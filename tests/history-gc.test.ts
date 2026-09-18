import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gcProjectDir, projectHash } from "../extensions/history/store.ts";

// GC/compaction (slice 6): threshold no-op below the limits, keep-newest
// semantics, and the failure paths — the compact file lands atomically
// before any original is removed, cleanup failures are tolerated, unreadable
// files are skipped, and an append landing mid-compaction is never lost.
// All fixtures live under os.tmpdir(): the user's real ~/.pi store root is
// never touched. (Ported from the dev repo's test/history/gc.test.ts; the
// dev-only compactProjectDir shortcut is gone — gcProjectDir with explicit
// thresholds is the single PR-branch entry point.)

const CWD = "/pi-history-test/project-gc";

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

/** Line texts of the single compact-*.jsonl file in dir (must exist). */
function compactTexts(dir: string): string[] {
  const compact = fs.readdirSync(dir).find((f) => f.startsWith("compact-"));
  assert.ok(compact, "a compact-*.jsonl file must exist");
  return fs
    .readFileSync(path.join(dir, compact), "utf8")
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { text: string }).text);
}

/**
 * Replace fs.rmSync (the shared CJS exports object store.ts resolves at
 * call time) for the duration of fn; the original is always restored.
 * `rmSync` inside the replacement is the captured original, so replacements
 * can observe-or-fail and then call through.
 */
function withRmSyncPatched(
  replacement: (file: string, rmSync: (file: string) => void) => void,
  fn: () => void,
): void {
  type RmSync = (file: string) => void;
  const realRmSync = fs.rmSync.bind(fs) as RmSync;
  const target = fs as unknown as { rmSync: RmSync };
  target.rmSync = (file: string) => {
    replacement(file, realRmSync);
  };
  try {
    fn();
  } finally {
    target.rmSync = realRmSync;
  }
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
  // The compact file is the renamed final artifact, not a staging leftover.
  assert.match(
    fs.readdirSync(dir).find((f) => f.startsWith("compact-")) ?? "",
    /^compact-\d+-\d+\.jsonl$/,
  );
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes(".tmp-")),
    [],
  );
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

