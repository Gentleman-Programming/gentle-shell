import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearCodegraphResolveCache, resolveCodegraphShimState } from "../lib/codegraph-cli-resolve.ts";
import { MAX_REPLY_CHARS, resetDaemonRegistryMemo, type DaemonCallResult } from "../lib/codegraph-daemon.ts";
import { leaseHostIdentity, leaseMachineIdentity, lockPathFor, type InitLockOutcome } from "../lib/codegraph-lease.ts";
import type { EnsureExposureIo } from "../lib/codegraph-mcp-exposure.ts";
import { SYNC_RETRY_DELAY_MS, SYNC_TIMEOUT_MS, WARMUP_TIMEOUT_MS, type IndexState } from "../lib/codegraph-readiness.ts";
import codeGraphTools, {
	armCodegraphEntryResolverForTest,
	armCodegraphExecForTest,
	armExposureEnsureForTest,
	armIndexStateForTest,
	armStartupDaemonSkipForTest,
	clearSearchWindow,
	createCodeGraphTool,
	codeGraphNodeScript,
	codegraphSyncFailureNotice,
	findCodeGraphNodeScriptOnPath,
	isSameDirectory,
	isWorkspaceProjectRoot,
	awaitSearchSync,
	warmNotice,
	indexStartNotice,
	indexedNotice,
	SYNC_FRESH_WINDOW_MS,
	DAEMON_SKIP_MS,
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

/** Pins process.platform for the test's lifetime, so the win32-gated paths (S11) are exercised on any host. */
function withPlatform(t: test.TestContext, platform: string): void {
	const previous = process.platform;
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
	t.after(() => Object.defineProperty(process, "platform", { configurable: true, value: previous }));
}

/** The endpoint a test daemon binds on the native platform: on Windows the daemon's IPC is a
 * named pipe, not a filesystem socket, so the fixture asks the platform before binding —
 * withPlatform cannot change what an already-listening server answers on. */
function nativeSocketPath(home: string): string {
	// The Windows named-pipe prefix built from char codes: a backslash-dense literal is
	// corruption-prone in generated source.
	const backslash = String.fromCharCode(92);
	const pipePrefix = backslash + backslash + "." + backslash + "pipe" + backslash;
	return process.platform === "win32"
		? pipePrefix + "gentle-shell-codegraph-" + randomUUID()
		: join(home, "daemon.sock");
}

/** A fake daemon socket server answering initialize and tools/call like the real daemon.
 * `initializeDelayMs` holds the initialize reply back so a test can interleave work (a newer
 * session starting) while a warm-up against the socket is still pending. The optional
 * handshake holds the initialize reply until the test releases it: onInitialize fires when
 * that request arrives, onCall when the client sends its first post-initialize request. */
interface DaemonServerHandshake {
	onInitialize?: () => void;
	releaseInitialize?: Promise<void>;
	onCall?: () => void;
}

function fakeDaemonServer(initializeDelayMs = 0, handshake: DaemonServerHandshake = {}): net.Server {
	return net.createServer((socket) => {
		socket.on("error", () => {});
		socket.write(JSON.stringify({ codegraph: "1.6.0", protocol: 1 }) + "\n");
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				const message = JSON.parse(line) as { id?: number; method?: string };
				const reply = (result: unknown): void => {
					socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
				};
				if (message.method === "initialize") {
					const greeting = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0" } };
					handshake.onInitialize?.();
					if (handshake.releaseInitialize) void handshake.releaseInitialize.then(() => reply(greeting));
					else if (initializeDelayMs === 0) reply(greeting);
					else setTimeout(() => reply(greeting), initializeDelayMs);
					continue;
				}
				if (message.method === "tools/call") {
					handshake.onCall?.();
					reply({ content: [{ type: "text", text: "daemon answer" }], isError: false });
				}
			}
		});
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

test("a daemon attempt the caller aborts mid-flight is discarded without paying for the CLI fallback", async (t) => {
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	let attempts = 0;
	let warmCalls = 0;
	let runnerCalls = 0;
	let startedResolve: () => void = () => {};
	const attemptStarted = new Promise<void>((resolve) => {
		startedResolve = resolve;
	});
	// A wedged daemon socket: the attempt never settles, so the abort — not the attempt — ends
	// the wait. Cancelling at that point must leave the discarded answer unpaid for: no warm-up,
	// and never a CLI fallback run whose success result would mask the cancellation.
	const wedged: DaemonExplore = () => {
		attempts += 1;
		startedResolve();
		return new Promise<DaemonCallResult>(() => {
			/* never settles: a wedged daemon socket */
		});
	};
	const caller = new AbortController();
	const search = createCodeGraphTool(async () => {
		runnerCalls += 1;
		return { stdout: "cli answer", stderr: "" };
	}, {
		daemonExplore: wedged,
		rewarm: noRewarm,
		warm: async () => {
			warmCalls += 1;
			return true;
		},
		syncRun: syncNothing,
	}).execute("test", { operation: "query", query: "symbol" }, caller.signal, undefined, ctx);
	void attemptStarted.then(() => caller.abort());
	const result = await Promise.race([
		search,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("execute did not return after the aborted attempt")), 3_000)),
	]);
	assert.equal(attempts, 1, "exactly one daemon attempt started before the abort");
	assert.equal(warmCalls, 0, "the aborted search never enters the warm-up stage");
	assert.equal(runnerCalls, 0, "an aborted daemon attempt must not fall through to the CLI runner");
	assert.match(result.content[0].text, /CodeGraph failed to run/);
	assert.equal((result.details as { status?: string }).status, "failed");
});
test("a cancellation that lands during the sync wait never starts the first daemon attempt", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const ctx = { cwd } as ExtensionContext;
	let attempts = 0;
	let runnerCalls = 0;
	let refreshStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		refreshStarted = resolve;
	});
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tool = createCodeGraphTool(async () => {
		runnerCalls += 1;
		return { stdout: "cli answer", stderr: "" };
	}, {
		daemonExplore: async () => {
			attempts += 1;
			return { status: "ok", text: "daemon answer" };
		},
		rewarm: noRewarm,
		warm: async () => true,
		// A gated refresh over a real index: the abort below lands while the sync is still in
		// flight, not before it starts.
		syncRun: async () => {
			refreshStarted?.();
			await gate;
			return true;
		},
	});
	const caller = new AbortController();

	const search = tool.execute("test", { operation: "query", query: "symbol" }, caller.signal, undefined, ctx);
	// The deadline bounds the whole sequence, awaiting the refresh start included: a regression
	// that never calls syncRun cannot park the test at `await started` before any deadline exists.
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		deadlineTimer = setTimeout(() => reject(new Error("the refresh never started or the aborted search never returned")), 3_000);
	});
	try {
		await Promise.race([started, deadline]);
		caller.abort();
		const result = await Promise.race([search, deadline]);
		assert.equal(attempts, 0, "a search cancelled mid-refresh must not open a daemon socket whose answer nobody waits for");
		assert.equal(runnerCalls, 0, "a search cancelled mid-refresh must not pay for the CLI fallback");
		assert.match(result.content[0].text, /CodeGraph failed to run/);
		assert.equal((result.details as { status?: string }).status, "failed");
	} finally {
		// The gate is released on every exit — success, timeout, or assertion failure — and the
		// deadline is cleared: a settled race never leaves a referenced timer behind.
		clearTimeout(deadlineTimer);
		release?.();
		// The abandoned search settles against the released gate; a deadline that fired first
		// must not turn its eventual rejection into an unhandled one.
		void search.catch(() => { /* already reported by the deadline or the assertions */ });
		await settled();
	}
});

