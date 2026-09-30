import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { aggregateUsage, type AggregationRecord } from "../lib/session-aggregate.ts";
import { ABSENT_COST, reportedCost, type UsageTokens } from "../lib/session-usage.ts";
import { exportStatisticsCsv, exportStatisticsJson, exportStatisticsMarkdown, STATISTICS_EXPORT_SCHEMA } from "../lib/session-export.ts";

// I7: the exporters. One source of numbers (I4's aggregate), golden files that
// are stable across runs, provenance on every figure, and `n/a` for an
// unavailable ratio instead of a blank that reads as zero.

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

function golden(name: string): string {
	return readFileSync(fileURLToPath(new URL(`./fixtures/session-export/${name}`, import.meta.url)), "utf8");
}

test("the markdown report matches its golden file", () => {
	assert.equal(exportStatisticsMarkdown(AGGREGATE), golden("report.md"));
});

test("the csv report matches its golden file", () => {
	assert.equal(exportStatisticsCsv(AGGREGATE), golden("report.csv"));
});

test("the json report matches its golden file", () => {
	assert.equal(exportStatisticsJson(AGGREGATE), golden("report.json"));
});

test("every figure states its provenance and an unavailable ratio is n/a", () => {
	const markdown = exportStatisticsMarkdown(AGGREGATE);
	assert.match(markdown, /partial/);
	assert.match(markdown, /measured/);
	assert.match(markdown, /derived/);
	assert.match(markdown, /1 unreported/);

	const csv = exportStatisticsCsv(AGGREGATE);
	assert.match(csv, /cost_provenance/);
	assert.match(csv, /partial/);
	const sessionRow = csv.split("\n")[1]!;
	assert.equal(sessionRow.split(",")[0], "session");

	// An empty session has zero denominators: ratios are explicit `n/a`, not blanks.
	assert.match(exportStatisticsCsv(EMPTY), /n\/a/);
	assert.match(exportStatisticsMarkdown(EMPTY), /n\/a/);
	const json = JSON.parse(exportStatisticsJson(EMPTY)) as { session: { ratios: { cacheReadShare: unknown; provenance: string } } };
	assert.equal(json.session.ratios.cacheReadShare, null);
	assert.equal(json.session.ratios.provenance, "derived");
});

test("the json export is the versioned envelope", () => {
	const parsed = JSON.parse(exportStatisticsJson(AGGREGATE)) as { schema: string; session: { turns: number } };
	assert.equal(parsed.schema, STATISTICS_EXPORT_SCHEMA);
	assert.equal(parsed.session.turns, 3);
});

test("the export is deterministic and an injected clock is the only variable", () => {
	assert.equal(exportStatisticsMarkdown(AGGREGATE), exportStatisticsMarkdown(AGGREGATE));
	assert.equal(exportStatisticsCsv(AGGREGATE), exportStatisticsCsv(AGGREGATE));
	assert.equal(exportStatisticsJson(AGGREGATE), exportStatisticsJson(AGGREGATE));
	assert.equal(exportStatisticsJson(AGGREGATE), exportStatisticsJson(AGGREGATE, {}));
	assert.notEqual(exportStatisticsJson(AGGREGATE), exportStatisticsJson(AGGREGATE, { generatedAt: 1 }));
});

test("no prompt, response or path reaches any exported artifact", () => {
	const withPrivate = { ...AGGREGATE, prompt: "SECRET_PROMPT", response: "SECRET_RESPONSE", path: "/secret/path.ts" } as unknown as typeof AGGREGATE;
	for (const artifact of [exportStatisticsMarkdown(withPrivate), exportStatisticsCsv(withPrivate), exportStatisticsJson(withPrivate)]) {
		for (const secret of ["SECRET_PROMPT", "SECRET_RESPONSE", "/secret/path.ts"]) {
			assert.equal(artifact.includes(secret), false, `no artifact may carry ${secret}`);
		}
	}
});
