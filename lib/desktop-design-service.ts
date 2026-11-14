// Gentle Desktop design-canvas bridge: reaches the existing design owner (the
// single `DesignCanvas` from `createDesignCanvas`, plus `listDesigns`, inside
// `extensions/gentle-design.ts`) through a defensive, versioned owner-service
// event/adapter — the design analogue of the usage `discoverDesktopUsageService`
// seam. It never starts a server, opens a browser, or keeps a second canvas
// store: every read and every transition is the owner's own answer, shaped into
// the Desktop RPC contract by `lib/desktop-rpc-design.ts`.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESIGN_UNAVAILABLE,
	DESKTOP_DESIGN_EVENT,
	DESKTOP_DESIGN_SERVICE_CHANNEL,
	isDesktopDesignServiceShape,
	isValidDesktopDesignOwnerState,
	parseDesktopDesignEntries,
	parseDesignCanvasParams,
	type DesktopDesignEntry,
	type DesktopDesignOwnerState,
	type DesktopDesignOwnerTransition,
	type DesktopDesignService,
} from "./desktop-rpc-design.ts";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import { isInteractiveRpcHost } from "./rpc-host.ts";

const DISCOVERY_TIMEOUT_MS = 100;

interface HostUiDesignRequest { context: ExtensionContext; respond(service: DesktopDesignService): void }

/**
 * Discover the live design owner exactly like the usage seam: emit a bounded,
 * versioned request and accept only an adapter-shaped responder.
 */
export function discoverDesktopDesignService(pi: ExtensionAPI, context: ExtensionContext): Promise<DesktopDesignService | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isDesktopDesignServiceShape(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try {
			pi.events.emit(DESKTOP_DESIGN_SERVICE_CHANNEL, { context, respond } satisfies HostUiDesignRequest);
		} catch {
			settled = true; clearTimeout(timer); resolve(undefined);
		}
	});
}

type Emit = (event: string, data: Record<string, unknown>) => void;

interface DesktopDesignBridgeOptions {
	discover?: typeof discoverDesktopDesignService;
	/** The interactive-host trust gate for URL inclusion; injectable for tests. */
	trusted?: (context: ExtensionContext) => boolean;
}

/**
 * The Desktop domain slice for `get_design_canvas` and the `design_canvas`
 * event. It is wired to the router's `emit` so agent-driven canvas transitions
 * become ordered events, and it owns the session-scoped lifecycle: a reset
 * (session replacement or shutdown) disconnects the owner observer and drops
 * stale async outcomes. There is no open/stop method here — those remain the
 * `gentle_design` tool's job.
 */
export class DesktopDesignBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverDesktopDesignService;
	private readonly trustedHost: (context: ExtensionContext) => boolean;
	private host: ExtensionContext | undefined;
	private service: DesktopDesignService | undefined;
	private discovering: Promise<DesktopDesignService | undefined> | undefined;
	private generation = 0;
	private observeDispose: (() => void) | undefined;
	private observeGeneration = 0;
	private emit: Emit | undefined;

	constructor(pi: ExtensionAPI, options: DesktopDesignBridgeOptions = {}) {
		this.pi = pi;
		this.discover = options.discover ?? discoverDesktopDesignService;
		this.trustedHost = options.trusted ?? ((context) => isInteractiveRpcHost(context.mode));
	}

	/** The live interactive context of this Desktop session; bound per command. */
	attach(context: ExtensionContext): void {
		this.host = context;
	}

	/** Route agent-driven `design_canvas` events through the router's sequencer. */
	wire(emit: Emit): void {
		this.emit = emit;
	}

	/** Eager discovery/subscription so agent-driven transitions arrive before any request. */
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
		try {
			service?.dispose();
		} catch {
			/* display-only owner teardown */
		}
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method !== "get_design_canvas") return undefined;
		const host = this.host;
		if (!host) return { ok: false, error: DESIGN_UNAVAILABLE };
		// Parse before discovery: a malformed request must never trigger owner work.
		const parsed = parseDesignCanvasParams(params);
		if ("error" in parsed) return { ok: false, error: parsed.error };
		const generation = this.generation;
		const service = await this.owner(host);
		if (generation !== this.generation || !service) return { ok: false, error: DESIGN_UNAVAILABLE };
		return this.read(service, parsed.includeUrl, host);
	}

	private async owner(context: ExtensionContext): Promise<DesktopDesignService | undefined> {
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

	private subscribe(service: DesktopDesignService): void {
		this.observeGeneration = this.generation;
		// The tokenized URL follows the same trust gate as `includeUrl` on a read:
		// only a trusted interactive Desktop client receives it in events.
		const includeUrl = this.host ? this.trustedHost(this.host) : false;
		try {
			this.observeDispose = service.observe({ includeUrl }, (transition) => this.onTransition(transition));
		} catch {
			this.observeDispose = undefined;
		}
	}

	/** Agent-driven transition: forward it exactly as the owner projected it. */
	private onTransition(transition: DesktopDesignOwnerTransition): void {
		if (this.observeGeneration !== this.generation) return;
		const emit = this.emit;
		if (!emit) return;
		emit(DESKTOP_DESIGN_EVENT, {
			transition: transition.transition,
			running: transition.running,
			slug: transition.slug,
			connectedClients: transition.connectedClients,
			...(transition.url === undefined ? {} : { url: transition.url }),
		});
	}

	private async read(service: DesktopDesignService, includeUrl: boolean, host: ExtensionContext): Promise<DesktopRpcOutcome> {
		let state: DesktopDesignOwnerState;
		try {
			const raw = await service.read();
			// The owner's answer crosses the event bus: re-validate before projecting,
			// so a foreign or malformed state can never become a malformed success.
			if (!isValidDesktopDesignOwnerState(raw)) return { ok: false, error: DESIGN_UNAVAILABLE };
			state = raw;
		} catch {
			// Raw owner failures carry paths and token detail; none of it crosses
			// the contract. An unreadable owner is treated as absent.
			return { ok: false, error: DESIGN_UNAVAILABLE };
		}

		let designs: DesktopDesignEntry[];
		try {
			const parsed = parseDesktopDesignEntries(service.listDesigns());
			// A malformed design list (non-array or a bad entry) is junk, not an
			// empty project: answer unavailable rather than echoing bad data.
			if (parsed === undefined) return { ok: false, error: DESIGN_UNAVAILABLE };
			designs = parsed;
		} catch {
			designs = [];
		}

		const wantUrl = includeUrl && this.trustedHost(host);
		let url: string | undefined;
		if (wantUrl) {
			try {
				const candidate = service.url();
				// The tokenized URL is a capability: a non-string value is dropped
				// exactly like a throwing owner, never emitted as junk.
				url = typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
			} catch {
				url = undefined;
			}
		}
		return {
			ok: true,
			data: {
				running: state.running,
				slug: state.slug,
				connectedClients: state.connectedClients,
				designs,
				...(url === undefined ? {} : { url }),
			} as unknown as Record<string, unknown>,
		};
	}
}
