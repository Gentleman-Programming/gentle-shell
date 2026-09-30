import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { aggregateUsage, type AggregationRecord } from "../lib/session-aggregate.ts";
import { buildTimeline } from "../lib/session-timeline.ts";
import { ABSENT_COST, reportedCost, type UsageTokens } from "../lib/session-usage.ts";
import { buildStatisticsModel, formatTokens, renderStatistics, STATISTICS_LEGEND, STATISTICS_NARROW_WIDTH, StatisticsView } from "../lib/statistics-view.ts";

// I8: the statistics overlay view. A width-aware renderer over a cached model,
// written for a human: readable magnitudes, no raw ids, provenance as one
// marker with a legend, `n/a` for an unavailable value, and no truncated line.

function tokens(partial: Partial<UsageTokens>): UsageTokens {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, ...partial };
}

const FIXTURE: readonly AggregationRecord[] = [
	{ source: "parent", sessionId: "s1", project: "projA", timestamp: 1000, model: "m1", provider: "p1", tokens: tokens({ input: 100, output: 40, cacheRead: 30, cacheWrite: 5, reasoning: 8, total: 175 }), cost: reportedCost(0.001) },
	{ source: "parent", sessionId: "s1", project: "projA", timestamp: 2000, model: "m1", provider: "p1", tokens: tokens({}), cost: ABSENT_COST },
	{ source: "subagent", sessionId: "s1", project: "projA", timestamp: 3000, model: "m2", provider: "p1", tokens: tokens({ input: 200, output: 60, cacheRead: 10, cacheWrite: 5, reasoning: 20, total: 275 }), cost: reportedCost(0.002), task: { taskId: "S1", agent: "gentle-ai-worker", label: "build the widget", status: "completed", toolCalls: 7 } },
];

const AGGREGATE = aggregateUsage(FIXTURE, { now: () => 0 });
const EMPTY = aggregateUsage([], { now: () => 0 });
const TIMELINE = buildTimeline([
	{ kind: "user", timestamp: 0 },
	{ kind: "assistant", timestamp: 2000, model: "m1", toolCalls: [{ id: "c1", name: "bash", command: "git status" }] },
	{ kind: "toolResult", timestamp: 5000, toolName: "bash", toolCallId: "c1", isError: false },
	{ kind: "assistant", timestamp: 6000, model: "m1", toolCalls: [] },
]);

test("the model carries provenance, ratios and human rows with the task id kept out of the label", () => {
	const model = buildStatisticsModel(AGGREGATE, TIMELINE, 42);
	assert.equal(model.costNanoUsd, 3_000_000);
	assert.equal(model.costProvenance, "partial");
	assert.equal(model.costAbsent, 1);
	assert.equal(model.turns, 3);
	assert.equal(model.tokens.total, 450);
	assert.deepEqual(model.subagents.map((row) => row.title), ["gentle-ai-worker"]);
	assert.deepEqual(model.subagents.map((row) => row.key), ["S1"], "the id is a key, not a label");
	assert.equal(model.subagents[0]!.subtitle, "build the widget");
	assert.deepEqual(model.models.map((row) => row.title), ["m1", "m2"]);
	assert.deepEqual(model.models.map((row) => row.subtitle), ["p1", "p1"]);
	assert.equal(model.generatedAt, 42);
	assert.deepEqual(model.timeline, { modelMs: 3000, toolMs: 3000, idleMs: 0, wallClockMs: 6000 });
	assert.equal(model.ratios.find((entry) => entry.label === "cache reads")!.value, "8.9%");
	assert.equal(model.ratios.find((entry) => entry.label === "tokens per turn")!.value, "150");
});

test("formatTokens renders readable magnitudes", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(7_780), "7.8K");
	assert.equal(formatTokens(122_803_929), "122.8M");
	assert.equal(formatTokens(1_500_000_000), "1.5B");
	assert.equal(formatTokens(null), "n/a");
});

test("an unavailable figure renders n/a, never 0", () => {
	const model = buildStatisticsModel(EMPTY, null, 0);
	assert.equal(model.ratios.every((entry) => entry.value === "n/a"), true);
	assert.match(renderStatistics(model, 100).join("\n"), /n\/a/);
	assert.equal(model.timeline, null);
});

test("the narrow layout stacks its sections and fits the width", () => {
	for (const width of [24, 40, STATISTICS_NARROW_WIDTH - 1]) {
		const lines = renderStatistics(buildStatisticsModel(AGGREGATE, TIMELINE, 0), width);
		assert.equal(lines.every((line) => visibleWidth(line) <= width), true, `every line fits ${width}`);
		assert.equal(lines[0]!.trimEnd(), "Session statistics");
		assert.equal(lines.some((line) => line.includes("╭")), false, "no frame when narrow");
		assert.equal(lines.some((line) => line.includes("Helpers")), true);
		assert.equal(lines.some((line) => line.includes("Export")), true);
	}
});

test("the fullscreen layout is framed, exact width, and never truncates a ratio", () => {
	for (const width of [STATISTICS_NARROW_WIDTH, 80, 120]) {
		const lines = renderStatistics(buildStatisticsModel(AGGREGATE, TIMELINE, 0), width);
		assert.equal(lines[0]!.startsWith("╭"), true);
		assert.equal(lines[lines.length - 1]!.startsWith("╰"), true);
		assert.equal(lines.every((line) => visibleWidth(line) === width), true, `every line is ${width} wide`);
		const text = lines.join("\n");
		assert.match(text, /gentle-ai-worker/);
		assert.match(text, /build the widget/);
		assert.match(text, /m1/);
		assert.equal(text.includes("S1"), false, "the raw task id never reaches the panel");
		assert.equal(text.includes("[measured]"), false, "no noisy bracket on every row");
		assert.match(text, /\+/, "a partial cost is marked with +");
		assert.equal(text.includes(STATISTICS_LEGEND), true, "the marker convention is shown once");
		// Every efficiency label survives at any wide width: the ratios wrap, never truncate.
		for (const label of ["cache reads", "cache writes", "reasoning of output", "output of total", "cost per turn", "tokens per turn"]) {
			assert.equal(text.includes(label), true, `${label} must not be truncated at width ${width}`);
		}
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
