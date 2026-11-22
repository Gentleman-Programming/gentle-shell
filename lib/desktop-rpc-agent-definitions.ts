// Gentle Desktop agent-definitions slice: the pure contract shared by the
// Desktop bridge (`lib/desktop-agent-definitions-service.ts`) and its reader.
//
// The data comes from the existing owners, unchanged: `discoverAgents` and
// `loadAgentsConfig` (`lib/agents-config.ts`, the same discovery
// `subagent_list_agents` uses) and `readOrchestratorSettings`
// (`lib/profiles-orchestrator.ts`, Pi's default orchestrator keys). This module
// only parses the request and projects those facts into a bounded shape with
// no file paths, no prompt bodies, and no problem text (which names files).

import type { AgentDefinition, AgentMode, AgentScope, ModelRef, ThinkingLevel } from "./agents-config.ts";
import type { OrchestratorSettingsReadResult } from "./profiles-orchestrator.ts";

export const DESKTOP_AGENT_DEFINITIONS_METHODS = ["list_agent_definitions"] as const;
/** Agent definitions are an explicit read: this slice advertises no event. */
export const DESKTOP_AGENT_DEFINITIONS_EVENTS = [] as const;

export const INVALID_AGENT_DEFINITIONS_PARAMS = { code: "invalid_request", message: "Invalid agent definitions parameters" } as const;
export const AGENT_DEFINITIONS_UNAVAILABLE = { code: "agent_definitions_unavailable", message: "Agent definitions unavailable" } as const;

/** Bounds of one answer. */
export const DESKTOP_AGENT_DEFINITIONS_LIMITS = {
	agents: 200,
	name: 128,
	description: 512,
	tools: 64,
	tool: 128,
	model: 256,
} as const;

export interface DesktopAgentDefinition {
	name: string;
	description: string;
	scope: AgentScope;
	/** The model the definition declares (`provider/id` or `id`), or null when it inherits. */
	model: string | null;
	thinking: ThinkingLevel | null;
	mode: AgentMode | null;
	tools: string[];
	toolsTruncated: boolean;
}

export type OrchestratorStatus = "set" | "unset" | "missing" | "invalid";

export interface DesktopAgentDefinitions {
	agents: DesktopAgentDefinition[];
	truncated: boolean;
	/** Counts only: problem text names files, so it never crosses. */
	problems: { invalid: number; notices: number };
	subagentDefaults: { model: string | null; thinking: ThinkingLevel | null; mode: AgentMode };
	defaultOrchestrator: { status: OrchestratorStatus; model: string | null; thinking: string | null };
}

/** What the reader hands to the projection: the owners' own results. */
export interface AgentDefinitionsFacts {
	agents: readonly AgentDefinition[];
	errors: readonly string[];
	notices: readonly string[];
	defaults: { model: ModelRef | undefined; thinking: ThinkingLevel | undefined; mode: AgentMode };
	orchestrator: OrchestratorSettingsReadResult;
}

/** `list_agent_definitions` params: an empty object. */
export function parseAgentDefinitionsParams(params: Record<string, unknown>): { ok: true } | { error: { code: string; message: string } } {
	return Object.keys(params).length === 0 ? { ok: true } : { error: INVALID_AGENT_DEFINITIONS_PARAMS };
}

function cut(value: string, limit: number): string {
	return value.length > limit ? value.slice(0, limit) : value;
}

function modelText(model: ModelRef | undefined): string | null {
	if (!model) return null;
	const text = model.provider ? `${model.provider}/${model.id}` : model.id;
	return text.length === 0 || text.length > DESKTOP_AGENT_DEFINITIONS_LIMITS.model ? null : text;
}

function projectAgent(agent: AgentDefinition): DesktopAgentDefinition {
	const limits = DESKTOP_AGENT_DEFINITIONS_LIMITS;
	return {
		name: cut(agent.name, limits.name),
		description: cut(agent.description, limits.description),
		scope: agent.scope,
		model: modelText(agent.model),
		thinking: agent.thinking ?? null,
		mode: agent.mode ?? null,
		tools: agent.tools.slice(0, limits.tools).map((tool) => cut(tool, limits.tool)),
		toolsTruncated: agent.tools.length > limits.tools,
	};
}

function projectOrchestrator(result: OrchestratorSettingsReadResult): DesktopAgentDefinitions["defaultOrchestrator"] {
	if (result.status === "missing") return { status: "missing", model: null, thinking: null };
	// The reason can quote a path or parser text: only the status crosses.
	if (result.status === "invalid") return { status: "invalid", model: null, thinking: null };
	if (!result.entry) return { status: "unset", model: null, thinking: null };
	const model = result.entry.model.length > DESKTOP_AGENT_DEFINITIONS_LIMITS.model ? null : result.entry.model;
	return { status: "set", model, thinking: result.entry.thinking ?? null };
}

/** Projects the owners' facts into the bounded, path-free Desktop shape. */
export function projectAgentDefinitions(facts: AgentDefinitionsFacts): DesktopAgentDefinitions {
	const limit = DESKTOP_AGENT_DEFINITIONS_LIMITS.agents;
	return {
		agents: facts.agents.slice(0, limit).map(projectAgent),
		truncated: facts.agents.length > limit,
		problems: { invalid: facts.errors.length, notices: facts.notices.length },
		subagentDefaults: {
			model: modelText(facts.defaults.model),
			thinking: facts.defaults.thinking ?? null,
			mode: facts.defaults.mode,
		},
		defaultOrchestrator: projectOrchestrator(facts.orchestrator),
	};
}
