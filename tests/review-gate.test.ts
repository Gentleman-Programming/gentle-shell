import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	EXTERNAL_RELEASE_EVIDENCE,
	GATE_RESULT,
	GATE_TARGET_KIND,
	PUSH_UPDATE_KIND,
	RELEASE_FAST_PATH_PROTECTED_REF,
	evaluateReleaseFastPathV1,
	recheckReleaseFastPathRemoteHeadV1,
	resolveConfiguredPushDestinationV1,
	type GateTargetV1,
	type ReleaseGateTargetV1,
	type GhCommandRunnerV1,
	type ReleaseFastPathEvidenceV1,
} from "../lib/review-publication-gate.ts";
import {
	REVIEW_MODE,
	REVIEW_TRANSITION,
	TERMINAL_STATE,
	ReviewTransactionStore,
	canonicalHash,
	createReceiptForState,
	createReviewState,
	evaluateGateTarget,
	validateReviewGate,
	type AuthoritativeReceiptV1,
	type ReceiptBodyV1,
	type ReceiptEnvelopeV1,
	type ReviewBudgetV1,
	type ReviewStateV1,
} from "../lib/review-transaction.ts";
import { REVIEW_LENS, REVIEW_ROUTE } from "../lib/review-triggers.ts";
import { inheritedUnsafeGitEnvironmentKeys } from "../lib/review-repository.ts";
import { qualifiedReviewLockPlatform, testSnapshot } from "./review-test-fixtures.ts";

interface GateRepository {
	repository: string;
	remote: string;
	remotePath: string;
	baseTree: string;
	finalTree: string;
	changedTree: string;
	baseCommit: string;
	finalCommit: string;
	tagObject: string;
}

test("unsafe publication Git environment matching preserves actual mixed-case keys", () => {
	assert.deepEqual(
		inheritedUnsafeGitEnvironmentKeys({
			git_config_count: "1",
			Git_Config_Key_0: "remote.origin.pushurl",
			git_config_value_0: "attacker",
			GIT_SSH_COMMAND: "unsafe",
			GIT_ASKPASS: "safe",
		}),
		["GIT_SSH_COMMAND", "Git_Config_Key_0", "git_config_count", "git_config_value_0"],
	);
});

function createGateRepository(t: test.TestContext): GateRepository {
	const parent = mkdtempSync(join(tmpdir(), "gentle-pi-gate-repo-"));
	const repository = join(parent, "repo");
	mkdirSync(repository);
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const git = (...args: string[]): string =>
		execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
	git("init", "-b", "main");
	writeFileSync(join(repository, "app.ts"), "export const value = 1;\n");
	git("add", ".");
	git("-c", "user.name=Gate Test", "-c", "user.email=gate@example.invalid", "commit", "-m", "base");
	const baseCommit = git("rev-parse", "HEAD");
	const baseTree = git("rev-parse", "HEAD^{tree}");
	git("branch", "base", baseCommit);
	writeFileSync(join(repository, "app.ts"), "export const value = 2;\n");
	git("add", ".");
	git("-c", "user.name=Gate Test", "-c", "user.email=gate@example.invalid", "commit", "-m", "final");
	const finalCommit = git("rev-parse", "HEAD");
	const finalTree = git("rev-parse", "HEAD^{tree}");
	git("branch", "final", finalCommit);
	git("-c", "user.name=Gate Test", "-c", "user.email=gate@example.invalid", "tag", "-a", "v1.2.3", "-m", "release", finalCommit);
	const tagObject = git("rev-parse", "refs/tags/v1.2.3^{object}");
	writeFileSync(join(repository, "app.ts"), "export const value = 3;\n");
	git("add", ".");
	git("-c", "user.name=Gate Test", "-c", "user.email=gate@example.invalid", "commit", "-m", "changed");
	const changedTree = git("rev-parse", "HEAD^{tree}");
	const remote = join(parent, "remote.git");
	execFileSync("git", ["clone", "--bare", repository, remote], {
		cwd: parent,
		stdio: ["ignore", "pipe", "pipe"],
	});
	execFileSync("git", ["--git-dir", remote, "update-ref", "refs/heads/main", baseCommit], {
		cwd: parent,
	});
	git("remote", "add", "origin", remote);
	git("update-ref", "refs/heads/main", finalCommit);
	return {
		repository,
		remote: "origin",
		remotePath: remote,
		baseTree,
		finalTree,
		changedTree,
		baseCommit,
		finalCommit,
		tagObject,
	};
}

function budget(overrides: Partial<ReviewBudgetV1> = {}): ReviewBudgetV1 {
	return {
		review_batches: 1,
		review_actors: 0,
		refuter_batches: 1,
		fix_batches: 1,
		validator_runs: 1,
		final_verifications: 1,
		judgment_rounds: 0,
		judge_runs: 0,
		...overrides,
	};
}

