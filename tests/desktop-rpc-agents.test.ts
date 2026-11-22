import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import gentleAgents, { type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { isFinished, TASK_EVENT, TASK_STATUS, TaskStore, type ChildResponseObservation, type ChildTokenMeasurement, type TaskRecord } from "../lib/agents-protocol.ts";
import { historyDir, loadStoredTask, saveTask } from "../lib/agents-history.ts";
import { AgentRunner } from "../lib/agents-runner.ts";
import { fakeChild } from "./agents-fake-child.ts";
import { DEFAULT_MAX_BYTES, projectRpcActivity } from "../lib/agents-rpc-publisher.ts";
import {
	AGENT_NOT_FOUND,
	AGENTS_UNAVAILABLE,
	DESKTOP_AGENTS_EVENT,
	DESKTOP_AGENTS_EVENTS,
	DESKTOP_AGENTS_LIST_LIMIT,
	DESKTOP_AGENTS_METHODS,
	DESKTOP_AGENTS_SERVICE_CHANNEL,
	DESKTOP_AGENTS_SERVICE_SCHEMA,
	INVALID_AGENTS_PARAMS,
	accumulateTaskUsage,
	isDesktopAgentsServiceShape,
	parseCancelSubagentParams,
	parseDesktopAgentEntry,
	parseDesktopAgentThread,
	parseGetSubagentThreadParams,
	parseListSubagentsParams,
	projectDesktopAgent,
	projectDesktopAgentThread,
	selectDesktopAgents,
	type DesktopAgentEntry,
	type DesktopAgentsCancelOutcome,
	type DesktopAgentsOwnerRead,
	type DesktopAgentsService,
	type DesktopAgentsThreadOutcome,
	type DesktopAgentThread,
} from "../lib/desktop-rpc-agents.ts";
import { DesktopAgentsBridge, discoverDesktopAgentsService } from "../lib/desktop-agents-service.ts";
import * as probeAgents from "../lib/desktop-rpc-agents.ts";
import { DESKTOP_RPC_SCHEMA, DesktopRpcRouter, type DesktopRpcDomain } from "../lib/desktop-rpc.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// ---- Fixtures: real TaskStore + a fake runner ----

function task(id: string, parentSessionId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		id,
		agent: "worker",
		mode: "task",
		prompt: "the full user prompt must never leak",
		label: "worker",
		cwd: "/secret/repo",
		parentSessionId,
		status: TASK_STATUS.RUNNING,
		createdAt: 1000,
		startedAt: 1000,
		endedAt: null,
		model: "anthropic/claude-probe",
		thinking: "high",
		sessionPath: "/sessions/child.jsonl",
		error: null,
		result: null,
		lastStep: "working",
		lastActivityAt: 1000,
		turns: 1,
		toolCalls: 2,
		tokens: 1234,
		cost: 0.005,
		...overrides,
	};
}

function reported(value: number): ChildTokenMeasurement {
	return Object.freeze({ state: "reported", value });
}

const unavailable = Object.freeze({ state: "unavailable" });

function observation(tokens: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "reasoning", number>> = {}): ChildResponseObservation {
	return Object.freeze({
		provider: Object.freeze({ state: "observed", value: "anthropic" }),
		model: Object.freeze({ state: "observed", value: "claude" }),
		responseModel: Object.freeze({ state: "observed", value: "claude" }),
		providerThinkingLevel: unavailable,
		selected: Object.freeze({ provider: unavailable, model: unavailable, effort: unavailable }),
		stopReason: "stop",
		tokens: Object.freeze({
			input: reported(tokens.input ?? 0),
			output: reported(tokens.output ?? 0),
			cacheRead: reported(tokens.cacheRead ?? 0),
			cacheWrite: reported(tokens.cacheWrite ?? 0),
			totalTokens: reported(0),
			reasoning: reported(tokens.reasoning ?? 0),
		}),
	});
}

interface FakeRunner {
	calls: Array<{ id: string; reason: string; result: boolean }>;
	cancel(id: string, reason: string): boolean;
}

/** A fake `AgentRunner`-shaped stop path that mirrors the real runner's cancel
 * result: a queued task finishes synchronously, a live task is accepted with no
 * synchronous store mutation, and a terminal task is refused. */
function makeRunner(store: TaskStore): FakeRunner {
	const calls: Array<{ id: string; reason: string; result: boolean }> = [];
	return {
		calls,
		cancel(id, reason) {
			const current = store.get(id);
			const result = current !== undefined && !isFinished(current.status);
			calls.push({ id, reason, result });
			if (result && current!.status === TASK_STATUS.QUEUED) {
				store.update(id, { status: TASK_STATUS.CANCELLED, endedAt: 1000, lastStep: "cancelled: stopped from desktop before start" });
			}
			return result;
		},
	};
}

function makeAgentsOwnerService(store: TaskStore, runner: FakeRunner, sessionId = "session-a") {
	const observers = new Set<(sessionId: string) => void>();
	let disposed = false;
	const service: DesktopAgentsService = {
		schema: DESKTOP_AGENTS_SERVICE_SCHEMA,
		read: (): DesktopAgentsOwnerRead => ({ sessionId, agents: disposed ? [] : selectDesktopAgents(store.list(sessionId)) }),
		cancel: (id: string): DesktopAgentsCancelOutcome => {
			if (disposed) return { kind: "not_found" };
			const before = store.get(id);
			if (!before || before.parentSessionId !== sessionId) return { kind: "not_found" };
			const requested = runner.cancel(id, "cancelled: stopped from desktop");
			const after = store.get(id) ?? before;
			const changed = requested && after.status !== before.status;
			return { kind: "ok", agent: projectDesktopAgent(after), requested, changed };
		},
		thread: (id: string): DesktopAgentsThreadOutcome => {
			if (disposed) return { kind: "not_found" };
			const owned = store.get(id);
			if (!owned || owned.parentSessionId !== sessionId) return { kind: "not_found" };
			return { kind: "ok", thread: projectDesktopAgentThread(id, store.thread(id)) };
		},
		observe: (onChange) => { observers.add(onChange); return () => observers.delete(onChange); },
		dispose: () => { disposed = true; observers.clear(); },
	};
	return { service, observers, notify: (id: string) => { for (const observer of [...observers]) observer(id); } };
}

function recordedScheduler() {
	const entries: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	return {
		entries,
		schedule: (fn: () => void, ms: number) => {
			const entry = { fn, ms, cancelled: false };
			entries.push(entry);
			return () => { entry.cancelled = true; };
		},
		pendingCount: () => entries.filter((entry) => !entry.cancelled).length,
		flushAll: () => {
			for (const entry of [...entries]) {
				if (entry.cancelled) continue;
				entry.cancelled = true;
				entry.fn();
			}
		},
	};
}

