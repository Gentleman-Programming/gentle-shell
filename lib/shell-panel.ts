import { visibleWidth } from "@earendil-works/pi-tui";
import { paintSurfaceRow, surfaceOpener, type CardTheme } from "./shell-card.ts";
import { HOVER_ROLE, paintHoverable } from "./shell-hover.ts";
import type { ChromeSurface } from "./visual-customization-policy.ts";

// Fullscreen rail sections drawn as one IDE-like panel (design/shell-rework/02-proposal.html):
// a one-row header `▾ NAME … count`, dense rows indented under it, and one
// tinted surface behind the whole rail instead of a card per section.

/** The theme background the rail panel paints behind its sections. */
export const PANEL_SURFACE_ROLE = "customMessageBg";
let surface: ChromeSurface = "tinted";
/** The live chrome surface (Layout → Surface); `transparent` leaves the panel rows unpainted. */
export function chromeSurface(): ChromeSurface { return surface; }
export function setChromeSurface(value: ChromeSurface): void { surface = value; }
/** The SGR that opens the panel surface, or "" when the chrome is transparent or the theme cannot paint it. */
export function panelSurfaceOpener(theme: CardTheme): string {
	return surface === "transparent" ? "" : surfaceOpener(theme, PANEL_SURFACE_ROLE);
}
/** Rail sections keep a blank row between them in comfortable density, whatever the surface. */
export function sectionGap(density: string | undefined): boolean {
	return density === undefined || density === "comfortable";
}
/** Columns a panel row is indented under its header. */
export const PANEL_ROW_INDENT = 2;

export interface PanelTheme extends CardTheme {
	bold?(text: string): string;
}

// Console panels (DESIGN.md §C2, design/gentle-tui-cinlo/01-cinlo-console.html):
// a box whose title is bitten into the top rule (`┌─ ◆ Sesión ── [ 4/6 ] ┐`),
// the content below and, when the panel has rows, the scroll bar bitten into
// the bottom rule (`└── [ 1..7/7 ▼ ] ──┘`). One column of border on each side.

/** Literal the console uses for every panel frame. */
export const CONSOLE_GLYPH = "◆";

/** Frame role for a console panel: the box is structure, never emphasis. */
export const CONSOLE_FRAME_ROLE = "border";
/** Role of the bitten title (glyph and name) and of the top-rule count. */
export const CONSOLE_TITLE_ROLE = "accent";

/** `[ 1..7/7 ▼ ]`: the rows a console panel shows against its total. */
export function consoleScrollBar(first: number, last: number, total: number): string {
	if (total <= 0) return "";
	const top = Math.max(1, Math.min(first, total));
	const bottom = Math.max(top, Math.min(last, total));
	return `[ ${top}..${bottom}/${total} ▼ ]`;
}

export interface ConsolePanel {
	/** Panel name as it is bitten into the top rule, e.g. `Sesión`. */
	title: string;
	/** Right-aligned tag on the top rule, e.g. `[ 4/6 ]` or `6%`. */
	count?: string;
	/** Body rows, already styled and rendered at `width - 2`. */
	rows: readonly string[];
}

/** Splits an interior slice into a surface-painted run, keeping SGR resets armed. */
function consoleInterior(theme: CardTheme, text: string): string {
	const open = panelSurfaceOpener(theme);
	return paintSurfaceRow(text, open);
}

/**
 * Whether the "Cine-Estelar" skin is active (`GENTLE_SHELL_SKIN=cine-estelar`, default).
 * Setting `GENTLE_SHELL_SKIN=cinlo` or `GENTLE_SHELL_SKIN=classic` switches back to square corners.
 */
export function isCineEstelarSkin(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.GENTLE_SHELL_SKIN ?? "cine-estelar").trim().toLowerCase();
	return raw !== "cinlo" && raw !== "classic" && raw !== "off" && raw !== "0";
}

/** True when running in the live Gentle Shell TUI with the Cine-Estelar skin enabled. */
export function isCineEstelarLive(env: NodeJS.ProcessEnv = process.env): boolean {
	return isCineEstelarSkin(env) && !env.NODE_TEST_CONTEXT;
}

export type RgbStop = readonly [number, number, number];

export const GLASS_SLATE_BG_STOPS: readonly RgbStop[] = [
	[36, 45, 64],
	[50, 61, 86],
	[43, 53, 75],
	[34, 42, 60],
];

