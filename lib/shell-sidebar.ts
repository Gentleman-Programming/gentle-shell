import type { Component, TUI } from "@earendil-works/pi-tui";
import type { PanelSummary } from "./shell-panel.ts";
import { guard, readContributions } from "./plugin-contract.ts";
import type { Contribution, ContributionIssue, ContributionReport } from "./plugin-contract.ts";

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
	/** Namespaced keys this terminal installed from plugin contributions, so a later read can retire one. */
	contributed?: Set<string>;
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

/** Built-in rail sections, in paint order. */
export const SIDEBAR_SECTION_KEYS = ["todo", "jobs", "agents", "footer"] as const;
/** Shell slots a contribution may never claim: the rail sections plus the header and status bar. */
export const SIDEBAR_RESERVED_KEYS: readonly string[] = [...SIDEBAR_SECTION_KEYS, "header", "statusbar"];
/** A plugin section key is `plugin:<owner>:<name>`; the owner side is the contribution's own owner. */
const PLUGIN_SECTION_KEY = /^plugin:([^:]+):(.+)$/;
// One guarded proxy per contributed rail, so the layout memo keeps seeing a stable identity.
const GUARDED_RAILS = new WeakMap<object, SidebarRail>();
// Process-wide for the same reason the contribution box is: Pi evaluates every
// extension with `moduleCache: false`, so `/gentle:plugins` can hold a second
// instance of this module. A module-local report would be empty there while the
// sidebar instance holds refusals — a silent blind spot in the audit.
const CONTRIBUTION_REPORT = Symbol.for("gentle-pi.sidebar-contribution-report/v1");

interface SidebarReportState {
	skipped: ContributionIssue[];
	replaced: string[];
}

function isSidebarReport(value: unknown): value is SidebarReportState {
	if (typeof value !== "object" || value === null) return false;
	// SAFETY: only the two array fields the report is built from are read here.
	const candidate = value as { skipped?: unknown; replaced?: unknown };
	return Array.isArray(candidate.skipped) && Array.isArray(candidate.replaced);
}

/** The one report every evaluation of this module shares through its process slot. */
function sidebarReport(): SidebarReportState {
	// SAFETY: the symbol index signature is the process-wide slot every evaluation of this module agrees on.
	const holder = globalThis as unknown as { [key: symbol]: unknown };
	const current = holder[CONTRIBUTION_REPORT];
	if (isSidebarReport(current)) return current;
	const created: SidebarReportState = { skipped: [], replaced: [] };
	holder[CONTRIBUTION_REPORT] = created;
	return created;
}

/** Clear the report in place, so a previous evaluation's reference stays live. */
function resetSidebarReport(): SidebarReportState {
	const report = sidebarReport();
	report.skipped.length = 0;
	report.replaced.length = 0;
	return report;
}

/** What the last contribution install refused, in the contract's own report shape. */
export function readSidebarContributionReport(): ContributionReport {
	const report = sidebarReport();
	return { skipped: report.skipped.map((issue) => ({ ...issue })), replaced: [...report.replaced] };
}

/**
 * The rail's section keys: the built-in four first, then contributed keys in
 * registration order. Contributed keys never displace or reorder a core one.
 */
export function sidebarSectionOrder(contributed: readonly string[] = [], todoVisible = true): string[] {
	const order: string[] = [];
	for (const key of [...SIDEBAR_SECTION_KEYS, ...contributed]) {
		if (order.includes(key)) continue;
		if (key === "todo" && !todoVisible) continue;
		order.push(key);
	}
	return order;
}

export interface ContributedSidebar {
	/** Namespaced section keys installed this read, in contribution registration order. */
	keys: string[];
	/** Contributions refused for their sidebar key (core collision, missing namespace or no rail). */
	rejected: ContributionIssue[];
}

function isSidebarRail(value: unknown): value is SidebarRail {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
	try {
		return typeof (value as { render?: unknown }).render === "function";
	} catch {
		return false;
	}
}

