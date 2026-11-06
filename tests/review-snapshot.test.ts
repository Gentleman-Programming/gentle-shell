import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	SNAPSHOT_CLEANUP_ACTION,
	SNAPSHOT_CLEANUP_TRIGGER,
	REVIEW_PROJECTION,
	captureReviewSnapshot,
	captureLiveReviewCandidateBinding,
	cleanupReviewSnapshot,
	type CaptureReviewSnapshotOptions,
	type ReviewProjectionV1,
	type SnapshotV1,
} from "../lib/review-snapshot.ts";
import {
	REVIEW_MODE,
	createReviewState,
	type ReviewBudgetV1,
} from "../lib/review-transaction.ts";
import { REVIEW_LENS, REVIEW_ROUTE } from "../lib/review-triggers.ts";

function judgmentDayBudget(): ReviewBudgetV1 {
	return {
		review_batches: 1,
		review_actors: 2,
		refuter_batches: 0,
		fix_batches: 2,
		validator_runs: 0,
		final_verifications: 1,
		judgment_rounds: 2,
		judge_runs: 6,
	};
}

function snapshotGit(snapshot: SnapshotV1, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd: snapshot.repository_root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_OBJECT_DIRECTORY: snapshot.object_store.object_directory,
			GIT_ALTERNATE_OBJECT_DIRECTORIES:
				snapshot.object_store.alternate_object_directory,
		},
	}).trim();
}

function createRepository(t: test.TestContext): {
	repository: string;
	git: (...args: string[]) => string;
} {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-snapshot-")));
	const repository = join(parent, "repo");
	mkdirSync(repository);
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const git = (...args: string[]): string =>
		execFileSync("git", args, {
			cwd: repository,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "-b", "main");
	writeFileSync(join(repository, "tracked.txt"), "base\n");
	writeFileSync(join(repository, ".gitignore"), "ignored.txt\n");
	git("add", ".");
	git(
		"-c",
		"user.name=Gentle Pi Tests",
		"-c",
		"user.email=gentle-pi@example.invalid",
		"commit",
		"-m",
		"base",
	);
	return { repository, git };
}

test("complete snapshot captures the repository root from a nested cwd without mutating index or worktree", (t) => {
	const { repository, git } = createRepository(t);
	const nested = join(repository, "packages", "app");
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(repository, "tracked.txt"), "working tree\n");
	writeFileSync(join(repository, "untracked.txt"), "included\n");
	writeFileSync(join(nested, "nested.txt"), "nested\n");
	writeFileSync(join(repository, "ignored.txt"), "excluded\n");
	const indexPath = join(git("rev-parse", "--absolute-git-dir"), "index");
	assert.equal(existsSync(indexPath), true);
	const indexBefore = readFileSync(indexPath);
	const statusBefore = git("status", "--porcelain=v1", "--untracked-files=all");

	const snapshot = captureReviewSnapshot({
		cwd: nested,
		mode: REVIEW_MODE.ORDINARY,
		projection: { kind: REVIEW_PROJECTION.COMPLETE },
		policyHash: "a".repeat(64),
	});

	assert.equal(snapshot.repository_root, repository);
	assert.equal(snapshot.base_tree, git("rev-parse", "HEAD^{tree}"));
	assert.equal(snapshot.initial_review_tree, snapshot.complete_snapshot_tree);
	assert.deepEqual(snapshot.review_projection, { kind: "complete" });
	assert.equal(snapshot.route, REVIEW_ROUTE.STANDARD);
	assert.deepEqual(snapshot.lenses, [REVIEW_LENS.READABILITY]);
	assert.equal(snapshot.policy_hash, "a".repeat(64));
	assert.deepEqual(
		snapshotGit(snapshot, "ls-tree", "-r", "--name-only", snapshot.complete_snapshot_tree)
			.split("\n")
			.filter(Boolean)
			.toSorted(),
		[".gitignore", "packages/app/nested.txt", "tracked.txt", "untracked.txt"],
	);
	assert.equal(
		snapshotGit(snapshot, "show", `${snapshot.complete_snapshot_tree}:tracked.txt`),
		"working tree",
	);
	assert.deepEqual(readFileSync(indexPath), indexBefore);
	assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
});

