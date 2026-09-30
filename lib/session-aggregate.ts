// Pure aggregation engine for the session statistics module (epic #1, I4).
//
// It folds canonical usage records (I3's transcript reader yields them; any
// `SessionUsageRecord` works) into the totals the current surfaces do not
// compute: cost and tokens per session, per subagent, per model, per agent
// class and per project, over an optional date range.
//
// Two rules from the epic are enforced by the types, not by convention:
//
//   1. A monetary or token figure carries its provenance. A sum is `measured`
//      only while every component reported a cost; the first absent component
//      makes it `partial` forever, so a consumer cannot render a partial sum as
//      complete. A token counter is a provider count, so token figures are
//      `measured` (I3 maps an omitted counter to a true zero).
//   2. This function is pure: no filesystem, network or clock. The clock is
//      injected through `now`, recorded as `asOf` for a caller that caches the
//      result and invalidates it by events. It is synchronous and free of I/O,
//      so no render path may call it; a caller caches and recomputes on events.
//
// It imports nothing from `lib/agents-*`, an extension or I3, so a future
// package can carry it whole. It accepts I3's `TranscriptUsageRecord`
// structurally, because that record already has `sessionId` and `task`.

import { NANO_USD_SCALE, type SessionUsageRecord, type UsageTokens } from "./session-usage.ts";

export type FigureProvenance = "measured" | "partial";

/** A cost sum that knows whether every component was reported. */
export interface MoneyFigure {
	readonly nanoUsd: number;
	readonly provenance: FigureProvenance;
	/** Components that reported no cost; greater than zero makes the figure partial. */
	readonly absent: number;
}

/** The six token counters plus their provenance. */
export interface TokenFigure extends UsageTokens {
	readonly provenance: FigureProvenance;
}

/** A count (sessions, subagents, tool calls) plus whether it is complete. */
export interface CountFigure {
	readonly value: number;
	readonly provenance: FigureProvenance;
}

/** Derived shares and per-turn averages. `null` means the denominator is zero, not a measured 0.
 * These are floating-point derived figures (a single division of an exact integer sum); the money
 * figures themselves stay exact integer nano-USD. */
export interface UsageRatios {
	readonly cacheReadShare: number | null;
	readonly cacheWriteShare: number | null;
	readonly reasoningShareOfOutput: number | null;
	readonly outputToTotal: number | null;
	readonly costPerTurn: number | null;
	readonly tokensPerTurn: number | null;
}

/** The totals every breakdown entry shares. */
export interface UsageBucket {
	readonly turns: number;
	readonly cost: MoneyFigure;
	readonly tokens: TokenFigure;
	readonly ratios: UsageRatios;
}

export interface SubagentAggregate extends UsageBucket {
	readonly taskId: string;
	readonly agent: string;
	readonly label: string;
	readonly status: string;
	readonly toolCalls: CountFigure;
}

export interface ModelAggregate extends UsageBucket {
	readonly model: string;
	readonly provider: string;
}

export interface AgentClassAggregate extends UsageBucket {
	readonly agentClass: string;
}

export interface ProjectAggregate extends UsageBucket {
	readonly project: string;
}

export interface UsageAggregate extends UsageBucket {
	/** The injected clock at aggregation time, for a caller's cache invalidation. */
	readonly asOf: number;
	readonly sessions: CountFigure;
	readonly subagents: CountFigure;
	readonly toolCalls: CountFigure;
	readonly perSubagent: readonly SubagentAggregate[];
	readonly perModel: readonly ModelAggregate[];
	readonly perAgentClass: readonly AgentClassAggregate[];
	readonly perProject: readonly ProjectAggregate[];
}

/** The task fields the engine reads; I3's `TranscriptTaskIdentity` satisfies this. */
export interface AggregationTaskIdentity {
	readonly taskId: string;
	readonly agent: string;
	readonly label?: string;
	readonly status?: string;
	readonly toolCalls?: number;
}

/** The fields the engine reads on top of the canonical record; all optional. */
export interface AggregationRecord extends SessionUsageRecord {
	readonly sessionId?: string;
	readonly project?: string;
	readonly task?: AggregationTaskIdentity;
}

