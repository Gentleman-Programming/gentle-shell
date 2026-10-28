// Background monitor: pure event batching.
//
// A monitor is a background job whose every stdout line is an event for the
// agent, delivered while the command keeps running (for example
// `tail -f app.log | grep --line-buffered ERROR`, or a loop that prints each
// CI check as it finishes). Lines arriving close together share one notice,
// each notice is bounded, and a stream that floods is stopped instead of
// burning the agent's turns. This module owns no timers or processes: the
// caller flushes MONITOR_BATCH_MS after a line opens a batch. The controller
// below wires it to a job registry with an injected scheduler.

import type { JobRecord, JobRegistry, JobStartRequest } from "./background-jobs.ts";

/** Lines arriving within this window share one notice. */
export const MONITOR_BATCH_MS = 200;
/** Lines kept per notice; the rest are only counted. */
export const MONITOR_LINES_PER_NOTICE = 20;
/** More lines than this within MONITOR_FLOOD_WINDOW_MS is a flood. */
export const MONITOR_FLOOD_LINES = 120;
export const MONITOR_FLOOD_WINDOW_MS = 60_000;
/** The mandatory monitor timeout is capped at 30 minutes. */
export const MONITOR_MAX_TIMEOUT_SECONDS = 1800;

export interface MonitorBatch {
	lines: string[];
	/** Lines beyond MONITOR_LINES_PER_NOTICE, counted but not delivered. */
	omitted: number;
}

export function createEventBatcher() {
	let batch: MonitorBatch | undefined;
	let total = 0;
	// Arrival times inside the current flood window, oldest first.
	const recent: number[] = [];
	return {
		/**
		 * Records one stdout line. `opensBatch` asks the caller to schedule a
		 * flush; `flood` asks it to stop the monitor.
		 */
		pushLine(line: string, now: number): { opensBatch: boolean; flood: boolean } {
			if (line.trim().length === 0) return { opensBatch: false, flood: false };
			total += 1;
			recent.push(now);
			while (recent.length > 0 && now - recent[0]! >= MONITOR_FLOOD_WINDOW_MS) recent.shift();
			const opensBatch = batch === undefined;
			batch ??= { lines: [], omitted: 0 };
			if (batch.lines.length < MONITOR_LINES_PER_NOTICE) batch.lines.push(line);
			else batch.omitted += 1;
			return { opensBatch, flood: recent.length > MONITOR_FLOOD_LINES };
		},
		/** Takes the current batch, or undefined when no line arrived. */
		flush(): MonitorBatch | undefined {
			const taken = batch;
			batch = undefined;
			return taken;
		},
		/** Every event line seen so far. */
		total: () => total,
	};
}

/** Coalesces two pending notices for one monitor within the same line bound. */
export function mergeMonitorBatches(first: MonitorBatch, second: MonitorBatch): MonitorBatch {
	const room = Math.max(0, MONITOR_LINES_PER_NOTICE - first.lines.length);
	return {
		lines: [...first.lines, ...second.lines.slice(0, room)],
		omitted: first.omitted + second.omitted + Math.max(0, second.lines.length - room),
	};
}

export type MonitorStopReason = "timeout" | "flood";

export type MonitorNotice =
	| { job: JobRecord; kind: "events"; batch: MonitorBatch }
	| { job: JobRecord; kind: "stopped"; reason: MonitorStopReason };

export interface MonitorControllerDeps {
	registry: JobRegistry;
	schedule(fn: () => void, ms: number): () => void;
	now(): number;
	/** Hands one notice to the parent delivery router. */
	deliver(notice: MonitorNotice): void;
}

export interface MonitorStartRequest extends Omit<JobStartRequest, "kind" | "onLine"> {
	/** Mandatory: the monitor is stopped after this many seconds (1-1800). */
	timeoutSeconds: number;
}

export function createMonitorController(deps: MonitorControllerDeps) {
	const active = new Map<string, { batcher: ReturnType<typeof createEventBatcher>; cancelFlush?: () => void; cancelTimeout: () => void }>();

	const flush = (job: JobRecord) => {
		const state = active.get(job.id);
		if (!state) return;
		state.cancelFlush?.();
		state.cancelFlush = undefined;
		const batch = state.batcher.flush();
		if (batch) deps.deliver({ job, kind: "events", batch });
	};
	const cancel = (id: string) => {
		const state = active.get(id);
		if (!state) return;
		state.cancelFlush?.();
		state.cancelTimeout();
		active.delete(id);
	};
	const stopFor = (job: JobRecord, reason: MonitorStopReason) => {
		// A command that already ended reports its own exit (finish flushes it).
		if (job.status !== "running") return;
		flush(job);
		cancel(job.id);
		deps.registry.stop(job.id);
		deps.deliver({ job, kind: "stopped", reason });
	};

	return {
		start(request: MonitorStartRequest): JobRecord {
			const { timeoutSeconds, ...rest } = request;
			if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MONITOR_MAX_TIMEOUT_SECONDS) {
				throw new Error(`timeout_seconds must be a whole number from 1 to ${MONITOR_MAX_TIMEOUT_SECONDS}.`);
			}
			const batcher = createEventBatcher();
			let job: JobRecord | undefined;
			const onLine = (line: string) => {
				const state = job && active.get(job.id);
				// A stopped or finished monitor reports nothing more.
				if (!job || !state || job.status !== "running") return;
				const { opensBatch, flood } = batcher.pushLine(line, deps.now());
				job.events = batcher.total();
				if (flood) return stopFor(job, "flood");
				if (opensBatch) state.cancelFlush = deps.schedule(() => job && flush(job), MONITOR_BATCH_MS);
			};
			job = deps.registry.start({ ...rest, kind: "monitor", onLine });
			job.events = 0;
			job.timeoutSeconds = timeoutSeconds;
			const started = job;
			active.set(started.id, { batcher, cancelTimeout: deps.schedule(() => stopFor(started, "timeout"), timeoutSeconds * 1000) });
			return started;
		},
		/** The job ended on its own: deliver its pending lines before the exit notice. */
		finish(job: JobRecord) {
			flush(job);
			cancel(job.id);
		},
		/** Stopped by job_stop or a human: drop its timers and pending lines. */
		cancel,
		cancelAll() {
			for (const id of [...active.keys()]) cancel(id);
		},
	};
}

export type MonitorController = ReturnType<typeof createMonitorController>;
