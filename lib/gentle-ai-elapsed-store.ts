export const GENTLE_AI_TIMING_ENTRY = "gentle-ai-elapsed-timing/v1";

export interface GentleAiTimingRecord {
	toolCallId: string;
	startedAt: number;
	endedAt?: number;
}

/** What the renderer consumes: a read-only lookup keyed by pi's stable toolCallId. */
export interface GentleAiTimingLookup {
	lookup(toolCallId: string): GentleAiTimingRecord | undefined;
}

export interface GentleAiTimingEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface GentleAiTimingSessionReader {
	getEntries(): readonly GentleAiTimingEntry[];
}

export interface GentleAiTimingAppendHost {
	appendEntry(type: string, data?: unknown): void;
}

export function parseGentleAiTimingData(data: unknown): GentleAiTimingRecord | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as { toolCallId?: unknown; startedAt?: unknown; endedAt?: unknown };
	if (typeof record.toolCallId !== "string" || record.toolCallId.length === 0) return undefined;
	if (typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt)) return undefined;
	// Local capture + a plain typeof guard: under non-strict null checks a
	// `x === undefined` condition leaves `unknown` unnarrowed, so the finite-
	// number branch must be decided by typeof before the value is used.
	const endedAt = record.endedAt;
	if (endedAt !== undefined) {
		if (typeof endedAt !== "number" || !Number.isFinite(endedAt)) return undefined;
		return { toolCallId: record.toolCallId, startedAt: record.startedAt, endedAt };
	}
	return { toolCallId: record.toolCallId, startedAt: record.startedAt };
}

/** Replay: entries are append-only, so the last timing entry per toolCallId wins. */
export function readGentleAiTimings(entries: readonly GentleAiTimingEntry[]): Map<string, GentleAiTimingRecord> {
	const timings = new Map<string, GentleAiTimingRecord>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== GENTLE_AI_TIMING_ENTRY) continue;
		const record = parseGentleAiTimingData(entry.data);
		if (record) timings.set(record.toolCallId, record);
	}
	return timings;
}

// No global store: the owning extension binds its own Pi API, and reading all
// entries also catches a launch that happened while the shell was absent.
export class GentleAiElapsedTimingLedger implements GentleAiTimingLookup {
	private readonly recorded = new Set<string>();
	private readonly session: GentleAiTimingSessionReader;
	private readonly host?: GentleAiTimingAppendHost;

	constructor(session: GentleAiTimingSessionReader, host?: GentleAiTimingAppendHost) {
		this.session = session;
		this.host = host;
	}

	lookup(toolCallId: string): GentleAiTimingRecord | undefined {
		return readGentleAiTimings(this.session.getEntries()).get(toolCallId);
	}

	recordStart(toolCallId: string, startedAt: number): void {
		this.append(`${toolCallId}:start`, { toolCallId, startedAt });
	}

	recordEnd(toolCallId: string, endedAt: number): void {
		const startedAt = this.lookup(toolCallId)?.startedAt;
		// A terminal without a durable start has no honest duration to freeze.
		if (startedAt === undefined) return;
		this.append(`${toolCallId}:end`, { toolCallId, startedAt, endedAt });
	}

	private append(stage: string, data: GentleAiTimingRecord): void {
		if (this.recorded.has(stage)) return;
		this.host?.appendEntry(GENTLE_AI_TIMING_ENTRY, data);
		this.recorded.add(stage);
	}
}
