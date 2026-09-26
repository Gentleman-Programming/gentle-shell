import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __testing, createGentleAiExtension, PendingReviewConsentRegistry } from "../extensions/gentle-ai.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { NATIVE_REVIEW_ERROR_CODE, NativeReviewCliError, NativeReviewConsentRequiredError, type NativeReviewCli } from "../lib/native-review-cli.ts";
import { decodeReviewConsentV3, decodeReviewStatusV3, type ReviewCollectInputV3, type ReviewStatusV3 } from "../lib/review-integration-v2.ts";

const SHA = `sha256:${"a".repeat(64)}`;
const TREE = "b".repeat(40);

function collectInput(lineageId: string): ReviewCollectInputV3 {
	const arguments_ = [
		{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
		{ name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` },
		{ name: "target", value: SHA, token: `--target=${SHA}` },
		{ name: "repository-context", value: `rctx1_${"c".repeat(64)}`, token: `--repository-context=rctx1_${"c".repeat(64)}` },
		{ name: "lens", value: "review-risk", token: "--lens=review-risk" },
		{ name: "order", value: "0", token: "--order=0" },
		{ name: "subject-hash", value: SHA, token: `--subject-hash=${SHA}` },
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
			lens: "review-risk",
			selectedOrder: 0,
		},
		submission: {
			operationToken: "capture-result",
			argumentTokens: [...arguments_.map((argument) => argument.token!), "--input={{value}}"],
			values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: 7 }],
		},
	};
}

function status(
	lineageId: string,
	inputs: readonly ReviewCollectInputV3[] = [collectInput(lineageId)],
	authorityState = "reviewing",
): ReviewStatusV3 {
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: authorityState, generation: 1, revision: SHA },
		receipt: { status: "expected_missing" },
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
		repair: { schema: "gentle-ai.review-authority-repair-assessment/v1", status: "unsupported", counts: { lineages: 0, compactLineages: 0, legacyLineages: 0, events: 0, bytes: 0, eligibleCandidates: 0, unsupportedLineages: 0, conflicts: 0 }, supportedOperations: ["review/complete-fix", "review/validate-fix"], authorizationSchema: "gentle-ai.review-repair-authorization/v1" },
		candidates: [],
		nextTransition: { kind: "collect", reasonCode: "capture_required", collect: { inputs } },
		raw: { schema: "gentle-ai.review-integration.status/v5" },
	} as unknown as ReviewStatusV3;
}

function approvedAcknowledgementStatus(lineageId: string, cwd = process.cwd()): ReviewStatusV3 {
	const arguments_ = [{ name: "cwd", value: cwd, token: `--cwd=${cwd}` }, { name: "lineage", value: lineageId, token: `--lineage=${lineageId}` }, { name: "target", value: SHA, token: `--target=${SHA}` }, { name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` }, { name: "token", value: "provider-issued-once", token: "--token=provider-issued-once" }];
	const approved = status(lineageId, [], "approved");
	approved.nextTransition = { kind: "execute", reasonCode: "approved_acknowledgement_required", execute: { operation: "review.acknowledge-approved", command: "gentle-ai review acknowledge-approved --provider-vector", arguments: arguments_, preconditions: [{ name: "state", value: "approved", token: "--state=approved" }], binding: { lineageId, targetIdentity: SHA, revision: SHA } } };
	return approved;
}

function burnedAcknowledgementStatus(lineageId: string): ReviewStatusV3 {
	const burned = status(lineageId, [], "approved");
	burned.nextTransition = { kind: "stop", reasonCode: "approved_acknowledged" };
	return burned;
}

// gentle-pi#627: gentle-ai reports a stale managed-asset set as a typed stop
// carrying the exact `gentle-ai sync` invocation that resolves it.
function managedAssetsOutdatedStatus(lineageId: string): ReviewStatusV3 {
	const stopped = status(lineageId, [], "approved");
	stopped.nextTransition = { kind: "stop", reasonCode: "managed_assets_outdated", continuation: { operation: "sync", command: "gentle-ai sync --agent claude-code", agent: "claude-code", staleAssets: ["orchestration/claude-code.md"] } };
	return stopped;
}

test("STATUS renders the managed_assets_outdated continuation command as the actionable next step", async () => {
	const lineageId = "managed-assets-outdated";
	const native = { targetStatus: async () => managedAssetsOutdatedStatus(lineageId) } as unknown as NativeReviewCli;
	const blocked = await __testing.executeReviewControllerOperation({ operation: "status", lineageId }, process.cwd(), native);
	assert.equal(blocked.status, "blocked");
	assert.equal(blocked.hint, "run gentle-ai sync --agent claude-code");

	// an unknown stop reason code keeps rendering as a plain blocked result
	const otherStopNative = { targetStatus: async () => burnedAcknowledgementStatus(lineageId) } as unknown as NativeReviewCli;
	const plainBlocked = await __testing.executeReviewControllerOperation({ operation: "status", lineageId }, process.cwd(), otherStopNative);
	assert.equal(plainBlocked.status, "blocked");
	assert.equal(plainBlocked.hint, undefined);

	// an older gentle-ai may report this same stop with no continuation; the
	// renderer degrades to a plain blocked result instead of losing the status
	const noContinuation = status(lineageId, [], "approved");
	noContinuation.nextTransition = { kind: "stop", reasonCode: "managed_assets_outdated" };
	const noContinuationNative = { targetStatus: async () => noContinuation } as unknown as NativeReviewCli;
	const degraded = await __testing.executeReviewControllerOperation({ operation: "status", lineageId }, process.cwd(), noContinuationNative);
	assert.equal(degraded.status, "blocked");
	assert.equal(degraded.hint, undefined);
});

test("public acknowledgement relays one current provider vector and never replays after authority burn", async () => {
	const lineageId = "acknowledge-approved";
	const requests: Array<Record<string, unknown>> = [];
	const acknowledgementRequests: Array<{ argumentTokens: readonly string[]; cwd: string }> = [];
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return requests.length === 1
				? approvedAcknowledgementStatus(lineageId)
				: burnedAcknowledgementStatus(lineageId);
		},
		acknowledgeApproved: async (request: { argumentTokens: readonly string[]; cwd: string }) => {
			acknowledgementRequests.push(request);
		},
	} as unknown as NativeReviewCli;

	const rejected = await __testing.executeReviewControllerOperation({ operation: "acknowledge-approved", lineageId, input: "{}" }, process.cwd(), native);
	assert.deepEqual({ outcome: rejected.outcome, calls: requests.length }, { outcome: "native-approved-acknowledgement-input-invalid", calls: 0 });
	const completed = await __testing.executeReviewControllerOperation({ operation: "acknowledge-approved", lineageId }, process.cwd(), native);
	assert.deepEqual(completed, { operation: "acknowledge-approved", status: "closed", outcome: "native-approved-acknowledgement-completed", lineage_id: lineageId, target_identity: SHA, authority: "burned", delivery: "ordinary-repository-policy", mutation_performed: true, mutation_outcome: "committed" });
	assert.deepEqual(requests, [{ cwd: process.cwd(), lineageId }]);
	assert.deepEqual(acknowledgementRequests, [{ cwd: process.cwd(), argumentTokens: [`--cwd=${process.cwd()}`, `--lineage=${lineageId}`, `--target=${SHA}`, `--expected-revision=${SHA}`, "--token=provider-issued-once"], binding: { lineageId, targetIdentity: SHA, revision: SHA } }]);

	const later = await __testing.executeReviewControllerOperation({ operation: "acknowledge-approved", lineageId }, process.cwd(), native);
	assert.equal(later.outcome, "native-approved-acknowledgement-not-current");
	assert.equal(requests.length, 2);
	assert.equal(acknowledgementRequests.length, 1);
});

test("approved acknowledgement reuses an explicit STATUS excluded-untracked selection and clears it after consumption", async () => {
	const cwd = process.cwd();
	const lineageId = "acknowledge-approved-excluded-untracked";
	const selection = {
		untrackedScope: "exclude",
		expectedUntrackedInventory: "inventory-sha256",
		intendedUntracked: [],
	};
	const selections = new Map();
	const requests: Array<Record<string, unknown>> = [];
	let acknowledgements = 0;
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return approvedAcknowledgementStatus(lineageId);
		},
		acknowledgeApproved: async () => { acknowledgements += 1; },
	} as unknown as NativeReviewCli;

	await __testing.executeReviewControllerOperation(
		{ operation: "status", lineageId, input: JSON.stringify(selection) },
		cwd,
		native,
		undefined,
		undefined,
		undefined,
		selections,
	);
	const acknowledged = await __testing.executeReviewControllerOperation(
		{ operation: "acknowledge-approved", lineageId },
		cwd,
		native,
		undefined,
		undefined,
		undefined,
		selections,
	);
	assert.equal(acknowledged.outcome, "native-approved-acknowledgement-completed");
	await __testing.executeReviewControllerOperation(
		{ operation: "status", lineageId },
		cwd,
		native,
		undefined,
		undefined,
		undefined,
		selections,
	);
	assert.deepEqual(requests, [
		{ cwd, lineageId, agent: "pi", ...selection },
		{ cwd, lineageId, ...selection },
		{ cwd, lineageId, agent: "pi" },
	]);
	assert.equal(acknowledgements, 1);
});

test("public acknowledgement reports the burn from the review-acknowledged/v1 envelope when the provider prints one", async () => {
	const lineageId = "acknowledge-approved-envelope";
	let statusCalls = 0;
	const acknowledgementRequests: Array<Record<string, unknown>> = [];
	const native = {
		targetStatus: async () => {
			statusCalls += 1;
			return statusCalls === 1 ? approvedAcknowledgementStatus(lineageId) : burnedAcknowledgementStatus(lineageId);
		},
		acknowledgeApproved: async (request: Record<string, unknown>) => {
			acknowledgementRequests.push(request);
			return {
				schema: "gentle-ai.review-acknowledged/v1",
				operation: "review/acknowledge-approved",
				action: "acknowledged",
				lineageId,
				targetIdentity: SHA,
				consumedRevision: SHA,
				authority: "burned",
				raw: { schema: "gentle-ai.review-acknowledged/v1" },
			};
		},
	} as unknown as NativeReviewCli;

	const completed = await __testing.executeReviewControllerOperation({ operation: "acknowledge-approved", lineageId }, process.cwd(), native);
	assert.deepEqual(completed, {
		operation: "acknowledge-approved",
		status: "closed",
		outcome: "native-approved-acknowledgement-completed",
		lineage_id: lineageId,
		target_identity: SHA,
		consumed_revision: SHA,
		authority: "burned",
		burn_evidence: "gentle-ai.review-acknowledged/v1",
		delivery: "ordinary-repository-policy",
		mutation_performed: true,
		mutation_outcome: "committed",
	});
	assert.equal(statusCalls, 1, "the burn is reported from the envelope, never from a later STATUS");
	assert.deepEqual(acknowledgementRequests, [{
		cwd: process.cwd(),
		argumentTokens: [`--cwd=${process.cwd()}`, `--lineage=${lineageId}`, `--target=${SHA}`, `--expected-revision=${SHA}`, "--token=provider-issued-once"],
		binding: { lineageId, targetIdentity: SHA, revision: SHA },
	}]);
});

function candidateRepository(t: test.TestContext): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-native-routing-")));
	// The registry's views are 0555 dirs / 0444 files; restore writability before
	// the fixture teardown so a surviving view never breaks rmSync.
	t.after(() => { try { execFileSync("chmod", ["-R", "u+w", cwd]); } catch {} rmSync(cwd, { recursive: true, force: true }); });
	const git = (...arguments_: string[]) => execFileSync("git", arguments_, { cwd, encoding: "utf8" });
	git("init", "-b", "main");
	writeFileSync(join(cwd, "tracked.txt"), "base\n");
	git("add", "tracked.txt");
	git("-c", "user.name=Routing Test", "-c", "user.email=routing@example.invalid", "commit", "-m", "base");
	return realpathSync(cwd);
}

test("approved acknowledgement burn tears down the retained candidate view and keeps its projection", async (t) => {
	const lineageId = "acknowledge-approved-view-teardown";
	const contributorRoot = candidateRepository(t);
	writeFileSync(join(contributorRoot, "tracked.txt"), "candidate\n");
	const registry = new CandidateViewRegistry();
	t.after(() => registry.cleanupAll());
	const view = registry.create({ contributorRoot });
	registry.retain(view.token, lineageId);
	assert.ok(existsSync(view.root));
	let approved = false;
	const native = {
		targetStatus: async () => approved ? approvedAcknowledgementStatus(lineageId, contributorRoot) : status(lineageId),
		acknowledgeApproved: async () => {},
	} as unknown as NativeReviewCli;

	const blocked = await __testing.executeReviewControllerOperation({ operation: "acknowledge-approved", lineageId }, contributorRoot, native, undefined, registry);
	assert.equal(blocked.outcome, "native-approved-acknowledgement-not-current");
	assert.ok(existsSync(view.root), "a refused acknowledgement proves no burn; the view must survive");

	approved = true;
	const completed = await __testing.executeReviewControllerOperation({ operation: "acknowledge-approved", lineageId }, contributorRoot, native, undefined, registry);
	assert.equal(completed.outcome, "native-approved-acknowledgement-completed");
	assert.equal(existsSync(view.root), false, "the burn must tear down the immutable candidate view worktree");
	assert.ok(registry.hasProjection(lineageId, contributorRoot), "terminal approved cleanup keeps the lineage projection");
});

// gentle-ai#4003: the native burn is the committed authority outcome. A Pi-side
// candidate-view teardown failure after it must never be reported as a failed
// acknowledgement, or the caller cannot tell that authority was consumed.
test("approved acknowledgement reports the burn truthfully when candidate-view cleanup fails after it", async (t) => {
	const lineageId = "acknowledge-approved-deferred-cleanup";
	const contributorRoot = candidateRepository(t);
	writeFileSync(join(contributorRoot, "tracked.txt"), "candidate\n");
	let failWorktreeRemove = true;
	const registry = new CandidateViewRegistry((file, arguments_, options) => {
		if (failWorktreeRemove && arguments_[0] === "worktree" && arguments_[1] === "remove") {
			failWorktreeRemove = false;
			throw Object.assign(new Error("simulated worktree removal failure"), { status: 128 });
		}
		return execFileSync(file, arguments_, options);
	});
	t.after(() => registry.cleanupAll());
	const view = registry.create({ contributorRoot });
	registry.retain(view.token, lineageId);
	const statusRequests: unknown[] = [];
	let acknowledgements = 0;
	const native = {
		targetStatus: async (request: unknown) => { statusRequests.push(request); return approvedAcknowledgementStatus(lineageId, contributorRoot); },
		acknowledgeApproved: async () => { acknowledgements += 1; },
	} as unknown as NativeReviewCli;

	const completed = await __testing.executeReviewControllerOperation({ operation: "acknowledge-approved", lineageId }, contributorRoot, native, undefined, registry);

	assert.equal(acknowledgements, 1, "exactly one native burn");
	assert.equal(statusRequests.length, 1, "no STATUS reconciliation after a cleanup-only failure");
	assert.equal(completed.status, "closed");
	assert.equal(completed.outcome, "native-approved-acknowledgement-completed");
	assert.equal(completed.authority, "burned");
	assert.equal(completed.mutation_performed, true);
	assert.equal(completed.mutation_outcome, "committed");
	assert.deepEqual(completed.candidate_view_cleanup, {
		status: "deferred",
		diagnostics: { code: "candidate-view-git-failure", message: "candidate-view Git command worktree failed; inspect the candidate state before any new START" },
		next_action: "retry-candidate-view-cleanup-or-remove-the-view-out-of-band",
	});
	assert.ok(existsSync(view.root), "a failed teardown preserves the candidate view");
	assert.ok(registry.hasProjection(lineageId, contributorRoot), "the lineage projection survives the deferred cleanup");

	// The residue stays recoverable: the registry still owns the view, so a
	// later terminal cleanup removes it without replaying the burn.
	registry.cleanupTerminal(lineageId, "approved", contributorRoot);
	assert.equal(existsSync(view.root), false);
	assert.equal(acknowledgements, 1);
});

