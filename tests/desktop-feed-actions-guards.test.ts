import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDesktopFeedExtension, type DesktopFeedOptions } from "../extensions/gentle-desktop-feed.ts";
import {
	answerKeys,
	createDesktopActionInbox,
	createDesktopActivityTimeline,
	DESKTOP_ACTION_SCHEMA,
	desktopActionInboxDir,
	desktopActionOutboxDir,
	providerDecisionIn,
	questionShape,
	sweepDesktopActionOrphans,
	type DesktopActionOwners,
} from "../lib/desktop-feed-actions.ts";
import type { DesktopFeedSnapshot, DesktopFeedTimers } from "../lib/desktop-feed.ts";
import { desktopFeedFile } from "../lib/desktop-feed-store.ts";
import { DESKTOP_AGENTS_SERVICE_CHANNEL, DESKTOP_AGENTS_SERVICE_SCHEMA } from "../lib/desktop-rpc-agents.ts";
import { DESKTOP_JOBS_SERVICE_CHANNEL, DESKTOP_JOBS_SERVICE_SCHEMA } from "../lib/desktop-rpc-jobs.ts";
import { NativeChoiceList } from "../lib/native-choice-list.ts";
import { QuestionnaireView, type QuestionnaireResult } from "../lib/questionnaire/questionnaire-view.ts";

// T7 verifier findings (odd/tasks/herdr-desktop.md L15): the inbox refuses
// what is not a private regular file and never reprocesses it, the outbox never
// writes through a link, the sweep never removes a live session's folders, a
// permission escalation dropped while the agent (or its jobs and subagents)
// can act is refused, and a relayed provider consent is answered only in the
// terminal.

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
const GENTLE_ENV = { PI_PROGRAM_STATUS_APP: "gentle-shell", HERDR_ENV: "1", HERDR_PANE_ID: "t7" };
const DEAD_PID = 99_999_999;

function fakeTimers() {
	const pending = new Map<number, () => void>();
	let next = 0;
	const timers: DesktopFeedTimers = {
		set(fn) { next += 1; pending.set(next, fn); return next; },
		clear(handle) { pending.delete(handle as number); },
	};
	return { timers, run() { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn(); } };
}

const actionText = (id: string, kind: string, args: Record<string, unknown>, sessionId = "sess-1") =>
	JSON.stringify({ schema: DESKTOP_ACTION_SCHEMA, id, sessionId, kind, args, createdAt: new Date(NOW - 1000).toISOString() });

// ---- The inbox alone, with recording owners ----

function inboxHarness(t: test.TestContext, overrides: Partial<DesktopActionOwners> = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "desktop-guards-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const calls: string[] = [];
	const owners: DesktopActionOwners = {
		setPermissionMode: async (mode) => { calls.push(`mode:${mode}`); return { ok: true, data: { mode } }; },
		cancelJob: async (id) => { calls.push(`job:${id}`); return { ok: true, data: { id } }; },
		cancelSubagent: async (id) => { calls.push(`agent:${id}`); return { ok: true, data: { id } }; },
		question: () => undefined,
		working: () => false,
		abortTurn: () => { calls.push("abort"); },
		permissionMode: () => "normal",
		busyAt: () => false,
		...overrides,
	};
	let fire: (() => void) | undefined;
	const clock = fakeTimers();
	const inbox = createDesktopActionInbox({ agentDir, sessionId: "sess-1", owners, now: () => NOW, timers: clock.timers, watch: (_dir, onChange) => { fire = onChange; return () => {}; } });
	return {
		agentDir, calls, inbox,
		get watching() { return fire !== undefined; },
		async deliver() { fire?.(); await settle(); },
		result(id: string) {
			const file = join(inbox.outbox, `${id}.json`);
			return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
		},
	};
}

