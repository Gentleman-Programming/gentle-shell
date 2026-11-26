import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDesktopFeedExtension, type DesktopFeedOptions } from "../extensions/gentle-desktop-feed.ts";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import {
	answerKeys,
	DESKTOP_ACTION_RESULT_SCHEMA,
	DESKTOP_ACTION_SCHEMA,
	desktopActionInboxDir,
	desktopActionOutboxDir,
	parseDesktopAction,
	questionShape,
	runDesktopAction,
	sweepDesktopActionOrphans,
	type DesktopActionOwners,
} from "../lib/desktop-feed-actions.ts";
import type { DesktopFeedSnapshot, DesktopFeedTimers } from "../lib/desktop-feed.ts";
import { DESKTOP_FEED_BUILTIN_COMMANDS } from "../lib/desktop-feed.ts";
import { desktopFeedFile } from "../lib/desktop-feed-store.ts";
import { publishChoiceAnswerHandle, publishQuestionnaireAnswerHandle } from "../lib/desktop-feed-answers.ts";
import { DESKTOP_AGENTS_SERVICE_CHANNEL, DESKTOP_AGENTS_SERVICE_SCHEMA } from "../lib/desktop-rpc-agents.ts";
import { DESKTOP_JOBS_SERVICE_CHANNEL, DESKTOP_JOBS_SERVICE_SCHEMA, type DesktopJobEntry } from "../lib/desktop-rpc-jobs.ts";
import { DESKTOP_RPC_SCHEMA, type DesktopRpcOutcome } from "../lib/desktop-rpc.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";
import { NOTIFICATION_ATTENTION_EVENT } from "../lib/notification-events.ts";
import { registerYoloSessionPolicy } from "../lib/yolo-session-policy.ts";

// T7 (odd/tasks/herdr-desktop.md, S2/S5): the desktop's actions reach a live
// Gentle Shell session through a private per-session inbox, and every action
// goes through the same owner the desktop RPC already uses — never around it.

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const GENTLE_ENV = { PI_PROGRAM_STATUS_APP: "gentle-shell", HERDR_ENV: "1", HERDR_PANE_ID: "t7" };

// ---- Harness ----

function fakeTimers() {
	const pending = new Map<number, () => void>();
	let next = 0;
	const timers: DesktopFeedTimers = {
		set(fn) { next += 1; pending.set(next, fn); return next; },
		clear(handle) { pending.delete(handle as number); },
	};
	return { timers, get armed() { return pending.size; }, run() { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn(); } };
}

function fakeBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(name: string, fn: (data: unknown) => void) {
			const set = listeners.get(name) ?? new Set();
			set.add(fn);
			listeners.set(name, set);
			return () => { set.delete(fn); };
		},
		emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
	};
}

type Handler = (event: any, ctx: any) => unknown;
function fakePi() {
	const bus = fakeBus();
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	// What pi.sendUserMessage received (T11 send_prompt).
	const sent: Array<{ content: unknown; options: unknown }> = [];
	// pi refuses a prompt while it compacts (agent-session prompt(): "Cannot submit a prompt
	// while compaction is in progress") and its runtime swallows the error (V9).
	const refused: Array<{ content: unknown; options: unknown }> = [];
	const state = { compacting: false };
	const pi = {
		on(name: string, fn: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
		events: bus,
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerTool() {},
		getThinkingLevel: () => "high",
		sendUserMessage(content: unknown, options: unknown) { (state.compacting ? refused : sent).push({ content, options }); },
	} as unknown as ExtensionAPI;
	const fire = (name: string, event: unknown, ctx: unknown) => { for (const fn of handlers.get(name) ?? []) fn(event, ctx); };
	return { pi, bus, commands, fire, sent, refused, setCompacting(value: boolean) { state.compacting = value; } };
}

function fakeCtx(cwd: string, overrides: Record<string, unknown> = {}) {
	const widgets: Array<{ key: string; lines: string[] }> = [];
	const notices: string[] = [];
	return {
		cwd, mode: "tui", hasUI: true,
		isIdle: () => true,
		model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true, contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
		ui: {
			setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); },
			setStatus() {},
			notify(message: string) { notices.push(message); },
			select: async () => undefined,
			getAllThemes: () => [{}],
			confirm: async () => true,
		},
		widgets, notices,
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => "/agent/sessions/--w--/2026_sess-1.jsonl",
			getSessionName: () => undefined,
			getCwd: () => cwd,
			getBranch: () => [],
			getEntries: () => [],
			getLeafId: () => null,
		},
		...overrides,
	};
}

interface OwnerCalls { cancelJob: string[]; cancelSubagent: string[] }

/** Minimal jobs and agents owners speaking the existing owner-service contracts. */
function fakeOwners(bus: ReturnType<typeof fakeBus>, calls: OwnerCalls, idle = false) {
	// `idle`: the job and the subagent have finished, so nothing of the session runs (T7 escalations).
	const job: DesktopJobEntry = idle ? { id: "j1", label: "npm test", status: "exited", startedAt: 1, endedAt: 2 } : { id: "j1", label: "npm test", status: "running", startedAt: 1 };
	bus.on(DESKTOP_JOBS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({
			schema: DESKTOP_JOBS_SERVICE_SCHEMA,
			read: () => ({ sessionId: "sess-1", jobs: [job] }),
			cancel: (id: string) => { calls.cancelJob.push(id); return id === "j1" ? { kind: "ok", job: { ...job, status: "stopped", endedAt: 2 }, changed: true } : { kind: "not_found" }; },
			observe: () => () => {},
			dispose: () => {},
		});
	});
	const agent = { id: "a1", agent: "gentle-writer", status: idle ? "completed" : "running", model: "sonnet", lastStep: "writing", usage: { total: 10, cost: 0.1 } };
	bus.on(DESKTOP_AGENTS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({
			schema: DESKTOP_AGENTS_SERVICE_SCHEMA,
			read: () => ({ sessionId: "sess-1", agents: [agent] }),
			cancel: (id: string) => { calls.cancelSubagent.push(id); return id === "a1" ? { kind: "ok", agent, requested: true, changed: false } : { kind: "not_found" }; },
			observe: () => () => {},
			dispose: () => {},
		});
	});
}

