import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { recognizeDestructiveCommands } from "../lib/destructive-command-guard.ts";

export function blockChildDestructiveCommand(command: string): ToolCallEventResult | undefined {
	if (recognizeDestructiveCommands(command).length === 0) return undefined;
	return { block: true, reason: "Gentle AI child safety blocked a recognized destructive command. Return an explicit safer plan to the parent; children cannot authorize data loss." };
}

// Explicitly loaded by package-owned children; package auto-discovery in the
// primary is inert. No UI or inherited delivery permission can waive this guard.
export function createChildSafetyExtension(env: NodeJS.ProcessEnv = process.env): (pi: ExtensionAPI) => void {
	return (pi) => {
		if (env.GENTLE_PI_AGENTS_CHILD !== "1") return;
		pi.on("tool_call", (event) => {
			if (event.toolName !== "bash" || typeof event.input.command !== "string") return undefined;
			return blockChildDestructiveCommand(event.input.command);
		});
	};
}

export default function childSafetyExtension(pi: ExtensionAPI): void {
	createChildSafetyExtension()(pi);
}