test("an already-aborted caller returns the abort failure before the re-warm, background sync, and first daemon attempt", async (t) => {
	withoutChildEnv(t);
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

	clearSearchWindow();
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
	// The child first proves the overrides took effect: Node reads HOME on POSIX and
	// USERPROFILE on Windows for homedir(), and TMPDIR/TEMP/TMP for tmpdir() — all five are
	// pointed at the missing path, so neither resolution can fall back to a real directory
	// before the module is imported.
	const childScript = [
		"import { homedir, tmpdir } from \"node:os\";",
		`const missing = ${JSON.stringify(missing)};`,
		"if (homedir() !== missing || tmpdir() !== missing) {",
		"  console.error(\"overrides ineffective: home=\" + homedir() + \" tmp=\" + tmpdir());",
		"  process.exit(1);",
		"}",
		`await import(${JSON.stringify(new URL("../extensions/codegraph-tools.ts", import.meta.url).href)});`,
		"console.log(\"codegraph-tools loaded\");",
	].join("\n") + "\n";
	writeFileSync(script, childScript);
	const child = spawnSync(process.execPath, ["--experimental-strip-types", script], {
		encoding: "utf8",
		env: { ...process.env, HOME: missing, USERPROFILE: missing, TMPDIR: missing, TEMP: missing, TMP: missing },
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

test("the default query path speaks codegraph_search over the socket: the name the daemon dispatches", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	// A socket-level daemon mirroring the real one's dispatch table: codegraph_search is a
	// registered tool (query + limit), while any other name gets the same "Unknown tool"
	// isError reply the real daemon's default case builds — so the tool name on the wire
	// decides whether the socket can ever serve a query.
	const home = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-sockhome-")));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const registryDir = join(home, ".codegraph", "daemons");
	mkdirSync(registryDir, { recursive: true });
	// The endpoint binds on the native platform: on Windows the daemon IPC is a named pipe,
	// not a filesystem socket, so the fixture asks the platform before binding.
	const socketPath = nativeSocketPath(home);
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		socket.write(JSON.stringify({ codegraph: "1.6.0", protocol: 1 }) + "\n");
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				const message = JSON.parse(line) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
				if (message.method === "initialize") {
					socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0" } } }) + "\n");
					continue;
				}
				if (message.method === "tools/call") {
					const name = String(message.params?.name);
					calls.push({ name, args: message.params?.arguments ?? {} });
					const result = name === "codegraph_search"
						? { content: [{ type: "text", text: "daemon answer" }], isError: false }
						: { content: [{ type: "text", text: "Error: Unknown tool: " + name }], isError: true };
					socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	writeFileSync(join(registryDir, "record.json"), JSON.stringify({ root: cwd, socketPath, startedAt: 1, pid: process.pid }));
	// The daemon registry is found through homedir(), which follows HOME on POSIX and
	// USERPROFILE on Windows — both pointed at the fixture home for this test.
	const previousHome = process.env.HOME;
	const previousProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
		resetDaemonRegistryMemo();
	});
	resetDaemonRegistryMemo();

	// daemonExplore left at its default: the production queryViaDaemon is the code under test.
	const tool = createCodeGraphTool(async () => ({ stdout: "cli answer", stderr: "" }), {
		rewarm: noRewarm,
		warm: async () => true,
		syncRun: syncNothing,
	});
	const result = await tool.execute("test", { operation: "query", query: "symbol", limit: 4 }, undefined, undefined, { cwd } as ExtensionContext);

	assert.deepEqual(result.content, [{ type: "text", text: "daemon answer" }], "a registered tool name is served by the socket");
	assert.deepEqual(calls, [{ name: "codegraph_search", args: { query: "symbol", limit: 4 } }], "the query operation speaks the daemon's registered codegraph_search tool");
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

test("every search awaits its own refresh; only the search-window caches reset per prompt", async (t) => {
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

	assert.ok(handlers.has("before_agent_start"), "the search-window reset lives at the user-prompt boundary");
	assert.ok(handlers.has("session_start"), "session_start still prepares readiness");

	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const calls: string[][] = [];
	const syncRun = async (args: readonly string[]): Promise<boolean> => {
		calls.push([...args]);
		return true;
	};
	const ctx = { cwd } as ExtensionContext;
	assert.equal(await awaitSearchSync(cwd, ctx, syncRun), true);
	if (process.platform === "win32") {
		assert.equal(await awaitSearchSync(cwd, ctx, syncRun), false, "win32 serves a search inside the freshness window from the last settled sync (S11)");
		assert.deepEqual(calls, [["sync", "-q"]]);
	} else {
		assert.equal(await awaitSearchSync(cwd, ctx, syncRun), true, "every search refreshes, not only the first of a prompt");
		assert.deepEqual(calls, [["sync", "-q"], ["sync", "-q"]]);
	}
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

	// One armed spy spans both phases: re-arming between them resets the once-per-process
	// flag and would hide a child session that incorrectly consumed the parent's only
	// exposure attempt — with one spy, the parent counts prove the child consumed nothing.
	const exposure = exposureIo();
	armExposureEnsureForTest(exposure.io);
	process.env.GENTLE_PI_AGENTS_CHILD = "1";
	sessionStart({ reason: "startup" }, ctx);
	sessionStart({ reason: "startup" }, ctx);
	assert.equal(exposure.reads.length, 0, "a child session never reads an agent mcp.json");
	delete process.env.GENTLE_PI_AGENTS_CHILD;

	// The parent session ensures exactly once against the SAME armed state: the first parent
	// start performs the only update attempt and the second is a per-process no-op.
	sessionStart({ reason: "startup" }, ctx);
	sessionStart({ reason: "startup" }, ctx);
	assert.equal(exposure.reads.length, 4, "each agent-home mcp.json is read once per update attempt (initial read plus the pre-publish re-verify)");
	assert.equal(exposure.writes.length, 2, "each agent-home mcp.json is written exactly once");
});

test("a refresh already in flight is awaited, never duplicated", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	let runs = 0;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const syncRun = async (): Promise<boolean> => {
		runs += 1;
		await gate;
		return true;
	};
	const ctx = { cwd } as ExtensionContext;
	const first = awaitSearchSync(cwd, ctx, syncRun);
	const second = awaitSearchSync(cwd, ctx, syncRun);
	release?.();
	assert.equal(await first, true);
	assert.equal(await second, true, "the second caller awaits the same in-flight refresh");
	assert.equal(runs, 1, "one refresh covers both callers");
});

test("win32: searches inside the sync freshness window pay one sync; an expired window syncs again", async (t) => {
	withoutChildEnv(t);
	withPlatform(t, "win32");
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const calls: string[][] = [];
	const syncRun = async (args: readonly string[]): Promise<boolean> => {
		calls.push([...args]);
		return true;
	};
	// The window arithmetic is observable without one real minute of waiting: the clock moves
	// exactly as far as the window is long, the way the readiness budget tests drive it.
	let now = Date.now();
	const realNow = Date.now;
	Date.now = () => now;
	t.after(() => {
		Date.now = realNow;
	});
	const tool = createCodeGraphTool(async () => ({ stdout: "cli", stderr: "" }), {
		daemonExplore: daemonOk,
		rewarm: noRewarm,
		syncRun,
	});
	const ctx = { cwd } as ExtensionContext;

	const first = await tool.execute("test", { operation: "query", query: "one" }, undefined, undefined, ctx);
	assert.equal((first.details as { syncTriggered?: boolean }).syncTriggered, true, "the first search refreshes");
	const second = await tool.execute("test", { operation: "explore", query: "two" }, undefined, undefined, ctx);
	assert.equal((second.details as { syncTriggered?: boolean }).syncTriggered, undefined, "a search inside the window runs no sync of its own");
	assert.deepEqual(calls, [["sync", "-q"]], "one sync covers both searches inside the window");

	now += SYNC_FRESH_WINDOW_MS;
	const third = await tool.execute("test", { operation: "query", query: "three" }, undefined, undefined, ctx);
	assert.equal((third.details as { syncTriggered?: boolean }).syncTriggered, true, "the expired window refreshes again");
	assert.deepEqual(calls, [["sync", "-q"], ["sync", "-q"]]);
});

test("win32: a failed sync never marks the window fresh; the next search refreshes again", async (t) => {
	withoutChildEnv(t);
	withPlatform(t, "win32");
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const noDaemon = { registryDir: join(cwd, "no-registry") };
	let mode: "fail" | "throw" | "ok" = "fail";
	const runs: string[] = [];
	const syncRun = async (): Promise<boolean> => {
		runs.push(mode);
		if (mode === "fail") return false;
		if (mode === "throw") throw new Error("refresh exploded");
		return true;
	};
	const ctx = { cwd } as ExtensionContext;

	assert.equal(await awaitSearchSync(cwd, ctx, syncRun, noDaemon), true, "the failed refresh still covered its search");
	assert.equal(await awaitSearchSync(cwd, ctx, syncRun, noDaemon), true, "a failed sync buys no freshness: the next search refreshes again");
	assert.deepEqual(runs, ["fail", "fail"]);

	mode = "throw";
	assert.equal(await awaitSearchSync(cwd, ctx, syncRun, noDaemon), true, "the exploding refresh still covered its search");
	assert.deepEqual(runs, ["fail", "fail", "throw"], "an unexpected exception never marks fresh either");

	mode = "ok";
	assert.equal(await awaitSearchSync(cwd, ctx, syncRun, noDaemon), true, "the first successful sync refreshes");
	assert.equal(await awaitSearchSync(cwd, ctx, syncRun, noDaemon), false, "only a settled successful sync opens the window");
	assert.deepEqual(runs, ["fail", "fail", "throw", "ok"], "exactly one sync inside the fresh window");
});

test("win32: a caller that joins a failing in-flight refresh inherits its verdict, not freshness", async (t) => {
	withoutChildEnv(t);
	withPlatform(t, "win32");
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const noDaemon = { registryDir: join(cwd, "no-registry") };
	let runs = 0;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const syncRun = async (): Promise<boolean> => {
		runs += 1;
		await gate;
		return false;
	};
	const ctx = { cwd } as ExtensionContext;

	const first = awaitSearchSync(cwd, ctx, syncRun, noDaemon);
	const second = awaitSearchSync(cwd, ctx, syncRun, noDaemon);
	await settled();
	release?.();
	assert.equal(await first, true);
	assert.equal(await second, true, "the joiner awaits the same in-flight refresh");
	assert.equal(runs, 1, "one refresh covers both callers");

	assert.equal(await awaitSearchSync(cwd, ctx, syncRun, noDaemon), true, "the failed shared refresh bought no freshness for either caller");
	assert.equal(runs, 2, "the next search syncs again");
});

test("win32: a refresh that ran no sync of its own buys no freshness window", async (t) => {
	withoutChildEnv(t);
	withPlatform(t, "win32");
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	// CodeGraph itself is writing this index right now (a live pid in its own writer lock):
	// the refresh runs no sync here and reports no failure — an outcome this session never
	// confirmed (the writer may still fail) must not open the freshness window, exactly like
	// a sync lease held by another session that ran nothing here either.
	writeFileSync(join(cwd, ".codegraph", "codegraph.lock"), String(process.pid));
	const runs: number[] = [];
	const syncRun = async (): Promise<boolean> => {
		runs.push(runs.length);
		return true;
	};
	const ctx = { cwd } as ExtensionContext;
	const noDaemon = { registryDir: join(cwd, "no-registry") };

	assert.equal(await awaitSearchSync(cwd, ctx, syncRun, noDaemon), true, "the writing-state refresh still covered its search");
	assert.equal(runs.length, 0, "another writer's live lock means this session runs no sync of its own");
	assert.equal(await awaitSearchSync(cwd, ctx, syncRun, noDaemon), true, "an unconfirmed refresh buys no freshness: the next search refreshes again");
	assert.equal(runs.length, 0, "the second search still runs nothing while the writer holds the lock");
});

test("awaitSearchSync: an unindexed workspace starts no doomed sync", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const calls: string[][] = [];
	const syncRun = async (args: readonly string[]): Promise<boolean> => {
		calls.push([...args]);
		return true;
	};
	const ctx = { cwd } as ExtensionContext;
	assert.equal(await awaitSearchSync(cwd, ctx, syncRun), false, "nothing to refresh without an index");
	assert.equal(await awaitSearchSync(cwd, ctx, syncRun), false, "still nothing on a second call");
	await settled();
	assert.deepEqual(calls, [], "no sync, no doomed CLI processes per turn");
});

test("awaitSearchSync: an unexpected exception notifies instead of vanishing", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const notices: Array<{ text: string; level: string }> = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
	} as unknown as ExtensionContext;
	await awaitSearchSync(cwd, ctx, async () => {
		throw new Error("boom: refresh exploded");
	});
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

test("the tool_call guard judges a rebuild at the command's own target, not the caller's checkout", async (t) => {
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
	// The fixtures sit under a directory whose name has a space and every positional is
	// quoted: the target parse must keep each path one shell word, and a spaceless runner
	// temporary could never expose a half-parsed path.
	const { indexed, fresh } = await spacedWorkspaces(t);
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const shellQuoted = (path: string) => "'" + path + "'";
	const verdict = (command: string) =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command } }, { cwd: indexed } as ExtensionContext);

	assert.equal(verdict("codegraph init " + shellQuoted(fresh)), undefined, "a positional target naming another checkout initializes that checkout, not this index");
	assert.equal(verdict("codegraph index " + shellQuoted(fresh)), undefined, "the index rebuild form takes the same positional target");
	assert.equal(verdict("codegraph init -y " + shellQuoted(fresh)), undefined, "flags come before the positional path");
	assert.equal((verdict("codegraph init") as { block?: boolean } | undefined)?.block, true, "a bare rebuild still targets the caller's indexed checkout");
	assert.equal((verdict("codegraph init " + shellQuoted(indexed)) as { block?: boolean } | undefined)?.block, true, "an explicit this-checkout target is the rebuild the guard exists for");
	const nested = join(indexed, "packages", "inner");
	mkdirSync(nested, { recursive: true });
	assert.equal((verdict("codegraph index " + shellQuoted(nested)) as { block?: boolean } | undefined)?.block, true, "a target inside this repo resolves to this repo's initialized index");
});

test("the guard reads a quoted positional target as one shell word", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);
	const { fresh } = await spacedWorkspaces(t);
	// Assembled from char codes: backslash literals are corruption-prone in generated code.
	const dquote = String.fromCharCode(34);
	const backslash = String.fromCharCode(92);
	assert.equal(verdict("codegraph init " + dquote + fresh + dquote), undefined, "a double-quoted path with spaces is one shell word naming the fresh checkout");
	assert.equal(
		verdict("codegraph init " + fresh.split(" ").join(backslash + " ")),
		undefined,
		"a backslash-escaped space keeps the target one word",
	);
	const unterminated = verdict("codegraph init '" + fresh) as { block?: boolean } | undefined;
	assert.equal(unterminated?.block, true, "an unterminated quote is a form the parser cannot place: it is judged at the caller's indexed checkout");
});

test("the tool_call guard judges a rebuild by CodeGraph's own target rules, not the Git root", async (t) => {
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
	// The index lives in a subdirectory and the Git root above it carries none: the CLI
	// resolves `index [path]` exactly and a bare `index` at the caller's cwd, walking up
	// for the nearest initialized ancestor — never down or sideways from the Git root.
	const root = workspace(t);
	const sub = join(root, "packages", "inner");
	mkdirSync(sub, { recursive: true });
	await writeIndex(["init", sub], { cwd: sub, maxBuffer: 1 });
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const verdictFrom = (cwd: string, command: string) =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command } }, { cwd } as ExtensionContext);

	assert.equal((verdictFrom(sub, "codegraph index") as { block?: boolean } | undefined)?.block, true, "a bare index from the initialized subdirectory resolves that subdirectory, not the unindexed Git root");
	assert.equal((verdictFrom(root, "codegraph index " + sub) as { block?: boolean } | undefined)?.block, true, "an explicit initialized target below the Git root is rebuilt exactly there");
	assert.equal((verdictFrom(sub, "codegraph init") as { block?: boolean } | undefined)?.block, true, "a bare init from the initialized subdirectory is judged at that same target");
	assert.equal(verdictFrom(root, "codegraph index"), undefined, "a bare index from the unindexed root finds no initialized ancestor above it: nothing existing is rebuilt");
	assert.equal(verdictFrom(root, "codegraph init"), undefined, "an init of the unindexed root creates the first index there: no existing index is rebuilt");
	const nonGit = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-nogit-")));
	t.after(() => rmSync(nonGit, { recursive: true, force: true }));
	await writeIndex(["init", nonGit], { cwd: nonGit, maxBuffer: 1 });
	assert.equal((verdictFrom(root, "codegraph index " + nonGit) as { block?: boolean } | undefined)?.block, true, "an initialized target outside any Git repository is rebuilt exactly there too");
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

/** A pair of Git workspaces under a directory whose name contains a space — the indexed one
 * carries a written index, the fresh one none. Rebuild-guard tests quote their positional
 * paths, and the space makes every quote load-bearing: a spaceless runner temporary could
 * never tell a parsed path from a half-parsed one. */
async function spacedWorkspaces(t: test.TestContext): Promise<{ indexed: string; fresh: string }> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-spaced-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const under = (name: string): string => {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
		return dir;
	};
	const indexed = under("indexed checkout");
	await writeIndex(["init", indexed], { cwd: indexed, maxBuffer: 1 });
	return { indexed, fresh: under("fresh checkout") };
}

