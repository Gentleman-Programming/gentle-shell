import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_MODE, type AgentDefinition, type AgentMode } from "../lib/agents-config.ts";
import { CHILD_MESSAGE_MAX_BYTES, CHILD_QUERY_ERROR_MAX_BYTES, CHILD_QUERY_TIMEOUT_ERROR, CHILD_QUERY_TIMEOUT_MS, ChildMessenger } from "../lib/agents-messaging.ts";
import { TaskStore } from "../lib/agents-protocol.ts";
import { AgentRunner, QUERY_STALL_MARGIN_MS } from "../lib/agents-runner.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const agent: AgentDefinition = { name: "worker", description: "", filePath: "/a.md", scope: "global", instructions: "", model: undefined, thinking: undefined, mode: undefined, tools: ["read"] };
const request = (mode: AgentMode = AGENT_MODE.BACKGROUND) => ({ agent, prompt: "work", label: undefined, context: undefined, mode, cwd: "/repo", parentSessionId: "s1", model: undefined, thinking: undefined, sessionDir: "/sessions", resumeSessionPath: undefined, env: {} });

test("ChildMessenger validates query replies and settles timeout, callback failure, and disconnect once", async () => {
	const listeners = new Map<string, Array<(value: Record<string, unknown>) => void>>();
	const frames: Array<Record<string, unknown>> = [];
	const timers: Array<() => void> = [];
	let callback: ((error: Error | null) => void) | undefined;
	const endpoint = {
		send: (frame: Record<string, unknown>, done?: (error: Error | null) => void) => { frames.push(frame); callback = done; return false; },
		on: (event: string, listener: (value: Record<string, unknown>) => void) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
	};
	const messenger = new ChildMessenger(endpoint, (fn) => { timers.push(fn); return () => {}; });
	const pending = messenger.query("which file?");
	assert.deepEqual(frames, [{ id: "q1", kind: "query", message: "which file?" }]);
	for (const listener of listeners.get("message") ?? []) listener({ id: "q1", kind: "reply", message: "\uD800" });
	for (const listener of listeners.get("message") ?? []) listener({ id: "q1", kind: "reply", message: "x".repeat(CHILD_MESSAGE_MAX_BYTES + 1) });
	callback?.(new Error("send failed"));
	await assert.rejects(pending, /send failed/);
	const timeout = messenger.query("timeout");
	timers.at(-1)!();
	await assert.rejects(timeout, /timed out/);
	const disconnected = messenger.query("disconnect");
	for (const listener of listeners.get("disconnect") ?? []) listener({});
	await assert.rejects(disconnected, /closed/);
});

test("a timed-out query tells the child what the timeout means, within the error cap, from either side", async () => {
	const guidance = "Parent query timed out: the parent did not answer in time. A late answer may still arrive as a message; continue with work that does not depend on it and state the open question in your report.";
	assert.equal(CHILD_QUERY_TIMEOUT_ERROR, guidance);
	assert.ok(Buffer.byteLength(guidance, "utf8") <= CHILD_QUERY_ERROR_MAX_BYTES);
	// The child's own deadline.
	const timers: Array<() => void> = [];
	const own = new ChildMessenger({ send: () => true, on: () => undefined }, (fn) => { timers.push(fn); return () => {}; });
	const ownTimeout = own.query("which file?");
	timers.at(-1)!();
	await assert.rejects(ownTimeout, (error: Error) => error.message === guidance);
	// The runner's deadline reaches the child as a reply error frame it accepts.
	const child = fakeChild();
	const runnerTimers: Array<{ fn: () => void; ms: number }> = [];
	const runner = new AgentRunner(new TaskStore(), { maxConcurrency: 1, stallTimeoutMs: 10_000 }, { spawn: () => child.child, now: () => 1, schedule: (fn, ms) => { runnerTimers.push({ fn, ms }); return () => {}; }, pi: { command: "pi", args: [] } }, { askUser: async () => ({ cancelled: true }), onQuery: () => {} });
	runner.run(request());
	await tick();
	const listeners: Array<(value: unknown) => void> = [];
	const messenger = new ChildMessenger({ send: (frame) => { child.message(frame as Record<string, unknown>); return true; }, on: (event, listener) => { if (event === "message") listeners.push(listener); } }, () => () => {});
	child.child.send = (frame, done) => { for (const listener of listeners) listener(frame); done?.(null); return true; };
	const before = runnerTimers.length;
	const pending = messenger.query("wait");
	runnerTimers.slice(before).find((timer) => timer.ms === CHILD_QUERY_TIMEOUT_MS)!.fn();
	await assert.rejects(pending, (error: Error) => error.message === guidance);
});

