import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalSeedPath, migrateLegacyStores } from "../extensions/history/store.ts";

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
  assert.equal(fs.existsSync(v1), true);
  assert.equal(fs.existsSync(`${v1}.imported`), false);
});

test("competing migration cannot publish a partial seed over a complete one", () => {
  const { root, agentDir } = makeDirs();
  const array = path.join(agentDir, "editor-history.json");
  const v1 = path.join(agentDir, "editor-history.jsonl");
  fs.writeFileSync(array, JSON.stringify(["array prompt"]));
  fs.writeFileSync(v1, `${JSON.stringify({ text: "v1 prompt" })}\n`);
  const original = fs.readFileSync;
  let competing: ReturnType<typeof migrateLegacyStores> | undefined;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (file === v1 && !competing) {
      // The first migration has already read the array; the competing one
      // must not publish a seed while that snapshot is incomplete.
      competing = { migrated: -1, ran: true };
      competing = migrateLegacyStores(root, agentDir);
    }
    return (original as (...args: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync;
  try {
    migrateLegacyStores(root, agentDir);
  } finally {
    fs.readFileSync = original;
  }
  assert.deepEqual(competing, { migrated: 0, ran: false });
  assert.deepEqual(fileTexts(globalSeedPath(root)), ["array prompt", "v1 prompt"]);
});

test("an ownerless crash lock fails closed without changing sources or seed", () => {
  const { root, agentDir } = makeDirs();
  const array = path.join(agentDir, "editor-history.json");
  const v1 = path.join(agentDir, "editor-history.jsonl");
  const seed = globalSeedPath(root);
  const arrayBytes = JSON.stringify(["array prompt"]);
  const v1Bytes = `${JSON.stringify({ text: "after crash" })}\n`;
  const seedBytes = `${JSON.stringify({ text: "already seeded" })}\n`;
  fs.writeFileSync(array, arrayBytes);
  fs.writeFileSync(v1, v1Bytes);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(seed, seedBytes);
  // A process can die immediately after mkdir, before recording ownership.
  // An ownerless lock needs manual recovery; do not claim automatic import.
  const lock = `${seed}.migration-lock`;
  fs.mkdirSync(lock);
  assert.deepEqual(migrateLegacyStores(root, agentDir), { migrated: 0, ran: false });
  assert.equal(fs.readFileSync(array, "utf8"), arrayBytes);
  assert.equal(fs.readFileSync(v1, "utf8"), v1Bytes);
  assert.equal(fs.existsSync(`${array}.imported`), false);
  assert.equal(fs.existsSync(`${v1}.imported`), false);
  assert.equal(fs.readFileSync(seed, "utf8"), seedBytes);
  assert.equal(fs.existsSync(lock), true);
});

test("a live legacy writer remains reachable for prompts appended after migration", () => {
  const { root, agentDir } = makeDirs();
  const v1 = path.join(agentDir, "editor-history.jsonl");
  fs.writeFileSync(v1, `${JSON.stringify({ text: "before" })}\n`);
  const fd = fs.openSync(v1, "a");
  try {
    migrateLegacyStores(root, agentDir);
    fs.writeSync(fd, `${JSON.stringify({ text: "after" })}\n`);
    assert.deepEqual(migrateLegacyStores(root, agentDir), { migrated: 1, ran: true });
    assert.deepEqual(fileTexts(globalSeedPath(root)), ["before", "after"]);
  } finally {
    fs.closeSync(fd);
  }
});

test("prompts appended to an already archived live v1 file are recovered", () => {
  const { root, agentDir } = makeDirs();
  const archived = path.join(agentDir, "editor-history.jsonl.imported");
  fs.writeFileSync(archived, `${JSON.stringify({ text: "archived" })}\n`);
  migrateLegacyStores(root, agentDir);
  fs.appendFileSync(archived, `${JSON.stringify({ text: "late" })}\n`);
  assert.deepEqual(migrateLegacyStores(root, agentDir), { migrated: 1, ran: true });
  assert.deepEqual(fileTexts(globalSeedPath(root)), ["archived", "late"]);
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
  assert.equal(fs.existsSync(v1), true);
});

test("existing global seed is preserved while new v1 prompts are imported", () => {
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
  assert.deepEqual(result, { migrated: 1, ran: true });
  assert.deepEqual(fileTexts(globalSeedPath(root)), ["already-here", "would-migrate"]);
  assert.deepEqual(migrateLegacyStores(root, agentDir), { migrated: 0, ran: false });
  assert.equal(fs.existsSync(v1), true);
});

test("unreadable legacy source leaves both sources for a complete retry", () => {
  const { root, agentDir } = makeDirs();
  const array = path.join(agentDir, "editor-history.json");
  const v1 = path.join(agentDir, "editor-history.jsonl");
  fs.writeFileSync(array, JSON.stringify(["array prompt"]));
  fs.writeFileSync(v1, `${JSON.stringify({ text: "v1 prompt" })}\n`);
  const original = fs.readFileSync;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (file === v1) throw new Error("injected read failure");
    return (original as (...args: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync;
  try {
    assert.throws(() => migrateLegacyStores(root, agentDir), /injected read failure/);
    assert.equal(fs.existsSync(globalSeedPath(root)), false);
    assert.equal(fs.existsSync(array), true);
    assert.equal(fs.existsSync(v1), true);
  } finally {
    fs.readFileSync = original;
  }
  assert.deepEqual(migrateLegacyStores(root, agentDir), { migrated: 2, ran: true });
  assert.deepEqual(fileTexts(globalSeedPath(root)), ["array prompt", "v1 prompt"]);
});

test("malformed legacy array cannot archive a readable v1 source", () => {
  const { root, agentDir } = makeDirs();
  const array = path.join(agentDir, "editor-history.json");
  const v1 = path.join(agentDir, "editor-history.jsonl");
  fs.writeFileSync(array, "{torn");
  fs.writeFileSync(v1, `${JSON.stringify({ text: "survives" })}\n`);
  assert.throws(() => migrateLegacyStores(root, agentDir), SyntaxError);
  assert.equal(fs.existsSync(globalSeedPath(root)), false);
  assert.equal(fs.existsSync(v1), true);
  fs.writeFileSync(array, JSON.stringify(["repaired"]));
  assert.deepEqual(migrateLegacyStores(root, agentDir), { migrated: 2, ran: true });
  assert.deepEqual(fileTexts(globalSeedPath(root)), ["repaired", "survives"]);
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

// node:test has no test.skipIf (Bun-ism): root skips via the options
// object — chmod 000 is invisible to the superuser.
const sealedLegacyTest = (name: string, fn: () => void) =>
  test(
    name,
    { skip: process.getuid?.() === 0 ? "requires non-root" : false },
    fn,
  );

// chmod-based failure injection is also invisible to the superuser.
const seedFailureTest = (name: string, fn: () => void) =>
  test(
    name,
    { skip: process.getuid?.() === 0 ? "requires non-root" : false },
    fn,
  );

seedFailureTest(
  "a failed seed write leaves legacy sources untouched for retry",
  () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-fail-"));
    const v1 = path.join(agentDir, "editor-history.jsonl");
    fs.writeFileSync(
      v1,
      `${JSON.stringify({ v: 1, text: "survives-retry" })}\n`,
      "utf8",
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-fail-root-"));
    // A read-only store root makes the seed write fail AFTER the sources
    // have been read but BEFORE any rename.
    fs.chmodSync(root, 0o555);
    try {
      assert.throws(() => migrateLegacyStores(root, agentDir));
      // The source was NOT renamed: the retry path is intact.
      assert.equal(fs.existsSync(v1), true);
      assert.equal(fs.existsSync(`${v1}.imported`), false);
      assert.equal(fs.existsSync(globalSeedPath(root)), false);
    } finally {
      fs.chmodSync(root, 0o755);
    }
    // Retry after the failure clears: full migration, then rename.
    const result = migrateLegacyStores(root, agentDir);
    assert.deepEqual(result, { migrated: 1, ran: true });
    assert.equal(fs.existsSync(v1), true);
    assert.deepEqual(fileTexts(globalSeedPath(root)), ["survives-retry"]);
  },
);

sealedLegacyTest(
  "an unreadable legacy file defers migration without archiving either source",
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
      assert.throws(() => migrateLegacyStores(root, agentDir));
      assert.equal(fs.existsSync(globalSeedPath(root)), false);
      assert.equal(fs.existsSync(readable), true);
      assert.equal(fs.existsSync(sealed), true);
    } finally {
      fs.chmodSync(sealed, 0o644);
    }
  },
);
