import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptUsageRecord } from "../lib/session-transcript.ts";
import { ABSENT_COST, reportedCost, sessionCostUsd, type UsageTokens } from "../lib/session-usage.ts";
import {
	aggregateUsage,
	mergeMoneyFigure,
	ORCHESTRATOR_CLASS,
	UNIDENTIFIED_CLASS,
	UNKNOWN_PROJECT,
	type AggregationRecord,
	type AggregationTaskIdentity,
	type TokenFigure,
} from "../lib/session-aggregate.ts";

// I3: the pure aggregation engine. Hand-computed fixtures over the canonical
// usage record, an injected clock, no I/O, and a provenance flag on every
// monetary and token figure so a partial sum can never read as complete.

const CLOCK = 1_700_000_000_000;

function tokens(partial: Partial<UsageTokens>): UsageTokens {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, ...partial };
}

function tokenFigure(partial: Partial<UsageTokens>): TokenFigure {
	return { ...tokens(partial), provenance: "measured" };
}

function task(taskId: string, agent: string, toolCalls: number): AggregationTaskIdentity {
	return { taskId, agent, label: `${agent} run`, status: "completed", toolCalls };
}

const FIXTURE: readonly AggregationRecord[] = [
	{
		source: "parent",
		timestamp: 1000,
		sessionId: "sess-1",
		project: "projA",
		model: "m1",
		provider: "p1",
		tokens: tokens({ input: 100, output: 40, cacheRead: 30, cacheWrite: 5, reasoning: 8, total: 175 }),
		cost: reportedCost(0.001),
	},
	{
		source: "parent",
		timestamp: 2000,
		sessionId: "sess-1",
		project: "projA",
		model: "m1",
		provider: "p1",
		// A second turn that reported no cost at all: absence, not a reported zero.
		tokens: tokens({}),
		cost: ABSENT_COST,
	},
	{
		source: "subagent",
		timestamp: 3000,
		sessionId: "sess-1",
		project: "projA",
		model: "m2",
		provider: "p1",
		tokens: tokens({ input: 200, output: 60, cacheRead: 10, cacheWrite: 0, reasoning: 20, total: 270 }),
		cost: reportedCost(0.002),
		task: task("S1", "gentle-ai-worker", 7),
	},
	{
		source: "subagent",
		timestamp: 4000,
		sessionId: "sess-1",
		project: "projA",
		model: "m2",
		provider: "p1",
		tokens: tokens({ input: 50, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 70 }),
		cost: ABSENT_COST,
		task: task("S1", "gentle-ai-worker", 7),
	},
	{
		source: "subagent",
		timestamp: 5000,
		sessionId: "sess-1",
		project: "projB",
		model: "m3",
		provider: "p2",
		tokens: tokens({ input: 300, output: 90, cacheRead: 40, cacheWrite: 10, reasoning: 30, total: 440 }),
		cost: reportedCost(0.003),
		task: task("S2", "gentle-ai-verify", 3),
	},
];

// Everything reported, for the parent-plus-subagents identity.
const REPORTED_FIXTURE: readonly AggregationRecord[] = FIXTURE.map((record) =>
	record.cost.state === "absent" ? { ...record, cost: reportedCost(0) } : record,
);

const PARENT_ONLY = FIXTURE.filter((record) => record.source === "parent");
const SUBAGENT_ONLY = FIXTURE.filter((record) => record.source === "subagent");

function aggregate(records: readonly AggregationRecord[]) {
	return aggregateUsage(records, { now: () => CLOCK });
}

test("an empty session aggregates to a measured zero with no ratios and no breakdowns", () => {
	const result = aggregate([]);
	assert.equal(result.asOf, CLOCK);
	assert.equal(result.turns, 0);
	assert.deepEqual(result.cost, { nanoUsd: 0, provenance: "measured", absent: 0 });
	assert.deepEqual(result.tokens, tokenFigure({}));
	assert.deepEqual(result.ratios, {
		cacheReadShare: null,
		cacheWriteShare: null,
		reasoningShareOfOutput: null,
		outputToTotal: null,
		costPerTurn: null,
		tokensPerTurn: null,
	});
	assert.deepEqual(result.sessions, { value: 0, provenance: "measured" });
	assert.deepEqual(result.subagents, { value: 0, provenance: "measured" });
	assert.deepEqual(result.toolCalls, { value: 0, provenance: "measured" });
	assert.deepEqual(result.perSubagent, []);
	assert.deepEqual(result.perModel, []);
	assert.deepEqual(result.perAgentClass, []);
	assert.deepEqual(result.perProject, []);
});