test("the tool_call guard judges a rebuild from the directory the command list changed into", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	codeGraphTools({
		registerTool() { /* the registered tool's shape is covered above */ },
		on(event, handler) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const guard = handlers.get("tool_call");
	const { indexed, fresh } = await spacedWorkspaces(t);
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const verdictFrom = (cwd: string, command: string) =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command } }, { cwd } as ExtensionContext);
	const shellQuoted = (path: string) => "'" + path + "'";

	assert.equal(verdictFrom(indexed, "cd " + shellQuoted(fresh) + " && codegraph init"), undefined, "an init run inside the unindexed sibling is that sibling's legitimate first init");
	assert.equal(verdictFrom(indexed, "cd " + shellQuoted(fresh) + " && codegraph index"), undefined, "the index form finds no initialized target at or above the sibling either");
	const reversed = verdictFrom(fresh, "cd " + shellQuoted(indexed) + " && codegraph init") as { block?: boolean; reason?: string } | undefined;
	assert.equal(reversed?.block, true, "an init run inside the indexed sibling would rebuild its index");
	assert.match(reversed?.reason ?? "", /an index already exists/);
	const unknowable = verdictFrom(fresh, "cd $TARGET && codegraph init") as { block?: boolean } | undefined;
	assert.equal(unknowable?.block, true, "a cd this walk cannot follow never leaves the caller's directory as proof the target is unindexed");
	assert.equal(verdictFrom(fresh, "cd $TARGET && GENTLE_CODEGRAPH_ALLOW_INDEX=1 codegraph init"), undefined, "the override on the rebuild itself still authorizes it");
});

test("the guard treats cd - as a directory change it cannot name", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	codeGraphTools({
		registerTool() { /* the registered tool's shape is covered above */ },
		on(event, handler) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const guard = handlers.get("tool_call");
	const indexed = workspace(t);
	await writeIndex(["init", indexed], { cwd: indexed, maxBuffer: 1 });
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const verdictFrom = (command: string) =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command } }, { cwd: indexed } as ExtensionContext);

	// `cd -` means OLDPWD — a directory this walk cannot establish, never a child spelled "-":
	// an unknown directory never proves the target unindexed, so the rebuild is blocked.
	const verdict = verdictFrom("cd - && codegraph init") as { block?: boolean; reason?: string } | undefined;
	assert.equal(verdict?.block, true, "an OLDPWD cd leaves the rebuild's directory unknowable, not a child spelled -");
	assert.match(verdict?.reason ?? "", /an index already exists/);
});

test("the guard keeps the caller's directory when a conditional list skips its cd", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	codeGraphTools({
		registerTool() { /* the registered tool's shape is covered above */ },
		on(event, handler) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const guard = handlers.get("tool_call");
	const { indexed, fresh } = await spacedWorkspaces(t);
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const verdictFrom = (cwd: string, command: string) =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command } }, { cwd } as ExtensionContext);
	const destination = "'" + indexed + "'";

	// An OR list whose left command certainly succeeds skips its cd: the init runs in the
	// caller's fresh checkout, and the skipped destination must not block that first init.
	assert.equal(verdictFrom(fresh, "true || cd " + destination + " && codegraph init"), undefined, "a skipped branch's destination is not the effective directory of the rebuild");
	// The branch that does run is still judged at its destination.
	const runs = verdictFrom(fresh, "false || cd " + destination + " && codegraph init") as { block?: boolean } | undefined;
	assert.equal(runs?.block, true, "a cd its branch reaches still moves the rebuild's directory");
	// An AND list whose left command certainly fails skips its cd — and the guarded rebuild with it.
	assert.equal(verdictFrom(fresh, "false && cd " + destination + " && codegraph init"), undefined, "a cd its branch skips moves nothing");
	// A branch this walk cannot evaluate leaves the directory unknowable, never the destination.
	const unknowable = verdictFrom(fresh, "grep -q x file || cd " + destination + " && codegraph init") as { block?: boolean } | undefined;
	assert.equal(unknowable?.block, true, "an unknowable branch never proves the rebuild unindexed");
	// The unconditional form is unchanged.
	const unconditional = verdictFrom(fresh, "cd " + destination + " && codegraph init") as { block?: boolean } | undefined;
	assert.equal(unconditional?.block, true, "the successful cd && form still judges the destination");
});

test("the guard judges a cd's failure path too, because a cd can fail and leave the shell where it was", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	codeGraphTools({
		registerTool() { /* the registered tool's shape is covered above */ },
		on(event, handler) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const guard = handlers.get("tool_call");
	const { indexed, fresh } = await spacedWorkspaces(t);
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const verdictFrom = (cwd: string, command: string) =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command } }, { cwd } as ExtensionContext);
	const shellQuoted = (path: string) => "'" + path + "'";
	// A destination that is not there when the guard runs: whether it appears (or is created
	// by an earlier command) before the cd runs is beyond this walk, so neither outcome is
	// disproven and both paths stay live.
	const missing = join(fresh, "missing checkout");

	// The cd fails at run time, so bash stays in the caller's checkout and runs the ||
	// fallback there: an indexed caller is never proven safe by the missing destination.
	const fallback = verdictFrom(indexed, "cd " + shellQuoted(missing) + " || codegraph init") as { block?: boolean; reason?: string } | undefined;
	assert.equal(fallback?.block, true, "a cd that fails leaves the shell in the indexed checkout, where the || fallback rebuilds it");
	assert.match(fallback?.reason ?? "", /an index already exists/);
	// An unconditional separator reaches the next command on both paths - the destination when
	// the cd succeeded, the caller's checkout when it failed - so both are judged.
	const separated = verdictFrom(indexed, "cd " + shellQuoted(missing) + "; codegraph init") as { block?: boolean } | undefined;
	assert.equal(separated?.block, true, "a semicolon-reached rebuild is judged in every directory the cd can leave the shell in");
	// The same failed cd in an unindexed caller leaves the fallback a legitimate first init.
	assert.equal(verdictFrom(fresh, "cd " + shellQuoted(missing) + " || codegraph init"), undefined, "a failed cd keeps the shell in the unindexed checkout, so its fallback init is that checkout's first");
	// A || fallback behind a cd that does succeed never runs at all, and the failure path it
	// would owe is the caller's own unindexed checkout.
	assert.equal(verdictFrom(fresh, "cd " + shellQuoted(indexed) + " || codegraph init"), undefined, "the || fallback of a successful cd runs only in the caller's checkout, which holds no index here");
	// The && continuation runs only behind a cd that succeeded, so it is judged at the
	// destination alone: a missing destination still holds no index.
	assert.equal(verdictFrom(indexed, "cd " + shellQuoted(missing) + " && codegraph init"), undefined, "a cd that could fail never runs its && rebuild in the caller's checkout");
	// A cd into a fresh checkout that does succeed keeps judging (and allowing) its own init.
	assert.equal(verdictFrom(indexed, "cd " + shellQuoted(fresh) + " && codegraph init"), undefined, "a successful directory change into a fresh checkout still authorizes the first init there");
});

test("the guard keeps a pipeline's status unknowable unless every stage agrees", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);

	// Without pipefail the last stage's success is the pipeline's status; with it the earlier
	// failure decides. Both readings are live, so the || fallback is reachable and the indexed
	// checkout behind it must be checked.
	const mixed = verdict("false | true || codegraph init") as { block?: boolean; reason?: string } | undefined;
	assert.equal(mixed?.block, true, "a pipeline whose stages disagree has no provable status, so its || branch is reachable");
	assert.match(mixed?.reason ?? "", /an index already exists/);
	// A pipeline whose every stage holds the same status reports it under either reading, so
	// the branch behind it stays provably unreachable.
	assert.equal(verdict("true | true || codegraph init"), undefined, "an all-successful pipeline fails nowhere, so its || branch never runs");
	// Standalone commands keep pruning by their own certain status.
	assert.equal(verdict("true || codegraph init"), undefined, "a certain success still makes its || branch unreachable");
	const reached = verdict("false || codegraph init") as { block?: boolean } | undefined;
	assert.equal(reached?.block, true, "a certain failure still makes its || branch reach the rebuild");
});

/** The tool_call guard's verdict function over a spaced indexed/fresh checkout pair, with the
 * launch override cleared for the test's lifetime: the callers the pipeline and branch tests
 * judge a command list against. */
async function guardVerdicts(t: test.TestContext): Promise<{
	verdictFrom: (cwd: string, command: string) => unknown;
	indexed: string;
	fresh: string;
}> {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	codeGraphTools({
		registerTool() { /* the registered tool's shape is covered above */ },
		on(event, handler) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const guard = handlers.get("tool_call");
	const { indexed, fresh } = await spacedWorkspaces(t);
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	return {
		indexed,
		fresh,
		verdictFrom: (cwd, command) =>
			(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command } }, { cwd } as ExtensionContext),
	};
}

test("the guard reads an adjacent |& as one pipeline separator", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);

	// `|&` pipes stderr into the next stage as well, so the stages are one pipeline: its first
	// stage certainly fails, no other reading proves the group's status, and the || continuation
	// therefore runs in the indexed checkout.
	const piped = verdict("false |& true | true || codegraph init") as { block?: boolean; reason?: string } | undefined;
	assert.equal(piped?.block, true, "a stage joined by |& belongs to the same pipeline, whose failure reaches the || continuation");
	assert.match(piped?.reason ?? "", /an index already exists/);
	// The two-stage form folds the same way.
	const direct = verdict("false |& true || codegraph init") as { block?: boolean } | undefined;
	assert.equal(direct?.block, true, "an adjacent |& folds both stages, so the failed first stage keeps the group's status unproven");
	// A lone & is still a background separator: the second true is a command of its own, and
	// its certain success makes the || branch unreachable.
	assert.equal(verdict("true & true || codegraph init"), undefined, "a separate background separator never joins a pipeline");
});

test("the guard decides a pipeline's reachability once, not stage by stage", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);

	// false fails, so the shell skips the whole && pipeline: none of its stages runs, and the
	// init joined to it by | never reaches any directory.
	assert.equal(verdict("false && true | codegraph init"), undefined, "a skipped pipeline runs none of its stages, whatever separator joins them");
	// A pipeline whose guard this walk cannot evaluate is still judged in full.
	const reached = verdict("grep -q x file && true | codegraph init") as { block?: boolean } | undefined;
	assert.equal(reached?.block, true, "an unknowable guard leaves the whole pipeline running, so its rebuild is judged");
});

test("the guard keeps a pipeline stage's cd out of the parent shell's directory", async (t) => {
	const { verdictFrom, indexed, fresh } = await guardVerdicts(t);
	const shellQuoted = (path: string) => "'" + path + "'";

	// Every stage of a pipeline runs in its own subshell, so without lastpipe the cd of the
	// last stage never moves the parent: the && init still runs in the indexed caller.
	const piped = verdictFrom(indexed, "true | cd " + shellQuoted(fresh) + " && codegraph init") as { block?: boolean; reason?: string } | undefined;
	assert.equal(piped?.block, true, "a cd inside a pipeline stage leaves the parent's indexed directory in place for the && rebuild");
	assert.match(piped?.reason ?? "", /an index already exists/);
	// A command outside any pipeline is the parent shell itself, so its cd still moves it.
	assert.equal(verdictFrom(indexed, "cd " + shellQuoted(fresh) + " && codegraph init"), undefined, "a cd outside a pipeline still moves the parent shell");
	// With lastpipe the stage's cd can reach the parent, so the destination stays a possible
	// directory for the continuation rather than being dropped.
	const lastpipe = verdictFrom(fresh, "true | cd " + shellQuoted(indexed) + " && codegraph init") as { block?: boolean } | undefined;
	assert.equal(lastpipe?.block, true, "a last-stage cd that lastpipe applies in the parent keeps the destination live");
});

test("the guard carries a skipped branch's directory and status forward", async (t) => {
	const { verdictFrom, indexed, fresh } = await guardVerdicts(t);
	const shellQuoted = (path: string) => "'" + path + "'";
	const missing = join(fresh, "missing checkout");

	// The cd fails at run time, so its && continuation never runs and the shell stays in the
	// indexed caller for the unconditional init after the semicolon.
	const skipped = verdictFrom(indexed, "cd " + shellQuoted(missing) + " && true; codegraph init") as { block?: boolean; reason?: string } | undefined;
	assert.equal(skipped?.block, true, "a skipped && command leaves the failed cd's directory live for the command after it");
	assert.match(skipped?.reason ?? "", /an index already exists/);
	// The skipped state keeps its own directory instead of inheriting the branch destination.
	const destination = verdictFrom(indexed, "cd " + shellQuoted(fresh) + " && true; codegraph init") as { block?: boolean } | undefined;
	assert.equal(destination?.block, true, "the cd's failure path keeps the indexed caller reachable for the unconditional init");
	// The && continuation alone still runs at the destination only, which holds no index.
	assert.equal(verdictFrom(indexed, "cd " + shellQuoted(missing) + " && codegraph init"), undefined, "a cd that could fail never runs its && rebuild in the caller's checkout");
});

