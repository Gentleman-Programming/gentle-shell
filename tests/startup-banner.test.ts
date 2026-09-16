import assert from "node:assert/strict";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs/promises";
import startup, { countEnabledMcpServers, mcpConfigPaths, readGitBranch } from "../extensions/startup-banner.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../lib/terminal-theme.ts";

test("startup branch lookup uses direct git argv and hides its Windows child", async () => {
	const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
	const run = ((command: string, args: readonly string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string) => void) => {
		calls.push({ command, args, options });
		callback(null, "main\n");
	}) as typeof import("node:child_process").execFile;
	assert.equal(await readGitBranch("/repo with spaces & metacharacters", run), "On branch main");
	assert.deepEqual(calls, [{
		command: "git",
		args: ["-C", "/repo with spaces & metacharacters", "branch", "--show-current"],
		options: { encoding: "utf8", shell: false, windowsHide: true },
    }]);
});

test("startup banner keeps animating after invalidate and cleans up on dispose", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.mock.method(fs, "readFile", async () => JSON.stringify({ showRose: true, showTextLogo: true, color: "pink" }));
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const argv = process.argv;
	process.argv = ["node"];
	t.after(() => { process.argv = argv; });
	for (const [key, value] of [["rows", 40], ["columns", 160]] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
		t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
	}
	let start: Function;
	let shutdown: Function;
	let header: { render(width: number): string[]; invalidate(): void; dispose(): void };
	let renders = 0;
	startup({ on: (name: string, fn: Function) => {
		if (name === "session_start") start = fn;
		if (name === "session_shutdown") shutdown = fn;
	}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
	await start!({}, { hasUI: true, cwd: "/fixture", ui: { setHeader: (factory: Function) => {
		header = factory({ requestRender() { renders++; } }, { fg: (_role: string, text: string) => text });
	} } });
	t.mock.timers.tick(50);
	const afterBoot = renders;
	t.mock.timers.tick(25);
	assert.ok(renders > afterBoot, "animation timer requests renders");
	header!.invalidate();
	const afterInvalidate = renders;
	t.mock.timers.tick(25);
	assert.ok(renders > afterInvalidate, "invalidate() must not stop the animation timer");
	header!.dispose();
	const afterDispose = renders;
	t.mock.timers.tick(25);
	assert.equal(renders, afterDispose, "dispose() stops the animation timer");
	shutdown!();
	t.mock.timers.tick(25);
	assert.equal(renders, afterDispose, "session_shutdown cleanup stays idle");
});

// Drive the real header factory; background git/home reads never run.
for (const showRose of [false, true]) for (const showTextLogo of [false, true]) {
	test(`startup art respects rose=${showRose}, logo=${showTextLogo} and cyan palette`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(fs, "readFile", async () => JSON.stringify({ showRose, showTextLogo, color: "cyan" }));
		syncBuiltinESMExports();
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		const argv = process.argv;
		process.argv = ["node"];
		t.after(() => { process.argv = argv; });
		for (const [key, value] of [["rows", 40], ["columns", 160]] as const) {
			const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
			Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
			t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
		}
		let start: Function;
		let shutdown: Function;
		let header: { render(width: number): string[]; dispose(): void };
		const writes: string[] = [];
		startup({ on: (name: string, fn: Function) => {
			if (name === "session_start") start = fn;
			if (name === "session_shutdown") shutdown = fn;
		}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
		const write = t.mock.method(process.stdout, "write", (text: string) => { writes.push(String(text)); return true; });
		await start!({}, { hasUI: true, cwd: "/fixture", ui: { setHeader: (factory: Function) => {
			header = factory({ requestRender() {} }, { fg: (_role: string, text: string) => text });
		} } });
		t.mock.timers.tick(50);
		try {
			for (const width of [40, 80, 160]) {
				const lines = header!.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				const text = stripAnsi(lines.join("\n"));
				assert.match(text, /GIT:/);
				assert.match(text, /PATH:/);
				if (width === 160) {
					assert.equal(/[\u2800-\u28ff]/.test(text), showRose);
					assert.equal(/[▒▄▀█]/.test(text), showTextLogo);
				}
				assert.match(lines.join("\n"), /\x1b\[38;2;85;170;205m/, "startup labels use the saved cyan palette");
			}
			// Cancel pending context reads before advancing the resize clock.
			t.mock.timers.reset();
			t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() + 1000 });
			process.stdout.rows = 10;
			process.stdout.emit("resize");
			t.mock.timers.tick(150);
			assert.deepEqual(header!.render(80), []);
			process.stdout.rows = 25;
			process.stdout.columns = 80;
			process.stdout.emit("resize");
			t.mock.timers.tick(150);
			const minimal = stripAnsi(header!.render(80).join("\n"));
			assert.doesNotMatch(minimal, /[\u2800-\u28ff]/);
			assert.equal(/[▒▄▀█]/.test(minimal), showTextLogo);
			assert.deepEqual(writes, [], "Pi owns stdout during startup and resize");
		} finally {
			shutdown!();
			write.mock.restore();
		}
	});
}

// The banner's MCP stat counted every key in the GLOBAL config file, so a
// server that connects to nothing still inflated it and a project-only server
// never appeared (#979). It also read only the two Pi-owned files, while the
// session merges six layers, so a server defined in a shared layer was missing
// and an omitted higher-precedence `disabled` entry kept one in the count.
const MCP_LAYER_NAMES = [
	"sharedGlobal",
	"agentsGlobal",
	"agentsNested",
	"global",
	"projectShared",
	"project",
] as const;

const mcpLayers = (cwd: string, layers: Partial<Record<(typeof MCP_LAYER_NAMES)[number], unknown>>) => {
	const paths = mcpConfigPaths(cwd);
	// Control: the layers really are distinct paths, or every case below would
	// be measuring one file several times over.
	assert.equal(paths.length, MCP_LAYER_NAMES.length);
	assert.equal(new Set(paths).size, paths.length);
	const byPath = new Map(paths.map((path, index) => [path, MCP_LAYER_NAMES[index]!]));
	return async (path: string) => {
		const name = byPath.get(path);
		const body = name === undefined ? undefined : layers[name];
		if (body === undefined) throw new Error(`ENOENT: ${path}`);
		return typeof body === "string" ? body : JSON.stringify(body);
	};
};

test("MCP stat counts servers the session loads, not keys in the config file", async () => {
	const read = mcpLayers("/repo", {
		global: { mcpServers: { one: { command: "a" }, two: { command: "b", disabled: true } } },
	});
	assert.equal(await countEnabledMcpServers("/repo", read), 1);
});

test("MCP stat sees a project layer, and lets it disable a globally enabled server", async () => {
	const read = mcpLayers("/repo", {
		global: { mcpServers: { shared: { command: "a" } } },
		project: { mcpServers: { shared: { command: "a", disabled: true }, local: { command: "c" } } },
	});
	// `shared` is off for this project and `local` exists only here: one server.
	assert.equal(await countEnabledMcpServers("/repo", read), 1);
});

test("MCP stat reads the shared layers the session merges, not only the Pi-owned two", async () => {
	// One server per shared layer, none of them in a Pi-owned file. Reading only
	// `~/.pi/agent/mcp.json` and `<cwd>/.pi/mcp.json` reported none of them.
	const read = mcpLayers("/repo", {
		sharedGlobal: { mcpServers: { a: { command: "a" } } },
		agentsGlobal: { mcpServers: { b: { command: "b" } } },
		agentsNested: { mcpServers: { c: { command: "c" } } },
		projectShared: { mcpServers: { d: { command: "d" } } },
	});
	assert.equal(await countEnabledMcpServers("/repo", read), 4);
});

test("MCP stat lets a higher layer disable a server a lower one enabled", async () => {
	// The direction the old two-path read could not see: `.mcp.json` sits ABOVE
	// the Pi global file, so its `disabled` wins and the banner must not keep
	// counting the server the global layer enabled.
	const read = mcpLayers("/repo", {
		sharedGlobal: { mcpServers: { shared: { command: "a" } } },
		projectShared: { mcpServers: { shared: { command: "a", disabled: true } } },
	});
	assert.equal(await countEnabledMcpServers("/repo", read), 0);
});

test("MCP stat reads the mcp-servers spelling the adapter also accepts", async () => {
	const read = mcpLayers("/repo", {
		global: { "mcp-servers": { one: { command: "a" } } },
	});
	assert.equal(await countEnabledMcpServers("/repo", read), 1);
});

test("MCP stat tolerates a config whose mcpServers is not an object of entries", async () => {
	// An entry that is not a non-null object is not a server definition: the
	// adapter's `isRecord` drops it before the session sees it, so counting it
	// as enabled reported a server that never loads.
	const shapes: [unknown, number][] = [
		[{ mcpServers: [] }, 0],
		[{ mcpServers: null }, 0],
		[{}, 0],
		["null", 0],
		[{ mcpServers: { one: null } }, 0],
		[{ mcpServers: { one: "a" } }, 0],
		[{ mcpServers: { one: [] } }, 0],
		[{ mcpServers: { one: { command: "a" }, two: null } }, 1],
	];
	for (const [shape, expected] of shapes) {
		assert.equal(
			await countEnabledMcpServers("/repo", mcpLayers("/repo", { global: shape })),
			expected,
			`shape ${JSON.stringify(shape)}`,
		);
	}
});