function initialState(repository: GateRepository, lineageId = "approved-lineage"): ReviewStateV1 {
	return createReviewState({
		lineageId,
		mode: REVIEW_MODE.ORDINARY,
		snapshot: testSnapshot({
			baseTree: repository.baseTree,
			completeTree: repository.finalTree,
			route: REVIEW_ROUTE.STANDARD,
			lenses: [REVIEW_LENS.READABILITY],
		}),
		evidenceHash: "b".repeat(64),
		budget: budget({ review_actors: 1 }),
	});
}

function receiptFor(state: ReviewStateV1): ReceiptEnvelopeV1 {
	return createReceiptForState(state);
}

function temporaryAuthority(t: test.TestContext): GateRepository & {
	store: ReviewTransactionStore;
	receipt: ReceiptEnvelopeV1;
	authoritativeReceipt: AuthoritativeReceiptV1;
} {
	const repository = createGateRepository(t);
	const store = ReviewTransactionStore.forRepository(repository.repository, { mutationLockPlatform: qualifiedReviewLockPlatform() });
	store.create(initialState(repository), "start-approved-lineage");
	store.runReducerOperation({
		lineageId: "approved-lineage",
		transition: REVIEW_TRANSITION.ORDINARY_DISCOVERY,
		idempotencyKey: "discover",
		input: { rows: [] },
	});
	store.runReducerOperation({
		lineageId: "approved-lineage",
		transition: REVIEW_TRANSITION.ORDINARY_EVIDENCE,
		idempotencyKey: "evidence",
		input: { deterministicResults: [] },
	});
	store.runReducerOperation({
		lineageId: "approved-lineage",
		transition: REVIEW_TRANSITION.ORDINARY_FINAL_VERIFICATION,
		idempotencyKey: "verify",
		input: { passed: true },
	});
	const state = store.read("approved-lineage");
	return { ...repository, store, receipt: receiptFor(state), authoritativeReceipt: store.createAuthoritativeReceipt("approved-lineage") };
}

test("unbranded receipts are rejected before lifecycle gate evaluation", (t) => {
	const { repository, finalTree, store, receipt } = temporaryAuthority(t);
	execFileSync("git", ["read-tree", finalTree], { cwd: repository });
	assert.throws(() => Reflect.apply(validateReviewGate, undefined, [{
		store,
		receipt,
		target: { kind: GATE_TARGET_KIND.INTENDED_COMMIT, intended_commit_tree: finalTree },
		repositoryCwd: repository,
		idempotencyKey: "unbranded-gate",
		scopeBudget: budget(),
	}]), /branded authoritative receipt/i);
});

test("authoritative receipts cannot be validated through another repository store", (t) => {
	const authority = temporaryAuthority(t);
	const other = temporaryAuthority(t);
	assert.throws(() => validateReviewGate({
		store: other.store,
		receipt: authority.authoritativeReceipt,
		target: { kind: GATE_TARGET_KIND.INTENDED_COMMIT, intended_commit_tree: authority.finalTree },
		repositoryCwd: authority.repository,
		idempotencyKey: "cross-store-gate",
		scopeBudget: budget(),
	}), /authority/i);
});

test("exact intended commit target allows with zero actors and journal replay is stable", (t) => {
	const { repository, finalTree, store, receipt, authoritativeReceipt } = temporaryAuthority(t);
	execFileSync("git", ["read-tree", finalTree], { cwd: repository });
	const target = {
		kind: GATE_TARGET_KIND.INTENDED_COMMIT,
		intended_commit_tree: finalTree,
	} as const;
	const first = validateReviewGate({
		store,
		receipt: authoritativeReceipt,
		target,
		repositoryCwd: repository,
		idempotencyKey: "gate-commit-1",
		scopeBudget: budget(),
	});
	assert.equal(first.status, GATE_RESULT.ALLOW);
	assert.equal(first.actor_count, 0);
	assert.equal(first.target_hash, canonicalHash(target));
	const replay = validateReviewGate({
		store: ReviewTransactionStore.forRepository(repository, { mutationLockPlatform: qualifiedReviewLockPlatform() }),
		receipt: store.createAuthoritativeReceipt(receipt.body.lineage_id),
		target,
		repositoryCwd: repository,
		idempotencyKey: "gate-commit-1",
		scopeBudget: budget({ fix_batches: 99 }),
	});
	assert.deepEqual(replay, first);
	assert.equal(store.read(receipt.body.lineage_id).revision, 4);
});

test("exact gate retries replay before stale receipt binding while new requests still deny", (t) => {
	const { repository, finalTree, store, authoritativeReceipt } = temporaryAuthority(t);
	execFileSync("git", ["read-tree", finalTree], { cwd: repository });
	const target = { kind: GATE_TARGET_KIND.INTENDED_COMMIT, intended_commit_tree: finalTree } as const;
	const first = validateReviewGate({ store, receipt: authoritativeReceipt, target, repositoryCwd: repository, idempotencyKey: "stale-retry", scopeBudget: budget() });
	const replay = validateReviewGate({ store, receipt: authoritativeReceipt, target, repositoryCwd: repository, idempotencyKey: "stale-retry", scopeBudget: budget() });
	assert.deepEqual(replay, first);
	assert.throws(() => validateReviewGate({ store, receipt: authoritativeReceipt, target, repositoryCwd: repository, idempotencyKey: "stale-new-request", scopeBudget: budget() }), /stale|unbound/i);
});