test("the guard forms a conditional operator only from adjacent separators", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	codeGraphTools({
		registerTool() { /* the registered tool's shape is covered above */ },
		on(event, handler) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const guard = handlers.get("tool_call");
	const { indexed, fresh } = await spacedWorkspaces(t);
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const verdictFrom = (cwd: string, command: string) =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command } }, { cwd } as ExtensionContext);
	const shellQuoted = (path: string) => "'" + path + "'";

	// Two background separators with a command between them are two separate `&`: the second
	// one introduces the cd, which runs unconditionally, and the init lands in the fresh
	// checkout behind the genuinely adjacent `&&` at the end of the list.
	assert.equal(
		verdictFrom(indexed, "true & false & cd " + shellQuoted(fresh) + " && codegraph init"),
		undefined,
		"the second & of `& cmd &` never combines with the first into &&",
	);
	// Control: a genuinely adjacent && still gates the branch — the cd runs behind the
	// certainly-failed false and the init is judged at the indexed destination.
	const gated = verdictFrom(fresh, "false || cd " + shellQuoted(indexed) + " && codegraph init") as { block?: boolean } | undefined;
	assert.equal(gated?.block, true, "an adjacent && after a running cd still forms the conditional");
});

test("a rebuild the walker proves unreachable never reaches the guard", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	codeGraphTools({
		registerTool() { /* the registered tool's shape is covered above */ },
		on(event, handler) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const guard = handlers.get("tool_call");
	const { indexed } = await spacedWorkspaces(t);
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const verdictFrom = (cwd: string, command: string) =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command } }, { cwd } as ExtensionContext);

	// A rebuild its branch provably skips never runs, so it is not the caller's rebuild.
	assert.equal(verdictFrom(indexed, "false && codegraph init"), undefined, "an init behind a certainly-failed command cannot run");
	// A branch this walk cannot evaluate stays checked: the rebuild may still run.
	const unknownBranch = verdictFrom(indexed, "grep -q x file && codegraph init") as { block?: boolean } | undefined;
	assert.equal(unknownBranch?.block, true, "an unknowable branch never proves the rebuild unindexed");
});

test("the walker carries the last executed status past a branch the shell skips", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	codeGraphTools({
		registerTool() { /* the registered tool's shape is covered above */ },
		on(event, handler) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const guard = handlers.get("tool_call");
	const { indexed, fresh } = await spacedWorkspaces(t);
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	const verdictFrom = (cwd: string, command: string) =>
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command } }, { cwd } as ExtensionContext);
	const shellQuoted = (path: string) => "'" + path + "'";

	// The skipped false keeps the success of the true before it: the cd and the init both
	// run, and the first init in the fresh checkout must not be judged at the indexed caller.
	assert.equal(
		verdictFrom(indexed, "true || false && cd " + shellQuoted(fresh) + " && codegraph init"),
		undefined,
		"a skipped command's status never gates the branch after it",
	);
	// The same walk with the indexed destination: the cd runs there and the init is blocked.
	const atIndexed = verdictFrom(fresh, "true || false && cd " + shellQuoted(indexed) + " && codegraph init") as { block?: boolean; reason?: string } | undefined;
	assert.equal(atIndexed?.block, true, "the cd the skipped branch leaves running still moves the rebuild");
	assert.match(atIndexed?.reason ?? "", /an index already exists/);
});

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

test("a rebuild carrying its own override is excluded from the target check", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);
	const fresh = workspace(t);
	assert.equal(
		verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=1 codegraph index .; codegraph init " + fresh),
		undefined,
		"the fresh init carries no override but rebuilds no index: the authorized sibling rebuild pays for itself",
	);
	const leaky = verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=1 codegraph index .; codegraph init .") as { block?: boolean } | undefined;
	assert.equal(leaky?.block, true, "a sibling rebuild without an override still blocks the list at its own indexed target");
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

test("the guard's inline override survives an unrelated assignment after it", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);
	assert.equal(
		verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=1 FOO=bar codegraph index ."),
		undefined,
		"an unrelated assignment between the override and the rebuild changes nothing: the authorized rebuild stays allowed",
	);
	const throughFoo = verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=1 FOO=bar GENTLE_CODEGRAPH_ALLOW_INDEX=0 codegraph init .") as { block?: boolean } | undefined;
	assert.equal(throughFoo?.block, true, "a trailing =0 reached through an unrelated assignment still removes the override: the last assignment to the variable wins");
	const superseded = verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=1 FOO=bar GENTLE_CODEGRAPH_ALLOW_INDEX=0 codegraph index .") as { block?: boolean; reason?: string } | undefined;
	assert.equal(superseded?.block, true, "a later assignment to the override variable itself still wins through the unrelated one");
	assert.match(superseded?.reason ?? "", /an index already exists/);
});

test("the guard strips shell line continuations before locating rebuild commands", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);
	// A backslash-newline pair is removed by the shell before parsing, so the scanner must
	// drop it too. Assembled from char codes because a backslash-before-newline literal
	// is corruption-prone in generated code.
	const continuation = String.fromCharCode(92) + String.fromCharCode(10);
	const bare = verdict("codegraph " + continuation + "index .") as { block?: boolean; reason?: string } | undefined;
	assert.equal(bare?.block, true, "a continued rebuild command is detected and blocked");
	assert.match(bare?.reason ?? "", /an index already exists/);
	const assigned = verdict("FOO=1 " + continuation + "codegraph index .") as { block?: boolean; reason?: string } | undefined;
	assert.equal(assigned?.block, true, "a continuation between a leading assignment and the rebuild verb is removed too");
	assert.equal(verdict("codegraph " + continuation + "status"), undefined, "a continued non-rebuild command stays allowed");
	const quoted = verdict("echo 'foo " + continuation + "bar'; codegraph index .") as { block?: boolean; reason?: string } | undefined;
	assert.equal(quoted?.block, true, "a backslash-newline inside single quotes stays content: the rebuild after the separator is still detected");
});

test("the guard keeps literal quotes inside quoted override values", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);
	// Assembled from char codes: a quote-inside-quotes literal is corruption-prone.
	const dquote = String.fromCharCode(34);
	const squote = String.fromCharCode(39);
	const innerQuoted = "GENTLE_CODEGRAPH_ALLOW_INDEX=" + dquote + squote + "1" + squote + dquote + " codegraph index .";
	const blocked = verdict(innerQuoted) as { block?: boolean; reason?: string } | undefined;
	assert.equal(blocked?.block, true, "an override value of '1' (quotes included) is not the exact value 1: the rebuild stays blocked");
	assert.match(blocked?.reason ?? "", /an index already exists/);
	assert.equal(verdict("GENTLE_CODEGRAPH_ALLOW_INDEX=" + dquote + "1" + dquote + " codegraph index ."), undefined, "a plain quoted 1 is still the exact value 1 and authorizes");
});

test("the guard does not classify here-document bodies as rebuild commands", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);
	assert.equal(verdict("cat <<'EOF'\ncodegraph init\ncodegraph index .\nEOF"), undefined, "heredoc body lines are the command's input, not rebuilds");
	assert.equal(verdict("cat <<EOF\ncodegraph init\n"), undefined, "an unclosed heredoc body runs to the end of the input");
	assert.equal(verdict("cat <<-EOF\n\tcodegraph init\n\tEOF\ncodegraph status"), undefined, "a <<- delimiter with tab-indented body lines closes the body");
	assert.equal((verdict("cat <<EOF\nbody\nEOF\ncodegraph index .") as { block?: boolean } | undefined)?.block, true, "commands after the closing delimiter are still inspected");
	assert.equal((verdict("cat <<EOF; codegraph index .\nbody\nEOF") as { block?: boolean } | undefined)?.block, true, "a rebuild after the operator on the introducing line is still detected");
	assert.equal(verdict("cat <<< codegraph init"), undefined, "a here-string is one word of one command, never split into commands");
});

test("the guard ignores here-document operators inside Bash comments", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);
	assert.equal(
		(verdict("# uses <<EOF\ncodegraph index .") as { block?: boolean } | undefined)?.block,
		true,
		"a comment's << opens no here-document: the next line's rebuild still runs and is blocked",
	);
	assert.equal(
		(verdict("# don't <<EOF\ncodegraph index .") as { block?: boolean } | undefined)?.block,
		true,
		"quotes inside a comment are comment text: they open no quoted section and hide no rebuild",
	);
	assert.equal(
		(verdict("cat <<EOF # a trailing comment <<X\nbody\nEOF\ncodegraph index .") as { block?: boolean } | undefined)?.block,
		true,
		"a second << named only in a trailing comment reads no second body: the rebuild after the closing delimiter is seen",
	);
	assert.equal(verdict("echo codegraph # <<EOF"), undefined, "a comment after a non-rebuild command neither hides nor blocks anything");
	assert.equal(verdict("echo foo#bar <<EOF\ncodegraph index .\nEOF"), undefined, "a # mid-word starts no comment: the here-document body stays the command's input");
});

test("the guard keeps an escaped space inside the word: # after it starts no comment", async (t) => {
	const verdict = await guardOnIndexedWorkspace(t);
	// Assembled from char codes: a backslash-before-space literal is corruption-prone in generated code.
	const escapedSpace = String.fromCharCode(92) + " ";
	const newline = String.fromCharCode(10);
	// The escaped space keeps the word open, so the # after it is a literal argument and the
	// <<'EOF' operator is real: the body's example rebuild is the command's input, never a command.
	const escaped = verdict("cat foo" + escapedSpace + "#note <<'EOF'" + newline + "codegraph index ." + newline + "EOF");
	assert.equal(escaped, undefined, "an escaped space is not a comment boundary: the here-document body stays data");
	// The unescaped form is a real comment: its << opens nothing, so the next line's rebuild is a command.
	const commented = verdict("cat foo #note <<'EOF'" + newline + "codegraph index ." + newline + "EOF") as { block?: boolean } | undefined;
	assert.equal(commented?.block, true, "a real comment's operator opens nothing: the following rebuild runs and is blocked");
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
	const entryScript = writeCodeGraphPackage(binDir, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
	// A workspace path carrying a literal metacharacter: "&" splits a command under any
	// shell reinterpretation, so the child receiving the path as ONE argv value is the
	// no-shell proof the test title names.
	const metacharHolder = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-metachar-")));
	t.after(() => rmSync(metacharHolder, { recursive: true, force: true }));
	const cwd = join(metacharHolder, "a&b");
	mkdirSync(cwd);
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	if (process.platform !== "win32") {
		const gitShim = join(binDir, "git");
		writeFileSync(gitShim, "#!/bin/sh\nprintf '%s\\n' \"$PWD\"\n");
		chmodSync(gitShim, 0o755);
	}
	withWindowsPath(t, binDir);

	const previousPlatform = process.platform;
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	t.after(() => Object.defineProperty(process, "platform", { configurable: true, value: previousPlatform }));
	// The pinned entry keeps the real process boundary under test on every host: the resolver
	// answers process.execPath + the fixture's npm-shim.js, so no CodeGraph installation is
	// needed and the handcrafted .cmd's rejection cannot skip the spawn.
	const restoreResolver = armCodegraphEntryResolverForTest(() => ({ status: "entry", entry: { node: process.execPath, script: entryScript } }));
	t.after(restoreResolver);

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

/** The POSIX-host stand-in for git under a clobbered PATH: every git interrogation answers with
 * the cwd itself, the way the Windows-launcher fixture above does. */
function writePwdGitShim(binDir: string): void {
	if (process.platform === "win32") return;
	writeFileSync(join(binDir, "git"), "#!/bin/sh\nprintf '%s\\n' \"$PWD\"\n");
	chmodSync(join(binDir, "git"), 0o755);
}

/** A bin dir whose two spawn targets answer differently, so which path ran is one observable
 * string: the package-scan target (npm-shim.js) prints scan:<argv>, while the direct-entry
 * target (dist/cli.js, the file T1's resolver proves) prints direct:<argv>. */
function writeCompetingTargetsBin(t: test.TestContext): { binDir: string; entryScript: string } {
	const binDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-compete-bin-")));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const pkgRoot = join(binDir, "node_modules", "@colbymchenry", "codegraph");
	mkdirSync(join(pkgRoot, "dist"), { recursive: true });
	const echo = (prefix: string) => "process.stdout.write(" + JSON.stringify(prefix) + " + JSON.stringify(process.argv.slice(2)));\n";
	const entryScript = join(pkgRoot, "dist", "cli.js");
	writeFileSync(entryScript, echo("direct:"));
	writeFileSync(join(pkgRoot, "npm-shim.js"), echo("scan:"));
	writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ bin: { codegraph: "npm-shim.js" } }));
	// A scan anchor the per-call fallback can find; the armed resolver bypasses its parsing, so
	// any plain non-npm content serves.
	writeFileSync(join(binDir, "codegraph.cmd"), "rem scan-anchor shim\n");
	return { binDir, entryScript };
}

