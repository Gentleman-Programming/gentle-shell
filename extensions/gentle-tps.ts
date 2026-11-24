import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isChildSession } from "../lib/child-session.ts";
import { resolveTpsSettings } from "../lib/tps-policy.ts";

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	let agentStartMs: number | null = null;

	pi.on("agent_start", () => {
		agentStartMs = Date.now();
	});

	pi.on("agent_end", (event, ctx) => {
		const startMs = agentStartMs;
		// Consume every end, even headless ones, so a repeated end cannot reuse it.
		agentStartMs = null;
		if (!ctx.hasUI || startMs === null) return;

		const elapsedMs = Date.now() - startMs;
		if (elapsedMs <= 0) return;

		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			cacheRead += message.usage.cacheRead || 0;
			cacheWrite += message.usage.cacheWrite || 0;
			totalTokens += message.usage.totalTokens || 0;
		}

		if (output <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const tokensPerSecond = output / elapsedSeconds;
		const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedSeconds.toFixed(1)}s`;
		// Reread on every run: a /gentle:customize toggle applies from the next run
		// without a reload. Fail open: missing, malformed or unreadable policy keeps
		// the notification (today's behavior).
		if (!resolveTpsSettings().settings.enabled) return;
		ctx.ui.notify(message, "info");
	});
}
