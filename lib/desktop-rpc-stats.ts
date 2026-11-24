// Gentle Desktop usage-stats slice: the pure contract shared by the Desktop
// bridge (`lib/desktop-stats-service.ts`) and the owner seam inside
// `extensions/gentle-stats.ts`.
//
// Nothing here reads a session file. The owner (`/gentle:stats`, with its one
// size/mtime-cached loader) supplies the parsed session records; this module
// runs the exact `aggregateStats` aggregation the stats panel runs and
// projects its result into the safe, bounded Desktop shape. It is a
// projection, not a second loader, cache, or aggregation.

import { aggregateStats, STATS_RANGE, STATS_SCOPE, type SessionRecord, type StatsRange, type StatsScope } from "./stats-collector.ts";

export const DESKTOP_STATS_METHODS = ["get_usage_stats"] as const;
/** Usage stats are an explicit read: this slice advertises no event. */
export const DESKTOP_STATS_EVENTS = [] as const;

// The versioned owner-service discovery seam (the stats analogue of the jobs
// `gentle:desktop:jobs-service` adapter). The schema string guards the adapter
// against drift; the bridge ignores any responder whose shape does not match.
export const DESKTOP_STATS_SERVICE_SCHEMA = "gentle-pi.desktop-stats-service/v1";
export const DESKTOP_STATS_SERVICE_CHANNEL = "gentle:desktop:stats-service";

/** Upper bounds on each array one answer carries. */
export const DESKTOP_STATS_LIMITS = { models: 50, days: 400, projects: 50, providers: 50 } as const;
/** Longest model id or project name the wire carries; longer strings are cut. */
export const DESKTOP_STATS_NAME_LIMIT = 128;

export const INVALID_STATS_PARAMS = { code: "invalid_request", message: "Invalid usage stats parameters" } as const;
export const STATS_UNAVAILABLE = { code: "stats_unavailable", message: "Usage stats unavailable: no session history can be read" } as const;

const RANGES: readonly StatsRange[] = [STATS_RANGE.WEEK, STATS_RANGE.MONTH, STATS_RANGE.ALL];
const SCOPES: readonly StatsScope[] = [STATS_SCOPE.PROJECT, STATS_SCOPE.ALL];
const PARAM_KEYS = new Set(["range", "scope"]);
const UNKNOWN_PROJECT = "unknown";

export interface DesktopUsageStatsQuery {
	range: StatsRange;
	scope: StatsScope;
}

export interface DesktopUsageStatsTotals {
	sessions: number;
	messages: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
}

export interface DesktopUsageStatsModel {
	model: string;
	messages: number;
	tokens: number;
	cost: number;
	share: number;
}

export interface DesktopUsageStatsDay {
	day: string;
	tokens: number;
	cost: number;
}

export interface DesktopUsageStatsProvider {
	provider: string;
	messages: number;
	tokens: number;
	cost: number;
	share: number;
}

export interface DesktopUsageStatsProject {
	name: string;
	sessions: number;
	messages: number;
	tokens: number;
	cost: number;
}

/** The `get_usage_stats` answer. `byProject` exists only for `scope: "all"`. */
export interface DesktopUsageStats {
	range: StatsRange;
	scope: StatsScope;
	totals: DesktopUsageStatsTotals;
	byModel: DesktopUsageStatsModel[];
	byDay: DesktopUsageStatsDay[];
	byProvider: DesktopUsageStatsProvider[];
	byProject?: DesktopUsageStatsProject[];
	truncated: { byModel: boolean; byDay: boolean; byProvider: boolean; byProject?: boolean };
}

/** One owner read: the parsed history from the owner's loader, or truthful absence. */
export type DesktopStatsOwnerRead =
	| { kind: "ok"; sessions: readonly SessionRecord[]; now: number }
	| { kind: "unavailable" };

/**
 * The owner-service adapter the bridge discovers. After `dispose()` `read`
 * answers `unavailable` rather than speaking for a replaced session.
 */
export interface DesktopStatsService {
	schema: typeof DESKTOP_STATS_SERVICE_SCHEMA;
	read(): Promise<DesktopStatsOwnerRead>;
	dispose(): void;
}

/**
 * `get_usage_stats` params are an object with only optional `range` and
 * `scope`, each one of the values `aggregateStats` supports. Anything else is
 * a typed `invalid_request` before any owner work happens.
 */
export function parseUsageStatsParams(params: Record<string, unknown>): DesktopUsageStatsQuery | { error: { code: string; message: string } } {
	if (Object.keys(params).some((key) => !PARAM_KEYS.has(key))) return { error: INVALID_STATS_PARAMS };
	// An omitted key takes its default; an explicit null or any other value must be valid.
	const range = "range" in params ? params.range : STATS_RANGE.WEEK;
	const scope = "scope" in params ? params.scope : STATS_SCOPE.PROJECT;
	if (!RANGES.includes(range as StatsRange) || !SCOPES.includes(scope as StatsScope)) return { error: INVALID_STATS_PARAMS };
	return { range: range as StatsRange, scope: scope as StatsScope };
}

