import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REVIEW_MODE, ReviewTransactionStore, createReviewState } from "../lib/review-transaction.ts";
import { REVIEW_LENS, REVIEW_ROUTE } from "../lib/review-triggers.ts";
import { qualifiedReviewLockPlatform, testSnapshot } from "./review-test-fixtures.ts";

const tree = (digit: string) => digit.repeat(40);

function repository(t: test.TestContext): string {
	const parent = mkdtempSync(join(tmpdir(), "drakonc-pi-review-authority-"));
	const cwd = join(parent, "repo");
	mkdirSync(cwd);
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	git("init", "-b", "main");
	writeFileSync(join(cwd, "file.txt"), "authority\n");
	git("add", ".");
	git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
	return cwd;
}

test("repository facade mutates under the portable atomic mkdir authority lock", (t) => {
	const cwd = repository(t);
	const store = ReviewTransactionStore.forRepository(cwd);
	const state = createReviewState({
		lineageId: "authority-lineage",
		mode: REVIEW_MODE.ORDINARY,
		snapshot: testSnapshot({ baseTree: tree("1"), completeTree: tree("2"), route: REVIEW_ROUTE.STANDARD, lenses: [REVIEW_LENS.READABILITY] }),
		evidenceHash: "a".repeat(64),
		budget: { review_batches: 1, review_actors: 1, refuter_batches: 1, fix_batches: 1, validator_runs: 1, final_verifications: 1, judgment_rounds: 0, judge_runs: 0 },
	});
	assert.equal(store.create(state, "start").revision, 0);
});
