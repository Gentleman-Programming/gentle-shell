import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../lib/terminal-theme.ts";
import gentleStats, { STATS_COMMAND_NAME, statsSessionRoots, statsViewKey } from "../extensions/gentle-stats.ts";

// /gentle:stats wiring: the command (and optional shortcut) opens the stats
// panel as a full-terminal overlay, loads sessions after it opens, closes
// with a forced repaint, and session shutdown force-closes it.

const STATS_HOME = fileURLToPath(new URL("./fixtures/stats", import.meta.url));
const SESSIONS = join(STATS_HOME, "sessions");
const USER_PI_HOME = join(STATS_HOME, "user-pi");
const NOW = Date.parse("2026-10-01T12:00:00.000Z");

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Component = { render(width: number): string[]; handleInput?(data: string): void };

function fakePi() {
	const commands = new Map<string, { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const shortcuts = new Map<string, { description: string; handler(ctx: ExtensionContext): Promise<void> }>();
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerCommand: (name: string, registration: { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, registration),
		registerShortcut: (key: string, registration: { description: string; handler(ctx: ExtensionContext): Promise<void> }) => shortcuts.set(key, registration),
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	} as unknown as ExtensionAPI;
	const fire = async (event: string, ctx: ExtensionContext) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	return { pi, commands, shortcuts, fire };
}

function fakeContext(mode = "tui", hasUI = true) {
	const notices: string[] = [];
	const renders: Array<boolean | undefined> = [];
	const options: unknown[] = [];
	let component: Component | undefined;
	let settled = false;
	const tui = { terminal: { rows: 30 }, requestRender: (force?: boolean) => renders.push(force) };
	const ctx = {
		hasUI,
		mode,
		cwd: "/work/alpha",
		sessionManager: { getSessionId: () => "live", getCwd: () => "/work/alpha", getEntries: () => [] },
		ui: {
			notify: (message: string) => notices.push(message),
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => Component, overlayOptions: unknown) =>
				new Promise((resolve) => {
					options.push(overlayOptions);
					component = factory(tui, { fg: (_role: string, text: string) => text }, {}, (value) => { settled = true; resolve(value); });
				}),
		},
	} as unknown as ExtensionContext;
	return { ctx, notices, renders, options, component: () => component, settled: () => settled };
}

async function until(check: () => boolean, attempts = 200) {
	for (let attempt = 0; attempt < attempts && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(check(), "condition not reached");
}

test("statsViewKey is off by default and honors an explicit key", () => {
	assert.equal(statsViewKey({}), undefined);
	assert.equal(statsViewKey({ GENTLE_PI_STATS_VIEW_KEY: "alt+t" }), "alt+t");
	assert.equal(statsViewKey({ GENTLE_PI_STATS_VIEW_KEY: " off " }), undefined);
	assert.equal(statsViewKey({ GENTLE_PI_STATS_VIEW_KEY: "" }), undefined);
});

test("registers /gentle:stats and only registers a shortcut when one is configured", () => {
	const plain = fakePi();
	gentleStats(plain.pi, { env: {} });
	assert.equal(STATS_COMMAND_NAME, "gentle:stats");
	assert.match(plain.commands.get(STATS_COMMAND_NAME)!.description, /usage/i);
	assert.equal(plain.shortcuts.size, 0);
	const keyed = fakePi();
	gentleStats(keyed.pi, { env: { GENTLE_PI_STATS_VIEW_KEY: "alt+t" } });
	assert.deepEqual([...keyed.shortcuts.keys()], ["alt+t"]);
});

test("the command opens a full-terminal overlay that loads, renders, and closes with a repaint", async () => {
	const { pi, commands } = fakePi();
	gentleStats(pi, { env: {}, now: () => NOW, sessionsRoots: () => [SESSIONS] });
	const context = fakeContext();
	const opened = commands.get(STATS_COMMAND_NAME)!.handler("", context.ctx);
	assert.deepEqual(context.options[0], { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } });
	const view = context.component()!;
	assert.match(view.render(100).map(stripAnsi).join("\n"), /Loading local sessions…/);
	await until(() => !view.render(100).map(stripAnsi).join("\n").includes("Loading"));
	const text = view.render(100).map(stripAnsi).join("\n");
	assert.match(text, /Total tokens +2\.8k/);
	assert.equal(view.render(100).length, 30);
	view.handleInput!("q");
	await opened;
	assert.equal(context.settled(), true);
	assert.ok(context.renders.includes(true), "closing forces a full repaint");
});

