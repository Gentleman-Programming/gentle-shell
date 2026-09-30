// Transcript reader for the session statistics module (epic #1, I3).
//
// The transcripts are the module's backbone: a session that already ran still
// has its per-message usage on disk, and parent and child transcripts share one
// record shape, so one reader serves both. Verified against live data:
//
//   parent:  <agentDir>/sessions/<project-slug>/<timestamp>_<sessionId>.jsonl
//   child:   <agentDir>/gentle-agents/sessions/<timestamp>_<sessionId>.jsonl
//   task:    <agentDir>/gentle-agents/tasks/<taskId>.json
//
// Each transcript line is JSON; an assistant message carries `message.model`,
// `message.provider`, `message.usage` and a top-level ISO `timestamp`. The task
// files carry the identity and outcome of a finished child, joined onto that
// child's records by the transcript path (or the session id).
//
// This module imports nothing from `lib/agents-*` or any extension, so a future
// package can carry it whole. It never writes to the filesystem.
//
// Non-blocking by construction: the only read path is an async generator over a
// streamed file, so the first I/O happens on the first iteration, nothing loads
// a whole transcript, and no render, tool-call or message hook may call it.

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { piDefaultSessionDir } from "./gentle-shell-resume-hint.ts";
import {
	reportedCostOrAbsent,
	type SessionUsageRecord,
	type UsageCostBreakdown,
	type UsageTokens,
} from "./session-usage.ts";

/** Model/provider label when the transcript omits one. Explicit, never a guess. */
const UNKNOWN = "unknown";

export type TranscriptSource = "parent" | "subagent";

/** Task identity joined from a `TaskRecord`; present only for a delegated child. */
export interface TranscriptTaskIdentity {
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

/** A task record addressable by its transcript path and by its session id. */
export interface TranscriptTaskIndex {
	readonly bySessionPath: ReadonlyMap<string, TranscriptTaskIdentity>;
	readonly bySessionId: ReadonlyMap<string, TranscriptTaskIdentity>;
}

/** One usage record recovered from a transcript line. */
export interface TranscriptUsageRecord extends SessionUsageRecord {
	readonly sessionId: string;
	readonly transcriptPath: string;
	/** Present when a `TaskRecord` joined; absent marks an unidentified child. */
	readonly task?: TranscriptTaskIdentity;
	/** False for a child whose `TaskRecord` was not found; always true for the parent. */
	readonly identified: boolean;
	readonly stopReason?: string;
}

export interface TranscriptReadContext {
	readonly source: TranscriptSource;
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly task?: TranscriptTaskIdentity;
}

export interface TranscriptReadOptions {
	readonly source: TranscriptSource;
	/** Defaults to the session id encoded in the file name. */
	readonly sessionId?: string;
	/** Joined onto every record of a child transcript. */
	readonly task?: TranscriptTaskIdentity;
}

export type TranscriptLineResult =
	| { readonly kind: "usage"; readonly record: TranscriptUsageRecord }
	| { readonly kind: "skip" }
	| { readonly kind: "malformed" };

export type TranscriptItem =
	| { readonly kind: "usage"; readonly record: TranscriptUsageRecord }
	| { readonly kind: "malformed"; readonly line: number }
	| { readonly kind: "skip"; readonly line: number };

export interface TranscriptReadResult {
	readonly records: readonly TranscriptUsageRecord[];
	/** Total lines read, including skipped and malformed ones. */
	readonly lines: number;
	readonly malformedLines: number;
}

export interface TranscriptFileRef {
	readonly file: string;
	readonly source: TranscriptSource;
	readonly sessionId: string;
	readonly startedAt: number;
}

export interface TranscriptEnumerationOptions {
	readonly agentHome: string;
	/** Parent project to enumerate. Its sessions live under the project's slug dir. */
	readonly projectCwd?: string;
	/** Defaults to true when `projectCwd` is given, false otherwise. */
	readonly includeParents?: boolean;
	/** Child sessions are a single directory, not project-scoped. Defaults to true. */
	readonly includeChildren?: boolean;
	/** Inclusive lower bound on a session's start, epoch milliseconds. */
	readonly from?: number;
	/** Exclusive upper bound on a session's start, epoch milliseconds. */
	readonly to?: number;
}

export type SessionUsageReadOptions = TranscriptEnumerationOptions;

// ---------------------------------------------------------------------------
// Pure line parsing: one transcript line in, one classified result out.
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A token counter is a non-negative count; anything else is genuinely zero. */
function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length > 0) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function breakdownOf(cost: unknown): UsageCostBreakdown {
	const source = isObject(cost) ? cost : {};
	return {
		input: reportedCostOrAbsent(source.input),
		output: reportedCostOrAbsent(source.output),
		cacheRead: reportedCostOrAbsent(source.cacheRead),
		cacheWrite: reportedCostOrAbsent(source.cacheWrite),
	};
}

