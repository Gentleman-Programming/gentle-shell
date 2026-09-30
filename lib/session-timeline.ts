// Transcript timeline for the session statistics module (epic #1, I5).
//
// Time is the harder half of the module, and it is derivable from the
// transcript rather than from live events. The method is the one measured in
// upstream #1263: pair message timestamps, where `assistant -> toolResult` is
// tool execution and `toolResult -> assistant` is model latency. This module
// adopts that method and carries its two documented artifacts instead of
// hiding them:
//
//   1. When a turn emits parallel tool calls, the first result's gap absorbs
//      the whole batch. Those tool durations are flagged `parallel` so the
//      attribution artifact is visible.
//   2. The harness prepends `cd <cwd> &&` to every bash call. `normalizeToolCommand`
//      strips it, so the same command from different cwds is one group.
//
// Two more honesty rules: latency is reported as median and p90 with the
// sample size, never as a bare mean, and idle is labelled an estimate wherever
// it is surfaced.
//
// The parent-side whitelisted timings already on disk (`gentle-ai-elapsed-timing/v1`,
// written for `gentle_review*` and gentle-ai `bash` cards) override the derived
// duration for the same `toolCallId` and are flagged `whitelisted`; they cover
// only those tools, never the whole session.
//
// Pure and non-blocking: `buildTimeline` is a pure function over a parsed event
// sequence, the only I/O is the lazy `streamTranscriptLines`, and no render path
// may call it.

import { GENTLE_AI_TIMING_ENTRY, parseGentleAiTimingData } from "./gentle-ai-elapsed-store.ts";
import { streamTranscriptLines } from "./session-transcript.ts";

const UNKNOWN = "unknown";
/** Default gap above which a model wait is treated as the user being away, not the model thinking. */
export const DEFAULT_IDLE_THRESHOLD_MS = 300_000;

export type TimelineSegmentKind = "model" | "tool" | "idle";

/** One classified span of the timeline. `idle` is an estimate. */
export interface TimelineSegment {
	readonly kind: TimelineSegmentKind;
	readonly start: number;
	readonly end: number;
	readonly durationMs: number;
	readonly model?: string;
	readonly tool?: string;
	readonly callId?: string;
	/** Normalized command for a bash-like tool, after the `cd <cwd> &&` prefix is stripped. */
	readonly command?: string;
	/** True when the duration comes from a turn with parallel tool calls: an attribution artifact. */
	readonly parallel?: boolean;
	/** True when the duration comes from the parent-side whitelisted timing store. */
	readonly whitelisted?: boolean;
	/** True for an idle estimate, never a measured time. */
	readonly estimated?: boolean;
}

/** Latency for one model: median and p90 with the sample size, never a bare mean. */
export interface LatencyStat {
	readonly model: string;
	readonly count: number;
	readonly medianMs: number;
	readonly p90Ms: number;
}

/** Tool durations grouped by normalized command. */
export interface ToolDurationGroup {
	readonly command: string;
	readonly count: number;
	readonly medianMs: number;
	readonly p90Ms: number;
	/** How many samples were flagged as a parallel-batch artifact. */
	readonly parallelCount: number;
}

export interface Timeline {
	readonly segments: readonly TimelineSegment[];
	readonly modelLatency: readonly LatencyStat[];
	readonly toolDurations: readonly ToolDurationGroup[];
	readonly modelMs: number;
	readonly toolMs: number;
	/** Estimate: wall clock minus the classified model and tool time. */
	readonly idleMs: number;
	readonly wallClockMs: number;
	readonly malformedLines: number;
}

export interface TimelineOptions {
	/** Gap above which a model wait is classified as idle. Defaults to five minutes. */
	readonly idleThresholdMs?: number;
}

/** One tool call requested by an assistant message. */
export interface TimelineToolCall {
	readonly id: string;
	readonly name: string;
	readonly command?: string;
}

export type TimelineEvent =
	| { readonly kind: "user"; readonly timestamp: number }
	| { readonly kind: "assistant"; readonly timestamp: number; readonly model: string; readonly toolCalls: readonly TimelineToolCall[] }
	| { readonly kind: "toolResult"; readonly timestamp: number; readonly toolName: string; readonly toolCallId: string; readonly isError: boolean }
	| { readonly kind: "timing"; readonly toolCallId: string; readonly startedAt: number; readonly endedAt?: number };

export type TimelineLineResult =
	| { readonly kind: "event"; readonly event: TimelineEvent }
	| { readonly kind: "skip" }
	| { readonly kind: "malformed" };