export const GLASS_SLATE_BORDER_STOPS: readonly RgbStop[] = [
	[104, 120, 152],
	[134, 150, 182],
	[98, 112, 144],
];

export const GLASS_CONTEXT_BG_STOPS: readonly RgbStop[] = [
	[32, 78, 98],
	[46, 90, 112],
	[62, 66, 110],
	[72, 52, 106],
];

export const GLASS_CONTEXT_BORDER_STOPS: readonly RgbStop[] = [
	[102, 234, 248],
	[148, 202, 255],
	[192, 150, 255],
];

export function interpolateRgb(stops: readonly RgbStop[], t: number): RgbStop {
	if (stops.length === 0) return [30, 34, 50];
	if (stops.length === 1 || t <= 0) return stops[0]!;
	if (t >= 1) return stops[stops.length - 1]!;
	const scaled = t * (stops.length - 1);
	const idx = Math.min(stops.length - 2, Math.floor(scaled));
	const frac = scaled - idx;
	const a = stops[idx]!;
	const b = stops[idx + 1]!;
	return [
		Math.round(a[0] + (b[0] - a[0]) * frac),
		Math.round(a[1] + (b[1] - a[1]) * frac),
		Math.round(a[2] + (b[2] - a[2]) * frac),
	];
}

/**
 * Paints a horizontal 24-bit RGB background gradient across `text`, preserving
 * foreground SGR sequences and visible width.
 */
export function paintHorizontalGradientRow(
	text: string,
	width: number,
	bgStops: readonly RgbStop[],
	defaultFg?: RgbStop,
): string {
	const total = Math.max(1, width);
	let col = 0;
	let out = "";
	let lastBg = "";
	const defaultFgSgr = defaultFg ? `\x1b[38;2;${defaultFg[0]};${defaultFg[1]};${defaultFg[2]}m` : "";
	if (defaultFgSgr) out += defaultFgSgr;
	for (const unit of text.match(/\x1b\[[0-9;]*m|[\s\S]/gu) ?? []) {
		if (unit.startsWith("\x1b[")) {
			if (unit === "\x1b[0m" || unit === "\x1b[m") {
				out += `\x1b[22;23;24;25;27;28;29;39m${defaultFgSgr}`;
				lastBg = "";
			} else if (unit === "\x1b[49m") {
				lastBg = "";
			} else if (unit === "\x1b[39m" && defaultFgSgr) {
				out += defaultFgSgr;
			} else {
				out += unit;
			}
			continue;
		}
		const bucket = Math.floor(col / 2) * 2;
		const [r, g, b] = interpolateRgb(bgStops, bucket / Math.max(1, total - 1));
		const bg = `\x1b[48;2;${r};${g};${b}m`;
		if (bg !== lastBg) {
			out += bg;
			lastBg = bg;
		}
		out += unit;
		col += Math.max(1, visibleWidth(unit));
	}
	return `${out}\x1b[49m${defaultFgSgr ? "\x1b[39m" : ""}`;
}

function paintBorderChar(ch: string, col: number, total: number, borderStops: readonly RgbStop[]): string {
	const t = total <= 1 ? 0 : col / (total - 1);
	const [fr, fg, fb] = interpolateRgb(borderStops, t);
	return `\x1b[49m\x1b[38;2;${fr};${fg};${fb}m${ch}\x1b[39m`;
}

/** `╭─ ◆ Sesión ───────── [ 4/6 ] ─╮`, exactly `width` columns. */
export function renderConsoleTop(
	theme: PanelTheme,
	width: number,
	panel: { title: string; count?: string },
	variant: "slate" | "context" = "slate",
): string {
	const target = Math.max(0, Math.floor(width));
	const [tl, tr] = isCineEstelarSkin() ? ["╭", "╮"] : ["┌", "┐"];
	if (isCineEstelarLive()) {
		const bgStops = variant === "context" ? GLASS_CONTEXT_BG_STOPS : GLASS_SLATE_BG_STOPS;
		const borderStops = variant === "context" ? GLASS_CONTEXT_BORDER_STOPS : GLASS_SLATE_BORDER_STOPS;
		const glyphColor = variant === "context" ? "\x1b[38;2;120;240;255m" : "\x1b[38;2;199;155;255m";
		const titleColor = "\x1b[1m\x1b[38;2;242;246;255m";
		const countColor = variant === "context" ? "\x1b[38;2;232;244;255m" : "\x1b[38;2;210;220;242m";
		const title = `${glyphColor}${CONSOLE_GLYPH}\x1b[39m ${titleColor}${panel.title}\x1b[22m\x1b[39m`;
		const count = panel.count ? `${countColor}${panel.count}\x1b[39m` : "";
		const leftPart = ` ${title}`;
		const rightPart = count ? `${count} ` : "";
		const inner = Math.max(0, target - 2);
		const gap = Math.max(1, inner - visibleWidth(leftPart) - visibleWidth(rightPart));
		const interior = clipPanelText(`${leftPart}${" ".repeat(gap)}${rightPart}`, inner);
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(interior)));
		return (
			paintBorderChar("╭", 0, target, borderStops) +
			paintHorizontalGradientRow(interior + pad, inner, bgStops) +
			paintBorderChar("╮", target - 1, target, borderStops)
		);
	}
	const frame = (text: string) => theme.fg(CONSOLE_FRAME_ROLE, text);
	const bold = theme.bold ? theme.bold(panel.title) : panel.title;
	const title = theme.fg(CONSOLE_TITLE_ROLE, `${CONSOLE_GLYPH} ${bold}`);
	const count = panel.count ? theme.fg(CONSOLE_TITLE_ROLE, panel.count) : "";
	// ╭ ─ space TITLE space RULE [space COUNT space] ─ ╮
	const fixed = 2 + 1 + visibleWidth(title) + 1 + (count ? 1 + visibleWidth(count) + 1 : 0) + 1 + 1;
	const room = target - fixed;
	if (room < 0) return frame(tl) + consoleInterior(theme, clipPanelText(` ${title} `, Math.max(0, target - 2))) + frame(tr);
	const middle = `${theme.fg(CONSOLE_FRAME_ROLE, "─".repeat(room))}${count ? ` ${count} ` : ""}`;
	return `${frame(tl)}${consoleInterior(theme, `─ ${title} ${middle}`)}${frame("─")}${frame(tr)}`;
}

