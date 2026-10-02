import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Gentle Shell cards: the shape every Gentle notice takes in the transcript
// and above the editor. The same rounded frame as the prompt and the
// overlays, with the title in the card's tone. Pure: strings in, lines out.

export const CARD_TONE = {
	INFO: "info",
	SUCCESS: "success",
	WARNING: "warning",
	ERROR: "error",
} as const;

export type CardTone = (typeof CARD_TONE)[keyof typeof CARD_TONE];

export interface Card {
	title: string;
	subtitle?: string;
	body: string[];
	tone: CardTone;
	glyph?: string;
}

export interface CardTheme {
	fg(color: string, text: string): string;
	/** Pi themes have it; the float style needs it to paint its panel. */
	bg?(color: string, text: string): string;
}

// Conversation cards come in two styles, chosen in /gentle:customize. Pi loads
// every extension with its own jiti loader (moduleCache:false), so each one
// gets a copy of this module; the global symbol keeps one style per process.
export const CARD_STYLE = {
	NEON: "neon",
	FLOAT: "float",
} as const;

export type CardStyle = (typeof CARD_STYLE)[keyof typeof CARD_STYLE];

const CARD_STYLE_SLOT = Symbol.for("gentle-pi.card-style");
const styleState = globalThis as typeof globalThis & { [CARD_STYLE_SLOT]?: unknown };

export function cardStyle(): CardStyle {
	return styleState[CARD_STYLE_SLOT] === CARD_STYLE.NEON ? CARD_STYLE.NEON : CARD_STYLE.FLOAT;
}

export function setCardStyle(style: CardStyle): void {
	styleState[CARD_STYLE_SLOT] = style;
}

export interface CardRenderOptions {
	expanded: boolean;
	/** Optional physical-row budget for useful tool previews; notices default to one. */
	previewRows?: number;
	/** Right-aligned hint in the top rule, e.g. the expand key. May carry ANSI. */
	hint?: string;
	/**
	 * Fixed chrome panels (Agents, Todos, Status rail) opt in here. The float
	 * style then paints them like float cards, centered between two padding
	 * rows with a blank row between header and body: `panelExtraRows` taller
	 * than neon when a body exists, with the header on `panelHeaderRow`.
	 * Neon keeps the outlined frame. Conversation cards never set it.
	 */
	panel?: boolean;
}

export const CARD_GLYPH = "✿";
// Frame and title paint with the same role for every tone except INFO, whose
// rounded frame stays in the theme's plain border role while its title
// carries the accent role — the rose look every informational card (sidebar,
// review preflight, a quiet Agents widget, ...) uses.
const FRAME_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "border",
	[CARD_TONE.SUCCESS]: "success",
	[CARD_TONE.WARNING]: "warning",
	[CARD_TONE.ERROR]: "error",
};
const TITLE_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "accent",
	[CARD_TONE.SUCCESS]: "success",
	[CARD_TONE.WARNING]: "warning",
	[CARD_TONE.ERROR]: "error",
};
const HINT_ROLE = "dim";
const SUBTITLE_ROLE = "muted";
const BODY_ROLE = "text";
const SEPARATOR = "·";
const FRAME_COLUMNS = 4;

// The characters that draw a card around its content. The float style keeps
// every row the same width: the left edge becomes an accent bar and the rules
// and the right rail become spaces. Rows are built from these by position, so
// content that happens to contain box-drawing characters is never rewritten.
interface CardChrome {
	topLeft: string;
	topLead: string;
	topRight: string;
	rule: string;
	side: string;
	rail: string;
	bottomLeft: string;
	bottomRight: string;
}

const OUTLINE_CHROME: CardChrome = { topLeft: "╭", topLead: "─ ", topRight: "╮", rule: "─", side: "│", rail: "│", bottomLeft: "╰", bottomRight: "╯" };
// `▎ ` is one cell narrower than `╭─ `: the spare cell moves to the right end
// so the heading glyph starts in the same column as the body text.
const FLOAT_CHROME: CardChrome = { topLeft: "▎", topLead: " ", topRight: "  ", rule: " ", side: "▎", rail: " ", bottomLeft: "▎", bottomRight: " " };
let chrome = OUTLINE_CHROME;

