import { truncateToWidth } from "@earendil-works/pi-tui";
import { paintGauge } from "./shell-gauge.ts";

// Gentle Shell subscription usage: the rate-limit windows each connected
// provider reports. Codex sends them as SSE headers and through its usage
// endpoint; both land in the same model. Parsing is pure and never keeps
// account details beyond the plan name.

export interface UsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
}

export interface UsageLimit {
	name: string;
	windows: UsageWindow[];
	limitReached: boolean;
}

export interface ProviderUsage {
	provider: string;
	plan: string | undefined;
	limits: UsageLimit[];
	fetchedAt: number;
}

export interface UsageTheme {
	fg(color: string, text: string): string;
}

interface RawWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

interface RawRateLimit {
	limit_reached?: boolean;
	primary_window?: RawWindow | null;
	secondary_window?: RawWindow | null;
}

interface RawAdditionalLimit {
	limit_name?: string;
	rate_limit?: RawRateLimit | null;
}

interface RawCodexUsage {
	plan_type?: string;
	rate_limit?: RawRateLimit | null;
	additional_rate_limits?: RawAdditionalLimit[] | null;
}

export const CODEX_PROVIDER = "openai-codex";
export const ANTHROPIC_PROVIDER = "anthropic";
const ANTHROPIC_MAIN_LIMIT = "claude";
const ANTHROPIC_PREFIX = "anthropic-ratelimit-unified-";
const ANTHROPIC_WINDOWS: ReadonlyArray<[key: string, seconds: number]> = [
	["5h", 18_000],
	["7d", 604_800],
];
// kimi-coding is the Kimi Code subscription OAuth provider; the matching usage
// endpoint lives at api.kimi.com and answers the weekly quota plus every
// rate-limit window the plan exposes.
export const KIMI_PROVIDER = "kimi-coding";
export const KIMI_DISPLAY_NAME = "kimi";
export const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
// The top-level "usage" row is the weekly plan quota; limits[] carry per-window
// caps. Both share the same numeric shape, so one parser handles them.
const KIMI_WEEKLY_LIMIT = "kimi";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_MAIN_LIMIT = "codex";
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const HEADER_PREFIX = "x-codex-";
const PANEL_METER_CELLS = 16;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
const KIMI_TIME_UNITS: Readonly<Record<string, number>> = {
	TIME_UNIT_MINUTE: MINUTE,
	TIME_UNIT_HOUR: HOUR,
	TIME_UNIT_DAY: DAY,
	TIME_UNIT_WEEK: WEEK,
};
const ROLE = {
	PROVIDER: "text",
	PLAN: "muted",
	LIMIT: "customMessageLabel",
	LABEL: "muted",
	PERCENT: "text",
	RESET: "dim",
	SEPARATOR: "muted",
} as const;
export const USAGE_EMPTY_MESSAGE = "No subscription usage yet. Usage arrives with the next response, or press r to fetch it.";
export const SUPPORTED_USAGE_PROVIDERS: readonly string[] = [CODEX_PROVIDER, ANTHROPIC_PROVIDER, KIMI_PROVIDER];
const PENDING_NOTE: Record<string, string> = {
	[CODEX_PROVIDER]: "no usage yet · r to fetch",
	[ANTHROPIC_PROVIDER]: "usage arrives with the first response",
	[KIMI_PROVIDER]: "no usage yet · r to fetch",
};
const UNSUPPORTED_NOTE = "no subscription usage for this provider";
const ACTIVE_MARK = "✿";

export interface ActiveProvider {
	provider: string;
}

export function providerNote(provider: string): string {
	return PENDING_NOTE[provider] ?? UNSUPPORTED_NOTE;
}

export function windowLabel(seconds: number): string {
	if (seconds === WEEK) return "week";
	if (seconds >= DAY && seconds % DAY === 0) return `${seconds / DAY}d`;
	if (seconds >= HOUR && seconds % HOUR === 0) return `${seconds / HOUR}h`;
	return `${Math.round(seconds / MINUTE)}m`;
}

