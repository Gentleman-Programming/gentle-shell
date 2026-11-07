import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { THREAD_ITEM, type ThreadItem, type ToolItem } from "./agents-protocol.ts";
import { agentMessageCard, steeredMessage } from "./agents-message-card.ts";
import { renderAgentToolItem } from "./agents-tool-renderers.ts";

export interface AgentsThreadTheme {
	fg(color: string, text: string): string;
	/** Pi themes carry it; the chat draws reasoning in italic. */
	italic?(text: string): string;
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
	/**
	 * Cards only: draws a tool's whole retained result. The labeled log always
	 * draws every retained line, so it ignores this and the two options below.
	 */
	expanded?: boolean;
	/**
	 * Cards only: draws thinking whole. `false` draws the chat's own `Thinking...` row
	 * instead; the log always shows thinking whole.
	 */
	thinkingExpanded?: boolean;
	/** Cards only: key text a collapsed tool result offers, e.g. `ctrl+o to expand`. */
	expandHint?: string;
}

/** How much of a long block a collapsed row keeps before it counts the rest. */
const COLLAPSED_PREVIEW_LINES = 3;

const ROLE = {
	TEXT: "text",
	/** The labeled log's own tone, unchanged from before. */
	THINKING: "dim",
	/** The chat's own reasoning token, so cards read like the transcript. */
	THINKING_CHAT: "thinkingText",
	TOOL: "accent",
	TOOL_ERROR: "error",
	OUTPUT: "muted",
	NOTE: "muted",
	LABEL: "customMessageLabel",
} as const;

/**
 * Paints one row in a role, in italic when the theme carries the attribute —
 * the chat italicizes reasoning, so a card that mirrors it must too. A theme
 * without `italic` keeps the row plain instead of failing to draw.
 */
function paint(theme: AgentsThreadTheme, role: string, text: string, italic: boolean): string {
	const colored = theme.fg(role, text);
	return italic && typeof theme.italic === "function" ? theme.italic(colored) : colored;
}

function line(theme: AgentsThreadTheme, role: string, text: string, width: number, italic = false): string {
	return paint(theme, role, truncateToWidth(text, Math.max(1, width), "…"), italic);
}

function contentLines(theme: AgentsThreadTheme, role: string, text: string, width: number, requestedIndent: number, italic = false): string[] {
	const indent = indentWidth(width, requestedIndent);
	const prefix = " ".repeat(indent);
	const contentWidth = Math.max(1, width - indent);
	return text.split("\n").flatMap((source) => {
		if (source.length === 0) return [paint(theme, role, prefix, italic)];
		const wrapped = wrapTextWithAnsi(source, contentWidth);
		return (wrapped.length > 0 ? wrapped : [source]).map((part) => paint(theme, role, `${prefix}${part}`, italic));
	});
}

function indentWidth(width: number, requested: number): number {
	return Math.min(requested, Math.max(0, width - 1));
}

/**
 * The leading lines a collapsed tool result keeps, with the count it withholds. A
 * result that already fits is returned whole, so a preview never invents a
 * remainder; `hint` names the key that draws the rest, when the action has one.
 */
function previewBlock(text: string, expanded: boolean, hint: string | undefined): { text: string; marker: string } {
	const lines = text.split("\n");
	if (expanded || lines.length <= COLLAPSED_PREVIEW_LINES) return { text, marker: "" };
	const hidden = lines.length - COLLAPSED_PREVIEW_LINES;
	return { text: lines.slice(0, COLLAPSED_PREVIEW_LINES).join("\n"), marker: `… ${hidden} more ${hidden === 1 ? "line" : "lines"}${hint ? ` · ${hint}` : ""}` };
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
function toolBlock(item: ToolItem, theme: AgentsThreadTheme, width: number, expanded: boolean, hint: string | undefined): string[] {
	const role = item.isError ? ROLE.TOOL_ERROR : ROLE.TOOL;
	const header = line(theme, role, `Tool · ${item.name} · ${toolStatus(item)}`, width);
	if (item.output.length === 0) return [header];
	const preview = previewBlock(item.output, expanded, hint);
	const marker = preview.marker ? [line(theme, ROLE.NOTE, `${" ".repeat(indentWidth(width, 4))}${preview.marker}`, width)] : [];
	return [header, line(theme, ROLE.OUTPUT, "  Output", width), ...contentLines(theme, ROLE.OUTPUT, preview.text, width, 4), ...marker];
}

/** The label Pi itself puts in place of a thinking run while thinking is hidden. */
const HIDDEN_THINKING_LABEL = "Thinking...";

function thinkingBlock(text: string, theme: AgentsThreadTheme, width: number, expanded: boolean, chatStyle: boolean): string[] {
	// A card mirrors the transcript: the chat's own reasoning token, italic, and
	// its hidden label. The labeled log keeps the tone and plain rows it always
	// had, so switching to cards never restyles the original view.
	const role = chatStyle ? ROLE.THINKING_CHAT : ROLE.THINKING;
	if (!expanded) return [line(theme, role, HIDDEN_THINKING_LABEL, width, chatStyle)];
	return [line(theme, ROLE.LABEL, "Thinking", width), ...contentLines(theme, role, text, width, 2, chatStyle)];
}

/** Render already-sanitized, bounded protocol items without inferring content roles. */
export function renderThreadItem(item: ThreadItem, theme: AgentsThreadTheme, width: number, options: ThreadItemRenderOptions = {}): string[] {
	if (width <= 0) return [];
	// The labeled log is the overlay's original drawing: thinking and tool output
	// are always whole there, and only the cards offer these detail levels.
	const cards = options.presentation === THREAD_PRESENTATION.CARDS;
	const showThinking = cards ? options.thinkingExpanded !== false : true;
	const showWhole = cards ? options.expanded !== false : true;
	switch (item.kind) {
		case THREAD_ITEM.TEXT:
			return [line(theme, ROLE.LABEL, "Text", width), ...contentLines(theme, ROLE.TEXT, item.text, width, 2)];
		case THREAD_ITEM.THINKING:
			return thinkingBlock(item.text, theme, width, showThinking, cards);
		case THREAD_ITEM.NOTE: {
			// A message delivered to the child is chat content, so cards draw it as the
			// chat's messaging card; the log keeps every note as the labelled block it
			// always drew. Anything the runner did not mark as a delivered message — and
			// a marker with nothing behind it — stays a note, never a message.
			const received = cards ? steeredMessage(item.text) : undefined;
			const card = received !== undefined && received.trim().length > 0 ? agentMessageCard(received, theme, width) : [];
			return card.length > 0 ? card : [line(theme, ROLE.NOTE, "Note", width), ...contentLines(theme, ROLE.NOTE, item.text, width, 2)];
		}
		case THREAD_ITEM.TOOL:
			// A card owns its frame when the chat offered one; `undefined` covers no
			// renderer, a renderer that does not own its frame, and one that threw.
			return (cards
				? renderAgentToolItem(item, theme, width, { expanded: options.expanded === true })
				: undefined) ?? toolBlock(item, theme, width, showWhole, options.expandHint);
		default:
			return [];
	}
}
