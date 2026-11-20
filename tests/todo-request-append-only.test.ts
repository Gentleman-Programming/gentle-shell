import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import installGentleTodo from "../extensions/gentle-todo.ts";

// cost-speed-painpoints S15 (P1b). The todo hook added two hidden messages that broke the
// request prefix: the reminder was request-local (in request k, gone in k+1) and the snapshot
// re-sent after compaction trailed one request but was saved later, after the reply. Invariant:
// request k+1 starts with exactly the messages of request k, while the model still receives
// the same reminder and snapshot at the same moments.
//
// The loop drives the real gentle-ai and gentle-todo hooks the way Pi 1.5.2 does: `context`
// handlers see the conversation without system messages (a changed list gets one replayed
// system head, runner.js restoreSystemMessages), then `context_with_system` handlers see the
// full transcript. A custom message sent with `triggerTurn: false` while streaming is stamped
// by Pi and appended once the turn ends, after the reply and its tool results
// (agent-session.js sendCustomMessage).

type Message = { role: string; content?: unknown; customType?: string; display?: boolean; details?: unknown; timestamp?: number; [key: string]: unknown };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const REMINDER = "The todo plan has not been reviewed during several tool-use turns. Check whether it still matches the work performed and update tasks where needed. Do not mark work done without verification.";
const PATCH: Message = { role: "system", content: "Mid-conversation tool patch.", timestamp: 5 };

function session(t: TestContext, transcript: Message[] = [{ role: "system", content: "You are the harness under test.", timestamp: 0 }, { role: "user", content: [{ type: "text", text: "Arreglá el bug" }], timestamp: 1 }, PATCH]) {
	const cwd = mkdtempSync(join(tmpdir(), "todo-append-only-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const pending: Message[] = [];
	let clock = 1_000;
	const now = () => ++clock;
	const api = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on() {}, emit() {} }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); },
		getActiveTools: () => ["read", "todo"], getFlag: () => undefined,
		sendMessage(message: Message, options?: { triggerTurn?: boolean }) {
			assert.equal(options?.triggerTurn, false, "a todo message never starts a turn");
			pending.push({ role: "custom", customType: message.customType, content: message.content, display: message.display, details: message.details, timestamp: now() });
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv: { GENTLE_PI_CONFIG_HOME: join(cwd, "config"), GENTLE_PI_AGENTS_CHILD: "0" },
		resolveTelemetryTriggerBinary: () => "/usr/bin/true", telemetryTriggerSpawn: (() => undefined) as never,
	})(api);
	installGentleTodo(api, {});
	const ctx = {
		cwd, hasUI: false, mode: "interactive", ui: { notify() {}, setWidget() {}, setStatus() {} },
		sessionManager: { getSessionId: () => "todo-append-only", getCwd: () => cwd, getBranch: () => transcript.map((message) => ({ type: "message", message })) },
		getContextUsage: () => undefined, isIdle: () => false,
	} as unknown as ExtensionContext;
	const fire = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const requests: Message[][] = [];
	const request = async (): Promise<Message[]> => {
		let current = structuredClone(transcript);
		for (const handler of handlers.get("context") ?? []) {
			const visible = current.filter((message) => message.role !== "system");
			const snapshot = visible.slice();
			const result = await handler({ type: "context", messages: visible }, ctx) as { messages?: Message[] } | undefined;
			const returned = result?.messages ?? (visible.every((message, index) => message === snapshot[index]) ? undefined : visible);
			if (!returned || (returned.length === snapshot.length && returned.every((message, index) => message === snapshot[index]))) continue;
			const head = getCurrentSystemMessage(current as never) as Message | undefined;
			current = head ? [head, ...returned] : returned;
		}
		for (const handler of handlers.get("context_with_system") ?? []) {
			const result = await handler({ type: "context_with_system", messages: current }, ctx) as { messages?: Message[] } | undefined;
			current = result?.messages ?? current;
		}
		const sent = structuredClone(current);
		requests.push(sent);
		return sent;
	};
	let call = 0;
	/** One model request whose reply calls `todo` (when params are given) or `read`; Pi then flushes queued messages. */
	const turn = async (todo?: Record<string, unknown>) => {
		await request();
		const id = `call-${++call}`;
		const assistant: Message = { role: "assistant", content: [{ type: "toolCall", id, name: todo ? "todo" : "read", arguments: todo ?? {} }], timestamp: now() };
		transcript.push(assistant);
		const content = todo ? (await tools.get("todo")!.execute(id, todo, undefined, undefined, ctx) as { content: unknown }).content : [{ type: "text", text: "ok" }];
		const toolResult: Message = { role: "toolResult", toolCallId: id, toolName: todo ? "todo" : "read", content, isError: false, timestamp: now() };
		transcript.push(toolResult);
		await fire("turn_end", { type: "turn_end", message: assistant, toolResults: [toolResult] });
		transcript.push(...pending.splice(0));
	};
	return { fire, transcript, requests, request, turn, pending };
}

