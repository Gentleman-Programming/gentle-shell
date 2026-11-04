// Reviewer selection of the last release before A1 (gentle-shell#2742, section
// 10; #2720 is A1). The functions below are byte-identical copies of
// `extensions/gentle-ai.ts` at 9fe14aad except their import lines. What A1 and
// A2 do not change is read live, like the other `v1-inputs.ts` inputs.
import { gentlePiConfigHome } from "../../../lib/agent-home.ts";
import type { AgentModelConfig } from "../../../lib/model-routing-authority.ts";
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

export { readReviewerModelConfig };
