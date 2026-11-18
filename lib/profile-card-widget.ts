import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentProfilesFile } from "./agent-profiles.ts";
import { clipPanelText, PANEL_ROW_INDENT, renderPanelHeader, renderPanelRow, type PanelTheme } from "./shell-panel.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

// Profile card: the pure part of the sidebar card that shows ONE saved agent
// profile, navigates between profiles with ◀/▶ (wrapping) and offers a "use"
// action. No pi/ctx access and no I/O: the sidebar registers the section,
// owns the selected index, and routes clicks through `profileCardActionAt`.

export type ProfileCardAction = "previous" | "next" | "use";

/**
 * A clickable span in the section's own frame: `y` is the row (0 = header),
 * `x0` inclusive and `x1` exclusive are columns from the section's left edge.
 */
export interface ProfileCardHit {
	y: number;
	x0: number;
	x1: number;
	action: ProfileCardAction;
}

export interface ProfileCardItem {
	name: string;
	active: boolean;
	pinned: boolean;
	session: boolean;
}

export interface ProfileCardRender {
	lines: string[];
	hits: ProfileCardHit[];
}

export const PROFILE_CARD_PREVIOUS_GLYPH = "◀";
export const PROFILE_CARD_NEXT_GLYPH = "▶";
export const PROFILE_CARD_USE_GLYPH = "✓";
export const PROFILE_CARD_USE_LABEL = "Use in session";
export const PROFILE_CARD_EMPTY_HINT = "No profiles yet. Create one in /gentle:profiles";

// ---- Navigation state ----

/**
 * One item per saved profile, with the same markers `buildProfileListItems`
 * names: `active` is the global claim; a session binding outranks the pin, so
 * `session` and `pinned` never both apply to one profile.
 */
export function buildProfileCardItems(file: Pick<AgentProfilesFile, "profiles" | "active">, pinned?: string, sessionBound?: string): ProfileCardItem[] {
	return Object.keys(file.profiles).map((name) => ({
		name,
		active: name === file.active,
		pinned: name !== sessionBound && name === pinned,
		session: name === sessionBound,
	}));
}

/** The profile in effect for the session: session marker first, then active, else the first. */
export function initialProfileIndex(items: readonly ProfileCardItem[]): number {
	const session = items.findIndex((entry) => entry.session);
	if (session >= 0) return session;
	const active = items.findIndex((entry) => entry.active);
	return active >= 0 ? active : 0;
}

export function nextProfileIndex(index: number, count: number): number {
	return count <= 0 ? 0 : (clampIndex(index, count) + 1) % count;
}

export function previousProfileIndex(index: number, count: number): number {
	return count <= 0 ? 0 : (clampIndex(index, count) - 1 + count) % count;
}

/** The index to show after the list changed: the same profile name if it still exists, else the old index clamped. */
export function reconcileProfileIndex(selectedName: string | undefined, index: number, items: readonly ProfileCardItem[]): number {
	if (selectedName !== undefined) {
		const found = items.findIndex((entry) => entry.name === selectedName);
		if (found >= 0) return found;
	}
	return clampIndex(index, items.length);
}

function clampIndex(index: number, count: number): number {
	if (count <= 0 || !Number.isFinite(index)) return 0;
	return Math.max(0, Math.min(count - 1, Math.trunc(index)));
}

// ---- Rendering ----

const ARROW_ROLE = "accent";
const NAME_ROLE = "text";
const META_ROLE = "dim";
// Below this width the row drops its indent so the arrows still fit.
const MIN_INDENTED_WIDTH = 7;

function clean(text: string): string {
	return sanitizeTerminalText(text).replace(/\s+/g, " ");
}

function markersText(entry: ProfileCardItem): string {
	const marks = [entry.active ? "active" : "", entry.pinned ? "pinned" : "", entry.session ? "session" : ""].filter(Boolean);
	return marks.length ? `(${marks.join(", ")})` : "";
}

