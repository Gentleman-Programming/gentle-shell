// Gentle Desktop review-mode contract (#3324): the pure wire shapes, the
// owner-service interface, strict param parsers, the whitelist projection of
// the owner's receipt-driven development (RDD) status, and the confirmation
// text and token. The owner is `extensions/gentle-ai.ts`, which reads and
// writes the switch through the same native review CLI adapter the
// `/gentle:review-mode` command uses; nothing here runs `gentle-ai`.

import { createHash } from "node:crypto";

export const DESKTOP_REVIEW_METHODS = ["get_review_mode", "set_review_mode"] as const;
export const DESKTOP_REVIEW_MODE_CHANGED_EVENT = "review_mode_changed";
export const DESKTOP_REVIEW_EVENTS = [DESKTOP_REVIEW_MODE_CHANGED_EVENT] as const;
export const DESKTOP_REVIEW_SERVICE_SCHEMA = "gentle-pi.desktop-review-service/v1";
export const DESKTOP_REVIEW_SERVICE_CHANNEL = "gentle:desktop:review-service";

const MAX_TOKEN_LENGTH = 128;

export const REVIEW_UNAVAILABLE = { code: "review_unavailable", message: "Review mode is not available in this session" } as const;
export const REVIEW_STATE_UNREADABLE = { code: "review_unavailable", message: "Review mode could not be read; nothing was changed" } as const;
export const REVIEW_WRITE_UNCONFIRMED = { code: "review_unavailable", message: "The review mode change did not complete; re-read the mode" } as const;
export const REVIEW_MODE_BUSY = { code: "review_mode_busy", message: "Another review mode change is in progress" } as const;
export const INVALID_GET_REVIEW_MODE = { code: "invalid_request", message: "Invalid get_review_mode parameters" } as const;
export const INVALID_SET_REVIEW_MODE = { code: "invalid_request", message: "Invalid set_review_mode parameters" } as const;

/** One scope's stored value as the owner reports it: `""` means unset. */
export type DesktopReviewOwnerScopeValue = "on" | "off" | "";

/** The owner's status, already decoded by the native adapter (`gentle-ai.rdd-mode-status/v1`). */
export interface DesktopReviewOwnerStatus {
	global: DesktopReviewOwnerScopeValue;
	cloneLocal: DesktopReviewOwnerScopeValue;
	effective: "on" | "off";
	source: "default" | "global" | "clone_local";
	revision?: string;
}

/** `unavailable`: no adapter, or `gentle-ai` is missing or does not support the command. `unknown`: the read failed or timed out. */
export type DesktopReviewOwnerRead =
	| { kind: "status"; status: DesktopReviewOwnerStatus }
	| { kind: "unknown" }
	| { kind: "unavailable" };

/** A write answers the owner's re-read after it, or `failed` when the write's outcome is unknown. */
export type DesktopReviewOwnerWrite = DesktopReviewOwnerRead | { kind: "failed" };

export type DesktopReviewScope = "clone" | "global";

export interface DesktopReviewSetRequest {
	enabled: boolean;
	scope: DesktopReviewScope;
}

export interface DesktopReviewService {
	readonly schema: typeof DESKTOP_REVIEW_SERVICE_SCHEMA;
	read(): Promise<DesktopReviewOwnerRead>;
	write(request: DesktopReviewSetRequest): Promise<DesktopReviewOwnerWrite>;
	dispose(): void;
}

export type DesktopReviewWireScope = "enabled" | "disabled" | "unset" | "unknown";

/** The wire projection: never a raw owner value, never CLI output. */
export interface DesktopReviewMode {
	effective: "enabled" | "disabled" | "unknown";
	source: "default" | "global" | "clone" | "unknown";
	scopes: { global: DesktopReviewWireScope; clone: DesktopReviewWireScope };
}

export const UNKNOWN_REVIEW_MODE: DesktopReviewMode = Object.freeze({
	effective: "unknown",
	source: "unknown",
	scopes: Object.freeze({ global: "unknown", clone: "unknown" }),
}) as DesktopReviewMode;

export function isDesktopReviewServiceShape(value: unknown): value is DesktopReviewService {
	if (!value || typeof value !== "object") return false;
	const service = value as Partial<DesktopReviewService>;
	return service.schema === DESKTOP_REVIEW_SERVICE_SCHEMA && typeof service.read === "function" && typeof service.write === "function" && typeof service.dispose === "function";
}

function isScopeValue(value: unknown): value is DesktopReviewOwnerScopeValue {
	return value === "on" || value === "off" || value === "";
}

