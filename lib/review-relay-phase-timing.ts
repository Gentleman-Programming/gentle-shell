export type ReviewRelayPhase = "materialize" | "submit" | "cleanup";
export interface ReviewRelayPhaseTiming {
	readonly phase: ReviewRelayPhase;
	/** Host-observed invocation/cleanup duration, not native internal CPU time. */
	readonly duration_ms: number;
	/** Invocation produced usable bytes, or cleanup resolved; never a review verdict. */
	readonly outcome: "success" | "failure";
}
export type ReviewRelayPhaseObserver = (sample: ReviewRelayPhaseTiming) => unknown;

/** Ignore invalid or throwing clocks so instrumentation cannot alter settlement. */
function readClock(clock: () => number): number | undefined {
	try {
		const value = clock();
		return Number.isFinite(value) && value >= 0 ? value : undefined;
	} catch { return undefined; }
}

/** Observe an existing operation only; callbacks never participate in settlement. */
export async function observeReviewRelayPhase<T>(
	observer: ReviewRelayPhaseObserver | undefined,
	phase: ReviewRelayPhase,
	run: () => Promise<T>,
	succeeded: (result: T) => boolean = () => true,
	clock: () => number = () => performance.now(),
): Promise<T> {
	if (typeof observer !== "function") return run();
	const start = readClock(clock);
	let success = false;
	try {
		const result = await run();
		try { success = succeeded(result); } catch { /* Classification is observational. */ }
		return result;
	} finally {
		const end = readClock(clock);
		if (start !== undefined && end !== undefined && end >= start) {
			try {
				const pending = observer(Object.freeze({ phase, duration_ms: end - start, outcome: success ? "success" : "failure" }));
				// Consume async rejection without awaiting it, including callbacks
				// that return promises which never settle.
				void Promise.resolve(pending).catch(() => undefined);
			} catch { /* Diagnostics cannot replace the result or primary failure. */ }
		}
	}
}
