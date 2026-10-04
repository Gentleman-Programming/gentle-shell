/**
 * SEC-13: Per-actor identity and capability binding at spawn.
 * Rejects prohibited tools/paths and duplicate built-in tool names at registrar
 * admission before execution.
 */

export type ActorRole = "analyst" | "worker" | "verifier" | "generic";

export interface ActorCapabilities {
	role: ActorRole;
	actorName: string;
	allowedTools: string[];
	prohibitedTools: string[];
	allowedEditSurfaces?: string[];
}

/** Built-in tool names whose names are reserved and cannot be re-registered. */
export const BUILTIN_TOOL_NAMES: ReadonlyArray<string> = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const ANALYST_ALLOWED = ["read", "grep", "find", "codegraph"];
const ANALYST_PROHIBITED = ["edit", "write", "bash"];
const ANALYST_AGENT_NAMES = ["gentle-ai-security"];

function resolveRole(agentName: string): ActorRole {
	if (ANALYST_AGENT_NAMES.includes(agentName)) return "analyst";
	if (agentName.includes("worker") || agentName === "jd-fix-agent") return "worker";
	if (agentName.includes("verif") || agentName.includes("judge")) return "verifier";
	return "generic";
}

/**
 * Resolves capabilities for a spawned actor. Analyst actors (including
 * gentle-ai-security) are constrained to read-only tools; workers and
 * verifiers inherit the declared tool list.
 */
export function resolveActorCapabilities(
	agentName: string,
	tools: string[],
	allowedSurfaces?: string[],
): ActorCapabilities {
	const role = resolveRole(agentName);
	if (role === "analyst") {
		return {
			role,
			actorName: agentName,
			allowedTools: ANALYST_ALLOWED,
			prohibitedTools: ANALYST_PROHIBITED,
			...(allowedSurfaces ? { allowedEditSurfaces: allowedSurfaces } : {}),
		};
	}
	return {
		role,
		actorName: agentName,
		allowedTools: tools,
		prohibitedTools: [],
		...(allowedSurfaces ? { allowedEditSurfaces: allowedSurfaces } : {}),
	};
}

/**
 * Validates whether a tool may be admitted to the actor's registrar.
 * Rejects duplicate built-in names and tools prohibited for the actor's role.
 */
export function validateRegistrarToolAdmission(
	toolName: string,
	capabilities: ActorCapabilities,
	existingTools: string[],
): { admitted: boolean; reason?: string } {
	// Reject if the tool is prohibited for this actor's role (checked first).
	if (capabilities.prohibitedTools.includes(toolName)) {
		return { admitted: false, reason: `Tool '${toolName}' is prohibited for ${capabilities.role} actor '${capabilities.actorName}'` };
	}
	// Reject if this name collides with a built-in that is already registered or is always built-in.
	if (BUILTIN_TOOL_NAMES.includes(toolName)) {
		return { admitted: false, reason: `Tool name '${toolName}' is a built-in and cannot be re-registered` };
	}
	return { admitted: true };
}

/**
 * Serializes actor identity and capability boundaries into child spawn
 * environment variables, preserving any telemetry opt-out variables from
 * the base environment.
 */
export function bindActorSpawnEnv(
	capabilities: ActorCapabilities,
	baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {
		...filterStringEntries(baseEnv),
		GENTLE_PI_AGENTS_ACTOR: capabilities.actorName,
		GENTLE_PI_AGENTS_ROLE: capabilities.role,
		GENTLE_PI_AGENTS_ALLOWED_TOOLS: capabilities.allowedTools.join(","),
		GENTLE_PI_AGENTS_PROHIBITED_TOOLS: capabilities.prohibitedTools.join(","),
	};
	return env;
}

function filterStringEntries(env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (typeof v === "string") result[k] = v;
	}
	return result;
}
