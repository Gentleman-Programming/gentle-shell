import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { createShellGitWorker } from "../lib/shell-git-worker.ts";
import { worktreeGitEnvironment } from "../lib/session-worktree-registry.ts";

const posix = { skip: process.platform === "win32" };
const options = { env: worktreeGitEnvironment(process.env), encoding: "utf8", shell: false, windowsHide: true, maxBuffer: Infinity, timeout: 5000 } as const;
const unavailable = { code: 1, stdout: "", unavailable: true };

function scratch(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-git-worker-fallback-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function gitFixture(t: TestContext) {
	const root = scratch(t);
	const git = join(root, "git");
	writeFileSync(git, `#!/bin/sh
case "$3" in
  slow) printf '%s' "$FIXTURE_TEXT"; exec /bin/sleep 4 ;;
  record) printf started > "$4" ;;
esac
`);
	chmodSync(git, 0o700);
	return { root, fixtureOptions: { ...options, env: { PATH: root, FIXTURE_TEXT: "partial" } } };
}

test("a deleted process cwd falls back once and preserves real Git and execFile results", posix, async (t) => {
	const root = scratch(t);
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], options);
	git("init", "-q");
	git("-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base");
	const { root: fixture, fixtureOptions } = gitFixture(t);
	// A shell shim writes a getcwd warning to stderr before its script runs,
	// which could hit the tiny buffer on stderr before stdout is truncated.
	const echo = scratch(t);
	symlinkSync("/bin/echo", join(echo, "git"));
	const worker = createShellGitWorker(1000);
	let constructions = 0;
	const fallback = createShellGitWorker(1000, (...args: ConstructorParameters<typeof Worker>) => {
		constructions++;
		return new Worker(...args);
	});
	t.after(() => Promise.all([worker.dispose(), fallback.dispose()]));
	const reads = [
		{ args: ["-C", root, "--version"], opts: options, result: { code: 0, stdout: git("--version") } },
		{ args: ["-C", root, "rev-parse", "HEAD"], opts: options, result: { code: 0, stdout: git("rev-parse", "HEAD") } },
		{ args: ["-C", root, "rev-parse", "--verify", "--quiet", "refs/heads/absent"], opts: options, result: { code: 1, stdout: "" } },
		{ args: ["abcdef"], opts: { ...options, env: { PATH: echo }, maxBuffer: 4 }, result: { code: 1, stdout: "abcd", truncated: true } },
		{ args: ["-C", fixture, "slow"], opts: { ...fixtureOptions, timeout: 350 }, result: { code: 1, stdout: "partial", timedOut: true } },
		{ args: ["-C", root, "--version"], opts: { ...options, env: { PATH: root } }, result: unavailable },
	];
	const viaWorker = [];
	for (const { args, opts } of reads) viaWorker.push(await worker.read(args, opts));

	const originalCwd = process.cwd();
	const vanished = join(root, "vanished");
	mkdirSync(vanished);
	const viaFallback = [];
	try {
		process.chdir(vanished);
		rmdirSync(vanished);
		assert.throws(() => process.cwd(), { code: "ENOENT" });
		for (const { args, opts } of reads) viaFallback.push(await fallback.read(args, opts));
	} finally {
		process.chdir(originalCwd);
	}
	assert.deepEqual(viaFallback.slice(0, 2), reads.slice(0, 2).map(({ result }) => result), "real Git still runs with a deleted cwd");
	// A read cut at maxBuffer keeps whatever stdout arrived before the cut; how
	// much that is depends on pipe timing (on Linux the child can be killed
	// before its first stdout chunk is read), on both paths. The shape must
	// match, and the partial stdout must be a prefix of the full output.
	const comparable = (result: { stdout: string; truncated?: boolean }, full: { stdout: string }) =>
		result.truncated && full.stdout.startsWith(result.stdout) ? { ...result, stdout: full.stdout } : result;
	const expected = reads.map(({ result }) => result);
	assert.deepEqual(viaWorker.map((result, i) => comparable(result, expected[i])), expected);
	assert.deepEqual(viaFallback.map((result, i) => comparable(result, expected[i])), expected);
	assert.equal(constructions, 1, "later reads do not try to recreate the failed worker");
});

test("a throwing worker constructor switches to direct Git without retrying", posix, async (t) => {
	const cwd = scratch(t);
	let constructions = 0;
	const reader = createShellGitWorker(1000, () => {
		constructions++;
		throw new Error("cannot create Git worker");
	});
	t.after(() => reader.dispose());
	const args = ["-C", cwd, "--version"];
	const result = { code: 0, stdout: execFileSync("git", args, options) };
	assert.deepEqual(await reader.read(args, options), result);
	assert.deepEqual(await reader.read(args, options), result);
	assert.equal(constructions, 1);
});

test("an unexpected worker exit replays all pending Git reads directly", posix, async (t) => {
	const cwd = scratch(t);
	let constructions = 0;
	const reader = createShellGitWorker(1000, () => {
		constructions++;
		return new Worker(new URL("data:text/javascript,process.exit(0)"), { env: {}, execArgv: [] });
	});
	t.after(() => reader.dispose());
	const version = ["-C", cwd, "--version"];
	const execPath = ["-C", cwd, "--exec-path"];
	const expected = [version, execPath].map((args) => ({ code: 0, stdout: execFileSync("git", args, options) }));
	assert.deepEqual(await Promise.all([reader.read(version, options), reader.read(execPath, options)]), expected);
	assert.deepEqual(await reader.read(version, options), expected[0]);
	assert.equal(constructions, 1);
});

test("a closed reader marks an unavailable read without starting a worker or Git", posix, async (t) => {
	const { root, fixtureOptions } = gitFixture(t);
	const started = join(root, "started");
	let constructions = 0;
	const reader = createShellGitWorker(1000, (...args: ConstructorParameters<typeof Worker>) => {
		constructions++;
		return new Worker(...args);
	});
	await reader.dispose();
	assert.deepEqual(await reader.read(["-C", root, "record", started], fixtureOptions), unavailable);
	assert.equal(constructions, 0);
	assert.equal(existsSync(started), false);
});

test("a worker lost during shutdown fails the pending read without restarting Git", posix, async (t) => {
	const { root, fixtureOptions } = gitFixture(t);
	const started = join(root, "started");
	const reader = createShellGitWorker(1000, () => new Worker(new URL("data:text/javascript,process.exit(0)"), { env: {}, execArgv: [] }));
	const pending = reader.read(["-C", root, "record", started], fixtureOptions);
	await reader.dispose();
	assert.deepEqual(await pending, unavailable);
	assert.equal(existsSync(started), false);
});
