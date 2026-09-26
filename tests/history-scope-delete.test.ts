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
  assert.deepEqual(result, { filesAffected: 2, removed: 2, failed: 0 });
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
  assert.deepEqual(result, { filesAffected: 0, removed: 0, failed: 0 });
  assert.deepEqual(fileTexts(path.join(dir, "s.jsonl")), ["a"]);
});

test("project delete on a missing dir is a no-op", () => {
  const root = makeRoot();
  const result = deleteFromProject(root, PROJECT_A, "x");
  assert.deepEqual(result, { filesAffected: 0, removed: 0, failed: 0 });
});

test("global delete on a root without a projects dir is a zero-delete no-op", () => {
  const root = makeRoot();
  const result = deleteFromGlobal(root, "x");
  assert.deepEqual(result, { filesAffected: 0, removed: 0, failed: 0 });
});

test("global delete sweeps every project dir plus the legacy seed", () => {
  const root = makeRoot();
  const dirA = path.join(root, "projects", projectHash(PROJECT_A));
  const dirB = path.join(root, "projects", projectHash(PROJECT_B));
  writeLines(path.join(dirA, "s.jsonl"), ["victim", "a-keep"]);
  writeLines(path.join(dirB, "s.jsonl"), ["victim"]);
  writeLines(globalSeedPath(root), ["victim", "legacy-keep"]);
  const result = deleteFromGlobal(root, "victim");
  assert.deepEqual(result, { filesAffected: 3, removed: 3, failed: 0 });
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
  "an unreadable store file (chmod 000) is counted as failed; readable copies still swept",
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
      // The unreadable file may still hold a copy: it is counted as a
      // failure (never reported as a clean delete); the readable copy is
      // removed and the sweep is never fatal.
      assert.deepEqual(result, { filesAffected: 1, removed: 1, failed: 1 });
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
  assert.deepEqual(result, { filesAffected: 1, removed: 1, failed: 0 });

  // The same writer state keeps appending after the sweep — the file was
  // rewritten under the writer's feet, not removed.
  appendSessionCapture(state, "after-delete");
  assert.equal(state.lineCount, 3);
  assert.equal(fs.existsSync(state.filePath), true);
  assert.deepEqual(fileTexts(state.filePath), ["keeper", "after-delete"]);
});

// Concurrent appends (PR #1393 adaptation): another pi instance appends to
// its own file by path at any time. A line that lands between the sweep's
// read and its rename must survive the rewrite instead of vanishing with
// the replaced inode. The hook simulates that instance: it appends right
// before the sweep's rename of the swept file.
function withAppendBeforeRename(
  target: string,
  appended: string,
  run: () => void,
): void {
  const realRename = fs.renameSync;
  let fired = false;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (!fired && String(to) === target) {
      fired = true;
      fs.appendFileSync(target, appended, "utf8");
    }
    return realRename(from, to);
  }) as typeof fs.renameSync;
  try {
    run();
  } finally {
    fs.renameSync = realRename;
  }
  assert.ok(fired, "the simulated concurrent append must fire");
}

test("a line appended between the sweep's read and rename survives", () => {
  const root = makeRoot();
  const state = openSessionWriter(root, PROJECT_A, "other-instance");
  appendSessionCapture(state, "victim");
  appendSessionCapture(state, "keeper");
  withAppendBeforeRename(
    state.filePath,
    `${JSON.stringify({ v: 1, text: "raced in" })}\n`,
    () => {
      const result = deleteFromProject(root, PROJECT_A, "victim");
      assert.deepEqual(result, { filesAffected: 1, removed: 1, failed: 0 });
    },
  );
  assert.deepEqual(fileTexts(state.filePath), ["keeper", "raced in"]);
});

test("a torn last line completed during the sweep is preserved whole", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(PROJECT_A));
  const file = path.join(dir, "other.jsonl");
  const torn = JSON.stringify({ v: 1, text: "in flight" });
  writeLines(file, ["victim", "keeper"]);
  fs.appendFileSync(file, torn.slice(0, 10), "utf8");
  withAppendBeforeRename(file, `${torn.slice(10)}\n`, () => {
    deleteFromProject(root, PROJECT_A, "victim");
  });
  assert.deepEqual(fileTexts(file), ["keeper", "in flight"]);
});

test("a failed rewrite is counted, keeps the original, and leaves no tmp file", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(PROJECT_A));
  const broken = path.join(dir, "broken.jsonl");
  const healthy = path.join(dir, "healthy.jsonl");
  writeLines(broken, ["victim", "broken-keep"]);
  writeLines(healthy, ["victim", "healthy-keep"]);
  const realRename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === broken) {
      throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    }
    return realRename(from, to);
  }) as typeof fs.renameSync;
  let result;
  try {
    result = deleteFromProject(root, PROJECT_A, "victim");
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(result, { filesAffected: 1, removed: 1, failed: 1 });
  assert.deepEqual(fileTexts(broken), ["victim", "broken-keep"]);
  assert.deepEqual(fileTexts(healthy), ["healthy-keep"]);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});
