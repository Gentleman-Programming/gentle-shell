import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleMusicExtension, {
	findOnPath,
	formatMusicStatus,
	GENTLE_STREAM_SPEC,
	installHint,
	MUSIC_COMMAND_NAME,
	MUSIC_INSTALL_OFFER,
	MUSIC_WINDOWS_UNSUPPORTED,
	MUSIC_INSTALL_TITLE,
	musicTuiArgs,
	parseMusicArgs,
	resolveGentleStream,
	type BundledMusicPlayer,
	type MusicSpawn,
} from "../extensions/gentle-music.ts";

// The music tests describe a supported (POSIX) host unless they pass `platform`,
// so they hold on every OS the suite runs on, Windows included.
const gentleMusic = (pi: Parameters<typeof gentleMusicExtension>[0], deps: Parameters<typeof gentleMusicExtension>[1] = {}) =>
	gentleMusicExtension(pi, { platform: "linux", ...deps });

// /gentle:music hands the terminal to gentle-stream's own TUI, the way Pi's
// external editor does, and controls the background player with
// `gentle-stream ctl …` without taking the terminal.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> };

function fakePi() {
	const commands = new Map<string, Command>();
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerCommand: (name: string, registration: Command) => commands.set(name, registration),
		registerShortcut: () => assert.fail("/gentle:music registers no shortcut"),
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	} as unknown as ExtensionAPI;
	const fire = async (event: string, payload: unknown, ctx: ExtensionContext) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	return { pi, commands, fire };
}

function fakeContext(mode = "tui", model: { provider: string; id: string } | null = { provider: "anthropic", id: "claude-sonnet-5-5" }, failing?: "stop" | "start") {
	const notices: Array<[string, string | undefined]> = [];
	const calls: string[] = [];
	let settled = false;
	const tui = {
		stop: () => { calls.push("stop"); if (failing === "stop") throw new Error("terminal busy"); },
		start: () => { calls.push("start"); if (failing === "start") throw new Error("terminal gone"); },
		requestRender: (force?: boolean) => calls.push(`render:${force === true}`),
	};
	const ctx = {
		hasUI: true,
		mode,
		model: model ?? undefined,
		ui: {
			notify: (message: string, type?: string) => notices.push([message, type]),
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown) =>
				new Promise((resolve) => {
					factory(tui, {}, {}, (value) => { settled = true; resolve(value); });
				}),
		},
	} as unknown as ExtensionContext;
	return { ctx, notices, calls, settled: () => settled };
}

type Outcome = { code?: number | null; error?: Error; stdout?: string; stderr?: string; hang?: boolean };

function fakeSpawn(outcomes: Outcome[], calls: string[] = []) {
	const spawned: Array<{ command: string; args: readonly string[]; stdio: unknown }> = [];
	const spawn: MusicSpawn = (command, args, options) => {
		spawned.push({ command, args, stdio: options.stdio });
		calls.push(`spawn:${args.join(" ")}`);
		const outcome = outcomes.shift() ?? { code: 0 };
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			kill: () => { calls.push("kill"); child.emit("close", null); return true; },
		});
		if (!outcome.hang) {
			setImmediate(() => {
				if (outcome.error) { child.emit("error", outcome.error); return; }
				if (outcome.stdout) child.stdout.emit("data", Buffer.from(outcome.stdout));
				if (outcome.stderr) child.stderr.emit("data", Buffer.from(outcome.stderr));
				child.emit("close", outcome.code ?? 0);
			});
		}
		return child;
	};
	return { spawn, spawned };
}

const onPath = (names: Record<string, string>) => (name: string) => names[name];

function fakeSignals() {
	const listeners = new Set<() => void>();
	return {
		listeners,
		signals: { on: (_signal: "SIGINT", listener: () => void) => listeners.add(listener), off: (_signal: "SIGINT", listener: () => void) => listeners.delete(listener) },
	};
}

test("executable resolution prefers gentle-stream, then uvx, then uv, else nothing", () => {
	assert.deepEqual(resolveGentleStream(onPath({ "gentle-stream": "/bin/gentle-stream", uvx: "/bin/uvx" })), { command: "/bin/gentle-stream", prefix: [] });
	assert.deepEqual(resolveGentleStream(onPath({ uvx: "/bin/uvx", uv: "/bin/uv" })), { command: "/bin/uvx", prefix: ["--from", GENTLE_STREAM_SPEC, "gentle-stream"] });
	assert.deepEqual(resolveGentleStream(onPath({ uv: "/bin/uv" })), { command: "/bin/uv", prefix: ["tool", "run", "--from", GENTLE_STREAM_SPEC, "gentle-stream"] });
	assert.equal(resolveGentleStream(onPath({})), undefined);
});

