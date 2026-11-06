import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// gentle-pi#311 P6 — restart parity for the provider-relay capture lane.
//
// P1-P5 proved same-process STATUS re-query after a relay transport failure
// (tests/review-host-relay-routing.test.ts): the capture tool re-queries STATUS
// in-process and directs the operator to relaunch only if the exact same bound
// slot is reoffered. P6 closes the remaining gap: the binding must survive a
// TRUE controller-process restart, and the retry discipline must be provable,
// not merely asserted.
//
// Each scenario runs the controller in its own child process with a fresh
// module load of extensions/gentle-ai.ts. Module-level state and every closure
// restart from scratch. The truthful restart protocol uses the public surface:
//   1. Process A: INSPECT exposes one opaque collectBinding, which is copied
//      unchanged to exactly one gentle_review_capture invocation. The relay
//      transport fails without capture or source/authority mutation.
//   2. Process B (fresh): INSPECT queries fresh provider STATUS and exposes the
//      pending opaque collectBinding; it invokes neither capture nor the relay.
//   3. The parent compares Process B's provider-returned binding to Process A's
//      observed binding without parsing or rebuilding it.
//   4. Only when equal, fresh Process C copies its newly reoffered binding to
//      one capture invocation.
//   5. Drifted and missing reoffers expose no eligible retry; the parent does
//      not spawn a capture process.
//
// The provider (native targetStatus) is stubbed from a JSON file the parent
// controls; the provider's own durability is proven elsewhere
// (native-review-parity-runtime.test.ts drives the real binary). What is under
// test is the controller's restart safety.

const SHA = `sha256:${"1".repeat(64)}`;
const TREE = "2".repeat(40);
const LINEAGE = "relay-lineage";
const LENS = "review-reliability";
const ORDER = 0;

