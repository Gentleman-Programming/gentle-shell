import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readReviewConsentLatch, recordReviewConsentLatch, REVIEW_CONSENT_LATCH_SCHEMA } from "../lib/review-consent-latch.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(t: test.TestContext): string {
	const parent = mkdtempSync(join(tmpdir(), "drakonc-pi-review-consent-latch-"));
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

test("no latch is recorded by default", (t) => {
	const cwd = repository(t);
	assert.equal(readReviewConsentLatch(cwd), false);
});

test("recording the latch is one-way: it reads back true, forever, with exact canonical bytes at mode 0600", (t) => {
	const cwd = repository(t);
	recordReviewConsentLatch(cwd);
	assert.equal(readReviewConsentLatch(cwd), true);

	const commonDir = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
	const path = join(commonDir, "drakonc-pi", "review-consent", "asked.json");
	const bytes = readFileSync(path, "utf8");
	assert.equal(bytes, `{"schema":"${REVIEW_CONSENT_LATCH_SCHEMA}"}\n`);
	assert.equal(REVIEW_CONSENT_LATCH_SCHEMA, "drakonc-pi.review-consent-asked/v1");
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);

	// Idempotent: recording again does not throw and the latch stays set.
	recordReviewConsentLatch(cwd);
	assert.equal(readReviewConsentLatch(cwd), true);
});

test("a linked worktree of the same clone shares one latch via the git common directory", (t) => {
	const cwd = repository(t);
	const worktreeParent = mkdtempSync(join(tmpdir(), "drakonc-pi-review-consent-latch-worktree-"));
	t.after(() => rmSync(worktreeParent, { recursive: true, force: true }));
	const worktree = join(worktreeParent, "wt");
	git(cwd, "worktree", "add", "-b", "feature", worktree);

	recordReviewConsentLatch(cwd);
	assert.equal(readReviewConsentLatch(worktree), true);
});

test("an unresolvable (non-Git) directory throws rather than silently reporting a latch", () => {
	const outside = mkdtempSync(join(tmpdir(), "drakonc-pi-review-consent-latch-not-git-"));
	try {
		assert.throws(() => readReviewConsentLatch(outside));
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
});