test("findOnPath finds executable files only, honoring PATHEXT on Windows", (t: TestContext) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-music-path-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const a = join(root, "a");
	const b = join(root, "b");
	mkdirSync(a);
	mkdirSync(b);
	writeFileSync(join(a, "gentle-stream"), "not executable");
	chmodSync(join(a, "gentle-stream"), 0o644);
	writeFileSync(join(b, "gentle-stream"), "#!/bin/sh\n");
	chmodSync(join(b, "gentle-stream"), 0o755);
	mkdirSync(join(a, "uvx"));
	const env = { PATH: [a, b].join(delimiter) };
	if (process.platform !== "win32") assert.equal(findOnPath("gentle-stream", env, "darwin"), join(b, "gentle-stream"));
	assert.equal(findOnPath("uvx", env, "darwin"), undefined, "a directory is not an executable");
	assert.equal(findOnPath("missing", env, "darwin"), undefined);
	assert.equal(findOnPath("gentle-stream", {}, "darwin"), undefined);
	writeFileSync(join(a, "uv.EXE"), "");
	assert.equal(findOnPath("uv", { Path: a, PATHEXT: ".COM;.EXE" }, "win32"), join(a, "uv.EXE"));
});

test("TUI arguments carry the session model and the mood as one argument", () => {
	assert.deepEqual(musicTuiArgs({ model: { provider: "anthropic", id: "claude-sonnet-5-5" }, mood: "rainy \"lo-fi\" night; $HOME" }), ["--model", "anthropic/claude-sonnet-5-5", "--mood", "rainy \"lo-fi\" night; $HOME"]);
	assert.deepEqual(musicTuiArgs({ model: { provider: "anthropic", id: "claude-sonnet-5-5" } }), ["--model", "anthropic/claude-sonnet-5-5"]);
	assert.deepEqual(musicTuiArgs({ model: undefined, mood: "calm" }), ["--mood", "calm"]);
	assert.deepEqual(musicTuiArgs({ model: { provider: "", id: "x" } }), []);
});

test("only an exact single control word is a subcommand; anything else is a mood", () => {
	assert.deepEqual(parseMusicArgs(""), { kind: "tui" });
	assert.deepEqual(parseMusicArgs("   "), { kind: "tui" });
	for (const command of ["next", "pause", "play", "stop", "status"]) assert.deepEqual(parseMusicArgs(` ${command} `), { kind: "ctl", command });
	assert.deepEqual(parseMusicArgs("next to the sea"), { kind: "tui", mood: "next to the sea" });
	assert.deepEqual(parseMusicArgs("toggle"), { kind: "tui", mood: "toggle" });
	assert.deepEqual(parseMusicArgs("  dark synthwave  "), { kind: "tui", mood: "dark synthwave" });
});

test("status output becomes a one-line summary", () => {
	assert.equal(formatMusicStatus('{"running": false}\n'), "nothing is playing");
	assert.equal(formatMusicStatus('{"running": true, "playing": true, "name": "Neon Rain", "genre": "synthwave", "mood": "night"}'), "♪ Neon Rain · synthwave · playing");
	assert.equal(formatMusicStatus('{"running": true, "playing": false, "name": "Neon Rain", "genre": "synthwave", "mood": ""}'), "♪ Neon Rain · synthwave · paused");
	assert.equal(formatMusicStatus('{"running": true, "playing": true, "name": "", "genre": ""}'), "♪ playing");
	assert.equal(formatMusicStatus("garbage"), undefined);
	assert.equal(formatMusicStatus("[]"), undefined);
});

test("registers /gentle:music without a shortcut", () => {
	const { pi, commands } = fakePi();
	gentleMusic(pi, { which: onPath({}) });
	assert.equal(MUSIC_COMMAND_NAME, "gentle:music");
	assert.match(commands.get(MUSIC_COMMAND_NAME)!.description, /gentle-stream/);
});

test("non-TUI modes get a notice and spawn nothing", async () => {
	const { pi, commands } = fakePi();
	const { spawn, spawned } = fakeSpawn([]);
	gentleMusic(pi, { which: onPath({ "gentle-stream": "/bin/gentle-stream" }), spawn });
	for (const mode of ["rpc", "json", "print"]) {
		const context = fakeContext(mode);
		await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
		assert.deepEqual(context.notices, [["/gentle:music needs the interactive terminal.", "warning"]]);
		assert.deepEqual(context.calls, []);
	}
	assert.equal(spawned.length, 0);
});

