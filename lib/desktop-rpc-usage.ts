// Gentle Desktop subscription-usage slice: the pure contract shared by the
// Desktop bridge (`lib/desktop-usage-service.ts`) and the owner seam inside
// `extensions/gentle-shell.ts`.
//
// Nothing here touches the network, reads a key, or resolves auth. It only
// names the wire shapes, maps the owner's own recorded `ProviderUsage` into the
// safe Desktop projection, and derives the truthful `ok|pending|stale|failed|
// unavailable` status from the owner's state. The owner (UsageStore /
// UsageSourceRegistry / refreshUsage / after_provider_response closures) stays
// the single source of truth; this module is a projection, not a second store.

import {
	CODEX_PROVIDER,
	NAN_PROVIDER,
	SUPPORTED_USAGE_PROVIDERS,
	type ProviderUsage,
} from "./shell-usage.ts";

export const DESKTOP_USAGE_METHODS = ["get_subscription_usage", "refresh_subscription_usage"] as const;
export const DESKTOP_USAGE_EVENT = "rate_limit";
/** Advertised only because the owner seam records the snapshots this event carries. */
export const DESKTOP_USAGE_EVENTS = [DESKTOP_USAGE_EVENT] as const;

// The versioned owner-service discovery seam (the usage analogue of the YOLO
// `gentle:yolo:host-ui` adapter). The schema string guards the adapter against
// drift; the bridge ignores any responder whose shape does not match.
export const DESKTOP_USAGE_SERVICE_SCHEMA = "gentle-pi.desktop-usage-service/v1";
export const DESKTOP_USAGE_SERVICE_CHANNEL = "gentle:desktop:usage-service";

// The staleness window matches the owner's own 5-minute refresh throttle: a
// snapshot older than this for a refreshable provider is reported `stale` so a
// Desktop consumer can decide to refresh rather than trust an aging figure.
export const DESKTOP_USAGE_STALE_MS = 5 * 60_000;

export type DesktopUsageStatus = "ok" | "pending" | "stale" | "failed" | "unavailable";

/** The safe wire window: percentages, durations, resets, and — only for the
 * providers that already report them (NaN) — raw allowance numbers. Never an
 * account id, URL, token, key, or error. */
export interface DesktopUsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
	used?: number;
	budget?: number;
}

export interface DesktopUsageLimit {
	name: string;
	windows: DesktopUsageWindow[];
	limitReached: boolean;
}

/** One provider as `get_subscription_usage` / `refresh_subscription_usage`
 * projects it. `refresh` is present only on a refresh answer: `unsupported` for
 * a supported provider with no fetch endpoint (Anthropic), and `out_of_scope`
 * for a refreshable provider the current session scope does not target. */
export interface DesktopUsageEntry {
	provider: string;
	status: DesktopUsageStatus;
	fetchedAt?: number;
	plan?: string;
	limits?: DesktopUsageLimit[];
	refresh?: "unsupported" | "out_of_scope";
}

/** The owner's raw answer for one provider: which of the existing owner facts
 * describe it, plus its recorded snapshot when there is one. `outOfScope` marks
 * a refresh that the owner did not even attempt because the provider is outside
 * the current session scope. The snapshot is re-validated by the bridge before
 * it is ever projected. */
export interface DesktopUsageOwnerEntry {
	provider: string;
	supported: boolean;
	refreshable: boolean;
	failed: boolean;
	outOfScope?: boolean;
	snapshot?: ProviderUsage;
}

export interface DesktopUsageOwnerRead {
	providers: DesktopUsageOwnerEntry[];
}

/** A header-driven recording handed from the owner's after_provider_response to
 * a subscribed Desktop consumer: the already-parsed snapshot, never header text. */
export interface DesktopUsageRecordedSnapshot {
	provider: string;
	usage: ProviderUsage;
}

/** The owner-service adapter the bridge discovers. Every method is defensive:
 * after `dispose()` it answers empty/no-op rather than speaking into a replaced
 * session. */
export interface DesktopUsageService {
	schema: typeof DESKTOP_USAGE_SERVICE_SCHEMA;
	read(provider?: string): DesktopUsageOwnerRead;
	refresh(provider?: string): Promise<DesktopUsageOwnerRead>;
	/** Subscribe to header-driven recordings. The unsubscribe stops delivery. */
	observe(onSnapshot: (recorded: DesktopUsageRecordedSnapshot) => void): () => void;
	dispose(): void;
}

export const INVALID_USAGE_PARAMS = { code: "invalid_request", message: "Invalid subscription usage parameters" } as const;
export const USAGE_UNAVAILABLE = { code: "usage_unavailable", message: "Usage owner unavailable for this session" } as const;

/**
 * The five statuses, derived only from facts the owner already holds. A
 * present snapshot wins before failure: `failed` names a provider with no data
 * whose latest refresh settled empty, while a retained snapshot keeps `ok` (or
 * `stale` when old) and exposes its own age through `fetchedAt`. A header-only
 * provider (`refreshable: false`, Anthropic) never ages into `stale` — its
 * windows arrive with responses, not through a fetch cycle.
 */
