import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codeGraphTools, {
	clearSearchSync,
	createCodeGraphTool,
	codeGraphNodeScript,
	findCodeGraphNodeScriptOnPath,
	isSameDirectory,
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

/** A syncRun that starts nothing real; tests count its calls when they care. */
const syncNothing = async (): Promise<boolean> => true;

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
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	// Behaves like execFile: settles only when its signal aborts, then rejects with AbortError.
	const hanging: CodeGraphRunner = (_args, options) => new Promise((_resolve, reject) => {
		options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true });
	});

	// A user cancellation is a failure, not a timeout.
	const user = new AbortController();
	setTimeout(() => user.abort(), 5);
	const cancelled = await createCodeGraphTool(hanging, { queryTimeoutMs: 60_000 }).execute("test", { operation: "init" }, user.signal, undefined, ctx);
	assert.doesNotMatch(cancelled.content[0].text, /timed out/);
	assert.match(cancelled.content[0].text, /CodeGraph failed to run/);

	// init is the legitimately slow first index: only the user's own signal bounds it.
	let initSignal: AbortSignal | undefined = new AbortController().signal;
	const slowInit = createCodeGraphTool(async (_args, options) => {
		initSignal = options.signal;
		await new Promise((resolve) => setTimeout(resolve, 60));
		return { stdout: "indexed", stderr: "" };
	}, { queryTimeoutMs: 20 });
	const init = await slowInit.execute("test", { operation: "init" }, undefined, undefined, ctx);
	assert.deepEqual(init.content, [{ type: "text", text: "indexed" }]);
	assert.equal(initSignal, undefined);
});

