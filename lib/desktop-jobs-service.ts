// Gentle Desktop background-jobs bridge: reaches the existing jobs owner (the
// single parent-session `JobRegistry` plus the parent `MonitorController`,
// inside `extensions/gentle-agents.ts`) through a defensive, versioned
// owner-service event/adapter — the jobs analogue of the usage
// `discoverDesktopUsageService` seam. It never starts, stops, or polls a job
// itself and keeps no second registry: every list and every cancel is the
// owner's own answer, shaped into the Desktop RPC contract by
// `lib/desktop-rpc-jobs.ts`.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESKTOP_JOBS_EVENT,
	DESKTOP_JOBS_SERVICE_CHANNEL,
	isDesktopJobsServiceShape,
	JOB_NOT_FOUND,
	JOBS_UNAVAILABLE,
	parseCancelJobParams,
	parseDesktopJobEntry,
	parseListJobsParams,
	type DesktopJobEntry,
	type DesktopJobsOwnerRead,
	type DesktopJobsService,
} from "./desktop-rpc-jobs.ts";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";

const DISCOVERY_TIMEOUT_MS = 100;

/** The `jobs_update` event payload: the active session's projected job list. */
export interface DesktopJobsUpdateEvent {
	jobs: DesktopJobEntry[];
}

interface HostUiJobsRequest { context: ExtensionContext; respond(service: DesktopJobsService): void }

/**
 * Discover the live jobs owner exactly like the usage seam: emit a bounded,
 * versioned request and accept only an adapter-shaped responder.
 */
export function discoverDesktopJobsService(pi: ExtensionAPI, context: ExtensionContext): Promise<DesktopJobsService | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isDesktopJobsServiceShape(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try {
			pi.events.emit(DESKTOP_JOBS_SERVICE_CHANNEL, { context, respond } satisfies HostUiJobsRequest);
		} catch {
			settled = true; clearTimeout(timer); resolve(undefined);
		}
	});
}

type Emit = (event: string, data: Record<string, unknown>) => void;

interface DesktopJobsBridgeOptions {
	discover?: typeof discoverDesktopJobsService;
}

/**
 * The Desktop domain slice for `list_jobs`, `cancel_job`, and the `jobs_update`
 * event. It is wired to the router's `emit` so agent-driven registry changes
 * become ordered events, and it owns the session-scoped lifecycle: a reset
 * (session replacement or shutdown) disconnects the owner observer and drops
 * stale async outcomes. There is no start/run method here — those remain the
 * `bash_background`/`monitor` tools' job.
 */
