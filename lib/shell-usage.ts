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
	// Raw allowance numbers, kept only by providers that report them (NaN).
	// Aggregates are weighted by budget, so averaging percentages is never
	// needed; nothing renders these fields directly.
	used?: number;
	budget?: number;
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

interface RawNanModel {
	model?: unknown;
	cap?: unknown;
	fullCap?: unknown;
	tokensUsed?: unknown;
	periodEnd?: unknown;
	windowHours?: unknown;
	windowTokens?: unknown;
	fullWindowTokens?: unknown;
	windowTokensUsed?: unknown;
	windowResetsAt?: unknown;
}

interface RawNanQuota {
	models?: unknown;
	periodEnd?: unknown;
}

export const CODEX_PROVIDER = "openai-codex";
export const ANTHROPIC_PROVIDER = "anthropic";
export const NAN_PROVIDER = "nan";
const ANTHROPIC_MAIN_LIMIT = "claude";
const ANTHROPIC_PREFIX = "anthropic-ratelimit-unified-";
const ANTHROPIC_WINDOWS: ReadonlyArray<[key: string, seconds: number]> = [
	["5h", 18_000],
	["7d", 604_800],
];
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
// The NaN Cloud dashboard backend; not part of NaN's published OpenAPI, so the
// fetch that uses it is fixed-origin, redirect-refusing, and schema-validated.
export const NAN_QUOTA_URL = "https://cloud-api.nan.builders/api/usage/quota";
// The model's own allowance for the billing period carries no label: the model
// id names it in the bar, and the reset text says what the window is in the
// panel. Only a sub-window on top of it (a rolling `4h`) needs a name.
const NAN_PERIOD_LABEL = "";
// The dashboard's own published fallbacks for a model that reports rolling
// numbers without naming its budget.
const NAN_DEFAULT_WINDOW_TOKENS = 400_000_000;
const NAN_DEFAULT_WINDOW_HOURS = 4;
const CODEX_MAIN_LIMIT = "codex";
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const HEADER_PREFIX = "x-codex-";
const PANEL_METER_CELLS = 16;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
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
export const SUPPORTED_USAGE_PROVIDERS: readonly string[] = [CODEX_PROVIDER, ANTHROPIC_PROVIDER, NAN_PROVIDER];
const PENDING_NOTE: Record<string, string> = {
	[CODEX_PROVIDER]: "no usage yet · r to fetch",
	[NAN_PROVIDER]: "no usage yet · r to fetch",
	[ANTHROPIC_PROVIDER]: "usage arrives with the first response",
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

// NaN Cloud reports one allowance per model for the billing period, plus the
// rolling window the model applies on top of it. Percentages follow the
// dashboard exactly: tokens used over the period allowance, and window tokens
// over the full window budget. Every field is optional, because this payload
// lives outside NaN's published contract.
function quotaTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value * 1000;
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function quotaNumber(value: unknown, positive: boolean): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return positive ? (value > 0 ? value : undefined) : value >= 0 ? value : undefined;
}

function nanRollingWindow(raw: RawNanModel): UsageWindow | undefined {
	const used = quotaNumber(raw.windowTokensUsed, false);
	if (used === undefined) return undefined;
	const budget = quotaNumber(raw.fullWindowTokens, true) ?? quotaNumber(raw.windowTokens, true) ?? NAN_DEFAULT_WINDOW_TOKENS;
	const hours = quotaNumber(raw.windowHours, true) ?? NAN_DEFAULT_WINDOW_HOURS;
	return { label: windowLabel(hours * HOUR), usedPercent: (used / budget) * 100, windowSeconds: hours * HOUR, resetAt: quotaTimestamp(raw.windowResetsAt) };
}

// The allowance the dashboard divides by is the full-period cap, because `cap`
// is the allowance of the period in progress and comes back prorated on a first
// period. A model that reports neither figure reports no allowance at all, which
// is a state the surfaces already know how to draw nothing for.
function nanEffectiveAllowance(raw: RawNanModel): number | undefined {
	return quotaNumber(raw.fullCap, true) ?? quotaNumber(raw.cap, true);
}