function bindingArguments(lineageId, lens, order) {
	return [
		{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
		{ name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` },
		{ name: "target", value: SHA, token: `--target=${SHA}` },
		{ name: "repository-context", value: `rctx1_${"e".repeat(64)}`, token: `--repository-context=rctx1_${"e".repeat(64)}` },
		{ name: "lens", value: lens, token: `--lens=${lens}` },
		{ name: "order", value: String(order), token: `--order=${order}` },
		{ name: "subject-hash", value: `sha256:${String(order).repeat(64)}`, token: `--subject-hash=sha256:${String(order).repeat(64)}` },
	];
}

function providerSubmission(lineageId, lens, order) {
	const bindingTokens = bindingArguments(lineageId, lens, order).map((a) => a.token);
	return {
		operationToken: "capture-result",
		argumentTokens: [...bindingTokens, "--input={{value}}"],
		values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: bindingTokens.length }],
	};
}

function relayCollectInput(lineageId, lens, order) {
	return {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		captureOperation: "review.capture-result",
		arguments: [
			...bindingArguments(lineageId, lens, order),
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "materialize", value: "true", token: "--materialize=true" },
		],
		// gentle-pi#638: the artifact subject is what makes the slot declarable —
		// its subject_hash is the --request-hash the capture-unachievable verb
		// binds to. A slot without one cannot be declared, only retried.
		artifactSubject: {
			schema: "gentle-ai.review-artifact-subject/v2",
			subjectHash: `sha256:${String(order).repeat(64)}`,
			lineageId,
			authorityRevision: SHA,
			targetIdentity: SHA,
			baseTree: TREE,
			candidateTree: TREE,
			changedPathManifestSha256: SHA,
			lens,
			selectedOrder: order,
		},
		submission: providerSubmission(lineageId, lens, order),
	};
}

function rawNextTransition(inputs) {
	return inputs.length === 0 ? undefined : {
		kind: "collect",
		reason_code: "reviewer_results_required",
		collect: { inputs: inputs.map((input) => ({
			name: input.name,
			schema: input.schema,
			capture_operation: input.captureOperation,
			arguments: input.arguments,
			submission: input.submission,
		})) },
	};
}

function collectStatus(lineageId, inputs) {
	const transition = rawNextTransition(inputs);
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: "reviewing", generation: 1, revision: SHA },
		receipt: { status: "none" },
		action: "stop",
		replayability: "not_replayable",
		targetIdentity: SHA,
		projection: {
			schema: "gentle-ai.review-candidate-projection/v1", kind: "current-changes", projection: "workspace",
			baseTree: TREE, initialReviewTree: TREE, currentCandidateTree: TREE,
			pathsDigest: SHA, paths: ["app.ts"], intendedUntracked: [], intendedUntrackedProof: SHA,
			initialSnapshotIdentity: SHA, currentSnapshotIdentity: SHA,
		},
		candidates: [],
		...(transition === undefined ? {} : { nextTransition: { kind: "collect", reasonCode: "reviewer_results_required", collect: { inputs: [...inputs] } } }),
		raw: {
			schema: "gentle-ai.review-integration.status/v5", contract: "gentle-ai.review-integration/v2",
			action: "stop", lineage_id: lineageId, target_identity: SHA,
			...(transition === undefined ? {} : { next_transition: transition }),
		},
	};
}

function repository(t) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-relay-restart-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-b", "main"], { cwd });
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Relay Restart Test", "-c", "user.email=relay-restart@example.invalid", "commit", "-m", "initial"], { cwd });
	return cwd;
}

function restartWorkerSource() {
	const extensionUrl = pathToFileURL(join(import.meta.dirname, "..", "extensions", "gentle-ai.ts")).href;
	const relayUrl = pathToFileURL(join(import.meta.dirname, "..", "lib", "review-host-relay.ts")).href;
	const terminalSubmission = JSON.stringify({
		schema: "gentle-ai.review-last-event-closure/v1",
		operation: "review/capture-result",
		lineage_id: LINEAGE,
		state: "approved",
		store_revision: SHA,
		action: "native last event closed the review",
	});
	return `
import { readFile, writeFile } from "node:fs/promises";

const [cwd, statusFile, mode, outFile] = process.argv.slice(-4);
const { __testing } = await import(${JSON.stringify(extensionUrl)});
const { ReviewHostRelayError, REVIEW_HOST_RELAY_FAILURE } = await import(${JSON.stringify(relayUrl)});
const statusQueue = JSON.parse(await readFile(statusFile, "utf8"));
const relayRequests = [];
const statusCalls = [];
const unachievableCalls = [];
let captureCalls = 0;

__testing.setReviewHostRelayRunnerForTesting(async (request) => {
	relayRequests.push({
		captureArgumentTokens: request.captureArgumentTokens,
		submission: request.submission,
	});
	if (mode === "capture-fail") {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi", "pi subprocess failed", { exitCode: 4 });
	}
	if (mode === "capture-timeout") {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_TIMED_OUT, "pi", "pi reviewer subprocess exceeded the relay bound", { exitCode: null, timedOut: true, elapsedMs: 2256004, timeoutMs: 2256000 });
	}
	if (mode === "capture-ambiguous") {
		throw Object.assign(new Error("capture response lost"), { mutationOutcome: "unknown", nextAction: "review.status" });
	}
	if (mode === "capture-terminal") {
		return { promptByteLength: 64, resultByteLength: 32, submission: ${JSON.stringify(terminalSubmission)} };
	}
	return { promptByteLength: 64, resultByteLength: 32, submission: "{\\"admission_decision\\":\\"completed\\"}" };
});

const nativeReviewCli = {
	targetStatus: async (request) => {
		statusCalls.push({ cwd: request.cwd, ...(request.lineageId === undefined ? {} : { lineageId: request.lineageId }) });
		const next = statusQueue.shift();
		if (next === undefined) throw new Error("status queue exhausted");
		return next;
	},
	captureUnachievableLens: async (request) => {
		unachievableCalls.push({
			cwd: request.cwd,
			lineageId: request.lineageId,
			targetIdentity: request.targetIdentity,
			expectedRevision: request.expectedRevision,
			requestHash: request.requestHash,
			reason: request.reason,
			...(request.detail === undefined ? {} : { detail: request.detail }),
			...(request.repositoryContext === undefined ? {} : { repositoryContext: request.repositoryContext }),
		});
		return {
			schema: "gentle-ai.review-capture-unachievable/v1",
			lineageId: request.lineageId,
			targetIdentity: request.targetIdentity,
			lens: ${JSON.stringify(LENS)},
			selectedOrder: ${JSON.stringify(ORDER)},
			reason: request.reason,
			recorded: true,
		};
	},
};

let result;
let inspectResult;
let captureBinding;
let error;
try {
	inspectResult = await __testing.executeReviewControllerOperation({ operation: "inspect" }, cwd, nativeReviewCli);
	if (mode === "inspect") {
		result = inspectResult;
	} else {
		const bindings = inspectResult.collectBindings;
		if (!Array.isArray(bindings) || bindings.length !== 1 || typeof bindings[0]?.collectBinding !== "string") {
			throw new Error("INSPECT did not expose exactly one public collectBinding");
		}
		captureBinding = bindings[0].collectBinding;
		captureCalls += 1;
		result = await __testing.executeReviewCaptureOperation(
			{ lineageId: "relay-lineage", collectBinding: captureBinding, reviewerRunAcknowledged: true },
			cwd,
			nativeReviewCli,
		);
	}
} catch (caught) {
	error = caught instanceof Error ? { name: caught.name, message: caught.message } : String(caught);
}

await writeFile(outFile, JSON.stringify({ result, inspectResult, captureBinding, error, relayRequests, statusCalls, captureCalls, unachievableCalls }, null, 2));
`;
}

function runWorker(t, cwd, statuses, mode) {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-relay-restart-run-")));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const statusFile = join(scratch, "statuses.json");
	const outFile = join(scratch, "out.json");
	writeFileSync(statusFile, JSON.stringify(statuses));
	const out = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", restartWorkerSource(), cwd, statusFile, mode, outFile], {
		encoding: "utf8", env: process.env, timeout: 15_000,
	});
	assert.equal(out.length, 0, `worker should write nothing to stdout, got: ${out}`);
	return JSON.parse(readFileSync(outFile, "utf8"));
}

function inspectCollectBinding(inspectResult) {
	const bindings = inspectResult?.collectBindings;
	if (!Array.isArray(bindings) || bindings.length !== 1) return undefined;
	return typeof bindings[0]?.collectBinding === "string" ? bindings[0].collectBinding : undefined;
}

const PENDING = collectStatus(LINEAGE, [relayCollectInput(LINEAGE, LENS, ORDER)]);
const CONVERGED = collectStatus(LINEAGE, []);

// gentle-pi#638: the typed stop the provider renders once the slot is declared
// unachievable — no collect inputs, one withdraw binding per declared slot.
// Built in the same plain-object style as collectStatus: typed fields for the
// controller, raw fields for the envelope passthrough.
function unachievableStopStatus(lineageId, lens, order) {
	const subjectHash = `sha256:${String(order).repeat(64)}`;
	const repositoryContext = `rctx1_${"e".repeat(64)}`;
	const withdrawArguments = [
		{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
		{ name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` },
		{ name: "target", value: SHA, token: `--target=${SHA}` },
		{ name: "repository-context", value: repositoryContext, token: `--repository-context=${repositoryContext}` },
		{ name: "request-hash", value: subjectHash, token: `--request-hash=${subjectHash}` },
		{ name: "withdraw", value: "true", token: "--withdraw=true" },
	];
	const withdrawCommand = `gentle-ai review capture-unachievable --lineage=${lineageId} --expected-revision=${SHA} --target=${SHA} --repository-context=${repositoryContext} --request-hash=${subjectHash} --withdraw=true`;
	return {
		...collectStatus(lineageId, []),
		nextTransition: {
			kind: "stop",
			reasonCode: "unachievable_lens_slot",
			unachievableLensSlots: [
				{
					lens,
					selectedOrder: order,
					subjectHash,
					reason: "relay_transport_bound_exceeded",
					withdraw: {
						operation: "review.capture-unachievable",
						command: withdrawCommand,
						arguments: withdrawArguments,
						binding: { targetIdentity: SHA, lineageId, revision: SHA },
					},
				},
			],
		},
		raw: {
			schema: "gentle-ai.review-integration.status/v5",
			action: "stop",
			lineage_id: lineageId,
			target_identity: SHA,
			next_transition: {
				kind: "stop",
				reason_code: "unachievable_lens_slot",
				unachievable_lens_slots: [
					{
						lens,
						selected_order: order,
						subject_hash: subjectHash,
						reason: "relay_transport_bound_exceeded",
						withdraw: {
							operation: "review.capture-unachievable",
							command: withdrawCommand,
							arguments: withdrawArguments,
							binding: { lineage_id: lineageId, revision: SHA, target_identity: SHA, repository_context: repositoryContext },
						},
					},
				],
			},
		},
	};
}
const UNACHIEVABLE_STOP = unachievableStopStatus(LINEAGE, LENS, ORDER);

