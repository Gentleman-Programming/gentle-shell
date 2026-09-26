import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hidePrompt } from "../extensions/history/hide-prompts.ts";
import {
  drainProject,
  gcProjectDir,
  globalSeedPath,
  projectHash,
  seedFilePath,
} from "../extensions/history/store.ts";

// GC/compaction (slice 6): threshold no-op below the limits, keep-newest
// semantics, and the failure paths — the compact file lands atomically
// before any original is removed, cleanup failures are tolerated, unreadable
// files are skipped, and an append landing mid-compaction is never lost.
// All fixtures live under os.tmpdir(): the user's real ~/.pi store root is
// never touched. (Ported from the dev repo's test/history/gc.test.ts;
// gcProjectDir with explicit thresholds is the wired and tested entry
// point.)

const CWD = "/pi-history-fixtures/project-gc";

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

/** Write explicit entries (text + optional ts) with a fixed mtime. */
function writeEntries(
  dir: string,
  name: string,
  entries: Array<{ text: string; ts?: number }>,
  mtimeMs: number,
): string {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `${entries.map((e) => JSON.stringify({ v: 1, ...e })).join("\n")}\n`,
    "utf8",
  );
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

/** Every entry text across the dir's .jsonl files (order unspecified). */
function dirTexts(dir: string): string[] {
  const out: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      out.push((JSON.parse(line) as { text: string }).text);
    }
  }
  return out;
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
  "an unreadable file (chmod 000) is left in place; GC still compacts the readable tail",
  { skip: process.getuid?.() === 0 ? "requires non-root" : false },
  () => {
    const root = makeRoot();
    const dir = projectRoot(root);
    fs.mkdirSync(dir, { recursive: true });
    // 3 files, keepNewest 1 -> the two oldest are merge candidates; the
    // sealed one cannot be read, so it must be neither merged nor removed:
    // removing bytes that were never copied would lose them.
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
      assert.deepEqual(result, { compacted: true, merged: 1 });
      assert.deepEqual(compactTexts(dir), [
        "readable-old.jsonl-0",
        "readable-old.jsonl-1",
        "readable-old.jsonl-2",
        "readable-old.jsonl-3",
        "readable-old.jsonl-4",
      ]);
      assert.equal(fs.existsSync(sealed), true);
      assert.equal(fs.readdirSync(dir).includes("newest.jsonl"), true);
    } finally {
      fs.chmodSync(sealed, 0o644);
    }
    assert.equal(
      fs.readFileSync(sealed, "utf8").trim().split("\n").length,
      5,
    );
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

// ---------------------------------------------------------------------------
// Adaptation hardening (PR #1394 on main): seed gate, live writers,
// chronology, tombstones, and failure tolerance.
// ---------------------------------------------------------------------------

test("compaction never selects seed.jsonl nor touches the global seed", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  // The seed is the OLDEST file, so a plain oldest-tail pick would merge it
  // and drop the bootstrap gate (an existing seed is never regenerated).
  const seed = seedFilePath(root, CWD);
  writeEntries(dir, "seed.jsonl", [{ text: "seeded", ts: 10 }], 500);
  const seedBytes = fs.readFileSync(seed, "utf8");
  const globalSeed = globalSeedPath(root);
  fs.writeFileSync(globalSeed, `${JSON.stringify({ v: 1, text: "g" })}\n`);
  const globalBytes = fs.readFileSync(globalSeed, "utf8");
  for (let i = 1; i <= 4; i++) {
    writeFile(dir, `s${i}.jsonl`, 2, i * 1000);
  }
  const result = gcProjectDir(root, CWD, {
    fileThreshold: 2,
    lineThreshold: 100000,
    keepNewest: 1,
  });
  assert.deepEqual(result, { compacted: true, merged: 3 });
  assert.equal(fs.readFileSync(seed, "utf8"), seedBytes);
  assert.equal(fs.readFileSync(globalSeed, "utf8"), globalBytes);
  assert.ok(!compactTexts(dir).includes("seeded"));
});

