import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { canonicalHash } from "../lib/review-transaction.ts";

function dispatch(severity: string) {
	const rows = [{ id: "JD-A-001", lens: "judgment-day", location: "src/target.ts:1", severity, status_at_freeze: "open",
		evidence_class: "deterministic", evidence_claim: "Controlled concrete impact at the frozen location." }];
	return { agent: "jd-fix-agent", task: ["## Judgment Day activation", "User explicitly requested Judgment Day.",
		"## Exact authorized severe IDs", "- `JD-A-001`", "## Judgment Day correction batch", "Round: 1 of 2.",
		`Frozen ledger SHA-256: \`${canonicalHash(rows)}\``, "## Exact frozen finding rows", JSON.stringify(rows[0]),
		"## Allowed edit surfaces", "src/target.ts"].join("\n") };
}

test("#3051: the registered admission hook pinpoints unsupported severity without promoting it", async t => {
	const cwd = mkdtempSync(join(tmpdir(), "judgment-severity-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	type Handler = (event: { toolName: string; input: unknown }, ctx: ExtensionContext) => Promise<{ block?: boolean; reason?: string } | undefined>;
	const handlers = new Map<string, Handler>();
	createGentleAiExtension({ nativeReviewCli: null, processEnv: { GENTLE_AI_TELEMETRY: "0" } })({
		on: (name: string, handler: Handler) => handlers.set(name, handler), events: { emit() {} }, registerCommand() {}, registerTool() {},
	} as unknown as ExtensionAPI);
	const check = (input: unknown) => handlers.get("tool_call")!({ toolName: "subagent_run", input }, {
		cwd, hasUI: false, getContextUsage: () => ({ tokens: 1000, contextWindow: 272000, percent: 1 }),
	} as unknown as ExtensionContext);
	for (const severity of ["BLOCKER", "CRITICAL"]) assert.equal(await check(dispatch(severity)), undefined, severity);
	for (const severity of ["HIGH", "MAJOR"]) {
		const input = dispatch(severity), before = JSON.stringify(input);
		const rejected = await check(input);
		assert.equal(rejected?.block, true);
		assert.match(rejected!.reason!, new RegExp(`Unsupported Judgment Day severity "${severity}"`));
		assert.match(rejected!.reason!, /BLOCKER, CRITICAL, WARNING, SUGGESTION/);
		assert.equal(JSON.stringify(input), before, "admission never rewrites the frozen rows or hash");
	}
	for (const severity of ["WARNING", "SUGGESTION"]) {
		const rejected = await check(dispatch(severity));
		assert.equal(rejected?.block, true); assert.match(rejected!.reason!, /informational.*not eligible/i);
	}
	const wrongHash = dispatch("CRITICAL"); wrongHash.task = wrongHash.task.replace(/Frozen ledger SHA-256: `[^`]+`/, `Frozen ledger SHA-256: \`${"0".repeat(64)}\``);
	assert.equal((await check(wrongHash))?.block, true, "valid severity never bypasses the frozen hash");
	assert.equal((await check({ ...dispatch("CRITICAL"), agents: [] }))?.block, true, "batch envelopes remain forbidden");
});
