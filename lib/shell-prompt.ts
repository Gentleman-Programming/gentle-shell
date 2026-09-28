import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "./terminal-theme.ts";

// Gentle Shell prompt frame. pi's editor renders a top rule, padded content
// lines, and a bottom rule; this module wraps those lines in a rounded frame
// with a petal that shows what the agent is doing. Everything here is pure.

export const PROMPT_STATE = {
	IDLE: "idle",
	WORKING: "working",
	QUEUED: "queued",
} as const;

export type PromptState = (typeof PROMPT_STATE)[keyof typeof PROMPT_STATE];

const PETAL_TONE = {
	BRIGHT: "borderAccent",
	ROSE: "accent",
	SOFT: "thinkingHigh",
	DEEP: "mdQuoteBorder",
	WARNING: "warning",
} as const;

export type PetalTone = (typeof PETAL_TONE)[keyof typeof PETAL_TONE];

// Keep Pi's original loader cadence while carrying the banner's reflected-light
// language into the compact working labels. The highlight enters before the
// word, crosses it as a soft symmetric wave, then exits before wrapping.
export const SHELL_PULSE_MS = 80;
export const SHELL_SCANNER_STEPS = 15;
const SCANNER_ENTRY_OFFSET = 3;

/** Banner-style reflected-light wave across text; foreground only. */
export function scanWorkingText(text: string, tick: number, fg: (role: string, text: string) => string): string {
	const phase = ((Math.floor(tick) % SHELL_SCANNER_STEPS) + SHELL_SCANNER_STEPS) % SHELL_SCANNER_STEPS;
	const head = phase - SCANNER_ENTRY_OFFSET;
	return Array.from(text, (char, index) => {
		const distance = Math.abs(head - index);
		const role = distance === 0 ? "borderAccent" : distance === 1 ? "accent" : distance === 2 ? "thinkingHigh" : "muted";
		return fg(role, char);
	}).join("");
}
const PETAL_TONE_FRAMES = [PETAL_TONE.DEEP, PETAL_TONE.SOFT, PETAL_TONE.ROSE, PETAL_TONE.BRIGHT, PETAL_TONE.ROSE, PETAL_TONE.SOFT, PETAL_TONE.DEEP, PETAL_TONE.DEEP] as const;

export interface PromptFrameOptions {
	state: PromptState;
	tick: number;
	borderColor: (text: string) => string;
	fg: (color: string, text: string) => string;
	bold?: (text: string) => string;
	/**
	 * Overrides the editor's own bottom scroll indicator (e.g. "esc again to
	 * cancel"). Both share the bottom rule's single label slot; an explicit
	 * hint always wins because it reflects state the editor cannot render on
	 * its own.
	 */
	escHint?: string;
	/**
	 * Overrides the generic "working…" label while state is WORKING with an
	 * explicit, orchestrator-reported ODD phase label (e.g. "exploring…").
	 * Ignored outside the WORKING state; undefined falls back to "working…".
	 */
	workingLabel?: string;
}

// A terminal cell cannot grow, so the petal earns presence with weight and
// the brightest rose in the theme. Working spins through four flowers.
export const PROMPT_PETAL = "✿";
const PETAL_FRAMES = ["✿", "❀", "❁", "✾"] as const;
export const PROMPT_HINT = "type, or / for commands";
export const DOUBLE_ESC_CANCEL_HINT = "esc again to cancel";
export const IDLE_ESC_CLEAR_HINT = "esc again to clear";
const LABEL_ROLE = "muted";
const HINT_ROLE = "dim";
const FAKE_CURSOR = "\x1b[7m \x1b[0m";
const SCROLL_INDICATOR = /[↑↓] \d+ more/;
const STATE_LABEL: Record<PromptState, string | undefined> = {
	[PROMPT_STATE.IDLE]: undefined,
	[PROMPT_STATE.WORKING]: "working…",
	[PROMPT_STATE.QUEUED]: "queued",
};

