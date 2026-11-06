import assert from "node:assert/strict";
import test from "node:test";
import { VimNormalEngine } from "../lib/vim-normal-engine.ts";

function run(text: string, cursor: { line: number; col: number }, keys: string) {
  const engine = new VimNormalEngine();
  let position = cursor;
  let insert: string | undefined;
  for (const key of keys.split(" ")) {
    const result = engine.input(key, text, position);
    position = result.cursor;
    if (result.insert !== undefined) insert = result.insert;
  }
  return { position, insert };
}

test("horizontal motions count graphemes, not UTF-16 units; clamp at line edges", () => {
  assert.deepEqual(run("a👩‍💻é\nz", { line: 0, col: 0 }, "3l").position, { line: 0, col: 7 });
  assert.deepEqual(run("a👩‍💻é\nz", { line: 0, col: 7 }, "2h").position, { line: 0, col: 1 });
  assert.deepEqual(run("a\nb", { line: 0, col: 1 }, "l").position, { line: 0, col: 1 });
  assert.deepEqual(run("a b", { line: 0, col: 0 }, "Space").position, { line: 0, col: 1 });
});

test("vertical motions keep preferred grapheme column across short lines without history", () => {
  assert.deepEqual(run("a👩‍💻z\nx\na👩‍💻z", { line: 0, col: 6 }, "j j").position, { line: 2, col: 6 });
  assert.deepEqual(run("one\ntwo", { line: 0, col: 0 }, "k").position, { line: 0, col: 0 });
});

test("word, line and document motions work across newlines and Unicode", () => {
  assert.deepEqual(run("  雪 blue\n fin", { line: 0, col: 0 }, "w").position, { line: 0, col: 2 });
  assert.deepEqual(run("  雪 blue\n fin", { line: 0, col: 2 }, "w").position, { line: 0, col: 4 });
  assert.deepEqual(run("abc de\nfin", { line: 0, col: 0 }, "e").position, { line: 0, col: 2 });
  assert.deepEqual(run("abc de\nfin", { line: 0, col: 4 }, "b").position, { line: 0, col: 0 });
  assert.deepEqual(run("  abc\n fin", { line: 1, col: 2 }, "0").position, { line: 1, col: 0 });
  assert.deepEqual(run("  abc\n fin", { line: 1, col: 0 }, "^").position, { line: 1, col: 1 });
  assert.deepEqual(run("  abc\n fin", { line: 0, col: 0 }, "$ G").position, { line: 1, col: 0 });
  assert.deepEqual(run("a\nb\nc", { line: 2, col: 1 }, "g g").position, { line: 0, col: 0 });
  assert.deepEqual(run("a\nb\nc", { line: 0, col: 0 }, "2G").position, { line: 1, col: 0 });
  assert.deepEqual(run("a\nb\nc", { line: 0, col: 0 }, "2g g").position, { line: 1, col: 0 });
});

test("pending count and gg survive a non-command shortcut probe", () => {
  const engine = new VimNormalEngine();
  const text = "a\nb\nc";
  assert.deepEqual(engine.input("g", text, { line: 2, col: 0 }).cursor, { line: 2, col: 0 });
  assert.deepEqual(engine.input("g", text, { line: 2, col: 0 }).cursor, { line: 0, col: 0 });
  engine.input("2", text, { line: 0, col: 0 });
  assert.deepEqual(engine.input("j", text, { line: 0, col: 0 }).cursor, { line: 2, col: 0 });
});

test("first non-whitespace is a grapheme boundary when whitespace precedes a combining mark", () => {
  assert.deepEqual(run(" \u0301a", { line: 0, col: 0 }, "^").position, { line: 0, col: 2 });
  assert.deepEqual(run(" \u0301a", { line: 0, col: 0 }, "I"), { position: { line: 0, col: 2 }, insert: "" });
});