/** `╰──────── [ 1..7/7 ▼ ] ─╯`, exactly `width` columns; an empty bar paints a plain rule. */
export function renderConsoleBottom(
	theme: PanelTheme,
	width: number,
	bar = "",
	variant: "slate" | "context" = "slate",
): string {
	const target = Math.max(0, Math.floor(width));
	const [bl, br] = isCineEstelarSkin() ? ["╰", "╯"] : ["└", "┘"];
	if (isCineEstelarLive()) {
		const borderStops = variant === "context" ? GLASS_CONTEXT_BORDER_STOPS : GLASS_SLATE_BORDER_STOPS;
		const fixed = 2 + (bar ? 2 + visibleWidth(bar) : 0);
		const room = target - fixed;
		if (room < 0) return paintBorderChar(bl, 0, target, borderStops) + paintBorderChar(br, 1, target, borderStops);
		let rule = "\x1b[49m";
		for (let i = 0; i < room; i++) {
			const [fr, fg, fb] = interpolateRgb(borderStops, (i + 1) / Math.max(1, target - 1));
			rule += `\x1b[38;2;${fr};${fg};${fb}m─`;
		}
		rule += "\x1b[39m";
		const middle = bar ? `\x1b[49m\x1b[38;2;180;194;224m ${bar} \x1b[39m` : "";
		return (
			paintBorderChar(bl, 0, target, borderStops) +
			rule +
			middle +
			paintBorderChar(br, target - 1, target, borderStops)
		);
	}
	const frame = (text: string) => theme.fg(CONSOLE_FRAME_ROLE, text);
	const middle = bar ? theme.fg("muted", bar) : "";
	const fixed = 2 + (bar ? 2 + visibleWidth(bar) : 0);
	const room = target - fixed;
	if (room < 0) return frame(bl) + frame(br);
	const rule = theme.fg(CONSOLE_FRAME_ROLE, "─".repeat(room));
	const body = bar ? `${rule} ${middle} ` : rule;
	return `${frame(bl)}${consoleInterior(theme, body)}${frame(br)}`;
}