test("ephemeral live candidate binding derives the complete candidate without retaining a snapshot", (t) => {
	const { repository, git } = createRepository(t);
	writeFileSync(join(repository, "tracked.txt"), "working tree\n");
	writeFileSync(join(repository, "untracked.txt"), "included\n");
	const snapshots = join(repository, ".git", "gentle-ai", "reviews", "snapshots");
	const indexPath = join(git("rev-parse", "--absolute-git-dir"), "index");
	const indexBefore = readFileSync(indexPath);
	const statusBefore = git("status", "--porcelain=v1", "--untracked-files=all");

	const binding = captureLiveReviewCandidateBinding({
		cwd: repository,
		repositoryId: "repository-authority-id",
	});

	assert.equal(binding.repository_id, "repository-authority-id");
	assert.equal(binding.base_tree, git("rev-parse", "HEAD^{tree}"));
	assert.equal(binding.complete_snapshot_tree, binding.initial_review_tree);
	assert.deepEqual(binding.genesis_paths, ["tracked.txt", "untracked.txt"]);
	assert.deepEqual(binding.intended_untracked, ["untracked.txt"]);
	assert.deepEqual(readFileSync(indexPath), indexBefore);
	assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
	assert.equal(existsSync(snapshots), false);
});

test("intended-commit projection binds its resolved tree while complete snapshot retains later scope", (t) => {
	const { repository, git } = createRepository(t);
	writeFileSync(join(repository, "tracked.txt"), "intended\n");
	git("add", "tracked.txt");
	const intendedTree = git("write-tree");
	writeFileSync(join(repository, "tracked.txt"), "later working change\n");
	writeFileSync(join(repository, "later.txt"), "complete scope only\n");
	const indexPath = join(git("rev-parse", "--absolute-git-dir"), "index");
	const indexBefore = readFileSync(indexPath);

	const snapshot = captureReviewSnapshot({
		cwd: repository,
		mode: REVIEW_MODE.ORDINARY,
		projection: { kind: REVIEW_PROJECTION.INTENDED_COMMIT, tree: intendedTree },
		policyHash: "b".repeat(64),
	});

	assert.deepEqual(snapshot.review_projection, {
		kind: "intended-commit",
		tree: intendedTree,
	});
	assert.equal(snapshot.initial_review_tree, intendedTree);
	assert.notEqual(snapshot.complete_snapshot_tree, intendedTree);
	assert.equal(snapshotGit(snapshot, "show", `${snapshot.initial_review_tree}:tracked.txt`), "intended");
	assert.equal(
		snapshotGit(snapshot, "show", `${snapshot.complete_snapshot_tree}:tracked.txt`),
		"later working change",
	);
	assert.equal(
		snapshotGit(snapshot, "show", `${snapshot.complete_snapshot_tree}:later.txt`),
		"complete scope only",
	);
	assert.deepEqual(snapshot.genesis_paths, ["tracked.txt"]);
	assert.deepEqual(readFileSync(indexPath), indexBefore);
});

test("snapshot derives its ordinary route and selected lenses from the captured diff", (t) => {
	const { repository } = createRepository(t);
	writeFileSync(join(repository, "tracked.txt"), "non-trivial source change\n");
	const callerAttempt = {
		cwd: repository,
		mode: REVIEW_MODE.ORDINARY,
		projection: { kind: REVIEW_PROJECTION.COMPLETE },
		policyHash: "d".repeat(64),
		route: REVIEW_ROUTE.TRIVIAL,
		lenses: [],
	} as unknown as CaptureReviewSnapshotOptions;

	const snapshot = captureReviewSnapshot(callerAttempt);

	assert.equal(snapshot.route, REVIEW_ROUTE.STANDARD);
	assert.deepEqual(snapshot.lenses, [REVIEW_LENS.READABILITY]);
	assert.equal(snapshot.diff_evidence.changedLines, 2);
});

test("generated testdata goldens stay in snapshot identity but not authored risk lines", (t) => {
	const { repository } = createRepository(t);
	mkdirSync(join(repository, "testdata", "golden"), { recursive: true });
	writeFileSync(join(repository, "testdata", "golden", "adapter.golden"), `${"generated\n".repeat(500)}`);
	writeFileSync(join(repository, "tracked.txt"), "authored change\n");
	const snapshot = captureReviewSnapshot({
		cwd: repository,
		mode: REVIEW_MODE.ORDINARY,
		projection: { kind: REVIEW_PROJECTION.COMPLETE },
		policyHash: "a".repeat(64),
	});
	assert.equal(snapshot.original_changed_lines, 2);
	assert.equal(snapshot.correction_budget, 1);
	assert.ok(snapshot.genesis_paths?.includes("testdata/golden/adapter.golden"));
	assert.ok(snapshotGit(snapshot, "ls-tree", "-r", "--name-only", snapshot.initial_review_tree).includes("testdata/golden/adapter.golden"));
});

