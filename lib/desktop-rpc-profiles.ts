// Gentle Desktop profile-apply bridge: reaches the `/gentle:profiles` owner in
// `extensions/gentle-ai.ts` through a versioned owner-service event/adapter,
// like the usage and design seams. The owner runs the screen's own "Use in this
// session" and "Make default" actions; this bridge only validates params and
// shapes owner results into the Desktop RPC contract. There is no second apply
// implementation and no file access here.

import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";

export const DESKTOP_PROFILES_METHODS = ["apply_profile"] as const;
export const DESKTOP_PROFILE_APPLIED_EVENT = "profile_applied";
export const DESKTOP_PROFILES_EVENTS = [DESKTOP_PROFILE_APPLIED_EVENT] as const;
export const DESKTOP_PROFILES_SERVICE_SCHEMA = "gentle-pi.desktop-profiles-service/v1";
export const DESKTOP_PROFILES_SERVICE_CHANNEL = "gentle:desktop:profiles-service";

const DISCOVERY_TIMEOUT_MS = 100;
const MAX_FIELD_LENGTH = 128;
const UNAVAILABLE = { code: "profiles_unavailable", message: "Profiles owner unavailable for this session" } as const;
const INVALID_PARAMS = { code: "invalid_request", message: "Invalid apply_profile parameters" } as const;
const UNKNOWN_PROFILE = { code: "unknown_profile", message: "No saved profile with that name" } as const;
const BUSY = { code: "profile_apply_busy", message: "Another profile apply is in progress" } as const;

/** `default` is the screen's "Make default for new sessions"; `session` is "Use in this session". */
export type DesktopProfileApplyMode = "default" | "session";

export interface DesktopProfileApplyRequest {
	readonly profile: string;
	readonly mode: DesktopProfileApplyMode;
	readonly confirmation?: string;
}

export interface DesktopProfileNote {
	readonly level: "info" | "warning" | "error";
	readonly text: string;
}

export type DesktopProfileApplyResult =
	| { status: "confirmation_required"; title: string; message: string; confirmation: string }
	| { status: "applied" | "not_applied"; notes: DesktopProfileNote[] }
	| { status: "unknown_profile" }
	| { status: "busy" };

export interface DesktopProfilesService {
	readonly schema: typeof DESKTOP_PROFILES_SERVICE_SCHEMA;
	apply(request: DesktopProfileApplyRequest): Promise<DesktopProfileApplyResult>;
	dispose(): void;
}

// Process-wide: the apply owner (gentle-ai) and the Desktop config writer
// (gentle-desktop-rpc) may load this module separately, so the gate lives on a
// registered symbol rather than in module state.
const APPLY_GATE = Symbol.for("gentle-shell.desktop-profile-apply");
type GateHost = { [APPLY_GATE]?: boolean };

/**
 * Claims the single apply slot. While it is held, Desktop writes to the stores an
 * apply reads and rewrites (`profiles`, `profile_fallbacks`, `pins`) are refused,
 * so an apply's claim and rollback never overwrite an edit accepted mid-apply.
 */
export function beginDesktopProfileApply(): boolean {
	const host = globalThis as GateHost;
	if (host[APPLY_GATE]) return false;
	host[APPLY_GATE] = true;
	return true;
}

export function endDesktopProfileApply(): void {
	(globalThis as GateHost)[APPLY_GATE] = false;
}

export function isDesktopProfileApplyRunning(): boolean {
	return (globalThis as GateHost)[APPLY_GATE] === true;
}

/**
 * Binds a confirmation to the exact dialog the screen would show and to the
 * saved profile content the apply uses. Any change in the diff, the profile's
 * routes, its name or the mode yields a different token, so an apply never
 * proceeds on text the human did not see, even when the dialog lists no routes.
 */
export function desktopConfirmationToken(mode: DesktopProfileApplyMode, profile: string, title: string, message: string, config: unknown): string {
	return createHash("sha256").update(JSON.stringify([mode, profile, title, message, config])).digest("hex");
}

