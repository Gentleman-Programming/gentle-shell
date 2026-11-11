import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "./terminal-theme.ts";
import { CARD_STYLE, type CardStyle } from "./shell-card.ts";
import { paintHoverable } from "./shell-hover.ts";

// Pure prompt chrome: neon keeps Pi's rule/content/rule rows in a rounded
// frame; float retains those indices as painted status/content/padding.

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

// Working-animation cadence: the scanner phase derives from elapsed time
// (workingTick), not render count — streaming repaints arrive in bursts and
// silent tool runs barely repaint, so a render-driven wave strobes or freezes.
// The pulse timer only keeps repaints flowing: SHELL_PULSE_MS under quality,
// the coarse watchdog window under potato (no timer; repaints that happen
// anyway still show the current coarse frame).
export const SHELL_PULSE_WATCHDOG_MS = 1000;
export const SHELL_PULSE_MS = 80;
export const SHELL_SCANNER_STEPS = 15;
const SCANNER_ENTRY_OFFSET = 3;

/**
 * Animation phase after `now` milliseconds of working time: one wave step per
 * `unitMs` pulse window, so two repaints inside one window paint the identical
 * frame and each window advances the wave exactly one step.
 */
export function workingTick(now: number, unitMs = SHELL_PULSE_MS): number {
	return Math.floor(now / Math.max(1, unitMs));
}

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
	style?: CardStyle;
	bg?: (role: string, text: string) => string;
	state: PromptState;
	tick: number;
	borderColor: (text: string) => string;
	fg: (color: string, text: string) => string;
	bold?: (text: string) => string;
	/**
	 * Overrides the editor's own bottom scroll indicator (e.g. "esc again to
	 * cancel"). Both share the bottom rule / float hint slot; an explicit
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
	/** A working panel callback is available in fullscreen editor chrome. */
	panelButton?: boolean;
	panelHovered?: boolean;
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
// Audited legacy SGR and Pi 1.2 APC cursors. Do not resolve the latter
// here: the host TUI owns hardware-cursor suppression after composition.
const EMPTY_FAKE_CURSORS = ["\x1b[7m \x1b[0m", "\x1b_pi:fc\x07 \x1b_pi:/fc\x07"];
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

export interface PromptLayout {
	width: number;
	nativeWidth: number;
	prefixWidth: number;
	background: string;
	/** The wide IDE chrome's editor: a titled rule and a `›` prompt, no frame. */
	panel?: boolean;
}