test("without gentle-stream or uv the command explains how to install and does nothing else", async () => {
	const { pi, commands } = fakePi();
	const { spawn, spawned } = fakeSpawn([]);
	gentleMusic(pi, { which: onPath({}), spawn });
	const context = fakeContext();
	await commands.get(MUSIC_COMMAND_NAME)!.handler("calm", context.ctx);
	assert.equal(spawned.length, 0);
	assert.deepEqual(context.calls, []);
	assert.equal(context.notices.length, 1);
	const [message, type] = context.notices[0]!;
	assert.equal(type, "warning");
	assert.match(message, /https:\/\/docs\.astral\.sh\/uv/);
	assert.ok(message.includes(`uv tool install '${GENTLE_STREAM_SPEC}'`));
});

test("the TUI gets the terminal, then Pi is restarted with a forced repaint", async () => {
	const { pi, commands } = fakePi();
	const context = fakeContext();
	const { spawn, spawned } = fakeSpawn([{ code: 0 }], context.calls);
	const { listeners, signals } = fakeSignals();
	let sigintWhileRunning = 0;
	gentleMusic(pi, { which: onPath({ "gentle-stream": "/bin/gentle-stream" }), spawn: (command, args, options) => { sigintWhileRunning = listeners.size; return spawn(command, args, options); }, signals });
	await commands.get(MUSIC_COMMAND_NAME)!.handler("rainy night", context.ctx);
	assert.deepEqual(context.calls, ["stop", "spawn:--model anthropic/claude-sonnet-5-5 --mood rainy night", "start", "render:true"]);
	assert.deepEqual(spawned[0], { command: "/bin/gentle-stream", args: ["--model", "anthropic/claude-sonnet-5-5", "--mood", "rainy night"], stdio: "inherit" });
	assert.equal(sigintWhileRunning, 1, "Pi ignores Ctrl+C while the TUI runs");
	assert.equal(listeners.size, 0, "the SIGINT guard is removed afterwards");
	assert.deepEqual(context.notices, []);
	assert.equal(context.settled(), true);
});

test("the uvx fallback runs gentle-stream from the published spec", async () => {
	const { pi, commands } = fakePi();
	const context = fakeContext("tui", null);
	const { spawn, spawned } = fakeSpawn([{ code: 0 }], context.calls);
	gentleMusic(pi, { which: onPath({ uvx: "/bin/uvx" }), spawn, signals: fakeSignals().signals });
	await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
	assert.deepEqual(spawned[0]!.args, ["--from", GENTLE_STREAM_SPEC, "gentle-stream"]);
});

test("Pi is restored and the failure reported when the TUI exits non-zero or cannot start", async () => {
	for (const [outcome, pattern] of [[{ code: 2 }, /exited with code 2/], [{ error: new Error("spawn ENOENT") }, /could not start.*spawn ENOENT/]] as const) {
		const { pi, commands } = fakePi();
		const context = fakeContext();
		const { spawn } = fakeSpawn([outcome], context.calls);
		const { listeners, signals } = fakeSignals();
		gentleMusic(pi, { which: onPath({ "gentle-stream": "/bin/gentle-stream" }), spawn, signals });
		await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
		assert.deepEqual(context.calls.filter((call) => !call.startsWith("spawn")), ["stop", "start", "render:true"]);
		assert.equal(listeners.size, 0);
		assert.equal(context.notices.length, 1);
		assert.match(context.notices[0]![0], pattern);
		assert.equal(context.notices[0]![1], "error");
	}
});

test("Pi is restored even when spawn itself throws", async () => {
	const { pi, commands } = fakePi();
	const context = fakeContext();
	const { listeners, signals } = fakeSignals();
	gentleMusic(pi, { which: onPath({ "gentle-stream": "/bin/gentle-stream" }), spawn: () => { throw new Error("EPERM"); }, signals });
	await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
	assert.deepEqual(context.calls, ["stop", "start", "render:true"]);
	assert.equal(listeners.size, 0);
	assert.match(context.notices[0]![0], /could not start.*EPERM/);
});