/**
 * Classify one transcript line. Only an assistant message that carries a usage
 * object becomes a record; a usage line whose timestamp cannot be read is
 * malformed rather than silently placed at the epoch.
 */
export function parseTranscriptLine(line: string, context: TranscriptReadContext): TranscriptLineResult {
	const trimmed = line.trim();
	if (trimmed.length === 0) return { kind: "skip" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { kind: "malformed" };
	}
	if (!isObject(parsed)) return { kind: "malformed" };
	if (parsed.type !== "message") return { kind: "skip" };
	const message = parsed.message;
	if (!isObject(message) || message.role !== "assistant") return { kind: "skip" };
	const usage = message.usage;
	if (!isObject(usage)) return { kind: "skip" };
	const timestamp = timestampMs(parsed.timestamp) ?? timestampMs(message.timestamp);
	if (timestamp === undefined) return { kind: "malformed" };
	const costSource = usage.cost;
	const total = isObject(costSource) ? costSource.total : undefined;
	const tokens: UsageTokens = {
		input: count(usage.input),
		output: count(usage.output),
		cacheRead: count(usage.cacheRead),
		cacheWrite: count(usage.cacheWrite),
		reasoning: count(usage.reasoning),
		total: count(usage.totalTokens ?? usage.total),
	};
	const effort = typeof message.thinkingLevel === "string" ? message.thinkingLevel : undefined;
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
	return {
		kind: "usage",
		record: {
			source: context.source,
			...(context.task ? { taskId: context.task.taskId } : {}),
			timestamp,
			model: text(message.model, UNKNOWN),
			provider: text(message.provider, UNKNOWN),
			...(effort ? { effort } : {}),
			tokens,
			cost: reportedCostOrAbsent(total),
			costBreakdown: breakdownOf(costSource),
			sessionId: context.sessionId,
			transcriptPath: context.transcriptPath,
			...(context.task ? { task: context.task } : {}),
			identified: context.source === "parent" || context.task !== undefined,
			...(stopReason !== undefined ? { stopReason } : {}),
		},
	};
}

// ---------------------------------------------------------------------------
// File names: the transcript name encodes the start time and the session id.
// ---------------------------------------------------------------------------