function makeBridge(service: DesktopAgentsService, sessionId = "session-a", scheduler = recordedScheduler()) {
	const bridge = new DesktopAgentsBridge({} as ExtensionAPI, { discover: async () => service, schedule: scheduler.schedule, coalesceMs: 10 });
	const host = { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
	bridge.attach(host);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	bridge.wire((event, data) => events.push({ event, data }));
	return { bridge, events, scheduler };
}

// ---- Pure contract: usage accumulation ----

test("accumulateTaskUsage sums only reported token breakdowns and ignores unavailable", () => {
	const usage = accumulateTaskUsage([
		observation({ input: 100, output: 40, cacheRead: 30, cacheWrite: 10, reasoning: 5 }),
		observation({ input: 20, output: 10 }),
	]);
	assert.deepEqual(usage, { input: 120, output: 50, cacheRead: 30, cacheWrite: 10, reasoning: 5 });

	// Unavailable measurements contribute nothing.
	const empty = accumulateTaskUsage([]);
	assert.deepEqual(empty, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
});

// ---- Pure contract: projection ----

test("projectDesktopAgent keeps only the whitelist and never prompt/cwd/path/result", () => {
	const record = task("t1", "session-a", {
		modelSource: "binding",
		fallbackFrom: "anthropic/claude-old",
		usage: { input: 100, output: 40, cacheRead: 30, cacheWrite: 10, reasoning: 5 },
	});
	assert.deepEqual(projectDesktopAgent(record), {
		id: "t1",
		agent: "worker",
		status: TASK_STATUS.RUNNING,
		model: "anthropic/claude-probe",
		modelSource: "binding",
		fallbackFrom: "anthropic/claude-old",
		thinking: "high",
		lastStep: "running",
		usage: { total: 1234, cost: 0.005, input: 100, output: 40, cache: 40, reasoning: 5 },
		turns: 1,
		toolCalls: 2,
	});

	const projected = JSON.stringify(projectDesktopAgent(record));
	assert.equal(projected.includes("the full user prompt"), false, "prompt never leaks");
	assert.equal(projected.includes("/secret/repo"), false, "cwd never leaks");
	assert.equal(projected.includes("/sessions/child.jsonl"), false, "session path never leaks");
	assert.equal(projected.includes("result"), false, "result field never leaks");
});

test("projectDesktopAgent omits optional fields and the breakdown when absent", () => {
	const record = task("t1", "session-a");
	assert.deepEqual(projectDesktopAgent(record), {
		id: "t1",
		agent: "worker",
		status: TASK_STATUS.RUNNING,
		model: "anthropic/claude-probe",
		thinking: "high",
		lastStep: "running",
		usage: { total: 1234, cost: 0.005 },
		turns: 1,
		toolCalls: 2,
	});
});

test("projectDesktopAgent projects a closed step and never forwards raw error/path/secret/provider text", () => {
	const record = task("t1", "session-a", {
		status: TASK_STATUS.FAILED,
		endedAt: 2000,
		lastStep: "error: ENOENT /home/secret/.env api_key=sk-live-1234 provider said 'quota exceeded'",
		error: "pi exited with 1 before agent_settled: /tmp/secret.log stderr tail",
		prompt: "original user prompt /etc/passwd",
	});
	const projected = projectDesktopAgent(record);
	assert.equal(projected.status, TASK_STATUS.FAILED);
	assert.equal(projected.lastStep, "failed", "a failed task gets the closed generic reason");
	const json = JSON.stringify(projected);
	for (const secret of ["/home/secret", "/etc/passwd", "sk-live-1234", "quota exceeded", "stderr", "ENOENT", ".env", "/tmp/secret.log", "original user prompt", "api_key"]) {
		assert.equal(json.includes(secret), false, `leaked: ${secret}`);
	}
});

test("projectDesktopAgent keeps only safe active steps and maps everything else to running", () => {
	assert.equal(projectDesktopAgent(task("t1", "s", { status: TASK_STATUS.RUNNING, lastStep: "writing" })).lastStep, "writing");
	assert.equal(projectDesktopAgent(task("t1", "s", { status: TASK_STATUS.RUNNING, lastStep: "generating tool arguments" })).lastStep, "generating tool arguments");
	assert.equal(projectDesktopAgent(task("t1", "s", { status: TASK_STATUS.RUNNING, lastStep: "error: /etc/passwd api_key=sk-live" })).lastStep, "running");
	assert.equal(projectDesktopAgent(task("t1", "s", { status: TASK_STATUS.RUNNING, lastStep: "bash" })).lastStep, "running", "a raw tool name is not a safe step label");
	assert.equal(projectDesktopAgent(task("t1", "s", { status: TASK_STATUS.COMPLETED, endedAt: 2, lastStep: "some raw text" })).lastStep, "completed");
});

test("projectDesktopAgent bounds the freeform name and model fields", () => {
	const record = task("t1", "session-a", { agent: "a".repeat(300), model: "m".repeat(200) });
	const projected = projectDesktopAgent(record);
	assert.ok(projected.agent.length <= 200 && projected.agent.endsWith("…"));
	assert.ok(projected.model.length <= 128 && projected.model.endsWith("…"));
});

// ---- Pure contract: selection ----

test("selectDesktopAgents keeps active first then recent finished, bounded", () => {
	const make = (id: string, status: TaskRecord["status"], endedAt: number | null, lastActivityAt: number): TaskRecord =>
		task(id, "s", { status, endedAt, lastActivityAt });
	const records = [
		make("running-1", TASK_STATUS.RUNNING, null, 5),
		make("waiting-1", TASK_STATUS.WAITING, null, 6),
		make("queued-1", TASK_STATUS.QUEUED, null, 3),
		make("finished-new", TASK_STATUS.COMPLETED, 200, 200),
		make("finished-old", TASK_STATUS.FAILED, 100, 100),
	];
	const selected = selectDesktopAgents(records);
	assert.deepEqual(selected.map((entry) => entry.id), ["running-1", "waiting-1", "queued-1", "finished-new", "finished-old"]);

	const many = Array.from({ length: DESKTOP_AGENTS_LIST_LIMIT + 20 }, (_, i) => make(`t-${i}`, TASK_STATUS.COMPLETED, i + 1, i + 1));
	assert.equal(selectDesktopAgents(many).length, DESKTOP_AGENTS_LIST_LIMIT, "the list is bounded");
});

// ---- Pure contract: params and shape ----

test("params parsers accept only the documented shapes", () => {
	assert.deepEqual(parseListSubagentsParams({}), { ok: true });
	assert.deepEqual(parseListSubagentsParams({ unexpected: true }), { error: INVALID_AGENTS_PARAMS });
	assert.deepEqual(parseCancelSubagentParams({ id: "task-1" }), { id: "task-1" });
	for (const params of [{}, { id: "" }, { id: 1 }, { id: "task-1", extra: true }, { task_id: "task-1" }]) {
		assert.deepEqual(parseCancelSubagentParams(params), { error: INVALID_AGENTS_PARAMS }, JSON.stringify(params));
	}
});

test("isDesktopAgentsServiceShape accepts only the versioned adapter", () => {
	const good = { schema: DESKTOP_AGENTS_SERVICE_SCHEMA, read: () => ({ sessionId: "s", agents: [] }), cancel: () => ({ kind: "not_found" }), observe: () => () => {}, dispose: () => {} };
	assert.equal(isDesktopAgentsServiceShape(good), true);
	assert.equal(isDesktopAgentsServiceShape({ ...good, schema: "gentle-pi.desktop-agents-service/v0" }), false);
	assert.equal(isDesktopAgentsServiceShape({ ...good, cancel: undefined }), false);
	assert.equal(isDesktopAgentsServiceShape(null), false);
	assert.equal(isDesktopAgentsServiceShape("nope"), false);
});

test("parseDesktopAgentEntry re-validates owner entries and drops foreign fields", () => {
	const valid = { id: "t1", agent: "worker", status: "running", model: "anthropic/claude", lastStep: "running", usage: { total: 1, cost: 0 } };
	assert.deepEqual(parseDesktopAgentEntry(valid), { id: "t1", agent: "worker", status: "running", model: "anthropic/claude", lastStep: "running", usage: { total: 1, cost: 0 } });
	assert.deepEqual(
		parseDesktopAgentEntry({ ...valid, modelSource: "binding", fallbackFrom: "m", thinking: "high", usage: { total: 2, cost: 0.1, input: 1, output: 1, cache: 1, reasoning: 1 }, prompt: "secret", cwd: "/etc", sessionPath: "/s" }),
		{ id: "t1", agent: "worker", status: "running", model: "anthropic/claude", modelSource: "binding", fallbackFrom: "m", thinking: "high", lastStep: "running", usage: { total: 2, cost: 0.1, input: 1, output: 1, cache: 1, reasoning: 1 } },
	);
	for (const bad of [
		null,
		{ id: "", agent: "a", status: "running", model: "m", lastStep: "running", usage: { total: 0, cost: 0 } },
		{ id: "t", agent: 1, status: "running", model: "m", lastStep: "running", usage: { total: 0, cost: 0 } },
		{ id: "t", agent: "a", status: "exploded", model: "m", lastStep: "running", usage: { total: 0, cost: 0 } },
		{ id: "t", agent: "a", status: "running", model: "m", lastStep: "error: /etc/passwd", usage: { total: 0, cost: 0 } },
		{ id: "t", agent: "a", status: "running", model: "m", lastStep: "working", usage: { total: 0, cost: 0 } },
		{ id: "t", agent: "a", status: "running", model: "m", lastStep: "running", usage: { total: -1, cost: 0 } },
		{ id: "t", agent: "a", status: "running", model: "m", lastStep: "running", usage: { total: 0, cost: "free" } },
	]) {
		assert.equal(parseDesktopAgentEntry(bad), undefined, JSON.stringify(bad));
	}
});

// ---- Bridge reads ----

test("list_subagents answers the projected active-session list and emits nothing", async () => {
	const store = new TaskStore();
	store.add(task("t1", "session-a"));
	const { service } = makeAgentsOwnerService(store, makeRunner(store));
	const { bridge, events } = makeBridge(service);
	const outcome = await bridge.handle("list_subagents", {});
	assert.equal(outcome.ok, true);
	assert.deepEqual((outcome as { ok: true; data: Record<string, unknown> }).data, {
		agents: [projectDesktopAgent(task("t1", "session-a"))],
	});
	assert.equal(events.length, 0, "a read emits nothing");
});

test("list_subagents filters out foreign sessions", async () => {
	const store = new TaskStore();
	store.add(task("mine", "session-a"));
	store.add(task("theirs", "session-b"));
	const { service } = makeAgentsOwnerService(store, makeRunner(store), "session-a");
	const { bridge } = makeBridge(service, "session-a");
	const outcome = await bridge.handle("list_subagents", {});
	assert.equal(outcome.ok, true);
	const data = (outcome as { ok: true; data: Record<string, unknown> }).data as { agents: DesktopAgentEntry[] };
	assert.deepEqual(data.agents.map((entry) => entry.id), ["mine"]);
});

test("invalid params are rejected before any owner discovery", async () => {
	const store = new TaskStore();
	const { service } = makeAgentsOwnerService(store, makeRunner(store));
	let discoveries = 0;
	const bridge = new DesktopAgentsBridge({} as ExtensionAPI, { discover: async () => { discoveries += 1; return service; } });
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	for (const params of [{ unexpected: true }]) {
		const bad = await bridge.handle("list_subagents", params);
		assert.equal(bad.ok, false);
		assert.deepEqual(bad.error, INVALID_AGENTS_PARAMS);
	}
	for (const params of [{}, { id: "" }, { id: 1 }, { id: "task-1", extra: true }]) {
		const bad = await bridge.handle("cancel_subagent", params);
		assert.equal(bad.ok, false);
		assert.deepEqual(bad.error, INVALID_AGENTS_PARAMS);
	}
	assert.equal(discoveries, 0, "invalid params never reach discovery");
});

test("no owner answers agents_unavailable rather than inventing an empty list", async () => {
	const bridge = new DesktopAgentsBridge({} as ExtensionAPI, { discover: async () => undefined });
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	const outcome = await bridge.handle("list_subagents", {});
	assert.equal(outcome.ok, false);
	assert.deepEqual(outcome.error, AGENTS_UNAVAILABLE);
});

test("a throwing or malformed owner never leaks raw prompt text or paths", async () => {
	const throwing: DesktopAgentsService = {
		schema: DESKTOP_AGENTS_SERVICE_SCHEMA,
		read: () => { throw new Error("secret prompt /etc/passwd"); },
		cancel: () => { throw new Error("secret prompt /etc/passwd"); },
		observe: () => () => {},
		dispose: () => {},
	};
	const { bridge } = makeBridge(throwing);
	const read = await bridge.handle("list_subagents", {});
	assert.equal(read.ok, false);
	assert.equal(JSON.stringify(read).includes("secret prompt"), false);
	assert.deepEqual(read.error, AGENTS_UNAVAILABLE);
	const cancelled = await bridge.handle("cancel_subagent", { id: "t1" });
	assert.equal(cancelled.ok, false);
	assert.equal(JSON.stringify(cancelled).includes("secret prompt"), false);

	// A foreign prompt field on an owner entry is dropped, never echoed.
	const malformed: DesktopAgentsService = {
		schema: DESKTOP_AGENTS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "session-a", agents: [{ id: "t", agent: "a", status: "running", model: "m", lastStep: "running", usage: { total: 0, cost: 0 }, prompt: "rm -rf /" }] as unknown as DesktopAgentEntry[] }),
		cancel: () => ({ kind: "not_found" }),
		observe: () => () => {},
		dispose: () => {},
	};
	const badBridge = makeBridge(malformed);
	const bad = await badBridge.bridge.handle("list_subagents", {});
	assert.equal(bad.ok, true);
	assert.deepEqual((bad as { ok: true; data: Record<string, unknown> }).data, { agents: [{ id: "t", agent: "a", status: "running", model: "m", lastStep: "running", usage: { total: 0, cost: 0 } }] });
	assert.equal(JSON.stringify(bad).includes("rm -rf"), false);
});

