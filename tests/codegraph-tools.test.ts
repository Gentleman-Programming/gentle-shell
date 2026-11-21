import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_REPLY_CHARS, type DaemonCallResult } from "../lib/codegraph-daemon.ts";
import type { InitLockOutcome } from "../lib/codegraph-lease.ts";
import type { EnsureExposureIo } from "../lib/codegraph-mcp-exposure.ts";
import codeGraphTools, {
	armExposureEnsureForTest,
	clearSearchSync,
	createCodeGraphTool,
	codeGraphNodeScript,
	codegraphSyncFailureNotice,
	indexedNotice,
	findCodeGraphNodeScriptOnPath,
	isSameDirectory,
	isWorkspaceProjectRoot,
	triggerSearchSync,
	type CodeGraphRunner,
	type DaemonExplore,
} from "../extensions/codegraph-tools.ts";

function workspace(t: test.TestContext): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-")));
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

/** Lets a detached background job settle before its effects are asserted. */
function settled(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 10));
}

/** A daemon that always answers, so a test never warms or spawns anything real. */
const daemonOk: DaemonExplore = async () => ({ status: "ok", text: "daemon answer" });

/** A lazy re-warm that starts nothing real: tests injecting the query seams never warm a daemon. */
const noRewarm = (): void => {};

/** A syncRun that starts nothing real; tests count its calls when they care. */
const syncNothing = async (): Promise<boolean> => true;

/** An init lock that is always acquired: init tests never touch the real cross-session lease. */
const lockAcquired = async (): Promise<InitLockOutcome> => ({ outcome: "acquired", release: () => {}, adopt: () => {} });

/**
 * The test runner may itself be flagged as a subagent child (GENTLE_PI_AGENTS_CHILD=1), which
 * suppresses the sync; tests that assert triggering run as a plain parent session.
 */
function withoutChildEnv(t: test.TestContext): void {
	const previous = process.env.GENTLE_PI_AGENTS_CHILD;
	delete process.env.GENTLE_PI_AGENTS_CHILD;
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
		else process.env.GENTLE_PI_AGENTS_CHILD = previous;
	});
}

test("CodeGraph tool rejects non-project, nested-project, HOME, and temporary workspaces before init", async (t) => {
	const nonProject = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-non-project-")));
	t.after(() => rmSync(nonProject, { recursive: true, force: true }));
	const root = workspace(t);
	const nested = join(root, "nested");
	mkdirSync(nested);
	let calls = 0;
	const tool = createCodeGraphTool(async () => {
		calls += 1;
		return { stdout: "unexpected", stderr: "" };
	});
	for (const cwd of [nonProject, nested, homedir(), tmpdir()]) {
		await assert.rejects(
			() => tool.execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext),
			/real Git project root equal to the current workspace/i,
		);
	}
	assert.equal(calls, 0);
});

test("CodeGraph workspace guard compares directories by identity, not path spelling (#2558)", (t) => {
	// A mapped drive and its UNC form name one directory; an alias reproduces that without a network share.
	const root = workspace(t);
	const holder = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-alias-")));
	t.after(() => rmSync(holder, { recursive: true, force: true }));
	const alias = join(holder, "root");
	symlinkSync(root, alias, "junction");
	t.after(() => rmSync(alias, { force: true }));
	const nested = join(root, "nested");
	mkdirSync(nested);
	assert.notEqual(alias, root);
	assert.equal(isSameDirectory(alias, root), true);
	assert.equal(isSameDirectory(root, nested), false);
	assert.equal(isSameDirectory(root, join(root, "missing")), false);
});
test("readiness treats a workspace symlinked to a valid Git root as that project root", (t) => {
	const root = workspace(t);
	const holder = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-root-alias-")));
	t.after(() => rmSync(holder, { recursive: true, force: true }));
	const alias = join(holder, "root");
	symlinkSync(root, alias, "junction");
	t.after(() => rmSync(alias, { force: true }));
	const nested = join(root, "nested");
	mkdirSync(nested);
	const nonProject = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-non-project-")));
	t.after(() => rmSync(nonProject, { recursive: true, force: true }));

	assert.equal(isWorkspaceProjectRoot(root), true, "the root itself validates");
	assert.equal(isWorkspaceProjectRoot(alias), true, "a different spelling of the same directory validates too");
	assert.equal(isWorkspaceProjectRoot(nested), false, "a subdirectory of the root is not the project root");
	assert.equal(isWorkspaceProjectRoot(nonProject), false, "a directory outside any repository is not a project root");
	assert.equal(isWorkspaceProjectRoot(homedir()), false, "HOME is never a project root");
});


test("CodeGraph tool accepts the Git root reached through a different spelling of the same directory (#2558)", async (t) => {
	// A mapped drive is one such spelling; on a case-insensitive filesystem a different letter case is another.
	const root = workspace(t);
	const respelled = [...root].map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())).join("");
	if (respelled === root || !existsSync(respelled)) {
		t.skip("case-sensitive filesystem: no second spelling of the same directory");
		return;
	}
	const cwds: string[] = [];
	const tool = createCodeGraphTool(
		async () => ({ stdout: "ok", stderr: "" }),
		{
			daemonExplore: async (cwd) => {
				cwds.push(cwd);
				return { status: "ok", text: "daemon answer" };
			},
			rewarm: noRewarm,
			syncRun: syncNothing,
		},
	);
	await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd: respelled } as ExtensionContext);
	assert.deepEqual(cwds, [realpathSync(respelled)]);
});

test("CodeGraph workspace rejection names the compared paths and Git's own error (#2558)", async (t) => {
	const nonProject = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-non-project-")));
	t.after(() => rmSync(nonProject, { recursive: true, force: true }));
	const root = workspace(t);
	const nested = join(root, "nested");
	mkdirSync(nested);
	let calls = 0;
	const tool = createCodeGraphTool(async () => {
		calls += 1;
		return { stdout: "unexpected", stderr: "" };
	});
	const rejection = async (cwd: string): Promise<string> => {
		try {
			await tool.execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext);
		} catch (error) {
			return (error as Error).message;
		}
		assert.fail(`expected ${cwd} to be rejected`);
	};

	assert.equal(
		await rejection(nested),
		`CodeGraph requires a real Git project root equal to the current workspace.\n  workspace: ${nested}\n  git toplevel: ${root}`,
	);

	const [prefix, workspaceLine, gitLine, ...rest] = (await rejection(nonProject)).split("\n");
	assert.equal(prefix, "CodeGraph requires a real Git project root equal to the current workspace.");
	assert.equal(workspaceLine, `  workspace: ${nonProject}`);
	// Git's stderr, not Node's "Command failed" wrapper; Git may localize the text itself.
	assert.match(gitLine, /^  git: \S/);
	assert.doesNotMatch(gitLine, /Command failed/);
	for (const line of rest) assert.match(line, /^    /);
	assert.equal(calls, 0);
});

test("CodeGraph init is never bounded by the query timeout; only the user's signal bounds it (#1901)", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	// Behaves like execFile: settles only when its signal aborts, then rejects with AbortError.
	const hanging: CodeGraphRunner = (_args, options) => new Promise((_resolve, reject) => {
		options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true });
	});

	// A user cancellation is a failure, not a timeout.
	const user = new AbortController();
	setTimeout(() => user.abort(), 5);
	const cancelled = await createCodeGraphTool(hanging, { queryTimeoutMs: 60_000, initLock: lockAcquired }).execute("test", { operation: "init" }, user.signal, undefined, ctx);
	assert.doesNotMatch(cancelled.content[0].text, /timed out/);
	assert.match(cancelled.content[0].text, /CodeGraph failed to run/);

	// init is the legitimately slow first index: only the user's own signal bounds it.
	let initSignal: AbortSignal | undefined = new AbortController().signal;
	const slowInit = createCodeGraphTool(async (_args, options) => {
		initSignal = options.signal;
		await new Promise((resolve) => setTimeout(resolve, 60));
		return { stdout: "indexed", stderr: "" };
	}, { queryTimeoutMs: 20, initLock: lockAcquired });
	const init = await slowInit.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.deepEqual(init.content, [{ type: "text", text: "indexed" }]);
	assert.equal(initSignal, undefined);
});

test("a hung CLI query fallback is bounded by the query timeout, not the user's patience (#1901)", async (t) => {
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	// Behaves like execFile: settles only when its signal aborts, then rejects with AbortError.
	const hanging: CodeGraphRunner = (_args, options) => new Promise((_resolve, reject) => {
		options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true });
	});
	// The caller eventually aborts, so an unbounded RED run fails the elapsed assertion instead of hanging.
	const caller = new AbortController();
	setTimeout(() => caller.abort(), 2_000);
	const started = Date.now();
	const result = await createCodeGraphTool(hanging, {
		queryTimeoutMs: 50,
		daemonExplore: async () => ({ status: "timeout" as const }),
		warm: async () => false,
		rewarm: noRewarm,
		syncRun: syncNothing,
	}).execute("test", { operation: "query", query: "symbol" }, caller.signal, undefined, ctx);
	const elapsed = Date.now() - started;
	assert.match(result.content[0].text, /CodeGraph failed to run/);
	assert.equal((result.details as { status?: string }).status, "failed");
	assert.ok(elapsed < 500, `the hung CLI fallback must be bounded by the query timeout, took ${elapsed} ms`);
});

