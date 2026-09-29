import assert from "node:assert/strict";
import test from "node:test";
import {
	ABSENT_COST,
	accumulateTaskCost,
	addSessionCost,
	childUsageCost,
	costUsd,
	delegatedCostFromTasks,
	EMPTY_SESSION_COST,
	foldSessionCost,
	isReported,
	mergeSessionCost,
	NANO_USD_SCALE,
	reportedCost,
	reportedCostOrAbsent,
	sessionCostFromEntries,
	sessionCostUsd,
	type SessionUsageRecord,
	type TimeSegment,
	type TurnRecord,
} from "../lib/session-usage.ts";

// I1: the canonical SessionUsageRecord and its money primitive. A reported $0
// and an absent cost are different states; they must never collapse into one
// another, and money must sum without float drift.

test("reportedCost carries exact integer nano-USD and a USD round-trip", () => {
	assert.equal(NANO_USD_SCALE, 1_000_000_000);
	const cost = reportedCost(0.000344274);
	assert.deepEqual(cost, { state: "reported", nanoUsd: 344_274 });
	assert.equal(costUsd(cost), 0.000344274);
	assert.equal(isReported(cost), true);
});

test("a reported zero stays reported, not absent", () => {
	const zero = reportedCost(0);
	assert.deepEqual(zero, { state: "reported", nanoUsd: 0 });
	assert.equal(isReported(zero), true);
	assert.equal(costUsd(zero), 0);
	assert.deepEqual(ABSENT_COST, { state: "absent" });
	assert.equal(isReported(ABSENT_COST), false);
});

test("reportedCostOrAbsent only accepts a finite number as reported", () => {
	assert.deepEqual(reportedCostOrAbsent(0.0193), { state: "reported", nanoUsd: 19_300_000 });
	assert.deepEqual(reportedCostOrAbsent(0), { state: "reported", nanoUsd: 0 });
	for (const absent of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "1", {}]) {
		assert.deepEqual(reportedCostOrAbsent(absent), ABSENT_COST);
	}
});

test("addSessionCost sums exactly and tracks completeness", () => {
	let total = EMPTY_SESSION_COST;
	assert.deepEqual(total, { nanoUsd: 0, complete: true, absent: 0 });

	total = addSessionCost(total, reportedCost(0.5));
	total = addSessionCost(total, reportedCost(0.25));
	assert.deepEqual(total, { nanoUsd: 750_000_000, complete: true, absent: 0 });
	assert.equal(sessionCostUsd(total), 0.75);

	// A legitimate reported zero does not make the total partial.
	total = addSessionCost(total, reportedCost(0));
	assert.deepEqual(total, { nanoUsd: 750_000_000, complete: true, absent: 0 });

	// An absent component marks the total partial without changing the sum.
	total = addSessionCost(total, ABSENT_COST);
	assert.deepEqual(total, { nanoUsd: 750_000_000, complete: false, absent: 1 });

	// Once partial, always partial, even when later components are reported.
	total = addSessionCost(total, reportedCost(0.25));
	assert.deepEqual(total, { nanoUsd: 1_000_000_000, complete: false, absent: 1 });
	assert.equal(sessionCostUsd(total), 1);
});

test("present nine-decimal costs sum without float drift", () => {
	const total = foldSessionCost([reportedCost(0.00007485), reportedCost(0.0002364), reportedCost(0.000033024)]);
	assert.deepEqual(total, { nanoUsd: 344_274, complete: true, absent: 0 });
	assert.equal(sessionCostUsd(total), 0.000344274);
});

test("foldSessionCost over nothing is the empty complete total", () => {
	assert.deepEqual(foldSessionCost([]), EMPTY_SESSION_COST);
	assert.deepEqual(foldSessionCost([ABSENT_COST]), { nanoUsd: 0, complete: false, absent: 1 });
});

