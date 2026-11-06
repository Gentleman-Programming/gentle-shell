import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import { CandidateViewError, CandidateViewRegistry, injectReviewCandidateView } from "../lib/review-candidate-view.ts";
import type { ReviewCollectInputV3, ReviewStatusV3 } from "../lib/review-integration-v2.ts";

// Field report (2026-08-16, gentle-pi main 402f9f77 + gentle-ai
// 2.4.0-main.20278905): after #340 the FINALIZE routing defect was fixed but
// the Pi relay's candidate-view registration still refused for an externally
// recovered successor. Reproduced against the live binary: hydration itself
// works for that shape (a dirty LINKED worktree hydrates fine) — the gap is
// that hydration was wired into the STATUS controller operation ONLY, while
// the maintainer's flow is `finalize` (now correctly blocked with
// review.capture-result) followed by a reviewer dispatch. The FINALIZE lane
// decodes the same authoritative status and never hydrated from it.
//
// Second defect in the same area: every hydration failure was swallowed by a
// bare catch, so the later dispatch refusal claimed no binding existed
// without ever admitting hydration had been attempted and why it failed.

const SHA = `sha256:${"1".repeat(64)}`;

function git(cwd: string, ...arguments_: string[]): string {
	return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

/** A LINKED worktree (not the primary checkout) with dirty tracked files. */
function linkedDirtyWorktree(t: test.TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-hydration-gap-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const primary = join(root, "primary");
	const linked = join(root, "linked");
	mkdirSync(primary, { recursive: true });
	git(primary, "init", "-b", "main");
	git(primary, "config", "user.name", "Hydration Test");
	git(primary, "config", "user.email", "hydration@example.invalid");
	mkdirSync(join(primary, "internal"), { recursive: true });
	writeFileSync(join(primary, "internal", "parser.go"), "package internal\n\nfunc Parse(s string) string {\n\treturn s\n}\n");
	git(primary, "add", "-A");
	git(primary, "commit", "-m", "base");
	git(primary, "worktree", "add", linked, "-b", "feature/fence-info");
	// Uncommitted tracked modification, exactly the field shape.
	writeFileSync(join(linked, "internal", "parser.go"), "package internal\n\nimport \"strings\"\n\nfunc Parse(s string) string {\n\treturn strings.TrimSpace(s)\n}\n");
	return linked;
}

function reviewerResultCollectInput(lineageId: string, lens: string): ReviewCollectInputV3 {
	return {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		captureOperation: "review.capture-result",
		arguments: [
			{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
			{ name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` },
			{ name: "lens", value: lens, token: `--lens=${lens}` },
			{ name: "order", value: "0", token: "--order=0" },
		],
		artifactSubject: {
			schema: "gentle-ai.review-artifact-subject/v2",
			subjectHash: SHA,
			lineageId,
			authorityRevision: SHA,
			targetIdentity: SHA,
			baseTree: "3".repeat(40),
			candidateTree: "4".repeat(40),
			changedPathManifestSha256: SHA,
			lens,
			selectedOrder: 0,
		},
	} as unknown as ReviewCollectInputV3;
}

function successorStatus(lineageId: string, projection: { baseTree: string; currentCandidateTree: string; paths: readonly string[] }): ReviewStatusV3 {
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: "reviewer_results_required", generation: 2, revision: SHA },
		receipt: { status: "expected_missing" },
		action: "finalize",
		replayability: "not_replayable",
		targetIdentity: SHA,
		projection: {
			schema: "gentle-ai.review-integration.projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: projection.baseTree,
			initialReviewTree: projection.currentCandidateTree,
			currentCandidateTree: projection.currentCandidateTree,
			pathsDigest: SHA,
			paths: [...projection.paths],
			intendedUntracked: [],
			intendedUntrackedProof: SHA,
			initialSnapshotIdentity: SHA,
			currentSnapshotIdentity: SHA,
		},
		candidates: [],
		nextTransition: { kind: "collect", reasonCode: "reviewer_results_required", collect: { inputs: [reviewerResultCollectInput(lineageId, "review-reliability")] } },
		raw: { schema: "gentle-ai.review-integration.status/v5", action: "finalize", lineage_id: lineageId },
	} as unknown as ReviewStatusV3;
}

/** The live frozen identity of the dirty linked worktree candidate. */
function liveProjection(cwd: string): { baseTree: string; currentCandidateTree: string; paths: readonly string[] } {
	const probe = new CandidateViewRegistry();
	const view = probe.create({ contributorRoot: cwd });
	try {
		return { baseTree: view.baseTree, currentCandidateTree: view.candidateTree, paths: view.paths };
	} finally {
		probe.cleanup(view.token);
	}
}

function statusNative(status: ReviewStatusV3): NativeReviewCli {
	return {
		targetStatus: async () => status,
		finalize: async () => { throw new Error("native finalize must not run while reviewer results are outstanding"); },
	} as unknown as NativeReviewCli;
}

async function runController(parameters: Record<string, unknown>, cwd: string, native: NativeReviewCli, candidateViews: CandidateViewRegistry): Promise<Record<string, unknown>> {
	return await __testing.executeReviewControllerOperation(
		parameters, cwd, native, undefined, candidateViews,
	) as Record<string, unknown>;
}

test("STATUS keeps hydrating and stays read-only when hydration fails", async (t) => {
	const cwd = linkedDirtyWorktree(t);
	const lineageId = "status-drifted-successor";
	const registry = new CandidateViewRegistry();
	const statusLive = liveProjection(cwd);
	const drifted = { ...statusLive, currentCandidateTree: statusLive.baseTree };
	// STATUS must never fail because hydration failed.
	const envelope = await runController({ operation: "status", lineageId }, cwd, statusNative(successorStatus(lineageId, drifted)), registry);
	assert.equal(envelope.operation, "status");
	assert.equal(registry.hasCurrentBinding(), false);
	assert.throws(
		() => injectReviewCandidateView({ agent: "review-reliability", task: "review", mode: "task" }, registry),
		(error: unknown) => error instanceof CandidateViewError && error.reason === "current-binding-hydration-failed",
	);
});
