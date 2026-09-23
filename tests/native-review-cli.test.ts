import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	decodeReviewConsentV3,
} from "../lib/review-integration-v2.ts";
import {
	decodeNativeSddStatusV2,
	NATIVE_REVIEW_DEFAULT_MAX_BUFFER_BYTES,
	NATIVE_REVIEW_ERROR_CODE,
	NativeReviewCliError,
	NativeReviewCliV216,
	NativeReviewIntegrationError,
	createNodeExecFileAdapter,
	isNativeReviewUnachievableVerbRefused,
	type ExecFileAdapter,
	type NativeTargetStatusRequest,
} from "../lib/native-review-cli.ts";

const fixture = (name: string): Record<string, unknown> => JSON.parse(
	readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", name), "utf8"),
) as Record<string, unknown>;

interface QueuedResult {
	stdout: string;
	stderr?: string;
	exitCode?: number;
	timedOut?: boolean;
	signal?: NodeJS.Signals | null;
	outputLimitExceeded?: boolean;
}

function queuedAdapter(results: readonly QueuedResult[]): {
	adapter: ExecFileAdapter;
	calls: Array<{ file: string; arguments: readonly string[]; cwd: string; timeoutMs: number | undefined }>;
} {
	const queue = [...results];
	const calls: Array<{ file: string; arguments: readonly string[]; cwd: string; timeoutMs: number | undefined }> = [];
	return {
		calls,
		adapter: async (request) => {
			calls.push({ file: request.file, arguments: request.arguments, cwd: request.cwd, timeoutMs: request.timeoutMs });
			const result = queue.shift();
			if (result === undefined) throw new Error("unexpected native invocation");
			return {
				stdout: result.stdout,
				stderr: result.stderr ?? "",
				exitCode: result.exitCode ?? 0,
				signal: result.signal ?? null,
				timedOut: result.timedOut ?? false,
				outputLimitExceeded: result.outputLimitExceeded ?? false,
			};
		},
	};
}

function client(adapter: ExecFileAdapter): NativeReviewCliV216 {
	return new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024);
}

// Structural test data follows the 2026-09-11 native 2.7.1-0.20260911070137-350f31554a4b
// capture: seven dependencies and four phaseInstructions groups, not a legacy alias.
function nativeSddStatus(changeName = "complete-native-review-lifecycle", workspaceRoot = "/repo"): Record<string, unknown> {
	return {
		schemaName: "gentle-ai.sdd-status",
		schemaVersion: 2,
		changeName,
		artifactStore: "openspec",
		planningHome: { mode: "repo-local", path: `${workspaceRoot}/openspec` },
		changeRoot: `${workspaceRoot}/openspec/changes/${changeName}`,
		actionContext: { mode: "repo-local", workspaceRoot, allowedEditRoots: [workspaceRoot] },
		dependencies: { proposal: "all_done", specs: "all_done", design: "all_done", tasks: "all_done", apply: "all_done", verify: "all_done", archive: "ready" },
		phaseInstructions: {
			apply: ["Apply is complete."],
			verify: ["Verification is complete."],
			remediate: ["Bind remediation to failed evidence."],
			archive: ["Archive the selected change."],
		},
		blockedReasons: [],
		nextRecommended: "archive",
	};
}

test("native SDD status executes its exact selected-root argv and returns only a validated v2 authority", async () => {
	const body = nativeSddStatus();
	const queue = queuedAdapter([{ stdout: JSON.stringify(body) }]);
	const status = await (client(queue.adapter) as unknown as {
		sddStatus(request: { changeName: string; workspaceRoot: string }): Promise<Record<string, unknown>>;
	}).sddStatus({ changeName: "complete-native-review-lifecycle", workspaceRoot: "/repo" });

	assert.deepEqual(status, body);
	assert.deepEqual(queue.calls, [{
		file: "/package/.gentle-ai/gentle-ai",
		arguments: ["sdd-status", "complete-native-review-lifecycle", "--cwd", "/repo", "--json", "--instructions"],
		cwd: "/repo",
		timeoutMs: 30_000,
	}]);
});

test("native SDD status rejects malformed v2 identities, dependencies, instructions, and blockers", async () => {
	const invalidInstructions = { apply: ["ok"], verify: ["ok"], remediate: ["ok"], archive: [42] };
	assert.doesNotThrow(() => decodeNativeSddStatusV2(
		{ ...nativeSddStatus(), phaseInstructions: { ...invalidInstructions, archive: ["ok"] } },
		{ changeName: "complete-native-review-lifecycle", workspaceRoot: "/repo" },
	));
	const malformed = [
		{ ...nativeSddStatus(), schemaName: "gentle-pi.sdd-status" },
		{ ...nativeSddStatus(), schemaVersion: 1 },
		{ ...nativeSddStatus(), changeName: "other-change" },
		{ ...nativeSddStatus(), artifactStore: "future-store" },
		{ ...nativeSddStatus(), planningHome: { mode: "future-mode", path: "/repo/openspec" } },
		{ ...nativeSddStatus(), planningHome: { mode: "repo-local", path: "/outside" } },
		{ ...nativeSddStatus(), changeRoot: "bad\nroot" },
		{ ...nativeSddStatus(), actionContext: { mode: "repo-local", workspaceRoot: "/other", allowedEditRoots: ["/other"] } },
		{ ...nativeSddStatus(), actionContext: { mode: "future-mode", workspaceRoot: "/repo", allowedEditRoots: ["/repo"] } },
		{ ...nativeSddStatus(), actionContext: { mode: "repo-local", workspaceRoot: "/repo", allowedEditRoots: ["/outside"] } },
		{ ...nativeSddStatus(), dependencies: { apply: "all_done", verify: "all_done", archive: "future" } },
		{ ...nativeSddStatus(), phaseInstructions: invalidInstructions },
		{ ...nativeSddStatus(), blockedReasons: "not-an-array" },
		{ ...nativeSddStatus(), nextRecommended: "unknown" },
		{ ...nativeSddStatus(), instructions: {}, phaseInstructions: undefined },
		{ ...nativeSddStatus(), phaseInstructions: null },
	];
	for (const body of malformed) {
		await assert.rejects(
			() => (client(queuedAdapter([{ stdout: JSON.stringify(body) }]).adapter) as unknown as {
				sddStatus(request: { changeName: string; workspaceRoot: string }): Promise<Record<string, unknown>>;
			}).sddStatus({ changeName: "complete-native-review-lifecycle", workspaceRoot: "/repo" }),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE,
		);
	}
});

test("native v2 read-only decoding preserves omitted optional phaseInstructions", () => {
	const body = nativeSddStatus();
	delete body.phaseInstructions;
	assert.equal(decodeNativeSddStatusV2(body, { changeName: "complete-native-review-lifecycle", workspaceRoot: "/repo" }), body);
});

test("native SDD status keeps malformed JSON, timeout, and nonzero execution fail-closed", async () => {
	for (const [result, code] of [
		[{ stdout: "not-json" }, NATIVE_REVIEW_ERROR_CODE.MALFORMED_JSON],
		[{ stdout: "", timedOut: true }, NATIVE_REVIEW_ERROR_CODE.TIMEOUT],
		[{ stdout: "{}", exitCode: 1 }, NATIVE_REVIEW_ERROR_CODE.NON_ZERO],
	] as const) {
		await assert.rejects(
			() => (client(queuedAdapter([result]).adapter) as unknown as {
				sddStatus(request: { changeName: string; workspaceRoot: string }): Promise<Record<string, unknown>>;
			}).sddStatus({ changeName: "complete-native-review-lifecycle", workspaceRoot: "/repo" }),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === code && error.mutationOutcome === "none",
		);
	}
});

