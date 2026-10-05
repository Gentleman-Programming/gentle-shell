import { join, resolve } from "node:path";
import { resolveGentlePiAgentHome } from "./agent-home.ts";
import { resolveProfilePin } from "./agent-profile-pin.ts";
import {
	discoverAgents,
	loadAgentsConfig,
	resolveAgentProfile,
	withPinnedModelProfiles,
	type AgentDefinition,
	type DiscoveryRoots,
	type ModelRef,
	type ResolvedProfile,
} from "./agents-config.ts";
import type { WorktreeResolver } from "./session-worktree-registry.ts";

// gentle-shell#1731: subagent launches and the harness model-routing fact share
// one resolution of the effective subagent model, so the fact the orchestrator
// reads can never disagree with the model a launch would actually use.

export interface AgentHomeSelection {
	env: NodeJS.ProcessEnv;
	home: string;
	/** An explicit agent home, kept literal. */
	agentHome?: string;
	/** An explicit home selects `<home>/.pi/agent` and ignores the environment. */
	homeOverridden?: boolean;
}

/** The agent home Gentle Agents discovers definitions and `subagents.json` from. */
export function resolveAgentHomeDirectory(selection: AgentHomeSelection): string {
	const selectedHome = selection.agentHome ?? (selection.homeOverridden ? join(selection.home, ".pi", "agent") : resolveGentlePiAgentHome(selection.env));
	// Expand environment tildes like Pi, but leave explicit path APIs literal.
	const environmentHome = selection.agentHome === undefined && !selection.homeOverridden;
	const expandedHome = environmentHome && selectedHome === "~" ? selection.home
		: environmentHome && (selectedHome.startsWith("~/") || (process.platform === "win32" && selectedHome.startsWith("~\\"))) ? join(selection.home, selectedHome.slice(2)) : selectedHome;
	return resolve(expandedHome);
}

export interface AgentProfileScope {
	roots: DiscoveryRoots;
	/** The directory whose repository profile pin applies to the launch. */
	pinCwd: string;
	configHome: string;
	resolveWorktree?: WorktreeResolver;
}

/**
 * The launch profile for an agent: global and project `subagents.json`, with a
 * repository profile pin replacing `modelProfiles` wholesale when one applies.
 */
export function resolvePinnedAgentProfile(agent: AgentDefinition, scope: AgentProfileScope): ResolvedProfile {
	const config = withPinnedModelProfiles(
		loadAgentsConfig(scope.roots),
		resolveProfilePin({ cwd: scope.pinCwd, configHome: scope.configHome, resolveWorktree: scope.resolveWorktree })?.modelProfiles,
	);
	return resolveAgentProfile(agent, config);
}

export interface EffectiveAgentModel {
	agent: string;
	model: ModelRef | undefined;
	/** No profile, definition, or default routes the agent: it inherits the session model. */
	inherited: boolean;
}

/**
 * The model a launch of `agentName` would use, falling back to the session model
 * when nothing routes it; `undefined` when the agent is not discovered.
 */
export function resolveEffectiveAgentModel(
	agentName: string,
	scope: AgentProfileScope & { fallback?: ModelRef },
): EffectiveAgentModel | undefined {
	const agent = discoverAgents(scope.roots).agents.find((candidate) => candidate.name === agentName);
	if (!agent) return undefined;
	const profile = resolvePinnedAgentProfile(agent, scope);
	return profile.model === undefined
		? { agent: agentName, model: scope.fallback, inherited: true }
		: { agent: agentName, model: profile.model, inherited: false };
}
