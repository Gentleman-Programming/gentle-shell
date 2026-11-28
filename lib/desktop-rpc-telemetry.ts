// Gentle Desktop telemetry-consent slice: the pure contract shared by the
// Desktop bridge (`lib/desktop-telemetry-service.ts`) and its tests.
//
// gentle-ai owns telemetry end to end (the state file, the first-run notice and
// `notice_shown`). This module only parses requests, decodes the output of
// `gentle-ai telemetry policy --json`, and derives the two client-facing fields
// `toggle` and `locked` in ONE place, from the table approved in
// Gentleman-Programming/gentle-shell#3586. It never fabricates a policy.

export const DESKTOP_TELEMETRY_METHODS = ["get_telemetry", "set_telemetry"] as const;
/** Advertised only while the state-directory watcher is wired. */
export const DESKTOP_TELEMETRY_EVENT = "telemetry_changed";
export const DESKTOP_TELEMETRY_EVENTS = [DESKTOP_TELEMETRY_EVENT] as const;

/** One deadline for every `gentle-ai telemetry` run (same as `/gentle:telemetry`). */
export const TELEMETRY_RPC_TIMEOUT_MS = 5_000;

export const INVALID_TELEMETRY_PARAMS = { code: "invalid_request", message: "Invalid telemetry parameters" } as const;
export const TELEMETRY_BINARY_MISSING = { code: "telemetry_binary_missing", message: "gentle-ai binary not found" } as const;
export const TELEMETRY_TIMEOUT = { code: "telemetry_timeout", message: "gentle-ai telemetry timed out" } as const;
export const TELEMETRY_COMMAND_FAILED = { code: "telemetry_command_failed", message: "gentle-ai telemetry command failed" } as const;
export const TELEMETRY_OUTPUT_INVALID = { code: "telemetry_output_invalid", message: "gentle-ai telemetry output could not be understood" } as const;
export const TELEMETRY_POLICY_UNSUPPORTED = { code: "telemetry_policy_unsupported", message: "This gentle-ai does not support `telemetry policy`; update gentle-ai" } as const;

export type TelemetryToggle = "on" | "off" | "unset";

/** The sources that lock the preference: they override what the state file says. */
export const TELEMETRY_LOCK_SOURCES = ["DO_NOT_TRACK", "GENTLE_AI_TELEMETRY", "CI"] as const;

/** The policy exactly as gentle-ai printed it, plus the two derived fields. */
export type DesktopTelemetryPolicy = Record<string, unknown> & {
	enabled: boolean;
	source: string;
	reason: string;
	toggle: TelemetryToggle;
	locked: boolean;
};

/**
 * The derivation table. Never keys on `source` alone: `reason` decides, and
 * `source` only separates the user's own opt-out from an environment lock.
 * Returns undefined for a combination the table does not cover, so the caller
 * reports it instead of guessing.
 */
export function deriveTelemetryToggle(policy: { reason: string; source: string }): { toggle: TelemetryToggle; locked: boolean } | undefined {
	switch (policy.reason) {
		case "enabled":
		case "enrollment_pending":
			return { toggle: "on", locked: false };
		case "state_unavailable":
			return { toggle: "unset", locked: false };
		case "disabled":
			if (policy.source === "state") return { toggle: "off", locked: false };
			if ((TELEMETRY_LOCK_SOURCES as readonly string[]).includes(policy.source)) return { toggle: "off", locked: true };
			return undefined;
		default:
			return undefined;
	}
}

/**
 * Decodes `telemetry policy --json` stdout: a JSON object with a boolean
 * `enabled` and string `source` and `reason`. Its fields pass through
 * unchanged; `toggle` and `locked` are added. Anything else is undefined.
 */
export function decodeTelemetryPolicy(stdout: string): DesktopTelemetryPolicy | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (typeof record.enabled !== "boolean" || typeof record.source !== "string" || typeof record.reason !== "string") return undefined;
	const derived = deriveTelemetryToggle({ reason: record.reason, source: record.source });
	if (derived === undefined) return undefined;
	return { ...record, enabled: record.enabled, source: record.source, reason: record.reason, ...derived };
}

/** `get_telemetry` takes no params. */
export function parseGetTelemetryParams(params: Record<string, unknown>): { error: { code: string; message: string } } | undefined {
	return Object.keys(params).length === 0 ? undefined : { error: INVALID_TELEMETRY_PARAMS };
}

/** `set_telemetry` takes exactly `{ enabled: boolean }`. */
export function parseSetTelemetryParams(params: Record<string, unknown>): { enabled: boolean } | { error: { code: string; message: string } } {
	const keys = Object.keys(params);
	if (keys.length !== 1 || keys[0] !== "enabled" || typeof params.enabled !== "boolean") return { error: INVALID_TELEMETRY_PARAMS };
	return { enabled: params.enabled };
}