// ---------------------------------------------------------------------------
// Command normalization: strip the harness's `cd <cwd> &&` prefix.
// ---------------------------------------------------------------------------

const CD_PREFIX = /^cd\s+(?:"[^"]*"|'[^']*'|[^&]+?)\s*&&\s*/;

/**
 * Normalize a bash command for grouping: strip a leading `cd <cwd> &&` (the
 * harness prepends it to every call) and collapse whitespace. A command with no
 * prefix is only trimmed and collapsed.
 */
export function normalizeToolCommand(command: string): string {
	return command.replace(CD_PREFIX, "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Line parsing: one transcript line in, one timeline event out.
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length > 0) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function text(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function toolCallsFromContent(content: unknown): TimelineToolCall[] {
	if (!Array.isArray(content)) return [];
	const calls: TimelineToolCall[] = [];
	for (const block of content) {
		if (!isObject(block) || block.type !== "toolCall") continue;
		const id = typeof block.id === "string" ? block.id : "";
		const name = text(block.name, UNKNOWN);
		const args = block.arguments;
		const command = isObject(args) && typeof args.command === "string" ? normalizeToolCommand(args.command) : undefined;
		calls.push({ id, name, ...(command !== undefined ? { command } : {}) });
	}
	return calls;
}

/**
 * Classify one transcript line into a timeline event. A whitelisted timing
 * entry becomes a `timing` event; a user/assistant/toolResult message becomes
 * its event; anything else is skipped; an unusable line is malformed.
 */
export function parseTimelineEvent(raw: string): TimelineLineResult {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { kind: "skip" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { kind: "malformed" };
	}
	if (!isObject(parsed)) return { kind: "malformed" };
	if (parsed.type === "custom" && parsed.customType === GENTLE_AI_TIMING_ENTRY) {
		const timing = parseGentleAiTimingData(parsed.data);
		if (!timing) return { kind: "skip" };
		return {
			kind: "event",
			event: {
				kind: "timing",
				toolCallId: timing.toolCallId,
				startedAt: timing.startedAt,
				...(timing.endedAt !== undefined ? { endedAt: timing.endedAt } : {}),
			},
		};
	}
	if (parsed.type !== "message") return { kind: "skip" };
	const message = parsed.message;
	if (!isObject(message)) return { kind: "skip" };
	const timestamp = timestampMs(parsed.timestamp) ?? timestampMs(message.timestamp);
	if (timestamp === undefined) return { kind: "skip" };
	if (message.role === "user") return { kind: "event", event: { kind: "user", timestamp } };
	if (message.role === "toolResult") {
		return {
			kind: "event",
			event: {
				kind: "toolResult",
				timestamp,
				toolName: text(message.toolName, UNKNOWN),
				toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
				isError: message.isError === true,
			},
		};
	}
	if (message.role === "assistant") {
		return { kind: "event", event: { kind: "assistant", timestamp, model: text(message.model, UNKNOWN), toolCalls: toolCallsFromContent(message.content) } };
	}
	return { kind: "skip" };
}

// ---------------------------------------------------------------------------
// Classification: pure over the event sequence.
// ---------------------------------------------------------------------------

function median(sorted: readonly number[]): number {
	const count = sorted.length;
	if (count === 0) return 0;
	const mid = Math.floor(count / 2);
	return count % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Nearest-rank p90 (or any p in (0,1]) over a sorted sample. */
function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[index]!;
}

function latencyStats(byModel: Map<string, number[]>): LatencyStat[] {
	return [...byModel.entries()]
		.map(([model, samples]) => {
			const sorted = [...samples].sort((a, b) => a - b);
			return { model, count: sorted.length, medianMs: median(sorted), p90Ms: percentile(sorted, 0.9) };
		})
		.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

function toolGroups(segments: readonly TimelineSegment[]): ToolDurationGroup[] {
	const byCommand = new Map<string, { samples: number[]; parallel: number }>();
	for (const segment of segments) {
		if (segment.kind !== "tool") continue;
		const key = segment.command ?? segment.tool ?? UNKNOWN;
		const entry = byCommand.get(key) ?? { samples: [], parallel: 0 };
		entry.samples.push(segment.durationMs);
		if (segment.parallel) entry.parallel += 1;
		byCommand.set(key, entry);
	}
	return [...byCommand.entries()]
		.map(([command, entry]) => {
			const sorted = [...entry.samples].sort((a, b) => a - b);
			return { command, count: sorted.length, medianMs: median(sorted), p90Ms: percentile(sorted, 0.9), parallelCount: entry.parallel };
		})
		.sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
}

/**
 * Classify a parsed event sequence into the timeline. Pure: no clock, no I/O,
 * the input array is not mutated, and the same input yields identical output.
 */
export function buildTimeline(events: readonly TimelineEvent[], options: TimelineOptions = {}, malformedLines = 0): Timeline {
	const idleThreshold = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
	const whitelisted = new Map<string, { startedAt: number; endedAt?: number }>();
	for (const event of events) {
		if (event.kind === "timing") whitelisted.set(event.toolCallId, { startedAt: event.startedAt, ...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}) });
	}
	const sequence = events.filter((event) => event.kind !== "timing");
	const segments: TimelineSegment[] = [];
	const byModel = new Map<string, number[]>();

	const pushIdle = (start: number, end: number) => {
		segments.push({ kind: "idle", start, end, durationMs: Math.max(0, end - start), estimated: true });
	};
	const pushModel = (start: number, end: number, model: string) => {
		const durationMs = Math.max(0, end - start);
		segments.push({ kind: "model", start, end, durationMs, model });
		const samples = byModel.get(model) ?? [];
		samples.push(durationMs);
		byModel.set(model, samples);
	};

	let index = 0;
	while (index < sequence.length) {
		const event = sequence[index]!;
		if (event.kind === "assistant" && event.toolCalls.length > 0) {
			const results: Extract<TimelineEvent, { kind: "toolResult" }>[] = [];
			let next = index + 1;
			while (next < sequence.length && sequence[next]!.kind === "toolResult") {
				results.push(sequence[next] as Extract<TimelineEvent, { kind: "toolResult" }>);
				next += 1;
			}
			if (results.length > 0) {
				results.sort((a, b) => a.timestamp - b.timestamp);
				const parallel = event.toolCalls.length > 1;
				let previous = event.timestamp;
				for (const result of results) {
					const call = event.toolCalls.find((candidate) => candidate.id === result.toolCallId);
					const override = whitelisted.get(result.toolCallId);
					const start = override?.startedAt ?? previous;
					const end = override?.endedAt ?? result.timestamp;
					segments.push({
						kind: "tool",
						start,
						end,
						durationMs: Math.max(0, end - start),
						tool: call?.name ?? result.toolName,
						callId: result.toolCallId,
						...(call?.command !== undefined ? { command: call.command } : {}),
						...(parallel ? { parallel: true } : {}),
						...(override?.endedAt !== undefined ? { whitelisted: true } : {}),
					});
					previous = result.timestamp;
				}
				// Point at the last result so the next iteration pairs it with the
				// following assistant as model latency.
				index = next - 1;
				continue;
			}
		}
		const following = sequence[index + 1];
		if (following) {
			if (following.kind === "assistant" && (event.kind === "user" || event.kind === "toolResult")) {
				const durationMs = Math.max(0, following.timestamp - event.timestamp);
				if (durationMs > idleThreshold) pushIdle(event.timestamp, following.timestamp);
				else pushModel(event.timestamp, following.timestamp, following.model);
			} else {
				pushIdle(event.timestamp, following.timestamp);
			}
		}
		index += 1;
	}

	const first = sequence[0];
	const last = sequence[sequence.length - 1];
	const wallClockMs = first && last ? Math.max(0, last.timestamp - first.timestamp) : 0;
	let modelMs = 0;
	let toolMs = 0;
	let idleMs = 0;
	for (const segment of segments) {
		if (segment.kind === "model") modelMs += segment.durationMs;
		else if (segment.kind === "tool") toolMs += segment.durationMs;
		else idleMs += segment.durationMs;
	}
	return {
		segments,
		modelLatency: latencyStats(byModel),
		toolDurations: toolGroups(segments),
		modelMs,
		toolMs,
		idleMs,
		wallClockMs,
		malformedLines,
	};
}

/** Stream a transcript and classify its timeline. For a large file this is the bounded-memory path. */
export async function readTimeline(file: string, options: TimelineOptions = {}): Promise<Timeline> {
	const events: TimelineEvent[] = [];
	let malformedLines = 0;
	for await (const { raw } of streamTranscriptLines(file)) {
		const result = parseTimelineEvent(raw);
		if (result.kind === "event") events.push(result.event);
		else if (result.kind === "malformed") malformedLines += 1;
	}
	return buildTimeline(events, options, malformedLines);
}
