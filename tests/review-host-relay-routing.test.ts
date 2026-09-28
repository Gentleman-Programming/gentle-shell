import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli, NativeReviewUnachievableLensCaptureArtifact, NativeReviewUnachievableLensCaptureRequest } from "../lib/native-review-cli.ts";
import { REVIEW_HOST_RELAY_FAILURE, REVIEW_HOST_RELAY_PI_TIMEOUT_ENV, REVIEW_HOST_RELAY_PI_TIMEOUT_MAX_MS, REVIEW_HOST_RELAY_SUBMISSION_MISSING_MESSAGE, REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE, ReviewHostRelayError, type ReviewHostRelayRequest } from "../lib/review-host-relay.ts";
import { decodeReviewNextTransitionV3, decodeReviewStatusV3, type ReviewArtifactSubjectV2, type ReviewCaptureSubmissionV1, type ReviewCollectInputV3, type ReviewStatusV3 } from "../lib/review-integration-v2.ts";

// One-slot capture routing: the host relay runs only when the selected
// provider-returned collect input carries the --materialize token. Every
// other capture form stays untouched.

const SHA = `sha256:${"1".repeat(64)}`;
const PHASE_REVISION = `sha256:${"3".repeat(64)}`;
const TREE = "2".repeat(40);

function repository(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-relay-routing-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-b", "main"], { cwd });
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Relay Test", "-c", "user.email=relay@example.invalid", "commit", "-m", "initial"], { cwd });
	return cwd;
}

function bindingArguments(lineageId: string, lens: ReviewArtifactSubjectV2["lens"], order: number, revision = SHA): ReviewCollectInputV3["arguments"] {
	return [
		{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
		{ name: "expected-revision", value: revision, token: `--expected-revision=${revision}` },
		{ name: "target", value: SHA, token: `--target=${SHA}` },
		{ name: "repository-context", value: `rctx1_${"e".repeat(64)}`, token: `--repository-context=rctx1_${"e".repeat(64)}` },
		{ name: "lens", value: lens, token: `--lens=${lens}` },
		{ name: "order", value: String(order), token: `--order=${order}` },
		{ name: "subject-hash", value: `sha256:${String(order).repeat(64)}`, token: `--subject-hash=sha256:${String(order).repeat(64)}` },
	];
}

function providerSubmission(lineageId: string, lens: ReviewArtifactSubjectV2["lens"], order: number, revision = SHA): ReviewCaptureSubmissionV1 {
	const bindingTokens = bindingArguments(lineageId, lens, order, revision).map((argument) => argument.token!);
	return {
		operationToken: "capture-result",
		argumentTokens: [...bindingTokens, "--input={{value}}"],
		values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: bindingTokens.length }],
	};
}

function relayCollectInput(lineageId: string, lens: ReviewArtifactSubjectV2["lens"], order: number, materialize = true, submission: ReviewCaptureSubmissionV1 | "provider" | "absent" = "provider", revision = SHA): ReviewCollectInputV3 {
	return {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		captureOperation: "review.capture-result",
		arguments: [
			...bindingArguments(lineageId, lens, order, revision),
			...(materialize ? [
				{ name: "agent", value: "pi", token: "--agent=pi" },
				{ name: "materialize", value: "true", token: "--materialize=true" },
			] : []),
		],
		artifactSubject: {
			schema: "gentle-ai.review-artifact-subject/v2", subjectHash: `sha256:${String(order).repeat(64)}`,
			lineageId, authorityRevision: revision, targetIdentity: SHA, baseTree: TREE, candidateTree: TREE,
			changedPathManifestSha256: SHA, lens, selectedOrder: order,
		},
		baseTree: TREE, candidateTree: TREE, changedPathManifest: [],
		...(materialize && submission !== "absent" ? { submission: submission === "provider" ? providerSubmission(lineageId, lens, order, revision) : submission } : {}),
	};
}

function capturedGroupedStatus(lineageId: string, authorityRevision = SHA): ReviewStatusV3 {
	const raw = JSON.parse(readFileSync(new URL("./fixtures/devbinary/status-v5-capture-result-submission.captured.json", import.meta.url), "utf8")) as Record<string, unknown>;
	// The captured binary's forward-only `finalize` action is not accepted by
	// this checked-out decoder; retain the v5 capture and normalize only that
	// unrelated routing action before decoding its provider-owned group.
	raw.action = "stop";
	const authority = raw.authority as Record<string, unknown>, repositoryContext = raw.repository_context as Record<string, unknown>;
	authority.lineage_id = lineageId;
	authority.revision = authorityRevision;
	const phaseRevision = String(repositoryContext.revision), targetIdentity = String(raw.target_identity);
	const source = ((((raw.next_transition as Record<string, unknown>).collect as Record<string, unknown>).inputs as Array<Record<string, unknown>>)[0]!);
	const lenses = ["review-risk", "review-resilience", "review-readability", "review-reliability"];
	((raw.next_transition as Record<string, unknown>).collect as Record<string, unknown>).inputs = lenses.map((lens, order) => {
		const input = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
		const subjectHash = `sha256:${String(order + 1).repeat(64)}`;
		const arguments_ = input.arguments as Array<Record<string, unknown>>;
		for (const argument of arguments_) {
			const value = argument.name === "lineage" ? lineageId
				: argument.name === "lens" ? lens
				: argument.name === "order" ? String(order)
				: argument.name === "subject-hash" ? subjectHash
				: argument.value;
			argument.value = value;
			argument.token = `--${String(argument.name)}=${String(value)}`;
		}
		const submission = input.submission as Record<string, unknown>;
		submission.argument_tokens = [...arguments_.filter((argument) => argument.name !== "agent" && argument.name !== "materialize").map((argument) => argument.token), "--input={{value}}"];
		const artifactSubject = input.artifact_subject as Record<string, unknown>;
		artifactSubject.subject_hash = subjectHash;
		artifactSubject.lineage_id = lineageId;
		artifactSubject.authority_revision = phaseRevision;
		artifactSubject.target_identity = targetIdentity;
		artifactSubject.lens = lens;
		artifactSubject.selected_order = order;
		return input;
	});
	return decodeReviewStatusV3(raw);
}

function replaceArgument(input: ReviewCollectInputV3, name: string, value: string): void {
	input.arguments = input.arguments.map((argument) => argument.name === name ? { ...argument, value, token: `--${name}=${value}` } : argument);
}

function finalizeStatus(lineageId: string, inputs?: readonly ReviewCollectInputV3[]): ReviewStatusV3 {
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: "reviewing", generation: 1, revision: SHA },
		action: "stop",
		replayability: "unknown",
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
		repositoryContext: { capability: "review.opaque_repository_context", handle: `rctx1_${"e".repeat(64)}`, revision: SHA, targetIdentity: SHA },
		...(inputs === undefined ? {} : { nextTransition: { kind: "collect", reasonCode: "reviewer_results_required", collect: { inputs: [...inputs] } } }),
		raw: { schema: "gentle-ai.review-integration.status/v3", action: "stop", lineage_id: lineageId },
	} as unknown as ReviewStatusV3;
}