test("intended commit target denies when the actual staged tree drifted after approval", (t) => {
	const { repository, finalTree, changedTree, receipt } = temporaryAuthority(t);
	assert.equal(
		execFileSync("git", ["write-tree"], { cwd: repository, encoding: "utf8" }).trim(),
		changedTree,
	);

	const result = evaluateGateTarget(
		receipt,
		{
			kind: GATE_TARGET_KIND.INTENDED_COMMIT,
			intended_commit_tree: finalTree,
		},
		repository,
	);

	assert.equal(result.status, GATE_RESULT.DENY);
	assert.match(result.reason, /staged tree.*intended commit tree/i);
});

test("changed exact target returns one deterministic child with a non-refreshing budget", (t) => {
	const { repository, changedTree, store, receipt, authoritativeReceipt } = temporaryAuthority(t);
	const target = {
		kind: GATE_TARGET_KIND.INTENDED_COMMIT,
		intended_commit_tree: changedTree,
	} as const;
	const first = validateReviewGate({
		store,
		receipt: authoritativeReceipt,
		target,
		repositoryCwd: repository,
		idempotencyKey: "scope-1",
		scopeBudget: budget({ review_actors: 4 }),
	});
	assert.equal(first.status, GATE_RESULT.SCOPE_CHANGED);
	assert.equal(first.actor_count, 0);
	assert.equal(first.child_claim?.target_tree, changedTree);
	assert.equal(first.child_claim?.budget.review_actors, 4);
	const replayUnderAnotherGateKey = validateReviewGate({
		store,
		receipt: store.createAuthoritativeReceipt(receipt.body.lineage_id),
		target,
		repositoryCwd: repository,
		idempotencyKey: "scope-2",
		scopeBudget: budget({ review_actors: 99, fix_batches: 99 }),
	});
	assert.equal(
		replayUnderAnotherGateKey.child_claim?.child_lineage_id,
		first.child_claim?.child_lineage_id,
	);
	assert.equal(replayUnderAnotherGateKey.child_claim?.budget.review_actors, 4);
	assert.equal(replayUnderAnotherGateKey.child_claim?.budget.fix_batches, 1);
});

test("push gate allows normal same-name updates while preserving exact-old and create rules", (t) => {
	const authority = temporaryAuthority(t);
	const { repository, remote, baseTree, finalTree, baseCommit, finalCommit, receipt } = authority;
	const destination = resolveConfiguredPushDestinationV1(repository, remote);
	const target = {
		kind: GATE_TARGET_KIND.PUSH,
		remote,
		destination_id: destination.destination_id,
		updates: [
			{
				kind: PUSH_UPDATE_KIND.CREATE,
				source_ref: "refs/heads/final",
				destination_ref: "refs/heads/feature",
				old_object: null,
				old_peeled_commit: null,
				old_tree: null,
				new_object: finalCommit,
				new_peeled_commit: finalCommit,
				new_tree: finalTree,
			},
			{
				kind: PUSH_UPDATE_KIND.UPDATE,
				source_ref: "refs/heads/main",
				destination_ref: "refs/heads/main",
				old_object: baseCommit,
				old_peeled_commit: baseCommit,
				old_tree: baseTree,
				new_object: finalCommit,
				new_peeled_commit: finalCommit,
				new_tree: finalTree,
			},
		],
	} as const;
	const allowed = evaluateGateTarget(receipt, target, repository);
	assert.equal(allowed.status, GATE_RESULT.ALLOW, allowed.reason);
	assert.equal(allowed.actor_count, 0);
	const driftedUpdate = {
		kind: GATE_TARGET_KIND.PUSH,
		remote,
		destination_id: target.destination_id,
		updates: [{
			...target.updates[1],
			old_object: finalCommit,
			old_peeled_commit: finalCommit,
			old_tree: finalTree,
		}],
	} as const;
	assert.equal(
		evaluateGateTarget(receipt, driftedUpdate, repository).status,
		GATE_RESULT.DENY,
	);
	const createOverExisting = {
		kind: GATE_TARGET_KIND.PUSH,
		remote,
		destination_id: target.destination_id,
		updates: [{ ...target.updates[0], destination_ref: "refs/heads/final" }],
	} as const;
	assert.equal(
		evaluateGateTarget(receipt, createOverExisting, repository).status,
		GATE_RESULT.DENY,
	);

	const reversed = { ...target, updates: [...target.updates].reverse() };
	assert.equal(evaluateGateTarget(receipt, reversed, repository).status, GATE_RESULT.DENY);
	const deletion = {
		kind: GATE_TARGET_KIND.PUSH,
		updates: [{ kind: "delete", destination_ref: "refs/heads/main" }],
	} as unknown as GateTargetV1;
	assert.equal(evaluateGateTarget(receipt, deletion, repository).status, GATE_RESULT.DENY);
	assert.equal(
		evaluateGateTarget(
			receipt,
			{
				...target,
				updates: [{ ...target.updates[0], new_peeled_commit: baseCommit }, target.updates[1]],
			},
			repository,
		).status,
		GATE_RESULT.DENY,
	);
	assert.equal(
		evaluateGateTarget(receipt, { ...target, remote: "missing-remote" }, repository).status,
		GATE_RESULT.DENY,
	);
	const changedDestination = join(authority.repository, "changed-destination.git");
	execFileSync("git", ["init", "--bare", changedDestination], { stdio: ["ignore", "pipe", "pipe"] });
	execFileSync("git", ["remote", "set-url", "--add", "--push", remote, changedDestination], { cwd: repository });
	assert.equal(
		evaluateGateTarget(receipt, target, repository).status,
		GATE_RESULT.DENY,
		"a target bound to the former publication destination must fail closed",
	);
});

