// Gentle Desktop subscription-usage bridge: reaches the existing usage owner
// (UsageStore / UsageSourceRegistry / refreshUsage / after_provider_response
// closures inside `extensions/gentle-shell.ts`) through a defensive, versioned
// owner-service event/adapter — the usage analogue of the YOLO
// `discoverYoloUiAdapter` seam. It never fetches, resolves auth, or keeps a
// second store: every read and every refresh is the owner's own answer, shaped
// into the Desktop RPC contract by `lib/desktop-rpc-usage.ts`.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DESKTOP_USAGE_EVENT,
	DESKTOP_USAGE_SERVICE_CHANNEL,
	DESKTOP_USAGE_STALE_MS,
	desktopUsageStatus,
	isDesktopUsageServiceShape,
	parseDesktopUsageOwnerEntry,
	parseUsageProviderParam,
	projectUsageEntry,
	USAGE_UNAVAILABLE,
	type DesktopUsageEntry,
	type DesktopUsageOwnerEntry,
	type DesktopUsageOwnerRead,
	type DesktopUsageRecordedSnapshot,
	type DesktopUsageService,
	type DesktopRateLimitEvent,
} from "./desktop-rpc-usage.ts";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import { parseProviderUsage, type ProviderUsage } from "./shell-usage.ts";

const DISCOVERY_TIMEOUT_MS = 100;

/** A content identity that deliberately excludes `fetchedAt`: a snapshot that
 * changed its payload within the same millisecond still differs, while
 * byte-equivalent data — whatever timestamp the owner stamped on it — is a
 * no-op. The objects are freshly rebuilt by `parseProviderUsage`, so their key
 * order is fixed and the JSON is stable for equivalent content. */
function usageContentKey(usage: ProviderUsage): string {
	return JSON.stringify({ provider: usage.provider, plan: usage.plan, limits: usage.limits });
}

interface HostUiUsageRequest { context: ExtensionContext; respond(service: DesktopUsageService): void }

/** Discover the live usage owner exactly like the YOLO seam: emit a bounded,
 * versioned request and accept only an adapter-shaped responder. */
export function discoverDesktopUsageService(pi: ExtensionAPI, context: ExtensionContext): Promise<DesktopUsageService | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isDesktopUsageServiceShape(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try {
			pi.events.emit(DESKTOP_USAGE_SERVICE_CHANNEL, { context, respond } satisfies HostUiUsageRequest);
		} catch {
			settled = true; clearTimeout(timer); resolve(undefined);
		}
	});
}

type Emit = (event: string, data: Record<string, unknown>) => void;

interface DesktopUsageBridgeOptions {
	discover?: typeof discoverDesktopUsageService;
	now?: () => number;
	staleAfterMs?: number;
}

/**
 * The Desktop domain slice for `get_subscription_usage` and
 * `refresh_subscription_usage`. It is wired to the router's `emit` so header-
 * driven snapshots become `rate_limit` events, and it owns the session-scoped
 * lifecycle: a reset (session replacement or shutdown) disconnects the owner
 * observer and drops stale async outcomes.
 */