test("negotiated STATUS accepts the pinned v5 receipt before routing its transition", async () => {
	const status = fixture("status-v5.captured.json");
	const queue = queuedAdapter([{ stdout: JSON.stringify(status) }]);
	const result = await client(queue.adapter).targetStatus({ cwd: "/repo", lineageId: "review-status-fixture", agent: "pi" });
	assert.deepEqual(result.receipt, { status: "not_applicable" });
	assert.equal(result.nextTransition?.kind, "collect");
	assert.deepEqual(queue.calls[0]?.arguments, [
		"review", "status", "--contract", "gentle-ai.review-integration/v2", "--cwd", "/repo",
		"--projection", "workspace", "--lineage", "review-status-fixture", "--agent", "pi", "--next-transition",
	]);
	assert.equal(queue.calls[0]?.timeoutMs, 30_000);
});

test("a final reviewer capture returns its native last-event closure without a follow-up command", async () => {
	const closure = fixture("last-event-capture-result-approved.captured.json");
	const queue = queuedAdapter([{ stdout: JSON.stringify(closure) }]);
	const result = await client(queue.adapter).captureResult({
		argumentTokens: ["--repository-context=rctx1_" + "a".repeat(64), "--lineage=review-c7c923a031112dd7"],
		resultDocument: "{\"subject_hash\":\"sha256:captured\"}",
	});

	assert.equal("operation" in result && result.operation, "review/capture-result");
	assert.deepEqual(queue.calls[0]?.arguments.slice(0, 4), ["review", "capture-result", "--repository-context=rctx1_" + "a".repeat(64), "--lineage=review-c7c923a031112dd7"]);
	assert.equal(queue.calls.length, 1);
	assert.equal(queue.calls[0]?.arguments.includes("--contract"), false);
});

test("correction-plan capture substitutes only the provider slot and closes natively", async () => {
	const closure = fixture("last-event-capture-correction-plan.captured.json");
	const queue = queuedAdapter([{ stdout: JSON.stringify(closure) }]);
	const result = await client(queue.adapter).captureCorrectionPlan({
		argumentTokens: ["--lineage=review-c7c923a031112dd7", "--correction-lines={{value}}"],
		correctionLines: 7,
		cwd: "/repo",
	});

	assert.equal(result.operation, "review.capture-correction-plan");
	assert.deepEqual(queue.calls[0]?.arguments, ["review", "capture-correction-plan", "--lineage=review-c7c923a031112dd7", "--correction-lines=7"]);
	await assert.rejects(
		() => client(queuedAdapter([]).adapter).captureCorrectionPlan({ argumentTokens: ["--a={{value}}", "--b={{value}}"], correctionLines: 1, cwd: "/repo" }),
		/CAPTURE_CORRECTION_PLAN requires exactly one/,
	);
});

test("provider-owned refuter and targeted-validator vectors accept only their mapped terminal closures", async () => {
	const captures = [
		{
			captureOperation: "review.capture-refuter",
			closure: fixture("last-event-capture-refuter-approved.captured.json"),
			closureOperation: "review.capture-refuter",
			commandOperation: "capture-refuter",
		},
		{
			captureOperation: "review.capture-validation",
			closure: fixture("last-event-capture-validation-approved.captured.json"),
			closureOperation: "review/capture-validation",
			commandOperation: "capture-validation",
		},
	] as const;

	for (const capture of captures) {
		const queue = queuedAdapter([{ stdout: JSON.stringify(capture.closure) }]);
		const result = await client(queue.adapter).captureProviderRole({
			captureOperation: capture.captureOperation,
			argumentTokens: ["--repository-context=rctx1_" + "a".repeat(64), "--agent=pi", "--execute=true"],
			cwd: "/repo",
		});
		assert.equal("operation" in result && result.operation, capture.closureOperation);
		assert.deepEqual(queue.calls[0]?.arguments, ["review", capture.commandOperation, "--repository-context=rctx1_" + "a".repeat(64), "--agent=pi", "--execute=true"]);
	}

	await assert.rejects(
		() => client(queuedAdapter([]).adapter).captureProviderRole({ captureOperation: "review.capture-result", argumentTokens: ["--agent=pi"], cwd: "/repo" }),
		/CAPTURE_PROVIDER_ROLE supports only/,
	);
});

// gentle-pi#638: the host relay's deterministic-failure exit declares the
// bound slot unachievable through the native verb instead of leaving the
// operator to re-spend an identical reviewer run. The invocation names the
// slot's frozen binding fields (--lineage/--target/--expected-revision/
// --request-hash), the machine-readable --reason, an optional bounded
// --detail, and the opaque --repository-context the slot carried; Go
// verifies all of them against the frozen authority before recording
// anything (internal/cli/review_capture_unachievable.go).
const UNACHIEVABLE_TARGET = `sha256:${"1".repeat(64)}`;
const UNACHIEVABLE_REVISION = `sha256:${"3".repeat(64)}`;
const UNACHIEVABLE_REQUEST_HASH = `sha256:${"0".repeat(64)}`;
const UNACHIEVABLE_ARTIFACT = { schema: "gentle-ai.review-capture-unachievable/v1", lineage_id: "relay-lineage", target_identity: UNACHIEVABLE_TARGET, lens: "review-reliability", selected_order: 0, reason: "relay_transport_bound_exceeded", recorded: true };
function unachievableRequest(cwd = "/repo") {
	return { cwd, lineageId: "relay-lineage", targetIdentity: UNACHIEVABLE_TARGET, expectedRevision: UNACHIEVABLE_REVISION, requestHash: UNACHIEVABLE_REQUEST_HASH, reason: "relay_transport_bound_exceeded" };
}

test("capture-unachievable declares the exact slot binding and decodes its recorded artifact", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify(UNACHIEVABLE_ARTIFACT) }]);
	const result = await client(queue.adapter).captureUnachievableLens({ ...unachievableRequest(), detail: "killed after 2256004ms against a 2256000ms relay bound", repositoryContext: "rctx1_" + "e".repeat(64) });
	assert.deepEqual(result, { schema: "gentle-ai.review-capture-unachievable/v1", lineageId: "relay-lineage", targetIdentity: UNACHIEVABLE_TARGET, lens: "review-reliability", selectedOrder: 0, reason: "relay_transport_bound_exceeded", recorded: true });
	// gentle-pi#822: --repository-context is authoritative and mutually exclusive with a path, so a declaration carrying one names no --cwd; the process still runs from request.cwd.
	assert.deepEqual(queue.calls[0]?.arguments, ["review", "capture-unachievable", "--lineage", "relay-lineage", "--target", UNACHIEVABLE_TARGET, "--expected-revision", UNACHIEVABLE_REVISION, "--request-hash", UNACHIEVABLE_REQUEST_HASH, "--reason", "relay_transport_bound_exceeded", "--detail", "killed after 2256004ms against a 2256000ms relay bound", "--repository-context", "rctx1_" + "e".repeat(64)]);
	assert.equal(queue.calls[0]?.cwd, "/repo", "the process working directory stays request.cwd even when --cwd is not passed as an argument");
	assert.equal(queue.calls[0]?.timeoutMs, undefined, "the mutating declaration runs without the read-only negotiation timeout");

	// the optional detail and repository context are genuinely optional
	const bare = queuedAdapter([{ stdout: JSON.stringify(UNACHIEVABLE_ARTIFACT) }]);
	await client(bare.adapter).captureUnachievableLens(unachievableRequest());
	assert.deepEqual(bare.calls[0]?.arguments, ["review", "capture-unachievable", "--lineage", "relay-lineage", "--target", UNACHIEVABLE_TARGET, "--expected-revision", UNACHIEVABLE_REVISION, "--request-hash", UNACHIEVABLE_REQUEST_HASH, "--reason", "relay_transport_bound_exceeded", "--cwd", "/repo"]);
	assert.equal(bare.calls[0]?.cwd, "/repo");
});