/** `│ body │` at `width` columns, the body clipped and padded to `width - 2`. */
export function renderConsoleRow(
	theme: PanelTheme,
	width: number,
	row: string,
	variant: "slate" | "context" = "slate",
): string {
	const target = Math.max(0, Math.floor(width));
	const inner = Math.max(0, target - 2);
	const shown = clipPanelText(row, inner);
	const padded = `${shown}${" ".repeat(Math.max(0, inner - visibleWidth(shown)))}`;
	if (isCineEstelarLive()) {
		const bgStops = variant === "context" ? GLASS_CONTEXT_BG_STOPS : GLASS_SLATE_BG_STOPS;
		const borderStops = variant === "context" ? GLASS_CONTEXT_BORDER_STOPS : GLASS_SLATE_BORDER_STOPS;
		return (
			paintBorderChar("│", 0, target, borderStops) +
			paintHorizontalGradientRow(padded, inner, bgStops) +
			paintBorderChar("│", target - 1, target, borderStops)
		);
	}
	const frame = theme.fg(CONSOLE_FRAME_ROLE, "│");
	return frame + consoleInterior(theme, padded) + frame;
}

/**
 * A whole console panel: top rule with the bitten title and count, one row per
 * body line, and the bottom rule carrying the scroll bar over the rows it shows.
 * `total` is what the panel could show (the caller owns any cap); omitting it
 * makes the bar report every row.
 */
export function renderConsolePanel(theme: PanelTheme, width: number, panel: ConsolePanel, view?: { first: number; last: number; total: number }): string[] {
	const variant: "slate" | "context" = panel.title === "Contexto" ? "context" : "slate";
	const rows = panel.rows.map((row) => renderConsoleRow(theme, width, row, variant));
	// Only a panel that shows a slice of its rows reports a range; a panel that
	// fits closes with a plain rule, like the mockup's Sesión and Engram.
	const bar = view ? consoleScrollBar(view.first, view.last, view.total) : "";
	return [renderConsoleTop(theme, width, panel, variant), ...rows, renderConsoleBottom(theme, width, bar, variant)];
}

export interface PanelHeader {
	title: string;
	/** Right-aligned summary, e.g. `2/6` or `1 running`. */
	count?: string;
	/** Role for the count; muted unless the section signals a state. */
	countRole?: string;
	open: boolean;
	/** The pointer is over the header, the section's collapse control. */
	hovered?: boolean;
}

const ELLIPSIS = "…";