test("a caller-aborted search stops paying for daemon attempts instead of running out the budget", async (t) => {
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	let attempts = 0;
	const never: DaemonExplore = async () => {
		attempts += 1;
		return await new Promise<DaemonCallResult>(() => {
			/* never settles: a wedged daemon socket */
		});
	};
	const caller = new AbortController();
	setTimeout(() => caller.abort(), 10);
	const started = Date.now();
	const result = await Promise.race([
		createCodeGraphTool(async () => ({ stdout: "cli answer", stderr: "" }), {
			daemonExplore: never,
			warm: async () => true,
			rewarm: noRewarm,
			syncRun: syncNothing,
		}).execute("test", { operation: "query", query: "symbol" }, caller.signal, undefined, ctx),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("execute did not return after caller abort")), 3_000)),
	]);
	const elapsed = Date.now() - started;
	assert.ok(result, "execute returned after the caller aborted");
	assert.ok(elapsed < 2_500, `the aborted call must not run out the daemon budget, took ${elapsed} ms`);
});

test("an already-aborted caller exits before the daemon warm-up and the CLI fallback stages", async (t) => {
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	let warmCalls = 0;
	let runnerCalls = 0;
	const caller = new AbortController();
	caller.abort(); // the caller cancelled before the search even started
	const result = await createCodeGraphTool(async () => {
		runnerCalls += 1;
		return { stdout: "cli answer", stderr: "" };
	}, {
		daemonExplore: async () => ({ status: "unavailable" as const }),
		rewarm: noRewarm,
		warm: async () => {
			warmCalls += 1;
			return true;
		},
		syncRun: syncNothing,
	}).execute("test", { operation: "query", query: "symbol" }, caller.signal, undefined, ctx);
	assert.equal(warmCalls, 0, "prior cancellation must not enter the warm-up stage");
	assert.equal(runnerCalls, 0, "prior cancellation must not start the CLI fallback");
	assert.match(result.content[0].text, /CodeGraph failed to run/);
	assert.equal((result.details as { status?: string }).status, "failed");
});
test("an already-aborted caller returns the abort failure before the re-warm, background sync, and first daemon attempt", async (t) => {
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const ctx = { cwd } as ExtensionContext;
	let attempts = 0;
	let rewarms = 0;
	let syncs = 0;
	// A wedged daemon socket: the attempt never settles, so any wait for it shows up as elapsed time.
	const never: DaemonExplore = async () => {
		attempts += 1;
		return await new Promise<DaemonCallResult>(() => {
			/* never settles: a wedged daemon socket */
		});
	};
	const caller = new AbortController();
	caller.abort(); // the caller cancelled before the search even started
	const started = Date.now();
	const result = await Promise.race([
		createCodeGraphTool(async () => ({ stdout: "cli answer", stderr: "" }), {
			daemonExplore: never,
			warm: async () => true,
			rewarm: () => {
				rewarms += 1;
			},
			syncRun: async () => {
				syncs += 1;
				return true;
			},
		}).execute("test", { operation: "query", query: "symbol" }, caller.signal, undefined, ctx),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("execute did not return after an already-aborted caller")), 3_000)),
	]);
	const elapsed = Date.now() - started;
	assert.ok(result, "execute returned for an already-aborted caller");
	assert.ok(elapsed < 2_500, `the cancelled call must not wait on the daemon, took ${elapsed} ms`);
	assert.equal(rewarms, 0, "prior cancellation must not re-warm");
	assert.equal(syncs, 0, "prior cancellation must not trigger the background sync");
	assert.equal(attempts, 0, "prior cancellation must not start the first daemon attempt");
	assert.match(result.content[0].text, /CodeGraph failed to run/);
	assert.equal((result.details as { status?: string }).status, "failed");

	// A daemon that would answer ok cannot turn a cancelled call into a success either.
	const leaked = await createCodeGraphTool(async () => ({ stdout: "cli answer", stderr: "" }), {
		daemonExplore: async () => ({ status: "ok", text: "daemon answer" }),
		rewarm: () => {
			rewarms += 1;
		},
		syncRun: syncNothing,
	}).execute("test", { operation: "query", query: "symbol" }, caller.signal, undefined, ctx);
	assert.match(leaked.content[0].text, /CodeGraph failed to run/);
	assert.equal((leaked.details as { status?: string }).status, "failed");
});


test("CodeGraph tool runs only fixed cwd-scoped init, query, and explore commands", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const runnerCalls: Array<{ args: readonly string[]; cwd: string }> = [];
	const daemonCalls: string[] = [];
	const tool = createCodeGraphTool(
		async (args, options) => {
			runnerCalls.push({ args, cwd: options.cwd });
			return { stdout: "indexed", stderr: "" };
		},
		{
			daemonExplore: async (_cwd, parameters) => {
				daemonCalls.push(parameters.operation);
				return { status: "ok", text: "daemon answer" };
			},
			rewarm: noRewarm,
			syncRun: syncNothing,
			initLock: lockAcquired,
		},
	);
	const ctx = { cwd } as ExtensionContext;

	for (const parameters of [
		{ operation: "init" },
		{ operation: "query", query: "buildGentlePrompt", limit: 4 },
		{ operation: "explore", query: "review gate", limit: 3 },
	] as const) {
		const result = await tool.execute("test", parameters, undefined, undefined, ctx);
		assert.deepEqual(result.content, [{ type: "text", text: parameters.operation === "init" ? "indexed" : "daemon answer" }]);
	}

	assert.deepEqual(runnerCalls, [
		{ args: ["init", cwd], cwd },
	], "only init runs the CLI");
	assert.deepEqual(daemonCalls, ["query", "explore"], "query and explore go through the daemon");
});

test("CodeGraph tool rejects pre-existing .codegraph symlinks and non-directories", async (t) => {
	for (const kind of ["symlink", "file"] as const) {
		const cwd = workspace(t);
		const indexPath = join(cwd, ".codegraph");
		if (kind === "symlink") {
			const outside = join(cwd, "outside");
			mkdirSync(outside);
			symlinkSync(outside, indexPath);
		} else {
			writeFileSync(indexPath, "not an index directory");
		}
		let calls = 0;
		const tool = createCodeGraphTool(async () => {
			calls += 1;
			return { stdout: "unexpected", stderr: "" };
		});

		await assert.rejects(
			() => tool.execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext),
			/must be a real directory/i,
		);
		assert.equal(calls, 0, `${kind} index must not execute CodeGraph`);
	}
});

test("CodeGraph tool accepts hyphen-leading queries after the option terminator", async (t) => {
	const cwd = workspace(t);
	const seen: Array<{ operation: string; query?: string }> = [];
	const tool = createCodeGraphTool(
		async () => ({ stdout: "safe", stderr: "" }),
		{
			daemonExplore: async (_cwd, parameters) => {
				seen.push({ operation: parameters.operation, query: parameters.query });
				return { status: "ok", text: "safe" };
			},
			rewarm: noRewarm,
			syncRun: syncNothing,
		},
	);
	const ctx = { cwd } as ExtensionContext;

	const result = await tool.execute("test", { operation: "query", query: "--help" }, undefined, undefined, ctx);

	assert.deepEqual(seen, [{ operation: "query", query: "--help" }]);
	assert.deepEqual((result.details as { args: string[] }).args, [
		"query", "--path", cwd, "--limit", "10", "--", "--help",
	]);
});

test("CodeGraph search falls back to one CLI process when the daemon cannot serve it", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const runnerCalls: Array<{ args: readonly string[]; cwd: string }> = [];
	const tool = createCodeGraphTool(
		async (args, options) => {
			runnerCalls.push({ args, cwd: options.cwd });
			return { stdout: "cli answer", stderr: "" };
		},
		{
			daemonExplore: async () => ({ status: "unavailable" }),
			warm: async () => true,
			rewarm: noRewarm,
			syncRun: syncNothing,
		},
	);
	const ctx = { cwd } as ExtensionContext;

	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, ctx);

	assert.deepEqual(result.content, [{ type: "text", text: "cli answer" }]);
	assert.deepEqual(runnerCalls, [
		{ args: ["query", "--path", cwd, "--limit", "10", "--", "symbol"], cwd },
	], "the daemon could not serve, so exactly one CLI process answered");
	assert.equal((result.details as { viaDaemon?: boolean }).viaDaemon, false);
	assert.equal((result.details as { syncTriggered?: boolean }).syncTriggered, true);
});

test("CodeGraph tool asks git once per cwd per turn, not once per search", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	mkdirSync(join(cwd, ".codegraph"));
	writeFileSync(join(cwd, ".codegraph", "codegraph.db"), "index");
	const gitCalls: string[] = [];
	const gitRun = (args: readonly string[], at: string): string => {
		gitCalls.push(args.join(" "));
		if (args.includes("--show-toplevel")) return at;
		if (args.includes("--is-inside-work-tree")) return "true";
		if (args.includes("--git-path")) return ".git/info/exclude";
		throw new Error(`unexpected git interrogation: ${args.join(" ")}`);
	};
	const tool = createCodeGraphTool(async () => ({ stdout: "unused", stderr: "" }), {
		daemonExplore: daemonOk,
		warm: async () => true,
		rewarm: noRewarm,
		syncRun: syncNothing,
		gitRun,
	});
	const ctx = { cwd } as ExtensionContext;

	await tool.execute("test", { operation: "query", query: "first" }, undefined, undefined, ctx);
	const firstSearch = gitCalls.length;
	assert.ok(firstSearch > 0, "the first search of a turn asks git");
	await tool.execute("test", { operation: "query", query: "second" }, undefined, undefined, ctx);
	assert.equal(gitCalls.length, firstSearch, "a later search in the same turn asks git nothing");

	clearSearchSync();
	await tool.execute("test", { operation: "query", query: "third" }, undefined, undefined, ctx);
	assert.equal(gitCalls.length, firstSearch * 2, "a new turn asks git again, exactly once");
});

