import assert from "node:assert/strict";
import test from "node:test";
import { echoTurn, sentMessage, settleOutbox, turnKey, type Outgoing } from "../web/tower/src/model.ts";
import type { TowerChatTurn } from "../web/tower/src/types.ts";
import { buildTowerSnapshot, chatFromBranch, TOWER_CHAT_TURNS } from "../lib/tower-snapshot.ts";

const you = (text: string, at: number): TowerChatTurn => ({ role: "you", text, at });
const T = 1_700_000_000_000;

test("a sent message is acknowledged only by its own turn, recorded at or after it was sent", () => {
	const before = [you("yes", T - 1000)];
	const pending = sentMessage("yes, run tests", T, before);
	// An older, shorter turn already in the chat never acknowledges the new message.
	assert.equal(echoTurn(pending, before, new Set()), undefined);
	const own = you("yes, run tests", T + 300);
	assert.equal(echoTurn(pending, [...before, own], new Set()), own);
});

test("an identical turn that was already in the chat when sending is not the echo", () => {
	const before = [you("ok", T - 500)];
	const pending = sentMessage("ok", T, before);
	assert.equal(echoTurn(pending, before, new Set()), undefined);
	const own = you("ok", T + 100);
	assert.equal(echoTurn(pending, [...before, own], new Set()), own);
});

test("the text must match exactly, unless the session cut the turn at its length limit", () => {
	const pending = sentMessage("deploy", T, []);
	assert.equal(echoTurn(pending, [you("deploy now", T + 10)], new Set()), undefined);
	assert.equal(echoTurn(pending, [you("dep…", T + 10)], new Set()), undefined, "a short turn ending in … is not a cut one");
	const long = "x".repeat(1500);
	const cut = you(`${"x".repeat(1199)}…`, T + 10);
	assert.equal(echoTurn(sentMessage(long, T, []), [cut], new Set()), cut);
});

test("a turn from well before sending, or one already used by an earlier message, is not the echo", () => {
	const pending = sentMessage("again", T, []);
	assert.equal(echoTurn(pending, [you("again", T - 2500)], new Set()), undefined);
	const first = you("again", T + 10);
	const used = new Set([turnKey(first)]);
	assert.equal(echoTurn(pending, [first], used), undefined);
	const second = you("again", T + 20);
	assert.equal(echoTurn(pending, [first, second], used), second);
	// Agent turns never acknowledge a message.
	assert.equal(echoTurn(sentMessage("hi", T, []), [{ role: "agent", text: "hi", at: T + 5 }], new Set()), undefined);
});

const out = (text: string, at: number, chat: TowerChatTurn[], state: Outgoing["state"] = "sending"): Outgoing => ({ ...sentMessage(text, at, chat), state });
const texts = (items: readonly Outgoing[]) => items.map((o) => `${o.text}:${o.state}`);

test("a failed resend of an identical message shows as not sent, even after the earlier one's turn arrived", () => {
	const consumed = new Set<string>();
	// The first "ok" went through; the second was sent before the first one's turn reached the view.
	const first = out("ok", T, [], "sent");
	const second = out("ok", T + 500, []);
	const echo = you("ok", T + 100);
	// Every snapshot carries fresh turn objects: the same turn, rendered twice.
	let r = settleOutbox([first, second], [{ ...echo }], consumed);
	assert.deepEqual(texts(r.keep), ["ok:sending"], "the first message is acknowledged by its turn");
	assert.deepEqual(texts(r.show), ["ok:sending"]);
	r = settleOutbox(r.keep, [{ ...echo }], consumed);
	assert.deepEqual(texts(r.keep), ["ok:sending"], "a turn that acknowledged one message never acknowledges another");
	assert.deepEqual(texts(r.show), ["ok:sending"]);
	second.state = "failed";
	r = settleOutbox(r.keep, [{ ...echo }], consumed);
	assert.deepEqual(texts(r.show), ["ok:failed"], "the failed resend is shown as not sent");
	assert.deepEqual(texts(r.keep), ["ok:failed"]);
});