// gentle-pi#638: the declared slot must not survive the restart as a reoffer.
// Process A declares after the deterministic bound kill; fresh Process B sees
// the provider's typed stop with the withdraw hint instead of the public
// collectBinding it would have seen before the declaration.
test("an unachievable declaration survives the controller restart as a typed stop, not a reoffer", async (t) => {
	const cwd = repository(t);

	// Process A: the deterministic relay bound kills the reviewer; the capture
	// path declares the slot unachievable and renders the provider's stop. The
	// worker always runs INSPECT first, so the queue carries the pending collect
	// twice (inspect + capture selection) before the post-declaration stop.
	const declared = runWorker(t, cwd, [PENDING, PENDING, UNACHIEVABLE_STOP], "capture-timeout");
	assert.equal(declared.error, undefined, `declared run threw: ${JSON.stringify(declared.error)}`);
	assert.equal(declared.captureCalls, 1, "Process A invokes one capture");
	assert.equal(declared.relayRequests.length, 1, "Process A launches one relay transport");
	assert.equal(declared.unachievableCalls.length, 1, "the declaration is recorded exactly once");
	assert.deepEqual(declared.unachievableCalls, [{ cwd, lineageId: LINEAGE, targetIdentity: SHA, expectedRevision: SHA, requestHash: `sha256:${String(ORDER).repeat(64)}`, reason: "relay_transport_bound_exceeded", detail: "killed after 2256004ms against a 2256000ms relay bound", repositoryContext: `rctx1_${"e".repeat(64)}` }]);
	assert.equal(declared.statusCalls.length, 3, "inspect and selection STATUS plus exactly one bound re-query");
	assert.equal(declared.result.tool, "gentle_review_capture");
	assert.equal(declared.result.status, "blocked");
	assert.equal(declared.result.outcome, "unachievable-lens-slot-declared");
	assert.equal(declared.result.mutation_performed, true);
	assert.match(String(declared.result.next_action), /withdraw/);

	// Process B (fresh): the provider's STATUS no longer reoffers the binding;
	// INSPECT renders the typed stop whose hint is the withdraw command.
	const inspect = runWorker(t, cwd, [UNACHIEVABLE_STOP], "inspect");
	assert.equal(inspect.error, undefined, `inspect run threw: ${JSON.stringify(inspect.error)}`);
	assert.equal(inspect.captureCalls, 0, "no capture runs without a reoffered binding");
	assert.equal(inspect.relayRequests.length, 0, "INSPECT never launches the relay");
	assert.equal(inspect.unachievableCalls.length, 0, "INSPECT never declares");
	assert.equal(inspectCollectBinding(inspect.result), undefined, "the declared slot is not reoffered after restart");
	assert.equal(inspect.result.status, "blocked");
	assert.match(String(inspect.result.hint), /capture-unachievable/);
	assert.match(String(inspect.result.hint), /--withdraw=true/);
});