function providerRefuterRequiredStatus(lineageId: string): ReviewStatusV3 {
	const refuter: ReviewCollectInputV3 = {
		name: "provider_refuter",
		schema: "https://gentle-ai.dev/schema/review/refuter/v1",
		captureOperation: "review.capture-refuter",
		arguments: bindingArguments(lineageId, "review-risk", 0),
	};
	return {
		...finalizeStatus(lineageId),
		nextTransition: { kind: "collect", reasonCode: "provider_refuter_required", collect: { inputs: [refuter] } },
	};
}

// gentle-pi#311 P3: gentle-ai's v9 contract renders the refuter and
// targeted-validator role captures host-mediated, exactly like a lens
// materialize slot, instead of the self-contained --execute=true vector
// `providerRefuterRequiredStatus` above models.
function roleBindingArguments(lineageId: string, revision = SHA): ReviewCollectInputV3["arguments"] {
	return [
		{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
		{ name: "expected-revision", value: revision, token: `--expected-revision=${revision}` },
		{ name: "target", value: SHA, token: `--target=${SHA}` },
		{ name: "repository-context", value: `rctx1_${"e".repeat(64)}`, token: `--repository-context=rctx1_${"e".repeat(64)}` },
	];
}

function hostMediatedRefuterCollectInput(lineageId: string, revision = SHA): ReviewCollectInputV3 {
	const bindingTokens = roleBindingArguments(lineageId, revision).map((argument) => argument.token!);
	return {
		name: "provider_refuter",
		schema: "https://gentle-ai.dev/schema/review/refuter/v1",
		captureOperation: "review.capture-refuter",
		arguments: [
			...roleBindingArguments(lineageId, revision),
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "materialize", value: "true", token: "--materialize=true" },
		],
		submission: {
			operationToken: "capture-refuter",
			argumentTokens: [...bindingTokens, "--agent=pi", "--input={{value}}"],
			values: [{ slot: "provider_refuter", domain: "artifact_path_or_stdin", substitutionLocation: bindingTokens.length + 1 }],
		},
	};
}

interface RoutingHarness {
	statusQueue: ReviewStatusV3[];
	statusCalls: Array<{ cwd: string; lineageId?: string; agent?: "pi" }>;
	unachievableCalls: NativeReviewUnachievableLensCaptureRequest[];
	native: NativeReviewCli;
}

type UnachievableResponder = (request: NativeReviewUnachievableLensCaptureRequest) => Promise<NativeReviewUnachievableLensCaptureArtifact>;

// The declaration verb stays OPT-IN: an absent captureUnachievableLens is the invocation-adjacent capability gate, so every pre-existing failure test keeps its exact envelope through the unchanged fall-back.
function nativeHarness(statuses: readonly ReviewStatusV3[], unachievableResponder?: UnachievableResponder): RoutingHarness {
	const harness: RoutingHarness = {
		statusQueue: [...statuses],
		statusCalls: [],
		unachievableCalls: [],
		native: undefined as unknown as NativeReviewCli,
	};
	harness.native = {
		targetStatus: async (request) => {
			harness.statusCalls.push({ cwd: request.cwd, ...(request.lineageId === undefined ? {} : { lineageId: request.lineageId }), ...(request.agent === undefined ? {} : { agent: request.agent }) });
			const next = harness.statusQueue.shift();
			if (next === undefined) throw new Error("status queue exhausted");
			return next;
		},
		...(unachievableResponder === undefined ? {} : { captureUnachievableLens: async (request: NativeReviewUnachievableLensCaptureRequest) => { harness.unachievableCalls.push(request); return await unachievableResponder(request); } }),
	};
	return harness;
}

async function runCapture(cwd: string, harness: RoutingHarness, lineageId: string, input: Record<string, unknown> = { reviewerRunAcknowledged: true }): Promise<Record<string, unknown>> {
	const selected = harness.statusQueue[0]?.nextTransition?.collect?.inputs[0];
	if (selected === undefined) throw new Error("capture test requires one current collect input");
	return await __testing.executeReviewCaptureOperation(
		{ lineageId, collectBinding: JSON.stringify(selected), ...input },
		cwd,
		harness.native,
	) as Record<string, unknown>;
}

test("one materialize binding routes exactly one provider slot through the host relay", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const input = relayCollectInput(lineageId, "review-risk", 0);
	const harness = nativeHarness([finalizeStatus(lineageId, [input])]);
	const relayed: ReviewHostRelayRequest[] = [];
	__testing.setReviewHostRelayRunnerForTesting(async (request: ReviewHostRelayRequest) => {
		relayed.push(request);
		return { promptByteLength: 64, resultByteLength: 32, submission: '{"admission_decision":"completed"}' };
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(relayed.length, 1);
	assert.deepEqual(relayed[0]!.captureArgumentTokens, input.arguments.map((argument) => argument.token));
	assert.deepEqual(relayed[0]!.submission, providerSubmission(lineageId, "review-risk", 0));
	assert.equal(harness.statusCalls.length, 1, "a nonterminal capture does not auto-follow STATUS");
	assert.equal(result.status, "captured");
	assert.equal((result.host_relay as { transport: string }).transport, "pi_host_relay");
});

// gentle-pi#311 P3: a v9 host-mediated refuter/targeted-validator slot reuses
// this exact relay machinery — the only role-specific part reachable from
// here is the fixed routing key it resolves through, since it carries no
// per-slot lens identity.
test("a v9 host-mediated refuter slot routes through the host relay with its fixed routing key", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-role-lineage";
	const input = hostMediatedRefuterCollectInput(lineageId);
	const harness = nativeHarness([finalizeStatus(lineageId, [input])]);
	const relayed: ReviewHostRelayRequest[] = [];
	__testing.setReviewHostRelayRunnerForTesting(async (request: ReviewHostRelayRequest) => {
		relayed.push(request);
		return { promptByteLength: 64, resultByteLength: 32, submission: '{"admission_decision":"completed"}' };
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(relayed.length, 1);
	assert.equal(relayed[0]!.routingKey, "review-refuter");
	assert.deepEqual(relayed[0]!.captureArgumentTokens, input.arguments.map((argument) => argument.token));
	assert.deepEqual(relayed[0]!.submission, input.submission);
	assert.equal(harness.statusCalls.length, 1, "a nonterminal capture does not auto-follow STATUS");
	assert.equal(result.status, "captured");
	assert.equal((result.host_relay as { transport: string }).transport, "pi_host_relay");
});

// The reviewer selection is validated before any process launches (the same
// discipline a lens slot already has): a routing config with no
// review-refuter entry is refused typed, naming that exact key, never a
// mid-relay transport failure.
test("a missing review-refuter routing model is refused typed, naming the key, before any relay launch", async (t) => {
	const cwd = repository(t);
	const lineageId = "relay-role-missing-model";
	const input = hostMediatedRefuterCollectInput(lineageId);
	const harness = nativeHarness([finalizeStatus(lineageId, [input])]);

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	const failure = result.failure as { kind?: string } | undefined;
	assert.equal(failure?.kind, "reviewer-config-invalid");
	assert.match(String(result.reason), /review-refuter/);
});

test("Pi-authored review documents are rejected at the capture input boundary", async (t) => {
	// The narrow capture schema rejects a caller-authored reviewer document
	// before any relay launch or native call.
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-reliability", 0)])]);
	let relayCalls = 0;
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		relayCalls += 1;
		return { promptByteLength: 1, resultByteLength: 1, submission: "{}" };
	});

	await assert.rejects(
		() => runCapture(cwd, harness, lineageId, { review_result: { lens_results: [{ findings: [], evidence: ["reviewed"] }] } }),
		/does not accept review_result/,
	);
	assert.equal(relayCalls, 0);
});

