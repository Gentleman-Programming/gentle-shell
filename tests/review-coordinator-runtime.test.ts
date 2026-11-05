import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCoordinatorRuntime } from "./support/review-coordinator-runtime.ts";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";
import { decodeReviewStatusV3 } from "../lib/review-integration-v2.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";

test("registered coordinator executes existing facade and preserves the baseline native trace", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "rdd-coordinator-runtime-"));
	t.after(() => { assert.ok(cwd.startsWith(join(tmpdir(), "rdd-coordinator-runtime-"))); rmSync(cwd, { recursive: true, force: true }); });
	execFileSync("git", ["init", "-q"], { cwd });
	writeFileSync(join(cwd, "candidate.ts"), "export const value = 1;\n");
	const baseline = createCoordinatorRuntime(cwd, "baseline");
	let baselineTrace: string[];
	try {
		const status = await baseline.invoke("gentle_review", { operation: "status", lineageId: baseline.lineage });
		const collectBinding = status.collectBindings[0].collectBinding;
		const capture = { lineageId: baseline.lineage, collectBinding };
		assert.equal((await baseline.invoke("gentle_review_capture", capture)).outcome, "reviewer-model-run-forecast");
		assert.equal((await baseline.invoke("gentle_review_capture", { ...capture, reviewerRunAcknowledged: true })).outcome, "native-last-event-closure");
		await baseline.invoke("gentle_review", { operation: "status", lineageId: baseline.lineage });
		assert.equal((await baseline.invoke("gentle_review", { operation: "acknowledge-approved", lineageId: baseline.lineage })).authority, "burned");
		assert.ok(baseline.closed());
		baselineTrace = [...baseline.nativeCalls];
	} finally { baseline.close(); }
	const coordinated = createCoordinatorRuntime(cwd, "coordinator");
	try {
		assert.equal(coordinated.tools.get("gentle_review_run").exposure, "model-only");
		const result = await coordinated.invoke("gentle_review_run", { lineageId: coordinated.lineage });
		assert.equal(result.outcome, "closed", JSON.stringify({ result, calls: coordinated.nativeCalls }));
		assert.ok(coordinated.closed());
		assert.deepEqual(coordinated.nativeCalls, baselineTrace!);
		assert.equal(coordinated.forecasts.length, 1);
		assert.equal(coordinated.forecasts[0]!.outcome, "reviewer-model-run-forecast");
		assert.equal(result.metrics.facade_calls, 5);
		assert.equal(result.current_candidate, undefined);
		assert.equal(coordinated.candidateReads(), 0, "ACK requires no post-burn query");
	} finally { coordinated.close(); }
});

test("experimental coordinator respects RDD off and a switch disabled during its forecast", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "rdd-coordinator-mode-"));
	t.after(() => { assert.ok(cwd.startsWith(join(tmpdir(), "rdd-coordinator-mode-"))); rmSync(cwd, { recursive: true, force: true }); });
	execFileSync("git", ["init", "-q"], { cwd });
	const raw = JSON.parse(readFileSync(new URL("./fixtures/devbinary/status-v5-capture-result-submission.captured.json", import.meta.url), "utf8"));
	raw.action = "stop";
	const status = decodeReviewStatusV3(raw);
	for (const initiallyOff of [true, false]) {
		let effective = initiallyOff ? "off" : "on";
		let captures = 0;
		__testing.setReviewHostRelayRunnerForTesting(async () => { captures++; throw new Error("No reviewer should run with RDD off"); });
		try {
			const native = {
				targetStatus: async () => status,
				reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: effective, cloneLocal: "", effective, source: "global" } }),
			} as unknown as NativeReviewCli;
			const tools = new Map<string, any>();
			createGentleAiExtension({ nativeReviewCli: native, candidateViews: null, processEnv: { GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR: "1" } })({ on() {}, registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool) } as never);
			const result = await tools.get("gentle_review_run").execute("mode-test", { lineageId: status.authority!.lineageId }, undefined,
				() => { effective = "off"; }, { cwd, hasUI: true, sessionManager: { getSessionId: () => "mode-test" } });
			assert.equal(captures, 0, "mode off must stop before reviewer execution");
			assert.equal(result.details.outcome, "blocked");
			assert.equal(result.details.result.status, "skipped");
		} finally { __testing.setReviewHostRelayRunnerForTesting(); }
	}
});

test("capture forecast retains fresh mode and session checks before model execution", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "rdd-projected-guards-"));
	t.after(() => { assert.ok(cwd.startsWith(join(tmpdir(), "rdd-projected-guards-"))); rmSync(cwd, { recursive: true, force: true }); });
	execFileSync("git", ["init", "-q"], { cwd });
	const raw = JSON.parse(readFileSync(new URL("./fixtures/devbinary/status-v5-capture-result-submission.captured.json", import.meta.url), "utf8"));
	raw.action = "stop";
	const base = decodeReviewStatusV3(raw);
	const template = base.nextTransition!.collect!.inputs[0];
	const input = { ...template, name: "provider_targeted_validator", captureOperation: "review.capture-validation",
		submission: { ...template.submission!, operationToken: "capture-validation" } };
	const validation = { ...base, authority: { ...base.authority!, state: "correction_required" },
		nextTransition: { kind: "collect", reasonCode: "targeted_validation_required", collect: { inputs: [input] } },
		raw: { ...raw, authority: { ...raw.authority, state: "correction_required" }, next_transition: { kind: "collect", reason_code: "targeted_validation_required" } } };
	for (const change of ["mode", "session"]) {
		let effective = "on"; let session = "original"; let runs = 0; let statusCalls = 0; let displayed = 0;
		__testing.setReviewHostRelayRunnerForTesting(async () => { runs++; throw new Error("changed mode/session cannot launch reviewer"); });
		try {
			const native = { targetStatus: async () => { statusCalls++; return validation; },
				reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: effective, cloneLocal: "", effective, source: "global" } }),
			} as unknown as NativeReviewCli;
			const tools = new Map<string, any>();
			createGentleAiExtension({ nativeReviewCli: native, candidateViews: null, processEnv: { GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR: "1" } })({ on() {}, registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool) } as never);
			const call = () => tools.get("gentle_review_run").execute("projected-guard", { lineageId: base.authority!.lineageId }, undefined,
				(update: any) => { assert.equal(update.details.outcome, "reviewer-model-run-forecast"); displayed++; if (change === "mode") effective = "off"; else session = "changed"; },
				{ cwd, hasUI: true, sessionManager: { getSessionId: () => session } });
			if (change === "session") await assert.rejects(call, { name: "AbortError" });
			else assert.equal((await call()).details.outcome, "blocked");
			assert.equal(displayed, 1);
			assert.equal(statusCalls, 2, "one offered STATUS and the existing capture forecast preflight");
			assert.equal(runs, 0);
		} finally { __testing.setReviewHostRelayRunnerForTesting(); }
	}
});
