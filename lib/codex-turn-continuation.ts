import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function trackCodexTurnContinuation(pi: ExtensionAPI) {
	let codexRequestedAnotherTurn = false;
	let recoveryAvailable = false;

	pi.on("message_start", ({ message }) => {
		// Pi 1.5/1.6 exposes delivery here, not a reliable input source or queue label.
		// Delivered user steers and follow-ups both have role `user`; package steering
		// via sendMessage is `custom`. Handled or cleared input never arrives here.
		if (message.role === "user") recoveryAvailable = true;
	});

	pi.on("turn_end", ({ message, toolResults }) => {
		if (toolResults.length > 0) recoveryAvailable = true;
		codexRequestedAnotherTurn = toolResults.length === 0 && message.role === "assistant" &&
			message.api === "openai-codex-responses" && message.stopReason === "stop" && message.endTurn === false;
	});

	pi.on("agent_settled", () => {
		codexRequestedAnotherTurn = false;
	});

	// Pi drains tool results, steering and follow-ups before settlement. Only
	// spend a recovery when the run would otherwise stop on the Codex signal.
	return (event: AgentBeforeSettleEvent, ctx: ExtensionContext): AgentBeforeSettleEventResult | undefined => {
		if (!codexRequestedAnotherTurn || !recoveryAvailable || event.continue || event.outcome !== "completed" || ctx.signal?.aborted) return;
		recoveryAvailable = false;
		if (event.context.canContinue) return { continue: true };

		// A bare assistant tail needs a model-visible entry for Pi to continue.
		return {
			entries: [...event.entries, {
				type: "custom_message", customType: "gentle-pi.codex-turn-continuation",
				content: "Continue the current turn within the existing instructions.", display: false,
			}],
			continue: true,
		};
	};
}
