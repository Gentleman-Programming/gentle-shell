import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_MODE, type AgentDefinition, type AgentMode } from "../lib/agents-config.ts";
import { CHILD_MESSAGE_MAX_BYTES, ChildMessenger } from "../lib/agents-messaging.ts";
import { TaskStore } from "../lib/agents-protocol.ts";
import { AgentRunner } from "../lib/agents-runner.ts";
import { fakeChild } from "./agents-fake-child.ts";

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
	assert.equal(timers.at(-1)?.ms, 30_000);
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