test("explicit Judgment Day captures non-trivial scope without ordinary classification", (t) => {
	const { repository } = createRepository(t);
	writeFileSync(join(repository, "tracked.txt"), "non-trivial Judgment Day change\n");

	const snapshot = captureReviewSnapshot({
		cwd: repository,
		mode: REVIEW_MODE.JUDGMENT_DAY,
		projection: { kind: REVIEW_PROJECTION.COMPLETE },
		policyHash: "f".repeat(64),
	});
	const state = createReviewState({
		lineageId: "explicit-judgment-day",
		mode: REVIEW_MODE.JUDGMENT_DAY,
		snapshot,
		evidenceHash: "e".repeat(64),
		budget: judgmentDayBudget(),
	});

	assert.equal(snapshot.mode, REVIEW_MODE.JUDGMENT_DAY);
	assert.equal(snapshot.diff_evidence.executableChanged, true);
	assert.equal(snapshot.route, REVIEW_ROUTE.TRIVIAL);
	assert.deepEqual(snapshot.lenses, []);
	assert.equal(state.mode, REVIEW_MODE.JUDGMENT_DAY);
	assert.equal(state.initial_review_tree, snapshot.complete_snapshot_tree);
});

test("isolated snapshot objects survive live Git GC until explicit sensitive-object cleanup", (t) => {
	const { repository, git } = createRepository(t);
	writeFileSync(join(repository, "tracked.txt"), "sensitive workspace value\n");
	const snapshot = captureReviewSnapshot({
		cwd: repository,
		mode: REVIEW_MODE.ORDINARY,
		projection: { kind: REVIEW_PROJECTION.COMPLETE },
		policyHash: "e".repeat(64),
	});

	assert.equal(snapshot.object_store.cleanup_trigger, SNAPSHOT_CLEANUP_TRIGGER.LINEAGE_TERMINAL);
	assert.equal(snapshot.object_store.cleanup_action, SNAPSHOT_CLEANUP_ACTION.DELETE_ISOLATED_STORE);
	assert.equal(existsSync(snapshot.object_store.metadata_path), true);
	assert.throws(() => git("cat-file", "-e", `${snapshot.complete_snapshot_tree}^{tree}`));
	git("gc", "--prune=now");
	assert.equal(
		snapshotGit(snapshot, "show", `${snapshot.complete_snapshot_tree}:tracked.txt`),
		"sensitive workspace value",
	);

	cleanupReviewSnapshot(snapshot);
	assert.equal(existsSync(snapshot.object_store.snapshot_directory), false);
	assert.throws(
		() => snapshotGit(snapshot, "cat-file", "-e", `${snapshot.complete_snapshot_tree}^{tree}`),
	);
});

test("snapshot rejects unsupported and unresolved projections without changing the real index", (t) => {
	const { repository, git } = createRepository(t);
	const indexPath = join(git("rev-parse", "--absolute-git-dir"), "index");
	const indexBefore = readFileSync(indexPath);
	const common = {
		cwd: repository,
		mode: REVIEW_MODE.ORDINARY,
		policyHash: "c".repeat(64),
	};

	assert.throws(
		() =>
			captureReviewSnapshot({
				...common,
				projection: { kind: "branch" } as unknown as ReviewProjectionV1,
			}),
		/Unsupported review projection/,
	);
	assert.throws(
		() =>
			captureReviewSnapshot({
				...common,
				projection: {
					kind: REVIEW_PROJECTION.INTENDED_COMMIT,
					tree: "f".repeat(40),
				},
			}),
		/cannot be resolved/,
	);
	assert.deepEqual(readFileSync(indexPath), indexBefore);
});

test("ordinary snapshots bind canonical genesis paths", (t) => {
	const { repository } = createRepository(t);
	writeFileSync(join(repository, "requirements.txt"), "package==1\n");
	writeFileSync(join(repository, "CMakeLists.txt"), "project(example)\n");
	writeFileSync(join(repository, "guide.mdx"), "export const executable = true;\n");
	writeFileSync(join(repository, "README.sh"), "#!/bin/sh\ntrue\n");
	const snapshot = captureReviewSnapshot({
		cwd: repository,
		mode: REVIEW_MODE.ORDINARY,
		projection: { kind: REVIEW_PROJECTION.COMPLETE },
		policyHash: "d".repeat(64),
	});
	assert.deepEqual(snapshot.genesis_paths, [
		"CMakeLists.txt",
		"README.sh",
		"guide.mdx",
		"requirements.txt",
	]);
});
