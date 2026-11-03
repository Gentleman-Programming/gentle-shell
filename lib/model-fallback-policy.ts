import { TERMINAL_ERROR_CATEGORY, type TerminalErrorCategory } from "./agents-protocol.ts";
import type { FallbackChain } from "./model-fallback-store.ts";
import type { ThinkingLevel } from "./model-routing-authority.ts";

// When a run moves to its next model, and which one. A terminal error only
// reaches us after Pi spent its own retries on the same model, so the error
// category alone decides: limits and unusable credentials move on, transient
// provider trouble moves on (Pi already retried), and request problems never
// do, since another model would fail the same way.

const FALL_BACK = new Set<TerminalErrorCategory>([
	TERMINAL_ERROR_CATEGORY.QUOTA,
	TERMINAL_ERROR_CATEGORY.AUTH,
	TERMINAL_ERROR_CATEGORY.RATE_LIMIT,
	TERMINAL_ERROR_CATEGORY.PROVIDER_UNAVAILABLE,
	TERMINAL_ERROR_CATEGORY.TIMEOUT,
	TERMINAL_ERROR_CATEGORY.NETWORK,
]);
const EXHAUSTED = new Set<TerminalErrorCategory>([TERMINAL_ERROR_CATEGORY.QUOTA, TERMINAL_ERROR_CATEGORY.AUTH]);

/** How long a failed model is skipped by every agent of the process. */
export const COOLDOWN_MS = { exhausted: 30 * 60_000, transient: 2 * 60_000 } as const;

export function shouldFallBack(category: TerminalErrorCategory | undefined): boolean {
	return category !== undefined && FALL_BACK.has(category);
}

const providerOf = (model: string) => (model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined);

export class ModelCooldown {
	private readonly until = new Map<string, number>();
	private readonly why = new Map<string, TerminalErrorCategory>();
	/** Providers whose subscription window is full, until it resets. */
	private readonly providers = new Map<string, number>();
	markProvider(provider: string, until: number): void {
		this.providers.set(provider, until);
	}
	clearProvider(provider: string): void {
		this.providers.delete(provider);
	}
	private providerWaits(model: string, now: number): boolean {
		const provider = providerOf(model);
		const until = provider === undefined ? undefined : this.providers.get(provider);
		if (until === undefined) return false;
		if (now < until) return true;
		this.providers.delete(provider!);
		return false;
	}
	mark(model: string, category: TerminalErrorCategory, now: number): void {
		if (!shouldFallBack(category)) return;
		const until = now + (EXHAUSTED.has(category) ? COOLDOWN_MS.exhausted : COOLDOWN_MS.transient);
		if (until >= (this.until.get(model) ?? 0)) this.why.set(model, category);
		this.until.set(model, Math.max(this.until.get(model) ?? 0, until));
	}
	/** A model whose own usage limit is spent waits until that limit resets. */
	markModelUntil(model: string, until: number): void {
		if (until <= (this.until.get(model) ?? 0)) return;
		this.until.set(model, until);
		this.why.set(model, TERMINAL_ERROR_CATEGORY.QUOTA);
	}
	/** Why a model is cooling down, while it is. */
	reason(model: string, now: number): TerminalErrorCategory | undefined {
		if (this.available(model, now)) return undefined;
		return this.why.get(model) ?? TERMINAL_ERROR_CATEGORY.QUOTA;
	}
	available(model: string, now: number): boolean {
		if (this.providerWaits(model, now)) return false;
		const until = this.until.get(model);
		if (until === undefined) return true;
		if (now < until) return false;
		this.until.delete(model);
		this.why.delete(model);
		return true;
	}
}

type UsageLike = {
	provider: string;
	limits: ReadonlyArray<{ name?: string; limitReached: boolean; windows: ReadonlyArray<{ label?: string; windowSeconds?: number; usedPercent: number; resetAt: number | null }> }>;
};

/**
 * Mirrors a /gentle:usage reading into the cooldown. A spent limit named
 * like a model id (NaN reports one limit per model) makes only
 * `provider/name` wait until it resets; names that are not model ids, such
 * as Codex's `codex` and `codex_spark`, cool nothing on their own. The whole
 * provider waits only when every limit is spent, until the earliest reset;
 * a reading with room releases it. A full window whose reset already passed
 * is a stale reading and blocks nothing; a spent limit with no reset time at
 * all waits the usual exhausted time. A model's own failures stay.
 */
export function syncUsageCooldown(usage: UsageLike, cooldown: ModelCooldown, now: number): void {
	const spentUntil = (limit: UsageLike["limits"][number]): number | undefined => {
		const full = limit.windows.filter((window) => limit.limitReached || window.usedPercent >= 100);
		if (!limit.limitReached && full.length === 0) return undefined;
		const resets = full.map((window) => window.resetAt).filter((reset): reset is number => typeof reset === "number");
		if (resets.length === 0) return now + COOLDOWN_MS.exhausted;
		const future = resets.filter((reset) => reset > now);
		return future.length ? Math.min(...future) : undefined;
	};
	const spent = usage.limits.map(spentUntil);
	const all = spent.length > 0 && spent.every((until) => until !== undefined);
	if (all) cooldown.markProvider(usage.provider, Math.min(...(spent as number[])));
	else cooldown.clearProvider(usage.provider);
	usage.limits.forEach((limit, index) => {
		const until = spent[index];
		if (until !== undefined && limit.name && SAFE_MODEL_NAME.test(limit.name)) cooldown.markModelUntil(`${usage.provider}/${limit.name}`, until);
	});
}

const SAFE_MODEL_NAME = /^[A-Za-z0-9._~:@+%-]+$/;

const SHARED = Symbol.for("gentle-pi.model-fallback.cooldown");
/** One registry per process: the orchestrator and the agents runner share what ran out. */
export function sharedCooldown(): ModelCooldown {
	const host = globalThis as unknown as Record<symbol, ModelCooldown | undefined>;
	return (host[SHARED] ??= new ModelCooldown());
}

export type ModelPick = { model: string | undefined; thinking?: ThinkingLevel; fallback: boolean };

/**
 * The model a run should use: the primary while it is usable and untried,
 * else the first chain step neither tried in this run nor cooling down.
 * Undefined when nothing is left. An undefined primary means "inherit".
 */
export function pickModel(primary: string | undefined, chain: FallbackChain, state: { cooldown: ModelCooldown; now: number; tried?: ReadonlySet<string> }): ModelPick | undefined {
	const usable = (model: string) => !state.tried?.has(model) && state.cooldown.available(model, state.now);
	if (primary === undefined ? !state.tried?.size : usable(primary)) return { model: primary, fallback: false };
	for (const step of chain) {
		if (step.model === primary || !usable(step.model)) continue;
		return step.thinking ? { model: step.model, thinking: step.thinking, fallback: true } : { model: step.model, fallback: true };
	}
	return undefined;
}