test("the current instance's own session file is never merged", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  // A long-lived instance whose file is the oldest in the dir.
  const own = writeFile(dir, "own-instance.jsonl", 3, 500);
  for (let i = 1; i <= 4; i++) {
    writeFile(dir, `o${i}.jsonl`, 2, i * 1000);
  }
  const result = gcProjectDir(root, CWD, {
    fileThreshold: 2,
    lineThreshold: 100000,
    keepNewest: 1,
    keepFiles: [own],
  });
  assert.deepEqual(result, { compacted: true, merged: 3 });
  assert.equal(fs.existsSync(own), true);
  assert.ok(!compactTexts(dir).some((t) => t.startsWith("own-instance")));
});

test("an append by path to a merged file between read and removal is kept", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  // An idle-but-live instance: old mtime, so its file is in the merge tail.
  const idle = writeFile(dir, "idle.jsonl", 2, 1000);
  for (let i = 2; i <= 4; i++) {
    writeFile(dir, `p${i}.jsonl`, 2, i * 1000);
  }
  let appended = false;
  withRmSyncPatched(
    (file, rmSync) => {
      if (!appended) {
        appended = true;
        // The live writer appends by path, exactly as appendSessionCapture.
        fs.appendFileSync(
          idle,
          `${JSON.stringify({ v: 1, text: "late-by-path" })}\n`,
        );
      }
      rmSync(file);
    },
    () => {
      const result = gcProjectDir(root, CWD, {
        fileThreshold: 2,
        lineThreshold: 100000,
        keepNewest: 1,
      });
      assert.equal(result.compacted, true);
    },
  );
  assert.equal(appended, true);
  const texts = dirTexts(dir);
  assert.ok(texts.includes("late-by-path"), "the late append survived");
  assert.ok(texts.includes("idle.jsonl-0"));
  assert.ok(texts.includes("idle.jsonl-1"));
});

test("a write through a descriptor opened before the claim is carried over", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  const idle = writeFile(dir, "idle.jsonl", 2, 1000);
  for (let i = 2; i <= 4; i++) {
    writeFile(dir, `q${i}.jsonl`, 2, i * 1000);
  }
  // A writer that opened the file before GC started writes after GC read it.
  const fd = fs.openSync(idle, "a");
  let written = false;
  try {
    withRmSyncPatched(
      (file, rmSync) => {
        if (!written) {
          written = true;
          fs.writeSync(
            fd,
            `${JSON.stringify({ v: 1, text: "late-by-fd" })}\n`,
          );
        }
        rmSync(file);
      },
      () => {
        gcProjectDir(root, CWD, {
          fileThreshold: 2,
          lineThreshold: 100000,
          keepNewest: 1,
        });
      },
    );
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(written, true);
  const texts = dirTexts(dir);
  assert.ok(texts.includes("late-by-fd"), "the in-flight write survived");
  assert.equal(texts.filter((t) => t.startsWith("idle.jsonl-")).length, 2);
});

test("merged output is chronological by entry ts, not by mutable mtime", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  // "old" holds the oldest prompts but was rewritten recently (a delete
  // sweep bumps mtime); "mid" is genuinely newer by ts.
  writeEntries(
    dir,
    "old.jsonl",
    [
      { text: "old-1", ts: 1000 },
      { text: "old-2", ts: 1001 },
    ],
    90_000,
  );
  writeEntries(
    dir,
    "mid.jsonl",
    [
      { text: "mid-1", ts: 2000 },
      { text: "mid-2", ts: 2001 },
    ],
    2000,
  );
  writeEntries(dir, "new.jsonl", [{ text: "new-1", ts: 3000 }], 3000);
  const result = gcProjectDir(root, CWD, {
    fileThreshold: 2,
    lineThreshold: 100000,
    keepNewest: 1,
  });
  assert.deepEqual(result, { compacted: true, merged: 2 });
  assert.deepEqual(compactTexts(dir), ["old-1", "old-2", "mid-1", "mid-2"]);
  assert.equal(fs.readdirSync(dir).includes("new.jsonl"), true);
  // The drain still reads newest-first after compaction.
  const drained = drainProject(root, CWD, 1000, root);
  assert.equal(drained.status, "ok");
  if (drained.status === "ok") {
    assert.deepEqual(drained.prompts, [
      "new-1",
      "mid-2",
      "mid-1",
      "old-2",
      "old-1",
    ]);
  }
});

