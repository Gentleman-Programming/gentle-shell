import assert from "node:assert/strict";
import test from "node:test";
import { deliveredTestViolation, evaluateDeliveredTestTool, isTestFilePath } from "../lib/delivered-test-lint.ts";

// Harness roadmap T5 (R1): blind review found delivered tests that ran
// `git show <baseline commit>` and failed in another clone, and orchestrators
// that pointed TMPDIR into the repository. The prompt rule did not hold, so the
// runtime blocks writing such a test instead of asking the model not to.

test("isTestFilePath recognizes common test layouts and nothing else", () => {
	for (const path of ["tests/ledger.test.ts", "src/__tests__/a.ts", "test/cli.spec.js", "pkg/store_test.go", "tests/test_cli.py", "/abs/repo/test/x.mjs"]) {
		assert.equal(isTestFilePath(path), true, path);
	}
	for (const path of ["src/ledger.ts", "README.md", "src/testing-utils.ts", "docs/tests.md"]) {
		assert.equal(isTestFilePath(path), false, path);
	}
});

test("a test that reads a literal commit from git history is a violation", () => {
	for (const content of [
		'const old = execSync("git show 3f9c2e1:src/ledger.ts").toString();',
		"execFileSync('git', ['show', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0:src/cli.ts']);",
		"git checkout 9e8d7c6 -- src/cli.ts",
		"git diff 4c5d6e7f HEAD -- src",
		"git archive 77aa12b | tar -x -C \"$scratch\"",
	]) {
		assert.match(deliveredTestViolation(content) ?? "", /git history/, content);
	}
});

test("a test that points TMPDIR inside the working directory is a violation", () => {
	for (const content of [
		"TMPDIR=$PWD/.test-tmp node --test",
		'const env = { ...process.env, TMPDIR: join(process.cwd(), ".tmp") };',
		"process.env.TMPDIR = path.join(__dirname, 'tmp');",
		"export TMPDIR=\"$(pwd)/tmp\"",
		'os.environ["TMPDIR"] = os.getcwd()',
	]) {
		assert.match(deliveredTestViolation(content) ?? "", /TMPDIR/, content);
	}
});

// PR #2290 review: a relative TMPDIR resolves against the working directory just
// like `$PWD/...`, so test scratch entered the diff unflagged.
test("a test that sets TMPDIR to a relative path is a violation", () => {
	for (const content of [
		"TMPDIR=./.tmp node --test",
		"TMPDIR=.tmp node --test",
		"export TMPDIR=tmp/x",
		'const env = { ...process.env, TMPDIR: "./.tmp" };',
		"process.env.TMPDIR = '.tmp';",
		'process.env.TMPDIR = "tmp/x";',
		'os.environ["TMPDIR"] = "../scratch"',
	]) {
		assert.match(deliveredTestViolation(content) ?? "", /TMPDIR/, content);
	}
	for (const content of [
		'TMPDIR="$TMPDIR/ledger" node --test',
		"TMPDIR=${TMPDIR:-/tmp}/ledger node --test",
		"export TMPDIR=/var/tmp/ledger",
		'const env = { TMPDIR: "/tmp/ledger" };',
		"const env = { TMPDIR: os.tmpdir() };",
		"const env = { TMPDIR: path.join(tmpdir(), 'ledger') };",
		"TMPDIR=~/scratch node --test",
		'process.env.TMPDIR = "C:\\\\Temp";',
		"const env = { TMPDIR: `${tmpdir()}/ledger` };",
		'const task = runner.run(request({ env: { TMPDIR: "reltmp" } }));',
	]) {
		assert.equal(deliveredTestViolation(content), undefined, content);
	}
});

test("ordinary tests, git use in throwaway repos, and outside scratch stay allowed", () => {
	for (const content of [
		'const dir = mkdtempSync(join(tmpdir(), "ledger-"));',
		'execFileSync("git", ["init", "-q"], { cwd: dir }); execFileSync("git", ["stash"], { cwd: dir });',
		'git show HEAD:src/a.ts',
		"const env = { TMPDIR: scratch, PATH: [dirname(process.execPath)].join(':') };",
		"git log -1 --format='%h' 53d62fbf3",
		'assert.equal(hash("deadbeef"), "cafebabe");',
		"assert.equal(env.TMPDIR === process.cwd(), false);",
	]) {
		assert.equal(deliveredTestViolation(content), undefined, content);
	}
});

test("evaluateDeliveredTestTool blocks write and edit of a test file, never a source file", () => {
	const bad = 'execSync("git show 3f9c2e1:src/ledger.ts")';
	const write = evaluateDeliveredTestTool("write", { path: "tests/ledger.test.ts", content: bad });
	assert.equal(write?.block, true);
	assert.match(write?.reason ?? "", /tests\/ledger\.test\.ts/);
	assert.match(write?.reason ?? "", /mktemp/);
	assert.equal(evaluateDeliveredTestTool("edit", { path: "tests/ledger.test.ts", edits: [{ oldText: "a", newText: bad }] })?.block, true);
	assert.equal(evaluateDeliveredTestTool("edit", { path: "tests/ledger.test.ts", oldText: "a", newText: bad })?.block, true);
	assert.equal(evaluateDeliveredTestTool("write", { path: "scripts/diff-check.sh", content: bad }), undefined);
	assert.equal(evaluateDeliveredTestTool("read", { path: "tests/ledger.test.ts" }), undefined);
	assert.equal(evaluateDeliveredTestTool("write", { path: "tests/ledger.test.ts", content: "assert.ok(true);" }), undefined);
});

test("absolute paths are judged relative to the session cwd, so a project under a test/ directory is not a test", () => {
	const bad = 'execSync("git show 3f9c2e1:src/ledger.ts")';
	assert.equal(evaluateDeliveredTestTool("write", { path: "/home/u/test/app/src/release.ts", content: bad }, "/home/u/test/app"), undefined);
	assert.equal(evaluateDeliveredTestTool("write", { path: "/home/u/test/app/tests/a.test.ts", content: bad }, "/home/u/test/app")?.block, true);
	assert.equal(evaluateDeliveredTestTool("write", { path: "/elsewhere/tests/a.ts", content: bad }, "/home/u/test/app")?.block, true, "outside the cwd the path is judged whole");
});
