import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage, type AggregationRecord } from "../lib/session-aggregate.ts";
import { reportedCost, ABSENT_COST, type UsageTokens } from "../lib/session-usage.ts";
import {
	createStatisticsPublisher,
	encodeStatisticsLines,
	projectStatisticsPayload,
	STATISTICS_SCHEMA,
	STATISTICS_WIDGET_KEY,
} from "../lib/session-statistics-rpc.ts";

// I7: the versioned statistics transport. One schema-tagged, whitelisted,
// bounded line per window; oversize discards instead of silently truncating;
// the encoder never throws; a busy attempt slot discards rather than queues.

function tokens(partial: Partial<UsageTokens>): UsageTokens {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, ...partial };
}

const FIXTURE: readonly AggregationRecord[] = [
	{ source: "parent", sessionId: "s1", project: "projA", timestamp: 1000, model: "m1", provider: "p1", tokens: tokens({ input: 100, output: 40, cacheRead: 30, cacheWrite: 5, reasoning: 8, total: 175 }), cost: reportedCost(0.001) },
	{ source: "parent", sessionId: "s1", project: "projA", timestamp: 2000, model: "m1", provider: "p1", tokens: tokens({}), cost: ABSENT_COST },
	{ source: "subagent", sessionId: "s1", project: "projA", timestamp: 3000, model: "m2", provider: "p1", tokens: tokens({ input: 200, output: 60, cacheRead: 10, cacheWrite: 5, reasoning: 20, total: 275 }), cost: reportedCost(0.002), task: { taskId: "S1", agent: "gentle-ai-worker", label: "build", status: "completed", toolCalls: 7 } },
];

const AGGREGATE = aggregateUsage(FIXTURE, { now: () => 0 });

test("the payload carries the schema tag, its own widget key and the aggregate figures", () => {
	assert.equal(STATISTICS_SCHEMA, "gentle-shell.statistics/v1");
	assert.notEqual(STATISTICS_WIDGET_KEY, "gentle-agents");
	const payload = projectStatisticsPayload(AGGREGATE);
	assert.equal(payload.schema, STATISTICS_SCHEMA);
	assert.equal(payload.totals.turns, 3);
	assert.equal(payload.totals.cost.provenance, "partial");
	assert.equal(payload.totals.cost.absent, 1);
	assert.equal(payload.counts.toolCalls.provenance, "partial");
	assert.deepEqual(payload.perModel.map((entry) => entry.key), ["p1/m1", "p1/m2"]);
	assert.deepEqual(payload.perProject.map((entry) => entry.key), ["projA"]);
	assert.deepEqual(Object.keys(payload.perSubagent[0]!.bucket).sort(), ["cost", "ratios", "tokens", "turns"]);
});

test("encodeStatisticsLines emits one schema-tagged JSON line for a valid aggregate", () => {
	const lines = encodeStatisticsLines(AGGREGATE);
	assert.equal(lines.length, 1);
	const parsed = JSON.parse(lines[0]!) as { schema: string };
	assert.equal(parsed.schema, STATISTICS_SCHEMA);
});

test("oversized payloads shrink, then discard rather than truncate silently", () => {
	// A tight bound shrinks the breakdowns but still fits.
	const shrunk = encodeStatisticsLines(AGGREGATE, { maxBytes: 900, entries: 20 });
	assert.equal(shrunk.length, 1);
	assert.ok(Buffer.byteLength(shrunk[0]!, "utf8") <= 900);
	const parsed = JSON.parse(shrunk[0]!) as { perModel: unknown[] };
	assert.ok(parsed.perModel.length <= 2);

	// An impossible bound discards: no lines, never a truncated payload, and it terminates.
	assert.deepEqual(encodeStatisticsLines(AGGREGATE, { maxBytes: 10 }), []);
});

test("the encoder never throws on malformed input", () => {
	for (const bad of [null, undefined, 42, "nope", [], {}, { asOf: 1 }, { asOf: 1, cost: {}, tokens: {}, ratios: {}, sessions: {}, subagents: {}, toolCalls: {} }]) {
		assert.deepEqual(encodeStatisticsLines(bad), [], `malformed input ${JSON.stringify(bad)} discards`);
	}
});

test("no prompt, response or path reaches the encoded line", () => {
	const withPrivate = {
		...AGGREGATE,
		prompt: "SECRET_PROMPT",
		response: "SECRET_RESPONSE",
		path: "/secret/path.ts",
	} as unknown as typeof AGGREGATE;
	const line = encodeStatisticsLines(withPrivate)[0]!;
	for (const secret of ["SECRET_PROMPT", "SECRET_RESPONSE", "/secret/path.ts"]) {
		assert.equal(line.includes(secret), false, `the line must not carry ${secret}`);
	}
});

function fakeSchedule(): { schedule: (fn: () => void, ms: number) => () => void; run: () => void; pending: () => number } {
	let pending: (() => void)[] = [];
	return {
		schedule: (fn) => {
			pending.push(fn);
			return () => {
				pending = pending.filter((entry) => entry !== fn);
			};
		},
		run: () => {
			const due = pending;
			pending = [];
			for (const fn of due) fn();
		},
		pending: () => pending.length,
	};
}

test("the publisher coalesces one frame per window and a final frame on stop", async () => {
	const frames: string[][] = [];
	const clock = fakeSchedule();
	const publisher = createStatisticsPublisher({ ui: { setWidget: (_key, lines) => frames.push(lines) }, snapshot: () => ({ aggregate: AGGREGATE }), schedule: clock.schedule });
	publisher.request();
	publisher.request();
	publisher.request();
	assert.equal(clock.pending(), 1, "a burst schedules one window");
	clock.run();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(frames.length, 1);
	await publisher.stop();
	assert.equal(frames.length, 2, "stop publishes a final frame");
});

test("a busy attempt slot discards rather than queues", async () => {
	let resolveSnapshot: ((value: { aggregate: unknown }) => void) | undefined;
	let snapshots = 0;
	const frames: string[][] = [];
	const publisher = createStatisticsPublisher({
		ui: { setWidget: (_key, lines) => frames.push(lines) },
		snapshot: () => {
			snapshots += 1;
			return new Promise<{ aggregate: unknown }>((resolve) => {
				resolveSnapshot = resolve;
			});
		},
	});
	const first = publisher.flush();
	const second = publisher.flush();
	resolveSnapshot?.({ aggregate: AGGREGATE });
	await Promise.all([first, second]);
	assert.equal(snapshots, 1, "the second flush while busy is discarded");
	assert.equal(frames.length, 1);
});

test("a setWidget failure is reported, never thrown", async () => {
	const errors: unknown[] = [];
	const publisher = createStatisticsPublisher({
		ui: {
			setWidget: () => {
				throw new Error("transport down");
			},
		},
		snapshot: () => ({ aggregate: AGGREGATE }),
		onError: (error) => errors.push(error),
	});
	await publisher.flush();
	assert.equal(errors.length, 1);
	assert.match(String(errors[0]), /transport down/);
});

test("a missing snapshot publishes nothing", async () => {
	const frames: string[][] = [];
	const publisher = createStatisticsPublisher({ ui: { setWidget: (_key, lines) => frames.push(lines) }, snapshot: () => undefined });
	await publisher.flush();
	assert.equal(frames.length, 0);
});
