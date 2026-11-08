import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
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

/**
 * The drawing slots a card brings, as far as drawing a whole tool row needs them.
 * A card is published by another extension rather than imported from it, so the
 * shape is structural here: this boundary never depends on a publisher's module.
 */
type CardRendererSlots = Pick<ToolDefinition, "renderShell" | "renderCall" | "renderResult">;

type ReusableCardRenderer = CardRendererSlots & {
	renderShell: "self";
	renderCall: NonNullable<CardRendererSlots["renderCall"]>;
};

/**
 * The process-wide slot extensions publish tool cards into, keyed by tool name.
 *
 * A publisher satisfies this contract: `globalThis[Symbol.for("gentle-pi.quiet-tool-renderers")]`
 * holds a `Map` from tool name to `{ renderer, active? }`; `renderer` draws its own
 * frame (`renderShell: "self"`) and carries a `renderCall`; and an optional
 * `active()` says whether that publisher is drawing the tool this way right now, so
 * a record with no `active` is always offered. Anything else in the slot — a value
 * that is not a `Map`, a record of another shape, a lookup or an `active()` that
 * throws — offers nothing, because a broken publisher must not break a frame.
 */
const CARD_RENDERER_SLOT = Symbol.for("gentle-pi.quiet-tool-renderers");

interface PublishedCardRecord {
	renderer?: unknown;
	active?: unknown;
}

function publishedCard(toolName: string): Record<string, unknown> | undefined {
	try {
		const slot = (globalThis as Record<symbol, unknown>)[CARD_RENDERER_SLOT];
		if (!(slot instanceof Map)) return undefined;
		const record = slot.get(toolName) as PublishedCardRecord | undefined;
		if (record === null || typeof record !== "object") return undefined;
		if (record.active !== undefined) {
			if (typeof record.active !== "function") return undefined;
			if (record.active.call(record) !== true) return undefined;
		}
		const renderer = record.renderer;
		return renderer !== null && typeof renderer === "object" ? (renderer as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

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
export function isReusableAgentToolRenderer(renderer: unknown): renderer is ReusableCardRenderer {
	if (renderer === null || typeof renderer !== "object") return false;
	const slots = renderer as Partial<CardRendererSlots>;
	return slots.renderShell === "self" && typeof slots.renderCall === "function";
}

/**
 * The renderer the chat's canvas was actually handed for `toolName`, or
 * `undefined` when there is none to reuse: no extension published a card for it
 * (another host keeps its own drawing, which this boundary never claims), the
 * published card does not draw its own frame, or it is not what the chat draws
 * this tool with right now. Treat the returned slots as read-only: they are the
 * very functions the chat is rendering with.
 */
export function agentToolRowRenderer(toolName: string): Readonly<ReusableCardRenderer> | undefined {
	const renderer = publishedCard(toolName);
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
 * The result object one retained item was drawn with, computed once. A card is
 * drawn again on every frame, and the shared helpers behind the cards keep their
 * parsed rows and tokenized previews keyed on the result object they are handed,
 * so a fresh object per frame threw that work away every time. The retained item
 * is the invalidation: the protocol replaces the item object on every change, so
 * a changed output, a settled call, a restored diff or a different call is a
 * different item and never reads a result left over from the previous one. It is
 * deliberately not shared between items, and no drawn rows are kept here.
 */
const retainedResults = new WeakMap<ToolItem, AgentToolResult<unknown>>();

function retainedResult(item: ToolItem, output: string): AgentToolResult<unknown> {
	const retained = retainedResults.get(item);
	if (retained !== undefined) return retained;
	const result: AgentToolResult<unknown> = { content: [{ type: "text", text: output }], details: typeof item.diff === "string" ? { diff: sanitizeTerminalText(item.diff) } : undefined };
	retainedResults.set(item, result);
	return result;
}

/**
 * Draws one retained tool call with the renderer the chat itself was handed: the
 * call slot, then — once output exists or the call is final — the result slot
 * that closes the row. That renderer owns its frame (`renderShell: "self"`), so
 * the caller adds no frame of its own.
 *
 * `undefined` means there is nothing to reuse — no extension published a card for
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
		const body = renderer.renderResult(
			retainedResult(item, output),
			{ expanded: options.expanded, isPartial: item.running } as any,
			drawingTheme as any,
			context as any,
		);
		return [...rows, ...body.render(target)];
	} catch {
		return undefined;
	}
}
