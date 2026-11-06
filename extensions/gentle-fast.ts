import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSessionProfileBinding } from "../lib/session-profile-binding.ts";
import { readSessionProfileAuthority } from "../lib/session-profile-authority.ts";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { freezeSessionProfileAtStartup, readFrozenDefaultOrchestrator } from "../lib/session-profile-freeze.ts";
import { isServiceTier } from "../lib/model-routing-authority.ts";
import { applyOpenAITier, CHILD_TIER_ENV, PROFILE_TIER_EVENT } from "../lib/openai-fast-tier.ts";

type Selection = "standard" | "fast" | undefined;

export default function (pi: ExtensionAPI) {
	let selection: Selection;
	let profileModel: string | undefined;

	function restore(ctx: ExtensionContext) {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		// The authority can replay the disk-corroborated branch even when this
		// extension starts before the profile owner's session_start handler.
		const authority = typeof ctx.sessionManager?.getBranch === "function" ? readSessionProfileAuthority(ctx.sessionManager) : undefined;
		const binding = authority ? authority.available ? authority.binding : undefined : readSessionProfileBinding(sessionId);
		const cwd = ctx.sessionManager?.getCwd?.() ?? ctx.cwd;
		if (process.env.GENTLE_PI_AGENTS_CHILD !== "1" && sessionId && typeof cwd === "string") {
			// Idempotent across extension load order and reload: never re-read a
			// later default into a session that already froze its startup choice.
			freezeSessionProfileAtStartup({ sessionId, cwd, configHome: gentlePiConfigHome() });
		}
		const entry = binding ? binding.modelProfiles.orchestrator
			: authority && !authority.available ? undefined : readFrozenDefaultOrchestrator(sessionId);
		const matches = entry?.model === `${ctx.model?.provider}/${ctx.model?.id}`;
		let child: { tier?: unknown; model?: unknown } | undefined;
		try { if (process.env.GENTLE_PI_AGENTS_CHILD === "1") child = JSON.parse(process.env[CHILD_TIER_ENV] ?? "null") ?? undefined; } catch { /* Invalid child selection is ignored. */ }
		const childMatches = child?.model === `${ctx.model?.provider}/${ctx.model?.id}`;
		selection = process.env.GENTLE_PI_AGENTS_CHILD === "1"
			? childMatches && isServiceTier(child?.tier) ? child.tier : undefined
			: matches ? entry?.tier : undefined;
		profileModel = selection ? `${ctx.model?.provider}/${ctx.model?.id}` : undefined;
	}
	let currentContext: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => { currentContext = ctx; restore(ctx); });
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.events?.on(PROFILE_TIER_EVENT, (value: unknown) => {
		const event = value as { sessionId?: string; tier?: unknown; model?: unknown } | undefined;
		if (!currentContext || !event || event.sessionId !== currentContext.sessionManager?.getSessionId?.()) return;
		selection = isServiceTier(event.tier) ? event.tier : undefined;
		profileModel = selection && typeof event.model === "string" ? event.model : undefined;
	});
	pi.on("model_select", (event) => {
		if (profileModel && profileModel !== `${event.model.provider}/${event.model.id}`) {
			selection = undefined;
			profileModel = undefined;
		}
	});
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (profileModel && profileModel !== `${model?.provider}/${model?.id}`) {
			selection = undefined;
			profileModel = undefined;
		}
		return applyOpenAITier(event.payload, selection, model);
	});
}