/** Resolve a contribution's sidebar claim, or the issue that refuses it. */
function contributionSection(contribution: Contribution): { key: string } | { issue: ContributionIssue } | undefined {
	const section = contribution.sidebar;
	if (!section) return undefined;
	// Core keys are read-only: a contribution never replaces or removes one.
	if (SIDEBAR_RESERVED_KEYS.includes(section.key)) {
		return { issue: { id: contribution.id, code: "malformed-sidebar", detail: `sidebar key "${section.key}" is read-only for plugins` } };
	}
	const match = PLUGIN_SECTION_KEY.exec(section.key);
	if (!match || match[1] !== contribution.owner) {
		return { issue: { id: contribution.id, code: "malformed-sidebar", detail: `sidebar key "${section.key}" must be "plugin:${contribution.owner}:<name>"` } };
	}
	if (!isSidebarRail(section.rail)) {
		return { issue: { id: contribution.id, code: "malformed-sidebar", detail: "sidebar rail must render a component" } };
	}
	return { key: section.key };
}

function recordRailFailure(id: string, error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error);
	const skipped = sidebarReport().skipped;
	if (skipped.some((issue) => issue.id === id && issue.detail === detail)) return;
	skipped.push({ id, code: "invalid-contribution", detail });
}

// A plugin rail is foreign code: a throwing render, digest or invalidation must
// degrade to an empty section and be reported, never take the whole rail down.
function guardedContributionRail(rail: SidebarRail, id: string): SidebarRail {
	const cached = GUARDED_RAILS.get(rail as object);
	if (cached) return cached;
	const onError = (error: unknown) => recordRailFailure(id, error);
	const wrapped = new Proxy(rail, {
		get(target, property, receiver) {
			if (property === "render") {
				return (width: number) => guard(() => target.render(width) ?? [], [] as string[], onError) as string[];
			}
			if (property === "invalidate") {
				return () => {
					try {
						target.invalidate?.();
					} catch (error) {
						onError(error);
					}
				};
			}
			// The layout already survives a throwing digest by treating it as
			// undefined; record it too, so the audit can say the rail misbehaved.
			if (property === "digest") {
				return () => {
					try {
						return target.digest?.();
					} catch (error) {
						onError(error);
						return undefined;
					}
				};
			}
			return Reflect.get(target, property, receiver);
		},
	}) as SidebarRail;
	GUARDED_RAILS.set(rail as object, wrapped);
	return wrapped;
}

/**
 * Apply every valid contributed rail to the shared `SidebarState.parts` map
 * before the layout iterates, and return the section keys in registration
 * order. The map is shared state, so a rail removed from the slot is retired
 * on the next read; a core key is never installed, replaced or removed here.
 */
export function installContributedSidebar(tui: TUI): ContributedSidebar {
	const report = resetSidebarReport();
	const result: ContributedSidebar = { keys: [], rejected: report.skipped };
	if (!tui.terminal) return result;
	const state = sidebarState(tui);
	const contributed = state.contributed ??= new Set<string>();
	const installed = new Set<string>();
	const contributions = guard(() => readContributions(), [] as Contribution[], (error) => recordRailFailure("contributions", error)) as Contribution[];
	for (const contribution of contributions) {
		const section = contributionSection(contribution);
		if (!section) continue;
		if ("issue" in section) {
			report.skipped.push(section.issue);
			continue;
		}
		state.parts.set(section.key, guardedContributionRail(contribution.sidebar!.rail as SidebarRail, contribution.id));
		contributed.add(section.key);
		installed.add(section.key);
		if (!result.keys.includes(section.key)) result.keys.push(section.key);
	}
	// Retire only keys this seam installed; a core part is never in this set.
	for (const key of [...contributed]) {
		if (installed.has(key)) continue;
		state.parts.delete(key);
		contributed.delete(key);
	}
	return result;
}