const SESSION_FILE = /^.+_([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/;
const FILE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/;

export function sessionIdFromFile(file: string): string | undefined {
	return SESSION_FILE.exec(basename(file))?.[1];
}

export function fileStartedAt(file: string): number | undefined {
	const match = FILE_TIMESTAMP.exec(basename(file));
	if (!match) return undefined;
	const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
	return Number.isFinite(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Streaming read: the primary path.
// ---------------------------------------------------------------------------

/**
 * Yield one classified item per transcript line, in file order. The generator
 * opens the file lazily on the first iteration and never holds more than one
 * line, so a multi-megabyte transcript streams rather than loads.
 */
export async function* streamTranscript(file: string, options: TranscriptReadOptions): AsyncGenerator<TranscriptItem> {
	const sessionId = options.sessionId ?? sessionIdFromFile(file) ?? UNKNOWN;
	const context: TranscriptReadContext = {
		source: options.source,
		sessionId,
		transcriptPath: file,
		...(options.task ? { task: options.task } : {}),
	};
	const input = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let line = 0;
	try {
		for await (const value of lines) {
			line += 1;
			const result = parseTranscriptLine(value, context);
			if (result.kind === "usage") yield result;
			else if (result.kind === "malformed") yield { kind: "malformed", line };
			else yield { kind: "skip", line };
		}
	} finally {
		lines.close();
		input.destroy();
	}
}

/** Collect a single transcript. For a large file prefer `streamTranscript`. */
export async function readTranscript(file: string, options: TranscriptReadOptions): Promise<TranscriptReadResult> {
	const records: TranscriptUsageRecord[] = [];
	let lines = 0;
	let malformedLines = 0;
	for await (const item of streamTranscript(file, options)) {
		lines += 1;
		if (item.kind === "usage") records.push(item.record);
		else if (item.kind === "malformed") malformedLines += 1;
	}
	return { records, lines, malformedLines };
}

// ---------------------------------------------------------------------------
// Enumeration: sessions by project and by date range.
// ---------------------------------------------------------------------------

async function listFiles(dir: string, suffix: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

async function fileRef(file: string, source: TranscriptSource): Promise<TranscriptFileRef | undefined> {
	const sessionId = sessionIdFromFile(file);
	if (sessionId === undefined) return undefined;
	let startedAt = fileStartedAt(file);
	if (startedAt === undefined) {
		try {
			startedAt = (await stat(file)).mtimeMs;
		} catch {
			return undefined;
		}
	}
	return { file, source, sessionId, startedAt };
}

/**
 * List transcript files for a project and a date range, sorted by session start
 * then path so the order is deterministic. The range bounds the session's
 * start time; a report that needs record-level filtering still sees every record.
 */
export async function listTranscriptFiles(options: TranscriptEnumerationOptions): Promise<readonly TranscriptFileRef[]> {
	const includeParents = options.includeParents ?? options.projectCwd !== undefined;
	const includeChildren = options.includeChildren ?? true;
	const refs: TranscriptFileRef[] = [];
	const collect = async (dir: string, source: TranscriptSource): Promise<void> => {
		for (const file of await listFiles(dir, ".jsonl")) {
			const ref = await fileRef(file, source);
			if (ref) refs.push(ref);
		}
	};
	if (includeParents && options.projectCwd !== undefined) await collect(piDefaultSessionDir(options.projectCwd, options.agentHome), "parent");
	if (includeChildren) await collect(join(options.agentHome, "gentle-agents", "sessions"), "subagent");
	const from = options.from ?? Number.NEGATIVE_INFINITY;
	const to = options.to ?? Number.POSITIVE_INFINITY;
	return refs
		.filter((ref) => ref.startedAt >= from && ref.startedAt < to)
		.sort((a, b) => a.startedAt - b.startedAt || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Task identity: `{task, thread}` files, joined by transcript path.
// ---------------------------------------------------------------------------

function taskIdentity(content: string): { identity: TranscriptTaskIdentity; sessionPath?: string } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!isObject(parsed)) return undefined;
	const task = parsed.task;
	if (!isObject(task)) return undefined;
	const taskId = task.id;
	if (typeof taskId !== "string" || taskId.length === 0) return undefined;
	const identity: TranscriptTaskIdentity = {
		taskId,
		agent: text(task.agent, UNKNOWN),
		label: text(task.label, ""),
		status: text(task.status, UNKNOWN),
		turns: count(task.turns),
		toolCalls: count(task.toolCalls),
		startedAt: timestampMs(task.startedAt) ?? null,
		endedAt: timestampMs(task.endedAt) ?? null,
		model: text(task.model, UNKNOWN),
		...(typeof task.thinking === "string" && task.thinking.length > 0 ? { thinking: task.thinking } : {}),
	};
	const sessionPath = typeof task.sessionPath === "string" && task.sessionPath.length > 0 ? task.sessionPath : undefined;
	return { identity, ...(sessionPath ? { sessionPath } : {}) };
}

/** Load every finished task's identity, addressable by transcript path and session id. */
export async function loadTaskIdentityIndex(tasksDir: string): Promise<TranscriptTaskIndex> {
	const bySessionPath = new Map<string, TranscriptTaskIdentity>();
	const bySessionId = new Map<string, TranscriptTaskIdentity>();
	for (const file of await listFiles(tasksDir, ".json")) {
		let content: string;
		try {
			content = await readFile(file, "utf8");
		} catch {
			continue;
		}
		const parsed = taskIdentity(content);
		if (!parsed?.sessionPath) continue;
		const resolved = resolve(parsed.sessionPath);
		bySessionPath.set(resolved, parsed.identity);
		const id = sessionIdFromFile(resolved);
		if (id) bySessionId.set(id, parsed.identity);
	}
	return { bySessionPath, bySessionId };
}

/** `loadTaskIdentityIndex` against the standard `<agentHome>/gentle-agents/tasks` dir. */
export function readTaskIdentityIndex(agentHome: string): Promise<TranscriptTaskIndex> {
	return loadTaskIdentityIndex(join(agentHome, "gentle-agents", "tasks"));
}

// ---------------------------------------------------------------------------
// Full replay: enumerate, join, stream.
// ---------------------------------------------------------------------------

/**
 * Stream every usage record of the selected sessions, joining each child to its
 * task identity. Files are processed in the deterministic enumeration order and
 * records stay in line order, so two runs over the same tree agree.
 */
export async function* streamSessionUsage(options: SessionUsageReadOptions): AsyncGenerator<TranscriptItem> {
	const refs = await listTranscriptFiles(options);
	const index = await readTaskIdentityIndex(options.agentHome);
	for (const ref of refs) {
		const task =
			ref.source === "subagent"
				? index.bySessionPath.get(resolve(ref.file)) ?? index.bySessionId.get(ref.sessionId)
				: undefined;
		const readOptions: TranscriptReadOptions = { source: ref.source, sessionId: ref.sessionId, ...(task ? { task } : {}) };
		for await (const item of streamTranscript(ref.file, readOptions)) yield item;
	}
}

/** Collect the full replay. For a large tree prefer `streamSessionUsage`. */
export async function readSessionUsage(options: SessionUsageReadOptions): Promise<TranscriptReadResult> {
	const records: TranscriptUsageRecord[] = [];
	let lines = 0;
	let malformedLines = 0;
	for await (const item of streamSessionUsage(options)) {
		lines += 1;
		if (item.kind === "usage") records.push(item.record);
		else if (item.kind === "malformed") malformedLines += 1;
	}
	return { records, lines, malformedLines };
}
