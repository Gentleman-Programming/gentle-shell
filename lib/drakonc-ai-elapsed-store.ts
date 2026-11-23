export const DRAKONC_AI_TIMING_ENTRY = "drakonc-ai-elapsed-timing/v1";

export interface DrakoncAiTimingRecord {
	toolCallId: string;
	startedAt: number;
	endedAt?: number;
}

/** What the renderer consumes: a read-only lookup keyed by pi's stable toolCallId. */
export interface DrakoncAiTimingLookup {
	lookup(toolCallId: string): DrakoncAiTimingRecord | undefined;
}

export interface DrakoncAiTimingEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface DrakoncAiTimingSessionReader {
	getEntries(): readonly DrakoncAiTimingEntry[];
}

export interface DrakoncAiTimingAppendHost {
	appendEntry(type: string, data?: unknown): void;
}

export function parseDrakoncAiTimingData(data: unknown): DrakoncAiTimingRecord | undefined {
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
export function readDrakoncAiTimings(entries: readonly DrakoncAiTimingEntry[]): Map<string, DrakoncAiTimingRecord> {
	const timings = new Map<string, DrakoncAiTimingRecord>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== DRAKONC_AI_TIMING_ENTRY) continue;
		const record = parseDrakoncAiTimingData(entry.data);
		if (record) timings.set(record.toolCallId, record);
	}
	return timings;
}

// No global store: the owning extension binds its own Pi API, and reading all
// entries also catches a launch that happened while the shell was absent.
export class DrakoncAiElapsedTimingLedger implements DrakoncAiTimingLookup {
	private readonly recorded = new Set<string>();
	private readonly session: DrakoncAiTimingSessionReader;
	private readonly host?: DrakoncAiTimingAppendHost;

	constructor(session: DrakoncAiTimingSessionReader, host?: DrakoncAiTimingAppendHost) {
		this.session = session;
		this.host = host;
	}

	lookup(toolCallId: string): DrakoncAiTimingRecord | undefined {
		return readDrakoncAiTimings(this.session.getEntries()).get(toolCallId);
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

	private append(stage: string, data: DrakoncAiTimingRecord): void {
		if (this.recorded.has(stage)) return;
		this.host?.appendEntry(DRAKONC_AI_TIMING_ENTRY, data);
		this.recorded.add(stage);
	}
}
