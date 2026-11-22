// Gentle Desktop background-subagents bridge: reaches the
// `/gentle:background-subagents` owner in `extensions/gentle-ai.ts` through a
// versioned owner-service event/adapter and answers `get_background_subagents`
// and `set_background_subagents`. It keeps no copy of the policy: every read
// and every write is the owner's own.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	BACKGROUND_SUBAGENTS_BUSY,
	BACKGROUND_SUBAGENTS_UNAVAILABLE,
	BACKGROUND_SUBAGENTS_WRITE_UNCONFIRMED,
	beginDesktopBackgroundSubagentsSet,
	DESKTOP_BACKGROUND_SUBAGENTS_SERVICE_CHANNEL,
	desktopBackgroundSubagentsConfirmation,
	endDesktopBackgroundSubagentsSet,
	INVALID_GET_BACKGROUND_SUBAGENTS,
	INVALID_SET_BACKGROUND_SUBAGENTS,
	isDesktopBackgroundSubagentsServiceShape,
	parseDesktopBackgroundSubagentsState,
	parseGetBackgroundSubagentsParams,
	parseSetBackgroundSubagentsParams,
	type BackgroundSubagentsPolicyValue,
	type DesktopBackgroundSubagentsService,
	type DesktopBackgroundSubagentsState,
} from "./desktop-rpc-background-subagents.ts";

const DISCOVERY_TIMEOUT_MS = 100;

interface ServiceRequest { context: ExtensionContext; respond(service: DesktopBackgroundSubagentsService): void }

/** Discover the live policy owner: a bounded, versioned request answered only by an adapter-shaped responder. */
export function discoverDesktopBackgroundSubagentsService(pi: ExtensionAPI, context: ExtensionContext): Promise<DesktopBackgroundSubagentsService | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isDesktopBackgroundSubagentsServiceShape(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try {
			pi.events.emit(DESKTOP_BACKGROUND_SUBAGENTS_SERVICE_CHANNEL, { context, respond } satisfies ServiceRequest);
		} catch {
			settled = true; clearTimeout(timer); resolve(undefined);
		}
	});
}

/** An owner answer, re-validated: a state, or unavailable (malformed answers count as unavailable). */
function checkState(value: unknown): DesktopBackgroundSubagentsState | undefined {
	if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== "status") return undefined;
	return parseDesktopBackgroundSubagentsState((value as { state?: unknown }).state);
}

/**
 * The Desktop domain slice for the background-subagents policy. The owner is
 * discovered per request with that request's command context and disposed
 * after it. A reset drops the bound context and supersedes any pending change.
 */
export class DesktopBackgroundSubagentsBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverDesktopBackgroundSubagentsService;
	private host: ExtensionContext | undefined;
	private generation = 0;

	constructor(pi: ExtensionAPI, options: { discover?: typeof discoverDesktopBackgroundSubagentsService } = {}) {
		this.pi = pi;
		this.discover = options.discover ?? discoverDesktopBackgroundSubagentsService;
	}

	attach(context: ExtensionContext): void {
		this.host = context;
	}

	reset(): void {
		this.generation += 1;
		this.host = undefined;
	}

	/**
	 * The generation at dispatch time. The Desktop domain captures it before its
	 * first await and passes it to `handle`, so a request that was dispatched
	 * before a session reset is refused even if a replacement session attached
	 * while it waited for the bridges ahead of this one.
	 */
	dispatchGeneration(): number {
		return this.generation;
	}

	async handle(method: string, params: Record<string, unknown>, dispatchedGeneration: number = this.generation): Promise<DesktopRpcOutcome | undefined> {
		if ((method === "get_background_subagents" || method === "set_background_subagents") && dispatchedGeneration !== this.generation) {
			return { ok: false, error: BACKGROUND_SUBAGENTS_UNAVAILABLE };
		}
		if (method === "get_background_subagents") {
			if (!parseGetBackgroundSubagentsParams(params)) return { ok: false, error: INVALID_GET_BACKGROUND_SUBAGENTS };
			return this.withOwner(async (service) => {
				const state = checkState(await service.read());
				return state ? { ok: true, data: { ...state } } : { ok: false, error: BACKGROUND_SUBAGENTS_UNAVAILABLE };
			});
		}
		if (method === "set_background_subagents") {
			// Parse before discovery: a malformed request never reaches the owner.
			const request = parseSetBackgroundSubagentsParams(params);
			if (!request) return { ok: false, error: INVALID_SET_BACKGROUND_SUBAGENTS };
			if (!beginDesktopBackgroundSubagentsSet()) return { ok: false, error: BACKGROUND_SUBAGENTS_BUSY };
			try {
				return await this.withOwner((service, generation) => this.set(service, request.policy, request.confirmationToken, generation));
			} finally {
				endDesktopBackgroundSubagentsSet();
			}
		}
		return undefined;
	}

	private async withOwner(run: (service: DesktopBackgroundSubagentsService, generation: number) => Promise<DesktopRpcOutcome>): Promise<DesktopRpcOutcome> {
		const context = this.host;
		if (!context) return { ok: false, error: BACKGROUND_SUBAGENTS_UNAVAILABLE };
		const generation = this.generation;
		let service: DesktopBackgroundSubagentsService | undefined;
		try {
			service = await this.discover(this.pi, context);
			if (!service || generation !== this.generation) return { ok: false, error: BACKGROUND_SUBAGENTS_UNAVAILABLE };
			const outcome = await run(service, generation);
			return generation === this.generation ? outcome : { ok: false, error: BACKGROUND_SUBAGENTS_UNAVAILABLE };
		} catch {
			// Owner failures can name files; none crosses.
			return { ok: false, error: BACKGROUND_SUBAGENTS_UNAVAILABLE };
		} finally {
			try { service?.dispose(); } catch { /* owner teardown is best-effort */ }
		}
	}

	private async set(service: DesktopBackgroundSubagentsService, policy: BackgroundSubagentsPolicyValue, token: string | undefined, generation: number): Promise<DesktopRpcOutcome> {
		const before = checkState(await service.read());
		// A confirmation must describe a known state; an unreadable one fails closed.
		if (!before) return { ok: false, error: BACKGROUND_SUBAGENTS_UNAVAILABLE };
		const confirmation = desktopBackgroundSubagentsConfirmation(policy, before);
		if (token !== confirmation.token) {
			// No token, a wrong one, or a stale one: ask again with the current text.
			return { ok: true, data: { status: "confirmation_required", policy, state: before, confirmation } };
		}
		// A reset while the pre-write read was pending supersedes this request.
		if (generation !== this.generation) return { ok: false, error: BACKGROUND_SUBAGENTS_UNAVAILABLE };
		let written: unknown;
		try {
			written = await service.write(policy);
		} catch {
			return { ok: false, error: BACKGROUND_SUBAGENTS_WRITE_UNCONFIRMED };
		}
		const after = checkState(written);
		if (!after) return { ok: false, error: BACKGROUND_SUBAGENTS_WRITE_UNCONFIRMED };
		return { ok: true, data: { status: "applied", policy, changed: JSON.stringify(after) !== JSON.stringify(before), state: after } };
	}
}
