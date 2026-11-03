import { assistantErrorCategory } from "./agents-protocol.ts";
import { fallbackContinuePrompt, type FallbackChange } from "./model-fallback-notice.ts";
import { pickModel, shouldFallBack, type ModelCooldown } from "./model-fallback-policy.ts";
import type { FallbackChain } from "./model-fallback-store.ts";
import type { ThinkingLevel } from "./model-routing-authority.ts";

// The main session's fallback. Pi ends a turn with an error only after its
// own retries; then the `orchestrator` chain of the session's profile picks
// the next model, the session switches to it and a message resumes the work.
// An episode lasts until a turn succeeds, so a chain is walked at most once.

export interface OrchestratorFallbackDeps {
	chain(): FallbackChain;
	/** `provider/id` of the session model, undefined when unknown. */
	current(): string | undefined;
	/** The model is in Pi's catalog and can be selected. */
	available(model: string): boolean;
	setModel(model: string): Promise<boolean>;
	setThinking(level: ThinkingLevel): void;
	announce(change: FallbackChange): void;
	resume(message: string): void;
	cooldown: ModelCooldown;
	now(): number;
}

type AssistantLike = { role?: unknown; stopReason?: unknown; errorMessage?: unknown };

export function createOrchestratorFallback(deps: OrchestratorFallbackDeps) {
	const tried = new Set<string>();
	return {
		/** Handles a finished agent run; true when the session moved to a fallback and resumed. */
		async onAgentEnd(messages: readonly unknown[]): Promise<boolean> {
			const last = [...messages].reverse().find((message) => (message as AssistantLike)?.role === "assistant") as AssistantLike | undefined;
			const category = assistantErrorCategory(last);
			if (category === undefined) {
				// Success or an abort ends the episode.
				tried.clear();
				return false;
			}
			const chain = deps.chain();
			if (!chain.length || !shouldFallBack(category)) return false;
			const now = deps.now();
			const current = deps.current();
			if (current) {
				tried.add(current);
				deps.cooldown.mark(current, category, now);
			}
			for (;;) {
				const pick = pickModel(current, chain, { cooldown: deps.cooldown, now, tried });
				if (!pick?.fallback || !pick.model) return false;
				tried.add(pick.model);
				if (!deps.available(pick.model) || !(await deps.setModel(pick.model))) continue;
				if (pick.thinking) deps.setThinking(pick.thinking);
				deps.announce({ agent: "orchestrator", from: current ?? "default", to: pick.model, category });
				deps.resume(fallbackContinuePrompt(current, pick.model, category));
				return true;
			}
		},
	};
}
