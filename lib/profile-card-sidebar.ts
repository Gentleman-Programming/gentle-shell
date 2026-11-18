import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { resolveProfileCard } from "./profile-card-policy.ts";
import {
	initialProfileIndex,
	nextProfileIndex,
	previousProfileIndex,
	profileCardActionAt,
	reconcileProfileIndex,
	renderProfileCardSection,
	type ProfileCardAction,
	type ProfileCardHit,
	type ProfileCardItem,
} from "./profile-card-widget.ts";
import type { PanelTheme } from "./shell-panel.ts";
import { sidebarPart, type SidebarRail } from "./shell-sidebar.ts";
import { invalidateSidebar } from "./shell-sidebar-layout.ts";

// The sidebar profile card's owner and registration glue. The owner holds the
// ONE copy of the card state (visibility, shown profile) so every surface —
// mouse clicks here, the "use" action (T4) and keyboard shortcuts (T5) — acts
// on the same selection. It does no rendering; `mountProfileCard` paints it.

/** The key the card registers under in `sidebarState(tui).parts`. */
export const PROFILE_CARD_SIDEBAR_KEY = "profiles";
// Saved profiles and session markers change outside this process's events (the
// /gentle:profiles panel writes the store), so a visible card re-reads them at
// most this often instead of on every frame.
export const PROFILE_CARD_REFRESH_MS = 1000;

/** Applies the shown profile in this session. T4 supplies the real implementation. */
export type ProfileCardUseHandler = (name: string) => void | Promise<void>;

export interface ProfileCardOwnerOptions {
	/** The saved profiles with their markers, read from the profile stores. */
	loadItems: () => readonly ProfileCardItem[];
	/** The "use" seam; defaults to a no-op until the owner action is wired. */
	onUse?: ProfileCardUseHandler;
	/** Config home holding profile-card.json; the real one when omitted. */
	configHome?: () => string | undefined;
	now?: () => number;
}

export interface ProfileCardOwner {
	/** Whether profile-card.json says the card is shown (as last read). */
	visible(): boolean;
	items(): readonly ProfileCardItem[];
	/** The shown position, always valid for `items()` (0 when empty). */
	index(): number;
	/** The shown profile, or undefined with no saved profiles. */
	shown(): ProfileCardItem | undefined;
	/** Re-read the visibility flag from its store; a card turning on restarts at the session's profile. */
	refreshVisibility(): void;
	/** Re-read the saved profiles, keeping the shown one by name when it still exists. */
	refreshItems(): void;
	/** Cheap staleness check for render time: refreshItems at most once per PROFILE_CARD_REFRESH_MS while visible. */
	pollItems(): void;
	next(): boolean;
	previous(): boolean;
	/** Run the use handler for the shown profile; false when nothing is shown. */
	use(): boolean;
	setUseHandler(handler: ProfileCardUseHandler | undefined): void;
	/** Called after any change a surface must repaint for. */
	onChange(listener: () => void): () => void;
	/** A string that changes whenever the painted card would. */
	digest(): string;
}

export function createProfileCardOwner(options: ProfileCardOwnerOptions): ProfileCardOwner {
	const now = options.now ?? Date.now;
	const listeners = new Set<() => void>();
	let useHandler = options.onUse;
	let visible = false;
	let items: readonly ProfileCardItem[] = [];
	let index = 0;
	let selectedName: string | undefined;
	let loadedAt = Number.NEGATIVE_INFINITY;
	const emit = () => { for (const listener of [...listeners]) listener(); };
	// A failed read (a stale session context, say) keeps what the card already shows.
	const safeLoad = (): readonly ProfileCardItem[] => {
		try { return options.loadItems(); } catch { return items; }
	};
	const select = (next: number) => { index = next; selectedName = items[next]?.name; };
	const same = (a: readonly ProfileCardItem[], b: readonly ProfileCardItem[]) => JSON.stringify(a) === JSON.stringify(b);
	const reload = (restart: boolean): boolean => {
		const loaded = safeLoad();
		loadedAt = now();
		const before = `${index}:${selectedName}`;
		const changed = !same(items, loaded);
		items = loaded;
		select(restart ? initialProfileIndex(items) : reconcileProfileIndex(selectedName, index, items));
		return changed || before !== `${index}:${selectedName}`;
	};
	const move = (target: (index: number, count: number) => number): boolean => {
		if (!visible || items.length === 0) return false;
		const next = target(index, items.length);
		const changed = next !== index;
		select(next);
		if (changed) emit();
		return changed;
	};
	return {
		visible: () => visible,
		items: () => items,
		index: () => index,
		shown: () => items[index],
		refreshVisibility() {
			let next = false;
			try { next = resolveProfileCard({ gentlePiConfigHome: options.configHome?.() }).visible; } catch { next = false; }
			const turnedOn = next && !visible;
			visible = next;
			if (turnedOn) reload(true);
			emit();
		},
		refreshItems() {
			// Hidden by default: a hidden card reads nothing, so the profile stores stay untouched.
			if (!visible) return;
			if (reload(false)) emit();
		},
		pollItems() {
			// No emit: the caller is the render pass, which reads `digest()` right after.
			if (!visible || now() - loadedAt < PROFILE_CARD_REFRESH_MS) return;
			reload(false);
		},
		next: () => move(nextProfileIndex),
		previous: () => move(previousProfileIndex),
		use() {
			const name = items[index]?.name;
			if (!visible || name === undefined) return false;
			void Promise.resolve(useHandler?.(name)).catch(() => {});
			return true;
		},
		setUseHandler(handler) { useHandler = handler; },
		onChange(listener) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		digest: () => JSON.stringify([visible, items, index]),
	};
}

/** Route one click's action to the owner: arrows navigate, `use` runs the handler. */
export function runProfileCardAction(owner: ProfileCardOwner, action: ProfileCardAction): void {
	if (action === "previous") owner.previous();
	else if (action === "next") owner.next();
	else owner.use();
}

/**
 * Register the card as the fullscreen rail's "profiles" section. It paints only
 * in the rail (the above-editor copy is always empty) and only while the owner
 * says visible. Returns the part, whose dispose() unregisters it and stops the
 * owner's repaint subscription.
 */
export function mountProfileCard(tui: TUI, theme: PanelTheme, owner: ProfileCardOwner): Component & { dispose(): void } {
	let hits: readonly ProfileCardHit[] = [];
	const repaint = () => {
		invalidateSidebar(tui);
		(tui as { requestRender?: () => void }).requestRender?.();
	};
	const unsubscribe = owner.onChange(repaint);
	const rail: SidebarRail & { dispose(): void } = {
		surface: "panel",
		render(width: number) {
			hits = [];
			if (!owner.visible()) return [];
			const section = renderProfileCardSection(owner.items(), owner.index(), theme, width);
			hits = section.hits;
			return section.lines;
		},
		digest() {
			owner.pollItems();
			return owner.digest();
		},
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			if (event.type !== "click" || event.button !== "left" || !owner.visible()) return undefined;
			const action = profileCardActionAt(hits, event.x, event.y);
			if (action === undefined) return undefined;
			runProfileCardAction(owner, action);
			return { handled: true, render: true };
		},
		invalidate() {},
		dispose() { unsubscribe(); },
	};
	const bottom: Component & { dispose?(): void } = { render: () => [], invalidate() {} };
	const part = sidebarPart(tui, PROFILE_CARD_SIDEBAR_KEY, bottom, rail);
	return { ...part, dispose() { unsubscribe(); part.dispose(); } };
}
