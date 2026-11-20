import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function codexTurnContinuation(pi: ExtensionAPI) {
	let codexRequestedAnotherTurn = false;
	let continuedWithoutTool = false;

	pi.on("turn_end", ({ message, toolResults }) => {
		if (toolResults.length > 0) continuedWithoutTool = false;
		codexRequestedAnotherTurn = toolResults.length === 0 && message.role === "assistant" &&
			message.api === "openai-codex-responses" && message.stopReason === "stop" && message.endTurn === false;
	});

	// Pi drains tool results, steering and follow-ups before settlement. Only
	// spend a recovery when the run would otherwise stop on the Codex signal.
	pi.on("agent_before_settle", (event, ctx) => {
		if (!codexRequestedAnotherTurn || continuedWithoutTool || event.continue || event.outcome !== "completed" || ctx.signal?.aborted) return;
		continuedWithoutTool = true;
		if (event.context.canContinue) return { continue: true };

		// A bare assistant tail needs a model-visible entry for Pi to continue.
		return {
			entries: [...event.entries, {
				type: "custom_message", customType: "gentle-pi.codex-turn-continuation",
				content: "Continue the current turn within the existing instructions.", display: false,
			}],
			continue: true,
		};
	});

	pi.on("agent_settled", () => {
		codexRequestedAnotherTurn = false;
		continuedWithoutTool = false;
	});
}
