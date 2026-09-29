import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { GentlePromptEditor } from "../extensions/gentle-shell.ts";
import { SelectionEngine } from "../lib/selection-engine.ts";
import { decodePrintableKey } from "../lib/pi-tui-keys.ts";

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

// --- Focused terminal-key decode + undo-transaction coverage (review round 2):
// the extension-era suites were replaced by the native engine, so these pin the
// contracts the review explicitly named: kitty press/repeat/release filtering,
// CSI-u DEL/C1 delete-only replacement, and exactly-one-undo replacement.

const KITTY_A_PRESS = "\x1b[97;1:1u"; // 'a', kitty flag 2, press
const KITTY_A_RELEASE = "\x1b[97;1:3u"; // 'a', kitty flag 2, release

test("kitty CSI-u press replaces the selection; release is dropped and keeps it", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("hello");
	editor.handleInput(END);
	engine.handleInput(SHIFT_HOME, native);
	engine.handleInput(KITTY_A_RELEASE, native);
	assert.equal(editor.getText(), "hello");
	assert.deepEqual(engine.anchor, { line: 0, col: 5 });
	engine.handleInput(KITTY_A_PRESS, native);
	assert.equal(editor.getText(), "a");
	assert.deepEqual(cursorOf(editor), { line: 0, col: 1 });
});

test("repeated shift+home at the line edge keeps the selection", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("hello");
	editor.handleInput(END);
	engine.handleInput(SHIFT_HOME, native);
	engine.handleInput(SHIFT_HOME, native);
	assert.notEqual(engine.anchor, null);
	assert.equal(engine.selectionLength(), 5);
});

test("modifyOtherKeys: printable decodes; ctrl-modified and control codepoints are rejected", () => {
	assert.equal(decodePrintableKey("\x1b[27;1;97~"), "a");
	assert.equal(decodePrintableKey("\x1b[27;5;97~"), undefined);
	assert.equal(decodePrintableKey("\x1b[27;1;27~"), undefined);
});

test("CSI-u DEL and C1 codepoints replace the selection with a pure delete", () => {
	for (const data of ["\x1b[27;1;127~", "\x1b[27;1;155~"]) {
		const editor = makeEditor();
		const engine = new SelectionEngine(editor);
		const native = (d: string) => editor.handleInput(d);
		editor.setText("hi");
		editor.handleInput(END);
		engine.handleInput(SHIFT_HOME, native);
		engine.handleInput(data, native);
		assert.equal(editor.getText(), "", `control byte from ${JSON.stringify(data)} must not be inserted`);
	}
});

test("bracketed paste replaces a multiline interior selection and restores it with one undo", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("prefix old\ntext suffix");
	editor.handleInput(HOME);
	engine.handleInput(SHIFT_END, native);
	engine.handleInput("\x1b[200~new\nlines\x1b[201~", native);
	assert.equal(editor.getText(), "prefix old\nnew\nlines");
	(editor as unknown as { undo(): void }).undo();
	assert.equal(editor.getText(), "prefix old\ntext suffix");
});

test("printable replacement is exactly one undo transaction", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("hello world");
	editor.handleInput(END);
	engine.handleInput(SHIFT_HOME, native);
	const internals = editor as unknown as { pushUndoSnapshot(): void };
	const original = internals.pushUndoSnapshot.bind(editor);
	let snapshots = 0;
	internals.pushUndoSnapshot = () => {
		snapshots += 1;
		original();
	};
	engine.handleInput("x", native);
	assert.equal(editor.getText(), "x");
	assert.equal(snapshots, 1);
});

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_INCOMPLETE_PASTE_BYTES = 16 * 1024 * 1024;

test("bracketed paste terminator split across six single-byte chunks still completes the paste", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("prefix old\ntext suffix");
	editor.handleInput(HOME);
	engine.handleInput(SHIFT_END, native);
	engine.handleInput(PASTE_START, native);
	engine.handleInput("new\nlines", native);
	for (const byte of PASTE_END) engine.handleInput(byte, native);
	assert.equal(editor.getText(), "prefix old\nnew\nlines");
	(editor as unknown as { undo(): void }).undo();
	assert.equal(editor.getText(), "prefix old\ntext suffix");
});

