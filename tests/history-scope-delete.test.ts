import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendSessionCapture,
  deleteFromGlobal,
  deleteFromProject,
  globalSeedPath,
  openSessionWriter,
  projectHash,
} from "../extensions/history/store.ts";

// Scope delete (design v2): sweepFiles' atomic per-file rewrite semantics
// plus the project/global delete entry points. Synthetic project cwds —
// never real directories on any machine (identity only feeds projectHash;
// the fixtures live in tmpdirs and never touch the user's real ~/.pi).
const PROJECT_A = "/fixtures/pi-history/project-a";
const PROJECT_B = "/fixtures/pi-history/project-b";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-del-"));
}

function writeLines(file: string, texts: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${texts.map((t) => JSON.stringify({ v: 1, text: t })).join("\n")}\n`,
    "utf8",
  );
}

function fileTexts(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { text: string }).text);
}

test("project delete removes every copy across the project's files", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(PROJECT_A));
  writeLines(path.join(dir, "s1.jsonl"), ["keep", "victim"]);
  writeLines(path.join(dir, "s2.jsonl"), ["VICTIM  ", "also-keep"]);
  const result = deleteFromProject(root, PROJECT_A, "victim");
  assert.deepEqual(result, { filesAffected: 2, removed: 2 });
  assert.deepEqual(fileTexts(path.join(dir, "s1.jsonl")), ["keep"]);
  assert.deepEqual(fileTexts(path.join(dir, "s2.jsonl")), ["also-keep"]);
});

test("project delete leaves other projects untouched", () => {
  const root = makeRoot();
  const dirA = path.join(root, "projects", projectHash(PROJECT_A));
  const dirB = path.join(root, "projects", projectHash(PROJECT_B));
  writeLines(path.join(dirA, "s.jsonl"), ["victim"]);
  writeLines(path.join(dirB, "s.jsonl"), ["victim", "b-keep"]);
  deleteFromProject(root, PROJECT_A, "victim");
  assert.deepEqual(fileTexts(path.join(dirB, "s.jsonl")), ["victim", "b-keep"]);
});

test("project delete of unknown prompt is a no-op", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(PROJECT_A));
  writeLines(path.join(dir, "s.jsonl"), ["a"]);
  const result = deleteFromProject(root, PROJECT_A, "missing");
  assert.deepEqual(result, { filesAffected: 0, removed: 0 });
  assert.deepEqual(fileTexts(path.join(dir, "s.jsonl")), ["a"]);
});

test("project delete on a missing dir is a no-op", () => {
  const root = makeRoot();
  const result = deleteFromProject(root, PROJECT_A, "x");
  assert.deepEqual(result, { filesAffected: 0, removed: 0 });
});

test("global delete on a root without a projects dir is a zero-delete no-op", () => {
  const root = makeRoot();
  const result = deleteFromGlobal(root, "x");
  assert.deepEqual(result, { filesAffected: 0, removed: 0 });
});

test("global delete sweeps every project dir plus the legacy seed", () => {
  const root = makeRoot();
  const dirA = path.join(root, "projects", projectHash(PROJECT_A));
  const dirB = path.join(root, "projects", projectHash(PROJECT_B));
  writeLines(path.join(dirA, "s.jsonl"), ["victim", "a-keep"]);
  writeLines(path.join(dirB, "s.jsonl"), ["victim"]);
  writeLines(globalSeedPath(root), ["victim", "legacy-keep"]);
  const result = deleteFromGlobal(root, "victim");
  assert.deepEqual(result, { filesAffected: 3, removed: 3 });
  assert.deepEqual(fileTexts(path.join(dirA, "s.jsonl")), ["a-keep"]);
  assert.deepEqual(fileTexts(path.join(dirB, "s.jsonl")), []);
  assert.deepEqual(fileTexts(globalSeedPath(root)), ["legacy-keep"]);
});

test("delete leaves no tmp files behind", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(PROJECT_A));
  writeLines(path.join(dir, "s.jsonl"), ["victim"]);
  deleteFromProject(root, PROJECT_A, "victim");
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

// node:test has no test.skipIf (Bun-ism): root skips via the options object.
test(
  "an unreadable store file (chmod 000) is skipped; readable copies still swept",
  { skip: process.getuid?.() === 0 ? "requires non-root" : false },
  () => {
    const root = makeRoot();
    const dir = path.join(root, "projects", projectHash(PROJECT_A));
    const readable = path.join(dir, "readable.jsonl");
    const sealed = path.join(dir, "sealed.jsonl");
    writeLines(readable, ["victim", "keep"]);
    writeLines(sealed, ["victim"]);
    fs.chmodSync(sealed, 0o000);
    try {
      const result = deleteFromProject(root, PROJECT_A, "victim");
      // The unreadable file's copy is invisible to the sweep; the readable
      // copy is removed and the sweep is never fatal.
      assert.deepEqual(result, { filesAffected: 1, removed: 1 });
      assert.deepEqual(fileTexts(readable), ["keep"]);
      assert.equal(fs.existsSync(sealed), true);
    } finally {
      fs.chmodSync(sealed, 0o644); // restore before cleanup
    }
  },
);

test("a file whose every line is deleted becomes empty (kept, not removed)", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(PROJECT_A));
  const file = path.join(dir, "s.jsonl");
  writeLines(file, ["only-victim"]);
  deleteFromProject(root, PROJECT_A, "only-victim");
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

// Active-writer safety (design v2): the sweep rewrites the writer's own
// file IN PLACE (tmp + rename, never a removal — emptied files are kept),
// so a concurrently live writer keeps working by path: its next capture
// appends into the swept file, and the surviving + new lines parse fine.
test("a sweep with a concurrent live writer keeps the writer's file functional", () => {
  const root = makeRoot();
  const state = openSessionWriter(root, PROJECT_A, "instance-1");
  appendSessionCapture(state, "victim");
  appendSessionCapture(state, "keeper");

  const result = deleteFromProject(root, PROJECT_A, "victim");
  assert.deepEqual(result, { filesAffected: 1, removed: 1 });

  // The same writer state keeps appending after the sweep — the file was
  // rewritten under the writer's feet, not removed.
  appendSessionCapture(state, "after-delete");
  assert.equal(state.lineCount, 3);
  assert.equal(fs.existsSync(state.filePath), true);
  assert.deepEqual(fileTexts(state.filePath), ["keeper", "after-delete"]);
});
