import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDesktopFeedExtension, type DesktopFeedOptions } from "../extensions/gentle-desktop-feed.ts";
import { createDesktopFeedScheduler, type DesktopFeedSnapshot, type DesktopFeedTimers } from "../lib/desktop-feed.ts";
import { createDesktopFeedStore, desktopFeedFile } from "../lib/desktop-feed-store.ts";
import { createUntrackedLineCounter } from "../lib/desktop-feed-sources.ts";
import { createSessionStatsFold } from "../lib/desktop-feed-stats.ts";
import { SESSION_WORKTREE_ENTRY } from "../lib/session-worktree-registry.ts";
import { collectSessionStats } from "../lib/shell-stats.ts";

// S13 (odd/tasks/herdr-desktop.md): the publisher's latency and resource use.
// Urgent state (questions, permission mode, idle/working/blocked, held prompts)
// is published within 50 ms; everything else coalesces to one write per second
// while the session is busy; a quiet session writes nothing; every flush stays
// cheap on pi's event loop.

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const GENTLE_ENV = { PI_PROGRAM_STATUS_APP: "gentle-shell", HERDR_ENV: "1", HERDR_PANE_ID: "t7" };
const START = Date.UTC(2026, 10, 15, 12, 0, 0);

/** Timers that honour their delay on a virtual clock. */
function virtualClock() {
	let now = START;
	let next = 0;
	const pending = new Map<number, { due: number; fn: () => void }>();
	const timers: DesktopFeedTimers = {
		set(fn, ms) { next += 1; pending.set(next, { due: now + Math.max(0, ms), fn }); return next; },
		clear(handle) { pending.delete(handle as number); },
	};
	const advance = (ms: number) => {
		const target = now + ms;
		for (;;) {
			let id: number | undefined;
			let due = Infinity;
			for (const [key, timer] of pending) if (timer.due <= target && timer.due < due) { id = key; due = timer.due; }
			if (id === undefined) break;
			const timer = pending.get(id)!;
			pending.delete(id);
			now = timer.due;
			timer.fn();
		}
		now = target;
	};
	return { timers, now: () => now, advance, get armed() { return pending.size; } };
}

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	let commandCalls = 0;
	const pi = {
		on(name: string, fn: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
		events: {
			on(name: string, fn: (data: unknown) => void) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => { set.delete(fn); }; },
			emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
		},
		registerCommand() {},
		getThinkingLevel: () => "high",
		getCommands: () => { commandCalls += 1; return [{ name: "gentle:changes", description: "Open the changes panel", source: "extension" }]; },
	} as unknown as ExtensionAPI;
	const fire = (name: string, event: unknown, ctx: unknown) => { for (const fn of handlers.get(name) ?? []) fn(event, ctx); };
	return { pi, fire, emit: (name: string, data: unknown) => (pi.events as any).emit(name, data), get commandCalls() { return commandCalls; } };
}

const assistant = (i: number) => ({ type: "message", timestamp: new Date(START - 3_600_000 + i * 100).toISOString(), message: { role: "assistant", model: i % 3 ? "anthropic/claude-opus-5-5" : "anthropic/claude-haiku-5-5", usage: { input: 10, output: 5, cacheRead: 3, cost: { total: 0.01 } } } });
const toolResult = (i: number) => ({ type: "message", timestamp: new Date(START - 3_600_000 + i * 100).toISOString(), message: { role: "toolResult", isError: i % 7 === 0 } });

/** A pi-like session manager: getEntries() copies, getEntryCount() does not. */
function fakeCtx(cwd: string, size: number, root?: string) {
	const entries: unknown[] = [];
	if (root) entries.push({ type: "custom", customType: SESSION_WORKTREE_ENTRY, data: { sessionId: "sess-1", root } });
	for (let i = entries.length; i < size; i++) entries.push(i % 2 ? toolResult(i) : assistant(i));
	let idle = true;
	return {
		cwd, mode: "tui", hasUI: true,
		isIdle: () => idle,
		setIdle(value: boolean) { idle = value; },
		model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true, contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
		ui: {},
		entries,
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => "/agent/sessions/--w--/2026_sess-1.jsonl",
			getSessionName: () => undefined,
			getCwd: () => cwd,
			getBranch: () => [...entries],
			getEntries: () => [...entries],
			getEntryCount: () => entries.length,
		},
	};
}