test("a cached workspace validation survives only while the checkout keeps its Git root", async (t) => {
	const cwd = workspace(t);
	const tool = createCodeGraphTool(async () => ({ stdout: "unused", stderr: "" }), {
		daemonExplore: daemonOk,
		rewarm: noRewarm,
		syncRun: syncNothing,
	});
	const ctx = { cwd } as ExtensionContext;

	await tool.execute("test", { operation: "query", query: "first" }, undefined, undefined, ctx);

	// The checkout loses its .git mid-prompt: realpath and the directory check still pass,
	// so only a revalidated cache can keep the Git-root requirement honest.
	rmSync(join(cwd, ".git"), { recursive: true, force: true });
	await assert.rejects(
		() => tool.execute("test", { operation: "query", query: "second" }, undefined, undefined, ctx),
		/real Git project root equal to the current workspace/i,
	);
});

test("a cached linked-worktree validation dies with the gitdir its .git file names", (t) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-wtbase-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const git = (args: readonly string[], at: string): void => {
		execFileSync("git", args, { cwd: at, stdio: "ignore" });
	};
	const main = join(base, "main");
	mkdirSync(main);
	git(["init", "-b", "main"], main);
	git(["config", "user.email", "codegraph-test@example.com"], main);
	git(["config", "user.name", "codegraph-test"], main);
	writeFileSync(join(main, "file.txt"), "content");
	git(["add", "."], main);
	git(["commit", "-m", "seed"], main);
	const linked = join(base, "linked");
	git(["worktree", "add", linked, "-b", "worktree-branch"], main);

	assert.equal(isWorkspaceProjectRoot(linked), true, "the linked worktree validates and caches as a project root");

	// The main checkout moves away: the worktree's .git file survives, but the gitdir it names
	// is gone — a cache hit that trusts the file's presence alone dispatches into a
	// non-repository.
	renameSync(main, join(base, "main-moved"));

	assert.equal(isWorkspaceProjectRoot(linked), false, "the stale cached root is rejected once the .git file's gitdir target is gone");
});

test("a cached validation dies with a non-regular .git marker instead of reading it", (t) => {
	if (process.platform === "win32") {
		t.skip("the FIFO fixture is POSIX-only");
		return;
	}
	const cwd = workspace(t);
	assert.equal(isWorkspaceProjectRoot(cwd), true, "the workspace validates and caches first");

	// A FIFO replaces the directory marker while a writer holds the pipe ready with a
	// well-formed gitdir line naming an existing directory: a check that reads the marker
	// would consume that line and keep the cache alive — and with no writer at all the same
	// synchronous read would block the whole session.
	rmSync(join(cwd, ".git"), { recursive: true, force: true });
	const marker = join(cwd, ".git");
	execFileSync("mkfifo", [marker]);
	const gitdir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-gitdir-")));
	t.after(() => rmSync(gitdir, { recursive: true, force: true }));
	const writer = spawn("sh", ["-c", 'echo "gitdir: $1" > "$2"', "sh", gitdir, marker]);
	t.after(() => writer.kill());

	assert.equal(isWorkspaceProjectRoot(cwd), false, "a non-regular marker is not a repository marker, whatever it would say");
});

test("CodeGraph init reports the missing binary distinctly", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const unavailable = Object.assign(new Error("spawn codegraph ENOENT"), { code: "ENOENT" });
	const tool = createCodeGraphTool(async () => {
		throw unavailable;
	}, { initLock: lockAcquired });
	const ctx = { cwd } as ExtensionContext;

	const result = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);

	assert.deepEqual(result.content, [{
		type: "text",
		text: "CodeGraph is unavailable because the codegraph binary was not found. Use read, grep, and find for this exploration.",
	}]);
	assert.deepEqual(result.details, {
		status: "unavailable",
		operation: "init",
		cwd,
		fallback: "Use read, grep, and find for this exploration.",
	});
});

test("CodeGraph tool configures a process buffer above the returned-output truncation threshold", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	let maxBuffer = 0;
	const tool = createCodeGraphTool(async (_args, options) => {
		maxBuffer = options.maxBuffer;
		return { stdout: "x".repeat(100_001), stderr: "" };
	}, { initLock: lockAcquired });
	const ctx = { cwd } as ExtensionContext;

	const result = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);

	assert.ok(maxBuffer > 100_000);
	assert.ok(maxBuffer >= MAX_REPLY_CHARS, "the CLI process buffer accepts what the daemon path accepts");
	assert.match(result.content[0]?.text ?? "", /\[CodeGraph output truncated\]$/);
});

test("the CLI process buffer is a byte budget covering the character cap at maximum UTF-8 width", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	let maxBuffer = 0;
	const tool = createCodeGraphTool(async (_args, options) => {
		maxBuffer = options.maxBuffer;
		return { stdout: "x", stderr: "" };
	}, { initLock: lockAcquired });
	const ctx = { cwd } as ExtensionContext;

	await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);

	// maxBuffer counts UTF-8 bytes while MAX_REPLY_CHARS counts UTF-16 code units, and the widest
	// UTF-8 encoding of a code unit is 3 bytes (a surrogate pair's 4-byte sequence spans two
	// units): 400k CJK characters are ~1.2 MB, and Node kills an overrunning child before
	// truncateOutput could bound it, so the byte budget must cover the character cap.
	assert.ok(maxBuffer >= 3 * MAX_REPLY_CHARS, `maxBuffer ${maxBuffer} cannot hold ${MAX_REPLY_CHARS} characters at 3 bytes each`);
});

test("module evaluation survives an unresolvable HOME and TMP: registration never breaks", async (t) => {
	// Environment overrides can point HOME/TMP at missing directories; resolving them must happen
	// inside the guarded workspace check, never at module evaluation — a throw there would keep
	// the extension from registering its tool and startup hooks at all.
	const holder = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-nohome-")));
	t.after(() => rmSync(holder, { recursive: true, force: true }));
	const missing = join(holder, "gone");
	const script = join(holder, "import-check.mjs");
	writeFileSync(script, `await import(${JSON.stringify(new URL("../extensions/codegraph-tools.ts", import.meta.url).href)});\nconsole.log("codegraph-tools loaded");\n`);
	const child = spawnSync(process.execPath, ["--experimental-strip-types", script], {
		encoding: "utf8",
		env: { ...process.env, HOME: missing, TMPDIR: missing },
		timeout: 60_000,
	});
	assert.equal(child.status, 0, `the module must evaluate with a missing HOME/TMP; stderr: ${child.stderr}`);
	assert.match(child.stdout, /codegraph-tools loaded/);
});

test("the lazy re-warm is an injected seam: query seams never reach the real daemon spawn", async (t) => {
	const cwd = workspace(t);
	const rewarmCalls: string[] = [];
	const tool = createCodeGraphTool(async () => ({ stdout: "cli", stderr: "" }), {
		daemonExplore: daemonOk,
		rewarm: (project: string) => {
			rewarmCalls.push(project);
		},
		syncRun: syncNothing,
	});

	await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);

	assert.deepEqual(rewarmCalls, [cwd], "the injected adapter is what the search calls, once, with the resolved cwd");
});

test("CodeGraph tool rejects incomplete or oversized query requests before running a process", async (t) => {
	const cwd = workspace(t);
	let calls = 0;
	const tool = createCodeGraphTool(async () => {
		calls += 1;
		return { stdout: "unexpected", stderr: "" };
	});
	const ctx = { cwd } as ExtensionContext;

	await assert.rejects(
		() => tool.execute("test", { operation: "query" }, undefined, undefined, ctx),
		/query is required/i,
	);
	await assert.rejects(
		() => tool.execute("test", { operation: "explore", query: "x", limit: 21 }, undefined, undefined, ctx),
		/between 1 and 20/i,
	);
	assert.equal(calls, 0);
});

test("CodeGraph tool registration exposes a single constrained custom tool", () => {
	const tools: Array<{ name: string; renderShell?: string; parameters: Record<string, unknown> }> = [];
	const pi = {
		registerTool(tool: { name: string; parameters: Record<string, unknown> }) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;

	codeGraphTools(pi);

	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.name, "codegraph");
	assert.equal(tools[0]?.renderShell, "self", "CodeGraph must not inherit Pi's painted Box");
	assert.deepEqual(tools[0]?.parameters, {
		type: "object",
		additionalProperties: false,
		required: ["operation"],
		properties: {
			operation: { type: "string", enum: ["init", "query", "explore"] },
			query: { type: "string", minLength: 1, maxLength: 2_000 },
			limit: { type: "integer", minimum: 1, maximum: 20 },
		},
	});
});