test("capture-unachievable measures detail in UTF-8 bytes, not UTF-16 code units", async () => {
	const atLimit = queuedAdapter([{ stdout: JSON.stringify(UNACHIEVABLE_ARTIFACT) }]);
	await client(atLimit.adapter).captureUnachievableLens({ ...unachievableRequest(), detail: "é".repeat(256) });
	assert.equal(atLimit.calls.length, 1, "256 two-byte characters are exactly the 512-byte limit and must pass");

	const oneCharBeyond = queuedAdapter([]);
	await assert.rejects(() => client(oneCharBeyond.adapter).captureUnachievableLens({ ...unachievableRequest(), detail: "é".repeat(257) }), TypeError);
	assert.equal(oneCharBeyond.calls.length, 0, "257 two-byte characters are 514 bytes and are refused before any process launches");

	const shortButHeavy = queuedAdapter([]);
	await assert.rejects(() => client(shortButHeavy.adapter).captureUnachievableLens({ ...unachievableRequest(), detail: "é".repeat(300) }), TypeError);
	assert.equal(shortButHeavy.calls.length, 0, "300 code units pass a .length check but encode to 600 bytes and must throw");
});

test("capture-unachievable validates its request and artifact shape before and after the invocation", async () => {
	for (const request of [
		{ ...unachievableRequest(), lineageId: "" },
		{ ...unachievableRequest(), targetIdentity: "not-a-sha" },
		{ ...unachievableRequest(), expectedRevision: " " },
		{ ...unachievableRequest(), requestHash: "sha256:short" },
		{ ...unachievableRequest(), reason: "" },
		{ ...unachievableRequest(), detail: "x".repeat(513) },
		{ ...unachievableRequest(), repositoryContext: "no\u0000context" },
	]) {
		const queue = queuedAdapter([]);
		await assert.rejects(() => client(queue.adapter).captureUnachievableLens(request), TypeError);
		assert.equal(queue.calls.length, 0, "a malformed declaration is refused before any process launches");
	}

	for (const artifact of [
		{ ...UNACHIEVABLE_ARTIFACT, schema: "gentle-ai.review-capture-unachievable/v2" },
		{ ...UNACHIEVABLE_ARTIFACT, recorded: false },
		{ ...UNACHIEVABLE_ARTIFACT, selected_order: -1 },
	]) {
		const queue = queuedAdapter([{ stdout: JSON.stringify(artifact) }]);
		await assert.rejects(() => client(queue.adapter).captureUnachievableLens(unachievableRequest()));
		assert.equal(queue.calls.length, 1);
	}
});

test("an older binary's unknown-verb refusal classifies as a capability signal, not a capture failure", async () => {
	const queue = queuedAdapter([{ stdout: "", stderr: 'Error: unknown review command "capture-unachievable"\n', exitCode: 1 }]);
	const error = await client(queue.adapter).captureUnachievableLens(unachievableRequest()).then(() => undefined, (caught: unknown) => caught);
	assert.ok(error instanceof NativeReviewCliError, "an empty-stdout refusal rejects with the typed CLI error carrying stderr diagnostics");
	assert.equal(isNativeReviewUnachievableVerbRefused(error), true);

	// Every other stderr — a typed binding-mismatch refusal, a timeout, or a
	// clean run — is a real outcome, never a capability signal.
	assert.equal(isNativeReviewUnachievableVerbRefused(new Error('unknown review command "capture-unachievable"')), false, "only the captured native stderr classifies");
	const typedRefusal = new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, "review/capture-unachievable", true, true, "native capture-unachievable refused", { operation: "review/capture-unachievable", error_code: NATIVE_REVIEW_ERROR_CODE.NON_ZERO, exit_code: 1, timed_out: false, output_limit_exceeded: false, stderr: "Error: review capture-unachievable binding does not match the current reviewing authority [invalid_request]" });
	assert.equal(isNativeReviewUnachievableVerbRefused(typedRefusal), false);
});

test("nonzero targeted-validator capture preserves its dot-form typed failure", async () => {
	const failure = {
		schema: "gentle-ai.review-integration.failure/v2",
		contract: "gentle-ai.review-integration/v2",
		operation: "review.capture-validation",
		phase: "native_running",
		code: "targeted_validation_failed",
		message: "the targeted validator rejected the candidate",
		mutation_outcome: "unknown",
		authority_applicability: "current_target",
		retry_safe: false,
		replayability: "status_required",
		required_inputs: [],
		next_action: "review.status",
	};
	const queue = queuedAdapter([{ stdout: JSON.stringify(failure), exitCode: 1 }]);
	await assert.rejects(
		() => client(queue.adapter).captureProviderRole({
			captureOperation: "review.capture-validation",
			argumentTokens: ["--repository-context=rctx1_" + "a".repeat(64), "--agent=pi", "--execute=true"],
			cwd: "/repo",
		}),
		(error: unknown) => {
			if (!(error instanceof NativeReviewIntegrationError)) return false;
			assert.equal(error.failureEnvelope.operation, "review.capture-validation");
			assert.equal(error.mutationOutcome, "unknown");
			assert.equal(error.nextAction, "review.status");
			assert.deepEqual(error.failureEnvelope.raw, failure);
			return true;
		},
	);
	assert.deepEqual(queue.calls[0]?.arguments, ["review", "capture-validation", "--repository-context=rctx1_" + "a".repeat(64), "--agent=pi", "--execute=true"]);
});

test("malformed closure output remains a typed schema failure and never authorizes a retry", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify({ schema: "gentle-ai.review-last-event-closure/v1", operation: "review/capture-result" }) }]);
	await assert.rejects(
		() => client(queue.adapter).captureResult({ argumentTokens: ["--repository-context=rctx1_" + "a".repeat(64)], resultDocument: "{}" }),
		(error: unknown) => error instanceof NativeReviewCliError
			&& error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE
			&& error.mutationOutcome === "unknown",
	);
	assert.equal(queue.calls.length, 1);
});

function currentStatusFixture(): Record<string, unknown> {
	return fixture("status-v5.captured.json");
}

