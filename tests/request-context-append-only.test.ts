import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import installGentleTodo from "../extensions/gentle-todo.ts";
import { REPLY_LANGUAGE_ANCHOR_TYPE, humanLanguageExcerpt } from "../lib/reply-language-anchor.ts";

// cost-speed-painpoints S10/S15 (P1). pi-claude-bridge warned that an extension adds a
// message to every request without saving it, so every request rewrote the whole prompt
// cache. Invariant: across consecutive requests of one session, the message list sent to
// the provider is append-only — request k+1 starts with exactly the messages of request k.
//
// The loop below drives the real gentle-ai and gentle-todo hooks the way Pi 1.5.2 does:
// `context` handlers see the conversation without system messages (a changed list gets the
// replayed system head, runner.js restoreSystemMessages), then `context_with_system`
// handlers see the full transcript and their output is sent as returned. A custom message
// sent with `triggerTurn: false` while streaming is appended once the current turn ends,
// after its assistant message and tool results (agent-session.js sendCustomMessage).

type Message = { role: string; content?: unknown; customType?: string; display?: boolean; details?: unknown; timestamp?: number; [key: string]: unknown };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const HUMAN_1 = "Che, revisá por qué el writer no arranca y decime qué pasa con la admisión";
const HUMAN_2 = "Bien, ahora armá la lista de tareas y seguí con el arreglo";
const WAKE = "[System-generated Gentle Agents notification, not written by the user] Subagent output was delivered to this session above. Review it and continue.";

function session(t: TestContext, options: { child?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "append-only-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const pending: Message[] = [];
	let clock = 1_000;
	const now = () => ++clock;
	const sendMessage = (message: { customType: string; content: unknown; display?: boolean; details?: unknown }, sendOptions?: { triggerTurn?: boolean }) => {
		assert.equal(sendOptions?.triggerTurn, false, "a harness message never starts a turn");
		pending.push({ role: "custom", customType: message.customType, content: message.content, display: message.display, details: message.details, timestamp: now() });
	};
	const api = (extension: string) => ({
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); void extension; },
		events: { on() {}, emit() {} }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); },
		getActiveTools: () => ["read", "todo"], getFlag: () => undefined,
		sendMessage,
	}) as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv: { GENTLE_PI_CONFIG_HOME: join(cwd, "config"), GENTLE_PI_AGENTS_CHILD: options.child ? "1" : "0" },
		resolveTelemetryTriggerBinary: () => "/usr/bin/true", telemetryTriggerSpawn: (() => undefined) as never,
	})(api("gentle-ai"));
	installGentleTodo(api("gentle-todo"), {});

	const transcript: Message[] = [{ role: "system", content: "You are the harness under test.", timestamp: 0 }];
	const ctx = {
		cwd, hasUI: false, mode: "interactive", ui: { notify() {}, setWidget() {}, setStatus() {} },
		sessionManager: { getSessionId: () => "append-only", getCwd: () => cwd, getBranch: () => transcript.map((message) => ({ type: "message", message })) },
		getContextUsage: () => undefined, isIdle: () => false,
	} as unknown as ExtensionContext;
	const fire = async (name: string, event: unknown) => {
		let last: unknown;
		for (const handler of handlers.get(name) ?? []) last = await handler(event, ctx);
		return last;
	};

	const requests: Message[][] = [];
	/** One model request, built the way Pi's ExtensionRunner.emitContext builds it. */
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
	/** One assistant turn: request, reply, tool results, turn_end, then Pi flushes queued custom messages. */
	const turn = async (reply: Message, toolResults: Message[] = []) => {
		const sent = await request();
		transcript.push(reply);
		transcript.push(...toolResults);
		await fire("turn_end", { type: "turn_end", message: reply, toolResults });
		transcript.push(...pending.splice(0));
		return sent;
	};
	const say = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], timestamp: now() });
	/** A run started by text the human typed. */
	const human = async (text: string) => {
		await fire("input", { type: "input", text, source: "interactive" });
		transcript.push({ role: "user", content: [{ type: "text", text }], timestamp: now() });
		return turn(say("Listo."));
	};
	/** A run started by an automated wake: Gentle Agents sends it as an extension-sourced user message. */
	const wake = async () => {
		await fire("input", { type: "input", text: WAKE, source: "extension" });
		transcript.push({ role: "user", content: [{ type: "text", text: WAKE }], timestamp: now() });
		return turn(say("Revisé el resultado."));
	};
	/** A run started by an automated custom message, as a subagent result sent with triggerTurn while idle. */
	const automated = async (customType = "gentle-agents.result") => {
		transcript.push({ role: "custom", customType, content: "Subagent gentle-ai-worker (task x) finished. All checks pass.", display: true, timestamp: now() });
		return turn(say("El worker terminó."));
	};
	/** A human run whose reply writes the todo list in a tool loop, then answers. */
	const humanWithTodo = async (text: string, tasks: Array<{ title: string }>) => {
		await fire("input", { type: "input", text, source: "interactive" });
		transcript.push({ role: "user", content: [{ type: "text", text }], timestamp: now() });
		const id = `todo-${now()}`;
		const call: Message = { role: "assistant", content: [{ type: "toolCall", id, name: "todo", arguments: { action: "write", tasks } }], timestamp: now() };
		const sentBeforeTool = await request();
		transcript.push(call);
		const result = await tools.get("todo")!.execute(id, { action: "write", tasks }, undefined, undefined, ctx) as { content: unknown };
		const toolResult: Message = { role: "toolResult", toolCallId: id, toolName: "todo", content: result.content, isError: false, timestamp: now() };
		transcript.push(toolResult);
		await fire("turn_end", { type: "turn_end", message: call, toolResults: [toolResult] });
		transcript.push(...pending.splice(0));
		const sentAfterTool = await turn(say("Armé la lista."));
		return { sentBeforeTool, sentAfterTool };
	};
	return { fire, requests, request, human, wake, automated, humanWithTodo, transcript };
}