test("ambiguous acknowledgement reconciles STATUS once without replaying the provider vector", async () => {
	const lineageId = "ambiguous-acknowledgement";
	let statusCalls = 0;
	let acknowledgementCalls = 0;
	const native = {
		targetStatus: async () => {
			statusCalls += 1;
			return statusCalls === 1
				? approvedAcknowledgementStatus(lineageId)
				: burnedAcknowledgementStatus(lineageId);
		},
		acknowledgeApproved: async () => { acknowledgementCalls += 1; throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, "review/acknowledge-approved", true, true, "acknowledgement outcome unknown"); },
	} as unknown as NativeReviewCli;

	const result = await __testing.executeReviewControllerOperation({ operation: "acknowledge-approved", lineageId }, process.cwd(), native);
	assert.equal(result.outcome, "native-mutation-status-reconciled");
	assert.equal(result.mutation_outcome, "unknown");
	assert.equal((result.diagnostics as { error_code?: string }).error_code, NATIVE_REVIEW_ERROR_CODE.NON_ZERO);
	assert.deepEqual(result.reconciliation, { schema: "gentle-ai.review-integration.status/v5" });
	assert.equal(statusCalls, 2);
	assert.equal(acknowledgementCalls, 1);
});

test("public acknowledgement rejects a typed decoy provider vector before invocation", async () => {
	const lineageId = "decoy-acknowledgement";
	const decoy = approvedAcknowledgementStatus(lineageId);
	const target = decoy.nextTransition!.execute!.arguments[2]!;
	target.value = `sha256:${"b".repeat(64)}`;
	target.token = `--target=${target.value}`;
	let statusCalls = 0;
	let acknowledgementCalls = 0;
	const native = {
		targetStatus: async () => { statusCalls += 1; return decoy; },
		acknowledgeApproved: async () => { acknowledgementCalls += 1; },
	} as unknown as NativeReviewCli;

	const result = await __testing.executeReviewControllerOperation({ operation: "acknowledge-approved", lineageId }, process.cwd(), native);
	assert.equal(result.outcome, "native-operation-failed");
	assert.equal(result.mutation_outcome, "none");
	assert.equal(statusCalls, 1);
	assert.equal(acknowledgementCalls, 0);
});

test("public acknowledgement rejects a mismatched provider cwd before invocation", async () => {
	let invoked = false;
	const result = await __testing.executeReviewControllerOperation({ operation: "acknowledge-approved", lineageId: "mismatched-cwd" }, process.cwd(), {
		targetStatus: async () => approvedAcknowledgementStatus("mismatched-cwd", "/provider/mismatch"),
		acknowledgeApproved: async () => { invoked = true; },
	} as unknown as NativeReviewCli);
	assert.deepEqual({ outcome: result.outcome, invoked }, { outcome: "native-operation-failed", invoked: false });
});

test("local acknowledgement failure remains pre-launch and does not reconcile STATUS", async () => {
	const lineageId = "local-acknowledgement-failure";
	let statusCalls = 0;
	let acknowledgementCalls = 0;
	const native = {
		targetStatus: async () => { statusCalls += 1; return approvedAcknowledgementStatus(lineageId); },
		acknowledgeApproved: async () => { acknowledgementCalls += 1; throw new TypeError("local acknowledgement validation failed"); },
	} as unknown as NativeReviewCli;

	const result = await __testing.executeReviewControllerOperation({ operation: "acknowledge-approved", lineageId }, process.cwd(), native);
	assert.equal(result.outcome, "native-operation-failed");
	assert.equal(result.mutation_outcome, "none");
	assert.equal(statusCalls, 1);
	assert.equal(acknowledgementCalls, 1);
});