test("stats read the active home and the user's original Pi home, falling back to the conventional one", () => {
	assert.deepEqual(statsSessionRoots("/gs/agent", { GENTLE_SHELL_USER_PI_HOME: "/custom/pi" }, "/home/u"), ["/gs/agent/sessions", "/custom/pi/sessions"]);
	// Launched directly (or by an older launcher): the conventional ~/.pi/agent, never PI_CODING_AGENT_DIR.
	assert.deepEqual(statsSessionRoots("/gs/agent", { PI_CODING_AGENT_DIR: "/gs/agent" }, "/home/u"), ["/gs/agent/sessions", "/home/u/.pi/agent/sessions"]);
	assert.deepEqual(statsSessionRoots("/gs/agent", { GENTLE_SHELL_USER_PI_HOME: "" }, "/home/u"), ["/gs/agent/sessions", "/home/u/.pi/agent/sessions"]);
});

test("the overlay totals combine the Gentle Shell and regular Pi histories", async () => {
	const { pi, commands } = fakePi();
	gentleStats(pi, { env: {}, now: () => NOW, sessionsRoots: () => statsSessionRoots(STATS_HOME, { GENTLE_SHELL_USER_PI_HOME: USER_PI_HOME }) });
	const context = fakeContext();
	const opened = commands.get(STATS_COMMAND_NAME)!.handler("", context.ctx);
	const view = context.component()!;
	await until(() => !view.render(100).map(stripAnsi).join("\n").includes("Loading"));
	assert.match(view.render(100).map(stripAnsi).join("\n"), /Total tokens +5\.8k/);
	view.handleInput!("q");
	await opened;
});

test("the shortcut opens the same overlay", async () => {
	const { pi, shortcuts } = fakePi();
	gentleStats(pi, { env: { GENTLE_PI_STATS_VIEW_KEY: "alt+t" }, now: () => NOW, sessionsRoots: () => [SESSIONS] });
	const context = fakeContext();
	const opened = shortcuts.get("alt+t")!.handler(context.ctx);
	assert.equal(context.options.length, 1);
	context.component()!.handleInput!("\x1b");
	await opened;
	assert.equal(context.settled(), true);
});

test("non-TUI modes get a notice and headless contexts get nothing", async () => {
	const { pi, commands } = fakePi();
	gentleStats(pi, { env: {}, sessionsRoots: () => [SESSIONS] });
	const rpc = fakeContext("rpc");
	await commands.get(STATS_COMMAND_NAME)!.handler("", rpc.ctx);
	assert.deepEqual(rpc.notices, ["The stats overlay requires TUI mode."]);
	assert.equal(rpc.options.length, 0);
	const headless = fakeContext("tui", false);
	await commands.get(STATS_COMMAND_NAME)!.handler("", headless.ctx);
	assert.equal(headless.options.length, 0);
	assert.deepEqual(headless.notices, []);
});

test("session shutdown force-closes an open overlay", async () => {
	const { pi, commands, fire } = fakePi();
	gentleStats(pi, { env: {}, now: () => NOW, sessionsRoots: () => [SESSIONS] });
	const context = fakeContext();
	const opened = commands.get(STATS_COMMAND_NAME)!.handler("", context.ctx);
	await fire("session_shutdown", context.ctx);
	await opened;
	assert.equal(context.settled(), true);
});