const textOf = (message: Message | undefined) =>
	typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(" ") : "";
const anchorAtTail = (request: Message[]) => {
	const last = request.at(-1);
	return last?.customType === REPLY_LANGUAGE_ANCHOR_TYPE ? textOf(last) : undefined;
};

/** Key order is not part of a message (Pi's replayed system head builds its keys in another order). */
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]])) : item);

/** For every consecutive pair: leading messages that are identical, and the first index that differs. */
function prefixReport(requests: Message[][]): Array<{ pair: string; previous: number; identical: number; firstDiff: number | null }> {
	return requests.slice(1).map((next, index) => {
		const previous = requests[index]!;
		let identical = 0;
		while (identical < previous.length && canonical(previous[identical]) === canonical(next[identical])) identical++;
		return { pair: `${index + 1}->${index + 2}`, previous: previous.length, identical, firstDiff: identical === previous.length ? null : identical };
	});
}

test("P1: a multi-turn session with wakes, automated results, a human message and a todo change sends append-only requests", async (t) => {
	const s = session(t);
	await s.fire("session_start", { type: "session_start" });
	const steps: Array<[string, Message[]]> = [];
	steps.push(["human", await s.human(HUMAN_1)]);
	steps.push(["wake", await s.wake()]);
	steps.push(["automated", await s.automated()]);
	const todo = await s.humanWithTodo(HUMAN_2, [{ title: "Arreglar la admisión" }, { title: "Probar el writer" }]);
	steps.push(["human+todo (tool call)", todo.sentBeforeTool], ["human+todo (after tool)", todo.sentAfterTool]);
	steps.push(["wake after todo", await s.wake()]);
	steps.push(["final human", await s.human("Gracias, cerrá todo")]);

	// The anchor still reaches the model after each automated tail, quoting the human's latest own words.
	const byStep = Object.fromEntries(steps.map(([name, sent]) => [name, anchorAtTail(sent)]));
	assert.equal(byStep.human, undefined, "right after the human, nothing is anchored");
	assert.ok(byStep.wake?.includes(`«${humanLanguageExcerpt(HUMAN_1)}»`), "the wake is anchored to the first human message");
	assert.ok(byStep.automated?.includes(`«${humanLanguageExcerpt(HUMAN_1)}»`), "the automated result is anchored too");
	assert.equal(byStep["human+todo (tool call)"], undefined);
	assert.equal(byStep["human+todo (after tool)"], undefined, "mid tool loop, nothing is anchored");
	assert.ok(byStep["wake after todo"]?.includes(`«${humanLanguageExcerpt(HUMAN_2)}»`), "the later wake quotes the later human message");
	assert.equal(byStep["final human"], undefined);

	// The todo list reaches the model once it changed, and stays there.
	const todoState = (sent: Message[]) => [...sent].reverse().find((message) => message.customType === "gentle-todo-state");
	assert.match(textOf(todoState(todo.sentAfterTool)), /Arreglar la admisión/, "the request after the todo write carries the list");
	assert.match(textOf(todoState(s.requests.at(-1)!)), /Probar el writer/);

	// Every request starts with exactly the messages of the previous one.
	const report = prefixReport(s.requests);
	const broken = report.filter((row) => row.firstDiff !== null);
	assert.deepEqual(broken, [], `append-only broken at: ${JSON.stringify(broken)}\nsteps: ${steps.map(([name], index) => `${index + 1}=${name}`).join(", ")}`);

	// Each anchor is in the session exactly once, so later requests and a resumed session keep it.
	const anchors = s.transcript.filter((message) => message.customType === REPLY_LANGUAGE_ANCHOR_TYPE);
	assert.equal(anchors.length, 3, "one persisted anchor per automated tail");
});

