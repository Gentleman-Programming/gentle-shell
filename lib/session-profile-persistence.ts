// Standalone v1 codec decoder (gentle-shell#1064).
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
function readRoute(value: unknown): AgentRoutingEntry | undefined {
	if (typeof value === "string") return normalizeRoutingEntry(value);
	if (!isRecord(value)) return undefined;
	const route = value;
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

function readSnapshot(value: unknown): AgentModelConfig | undefined {
	if (!isRecord(value)) return undefined;
	const entries: Array<[string, AgentRoutingEntry]> = [];
	for (const [name, rawRoute] of Object.entries(value)) {
		// Shared agent-name policy, applied here without the forgiving whole-config
		// normalization that would silently discard a bad route. Output below uses
		// own data properties, never prototype setters.
		if (!isSafeAgentName(name)) return undefined;
		const route = readRoute(rawRoute);
		if (route === undefined) return undefined;
		entries.push([name, route]);
	}
	return Object.fromEntries(entries);
}

function readBind(
	data: Record<string, unknown>,
): SessionProfileBindPayload | undefined {
	if (!["origin", "name", "modelProfiles"].every((key) => hasOwn(data, key)))
		return undefined;
	if (!isOrigin(data.origin) || !isValidProfileName(data.name)) return undefined;
	const modelProfiles = readSnapshot(data.modelProfiles);
	if (modelProfiles === undefined) return undefined;
	return { kind: "bind", origin: data.origin, name: data.name, modelProfiles };
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
