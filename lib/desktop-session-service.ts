// Gentle Desktop session-state bridge (#3319): reaches the existing session
// projection owner (the feed extension, `extensions/gentle-desktop-feed.ts`)
// through a defensive, versioned owner-service event/adapter — the session
// analogue of `discoverDesktopJobsService`. It never reads the feed's file and
// keeps no state of its own beyond the last sections it emitted: every read is
// the owner's live projection, shaped by `lib/desktop-rpc-session.ts`.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopFeedSnapshot } from "./desktop-feed.ts";
import {
	DESKTOP_SESSION_EVENT,
	DESKTOP_SESSION_SECTIONS,
	DESKTOP_SESSION_SERVICE_CHANNEL,
	desktopSessionSectionKey,
	isDesktopSessionServiceShape,
	parseSessionSnapshotParams,
	projectDesktopSessionSections,
	SESSION_UNAVAILABLE,
	type DesktopSessionSection,
	type DesktopSessionSections,
	type DesktopSessionService,
} from "./desktop-rpc-session.ts";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";

const DISCOVERY_TIMEOUT_MS = 100;

/** The `session_snapshot` event payload: only the sections whose content changed. */
export interface DesktopSessionSnapshotEvent {
	sections: DesktopSessionSections;
}

interface HostUiSessionRequest { context: ExtensionContext; respond(service: DesktopSessionService): void }

/**
 * Discover the live feed owner exactly like the jobs seam: emit a bounded,
 * versioned request and accept only an adapter-shaped responder.
 */
export function discoverDesktopSessionService(pi: ExtensionAPI, context: ExtensionContext): Promise<DesktopSessionService | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isDesktopSessionServiceShape(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try {
			pi.events.emit(DESKTOP_SESSION_SERVICE_CHANNEL, { context, respond } satisfies HostUiSessionRequest);
		} catch {
			settled = true; clearTimeout(timer); resolve(undefined);
		}
	});
}

type Emit = (event: string, data: Record<string, unknown>) => void;

interface DesktopSessionBridgeOptions {
	discover?: typeof discoverDesktopSessionService;
}

/**
 * The Desktop domain slice for `get_snapshot { sections }` and the
 * `session_snapshot` event. The feed owner publishes on its own tiers (urgent,
 * debounced, busy-throttled); this bridge only diffs each published snapshot
 * against the sections it last emitted and forwards the changed ones.
 */
export class DesktopSessionBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverDesktopSessionService;
	private host: ExtensionContext | undefined;
	private service: DesktopSessionService | undefined;
	private discovering: Promise<DesktopSessionService | undefined> | undefined;
	private generation = 0;
	private observeDispose: (() => void) | undefined;
	private emit: Emit | undefined;
	/** Per-section comparison keys of the last state emitted (or seen at subscription). */
	private baseline = new Map<DesktopSessionSection, string>();

	constructor(pi: ExtensionAPI, options: DesktopSessionBridgeOptions = {}) {
		this.pi = pi;
		this.discover = options.discover ?? discoverDesktopSessionService;
	}

	/** True while the feed owner seam is wired for this session: gates `capabilities`. */
	get wired(): boolean {
		return this.service !== undefined;
	}

	/** The live interactive context of this Desktop session; bound per command. */
	attach(context: ExtensionContext): void {
		this.host = context;
	}

	/** Route feed-published changes through the router's sequencer. */
	wire(emit: Emit): void {
		this.emit = emit;
	}

	/** Eager discovery/subscription so feed changes arrive before any request. */
	async start(): Promise<void> {
		const host = this.host;
		if (!host) return;
		await this.owner(host);
	}

	/** Session start/shutdown: the owner adapter of a previous session is invalid. */
	reset(): void {
		this.generation += 1;
		try { this.observeDispose?.(); } catch { /* owner teardown */ }
		this.observeDispose = undefined;
		const service = this.service;
		this.service = undefined;
		this.discovering = undefined;
		this.host = undefined;
		this.emit = undefined;
		this.baseline = new Map();
		try {
			service?.dispose();
		} catch {
			/* owner teardown */
		}
	}

	/**
	 * `get_snapshot` sections. `undefined` (synchronously) when the request
	 * names no `sections`, so the router answers its legacy snapshot unchanged;
	 * malformed sections fail before any owner work.
	 */
	snapshot(params: Record<string, unknown>): DesktopRpcOutcome | Promise<DesktopRpcOutcome> | undefined {
		const parsed = parseSessionSnapshotParams(params);
		if ("legacy" in parsed) return undefined;
		if ("error" in parsed) return { ok: false, error: parsed.error };
		const host = this.host;
		if (!host) return { ok: false, error: SESSION_UNAVAILABLE };
		const generation = this.generation;
		return this.owner(host).then((service): DesktopRpcOutcome => {
			if (generation !== this.generation || !service) return { ok: false, error: SESSION_UNAVAILABLE };
			const snapshot = this.readOwner(service);
			if (!snapshot) return { ok: false, error: SESSION_UNAVAILABLE };
			return { ok: true, data: projectDesktopSessionSections(snapshot, parsed.sections) as Record<string, unknown> };
		});
	}

	private async owner(context: ExtensionContext): Promise<DesktopSessionService | undefined> {
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

	private subscribe(service: DesktopSessionService): void {
		const generation = this.generation;
		// The state at subscription is the baseline: the first event carries
		// only what changed after it.
		const current = this.readOwner(service);
		if (current) this.baseline = this.keys(projectDesktopSessionSections(current, DESKTOP_SESSION_SECTIONS));
		try {
			this.observeDispose = service.observe((snapshot) => {
				if (generation !== this.generation) return;
				this.onSnapshot(snapshot);
			});
		} catch {
			this.observeDispose = undefined;
		}
	}

	private keys(sections: DesktopSessionSections): Map<DesktopSessionSection, string> {
		const keys = new Map<DesktopSessionSection, string>();
		for (const name of DESKTOP_SESSION_SECTIONS) keys.set(name, desktopSessionSectionKey(name, sections[name]));
		return keys;
	}

	/** A feed-published snapshot: forward only the sections whose content changed. */
	private onSnapshot(snapshot: DesktopFeedSnapshot): void {
		const emit = this.emit;
		if (!emit) return;
		let sections: DesktopSessionSections;
		try {
			sections = projectDesktopSessionSections(snapshot, DESKTOP_SESSION_SECTIONS);
		} catch {
			return;
		}
		const keys = this.keys(sections);
		const changed: DesktopSessionSections = {};
		let any = false;
		for (const name of DESKTOP_SESSION_SECTIONS) {
			if (keys.get(name) === this.baseline.get(name)) continue;
			changed[name] = sections[name];
			any = true;
		}
		if (!any) return;
		this.baseline = keys;
		emit(DESKTOP_SESSION_EVENT, { sections: changed } satisfies DesktopSessionSnapshotEvent as unknown as Record<string, unknown>);
	}

	private readOwner(service: DesktopSessionService): DesktopFeedSnapshot | undefined {
		try {
			const snapshot = service.read();
			return snapshot && typeof snapshot === "object" ? snapshot : undefined;
		} catch {
			// Raw owner failures may carry paths; none of it crosses the contract.
			return undefined;
		}
	}
}