test("a fresh controller process reoffers the exact public binding before one capture closes", async (t) => {
	const cwd = repository(t);

	// Process A copies its own public binding to capture. Transport fails without
	// a capture mutation, and the capture path does not automatically re-query.
	const failure = runWorker(t, cwd, [PENDING, PENDING], "capture-fail");
	assert.equal(failure.error, undefined, `failure run threw: ${JSON.stringify(failure.error)}`);
	assert.equal(failure.captureCalls, 1, "Process A invokes one capture");
	assert.equal(failure.relayRequests.length, 1, "Process A observes exactly one pending slot");
	assert.equal(failure.statusCalls.length, 2, "Process A performs INSPECT and the selected capture STATUS only");
	assert.deepEqual(failure.statusCalls, [{ cwd }, { cwd, lineageId: LINEAGE }]);
	assert.equal(failure.result.tool, "gentle_review_capture");
	assert.equal(failure.result.status, "blocked");
	assert.equal(failure.result.outcome, "pi-host-relay-transport-failure");
	assert.deepEqual(failure.result.failure, { kind: "pi-failed", stage: "pi", exit_code: 4, timed_out: false });
	assert.equal((failure.result.captured_slots ?? []).length, 0, "transport failure captures nothing");
	assert.equal(failure.result.mutation_performed, false);
	assert.match(String(failure.result.next_action), /fresh STATUS/);
	assert.match(String(failure.result.next_action), /exact reoffered one-slot binding/);
	const observedBinding = failure.captureBinding;
	assert.equal(observedBinding, inspectCollectBinding(failure.inspectResult), "Process A copies the public binding without rebuilding it");
	const observedRelayRequest = failure.relayRequests[0];

	// Process B is a true restart. It only exposes the provider-owned public
	// binding, so the parent can decide whether a retry is safe.
	const inspect = runWorker(t, cwd, [PENDING], "inspect");
	assert.equal(inspect.error, undefined, `inspect run threw: ${JSON.stringify(inspect.error)}`);
	assert.equal(inspect.captureCalls, 0, "INSPECT never invokes capture");
	assert.equal(inspect.relayRequests.length, 0, "INSPECT never launches the relay");
	assert.equal(inspect.statusCalls.length, 1, "INSPECT queries STATUS exactly once");
	assert.deepEqual(inspect.statusCalls, [{ cwd }]);
	assert.equal(inspect.result.operation, "inspect");
	const reofferedBinding = inspectCollectBinding(inspect.result);
	assert.ok(reofferedBinding !== undefined, "INSPECT exposed one provider-returned pending binding");
	assert.equal(reofferedBinding, observedBinding, "the fresh reoffer is byte-identical to the observed opaque binding");

	// Process C runs only after the parent confirms equality. It copies its fresh
	// reoffer to one capture and receives the terminal native closure directly.
	const relaunch = runWorker(t, cwd, [PENDING, PENDING], "capture-terminal");
	assert.equal(relaunch.error, undefined, `relaunch threw: ${JSON.stringify(relaunch.error)}`);
	assert.equal(relaunch.captureCalls, 1, "Process C invokes exactly one capture");
	assert.equal(relaunch.relayRequests.length, 1, "Process C launches one relay from the fresh reoffer");
	assert.deepEqual(relaunch.statusCalls, [{ cwd }, { cwd, lineageId: LINEAGE }], "terminal capture performs no post-success STATUS");
	assert.equal(relaunch.captureBinding, observedBinding, "Process C copies the exact reoffered binding");
	assert.deepEqual(relaunch.relayRequests[0], observedRelayRequest, "the relay receives the same provider-owned slot after restart");
	assert.deepEqual(relaunch.relayRequests[0].submission, providerSubmission(LINEAGE, LENS, ORDER));
	assert.equal(relaunch.result.tool, "gentle_review_capture");
	assert.equal(relaunch.result.status, "closed");
	assert.equal(relaunch.result.outcome, "native-last-event-closure");
	assert.equal(relaunch.result.closure.operation, "review/capture-result");

	// A nonterminal result also stops at the one capture; it does not follow the
	// next lifecycle transition on its own.
	const nonterminal = runWorker(t, cwd, [PENDING, PENDING], "capture-nonterminal");
	assert.equal(nonterminal.error, undefined, `nonterminal capture threw: ${JSON.stringify(nonterminal.error)}`);
	assert.equal(nonterminal.captureCalls, 1);
	assert.equal(nonterminal.relayRequests.length, 1);
	assert.deepEqual(nonterminal.statusCalls, [{ cwd }, { cwd, lineageId: LINEAGE }], "nonterminal capture does not auto-follow STATUS");
	assert.equal(nonterminal.result.status, "captured");
	assert.equal(nonterminal.result.outcome, "native-reviewer-result-captured");

	// A response with an unknown mutation outcome reconciles once through STATUS
	// without replaying the capture or relay.
	const ambiguous = runWorker(t, cwd, [PENDING, PENDING, CONVERGED], "capture-ambiguous");
	assert.equal(ambiguous.error, undefined, `ambiguous capture threw: ${JSON.stringify(ambiguous.error)}`);
	assert.equal(ambiguous.captureCalls, 1, "ambiguous capture is never replayed");
	assert.equal(ambiguous.relayRequests.length, 1, "ambiguity does not relaunch the relay");
	assert.deepEqual(ambiguous.statusCalls, [{ cwd }, { cwd, lineageId: LINEAGE }, { cwd, lineageId: LINEAGE }], "one capture STATUS plus one reconciliation STATUS");
	assert.equal(ambiguous.result.tool, "gentle_review_capture");
	assert.equal(ambiguous.result.status, "reconciled");
	assert.equal(ambiguous.result.outcome, "native-capture-outcome-unknown");
});

