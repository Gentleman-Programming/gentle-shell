import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as shell from "../extensions/gentle-shell.ts";
import { fileDiffArgs, loadFileDiff, runFileDiff } from "../lib/change-diff.ts";
import { CHANGE_STATUS, DIFF_MAX_BYTES, DIFF_TOO_LARGE } from "../lib/shell-changes.ts";

// The `/gentle:changes` panel and Desktop RPC read one file's diff through the
// same lib module, so both show the same text (#3322, S6).

function tempRepo(t: test.TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-change-diff-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
	git("init", "-q", "--initial-branch=main");
	writeFileSync(join(root, "tracked.txt"), "base\n");
	git("add", "tracked.txt");
	git("commit", "-q", "-m", "base");
	return { root, git };
}

test("the shell's loadFileDiff is the shared lib function, unchanged for the panel", () => {
	assert.equal(shell.loadFileDiff, loadFileDiff, "the TUI panel and the RPC slice import one implementation");
});

test("fileDiffArgs keeps the panel's HEAD diff and empty-file diff for untracked files", () => {
	assert.deepEqual(fileDiffArgs({ path: "lib/a.ts", status: CHANGE_STATUS.MODIFIED }), ["diff", "HEAD", "--", "lib/a.ts"]);
	assert.deepEqual(fileDiffArgs({ path: "lib/a.ts", status: CHANGE_STATUS.DELETED }), ["diff", "HEAD", "--", "lib/a.ts"]);
	assert.deepEqual(fileDiffArgs({ path: "notes.md", status: CHANGE_STATUS.UNTRACKED }), ["diff", "--no-index", "--", "/dev/null", "notes.md"]);
});

test("real Git on this platform: tracked and untracked diffs, and the panel bound", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "tracked.txt"), "changed\n");
	writeFileSync(join(repo.root, "new.txt"), "hello\n");
	const run = shell.shellGitRunner(repo.root, process.env, undefined, DIFF_MAX_BYTES);

	const tracked = await loadFileDiff(run, { path: "tracked.txt", added: 1, deleted: 1, status: CHANGE_STATUS.MODIFIED });
	assert.match(tracked, /^diff --git a\/tracked\.txt b\/tracked\.txt/);
	assert.match(tracked, /-base\n\+changed\n/);

	// `/dev/null` is Git's own empty-file spelling, on Windows too.
	const untracked = await loadFileDiff(run, { path: "new.txt", added: 1, deleted: 0, status: CHANGE_STATUS.UNTRACKED });
	assert.match(untracked, /new file mode/);
	assert.match(untracked, /\+hello\n/);
	const raw = await runFileDiff(run, { path: "new.txt", status: CHANGE_STATUS.UNTRACKED });
	assert.equal(raw.code, 1, "a no-index diff with content exits 1");
	assert.equal(raw.stdout, untracked, "the panel shows Git's text as-is");

	writeFileSync(join(repo.root, "tracked.txt"), "line\n".repeat(DIFF_MAX_BYTES / 4));
	assert.equal(await loadFileDiff(run, { path: "tracked.txt", added: 1, deleted: 1, status: CHANGE_STATUS.MODIFIED }), DIFF_TOO_LARGE, "past the bound the panel shows its notice");
	assert.equal(await loadFileDiff(async () => ({ stdout: "partial", code: 128 }), { path: "tracked.txt", added: 0, deleted: 0, status: CHANGE_STATUS.MODIFIED }), "", "a Git failure shows nothing");
});
