import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { GentlePromptEditor } from "../extensions/gentle-shell.ts";
import { SelectionEngine } from "../lib/selection-engine.ts";

// Native selection engine tests: drive a real CustomEditor through the
// SelectionEngine the same way GentlePromptEditor wires it — engine.handleInput
// in front, native dispatch back into the editor. Covers the ported contract:
// shift+home/end selection, replace-on-delete, alt+a select all, collapse on
// movement, zero-width no-op at the edge, highlight + hint rendering, and
// degraded passthrough.

type CtorParams = ConstructorParameters<typeof CustomEditor>;

function makeEditor(): CustomEditor {
	const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => {} } as unknown as CtorParams[0];
	const theme = { borderColor: (s: string) => s, selectList: {} } as unknown as CtorParams[1];
	const kb = { matches: () => false } as unknown as CtorParams[2];
	const editor = new CustomEditor(tui, theme, kb);
	(editor as unknown as { focused: boolean }).focused = true;
	return editor;
}

const END = "\x1b[F";
const HOME = "\x1b[H";
const SHIFT_HOME = "\x1b[1;2H";
const SHIFT_END = "\x1b[1;2F";
const RIGHT = "\x1b[C";
const DEL = "\x1b[3~";
const BACKSPACE = "\x7f";
const ALT_A = "\x1ba";

function cursorOf(editor: CustomEditor): { line: number; col: number } {
	return (editor as unknown as { getCursor(): { line: number; col: number } }).getCursor();
}

test("shift+home selects to line start; delete replaces the selection atomically", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("hello world");
	editor.handleInput(END);
	engine.handleInput(SHIFT_HOME, native);
	assert.equal(cursorOf(editor).col, 0);
	engine.handleInput(DEL, native);
	assert.equal(editor.getText(), "");
});

test("alt+a selects all; backspace replaces the whole text", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("abc\ndef");
	engine.handleInput(ALT_A, native);
	engine.handleInput(BACKSPACE, native);
	assert.equal(editor.getText(), "");
	assert.equal(cursorOf(editor).line, 0);
});

test("movement collapses the selection; later delete behaves natively", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("hello");
	editor.handleInput(END);
	engine.handleInput(SHIFT_HOME, native);
	engine.handleInput(RIGHT, native);
	engine.handleInput(DEL, native);
	assert.equal(editor.getText(), "hllo");
});

test("shift+end at line end: zero-width selection, delete is a no-op", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("hi");
	editor.handleInput(END);
	engine.handleInput(SHIFT_END, native);
	engine.handleInput(DEL, native);
	assert.equal(editor.getText(), "hi");
});

test("render wraps the selected span in reverse video and shows the hint", () => {
	const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => {} } as unknown as CtorParams[0];
	const theme = { borderColor: (s: string) => s, selectList: {} } as unknown as CtorParams[1];
	const kb = { matches: () => false } as unknown as CtorParams[2];
	const editor = new GentlePromptEditor(tui, theme, kb, {
		fg: (_color, text) => text,
		bold: (text) => text,
		requestRender: () => {},
		pending: () => false,
		now: () => Date.now(),
		doubleEscCancelEnabled: () => false,
		dispatchQueuedText: () => {},
	});
	(editor as unknown as { focused: boolean }).focused = true;
	const engine = (editor as unknown as { selectionEngine: SelectionEngine }).selectionEngine;
	const native = (d: string) => editor.handleInput(d);
	editor.setText("hello world");
	editor.handleInput(END);
	engine.handleInput(SHIFT_HOME, native);
	const rows = editor.render(80);
	const content = rows[1] ?? "";
	assert.ok(content.includes("\x1b[7m"), "reverse-video span missing");
	const last = rows[rows.length - 1] ?? "";
	assert.ok(last.includes("chars selected"), "selection hint missing on the bottom rule");
});

test("degraded host: pure passthrough, no selection behavior", () => {
	const minimal = {
		getText: () => "",
		setText: (_text: string) => {},
		handleInput: (_data: string) => {},
		render: (_width: number) => [] as string[],
		invalidate: () => {},
	} as unknown as CustomEditor;
	const engine = new SelectionEngine(minimal);
	assert.equal(engine.degraded, true);
	let nativeSeen = "";
	engine.handleInput(SHIFT_HOME, (d) => {
		nativeSeen = d;
	});
	assert.equal(nativeSeen, SHIFT_HOME);
	assert.equal(engine.anchor, null);
});
