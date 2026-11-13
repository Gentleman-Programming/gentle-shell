import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import gentleAgents, { type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { isFinished, TASK_STATUS, TaskStore, type ChildResponseObservation, type ChildTokenMeasurement, type TaskRecord } from "../lib/agents-protocol.ts";
import { historyDir, loadStoredTask, saveTask } from "../lib/agents-history.ts";
import { AgentRunner } from "../lib/agents-runner.ts";
import { fakeChild } from "./agents-fake-child.ts";
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
	parseListSubagentsParams,
	projectDesktopAgent,
	selectDesktopAgents,
	type DesktopAgentEntry,
	type DesktopAgentsCancelOutcome,
	type DesktopAgentsOwnerRead,
	type DesktopAgentsService,
} from "../lib/desktop-rpc-agents.ts";
import { DesktopAgentsBridge, discoverDesktopAgentsService } from "../lib/desktop-agents-service.ts";
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
		"list_subagents",
		"cancel_subagent",
	]);
	assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "agents_update"]);
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
async function realOwnerHarness(t: test.TestContext): Promise<RealOwnerHarness> {
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
		schedule: () => () => {},
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

test("a shut-down owner leaves the agents service channel and never answers discovery", async (t) => {
	const harness = await realOwnerHarness(t);
	assert.equal(harness.listeners.get(DESKTOP_AGENTS_SERVICE_CHANNEL)?.size, 1, "one owner answers while the session is live");
	for (const handler of harness.handlers.get("session_shutdown") ?? []) await handler({}, harness.ctx);
	assert.equal(harness.listeners.get(DESKTOP_AGENTS_SERVICE_CHANNEL)?.size ?? 0, 0, "the owner subscription is removed on shutdown");
	let answered = 0;
	harness.pi.events.emit(DESKTOP_AGENTS_SERVICE_CHANNEL, { context: harness.ctx, respond: () => { answered += 1; } });
	assert.equal(answered, 0, "a replaced runtime is never discovered through the old owner");
});