/** A Git repository with `files` modified files (200 in the S13 measurement). */
function gitWith(root: string, files: number) {
	const numstat = Array.from({ length: files }, (_, i) => `3\t1\tsrc/file-${i}.ts\n`).join("");
	const porcelain = Array.from({ length: files }, (_, i) => ` M src/file-${i}.ts\0`).join("");
	return () => async (args: string[]) => {
		const cmd = args.join(" ");
		if (cmd.startsWith("worktree list")) return { stdout: `worktree ${root}\0branch refs/heads/feat/x\0\0`, code: 0 };
		if (cmd.startsWith("symbolic-ref")) return { stdout: "feat/x\n", code: 0 };
		if (cmd.startsWith("rev-parse")) return { stdout: "abc\n", code: 0 };
		if (cmd.startsWith("diff --numstat")) return { stdout: numstat, code: 0 };
		if (cmd.startsWith("status")) return { stdout: porcelain, code: 0 };
		return { stdout: "", code: 1 };
	};
}

function harness(t: test.TestContext, options: { entries?: number; files?: number; extra?: Partial<DesktopFeedOptions> } = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "desktop-feed-perf-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const root = join(agentDir, "repo");
	const clock = virtualClock();
	const pi = fakePi();
	const writes: Array<{ at: number; value: DesktopFeedSnapshot }> = [];
	const files = options.files ?? 0;
	createDesktopFeedExtension({
		env: GENTLE_ENV,
		agentDir,
		now: clock.now,
		timers: clock.timers,
		activityClock: clock.now,
		git: files > 0 ? gitWith(root, files) : () => async () => ({ stdout: "", code: 128 }),
		rootExists: () => true,
		parentOf: async () => undefined,
		profile: () => ({ name: "work (session)", tier: "fast" }),
		realpath: (path) => path,
		sweep: () => {},
		actionWatch: () => () => {},
		store: (dir, sessionId) => {
			const real = createDesktopFeedStore(dir, sessionId);
			return { path: real.path, write(value) { writes.push({ at: clock.now(), value: value as DesktopFeedSnapshot }); return real.write(value); }, remove() { real.remove(); } };
		},
		...options.extra,
	})(pi.pi);
	const ctx = fakeCtx(files > 0 ? root : "/w", options.entries ?? 1, files > 0 ? root : undefined);
	const file = desktopFeedFile(agentDir, "sess-1");
	return {
		fire: pi.fire, emit: pi.emit, pi: pi.pi, ctx, clock, writes, file,
		get commandCalls() { return pi.commandCalls; },
		read: () => JSON.parse(readFileSync(file, "utf8")) as DesktopFeedSnapshot,
		/** session_start, owner discovery, the first scan: then a quiet, published session. */
		async start() {
			pi.fire("session_start", { reason: "startup" }, ctx);
			for (let i = 0; i < 3; i++) { await settle(); clock.advance(20_000); }
		},
		/** The agent starts a run that keeps working. */
		work() { ctx.setIdle(false); pi.fire("agent_start", {}, ctx); },
	};
}

// ---- Two-tier scheduler (pure) ----

test("S13: an urgent change flushes within 50 ms even while a slow write is pending", () => {
	const clock = virtualClock();
	const flushes: number[] = [];
	const scheduler = createDesktopFeedScheduler(() => { flushes.push(clock.now()); }, clock.timers, { now: clock.now, busy: () => true });
	scheduler.schedule(true);
	clock.advance(50);
	assert.equal(flushes.length, 1);
	assert.ok(flushes[0]! - START <= 50, `urgent write after ${flushes[0]! - START} ms`);
	scheduler.schedule();
	clock.advance(100);
	assert.equal(flushes.length, 1, "a routine change waits for the busy interval");
	scheduler.schedule(true);
	clock.advance(50);
	assert.equal(flushes.length, 2, "an urgent change overtakes the pending routine write");
	assert.equal(clock.armed, 0, "the routine write rode along with the urgent one");
});

test("S13: routine changes coalesce to at most one write per second while busy, a quarter second when idle", () => {
	const clock = virtualClock();
	const flushes: number[] = [];
	let busy = true;
	const scheduler = createDesktopFeedScheduler(() => { flushes.push(clock.now()); }, clock.timers, { now: clock.now, busy: () => busy });
	for (let i = 0; i < 100; i++) { scheduler.schedule(); clock.advance(100); }
	clock.advance(1000);
	assert.ok(flushes.length <= 11, `${flushes.length} writes in 10 s`);
	for (let i = 1; i < flushes.length; i++) assert.ok(flushes[i]! - flushes[i - 1]! >= 1000, "one second apart");
	busy = false;
	const before = flushes.length;
	clock.advance(5000);
	scheduler.schedule();
	clock.advance(250);
	assert.equal(flushes.length, before + 1, "idle routine changes keep the 250 ms debounce");
	clock.advance(60_000);
	assert.equal(flushes.length, before + 1, "nothing is armed while nothing changes");
	assert.equal(clock.armed, 0);
});

// ---- Extension: urgent tier ----