function negotiatedStartStatus(targetIdentity: string, tokens: readonly string[]): Record<string, unknown> {
	const status = currentStatusFixture();
	status.target_identity = targetIdentity;
	const projection = status.projection as Record<string, unknown>;
	projection.initial_snapshot_identity = targetIdentity;
	projection.current_snapshot_identity = targetIdentity;
	status.next_transition = {
		kind: "execute",
		reason_code: "review_start_required",
		execute: {
			operation: "review.start",
			arguments: tokens.map((token) => {
				const separator = token.indexOf("=");
				return { name: token.slice(2, separator), value: token.slice(separator + 1), token };
			}),
			preconditions: [],
			binding: { target_identity: targetIdentity },
		},
	};
	return status;
}

const TARGET = `sha256:${"b".repeat(64)}`;
const REPOSITORY_CONTEXT = `rctx1_${"c".repeat(64)}`;

function reviewingStartV4(targetIdentity: string): Record<string, unknown> {
	const start = fixture("start-v3-consent-granted.captured.json");
	start.schema = "gentle-ai.review-integration.start/v4";
	(start.repository_context as Record<string, unknown>).target_identity = targetIdentity;
	for (const subject of start.artifact_subjects as Record<string, unknown>[]) subject.target_identity = targetIdentity;
	const baseTree = start.base_tree as string;
	start.next_transition = {
		kind: "execute",
		reason_code: "review_status_required",
		execute: {
			operation: "review.status",
			arguments: [
				{ name: "contract", value: "gentle-ai.review-integration/v2", token: "--contract=gentle-ai.review-integration/v2" },
				{ name: "next-transition", value: "true", token: "--next-transition=true" },
				{ name: "lineage", value: start.lineage_id, token: `--lineage=${start.lineage_id}` },
				{ name: "agent", value: "pi", token: "--agent=pi" },
				{ name: "base-ref", value: baseTree, token: `--base-ref=${baseTree}` },
				{ name: "committed-only", value: "true", token: "--committed-only=true" },
			],
			preconditions: [],
			binding: { target_identity: targetIdentity },
		},
	};
	const execute = (start.next_transition as Record<string, unknown>).execute as Record<string, unknown>;
	execute.selector_arguments = (execute.arguments as Record<string, unknown>[]).slice(-2).map((argument) => ({ ...argument }));
	return start;
}

test("negotiated STATUS forwards its exact ordered workspace, base, lineage, and untracked selection argv", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify(currentStatusFixture()) }]);
	const result = await client(queue.adapter).targetStatus({
		cwd: "/repo with spaces",
		projection: "staged",
		baseRef: "origin/main",
		committedOnly: true,
		lineageId: "review-current",
		agent: "pi",
		untrackedScope: "select",
		expectedUntrackedInventory: "inventory-sha256",
		intendedUntracked: ["new.txt", "nested/other.txt"],
	});
	assert.equal(result.action, "start");
	assert.deepEqual(queue.calls[0]?.arguments, [
		"review", "status", "--contract", "gentle-ai.review-integration/v2", "--cwd", "/repo with spaces",
		"--projection", "staged", "--untracked-scope=select", "--expected-untracked-inventory=inventory-sha256",
		"--intended-untracked=new.txt", "--intended-untracked=nested/other.txt", "--base-ref", "origin/main", "--committed-only",
		"--lineage", "review-current", "--agent", "pi", "--next-transition",
	]);
	assert.equal(queue.calls[0]?.timeoutMs, 30_000);
});

test("negotiated STATUS emits the explicit committed selector argv", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify(currentStatusFixture()) }]);
	await client(queue.adapter).targetStatus({
		cwd: "/repo",
		baseRef: "refs/heads/main",
		committedOnly: true,
	});
	assert.deepEqual(queue.calls[0]?.arguments, [
		"review", "status", "--contract", "gentle-ai.review-integration/v2", "--cwd", "/repo",
		"--projection", "workspace", "--base-ref", "refs/heads/main", "--committed-only", "--next-transition",
	]);
});

test("negotiated STATUS rejects malformed committed selectors before launching a process", async () => {
	for (const request of [
		{ cwd: "/repo", baseRef: "", committedOnly: true },
		{ cwd: "/repo", baseRef: 42, committedOnly: true },
		{ cwd: "/repo", committedOnly: true },
		{ cwd: "/repo", baseRef: "refs/heads/main" },
		{ cwd: "/repo", baseRef: "refs/heads/main", committedOnly: false },
		{ cwd: "/repo", baseRef: "refs/heads/main", committedOnly: "true" },
	]) {
		const queue = queuedAdapter([]);
		// gentle-pi#822: these fixtures are intentionally mistyped (a numeric baseRef, a string committedOnly) — the repo's `as unknown as` idiom keeps the invalid shapes reaching the validator instead of widening the request type.
		await assert.rejects(() => client(queue.adapter).targetStatus(request as unknown as NativeTargetStatusRequest), TypeError);
		assert.equal(queue.calls.length, 0);
	}
});

test("negotiated STATUS rejects malformed untracked selection before launching a process", async () => {
	const queue = queuedAdapter([]);
	await assert.rejects(
		() => client(queue.adapter).targetStatus({ cwd: "/repo", untrackedScope: "select", expectedUntrackedInventory: "inventory", intendedUntracked: ["../escape"] }),
		/unique repository-relative paths/,
	);
	assert.equal(queue.calls.length, 0);
});

