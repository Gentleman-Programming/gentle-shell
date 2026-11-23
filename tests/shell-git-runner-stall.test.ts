import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { shellGitRunner } from "../extensions/gentle-shell.ts";
import { worktreeGitEnvironment } from "../lib/session-worktree-registry.ts";

const posix = { skip: process.platform === "win32" };
const deadline = 200;
function stall(ms: number): void {
	// Real Git progresses while the calling JS thread cannot deliver events.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fixtureGit(t: TestContext, script: string, timeout = deadline) {
	const directory = mkdtempSync(join(tmpdir(), "gentle-git-deadline-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const executable = join(directory, "git");
	writeFileSync(executable, `#!/bin/sh\n${script}\n`);
	chmodSync(executable, 0o700);
	return shellGitRunner(directory, { PATH: directory }, undefined, Infinity, undefined, timeout);
}

test("a Git process that completes within its deadline keeps its real result after a UI stall", posix, async (t) => {
	// A real child with deterministic output avoids racing a Git shim or repo
	// configuration against the shortened deadline in the highly parallel suite.
	const timeout = 500;
	const git = fixtureGit(t, "printf 'true\\n'", timeout);
	assert.deepEqual(await git(["status"]), { code: 0, stdout: "true\n" });
	const result = git(["status"]);
	stall(timeout + 100);
	assert.deepEqual(await result, { code: 0, stdout: "true\n" });
});

test("a Git process still running at its deadline remains a timeout", posix, async (t) => {
	const git = fixtureGit(t, "printf partial\nexec /bin/sleep 4");
	const start = performance.now();
	assert.deepEqual(await git(["status"]), { code: 1, stdout: "partial", timedOut: true });
	const elapsed = performance.now() - start;
	assert.ok(elapsed >= deadline - 20 && elapsed < 2000, `timeout took ${elapsed}ms`);
});

test("a Git deadline still expires while the UI thread is stalled", posix, async (t) => {
	const git = fixtureGit(t, 'if [ "$3" = status ]; then printf partial; exec /bin/sleep 0.4; fi');
	assert.deepEqual(await git(["version"]), { code: 0, stdout: "" });
	const result = git(["status"]);
	stall(deadline + 400); // long enough for the fake Git to exit normally if the deadline stalls too
	assert.deepEqual(await result, { code: 1, stdout: "partial", timedOut: true });
});

test("bounded Git stdout preserves execFile UTF-8 truncation across a UI stall", posix, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "gentle-git-utf8-bound-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const executable = join(directory, "git");
	// The earlier multibyte output makes execFile's byte tally and string slice
	// disagree. A second multibyte character itself crosses the byte limit.
	writeFileSync(executable, `#!/bin/sh\nif [ "$3" = version ]; then exit 0; fi\nprintf 'é'\n/bin/sleep 0.25\nprintf 'a界zz'\n`);
	chmodSync(executable, 0o700);
	const env = { PATH: directory };
	const maxBuffer = 4;
	const git = shellGitRunner(directory, env, undefined, maxBuffer);
	assert.deepEqual(await git(["version"]), { code: 0, stdout: "" });
	const legacy = new Promise<string>((resolve, reject) => {
		execFile("git", ["-C", directory, "log"], { env: worktreeGitEnvironment(env), encoding: "utf8", maxBuffer }, (err, stdout) => {
			if (err?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(err ?? new Error("expected truncation"));
			else resolve(stdout);
		});
	});
	const read = git(["log"]);
	stall(650);
	assert.deepEqual(await read, { code: 1, truncated: true, stdout: await legacy });
});