// ---- Cancel: the runner.cancel owner path ----

test("cancel_subagent honors the runner result and the actual store transition (queued)", async () => {
	const store = new TaskStore();
	store.add(task("t1", "session-a", { status: TASK_STATUS.QUEUED, startedAt: null }));
	const runner = makeRunner(store);
	const { service } = makeAgentsOwnerService(store, runner);
	const { bridge, events } = makeBridge(service);
	const outcome = await bridge.handle("cancel_subagent", { id: "t1" });
	assert.equal(outcome.ok, true);
	assert.deepEqual(runner.calls, [{ id: "t1", reason: "cancelled: stopped from desktop", result: true }], "the same runner.cancel owner path runs");
	const data = (outcome as { ok: true; data: Record<string, unknown> }).data as { agent: DesktopAgentEntry };
	assert.equal(data.agent.status, TASK_STATUS.CANCELLED, "a queued task transitioned synchronously");
	assert.equal(data.agent.lastStep, "cancelled", "the post-action state is the closed label");
	// A synchronous transition is a real state change: the response carries one event.
	assert.equal((outcome as { ok: true; event?: unknown }).event !== undefined, true, "a synchronous transition emits an agents_update");
	assert.equal(events.length, 0, "the immediate event rides the outcome, not the observer");
});

test("cancel_subagent of an already-terminal task answers terminal state without an error or event", async () => {
	const store = new TaskStore();
	store.add(task("t1", "session-a", { status: TASK_STATUS.COMPLETED, endedAt: 2000 }));
	const runner = makeRunner(store);
	const { service } = makeAgentsOwnerService(store, runner);
	const { bridge, events } = makeBridge(service);
	const outcome = await bridge.handle("cancel_subagent", { id: "t1" });
	assert.equal(outcome.ok, true);
	const data = (outcome as { ok: true; data: Record<string, unknown> }).data as { agent: DesktopAgentEntry };
	assert.equal(data.agent.status, TASK_STATUS.COMPLETED);
	assert.equal(data.agent.lastStep, "completed");
	assert.equal((outcome as { ok: true; event?: unknown }).event, undefined, "a no-op cancel emits nothing");
	assert.equal(events.length, 0, "an already-terminal cancel emits nothing");
	assert.deepEqual(runner.calls, [{ id: "t1", reason: "cancelled: stopped from desktop", result: false }], "the owner path is still the runner's, and its result is honored");
});

test("a running-task cancel is requested but not changed and emits no immediate event (even when repeated)", async () => {
	const store = new TaskStore();
	store.add(task("t1", "session-a", { status: TASK_STATUS.RUNNING }));
	const runner = makeRunner(store);
	const { service } = makeAgentsOwnerService(store, runner);
	const { bridge, events } = makeBridge(service);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const outcome = await bridge.handle("cancel_subagent", { id: "t1" });
		assert.equal(outcome.ok, true);
		const data = (outcome as { ok: true; data: Record<string, unknown> }).data as { agent: DesktopAgentEntry };
		assert.equal(data.agent.status, TASK_STATUS.RUNNING, "a running task's cancellation is asynchronous; the post-action state is still running");
		assert.equal((outcome as { ok: true; event?: unknown }).event, undefined, "no immediate byte-identical agents_update for an in-flight cancel");
	}
	assert.equal(events.length, 0, "the eventual transition emits through the observer, not here");
	assert.deepEqual(runner.calls.map((call) => call.result), [true, true]);
});

test("cancel_subagent unknown and foreign-session ids are typed not_found", async () => {
	const store = new TaskStore();
	store.add(task("t1", "session-b"));
	const runner = makeRunner(store);
	const { service } = makeAgentsOwnerService(store, runner, "session-a");
	const { bridge } = makeBridge(service, "session-a");

	const foreign = await bridge.handle("cancel_subagent", { id: "t1" });
	assert.equal(foreign.ok, false);
	assert.deepEqual(foreign.error, AGENT_NOT_FOUND);

	const unknown = await bridge.handle("cancel_subagent", { id: "t-99" });
	assert.equal(unknown.ok, false);
	assert.deepEqual(unknown.error, AGENT_NOT_FOUND);
	assert.deepEqual(runner.calls, [], "a foreign or unknown id never reaches the runner");
});

// ---- Events: observer-driven transitions, dedupe and coalescing ----

test("agent-driven transitions become one coalesced agents_update filtered by active session", async () => {
	const store = new TaskStore();
	const { service, notify } = makeAgentsOwnerService(store, makeRunner(store), "session-a");
	const { bridge, events, scheduler } = makeBridge(service, "session-a");
	await bridge.handle("list_subagents", {});

	store.add(task("t1", "session-a", { status: TASK_STATUS.QUEUED, startedAt: null }));
	notify("session-a");
	assert.equal(scheduler.pendingCount(), 1, "a change schedules one coalesced flush");
	store.update("t1", { status: TASK_STATUS.RUNNING, startedAt: 1000 });
	notify("session-a");
	assert.equal(scheduler.pendingCount(), 1, "a burst inside the window does not add timers");
	assert.equal(events.length, 0, "nothing is emitted before the flush");

	scheduler.flushAll();
	assert.equal(events.length, 1);
	assert.equal(events[0]!.event, DESKTOP_AGENTS_EVENT);
	assert.deepEqual(events[0]!.data, { agents: [projectDesktopAgent(task("t1", "session-a"))] });

	// A foreign-session change does not reach this bridge.
	store.add(task("t2", "session-b"));
	notify("session-b");
	scheduler.flushAll();
	assert.equal(events.length, 1, "a foreign session change is filtered out");
});

test("byte-identical projected content is deduped across flushes", async () => {
	const store = new TaskStore();
	store.add(task("t1", "session-a"));
	const { service, notify } = makeAgentsOwnerService(store, makeRunner(store), "session-a");
	const { bridge, events, scheduler } = makeBridge(service, "session-a");
	await bridge.handle("list_subagents", {});

	notify("session-a");
	scheduler.flushAll();
	assert.equal(events.length, 1);

	notify("session-a");
	scheduler.flushAll();
	assert.equal(events.length, 1, "identical content emits once");
});

test("session reset disconnects observers and drops stale async outcomes", async () => {
	const observers = new Set<(sessionId: string) => void>();
	const service: DesktopAgentsService = {
		schema: DESKTOP_AGENTS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "session-a", agents: [] }),
		cancel: () => ({ kind: "not_found" }),
		observe: (onChange) => { observers.add(onChange); return () => observers.delete(onChange); },
		dispose: () => { observers.clear(); },
	};
	let releaseService: (value: DesktopAgentsService) => void = () => {};
	const serviceGate = new Promise<DesktopAgentsService>((resolve) => { releaseService = resolve; });
	const scheduler = recordedScheduler();
	const bridge = new DesktopAgentsBridge({} as ExtensionAPI, { discover: () => serviceGate, schedule: scheduler.schedule, coalesceMs: 10 });
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	bridge.wire((event, data) => events.push({ event, data }));

	const pending = bridge.handle("list_subagents", {});
	bridge.reset();
	for (const observer of [...observers]) observer("session-a");
	scheduler.flushAll();
	assert.equal(events.length, 0, "a disposed session never delivers a change");
	releaseService(service);
	const outcome = await pending;
	assert.equal(outcome.ok, false);
	assert.deepEqual(outcome.error, AGENTS_UNAVAILABLE);
});