function harness(t: test.TestContext, { idle, ...options }: Partial<DesktopFeedOptions> & { owner?: "real" | "refusing" | "none"; idle?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "desktop-actions-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	const configHome = join(root, "config");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(configHome, { recursive: true });
	const clock = fakeTimers();
	const h = fakePi();
	const calls: OwnerCalls = { cancelJob: [], cancelSubagent: [] };
	const setModes: string[] = [];
	fakeOwners(h.bus, calls, idle);
	const ownerEnv = { ...GENTLE_ENV, GENTLE_PI_CONFIG_HOME: configHome };
	if ((options.owner ?? "real") === "real") {
		// Count every owner setMode the adapter receives without changing what it
		// does (registered first, so it wraps the request before the owner answers).
		h.bus.on("gentle:yolo:host-ui", (payload) => {
			const request = payload as { respond(adapter: unknown): void };
			const original = request.respond;
			request.respond = (adapter: any) => {
				if (adapter && typeof adapter.setMode === "function") {
					const setMode = adapter.setMode;
					adapter.setMode = async (mode: string) => { setModes.push(mode); return setMode(mode); };
				}
				original(adapter);
			};
		});
		registerYoloSessionPolicy(h.pi, ownerEnv, { resolveIdentity: async () => "workspace:test" });
	} else if (options.owner === "refusing") {
		h.bus.on("gentle:yolo:host-ui", (payload) => {
			(payload as { respond(adapter: unknown): void }).respond({
				read: async () => "OFF",
				readSnapshot: async () => ({ yolo: "OFF", mode: "normal", defaultMode: "normal" }),
				setMode: async (mode: string) => { setModes.push(mode); return false; },
				toggle: async () => {},
				observe: () => () => {},
				dispose: () => {},
			});
		});
	}
	let fireWatch: (() => void) | undefined;
	let watchClosed = 0;
	createDesktopFeedExtension({
		env: GENTLE_ENV,
		agentDir,
		now: () => NOW,
		timers: clock.timers,
		git: () => async () => ({ stdout: "", code: 128 }),
		parentOf: async () => undefined,
		profile: () => ({ name: undefined, tier: undefined }),
		realpath: (path) => path,
		sweep: () => {},
		actionWatch: (_dir, onChange) => { fireWatch = onChange; return () => { watchClosed += 1; }; },
		...options,
	})(h.pi);
	const ctx = fakeCtx(workspace);
	const inbox = desktopActionInboxDir(agentDir, "sess-1");
	const outbox = desktopActionOutboxDir(agentDir, "sess-1");
	const feedFile = desktopFeedFile(agentDir, "sess-1");
	const action = (id: string, kind: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
		JSON.stringify({ schema: DESKTOP_ACTION_SCHEMA, id, sessionId: "sess-1", kind, args, createdAt: new Date(NOW - 1000).toISOString(), ...extra });
	return {
		...h, ctx, clock, agentDir, inbox, outbox, calls, setModes,
		get watchClosed() { return watchClosed; },
		start: async () => { h.fire("session_start", { reason: "startup" }, ctx); await settle(); clock.run(); await settle(); clock.run(); },
		drop(name: string, text: string) { writeFileSync(join(inbox, name), text); },
		action,
		/** Fire the inbox watch, let the owners answer, flush the debounced snapshot. */
		async deliver() { fireWatch?.(); await settle(); await settle(); clock.run(); },
		result(id: string) {
			const file = join(outbox, `${id}.json`);
			return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
		},
		// The session's pid marker (`.owner`) is not an action.
		inboxFiles: () => readdirSync(inbox).filter((name) => !name.startsWith(".")),
		snapshot: () => JSON.parse(readFileSync(feedFile, "utf8")) as DesktopFeedSnapshot,
	};
}

// ---- The inbox ----

test("S2: the session creates a private inbox and outbox, and removes them when it ends", async (t) => {
	const h = harness(t);
	await h.start();
	assert.equal(statSync(h.inbox).mode & 0o777, 0o700);
	assert.equal(statSync(h.outbox).mode & 0o777, 0o700);
	h.fire("session_shutdown", { reason: "quit" }, h.ctx);
	assert.equal(existsSync(h.inbox), false);
	assert.equal(existsSync(h.outbox), false);
	assert.equal(h.watchClosed, 1);
});

test("S2: set_permission_mode goes through the permission owner once and the snapshot follows it", async (t) => {
	const h = harness(t, { idle: true });
	await h.start();
	assert.equal(h.snapshot().permission!.mode, "normal");
	h.drop("p1.json", h.action("p1", "set_permission_mode", { mode: "super-yolo" }));
	await h.deliver();
	assert.deepEqual(h.setModes, ["super-yolo"], "the owner decides, once");
	assert.deepEqual(h.inboxFiles(), [], "the handled file is removed");
	const result = h.result("p1");
	assert.equal(result.schema, DESKTOP_ACTION_RESULT_SCHEMA);
	assert.equal(result.id, "p1");
	assert.equal(result.kind, "set_permission_mode");
	assert.equal(result.ok, true);
	assert.equal(result.data.mode, "super-yolo");
	assert.equal(statSync(join(h.outbox, "p1.json")).mode & 0o777, 0o600);
	assert.equal(h.snapshot().permission!.mode, "super-yolo");
	h.drop("p2.json", h.action("p2", "set_permission_mode", { mode: "normal" }));
	await h.deliver();
	assert.deepEqual(h.setModes, ["super-yolo", "normal"]);
	assert.equal(h.snapshot().permission!.mode, "normal");
});

test("S2: an owner refusal of super-yolo is reported and changes nothing", async (t) => {
	const h = harness(t, { owner: "refusing", idle: true });
	await h.start();
	h.drop("p1.json", h.action("p1", "set_permission_mode", { mode: "super-yolo" }));
	await h.deliver();
	assert.deepEqual(h.setModes, ["super-yolo"]);
	assert.deepEqual(h.result("p1").error, { code: "permission_denied", message: "Permission mode unchanged for this session" });
	assert.equal(h.result("p1").ok, false);
	assert.equal(h.snapshot().permission!.mode, "normal");
	assert.deepEqual(h.inboxFiles(), []);
});

test("S2: cancel_job and cancel_subagent call their owners exactly once with the id", async (t) => {
	const h = harness(t);
	await h.start();
	h.drop("c1.json", h.action("c1", "cancel_job", { id: "j1" }));
	h.drop("c2.json", h.action("c2", "cancel_subagent", { id: "a1" }));
	await h.deliver();
	assert.deepEqual(h.calls.cancelJob, ["j1"]);
	assert.deepEqual(h.calls.cancelSubagent, ["a1"]);
	assert.equal(h.result("c1").ok, true);
	assert.equal(h.result("c1").data.job.status, "stopped");
	assert.equal(h.result("c2").ok, true);
	assert.equal(h.result("c2").data.agent.id, "a1");
	h.drop("c3.json", h.action("c3", "cancel_job", { id: "nope" }));
	await h.deliver();
	assert.equal(h.result("c3").ok, false);
	assert.equal(h.result("c3").error.code, "not_found");
	assert.deepEqual(h.inboxFiles(), []);
});

test("S2: a crashed session's inbox and outbox are swept once they are old and its snapshot is gone", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "desktop-actions-sweep-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const old = (Date.now() - 11 * 60_000) / 1000;
	const make = (session: string, age: number | undefined, snapshot: boolean) => {
		for (const dir of [desktopActionInboxDir(agentDir, session), desktopActionOutboxDir(agentDir, session)]) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			writeFileSync(join(dir, "x.json"), "{}");
			if (age !== undefined) utimesSync(dir, age, age);
		}
		if (snapshot) { mkdirSync(join(agentDir, "desktop", "sessions"), { recursive: true }); writeFileSync(desktopFeedFile(agentDir, session), "{}"); }
	};
	make("dead", old, false);
	make("fresh", undefined, false);
	make("alive", old, true);
	make("mine", old, false);
	sweepDesktopActionOrphans(agentDir, "mine");
	assert.equal(existsSync(desktopActionInboxDir(agentDir, "dead")), false);
	assert.equal(existsSync(desktopActionOutboxDir(agentDir, "dead")), false);
	for (const kept of ["fresh", "alive", "mine"]) {
		assert.ok(existsSync(desktopActionInboxDir(agentDir, kept)), kept);
		assert.ok(existsSync(desktopActionOutboxDir(agentDir, kept)), kept);
	}
});

