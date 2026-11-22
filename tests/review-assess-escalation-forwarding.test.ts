import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { NATIVE_REVIEW_MODE_SOURCE, NativeReviewCliV216, type ExecFileAdapter, type NativeReviewCli } from "../lib/native-review-cli.ts";
import { REVIEW_ASSESSMENT_SCHEMA } from "../lib/review-risk-assessment.ts";

// gentle-ai#6203: an agent escalation is forwarded to native assess so native
// raises the tier to high and reports review due. Due stays computed natively.

const envelope = (risk: string, due?: boolean) => JSON.stringify({
	schema: REVIEW_ASSESSMENT_SCHEMA, risk, reasons: [], changed_paths: 1, changed_lines: 3, candidate: { kind: "current-changes" },
	...(due === undefined ? {} : { review_due: due, review_due_reason: due ? "high_risk" : "under_budget" }),
});

async function assessArgs(escalate: { item: number; reason: string } | undefined): Promise<readonly string[]> {
	const cwd = mkdtempSync(`${tmpdir()}/assess-esc-`);
	try {
		const calls: Array<readonly string[]> = [];
		const adapter: ExecFileAdapter = async (request) => {
			calls.push(request.arguments);
			return { stdout: envelope("medium"), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		};
		const cli = new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024);
		await cli.assess({ cwd, ...(escalate === undefined ? {} : { escalate }) } as never);
		assert.equal(calls.length, 1);
		return calls[0].slice(0, calls[0].length);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("native assess sends exactly --escalate-item and --escalate-reason when escalate is present", async () => {
	const cwd = realpathSync(tmpdir());
	void cwd;
	const args = await assessArgs({ item: 2, reason: "weakens the permission check" });
	const i = args.indexOf("--escalate-item");
	assert.ok(i > 0);
	assert.deepEqual(args.slice(i, i + 4), ["--escalate-item", "2", "--escalate-reason", "weakens the permission check"]);
	assert.equal(args.at(-1), "--json");
	assert.equal(args.filter((a) => a.startsWith("--escalate")).length, 2);
});

test("native assess sends neither escalate flag without escalate", async () => {
	const args = await assessArgs(undefined);
	assert.equal(args.some((a) => a.startsWith("--escalate")), false);
	assert.deepEqual(args.slice(0, 2), ["review", "assess"]);
});

function tool(assess: NativeReviewCli["assess"]) {
	const tools = new Map<string, any>();
	const pi = { on() {}, registerCommand() {}, registerTool(t: { name: string }) { tools.set(t.name, t); } } as unknown as ExtensionAPI;
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		assess,
	};
	createGentleAiExtension({ nativeReviewCli: nativeReviewCli as NativeReviewCli })(pi);
	return tools.get("gentle_review");
}
const ctx = { cwd: process.cwd() } as ExtensionContext;

test("gentle_review assess forwards the parsed escalate and reports native reviewDue true", async () => {
	const seen: unknown[] = [];
	const t = tool(async (request) => {
		seen.push((request as { escalate?: unknown }).escalate);
		return { schema: REVIEW_ASSESSMENT_SCHEMA, risk: "high", reasons: [{ code: "agent_escalation", detail: "x" }], changedPaths: 1, changedLines: 3, candidate: { kind: "current-changes", baseRef: undefined }, reviewDue: true, reviewDueReason: "high_risk" } as never;
	});
	const { details } = await t.execute("f1", { operation: "assess", input: JSON.stringify({ escalate: { item: 2, reason: "r" } }) }, undefined, undefined, ctx);
	assert.deepEqual(seen, [{ item: 2, reason: "r" }]);
	const d = details as { reviewDue: boolean; nativeRisk: string; risk: string; agentEscalation: { applied: boolean }; plan: { independentVerifier: boolean } };
	assert.equal(d.reviewDue, true);
	assert.equal(d.nativeRisk, "high");
	assert.equal(d.risk, "high");
	assert.equal(d.agentEscalation.applied, true);
	assert.equal(d.plan.independentVerifier, true);
});

test("gentle_review assess without escalate passes no escalate; invalid escalate is rejected before native", async () => {
	const seen: unknown[] = [];
	let calls = 0;
	const t = tool(async (request) => {
		calls++;
		seen.push("escalate" in request);
		return { schema: REVIEW_ASSESSMENT_SCHEMA, risk: "medium", reasons: [], changedPaths: 1, changedLines: 3, candidate: { kind: "current-changes", baseRef: undefined } } as never;
	});
	await t.execute("f2", { operation: "assess" }, undefined, undefined, ctx);
	assert.deepEqual(seen, [false]);
	await assert.rejects(() => t.execute("f3", { operation: "assess", input: JSON.stringify({ escalate: { item: 9, reason: "x" } }) }, undefined, undefined, ctx), /escalate/);
	assert.equal(calls, 1);
});

test("guidance says an escalation makes native review due and a verifier never replaces it", async () => {
	const { readFileSync } = await import("node:fs");
	const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
	assert.match(read("assets/orchestrator.md"), /RDD on: `escalate` makes review due\./);
	assert.match(read("assets/orchestrator-verification.md"), /With RDD on it also makes native review due, which a verifier never replaces\./);
	assert.match(read("extensions/gentle-ai.ts"), /An escalation is also forwarded to native assess, which raises the tier to high and reports reviewDue true/);
	assert.match(read("docs/delegated-verification.md"), /--escalate-item <1-6> --escalate-reason <text>/);
});
