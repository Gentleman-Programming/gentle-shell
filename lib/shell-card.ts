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
}

export interface CardRenderOptions {
	expanded: boolean;
	/** Right-aligned hint in the top rule, e.g. the expand key. May carry ANSI. */
	hint?: string;
}

export const CARD_GLYPH = "✿";
const TONE_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "customMessageLabel",
	[CARD_TONE.SUCCESS]: "success",
	[CARD_TONE.WARNING]: "warning",
	[CARD_TONE.ERROR]: "error",
};
const HINT_ROLE = "dim";
const SUBTITLE_ROLE = "muted";
const BODY_ROLE = "text";
const SEPARATOR = "·";
const FRAME_COLUMNS = 4;

function rule(length: number): string {
	return "─".repeat(Math.max(0, length));
}

function titleText(card: Card, theme: CardTheme): { styled: string; width: number } {
	const head = `${card.glyph ?? CARD_GLYPH} ${card.title}`;
	const styled = card.subtitle
		? `${theme.fg(TONE_ROLE[card.tone], head)} ${theme.fg(SUBTITLE_ROLE, SEPARATOR)} ${theme.fg(SUBTITLE_ROLE, card.subtitle)}`
		: theme.fg(TONE_ROLE[card.tone], head);
	return { styled, width: visibleWidth(head) + (card.subtitle ? visibleWidth(card.subtitle) + 3 : 0) };
}

function bodyLines(card: Card, innerWidth: number): string[] {
	return card.body.flatMap((paragraph) => (paragraph === "" ? [""] : wrapTextWithAnsi(paragraph, innerWidth)));
}

function frame(theme: CardTheme, tone: CardTone, text: string): string {
	return theme.fg(TONE_ROLE[tone], text);
}

export function cardTop(card: Card, theme: CardTheme, width: number, hint?: string): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	if (targetWidth < 5) {
		const left = theme.fg(TONE_ROLE[card.tone], "╭");
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
	return theme.fg(TONE_ROLE[card.tone], "╭") + frame(theme, card.tone, "─ ") + styledTitle + frame(theme, card.tone, ` ${fill}`) + tail + frame(theme, card.tone, "╮");
}

export function cardLine(text: string, tone: CardTone, theme: CardTheme, width: number): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	const left = theme.fg(TONE_ROLE[tone], "│");
	if (targetWidth === 1) return left;
	if (targetWidth === 2) return left + frame(theme, tone, "│");
	if (targetWidth === 3) return `${left} ${frame(theme, tone, "│")}`;

	const innerWidth = targetWidth - FRAME_COLUMNS;
	const clipped = innerWidth === 0 ? "" : truncateToWidth(text, innerWidth, "…");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return `${left} ${clipped}${padding} ${frame(theme, tone, "│")}`;
}

export function cardBottom(tone: CardTone, theme: CardTheme, width: number): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	const left = theme.fg(TONE_ROLE[tone], "╰");
	if (targetWidth === 1) return left;
	return left + frame(theme, tone, `${rule(targetWidth - 2)}╯`);
}

export function cardInnerWidth(width: number): number {
	return Math.max(1, width - FRAME_COLUMNS);
}

export function renderCard(card: Card, theme: CardTheme, width: number, options: CardRenderOptions): string[] {
	const innerWidth = Math.max(1, width - FRAME_COLUMNS);
	const top = cardTop(card, theme, width, options.hint);
	const bottom = cardBottom(card.tone, theme, width);
	const lines = bodyLines(card, innerWidth);
	const body = (() => {
		if (lines.length === 0) return [];
		if (!options.expanded) {
			const first = lines.find((line) => line !== "") ?? "";
			const clipped = lines.length > 1 ? truncateToWidth(first, Math.max(1, innerWidth - 1), "") + "…" : first;
			return [cardLine(theme.fg(BODY_ROLE, clipped), card.tone, theme, width)];
		}
		return lines.map((line) => cardLine(line === "" ? "" : theme.fg(BODY_ROLE, line), card.tone, theme, width));
	})();
	return [top, ...body, bottom];
}
