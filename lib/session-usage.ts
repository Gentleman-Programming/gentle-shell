// Canonical usage records for the session statistics module (epic #1, I1).
//
// Money is carried as integer nano-USD. Providers report cost with up to nine
// decimals (observed: 0.000344274), so `usd * 1e9` is exact, integer addition
// is exact, and a billing report never accumulates float drift. `float64`
// represents integers exactly up to 2^53, so the accumulated ceiling is about
// nine million USD per total — ample for a session, and the reason this is
// documented rather than enforced.
//
// The one fact this module exists to protect: "the provider reported $0" and
// "the provider reported nothing" are different states. Every ingestion site
// must preserve that difference instead of coercing absence to zero.

export const NANO_USD_SCALE = 1_000_000_000;

/** Where a usage record came from: the orchestrator session or a delegated child. */
export type UsageSource = "parent" | "subagent";

export type ReportedUsageCost = Readonly<{ state: "reported"; nanoUsd: number }>;
export type AbsentUsageCost = Readonly<{ state: "absent" }>;
export type UsageCost = ReportedUsageCost | AbsentUsageCost;

/** Exact integer nano-USD for a provider-reported USD amount. */
export function reportedCost(usd: number): ReportedUsageCost {
	return { state: "reported", nanoUsd: Math.round(usd * NANO_USD_SCALE) };
}

/** The provider reported no cost at all; it is not a reported zero. */
export const ABSENT_COST: AbsentUsageCost = { state: "absent" };

/** True when the provider reported this component's cost (a reported zero included). */
export function isReported(cost: UsageCost): cost is ReportedUsageCost {
	return cost.state === "reported";
}

/** The known USD amount: the reported value, or 0 when nothing was reported. */
export function costUsd(cost: UsageCost): number {
	return cost.state === "reported" ? cost.nanoUsd / NANO_USD_SCALE : 0;
}

/**
 * The single rule both ingestion sites share: a finite number is reported
 * (including an explicit 0); anything else is absent.
 */
export function reportedCostOrAbsent(value: unknown): UsageCost {
	return typeof value === "number" && Number.isFinite(value) ? reportedCost(value) : ABSENT_COST;
}

/** The six token counters carried by every usage record. Degrees of cache and reasoning are not additive; `total` is the provider's own total. */
export interface UsageTokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning: number;
	readonly total: number;
}

/**
 * The provider's per-component cost split, each component carrying its own
 * provenance. A billing report needs input/output/cache separately, and "the
 * provider reported this component" must stay distinguishable from "the
 * provider reported nothing" exactly as the total does.
 */
export interface UsageCostBreakdown {
	readonly input: UsageCost;
	readonly output: UsageCost;
	readonly cacheRead: UsageCost;
	readonly cacheWrite: UsageCost;
}

/**
 * The one canonical shape every statistics issue consumes. Parent and child
 * transcripts share this record shape; `taskId` is present only for a
 * delegated child.
 */
export interface SessionUsageRecord {
	readonly source: UsageSource;
	readonly taskId?: string;
	/** Epoch milliseconds of the source record. */
	readonly timestamp: number;
	readonly model: string;
	readonly provider: string;
	readonly effort?: string;
	readonly tokens: UsageTokens;
	readonly cost: UsageCost;
	/** Present when the source carries a per-component split; a transcript does. */
	readonly costBreakdown?: UsageCostBreakdown;
}

/**
 * An aggregated session cost: the exact sum of every reported component, plus
 * the provenance needed to render a partial total honestly. `complete` is
 * false as soon as one component was absent, and never returns to true.
 */
export interface SessionCostTotal {
	readonly nanoUsd: number;
	readonly complete: boolean;
	/** How many components reported no cost, for diagnostics and the `+` marker. */
	readonly absent: number;
}

export const EMPTY_SESSION_COST: SessionCostTotal = { nanoUsd: 0, complete: true, absent: 0 };

/** Mutable accumulator: one allocation, no per-component object churn on render paths. */
export class SessionCostAccumulator {
	private nanoUsd: number;
	private complete: boolean;
	private absent: number;

	constructor(base: SessionCostTotal = EMPTY_SESSION_COST) {
		this.nanoUsd = base.nanoUsd;
		this.complete = base.complete;
		this.absent = base.absent;
	}

	add(cost: UsageCost): this {
		if (cost.state === "reported") this.nanoUsd += cost.nanoUsd;
		else {
			this.complete = false;
			this.absent += 1;
		}
		return this;
	}