function correctionPlanInput(lineageId: string): ReviewCollectInputV3 {
	const arguments_ = [{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` }, { name: "target", value: SHA, token: `--target=${SHA}` }];
	return { name: "correction_plan", schema: "https://gentle-ai.dev/schema/review/correction-plan/v1", captureOperation: "review.capture-correction-plan", arguments: arguments_, submission: { operationToken: "capture-correction-plan", argumentTokens: [`--lineage=${lineageId}`, "--correction-lines={{value}}"], values: [{ slot: "correction_lines", domain: "integer", substitutionLocation: 1, minimum: 1, maximum: 200 }] } } as unknown as ReviewCollectInputV3;
}

function bindingOf(result: Record<string, unknown>): string {
	return (result.collectBindings as readonly { collectBinding: string }[])[0]!.collectBinding;
}

test("public STATUS exposes one opaque current collect binding without advancing authority", async () => {
	const lineageId = "public-status-lineage";
	let statusCalls = 0;
	const native = {
		targetStatus: async (request: { lineageId?: string; agent?: string }) => {
			statusCalls += 1;
			assert.equal(request.lineageId, lineageId);
			assert.equal(request.agent, "pi");
			assert.equal("baseRef" in request, false);
			assert.equal("committedOnly" in request, false);
			return status(lineageId);
		},
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation(
		{ operation: "status", lineageId },
		process.cwd(),
		native,
	);
	assert.equal(result.status, "blocked");
	assert.equal(statusCalls, 1);
	const collectBindings = result.collectBindings as readonly { collectBinding: string }[];
	assert.equal(collectBindings.length, 1);
	assert.deepEqual(JSON.parse(collectBindings[0]!.collectBinding), collectInput(lineageId));
});

test("interleaved sessions sharing a CLI retain only their own capture routes", async () => {
	const [a, b] = ["interleaved-a", "interleaved-b"];
	const inputs = new Map([[a, correctionPlanInput(a)], [b, correctionPlanInput(b)]]);
	const requests: Array<Record<string, unknown>> = [];
	let releaseA!: () => void, releaseB!: () => void, readyA!: () => void, readyB!: () => void;
	const waits = [new Promise<void>((resolve) => { releaseA = resolve; }), new Promise<void>((resolve) => { releaseB = resolve; })];
	const ready = [new Promise<void>((resolve) => { readyA = resolve; }), new Promise<void>((resolve) => { readyB = resolve; })];
	let captures = 0;
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			const index = requests.length - 1;
			if (index < 2) { [readyA, readyB][index]!(); await waits[index]!; }
			const lineageId = String(request.lineageId);
			return status(lineageId, [inputs.get(lineageId)!]);
		},
		captureCorrectionPlan: async ({ argumentTokens }: { argumentTokens: readonly string[] }) => {
			captures += 1;
			const lineageId = argumentTokens.find((token) => token.startsWith("--lineage="))!.slice("--lineage=".length);
			return { schema: "gentle-ai.review-last-event-closure/v1", operation: "review.capture-correction-plan", lineageId, state: "correction_required", storeRevision: SHA };
		},
	} as unknown as NativeReviewCli;
	const { controller, capture, sessionShutdown } = reviewRuntime(native, new CandidateViewRegistry());
	const contexts = [a, b].map((id) => ({ ...reviewContext(process.cwd()), sessionManager: { getSessionId: () => id } } as unknown as ExtensionContext));
	const listedA = controller.execute("", { operation: "status", lineageId: a, input: JSON.stringify({ baseRef: "base-a", committedOnly: true }) }, undefined, undefined, contexts[0]!);
	await ready[0];
	const listedB = controller.execute("", { operation: "status", lineageId: b, input: JSON.stringify({ baseRef: "base-b", committedOnly: true }) }, undefined, undefined, contexts[1]!);
	await ready[1]; releaseA(); await listedA; releaseB();
	const [resultA, resultB] = await Promise.all([listedA, listedB]);
	const ownA = await capture.execute("", { lineageId: a, collectBinding: bindingOf(resultA.details as Record<string, unknown>), correctionLines: 1 }, undefined, undefined, contexts[0]!);
	const ownB = await capture.execute("", { lineageId: b, collectBinding: bindingOf(resultB.details as Record<string, unknown>), correctionLines: 1 }, undefined, undefined, contexts[1]!);
	const foreign = await capture.execute("", { lineageId: a, collectBinding: bindingOf(resultA.details as Record<string, unknown>), correctionLines: 1 }, undefined, undefined, contexts[1]!);
	await sessionShutdown({}, contexts[0]!);
	const cleaned = await capture.execute("", { lineageId: a, collectBinding: bindingOf(resultA.details as Record<string, unknown>), correctionLines: 1 }, undefined, undefined, contexts[0]!);
	assert.deepEqual({
		outcomes: [ownA, ownB, foreign, cleaned].map(({ details }) => (details as { outcome?: string }).outcome),
		revalidationCalls: requests.length - 2,
		captures,
	}, { outcomes: ["native-last-event-closure", "native-last-event-closure", "capture-binding-rejected", "capture-binding-rejected"], revalidationCalls: 2, captures: 2 });
});

test("REPAIR retains frozen committed collect selectors and leaves workspace routes unselected", async (t) => {
	const candidateViews = new CandidateViewRegistry(); t.after(() => candidateViews.cleanupAll());
	const cwd = repository(t), lineageId = "repair-committed", input = correctionPlanInput(lineageId); const view = candidateViews.create({ contributorRoot: cwd, baseRef: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(), committedOnly: true });
	candidateViews.retain(view.token, lineageId); const frozenTarget = candidateViews.resolveProjection(lineageId, cwd), selections = new Map(), requests: Array<Record<string, unknown>> = [];
	const native = {
		targetStatus: async (request: Record<string, unknown>) => { requests.push(request); return requests.length === 3 ? status(lineageId, [], "approved") : status(lineageId, [input]); },
		captureCorrectionPlan: async () => { throw Object.assign(new Error("lost response"), { mutationOutcome: "unknown", nextAction: "review.status" }); },
	} as unknown as NativeReviewCli;
	await __testing.executeReviewControllerOperation({ operation: "repair", lineageId }, cwd, native, undefined, candidateViews, undefined, selections);
	const result = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: JSON.stringify(input), correctionLines: 1 }, cwd, native, undefined, candidateViews, selections, true);
	const workspaceLineage = "repair-workspace", workspaceRequests: Array<Record<string, unknown>> = [];
	await __testing.executeReviewControllerOperation({ operation: "repair", lineageId: workspaceLineage }, cwd, { targetStatus: async (request: Record<string, unknown>) => { workspaceRequests.push(request); return status(workspaceLineage); } } as unknown as NativeReviewCli, undefined, candidateViews);
	assert.deepEqual({ outcome: result.outcome, routes: selections.size, selectors: requests.map(({ cwd: requestCwd, lineageId: id, baseRef, committedOnly }) => ({ cwd: requestCwd, lineageId: id, baseRef, committedOnly })) }, { outcome: "native-capture-outcome-unknown", routes: 0, selectors: Array.from({ length: 3 }, () => ({ cwd, lineageId, baseRef: frozenTarget.baseCommit, committedOnly: true })) });
	assert.deepEqual(workspaceRequests, [{ cwd, lineageId: workspaceLineage }]);
});

test("selectorless STATUS resumes a retained committed correction lineage", async (t) => {
	const candidateViews = new CandidateViewRegistry();
	t.after(() => candidateViews.cleanupAll());
	const cwd = repository(t);
	const lineageId = "retained-committed-correction";
	const view = candidateViews.create({
		contributorRoot: cwd,
		baseRef: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
		committedOnly: true,
	});
	candidateViews.retain(view.token, lineageId);
	const frozenTarget = candidateViews.resolveProjection(lineageId, cwd);
	const requests: Array<Record<string, unknown>> = [];
	const selections = new Map();
	let captures = 0;
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return status(lineageId, [correctionPlanInput(lineageId)], "correction_required");
		},
		captureCorrectionPlan: async () => {
			captures += 1;
			return { schema: "gentle-ai.review-last-event-closure/v1", operation: "review.capture-correction-plan", lineageId, state: "correction_required", storeRevision: SHA };
		},
	} as unknown as NativeReviewCli;

	const listed = await __testing.executeReviewControllerOperation({ operation: "status", lineageId }, cwd, native, undefined, candidateViews, undefined, selections);
	const captured = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: bindingOf(listed), correctionLines: 1 }, cwd, native, undefined, candidateViews, selections, true);

	assert.equal(captured.outcome, "native-last-event-closure");
	assert.equal(captures, 1);
	assert.deepEqual(requests, Array.from({ length: 2 }, () => ({ cwd, lineageId, agent: "pi", baseRef: frozenTarget.baseCommit, committedOnly: true })));
});

test("selectorless STATUS uses a retained committed selector only at its retained workspace", async (t) => {
	const candidateViews = new CandidateViewRegistry();
	t.after(() => candidateViews.cleanupAll());
	const retainedRoot = repository(t);
	const otherRoot = repository(t);
	const lineageId = "retained-selector-boundary";
	const view = candidateViews.create({
		contributorRoot: retainedRoot,
		baseRef: execFileSync("git", ["rev-parse", "HEAD"], { cwd: retainedRoot, encoding: "utf8" }).trim(),
		committedOnly: true,
	});
	candidateViews.retain(view.token, lineageId);
	const frozenTarget = candidateViews.resolveProjection(lineageId, retainedRoot);
	const requests: Array<Record<string, unknown>> = [];
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return status(String(request.lineageId ?? "unretained"));
		},
	} as unknown as NativeReviewCli;

	await __testing.executeReviewControllerOperation({ operation: "status", lineageId, input: JSON.stringify({ baseRef: "explicit-base", committedOnly: true }) }, retainedRoot, native, undefined, candidateViews);
	await __testing.executeReviewControllerOperation({ operation: "status", lineageId: "unretained" }, retainedRoot, native, undefined, candidateViews);
	await __testing.executeReviewControllerOperation({ operation: "status", lineageId }, otherRoot, native, undefined, candidateViews);

	assert.deepEqual(requests, [
		{ cwd: retainedRoot, lineageId, agent: "pi", baseRef: "explicit-base", committedOnly: true },
		{ cwd: retainedRoot, lineageId: "unretained", agent: "pi" },
		{ cwd: retainedRoot, lineageId, agent: "pi", baseRef: frozenTarget.baseCommit, committedOnly: true },
	]);
});

test("STATUS preserves retained intended-untracked selection through selectorless same-lineage replacement collection", async () => {
	const cwd = process.cwd();
	const lineageId = "selectorless-replacement";
	const selectedUntracked = {
		untrackedScope: "select",
		expectedUntrackedInventory: "inventory-sha256",
		intendedUntracked: ["generated/report.json"],
	};
	const initial = correctionPlanInput(lineageId);
	const replacement: ReviewCollectInputV3 = {
		...correctionPlanInput(lineageId),
		arguments: [
			...correctionPlanInput(lineageId).arguments,
			{ name: "replacement", value: "b", token: "--replacement=b" },
		],
	};
	const selections = new Map();
	const requests: Array<Record<string, unknown>> = [];
	let captures = 0;
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return "baseRef" in request
				? status(lineageId, [])
				: status(lineageId, [requests.length === 1 ? initial : replacement]);
		},
		captureCorrectionPlan: async ({ correctionLines, cwd: captureCwd }: { correctionLines: number; cwd: string }) => {
			captures += 1;
			assert.deepEqual({ correctionLines, cwd: captureCwd }, { correctionLines: 1, cwd });
			return { schema: "gentle-ai.review-last-event-closure/v1", operation: "review.capture-correction-plan", lineageId, state: "correction_required", storeRevision: SHA };
		},
	} as unknown as NativeReviewCli;

	const initialStatus = await __testing.executeReviewControllerOperation(
		{ operation: "status", lineageId, input: JSON.stringify(selectedUntracked) },
		cwd,
		native,
		undefined,
		undefined,
		undefined,
		selections,
	);
	assert.equal(selections.size, 2);
	await __testing.executeReviewControllerOperation(
		{ operation: "status", lineageId, input: JSON.stringify({ baseRef: "main", committedOnly: true }) },
		cwd,
		native,
		undefined,
		undefined,
		undefined,
		selections,
	);
	assert.deepEqual(requests[1], { cwd, lineageId, agent: "pi", baseRef: "main", committedOnly: true });
	assert.equal(selections.size, 1);
	const replacementStatus = await __testing.executeReviewControllerOperation(
		{ operation: "status", lineageId },
		cwd,
		native,
		undefined,
		undefined,
		undefined,
		selections,
	);
	assert.equal(selections.size, 2);
	const bindingA = bindingOf(initialStatus);
	const bindingB = bindingOf(replacementStatus);
	assert.notEqual(bindingA, bindingB);

	const stale = await __testing.executeReviewCaptureOperation(
		{ lineageId, collectBinding: bindingA, correctionLines: 1 },
		cwd,
		native,
		undefined,
		undefined,
		selections,
		true,
	);
	assert.deepEqual({ outcome: stale.outcome, requests: requests.length, captures }, { outcome: "capture-binding-rejected", requests: 3, captures: 0 });

	const captured = await __testing.executeReviewCaptureOperation(
		{ lineageId, collectBinding: bindingB, correctionLines: 1 },
		cwd,
		native,
		undefined,
		undefined,
		selections,
		true,
	);
	assert.equal(captured.outcome, "native-last-event-closure");
	assert.deepEqual(requests, [
		{ cwd, lineageId, agent: "pi", ...selectedUntracked },
		{ cwd, lineageId, agent: "pi", baseRef: "main", committedOnly: true },
		{ cwd, lineageId, agent: "pi", ...selectedUntracked },
		{ cwd, lineageId, agent: "pi", ...selectedUntracked },
	]);
	assert.equal(captures, 1);

	const override = { ...selectedUntracked, expectedUntrackedInventory: "override-inventory", intendedUntracked: ["generated/override.json"] };
	await __testing.executeReviewControllerOperation({ operation: "status", lineageId, input: JSON.stringify(override) }, cwd, native, undefined, undefined, undefined, selections);
	await __testing.executeReviewControllerOperation({ operation: "status", lineageId }, cwd, native, undefined, undefined, undefined, selections);
	assert.deepEqual(requests.slice(-2), Array.from({ length: 2 }, () => ({ cwd, lineageId, agent: "pi", ...override })));
});

test("route retention caps, rejects collisions and invalid selectors, and clears every terminal state", async () => {
	const native = { targetStatus: async (request: Record<string, unknown>) => status(String(request.lineageId)) } as unknown as NativeReviewCli;
	const selections = new Map();
	for (let index = 0; index <= 64; index += 1) await __testing.executeReviewControllerOperation({ operation: "status", lineageId: `bounded-${index}`, input: JSON.stringify({ baseRef: `base-${index}`, committedOnly: true }) }, process.cwd(), native, undefined, undefined, undefined, selections);
	const evicted = await __testing.executeReviewCaptureOperation({ lineageId: "bounded-0", collectBinding: JSON.stringify(collectInput("bounded-0")) }, process.cwd(), native, undefined, undefined, selections, true);
	const collision = new Map(), lineageId = "route-collision", input = correctionPlanInput(lineageId);
	await __testing.executeReviewControllerOperation({ operation: "status", lineageId, input: JSON.stringify({ baseRef: "base-a", committedOnly: true }) }, process.cwd(), { targetStatus: async () => status(lineageId, [input]) } as unknown as NativeReviewCli, undefined, undefined, undefined, collision);
	const rejected = await __testing.executeReviewControllerOperation({ operation: "status", lineageId, input: JSON.stringify({ baseRef: "base-b", committedOnly: true }) }, process.cwd(), { targetStatus: async () => status(lineageId, [input]) } as unknown as NativeReviewCli, undefined, undefined, undefined, collision);
	for (const state of ["invalidated", "approved", "escalated"]) {
		const routes = new Map(), id = `terminal-${state}`;
		await __testing.executeReviewControllerOperation({ operation: "status", lineageId: id, input: JSON.stringify({ baseRef: "base", committedOnly: true }) }, process.cwd(), { targetStatus: async () => status(id, [input]) } as unknown as NativeReviewCli, undefined, undefined, undefined, routes);
		await __testing.executeReviewControllerOperation({ operation: "status", lineageId: id }, process.cwd(), { targetStatus: async () => status(id, [], state) } as unknown as NativeReviewCli, undefined, undefined, undefined, routes);
		assert.equal(routes.size, 0, state);
	}
	let calls = 0;
	for (const value of [{ baseRef: "", committedOnly: true }, { committedOnly: true }, { baseRef: "base" }, { baseRef: "base", committedOnly: false }]) {
		const result = await __testing.executeReviewControllerOperation({ operation: "status", input: JSON.stringify(value) }, process.cwd(), { targetStatus: async () => { calls += 1; return status("unreachable"); } } as unknown as NativeReviewCli);
		assert.equal(result.outcome, "native-status-input-invalid");
	}
	assert.deepEqual({ routes: selections.size, evicted: evicted.outcome, collision: rejected.outcome, calls }, { routes: 64, evicted: "capture-binding-rejected", collision: "capture-route-registration-rejected", calls: 0 });
});

test("public INSPECT and STATUS publish the exact pi-bound binding that capture revalidates", async () => {
	const lineageId = "pi-bound-public-binding";
	const agentlessInput = collectInput(lineageId);
	const piBoundInput: ReviewCollectInputV3 = {
		...agentlessInput,
		arguments: [
			...agentlessInput.arguments,
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "materialize", value: "true", token: "--materialize=true" },
		],
		submission: {
			...agentlessInput.submission!,
			argumentTokens: [
				...agentlessInput.submission!.argumentTokens.slice(0, -1),
				"--agent=pi",
				"--materialize=true",
				"--input={{value}}",
			],
			values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: 9 }],
		},
	};
	const agentlessStatus = status(lineageId);
	agentlessStatus.nextTransition = {
		kind: "collect",
		reasonCode: "capture_required",
		collect: { inputs: [agentlessInput] },
	};
	const piBoundStatus = status(lineageId);
	piBoundStatus.nextTransition = {
		kind: "collect",
		reasonCode: "capture_required",
		collect: { inputs: [piBoundInput] },
	};
	const requests: Array<{ agent?: string; lineageId?: string }> = [];
	const native = {
		targetStatus: async (request: { agent?: string; lineageId?: string }) => {
			requests.push(request);
			return request.agent === "pi" ? piBoundStatus : agentlessStatus;
		},
	} as unknown as NativeReviewCli;

	const publicStatus = await __testing.executeReviewControllerOperation(
		{ operation: "status", lineageId },
		process.cwd(),
		native,
	);
	const statusBinding = (publicStatus.collectBindings as readonly { collectBinding: string }[])[0]!.collectBinding;
	assert.deepEqual(JSON.parse(statusBinding), piBoundInput);

	const publicInspect = await __testing.executeReviewControllerOperation(
		{ operation: "inspect" },
		process.cwd(),
		native,
	);
	const inspectBinding = (publicInspect.collectBindings as readonly { collectBinding: string }[])[0]!.collectBinding;
	assert.deepEqual(JSON.parse(inspectBinding), piBoundInput);

	const publicStart = await __testing.executeReviewControllerOperation(
		{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
		process.cwd(),
		native,
	);
	const startBinding = (publicStart.collectBindings as readonly { collectBinding: string }[])[0]!.collectBinding;
	assert.deepEqual(JSON.parse(startBinding), piBoundInput);

	const forecast = await __testing.executeReviewCaptureOperation(
		{ lineageId, collectBinding: statusBinding },
		process.cwd(),
		native,
	);
	assert.equal(forecast.outcome, "reviewer-model-run-forecast");
	assert.deepEqual(requests.map((request) => request.agent), ["pi", "pi", "pi", "pi"]);
	assert.deepEqual(requests.map((request) => request.lineageId), [lineageId, undefined, undefined, lineageId]);
});

function repository(t: test.TestContext): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-native-routing-")));
	t.after(() => {
		execFileSync("chmod", ["-R", "u+rwx", cwd], { stdio: "ignore" });
		chmodSync(cwd, 0o700);
		rmSync(cwd, { recursive: true, force: true });
	});
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "tracked.txt"), "base\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Routing Test", "-c", "user.email=routing@example.invalid", "commit", "-m", "base"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "tracked.txt"), "candidate\n");
	return cwd;
}

test("candidate lifecycle sweeps startup and cleans every shutdown including reload", async (t) => {
	const cwd = repository(t);
	for (const key of ["HOME", "GENTLE_PI_AGENT_HOME", "PI_CODING_AGENT_DIR", "GENTLE_PI_CONFIG_HOME", "GENTLE_PI_GENTLE_AI_DEV_BINARY"]) {
		const previous = process.env[key];
		process.env[key] = key === "GENTLE_PI_GENTLE_AI_DEV_BINARY" ? "" : join(cwd, key);
		if (process.env[key]) mkdirSync(process.env[key]!, { recursive: true });
		t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
	}
	t.mock.method(os, "homedir", () => join(cwd, "HOME"));
	const homeAgent = join(cwd, "HOME", ".agents", "isolation-probe.md");
	mkdirSync(dirname(homeAgent), { recursive: true });
	writeFileSync(homeAgent, "---\nname: isolation-probe\ndescription: Fixture\n---\n");
	writeFileSync(join(cwd, "GENTLE_PI_CONFIG_HOME", "models.json"), JSON.stringify({ "isolation-probe": { model: "fixture/model" } }));
	t.diagnostic(`startup routing: cwd=${cwd}; HOME, GENTLE_PI_AGENT_HOME, PI_CODING_AGENT_DIR, GENTLE_PI_CONFIG_HOME are same-named children; dev-binary override disabled`);
	const calls: string[] = [];
	const destinations: string[] = [];
	const violations: string[] = [];
	const discovery: string[] = [];
	const assets = resolve("assets");
	const inside = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);
	const originalExists = fs.existsSync;
	const originalRealpath = fs.realpathSync;
	// Install guards BEFORE startup, including RED: a swallowed startup error
	// must never hide an attempted external write or read real-home contents.
	for (const [module, names] of [
		[fs, ["existsSync", "lstatSync", "readdirSync", "readFileSync", "mkdirSync", "writeFileSync", "rmSync"]],
		[fsp, ["access", "readdir", "readFile", "mkdir", "writeFile"]],
	] as const) {
		for (const name of names) {
			const original = (module as any)[name];
			t.mock.method(module as any, name, (value: string, ...args: unknown[]) => {
				const path = resolve(value);
				const writes = /^(mkdir|writeFile|rm)/.test(name);
				const allowed = inside(cwd, path) || (!writes && inside(assets, path));
				if (!allowed && name === "existsSync") return false;
				if (!allowed && ["access", "readdir"].includes(name)) return Promise.reject(Object.assign(new Error("fixture discovery boundary"), { code: "ENOENT" }));
				if (!allowed) { violations.push(`${name}:${path}`); throw new Error("fixture filesystem boundary"); }
				if (writes) {
					let ancestor = path;
					while (!originalExists(ancestor)) ancestor = dirname(ancestor);
					assert.ok(inside(cwd, originalRealpath(ancestor)), "write ancestor escaped fixture");
					destinations.push(path);
				}
				if (name.startsWith("readdir")) discovery.push(path);
				return original(value, ...args);
			});
		}
	}
	syncBuiltinESMExports();
	// Prove the guard refuses an escape without performing the attempted write.
	const escape = join(cwd, "..", "startup-isolation-escape");
	assert.throws(() => fs.writeFileSync(escape, "blocked"), /fixture filesystem boundary/);
	assert.deepEqual(violations, [`writeFileSync:${escape}`]);
	violations.length = 0;
	const hooks = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const registry = new CandidateViewRegistry();
	t.mock.method(registry, "sweepOrphans", (root: string) => { assert.equal(root, cwd); calls.push("sweep"); });
	t.mock.method(registry, "cleanupAll", () => { calls.push("cleanup"); });
	createGentleAiExtension({ nativeReviewCli: null, candidateViews: registry, processEnv: {} })({
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			hooks.set(name, [...(hooks.get(name) ?? []), handler]);
		},
		registerTool() {}, registerCommand() {},
	} as unknown as ExtensionAPI);
	try {
		assert.equal(hooks.get("session_start")?.length, 1);
		await hooks.get("session_start")![0]!({ reason: "startup" }, reviewContext(cwd));
		assert.deepEqual(violations, []);
		assert.ok(destinations.length > 0, "startup must actually write fixture assets");
		assert.ok(discovery.includes(join(cwd, "HOME", ".agents")), "home agent discovery must use the fixture");
		assert.equal(existsSync(join(cwd, "GENTLE_PI_AGENT_HOME", "gentle-ai", "managed-assets.json")), true);
		assert.match(readFileSync(homeAgent, "utf8"), /model: fixture\/model/);
		assert.ok(destinations.includes(homeAgent), "the discovered fixture agent must actually receive routing");
		assert.ok(destinations.includes(join(cwd, "GENTLE_PI_AGENT_HOME", "subagents.json")));
		t.diagnostic(`confined startup: ${destinations.length} filesystem mutations; fixture home-agent routing and managed-assets manifest verified; external violations=0`);
		assert.deepEqual(calls, ["sweep"]);
	} finally {
		// Restore only mocks before fixture teardown; never clean external paths.
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
	t.mock.method(registry, "cleanupAll", () => { calls.push("cleanup"); });
	for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
		for (const hook of hooks.get("session_shutdown")!) await hook({ reason }, reviewContext(cwd));
	}
	assert.deepEqual(calls, ["sweep", ...Array(5).fill("cleanup")]);
});

interface RegisteredControllerTool {
	execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ details?: unknown }>;
}

function reviewRuntime(nativeReviewCli: NativeReviewCli, candidateViews: CandidateViewRegistry) {
	const tools = new Map<string, RegisteredControllerTool>();
	let toolCall: ((event: { toolName: string; input: unknown }, ctx: ExtensionContext) => Promise<unknown>) | undefined;
	let sessionShutdown: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
	createGentleAiExtension({ nativeReviewCli, candidateViews })({
		on(name: string, handler: (event: { toolName: string; input: unknown }, ctx: ExtensionContext) => Promise<unknown>) {
			if (name === "tool_call") toolCall = handler;
			if (name === "session_shutdown") sessionShutdown = handler as unknown as (event: unknown, ctx: ExtensionContext) => unknown;
		},
		registerTool(definition: RegisteredControllerTool & { name: string }) { tools.set(definition.name, definition); },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	const controller = tools.get("gentle_review");
	const capture = tools.get("gentle_review_capture");
	assert.ok(controller);
	assert.ok(capture);
	assert.ok(toolCall);
	assert.ok(sessionShutdown);
	return { controller, capture, toolCall, sessionShutdown };
}

function reviewContext(cwd: string): ExtensionContext {
	return { cwd, hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext;
}

function startStatus(cwd: string, baseRef?: string, intendedUntracked: readonly string[] = []): ReviewStatusV3 {
	const candidateViews = new CandidateViewRegistry();
	const view = candidateViews.create({ contributorRoot: cwd, intendedUntracked, ...(baseRef === undefined ? {} : { baseRef, committedOnly: true }) });
	try {
		return {
			contract: "gentle-ai.review-integration/v2",
			applicability: "unrelated",
			action: "start",
			replayability: "not_replayable",
			targetIdentity: SHA,
			projection: {
				schema: "gentle-ai.review-candidate-projection/v1",
				kind: "current-changes",
				projection: "workspace",
				baseTree: view.baseTree,
				initialReviewTree: view.candidateTree,
				currentCandidateTree: view.candidateTree,
				pathsDigest: SHA,
				paths: [...view.paths],
				intendedUntracked: [...intendedUntracked],
				intendedUntrackedProof: SHA,
				initialSnapshotIdentity: SHA,
				currentSnapshotIdentity: SHA,
			},
			candidates: [],
			raw: { schema: "gentle-ai.review-integration.status/v5" },
		} as unknown as ReviewStatusV3;
	} finally {
		candidateViews.cleanup(view.token);
	}
}

test("ordinary START binds the native workspace candidate and returns the native result", async (t) => {
	const cwd = repository(t);
	const target = startStatus(cwd);
	let targetCalls = 0;
	let startCalls = 0;
	const native = {
		targetStatus: async (request: { cwd: string }) => {
			targetCalls += 1;
			assert.equal(request.cwd, cwd);
			return target;
		},
		start: async (request: { targetIdentity?: string }) => {
			startCalls += 1;
			assert.equal(request.targetIdentity, SHA);
			return { lineageId: "review-started", state: "reviewing", riskLevel: "low", selectedLenses: [], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false, riskReasons: [], raw: {} };
		},
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native);
	assert.equal(result.operation, "start");
	assert.equal(targetCalls, 1);
	assert.equal(startCalls, 1);
});

test("ordinary START materializes an excluded-untracked candidate exactly once before native START", async (t) => {
	const cwd = repository(t);
	writeFileSync(join(cwd, "unrelated.md"), "not part of the review\n");
	const target = startStatus(cwd, undefined, []);
	const candidateViews = new CandidateViewRegistry();
	t.after(() => candidateViews.cleanupAll());
	const creation = t.mock.method(candidateViews, "createOrReuse");
	let startCalls = 0;
	const native = {
		targetStatus: async () => target,
		start: async () => {
			startCalls += 1;
			return { lineageId: "excluded-untracked-start", state: "reviewing", riskLevel: "low", selectedLenses: [], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false, riskReasons: [], raw: {} };
		},
	} as unknown as NativeReviewCli;

	const result = await __testing.executeReviewControllerOperation(
		{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
		cwd, native, undefined, candidateViews,
	);

	assert.equal(result.operation, "start");
	assert.equal(creation.mock.callCount(), 1);
	assert.deepEqual(creation.mock.calls[0]!.arguments[0].intendedUntracked, []);
	assert.equal(startCalls, 1);
});

test("ordinary START adopts the offered committed-range base while an untracked selection is in play", async (t) => {
	// Live-reproduced blocker (gentle-pi#874): the committed-range adoption was
	// skipped whenever an untracked selection was in play, so the provider's
	// base-diff projection was compared against a base-less candidate view and
	// assertNativeStartCandidateBinding failed with
	// candidate-target-projection-drift before native START ever ran. An in-play
	// selection must still pay the second read-only STATUS and materialize the
	// candidate view WITH the offered base.
	const cwd = repository(t);
	// Commit the candidate change so a real committed range exists: the offered
	// base commit's tree is the projection baseTree and the committed changed
	// path is the candidate scope.
	execFileSync("git", ["add", "tracked.txt"], { cwd });
	execFileSync("git", ["-c", "user.name=Routing Test", "-c", "user.email=routing@example.invalid", "commit", "-m", "candidate"], { cwd });
	const baseRef = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd, encoding: "utf8" }).trim();
	const selection = { untrackedScope: "exclude", expectedUntrackedInventory: "inventory-sha256", intendedUntracked: [] as string[] };
	const offered = startStatus(cwd);
	offered.nextTransition = {
		kind: "execute",
		reasonCode: "start_required",
		execute: {
			operation: "review.start",
			arguments: [{ name: "base-ref", value: baseRef }, { name: "committed-only", value: "true" }],
			preconditions: [],
			binding: {},
		},
	} as unknown as ReviewStatusV3["nextTransition"];
	const adopted = startStatus(cwd, baseRef, []);
	const requests: Array<Record<string, unknown>> = [];
	const candidateViews = new CandidateViewRegistry();
	t.after(() => candidateViews.cleanupAll());
	const creation = t.mock.method(candidateViews, "createOrReuse");
	let startCalls = 0;
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return requests.length === 1 ? offered : adopted;
		},
		start: async () => {
			startCalls += 1;
			return { lineageId: "adopted-base-untracked", state: "reviewing", riskLevel: "low", selectedLenses: [], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false, riskReasons: [], raw: {} };
		},
	} as unknown as NativeReviewCli;

	const result = await __testing.executeReviewControllerOperation(
		{ operation: "start", input: JSON.stringify({ mode: "ordinary", ...selection }) },
		cwd, native, undefined, candidateViews,
	);

	assert.equal(result.operation, "start");
	assert.deepEqual(requests, [
		{ cwd, agent: "pi", ...selection },
		{ cwd, agent: "pi", baseRef, committedOnly: true, ...selection },
	]);
	assert.equal(creation.mock.callCount(), 1);
	assert.equal(creation.mock.calls[0]!.arguments[0].baseRef, baseRef, "the candidate view adopts the offered base");
	assert.equal(startCalls, 1, "native START is reached exactly once without drift");
});

test("ordinary START preserves sanitized foreign diagnostics through one ambiguous reconciliation", async (t) => {
	const cwd = repository(t);
	const target = startStatus(cwd);
	let targetCalls = 0;
	let startCalls = 0;
	const native = {
		targetStatus: async () => {
			targetCalls += 1;
			return target;
		},
		start: async () => {
			startCalls += 1;
			throw {
				name: "NativeReviewCliError",
				code: NATIVE_REVIEW_ERROR_CODE.NON_ZERO,
				mutationOutcome: "unknown",
				nextAction: "review.status",
				diagnostics: {
					operation: "review/start",
					error_code: NATIVE_REVIEW_ERROR_CODE.NON_ZERO,
					exit_code: 1,
					timed_out: false,
					output_limit_exceeded: false,
					stderr: "token=secret",
				},
			};
		},
	} as unknown as NativeReviewCli;

	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native);
	assert.equal(result.outcome, "native-mutation-status-reconciled");
	assert.equal(result.mutation_outcome, "unknown");
	assert.deepEqual(result.diagnostics, {
		operation: "review/start",
		error_code: NATIVE_REVIEW_ERROR_CODE.NON_ZERO,
		exit_code: 1,
		timed_out: false,
		output_limit_exceeded: false,
		stderr: "token=[REDACTED]",
	});
	assert.match(String(result.required_status_action), /Run target-scoped review\.status/);
	assert.equal(result.next_action, "start");
	assert.equal(targetCalls, 2, "START failure reconciles STATUS exactly once");
	assert.equal(startCalls, 1, "reconciliation never replays START");
});

test("ambiguous START reconciliation preserves the provider-selected recovery directive", async (t) => {
	const cwd = repository(t), recoveryStatus = status("recovery-lineage");
	recoveryStatus.action = "recover";
	recoveryStatus.actionDisposition = "escalated";
	recoveryStatus.nextTransition = { kind: "stop", reasonCode: "manual_intervention_required" };
	let targetCalls = 0, startCalls = 0;
	const native = {
		targetStatus: async () => {
			targetCalls += 1;
			return targetCalls === 1 ? startStatus(cwd) : recoveryStatus;
		},
		start: async () => {
			startCalls += 1;
			throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, "review/start", true, true, "unknown mutation");
		},
	} as unknown as NativeReviewCli;

	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native);
	assert.equal(result.outcome, "native-mutation-status-reconciled");
	assert.equal(result.mutation_outcome, "unknown");
	assert.equal(result.next_action, "recover-with-provider-disposition");
	assert.equal(result.required_status_action, "Use only the provider-selected recovery disposition; do not substitute scope_changed, invalidated, or escalated.");
	assert.equal(targetCalls, 2, "START failure reconciles STATUS exactly once");
	assert.equal(startCalls, 1, "reconciliation never replays START");
});

for (const statusSchema of ["gentle-ai.review-integration.status/v6", "gentle-ai.review-integration.status/v7"]) test(`pre-lineage intended-untracked selection revalidates and starts at an explicit workspace root (${statusSchema})`, async (t) => {
	const cwd = realpathSync(repository(t)), sessionCwd = repository(t), eligible = "selected.md";
	writeFileSync(join(cwd, eligible), "selected\n");
	const initialTarget = startStatus(cwd), target = startStatus(cwd, undefined, [eligible]);
	const selection: ReviewCollectInputV3 = {
		name: "intended_untracked_selection", schema: "gentle-ai.review-intended-untracked-selection/v1", captureOperation: "external.select_intended_untracked",
		arguments: [
			{ name: "target_identity", value: SHA }, { name: "projection", value: "workspace" },
			{ name: "base_tree", value: initialTarget.projection.baseTree }, { name: "candidate_tree", value: initialTarget.projection.currentCandidateTree },
			{ name: "eligible_paths_json", value: JSON.stringify([eligible]) }, { name: "expected_untracked_inventory", value: SHA },
		],
		submission: { operationToken: "status", argumentTokens: ["--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", "--intended-untracked-selection={{value}}"], values: [{ slot: "intended_untracked_selection", domain: "schema_bound_json", schema: "gentle-ai.review-intended-untracked-selection/v1", substitutionLocation: 4 }] },
	};
	const initial = { ...initialTarget, nextTransition: { kind: "collect", reasonCode: "intended_untracked_selection_required", collect: { inputs: [selection] } }, raw: { schema: statusSchema } } as ReviewStatusV3;
	const requests: Array<Record<string, unknown>> = [], starts: Array<Record<string, unknown>> = [], retained = new Map();
	const native = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "on", effective: "on", source: "clone_local" } }),
		targetStatus: async (request: Record<string, unknown>) => { requests.push(request); return "intendedUntrackedSelection" in request ? target : initial; },
		start: async (request: Record<string, unknown>) => { assert.equal(retained.size, 0); starts.push(request); return { lineageId: "selected", state: "reviewing", riskLevel: "low", selectedLenses: [], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false, riskReasons: [], raw: {} }; },
	} as unknown as NativeReviewCli;
	const listed = await __testing.executeReviewControllerOperation({ operation: "status", workspaceRoot: cwd }, sessionCwd, native, undefined, undefined, undefined, retained);
	const selectionBinding = listed.selectionBinding as string;
	assert.equal(typeof selectionBinding, "string");
	const selectedResult = await __testing.executeReviewControllerOperation({ operation: "select-intended-untracked", selectionBinding, intendedUntracked: [eligible], workspaceRoot: cwd } as never, sessionCwd, native, undefined, undefined, undefined, retained);
	assert.equal(starts.length, 1, JSON.stringify(selectedResult));
	assert.deepEqual(requests.map((request) => request.cwd), [cwd, cwd, cwd]);
	assert.equal(starts[0]!.cwd, cwd);
	assert.deepEqual(starts[0]!.intendedUntrackedSelection, { argumentTokens: selection.submission!.argumentTokens, value: JSON.stringify({ schema: "gentle-ai.review-intended-untracked-selection/v1", untracked_scope: "select", expected_untracked_inventory: SHA, intended_untracked: [eligible] }) });
	for (const invalid of [
		{ selectionBinding: selectionBinding.replace(eligible, "docs/stale.md"), intendedUntracked: [eligible] },
		{ selectionBinding, intendedUntracked: [eligible, eligible] }, { selectionBinding, intendedUntracked: ["docs/unknown.md"] },
	]) {
		const rejection = await __testing.executeReviewControllerOperation({ operation: "select-intended-untracked", ...invalid } as never, cwd, native, undefined, undefined, undefined, retained);
		assert.equal(rejection.status, "blocked", JSON.stringify(invalid));
		assert.equal(rejection.outcome, "intended-untracked-selection-binding-rejected", JSON.stringify(invalid));
		assert.equal(rejection.mutation_performed, false, JSON.stringify(invalid));
		assert.equal(rejection.mutation_outcome, "none", JSON.stringify(invalid));
	}
	await assert.rejects(() => __testing.executeReviewControllerOperation({ operation: "select-intended-untracked", selectionBinding, intendedUntracked: [eligible], input: "{}" } as never, cwd, native, undefined, undefined, undefined, retained), /exactly selectionBinding/);
	assert.equal(starts.length, 1);
	assert.equal(requests.every((request) => !("lineageId" in request)), true);
});

test("committed-range inspect stop carries its binding selector into selection STATUS and START, rejecting a mismatched binding", async (t) => {
	const { cwd, eligible, selection } = untrackedStopFixture(t);
	const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	const initialTarget = startStatus(cwd, baseRef), target = startStatus(cwd, baseRef, [eligible]);
	const boundSelection = { ...selection, arguments: selection.arguments.map((arg) => arg.name === "base_tree" ? { ...arg, value: initialTarget.projection.baseTree } : arg.name === "candidate_tree" ? { ...arg, value: initialTarget.projection.currentCandidateTree } : arg) };
	const initial = { ...initialTarget, nextTransition: { kind: "collect", reasonCode: "intended_untracked_selection_required", collect: { inputs: [boundSelection] } }, raw: { schema: "gentle-ai.review-integration.status/v7" } } as ReviewStatusV3;
	const requests: Array<Record<string, unknown>> = [], starts: Array<Record<string, unknown>> = [], retained = new Map();
	const native = {
		targetStatus: async (request: Record<string, unknown>) => { requests.push(request); return "intendedUntrackedSelection" in request ? target : initial; },
		start: async (request: Record<string, unknown>) => { starts.push(request); return { lineageId: "review-selected", state: "reviewing", riskLevel: "low", selectedLenses: [], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false, riskReasons: [], raw: {} }; },
	} as unknown as NativeReviewCli;
	const inspected = await __testing.executeReviewControllerOperation({ operation: "inspect", input: JSON.stringify({ baseRef: "HEAD", committedOnly: true }) }, cwd, native, undefined, undefined, undefined, retained);
	assert.equal(typeof inspected.selectionBinding, "string");
	assert.equal(retained.has(`${cwd}\u0000`), true, "plain inspect stop retains its selector");
	const mismatch = await __testing.executeReviewControllerOperation({ operation: "select-intended-untracked", selectionBinding: (inspected.selectionBinding as string).replace(eligible, "other.md"), intendedUntracked: [eligible] }, cwd, native, undefined, undefined, undefined, retained);
	assert.equal(mismatch.outcome, "intended-untracked-selection-binding-rejected");
	assert.equal(requests.length, 1, "mismatched binding must not request another STATUS");
	assert.equal(starts.length, 0);
	const selected = await __testing.executeReviewControllerOperation({ operation: "select-intended-untracked", selectionBinding: inspected.selectionBinding, intendedUntracked: [eligible] }, cwd, native, undefined, undefined, undefined, retained);
	assert.equal(selected.operation, "select-intended-untracked");
	assert.equal(starts.length, 1, JSON.stringify(selected));
	assert.equal(requests.length, 3);
	for (const request of requests) { assert.equal(request.baseRef, baseRef); assert.equal(request.committedOnly, true); }
	assert.equal(starts[0]!.baseRef, baseRef);
	assert.equal(starts[0]!.committedOnly, true);
});

test("committed-range selection rejects target-identity drift before START", async (t) => {
	const { cwd, eligible, selection } = untrackedStopFixture(t);
	const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	const initialTarget = startStatus(cwd, baseRef);
	const boundSelection = { ...selection, arguments: selection.arguments.map((arg) => arg.name === "base_tree" ? { ...arg, value: initialTarget.projection.baseTree } : arg.name === "candidate_tree" ? { ...arg, value: initialTarget.projection.currentCandidateTree } : arg) };
	const initial = { ...initialTarget, nextTransition: { kind: "collect", reasonCode: "intended_untracked_selection_required", collect: { inputs: [boundSelection] } }, raw: { schema: "gentle-ai.review-integration.status/v7" } } as ReviewStatusV3;
	const changed = { ...initial, targetIdentity: `sha256:${"d".repeat(64)}` } as ReviewStatusV3;
	const requests: Array<Record<string, unknown>> = [];
	let starts = 0;
	const retained = new Map();
	const native = {
		targetStatus: async (request: Record<string, unknown>) => { requests.push(request); return requests.length === 1 ? initial : changed; },
		start: async () => { starts++; throw new Error("START must not run for a changed target"); },
	} as unknown as NativeReviewCli;
	const inspected = await __testing.executeReviewControllerOperation({ operation: "inspect", input: JSON.stringify({ baseRef: "HEAD", committedOnly: true }) }, cwd, native, undefined, undefined, undefined, retained);
	assert.equal(typeof inspected.selectionBinding, "string");
	const rejected = await __testing.executeReviewControllerOperation({ operation: "select-intended-untracked", selectionBinding: inspected.selectionBinding, intendedUntracked: [eligible] }, cwd, native, undefined, undefined, undefined, retained);
	assert.equal(rejected.status, "blocked");
	assert.equal(rejected.outcome, "intended-untracked-selection-binding-rejected");
	assert.equal(rejected.mutation_performed, false);
	assert.equal(rejected.mutation_outcome, "none");
	assert.equal(requests.length, 2);
	assert.equal(requests[1]!.baseRef, baseRef);
	assert.equal(requests[1]!.committedOnly, true);
	assert.equal(starts, 0);
});

// gentle-pi#706: inspect names the exact continuation for the intended-untracked
// stop and can resolve it in one call through top-level untrackedScope.
function untrackedStopFixture(
	t: test.TestContext,
	statusSchema = "gentle-ai.review-integration.status/v7",
): {
	cwd: string;
	eligible: string;
	initial: ReviewStatusV3;
	target: ReviewStatusV3;
	selection: ReviewCollectInputV3;
} {
	const cwd = repository(t),
		eligible = "selected.md";
	writeFileSync(join(cwd, eligible), "selected\n");
	const initialTarget = startStatus(cwd),
		target = startStatus(cwd, undefined, [eligible]);
	const selection: ReviewCollectInputV3 = {
		name: "intended_untracked_selection",
		schema: "gentle-ai.review-intended-untracked-selection/v1",
		captureOperation: "external.select_intended_untracked",
		arguments: [
			{ name: "target_identity", value: SHA },
			{ name: "projection", value: "workspace" },
			{ name: "base_tree", value: initialTarget.projection.baseTree },
			{
				name: "candidate_tree",
				value: initialTarget.projection.currentCandidateTree,
			},
			{ name: "eligible_paths_json", value: JSON.stringify([eligible]) },
			{ name: "expected_untracked_inventory", value: SHA },
		],
		submission: {
			operationToken: "status",
			argumentTokens: [
				"--contract=gentle-ai.review-integration/v2",
				"--next-transition=true",
				"--agent=pi",
				"--projection=workspace",
				"--intended-untracked-selection={{value}}",
			],
			values: [
				{
					slot: "intended_untracked_selection",
					domain: "schema_bound_json",
					schema: "gentle-ai.review-intended-untracked-selection/v1",
					substitutionLocation: 4,
				},
			],
		},
	};
	const initial = {
		...initialTarget,
		nextTransition: {
			kind: "collect",
			reasonCode: "intended_untracked_selection_required",
			collect: { inputs: [selection] },
		},
		raw: { schema: statusSchema },
	} as ReviewStatusV3;
	return { cwd, eligible, initial, target, selection };
}

for (const statusSchema of [
	"gentle-ai.review-integration.status/v6",
	"gentle-ai.review-integration.status/v7",
])
	test(`inspect on the intended-untracked stop returns nextStep and the selection binding (${statusSchema})`, async (t) => {
		const { cwd, initial } = untrackedStopFixture(t, statusSchema);
		let targetCalls = 0;
		const native = {
			targetStatus: async () => {
				targetCalls += 1;
				return initial;
			},
		} as unknown as NativeReviewCli;
		const result = await __testing.executeReviewControllerOperation(
			{ operation: "inspect" },
			cwd,
			native,
		);
		assert.equal(result.status, "blocked");
		assert.equal(typeof result.selectionBinding, "string");
		assert.equal(typeof result.nextStep, "string");
		for (const fragment of [
			"select-intended-untracked",
			"untrackedScope",
			".gitignore",
			"path names",
		]) {
			assert.equal((result.nextStep as string).includes(fragment), true, fragment);
		}
		assert.equal(targetCalls, 1);
	});

test("inspect with untrackedScope exclude resolves the intended-untracked stop in one round trip", async (t) => {
	const { cwd, initial, target, selection } = untrackedStopFixture(t);
	const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	const requests: Array<Record<string, unknown>> = [],
		retained = new Map();
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return "intendedUntrackedSelection" in request ? target : initial;
		},
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation(
		{
			operation: "inspect",
			input: JSON.stringify({ baseRef: "HEAD", committedOnly: true }),
			untrackedScope: "exclude",
		},
		cwd,
		native,
		undefined,
		undefined,
		undefined,
		retained,
	);
	assert.equal(result.status, "ready");
	assert.equal("selectionBinding" in result, false);
	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.equal(request.baseRef, baseRef);
		assert.equal(request.committedOnly, true);
	}
	assert.equal(requests[1]!.untrackedScope, "exclude");
	assert.equal(requests[1]!.expectedUntrackedInventory, SHA);
	assert.deepEqual(requests[1]!.intendedUntracked, []);
	assert.deepEqual(requests[1]!.intendedUntrackedSelection, {
		argumentTokens: selection.submission!.argumentTokens,
		value: JSON.stringify({
			schema: "gentle-ai.review-intended-untracked-selection/v1",
			untracked_scope: "exclude",
			expected_untracked_inventory: SHA,
			intended_untracked: [],
		}),
	});
	const retainedEntry = retained.get(`${cwd}\u0000`) as
		| { untrackedScope: string; submission?: unknown }
		| undefined;
	assert.notEqual(retainedEntry, undefined);
	assert.equal(retainedEntry!.untrackedScope, "exclude");
	assert.notEqual(retainedEntry!.submission, undefined);
});

test("inspect with untrackedScope select resolves the stop with exactly the selected paths", async (t) => {
	const { cwd, eligible, initial, target } = untrackedStopFixture(t);
	const requests: Array<Record<string, unknown>> = [];
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return "intendedUntrackedSelection" in request ? target : initial;
		},
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation(
		{
			operation: "inspect",
			untrackedScope: "select",
			intendedUntracked: [eligible],
		},
		cwd,
		native,
	);
	assert.equal(result.status, "ready");
	assert.equal(requests.length, 2);
	assert.equal(requests[1]!.untrackedScope, "select");
	assert.deepEqual(requests[1]!.intendedUntracked, [eligible]);
	const submission = requests[1]!.intendedUntrackedSelection as {
		value: string;
	};
	assert.deepEqual(JSON.parse(submission.value), {
		schema: "gentle-ai.review-intended-untracked-selection/v1",
		untracked_scope: "select",
		expected_untracked_inventory: SHA,
		intended_untracked: [eligible],
	});
});

test("inspect with untrackedScope select rejects a path outside the eligible inventory", async (t) => {
	const { cwd, initial } = untrackedStopFixture(t);
	let targetCalls = 0;
	const native = {
		targetStatus: async () => {
			targetCalls += 1;
			return initial;
		},
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation(
		{
			operation: "inspect",
			untrackedScope: "select",
			intendedUntracked: ["docs/unknown.md"],
		},
		cwd,
		native,
	);
	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "inspect-untracked-scope-invalid");
	assert.equal(result.mutation_performed, false);
	assert.equal(result.mutation_outcome, "none");
	assert.equal(targetCalls, 1);
});

for (const invalid of [
	{ untrackedScope: "select" },
	{ untrackedScope: "exclude", intendedUntracked: ["selected.md"] },
] as const)
	test(`inspect rejects an inconsistent untracked scope combination (${JSON.stringify(invalid)})`, async (t) => {
		const { cwd, initial } = untrackedStopFixture(t);
		let targetCalls = 0;
		const native = {
			targetStatus: async () => {
				targetCalls += 1;
				return initial;
			},
		} as unknown as NativeReviewCli;
		if (invalid.untrackedScope === "exclude") {
			await assert.rejects(
				() => __testing.executeReviewControllerOperation({ operation: "inspect", ...invalid }, cwd, native),
				/requires untrackedScope select/,
			);
			assert.equal(targetCalls, 0);
			return;
		}
		const result = await __testing.executeReviewControllerOperation(
			{ operation: "inspect", ...invalid },
			cwd,
			native,
		);
		assert.equal(result.status, "blocked");
		assert.equal(result.outcome, "inspect-untracked-scope-invalid");
		assert.equal(result.mutation_performed, false);
		assert.equal(result.mutation_outcome, "none");
		assert.equal(targetCalls, 1);
	});

test("inspect with untrackedScope and no intended-untracked stop reports not-required", async (t) => {
	const { cwd, target } = untrackedStopFixture(t);
	let targetCalls = 0;
	const native = {
		targetStatus: async () => {
			targetCalls += 1;
			return target;
		},
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation(
		{ operation: "inspect", untrackedScope: "exclude" },
		cwd,
		native,
	);
	assert.equal(result.status, "ready");
	assert.equal(result.untracked_selection, "not-required");
	assert.equal(targetCalls, 1);
});

test("plain START adopts the pre-lineage selection retained by inspect and deletes it after success", async (t) => {
	const { cwd, eligible, initial, target, selection } = untrackedStopFixture(t);
	const requests: Array<Record<string, unknown>> = [],
		starts: Array<Record<string, unknown>> = [],
		retained = new Map();
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return "intendedUntrackedSelection" in request ? target : initial;
		},
		start: async (request: Record<string, unknown>) => {
			starts.push(request);
			return {
				lineageId: "review-started",
				state: "reviewing",
				riskLevel: "low",
				selectedLenses: [],
				changedFiles: 1,
				changedLines: 1,
				correctionBudget: 1,
				action: "created",
				lensesRequired: false,
				riskReasons: [],
				raw: {},
			};
		},
	} as unknown as NativeReviewCli;
	const resolved = await __testing.executeReviewControllerOperation(
		{
			operation: "inspect",
			untrackedScope: "select",
			intendedUntracked: [eligible],
		},
		cwd,
		native,
		undefined,
		undefined,
		undefined,
		retained,
	);
	assert.equal(resolved.status, "ready");
	const started = await __testing.executeReviewControllerOperation(
		{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
		cwd,
		native,
		undefined,
		undefined,
		undefined,
		retained,
	);
	assert.equal(started.operation, "start");
	assert.equal(started.result.lineage_id, "review-started");
	assert.equal(starts.length, 1);
	assert.equal(requests.length, 3);
	const startStatusRequest = requests[2]!;
	assert.equal(startStatusRequest.untrackedScope, "select");
	assert.equal(startStatusRequest.expectedUntrackedInventory, SHA);
	assert.deepEqual(startStatusRequest.intendedUntracked, [eligible]);
	assert.deepEqual(startStatusRequest.intendedUntrackedSelection, {
		argumentTokens: selection.submission!.argumentTokens,
		value: JSON.stringify({
			schema: "gentle-ai.review-intended-untracked-selection/v1",
			untracked_scope: "select",
			expected_untracked_inventory: SHA,
			intended_untracked: [eligible],
		}),
	});
	assert.equal(starts[0]!.untrackedScope, "select");
	assert.equal(retained.has(`${cwd}\u0000`), false);
	const lineageEntry = retained.get(`${cwd}\u0000review-started`) as
		| { untrackedScope: string; submission?: unknown }
		| undefined;
	assert.notEqual(lineageEntry, undefined);
	assert.equal(lineageEntry!.untrackedScope, "select");
	assert.notEqual(lineageEntry!.submission, undefined);
});

test("untrackedScope is accepted only by the inspect operation", async (t) => {
	const { cwd, initial } = untrackedStopFixture(t);
	const native = {
		targetStatus: async () => initial,
	} as unknown as NativeReviewCli;
	await assert.rejects(
		() =>
			__testing.executeReviewControllerOperation(
				{ operation: "status", untrackedScope: "exclude" } as never,
				cwd,
				native,
			),
		/does not accept untrackedScope/,
	);
	await assert.rejects(
		() =>
			__testing.executeReviewControllerOperation(
				{
					operation: "start",
					input: JSON.stringify({ mode: "ordinary" }),
					untrackedScope: "exclude",
				} as never,
				cwd,
				native,
			),
		/does not accept untrackedScope/,
	);
});

test("top-level intendedUntracked is accepted only by inspect select", async (t) => {
		const { cwd, initial } = untrackedStopFixture(t);
		const native = { targetStatus: async () => initial } as unknown as NativeReviewCli;
		for (const parameters of [
			{ operation: "inspect", intendedUntracked: [] },
			{ operation: "inspect", untrackedScope: "exclude", intendedUntracked: [] },
			{ operation: "status", intendedUntracked: [] },
			{ operation: "start", input: JSON.stringify({ mode: "ordinary" }), intendedUntracked: [] },
		] as const) {
			await assert.rejects(
				() => __testing.executeReviewControllerOperation(parameters as never, cwd, native),
				/intendedUntracked/,
				JSON.stringify(parameters),
			);
		}
	});

test("a fresh unsuccessful inspect invalidates its prior pre-lineage selection", async (t) => {
		const { cwd, eligible, initial, target } = untrackedStopFixture(t);
		const retained = new Map();
		let failInspect = false;
		const native = {
			targetStatus: async (request: Record<string, unknown>) => {
				if (failInspect) throw new Error("inspect unavailable");
				return "intendedUntrackedSelection" in request ? target : initial;
			},
		} as unknown as NativeReviewCli;
		await __testing.executeReviewControllerOperation(
			{ operation: "inspect", untrackedScope: "select", intendedUntracked: [eligible] },
			cwd, native, undefined, undefined, undefined, retained,
		);
		assert.equal(retained.has(`${cwd}\u0000`), true);
		failInspect = true;
		const failed = await __testing.executeReviewControllerOperation(
			{ operation: "inspect" }, cwd, native, undefined, undefined, undefined, retained,
		);
		assert.equal(failed.outcome, "native-status-unavailable");
		assert.equal(retained.has(`${cwd}\u0000`), false);
	});

// gentle-pi#1192: a committed-range inspect's retained pre-lineage selection
// must remember its own baseRef/committedOnly too, so a later plain START
// replays the same committed range instead of falling back to the
// workspace-diff one.
test("inspect with a committed-range selector retains baseRef/committedOnly, and a plain START adopts it", async (t) => {
	const cwd = repository(t), eligible = "selected.md";
	writeFileSync(join(cwd, eligible), "selected\n");
	const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	// The inspect handler carries its committed-range selector through both the
	// pre-resolution and resolution STATUS calls, so a faithful fixture for
	// this scenario must project the committed range on both, not the
	// workspace-diff range untrackedStopFixture builds.
	const initialTarget = startStatus(cwd, baseRef),
		target = startStatus(cwd, baseRef, [eligible]);
	const selection: ReviewCollectInputV3 = {
		name: "intended_untracked_selection",
		schema: "gentle-ai.review-intended-untracked-selection/v1",
		captureOperation: "external.select_intended_untracked",
		arguments: [
			{ name: "target_identity", value: SHA },
			{ name: "projection", value: "workspace" },
			{ name: "base_tree", value: initialTarget.projection.baseTree },
			{ name: "candidate_tree", value: initialTarget.projection.currentCandidateTree },
			{ name: "eligible_paths_json", value: JSON.stringify([eligible]) },
			{ name: "expected_untracked_inventory", value: SHA },
		],
		submission: {
			operationToken: "status",
			argumentTokens: [
				"--contract=gentle-ai.review-integration/v2",
				"--next-transition=true",
				"--agent=pi",
				"--projection=workspace",
				"--intended-untracked-selection={{value}}",
			],
			values: [
				{
					slot: "intended_untracked_selection",
					domain: "schema_bound_json",
					schema: "gentle-ai.review-intended-untracked-selection/v1",
					substitutionLocation: 4,
				},
			],
		},
	};
	const initial = {
		...initialTarget,
		nextTransition: {
			kind: "collect",
			reasonCode: "intended_untracked_selection_required",
			collect: { inputs: [selection] },
		},
		raw: { schema: "gentle-ai.review-integration.status/v7" },
	} as ReviewStatusV3;
	const requests: Array<Record<string, unknown>> = [],
		starts: Array<Record<string, unknown>> = [],
		retained = new Map();
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return "intendedUntrackedSelection" in request ? target : initial;
		},
		start: async (request: Record<string, unknown>) => {
			starts.push(request);
			return {
				lineageId: "review-started", state: "reviewing", riskLevel: "low", selectedLenses: [],
				changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false,
				riskReasons: [], raw: {},
			};
		},
	} as unknown as NativeReviewCli;
	const resolved = await __testing.executeReviewControllerOperation(
		{
			operation: "inspect",
			input: JSON.stringify({ baseRef: "HEAD", committedOnly: true }),
			untrackedScope: "select",
			intendedUntracked: [eligible],
		},
		cwd, native, undefined, undefined, undefined, retained,
	);
	assert.equal(resolved.status, "ready");
	const retainedEntry = retained.get(`${cwd}\u0000`) as { baseRef?: string; committedOnly?: true } | undefined;
	assert.notEqual(retainedEntry, undefined);
	assert.equal(retainedEntry!.baseRef, baseRef);
	assert.equal(retainedEntry!.committedOnly, true);

	const started = await __testing.executeReviewControllerOperation(
		{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
		cwd, native, undefined, undefined, undefined, retained,
	);
	assert.equal(started.operation, "start");
	assert.equal((started.result as { lineage_id?: string }).lineage_id, "review-started");
	assert.equal(requests.length, 3);
	const startStatusRequest = requests[2]!;
	assert.equal(startStatusRequest.baseRef, baseRef);
	assert.equal(startStatusRequest.committedOnly, true);
	assert.equal(startStatusRequest.untrackedScope, "select");
	assert.deepEqual(startStatusRequest.intendedUntrackedSelection, {
		argumentTokens: selection.submission!.argumentTokens,
		value: JSON.stringify({
			schema: "gentle-ai.review-intended-untracked-selection/v1",
			untracked_scope: "select",
			expected_untracked_inventory: SHA,
			intended_untracked: [eligible],
		}),
	});
	assert.equal(starts.length, 1);
	assert.equal(starts[0]!.baseRef, baseRef);
	assert.equal(starts[0]!.committedOnly, true);
	assert.equal(starts[0]!.untrackedScope, "select");
	assert.equal(retained.has(`${cwd}\u0000`), false);
	const lineageEntry = retained.get(`${cwd}\u0000review-started`) as { untrackedScope: string; baseRef?: string } | undefined;
	assert.notEqual(lineageEntry, undefined);
	assert.equal(lineageEntry!.untrackedScope, "select");
	// The lineage-scoped entry must stay a plain untracked selection: a
	// leftover baseRef field would make readRetainedNativeUntrackedSelection
	// mistake it for a RetainedNativeCaptureRoute.
	assert.equal("baseRef" in lineageEntry!, false);
});

test("an explicit baseRef that conflicts with a retained committed-range selector is not adopted", async (t) => {
	const { cwd, eligible, initial, target } = untrackedStopFixture(t);
	const headRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	writeFileSync(join(cwd, "tracked.txt"), "second\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Routing Test", "-c", "user.email=routing@example.invalid", "commit", "-m", "second"], { cwd, stdio: "ignore" });
	const otherRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	const readyTarget = startStatus(cwd, otherRef);
	const starts: Array<Record<string, unknown>> = [],
		retained = new Map();
	const native = {
		targetStatus: async (request: Record<string, unknown>) =>
			request.baseRef === otherRef ? readyTarget : ("intendedUntrackedSelection" in request ? target : initial),
		start: async (request: Record<string, unknown>) => {
			starts.push(request);
			return {
				lineageId: "review-started", state: "reviewing", riskLevel: "low", selectedLenses: [],
				changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false,
				riskReasons: [], raw: {},
			};
		},
	} as unknown as NativeReviewCli;
	await __testing.executeReviewControllerOperation(
		{
			operation: "inspect",
			input: JSON.stringify({ baseRef: headRef, committedOnly: true }),
			untrackedScope: "select",
			intendedUntracked: [eligible],
		},
		cwd, native, undefined, undefined, undefined, retained,
	);
	const retainedEntry = retained.get(`${cwd}\u0000`) as { baseRef?: string } | undefined;
	assert.equal(retainedEntry?.baseRef, headRef);

	const started = await __testing.executeReviewControllerOperation(
		{ operation: "start", input: JSON.stringify({ mode: "ordinary", baseRef: otherRef, committedOnly: true }) },
		cwd, native, undefined, undefined, undefined, retained,
	);
	assert.equal(started.operation, "start");
	assert.equal(starts.length, 1);
	assert.equal(starts[0]!.baseRef, otherRef);
	// The conflicting explicit START never adopts the retained scope/inventory.
	assert.equal("untrackedScope" in starts[0]!, false);
	// A successful START always clears the pre-lineage "" entry (gentle-pi#706),
	// whether or not it consumed it: a new lineage invalidates any stale
	// pre-lineage selection regardless of this START's own adoption choice.
	assert.equal(retained.has(`${cwd}\u0000`), false);
});

test("START rejects a retained pre-lineage selection when fresh STATUS identifies a changed candidate", async (t) => {
		const { cwd, eligible, initial, target } = untrackedStopFixture(t);
		const retained = new Map();
		const candidateA = {
			...target,
			targetIdentity: "target-a",
			projection: { ...target.projection, currentCandidateTree: "candidate-a" },
		} as ReviewStatusV3;
		const candidateB = {
			...target,
			targetIdentity: "target-b",
			projection: { ...target.projection, currentCandidateTree: "candidate-b" },
		} as ReviewStatusV3;
		let resolved = false;
		let starts = 0;
		const native = {
			targetStatus: async (request: Record<string, unknown>) => {
				if (!("intendedUntrackedSelection" in request)) return initial;
				if (!resolved) { resolved = true; return candidateA; }
				return candidateB;
			},
			start: async () => {
				starts += 1;
				return { lineageId: "unexpected", state: "reviewing", riskLevel: "low", selectedLenses: [], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false, riskReasons: [], raw: {} };
			},
		} as unknown as NativeReviewCli;
		await __testing.executeReviewControllerOperation(
			{ operation: "inspect", untrackedScope: "select", intendedUntracked: [eligible] },
			cwd, native, undefined, null, undefined, retained,
		);
		const rejected = await __testing.executeReviewControllerOperation(
			{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
			cwd, native, undefined, null, undefined, retained,
		);
		assert.equal(rejected.outcome, "native-start-retained-selection-candidate-mismatch");
		assert.equal(starts, 0);
		assert.equal(retained.has(`${cwd}\u0000`), false);
	});

test("a failed START retains a pre-lineage selection for a same-candidate retry", async (t) => {
		const { cwd, eligible, initial, target } = untrackedStopFixture(t);
		const retained = new Map();
		let starts = 0;
		const native = {
			targetStatus: async (request: Record<string, unknown>) =>
				"intendedUntrackedSelection" in request ? target : initial,
			start: async () => {
				starts += 1;
				if (starts === 1) throw Object.assign(new Error("retryable failure"), { mutationOutcome: "none" });
				return { lineageId: "retried", state: "reviewing", riskLevel: "low", selectedLenses: [], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false, riskReasons: [], raw: {} };
			},
		} as unknown as NativeReviewCli;
		await __testing.executeReviewControllerOperation(
			{ operation: "inspect", untrackedScope: "select", intendedUntracked: [eligible] },
			cwd, native, undefined, null, undefined, retained,
		);
		const failed = await __testing.executeReviewControllerOperation(
			{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
			cwd, native, undefined, null, undefined, retained,
		);
		assert.equal(failed.mutation_outcome, "none");
		assert.equal(retained.has(`${cwd}\u0000`), true);
		const retried = await __testing.executeReviewControllerOperation(
			{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
			cwd, native, undefined, null, undefined, retained,
		);
		assert.equal(retried.result.lineage_id, "retried");
		assert.equal(starts, 2);
		assert.equal(retained.has(`${cwd}\u0000`), false);
	});

test("ordinary START relays native consent without authoring or advancing it", async (t) => {
	const cwd = repository(t);
	const consent = decodeReviewConsentV3(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json"), "utf8")));
	const native = {
		targetStatus: async () => startStatus(cwd),
		start: async () => { throw new NativeReviewConsentRequiredError(consent); },
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native);
	assert.equal(result.outcome, "native-review-consent-required");
	assert.equal(typeof result.consent_binding, "string");
	assert.equal(result.mutation_outcome, "none");
});

test("shutdown preserves failed consent candidates without interrupting session teardown", async (t) => {
	const cwd = repository(t);
	const consent = decodeReviewConsentV3(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json"), "utf8")));
	const native = {
		targetStatus: async () => startStatus(cwd),
		start: async () => { throw new NativeReviewConsentRequiredError(consent); },
	} as unknown as NativeReviewCli;
	const registry = new CandidateViewRegistry();
	const runtime = reviewRuntime(native, registry);
	const ctx = reviewContext(cwd);
	const result = await runtime.controller.execute("pending", { operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, ctx);
	assert.equal((result.details as { outcome: string }).outcome, "native-review-consent-required");
	t.mock.method(registry, "cleanup", () => { throw new Error("fixture unsafe ownership"); });
	assert.doesNotThrow(() => runtime.sessionShutdown({ reason: "reload" }, ctx));
});

test("ordinary START obeys the review-mode kill switch before target STATUS", async () => {
	let targetCalls = 0;
	const native = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "off", effective: "off", source: "clone_local" } }),
		targetStatus: async () => { targetCalls += 1; return status("unreachable"); },
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, process.cwd(), native);
	assert.equal(result.outcome, "review-mode-disabled");
	assert.equal(targetCalls, 0);
});

test("STATUS preserves a native process failure without inventing authority recovery", async () => {
	const native = {
		targetStatus: async () => { throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.UNAVAILABLE, "review/status", false, false, "native unavailable"); },
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "status" }, process.cwd(), native);
	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "native-operation-failed");
	assert.equal(result.mutation_outcome, "none");
});

test("foreign native errors with malformed diagnostics remain untrusted", async () => {
	const native = {
		targetStatus: async () => { throw {
			name: "NativeReviewCliError",
			code: NATIVE_REVIEW_ERROR_CODE.NON_ZERO,
			diagnostics: {
				operation: "review/status",
				error_code: "forged-code",
				timed_out: false,
				output_limit_exceeded: false,
			},
		}; },
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "status" }, process.cwd(), native);
	assert.equal(result.outcome, "native-operation-failed");
	assert.equal("diagnostics" in result, false);
});

test("STATUS preserves ambiguous native status as read-only provider-owned state", async () => {
	const lineageId = "ambiguous-lineage";
	const native = {
		targetStatus: async () => ({ ...status(lineageId), applicability: "ambiguous", action: "stop" }) as ReviewStatusV3,
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "status", lineageId }, process.cwd(), native);
	assert.equal(result.operation, "status");
	assert.equal(result.status, "blocked");
	assert.deepEqual(result.result, { schema: "gentle-ai.review-integration.status/v5" });
});

test("STATUS routes an explicit workspace root to the provider and reports it", async () => {
	const cwd = process.cwd();
	const native = {
		targetStatus: async (request: { cwd: string }) => {
			assert.equal(request.cwd, cwd);
			return status("workspace-root");
		},
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "status", lineageId: "workspace-root", workspaceRoot: cwd }, cwd, native);
	assert.equal(result.workspace_root, cwd);
});

test("a public provider-role collect binding remains reachable through one native capture", async () => {
	const closureLineage = "review-61da8af1a89ff96a";
	const baseInput = collectInput(closureLineage);
	const { submission: _submission, artifactSubject: _artifactSubject, ...roleInput } = baseInput;
	void _submission;
	void _artifactSubject;
	const input = {
		...roleInput,
		name: "provider_refuter",
		schema: "https://gentle-ai.dev/schema/review/refuter/v1",
		captureOperation: "review.capture-refuter",
		arguments: [
			{ name: "lineage", value: closureLineage, token: `--lineage=${closureLineage}` },
			{ name: "target", value: SHA, token: `--target=${SHA}` },
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "execute", value: "true", token: "--execute=true" },
		],
	} as unknown as ReviewCollectInputV3;
	const roleStatus = { ...status(closureLineage), nextTransition: { kind: "collect", reasonCode: "provider_role_required", collect: { inputs: [input] } } } as ReviewStatusV3;
	let captureCalls = 0;
	const native = {
		targetStatus: async (request: { agent?: string }) => {
			assert.equal(request.agent, "pi");
			return roleStatus;
		},
		captureProviderRole: async (request: { captureOperation: string; argumentTokens: readonly string[] }) => {
			captureCalls += 1;
			assert.equal(request.captureOperation, "review.capture-refuter");
			assert.deepEqual(request.argumentTokens, [`--lineage=${closureLineage}`, `--target=${SHA}`, "--agent=pi", "--execute=true"]);
			return { schema: "gentle-ai.review-last-event-closure/v1", operation: "review.capture-refuter", lineageId: closureLineage, state: "approved", storeRevision: SHA };
		},
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewCaptureOperation({ lineageId: closureLineage, collectBinding: JSON.stringify(input) }, process.cwd(), native);
	assert.equal(result.status, "closed");
	assert.equal(result.outcome, "native-last-event-closure");
	assert.equal(captureCalls, 1);
});

test("ordinary START follows a provider reconciliation status without creating a candidate or invoking START", async () => {
	let startCalls = 0;
	const native = {
		targetStatus: async () => status("reconcile-current"),
		start: async () => { startCalls += 1; throw new Error("must not start"); },
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, process.cwd(), native);
	assert.equal(result.status, "blocked");
	assert.deepEqual(result.result, { schema: "gentle-ai.review-integration.status/v5" });
	assert.equal(startCalls, 0);
});

test("STATUS rejects locally-authored untracked input before reading native authority", async () => {
	let statusCalls = 0;
	const native = {
		targetStatus: async () => { statusCalls += 1; return status("unreachable"); },
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "status", input: JSON.stringify({ unexpected: true }) }, process.cwd(), native);
	assert.equal(result.outcome, "native-status-input-invalid");
	assert.equal(result.mutation_outcome, "none");
	assert.equal(statusCalls, 0);
});

test("INSPECT remains a read-only negotiated STATUS projection with no inventory reconstruction", async () => {
	let calls = 0;
	const native = {
		targetStatus: async (request: { cwd: string }) => {
			calls += 1;
			assert.equal(request.cwd, process.cwd());
			return { ...status("inspect-lineage"), applicability: "ambiguous" } as ReviewStatusV3;
		},
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "inspect" }, process.cwd(), native);
	assert.equal(result.operation, "inspect");
	assert.equal(result.status, "blocked");
	assert.equal("mutation_performed" in result, false);
	assert.equal(calls, 1);
});

test("targeted-validator provider vectors preserve their nonuniform native closure operation", async () => {
	const closureLineage = "review-validator";
	const baseInput = collectInput(closureLineage);
	const { submission: _submission, artifactSubject: _artifactSubject, ...roleInput } = baseInput;
	void _submission;
	void _artifactSubject;
	const input = {
		...roleInput,
		name: "provider_targeted_validator",
		schema: "https://gentle-ai.dev/schema/review/targeted-validator/v1",
		captureOperation: "review.capture-validation",
		arguments: [
			{ name: "lineage", value: closureLineage, token: `--lineage=${closureLineage}` },
			{ name: "target", value: SHA, token: `--target=${SHA}` },
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "execute", value: "true", token: "--execute=true" },
		],
	} as unknown as ReviewCollectInputV3;
	const roleStatus = { ...status(closureLineage), nextTransition: { kind: "collect", reasonCode: "provider_role_required", collect: { inputs: [input] } } } as ReviewStatusV3;
	const native = {
		targetStatus: async () => roleStatus,
		captureProviderRole: async (request: { captureOperation: string }) => {
			assert.equal(request.captureOperation, "review.capture-validation");
			return { schema: "gentle-ai.review-last-event-closure/v1", operation: "review/capture-validation", lineageId: closureLineage, state: "approved", storeRevision: SHA };
		},
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewCaptureOperation({ lineageId: closureLineage, collectBinding: JSON.stringify(input) }, process.cwd(), native);
	assert.equal(result.status, "closed");
	assert.equal(result.outcome, "native-last-event-closure");
	assert.equal("correction_target_identity" in result, false);
});

test("targeted-validator captures echo the distinct provider correction target identity", async () => {
	const closureLineage = "review-validator-correction-target";
	const correctionTarget = `sha256:${"d".repeat(64)}`;
	const baseInput = collectInput(closureLineage);
	const { submission: _submission, artifactSubject: _artifactSubject, ...roleInput } = baseInput;
	void _submission;
	void _artifactSubject;
	const input = {
		...roleInput,
		name: "provider_targeted_validator",
		schema: "https://gentle-ai.dev/schema/review/targeted-validator/v1",
		captureOperation: "review.capture-validation",
		arguments: [
			{ name: "lineage", value: closureLineage, token: `--lineage=${closureLineage}` },
			{ name: "target", value: correctionTarget, token: `--target=${correctionTarget}` },
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "execute", value: "true", token: "--execute=true" },
		],
		validationRequest: { correctionTargetIdentity: correctionTarget },
	} as unknown as ReviewCollectInputV3;
	const roleStatus = { ...status(closureLineage), nextTransition: { kind: "collect", reasonCode: "provider_role_required", collect: { inputs: [input] } } } as ReviewStatusV3;
	const native = {
		targetStatus: async () => roleStatus,
		captureProviderRole: async () => ({ schema: "gentle-ai.review-last-event-closure/v1", operation: "review/capture-validation", lineageId: closureLineage, state: "approved", storeRevision: SHA }),
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewCaptureOperation({ lineageId: closureLineage, collectBinding: JSON.stringify(input) }, process.cwd(), native);
	assert.equal(result.outcome, "native-last-event-closure");
	assert.equal(result.correction_target_identity, correctionTarget);
});

test("capture schema and guidance name diff-line units apart from the frozen logical correction budget", () => {
	const tools = new Map<string, { description: string; promptGuidelines?: readonly string[]; parameters: unknown }>();
	createGentleAiExtension({ nativeReviewCli: null })({
		on() {},
		registerTool(definition: { name: string; description: string; promptGuidelines?: readonly string[]; parameters: unknown }) { tools.set(definition.name, definition); },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	const capture = tools.get("gentle_review_capture");
	const controller = tools.get("gentle_review");
	assert.ok(capture);
	assert.ok(controller);
	const schema = JSON.stringify(capture.parameters);
	assert.match(schema, /diff lines/);
	assert.match(schema, /logical correction budget/);
	const captureGuidance = (capture.promptGuidelines ?? []).join("\n");
	assert.match(captureGuidance, /diff lines/);
	assert.match(captureGuidance, /logical correction budget/);
	const controllerGuidance = (controller.promptGuidelines ?? []).join("\n");
	assert.match(controllerGuidance, /logical correction/);
	assert.match(controllerGuidance, /diff lines/);
});

test("correction-plan collection demands provider-bounded lines, then returns its terminal closure", async () => {
	const lineageId = "review-correction";
	const input = {
		name: "correction_plan",
		schema: "https://gentle-ai.dev/schema/review/correction-plan/v1",
		captureOperation: "review.capture-correction-plan",
		arguments: [
			{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
			{ name: "target", value: SHA, token: `--target=${SHA}` },
		],
		submission: {
			operationToken: "capture-correction-plan",
			argumentTokens: [`--lineage=${lineageId}`, "--correction-lines={{value}}"],
			values: [{ slot: "correction_lines", domain: "integer", substitutionLocation: 1, minimum: 2, maximum: 8 }],
		},
	} as unknown as ReviewCollectInputV3;
	const planStatus = { ...status(lineageId), nextTransition: { kind: "collect", reasonCode: "correction_plan_required", collect: { inputs: [input] } } } as ReviewStatusV3;
	let captures = 0;
	const native = {
		targetStatus: async () => planStatus,
		captureCorrectionPlan: async (request: { correctionLines: number; argumentTokens: readonly string[] }) => {
			captures += 1;
			assert.equal(request.correctionLines, 3);
			assert.deepEqual(request.argumentTokens, [`--lineage=${lineageId}`, "--correction-lines={{value}}"]);
			return { schema: "gentle-ai.review-last-event-closure/v1", operation: "review.capture-correction-plan", lineageId, state: "approved", storeRevision: SHA };
		},
	} as unknown as NativeReviewCli;
	const binding = JSON.stringify(input);
	const required = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: binding }, process.cwd(), native);
	assert.equal(required.outcome, "correction-lines-required");
	const complete = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: binding, correctionLines: 3 }, process.cwd(), native);
	assert.equal(complete.outcome, "native-last-event-closure");
	assert.equal(captures, 1);
});

test("capture refuses a stale binding before any provider mutation", async () => {
	const lineageId = "review-stale-binding";
	const current = collectInput(lineageId);
	const native = {
		targetStatus: async () => status(lineageId),
		captureResult: async () => { throw new Error("must not capture"); },
	} as unknown as NativeReviewCli;
	const stale = { ...current, arguments: [...current.arguments, { name: "unexpected", value: "drift", token: "--unexpected=drift" }] };
	const result = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: JSON.stringify(stale) }, process.cwd(), native);
	assert.equal(result.outcome, "capture-binding-rejected");
	assert.equal(result.mutation_outcome, "none");
	const foreign = { ...current, arguments: current.arguments.map((argument) => argument.name === "lineage" ? { ...argument, value: "foreign-lineage", token: "--lineage=foreign-lineage" } : argument) };
	const foreignResult = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: JSON.stringify(foreign) }, process.cwd(), native);
	assert.equal(foreignResult.outcome, "capture-binding-rejected");
	assert.equal(foreignResult.mutation_outcome, "none");
});

test("ordinary START rejects unknown, legacy-policy, and invalid focus inputs before the mode gate", async () => {
	for (const input of [
		{ mode: "ordinary", unexpected: true },
		{ mode: "ordinary", policyHash: "legacy-policy" },
		{ mode: "ordinary", focus: "not-a-native-focus" },
	]) {
		let statusCalls = 0;
		const native = {
			reviewMode: async () => { throw new Error("mode gate must not run"); },
			targetStatus: async () => { statusCalls += 1; return status("unreachable"); },
		} as unknown as NativeReviewCli;
		const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify(input) }, process.cwd(), native);
		assert.match(String(result.outcome), /^native-start-/);
		assert.equal(result.mutation_outcome, "none");
		assert.equal(statusCalls, 0);
	}
});

test("ordinary START preserves a target STATUS failure instead of constructing compact fallback authority", async () => {
	const native = {
		targetStatus: async () => { throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.OUTPUT_LIMIT, "review/status", true, false, "status too large"); },
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, process.cwd(), native);
	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "native-operation-failed");
	assert.equal(result.mutation_outcome, "none");
	assert.equal((result.diagnostics as { error_code?: string }).error_code, NATIVE_REVIEW_ERROR_CODE.OUTPUT_LIMIT);
});

test("ordinary START leaves the review-mode gate dark when the native client does not expose it", async (t) => {
	const cwd = repository(t);
	const native = {
		targetStatus: async () => startStatus(cwd),
		start: async () => ({ lineageId: "dark-mode-lineage", state: "reviewing", riskLevel: "medium", selectedLenses: ["review-reliability"], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: true, riskReasons: [] }),
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native);
	assert.equal(result.operation, "start");
	assert.equal((result.result as { lineage_id?: string }).lineage_id, "dark-mode-lineage");
});

test("current STATUS binding allows exactly one provider capture and never follows a retired lifecycle route", async () => {
	const lineageId = "last-event-provider-role";
	const base = collectInput(lineageId);
	const { submission: _submission, artifactSubject: _artifactSubject, ...withoutReviewerDocument } = base;
	void _submission;
	void _artifactSubject;
	const input = {
		...withoutReviewerDocument,
		name: "provider_refuter",
		schema: "https://gentle-ai.dev/schema/review/refuter/v1",
		captureOperation: "review.capture-refuter",
		arguments: [
			{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
			{ name: "target", value: SHA, token: `--target=${SHA}` },
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "execute", value: "true", token: "--execute=true" },
		],
	} as unknown as ReviewCollectInputV3;
	let statusCalls = 0;
	let captureCalls = 0;
	const native = {
		targetStatus: async () => {
			statusCalls += 1;
			return { ...status(lineageId), nextTransition: { kind: "collect", reasonCode: "provider_role_required", collect: { inputs: [input] } } } as ReviewStatusV3;
		},
		captureProviderRole: async (request: { captureOperation: string; argumentTokens: readonly string[] }) => {
			captureCalls += 1;
			assert.equal(request.captureOperation, "review.capture-refuter");
			assert.deepEqual(request.argumentTokens, [`--lineage=${lineageId}`, `--target=${SHA}`, "--agent=pi", "--execute=true"]);
			return { schema: "gentle-ai.review-last-event-closure/v1", operation: "review.capture-refuter", lineageId, state: "approved", storeRevision: SHA };
		},
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: JSON.stringify(input) }, process.cwd(), native);
	assert.equal(result.outcome, "native-last-event-closure");
	assert.equal(result.status, "closed");
	assert.equal(statusCalls, 1);
	assert.equal(captureCalls, 1);
});

test("ordinary START transports native focus and safe policy inputs without rebuilding provider authority", async (t) => {
	const cwd = repository(t);
	const seen: Array<Record<string, unknown>> = [];
	mkdirSync(join(cwd, ".gentle-ai", "policies"), { recursive: true });
	const policyPath = join(cwd, ".gentle-ai", "policies", "focus.json");
	writeFileSync(policyPath, "{}\n");
	const native = {
		targetStatus: async () => startStatus(cwd),
		start: async (request: Record<string, unknown>) => {
			seen.push(request);
			return { lineageId: `focus-${seen.length}`, state: "reviewing", riskLevel: "medium", selectedLenses: ["review-reliability"], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: true, riskReasons: [] };
		},
	} as unknown as NativeReviewCli;
	for (const focus of [undefined, "risk", "resilience", "readability", "reliability"] as const) {
		const input = { mode: "ordinary", ...(focus === undefined ? {} : { focus }), ...(focus === "risk" ? { policyPath: ".gentle-ai/policies/focus.json" } : {}) };
		const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify(input) }, cwd, native);
		assert.equal(result.operation, "start");
	}
	assert.equal(seen.length, 5);
	assert.equal("focus" in seen[0]!, false);
	assert.equal(seen[1]?.focus, "risk");
	assert.equal(seen[1]?.policyPath, policyPath);
	assert.deepEqual(seen.slice(2).map((request) => request.focus), ["resilience", "readability", "reliability"]);

	let statusCalls = 0;
	for (const input of [
		{ mode: "ordinary", focus: "unsupported" },
		{ mode: "ordinary", policyHash: "retired-local-policy" },
		{ mode: "ordinary", policyPath: "../outside" },
	]) {
		const rejected = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify(input) }, cwd, {
			targetStatus: async () => { statusCalls += 1; return startStatus(cwd); },
		} as unknown as NativeReviewCli);
		assert.match(String(rejected.outcome), /^native-start-/);
		assert.equal(rejected.mutation_outcome, "none");
	}
	assert.equal(statusCalls, 0);
});

test("INSPECT forwards an explicit committed-only base selector to negotiated STATUS", async (t) => {
	const cwd = repository(t);
	const baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	const requests: Array<Record<string, unknown>> = [];
	const native = {
		targetStatus: async (request: Record<string, unknown>) => {
			requests.push(request);
			return startStatus(cwd, baseRef);
		},
	} as unknown as NativeReviewCli;

	const result = await __testing.executeReviewControllerOperation(
		{ operation: "inspect", input: JSON.stringify({ baseRef, committedOnly: true }) },
		cwd,
		native,
	);

	assert.equal(result.status, "ready");
	assert.deepEqual(
		requests.map(({ baseRef: selectedBase, committedOnly }) => ({ baseRef: selectedBase, committedOnly })),
		[{ baseRef, committedOnly: true }],
	);
});

test("INSPECT rejects malformed committed-range selectors before negotiated STATUS", async (t) => {
	const cwd = repository(t);
	let targetCalls = 0;
	const native = {
		targetStatus: async () => {
			targetCalls += 1;
			return startStatus(cwd);
		},
	} as unknown as NativeReviewCli;

	for (const input of [
		{ baseRef: "HEAD", committedOnly: false },
		{ committedOnly: true },
		{ baseRef: "HEAD", committedOnly: true, mode: "ordinary" },
	]) {
		const rejected = await __testing.executeReviewControllerOperation(
			{ operation: "inspect", input: JSON.stringify(input) },
			cwd,
			native,
		);
		assert.equal(rejected.outcome, "native-inspect-input-invalid");
		assert.equal(rejected.mutation_outcome, "none");
	}
	assert.equal(targetCalls, 0);
});

test("ordinary START keeps default and explicit base selection fail-closed before native mutation", async (t) => {
	const cwd = repository(t);
	let targetCalls = 0;
	const native = {
		targetStatus: async () => { targetCalls += 1; return startStatus(cwd); },
		start: async () => { throw new Error("must not start"); },
	} as unknown as NativeReviewCli;
	for (const input of [
		{ mode: "ordinary", baseRef: "missing-base", committedOnly: true },
		{ mode: "ordinary", baseRef: "HEAD", committedOnly: false },
		{ mode: "ordinary", baseRef: " HEAD", committedOnly: true },
		{ mode: "ordinary", committedOnly: true },
	]) {
		const rejected = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify(input) }, cwd, native);
		assert.match(String(rejected.outcome), /^native-start-/);
		assert.equal(rejected.mutation_outcome, "none");
	}
	assert.equal(targetCalls, 0);
});

test("START and consent ambiguity reconciliation register their returned committed collect route", async (t) => {
	const cwd = repository(t), baseRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	const lineageId = "reconciled-collect", input = correctionPlanInput(lineageId), unknown = () => { throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, "review/start", true, true, "unknown mutation"); };
	const selectors = (requests: readonly Record<string, unknown>[]) => requests.map(({ baseRef: base, committedOnly }) => ({ baseRef: base, committedOnly }));
	const directRequests: Array<Record<string, unknown>> = [], directRoutes = new Map();
	let directStartCalls = 0;
	const directNative = {
		targetStatus: async (request: Record<string, unknown>) => { directRequests.push(request); return directRequests.length === 1 ? startStatus(cwd, baseRef) : status(lineageId, [input]); },
		start: () => { directStartCalls += 1; return unknown(); },
		captureCorrectionPlan: async () => ({ schema: "gentle-ai.review-last-event-closure/v1", operation: "review.capture-correction-plan", lineageId, state: "correction_required", storeRevision: SHA }),
	} as unknown as NativeReviewCli;
	const directStart = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary", baseRef, committedOnly: true }) }, cwd, directNative, undefined, undefined, undefined, directRoutes);
	assert.deepEqual({ outcome: directStart.outcome, status: directStart.status, mutationOutcome: directStart.mutation_outcome, startCalls: directStartCalls, statusCalls: directRequests.length }, { outcome: "native-mutation-status-reconciled", status: "blocked", mutationOutcome: "unknown", startCalls: 1, statusCalls: 2 });
	assert.equal((directStart.diagnostics as { error_code?: string }).error_code, NATIVE_REVIEW_ERROR_CODE.NON_ZERO);
	assert.equal("next_action" in directStart, false);
	const directCapture = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: bindingOf(directStart), correctionLines: 1 }, cwd, directNative, undefined, undefined, directRoutes, true);
	const consent = decodeReviewConsentV3(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json"), "utf8")));
	const consentRequests: Array<Record<string, unknown>> = [], consentRoutes = new Map(), registry = new PendingReviewConsentRegistry(), session = Symbol("consent-session");
	const consentNative = {
		targetStatus: async (request: Record<string, unknown>) => { consentRequests.push(request); return consentRequests.length === 1 ? startStatus(cwd, baseRef) : status(lineageId, [input]); },
		start: async () => { throw new NativeReviewConsentRequiredError(consent); },
		answerConsent: unknown,
		captureCorrectionPlan: directNative.captureCorrectionPlan,
	} as unknown as NativeReviewCli;
	const run = (parameters: Record<string, unknown>) => __testing.executeReviewControllerOperation(parameters, cwd, consentNative, undefined, undefined, undefined, consentRoutes, registry, session);
	const pending = await run({ operation: "start", input: JSON.stringify({ mode: "ordinary", baseRef, committedOnly: true }) });
	await run({ operation: "answer-consent", input: JSON.stringify({ consentBinding: pending.consent_binding, answer: "granted" }) });
	const consentCapture = await __testing.executeReviewCaptureOperation({ lineageId, collectBinding: JSON.stringify(input), correctionLines: 1 }, cwd, consentNative, undefined, undefined, consentRoutes, true);
	assert.deepEqual({
		outcomes: [directCapture.outcome, consentCapture.outcome],
		directStartCalls,
		selectors: [selectors(directRequests), selectors(consentRequests)],
	}, {
		outcomes: ["native-last-event-closure", "native-last-event-closure"],
		directStartCalls: 1,
		selectors: [Array.from({ length: 3 }, () => ({ baseRef, committedOnly: true })), Array.from({ length: 3 }, () => ({ baseRef, committedOnly: true }))],
	});
});

test("ordinary START refuses a target projection that no longer matches the frozen candidate", async (t) => {
	const cwd = repository(t);
	let startCalls = 0;
	const target = startStatus(cwd);
	target.projection = { ...target.projection, currentCandidateTree: "c".repeat(40) };
	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, {
		targetStatus: async () => target,
		start: async () => { startCalls += 1; throw new Error("must not start"); },
	} as unknown as NativeReviewCli);
	assert.equal(result.outcome, "native-operation-failed");
	assert.equal(result.mutation_outcome, "none");
	assert.equal(startCalls, 0);
});

// gentle-pi#455: a consent binding one active Pi session's START created must
// be answerable from another active session presenting the same opaque
// binding id -- consent bindings are not partitioned by which session's
// START created them, only by the repository and candidate they are scoped to.
test("answer-consent resolves a valid binding presented by a different active Pi session", async (t) => {
	const cwd = repository(t);
	const consent = decodeReviewConsentV3(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json"), "utf8")));
	const registry = new PendingReviewConsentRegistry();
	const sessionA = Symbol("session-a"), sessionB = Symbol("session-b");
	let answerCalls = 0;
	const native = {
		targetStatus: async () => startStatus(cwd),
		start: async () => { throw new NativeReviewConsentRequiredError(consent); },
		answerConsent: async () => {
			answerCalls += 1;
			return { kind: "granted", start: { lineageId: "cross-session", state: "reviewing", riskLevel: "low", selectedLenses: [], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false, riskReasons: [] } };
		},
	} as unknown as NativeReviewCli;
	const started = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native, undefined, undefined, undefined, undefined, registry, sessionA);
	assert.equal(typeof started.consent_binding, "string", JSON.stringify(started));
	const answered = await __testing.executeReviewControllerOperation({ operation: "answer-consent", input: JSON.stringify({ consentBinding: started.consent_binding, answer: "granted" }) }, cwd, native, undefined, undefined, undefined, undefined, registry, sessionB);
	assert.equal(answerCalls, 1, JSON.stringify(answered));
	assert.equal((answered.result as { lineage_id?: string } | undefined)?.lineage_id, "cross-session", JSON.stringify(answered));
	assert.notEqual(answered.status, "blocked", JSON.stringify(answered));
});

// gentle-pi#455: cross-session resolution must still enforce single use --
// once a binding is answered by any session, no session (including the one
// whose START created it) may answer it again.
test("a consumed consent binding cannot be answered a second time from any session", async (t) => {
	const cwd = repository(t);
	const consent = decodeReviewConsentV3(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json"), "utf8")));
	const registry = new PendingReviewConsentRegistry();
	const sessionA = Symbol("session-a"), sessionB = Symbol("session-b");
	let answerCalls = 0;
	const native = {
		targetStatus: async () => startStatus(cwd),
		start: async () => { throw new NativeReviewConsentRequiredError(consent); },
		answerConsent: async () => {
			answerCalls += 1;
			return { kind: "granted", start: { lineageId: "single-use", state: "reviewing", riskLevel: "low", selectedLenses: [], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false, riskReasons: [] } };
		},
	} as unknown as NativeReviewCli;
	const started = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native, undefined, undefined, undefined, undefined, registry, sessionA);
	const binding = started.consent_binding as string;
	const first = await __testing.executeReviewControllerOperation({ operation: "answer-consent", input: JSON.stringify({ consentBinding: binding, answer: "granted" }) }, cwd, native, undefined, undefined, undefined, undefined, registry, sessionB);
	assert.equal(answerCalls, 1, JSON.stringify(first));
	const replay = await __testing.executeReviewControllerOperation({ operation: "answer-consent", input: JSON.stringify({ consentBinding: binding, answer: "granted" }) }, cwd, native, undefined, undefined, undefined, undefined, registry, sessionA);
	assert.equal(answerCalls, 1, JSON.stringify(replay));
	assert.equal(replay.status, "blocked", JSON.stringify(replay));
	assert.equal(replay.outcome, "consent-binding-stale", JSON.stringify(replay));
	assert.equal((replay.diagnostics as { code?: string } | undefined)?.code, "consent-binding-already-consumed", JSON.stringify(replay));
});

// gentle-pi#455 correction: cross-session resolution looks a binding up by
// its opaque id alone, so it must independently refuse an answer presented
// from a different repository than the one its owning START minted it for,
// without ever running the mode gate or native answerConsent, and without
// consuming the binding -- leaving it answerable from the right repository.
test("answer-consent refuses a binding presented from a different repository than the one its START minted, and leaves it answerable from the right one", async (t) => {
	const cwdA = repository(t), cwdB = repository(t);
	const consent = decodeReviewConsentV3(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json"), "utf8")));
	const registry = new PendingReviewConsentRegistry();
	const sessionA = Symbol("session-a"), sessionB = Symbol("session-b");
	let answerCalls = 0;
	const native = {
		targetStatus: async () => startStatus(cwdA),
		start: async () => { throw new NativeReviewConsentRequiredError(consent); },
		answerConsent: async () => {
			answerCalls += 1;
			return { kind: "granted", start: { lineageId: "right-repo", state: "reviewing", riskLevel: "low", selectedLenses: [], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false, riskReasons: [] } };
		},
	} as unknown as NativeReviewCli;
	const started = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwdA, native, undefined, undefined, undefined, undefined, registry, sessionA);
	const binding = started.consent_binding as string;
	const wrongRepo = await __testing.executeReviewControllerOperation({ operation: "answer-consent", input: JSON.stringify({ consentBinding: binding, answer: "granted" }) }, cwdB, native, undefined, undefined, undefined, undefined, registry, sessionB);
	assert.equal(answerCalls, 0, JSON.stringify(wrongRepo));
	assert.equal(wrongRepo.status, "blocked", JSON.stringify(wrongRepo));
	assert.equal(wrongRepo.outcome, "consent-binding-repository-mismatch", JSON.stringify(wrongRepo));
	assert.equal((wrongRepo.diagnostics as { code?: string } | undefined)?.code, "consent-binding-repository-mismatch", JSON.stringify(wrongRepo));
	assert.equal(wrongRepo.mutation_performed, false, JSON.stringify(wrongRepo));
	const rightRepo = await __testing.executeReviewControllerOperation({ operation: "answer-consent", input: JSON.stringify({ consentBinding: binding, answer: "granted" }) }, cwdA, native, undefined, undefined, undefined, undefined, registry, sessionA);
	assert.equal(answerCalls, 1, JSON.stringify(rightRepo));
	assert.equal((rightRepo.result as { lineage_id?: string } | undefined)?.lineage_id, "right-repo", JSON.stringify(rightRepo));
});

// gentle-pi#323: within the live consent TTL window, a content-independent
// replay key let a second ordinary START reuse the first START's still-live
// (never lineage-bound) frozen candidate view even though the live candidate
// content changed underneath it, and then dead-ended at
// candidate-target-projection-drift instead of minting a fresh view and a
// fresh consent envelope. An intended-untracked selection is retained across
// both calls so the pre-existing empty-untracked drift-recovery branch does
// not mask the general content-change gap this covers.
test("ordinary START mints a fresh candidate view when candidate content changes within the live consent TTL window", async (t) => {
	const candidateViews = new CandidateViewRegistry();
	t.after(() => candidateViews.cleanupAll());
	const cwd = repository(t);
	writeFileSync(join(cwd, "extra.md"), "kept\n");
	const consent = decodeReviewConsentV3(JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json"), "utf8")));
	const native = {
		targetStatus: async () => startStatus(cwd, undefined, ["extra.md"]),
		start: async () => { throw new NativeReviewConsentRequiredError(consent); },
	} as unknown as NativeReviewCli;
	const first = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native, undefined, candidateViews);
	assert.equal(first.outcome, "native-review-consent-required", JSON.stringify(first));
	writeFileSync(join(cwd, "tracked.txt"), "candidate two\n");
	const second = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native, undefined, candidateViews);
	assert.notEqual(second.outcome, "native-operation-failed", JSON.stringify(second));
	assert.equal(second.outcome, "native-review-consent-required", JSON.stringify(second));
	assert.notEqual(second.consent_binding, first.consent_binding, JSON.stringify(second));
});

test("controller-owned dispatch confines single and parallel graph actors to the current candidate view", async (t) => {
	const cwd = repository(t);
	const candidateViews = new CandidateViewRegistry();
	const lenses = ["review-risk", "review-resilience", "review-readability", "review-reliability"] as const;
	const { controller, toolCall } = reviewRuntime({
		targetStatus: async () => startStatus(cwd),
		start: async () => ({ lineageId: "current-4r", state: "reviewing", riskLevel: "high", selectedLenses: lenses, changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: true, riskReasons: [] }),
	} as unknown as NativeReviewCli, candidateViews);
	await controller.execute("start", { operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, reviewContext(cwd));
	const current = candidateViews.resolveForLens("current-4r", "review-risk");
	try {
		const single = { agent: "review-risk", task: "Inspect", mode: "task" };
		const parallel = { agents: [...lenses], task: "Inspect", mode: "task" };
		assert.equal(await toolCall({ toolName: "subagent_run", input: single }, reviewContext(cwd)), undefined);
		assert.equal(await toolCall({ toolName: "subagent_run", input: parallel }, reviewContext(cwd)), undefined);
		for (const task of [single.task, parallel.task]) {
			assert.match(task, /Controller-owned review lineage: `current-4r`/);
			assert.match(task, new RegExp(`Frozen candidate tree: \`${current.candidateTree}\``));
			assert.match(task, /ambient contributor working directory is out of scope/);
		}
		for (const malformed of [
			{ agent: "review-risk", agents: ["review-risk"], task: "Inspect", mode: "task" },
			{ agents: ["review-risk", "worker"], task: "Inspect", mode: "task" },
			{ agent: "review-risk", task: "Inspect", mode: "background" },
		]) {
			const rejected = await toolCall({ toolName: "subagent_run", input: malformed }, reviewContext(cwd)) as { block?: boolean };
			assert.equal(rejected.block, true);
		}
	} finally {
		candidateViews.cleanup(current.token);
	}
});