/** The profile card section: header, one navigation row and the use row; or the empty-state hint. */
export function renderProfileCardSection(items: readonly ProfileCardItem[], index: number, theme: PanelTheme, width: number): ProfileCardRender {
	const w = Math.max(0, Math.floor(width));
	const header = renderPanelHeader(theme, w, { title: "Profile", open: true });
	if (items.length === 0) {
		return { lines: [header, renderPanelRow(w, theme.fg(META_ROLE, clipPanelText(PROFILE_CARD_EMPTY_HINT, Math.max(0, w - PANEL_ROW_INDENT))))], hits: [] };
	}
	const current = clampIndex(index, items.length);
	const entry = items[current]!;
	const indent = w >= MIN_INDENTED_WIDTH ? PANEL_ROW_INDENT : 0;
	const prev = PROFILE_CARD_PREVIOUS_GLYPH;
	const next = PROFILE_CARD_NEXT_GLYPH;
	const hits: ProfileCardHit[] = [];

	// Navigation row: `◀ name (markers)  n/total ▶`, ▶ pinned to the last column.
	let nav: string;
	if (w < 2) {
		nav = w === 1 ? theme.fg(ARROW_ROLE, prev) : "";
		if (w === 1) hits.push({ y: 1, x0: 0, x1: 1, action: "previous" });
	} else {
		const counter = `${current + 1}/${items.length}`;
		let right = `${counter} ${next}`;
		let room = w - indent - 2 - visibleWidth(right) - 1;
		if (room < 1) { right = next; room = w - indent - 2 - 1 - 1; }
		const name = clean(entry.name);
		const markers = markersText(entry);
		let left = "";
		if (room >= 1) {
			const markersWidth = markers ? visibleWidth(markers) + 1 : 0;
			if (visibleWidth(name) + markersWidth <= room) {
				left = theme.fg(NAME_ROLE, name) + (markers ? ` ${theme.fg(META_ROLE, markers)}` : "");
			} else if (markers && room - markersWidth >= 4) {
				left = `${theme.fg(NAME_ROLE, clipPanelText(name, room - markersWidth))} ${theme.fg(META_ROLE, markers)}`;
			} else {
				left = theme.fg(NAME_ROLE, clipPanelText(name, room));
			}
		}
		const head = `${" ".repeat(indent)}${theme.fg(ARROW_ROLE, prev)}${left ? ` ${left}` : ""}`;
		const rightPainted = right === next ? theme.fg(ARROW_ROLE, next) : `${theme.fg(META_ROLE, counter)} ${theme.fg(ARROW_ROLE, next)}`;
		nav = `${head}${" ".repeat(Math.max(0, w - visibleWidth(head) - visibleWidth(right)))}${rightPainted}`;
		hits.push({ y: 1, x0: indent, x1: indent + 1, action: "previous" }, { y: 1, x0: w - 1, x1: w, action: "next" });
	}

	// Use row: glyph and label are one clickable span.
	const useText = clipPanelText(`${PROFILE_CARD_USE_GLYPH} ${PROFILE_CARD_USE_LABEL}`, Math.max(0, w - indent));
	const useRow = `${" ".repeat(indent)}${theme.fg(ARROW_ROLE, useText)}`;
	const usePadded = `${useRow}${" ".repeat(Math.max(0, w - visibleWidth(useRow)))}`;
	if (visibleWidth(useText) > 0) hits.push({ y: 2, x0: indent, x1: indent + visibleWidth(useText), action: "use" });
	return { lines: [header, nav, usePadded], hits };
}

/** The action whose span covers the frame coordinate (`x` from the left edge, `y` from the first row), if any. */
export function profileCardActionAt(hits: readonly ProfileCardHit[], x: number, y: number): ProfileCardAction | undefined {
	return hits.find((hit) => hit.y === y && x >= hit.x0 && x < hit.x1)?.action;
}