test("ChildMessenger resolves one strictly correlated query reply", async () => {
	const listeners = new Map<string, Array<(value: Record<string, unknown>) => void>>();
	const frames: Array<Record<string, unknown>> = [];
	const endpoint = {
		send: (frame: Record<string, unknown>) => { frames.push(frame); return true; },
		on: (event: string, listener: (value: Record<string, unknown>) => void) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
	};
	const messenger = new ChildMessenger(endpoint, () => () => {});
	const pending = messenger.query("Where?");
	for (const listener of listeners.get("message") ?? []) listener({ id: "n1", kind: "reply", message: "forged" });
	for (const listener of listeners.get("message") ?? []) listener({ id: "q1", kind: "reply", message: "src/a.ts", extra: true });
	for (const listener of listeners.get("message") ?? []) listener({ id: "q1", kind: "reply", message: "src/a.ts" });
	assert.deepEqual(frames, [{ id: "q1", kind: "query", message: "Where?" }]);
	assert.equal(await pending, "src/a.ts");
});

test("ChildMessenger rejects an empty reply error and ignores mixed reply fields", async () => {
	const listeners = new Map<string, Array<(value: Record<string, unknown>) => void>>();
	const timers: Array<{ cancelled: boolean; fn: () => void }> = [];
	const messenger = new ChildMessenger({
		send: () => true,
		on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener as (value: Record<string, unknown>) => void]),
	}, (fn) => {
		const timer = { cancelled: false, fn };
		timers.push(timer);
		return () => { timer.cancelled = true; };
	});
	const emptyError = messenger.query("empty error");
	for (const listener of listeners.get("message") ?? []) listener({ id: "q1", kind: "reply", error: "" });
	await assert.rejects(emptyError, /parent rejected query/);
	assert.equal(timers[0]?.cancelled, true, "a rejected reply cancels its deadline");
	const mixed = messenger.query("mixed fields");
	for (const listener of listeners.get("message") ?? []) listener({ id: "q2", kind: "reply", message: "answer", error: "also error" });
	assert.equal(timers[1]?.cancelled, false, "mixed reply fields cannot settle a query");
	timers[1]?.fn();
	await assert.rejects(mixed, /timed out/);
});

test("runner sends bounded static query rejection frames that settle the child before timeout", async () => {
	const child = fakeChild();
	const listeners = new Map<string, Array<(value: unknown) => void>>();
	const timers: Array<{ cancelled: boolean; fn: () => void }> = [];
	child.child.send = (frame, done) => {
		child.sent.push(frame);
		for (const listener of listeners.get("message") ?? []) listener(frame);
		done?.(null);
		return true;
	};
	const messenger = new ChildMessenger({
		send: (frame: Record<string, unknown>) => { child.message(frame); return true; },
		on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
	}, (fn) => {
		const timer = { cancelled: false, fn };
		timers.push(timer);
		return () => { timer.cancelled = true; };
	});
	const runner = new AgentRunner(new TaskStore(), { maxConcurrency: 1, stallTimeoutMs: 10_000 }, { spawn: () => child.child, now: () => 1, schedule: () => () => {}, pi: { command: "pi", args: [] } }, { askUser: async () => ({ cancelled: true }), onQuery: () => { throw new Error(`\uD800${"x".repeat(CHILD_MESSAGE_MAX_BYTES)}`); } });
	runner.run(request());
	await tick();
	const pending = messenger.query("reject me");
	timers[0]?.fn();
	await assert.rejects(pending, /parent rejected query/);
	assert.deepEqual(child.sent.at(-1), { id: "q1", kind: "reply", error: "parent rejected query" });
	assert.equal(timers[0]?.cancelled, true, "the child reply settles before its deadline");
});