test("win32: the ENOENT fallback spawns the resolver's entry directly, ahead of the package scan", async (t) => {
	withoutChildEnv(t);
	const { binDir, entryScript } = writeCompetingTargetsBin(t);
	writePwdGitShim(binDir);
	const cwd = workspace(t);
	// The PATH is clobbered while the platform is still the host's own, like the launcher test
	// above: a win32-pinned clobber would join PATH with ";" and leave the host's real codegraph
	// reachable through the intact later ":"-entries.
	withWindowsPath(t, binDir);
	withPlatform(t, "win32");
	const restore = armCodegraphEntryResolverForTest(() => ({ status: "entry", entry: { node: process.execPath, script: entryScript } }));
	t.after(restore);

	const result = await createCodeGraphTool(undefined, { initLock: lockAcquired }).execute(
		"test",
		{ operation: "init" },
		undefined,
		undefined,
		{ cwd } as ExtensionContext,
	);

	assert.equal(result.content[0].text, "direct:" + JSON.stringify(["init", cwd]), "the resolved entry answers, not the package-scan target");
});

test("win32: repeated ENOENT fallbacks consult the resolver, never a fresh PATH scan", async (t) => {
	withoutChildEnv(t);
	// No codegraph.cmd and no package anywhere on this PATH: the per-call scan can never answer,
	// so only the resolver's (process-lifetime cached, T1) entry can — a rescan cannot succeed.
	const binDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-empty-bin-")));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	writePwdGitShim(binDir);
	const cwd = workspace(t);
	withWindowsPath(t, binDir);
	withPlatform(t, "win32");
	const entryScript = join(binDir, "direct-entry.js");
	writeFileSync(entryScript, "process.stdout.write(\"stable answer\");\n");
	let consultations = 0;
	const restore = armCodegraphEntryResolverForTest(() => {
		consultations += 1;
		return { status: "entry", entry: { node: process.execPath, script: entryScript } };
	});
	t.after(restore);

	const tool = createCodeGraphTool(undefined, { initLock: lockAcquired });
	const ctx = { cwd } as ExtensionContext;
	for (let run = 1; run <= 3; run += 1) {
		const result = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
		assert.equal(result.content[0].text, "stable answer", `fallback ${run} is answered by the resolver entry`);
	}
	assert.equal(consultations, 3, "every failure consults the resolver; the once-per-process scan lives inside its cache");
});

test("win32: a rejected first shim never falls through to the package scan", async (t) => {
	withoutChildEnv(t);
	const binDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-rejected-bin-")));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	writeCodeGraphPackage(binDir, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
	writePwdGitShim(binDir);
	const cwd = workspace(t);
	withWindowsPath(t, binDir);
	withPlatform(t, "win32");
	clearCodegraphResolveCache();
	t.after(() => clearCodegraphResolveCache());

	// What the real resolver proves on win32 for a shim shaped like writeCodeGraphPackage's
	// (an invocation line npm never writes): the first shim exists and nothing about it can
	// be reproduced — a rejection, not a miss. Armed because the real resolution needs a
	// Windows filesystem to see the shim at all; the lib suite pins the rejection itself.
	const restore = armCodegraphEntryResolverForTest(() => ({ status: "rejected" }));
	t.after(restore);


	const result = await createCodeGraphTool(undefined, { initLock: lockAcquired }).execute(
	"test",
	{ operation: "init" },
	undefined,
	undefined,
	{ cwd } as ExtensionContext,
	);
	// The package beside the rejected shim would happily answer the scan — substituting it
	// would drop the shim's own invocation — so the cascade must refuse it and end at the
	// bare spawn, which stays a runtime-level miss nothing turns into an answer.
	assert.match(result.content[0].text, /CodeGraph is unavailable/);
	assert.equal((result.details as { status?: string }).status, "unavailable");
});

test("win32: a genuine miss keeps the cascade: no shim, no scan anchor, unavailable", async (t) => {
	withoutChildEnv(t);
	const binDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-miss-bin-")));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	// The package without its shim: no codegraph.cmd anywhere on the fixture PATH, so the
	// resolution is a genuine miss (nothing was rejected) and the per-call scan keeps its
	// turn, finding no anchor to expand.
	writeCodeGraphPackage(binDir, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
	rmSync(join(binDir, "codegraph.cmd"));
	writePwdGitShim(binDir);
	const cwd = workspace(t);
	withWindowsPath(t, binDir);
	withPlatform(t, "win32");
	clearCodegraphResolveCache();
	t.after(() => clearCodegraphResolveCache());
	// The miss is asserted on an isolated PATH a developer's installed shim can never
	// enter, so the assertion means the same thing on every host.
	assert.equal(
		resolveCodegraphShimState({ platform: () => "win32", pathEnv: () => binDir, exists: (path) => existsSync(path), read: (path) => readFileSync(path, "utf8") }).status,
		"miss",
		"no shim on the isolated PATH resolves to a miss",
	);
	// The exec seam records every spawn the cascade attempts without ever launching an
	// executable a host PATH could still expose.
	let attempts = 0;
	const restoreExec = armCodegraphExecForTest((async () => {
		attempts += 1;
		throw Object.assign(new Error("spawn codegraph ENOENT"), { code: "ENOENT" });
	}) as unknown as Parameters<typeof armCodegraphExecForTest>[0]);
	t.after(restoreExec);

	const result = await createCodeGraphTool(undefined, { initLock: lockAcquired }).execute(
	"test",
	{ operation: "init" },
	undefined,
	undefined,
	{ cwd } as ExtensionContext,
	);
	assert.match(result.content[0].text, /CodeGraph is unavailable/);
	assert.equal((result.details as { status?: string }).status, "unavailable");
	assert.ok(attempts >= 1, "the cascade did attempt its spawns; the armed seam launched nothing");
});

test("POSIX: a bare-codegraph ENOENT stays unavailable — no resolver consultation, no package scan", async (t) => {
	withoutChildEnv(t);
	// The pinned platform only steers the branch; the bare spawn itself must still ENOENT the
	// way it does on a real POSIX host — the seam makes that observable under any runtime (bun
	// on Windows would otherwise run the fixture shim through cmd.exe and answer).
	const restoreExec = armCodegraphExecForTest((async () => {
		throw Object.assign(new Error("spawn codegraph ENOENT"), { code: "ENOENT" });
	}) as unknown as Parameters<typeof armCodegraphExecForTest>[0]);
	t.after(restoreExec);
	const binDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-posix-bin-")));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	writeCodeGraphPackage(binDir, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
	writePwdGitShim(binDir);
	const cwd = workspace(t);
	withWindowsPath(t, binDir);
	withPlatform(t, "linux");
	const restore = armCodegraphEntryResolverForTest(() => {
		throw new Error("the resolver is a win32-only consultation (S11)");
	});
	t.after(restore);

	const result = await createCodeGraphTool(undefined, { initLock: lockAcquired }).execute(
		"test",
		{ operation: "init" },
		undefined,
		undefined,
		{ cwd } as ExtensionContext,
	);

	assert.match(result.content[0].text, /CodeGraph is unavailable/);
	assert.equal((result.details as { status?: string }).status, "unavailable");
});

test("win32: a genuine non-ENOENT failure from the resolver entry surfaces as failed, never unavailable", async (t) => {
	withoutChildEnv(t);
	const binDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-winfail-bin-")));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	writePwdGitShim(binDir);
	const cwd = workspace(t);
	withWindowsPath(t, binDir);
	withPlatform(t, "win32");
	const entryScript = join(binDir, "direct-entry.js");
	writeFileSync(entryScript, "process.stdout.write(\"never\")\n");
	const restoreResolver = armCodegraphEntryResolverForTest(() => ({ status: "entry", entry: { node: process.execPath, script: entryScript } }));
	t.after(restoreResolver);
	let scanRan = false;
	const restoreExec = armCodegraphExecForTest((async (_file: string, args: readonly string[]) => {
		if (String(args[0]).endsWith("direct-entry.js")) throw Object.assign(new Error("codegraph exited with status 1"), { code: 1 });
		scanRan = true;
		throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
	}) as unknown as Parameters<typeof armCodegraphExecForTest>[0]);
	t.after(restoreExec);
	const result = await createCodeGraphTool(undefined, { initLock: lockAcquired }).execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext);
	assert.match(result.content[0].text, /CodeGraph failed to run/);
	assert.equal((result.details as { status?: string }).status, "failed");
	assert.equal(scanRan, false, "a genuine failure never falls through to the scan");
});

test("win32: a total miss reports unavailable from the fabricated not-found", async (t) => {
	withoutChildEnv(t);
	const binDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-winmiss-bin-")));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	writePwdGitShim(binDir);
	const cwd = workspace(t);
	withWindowsPath(t, binDir);
	withPlatform(t, "win32");
	const restoreResolver = armCodegraphEntryResolverForTest(() => ({ status: "miss" }));
	t.after(restoreResolver);
	const restoreExec = armCodegraphExecForTest((async () => {
		throw Object.assign(new Error("spawn codegraph ENOENT"), { code: "ENOENT" });
	}) as unknown as Parameters<typeof armCodegraphExecForTest>[0]);
	t.after(restoreExec);
	const result = await createCodeGraphTool(undefined, { initLock: lockAcquired }).execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext);
	assert.match(result.content[0].text, /CodeGraph is unavailable/);
	assert.equal((result.details as { status?: string }).status, "unavailable");
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
	withPlatform(t, "linux");
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

	assert.equal((second.details as { syncTriggered?: boolean }).syncTriggered, true, "every search refreshes; only the daemon bypass persists per turn");
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
	withPlatform(t, "linux");
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

	// q3, a new user prompt: clearSearchWindow (what before_agent_start fires) re-asks the daemon once more.
	clearSearchWindow();
	const third = await tool.execute("test", { operation: "query", query: "q3" }, undefined, undefined, ctx);
	assert.deepEqual(third.content, [{ type: "text", text: "cli answer" }]);
	assert.equal((third.details as { viaDaemon?: boolean }).viaDaemon, false);
	assert.equal(daemonCalls, 4, "a fresh turn runs one full chain again");
	assert.equal(runnerCalls, 3);
});

test("a startup wedge verdict survives the first prompt boundary until its own expiry", async (t) => {
	const cwd = workspace(t);
	const restore = armStartupDaemonSkipForTest(cwd);
	t.after(restore);
	let attempts = 0;
	const tool = createCodeGraphTool(async () => ({ stdout: "cli answer", stderr: "" }), {
		daemonExplore: async () => {
			attempts += 1;
			return { status: "ok", text: "daemon answer" };
		},
		rewarm: noRewarm,
		syncRun: syncNothing,
	});

	// What before_agent_start fires between the startup detection and the first search: the
	// startup's verdict is kept, only prompt-scoped failures reset.
	clearSearchWindow();
	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);

	assert.deepEqual(result.content, [{ type: "text", text: "cli answer" }]);
	assert.equal(attempts, 0, "the startup's CLI bypass still spans the first search after the boundary");
});

test("a startup wedge recorded through a symlink spelling still bypasses the daemon", async (t) => {
	const root = workspace(t);
	const holder = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-skip-alias-")));
	t.after(() => rmSync(holder, { recursive: true, force: true }));
	const alias = join(holder, "root");
	symlinkSync(root, alias, "junction");
	t.after(() => rmSync(alias, { force: true }));
	const restore = armStartupDaemonSkipForTest(alias);
	t.after(restore);
	let attempts = 0;
	const tool = createCodeGraphTool(async () => ({ stdout: "cli answer", stderr: "" }), {
		daemonExplore: async () => {
			attempts += 1;
			return { status: "ok", text: "daemon answer" };
		},
		rewarm: noRewarm,
		syncRun: syncNothing,
	});

	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd: alias } as ExtensionContext);

	assert.deepEqual(result.content, [{ type: "text", text: "cli answer" }]);
	assert.equal(attempts, 0, "the verdict is recorded under the same canonical key the query reads");
});

