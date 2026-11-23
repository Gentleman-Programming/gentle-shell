const CHANGES_QUIET_MS = 250;
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000];

export type ChangesIdleScheduler = (tick: () => void, delayMs: number) => { cancel(): void; unref(): void };

export const scheduleChangesIdle: ChangesIdleScheduler = (tick, delayMs) => {
	const timer = setTimeout(tick, delayMs);
	return { cancel: () => clearTimeout(timer), unref: () => timer.unref() };
};

/** Defer the initial inventory, failure retries and partial-count passes, not explicit refreshes. */
export function createIdleChanges({ isIdle, refresh, observeInput, schedule }: {
	isIdle(): boolean;
	refresh(): void;
	observeInput(listener: () => void): (() => void) | undefined;
	schedule: ChangesIdleScheduler;
}) {
	let started = false, painted = false, turnRunning = false, disposed = false;
	let delay: number | undefined = CHANGES_QUIET_MS;
	let retries = 0, turnGeneration = 0;
	// The pending count seen after the last scan. A pass that leaves it where it
	// was made no progress: waiting for more idle time would scan forever.
	let lastPending = -1;
	// The lowest pending count an idle pass reached since the last ordinary
	// refresh. Idle passes continue only while they set a new low, so a count
	// that moves without going down (a file rewritten while counted) stops.
	let lowestPending = Number.POSITIVE_INFINITY;
	// Callers that shared one scan report it more than once: judge each scan once.
	let lastScan: object | undefined;
	let timer: ReturnType<ChangesIdleScheduler> | undefined;
	let unobserve: (() => void) | undefined;
	const stopWaiting = () => {
		timer?.cancel();
		timer = undefined;
		unobserve?.();
		unobserve = undefined;
	};
	const arm = () => {
		if (!started || !painted || turnRunning || disposed || delay === undefined || timer) return;
		timer = schedule(() => {
			timer = undefined;
			// Pi may still be compacting or settling a turn after agent_end.
			if (!isIdle()) { arm(); return; }
			stopWaiting();
			refresh();
		}, delay);
		timer.unref();
		unobserve ??= observeInput(() => {
			// A new keystroke starts a fresh quiet period without consuming it.
			timer?.cancel();
			timer = undefined;
			arm();
		});
	};
	const scanStarted = () => { delay = undefined; stopWaiting(); return turnGeneration; };
	return {
		started() { started = true; arm(); },
		firstPaint() { if (!painted) { painted = true; arm(); } },
		turnStarted() { turnRunning = true; turnGeneration++; scanStarted(); },
		turnEnded() { turnRunning = false; },
		scanStarted,
		scanFinished(pendingFiles: number, scan: object, failedRoots = 0, idleTurn?: number) {
			if (scan !== lastScan) {
				// A turn invalidates retries even if it ends before the idle scan settles.
				const idleScan = idleTurn === turnGeneration;
				const retrying = failedRoots > 0 && idleScan && retries < RETRY_DELAYS_MS.length;
				if (retrying) {
					delay = RETRY_DELAYS_MS[retries++];
				} else {
					// Once the retries run out, a failing root must not stop counts
					// that still progress on the healthy ones.
					if (failedRoots === 0 || !idleScan) retries = 0;
					const progressed = idleScan ? pendingFiles < lowestPending : pendingFiles !== lastPending;
					delay = pendingFiles > 0 && progressed ? CHANGES_QUIET_MS : undefined;
				}
				lastPending = pendingFiles;
				// While a failed root is being retried its count lists no files for
				// it and is not a low; once the retries are spent, the count is all
				// there is, and a pass that does not lower it ends the continuation.
				if (!idleScan) lowestPending = pendingFiles;
				else if (!retrying) lowestPending = Math.min(lowestPending, pendingFiles);
				lastScan = scan;
			}
			arm();
		},
		dispose() { disposed = true; stopWaiting(); },
	};
}
