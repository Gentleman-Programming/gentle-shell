import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { effectiveKey, type KeymapBindings } from "./keymaps.ts";
import { evaluateProfilePin, readProfilePinStatus } from "./agent-profile-pin.ts";
import { profilesFilePath, readProfilesFileResult, type ProfilesFileReadResult } from "./agent-profiles.ts";
import { resolveProfileCard } from "./profile-card-policy.ts";
import { readSessionProfileBinding } from "./session-profile-binding.ts";
import { readSessionProfileDisk, type SessionProfileSource } from "./session-profile-disk-reader.ts";
import { isSessionProfileFamilyEntry } from "./session-profile-persistence.ts";
import {
	buildProfileCardItems,
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

// ---- Display read ----

export interface ProfileCardReaderDeps {
	/** The pure session record read; tests inject a counting spy. */
	readDisk?: typeof readSessionProfileDisk;
	readProfiles?: typeof readProfilesFileResult;
}

export interface ProfileCardSource {
	configHome: string;
	sessionId: string | undefined;
	cwd: string;
	session?: SessionProfileSource;
}

export interface ProfileCardReader {
	/** The saved profiles with their markers; see `readProfileCardItems`. */
	items(source: ProfileCardSource): ProfileCardItem[];
	/** Forget what was read, so the next `items` reads again (right after a use). */
	invalidate(): void;
}

/** Cheap file identity from one stat (inode, size, mtime in ns); undefined when the file cannot be statted. */
function fileSignature(path: string | undefined): string | undefined {
	if (path === undefined) return undefined;
	try {
		const stat = statSync(path, { bigint: true });
		return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
	} catch { return undefined; }
}

/** The id of the newest session-profile record on the branch: an in-memory scan, no I/O. */
function newestRecordId(session: SessionProfileSource): string {
	try {
		const branch = session.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			if (isSessionProfileFamilyEntry(branch[index])) return String((branch[index] as { id?: unknown }).id);
		}
	} catch { /* An unreadable branch is simply a different signal. */ }
	return "";
}

/**
 * The card's display reader. Strictly pure (no freeze, clear, append or write),
 * and change-driven: a visible card refreshes every second, and the session
 * file can be several MB, so each source is re-read only when its signal moved.
 *
 * Session marker. The newest session-profile record on the branch, corroborated
 * by `readSessionProfileDisk` (stateless, no writes, no cache): a bind is the
 * user's explicit choice (origin `user`) or the session's startup record
 * (origin local/repo/global), so the newest record gives the precedence; a
 * clear or no record means no profile. `resolveSessionProfile` and
 * `readSessionProfileAuthority` are NOT used: they freeze a profile or clear a
 * binding they cannot corroborate. Signal for re-reading: the session file's
 * stat signature (a profile record reaches disk only by appending, which moves
 * size and mtime), the newest profile record id on the branch (an in-memory
 * scan; a record newer than disk is not disk-corroborated yet) and the
 * in-memory binding name. A stat is one syscall regardless of file size; the
 * branch scan costs no I/O. An indeterminate read (file not flushed, record
 * newer than disk) is never cached: it falls back to the in-memory binding
 * (`readSessionProfileBinding`, a copy read) and retries on the next tick.
 *
 * profiles.json is small but is gated the same way, by its stat signature.
 */
export function createProfileCardReader(deps: ProfileCardReaderDeps = {}): ProfileCardReader {
	const readDisk = deps.readDisk ?? readSessionProfileDisk;
	const readProfiles = deps.readProfiles ?? readProfilesFileResult;
	let marker: { signal: string; name: string | undefined } | undefined;
	let profiles: { path: string; signature: string; result: ProfilesFileReadResult } | undefined;
	const readProfilesGated = (path: string): ProfilesFileReadResult => {
		const signature = fileSignature(path);
		if (signature !== undefined && profiles?.path === path && profiles.signature === signature) return profiles.result;
		const result = readProfiles(path);
		profiles = signature !== undefined && result.status === "valid" ? { path, signature, result } : undefined;
		return result;
	};
	const readMarker = (sessionId: string | undefined, session: SessionProfileSource | undefined): string | undefined => {
		const memory = readSessionProfileBinding(sessionId)?.name;
		if (session === undefined) return memory;
		let file: string | undefined;
		try { file = session.getSessionFile(); } catch { return memory; }
		const signature = fileSignature(file);
		const signal = signature === undefined ? undefined : JSON.stringify([sessionId, file, signature, newestRecordId(session), memory ?? null]);
		if (signal !== undefined && marker?.signal === signal) return marker.name;
		try {
			const disk = readDisk(session);
			if (disk.status === "indeterminate") return memory;
			const name = disk.status === "bound" ? disk.binding.name : undefined;
			marker = signal === undefined ? undefined : { signal, name };
			return name;
		} catch { return memory; }
	};
	return {
		items(source) {
			const read = readProfilesGated(profilesFilePath(source.configHome));
			if (read.status !== "valid") return [];
			const pinned = evaluateProfilePin(readProfilePinStatus(source.cwd), read.file.profiles).winner?.profile;
			return buildProfileCardItems(read.file, pinned, readMarker(source.sessionId, source.session));
		},
		invalidate() {
			marker = undefined;
			profiles = undefined;
		},
	};
}

