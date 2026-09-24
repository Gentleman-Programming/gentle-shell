import assert from "node:assert/strict";
import test from "node:test";
import {
	applyTaskEvent,
	emptyThread,
	normalizeRpcEvent,
	TASK_EVENT,
	TASK_STATUS,
	taskLabel,
	TaskStore,
	THREAD_ITEM,
	type TaskRecord,
} from "../lib/agents-protocol.ts";

// Gentle Agents protocol: the child pi process streams RPC events; the host
// normalizes them into small typed deltas, applies them to an append-only
// thread, and notifies only the listeners of the task that changed.

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		id: "t1",
		agent: "gentle-ai-explore",
		mode: "task",
		prompt: "Map the repo",
		label: "map the repo",
		cwd: "/repo",
		parentSessionId: "s1",
		status: TASK_STATUS.QUEUED,
		createdAt: 1000,
		startedAt: null,
		endedAt: null,
		model: "openai-codex/gpt-5.6-terra",
		thinking: "high",
		sessionPath: null,
		error: null,
		result: null,
		lastStep: "queued",
		lastActivityAt: 1000,
		turns: 0,
		toolCalls: 0,
		tokens: 0,
		cost: 0,
		...overrides,
	};
}

test("normalizeRpcEvent maps pi RPC events to task deltas and ignores the rest", () => {
	assert.deepEqual(normalizeRpcEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } }), [{ type: TASK_EVENT.TEXT, text: "Hi" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } }), [{ type: TASK_EVENT.THINKING, text: "hmm" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }), [{ type: TASK_EVENT.TOOL_START, callId: "c1", name: "bash", args: { command: "ls" } }]);
	assert.deepEqual(normalizeRpcEvent({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: "a\nb" }] } }), [{ type: TASK_EVENT.TOOL_UPDATE, callId: "c1", output: "a\nb" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "boom" }] } }), [{ type: TASK_EVENT.TOOL_END, callId: "c1", output: "boom", isError: true }]);
	assert.deepEqual(normalizeRpcEvent({ type: "turn_end" }), [{ type: TASK_EVENT.TURN_END }]);
	assert.deepEqual(normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done." }], stopReason: "stop" }] }), [{ type: TASK_EVENT.AGENT_END, text: "done.", outcome: "success" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "WebSocket error with untrusted provider payload" }] }), [{ type: TASK_EVENT.AGENT_END, text: "", outcome: "error", diagnostic: "assistant reported an error" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "aborted" }] }), [{ type: TASK_EVENT.AGENT_END, text: "", outcome: "aborted", diagnostic: "assistant aborted" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "stop" }] }), [{ type: TASK_EVENT.AGENT_END, text: "", outcome: "empty", diagnostic: "assistant returned no final report" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "agent_settled" }), [{ type: TASK_EVENT.AGENT_SETTLED }]);
	assert.deepEqual(normalizeRpcEvent({ type: "message_update", assistantMessageEvent: { type: "error", reason: "error", error: { message: "rate limited" } } }), [{ type: TASK_EVENT.ERROR, message: "rate limited" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Delete?" }), [{ type: TASK_EVENT.ASK, request: { id: "u1", method: "confirm", title: "Delete?" } }]);
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u2", method: "setStatus", statusKey: "mcp" }), [], "fire-and-forget UI requests never count as questions");
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u3", method: "notify", message: "hi" }), []);
	assert.deepEqual(normalizeRpcEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 }), [{ type: TASK_EVENT.NOTE, text: "retrying (1/3)" }]);
	assert.deepEqual(normalizeRpcEvent({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 9621, cost: { total: 0.0193 } } } }), [{ type: TASK_EVENT.USAGE, tokens: 9621, cost: 0.0193 }]);
	assert.deepEqual(normalizeRpcEvent({ type: "message_end", message: { role: "user" } }), []);
	assert.deepEqual(normalizeRpcEvent({ type: "queue_update" }), []);
	assert.deepEqual(normalizeRpcEvent("garbage"), []);
});