test("control words run ctl with captured output and never take the terminal", async () => {
	const { pi, commands } = fakePi();
	const context = fakeContext();
	const { spawn, spawned } = fakeSpawn([
		{ code: 0, stdout: '{"running": true, "playing": true, "name": "Neon Rain", "genre": "synthwave", "mood": "night"}\n' },
		{ code: 0 },
		{ code: 1, stderr: "gentle-stream: nothing is playing\n" },
		{ code: 0, stdout: "not json" },
	], context.calls);
	gentleMusic(pi, { which: onPath({ uvx: "/bin/uvx" }), spawn });
	const run = (args: string) => commands.get(MUSIC_COMMAND_NAME)!.handler(args, context.ctx);
	await run("status");
	await run("next");
	await run("pause");
	await run("status");
	assert.deepEqual(spawned.map((entry) => entry.args.slice(3)), [["ctl", "status"], ["ctl", "next"], ["ctl", "pause"], ["ctl", "status"]]);
	assert.ok(spawned.every((entry) => JSON.stringify(entry.stdio) === JSON.stringify(["ignore", "pipe", "pipe"])));
	assert.ok(!context.calls.includes("stop"), "ctl never stops the TUI");
	assert.deepEqual(context.notices, [
		["♪ Neon Rain · synthwave · playing", "info"],
		["♪ next track", "info"],
		["gentle-stream: nothing is playing", "warning"],
		["gentle-stream status was not readable: not json", "warning"],
	]);
});

test("a control word without gentle-stream or uv explains how to install", async () => {
	const { pi, commands } = fakePi();
	const { spawn, spawned } = fakeSpawn([]);
	gentleMusic(pi, { which: onPath({}), spawn });
	const context = fakeContext();
	await commands.get(MUSIC_COMMAND_NAME)!.handler("next", context.ctx);
	assert.equal(spawned.length, 0);
	assert.match(context.notices[0]![0], /uv tool install/);
});

test("quitting Pi stops the music only after /gentle:music was used", async () => {
	const unused = fakePi();
	const quiet = fakeSpawn([]);
	gentleMusic(unused.pi, { which: onPath({ "gentle-stream": "/bin/gentle-stream" }), spawn: quiet.spawn, signals: fakeSignals().signals, usage: { used: false } });
	await unused.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, fakeContext().ctx);
	assert.equal(quiet.spawned.length, 0);

	const usage = { used: false };
	const { pi, commands, fire } = fakePi();
	const context = fakeContext();
	const { spawn, spawned } = fakeSpawn([{ code: 0 }, { code: 0 }], context.calls);
	gentleMusic(pi, { which: onPath({ "gentle-stream": "/bin/gentle-stream" }), spawn, signals: fakeSignals().signals, usage });
	await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
	await fire("session_shutdown", { type: "session_shutdown", reason: "new" }, context.ctx);
	assert.equal(spawned.length, 1, "switching sessions keeps the music playing");
	await fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, context.ctx);
	assert.deepEqual(spawned[1], { command: "/bin/gentle-stream", args: ["ctl", "stop"], stdio: ["ignore", "pipe", "pipe"] });
});

test("the shutdown stop never blocks longer than its budget", async () => {
	const { pi, commands, fire } = fakePi();
	const context = fakeContext();
	const { spawn } = fakeSpawn([{ code: 0 }, { hang: true }], context.calls);
	gentleMusic(pi, { which: onPath({ "gentle-stream": "/bin/gentle-stream" }), spawn, signals: fakeSignals().signals, usage: { used: false }, shutdownTimeoutMs: 20 });
	await commands.get(MUSIC_COMMAND_NAME)!.handler("status", context.ctx);
	const started = Date.now();
	await fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, context.ctx);
	assert.ok(Date.now() - started < 1000);
	assert.ok(context.calls.includes("kill"), "the hung ctl is killed");
});

test("a failing terminal handover still settles the command, reports it and removes the Ctrl+C guard", async () => {
	for (const failing of ["stop", "start"] as const) {
		const { pi, commands } = fakePi();
		const context = fakeContext("tui", undefined, failing);
		const { spawn, spawned } = fakeSpawn([{ code: 0 }], context.calls);
		const { listeners, signals } = fakeSignals();
		gentleMusic(pi, { which: onPath({ "gentle-stream": "/bin/gentle-stream" }), spawn, signals });
		await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
		assert.equal(context.settled(), true, `done is called when tui.${failing}() throws`);
		assert.equal(listeners.size, 0, "the SIGINT guard is removed");
		assert.equal(spawned.length, failing === "stop" ? 0 : 1);
		assert.equal(context.notices.length, 1);
		assert.match(context.notices[0]![0], failing === "stop" ? /terminal busy/ : /terminal gone/);
	}
});