function groupInputs(lineageId: string, revision = SHA): ReviewCollectInputV3[] { return ["review-risk", "review-resilience", "review-readability", "review-reliability"].map((lens, order) => relayCollectInput(lineageId, lens, order, true, "provider", revision)); }

async function runCaptureGroup(cwd: string, harness: RoutingHarness, lineageId: string, inputs: readonly ReviewCollectInputV3[], reviewerRunAcknowledged = true): Promise<Record<string, unknown>> { return await __testing.executeReviewCaptureGroupOperation({ lineageId, collectBindings: inputs.map((input) => JSON.stringify(input)), reviewerRunAcknowledged }, cwd, harness.native) as Record<string, unknown>; }

function prepared(request: ReviewHostRelayRequest) { return { request, promptByteLength: 64, resultByteLength: 32 }; }

test("grouped capture forecasts once, reaches a four-reviewer barrier, and reconciles unclosed submissions", async (t) => {
	t.after(() => __testing.setReviewHostRelayGroupRunnersForTesting());
	const cwd = repository(t), lineageId = "relay-group", inputs = groupInputs(lineageId), lenses = inputs.map((input) => input.arguments.find((argument) => argument.name === "lens")!.value);
	const harness = nativeHarness([finalizeStatus(lineageId, inputs), finalizeStatus(lineageId, inputs), ...inputs.map((_input, index) => finalizeStatus(lineageId, index === 1 ? [...inputs.slice(index), { name: "unrelated", schema: "example", captureOperation: "external.example", arguments: [] }] : inputs.slice(index))), providerRefuterRequiredStatus(lineageId)]);
	let ready!: () => void;
	const allStarted = new Promise<void>((resolve) => { ready = resolve; });
	const releases = new Map<string, () => void>(), completed: string[] = [], submitted: string[] = [];
	const reviewerGroup = async (requests: readonly ReviewHostRelayRequest[]) => await Promise.all(requests.map(async (request) => {
		const lens = request.captureArgumentTokens.find((token) => token.startsWith("--lens="))!.slice(7);
		await new Promise<void>((resolve) => { releases.set(lens, resolve); if (releases.size === requests.length) ready(); });
		completed.push(lens); return prepared(request);
	}));
	__testing.setReviewHostRelayGroupRunnersForTesting(reviewerGroup, async (result) => {
		submitted.push(result.request.captureArgumentTokens.find((token) => token.startsWith("--lens="))!.slice(7));
		return { promptByteLength: result.promptByteLength, resultByteLength: result.resultByteLength, submission: "{}" };
	});
	const forecast = await runCaptureGroup(cwd, harness, lineageId, inputs, false);
	assert.deepEqual(forecast.cost_forecast, { transport: "pi_host_relay", model_runs: 4, lenses });
	const run = runCaptureGroup(cwd, harness, lineageId, inputs);
	await allStarted;
	assert.deepEqual([...releases.keys()], lenses, "all reviewers start before the group waits");
	for (const lens of [...lenses].reverse()) releases.get(lens!)!();
	const result = await run;
	assert.deepEqual(completed, [...lenses].reverse(), "reviewer completion order is not submission order");
	assert.deepEqual(submitted, lenses);
	assert.deepEqual({ outcome: result.outcome, statusCalls: harness.statusCalls.length, providerAction: result.provider_action }, { outcome: "native-reviewer-group-status-reconciled", statusCalls: 7, providerAction: "stop" });
	assert.equal(harness.statusCalls.at(-1)?.agent, "pi", "post-last-capture reconciliation preserves the Pi host runtime");
	assert.equal((result.next_transition as { kind?: string; reasonCode?: string } | undefined)?.kind, "collect");
	assert.equal((result.next_transition as { kind?: string; reasonCode?: string } | undefined)?.reasonCode, "provider_refuter_required");
});