function withChrome<T>(next: CardChrome, run: () => T): T {
	const previous = chrome;
	chrome = next;
	try {
		return run();
	} finally {
		chrome = previous;
	}
}

function rule(length: number): string {
	return chrome.rule.repeat(Math.max(0, length));
}

function titleText(card: Card, theme: CardTheme): { styled: string; width: number } {
	const head = `${card.glyph ?? CARD_GLYPH} ${card.title}`;
	const styled = card.subtitle
		? `${theme.fg(TITLE_ROLE[card.tone], head)} ${theme.fg(SUBTITLE_ROLE, SEPARATOR)} ${theme.fg(SUBTITLE_ROLE, card.subtitle)}`
		: theme.fg(TITLE_ROLE[card.tone], head);
	return { styled, width: visibleWidth(head) + (card.subtitle ? visibleWidth(card.subtitle) + 3 : 0) };
}

function bodyLines(card: Card, innerWidth: number): string[] {
	return card.body.flatMap((paragraph) => (paragraph === "" ? [""] : wrapTextWithAnsi(paragraph, innerWidth)));
}

function frame(theme: CardTheme, tone: CardTone, text: string): string {
	return theme.fg(FRAME_ROLE[tone], text);
}

export function cardTop(card: Card, theme: CardTheme, width: number, hint?: string): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	if (targetWidth < 5) {
		const left = theme.fg(FRAME_ROLE[card.tone], "╭");
		if (targetWidth === 1) return left;
		return left + frame(theme, card.tone, `${rule(targetWidth - 2)}╮`);
	}

	const title = titleText(card, theme);
	const fullHintWidth = hint ? visibleWidth(hint) + 2 : 0;
	const shownHint = hint && title.width + 5 + fullHintWidth <= targetWidth ? hint : undefined;
	const hintWidth = shownHint ? fullHintWidth : 0;
	const titleWidth = Math.max(0, targetWidth - 5 - hintWidth);
	const styledTitle = title.width <= titleWidth ? title.styled : truncateToWidth(title.styled, titleWidth, "");
	const styledTitleWidth = title.width <= titleWidth ? title.width : visibleWidth(styledTitle);
	const fill = rule(targetWidth - styledTitleWidth - 5 - hintWidth);
	const tail = shownHint ? ` ${theme.fg(HINT_ROLE, shownHint)} ` : "";
	return theme.fg(FRAME_ROLE[card.tone], chrome.topLeft) + frame(theme, card.tone, chrome.topLead) + styledTitle + frame(theme, card.tone, ` ${fill}`) + tail + frame(theme, card.tone, chrome.topRight);
}

export function cardLine(text: string, tone: CardTone, theme: CardTheme, width: number): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	const left = theme.fg(FRAME_ROLE[tone], chrome.side);
	if (targetWidth === 1) return left;
	if (targetWidth === 2) return left + frame(theme, tone, "│");
	if (targetWidth === 3) return `${left} ${frame(theme, tone, "│")}`;

	const innerWidth = targetWidth - FRAME_COLUMNS;
	const clipped = innerWidth === 0 ? "" : truncateToWidth(text, innerWidth, "…");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return `${left} ${clipped}${padding} ${frame(theme, tone, chrome.rail)}`;
}

