// Gentle Desktop changes bridge: reaches the existing changes owner (the
// `/gentle:changes` WorktreeChangesTracker inside `extensions/gentle-shell.ts`)
// through a defensive, versioned owner-service event/adapter — the changes
// analogue of the jobs `discoverDesktopJobsService` seam. It never runs Git or
// reads a file itself and keeps no second tracker: every list and every diff
// is the owner's own answer, shaped into the Desktop RPC contract by
// `lib/desktop-rpc-changes.ts`.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CHANGE_NOT_FOUND,
	CHANGES_UNAVAILABLE,
	capDesktopDiff,
	DESKTOP_CHANGE_PATH_MAX,
	DESKTOP_CHANGES_SERVICE_CHANNEL,
	isDesktopChangesServiceShape,
	isPlausibleChangePath,
	parseDesktopChangesRead,
	parseGetChangeDiffParams,
	parseGetChangesParams,
	type DesktopChangeDiff,
	type DesktopChangesService,
} from "./desktop-rpc-changes.ts";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";

const DISCOVERY_TIMEOUT_MS = 100;

interface HostUiChangesRequest { context: ExtensionContext; respond(service: DesktopChangesService): void }

/**
 * Discover the live changes owner exactly like the jobs seam: emit a bounded,
 * versioned request and accept only an adapter-shaped responder.
 */
export function discoverDesktopChangesService(pi: ExtensionAPI, context: ExtensionContext): Promise<DesktopChangesService | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isDesktopChangesServiceShape(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try {
			pi.events.emit(DESKTOP_CHANGES_SERVICE_CHANNEL, { context, respond } satisfies HostUiChangesRequest);
		} catch {
			settled = true; clearTimeout(timer); resolve(undefined);
		}
	});
}

interface DesktopChangesBridgeOptions {
	discover?: typeof discoverDesktopChangesService;
}

/**
 * The Desktop domain slice for `get_changes` and `get_change_diff`. Both are
 * reads: they never emit an event. A reset (session replacement or shutdown)
 * disposes the owner adapter and drops stale async outcomes.
 */
export class DesktopChangesBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverDesktopChangesService;
	private host: ExtensionContext | undefined;
	private service: DesktopChangesService | undefined;
	private discovering: Promise<DesktopChangesService | undefined> | undefined;
	private generation = 0;

	constructor(pi: ExtensionAPI, options: DesktopChangesBridgeOptions = {}) {
		this.pi = pi;
		this.discover = options.discover ?? discoverDesktopChangesService;
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
		if (method !== "get_changes" && method !== "get_change_diff") return undefined;
		const host = this.host;
		if (!host) return { ok: false, error: CHANGES_UNAVAILABLE };
		// Parse before discovery: a malformed request, or a path that can never
		// be in a change set, must never trigger owner or Git work.
		let target: { root: string; path: string } | undefined;
		if (method === "get_changes") {
			const parsed = parseGetChangesParams(params);
			if ("error" in parsed) return { ok: false, error: parsed.error };
		} else {
			const parsed = parseGetChangeDiffParams(params);
			if ("error" in parsed) return { ok: false, error: parsed.error };
			if (parsed.root.length === 0 || parsed.root.length > DESKTOP_CHANGE_PATH_MAX || !isPlausibleChangePath(parsed.path)) {
				return { ok: false, error: CHANGE_NOT_FOUND };
			}
			target = parsed;
		}
		const generation = this.generation;
		const service = await this.owner(host);
		if (generation !== this.generation || !service) return { ok: false, error: CHANGES_UNAVAILABLE };
		const outcome = target ? await this.diff(service, target) : await this.list(service);
		// A reset while the owner was working: the answer belongs to a replaced session.
		if (generation !== this.generation) return { ok: false, error: CHANGES_UNAVAILABLE };
		return outcome;
	}

	private async owner(context: ExtensionContext): Promise<DesktopChangesService | undefined> {
		if (this.service) return this.service;
		if (!this.discovering) {
			const generation = this.generation;
			const discovering = Promise.resolve()
				.then(() => this.discover(this.pi, context))
				.then((service) => {
					// A late adapter of a superseded session is disposed, never cached.
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

	private async list(service: DesktopChangesService): Promise<DesktopRpcOutcome> {
		try {
			const read = parseDesktopChangesRead(await service.read());
			if (!read) return { ok: false, error: CHANGES_UNAVAILABLE };
			return { ok: true, data: read as unknown as Record<string, unknown> };
		} catch {
			// Raw owner failures carry paths and Git detail; none of it crosses.
			return { ok: false, error: CHANGES_UNAVAILABLE };
		}
	}

	private async diff(service: DesktopChangesService, target: { root: string; path: string }): Promise<DesktopRpcOutcome> {
		let outcome: Awaited<ReturnType<DesktopChangesService["diff"]>>;
		try {
			outcome = await service.diff(target.root, target.path);
		} catch {
			return { ok: false, error: CHANGES_UNAVAILABLE };
		}
		if (!outcome || typeof outcome !== "object") return { ok: false, error: CHANGES_UNAVAILABLE };
		if (outcome.kind === "not_found") return { ok: false, error: CHANGE_NOT_FOUND };
		if (outcome.kind !== "ok" || typeof outcome.diff !== "string" || typeof outcome.truncated !== "boolean") {
			return { ok: false, error: CHANGES_UNAVAILABLE };
		}
		// The owner's text crosses the event bus: re-apply the bound.
		const capped = capDesktopDiff(outcome.diff);
		const data: DesktopChangeDiff = { root: target.root, path: target.path, diff: capped.diff, truncated: outcome.truncated || capped.truncated };
		return { ok: true, data: data as unknown as Record<string, unknown> };
	}
}
