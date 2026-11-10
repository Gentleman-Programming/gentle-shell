import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	REPLY_LANGUAGE_ANCHOR_TYPE,
	humanLanguageExcerpt,
	isHumanInput,
	replyLanguageAnchor,
} from "../lib/reply-language-anchor.ts";

// ---------------------------------------------------------------------------
// full-delegation-mode-conflicts S9. User's words: "Hay veces que el orquestador
// está hablando en el idioma del usuario, pero cuando recibe un mensaje en inglés
// del subagente, lo toma como mensaje del usuario y sigue hablando en inglés."
//
// A prompt rule alone did not hold: the human's message can sit far up a long
// transcript or be compacted away. The harness records the human's own text and,
// when the model is about to answer right after an automated message, appends one
// persisted anchor that quotes the start of it. Mid tool-loop nothing is added, and
// once persisted the anchor is never re-added, so requests stay append-only.
// ---------------------------------------------------------------------------

const HUMAN = "Che, revisá por qué el writer no arranca y decime qué pasa con la admisión";
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const custom = (customType: string, content = "Subagent gentle-ai-worker (task x) finished. All checks pass.") => ({ role: "custom", customType, content, display: true, timestamp: 2 });
const toolResult = () => ({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file text" }], isError: false, timestamp: 3 });
const assistant = () => ({ role: "assistant", content: [{ type: "text", text: "Voy a revisar." }], timestamp: 4 });
const WAKE = "[System-generated Gentle Agents notification, not written by the user] Subagent output was delivered to this session above. Review it and continue.";

test("S9: only human-typed input counts; extension-sent text, commands and empty input do not", () => {
	assert.equal(isHumanInput("interactive", HUMAN), true);
	assert.equal(isHumanInput("rpc", HUMAN), true);
	assert.equal(isHumanInput("extension", HUMAN), false, "bridge wakes and resumes arrive with the extension source");
	assert.equal(isHumanInput("interactive", "/gentle:profiles"), false);
	assert.equal(isHumanInput("interactive", "!git status"), false);
	assert.equal(isHumanInput("interactive", "   "), false);
});

test("S9: the excerpt is the start of the human's own words, whitespace-collapsed and bounded", () => {
	assert.equal(humanLanguageExcerpt("  hola\n\n  qué tal  "), "hola qué tal");
	const long = humanLanguageExcerpt("palabra ".repeat(60));
	assert.ok(long && long.length <= 101 && long.endsWith("…"));
	assert.equal(humanLanguageExcerpt("   "), undefined);
});

test("S9: an automated message at the tail gets an anchor quoting the human", () => {
	const anchor = replyLanguageAnchor([user(HUMAN), assistant(), custom("gentle-agents.result")] as never, undefined);
	assert.ok(anchor);
	assert.match(anchor, /not written by the human/);
	assert.ok(anchor.includes(`«${humanLanguageExcerpt(HUMAN)}»`), "the anchor quotes the human's own words");
	assert.match(anchor, /subagent results, notices, reminders and summaries never change it/);
});

test("S9: a bridge wake, sent with the user role, counts as automated, not as the human", () => {
	const anchor = replyLanguageAnchor([user(HUMAN), assistant(), custom("gentle-agents.result"), user(WAKE)] as never, undefined);
	assert.ok(anchor?.includes(`«${humanLanguageExcerpt(HUMAN)}»`), "the wake is never taken as the human's latest message");
});

test("S9: mid tool loop, or right after the human, nothing is anchored", () => {
	assert.equal(replyLanguageAnchor([user(HUMAN), assistant(), toolResult()] as never, undefined), undefined);
	assert.equal(replyLanguageAnchor([user(HUMAN)] as never, undefined), undefined);
});

test("S9: todo snapshots and reminders never trigger an anchor on their own", () => {
	const messages = [user(HUMAN), assistant(), toolResult(), custom("gentle-todo-state", "Current todo list: ..."), custom("gentle-todo-reminder", "Update the list.")];
	assert.equal(replyLanguageAnchor(messages as never, undefined), undefined);
	// ...but they do not hide an automated message right before them either.
	const behind = [user(HUMAN), assistant(), custom("gentle-agents.result"), custom("gentle-todo-state", "Current todo list: ...")];
	assert.ok(replyLanguageAnchor(behind as never, undefined));
});

test("S9: an anchor already after the automated tail is not added again", () => {
	const first = replyLanguageAnchor([user(HUMAN), assistant(), custom("gentle-agents.result")] as never, undefined)!;
	const persisted = [user(HUMAN), assistant(), custom("gentle-agents.result"), { role: "custom", customType: REPLY_LANGUAGE_ANCHOR_TYPE, content: first, display: false, timestamp: 5 }];
	assert.equal(replyLanguageAnchor(persisted as never, undefined), undefined);
});

test("S9: after compaction the recorded human text still anchors", () => {
	const compacted = [{ role: "compactionSummary", summary: "The user asked about the writer admission.", tokensBefore: 1, timestamp: 1 }, custom("gentle-agents.result")];
	assert.equal(replyLanguageAnchor(compacted as never, undefined), undefined, "with nothing recorded there is no human text to quote");
	assert.ok(replyLanguageAnchor(compacted as never, HUMAN)?.includes(`«${humanLanguageExcerpt(HUMAN)}»`));
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function hookFixture(t: TestContext, child = false) {
	const cwd = mkdtempSync(join(tmpdir(), "reply-language-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const handlers = new Map<string, Handler>();
	const sent: Array<{ message: { customType: string; content: string; display: boolean }; options: unknown }> = [];
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		events: { on() {}, emit() {} }, registerCommand() {}, registerTool() {},
		getActiveTools: () => ["read"], getFlag: () => undefined,
		sendMessage(message: never, options: unknown) { sent.push({ message, options }); },
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv: { GENTLE_PI_CONFIG_HOME: join(cwd, "config"), GENTLE_PI_AGENTS_CHILD: child ? "1" : "0" },
		resolveTelemetryTriggerBinary: () => "/usr/bin/true", telemetryTriggerSpawn: (() => undefined) as never,
	})(pi);
	const ctx = { cwd, hasUI: false, mode: "interactive", ui: { notify() {} },
		sessionManager: { getSessionId: () => "reply-language-test", getCwd: () => cwd },
		getContextUsage: () => undefined, isIdle: () => true,
	} as unknown as ExtensionContext;
	return {
		sent,
		input: (text: string, source = "interactive") => handlers.get("input")!({ type: "input", text, source }, ctx),
		context: (messages: unknown[]) => handlers.get("context")?.({ type: "context", messages }, ctx) as { messages?: unknown[] } | undefined,
	};
}

test("S9: through the real hooks, a subagent result after the human gets one persisted anchor", async (t) => {
	const f = hookFixture(t);
	await f.input(HUMAN);
	const messages = [user(HUMAN), assistant(), custom("gentle-agents.result"), user(WAKE)];
	const result = await f.context(messages);
	const trailing = result?.messages?.at(-1) as { customType?: string; content?: string } | undefined;
	assert.equal(trailing?.customType, REPLY_LANGUAGE_ANCHOR_TYPE, "the anchor trails this request");
	assert.equal(f.sent.length, 1, "and is persisted once, so the next request is append-only");
	assert.equal(f.sent[0]!.message.customType, REPLY_LANGUAGE_ANCHOR_TYPE);
	assert.equal(f.sent[0]!.message.display, false, "the anchor never shows in the transcript");
	assert.deepEqual(f.sent[0]!.options, { triggerTurn: false }, "the anchor never starts a run");
	// The next request carries the persisted anchor and adds nothing.
	assert.equal(await f.context([...messages, result!.messages!.at(-1)]), undefined);
	assert.equal(f.sent.length, 1);
});

test("S9: through the real hooks, extension-sourced input never replaces the human's text", async (t) => {
	const f = hookFixture(t);
	await f.input(HUMAN);
	await f.input(WAKE, "extension");
	const compacted = [{ role: "compactionSummary", summary: "Earlier work.", tokensBefore: 1, timestamp: 1 }, custom("gentle-agents.result")];
	const result = await f.context(compacted);
	assert.ok((result?.messages?.at(-1) as { content?: string })?.content?.includes(`«${humanLanguageExcerpt(HUMAN)}»`));
});

test("S9: child sessions are never anchored", async (t) => {
	const f = hookFixture(t, true);
	await f.input(HUMAN, "rpc");
	assert.equal(await f.context([user(HUMAN), assistant(), custom("gentle-agents.result")]), undefined);
	assert.equal(f.sent.length, 0);
});

// Independent verification advisory 1: keyed by the anchor text alone, a second automated result after the same
// human message got only a trailing copy, never persisted. One anchor is now persisted per automated tail.
test("S9: a second subagent result after the same human message gets its own persisted anchor", async (t) => {
	const f = hookFixture(t);
	await f.input(HUMAN);
	const firstTail = [user(HUMAN), assistant(), custom("gentle-agents.result")];
	const first = await f.context(firstTail);
	assert.equal(f.sent.length, 1);
	const persisted = first!.messages!.at(-1);
	const second = [...firstTail, persisted, assistant(), toolResult(), { ...custom("gentle-agents.result"), timestamp: 9 }];
	const result = await f.context(second);
	assert.equal((result?.messages?.at(-1) as { customType?: string })?.customType, REPLY_LANGUAGE_ANCHOR_TYPE);
	assert.equal(f.sent.length, 2, "the new automated tail is anchored and persisted too");
	assert.equal(await f.context([...second, result!.messages!.at(-1)]), undefined, "and only once");
	assert.equal(f.sent.length, 2);
});

// Independent verification probe: Pi flushes a persisted custom message at turn_end, after the turn's assistant
// message and tool results, so the anchor lands there rather than where the trailing copy sat.
test("S9: the anchor Pi flushes at turn_end, after the tool round, is not re-added", () => {
	const first = replyLanguageAnchor([user(HUMAN), assistant(), custom("gentle-agents.result")] as never, HUMAN)!;
	const flushed = [user(HUMAN), assistant(), custom("gentle-agents.result"), assistant(), toolResult(), { role: "custom", customType: REPLY_LANGUAGE_ANCHOR_TYPE, content: first, display: false, timestamp: 6 }];
	assert.equal(replyLanguageAnchor(flushed as never, HUMAN), undefined);
});