test("sessionCostFromEntries is the exposed parent fold: present, reported zero, absent", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.5 } } } },
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "assistant", usage: { cost: { total: 0 } } } },
		{ type: "message", message: { role: "assistant", usage: {} } },
		{ type: "custom", message: { role: "assistant", usage: { cost: { total: 9 } } } },
	];
	assert.deepEqual(sessionCostFromEntries(entries), { nanoUsd: 500_000_000, complete: false, absent: 1 });
	assert.deepEqual(sessionCostFromEntries([{ type: "message", message: { role: "assistant", usage: { cost: { total: 0 } } } }]), { nanoUsd: 0, complete: true, absent: 0 });
});

test("childUsageCost reads one child usage object without coercing absence", () => {
	assert.deepEqual(childUsageCost({ cost: { total: 0.0193 } }), { state: "reported", nanoUsd: 19_300_000 });
	assert.deepEqual(childUsageCost({ cost: { total: 0 } }), { state: "reported", nanoUsd: 0 });
	assert.deepEqual(childUsageCost({ totalTokens: 16 }), ABSENT_COST);
	assert.deepEqual(childUsageCost(undefined), ABSENT_COST);
});

test("accumulateTaskCost sums reported deltas and marks the task partial for good", () => {
	let task = { cost: 0 } as { cost: number; costComplete?: boolean };
	task = { ...task, ...accumulateTaskCost(task, reportedCost(0.5)) };
	task = { ...task, ...accumulateTaskCost(task, ABSENT_COST) };
	assert.equal(task.cost, 0.5);
	assert.equal(task.costComplete, false);
	task = { ...task, ...accumulateTaskCost(task, reportedCost(0.25)) };
	assert.equal(task.cost, 0.75);
	assert.equal(task.costComplete, false);
});

test("delegatedCostFromTasks folds subagents and flags any partial one", () => {
	assert.deepEqual(delegatedCostFromTasks([]), EMPTY_SESSION_COST);
	assert.deepEqual(delegatedCostFromTasks([{ cost: 0.5 }]), { nanoUsd: 500_000_000, complete: true, absent: 0 });
	assert.deepEqual(delegatedCostFromTasks([{ cost: 0.5 }, { cost: 0.25 }]), { nanoUsd: 750_000_000, complete: true, absent: 0 });
	assert.deepEqual(delegatedCostFromTasks([{ cost: 0.5, costComplete: false }, { cost: 0.25 }]), { nanoUsd: 750_000_000, complete: false, absent: 1 });
});

test("mergeSessionCost adds orchestrator and subagent totals without losing provenance", () => {
	assert.deepEqual(mergeSessionCost({ nanoUsd: 100_000_000, complete: true, absent: 0 }, { nanoUsd: 250_000_000, complete: true, absent: 0 }), { nanoUsd: 350_000_000, complete: true, absent: 0 });
	assert.deepEqual(mergeSessionCost({ nanoUsd: 100_000_000, complete: true, absent: 0 }, { nanoUsd: 0, complete: false, absent: 1 }), { nanoUsd: 100_000_000, complete: false, absent: 1 });
	assert.deepEqual(mergeSessionCost({ nanoUsd: 1, complete: false, absent: 2 }, { nanoUsd: 2, complete: false, absent: 3 }), { nanoUsd: 3, complete: false, absent: 5 });
});

test("SessionUsageRecord, TimeSegment and TurnRecord expose the canonical shape", () => {
	const record: SessionUsageRecord = {
		source: "subagent",
		taskId: "t1",
		timestamp: 1_788_600_000_000,
		model: "gpt-5.6-terra",
		provider: "openai-codex",
		effort: "high",
		tokens: { input: 499, output: 394, cacheRead: 11_008, cacheWrite: 0, reasoning: 184, total: 11_901 },
		cost: reportedCost(0.000344274),
	};
	assert.equal(Object.keys(record.tokens).length, 6);
	assert.equal(record.source, "subagent");

	const segment: TimeSegment = { kind: "tool", start: 1, end: 3, tool: "bash", callId: "c1" };
	const turn: TurnRecord = { index: 0, start: 1, end: 5, model: record.model, segments: [segment] };
	assert.equal(turn.segments[0]?.kind, "tool");
});
