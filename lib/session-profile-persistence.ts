// Standalone v1 codec and pure active-branch replay (gentle-shell#1064).
// No Pi API, disk access, shared binding store, or orchestrator application.
import { isValidProfileName } from "./agent-profiles.ts";
import {
	isSafeAgentName,
	isThinkingLevel,
	isServiceTier,
	normalizeModelId,
	normalizeRoutingEntry,
	type AgentModelConfig,
	type AgentRoutingEntry,
} from "./model-routing-authority.ts";

export const SESSION_PROFILE_CUSTOM_TYPE = "gentle-pi.session-profile/v1";
export const SESSION_PROFILE_FAMILY = "gentle-pi.session-profile/";

/** True for any custom entry in the session-profile family, known version or not. */
export function isSessionProfileFamilyEntry(entry: unknown): boolean {
	return (
		typeof entry === "object" &&
		entry !== null &&
		(entry as { type?: unknown }).type === "custom" &&
		typeof (entry as { customType?: unknown }).customType === "string" &&
		(entry as { customType: string }).customType.startsWith(
			SESSION_PROFILE_FAMILY,
		)
	);
}

export type SessionProfileOrigin = "user" | "local" | "repo" | "global";
export type SessionProfileStartupOrigin = Exclude<SessionProfileOrigin, "user">;

/** The profile a session took at startup, with the layer that supplied it. */
export interface SessionProfileStartupProfile {
	origin: SessionProfileStartupOrigin;
	name: string;
	modelProfiles: AgentModelConfig;
}

/** A known startup state (gentle-shell#2742, section 3): a profile, or none in any layer. */
export type SessionProfileStartupState = SessionProfileStartupProfile | "none";

export interface SessionProfileBindPayload {
	kind: "bind";
	origin: SessionProfileOrigin;
	name: string;
	modelProfiles: AgentModelConfig;
	/** Only on an explicit choice (`origin: "user"`); a startup record is its own startup state. */
	startup?: SessionProfileStartupState;
}

export interface SessionProfileClearPayload {
	kind: "clear";
	startup?: "none";
}

/** Public structural entry shape only; ordinary messages need no custom fields. */
export interface SessionProfileEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export type SessionProfileReadResult =
	| { status: "absent" }
	| { status: "bound"; binding: SessionProfileBindPayload }
	| { status: "cleared"; startup?: "none" }
	| { status: "invalid" }
	| { status: "unsupported" };

export type SessionProfileReplayResult =
	| { status: "absent" }
	| (Exclude<SessionProfileReadResult, { status: "absent" }> & {
			entryIndex: number;
	  });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(value, key);
}

function isOrigin(value: unknown): value is SessionProfileOrigin {
	return (
		value === "user" || isStartupOrigin(value)
	);
}

function isStartupOrigin(value: unknown): value is SessionProfileStartupOrigin {
	return (
		value === "local" ||
		value === "repo" ||
		value === "global"
	);
}

/** Validate known fields before the permissive routing helper can drop them. */
function readRoute(
	value: unknown,
	encoderInput = false,
): AgentRoutingEntry | undefined {
	if (typeof value === "string") return normalizeRoutingEntry(value);
	if (!isRecord(value)) return undefined;
	// Typed normalized routes can own optional undefined fields. Omit only those
	// encoder fields; persisted fields and legacy effort retain strict validation.
	const route = encoderInput
		? Object.fromEntries(
				Object.entries(value).filter(
					([key, field]) =>
						!((key === "model" || key === "thinking" || key === "tier") && field === undefined),
				),
			)
		: value;
	if (hasOwn(route, "model") && normalizeModelId(route.model) === undefined)
		return undefined;
	if (hasOwn(route, "thinking") && !isThinkingLevel(route.thinking))
		return undefined;
	if (hasOwn(route, "effort") && !isThinkingLevel(route.effort))
		return undefined;
	if (hasOwn(route, "tier") && !isServiceTier(route.tier))
		return undefined;
	// Project only own known fields. Unknown extras, even an unknown-only route,
	// carry no routing meaning. Thinking wins over legacy effort as elsewhere.
	const known = Object.fromEntries(
		["model", "thinking", "effort", "tier"]
			.filter((key) => hasOwn(route, key))
			.map((key) => [key, route[key]]),
	);
	const normalized = normalizeRoutingEntry(known);
	if (!normalized) return undefined;
	return Object.fromEntries(
		Object.entries(normalized).filter(([, field]) => field !== undefined),
	);
}

