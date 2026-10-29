import assert from "node:assert/strict";
import test from "node:test";
import {
	applyTaskEvent,
	emptyThread,
	MISSING_TOOLS_NOTE_PREFIX,
	normalizeRpcEvent,
	ToolArgumentProgress,
	TASK_EVENT,
	TASK_STATUS,
	taskLabel,
	TaskStore,
	TERMINAL_RETENTION,
	THREAD_ITEM,
	isFinished,
	type TaskRecord,
} from "../lib/agents-protocol.ts";

function terminalError(message: Record<string, unknown>) {
	const [event] = normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", ...message }] });
	assert.equal(event?.type, TASK_EVENT.AGENT_END);
	return event as Extract<typeof event, { type: typeof TASK_EVENT.AGENT_END }>;
}

test("terminal assistant errors expose one closed category, never provider text (#2322)", () => {
	const cases: Array<[string, Record<string, unknown>, string]> = [
		["rate limit error type", { errorMessage: "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}" }, "rate_limit"],
		["too many requests", { errorMessage: "Too Many Requests" }, "rate_limit"],
		["bare 429 status", { errorMessage: "429: {}" }, "rate_limit"],
		["quota on a 429", { errorMessage: "429 You exceeded your current quota (insufficient_quota)" }, "quota"],
		["invalid key", { errorMessage: "401 invalid x-api-key" }, "auth"],
		["forbidden status", { errorMessage: "Provider (403): {}" }, "auth"],
		["prompt too long", { errorMessage: "400 prompt is too long: 210000 tokens > 200000 maximum" }, "context_length"],
		["context window raw stop reason", { rawStopReason: "model_context_window_exceeded" }, "context_length"],
		["timed out", { errorMessage: "Request timed out." }, "timeout"],
		["diagnostic timeout code", { diagnostics: [{ type: "stream", timestamp: 1, error: { message: "x", code: "ETIMEDOUT" } }] }, "timeout"],
		["fetch failed", { errorMessage: "fetch failed" }, "network"],
		["connection reset", { errorMessage: "read ECONNRESET" }, "network"],
		["overloaded", { errorMessage: "529 {\"type\":\"overloaded_error\"}" }, "provider_unavailable"],
		["bad gateway status", { errorMessage: "502: <html>" }, "provider_unavailable"],
		["invalid request", { errorMessage: "400 invalid_request_error: messages.0 is malformed" }, "invalid_request"],
		["unmatched provider text", { errorMessage: "Provider finish_reason: content_filter" }, "unavailable"],
		["token count is not a status", { errorMessage: "stopped after 500 tokens" }, "unavailable"],
		["no error message", {}, "unavailable"],
		["non-string error message", { errorMessage: { status: 429 } }, "unavailable"],
		["raw stop reason that is not an identifier", { rawStopReason: "rate limit <script>" }, "unavailable"],
		["signal beyond the scan bound", { errorMessage: `${"x".repeat(5000)} rate limit` }, "unavailable"],
	];
	for (const [name, message, category] of cases) {
		assert.deepEqual(terminalError(message), { type: TASK_EVENT.AGENT_END, text: "", outcome: "error", diagnostic: `assistant reported an error (${category})`, errorCategory: category }, name);
	}
});

test("terminal error categories never carry provider payload into the event or the task (#2322)", () => {
	const secret = "sk-live-never-copy-7f3a";
	const event = terminalError({ errorMessage: `429 rate limit for key ${secret} at https://private.example/v1`, rawStopReason: "error", diagnostics: [{ type: "stream", timestamp: 1, error: { message: secret, code: secret } }] });
	assert.equal(event.errorCategory, "rate_limit");
	assert.equal(JSON.stringify(event).includes("never-copy"), false);
	assert.equal(JSON.stringify(event).includes("private.example"), false);
	const store = new TaskStore();
	store.add(record({ status: TASK_STATUS.RUNNING }));
	store.apply("t1", event, 2);
	const task = store.get("t1");
	assert.equal(task?.error, "assistant reported an error (rate_limit)");
	assert.equal(task?.lastStep, "assistant reported an error (rate_limit)");
	assert.equal(task?.result, null);
	assert.equal(JSON.stringify(task).includes("never-copy"), false);
	assert.equal(JSON.stringify(store.thread("t1")).includes("never-copy"), false);
});