test("push gate treats only successful empty output as absent and fails closed on probe failures", async (t) => {
	const authority = temporaryAuthority(t);
	const { repository, remote, finalTree, finalCommit, receipt } = authority;
	const destination = resolveConfiguredPushDestinationV1(repository, remote);
	const target = {
		kind: GATE_TARGET_KIND.PUSH,
		remote,
		destination_id: destination.destination_id,
		updates: [{
			kind: PUSH_UPDATE_KIND.CREATE,
			source_ref: "refs/heads/final",
			destination_ref: "refs/heads/feature",
			old_object: null,
			old_peeled_commit: null,
			old_tree: null,
			new_object: finalCommit,
			new_peeled_commit: finalCommit,
			new_tree: finalTree,
		}],
	} as const;
	assert.equal(evaluateGateTarget(receipt, target, repository).status, GATE_RESULT.ALLOW);
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const originalPath = process.env.PATH;
	for (const [name, body] of [
		["nonzero", "exit 1"],
		["malformed", "printf 'not-a-valid-row\\n'; exit 0"],
		["ambiguous", `printf '${finalCommit}\\trefs/heads/feature\\n${finalCommit}\\trefs/heads/feature\\n'; exit 0`],
	] as const) {
		await t.test(name, () => {
			const bin = join(authority.repository, `fake-git-${name}`);
			mkdirSync(bin);
			const fakeGit = join(bin, "git");
			writeFileSync(fakeGit, `#!/bin/sh\nif [ "$1" = "ls-remote" ]; then ${body}; fi\nexec "${realGit}" "$@"\n`);
			chmodSync(fakeGit, 0o755);
			process.env.PATH = `${bin}:${originalPath ?? ""}`;
			try {
				const result = evaluateGateTarget(receipt, target, repository);
				assert.equal(result.status, GATE_RESULT.DENY, result.reason);
			} finally {
				process.env.PATH = originalPath;
			}
		});
	}
});