test("session totals carry hand-computed tokens, cost, ratios and counts", () => {
	const result = aggregate(FIXTURE);
	assert.equal(result.turns, 5);
	assert.deepEqual(result.tokens, tokenFigure({ input: 650, output: 210, cacheRead: 80, cacheWrite: 15, reasoning: 58, total: 955 }));
	// Two components reported nothing: the total is partial and includes every reported part.
	assert.deepEqual(result.cost, { nanoUsd: 6_000_000, provenance: "partial", absent: 2 });
	assert.equal(sessionCostUsd({ nanoUsd: result.cost.nanoUsd, complete: result.cost.provenance === "measured", absent: result.cost.absent }), 0.006);
	assert.deepEqual(result.sessions, { value: 1, provenance: "measured" });
	assert.deepEqual(result.subagents, { value: 2, provenance: "measured" });
	// The orchestrator's own tool calls are not in the input, so the count is partial.
	assert.deepEqual(result.toolCalls, { value: 10, provenance: "partial" });
	assert.equal(result.ratios.cacheReadShare, 80 / 955);
	assert.equal(result.ratios.cacheWriteShare, 15 / 955);
	assert.equal(result.ratios.reasoningShareOfOutput, 58 / 210);
	assert.equal(result.ratios.outputToTotal, 210 / 955);
	// A ratio is a derived figure, so it is compared within floating-point tolerance.
	assert.ok(result.ratios.costPerTurn !== null && Math.abs(result.ratios.costPerTurn - 0.0012) < 1e-12);
	assert.equal(result.ratios.tokensPerTurn, 191);
});

test("an unreported subagent cost marks the total partial and never silently shrinks it", () => {
	const result = aggregate(FIXTURE);
	const worker = result.perSubagent.find((entry) => entry.taskId === "S1");
	assert.ok(worker);
	assert.equal(worker.turns, 2);
	assert.deepEqual(worker.cost, { nanoUsd: 2_000_000, provenance: "partial", absent: 1 });
	assert.deepEqual(worker.toolCalls, { value: 7, provenance: "measured" });
	assert.equal(worker.agent, "gentle-ai-worker");
	assert.equal(worker.label, "gentle-ai-worker run");
	assert.equal(worker.status, "completed");
	// The reported half is still there; the partial flag is what keeps it honest.
	assert.equal(sessionCostUsd({ nanoUsd: worker.cost.nanoUsd, complete: worker.cost.provenance === "measured", absent: worker.cost.absent }), 0.002);
	assert.deepEqual(result.tokens, tokenFigure({ input: 650, output: 210, cacheRead: 80, cacheWrite: 15, reasoning: 58, total: 955 }));
});

test("per-subagent totals plus the parent total equal the session total when every cost is reported", () => {
	const result = aggregate(REPORTED_FIXTURE);
	assert.equal(result.cost.provenance, "measured");
	const classes = result.perAgentClass;
	const orchestrator = classes.find((entry) => entry.agentClass === ORCHESTRATOR_CLASS);
	assert.ok(orchestrator);
	const subagents = classes.filter((entry) => entry.agentClass !== ORCHESTRATOR_CLASS);
	const merged = subagents.reduce((total, entry) => mergeMoneyFigure(total, entry.cost), orchestrator.cost);
	assert.deepEqual(merged, result.cost);
	assert.equal(result.cost.nanoUsd, 6_000_000);
});

