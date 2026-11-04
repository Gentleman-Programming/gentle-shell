// Reviewer selection of the last release before A1 (gentle-shell#2742, section
// 10; #2720 is A1). The functions below are byte-identical copies of
// `extensions/gentle-ai.ts` at 9fe14aad except their import lines. What A1 and
// A2 do not change is read live, like the other `v1-inputs.ts` inputs.
import { join } from "node:path";
import { resolveGentlePiAgentHome, gentlePiConfigHome } from "../../../lib/agent-home.ts";
import { PROVIDER_REVIEW_ROLES } from "../../../lib/agents-config.ts";
import type { AgentModelConfig, AgentRoutingEntry } from "../../../lib/model-routing-authority.ts";
import { readOrchestratorSettings } from "../../../lib/profiles-orchestrator.ts";
import { readModelConfig } from "../../../extensions/gentle-ai.ts";
import { resolveProfilePin } from "./v1-inputs.ts";
import { readSessionProfileBinding } from "./session-profile-binding.ts";

function gentleAiConfigHome(): string {
	return gentlePiConfigHome();
}

function cloneModelConfig(config: AgentModelConfig): AgentModelConfig {
	return Object.fromEntries(
		Object.entries(config).map(([name, entry]) => [name, { ...entry }]),
	);
}

/**
 * The routing a launch would resolve: a winning per-repository pin replaces subagent
 * routing wholesale, so when one wins it is the effective routing. The launch
 * resolver decides, so the profile shown as effective is exactly the profile a launch
 * would use -- there is no second precedence rule here.
 */
function pinnedEffectiveModelConfig(cwd: string): AgentModelConfig | undefined {
	const resolution = resolveProfilePin({ cwd, configHome: gentleAiConfigHome() });
	return resolution === undefined ? undefined : cloneModelConfig(resolution.modelProfiles);
}

/** Resolve one complete reviewer routing snapshot without per-role fallback. */
function readReviewerModelConfig(cwd: string, sessionId: string | undefined): AgentModelConfig {
	return readSessionProfileBinding(sessionId)?.modelProfiles ?? pinnedEffectiveModelConfig(cwd) ?? readModelConfig(cwd);
}

function gentlePiAgentHome(): string {
	return resolveGentlePiAgentHome();
}

/**
 * Pi's own global settings file, which is where the orchestrator model lives.
 * Profiles own the three `default*` keys there; nothing else in this extension
 * reads or writes that file.
 */
function orchestratorSettingsPath(): string {
	return join(gentlePiAgentHome(), "settings.json");
}

function isProviderReviewRole(name: string): boolean {
	return PROVIDER_REVIEW_ROLES.some((role) => role === name);
}

// gentle-pi#311 P2 (superseding gentle-shell#1136 / #1158): the lens's
// completion selection comes from its entry in the agent model routing
// config, keyed by its routing key (`review-<lens>`). There is no extension
// allowlist and no ambient default model: the in-process completion resolves
// its provider through the live model registry the caller supplies, or it is
// refused before materialize ever runs (validateReviewerSelectionConfiguration
// in lib/review-host-relay.ts).
//
// gentle-pi#2271: review-refuter and review-validator are provider review
// roles, not installable agents, so nothing seeds their entries and profiles
// never carry them. For those two keys only, a snapshot with no model falls
// back to Pi's persisted default model and effort, the default the routing
// panel already labels them with. Lens keys keep the fail-closed rule.
function reviewHostRelaySelection(lens: string | undefined, config: AgentModelConfig): { selection?: string; thinking?: string; routingKey: string } {
	const routingKey = lens === undefined || lens.length === 0 ? "review capture" : lens.startsWith("review-") ? lens : `review-${lens}`;
	const entry = config[routingKey];
	let model = typeof entry === "object" && entry !== null && typeof (entry as AgentRoutingEntry).model === "string" && (entry as AgentRoutingEntry).model!.length > 0 ? (entry as AgentRoutingEntry).model : undefined;
	let thinking = typeof entry === "object" && entry !== null && typeof (entry as AgentRoutingEntry).thinking === "string" ? (entry as AgentRoutingEntry).thinking : undefined;
	if (model === undefined && isProviderReviewRole(routingKey)) {
		const persisted = readOrchestratorSettings(orchestratorSettingsPath());
		if (persisted.status === "valid" && persisted.entry?.model !== undefined) {
			model = persisted.entry.model;
			thinking ??= persisted.entry.thinking;
		}
	}
	return {
		...(model === undefined ? {} : { selection: model }),
		...(thinking === undefined ? {} : { thinking }),
		routingKey,
	};
}

export { readReviewerModelConfig, reviewHostRelaySelection };
