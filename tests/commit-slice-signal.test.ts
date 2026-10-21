import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { commitSliceReport, commitSliceToolResult, commitTargetDirectory, isGitCommitCommand } from "../lib/commit-slice-signal.ts";

// Harness roadmap T4 (R1): the ~400-line slice rule lived in the prompt and the
// model had to estimate line counts. After each parent commit the runtime now
// reports the authored changed lines on the branch, so slicing reads a number.

function repo(t: TestContext): { dir: string; git: (...args: string[]) => string; commitFile: (path: string, lines: number) => void } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "commit-slice-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
	const commitFile = (path: string, lines: number) => {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") + "\n");
		git("add", "--", path);
		git("commit", "-q", "-m", `add ${path}`);
	};
	git("init", "-q", "-b", "main");
	commitFile("README.md", 3);
	return { dir, git, commitFile };
}

test("isGitCommitCommand recognizes commits inside shell commands, nothing else", () => {
	for (const command of ["git commit -m 'feat: x'", "git add -A && git commit -qm x", "cd pkg && git -C . commit --amend --no-edit", "git -c user.name=a commit -m x"]) {
		assert.equal(isGitCommitCommand(command), true, command);
	}
	for (const command of ["git status", "git log --grep commit", "echo git commit", "npm test", "git commit-tree abc"]) {
		assert.equal(isGitCommitCommand(command), false, command);
	}
});

// R1 review advisory: any `echo ... git` segment hid a real commit elsewhere in
// the command, while text that only mentioned `git commit` counted as one.
test("isGitCommitCommand counts a git invocation that starts a shell segment, not text that mentions one", () => {
	for (const command of ["echo 'staging git files' && git commit -m x", "echo git status; git commit -m x", "GIT_AUTHOR_DATE=now git commit -m x", "(cd pkg && git commit -m x)", "git add -A\ngit commit -m x", "git commit -m 'feat: git commit counting'"]) {
		assert.equal(isGitCommitCommand(command), true, command);
	}
	for (const command of ["printf 'run git commit now'", "gh pr create --body \"then git commit -m x\"", "grep -rn 'git commit' docs", "echo \"git commit -m x\""]) {
		assert.equal(isGitCommitCommand(command), false, command);
	}
});

test("commitTargetDirectory follows git -C and a leading cd", () => {
	assert.equal(commitTargetDirectory("git commit -m x", "/work/repo"), "/work/repo");
	assert.equal(commitTargetDirectory("git -C ../other commit -m x", "/work/repo"), "/work/other");
	assert.equal(commitTargetDirectory("cd /tmp/x && git commit -m x", "/work/repo"), "/tmp/x");
});

// PR #2290 review: only a leading `cd <dir> &&` moved the count, so a commit after
// `cd <dir>;` or a later `cd` counted the session cwd instead.
test("commitTargetDirectory follows a cd that precedes the commit through ;, && or ||", () => {
	assert.equal(commitTargetDirectory("cd /tmp/x; git commit -m x", "/work/repo"), "/tmp/x");
	assert.equal(commitTargetDirectory("git add -A && cd pkg && git commit -m x", "/work/repo"), "/work/repo/pkg");
	assert.equal(commitTargetDirectory("cd /tmp/x || exit 1; git commit -m x", "/work/repo"), "/tmp/x");
	assert.equal(commitTargetDirectory("cd a && cd 'b c'\ngit -C d commit -m x", "/work/repo"), "/work/repo/a/b c/d");
	assert.equal(commitTargetDirectory("git commit -m x && cd /tmp/x", "/work/repo"), "/work/repo", "a cd after the commit does not move it");
});

test("a feature branch reports authored changed lines since the default branch, lock files excluded", async (t) => {
	const { dir, git, commitFile } = repo(t);
	git("switch", "-q", "-c", "feat/slice");
	commitFile("src/a.ts", 120);
	commitFile("pnpm-lock.yaml", 900);
	commitFile("tests/a.test.ts", 30);
	const report = await commitSliceReport(dir);
	assert.match(report ?? "", /^Commit slice: 150 authored changed lines in 3 commits on feat\/slice since main/);
	assert.match(report ?? "", /250 lines left before the ~400-line slice/);
});

// PR #2290 review: `--no-renames` counted a moved file as all of its lines deleted
// and added again; rename detection counts only what the move changed.
test("a move-only commit counts no authored lines", async (t) => {
	const { dir, git, commitFile } = repo(t);
	commitFile("src/old.ts", 120);
	git("switch", "-q", "-c", "feat/move");
	git("mv", "src/old.ts", "src/new.ts");
	git("commit", "-q", "-m", "move src/old.ts");
	assert.match(await commitSliceReport(dir) ?? "", /^Commit slice: 0 authored changed lines in 1 commit on feat\/move/);
	git("mv", "src/new.ts", "src/newer.ts");
	appendFileSync(join(dir, "src/newer.ts"), "line 120\n");
	git("commit", "-qam", "move and extend src/new.ts");
	assert.match(await commitSliceReport(dir) ?? "", /^Commit slice: 1 authored changed lines in 2 commits on feat\/move/, "a move that edits counts only the edit");
});

