// Billable hours report (epic #1, I9).
//
// The motivating use case: an operator billing hours at an hourly rate wants
// the same numbers to produce the hours report and its cost. That needs a rate,
// a currency, a rounding policy and a date range, and it must be honest about
// which part of the total time is measured and which is derived:
//
//   measured  — session and subagent wall-clock boundaries
//   derived   — per-tool duration and model latency from timestamp pairing
//   estimated — idle
//
// `buildBillableReport` is pure and deterministic (same input and rate yields
// the same report); `collectBillableSessions` is the only I/O and runs off the
// interactive path. The report never presents derived time as measured, and a
// session whose provider reported no cost still bills its hours with the cost
// marked partial.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileStartedAt, readTranscript, streamTranscriptLines } from "./session-transcript.ts";
import { foldSessionCost } from "./session-usage.ts";
import { readTimeline } from "./session-timeline.ts";
import type { FigureProvenance } from "./session-aggregate.ts";

export const BILLABLE_SCHEMA = "gentle-shell.billable-hours/v1";
export const MILLISECONDS_PER_HOUR = 3_600_000;

export type RoundingPolicy =
	| { readonly mode: "none" }
	| { readonly mode: "nearest"; readonly minutes: number }
	| { readonly mode: "up"; readonly minutes: number };

export interface BillableConfig {
	/** Amount per hour, in `currency`. Zero means the hours are reported without an amount. */
	readonly hourlyRate: number;
	readonly currency: string;
	readonly rounding: RoundingPolicy;
}

export const DEFAULT_BILLABLE_CONFIG: BillableConfig = { hourlyRate: 0, currency: "USD", rounding: { mode: "none" } };

/** The honest split, stated in every report. */
export const BILLABLE_PROVENANCE = {
	measured: "session and subagent wall-clock boundaries",
	derived: "per-tool duration and model latency from timestamp pairing",
	estimated: "idle is an estimate, never a measured time",
} as const;

/**
 * Parse `none`, `nearest-6`, `nearest:15`, `up-15` … A malformed or non-positive
 * policy fails closed to `none`, so a typo can never inflate an invoice.
 */
export function parseRounding(value: string | undefined): RoundingPolicy {
	const text = (value ?? "").trim().toLowerCase();
	if (text === "" || text === "none") return { mode: "none" };
	const match = /^(nearest|up)[-:](\d+)$/.exec(text);
	if (!match) return { mode: "none" };
	const minutes = Number(match[2]);
	if (!Number.isFinite(minutes) || minutes <= 0) return { mode: "none" };
	return { mode: match[1] as "nearest" | "up", minutes };
}

export interface BillableEnv {
	readonly GENTLE_BILLABLE_RATE?: string;
	readonly GENTLE_BILLABLE_CURRENCY?: string;
	readonly GENTLE_BILLABLE_ROUNDING?: string;
}

export function readBillableConfig(env: BillableEnv): BillableConfig {
	const rate = Number(env.GENTLE_BILLABLE_RATE);
	const currency = (env.GENTLE_BILLABLE_CURRENCY ?? DEFAULT_BILLABLE_CONFIG.currency).trim().toUpperCase();
	return {
		hourlyRate: Number.isFinite(rate) && rate >= 0 ? rate : 0,
		currency: currency.length > 0 ? currency : DEFAULT_BILLABLE_CONFIG.currency,
		rounding: parseRounding(env.GENTLE_BILLABLE_ROUNDING),
	};
}

/**
 * Round a duration to the policy's step. `up` never exceeds the next step;
 * `nearest` moves by at most half a step; `none` is exact.
 */
export function roundDurationMs(ms: number, policy: RoundingPolicy): number {
	const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
	if (policy.mode === "none") return value;
	const step = policy.minutes * 60_000;
	if (!Number.isFinite(step) || step <= 0) return value;
	return policy.mode === "up" ? Math.ceil(value / step) * step : Math.round(value / step) * step;
}