test("the per-prompt sync reset binds to before_agent_start, never to a prompt's tool-call turns", async (t) => {
	withoutChildEnv(t);
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = {
		registerTool() {
			/* the registered tool's shape is covered above */
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;

	codeGraphTools(pi);

	assert.ok(handlers.has("before_agent_start"), "the reset lives at the user-prompt boundary");
	assert.ok(handlers.has("session_start"), "session_start still prepares readiness");

	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const calls: string[][] = [];
	const syncRun = async (args: readonly string[]): Promise<boolean> => {
		calls.push([...args]);
		return true;
	};
	const ctx = { cwd } as ExtensionContext;
	assert.equal(triggerSearchSync(cwd, ctx, syncRun), true);
	await settled();
	assert.equal(triggerSearchSync(cwd, ctx, syncRun), false, "one background sync per user prompt");
	await settled();
	// A turn boundary inside the same user prompt — every assistant response between tool calls
	// fires turn_start — must not re-arm the background sync or drop the daemon bypass.
	const turnStart = handlers.get("turn_start") as ((event: unknown) => void) | undefined;
	turnStart?.({});
	assert.equal(triggerSearchSync(cwd, ctx, syncRun), false, "a tool-call turn never re-arms the per-prompt sync");
	// The next user prompt is the boundary that resets.
	(handlers.get("before_agent_start") as () => void)();
	assert.equal(triggerSearchSync(cwd, ctx, syncRun), true, "a new user prompt re-arms the sync");
	await settled();
	assert.deepEqual(calls, [["sync", "-q"], ["sync", "-q"]]);
});

test("session_start ensures direct mcp exposure once per process, and a child session never does", (t) => {
	withoutChildEnv(t);
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = {
		registerTool() {
			/* the registered tool's shape is covered above */
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;

	codeGraphTools(pi);

	const sessionStart = handlers.get("session_start") as (event: unknown, ctx: unknown) => void;
	// A fresh git repo with no index and no marker: readiness plans nothing, so firing the
	// handler never spawns a real CodeGraph command.
	const ctx = { cwd: workspace(t) } as ExtensionContext;
	const exposureIo = (): { reads: string[]; writes: string[]; io: EnsureExposureIo } => {
		const reads: string[] = [];
		const writes: string[] = [];
		return {
			reads,
			writes,
			io: {
				read: (path) => {
					reads.push(path);
					return JSON.stringify({ mcpServers: { codegraph: { command: "codegraph", args: ["serve", "--mcp"] } } });
				},
				write: (path) => {
					writes.push(path);
				},
			},
		};
	};
	t.after(() => armExposureEnsureForTest(undefined));

	// A child session never patches the user's config — checked first, from a pristine flag.
	const child = exposureIo();
	armExposureEnsureForTest(child.io);
	process.env.GENTLE_PI_AGENTS_CHILD = "1";
	sessionStart({ reason: "startup" }, ctx);
	sessionStart({ reason: "startup" }, ctx);
	assert.equal(child.reads.length, 0, "a child session never reads an agent mcp.json");
	delete process.env.GENTLE_PI_AGENTS_CHILD;

	// A parent session ensures exactly once: the second session start is a per-process no-op.
	const parent = exposureIo();
	armExposureEnsureForTest(parent.io);
	sessionStart({ reason: "startup" }, ctx);
	sessionStart({ reason: "startup" }, ctx);
	assert.equal(parent.reads.length, 4, "each agent-home mcp.json is read once per update attempt (initial read plus the pre-publish re-verify)");
	assert.equal(parent.writes.length, 2, "each agent-home mcp.json is written exactly once");
});

test("triggerSearchSync: an unindexed workspace starts no doomed sync", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const calls: string[][] = [];
	const syncRun = async (args: readonly string[]): Promise<boolean> => {
		calls.push([...args]);
		return true;
	};
	const ctx = { cwd } as ExtensionContext;
	assert.equal(triggerSearchSync(cwd, ctx, syncRun), false, "nothing to refresh without an index");
	assert.equal(triggerSearchSync(cwd, ctx, syncRun), false, "still nothing on a second call");
	await settled();
	assert.deepEqual(calls, [], "no sync, no doomed CLI processes per turn");
});

test("triggerSearchSync: an unexpected exception notifies instead of vanishing", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const notices: Array<{ text: string; level: string }> = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
	} as unknown as ExtensionContext;
	triggerSearchSync(cwd, ctx, async () => {
		throw new Error("boom: refresh exploded");
	});
	await settled();
	assert.equal(notices.length, 1, "one warning for one unexpected failure");
	assert.match(notices[0].text, /boom: refresh exploded/);
	assert.equal(notices[0].level, "warning");
});

test("the tool_call guard blocks bash codegraph index/init when an index exists and allows everything else", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		registerTool() {
			/* the registered tool's shape is covered above */
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	codeGraphTools(pi);
	const guard = handlers.get("tool_call");
	assert.ok(typeof guard === "function", "the extension registers a tool_call guard");

	const indexed = workspace(t);
	await writeIndex(["init", indexed], { cwd: indexed, maxBuffer: 1 });
	const ctx = { cwd: indexed } as ExtensionContext;
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const verdict = (command: string, toolName = "bash") =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName, input: { command } }, ctx);

	for (const [command, toolName] of [
		["codegraph index .", "bash"],
		["codegraph init", "bash"],
		["  FOO=1 codegraph index", "bash"],
		["FOO=1 codegraph init", "bash_background"],
		["FOO=\"a b\" codegraph index .", "bash"],
		["cd . && codegraph index .", "bash"],
		["cd .; codegraph init", "bash"],
		["cd .\ncodegraph index .", "bash"],
	] as const) {
		const blocked = verdict(command, toolName) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blocked?.block, true, `${toolName}: ${command} is blocked`);
		assert.match(blocked?.reason ?? "", /an index already exists/);
		assert.match(blocked?.reason ?? "", /GENTLE_CODEGRAPH_ALLOW_INDEX=1/);
	}

	for (const command of ["codegraph sync", "codegraph unlock", "codegraph status", "codegraph indexer .", "rg foo", "FOO=\"a b\" codegraph sync", "echo \"codegraph index .\"", "cd . && codegraph status"]) {
		assert.equal(verdict(command), undefined, `${command} is allowed`);
	}
	assert.equal(verdict("codegraph index .", "read"), undefined, "only bash tools are guarded");

	const bare = workspace(t);
	assert.equal(
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command: "codegraph index" } }, { cwd: bare } as ExtensionContext),
		undefined,
		"no index database: the first index is the legitimate init path",
	);

	// The literal leading assignment is the inline form of the override, recognized in the
	// detected command itself rather than only the parent process environment.
	assert.equal(verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=1 codegraph index ."), undefined, "the inline leading override allows the deliberate rebuild");
	assert.equal(verdict("FOO=1 GENTLE_CODEGRAPH_ALLOW_INDEX=1 codegraph init"), undefined, "the override counts anywhere in the leading assignment run");
	const refused = verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=0 codegraph index .") as { block?: boolean } | undefined;
	assert.equal(refused?.block, true, "only the exact =1 value overrides");
	assert.equal(verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=\"1\" codegraph index ."), undefined, "a quoted =1 is the same override value");
	const refusedQuoted = verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=\"0\" codegraph index .") as { block?: boolean } | undefined;
	assert.equal(refusedQuoted?.block, true, "only the exact quoted value 1 overrides");
	assert.equal(verdict("cd . && GENTLE_CODEGRAPH_ALLOW_INDEX=1 codegraph index ."), undefined, "the override on the rebuild command itself counts after a separator");
	const siblingOverride = verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=1 cd . && codegraph index .") as { block?: boolean } | undefined;
	assert.equal(siblingOverride?.block, true, "an override on an earlier command never leaks onto the rebuild after a separator");
	process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = "1";
	assert.equal(verdict("codegraph index ."), undefined, "the explicit override allows a deliberate rebuild");
});

test("the tool_call guard blocks re-index from a subdirectory session of an indexed repo", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		registerTool() {
			/* the registered tool's shape is covered above */
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	codeGraphTools(pi);
	const guard = handlers.get("tool_call");
	assert.ok(typeof guard === "function", "the extension registers a tool_call guard");

	const root = workspace(t);
	await writeIndex(["init", root], { cwd: root, maxBuffer: 1 });
	const subdir = join(root, "packages", "inner");
	mkdirSync(subdir, { recursive: true });
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});

	const verdictFrom = (cwd: string, command = "codegraph index") =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command } }, { cwd } as ExtensionContext);

	const blocked = verdictFrom(subdir) as { block?: boolean; reason?: string } | undefined;
	assert.equal(blocked?.block, true, "a subdirectory session cannot rebuild the repo-root index");
	assert.match(blocked?.reason ?? "", /an index already exists/);

	process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = "1";
	assert.equal(verdictFrom(subdir), undefined, "the explicit override allows a deliberate rebuild from a subdirectory");
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;

	const bare = workspace(t);
	const bareSub = join(bare, "packages", "inner");
	mkdirSync(bareSub, { recursive: true });
	assert.equal(verdictFrom(bareSub), undefined, "no index anywhere: the first index stays the legitimate init path");
});

/** The tool_call guard's verdict function over an indexed workspace, with the launch override
 * cleared for the test's lifetime: the guard's domain (existing index, no override). */
async function guardOnIndexedWorkspace(t: test.TestContext): Promise<(command: string, toolName?: string) => unknown> {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		registerTool() {
			/* the registered tool's shape is covered above */
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	codeGraphTools(pi);
	const guard = handlers.get("tool_call");
	const indexed = workspace(t);
	await writeIndex(["init", indexed], { cwd: indexed, maxBuffer: 1 });
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const ctx = { cwd: indexed } as ExtensionContext;
	return (command: string, toolName = "bash") =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName, input: { command } }, ctx);
}

test("the guard's inline override honors the last GENTLE_CODEGRAPH_ALLOW_INDEX assignment", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);
	const superseded = verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=1 GENTLE_CODEGRAPH_ALLOW_INDEX=0 codegraph index .") as { block?: boolean; reason?: string } | undefined;
	assert.equal(superseded?.block, true, "a trailing =0 leaves no override: the shell applies the last assignment, so the rebuild is blocked");
	assert.match(superseded?.reason ?? "", /an index already exists/);
	assert.equal(verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=0 GENTLE_CODEGRAPH_ALLOW_INDEX=1 codegraph index ."), undefined, "a trailing =1 is the override the command actually runs with");
});

