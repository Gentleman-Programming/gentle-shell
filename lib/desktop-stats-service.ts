// Gentle Desktop usage-stats bridge: reaches the existing `/gentle:stats`
// owner (inside `extensions/gentle-stats.ts`, with its single size/mtime-cached
// loader) through a defensive, versioned owner-service event/adapter — the
// stats analogue of the jobs `discoverDesktopJobsService` seam. It never reads
// a session file itself and keeps no second cache: every answer is the owner's
// own history, aggregated and projected by `lib/desktop-rpc-stats.ts`.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESKTOP_STATS_SERVICE_CHANNEL,
	isDesktopStatsServiceShape,
	parseUsageStatsParams,
	projectDesktopUsageStats,
	STATS_UNAVAILABLE,
	type DesktopStatsOwnerRead,
	type DesktopStatsService,
} from "./desktop-rpc-stats.ts";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";

const DISCOVERY_TIMEOUT_MS = 100;

interface HostUiStatsRequest { context: ExtensionContext; respond(service: DesktopStatsService): void }

/**
 * Discover the live stats owner exactly like the jobs seam: emit a bounded,
 * versioned request and accept only an adapter-shaped responder.
 */
export function discoverDesktopStatsService(pi: ExtensionAPI, context: ExtensionContext): Promise<DesktopStatsService | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isDesktopStatsServiceShape(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try {
			pi.events.emit(DESKTOP_STATS_SERVICE_CHANNEL, { context, respond } satisfies HostUiStatsRequest);
		} catch {
			settled = true; clearTimeout(timer); resolve(undefined);
		}
	});
}

interface DesktopStatsBridgeOptions {
	discover?: typeof discoverDesktopStatsService;
}

/**
 * The Desktop domain slice for `get_usage_stats`. It is a read: it has no
 * event and no side effect. It owns the session-scoped lifecycle only: a reset
 * (session replacement or shutdown) drops the owner adapter and any late
 * outcome of a read that started before it.
 */
export class DesktopStatsBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverDesktopStatsService;
	private host: ExtensionContext | undefined;
	private service: DesktopStatsService | undefined;
	private discovering: Promise<DesktopStatsService | undefined> | undefined;
	private generation = 0;

	constructor(pi: ExtensionAPI, options: DesktopStatsBridgeOptions = {}) {
		this.pi = pi;
		this.discover = options.discover ?? discoverDesktopStatsService;
	}

	/** The live interactive context of this Desktop session; bound per command. */
	attach(context: ExtensionContext): void {
		this.host = context;
	}

	/** Session start/shutdown: the owner adapter of a previous session is invalid. */
	reset(): void {
		this.generation += 1;
		const service = this.service;
		this.service = undefined;
		this.discovering = undefined;
		this.host = undefined;
		try {
			service?.dispose();
		} catch {
			/* owner teardown */
		}
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method !== "get_usage_stats") return undefined;
		// Parse first: a malformed request is `invalid_request` whatever the
		// session state, and never triggers owner work.
		const query = parseUsageStatsParams(params);
		if ("error" in query) return { ok: false, error: query.error };
		const host = this.host;
		if (!host) return { ok: false, error: STATS_UNAVAILABLE };
		const generation = this.generation;
		const service = await this.owner(host);
		if (generation !== this.generation || !service) return { ok: false, error: STATS_UNAVAILABLE };
		let read: DesktopStatsOwnerRead;
		try {
			read = await service.read();
		} catch {
			// Raw owner failures can carry paths; none of it crosses the contract.
			return { ok: false, error: STATS_UNAVAILABLE };
		}
		if (generation !== this.generation) return { ok: false, error: STATS_UNAVAILABLE };
		if (!read || read.kind !== "ok" || !Array.isArray(read.sessions) || typeof read.now !== "number" || !Number.isFinite(read.now)) {
			return { ok: false, error: STATS_UNAVAILABLE };
		}
		const cwd = host.sessionManager?.getCwd?.() ?? host.cwd;
		try {
			const stats = projectDesktopUsageStats(read.sessions, { ...query, cwd, now: read.now });
			return { ok: true, data: stats as unknown as Record<string, unknown> };
		} catch {
			return { ok: false, error: STATS_UNAVAILABLE };
		}
	}

	private async owner(context: ExtensionContext): Promise<DesktopStatsService | undefined> {
		if (this.service) return this.service;
		if (!this.discovering) {
			const generation = this.generation;
			const discovering = Promise.resolve()
				.then(() => this.discover(this.pi, context))
				.then((service) => {
					// A reset happened while discovery was in flight: the late adapter
					// belongs to a superseded session. Dispose it and never cache it.
					if (generation !== this.generation || !service) {
						try { service?.dispose(); } catch { /* owner teardown */ }
						return undefined;
					}
					this.service = service;
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
}