const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]])) : item);

/** Consecutive request pairs (1-based) whose later request does not start with the earlier one. */
function prefixBreaks(requests: Message[][], from = 0): string[] {
	const breaks: string[] = [];
	for (let index = from + 1; index < requests.length; index++) {
		const previous = requests[index - 1]!;
		const next = requests[index]!;
		let identical = 0;
		while (identical < previous.length && canonical(previous[identical]) === canonical(next[identical])) identical++;
		if (identical < previous.length) breaks.push(`${index}->${index + 1} at ${identical} (${previous[identical]?.customType ?? previous[identical]?.role})`);
	}
	return breaks;
}

const reminders = (messages: Message[]) => messages.filter((message) => message.customType === "gentle-todo-reminder");
const snapshots = (messages: Message[]) => messages.filter((message) => message.customType === "gentle-todo-state");

test("P1b (a): the request after the one that carried the todo reminder extends it", async (t) => {
	const s = session(t);
	await s.fire("session_start", { type: "session_start" });
	await s.turn({ action: "write", tasks: [{ title: "Fix the bug" }, { title: "Ship it" }] });
	for (let index = 0; index < 4; index++) await s.turn();
	const fired = s.requests.length;
	await s.turn();
	await s.turn();
	await s.request();
	assert.equal(reminders(s.requests[fired]!).length, 1, "the fifth tool-loop request carries the reminder");
	assert.deepEqual(prefixBreaks(s.requests), [], "every request extends the previous one");
	for (const sent of s.requests) {
		assert.equal(sent[0]!.role, "system", "the system message stays first");
		assert.deepEqual(sent.find((message) => message.content === PATCH.content), PATCH, "a mid-conversation system message is never folded into the head");
	}
});

test("P1b (b): the request after a post-compaction snapshot extends it", async (t) => {
	const s = session(t);
	await s.fire("session_start", { type: "session_start" });
	await s.turn({ action: "write", tasks: [{ title: "Fix the bug" }] });
	await s.turn();
	// Compaction summarises the head of the conversation, including the saved snapshot.
	s.transcript.splice(1, s.transcript.length - 1, { role: "compactionSummary", summary: "Earlier work on the bug.", tokensBefore: 1, timestamp: 900 });
	const healed = s.requests.length;
	await s.turn();
	await s.turn();
	await s.turn();
	await s.request();
	for (const sent of s.requests.slice(healed)) assert.match(String(snapshots(sent).at(-1)?.content), /\[pending\] Fix the bug/, "every request after compaction carries the list");
	assert.equal(snapshots(s.transcript).length, 1, "the missing snapshot is saved exactly once");
	assert.deepEqual(prefixBreaks(s.requests, healed), [], "from the first request after compaction on, every request extends the previous one");
});