test("push CREATE rejects unreviewed ancestor history", (t) => {
	const authority = temporaryAuthority(t);
	const { repository, remote, baseTree, finalTree, baseCommit, receipt } = authority;
	const git = (...args: string[]): string =>
		execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
	git("checkout", "--force", "--detach", baseCommit);
	writeFileSync(join(repository, "ancestor.ts"), "export const unreviewed = true;\n");
	git("add", ".");
	git("-c", "user.name=Gate Test", "-c", "user.email=gate@example.invalid", "commit", "-m", "unreviewed ancestor");
	const unreviewedParent = git("rev-parse", "HEAD");
	git("read-tree", finalTree);
	git("-c", "user.name=Gate Test", "-c", "user.email=gate@example.invalid", "commit", "-m", "reviewed tree");
	const newCommit = git("rev-parse", "HEAD");
	git("branch", "unsafe-first-push", newCommit);
	execFileSync("git", ["--git-dir", authority.remotePath, "fetch", repository, `${unreviewedParent}:refs/heads/unreviewed`], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const destination = resolveConfiguredPushDestinationV1(repository, remote);
	const target = {
		kind: GATE_TARGET_KIND.PUSH,
		remote,
		destination_id: destination.destination_id,
		updates: [{
			kind: PUSH_UPDATE_KIND.CREATE,
			source_ref: "refs/heads/unsafe-first-push",
			destination_ref: "refs/heads/unsafe-first-push",
			old_object: null,
			old_peeled_commit: null,
			old_tree: null,
			new_object: newCommit,
			new_peeled_commit: newCommit,
			new_tree: finalTree,
		}],
	} as const;

	const result = evaluateGateTarget(receipt, target, repository);
	assert.equal(result.status, GATE_RESULT.DENY, result.reason);
	assert.match(result.reason, /parent tree|base tree/i);
	assert.notEqual(git("rev-parse", `${unreviewedParent}^{tree}`), baseTree);
});

test("PR and release gates resolve exact refs, commits, tag objects, peels, and trees", (t) => {
	const authority = temporaryAuthority(t);
	const { repository, baseTree, finalTree, changedTree, baseCommit, finalCommit, receipt } = authority;
	const pullRequest = {
		kind: GATE_TARGET_KIND.PULL_REQUEST,
		base_ref: "refs/heads/base",
		base_commit: baseCommit,
		base_tree: baseTree,
		head_ref: "refs/heads/final",
		head_commit: finalCommit,
		head_tree: finalTree,
	} as const;
	const pullRequestResult = evaluateGateTarget(receipt, pullRequest, repository);
	assert.equal(pullRequestResult.status, GATE_RESULT.ALLOW, pullRequestResult.reason);
	assert.equal(
		evaluateGateTarget(receipt, { ...pullRequest, base_commit: finalCommit }, repository).status,
		GATE_RESULT.DENY,
	);
	const release = releaseTarget(authority);
	const releaseResult = evaluateGateTarget(receipt, release, repository);
	assert.equal(releaseResult.status, GATE_RESULT.ALLOW, releaseResult.reason);
	assert.equal(
		evaluateGateTarget(receipt, { ...release, tree: changedTree }, repository).status,
		GATE_RESULT.DENY,
	);
});

test("unsupported, ambiguous, nonexistent, and non-approved targets fail closed", (t) => {
	const { repository, finalTree, receipt: approved } = temporaryAuthority(t);
	assert.equal(
		evaluateGateTarget(approved, {
			kind: GATE_TARGET_KIND.INTENDED_COMMIT,
			intended_commit_tree: "HEAD",
		}, repository).status,
		GATE_RESULT.DENY,
	);
	assert.equal(
		evaluateGateTarget(approved, { kind: "branch", ref: "main" } as unknown as GateTargetV1, repository)
			.status,
		GATE_RESULT.DENY,
	);
	const escalated = structuredClone(approved);
	escalated.body.terminal_state = TERMINAL_STATE.ESCALATED;
	escalated.receipt_hash = canonicalHash(escalated.body);
	assert.equal(
		evaluateGateTarget(escalated, {
			kind: GATE_TARGET_KIND.INTENDED_COMMIT,
			intended_commit_tree: finalTree,
		}, repository).status,
		GATE_RESULT.DENY,
	);
	assert.equal(
		evaluateGateTarget(approved, {
			kind: GATE_TARGET_KIND.INTENDED_COMMIT,
			intended_commit_tree: "f".repeat(40),
		}, repository).status,
		GATE_RESULT.DENY,
	);
});

test("scope child claim and parent gate journal publish atomically across faults", (t) => {
	const { repository, changedTree, store, receipt, authoritativeReceipt } = temporaryAuthority(t);
	const before = store.read(receipt.body.lineage_id);
	let injected = false;
	const faulty = ReviewTransactionStore.forRepository(repository, {
		mutationLockPlatform: qualifiedReviewLockPlatform(),
		faultInjector(point) {
			if (!injected && point === "before-head-rename") {
				injected = true;
				throw new Error("scope publication fault");
			}
		},
	});
	const target = {
		kind: GATE_TARGET_KIND.INTENDED_COMMIT,
		intended_commit_tree: changedTree,
	} as const;
	assert.throws(
		() => validateReviewGate({
			store: faulty,
			receipt: authoritativeReceipt,
			target,
			repositoryCwd: repository,
			idempotencyKey: "scope-fault",
			scopeBudget: budget({ review_actors: 4 }),
		}),
		/scope publication fault/,
	);
	const afterFault = store.read(receipt.body.lineage_id);
	assert.equal(afterFault.revision, before.revision);
	assert.deepEqual(afterFault.child_claims ?? [], []);
	assert.equal(afterFault.request_journal.length, before.request_journal.length);

	const published = validateReviewGate({
		store,
		receipt: authoritativeReceipt,
		target,
		repositoryCwd: repository,
		idempotencyKey: "scope-fault",
		scopeBudget: budget({ review_actors: 4 }),
	});
	assert.equal(published.child_claim?.child_lineage_id, canonicalHash({
		parent_lineage_id: receipt.body.lineage_id,
		target_tree: changedTree,
	}));
	assert.equal(store.read(receipt.body.lineage_id).child_claims?.length, 1);
});

function releaseTarget(repository: GateRepository): ReleaseGateTargetV1 {
	return {
		kind: GATE_TARGET_KIND.RELEASE,
		tag_ref: "refs/tags/v1.2.3",
		tag_object: repository.tagObject,
		peeled_commit: repository.finalCommit,
		tree: repository.finalTree,
	};
}

function fastPathEvidence(
	repository: GateRepository,
	overrides: Partial<ReleaseFastPathEvidenceV1> = {},
): ReleaseFastPathEvidenceV1 {
	return {
		protected_ref: RELEASE_FAST_PATH_PROTECTED_REF,
		remote: repository.remote,
		ci: { revision: repository.finalCommit, status: "success" },
		external_evidence: EXTERNAL_RELEASE_EVIDENCE.NONE,
		post_incident: false,
		...overrides,
	};
}

function setRemoteMain(repository: GateRepository, commit: string): void {
	execFileSync("git", ["--git-dir", repository.remotePath, "update-ref", "refs/heads/main", commit]);
}

// A stub `gh` command runner that only reports success when the exact SHA
// under test is present in the invoked arguments — mirroring `gh api
// repos/{owner}/{repo}/commits/<sha>/status` being bound to one exact SHA.
function successfulGhCommandRunner(expectedSha: string): GhCommandRunnerV1 {
	return (args) => {
		if (!args.some((arg) => arg.includes(expectedSha))) return { status: 1, stdout: "" };
		if (args[1] === `repos/{owner}/{repo}/commits/${expectedSha}/check-runs?per_page=100`) {
			return {
				status: 0,
				stdout: JSON.stringify({ total_count: 1, returned: 1, checks: [["completed", "success"]] }),
			};
		}
		return { status: 0, stdout: "success" };
	};
}

test("release fast path independently accepts complete successful Check Runs despite a pending legacy status", (t) => {
	const repository = createGateRepository(t);
	setRemoteMain(repository, repository.finalCommit);
	const calls: string[][] = [];
	const checkRuns = (checks: readonly unknown[], totalCount = checks.length, legacyStatus = "pending"): GhCommandRunnerV1 => (args) => {
		calls.push([...args]);
		if (args[1] === `repos/{owner}/{repo}/commits/${repository.finalCommit}/check-runs?per_page=100`) {
			return { status: 0, stdout: JSON.stringify({ total_count: totalCount, returned: checks.length, checks }) };
		}
		return { status: 0, stdout: legacyStatus };
	};
	const successful = [["completed", "success"], ["completed", "success"], ["completed", "success"]];
	const evaluation = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
		ghCommandRunner: checkRuns(successful),
	});
	assert.equal(evaluation.eligible, true, evaluation.reason);
	assert.deepEqual(calls, [[
		"api",
		`repos/{owner}/{repo}/commits/${repository.finalCommit}/check-runs?per_page=100`,
		"--jq",
		"{total_count, returned: (.check_runs | length), checks: [.check_runs[] | [.status, .conclusion]]}",
	]]);
	for (const [name, checks, totalCount, legacyStatus, eligible] of [
		["failed check", [["completed", "failure"]], 1, "pending", false],
		["pending check", [["in_progress", null]], 1, "pending", false],
		["partial enumeration", successful, 4, "success", false],
		["legacy success without checks", [], 0, "success", true],
		["legacy pending without checks", [], 0, "pending", false],
		["missing legacy status without checks", [], 0, "", false],
	] as const) {
		const result = evaluateReleaseFastPathV1({
			target: releaseTarget(repository),
			evidence: fastPathEvidence(repository),
			repositoryCwd: repository.repository,
			ghCommandRunner: checkRuns(checks, totalCount, legacyStatus),
		});
		assert.equal(result.eligible, eligible, name);
	}
});

