import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { REPLY_LANGUAGE_ANCHOR_TYPE, placePersistedReplyAnchors } from "../lib/reply-language-anchor.ts";

// cost-speed-painpoints S10/S15 (P1), independent verifier probes (mwb638m6-12-yqki). Pi saves an anchor sent
// while streaming only when the turn ends, after the reply and its tool results; the saved copy records the
// message it followed and is moved back there on every later request. These probes pin that placement in the
// cases a plain session does not reach: a tool loop in progress, consecutive automated messages, compaction,
// branch switches, anchors saved before placement existed, and a long session.

type Message = { role: string; content?: unknown; customType?: string; timestamp?: number; [key: string]: unknown };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const HUMAN = "Che, revisá por qué el writer no arranca y decime qué pasa con la admisión";
const WAKE = "[System-generated Gentle Agents notification, not written by the user] Subagent output was delivered to this session above. Review it and continue.";
let clock = 100;
const sys: Message = { role: "system", content: "prompt", timestamp: 0 };
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: ++clock });
const assistant = (call?: string): Message => ({ role: "assistant", content: call ? [{ type: "toolCall", id: call, name: "read", arguments: {} }] : [{ type: "text", text: "ok" }], timestamp: ++clock });
const toolResult = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "r" }], isError: false, timestamp: ++clock });
const result = (): Message => ({ role: "custom", customType: "gentle-agents.result", content: "Subagent finished.", display: true, timestamp: ++clock });
const compactionSummary = (): Message => ({ role: "compactionSummary", summary: "s", tokensBefore: 1, timestamp: ++clock });

function fixture(t: TestContext) {
	const cwd = mkdtempSync(join(tmpdir(), "anchor-placement-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const handlers = new Map<string, Handler[]>();
	const sent: Message[] = [];
	const api = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on() {}, emit() {} }, registerCommand() {}, registerTool() {}, registerShortcut() {}, registerMessageRenderer() {},
		getActiveTools: () => ["read", "todo"], getFlag: () => undefined,
		// Pi stamps the saved copy itself, later than the request that carried it.
		sendMessage(message: Message, options: unknown) { sent.push({ ...message, role: "custom", timestamp: ++clock, _options: options }); },
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv: { GENTLE_PI_CONFIG_HOME: join(cwd, "config"), GENTLE_PI_AGENTS_CHILD: "0" },
		resolveTelemetryTriggerBinary: () => "/usr/bin/true", telemetryTriggerSpawn: (() => undefined) as never,
	})(api);
	const ctx = {
		cwd, hasUI: false, mode: "interactive", ui: { notify() {}, setWidget() {}, setStatus() {} },
		sessionManager: { getSessionId: () => "anchor-placement", getCwd: () => cwd, getBranch: () => [] },
		getContextUsage: () => undefined, isIdle: () => false,
	} as unknown as ExtensionContext;
	const fire = async (name: string, event: unknown) => {
		let last: unknown;
		for (const handler of handlers.get(name) ?? []) last = await handler(event, ctx);
		return last;
	};
	return {
		sent,
		input: (text: string) => fire("input", { type: "input", text, source: "interactive" }),
		/** Pi 1.5.2 order: `context` handlers (no system messages), then `context_with_system` (full transcript). */
		request: async (messages: Message[]): Promise<Message[]> => {
			let current = structuredClone(messages);
			for (const handler of handlers.get("context") ?? []) {
				const visible = current.filter((message) => message.role !== "system");
				const returned = await handler({ type: "context", messages: visible }, ctx) as { messages?: Message[] } | undefined;
				if (returned?.messages) current = [...current.filter((message) => message.role === "system"), ...returned.messages];
			}
			for (const handler of handlers.get("context_with_system") ?? []) {
				const returned = await handler({ type: "context_with_system", messages: current }, ctx) as { messages?: Message[] } | undefined;
				current = returned?.messages ?? current;
			}
			return current;
		},
	};
}

/** The saved copies as Pi would hold them in the session, without the fixture's bookkeeping. */
const saved = (messages: Message[]): Message[] => messages.map(({ _options, ...rest }) => rest);
const isAnchor = (message: Message | undefined) => message?.customType === REPLY_LANGUAGE_ANCHOR_TYPE;
/** System head first, no leading assistant, and every toolCall immediately answered by its toolResult. */
function protocolOk(list: Message[]): boolean {
	if (list[0]?.role !== "system") return false;
	if (list.find((message) => message.role !== "system")?.role === "assistant") return false;
	return list.every((message, index) => message.role !== "assistant"
		|| (message.content as Array<{ type: string; id?: string }>).filter((part) => part.type === "toolCall")
			.every((part, offset) => list[index + 1 + offset]?.role === "toolResult" && list[index + 1 + offset]!.toolCallId === part.id));
}