test("Windows .cmd and .bat shims are not picked, so resolution falls back to uvx", (t: TestContext) => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-music-win-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "gentle-stream.CMD"), "@echo off\n");
	writeFileSync(join(dir, "uvx.BAT"), "@echo off\n");
	writeFileSync(join(dir, "uv.EXE"), "");
	const env = { Path: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
	assert.equal(findOnPath("gentle-stream", env, "win32"), undefined);
	assert.equal(findOnPath("uvx", env, "win32"), undefined);
	assert.equal(findOnPath("uv", env, "win32"), join(dir, "uv.EXE"));
	const resolved = resolveGentleStream((name) => findOnPath(name, env, "win32"));
	assert.equal(resolved?.command, join(dir, "uv.EXE"));
});

// S5: a bundled Gentle Shell offers to install the player inside its own
// folder; any other install keeps the manual hint.
const PREVIOUS_HINT = "/gentle:music needs gentle-stream, and neither gentle-stream nor uv is on PATH. Install uv (https://docs.astral.sh/uv/getting-started/installation/) and run /gentle:music again, or install gentle-stream with: uv tool install 'gentle-stream[samples] @ git+https://github.com/Gentleman-Programming/gentle-stream'";

function withConfirm(context: ReturnType<typeof fakeContext>, answer: boolean) {
	const asked: Array<[string, string]> = [];
	(context.ctx.ui as unknown as { confirm: (title: string, message: string) => Promise<boolean> }).confirm = async (title, message) => {
		asked.push([title, message]);
		return answer;
	};
	return asked;
}

function fakeBundled({ installed = false, fail }: { installed?: boolean; fail?: Error } = {}) {
	const state = { installed, installs: 0 };
	const player: BundledMusicPlayer = {
		gentleStream: "/prefix/music/bin/gentle-stream",
		installed: () => state.installed,
		install: async (progress) => {
			state.installs += 1;
			progress("Downloading uv 0.13.6…");
			if (fail) throw fail;
			state.installed = true;
			return { gentleStream: "/prefix/music/bin/gentle-stream", samples: true };
		},
	};
	return { state, bundled: async () => player };
}

test("the manual hint outside a bundled install is unchanged", async () => {
	assert.equal(installHint(), PREVIOUS_HINT);
	const { pi, commands } = fakePi();
	const { spawn, spawned } = fakeSpawn([]);
	gentleMusic(pi, { which: onPath({}), spawn, bundled: async () => undefined });
	const context = fakeContext();
	const asked = withConfirm(context, true);
	await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
	assert.deepEqual(asked, [], "no offer outside a bundled install");
	assert.deepEqual(context.notices, [[PREVIOUS_HINT, "warning"]]);
	assert.equal(spawned.length, 0);
});

test("a bundled install without the player offers it; declining shows the hint and installs nothing", async () => {
	const { pi, commands } = fakePi();
	const { spawn, spawned } = fakeSpawn([]);
	const { state, bundled } = fakeBundled();
	gentleMusic(pi, { which: onPath({}), spawn, bundled });
	const context = fakeContext();
	const asked = withConfirm(context, false);
	await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
	assert.deepEqual(asked, [[MUSIC_INSTALL_TITLE, MUSIC_INSTALL_OFFER]]);
	assert.equal(MUSIC_INSTALL_OFFER, "Install the gentle-stream music player inside Gentle Shell? It downloads uv, Python 3.13 and the player (about 150 MB) into the Gentle Shell folder.");
	assert.equal(state.installs, 0);
	assert.deepEqual(context.notices, [[PREVIOUS_HINT, "warning"]]);
	assert.equal(spawned.length, 0);
});

test("accepting the offer installs the player with progress, then starts the music from the prefix", async () => {
	const { pi, commands } = fakePi();
	const context = fakeContext();
	const { spawn, spawned } = fakeSpawn([{ code: 0 }], context.calls);
	const { state, bundled } = fakeBundled();
	gentleMusic(pi, { which: onPath({}), spawn, bundled, signals: fakeSignals().signals });
	withConfirm(context, true);
	await commands.get(MUSIC_COMMAND_NAME)!.handler("calm", context.ctx);
	assert.equal(state.installs, 1);
	assert.deepEqual(context.notices.map(([, type]) => type), ["info", "info"]);
	assert.match(context.notices[0]![0], /Downloading uv/);
	assert.match(context.notices[1]![0], /installed/i);
	assert.equal(spawned[0]!.command, "/prefix/music/bin/gentle-stream");
	assert.deepEqual(spawned[0]!.args, ["--model", "anthropic/claude-sonnet-5-5", "--mood", "calm"]);
});

