import type { Component, TUI } from "@earendil-works/pi-tui";
import type { PanelSummary } from "./shell-panel.ts";

// Store on the terminal, not a module singleton: extension loaders may isolate
// modules, while Pi keeps this terminal across regular/fullscreen transitions.
const STATE = Symbol.for("gentle-pi.experimental-sidebar.state");
/** In-process notification after a visual preference is persisted. */
export const VISUAL_SETTINGS_CHANGED = "gentle-pi.visual-settings-changed";
export interface SidebarState {
	active: boolean;
	visibility?: { todo?: boolean };
	ownsHost?: () => boolean;
	/**
	 * Columns the fullscreen rail reserves at the right edge (rail plus gap)
	 * while `active && ownsHost()`. Overlays read it to stay inside the editor
	 * column (the prompt-history picker's right margin) without importing
	 * gentle-shell.
	 */
	railColumns?: number;
	/** True while Status placement is "hidden": the bottom Status bar paints nothing at any width or mode. */
	statusHidden?: () => boolean;
	/** True while a painting top header is the only status row of a narrow fullscreen terminal: the bottom Status bar steps aside. */
	headerOwnsStatus?: () => boolean;
	/** True while a narrow fullscreen terminal folds live work into the mobile work row: the Todos and Agents cards step aside. */
	compactWork?: () => boolean;
	/** True while the IDE chrome's status bar shows the permission mode: the above-editor YOLO banner steps aside. */
	statusBarShowsMode?: () => boolean;
	/** True while the fullscreen layout is installed on the host's root, so its title row and status bar can actually draw. */
	layoutAttached?: () => boolean;
	/** Current shell-owned pointer hover; shared across separately loaded extensions. */
	hover?: { owner: object; clear: () => void };
	parts: Map<string, SidebarRail>;
}

/** A rail slot in the fullscreen sidebar. */
export interface SidebarRail extends Component {
	/**
	 * Row ranges of the sections this part renders, for a transparent rail that
	 * draws every section as its own card: each group starts at its header row
	 * and ends before `end`; `loose` rows (key hints) sit outside the cards.
	 * Without it the whole part is one section headed by its first row.
	 */
	cardGroups?(width: number): { groups: Array<{ start: number; end: number }>; loose?: number[] } | undefined;
	/**
	 * Cheap digest of the live state this rail paints. The fullscreen layout memo
	 * re-renders a part only when its digest changes, so a rail that reads session
	 * data (model, thinking level, context, cost, extension statuses) must declare
	 * one; explicit invalidateSidebar() stays for discrete state changes.
	 */
	digest?(): string;
	/**
	 * "panel" sections render IDE-like panel rows (lib/shell-panel.ts) and the
	 * rail paints them, padding included, on one shared surface; others are
	 * cards that carry their own chrome.
	 */
	surface?: "panel";
	/** Destination already renders its own card frame. */
	framed?: boolean;
	/** A one-row digest for the mobile work row; undefined when the section has nothing live. */
	summary?(): PanelSummary | undefined;
	/** Opens the section's own view (Agents: /gentle:agents); a tap on the mobile work row runs it when this section leads the row. */
	open?(): void;
	/** "Needs you" rows the panel editor draws right above its rule (an agent asking the user); [] when none. */
	alert?(width: number): string[];
	/** What this section's work spent (the Agents section: started subagents), for the Stats section. */
	spend?(): { runs: number; tokens: number; cost: number } | undefined;
}
export function sidebarState(tui: TUI): SidebarState {
	const terminal = tui.terminal as unknown as Record<symbol, SidebarState>;
	return terminal[STATE] ??= { active: false, parts: new Map() };
}

/** Transfer shell hover ownership without clearing an unchanged owner. */
export function setSidebarHover(tui: TUI, owner?: object, clear?: () => void): void {
	if (!tui.terminal) return;
	const state = sidebarState(tui);
	if (state.hover?.owner === owner) return;
	const previous = state.hover;
	state.hover = owner && clear ? { owner, clear } : undefined;
	previous?.clear();
}

/** Forget a disposed or invalidated owner without disturbing another surface. */
export function releaseSidebarHover(tui: TUI, owner: object): void {
	if (tui.terminal && sidebarState(tui).hover?.owner === owner) sidebarState(tui).hover = undefined;
}

/** Keep the original bottom component mounted, suppressing only its paint. */
export function sidebarPart<T extends Component & { dispose?(): void }>(tui: TUI, key: string, bottom: T, rail: SidebarRail = bottom): T {
	// Minimal extension hosts cannot share terminal-owned layout state.
	if (!tui.terminal) return bottom;
	const state = sidebarState(tui);
	state.parts.set(key, rail);
	return {
		...bottom,
		render: (width: number) => (key === "todo" && state.visibility?.todo === false) || (key === "footer" && (state.statusHidden?.() || state.headerOwnsStatus?.() || state.compactWork?.())) || ((key === "todo" || key === "agents") && state.compactWork?.()) || (state.active && state.ownsHost?.()) ? [] : bottom.render(width),
		dispose() {
			if (state.parts.get(key) === rail) state.parts.delete(key);
			bottom.dispose?.();
		},
	};
}

/**
 * Register the fullscreen header rail: the one row above the hstack that
 * carries the brand, session identity, and the per-frame counters. There is
 * no narrow-mode bottom counterpart — the compact bar already carries this
 * data when the sidebar is inactive — so this only ever writes the "header"
 * slot in sidebarState(tui).parts, and returns its own disposer.
 */
export function sidebarHeader(tui: TUI, rail: SidebarRail): () => void {
	if (!tui.terminal) return () => {};
	const state = sidebarState(tui);
	state.parts.set("header", rail);
	return () => {
		if (state.parts.get("header") === rail) state.parts.delete("header");
	};
}

/**
 * Register the fullscreen status bar: one full-width row below the transcript
 * and the rail while the rail is shown. Below the breakpoint it paints nothing;
 * the compact bar carries the same data there. Writes the "statusbar" slot and
 * returns its own disposer.
 */
export function sidebarStatusBar(tui: TUI, rail: SidebarRail): () => void {
	if (!tui.terminal) return () => {};
	const state = sidebarState(tui);
	state.parts.set("statusbar", rail);
	return () => {
		if (state.parts.get("statusbar") === rail) state.parts.delete("statusbar");
	};
}
