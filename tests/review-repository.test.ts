import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { publicationProbeGitEnvironment, resolveRepositoryAuthorityV1, reviewGitEnvironment, setReviewRepositoryIdentityRetryHookForTesting } from "../lib/review-repository.ts";
import { REVIEW_MODE, ReviewTransactionStore, createReviewState, setReviewMutationLockPlatformForTesting } from "../lib/review-transaction.ts";
import { REVIEW_LENS, REVIEW_ROUTE } from "../lib/review-triggers.ts";
import { qualifiedReviewLockPlatform, testSnapshot } from "./review-test-fixtures.ts";

setReviewMutationLockPlatformForTesting(qualifiedReviewLockPlatform());

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(t: test.TestContext): string {
	const parent = mkdtempSync(join(tmpdir(), "gentle-pi-review-repository-"));
	const root = join(parent, "repo");
	mkdirSync(root);
	git(root, "init", "-b", "main");
	git(root, "config", "user.email", "tests@example.com");
	git(root, "config", "user.name", "Tests");
	writeFileSync(join(root, "README.md"), "test\n");
	git(root, "add", "README.md");
	git(root, "commit", "-m", "initial");
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	return root;
}

function createLineage(cwd: string, lineageId = "pin-lineage"): void {
	const store = ReviewTransactionStore.forRepository(cwd);
	store.create(createReviewState({
		lineageId,
		mode: REVIEW_MODE.ORDINARY,
		snapshot: testSnapshot({ baseTree: "1".repeat(40), completeTree: "2".repeat(40), route: REVIEW_ROUTE.STANDARD, lenses: [REVIEW_LENS.RELIABILITY] }),
		evidenceHash: "a".repeat(64),
		budget: { review_batches: 1, review_actors: 1, refuter_batches: 1, fix_batches: 1, validator_runs: 1, final_verifications: 1, judgment_rounds: 0, judge_runs: 0 },
	}), "start");
	store.runReducerOperation({ lineageId, transition: "ordinary-discovery", idempotencyKey: "freeze", input: { rows: [] } });
}

function addOrphanRoot(root: string, branch: string, file: string): void {
	git(root, "checkout", "--orphan", branch);
	writeFileSync(join(root, file), `${file}\n`);
	git(root, "add", file);
	git(root, "commit", "-m", `orphan root on ${branch}`);
	git(root, "checkout", "main");
}

test("review Git environment uses a Git-compatible null config path on Windows", () => {
	const environment = reviewGitEnvironment();
	assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
	assert.equal(environment.GIT_CONFIG_SYSTEM, "/dev/null");
});

test("review Git environment runs a real Git authority probe", (t) => {
	const root = repository(t);
	const commonDirectory = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd: root,
		encoding: "utf8",
		env: reviewGitEnvironment(),
	}).trim();
	assert.equal(resolve(commonDirectory), resolve(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")));
});

