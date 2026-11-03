import { isKeyRelease, matchesKey, type TUI } from "@earendil-works/pi-tui";

// The global key translation layer for vim-everywhere: while some component
// other than the prompt editor holds focus — a Pi picker, an fzf-style list,
// a search box — ctrl+hjkl moves like the arrows, so every list in the
// interface is reachable from the home row. Pi's own pickers understand
// the synthesized sequences; no Pi code is touched.
//
// Terminal bytes decide what is safe to translate. The bare bytes of ctrl+h
// (0x08) and ctrl+j (0x0a) are indistinguishable from Backspace and Enter,
// so they always keep their terminal meaning; only their unambiguous forms
// (Kitty/CSI-u, e.g. "\x1b[104;5u") translate. The bare ctrl+k (0x0b) and
// ctrl+l (0x0c) bytes are unambiguous and translate everywhere. Key releases
// (Kitty event type 3) never translate: matching them too would move twice per
// tap (press and release); repeats (event type 2) translate so holding a key
// scrolls exactly like holding an arrow. ctrl+u and ctrl+d are never
// translated: menus own them (the command palette clears its query with
// ctrl+u), the same readline conventions their inputs follow.

const ARROWS = {
	"ctrl+h": "\x1b[D",
	"ctrl+j": "\x1b[B",
	"ctrl+k": "\x1b[A",
	"ctrl+l": "\x1b[C",
} as const;

/** Bare bytes that are also Backspace and Enter: never rewritten. */
const RESERVED_BARE_BYTES = new Set(["\b", "\n"]);

/**
 * Views that page with ctrl+j/k (Agents thread, Changes diff) declare
 * `ownsVimScrollKeys`; while one holds focus those two keys reach it
 * untranslated. ctrl+h/l still translate.
 */
export interface VimScrollKeyOwner {
	readonly ownsVimScrollKeys?: boolean;
}

export interface VimKeyTranslationOptions {
	/**
	 * True while the prompt editor holds focus: its ctrl+h/ctrl+j meanings survive.
	 * Undefined means the prompt is unknown (not created yet, or a foreign editor
	 * owns it); an editor may hold focus, so nothing translates.
	 */
	promptFocused(): boolean | undefined;
}

function focusOwnsScrollKeys(tui: TUI): boolean {
	// getFocusedComponent is not in every pi-tui TUI typing; read it structurally.
	const focused = (tui as { getFocusedComponent?: () => unknown }).getFocusedComponent?.();
	return (focused as VimScrollKeyOwner | null | undefined)?.ownsVimScrollKeys === true;
}

/**
 * Install the translation as one global input listener. The returned function
 * removes it. Hosts without input listeners (minimal extension hosts, test
 * fakes) stay inert.
 */
export function installVimKeyTranslation(tui: TUI, options: VimKeyTranslationOptions): () => void {
	if (!tui.terminal || typeof tui.addInputListener !== "function") return () => {};
	return tui.addInputListener((data) => {
		if (options.promptFocused() !== false || RESERVED_BARE_BYTES.has(data) || isKeyRelease(data)) return undefined;
		const ownsScroll = focusOwnsScrollKeys(tui);
		for (const [name, arrow] of Object.entries(ARROWS) as Array<[keyof typeof ARROWS, string]>) {
			if (ownsScroll && (name === "ctrl+j" || name === "ctrl+k")) continue;
			if (matchesKey(data, name)) return { data: arrow };
		}
		return undefined;
	});
}