export function cardBottom(tone: CardTone, theme: CardTheme, width: number, content?: string): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	const left = theme.fg(FRAME_ROLE[tone], chrome.bottomLeft);
	if (targetWidth === 1) return left;
	if (content === undefined || visibleWidth(content) === 0) return left + frame(theme, tone, `${rule(targetWidth - 2)}${chrome.bottomRight}`);
	const contentWidth = visibleWidth(content) + 2;
	// Responsive: the duration rides the closing rule only when it fits with a minimum fill.
	if (targetWidth - 2 - contentWidth < 3) return left + frame(theme, tone, `${rule(targetWidth - 2)}${chrome.bottomRight}`);
	return left + frame(theme, tone, `${rule(targetWidth - 2 - contentWidth)} `) + theme.fg(HINT_ROLE, content) + frame(theme, tone, ` ${chrome.bottomRight}`);
}

export function cardInnerWidth(width: number): number {
	return Math.max(1, width - FRAME_COLUMNS);
}

/** Shared body for whole cards and separate call/result components. Budgets apply after wrapping. */
export function cardBodyRows(
	rows: readonly string[], tone: CardTone, theme: CardTheme, width: number,
	options: CardRenderOptions,
): string[] {
	if (width <= 0) return [];
	const wrapped = rows.flatMap((row) => row.split("\n").flatMap((line) => line === "" ? [""] : wrapTextWithAnsi(line, cardInnerWidth(width))));
	const limit = Math.max(0, Math.floor(options.previewRows ?? 3));
	const shown = options.expanded ? wrapped : wrapped.slice(0, limit);
	return shown.map((line) => cardLine(line, tone, theme, width));
}

// Pi draws a tool row as the call component followed, once a result exists,
// by the result component, which closes the frame. The call cannot see the
// result, so result renderers mark the row state both share, and a call still
// waiting for its first result closes its own frame.
const RESULT_MARK = Symbol.for("gentle-pi.card-result");
const RUNNING_TEXT = "running…";
const RUNNING_ROLE = "muted";

/** The fields of pi's tool render context that tell whether a result exists. */
export interface CardRowContext {
	isPartial?: boolean;
	state?: unknown;
}

/** Result renderers mark the shared row state: from now on a result component closes the card. */
export function markCardResult(state: unknown): void {
	if (state !== null && typeof state === "object") (state as Record<symbol, unknown>)[RESULT_MARK] = true;
}

/** Whether a call card must close its own frame. Read it at render time: pi builds the result component after the call. */
export function cardAwaitingResult(context: CardRowContext): boolean {
	if (context.isPartial === false) return false;
	const state = context.state;
	return !(state !== null && typeof state === "object" && (state as Record<symbol, unknown>)[RESULT_MARK] === true);
}

/** The muted body row of a call card that is still waiting for its result. */
export function cardRunningLine(tone: CardTone, theme: CardTheme, width: number): string {
	return cardLine(theme.fg(RUNNING_ROLE, RUNNING_TEXT), tone, theme, width);
}

/** Quiet calls may continue long or multiline headings inside the same frame. */
export function cardTopRows(card: Card, theme: CardTheme, width: number, hint?: string): string[] {
	const target = Math.max(0, Math.floor(width));
	if (target === 0) return [];
	if (target < 8) return [cardTop(card, theme, target, hint)];
	const [first = "", ...rest] = card.title.split("\n");
	// Reserve the hint before wrapping, plus one rule column and enough heading
	// space to retain identity. This policy belongs only to continuing tool tops.
	const available = target - 6 - visibleWidth(`${card.glyph ?? CARD_GLYPH} `) - (card.subtitle ? visibleWidth(card.subtitle) + 3 : 0);
	const hintWidth = hint ? visibleWidth(hint) + 2 : 0;
	const shownHint = hint && available - hintWidth >= 12 ? hint : undefined;
	const room = Math.max(1, available - (shownHint ? hintWidth : 0));
	const [head = "", ...overflow] = wrapTextWithAnsi(first, room);
	return [
		cardTop({ ...card, title: head }, theme, target, shownHint),
		...cardBodyRows([...overflow, ...rest], card.tone, theme, target, { expanded: true }),
	];
}

