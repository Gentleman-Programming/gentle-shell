// Gentle Desktop background-subagents slice: the pure contract shared by the
// Desktop bridge (`lib/desktop-background-subagents-service.ts`) and the
// policy owner in `extensions/gentle-ai.ts` (`/gentle:background-subagents`).
//
// The policy is a user-owned switch: the owner's command is the only writer,
// and only on explicit invocation. A Desktop change therefore needs two calls,
// like `set_review_mode`: the first answers the confirmation text and a token
// bound to the state it describes; only a second call with a token that still
// matches the current state writes. The write goes to the global file, the
// same one the command writes, and the answer is the owner's re-read state,
// which says when a project file still outranks it.

import { createHash } from "node:crypto";

export const DESKTOP_BACKGROUND_SUBAGENTS_METHODS = ["get_background_subagents", "set_background_subagents"] as const;
/** Every answer carries the state; this slice advertises no event. */
export const DESKTOP_BACKGROUND_SUBAGENTS_EVENTS = [] as const;

export const DESKTOP_BACKGROUND_SUBAGENTS_SERVICE_SCHEMA = "gentle-pi.desktop-background-subagents-service/v1";
export const DESKTOP_BACKGROUND_SUBAGENTS_SERVICE_CHANNEL = "gentle:desktop:background-subagents-service";

export const INVALID_GET_BACKGROUND_SUBAGENTS = { code: "invalid_request", message: "Invalid get_background_subagents parameters" } as const;
export const INVALID_SET_BACKGROUND_SUBAGENTS = { code: "invalid_request", message: "Invalid set_background_subagents parameters" } as const;
export const BACKGROUND_SUBAGENTS_UNAVAILABLE = { code: "background_subagents_unavailable", message: "The background subagents policy is not available in this session" } as const;
export const BACKGROUND_SUBAGENTS_WRITE_UNCONFIRMED = { code: "background_subagents_unavailable", message: "The background subagents change did not complete; re-read the policy" } as const;
export const BACKGROUND_SUBAGENTS_BUSY = { code: "background_subagents_busy", message: "Another background subagents change is in progress" } as const;

export type BackgroundSubagentsPolicyValue = "on" | "off";
export type BackgroundSubagentsWireSource = "project" | "global" | "environment" | "default";

/** The policy state, as the owner resolves it, without file paths or the raw environment value. */
export interface DesktopBackgroundSubagentsState {
	effective: BackgroundSubagentsPolicyValue;
	source: BackgroundSubagentsWireSource;
	/** The deciding file exists but failed the strict decode (the policy is then `off`). */
	malformed: boolean;
	projectFile: "present" | "absent";
	globalFile: "present" | "absent";
	/** Whether this session can launch background subagents at all. */
	capability: "ready" | "absent";
}

export type DesktopBackgroundSubagentsOwnerRead = { kind: "status"; state: DesktopBackgroundSubagentsState } | { kind: "unavailable" };
export type DesktopBackgroundSubagentsOwnerWrite = DesktopBackgroundSubagentsOwnerRead | { kind: "failed" };

export interface DesktopBackgroundSubagentsService {
	readonly schema: typeof DESKTOP_BACKGROUND_SUBAGENTS_SERVICE_SCHEMA;
	read(): Promise<DesktopBackgroundSubagentsOwnerRead>;
	/** Writes the global policy file, then answers the owner's re-read. */
	write(policy: BackgroundSubagentsPolicyValue): Promise<DesktopBackgroundSubagentsOwnerWrite>;
	dispose(): void;
}