test("release fast path proves the immutable origin/main SHA and ignores local branch position and worktree dirtiness", (t) => {
	const repository = createGateRepository(t);
	setRemoteMain(repository, repository.finalCommit);
	// Local publication inputs must be irrelevant: detached HEAD at an older commit plus a dirty worktree.
	execFileSync("git", ["checkout", "--force", "--detach", repository.baseCommit], {
		cwd: repository.repository,
		stdio: ["ignore", "pipe", "pipe"],
	});
	writeFileSync(join(repository.repository, "app.ts"), "export const value = 999; // dirty\n");
	const evaluation = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
		ghCommandRunner: successfulGhCommandRunner(repository.finalCommit),
	});
	assert.equal(evaluation.eligible, true, evaluation.reason);
	assert.equal(evaluation.remote_head, repository.finalCommit);
	assert.match(evaluation.reason, /immutable origin\/main SHA/i);
});

test("release fast path fails closed when the tag does not target the current immutable origin/main SHA", (t) => {
	const repository = createGateRepository(t);
	setRemoteMain(repository, repository.baseCommit);
	const evaluation = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository, { ci: { revision: repository.baseCommit, status: "success" } }),
		repositoryCwd: repository.repository,
	});
	assert.equal(evaluation.eligible, false);
	assert.match(evaluation.reason, /not the current immutable origin\/main SHA/i);
});

test("release fast path requires successful required CI bound to the exact origin/main SHA", (t) => {
	const repository = createGateRepository(t);
	setRemoteMain(repository, repository.finalCommit);
	for (const ci of [
		{ revision: repository.baseCommit, status: "success" },
		{ revision: repository.finalCommit, status: "failure" },
		{ revision: repository.finalCommit, status: "pending" },
	]) {
		const evaluation = evaluateReleaseFastPathV1({
			target: releaseTarget(repository),
			evidence: fastPathEvidence(repository, { ci }),
			repositoryCwd: repository.repository,
		});
		assert.equal(evaluation.eligible, false, JSON.stringify(ci));
		assert.match(evaluation.reason, /required CI/i);
	}
});

