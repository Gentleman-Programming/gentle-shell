// Gentle Desktop review-mode bridge (#3324): reaches the review-mode owner in
// `extensions/gentle-ai.ts` (the native review CLI adapter behind
// `/gentle:review-mode`) through a defensive, versioned owner-service
// event/adapter, like the jobs and profiles seams. It never spawns `gentle-ai`
// and keeps no copy of the switch: every read and every write is the owner's
// own, shaped into the Desktop RPC contract by `lib/desktop-rpc-review.ts`.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	beginDesktopReviewModeSet,
	DESKTOP_REVIEW_MODE_CHANGED_EVENT,
	DESKTOP_REVIEW_SERVICE_CHANNEL,
	desktopReviewModeConfirmation,
	endDesktopReviewModeSet,
	INVALID_GET_REVIEW_MODE,
	INVALID_SET_REVIEW_MODE,
	isDesktopReviewServiceShape,
	parseDesktopReviewOwnerStatus,
	parseGetReviewModeParams,
	parseSetReviewModeParams,
	projectDesktopReviewMode,
	REVIEW_MODE_BUSY,
	REVIEW_STATE_UNREADABLE,
	REVIEW_UNAVAILABLE,
	REVIEW_WRITE_UNCONFIRMED,
	type DesktopReviewOwnerStatus,
	type DesktopReviewService,
	type DesktopReviewSetRequest,
} from "./desktop-rpc-review.ts";

const DISCOVERY_TIMEOUT_MS = 100;

interface ReviewServiceRequest { context: ExtensionContext; respond(service: DesktopReviewService): void }

/** Discover the live review-mode owner: a bounded, versioned request answered only by an adapter-shaped responder. */
export function discoverDesktopReviewService(pi: ExtensionAPI, context: ExtensionContext): Promise<DesktopReviewService | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isDesktopReviewServiceShape(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try {
			pi.events.emit(DESKTOP_REVIEW_SERVICE_CHANNEL, { context, respond } satisfies ReviewServiceRequest);
		} catch {
			settled = true; clearTimeout(timer); resolve(undefined);
		}
	});
}

interface DesktopReviewBridgeOptions {
	discover?: typeof discoverDesktopReviewService;
}

/** An owner read, re-validated: a status, `unknown` (fail closed), or `unavailable`. */
type CheckedRead = { kind: "status"; status: DesktopReviewOwnerStatus } | { kind: "unknown" } | { kind: "unavailable" };

function checkRead(value: unknown): CheckedRead {
	if (!value || typeof value !== "object") return { kind: "unknown" };
	const read = value as { kind?: unknown; status?: unknown };
	if (read.kind === "unavailable") return { kind: "unavailable" };
	if (read.kind !== "status") return { kind: "unknown" };
	const status = parseDesktopReviewOwnerStatus(read.status);
	return status ? { kind: "status", status } : { kind: "unknown" };
}

/**
 * The Desktop domain slice for `get_review_mode`, `set_review_mode`, and the
 * `review_mode_changed` event. The owner is discovered per request with that
 * request's command context (the switch is read for that session's workspace)
 * and disposed after it. A change needs two calls: the first answers the
 * confirmation dialog and its token, and only a second call carrying a token
 * that still matches the current state writes.
 */