/** Re-validates an owner status that crossed the event bus; anything unrecognized is undefined. */
export function parseDesktopReviewOwnerStatus(value: unknown): DesktopReviewOwnerStatus | undefined {
	if (!value || typeof value !== "object") return undefined;
	const status = value as Record<string, unknown>;
	if (!isScopeValue(status.global) || !isScopeValue(status.cloneLocal)) return undefined;
	if (status.effective !== "on" && status.effective !== "off") return undefined;
	if (status.source !== "default" && status.source !== "global" && status.source !== "clone_local") return undefined;
	if (status.revision !== undefined && (typeof status.revision !== "string" || status.revision.length > MAX_TOKEN_LENGTH)) return undefined;
	return {
		global: status.global,
		cloneLocal: status.cloneLocal,
		effective: status.effective,
		source: status.source,
		...(status.revision === undefined ? {} : { revision: status.revision as string }),
	};
}

function wireScope(value: DesktopReviewOwnerScopeValue): DesktopReviewWireScope {
	return value === "on" ? "enabled" : value === "off" ? "disabled" : "unset";
}

export function projectDesktopReviewMode(status: DesktopReviewOwnerStatus | undefined): DesktopReviewMode {
	if (!status) return { effective: "unknown", source: "unknown", scopes: { global: "unknown", clone: "unknown" } };
	return {
		effective: status.effective === "on" ? "enabled" : "disabled",
		source: status.source === "clone_local" ? "clone" : status.source,
		scopes: { global: wireScope(status.global), clone: wireScope(status.cloneLocal) },
	};
}

export function parseGetReviewModeParams(params: Record<string, unknown>): boolean {
	return Object.keys(params).length === 0;
}

export function parseSetReviewModeParams(params: Record<string, unknown>): (DesktopReviewSetRequest & { confirmationToken?: string }) | undefined {
	for (const key of Object.keys(params)) {
		if (key !== "enabled" && key !== "scope" && key !== "confirmationToken") return undefined;
	}
	if (typeof params.enabled !== "boolean") return undefined;
	if (params.scope !== "clone" && params.scope !== "global") return undefined;
	const token = params.confirmationToken;
	if (token === undefined) return { enabled: params.enabled, scope: params.scope };
	if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return undefined;
	return { enabled: params.enabled, scope: params.scope, confirmationToken: token };
}

function sourceLabel(source: DesktopReviewOwnerStatus["source"]): string {
	return source === "global" ? "the machine-wide setting" : source === "clone_local" ? "this repository's setting" : "the default";
}

/**
 * The dialog Desktop must show before a change. It names the current state and
 * the owner's exact semantics; it never carries a path, a command line, or CLI
 * output.
 */
export function desktopReviewModeConfirmation(request: DesktopReviewSetRequest, status: DesktopReviewOwnerStatus): { title: string; message: string; token: string } {
	const where = request.scope === "global" ? "machine-wide" : "for this repository";
	const title = `Turn review mode ${request.enabled ? "on" : "off"} ${where}?`;
	const current = `Receipt-driven development is currently ${status.effective} (decided by ${sourceLabel(status.source)}).`;
	let effect: string;
	if (request.scope === "global") {
		effect = request.enabled
			? "Reviews will be on for every repository on this machine, except a repository with its own off setting."
			: "Reviews will be off for every repository on this machine.";
	} else if (!request.enabled) {
		effect = "Reviews will be off for this repository only.";
	} else if (status.global === "off") {
		effect = "This only clears this repository's off setting. Review mode is off machine-wide, and a repository setting cannot override that, so reviews stay off.";
	} else {
		effect = "This clears this repository's off setting; it cannot override a machine-wide off.";
	}
	const message = `${current} ${effect}`;
	return { title, message, token: desktopReviewModeToken(request, title, message, status) };
}

/** sha256 over the request, the exact text shown, and the owner state it was computed from. */
export function desktopReviewModeToken(request: DesktopReviewSetRequest, title: string, message: string, status: DesktopReviewOwnerStatus): string {
	const state = [status.global, status.cloneLocal, status.effective, status.source, status.revision ?? null];
	return createHash("sha256").update(JSON.stringify([request.enabled, request.scope, title, message, state])).digest("hex");
}

// Process-wide: the review-mode owner and this bridge may load this module
// separately, so the single-flight gate lives on a registered symbol.
const SET_GATE = Symbol.for("gentle-shell.desktop-review-mode-set");
type GateHost = { [SET_GATE]?: boolean };

export function beginDesktopReviewModeSet(): boolean {
	const host = globalThis as GateHost;
	if (host[SET_GATE]) return false;
	host[SET_GATE] = true;
	return true;
}

export function endDesktopReviewModeSet(): void {
	(globalThis as GateHost)[SET_GATE] = false;
}