test("negotiated STATUS rejects an unsupported provider execute operation before argv synthesis", async () => {
	const status = currentStatusFixture();
	status.next_transition = {
		kind: "execute",
		reason_code: "future_operation",
		execute: { operation: "review.dispose-result", arguments: [], preconditions: [], binding: { target_identity: TARGET } },
	};
	const queue = queuedAdapter([{ stdout: JSON.stringify(status) }]);
	await assert.rejects(
		() => client(queue.adapter).targetStatus({ cwd: "/repo" }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.UNSUPPORTED_TRANSITION_OPERATION,
	);
	assert.equal(queue.calls.length, 1);
});

test("native START queries STATUS then executes only the provider-rendered ordered transition", async () => {
	const tokens = [
		"--contract=gentle-ai.review-integration/v2", "--cwd=/repo", `--target=${TARGET}`,
		"--projection=workspace", "--agent=pi", "--consent=relay",
	];
	const queue = queuedAdapter([
		{ stdout: JSON.stringify(negotiatedStartStatus(TARGET, tokens)) },
		{ stdout: JSON.stringify(fixture("start-v3-zero-lens-closed.captured.json")) },
	]);
	const result = await client(queue.adapter).start({ cwd: "/repo", targetIdentity: TARGET });
	assert.equal(result.action, "closed");
	assert.equal(result.hint, undefined);
	assert.deepEqual(queue.calls.map((call) => call.arguments), [
		["review", "status", "--contract", "gentle-ai.review-integration/v2", "--cwd", "/repo", "--projection", "workspace", "--agent", "pi", "--next-transition"],
		["review", "start", ...tokens],
	]);
});

test("native START relays provider-owned intended-untracked selection and transition argv verbatim", async () => {
	const selectionValue = JSON.stringify(["new.ts", "nested/other.ts"]);
	const selectionTokens = ["--selection-kind=untracked", "--selection-json={{value}}", "--selection-proof=provider-issued"];
	const startTokens = [
		"--contract=gentle-ai.review-integration/v2", "--cwd=/repo", `--target=${TARGET}`,
		"--projection=workspace", "--agent=pi", "--consent=relay",
	];
	const queue = queuedAdapter([
		{ stdout: JSON.stringify(negotiatedStartStatus(TARGET, startTokens)) },
		{ stdout: JSON.stringify(fixture("start-v3-zero-lens-closed.captured.json")) },
	]);
	await client(queue.adapter).start({
		cwd: "/repo",
		targetIdentity: TARGET,
		intendedUntrackedSelection: { argumentTokens: selectionTokens, value: selectionValue },
	});
	assert.deepEqual(queue.calls.map((call) => call.arguments), [
		["review", "status", "--cwd", "/repo", "--selection-kind=untracked", `--selection-json=${selectionValue}`, "--selection-proof=provider-issued"],
		["review", "start", ...startTokens],
	]);
	for (const flag of ["--untracked-scope", "--expected-untracked-inventory", "--intended-untracked", "--contract", "--agent", "--projection"]) {
		assert.equal(queue.calls[0]?.arguments.includes(flag), false, flag);
	}

	for (const argumentTokens of [["--selection-json=value"], ["--selection-json={{value}}", "--duplicate={{value}}"], ["--selection-json={{value}}{{value}}"]]) {
		const rejected = queuedAdapter([]);
		await assert.rejects(
			() => client(rejected.adapter).start({ cwd: "/repo", targetIdentity: TARGET, intendedUntrackedSelection: { argumentTokens, value: selectionValue } }),
			/exactly one provider-issued \{\{value\}\} token/,
		);
		assert.equal(rejected.calls.length, 0);
	}
});

test("native START retains the provider-owned START/v4 status transition in exact argument order", async () => {
	const tokens = [
		"--contract=gentle-ai.review-integration/v2", "--cwd=/repo", `--target=${TARGET}`,
		"--projection=workspace", "--agent=pi", "--consent=relay",
	];
	const start = reviewingStartV4(TARGET);
	const queue = queuedAdapter([
		{ stdout: JSON.stringify(negotiatedStartStatus(TARGET, tokens)) },
		{ stdout: JSON.stringify(start) },
	]);
	const result = await client(queue.adapter).start({ cwd: "/repo", targetIdentity: TARGET });
	assert.deepEqual(result.nextTransition?.execute?.arguments.map((argument) => argument.token), [
		"--contract=gentle-ai.review-integration/v2",
		"--next-transition=true",
		`--lineage=${result.lineageId}`,
		"--agent=pi",
		`--base-ref=${start.base_tree}`,
		"--committed-only=true",
	]);
	assert.deepEqual(result.nextTransition?.execute?.selectorArguments?.map((argument) => argument.token), [
		`--base-ref=${start.base_tree}`,
		"--committed-only=true",
	]);
	assert.deepEqual(queue.calls[1]?.arguments, ["review", "start", ...tokens]);
});

test("native consent completion decodes START/v4 and replays its provider argv unchanged", async () => {
	const rawConsent = fixture("consent-v3.captured.json");
	rawConsent.agent = "pi";
	for (const choice of rawConsent.choices as Record<string, unknown>[]) {
		choice.invocation = String(choice.invocation)
			.replace(/--cwd \S+ --target/, "--cwd /repo --target")
			.replace(" --consent ", " --agent pi --consent ");
	}
	const consent = decodeReviewConsentV3(rawConsent, "pi");
	const queue = queuedAdapter([{ stdout: JSON.stringify(reviewingStartV4(consent.targetIdentity)) }]);
	const answered = await client(queue.adapter).answerConsent({ cwd: "/repo", consent, answer: "granted" });
	assert.equal(answered.kind, "started");
	if (answered.kind !== "started") throw new Error("expected started consent result");
	assert.equal(answered.start.nextTransition?.execute?.operation, "review.status");
	assert.deepEqual(queue.calls[0]?.arguments, consent.choices[0].invocation.split(" ").slice(1));
});

test("native START refuses invalid committed-range and target bindings before STATUS", async () => {
	for (const request of [
		{ cwd: "/repo", baseRef: "origin/main" },
		{ cwd: "/repo", committedOnly: true },
		{ cwd: "/repo", baseRef: " origin/main", committedOnly: true },
		{ cwd: "/repo", targetIdentity: "not-a-sha" },
	]) {
		const queue = queuedAdapter([]);
		await assert.rejects(() => client(queue.adapter).start(request), TypeError);
		assert.equal(queue.calls.length, 0);
	}
});

test("capture-result stages a private input and preserves provider tokens without adding a contract", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify(fixture("last-event-capture-result-approved.captured.json")) }]);
	const result = await client(queue.adapter).captureResult({
		argumentTokens: [`--repository-context=${REPOSITORY_CONTEXT}`, "--lineage=review-c7c923a031112dd7", "--target=sha256:captured"],
		resultDocument: "{\"subject_hash\":\"sha256:captured\"}",
	});
	assert.equal("operation" in result && result.operation, "review/capture-result");
	assert.deepEqual(queue.calls[0]?.arguments.slice(0, 5), ["review", "capture-result", `--repository-context=${REPOSITORY_CONTEXT}`, "--lineage=review-c7c923a031112dd7", "--target=sha256:captured"]);
	assert.equal(queue.calls[0]?.arguments.includes("--contract"), false);
	assert.equal(queue.calls[0]?.arguments.at(-2), "--input");
	assert.equal(queue.calls[0]?.timeoutMs, undefined);
});

test("capture-result rejects an empty document and a conflicting repository context before launch", async () => {
	for (const request of [
		{ argumentTokens: [`--repository-context=${REPOSITORY_CONTEXT}`], resultDocument: "" },
		{ argumentTokens: [`--repository-context=${REPOSITORY_CONTEXT}`], resultDocument: "{}", cwd: "/repo" },
	]) {
		const queue = queuedAdapter([]);
		await assert.rejects(() => client(queue.adapter).captureResult(request), TypeError);
		assert.equal(queue.calls.length, 0);
	}
});

test("terminal correction and provider-role captures preserve unknown mutation failure semantics", async () => {
	for (const run of [
		(review: NativeReviewCliV216) => review.captureCorrectionPlan({ argumentTokens: ["--lineage=review-c7c923a031112dd7", "--correction-lines={{value}}"], correctionLines: 1, cwd: "/repo" }),
		(review: NativeReviewCliV216) => review.captureProviderRole({ captureOperation: "review.capture-refuter", argumentTokens: ["--lineage=review-c7c923a031112dd7"], cwd: "/repo" }),
	]) {
		const queue = queuedAdapter([{ stdout: "", timedOut: true }]);
		await assert.rejects(
			() => run(client(queue.adapter)),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.TIMEOUT && error.mutationOutcome === "unknown" && error.nextAction === "review.status",
		);
	}
});

test("read-only STATUS process failures remain typed and never claim mutation", async () => {
	for (const [result, code] of [
		[{ stdout: "", outputLimitExceeded: true }, NATIVE_REVIEW_ERROR_CODE.OUTPUT_LIMIT],
		[{ stdout: "", timedOut: true }, NATIVE_REVIEW_ERROR_CODE.TIMEOUT],
		[{ stdout: "", signal: "SIGTERM" as NodeJS.Signals }, NATIVE_REVIEW_ERROR_CODE.SIGNAL],
		[{ stdout: "not-json" }, NATIVE_REVIEW_ERROR_CODE.MALFORMED_JSON],
	] as const) {
		const queue = queuedAdapter([result]);
		await assert.rejects(
			() => client(queue.adapter).targetStatus({ cwd: "/repo" }),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === code && error.mutationOutcome === "none",
		);
	}
});

