// Gentle Desktop package-status bridge: reaches the `/gentle:status` owner in
// `extensions/gentle-ai.ts` through a versioned owner-service event/adapter and
// answers `get_status` with its re-validated, path-free status.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	DESKTOP_STATUS_SERVICE_CHANNEL,
	isDesktopStatusServiceShape,
	parseDesktopPackageStatus,
	parseStatusParams,
	STATUS_UNAVAILABLE,
	type DesktopStatusService,
} from "./desktop-rpc-status.ts";

const DISCOVERY_TIMEOUT_MS = 100;

interface StatusServiceRequest { context: ExtensionContext; respond(service: DesktopStatusService): void }

/** Discover the live status owner: a bounded, versioned request answered only by an adapter-shaped responder. */
export function discoverDesktopStatusService(pi: ExtensionAPI, context: ExtensionContext): Promise<DesktopStatusService | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isDesktopStatusServiceShape(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try {
			pi.events.emit(DESKTOP_STATUS_SERVICE_CHANNEL, { context, respond } satisfies StatusServiceRequest);
		} catch {
			settled = true; clearTimeout(timer); resolve(undefined);
		}
	});
}

/**
 * The Desktop domain slice for `get_status`. The owner is discovered per
 * request with that request's command context and disposed after it. A read
 * only: no event and no write. A reset drops the bound context and the answer
 * of any read that started before it.
 */
export class DesktopStatusBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverDesktopStatusService;
	private host: ExtensionContext | undefined;
	private generation = 0;

	constructor(pi: ExtensionAPI, options: { discover?: typeof discoverDesktopStatusService } = {}) {
		this.pi = pi;
		this.discover = options.discover ?? discoverDesktopStatusService;
	}

	attach(context: ExtensionContext): void {
		this.host = context;
	}

	reset(): void {
		this.generation += 1;
		this.host = undefined;
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method !== "get_status") return undefined;
		const query = parseStatusParams(params);
		if ("error" in query) return { ok: false, error: query.error };
		const host = this.host;
		if (!host) return { ok: false, error: STATUS_UNAVAILABLE };
		const generation = this.generation;
		let service: DesktopStatusService | undefined;
		try {
			service = await this.discover(this.pi, host);
			if (!service || generation !== this.generation) return { ok: false, error: STATUS_UNAVAILABLE };
			const read = await service.read();
			if (generation !== this.generation || !read || read.kind !== "status") return { ok: false, error: STATUS_UNAVAILABLE };
			const status = parseDesktopPackageStatus(read.status);
			return status ? { ok: true, data: status as unknown as Record<string, unknown> } : { ok: false, error: STATUS_UNAVAILABLE };
		} catch {
			// Owner failures can name files; none crosses.
			return { ok: false, error: STATUS_UNAVAILABLE };
		} finally {
			try { service?.dispose(); } catch { /* disposal never changes the answer */ }
		}
	}
}
