import { assistantErrorCategory } from "./agents-protocol.ts";
import { fallbackContinuePrompt, type FallbackChange } from "./model-fallback-notice.ts";
import { pickModel, shouldFallBack, type ModelCooldown } from "./model-fallback-policy.ts";
import type { FallbackChain } from "./model-fallback-store.ts";
import type { ThinkingLevel } from "./model-routing-authority.ts";

// The main session's fallback. Pi fires agent_end on every failed attempt and
// only then decides to retry, so the decision waits for agent_settled: the
// run's last attempt failed after Pi's own retries. Then the `orchestrator`
// chain of the session's profile picks the next model, the session switches
// to it and a message resumes the work. An episode lasts until a turn
// succeeds or the user aborts, so a chain is walked at most once.

export interface OrchestratorFallbackDeps {
	chain(): FallbackChain;
	/** `provider/id` of the session model, undefined when unknown. */
	current(): string | undefined;
	/** The model is in Pi's catalog and can be selected. */
	available(model: string): boolean;
	setModel(model: string): Promise<boolean>;
	setThinking(level: ThinkingLevel): void;
	/** The session's effort when the episode began: a step without its own effort runs at it. */
	thinking(): ThinkingLevel | undefined;
	announce(change: FallbackChange): void;
	resume(message: string): void;
	cooldown: ModelCooldown;
	now(): number;
}

type AssistantLike = { role?: unknown; stopReason?: unknown; errorMessage?: unknown };

export function createOrchestratorFallback(deps: OrchestratorFallbackDeps) {
	const tried = new Set<string>();
	let episodeThinking: ThinkingLevel | undefined;
	return {
		/** Handles a settled run (its last attempt's messages); true when the session moved to a fallback and resumed. */
		async onSettled(messages: readonly unknown[], settled: { aborted?: boolean } = {}): Promise<boolean> {
			if (settled.aborted) {
				// The user stopped the run: never resume it on another model.
				tried.clear();
				return false;
			}
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
			if (tried.size === 0) episodeThinking = deps.thinking();
			if (current) {
				tried.add(current);
				deps.cooldown.mark(current, category, now);
			}
			for (;;) {
				const pick = pickModel(current, chain, { cooldown: deps.cooldown, now, tried });
				if (!pick?.fallback || !pick.model) return false;
				tried.add(pick.model);
				if (!deps.available(pick.model)) continue;
				// Pi may refuse or throw (an expired login): the next step gets its turn.
				const switched = await deps.setModel(pick.model).catch(() => false);
				if (!switched) continue;
				const level = pick.thinking ?? episodeThinking;
				if (level) deps.setThinking(level);
				deps.announce({ agent: "orchestrator", from: current ?? "default", to: pick.model, category });
				deps.resume(fallbackContinuePrompt(current, pick.model, category));
				return true;
			}
		},
	};
}
