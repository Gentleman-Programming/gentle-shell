import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { reconcileUnknownReviewLastEventCapture } from "../lib/review-last-event-controller.ts";
import * as nativeReviewCliModule from "../lib/native-review-cli.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import {
	decodeReviewLastEventClosureV1,
	decodeReviewStartV3,
	type ReviewCollectInputV3,
	type ReviewStatusV3,
} from "../lib/review-integration-v2.ts";

const SHA = `sha256:${"a".repeat(64)}`;
const TREE = "b".repeat(40);
const CAPTURED_FIXTURES = join(process.cwd(), "tests", "fixtures", "devbinary");

function captured(name: string): unknown {
	return JSON.parse(readFileSync(join(CAPTURED_FIXTURES, name), "utf8"));
}

function closure(operation: string, lineageId: string): Record<string, unknown> {
	return {
		schema: "gentle-ai.review-last-event-closure/v1",
		operation,
		lineage_id: lineageId,
		state: operation === "review.capture-correction-plan" ? "correction_required" : "approved",
		...(operation === "review.capture-correction-plan"
			? { target_identity: SHA, request_hash: SHA, correction_lines: 2 }
			: { action: "native last event closed the review" }),
		store_revision: SHA,
	};
}

function bindingArguments(lineageId: string, suffix = "0"): ReviewCollectInputV3["arguments"] {
	return [
		{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
		{ name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` },
		{ name: "target", value: SHA, token: `--target=${SHA}` },
		{ name: "repository-context", value: `rctx1_${"c".repeat(64)}`, token: `--repository-context=rctx1_${"c".repeat(64)}` },
		{ name: "lens", value: `review-risk-${suffix}`, token: `--lens=review-risk-${suffix}` },
		{ name: "order", value: suffix, token: `--order=${suffix}` },
		{ name: "subject-hash", value: SHA, token: `--subject-hash=${SHA}` },
	];
}

function materializeInput(lineageId: string, suffix = "0"): ReviewCollectInputV3 {
	const arguments_ = [
		...bindingArguments(lineageId, suffix),
		{ name: "agent", value: "pi", token: "--agent=pi" },
		{ name: "materialize", value: "true", token: "--materialize=true" },
	];
	return {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		captureOperation: "review.capture-result",
		arguments: arguments_,
		artifactSubject: {
			schema: "gentle-ai.review-artifact-subject/v2",
			subjectHash: SHA,
			lineageId,
			authorityRevision: SHA,
			targetIdentity: SHA,
			baseTree: TREE,
			candidateTree: TREE,
			changedPathManifestSha256: SHA,
			lens: `review-risk-${suffix}`,
			selectedOrder: Number(suffix),
		},
		submission: {
			operationToken: "capture-result",
			argumentTokens: [...bindingArguments(lineageId, suffix).map((argument) => argument.token!), "--input={{value}}"],
			values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: 7 }],
		},
	};
}

function correctionPlanInput(lineageId: string): ReviewCollectInputV3 {
	return {
		name: "correction_plan",
		schema: "gentle-ai.review-correction-plan/v1",
		captureOperation: "review.capture-correction-plan",
		arguments: bindingArguments(lineageId),
		submission: {
			operationToken: "capture-correction-plan",
			argumentTokens: [...bindingArguments(lineageId).map((argument) => argument.token!), "--correction-lines={{value}}"],
			values: [{ slot: "correction_lines", domain: "positive_integer", substitutionLocation: 7, minimum: 2, maximum: 3 }],
		},
	};
}

function roleInput(lineageId: string, operation: "review.capture-refuter" | "review.capture-validation"): ReviewCollectInputV3 {
	return {
		name: operation === "review.capture-refuter" ? "provider_refuter" : "targeted_validator",
		schema: "gentle-ai.review-provider-role/v1",
		captureOperation: operation,
		arguments: [
			...bindingArguments(lineageId),
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "execute", value: "true", token: "--execute=true" },
		],
	};
}

function status(lineageId: string, inputs: readonly ReviewCollectInputV3[]): ReviewStatusV3 {
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: "reviewing", generation: 1, revision: SHA },
		action: "stop",
		replayability: "not_replayable",
		targetIdentity: SHA,
		projection: {
			schema: "gentle-ai.review-candidate-projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: TREE,
			initialReviewTree: TREE,
			currentCandidateTree: TREE,
			pathsDigest: SHA,
			paths: ["app.ts"],
			intendedUntracked: [],
			intendedUntrackedProof: SHA,
			initialSnapshotIdentity: SHA,
			currentSnapshotIdentity: SHA,
		},
		candidates: [],
		nextTransition: { kind: "collect", reasonCode: "capture_required", collect: { inputs: [...inputs] } },
		raw: { schema: "gentle-ai.review-integration.status/v5" },
	} as unknown as ReviewStatusV3;
}

function capture(lineageId: string, input: ReviewCollectInputV3, native: NativeReviewCli, extras: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	return __testing.executeReviewCaptureOperation({ lineageId, collectBinding: JSON.stringify(input), ...extras }, process.cwd(), native);
}

test("strictly decodes the real zero-lens closed START and every last-event closure", () => {
	const start = decodeReviewStartV3(captured("start-v3-zero-lens-closed.captured.json"));
	assert.equal(start.action, "closed");
	assert.equal(start.state, "approved");
	assert.equal(start.lensesRequired, false);
	assert.deepEqual(start.selectedLenses, []);
	for (const [name, operation, state] of [
		["last-event-capture-result-approved.captured.json", "review/capture-result", "approved"],
		["last-event-capture-result-correction-required.captured.json", "review/capture-result", "correction_required"],
		["last-event-capture-correction-plan.captured.json", "review.capture-correction-plan", "correction_required"],
		["last-event-capture-refuter-correction-required.captured.json", "review.capture-refuter", "correction_required"],
		["last-event-capture-refuter-approved.captured.json", "review.capture-refuter", "approved"],
		["last-event-capture-validation-approved.captured.json", "review/capture-validation", "approved"],
	] as const) {
		const decoded = decodeReviewLastEventClosureV1(captured(name));
		assert.equal(decoded.operation, operation, name);
		assert.equal(decoded.state, state, name);
	}
});

test("approved closure preserves complete admitted reviewer results before acknowledgement", () => {
	const approved = closure("review/capture-result", "review-results");
	approved.reviewer_results = [{
		lens: "review-reliability",
		findings: [{
			id: "R3-W01",
			lens: "reliability",
			location: "lib/session.ts:4",
			severity: "SUGGESTION",
			claim: "the complete explanatory narrative remains available",
			proof_refs: ["the changed line was inspected"],
			evidence_class: "insufficient",
			causal_disposition: "pre-existing",
		}],
		evidence: ["inspected the complete frozen candidate"],
		result_hash: SHA,
	}];
	const decoded = decodeReviewLastEventClosureV1(approved);
	assert.deepEqual(decoded.reviewerResults, [{
		lens: "review-reliability",
		findings: [{
			id: "R3-W01",
			lens: "reliability",
			location: "lib/session.ts:4",
			severity: "SUGGESTION",
			claim: "the complete explanatory narrative remains available",
			proofRefs: ["the changed line was inspected"],
			evidenceClass: "insufficient",
			causalDisposition: "pre-existing",
		}],
		evidence: ["inspected the complete frozen candidate"],
		resultHash: SHA,
	}]);

	const correctionPlan = closure("review.capture-correction-plan", "review-results");
	correctionPlan.reviewer_results = approved.reviewer_results;
	assert.throws(() => decodeReviewLastEventClosureV1(correctionPlan), /reviewer_results requires approved state/);
});

test("retired legacy client no longer exposes a FINALIZE route", () => {
	assert.equal("NativeReviewCliV214" in nativeReviewCliModule, false);
	assert.equal("NativeReviewCliV213" in nativeReviewCliModule, false);
});

test("one exact offered materialize binding executes only its selected slot and never follows STATUS", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const lineageId = "one-slot-lineage";
	const selected = materializeInput(lineageId, "0");
	const ignored = materializeInput(lineageId, "1");
	let statusCalls = 0;
	const native = {
		targetStatus: async () => {
			statusCalls += 1;
			return status(lineageId, [selected, ignored]);
		},
	} as unknown as NativeReviewCli;
	const relayed: unknown[] = [];
	__testing.setReviewHostRelayRunnerForTesting(async (request) => {
		relayed.push(request);
		return { promptByteLength: 12, resultByteLength: 8, submission: "{\"admission_decision\":\"completed\"}" };
	});

	const result = await capture(lineageId, selected, native, { reviewerRunAcknowledged: true });
	assert.equal(statusCalls, 1);
	assert.equal(relayed.length, 1);
	assert.equal(result.status, "captured");
	assert.equal(result.outcome, "native-reviewer-result-captured");
	assert.deepEqual((relayed[0] as { captureArgumentTokens: readonly string[] }).captureArgumentTokens, selected.arguments.map((argument) => argument.token));
});

test("malformed, stale, duplicate, and incomplete collect bindings reject before capture mutation", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const lineageId = "rejected-binding";
	const input = materializeInput(lineageId);
	let statusCalls = 0;
	let launches = 0;
	const native = { targetStatus: async () => { statusCalls += 1; return status(lineageId, [input]); } } as unknown as NativeReviewCli;
	__testing.setReviewHostRelayRunnerForTesting(async () => { launches += 1; return { promptByteLength: 1, resultByteLength: 1, submission: "{}" }; });

	await assert.rejects(() => __testing.executeReviewCaptureOperation({ lineageId, collectBinding: "{" }, process.cwd(), native), /collectBinding is not valid JSON/);
	const stale = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: JSON.stringify(materializeInput("other")) }, process.cwd(), native);
	const duplicate = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: JSON.stringify(input) }, process.cwd(), {
		targetStatus: async () => { statusCalls += 1; return status(lineageId, [input, input]); },
	} as unknown as NativeReviewCli);
	assert.equal(stale.outcome, "capture-binding-rejected");
	assert.equal(duplicate.outcome, "capture-binding-rejected");

	const missingLineageToken: ReviewCollectInputV3 = { ...input, arguments: input.arguments.filter((argument) => argument.name !== "lineage") };
	const missingTargetToken: ReviewCollectInputV3 = { ...input, arguments: input.arguments.filter((argument) => argument.name !== "target") };
	const mismatchedLineageToken: ReviewCollectInputV3 = {
		...input,
		arguments: input.arguments.map((argument) => argument.name === "lineage" ? { ...argument, value: "other-lineage" } : argument),
	};
	const mismatchedTargetToken: ReviewCollectInputV3 = {
		...input,
		arguments: input.arguments.map((argument) => argument.name === "target" ? { ...argument, value: `sha256:${"d".repeat(64)}` } : argument),
	};
	const missingAuthorityLineage = { ...status(lineageId, [input]), authority: undefined } as ReviewStatusV3;
	const emptyAuthorityLineage = {
		...status(lineageId, [input]),
		authority: { ...status(lineageId, [input]).authority!, lineageId: "" },
	} as unknown as ReviewStatusV3;
	const missingStatusTarget = { ...status(lineageId, [missingTargetToken]), targetIdentity: undefined } as unknown as ReviewStatusV3;
	const emptyStatusTarget = { ...status(lineageId, [input]), targetIdentity: "" } as unknown as ReviewStatusV3;
	for (const [offeredInput, currentStatus] of [
		[missingLineageToken, status(lineageId, [missingLineageToken])],
		[missingTargetToken, status(lineageId, [missingTargetToken])],
		[mismatchedLineageToken, status(lineageId, [mismatchedLineageToken])],
		[mismatchedTargetToken, status(lineageId, [mismatchedTargetToken])],
		[input, missingAuthorityLineage],
		[input, emptyAuthorityLineage],
		[missingTargetToken, missingStatusTarget],
		[input, emptyStatusTarget],
	] as const) {
		const rejected = await __testing.executeReviewCaptureOperation(
			{ lineageId, collectBinding: JSON.stringify(offeredInput), reviewerRunAcknowledged: true },
			process.cwd(),
			{ targetStatus: async () => currentStatus } as unknown as NativeReviewCli,
		);
		assert.equal(rejected.outcome, "capture-binding-rejected");
	}
	assert.equal(launches, 0);
	assert.equal(statusCalls, 2);
});

test("forecast spends zero and acknowledgement runs exactly one materialize reviewer", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const lineageId = "forecast-lineage";
	const input = materializeInput(lineageId);
	let statusCalls = 0;
	let launches = 0;
	const native = { targetStatus: async () => { statusCalls += 1; return status(lineageId, [input]); } } as unknown as NativeReviewCli;
	__testing.setReviewHostRelayRunnerForTesting(async () => { launches += 1; return { promptByteLength: 1, resultByteLength: 1, submission: "{}" }; });

	const forecast = await capture(lineageId, input, native);
	const acknowledged = await capture(lineageId, input, native, { reviewerRunAcknowledged: true });
	assert.equal(forecast.outcome, "reviewer-model-run-forecast");
	assert.equal((forecast.cost_forecast as { model_runs: number }).model_runs, 1);
	assert.equal(acknowledged.status, "captured");
	assert.equal(launches, 1);
	assert.equal(statusCalls, 2);
});

test("correction-plan preserves exact provider tokens and bounds without a follow-up lifecycle call", async () => {
	const lineageId = "correction-plan";
	const input = correctionPlanInput(lineageId);
	let statusCalls = 0;
	const requests: Array<{ argumentTokens: readonly string[]; correctionLines: number }> = [];
	const native = {
		targetStatus: async () => { statusCalls += 1; return status(lineageId, [input]); },
		captureCorrectionPlan: async (request: { argumentTokens: readonly string[]; correctionLines: number }) => {
			requests.push(request);
			return decodeReviewLastEventClosureV1(closure("review.capture-correction-plan", lineageId));
		},
	} as unknown as NativeReviewCli;
	const missing = await capture(lineageId, input, native);
	const outOfBounds = await capture(lineageId, input, native, { correctionLines: 4 });
	const completed = await capture(lineageId, input, native, { correctionLines: 2 });
	assert.equal(missing.outcome, "correction-lines-required");
	assert.equal(outOfBounds.outcome, "capture-binding-rejected");
	assert.equal(completed.status, "closed");
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0]!.argumentTokens, input.submission!.argumentTokens);
	assert.equal(requests[0]!.correctionLines, 2);
	assert.equal(statusCalls, 3);
});

test("refuter and validation each execute one self-contained provider vector", async () => {
	for (const operation of ["review.capture-refuter", "review.capture-validation"] as const) {
		const lineageId = `role-${operation}`;
		const input = roleInput(lineageId, operation);
		const requests: Array<{ captureOperation: string; argumentTokens: readonly string[] }> = [];
		const native = {
			targetStatus: async () => status(lineageId, [input]),
			captureProviderRole: async (request: { captureOperation: string; argumentTokens: readonly string[] }) => {
				requests.push(request);
				return { schema: "gentle-ai.review-provider-role-capture/v1", lineageId, targetIdentity: SHA, role: operation, captured: true };
			},
		} as unknown as NativeReviewCli;
		const result = await capture(lineageId, input, native);
		assert.equal(result.status, "captured");
		assert.equal(requests.length, 1);
		assert.equal(requests[0]!.captureOperation, operation);
		assert.deepEqual(requests[0]!.argumentTokens, input.arguments.map((argument) => argument.token!));
	}
});

test("terminal capture closes directly, nonterminal capture does not auto-follow, and unknown mutation reconciles once", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const lineageId = "closure-behavior";
	const input = materializeInput(lineageId);
	let statusCalls = 0;
	const native = { targetStatus: async () => { statusCalls += 1; return status(lineageId, [input]); } } as unknown as NativeReviewCli;
	__testing.setReviewHostRelayRunnerForTesting(async () => ({ promptByteLength: 1, resultByteLength: 1, submission: JSON.stringify(closure("review/capture-result", lineageId)) }));
	const terminal = await capture(lineageId, input, native, { reviewerRunAcknowledged: true });
	assert.equal(terminal.status, "closed");
	assert.equal(statusCalls, 1, "terminal closure performs no post-success STATUS");

	statusCalls = 0;
	let captureCalls = 0;
	const correction = correctionPlanInput(lineageId);
	const ambiguousNative = {
		targetStatus: async () => { statusCalls += 1; return status(lineageId, [correction]); },
		captureCorrectionPlan: async () => {
			captureCalls += 1;
			throw Object.assign(new Error("response lost"), { mutationOutcome: "unknown", nextAction: "review.status" });
		},
	} as unknown as NativeReviewCli;
	const reconciled = await capture(lineageId, correction, ambiguousNative, { correctionLines: 2 });
	assert.equal(reconciled.status, "reconciled");
	assert.equal(captureCalls, 1);
	assert.equal(statusCalls, 2, "only initial STATUS plus one ambiguity reconciliation");
});

test("unknown-capture reconciliation preserves agentless legacy callers and forwards an explicit Pi agent", async () => {
	const calls: Array<Record<string, unknown>> = [];
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			calls.push(request);
			assert.equal(request.lineageId, "reconcile-lineage");
			return { applicability: "current_target", targetIdentity: SHA, authority: { lineageId: "reconcile-lineage" } } as ReviewStatusV3;
		},
	} as unknown as NativeReviewCli;
	const result = await reconcileUnknownReviewLastEventCapture(native, "/repo", { lineageId: "reconcile-lineage", targetIdentity: SHA });
	await reconcileUnknownReviewLastEventCapture(native, "/repo", { lineageId: "reconcile-lineage", targetIdentity: SHA }, { baseRef: "refs/heads/main", committedOnly: true });
	await reconcileUnknownReviewLastEventCapture(native, "/repo", { lineageId: "reconcile-lineage", targetIdentity: SHA }, { agent: "pi" });
	assert.deepEqual(calls, [
		{ cwd: "/repo", lineageId: "reconcile-lineage" },
		{ cwd: "/repo", lineageId: "reconcile-lineage", baseRef: "refs/heads/main", committedOnly: true },
		{ cwd: "/repo", lineageId: "reconcile-lineage", agent: "pi" },
	]);
	assert.equal(result.targetIdentity, SHA);
	let launches = 0;
	const strictNative = new nativeReviewCliModule.NativeReviewCliV216(async () => { launches += 1; throw new Error("must not launch"); }, "/package/.gentle-ai/gentle-ai");
	for (const selector of [{ committedOnly: true }, { baseRef: "refs/heads/main" }, { baseRef: "refs/heads/main", committedOnly: false }] as unknown as readonly Parameters<typeof reconcileUnknownReviewLastEventCapture>[3][]) await assert.rejects(() => reconcileUnknownReviewLastEventCapture(strictNative, "/repo", { lineageId: "reconcile-lineage", targetIdentity: SHA }, selector));
	assert.equal(launches, 0);
});

test("unknown targeted-validator capture reconciliation requires current exact authority and target", async () => {
	const lineageId = "targeted-validator-reconciliation";
	const input = roleInput(lineageId, "review.capture-validation");
	const expected = status(lineageId, [input]);
	const cases = [
		["current matching STATUS", expected, true],
		["unrelated STATUS", { ...expected, applicability: "unrelated" }, false],
		["STATUS without authority", { ...expected, authority: undefined }, false],
		["STATUS for another lineage", { ...expected, authority: { ...expected.authority!, lineageId: "other-lineage" } }, false],
		["STATUS for another target", { ...expected, targetIdentity: `sha256:${"d".repeat(64)}` }, false],
	] as const;

	for (const [_name, reconciliationStatus, trusted] of cases) {
		let statusCalls = 0;
		let captureCalls = 0;
		let startCalls = 0;
		const native = {
			targetStatus: async () => {
				statusCalls += 1;
				return statusCalls === 1 ? expected : reconciliationStatus;
			},
			captureProviderRole: async () => {
				captureCalls += 1;
				throw Object.assign(new Error("targeted-validator response lost"), {
					mutationOutcome: "unknown",
					nextAction: "review.status",
					failureEnvelope: { raw: { code: "targeted-validator-response-lost" }, mutationOutcome: "unknown" },
				});
			},
			start: async () => { startCalls += 1; },
		} as unknown as NativeReviewCli;

		const result = await capture(lineageId, input, native);
		assert.equal(result.outcome, trusted ? "native-capture-outcome-unknown" : "native-capture-status-reconciliation-failed");
		assert.equal(captureCalls, 1, "an ambiguous capture is never replayed");
		assert.equal(statusCalls, 2, "an ambiguous capture gets one reconciliation STATUS");
		assert.equal(startCalls, 0, "reconciliation never invokes START");
		if (trusted) {
			assert.equal(result.status, "reconciled");
			assert.deepEqual((result.native_failure as { native_failure: unknown }).native_failure, { code: "targeted-validator-response-lost" });
		} else {
			assert.deepEqual(result.native_failure, { code: "targeted-validator-response-lost" }, "the original capture failure is preserved");
			assert.ok(result.reconciliation_failure, "the rejected STATUS diagnostic remains nested");
		}
	}
});

test("unknown-capture reconciliation rejects a binding without a target identity", async () => {
	const lineageId = "missing-reconciliation-target";
	const input = roleInput(lineageId, "review.capture-validation");
	let statusCalls = 0;
	const native = {
		targetStatus: async () => {
			statusCalls += 1;
			return status(lineageId, [input]);
		},
	} as unknown as NativeReviewCli;

	await assert.rejects(
		() => reconcileUnknownReviewLastEventCapture(native, process.cwd(), { lineageId }),
		/capture reconciliation returned missing or different target/,
	);
	assert.equal(statusCalls, 1, "the missing binding is rejected after one reconciliation STATUS");
});

// One approved terminal closure carrying the exact continuation the provider
// renders: closed positional arguments, the single approved precondition, and a
// binding that names the candidate being burned.
function approvedClosureWithAcknowledgement(): Record<string, unknown> {
	const lineageId = "review-acknowledgement-fixture";
	const body = closure("review/capture-result", lineageId);
	body.acknowledgement = {
		operation: "review.acknowledge-approved",
		command: "gentle-ai review acknowledge-approved",
		arguments: [
			{ name: "cwd", value: "/repo", token: "--cwd=/repo" },
			{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
			{ name: "target", value: SHA, token: `--target=${SHA}` },
			{ name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` },
			{ name: "token", value: "a".repeat(64), token: `--token=${"a".repeat(64)}` },
		],
		preconditions: [{ name: "state", value: "approved" }],
		binding: { lineage_id: lineageId, revision: SHA, target_identity: SHA },
	};
	return body;
}