export function isDesktopBackgroundSubagentsServiceShape(value: unknown): value is DesktopBackgroundSubagentsService {
	if (!value || typeof value !== "object") return false;
	const service = value as Partial<DesktopBackgroundSubagentsService>;
	return service.schema === DESKTOP_BACKGROUND_SUBAGENTS_SERVICE_SCHEMA
		&& typeof service.read === "function" && typeof service.write === "function" && typeof service.dispose === "function";
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T => typeof value === "string" && (options as readonly string[]).includes(value);

/** Re-validates an owner state field by field; anything else is `undefined`. */
export function parseDesktopBackgroundSubagentsState(value: unknown): DesktopBackgroundSubagentsState | undefined {
	if (!record(value)) return undefined;
	if (!oneOf(value.effective, ["on", "off"] as const)) return undefined;
	if (!oneOf(value.source, ["project", "global", "environment", "default"] as const)) return undefined;
	if (typeof value.malformed !== "boolean") return undefined;
	if (!oneOf(value.projectFile, ["present", "absent"] as const) || !oneOf(value.globalFile, ["present", "absent"] as const)) return undefined;
	if (!oneOf(value.capability, ["ready", "absent"] as const)) return undefined;
	return { effective: value.effective, source: value.source, malformed: value.malformed, projectFile: value.projectFile, globalFile: value.globalFile, capability: value.capability };
}

export function parseGetBackgroundSubagentsParams(params: Record<string, unknown>): boolean {
	return Object.keys(params).length === 0;
}

/** `{ policy: "on" | "off", confirmationToken?: string (1-128) }`; nothing else. */
export function parseSetBackgroundSubagentsParams(params: Record<string, unknown>): { policy: BackgroundSubagentsPolicyValue; confirmationToken?: string } | undefined {
	if (Object.keys(params).some((key) => key !== "policy" && key !== "confirmationToken")) return undefined;
	if (!oneOf(params.policy, ["on", "off"] as const)) return undefined;
	if (!("confirmationToken" in params)) return { policy: params.policy };
	const token = params.confirmationToken;
	if (typeof token !== "string" || token.length === 0 || token.length > 128) return undefined;
	return { policy: params.policy, confirmationToken: token };
}

const SOURCE_LABEL: Record<BackgroundSubagentsWireSource, string> = {
	project: "this project's file",
	global: "the machine-wide file",
	environment: "the GENTLE_PI_BACKGROUND_SUBAGENTS environment variable",
	default: "the built-in default",
};

/** The confirmation text for writing `policy` machine-wide, given the current state, and its token. */
export function desktopBackgroundSubagentsConfirmation(policy: BackgroundSubagentsPolicyValue, state: DesktopBackgroundSubagentsState): { title: string; message: string; token: string } {
	const title = `Turn background subagents ${policy} machine-wide?`;
	const current = `Background subagents are currently ${state.effective} (decided by ${SOURCE_LABEL[state.source]}${state.malformed ? ", which is malformed, so they stay off" : ""}).`;
	const effect = state.projectFile === "present"
		? `This writes the machine-wide setting, but this project's file decides here, so the change does not apply to this project until that file is removed.`
		: `This writes the machine-wide setting; a project can still override it with its own file.`;
	const capability = state.capability === "absent" ? " This session cannot launch background subagents, so the setting has no effect here yet." : "";
	const message = `${current} ${effect}${capability}`;
	return { title, message, token: desktopBackgroundSubagentsToken(policy, title, message, state) };
}

/** sha256 over the request, the exact text shown, and the state it was computed from. */
export function desktopBackgroundSubagentsToken(policy: BackgroundSubagentsPolicyValue, title: string, message: string, state: DesktopBackgroundSubagentsState): string {
	return createHash("sha256").update(JSON.stringify([policy, title, message, state])).digest("hex");
}

// One Desktop change at a time per process, like the review switch.
const SET_GATE = Symbol.for("gentle-pi.desktop-background-subagents.set-gate");
type GateHost = typeof globalThis & { [SET_GATE]?: boolean };

export function beginDesktopBackgroundSubagentsSet(): boolean {
	const host = globalThis as GateHost;
	if (host[SET_GATE]) return false;
	host[SET_GATE] = true;
	return true;
}

export function endDesktopBackgroundSubagentsSet(): void {
	(globalThis as GateHost)[SET_GATE] = false;
}
