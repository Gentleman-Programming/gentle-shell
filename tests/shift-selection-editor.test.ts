/**
 * Behavioral tests for SelectingEditor, ported from the tmp-scope harness (tmp/harness.ts)
 * onto node:test. Drives the landed extensions/shift-selection-extension/index.ts through handleInput with
 * real terminal byte sequences and asserts the behavior contract; render-level assertions
 * cover the reverse-video highlight and the bottom-border hint.
 */
import { describe, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { missingEditorInternals, SelectingEditor } from "../extensions/shift-selection-extension/index.ts";
import assert from "node:assert/strict";

// Minimal bun-style expect over node:assert so the ported suite stays 1:1
// with the original bun:test sources.
function expect(actual: unknown): {
	toBe: (expected: unknown) => void;
	toEqual: (expected: unknown) => void;
	toContain: (fragment: string) => void;
	toBeNull: () => void;
	toBeUndefined: () => void;
	toBeDefined: () => void;
	toHaveLength: (length: number) => void;
	toBeGreaterThan: (minimum: number) => void;
	toBeGreaterThanOrEqual: (minimum: number) => void;
	not: {
		toBe: (expected: unknown) => void;
		toEqual: (expected: unknown) => void;
		toContain: (fragment: string) => void;
		toBeNull: () => void;
		toThrow: () => void;
	};
} {
	const check = (positive: boolean) => ({
		toBe: (expected: unknown) => {
			if (positive) assert.strictEqual(actual, expected);
			else assert.notStrictEqual(actual, expected);
		},
		toEqual: (expected: unknown) => {
			if (positive) assert.deepStrictEqual(actual, expected);
			else assert.notDeepStrictEqual(actual, expected);
		},
		toContain: (fragment: string) => {
			const hit = Array.isArray(actual)
				? actual.includes(fragment as unknown as never)
				: typeof actual === "string" && actual.includes(fragment);
			const message = `expected ${JSON.stringify(actual)} ${positive ? "to contain" : "not to contain"} ${JSON.stringify(fragment)}`;
			assert.ok(positive ? hit : !hit, message);
		},
		toBeNull: () => {
			if (positive) assert.strictEqual(actual, null);
			else assert.notStrictEqual(actual, null);
		},
		toBeUndefined: () => {
			if (positive) assert.strictEqual(actual, undefined);
			else assert.notStrictEqual(actual, undefined);
		},
		toBeDefined: () => {
			if (positive) assert.notStrictEqual(actual, undefined);
			else assert.strictEqual(actual, undefined);
		},
		toHaveLength: (length: number) => {
			const actualLength = (actual as unknown as { length?: number })?.length;
			const message = `expected length ${String(actualLength)} ${positive ? "to be" : "not to be"} ${length}`;
			assert.ok(positive ? actualLength === length : actualLength !== length, message);
		},
		toBeGreaterThanOrEqual: (minimum: number) => {
			const hit = typeof actual === "number" && actual >= minimum;
			assert.ok(positive ? hit : !hit, `expected ${String(actual)} to be at least ${minimum}`);
		},
		toBeGreaterThan: (minimum: number) => {
			const hit = typeof actual === "number" && actual > minimum;
			assert.ok(positive ? hit : !hit, `expected ${String(actual)} to be greater than ${minimum}`);
		},
	});
	const positive = check(true);
	return {
		...positive,
		not: {
			...check(false),
			toThrow: () => {
				assert.doesNotThrow(() => (actual as unknown as () => void)());
			},
		},
	};
}



type CtorParams = ConstructorParameters<typeof SelectingEditor>;

function makeEditor(opts?: { paddingX?: number }): SelectingEditor {
	const tui = { terminal: { rows: 30, columns: 100 }, requestRender: () => {} } as unknown as CtorParams[0];
	const theme = { borderColor: (s: string) => s, selectList: {} } as unknown as CtorParams[1];
	const kb = { matches: () => false } as unknown as CtorParams[2];
	const inst = new SelectingEditor(tui, theme, kb, opts);
	(inst as unknown as { focused: boolean }).focused = true;
	return inst;
}

interface Priv {
	anchor: { line: number; col: number } | null;
	autocompleteState: string | null;
}
const priv = (inst: SelectingEditor): Priv => inst as unknown as Priv;

const SHIFT_HOME = "\x1b[1;2H";
const SHIFT_HOME_LEGACY = "\x1b[7$";
const SHIFT_END = "\x1b[1;2F";
const SHIFT_END_LEGACY = "\x1b[8$";
const HOME = "\x1b[H";
const END = "\x1b[F";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";
const DEL = "\x1b[3~";
const ENTER = "\r";
const UNDO = "\x1f";
const CTRL_A = "\x01";
const CTRL_E = "\x05";
const CTRL_U = "\x15";
const CTRL_K = "\x0b";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const ESC = "\x1b";
const KITTY_X = "\x1b[120u"; // Kitty CSI-u printable 'x'
const KITTY_REPEAT_SHIFT_HOME = "\x1b[1;2:2H"; // Kitty flag 2: shift+home REPEAT
const KITTY_RELEASE_SHIFT_END = "\x1b[1;2:3F"; // Kitty flag 2: shift+end RELEASE
const KITTY_RELEASE_A = "\x1b[97;1:3u"; // Kitty flag 2: 'a' RELEASE
const KITTY_REPEAT_X = "\x1b[120;1:2u"; // Kitty flag 2: 'x' REPEAT
const KITTY_SHIFT_BACKSPACE = "\x1b[127;2u"; // Kitty flag 2: shift+backspace press
const KITTY_RELEASE_SHIFT_BACKSPACE = "\x1b[127;2:3u"; // Kitty flag 2: shift+backspace RELEASE
const KITTY_SHIFT_DELETE = "\x1b[3;2~"; // Kitty functional form: shift+delete press
const KITTY_PRESS_SHIFT_HOME = "\x1b[1;2:1H"; // Kitty flag 2: shift+home PRESS (explicit event type)
const KITTY_EMOJI = "\x1b[127751u"; // Kitty CSI-u printable U+1F307 (surrogate pair when decoded)
const ALT_A = "\x1ba";

/**
 * Shared selection setup for the replace-selection tests: select [0, col) through real keys —
 * HOME, then col × RIGHT (cursor walks forward to col), then SHIFT_HOME (anchor parks at
 * col, cursor returns to 0).
 */
function selectFromCol(inst: SelectingEditor, col: number): void {
	inst.handleInput(HOME);
	for (let i = 0; i < col; i++) inst.handleInput(RIGHT);
	inst.handleInput(SHIFT_HOME);
}

describe("SelectingEditor", () => {
	test("shift+home selects to col 0, backspace replaces, one undo restores text+cursor", () => {
		const inst = makeEditor();
		inst.setText("hello world");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		expect(inst.getCursor().col).toBe(0);
		expect(inst.render(80).join("\n")).toContain("11 chars selected - Del deletes - Alt+a select all");
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("");
		expect(inst.getCursor().line).toBe(0);
		expect(inst.getCursor().col).toBe(0);
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("hello world");
		expect(inst.getCursor().col).toBe(0);
	});

	test("shift+home then shift+end extends original position to EOL; typing replaces", () => {
		const inst = makeEditor();
		inst.setText("hello world");
		inst.handleInput(LEFT);
		inst.handleInput(LEFT);
		inst.handleInput(LEFT);
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(SHIFT_END);
		expect(priv(inst).anchor).not.toBeNull();
		inst.handleInput("X");
		expect(inst.getText()).toBe("hello woX");
	});

	test("arrow movement collapses selection without deleting", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(LEFT);
		inst.handleInput(LEFT);
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(RIGHT);
		expect(priv(inst).anchor).toBeNull();
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("ello");
	});

	test("up movement collapses; hint disappears from render", () => {
		const inst = makeEditor();
		inst.setText("abc");
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(UP);
		expect(priv(inst).anchor).toBeNull();
		expect(inst.render(80).join("\n")).not.toContain("selected");
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("abc");
	});

	test("enter with active selection submits collapsed (not deleted)", () => {
		const inst = makeEditor();
		let submitted: string | null = null;
		(inst as unknown as { onSubmit?: (t: string) => void }).onSubmit = (text) => {
			submitted = text;
		};
		inst.setText("abc");
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(ENTER);
		expect(submitted).toBe("abc");
		expect(priv(inst).anchor).toBeNull();
	});

	test("forward delete replaces selection", () => {
		const inst = makeEditor();
		inst.setText("hello");
		selectFromCol(inst, 2);
		inst.handleInput(DEL);
		expect(inst.getText()).toBe("llo");
		expect(inst.getCursor().col).toBe(0);
	});

	test("printable char replaces selection", () => {
		const inst = makeEditor();
		inst.setText("hello");
		selectFromCol(inst, 2);
		inst.handleInput("Z");
		expect(inst.getText()).toBe("Zllo");
	});

	test("raw non-ASCII keystroke (é) replaces selection on terminals without kitty/modifyOtherKeys", () => {
		const inst = makeEditor();
		inst.setText("hello");
		selectFromCol(inst, 2);
		// "é" is one UTF-16 code unit (U+00E9) arriving as raw terminal bytes — no CSI-u
		// wrapper — so the raw printable fallback must treat it as a replace key.
		inst.handleInput("é");
		expect(inst.getText()).toBe("éllo");
		expect(inst.getCursor().col).toBe(1);
		expect(priv(inst).anchor).toBeNull();
		// One undo restores the pre-replacement text (text AND cursor snapshot).
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("hello");
	});

	test("kitty CSI-u printable replaces selection", () => {
		const inst = makeEditor();
		inst.setText("hello");
		selectFromCol(inst, 2);
		inst.handleInput(KITTY_X);
		expect(inst.getText()).toBe("xllo");
	});

	test("kitty shift+home repeat at the edge keeps the selection", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(KITTY_REPEAT_SHIFT_HOME);
		expect(priv(inst).anchor).not.toBeNull();
		expect(inst.render(80).join("\n")).toContain("5 chars selected");
	});

	test("kitty shift+end release is a no-op (selection and cursor unchanged)", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(KITTY_RELEASE_SHIFT_END);
		expect(priv(inst).anchor).not.toBeNull();
		expect(inst.getCursor().col).toBe(0);
	});

	test("kitty printable release with active selection does not edit or collapse", () => {
		const inst = makeEditor();
		inst.setText("hello");
		selectFromCol(inst, 2);
		inst.handleInput(KITTY_RELEASE_A);
		expect(inst.getText()).toBe("hello");
		expect(priv(inst).anchor).not.toBeNull();
	});

	test("kitty printable repeat replaces the selection", () => {
		const inst = makeEditor();
		inst.setText("hello");
		selectFromCol(inst, 2);
		inst.handleInput(KITTY_REPEAT_X);
		expect(inst.getText()).toBe("xllo");
		expect(priv(inst).anchor).toBeNull();
	});

	test("repeated shift+home press at the edge keeps the selection", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(SHIFT_HOME);
		expect(priv(inst).anchor).not.toBeNull();
		expect(inst.render(80).join("\n")).toContain("5 chars selected");
	});

	test("replacement is one undo transaction restoring text and pre-replacement cursor", () => {
		const inst = makeEditor();
		inst.setText("hello"); // setText places the cursor at the end
		inst.handleInput(HOME);
		inst.handleInput(RIGHT);
		inst.handleInput(RIGHT); // cursor {0,2}
		// Span [0,2) with the cursor at the right endpoint; the anchor is set directly because
		// no key flow parks the cursor inside a span. Undo restores the push-time state, so a
		// single undo must bring back the text AND the pre-replacement cursor (col 2).
		priv(inst).anchor = { line: 0, col: 0 };
		inst.handleInput("Z");
		expect(inst.getText()).toBe("Zllo");
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("hello");
		expect(inst.getCursor().col).toBe(2);
	});

	test("space replacement is one undo transaction", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(ALT_A);
		inst.handleInput(" ");
		expect(inst.getText()).toBe(" ");
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("hello");
	});

	test("empty editor: shift+home/end, backspace, delete are safe no-ops", () => {
		const inst = makeEditor();
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(SHIFT_END);
		inst.handleInput(BACKSPACE);
		inst.handleInput(DEL);
		inst.handleInput(SHIFT_HOME_LEGACY);
		expect(inst.getText()).toBe("");
		expect(inst.getCursor().line).toBe(0);
		expect(inst.getCursor().col).toBe(0);
		expect(() => inst.render(80)).not.toThrow();
	});

	test("legacy encodings (ESC[7$/ESC[8$) work as shift+home/end", () => {
		const inst = makeEditor();
		inst.setText("hi");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME_LEGACY);
		expect(inst.getCursor().col).toBe(0);
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("");
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("hi");
	});

	test("shift+end at EOL collapses immediately (eager empty-selection collapse)", () => {
		const inst = makeEditor();
		inst.setText("abc");
		inst.handleInput(END);
		inst.handleInput(SHIFT_END_LEGACY);
		expect(priv(inst).anchor).toBeNull();
		expect(inst.render(80).join("\n")).not.toContain("selected");
	});

	test("multi-line: select within a line and delete", () => {
		const inst = makeEditor();
		inst.setText("abc\ndef\nghi");
		inst.handleInput(LEFT);
		inst.handleInput(LEFT);
		inst.handleInput(UP);
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("abc\nef\nghi");
		expect(inst.getCursor().line).toBe(1);
		expect(inst.getCursor().col).toBe(0);
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("abc\ndef\nghi");
		expect(inst.getCursor().line).toBe(1);
		expect(inst.getCursor().col).toBe(0);
	});

	test("multi-line splice crossing lines (anchor set directly; unreachable via keys)", () => {
		const inst = makeEditor();
		inst.setText("abc\ndef\nghi");
		inst.handleInput(LEFT);
		inst.handleInput(LEFT);
		priv(inst).anchor = { line: 0, col: 1 };
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("ahi");
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("abc\ndef\nghi");
	});

	test("render highlight wraps selected span in reverse video", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(HOME);
		inst.handleInput(RIGHT);
		inst.handleInput(SHIFT_END);
		expect(inst.render(80).join("\n")).toContain("\x1b[7mello\x1b[27m");
	});

	test("render highlight correct with paddingX=1", () => {
		const inst = makeEditor({ paddingX: 1 });
		inst.setText("hey");
		inst.handleInput(HOME);
		inst.handleInput(RIGHT);
		inst.handleInput(SHIFT_END);
		expect(inst.render(80).join("\n")).toContain("\x1b[7mey\x1b[27m");
	});

	test("autocomplete popup: splice cancels stale popup", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		expect(priv(inst).anchor).not.toBeNull();
		priv(inst).autocompleteState = "regular";
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("");
		expect(priv(inst).autocompleteState).toBeNull();
	});

	test("shift+end then shift+home selects full line; backspace splices; undo restores", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(END);
		inst.handleInput(SHIFT_END);
		expect(priv(inst).anchor).toBeNull();
		inst.handleInput(SHIFT_HOME);
		const anchor = priv(inst).anchor;
		expect(anchor).not.toBeNull();
		expect(anchor?.col).toBe(5);
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("");
		expect(inst.getCursor().col).toBe(0);
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("hello");
	});

	test("shift+home then shift+end: endpoints meet at EOL, empty span collapses; backspace native", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(SHIFT_END);
		expect(priv(inst).anchor).toBeNull();
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("hell");
	});

	test("existing keys unaffected: home/ctrl+a line-start, end/ctrl+e line-end", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(END);
		inst.handleInput(HOME);
		expect(inst.getCursor().col).toBe(0);
		inst.handleInput(END);
		expect(inst.getCursor().col).toBe(5);
		inst.handleInput(CTRL_A);
		expect(inst.getCursor().col).toBe(0);
		expect(priv(inst).anchor).toBeNull();
		inst.handleInput(CTRL_E);
		expect(inst.getCursor().col).toBe(5);
		expect(inst.render(80).join("\n")).not.toContain("selected");
	});

	test("ctrl+u / ctrl+k still delete to line edges after collapse", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(END);
		inst.handleInput(CTRL_U);
		expect(inst.getText()).toBe("");
		inst.handleInput(UNDO);
		inst.handleInput(HOME);
		inst.handleInput(CTRL_K);
		expect(inst.getText()).toBe("");
	});

	test("pageUp/pageDown/escape/down navigation: no crash", () => {
		const inst = makeEditor();
		inst.render(80);
		inst.handleInput(PAGE_UP);
		inst.handleInput(PAGE_DOWN);
		inst.handleInput(ESC);
		inst.handleInput(DOWN);
	});

	test("ctrl+d with empty editor / backspace on empty: no-ops", () => {
		const empty = makeEditor();
		empty.handleInput("\x04");
		empty.handleInput(BACKSPACE);
		expect(empty.getText()).toBe("");
	});

	test("built-in undo coalescing regression: undo returns to pre-typing text", () => {
		const inst = makeEditor();
		inst.handleInput("a");
		inst.handleInput("b");
		inst.handleInput("c");
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("");
	});

	test("alt+a selects all; backspace deletes everything; undo restores", () => {
		const inst = makeEditor();
		inst.setText("hello world");
		inst.handleInput(ALT_A);
		const anchor = priv(inst).anchor;
		expect(anchor).not.toBeNull();
		expect(anchor?.line).toBe(0);
		expect(anchor?.col).toBe(0);
		expect(inst.getCursor().line).toBe(0);
		expect(inst.getCursor().col).toBe(11);
		expect(inst.render(80).join("\n")).toContain("11 chars selected");
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("");
		expect(inst.getCursor().line).toBe(0);
		expect(inst.getCursor().col).toBe(0);
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("hello world");
		expect(inst.getCursor().col).toBe(11);
	});

	test("alt+a multi-line: spans all lines; delete-all; arrows still collapse", () => {
		const inst = makeEditor();
		inst.setText("abc\ndef");
		inst.handleInput(ALT_A);
		expect(inst.getCursor().line).toBe(1);
		expect(inst.getCursor().col).toBe(3);
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("");
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("abc\ndef");
		inst.handleInput(ALT_A);
		inst.handleInput(LEFT);
		expect(priv(inst).anchor).toBeNull();
	});

	test("selection label counts line breaks in multi-line selections", () => {
		const inst = makeEditor();
		inst.setText("abc\ndef\nghi");
		inst.handleInput(ALT_A);
		// 3 + 3 + 3 characters plus the 2 line breaks a delete would splice out.
		expect(inst.render(80).join("\n")).toContain("11 chars selected");
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("");
	});

	test("partial multi-line label equals the spliced amount", () => {
		const inst = makeEditor();
		inst.setText("abc\ndef\nghi");
		inst.handleInput(LEFT);
		inst.handleInput(LEFT);
		priv(inst).anchor = { line: 0, col: 1 };
		// Range [(0,1),(2,1)] covers "bc\ndef\ng" = 2 + 3 + 1 characters + 2 line breaks.
		expect(inst.render(80).join("\n")).toContain("8 chars selected");
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("ahi");
	});

	test("alt+a on empty editor is a safe no-op", () => {
		const inst = makeEditor();
		inst.handleInput(ALT_A);
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("");
	});

	test("render highlight re-arms reverse after cursor reset inside span (shift+home case)", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		expect(inst.render(80).join("\n")).toContain("h\x1b[0m\x1b[7mello\x1b[27m");
	});

	test("wrapped single-line selection highlights both visual rows", () => {
		const inst = makeEditor();
		// 26 lowercase letters + 10 digits = 36 code units on one logical line.
		const line = "abcdefghijklmnopqrstuvwxyz0123456789";
		inst.setText(line);
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		// render(24): contentWidth 24, layoutWidth 23 → the 36-char line wraps after col 22
		// (visual row 1 = cols 0-22, visual row 2 = cols 23-35). Substrings below are derived
		// from an actual render(24) of this exact state.
		const rows = inst.render(24);
		// Each visual row of the wrapped line carries its own reverse-video span. Visual row 1
		// also holds the cursor (col 0), so only its span tail stays contiguous.
		expect(rows[1]).toContain("\x1b[7mbcdefghijklmnopqrstuvw\x1b[27m");
		expect(rows[2]).toContain("\x1b[7mxyz0123456789\x1b[27m");
		// Two separate spans: at least two SGR-27 closes, one per visual row.
		expect(rows.join("\n").split("\x1b[27m").length - 1).toBeGreaterThanOrEqual(2);
		// Top and bottom border rows carry no reverse video.
		expect(rows[0]).not.toContain("\x1b[7m");
		expect(rows[rows.length - 1]).not.toContain("\x1b[7m");
		// The 51-char selection label cannot fit at width 24 (renderBottomBorder drops it), so
		// the label is asserted on a wider render of the same unchanged selection state.
		const wide = inst.render(80);
		expect(wide[wide.length - 1]).toContain("36 chars selected");
	});

	test("delete across a wrap boundary empties the line; one undo restores it", () => {
		const inst = makeEditor();
		inst.setText("abcdefghijklmnopqrstuvwxyz0123456789");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("");
		expect(inst.getCursor().line).toBe(0);
		expect(inst.getCursor().col).toBe(0);
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("abcdefghijklmnopqrstuvwxyz0123456789");
	});

	test("unicode printable replacement: accented selection replaced, one undo restores", () => {
		const inst = makeEditor();
		// é is one UTF-16 code unit, so "héllo" is 5 code units and shift+home selects all 5.
		inst.setText("héllo");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		inst.handleInput("X");
		expect(inst.getText()).toBe("X");
		expect(inst.getCursor().col).toBe(1);
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("héllo");
	});

	test("unicode span through keys: code-unit label, delete, one undo restores", () => {
		const inst = makeEditor();
		// 🌍 is a surrogate pair: "a🌍b" is 4 UTF-16 code units, and the selection counts both.
		inst.setText("a🌍b");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		expect(inst.render(80).join("\n")).toContain("4 chars selected");
		inst.handleInput(BACKSPACE);
		expect(inst.getText()).toBe("");
		expect(inst.getCursor().line).toBe(0);
		expect(inst.getCursor().col).toBe(0);
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("a🌍b");
		// Undo restores the pre-delete cursor position (0), not the pre-selection end-of-line position (4).
		expect(inst.getCursor().col).toBe(0);
	});

	test("debug tap logs raw bytes + branch when PI_SHIFT_SELECTION_DEBUG is set", () => {
		const logPath = join(tmpdir(), "shift-sel-debug-tap-" + process.pid + ".log");
		try {
			unlinkSync(logPath);
		} catch {
			/* absent */
		}
		process.env.PI_SHIFT_SELECTION_DEBUG = logPath;
		try {
			const inst = makeEditor();
			inst.setText("hello");
			inst.handleInput(END);
			inst.handleInput(SHIFT_HOME);
			inst.handleInput("x");
		} finally {
			delete process.env.PI_SHIFT_SELECTION_DEBUG;
		}
		const logged = readFileSync(logPath, "utf8");
		expect(logged).toContain("1;2H");
		expect(logged).toContain("shift+home");
		expect(logged).toContain("replace selection");
	});

	test("kitty shift+backspace replaces selection", () => {
		const inst = makeEditor();
		inst.setText("hello");
		selectFromCol(inst, 2);
		inst.handleInput(KITTY_SHIFT_BACKSPACE);
		expect(inst.getText()).toBe("llo");
		expect(inst.getCursor().col).toBe(0);
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("hello");
	});

	test("kitty shift+delete replaces selection", () => {
		const inst = makeEditor();
		inst.setText("hello");
		selectFromCol(inst, 2);
		inst.handleInput(KITTY_SHIFT_DELETE);
		expect(inst.getText()).toBe("llo");
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("hello");
	});

	test("kitty shift+backspace release is ignored with an active selection", () => {
		const inst = makeEditor();
		inst.setText("hello");
		selectFromCol(inst, 2);
		inst.handleInput(KITTY_RELEASE_SHIFT_BACKSPACE);
		expect(inst.getText()).toBe("hello");
		expect(priv(inst).anchor).not.toBeNull();
	});

	test("kitty explicit press event type acts as shift+home", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(END);
		inst.handleInput(KITTY_PRESS_SHIFT_HOME);
		expect(inst.getCursor().col).toBe(0);
		const anchor = priv(inst).anchor;
		expect(anchor).not.toBeNull();
		expect(anchor?.line).toBe(0);
		expect(anchor?.col).toBe(5);
		expect(inst.render(80).join("\n")).toContain("5 chars selected");
	});

	test("emoji CSI-u replacement over selection: surrogate pair advances cursor by 2", () => {
		const inst = makeEditor();
		inst.setText("hello"); // setText places the cursor at the end
		inst.handleInput(HOME);
		inst.handleInput(RIGHT);
		inst.handleInput(RIGHT); // cursor {0,2}
		// Span [0,2) with the cursor at the right endpoint; the anchor is set directly because
		// no key flow parks the cursor inside a span (same setup as the one-undo-transaction
		// test), so the single undo below must restore the pre-replacement cursor (col 2).
		priv(inst).anchor = { line: 0, col: 0 };
		inst.handleInput(KITTY_EMOJI);
		// ESC[127751u decodes to U+1F307, one surrogate pair = 2 UTF-16 code units.
		expect(inst.getText()).toBe("\u{1F307}llo");
		expect(inst.getCursor().col).toBe(2);
		expect(priv(inst).anchor).toBeNull();
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("hello");
		expect(inst.getCursor().col).toBe(2);
	});

	test("multi-line selection printable replacement splices across lines; one undo restores", () => {
		const inst = makeEditor();
		inst.setText("abc\ndef\nghi");
		inst.handleInput(LEFT);
		inst.handleInput(LEFT);
		priv(inst).anchor = { line: 0, col: 1 };
		inst.handleInput("X");
		expect(inst.getText()).toBe("aXhi");
		expect(inst.getCursor().line).toBe(0);
		expect(inst.getCursor().col).toBe(2);
		inst.handleInput(UNDO);
		expect(inst.getText()).toBe("abc\ndef\nghi");
		expect(inst.getCursor().line).toBe(2);
		expect(inst.getCursor().col).toBe(1);
	});

	test("debug tap file is created owner-only (0600) with the warning header", () => {
		const logPath = join(tmpdir(), "shift-sel-debug-hardening-" + process.pid + ".log");
		try {
			unlinkSync(logPath);
		} catch {
			/* absent */
		}
		process.env.PI_SHIFT_SELECTION_DEBUG = logPath;
		try {
			const inst = makeEditor();
			inst.handleInput(END);
			const logged = readFileSync(logPath, "utf8");
			expect(logged.startsWith("# PI_SHIFT_SELECTION_DEBUG")).toBe(true);
			expect(logged).toContain("delete the file afterwards");
			expect(statSync(logPath).mode & 0o777).toBe(0o600);
		} finally {
			delete process.env.PI_SHIFT_SELECTION_DEBUG;
			try {
				unlinkSync(logPath);
			} catch {
				/* absent */
			}
		}
	});

	test("debug tap reopens when the env path changes (fd cache is per path)", () => {
		const pathA = join(tmpdir(), "shift-sel-debug-path-a-" + process.pid + ".log");
		const pathB = join(tmpdir(), "shift-sel-debug-path-b-" + process.pid + ".log");
		for (const p of [pathA, pathB]) {
			try {
				unlinkSync(p);
			} catch {
				/* absent */
			}
		}
		try {
			process.env.PI_SHIFT_SELECTION_DEBUG = pathA;
			makeEditor().handleInput(END);
			process.env.PI_SHIFT_SELECTION_DEBUG = pathB;
			makeEditor().handleInput(END);
			const loggedA = readFileSync(pathA, "utf8");
			const loggedB = readFileSync(pathB, "utf8");
			for (const logged of [loggedA, loggedB]) {
				// A fresh file for each path proves the fd cache reopened for B instead of
				// appending B's key line to A: exactly 3 lines = 2 header + 1 key line.
				expect(logged.startsWith("# PI_SHIFT_SELECTION_DEBUG")).toBe(true);
				expect(logged.trimEnd().split("\n")).toHaveLength(3);
			}
		} finally {
			delete process.env.PI_SHIFT_SELECTION_DEBUG;
			for (const p of [pathA, pathB]) {
				try {
					unlinkSync(p);
				} catch {
					/* absent */
				}
			}
		}
	});

	test("selection label is suppressed when the render is too narrow", () => {
		const inst = makeEditor();
		// Same 36-char single line as the wrapped-highlight test.
		const line = "abcdefghijklmnopqrstuvwxyz0123456789";
		inst.setText(line);
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		// The 52-char label cannot fit at width 24 (renderBottomBorder drops it), so the
		// narrow frame carries no "selected" hint anywhere...
		expect(inst.render(24).join("\n")).not.toContain("selected");
		// ...while the same unchanged selection state shows it at width 80.
		expect(inst.render(80).join("\n")).toContain("36 chars selected");
	});
});

