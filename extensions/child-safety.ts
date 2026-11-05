import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { SHELL_COMMAND_TOOLS } from "../lib/background-jobs.ts";
import { recognizeDestructiveCommands } from "../lib/destructive-command-guard.ts";

// Pi's bash tool has no default timeout. A child command that never ends (for
// example a test waiting on a fake clock it never advances) would otherwise sit
// until the runner's 30-minute tool stall watchdog stops the whole child.
export const CHILD_BASH_DEFAULT_TIMEOUT_SECONDS = 600;
// Below the runner's default tool_stall_timeout_ms, so the command's own timeout
// fires first and reports its output instead of the child being killed.
export const CHILD_BASH_MAX_TIMEOUT_SECONDS = 1740;

export function blockChildDestructiveCommand(command: string): ToolCallEventResult | undefined {
	if (recognizeDestructiveCommands(command).length === 0) return undefined;
	return { block: true, reason: "Gentle AI child safety blocked a recognized destructive command. Return an explicit safer plan to the parent; children cannot authorize data loss." };
}

/** Mutates validated bash input in place: a missing timeout gets the default, an
 * excessive one the ceiling. Other values, including invalid ones the tool itself
 * rejects, are left untouched; the call is never retried or moved elsewhere.
 */
export function applyChildBashDeadline(input: { timeout?: unknown }): void {
	if (input.timeout === undefined) input.timeout = CHILD_BASH_DEFAULT_TIMEOUT_SECONDS;
	else if (typeof input.timeout === "number" && input.timeout > CHILD_BASH_MAX_TIMEOUT_SECONDS) input.timeout = CHILD_BASH_MAX_TIMEOUT_SECONDS;
}

// Explicitly loaded by package-owned children; package auto-discovery in the
// primary is inert. No UI or inherited delivery permission can waive this guard.
export function createChildSafetyExtension(env: NodeJS.ProcessEnv = process.env): (pi: ExtensionAPI) => void {
	return (pi) => {
		if (env.GENTLE_PI_AGENTS_CHILD !== "1") return;
		pi.on("tool_call", (event) => {
			const command = (event.input as { command?: unknown }).command;
			if (!SHELL_COMMAND_TOOLS.has(event.toolName) || typeof command !== "string") return undefined;
			const blocked = blockChildDestructiveCommand(command);
			if (!blocked && event.toolName === "bash") applyChildBashDeadline(event.input as { timeout?: unknown });
			return blocked;
		});
	};
}

export default function childSafetyExtension(pi: ExtensionAPI): void {
	createChildSafetyExtension()(pi);
}