test("an identical turn matched while sending never marks a failed send as delivered", () => {
	const consumed = new Set<string>();
	const pending = out("ok", T, [{ role: "you", text: "ok", at: T - 5000 }]);
	// An identical turn appears (typed in the terminal) while the request is still pending: it is not shown twice.
	const typed = you("ok", T + 50);
	let r = settleOutbox([pending], [typed], consumed);
	assert.deepEqual(texts(r.keep), ["ok:sending"], "kept until the request answers");
	assert.deepEqual(texts(r.show), []);
	pending.state = "failed";
	r = settleOutbox(r.keep, [{ ...typed }], consumed);
	assert.deepEqual(texts(r.show), ["ok:failed"], "the failure is reported, not hidden behind the identical turn");
	assert.equal(consumed.size, 0, "a failed send never consumes a turn");
});

test("a delivered message whose turn arrived leaves the outbox", () => {
	const consumed = new Set<string>();
	const sent = out("hi", T, [], "sent");
	const turn = you("hi", T + 10);
	const r = settleOutbox([sent], [turn], consumed);
	assert.deepEqual([r.keep, r.show], [[], []]);
	assert.deepEqual([...consumed], [turnKey(turn)]);
	// Turns no longer in the chat are forgotten.
	settleOutbox([], [], consumed);
	assert.equal(consumed.size, 0);
});

test("a delivered Tower question remains with its answer after many visible assistant tool turns", () => {
	const terminal = { type: "message", message: { role: "user", content: "terminal question", timestamp: T - 1000 } };
	const previous = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "previous reply" }], timestamp: T - 500 } };
	const question = { type: "message", message: { role: "user", content: [{ type: "text", text: "tower question" }], timestamp: T + 10 } };
	const branch: unknown[] = [terminal, previous];
	const sent = out("tower question", T, chatFromBranch(branch), "sent");
	branch.push(question);
	const snapshot = (entries: unknown[]) => buildTowerSnapshot({ sessionId: "s", cwd: "/w/app", stats: { cost: 0, input: 0, output: 0 }, todos: [], agents: [], chat: chatFromBranch(entries), now: T + 1000 });
	const acknowledged = snapshot(branch).chat!;
	assert.deepEqual(acknowledged.map((t) => [t.role, t.text]), [["you", "terminal question"], ["agent", "previous reply"], ["you", "tower question"]]);
	const consumed = new Set<string>();
	assert.deepEqual(settleOutbox([sent], acknowledged, consumed).keep, [], "the publisher's user turn consumes the local outgoing copy");
	for (let i = 0; i < TOWER_CHAT_TURNS; i++) branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `working ${i}` }, { type: "toolCall", id: `t${i}`, name: "read", arguments: {} }], timestamp: T + 20 + i } });
	branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "final answer" }], timestamp: T + 200 } });
	const chat = snapshot(branch).chat!;
	assert.equal(chat.length, TOWER_CHAT_TURNS);
	assert.deepEqual(chat[0], you("tower question", T + 10), "the latest human question must survive the assistant's many intermediate messages");
	assert.deepEqual(chat.at(-1), { role: "agent", text: "final answer", at: T + 200 });
	assert.deepEqual(settleOutbox([], chat, consumed).show, [], "the acknowledged question is shown by the publisher, not duplicated from the outbox");
});

test("without a human question the conversation still keeps the latest bounded assistant turns", () => {
	const branch = Array.from({ length: TOWER_CHAT_TURNS + 3 }, (_, i) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `reply ${i}` }], timestamp: T + i } }));
	branch.splice(2, 0, { type: "message", message: { role: "user", content: [{ type: "text", text: "[System-generated wake] internal" }], timestamp: T + 2 } });
	const chat = chatFromBranch(branch);
	assert.equal(chat.length, TOWER_CHAT_TURNS);
	assert.equal(chat[0].text, "reply 3");
	assert.equal(chat.at(-1)?.text, `reply ${TOWER_CHAT_TURNS + 2}`);
	assert.ok(chat.every((t) => t.role === "agent"));
});
