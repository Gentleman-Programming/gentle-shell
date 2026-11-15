import assert from "node:assert/strict";
import test from "node:test";
import { echoTurn, sentMessage } from "../web/tower/src/model.ts";
import type { TowerChatTurn } from "../web/tower/src/types.ts";

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
	const used = new Set<TowerChatTurn>([first]);
	assert.equal(echoTurn(pending, [first], used), undefined);
	const second = you("again", T + 20);
	assert.equal(echoTurn(pending, [first, second], used), second);
	// Agent turns never acknowledge a message.
	assert.equal(echoTurn(sentMessage("hi", T, []), [{ role: "agent", text: "hi", at: T + 5 }], new Set()), undefined);
});