test("a late discovery after reset is disposed and never cached for the next session", async () => {
	const disposed: string[] = [];
	const service: DesktopAgentsService = {
		schema: DESKTOP_AGENTS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "session-a", agents: [] }),
		cancel: () => ({ kind: "not_found" }),
		observe: () => () => {},
		dispose: () => { disposed.push("old"); },
	};
	let releaseOld: (value: DesktopAgentsService) => void = () => {};
	const oldGate = new Promise<DesktopAgentsService>((resolve) => { releaseOld = resolve; });
	let discoverCount = 0;
	const bridge = new DesktopAgentsBridge({} as ExtensionAPI, {
		discover: () => { discoverCount += 1; return discoverCount === 1 ? oldGate : Promise.resolve(service); },
	});
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	const first = bridge.handle("list_subagents", {});
	bridge.reset();
	releaseOld(service);
	const firstOutcome = await first;
	assert.equal(firstOutcome.ok, false);
	assert.deepEqual(disposed, ["old"], "the late adapter is disposed, never cached");
});

// ---- Discovery ----

test("discoverDesktopAgentsService accepts the versioned adapter and ignores malformed responders", async () => {
	const listeners = new Map<string, (value: unknown) => void>();
	const pi = {
		events: {
			on(name: string, handler: (value: unknown) => void) { listeners.set(name, handler); return () => listeners.delete(name); },
			emit(name: string, value: unknown) { listeners.get(name)?.(value); },
		},
	} as unknown as ExtensionAPI;
	const ctx = {} as ExtensionContext;

	listeners.set(DESKTOP_AGENTS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({
			schema: DESKTOP_AGENTS_SERVICE_SCHEMA,
			read: () => ({ sessionId: "s", agents: [] }),
			cancel: () => ({ kind: "not_found" }),
			observe: () => () => {},
			dispose: () => {},
		});
	});
	const service = await discoverDesktopAgentsService(pi, ctx);
	assert.equal(service?.schema, DESKTOP_AGENTS_SERVICE_SCHEMA);

	listeners.set(DESKTOP_AGENTS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({ schema: "gentle-pi.desktop-agents-service/v0", read: () => ({ sessionId: "s", agents: [] }) });
	});
	assert.equal(await discoverDesktopAgentsService(pi, ctx), undefined);
});

// ---- Router sequencing: response before event ----

test("the router publishes a changed cancel response before its agents_update event", async () => {
	const store = new TaskStore();
	store.add(task("t1", "session-a", { status: TASK_STATUS.QUEUED, startedAt: null }));
	const { service } = makeAgentsOwnerService(store, makeRunner(store));
	const bridge = new DesktopAgentsBridge({} as ExtensionAPI, { discover: async () => service, schedule: () => () => {}, coalesceMs: 10 });
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	const domain: DesktopRpcDomain = (method, params) => bridge.handle(method, params as Record<string, unknown>);
	const lines: string[] = [];
	const router = new DesktopRpcRouter(
		["capabilities", "get_snapshot", ...DESKTOP_AGENTS_METHODS],
		[...DESKTOP_AGENTS_EVENTS],
		undefined,
		domain,
	);
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "cancel-1", method: "cancel_subagent", params: { id: "t1" } }));
	assert.deepEqual(lines.map((line) => JSON.parse(line).kind), ["response", "event"]);
	assert.equal(JSON.parse(lines[0]!).requestId, "cancel-1");
	assert.equal(JSON.parse(lines[1]!).event, DESKTOP_AGENTS_EVENT);
});

// ---- get_subagent_thread ----

type ThreadData = { ok: true; data: DesktopAgentThread };

/** A store whose task t1 (session-a) has more items than the window, evicted items, and oversize fields. */
function threadStore(maxItems = 60) {
	const store = new TaskStore({ maxItems });
	store.add(task("t1", "session-a"));
	store.add(task("theirs", "session-b"));
	store.apply("theirs", { type: TASK_EVENT.NOTE, text: "foreign session note" }, 1001);
	for (let index = 0; index < 70; index += 1) {
		store.apply("t1", { type: TASK_EVENT.NOTE, text: `note ${index}` }, 1001);
		store.apply("t1", { type: TASK_EVENT.TOOL_START, callId: `c${index}`, name: "bash", args: { command: "x".repeat(900) } }, 1001);
		store.apply("t1", { type: TASK_EVENT.TOOL_END, callId: `c${index}`, output: "y".repeat(900), isError: index % 2 === 0 }, 1001);
	}
	store.apply("t1", { type: TASK_EVENT.TEXT, text: "z".repeat(5000) }, 1002);
	return store;
}

test("parseGetSubagentThreadParams accepts only { id, sinceVersion? }", () => {
	assert.deepEqual(parseGetSubagentThreadParams({ id: "t1" }), { id: "t1" });
	assert.deepEqual(parseGetSubagentThreadParams({ id: "t1", sinceVersion: 0 }), { id: "t1", sinceVersion: 0 });
	assert.deepEqual(parseGetSubagentThreadParams({ id: "t1", sinceVersion: 12 }), { id: "t1", sinceVersion: 12 });
	for (const params of [{}, { id: "" }, { id: 1 }, { id: "t1", extra: true }, { task_id: "t1" }, { id: "t1", sinceVersion: -1 }, { id: "t1", sinceVersion: 1.5 }, { id: "t1", sinceVersion: "3" }, { id: "t1", sinceVersion: null }, { id: "t1", sinceVersion: Number.NaN }]) {
		assert.deepEqual(parseGetSubagentThreadParams(params), { error: INVALID_AGENTS_PARAMS }, JSON.stringify(params));
	}
});

test("projectDesktopAgentThread is the widget's exact thread projection and bounds", () => {
	const store = threadStore();
	const widget = projectRpcActivity(store, { parentSessionId: "session-a" }).tasks.find((entry) => entry.summary.id === "t1")!.thread;
	const thread = projectDesktopAgentThread("t1", store.thread("t1"));
	assert.equal(thread.id, "t1");
	assert.deepEqual({ version: thread.version, dropped: thread.dropped, items: thread.items }, widget, "the method and gentle-agents.activity/v1 never disagree");
	assert.equal(thread.items.length, 40, "the widget's 40-item window");
	assert.equal(thread.version, store.thread("t1").version);
	assert.equal(thread.dropped, store.thread("t1").dropped);
	assert.ok(thread.dropped > 0, "the store evicted items beyond its own maxItems");
	assert.equal(thread.truncated, true, "the store holds more items than the window");
	const text = thread.items.at(-1)!;
	assert.equal(text.kind, "text");
	assert.equal((text as { text: string }).text.length, 2000, "text items keep the 2000-char bound");
	const tool = thread.items.find((item) => item.kind === "tool") as { args: string; output: string; callId?: unknown };
	assert.equal(tool.args.length, 500, "tool args keep the 500-char bound");
	assert.equal(tool.output.length, 500, "tool output keeps the 500-char bound");
	assert.equal(tool.callId, undefined, "the raw callId is not whitelisted");
});

test("projectDesktopAgentThread reports truncated only when the window cut items", () => {
	const store = new TaskStore();
	store.add(task("t1", "session-a"));
	store.apply("t1", { type: TASK_EVENT.NOTE, text: "one" }, 1001);
	const thread = projectDesktopAgentThread("t1", store.thread("t1"));
	assert.deepEqual(thread, { id: "t1", version: 1, items: [{ kind: "note", text: "one" }], dropped: 0, truncated: false });
});

test("projectDesktopAgentThread halves items under the activity byte bound", () => {
	const store = new TaskStore();
	store.add(task("t1", "session-a"));
	for (let index = 0; index < 40; index += 1) store.apply("t1", { type: TASK_EVENT.NOTE, text: `${"n".repeat(1990)}${index}` }, 1001);
	assert.equal(projectDesktopAgentThread("t1", store.thread("t1")).items.length, 40, "under the default 256 KB bound the whole window fits");
	assert.equal(DEFAULT_MAX_BYTES, 256 * 1024);
	const maxBytes = 9000;
	const thread = projectDesktopAgentThread("t1", store.thread("t1"), maxBytes);
	assert.ok(Buffer.byteLength(JSON.stringify({ version: thread.version, dropped: thread.dropped, items: thread.items })) <= maxBytes);
	assert.equal(thread.items.length, 2, "40 → 20 → 10 → 5 → 2, the activity encoder's halving");
	assert.equal(thread.truncated, true);
	assert.deepEqual(thread.items.map((item) => (item as { text: string }).text.slice(1990)), ["38", "39"], "the most recent items are kept");
});