export function formatReset(resetAt: number | null, now: number): string {
	if (resetAt === null) return "";
	const seconds = Math.floor((resetAt - now) / 1000);
	if (seconds <= 0) return "resets now";
	if (seconds < HOUR) return `resets in ${Math.max(1, Math.round(seconds / MINUTE))}m`;
	if (seconds < DAY) return `resets in ${Math.floor(seconds / HOUR)}h ${Math.floor((seconds % HOUR) / MINUTE)}m`;
	return `resets in ${Math.floor(seconds / DAY)}d ${Math.floor((seconds % DAY) / HOUR)}h`;
}

function parseWindow(raw: RawWindow | null | undefined, now: number): UsageWindow | undefined {
	if (!raw || typeof raw.used_percent !== "number" || typeof raw.limit_window_seconds !== "number") return undefined;
	const resetAt =
		typeof raw.reset_at === "number" ? raw.reset_at * 1000 : typeof raw.reset_after_seconds === "number" ? now + raw.reset_after_seconds * 1000 : null;
	return { label: windowLabel(raw.limit_window_seconds), usedPercent: raw.used_percent, windowSeconds: raw.limit_window_seconds, resetAt };
}

function parseRateLimit(name: string, raw: RawRateLimit | null | undefined, now: number): UsageLimit | undefined {
	if (!raw) return undefined;
	const windows = [parseWindow(raw.primary_window, now), parseWindow(raw.secondary_window, now)].filter((window): window is UsageWindow => window !== undefined);
	if (windows.length === 0) return undefined;
	return { name, windows, limitReached: raw.limit_reached === true };
}

export function parseCodexUsage(payload: unknown, now: number): ProviderUsage {
	const raw = (payload ?? {}) as RawCodexUsage;
	const limits: UsageLimit[] = [];
	const main = parseRateLimit(CODEX_MAIN_LIMIT, raw.rate_limit, now);
	if (main) limits.push(main);
	for (const extra of raw.additional_rate_limits ?? []) {
		const limit = parseRateLimit(extra.limit_name ?? "limit", extra.rate_limit, now);
		if (limit) limits.push(limit);
	}
	return { provider: CODEX_PROVIDER, plan: typeof raw.plan_type === "string" ? raw.plan_type : undefined, limits, fetchedAt: now };
}

function headerWindow(headers: Record<string, string>, kind: "primary" | "secondary", now: number): UsageWindow | undefined {
	const used = Number.parseFloat(headers[`${HEADER_PREFIX}${kind}-used-percent`] ?? "");
	if (!Number.isFinite(used)) return undefined;
	const minutes = Number.parseInt(headers[`${HEADER_PREFIX}${kind}-window-minutes`] ?? "", 10);
	const resetAt = Number.parseInt(headers[`${HEADER_PREFIX}${kind}-reset-at`] ?? "", 10);
	const seconds = Number.isFinite(minutes) ? minutes * MINUTE : 0;
	return { label: windowLabel(seconds), usedPercent: used, windowSeconds: seconds, resetAt: Number.isFinite(resetAt) ? resetAt * 1000 : null };
}

export function parseCodexHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	const windows = [headerWindow(headers, "primary", now), headerWindow(headers, "secondary", now)].filter((window): window is UsageWindow => window !== undefined);
	if (windows.length === 0) return undefined;
	const reached = headers[`${HEADER_PREFIX}rate-limit-reached-type`];
	return { provider: CODEX_PROVIDER, plan: undefined, limits: [{ name: CODEX_MAIN_LIMIT, windows, limitReached: Boolean(reached) }], fetchedAt: now };
}

