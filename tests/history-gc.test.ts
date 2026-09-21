import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compactProjectDir,
  gcProjectDir,
  projectHash,
} from "../extensions/history/store.ts";
// node:test has no test.skipIf (Bun-ism): emulate via the options object.
const skipIf =
  (condition: unknown) =>
  (name: string, fn: () => unknown) =>
    test(
      name,
      { skip: condition ? "requires non-root" : false },
      fn as () => void | Promise<void>,
    );


const CWD = "/Users/admin/Dev/pi/pi-history";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-gc-"));
}

function projectRoot(root: string): string {
  return path.join(root, "projects", projectHash(CWD));
}

function writeFile(
  dir: string,
  name: string,
  count: number,
  mtimeMs: number,
): string {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `${Array.from({ length: count }, (_, i) =>
      JSON.stringify({ v: 1, text: `${name}-${i}` }),
    ).join("\n")}\n`,
    "utf8",
  );
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

function totalLines(dir: string): number {
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    total += fs
      .readFileSync(path.join(dir, f), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
  }
  return total;
}

test("under both thresholds: GC is a no-op", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  writeFile(dir, "a.jsonl", 10, 1000);
  writeFile(dir, "b.jsonl", 10, 2000);
  const result = gcProjectDir(root, CWD, {
    fileThreshold: 10,
    lineThreshold: 10000,
    keepNewest: 1,
  });
  assert.deepEqual(result, { compacted: false, merged: 0 });
  assert.equal(fs.readdirSync(dir).length, 2);
});

test("file-count threshold merges the oldest files into one compact file", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  // 12 files (threshold 10) x 10 lines each.
  for (let i = 1; i <= 12; i++) {
    writeFile(dir, `f${String(i).padStart(2, "0")}.jsonl`, 10, i * 1000);
  }
  const result = gcProjectDir(root, CWD, {
    fileThreshold: 10,
    lineThreshold: 10000,
    keepNewest: 1,
  });
  assert.deepEqual(result, { compacted: true, merged: 11 });
  // 12 files -> newest 1 kept + 1 compact file = 2 files; all lines kept.
  assert.equal(fs.readdirSync(dir).length, 2);
  assert.equal(totalLines(dir), 120);
  const compact = fs.readdirSync(dir).find((f) => f.startsWith("compact-"));
  assert.ok(compact);
  // The newest original file survives untouched by name.
  assert.equal(fs.readdirSync(dir).includes("f12.jsonl"), true);
});

test("line-count threshold triggers compaction too", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  // 3 files x 4000 lines = 12000 > 10000 threshold.
  for (let i = 1; i <= 3; i++) {
    writeFile(dir, `g${i}.jsonl`, 4000, i * 1000);
  }
  const result = gcProjectDir(root, CWD, {
    fileThreshold: 10,
    lineThreshold: 10000,
    keepNewest: 1,
  });
  assert.equal(result.compacted, true);
  assert.equal(totalLines(dir), 12000);
  assert.equal(fs.readdirSync(dir).includes("g3.jsonl"), true);
});

test("compactProjectDir on a missing dir is a no-op", () => {
  const root = makeRoot();
  const result = compactProjectDir(root, "/does/not/exist");
  assert.deepEqual(result, { compacted: false, merged: 0 });
});

test("compaction keeps the newest 10 files, merges the rest", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 15; i++) {
    writeFile(dir, `h${String(i).padStart(2, "0")}.jsonl`, 5, i * 1000);
  }
  const result = gcProjectDir(root, CWD, {
    fileThreshold: 10,
    lineThreshold: 10000,
    keepNewest: 10,
  });
  assert.deepEqual(result, { compacted: true, merged: 5 });
  const names = fs.readdirSync(dir).sort();
  // 10 newest originals + 1 compact file.
  assert.equal(names.length, 11);
  assert.equal(names[0].startsWith("compact-"), true);
  assert.equal(names.includes("h15.jsonl"), true);
  assert.equal(names.includes("h05.jsonl"), false);
  assert.equal(names.includes("h06.jsonl"), true);
});

const sealedGcTest = skipIf(process.getuid?.() === 0);
sealedGcTest(
  "compactProjectDir skips an unreadable file's content and compacts the readable entries",
  () => {
    const root = makeRoot();
    const dir = projectRoot(root);
    fs.mkdirSync(dir, { recursive: true });
    // 3 files, keepNewest 1 → the two oldest merge; the sealed one sits in
    // the merged tail so its content hits the unreadable-skip branch.
    writeFile(dir, "readable-old.jsonl", 5, 1000);
    const sealed = writeFile(dir, "sealed-old.jsonl", 5, 2000);
    writeFile(dir, "newest.jsonl", 5, 3000);
    fs.chmodSync(sealed, 0o000);
    try {
      const result = compactProjectDir(root, CWD, { keepNewest: 1 });
      // The merged count covers the whole tail, sealed file included.
      assert.deepEqual(result, { compacted: true, merged: 2 });
      const compact = fs.readdirSync(dir).find((f) => f.startsWith("compact-"));
      if (compact === undefined) {
        throw new Error("the compact file must exist");
      }
      const compactTexts = fs
        .readFileSync(path.join(dir, compact), "utf8")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { text: string }).text);
      // Only the readable tail file's entries compacted; the sealed bytes
      // were skipped, never fatal. (writeFile names entries `${name}-${i}`.)
      assert.deepEqual(compactTexts, [
        "readable-old.jsonl-0",
        "readable-old.jsonl-1",
        "readable-old.jsonl-2",
        "readable-old.jsonl-3",
        "readable-old.jsonl-4",
      ]);
      // GC cache semantics: the tail originals (sealed one included) are
      // removed after the compact file lands — unlink needs no read access.
      assert.equal(fs.readdirSync(dir).includes("sealed-old.jsonl"), false);
      assert.equal(fs.readdirSync(dir).includes("newest.jsonl"), true);
    } finally {
      // The compaction removes the sealed original; restore only if it
      // survived an early failure so cleanup never leaves a 000 file.
      try {
        fs.chmodSync(sealed, 0o644);
      } catch {
        // already removed by the compaction
      }
    }
  },
);