test("parseDesktopAgentThread re-validates the owner thread and drops foreign fields", () => {
	const valid = { id: "t1", version: 3, dropped: 0, truncated: false, items: [{ kind: "text", text: "hi" }, { kind: "tool", name: "bash", args: "{}", running: false, isError: false, output: "ok" }] };
	assert.deepEqual(parseDesktopAgentThread({ ...valid, cwd: "/secret", items: [{ kind: "text", text: "hi", raw: "x" }, { kind: "tool", name: "bash", args: "{}", running: false, isError: false, output: "ok", callId: "c1" }] }), valid);
	for (const bad of [
		null,
		{ ...valid, id: "" },
		{ ...valid, version: -1 },
		{ ...valid, dropped: 1.5 },
		{ ...valid, truncated: "no" },
		{ ...valid, items: "nope" },
		{ ...valid, items: [{ kind: "image", text: "x" }] },
		{ ...valid, items: [{ kind: "text", text: "x".repeat(2001) }] },
		{ ...valid, items: [{ kind: "tool", name: "bash", args: "x".repeat(501), running: false, isError: false, output: "" }] },
		{ ...valid, items: [{ kind: "tool", name: "bash", args: "{}", running: false, isError: false, output: "x".repeat(501) }] },
		{ ...valid, items: [{ kind: "tool", name: "bash", args: "{}", running: "no", isError: false, output: "" }] },
	]) {
		assert.equal(parseDesktopAgentThread(bad), undefined, JSON.stringify(bad).slice(0, 120));
	}
});

test("get_subagent_thread answers the owned thread and emits nothing", async () => {
	const store = threadStore();
	const { service } = makeAgentsOwnerService(store, makeRunner(store));
	const { bridge, events, scheduler } = makeBridge(service);
	const outcome = await bridge.handle("get_subagent_thread", { id: "t1" });
	assert.equal(outcome.ok, true);
	assert.deepEqual((outcome as unknown as ThreadData).data, projectDesktopAgentThread("t1", store.thread("t1")));
	assert.deepEqual(Object.keys((outcome as unknown as ThreadData).data).sort(), ["dropped", "id", "items", "truncated", "version"]);
	assert.equal((outcome as { event?: unknown }).event, undefined, "a read carries no event");
	assert.equal(events.length, 0, "a read emits nothing");
	assert.equal(scheduler.pendingCount(), 0, "a read schedules nothing");
	assert.equal(store.get("t1")!.status, TASK_STATUS.RUNNING, "a read changes nothing");
});

test("get_subagent_thread sinceVersion returns no items when unchanged and the window after a change", async () => {
	const store = new TaskStore();
	store.add(task("t1", "session-a"));
	store.apply("t1", { type: TASK_EVENT.NOTE, text: "first" }, 1001);
	const { service } = makeAgentsOwnerService(store, makeRunner(store));
	const { bridge, events } = makeBridge(service);
	const first = (await bridge.handle("get_subagent_thread", { id: "t1" })) as unknown as ThreadData;
	assert.deepEqual(first.data, { id: "t1", version: 1, items: [{ kind: "note", text: "first" }], dropped: 0, truncated: false });

	const unchanged = (await bridge.handle("get_subagent_thread", { id: "t1", sinceVersion: first.data.version })) as unknown as ThreadData;
	assert.deepEqual(unchanged.data, { id: "t1", version: 1, items: [], dropped: 0, truncated: false }, "nothing newer than the client's last read");

	// Streamed text merges into the last item in place, so the changed window is returned.
	store.apply("t1", { type: TASK_EVENT.TEXT, text: "hel" }, 1002);
	store.apply("t1", { type: TASK_EVENT.TEXT, text: "lo" }, 1003);
	const changed = (await bridge.handle("get_subagent_thread", { id: "t1", sinceVersion: first.data.version })) as unknown as ThreadData;
	assert.deepEqual(changed.data, { id: "t1", version: 3, items: [{ kind: "note", text: "first" }, { kind: "text", text: "hello" }], dropped: 0, truncated: false });

	const ahead = (await bridge.handle("get_subagent_thread", { id: "t1", sinceVersion: 99 })) as unknown as ThreadData;
	assert.equal(ahead.data.items.length, 2, "a version the store never reached is not trusted: the whole window answers");
	assert.equal(events.length, 0);
});

test("get_subagent_thread unknown and foreign-session ids are typed not_found", async () => {
	const store = threadStore();
	const { service } = makeAgentsOwnerService(store, makeRunner(store), "session-a");
	const { bridge, events } = makeBridge(service, "session-a");
	for (const id of ["theirs", "t-99"]) {
		const outcome = await bridge.handle("get_subagent_thread", { id });
		assert.equal(outcome.ok, false, id);
		assert.deepEqual(outcome.error, AGENT_NOT_FOUND, id);
		assert.doesNotMatch(JSON.stringify(outcome), /foreign session note/);
	}
	assert.equal(events.length, 0);
});

test("get_subagent_thread rejects invalid params before any owner discovery", async () => {
	const store = threadStore();
	const { service } = makeAgentsOwnerService(store, makeRunner(store));
	let discoveries = 0;
	const bridge = new DesktopAgentsBridge({} as ExtensionAPI, { discover: async () => { discoveries += 1; return service; } });
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	for (const params of [{}, { id: "" }, { id: "t1", extra: true }, { id: "t1", sinceVersion: -1 }, { id: "t1", sinceVersion: "1" }]) {
		const bad = await bridge.handle("get_subagent_thread", params);
		assert.equal(bad.ok, false);
		assert.deepEqual(bad.error, INVALID_AGENTS_PARAMS, JSON.stringify(params));
	}
	assert.equal(discoveries, 0, "invalid params never reach discovery");
});

test("get_subagent_thread answers agents_unavailable for an absent, older, throwing, or malformed owner without leaking", async () => {
	const absent = new DesktopAgentsBridge({} as ExtensionAPI, { discover: async () => undefined });
	absent.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	const missing = await absent.handle("get_subagent_thread", { id: "t1" });
	assert.equal(missing.ok, false);
	assert.deepEqual(missing.error, AGENTS_UNAVAILABLE);

	const base: DesktopAgentsService = { schema: DESKTOP_AGENTS_SERVICE_SCHEMA, read: () => ({ sessionId: "session-a", agents: [] }), cancel: () => ({ kind: "not_found" as const }), observe: () => () => {}, dispose: () => {} };
	const older: DesktopAgentsService = { ...base };
	const throwing: DesktopAgentsService = { ...base, thread: () => { throw new Error("ENOENT /home/me/.pi/sessions/secret.jsonl sk-ant-secret"); } };
	const malformed: DesktopAgentsService = { ...base, thread: () => ({ kind: "ok", thread: { id: "t1", version: 1, dropped: 0, truncated: false, items: [{ kind: "text", text: "x".repeat(5000) }] } as unknown as DesktopAgentThread }) };
	const wrongId: DesktopAgentsService = { ...base, thread: () => ({ kind: "ok", thread: { id: "other", version: 1, dropped: 0, truncated: false, items: [] } }) };
	for (const service of [older, throwing, malformed, wrongId]) {
		const { bridge, events } = makeBridge(service);
		const outcome = await bridge.handle("get_subagent_thread", { id: "t1" });
		assert.equal(outcome.ok, false);
		assert.deepEqual(outcome.error, AGENTS_UNAVAILABLE);
		assert.doesNotMatch(JSON.stringify(outcome), /secret|ENOENT|xxxxx/);
		assert.equal(events.length, 0);
	}
	assert.equal(isDesktopAgentsServiceShape(older), true, "an adapter without thread still serves list/cancel");
	assert.equal(isDesktopAgentsServiceShape({ ...base, thread: "nope" }), false, "a non-function thread is not the adapter");
});

test("get_subagent_thread through the router publishes exactly one response line", async () => {
	const store = threadStore();
	const { service } = makeAgentsOwnerService(store, makeRunner(store));
	const bridge = new DesktopAgentsBridge({} as ExtensionAPI, { discover: async () => service, schedule: () => () => {}, coalesceMs: 10 });
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	const domain: DesktopRpcDomain = (method, params) => bridge.handle(method, params as Record<string, unknown>);
	const lines: string[] = [];
	const router = new DesktopRpcRouter(["capabilities", "get_snapshot", ...DESKTOP_AGENTS_METHODS], [...DESKTOP_AGENTS_EVENTS], undefined, domain);
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "thread-2", method: "get_subagent_thread", params: { id: "t1" } }));
	assert.equal(lines.length, 1);
	const response = JSON.parse(lines[0]!);
	assert.equal(response.kind, "response");
	assert.equal(response.ok, true);
	assert.deepEqual(response.data, projectDesktopAgentThread("t1", store.thread("t1")));
});

// ---- Transport: capabilities and owner absence ----

function desktopHarness(t: test.TestContext) {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: any) => void>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { events.set(name, handler); },
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	const widgets: Array<{ key: string; lines: string[] }> = [];
	const ctx = { mode: "rpc", ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } } };
	events.get("session_start")?.({}, ctx);
	return { commands, events, ctx, widgets };
}

test("the Desktop transport advertises the agents methods and event", (t) => {
	const app = desktopHarness(t);
	app.commands.get("gentle:desktop")!.handler(
		JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "cap-1", method: "capabilities", params: {} }),
		app.ctx,
	);
	const response = JSON.parse(app.widgets[0]!.lines[0]!);
	assert.deepEqual(response.data.methods, [
		"capabilities",
		"get_snapshot",
		"get_config",
		"set_config",
		"get_permission_mode",
		"set_permission_mode",
		"get_subscription_usage",
		"refresh_subscription_usage",
		"get_design_canvas",
		"list_jobs",
		"cancel_job",
		"get_job_output",
		"apply_profile",
		"list_subagents",
		"cancel_subagent",
		"get_subagent_thread",
		"list_sessions",
		"switch_session",
		"get_changes",
		"get_change_diff",
		"get_review_mode",
		"set_review_mode",
		"get_usage_stats",
		"get_update_status",
		"list_agent_definitions",
		"get_status",
		"get_background_subagents",
		"set_background_subagents",
		"get_profile_binding",
		"clear_profile_binding",
		"get_auth_status",
		"reload_credentials",
	]);
	assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed"]);
});

