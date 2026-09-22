import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  drainGlobal,
  drainProject,
  globalSeedPath,
  projectHash,
  seedFilePath,
} from "../extensions/history/store.ts";

const PROJECT_A = "/pi-history-fixtures/project-a";
const PROJECT_B = "/pi-history-fixtures/project-b";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-reader-"));
}

function writeLines(
  file: string,
  texts: string[],
  opts?: { ts?: number },
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${texts
      .map((t) => JSON.stringify({ v: 1, text: t, ts: opts?.ts ?? 1000 }))
      .join("\n")}\n`,
    "utf8",
  );
}

function setMtime(file: string, ms: number): void {
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

test("empty project dir drains nothing", () => {
  const root = makeRoot();
  assert.deepEqual(drainProject(root, PROJECT_A), []);
});

test("single file drains newest-first (reverse of file order)", () => {
  const root = makeRoot();
  writeLines(path.join(root, "projects", projectHash(PROJECT_A), "s1.jsonl"), [
    "old",
    "mid",
    "new",
  ]);
  assert.deepEqual(drainProject(root, PROJECT_A), ["new", "mid", "old"]);
});

test("multiple files merge by file mtime, then newest-first inside", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(PROJECT_A));
  writeLines(path.join(dir, "older-session.jsonl"), ["a1", "a2"]);
  writeLines(path.join(dir, "newer-session.jsonl"), ["b1", "b2"]);
  setMtime(path.join(dir, "older-session.jsonl"), 1000);
  setMtime(path.join(dir, "newer-session.jsonl"), 2000);
  assert.deepEqual(drainProject(root, PROJECT_A), ["b2", "b1", "a2", "a1"]);
});

test("duplicates across files keep only the newest occurrence", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(PROJECT_A));
  writeLines(path.join(dir, "old.jsonl"), ["shared", "only-old"]);
  writeLines(path.join(dir, "new.jsonl"), ["shared", "only-new"]);
  setMtime(path.join(dir, "old.jsonl"), 1000);
  setMtime(path.join(dir, "new.jsonl"), 2000);
  assert.deepEqual(drainProject(root, PROJECT_A), [
    "only-new",
    "shared",
    "only-old",
  ]);
});

test("case-insensitive identity: DUPLICATE matches duplicate", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(PROJECT_A));
  writeLines(path.join(dir, "old.jsonl"), ["duplicate"]);
  writeLines(path.join(dir, "new.jsonl"), ["DUPLICATE"]);
  setMtime(path.join(dir, "old.jsonl"), 1000);
  setMtime(path.join(dir, "new.jsonl"), 2000);
  const drained = drainProject(root, PROJECT_A);
  assert.equal(drained.length, 1);
  assert.equal(drained[0], "DUPLICATE");
});

test("limit stops the drain early (newest kept)", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(PROJECT_A));
  const texts: string[] = [];
  for (let i = 1; i <= 30; i++) texts.push(`p${i}`);
  writeLines(path.join(dir, "s.jsonl"), texts);
  const drained = drainProject(root, PROJECT_A, 5);
  assert.deepEqual(drained, ["p30", "p29", "p28", "p27", "p26"]);
});

test("seed.jsonl participates as an ordinary source file", () => {
  const root = makeRoot();
  writeLines(seedFilePath(root, PROJECT_A), ["seeded-old", "seeded-new"]);
  setMtime(seedFilePath(root, PROJECT_A), 500);
  const drained = drainProject(root, PROJECT_A);
  assert.deepEqual(drained, ["seeded-new", "seeded-old"]);
});

test("malformed lines are skipped", () => {
  const root = makeRoot();
  const file = path.join(root, "projects", projectHash(PROJECT_A), "s.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ v: 1, text: "good" }),
      "{torn",
      JSON.stringify({ v: 1, text: "also-good" }),
      "",
    ].join("\n"),
    "utf8",
  );
  assert.deepEqual(drainProject(root, PROJECT_A), ["also-good", "good"]);
});

// --- global drain ---

test("global drain merges all projects newest-first with the legacy seed", () => {
  const root = makeRoot();
  const dirA = path.join(root, "projects", projectHash(PROJECT_A));
  const dirB = path.join(root, "projects", projectHash(PROJECT_B));
  // Distinct entry ts values make the cross-project order explicit:
  // fileSortKey keys on the newest entry ts, so equal-ts files would leave
  // the order to directory enumeration (accidental, not asserted).
  writeLines(path.join(dirA, "s1.jsonl"), ["a-oldest", "a-newest"], {
    ts: 3000,
  });
  writeLines(path.join(dirB, "s1.jsonl"), ["b-mid"], { ts: 2000 });
  writeLines(globalSeedPath(root), ["legacy-oldest"], { ts: 1000 });
  const drained = drainGlobal(root);
  assert.deepEqual(drained, ["a-newest", "a-oldest", "b-mid", "legacy-oldest"]);
});

test("global drain dedupes across projects", () => {
  const root = makeRoot();
  const dirA = path.join(root, "projects", projectHash(PROJECT_A));
  const dirB = path.join(root, "projects", projectHash(PROJECT_B));
  // Distinct entry ts: A must drain before B (see the merge test above).
  writeLines(path.join(dirA, "s.jsonl"), ["shared-prompt"], { ts: 2000 });
  writeLines(path.join(dirB, "s.jsonl"), ["shared-prompt", "b-only"], {
    ts: 1000,
  });
  assert.deepEqual(drainGlobal(root), ["shared-prompt", "b-only"]);
});

test("growth from a concurrent instance is visible on the next drain", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(PROJECT_A));
  writeLines(path.join(dir, "s1.jsonl"), ["first"]);
  assert.deepEqual(drainProject(root, PROJECT_A), ["first"]);
  writeLines(path.join(dir, "s2.jsonl"), ["from-other-instance"]);
  setMtime(path.join(dir, "s2.jsonl"), Date.now() + 5000);
  assert.deepEqual(drainProject(root, PROJECT_A), [
    "from-other-instance",
    "first",
  ]);
});

test("global drain on a fresh root without a projects dir is empty", () => {
  const root = makeRoot();
  assert.deepEqual(drainGlobal(root), []);
});
