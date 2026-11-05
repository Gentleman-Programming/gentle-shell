import { Container, ScrollView, VStack, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { setSidebarHover, sidebarState, type SidebarRail } from "./shell-sidebar.ts";
import type { ShellBarTheme } from "./shell-bar.ts";
import { CARD_STYLE, cardStyle, paintSurfaceRow, type CardStyle } from "./shell-card.ts";
import { chromeSurface, panelSurfaceOpener, sectionGap } from "./shell-panel.ts";
import { renderSidebarBanner } from "./shell-sidebar-banner.ts";
import type { Density, HeaderPlacement, StatusPlacement } from "./visual-customization-policy.ts";

export const SIDEBAR_BREAKPOINT = 140;
const RAIL_WIDTH = 50;
const RAIL_PADDING = 1;
// The rail's ScrollView keeps one column for its scrollbar; with the rail
// padding that puts the card's right border two columns in from the edge.
// The header row stops at the same column so its right group lines up with
// the card instead of touching the terminal edge.
const HEADER_RIGHT_INSET = RAIL_PADDING + 1;
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
type RailHit = { key: string; component: Component; startY: number; height: number; width: number };
type SectionCacheEntry = { component: Component; digest: string | undefined; revision: number; contentWidth: number; cardStyle: CardStyle; theme: ShellBarTheme; themeSignature: string; lines: string[] };
type SidebarPresentation = { scrollTop: number; output: LayoutNode };
type PreparedRail = {
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
	/** A `top` header painted inside the conversation column, beside the rail, instead of above both. */
	headerInColumn: boolean;
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

/** Installs the fullscreen rail: wraps the host layout root with the [rail, transcript] hstack and returns a disposer restoring the original layout. */
export function installSidebar(tui: TUI, theme: ShellBarTheme, placement: () => StatusPlacement = () => "auto", headerPlacement: () => HeaderPlacement = () => "split", density: () => Density = () => "comfortable"): () => void {
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
	const nativeMouse = scroll.handleMouse.bind(scroll);
	const dispatchPartMouse = (event: TuiMouseEvent) => {
		const current = prepared;
		if (!current || stopped || failed || !current.active || current.revision !== cache.revision ||
			host.mode !== "fullscreen" || tui.terminal.columns !== current.width || host.layoutRoot !== current.root ||
			scroll.getContentWidth(event.width) !== current.contentWidth || event.x < RAIL_PADDING ||
			event.x >= current.contentWidth || event.y < 0 || event.y >= event.height) return undefined;
		const contentY = scroll.scrollTop + event.y;
		const hit = current.hits.find((candidate) => contentY >= candidate.startY && contentY < candidate.startY + candidate.height);
		if (!hit || state.parts.get(hit.key) !== hit.component || event.x >= RAIL_PADDING + hit.width) return undefined;
		return hit.component.handleMouse?.({
			...event,
			x: event.x - RAIL_PADDING,
			y: contentY - hit.startY,
			width: hit.width,
			height: hit.height,
		});
	};
	scroll.handleMouse = (event) => {
		if (event.type === "wheel") {
			// A bounded section (Todo) owns its inner viewport. Only wheel
			// events it declines should move the surrounding rail.
			const sectionResult = dispatchPartMouse(event);
			if (sectionResult?.handled) return sectionResult;
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
			prepared = undefined;
			headerLines = [];
			statusLines = [];
			return false;
		}
		const railEligible = width >= SIDEBAR_BREAKPOINT && placement() !== "bottom" && placement() !== "hidden";
		if (!railEligible) {
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
		const parts = [...state.parts.entries()];
		// Digest closures read live session state, so they must be evaluated once
		// per frame and stored for the next comparison (issue #1681): the sections
		// loop below reuses this pass instead of calling each digest a second time.
		const digests = parts.map(([, rail]) => railDigest(rail));
		const signature = themeSignature(theme);
		const unchanged = prepared?.revision === cache.revision &&
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
			// The header is not a rail section: a split header is a full-width
			// sibling row reading the terminal width (minus the rail's right
			// inset), while a top header heads the conversation column beside the
			// rail. Neither reads the 50-column rail's content width.
			const headerPart = state.parts.get("header");
			const inColumn = headerPlacement() === "top";
			const columnWidth = Math.max(0, width - RAIL_WIDTH - GAP);
			let preparedHeaderLines = [...(headerPart?.render(inColumn ? columnWidth : Math.max(0, width - HEADER_RIGHT_INSET)) ?? [])];
			const headerActive = headerPart !== undefined && preparedHeaderLines.some((line) => line.trim() !== "");
			const contentWidth = scroll.getContentWidth(RAIL_WIDTH);
			// Live work first, then the session Status sections (design/shell-rework/02-proposal.html).
			const sections = ["todo", "jobs", "agents", "footer"].filter((key) => key !== "todo" || state.visibility?.todo !== false).map((key) => {
				const component = state.parts.get(key);
				if (!component) {
					sectionCache.delete(key);
					return { key, component, lines: [] as string[] };
				}
				const digest = digestByPart.get(key);
				const existing = sectionCache.get(key);
				// Sections paint their card chrome in the active style, which their
				// own digests do not track, so a style switch must re-render them.
				const reusable = existing?.component === component && existing.contentWidth === contentWidth && existing.cardStyle === style && existing.theme === theme && existing.themeSignature === signature &&
					(digest !== undefined ? existing.digest === digest : existing.digest === undefined && existing.revision === cache.revision);
				const lines = reusable ? existing.lines : (() => {
					const rendered = [...(component.render(contentWidth - RAIL_PADDING * 2) ?? [])];
					while (rendered.length && rendered[rendered.length - 1]?.trim() === "") rendered.pop();
					return rendered;
				})();
				sectionCache.set(key, { component, digest, revision: cache.revision, contentWidth, cardStyle: style, theme, themeSignature: signature, lines });
				return { key, component, lines };
			}).filter((section) => section.component !== undefined && section.lines.length > 0) as Array<{ key: string; component: Component; lines: string[] }>;
			// The header carries the brand once it is active; the banner is the
			// rail's fallback identity when no header is wired up.
			const branding = headerActive ? [] : renderSidebarBanner(theme, contentWidth - RAIL_PADDING * 2);
			const hits: RailHit[] = [];
			railLines = [];
			fillRow = "";
			const surface = panelSurfaceOpener(theme);
			if (sections.length && branding.length) {
				railLines.push(...branding.map((line) => " ".repeat(RAIL_PADDING) + line + " ".repeat(RAIL_PADDING)));
			} else if (sections.length && headerActive && inColumn) {
				// Beside a top header the first section sits on the window's first row, level with it.
			} else if (sections.length && headerActive && (headerPlacement() === "split" || (density() === "comfortable" && style === CARD_STYLE.NEON))) {
				// Pad the first section beneath the header without breaking its surface.
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
				if ((hits.length > 0 || branding.length > 0) && sectionGap(density())) railLines.push(panel && previousPanel ? paint(" ".repeat(contentWidth)) : "");
				const startY = railLines.length;
				railLines.push(...section.lines.map((line) => paint(" ".repeat(RAIL_PADDING) + line + " ".repeat(RAIL_PADDING))));
				previousPanel = panel;
				fillRow = panel ? paint(" ".repeat(contentWidth)) : "";
				hits.push({ key: section.key, component: section.component, startY, height: section.lines.length, width: contentWidth - RAIL_PADDING * 2 });
			}
			// Height is owned by the native ScrollView, never by the transcript.
			const active = railLines.length > 0 && railLines.every((line) => visibleWidth(line) <= contentWidth);
			// Without the rail a top header falls back to the full-width row.
			if (inColumn && headerActive && !active) preparedHeaderLines = [...(headerPart?.render(Math.max(0, width)) ?? [])];
			headerLines = headerActive && headerPlacement() !== "below-input" ? preparedHeaderLines : [];
			const statusPart = state.parts.get("statusbar");
			const preparedStatusLines = active && statusPart ? [...(statusPart.render(Math.max(0, width - HEADER_RIGHT_INSET)) ?? [])] : [];
			statusLines = preparedStatusLines.some((line) => line.trim() !== "") ? preparedStatusLines : [];
			prepared = { revision: cache.revision, width, mode: host.mode, headerPlacement: headerPlacement(), density: density(), surface: chromeSurface(), cardStyle: style, root, theme, themeSignature: signature, parts, digests, contentWidth, active, lines: railLines, hits, headerLines, statusLines, fillRow, headerActive: headerLines.length > 0, headerInColumn: inColumn && active && headerLines.length > 0 };
			state.active = active;
			return active;
		} catch {
			failed = true;
			return false;
		}
	};
	const attach = () => {
		if (stopped || failed) return;
		if (host.mode !== "fullscreen") { state.active = false; return; }
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
			// Stable component wrapping the [left, scroll] hstack behind its own
			// NODE, exactly like `left` wraps the native transcript: the header
			// vstack's second entry recurses into it the same way pi-tui already
			// recurses into a nested layout via [NODE].
			// A top header heads the conversation column: the same stable `left`
			// under the header leaf, so the transcript keeps its native scroll.
			const leftWithHeader = {
				render: () => [],
				invalidate() {},
				[NODE]: (): LayoutNode => ({ type: "vstack", gap: 0, align: "stretch", entries: [
					{ component: header, basis: "auto" as const, grow: 0, shrink: 0, minSize: 1 },
					{ component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				] }),
			};
			const hstackHost: Component & { [NODE](): LayoutNode } = {
				render: () => [],
				invalidate() {},
				[NODE]: () => ({ type: "hstack", gap: GAP, align: "stretch", entries: [
					{ component: prepared?.headerInColumn ? leftWithHeader : left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{ component: scroll, basis: RAIL_WIDTH, grow: 0, shrink: 0, minSize: RAIL_WIDTH },
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
				const withHeader = current.headerActive && !current.headerInColumn && headerPlacement() !== "below-input";
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
		setSidebarHover(tui);
		state.active = false;
		clearInterval(timer);
		scroll.setScrollbar("hidden");
		for (const cleanup of cleanups.reverse()) cleanup();
		tui.requestRender();
	};
}