test("controller forwards AbortSignal and retains typed native diagnostics without fallback authority", async (t) => {
	const cwd = repository(t);
	const controller = new AbortController();
	let targetSignal: AbortSignal | undefined;
	let startSignal: AbortSignal | undefined;
	const native = {
		targetStatus: async (request: { signal?: AbortSignal }) => { targetSignal = request.signal; return startStatus(cwd); },
		start: async (request: { signal?: AbortSignal }) => {
			startSignal = request.signal;
			return { lineageId: "signal-lineage", state: "reviewing", riskLevel: "medium", selectedLenses: ["review-reliability"], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: true, riskReasons: [] };
		},
	} as unknown as NativeReviewCli;
	const started = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native, controller.signal);
	assert.equal(started.operation, "start");
	assert.equal(targetSignal, controller.signal);
	assert.equal(startSignal, controller.signal);

	for (const operation of ["inspect", "start", "repair"] as const) {
		const input = operation === "start" ? JSON.stringify({ mode: "ordinary" }) : undefined;
		const failed = await __testing.executeReviewControllerOperation({ operation, ...(input === undefined ? {} : { input }) }, cwd, {
			targetStatus: async () => { throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.PACKAGE_BINARY_MISSING, "review/status", false, false, "package binary missing"); },
		} as unknown as NativeReviewCli);
		assert.equal(failed.outcome, "native-status-package-binary-missing");
		assert.equal(failed.mutation_outcome, "none");
		assert.equal((failed.diagnostics as { error_code?: string }).error_code, NATIVE_REVIEW_ERROR_CODE.PACKAGE_BINARY_MISSING);
	}
});