// PR #2290 review: Git quotes an unusual path in plain numstat output, so the
// trailing quote hid a lock file from the generated-file filter.
test("a lock file whose path Git quotes is still excluded", async (t) => {
	const { dir, git, commitFile } = repo(t);
	git("switch", "-q", "-c", "feat/quoted");
	commitFile("packages/caf\u00e9/pnpm-lock.yaml", 900);
	commitFile("src/a.ts", 10);
	assert.match(git("-c", "core.quotePath=true", "diff", "--numstat", "main", "HEAD"), /"packages\/caf\\303\\251\/pnpm-lock\.yaml"/, "the fixture path needs quoting");
	assert.match(await commitSliceReport(dir) ?? "", /^Commit slice: 10 authored changed lines in 2 commits on feat\/quoted/);
});

test("past ~400 lines the report says to apply the delivery strategy before the next commit", async (t) => {
	const { dir, git, commitFile } = repo(t);
	git("switch", "-q", "-c", "feat/big");
	commitFile("src/big.ts", 450);
	assert.match(await commitSliceReport(dir) ?? "", /450 authored changed lines in 1 commit on feat\/big since main\b.*Past the ~400-line slice: apply the feature's delivery strategy before the next commit/);
});

// R1 review advisory: the report ran git synchronously in the parent's
// tool_result handler, so the interface froze for as long as git took.
test("the parent keeps running while git computes the report", async (t) => {
	const { dir, git, commitFile } = repo(t);
	git("switch", "-q", "-c", "feat/async");
	commitFile("src/a.ts", 10);
	let ran = false;
	setImmediate(() => { ran = true; });
	const report = await commitSliceReport(dir);
	assert.equal(ran, true, "the event loop ran while git answered");
	assert.match(report ?? "", /^Commit slice: 10 authored changed lines in 1 commit on feat\/async/);
});

// R1 review advisory: a failed or timed-out `git diff` read as an empty diff
// and reported "0 authored changed lines"; no number beats a wrong one.
test("a failed diff reports nothing instead of zero lines", async () => {
	const answers: Record<string, string | undefined> = {
		"symbolic-ref -q --short HEAD": "feat/slice",
		"symbolic-ref -q --short refs/remotes/origin/HEAD": "origin/main",
		"merge-base HEAD origin/main": "base",
		"rev-list --count base..HEAD": "2",
		"diff --numstat -z -M base HEAD": "12\t3\tsrc/a.ts\0",
	};
	const git = async (args: string[]) => answers[args.join(" ")];
	assert.match(await commitSliceReport("/repo", git) ?? "", /^Commit slice: 15 authored changed lines in 2 commits/);
	delete answers["diff --numstat -z -M base HEAD"];
	assert.equal(await commitSliceReport("/repo", git), undefined);
});

// R1 review advisory: a background job's result arrives when the job starts,
// before its commit exists, so its slice line would describe the old HEAD.
test("only a foreground bash commit carries the slice line", async () => {
	const git = async (args: string[]) => ({
		"symbolic-ref -q --short HEAD": "feat/slice",
		"symbolic-ref -q --short refs/remotes/origin/HEAD": "origin/main",
		"merge-base HEAD origin/main": "base",
		"rev-list --count base..HEAD": "1",
		"diff --numstat -z -M base HEAD": "5\t0\tsrc/a.ts\0",
	} as Record<string, string>)[args.join(" ")];
	const event = (toolName: string) => ({ toolName, input: { command: "git commit -m x" }, isError: false, content: [{ type: "text" as const, text: "ok" }], structuredContent: undefined });
	assert.match(JSON.stringify((await commitSliceToolResult(event("bash"), "/repo", git))?.content), /Commit slice: 5 authored changed lines/);
	assert.equal(await commitSliceToolResult(event("bash_background"), "/repo", git), undefined);
	assert.equal(await commitSliceToolResult(event("monitor"), "/repo", git), undefined);
});

test("commits on the default branch, outside Git, or with nothing ahead report nothing", async (t) => {
	const { dir, git, commitFile } = repo(t);
	commitFile("src/direct.ts", 10);
	assert.equal(await commitSliceReport(dir), undefined, "the default branch has no slice");
	git("switch", "-q", "-c", "feat/empty");
	assert.equal(await commitSliceReport(dir), undefined, "nothing ahead of the default branch");
	const plain = realpathSync(mkdtempSync(join(tmpdir(), "commit-slice-plain-")));
	t.after(() => rmSync(plain, { recursive: true, force: true }));
	assert.equal(await commitSliceReport(plain), undefined, "outside Git");
});