test("the approved acknowledgement fixture decodes as a runnable continuation", () => {
	const decoded = decodeReviewLastEventClosureV1(approvedClosureWithAcknowledgement());
	assert.equal(decoded.acknowledgement?.operation, "review.acknowledge-approved");
	assert.equal(decoded.acknowledgementUndecodable, undefined);
});

test("an approved acknowledgement must prove the target its relayed token burns", () => {
	const closure = approvedClosureWithAcknowledgement();
	const acknowledgement = closure.acknowledgement as Record<string, unknown>;
	const args = (acknowledgement.arguments as Record<string, unknown>[]).map((argument) => ({ ...argument }));
	// The relayed token now names a different candidate than the binding does.
	const decoyTarget = `sha256:${"b".repeat(64)}`;
	args[2] = { name: "target", value: decoyTarget, token: `--target=${decoyTarget}` };
	acknowledgement.arguments = args;
	assert.throws(
		() => decodeReviewLastEventClosureV1(closure),
		/acknowledgement target argument does not match its binding/,
		"a relayed target the binding does not commit to must be refused",
	);
});

test("an unreadable acknowledgement degrades the continuation, never the approval", () => {
	const closure = approvedClosureWithAcknowledgement();
	// One extra provider-side argument is enough to miss the closed shape.
	const acknowledgement = closure.acknowledgement as Record<string, unknown>;
	acknowledgement.arguments = [
		...(acknowledgement.arguments as unknown[]),
		{ name: "future", value: "1", token: "--future=1" },
	];
	const decoded = decodeReviewLastEventClosureV1(closure);
	assert.equal(decoded.state, "approved", "the approval outcome must survive an unreadable continuation");
	assert.equal(decoded.acknowledgement, undefined, "an unreadable continuation must not be offered as runnable");
	assert.equal(decoded.acknowledgementUndecodable, true, "the host must be told the continuation exists and could not be read");
});
