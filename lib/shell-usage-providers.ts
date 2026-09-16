import type { ProviderUsage, UsageLimit, UsageWindow } from "./shell-usage.ts";

// Optional subscription providers expose their quota through different APIs.
// Keep those wire formats at this boundary and feed only Gentle Shell's small,
// account-free ProviderUsage model to the renderer and in-memory store.

export const OPENCODE_GO_PROVIDER = "opencode-go";
export const ANTIGRAVITY_PROVIDER = "antigravity";
export const COMMAND_CODE_PROVIDER = "commandcode";

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const ANTIGRAVITY_QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";
export const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
] as const;
export const COMMAND_CODE_API_URL = "https://api.commandcode.ai";

const FIVE_HOURS = 18_000;
const WEEK = 604_800;
const REQUEST_TIMEOUT_MS = 15_000;
const ANTIGRAVITY_USER_AGENT = "antigravity/cli/1.1.23 (aidev_client; os_type=linux; arch=amd64; cl=974125021; auth_method=consumer)";

type RecordValue = Record<string, unknown>;

/** Narrow an untrusted JSON value to a plain record. */
function record(value: unknown): RecordValue | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;
}

/** Accept only finite JSON numbers. */
function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Accept only finite non-negative JSON numbers. */
function nonnegative(value: unknown): number | undefined {
	const number = finite(value);
	return number !== undefined && number >= 0 ? number : undefined;
}

/** Accept non-empty strings without coercing account data. */
function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Bound and stabilize a percentage for the shared usage model. */
function clampPercent(value: number): number {
	return Math.round(Math.max(0, Math.min(100, value)) * 1000) / 1000;
}

/** Parse Unix timestamps or strict RFC3339 timestamps into milliseconds. */
function timestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value >= 1e12 ? value : value * 1000;
	}
	if (typeof value !== "string" || value.length === 0) return null;
	if (/^\d+$/.test(value)) {
		const numeric = Number(value);
		return Number.isFinite(numeric) ? (numeric >= 1e12 ? numeric : numeric * 1000) : null;
	}
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
	if (!match) return null;
	const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , offsetHourRaw = "0", offsetMinuteRaw = "0"] = match;
	const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, offsetHourRaw, offsetMinuteRaw].map(Number);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return null;
	return parsed;
}

/** Translate provider window labels to the canonical window duration. */
function windowSeconds(value: unknown, label: string): number {
	const raw = typeof value === "string" ? value : "";
	const source = `${raw} ${label}`;
	if (/(?:five|5)\s*(?:hour|h)\b/i.test(source)) return FIVE_HOURS;
	if (/\b(?:weekly|week|7d|seven\s*day)\b/i.test(source)) return WEEK;
	if (/\bmonthly|month\b/i.test(source)) return 30 * 86_400;
	return 0;
}

/** Turn a provider plan id into a compact human label. */
function responsePlan(value: unknown): string | undefined {
	return text(value)?.replace(/[_-]+/g, " ");
}

/** Resolve a provider-scoped credential without retaining its metadata. */
export function credentialToken(provider: string, credential: string | undefined): string | undefined {
	const value = credential?.trim();
	if (!value) return undefined;
	if (provider !== ANTIGRAVITY_PROVIDER) {
		if (/^\$?(?:COMMAND_?CODE|OPENCODE_GO)_API_KEY$/.test(value)) return undefined;
		return value;
	}
	try {
		const parsed = record(JSON.parse(value));
		return text(parsed?.token) ?? text(parsed?.access);
	} catch {
		return undefined;
	}
}