export class DesktopReviewBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverDesktopReviewService;
	private host: ExtensionContext | undefined;
	private generation = 0;

	constructor(pi: ExtensionAPI, options: DesktopReviewBridgeOptions = {}) {
		this.pi = pi;
		this.discover = options.discover ?? discoverDesktopReviewService;
	}

	attach(context: ExtensionContext): void {
		this.host = context;
	}

	reset(): void {
		this.generation += 1;
		this.host = undefined;
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method === "get_review_mode") {
			if (!parseGetReviewModeParams(params)) return { ok: false, error: INVALID_GET_REVIEW_MODE };
			return this.withOwner((service) => this.get(service));
		}
		if (method === "set_review_mode") {
			// Parse before discovery: a malformed request never reaches the owner.
			const request = parseSetReviewModeParams(params);
			if (!request) return { ok: false, error: INVALID_SET_REVIEW_MODE };
			if (!beginDesktopReviewModeSet()) return { ok: false, error: REVIEW_MODE_BUSY };
			try {
				return await this.withOwner((service, generation) => this.set(service, request, generation));
			} finally {
				endDesktopReviewModeSet();
			}
		}
		return undefined;
	}

	private async withOwner(run: (service: DesktopReviewService, generation: number) => Promise<DesktopRpcOutcome>): Promise<DesktopRpcOutcome> {
		const context = this.host;
		if (!context) return { ok: false, error: REVIEW_UNAVAILABLE };
		const generation = this.generation;
		let service: DesktopReviewService | undefined;
		try {
			service = await this.discover(this.pi, context);
			if (!service || generation !== this.generation) return { ok: false, error: REVIEW_UNAVAILABLE };
			return await run(service, generation);
		} catch {
			return { ok: false, error: REVIEW_UNAVAILABLE };
		} finally {
			try {
				service?.dispose();
			} catch {
				/* owner teardown is best-effort */
			}
		}
	}

	private async read(service: DesktopReviewService): Promise<CheckedRead> {
		try {
			return checkRead(await service.read());
		} catch {
			// Raw owner failures can carry paths and CLI detail; none crosses.
			return { kind: "unknown" };
		}
	}

	private async get(service: DesktopReviewService): Promise<DesktopRpcOutcome> {
		const read = await this.read(service);
		if (read.kind === "unavailable") return { ok: false, error: REVIEW_UNAVAILABLE };
		return { ok: true, data: { ...projectDesktopReviewMode(read.kind === "status" ? read.status : undefined) } };
	}

	private async set(service: DesktopReviewService, request: DesktopReviewSetRequest & { confirmationToken?: string }, generation: number): Promise<DesktopRpcOutcome> {
		const subject: DesktopReviewSetRequest = { enabled: request.enabled, scope: request.scope };
		const before = await this.read(service);
		if (before.kind === "unavailable") return { ok: false, error: REVIEW_UNAVAILABLE };
		// A confirmation must describe a known state; an unreadable one fails closed.
		if (before.kind === "unknown") return { ok: false, error: REVIEW_STATE_UNREADABLE };
		const previousMode = projectDesktopReviewMode(before.status);
		const confirmation = desktopReviewModeConfirmation(subject, before.status);
		if (request.confirmationToken !== confirmation.token) {
			// No token, a wrong token, or a stale one (the state changed since it
			// was shown): ask again with the current text and a fresh token.
			return { ok: true, data: { status: "confirmation_required", ...subject, mode: previousMode, confirmation } };
		}
		// A reset (session replacement or shutdown) while the pre-write read was
		// pending supersedes this request: its publisher is gone, so never write
		// the switch on its behalf. Like the other slices' stale outcomes, the
		// answer is unavailable, which the router drops; the client re-reads.
		if (generation !== this.generation) return { ok: false, error: REVIEW_UNAVAILABLE };
		let written: unknown;
		try {
			written = await service.write(subject);
		} catch {
			return { ok: false, error: REVIEW_WRITE_UNCONFIRMED };
		}
		if (written && typeof written === "object" && (written as { kind?: unknown }).kind === "failed") return { ok: false, error: REVIEW_WRITE_UNCONFIRMED };
		const after = checkRead(written);
		if (after.kind === "unavailable") return { ok: false, error: REVIEW_UNAVAILABLE };
		const mode = projectDesktopReviewMode(after.kind === "status" ? after.status : undefined);
		// Only a confirmed re-read that differs from the state shown is a change;
		// a no-op or an unreadable re-read emits nothing.
		const changed = after.kind === "status" && JSON.stringify(mode) !== JSON.stringify(previousMode);
		const data = { status: "applied", ...subject, changed, mode };
		if (!changed) return { ok: true, data };
		return { ok: true, data, event: { name: DESKTOP_REVIEW_MODE_CHANGED_EVENT, data: { mode, previousMode } } };
	}
}