test("GC on a missing project dir is a no-op", () => {
  const root = makeRoot();
  const result = gcProjectDir(root, "/does/not/exist");
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

// node:test has no test.skipIf (Bun-ism): root skips via the options object.
test(
  "an unreadable file (chmod 000) is skipped; GC still compacts the readable tail",
  { skip: process.getuid?.() === 0 ? "requires non-root" : false },
  () => {
    const root = makeRoot();
    const dir = projectRoot(root);
    fs.mkdirSync(dir, { recursive: true });
    // 3 files, keepNewest 1 -> the two oldest merge; the sealed one sits in
    // the merged tail so its bytes hit the unreadable-skip branch (both the
    // line-counting pass and the merge pass skip it).
    writeFile(dir, "readable-old.jsonl", 5, 1000);
    const sealed = writeFile(dir, "sealed-old.jsonl", 5, 2000);
    writeFile(dir, "newest.jsonl", 5, 3000);
    fs.chmodSync(sealed, 0o000);
    try {
      const result = gcProjectDir(root, CWD, {
        fileThreshold: 2,
        lineThreshold: 100000,
        keepNewest: 1,
      });
      // The merged count covers the whole tail, sealed file included.
      assert.deepEqual(result, { compacted: true, merged: 2 });
      // Only the readable tail file's entries compacted; the sealed bytes
      // were skipped, never fatal. (writeFile names entries `${name}-${i}`.)
      assert.deepEqual(compactTexts(dir), [
        "readable-old.jsonl-0",
        "readable-old.jsonl-1",
        "readable-old.jsonl-2",
        "readable-old.jsonl-3",
        "readable-old.jsonl-4",
      ]);
      // Cleanup semantics: the tail originals (sealed one included) are
      // removed after the compact file lands — unlink needs no read access.
      assert.equal(fs.existsSync(sealed), false);
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

test("the compact file lands complete before any original is removed", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 12; i++) {
    writeFile(dir, `f${String(i).padStart(2, "0")}.jsonl`, 10, i * 1000);
  }
  // Observe, do not replace: at the FIRST cleanup unlink the compact file
  // must already exist on disk with the full merged content (110 lines).
  // That is the crash-safe ordering contract: readers never see the tail
  // gone with no compact file in its place.
  let compactCompleteAtFirstRm: boolean | null = null;
  withRmSyncPatched(
    (file, rmSync) => {
      if (compactCompleteAtFirstRm === null) {
        const parent = path.dirname(file);
        const compact = fs
          .readdirSync(parent)
          .find((f) => f.startsWith("compact-"));
        compactCompleteAtFirstRm =
          compact !== undefined &&
          fs
            .readFileSync(path.join(parent, compact), "utf8")
            .trim()
            .split("\n")
            .filter((l) => l.trim().length > 0).length === 110;
      }
      rmSync(file);
    },
    () => {
      const result = gcProjectDir(root, CWD, {
        fileThreshold: 10,
        lineThreshold: 10000,
        keepNewest: 1,
      });
      assert.deepEqual(result, { compacted: true, merged: 11 });
    },
  );
  assert.equal(compactCompleteAtFirstRm, true);
});

test("rm failure is tolerated: originals survive, GC still reports success", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 12; i++) {
    writeFile(dir, `f${String(i).padStart(2, "0")}.jsonl`, 10, i * 1000);
  }
  // Simulate every cleanup unlink failing (e.g. originals held by another
  // process): the compact file already landed, so a surviving original is
  // harmless — readers dedupe by identity.
  withRmSyncPatched(
    () => {
      throw new Error("simulated EBUSY: original still held");
    },
    () => {
      const result = gcProjectDir(root, CWD, {
        fileThreshold: 10,
        lineThreshold: 10000,
        keepNewest: 1,
      });
      // The success shape is unchanged even though cleanup failed.
      assert.deepEqual(result, { compacted: true, merged: 11 });
    },
  );
  // The compact file is complete on disk...
  assert.equal(compactTexts(dir).length, 110);
  // ...and every original survived the failed cleanup (12 + 1 compact).
  assert.equal(fs.readdirSync(dir).length, 13);
});

test("an append landing during compaction is never lost (active writer)", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  // 12 old files (merge-tail candidates) + one active writer file with the
  // newest mtime. The freshness rule keeps the active file out of the merge
  // tail — that is what makes concurrent appends safe during GC.
  for (let i = 1; i <= 12; i++) {
    writeFile(dir, `t${String(i).padStart(2, "0")}.jsonl`, 5, i * 1000);
  }
  const active = writeFile(dir, "active.jsonl", 5, 99_000);
  // Mid-compaction (first cleanup unlink), the active writer appends a line.
  let appended = false;
  withRmSyncPatched(
    (file, rmSync) => {
      if (!appended) {
        appended = true;
        fs.appendFileSync(
          active,
          `${JSON.stringify({ v: 1, text: "during-gc" })}\n`,
          "utf8",
        );
      }
      rmSync(file);
    },
    () => {
      const result = gcProjectDir(root, CWD, {
        fileThreshold: 10,
        lineThreshold: 100000,
        keepNewest: 10,
      });
      // 13 files > threshold 10; tail = 3 oldest; active writer untouched.
      assert.deepEqual(result, { compacted: true, merged: 3 });
    },
  );
  // The active file survived by name with every line: the pre-GC lines and
  // the line appended mid-compaction.
  const activeTexts = fs
    .readFileSync(active, "utf8")
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { text: string }).text);
  assert.deepEqual(activeTexts, [
    "active.jsonl-0",
    "active.jsonl-1",
    "active.jsonl-2",
    "active.jsonl-3",
    "active.jsonl-4",
    "during-gc",
  ]);
  // The tail's 15 lines all compacted; nothing from kept files was merged.
  const mergedTexts = compactTexts(dir);
  assert.equal(mergedTexts.length, 15);
  assert.ok(mergedTexts.includes("t01.jsonl-0"));
  assert.ok(mergedTexts.includes("t03.jsonl-4"));
  assert.ok(!mergedTexts.some((t) => t.startsWith("active.")));
  assert.ok(!mergedTexts.some((t) => t.startsWith("t04.")));
  // Whole-dir accounting: 13 x 5 original lines + 1 mid-GC append.
  assert.equal(totalLines(dir), 66);
});