test("read-only STATUS rejects unexpected stderr and nonzero failures without decoding authority", async () => {
	for (const result of [
		{ stdout: JSON.stringify(currentStatusFixture()), stderr: "unexpected provider noise" },
		{ stdout: JSON.stringify({ schema: "gentle-ai.review-integration.failure/v2" }), exitCode: 1 },
	]) {
		const queue = queuedAdapter([result]);
		await assert.rejects(
			() => client(queue.adapter).targetStatus({ cwd: "/repo" }),
			(error: unknown) => error instanceof NativeReviewCliError && error.mutationOutcome === "none",
		);
	}
});

test("negotiated STATUS accepts only exact provider forecast narration on stderr", async () => {
	const narration = [
		"Forecast horizon: partial",
		"step 1: collect; reason_code=provider_refuter_required; description=run the provider-owned refuter",
		"Re-query STATUS after completing this partial head.",
	].join("\n");
	const accepted = queuedAdapter([{ stdout: JSON.stringify(currentStatusFixture()), stderr: narration }]);
	assert.equal((await client(accepted.adapter).targetStatus({ cwd: "/repo" })).action, "start");

	for (const stderr of [
		"Forecast horizon: unknown",
		`prefix ${narration}`,
		`${narration}\nunexpected provider noise`,
	]) {
		const rejected = queuedAdapter([{ stdout: JSON.stringify(currentStatusFixture()), stderr }]);
		await assert.rejects(
			() => client(rejected.adapter).targetStatus({ cwd: "/repo" }),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.UNEXPECTED_STDERR,
		);
	}
});

test("native client requires an absolute package-local executable before any invocation", () => {
	assert.throws(() => new NativeReviewCliV216(queuedAdapter([]).adapter, "gentle-ai"), /absolute package-local executable/);
	assert.throws(() => new NativeReviewCliV216(queuedAdapter([]).adapter, "relative/gentle-ai"), /absolute package-local executable/);
});

// O012 migrated from the retired per-operation version probe. V216 executes
// negotiated argv directly; this test proves the argv boundary without
// resurrecting NativeReviewCliV213 or capability/version negotiation.
test("native client executes current negotiated argv without a shell", async () => {
	const literal = "$GENTLE_PI_MUST_NOT_EXPAND";
	const result = await createNodeExecFileAdapter()({
		file: process.execPath,
		arguments: ["-p", "process.argv[1]", literal],
		cwd: process.cwd(),
		timeoutMs: 30_000,
		maxBufferBytes: 1024,
	});
	assert.equal(result.exitCode, 0);
	assert.equal(result.stderr, "");
	assert.equal(result.stdout.trim(), literal);
});

test("current STATUS preserves bounded output configuration and output-limit precedence", async () => {
	const previous = process.env.GENTLE_PI_REVIEW_MAX_BUFFER_BYTES;
	try {
		for (const [environmentValue, expectedBuffer] of [[undefined, NATIVE_REVIEW_DEFAULT_MAX_BUFFER_BYTES], ["2097152", 2_097_152], ["invalid", NATIVE_REVIEW_DEFAULT_MAX_BUFFER_BYTES]] as const) {
			if (environmentValue === undefined) delete process.env.GENTLE_PI_REVIEW_MAX_BUFFER_BYTES;
			else process.env.GENTLE_PI_REVIEW_MAX_BUFFER_BYTES = environmentValue;
			const calls: Array<{ timeoutMs: number | undefined; maxBufferBytes: number }> = [];
			const adapter: ExecFileAdapter = async (request) => {
				calls.push({ timeoutMs: request.timeoutMs, maxBufferBytes: request.maxBufferBytes });
				return { stdout: JSON.stringify(currentStatusFixture()), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
			};
			await new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai").targetStatus({ cwd: "/repo" });
			assert.deepEqual(calls, [{ timeoutMs: 30_000, maxBufferBytes: expectedBuffer }]);
		}
	} finally {
		if (previous === undefined) delete process.env.GENTLE_PI_REVIEW_MAX_BUFFER_BYTES;
		else process.env.GENTLE_PI_REVIEW_MAX_BUFFER_BYTES = previous;
	}

	const outputLimited = new NativeReviewCliV216(async () => ({
		stdout: "", stderr: "", exitCode: 0, signal: "SIGTERM", timedOut: true, outputLimitExceeded: true,
	}), "/package/.gentle-ai/gentle-ai");
	await assert.rejects(
		() => outputLimited.targetStatus({ cwd: "/repo" }),
		(error: unknown) => error instanceof NativeReviewCliError
			&& error.code === NATIVE_REVIEW_ERROR_CODE.OUTPUT_LIMIT
			&& error.mutationOutcome === "none"
			&& error.diagnostics.timed_out === false
			&& error.diagnostics.output_limit_exceeded === true
			&& error.diagnostics.max_buffer_bytes === NATIVE_REVIEW_DEFAULT_MAX_BUFFER_BYTES
			&& error.diagnostics.configuration_hint === "Inspect native review state before any new START; GENTLE_PI_REVIEW_MAX_BUFFER_BYTES accepts a positive decimal up to 67108864.",
	);
});

test("node execFile adapter passes AbortSignal to child_process", async () => {
	const controller = new AbortController();
	const pending = createNodeExecFileAdapter()({
		file: process.execPath,
		arguments: ["-e", "setTimeout(() => {}, 10_000)"],
		cwd: process.cwd(),
		timeoutMs: 30_000,
		maxBufferBytes: 1024,
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("capture-result receives the controller AbortSignal without an automatic mutation timeout", async () => {
	const controller = new AbortController();
	controller.abort();
	let receivedSignal: AbortSignal | undefined;
	let receivedTimeout: number | undefined;
	const adapter: ExecFileAdapter = async (request) => {
		receivedSignal = request.signal;
		receivedTimeout = request.timeoutMs;
		const error = new Error("cancelled");
		error.name = "AbortError";
		throw error;
	};
	await assert.rejects(
		() => new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai").captureResult({
			argumentTokens: [`--repository-context=${REPOSITORY_CONTEXT}`],
			resultDocument: "{}",
			signal: controller.signal,
		}),
		(error: unknown) => error instanceof NativeReviewCliError
			&& error.code === NATIVE_REVIEW_ERROR_CODE.CANCELLED
			&& error.mutationOutcome === "unknown"
			&& error.nextAction === "review.status",
	);
	assert.equal(receivedSignal, controller.signal);
	assert.equal(receivedTimeout, undefined);
});

test("native review client exposes native v2 SDD status without adding review lifecycle behavior", () => {
	assert.equal(typeof (client(queuedAdapter([]).adapter) as unknown as { sddStatus?: unknown }).sddStatus, "function");
});

test("read-only authority inventory rejects a repository identity mismatch after decoding", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify({
		schema: "gentle-ai.review-authority-status/v1", operation: "review/status", repository: "/foreign-repository",
		complete: true, authoritative: true, status: "clean", entries: [], locks: [], diagnostics: [],
	}) }]);
	await assert.rejects(
		() => client(queue.adapter).reviewStatus({ cwd: "/repo" }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.IDENTITY_MISMATCH && error.mutationOutcome === "none",
	);
	assert.deepEqual(queue.calls[0]?.arguments, ["review", "status", "--cwd", "/repo"]);
});


