import { isKeyRelease, matchesKey, type TUI } from "@earendil-works/pi-tui";

/** The key-name union pi-tui's matcher accepts. */
type KeyName = Parameters<typeof matchesKey>[1];

// The global key translation layer for vim-everywhere: while some component
// other than the prompt editor holds focus — a Pi picker, an fzf-style list,
// a search box — ctrl+hjkl moves like the arrows and ctrl+u/d pages, so
// every list in the interface is reachable from the home row. Pi's own
// pickers understand the synthesized sequences; no Pi code is touched.
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

const ARROW_LEFT = "\x1b[D";
const ARROW_DOWN = "\x1b[B";
const ARROW_UP = "\x1b[A";
const ARROW_RIGHT = "\x1b[C";

const TRANSLATIONS: ReadonlyArray<readonly [KeyName, string]> = [
	["ctrl+h", ARROW_LEFT],
	["ctrl+j", ARROW_DOWN],
	["ctrl+k", ARROW_UP],
	["ctrl+l", ARROW_RIGHT],
];

/** Escape sequences whose bare bytes must never be rewritten. */
const RESERVED_BARE_BYTES = new Set(["\b", "\n"]);

export interface VimKeyTranslationOptions {
	/** True while the prompt editor holds focus: its ctrl+h/ctrl+j meanings survive. */
	promptFocused(): boolean;
}

/**
 * Install the translation as one global input listener. The returned function
 * removes it. Hosts without input listeners (minimal extension hosts, test
 * fakes) stay inert.
 */
export function installVimKeyTranslation(tui: TUI, options: VimKeyTranslationOptions): () => void {
	if (!tui.terminal || typeof tui.addInputListener !== "function") return () => {};
	return tui.addInputListener((data) => {
		if (options.promptFocused()) return undefined;
		if (RESERVED_BARE_BYTES.has(data)) return undefined;
		if (isKeyRelease(data)) return undefined;
		for (const [name, sequence] of TRANSLATIONS) {
			if (matchesKey(data, name)) return { data: sequence };
		}
		return undefined;
	});
}