test("a malformed query with a valid q ID gets a reply that clears the matching child query", async () => {
	const child = fakeChild();
	const listeners = new Map<string, Array<(value: unknown) => void>>();
	const timers: Array<{ cancelled: boolean; fn: () => void }> = [];
	child.child.send = (frame, done) => {
		child.sent.push(frame);
		for (const listener of listeners.get("message") ?? []) listener(frame);
		done?.(null);
		return true;
	};
	const messenger = new ChildMessenger({
		send: (frame: Record<string, unknown>) => { child.message(frame); return true; },
		on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
	}, (fn) => {
		const timer = { cancelled: false, fn };
		timers.push(timer);
		return () => { timer.cancelled = true; };
	});
	const runner = new AgentRunner(new TaskStore(), { maxConcurrency: 1, stallTimeoutMs: 10_000 }, { spawn: () => child.child, now: () => 1, schedule: () => () => {}, pi: { command: "pi", args: [] } }, { askUser: async () => ({ cancelled: true }), onQuery: () => {} });
	runner.run(request());
	await tick();
	const pending = messenger.query("valid first");
	child.message({ id: "q1", kind: "query", message: "malformed", extra: true });
	timers[0]?.fn();
	await assert.rejects(pending, /invalid child IPC frame/);
	assert.deepEqual(child.sent.at(-1), { id: "q1", kind: "reply", error: "invalid child IPC frame" });
	assert.equal(timers[0]?.cancelled, true);
});

test("background queries keep correlation, bounds, and ownership before replying only over IPC", async () => {
	const child = fakeChild();
	const queries: Array<{ taskId: string; requestId: string; message: string }> = [];
	const runner = new AgentRunner(new TaskStore(), { maxConcurrency: 1, stallTimeoutMs: 10_000 }, { spawn: () => child.child, now: () => 1, schedule: () => () => {}, pi: { command: "pi", args: [] } }, {
		askUser: async () => ({ cancelled: true }), onQuery: (task, requestId, message) => { queries.push({ taskId: task.id, requestId, message }); },
	});
	const task = runner.run(request());
	await tick();
	for (const [id, message] of [["q1", "Which file?"], ["q2", "two"], ["q3", "three"], ["q4", "four"], ["q5", "five"], ["q1", "duplicate"]]) child.message({ id, kind: "query", message });
	await tick();
	assert.deepEqual(queries, ["q1", "q2", "q3", "q4"].map((requestId, index) => ({ taskId: task.id, requestId, message: ["Which file?", "two", "three", "four"][index] })));
	assert.deepEqual(child.sent.slice(-2), [{ id: "q5", kind: "reply", error: "too many pending parent queries" }, { id: "q1", kind: "reply", error: "duplicate query request" }]);
	assert.equal(await runner.reply(task.id, "q1", "src/a.ts", "s1"), true);
	assert.equal(await runner.reply(task.id, "q1", "again", "s1"), false);
	assert.equal(await runner.reply(task.id, "q2", "other", "s2"), false);
	assert.equal(await runner.reply(task.id, "q2", "x".repeat(CHILD_MESSAGE_MAX_BYTES + 1), "s1"), false);
	assert.deepEqual(child.sent.at(-1), { id: "q1", kind: "reply", message: "src/a.ts" });
});

test("a throwing query hook rolls back ownership before one error and never schedules a second reply", async () => {
	const child = fakeChild();
	const timers: Array<{ fn: () => void; ms: number }> = [];
	const runner = new AgentRunner(new TaskStore(), { maxConcurrency: 1, stallTimeoutMs: 10_000 }, { spawn: () => child.child, now: () => 1, schedule: (fn, ms) => { timers.push({ fn, ms }); return () => {}; }, pi: { command: "pi", args: [] } }, { askUser: async () => ({ cancelled: true }), onQuery: () => { throw new Error("host callback failed"); } });
	const task = runner.run(request());
	await tick();
	child.message({ id: "q1", kind: "query", message: "throw" });
	assert.deepEqual(child.sent.at(-1), { id: "q1", kind: "reply", error: "parent rejected query" });
	assert.equal(await runner.reply(task.id, "q1", "late", "s1"), false);
	timers.at(-1)?.fn();
	assert.equal(child.sent.filter((frame) => frame.id === "q1").length, 1);
});