// Claude Pro/Max sends utilization as a 0..1 fraction per window and reset
// times in Unix seconds on every response; there is no usage endpoint.
export function parseAnthropicHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	const windows: UsageWindow[] = [];
	for (const [key, seconds] of ANTHROPIC_WINDOWS) {
		const fraction = Number.parseFloat(headers[`${ANTHROPIC_PREFIX}${key}-utilization`] ?? "");
		if (!Number.isFinite(fraction)) continue;
		const reset = Number.parseInt(headers[`${ANTHROPIC_PREFIX}${key}-reset`] ?? "", 10);
		windows.push({ label: windowLabel(seconds), usedPercent: fraction * 100, windowSeconds: seconds, resetAt: Number.isFinite(reset) ? reset * 1000 : null });
	}
	if (windows.length === 0) return undefined;
	const status = headers[`${ANTHROPIC_PREFIX}status`];
	return { provider: ANTHROPIC_PROVIDER, plan: undefined, limits: [{ name: ANTHROPIC_MAIN_LIMIT, windows, limitReached: status === "rejected" }], fetchedAt: now };
}

export function parseUsageHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	return parseCodexHeaders(headers, now) ?? parseAnthropicHeaders(headers, now);
}

interface RawKimiWindow {
	duration?: unknown;
	timeUnit?: unknown;
}

interface RawKimiDetail {
	limit?: unknown;
	used?: unknown;
	remaining?: unknown;
	resetTime?: unknown;
}

interface RawKimiLimit {
	name?: unknown;
	window?: RawKimiWindow | null;
	detail?: RawKimiDetail | null;
}

