import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { THREAD_ITEM, type ThreadItem, type ToolItem } from "./agents-protocol.ts";
import { renderAgentToolItem } from "./agents-tool-renderers.ts";

export interface AgentsThreadTheme {
	fg(color: string, text: string): string;
}

/**
 * How the thread draws a tool row. `log` is the overlay's own labeled block;
 * `cards` hands the row to the renderer the chat's canvas was offered.
 */
export const THREAD_PRESENTATION = {
	LOG: "log",
	CARDS: "cards",
} as const;

export type ThreadPresentation = (typeof THREAD_PRESENTATION)[keyof typeof THREAD_PRESENTATION];

export interface ThreadItemRenderOptions {
	/** Defaults to `log`, the presentation this overlay has always drawn. */
	presentation?: ThreadPresentation;
	/** Asks a card for its whole result instead of its collapsed preview. */
	expanded?: boolean;
}

const ROLE = {
	TEXT: "text",
	THINKING: "dim",
	TOOL: "accent",
	TOOL_ERROR: "error",
	OUTPUT: "muted",
	NOTE: "muted",
	LABEL: "customMessageLabel",
} as const;

function line(theme: AgentsThreadTheme, role: string, text: string, width: number): string {
	return theme.fg(role, truncateToWidth(text, Math.max(1, width), "…"));
}

function contentLines(theme: AgentsThreadTheme, role: string, text: string, width: number, requestedIndent: number): string[] {
	const indent = Math.min(requestedIndent, Math.max(0, width - 1));
	const prefix = " ".repeat(indent);
	const contentWidth = Math.max(1, width - indent);
	return text.split("\n").flatMap((source) => {
		if (source.length === 0) return [theme.fg(role, prefix)];
		const wrapped = wrapTextWithAnsi(source, contentWidth);
		return (wrapped.length > 0 ? wrapped : [source]).map((part) => theme.fg(role, `${prefix}${part}`));
	});
}

function toolStatus(item: ToolItem): "Running" | "Error" | "Complete" {
	if (item.isError) return "Error";
	return item.running ? "Running" : "Complete";
}

/**
 * The generic tool block, drawn when no reusable card is offered. It is one block
 * for every tool on purpose: a supported tool draws through the chat's own
 * renderer, and no second per-tool drawing is kept here.
 */
function toolBlock(item: ToolItem, theme: AgentsThreadTheme, width: number): string[] {
	const role = item.isError ? ROLE.TOOL_ERROR : ROLE.TOOL;
	const header = line(theme, role, `Tool · ${item.name} · ${toolStatus(item)}`, width);
	if (item.output.length === 0) return [header];
	return [header, line(theme, ROLE.OUTPUT, "  Output", width), ...contentLines(theme, ROLE.OUTPUT, item.output, width, 4)];
}

/** Render already-sanitized, bounded protocol items without inferring content roles. */
export function renderThreadItem(item: ThreadItem, theme: AgentsThreadTheme, width: number, options: ThreadItemRenderOptions = {}): string[] {
	if (width <= 0) return [];
	switch (item.kind) {
		case THREAD_ITEM.TEXT:
			return [line(theme, ROLE.LABEL, "Text", width), ...contentLines(theme, ROLE.TEXT, item.text, width, 2)];
		case THREAD_ITEM.THINKING:
			return [line(theme, ROLE.LABEL, "Thinking", width), ...contentLines(theme, ROLE.THINKING, item.text, width, 2)];
		case THREAD_ITEM.NOTE:
			return [line(theme, ROLE.NOTE, "Note", width), ...contentLines(theme, ROLE.NOTE, item.text, width, 2)];
		case THREAD_ITEM.TOOL:
			// A card owns its frame when the chat offered one; `undefined` covers no
			// renderer, a renderer that does not own its frame, and one that threw.
			return (options.presentation === THREAD_PRESENTATION.CARDS
				? renderAgentToolItem(item, theme, width, { expanded: options.expanded === true })
				: undefined) ?? toolBlock(item, theme, width);
		default:
			return [];
	}
}