export class DesktopJobsBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverDesktopJobsService;
	private host: ExtensionContext | undefined;
	private service: DesktopJobsService | undefined;
	private discovering: Promise<DesktopJobsService | undefined> | undefined;
	private generation = 0;
	private observeDispose: (() => void) | undefined;
	private observeGeneration = 0;
	private emit: Emit | undefined;
	/** Byte-identical projected list already emitted; suppresses observer duplicates. */
	private lastEmittedJobs: string | undefined;

	constructor(pi: ExtensionAPI, options: DesktopJobsBridgeOptions = {}) {
		this.pi = pi;
		this.discover = options.discover ?? discoverDesktopJobsService;
	}

	/** The live interactive context of this Desktop session; bound per command. */
	attach(context: ExtensionContext): void {
		this.host = context;
	}

	/** Route agent-driven `jobs_update` events through the router's sequencer. */
	wire(emit: Emit): void {
		this.emit = emit;
	}

	/** Eager discovery/subscription so agent-driven job changes arrive before any request. */
	async start(): Promise<void> {
		const host = this.host;
		if (!host) return;
		await this.owner(host);
	}

	/** Session start/shutdown: the owner adapter of a previous session is invalid. */
	reset(): void {
		this.generation += 1;
		this.observeDispose?.();
		this.observeDispose = undefined;
		const service = this.service;
		this.service = undefined;
		this.discovering = undefined;
		this.host = undefined;
		this.emit = undefined;
		this.lastEmittedJobs = undefined;
		try {
			service?.dispose();
		} catch {
			/* owner teardown */
		}
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method !== "list_jobs" && method !== "cancel_job") return undefined;
		const host = this.host;
		if (!host) return { ok: false, error: JOBS_UNAVAILABLE };
		// Parse before discovery: a malformed request must never trigger owner work.
		if (method === "list_jobs") {
			const parsed = parseListJobsParams(params);
			if ("error" in parsed) return { ok: false, error: parsed.error };
		} else {
			const parsed = parseCancelJobParams(params);
			if ("error" in parsed) return { ok: false, error: parsed.error };
		}
		const generation = this.generation;
		const service = await this.owner(host);
		if (generation !== this.generation || !service) return { ok: false, error: JOBS_UNAVAILABLE };
		return method === "list_jobs" ? this.list(service) : this.cancel(service, params);
	}

	private async owner(context: ExtensionContext): Promise<DesktopJobsService | undefined> {
		if (this.service) return this.service;
		if (!this.discovering) {
			const generation = this.generation;
			const discovering = Promise.resolve()
				.then(() => this.discover(this.pi, context))
				.then((service) => {
					// A reset/replacement happened while discovery was in flight: the
					// late adapter belongs to a superseded session. Dispose it and never
					// cache or re-subscribe it for the next session.
					if (generation !== this.generation || !service) {
						try { service?.dispose(); } catch { /* owner teardown */ }
						return undefined;
					}
					this.service = service;
					this.subscribe(service);
					return service;
				})
				.catch(() => undefined)
				.finally(() => {
					if (this.discovering === discovering) this.discovering = undefined;
				});
			this.discovering = discovering;
		}
		return this.discovering;
	}

	private subscribe(service: DesktopJobsService): void {
		this.observeGeneration = this.generation;
		try {
			this.observeDispose = service.observe((sessionId) => this.onChanged(service, sessionId));
		} catch {
			this.observeDispose = undefined;
		}
	}

	/** Agent-driven registry change: forward the active session's projected list. */
	private onChanged(service: DesktopJobsService, sessionId: string): void {
		if (this.observeGeneration !== this.generation) return;
		const host = this.host;
		const emit = this.emit;
		if (!host || !emit) return;
		if (sessionId !== this.activeSessionId(host)) return;
		const read = this.readOwner(service);
		if (!read) return;
		// A single registry change can reach the observer more than once (for
		// example a monitor self-stop flushes its pending lines and then stops).
		// Dedupe byte-identical projected lists so each real change emits once.
		const key = JSON.stringify(read.jobs);
		if (key === this.lastEmittedJobs) return;
		this.lastEmittedJobs = key;
		emit(DESKTOP_JOBS_EVENT, { jobs: read.jobs } satisfies DesktopJobsUpdateEvent);
	}

	private activeSessionId(host: ExtensionContext): string {
		return host.sessionManager?.getSessionId?.() ?? "";
	}

	private readOwner(service: DesktopJobsService): DesktopJobsOwnerRead | undefined {
		try {
			const read = service.read();
			if (!read || typeof read !== "object") return undefined;
			const jobs = this.parseJobs(read.jobs);
			if (jobs === undefined) return undefined;
			return { sessionId: read.sessionId, jobs };
		} catch {
			// Raw owner failures carry paths and command detail; none of it crosses
			// the contract. An unreadable owner is treated as absent.
			return undefined;
		}
	}

	private parseJobs(value: unknown): DesktopJobEntry[] | undefined {
		if (!Array.isArray(value)) return undefined;
		const jobs: DesktopJobEntry[] = [];
		for (const entry of value) {
			const parsed = parseDesktopJobEntry(entry);
			if (parsed === undefined) return undefined;
			jobs.push(parsed);
		}
		return jobs;
	}

	private list(service: DesktopJobsService): DesktopRpcOutcome {
		const read = this.readOwner(service);
		if (!read) return { ok: false, error: JOBS_UNAVAILABLE };
		return { ok: true, data: { jobs: read.jobs } as unknown as Record<string, unknown> };
	}

	private cancel(service: DesktopJobsService, params: Record<string, unknown>): DesktopRpcOutcome {
		// Params were already validated before discovery; reparse defensively.
		const parsed = parseCancelJobParams(params);
		if ("error" in parsed) return { ok: false, error: parsed.error };
		let outcome: ReturnType<DesktopJobsService["cancel"]>;
		try {
			outcome = service.cancel(parsed.id);
		} catch {
			// Raw owner failures carry paths and command detail; none of it crosses.
			return { ok: false, error: JOBS_UNAVAILABLE };
		}
		if (!outcome || outcome.kind === "not_found") return { ok: false, error: JOB_NOT_FOUND };
		// The owner's projected job crosses the event bus: re-validate it.
		const job = parseDesktopJobEntry(outcome.job);
		if (job === undefined) return { ok: false, error: JOBS_UNAVAILABLE };
		const data = { job } as unknown as Record<string, unknown>;
		// A no-op (already-terminal) cancellation changes nothing: answer the
		// terminal state and emit no event.
		if (outcome.changed !== true) return { ok: true, data };
		// Response-before-event: carry the event so the router publishes the
		// response line first, then one `jobs_update` with the post-action list.
		const read = this.readOwner(service);
		const jobs = read ? read.jobs : [job];
		this.lastEmittedJobs = JSON.stringify(jobs);
		return {
			ok: true,
			data,
			event: {
				name: DESKTOP_JOBS_EVENT,
				data: { jobs } satisfies DesktopJobsUpdateEvent,
			},
		};
	}
}