function readSnapshot(
	value: unknown,
	encoderInput = false,
): AgentModelConfig | undefined {
	if (!isRecord(value)) return undefined;
	const entries: Array<[string, AgentRoutingEntry]> = [];
	for (const [name, rawRoute] of Object.entries(value)) {
		// Shared agent-name policy, applied here without the forgiving whole-config
		// normalization that would silently discard a bad route. Output below uses
		// own data properties, never prototype setters.
		if (!isSafeAgentName(name)) return undefined;
		const route = readRoute(rawRoute, encoderInput);
		if (route === undefined) return undefined;
		entries.push([name, route]);
	}
	return Object.fromEntries(entries);
}

function readBind(
	data: Record<string, unknown>,
	encoderInput = false,
): SessionProfileBindPayload | undefined {
	if (!["origin", "name", "modelProfiles"].every((key) => hasOwn(data, key)))
		return undefined;
	if (!isOrigin(data.origin) || !isValidProfileName(data.name)) return undefined;
	const modelProfiles = readSnapshot(data.modelProfiles, encoderInput);
	if (modelProfiles === undefined) return undefined;
	const binding: SessionProfileBindPayload = { kind: "bind", origin: data.origin, name: data.name, modelProfiles };
	if (data.origin !== "user" || !hasOwn(data, "startup")) return binding;
	// Older readers ignore the startup state, so a malformed one only leaves it
	// unknown: it never invalidates the selection the record routes.
	const startup = readStartup(data.startup, encoderInput);
	return startup === undefined ? binding : { ...binding, startup };
}

function readStartup(
	value: unknown,
	encoderInput = false,
): SessionProfileStartupState | undefined {
	if (value === "none") return "none";
	if (!isRecord(value) || !isStartupOrigin(value.origin)) return undefined;
	const binding = readBind({ origin: value.origin, name: value.name, modelProfiles: value.modelProfiles }, encoderInput);
	return binding && { origin: value.origin, name: binding.name, modelProfiles: binding.modelProfiles };
}

/** Create a detached user selection payload; never appends or claims durability. */
export function createSessionProfileBind(
	name: string,
	modelProfiles: AgentModelConfig,
	startup?: SessionProfileStartupState,
): SessionProfileBindPayload {
	const binding = readBind({ origin: "user", name, modelProfiles }, true);
	if (!binding) throw new TypeError("Invalid session profile binding");
	if (startup === undefined) return binding;
	const state = readStartup(startup, true);
	if (state === undefined) throw new TypeError("Invalid session profile startup state");
	return { ...binding, startup: state };
}

/** Create a detached startup record: the full normalized definition, orchestrator included. */
export function createSessionProfileStartupBind(
	origin: SessionProfileStartupOrigin,
	name: string,
	modelProfiles: AgentModelConfig,
): SessionProfileBindPayload {
	const startup = isStartupOrigin(origin) ? readStartup({ origin, name, modelProfiles }, true) : undefined;
	if (typeof startup !== "object") throw new TypeError("Invalid session profile startup binding");
	return { kind: "bind", ...startup };
}

/** A legacy clear, or with `"none"` the record of a session started without a profile. */
export function createSessionProfileClear(startup?: "none"): SessionProfileClearPayload {
	return startup === "none" ? { kind: "clear", startup } : { kind: "clear" };
}

/** Unknown family identifiers are terminal unsupported states, regardless of data. */
export function readSessionProfileEntry(
	entry: SessionProfileEntry,
): SessionProfileReadResult {
	if (!isSessionProfileFamilyEntry(entry)) return { status: "absent" };
	if (entry.customType !== SESSION_PROFILE_CUSTOM_TYPE)
		return { status: "unsupported" };
	const data = entry.data;
	if (!isRecord(data) || !hasOwn(data, "kind")) return { status: "invalid" };
	if (data.kind === "clear")
		return data.startup === "none" ? { status: "cleared", startup: "none" } : { status: "cleared" };
	if (data.kind !== "bind") return { status: "invalid" };
	const binding = readBind(data);
	return binding ? { status: "bound", binding } : { status: "invalid" };
}

/**
 * Caller MUST supply ALREADY disk-corroborated active-branch entries, in branch
 * order (oldest to newest). This function cannot establish that precondition:
 * it does not read disk, call Pi, enforce append-failure recovery, establish
 * durability, or update the shared map. In-memory getBranch() alone is NOT
 * corroboration. Sibling and future paths must be excluded by the caller.
 *
 * The newest family entry wins even when invalid or unsupported; never revive
 * an older binding. Cleared permits current fallback at a later consumer,
 * whereas invalid/unsupported must remain distinct from absent. entryIndex is
 * the actual supplied branch offset for a later adapter's location warning.
 */
export function replaySessionProfileBranch(
	entries: readonly SessionProfileEntry[],
): SessionProfileReplayResult {
	for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
		const result = readSessionProfileEntry(entries[entryIndex]);
		if (result.status !== "absent") return { ...result, entryIndex };
	}
	return { status: "absent" };
}