test("the guard requires the inline override on every rebuild command in the list", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);
	const leaked = verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=1 codegraph index .; codegraph init .") as { block?: boolean; reason?: string } | undefined;
	assert.equal(leaked?.block, true, "the second rebuild carries no override of its own, so the whole shell call is blocked");
	assert.match(leaked?.reason ?? "", /an index already exists/);
	assert.equal(
		verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=1 codegraph index .; GENTLE_CODEGRAPH_ALLOW_INDEX=1 codegraph init ."),
		undefined,
		"a list where every rebuild carries its own override is the deliberate rebuild the override exists for",
	);
});

test("the guard still detects rebuild commands hidden behind backslash-escaped quotes", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);
	// An escaped quote passes a literal quote to echo: the shell opens no quoted section, so
	// the semicolon after it separates a real second command. The pair is assembled from char
	// codes because a backslash-before-quote literal is corruption-prone in generated code.
	const escapedQuote = `${String.fromCharCode(92)}${String.fromCharCode(34)}`;
	const hidden = verdict(`echo ${escapedQuote} ; codegraph index .`) as { block?: boolean; reason?: string } | undefined;
	assert.equal(hidden?.block, true, "the rebuild behind the escaped quote is detected and blocked");
	assert.match(hidden?.reason ?? "", /an index already exists/);
	assert.equal(verdict(`echo ${escapedQuote} ; codegraph status`), undefined, "a non-rebuild command behind an escaped quote stays allowed");
});

function writeCodeGraphPackage(binDir: string, scriptSource = "#!/usr/bin/env node\n"): string {
	const pkgRoot = join(binDir, "node_modules", "@colbymchenry", "codegraph");
	mkdirSync(pkgRoot, { recursive: true });
	const scriptTarget = join(pkgRoot, "npm-shim.js");
	writeFileSync(scriptTarget, scriptSource);
	writeFileSync(
		join(pkgRoot, "package.json"),
		JSON.stringify({
			name: "@colbymchenry/codegraph",
			version: "1.0.0",
			bin: { codegraph: "npm-shim.js" },
		}),
	);
	writeFileSync(
		join(binDir, "codegraph.cmd"),
		"@ECHO off\nnode \"%~dp0\\node_modules\\@colbymchenry\\codegraph\\npm-shim.js\" %*\n",
	);
	return scriptTarget;
}

function withWindowsPath(t: test.TestContext, path: string): void {
	const previousPath = process.env.PATH;
	const previousWindowsPath = process.env.Path;
	const windowsPath = process.platform === "win32"
		? `${path};${previousWindowsPath ?? previousPath ?? ""}`
		: path;
	process.env.Path = windowsPath;
	process.env.PATH = windowsPath;
	t.after(() => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousWindowsPath === undefined) delete process.env.Path;
		else process.env.Path = previousWindowsPath;
	});
}

test("Windows shim helpers skip stale PATH shims before resolving the npm script", (t) => {
	const staleBinDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-stale-bin-")));
	const validBinDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-valid-bin-")));
	t.after(() => rmSync(staleBinDir, { recursive: true, force: true }));
	t.after(() => rmSync(validBinDir, { recursive: true, force: true }));
	writeFileSync(join(staleBinDir, "codegraph.cmd"), "@ECHO off\n");
	const stalePkgRoot = join(staleBinDir, "node_modules", "@colbymchenry", "codegraph");
	mkdirSync(stalePkgRoot, { recursive: true });
	writeFileSync(join(stalePkgRoot, "package.json"), JSON.stringify({ bin: { codegraph: "." } }));
	const scriptTarget = writeCodeGraphPackage(validBinDir);

	withWindowsPath(t, `${staleBinDir};${validBinDir}`);

	assert.equal(codeGraphNodeScript(join(staleBinDir, "codegraph.cmd")), undefined);
	assert.equal(findCodeGraphNodeScriptOnPath(), scriptTarget);
});

test("Windows shim helpers resolve quoted PATH entries in order without stripping unmatched quotes", (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-quoted-bin-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const firstBin = join(root, "Program Files", "nodejs");
	const secondBin = join(root, "other-bin");
	const firstScript = writeCodeGraphPackage(firstBin);
	const secondScript = writeCodeGraphPackage(secondBin);
	withWindowsPath(t, `"${firstBin}";${secondBin}`);

	assert.equal(findCodeGraphNodeScriptOnPath(), firstScript);
	for (const [path, expected] of [
		[`${firstBin};"${secondBin}"`, firstScript],
		[`"${firstBin};${secondBin}`, secondScript],
		[`${firstBin}";${secondBin}`, secondScript],
		[`${secondBin};"${firstBin}"`, secondScript],
	]) {
		process.env.Path = path;
		process.env.PATH = path;
		assert.equal(findCodeGraphNodeScriptOnPath(), expected);
	}
});

test("Windows launcher passes command metacharacters as one literal argv value", async (t) => {
	withoutChildEnv(t);
	const binDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-bin-")));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	writeCodeGraphPackage(binDir, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
	const cwd = workspace(t);
	if (process.platform !== "win32") {
		const gitShim = join(binDir, "git");
		writeFileSync(gitShim, "#!/bin/sh\nprintf '%s\\n' \"$PWD\"\n");
		chmodSync(gitShim, 0o755);
	}
	withWindowsPath(t, binDir);

	const previousPlatform = process.platform;
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	t.after(() => Object.defineProperty(process, "platform", { configurable: true, value: previousPlatform }));

	const result = await createCodeGraphTool(undefined, { initLock: lockAcquired }).execute(
		"test",
		{ operation: "init" },
		undefined,
		undefined,
		{ cwd } as ExtensionContext,
	);

	assert.deepEqual(result.content, [{
		type: "text",
		text: JSON.stringify(["init", cwd]),
	}]);
	assert.equal(existsSync(join(cwd, "shell-injection.txt")), false);
});

// Real CodeGraph writes .codegraph/.gitignore with `*` and `!.gitignore`, so the
// .gitignore itself stays untracked and would otherwise enter every diff.
const writeIndex: CodeGraphRunner = async (_args, options) => {
	mkdirSync(join(options.cwd, ".codegraph"), { recursive: true });
	writeFileSync(join(options.cwd, ".codegraph", ".gitignore"), "*\n!.gitignore\n");
	writeFileSync(join(options.cwd, ".codegraph", "codegraph.db"), "index");
	return { stdout: "indexed", stderr: "" };
};

function gitOutput(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function excludeFile(cwd: string): string {
	return realpathSync(resolve(cwd, gitOutput(cwd, "rev-parse", "--git-path", "info/exclude")));
}

function excludeLines(cwd: string): string[] {
	return readFileSync(excludeFile(cwd), "utf8").split("\n").filter((line) => line.trim() === ".codegraph/");
}

test("CodeGraph init keeps the whole .codegraph index out of git through the local exclude file, idempotently", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	writeFileSync(join(cwd, "tracked.txt"), "tracked\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd });
	const tool = createCodeGraphTool(writeIndex, { initLock: lockAcquired });
	const ctx = { cwd } as ExtensionContext;

	const first = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	const second = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);

	assert.deepEqual(first.content, [{ type: "text", text: "indexed" }]);
	assert.equal(gitOutput(cwd, "status", "--porcelain", "--untracked-files=all"), "A  tracked.txt");
	assert.deepEqual(excludeLines(cwd), [".codegraph/"], "exactly one exclude line after repeated init");
	assert.equal(existsSync(join(cwd, ".gitignore")), false, "never creates or edits a tracked .gitignore");
	assert.deepEqual((first.details as { localExclude?: unknown }).localExclude, { status: "added", path: excludeFile(cwd) });
	assert.deepEqual((second.details as { localExclude?: unknown }).localExclude, { status: "present", path: excludeFile(cwd) });
});

test("CodeGraph exclusion appends on a new line and recognizes an equivalent existing pattern", async (t) => {
	withoutChildEnv(t);
	const appended = workspace(t);
	writeFileSync(excludeFile(appended), "# local\n*.log");
	await createCodeGraphTool(writeIndex, { initLock: lockAcquired }).execute("test", { operation: "init" }, undefined, undefined, { cwd: appended } as ExtensionContext);
	assert.equal(readFileSync(excludeFile(appended), "utf8"), "# local\n*.log\n.codegraph/\n");

	const equivalent = workspace(t);
	writeFileSync(excludeFile(equivalent), "/.codegraph\n");
	const result = await createCodeGraphTool(writeIndex, { initLock: lockAcquired }).execute("test", { operation: "init" }, undefined, undefined, { cwd: equivalent } as ExtensionContext);
	assert.equal(readFileSync(excludeFile(equivalent), "utf8"), "/.codegraph\n");
	assert.equal((result.details as { localExclude?: { status: string } }).localExclude?.status, "present");
	assert.equal(gitOutput(equivalent, "status", "--porcelain", "--untracked-files=all"), "");
});

test("CodeGraph exclusion uses the exclude file git resolves for a linked worktree", async (t) => {
	withoutChildEnv(t);
	const base = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-worktree-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const primary = join(base, "primary");
	const linked = join(base, "linked");
	mkdirSync(primary);
	execFileSync("git", ["init", "-b", "main"], { cwd: primary, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], { cwd: primary, stdio: "ignore" });
	execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: primary, stdio: "ignore" });

	const result = await createCodeGraphTool(writeIndex, { initLock: lockAcquired }).execute("test", { operation: "init" }, undefined, undefined, { cwd: linked } as ExtensionContext);

	assert.deepEqual(result.content, [{ type: "text", text: "indexed" }]);
	assert.equal(gitOutput(linked, "status", "--porcelain", "--untracked-files=all"), "");
	assert.deepEqual(excludeLines(linked), [".codegraph/"]);
	assert.equal((result.details as { localExclude?: { path: string } }).localExclude?.path, excludeFile(linked));
	assert.equal(existsSync(join(linked, ".git", "info")), false, "the linked worktree's .git file is never treated as a directory");
});

