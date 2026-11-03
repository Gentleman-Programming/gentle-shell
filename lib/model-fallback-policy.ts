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
 * Mirrors a /gentle:usage reading into the cooldown: a reached limit or a
 * full window makes every model of the provider wait until the earliest of
 * those windows resets (the usual exhausted wait when no reset is known);
 * a reading with room releases the provider. A model's own failures stay.
 */
export function syncUsageCooldown(usage: UsageLike, cooldown: ModelCooldown, now: number): void {
	const full = usage.limits.flatMap((limit) => limit.windows.filter((window) => limit.limitReached || window.usedPercent >= 100));
	const exhausted = usage.limits.some((limit) => limit.limitReached) || full.length > 0;
	if (!exhausted) return cooldown.clearProvider(usage.provider);
	const resets = full.map((window) => window.resetAt).filter((reset): reset is number => typeof reset === "number" && reset > now);
	cooldown.markProvider(usage.provider, resets.length ? Math.min(...resets) : now + COOLDOWN_MS.exhausted);
}

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