test("response observations are opt-in, finalized, field-specific and content-free", () => {
	const message = { role: "assistant", provider: "openai", model: "gpt-4o", responseModel: "gpt-4o-2024-08-06",
		providerThinkingLevel: "high", stopReason: "stop", content: [{ type: "text", text: "private response" }],
		errorMessage: "private error", responseId: "private id", modelVersion: "invented",
		usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: -1, totalTokens: 16, reasoning: 2 } };
	const raw = { type: "message_end", message };
	assert.deepEqual(normalizeRpcEvent(raw), [{ type: TASK_EVENT.USAGE, tokens: 16, cost: 0 }]);
	const events = normalizeRpcEvent(raw, { observeResponses: true });
	assert.equal(events.length, 2);
	const observation = events.find((event) => event.type === "response_observation")?.observation;
	assert.ok(observation);
	assert.deepEqual(observation.provider, { state: "observed", value: "openai" });
	assert.deepEqual(observation.model, { state: "observed", value: "gpt-4o" });
	assert.deepEqual(observation.responseModel, { state: "observed", value: message.responseModel });
	assert.deepEqual(observation.providerThinkingLevel, { state: "observed", value: "high" });
	assert.deepEqual(observation.selected, { provider: { state: "unavailable" }, model: { state: "unavailable" }, effort: { state: "unavailable" } });
	assert.deepEqual(observation.tokens, { input: { state: "reported", value: 12 }, output: { state: "reported", value: 4 },
		cacheRead: { state: "unavailable" }, cacheWrite: { state: "unavailable" }, totalTokens: { state: "reported", value: 16 },
		reasoning: { state: "reported", value: 2 } });
	assert.doesNotMatch(JSON.stringify(observation), /private|invented|modelVersion|content|responseId/);
	for (const stopReason of ["stop", "length", "toolUse", "error", "aborted"]) {
		const [event] = normalizeRpcEvent({ type: "message_end", message: { role: "assistant", stopReason } }, { observeResponses: true });
		assert.ok(event?.type === "response_observation", "missing usage still exposes a response");
		assert.equal(event.observation.stopReason, stopReason);
	}
	for (const stopReason of ["pending", "deferred", undefined, "private error"]) {
		assert.deepEqual(normalizeRpcEvent({ type: "message_end", message: { role: "assistant", stopReason } }, { observeResponses: true }), []);
	}
	for (const type of ["message_start", "message_update", "turn_end", "agent_end"]) {
		assert.ok(!normalizeRpcEvent({ type, message, messages: [message] }, { observeResponses: true }).some((event) => event.type === "response_observation"));
	}
	assert.deepEqual(normalizeRpcEvent({ type: "message_end", message: { ...message, role: "toolResult" } }, { observeResponses: true }), []);
});

test("response observations reject malformed counters and unbounded metadata without coercion", () => {
	for (const value of [0, -1, 1.5, NaN, Infinity, "12", null, undefined, 1_000_000_001]) {
		const [event] = normalizeRpcEvent({ type: "message_end", message: { role: "assistant", stopReason: "error",
			provider: "x".repeat(33), model: "x".repeat(129), responseModel: "private\ntext", providerThinkingLevel: {},
			usage: { input: value, output: value, cacheRead: value, cacheWrite: value, totalTokens: value, reasoning: value } } }, { observeResponses: true }).filter((event) => event.type === "response_observation");
		assert.ok(event);
		for (const field of Object.values(event.observation.tokens)) assert.deepEqual(field, { state: "unavailable" });
		for (const field of ["provider", "model", "responseModel", "providerThinkingLevel"] as const) assert.deepEqual(event.observation[field], { state: "unavailable" });
	}
});

test("taskLabel prefers an explicit label and otherwise takes the prompt's first sentence", () => {
	assert.equal(taskLabel("Map the repo. Then report.", "  map  the repo "), "map the repo");
	assert.equal(taskLabel("Repeat a fresh read-only exploration of lib. Own runtime architecture: extensions, hooks."), "Repeat a fresh read-only exploration of lib");
	assert.equal(taskLabel("\n\nFirst line here:\nsecond"), "First line here");
	assert.equal(taskLabel(`${"x".repeat(100)} tail`).length, 72);
	assert.equal(taskLabel("\x1b[31mred\x1b[0m"), "red");
});

test("applyTaskEvent appends incrementally: text deltas merge, tool output is replaced, items stay bounded", () => {
	let thread = emptyThread({ maxItems: 3, maxOutputChars: 9 });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TEXT, text: "Hel" });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TEXT, text: "lo" });
	assert.deepEqual(thread.items, [{ kind: THREAD_ITEM.TEXT, text: "Hello" }]);
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_START, callId: "c1", name: "bash", args: { command: "ls" } });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_UPDATE, callId: "c1", output: "line one\nline two" });
	assert.equal(thread.items[1].kind, THREAD_ITEM.TOOL);
	assert.equal((thread.items[1] as { output: string }).output, "…line two", "tool output keeps the tail");
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_END, callId: "c1", output: "ok", isError: false });
	assert.deepEqual(thread.items[1], { kind: THREAD_ITEM.TOOL, callId: "c1", name: "bash", args: { command: "ls" }, output: "ok", running: false, isError: false });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.NOTE, text: "retrying (1/3)" });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TEXT, text: "After" });
	assert.equal(thread.items.length, 3);
	assert.equal(thread.dropped, 1, "the oldest item made room");
	assert.equal(thread.items[0].kind, THREAD_ITEM.TOOL);
	assert.equal(thread.version, 7);
});