test("captured v5 STATUS accepts capture-phase Pn when authority has advanced to Rn at the forecast boundary", async (t) => {
	t.after(() => __testing.setReviewHostRelayGroupRunnersForTesting());
	const cwd = repository(t), lineageId = "relay-group-phase-revision", status = capturedGroupedStatus(lineageId, SHA), inputs = status.nextTransition!.collect!.inputs!;
	let launches = 0;
	__testing.setReviewHostRelayGroupRunnersForTesting(async (requests) => { launches += requests.length; return requests.map(prepared); });

	assert.notEqual(status.authority!.revision, status.repositoryContext!.revision, "captured v5 group keeps capture-phase Pn distinct from authority Rn");
	const forecast = await runCaptureGroup(cwd, nativeHarness([status]), lineageId, inputs, false);

	assert.equal(forecast.outcome, "reviewer-model-run-forecast");
	assert.deepEqual(forecast.cost_forecast, { transport: "pi_host_relay", model_runs: 4, lenses: ["review-risk", "review-resilience", "review-readability", "review-reliability"] });
	assert.equal(launches, 0, "decoder-valid capture-phase Pn must pass admission before any reviewer model launch");
});

 test("group rejects STATUS repository target mismatch and per-slot revision, context, or target drift before launch", async (t) => {
	t.after(() => __testing.setReviewHostRelayGroupRunnersForTesting());
	const cwd = repository(t), lineageId = "relay-group-slot-consistency";
	const repositoryTargetMismatch = capturedGroupedStatus(lineageId, SHA);
	repositoryTargetMismatch.repositoryContext!.targetIdentity = SHA;
	const revisionMismatch = capturedGroupedStatus(lineageId, SHA);
	replaceArgument(revisionMismatch.nextTransition!.collect!.inputs![1]!, "expected-revision", SHA);
	const contextMismatch = capturedGroupedStatus(lineageId, SHA);
	replaceArgument(contextMismatch.nextTransition!.collect!.inputs![1]!, "repository-context", `rctx1_${"f".repeat(64)}`);
	const targetMismatch = capturedGroupedStatus(lineageId, SHA);
	replaceArgument(targetMismatch.nextTransition!.collect!.inputs![1]!, "target", SHA);
	let launches = 0;
	__testing.setReviewHostRelayGroupRunnersForTesting(async (requests) => { launches += requests.length; return requests.map(prepared); });

	// Each call forwards this STATUS's own current set, so rejection proves an
	// internal STATUS guard rather than stale or caller/canonical mismatch.
	const repositoryTargetResult = await runCaptureGroup(cwd, nativeHarness([repositoryTargetMismatch]), lineageId, repositoryTargetMismatch.nextTransition!.collect!.inputs!);
	assert.deepEqual({ outcome: repositoryTargetResult.outcome, reason: repositoryTargetResult.reason }, {
		outcome: "capture-group-rejected",
		reason: "current STATUS repository context does not match the reviewer group binding",
	});
	const revisionResult = await runCaptureGroup(cwd, nativeHarness([revisionMismatch]), lineageId, revisionMismatch.nextTransition!.collect!.inputs!);
	assert.deepEqual({ outcome: revisionResult.outcome, reason: revisionResult.reason }, {
		outcome: "capture-group-rejected",
		reason: "current STATUS carries an incomplete or mismatched materialize reviewer binding",
	});
	const contextResult = await runCaptureGroup(cwd, nativeHarness([contextMismatch]), lineageId, contextMismatch.nextTransition!.collect!.inputs!);
	assert.deepEqual({ outcome: contextResult.outcome, reason: contextResult.reason }, {
		outcome: "capture-group-rejected",
		reason: "current STATUS carries an incomplete or mismatched materialize reviewer binding",
	});
	const targetResult = await runCaptureGroup(cwd, nativeHarness([targetMismatch]), lineageId, targetMismatch.nextTransition!.collect!.inputs!);
	assert.deepEqual({ outcome: targetResult.outcome, reason: targetResult.reason }, {
		outcome: "capture-group-rejected",
		reason: "current STATUS carries an incomplete or mismatched materialize reviewer binding",
	});
	assert.equal(launches, 0, "current STATUS consistency checks reject before reviewer model launch");
});

test("group rejects absent or mismatched current repository context before launch", async (t) => {
	t.after(() => __testing.setReviewHostRelayGroupRunnersForTesting());
	const cwd = repository(t), lineageId = "relay-group-context-reject", inputs = groupInputs(lineageId, PHASE_REVISION);
	const revisionMismatch = finalizeStatus(lineageId, inputs);
	const handleMismatch = finalizeStatus(lineageId, inputs);
	const absent = finalizeStatus(lineageId, inputs);
	handleMismatch.repositoryContext = { capability: "review.opaque_repository_context", handle: `rctx1_${"f".repeat(64)}`, revision: PHASE_REVISION, targetIdentity: SHA };
	delete absent.repositoryContext;
	let launches = 0;
	__testing.setReviewHostRelayGroupRunnersForTesting(async (requests) => { launches += requests.length; return requests.map(prepared); });

	for (const status of [revisionMismatch, handleMismatch, absent]) {
		const result = await runCaptureGroup(cwd, nativeHarness([status]), lineageId, inputs);
		assert.equal(result.outcome, "capture-group-rejected");
	}
	assert.equal(launches, 0, "repository-context validation must reject before reviewer model launch");
});

test("group rejects partial, duplicate, reordered, stale, mixed, and late-invalid bindings before launch", async (t) => {
	t.after(() => __testing.setReviewHostRelayGroupRunnersForTesting());
	const cwd = repository(t), lineageId = "relay-group-reject", inputs = groupInputs(lineageId);
	const stale = JSON.parse(JSON.stringify(inputs[3]!)) as ReviewCollectInputV3;
	stale.arguments = [...stale.arguments, { name: "replacement", value: "stale", token: "--replacement=stale" }];
	const mixed = [...inputs.slice(0, 3), relayCollectInput(lineageId, "review-reliability", 3, false)];
	const malformed = JSON.parse(JSON.stringify(inputs)) as ReviewCollectInputV3[];
	malformed[3]!.submission!.argumentTokens = ["--input={{value}}"];
	const cases = [
		{ bindings: inputs.slice(0, 3), current: inputs }, { bindings: [...inputs].reverse(), current: inputs },
		{ bindings: [...inputs.slice(0, 3), inputs[2]!], current: inputs }, { bindings: [...inputs.slice(0, 3), stale], current: inputs },
		{ bindings: mixed, current: mixed }, { bindings: malformed, current: malformed },
	];
	let launches = 0;
	__testing.setReviewHostRelayGroupRunnersForTesting(async (requests) => { launches += requests.length; return requests.map(prepared); });
	for (const entry of cases) {
		const result = await runCaptureGroup(cwd, nativeHarness([finalizeStatus(lineageId, entry.current)]), lineageId, entry.bindings);
		assert.equal(result.outcome, "capture-group-rejected");
	}
	assert.equal(launches, 0);
});

