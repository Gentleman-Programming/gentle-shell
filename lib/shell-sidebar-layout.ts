import { Container, ScrollView, VStack, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { setSidebarHover, sidebarState, type SidebarRail } from "./shell-sidebar.ts";
import type { ShellBarTheme } from "./shell-bar.ts";
import { CARD_STYLE, CARD_TONE, cardBottom, cardLine, cardStyle, cardTop, floatRows, paintSurfaceRow, panelInnerWidth, type CardStyle, type CardTheme } from "./shell-card.ts";
import { chromeSurface, PANEL_ROW_INDENT, panelSurfaceOpener, sectionGap } from "./shell-panel.ts";
import { renderSidebarBanner } from "./shell-sidebar-banner.ts";
import type { Density, HeaderPlacement, StatusPlacement } from "./visual-customization-policy.ts";

export const SIDEBAR_BREAKPOINT = 140;
const RAIL_WIDTH = 50;
const RAIL_PADDING = 1;
// The conversation and rail keep a gap below the full-width header.
const GAP = 3;
/** Right-edge columns the painting rail takes from the editor column; published as `railColumns`. */
export const SIDEBAR_RAIL_COLUMNS = RAIL_WIDTH + GAP;
// Experimental Pi 0.85.1 internals. Only the fullscreen layout tree is adapted;
// regular mode keeps native scrollback and the original bottom components.
const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
type LayoutNode = { type: string; entries?: unknown[]; gap?: number; align?: "stretch" | "start" | "center" | "end" };
type StackLayoutEntry = ConstructorParameters<typeof VStack>[0] extends Array<infer T> | undefined ? Exclude<T, Component> : never;
type LayoutRoot = Component & { [NODE]?: () => LayoutNode };
type Host = TUI & { mode?: string; layoutRoot?: LayoutRoot };
type SidebarCache = { revision: number };
// `x`/`row` map a rail cell to the part's own cells; `frameWidth`/`frameHeight` are
// the frame the part rendered, which its mouse handler checks events against.
// A card title row (`wholeRow`) answers across the whole rail row, its x clamped into the frame.
type RailHit = { key: string; component: Component; startY: number; height: number; width: number; x: number; row: number; frameWidth: number; frameHeight: number; wholeRow?: boolean };
type SectionCacheEntry = { component: Component; digest: string | undefined; revision: number; contentWidth: number; renderWidth: number; cardStyle: CardStyle; theme: ShellBarTheme; themeSignature: string; lines: string[] };
// A transparent rail draws every section as its own card in the transcript's
// card style (neon outline with the title in the top rule, float tint with its
// accent bar), through the same renderCard the conversation cards use.
type CardGeometry = { headerRow: number; headerX: number; bodyRow: number; bodyX: number };
// One section card: the title (with its count as the top rule's hint) and the
// body rows together, so a float card spends no separator row between them.
function sectionCardRows(header: { glyph?: string; title: string; count?: string }, body: readonly string[], theme: ShellBarTheme, width: number): string[] {
	const tone = CARD_TONE.INFO;
	return floatRows(tone, theme, width, (inner) => ({
		head: [cardTop({ title: header.title, ...(header.glyph ? { glyph: header.glyph } : {}), body: [], tone }, theme, inner, header.count), ...body.map((row) => cardLine(row, tone, theme, inner))],
		bottom: cardBottom(tone, theme, inner),
	}));
}
const CARD_PROBE = "\u2063probe";
const geometryCache = new Map<string, CardGeometry>();
function cardGeometry(theme: ShellBarTheme, width: number, style: CardStyle): CardGeometry {
	// Float geometry depends on whether this theme can paint its background,
	// not just on the foreground roles used by the rail's frame cache.
	let background = "";
	try { background = (theme as CardTheme).bg?.("customMessageBg", "·") ?? ""; } catch { /* No background support. */ }
	const key = `${style}:${width}:${themeSignature(theme)}:${background}`;
	const cached = geometryCache.get(key);
	if (cached) return cached;
	const rows = sectionCardRows({ glyph: "▾", title: "HEADER" }, [CARD_PROBE], theme, width).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
	const bodyRow = Math.max(0, rows.findIndex((row) => row.includes(CARD_PROBE)));
	const headerRow = Math.max(0, rows.findIndex((row) => row.includes("HEADER")));
	const geometry = { headerRow, headerX: Math.max(0, visibleWidth(rows[headerRow]!.slice(0, rows[headerRow]!.indexOf("▾")))), bodyRow, bodyX: Math.max(0, visibleWidth(rows[bodyRow]!.slice(0, rows[bodyRow]!.indexOf(CARD_PROBE)))) };
	if (geometryCache.size > 64) geometryCache.clear();
	geometryCache.set(key, geometry);
	return geometry;
}
// The header row a part renders (`▾ NAME … count`, styled, hover included),
// split at the gap before its right-aligned count into the card's glyph,
// title and count, keeping their styling.
function headerParts(line: string): { glyph?: string; title: string; count?: string } {
	const trimmed = line.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1");
	const split = /^(.*?\S)( {2,})(?=\S|\x1b)(.*)$/s.exec(trimmed);
	const left = split ? split[1]! : trimmed;
	const count = split?.[3]?.trim() ? split[3] : undefined;
	// The glyph keeps its own escape codes on both sides (the hover role paints it),
	// so no opening code leaks onto the title.
	const glyph = /^((?:\x1b\[[0-9;]*m)*[▾▸](?:\x1b\[[0-9;]*m)*)\s/.exec(left);
	return { ...(glyph ? { glyph: glyph[1] } : {}), title: glyph ? left.slice(glyph[0].length) : left, ...(count ? { count } : {}) };
}
type SidebarPresentation = { scrollTop: number; output: LayoutNode };
type PreparedRail = {
	activeRail: SidebarRail | undefined;
	destinations: SidebarDestination[];
	destination: string;
	revision: number;
	width: number;
	mode: string | undefined;
	headerPlacement: HeaderPlacement;
	density: Density;
	surface: string;
	cardStyle: CardStyle;
	root: LayoutRoot;
	theme: ShellBarTheme;
	themeSignature: string;
	parts: Array<[string, SidebarRail]>;
	digests: Array<string | undefined>;
	contentWidth: number;
	viewportOverhead: number;
	active: boolean;
	lines: string[];
	hits: RailHit[];
	// The header row is a full-width sibling above the hstack, not a rail
	// section: it never enters `lines`/`hits`, and an empty/blank result
	// falls back to the old hstack-direct shape with the banner restored.
	headerLines: string[];
	statusLines: string[];
	/** The tinted blank row that fills the rail below a trailing panel section, or "" when the rail ends on a card. */
	fillRow: string;
	headerActive: boolean;
	presentation?: SidebarPresentation;
};
const CACHE = Symbol.for("gentle-pi.experimental-sidebar.cache");

function sidebarCache(tui: TUI): SidebarCache {
	const terminal = tui.terminal as unknown as Record<symbol, SidebarCache>;
	return terminal[CACHE] ??= { revision: 0 };
}

/** Mark terminal-owned fullscreen sidebar output stale after a part state change. */
export function invalidateSidebar(tui: TUI): void {
	if (tui.terminal) sidebarCache(tui).revision++;
}

// The memo keys on part identity and an explicit revision, neither of which can
// see live session state read inside a rail's render closure: a model switch, a
// new context percentage or an extension status change leaves the prepared lines
// intact. A rail that paints such state declares a digest of it, so the memo can
// notice by itself; a throwing digest degrades that rail to invalidation-only
// rather than taking the whole sidebar down with it.
function railDigest(rail: SidebarRail): string | undefined {
	try {
		return rail.digest?.();
	} catch {
		return undefined;
	}
}

// Pi passes extensions one live theme proxy, so identity never changes on a
// theme switch, and the switch only calls ui.invalidate(), which does not reach
// the rail inside the layout tree. How the current theme paints a few roles is
// what changes, so the memo keys on that: a digest-only section (Status,
// Agents, Todos) would otherwise keep the previous theme's colors.
const THEME_SIGNATURE_ROLES = ["accent", "border", "borderAccent", "muted", "dim", "text", "success", "warning", "error"];
function themeSignature(theme: ShellBarTheme): string {
	try {
		return THEME_SIGNATURE_ROLES.map((role) => theme.fg(role, "·")).join("") + theme.bold("·");
	} catch {
		return "";
	}
}

export const STATUS_OWNER = { HEADER: "header", BOTTOM: "bottom" } as const;
export type StatusOwner = (typeof STATUS_OWNER)[keyof typeof STATUS_OWNER];
export interface StatusOwnerInput {
	mode: string | undefined;
	columns: number;
	statusPlacement: StatusPlacement;
	headerPlacement: HeaderPlacement;
}

/**
 * Which single status row owns a narrow fullscreen terminal, so the header and
 * the bottom bar never both paint there. A configured top header wins;
 * otherwise the bottom bar does, unless Status is hidden and the below-input
 * header is all that is left. Wide and regular layouts keep their own rules.
 */
export function narrowStatusOwner(input: StatusOwnerInput): StatusOwner | undefined {
	if (input.mode !== "fullscreen" || input.columns >= SIDEBAR_BREAKPOINT) return undefined;
	return input.headerPlacement !== "below-input" || input.statusPlacement === "hidden" ? STATUS_OWNER.HEADER : STATUS_OWNER.BOTTOM;
}

export type SidebarDestination = { id: string; label: string; rail?: SidebarRail };
export type SidebarNavigationProvider = () => readonly SidebarDestination[] | undefined;

/** Installs the fullscreen rail and returns a disposer restoring the original layout. */
export function installSidebar(tui: TUI, theme: ShellBarTheme, placement: () => StatusPlacement = () => "auto", headerPlacement: () => HeaderPlacement = () => "split", density: () => Density = () => "comfortable", navigationProvider: SidebarNavigationProvider = () => undefined, onDestination: (id: string | undefined) => void = () => {}, onViewport: (id: string, height: number) => void = () => {}): () => void {
	if (!tui.terminal) return () => {};
	const host = tui as Host;
	const state = sidebarState(tui);
	const cache = sidebarCache(tui);
	const cleanups: Array<() => void> = [];
	const roots = new Set<LayoutRoot>();
	let stopped = false;
	let failed = false;
	let railLines: string[] = [];
	let fillRow = "";
	let headerLines: string[] = [];
	let statusLines: string[] = [];
	let prepared: PreparedRail | undefined;
	let selected = "main";
	const destinations = (): SidebarDestination[] => {
		try {
			const value = navigationProvider();
			if (!value) return [];
			const seen = new Set<string>();
			return value.filter(item => item && item.id && item.label && (item.id === "main" || item.rail) && !seen.has(item.id) && !!seen.add(item.id));
		} catch { return []; }
	};
	const sameDestinations = (a: readonly SidebarDestination[], b: readonly SidebarDestination[]) => a.length === b.length && a.every((item, i) => item.id === b[i]?.id && item.label === b[i]?.label && item.rail === b[i]?.rail);
	const destination = (items: readonly SidebarDestination[]) => items.some(item => item.id === selected) ? selected : items[0]?.id ?? "main";
	// One rendered-lines cache per rail section key, independent of the
	// whole-rail `prepared` memo below: a section with its own digest is
	// revalidated by that digest alone, so a sibling's ticking digest (the
	// header/Status counters) never forces Agents or TODO to re-render. A
	// section with no digest (or a throwing one) falls back to the shared
	// revision counter, exactly like the whole-rail memo already did.
	const sectionCache = new Map<string, SectionCacheEntry>();
	state.active = false;
	// Hidden removes Status everywhere, including regular mode where the rail
	// never mounts, so it is published independently of the fullscreen layout.
	state.statusHidden = () => !stopped && placement() === "hidden";
	// A narrow top header is the only status row there. Whether it paints comes
	// from the last layout pass (a blank or failed header never swallows the
	// bottom bar); the geometry is read live so a resize applies before the next pass.
	const headerOwnsStatus = () => !stopped && !failed && headerLines.length > 0 && headerPlacement() !== "below-input" &&
		narrowStatusOwner({ mode: host.mode, columns: tui.terminal.columns, statusPlacement: placement(), headerPlacement: headerPlacement() }) === STATUS_OWNER.HEADER;
	state.headerOwnsStatus = headerOwnsStatus;
	state.railColumns = SIDEBAR_RAIL_COLUMNS;
	state.layoutAttached = () => !stopped && !failed && host.mode === "fullscreen" && !!host.layoutRoot && roots.has(host.layoutRoot);
	state.ownsHost = () => !stopped && host.mode === "fullscreen" && tui.terminal.columns >= SIDEBAR_BREAKPOINT && (placement() === "auto" || placement() === "right") && !!host.layoutRoot && roots.has(host.layoutRoot);
	// The panel surface runs to the bottom of the rail: below the last panel
	// section, blank tinted rows fill what is left of the viewport. They are
	// not content, so they never add scroll range or hit targets.
	const rail: Component = {
		render: () => {
			if (prepared?.activeRail) onViewport(prepared.destination, Math.max(1, scroll.viewportHeight - prepared.viewportOverhead));
			const room = scroll.viewportHeight - railLines.length;
			return fillRow && room > 0 ? [...railLines, ...Array.from({ length: room }, () => fillRow)] : railLines;
		},
		invalidate() {
			invalidateSidebar(tui);
			for (const part of state.parts.values()) part.invalidate();
		},
	};
	// The header row: a plain leaf component measured from its rendered lines
	// (one line with just the status bar; two once the rule row joins it),
	// painted full-width above the hstack when a "header" part is registered
	// and has something to show.
	// The header is not inside the rail's ScrollView, so it never goes through
	// dispatchPartMouse: it is its own leaf in the layout tree (no [NODE]),
	// and pi-tui's mouse dispatch (tui-alt-screen.js dispatchMouseToLayout)
	// finds and calls handleMouse on whatever leaf box is under the pointer
	// directly, without any wiring of our own. Delegate straight to whatever
	// the registered "header" part declares.
	const header: Component = {
		render: () => headerLines,
		invalidate() {},
		handleMouse: (event) => {
			if (event.type === "move" && event.button === "none") setSidebarHover(tui);
			return state.parts.get("header")?.handleMouse?.(event);
		},
	};
	// The status bar row: a leaf like the header, painted full-width below the
	// hstack while the rail is shown, delegating its mouse to the registered part.
	const statusBar: Component = {
		render: () => statusLines,
		invalidate() {},
		handleMouse: (event) => {
			if (event.type === "move" && event.button === "none") setSidebarHover(tui);
			return state.parts.get("statusbar")?.handleMouse?.(event);
		},
	};
	const scroll = new ScrollView(rail, {
		follow: "none",
		primary: false,
		overscroll: "contain",
		// "always" re-slices the scrollbar column of every rail line on every
		// render pass (grapheme measurement per row). "auto" keeps the rail
		// scrollbar transient like pi's own fullscreen scrollbar.
		scrollbar: "auto",
		scrollbarTrackStyle: (text) => theme.fg("border", text),
		scrollbarThumbStyle: (text) => theme.fg("accent", text),
	});
	const tabGeometry = (items: readonly SidebarDestination[]) => {
		let start = 0;
		return items.map(item => { const tab = { ...item, start, end: start + visibleWidth(item.label) + 2 }; start = tab.end + 3; return tab; });
	};
	const navigation: Component = {
		render(width) {
			if (!prepared || prepared.destinations.length < 2) return [];
			const tabs = tabGeometry(prepared.destinations);
			if (tabs.at(-1)!.end > width) return [];
			const active = tabs.find(tab => tab.id === prepared!.destination)!;
			const labels = tabs.map(tab => theme.fg(tab.id === active.id ? "accent" : "muted", tab.id === active.id ? `[${tab.label}]` : ` ${tab.label} `)).join("   ");
			const rule = theme.fg("border", "─".repeat(active.start)) + theme.fg("accent", "─".repeat(active.end - active.start)) + theme.fg("border", "─".repeat(width - active.end));
			return [labels + " ".repeat(width - visibleWidth(labels)), rule].map(row => paintSurfaceRow(row, panelSurfaceOpener(theme)));
		},
		invalidate() {},
		handleMouse(event) {
			const current = prepared;
			if (event.type !== "click" || event.button !== "left" || event.y !== 0 || !current || current.destinations.length < 2 || !sameDestinations(current.destinations, destinations()) || stopped || failed || !state.active || !state.ownsHost?.() || current.width !== tui.terminal.columns || current.root !== host.layoutRoot || current.revision !== cache.revision) return undefined;
			const tabs = tabGeometry(current.destinations);
			if (tabs.at(-1)!.end > event.width) return undefined;
			const hit = tabs.find(tab => event.x >= tab.start && event.x < tab.end);
			if (!hit) return undefined;
			if (selected !== hit.id) { selected = hit.id; onDestination(selected); setSidebarHover(tui); scroll.scrollTo(0); tui.requestRender(); }
			return { handled: true, render: true };
		},
	};
	const tabbedRail = new VStack([{ component: navigation }, { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 }]);
	const nativeMouse = scroll.handleMouse.bind(scroll);
	const dispatchPartMouse = (event: TuiMouseEvent) => {
		const current = prepared;
		const items = destinations();
		if (!current || !sameDestinations(current.destinations, items) || current.destination !== destination(items) || stopped || failed || !current.active || current.revision !== cache.revision ||
			host.mode !== "fullscreen" || tui.terminal.columns !== current.width || host.layoutRoot !== current.root ||
			scroll.getContentWidth(event.width) !== current.contentWidth || event.x < 0 ||
			event.x >= current.contentWidth || event.y < 0 || event.y >= event.height) return undefined;
		const contentY = scroll.scrollTop + event.y;
		const hit = current.hits.find((candidate) => contentY >= candidate.startY && contentY < candidate.startY + candidate.height);
		if (!hit || (hit.key === "$destination" ? items.find(item => item.id === current.destination)?.rail : state.parts.get(hit.key)) !== hit.component) return undefined;
		if (!hit.wholeRow && !(hit.key === "$destination" && event.type === "wheel") && (event.x < hit.x || event.x >= hit.x + hit.width)) return undefined;
		// The part sees the event in the frame it rendered: its own width and all its rows.
		return hit.component.handleMouse?.({
			...event,
			x: Math.max(0, Math.min(hit.frameWidth - 1, event.x - hit.x)),
			y: hit.row + contentY - hit.startY,
			width: hit.frameWidth,
			height: hit.frameHeight,
		});
	};
	scroll.handleMouse = (event) => {
		if (event.type === "wheel") {
			const current = prepared, items = destinations();
			if (!current || !sameDestinations(current.destinations, items) || current.destination !== destination(items) || current.revision !== cache.revision || stopped || failed || !current.active || current.width !== tui.terminal.columns || current.root !== host.layoutRoot || !state.ownsHost?.()) return { handled: true, render: false };
			// A bounded section (Todo) owns its inner viewport. Only wheel
			// events it declines should move the surrounding rail.
			const sectionResult = dispatchPartMouse(event);
			if (sectionResult?.handled) return sectionResult;
			// Git owns the whole card, including its border and padding. Never
			// turn a wheel over that chrome into outer sidebar scrolling.
			if ((current.destination === "git" || current.destination === "tree") && current.activeRail) {
				return current.activeRail.handleMouse?.({ ...event, x: 0, y: 0 }) ?? { handled: true };
			}
			// Consume even at the boundary or over blank rail space: Pi 0.85.1
			// can send unconsumed delta to the primary transcript despite containment.
			scroll.scrollBy(event.wheelDelta ?? 0);
			return {
				handled: true,
				render: true,
				target: { component: scroll, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height },
			};
		}
		const result = dispatchPartMouse(event);
		if (!result && event.type === "move" && event.button === "none") setSidebarHover(tui);
		return result ?? nativeMouse(event);
	};
	const prepare = (width: number, root: LayoutRoot): boolean => {
		state.active = false;
		if (stopped || failed || host.mode !== "fullscreen") {
			onDestination(undefined);
			prepared = undefined;
			headerLines = [];
			statusLines = [];
			return false;
		}
		const railEligible = width >= SIDEBAR_BREAKPOINT && placement() !== "bottom" && placement() !== "hidden";
		if (!railEligible) {
			onDestination(undefined);
			prepared = undefined;
			statusLines = [];
			try {
				const headerPart = state.parts.get("header");
				headerLines = headerPlacement() !== "below-input" && headerPart
					? [...(headerPart.render(Math.max(0, width)) ?? [])] : [];
				if (!headerLines.some((line) => line.trim() !== "")) headerLines = [];
				// A narrow terminal keeps the status bar row (mobile chrome) when its part paints one.
				const statusPart = state.parts.get("statusbar");
				const narrowStatus = statusPart ? [...(statusPart.render(Math.max(0, width)) ?? [])] : [];
				statusLines = narrowStatus.some((line) => line.trim() !== "") ? narrowStatus : [];
			} catch {
				failed = true;
				headerLines = [];
			}
			return false;
		}
		const style = cardStyle();
		const items = destinations();
		const activeDestination = destination(items);
		onDestination(activeDestination);
		if (selected !== activeDestination) { selected = activeDestination; scroll.scrollTo(0); }
		const activeRail = items.find(item => item.id === activeDestination)?.rail;
		const parts = [...state.parts.entries()].filter(([key]) => activeDestination === "main" || key === "header" || key === "statusbar");
		if (activeRail) parts.push(["$destination", activeRail]);
		// Digest closures read live session state, so they must be evaluated once
		// per frame and stored for the next comparison (issue #1681): the sections
		// loop below reuses this pass instead of calling each digest a second time.
		const digests = parts.map(([, rail]) => railDigest(rail));
		const signature = themeSignature(theme);
		const unchanged = prepared !== undefined && prepared.activeRail === activeRail && sameDestinations(prepared.destinations, items) && prepared.destination === activeDestination && prepared.revision === cache.revision &&
			prepared.width === width && prepared.mode === host.mode && prepared.headerPlacement === headerPlacement() && prepared.density === density() && prepared.surface === chromeSurface() && prepared.cardStyle === style && prepared.root === root && prepared.theme === theme && prepared.themeSignature === signature &&
			prepared.parts.length === parts.length && prepared.parts.every(([key, part], index) => parts[index]?.[0] === key && parts[index]?.[1] === part) &&
			prepared.digests.length === digests.length && prepared.digests.every((digest, index) => digest === digests[index]);
		if (unchanged) {
			railLines = prepared.lines;
			statusLines = prepared.statusLines;
			fillRow = prepared.fillRow;
			state.active = prepared.active;
			return prepared.active;
		}
		try {
			const digestByPart = new Map(parts.map(([key], index) => [key, digests[index]]));
			// Top and split headers are full-width siblings above the conversation
			// and rail; the registered part still chooses which content to render.
			const headerPart = state.parts.get("header");
			const preparedHeaderLines = [...(headerPart?.render(Math.max(0, width)) ?? [])];
			const headerActive = headerPart !== undefined && preparedHeaderLines.some((line) => line.trim() !== "");
			const contentWidth = scroll.getContentWidth(RAIL_WIDTH);
			const carded = chromeSurface() === "transparent";
			// Float cards are tinted from edge to edge, so two of them would fuse into one
			// slab: like the conversation cards, they always keep a blank row between them.
			// Neon cards close with their own rule, so the density decides their gap.
			const cardGap = () => (carded && style === CARD_STYLE.FLOAT) || sectionGap(density());
			// A carded section renders one indent wider; its body rows drop that indent inside the card.
			const renderWidth = carded ? panelInnerWidth(theme, contentWidth) + PANEL_ROW_INDENT : contentWidth - RAIL_PADDING * 2;
			// Live work first, then the session Status sections (design/shell-rework/02-proposal.html).
			const sections = (activeDestination !== "main" ? ["$destination"] : ["todo", "jobs", "agents", "footer"]).filter((key) => key !== "todo" || state.visibility?.todo !== false).map((key) => {
				const component = key === "$destination" ? activeRail : state.parts.get(key);
				if (!component) {
					sectionCache.delete(key);
					return { key, component, lines: [] as string[] };
				}
				const digest = digestByPart.get(key);
				const existing = sectionCache.get(key);
				// Sections paint their card chrome in the active style, which their
				// own digests do not track, so a style switch must re-render them.
				const reusable = existing?.component === component && existing.contentWidth === contentWidth && existing.renderWidth === renderWidth && existing.cardStyle === style && existing.theme === theme && existing.themeSignature === signature &&
					(digest !== undefined ? existing.digest === digest : existing.digest === undefined && existing.revision === cache.revision);
				const lines = reusable ? existing.lines : (() => {
					const rendered = [...(component.render(renderWidth) ?? [])];
					while (rendered.length && rendered[rendered.length - 1]?.trim() === "") rendered.pop();
					return rendered;
				})();
				sectionCache.set(key, { component, digest, revision: cache.revision, contentWidth, renderWidth, cardStyle: style, theme, themeSignature: signature, lines });
				return { key, component, lines };
			}).filter((section) => section.component !== undefined && section.lines.length > 0) as Array<{ key: string; component: Component; lines: string[] }>;
			// The header carries the brand once it is active; the banner is the
			// rail's fallback identity when no header is wired up.
			const branding = headerActive || items.length >= 2 || activeRail ? [] : renderSidebarBanner(theme, contentWidth - RAIL_PADDING * 2);
			const hits: RailHit[] = [];
			railLines = [];
			fillRow = "";
			const surface = panelSurfaceOpener(theme);
			if (sections.length && headerActive && headerPlacement() !== "below-input" && items.length < 2) {
				// Tinted spacing continues the rail background; transparent spacing
				// leaves a clear row above the first card. Count it before recording hits.
				railLines.push(paintSurfaceRow(" ".repeat(contentWidth), surface));
			}
			if (sections.length && branding.length) {
				railLines.push(...branding.map((line) => " ".repeat(RAIL_PADDING) + line + " ".repeat(RAIL_PADDING)));
			} else if (!carded && sections.length && headerActive && headerPlacement() === "below-input" && density() === "comfortable" && style === CARD_STYLE.NEON) {
				// Keep neon's existing comfortable gap for below-input headers too.
				railLines.push((sections[0].component as SidebarRail).surface === "panel" ? paintSurfaceRow(" ".repeat(contentWidth), surface) : "");
			}
			// Panel sections share one tinted surface: their rows, padding
			// included, and the gap between two of them are painted alike.
			let previousPanel = false;
			for (const section of sections) {
				const panel = (section.component as SidebarRail).surface === "panel";
				const paint = (row: string) => (panel ? paintSurfaceRow(row, surface) : row);
				// One blank row separates a section from the banner or the
				// previous section; neon's header gap above is not a section.
				if ((hits.length > 0 || branding.length > 0) && (carded ? cardGap() : sectionGap(density()))) railLines.push(!carded && panel && previousPanel ? paint(" ".repeat(contentWidth)) : "");
				if (carded && !(section.component as SidebarRail).framed) {
					const layout = (section.component as SidebarRail).cardGroups?.(renderWidth) ?? { groups: [{ start: 0, end: section.lines.length }] };
					const geometry = cardGeometry(theme, contentWidth, style);
					const indent = " ".repeat(PANEL_ROW_INDENT);
					const looseRows = new Set(layout.loose ?? []);
					let nextRow = 0;
					const appendLoose = (until: number) => {
						for (; nextRow < until; nextRow++) {
							if (!looseRows.has(nextRow)) continue;
							const line = section.lines[nextRow] ?? "";
							const top = railLines.length;
							railLines.push(truncateToWidth(line, contentWidth, "…"));
							hits.push({ key: section.key, component: section.component, startY: top, height: 1, width: renderWidth, x: 0, row: nextRow, frameWidth: renderWidth, frameHeight: section.lines.length });
						}
					};
					layout.groups.forEach((group, index) => {
						appendLoose(group.start);
						if (index > 0 && cardGap()) railLines.push("");
						const body = section.lines.slice(group.start + 1, group.end).map((row) => row.startsWith(indent) ? row.slice(PANEL_ROW_INDENT) : row);
						if (section.key !== "$destination") while (body.length && body[body.length - 1]?.trim() === "") body.pop();
						const top = railLines.length;
						const cardRows = sectionCardRows(headerParts(section.lines[group.start] ?? ""), body, theme, contentWidth);
						// TREE's bounded viewport can be smaller than the shared chrome
						// itself. Never turn that chrome into outer rail scroll range.
						const room = section.key === "$destination" && activeDestination === "tree" && scroll.viewportHeight > 0 ? Math.max(0, scroll.viewportHeight - top) : cardRows.length;
						railLines.push(...cardRows.slice(0, room));
						// The title row folds the section like its header; body rows keep their own rows.
						const frame = { frameWidth: renderWidth, frameHeight: section.lines.length };
						hits.push({ key: section.key, component: section.component, startY: top + geometry.headerRow, height: 1, width: renderWidth, x: geometry.headerX, row: group.start, wholeRow: true, ...frame });
						if (body.length) hits.push({ key: section.key, component: section.component, startY: top + geometry.bodyRow, height: body.length, width: renderWidth - PANEL_ROW_INDENT, x: geometry.bodyX - (section.key === "$destination" ? 0 : PANEL_ROW_INDENT), row: group.start + 1, ...frame });
						nextRow = group.end;
					});
					appendLoose(section.lines.length);
					continue;
				}
				const startY = railLines.length;
				const padding = RAIL_PADDING;
				railLines.push(...section.lines.map((line) => paint(" ".repeat(padding) + line + " ".repeat(padding))));
				previousPanel = panel;
				fillRow = panel ? paint(" ".repeat(contentWidth)) : "";
				const frameWidth = renderWidth;
				hits.push({ key: section.key, component: section.component, startY, height: section.lines.length, width: frameWidth, x: padding, row: 0, frameWidth, frameHeight: section.lines.length });
			}
			// Height is owned by the native ScrollView, never by the transcript.
			const active = railLines.length > 0 && railLines.every((line) => visibleWidth(line) <= contentWidth);
			headerLines = headerActive && headerPlacement() !== "below-input" ? preparedHeaderLines : [];
			const statusPart = state.parts.get("statusbar");
			const preparedStatusLines = active && statusPart ? [...(statusPart.render(Math.max(0, width)) ?? [])] : [];
			statusLines = preparedStatusLines.some((line) => line.trim() !== "") ? preparedStatusLines : [];
			const viewportOverhead = (activeDestination === "git" || activeDestination === "tree") && activeRail ? Math.max(0, railLines.length - (sections.find(section => section.key === "$destination")?.lines.length ?? 0)) : 0;
			prepared = { activeRail, destinations: items, destination: activeDestination, revision: cache.revision, width, mode: host.mode, headerPlacement: headerPlacement(), density: density(), surface: chromeSurface(), cardStyle: style, root, theme, themeSignature: signature, parts, digests, contentWidth, viewportOverhead, active, lines: railLines, hits, headerLines, statusLines, fillRow, headerActive: headerLines.length > 0 };
			state.active = active;
			return active;
		} catch {
			failed = true;
			return false;
		}
	};
	const attach = () => {
		if (stopped || failed) return;
		if (host.mode !== "fullscreen") { state.active = false; onDestination(undefined); return; }
		try {
			const root = host.layoutRoot;
			if (!root || typeof root[NODE] !== "function") { state.active = false; return; }
			if (roots.has(root)) return;
			const original = root[NODE]!;
			const descriptor = Object.getOwnPropertyDescriptor(root, NODE);
			const mouseDescriptor = Object.getOwnPropertyDescriptor(root, "handleMouse");
			// pi-tui skips layout roots that keep Container.prototype.handleMouse:
			// without a mouse layout cache it renders every child to measure it,
			// which re-renders the whole transcript on each wheel or move event.
			// Replacing it must not re-enable that path, so only own handlers run.
			const originalMouse = root.handleMouse === Container.prototype.handleMouse ? undefined : root.handleMouse;
			const fallbackMouse: NonNullable<Component["handleMouse"]> = (event) => {
				if (event.type === "move" && event.button === "none") setSidebarHover(tui);
				return originalMouse?.call(root, event);
			};
			// Fullscreen gives this stretched stack an explicit viewport height.
			// Its intrinsic-height probe is unused; real painting traverses NODE.
			// Delegating that probe to root.render would render the transcript twice.
			// Pi's dock reserves one row for the footer (chat-viewport: minSize 1)
			// even though our footer paints nothing while the sidebar is active.
			// The row is baked in twice: the dock's own VStack.render pads it into
			// the intrinsic height the root measures, and its layout node keeps
			// it as minSize. Overriding only the node leaves the measured blank
			// row in place, so the dock is re-hosted in a real VStack over the
			// same children with the footer entry free to shrink to zero. One
			// wrapper per dock keeps component identity stable across frames.
			const docks = new WeakMap<Component, VStack>();
			const reclaimFooterRow = (node: LayoutNode): LayoutNode => {
				if (node.type !== "vstack" || !node.entries?.length) return node;
				const entries = node.entries as Array<{ component: Component & { [NODE]?: () => LayoutNode } }>;
				const dock = entries[entries.length - 1]!.component;
				if (typeof dock[NODE] !== "function") return node;
				let wrapped = docks.get(dock);
				if (!wrapped) {
					const inner = dock[NODE]!();
					if (inner.type !== "vstack" || !inner.entries?.length) return node;
					const last = inner.entries.length - 1;
					wrapped = new VStack(inner.entries.map((entry, index) => index === last ? { ...(entry as StackLayoutEntry), minSize: 0 } : entry as StackLayoutEntry), { gap: inner.gap, align: inner.align });
					docks.set(dock, wrapped);
				}
				return { ...node, entries: entries.map((entry, index) => index === entries.length - 1 ? { ...entry, component: wrapped! } : entry) };
			};
			// Without a rail the native layout stays in place; a hidden Status, or a
			// narrow top header owning it, only frees the footer's reserved dock row,
			// exactly as the rail does.
			// The minimal edition (compact work) hands the footer row to its status bar too.
			const nativeLayout = () => placement() === "hidden" || headerOwnsStatus() || state.compactWork?.() ? reclaimFooterRow(original.call(root)) : original.call(root);
			const nativeHost = { render: () => [], invalidate() {}, [NODE]: nativeLayout };
			const left = { render: () => [], invalidate() {}, [NODE]: () => reclaimFooterRow(original.call(root)) };
			// The full-width header is a sibling above this stable conversation/rail
			// hstack. Pi keeps native transcript scrolling and dispatches header and
			// rail mouse events in their respective boxes.
			const hstackHost: Component & { [NODE](): LayoutNode } = {
				render: () => [],
				invalidate() {},
				[NODE]: () => ({ type: "hstack", gap: GAP, align: "stretch", entries: [
					{ component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{ component: (prepared?.destinations.length ?? 0) >= 2 ? tabbedRail : scroll, basis: RAIL_WIDTH, grow: 0, shrink: 0, minSize: RAIL_WIDTH },
				] }),
			};
			const replacement = () => {
				if (!prepare(tui.terminal.columns, root)) {
					if (failed || stopped || host.mode !== "fullscreen") return original.call(root);
					if (!headerLines.length && !statusLines.length) return nativeLayout();
					return { type: "vstack", gap: 0, align: "stretch", entries: [
						...(headerLines.length ? [{ component: header, basis: "auto" as const, grow: 0, shrink: 0, minSize: 1 }] : []),
						{ component: nativeHost, basis: 0, grow: 1, shrink: 1, minSize: 1 },
						...(statusLines.length ? [{ component: statusBar, basis: "auto" as const, grow: 0, shrink: 0, minSize: 1 }] : []),
					] };
				}
				const current = prepared!;
				if (current.presentation?.scrollTop === scroll.scrollTop) return current.presentation.output;
				const withHeader = current.headerActive && headerPlacement() !== "below-input";
				const withStatus = current.statusLines.length > 0;
				const output: LayoutNode = withHeader || withStatus
					? { type: "vstack", gap: 0, align: "stretch", entries: [
						...(withHeader ? [{ component: header, basis: "auto" as const, grow: 0, shrink: 0, minSize: 1 }] : []),
						{ component: hstackHost, basis: 0, grow: 1, shrink: 1, minSize: 1 },
						...(withStatus ? [{ component: statusBar, basis: "auto" as const, grow: 0, shrink: 0, minSize: 1 }] : []),
					] }
					: hstackHost[NODE]();
				return (current.presentation = { scrollTop: scroll.scrollTop, output }).output;
			};
			root[NODE] = replacement;
			root.handleMouse = fallbackMouse;
			roots.add(root);
			tui.requestRender();
			cleanups.push(() => {
				if (root[NODE] === replacement) {
					if (descriptor) Object.defineProperty(root, NODE, descriptor);
					else Reflect.deleteProperty(root, NODE);
				}
				if (root.handleMouse === fallbackMouse) {
					if (mouseDescriptor) Object.defineProperty(root, "handleMouse", mouseDescriptor);
					else Reflect.deleteProperty(root, "handleMouse");
				}
			});
		} catch {
			failed = true;
			state.active = false;
		}
	};
	attach();
	// Pi replaces renderers without a session event. Rebind only that transition;
	// resize and scroll remain owned by Pi's native layout/render loop.
	const timer = setInterval(attach, 100);
	timer.unref();
	return () => {
		stopped = true;
		onDestination(undefined);
		setSidebarHover(tui);
		state.active = false;
		clearInterval(timer);
		scroll.setScrollbar("hidden");
		for (const cleanup of cleanups.reverse()) cleanup();
		tui.requestRender();
	};
}
