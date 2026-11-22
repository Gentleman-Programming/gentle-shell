// Gentle Desktop agent-definitions bridge: answers `list_agent_definitions`
// from the existing owners and projects their result with
// `lib/desktop-rpc-agent-definitions.ts`.
//
// The roots are the same ones `subagent_list_agents` discovers from
// (`extensions/gentle-agents.ts`): the session cwd, the agent home resolved by
// `resolveAgentHomeDirectory`, and the Gentle config home for tool overlays.
// The default orchestrator is read from Pi's `settings.json` in that agent
// home. Every read is fresh: definitions are plain files re-read on each call,
// and nothing is written or cached.

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import { gentlePiConfigHome } from "./agent-home.ts";
import { resolveAgentHomeDirectory } from "./agent-model-resolution.ts";
import { discoverAgents, loadAgentsConfig, type DiscoveryRoots } from "./agents-config.ts";
import { readOrchestratorSettings } from "./profiles-orchestrator.ts";
import {
	AGENT_DEFINITIONS_UNAVAILABLE,
	parseAgentDefinitionsParams,
	projectAgentDefinitions,
} from "./desktop-rpc-agent-definitions.ts";

/** Where one read looks: discovery roots and Pi's settings file. */
export interface AgentDefinitionsLocation {
	roots: DiscoveryRoots;
	orchestratorSettingsPath: string;
}

export type AgentDefinitionsLocationFactory = (context: ExtensionContext) => AgentDefinitionsLocation;

const defaultLocation: AgentDefinitionsLocationFactory = (context) => {
	const home = homedir();
	const agentHome = resolveAgentHomeDirectory({ env: process.env, home });
	return {
		roots: { cwd: context.sessionManager?.getCwd?.() ?? context.cwd, home, agentHome, configHome: gentlePiConfigHome() },
		orchestratorSettingsPath: join(agentHome, "settings.json"),
	};
};

/**
 * The Desktop domain slice for `list_agent_definitions`. It is a read: no
 * event and no write. A reset (session replacement or shutdown) drops the
 * bound context.
 */
export class DesktopAgentDefinitionsBridge {
	private readonly location: AgentDefinitionsLocationFactory;
	private host: ExtensionContext | undefined;

	constructor(options: { location?: AgentDefinitionsLocationFactory } = {}) {
		this.location = options.location ?? defaultLocation;
	}

	/** The live interactive context of this Desktop session; bound per command. */
	attach(context: ExtensionContext): void {
		this.host = context;
	}

	reset(): void {
		this.host = undefined;
	}

	handle(method: string, params: Record<string, unknown>): DesktopRpcOutcome | undefined {
		if (method !== "list_agent_definitions") return undefined;
		// Parse first: a malformed request never reads.
		const query = parseAgentDefinitionsParams(params);
		if ("error" in query) return { ok: false, error: query.error };
		const host = this.host;
		if (!host) return { ok: false, error: AGENT_DEFINITIONS_UNAVAILABLE };
		try {
			const { roots, orchestratorSettingsPath } = this.location(host);
			const discovery = discoverAgents(roots);
			const config = loadAgentsConfig(roots);
			const data = projectAgentDefinitions({
				agents: discovery.agents,
				errors: discovery.errors,
				notices: discovery.notices,
				defaults: { model: config.defaultModel, thinking: config.defaultThinking, mode: config.defaultMode },
				orchestrator: readOrchestratorSettings(orchestratorSettingsPath),
			});
			return { ok: true, data: data as unknown as Record<string, unknown> };
		} catch {
			// Discovery failures name directories and files; none crosses.
			return { ok: false, error: AGENT_DEFINITIONS_UNAVAILABLE };
		}
	}
}
