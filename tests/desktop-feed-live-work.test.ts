import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDesktopFeedExtension } from "../extensions/gentle-desktop-feed.ts";
import { buildDesktopFeedSnapshot, type DesktopFeedInput, type DesktopFeedSnapshot, type DesktopFeedTimers } from "../lib/desktop-feed.ts";
import { createDesktopFeedStore, desktopFeedFile } from "../lib/desktop-feed-store.ts";
import { DESKTOP_AGENTS_SERVICE_CHANNEL, DESKTOP_AGENTS_SERVICE_SCHEMA, type DesktopAgentEntry } from "../lib/desktop-rpc-agents.ts";
import { DESKTOP_JOBS_SERVICE_CHANNEL, DESKTOP_JOBS_SERVICE_SCHEMA, type DesktopJobEntry } from "../lib/desktop-rpc-jobs.ts";

// S15 (odd/tasks/herdr-desktop.md, xabilarra's report): a session whose turn ended while its
// background subagents or jobs still run is never "idle". The snapshot says how much live work
// the session has (the same running count the header's Agents shows) and the words every
// desktop region shows: "Working · 2 agents" while the turn runs, "Waiting on 2 agents" after
// it. Background subagents are the agents owner's, not the jobs registry's: "Jobs 0 running"
// was right about jobs, and the status bar now counts both.

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const GENTLE_ENV = { PI_PROGRAM_STATUS_APP: "gentle-shell" };

const agent = (id: string, status: DesktopAgentEntry["status"]): DesktopAgentEntry => ({
	id, agent: "gentle-writer", status, model: "sonnet",
	lastStep: status === "running" ? "writing" : status === "completed" ? "completed" : status === "queued" ? "queued" : status === "waiting" ? "waiting" : "failed",
	usage: { total: 10, cost: 0.01 },
});
const job = (id: string, status: DesktopJobEntry["status"]): DesktopJobEntry => ({ id, label: `job ${id}`, status, startedAt: NOW - 1000, ...(status === "running" ? {} : { endedAt: NOW, exitCode: 0 }) });

function input(overrides: Partial<DesktopFeedInput> = {}): DesktopFeedInput {
	return {
		now: NOW,
		identity: { sessionId: "s", sessionFile: undefined, sessionName: undefined, cwd: "/w", realCwd: undefined, pid: 1, ppid: 1, ancestors: [], mode: "tui", agentDir: "/agent", env: {} },
		branch: null, model: undefined, thinkingLevel: undefined, subscription: false,
		profile: { name: undefined, tier: undefined }, context: undefined, usage: undefined, permission: undefined,
		todo: { tasks: [], nextId: 1, updatedTurn: null }, changes: undefined, agents: [], jobs: [], review: undefined,
		stats: { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, toolCalls: 0, toolErrors: 0, spanMs: 0, cacheHitRate: null, models: [] },
		activity: { working: false, blocked: 0, blockedLabel: undefined, streaming: false, phase: undefined },
		pendingQuestion: undefined,
		...overrides,
	};
}
const working = { working: true, blocked: 0, blockedLabel: undefined, streaming: false, phase: undefined } as const;

// ---- The snapshot (pure) ----

test("S15: a working turn with two running subagents says Working · 2 agents", () => {
	const snapshot = buildDesktopFeedSnapshot(input({ activity: working, agents: [agent("a1", "running"), agent("a2", "running"), agent("a3", "completed")] }));
	assert.deepEqual(snapshot.activity, { state: "working", streaming: false, phase: null, phaseLabel: null, blockedLabel: null, agents: 2, jobs: 0, label: "Working · 2 agents" });
	assert.equal(snapshot.agents?.active, snapshot.activity.agents, "the header's Agents count and the activity's are one number");
});

test("S15: a turn that ended while subagents run is waiting on them, never idle", () => {
	const two = buildDesktopFeedSnapshot(input({ agents: [agent("a1", "running"), agent("a2", "queued")] }));
	assert.equal(two.activity.state, "waiting");
	assert.equal(two.activity.label, "Waiting on 2 agents");
	assert.equal(two.activity.agents, 2);
	const one = buildDesktopFeedSnapshot(input({ agents: [agent("a1", "waiting"), agent("a2", "failed")] }));
	assert.equal(one.activity.label, "Waiting on 1 agent");
	assert.equal(one.agents?.active, 1);
});