// #465: a collect-state STATUS/INSPECT/START answer used to carry every
// provider collect input twice, once inside result.next_transition.collect
// and once as the canonical collectBinding string, so a four-lens review paid
// roughly 28k characters per call and again on every blocked retry. The
// consumed projection is collectBindings; the raw inputs are the duplicate.
function fourLensCollectStatus(): { raw: Record<string, unknown>; lenses: readonly string[] } {
	const captured = JSON.parse(readFileSync(new URL("./fixtures/devbinary/status-v5-capture-result-submission.captured.json", import.meta.url), "utf8")) as Record<string, unknown>;
	const nextTransition = captured.next_transition as { collect: { inputs: Array<Record<string, unknown>> } };
	const template = nextTransition.collect.inputs[0]!;
	const lenses = ["review-risk", "review-readability", "review-reliability", "review-resilience"] as const;
	// The captured input names its lens in the capture arguments and again in
	// the provider-owned submission tokens; rewrite every occurrence so each of
	// the four inputs is one distinct provider slot.
	const inputs = lenses.map((lens, order) => JSON.parse(JSON.stringify(template).replaceAll("review-reliability", lens).replaceAll("--order=0", `--order=${order}`)) as Record<string, unknown>);
	// The captured envelope predates the current action enumeration; the collect transition is what this test exercises.
	return { raw: { ...captured, action: "stop", next_transition: { ...nextTransition, collect: { inputs } } }, lenses };
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

test("collect-state public STATUS, INSPECT, and START serialize each provider collect input exactly once", async () => {
	const { raw, lenses } = fourLensCollectStatus();
	const status = decodeReviewStatusV3(raw);
	const lineageId = status.authority!.lineageId!;
	const native = { targetStatus: async () => status } as unknown as NativeReviewCli;
	for (const parameters of [
		{ operation: "status", lineageId },
		{ operation: "inspect" },
		{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
	] as const) {
		const result = await __testing.executeReviewControllerOperation(parameters, process.cwd(), native);
		assert.equal(result.status, "blocked", parameters.operation);
		const bindings = result.collectBindings as readonly { collectBinding: string }[];
		assert.equal(bindings.length, lenses.length, parameters.operation);
		const serialized = JSON.stringify(result);
		const projected = JSON.stringify(bindings);
		for (const lens of lenses) {
			const needle = `--lens=${lens}`;
			assert.ok(occurrences(projected, needle) > 0, `${lens} must be published through collectBindings`);
			assert.equal(occurrences(JSON.stringify(result.result), needle), 0, `${parameters.operation} must not repeat the ${lens} collect input inside result (${serialized.length} characters)`);
			assert.equal(occurrences(serialized, needle), occurrences(projected, needle), `${parameters.operation} must serialize the ${lens} collect input exactly once (${serialized.length} characters)`);
		}
		const transition = (result.result as { next_transition: { kind: string } }).next_transition;
		assert.equal(transition.kind, "collect", `${parameters.operation} keeps the transition kind so the orchestrator still sees the collect state`);
		assert.ok(serialized.length < 2 * JSON.stringify(bindings).length, `${parameters.operation} answer (${serialized.length} characters) must not double the ${JSON.stringify(bindings).length}-character binding projection`);
	}
});