export interface AggregateOptions {
	/** Injected clock; the engine never reads one itself. */
	readonly now: () => number;
	/** Inclusive lower bound on a record's timestamp. */
	readonly from?: number;
	/** Exclusive upper bound on a record's timestamp. */
	readonly to?: number;
}

/** The agent class of the orchestrator's own messages. */
export const ORCHESTRATOR_CLASS = "orchestrator";
/** The agent class of a subagent whose task file was not found. */
export const UNIDENTIFIED_CLASS = "unidentified";
/** The project key when a record carries none. */
export const UNKNOWN_PROJECT = "unknown";

interface MutableBucket {
	turns: number;
	nanoUsd: number;
	absent: number;
	complete: boolean;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	total: number;
}

function emptyBucket(): MutableBucket {
	return { turns: 0, nanoUsd: 0, absent: 0, complete: true, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function addRecord(bucket: MutableBucket, record: SessionUsageRecord): void {
	bucket.turns += 1;
	if (record.cost.state === "reported") bucket.nanoUsd += record.cost.nanoUsd;
	else {
		bucket.complete = false;
		bucket.absent += 1;
	}
	const tokens = record.tokens;
	bucket.input += tokens.input;
	bucket.output += tokens.output;
	bucket.cacheRead += tokens.cacheRead;
	bucket.cacheWrite += tokens.cacheWrite;
	bucket.reasoning += tokens.reasoning;
	bucket.total += tokens.total;
}

function moneyFigure(bucket: MutableBucket): MoneyFigure {
	return { nanoUsd: bucket.nanoUsd, provenance: bucket.complete ? "measured" : "partial", absent: bucket.absent };
}

function tokenFigure(bucket: MutableBucket): TokenFigure {
	return {
		input: bucket.input,
		output: bucket.output,
		cacheRead: bucket.cacheRead,
		cacheWrite: bucket.cacheWrite,
		reasoning: bucket.reasoning,
		total: bucket.total,
		provenance: "measured",
	};
}

function ratios(bucket: MutableBucket): UsageRatios {
	const total = bucket.total;
	return {
		cacheReadShare: total > 0 ? bucket.cacheRead / total : null,
		cacheWriteShare: total > 0 ? bucket.cacheWrite / total : null,
		reasoningShareOfOutput: bucket.output > 0 ? bucket.reasoning / bucket.output : null,
		outputToTotal: total > 0 ? bucket.output / total : null,
		costPerTurn: bucket.turns > 0 ? bucket.nanoUsd / NANO_USD_SCALE / bucket.turns : null,
		tokensPerTurn: bucket.turns > 0 ? total / bucket.turns : null,
	};
}

function finish(bucket: MutableBucket): UsageBucket {
	return { turns: bucket.turns, cost: moneyFigure(bucket), tokens: tokenFigure(bucket), ratios: ratios(bucket) };
}

/** Fold two partial-aware cost figures without ever laundering a partial one into a measured total. */
export function mergeMoneyFigure(a: MoneyFigure, b: MoneyFigure): MoneyFigure {
	return {
		nanoUsd: a.nanoUsd + b.nanoUsd,
		provenance: a.provenance === "measured" && b.provenance === "measured" ? "measured" : "partial",
		absent: a.absent + b.absent,
	};
}

function addToGroup(map: Map<string, MutableBucket>, key: string, record: SessionUsageRecord): void {
	let bucket = map.get(key);
	if (!bucket) {
		bucket = emptyBucket();
		map.set(key, bucket);
	}
	addRecord(bucket, record);
}

function finiteCount(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface SubagentBucket {
	identity: AggregationTaskIdentity;
	bucket: MutableBucket;
}

/**
 * Aggregate canonical usage records into session, subagent, model, agent-class
 * and project totals. Records outside `[from, to)` are ignored. Ordering inside
 * every breakdown is a stable ascending key sort, so the same input yields
 * bit-identical output; the input array is never mutated.
 */
export function aggregateUsage(records: readonly AggregationRecord[], options: AggregateOptions): UsageAggregate {
	const from = options.from ?? Number.NEGATIVE_INFINITY;
	const to = options.to ?? Number.POSITIVE_INFINITY;

	const total = emptyBucket();
	const perModel = new Map<string, MutableBucket>();
	const perModelIdentity = new Map<string, { model: string; provider: string }>();
	const perAgentClass = new Map<string, MutableBucket>();
	const perProject = new Map<string, MutableBucket>();
	const perSubagent = new Map<string, SubagentBucket>();
	const sessions = new Set<string>();
	const subagentTasks = new Set<string>();
	const toolCallsByTask = new Map<string, number>();

	let identitiesComplete = true;
	let subagentsComplete = true;
	let toolCallsComplete = true;
	let sawRecord = false;

	for (const record of records) {
		if (record.timestamp < from || record.timestamp >= to) continue;
		sawRecord = true;
		addRecord(total, record);

		if (record.sessionId !== undefined) sessions.add(record.sessionId);
		else identitiesComplete = false;

		const modelKey = `${record.provider}\u0000${record.model}`;
		addToGroup(perModel, modelKey, record);
		if (!perModelIdentity.has(modelKey)) perModelIdentity.set(modelKey, { model: record.model, provider: record.provider });

		const agentClass = record.source === "parent" ? ORCHESTRATOR_CLASS : (record.task?.agent ?? UNIDENTIFIED_CLASS);
		addToGroup(perAgentClass, agentClass, record);
		addToGroup(perProject, record.project ?? UNKNOWN_PROJECT, record);

		if (record.source === "parent") {
			// The orchestrator's tool calls are not carried by a usage record.
			toolCallsComplete = false;
			continue;
		}
		const identity = record.task;
		if (!identity) {
			subagentsComplete = false;
			toolCallsComplete = false;
			continue;
		}
		subagentTasks.add(identity.taskId);
		let entry = perSubagent.get(identity.taskId);
		if (!entry) {
			entry = { identity, bucket: emptyBucket() };
			perSubagent.set(identity.taskId, entry);
		}
		addRecord(entry.bucket, record);
		if (!toolCallsByTask.has(identity.taskId)) {
			const count = finiteCount(identity.toolCalls);
			if (count === undefined) toolCallsComplete = false;
			else toolCallsByTask.set(identity.taskId, count);
		}
	}

	const toolCallsValue = [...toolCallsByTask.values()].reduce((sum, value) => sum + value, 0);

	return {
		...finish(total),
		asOf: options.now(),
		sessions: { value: sessions.size, provenance: identitiesComplete ? "measured" : "partial" },
		subagents: { value: subagentTasks.size, provenance: subagentsComplete ? "measured" : "partial" },
		toolCalls: { value: toolCallsValue, provenance: !sawRecord || toolCallsComplete ? "measured" : "partial" },
		perSubagent: [...perSubagent.values()]
			.map((entry): SubagentAggregate => {
				const count = finiteCount(entry.identity.toolCalls);
				return {
					...finish(entry.bucket),
					taskId: entry.identity.taskId,
					agent: entry.identity.agent,
					label: entry.identity.label ?? "",
					status: entry.identity.status ?? "unknown",
					toolCalls: { value: count ?? 0, provenance: count === undefined ? "partial" : "measured" },
				};
			})
			.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)),
		perModel: [...perModel.entries()]
			.map(([key, bucket]) => {
				const identity = perModelIdentity.get(key) ?? { model: key, provider: "" };
				return { ...finish(bucket), model: identity.model, provider: identity.provider };
			})
			.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0)),
		perAgentClass: [...perAgentClass.entries()]
			.map(([agentClass, bucket]) => ({ ...finish(bucket), agentClass }))
			.sort((a, b) => (a.agentClass < b.agentClass ? -1 : a.agentClass > b.agentClass ? 1 : 0)),
		perProject: [...perProject.entries()]
			.map(([project, bucket]) => ({ ...finish(bucket), project }))
			.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0)),
	};
}