test("S15: background jobs count as live work too, alone and with agents", () => {
	const jobs = buildDesktopFeedSnapshot(input({ jobs: [job("j1", "running"), job("j2", "exited")] }));
	assert.deepEqual([jobs.activity.state, jobs.activity.label, jobs.activity.jobs], ["waiting", "Waiting on 1 job", 1]);
	assert.equal(jobs.jobs?.running.length, jobs.activity.jobs, "the status bar's Jobs running and the activity's are one number");
	const both = buildDesktopFeedSnapshot(input({ agents: [agent("a1", "running"), agent("a2", "running")], jobs: [job("j1", "running"), job("j2", "running"), job("j3", "running")] }));
	assert.equal(both.activity.label, "Waiting on 2 agents · 3 jobs");
	const busy = buildDesktopFeedSnapshot(input({ activity: working, jobs: [job("j1", "running")] }));
	assert.equal(busy.activity.label, "Working · 1 job");
});

test("S15: plain working, blocked and idle keep their state; the label names them", () => {
	assert.deepEqual(buildDesktopFeedSnapshot(input({ activity: working })).activity, { state: "working", streaming: false, phase: null, phaseLabel: null, blockedLabel: null, agents: 0, jobs: 0, label: "Working" });
	const idle = buildDesktopFeedSnapshot(input({ agents: [agent("a1", "completed")], jobs: [job("j1", "exited")] }));
	assert.deepEqual([idle.activity.state, idle.activity.label, idle.activity.agents, idle.activity.jobs], ["idle", "Idle", 0, 0]);
	const blocked = buildDesktopFeedSnapshot(input({ activity: { ...working, blocked: 1, blockedLabel: "Choice awaiting input" }, agents: [agent("a1", "running")] }));
	assert.deepEqual([blocked.activity.state, blocked.activity.label, blocked.activity.agents], ["blocked", "Choice awaiting input", 1], "a blocker wins over live work");
	const unknown = buildDesktopFeedSnapshot(input({ agents: undefined, jobs: undefined }));
	assert.deepEqual([unknown.activity.state, unknown.activity.agents, unknown.activity.jobs], ["idle", 0, 0], "an owner that never answered counts no work");
});

// ---- The extension: owners, urgency ----

function virtualClock() {
	let now = NOW;
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
	return { timers, now: () => now, advance };
}

