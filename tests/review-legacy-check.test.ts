import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReviewTransactionStore } from "../lib/review-transaction.ts";

function repository(): string {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "legacy-check-")));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
	git("init", "-q");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git("add", "a.txt");
	git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
	return repo;
}

test("pre-graph legacy review data refuses with the directories to remove and deletes nothing", () => {
	const repo = repository();
	const lineages = join(repo, ".git", "gentle-ai", "reviews", "lineages");
	const locks = join(repo, ".git", "gentle-ai", "reviews", "locks");
	mkdirSync(join(lineages, "old"), { recursive: true });
	mkdirSync(locks, { recursive: true });
	assert.throws(
		() => ReviewTransactionStore.forRepository(repo),
		{ message: `legacy review authority data is no longer supported; remove these directories to continue: ${lineages}, ${locks}` },
	);
	assert.ok(existsSync(join(lineages, "old")));
	assert.ok(existsSync(locks));
});

test("a repository without legacy review data opens the graph store", () => {
	const repo = repository();
	assert.ok(ReviewTransactionStore.forRepository(repo));
	mkdirSync(join(repo, ".git", "gentle-ai", "reviews", "control"), { recursive: true });
	assert.ok(ReviewTransactionStore.forRepository(repo));
});
