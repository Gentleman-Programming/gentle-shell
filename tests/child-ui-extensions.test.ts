import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gentleMusic from "../extensions/gentle-music.ts";
import { createStarPromptExtension } from "../extensions/gentle-star-prompt.ts";
import gentleTps from "../extensions/gentle-tps.ts";
import startupBanner from "../extensions/startup-banner.ts";
import { DEFAULT_STAR_PROMPT_STATE, type StarPromptState } from "../lib/star-prompt.ts";

// gentle-shell#3386 phase 2: delegated children (GENTLE_PI_AGENTS_CHILD=1) have no
// terminal, so the UI-only entrypoints register nothing there. Parents are unchanged.

function asChild(t: TestContext, child: boolean) {
	const previous = process.env.GENTLE_PI_AGENTS_CHILD;
	if (child) process.env.GENTLE_PI_AGENTS_CHILD = "1";
	else delete process.env.GENTLE_PI_AGENTS_CHILD;
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
		else process.env.GENTLE_PI_AGENTS_CHILD = previous;
	});
}

function recorder() {
	const events: string[] = [];
	const commands: string[] = [];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		on: (name: string, handler: (...args: any[]) => unknown) => { events.push(name); handlers.set(name, handler); },
		registerCommand: (name: string) => { commands.push(name); },
		registerShortcut: (name: string) => { commands.push(`shortcut:${String(name)}`); },
		getCommands: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	return { pi, events, commands, handlers };
}

const usage = { input: 7, output: 20, cacheRead: 3, cacheWrite: 2, totalTokens: 32 };

test("S1: a child session registers no gentle-tps hooks", (t) => {
	asChild(t, true);
	const r = recorder();
	gentleTps(r.pi);
	assert.deepEqual(r.events, []);
});

test("S1: a child session registers no gentle-music command or hook", (t) => {
	asChild(t, true);
	const r = recorder();
	gentleMusic(r.pi);
	assert.deepEqual([r.events, r.commands], [[], []]);
});

test("S1: a child session registers no star-prompt hooks", (t) => {
	asChild(t, true);
	const r = recorder();
	createStarPromptExtension(r.pi, { configHome: "/nonexistent-star-prompt-home" });
	assert.deepEqual(r.events, []);
});

test("S1: a child session registers no startup-banner commands or hooks", (t) => {
	asChild(t, true);
	const r = recorder();
	startupBanner(r.pi);
	assert.deepEqual([r.events, r.commands], [[], []]);
});

test("S3: a child session's rpc input is neither counted nor persisted by the star prompt", (t) => {
	asChild(t, true);
	const r = recorder();
	const writes: StarPromptState[] = [];
	createStarPromptExtension(r.pi, {
		configHome: "/nonexistent-star-prompt-home",
		readState: () => ({ state: { ...DEFAULT_STAR_PROMPT_STATE }, unusable: false }),
		writeState: (_home, state) => { writes.push(state); },
	});
	r.handlers.get("session_start")?.({}, {});
	r.handlers.get("input")?.({ source: "rpc", text: "delegated task" }, {});
	assert.deepEqual(writes, []);
});

test("S4: a parent session still gets the gentle-tps notification", (t) => {
	asChild(t, false);
	let now = 0;
	t.mock.method(Date, "now", () => now);
	const r = recorder();
	gentleTps(r.pi);
	assert.deepEqual(r.events, ["agent_start", "agent_end"]);
	const notes: string[] = [];
	r.handlers.get("agent_start")!({}, {});
	now = 1000;
	r.handlers.get("agent_end")!({ messages: [{ role: "assistant", content: [], usage }] }, { hasUI: true, ui: { notify: (m: string) => notes.push(m) } });
	assert.equal(notes.length, 1);
	assert.match(notes[0], /^TPS 20\.0 tok\/s\./);
});

test("S4: a parent session still gets /gentle:music and its shutdown hook", (t) => {
	asChild(t, false);
	const r = recorder();
	gentleMusic(r.pi);
	assert.deepEqual(r.commands, ["gentle:music"]);
	assert.deepEqual(r.events, ["session_shutdown"]);
});

test("S4: a parent session's star prompt still counts and persists interactive input", (t) => {
	asChild(t, false);
	const r = recorder();
	const writes: StarPromptState[] = [];
	createStarPromptExtension(r.pi, {
		configHome: "/nonexistent-star-prompt-home",
		readState: () => ({ state: { ...DEFAULT_STAR_PROMPT_STATE }, unusable: false }),
		writeState: (_home, state) => { writes.push(state); },
	});
	assert.deepEqual(r.events, ["session_start", "session_shutdown", "input", "agent_start", "agent_end"]);
	r.handlers.get("session_start")?.({}, {});
	r.handlers.get("input")?.({ source: "interactive", text: "hi" }, {});
	assert.deepEqual(writes.map((state) => state.sent), [1]);
});

test("S4: a parent session still gets the startup-banner commands and hooks", (t) => {
	asChild(t, false);
	const r = recorder();
	startupBanner(r.pi);
	assert.deepEqual(r.commands, ["gentle:banner", "gentle:toggle-rose", "gentle:toggle-text-logo", "gentle:banner-color"]);
	assert.deepEqual([...new Set(r.events)].sort(), ["session_shutdown", "session_start"]);
});