// ---- Guards: each rejection has no side effect ----

test("S2: rejected actions never reach an owner, are removed and answer why", async (t) => {
	const h = harness(t);
	await h.start();
	const target = join(h.agentDir, "target.json");
	writeFileSync(target, h.action("g1", "cancel_job", { id: "j1" }));
	symlinkSync(target, join(h.inbox, "g1.json"));
	h.drop("g2.json", h.action("g2", "cancel_job", { id: "j1" }, { pad: "x".repeat(17 * 1024) }));
	h.drop("g3.json", h.action("g3", "cancel_job", { id: "j1" }, { createdAt: new Date(NOW - 61_000).toISOString() }));
	h.drop("g4.json", h.action("g4", "run_shell", { command: "rm -rf /" }));
	h.drop("g5.json", h.action("g5", "cancel_job", { id: "j1" }, { sessionId: "other" }));
	h.drop("g6.json", h.action("g6", "set_permission_mode", { mode: "super-yolo", persist: true, extra: 1 }));
	h.drop("g7.json", h.action("g7", "answer_question", { toolCallId: "call-1", option: 0 }));
	h.drop("g8.json", h.action("g8", "cancel_job", { id: "j1" }, { createdAt: new Date(NOW + 60_000).toISOString() }));
	h.drop("g9.json", h.action("other-id", "cancel_job", { id: "j1" }));
	await h.deliver();
	assert.deepEqual(h.calls, { cancelJob: [], cancelSubagent: [] });
	assert.deepEqual(h.setModes, []);
	assert.equal(h.snapshot().permission!.mode, "normal");
	assert.deepEqual(h.inboxFiles(), []);
	assert.ok(existsSync(target), "a symlink is removed, never followed");
	const codes = Object.fromEntries(["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9"].map((id) => [id, h.result(id)?.error?.code]));
	assert.deepEqual(codes, {
		g1: "unsafe_file", g2: "too_large", g3: "stale", g4: "unknown_kind", g5: "wrong_session",
		g6: "invalid_action", g7: "question_mismatch", g8: "stale", g9: "invalid_action",
	});
});