test("status observers see only live transitions, remain isolated and cannot fail mutations", () => {
	const store = new TaskStore();
	const changes: Array<{ status: string; sequence: number; parentSessionId: string; producerId: string; runId: string }> = [];
	store.subscribeStatusChanges(() => { throw new Error("listener failure"); });
	store.subscribeStatusChanges(async () => { throw new Error("async failure"); });
	const stop = store.subscribeStatusChanges(change => { changes.push(change); });
	store.restore(record({ id: "restored" }), emptyThread());
	store.add(record());
	store.update("t1", { status: TASK_STATUS.RUNNING });
	store.update("t1", { status: TASK_STATUS.RUNNING, label: "new label" });
	const ask = { type: TASK_EVENT.ASK, request: { id: "q", method: "input", title: "Question" } } as const;
	store.apply("t1", ask, 2);
	store.apply("t1", ask, 3);
	store.apply("t1", { type: TASK_EVENT.TEXT, text: "answer" }, 4);
	store.apply("t1", { type: TASK_EVENT.TEXT, text: "more" }, 5);
	store.add(record({ id: "other", parentSessionId: "s2" }));
	assert.deepEqual(changes.map(change => change.status), ["queued", "running", "waiting", "running", "queued"]);
	assert.deepEqual(changes.map(change => change.sequence), [1, 2, 3, 4, 5]);
	assert.deepEqual(changes.map(change => change.parentSessionId), ["s1", "s1", "s1", "s1", "s2"]);
	assert.equal(new Set(changes.slice(0, 4).map(change => change.runId)).size, 1);
	assert.equal(store.get("t1")?.status, "running");
	const another = new TaskStore();
	let otherProducer: string | undefined;
	another.subscribeStatusChanges(change => { otherProducer = change.producerId; });
	another.add(record());
	assert.notEqual(otherProducer, changes[0].producerId);
	stop();
	store.update("t1", { status: TASK_STATUS.COMPLETED });
	assert.equal(changes.length, 5);
});

test("all terminal statuses produce exactly one transition and restore establishes a silent baseline", () => {
	for (const status of [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.TIMED_OUT]) {
		const store = new TaskStore();
		const statuses: string[] = [];
		store.subscribeStatusChanges(change => { statuses.push(change.status); });
		store.restore(record({ status: TASK_STATUS.RUNNING }), emptyThread());
		store.update("t1", { status });
		store.update("t1", { status, result: "report" });
		store.add(record({ status }));
		assert.deepEqual(statuses, [status]);
		assert.equal(store.get("t1")?.status, status);
	}
});

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
	assert.deepEqual(normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "WebSocket error with untrusted provider payload" }] }), [{ type: TASK_EVENT.AGENT_END, text: "", outcome: "error", diagnostic: "assistant reported an error (network)", errorCategory: "network" }]);
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

// #1690: Pi drops unknown --tools names silently, so the child reports them
// with one marked notify; only that notify reaches the task thread.
test("normalizeRpcEvent turns the marked missing-tools notify into a note and drops every other notify", () => {
	const message = `${MISSING_TOOLS_NOTE_PREFIX} gentle_review_scope, codegraph`;
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u1", method: "notify", message, notifyType: "warning" }), [{ type: TASK_EVENT.NOTE, text: message }]);
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u2", method: "notify", message: "requested tools missing in child: x" }), [], "an unmarked notify stays dropped");
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u3", method: "notify", message: ` ${MISSING_TOOLS_NOTE_PREFIX} x` }), [], "the marker must be a prefix");
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u4", method: "setStatus", statusKey: "k", statusText: `${MISSING_TOOLS_NOTE_PREFIX} x` }), [], "only notify carries the marker");
	assert.deepEqual(normalizeRpcEvent({ type: "extension_ui_request", id: "u5", method: "notify", message: `${MISSING_TOOLS_NOTE_PREFIX} \u001B[2Jx` }), [{ type: TASK_EVENT.NOTE, text: `${MISSING_TOOLS_NOTE_PREFIX} x` }], "child text is sanitized");
});