export function petalTone(state: PromptState, tick: number): PetalTone {
	if (state === PROMPT_STATE.QUEUED) return PETAL_TONE.WARNING;
	if (state === PROMPT_STATE.WORKING) return PETAL_TONE_FRAMES[tick % PETAL_TONE_FRAMES.length];
	return PETAL_TONE.BRIGHT;
}

export function petalGlyph(state: PromptState, tick: number): string {
	if (state === PROMPT_STATE.IDLE) return PROMPT_PETAL;
	return PETAL_FRAMES[tick % PETAL_FRAMES.length];
}

function scrollIndicator(rule: string): string | undefined {
	return stripAnsi(rule).match(SCROLL_INDICATOR)?.[0];
}

function rule(length: number): string {
	return "─".repeat(Math.max(0, length));
}

function stateLabel(options: PromptFrameOptions): string | undefined {
	if (options.state === PROMPT_STATE.WORKING) return options.workingLabel ?? STATE_LABEL[PROMPT_STATE.WORKING];
	return STATE_LABEL[options.state];
}

function topRule(width: number, options: PromptFrameOptions, indicator: string | undefined): string {
	const label = indicator ?? stateLabel(options);
	const scanning = options.state === PROMPT_STATE.WORKING;
	const glyph = petalGlyph(options.state, options.tick);
	const petal = options.fg(petalTone(options.state, options.tick), options.bold ? options.bold(glyph) : glyph);
	const paintedLabel = label && scanning && !indicator ? scanWorkingText(label, options.tick, options.fg) : label ? options.fg(LABEL_ROLE, label) : "";
	const title = [petal, paintedLabel].filter(Boolean).join(" ");
	const titleWidth = visibleWidth(glyph) + (label ? visibleWidth(label) + (glyph ? 1 : 0) : 0);
	const fill = width - titleWidth - 5;
	if (fill < 0) return options.borderColor(`╭${rule(width - 2)}╮`);
	return options.borderColor("╭─ ") + title + options.borderColor(` ${rule(fill)}╮`);
}

function bottomRule(width: number, options: PromptFrameOptions, indicator: string | undefined): string {
	if (!indicator) return options.borderColor(`╰${rule(width - 2)}╯`);
	const fill = width - 3 - indicator.length - 1 - 1;
	if (fill < 0) return options.borderColor(`╰${rule(width - 2)}╯`);
	return options.borderColor("╰─ ") + options.fg(LABEL_ROLE, indicator) + options.borderColor(` ${rule(fill)}╯`);
}

function sideRules(line: string, innerWidth: number, options: PromptFrameOptions): string {
	const clipped = innerWidth === 0 ? "" : truncateToWidth(line, innerWidth, "");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const content = clipped + padding;
	return options.borderColor("│") + content + options.borderColor("│");
}

export function framePromptLines(lines: string[], width: number, options: PromptFrameOptions): string[] {
	width = Math.max(0, Math.floor(width));
	if (lines.length < 2) return lines.map((line) => truncateToWidth(line, width, ""));
	if (width < 2) return lines.map((_line, index) => width === 0 ? "" : options.borderColor(index === 0 ? "╭" : index === lines.length - 1 ? "╰" : "│"));
	const innerWidth = width - 2;
	const top = lines[0];
	const bottom = lines[lines.length - 1];
	const content = lines.slice(1, -1).map((line) => sideRules(line, innerWidth, options));
	return [topRule(width, options, scrollIndicator(top)), ...content, bottomRule(width, options, options.escHint ?? scrollIndicator(bottom))];
}

export function withPromptHint(line: string, hint: string, fg: PromptFrameOptions["fg"]): string {
	const cursorAt = line.indexOf(FAKE_CURSOR);
	if (cursorAt === -1) return line;
	const afterCursor = cursorAt + FAKE_CURSOR.length;
	const trailing = line.slice(afterCursor);
	if (trailing.trim() !== "" || trailing.length < hint.length + 1) return line;
	return `${line.slice(0, afterCursor)} ${fg(HINT_ROLE, hint)}${" ".repeat(trailing.length - hint.length - 1)}`;
}