export class DesktopUsageBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverDesktopUsageService;
	private readonly now: () => number;
	private readonly staleAfterMs: number;
	private host: ExtensionContext | undefined;
	private service: DesktopUsageService | undefined;
	private discovering: Promise<DesktopUsageService | undefined> | undefined;
	private generation = 0;
	private observeDispose: (() => void) | undefined;
	private observeGeneration = 0;
	private emit: Emit | undefined;

	constructor(pi: ExtensionAPI, options: DesktopUsageBridgeOptions = {}) {
		this.pi = pi;
		this.discover = options.discover ?? discoverDesktopUsageService;
		this.now = options.now ?? (() => Date.now());
		this.staleAfterMs = options.staleAfterMs ?? DESKTOP_USAGE_STALE_MS;
	}

	/** The live interactive context of this Desktop session; bound per command. */
	attach(context: ExtensionContext): void {
		this.host = context;
	}

	/** Route header-driven `rate_limit` events through the router's sequencer. */
	wire(emit: Emit): void {
		this.emit = emit;
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
		if (method !== "get_subscription_usage" && method !== "refresh_subscription_usage") return undefined;
		const host = this.host;
		if (!host) return { ok: false, error: USAGE_UNAVAILABLE };
		const generation = this.generation;
		const service = await this.owner(host);
		if (generation !== this.generation || !service) return { ok: false, error: USAGE_UNAVAILABLE };
		if (method === "get_subscription_usage") return this.read(service, params);
		return this.refresh(service, params, generation);
	}

	private async owner(context: ExtensionContext): Promise<DesktopUsageService | undefined> {
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

	private subscribe(service: DesktopUsageService): void {
		this.observeGeneration = this.generation;
		try {
			this.observeDispose = service.observe((recorded) => this.onRecorded(recorded));
		} catch {
			this.observeDispose = undefined;
		}
	}

	/** Header-driven recording: the owner already parsed the headers. */
	private onRecorded(recorded: DesktopUsageRecordedSnapshot): void {
		if (this.observeGeneration !== this.generation) return;
		const emit = this.emit;
		if (!emit) return;
		const usage = this.validatedSnapshot(recorded);
		if (!usage) return;
		// A response-carried snapshot is fresh by definition; it is never
		// refreshed, so the status is always `ok` here.
		const entry = projectUsageEntry(recorded.provider, "ok", usage);
		emit(DESKTOP_USAGE_EVENT, { source: "response", snapshots: [entry] } satisfies DesktopRateLimitEvent);
	}

	/** The owner's snapshot crosses the event bus: re-validate before projecting. */
	private validatedSnapshot(recorded: DesktopUsageRecordedSnapshot): ProviderUsage | undefined {
		if (!recorded || typeof recorded !== "object") return undefined;
		if (typeof recorded.provider !== "string") return undefined;
		return parseProviderUsage(recorded.usage, recorded.provider);
	}

	private read(service: DesktopUsageService, params: Record<string, unknown>): DesktopRpcOutcome {
		const parsed = parseUsageProviderParam(params);
		if ("error" in parsed) return { ok: false, error: parsed.error };
		const providers = this.projectRead(service, parsed.provider, undefined, false);
		return { ok: true, data: { providers } as unknown as Record<string, unknown> };
	}

	private async refresh(service: DesktopUsageService, params: Record<string, unknown>, generation: number): Promise<DesktopRpcOutcome> {
		const parsed = parseUsageProviderParam(params);
		if ("error" in parsed) return { ok: false, error: parsed.error };
		const provider = parsed.provider;
		const before = this.readOwner(service, provider);
		let after: DesktopUsageOwnerRead;
		try {
			// The owner's refresh result crosses the event bus, so it is re-validated
			// before anything is projected or diffed.
			after = this.parseOwnerRead(await service.refresh(provider));
		} catch {
			// Raw owner failures carry endpoint/key detail; none of it crosses the
			// contract. Fall back to the current owner state (which still reports a
			// truthful pending/failed) and never fabricate a snapshot.
			after = this.readOwner(service, provider);
		}
		if (generation !== this.generation) return { ok: false, error: USAGE_UNAVAILABLE };
		const providers = this.projectRead(service, provider, after, true);
		// Exactly one rate_limit event per response, carrying every snapshot this
		// refresh actually changed. A no-op (unsupported, throttled, or failed)
		// refresh changes nothing and therefore emits no duplicate event.
		const snapshots = this.changedSnapshots(before, after);
		const data = { providers } as unknown as Record<string, unknown>;
		if (snapshots.length === 0) return { ok: true, data };
		return {
			ok: true,
			data,
			event: {
				name: DESKTOP_USAGE_EVENT,
				data: { source: "refresh", snapshots } satisfies DesktopRateLimitEvent,
			},
		};
	}

	private parseOwnerRead(value: unknown): DesktopUsageOwnerRead {
		if (!value || typeof value !== "object") return { providers: [] };
		const raw = value as { providers?: unknown };
		if (!Array.isArray(raw.providers)) return { providers: [] };
		return {
			providers: raw.providers
				.map((entry) => parseDesktopUsageOwnerEntry(entry))
				.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
		};
	}

	private readOwner(service: DesktopUsageService, provider: string | undefined): DesktopUsageOwnerRead {
		try {
			return this.parseOwnerRead(service.read(provider));
		} catch {
			return { providers: [] };
		}
	}

	private projectRead(
		service: DesktopUsageService,
		provider: string | undefined,
		read: DesktopUsageOwnerRead | undefined,
		markRefreshDisposition: boolean,
	): DesktopUsageEntry[] {
		const owners = read ?? this.readOwner(service, provider);
		const now = this.now();
		return owners.providers.map((owner) => {
			const snapshot = owner.snapshot === undefined ? undefined : parseProviderUsage(owner.snapshot, owner.provider);
			const status = desktopUsageStatus({
				supported: owner.supported,
				refreshable: owner.refreshable,
				failed: owner.failed,
				fetchedAt: snapshot?.fetchedAt,
				now,
				staleAfterMs: this.staleAfterMs,
			});
			return projectUsageEntry(owner.provider, status, snapshot, {
				refresh: markRefreshDisposition ? this.refreshDisposition(owner) : undefined,
			});
		});
	}

	/** The typed no-op marker a refresh answer reports, in precedence order. */
	private refreshDisposition(owner: DesktopUsageOwnerEntry): "unsupported" | "out_of_scope" | undefined {
		// The owner said it never even attempted the fetch: the provider is outside
		// the current session scope. This wins for a refreshable provider so a
		// client can tell an out-of-scope no-op from a supported-but-header-only one.
		if (owner.outOfScope === true && owner.refreshable) return "out_of_scope";
		if (owner.supported && !owner.refreshable) return "unsupported";
		return undefined;
	}

	private changedSnapshots(before: DesktopUsageOwnerRead, after: DesktopUsageOwnerRead): DesktopUsageEntry[] {
		const beforeByProvider = new Map(before.providers.map((entry) => [entry.provider, entry]));
		const changed: DesktopUsageEntry[] = [];
		for (const entry of after.providers) {
			const previous = beforeByProvider.get(entry.provider);
			const afterSnapshot = entry.snapshot === undefined ? undefined : parseProviderUsage(entry.snapshot, entry.provider);
			const beforeSnapshot = previous?.snapshot === undefined ? undefined : parseProviderUsage(previous.snapshot, entry.provider);
			// Compare the actual snapshot content, not only `fetchedAt`: a payload
		// that changed within the same millisecond still emits, while byte-equivalent
		// data (whatever its timestamp) stays a no-op. A failure (still no snapshot)
		// is not a change.
			if (afterSnapshot && usageContentKey(afterSnapshot) !== (beforeSnapshot ? usageContentKey(beforeSnapshot) : undefined)) {
				const status = desktopUsageStatus({
					supported: entry.supported,
					refreshable: entry.refreshable,
					failed: entry.failed,
					fetchedAt: afterSnapshot.fetchedAt,
					now: this.now(),
					staleAfterMs: this.staleAfterMs,
				});
				changed.push(projectUsageEntry(entry.provider, status, afterSnapshot));
			}
		}
		return changed;
	}
}
