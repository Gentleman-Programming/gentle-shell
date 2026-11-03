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

export class ModelCooldown {
	private readonly until = new Map<string, number>();
	private readonly why = new Map<string, TerminalErrorCategory>();
	mark(model: string, category: TerminalErrorCategory, now: number): void {
		if (!shouldFallBack(category)) return;
		const until = now + (EXHAUSTED.has(category) ? COOLDOWN_MS.exhausted : COOLDOWN_MS.transient);
		if (until >= (this.until.get(model) ?? 0)) this.why.set(model, category);
		this.until.set(model, Math.max(this.until.get(model) ?? 0, until));
	}
	/** Why a model is cooling down, while it is. */
	reason(model: string, now: number): TerminalErrorCategory | undefined {
		return this.available(model, now) ? undefined : this.why.get(model);
	}
	available(model: string, now: number): boolean {
		const until = this.until.get(model);
		if (until === undefined) return true;
		if (now < until) return false;
		this.until.delete(model);
		this.why.delete(model);
		return true;
	}
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