test("S2: an id seen before is refused, so an action never runs twice", async (t) => {
	const h = harness(t);
	await h.start();
	h.drop("d1.json", h.action("d1", "cancel_job", { id: "j1" }));
	await h.deliver();
	h.drop("d1.json", h.action("d1", "cancel_job", { id: "j1" }));
	await h.deliver();
	assert.deepEqual(h.calls.cancelJob, ["j1"]);
	assert.equal(h.result("d1").error.code, "duplicate");
});

test("S2: a half-written file waits for the rest instead of being rejected", async (t) => {
	const h = harness(t);
	await h.start();
	const full = h.action("w1", "cancel_job", { id: "j1" });
	h.drop("w1.json", full.slice(0, 20));
	await h.deliver();
	assert.deepEqual(h.inboxFiles(), ["w1.json"]);
	assert.equal(h.result("w1"), undefined);
	writeFileSync(join(h.inbox, "w1.json"), full);
	h.clock.run(); // the retry armed for the partial file
	await settle();
	assert.deepEqual(h.calls.cancelJob, ["j1"]);
	assert.deepEqual(h.inboxFiles(), []);
});

// ---- Stop the agent's turn (T10, S9: the TUI's Esc Esc) ----

test("S9: abort_turn stops a working turn through the session's own abort, once", async (t) => {
	const h = harness(t);
	await h.start();
	let aborts = 0;
	let idle = false;
	Object.assign(h.ctx, { isIdle: () => idle, abort: () => { aborts += 1; } });
	h.drop("s1.json", h.action("s1", "abort_turn", {}));
	await h.deliver();
	assert.equal(aborts, 1);
	assert.deepEqual(h.result("s1"), { schema: DESKTOP_ACTION_RESULT_SCHEMA, id: "s1", sessionId: "sess-1", kind: "abort_turn", ok: true, data: { aborted: true }, finishedAt: new Date(NOW).toISOString() });
	assert.deepEqual(h.inboxFiles(), []);
	idle = true;
	h.drop("s2.json", h.action("s2", "abort_turn", {}));
	h.drop("s3.json", h.action("s3", "abort_turn", { force: true }));
	await h.deliver();
	assert.equal(aborts, 1, "an idle session or a malformed action aborts nothing");
	assert.deepEqual(h.result("s2").error, { code: "not_working", message: "The agent is not working" });
	assert.equal(h.result("s3").error.code, "invalid_action");
	assert.deepEqual(h.inboxFiles(), []);
	assert.deepEqual(h.calls, { cancelJob: [], cancelSubagent: [] }, "no other owner is reached");
	assert.deepEqual(h.setModes, []);
});

// ---- Questions ----

test("S5: answer_question answers only the open question with the keys the real list takes", async (t) => {
	const h = harness(t);
	await h.start();
	h.fire("tool_execution_start", { toolCallId: "call-9", toolName: "ask_user_choice", args: { question: "Which?", options: [{ label: "A", value: "x" }, { label: "B", value: "y" }, { label: "C", value: "z" }], allowCustomResponse: true } }, h.ctx);
	h.drop("q1.json", h.action("q1", "answer_question", { toolCallId: "call-9", option: 1 }));
	h.drop("q2.json", h.action("q2", "answer_question", { toolCallId: "call-8", option: 0 }));
	h.drop("q3.json", h.action("q3", "answer_question", { toolCallId: "call-9", option: 3 }));
	await h.deliver();
	// NativeChoiceList clamps: four ups reach the top from anywhere, one down is option 2.
	assert.deepEqual(h.result("q1"), { schema: DESKTOP_ACTION_RESULT_SCHEMA, id: "q1", sessionId: "sess-1", kind: "answer_question", ok: true, data: { toolCallId: "call-9", keys: ["up", "up", "up", "up", "down", "enter"] }, finishedAt: new Date(NOW).toISOString() });
	assert.equal(h.result("q2").error.code, "question_mismatch");
	assert.equal(h.result("q3").error.code, "invalid_action");
	h.drop("q4.json", h.action("q4", "answer_question", { toolCallId: "call-9", text: "my own" }));
	await h.deliver();
	assert.deepEqual(h.result("q4").data, { toolCallId: "call-9", keys: ["up", "up", "up", "up", "down", "down", "down", "enter"], text: "my own" });
	h.fire("tool_execution_end", { toolCallId: "call-9", toolName: "ask_user_choice", isError: false, result: {} }, h.ctx);
	h.drop("q5.json", h.action("q5", "answer_question", { toolCallId: "call-9", option: 0 }));
	await h.deliver();
	assert.equal(h.result("q5").error.code, "question_mismatch", "a closed question cannot be answered");
});

test("S5: multi-question, multi-select and consent prompts are answered in the terminal", () => {
	const multi = questionShape("ask_user_question", "q", { questions: [{ question: "a", options: [{ label: "1" }, { label: "2" }] }, { question: "b", options: [{ label: "1" }, { label: "2" }] }] })!;
	assert.deepEqual(answerKeys(multi, { option: 0 }), { error: { code: "answer_in_terminal", message: "Answer this question in the Terminal view" } });
	const select = questionShape("ask_user_question", "q", { questions: [{ question: "a", multiSelect: true, options: [{ label: "1" }, { label: "2" }] }] })!;
	assert.equal("error" in answerKeys(select, { option: 0 }), true);
	const single = questionShape("ask_user_question", "q", { questions: [{ question: "a", options: [{ label: "1" }, { label: "2" }] }] })!;
	assert.deepEqual(answerKeys(single, { option: 1 }), { keys: ["up", "up", "up", "down", "enter"] });
	const noCustom = questionShape("ask_user_choice", "c", { question: "a", options: [{ label: "1" }, { label: "2" }] })!;
	assert.equal("error" in answerKeys(noCustom, { text: "x" }), true, "free text only where the list offers it");
	assert.equal(questionShape("bash", "b", {}), undefined);
});