interface RawKimiUsage {
	usage?: RawKimiDetail | null;
	limits?: RawKimiLimit[] | null;
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function kimiWindowSeconds(window: RawKimiWindow | null | undefined): number | undefined {
	if (!window) return undefined;
	const duration = toFiniteNumber(window.duration);
	const unitSeconds = typeof window.timeUnit === "string" ? KIMI_TIME_UNITS[window.timeUnit] : undefined;
	if (duration === undefined || unitSeconds === undefined) return undefined;
	const seconds = duration * unitSeconds;
	return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function kimiPercent(detail: RawKimiDetail | null | undefined): number | undefined {
	if (!detail) return undefined;
	const used = toFiniteNumber(detail.used);
	const limit = toFiniteNumber(detail.limit);
	if (limit === undefined || limit <= 0 || used === undefined) return undefined;
	const percent = Math.min(100, Math.max(0, (used / limit) * 100));
	return percent;
}

function kimiReset(detail: RawKimiDetail | null | undefined): number | null {
	if (!detail || typeof detail.resetTime !== "string") return null;
	const millis = Date.parse(detail.resetTime);
	return Number.isFinite(millis) ? millis : null;
}

// The top-level "usage" row is the weekly plan quota; limits[] carry per-window
// caps. Both share the same numeric shape, so one parser handles them.
function kimiWindow(detail: RawKimiDetail | null | undefined, window: RawKimiWindow | null | undefined, fallbackSeconds: number): UsageWindow | undefined {
	const seconds = kimiWindowSeconds(window) ?? fallbackSeconds;
	const usedPercent = kimiPercent(detail);
	if (usedPercent === undefined) return undefined;
	return { label: windowLabel(seconds), usedPercent, windowSeconds: seconds, resetAt: kimiReset(detail) };
}

export function parseKimiUsage(payload: unknown, now: number): ProviderUsage | undefined {
	const raw = (payload ?? {}) as RawKimiUsage;
	const windows: UsageWindow[] = [];
	// The top-level usage row is the weekly plan quota. The endpoint omits the
	// window object for that one, so fall back to a week window when it is present.
	const weekly = kimiWindow(raw.usage, undefined, WEEK);
	if (weekly) windows.push(weekly);
	for (const entry of raw.limits ?? []) {
		const win = kimiWindow(entry.detail ?? null, entry.window ?? null, 0);
		if (win && Number.isFinite(win.windowSeconds) && win.windowSeconds > 0) windows.push(win);
	}
	if (windows.length === 0) return undefined;
	// The weekly row is the plan quota and is reported under the KIMI display name;
	// per-window rows live alongside it inside the same limit bucket.
	return {
		provider: KIMI_PROVIDER,
		plan: undefined,
		limits: [{ name: KIMI_WEEKLY_LIMIT, windows, limitReached: windows.some((window) => window.usedPercent >= 100) }],
		fetchedAt: now,
	};
}

export function accountIdFromToken(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = claims[CODEX_ACCOUNT_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
		return typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id.length > 0 ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

function paintMeter(percent: number, cells: number, theme: UsageTheme): string {
	return paintGauge(percent, theme, cells);
}

export function renderUsageBar(usage: ProviderUsage, theme: UsageTheme): string | undefined {
	const main = usage.limits[0];
	const [first, ...rest] = main?.windows ?? [];
	if (!first) return undefined;
	const head = `${theme.fg(ROLE.LABEL, main.name)} ${theme.fg(ROLE.LABEL, first.label)} ${paintMeter(first.usedPercent, 8, theme)} ${theme.fg(ROLE.PERCENT, `${Math.round(first.usedPercent)}%`)}`;
	const tail = rest.map((window) => `${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.LABEL, window.label)} ${theme.fg(ROLE.PERCENT, `${Math.round(window.usedPercent)}%`)}`);
	return [head, ...tail].join(" ");
}

function updatedAgo(fetchedAt: number, now: number): string {
	const minutes = Math.floor((now - fetchedAt) / 60_000);
	return minutes < 1 ? "updated just now" : `updated ${minutes}m ago`;
}

// The active provider comes first, marked with the petal, and explains
// itself when it has no data yet. Other providers seen this session follow.
export function renderUsagePanel(usages: ProviderUsage[], theme: UsageTheme, width: number, now: number, active?: ActiveProvider): string[] {
	const activeUsage = active ? usages.find((usage) => usage.provider === active.provider) : undefined;
	const others = usages.filter((usage) => usage !== activeUsage);
	if (!active && usages.length === 0) return [truncateToWidth(USAGE_EMPTY_MESSAGE, width, "…")];
	const lines: string[] = [];
	if (active && !activeUsage) {
		lines.push(`${theme.fg(ROLE.LIMIT, ACTIVE_MARK)} ${theme.fg(ROLE.PROVIDER, active.provider)} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, providerNote(active.provider))}`);
	}
	for (const usage of [...(activeUsage ? [activeUsage] : []), ...others]) {
		const mark = usage === activeUsage ? `${theme.fg(ROLE.LIMIT, ACTIVE_MARK)} ` : "";
		const plan = usage.plan ? ` ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.PLAN, usage.plan)}` : "";
		lines.push(`${mark}${theme.fg(ROLE.PROVIDER, usage.provider)}${plan} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, updatedAgo(usage.fetchedAt, now))}`);
		for (const limit of usage.limits) {
			lines.push(`  ${theme.fg(ROLE.LIMIT, limit.name)}`);
			for (const window of limit.windows) {
				const percent = `${Math.round(window.usedPercent)}%`.padStart(4);
				lines.push(`    ${theme.fg(ROLE.LABEL, window.label.padEnd(5))} ${paintMeter(window.usedPercent, PANEL_METER_CELLS, theme)} ${theme.fg(ROLE.PERCENT, percent)}  ${theme.fg(ROLE.RESET, formatReset(window.resetAt, now))}`);
			}
		}
	}
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

export class UsageStore {
	private readonly usages = new Map<string, ProviderUsage>();

	record(usage: ProviderUsage): void {
		this.usages.set(usage.provider, usage);
	}

	get(provider: string): ProviderUsage | undefined {
		return this.usages.get(provider);
	}

	all(): ProviderUsage[] {
		return [...this.usages.values()];
	}
}
