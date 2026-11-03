import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSessionProfileBinding } from "../lib/session-profile-binding.ts";
import { readSessionProfileAuthority } from "../lib/session-profile-authority.ts";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { freezeSessionProfileAtStartup, readFrozenDefaultOrchestrator } from "../lib/session-profile-freeze.ts";
import { isServiceTier } from "../lib/model-routing-authority.ts";
import { applyOpenAITier, CHILD_TIER_ENV, PROFILE_TIER_EVENT, supportsOpenAIFast } from "../lib/openai-fast-tier.ts";

type Model = ExtensionContext["model"];
type Selection = "standard" | "fast" | undefined;
type Observation = "priority" | "fast" | "default" | "unknown" | undefined;

const supported = supportsOpenAIFast;

export default function (pi: ExtensionAPI) {
	let selection: Selection;
	let profileModel: string | undefined;
	let observation: Observation;
	let active: { provider: string; api: string; model: string; responseId?: string } | undefined;

	function state(model: Model): string {
		const requested = !selection ? "No tier selected; existing request behavior unchanged"
			: !supported(model) ? `${selection === "fast" ? "Fast" : "Standard"} selected, inactive: unsupported provider, API or model`
			: selection === "fast" ? "Fast requested" : "Standard requested";
		const observed = observation === "priority" || observation === "fast" ? `Fast (${observation})`
			: observation === "default" ? "Standard (default)"
			: observation === "unknown" ? "unknown or missing service_tier; cannot confirm"
			: "not yet observed; cannot confirm";
		return `${requested}; last response from server: ${observed}`;
	}

	function status(ctx: ExtensionContext, model = ctx.model) {
		if (ctx.hasUI) ctx.ui.setStatus("gentle-fast", selection || observation ? state(model) : undefined);
	}

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
		observation = undefined;
		active = undefined;
		status(ctx);
	}
	let currentContext: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => { currentContext = ctx; restore(ctx); });
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.events?.on(PROFILE_TIER_EVENT, (value: unknown) => {
		const event = value as { sessionId?: string; tier?: unknown; model?: unknown } | undefined;
		if (!currentContext || !event || event.sessionId !== currentContext.sessionManager?.getSessionId?.()) return;
		selection = isServiceTier(event.tier) ? event.tier : undefined;
		profileModel = selection && typeof event.model === "string" ? event.model : undefined;
		observation = undefined;
		active = undefined;
		status(currentContext);
	});
	pi.on("model_select", (event, ctx) => {
		if (profileModel && profileModel !== `${event.model.provider}/${event.model.id}`) {
			selection = undefined;
			profileModel = undefined;
		}
		observation = undefined;
		active = undefined;
		status(ctx, event.model);
	});
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (profileModel && profileModel !== `${model?.provider}/${model?.id}`) {
			selection = undefined;
			profileModel = undefined;
		}
		active = supported(model) && model ? { provider: model.provider, api: model.api, model: model.id } : undefined;
		return applyOpenAITier(event.payload, selection, model);
	});
	pi.on("provider_stream_event", (event, ctx) => {
		if (!active || !supported(ctx.model) || event.provider !== active.provider || event.api !== active.api || event.model !== active.model ||
			ctx.model?.provider !== active.provider || ctx.model.api !== active.api || ctx.model.id !== active.model) return;
		if (!event.data || typeof event.data !== "object") return;
		const data = event.data as { type?: unknown; response?: { id?: unknown; service_tier?: unknown } };
		if (data.type === "response.created") {
			active.responseId = typeof data.response?.id === "string" ? data.response.id : undefined;
			return;
		}
		if (data.type !== "response.completed" && data.type !== "response.incomplete" && !(event.api === "openai-codex-responses" && data.type === "response.done")) return;
		const id = data.response?.id;
		if (active.responseId && typeof id === "string" && id !== active.responseId) return;
		const tier = active.responseId && typeof id !== "string" ? undefined : data.response?.service_tier;
		observation = tier === "priority" || tier === "fast" || tier === "default" ? tier : "unknown";
		active = undefined;
		status(ctx);
	});
}