test("an incomplete bracketed paste that crosses the 16 MiB bound without a terminator is abandoned, never forwarded to native", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("hello");
	engine.handleInput(ALT_A, native);
	engine.handleInput(PASTE_START, native);
	const payload = "z".repeat(MAX_INCOMPLETE_PASTE_BYTES - PASTE_START.length + 1);
	engine.handleInput(payload, native);
	assert.equal(editor.getText(), "hello", "no partial paste bytes are ever forwarded to the native editor");
	engine.handleInput("x", native);
	assert.equal(editor.getText(), "x", "input after abandonment behaves like a fresh keystroke over the still-active selection");
});

test("the 16 MiB incomplete-frame bound counts UTF-8 bytes, not UTF-16 code units", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("hello");
	engine.handleInput(ALT_A, native);
	engine.handleInput(PASTE_START, native);
	// "é" is one UTF-16 code unit but two UTF-8 bytes: 10M code units is under
	// the 16 MiB code-unit count but 20 MB in UTF-8 bytes, over the bound.
	const payload = "é".repeat(10 * 1024 * 1024);
	engine.handleInput(payload, native);
	assert.equal(editor.getText(), "hello", "a multibyte payload under 16M code units but over 16 MiB in UTF-8 bytes must still be abandoned");
	engine.handleInput("x", native);
	assert.equal(editor.getText(), "x");
});

test("many-chunk bracketed paste never rescans the full accumulated buffer for the terminator", () => {
	const editor = makeEditor();
	const engine = new SelectionEngine(editor);
	const native = (d: string) => editor.handleInput(d);
	editor.setText("hello");
	engine.handleInput(ALT_A, native);
	const chunkCount = 1500; // > 1000 chars so the host editor collapses it into its own marker
	// Deterministic regression check (avoids flaky wall-clock timing on slow/CI
	// hardware): instrument String.prototype.indexOf while chunks are buffered
	// and record the length of every string searched for PASTE_END. A
	// full-buffer rescan (the pre-fix O(n^2) bug) would search a string that
	// grows with every chunk; the tail-bounded scan only ever searches
	// `pasteTail + <this chunk>`, so its length stays bounded regardless of how
	// many chunks were already buffered.
	const originalIndexOf = String.prototype.indexOf;
	const searchedLengths: number[] = [];
	// biome-ignore lint: intentional prototype patch, restored in `finally` below.
	String.prototype.indexOf = function (this: string, searchString: string, position?: number): number {
		if (searchString === PASTE_END) searchedLengths.push(this.length);
		return originalIndexOf.call(this, searchString, position);
	};
	try {
		engine.handleInput(PASTE_START, native);
		for (let i = 0; i < chunkCount; i++) engine.handleInput("z", native);
		engine.handleInput(PASTE_END, native);
	} finally {
		String.prototype.indexOf = originalIndexOf;
	}
	assert.match(editor.getText(), /^\[paste #1 \d+ chars\]$/, "the oversized paste still completed (collapsed into the host editor's own marker)");
	// Bound: PASTE_END tail carry (5 chars) + the largest single chunk sent
	// here (the 6-char PASTE_END chunk itself) = 11 chars, never the ~1500+
	// char accumulated buffer a full-buffer rescan would search. The final
	// `native(frame)` call hands the fully assembled frame to the underlying
	// host editor exactly once, and that editor's own paste handling does its
	// own one-time scan over the assembled length — a single unavoidable O(final
	// length) cost outside SelectionEngine, not a per-chunk rescan; exactly one
	// such large search is tolerated below.
	const smallSearches = searchedLengths.filter((len) => len <= 11);
	const largeSearches = searchedLengths.filter((len) => len > 11);
	assert.equal(
		smallSearches.length,
		chunkCount + 2,
		`expected exactly one tail-bounded terminator search per input chunk (start + ${chunkCount} z's + end), saw ${smallSearches.length}`,
	);
	assert.ok(
		largeSearches.length <= 1,
		`expected at most one full-frame scan (the host editor's own one-time assembled-paste handling), saw ${largeSearches.length} large searches (lengths: ${largeSearches.join(", ")}) — a full-buffer rescan during chunk intake regressed`,
	);
});
