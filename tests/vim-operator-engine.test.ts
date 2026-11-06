import assert from "node:assert/strict";
import test from "node:test";
import { VimOperatorEngine } from "../lib/vim-operator-engine.ts";

function run(text: string, col: number, keys: string[], bounds?: number[][]) {
  const engine = new VimOperatorEngine();
  let cursor = { line: 0, col };
  let edit;
  for (const key of keys) {
    const result = engine.input(key, text, cursor, bounds);
    if (result?.edit) {
      edit = result.edit;
      const offset = (p: typeof cursor) => text.split("\n").slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.col;
      text = text.slice(0, offset(edit.start)) + edit.text + text.slice(offset(edit.end));
      cursor = edit.cursor;
    }
  }
  return { text, cursor, edit, engine };
}

test("visual ranges delete or change linewise and shift only selected lines", () => {
  const engine = new VimOperatorEngine();
  const range = { start: { line: 1, col: 0 }, end: { line: 2, col: 5 }, linewise: true };
  assert.deepEqual(engine.visualEdit("d", "one\ntwo\nthree", range).edit, {
    start: { line: 0, col: 3 }, end: { line: 2, col: 5 }, text: "", cursor: { line: 0, col: 0 },
  });
  assert.equal(engine.visualEdit("c", "one\ntwo\nthree", range).edit?.insert, true);
  assert.equal(engine.visualEdit(">", "one\ntwo\nthree", range).edit?.text, "  two\n  three");
  assert.equal(engine.visualEdit("<", "one\ntwo\nthree", range).edit, undefined);
});

test("visual shifts dedent tabs and empty visual ranges cannot overwrite the register", () => {
  const engine = new VimOperatorEngine();
  const line = { start: { line: 0, col: 0 }, end: { line: 0, col: 4 }, linewise: true };
  assert.equal(engine.visualEdit("<", "\tfoo", line).edit?.text, "foo");
  engine.visualRegister("saved", false);
  engine.visualRegister("", false);
  assert.equal(engine.input("P", "abc", { line: 0, col: 0 })?.edit?.text, "saved");
});

test("operator motions and doubled line operators honor counts and multiline Unicode", () => {
  assert.equal(run("👩‍💻 hi\nnext", 0, ["d", "w"]).text, "hi\nnext");
  assert.equal(run("one\ntwo\nthree", 0, ["2", "d", "d"]).text, "three");
  assert.equal(run("one\ntwo", 0, ["c", "c"]).text, "\ntwo");
  assert.equal(run("one\ntwo", 0, ["y", "y", "p"]).text, "one\none\ntwo");
  assert.equal(run("abcb", 0, ["d", "f", "c"]).text, "b");
});

test("linewise yank records a complete line and pastes at line boundaries", () => {
  for (const paste of ["p", "P"]) {
    const engine = new VimOperatorEngine();
    const cursor = { line: 1, col: 0 };
    assert.deepEqual(engine.input("y", "one\ntwo", cursor), { handled: true });
    assert.deepEqual(engine.input("y", "one\ntwo", cursor), { handled: true });
    const result = engine.input(paste, "one\ntwo", cursor);
    assert.ok(result?.edit);
    const { start, end, text } = result.edit;
    const source = "one\ntwo";
    const offset = (p: typeof cursor) => source.split("\n").slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.col;
    assert.equal(source.slice(0, offset(start)) + text + source.slice(offset(end)), "one\ntwo\ntwo");
    assert.deepEqual(result.edit.cursor, { line: paste === "P" ? 1 : 2, col: 0 });
  }
});

test("change line keeps one empty line and enters insert on the changed line", () => {
  for (const [source, line, expected] of [["one", 0, ""], ["one\ntwo", 1, "one\n"]] as const) {
    const engine = new VimOperatorEngine();
    const cursor = { line, col: 0 };
    engine.input("c", source, cursor);
    const result = engine.input("c", source, cursor);
    assert.ok(result?.edit?.insert);
    const offset = (p: { line: number; col: number }) => source.split("\n").slice(0, p.line).reduce((n, value) => n + value.length + 1, 0) + p.col;
    const edit = result.edit;
    assert.equal(source.slice(0, offset(edit.start)) + edit.text + source.slice(offset(edit.end)), expected);
    assert.deepEqual(edit.cursor, { line, col: 0 });
  }
});