test("CodeGraph query excludes an index that already exists, and leaves the exclude file alone without one", async (t) => {
	const indexed = workspace(t);
	await writeIndex(["init", indexed], { cwd: indexed, maxBuffer: 1 });
	const daemonFound: DaemonExplore = async () => ({ status: "ok", text: "found" });
	await createCodeGraphTool(async () => ({ stdout: "found", stderr: "" }), { daemonExplore: daemonFound, syncRun: syncNothing, rewarm: noRewarm }).execute(
		"test",
		{ operation: "query", query: "symbol" },
		undefined,
		undefined,
		{ cwd: indexed } as ExtensionContext,
	);
	assert.deepEqual(excludeLines(indexed), [".codegraph/"]);
	assert.equal(gitOutput(indexed, "status", "--porcelain", "--untracked-files=all"), "");

	const bare = workspace(t);
	const result = await createCodeGraphTool(async () => ({ stdout: "found", stderr: "" }), { daemonExplore: daemonFound, syncRun: syncNothing, rewarm: noRewarm }).execute(
		"test",
		{ operation: "query", query: "symbol" },
		undefined,
		undefined,
		{ cwd: bare } as ExtensionContext,
	);
	assert.deepEqual(excludeLines(bare), []);
	assert.equal((result.details as { localExclude?: unknown }).localExclude, undefined);
});

test("CodeGraph query does not treat a .codegraph directory without codegraph.db as an index", async (t) => {
	const partial = workspace(t);
	mkdirSync(join(partial, ".codegraph"));
	writeFileSync(join(partial, ".codegraph", ".gitignore"), "*\n!.gitignore\n");
	const result = await createCodeGraphTool(
		async () => ({ stdout: "found", stderr: "" }),
		{ daemonExplore: async () => ({ status: "ok", text: "found" }), syncRun: syncNothing, rewarm: noRewarm },
	).execute(
		"test",
		{ operation: "query", query: "symbol" },
		undefined,
		undefined,
		{ cwd: partial } as ExtensionContext,
	);
	assert.deepEqual(result.content, [{ type: "text", text: "found" }]);
	assert.deepEqual(excludeLines(partial), [], "a directory without the database file is not an index");
	assert.equal((result.details as { localExclude?: unknown }).localExclude, undefined);
});
test("a search that waited on the daemon or the CLI still excludes an index published meanwhile", async (t) => {
	// The daemon path: session readiness publishes the index while the search awaits the daemon's answer.
	const daemonCwd = workspace(t);
	const viaDaemon = await createCodeGraphTool(async () => ({ stdout: "found", stderr: "" }), {
		daemonExplore: async () => {
			await writeIndex(["init", daemonCwd], { cwd: daemonCwd, maxBuffer: 1 });
			return { status: "ok" as const, text: "found" };
		},
		rewarm: noRewarm,
		syncRun: syncNothing,
	}).execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd: daemonCwd } as ExtensionContext);
	assert.match(viaDaemon.content[0].text, /found/);
	assert.equal(((viaDaemon.details as { localExclude?: { status: string } }).localExclude)?.status, "added", "the daemon path excludes an index published during its wait");
	assert.equal(gitOutput(daemonCwd, "status", "--porcelain", "--untracked-files=all"), "");

	// The CLI fallback path: the index appears while the search runs its one CLI process.
	const cliCwd = workspace(t);
	const viaCli = await createCodeGraphTool(async () => {
		await writeIndex(["init", cliCwd], { cwd: cliCwd, maxBuffer: 1 });
		return { stdout: "found", stderr: "" };
	}, {
		daemonExplore: async () => ({ status: "unavailable" as const }),
		warm: async () => true,
		rewarm: noRewarm,
		syncRun: syncNothing,
	}).execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd: cliCwd } as ExtensionContext);
	assert.match(viaCli.content[0].text, /found/);
	assert.equal(((viaCli.details as { localExclude?: { status: string } }).localExclude)?.status, "added", "the CLI path excludes an index published during its wait");
	assert.equal(gitOutput(cliCwd, "status", "--porcelain", "--untracked-files=all"), "");
});


test("CodeGraph query prefers the daemon socket and never spawns the CLI", async (t) => {
	const cwd = workspace(t);
	let runnerCalls = 0;
	const tool = createCodeGraphTool(
		async () => {
			runnerCalls += 1;
			return { stdout: "cli", stderr: "" };
		},
		{ daemonExplore: daemonOk, syncRun: syncNothing, rewarm: noRewarm },
	);
	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);
	assert.deepEqual(result.content, [{ type: "text", text: "daemon answer" }]);
	assert.equal(runnerCalls, 0, "the daemon answered, so no CLI process was spawned");
	assert.equal((result.details as { viaDaemon?: boolean }).viaDaemon, true);
});

test("a daemon that never answers tries twice, warms once, then answers through the CLI", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	let daemonCalls = 0;
	let warmCalls = 0;
	let runnerCalls = 0;
	const tool = createCodeGraphTool(
		async () => {
			runnerCalls += 1;
			return { stdout: "cli", stderr: "" };
		},
		{
			daemonExplore: async () => {
				daemonCalls += 1;
				return { status: "unavailable" };
			},
			rewarm: noRewarm,
			warm: async () => {
				warmCalls += 1;
				return true;
			},
			syncRun: syncNothing,
		},
	);
	const ctx = { cwd } as ExtensionContext;

	const first = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, ctx);

	assert.deepEqual(first.content, [{ type: "text", text: "cli" }]);
	assert.equal((first.details as { viaDaemon?: boolean }).viaDaemon, false);
	assert.equal((first.details as { syncTriggered?: boolean }).syncTriggered, true);
	assert.equal(daemonCalls, 2, "one attempt, then exactly one more after the warm-up");
	assert.equal(warmCalls, 1);
	assert.equal(runnerCalls, 1, "the CLI answers as the last resort");

	const second = await tool.execute("test", { operation: "explore", query: "symbol" }, undefined, undefined, ctx);

	assert.equal((second.details as { syncTriggered?: boolean }).syncTriggered, undefined, "one background sync per turn");
	assert.equal(daemonCalls, 2, "an unavailable daemon is skipped for the rest of the turn, not re-paid per query");
	assert.equal(warmCalls, 1);
	assert.equal(runnerCalls, 2);
});

test("a hung daemon also falls back to the CLI", async (t) => {
	const cwd = workspace(t);
	let runnerCalls = 0;
	const tool = createCodeGraphTool(
		async () => {
			runnerCalls += 1;
			return { stdout: "cli", stderr: "" };
		},
		{
			daemonExplore: async () => ({ status: "timeout" }),
			warm: async () => true,
			rewarm: noRewarm,
			syncRun: syncNothing,
		},
	);

	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);

	assert.deepEqual(result.content, [{ type: "text", text: "cli" }]);
	assert.equal((result.details as { viaDaemon?: boolean }).viaDaemon, false);
	assert.equal(runnerCalls, 1);
});

test("a failed daemon chain skips the daemon for the rest of the turn", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	let daemonCalls = 0;
	let runnerCalls = 0;
	const tool = createCodeGraphTool(
		async () => {
			runnerCalls += 1;
			return { stdout: "cli answer", stderr: "" };
		},
		{
			daemonExplore: async () => {
				daemonCalls += 1;
				return { status: "timeout" };
			},
			rewarm: noRewarm,
			warm: async () => true,
			syncRun: syncNothing,
		},
	);
	const ctx = { cwd } as ExtensionContext;

	// q1: one full failed chain (attempt, warm, attempt), then the CLI answers.
	const first = await tool.execute("test", { operation: "query", query: "q1" }, undefined, undefined, ctx);
	assert.deepEqual(first.content, [{ type: "text", text: "cli answer" }]);
	assert.equal((first.details as { viaDaemon?: boolean }).viaDaemon, false);
	assert.equal(daemonCalls, 2, "one attempt, then exactly one more after the warm-up");
	assert.equal(runnerCalls, 1);

	// q2, same turn: the daemon is skipped, so the CLI answers directly.
	const second = await tool.execute("test", { operation: "query", query: "q2" }, undefined, undefined, ctx);
	assert.deepEqual(second.content, [{ type: "text", text: "cli answer" }]);
	assert.equal((second.details as { viaDaemon?: boolean }).viaDaemon, false);
	assert.equal(daemonCalls, 2, "the failed chain is not repeated this turn");
	assert.equal(runnerCalls, 2);

	// q3, a new user prompt: clearSearchSync (what before_agent_start fires) re-asks the daemon once more.
	clearSearchSync();
	const third = await tool.execute("test", { operation: "query", query: "q3" }, undefined, undefined, ctx);
	assert.deepEqual(third.content, [{ type: "text", text: "cli answer" }]);
	assert.equal((third.details as { viaDaemon?: boolean }).viaDaemon, false);
	assert.equal(daemonCalls, 4, "a fresh turn runs one full chain again");
	assert.equal(runnerCalls, 3);
});