test("S2: a hard-linked action file is refused, removed from the inbox and never run", async (t) => {
	const h = inboxHarness(t);
	assert.equal(h.inbox.start(), true);
	const outside = join(h.agentDir, "outside.json");
	writeFileSync(outside, actionText("h1", "cancel_job", { id: "j1" }));
	linkSync(outside, join(h.inbox.inbox, "h1.json"));
	await h.deliver();
	assert.deepEqual(h.calls, []);
	assert.equal(h.result("h1").error.code, "unsafe_file");
	assert.deepEqual(readdirSync(h.inbox.inbox).filter((name) => name.endsWith(".json")), []);
	assert.equal(readFileSync(outside, "utf8"), actionText("h1", "cancel_job", { id: "j1" }), "the linked target is untouched");
});

test("S2: a FIFO named like an action is refused without blocking the inbox", { skip: process.platform === "win32" }, async (t) => {
	const h = inboxHarness(t);
	assert.equal(h.inbox.start(), true);
	execFileSync("mkfifo", [join(h.inbox.inbox, "f1.json")]);
	writeFileSync(join(h.inbox.inbox, "f2.json"), actionText("f2", "cancel_job", { id: "j1" }));
	await h.deliver();
	assert.equal(h.result("f1").error.code, "unsafe_file");
	assert.deepEqual(h.calls, ["job:j1"], "the next file still runs");
	assert.deepEqual(readdirSync(h.inbox.inbox).filter((name) => name.endsWith(".json")), []);
});

test("S2: a directory named *.json is removed when empty, otherwise ignored once, and close() removes the folders", async (t) => {
	const h = inboxHarness(t);
	assert.equal(h.inbox.start(), true);
	mkdirSync(join(h.inbox.inbox, "d1.json"));
	mkdirSync(join(h.inbox.inbox, "d2.json"));
	writeFileSync(join(h.inbox.inbox, "d2.json", "inner"), "x");
	await h.deliver();
	assert.equal(existsSync(join(h.inbox.inbox, "d1.json")), false, "an empty directory is removed");
	assert.equal(h.result("d1").error.code, "unsafe_file");
	assert.equal(h.result("d2").error.code, "unsafe_file");
	unlinkSync(join(h.inbox.outbox, "d2.json"));
	await h.deliver();
	await h.deliver();
	assert.equal(h.result("d2"), undefined, "a directory that stays is not reprocessed on every scan");
	assert.deepEqual(h.calls, []);
	h.inbox.close();
	assert.equal(existsSync(h.inbox.inbox), false, "close() removes the inbox even with a directory inside");
	assert.equal(existsSync(h.inbox.outbox), false);
});

test("S2: the outbox never writes through a symlink", async (t) => {
	const h = inboxHarness(t);
	assert.equal(h.inbox.start(), true);
	const outside = join(h.agentDir, "victim.txt");
	writeFileSync(outside, "keep");
	symlinkSync(outside, join(h.inbox.outbox, "o1.json"));
	writeFileSync(join(h.inbox.inbox, "o1.json"), actionText("o1", "cancel_job", { id: "j1" }));
	await h.deliver();
	assert.equal(readFileSync(outside, "utf8"), "keep");
	// The outbox folder itself replaced by a link: nothing lands in its target.
	const elsewhere = join(h.agentDir, "elsewhere");
	mkdirSync(elsewhere);
	rmSync(h.inbox.outbox, { recursive: true, force: true });
	symlinkSync(elsewhere, h.inbox.outbox);
	writeFileSync(join(h.inbox.inbox, "o2.json"), actionText("o2", "cancel_job", { id: "j1" }));
	await h.deliver();
	assert.deepEqual(readdirSync(elsewhere), []);
});

test("S2: a symlinked inbox refuses to start and its target is untouched", async (t) => {
	const h = inboxHarness(t);
	const target = join(h.agentDir, "target");
	mkdirSync(target, { mode: 0o755 });
	mkdirSync(join(h.agentDir, "desktop", "inbox"), { recursive: true, mode: 0o700 });
	symlinkSync(target, h.inbox.inbox);
	writeFileSync(join(target, "s1.json"), actionText("s1", "cancel_job", { id: "j1" }));
	assert.equal(h.inbox.start(), false);
	await h.deliver();
	assert.equal(h.watching, false);
	assert.deepEqual(h.calls, []);
	assert.deepEqual(readdirSync(target), ["s1.json"]);
});