test("CodeGraph tool runs only fixed cwd-scoped init, query, and explore commands", async (t) => {
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
			syncRun: syncNothing,
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
	const runnerCalls: Array<{ args: readonly string[]; cwd: string }> = [];
	const tool = createCodeGraphTool(
		async (args, options) => {
			runnerCalls.push({ args, cwd: options.cwd });
			return { stdout: "cli answer", stderr: "" };
		},
		{
			daemonExplore: async () => ({ status: "unavailable" }),
			warm: async () => true,
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

test("CodeGraph init reports the missing binary distinctly", async (t) => {
	const cwd = workspace(t);
	const unavailable = Object.assign(new Error("spawn codegraph ENOENT"), { code: "ENOENT" });
	const tool = createCodeGraphTool(async () => {
		throw unavailable;
	});
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
	const cwd = workspace(t);
	let maxBuffer = 0;
	const tool = createCodeGraphTool(async (_args, options) => {
		maxBuffer = options.maxBuffer;
		return { stdout: "x".repeat(100_001), stderr: "" };
	});
	const ctx = { cwd } as ExtensionContext;

	const result = await tool.execute("test", { operation: "init" }, undefined, undefined, ctx);

	assert.ok(maxBuffer > 100_000);
	assert.match(result.content[0]?.text ?? "", /\[CodeGraph output truncated\]$/);
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

test("the extension hooks turn_start and session_start; turn_start resets the per-turn sync", async (t) => {
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

	assert.ok(handlers.has("turn_start"), "turn_start clears the per-turn sync set");
	assert.ok(handlers.has("session_start"), "session_start still prepares readiness");

	const cwd = workspace(t);
	const calls: string[][] = [];
	const syncRun = async (args: readonly string[]): Promise<boolean> => {
		calls.push([...args]);
		return true;
	};
	const ctx = { cwd } as ExtensionContext;
	assert.equal(triggerSearchSync(cwd, ctx, syncRun), true);
	assert.equal(triggerSearchSync(cwd, ctx, syncRun), false, "one background sync per turn");
	await settled();
	(handlers.get("turn_start") as () => void)();
	assert.equal(triggerSearchSync(cwd, ctx, syncRun), true, "the turn_start handler cleared the set");
	await settled();
	assert.deepEqual(calls, [["unlock"], ["sync", "-q"], ["unlock"], ["sync", "-q"]]);
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
	] as const) {
		const blocked = verdict(command, toolName) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blocked?.block, true, `${toolName}: ${command} is blocked`);
		assert.match(blocked?.reason ?? "", /an index already exists/);
		assert.match(blocked?.reason ?? "", /GENTLE_CODEGRAPH_ALLOW_INDEX=1/);
	}

	for (const command of ["codegraph sync", "codegraph unlock", "codegraph status", "codegraph indexer .", "rg foo"]) {
		assert.equal(verdict(command), undefined, `${command} is allowed`);
	}
	assert.equal(verdict("codegraph index .", "read"), undefined, "only bash tools are guarded");

	const bare = workspace(t);
	assert.equal(
		(guard as (event: unknown, ctx: unknown) => unknown)({ toolName: "bash", input: { command: "codegraph index" } }, { cwd: bare } as ExtensionContext),
		undefined,
		"no index database: the first index is the legitimate init path",
	);

	process.env.GENTLE_CODEGRAPH_ALLOW_INDEX = "1";
	assert.equal(verdict("codegraph index ."), undefined, "the explicit override allows a deliberate rebuild");
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

	const result = await createCodeGraphTool().execute(
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
	const cwd = workspace(t);
	writeFileSync(join(cwd, "tracked.txt"), "tracked\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd });
	const tool = createCodeGraphTool(writeIndex);
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
	const appended = workspace(t);
	writeFileSync(excludeFile(appended), "# local\n*.log");
	await createCodeGraphTool(writeIndex).execute("test", { operation: "init" }, undefined, undefined, { cwd: appended } as ExtensionContext);
	assert.equal(readFileSync(excludeFile(appended), "utf8"), "# local\n*.log\n.codegraph/\n");

	const equivalent = workspace(t);
	writeFileSync(excludeFile(equivalent), "/.codegraph\n");
	const result = await createCodeGraphTool(writeIndex).execute("test", { operation: "init" }, undefined, undefined, { cwd: equivalent } as ExtensionContext);
	assert.equal(readFileSync(excludeFile(equivalent), "utf8"), "/.codegraph\n");
	assert.equal((result.details as { localExclude?: { status: string } }).localExclude?.status, "present");
	assert.equal(gitOutput(equivalent, "status", "--porcelain", "--untracked-files=all"), "");
});

test("CodeGraph exclusion uses the exclude file git resolves for a linked worktree", async (t) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-worktree-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const primary = join(base, "primary");
	const linked = join(base, "linked");
	mkdirSync(primary);
	execFileSync("git", ["init", "-b", "main"], { cwd: primary, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], { cwd: primary, stdio: "ignore" });
	execFileSync("git", ["worktree", "add", "-b", "feature", linked], { cwd: primary, stdio: "ignore" });

	const result = await createCodeGraphTool(writeIndex).execute("test", { operation: "init" }, undefined, undefined, { cwd: linked } as ExtensionContext);

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
	await createCodeGraphTool(async () => ({ stdout: "found", stderr: "" }), { daemonExplore: daemonFound, syncRun: syncNothing }).execute(
		"test",
		{ operation: "query", query: "symbol" },
		undefined,
		undefined,
		{ cwd: indexed } as ExtensionContext,
	);
	assert.deepEqual(excludeLines(indexed), [".codegraph/"]);
	assert.equal(gitOutput(indexed, "status", "--porcelain", "--untracked-files=all"), "");

	const bare = workspace(t);
	const result = await createCodeGraphTool(async () => ({ stdout: "found", stderr: "" }), { daemonExplore: daemonFound, syncRun: syncNothing }).execute(
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
		{ daemonExplore: async () => ({ status: "ok", text: "found" }), syncRun: syncNothing },
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

test("CodeGraph query prefers the daemon socket and never spawns the CLI", async (t) => {
	const cwd = workspace(t);
	let runnerCalls = 0;
	const tool = createCodeGraphTool(
		async () => {
			runnerCalls += 1;
			return { stdout: "cli", stderr: "" };
		},
		{ daemonExplore: daemonOk, syncRun: syncNothing },
	);
	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);
	assert.deepEqual(result.content, [{ type: "text", text: "daemon answer" }]);
	assert.equal(runnerCalls, 0, "the daemon answered, so no CLI process was spawned");
	assert.equal((result.details as { viaDaemon?: boolean }).viaDaemon, true);
});

test("a daemon that never answers tries twice, warms once, then answers through the CLI", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
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
	assert.equal(daemonCalls, 4);
	assert.equal(warmCalls, 2);
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

	// q3, a new turn: clearSearchSync (what turn_start fires) re-asks the daemon once more.
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
		{ daemonExplore: daemonDown, warm: warmOk, syncRun: syncNothing },
	).execute("test", { operation: "query", query: "symbol" }, undefined, undefined, { cwd } as ExtensionContext);
	assert.deepEqual(failed.content, [{ type: "text", text: "CodeGraph failed to run. Use read, grep, and find for this exploration." }]);
	assert.equal((failed.details as { status?: string }).status, "failed");

	const missingBinary = Object.assign(new Error("spawn codegraph ENOENT"), { code: "ENOENT" });
	const unavailable = await createCodeGraphTool(
		async () => {
			throw missingBinary;
		},
		{ daemonExplore: daemonDown, warm: warmOk, syncRun: syncNothing },
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
		},
	);

	const result = await tool.execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext);

	assert.deepEqual(result.content, [{ type: "text", text: "indexed" }]);
	assert.deepEqual(calls, [{ args: ["init", cwd], cwd }]);
	assert.equal(daemonCalls, 0, "init never consults the daemon");
	await settled();
	assert.equal(syncCalls, 0, "init never triggers the background sync");
});

test("the first search of a turn triggers one background unlock+sync, later searches none", async (t) => {
	withoutChildEnv(t);
	const cwd = workspace(t);
	const calls: string[][] = [];
	const tool = createCodeGraphTool(
		async () => ({ stdout: "cli", stderr: "" }),
		{
			daemonExplore: daemonOk,
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
	assert.deepEqual(calls, [["unlock"], ["sync", "-q"]]);

	await tool.execute("test", { operation: "explore", query: "symbol" }, undefined, undefined, ctx);
	await settled();
	assert.deepEqual(calls, [["unlock"], ["sync", "-q"]], "one background sync per turn");

	clearSearchSync();
	await tool.execute("test", { operation: "query", query: "again" }, undefined, undefined, ctx);
	await settled();
	assert.deepEqual(calls, [["unlock"], ["sync", "-q"], ["unlock"], ["sync", "-q"]], "a new turn syncs again");
});

test("a subagent child never triggers the background sync", async (t) => {
	const cwd = workspace(t);
	const calls: string[][] = [];
	const tool = createCodeGraphTool(
		async () => ({ stdout: "cli", stderr: "" }),
		{
			daemonExplore: daemonOk,
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

test("CodeGraph init still succeeds and reports when git is unavailable for the local exclusion", async (t) => {
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
	}).execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext);
	process.env.PATH = originalPath;

	assert.match(result.content[0].text, /^indexed\n\n/);
	assert.match(result.content[0].text, /\.codegraph\/ is not excluded from git locally/);
	assert.match(result.content[0].text, /keep \.codegraph\/ out of the change/i);
	assert.equal((result.details as { localExclude?: { status: string } }).localExclude?.status, "failed");
	assert.deepEqual(excludeLines(cwd), []);
});

test("CodeGraph excludes a partial index left behind by a failed init without changing the fallback text", async (t) => {
	const cwd = workspace(t);
	const result = await createCodeGraphTool(async (args, options) => {
		await writeIndex(args, options);
		throw new Error("CodeGraph exited with status 1");
	}).execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext);

	assert.deepEqual(result.content, [{ type: "text", text: "CodeGraph failed to run. Use read, grep, and find for this exploration." }]);
	assert.equal((result.details as { status: string }).status, "failed");
	assert.equal((result.details as { localExclude?: { status: string } }).localExclude?.status, "added");
	assert.equal(gitOutput(cwd, "status", "--porcelain", "--untracked-files=all"), "");
});
