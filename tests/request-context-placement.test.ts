import assert from "node:assert/strict";
import test from "node:test";

import { REPLY_LANGUAGE_ANCHOR_TYPE, placePersistedReplyAnchors } from "../lib/reply-language-anchor.ts";
import { placePersistedMessages, requestMessagePosition as key } from "../lib/request-context-placement.ts";

// cost-speed-painpoints S15 (P1b), independent verifier probes (mwb7zm1y-1r-1unr). Two hooks save hidden
// messages where their request carried them: gentle-ai places reply-language anchors, then gentle-todo places
// its snapshot and reminder. These cases pin `placePersistedMessages` with both kinds mixed, in the order Pi
// runs the hooks; the seeded property pins its invariants over random transcripts.

type Message = { role: string; content?: unknown; customType?: string; details?: unknown; timestamp?: number; toolCallId?: string; [key: string]: unknown };

const TODO_TYPES: ReadonlySet<string> = new Set(["gentle-todo-state", "gentle-todo-reminder"]);
const ALL_TYPES: ReadonlySet<string> = new Set([REPLY_LANGUAGE_ANCHOR_TYPE, ...TODO_TYPES]);

/** gentle-ai's `context_with_system` hook runs before gentle-todo's (extension load order). */
const hooks = (list: Message[]): Message[] => {
	const anchored = placePersistedReplyAnchors(list) ?? list;
	return placePersistedMessages(anchored, TODO_TYPES) ?? anchored;
};

const label = (list: Message[]) => list.map((message) =>
	message.customType === REPLY_LANGUAGE_ANCHOR_TYPE ? "ANCHOR"
		: message.customType ? message.customType.replace("gentle-todo-", "")
			: message.role === "assistant" && message.content === "call" ? "A(call)"
				: message.role === "assistant" ? "A" : message.role).join(" ");

const sys: Message = { role: "system", content: "s", timestamp: 0 };
const user: Message = { role: "user", content: "u", timestamp: 1 };
const call: Message = { role: "assistant", content: "call", timestamp: 2 };
const result: Message = { role: "toolResult", content: "r", timestamp: 3 };
const wake: Message = { role: "user", content: "[System-generated wake", timestamp: 4 };
const call2: Message = { role: "assistant", content: "call", timestamp: 20 };
const result2: Message = { role: "toolResult", content: "r", timestamp: 21 };
// Request k carried [sys, user, call, result, wake, ANCHOR (after wake), reminder (after the anchor)].
const anchor: Message = { role: "custom", customType: REPLY_LANGUAGE_ANCHOR_TYPE, content: "a", display: false, details: { after: key(wake), at: 10 }, timestamp: 10 };
const reminder: Message = { role: "custom", customType: "gentle-todo-reminder", content: "r", display: false, details: { after: key(anchor), at: 11 }, timestamp: 11 };
// Pi saves both after the reply and its tool results, stamped later.
const savedAnchor: Message = { ...anchor, timestamp: 22 };
const savedReminder: Message = { ...reminder, timestamp: 23 };

test("P1b placement: after a wake, the saved anchor and reminder both return to their place in order", () => {
	assert.equal(label(hooks([sys, user, call, result, wake, call2, result2, savedAnchor, savedReminder])), "system user A(call) toolResult user ANCHOR reminder A(call) toolResult");
});

test("P1b placement: when compaction removed the message they followed, both stay put", () => {
	const summary: Message = { role: "compactionSummary", summary: "s", timestamp: 30 };
	const compacted = [sys, summary, call2, result2, savedAnchor, savedReminder];
	assert.equal(label(hooks(compacted)), "system compactionSummary A(call) toolResult ANCHOR reminder");
	assert.equal(placePersistedMessages(compacted, ALL_TYPES), undefined, "nothing moves");
});

test("P1b placement: after parallel tool results that share a timestamp, the reminder goes after the last one", () => {
	const parallel: Message = { role: "assistant", content: "call", timestamp: 40 };
	const first: Message = { role: "toolResult", content: "a", timestamp: 41 };
	const second: Message = { role: "toolResult", content: "b", timestamp: 41 };
	const saved: Message = { role: "custom", customType: "gentle-todo-reminder", content: "r", details: { after: key(second), at: 42 }, timestamp: 50 };
	const placed = hooks([sys, user, parallel, first, second, call2, result2, saved]);
	assert.equal(label(placed), "system user A(call) toolResult toolResult reminder A(call) toolResult");
	assert.equal(placed[4], second, "never between a tool call and one of its results");
});

test("P1b placement: after a branch switch the message it followed is on the other branch, so it stays put", () => {
	const branch = [sys, user, { role: "assistant", content: "other", timestamp: 60 }, savedReminder];
	assert.equal(label(hooks(branch)), "system user A reminder");
	assert.equal(placePersistedMessages(branch, ALL_TYPES), undefined);
	assert.equal(placePersistedMessages([sys, user], ALL_TYPES), undefined, "no saved copy on this branch: nothing to do");
});