test("an older search's daemon failure never demotes an unexpired startup bypass", async (t) => {
	withPlatform(t, "linux");
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	let attempts = 0;
	// The first attempt is in flight when session start records the wedge: a search that
	// started before startup can only publish its failure afterward. The started signal is
	// what guarantees that ordering — execute() yields at its first await, so arming without
	// it would land before the attempt ever began.
	let releaseAttempt: (() => void) | undefined;
	const inFlight = new Promise<DaemonCallResult>((resolve) => {
		releaseAttempt = () => resolve({ status: "unavailable" });
	});
	let attemptStarted: (() => void) | undefined;
	const firstAttemptInFlight = new Promise<void>((resolve) => {
		attemptStarted = resolve;
	});
	const daemonExplore: DaemonExplore = async () => {
		attempts += 1;
		if (attempts === 1) {
			attemptStarted?.();
			return inFlight;
		}
		return { status: "unavailable" };
	};
	const tool = createCodeGraphTool(async () => ({ stdout: "cli answer", stderr: "" }), {
		daemonExplore,
		rewarm: noRewarm,
		warm: async () => true,
		syncRun: syncNothing,
	});

	const search = tool.execute("test", { operation: "query", query: "old" }, undefined, undefined, ctx);
	await firstAttemptInFlight;
	const restore = armStartupDaemonSkipForTest(cwd);
	t.after(restore);
	releaseAttempt?.();
	const result = await search;
	assert.match(result.content[0].text, /cli answer/);
	assert.equal(attempts, 2, "the older search ran its full attempt-warm-attempt chain");

	// What before_agent_start fires between the startup detection and the next search: an
	// unexpired startup verdict is kept, not demoted to a prompt-scoped failure.
	clearSearchWindow();
	const next = await tool.execute("test", { operation: "query", query: "new" }, undefined, undefined, ctx);
	assert.match(next.content[0].text, /cli answer/);
	assert.equal(attempts, 2, "the next search runs no daemon attempt after the older search published its failure");
});

test("an expired startup bypass makes way for a fresh prompt-scoped one in the same prompt", async (t) => {
	withPlatform(t, "linux");
	const cwd = workspace(t);
	const restore = armStartupDaemonSkipForTest(cwd);
	t.after(restore);
	// The startup verdict's own clock runs out mid-prompt: the frozen now advances past the
	// deadline without the prompt boundary that would otherwise clear the entry.
	let now = Date.now();
	const realNow = Date.now;
	Date.now = () => now;
	t.after(() => {
		Date.now = realNow;
	});
	let attempts = 0;
	const tool = createCodeGraphTool(async () => ({ stdout: "cli answer", stderr: "" }), {
		daemonExplore: async () => {
			attempts += 1;
			return { status: "unavailable" as const };
		},
		rewarm: noRewarm,
		warm: async () => true,
		syncRun: syncNothing,
	});

	now += DAEMON_SKIP_MS + 1;
	const first = await tool.execute("test", { operation: "query", query: "first" }, undefined, undefined, { cwd } as ExtensionContext);
	assert.match(first.content[0].text, /cli answer/);
	assert.equal(attempts, 2, "the expired entry lets the search run the full chain again");

	// The chain's failure must re-arm the bypass for the rest of the prompt: a later search
	// answers through the CLI without paying attempt, warm-up, and attempt again.
	const second = await tool.execute("test", { operation: "query", query: "second" }, undefined, undefined, { cwd } as ExtensionContext);
	assert.match(second.content[0].text, /cli answer/);
	assert.equal((second.details as { viaDaemon?: boolean }).viaDaemon, false);
	assert.equal(attempts, 2, "an expired startup entry no longer blocks the prompt-scoped bypass");
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
	withPlatform(t, "linux");
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

test("win32: a daemon-death search returns through the CLI without waiting for the warm-up", async (t) => {
	withoutChildEnv(t);
	withPlatform(t, "win32");
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	let release: (() => void) | undefined;
	const warmGate = new Promise<boolean>((resolve) => {
		release = () => resolve(true);
	});
	let warmCalls = 0;
	let daemonCalls = 0;
	let runnerCalls = 0;
	const tool = createCodeGraphTool(async () => {
		runnerCalls += 1;
		return { stdout: "cli answer", stderr: "" };
	}, {
		daemonExplore: async () => {
			daemonCalls += 1;
			return { status: "unavailable" };
		},
		rewarm: noRewarm,
		warm: () => {
			warmCalls += 1;
			return warmGate;
		},
		syncRun: syncNothing,
	});
	const ctx = { cwd } as ExtensionContext;

	const result = await Promise.race([
		tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, ctx),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the query blocked on the warm-up")), 3_000)),
	]);
	assert.deepEqual(result.content, [{ type: "text", text: "cli answer" }]);
	assert.equal((result.details as { viaDaemon?: boolean }).viaDaemon, false);
	assert.equal(daemonCalls, 1, "one daemon attempt: no second behind a warm-up the query never waits for");
	assert.equal(warmCalls, 1, "the warm-up is still triggered, in the background");
	assert.equal(runnerCalls, 1, "the CLI answers immediately");

	// The DAEMON_SKIP_MS bypass keeps its meaning: the failed chain still skips the daemon this turn.
	const second = await tool.execute("test", { operation: "query", query: "again" }, undefined, undefined, ctx);
	assert.deepEqual(second.content, [{ type: "text", text: "cli answer" }]);
	assert.equal(daemonCalls, 1, "the turn bypass is unchanged");
	assert.equal(warmCalls, 1, "a bypassed daemon is not re-warmed per query");
	assert.equal(runnerCalls, 2);

	release?.();
	await settled();
});

test("win32: a fast warm failure still skips the second daemon attempt and answers through the CLI", async (t) => {
	withoutChildEnv(t);
	withPlatform(t, "win32");
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	let daemonCalls = 0;
	let warmCalls = 0;
	let runnerCalls = 0;
	const tool = createCodeGraphTool(async () => {
		runnerCalls += 1;
		return { stdout: "cli", stderr: "" };
	}, {
		daemonExplore: async () => {
			daemonCalls += 1;
			return { status: "timeout" };
		},
		rewarm: noRewarm,
		warm: async () => {
			warmCalls += 1;
			return false;
		},
		syncRun: syncNothing,
	});
	const ctx = { cwd } as ExtensionContext;

	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, ctx);

	assert.deepEqual(result.content, [{ type: "text", text: "cli" }]);
	assert.equal((result.details as { viaDaemon?: boolean }).viaDaemon, false);
	assert.equal(daemonCalls, 1, "no second daemon attempt after a fast warm failure");
	assert.equal(warmCalls, 1);
	assert.equal(runnerCalls, 1, "the CLI answers as the last resort");
});

test("POSIX: every search still refreshes, and the daemon chain keeps its attempt, warm, attempt order", async (t) => {
	withoutChildEnv(t);
	withPlatform(t, "linux");
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const calls: string[][] = [];
	const syncRun = async (args: readonly string[]): Promise<boolean> => {
		calls.push([...args]);
		return true;
	};
	const ctx = { cwd } as ExtensionContext;
	const noDaemon = { registryDir: join(cwd, "no-registry") };

	assert.equal(await awaitSearchSync(cwd, ctx, syncRun, noDaemon), true);
	assert.equal(await awaitSearchSync(cwd, ctx, syncRun, noDaemon), true);
	assert.deepEqual(calls, [["sync", "-q"], ["sync", "-q"]], "no freshness window off win32: every search refreshes");

	let daemonCalls = 0;
	let warmCalls = 0;
	let runnerCalls = 0;
	const tool = createCodeGraphTool(async () => {
		runnerCalls += 1;
		return { stdout: "cli", stderr: "" };
	}, {
		daemonExplore: async () => {
			daemonCalls += 1;
			return { status: "unavailable" };
		},
		rewarm: noRewarm,
		warm: async () => {
			warmCalls += 1;
			return false;
		},
		syncRun: syncNothing,
	});

	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, ctx);

	assert.match(result.content[0].text, /cli/);
	assert.equal(daemonCalls, 2, "the warm-up is still awaited between the two attempts");
	assert.equal(warmCalls, 1);
	assert.equal(runnerCalls, 1);
	assert.equal((result.details as { syncTriggered?: boolean }).syncTriggered, true, "the pre-query sync still runs for every search");
});

test("POSIX: a warm slower than the attempt budget keeps running while the query answers via the CLI", async (t) => {
	withoutChildEnv(t);
	withPlatform(t, "linux");
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	let release: (() => void) | undefined;
	const warmGate = new Promise<boolean>((resolve) => {
		release = () => resolve(true);
	});
	const warmTimeouts: number[] = [];
	let daemonCalls = 0;
	const tool = createCodeGraphTool(async () => ({ stdout: "cli answer", stderr: "" }), {
		daemonExplore: async () => {
			daemonCalls += 1;
			return { status: "unavailable" };
		},
		rewarm: noRewarm,
		warm: (_project: string, timeoutMs: number) => {
			warmTimeouts.push(timeoutMs);
			return warmGate;
		},
		syncRun: syncNothing,
		daemonAttemptTimeoutMs: 50,
	});
	const ctx = { cwd } as ExtensionContext;

	const result = await Promise.race([
		tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, ctx),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the query blocked on the warm-up")), 3_000)),
	]);

	assert.match(result.content[0].text, /cli answer/);
	assert.equal(daemonCalls, 2, "the second daemon attempt still runs after the raced warm window closes");
	assert.deepEqual(warmTimeouts, [WARMUP_TIMEOUT_MS], "the warm carries the session-start budget, never the attempt budget");
	assert.ok(WARMUP_TIMEOUT_MS > 50, "the raced wait window is the attempt budget, not the warm's own");

	release?.();
	await settled();
});

test("a query retry that warms a daemon announces the same ready line as the lazy re-warm", async (t) => {
	withoutChildEnv(t);
	// The session_start wiring owns the ready-notice say handle: a non-project session
	// start captures it while readiness plans nothing.
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	codeGraphTools({
		registerTool() { /* the registered tool's shape is covered above */ },
		on(event, handler) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const sessionStart = handlers.get("session_start") as (event: unknown, ctx: unknown) => void;
	const notices: Array<{ text: string; level: string }> = [];
	const nonProject = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-notice-")));
	t.after(() => rmSync(nonProject, { recursive: true, force: true }));
	armExposureEnsureForTest({ read: () => "{}", write: () => { /* isolated by the fake io */ } });
	t.after(() => armExposureEnsureForTest(undefined));
	sessionStart({ reason: "startup" }, {
		cwd: nonProject,
		hasUI: true,
		ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
	} as unknown as ExtensionContext);

	// A live, answering daemon: the query retry's default warm resolves ok through the
	// health probe without spawning anything.
	const cwd = workspace(t);
	const home = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-warmhome-")));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const registryDir = join(home, ".codegraph", "daemons");
	mkdirSync(registryDir, { recursive: true });
	const socketPath = nativeSocketPath(home);
	const server = fakeDaemonServer();
	await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	writeFileSync(join(registryDir, "record.json"), JSON.stringify({ root: cwd, socketPath, startedAt: 1, pid: process.pid }));
	const previousHome = process.env.HOME;
	const previousProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
		resetDaemonRegistryMemo();
	});
	resetDaemonRegistryMemo();

	withPlatform(t, "linux");
	const tool = createCodeGraphTool(async () => ({ stdout: "cli answer", stderr: "" }), {
		daemonExplore: async () => ({ status: "unavailable" as const }),
		rewarm: noRewarm,
		syncRun: syncNothing,
		// warm stays at its default: the adapter under test.
	});

	// The deadline is cleared when the race settles — either side winning leaves no referenced
	// timer behind to keep the test worker alive.
	const search = tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let result: Awaited<typeof search>;
	try {
		result = await Promise.race([
			search,
			new Promise<never>((_, reject) => {
				deadlineTimer = setTimeout(() => reject(new Error("the query never settled")), 20_000);
			}),
		]);
	} finally {
		clearTimeout(deadlineTimer);
	}

	assert.match(result.content[0].text, /cli answer/);
	assert.ok(
		notices.some((notice) => notice.text === "CodeGraph ready in " + cwd && notice.level === "info"),
		"the retry warm's success rides the same ready notice as the lazy re-warm",
	);
	assert.ok(
		!notices.some((notice) => /warm-up failed|not answering/.test(notice.text)),
		"a best-effort query retry never emits failure notices",
	);
});