test("review Git environment rejects inherited unsafe Git overrides", () => {
	const prior = process.env.GIT_DIR;
	try {
		process.env.GIT_DIR = "/unsafe";
		assert.throws(() => reviewGitEnvironment(), /REVIEW_GIT_ENV_UNSAFE/);
	} finally {
		if (prior === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = prior;
	}
});

// gentle-shell#2552: the unit-test runner pins the config-file keys for
// hermeticity, and reviewGitEnvironment overrides them itself, so inherited
// values must be tolerated instead of failing closed; routing overrides do not.
test("review Git environment tolerates inherited config-file keys and still pins them", () => {
	const prior = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
	try {
		process.env.GIT_CONFIG_GLOBAL = "/hostile/global.gitconfig";
		process.env.GIT_CONFIG_NOSYSTEM = "1";
		const environment = reviewGitEnvironment();
		assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
		assert.equal(environment.GIT_CONFIG_SYSTEM, "/dev/null");
		assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
		process.env.GIT_CONFIG_COUNT = "1";
		assert.throws(() => reviewGitEnvironment(), /REVIEW_GIT_ENV_UNSAFE/);
	} finally {
		for (const [key, value] of Object.entries(prior)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

// gentle-shell#2552: deleting the config-file keys makes the probe fall back to
// the host's default config paths, so inherited pins must survive while every
// routing override is still dropped.
test("publication probe keeps inherited config-file pins and drops routing overrides", () => {
	const prior = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 };
	try {
		process.env.GIT_CONFIG_GLOBAL = "/pinned/global.gitconfig";
		process.env.GIT_CONFIG_SYSTEM = "/pinned/system.gitconfig";
		process.env.GIT_CONFIG_NOSYSTEM = "1";
		process.env.GIT_DIR = "/unsafe";
		process.env.GIT_CONFIG_COUNT = "1";
		process.env.GIT_CONFIG_KEY_0 = "user.name";
		process.env.GIT_CONFIG_VALUE_0 = "injected";
		const environment = publicationProbeGitEnvironment();
		assert.equal(environment.GIT_CONFIG_GLOBAL, "/pinned/global.gitconfig");
		assert.equal(environment.GIT_CONFIG_SYSTEM, "/pinned/system.gitconfig");
		assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
		assert.equal(environment.GIT_DIR, undefined);
		assert.equal(environment.GIT_CONFIG_COUNT, undefined);
		assert.equal(environment.GIT_CONFIG_KEY_0, undefined);
		assert.equal(environment.GIT_CONFIG_VALUE_0, undefined);
	} finally {
		for (const [key, value] of Object.entries(prior)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("a Windows drive-letter Git common directory resolves repository authority", { skip: process.platform !== "win32" }, (t) => {
	const root = repository(t);
	const commonDirectory = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
	assert.match(commonDirectory, /^[A-Za-z]:[\\/]/);
	const storeRoot = join(commonDirectory, "gentle-ai", "reviews");
	mkdirSync(storeRoot, { recursive: true });
	writeFileSync(join(storeRoot, "IDENTITY"), JSON.stringify({
		object_format: "sha1",
		root_commit_ids: [git(root, "rev-list", "--max-parents=0", "--all")],
		schema: "gentle-ai.review-repository/v1",
	}));
	assert.equal(resolveRepositoryAuthorityV1(root).common_directory, resolve(commonDirectory));
});

test("linked worktrees resolve one common-directory authority", (t) => {
	const root = repository(t);
	const linked = join(root, "..", "linked");
	git(root, "worktree", "add", "-b", "linked", linked);
	const primary = resolveRepositoryAuthorityV1(root);
	const other = resolveRepositoryAuthorityV1(linked);
	assert.equal(primary.store_root, other.store_root);
	assert.equal(primary.repository_id, other.repository_id);
	assert.equal(primary.authority_id, other.authority_id);
});

test("non-Git directories and empty repositories fail closed", (t) => {
	const outside = mkdtempSync(join(tmpdir(), "gentle-pi-not-git-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	assert.throws(() => resolveRepositoryAuthorityV1(outside), /Git common directory|repository/i);
	git(outside, "init");
	assert.throws(() => resolveRepositoryAuthorityV1(outside), /root commit anchors/i);
});

test("repository identity is pinned once and reused on later resolutions", (t) => {
	const root = repository(t);
	const first = resolveRepositoryAuthorityV1(root);
	const second = resolveRepositoryAuthorityV1(root);
	assert.equal(first.repository_id, second.repository_id);
	assert.equal(first.authority_id, second.authority_id);
	assert.deepEqual(first.repository_identity.root_commit_ids, second.repository_identity.root_commit_ids);
});

test("an orphan root added after store establishment leaves identity unchanged and reads/mutations still succeed", (t) => {
	const root = repository(t);
	createLineage(root);
	const before = resolveRepositoryAuthorityV1(root);

	addOrphanRoot(root, "gh-pages", "orphan.txt");

	const after = resolveRepositoryAuthorityV1(root);
	assert.equal(after.repository_id, before.repository_id);
	assert.equal(after.authority_id, before.authority_id);
	assert.deepEqual(after.repository_identity.root_commit_ids, before.repository_identity.root_commit_ids);

	assert.equal(ReviewTransactionStore.forRepository(root).read("pin-lineage").lineage_id, "pin-lineage");
	createLineage(root, "pin-lineage-2");
	assert.equal(ReviewTransactionStore.forRepository(root).read("pin-lineage-2").lineage_id, "pin-lineage-2");
});

test("a store transplanted into an unrelated repository fails closed", (t) => {
	const source = repository(t);
	createLineage(source);
	const sourceCommonDirectory = git(source, "rev-parse", "--path-format=absolute", "--git-common-dir");
	const sourceStoreRoot = join(sourceCommonDirectory, "gentle-ai", "reviews");

	const otherParent = mkdtempSync(join(tmpdir(), "gentle-pi-review-repository-unrelated-"));
	t.after(() => rmSync(otherParent, { recursive: true, force: true }));
	const other = join(otherParent, "repo");
	mkdirSync(other);
	git(other, "init", "-b", "main");
	git(other, "config", "user.email", "tests@example.com");
	git(other, "config", "user.name", "Tests");
	writeFileSync(join(other, "README.md"), "unrelated\n");
	git(other, "add", "README.md");
	git(other, "commit", "-m", "unrelated initial");
	const otherCommonDirectory = git(other, "rev-parse", "--path-format=absolute", "--git-common-dir");
	const otherStoreRoot = join(otherCommonDirectory, "gentle-ai", "reviews");
	mkdirSync(dirname(otherStoreRoot), { recursive: true });
	cpSync(sourceStoreRoot, otherStoreRoot, { recursive: true });

	assert.throws(() => resolveRepositoryAuthorityV1(other), /pinned|authority/i);
});

test("removing a pinned root commit via history rewrite violates the subset and fails closed", (t) => {
	const root = repository(t);
	addOrphanRoot(root, "second-root", "second.txt");
	const established = resolveRepositoryAuthorityV1(root);
	assert.equal(established.repository_identity.root_commit_ids.length, 2);

	git(root, "branch", "-D", "second-root");

	assert.throws(() => resolveRepositoryAuthorityV1(root), /pinned|authority/i);
});

test("a reader racing the first-time IDENTITY write recovers once the concurrent writer completes, instead of dying on a transient partial read", (t) => {
	const root = repository(t);
	const commonDirectory = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
	const storeRoot = join(commonDirectory, "gentle-ai", "reviews");
	mkdirSync(storeRoot, { recursive: true });
	const identityPath = join(storeRoot, "IDENTITY");
	// Simulate a concurrent writer's O_CREAT|O_EXCL having claimed the slot
	// (the file is now visible) before its content has been fully written —
	// exactly the window `writeFileSync(..., { flag: "wx" })` can leave open.
	writeFileSync(identityPath, Buffer.alloc(0), { flag: "wx" });
	const rootCommit = git(root, "rev-parse", "HEAD");
	const objectFormat = git(root, "rev-parse", "--show-object-format");
	const validBody = `{"object_format":"${objectFormat}","root_commit_ids":["${rootCommit}"],"schema":"gentle-ai.review-repository/v1"}`;

	let hookCalls = 0;
	setReviewRepositoryIdentityRetryHookForTesting(() => {
		hookCalls += 1;
		writeFileSync(identityPath, validBody, { flag: "r+" });
	});
	t.after(() => setReviewRepositoryIdentityRetryHookForTesting(undefined));

	const authority = resolveRepositoryAuthorityV1(root);
	assert.equal(hookCalls, 1);
	assert.deepEqual(authority.repository_identity.root_commit_ids, [rootCommit]);
});