/** Parse OpenCode Go's rolling, weekly, and monthly utilization response. */
export function parseOpenCodeGoUsage(payload: unknown, now: number): ProviderUsage | undefined {
	const usage = record(record(payload)?.usage);
	if (!usage) return undefined;
	const windows: UsageWindow[] = [];
	for (const [key, label, seconds] of [
		["rolling", "5h", FIVE_HOURS],
		["weekly", "week", WEEK],
		["monthly", "month", 30 * 86_400],
	] as const) {
		const raw = record(usage[key]);
		const percent = finite(raw?.percent);
		if (raw?.status !== "ok" || percent === undefined) continue;
		windows.push({
			label,
			usedPercent: clampPercent(percent),
			windowSeconds: seconds,
			resetAt: timestamp(raw.resetAt ?? raw.reset_at ?? raw.resetTime),
		});
	}
	if (windows.length === 0) return undefined;
	return { provider: OPENCODE_GO_PROVIDER, plan: "Go", limits: [{ name: "opencode", windows, limitReached: windows[0]!.usedPercent >= 100 }], fetchedAt: now };
}

/** Parse Antigravity's shared quota groups into used percentages. */
export function parseAntigravityUsage(payload: unknown, now: number): ProviderUsage | undefined {
	const groups = record(payload)?.groups;
	if (!Array.isArray(groups)) return undefined;
	const limits: UsageLimit[] = [];
	for (const rawGroup of groups) {
		const group = record(rawGroup);
		if (!group || !Array.isArray(group.buckets)) continue;
		const windows: UsageWindow[] = [];
		for (const rawBucket of group.buckets) {
			const bucket = record(rawBucket);
			const remaining = finite(bucket?.remainingFraction);
			if (!bucket || remaining === undefined) continue;
			const name = text(bucket.displayName) ?? text(bucket.bucketId) ?? "quota";
			const seconds = windowSeconds(bucket.window, name);
			windows.push({
				label: seconds === FIVE_HOURS ? "5h" : seconds === WEEK ? "week" : name,
				usedPercent: clampPercent((1 - remaining) * 100),
				windowSeconds: seconds,
				resetAt: timestamp(bucket.resetTime),
			});
		}
		if (windows.length === 0) continue;
		windows.sort((left, right) => left.windowSeconds - right.windowSeconds);
		limits.push({
			name: text(group.displayName) ?? "antigravity",
			windows,
			limitReached: windows.some((window) => window.usedPercent >= 100),
		});
	}
	if (limits.length === 0) return undefined;
	return { provider: ANTIGRAVITY_PROVIDER, plan: undefined, limits, fetchedAt: now };
}

/** Parse Command Code windows and billing credits without account identity. */
export function parseCommandCodeUsage(
	creditsPayload: unknown,
	subscriptionPayload: unknown,
	summaryPayload: unknown,
	now: number,
): ProviderUsage | undefined {
	const creditsRoot = record(creditsPayload);
	const windowLimits = record(creditsRoot?.windowLimits);
	const windows: UsageWindow[] = [];
	for (const [key, label, seconds] of [
		["fiveHour", "5h", FIVE_HOURS],
		["weekly", "week", WEEK],
	] as const) {
		const raw = record(windowLimits?.[key]);
		const used = nonnegative(raw?.used);
		const cap = nonnegative(raw?.cap);
		if (used === undefined || cap === undefined || cap <= 0) continue;
		windows.push({ label, usedPercent: clampPercent(used / cap * 100), windowSeconds: seconds, resetAt: timestamp(raw.resetAt) });
	}
	const limits: UsageLimit[] = [];
	if (windows.length > 0) {
		limits.push({ name: "command code", windows, limitReached: windows.some((window) => window.usedPercent >= 100) });
	}

	const creditSources = record(creditsRoot?.credits);
	const remaining = (nonnegative(creditSources?.monthlyCredits) ?? 0)
		+ (nonnegative(creditSources?.purchasedCredits) ?? 0)
		+ (nonnegative(creditSources?.freeCredits) ?? 0);
	const spent = nonnegative(record(summaryPayload)?.totalCost);
	const subscription = record(record(subscriptionPayload)?.data);
	if (spent !== undefined && remaining + spent > 0) {
		const resetAt = timestamp(subscription?.currentPeriodEnd);
		const periodStart = timestamp(subscription?.currentPeriodStart);
		const seconds = resetAt !== null && periodStart !== null ? Math.max(0, Math.round((resetAt - periodStart) / 1000)) : 0;
		limits.push({
			name: "credits",
			windows: [{ label: "billing", usedPercent: clampPercent(spent / (remaining + spent) * 100), windowSeconds: seconds, resetAt }],
			limitReached: remaining <= 0,
		});
	}
	if (limits.length === 0) return undefined;
	return {
		provider: COMMAND_CODE_PROVIDER,
		plan: responsePlan(subscription?.planId),
		limits,
		fetchedAt: now,
	};
}

