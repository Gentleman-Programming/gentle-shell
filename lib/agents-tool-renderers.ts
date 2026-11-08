import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { registeredQuietToolRenderer, type QuietToolRenderer } from "../extensions/quiet-tools.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import type { ToolItem } from "./agents-protocol.ts";

/**
 * The theme roles a chat tool card reads. A card names a role, never a color, so
 * a preview theme forwards its own roles and gives an attribute it does not
 * carry as the text itself — a minimal theme never makes a card throw.
 */
export interface AgentToolRendererTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
	bg?(color: string, text: string): string;
}

export interface AgentToolRenderOptions {
	/** Whether the reader asked for the whole result instead of the collapsed preview. */
	expanded: boolean;
}

type ReusableQuietToolRenderer = QuietToolRenderer & {
	renderShell: "self";
	renderCall: NonNullable<QuietToolRenderer["renderCall"]>;
};

function chatTheme(theme: AgentToolRendererTheme): AgentToolRendererTheme {
	return {
		fg: (color, text) => theme.fg(color, text),
		bold: (text) => (typeof theme.bold === "function" ? theme.bold(text) : text),
		...(typeof theme.bg === "function" ? { bg: (color: string, text: string) => theme.bg!(color, text) } : {}),
	};
}

/**
 * Whether a published renderer can draw a whole tool row: it must state that it
 * draws its own frame (`renderShell: "self"`) and it must have a call slot.
 *
 * A renderer with no result slot still qualifies — it draws its call alone, which
 * is a different case from a tool with no shared renderer at all, and the
 * difference is kept rather than collapsed into one "unsupported" answer.
 */
export function isReusableAgentToolRenderer(renderer: QuietToolRenderer | undefined): renderer is ReusableQuietToolRenderer {
	return renderer?.renderShell === "self" && typeof renderer.renderCall === "function";
}

/**
 * The renderer the chat's canvas was actually handed for `toolName`, or
 * `undefined` when there is none to reuse: quiet-tools published no card for it
 * (another host keeps its own drawing, which this boundary never claims), the
 * published card does not draw its own frame, or it is not what the chat draws
 * this tool with right now. Treat the returned slots as read-only: they are the
 * very functions the chat is rendering with.
 */
export function agentToolRowRenderer(toolName: string): Readonly<ReusableQuietToolRenderer> | undefined {
	const renderer = registeredQuietToolRenderer(toolName);
	return isReusableAgentToolRenderer(renderer) ? renderer : undefined;
}

/**
 * The retained item's strings, cleaned at the drawing boundary. A thread item can
 * be restored from a history file or copied out of a hand-built thread, so it is
 * not evidence that anything sanitized it, while a card draws the text it is
 * handed. A container nothing changed in is returned as it is, so a renderer that
 * compares arguments by identity still sees one object.
 */
function printable(value: unknown): unknown {
	if (typeof value === "string") return sanitizeTerminalText(value);
	if (Array.isArray(value)) {
		const rows = value.map(printable);
		return rows.every((row, index) => row === value[index]) ? value : rows;
	}
	if (value === null || typeof value !== "object") return value;
	// Validated JSON payloads only, so own enumerable entries cover everything a
	// card can read; `Object.fromEntries` defines each key instead of assigning it,
	// so an argument named `__proto__` stays an own property.
	const source = value as Record<string, unknown>;
	const entries = Object.entries(source).map(([key, entry]) => [key, printable(entry)] as const);
	return entries.some(([key, entry]) => entry !== source[key]) ? Object.fromEntries(entries) : source;
}

function callContext(item: ToolItem, args: Record<string, unknown>, options: AgentToolRenderOptions): Record<string, unknown> {
	return {
		args,
		toolCallId: item.callId,
		// The protocol retains no working directory, so none is handed down: a card
		// that resolved a path against a guess would name a file the child never read.
		cwd: "",
		// A retained call has started and its arguments are complete; only a running
		// item is still waiting for output.
		executionStarted: true,
		argsComplete: true,
		isPartial: item.running,
		isError: item.isError,
		expanded: options.expanded,
		// The preview repaints on its own request, so a row has nothing to invalidate.
		invalidate: () => {},
		lastComponent: undefined,
	};
}

/**
 * Draws one retained tool call with the renderer the chat itself was handed: the
 * call slot, then — once output exists or the call is final — the result slot
 * that closes the row. That renderer owns its frame (`renderShell: "self"`), so
 * the caller adds no frame of its own.
 *
 * `undefined` means there is nothing to reuse — quiet-tools published no card for
 * this tool, the card does not draw its own frame, or it threw while drawing (a
 * preview theme, or a host that has not initialized pi's theme). The caller then
 * draws its generic block: there is deliberately no per-tool fallback here,
 * because a second implementation per tool is what this boundary removes. An
 * empty array is a renderer that legitimately draws nothing for this call.
 */
export function renderAgentToolItem(
	item: ToolItem,
	theme: AgentToolRendererTheme,
	width: number,
	options: AgentToolRenderOptions,
): string[] | undefined {
	const renderer = agentToolRowRenderer(item.name);
	if (!renderer) return undefined;
	const target = Math.max(0, Math.floor(width));
	if (target === 0) return [];
	const args = printable(item.args) as Record<string, unknown>;
	const output = sanitizeTerminalText(item.output);
	const context = callContext(item, args, options);
	const drawingTheme = chatTheme(theme);
	try {
		// The chat's slots take pi's own theme and render context; the preview theme
		// and the retained context above are the structural subset every card reads.
		const rows = renderer.renderCall(args, drawingTheme as any, context as any).render(target);
		// A running call with nothing retained yet has no result slot, exactly as the
		// transcript draws it: the call closes its own frame until output arrives.
		if (item.running && output.length === 0) return rows;
		if (typeof renderer.renderResult !== "function") return rows;
		const result: AgentToolResult<unknown> = { content: [{ type: "text", text: output }], details: typeof item.diff === "string" ? { diff: sanitizeTerminalText(item.diff) } : undefined };
		const body = renderer.renderResult(
			result,
			{ expanded: options.expanded, isPartial: item.running } as any,
			drawingTheme as any,
			context as any,
		);
		return [...rows, ...body.render(target)];
	} catch {
		return undefined;
	}
}