test("a retry warm-up's ready notice never rides a session that started after it", async (t) => {
	withoutChildEnv(t);
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	codeGraphTools({
		registerTool() { /* the registered tool's shape is covered above */ },
		on(event, handler) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const sessionStart = handlers.get("session_start") as (event: unknown, ctx: unknown) => void;
	armExposureEnsureForTest({ read: () => "{}", write: () => { /* isolated by the fake io */ } });
	t.after(() => armExposureEnsureForTest(undefined));
	const nonProject = (name: string): string => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-notice-" + name + "-")));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		return dir;
	};
	// Session A starts first and will start the warm-up; session B starts while it is pending.
	const noticesA: Array<{ text: string; level: string }> = [];
	const noticesB: Array<{ text: string; level: string }> = [];
	sessionStart({ reason: "startup" }, {
		cwd: nonProject("a"),
		hasUI: true,
		ui: { notify: (text: string, level: string) => noticesA.push({ text, level }) },
	} as unknown as ExtensionContext);

	// A live, answering daemon whose initialize reply is held until the test releases it:
	// session B starts while the warm-up is provably pending, and the release then lets the
	// warm-up succeed.
	const cwd = workspace(t);
	const home = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-warmhome-b-")));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const registryDir = join(home, ".codegraph", "daemons");
	mkdirSync(registryDir, { recursive: true });
	const socketPath = nativeSocketPath(home);
	let initializeSeen: (() => void) | undefined;
	const initializeArrived = new Promise<void>((resolve) => {
		initializeSeen = resolve;
	});
	let callSeen: (() => void) | undefined;
	const callArrived = new Promise<void>((resolve) => {
		callSeen = resolve;
	});
	let releaseInitialize: (() => void) | undefined;
	const initializeHeld = new Promise<void>((resolve) => {
		releaseInitialize = resolve;
	});
	const server = fakeDaemonServer(0, {
		onInitialize: () => initializeSeen?.(),
		releaseInitialize: initializeHeld,
		onCall: () => callSeen?.(),
	});
	// Every accepted connection, so a failing assertion can drop them: the fixture's close hook
	// waits for open sockets, and the held reply's own socket stays open until it is released.
	const sockets: net.Socket[] = [];
	server.on("connection", (socket) => sockets.push(socket));
	await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	writeFileSync(join(registryDir, "record.json"), JSON.stringify({ root: cwd, socketPath, startedAt: 1, pid: process.pid }));
	const previousHome = process.env.HOME;
	const previousProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
		resetDaemonRegistryMemo();
	});
	resetDaemonRegistryMemo();

	withPlatform(t, "linux");
	const tool = createCodeGraphTool(async () => ({ stdout: "cli answer", stderr: "" }), {
		daemonExplore: async () => ({ status: "unavailable" as const }),
		rewarm: noRewarm,
		syncRun: syncNothing,
		// warm stays at its default: the session-bound notice delivery is the code under test.
	});

	const search = tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);
	// One deadline covers both handshake waits and the search itself: a warm-up that never
	// sends its initialize request, or a client that initializes and never calls, would
	// otherwise park this test forever - before the old search-only deadline even existed -
	// with the fixture server still listening. It stays under the runner's own per-test limit
	// so this report wins the race against a runtime timeout, whose rejection lands on
	// whichever test runs next.
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		deadlineTimer = setTimeout(() => reject(new Error("the warm-up handshake and the query never settled")), 4_000);
	});
	const withinDeadline = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
	try {
		// B's start lands while the retry warm-up is provably pending: the first daemon attempt
		// settles at once, the warm then holds on the initialize reply, and B starts only after
		// the daemon saw the warm-up's initialize request — a timer could fire before the warm-up
		// reached the daemon and leave the assertions below vacuous.
		await withinDeadline(initializeArrived);
		sessionStart({ reason: "startup" }, {
			cwd: nonProject("b"),
			hasUI: true,
			ui: { notify: (text: string, level: string) => noticesB.push({ text, level }) },
		} as unknown as ExtensionContext);
		// The held reply goes out only after B replaced A; the warm-up then completes its
		// handshake, and its post-initialize request is the proof it succeeded.
		releaseInitialize?.();
		await withinDeadline(callArrived);
		const result = await withinDeadline(search);
		assert.match(result.content[0].text, /cli answer/);
	} finally {
		// Every exit path — a timed-out handshake, a failed assertion — releases the held reply
		// and drops the fixture's sockets, so a regression is reported instead of hanging the run.
		clearTimeout(deadlineTimer);
		releaseInitialize?.();
		for (const socket of sockets) socket.destroy();
	}

	// The negative assertions are about a warm-up that provably succeeded — the fixture saw
	// its post-initialize request after session B had replaced A — so the discarded ready
	// notice was real, not a warm-up that never reached the daemon behind a quiet fallback.
	assert.ok(!noticesB.some((notice) => /CodeGraph ready/.test(notice.text)), "a newer session never receives another session's ready notice");
	assert.ok(!noticesA.some((notice) => /CodeGraph ready/.test(notice.text)), "a superseded session's completion notice is discarded, not re-routed");
	assert.ok(!noticesB.some((notice) => /warm-up failed|not answering/.test(notice.text)), "no failure notice leaks either");
	await settled();
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

test("explicit init hands the spawned child to the init lease, as readiness does", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	const adopted: Array<[number, boolean]> = [];
	const tool = createCodeGraphTool(async (_args, options) => {
		options.onSpawn?.(4242, true);
		return { stdout: "indexed", stderr: "" };
	}, {
		initLock: async () => ({
			outcome: "acquired" as const,
			release: () => {},
			adopt: (pid: number, proxy: boolean) => {
				adopted.push([pid, proxy]);
			},
		}),
	});

	await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);

	assert.deepEqual(adopted, [[4242, true]], "the runner's spawned child reaches the lease's adopt hook");
});

test("the default runner reports the real spawned child to the init lease", async (t) => {
	withoutChildEnv(t);
	const binDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-adopt-bin-")));
	t.after(() => rmSync(binDir, { recursive: true, force: true }));
	const entryScript = writeCodeGraphPackage(binDir, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
	writePwdGitShim(binDir);
	const cwd = workspace(t);
	withWindowsPath(t, binDir);
	withPlatform(t, "win32");
	const adopted: Array<[number, boolean]> = [];
	// The pinned entry keeps the real process boundary under test on every host: the resolver
	// answers process.execPath + the fixture's npm-shim.js, so no CodeGraph installation is
	// needed and the handcrafted .cmd's rejection cannot skip the spawn.
	const restoreResolver = armCodegraphEntryResolverForTest(() => ({ status: "entry", entry: { node: process.execPath, script: entryScript } }));
	t.after(restoreResolver);

	const tool = createCodeGraphTool(undefined, {
		initLock: async () => ({
			outcome: "acquired" as const,
			release: () => {},
			adopt: (pid: number, proxy: boolean) => {
				adopted.push([pid, proxy]);
			},
		}),
	});

	await tool.execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext);

	assert.equal(adopted.length, 1, "exactly one spawn is reported to the lease");
	assert.ok((adopted[0]?.[0] ?? 0) > 0, "the report carries the real child pid");
	assert.equal(adopted[0]?.[1], true, "a win32 spawn is reported as a proxy pid, like the readiness runner");
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

test("init after an acquired lock runs only for an absent index: unknown stands down unless overridden", async (t) => {
	// The init refusal under test is the lock-ordered stand-down, not the subagent-child refusal:
	// a test runner that is itself flagged as a child (GENTLE_PI_AGENTS_CHILD=1) would refuse one
	// step earlier and never acquire the lock, so this runs as a plain parent session.
	withoutChildEnv(t);
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	const previousOverride = process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
	t.after(() => {
		if (previousOverride === undefined) delete process.env.GENTLE_CODEGRAPH_ALLOW_INDEX;
		else process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = previousOverride;
	});
	// The "unknown" index state — an unreadable .codegraph — reached through the injected
	// reader: no filesystem fixture fails a stat on every runner (a self-referential symlink
	// needs privileges on Windows), and indexExists() alone treats unknown as no index, so
	// an unfenced init would rebuild on a guess.
	const restoreIndexState = armIndexStateForTest((): IndexState => "unknown");
	t.after(restoreIndexState);
	let runnerCalls = 0;
	let releases = 0;
	const tool = createCodeGraphTool(async () => {
		runnerCalls += 1;
		return { stdout: "rebuilt", stderr: "" };
	}, { initLock: async () => ({ outcome: "acquired" as const, release: () => { releases += 1; }, adopt: () => {} }) });

	const refused = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);

	assert.equal(runnerCalls, 0, "an unknown index state never authorizes a rebuild on a guess");
	assert.equal(releases, 1, "the acquired lock is released when init stands down");
	assert.match(refused.content[0].text, /an index already exists/);
	assert.match(refused.content[0].text, /GENTLE_CODEGRAPH_ALLOW_INDEX=1/);
	assert.equal((refused.details as { status?: string }).status, "failed");

	process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = "1";
	const rebuilt = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.equal(runnerCalls, 1, "the explicit override still authorizes the deliberate rebuild of an unknown state");
	assert.equal(releases, 2, "the lock is released however init ends");
});

test("every search awaits its refresh before the query runs", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const events: string[] = [];
	const gates: Array<() => void> = [];
	const tool = createCodeGraphTool(
		async () => ({ stdout: "cli", stderr: "" }),
		{
			daemonExplore: async () => {
				events.push("query");
				return { status: "ok", text: "daemon answer" };
			},
			rewarm: noRewarm,
			syncRun: async (args) => {
				events.push("sync-start");
				await new Promise<void>((resolve) => gates.push(resolve));
				events.push("sync-end");
				return true;
			},
		},
	);
	const ctx = { cwd } as ExtensionContext;

	const first = tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, ctx);
	await settled();
	assert.deepEqual(events, ["sync-start"], "the query waits behind its refresh");

	gates[0]?.();
	const settledFirst = await first;
	assert.equal((settledFirst.details as { syncTriggered?: boolean }).syncTriggered, true);
	assert.deepEqual(events, ["sync-start", "sync-end", "query"], "the query runs only after the refresh settled");

	const second = tool.execute("test", { operation: "explore", query: "symbol" }, undefined, undefined, ctx);
	if (process.platform !== "win32") {
		// The POSIX second refresh must have STARTED before its gate is released: a fixed
		// sleep races the scheduler, and releasing a gate that does not exist yet would leave
		// the refresh holding a gate nothing ever opens — the await below then never settles.
		for (let spin = 0; spin < 200 && gates.length < 2; spin += 1) await settled();
		gates[1]?.();
	}
	await Promise.race([
		second,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the second search never settled")), 3_000)),
	]);
	if (process.platform === "win32") {
		assert.deepEqual(
			events,
			["sync-start", "sync-end", "query", "query"],
			"win32 serves the second search from the first's settled sync inside the freshness window (S11)",
		);
	} else {
		assert.deepEqual(
			events,
			["sync-start", "sync-end", "query", "sync-start", "sync-end", "query"],
			"every search refreshes again, with no per-prompt gate",
		);
	}
});