test("S2: the orphan sweep keeps live, young and linked folders and removes a dead session's", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "desktop-guards-sweep-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const old = (Date.now() - 11 * 60_000) / 1000;
	const age = (session: string) => {
		for (const dir of [desktopActionInboxDir(agentDir, session), desktopActionOutboxDir(agentDir, session)]) utimesSync(dir, old, old);
	};
	// A live session, idle for longer than the sweep age and without its snapshot
	// (the snapshot sweep drops a day-old snapshot even while its pid lives).
	const live = createDesktopActionInbox({ agentDir, sessionId: "live", owners: {} as DesktopActionOwners, now: Date.now, timers: fakeTimers().timers, watch: () => () => {} });
	assert.equal(live.start(), true);
	age("live");
	// A session whose recorded pid is gone.
	const dead = createDesktopActionInbox({ agentDir, sessionId: "dead", owners: {} as DesktopActionOwners, now: Date.now, timers: fakeTimers().timers, watch: () => () => {} });
	assert.equal(dead.start(), true);
	writeFileSync(join(dead.inbox, ".owner"), JSON.stringify({ pid: DEAD_PID }));
	age("dead");
	// Young, without any marker.
	for (const dir of [desktopActionInboxDir(agentDir, "young"), desktopActionOutboxDir(agentDir, "young")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Linked: never followed, never removed.
	const target = join(agentDir, "linked-target");
	mkdirSync(target);
	writeFileSync(join(target, "keep.json"), "{}");
	symlinkSync(target, desktopActionInboxDir(agentDir, "linked"));
	sweepDesktopActionOrphans(agentDir, "someone-else");
	assert.ok(existsSync(live.inbox), "a live session's inbox stays");
	assert.ok(existsSync(live.outbox), "a live session's outbox stays");
	assert.equal(existsSync(dead.inbox), false);
	assert.equal(existsSync(dead.outbox), false);
	assert.ok(existsSync(desktopActionInboxDir(agentDir, "young")));
	assert.ok(existsSync(desktopActionInboxDir(agentDir, "linked")));
	assert.deepEqual(readdirSync(target), ["keep.json"]);
});

// ---- The keys reach option i in both real lists ----

const KEY: Record<string, string> = { up: "\x1b[A", down: "\x1b[B", enter: "\r" };

test("S5: answerKeys reach option i from any cursor in NativeChoiceList and the questionnaire view", () => {
	for (const count of [2, 3, 4]) {
		for (const custom of [false, true]) {
			const options = Array.from({ length: count }, (_, i) => ({ label: `Opt${i}`, description: `d${i}`, value: `v${i}` }));
			const shape = questionShape("ask_user_choice", "c1", { question: "Q?", options, allowCustomResponse: custom })!;
			const rows = count + (custom ? 1 : 0);
			for (let i = 0; i < count; i++) {
				for (let start = 0; start < rows; start++) {
					const items = [...options.map((o, k) => ({ id: `i${k}`, label: o.label })), ...(custom ? [{ id: "custom", label: "Other…" }] : [])];
					const list = new NativeChoiceList(items, { selectedPrefix: (s) => s, selectedText: (s) => s, description: (s) => s, hoverBackground: (s) => s });
					list.setSelectedIndex(start);
					let picked: string | undefined;
					list.onSelect = (item) => { picked = item.id; };
					const keys = answerKeys(shape, { option: i });
					assert.ok("keys" in keys);
					for (const key of keys.keys) list.handleInput(KEY[key]!);
					assert.equal(picked, `i${i}`, `choice ${count}${custom ? "+custom" : ""} from ${start} to ${i}`);
				}
			}
		}
	}
	for (const count of [2, 3, 4]) {
		const options = Array.from({ length: count }, (_, i) => ({ label: `Opt${i}`, description: `d${i}` }));
		const shape = questionShape("ask_user_question", "q1", { questions: [{ question: "Q?", header: "H", options }] })!;
		for (let i = 0; i < count; i++) {
			for (let start = 0; start <= count; start++) {
				const done: QuestionnaireResult[] = [];
				const view = new QuestionnaireView({ questions: [{ question: "Q?", header: "H", options }], theme: { fg: (_c, s) => s, bold: (s) => s }, onComplete: (r) => done.push(r) });
				for (let k = 0; k < start; k++) view.handleInput(KEY.down!);
				const keys = answerKeys(shape, { option: i });
				assert.ok("keys" in keys);
				for (const key of keys.keys) view.handleInput(KEY[key]!);
				assert.equal(done.length, 1, `questionnaire ${count} from ${start} to ${i}`);
				assert.equal(done[0]!.answers[0]!.answer, `Opt${i}`);
			}
		}
	}
});

// ---- B1: the activity timeline ----

test("S2: the activity timeline marks busy spans, a 2 s tail, and time before it started", () => {
	let clock = 100_000;
	const timeline = createDesktopActivityTimeline(() => clock);
	assert.equal(timeline.busyAt(99_999), true, "before the session started nothing is known");
	assert.equal(timeline.busyAt(100_000), false);
	clock = 110_000; timeline.set(true);
	clock = 120_000; timeline.set(false);
	clock = 130_000;
	assert.equal(timeline.busyAt(107_999), false);
	assert.equal(timeline.busyAt(108_000), true, "a file time up to 2 s behind the activity clock still reaches the span");
	assert.equal(timeline.busyAt(109_999), true, "a coarse file clock lags: a file stamped just before the span may be written in it");
	assert.equal(timeline.busyAt(110_000), true);
	assert.equal(timeline.busyAt(115_000), true);
	assert.equal(timeline.busyAt(122_000), true, "within 2 s after the activity ended");
	assert.equal(timeline.busyAt(122_001), false);
	clock = 131_000; timeline.set(true);
	assert.equal(timeline.busyAt(140_000), true, "an open span runs until now");
	assert.equal(timeline.busyAt(200_000), true, "a time ahead of the clock is read as now");
});

// ---- B1: escalations through a live session ----

function sessionHarness(t: test.TestContext, options: { mode?: string; job?: string; agent?: string } = {}) {
	const root = mkdtempSync(join(tmpdir(), "desktop-guards-session-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const workspace = join(root, "w");
	mkdirSync(workspace);
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const bus = {
		on(name: string, fn: (data: unknown) => void) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => { set.delete(fn); }; },
		emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
	};
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const pi = {
		on(name: string, fn: (event: any, ctx: any) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
		events: bus, registerCommand() {}, registerTool() {}, getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	const fire = (name: string, event: unknown) => { for (const fn of handlers.get(name) ?? []) fn(event, ctx); };
	// The permission owner: records every change it is asked for.
	let mode = options.mode ?? "normal";
	const setModes: string[] = [];
	const permissionObservers: Array<() => void> = [];
	bus.on("gentle:yolo:host-ui", (payload) => {
		(payload as { respond(adapter: unknown): void }).respond({
			read: async () => (mode === "normal" ? "OFF" : "ON"),
			readSnapshot: async () => ({ yolo: mode === "normal" ? "OFF" : "ON", mode, defaultMode: "normal" }),
			setMode: async (next: string) => { setModes.push(next); mode = next; for (const fn of permissionObservers) fn(); return true; },
			toggle: async () => {},
			observe: (fn: () => void) => { permissionObservers.push(fn); return () => {}; },
			dispose: () => {},
		});
	});
	// One background job and one subagent whose status the test changes.
	const state = { job: options.job ?? "exited", agent: options.agent ?? "completed" };
	let jobsChanged: ((sessionId: string) => void) | undefined;
	let agentsChanged: ((sessionId: string) => void) | undefined;
	bus.on(DESKTOP_JOBS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({
			schema: DESKTOP_JOBS_SERVICE_SCHEMA,
			read: () => ({ sessionId: "sess-1", jobs: [{ id: "j1", label: "npm test", status: state.job, startedAt: 1, ...(state.job === "running" ? {} : { endedAt: Date.now() }) }] }),
			cancel: () => ({ kind: "not_found" }),
			observe: (fn: (sessionId: string) => void) => { jobsChanged = fn; return () => {}; },
			dispose: () => {},
		});
	});
	bus.on(DESKTOP_AGENTS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({
			schema: DESKTOP_AGENTS_SERVICE_SCHEMA,
			read: () => ({ sessionId: "sess-1", agents: [{ id: "a1", agent: "gentle-writer", status: state.agent, model: "sonnet", lastStep: "writing", usage: { total: 1, cost: 0 } }] }),
			cancel: () => ({ kind: "not_found" }),
			observe: (fn: (sessionId: string) => void) => { agentsChanged = fn; return () => {}; },
			dispose: () => {},
		});
	});
	const clock = fakeTimers();
	let offset = 0;
	let fireWatch: (() => void) | undefined;
	let idle = true;
	let aborts = 0;
	const prompts: string[] = [];
	let confirmAnswer = true;
	createDesktopFeedExtension({
		env: GENTLE_ENV,
		agentDir,
		now: () => NOW,
		activityClock: () => Date.now() + offset,
		timers: clock.timers,
		git: () => async () => ({ stdout: "", code: 128 }),
		parentOf: async () => undefined,
		profile: () => ({ name: undefined, tier: undefined }),
		realpath: (path) => path,
		sweep: () => {},
		actionWatch: (_dir, onChange) => { fireWatch = onChange; return () => {}; },
	} satisfies DesktopFeedOptions)(pi);
	const ctx = {
		cwd: workspace, mode: "tui", hasUI: true,
		isIdle: () => idle,
		abort: () => { aborts += 1; },
		model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true, contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => undefined,
		ui: { setWidget() {}, setStatus() {}, notify() {}, select: async () => undefined, getAllThemes: () => [{}], confirm: async (title: string, message: string) => { prompts.push(`${title} ${message}`); return confirmAnswer; } },
		sessionManager: {
			getSessionId: () => "sess-1", getSessionFile: () => "/s.jsonl", getSessionName: () => undefined,
			getCwd: () => workspace, getBranch: () => [], getEntries: () => [], getLeafId: () => null,
		},
	};
	const inbox = desktopActionInboxDir(agentDir, "sess-1");
	const outbox = desktopActionOutboxDir(agentDir, "sess-1");
	let n = 0;
	return {
		fire, setModes, ctx, inbox, outbox, prompts,
		get aborts() { return aborts; },
		set confirmAnswer(value: boolean) { confirmAnswer = value; },
		set idle(value: boolean) { idle = value; },
		set offset(value: number) { offset = value; },
		async start() { fire("session_start", { reason: "startup" }); await settle(); clock.run(); await settle(); clock.run(); },
		async flush() { await settle(); clock.run(); },
		async setJob(status: string) { state.job = status; jobsChanged?.("sess-1"); await settle(); clock.run(); },
		async setAgent(status: string) { state.agent = status; agentsChanged?.("sess-1"); await settle(); clock.run(); },
		/** Drops one action, delivers it, and answers its result. */
		async act(kind: string, args: Record<string, unknown>) {
			n += 1;
			const id = `a${n}`;
			writeFileSync(join(inbox, `${id}.json`), actionText(id, kind, args));
			fireWatch?.();
			await settle();
			clock.run();
			await settle();
			return JSON.parse(readFileSync(join(outbox, `${id}.json`), "utf8"));
		},
		snapshot: () => JSON.parse(readFileSync(desktopFeedFile(agentDir, "sess-1"), "utf8")) as DesktopFeedSnapshot,
		inboxFiles: () => readdirSync(inbox).filter((name) => name.endsWith(".json")),
	};
}

const BUSY = { code: "escalation_while_busy", message: "Raising the permission mode is refused while the agent, a background job or a subagent is running, or within 2 s after; try again when the session is idle." };

test("S2: an escalation written while the agent works is refused before the owner; a de-escalation and abort_turn still run", async (t) => {
	const h = sessionHarness(t, { mode: "auto" });
	await h.start();
	assert.equal(h.snapshot().permission!.mode, "auto");
	// The file clock lags the activity clock (Linux stamps files with its coarse
	// clock, up to a tick behind Date.now; some filesystems keep whole seconds):
	// a file written after agent_start can carry a time just before it.
	h.offset = 50;
	h.idle = false;
	h.fire("agent_start", {});
	for (const mode of ["yolo", "super-yolo"]) {
		const result = await h.act("set_permission_mode", { mode });
		assert.equal(result.ok, false, mode);
		assert.deepEqual(result.error, BUSY);
	}
	assert.deepEqual(h.setModes, [], "the owner is never asked");
	assert.equal(h.snapshot().permission!.mode, "auto");
	assert.deepEqual(h.inboxFiles(), []);
	const lower = await h.act("set_permission_mode", { mode: "normal" });
	assert.equal(lower.ok, true, "a de-escalation is always accepted");
	assert.deepEqual(h.setModes, ["normal"]);
	const stop = await h.act("abort_turn", {});
	assert.equal(stop.ok, true);
	assert.equal(h.aborts, 1);
});

test("S2: an escalation is refused while a background job or a subagent runs, and within 2 s after the turn", async (t) => {
	const h = sessionHarness(t, { job: "running" });
	await h.start();
	assert.deepEqual((await h.act("set_permission_mode", { mode: "auto" })).error, BUSY, "a running job");
	await h.setJob("exited");
	await h.setAgent("running");
	assert.deepEqual((await h.act("set_permission_mode", { mode: "yolo" })).error, BUSY, "a running subagent");
	await h.setAgent("completed");
	// The turn just ended: still inside the 2 s tail.
	h.idle = false;
	h.fire("agent_start", {});
	h.idle = true;
	h.fire("agent_settled", {});
	assert.deepEqual((await h.act("set_permission_mode", { mode: "super-yolo" })).error, BUSY, "within 2 s after activity");
	assert.deepEqual(h.setModes, []);
	assert.equal(h.snapshot().permission!.mode, "normal");
});

test("S2: an escalation from an idle session runs through the owner once", async (t) => {
	const h = sessionHarness(t);
	await h.start();
	// Activity that ended well before the file was written.
	h.offset = -10_000;
	h.idle = false;
	h.fire("agent_start", {});
	h.offset = -5_000;
	h.idle = true;
	h.fire("agent_settled", {});
	h.offset = 0;
	const result = await h.act("set_permission_mode", { mode: "super-yolo" });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(h.setModes, ["super-yolo"]);
	assert.equal(h.snapshot().permission!.mode, "super-yolo");
	assert.equal(h.prompts.length, 1, "the human confirmed it in the session UI");
	assert.match(h.prompts[0]!, /Gentle Shell Desktop/);
	assert.match(h.prompts[0]!, /super-yolo/);
	const lower = await h.act("set_permission_mode", { mode: "normal" });
	assert.equal(lower.ok, true);
	assert.equal(h.prompts.length, 1, "a de-escalation never asks");
});

const NEEDS_CONFIRMATION = { code: "escalation_needs_confirmation", message: "Raising the permission mode needs your confirmation in the session's Terminal; it was not confirmed." };

test("S2: an idle escalation the human declines is refused with zero owner calls", async (t) => {
	const h = sessionHarness(t);
	await h.start();
	h.confirmAnswer = false;
	assert.deepEqual((await h.act("set_permission_mode", { mode: "super-yolo" })).error, NEEDS_CONFIRMATION);
	assert.equal(h.prompts.length, 1);
	assert.deepEqual(h.setModes, []);
	assert.equal(h.snapshot().permission!.mode, "normal");
});

test("S2: an escalation without an interactive confirm is refused; one awaiting it answers pending first", async (t) => {
	const bare = inboxHarness(t);
	bare.inbox.start();
	writeFileSync(join(bare.inbox.inbox, "n1.json"), actionText("n1", "set_permission_mode", { mode: "yolo" }));
	await bare.deliver();
	assert.deepEqual(bare.result("n1").error, NEEDS_CONFIRMATION);
	assert.deepEqual(bare.calls, [], "no owner call");
	let answer: (yes: boolean) => void = () => {};
	const asks: string[] = [];
	const h = inboxHarness(t, { confirmEscalation: (from, to) => { asks.push(`${from}>${to}`); return new Promise((resolve) => { answer = resolve; }); } });
	h.inbox.start();
	writeFileSync(join(h.inbox.inbox, "c1.json"), actionText("c1", "set_permission_mode", { mode: "auto" }));
	await h.deliver();
	assert.deepEqual(h.result("c1").data, { pending: "confirmation" }, "the desktop shows the Terminal");
	assert.deepEqual(h.calls, []);
	answer(true);
	await settle();
	assert.deepEqual(h.result("c1").data, { mode: "auto" });
	assert.deepEqual(h.calls, ["mode:auto"]);
	assert.deepEqual(asks, ["normal>auto"]);
});

// ---- B2: relayed provider consent is answered in the terminal ----

const consentEnvelope = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json"), "utf8")) as {
	headline: string;
	choices: Array<{ answer: string; label: string; effect: string; invocation: string }>;
};
const relayedArgs = (value: (choice: { answer: string; invocation: string }) => string) => ({
	question: consentEnvelope.headline,
	options: consentEnvelope.choices.map((choice) => ({ label: choice.label, description: choice.effect, value: value(choice) })),
});
const TERMINAL = { code: "answer_in_terminal", message: "Answer this question in the Terminal view" };

test("S5: a provider consent relayed through ask_user_choice is answered only in the terminal", async (t) => {
	const h = sessionHarness(t);
	await h.start();
	h.fire("agent_start", {});
	// gentle_review returned the unresolved consent envelope; the model relays it.
	const details = { operation: "start", status: "blocked", outcome: "native-review-consent-required", consent: { ...consentEnvelope, consentBinding: "binding-1" }, consent_binding: "binding-1" };
	h.fire("tool_execution_end", { toolCallId: "r1", toolName: "gentle_review", isError: false, result: { content: [{ type: "text", text: JSON.stringify(details) }], details } });
	// Neutral option tokens: only the relay path marks it.
	h.fire("tool_execution_start", { toolCallId: "ask-1", toolName: "ask_user_choice", args: relayedArgs((_choice) => "opaque-token") });
	await h.flush();
	const pending = h.snapshot().pendingQuestion!;
	assert.equal(pending.terminalOnly, true);
	const answer = await h.act("answer_question", { toolCallId: "ask-1", option: 0 });
	assert.deepEqual(answer.error, TERMINAL);
	assert.equal(answer.ok, false);
});

test("S5: relayed consent and maintenance authorization are recognised from the ask call and from tool results", () => {
	for (const args of [relayedArgs((choice) => choice.answer), relayedArgs((choice) => choice.invocation)]) {
		const shape = questionShape("ask_user_choice", "c", args)!;
		assert.deepEqual(answerKeys(shape, { option: 0 }), { error: TERMINAL });
	}
	assert.equal(providerDecisionIn({ content: [{ type: "text", text: JSON.stringify(consentEnvelope) }] }), true);
	assert.equal(providerDecisionIn({ details: { authorization_schema: "gentle-ai.review-repair-authorization/v1", required_inputs: ["actor", "reason", "maintainer_authorization"] } }), true);
	assert.equal(providerDecisionIn({ content: [{ type: "text", text: "Tests passed: 12" }] }), false);
	// An ordinary question keeps its clickable answer.
	const ordinary = questionShape("ask_user_choice", "c", { question: "Which name?", options: [{ label: "A", description: "a", value: "a" }, { label: "B", description: "b", value: "b" }] })!;
	assert.deepEqual(answerKeys(ordinary, { option: 1 }), { keys: ["up", "up", "down", "enter"] });
});

// ---- Verifier regressions (350f066c6 re-verify) ----

test("S2: an escalation file present before session_start is refused with zero owner calls", async (t) => {
	const h = sessionHarness(t);
	mkdirSync(h.inbox, { recursive: true, mode: 0o700 });
	mkdirSync(h.outbox, { recursive: true, mode: 0o700 });
	writeFileSync(join(h.inbox, "early.json"), actionText("early", "set_permission_mode", { mode: "super-yolo" }), { mode: 0o600 });
	await new Promise((resolve) => setTimeout(resolve, 20));
	await h.start();
	await h.flush();
	assert.deepEqual(h.setModes, [], "the owner is never asked");
	assert.equal(h.snapshot().permission!.mode, "normal");
	const result = join(h.outbox, "early.json");
	assert.ok(existsSync(result), "the refusal is answered");
	assert.deepEqual(JSON.parse(readFileSync(result, "utf8")).error, BUSY);
	assert.deepEqual(h.inboxFiles(), []);
});

test("S2: queued and waiting subagents count as busy for an escalation", async (t) => {
	const h = sessionHarness(t, { agent: "queued" });
	await h.start();
	assert.deepEqual((await h.act("set_permission_mode", { mode: "yolo" })).error, BUSY, "a queued subagent");
	await h.setAgent("waiting");
	assert.deepEqual((await h.act("set_permission_mode", { mode: "super-yolo" })).error, BUSY, "a waiting subagent");
	assert.deepEqual(h.setModes, []);
	assert.equal(h.snapshot().permission!.mode, "normal");
});

test("S5: a provider consent relayed in the next agent run through ask_user_question is terminal-only", async (t) => {
	const h = sessionHarness(t);
	await h.start();
	h.fire("agent_start", {});
	const details = { operation: "start", status: "blocked", outcome: "native-review-consent-required", consent: { ...consentEnvelope, consentBinding: "binding-2" }, consent_binding: "binding-2" };
	h.fire("tool_execution_end", { toolCallId: "r2", toolName: "gentle_review", isError: false, result: { content: [{ type: "text", text: JSON.stringify(details) }], details } });
	h.fire("agent_settled", {});
	// The next run relays it with a neutral questionnaire.
	h.fire("agent_start", {});
	h.fire("tool_execution_start", { toolCallId: "ask-3", toolName: "ask_user_question", args: { questions: [{ question: "Proceed?", header: "Review", options: [{ label: "Yes", description: "go" }, { label: "No", description: "stop" }] }] } });
	await h.flush();
	assert.equal(h.snapshot().pendingQuestion!.terminalOnly, true);
	const answer = await h.act("answer_question", { toolCallId: "ask-3", option: 0 });
	assert.equal(answer.ok, false);
	assert.deepEqual(answer.error, TERMINAL);
});

test("S2: a spoofed createdAt and a set-back mtime cannot date an escalation before the busy span", async (t) => {
	// Idle from 60 s ago, busy from 5 s ago: only the file's ctime (now) falls in the busy span.
	let fake: number | undefined = Date.now() - 60_000;
	const timeline = createDesktopActivityTimeline(() => fake ?? Date.now());
	fake = Date.now() - 5_000;
	timeline.set(true);
	fake = undefined;
	const h = inboxHarness(t, { busyAt: (time) => timeline.busyAt(time) });
	assert.equal(h.inbox.start(), true);
	const file = join(h.inbox.inbox, "sp1.json");
	writeFileSync(file, JSON.stringify({ schema: DESKTOP_ACTION_SCHEMA, id: "sp1", sessionId: "sess-1", kind: "set_permission_mode", args: { mode: "super-yolo" }, createdAt: new Date(NOW - 50_000).toISOString() }));
	const back = (Date.now() - 30_000) / 1000;
	utimesSync(file, back, back);
	assert.equal(timeline.busyAt(back * 1000), false, "the set-back mtime alone would read as idle");
	await h.deliver();
	assert.deepEqual(h.calls, []);
	assert.deepEqual(h.result("sp1").error, BUSY);
});

test("S5: an ordinary question in a later turn stays clickable", async (t) => {
	const h = sessionHarness(t);
	await h.start();
	h.fire("agent_start", {});
	h.fire("tool_execution_start", { toolCallId: "ask-2", toolName: "ask_user_choice", args: { question: "Which name?", options: [{ label: "A", description: "a", value: "a" }, { label: "B", description: "b", value: "b" }] } });
	await h.flush();
	assert.equal(h.snapshot().pendingQuestion!.terminalOnly, false);
	const answer = await h.act("answer_question", { toolCallId: "ask-2", option: 1 });
	assert.deepEqual(answer.data, { toolCallId: "ask-2", keys: ["up", "up", "down", "enter"] });
});