/** The rows one card component draws, by position. */
export interface CardParts {
	/** The top rule plus any heading continuation rows. */
	head?: readonly string[];
	body?: readonly string[];
	/** The closing rule, when this component closes the card. */
	bottom?: string;
	/** A component above this one already drew the heading. */
	afterHeading?: boolean;
}

const FLOAT_MARGIN = 1;
const FLOAT_MIN_WIDTH = 10;
const FLOAT_BG_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "toolSuccessBg",
	[CARD_TONE.SUCCESS]: "toolSuccessBg",
	[CARD_TONE.WARNING]: "toolPendingBg",
	[CARD_TONE.ERROR]: "toolErrorBg",
};
const BG_RESET = "\x1b[49m";
// Full resets (pi-tui truncation inserts one) and background resets.
const BG_CLEARING = /\x1b\[(?:0|49)?m/g;

function panelOpener(theme: CardTheme, tone: CardTone): string {
	if (typeof theme.bg !== "function") return "";
	try {
		const painted = theme.bg(FLOAT_BG_ROLE[tone], "");
		return painted.endsWith(BG_RESET) ? painted.slice(0, -BG_RESET.length) : "";
	} catch {
		// A theme without the tool background keeps the outlined card.
		return "";
	}
}

/**
 * Draws one conversation card component in the active style. The outlined
 * style returns the parts unchanged; the float style renders them one margin
 * narrower with the float chrome and paints a tone background behind every
 * row. A blank row sits above the heading and between it and the body.
 */
export function floatRows(tone: CardTone, theme: CardTheme, width: number, render: (width: number) => CardParts): string[] {
	const target = Math.max(0, Math.floor(width));
	const open = floatOpener(theme, tone, target);
	if (!open) {
		const { head = [], body = [], bottom } = render(width);
		return [...head, ...body, ...(bottom === undefined ? [] : [bottom])];
	}
	const inner = target - FLOAT_MARGIN * 2;
	const rows = withChrome(FLOAT_CHROME, () => {
		const { head = [], body = [], bottom, afterHeading = false } = render(inner);
		const blank = cardBottom(tone, theme, inner);
		return [
			...(head.length > 0 ? [blank, ...head] : []),
			...(body.length > 0 && (head.length > 0 || afterHeading) ? [blank] : []),
			...body,
			...(bottom === undefined ? [] : [bottom]),
		];
	});
	return paintFloat(rows, open);
}

/** The tone background opener when the float style applies at this width, or "" for the outlined card. */
function floatOpener(theme: CardTheme, tone: CardTone, width: number): string {
	return cardStyle() === CARD_STYLE.FLOAT && Math.floor(width) >= FLOAT_MIN_WIDTH ? panelOpener(theme, tone) : "";
}

// Paints every row behind its tone background, re-armed after any reset the
// content carries, inside a transparent one-column margin on both sides.
// Padding rows keep their tone-coloured accent just like content rows.
function paintFloat(rows: readonly string[], open: string): string[] {
	const margin = " ".repeat(FLOAT_MARGIN);
	return rows.map((row) => `${margin}${open}${row.replace(BG_CLEARING, (reset) => reset + open)}${BG_RESET}${margin}`);
}

/**
 * Content columns of a panel body (Agents, Todos, Status rail) in the active
 * style. Callers that pre-wrap or pre-fit rows use it so a float panel, two
 * columns narrower than the outlined frame, never re-wraps or clips them.
 */
export function panelInnerWidth(theme: CardTheme, width: number, tone: CardTone = CARD_TONE.INFO): number {
	return floatOpener(theme, tone, width) ? cardInnerWidth(Math.floor(width) - FLOAT_MARGIN * 2) : cardInnerWidth(width);
}

/**
 * The row a panel draws its header on in the active style: 0 for the
 * outlined frame, 1 below the float panel's top padding row. Callers
 * hit-test their header control with it.
 */
export function panelHeaderRow(theme: CardTheme, width: number, tone: CardTone = CARD_TONE.INFO): number {
	return floatOpener(theme, tone, width) ? 1 : 0;
}

/**
 * Rows a float panel with a body adds over the outlined frame: the top
 * padding row and the separator below the header, or 0 for the outlined
 * frame. Callers with a row budget spend them from the body.
 */
export function panelExtraRows(theme: CardTheme, width: number, tone: CardTone = CARD_TONE.INFO): number {
	return floatOpener(theme, tone, width) ? 2 : 0;
}

export function renderCard(card: Card, theme: CardTheme, width: number, options: CardRenderOptions): string[] {
	// Only opt-in tool previews collapse to nothing at nonpositive widths; the
	// legacy path keeps its empty-row shape for widgets that call it unguarded.
	if (options.previewRows !== undefined) return width <= 0 ? [] : floatRows(card.tone, theme, width, (inner) => ({
		head: [cardTop(card, theme, inner, options.hint)],
		body: cardBodyRows(card.body.map((line) => theme.fg(BODY_ROLE, line)), card.tone, theme, inner, options),
		bottom: cardBottom(card.tone, theme, inner),
	}));
	// Without the panel opt-in, legacy cards always keep the outlined frame.
	if (chrome !== OUTLINE_CHROME) return withChrome(OUTLINE_CHROME, () => renderCard(card, theme, width, options));
	const open = options.panel ? floatOpener(theme, card.tone, width) : "";
	if (open) return paintFloat(withChrome(FLOAT_CHROME, () => floatPanel(card, theme, Math.floor(width) - FLOAT_MARGIN * 2, options)), open);
	const top = cardTop(card, theme, width, options.hint);
	const bottom = cardBottom(card.tone, theme, width);
	return [top, ...cardText(card, theme, cardInnerWidth(width), options.expanded).map((line) => cardLine(line, card.tone, theme, width)), bottom];
}

/** Body text of a legacy card or panel, wrapped to its content columns, before the side rails. */
function cardText(card: Card, theme: CardTheme, innerWidth: number, expanded: boolean): string[] {
	const lines = bodyLines(card, innerWidth);
	if (lines.length === 0) return [];
	if (!expanded) {
		const first = lines.find((line) => line !== "") ?? "";
		const clipped = lines.length > 1 ? truncateToWidth(first, Math.max(1, innerWidth - 1), "") + "…" : first;
		return [theme.fg(BODY_ROLE, clipped)];
	}
	return lines.map((line) => (line === "" ? "" : theme.fg(BODY_ROLE, line)));
}

// Float panels: the float card chrome. Padding rows that keep the accent bar
// sit above the heading, between heading and body (only when a body exists)
// and in the bottom rule's place, centering the content: panelExtraRows taller
// than neon, with the heading on row 1 (see panelHeaderRow).
function floatPanel(card: Card, theme: CardTheme, width: number, options: CardRenderOptions): string[] {
	const blank = cardBottom(card.tone, theme, width);
	const body = cardText(card, theme, cardInnerWidth(width), options.expanded).map((line) => cardLine(line, card.tone, theme, width));
	return [blank, panelHeader(card, theme, width, options.hint), ...(body.length > 0 ? [blank, ...body] : []), blank];
}

function fitRow(text: string, width: number): string {
	const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

// `▎ <glyph> <title>  <subtitle>` left and the hint right, ending in the same
// two columns the body rows keep for their right edge.
function panelHeader(card: Card, theme: CardTheme, width: number, hint?: string): string {
	const lead = theme.fg(FRAME_ROLE[card.tone], chrome.topLeft) + chrome.topLead;
	const subtitle = card.subtitle ? `  ${theme.fg(SUBTITLE_ROLE, card.subtitle)}` : "";
	const left = `${lead}${theme.fg(TITLE_ROLE[card.tone], `${card.glyph ?? CARD_GLYPH} ${card.title}`)}${subtitle}`;
	const right = hint ? `${theme.fg(SUBTITLE_ROLE, hint)}${chrome.topRight}` : "";
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return right && gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : fitRow(left, width);
}
