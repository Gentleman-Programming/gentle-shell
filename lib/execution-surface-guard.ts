import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";

// gentle-shell#379: delegated work stays in the current runtime. A tool call
// that asks to open an external project pane is classified by its own input
// property, never by the tool name, and is blocked in every mode and in
// children. A value that is not a boolean fails closed. The reason carries
// fixed fields only, never input paths or content.

export const EXTERNAL_FALLBACK_PROHIBITED = "gentle-ai.execution-surface.external-fallback-prohibited";

const PANE_PROPERTY = "openProjectPaneIfMissing";

export function evaluateExecutionSurfaceTool(toolName: string, input: unknown): ToolCallEventResult | undefined {
	if (typeof input !== "object" || input === null || !Object.hasOwn(input, PANE_PROPERTY)) return undefined;
	if ((input as Record<string, unknown>)[PANE_PROPERTY] === false) return undefined;
	return {
		block: true,
		reason: `Gentle AI blocked an execution-surface escalation. code=${EXTERNAL_FALLBACK_PROHIBITED} tool=${toolName} property=${PANE_PROPERTY} next=Run the work through subagent_* or the native Agent in the current runtime; if neither is available, stop and tell the user.`,
	};
}