/** Resolve fallback before native wrapping, selection, completion and mouse geometry. */
export function resolvePromptLayout(width: number, style?: CardStyle, bg?: PromptFrameOptions["bg"], panel = false): PromptLayout {
	width = Math.max(0, Math.floor(width));
	if (panel && width >= 4) return { width, nativeWidth: Math.max(1, width - PANEL_PROMPT.length), prefixWidth: PANEL_PROMPT.length, background: "", panel: true };
	let background = "";
	if (style === CARD_STYLE.FLOAT && width >= 10 && bg) {
		try {
			const painted = bg("toolSuccessBg", " ");
			const match = painted.match(/^((?:\x1b\[[\d;]*m)+) (?:\x1b\[(?:49|0)?m)$/);
			if (match) {
				for (const sgr of match[1].matchAll(/\x1b\[([\d;]*)m/g)) {
					for (const command of promptSgrCommands(sgr[1])) {
						const code = command[0];
						if (code === 0 || code === 49) background = "";
						else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) ||
							(code === 48 && ((command[1] === 5 && command.length === 3) || (command[1] === 2 && command.length === 5)))) {
							background = `\x1b[${command.join(";")}m`;
						}
					}
				}
			}
		} catch { /* Missing theme background: retain the entire neon path. */ }
	}
	return { width, nativeWidth: Math.max(1, width - (background ? 5 : 2)), prefixWidth: background ? 3 : 1, background };
}

// Extended-colour parameters belong to one command: zero RGB channels
// must never be interpreted as full styling resets.
function promptSgrCommands(parameters: string): number[][] {
	const codes = parameters.split(";").map(Number);
	const commands: number[][] = [];
	for (let i = 0; i < codes.length;) {
		const extended = codes[i] === 38 || codes[i] === 48 || codes[i] === 58;
		const length = extended && codes[i + 1] === 2 ? 5 : extended && codes[i + 1] === 5 ? 3 : 1;
		commands.push(codes.slice(i, i + length));
		i += length;
	}
	return commands;
}

// Rearm only the panel background, leaving marker/inversion bytes intact.
function rearmPromptBackground(text: string, background: string): string {
	return text.replace(/\x1b\[([\d;]*)m/g, (sgr, parameters: string) =>
		promptSgrCommands(parameters).some(([code]) => code === 0 || code === 49) ? sgr + background : sgr);
}

/** Same chrome and horizontal prefix for editable and native completion rows. */
export function floatPromptRow(line: string, layout: PromptLayout, borderColor: PromptFrameOptions["borderColor"]): string {
	const clipped = truncateToWidth(line, layout.nativeWidth, "");
	const content = borderColor("▎") + " " + clipped + " ".repeat(Math.max(0, layout.nativeWidth - visibleWidth(clipped))) + " ";
	return " " + layout.background + rearmPromptBackground(content, layout.background) + "\x1b[49m ";
}

function floatPromptHint(top: string, bottom: string, options: PromptFrameOptions, width: number): string {
	const glyph = petalGlyph(options.state, options.tick);
	const petal = options.fg(petalTone(options.state, options.tick), options.bold ? options.bold(glyph) : glyph);
	const label = stateLabel(options) ?? "waiting for input";
	let paintedLabel = "";
	if (label) {
		paintedLabel = options.state === PROMPT_STATE.WORKING
			? scanWorkingText(label, options.tick, options.fg)
			: options.fg(LABEL_ROLE, label);
	}
	const info = [scrollIndicator(top), options.escHint ?? scrollIndicator(bottom)]
		.filter((text): text is string => Boolean(text))
		.map((text) => options.fg(LABEL_ROLE, text));
	const hint = truncateToWidth("  " + petal + (paintedLabel ? " " + paintedLabel : "") + (info.length ? " · " + info.join(" · ") : ""), width, "");
	return hint + " ".repeat(Math.max(0, width - visibleWidth(hint)));
}

// The panel editor: `─ ✿ state ──── mode ─` above the input, where the state
// scans while working and the right end carries the vim mode or esc hint.
const PANEL_PROMPT = "› ";
const PANEL_PROMPT_ROLE = "accent";
export const PANEL_BUTTON = "[ Panel ]";

function panelPromptRule(width: number, options: PromptFrameOptions, top: string | undefined, right: string | undefined): string {
	const glyph = petalGlyph(options.state, options.tick);
	const petal = options.fg(petalTone(options.state, options.tick), options.bold ? options.bold(glyph) : glyph);
	const label = top ?? stateLabel(options) ?? "waiting for input";
	if (options.panelButton && width >= visibleWidth(PANEL_BUTTON)) {
		const button = paintHoverable({ fg: options.fg }, PANEL_BUTTON, options.panelHovered ?? false, "accent");
		if (width < visibleWidth(PANEL_BUTTON) + 3) return button + options.borderColor(rule(width - visibleWidth(PANEL_BUTTON)));
		const hintWidth = Math.max(0, width - visibleWidth(PANEL_BUTTON) - 4);
		const hint = right && hintWidth > 0 ? truncateToWidth(right, hintWidth, "…") : "";
		const end = ` ${button}${hint ? ` ${options.fg(LABEL_ROLE, hint)}` : ""} ${options.borderColor("─")}`;
		const available = width - visibleWidth(end);
		if (available < 4) return options.borderColor(rule(available)) + end;
		const clipped = truncateToWidth(label, Math.max(0, available - 5), "…");
		const painted = options.state === PROMPT_STATE.WORKING && !top ? scanWorkingText(clipped, options.tick, options.fg) : options.fg(LABEL_ROLE, clipped);
		const fill = available - 4 - visibleWidth(clipped);
		return `${options.borderColor("─ ")}${petal} ${painted}${options.borderColor(rule(fill))}${end}`;
	}
	const painted = options.state === PROMPT_STATE.WORKING && !top ? scanWorkingText(label, options.tick, options.fg) : options.fg(LABEL_ROLE, label);
	const end = right ? ` ${options.fg(LABEL_ROLE, right)} ` : "";
	const titleWidth = 2 + visibleWidth(glyph) + 1 + visibleWidth(label) + 1;
	const endWidth = right ? visibleWidth(right) + 2 : 0;
	const fill = width - titleWidth - endWidth - 1;
	if (fill < 1) return options.borderColor(rule(width));
	return `${options.borderColor("─ ")}${petal} ${painted} ${options.borderColor(rule(fill))}${end}${options.borderColor("─")}`;
}

/** One input row behind the `›` prompt (or its indent), clipped and padded to the layout width. */
export function panelPromptRow(line: string, layout: PromptLayout, prefix: string): string {
	const clipped = truncateToWidth(line, layout.nativeWidth, "");
	return prefix + clipped + " ".repeat(Math.max(0, layout.nativeWidth - visibleWidth(clipped)));
}

export function framePromptLines(lines: string[], width: number, options: PromptFrameOptions, layout = resolvePromptLayout(width, options.style, options.bg)): string[] {
	width = Math.max(0, Math.floor(width));
	if (layout.panel && lines.length >= 2) {
		return [
			panelPromptRule(width, options, scrollIndicator(lines[0]), options.escHint ?? scrollIndicator(lines[lines.length - 1])),
			...lines.slice(1, -1).map((line, index) => panelPromptRow(line, layout, index === 0 ? options.fg(PANEL_PROMPT_ROLE, options.bold ? options.bold(PANEL_PROMPT.trim()) : PANEL_PROMPT.trim()) + " " : " ".repeat(PANEL_PROMPT.length))),
			" ".repeat(width),
		];
	}
	if (layout.background && lines.length >= 2) {
		return [
			floatPromptRow(floatPromptHint(lines[0], lines[lines.length - 1], options, layout.nativeWidth).slice(2), layout, options.borderColor),
			...lines.slice(1, -1).map((line) => floatPromptRow(line, layout, options.borderColor)),
			floatPromptRow("", layout, options.borderColor),
		];
	}
	if (lines.length < 2) return lines.map((line) => truncateToWidth(line, width, ""));
	if (width < 2) return lines.map((_line, index) => width === 0 ? "" : options.borderColor(index === 0 ? "╭" : index === lines.length - 1 ? "╰" : "│"));
	const innerWidth = width - 2;
	const top = lines[0];
	const bottom = lines[lines.length - 1];
	const content = lines.slice(1, -1).map((line) => sideRules(line, innerWidth, options));
	return [topRule(width, options, scrollIndicator(top)), ...content, bottomRule(width, options, options.escHint ?? scrollIndicator(bottom))];
}

export function withPromptHint(line: string, hint: string, fg: PromptFrameOptions["fg"]): string {
	const cursor = EMPTY_FAKE_CURSORS.find((marker) => line.includes(marker));
	if (!cursor) return line;
	const afterCursor = line.indexOf(cursor) + cursor.length;
	const trailing = line.slice(afterCursor);
	if (trailing.trim() !== "" || trailing.length < hint.length + 1) return line;
	return `${line.slice(0, afterCursor)} ${fg(HINT_ROLE, hint)}${" ".repeat(trailing.length - hint.length - 1)}`;
}