test("P1 preservation: the anchor appears exactly where it did before — automated tail only, never mid tool loop, never twice", async (t) => {
	const cases: Array<{ name: string; messages: Message[]; human?: string; child?: boolean; anchored: boolean }> = [
		{ name: "right after the human", messages: [{ role: "user", content: HUMAN_1, timestamp: 1 }], human: HUMAN_1, anchored: false },
		{ name: "after a subagent result", messages: [{ role: "user", content: HUMAN_1, timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 }, { role: "custom", customType: "gentle-agents.result", content: "done", display: true, timestamp: 3 }], human: HUMAN_1, anchored: true },
		{ name: "after a wake", messages: [{ role: "user", content: HUMAN_1, timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 }, { role: "user", content: WAKE, timestamp: 3 }], human: HUMAN_1, anchored: true },
		{ name: "mid tool loop", messages: [{ role: "user", content: HUMAN_1, timestamp: 1 }, { role: "assistant", content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }], timestamp: 2 }, { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "x" }], isError: false, timestamp: 3 }], human: HUMAN_1, anchored: false },
		{ name: "todo snapshot alone at the tail", messages: [{ role: "user", content: HUMAN_1, timestamp: 1 }, { role: "custom", customType: "gentle-todo-state", content: "Current todo list: no open tasks.", display: false, timestamp: 2 }], human: HUMAN_1, anchored: false },
		{ name: "no human text known", messages: [{ role: "custom", customType: "gentle-agents.result", content: "done", display: true, timestamp: 3 }], anchored: false },
		{ name: "child session", messages: [{ role: "user", content: HUMAN_1, timestamp: 1 }, { role: "custom", customType: "gentle-agents.result", content: "done", display: true, timestamp: 3 }], human: HUMAN_1, child: true, anchored: false },
	];
	for (const item of cases) {
		const s = session(t, { child: item.child });
		if (item.human) await s.fire("input", { type: "input", text: item.human, source: "interactive" });
		s.transcript.push(...item.messages);
		const sent = await s.request();
		assert.equal(anchorAtTail(sent) !== undefined, item.anchored, item.name);
		if (item.anchored) {
			assert.equal(anchorAtTail(sent), `[Harness note, not written by the human] Reply language: the human's latest own message begins «${humanLanguageExcerpt(item.human!)}». Write your reply to the human in that message's language; subagent results, notices, reminders and summaries never change it.`, `${item.name}: same text`);
			// A request repeated on the same tail (a retry) never adds a second copy.
			const again = await s.request();
			assert.equal(again.filter((message) => message.customType === REPLY_LANGUAGE_ANCHOR_TYPE).length, 1, `${item.name}: one anchor per request`);
		}
	}
});