test("horizontal motions skip registered paste markers atomically", () => {
  const engine = new VimNormalEngine();
  const text = "a[paste #1 1001 chars]b";
  const end = text.indexOf("b");
  const positions = [[0, 1, end, text.length]];
  assert.deepEqual(engine.input("h", text, { line: 0, col: end }, positions).cursor, { line: 0, col: 1 });
  assert.deepEqual(engine.input("l", text, { line: 0, col: 1 }, positions).cursor, { line: 0, col: end });
});

test("counted f/F/t/T find within the current line on grapheme boundaries", () => {
  assert.deepEqual(run("a👩‍💻x👩‍💻x\n👩‍💻x", { line: 0, col: 0 }, "2 f 👩‍💻").position, { line: 0, col: 7 });
  assert.deepEqual(run("a👩‍💻x👩‍💻x", { line: 0, col: 0 }, "2 t 👩‍💻").position, { line: 0, col: 6 });
  assert.deepEqual(run("a👩‍💻x👩‍💻x", { line: 0, col: 13 }, "2 F 👩‍💻").position, { line: 0, col: 1 });
  assert.deepEqual(run("a👩‍💻x👩‍💻x", { line: 0, col: 13 }, "2 T 👩‍💻").position, { line: 0, col: 6 });
});

test(";/, repeat last successful find with counts, reverse direction, and no-match safety", () => {
  assert.deepEqual(run("axaxax", { line: 0, col: 0 }, "t x ;").position, { line: 0, col: 2 });
  assert.deepEqual(run("axaxax", { line: 0, col: 0 }, "f x 2 ; ,").position, { line: 0, col: 3 });
  assert.deepEqual(run("ax\nx", { line: 0, col: 0 }, "f x ;").position, { line: 0, col: 1 });
  assert.deepEqual(run("a👩‍💻b", { line: 0, col: 0 }, "f z ;").position, { line: 0, col: 0 });
  assert.deepEqual(run("ax", { line: 0, col: 0 }, "; ,").position, { line: 0, col: 0 });
});

test("pending find consumes numeric target, resets on cancellation and respects atomic paste", () => {
  const engine = new VimNormalEngine();
  const text = "a1[paste #1 1001 chars]b";
  const end = text.indexOf("b");
  const stops = [[0, 1, 2, end, text.length]];
  assert.deepEqual(engine.input("f", text, { line: 0, col: 0 }, stops).cursor, { line: 0, col: 0 });
  assert.deepEqual(engine.input("1", text, { line: 0, col: 0 }, stops).cursor, { line: 0, col: 1 });
  engine.input("f", text, { line: 0, col: 1 }, stops);
  engine.reset();
  assert.deepEqual(engine.input(";", text, { line: 0, col: 1 }, stops).cursor, { line: 0, col: 1 });
  const markerText = "a[paste #1 1001 chars]b";
  assert.deepEqual(engine.input("f", markerText, { line: 0, col: 0 }, [[0, 1, markerText.length - 1, markerText.length]]).cursor, { line: 0, col: 0 });
  assert.deepEqual(engine.input("#", markerText, { line: 0, col: 0 }, [[0, 1, markerText.length - 1, markerText.length]]).cursor, { line: 0, col: 0 });
});

test("insert/open commands return exact insertion and cursor destination", () => {
  assert.deepEqual(run("  ab", { line: 0, col: 2 }, "I"), { position: { line: 0, col: 2 }, insert: "" });
  assert.deepEqual(run("  ab", { line: 0, col: 2 }, "A"), { position: { line: 0, col: 4 }, insert: "" });
  assert.deepEqual(run("ab", { line: 0, col: 0 }, "a"), { position: { line: 0, col: 1 }, insert: "" });
  assert.deepEqual(run("ab\ncd", { line: 0, col: 0 }, "o"), { position: { line: 0, col: 2 }, insert: "\n" });
  assert.deepEqual(run("ab\ncd", { line: 1, col: 1 }, "O"), { position: { line: 1, col: 0 }, insert: "\n" });
});
