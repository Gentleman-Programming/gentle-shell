// Local, opt-in statistics store (epic #1, I6).
//
// Replay from transcripts covers history, but a durable local store is what
// lets a report survive session pruning and lets a panel open instantly. It is
// NOT the telemetry path: nothing here sends anything, ever, and it does not
// touch `docs/telemetry.md`'s adapter. It follows the #1302 prior art instead:
// a local, silent JSONL recorder, opt-out through `DO_NOT_TRACK` or `CI`,
// nothing ever sent.
//
// The record shape is a content-free projection of one assistant usage line,
// kept byte-compatible with a transcript line so I3's `parseTranscriptLine`
// reads it back unchanged. Prompt text, response text, file paths and raw
// provider errors are never read from the input and never written: the line is
// built from an explicit allowlist, never by spreading the source record.
//
// Retention is bounded by count and by age, prunes oldest-first, and never
// removes the active session's records. Writes are asynchronous, there is no
// fsync on the interactive path, and a write failure is silent: it returns 0
// instead of surfacing as a task failure.

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	parseTranscriptLine,
	streamTranscriptLines,
	type TranscriptReadContext,
	type TranscriptTaskIdentity,
	type TranscriptUsageRecord,
} from "./session-transcript.ts";
import { NANO_USD_SCALE, type UsageCost } from "./session-usage.ts";

/** Dedicated namespace under the agent home, separate from telemetry and `gentle-agents`. */
export const STATISTICS_STORE_DIR = "gentle-statistics";
export const STATISTICS_STORE_FILE = "usage.jsonl";
export const STORE_LINE_VERSION = 1;
export const DEFAULT_STORE_MAX_RECORDS = 50_000;
export const DEFAULT_STORE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface StoreEnv {
	readonly DO_NOT_TRACK?: string;
	readonly CI?: string;
	readonly GITHUB_ACTIONS?: string;
	/** Documented preference: `GENTLE_STATISTICS_STORE=0` disables the store. */
	readonly GENTLE_STATISTICS_STORE?: string;
}

export function statisticsStoreDir(agentHome: string): string {
	return join(agentHome, STATISTICS_STORE_DIR);
}

export function statisticsStoreFile(agentHome: string): string {
	return join(statisticsStoreDir(agentHome), STATISTICS_STORE_FILE);
}

/** Unknown nonempty spellings veto too, matching the telemetry policy: never weaken a veto. */
function truthy(value: string | undefined): boolean {
	return !["", "0", "false", "no", "off"].includes((value ?? "").trim().toLowerCase());
}

/** True when the store may write: not vetoed by `DO_NOT_TRACK`/`CI` and not disabled by preference. */
export function statisticsStoreEnabled(env: StoreEnv): boolean {
	if (truthy(env.DO_NOT_TRACK) || truthy(env.CI) || truthy(env.GITHUB_ACTIONS)) return false;
	const preference = env.GENTLE_STATISTICS_STORE;
	return preference === undefined || truthy(preference);
}

/** The allowlisted task identity: identity and outcome, never prompt, result or path. */
export interface StoredTaskIdentity {
	readonly taskId: string;
	readonly agent: string;
	readonly label: string;
	readonly status: string;
	readonly turns: number;
	readonly toolCalls: number;
	readonly startedAt: number | null;
	readonly endedAt: number | null;
	readonly model: string;
	readonly thinking?: string;
}

/** One stored line: a transcript-shaped, content-free assistant usage projection. */
export interface StoredUsageLine {
	readonly type: "message";
	readonly version: typeof STORE_LINE_VERSION;
	readonly timestamp: string;
	readonly sessionId: string;
	readonly source: TranscriptUsageRecord["source"];
	readonly taskId?: string;
	readonly task?: StoredTaskIdentity;
	readonly message: {
		readonly role: "assistant";
		readonly model: string;
		readonly provider: string;
		readonly thinkingLevel?: string;
		readonly stopReason?: string;
		readonly usage: {
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
			readonly reasoning: number;
			readonly totalTokens: number;
			readonly cost?: Readonly<Record<string, number>>;
		};
	};
}

function costUsd(cost: UsageCost): number | undefined {
	return cost.state === "reported" ? cost.nanoUsd / NANO_USD_SCALE : undefined;
}

function taskIdentity(task: TranscriptTaskIdentity): StoredTaskIdentity {
	return {
		taskId: task.taskId,
		agent: task.agent,
		label: task.label,
		status: task.status,
		turns: task.turns,
		toolCalls: task.toolCalls,
		startedAt: task.startedAt,
		endedAt: task.endedAt,
		model: task.model,
		...(task.thinking !== undefined ? { thinking: task.thinking } : {}),
	};
}

/**
 * Project one usage record into the stored line. Only allowlisted fields are
 * read; any extra field on the input (prompt, response, path, raw error) is
 * structurally incapable of reaching the line.
 */
