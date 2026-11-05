// Actual registered facade executors over an in-memory native authority fixture.
// No real approval, native CLI, reviewer network call or candidate freeze occurs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGentleAiExtension, __testing } from "../../extensions/gentle-ai.ts";
import { decodeReviewStatusV3 } from "../../lib/review-integration-v2.ts";
import type { NativeReviewCli } from "../../lib/native-review-cli.ts";

type Body = Record<string, any>;
export function createCoordinatorRuntime(cwd: string, variant: "baseline" | "coordinator") {
	const raw = JSON.parse(readFileSync(new URL("../fixtures/devbinary/status-v5-capture-result-submission.captured.json", import.meta.url), "utf8"));
	raw.action = "stop";
	const reviewing = decodeReviewStatusV3(raw);
	const lineage = reviewing.authority!.lineageId!;
	const target = reviewing.targetIdentity;
	const revision = reviewing.authority!.revision;
	const arguments_ = [["cwd", cwd], ["lineage", lineage], ["target", target], ["expected-revision", revision], ["token", "fixture-only"]].map(([name, value]) => ({ name, value, token: `--${name}=${value}` }));
	const execute = { operation: "review.acknowledge-approved", command: "gentle-ai review acknowledge-approved --fixture-only", arguments: arguments_, preconditions: [{ name: "state", value: "approved" }], binding: { lineageId: lineage, targetIdentity: target, revision } };
	const approved = { ...reviewing, authority: { ...reviewing.authority!, state: "approved" }, nextTransition: { kind: "execute", reasonCode: "approved_acknowledgement_required", execute }, raw: { ...raw, authority: { ...raw.authority, state: "approved" }, next_transition: { kind: "execute", reason_code: "approved_acknowledgement_required", execute } } };
	let state = "reviewing";
	const nativeCalls: string[] = [];
	let modeReads = 0;
	let candidateReads = 0;
	const tools = new Map<string, any>();
	const native = {
		reviewMode: async () => { modeReads++; return { operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: "global" } }; },
		targetStatus: async () => {
			assert.notEqual(state, "burned", "no STATUS after burn");
			nativeCalls.push(`status:${state}`);
			return state === "approved" ? approved : reviewing;
		},
		acknowledgeApproved: async () => {
			assert.equal(state, "approved");
			nativeCalls.push("acknowledge"); state = "burned";
			return { schema: "gentle-ai.review-acknowledged/v1", lineageId: lineage, targetIdentity: target, consumedRevision: revision };
		},
		assess: async () => {
			candidateReads++;
			return { schema: "gentle-ai.review-assessment/v1", risk: "passive", reasons: [], changedPaths: 1, changedLines: 1,
				candidate: { kind: "current-changes", consumed: state === "burned" } };
		},
	} as unknown as NativeReviewCli;
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		assert.equal(state, "reviewing");
		nativeCalls.push("capture:recorded-output"); state = "approved";
		const submission = JSON.stringify({ schema: "gentle-ai.review-last-event-closure/v1", operation: "review/capture-result", lineage_id: lineage, state: "approved", action: "fixture approval; not real authority", store_revision: revision });
		return { submission, promptByteLength: 0, resultByteLength: Buffer.byteLength(submission) };
	});
	createGentleAiExtension({ nativeReviewCli: native, candidateViews: null,
		processEnv: { GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR: variant === "coordinator" ? "1" : "0", GENTLE_AI_TELEMETRY: "0" },
	})({ on() {}, registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool) } as never);
	const forecasts: Body[] = [];
	const context = { cwd, hasUI: true, sessionManager: { getSessionId: () => "fixture-live-driver", getBranch: () => [], getSessionFile: () => undefined }, modelRegistry: undefined };
	const facadeCalls: { name: string; parameters: Body; elapsed_ms: number }[] = [];
	return { tools, lineage, target, nativeCalls, facadeCalls, forecasts,
		async invoke(name: string, parameters: Body) {
			const tool = tools.get(name); assert.ok(tool, `registered tool ${name}`);
			const began = performance.now();
			const result = await tool.execute("fixture-call", parameters, undefined, (update: any) => forecasts.push(update.details), context);
			facadeCalls.push({ name, parameters, elapsed_ms: performance.now() - began });
			return result.details as Body;
		},
		closed: () => state === "burned",
		modeReads: () => modeReads,
		candidateReads: () => candidateReads,
		close: () => __testing.setReviewHostRelayRunnerForTesting(),
	};
}
