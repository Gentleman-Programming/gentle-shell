import type { ServiceTier } from "./model-routing-authority.ts";

// Conservative intersection of the installed catalog and OpenAI's Fast list.
const FAST_MODELS = new Set([
	"gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
	"gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra",
]);

export const PROFILE_TIER_EVENT = "gentle-pi:profile-tier";
export const CHILD_TIER_ENV = "GENTLE_PI_AGENT_SERVICE_TIER";

export function supportsOpenAIFast(model: { provider?: string; api?: string; id?: string } | null | undefined): boolean {
	return !!model && typeof model.id === "string" && FAST_MODELS.has(model.id) && (
		(model.provider === "openai" && model.api === "openai-responses") ||
		(model.provider === "openai-codex" && model.api === "openai-codex-responses")
	);
}

export function applyOpenAITier(payload: unknown, tier: ServiceTier | undefined, model: { provider?: string; api?: string; id?: string } | null | undefined): unknown {
	if (!tier || !supportsOpenAIFast(model) || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	return { ...payload, service_tier: tier === "fast" ? "priority" : "default" };
}