// One allowance per metered model, weighted by that model's own cap. The raw
// numbers travel with the period window so the bar and the panel can aggregate
// without ever averaging percentages.
function nanPeriodWindow(tokensUsed: number, cap: number, resetAt: number | null, now: number): UsageWindow {
	return {
		label: NAN_PERIOD_LABEL,
		usedPercent: (tokensUsed / cap) * 100,
		windowSeconds: resetAt === null ? 0 : Math.max(0, Math.round((resetAt - now) / 1000)),
		resetAt,
		used: tokensUsed,
		budget: cap,
	};
}

export function parseNanQuota(payload: unknown, now: number): ProviderUsage {
	const raw = (payload ?? {}) as RawNanQuota;
	const fallbackResetAt = quotaTimestamp(raw.periodEnd);
	const limits: UsageLimit[] = [];
	if (Array.isArray(raw.models)) {
		for (const entry of raw.models) {
			if (!entry || typeof entry !== "object") continue;
			const model = entry as RawNanModel;
			if (typeof model.model !== "string" || model.model.length === 0) continue;
			const allowance = nanEffectiveAllowance(model);
			// A model that reports no allowance is not drift — the dashboard draws
			// nothing for it either, and the live payload carries such entries. A metered
			// allowance whose usage cannot be read is drift: a partial snapshot would
			// understate every aggregate it feeds, so the read fails whole and the last
			// valid snapshot survives instead.
			if (allowance === undefined) continue;
			const tokensUsed = quotaNumber(model.tokensUsed, false);
			if (tokensUsed === undefined) return { provider: NAN_PROVIDER, plan: undefined, limits: [], fetchedAt: now };
			const resetAt = quotaTimestamp(model.periodEnd) ?? fallbackResetAt;
			const windows: UsageWindow[] = [nanPeriodWindow(tokensUsed, allowance, resetAt, now)];
			const rolling = nanRollingWindow(model);
			if (rolling) windows.push(rolling);
			limits.push({ name: model.model, windows, limitReached: tokensUsed >= allowance });
		}
	}
	return { provider: NAN_PROVIDER, plan: undefined, limits, fetchedAt: now };
}

// Aggregation. NaN reports one allowance per metered model and the payload
// order is the server's business, so surfaces pick by meaning, not by position.
function rawAllowance(limit: UsageLimit): UsageWindow | undefined {
	const [first] = limit.windows;
	if (!first || first.used === undefined || first.budget === undefined) return undefined;
	return first.budget > 0 ? first : undefined;
}

// The leading alphabetic run of a model id: glm5.3-flash and glm5.2 are both
// "glm". Derived from the id the payload reports, never from a vendor list.
export function modelFamily(modelId: string): string {
	return (/^[a-z]+/i.exec(modelId)?.[0] ?? modelId).toLowerCase();
}

// Only NaN carries raw allowance numbers, so this one gate is what keeps Codex
// and Anthropic on exactly the rows and the meter they had before. One metered
// model is still a payload that carries them: the gate answers "does this
// provider report allowances", never "are there enough rows to sort", because
// a single allowance read as "no allowances" sent the bar back to whichever
// model the payload listed first.
export function allowanceGroupsSupported(limits: readonly UsageLimit[]): boolean {
	return limits.length > 0 && limits.every((limit) => rawAllowance(limit) !== undefined);
}

function percentOf(limit: UsageLimit): number {
	return limit.windows[0]?.usedPercent ?? 0;
}

const GROUP_SUFFIX = " total";

// A group is an allowance share, never an average of shares: Σused / Σbudget.
// It carries no reset, because its members close their own billing period on
// their own date, and a single reset would be a lie.
function allowanceTotal(name: string, limits: readonly UsageLimit[]): UsageLimit | undefined {
	const windows = limits.map(rawAllowance).filter((window): window is UsageWindow => window !== undefined);
	if (windows.length === 0 || windows.length !== limits.length) return undefined;
	const used = windows.reduce((total, window) => total + (window.used ?? 0), 0);
	const budget = windows.reduce((total, window) => total + (window.budget ?? 0), 0);
	if (budget <= 0) return undefined;
	return {
		name,
		windows: [{ label: NAN_PERIOD_LABEL, usedPercent: (used / budget) * 100, windowSeconds: 0, resetAt: null }],
		limitReached: limits.some((limit) => limit.limitReached),
	};
}