test("group preserves earlier admission when a later STATUS drifts, and stops on closure or unknown outcome", async (t) => {
	t.after(() => __testing.setReviewHostRelayGroupRunnersForTesting());
	const cwd = repository(t), lineageId = "relay-group-stop", inputs = groupInputs(lineageId);
	const reviewerGroup = async (requests: readonly ReviewHostRelayRequest[]) => requests.map(prepared);
	let submissions = 0;
	__testing.setReviewHostRelayGroupRunnersForTesting(reviewerGroup, async (result) => { submissions += 1; return { promptByteLength: result.promptByteLength, resultByteLength: result.resultByteLength, submission: "{}" }; });
	const staleStatus = finalizeStatus(lineageId, inputs), stale = await runCaptureGroup(cwd, nativeHarness([finalizeStatus(lineageId, inputs), finalizeStatus(lineageId, inputs), staleStatus]), lineageId, inputs);
	assert.deepEqual({ outcome: stale.outcome, submissions, mutation: stale.mutation_performed, mutationOutcome: stale.mutation_outcome }, { outcome: "capture-group-authority-drift", submissions: 1, mutation: true, mutationOutcome: "partial" });
	assert.equal(stale.reconciliation, staleStatus.raw);
	submissions = 0;
	const drift = await runCaptureGroup(cwd, nativeHarness([finalizeStatus(lineageId, inputs), finalizeStatus(lineageId, inputs), finalizeStatus(lineageId, inputs.slice(2))]), lineageId, inputs);
	assert.deepEqual({ outcome: drift.outcome, submissions, mutation: drift.mutation_performed, mutationOutcome: drift.mutation_outcome }, { outcome: "capture-group-authority-drift", submissions: 1, mutation: true, mutationOutcome: "partial" });
	assert.deepEqual(((drift.host_relay as { reviewers: Array<{ lens: string }> }).reviewers).map((reviewer) => reviewer.lens), ["review-risk"]);
	submissions = 0;
	__testing.setReviewHostRelayGroupRunnersForTesting(reviewerGroup, async (result) => { submissions += 1; return { promptByteLength: result.promptByteLength, resultByteLength: result.resultByteLength, submission: JSON.stringify({ schema: "gentle-ai.review-last-event-closure/v1", operation: "review/capture-result", lineage_id: lineageId, state: "approved", store_revision: SHA, action: "native last event closed the review" }) }; });
	const terminal = await runCaptureGroup(cwd, nativeHarness([finalizeStatus(lineageId, inputs), finalizeStatus(lineageId, inputs)]), lineageId, inputs);
	assert.deepEqual({ status: terminal.status, submissions }, { status: "closed", submissions: 1 });
	submissions = 0;
	__testing.setReviewHostRelayGroupRunnersForTesting(reviewerGroup, async () => { submissions += 1; throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit", "unknown", { timedOut: true }); });
	const unknown = await runCaptureGroup(cwd, nativeHarness([finalizeStatus(lineageId, inputs), finalizeStatus(lineageId, inputs), finalizeStatus(lineageId, inputs)]), lineageId, inputs);
	assert.deepEqual({ status: unknown.status, submissions }, { status: "reconciled", submissions: 1 });
});

test("an old binary reports the relay as unavailable without touching existing behavior", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-reliability", 0)])]);
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE, "materialize", REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE, { exitCode: 2, stderr: "flag provided but not defined: -materialize" });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "pi-host-relay-unavailable");
	assert.equal(result.reason, REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE);
	assert.equal(result.mutation_performed, false);
	assert.equal(result.mutation_outcome, "none");
});

test("a handshake refusal surfaces the provider refusal verbatim through the controller envelope", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const refusal = "the active runtime is not eligible for immutable receipt review; supported immutable review runtimes: claude-code, codex, opencode";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-reliability", 0)])]);
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.HANDSHAKE_REFUSED, "materialize", refusal, { exitCode: 1, stderr: refusal });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.outcome, "pi-host-relay-handshake-refused");
	assert.equal(result.reason, refusal);
	assert.equal(result.refusal, refusal);
});

test("a transport failure stops the selected capture without auto-follow", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-risk", 0)])]);
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi", "pi subprocess failed", { exitCode: 4 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "pi-host-relay-transport-failure");
	assert.deepEqual(result.failure, { kind: "pi-failed", stage: "pi", exit_code: 4, timed_out: false });
	assert.match(String(result.next_action), /fresh STATUS/);
	assert.equal(harness.statusCalls.length, 1, "no automatic relaunch after transport failure");
});

// gentle-pi#522 / #524: a submission Go refused at admission is a proven
// non-mutation. The model must see the refusal text, mutation_outcome none,
// and a continuation for the reoffered slot, never an unknown outcome that the
// contract forbids replaying.
test("an admission refusal reaches the model as a proven non-mutation carrying the refusal and a continuation", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-risk", 0)])]);
	const refusal = "Error: reviewer artifact admission binding_mismatch: reviewer result echoed a different artifact subject: the rejected admission did not consume the lens slot, so re-run the lens and invoke gentle-ai review capture-result again on the same lineage with a result that echoes the binding's top-level subject_hash [invalid_request]\n";
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit", refusal.trim(), { exitCode: 1, stderr: refusal, elapsedMs: 40, timeoutMs: 120_000, mutationOutcome: "none" });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "pi-host-relay-transport-failure");
	assert.deepEqual(result.failure, { kind: "submission-refused", stage: "submit", exit_code: 1, timed_out: false, elapsed_ms: 40, timeout_ms: 120_000, stderr: refusal });
	assert.equal(result.reason, refusal.trim());
	assert.equal(result.mutation_performed, false);
	assert.equal(result.mutation_outcome, "none");
	assert.match(String(result.next_action), /did not consume the lens slot/);
	assert.match(String(result.next_action), /fresh STATUS/);
	assert.equal(harness.statusCalls.length, 1, "a proven non-mutation needs no STATUS reconciliation and no relaunch");
});

test("a submission whose outcome is genuinely indeterminate still reconciles through STATUS and carries its evidence", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const pending = finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-risk", 0)]);
	const harness = nativeHarness([pending, pending]);
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit", "gentle-ai capture submission exceeded its 120000ms bound after 120004ms", { exitCode: null, stderr: "", timedOut: true, elapsedMs: 120_004, timeoutMs: 120_000 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "reconciled");
	assert.equal(result.outcome, "native-capture-outcome-unknown");
	assert.deepEqual(result.failure, { kind: "submission-refused", stage: "submit", exit_code: null, timed_out: true, elapsed_ms: 120_004, timeout_ms: 120_000 });
	assert.match(String(result.reason), /exceeded its 120000ms bound/);
	assert.equal(harness.statusCalls.length, 2, "an indeterminate submission reconciles exactly once through STATUS");
	assert.equal(harness.statusCalls.at(-1)?.agent, "pi", "ordinary host-relay reconciliation preserves the Pi host runtime");
});

test("a relay timeout reports its one-slot measurements and no auto-follow", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-risk", 0)])]);
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(
			REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT,
			"pi",
			"pi reviewer subprocess exceeded the relay bound",
			{ exitCode: null, timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 },
		);
	});

	const result = await runCapture(cwd, harness, lineageId);
	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "pi-host-relay-timeout");
	assert.deepEqual(result.failure, { kind: "pi-timed-out", stage: "pi", exit_code: null, timed_out: true, elapsed_ms: 2_256_004, timeout_ms: 2_256_000 });
	assert.match(String(result.next_action), new RegExp(`${REVIEW_HOST_RELAY_PI_TIMEOUT_ENV}=<milliseconds>`));
	assert.match(String(result.next_action), new RegExp(String(REVIEW_HOST_RELAY_PI_TIMEOUT_MAX_MS)));
	assert.equal(harness.statusCalls.length, 1);
});