// ---- Pure parsing and dispatch ----

test("S2: parseDesktopAction checks schema, id, session, kind, args and age", () => {
	const base = { schema: DESKTOP_ACTION_SCHEMA, id: "a-1", sessionId: "s", kind: "cancel_job", args: { id: "j" }, createdAt: new Date(NOW).toISOString() };
	assert.deepEqual(parseDesktopAction(JSON.stringify(base), "s", NOW), { ok: true, action: { id: "a-1", sessionId: "s", kind: "cancel_job", args: { id: "j" }, createdAt: NOW } });
	const code = (value: unknown) => { const r = parseDesktopAction(JSON.stringify(value), "s", NOW); return "error" in r ? r.error.code : "ok"; };
	assert.equal(code({ ...base, schema: "other" }), "invalid_action");
	assert.equal(code({ ...base, id: "../x" }), "invalid_action");
	assert.equal(code({ ...base, args: { id: "" } }), "invalid_action");
	assert.equal(code({ ...base, args: { id: "j", more: 1 } }), "invalid_action");
	assert.equal(code({ ...base, kind: "set_permission_mode", args: { mode: "root" } }), "invalid_action");
	assert.equal(code({ ...base, kind: "answer_question", args: { toolCallId: "c", option: 0, text: "x" } }), "invalid_action");
	assert.equal(code({ ...base, kind: "abort_turn", args: {} }), "ok");
	assert.equal(code({ ...base, kind: "abort_turn", args: { id: "j" } }), "invalid_action");
	assert.equal(parseDesktopAction("{", "s", NOW).ok, false);
});

test("S2: runDesktopAction calls only the owner its kind names", async () => {
	const seen: string[] = [];
	const answer = (name: string) => async (value: string): Promise<DesktopRpcOutcome> => { seen.push(`${name}:${value}`); return { ok: true, data: { value } }; };
	let working = true;
	const owners: DesktopActionOwners = { setPermissionMode: answer("mode"), cancelJob: answer("job"), cancelSubagent: answer("agent"), question: () => undefined, working: () => working, abortTurn: () => { seen.push("abort"); }, permissionMode: () => "normal", busyAt: () => false, confirmEscalation: async () => true };
	const run = (kind: string, args: Record<string, unknown>) => runDesktopAction({ id: "x", sessionId: "s", kind: kind as never, args, createdAt: NOW }, owners);
	assert.deepEqual(await run("set_permission_mode", { mode: "auto" }), { ok: true, data: { value: "auto" } });
	assert.deepEqual(await run("cancel_job", { id: "j" }), { ok: true, data: { value: "j" } });
	assert.deepEqual(await run("cancel_subagent", { id: "a" }), { ok: true, data: { value: "a" } });
	assert.deepEqual(await run("abort_turn", {}), { ok: true, data: { aborted: true } });
	working = false;
	assert.deepEqual(await run("abort_turn", {}), { ok: false, error: { code: "not_working", message: "The agent is not working" } });
	assert.deepEqual(seen, ["mode:auto", "job:j", "agent:a", "abort"]);
	const failing: DesktopActionOwners = { ...owners, cancelJob: async () => { throw new Error("/secret/path exploded"); } };
	const failed = await runDesktopAction({ id: "x", sessionId: "s", kind: "cancel_job", args: { id: "j" }, createdAt: NOW }, failing);
	assert.deepEqual(failed, { ok: false, error: { code: "owner_failed", message: "The session could not run this action" } });
});

// ---- Existing desktop RPC behaviour is unchanged ----


/** Channel lines other than the feed's session_snapshot events, without the shared event counter. */
function withoutSessionSnapshots(lines: Array<string | undefined>): unknown[] {
	return lines
		.map((line) => JSON.parse(line!) as Record<string, unknown>)
		.filter((line) => line.event !== "session_snapshot")
		.map(({ seq: _seq, ...line }) => line);
}

test("S2: desktop RPC set_permission_mode answers are byte-identical with the feed and its inbox loaded", async (t) => {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => { if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV]; else process.env[INTERACTIVE_HOST_ENV] = previous; });
	const run = async (withFeed: boolean) => {
		const root = mkdtempSync(join(tmpdir(), "desktop-actions-rpc-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(join(root, "w"));
		mkdirSync(join(root, "config"));
		const h = fakePi();
		registerYoloSessionPolicy(h.pi, { ...GENTLE_ENV, GENTLE_PI_CONFIG_HOME: join(root, "config"), [INTERACTIVE_HOST_ENV]: "1" }, { resolveIdentity: async () => "workspace:test" });
		desktopRpc(h.pi);
		const clock = fakeTimers();
		if (withFeed) createDesktopFeedExtension({ env: { ...GENTLE_ENV, [INTERACTIVE_HOST_ENV]: "1" }, agentDir: join(root, "agent"), timers: clock.timers, git: () => async () => ({ stdout: "", code: 128 }), parentOf: async () => undefined, profile: () => ({ name: undefined, tier: undefined }), sweep: () => {}, actionWatch: () => () => {} })(h.pi);
		const ctx = fakeCtx(join(root, "w"), { mode: "rpc" });
		h.fire("session_start", { reason: "startup" }, ctx);
		await settle();
		for (const [requestId, params] of [["r1", { mode: "super-yolo" }], ["r2", { mode: "normal" }], ["r3", { mode: "nope" }]] as const) {
			await h.commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method: "set_permission_mode", params }), ctx);
		}
		clock.run();
		return ctx.widgets.filter((widget) => widget.key === "gentle-desktop-rpc").map((widget) => widget.lines[0]);
	};
	const without = await run(false);
	const withFeed = await run(true);
	// #3319: the feed also publishes its own session_snapshot events on the
	// channel; every other line is unchanged, in the same order.
	assert.deepEqual(withoutSessionSnapshots(withFeed), withoutSessionSnapshots(without));
	assert.equal(without.length, 5, "two answers with their events and one refusal");
});