test("current native process boundary preserves caps, timeout classes, and sanitized diagnostics", async () => {
	const calls: Array<{ timeoutMs: number | undefined; maxBufferBytes: number }> = [];
	const adapter: ExecFileAdapter = async (request) => {
		calls.push({ timeoutMs: request.timeoutMs, maxBufferBytes: request.maxBufferBytes });
		if (request.arguments[1] === "capture-result") {
			return { stdout: JSON.stringify(fixture("last-event-capture-result-approved.captured.json")), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		}
		return { stdout: JSON.stringify(currentStatusFixture()), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
	};
	const review = new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 321, 654);
	await review.targetStatus({ cwd: "/repo" });
	await review.captureResult({ argumentTokens: [`--repository-context=${REPOSITORY_CONTEXT}`], resultDocument: "{}" });
	assert.deepEqual(calls, [{ timeoutMs: 321, maxBufferBytes: 654 }, { timeoutMs: undefined, maxBufferBytes: 654 }]);

	const diagnostics = queuedAdapter([{ stdout: JSON.stringify(currentStatusFixture()), stderr: "\u001b]8;;https://example.invalid/token\u0007token=super-secret\n" }]);
	await assert.rejects(
		() => client(diagnostics.adapter).targetStatus({ cwd: "/repo" }),
		(error: unknown) => error instanceof NativeReviewCliError
			&& error.code === NATIVE_REVIEW_ERROR_CODE.UNEXPECTED_STDERR
			&& !String(error.diagnostics.stderr).includes("super-secret")
			&& !/[\u0000-\u001f\u007f]/.test(String(error.diagnostics.stderr)),
	);
});

test("authority inventory accepts compact discarded work and historical entry statuses", async () => {
	const repository = process.cwd();
	const discardedWork = { captured_lens_results: [], findings_present: false };
	const statuses = ["incomplete-store-entry", "historical-pre-receipt", "invalidated"] as const;
	const body = {
		schema: "gentle-ai.review-authority-status/v1",
		operation: "review/status",
		repository,
		complete: true,
		authoritative: true,
		status: "active",
		entries: statuses.map((status) => ({
			version: "compact-v2",
			lineage_id: `review-${status}`,
			path: `${repository}/.git/gentle-ai/${status}`,
			status,
			discarded_work: discardedWork,
			problems: [],
		})),
		locks: [],
		diagnostics: [],
	};
	const decoded = await client(queuedAdapter([{ stdout: JSON.stringify(body) }]).adapter).reviewStatus({ cwd: repository });
	assert.deepEqual(decoded.entries.map((entry) => ({ status: entry.status, discardedWork: entry.discardedWork })), statuses.map((status) => ({
		status,
		discardedWork: { capturedLensResults: [], findingsPresent: false },
	})));

	for (const entry of [
		{ ...body.entries[0], discarded_work: { captured_lens_results: "not-an-array", findings_present: false } },
		{ ...body.entries[0], discarded_work: { ...discardedWork, unexpected: true } },
		{ ...body.entries[0], status: "future-status" },
	]) {
		await assert.rejects(
			() => client(queuedAdapter([{ stdout: JSON.stringify({ ...body, entries: [entry] }) }]).adapter).reviewStatus({ cwd: repository }),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE,
		);
	}
});

test("current review STATUS retains compact snapshot and released-lock wire fields", async (t) => {
	const repository = process.cwd();
	const snapshotIdentity = `sha256:${"d".repeat(64)}`;
	const body = {
		schema: "gentle-ai.review-authority-status/v1",
		operation: "review/status",
		repository,
		complete: true,
		authoritative: true,
		status: "active",
		entries: [{ version: "compact-v2", lineage_id: "current-lineage", path: `${repository}/.git/gentle-ai`, status: "active", revision: `sha256:${"e".repeat(64)}`, snapshot_identity: snapshotIdentity, problems: [] }],
		locks: [{ version: "compact-v2", path: `${repository}/.git/gentle-ai/LOCK`, status: "released" }],
		diagnostics: [],
	};
	const queue = queuedAdapter([{ stdout: JSON.stringify(body) }]);
	const status = await client(queue.adapter).reviewStatus({ cwd: repository });
	assert.equal(status.entries[0]?.snapshotIdentity, snapshotIdentity);
	assert.deepEqual(status.locks, [{ version: "compact-v2", path: `${repository}/.git/gentle-ai/LOCK`, status: "released" }]);
	for (const lockStatus of ["Released", "stale", "future"]) {
		const malformed = queuedAdapter([{ stdout: JSON.stringify({ ...body, locks: [{ ...body.locks[0], status: lockStatus }] }) }]);
		await assert.rejects(
			() => client(malformed.adapter).reviewStatus({ cwd: repository }),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE,
		);
	}
	if (process.platform !== "win32") {
		const root = mkdtempSync(join(tmpdir(), "gentle-pi-native-status-"));
		const alias = `${root}-alias`;
		symlinkSync(root, alias, "dir");
		t.after(() => {
			rmSync(alias, { force: true });
			rmSync(root, { recursive: true, force: true });
		});
		const canonical = queuedAdapter([{ stdout: JSON.stringify({ ...body, repository: root }) }]);
		assert.equal((await client(canonical.adapter).reviewStatus({ cwd: alias })).repository, root);
	}
});

// ---------------------------------------------------------------------------
// acknowledge-approved — gentle-ai #3947 made the burn print one typed
// `gentle-ai.review-acknowledged/v1` envelope; every published release up to
// v2.5.0-rc.3 burns in silence. Both are a successful burn; anything else on
// stdout is not.
// ---------------------------------------------------------------------------

const ACKNOWLEDGED_LINEAGE = "review-3ec95251db75f626";
const ACKNOWLEDGED_TARGET = "sha256:b505dcd8d82395c053c9786935e11e0e235cbdecca4f1f46f98c768ea6248d3d";
const ACKNOWLEDGED_REVISION = "sha256:9732b1c3526bfecd3851093239241145c970cc126acea59bfaf14133214b60ee";
const ACKNOWLEDGEMENT_TOKENS = [`--cwd=/repo`, `--lineage=${ACKNOWLEDGED_LINEAGE}`, `--target=${ACKNOWLEDGED_TARGET}`, `--expected-revision=${ACKNOWLEDGED_REVISION}`, "--token=provider-issued-once"] as const;
const ACKNOWLEDGED_BINDING = { lineageId: ACKNOWLEDGED_LINEAGE, targetIdentity: ACKNOWLEDGED_TARGET, revision: ACKNOWLEDGED_REVISION } as const;

test("acknowledge-approved keeps accepting the pinned silent burn byte-for-byte", async () => {
	const queue = queuedAdapter([{ stdout: "" }]);
	const result = await client(queue.adapter).acknowledgeApproved({ argumentTokens: ACKNOWLEDGEMENT_TOKENS, cwd: "/repo", binding: ACKNOWLEDGED_BINDING });
	assert.equal(result, undefined);
	assert.deepEqual(queue.calls[0]?.arguments, ["review", "acknowledge-approved", ...ACKNOWLEDGEMENT_TOKENS]);
	assert.equal(queue.calls[0]?.cwd, "/repo");
	assert.equal(queue.calls[0]?.timeoutMs, undefined);
	assert.equal(queue.calls.length, 1);
});

test("acknowledge-approved decodes the captured review-acknowledged/v1 burn envelope", async () => {
	const raw = readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "review-acknowledged-v1.captured.json"), "utf8");
	const queue = queuedAdapter([{ stdout: raw }]);
	const result = await client(queue.adapter).acknowledgeApproved({ argumentTokens: ACKNOWLEDGEMENT_TOKENS, cwd: "/repo", binding: ACKNOWLEDGED_BINDING });
	assert.equal(result?.schema, "gentle-ai.review-acknowledged/v1");
	assert.deepEqual(
		{ lineageId: result?.lineageId, targetIdentity: result?.targetIdentity, consumedRevision: result?.consumedRevision, authority: result?.authority },
		{ lineageId: ACKNOWLEDGED_LINEAGE, targetIdentity: ACKNOWLEDGED_TARGET, consumedRevision: ACKNOWLEDGED_REVISION, authority: "burned" },
	);
	assert.deepEqual(queue.calls[0]?.arguments, ["review", "acknowledge-approved", ...ACKNOWLEDGEMENT_TOKENS]);
	assert.equal(queue.calls.length, 1);

	const unbound = await client(queuedAdapter([{ stdout: raw }]).adapter).acknowledgeApproved({ argumentTokens: ACKNOWLEDGEMENT_TOKENS, cwd: "/repo" });
	assert.equal(unbound?.consumedRevision, ACKNOWLEDGED_REVISION);
});