test("get_subagent_thread answers agents_unavailable through the transport without an owner extension", async (t) => {
	const app = desktopHarness(t);
	await app.commands.get("gentle:desktop")!.handler(
		JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "thread-1", method: "get_subagent_thread", params: { id: "t1" } }),
		app.ctx,
	);
	assert.equal(app.widgets.length, 1, "exactly one response line and no event");
	const response = JSON.parse(app.widgets[0]!.lines[0]!);
	assert.equal(response.kind, "response");
	assert.equal(response.requestId, "thread-1");
	assert.equal(response.ok, false);
	assert.deepEqual(response.error, AGENTS_UNAVAILABLE);
});

test("list_subagents answers agents_unavailable through the transport without an owner extension", async (t) => {
	const app = desktopHarness(t);
	await app.commands.get("gentle:desktop")!.handler(
		JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "agents-1", method: "list_subagents", params: {} }),
		app.ctx,
	);
	const response = JSON.parse(app.widgets[0]!.lines[0]!);
	assert.equal(response.ok, false);
	assert.deepEqual(response.error, AGENTS_UNAVAILABLE);
});

// ---- Real owner: the gentle-agents agents seam ----

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

interface RealOwnerHarness {
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	listeners: Map<string, Set<(data: unknown) => void>>;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	service: DesktopAgentsService;
	tools: Map<string, any>;
	children: ReturnType<typeof fakeChild>[];
	tasksDir: string;
}

/**
 * Instantiates the real `gentleAgents` extension (the actual owner seam, real
 * `TaskStore`, and real `AgentRunner`) with a fake host and a fake child spawn
 * (never a real process), then discovers the real owner service. A minimal
 * `worker` agent definition is written into the agent home so `subagent_run`
 * can launch a real background task.
 */
async function realOwnerHarness(t: test.TestContext, options: { schedule?: (fn: () => void, ms: number) => () => void } = {}): Promise<RealOwnerHarness> {
	const root = mkdtempSync(join(tmpdir(), "desktop-rpc-agents-real-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
	const home = join(root, "home");
	const agentHome = join(root, "agent");
	const cwd = join(root, "workspace");
	const configHome = join(root, "config");
	const jobOutputDir = join(root, "job-output");
	for (const directory of [home, agentHome, cwd, configHome, jobOutputDir]) mkdirSync(directory, { recursive: true });
	mkdirSync(join(agentHome, "agents"), { recursive: true });
	writeFileSync(join(agentHome, "agents", "explore.md"), "---\ndescription: explore\ntools: [read]\n---\nExplore.");

	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const tools = new Map<string, any>();
	const children: ReturnType<typeof fakeChild>[] = [];
	const pi = {
		appendEntry: () => {},
		registerMarkdownTransformer: () => {},
		events: {
			emit: (name: string, data: unknown) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(data); },
			on: (name: string, listener: (data: unknown) => void) => {
				const set = listeners.get(name) ?? new Set();
				listeners.set(name, set);
				set.add(listener);
				return () => { set.delete(listener); };
			},
		},
		sendMessage: () => {},
		sendUserMessage: () => {},
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerShortcut: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		model: { provider: "claude-bridge", id: "claude-probe" },
		sessionManager: {
			getSessionId: () => "session-a",
			getCwd: () => cwd,
			getEntries: () => [],
			getBranch: () => [],
			getSessionFile: () => undefined,
			getSessionName: () => "test",
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			custom: async () => {},
			setWidget: () => {},
			select: async () => undefined,
			confirm: async () => true,
			input: async () => undefined,
			editor: async () => "edited",
		},
		isIdle: () => true,
	} as unknown as ExtensionContext;

	const inertSessionTransport: SessionTransportFactory = {
		createRegistry: async () => ({ list: async () => [], listActivations: async () => [] }),
		createListener: (registry) => ({ registry, start: async () => {}, close: async () => {} }),
		createClient: () => ({ close() {}, sendNotification: async () => { throw new Error("inert transport must not send"); } }),
	};

	gentleAgents(pi, { GENTLE_PI_CONFIG_HOME: configHome, PATH: process.env.PATH ?? "" }, {
		home,
		agentHome,
		env: { GENTLE_PI_CONFIG_HOME: configHome, PATH: process.env.PATH ?? "" },
		schedule: options.schedule ?? (() => () => {}),
		now: () => 1000,
		jobShell: () => { throw new Error("real-owner agents harness must not run jobs"); },
		jobOutputDir: () => jobOutputDir,
		sessionTransport: inertSessionTransport,
		resolveWorktree: (path: string, base: string) => ({ root: resolve(base, path), commonDir: "/fixture/common" }),
		spawn: () => {
			const child = fakeChild();
			children.push(child);
			return child.child;
		},
		pi: { command: "pi", args: [] },
	});

	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "new" }, ctx);

	const service = await discoverDesktopAgentsService(pi, ctx);
	assert.ok(service, "the real owner seam must answer in-process");
	return { pi, ctx, service, tools, children, tasksDir: historyDir(home, agentHome), handlers, listeners };
}

async function launchBackgroundTask(h: RealOwnerHarness): Promise<string> {
	const run = h.tools.get("subagent_run")!;
	const result = await run.execute("run", { agent: "explore", task: "Map the repo", mode: "background" }, undefined, undefined, h.ctx);
	await tick();
	const taskId = (result.details.gentleAgents as { taskId: string }).taskId;
	assert.equal(h.children.length, 1, "the background task spawned exactly one child");
	return taskId;
}

test("the real owner serves a truthful empty subagent list and a typed not_found cancel", async (t) => {
	const { service } = await realOwnerHarness(t);
	assert.deepEqual(service.read(), { sessionId: "session-a", agents: [] }, "no subagents exist, so the list is empty rather than fabricated");
	assert.deepEqual(service.cancel("unknown-id"), { kind: "not_found" }, "an unknown id is a typed not_found, never a spawn");
	assert.deepEqual(service.cancel(""), { kind: "not_found" });
});

test("saveTask/loadStoredTask retain the final usage breakdown across restore", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "desktop-rpc-agents-history-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const record = task("t1", "session-a", {
		status: TASK_STATUS.COMPLETED,
		endedAt: 2000,
		usage: { input: 100, output: 40, cacheRead: 30, cacheWrite: 10, reasoning: 5 },
	});
	await saveTask(dir, record, { items: [], dropped: 0, version: 0, limits: { maxItems: 400, maxOutputChars: 16000 } });
	const stored = await loadStoredTask(dir, "t1");
	assert.ok(stored);
	assert.deepEqual(stored.task.usage, { input: 100, output: 40, cacheRead: 30, cacheWrite: 10, reasoning: 5 });
	assert.deepEqual(projectDesktopAgent(stored.task).usage, { total: 1234, cost: 0.005, input: 100, output: 40, cache: 40, reasoning: 5 });
});

test("the real owner cancels a live task through runner.cancel and emits one eventual agents_update", async (t) => {
	const h = await realOwnerHarness(t);
	const originalCancel = AgentRunner.prototype.cancel;
	const cancelCalls: Array<{ id: string; reason: string; result: boolean }> = [];
	t.mock.method(AgentRunner.prototype, "cancel", function (this: AgentRunner, id: string, reason: string) {
		const result = originalCancel.call(this, id, reason);
		cancelCalls.push({ id, reason, result });
		return result;
	});

	const taskId = await launchBackgroundTask(h);
	const scheduler = recordedScheduler();
	const bridge = new DesktopAgentsBridge(h.pi, { discover: async () => h.service, schedule: scheduler.schedule, coalesceMs: 10 });
	bridge.attach(h.ctx);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	bridge.wire((event, data) => events.push({ event, data }));
	await bridge.start();

	const list = await bridge.handle("list_subagents", {});
	assert.equal(list.ok, true);
	assert.deepEqual(((list as { ok: true; data: Record<string, unknown> }).data as { agents: DesktopAgentEntry[] }).agents.map((entry) => entry.status), [TASK_STATUS.RUNNING]);

	const cancel = await bridge.handle("cancel_subagent", { id: taskId });
	assert.equal(cancel.ok, true);
	const data = (cancel as { ok: true; data: Record<string, unknown> }).data as { agent: DesktopAgentEntry };
	assert.equal(data.agent.status, TASK_STATUS.RUNNING, "the post-action state is still running: cancellation is asynchronous");
	assert.equal((cancel as { ok: true; event?: unknown }).event, undefined, "no immediate byte-identical agents_update for an in-flight cancel");
	assert.deepEqual(cancelCalls, [{ id: taskId, reason: "cancelled: stopped from desktop", result: true }], "the real runner.cancel path ran and its result is honored");
	assert.equal(events.length, 0);

	// The cancel's SIGTERM already propagated the child exit into a real
	// store transition; the observer scheduled exactly one coalesced flush.
	scheduler.flushAll();
	assert.equal(events.length, 1, "exactly one eventual agents_update for the real transition");
	assert.equal(events[0]!.event, DESKTOP_AGENTS_EVENT);
	assert.deepEqual((events[0]!.data as { agents: DesktopAgentEntry[] }).agents.map((entry) => entry.status), [TASK_STATUS.CANCELLED]);
	assert.deepEqual((events[0]!.data as { agents: DesktopAgentEntry[] }).agents.map((entry) => entry.lastStep), ["cancelled"]);
});