test("on Windows /gentle:music explains it is not available yet and never offers, installs or runs anything", async () => {
	assert.equal(MUSIC_WINDOWS_UNSUPPORTED, "/gentle:music is not available on Windows yet: the gentle-stream player runs on macOS and Linux. It works when Gentle Shell runs inside WSL.");
	for (const args of ["", "calm", "status", "stop"]) {
		const { pi, commands } = fakePi();
		const context = fakeContext();
		const asked = withConfirm(context, true);
		const { spawn, spawned } = fakeSpawn([{ code: 0 }], context.calls);
		const { state, bundled } = fakeBundled({ installed: true });
		gentleMusic(pi, { which: onPath({ "gentle-stream": "C:\\bin\\gentle-stream.exe", uvx: "C:\\bin\\uvx.exe" }), spawn, bundled, signals: fakeSignals().signals, platform: "win32" });
		await commands.get(MUSIC_COMMAND_NAME)!.handler(args, context.ctx);
		assert.deepEqual(context.notices, [[MUSIC_WINDOWS_UNSUPPORTED, "warning"]], args);
		assert.deepEqual(asked, [], args);
		assert.equal(state.installs, 0, args);
		assert.equal(spawned.length, 0, args);
	}
});

test("on Windows the not-available notice wins over the interactive-terminal notice", async () => {
	for (const mode of ["rpc", "json", "print"]) {
		const { pi, commands } = fakePi();
		const context = fakeContext(mode);
		const { spawn, spawned } = fakeSpawn([{ code: 0 }], context.calls);
		gentleMusic(pi, { which: onPath({ uvx: "C:\\bin\\uvx.exe" }), spawn, platform: "win32" });
		await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
		assert.deepEqual(context.notices, [[MUSIC_WINDOWS_UNSUPPORTED, "warning"]], mode);
		assert.equal(spawned.length, 0, mode);
	}
});

test("an installed prefix player is used without asking; PATH gentle-stream still comes first", async () => {
	const { bundled } = fakeBundled({ installed: true });
	for (const [names, expected] of [[{}, "/prefix/music/bin/gentle-stream"], [{ uvx: "/bin/uvx" }, "/prefix/music/bin/gentle-stream"], [{ "gentle-stream": "/bin/gentle-stream" }, "/bin/gentle-stream"]] as const) {
		const { pi, commands } = fakePi();
		const context = fakeContext();
		const asked = withConfirm(context, false);
		const { spawn, spawned } = fakeSpawn([{ code: 0 }], context.calls);
		gentleMusic(pi, { which: onPath(names), spawn, bundled, signals: fakeSignals().signals });
		await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
		assert.deepEqual(asked, []);
		assert.equal(spawned[0]!.command, expected);
		assert.deepEqual(spawned[0]!.args, ["--model", "anthropic/claude-sonnet-5-5"]);
	}
	assert.deepEqual(resolveGentleStream(onPath({ uv: "/bin/uv" }), "/prefix/music/bin/gentle-stream"), { command: "/prefix/music/bin/gentle-stream", prefix: [] });
});

test("a bundled install with uv on PATH keeps the uvx route and does not offer", async () => {
	const { pi, commands } = fakePi();
	const context = fakeContext();
	const asked = withConfirm(context, true);
	const { spawn, spawned } = fakeSpawn([{ code: 0 }], context.calls);
	gentleMusic(pi, { which: onPath({ uvx: "/bin/uvx" }), spawn, bundled: fakeBundled().bundled, signals: fakeSignals().signals });
	await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
	assert.deepEqual(asked, []);
	assert.equal(spawned[0]!.command, "/bin/uvx");
});

test("a failed install is reported and nothing starts", async () => {
	const { pi, commands } = fakePi();
	const { spawn, spawned } = fakeSpawn([]);
	gentleMusic(pi, { which: onPath({}), spawn, bundled: fakeBundled({ fail: new Error("Download integrity mismatch") }).bundled });
	const context = fakeContext();
	withConfirm(context, true);
	await commands.get(MUSIC_COMMAND_NAME)!.handler("", context.ctx);
	assert.equal(spawned.length, 0);
	const [message, type] = context.notices.at(-1)!;
	assert.equal(type, "error");
	assert.match(message, /could not install gentle-stream.*Download integrity mismatch/);
});