test("acknowledge-approved fails closed on a foreign, drifted, or mismatched success body", async () => {
	const raw = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "review-acknowledged-v1.captured.json"), "utf8")) as Record<string, unknown>;
	const bodies: Array<[string, string, { lineageId: string; targetIdentity: string; revision: string }]> = [
		["a STATUS envelope", JSON.stringify(fixture("status-v5.captured.json")), ACKNOWLEDGED_BINDING],
		["a last-event closure", JSON.stringify(fixture("last-event-capture-result-approved.captured.json")), ACKNOWLEDGED_BINDING],
		["an envelope with an unknown field", JSON.stringify({ ...raw, receipt: {} }), ACKNOWLEDGED_BINDING],
		["an envelope naming another lineage", JSON.stringify(raw), { ...ACKNOWLEDGED_BINDING, lineageId: "review-other" }],
		["an envelope naming another revision", JSON.stringify(raw), { ...ACKNOWLEDGED_BINDING, revision: `sha256:${"c".repeat(64)}` }],
		["non-JSON output", "acknowledged\n", ACKNOWLEDGED_BINDING],
	];
	for (const [name, stdout, binding] of bodies) {
		const queue = queuedAdapter([{ stdout }]);
		await assert.rejects(
			() => client(queue.adapter).acknowledgeApproved({ argumentTokens: ACKNOWLEDGEMENT_TOKENS, cwd: "/repo", binding }),
			(error: unknown) => error instanceof NativeReviewCliError
				&& (error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE || error.code === NATIVE_REVIEW_ERROR_CODE.MALFORMED_JSON)
				&& error.mutationOutcome === "unknown",
			name,
		);
		assert.equal(queue.calls.length, 1, name);
	}
});

test("acknowledge-approved keeps its fail-closed stderr and typed refusal discipline around the envelope", async () => {
	const raw = readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "review-acknowledged-v1.captured.json"), "utf8");
	await assert.rejects(
		() => client(queuedAdapter([{ stdout: raw, stderr: "note: burned\n" }]).adapter).acknowledgeApproved({ argumentTokens: ACKNOWLEDGEMENT_TOKENS, cwd: "/repo", binding: ACKNOWLEDGED_BINDING }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.UNEXPECTED_STDERR,
	);
	await assert.rejects(
		() => client(queuedAdapter([{ stdout: "", stderr: "note: burned\n" }]).adapter).acknowledgeApproved({ argumentTokens: ACKNOWLEDGEMENT_TOKENS, cwd: "/repo", binding: ACKNOWLEDGED_BINDING }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.UNEXPECTED_STDERR,
	);
	const failure = {
		schema: "gentle-ai.review-integration.failure/v2",
		contract: "gentle-ai.review-integration/v2",
		operation: "review.capture-result",
		phase: "pre_native",
		code: "gate_scope_changed",
		message: "the target scope changed since START",
		mutation_outcome: "not_started",
		authority_applicability: "current_target",
		retry_safe: true,
		replayability: "manual_action_required",
		required_inputs: [],
		next_action: "explicit-maintainer-action",
	};
	await assert.rejects(
		() => client(queuedAdapter([{ stdout: JSON.stringify(failure), exitCode: 1 }]).adapter).acknowledgeApproved({ argumentTokens: ACKNOWLEDGEMENT_TOKENS, cwd: "/repo", binding: ACKNOWLEDGED_BINDING }),
		(error: unknown) => error instanceof Error && error.name === "NativeReviewIntegrationError",
	);
	await assert.rejects(
		() => client(queuedAdapter([{ stdout: "", stderr: "Error: approved acknowledgement names no live compact authority\n", exitCode: 1 }]).adapter).acknowledgeApproved({ argumentTokens: ACKNOWLEDGEMENT_TOKENS, cwd: "/repo", binding: ACKNOWLEDGED_BINDING }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.EMPTY_OUTPUT,
	);
});

test("native continuation uses a distinct mutating operation and the same v2 decoder", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify(nativeSddStatus()) }, { stdout: "{}" }]);
	const cli = client(queue.adapter);
	const request = { changeName: "complete-native-review-lifecycle", workspaceRoot: "/repo" };
	assert.equal((await cli.sddContinue(request)).nextRecommended, nativeSddStatus().nextRecommended);
	assert.deepEqual(queue.calls[0]!.arguments, ["sdd-continue", request.changeName, "--cwd", "/repo", "--json", "--instructions"]);
	assert.equal(queue.calls[0]!.timeoutMs, undefined);
	await assert.rejects(() => cli.sddContinue(request), (error: unknown) => error instanceof NativeReviewCliError && error.mutating === true);
});

test("native discovery preserves nullable selection and rejects an invented selected identity", () => {
	const discovery = { ...nativeSddStatus(), changeName: null, changeRoot: null, nextRecommended: "select-change" };
	assert.equal(decodeNativeSddStatusV2(discovery, { workspaceRoot: "/repo" }).changeName, null);
	assert.throws(() => decodeNativeSddStatusV2(discovery, { changeName: "alpha", workspaceRoot: "/repo" }), /identity/);
});

test("all twelve native actions retain their exact tokens without prose routing", () => {
	for (const nextRecommended of ["apply", "verify", "remediate", "archive", "archived", "resolve-blockers", "sdd-new", "select-change", "propose", "spec", "design", "tasks"]) {
		const status = { ...nativeSddStatus(), nextRecommended, ...(nextRecommended === "remediate" ? { remediationState: { required: true, complete: false, failedEvidenceRevision: `sha256:${"a".repeat(64)}` } } : {}) };
		assert.equal(decodeNativeSddStatusV2(status, { workspaceRoot: "/repo" }).nextRecommended, nextRecommended);
	}
});