test("P1 placement: during a tool loop the saved anchor returns behind the automated result, never between a toolCall and its toolResult, and is not added again", async (t) => {
	const f = fixture(t);
	await f.input(HUMAN);
	const base = [sys, user(HUMAN), assistant(), result()];
	const k = await f.request(base);
	assert.ok(isAnchor(k.at(-1)));
	assert.equal(f.sent.length, 1);
	const k1 = await f.request([...base, assistant("c1"), toolResult("c1"), ...saved(f.sent)]);
	assert.deepEqual(k1.slice(0, k.length), k, "request k+1 extends request k");
	assert.ok(protocolOk(k1));
	assert.equal(f.sent.length, 1, "no second anchor mid loop");
	assert.ok(!isAnchor(k1.at(-1)));
});

test("P1 placement: after two automated messages in a row the anchor follows the second and the next request extends it", async (t) => {
	const f = fixture(t);
	await f.input(HUMAN);
	const base = [sys, user(HUMAN), assistant(), result(), user(WAKE)];
	const k = await f.request(base);
	const k1 = await f.request([...base, assistant(), ...saved(f.sent)]);
	assert.deepEqual(k1.slice(0, k.length), k);
	assert.ok(protocolOk(k1));
	assert.equal(f.sent.length, 1);
});

test("P1 placement: when compaction removed the anchor's predecessor, the anchor stays put and requests are stable", async (t) => {
	const f = fixture(t);
	await f.input(HUMAN);
	await f.request([sys, user(HUMAN), assistant(), result()]);
	const compacted = [sys, compactionSummary(), assistant(), saved(f.sent)[0]!, user("seguí")];
	assert.equal(placePersistedReplyAnchors(compacted), undefined);
	const first = await f.request(compacted);
	const second = await f.request(compacted);
	assert.deepEqual(first, second);
	assert.deepEqual(first, compacted);
	assert.ok(protocolOk(first));
});

test("P1 placement: with a compaction summary at the head, an automated message is anchored right after it", async (t) => {
	const f = fixture(t);
	await f.input(HUMAN);
	const k = await f.request([sys, compactionSummary(), result()]);
	assert.ok(isAnchor(k.at(-1)));
	assert.ok(protocolOk(k));
});

test("P1 placement: after a branch switch replaced the anchor's predecessor, the anchor stays put; another message never matches its identity", async (t) => {
	const f = fixture(t);
	await f.input(HUMAN);
	await f.request([sys, user(HUMAN), assistant(), result()]);
	const other = [sys, user("otra rama"), assistant(), result(), assistant(), saved(f.sent)[0]!];
	assert.equal(placePersistedReplyAnchors(other), undefined);
	assert.ok(protocolOk(await f.request(other)));
});

test("P1 placement: anchors saved without placement stay where they are while new ones move, and placement is idempotent", async (t) => {
	const f = fixture(t);
	await f.input(HUMAN);
	const legacy: Message = { role: "custom", customType: REPLY_LANGUAGE_ANCHOR_TYPE, content: "legacy", display: false, timestamp: ++clock };
	const head = [sys, user(HUMAN), assistant(), result(), assistant(), legacy, user("sigo"), assistant(), result()];
	const k = await f.request(head);
	const next = [...head, assistant(), ...saved(f.sent)];
	const k1 = await f.request(next);
	assert.deepEqual(k1.slice(0, k.length), k);
	assert.equal(k1.findIndex((message) => message.content === "legacy"), 5);
	const placed = placePersistedReplyAnchors(next)!;
	assert.equal(placePersistedReplyAnchors(placed), undefined);
});

test("P1 placement: a long session with 50 anchors stays append-only and placement is cheap and idempotent", async (t) => {
	const f = fixture(t);
	await f.input(HUMAN);
	const persisted: Message[] = [sys, user(HUMAN), assistant()];
	const snapshots: Message[][] = [];
	for (let i = 0; i < 50; i++) {
		persisted.push(result());
		snapshots.push(await f.request(persisted));
		for (let j = 0; j < 8; j++) {
			persisted.push(assistant(`c${i}_${j}`), toolResult(`c${i}_${j}`));
			if (j === 0) persisted.push(saved([f.sent[i]!])[0]!);
			snapshots.push(await f.request(persisted));
		}
		persisted.push(assistant());
	}
	assert.equal(f.sent.length, 50);
	const started = performance.now();
	let placed: Message[] | undefined;
	for (let n = 0; n < 200; n++) placed = placePersistedReplyAnchors(persisted);
	const perCall = (performance.now() - started) / 200;
	assert.ok(perCall < 5, `placement costs ${perCall.toFixed(3)} ms per call over ${persisted.length} messages`);
	assert.ok(placed);
	assert.equal(placePersistedReplyAnchors(placed), undefined, "second call: nothing moves");
	assert.ok(protocolOk(placed));
	for (let k = 1; k < snapshots.length; k++) assert.deepEqual(snapshots[k]!.slice(0, snapshots[k - 1]!.length), snapshots[k - 1], `request ${k + 1} extends request ${k}`);
	assert.deepEqual(await f.request(persisted), placed);
});