	total(): SessionCostTotal {
		return { nanoUsd: this.nanoUsd, complete: this.complete, absent: this.absent };
	}
}

/** Fold one usage component into an existing total, preserving provenance. */
export function addSessionCost(total: SessionCostTotal, cost: UsageCost): SessionCostTotal {
	return new SessionCostAccumulator(total).add(cost).total();
}

/** Fold many usage components into one provenance-carrying total. */
export function foldSessionCost(costs: Iterable<UsageCost>): SessionCostTotal {
	const accumulator = new SessionCostAccumulator();
	for (const cost of costs) accumulator.add(cost);
	return accumulator.total();
}

/** The known USD total, routed through one conversion point so no caller re-derives it. */
export function sessionCostUsd(total: SessionCostTotal): number {
	return total.nanoUsd / NANO_USD_SCALE;
}

/** Combine two partial-aware totals (for example the orchestrator and its subagents) without losing provenance. */
export function mergeSessionCost(a: SessionCostTotal, b: SessionCostTotal): SessionCostTotal {
	return { nanoUsd: a.nanoUsd + b.nanoUsd, complete: a.complete && b.complete, absent: a.absent + b.absent };
}

// ---------------------------------------------------------------------------
// Exposed ingestion seam (I1/I2).
//
// Everything above is the canonical contract. The functions below are the only
// entry points the agent code needs to call, and each is a pure fold over a
// plain shape: no `ExtensionContext`, no `TaskStore`, no extension import. The
// agent code stays a thin adapter, so a future plugin can consume the same
// inputs (`ctx.sessionManager.getEntries()` for the parent, the delegated-cost
// topic for children) and apply the identical no-coercion rule without
// dragging statistics logic into the core.
// ---------------------------------------------------------------------------

/** The minimal slice of a Pi session entry the parent fold reads. */
export interface UsageEntryLike {
	readonly type?: string;
	readonly message?: {
		readonly role?: string;
		readonly usage?: { readonly cost?: { readonly total?: unknown } };
	};
}

/** Parent-session ingestion (I1): fold the orchestrator's own usage into one provenance-carrying total. */
export function sessionCostFromEntries(entries: Iterable<UsageEntryLike>): SessionCostTotal {
	const accumulator = new SessionCostAccumulator();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		accumulator.add(reportedCostOrAbsent(entry.message.usage?.cost?.total));
	}
	return accumulator.total();
}

/** Child ingestion (I1): read one assistant message's usage without coercing an absent cost to zero. */
export function childUsageCost(usage: unknown): UsageCost {
	const total = (usage as { readonly cost?: { readonly total?: unknown } } | undefined)?.cost?.total;
	return reportedCostOrAbsent(total);
}

/** The minimal slice of a task record the delegated fold reads. */
export interface TaskCostLike {
	readonly cost: number;
	readonly costComplete?: boolean;
}

/** Task accumulation (I1): apply one child usage delta while remembering whether any component was absent. */
/** Task accumulation (I1): apply one child usage delta while remembering whether
 * any component was absent. Each step stays on the integer nano-USD grid, so
 * repeated nine-decimal additions cannot drift before the delegated fold. */
export function accumulateTaskCost(current: TaskCostLike, cost: UsageCost): { cost: number; costComplete: boolean } {
	const nanoUsd = reportedCost(current.cost).nanoUsd + (cost.state === "reported" ? cost.nanoUsd : 0);
	return { cost: nanoUsd / NANO_USD_SCALE, costComplete: current.costComplete !== false && cost.state === "reported" };
}

/** Delegated ingestion (I2): fold every subagent's known cost into one partial-aware total for the bar. */
export function delegatedCostFromTasks(tasks: Iterable<TaskCostLike>): SessionCostTotal {
	const accumulator = new SessionCostAccumulator();
	for (const task of tasks) {
		// A task with an absent component still has a known partial cost; add it
		// and record one absence marker so the total renders as partial.
		accumulator.add(reportedCost(task.cost));
		if (task.costComplete === false) accumulator.add(ABSENT_COST);
	}
	return accumulator.total();
}

/** One classified span of a turn's timeline (I5). `idle` is an estimate and must be labelled as one. */
export interface TimeSegment {
	readonly kind: "model" | "tool" | "idle";
	readonly start: number;
	readonly end: number;
	readonly tool?: string;
	readonly callId?: string;
}

/** One model turn with its classified segments, built by timestamp pairing (I5). */
export interface TurnRecord {
	readonly index: number;
	readonly start: number;
	readonly end: number;
	readonly model: string;
	readonly segments: readonly TimeSegment[];
}