test("query expiry, IPC revocation, delayed callbacks, and foreground admission settle once", async () => {
	const child = fakeChild();
	const timers: Array<{ fn: () => void; ms: number }> = [];
	const runner = new AgentRunner(new TaskStore(), { maxConcurrency: 1, stallTimeoutMs: 10_000 }, { spawn: () => child.child, now: () => 1, schedule: (fn, ms) => { timers.push({ fn, ms }); return () => {}; }, pi: { command: "pi", args: [] } }, { askUser: async () => ({ cancelled: true }), onQuery: () => {} });
	const task = runner.run(request());
	await tick();
	child.message({ id: "q1", kind: "query", message: "wait" });
	assert.equal(timers.at(-1)?.ms, 120_000);
	let callback: ((error: Error | null) => void) | undefined;
	child.child.send = (_frame, done) => { callback = done; return false; };
	const pending = runner.reply(task.id, "q1", "late", "s1");
	timers.at(-1)?.fn();
	assert.equal(await pending, false);
	callback?.(null);
	assert.equal(await runner.reply(task.id, "q1", "again", "s1"), false);
	child.message({ id: "q2", kind: "query", message: "disconnect" });
	child.child.disconnect?.();
	assert.equal(await runner.reply(task.id, "q2", "no", "s1"), false);
	const foregroundChild = fakeChild();
	let foregroundQueries = 0;
	const foreground = new AgentRunner(new TaskStore(), { maxConcurrency: 1, stallTimeoutMs: 10_000 }, { spawn: () => foregroundChild.child, now: () => 1, schedule: () => () => {}, pi: { command: "pi", args: [] } }, { askUser: async () => ({ cancelled: true }), onQuery: () => { foregroundQueries += 1; } });
	foreground.run(request(AGENT_MODE.TASK));
	await tick();
	foregroundChild.message({ id: "q1", kind: "query", message: "not yet" });
	await tick();
	assert.equal(foregroundQueries, 1);
});

// S15 P9a regression probes (independent verifier mwb7rj51-1n-h3x2): late
// replies, ownership, registry bounds, and the stall watchdog while a query waits.
function lateHarness(limits: { stallTimeoutMs: number; toolStallTimeoutMs?: number } = { stallTimeoutMs: 600_000 }) {
	const children: FakeChild[] = [];
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	const store = new TaskStore();
	const runner = new AgentRunner(store, { maxConcurrency: 100, stallTimeoutMs: limits.stallTimeoutMs, toolStallTimeoutMs: limits.toolStallTimeoutMs }, {
		spawn: () => { const created = fakeChild(); children.push(created); return created.child; }, now: () => 1,
		schedule: (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; }, pi: { command: "pi", args: [] },
	}, { askUser: async () => ({ cancelled: true }), onQuery: () => {} });
	const expire = () => { const timer = timers.filter((entry) => entry.ms === CHILD_QUERY_TIMEOUT_MS && !entry.cancelled).shift()!; timer.cancelled = true; timer.fn(); };
	const steers = (index = 0) => children[index].written.filter((command) => command.type === "steer").map((command) => command.message as string);
	return { runner, store, children, timers, expire, steers };
}

test("race-replying-then-expiry: a reply in flight when the query expires delivers nothing late", async () => {
	const h = lateHarness();
	const task = h.runner.run(request()); await tick();
	h.children[0].message({ id: "q1", kind: "query", message: "?" });
	let callback: ((error: Error | null) => void) | undefined;
	h.children[0].child.send = (frame, done) => { h.children[0].sent.push(frame as never); callback = done; return true; };
	const pending = h.runner.reply(task.id, "q1", "ans", "s1");
	h.expire();
	callback?.(null);
	assert.equal(await pending, false);
	assert.equal(h.runner.replyLate(task.id, "q1", "ans", "s1"), undefined);
	await tick();
	assert.deepEqual(h.steers(), []);
});

test("wrong-session-late-not-consumed: another session cannot answer or spend a closed query", async () => {
	const h = lateHarness();
	const task = h.runner.run(request()); await tick();
	h.children[0].message({ id: "q1", kind: "query", message: "?" }); h.expire();
	assert.equal(h.runner.replyLate(task.id, "q1", "a", "other"), undefined);
	assert.equal(h.runner.replyLate(task.id, "q1", "a", "s1"), "delivered");
	assert.equal(h.runner.replyLate(task.id, "q1", "b", "s1"), undefined);
	await tick();
	assert.equal(h.steers().length, 1);
});

test("continued-task-gets-no-stale-answer: a late reply to a finished task never reaches a later task", async () => {
	const h = lateHarness();
	const first = h.runner.run(request()); await tick();
	h.children[0].message({ id: "q1", kind: "query", message: "?" }); h.expire();
	h.runner.cancel(first.id); await tick(); await tick();
	const second = h.runner.run(request()); await tick();
	assert.notEqual(first.id, second.id);
	assert.equal(h.runner.replyLate(first.id, "q1", "a", "s1"), "not running");
	assert.equal(h.runner.replyLate(second.id, "q1", "a", "s1"), undefined);
	await tick();
	assert.deepEqual(h.steers(1), []);
});