/** Clips plain-or-ANSI `text` to `width` columns with an ellipsis; SGR codes are kept. */
export function clipPanelText(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	let clipped = "";
	// Walk escape sequences as zero-width units so a clip never splits one.
	for (const unit of text.match(/\x1b\[[0-9;]*m|[\s\S]/gu) ?? []) {
		if (unit.startsWith("\x1b[")) { clipped += unit; continue; }
		if (visibleWidth(clipped + unit) > width - 1) break;
		clipped += unit;
	}
	return `${clipped}${ELLIPSIS}`;
}

/** `left` and `right` on one row exactly `width` columns wide; `left` gives way first. */
export function fitPanelLine(left: string, right: string, width: number): string {
	const target = Math.max(0, Math.floor(width));
	const rightWidth = visibleWidth(right);
	const shownRight = rightWidth + 1 <= target ? right : "";
	const room = target - visibleWidth(shownRight) - (shownRight ? 1 : 0);
	const shownLeft = clipPanelText(left, room);
	return `${shownLeft}${" ".repeat(Math.max(0, target - visibleWidth(shownLeft) - visibleWidth(shownRight)))}${shownRight}`;
}

export function renderPanelHeader(theme: PanelTheme, width: number, header: PanelHeader): string {
	const glyph = paintHoverable(theme, header.open ? "▾" : "▸", header.hovered ?? false, "accent");
	const name = header.title.toUpperCase();
	// The hover paints the name too: a lone glyph is too small a signal, and other rail controls paint their text.
	const title = theme.fg(header.hovered ? HOVER_ROLE : "text", theme.bold ? theme.bold(name) : name);
	const count = header.count ? theme.fg(header.countRole ?? "muted", header.count) : "";
	return fitPanelLine(`${glyph} ${title}`, count, width);
}

/** One section row, indented under the header, with an optional right column. */
export function renderPanelRow(width: number, left: string, right = "", indent = PANEL_ROW_INDENT): string {
	return fitPanelLine(`${" ".repeat(indent)}${left}`, right, width);
}

/** Paints every row behind the rail surface; a theme that cannot paint it leaves rows as they are. */
export function paintPanelSurface(theme: CardTheme, rows: readonly string[]): string[] {
	const open = panelSurfaceOpener(theme);
	return rows.map((row) => paintSurfaceRow(row, open));
}

/** A one-row digest of a rail section for the mobile work row. */
export interface PanelSummary {
	left: string;
	/** Right-aligned count, e.g. `2/6`. */
	right?: string;
	/** Names the count when another summary leads the row, e.g. `todos`. */
	rightLabel?: string;
	/** Higher leads the row: live agents outrank the current todo. */
	priority?: number;
}

/** ` ▸ <lead> … <count>`: the section that matters most, plus the todo count; undefined without live work. */
/** The index of the summary that leads the mobile work row (highest priority, first on ties); -1 when there is none. */
export function workRowLead(summaries: readonly PanelSummary[]): number {
	let lead = -1;
	summaries.forEach((summary, index) => {
		if (lead === -1 || (summary.priority ?? 0) > (summaries[lead]!.priority ?? 0)) lead = index;
	});
	return lead;
}

export function renderWorkRow(summaries: readonly PanelSummary[], theme: PanelTheme, width: number, hovered = false): string | undefined {
	if (summaries.length === 0) return undefined;
	const lead = summaries[workRowLead(summaries)]!;
	const counted = lead.right ? lead : summaries.find((summary) => summary.right);
	const right = !counted ? "" : counted === lead ? counted.right! : `${counted.right} ${counted.rightLabel ?? ""}`.trimEnd();
	// The ▸ is the row's tap affordance; hovering paints it like every other clickable surface.
	const row = fitPanelLine(`${paintHoverable(theme, "▸", hovered, "muted")} ${lead.left}`, right ? theme.fg("muted", right) : "", Math.max(0, Math.floor(width) - 2));
	return paintPanelSurface(theme, [` ${row} `])[0];
}

export interface PanelSheet {
	lines: string[];
	/** The largest useful scrollTop for this content and height. */
	maxScroll: number;
}

const SHEET_ORDER = ["todo", "agents", "jobs", "footer"] as const;

/**
 * The rail's sections as a full-width sheet (/gentle:panel, mobile): a fixed
 * ` ✿ Panel … esc back` row, then every section the rail would show, in rail
 * order, scrolled within `rows`. Rows hidden below say how many remain.
 */
const SHEET_BACK = "esc back";

/** True when a click at (x, y) of a sheet `width` wide lands on its ` esc back ` control. */
export function panelSheetBackHit(width: number, x: number, y: number): boolean {
	const end = Math.max(0, Math.floor(width)) - 1;
	return y === 0 && x >= end - SHEET_BACK.length - 1 && x < end + 1;
}

export function renderPanelSheet(parts: ReadonlyMap<string, { render(width: number): string[] }>, theme: PanelTheme, width: number, view: { rows: number; scrollTop: number; backHovered?: boolean }): PanelSheet {
	const target = Math.max(0, Math.floor(width));
	const inner = Math.max(0, target - 2);
	const title = ` ${fitPanelLine(`${theme.fg("accent", "✿")} ${theme.fg("text", theme.bold ? theme.bold("Panel") : "Panel")}`, paintHoverable(theme, SHEET_BACK, view.backHovered ?? false, "muted"), inner)} `;
	const content: string[] = [];
	for (const key of SHEET_ORDER) {
		const lines = [...(parts.get(key)?.render(inner) ?? [])];
		while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
		if (lines.length === 0) continue;
		content.push(" ".repeat(target), ...lines.map((line) => ` ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} `));
	}
	const viewport = Math.max(1, Math.floor(view.rows) - 1);
	const maxScroll = Math.max(0, content.length - viewport);
	const top = Math.min(Math.max(0, Math.floor(view.scrollTop)), maxScroll);
	let shown: string[];
	if (content.length <= viewport || top >= maxScroll) shown = content.slice(top, top + viewport);
	else {
		shown = content.slice(top, top + viewport - 1);
		const remaining = content.length - top - shown.length;
		shown.push(` ${fitPanelLine(`${theme.fg("accent", "↓")} ${theme.fg("muted", `${remaining} more · scroll`)}`, "", inner)} `);
	}
	while (shown.length < viewport) shown.push(fitPanelLine("", "", target));
	return { lines: paintPanelSurface(theme, [title, ...shown]), maxScroll };
}
