import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

// Harness roadmap R1: the parent-context backstop was a fixed "~150k tokens" in
// prompt text, so the model had to estimate its own context. The runtime now
// measures it with one threshold for every model: carried context is paid on
// every remaining turn whatever the provider (absolute cap), and quality and
// headroom depend on how full the window is (fraction of the window).

export const CONTEXT_BACKSTOP_TOKENS = 150_000;
// Bench gate (harness roadmap T12): on the wide five-feature task, delegating at ~15% of a 272k window cost about
// 20-40% less and ran ~30% faster than never reaching the backstop, while small tasks never reached it.
export const CONTEXT_BACKSTOP_FRACTION = 0.15;
export const CONTEXT_BACKSTOP_TOKENS_ENV = "GENTLE_PI_CONTEXT_BACKSTOP_TOKENS";
export const CONTEXT_BACKSTOP_FRACTION_ENV = "GENTLE_PI_CONTEXT_BACKSTOP_FRACTION";
// Sampling window for the measured context (see createThrottledContextMeasure).
export const CONTEXT_BACKSTOP_MEASURE_MS_ENV = "GENTLE_PI_CONTEXT_BACKSTOP_MEASURE_MS";
export const CONTEXT_BACKSTOP_MEASURE_MS_DEFAULT = 5_000;

/** The part of Pi's `ctx.getContextUsage()` the backstop reads; null tokens are unknown (e.g. right after compaction). */
export interface MeasuredContext {
	tokens: number | null | undefined;
	contextWindow?: number | null;
}

type Env = Readonly<Record<string, string | undefined>>;

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function envNumber(env: Env, name: string, valid: (value: number) => boolean, fallback: number): number {
	const raw = env[name]?.trim();
	const value = raw ? Number(raw) : Number.NaN;
	return valid(value) ? value : fallback;
}

/** min(absolute cap, fraction x context window); an unknown window leaves the cap alone. Never 0: an empty context is not past it. */
export function contextBackstopThreshold(contextWindow: number | null | undefined, env: Env = process.env): number {
	const cap = envNumber(env, CONTEXT_BACKSTOP_TOKENS_ENV, positive, CONTEXT_BACKSTOP_TOKENS);
	const fraction = envNumber(env, CONTEXT_BACKSTOP_FRACTION_ENV, (value) => positive(value) && value <= 1, CONTEXT_BACKSTOP_FRACTION);
	return positive(contextWindow) ? Math.min(cap, Math.max(1, Math.floor(fraction * contextWindow))) : cap;
}

/** Unknown tokens never count as reached. */
export function contextBackstopReached(usage: MeasuredContext | undefined, env: Env = process.env): boolean {
	return typeof usage?.tokens === "number" && usage.tokens >= contextBackstopThreshold(usage.contextWindow, env);
}

const count = (value: number) => Math.round(value).toLocaleString("en-US");

function contextBackstopNotice(tokens: number, contextWindow: number | null | undefined, threshold: number): string {
	const share = positive(contextWindow) ? ` (${Math.round((tokens / contextWindow) * 100)}% of the ${count(contextWindow)}-token context window)` : "";
	return `Context backstop: the parent context measures ${count(tokens)} tokens${share}, at or past the ${count(threshold)}-token backstop: delegate the next bounded unit that needs several steps (its reads, edits, and checks) with a short handoff, while single small edits and state checks stay inline.`;
}

/**
 * One notice per crossing for each session: the first measurement at or past the backstop returns it, and a
 * measurement below the backstop re-arms it (for example after compaction). Unknown tokens change nothing.
 */
export function createContextBackstopSignal(env: Env = process.env): (session: unknown, usage: MeasuredContext | undefined) => string | undefined {
	const notified = new Set<unknown>();
	return (session, usage) => {
		if (typeof usage?.tokens !== "number") return undefined;
		const threshold = contextBackstopThreshold(usage.contextWindow, env);
		if (usage.tokens < threshold) {
			notified.delete(session);
			return undefined;
		}
		if (notified.has(session)) return undefined;
		notified.add(session);
		return contextBackstopNotice(usage.tokens, usage.contextWindow, threshold);
	};
}

export interface ThrottledContextMeasureOptions {
	now?: () => number;
	/** Injected window in ms; 0 samples on every call (tests). Omitted resolves the env, then the 5 s default. */
	minIntervalMs?: number;
	env?: Env;
}

/**
 * One measured context per session per window. `ctx.getContextUsage()` rebuilds the whole session projection
 * (O(session) per call), so the backstop samples it instead of paying that on every tool result. The first
 * sample of a session is immediate — a resumed session already past the backstop must not wait a window — and
 * every call inside the window skips the measurement entirely, so the backstop sees `undefined` (unknown
 * tokens change nothing). A throwing measure returns `undefined`; the failed attempt still consumed its
 * window, so a persistently failing host cannot turn every tool result into a retry.
 */
export function createThrottledContextMeasure(options: ThrottledContextMeasureOptions = {}): (session: unknown, measure: () => MeasuredContext | undefined) => MeasuredContext | undefined {
	const now = options.now ?? (() => Date.now());
	const env = options.env ?? process.env;
	const minIntervalMs = options.minIntervalMs ?? envNumber(env, CONTEXT_BACKSTOP_MEASURE_MS_ENV, positive, CONTEXT_BACKSTOP_MEASURE_MS_DEFAULT);
	const lastMeasuredAt = new Map<unknown, number>();
	return (session, measure) => {
		const previous = lastMeasuredAt.get(session);
		const at = now();
		if (previous !== undefined && at - previous < minIntervalMs) return undefined;
		lastMeasuredAt.set(session, at);
		try {
			return measure();
		} catch {
			return undefined;
		}
	};
}

/** Appends the notice after the (possibly already patched) tool output, keeping structured content and the error flag. */
export function appendContextBackstopNotice(
	event: Pick<ToolResultEvent, "content" | "structuredContent">,
	patch: ToolResultEventResult | undefined,
	notice: string,
): ToolResultEventResult {
	const structuredContent = patch?.structuredContent ?? event.structuredContent;
	return {
		...patch,
		content: [...(patch?.content ?? event.content), { type: "text", text: `\n${notice}` }],
		...(structuredContent === undefined ? {} : { structuredContent }),
	};
}