/** Money is rounded to cents per line, so the total is the sum of what is billed. */
export function roundMoney(value: number): number {
	return Math.round(value * 100) / 100;
}

export function billableAmount(ms: number, hourlyRate: number): number {
	if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) return 0;
	return roundMoney((Math.max(0, ms) / MILLISECONDS_PER_HOUR) * hourlyRate);
}

export interface BillableSessionInput {
	readonly sessionId: string;
	readonly project: string;
	readonly startedAt: number;
	readonly endedAt: number;
	/** Measured: the session's own wall-clock boundary. */
	readonly wallClockMs: number;
	/** Derived: per-tool duration from timestamp pairing. */
	readonly toolMs: number;
	/** Derived: model latency from timestamp pairing. */
	readonly modelMs: number;
	/** Estimated: the idle residual. */
	readonly idleMs: number;
	/** Measured: this session's subagent wall clocks (concurrent, context only). */
	readonly subagentMs: number;
	readonly costNanoUsd: number;
	readonly costProvenance: FigureProvenance;
}

export interface BillableSessionRow extends BillableSessionInput {
	readonly billableMs: number;
	readonly amount: number;
}

export interface BillableProjectRow {
	readonly project: string;
	readonly sessions: number;
	readonly wallClockMs: number;
	readonly billableMs: number;
	readonly amount: number;
	readonly costNanoUsd: number;
	readonly costProvenance: FigureProvenance;
}

export interface BillableTotals {
	readonly sessions: number;
	readonly wallClockMs: number;
	readonly billableMs: number;
	readonly amount: number;
	readonly costNanoUsd: number;
	readonly costProvenance: FigureProvenance;
}

export interface BillableRange {
	readonly from: number | null;
	readonly to: number | null;
}

export interface BillableReport {
	readonly schema: typeof BILLABLE_SCHEMA;
	readonly generatedAt: number;
	readonly config: BillableConfig;
	readonly range: BillableRange;
	readonly sessions: readonly BillableSessionRow[];
	readonly projects: readonly BillableProjectRow[];
	readonly totals: BillableTotals;
	readonly provenance: typeof BILLABLE_PROVENANCE;
}

function mergeProvenance(a: FigureProvenance, b: FigureProvenance): FigureProvenance {
	return a === "measured" && b === "measured" ? "measured" : "partial";
}

/** Build the report. Pure and deterministic: the same input and rate yields the same report. */
export function buildBillableReport(sessions: readonly BillableSessionInput[], config: BillableConfig, range: BillableRange = { from: null, to: null }, generatedAt = 0): BillableReport {
	const rows: BillableSessionRow[] = sessions
		.map((session): BillableSessionRow => {
			const billableMs = roundDurationMs(session.wallClockMs, config.rounding);
			return { ...session, billableMs, amount: billableAmount(billableMs, config.hourlyRate) };
		})
		.sort((a, b) => a.startedAt - b.startedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));

	const projects = new Map<string, BillableProjectRow>();
	for (const row of rows) {
		const current = projects.get(row.project);
		projects.set(row.project, {
			project: row.project,
			sessions: (current?.sessions ?? 0) + 1,
			wallClockMs: (current?.wallClockMs ?? 0) + row.wallClockMs,
			billableMs: (current?.billableMs ?? 0) + row.billableMs,
			amount: roundMoney((current?.amount ?? 0) + row.amount),
			costNanoUsd: (current?.costNanoUsd ?? 0) + row.costNanoUsd,
			costProvenance: mergeProvenance(current?.costProvenance ?? "measured", row.costProvenance),
		});
	}

	const totals: BillableTotals = {
		sessions: rows.length,
		wallClockMs: rows.reduce((sum, row) => sum + row.wallClockMs, 0),
		billableMs: rows.reduce((sum, row) => sum + row.billableMs, 0),
		amount: roundMoney(rows.reduce((sum, row) => sum + row.amount, 0)),
		costNanoUsd: rows.reduce((sum, row) => sum + row.costNanoUsd, 0),
		costProvenance: rows.every((row) => row.costProvenance === "measured") ? "measured" : "partial",
	};

	return {
		schema: BILLABLE_SCHEMA,
		generatedAt,
		config,
		range,
		sessions: rows,
		projects: [...projects.values()].sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0)),
		totals,
		provenance: BILLABLE_PROVENANCE,
	};
}