/** True only for the adapter-shaped object the discovery responder must return. */
export function isDesktopStatsServiceShape(value: unknown): value is DesktopStatsService {
	if (!value || typeof value !== "object") return false;
	const adapter = value as Partial<DesktopStatsService>;
	return adapter.schema === DESKTOP_STATS_SERVICE_SCHEMA && typeof adapter.read === "function" && typeof adapter.dispose === "function";
}

const boundedName = (value: string): string => (value.length > DESKTOP_STATS_NAME_LIMIT ? value.slice(0, DESKTOP_STATS_NAME_LIMIT) : value);

/** A project's display name: the last segment of its working directory, never the path. */
export function projectDisplayName(cwd: string): string {
	const segments = cwd.split(/[\\/]+/).filter((segment) => segment.length > 0);
	return boundedName(segments.at(-1) ?? UNKNOWN_PROJECT);
}

/**
 * The `get_usage_stats` projection over the owner's parsed history. Totals,
 * models, and days come from one `aggregateStats` call with the requested
 * range and scope; for `scope: "all"` each project row is the same
 * aggregation scoped to that project. Every field is rebuilt by name, so no
 * session id, path, or message text can reach the wire. Arrays keep the
 * largest models and projects and the most recent days within the bounds.
 */
export function projectDesktopUsageStats(
	sessions: readonly SessionRecord[],
	query: DesktopUsageStatsQuery & { cwd: string | undefined; now: number },
): DesktopUsageStats {
	const summary = aggregateStats(sessions, { range: query.range, scope: query.scope, cwd: query.cwd, now: query.now });
	const models = summary.models.map((model) => ({ model: boundedName(model.model), messages: model.messages, tokens: model.tokens, cost: model.cost, share: model.share }));
	const days = Object.keys(summary.days).sort().map((day) => ({ day, tokens: summary.days[day]!, cost: summary.dayCosts[day] ?? 0 }));
	const providers = summary.providers.map((provider) => ({ provider: boundedName(provider.provider), messages: provider.messages, tokens: provider.tokens, cost: provider.cost, share: provider.share }));
	const stats: DesktopUsageStats = {
		range: query.range,
		scope: query.scope,
		totals: {
			sessions: summary.sessions,
			messages: summary.models.reduce((sum, model) => sum + model.messages, 0),
			inputTokens: summary.totals.input,
			outputTokens: summary.totals.output,
			cacheReadTokens: summary.totals.cacheRead,
			cacheWriteTokens: summary.totals.cacheWrite,
			totalTokens: summary.totals.total,
			cost: summary.totals.cost,
		},
		byModel: models.slice(0, DESKTOP_STATS_LIMITS.models),
		byDay: days.slice(Math.max(0, days.length - DESKTOP_STATS_LIMITS.days)),
		byProvider: providers.slice(0, DESKTOP_STATS_LIMITS.providers),
		truncated: { byModel: models.length > DESKTOP_STATS_LIMITS.models, byDay: days.length > DESKTOP_STATS_LIMITS.days, byProvider: providers.length > DESKTOP_STATS_LIMITS.providers },
	};
	if (query.scope === STATS_SCOPE.ALL) {
		const projects = projectRows(sessions, query);
		stats.byProject = projects.slice(0, DESKTOP_STATS_LIMITS.projects);
		stats.truncated.byProject = projects.length > DESKTOP_STATS_LIMITS.projects;
	}
	return stats;
}

function projectRows(sessions: readonly SessionRecord[], query: DesktopUsageStatsQuery & { now: number }): DesktopUsageStatsProject[] {
	const byCwd = new Map<string, SessionRecord[]>();
	for (const session of sessions) byCwd.set(session.cwd, [...(byCwd.get(session.cwd) ?? []), session]);
	const rows: Array<DesktopUsageStatsProject & { cwd: string }> = [];
	for (const [cwd, group] of byCwd) {
		const summary = aggregateStats(group, { range: query.range, scope: STATS_SCOPE.PROJECT, cwd, now: query.now });
		if (summary.sessions === 0) continue;
		rows.push({
			cwd,
			name: projectDisplayName(cwd),
			sessions: summary.sessions,
			messages: summary.models.reduce((sum, model) => sum + model.messages, 0),
			tokens: summary.totals.total,
			cost: summary.totals.cost,
		});
	}
	// Largest first; the private cwd only breaks a full tie and never leaves here.
	rows.sort((a, b) => b.tokens - a.tokens || b.messages - a.messages || a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd));
	return rows.map(({ name, sessions: count, messages, tokens, cost }) => ({ name, sessions: count, messages, tokens, cost }));
}