test("a subagent child never triggers the background sync", async (t) => {
	const cwd = workspace(t);
	// An index is what makes the sync reachable at all: without one the unindexed-workspace
	// guard would return false before the child-session guard ever mattered.
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

test("warmNotice: every warm outcome carries its one notice - the ready line on any ok, wedged and failure warnings otherwise", () => {
	assert.deepEqual(warmNotice({ ok: true }, "/repo"), { text: "CodeGraph ready in /repo", level: "info" });
	assert.deepEqual(warmNotice({ ok: true, adopted: true }, "/repo"), { text: "CodeGraph ready in /repo", level: "info" });
	assert.deepEqual(warmNotice({ ok: false, wedged: true }, "/repo"), {
		text: "CodeGraph daemon in /repo is not answering; queries use the CLI fallback for now",
		level: "warning",
	});
	assert.deepEqual(warmNotice({ ok: false }, "/repo"), { text: "CodeGraph warm-up failed in /repo", level: "warning" });
});

test("indexStartNotice: init announces initialization in the approved wording; sync keeps its line", () => {
	assert.deepEqual(indexStartNotice("init"), { text: "initializing the current repo for CodeGraph...", level: "info" });
	assert.deepEqual(indexStartNotice("sync"), { text: "syncing the CodeGraph index...", level: "info" });
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

test("awaitSearchSync: a failing sync beside a live daemon notifies info, a daemon-less one keeps the warning", async (t) => {
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

	await awaitSearchSync(cwd, ctx, alwaysFails, { registryDir: registry, sleep: instant });
	assert.equal(notices.length, 1, "one notify for one failed refresh");
	assert.equal(notices[0].level, "info", "a live daemon self-heals the index: no warning");
	assert.match(notices[0].text, /\(daemon alive/);

	const deadCwd = workspace(t);
	await writeIndex(["init", deadCwd], { cwd: deadCwd, maxBuffer: 1 });
	const deadCtx = { cwd: deadCwd, hasUI: true, ui: { notify: (text: string, level: "info" | "warning") => notices.push({ text, level }) } } as unknown as ExtensionContext;
	const deadRun = async (): Promise<boolean> => false;
	await awaitSearchSync(deadCwd, deadCtx, deadRun, { registryDir: join(deadCwd, "no-registry"), sleep: instant });
	assert.equal(notices.length, 2);
	assert.equal(notices[1].level, "warning", "without a daemon the failure stays a warning");
	assert.equal(notices[1].text, `codegraph sync failed in ${deadCwd}`);
});

test("one budget covers the whole live-daemon refresh: the retry and the backoff draw on what the first attempt left", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const registry = join(cwd, "registry");
	mkdirSync(registry);
	const socket = join(registry, "live.sock");
	writeFileSync(socket, "");
	writeFileSync(join(registry, "record.json"), JSON.stringify({ root: cwd, socketPath: socket, startedAt: 1, pid: process.pid }));
	const budgets: number[] = [];
	const sleeps: number[] = [];
	// The module's clock is driven only by the injected seams, so the budget arithmetic is
	// observable without one real 120-second wait: the sleep advances the clock exactly the
	// way the real backoff would.
	let now = Date.now();
	const realNow = Date.now;
	Date.now = () => now;
	t.after(() => {
		Date.now = realNow;
	});
	const ctx = { cwd } as ExtensionContext;

	const refreshed = await awaitSearchSync(cwd, ctx, async (_args, _cwd, timeoutMs) => {
		budgets.push(timeoutMs);
		return false;
	}, {
		registryDir: registry,
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
	});

	assert.equal(refreshed, true, "a refresh covered the search even though the sync failed");
	assert.deepEqual(sleeps, [SYNC_RETRY_DELAY_MS], "one full backoff separates the two attempts");
	assert.equal(budgets.length, 2, "the failing sync beside a live daemon is retried once");
	assert.equal(budgets[0], SYNC_TIMEOUT_MS, "the first attempt gets the whole sync budget");
	assert.equal(budgets[1], SYNC_TIMEOUT_MS - SYNC_RETRY_DELAY_MS, "a fast-failing first attempt leaves the budget minus the backoff for the retry");
	assert.ok(budgets[1] + sleeps[0] <= SYNC_TIMEOUT_MS, "attempt plus backoff plus retry stay inside one sync budget");
});

test("a refresh whose first attempt spent the whole budget ends there: no backoff, no second attempt", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	await writeIndex(["init", cwd], { cwd, maxBuffer: 1 });
	const registry = join(cwd, "registry");
	mkdirSync(registry);
	const socket = join(registry, "live.sock");
	writeFileSync(socket, "");
	writeFileSync(join(registry, "record.json"), JSON.stringify({ root: cwd, socketPath: socket, startedAt: 1, pid: process.pid }));
	const budgets: number[] = [];
	const sleeps: number[] = [];
	// The first attempt runs to its timeout, spending exactly the budget it was granted.
	let now = Date.now();
	const realNow = Date.now;
	Date.now = () => now;
	t.after(() => {
		Date.now = realNow;
	});
	const ctx = { cwd } as ExtensionContext;

	const refreshed = await awaitSearchSync(cwd, ctx, async (_args, _cwd, timeoutMs) => {
		budgets.push(timeoutMs);
		now += timeoutMs;
		return false;
	}, {
		registryDir: registry,
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
	});

	assert.equal(refreshed, true, "the budget-exhausted refresh still settled before the search");
	assert.deepEqual(budgets, [SYNC_TIMEOUT_MS], "the whole-budget refresh makes exactly one attempt");
	assert.deepEqual(sleeps, [], "no backoff fits what the first attempt already spent");
});

/** Drives the REAL session_start wiring end to end: a fake codegraph CLI first on PATH, the
 * mcp.json exposure armed on a fake io, and a captured ctx.ui.notify — everything else, from
 * workspace validation through prepareReadiness to the index run and the daemon warm, is the
 * real path (its cross-session lease tokens are acquired and released per project digest, the
 * same transient state a real session start writes). POSIX-only: the fake CLI is a shell script. */
function armSessionStartWiring(t: test.TestContext): {
	fire: (cwd: string) => {
		notices: Array<{ text: string; level: string }>;
		syncCapture: Array<{ text: string; level: string }>;
		calls: () => string[];
	};
} {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	codeGraphTools({
		registerTool() { /* the registered tool's shape is covered above */ },
		on(event, handler) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI);
	const sessionStart = handlers.get("session_start") as (event: unknown, ctx: unknown) => void;

	const bin = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-ss-bin-")));
	const callsLog = join(bin, "calls.log");
	// The index commands take a visible moment — the real init runs for seconds — so the
	// deferred start notice lands while the run is still in flight, exactly as it does live.
	writeFileSync(join(bin, "codegraph"), [
		"#!/bin/sh",
		'printf "%s\\n" "$1" >> "$GENTLE_SS_CALLS"',
		'case "$1" in',
		"  init|sync)",
		"    sleep 0.7",
		"    ;;",
		"esac",
		'case "$1" in',
		'  init)',
		'    if [ -n "$GENTLE_SS_INIT_FAIL" ]; then sleep 0.3; exit 1; fi',
		'    mkdir -p "$3/.codegraph"',
		'    printf "index" > "$3/.codegraph/codegraph.db"',
		"    ;;",
		"esac",
		"exit 0",
	].join("\n"));
	chmodSync(join(bin, "codegraph"), 0o755);

	const previousPath = process.env.PATH;
	const previousCalls = process.env.GENTLE_SS_CALLS;
	const previousChild = process.env.GENTLE_PI_AGENTS_CHILD;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.GENTLE_SS_CALLS = callsLog;
	delete process.env.GENTLE_PI_AGENTS_CHILD;
	armExposureEnsureForTest({ read: () => "{}", write: () => { /* isolated by the fake io */ } });
	t.after(() => {
		process.env.PATH = previousPath;
		if (previousCalls === undefined) delete process.env.GENTLE_SS_CALLS;
		else process.env.GENTLE_SS_CALLS = previousCalls;
		if (previousChild === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
		else process.env.GENTLE_PI_AGENTS_CHILD = previousChild;
		armExposureEnsureForTest(undefined);
		rmSync(bin, { recursive: true, force: true });
	});

	return {
		fire: (cwd: string) => {
			const notices: Array<{ text: string; level: string }> = [];
			const ctx = {
				cwd,
				hasUI: true,
				ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
			} as unknown as ExtensionContext;
			sessionStart({ reason: "startup" }, ctx);
			// The start say is deferred past the session_start notify window, so handler-return
			// time is the dispatch baseline: the captured notices prove nothing was said yet.
			const syncCapture = notices.map((notice) => ({ ...notice }));
			return {
				notices,
				syncCapture,
				calls: () => (existsSync(callsLog) ? readFileSync(callsLog, "utf8").trim().split("\n") : []),
			};
		},
	};
}

/** Awaits the wiring's warm tail: the fake serve exits at once, so the adoption poll fails
 * after its bounded 5s window and the warm-up-failed warning is the flow's last notice. */
async function awaitWarmTail(notices: Array<{ text: string; level: string }>): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && !notices.some((notice) => /warm-up failed/.test(notice.text))) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Waits until a notice matching `pattern` lands in `notices`, bounded by `deadlineMs`. */
async function untilNotice(notices: Array<{ text: string; level: string }>, pattern: RegExp, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline && !notices.some((notice) => pattern.test(notice.text))) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.ok(notices.some((notice) => pattern.test(notice.text)), `expected a notice matching ${pattern}`);
}

test("session_start defers the init start notice past the notify window and says it exactly once", { timeout: 20_000 }, async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	withoutChildEnv(t);
	const cwd = workspace(t);
	writeFileSync(join(cwd, "package.json"), "{}\n");
	const harness = armSessionStartWiring(t);

	const { notices, syncCapture, calls } = harness.fire(cwd);
	assert.deepEqual(
		syncCapture,
		[],
		"nothing is said at dispatch time: the start say is deferred past the session_start notify window so the TUI paints it",
	);

	await untilNotice(notices, /initializing the current repo for CodeGraph/, 5_000);
	assert.ok(calls().includes("init"), "the real readiness path ran codegraph init while the deferred say was pending");
	assert.equal(
		notices.filter((notice) => notice.text === "initializing the current repo for CodeGraph...").length,
		1,
		"the deferred start say emits exactly once with the approved wording",
	);

	await awaitWarmTail(notices);
	assert.ok(existsSync(join(cwd, ".codegraph", "codegraph.db")), "the fake init created the database");
	assert.deepEqual(notices, [
		{ text: "initializing the current repo for CodeGraph...", level: "info" },
		{ text: "CodeGraph index created", level: "info" },
		{ text: "warming up CodeGraph...", level: "info" },
		{ text: `CodeGraph warm-up failed in ${cwd}`, level: "warning" },
	], "the deferred start line still precedes the created/warm notices in the chain");
});

test("session_start announces sync through the real path with the existing wording", { timeout: 20_000 }, async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	withoutChildEnv(t);
	const cwd = workspace(t);
	writeFileSync(join(cwd, "package.json"), "{}\n");
	mkdirSync(join(cwd, ".codegraph"));
	writeFileSync(join(cwd, ".codegraph", "codegraph.db"), "index");
	const harness = armSessionStartWiring(t);

	const { notices, syncCapture, calls } = harness.fire(cwd);
	assert.deepEqual(
		syncCapture,
		[],
		"the sync start say rides the same deferred emission: nothing is said at dispatch time",
	);

	await untilNotice(notices, /syncing the CodeGraph index/, 5_000);
	assert.equal(
		notices.filter((notice) => notice.text === "syncing the CodeGraph index...").length,
		1,
		"the deferred sync say emits exactly once with the existing wording",
	);

	await awaitWarmTail(notices);
	assert.ok(calls().includes("sync"), "the real readiness path ran the sync");
	assert.deepEqual(notices, [
		{ text: "syncing the CodeGraph index...", level: "info" },
		{ text: "CodeGraph index synced", level: "info" },
		{ text: "warming up CodeGraph...", level: "info" },
		{ text: `CodeGraph warm-up failed in ${cwd}`, level: "warning" },
	], "the sync branch's notice chain is unchanged by the deferred emission");
});

test("session_start tells the user to run init manually after the silent retries are exhausted", { timeout: 20_000 }, async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	withoutChildEnv(t);
	const cwd = workspace(t);
	writeFileSync(join(cwd, "package.json"), "{}\n");
	const harness = armSessionStartWiring(t);
	process.env.GENTLE_SS_INIT_FAIL = "1";
	t.after(() => {
		delete process.env.GENTLE_SS_INIT_FAIL;
	});

	const { notices, calls } = harness.fire(cwd);
	await untilNotice(notices, /run "codegraph init" manually/, 10_000);
	assert.deepEqual(notices, [
		{ text: "initializing the current repo for CodeGraph...", level: "info" },
		{ text: `codegraph init failed in ${cwd} after 3 retries; run "codegraph init" manually`, level: "warning" },
	], "the exhaustion notice names the manual action and the retry count after the start line");
	assert.equal(
		calls().filter((call) => call === "init").length,
		4,
		"one initial run plus three silent retries through the real session-start path",
	);
	assert.ok(!existsSync(join(cwd, ".codegraph", "codegraph.db")), "the failing init created no database");
});

test("session_start reports a main-busy seed stand-down as deferred initialization", { timeout: 20_000 }, async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	withoutChildEnv(t);
	// A linked worktree whose main checkout holds a live init lease: the seed stands down
	// with main-busy (ok, nothing copied), and the notice must report deferral, not creation.
	const home = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-busyhome-")));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const previousHome = process.env.HOME;
	const previousProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousProfile;
	});
	const base = join(home, "repos");
	mkdirSync(base);
	const main = join(base, "main");
	mkdirSync(main);
	execFileSync("git", ["init", "-b", "main"], { cwd: main, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], { cwd: main, stdio: "ignore" });
	const linked = join(base, "linked");
	execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: main, stdio: "ignore" });
	writeFileSync(join(linked, "package.json"), "{}\n");
	// The main checkout's init lease, held live by this process: the fixture token carries
	// the real host and machine identities so the verdict reads held-live on any host.
	const now = Date.now();
	const host = leaseHostIdentity();
	const machine = leaseMachineIdentity();
	mkdirSync(join(home, ".codegraph", "locks"), { recursive: true });
	writeFileSync(lockPathFor(main, "init"), JSON.stringify({
		kind: "init",
		pid: process.pid,
		startedAt: now,
		expiresAt: now + 600_000,
		nonce: "main-busy-fixture",
		...(host === null ? {} : { host }),
		...(machine === null ? {} : { machine }),
	}));

	const harness = armSessionStartWiring(t);
	const { notices, calls } = harness.fire(linked);
	await untilNotice(notices, /CodeGraph index creation deferred/, 10_000);
	assert.ok(!notices.some((notice) => notice.text === "CodeGraph index created"), "the stand-down never claims a created index");
	assert.ok(!notices.some((notice) => /warming up CodeGraph/.test(notice.text)), "a stand-down warms nothing");
	assert.ok(!calls().includes("init"), "no init runs: the main checkout owns index creation right now");
	assert.equal(existsSync(join(linked, ".codegraph", "codegraph.db")), false, "the worktree still has no database");
	await settled();
});
