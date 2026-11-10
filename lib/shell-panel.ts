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
	const glyph = paintHoverable(theme, header.open ? "▾" : "▸", header.hovered ?? false, "muted");
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

const SHEET_ORDER = ["todo", "github", "jobs", "agents", "footer"] as const;

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
