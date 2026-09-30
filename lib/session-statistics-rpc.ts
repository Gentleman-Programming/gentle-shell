// Versioned statistics RPC transport (epic #1, I7).
//
// A non-TUI host needs the aggregates, and Pi's only fire-and-forget,
// structured-enough RPC push is `setWidget(key, string[])` (component factories
// are ignored in RPC mode). This module follows `lib/agents-rpc-publisher.ts`
// exactly: a schema tag on every line, a field whitelist, per-field bounds, a
// whole-payload bound, one coalesced frame per window, fail-closed and never
// throwing. It publishes on its own widget key so it cannot collide with
// `gentle-agents.activity/v1`.
//
// Oversize is a discard, not a silent truncation: when the payload cannot be
// shrunk under the bound, `encodeStatisticsLines` returns no lines and the
// publisher sends nothing. Every figure keeps its provenance from the aggregate
// (I4): a partial cost stays `partial`, and an unavailable ratio stays `null`
// rather than a blank.

import type { CountFigure, UsageAggregate, UsageBucket } from "./session-aggregate.ts";
import type { LatencyStat, Timeline, ToolDurationGroup } from "./session-timeline.ts";

/** Schema tag carried on every published line so a client can version the payload shape. */
export const STATISTICS_SCHEMA = "gentle-shell.statistics/v1";
/** Its own widget key: never `gentle-agents`, so the two publications cannot collide on the wire. */
export const STATISTICS_WIDGET_KEY = "gentle-statistics";
export const DEFAULT_STATISTICS_MAX_BYTES = 64 * 1024;
/** Breakdown entries kept per dimension before shrinking. */
export const DEFAULT_STATISTICS_ENTRIES = 20;
export const DEFAULT_STATISTICS_COALESCE_MS = 150;
/** Every whitelisted free-text key (model, agent, project, task id, status, label) is bounded. */
export const STATISTICS_STRING_LIMIT = 120;

export interface StatisticsTimelineSummary {
	readonly segments: number;
	readonly modelMs: number;
	readonly toolMs: number;
	readonly idleMs: number;
	readonly wallClockMs: number;
	readonly modelLatency: readonly LatencyStat[];
	readonly toolDurations: readonly ToolDurationGroup[];
}

export interface StatisticsBreakdownEntry {
	readonly key: string;
	readonly label?: string;
	readonly bucket: UsageBucket;
}

export interface StatisticsPayload {
	readonly schema: typeof STATISTICS_SCHEMA;
	readonly asOf: number;
	readonly totals: UsageBucket;
	readonly counts: {
		readonly sessions: CountFigure;
		readonly subagents: CountFigure;
		readonly toolCalls: CountFigure;
	};
	readonly perModel: readonly StatisticsBreakdownEntry[];
	readonly perAgentClass: readonly StatisticsBreakdownEntry[];
	readonly perSubagent: readonly StatisticsBreakdownEntry[];
	readonly perProject: readonly StatisticsBreakdownEntry[];
	readonly timeline: StatisticsTimelineSummary | null;
}

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/** No filesystem path may reach the wire: an absolute path run in a tool command is redacted. */
function redactPaths(value: string): string {
	return value.replace(/\/[^\s]*/g, "…");
}

/** The whitelisted bucket: turns, cost, tokens and ratios, never a field the aggregate also carries. */
function bucketOf(bucket: UsageBucket): UsageBucket {
	return { turns: bucket.turns, cost: bucket.cost, tokens: bucket.tokens, ratios: bucket.ratios };
}

function timelineSummary(timeline: Timeline, entries: number): StatisticsTimelineSummary {
	return {
		segments: timeline.segments.length,
		modelMs: timeline.modelMs,
		toolMs: timeline.toolMs,
		idleMs: timeline.idleMs,
		wallClockMs: timeline.wallClockMs,
		modelLatency: timeline.modelLatency.slice(0, entries),
		toolDurations: timeline.toolDurations.slice(0, entries).map((entry) => ({ ...entry, command: truncate(redactPaths(entry.command), STATISTICS_STRING_LIMIT) })),
	};
}

