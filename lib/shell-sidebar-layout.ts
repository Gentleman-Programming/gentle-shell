import { ScrollView, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { sidebarState, type SidebarRail } from "./shell-sidebar.ts";
import type { ShellBarTheme } from "./shell-bar.ts";
import { renderSidebarBanner } from "./shell-sidebar-banner.ts";

export const SIDEBAR_BREAKPOINT = 140;
const RAIL_WIDTH = 50;
const RAIL_PADDING = 1;
const GAP = 3;
// Experimental Pi 0.85.1 internals. Only the fullscreen layout tree is adapted;
// regular mode keeps native scrollback and the original bottom components.
const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
type LayoutNode = { type: string; entries?: unknown[]; gap?: number; align?: string };
type LayoutRoot = Component & { [NODE]?: () => LayoutNode };
type Host = TUI & { mode?: string; layoutRoot?: LayoutRoot };
type SidebarCache = { revision: number };
type RailHit = { key: string; component: Component; startY: number; height: number; width: number };
type SidebarPresentation = { scrollTop: number; output: LayoutNode };
type PreparedRail = {
	revision: number;
	width: number;
	mode: string | undefined;
	root: LayoutRoot;
	theme: ShellBarTheme;
	parts: Array<[string, SidebarRail]>;
	digests: Array<string | undefined>;
	contentWidth: number;
	active: boolean;
	lines: string[];
	hits: RailHit[];
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

export function installSidebar(tui: TUI, theme: ShellBarTheme): () => void {
	if (!tui.terminal) return () => {};
	const host = tui as Host;
	const state = sidebarState(tui);
	const cache = sidebarCache(tui);
	const cleanups: Array<() => void> = [];
	const roots = new Set<LayoutRoot>();
	let stopped = false;
	let failed = false;
	let railLines: string[] = [];
	let prepared: PreparedRail | undefined;
	state.active = false;
	state.ownsHost = () => !stopped && host.mode === "fullscreen" && !!host.layoutRoot && roots.has(host.layoutRoot);
	const rail: Component = {
		render: () => railLines,
		invalidate() {
			invalidateSidebar(tui);
			for (const part of state.parts.values()) part.invalidate();
		},
	};
	const scroll = new ScrollView(rail, {
		follow: "none",
		primary: false,
		overscroll: "contain",
		scrollbar: "always",
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
		if (stopped || failed || host.mode !== "fullscreen" || width < SIDEBAR_BREAKPOINT) {
			prepared = undefined;
			return false;
		}
		const parts = [...state.parts.entries()];
		const digests = parts.map(([, rail]) => railDigest(rail));
		const unchanged = prepared?.revision === cache.revision &&
			prepared.width === width && prepared.mode === host.mode && prepared.root === root && prepared.theme === theme &&
			prepared.parts.length === parts.length && prepared.parts.every(([key, part], index) => parts[index]?.[0] === key && parts[index]?.[1] === part) &&
			prepared.digests.length === digests.length && prepared.digests.every((digest, index) => digest === digests[index]);
		if (unchanged) {
			railLines = prepared.lines;
			state.active = prepared.active;
			return prepared.active;
		}
		try {
			const contentWidth = scroll.getContentWidth(RAIL_WIDTH);
			const sections = ["footer", "agents", "todo"].map((key) => {
				const component = state.parts.get(key);
				const lines = [...(component?.render(contentWidth - RAIL_PADDING * 2) ?? [])];
				while (lines.length && lines[lines.length - 1]?.trim() === "") lines.pop();
				return { key, component, lines };
			}).filter((section) => section.component !== undefined && section.lines.length > 0) as Array<{ key: string; component: Component; lines: string[] }>;
			const branding = renderSidebarBanner(theme, contentWidth - RAIL_PADDING * 2);
			const hits: RailHit[] = [];
			railLines = [];
			if (sections.length && branding.length) {
				railLines.push(...branding.map((line) => " ".repeat(RAIL_PADDING) + line + " ".repeat(RAIL_PADDING)));
			}
			for (const section of sections) {
				if (railLines.length > 0) railLines.push("");
				const startY = railLines.length;
				railLines.push(...section.lines.map((line) => " ".repeat(RAIL_PADDING) + line + " ".repeat(RAIL_PADDING)));
				hits.push({ key: section.key, component: section.component, startY, height: section.lines.length, width: contentWidth - RAIL_PADDING * 2 });
			}
			// Height is owned by the native ScrollView, never by the transcript.
			const active = railLines.length > 0 && railLines.every((line) => visibleWidth(line) <= contentWidth);
			prepared = { revision: cache.revision, width, mode: host.mode, root, theme, parts, digests, contentWidth, active, lines: railLines, hits };
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
			const left = { render: () => [], invalidate() {}, [NODE]: () => original.call(root) };
			const replacement = () => {
				if (!prepare(tui.terminal.columns, root)) return original.call(root);
				const current = prepared!;
				if (current.presentation?.scrollTop === scroll.scrollTop) return current.presentation.output;
				return (current.presentation = {
					scrollTop: scroll.scrollTop,
					output: { type: "hstack", gap: GAP, align: "stretch", entries: [
						{ component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
						{ component: scroll, basis: RAIL_WIDTH, grow: 0, shrink: 0, minSize: RAIL_WIDTH },
					] },
				}).output;
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