test("release fast path fails closed on escalating or invalidating fresh risk evidence", (t) => {
	const repository = createGateRepository(t);
	setRemoteMain(repository, repository.finalCommit);
	for (const disposition of [
		EXTERNAL_RELEASE_EVIDENCE.ESCALATING,
		EXTERNAL_RELEASE_EVIDENCE.INVALIDATING,
	]) {
		const evaluation = evaluateReleaseFastPathV1({
			target: releaseTarget(repository),
			evidence: fastPathEvidence(repository, { external_evidence: disposition }),
			repositoryCwd: repository.repository,
			ghCommandRunner: successfulGhCommandRunner(repository.finalCommit),
		});
		assert.equal(evaluation.eligible, false, disposition);
		assert.match(evaluation.reason, /vulnerability, policy, provenance, signing, generated-artifact, or release evidence/i);
	}
});

test("major, post-incident, and unprovable-version releases always require explicit extraordinary review", (t) => {
	const repository = createGateRepository(t);
	setRemoteMain(repository, repository.finalCommit);
	const git = (...args: string[]): string =>
		execFileSync("git", args, { cwd: repository.repository, encoding: "utf8" }).trim();

	const postIncident = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository, { post_incident: true }),
		repositoryCwd: repository.repository,
	});
	assert.equal(postIncident.eligible, false);
	assert.match(postIncident.reason, /extraordinary review/i);

	git("-c", "user.name=Gate Test", "-c", "user.email=gate@example.invalid", "tag", "-a", "v2.0.0", "-m", "major", repository.finalCommit);
	const majorTagObject = git("rev-parse", "refs/tags/v2.0.0^{object}");
	const major = evaluateReleaseFastPathV1({
		target: { ...releaseTarget(repository), tag_ref: "refs/tags/v2.0.0", tag_object: majorTagObject },
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
	});
	assert.equal(major.eligible, false);
	assert.match(major.reason, /major releases require explicit extraordinary review/i);

	git("-c", "user.name=Gate Test", "-c", "user.email=gate@example.invalid", "tag", "-a", "nightly", "-m", "opaque", repository.finalCommit);
	const opaqueTagObject = git("rev-parse", "refs/tags/nightly^{object}");
	const opaque = evaluateReleaseFastPathV1({
		target: { ...releaseTarget(repository), tag_ref: "refs/tags/nightly", tag_object: opaqueTagObject },
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
	});
	assert.equal(opaque.eligible, false);
	assert.match(opaque.reason, /major release cannot be ruled out/i);
});

test("release fast path treats vX.0.0 and pre-1.0 v0.Y.0 minor bumps as major-equivalent, while v0.Y.Z patch releases remain eligible", (t) => {
	const repository = createGateRepository(t);
	setRemoteMain(repository, repository.finalCommit);
	const git = (...args: string[]): string =>
		execFileSync("git", args, { cwd: repository.repository, encoding: "utf8" }).trim();
	const tagRelease = (name: string): GateTargetV1 => {
		git("-c", "user.name=Gate Test", "-c", "user.email=gate@example.invalid", "tag", "-a", name, "-m", name, repository.finalCommit);
		const tagObject = git("rev-parse", `refs/tags/${name}^{object}`);
		return { ...releaseTarget(repository), tag_ref: `refs/tags/${name}`, tag_object: tagObject };
	};

	const v100 = evaluateReleaseFastPathV1({
		target: tagRelease("v1.0.0"),
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
		ghCommandRunner: successfulGhCommandRunner(repository.finalCommit),
	});
	assert.equal(v100.eligible, false, v100.reason);
	assert.match(v100.reason, /major releases require explicit extraordinary review/i);

	const v0160 = evaluateReleaseFastPathV1({
		target: tagRelease("v0.16.0"),
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
		ghCommandRunner: successfulGhCommandRunner(repository.finalCommit),
	});
	assert.equal(v0160.eligible, false, v0160.reason);
	assert.match(v0160.reason, /major releases require explicit extraordinary review/i);

	const v0151 = evaluateReleaseFastPathV1({
		target: tagRelease("v0.15.1"),
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
		ghCommandRunner: successfulGhCommandRunner(repository.finalCommit),
	});
	assert.equal(v0151.eligible, true, v0151.reason);
});