// gentle-pi#638: the typed stop a provider renders after a host declared a
// slot unachievable, built through the production decoder so the routing
// tests exercise the same typed shape the extension consumes.
function unachievableStopStatus(lineageId: string, lens: ReviewArtifactSubjectV2["lens"], order: number, reason = "relay_transport_bound_exceeded"): ReviewStatusV3 {
	const subjectHash = `sha256:${String(order).repeat(64)}`;
	const repositoryContext = `rctx1_${"e".repeat(64)}`;
	const rawTransition = {
		kind: "stop",
		reason_code: "unachievable_lens_slot",
		unachievable_lens_slots: [
			{
				lens,
				selected_order: order,
				subject_hash: subjectHash,
				reason,
				withdraw: {
					operation: "review.capture-unachievable",
					command: `gentle-ai review capture-unachievable --lineage=${lineageId} --expected-revision=${SHA} --target=${SHA} --repository-context=${repositoryContext} --request-hash=${subjectHash} --withdraw=true`,
					arguments: [
						{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
						{ name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` },
						{ name: "target", value: SHA, token: `--target=${SHA}` },
						{ name: "repository-context", value: repositoryContext, token: `--repository-context=${repositoryContext}` },
						{ name: "request-hash", value: subjectHash, token: `--request-hash=${subjectHash}` },
						{ name: "withdraw", value: "true", token: "--withdraw=true" },
					],
					binding: { lineage_id: lineageId, revision: SHA, target_identity: SHA, repository_context: repositoryContext },
				},
			},
		],
	};
	return {
		...finalizeStatus(lineageId),
		nextTransition: decodeReviewNextTransitionV3(rawTransition),
		raw: { schema: "gentle-ai.review-integration.status/v5", action: "stop", lineage_id: lineageId, target_identity: SHA, next_transition: rawTransition },
	} as unknown as ReviewStatusV3;
}

function unachievableArtifact(lineageId: string, lens: ReviewArtifactSubjectV2["lens"], order: number, reason = "relay_transport_bound_exceeded"): NativeReviewUnachievableLensCaptureArtifact {
	return { schema: "gentle-ai.review-capture-unachievable/v1", lineageId, targetIdentity: SHA, lens, selectedOrder: order, reason, recorded: true };
}

// gentle-pi#638: a deterministic pi timeout is declared unachievable through
// the native verb, and one bound STATUS re-query renders the typed stop with
// its withdraw binding instead of reoffering the same slot.
test("a deterministic pi timeout declares the slot unachievable and renders the typed stop", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const input = relayCollectInput(lineageId, "review-risk", 0);
	const stop = unachievableStopStatus(lineageId, "review-risk", 0);
	const harness = nativeHarness([finalizeStatus(lineageId, [input]), stop], () => Promise.resolve(unachievableArtifact(lineageId, "review-risk", 0)));
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "pi reviewer subprocess exceeded the relay bound", { exitCode: null, timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "unachievable-lens-slot-declared");
	assert.deepEqual(result.failure, { kind: "pi-timed-out", stage: "pi", exit_code: null, timed_out: true, elapsed_ms: 2_256_004, timeout_ms: 2_256_000 });
	assert.deepEqual(harness.unachievableCalls, [{ cwd: realpathSync(cwd), lineageId, targetIdentity: SHA, expectedRevision: SHA, requestHash: `sha256:${"0".repeat(64)}`, reason: "relay_transport_bound_exceeded", detail: "killed after 2256004ms against a 2256000ms relay bound", repositoryContext: `rctx1_${"e".repeat(64)}` }]);
	assert.deepEqual(result.declaration, { lens: "review-risk", selected_order: 0, subject_hash: `sha256:${"0".repeat(64)}`, reason: "relay_transport_bound_exceeded" });
	assert.deepEqual(result.result, stop.raw);
	const slots = result.unachievable_lens_slots as Array<{ lens: string; subject_hash: string; withdraw: string }>;
	assert.equal(slots.length, 1);
	assert.equal(slots[0]!.lens, "review-risk");
	assert.equal(slots[0]!.subject_hash, `sha256:${"0".repeat(64)}`);
	assert.match(slots[0]!.withdraw, /capture-unachievable.*--withdraw=true/);
	assert.match(String(result.next_action), /withdraw/);
	assert.equal(result.mutation_performed, true);
	// gentle-pi#822: the native declaration was recorded, so the flow reports the mutation as committed, not none.
	assert.equal(result.mutation_outcome, "committed");
	assert.equal(harness.statusCalls.length, 2, "one selection STATUS plus exactly one bound re-query");
	assert.equal(harness.statusCalls.at(-1)?.agent, "pi", "the bound re-query preserves the Pi host runtime");
});

// gentle-pi#638: generic admission rejections describe the submitted reviewer
// bytes, not a deterministic failure of the provider-bound slot. A fresh
// reviewer can repair malformed JSON or a binding mismatch, so both retain the
// ordinary exact-reoffer path and must never declare the slot unachievable.
test("repairable submission refusals retain the exact-slot retry path", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	for (const refusal of [
		"Error: reviewer payload contains no complete JSON object [invalid_request]\n",
		"Error: reviewer artifact admission binding_mismatch [invalid_request]\n",
	]) {
		const input = relayCollectInput(lineageId, "review-reliability", 0);
		const harness = nativeHarness([finalizeStatus(lineageId, [input])], async () => {
			throw new Error("a repairable refusal must not call capture-unachievable");
		});
		__testing.setReviewHostRelayRunnerForTesting(async () => {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit", refusal.trim(), { exitCode: 1, stderr: refusal, mutationOutcome: "none" });
		});

		const result = await runCapture(cwd, harness, lineageId);

		assert.equal(result.outcome, "pi-host-relay-transport-failure");
		assert.equal(result.mutation_performed, false);
		assert.equal(result.mutation_outcome, "none");
		assert.match(String(result.next_action), /fresh STATUS/);
		assert.deepEqual(harness.unachievableCalls, []);
		assert.equal(harness.statusCalls.length, 1, "a repairable non-mutation needs no reconciliation before the provider reoffers it");
	}
});

// gentle-pi#822: a stop carrying slots that do not match the identity this
// session declared is a reconciliation failure — never a success rendering
// someone else's withdraw command.
test("a stop whose slots do not match the declared identity reports a reconciliation failure", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const input = relayCollectInput(lineageId, "review-risk", 0);
	const foreignStop = unachievableStopStatus(lineageId, "review-risk", 1);
	const harness = nativeHarness([finalizeStatus(lineageId, [input]), foreignStop], () => Promise.resolve(unachievableArtifact(lineageId, "review-risk", 0)));
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "pi reviewer subprocess exceeded the relay bound", { exitCode: null, timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "unachievable-lens-declaration-reconciliation-failed");
	assert.deepEqual(result.declaration, { lens: "review-risk", selected_order: 0, subject_hash: `sha256:${"0".repeat(64)}`, reason: "relay_transport_bound_exceeded" });
	assert.equal(result.unachievable_lens_slots, undefined, "a foreign slot is never exposed as this session's withdraw command");
	const reconciliationFailure = result.reconciliation_failure as { outcome?: string; reason?: string } | undefined;
	assert.equal(reconciliationFailure?.outcome, "unachievable-lens-slot-declaration-unmatched");
	assert.match(String(reconciliationFailure?.reason), /no unachievable_lens_slots entry matches the declared slot identity/);
	assert.equal(result.mutation_performed, true);
	assert.equal(result.mutation_outcome, "committed");
	assert.match(String(result.next_action), /refused the unachievable declaration/);
	assert.equal(harness.statusCalls.length, 2, "the bound re-query still runs exactly once");
});

// gentle-pi#822: with several declared entries on the stop, only the matching
// identity is exposed — never the withdraw commands of other runs.
test("a stop carrying several declared slots exposes only the one this session declared", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const input = relayCollectInput(lineageId, "review-risk", 0);
	const stop = unachievableStopStatus(lineageId, "review-risk", 0);
	const foreign = unachievableStopStatus(lineageId, "review-reliability", 2).nextTransition?.unachievableLensSlots?.[0];
	assert.ok(foreign !== undefined);
	stop.nextTransition = { ...stop.nextTransition!, unachievableLensSlots: [...stop.nextTransition!.unachievableLensSlots!, foreign] };
	const harness = nativeHarness([finalizeStatus(lineageId, [input]), stop], () => Promise.resolve(unachievableArtifact(lineageId, "review-risk", 0)));
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "pi reviewer subprocess exceeded the relay bound", { exitCode: null, timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.outcome, "unachievable-lens-slot-declared");
	const slots = result.unachievable_lens_slots as Array<{ lens: string; selected_order: number; subject_hash: string }>;
	assert.equal(slots.length, 1, "only the declared entry is exposed");
	assert.equal(slots[0]!.lens, "review-risk");
	assert.equal(slots[0]!.selected_order, 0);
	assert.equal(slots[0]!.subject_hash, `sha256:${"0".repeat(64)}`);
	assert.equal(result.mutation_outcome, "committed");
});

// gentle-pi#822 (CodeRabbit finding): success must be proven by the unachievable_lens_slot stop itself — a bound STATUS that comes back with a collect reoffer instead of the stop is a reconciliation failure, never a silent success with no withdraw command.
test("a bound STATUS that reoffers the collect transition instead of the stop reports a reconciliation failure", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const input = relayCollectInput(lineageId, "review-risk", 0);
	const harness = nativeHarness([finalizeStatus(lineageId, [input]), finalizeStatus(lineageId, [input])], () => Promise.resolve(unachievableArtifact(lineageId, "review-risk", 0)));
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "pi reviewer subprocess exceeded the relay bound", { exitCode: null, timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "unachievable-lens-declaration-reconciliation-failed");
	assert.equal(result.unachievable_lens_slots, undefined, "no stop means no withdraw command to expose");
	const reconciliationFailure = result.reconciliation_failure as { outcome?: string; reason?: string };
	assert.equal(reconciliationFailure?.outcome, "unachievable-lens-slot-declaration-unmatched");
	assert.match(String(reconciliationFailure?.reason), /did not return the unachievable_lens_slot stop/);
	assert.equal(result.mutation_performed, true, "the declaration was recorded");
	assert.equal(result.mutation_outcome, "committed");
	assert.equal(harness.statusCalls.length, 2, "the bound re-query still runs exactly once");
});

// gentle-pi#822 (CodeRabbit finding): the same proof requirement covers every STATUS shape that is not the stop — a foreign stop reason code or no transition at all.
test("a bound STATUS stop with a foreign reason code or no transition reports a reconciliation failure", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const input = relayCollectInput(lineageId, "review-risk", 0);
	const responder = () => Promise.resolve(unachievableArtifact(lineageId, "review-risk", 0));
	const relayFailure = async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "pi reviewer subprocess exceeded the relay bound", { exitCode: null, timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 });
	};

	const foreignStop = { ...finalizeStatus(lineageId), nextTransition: { kind: "stop", reasonCode: "rdd_disabled" } } as unknown as ReviewStatusV3;
	const foreignHarness = nativeHarness([finalizeStatus(lineageId, [input]), foreignStop], responder);
	__testing.setReviewHostRelayRunnerForTesting(relayFailure);
	const foreign = await runCapture(cwd, foreignHarness, lineageId);

	assert.equal(foreign.outcome, "unachievable-lens-declaration-reconciliation-failed");
	assert.equal(foreign.unachievable_lens_slots, undefined);
	const foreignFailure = foreign.reconciliation_failure as { outcome?: string; reason?: string };
	assert.match(String(foreignFailure?.reason), /did not return the unachievable_lens_slot stop/);
	assert.equal(foreign.mutation_performed, true);
	assert.equal(foreign.mutation_outcome, "committed");

	const bareHarness = nativeHarness([finalizeStatus(lineageId, [input]), finalizeStatus(lineageId)], responder);
	__testing.setReviewHostRelayRunnerForTesting(relayFailure);
	const bare = await runCapture(cwd, bareHarness, lineageId);

	assert.equal(bare.outcome, "unachievable-lens-declaration-reconciliation-failed");
	assert.equal(bare.unachievable_lens_slots, undefined);
	const bareFailure = bare.reconciliation_failure as { outcome?: string; reason?: string };
	assert.match(String(bareFailure?.reason), /did not return the unachievable_lens_slot stop/);
	assert.equal(bare.mutation_outcome, "committed");
	assert.equal(bareHarness.statusCalls.length, 2);
});

// gentle-pi#822: STATUS for one lineage renders only that lineage's withdraw
// command as the hint; a request for an unlisted lineage omits the hint rather
// than surfacing a potentially unrelated withdraw command.
test("an unachievable stop renders the withdraw hint only for the requested lineage", async (t) => {
	const cwd = repository(t);
	const matchedHarness = nativeHarness([unachievableStopStatus("other-lineage", "review-risk", 0)]);
	const matched = (await __testing.executeReviewControllerOperation({ operation: "status", lineageId: "other-lineage" }, cwd, matchedHarness.native)) as Record<string, unknown>;
	assert.match(String(matched.hint), /capture-unachievable.*--withdraw=true/);
	assert.equal(matched.requested_lineage_id, "other-lineage");

	const unmatchedHarness = nativeHarness([unachievableStopStatus("other-lineage", "review-risk", 0)]);
	const unmatched = (await __testing.executeReviewControllerOperation({ operation: "status", lineageId: "relay-lineage" }, cwd, unmatchedHarness.native)) as Record<string, unknown>;
	assert.equal(unmatched.hint, undefined, "no hint when no slot matches the requested lineage");
	assert.equal(unmatched.requested_lineage_id, "relay-lineage");
});

// The fail-open capability gate: an older binary that refuses the whole verb
// keeps today's transport-failure envelope untouched.
test("an unknown-verb refusal falls back to today's transport-failure behavior", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-risk", 0)])], async () => {
		throw Object.assign(new Error("native command returned empty output"), { diagnostics: { stderr: 'Error: unknown review command "capture-unachievable"\n' } });
	});
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "pi reviewer subprocess exceeded the relay bound", { exitCode: null, timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "pi-host-relay-timeout");
	assert.equal(harness.unachievableCalls.length, 1, "the verb was attempted exactly once");
	assert.equal(harness.statusCalls.length, 1, "the fall-back performs no bound STATUS re-query");
	assert.match(String(result.next_action), new RegExp(`${REVIEW_HOST_RELAY_PI_TIMEOUT_ENV}=<milliseconds>`));
});

// Every non-capability declaration failure — here a typed binding-mismatch
// refusal — is surfaced with both failures, never hidden behind the relay
// failure it followed.
test("a refused declaration surfaces both failures instead of the transport fall-back", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-risk", 0)])], async () => {
		throw Object.assign(new Error("review capture-unachievable binding does not match the current reviewing authority"), { diagnostics: { stderr: "Error: review capture-unachievable binding does not match [invalid_request]" } });
	});
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "pi reviewer subprocess exceeded the relay bound", { exitCode: null, timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "unachievable-lens-declaration-failed");
	assert.equal(result.mutation_performed, false);
	assert.equal(result.mutation_outcome, "none");
	assert.deepEqual(result.failure, { kind: "pi-timed-out", stage: "pi", exit_code: null, timed_out: true, elapsed_ms: 2_256_004, timeout_ms: 2_256_000 });
	assert.ok(result.declaration_failure, "the declaration refusal rides the envelope");
	assert.equal(harness.statusCalls.length, 1, "a refused declaration performs no bound STATUS re-query");
	assert.match(String(result.next_action), /fresh STATUS/);
});

// gentle-pi#822 (outside-diff finding): the declaration failure's own envelope carries the mutation truth — a failure AFTER the provider recorded the declaration reports committed, never a hardcoded none.
test("a declaration failure whose envelope already committed propagates its mutation state", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-risk", 0)])], async () => {
		throw Object.assign(new Error("review capture-unachievable failed after recording"), { failureEnvelope: { raw: { code: "invalid_request", message: "review capture-unachievable failed after recording" }, mutationOutcome: "committed" } });
	});
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "pi reviewer subprocess exceeded the relay bound", { exitCode: null, timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "unachievable-lens-declaration-failed");
	assert.equal(result.mutation_performed, true);
	assert.equal(result.mutation_outcome, "committed");
	assert.ok(result.declaration_failure, "the declaration failure still rides the envelope");
	assert.equal(harness.statusCalls.length, 1, "a committed outcome needs no reconciliation re-query");
});

// gentle-pi#822 (outside-diff finding): an unknown declaration outcome is proven or disproven by one bound STATUS re-query without ever changing the failure outcome.
test("an unknown declaration outcome is proven committed by one bound STATUS re-query", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const input = relayCollectInput(lineageId, "review-risk", 0);
	const stop = unachievableStopStatus(lineageId, "review-risk", 0);
	const harness = nativeHarness([finalizeStatus(lineageId, [input]), stop], async () => {
		throw Object.assign(new Error("native command timed out while recording the declaration"), { failureEnvelope: { raw: { code: "deadline_exceeded", message: "native command timed out" }, mutationOutcome: "unknown" } });
	});
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "pi reviewer subprocess exceeded the relay bound", { exitCode: null, timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "unachievable-lens-declaration-failed", "the failure outcome never changes");
	assert.equal(result.mutation_performed, true);
	assert.equal(result.mutation_outcome, "committed");
	assert.equal(harness.statusCalls.length, 2, "one selection STATUS plus exactly one bound reconciliation re-query");
	assert.equal(harness.statusCalls.at(-1)?.agent, "pi", "the reconciliation re-query preserves the Pi host runtime");
});

// gentle-pi#822 (outside-diff finding): a malformed declaration error with no envelope at all keeps the conservative none outcome and performs no re-query.
test("a malformed declaration error without an envelope keeps mutation none", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-risk", 0)])], async () => {
		throw new TypeError("cannot read properties of undefined (reading 'detail')");
	});
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "pi reviewer subprocess exceeded the relay bound", { exitCode: null, timedOut: true, elapsedMs: 2_256_004, timeoutMs: 2_256_000 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "unachievable-lens-declaration-failed");
	assert.equal(result.mutation_performed, false);
	assert.equal(result.mutation_outcome, "none");
	assert.equal(harness.statusCalls.length, 1, "no envelope means no unknown outcome and no re-query");
});

test("a non-timeout transport failure keeps its generic continuation and now carries its measurements", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-reliability", 0)])]);
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi", "pi subprocess failed", { exitCode: 4, elapsedMs: 1_200, timeoutMs: 900_000 });
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(result.outcome, "pi-host-relay-transport-failure");
	assert.deepEqual(result.failure, { kind: "pi-failed", stage: "pi", exit_code: 4, timed_out: false, elapsed_ms: 1_200, timeout_ms: 900_000 });
	assert.match(String(result.next_action), /fresh STATUS/);
});

test("materialize tokens without a provider submission fail closed as a typed contract mismatch", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-reliability", 0, true, "absent")])]);
	let relayCalls = 0;
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		relayCalls += 1;
		return { promptByteLength: 1, resultByteLength: 1, submission: "{}" };
	});

	const result = await runCapture(cwd, harness, lineageId);

	assert.equal(relayCalls, 0, "the completing form is never synthesized, so nothing launches");
	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "pi-host-relay-transport-failure");
	assert.deepEqual(result.failure, { kind: "submission-contract-mismatch", stage: "binding", exit_code: null, timed_out: false });
	assert.equal(result.reason, REVIEW_HOST_RELAY_SUBMISSION_MISSING_MESSAGE);
	assert.equal(result.mutation_performed, false);
	assert.equal(result.mutation_outcome, "none");
	assert.equal(harness.statusCalls.length, 1, "no relaunch and no post-capture STATUS after the contract mismatch");
});

test("collect inputs without the provider-issued materialize token never reach the relay", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([
		finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-reliability", 0, false)]),
		finalizeStatus(lineageId),
	]);
	let relayCalls = 0;
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		relayCalls += 1;
		return { promptByteLength: 1, resultByteLength: 1, submission: "{}" };
	});

	// The existing lane may fail on the synthetic projection; only the relay
	// boundary is under test here: it must never be consulted.
	try {
		await runCapture(cwd, harness, lineageId);
	} catch {
		// Existing-lane behavior for this synthetic fixture is out of scope.
	}
	assert.equal(relayCalls, 0);
});