test("S13: questions, permission mode, activity transitions and blockers publish within 50 ms while working", async (t) => {
	const h = harness(t);
	await h.start();
	h.work();
	h.clock.advance(50);
	assert.equal(h.read().activity.state, "working", "idle → working within 50 ms");
	// A routine change arms the slow tier: the question must not wait for it.
	h.fire("message_start", { message: { role: "assistant" } }, h.ctx);
	h.clock.advance(10);
	h.fire("tool_execution_start", { toolCallId: "call-1", toolName: "ask_user_choice", args: { question: "Which?", options: [{ label: "A" }, { label: "B" }] } }, h.ctx);
	h.clock.advance(50);
	assert.equal(h.read().pendingQuestion?.toolCallId, "call-1", "an open question is published within 50 ms");
	h.fire("tool_execution_end", { toolCallId: "call-1", toolName: "ask_user_choice", isError: false, result: {} }, h.ctx);
	h.clock.advance(50);
	assert.equal(h.read().pendingQuestion, null, "an answered question clears within 50 ms");
	h.emit("herdr:blocked", { active: true, label: "Review authorization awaiting input" });
	h.clock.advance(50);
	assert.equal(h.read().activity.state, "blocked", "working → blocked within 50 ms");
	h.emit("herdr:blocked", { active: false });
	h.clock.advance(50);
	assert.equal(h.read().activity.state, "working", "blocked → working within 50 ms");
	h.ctx.setIdle(true);
	h.fire("agent_settled", {}, h.ctx);
	h.clock.advance(50);
	assert.equal(h.read().activity.state, "idle", "working → idle within 50 ms");
});

test("S13: a permission mode change publishes within 50 ms", async (t) => {
	let observer: (() => void) | undefined;
	let mode = "normal";
	const adapter = {
		read: async () => (mode === "normal" ? "OFF" : "ON"),
		readSnapshot: async () => ({ yolo: mode === "normal" ? "OFF" : "ON", mode, defaultMode: "normal" }),
		toggle: async () => {},
		observe: (fn: () => void) => { observer = fn; return () => {}; },
		dispose: () => {},
	};
	const h = harness(t);
	// The permission owner answers discovery on the bus, as gentle-shell's does.
	(h.pi.events as any).on("gentle:yolo:host-ui", (request: any) => { request.respond(adapter); });
	await h.start();
	assert.equal(h.read().permission?.mode, "normal");
	assert.ok(observer, "the feed observes the permission owner");
	h.work();
	h.fire("message_start", { message: { role: "assistant" } }, h.ctx);
	h.clock.advance(60);
	mode = "yolo";
	observer!();
	await settle();
	h.clock.advance(50);
	assert.equal(h.read().permission?.mode, "yolo");
});

// ---- Extension: routine tier ----

test("S13: a burst of 100 tool events in 10 s writes at most once per second", async (t) => {
	const h = harness(t);
	await h.start();
	h.work();
	h.clock.advance(50);
	const before = h.writes.length;
	for (let i = 0; i < 100; i++) {
		h.ctx.entries.push(i % 2 ? toolResult(i) : assistant(i));
		h.fire(i % 2 ? "tool_execution_end" : "tool_execution_start", { toolCallId: `c${i >> 1}`, toolName: "read", args: {}, isError: false, result: {} }, h.ctx);
		h.clock.advance(100);
	}
	h.clock.advance(1000);
	const writes = h.writes.slice(before);
	t.diagnostic(`S13 burst: ${writes.length} writes for 100 tool events in 10 s (${writes.length * 6}/min)`);
	assert.ok(writes.length <= 11, `${writes.length} writes`);
	for (let i = 1; i < writes.length; i++) assert.ok(writes[i]!.at - writes[i - 1]!.at >= 1000, "routine writes are a second apart");
	assert.equal(h.read().stats.toolCalls, collectSessionStats(h.ctx.entries).toolCalls, "the last write carries the final stats");
});

test("S13: a quiet session writes nothing, and a change of time alone is no change", async (t) => {
	const h = harness(t);
	await h.start();
	const before = h.writes.length;
	h.clock.advance(60_000);
	assert.equal(h.writes.length, before, "no write in a quiet minute");
	for (let i = 0; i < 5; i++) { h.fire("message_end", { message: { role: "user" } }, h.ctx); h.clock.advance(5_000); }
	assert.equal(h.writes.length, before, "updatedAt alone never causes a write");
	assert.equal(h.clock.armed, 0, "nothing stays armed");
});

// ---- Caches ----

