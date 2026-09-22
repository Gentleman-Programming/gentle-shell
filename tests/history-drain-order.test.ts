import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteFromProject,
  drainGlobal,
  drainProject,
  globalSeedPath,
  projectHash,
} from "../extensions/history/store.ts";

const CWD = "/pi-history-fixtures/project-a";

function writeTs(file: string, texts: string[], ts: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${texts.map((t) => JSON.stringify({ v: 1, text: t, ts })).join("\n")}\n`,
    "utf8",
  );
}

test("atomic rewrite (delete) does not reshuffle the drain order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ord-"));
  const dir = path.join(root, "projects", projectHash(CWD));
  writeTs(path.join(dir, "old.jsonl"), ["a-old"], 100);
  writeTs(path.join(dir, "new.jsonl"), ["z-new"], 200);
  assert.deepEqual(drainProject(root, CWD), ["z-new", "a-old"]);
  // Deleting from the old file rewrites it — mtime jumps to NOW.
  deleteFromProject(root, CWD, "a-old");
  assert.deepEqual(drainProject(root, CWD), ["z-new"]);
  // Re-add with an OLD ts via direct write: still ordered by ts, not mtime.
  writeTs(path.join(dir, "old2.jsonl"), ["b-old"], 150);
  fs.utimesSync(
    path.join(dir, "old2.jsonl"),
    new Date(Date.now() + 99999),
    new Date(Date.now() + 99999),
  );
  assert.deepEqual(drainProject(root, CWD), ["z-new", "b-old"]);
});

test("global drain puts the legacy seed last regardless of its fresh mtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  const dir = path.join(root, "projects", projectHash(CWD));
  writeTs(path.join(dir, "s.jsonl"), ["fresh"], 200);
  const seed = globalSeedPath(root);
  writeTs(seed, ["legacy-1", "legacy-2"], 10);
  fs.utimesSync(seed, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.deepEqual(drainGlobal(root), ["fresh", "legacy-2", "legacy-1"]);
});

const isRoot = process.getuid?.() === 0;
const sealedDrainTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, { skip: isRoot && "requires a non-root user" }, fn);
sealedDrainTest(
  "an unreadable store file is skipped; the rest drain in the expected order",
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ord-sealed-"));
    const dir = path.join(root, "projects", projectHash(CWD));
    writeTs(path.join(dir, "old.jsonl"), ["a-old"], 100);
    const sealed = path.join(dir, "sealed.jsonl");
    writeTs(sealed, ["sealed-never"], 150);
    writeTs(path.join(dir, "new.jsonl"), ["z-new"], 200);
    // The sealed file's fresh mtime would sort it FIRST if it were readable —
    // its absence from the drain is caused by the unreadable skip alone.
    fs.utimesSync(
      sealed,
      new Date(Date.now() + 99999),
      new Date(Date.now() + 99999),
    );
    fs.chmodSync(sealed, 0o000);
    try {
      // An unreadable file reads as zero entries and drops out of the drain;
      // the readable files keep their ts order. No throw.
      assert.deepEqual(drainProject(root, CWD), ["z-new", "a-old"]);
    } finally {
      fs.chmodSync(sealed, 0o644); // restore before cleanup
    }
  },
);
