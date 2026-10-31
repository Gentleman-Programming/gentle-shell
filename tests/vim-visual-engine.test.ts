import assert from "node:assert/strict";
import test from "node:test";
import { offsetAt, pairBlock, positionAt, seekPair, VimVisualEngine } from "../lib/vim-visual-engine.ts";

const bounds = (text: string) => text.split("\n").map((line) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].map((unit) => unit.index).concat(line.length));

test("character selection includes the moving grapheme, crosses newlines, and swaps its anchor", () => {
  const engine = new VimVisualEngine();
  const text = "a👩‍💻\néx";
  const stops = bounds(text);
  engine.start("char", { line: 0, col: 1 });
  assert.deepEqual(engine.range(text, { line: 0, col: 1 }, stops), { start: { line: 0, col: 1 }, end: { line: 0, col: 6 }, linewise: false });
  assert.deepEqual(engine.range(text, { line: 1, col: 0 }, stops), { start: { line: 0, col: 1 }, end: { line: 1, col: 1 }, linewise: false });
  assert.deepEqual(engine.swap({ line: 1, col: 0 }), { line: 0, col: 1 });
  assert.deepEqual(engine.range(text, { line: 0, col: 1 }, stops), { start: { line: 0, col: 1 }, end: { line: 1, col: 1 }, linewise: false });
  engine.cancel();
  assert.equal(engine.range(text, { line: 0, col: 0 }, stops), undefined);
});

test("visual objects resolve word, WORD, quotes and nested brackets across graphemes and lines", () => {
  const engine = new VimVisualEngine();
  const text = 'a👩‍💻b rest\n(é [two]) "hi"';
  const stops = bounds(text);
  engine.start("char", { line: 0, col: 1 });
  assert.deepEqual(engine.object(text, { line: 0, col: 1 }, stops, "i", "w"), {
    start: { line: 0, col: 1 }, end: { line: 0, col: 6 }, linewise: false,
  });
  assert.deepEqual(engine.object(text, { line: 0, col: 1 }, stops, "a", "W")?.end, { line: 0, col: 8 });
  assert.deepEqual(engine.object(text, { line: 1, col: 5 }, stops, "i", "("), {
    start: { line: 1, col: 1 }, end: { line: 1, col: 8 }, linewise: false,
  });
  assert.deepEqual(engine.object(text, { line: 1, col: 11 }, stops, "a", '"'), {
    start: { line: 1, col: 10 }, end: { line: 1, col: 14 }, linewise: false,
  });
  // Outside any block the object seeks the next match of its type (the
  // requested vim-everywhere behavior); a type with no block anywhere still
  // fails without moving.
  assert.deepEqual(engine.object(text, { line: 1, col: 0 }, stops, "i", '"'), {
    start: { line: 1, col: 11 }, end: { line: 1, col: 13 }, linewise: false,
  });
  assert.equal(engine.object(text, { line: 0, col: 0 }, stops, "i", "}"), undefined);
  assert.equal(engine.object("(one\ntwo)", { line: 1, col: 1 }, bounds("(one\ntwo)"), "i", "(")?.end.line, 1);
  const across = "(one\nnext\n)";
  assert.deepEqual(engine.object(across, { line: 0, col: 1 }, bounds(across), "i", "("), {
    start: { line: 0, col: 1 }, end: { line: 2, col: 0 }, linewise: false,
  });
  engine.start("char", { line: 0, col: 1 });
  assert.deepEqual(engine.range(across, { line: 1, col: 4 }, bounds(across))?.end, { line: 2, col: 0 });
});

test("line selection includes complete lines even at the final line without a newline", () => {
  const engine = new VimVisualEngine();
  engine.start("line", { line: 1, col: 1 });
  assert.deepEqual(engine.range("one\ntwo\nthree", { line: 2, col: 2 }, bounds("one\ntwo\nthree")), {
    start: { line: 1, col: 0 }, end: { line: 2, col: 5 }, linewise: true,
  });
});

test("visual objects seek the next match when the cursor is outside any block", () => {
	const engine = new VimVisualEngine();
	const text = "alpha (one) beta (two) gamma";
	const boundaries = [text.split("").map((_, i) => i)];
	engine.start("char", { line: 0, col: 0 }); // before every parenthesis
	const range = engine.object(text, { line: 0, col: 0 }, boundaries, "i", "(");
	assert.ok(range, "vi( seeks the next paren block instead of failing");
	assert.equal(text.slice(offsetAt(text, range!.start), offsetAt(text, range!.end)), "one", "the next block's inside is selected");
});


test("offsetAt and positionAt round-trip across lines", () => {
	const text = "ab\ncde\nf";
	for (const pos of [{ line: 0, col: 0 }, { line: 0, col: 2 }, { line: 1, col: 3 }, { line: 2, col: 1 }]) {
		assert.deepEqual(positionAt(text, offsetAt(text, pos)), pos);
	}
});

test("vin and vil take an object character and select the next/last block inside its delimiters", () => {
	const engine = new VimVisualEngine();
	const text = 'a [first] b {second} c "third"';
	const stops = bounds(text);
	engine.start("char", { line: 0, col: 10 });
	const next = engine.object(text, { line: 0, col: 10 }, stops, "i", "{", 1);
	assert.deepEqual(next, { start: { line: 0, col: 13 }, end: { line: 0, col: 19 }, linewise: false }, "vin{ selects inside the next braces");
	const last = engine.object(text, { line: 0, col: 10 }, stops, "i", "[", -1);
	assert.deepEqual(last, { start: { line: 0, col: 3 }, end: { line: 0, col: 8 }, linewise: false }, "vil[ selects inside the last brackets");
	const opposite = engine.object(text, { line: 0, col: 10 }, stops, "i", "}", 1);
	assert.deepEqual(opposite, next, "the closing delimiter names the same object");
	const around = engine.object(text, { line: 0, col: 10 }, stops, "a", '"', 1);
	assert.deepEqual(around, { start: { line: 0, col: 23 }, end: { line: 0, col: 30 }, linewise: false }, 'van" includes the quotes');
	const none = engine.object(text, { line: 0, col: 10 }, stops, "i", "<", 1);
	assert.equal(none, undefined, "no angle brackets anywhere: fails without moving");
});

test("backward quote seek returns the nearest preceding pair", () => {
	const text = 'x "one" y "two" z';
	const block = seekPair(text, 16, ['"', '"'], -1);
	assert.deepEqual(block, [10, 14], "the nearest preceding pair, not the first");
});

test("a pair object with the cursor on its closing delimiter selects that pair, flat and nested", () => {
	assert.deepEqual(pairBlock("f(a) g(b)", 3, "("), [1, 3], "on ) of (a): that block, not the next one");
	assert.deepEqual(pairBlock("(a (b) c)", 5, "("), [3, 5], "on the inner ): the inner block, not the outer one");
	assert.deepEqual(pairBlock("f(a) g(b)", 1, "("), [1, 3], "previous behavior holds: on the opener");
});