function isDesktopProfilesServiceShape(value: unknown): value is DesktopProfilesService {
	if (!value || typeof value !== "object") return false;
	const service = value as Partial<DesktopProfilesService>;
	return service.schema === DESKTOP_PROFILES_SERVICE_SCHEMA && typeof service.apply === "function" && typeof service.dispose === "function";
}

function boundedString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function parseApplyParams(params: Record<string, unknown>): DesktopProfileApplyRequest | undefined {
	for (const key of Object.keys(params)) {
		if (key !== "profile" && key !== "mode" && key !== "confirmation") return undefined;
	}
	if (!boundedString(params.profile)) return undefined;
	if (params.mode !== "default" && params.mode !== "session") return undefined;
	const confirmation = params.confirmation;
	if (confirmation === undefined) return { profile: params.profile, mode: params.mode };
	if (!boundedString(confirmation)) return undefined;
	return { profile: params.profile, mode: params.mode, confirmation };
}

interface ProfilesServiceRequest { context: ExtensionContext; respond(service: DesktopProfilesService): void }

/** Discover the live profiles owner: a bounded, versioned request answered only by an adapter-shaped responder. */
export function discoverDesktopProfilesService(pi: ExtensionAPI, context: ExtensionContext): Promise<DesktopProfilesService | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => { settled = true; resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
		const respond = (value: unknown) => {
			if (!isDesktopProfilesServiceShape(value)) return;
			if (settled) { value.dispose(); return; }
			settled = true; clearTimeout(timer); resolve(value);
		};
		try {
			pi.events.emit(DESKTOP_PROFILES_SERVICE_CHANNEL, { context, respond } satisfies ProfilesServiceRequest);
		} catch {
			settled = true; clearTimeout(timer); resolve(undefined);
		}
	});
}

/**
 * The Desktop domain slice for `apply_profile` and the `profile_applied` event.
 * The owner service is discovered per request with that request's command
 * context, because the apply binds to the session the request came from.
 */
export class DesktopProfilesBridge {
	private readonly pi: ExtensionAPI;
	private readonly discover: typeof discoverDesktopProfilesService;
	private host: ExtensionContext | undefined;

	constructor(pi: ExtensionAPI, discover: typeof discoverDesktopProfilesService = discoverDesktopProfilesService) {
		this.pi = pi;
		this.discover = discover;
	}

	attach(context: ExtensionContext): void {
		this.host = context;
	}

	reset(): void {
		this.host = undefined;
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method !== "apply_profile") return undefined;
		const request = parseApplyParams(params);
		if (!request) return { ok: false, error: INVALID_PARAMS };
		const context = this.host;
		if (!context) return { ok: false, error: UNAVAILABLE };
		let service: DesktopProfilesService | undefined;
		let result: DesktopProfileApplyResult;
		try {
			service = await this.discover(this.pi, context);
			if (!service) return { ok: false, error: UNAVAILABLE };
			result = await service.apply(request);
		} catch {
			return { ok: false, error: UNAVAILABLE };
		} finally {
			try {
				service?.dispose();
			} catch {
				/* owner teardown is best-effort */
			}
		}
		const subject = { profile: request.profile, mode: request.mode };
		switch (result.status) {
			case "confirmation_required":
				return {
					ok: true,
					data: { ...subject, status: result.status, confirmation: { title: result.title, message: result.message, token: result.confirmation } },
				};
			case "applied":
				return {
					ok: true,
					data: { ...subject, status: result.status, notes: result.notes },
					event: { name: DESKTOP_PROFILE_APPLIED_EVENT, data: { ...subject, source: "desktop" } },
				};
			case "not_applied":
				return { ok: true, data: { ...subject, status: result.status, notes: result.notes } };
			case "unknown_profile":
				return { ok: false, error: UNKNOWN_PROFILE };
			case "busy":
				return { ok: false, error: BUSY };
			default:
				return { ok: false, error: UNAVAILABLE };
		}
	}
}
