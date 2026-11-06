import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import { CandidateViewRegistry, injectReviewCandidateView } from "../lib/review-candidate-view.ts";
import type { ReviewCollectInputV3, ReviewStatusV3 } from "../lib/review-integration-v2.ts";

// Live-confirmed adapter defects (2026-08-16, gentle-ai 2.4.0-main, Engram
// #12461/#12466), both around a lineage recovered EXTERNALLY through native
// `gentle-ai review recover` (disposition scope_changed):
//
//   A. The controller never saw the successor's START, so direct reviewer
//      dispatch refused with `no current controller-owned candidate view
//      lineage binding` even though the controller itself had just decoded
//      the successor's authoritative STATUS.
//   B. `gentle_review finalize` on a lineage still at reviewer_results_required
//      misrouted into the correction evidence-first-ordering lane and failed
//      instead of surfacing the provider-offered review.capture-result step.

const SHA = `sha256:${"1".repeat(64)}`;

function git(cwd: string, ...arguments_: string[]): string {
	return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

function repository(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-recovered-routing-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	git(cwd, "init", "-b", "main");
	writeFileSync(join(cwd, "tracked.txt"), "base\n");
	git(cwd, "add", "tracked.txt");
	git(cwd, "-c", "user.name=Recovered Test", "-c", "user.email=recovered@example.invalid", "commit", "-m", "base");
	return cwd;
}

function reviewerResultCollectInput(lineageId: string, lens: string, order: number): ReviewCollectInputV3 {
	return {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		captureOperation: "review.capture-result",
		arguments: [
			{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
			{ name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` },
			{ name: "target", value: SHA, token: `--target=${SHA}` },
			{ name: "lens", value: lens, token: `--lens=${lens}` },
			{ name: "order", value: String(order), token: `--order=${order}` },
			{ name: "subject-hash", value: `sha256:${String(order).repeat(64)}`, token: `--subject-hash=sha256:${String(order).repeat(64)}` },
		],
		artifactSubject: {
			schema: "gentle-ai.review-artifact-subject/v2",
			subjectHash: `sha256:${String(order).repeat(64)}`,
			lineageId,
			authorityRevision: SHA,
			targetIdentity: SHA,
			baseTree: "3".repeat(40),
			candidateTree: "4".repeat(40),
			changedPathManifestSha256: SHA,
			lens,
			selectedOrder: order,
		},
	} as unknown as ReviewCollectInputV3;
}

interface StatusFixtureShape {
	lineageId: string;
	baseTree: string;
	currentCandidateTree: string;
	paths: readonly string[];
	inputs?: readonly ReviewCollectInputV3[];
	executeFinalize?: boolean;
}

function recoveredStatus(shape: StatusFixtureShape): ReviewStatusV3 {
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId: shape.lineageId, state: "reviewer_results_required", generation: 2, revision: SHA },
		receipt: { status: "expected_missing" },
		action: "finalize",
		replayability: "not_replayable",
		targetIdentity: SHA,
		projection: {
			schema: "gentle-ai.review-integration.projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: shape.baseTree,
			initialReviewTree: shape.currentCandidateTree,
			currentCandidateTree: shape.currentCandidateTree,
			pathsDigest: SHA,
			paths: [...shape.paths],
			intendedUntracked: [],
			intendedUntrackedProof: SHA,
			initialSnapshotIdentity: SHA,
			currentSnapshotIdentity: SHA,
		},
		candidates: [],
		...(shape.inputs !== undefined
			? { nextTransition: { kind: "collect", reasonCode: "reviewer_results_required", collect: { inputs: [...shape.inputs] } } }
			: {}),
		...(shape.executeFinalize === true
			? { nextTransition: { kind: "execute", reasonCode: "captured_results_ready", execute: { operation: "review.finalize", arguments: [], binding: { lineageId: shape.lineageId } } } }
			: {}),
		raw: { schema: "gentle-ai.review-integration.status/v5", action: "finalize", lineage_id: shape.lineageId },
	} as unknown as ReviewStatusV3;
}

function statusOnlyNative(statuses: readonly ReviewStatusV3[]): { native: NativeReviewCli; finalizeCalls: () => number; statusCalls: () => number } {
	const queue = [...statuses];
	let finalizeCalls = 0;
	let statusCalls = 0;
	const native = {
		targetStatus: async () => {
			statusCalls += 1;
			// The v5 lane legitimately re-queries STATUS (workspace-root
			// rebind); keep serving the terminal fixture once drained.
			const next = queue.length > 1 ? queue.shift() : queue[0];
			if (next === undefined) throw new Error("status queue exhausted");
			return next;
		},
		finalize: async () => {
			finalizeCalls += 1;
			throw new Error("native finalize must not be invoked while reviewer results are outstanding");
		},
	} as unknown as NativeReviewCli;
	return { native, finalizeCalls: () => finalizeCalls, statusCalls: () => statusCalls };
}

async function runController(
	parameters: Record<string, unknown>,
	cwd: string,
	native: NativeReviewCli,
	candidateViews: CandidateViewRegistry,
): Promise<Record<string, unknown>> {
	return await __testing.executeReviewControllerOperation(
		parameters,
		cwd,
		native,
		undefined,
		candidateViews,
	) as Record<string, unknown>;
}

// --- DEFECT A: STATUS discovery hydrates the dispatch binding ---

test("STATUS discovery hydrates the dispatch binding for an externally recovered lineage", async (t) => {
	const cwd = repository(t);
	writeFileSync(join(cwd, "tracked.txt"), "successor candidate change\n");
	// Derive the real frozen identity of the live workspace candidate the way
	// native recover froze it: the descriptor in status/v5 names these trees.
	const probe = new CandidateViewRegistry();
	const probeView = probe.create({ contributorRoot: cwd });
	const frozen = { baseTree: probeView.baseTree, currentCandidateTree: probeView.candidateTree, paths: probeView.paths };
	probe.cleanup(probeView.token);

	const successor = "review-recovered-successor";
	const status = recoveredStatus({ lineageId: successor, ...frozen, inputs: [reviewerResultCollectInput(successor, "review-reliability", 0)] });
	const { native } = statusOnlyNative([status]);
	const registry = new CandidateViewRegistry();

	// The controller does not know this lineage: dispatch refuses.
	assert.throws(
		() => injectReviewCandidateView({ agent: "review-reliability", task: "review", mode: "task" }, registry),
		/no current controller-owned candidate view lineage binding/,
	);

	const envelope = await runController({ operation: "status", lineageId: successor }, cwd, native, registry);
	assert.equal(envelope.operation, "status");

	// After the controller itself decoded the successor's authoritative
	// STATUS, the dispatch binding must be hydrated from that status.
	assert.equal(registry.hasCurrentBinding(), true, "STATUS discovery must hydrate the controller-owned dispatch binding");
	try {
		const dispatch: Record<string, unknown> = { agent: "review-reliability", task: "review the recovered successor", mode: "task" };
		assert.doesNotThrow(() => injectReviewCandidateView(dispatch, registry));
		assert.match(String(dispatch.task), new RegExp(successor));
		assert.equal(registry.resolveCurrentForLens("review-reliability").candidateTree, frozen.currentCandidateTree);
	} finally {
		registry.cleanup(registry.resolveCurrentForLens("review-reliability").token);
	}
});

test("STATUS discovery never hydrates without pending reviewer-result collection", async (t) => {
	const cwd = repository(t);
	writeFileSync(join(cwd, "tracked.txt"), "successor candidate change\n");
	const probe = new CandidateViewRegistry();
	const probeView = probe.create({ contributorRoot: cwd });
	const frozen = { baseTree: probeView.baseTree, currentCandidateTree: probeView.candidateTree, paths: probeView.paths };
	probe.cleanup(probeView.token);

	const successor = "review-recovered-successor";
	const { native } = statusOnlyNative([recoveredStatus({ lineageId: successor, ...frozen, executeFinalize: true })]);
	const registry = new CandidateViewRegistry();
	await runController({ operation: "status", lineageId: successor }, cwd, native, registry);
	assert.equal(registry.hasCurrentBinding(), false, "an execute transition offers no reviewer dispatch and must not hydrate");
});