test("the real owner persists the final usage breakdown so restored finished tasks retain it", async (t) => {
	const h = await realOwnerHarness(t);
	const taskId = await launchBackgroundTask(h);

	// Record a final-assistant observation with a token breakdown, then settle.
	h.children[0]!.emit({ type: "message_end", message: { role: "assistant", model: "gpt-4o", provider: "openai", providerThinkingLevel: "low", stopReason: "stop", usage: { input: 100, output: 40, cacheRead: 30, cacheWrite: 10, totalTokens: 180, reasoning: 5 } } });
	h.children[0]!.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	h.children[0]!.emit({ type: "agent_settled" });
	await tick();
	await tick();
	await settle();

	const stored = await loadStoredTask(h.tasksDir, taskId);
	assert.ok(stored, "the finished task was persisted");
	assert.equal(stored.task.status, TASK_STATUS.COMPLETED);
	assert.deepEqual(stored.task.usage, { input: 100, output: 40, cacheRead: 30, cacheWrite: 10, reasoning: 5 });
});

test("the real owner serves an owned thread through the activity projection and not_found otherwise", async (t) => {
	const h = await realOwnerHarness(t);
	assert.deepEqual(h.service.thread!("unknown-id"), { kind: "not_found" });
	const taskId = await launchBackgroundTask(h);
	h.children[0]!.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "mapping the repo" } });
	h.children[0]!.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "README.md" } });
	h.children[0]!.emit({ type: "tool_execution_end", toolCallId: "call-1", result: { content: [{ type: "text", text: "w".repeat(800) }] }, isError: false });
	await tick();

	const outcome = h.service.thread!(taskId);
	assert.equal(outcome.kind, "ok");
	const thread = (outcome as { kind: "ok"; thread: DesktopAgentThread }).thread;
	assert.deepEqual(thread.items, [
		{ kind: "text", text: "mapping the repo" },
		{ kind: "tool", name: "read", args: JSON.stringify({ path: "README.md" }), running: false, isError: false, output: `${"w".repeat(499)}…` },
	]);
	assert.equal(thread.dropped, 0);
	assert.equal(thread.truncated, false);
	assert.ok(thread.version > 0);

	const bridge = new DesktopAgentsBridge(h.pi, { discover: async () => h.service, schedule: () => () => {} });
	bridge.attach(h.ctx);
	const read = (await bridge.handle("get_subagent_thread", { id: taskId })) as unknown as ThreadData;
	assert.deepEqual(read.data, thread);
	const again = (await bridge.handle("get_subagent_thread", { id: taskId, sinceVersion: thread.version })) as unknown as ThreadData;
	assert.deepEqual(again.data.items, []);

	// The same ownership rule as cancel: a session-b context never reads session-a's thread.
	const foreignCtx = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "session-b" } } as unknown as ExtensionContext;
	const foreign = await discoverDesktopAgentsService(h.pi, foreignCtx);
	assert.ok(foreign);
	assert.deepEqual(foreign.thread!(taskId), { kind: "not_found" });
});

test("a shut-down owner leaves the agents service channel and never answers discovery", async (t) => {
	const harness = await realOwnerHarness(t);
	assert.equal(harness.listeners.get(DESKTOP_AGENTS_SERVICE_CHANNEL)?.size, 1, "one owner answers while the session is live");
	for (const handler of harness.handlers.get("session_shutdown") ?? []) await handler({}, harness.ctx);
	assert.equal(harness.listeners.get(DESKTOP_AGENTS_SERVICE_CHANNEL)?.size ?? 0, 0, "the owner subscription is removed on shutdown");
	let answered = 0;
	harness.pi.events.emit(DESKTOP_AGENTS_SERVICE_CHANNEL, { context: harness.ctx, respond: () => { answered += 1; } });
	assert.equal(answered, 0, "a replaced runtime is never discovered through the old owner");
});

// ---- get_subagent_thread: independent verifier probes (regression) ----
function probeTask(id: string, parentSessionId: string, o: any = {}) {
	return { id, agent: "w", mode: "task", prompt: "SECRETPROMPT", label: "p", cwd: "/r", parentSessionId, status: TASK_STATUS.RUNNING, createdAt: 1, startedAt: 1, endedAt: null, model: "m", thinking: undefined, sessionPath: "/s.jsonl", error: null, result: null, lastStep: "x", lastActivityAt: 1, turns: 0, toolCalls: 0, tokens: 0, cost: 0, ...o };
}
function probeOwner(store: any, sessionId = "session-a", over: any = {}) {
	let disposed = false;
	let discoveries = 0;
	const service: any = {
		schema: probeAgents.DESKTOP_AGENTS_SERVICE_SCHEMA,
		read: () => ({ sessionId, agents: probeAgents.selectDesktopAgents(store.list(sessionId)) }),
		cancel: () => ({ kind: "not_found" }),
		thread: (id: string) => {
			if (disposed) return { kind: "not_found" };
			const t = store.get(id);
			if (!t || t.parentSessionId !== sessionId) return { kind: "not_found" };
			return { kind: "ok", thread: probeAgents.projectDesktopAgentThread(id, store.thread(id)) };
		},
		observe: () => () => {},
		dispose: () => { disposed = true; },
		...over,
	};
	return { service, count: () => discoveries, discover: async () => { discoveries++; return service; } };
}
function probeBridge(o: any, sessionId = "session-a") {
	const b = new DesktopAgentsBridge({} as any, { discover: o.discover, schedule: () => () => {}, coalesceMs: 1 });
	b.attach({ sessionManager: { getSessionId: () => sessionId } } as any);
	const events: any[] = [];
	b.wire((e: string) => events.push(e));
	return { b, events };
}
function probeSeeded() {
	const store = new TaskStore();
	store.add(probeTask("mine", "session-a"));
	store.add(probeTask("theirs", "session-b"));
	store.add(probeTask("grandchild", "child-session-of-mine"));
	store.apply("mine", { type: "text", text: "hello" }, 2);
	store.apply("theirs", { type: "tool_start", callId: "c", name: "bash", args: { cmd: "cat ~/.ssh/id_rsa" } }, 2);
	store.apply("grandchild", { type: "note", text: "nested" }, 2);
	return store;
}

test("probe: invalid params are invalid_request before discovery", async () => {
	const o = probeOwner(probeSeeded());
	const { b } = probeBridge(o);
	for (const p of [{}, { id: "" }, { id: 3 }, { id: "mine", extra: 1 }, { id: "mine", sinceVersion: -1 }, { id: "mine", sinceVersion: 1.5 }, { id: "mine", sinceVersion: 2 ** 60 }, { id: "mine", sinceVersion: "1" }, { id: "mine", sinceVersion: null }, { id: "mine", sinceVersion: NaN }, { id: "mine", sinceVersion: Infinity }]) {
		const r: any = await b.handle("get_subagent_thread", p as any);
		assert.equal(r.ok, false, JSON.stringify(p));
		assert.equal(r.error.code, "invalid_request", JSON.stringify(p));
	}
	assert.equal(o.count(), 0);
});

test("probe: ownership: foreign, nested, unknown are not_found with no leak; own ok", async () => {
	const o = probeOwner(probeSeeded());
	const { b, events } = probeBridge(o);
	for (const id of ["theirs", "grandchild", "nope", "__proto__", "constructor"]) {
		const r: any = await b.handle("get_subagent_thread", { id });
		assert.equal(r.ok, false, id);
		assert.equal(r.error.code, probeAgents.AGENT_NOT_FOUND.code, id);
		assert.ok(!JSON.stringify(r).includes("id_rsa"));
	}
	const r: any = await b.handle("get_subagent_thread", { id: "mine" });
	assert.equal(r.ok, true);
	assert.deepEqual(r.data.items, [{ kind: "text", text: "hello" }]);
	assert.ok(!JSON.stringify(r).includes("SECRETPROMPT"));
	assert.equal(events.length, 0);
});

test("probe: session switch: a session-b owner cannot read the session-a subagent", async () => {
	const o = probeOwner(probeSeeded(), "session-b");
	const { b } = probeBridge(o, "session-b");
	const r: any = await b.handle("get_subagent_thread", { id: "mine" });
	assert.equal(r.error.code, probeAgents.AGENT_NOT_FOUND.code);
});

test("probe: reset during discovery answers agents_unavailable", async () => {
	const o = probeOwner(probeSeeded());
	let release: any;
	const gate = new Promise((r) => { release = r; });
	const b = new DesktopAgentsBridge({} as any, { discover: () => gate as any, schedule: () => () => {} });
	b.attach({ sessionManager: { getSessionId: () => "session-a" } } as any);
	const pending = b.handle("get_subagent_thread", { id: "mine" });
	b.reset();
	release(o.service);
	const r: any = await pending;
	assert.equal(r.error.code, probeAgents.AGENTS_UNAVAILABLE.code);
});