/** Project the aggregate (and an optional timeline) into the whitelisted, per-field-bounded payload. */
export function projectStatisticsPayload(aggregate: UsageAggregate, timeline: Timeline | null = null, entries: number = DEFAULT_STATISTICS_ENTRIES): StatisticsPayload {
	const cap = Math.max(0, entries);
	return {
		schema: STATISTICS_SCHEMA,
		asOf: aggregate.asOf,
		totals: bucketOf(aggregate),
		counts: { sessions: aggregate.sessions, subagents: aggregate.subagents, toolCalls: aggregate.toolCalls },
		perModel: aggregate.perModel.slice(0, cap).map((entry) => ({ key: truncate(`${entry.provider}/${entry.model}`, STATISTICS_STRING_LIMIT), bucket: bucketOf(entry) })),
		perAgentClass: aggregate.perAgentClass.slice(0, cap).map((entry) => ({ key: truncate(entry.agentClass, STATISTICS_STRING_LIMIT), bucket: bucketOf(entry) })),
		perSubagent: aggregate.perSubagent
			.slice(0, cap)
			.map((entry) => ({ key: truncate(entry.taskId, STATISTICS_STRING_LIMIT), label: truncate(entry.label, STATISTICS_STRING_LIMIT), bucket: bucketOf(entry) })),
		perProject: aggregate.perProject.slice(0, cap).map((entry) => ({ key: truncate(entry.project, STATISTICS_STRING_LIMIT), bucket: bucketOf(entry) })),
		timeline: timeline ? timelineSummary(timeline, cap) : null,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minimal shape guard: anything else is malformed and the encoder fails closed instead of throwing. */
function isAggregateLike(value: unknown): value is UsageAggregate {
	if (!isRecord(value)) return false;
	if (typeof value.asOf !== "number") return false;
	if (!isRecord(value.cost) || !isRecord(value.tokens) || !isRecord(value.ratios)) return false;
	if (!isRecord(value.sessions) || !isRecord(value.subagents) || !isRecord(value.toolCalls)) return false;
	return Array.isArray(value.perModel) && Array.isArray(value.perAgentClass) && Array.isArray(value.perSubagent) && Array.isArray(value.perProject);
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function halve<T>(list: readonly T[]): T[] {
	return list.length <= 1 ? [] : list.slice(0, Math.ceil(list.length / 2));
}

function entryCount(payload: StatisticsPayload): number {
	return payload.perModel.length + payload.perAgentClass.length + payload.perSubagent.length + payload.perProject.length;
}

function shrinkEntries(payload: StatisticsPayload): StatisticsPayload {
	return { ...payload, perModel: halve(payload.perModel), perAgentClass: halve(payload.perAgentClass), perSubagent: halve(payload.perSubagent), perProject: halve(payload.perProject) };
}

export interface EncodeStatisticsOptions {
	readonly maxBytes?: number;
	readonly entries?: number;
	readonly timeline?: Timeline | null;
}

/**
 * Serialize the aggregate as one JSON line. Shrinks breakdown entries first,
 * then drops the timeline; when even that does not fit, returns no lines so the
 * caller discards rather than silently truncating. Never throws: malformed
 * input fails closed to an empty result.
 */
export function encodeStatisticsLines(input: unknown, options: EncodeStatisticsOptions = {}): string[] {
	const maxBytes = options.maxBytes ?? DEFAULT_STATISTICS_MAX_BYTES;
	const entries = options.entries ?? DEFAULT_STATISTICS_ENTRIES;
	try {
		if (!isAggregateLike(input)) return [];
		let working = projectStatisticsPayload(input, options.timeline ?? null, entries);
		let line = JSON.stringify(working);
		if (byteLength(line) <= maxBytes) return [line];
		while (byteLength(line) > maxBytes && entryCount(working) > 0) {
			working = shrinkEntries(working);
			line = JSON.stringify(working);
		}
		if (byteLength(line) > maxBytes && working.timeline !== null) {
			working = { ...working, timeline: null };
			line = JSON.stringify(working);
		}
		return byteLength(line) <= maxBytes ? [line] : [];
	} catch {
		return [];
	}
}

export interface StatisticsPublisherUi {
	setWidget(key: string, lines: string[]): void;
}

export interface StatisticsSnapshot {
	readonly aggregate: unknown;
	readonly timeline?: Timeline | null;
}

export interface StatisticsPublisherDeps {
	readonly ui: StatisticsPublisherUi;
	/** Pull the current aggregate; called only when a frame is due. May be async. */
	readonly snapshot: () => StatisticsSnapshot | undefined | Promise<StatisticsSnapshot | undefined>;
	/** Same convention as the agents publisher: returns a cancel function. */
	readonly schedule?: (fn: () => void, ms: number) => () => void;
	readonly coalesceMs?: number;
	readonly maxBytes?: number;
	readonly entries?: number;
	readonly onError?: (error: unknown) => void;
}

export interface StatisticsPublisher {
	/** Mark dirty; a burst coalesces into one frame per window. */
	request(): void;
	/** Publish now, cancelling a pending window. */
	flush(): Promise<void>;
	/** Cancel and publish a final frame. */
	stop(): Promise<void>;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
	const timer = setTimeout(fn, ms);
	(timer as unknown as { unref?: () => void }).unref?.();
	return () => clearTimeout(timer);
}

/**
 * Coalescing publisher with a single attempt slot. A frame in flight makes the
 * slot busy and a request in that state is discarded, never queued; failures are
 * reported to `onError` and never escape.
 */
export function createStatisticsPublisher(deps: StatisticsPublisherDeps): StatisticsPublisher {
	const { ui, snapshot, schedule = defaultSchedule, coalesceMs = DEFAULT_STATISTICS_COALESCE_MS, maxBytes = DEFAULT_STATISTICS_MAX_BYTES, entries = DEFAULT_STATISTICS_ENTRIES, onError = () => {} } = deps;
	let cancelTimer: (() => void) | undefined;
	let busy = false;
	let stopped = false;

	const publish = async (): Promise<void> => {
		if (busy) return;
		busy = true;
		try {
			const current = await snapshot();
			if (!current) return;
			const lines = encodeStatisticsLines(current.aggregate, { maxBytes, entries, timeline: current.timeline ?? null });
			if (lines.length > 0) ui.setWidget(STATISTICS_WIDGET_KEY, lines);
		} catch (error) {
			onError(error);
		} finally {
			busy = false;
		}
	};

	const scheduleFlush = () => {
		if (cancelTimer || stopped) return;
		cancelTimer = schedule(() => {
			cancelTimer = undefined;
			void publish();
		}, coalesceMs);
	};

	return {
		request: scheduleFlush,
		flush: async () => {
			cancelTimer?.();
			cancelTimer = undefined;
			await publish();
		},
		stop: async () => {
			if (stopped) return;
			stopped = true;
			cancelTimer?.();
			cancelTimer = undefined;
			await publish();
		},
	};
}