test("every provider-owned binding drift forbids a capture after restart", async (t) => {
	const cwd = repository(t);

	// Process A observes the original public binding and suffers a transport
	// failure. The parent retains the opaque binding only for equality checks.
	const failure = runWorker(t, cwd, [PENDING, PENDING], "capture-fail");
	assert.equal(failure.captureCalls, 1);
	assert.equal(failure.relayRequests.length, 1);
	assert.equal(failure.result.outcome, "pi-host-relay-transport-failure");
	const observedBinding = failure.captureBinding;
	const baseInput = relayCollectInput(LINEAGE, LENS, ORDER);
	const driftArgument = (name, value, token) => {
		const input = structuredClone(baseInput);
		const argument = input.arguments.find((candidate) => candidate.name === name);
		assert.ok(argument !== undefined);
		const originalToken = argument.token;
		Object.assign(argument, { value, token });
		input.submission.argumentTokens = input.submission.argumentTokens.map((candidate) => candidate === originalToken ? token : candidate);
		return input;
	};
	const driftedSubmission = structuredClone(baseInput);
	driftedSubmission.submission.values[0]!.slot = "drifted_reviewer_result";
	const driftSha = `sha256:${"f".repeat(64)}`;
	const driftCases = [
		{ field: "submission", input: driftedSubmission },
		{ field: "captureArgumentTokens", input: driftArgument("expected-revision", driftSha, `--expected-revision=${driftSha}`) },
		{ field: "order", input: driftArgument("order", String(ORDER + 1), `--order=${ORDER + 1}`) },
		{ field: "subjectHash", input: driftArgument("subject-hash", driftSha, `--subject-hash=${driftSha}`) },
		{ field: "lens", input: driftArgument("lens", "review-risk", "--lens=review-risk") },
	];

	for (const { field, input } of driftCases) {
		// Process B is fresh and exposes one independently drifted public binding.
		const inspect = runWorker(t, cwd, [collectStatus(LINEAGE, [input])], "inspect");
		assert.equal(inspect.captureCalls, 0, `${field}: INSPECT never invokes capture`);
		assert.equal(inspect.relayRequests.length, 0, `${field}: INSPECT never launches the relay`);
		assert.deepEqual(inspect.statusCalls, [{ cwd }], `${field}: INSPECT queries STATUS once`);
		const reofferedBinding = inspectCollectBinding(inspect.result);
		assert.ok(reofferedBinding !== undefined, `${field}: INSPECT exposes the drifted binding for comparison`);
		assert.notEqual(reofferedBinding, observedBinding, `${field}: the drifted reoffer must not equal the observed binding`);
	}
});

test("a missing restarted reoffer exposes no public binding and forbids capture", async (t) => {
	const cwd = repository(t);

	// Process A observes the original binding and suffers a transport failure.
	const failure = runWorker(t, cwd, [PENDING, PENDING], "capture-fail");
	assert.equal(failure.captureCalls, 1);
	assert.equal(failure.relayRequests.length, 1);
	assert.equal(failure.result.outcome, "pi-host-relay-transport-failure");

	// Process B is fresh and returns a converged STATUS with no public binding.
	// The parent confirms the absence, so it does not launch another process.
	const inspect = runWorker(t, cwd, [CONVERGED], "inspect");
	assert.equal(inspect.captureCalls, 0, "INSPECT never invokes capture");
	assert.equal(inspect.relayRequests.length, 0, "INSPECT never launches the relay");
	assert.deepEqual(inspect.statusCalls, [{ cwd }], "INSPECT queries STATUS once");
	assert.equal(inspectCollectBinding(inspect.result), undefined, "INSPECT exposed no matching public binding");
});