test("probe: older adapter, throwing, malformed, id mismatch, oversized item answer agents_unavailable", async () => {
	const store = probeSeeded();
	const cases = [
		{ thread: undefined },
		{ thread: () => { throw new Error("/home/x SECRETPROMPT"); } },
		{ thread: () => ({ kind: "ok", thread: { id: "mine", version: 1, dropped: 0, truncated: false, items: [{ kind: "text", text: "x".repeat(2001) }] } }) },
		{ thread: () => ({ kind: "ok", thread: { id: "other", version: 1, dropped: 0, truncated: false, items: [] } }) },
		{ thread: () => ({ kind: "ok", thread: { id: "mine", version: -1, dropped: 0, truncated: false, items: [] } }) },
	];
	for (const over of cases) {
		const o = probeOwner(store, "session-a", over);
		const { b } = probeBridge(o);
		const r: any = await b.handle("get_subagent_thread", { id: "mine" });
		assert.equal(r.error.code, probeAgents.AGENTS_UNAVAILABLE.code);
		assert.ok(!JSON.stringify(r).includes("SECRETPROMPT"));
	}
});

test("probe: bounds: dropped vs eviction, 256KB halving with escape-heavy text", async () => {
	const store = new TaskStore({ maxItems: 400 });
	store.add(probeTask("t", "session-a"));
	// Text is sanitized and capped at 2000 chars (≤ ~6 KB/item), so a realistic text-only
	// window never exceeds 256 KB; tool names are the one unbounded field the widget forwards.
	for (let i = 0; i < 450; i++) store.apply("t", { type: "tool_start", callId: "c" + i, name: "n".repeat(8000), args: {} }, i);
	const raw = store.thread("t");
	assert.equal(raw.items.length, 400);
	assert.equal(raw.dropped, 50);
	const { b } = probeBridge(probeOwner(store));
	const r: any = await b.handle("get_subagent_thread", { id: "t" });
	assert.equal(r.ok, true);
	assert.ok(Buffer.byteLength(JSON.stringify(r.data)) <= 256 * 1024);
	assert.equal(r.data.items.length, 20, "40 items of ~12KB halved once");
	assert.equal(r.data.dropped, 50);
	assert.equal(r.data.truncated, true);
	assert.ok(r.data.items.every((it: any) => it.kind === "tool" && it.name.length === 8000));
	const w = projectRpcActivity(store, { parentSessionId: "session-a" });
	assert.equal(w.tasks[0].thread.items.length, 40);
});

test("probe: tool item caps: args 500, output 500, exact key set", async () => {
	const store = new TaskStore();
	store.add(probeTask("t", "session-a"));
	store.apply("t", { type: "tool_start", callId: "c", name: "bash", args: { cmd: "y".repeat(900) } }, 1);
	store.apply("t", { type: "tool_end", callId: "c", output: "o".repeat(900), isError: true }, 2);
	const { b } = probeBridge(probeOwner(store));
	const r: any = await b.handle("get_subagent_thread", { id: "t" });
	const it = r.data.items[0];
	assert.equal(it.args.length, 500);
	assert.equal(it.output.length, 500);
	assert.equal(it.isError, true);
	assert.equal(it.running, false);
	assert.deepEqual(Object.keys(it).sort(), ["args", "isError", "kind", "name", "output", "running"]);
	assert.deepEqual(Object.keys(r.data).sort(), ["dropped", "id", "items", "truncated", "version"]);
});

test("probe: sinceVersion: equal returns [], other values return the window; in-place change bumps version", async () => {
	const store = new TaskStore();
	store.add(probeTask("t", "session-a"));
	store.apply("t", { type: "text", text: "a" }, 1);
	const { b } = probeBridge(probeOwner(store));
	const first: any = await b.handle("get_subagent_thread", { id: "t" });
	const v = first.data.version;
	const same: any = await b.handle("get_subagent_thread", { id: "t", sinceVersion: v });
	assert.deepEqual(same.data, { ...first.data, items: [], truncated: false });
	store.apply("t", { type: "text", text: "b" }, 2);
	const after: any = await b.handle("get_subagent_thread", { id: "t", sinceVersion: v });
	assert.equal(after.data.version, v + 1);
	assert.deepEqual(after.data.items, [{ kind: "text", text: "ab" }]);
	const higher: any = await b.handle("get_subagent_thread", { id: "t", sinceVersion: v + 100 });
	assert.equal(higher.data.items.length, 1);
});

// ---- Progress (gentle-shell-gpui parity, T6) ----

function toolThread(name: string, running: boolean) {
	return { items: [{ kind: "tool" as const, callId: "c1", name, args: { command: "rm -rf /secret" }, output: "", running, isError: false }], dropped: 0, version: 1, limits: { maxItems: 400, maxOutputChars: 16000 } };
}

test("projectDesktopAgent carries turns, tool calls, and the running tool name, never its arguments", () => {
	const running = probeAgents.projectDesktopAgent(task("t1", "session-a", { status: TASK_STATUS.RUNNING, turns: 2, toolCalls: 3 }), toolThread("bash", true));
	assert.equal(running.turns, 2);
	assert.equal(running.toolCalls, 3);
	assert.equal(running.activeTool, "bash");
	assert.equal(JSON.stringify(running).includes("rm -rf"), false);
	assert.equal(probeAgents.projectDesktopAgent(task("t1", "session-a", { status: TASK_STATUS.RUNNING }), toolThread("bash", false)).activeTool, undefined, "a finished tool call is not active");
	assert.equal(probeAgents.projectDesktopAgent(task("t1", "session-a", { status: TASK_STATUS.RUNNING }), toolThread("not a name; rm", true)).activeTool, undefined, "only a plain identifier crosses");
	assert.equal(probeAgents.projectDesktopAgent(task("t1", "session-a", { status: TASK_STATUS.COMPLETED, endedAt: 2 }), toolThread("bash", true)).activeTool, undefined, "a finished task has no active tool");
});

test("parseDesktopAgentEntry accepts the progress fields and rejects malformed ones", () => {
	const base = probeAgents.projectDesktopAgent(task("t1", "session-a", { status: TASK_STATUS.RUNNING, turns: 1, toolCalls: 1 }), toolThread("read", true));
	assert.deepEqual(probeAgents.parseDesktopAgentEntry(base), base);
	for (const bad of [{ turns: -1 }, { toolCalls: 1.5 }, { activeTool: "two words" }, { activeTool: 7 }]) {
		assert.equal(probeAgents.parseDesktopAgentEntry({ ...base, ...bad }), undefined, JSON.stringify(bad));
	}
});

test("the real owner pushes in-turn progress as one throttled agents_update with turns, tool calls, and the running tool", async (t) => {
	const owner = recordedScheduler();
	const h = await realOwnerHarness(t, { schedule: owner.schedule });
	await launchBackgroundTask(h);
	const scheduler = recordedScheduler();
	const bridge = new DesktopAgentsBridge(h.pi, { discover: async () => h.service, schedule: scheduler.schedule, coalesceMs: 10 });
	bridge.attach(h.ctx);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	bridge.wire((event, data) => events.push({ event, data }));
	await bridge.start();
	scheduler.flushAll();
	const before = events.length;

	h.children[0]!.emit({ type: "turn_end" });
	h.children[0]!.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "cat /secret/path" } });
	await tick();
	scheduler.flushAll();
	assert.equal(events.length, before, "progress waits for the owner's throttle");
	const throttles = owner.entries.filter((entry) => entry.ms === 500 && !entry.cancelled);
	assert.equal(throttles.length, 1, "two progress changes schedule one notification");

	owner.flushAll();
	scheduler.flushAll();
	assert.equal(events.length, before + 1);
	const [agent] = (events.at(-1)!.data as { agents: DesktopAgentEntry[] }).agents;
	assert.equal(agent!.status, TASK_STATUS.RUNNING);
	assert.equal(agent!.turns, 1);
	assert.equal(agent!.toolCalls, 1);
	assert.equal(agent!.activeTool, "bash");
	assert.equal(JSON.stringify(events.at(-1)).includes("/secret/path"), false);
});

test("activeTool skips finished tool items and reports the most recent running one", () => {
	const thread = { items: [
		{ kind: "tool" as const, callId: "c1", name: "bash", args: {}, output: "", running: true, isError: false },
		{ kind: "tool" as const, callId: "c2", name: "read", args: {}, output: "", running: false, isError: false },
	], dropped: 0, version: 2, limits: { maxItems: 400, maxOutputChars: 16000 } };
	assert.equal(probeAgents.activeToolName(thread), "bash");
});

/** Fire only the owner's pending progress throttle (500 ms), never its stall timers. */
function flushProgress(owner: ReturnType<typeof recordedScheduler>): void {
	for (const entry of [...owner.entries]) {
		if (entry.cancelled || entry.ms !== 500) continue;
		entry.cancelled = true;
		entry.fn();
	}
}

test("streamed text alone emits no agents_update", async (t) => {
	const owner = recordedScheduler();
	const h = await realOwnerHarness(t, { schedule: owner.schedule });
	await launchBackgroundTask(h);
	const scheduler = recordedScheduler();
	const bridge = new DesktopAgentsBridge(h.pi, { discover: async () => h.service, schedule: scheduler.schedule, coalesceMs: 10 });
	bridge.attach(h.ctx);
	const events: unknown[] = [];
	bridge.wire((_event, data) => events.push(data));
	await bridge.start();
	h.children[0]!.emit({ type: "turn_end" });
	// The first delta moves the step to `writing`, a real projected change.
	h.children[0]!.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "start" } });
	await tick();
	flushProgress(owner);
	scheduler.flushAll();
	const before = events.length;
	for (const delta of ["a", "b", "c"]) h.children[0]!.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
	await tick();
	flushProgress(owner);
	scheduler.flushAll();
	assert.equal(events.length, before, "text deltas change no projected field");
});
