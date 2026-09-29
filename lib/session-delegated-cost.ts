import type { SessionCostTotal } from "./session-usage.ts";

// I2 transport: the agents extension owns the TaskStore, the shell extension
// owns the bar. They are separate extensions with no shared state, so the
// delegated total (orchestrator-excluded subagent cost) crosses over Pi's
// extension bus on one versioned topic, following the
// `gentle:runtime-metrics:child/v1` precedent.
//
// The payload is whitelisted and bounded: a session id, three numbers, a flag
// and a timestamp, nothing else. The consumer treats a missing or malformed
// payload as "no delegated cost known" and never throws.

export const SESSION_DELEGATED_COST_EVENT = "gentle:session-cost:delegated/v1";

/** Maximum value accepted for a payload's diagnostic count fields. */
export const MAX_DELEGATED_COUNT = 4096;

const MAX_SESSION_ID = 256;
const MAX_COUNT = MAX_DELEGATED_COUNT;

export interface DelegatedSessionCostPayload {
	readonly schema: typeof SESSION_DELEGATED_COST_EVENT;
	readonly parentSessionId: string;
	/** Monotonic per-publisher sequence; a consumer ignores an older sequence, so a
	 * backward wall-clock adjustment can never make a newer total look stale. */
	readonly seq: number;
	/** Exact integer nano-USD for every subagent of this parent session. */
	readonly nanoUsd: number;
	/** False when any subagent reported no cost; drives the bar's `+` marker. */
	readonly complete: boolean;
	readonly absent: number;
	readonly subagents: number;
	/** Wall-clock timestamp, kept for diagnostics only; never used for ordering. */
	readonly at: number;
}

export interface DelegatedSessionCostInput {
	readonly parentSessionId: string;
	readonly seq: number;
	readonly total: SessionCostTotal;
	readonly subagents: number;
	readonly at: number;
}

/** Clamp a diagnostic count to the payload bound, so a very long session still
 * publishes a valid event instead of silently dropping the delegated total. */
export function clampDelegatedCount(value: number): number {
	return Math.min(value, MAX_DELEGATED_COUNT);
}

/** True when a value is a count the payload can carry: a non-negative integer within the bound. */
function validCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
}

/** True when a value is a valid monotonic publication sequence. */
function validSequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Build the bounded payload, or undefined when any field is out of range. */
export function delegatedSessionCostEvent(input: DelegatedSessionCostInput): DelegatedSessionCostPayload | undefined {
	if (typeof input.parentSessionId !== "string" || input.parentSessionId.length === 0 || input.parentSessionId.length > MAX_SESSION_ID) return undefined;
	if (!validSequence(input.seq)) return undefined;
	if (!Number.isSafeInteger(input.total.nanoUsd) || input.total.nanoUsd < 0) return undefined;
	if (!validCount(input.total.absent)) return undefined;
	if (!validCount(input.subagents)) return undefined;
	if (typeof input.at !== "number" || !Number.isFinite(input.at)) return undefined;
	return {
		schema: SESSION_DELEGATED_COST_EVENT,
		parentSessionId: input.parentSessionId,
		seq: input.seq,
		nanoUsd: input.total.nanoUsd,
		complete: input.total.complete,
		absent: input.total.absent,
		subagents: input.subagents,
		at: input.at,
	};
}

/** Recognize a well-formed delegated-cost payload; return undefined for anything else. */
export function decodeDelegatedSessionCost(value: unknown): DelegatedSessionCostPayload | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.schema !== SESSION_DELEGATED_COST_EVENT) return undefined;
	if (typeof raw.parentSessionId !== "string" || raw.parentSessionId.length === 0 || raw.parentSessionId.length > MAX_SESSION_ID) return undefined;
	if (!validSequence(raw.seq)) return undefined;
	if (!Number.isSafeInteger(raw.nanoUsd) || (raw.nanoUsd as number) < 0) return undefined;
	if (typeof raw.complete !== "boolean") return undefined;
	if (!validCount(raw.absent) || !validCount(raw.subagents)) return undefined;
	if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return undefined;
	return {
		schema: SESSION_DELEGATED_COST_EVENT,
		parentSessionId: raw.parentSessionId,
		seq: raw.seq as number,
		nanoUsd: raw.nanoUsd as number,
		complete: raw.complete,
		absent: raw.absent as number,
		subagents: raw.subagents as number,
		at: raw.at as number,
	};
}
