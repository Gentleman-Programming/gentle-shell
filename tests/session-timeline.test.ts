import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildTimeline,
	DEFAULT_IDLE_THRESHOLD_MS,
	normalizeToolCommand,
	parseTimelineEvent,
	readTimeline,
	type TimelineEvent,
} from "../lib/session-timeline.ts";

// I5: the transcript timeline. Hand-computed segments over a real-shaped
// transcript fixture, percentiles instead of means, the parallel-batch artifact
// flagged, the `cd <cwd> &&` prefix normalized, idle labelled an estimate, and
// the parent-side whitelisted timings overriding the derived duration.

const FIXTURE = fileURLToPath(new URL("./fixtures/session-timeline/session.jsonl", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gentle-timeline-"));
after(() => rmSync(root, { recursive: true, force: true }));

const T = (seconds: number) => Date.parse("2026-09-29T10:00:00.000Z") + seconds * 1000;

test("normalizeToolCommand strips the harness's cd prefix and collapses whitespace", () => {
	assert.equal(normalizeToolCommand("cd /proj && git status"), "git status");
	assert.equal(normalizeToolCommand("cd /a/b/c &&  pnpm   test"), "pnpm test");
	assert.equal(normalizeToolCommand('cd "/path with spaces" && ls -la'), "ls -la");
	assert.equal(normalizeToolCommand("cd '/quoted path' && echo hi"), "echo hi");
	assert.equal(normalizeToolCommand("cd /proj&&git log"), "git log");
	// No prefix: only trimmed and collapsed, never mangled.
	assert.equal(normalizeToolCommand("git status"), "git status");
	assert.equal(normalizeToolCommand("  echo   hi  "), "echo hi");
});

test("parseTimelineEvent classifies user, assistant, toolResult, timing, skip and malformed", () => {
	const line = (value: unknown) => JSON.stringify(value);
	const user = parseTimelineEvent(line({ type: "message", timestamp: "2026-09-29T10:00:00.000Z", message: { role: "user" } }));
	assert.equal(user.kind, "event");
	if (user.kind === "event") assert.equal(user.event.kind, "user");

	const assistant = parseTimelineEvent(
		line({
			type: "message",
			timestamp: "2026-09-29T10:00:02.000Z",
			message: { role: "assistant", model: "m1", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cd /x && ls" } }] },
		}),
	);
	assert.equal(assistant.kind, "event");
	if (assistant.kind === "event" && assistant.event.kind === "assistant") {
		assert.equal(assistant.event.model, "m1");
		assert.deepEqual(assistant.event.toolCalls, [{ id: "c1", name: "bash", command: "ls" }]);
	}

	const result = parseTimelineEvent(
		line({ type: "message", timestamp: "2026-09-29T10:00:04.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true } }),
	);
	assert.equal(result.kind, "event");
	if (result.kind === "event" && result.event.kind === "toolResult") {
		assert.equal(result.event.toolCallId, "c1");
		assert.equal(result.event.isError, true);
	}

	const timing = parseTimelineEvent(line({ type: "custom", customType: "gentle-ai-elapsed-timing/v1", data: { toolCallId: "c1", startedAt: 1, endedAt: 2 } }));
	assert.equal(timing.kind, "event");
	if (timing.kind === "event" && timing.event.kind === "timing") assert.equal(timing.event.endedAt, 2);

	assert.equal(parseTimelineEvent("").kind, "skip");
	assert.equal(parseTimelineEvent(line({ type: "custom", customType: "other" })).kind, "skip");
	assert.equal(parseTimelineEvent(line({ type: "message", message: { role: "system" } })).kind, "skip");
	assert.equal(parseTimelineEvent("{not json").kind, "malformed");
	assert.equal(parseTimelineEvent("[]").kind, "malformed");
});

test("readTimeline classifies the fixture into hand-computed segments and totals", async () => {
	const timeline = await readTimeline(FIXTURE);
	assert.equal(timeline.malformedLines, 0);
	assert.deepEqual(
		timeline.segments.map((segment) => segment.kind),
		["model", "tool", "model", "tool", "tool", "model", "idle"],
	);
	assert.equal(timeline.modelMs, 6999);
	assert.equal(timeline.toolMs, 5001);
	assert.equal(timeline.idleMs, 48000);
	assert.equal(timeline.wallClockMs, 60000);
	assert.equal(timeline.modelMs + timeline.toolMs + timeline.idleMs, timeline.wallClockMs, "the segments tile the wall clock");

	// Model latency: median and p90 with the sample size, never a bare mean.
	assert.deepEqual(timeline.modelLatency, [
		{ model: "m1", count: 2, medianMs: 2000, p90Ms: 2000 },
		{ model: "m2", count: 1, medianMs: 2999, p90Ms: 2999 },
	]);

	// Tool durations grouped by normalized command.
	assert.deepEqual(timeline.toolDurations, [
		{ command: "git status", count: 1, medianMs: 2000, p90Ms: 2000, parallelCount: 0 },
		{ command: "pnpm test", count: 1, medianMs: 3000, p90Ms: 3000, parallelCount: 1 },
		{ command: "read", count: 1, medianMs: 1, p90Ms: 1, parallelCount: 1 },
	]);

	const [firstTool, parallelBash, parallelRead] = timeline.segments.filter((segment) => segment.kind === "tool");
	assert.equal(firstTool!.command, "git status");
	assert.equal(firstTool!.parallel, undefined, "a single-call turn is not flagged");
	assert.equal(firstTool!.callId, "c1");
	assert.equal(parallelBash!.parallel, true, "a parallel batch is flagged");
	assert.equal(parallelBash!.durationMs, 3000, "the first result absorbs the batch");
	assert.equal(parallelRead!.parallel, true);
	assert.equal(parallelRead!.durationMs, 1, "later results keep their own delta");

	const idle = timeline.segments.find((segment) => segment.kind === "idle");
	assert.equal(idle!.estimated, true, "idle is always labelled an estimate");
});

test("percentiles report median and p90 over the sample, never a mean", () => {
	const events: TimelineEvent[] = [];
	let at = 0;
	for (const gap of [100, 150, 300, 400, 500]) {
		events.push({ kind: "user", timestamp: at });
		at += gap;
		events.push({ kind: "assistant", timestamp: at, model: "m", toolCalls: [] });
		at += 1000;
	}
	const timeline = buildTimeline(events);
	assert.deepEqual(timeline.modelLatency, [{ model: "m", count: 5, medianMs: 300, p90Ms: 500 }]);
	assert.equal("meanMs" in (timeline.modelLatency[0] as object), false);
});

test("a model wait above the idle threshold is classified as an estimated idle", () => {
	const long: TimelineEvent[] = [
		{ kind: "user", timestamp: 0 },
		{ kind: "assistant", timestamp: 400_000, model: "m", toolCalls: [] },
	];
	const idle = buildTimeline(long, { idleThresholdMs: 300_000 });
	assert.equal(idle.segments.length, 1);
	assert.equal(idle.segments[0]!.kind, "idle");
	assert.equal(idle.segments[0]!.estimated, true);
	assert.deepEqual(idle.modelLatency, []);

	const model = buildTimeline(long, { idleThresholdMs: 500_000 });
	assert.equal(model.segments[0]!.kind, "model");
	assert.deepEqual(model.modelLatency, [{ model: "m", count: 1, medianMs: 400_000, p90Ms: 400_000 }]);

	assert.equal(DEFAULT_IDLE_THRESHOLD_MS, 300_000);
});

test("a whitelisted parent-side timing overrides the derived tool duration and is flagged", () => {
	const events: TimelineEvent[] = [
		{ kind: "assistant", timestamp: 1000, model: "m", toolCalls: [{ id: "c1", name: "bash", command: "git status" }] },
		{ kind: "toolResult", timestamp: 5000, toolName: "bash", toolCallId: "c1", isError: false },
		{ kind: "timing", toolCallId: "c1", startedAt: 2000, endedAt: 3000 },
	];
	const timeline = buildTimeline(events);
	const tool = timeline.segments.find((segment) => segment.kind === "tool");
	assert.ok(tool);
	assert.equal(tool.durationMs, 1000);
	assert.equal(tool.whitelisted, true);
	assert.equal(tool.command, "git status");

	const derived = buildTimeline(events.slice(0, 2));
	assert.equal(derived.segments.find((segment) => segment.kind === "tool")!.durationMs, 4000);
	assert.equal(derived.segments.find((segment) => segment.kind === "tool")!.whitelisted, undefined);

	// A start-only entry (the tool never recorded an end) is ignored, not a half override.
	const startOnly = buildTimeline([
		{ kind: "assistant", timestamp: 1000, model: "m", toolCalls: [{ id: "c1", name: "bash", command: "git status" }] },
		{ kind: "toolResult", timestamp: 5000, toolName: "bash", toolCallId: "c1", isError: false },
		{ kind: "timing", toolCallId: "c1", startedAt: 2000 },
	]);
	const startOnlyTool = startOnly.segments.find((segment) => segment.kind === "tool");
	assert.equal(startOnlyTool!.durationMs, 4000);
	assert.equal(startOnlyTool!.whitelisted, undefined);
});

test("malformed and partial lines are counted without changing the timeline", async () => {
	const file = join(root, "malformed.jsonl");
	const fixture = readFileSync(FIXTURE, "utf8");
	writeFileSync(file, `${fixture}{not json\n[]\n{"type":"message","message":{"role":"assistant","usage":{`, "utf8");
	const timeline = await readTimeline(file);
	assert.equal(timeline.malformedLines, 3);
	assert.equal(timeline.segments.length, 7);
	assert.equal(timeline.modelMs, 6999);
});

test("the timeline is pure and deterministic and the reader writes nothing", async () => {
	const events: TimelineEvent[] = [
		{ kind: "user", timestamp: T(0) },
		{ kind: "assistant", timestamp: T(2), model: "m", toolCalls: [{ id: "c1", name: "bash", command: "ls" }] },
		{ kind: "toolResult", timestamp: T(4), toolName: "bash", toolCallId: "c1", isError: false },
	];
	const before = JSON.stringify(events);
	assert.deepEqual(buildTimeline(events), buildTimeline(events));
	assert.equal(JSON.stringify(events), before, "the input events are not mutated");

	const listing = readdirSync(root).sort();
	await readTimeline(FIXTURE);
	assert.deepEqual(readdirSync(root).sort(), listing, "reading a transcript writes nothing");
});