export function defaultBillableRange(now: number, days: number): BillableRange {
	const span = Math.max(0, days) * 24 * 60 * 60 * 1000;
	return { from: now - span, to: now };
}

// ---------------------------------------------------------------------------
// Collection: the only I/O, and it never runs on a render path.
// ---------------------------------------------------------------------------

/** The project is the basename of the session's recorded cwd. */
async function sessionProject(file: string): Promise<string> {
	for await (const { raw } of streamTranscriptLines(file)) {
		try {
			const parsed = JSON.parse(raw) as { cwd?: unknown };
			if (typeof parsed.cwd === "string" && parsed.cwd.length > 0) return basename(parsed.cwd);
		} catch {
			/* a malformed header falls through to "unknown" */
		}
		break;
	}
	return "unknown";
}

async function subagentWallClock(agentHome: string, sessionId: string): Promise<number> {
	const dir = join(agentHome, "gentle-agents", "tasks");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return 0;
	}
	let total = 0;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const task = (JSON.parse(await readFile(join(dir, name), "utf8")) as { task?: { parentSessionId?: unknown; startedAt?: unknown; endedAt?: unknown } }).task;
			if (task?.parentSessionId !== sessionId || typeof task.startedAt !== "number" || typeof task.endedAt !== "number") continue;
			total += Math.max(0, task.endedAt - task.startedAt);
		} catch {
			/* a malformed task file is skipped */
		}
	}
	return total;
}

async function listParentTranscripts(agentHome: string, range: BillableRange): Promise<string[]> {
	const root = join(agentHome, "sessions");
	let dirs: string[];
	try {
		dirs = await readdir(root);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = await readdir(join(root, dir));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const file = join(root, dir, name);
			const startedAt = fileStartedAt(file);
			if (startedAt !== undefined && range.from !== null && startedAt < range.from) continue;
			if (startedAt !== undefined && range.to !== null && startedAt >= range.to) continue;
			files.push(file);
		}
	}
	return files.sort((a, b) => (fileStartedAt(a) ?? 0) - (fileStartedAt(b) ?? 0) || (a < b ? -1 : 1));
}

export interface CollectBillableOptions {
	readonly agentHome: string;
	readonly range?: BillableRange;
}

/** Read every parent session in the range into the report's inputs. Streamed and off the render path. */
export async function collectBillableSessions(options: CollectBillableOptions): Promise<BillableSessionInput[]> {
	const range = options.range ?? { from: null, to: null };
	const files = await listParentTranscripts(options.agentHome, range);
	const sessions: BillableSessionInput[] = [];
	for (const file of files) {
		const sessionId = file.replace(/^.*_/, "").replace(/\.jsonl$/, "");
		const read = await readTranscript(file, { source: "parent", sessionId });
		const cost = foldSessionCost(read.records.map((record) => record.cost));
		const timeline = await readTimeline(file);
		const first = read.records[0]?.timestamp;
		const last = read.records[read.records.length - 1]?.timestamp;
		sessions.push({
			sessionId,
			project: await sessionProject(file),
			startedAt: first ?? fileStartedAt(file) ?? 0,
			endedAt: last ?? first ?? fileStartedAt(file) ?? 0,
			wallClockMs: timeline.wallClockMs,
			toolMs: timeline.toolMs,
			modelMs: timeline.modelMs,
			idleMs: timeline.idleMs,
			subagentMs: await subagentWallClock(options.agentHome, sessionId),
			costNanoUsd: cost.nanoUsd,
			costProvenance: cost.complete ? "measured" : "partial",
		});
	}
	return sessions;
}
