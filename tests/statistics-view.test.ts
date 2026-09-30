import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { aggregateUsage, type AggregationRecord } from "../lib/session-aggregate.ts";
import { buildTimeline } from "../lib/session-timeline.ts";
import { ABSENT_COST, reportedCost, type UsageTokens } from "../lib/session-usage.ts";
import { buildStatisticsModel, renderStatistics, STATISTICS_NARROW_WIDTH, StatisticsView } from "../lib/statistics-view.ts";

// I8: the statistics overlay view. A width-aware renderer over a cached model,
// provenance on every figure, `n/a` for an unavailable value, and the overlay
// keys. `render` never recomputes an aggregate.

function tokens(partial: Partial<UsageTokens>): UsageTokens {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, ...partial };
}

const FIXTURE: readonly AggregationRecord[] = [
	{ source: "parent", sessionId: "s1", project: "projA", timestamp: 1000, model: "m1", provider: "p1", tokens: tokens({ input: 100, output: 40, cacheRead: 30, cacheWrite: 5, reasoning: 8, total: 175 }), cost: reportedCost(0.001) },
	{ source: "parent", sessionId: "s1", project: "projA", timestamp: 2000, model: "m1", provider: "p1", tokens: tokens({}), cost: ABSENT_COST },
	{ source: "subagent", sessionId: "s1", project: "projA", timestamp: 3000, model: "m2", provider: "p1", tokens: tokens({ input: 200, output: 60, cacheRead: 10, cacheWrite: 5, reasoning: 20, total: 275 }), cost: reportedCost(0.002), task: { taskId: "S1", agent: "gentle-ai-worker", label: "build", status: "completed", toolCalls: 7 } },
];

const AGGREGATE = aggregateUsage(FIXTURE, { now: () => 0 });
const EMPTY = aggregateUsage([], { now: () => 0 });
const TIMELINE = buildTimeline([
	{ kind: "user", timestamp: 0 },
	{ kind: "assistant", timestamp: 2000, model: "m1", toolCalls: [{ id: "c1", name: "bash", command: "git status" }] },
	{ kind: "toolResult", timestamp: 5000, toolName: "bash", toolCallId: "c1", isError: false },
	{ kind: "assistant", timestamp: 6000, model: "m1", toolCalls: [] },
]);

test("the model carries provenance, ratios and the per-subagent and per-model rows", () => {
	const model = buildStatisticsModel(AGGREGATE, TIMELINE, 42);
	assert.equal(model.cost, "0.003000");
	assert.equal(model.costProvenance, "partial");
	assert.equal(model.costAbsent, 1);
	assert.equal(model.turns, 3);
	assert.equal(model.tokens.total, 450);
	assert.deepEqual(model.subagents.map((row) => row.label), ["S1 gentle-ai-worker"]);
	assert.deepEqual(model.models.map((row) => row.label), ["p1/m1", "p1/m2"]);
	assert.equal(model.generatedAt, 42);
	assert.deepEqual(model.timeline, { modelMs: 3000, toolMs: 3000, idleMs: 0, wallClockMs: 6000 });
	assert.equal(model.ratios.find((entry) => entry.label === "cache-read share")!.value, "0.0889");
});

test("an unavailable figure renders n/a, never 0", () => {
	const model = buildStatisticsModel(EMPTY, null, 0);
	assert.equal(model.ratios.every((entry) => entry.value === "n/a"), true);
	const wide = renderStatistics(model, 100).join("\n");
	assert.match(wide, /n\/a/);
	assert.equal(model.timeline, null);
});

test("the narrow layout stacks its sections and fits the width", () => {
	for (const width of [24, 40, STATISTICS_NARROW_WIDTH - 1]) {
		const lines = renderStatistics(buildStatisticsModel(AGGREGATE, TIMELINE, 0), width);
		assert.equal(lines.every((line) => visibleWidth(line) <= width), true, `every line fits ${width}`);
		assert.equal(lines[0]!.trimEnd(), "Session statistics");
		assert.equal(lines.some((line) => line.includes("╭")), false, "no frame when narrow");
		assert.equal(lines.some((line) => line.includes("Subagents")), true);
		assert.equal(lines.some((line) => line.includes("Export")), true);
	}
});

test("the fullscreen layout is framed and every line is exactly the width", () => {
	for (const width of [STATISTICS_NARROW_WIDTH, 80, 120]) {
		const lines = renderStatistics(buildStatisticsModel(AGGREGATE, TIMELINE, 0), width);
		assert.equal(lines[0]!.startsWith("╭"), true);
		assert.equal(lines[lines.length - 1]!.startsWith("╰"), true);
		assert.equal(lines.every((line) => visibleWidth(line) === width), true, `every line is ${width} wide`);
		const text = lines.join("\n");
		assert.match(text, /partial/);
		assert.match(text, /S1 gentle-ai-worker/);
		assert.match(text, /p1\/m1/);
	}
});

test("the overlay keys close, export and refresh", () => {
	let closed = 0;
	let exported = 0;
	let refreshed = 0;
	const view = new StatisticsView({
		getModel: () => buildStatisticsModel(AGGREGATE, TIMELINE, 0),
		onClose: () => {
			closed += 1;
		},
		onExport: () => {
			exported += 1;
		},
		onRefresh: () => {
			refreshed += 1;
		},
	});
	view.handleInput("\u001b");
	view.handleInput("q");
	assert.equal(closed, 2);
	view.handleInput("e");
	assert.equal(exported, 1);
	view.handleInput("r");
	assert.equal(refreshed, 1);
	view.handleInput("x");
	assert.deepEqual([closed, exported, refreshed], [2, 1, 1], "an unknown key is ignored");
});

test("render reads the model getter and never rebuilds an aggregate", () => {
	let calls = 0;
	const view = new StatisticsView({
		getModel: () => {
			calls += 1;
			return buildStatisticsModel(AGGREGATE, TIMELINE, 0);
		},
		onClose: () => {},
		onExport: () => {},
		onRefresh: () => {},
	});
	view.render(80);
	view.render(80);
	assert.equal(calls, 2, "one model read per render, no recomputation");
});