test("applyTaskEvent sanitizes text, ignores updates for unknown tools, and records asks as notes", () => {
	let thread = emptyThread();
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TEXT, text: "\x1b[31mred\x1b[0m" });
	assert.deepEqual(thread.items, [{ kind: THREAD_ITEM.TEXT, text: "red" }]);
	const before = thread;
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_UPDATE, callId: "missing", output: "x" });
	assert.strictEqual(thread, before);
	thread = applyTaskEvent(thread, { type: TASK_EVENT.ASK, request: { id: "u1", method: "confirm", title: "Delete?" } });
	assert.deepEqual(thread.items[1], { kind: THREAD_ITEM.NOTE, text: "asked: Delete?" });
});

test("TaskStore notifies only the listeners of the task that changed and keeps summaries cheap", () => {
	const store = new TaskStore();
	store.add(record({ id: "a" }));
	store.add(record({ id: "b", agent: "worker" }));
	const seenA: string[] = [];
	const seenB: string[] = [];
	const summaries: string[] = [];
	const offA = store.subscribe("a", (task) => seenA.push(`${task.status}:${task.lastStep}`));
	store.subscribe("b", (task) => seenB.push(task.status));
	store.subscribeSummary((summary) => summaries.push(`${summary.running}/${summary.queued}/${summary.finished}`));
	store.update("a", { status: TASK_STATUS.RUNNING, startedAt: 2000, lastStep: "starting" });
	store.apply("a", { type: TASK_EVENT.TOOL_START, callId: "c1", name: "bash", args: {} }, 2500);
	assert.deepEqual(seenA, ["running:starting", "running:bash"]);
	assert.deepEqual(seenB, []);
	assert.deepEqual(summaries, ["1/1/0"], "an event inside a task never touches the summary");
	assert.equal(store.get("a")?.toolCalls, 1);
	assert.equal(store.get("a")?.lastActivityAt, 2500);
	assert.equal(store.thread("a").items.length, 1);
	offA();
	store.update("a", { status: TASK_STATUS.COMPLETED, endedAt: 3000 });
	assert.equal(seenA.length, 2, "unsubscribed listener stays quiet");
	assert.deepEqual(summaries, ["1/1/0", "0/1/1"]);
	assert.deepEqual(store.list("s1").map((task) => task.id), ["a", "b"], "newest activity first");
	assert.equal(store.get("missing"), undefined);
	assert.deepEqual(store.thread("missing"), emptyThread());
});

test("TaskStore.apply moves the task to waiting on ask, back to running on any later event, and counts turns", () => {
	const store = new TaskStore();
	store.add(record({ id: "a", status: TASK_STATUS.RUNNING }));
	store.apply("a", { type: TASK_EVENT.ASK, request: { id: "u1", method: "input", title: "Name?" } }, 1);
	assert.equal(store.get("a")?.status, TASK_STATUS.WAITING);
	assert.equal(store.get("a")?.lastStep, "asked: Name?");
	store.apply("a", { type: TASK_EVENT.TEXT, text: "thanks" }, 2);
	assert.equal(store.get("a")?.status, TASK_STATUS.RUNNING);
	store.apply("a", { type: TASK_EVENT.TURN_END }, 3);
	store.apply("a", { type: TASK_EVENT.TURN_END }, 4);
	assert.equal(store.get("a")?.turns, 2);
	store.apply("a", { type: TASK_EVENT.USAGE, tokens: 100, cost: 0.5 }, 4);
	store.apply("a", { type: TASK_EVENT.USAGE, tokens: 50, cost: 0.25 }, 4);
	assert.equal(store.get("a")?.tokens, 150);
	assert.equal(store.get("a")?.cost, 0.75);
	store.apply("a", { type: TASK_EVENT.AGENT_END, text: "final answer", outcome: "success" }, 5);
	assert.equal(store.get("a")?.result, "final answer");
	assert.equal(store.get("a")?.status, TASK_STATUS.RUNNING, "agent_end alone does not finish: the runner decides");
});