test("S13: pi's command registry is read once per session start, not per flush", async (t) => {
	const h = harness(t);
	await h.start();
	const calls = h.commandCalls;
	assert.ok(calls >= 1);
	h.work();
	for (let i = 0; i < 20; i++) { h.ctx.entries.push(assistant(i)); h.fire("message_end", { message: { role: "assistant" } }, h.ctx); h.clock.advance(1100); }
	assert.ok(h.writes.length > 5);
	assert.equal(h.commandCalls, calls, "no registry read per flush");
	assert.equal(h.read().commands.items.some((item) => item.name === "gentle:changes"), true);
	h.fire("resources_discover", { type: "resources_discover", cwd: "/w", reason: "reload" }, h.ctx);
	h.clock.advance(1100);
	assert.equal(h.commandCalls, calls + 1, "rediscovered resources refresh the registry");
	h.fire("session_start", { reason: "reload" }, h.ctx);
	await settle();
	h.clock.advance(1100);
	assert.ok(h.commandCalls > calls + 1, "a session start reads it again");
});

test("S13: session stats fold new entries instead of re-walking the session", () => {
	let reads = 0;
	const counted = (entry: Record<string, unknown>) => new Proxy(entry, { get(target, key, receiver) { if (key === "type") reads += 1; return Reflect.get(target, key, receiver); } });
	const entries: unknown[] = Array.from({ length: 1000 }, (_, i) => counted(i % 2 ? toolResult(i) : assistant(i)));
	const fold = createSessionStatsFold();
	assert.deepEqual(fold.update(entries), collectSessionStats(entries));
	reads = 0;
	entries.push(counted(assistant(1000)), counted(toolResult(1001)));
	const folded = fold.update([...entries]);
	assert.ok(reads <= 4, `${reads} entries read for 2 new ones`);
	assert.deepEqual(folded, collectSessionStats(entries));
	// A different history (a new or switched session) starts over.
	const other = [assistant(1), toolResult(2)];
	assert.deepEqual(fold.update(other), collectSessionStats(other));
	assert.deepEqual(fold.update([]), collectSessionStats([]));
});

test("S13: untracked line counts are cached by path, size and mtime", async () => {
	const files = new Map<string, { size: number; mtimeMs: number; text: string }>([["/r/a.txt", { size: 4, mtimeMs: 1, text: "1\n2\n" }]]);
	let readsOf = 0;
	const io = {
		lstat: async (path: string) => { const file = files.get(path); if (!file) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return { isFile: () => true, size: file.size, mtimeMs: file.mtimeMs }; },
		readFile: async (path: string) => { readsOf += 1; return Buffer.from(files.get(path)!.text); },
	};
	const counter = createUntrackedLineCounter(undefined, io);
	assert.equal(await counter.forRoot("/r")("a.txt"), 2);
	assert.equal(await counter.forRoot("/r")("a.txt"), 2);
	assert.equal(readsOf, 1, "an unchanged file is not read again");
	files.set("/r/a.txt", { size: 6, mtimeMs: 2, text: "1\n2\n3\n" });
	assert.equal(await counter.forRoot("/r")("a.txt"), 3);
	assert.equal(readsOf, 2, "a changed file is read again");
	files.set("/r/a.txt", { size: 6, mtimeMs: 3, text: "1\0\n3\n" });
	assert.equal(await counter.forRoot("/r")("a.txt"), 0);
	assert.ok(counter.uncounted().has("/r/a.txt"));
	assert.equal(await counter.forRoot("/r")("a.txt"), 0, "a cached skip stays a skip");
	assert.ok(counter.uncounted().has("/r/a.txt"));
	assert.equal(readsOf, 3);
});

// ---- Flush cost ----

test("S13: a flush on a 5,000-entry session with 200 changed files stays under 15 ms", async (t) => {
	const h = harness(t, { entries: 5000, files: 200 });
	await h.start();
	assert.equal(h.read().changes?.files.length, 200);
	assert.equal(h.read().stats.turns, collectSessionStats(h.ctx.entries).turns);
	h.work();
	h.clock.advance(50);
	const times: number[] = [];
	for (let i = 0; i < 40; i++) {
		h.ctx.entries.push(i % 2 ? toolResult(5000 + i) : assistant(5000 + i));
		h.fire("message_end", { message: { role: "assistant" } }, h.ctx);
		const started = performance.now();
		h.clock.advance(1000);
		times.push(performance.now() - started);
	}
	times.sort((a, b) => a - b);
	const median = times[times.length >> 1]!;
	const worst = times[times.length - 1]!;
	t.diagnostic(`S13 flush: median ${median.toFixed(2)} ms, p95 ${times[Math.floor(times.length * 0.95)]!.toFixed(2)} ms, max ${worst.toFixed(2)} ms over ${times.length} flushes`);
	assert.equal(h.read().stats.turns, collectSessionStats(h.ctx.entries).turns, "incremental stats match a full walk");
	assert.ok(median < 15, `median flush ${median.toFixed(2)} ms`);
});