test("release fast path applies only to protected main with a provable remote head and exact tag identity", (t) => {
	const repository = createGateRepository(t);
	setRemoteMain(repository, repository.finalCommit);

	const wrongRef = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository, { protected_ref: "refs/heads/develop" }),
		repositoryCwd: repository.repository,
	});
	assert.equal(wrongRef.eligible, false);
	assert.match(wrongRef.reason, /protected refs\/heads\/main/i);

	execFileSync("git", ["--git-dir", repository.remotePath, "update-ref", "-d", "refs/heads/main"]);
	const missingRemoteHead = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
	});
	assert.equal(missingRemoteHead.eligible, false);
	assert.match(missingRemoteHead.reason, /cannot be proven/i);

	setRemoteMain(repository, repository.finalCommit);
	const forgedTag = evaluateReleaseFastPathV1({
		target: { ...releaseTarget(repository), tag_object: repository.finalCommit === repository.tagObject ? repository.baseCommit : repository.finalCommit },
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
	});
	assert.equal(forgedTag.eligible, false);
	const malformedObject = evaluateReleaseFastPathV1({
		target: { ...releaseTarget(repository), tag_object: "--help" },
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
	});
	assert.equal(malformedObject.eligible, false);
	assert.match(malformedObject.reason, /resolved object IDs/i);
});

test("release fast path denies a remote endpoint that is not the repository's actually configured remote name", (t) => {
	const repository = createGateRepository(t);
	setRemoteMain(repository, repository.finalCommit);

	const fileUrl = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository, { remote: `file://${repository.remotePath}` }),
		repositoryCwd: repository.repository,
	});
	assert.equal(fileUrl.eligible, false, "a file:// URL supplied as remote must not be eligible");

	const attackerPath = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository, { remote: repository.remotePath }),
		repositoryCwd: repository.repository,
	});
	assert.equal(attackerPath.eligible, false, "a bare filesystem path supplied as remote must not be eligible");

	const nonConfigured = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository, { remote: "not-a-configured-remote" }),
		repositoryCwd: repository.repository,
	});
	assert.equal(nonConfigured.eligible, false, "a remote name absent from the repository's configured remotes must not be eligible");

	// The actually configured remote name must still resolve.
	const configured = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository, { remote: "origin" }),
		repositoryCwd: repository.repository,
		ghCommandRunner: successfulGhCommandRunner(repository.finalCommit),
	});
	assert.equal(configured.eligible, true, configured.reason);
});

test("release fast path requires independently derived CI success via the gh CLI bound to the exact remote SHA — caller-supplied CI evidence alone is never sufficient", (t) => {
	const repository = createGateRepository(t);
	setRemoteMain(repository, repository.finalCommit);

	// Caller-supplied CI evidence self-reports success for the exact SHA, but
	// no gh command runner is supplied and the repository's remote is not a
	// real GitHub remote, so independent derivation is unprovable — the fast
	// path must fail closed rather than trust the self-report alone.
	const undeprovable = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
	});
	assert.equal(undeprovable.eligible, false, undeprovable.reason);
	assert.match(undeprovable.reason, /independently derived|gh CLI/i);

	// gh unavailable/erroring must fail closed.
	const ghUnavailable = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
		ghCommandRunner: () => ({ status: 1, stdout: "", error: new Error("gh: command not found") }),
	});
	assert.equal(ghUnavailable.eligible, false);
	assert.match(ghUnavailable.reason, /independently derived|gh CLI/i);

	// Derived success bound to the wrong SHA must still deny: the runner only
	// reports success for the base commit, never the exact remote head that
	// the fast path is required to query.
	const wrongShaBinding = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
		ghCommandRunner: successfulGhCommandRunner(repository.baseCommit),
	});
	assert.equal(wrongShaBinding.eligible, false);

	// Derived success bound to the exact remote SHA is eligible.
	const derived = evaluateReleaseFastPathV1({
		target: releaseTarget(repository),
		evidence: fastPathEvidence(repository),
		repositoryCwd: repository.repository,
		ghCommandRunner: successfulGhCommandRunner(repository.finalCommit),
	});
	assert.equal(derived.eligible, true, derived.reason);
});

test("release fast path remote head recheck detects an advanced or unresolvable protected main before tag push", (t) => {
	const repository = createGateRepository(t);
	setRemoteMain(repository, repository.finalCommit);
	const unchanged = recheckReleaseFastPathRemoteHeadV1({
		repositoryCwd: repository.repository,
		remote: repository.remote,
		expectedRemoteHead: repository.finalCommit,
	});
	assert.deepEqual(unchanged, { advanced: false, remote_head: repository.finalCommit });

	setRemoteMain(repository, repository.baseCommit);
	const advanced = recheckReleaseFastPathRemoteHeadV1({
		repositoryCwd: repository.repository,
		remote: repository.remote,
		expectedRemoteHead: repository.finalCommit,
	});
	assert.equal(advanced.advanced, true);

	execFileSync("git", ["--git-dir", repository.remotePath, "update-ref", "-d", "refs/heads/main"]);
	const missing = recheckReleaseFastPathRemoteHeadV1({
		repositoryCwd: repository.repository,
		remote: repository.remote,
		expectedRemoteHead: repository.finalCommit,
	});
	assert.deepEqual(missing, { advanced: true, remote_head: null });
});