test("P1b placement: an anchor saved before P1b, following a reminder that was never saved, stays put", () => {
	const legacy: Message = { ...savedAnchor, details: { after: "custom|gentle-todo-reminder|999", at: 10 } };
	assert.equal(label(hooks([sys, user, call, result, wake, call2, result2, legacy])), "system user A(call) toolResult user A(call) toolResult ANCHOR");
});

/** Deterministic linear congruential generator, so every run checks the same lists. */
function random(seed: number) {
	let state = seed;
	return (n: number) => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		// The low bits of this generator repeat with a short period; use the high ones.
		return (state >>> 16) % n;
	};
}

/**
 * A transcript shaped like the hooks produce it: a system head, then users, plain assistants, tool batches
 * (results may share a timestamp), unrelated custom messages and saved copies. A saved copy records a message
 * that could have been its request's tail (never a tool call, never a result before the batch's last one),
 * each tail at most once, or a message compaction removed.
 */
function transcript(next: (n: number) => number): Message[] {
	let clock = 100;
	const list: Message[] = [{ role: "system", content: "s", timestamp: 0 }];
	const tails: Message[] = [list[0]!];
	const blocks = 1 + next(14);
	for (let block = 0; block < blocks; block++) {
		const kind = next(6);
		if (kind === 0) list.push({ role: "user", content: "u", timestamp: ++clock });
		else if (kind === 1) list.push({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: ++clock });
		else if (kind === 2) {
			const ids = Array.from({ length: 1 + next(3) }, (_, index) => `c${clock}-${index}`);
			list.push({ role: "assistant", content: ids.map((id) => ({ type: "toolCall", id })), timestamp: ++clock });
			const shared = next(2) === 0 ? ++clock : undefined;
			for (const id of ids) list.push({ role: "toolResult", toolCallId: id, content: "r", timestamp: shared ?? ++clock });
		} else if (kind === 3) list.push({ role: "custom", customType: "other", content: "x", timestamp: ++clock });
		else {
			const customType = [...ALL_TYPES][next(ALL_TYPES.size)]!;
			const at = ++clock;
			// Mostly an earlier tail, as Pi appends the saved copy after the reply that followed its request.
			const pick = tails.length > 0 && next(5) !== 0 ? tails.splice(next(Math.max(1, tails.length - (next(4) === 0 ? 0 : 1))), 1)[0]! : undefined;
			const after = pick === undefined ? "gone|x|1" : pick.role === "custom" && pick.details ? `custom|${pick.customType}|${(pick.details as { at: number }).at}` : key(pick);
			// Already in place (stamped with `at`) or saved later by Pi; some carry no placement (saved by an earlier version).
			const message: Message = { role: "custom", customType, content: "x", timestamp: next(2) === 0 ? at : ++clock };
			if (next(4) !== 0) message.details = { after, at };
			list.push(message);
		}
		const last = list.at(-1)!;
		if (!(last.role === "assistant" && Array.isArray(last.content) && (last.content as Array<{ type: string }>).some((part) => part.type === "toolCall"))) tails.push(last);
	}
	return list;
}

const isPlacement = (message: Message) => message.role === "custom" && typeof message.customType === "string" && ALL_TYPES.has(message.customType) && message.details !== undefined;

test("P1b placement property: over seeded random transcripts the helper keeps the protocol and is idempotent", () => {
	const next = random(7);
	let moved = 0;
	for (let iteration = 0; iteration < 5000; iteration++) {
		const input = transcript(next);
		const frozen = JSON.stringify(input);
		const placed = placePersistedMessages(input, ALL_TYPES);
		const output = placed ?? input;
		if (placed !== undefined) moved++;
		const where = `case ${iteration}: ${frozen}`;
		assert.equal(JSON.stringify(input), frozen, `input not mutated, ${where}`);
		assert.equal(output.length, input.length, where);
		assert.equal(output[0], input[0], `the first message never moves, ${where}`);
		assert.deepEqual(output.filter((message) => !isPlacement(message)), input.filter((message) => !isPlacement(message)), `other messages keep their order, ${where}`);
		output.forEach((message, index) => {
			if (message.role !== "assistant" || !Array.isArray(message.content)) return;
			const ids = (message.content as Array<{ type: string; id?: string }>).filter((part) => part.type === "toolCall").map((part) => part.id);
			ids.forEach((id, offset) => assert.equal(output[index + 1 + offset]?.toolCallId, id, `no message between a tool call and its results, ${where}`));
		});
		assert.equal(placePersistedMessages(output, ALL_TYPES), undefined, `a second call changes nothing, ${where}`);
	}
	assert.ok(moved > 500, `the generated lists exercise placement (${moved} moved)`);
});