test("breakdowns are stable-ordered and group by model, agent class and project", () => {
	const result = aggregate(FIXTURE);

	assert.deepEqual(result.perModel.map((entry) => `${entry.provider}/${entry.model}`), ["p1/m1", "p1/m2", "p2/m3"]);
	assert.deepEqual(result.perModel[0]!.cost, { nanoUsd: 1_000_000, provenance: "partial", absent: 1 });
	assert.equal(result.perModel[0]!.turns, 2);
	assert.deepEqual(result.perModel[1]!.tokens, tokenFigure({ input: 250, output: 80, cacheRead: 10, cacheWrite: 0, reasoning: 20, total: 340 }));

	assert.deepEqual(result.perAgentClass.map((entry) => entry.agentClass), ["gentle-ai-verify", "gentle-ai-worker", ORCHESTRATOR_CLASS]);
	assert.deepEqual(result.perAgentClass[2]!.cost, { nanoUsd: 1_000_000, provenance: "partial", absent: 1 });

	assert.deepEqual(result.perProject.map((entry) => entry.project), ["projA", "projB"]);
	assert.deepEqual(result.perProject[0]!.cost, { nanoUsd: 3_000_000, provenance: "partial", absent: 2 });
	assert.equal(result.perProject[0]!.turns, 4);
	assert.deepEqual(result.perProject[0]!.tokens, tokenFigure({ input: 350, output: 120, cacheRead: 40, cacheWrite: 5, reasoning: 28, total: 515 }));
	assert.deepEqual(result.perProject[1]!.cost, { nanoUsd: 3_000_000, provenance: "measured", absent: 0 });
});

test("a subagent without a task is reported as unidentified and makes the counts partial", () => {
	const orphan: AggregationRecord = {
		source: "subagent",
		timestamp: 6000,
		sessionId: "sess-1",
		model: "m4",
		provider: "p3",
		tokens: tokens({ input: 10, output: 5, total: 15 }),
		cost: reportedCost(0.0005),
	};
	const result = aggregate([orphan]);
	assert.deepEqual(result.subagents, { value: 0, provenance: "partial" });
	assert.deepEqual(result.toolCalls, { value: 0, provenance: "partial" });
	assert.deepEqual(result.perAgentClass.map((entry) => entry.agentClass), [UNIDENTIFIED_CLASS]);
	assert.deepEqual(result.perProject.map((entry) => entry.project), [UNKNOWN_PROJECT]);
	assert.equal(result.cost.provenance, "measured");
});

test("a subagent-only aggregate can have a measured tool-call count", () => {
	const result = aggregate(SUBAGENT_ONLY);
	assert.deepEqual(result.toolCalls, { value: 10, provenance: "measured" });
	assert.deepEqual(result.subagents, { value: 2, provenance: "measured" });
});

test("the date range filters records on their timestamp, inclusive from and exclusive to", () => {
	const bounded = aggregateUsage(FIXTURE, { now: () => CLOCK, from: 3000 });
	assert.equal(bounded.turns, 3);
	assert.deepEqual(bounded.cost, { nanoUsd: 5_000_000, provenance: "partial", absent: 1 });

	const early = aggregateUsage(FIXTURE, { now: () => CLOCK, to: 3000 });
	assert.equal(early.turns, 2);
	assert.deepEqual(early.cost, { nanoUsd: 1_000_000, provenance: "partial", absent: 1 });

	const exact = aggregateUsage(FIXTURE, { now: () => CLOCK, from: 1000, to: 2000 });
	assert.equal(exact.turns, 1);
	assert.deepEqual(exact.cost, { nanoUsd: 1_000_000, provenance: "measured", absent: 0 });
});

test("the engine is pure and deterministic: same input and clock yield identical output and no mutation", () => {
	const before = JSON.stringify(FIXTURE);
	const first = aggregate(FIXTURE);
	const second = aggregate(FIXTURE);
	assert.deepEqual(first, second);
	assert.equal(first.asOf, CLOCK);
	assert.equal(JSON.stringify(FIXTURE), before, "the input records are not mutated");
});

test("a transcript usage record is accepted as an aggregation record", () => {
	const transcript = null as unknown as TranscriptUsageRecord;
	const accepted: AggregationRecord = transcript;
	assert.equal(typeof accepted, "object");
});
