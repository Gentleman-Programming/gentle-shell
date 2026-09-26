import { ScrollView, VStack, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { sidebarState, type SidebarRail } from "./shell-sidebar.ts";
import type { ShellBarTheme } from "./shell-bar.ts";
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
// Experimental Pi 0.85.1 internals. Only the fullscreen layout tree is adapted;
// regular mode keeps native scrollback and the original bottom components.
const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
type LayoutNode = { type: string; entries?: unknown[]; gap?: number; align?: "stretch" | "start" | "center" | "end" };
type StackLayoutEntry = ConstructorParameters<typeof VStack>[0] extends Array<infer T> | undefined ? Exclude<T, Component> : never;
type LayoutRoot = Component & { [NODE]?: () => LayoutNode };
type Host = TUI & { mode?: string; layoutRoot?: LayoutRoot };
type SidebarCache = { revision: number };
type RailHit = { key: string; component: Component; startY: number; height: number; width: number };
type SectionCacheEntry = { component: Component; digest: string | undefined; revision: number; contentWidth: number; theme: ShellBarTheme; lines: string[] };
type SidebarPresentation = { scrollTop: number; output: LayoutNode };
type PreparedRail = {
	revision: number;
	width: number;
	mode: string | undefined;
	headerPlacement: HeaderPlacement;
	root: LayoutRoot;
	theme: ShellBarTheme;
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
	return input.headerPlacement === "top" || input.statusPlacement === "hidden" ? STATUS_OWNER.HEADER : STATUS_OWNER.BOTTOM;
}

/** Installs the fullscreen rail: wraps the host layout root with the [rail, transcript] hstack and returns a disposer restoring the original layout. */
export function installSidebar(tui: TUI, theme: ShellBarTheme, placement: () => StatusPlacement = () => "auto", headerPlacement: () => HeaderPlacement = () => "top", density: () => Density = () => "comfortable"): () => void {
	if (!tui.terminal) return () => {};
	const host = tui as Host;
	const state = sidebarState(tui);
	const cache = sidebarCache(tui);
	const cleanups: Array<() => void> = [];
	const roots = new Set<LayoutRoot>();
	let stopped = false;
	let failed = false;
	let railLines: string[] = [];
	let headerLines: string[] = [];
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
	const headerOwnsStatus = () => !stopped && !failed && headerLines.length > 0 && headerPlacement() === "top" &&
		narrowStatusOwner({ mode: host.mode, columns: tui.terminal.columns, statusPlacement: placement(), headerPlacement: headerPlacement() }) === STATUS_OWNER.HEADER;
	state.headerOwnsStatus = headerOwnsStatus;
	state.ownsHost = () => !stopped && host.mode === "fullscreen" && tui.terminal.columns >= SIDEBAR_BREAKPOINT && (placement() === "auto" || placement() === "right") && !!host.layoutRoot && roots.has(host.layoutRoot);
	const rail: Component = {
		render: () => railLines,
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
		handleMouse: (event) => state.parts.get("header")?.handleMouse?.(event),
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
			// Consume even at the boundary or over blank rail space: Pi 0.85.1
			// can send unconsumed delta to the primary transcript despite containment.
			scroll.scrollBy(event.wheelDelta ?? 0);
			return {
				handled: true,
				render: true,
				target: { component: scroll, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height },
			};
		}
		return dispatchPartMouse(event) ?? nativeMouse(event);
	};
	const prepare = (width: number, root: LayoutRoot): boolean => {
		state.active = false;
		if (stopped || failed || host.mode !== "fullscreen") {
			prepared = undefined;
			headerLines = [];
			return false;
		}
		const railEligible = width >= SIDEBAR_BREAKPOINT && placement() !== "bottom" && placement() !== "hidden";
		if (!railEligible) {
			prepared = undefined;
			try {
				const headerPart = state.parts.get("header");
				headerLines = headerPlacement() === "top" && headerPart
					? [...(headerPart.render(Math.max(0, width)) ?? [])] : [];
				if (!headerLines.some((line) => line.trim() !== "")) headerLines = [];
			} catch {
				failed = true;
				headerLines = [];
			}
			return false;
		}
		const parts = [...state.parts.entries()];
		const digests = parts.map(([, rail]) => railDigest(rail));
		const unchanged = prepared?.revision === cache.revision &&
			prepared.width === width && prepared.mode === host.mode && prepared.headerPlacement === headerPlacement() && prepared.root === root && prepared.theme === theme &&
			prepared.parts.length === parts.length && prepared.parts.every(([key, part], index) => parts[index]?.[0] === key && parts[index]?.[1] === part) &&
			prepared.digests.length === digests.length && prepared.digests.every((digest, index) => digest === digests[index]);
		if (unchanged) {
			railLines = prepared.lines;
			state.active = prepared.active;
			return prepared.active;
		}
		try {
			// The header is a full-width sibling row, not a rail section: it reads
			// the terminal width (minus the rail's right inset), never the
			// 50-column rail's content width.
			const headerPart = state.parts.get("header");
			const preparedHeaderLines = [...(headerPart?.render(Math.max(0, width - HEADER_RIGHT_INSET)) ?? [])];
			const headerActive = headerPart !== undefined && preparedHeaderLines.some((line) => line.trim() !== "");
			const contentWidth = scroll.getContentWidth(RAIL_WIDTH);
			const sections = ["footer", "agents", "todo"].filter((key) => key !== "todo" || state.visibility?.todo !== false).map((key) => {
				const component = state.parts.get(key);
				if (!component) {
					sectionCache.delete(key);
					return { key, component, lines: [] as string[] };
				}
				const digest = railDigest(component);
				const existing = sectionCache.get(key);
				const reusable = existing?.component === component && existing.contentWidth === contentWidth && existing.theme === theme &&
					(digest !== undefined ? existing.digest === digest : existing.digest === undefined && existing.revision === cache.revision);
				const lines = reusable ? existing.lines : (() => {
					const rendered = [...(component.render(contentWidth - RAIL_PADDING * 2) ?? [])];
					while (rendered.length && rendered[rendered.length - 1]?.trim() === "") rendered.pop();
					return rendered;
				})();
				sectionCache.set(key, { component, digest, revision: cache.revision, contentWidth, theme, lines });
				return { key, component, lines };
			}).filter((section) => section.component !== undefined && section.lines.length > 0) as Array<{ key: string; component: Component; lines: string[] }>;
			// The header carries the brand once it is active; the banner is the
			// rail's fallback identity when no header is wired up.
			const branding = headerActive ? [] : renderSidebarBanner(theme, contentWidth - RAIL_PADDING * 2);
			const hits: RailHit[] = [];
			railLines = [];
			if (sections.length && branding.length) {
				railLines.push(...branding.map((line) => " ".repeat(RAIL_PADDING) + line + " ".repeat(RAIL_PADDING)));
			} else if (sections.length && headerActive && density() === "comfortable") {
				// The banner used to hold the first card off the top; the header
				// took its place, so keep one blank row between them.
				railLines.push("");
			}
			for (const section of sections) {
				// One blank row separates a section from the banner or the
				// previous section; the header gap above is not a section.
				if ((hits.length > 0 || branding.length > 0) && density() === "comfortable") railLines.push("");
				const startY = railLines.length;
				railLines.push(...section.lines.map((line) => " ".repeat(RAIL_PADDING) + line + " ".repeat(RAIL_PADDING)));
				hits.push({ key: section.key, component: section.component, startY, height: section.lines.length, width: contentWidth - RAIL_PADDING * 2 });
			}
			// Height is owned by the native ScrollView, never by the transcript.
			const active = railLines.length > 0 && railLines.every((line) => visibleWidth(line) <= contentWidth);
			headerLines = headerActive && headerPlacement() === "top" ? preparedHeaderLines : [];
			prepared = { revision: cache.revision, width, mode: host.mode, headerPlacement: headerPlacement(), root, theme, parts, digests, contentWidth, active, lines: railLines, hits, headerLines, headerActive: headerLines.length > 0 };
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
			const nativeLayout = () => placement() === "hidden" || headerOwnsStatus() ? reclaimFooterRow(original.call(root)) : original.call(root);
			const nativeHost = { render: () => [], invalidate() {}, [NODE]: nativeLayout };
			const left = { render: () => [], invalidate() {}, [NODE]: () => reclaimFooterRow(original.call(root)) };
			// Stable component wrapping the [left, scroll] hstack behind its own
			// NODE, exactly like `left` wraps the native transcript: the header
			// vstack's second entry recurses into it the same way pi-tui already
			// recurses into a nested layout via [NODE].
			const hstackHost: Component & { [NODE](): LayoutNode } = {
				render: () => [],
				invalidate() {},
				[NODE]: () => ({ type: "hstack", gap: GAP, align: "stretch", entries: [
					{ component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{ component: scroll, basis: RAIL_WIDTH, grow: 0, shrink: 0, minSize: RAIL_WIDTH },
				] }),
			};
			const replacement = () => {
				if (!prepare(tui.terminal.columns, root)) {
					if (failed || stopped || host.mode !== "fullscreen") return original.call(root);
					if (!headerLines.length) return nativeLayout();
					return { type: "vstack", gap: 0, align: "stretch", entries: [
						{ component: header, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
						{ component: nativeHost, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					] };
				}
				const current = prepared!;
				if (current.presentation?.scrollTop === scroll.scrollTop) return current.presentation.output;
				const output: LayoutNode = current.headerActive && headerPlacement() !== "below-input"
					? { type: "vstack", gap: 0, align: "stretch", entries: [
						{ component: header, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
						{ component: hstackHost, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					] }
					: hstackHost[NODE]();
				return (current.presentation = { scrollTop: scroll.scrollTop, output }).output;
			};
			root[NODE] = replacement;
			roots.add(root);
			tui.requestRender();
			cleanups.push(() => {
				if (root[NODE] !== replacement) return;
				if (descriptor) Object.defineProperty(root, NODE, descriptor);
				else Reflect.deleteProperty(root, NODE);
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
		state.active = false;
		clearInterval(timer);
		scroll.hideTransientScrollbar();
		for (const cleanup of cleanups.reverse()) cleanup();
		tui.requestRender();
	};
}