export function usageLineFromRecord(record: TranscriptUsageRecord): StoredUsageLine {
	const cost: Record<string, number> = {};
	const total = costUsd(record.cost);
	if (total !== undefined) cost.total = total;
	const breakdown = record.costBreakdown;
	if (breakdown) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const value = costUsd(breakdown[key]);
			if (value !== undefined) cost[key] = value;
		}
	}
	return {
		type: "message",
		version: STORE_LINE_VERSION,
		timestamp: new Date(record.timestamp).toISOString(),
		sessionId: record.sessionId,
		source: record.source,
		...(record.task ? { taskId: record.task.taskId, task: taskIdentity(record.task) } : {}),
		message: {
			role: "assistant",
			model: record.model,
			provider: record.provider,
			...(record.effort !== undefined ? { thinkingLevel: record.effort } : {}),
			...(record.stopReason !== undefined ? { stopReason: record.stopReason } : {}),
			usage: {
				input: record.tokens.input,
				output: record.tokens.output,
				cacheRead: record.tokens.cacheRead,
				cacheWrite: record.tokens.cacheWrite,
				reasoning: record.tokens.reasoning,
				totalTokens: record.tokens.total,
				...(Object.keys(cost).length > 0 ? { cost } : {}),
			},
		},
	};
}

/**
 * Append a finalized session's usage records, one JSON line each. Returns the
 * number of records written. Silent: an opted-out store or a write failure
 * returns 0 without creating a file or throwing, so the store never surfaces to
 * the session. No fsync.
 */
export async function appendUsageRecords(file: string, records: readonly TranscriptUsageRecord[], options: { env?: StoreEnv } = {}): Promise<number> {
	if (records.length === 0) return 0;
	if (!statisticsStoreEnabled(options.env ?? {})) return 0;
	const payload = `${records.map((record) => JSON.stringify(usageLineFromRecord(record))).join("\n")}\n`;
	try {
		await mkdir(dirname(file), { recursive: true });
		await appendFile(file, payload, "utf8");
		return records.length;
	} catch {
		return 0;
	}
}

function storeContext(raw: string, file: string): TranscriptReadContext | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const line = parsed as { sessionId?: unknown; source?: unknown; task?: unknown };
	if (typeof line.sessionId !== "string") return undefined;
	const source = line.source === "subagent" ? "subagent" : "parent";
	const task = isTaskIdentity(line.task) ? line.task : undefined;
	return { source, sessionId: line.sessionId, transcriptPath: file, ...(task ? { task } : {}) };
}

function isTaskIdentity(value: unknown): value is TranscriptTaskIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const task = value as { taskId?: unknown; agent?: unknown };
	return typeof task.taskId === "string" && typeof task.agent === "string";
}

export interface StoreReadResult {
	readonly records: readonly TranscriptUsageRecord[];
	readonly lines: number;
	readonly malformedLines: number;
}

/** Read the store back through I3's `parseTranscriptLine`, so the numbers are the reader's own. */
export async function readUsageRecords(file: string): Promise<StoreReadResult> {
	const records: TranscriptUsageRecord[] = [];
	let lines = 0;
	let malformedLines = 0;
	for await (const { raw } of streamTranscriptLines(file)) {
		lines += 1;
		const context = storeContext(raw, file);
		if (!context) {
			malformedLines += 1;
			continue;
		}
		const result = parseTranscriptLine(raw, context);
		if (result.kind === "usage") records.push(result.record);
		else if (result.kind === "malformed") malformedLines += 1;
	}
	return { records, lines, malformedLines };
}

export interface StoreRetention {
	readonly maxRecords?: number;
	readonly maxAgeMs?: number;
	/** Records of this session are never removed, however old or far past the count bound. */
	readonly activeSessionId?: string;
	readonly now?: () => number;
}

/**
 * Prune the store oldest-first by age and by count. Rewrites the file atomically
 * (temp + rename) only when something is removed, and never removes a record
 * whose `sessionId` is the active session. Returns how many records were removed.
 */
export async function pruneStore(file: string, options: StoreRetention = {}): Promise<number> {
	const maxRecords = options.maxRecords ?? DEFAULT_STORE_MAX_RECORDS;
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_STORE_MAX_AGE_MS;
	const now = options.now ?? Date.now;
	let content: string;
	try {
		content = await readFile(file, "utf8");
	} catch {
		return 0;
	}
	const rawLines = content.split("\n").filter((line) => line.trim().length > 0);
	interface Entry {
		readonly raw: string;
		readonly sessionId?: string;
		readonly timestamp?: number;
	}
	const entries: Entry[] = rawLines.map((raw) => {
		try {
			const parsed = JSON.parse(raw) as { sessionId?: unknown; timestamp?: unknown };
			return {
				raw,
				...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
				...(typeof parsed.timestamp === "string" && Number.isFinite(Date.parse(parsed.timestamp)) ? { timestamp: Date.parse(parsed.timestamp) } : {}),
			};
		} catch {
			return { raw };
		}
	});
	const isActive = (entry: Entry) => options.activeSessionId !== undefined && entry.sessionId === options.activeSessionId;
	const active = entries.filter(isActive);
	const removable = entries.filter((entry) => !isActive(entry));
	const cutoff = now() - maxAgeMs;
	const withinAge = removable.filter((entry) => entry.timestamp === undefined || entry.timestamp >= cutoff);
	const budget = Math.max(0, maxRecords - active.length);
	const oldestFirst = [...withinAge].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
	const dropped = new Set(oldestFirst.slice(0, Math.max(0, oldestFirst.length - budget)));
	const kept = entries.filter((entry) => isActive(entry) || (withinAge.includes(entry) && !dropped.has(entry)));
	const removed = entries.length - kept.length;
	if (removed === 0) return 0;
	const temp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
	await writeFile(temp, `${kept.map((entry) => entry.raw).join("\n")}\n`, "utf8");
	await rename(temp, file);
	return removed;
}
