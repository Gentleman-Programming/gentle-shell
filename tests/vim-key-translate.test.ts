import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { installVimKeyTranslation } from "../lib/vim-key-translate.ts";

// The global key translation layer: while some component other than the
// prompt editor holds focus (a Pi picker, an fzf-style list, a search box),
// ctrl+hjkl moves like the arrows and ctrl+u/d pages. The bare terminal
// bytes of ctrl+h (backspace) and ctrl+j (Enter) always keep their meaning.

function fakeTui() {
	const state: { listener: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined; focused: Array<object | null> } = { listener: undefined, focused: [] };
	const tui = {
		terminal: {},
		setFocus(component: object | null) { state.focused.push(component); },
		getFocusedComponent() { return state.focused[state.focused.length - 1] ?? null; },
		addInputListener(next: typeof state.listener) { state.listener = next; return () => { state.listener = undefined; }; },
		requestRender() {},
	} as unknown as TUI;
	return { tui, state };
}

test("ctrl+hjkl translate to arrows while a picker holds focus", () => {
	const { tui, state } = fakeTui();
	const dispose = installVimKeyTranslation(tui, { promptFocused: () => false });
	assert.deepEqual(state.listener!("\x1b[104;5u"), { data: "\x1b[D" }, "ctrl+h moves left");
	assert.deepEqual(state.listener!("\x1b[106;5u"), { data: "\x1b[B" }, "ctrl+j moves down");
	assert.deepEqual(state.listener!("\x1b[107;5u"), { data: "\x1b[A" }, "ctrl+k moves up");
	assert.deepEqual(state.listener!("\x1b[108;5u"), { data: "\x1b[C" }, "ctrl+l moves right");
	assert.deepEqual(state.listener!("\x0b"), { data: "\x1b[A" }, "the bare ctrl+k byte moves up");
	assert.deepEqual(state.listener!("\x1b[107;5:2u"), { data: "\x1b[A" }, "key repeats translate so holding scrolls like an arrow");
	assert.deepEqual(state.listener!("\x0c"), { data: "\x1b[C" }, "the bare ctrl+l byte moves right");
	dispose();
});

test("previous behavior holds: backspace and Enter bytes pass through and the prompt keeps its keys", () => {
	const { tui, state } = fakeTui();
	let promptFocused = true;
	const dispose = installVimKeyTranslation(tui, { promptFocused: () => promptFocused });
	assert.equal(state.listener!("\b"), undefined, "the ctrl+h byte is backspace and passes through");
	assert.equal(state.listener!("\n"), undefined, "the ctrl+j byte is Enter and passes through");
	assert.equal(state.listener!("\x1b[104;5u"), undefined, "nothing translates while the prompt has focus");
	assert.equal(state.listener!("\x0b"), undefined, "ctrl+k keeps its prompt meaning while editing");
	promptFocused = false;
	assert.equal(state.listener!("\x1b[106;5:3u"), undefined, "key releases pass through untranslated: one move per tap, not two");
	assert.equal(state.listener!("\x1b[107;5:3u"), undefined, "key releases pass through for every translated key");
	assert.equal(state.listener!("\x15"), undefined, "ctrl+u stays with the menus that own it (palette clear-query)");
	assert.equal(state.listener!("\x04"), undefined, "ctrl+d stays with the menus that own it");
	assert.equal(state.listener!("a"), undefined, "plain letters fall through to type text");
	assert.equal(state.listener!("\x1b[B"), undefined, "real arrows are never rewritten");
	dispose();
	assert.equal(state.listener, undefined, "dispose removes the listener");
	assert.doesNotThrow(() => installVimKeyTranslation({ terminal: {} } as TUI, { promptFocused: () => false }), "previous behavior holds: hosts without input listeners stay inert");
});

test("a focused view that owns ctrl+j/k paging receives them untranslated", () => {
	const { tui, state } = fakeTui();
	const dispose = installVimKeyTranslation(tui, { promptFocused: () => false });
	state.focused.push({ ownsVimScrollKeys: true });
	assert.equal(state.listener!("\x1b[106;5u"), undefined, "ctrl+j reaches the view's page-down");
	assert.equal(state.listener!("\x1b[107;5u"), undefined, "ctrl+k reaches the view's page-up");
	assert.equal(state.listener!("\x0b"), undefined, "the bare ctrl+k byte reaches the view too");
	assert.deepEqual(state.listener!("\x1b[104;5u"), { data: "\x1b[D" }, "ctrl+h still translates");
	assert.deepEqual(state.listener!("\x0c"), { data: "\x1b[C" }, "ctrl+l still translates");
	state.focused.push({});
	assert.deepEqual(state.listener!("\x0b"), { data: "\x1b[A" }, "previous behavior holds: other pickers still get the arrow");
	dispose();
});

test("no translation while the prompt is unknown (no Gentle prompt, or a foreign editor)", () => {
	const { tui, state } = fakeTui();
	const dispose = installVimKeyTranslation(tui, { promptFocused: () => undefined });
	assert.equal(state.listener!("\x0b"), undefined, "ctrl+k stays the editor's kill-line");
	assert.equal(state.listener!("\x1b[104;5u"), undefined, "Kitty ctrl+h stays with the editor");
	dispose();
});