describe("capability probe and graceful degradation (internal drift)", () => {
	test("missingEditorInternals returns [] for a healthy editor instance", () => {
		expect(missingEditorInternals(makeEditor())).toEqual([]);
	});

	test("missingEditorInternals reports members shadowed to undefined and non-function drift", () => {
		const inst = makeEditor();
		const view = inst as unknown as Record<string, unknown>;
		// Methods live on the prototype, so an own undefined property shadows the member for
		// the probe without touching the prototype itself.
		view.pushUndoSnapshot = undefined;
		expect(missingEditorInternals(inst)).toContain("pushUndoSnapshot");
		expect(missingEditorInternals(inst)).toHaveLength(1);
		view.setCursorCol = 42;
		const both = missingEditorInternals(inst);
		expect(both).toContain("pushUndoSnapshot");
		expect(both).toContain("setCursorCol");
		expect(both).toHaveLength(2);
	});

	test("missingEditorInternals treats null values as present (legitimate for autocompleteState/lastAction)", () => {
		const inst = makeEditor();
		const view = inst as unknown as Record<string, unknown>;
		view.autocompleteState = null;
		view.lastAction = null;
		expect(missingEditorInternals(inst)).toEqual([]);
	});

	test("degraded instance delegates everything to the stock editor (no crash, no selection)", () => {
		const inst = makeEditor();
		inst.setText("hello");
		// Methods live on the prototype, so an own undefined property shadows the member for
		// the probe without touching the prototype itself. moveToLineEnd is the simulated
		// drift because the stock path exercised below (unknown CSI, native typing, render)
		// never calls it — verified against pi-tui editor.js — so the drift itself cannot
		// break the stock behavior under test (pushUndoSnapshot would: base insertCharacter
		// calls it on the delegated path). The shadow must also precede the FIRST
		// handleInput/render: the probe is computed once, so an earlier healthy call would
		// cache a healthy verdict for the instance lifetime.
		(inst as unknown as Record<string, unknown>).moveToLineEnd = undefined;
		// Degraded shift+home delegates to the stock editor: no throw, no anchor, no cursor
		// movement (setText parks the cursor at the end, col 5), text unchanged.
		inst.handleInput(SHIFT_HOME);
		expect(priv(inst).anchor).toBeNull();
		expect(inst.getCursor().col).toBe(5);
		expect(inst.getText()).toBe("hello");
		// Typing is pure stock editor behavior: native insert at the cursor (col 5).
		inst.handleInput("x");
		expect(inst.getText()).toBe("hellox");
		expect(inst.getCursor().col).toBe(6);
		// Stock render: rows come back and no selection hint is ever produced.
		const rows = inst.render(80);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.join("\n")).not.toContain("selected");
		// Degradation is permanent for the instance lifetime: restoring the shadowed method
		// (assignment, not delete) would make the probe pass again, yet the cached defect
		// keeps the stock behavior — a healthy editor would select on this shift+home.
		(inst as unknown as Record<string, unknown>).moveToLineEnd = (
			SelectingEditor.prototype as unknown as Record<string, unknown>
		).moveToLineEnd;
		inst.handleInput(SHIFT_HOME);
		expect(priv(inst).anchor).toBeNull();
		expect(inst.getText()).toBe("hellox");
	});

	test("bracketed paste with an active selection is not a replace key (collapses; base handles payload)", () => {
		const inst = makeEditor();
		inst.setText("hello");
		inst.handleInput(END);
		inst.handleInput(SHIFT_HOME);
		// Real terminals wrap paste payloads in bracketed-paste markers; "abc" is the payload.
		const paste = "\x1b[200~abc\x1b[201~";
		// Pinned invariant: paste is never a replace key — the selection collapses and the base editor handles the payload.
		expect(() => inst.handleInput(paste)).not.toThrow();
		expect(priv(inst).anchor).toBeNull();
		// Base-agnostic: whatever the base does with the payload, it must not splice over the
		// selection (that would yield exactly "abc") and the original line survives.
		expect(inst.getText()).not.toBe("abc");
		expect(inst.getText()).toContain("hello");
	});
});