test("linewise change and delete preserve surrounding lines and last-line cursor", () => {
  assert.equal(run("one\ntwo\nthree", 0, ["c", "c"]).text, "\ntwo\nthree");
  const middle = new VimOperatorEngine();
  const at = { line: 1, col: 0 };
  middle.input("c", "one\ntwo\nthree", at);
  const edit = middle.input("c", "one\ntwo\nthree", at)?.edit;
  assert.deepEqual(edit?.cursor, at);
  assert.equal(edit?.text, "\n");
  const last = new VimOperatorEngine();
  last.input("d", "one\ntwo", at);
  assert.deepEqual(last.input("d", "one\ntwo", at)?.edit?.cursor, { line: 0, col: 0 });
  assert.equal(run("one", 0, ["d", "d"]).text, "");
});

test("S on an empty prompt still requests INSERT", () => {
  assert.equal(new VimOperatorEngine().input("S", "", { line: 0, col: 0 })?.edit?.insert, true);
});

test("text objects include punctuation and WORD whitespace with quote/bracket nesting", () => {
  assert.equal(run("alpha beta", 2, ["d", "i", "w"]).text, " beta");
  assert.equal(run("alpha beta", 2, ["d", "a", "w"]).text, "beta");
  assert.equal(run("a.b rest", 2, ["d", "i", "W"]).text, " rest");
  assert.equal(run('x "a👩‍💻b" y', 4, ["d", "i", '"']).text, 'x "" y');
  assert.equal(run("a (b [cd]) z", 7, ["d", "a", "["]).text, "a (b ) z");
});

test("x/s/S and character paste use grapheme boundaries and undo-safe single edit", () => {
  assert.equal(run("👩‍💻é", 0, ["x"]).text, "é");
  assert.equal(run("👩‍💻é", 0, ["s"]).edit?.insert, true);
  assert.equal(run("abc", 0, ["x", "P"]).text, "abc");
  assert.equal(run("abc", 0, ["x", "p"]).text, "bac");
  assert.equal(run("one\ntwo", 0, ["S"]).text, "\ntwo");
});

test("shift operator accepts motion ranges, counts, Unicode and keeps the register", () => {
  const engine = new VimOperatorEngine();
  const at = { line: 0, col: 0 };
  engine.visualRegister("saved", false);
  engine.input(">", "é one\n  two\nthree", at);
  const edit = engine.input("w", "é one\n  two\nthree", at)?.edit;
  assert.equal(edit?.text, "  é one");
  assert.equal(engine.input("P", "abc", at)?.edit?.text, "saved");
  assert.equal(run("a\n b\n c\nd", 0, ["2", ">", "j"]).text, "  a\n   b\n   c\nd");
  assert.equal(run("a\n b\n c", 0, [">", "2", "j"]).text, "  a\n   b\n   c");
  assert.equal(run("  a\n\tb", 0, ["<", "j"]).text, "a\nb");
  assert.equal(run("  a\n  b", 0, ["<", "w"]).text, "a\n  b");
  assert.equal(run("  a\n  b", 0, ["<", "k"]).text, "  a\n  b");
  assert.equal(run("a\nb\nc", 0, [">", "G"]).text, "  a\n  b\n  c");
  assert.equal(run("a\nb\nc", 0, [">", "2", "G"]).text, "  a\n  b\nc");
  const repeat = new VimOperatorEngine();
  repeat.input(">", "a\nb", at);
  repeat.remember(repeat.input("j", "a\nb", at)!);
  assert.equal(repeat.repeatAt("é\nz", at)?.edit?.text, "  é\n  z");
  assert.equal(run("a\nb\nc", 0, [">", "g", "g"]).text, "a\nb\nc");
  assert.equal(run("a\nb\nc", 0, [">", "f", "b"]).text, "a\nb\nc");
});

test("motion shift excludes a next-line column-zero endpoint but keeps inclusive line motions", () => {
  assert.equal(run("a\nb", 0, [">", "w"]).text, "  a\nb");
  assert.equal(run("  a\n  b", 0, ["<", "w"]).text, "a\n  b");
  assert.equal(run("é\nb\nc", 0, [">", "2", "w"]).text, "  é\n  b\nc");
  assert.equal(run("a\nb", 0, [">", "j"]).text, "  a\n  b");
});