/** Read an OK JSON response without allowing parse failures to escape. */
async function json(response: Response): Promise<unknown | undefined> {
	if (!response.ok) return undefined;
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

/** Fetch one OpenCode Go usage snapshot. */
export async function fetchOpenCodeGoUsage(token: string, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> {
	try {
		const payload = await json(await fetchFn(OPENCODE_GO_USAGE_URL, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		}));
		return parseOpenCodeGoUsage(payload, now);
	} catch {
		return undefined;
	}
}

/** Fetch one Antigravity snapshot using the provider's endpoint order. */
export async function fetchAntigravityUsage(token: string, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> {
	for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
		try {
			const payload = await json(await fetchFn(`${endpoint}${ANTIGRAVITY_QUOTA_PATH}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					Accept: "application/json",
					"User-Agent": ANTIGRAVITY_USER_AGENT,
				},
				body: "{}",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}));
			const usage = parseAntigravityUsage(payload, now);
			if (usage) return usage;
		} catch {
			// pi-antigravity uses the same ordered fallback endpoints.
		}
	}
	return undefined;
}

/** Build Command Code's optional organization query. */
function query(orgId: unknown): string {
	const id = text(orgId);
	return id ? `?orgId=${encodeURIComponent(id)}` : "";
}

/** Fetch one Command Code quota snapshot through its dependent API calls. */
export async function fetchCommandCodeUsage(
	token: string,
	fetchFn: typeof fetch,
	now: number,
	baseUrl = COMMAND_CODE_API_URL,
	extraHeaders: Record<string, string> = {},
): Promise<ProviderUsage | undefined> {
	try {
		const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", ...extraHeaders };
		const get = (path: string) => fetchFn(`${baseUrl}${path}`, { headers, signal }).then(json);
		const whoami = record(await get("/alpha/whoami"));
		if (!whoami) return undefined;
		const org = query(record(whoami.org)?.id);
		const [credits, subscription] = await Promise.all([
			get(`/alpha/billing/credits${org}`),
			get(`/alpha/billing/subscriptions${org}`),
		]);
		if (!credits) return undefined;
		const periodStart = text(record(record(subscription)?.data)?.currentPeriodStart);
		const summaryQuery = `${org ? `${org}&` : "?"}${periodStart ? `since=${encodeURIComponent(periodStart)}` : ""}`;
		const summary = await get(`/alpha/usage/summary${summaryQuery}`);
		return parseCommandCodeUsage(credits, subscription, summary, now);
	} catch {
		return undefined;
	}
}

/** Dispatch a one-off fetch for a supported optional provider. */
export async function fetchOptionalProviderUsage(
	provider: string,
	credential: string | undefined,
	fetchFn: typeof fetch,
	now: number,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderUsage | undefined> {
	const token = credentialToken(provider, credential);
	if (!token) return undefined;
	if (provider === OPENCODE_GO_PROVIDER) return fetchOpenCodeGoUsage(token, fetchFn, now);
	if (provider === ANTIGRAVITY_PROVIDER) return fetchAntigravityUsage(token, fetchFn, now);
	if (provider === COMMAND_CODE_PROVIDER) {
		const base = (env.COMMANDCODE_API_BASE ?? COMMAND_CODE_API_URL).replace(/\/provider\/v1\/?$/, "");
		const headers = env.CMD_ZDR === "1" || env.COMMANDCODE_ZDR === "1" ? { "x-cmd-zdr": "1" } : {};
		return fetchCommandCodeUsage(token, fetchFn, now, base, headers);
	}
	return undefined;
}
