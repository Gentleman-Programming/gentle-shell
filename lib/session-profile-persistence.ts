// Standalone v1 codec and pure active-branch replay (gentle-shell#1064).
// No Pi API, disk access, shared binding store, or orchestrator application.
import { isValidProfileName } from "./agent-profiles.ts";
import {
	isSafeAgentName,
	isThinkingLevel,
	normalizeModelId,
	normalizeRoutingEntry,
	type AgentModelConfig,
	type AgentRoutingEntry,
} from "./model-routing-authority.ts";

export const SESSION_PROFILE_CUSTOM_TYPE = "gentle-pi.session-profile/v1";
const SESSION_PROFILE_FAMILY = "gentle-pi.session-profile/";

export type SessionProfileOrigin = "user" | "local" | "repo" | "global";

export interface SessionProfileBindPayload {
	kind: "bind";
	origin: SessionProfileOrigin;
	name: string;
	modelProfiles: AgentModelConfig;
}

export interface SessionProfileClearPayload {
	kind: "clear";
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
	| { status: "cleared" }
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
		value === "user" ||
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
						!((key === "model" || key === "thinking") && field === undefined),
				),
			)
		: value;
	if (hasOwn(route, "model") && normalizeModelId(route.model) === undefined)
		return undefined;
	if (hasOwn(route, "thinking") && !isThinkingLevel(route.thinking))
		return undefined;
	if (hasOwn(route, "effort") && !isThinkingLevel(route.effort))
		return undefined;
	// Project only own known fields. Unknown extras, even an unknown-only route,
	// carry no routing meaning. Thinking wins over legacy effort as elsewhere.
	const known = Object.fromEntries(
		["model", "thinking", "effort"]
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
	return { kind: "bind", origin: data.origin, name: data.name, modelProfiles };
}

/** Create a detached user selection payload; never appends or claims durability. */
export function createSessionProfileBind(
	name: string,
	modelProfiles: AgentModelConfig,
): SessionProfileBindPayload {
	const binding = readBind({ origin: "user", name, modelProfiles }, true);
	if (!binding) throw new TypeError("Invalid session profile binding");
	return binding;
}

export function createSessionProfileClear(): SessionProfileClearPayload {
	return { kind: "clear" };
}

/** Unknown family identifiers are terminal unsupported states, regardless of data. */
export function readSessionProfileEntry(
	entry: SessionProfileEntry,
): SessionProfileReadResult {
	if (
		entry.type !== "custom" ||
		typeof entry.customType !== "string" ||
		!entry.customType.startsWith(SESSION_PROFILE_FAMILY)
	)
		return { status: "absent" };
	if (entry.customType !== SESSION_PROFILE_CUSTOM_TYPE)
		return { status: "unsupported" };
	const data = entry.data;
	if (!isRecord(data) || !hasOwn(data, "kind")) return { status: "invalid" };
	if (data.kind === "clear") return { status: "cleared" };
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