test("when the daemon and the CLI both fail, the search reports the standard failure", async (t) => {
	const cwd = workspace(t);
	const daemonDown: DaemonExplore = async () => ({ status: "unavailable" });
	const warmOk = async () => true;

	const failed = await createCodeGraphTool(
		async () => {
			throw new Error("CodeGraph exited with status 1");
		},
		{ daemonExplore: daemonDown, warm: warmOk, syncRun: syncNothing, rewarm: noRewarm },
	).execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);
	assert.deepEqual(failed.content, [{ type: "text", text: "CodeGraph failed to run. Use read, grep, and find for this exploration." }]);
	assert.equal((failed.details as { status?: string }).status, "failed");

	const missingBinary = Object.assign(new Error("spawn codegraph ENOENT"), { code: "ENOENT" });
	const unavailable = await createCodeGraphTool(
		async () => {
			throw missingBinary;
		},
		{ daemonExplore: daemonDown, warm: warmOk, syncRun: syncNothing, rewarm: noRewarm },
	).execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);
	assert.deepEqual(unavailable.content, [{ type: "text", text: "CodeGraph is unavailable because the codegraph binary was not found. Use read, grep, and find for this exploration." }]);
	assert.equal((unavailable.details as { status?: string }).status, "unavailable");
});

test("a daemon miss recovers after one warm-up attempt", async (t) => {
	const cwd = workspace(t);
	const answers: Array<{ status: "ok"; text: string } | { status: "unavailable" }> = [
		{ status: "unavailable" },
		{ status: "ok", text: "daemon answer" },
	];
	let warmCalls = 0;
	let runnerCalls = 0;
	const tool = createCodeGraphTool(
		async () => {
			runnerCalls += 1;
			return { stdout: "cli", stderr: "" };
		},
		{
			daemonExplore: async () => answers.shift() ?? { status: "unavailable" },
			rewarm: noRewarm,
			warm: async () => {
				warmCalls += 1;
				return true;
			},
			syncRun: syncNothing,
		},
	);

	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);

	assert.deepEqual(result.content, [{ type: "text", text: "daemon answer" }]);
	assert.equal((result.details as { viaDaemon?: boolean }).viaDaemon, true);
	assert.equal(answers.length, 0, "exactly two daemon attempts");
	assert.equal(warmCalls, 1);
	assert.equal(runnerCalls, 0);
});

test("init runs the CLI with the workspace, never the daemon, and never triggers a sync", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const calls: Array<{ args: readonly string[]; cwd: string }> = [];
	let daemonCalls = 0;
	let syncCalls = 0;
	const tool = createCodeGraphTool(
		async (args, options) => {
			calls.push({ args, cwd: options.cwd });
			return { stdout: "indexed", stderr: "" };
		},
		{
			daemonExplore: async () => {
				daemonCalls += 1;
				return { status: "ok", text: "daemon answer" };
			},
			syncRun: async () => {
				syncCalls += 1;
				return true;
			},
			initLock: lockAcquired,
		},
	);

	const result = await tool.execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext);

	assert.deepEqual(result.content, [{ type: "text", text: "indexed" }]);
	assert.deepEqual(calls, [{ args: ["init", cwd], cwd }]);
	assert.equal(daemonCalls, 0, "init never consults the daemon");
	await settled();
	assert.equal(syncCalls, 0, "init never triggers the background sync");
});
test("explicit init runs under the cross-session init lock: a held lock fails closed, and the lock is always released", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	let runnerCalls = 0;
	let releases = 0;
	const acquired: InitLockOutcome = { outcome: "acquired", release: () => { releases += 1; }, adopt: () => {} };
	const outcomes: InitLockOutcome[] = [{ outcome: "skipped" }, { outcome: "present" }, acquired, acquired];
	let failNextInit = false;
	const tool = createCodeGraphTool(async () => {
		runnerCalls += 1;
		if (failNextInit) throw new Error("CodeGraph exited with status 1");
		return { stdout: "indexed", stderr: "" };
	}, { initLock: async () => outcomes.shift() ?? acquired });

	const skipped = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.equal(runnerCalls, 0, "a lock that stays held never runs a second concurrent init");
	assert.match(skipped.content[0].text, /held by another session/);
	assert.equal((skipped.details as { status?: string }).status, "failed");

	const present = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.equal(runnerCalls, 0, "an index that appeared while the lock was waited on is not rebuilt");
	assert.match(present.content[0].text, /an index already exists/);
	assert.equal((present.details as { status?: string }).status, "failed");

	const ok = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.deepEqual(ok.content, [{ type: "text", text: "indexed" }]);
	failNextInit = true;
	const failed = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.match(failed.content[0].text, /CodeGraph failed to run/);
	assert.equal(runnerCalls, 2);
	assert.equal(releases, 2, "the lock is released however init ends");
});

test("operation init refuses to rebuild an existing index without the explicit override, like the bash guard", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const ctx = { cwd } as ExtensionContext;
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	let runnerCalls = 0;
	let lockAcquisitions = 0;
	const tool = createCodeGraphTool(async () => {
		runnerCalls += 1;
		return { stdout: "rebuilt", stderr: "" };
	}, {
		initLock: async () => {
			lockAcquisitions += 1;
			return { outcome: "acquired" as const, release: () => {}, adopt: () => {} };
		},
	});

	const refused = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.equal(runnerCalls, 0, "an indexed workspace is never rebuilt from the tool");
	assert.equal(lockAcquisitions, 0, "the guard refuses before touching the init lock");
	assert.match(refused.content[0].text, /an index already exists/);
	assert.match(refused.content[0].text, /GENTLE_CODEGRAPH_ALLOW_INDEX=1/);
	assert.equal((refused.details as { status?: string }).status, "failed");

	process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = "1";
	const rebuilt = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.equal(runnerCalls, 1, "the explicit override allows the deliberate rebuild");
	assert.equal(lockAcquisitions, 1, "the override still runs under the init lock");
	assert.match(rebuilt.content[0].text, /rebuilt/);
});

test("init rechecks index presence after acquiring a lock another initializer finished behind", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	let runnerCalls = 0;
	let releases = 0;
	// The pre-check sees an index-less workspace; while this call waits on the lock, the other
	// initializer finishes AND releases, so acquisition succeeds with the database in place.
	const initLock = async (): Promise<InitLockOutcome> => {
		await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
		return { outcome: "acquired", release: () => { releases += 1; }, adopt: () => {} };
	};
	const tool = createCodeGraphTool(async () => {
		runnerCalls += 1;
		return { stdout: "rebuilt", stderr: "" };
	}, { initLock });

	const refused = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);

	assert.equal(runnerCalls, 0, "the completed index is never rebuilt over the shared daemon");
	assert.equal(releases, 1, "the acquired lock is released when init stands down");
	assert.match(refused.content[0].text, /an index already exists/);
	assert.match(refused.content[0].text, /GENTLE_CODEGRAPH_ALLOW_INDEX=1/);
	assert.equal((refused.details as { status?: string }).status, "failed");

	process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = "1";
	await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.equal(runnerCalls, 1, "the explicit override still allows the deliberate rebuild after the recheck");
	assert.equal(releases, 2, "the lock is released however init ends");
});

test("init rechecks the .codegraph identity under the acquired lease, override included", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const outside = join(cwd, "outside-index");
	mkdirSync(outside);
	let runnerCalls = 0;
	let releases = 0;
	// While this init waits on the lease, .codegraph becomes a link to another checkout's
	// empty index directory: the database reads absent, but initializing would write through
	// the link into that other checkout.
	const initLock = async (): Promise<InitLockOutcome> => {
		// A directory junction: a runner that cannot create directory symlinks can still create
		// one, so the fixture reaches the post-lock refusal instead of throwing before initLock
		// returns an acquired lease. Node ignores the type argument on POSIX.
		symlinkSync(outside, join(cwd, ".codegraph"), "junction");
		return { outcome: "acquired", release: () => { releases += 1; }, adopt: () => {} };
	};
	const tool = createCodeGraphTool(async () => {
		runnerCalls += 1;
		return { stdout: "indexed", stderr: "" };
	}, { initLock });

	const refused = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.equal(runnerCalls, 0, "the runner never initializes through a replaced .codegraph link");
	assert.equal(releases, 1, "the acquired lock is released when init stands down");
	assert.match(refused.content[0].text, /CodeGraph failed to run/);
	assert.equal((refused.details as { status?: string }).status, "failed");

	rmSync(join(cwd, ".codegraph"), { force: true });
	process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = "1";
	const overrideRefused = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.equal(runnerCalls, 0, "the identity check is independent of the rebuild override");
	assert.equal(releases, 2, "the override path releases its lock too");
	assert.match(overrideRefused.content[0].text, /CodeGraph failed to run/);
});


test("the first search of a turn triggers one background sync, later searches none", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const calls: string[][] = [];
	const tool = createCodeGraphTool(
		async () => ({ stdout: "cli", stderr: "" }),
		{
			daemonExplore: daemonOk,
			rewarm: noRewarm,
			syncRun: async (args) => {
				calls.push([...args]);
				return true;
			},
		},
	);
	const ctx = { cwd } as ExtensionContext;

	const first = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, ctx);

	assert.equal((first.details as { syncTriggered?: boolean }).syncTriggered, true);
	await settled();
	assert.deepEqual(calls, [["sync", "-q"]]);

	await tool.execute("test", { operation: "explore", query: "symbol" }, undefined, undefined, ctx);
	await settled();
	assert.deepEqual(calls, [["sync", "-q"]], "one background sync per turn");

	clearSearchSync();
	await tool.execute("test", { operation: "query", query: "again" }, undefined, undefined, ctx);
	await settled();
	assert.deepEqual(calls, [["sync", "-q"], ["sync", "-q"]], "a new turn syncs again");
});

