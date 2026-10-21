import { createReadStream, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { listSessionFiles } from "../extensions/history/session-scan.ts";
import { SessionChanges } from "./session-changes.ts";

// /gentle:stats data: a read-only, failure-tolerant scan of Pi's top-level
// session files (nested subagent runs are excluded by listSessionFiles) across
// one or more homes, and pure aggregation over the parsed records. Nothing
// here persists anything.
// Day keys are local calendar dates ("YYYY-MM-DD"); key arithmetic runs in
// UTC so it never drifts across DST changes.

export const STATS_RANGE = {
	ALL: "all",
	WEEK: "7d",
	MONTH: "30d",
} as const;
export type StatsRange = (typeof STATS_RANGE)[keyof typeof STATS_RANGE];

export const STATS_SCOPE = {
	ALL: "all",
	PROJECT: "project",
} as const;
export type StatsScope = (typeof STATS_SCOPE)[keyof typeof STATS_SCOPE];

const RANGE_DAYS: Record<StatsRange, number | undefined> = {
	[STATS_RANGE.ALL]: undefined,
	[STATS_RANGE.WEEK]: 7,
	[STATS_RANGE.MONTH]: 30,
};
const DAY_MS = 24 * 60 * 60 * 1000;
const COST_PRECISION = 1e9;
const UNKNOWN = "unknown";

export interface UsageRecord {
	timestamp: number;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

export interface SessionRecord {
	id: string;
	cwd: string;
	startedAt: number;
	messages: UsageRecord[];
}

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

export interface ModelStats {
	model: string;
	tokens: number;
	cost: number;
	messages: number;
	share: number;
}

export interface StatsFilter {
	range: StatsRange;
	scope: StatsScope;
	cwd?: string;
	now: number;
	dayKey?: (ms: number) => string;
}

export interface StatsSummary {
	totals: TokenTotals;
	models: ModelStats[];
	days: Record<string, number>;
	sessions: number;
	activeDays: number;
	daysInRange: number;
	firstDay: string;
	today: string;
	mostActiveDay?: { day: string; tokens: number };
	longestSession?: { id: string; durationMs: number };
	longestStreak: number;
	currentStreak: number;
}

export interface CurrentSessionStats {
	totals: TokenTotals;
	messages: number;
	model?: string;
	durationMs: number;
	lines?: { added: number; removed: number };
}

export function localDayKey(ms: number): string {
	const date = new Date(ms);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayUtc(key: string): number {
	const [year, month, day] = key.split("-").map(Number);
	return Date.UTC(year, month - 1, day);
}

export function shiftDay(key: string, delta: number): string {
	return new Date(dayUtc(key) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(key: string): number {
	return new Date(dayUtc(key)).getUTCDay();
}

export function daysBetween(from: string, to: string): number {
	return Math.round((dayUtc(to) - dayUtc(from)) / DAY_MS);
}

const emptyTotals = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const roundCost = (value: number): number => Math.round(value * COST_PRECISION) / COST_PRECISION;
const text = (value: unknown, fallback: string): string => (typeof value === "string" && value.length > 0 ? value : fallback);

function addUsage(totals: TokenTotals, record: UsageRecord): void {
	totals.input += record.input;
	totals.output += record.output;
	totals.cacheRead += record.cacheRead;
	totals.cacheWrite += record.cacheWrite;
	totals.total += record.total;
	totals.cost += record.cost;
}

type RawEntry = { type?: unknown; timestamp?: unknown; message?: { role?: unknown; provider?: unknown; model?: unknown; usage?: unknown } };

/** One assistant usage record from a parsed entry, or undefined for anything else. */
export function usageRecord(entry: unknown): UsageRecord | undefined {
	const raw = entry as RawEntry | null;
	if (!raw || typeof raw !== "object" || raw.type !== "message" || raw.message?.role !== "assistant") return undefined;
	const usage = raw.message.usage as Record<string, unknown> | undefined;
	if (!usage || typeof usage !== "object") return undefined;
	const timestamp = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
	if (!Number.isFinite(timestamp)) return undefined;
	const input = count(usage.input);
	const output = count(usage.output);
	const cacheRead = count(usage.cacheRead);
	const cacheWrite = count(usage.cacheWrite);
	const total = typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0 ? usage.totalTokens : input + output + cacheRead + cacheWrite;
	const cost = count((usage.cost as { total?: unknown } | undefined)?.total);
	return { timestamp, provider: text(raw.message.provider, UNKNOWN), model: text(raw.message.model, UNKNOWN), input, output, cacheRead, cacheWrite, total, cost };
}

// Incremental so the loader can stream large files line by line. Only the
// header and assistant lines are parsed; everything else is skipped by a
// cheap substring check before JSON.parse.
class SessionParser {
	private record: SessionRecord | undefined;
	private sawFirst = false;

	push(line: string): void {
		if (!this.sawFirst) {
			if (line.trim() === "") return;
			this.sawFirst = true;
			const header = parse(line) as { type?: unknown; id?: unknown; timestamp?: unknown; cwd?: unknown } | undefined;
			if (header?.type !== "session") return;
			const startedAt = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
			this.record = { id: text(header.id, UNKNOWN), cwd: text(header.cwd, ""), startedAt, messages: [] };
			return;
		}
		if (!this.record || !line.includes("\"assistant\"")) return;
		const usage = usageRecord(parse(line));
		if (usage) this.record.messages.push(usage);
	}

	result(): SessionRecord | undefined {
		const record = this.record;
		if (record && !Number.isFinite(record.startedAt)) record.startedAt = record.messages[0]?.timestamp ?? NaN;
		return record;
	}
}

function parse(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

export function parseSessionLines(lines: Iterable<string>): SessionRecord | undefined {
	const parser = new SessionParser();
	for (const line of lines) parser.push(line);
	return parser.result();
}

async function readSessionFile(path: string): Promise<SessionRecord | undefined> {
	const parser = new SessionParser();
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) parser.push(line);
	} catch {
		return undefined; // an unreadable file skips itself, never fatal
	} finally {
		lines.close();
		stream.destroy();
	}
	return parser.result();
}

export interface StatsLoader {
	load(sessionsRoots: string | readonly string[]): Promise<SessionRecord[]>;
}

// Roots resolve through realpath so an alias (trailing slash, "..", a
// symlink) of a root already listed is read once; a missing root is skipped.
function sessionFiles(sessionsRoots: readonly string[]): string[] {
	const roots = new Set<string>();
	for (const root of sessionsRoots) {
		try {
			roots.add(realpathSync(root));
		} catch {
			// a missing or unreadable root contributes nothing
		}
	}
	return [...new Set([...roots].flatMap(listSessionFiles))];
}

const lastUsageAt = (record: SessionRecord): number => record.messages.reduce((latest, message) => Math.max(latest, message.timestamp), -Infinity);

// The same session can exist in two homes (a copied or migrated history).
// Only one copy counts: the one with more usage records, then the one whose
// last usage is newest; on a full tie the first file in path order stays.
function preferredCopy(kept: SessionRecord, other: SessionRecord): SessionRecord {
	if (other.messages.length !== kept.messages.length) return other.messages.length > kept.messages.length ? other : kept;
	return lastUsageAt(other) > lastUsageAt(kept) ? other : kept;
}

/** A loader over one or more sessions roots that re-reads only files whose size or mtime changed since the last load. */
export function createStatsLoader(): StatsLoader {
	const cache = new Map<string, { size: number; mtimeMs: number; record: SessionRecord | undefined }>();
	return {
		async load(sessionsRoots) {
			const files = sessionFiles(typeof sessionsRoots === "string" ? [sessionsRoots] : sessionsRoots).sort();
			const live = new Set(files);
			for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
			const byId = new Map<string, SessionRecord>();
			const sessions: SessionRecord[] = [];
			for (const path of files) {
				let info;
				try {
					info = await stat(path);
				} catch {
					continue;
				}
				let cached = cache.get(path);
				if (!cached || cached.size !== info.size || cached.mtimeMs !== info.mtimeMs) {
					cached = { size: info.size, mtimeMs: info.mtimeMs, record: await readSessionFile(path) };
					cache.set(path, cached);
				}
				const record = cached.record;
				if (!record) continue;
				// A header without an ID cannot be matched to another copy.
				if (record.id === UNKNOWN) sessions.push(record);
				else byId.set(record.id, byId.has(record.id) ? preferredCopy(byId.get(record.id)!, record) : record);
			}
			return [...byId.values(), ...sessions];
		},
	};
}

export function aggregateStats(sessions: readonly SessionRecord[], filter: StatsFilter): StatsSummary {
	const dayKey = filter.dayKey ?? localDayKey;
	const today = dayKey(filter.now);
	const rangeDays = RANGE_DAYS[filter.range];
	const startDay = rangeDays === undefined ? undefined : shiftDay(today, -(rangeDays - 1));
	const totals = emptyTotals();
	const models = new Map<string, Omit<ModelStats, "share">>();
	const days: Record<string, number> = {};
	let sessionCount = 0;
	let longestSession: StatsSummary["longestSession"];
	for (const session of sessions) {
		if (filter.scope === STATS_SCOPE.PROJECT && session.cwd !== filter.cwd) continue;
		let counted = false;
		let lastAt = -Infinity;
		for (const message of session.messages) {
			const day = dayKey(message.timestamp);
			if (startDay !== undefined && day < startDay) continue;
			counted = true;
			lastAt = Math.max(lastAt, message.timestamp);
			addUsage(totals, message);
			days[day] = (days[day] ?? 0) + message.total;
			const model = models.get(message.model) ?? { model: message.model, tokens: 0, cost: 0, messages: 0 };
			model.tokens += message.total;
			model.cost += message.cost;
			model.messages++;
			models.set(message.model, model);
		}
		if (!counted) continue;
		sessionCount++;
		const durationMs = Number.isFinite(session.startedAt) ? Math.max(0, lastAt - session.startedAt) : 0;
		if (!longestSession || durationMs > longestSession.durationMs) longestSession = { id: session.id, durationMs };
	}
	totals.cost = roundCost(totals.cost);
	const active = Object.keys(days).sort();
	const firstDay = startDay ?? active[0] ?? today;
	let mostActiveDay: StatsSummary["mostActiveDay"];
	for (const day of active) if (!mostActiveDay || days[day] > mostActiveDay.tokens) mostActiveDay = { day, tokens: days[day] };
	return {
		totals,
		models: [...models.values()]
			.map((model) => ({ ...model, cost: roundCost(model.cost), share: totals.total > 0 ? model.tokens / totals.total : 0 }))
			.sort((a, b) => b.tokens - a.tokens || b.messages - a.messages || a.model.localeCompare(b.model)),
		days,
		sessions: sessionCount,
		activeDays: active.length,
		daysInRange: daysBetween(firstDay, today) + 1,
		firstDay,
		today,
		mostActiveDay,
		longestSession,
		longestStreak: longestStreak(active),
		currentStreak: currentStreak(days, today),
	};
}

function longestStreak(sortedDays: readonly string[]): number {
	let best = 0;
	let run = 0;
	let previous: string | undefined;
	for (const day of sortedDays) {
		run = previous !== undefined && shiftDay(previous, 1) === day ? run + 1 : 1;
		best = Math.max(best, run);
		previous = day;
	}
	return best;
}

// A streak stays alive through an idle today: it counts back from today when
// today is active, otherwise from yesterday.
function currentStreak(days: Record<string, number>, today: string): number {
	let day = days[today] !== undefined ? today : shiftDay(today, -1);
	let streak = 0;
	while (days[day] !== undefined) {
		streak++;
		day = shiftDay(day, -1);
	}
	return streak;
}

type LiveEntry = { type?: string; customType?: string; data?: unknown; timestamp?: unknown; modelId?: unknown };

/** The live session from its in-memory entries: usage, wall time so far, and captured line changes. */
export function currentSessionStats(entries: readonly unknown[], options: { sessionId: string; now: number }): CurrentSessionStats {
	const totals = emptyTotals();
	let messages = 0;
	let model: string | undefined;
	let firstAt = Infinity;
	for (const entry of entries as LiveEntry[]) {
		const at = typeof entry?.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
		if (Number.isFinite(at)) firstAt = Math.min(firstAt, at);
		if (entry?.type === "model_change" && typeof entry.modelId === "string") model = entry.modelId;
		const usage = usageRecord(entry);
		if (!usage) continue;
		addUsage(totals, usage);
		messages++;
		if (usage.model !== UNKNOWN) model = usage.model;
	}
	totals.cost = roundCost(totals.cost);
	const worktrees = new SessionChanges(options.sessionId, entries as LiveEntry[]).worktrees;
	const lines = worktrees.length === 0
		? undefined
		: worktrees.reduce((sum, tree) => ({ added: sum.added + tree.model.added, removed: sum.removed + tree.model.deleted }), { added: 0, removed: 0 });
	return { totals, messages, model, durationMs: Number.isFinite(firstAt) ? Math.max(0, options.now - firstAt) : 0, lines };
}