function harness(t: test.TestContext) {
	const agentDir = mkdtempSync(join(tmpdir(), "desktop-feed-live-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const pi = {
		on(name: string, fn: (event: unknown, ctx: unknown) => void) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
		events: {
			on(name: string, fn: (data: unknown) => void) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => { set.delete(fn); }; },
			emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
		},
		registerCommand() {},
		getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	const fire = (name: string, event: unknown, ctx: unknown) => { for (const fn of handlers.get(name) ?? []) fn(event, ctx); };
	// The agents and jobs owners answer discovery on the bus, as gentle-agents does.
	const owners = { agents: [] as DesktopAgentEntry[], jobs: [] as DesktopJobEntry[], agentObservers: new Set<(id: string) => void>(), jobObservers: new Set<(id: string) => void>() };
	pi.events.on(DESKTOP_AGENTS_SERVICE_CHANNEL, (payload) => (payload as { respond(service: unknown): void }).respond({
		schema: DESKTOP_AGENTS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "sess-1", agents: owners.agents }),
		cancel: () => ({ kind: "not_found" }),
		observe: (fn: (id: string) => void) => { owners.agentObservers.add(fn); return () => owners.agentObservers.delete(fn); },
		dispose: () => {},
	}));
	pi.events.on(DESKTOP_JOBS_SERVICE_CHANNEL, (payload) => (payload as { respond(service: unknown): void }).respond({
		schema: DESKTOP_JOBS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "sess-1", jobs: owners.jobs }),
		cancel: () => ({ kind: "not_found" }),
		observe: (fn: (id: string) => void) => { owners.jobObservers.add(fn); return () => owners.jobObservers.delete(fn); },
		dispose: () => {},
	}));
	const clock = virtualClock();
	const writes: Array<{ at: number; value: DesktopFeedSnapshot }> = [];
	createDesktopFeedExtension({
		env: GENTLE_ENV, agentDir, now: clock.now, timers: clock.timers, activityClock: clock.now,
		git: () => async () => ({ stdout: "", code: 128 }), rootExists: () => true, parentOf: async () => undefined,
		profile: () => ({ name: undefined, tier: undefined }), realpath: (path) => path, sweep: () => {}, actionWatch: () => () => {},
		store: (dir, sessionId) => {
			const real = createDesktopFeedStore(dir, sessionId);
			return { path: real.path, write(value) { writes.push({ at: clock.now(), value: value as DesktopFeedSnapshot }); return real.write(value); }, remove() { real.remove(); } };
		},
	})(pi);
	let idle = true;
	const ctx = {
		cwd: "/w", mode: "tui", hasUI: true, isIdle: () => idle, ui: {},
		model: { id: "m", provider: "p", reasoning: false, contextWindow: 1000 },
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => undefined,
		sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => undefined, getSessionName: () => undefined, getCwd: () => "/w", getBranch: () => [], getEntries: () => [], getEntryCount: () => 0 },
	};
	const file = desktopFeedFile(agentDir, "sess-1");
	return {
		owners, clock, writes, ctx, fire,
		read: () => JSON.parse(readFileSync(file, "utf8")) as DesktopFeedSnapshot,
		async start() { fire("session_start", { reason: "startup" }, ctx); for (let i = 0; i < 3; i++) { await settle(); clock.advance(20_000); } },
		work() { idle = false; fire("agent_start", {}, ctx); },
		settleTurn() { idle = true; fire("agent_settled", {}, ctx); },
		/** An owner transition: the bridges coalesce on real timers before they emit. */
		async changeAgents(list: DesktopAgentEntry[]) { owners.agents = list; for (const fn of owners.agentObservers) fn("sess-1"); await settle(); },
		async changeJobs(list: DesktopJobEntry[]) { owners.jobs = list; for (const fn of owners.jobObservers) fn("sess-1"); await settle(); },
	};
}

test("S15: background subagents keep a settled session waiting; working → waiting → idle publish within 50 ms", async (t) => {
	const h = harness(t);
	await h.start();
	assert.equal(h.read().activity.state, "idle");
	h.work();
	await h.changeAgents([agent("a1", "running"), agent("a2", "running")]);
	h.clock.advance(1100);
	assert.equal(h.read().activity.label, "Working · 2 agents");
	assert.equal(h.read().agents?.active, 2);
	// The turn ends, the subagents keep running: a state transition, so the urgent tier.
	h.settleTurn();
	h.clock.advance(50);
	assert.equal(h.read().activity.state, "waiting", "working → waiting within 50 ms, not after the busy interval");
	assert.equal(h.read().activity.label, "Waiting on 2 agents");
	await h.changeAgents([agent("a1", "completed"), agent("a2", "running")]);
	h.clock.advance(1100);
	assert.equal(h.read().activity.label, "Waiting on 1 agent");
	await h.changeAgents([agent("a1", "completed"), agent("a2", "completed")]);
	const before = h.writes.length;
	h.clock.advance(50);
	assert.equal(h.read().activity.state, "idle", "waiting → idle within 50 ms");
	assert.equal(h.writes.length, before + 1);
	assert.equal(h.read().activity.label, "Idle");
});

test("S15: a background job alone keeps the session waiting, and its end publishes at once", async (t) => {
	const h = harness(t);
	await h.start();
	await h.changeJobs([job("j1", "running")]);
	h.clock.advance(50);
	assert.deepEqual([h.read().activity.state, h.read().activity.label, h.read().jobs?.running.length], ["waiting", "Waiting on 1 job", 1]);
	await h.changeJobs([job("j1", "exited")]);
	h.clock.advance(50);
	assert.equal(h.read().activity.state, "idle");
	assert.equal(h.read().activity.jobs, 0);
});