test("dedent with no indentation leaves undo and repeat history on the previous x", () => {
  const engine = new VimOperatorEngine();
  const cursor = { line: 0, col: 0 };
  const x = engine.input("x", "abc", cursor)!;
  engine.remember(x);
  assert.equal(engine.input("<", "bc", cursor)?.edit, undefined);
  const dedent = engine.input("<", "bc", cursor)!;
  assert.equal(dedent.edit, undefined);
  engine.remember(dedent);
  assert.deepEqual(engine.repeatAt("bc", cursor)?.edit?.end, { line: 0, col: 1 });
  const visual = { start: cursor, end: { line: 0, col: 2 }, linewise: true };
  assert.equal(engine.visualEdit("<", "bc", visual).edit, undefined);
});

test("join and shift linewise commands honor counts and Unicode without clipping", () => {
  assert.equal(run("  👩‍💻 one  \n  é two\nthird", 0, ["J"]).text, "  👩‍💻 one é two\nthird");
  assert.equal(run("a\nb\nc", 0, ["3", "J"]).text, "a b c");
  assert.equal(run("  one\n\ttwo", 0, [">", ">", "<", "<"]).text, "  one\n\ttwo");
  assert.equal(run("one\ntwo\nthree", 0, ["2", ">", ">"]).text, "  one\n  two\nthree");
});

test("repeat re-evaluates a completed counted operator at a new cursor, never a motion or yank", () => {
  const engine = new VimOperatorEngine();
  const at = { line: 0, col: 0 };
  for (const key of ["2", "d", "w"]) {
    const result = engine.input(key, "one two three four", at);
    if (result?.edit) engine.remember(result);
  }
  assert.equal(engine.repeatAt("alpha beta gamma delta", at)?.edit?.text, "");
  assert.deepEqual(engine.repeatAt("alpha beta gamma delta", at)?.edit?.end, { line: 0, col: 11 });
  engine.input("y", "alpha beta", at); engine.input("w", "alpha beta", at);
  assert.deepEqual(engine.repeatAt("red blue green", at)?.edit?.end, { line: 0, col: 9 });
  engine.cancel();
  assert.deepEqual(engine.repeatAt("red blue green", at)?.edit?.end, { line: 0, col: 9 });
});

test("repeat of x, p, join and shift uses bounded semantics; empty or failed edits are not recorded", () => {
  const engine = new VimOperatorEngine();
  const at = { line: 0, col: 0 };
  assert.equal(engine.repeatAt("abc", at), undefined);
  const noop = engine.input("x", "", at);
  assert.equal(noop?.edit, undefined);
  engine.remember(noop!);
  assert.equal(engine.repeatAt("abc", at), undefined);
  const x = engine.input("x", "👩‍💻ab", at)!;
  engine.remember(x);
  assert.deepEqual(engine.repeatAt("éz", at)?.edit?.end, { line: 0, col: 1 });
  engine.input("y", "hi\nthere", at); engine.input("y", "hi\nthere", at);
  const paste = engine.input("p", "a\nb", at)!;
  engine.remember(paste);
  assert.equal(engine.repeatAt("é\nz", at)?.edit?.text, "hi\n");
  const join = engine.input("J", "a\nb\nc", at)!;
  engine.remember(join);
  assert.equal(engine.repeatAt("é\nz", at)?.edit?.text, "é z");
  engine.input(">", "a\nb", at);
  engine.remember(engine.input(">", "a\nb", at)!);
  assert.equal(engine.repeatAt("é\nz", at)?.edit?.text, "  é");
});

test("cancel and failed motions never overwrite register or mutate paste markers", () => {
  const engine = new VimOperatorEngine();
  const pos = { line: 0, col: 0 };
  assert.deepEqual(engine.input("d", "abc", pos), { handled: true });
  assert.equal(engine.cancel(), true);
  assert.equal(engine.input("w", "abc", pos), null);
  assert.deepEqual(engine.input("p", "abc", pos), { handled: true });
  const text = "a[paste #1 1001 chars]b";
  const end = text.indexOf("b");
  const markerStart = { line: 0, col: 1 };
  assert.deepEqual(engine.input("d", text, markerStart, [[0, 1, end, text.length]]), { handled: true });
  assert.deepEqual(engine.input("w", text, markerStart, [[0, 1, end, text.length]]), { handled: true });
  assert.deepEqual(engine.input("p", text, pos), { handled: true });
});