/**
 * The saved profiles with their markers, read without side effects. Without a
 * `reader` every call reads fresh; the live card passes one shared reader.
 * A missing or invalid store shows nothing and is never seeded.
 */
export function readProfileCardItems(source: ProfileCardSource, reader: ProfileCardReader = createProfileCardReader()): ProfileCardItem[] {
	return reader.items(source);
}

// ---- Use action ----

export const PROFILE_CARD_BUSY_NOTICE = "Another profile apply is already running. Wait for it to finish, then use the profile again.";

export interface ProfileCardUseDeps {
	/** The shared single-apply gate (`beginDesktopProfileApply`); false when another apply holds it. */
	begin: () => boolean;
	end: () => void;
	notify: (message: string, level: "info" | "warning") => void;
	/** The owner's "Use in this session" action for one profile, with its own dialog and notices. */
	run: (name: string) => Promise<void>;
	/** Re-read the card's items so the markers reflect the outcome. */
	refresh: () => void;
}

/**
 * The card's use handler: runs the owner action under the shared apply gate. A
 * busy gate applies nothing and says so; a failing action is notified, never
 * thrown into the TUI; the gate is always released and the markers refreshed.
 */
export function createProfileCardUseHandler(deps: ProfileCardUseDeps): ProfileCardUseHandler {
	return async (name) => {
		if (!deps.begin()) {
			deps.notify(PROFILE_CARD_BUSY_NOTICE, "info");
			return;
		}
		try {
			await deps.run(name);
		} catch (error) {
			deps.notify(`Could not use profile "${name}" in this session: ${error instanceof Error ? error.message : String(error)}`, "warning");
		} finally {
			deps.end();
			try { deps.refresh(); } catch { /* A failed re-read keeps the markers on screen. */ }
		}
	};
}

// ---- Keyboard shortcuts ----

export const PROFILE_CARD_HIDDEN_NOTICE = "The profile card is hidden. Turn it on with /gentle:profiles card on.";
export const PROFILE_CARD_EMPTY_NOTICE = "The profile card has no saved profiles. Create one in /gentle:profiles.";

/**
 * One shortcut press. A hidden card or an empty list changes nothing and says
 * why in a single info notice; otherwise previous/next move the shown profile
 * (the owner repaints the rail) and use runs the same handler a click runs.
 */
export function runProfileCardShortcut(owner: ProfileCardOwner, action: ProfileCardAction, notify: (message: string, level: "info") => void): void {
	if (!owner.visible()) { notify(PROFILE_CARD_HIDDEN_NOTICE, "info"); return; }
	if (owner.items().length === 0) { notify(PROFILE_CARD_EMPTY_NOTICE, "info"); return; }
	runProfileCardAction(owner, action);
}

const PROFILE_CARD_SHORTCUTS: ReadonlyArray<{ id: string; action: ProfileCardAction; description: string }> = [
	{ id: "profileCard.previous", action: "previous", description: "Show the previous profile on the profile card" },
	{ id: "profileCard.next", action: "next", description: "Show the next profile on the profile card" },
	{ id: "profileCard.use", action: "use", description: "Use the profile shown on the profile card in this session" },
];

/**
 * Register the card's shortcuts on the key each `KEYMAP_ACTIONS` entry resolves
 * to (environment variable, then saved keymaps.json, then default; "off" or
 * empty leaves one unregistered). Called where the owner lives, with the same
 * `effectiveKey` resolution every Gentle shortcut uses.
 */
export function registerProfileCardShortcuts(pi: Pick<ExtensionAPI, "registerShortcut">, owner: ProfileCardOwner, env: NodeJS.ProcessEnv, bindings: KeymapBindings): void {
	// Minimal hosts (and test doubles) have no shortcut registry.
	if (typeof pi.registerShortcut !== "function") return;
	for (const shortcut of PROFILE_CARD_SHORTCUTS) {
		const key = effectiveKey(shortcut.id, env, bindings);
		if (!key) continue;
		pi.registerShortcut(key as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: shortcut.description,
			handler: (ctx: ExtensionContext) => runProfileCardShortcut(owner, shortcut.action, (message, level) => ctx.ui.notify(message, level)),
		});
	}
}