test("argument liveness accepts current and legacy Pi starts without display or usage deltas", () => {
	for (const start of [{ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "write" },
		{ type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", id: "c1", name: "write", arguments: {} }] } }]) {
		const progress = new ToolArgumentProgress();
		const update = (inner: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent: inner });
		const delta = update({ type: "toolcall_delta", contentIndex: 0, delta: "private" });
		assert.equal(progress.observe(delta), false, "no active generation");
		progress.observe({ type: "message_start", message: { role: "assistant", timestamp: 1 } });
		assert.equal(progress.observe(delta), false, "no announced block");
		assert.equal(progress.observe(update(start)), false, "announcement alone is not progress");
		assert.equal(progress.observe(delta), true);
		assert.equal(progress.observe(delta), false);
		assert.deepEqual(normalizeRpcEvent(delta), [], "no arguments in display events or provisional totals");
		progress.observe(update({ type: "toolcall_end", contentIndex: 0 }));
		assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: "late" })), false);
		progress.observe(update(start));
		assert.equal(progress.observe(delta), false, "a closed block cannot be reopened");
	}
});

test("argument liveness fails closed on malformed starts, stale generations and fingerprint exhaustion", () => {
	const progress = new ToolArgumentProgress();
	const update = (inner: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent: inner });
	for (const timestamp of [undefined, "1", -1, 1.5]) progress.observe({ type: "message_start", message: { role: "assistant", timestamp } });
	assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: "x" })), false);
	progress.observe({ type: "message_start", message: { role: "assistant", timestamp: 1 } });
	for (const fields of [{ id: 1, toolName: "write" }, { id: "c", toolName: "" }, { partial: null }]) {
		progress.observe(update({ type: "toolcall_start", contentIndex: 0, ...fields }));
		assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: "x" })), false);
	}
	progress.observe(update({ type: "toolcall_start", contentIndex: 0, id: "c", toolName: "write" }));
	for (let index = 0; index < 4096; index++) assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: String(index) })), true);
	assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: "over-cap" })), false);
	progress.observe({ type: "message_end" });
	progress.observe({ type: "message_start", message: { role: "assistant", timestamp: 1 } });
	progress.observe(update({ type: "toolcall_start", contentIndex: 0, id: "c", toolName: "write" }));
	assert.equal(progress.observe(update({ type: "toolcall_delta", contentIndex: 0, delta: "stale" })), false);
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

// Finished tasks must release their weight: a bounded window of the most
// recent ones stays readable, older ones leave the store entirely, and a
// terminal task's listeners go quiet after the one final transition.
test("TaskStore keeps a bounded window of finished tasks and silences terminal listeners", () => {
	const store = new TaskStore();
	const seen: string[] = [];
	store.add(record({ id: "watched", status: TASK_STATUS.RUNNING, lastActivityAt: 1 }));
	store.add(record({ id: "filler", status: TASK_STATUS.RUNNING, lastActivityAt: 2 }));
	store.subscribe("watched", (task) => seen.push(task.status));
	// `watched` completes the window once it finishes, so the next terminal
	// task evicts exactly the oldest one.
	for (let index = 0; index < TERMINAL_RETENTION - 1; index += 1) {
		store.add(record({ id: `done-${index}`, status: TASK_STATUS.COMPLETED, lastActivityAt: 10 + index }));
	}
	assert.equal(store.list().filter((task) => isFinished(task.status)).length, TERMINAL_RETENTION - 1, "retained finished tasks stay at the cap");
	assert.ok(store.get("watched") && store.get("filler"), "running tasks are never evicted");
	store.update("watched", { status: TASK_STATUS.COMPLETED, endedAt: 50 });
	assert.deepEqual(seen, ["completed"], "the terminal transition itself still notifies exactly once");
	store.apply("watched", { type: TASK_EVENT.TEXT, text: "late" }, 60);
	assert.deepEqual(seen, ["completed"], "a terminal task's listener stays quiet afterwards");
	store.add(record({ id: "newest", status: TASK_STATUS.COMPLETED, lastActivityAt: 1_000 }));
	assert.equal(store.get("done-0"), undefined, "the oldest finished task is evicted");
	assert.ok(store.get("done-1") && store.get("newest"), "recent finished tasks remain readable");
	assert.ok(store.get("filler"), "running tasks survive eviction");
	assert.equal(store.list().filter((task) => isFinished(task.status)).length, TERMINAL_RETENTION);
	assert.deepEqual(store.thread("done-0"), emptyThread(), "an evicted task's thread weight is released");
	assert.ok(store.thread("done-1").limits.maxItems > 0, "a retained finished task stays renderable");
	assert.equal(store.summary().finished, TERMINAL_RETENTION, "summaries reflect the bounded window");
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