// What the grouping is for now that the totals are gone: the order. A family
// stays together, families sort by what they consume and the members inside one
// follow the same rule, most used first. The account and family totals are the
// bar's fallback ladder only — they are never rows, because a total nobody can
// act on only costs space. Every row is a limit block, so nothing here
// introduces a shape the other providers do not already use.
export function groupUsageLimits(limits: readonly UsageLimit[]): UsageLimit[] {
	if (!allowanceGroupsSupported(limits)) return [...limits];
	const order: string[] = [];
	const members = new Map<string, UsageLimit[]>();
	for (const limit of limits) {
		const family = modelFamily(limit.name);
		if (!members.has(family)) {
			members.set(family, []);
			order.push(family);
		}
		members.get(family)?.push(limit);
	}
	return order
		.map((family) => {
			const sorted = [...(members.get(family) ?? [])].sort((a, b) => percentOf(b) - percentOf(a));
			const total = allowanceTotal(`${family}${GROUP_SUFFIX}`, sorted);
			return { percent: total?.windows[0]?.usedPercent ?? percentOf(sorted[0]), sorted };
		})
		.sort((a, b) => b.percent - a.percent)
		.flatMap((family) => family.sorted);
}

// The bar follows the model the session is using: exact allowance, then its
// family, then the account total, then the first limit (which is what every
// provider without raw numbers keeps using, and what a missing model keeps).
export function selectUsageLimit(usage: ProviderUsage, activeModelId?: string): UsageLimit | undefined {
	if (!activeModelId) return usage.limits[0];
	const exact = usage.limits.find((limit) => limit.name === activeModelId);
	if (exact) return exact;
	if (allowanceGroupsSupported(usage.limits)) {
		const family = modelFamily(activeModelId);
		const members = usage.limits.filter((limit) => modelFamily(limit.name) === family);
		// The family rung is about the name of the meter, not about printing a row,
		// so a single member counts: its family is a closer statement of what the
		// session is drawing from than the whole account.
		if (members.length > 0) {
			const total = allowanceTotal(`${family}${GROUP_SUFFIX}`, members);
			if (total) return total;
		}
		const account = allowanceTotal(`${usage.provider}${GROUP_SUFFIX}`, usage.limits);
		if (account) return account;
	}
	return usage.limits[0];
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

export function renderUsageBar(usage: ProviderUsage, theme: UsageTheme, activeModelId?: string): string | undefined {
	const main = selectUsageLimit(usage, activeModelId);
	const [first, ...rest] = main?.windows ?? [];
	if (!first) return undefined;
	// An unlabeled window prints as the name, the meter and the percentage.
	const head = [theme.fg(ROLE.LABEL, main.name), ...(first.label.length === 0 ? [] : [theme.fg(ROLE.LABEL, first.label)]), paintMeter(first.usedPercent, 8, theme), theme.fg(ROLE.PERCENT, `${Math.round(first.usedPercent)}%`)].join(" ");
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
		// One row per window: the limit name, its meter, its percentage and the reset
		// that window reports, all on one line. A window without its own label (the
		// model's allowance) is named by its limit alone, and one without a reset ends
		// at its percentage, never on a dangling separator.
		const rows = groupUsageLimits(usage.limits).flatMap((limit) =>
			limit.windows.map((window) => ({ name: [limit.name, window.label].filter((part) => part.length > 0).join(" "), window })),
		);
		const nameWidth = rows.reduce((widest, row) => Math.max(widest, row.name.length), 0);
		for (const row of rows) {
			const percent = `${Math.round(row.window.usedPercent)}%`.padStart(4);
			const reset = formatReset(row.window.resetAt, now);
			const tail = reset.length > 0 ? ` ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, reset)}` : "";
			lines.push(`  ${theme.fg(ROLE.LABEL, row.name.padEnd(nameWidth))} ${paintMeter(row.window.usedPercent, PANEL_METER_CELLS, theme)} ${theme.fg(ROLE.PERCENT, percent)}${tail}`);
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
