import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalSeedPath, migrateLegacyStores } from "../extensions/history/store.ts";
// node:test has no test.skipIf (Bun-ism): emulate via the options object.
const skipIf =
  (condition: unknown) =>
  (name: string, fn: () => unknown) =>
    test(name, { skip: condition ? "requires non-root" : false }, fn);


function makeDirs(): { root: string; agentDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-mig-"));
  const root = path.join(base, "pi-history");
  const agentDir = path.join(base, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return { root, agentDir };
}

function fileTexts(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { text: string }).text);
}

test("no legacy files: migration is a no-op, nothing created", () => {
  const { root, agentDir } = makeDirs();
  const result = migrateLegacyStores(root, agentDir);
  assert.deepEqual(result, { migrated: 0, ran: false });
  assert.equal(fs.existsSync(globalSeedPath(root)), false);
});

test("v1 jsonl migrates into the global seed chronologically", () => {
  const { root, agentDir } = makeDirs();
  const v1 = path.join(agentDir, "editor-history.jsonl");
  fs.writeFileSync(
    v1,
    `${[
      JSON.stringify({ v: 1, text: "old" }),
      JSON.stringify({ v: 1, text: "new" }),
    ].join("\n")}\n`,
    "utf8",
  );
  const result = migrateLegacyStores(root, agentDir);
  assert.deepEqual(result, { migrated: 2, ran: true });
  assert.deepEqual(fileTexts(globalSeedPath(root)), ["old", "new"]);
  assert.equal(fs.existsSync(v1), false);
  assert.equal(fs.existsSync(`${v1}.imported`), true);
});

test("legacy array file also migrates (newest-first reversed)", () => {
  const { root, agentDir } = makeDirs();
  const legacy = path.join(agentDir, "editor-history.json");
  fs.writeFileSync(legacy, JSON.stringify(["newest", "oldest"]), "utf8");
  const result = migrateLegacyStores(root, agentDir);
  assert.deepEqual(result, { migrated: 2, ran: true });
  assert.deepEqual(fileTexts(globalSeedPath(root)), ["oldest", "newest"]);
  assert.equal(fs.existsSync(`${legacy}.imported`), true);
});

test("both legacy files: v1 jsonl content appends after array content", () => {
  const { root, agentDir } = makeDirs();
  const legacy = path.join(agentDir, "editor-history.json");
  const v1 = path.join(agentDir, "editor-history.jsonl");
  fs.writeFileSync(legacy, JSON.stringify(["from-array"]), "utf8");
  fs.writeFileSync(
    v1,
    `${JSON.stringify({ v: 1, text: "from-jsonl" })}\n`,
    "utf8",
  );
  migrateLegacyStores(root, agentDir);
  assert.deepEqual(fileTexts(globalSeedPath(root)), [
    "from-array",
    "from-jsonl",
  ]);
  assert.equal(fs.existsSync(`${legacy}.imported`), true);
  assert.equal(fs.existsSync(`${v1}.imported`), true);
});

test("existing global seed gates the migration (idempotent)", () => {
  const { root, agentDir } = makeDirs();
  fs.mkdirSync(path.dirname(globalSeedPath(root)), { recursive: true });
  fs.writeFileSync(
    globalSeedPath(root),
    `${JSON.stringify({ v: 1, text: "already-here" })}\n`,
    "utf8",
  );
  const v1 = path.join(agentDir, "editor-history.jsonl");
  fs.writeFileSync(
    v1,
    `${JSON.stringify({ v: 1, text: "would-migrate" })}\n`,
    "utf8",
  );
  const result = migrateLegacyStores(root, agentDir);
  assert.deepEqual(result, { migrated: 0, ran: false });
  assert.deepEqual(fileTexts(globalSeedPath(root)), ["already-here"]);
  assert.equal(fs.existsSync(v1), true);
});

test("malformed v1 jsonl lines are skipped, not fatal", () => {
  const { root, agentDir } = makeDirs();
  const v1 = path.join(agentDir, "editor-history.jsonl");
  fs.writeFileSync(
    v1,
    `${["{torn", JSON.stringify({ v: 1, text: "good" })].join("\n")}\n`,
    "utf8",
  );
  const result = migrateLegacyStores(root, agentDir);
  assert.deepEqual(result, { migrated: 1, ran: true });
  assert.deepEqual(fileTexts(globalSeedPath(root)), ["good"]);
});

const sealedLegacyTest = skipIf(process.getuid?.() === 0);
sealedLegacyTest(
  "an unreadable legacy file is skipped; the readable file still migrates",
  () => {
    const { root, agentDir } = makeDirs();
    const readable = path.join(agentDir, "editor-history.json");
    fs.writeFileSync(readable, JSON.stringify(["from-array"]), "utf8");
    const sealed = path.join(agentDir, "editor-history.jsonl");
    fs.writeFileSync(
      sealed,
      `${JSON.stringify({ v: 1, text: "sealed-content" })}\n`,
      "utf8",
    );
    fs.chmodSync(sealed, 0o000);
    try {
      // The sealed file's bytes are unreadable: its prompts contribute
      // nothing to the seed; the readable array still migrates. No throw.
      const result = migrateLegacyStores(root, agentDir);
      assert.deepEqual(result, { migrated: 1, ran: true });
      assert.deepEqual(fileTexts(globalSeedPath(root)), ["from-array"]);
    } finally {
      // The migration archives the unreadable file as `.imported` (rename
      // needs no read permission — content skipped, file still moved aside);
      // restore only when the original path survived an early failure.
      try {
        fs.chmodSync(sealed, 0o644);
      } catch {
        // already renamed to `.imported` by the migration
      }
    }
  },
);