// ---- T11: sessions outside Herdr app (S10) ----

test("S10: send_prompt types the text into the session through pi, steering while the agent works", async (t) => {
	const h = harness(t);
	await h.start();
	Object.assign(h.pi, { getCommands: () => [{ name: "gentle:mode", source: "extension" }, { name: "review", source: "prompt" }] });
	h.drop("p1.json", h.action("p1", "send_prompt", { text: "hola" }));
	await h.deliver();
	assert.deepEqual(h.sent, [{ content: "hola", options: { deliverAs: "steer", expandPromptTemplates: false } }]);
	assert.deepEqual(h.result("p1"), { schema: DESKTOP_ACTION_RESULT_SCHEMA, id: "p1", sessionId: "sess-1", kind: "send_prompt", ok: true, data: { queued: false }, finishedAt: new Date(NOW).toISOString() });
	Object.assign(h.ctx, { isIdle: () => false });
	h.fire("agent_start", {}, h.ctx);
	h.drop("p2.json", h.action("p2", "send_prompt", { text: "/review the parser" }));
	await h.deliver();
	assert.deepEqual(h.sent[1], { content: "/review the parser", options: { deliverAs: "steer", expandPromptTemplates: true } });
	assert.deepEqual(h.result("p2").data, { queued: true });
	h.drop("p3.json", h.action("p3", "send_prompt", { text: "/gentle:mode super-yolo" }));
	h.drop("p4.json", h.action("p4", "send_prompt", { text: "/new" }));
	await h.deliver();
	assert.equal(h.result("p3").error.code, "terminal_command");
	assert.equal(h.result("p4").error.code, "terminal_command");
	assert.equal(h.sent.length, 2, "no command reached pi");
	assert.deepEqual(h.setModes, [], "the permission owner was never asked");
	assert.deepEqual(h.inboxFiles(), []);
});

