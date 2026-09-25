import assert from "node:assert/strict";
import test from "node:test";
import {
	GENTLE_AI_TIMING_ENTRY,
	GentleAiElapsedTimingLedger,
	parseGentleAiTimingData,
	readGentleAiTimings,
	type GentleAiTimingEntry,
} from "../lib/gentle-ai-elapsed-store.ts";

function entry(data: unknown): GentleAiTimingEntry {
	return { type: "custom", customType: GENTLE_AI_TIMING_ENTRY, data };
}

test("timing entry parsing accepts well-formed records and rejects the rest", () => {
	assert.deepEqual(parseGentleAiTimingData({ toolCallId: "c1", startedAt: 1 }), { toolCallId: "c1", startedAt: 1 });
	assert.deepEqual(parseGentleAiTimingData({ toolCallId: "c1", startedAt: 1, endedAt: 2 }), { toolCallId: "c1", startedAt: 1, endedAt: 2 });
	for (const bad of [undefined, null, "x", 5, [], {}, { startedAt: 1 }, { toolCallId: "" }, { toolCallId: "c1" }, { toolCallId: "c1", startedAt: "x" }, { toolCallId: "c1", startedAt: Number.NaN }, { toolCallId: "c1", startedAt: 1, endedAt: "x" }]) {
		assert.equal(parseGentleAiTimingData(bad), undefined, JSON.stringify(bad) ?? String(bad));
	}
});

test("replay keeps the last timing entry per tool call and ignores foreign entries", () => {
	const entries: GentleAiTimingEntry[] = [
		{ type: "message", customType: undefined, data: null },
		{ type: "custom", customType: "gentle-pi.session-worktree/v1", data: { root: "/x" } },
		entry({ toolCallId: "a", startedAt: 1 }),
		entry({ toolCallId: "a", startedAt: 1, endedAt: 9 }),
		entry({ toolCallId: "b", startedAt: 2 }),
		entry({ toolCallId: "a", startedAt: "corrupt" }),
	];
	const timings = readGentleAiTimings(entries);
	assert.deepEqual(timings.get("a"), { toolCallId: "a", startedAt: 1, endedAt: 9 }, "the corrupt last entry is ignored, not merged");
	assert.deepEqual(timings.get("b"), { toolCallId: "b", startedAt: 2 });
	assert.equal(timings.size, 2);
});

test("the ledger persists start and end once each and skips ends without a durable start", () => {
	const appended: Array<{ type: string; data?: unknown }> = [];
	const host = { appendEntry: (type: string, data?: unknown) => appended.push({ type, data }) };
	let stored: GentleAiTimingEntry[] = [];
	const session = { getEntries: () => stored };
	const ledger = new GentleAiElapsedTimingLedger(session, host);
	ledger.recordEnd("call-1", 500);
	assert.equal(appended.length, 0, "a terminal without a durable start has nothing honest to freeze");
	ledger.recordStart("call-1", 1_000);
	ledger.recordStart("call-1", 2_000);
	assert.equal(appended.length, 1, "a repeated start stage does not append again");
	stored = appended.map((append) => ({ type: "custom", customType: append.type, data: append.data }));
	ledger.recordEnd("call-1", 31_000);
	ledger.recordEnd("call-1", 32_000);
	stored = appended.map((append) => ({ type: "custom", customType: append.type, data: append.data }));
	assert.equal(appended.length, 2, "a repeated end stage does not append again");
	assert.deepEqual(appended.map((append) => append.data), [
		{ toolCallId: "call-1", startedAt: 1_000 },
		{ toolCallId: "call-1", startedAt: 1_000, endedAt: 31_000 },
	]);
	assert.deepEqual(ledger.lookup("call-1"), { toolCallId: "call-1", startedAt: 1_000, endedAt: 31_000 });
});

test("a fresh ledger restores timings recorded by a previous one", () => {
	const appended: Array<{ type: string; data?: unknown }> = [];
	const first = new GentleAiElapsedTimingLedger({ getEntries: () => [] }, { appendEntry: (type, data) => appended.push({ type, data }) });
	first.recordStart("call-1", 1_000);
	const stored: GentleAiTimingEntry[] = appended.map((append) => ({ type: "custom", customType: append.type, data: append.data }));
	const second = new GentleAiElapsedTimingLedger({ getEntries: () => stored });
	assert.deepEqual(second.lookup("call-1"), { toolCallId: "call-1", startedAt: 1_000 });
});