export function desktopUsageStatus(input: {
	supported: boolean;
	refreshable: boolean;
	failed: boolean;
	fetchedAt: number | undefined;
	now: number;
	staleAfterMs?: number;
}): DesktopUsageStatus {
	const staleAfter = input.staleAfterMs ?? DESKTOP_USAGE_STALE_MS;
	if (input.fetchedAt !== undefined) {
		if (input.refreshable && input.now - input.fetchedAt > staleAfter) return "stale";
		return "ok";
	}
	if (!input.supported) return "unavailable";
	if (input.failed) return "failed";
	return "pending";
}

/** Built-in or registered source: the providers the owner can actually answer for. */
export function isSupportedUsageProvider(provider: string, hasSource: boolean): boolean {
	return (SUPPORTED_USAGE_PROVIDERS as readonly string[]).includes(provider) || hasSource;
}

/** Anthropic has no usage endpoint; its windows arrive only with responses. */
export function isRefreshableUsageProvider(provider: string, hasSource: boolean): boolean {
	return provider === CODEX_PROVIDER || provider === NAN_PROVIDER || hasSource;
}

/**
 * The wire projection of one owner snapshot. It rebuilds every field from the
 * already-validated `ProviderUsage` and drops `scope` (an internal panel
 * marker) and anything not named here, so a foreign or stale object can never
 * smuggle an account id, URL, or key into the Desktop payload. `plan` is kept
 * verbatim only when the owner already recorded it — never enriched from auth.
 */
export function projectUsageEntry(
	provider: string,
	status: DesktopUsageStatus,
	snapshot: ProviderUsage | undefined,
	options: { refresh?: "unsupported" | "out_of_scope" } = {},
): DesktopUsageEntry {
	const entry: DesktopUsageEntry = { provider, status };
	if (snapshot) {
		entry.fetchedAt = snapshot.fetchedAt;
		if (snapshot.plan !== undefined) entry.plan = snapshot.plan;
		entry.limits = snapshot.limits.map((limit) => ({
			name: limit.name,
			limitReached: limit.limitReached,
			windows: limit.windows.map((window) => {
				const projected: DesktopUsageWindow = {
					label: window.label,
					usedPercent: window.usedPercent,
					windowSeconds: window.windowSeconds,
					resetAt: window.resetAt,
				};
				if (window.used !== undefined) projected.used = window.used;
				if (window.budget !== undefined) projected.budget = window.budget;
				return projected;
			}),
		}));
	}
	if (options.refresh !== undefined) entry.refresh = options.refresh;
	return entry;
}

/**
 * `get_subscription_usage` / `refresh_subscription_usage` params: either empty
 * (the whole scope) or exactly `{ provider: string }`. Anything else is a typed
 * `invalid_request` before any owner work happens.
 */
export function parseUsageProviderParam(
	params: Record<string, unknown>,
): { provider: string | undefined } | { error: { code: string; message: string } } {
	const keys = Object.keys(params);
	if (keys.length === 0) return { provider: undefined };
	if (keys.length !== 1 || keys[0] !== "provider" || typeof params.provider !== "string" || params.provider.length === 0) {
		return { error: INVALID_USAGE_PARAMS };
	}
	return { provider: params.provider };
}

/** Defensive read of one owner entry: the adapter crosses the event bus, so its
 * shape is never trusted beyond the fields the bridge actually needs. */
export function parseDesktopUsageOwnerEntry(value: unknown): DesktopUsageOwnerEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.provider !== "string") return undefined;
	if (typeof raw.supported !== "boolean") return undefined;
	if (typeof raw.refreshable !== "boolean") return undefined;
	if (typeof raw.failed !== "boolean") return undefined;
	const entry: DesktopUsageOwnerEntry = {
		provider: raw.provider,
		supported: raw.supported,
		refreshable: raw.refreshable,
		failed: raw.failed,
	};
	if (raw.outOfScope === true) entry.outOfScope = true;
	if (raw.snapshot !== undefined) entry.snapshot = raw.snapshot as ProviderUsage;
	return entry;
}

/** The rate_limit event payload: the changed snapshots plus which owner path produced them. */
export interface DesktopRateLimitEvent {
	source: "refresh" | "response";
	snapshots: DesktopUsageEntry[];
}

/** True only for the adapter-shaped object the discovery responder must return. */
export function isDesktopUsageServiceShape(value: unknown): value is DesktopUsageService {
	if (!value || typeof value !== "object") return false;
	const adapter = value as Partial<DesktopUsageService>;
	if (adapter.schema !== DESKTOP_USAGE_SERVICE_SCHEMA) return false;
	return [adapter.read, adapter.refresh, adapter.observe, adapter.dispose].every((fn) => typeof fn === "function");
}