test("same-request-id-two-tasks: each late answer reaches only its own task", async () => {
	const h = lateHarness();
	const a = h.runner.run(request()); const b = h.runner.run(request()); await tick();
	h.children[0].message({ id: "q1", kind: "query", message: "?" }); h.children[1].message({ id: "q1", kind: "query", message: "?" });
	h.expire(); h.expire();
	assert.equal(h.runner.replyLate(b.id, "q1", "forB", "s1"), "delivered"); await tick();
	assert.deepEqual(h.steers(0), []); assert.equal(h.steers(1).length, 1);
	assert.equal(h.runner.replyLate(a.id, "q1", "forA", "s1"), "delivered"); await tick();
	assert.match(h.steers(0)[0], /forA$/); assert.equal(h.steers(1).length, 1);
});

test("closed-registry-bounds: 16 closed queries per task and 64 tasks, never throwing", async () => {
	const h = lateHarness();
	const task = h.runner.run(request()); await tick();
	for (let index = 1; index <= 17; index += 1) { h.children[0].message({ id: `q${index}`, kind: "query", message: "?" }); h.expire(); }
	assert.equal(h.runner.replyLate(task.id, "q1", "a", "s1"), undefined);
	assert.equal(h.runner.replyLate(task.id, "q2", "a", "s1"), "delivered");
	const ids = [task.id];
	for (let index = 1; index <= 64; index += 1) { const next = h.runner.run(request()); await tick(); ids.push(next.id); h.children[index].message({ id: "q1", kind: "query", message: "?" }); h.expire(); }
	assert.equal(h.runner.replyLate(ids[0], "q3", "a", "s1"), undefined, "the oldest task is evicted");
	assert.equal(h.runner.replyLate(ids[1], "q1", "a", "s1"), "delivered");
	assert.equal(h.runner.replyLate(ids[64], "q1", "a", "s1"), "delivered");
});

test("oversize-late-not-consumed: a too-large late reply is reported and the request stays answerable", async () => {
	const h = lateHarness();
	const task = h.runner.run(request()); await tick();
	h.children[0].message({ id: "q1", kind: "query", message: "?" }); h.expire();
	assert.equal(h.runner.replyLate(task.id, "q1", "x".repeat(CHILD_MESSAGE_MAX_BYTES + 1), "s1"), "too large");
	assert.equal(h.runner.replyLate(task.id, "q1", "x".repeat(CHILD_MESSAGE_MAX_BYTES), "s1"), "delivered");
	await tick();
	assert.equal(h.steers().length, 1);
});

test("query-wait-not-killed-by-tool-stall: no stall timer fires before a pending query's deadline", async () => {
	const h = lateHarness({ stallTimeoutMs: 60_000, toolStallTimeoutMs: 60_000 });
	const task = h.runner.run(request()); await tick();
	h.children[0].emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "subagent_parent_message", args: { kind: "query" } });
	await tick();
	h.children[0].message({ id: "q1", kind: "query", message: "?" });
	const armed = h.timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms);
	assert.ok(armed.every((ms) => ms >= CHILD_QUERY_TIMEOUT_MS), `armed: ${JSON.stringify(armed)}`);
	assert.ok(armed.includes(CHILD_QUERY_TIMEOUT_MS + QUERY_STALL_MARGIN_MS));
	assert.equal(h.store.get(task.id)?.status, "running");
});

test("the normal stall budget returns once the query expires or is answered", async () => {
	for (const settle of ["expire", "reply"] as const) {
		const h = lateHarness({ stallTimeoutMs: 60_000, toolStallTimeoutMs: 60_000 });
		const task = h.runner.run(request()); await tick();
		h.children[0].message({ id: "q1", kind: "query", message: "?" });
		if (settle === "expire") h.expire();
		else assert.equal(await h.runner.reply(task.id, "q1", "ans", "s1"), true);
		const stall = h.timers.filter((timer) => !timer.cancelled);
		assert.deepEqual(stall.map((timer) => timer.ms), [60_000], settle);
		stall[0]!.fn();
		await tick();
		assert.equal(h.store.get(task.id)?.status, "timed_out", `${settle}: a child that hangs afterwards is still caught`);
	}
});