test("compaction drops tombstoned prompts instead of copying them", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  writeEntries(
    dir,
    "a.jsonl",
    [{ text: "keep me" }, { text: "secret   token" }],
    1000,
  );
  writeEntries(dir, "b.jsonl", [{ text: "legacy hidden" }], 2000);
  writeEntries(dir, "c.jsonl", [{ text: "newest" }], 3000);
  assert.equal(hidePrompt(root, "secret token").status, "written");
  // A legacy plaintext (prefix-format) tombstone stays honored too.
  const hidden = JSON.parse(
    fs.readFileSync(path.join(root, "hidden.json"), "utf8"),
  ) as string[];
  fs.writeFileSync(
    path.join(root, "hidden.json"),
    JSON.stringify([...hidden, "legacy hidden"]),
  );
  const result = gcProjectDir(root, CWD, {
    fileThreshold: 2,
    lineThreshold: 100000,
    keepNewest: 1,
  });
  assert.equal(result.compacted, true);
  const texts = dirTexts(dir);
  assert.ok(texts.includes("keep me"));
  assert.ok(!texts.includes("secret   token"));
  assert.ok(!texts.includes("legacy hidden"));
});

test("an untrusted hidden.json blocks compaction (fail closed)", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 4; i++) {
    writeFile(dir, `u${i}.jsonl`, 2, i * 1000);
  }
  fs.writeFileSync(path.join(root, "hidden.json"), "{corrupt", "utf8");
  const before = fs.readdirSync(dir).sort();
  const result = gcProjectDir(root, CWD, {
    fileThreshold: 2,
    lineThreshold: 100000,
    keepNewest: 1,
  });
  assert.deepEqual(result, { compacted: false, merged: 0 });
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test("a failed compact write is tolerated and loses nothing", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 4; i++) {
    writeFile(dir, `w${i}.jsonl`, 3, i * 1000);
  }
  type RenameSync = (from: string, to: string) => void;
  const target = fs as unknown as { renameSync: RenameSync };
  const realRename = fs.renameSync.bind(fs) as RenameSync;
  target.renameSync = (from: string, to: string) => {
    if (path.basename(to).startsWith("compact-")) {
      throw new Error("simulated ENOSPC");
    }
    realRename(from, to);
  };
  let result: ReturnType<typeof gcProjectDir>;
  try {
    result = gcProjectDir(root, CWD, {
      fileThreshold: 2,
      lineThreshold: 100000,
      keepNewest: 1,
    });
  } finally {
    target.renameSync = realRename;
  }
  assert.deepEqual(result, { compacted: false, merged: 0 });
  assert.equal(dirTexts(dir).length, 12);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes(".tmp-")),
    [],
  );
});

test("a torn last line in a merged file is carried over, not dropped", () => {
  const root = makeRoot();
  const dir = projectRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  // A writer died mid-append: the final line has no newline yet.
  const torn = path.join(dir, "torn.jsonl");
  fs.writeFileSync(
    torn,
    `${JSON.stringify({ v: 1, text: "whole" })}\n${JSON.stringify({ v: 1, text: "torn" })}`,
  );
  fs.utimesSync(torn, new Date(1000), new Date(1000));
  writeFile(dir, "r2.jsonl", 2, 2000);
  writeFile(dir, "r3.jsonl", 2, 3000);
  const result = gcProjectDir(root, CWD, {
    fileThreshold: 2,
    lineThreshold: 100000,
    keepNewest: 1,
  });
  assert.deepEqual(result, { compacted: true, merged: 2 });
  assert.equal(fs.existsSync(torn), false);
  // Every compact line parses, and the torn entry survived.
  const texts = compactTexts(dir);
  assert.ok(texts.includes("whole"));
  assert.ok(texts.includes("torn"));
  assert.ok(texts.includes("r2.jsonl-1"));
});
