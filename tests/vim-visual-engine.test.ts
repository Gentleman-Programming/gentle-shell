import assert from "node:assert/strict";
import test from "node:test";
import { VimVisualEngine } from "../lib/vim-visual-engine.ts";

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
  assert.equal(engine.object(text, { line: 1, col: 0 }, stops, "i", '"'), undefined);
  assert.equal(engine.object(text, { line: 0, col: 0 }, stops, "i", "["), undefined);
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
