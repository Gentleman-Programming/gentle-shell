import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { THREAD_ITEM, type ThreadItem, type ToolItem } from "./agents-protocol.ts";

export interface AgentsThreadTheme {
	fg(color: string, text: string): string;
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

/** Render already-sanitized, bounded protocol items without inferring content roles. */
export function renderThreadItem(item: ThreadItem, theme: AgentsThreadTheme, width: number): string[] {
	if (width <= 0) return [];
	switch (item.kind) {
		case THREAD_ITEM.TEXT:
			return [line(theme, ROLE.LABEL, "Text", width), ...contentLines(theme, ROLE.TEXT, item.text, width, 2)];
		case THREAD_ITEM.THINKING:
			return [line(theme, ROLE.LABEL, "Thinking", width), ...contentLines(theme, ROLE.THINKING, item.text, width, 2)];
		case THREAD_ITEM.NOTE:
			return [line(theme, ROLE.NOTE, "Note", width), ...contentLines(theme, ROLE.NOTE, item.text, width, 2)];
		case THREAD_ITEM.TOOL: {
			const role = item.isError ? ROLE.TOOL_ERROR : ROLE.TOOL;
			const header = line(theme, role, `Tool · ${item.name} · ${toolStatus(item)}`, width);
			if (item.output.length === 0) return [header];
			return [header, line(theme, ROLE.OUTPUT, "  Output", width), ...contentLines(theme, ROLE.OUTPUT, item.output, width, 4)];
		}
		default:
			return [];
	}
}