test("P1b (c): the reminder is delivered once per trigger with unchanged text, and rearms after a write", async (t) => {
	const s = session(t);
	await s.fire("session_start", { type: "session_start" });
	await s.turn({ action: "write", tasks: [{ title: "Fix the bug" }] });
	for (let index = 0; index < 4; index++) await s.turn();
	const fired = s.requests.length;
	// A retry of the same request (the provider failed before any reply) carries the same single copy.
	const first = await s.request();
	const retry = await s.request();
	assert.deepEqual(reminders(retry), reminders(first), "a retry repeats the same reminder bytes");
	s.requests.splice(fired + 1, 1);
	await s.turn();
	for (let index = 0; index < 3; index++) await s.turn();
	for (const sent of s.requests.slice(0, fired)) assert.equal(reminders(sent).length, 0, "no reminder before four tool turns");
	for (const sent of s.requests.slice(fired)) {
		assert.equal(reminders(sent).length, 1, "one reminder per trigger, never a second copy");
		assert.equal(reminders(sent)[0]!.content, REMINDER);
		assert.equal(reminders(sent)[0]!.display, false, "hidden from the visible conversation");
	}
	assert.equal(reminders(s.transcript).length, 1, "saved once, where the request carried it");
	// A successful write rearms it: four more tool turns, one more reminder.
	await s.turn({ action: "update", id: 1, status: "in_progress" });
	for (let index = 0; index < 4; index++) await s.turn();
	await s.request();
	assert.equal(reminders(s.requests.at(-1)!).length, 2, "the second trigger adds exactly one more");
	assert.deepEqual(prefixBreaks(s.requests), []);
});

test("P1b (d): a session saved before placement existed loads, and its snapshots stay where they were saved", async (t) => {
	const legacy: Message[] = [
		{ role: "system", content: "You are the harness under test.", timestamp: 0 },
		{ role: "user", content: [{ type: "text", text: "Arreglá el bug" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "old", name: "todo", arguments: { action: "write", tasks: [{ title: "Fix the bug" }] } }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "old", toolName: "todo", content: [{ type: "text", text: "ok" }], details: { gentleTodo: { tasks: [{ id: 1, title: "Fix the bug", status: "pending" }], nextId: 2, updatedTurn: 1 } }, isError: false, timestamp: 3 },
		{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 4 },
		{ role: "custom", customType: "gentle-todo-state", content: "Current todo list:\n1. [pending] Fix the bug", display: false, timestamp: 5 },
	];
	const s = session(t, structuredClone(legacy));
	await s.fire("session_start", { type: "session_start" });
	await s.turn();
	await s.turn();
	await s.request();
	assert.deepEqual(s.requests[0]!.slice(0, legacy.length), legacy, "the saved transcript is sent as it was");
	assert.deepEqual(prefixBreaks(s.requests), []);
});

test("P1b (e): the reminder survives an aborted turn exactly once", async (t) => {
	const s = session(t);
	await s.fire("session_start", { type: "session_start" });
	await s.turn({ action: "write", tasks: [{ title: "Fix the bug" }] });
	for (let index = 0; index < 4; index++) await s.turn();
	const fired = await s.request();
	assert.equal(reminders(fired).length, 1, "the request after four tool turns carries one reminder");
	// The human aborts while the model streams: the turn ends with an empty assistant message, Pi then appends what was saved.
	const aborted: Message = { role: "assistant", content: [], stopReason: "aborted", timestamp: 5000 };
	s.transcript.push(aborted);
	await s.fire("turn_end", { type: "turn_end", message: aborted, toolResults: [] });
	s.transcript.push(...s.pending.splice(0));
	s.transcript.push({ role: "user", content: [{ type: "text", text: "Seguí" }], timestamp: 5001 });
	const next = await s.request();
	assert.equal(reminders(next).length, 1, "the next request carries exactly one reminder");
	assert.equal(reminders(s.transcript).length, 1, "it is saved exactly once");
	assert.deepEqual(prefixBreaks(s.requests), [], "every request extends the previous one");
});
