import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bootstrapProjectSeed,
  projectHash,
  seedFilePath,
} from "../extensions/history/store.ts";

// Fake project cwd (never created on disk): projectHash falls back to
// raw-string hashing for nonexistent paths, and the transcript dirName
// encoding derives from the same string.
const CWD = "/pi-history-test/seed-project";
const DIR = "--pi-history-test-seed-project--";

function makeDirs(): { root: string; sessionsRoot: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-seed-"));
  return {
    root: path.join(base, "pi-history"),
    sessionsRoot: path.join(base, "sessions"),
  };
}

function writeSession(
  sessionsRoot: string,
  dirName: string,
  fileName: string,
  userTexts: string[],
  mtimeMs?: number,
): string {
  const dir = path.join(sessionsRoot, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
  ];
  let ms = 1700000000000;
  for (const text of userTexts) {
    lines.push(
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: text, timestamp: ms },
      }),
    );
    ms += 1;
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  if (mtimeMs !== undefined) {
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  }
  return file;
}

function seedTexts(root: string): string[] {
  const file = seedFilePath(root, CWD);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { text: string }).text);
}

test("no sessions and no project dir: bootstrap seeds nothing", () => {
  const { root, sessionsRoot } = makeDirs();
  const result = bootstrapProjectSeed(root, CWD, sessionsRoot, 500);
  assert.deepEqual(result, { seeded: 0, ran: false });
  assert.equal(fs.existsSync(seedFilePath(root, CWD)), false);
});

test("empty project dir bootstraps from the project's transcripts", () => {
  const { root, sessionsRoot } = makeDirs();
  writeSession(sessionsRoot, DIR, "s1.jsonl", [
    "real prompt",
    "/compact",
    "   ",
    "second prompt",
  ]);
  const result = bootstrapProjectSeed(root, CWD, sessionsRoot, 500);
  assert.deepEqual(result, { seeded: 2, ran: true });
  // Chronological order (oldest first) in the seed file.
  assert.deepEqual(seedTexts(root), ["real prompt", "second prompt"]);
});

test("only the project's own session dir is scanned", () => {
  const { root, sessionsRoot } = makeDirs();
  writeSession(sessionsRoot, DIR, "s1.jsonl", ["mine"]);
  writeSession(sessionsRoot, "--Other--", "s2.jsonl", ["not mine"]);
  bootstrapProjectSeed(root, CWD, sessionsRoot, 500);
  assert.deepEqual(seedTexts(root), ["mine"]);
});

test("caps at the target keeping the newest", () => {
  const { root, sessionsRoot } = makeDirs();
  const texts: string[] = [];
  for (let i = 1; i <= 600; i++) texts.push(`p${i}`);
  writeSession(sessionsRoot, DIR, "big.jsonl", texts);
  const result = bootstrapProjectSeed(root, CWD, sessionsRoot, 500);
  assert.deepEqual(result, { seeded: 500, ran: true });
  const all = seedTexts(root);
  assert.equal(all.length, 500);
  assert.equal(all[0], "p101"); // oldest kept
  assert.equal(all[499], "p600"); // newest
});

test("project dir already populated above target: no scan, seed untouched", () => {
  const { root, sessionsRoot } = makeDirs();
  const dir = path.join(root, "projects", projectHash(CWD));
  fs.mkdirSync(dir, { recursive: true });
  const existing = path.join(dir, "existing.jsonl");
  fs.writeFileSync(
    existing,
    `${Array.from({ length: 500 }, (_, i) =>
      JSON.stringify({ v: 1, text: `e${i}` }),
    ).join("\n")}\n`,
    "utf8",
  );
  const marker = writeSession(sessionsRoot, DIR, "s.jsonl", ["marker"]);
  fs.utimesSync(
    marker,
    new Date(Date.now() + 5000),
    new Date(Date.now() + 5000),
  );
  const result = bootstrapProjectSeed(root, CWD, sessionsRoot, 500);
  assert.deepEqual(result, { seeded: 0, ran: false });
  assert.deepEqual(seedTexts(root), []);
  assert.equal(fs.readFileSync(existing, "utf8").includes("marker"), false);
});

// node:test has no test.skipIf (Bun-ism): root skips via the options
// object — chmod 000 is invisible to the superuser.
const sealedStoreTest = (name: string, fn: () => void) =>
  test(
    name,
    { skip: process.getuid?.() === 0 ? "requires non-root" : false },
    fn,
  );
sealedStoreTest(
  "an unreadable existing store file is skipped during counting; seeding still runs from transcripts",
  () => {
    const { root, sessionsRoot } = makeDirs();
    const dir = path.join(root, "projects", projectHash(CWD));
    fs.mkdirSync(dir, { recursive: true });
    const sealed = path.join(dir, "sealed.jsonl");
    fs.writeFileSync(
      sealed,
      `${JSON.stringify({ v: 1, text: "sealed-entry" })}\n`,
      "utf8",
    );
    fs.chmodSync(sealed, 0o000);
    writeSession(sessionsRoot, DIR, "s1.jsonl", ["from transcript"]);
    try {
      // The unreadable file contributes zero to existingCount, so the count
      // stays under target and the transcript scan still runs. No throw.
      const result = bootstrapProjectSeed(root, CWD, sessionsRoot, 500);
      assert.deepEqual(result, { seeded: 1, ran: true });
      assert.deepEqual(seedTexts(root), ["from transcript"]);
    } finally {
      fs.chmodSync(sealed, 0o644); // restore before cleanup
    }
  },
);