test("S10: send_prompt is refused while a question, an extension prompt or a consent is open", async (t) => {
	const h = harness(t);
	await h.start();
	h.fire("tool_execution_start", { toolCallId: "call-1", toolName: "ask_user_choice", args: { question: "Which?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] } }, h.ctx);
	h.drop("p1.json", h.action("p1", "send_prompt", { text: "A" }));
	await h.deliver();
	assert.deepEqual(h.result("p1").error, { code: "question_open", message: "Answer the open question first." });
	h.fire("tool_execution_end", { toolCallId: "call-1", toolName: "ask_user_choice", isError: false, result: {} }, h.ctx);
	h.fire("ui_prompt_start", { title: "Continue?", kind: "confirm" }, h.ctx);
	h.drop("p2.json", h.action("p2", "send_prompt", { text: "yes" }));
	await h.deliver();
	assert.equal(h.result("p2").error.code, "question_open");
	h.fire("ui_prompt_end", {}, h.ctx);
	h.bus.emit(NOTIFICATION_ATTENTION_EVENT, { active: true, label: "Review consent" });
	h.drop("p3.json", h.action("p3", "send_prompt", { text: "yes" }));
	await h.deliver();
	assert.equal(h.result("p3").error.code, "question_open");
	assert.deepEqual(h.sent, []);
});

test("S10: answer_question via session answers through the ask tool's handle; the key path is unchanged", async (t) => {
	const h = harness(t);
	await h.start();
	const params = { question: "Which?", options: [{ label: "A", description: "", value: "tok-a" }, { label: "B", description: "", value: "tok-b" }] };
	h.fire("tool_execution_start", { toolCallId: "call-1", toolName: "ask_user_choice", args: params }, h.ctx);
	h.drop("a0.json", h.action("a0", "answer_question", { toolCallId: "call-1", option: 1, via: "session" }));
	await h.deliver();
	assert.deepEqual(h.result("a0").error, { code: "answer_in_terminal", message: "Answer this question in that session's terminal." }, "no handle yet");
	const finished: unknown[] = [];
	let done = false;
	publishChoiceAnswerHandle("call-1", params, (result) => { finished.push(result); done = true; }, () => done);
	h.drop("a1.json", h.action("a1", "answer_question", { toolCallId: "call-1", option: 1, via: "session" }));
	await h.deliver();
	assert.deepEqual(finished, [{ value: "tok-b", label: "B", index: 2 }]);
	assert.deepEqual(h.result("a1").data, { toolCallId: "call-1", answered: true });
	h.drop("a2.json", h.action("a2", "answer_question", { toolCallId: "call-1", option: 0 }));
	await h.deliver();
	assert.deepEqual(h.result("a2").data, { toolCallId: "call-1", keys: ["up", "up", "enter"] }, "keys, as before");
	assert.equal(finished.length, 1, "the key path never answers by itself");
	h.fire("tool_execution_end", { toolCallId: "call-1", toolName: "ask_user_choice", isError: false, result: {} }, h.ctx);
	h.drop("a3.json", h.action("a3", "answer_question", { toolCallId: "call-1", option: 0, via: "session" }));
	await h.deliver();
	assert.equal(h.result("a3").error.code, "question_mismatch");
	assert.equal(finished.length, 1);
});

// ---- T11 regressions (verifier, S10) ----

const STEER = (content: string, expand = false) => ({ content, options: { deliverAs: "steer", expandPromptTemplates: expand } });

test("S10: no pi built-in, extension command or ! line reaches pi, leading whitespace included", async (t) => {
	const h = harness(t);
	await h.start();
	Object.assign(h.pi, { getCommands: () => [{ name: "gentle:mode", source: "extension" }, { name: "gentle:agents", source: "extension" }, { name: "review", source: "prompt" }] });
	const texts = [
		...DESKTOP_FEED_BUILTIN_COMMANDS.map((command) => `/${command.name}`),
		"/quit", "/exit", "/settings", "/scoped-models", "/hotkeys", "/debug",
		"/gentle:mode super-yolo", "/gentle:agents", "  /new", "\t/model x", "\n/gentle:mode yolo",
		"!rm -rf build", "!!ls", "   !ls", "\n!ls",
	];
	// Batches under the outbox's 32 kept answers.
	for (let start = 0; start < texts.length; start += 20) {
		const batch = texts.slice(start, start + 20);
		const id = (index: number) => `c${String(start + index).padStart(3, "0")}`;
		batch.forEach((text, index) => h.drop(`${id(index)}.json`, h.action(id(index), "send_prompt", { text })));
		await h.deliver();
		batch.forEach((text, index) => assert.equal(h.result(id(index))?.error?.code, "terminal_command", JSON.stringify(text)));
	}
	assert.deepEqual(h.sent, [], "nothing reached pi");
	assert.deepEqual(h.refused, []);
	assert.deepEqual(h.setModes, [], "the permission owner was never asked");
	assert.deepEqual(h.inboxFiles(), []);
});

test("S10: send_prompt bounds through the inbox: 4000 characters and multi-line text go in, CRLF as LF; the rest is invalid", async (t) => {
	const h = harness(t);
	await h.start();
	h.drop("b1.json", h.action("b1", "send_prompt", { text: "x".repeat(4000) }));
	h.drop("b2.json", h.action("b2", "send_prompt", { text: "x".repeat(4001) }));
	h.drop("b3.json", h.action("b3", "send_prompt", { text: "" }));
	h.drop("b4.json", h.action("b4", "send_prompt", { text: "  \n\t " }));
	h.drop("b5.json", h.action("b5", "send_prompt", { text: "clear\u001b[2J" }));
	h.drop("b6.json", h.action("b6", "send_prompt", { text: 42 }));
	h.drop("b7.json", h.action("b7", "send_prompt", { text: "line one\nline two\tend" }));
	h.drop("b8.json", h.action("b8", "send_prompt", { text: "from windows\r\nsecond line" }));
	h.drop("b9.json", h.action("b9", "send_prompt", { text: "lone\rreturn" }));
	await h.deliver();
	for (const id of ["b1", "b7", "b8"]) assert.deepEqual(h.result(id).data, { queued: false }, id);
	for (const id of ["b2", "b3", "b4", "b5", "b6", "b9"]) assert.equal(h.result(id).error.code, "invalid_action", id);
	assert.deepEqual(h.sent, [STEER("x".repeat(4000)), STEER("line one\nline two\tend"), STEER("from windows\nsecond line")]);
	assert.deepEqual(h.inboxFiles(), []);
});

test("S10: via session never answers a relayed consent, another call id or a multi-select list", async (t) => {
	const h = harness(t);
	await h.start();
	const answered: unknown[] = [];
	// A consent relayed by its own tokens.
	const consent = { question: "Allow review?", options: [{ label: "Yes", description: "", value: "granted" }, { label: "No", description: "", value: "declined" }] };
	h.fire("tool_execution_start", { toolCallId: "call-c", toolName: "ask_user_choice", args: consent }, h.ctx);
	publishChoiceAnswerHandle("call-c", consent, (result) => answered.push(result), () => false);
	h.drop("v1.json", h.action("v1", "answer_question", { toolCallId: "call-c", option: 0, via: "session" }));
	h.drop("v2.json", h.action("v2", "answer_question", { toolCallId: "call-c", text: "granted", via: "session" }));
	await h.deliver();
	assert.deepEqual(h.result("v1").error, { code: "answer_in_terminal", message: "Answer this question in the Terminal view" });
	assert.equal(h.result("v2").error.code, "answer_in_terminal");
	h.fire("tool_execution_end", { toolCallId: "call-c", toolName: "ask_user_choice", isError: false, result: {} }, h.ctx);
	// A consent relayed after a provider decision envelope in this run's tool results.
	h.fire("agent_start", {}, h.ctx);
	h.fire("tool_execution_end", { toolCallId: "b-1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "status: consent_required" }] } }, h.ctx);
	const plain = { question: "Go on?", options: [{ label: "Yes", description: "", value: "yes" }, { label: "No", description: "", value: "no" }] };
	h.fire("tool_execution_start", { toolCallId: "call-r", toolName: "ask_user_choice", args: plain }, h.ctx);
	publishChoiceAnswerHandle("call-r", plain, (result) => answered.push(result), () => false);
	h.drop("v3.json", h.action("v3", "answer_question", { toolCallId: "call-r", option: 0, via: "session" }));
	await h.deliver();
	assert.equal(h.result("v3").error.code, "answer_in_terminal");
	h.fire("tool_execution_end", { toolCallId: "call-r", toolName: "ask_user_choice", isError: false, result: {} }, h.ctx);
	// Another call id: the open question is call-o; a handle for call-x exists.
	h.fire("agent_start", {}, h.ctx);
	h.fire("agent_start", {}, h.ctx);
	h.fire("tool_execution_start", { toolCallId: "call-o", toolName: "ask_user_choice", args: plain }, h.ctx);
	publishChoiceAnswerHandle("call-x", plain, (result) => answered.push(result), () => false);
	h.drop("v4.json", h.action("v4", "answer_question", { toolCallId: "call-x", option: 0, via: "session" }));
	await h.deliver();
	assert.deepEqual(h.result("v4").error, { code: "question_mismatch", message: "That question is no longer open" });
	h.fire("tool_execution_end", { toolCallId: "call-o", toolName: "ask_user_choice", isError: false, result: {} }, h.ctx);
	// A multi-select list.
	const multi = [{ question: "Which?", header: "H", multiSelect: true, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }];
	h.fire("tool_execution_start", { toolCallId: "call-m", toolName: "ask_user_question", args: { questions: multi } }, h.ctx);
	publishQuestionnaireAnswerHandle("call-m", multi, (result) => answered.push(result), () => false);
	h.drop("v5.json", h.action("v5", "answer_question", { toolCallId: "call-m", option: 0, via: "session" }));
	await h.deliver();
	assert.equal(h.result("v5").error.code, "answer_in_terminal");
	assert.deepEqual(answered, [], "no handle was ever used");
	assert.deepEqual(h.sent, []);
});

test("S10 (V9): a prompt sent while pi compacts is held, never reported delivered while pi refuses it, and goes in once compaction ends", async (t) => {
	const h = harness(t);
	await h.start();
	// /compact: pi refuses prompts until its compaction state clears.
	h.setCompacting(true);
	Object.assign(h.ctx, { isIdle: () => false });
	h.fire("session_before_compact", { reason: "manual", willRetry: false }, h.ctx);
	h.drop("k1.json", h.action("k1", "send_prompt", { text: "after the summary" }));
	await h.deliver();
	assert.deepEqual(h.refused, [], "nothing was handed to pi while it refuses prompts");
	assert.deepEqual(h.sent, []);
	assert.deepEqual(h.result("k1").data, { queued: true, after: "compaction" });
	h.drop("k2.json", h.action("k2", "send_prompt", { text: "and this too" }));
	await h.deliver();
	assert.deepEqual(h.result("k2").error, { code: "session_compacting", message: "Pi is compacting this session and already holds one prompt for after it; send this one when compaction ends." });
	h.clock.run();
	h.clock.run();
	assert.deepEqual([h.sent, h.refused], [[], []], "still compacting: still held");
	// pi emits session_compact, then clears its compaction state.
	h.fire("session_compact", { reason: "manual", willRetry: false }, h.ctx);
	h.setCompacting(false);
	Object.assign(h.ctx, { isIdle: () => true });
	h.clock.run();
	assert.deepEqual(h.sent, [STEER("after the summary")]);
	h.clock.run();
	assert.equal(h.sent.length, 1, "delivered once");
	assert.deepEqual(h.refused, []);
	assert.equal(h.clock.armed, 0, "no timer while nothing is held");
});

test("S10 (V9): /tree's summary holds a prompt too, also when the navigation ends without session_tree", async (t) => {
	const h = harness(t);
	await h.start();
	h.setCompacting(true);
	Object.assign(h.ctx, { isIdle: () => false });
	h.fire("session_before_tree", { preparation: {} }, h.ctx);
	h.drop("t1.json", h.action("t1", "send_prompt", { text: "first" }));
	await h.deliver();
	assert.deepEqual(h.result("t1").data, { queued: true, after: "compaction" });
	h.fire("session_tree", { newLeafId: "x", oldLeafId: "y" }, h.ctx);
	h.setCompacting(false);
	Object.assign(h.ctx, { isIdle: () => true });
	h.clock.run();
	assert.deepEqual(h.sent, [STEER("first")]);
	// A cancelled navigation emits no session_tree: pi turning idle releases the prompt.
	h.setCompacting(true);
	Object.assign(h.ctx, { isIdle: () => false });
	h.fire("session_before_tree", { preparation: {} }, h.ctx);
	h.drop("t2.json", h.action("t2", "send_prompt", { text: "second" }));
	await h.deliver();
	h.clock.run();
	assert.equal(h.sent.length, 1);
	h.setCompacting(false);
	Object.assign(h.ctx, { isIdle: () => true });
	h.clock.run();
	assert.deepEqual(h.sent, [STEER("first"), STEER("second")]);
	assert.deepEqual(h.refused, []);
});

test("S10 (V9): a busy pi with no agent run started is waited for, not handed a prompt it may refuse", async (t) => {
	const h = harness(t);
	await h.start();
	// Compacting before this extension heard of it (an earlier handler still runs).
	h.setCompacting(true);
	Object.assign(h.ctx, { isIdle: () => false });
	h.drop("w1.json", h.action("w1", "send_prompt", { text: "wait for it" }));
	await h.deliver();
	assert.deepEqual(h.result("w1").data, { queued: true });
	assert.deepEqual([h.sent, h.refused], [[], []]);
	h.setCompacting(false);
	Object.assign(h.ctx, { isIdle: () => true });
	h.clock.run();
	assert.deepEqual(h.sent, [STEER("wait for it")]);
});

test("S10 (V9): a held prompt is dropped with a clear error when the session ends", async (t) => {
	const h = harness(t);
	await h.start();
	h.setCompacting(true);
	Object.assign(h.ctx, { isIdle: () => false });
	h.fire("session_before_compact", { reason: "manual", willRetry: false }, h.ctx);
	h.drop("s1.json", h.action("s1", "send_prompt", { text: "never mind" }));
	await h.deliver();
	assert.deepEqual(h.result("s1").data, { queued: true, after: "compaction" });
	h.fire("session_shutdown", { reason: "quit" }, h.ctx);
	h.clock.run();
	assert.deepEqual([h.sent, h.refused], [[], []]);
	assert.deepEqual(h.ctx.notices, ["Gentle Shell Desktop: a prompt sent during compaction was not delivered (the session ended)."]);
	assert.equal(h.clock.armed, 0);
});
