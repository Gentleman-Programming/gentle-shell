import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codeGraphTools, {
	createCodeGraphTool,
	codeGraphNodeScript,
	findCodeGraphNodeScriptOnPath,
	type CodeGraphRunner,
} from "../extensions/codegraph-tools.ts";

function workspace(t: test.TestContext): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-")));
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
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

test("CodeGraph query timeout is reported distinctly from user abort and never bounds init (#1901)", async (t) => {
	const cwd = workspace(t);
	const ctx = { cwd } as ExtensionContext;
	// Behaves like execFile: settles only when its signal aborts, then rejects with AbortError.
	const hanging: CodeGraphRunner = (_args, options) => new Promise((_resolve, reject) => {
		options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true });
	});

	const bounded = createCodeGraphTool(hanging, { queryTimeoutMs: 20 });
	for (const parameters of [{ operation: "query", query: "x" }, { operation: "explore", query: "x" }] as const) {
		const result = await bounded.execute("test", parameters, undefined, undefined, ctx);
		assert.match(result.content[0].text, /CodeGraph timed out after 20 ms/);
		assert.match(result.content[0].text, /Use read, grep, and find/);
		assert.equal((result.details as { status: string }).status, "failed");
	}

	// A user cancellation is not a timeout.
	const user = new AbortController();
	setTimeout(() => user.abort(), 5);
	const cancelled = await createCodeGraphTool(hanging, { queryTimeoutMs: 60_000 }).execute("test", { operation: "query", query: "x" }, user.signal, undefined, ctx);
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
	const calls: Array<{ args: readonly string[]; cwd: string }> = [];
	const runner: CodeGraphRunner = async (args, options) => {
		calls.push({ args, cwd: options.cwd });
		return { stdout: "indexed", stderr: "" };
	};
	const tool = createCodeGraphTool(runner);
	const ctx = { cwd } as ExtensionContext;

	for (const parameters of [
		{ operation: "init" },
		{ operation: "query", query: "buildGentlePrompt", limit: 4 },
		{ operation: "explore", query: "review gate", limit: 3 },
	] as const) {
		const result = await tool.execute("test", parameters, undefined, undefined, ctx);
		assert.deepEqual(result.content, [{ type: "text", text: "indexed" }]);
	}

	assert.deepEqual(calls, [
		{ args: ["init", cwd], cwd },
		{
			args: ["query", "--path", cwd, "--limit", "4", "--", "buildGentlePrompt"],
			cwd,
		},
		{
			args: ["explore", "--path", cwd, "--max-files", "3", "--", "review gate"],
			cwd,
		},
	]);
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

test("CodeGraph tool passes hyphen-leading queries after the option terminator", async (t) => {
	const cwd = workspace(t);
	const calls: Array<readonly string[]> = [];
	const tool = createCodeGraphTool(async (args) => {
		calls.push(args);
		return { stdout: "safe", stderr: "" };
	});
	const ctx = { cwd } as ExtensionContext;

	await tool.execute("test", { operation: "query", query: "--help" }, undefined, undefined, ctx);

	assert.deepEqual(calls, [
		["query", "--path", cwd, "--limit", "10", "--", "--help"],
	]);
});

test("CodeGraph tool returns structured fallback instructions when the binary is unavailable", async (t) => {
	const cwd = workspace(t);
	const unavailable = Object.assign(new Error("spawn codegraph ENOENT"), { code: "ENOENT" });
	const tool = createCodeGraphTool(async () => {
		throw unavailable;
	});
	const ctx = { cwd } as ExtensionContext;

	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, ctx);

	assert.deepEqual(result.content, [{
		type: "text",
		text: "CodeGraph is unavailable because the codegraph binary was not found. Use read, grep, and find for this exploration.",
	}]);
	assert.deepEqual(result.details, {
		status: "unavailable",
		operation: "query",
		cwd,
		fallback: "Use read, grep, and find for this exploration.",
	});
});

test("CodeGraph tool returns fallback instructions when CodeGraph fails", async (t) => {
	const cwd = workspace(t);
	const tool = createCodeGraphTool(async () => {
		throw new Error("CodeGraph exited with status 1");
	});
	const ctx = { cwd } as ExtensionContext;

	const result = await tool.execute("test", { operation: "explore", query: "call path" }, undefined, undefined, ctx);

	assert.deepEqual(result.content, [{
		type: "text",
		text: "CodeGraph failed to run. Use read, grep, and find for this exploration.",
	}]);
	assert.deepEqual(result.details, {
		status: "failed",
		operation: "explore",
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

	const result = await tool.execute("test", { operation: "explore", query: "large result" }, undefined, undefined, ctx);

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

	const query = "literal & echo injected > shell-injection.txt";
	const result = await createCodeGraphTool().execute(
		"test",
		{ operation: "query", query },
		undefined,
		undefined,
		{ cwd } as ExtensionContext,
	);

	assert.deepEqual(result.content, [{
		type: "text",
		text: JSON.stringify(["query", "--path", cwd, "--limit", "10", "--", query]),
	}]);
	assert.equal(existsSync(join(cwd, "shell-injection.txt")), false);
});