test("a subagent child never triggers the background sync", async (t) => {
	const cwd = workspace(t);
	const calls: string[][] = [];
	const tool = createCodeGraphTool(
		async () => ({ stdout: "cli", stderr: "" }),
		{
			daemonExplore: daemonOk,
			rewarm: noRewarm,
			syncRun: async (args) => {
				calls.push([...args]);
				return true;
			},
		},
	);
	const previous = process.env.GENTLE_PI_AGENTS_CHILD;
	process.env.GENTLE_PI_AGENTS_CHILD = "1";
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
		else process.env.GENTLE_PI_AGENTS_CHILD = previous;
	});

	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);

	assert.deepEqual(result.content, [{ type: "text", text: "daemon answer" }]);
	assert.equal((result.details as { syncTriggered?: boolean }).syncTriggered, undefined);
	await settled();
	assert.deepEqual(calls, []);
});

test("a subagent child init is refused: index creation is parent-session-owned", async (t) => {
	const cwd = workspace(t);
	const runnerCalls: Array<{ args: readonly string[]; cwd: string }> = [];
	let lockAcquisitions = 0;
	const childInitLock = async (): Promise<InitLockOutcome> => {
		lockAcquisitions += 1;
		return { outcome: "acquired", release: () => {}, adopt: () => {} };
	};
	const tool = createCodeGraphTool(async (args, options) => {
		runnerCalls.push({ args, cwd: options.cwd });
		return { stdout: "indexed", stderr: "" };
	}, { initLock: childInitLock });
	const ctx = { cwd } as ExtensionContext;
	const previous = process.env.GENTLE_PI_AGENTS_CHILD;
	process.env.GENTLE_PI_AGENTS_CHILD = "1";
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
		else process.env.GENTLE_PI_AGENTS_CHILD = previous;
	});

	// S1: the child guard refuses before the CLI runner is ever invoked, leaving no partial index.
	const refused = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.equal(runnerCalls.length, 0, "the child guard refuses before the CLI runner is invoked");
	assert.equal(lockAcquisitions, 0, "the child guard refuses before touching the cross-session init lock");
	assert.deepEqual(refused.content, [{
		type: "text",
		text: "CodeGraph init is refused in a subagent child: index creation is parent-session-owned. Query and explore the shared index instead; the parent session owns init.",
	}]);
	assert.deepEqual(refused.details, {
		status: "failed",
		operation: "init",
		cwd,
		fallback: "Use read, grep, and find for this exploration.",
	});
	assert.equal(existsSync(join(cwd, ".codegraph")), false, "the refusal builds no partial index");

	// S2: without the child flag the same call reaches the CLI runner exactly as before.
	delete process.env.GENTLE_PI_AGENTS_CHILD;
	const allowed = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.deepEqual(allowed.content, [{ type: "text", text: "indexed" }]);
	assert.deepEqual(runnerCalls, [{ args: ["init", cwd], cwd }]);
});

test("CodeGraph init still succeeds and reports when git is unavailable for the local exclusion", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const empty = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-nogit-")));
	const originalPath = process.env.PATH;
	t.after(() => {
		process.env.PATH = originalPath;
		rmSync(empty, { recursive: true, force: true });
	});
	const result = await createCodeGraphTool(async (args, options) => {
		const output = await writeIndex(args, options);
		process.env.PATH = empty; // git disappears after the workspace check
		return output;
	}, { initLock: lockAcquired }).execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext);
	process.env.PATH = originalPath;

	assert.match(result.content[0].text, /^indexed\n\n/);
	assert.match(result.content[0].text, /\.codegraph\/ is not excluded from git locally/);
	assert.match(result.content[0].text, /keep \.codegraph\/ out of the change/i);
	assert.equal((result.details as { localExclude?: { status: string } }).localExclude?.status, "failed");
	assert.deepEqual(excludeLines(cwd), []);
});

test("CodeGraph excludes a partial index left behind by a failed init without changing the fallback text", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const result = await createCodeGraphTool(async (args, options) => {
		await writeIndex(args, options);
		throw new Error("CodeGraph exited with status 1");
	}, { initLock: lockAcquired }).execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext);

	assert.deepEqual(result.content, [{ type: "text", text: "CodeGraph failed to run. Use read, grep, and find for this exploration." }]);
	assert.equal((result.details as { status: string }).status, "failed");
	assert.equal((result.details as { localExclude?: { status: string } }).localExclude?.status, "added");
	assert.equal(gitOutput(cwd, "status", "--porcelain", "--untracked-files=all"), "");
});

test("codegraphSyncFailureNotice: beside a live daemon the note is info with the self-heal hint; otherwise a warning with diagnostics", () => {
	assert.deepEqual(codegraphSyncFailureNotice("/repo", "sync", { daemonAlive: true }), {
		text: "codegraph sync failed in /repo (daemon alive; its file watcher keeps the index fresh)",
		level: "info",
	});
	assert.deepEqual(codegraphSyncFailureNotice("/repo", "sync", { daemonAlive: false, exitCode: 3, stderrTail: "lock busy" }), {
		text: "codegraph sync failed in /repo — exit 3: lock busy",
		level: "warning",
	});
	assert.deepEqual(codegraphSyncFailureNotice("/repo", "lease", {}), {
		text: "codegraph sync skipped in /repo: the cross-session sync lease is not acquirable",
		level: "warning",
	});
	assert.deepEqual(codegraphSyncFailureNotice("/repo", "sync", { daemonAlive: true, exitCode: null }), {
		text: "codegraph sync failed in /repo (daemon alive; its file watcher keeps the index fresh) — killed (timeout)",
		level: "info",
	});
});

test("indexedNotice: a main-busy stand-down reports deferred initialization, never a created index", () => {
	assert.deepEqual(indexedNotice({ action: "init", ok: true }, "/repo"), { text: "CodeGraph index created", level: "info" });
	assert.deepEqual(indexedNotice({ action: "sync", ok: true }, "/repo"), { text: "CodeGraph index synced", level: "info" });
	assert.deepEqual(indexedNotice({ action: "init", ok: true, stoodDown: true }, "/repo"), {
		text: "CodeGraph index creation deferred in /repo: the main checkout is creating its index",
		level: "info",
	});
	assert.deepEqual(
		indexedNotice({ action: "sync", ok: true, stoodDown: true }, "/repo"),
		{ text: "CodeGraph index synced", level: "info" },
		"a sync stand-down keeps its synced line: another session's refresh covered the index",
	);
	assert.deepEqual(
		indexedNotice({ action: "init", ok: false, initAttempts: 4 }, "/repo"),
		{ text: 'codegraph init failed in /repo after 3 retries; run "codegraph init" manually', level: "warning" },
	);
	assert.deepEqual(indexedNotice({ action: "init", ok: false }, "/repo"), { text: "codegraph init failed in /repo", level: "warning" });
	assert.deepEqual(
		indexedNotice({ action: "sync", ok: false, daemonAlive: true, exitCode: 1 }, "/repo"),
		codegraphSyncFailureNotice("/repo", "sync", { daemonAlive: true, exitCode: 1 }),
	);
});

test("indexedNotice: an unconfirmed teardown never offers the manual init while a writer may still run", () => {
	const notice = indexedNotice({ action: "init", ok: false, initAttempts: 2, initStop: "teardown-unconfirmed" }, "/repo");
	const unconfirmedTeardown = {
		text: "codegraph init failed in /repo: the previous attempt could not be confirmed stopped, so init was not retried; retry later once no codegraph writer is running",
		level: "warning",
	} as const;
	assert.deepEqual(notice, unconfirmedTeardown, "the stop reason replaces the exhausted-retry instruction");
	assert.doesNotMatch(
		notice?.text ?? "",
		/run "codegraph init" manually/,
		"a writer that may still be running is never met by a second one the notice asks for",
	);
	assert.deepEqual(
		indexedNotice({ action: "init", ok: false, initAttempts: 1, initStop: "teardown-unconfirmed" }, "/repo"),
		unconfirmedTeardown,
		"the sequence can stop on the first attempt, so the attempt count alone never selects this notice",
	);
});

test("triggerSearchSync: a failing sync beside a live daemon notifies info, a daemon-less one keeps the warning", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const registry = join(cwd, "registry");
	mkdirSync(registry);
	const socket = join(registry, "live.sock");
	writeFileSync(socket, "");
	writeFileSync(join(registry, "record.json"), JSON.stringify({ root: cwd, socketPath: socket, startedAt: 1, pid: process.pid }));
	const notices: Array<{ text: string; level: "info" | "warning" }> = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify: (text: string, level: "info" | "warning") => notices.push({ text, level }) },
	} as unknown as ExtensionContext;
	const alwaysFails = async (): Promise<boolean> => false;
	const instant = async (): Promise<void> => {};

	triggerSearchSync(cwd, ctx, alwaysFails, { registryDir: registry, sleep: instant });
	await settled();
	assert.equal(notices.length, 1, "one notify for one failed refresh");
	assert.equal(notices[0].level, "info", "a live daemon self-heals the index: no warning");
	assert.match(notices[0].text, /\(daemon alive/);

	const deadCwd = workspace(t);
	await writeIndex(["init", deadCwd], { cwd: deadCwd, maxBuffer: 1 });
	const deadCtx = { cwd: deadCwd, hasUI: true, ui: { notify: (text: string, level: "info" | "warning") => notices.push({ text, level }) } } as unknown as ExtensionContext;
	const deadRun = async (): Promise<boolean> => false;
	triggerSearchSync(deadCwd, deadCtx, deadRun, { registryDir: join(deadCwd, "no-registry"), sleep: instant });
	await settled();
	assert.equal(notices.length, 2);
	assert.equal(notices[1].level, "warning", "without a daemon the failure stays a warning");
	assert.equal(notices[1].text, `codegraph sync failed in ${deadCwd}`);
});
