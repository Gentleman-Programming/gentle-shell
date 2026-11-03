import { visibleWidth } from "@earendil-works/pi-tui";
import { paintSurfaceRow, surfaceOpener, type CardTheme } from "./shell-card.ts";
import { paintHoverable } from "./shell-hover.ts";

// Fullscreen rail sections drawn as one IDE-like panel (design/shell-rework/02-proposal.html):
// a one-row header `▾ NAME … count`, dense rows indented under it, and one
// tinted surface behind the whole rail instead of a card per section.

/** The theme background the rail panel paints behind its sections. */
export const PANEL_SURFACE_ROLE = "customMessageBg";
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
	const title = theme.fg("text", theme.bold ? theme.bold(name) : name);
	const count = header.count ? theme.fg(header.countRole ?? "muted", header.count) : "";
	return fitPanelLine(`${glyph} ${title}`, count, width);
}

/** One section row, indented under the header, with an optional right column. */
export function renderPanelRow(width: number, left: string, right = "", indent = PANEL_ROW_INDENT): string {
	return fitPanelLine(`${" ".repeat(indent)}${left}`, right, width);
}

/** Paints every row behind the rail surface; a theme that cannot paint it leaves rows as they are. */
export function paintPanelSurface(theme: CardTheme, rows: readonly string[]): string[] {
	const open = surfaceOpener(theme, PANEL_SURFACE_ROLE);
	return rows.map((row) => paintSurfaceRow(row, open));
}
