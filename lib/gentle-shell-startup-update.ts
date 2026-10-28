import type { ParsedLauncherArgs } from "./gentle-shell-launcher.ts";

export interface StartupUpdateOffer {
	current: string;
	latest: string;
	notesUrl: string;
}

export interface StartupUpdateCheckOptions {
	args: ParsedLauncherArgs;
	env: Record<string, string | undefined>;
	bundled: boolean;
	inputTTY: boolean;
	outputTTY: boolean;
}

export interface StartupUpdateLookupOptions {
	current: string;
	skipped?: string;
	lookup: (signal: AbortSignal) => Promise<string | undefined>;
	timeoutMs?: number;
	/** A recorded previous lookup. Fresh enough, it answers without the network. */
	cache?: StartupReleaseCache;
	/** Injected clock and budget for tests; defaults to now and one day. */
	nowMs?: number;
	ttlMs?: number;
	/** Called once with a live lookup's version; never for a fresh-cache answer or an unanswered lookup. */
	cacheWrite?: (latest: string) => void;
}

/** The launcher config records the last live lookup so the everyday launch stays off the network. */
export interface StartupReleaseCache {
	checkedAt: number;
	latest: string;
}

/** Reads the config's `startupReleaseCheck` key; anything malformed is no cache. */
export function parseStartupReleaseCache(value: unknown): StartupReleaseCache | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { checkedAt, latest } = value as { checkedAt?: unknown; latest?: unknown };
	const ms = typeof checkedAt === "number" ? checkedAt : typeof checkedAt === "string" ? Date.parse(checkedAt) : Number.NaN;
	if (!Number.isFinite(ms) || typeof latest !== "string" || latest === "") return undefined;
	return { checkedAt: ms, latest };
}

export const STARTUP_RELEASE_TTL_MS = 24 * 60 * 60 * 1000;

export function shouldCheckStartupUpdate({ args, env, bundled, inputTTY, outputTTY }: StartupUpdateCheckOptions): boolean {
	if (!bundled || !inputTTY || !outputTTY || args.command || args.piSubcommand || args.error || args.help || args.version || args.packageRoot !== undefined) {
		return false;
	}
	if (env.GENTLE_PI_AGENTS_CHILD || env.PI_OFFLINE || env.GENTLE_SHELL_SKIP_STARTUP_UPDATE) {
		return false;
	}

	// An allowlist keeps new command modes from accidentally showing a prompt.
	for (let i = 0; i < args.passthrough.length; i += 1) {
		const token = args.passthrough[i];
		if (token === "--continue" || token === "-c") continue;
		if (token.startsWith("--resume=") && token.length > "--resume=".length) continue;
		if (token === "--resume" || token === "-r") {
			const next = args.passthrough[i + 1];
			if (next !== undefined && !next.startsWith("-")) i += 1;
			continue;
		}
		return false;
	}
	return true;
}

function stableParts(version: string): string[] | undefined {
	// No leading zeros, prefixes, whitespace, prereleases or build metadata.
	const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version);
	return match && match[0] === version ? match.slice(1) : undefined;
}

function isNewer(latest: string[], current: string[]): boolean {
	for (let i = 0; i < 3; i += 1) {
		if (latest[i] === current[i]) continue;
		// Decimal string comparison avoids rounding even for arbitrarily large parts.
		return latest[i].length !== current[i].length
			? latest[i].length > current[i].length
			: latest[i] > current[i];
	}
	return false;
}

function offerFor(current: string, latest: string | undefined, skipped: string | undefined): StartupUpdateOffer | undefined {
	const currentParts = stableParts(current);
	if (!currentParts) return undefined;
	if (latest === undefined || latest === skipped) return undefined;
	const latestParts = stableParts(latest);
	if (!latestParts || !isNewer(latestParts, currentParts)) return undefined;
	return {
		current,
		latest,
		notesUrl: `https://github.com/Gentleman-Programming/gentle-shell/releases/tag/v${latest}`,
	};
}

// A malformed cached latest is never trusted — it must not suppress the
// network check for a whole TTL window — so it counts as no cache at all.
function usableCache(cache: StartupReleaseCache | undefined, ttlMs: number, nowMs: number): StartupReleaseCache | undefined {
	if (cache === undefined) return undefined;
	if (!Number.isFinite(cache.checkedAt) || typeof cache.latest !== "string" || cache.latest === "" || stableParts(cache.latest) === undefined) return undefined;
	return nowMs - cache.checkedAt < ttlMs ? cache : undefined;
}

export async function findStartupUpdate({ current, skipped, lookup, timeoutMs = 1500, cache, nowMs = Date.now(), ttlMs = STARTUP_RELEASE_TTL_MS, cacheWrite }: StartupUpdateLookupOptions): Promise<StartupUpdateOffer | undefined> {
	const cached = usableCache(cache, ttlMs, nowMs);
	if (cached !== undefined) return offerFor(current, cached.latest, skipped);
	const controller = new AbortController();
	const deadline = Number.isFinite(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 2_147_483_647 ? timeoutMs : 1500;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => {
				resolve(undefined);
				controller.abort();
			}, deadline);
		});
		// The race bounds startup even if the injected lookup ignores cancellation.
		const latest = await Promise.race([lookup(controller.signal), timeout]);
		// Only a real answer is worth a day's trust: a timeout or rejection must
		// not suppress tomorrow's check.
		if (typeof latest === "string") cacheWrite?.(latest);
		return offerFor(current, latest, skipped);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

// Mirrors omitStartupVersion: preserves every other config key, fails loudly on
// an invalid config, and records the lookup's answer with an injected clock.
export function writeStartupReleaseCache(read: () => string | undefined, write: (text: string) => void, version: string, nowMs = Date.now()): void {
	const text = read();
	const config = text === undefined ? {} : JSON.parse(text);
	if (config === null || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid launcher config");
	const cache: StartupReleaseCache = { checkedAt: nowMs, latest: version };
	const serialized = JSON.stringify({ ...config, startupReleaseCheck: { checkedAt: new Date(cache.checkedAt).toISOString(), latest: cache.latest } }, null, 2);
	write(`${serialized}\n`);
}
