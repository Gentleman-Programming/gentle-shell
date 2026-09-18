import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapProjectSeed, seedFilePath } from "../extensions/history/store.ts";

// Fake project cwd (never created on disk): projectHash falls back to
// raw-string hashing for nonexistent paths, and the transcript dirName
// encoding derives from the same string.
const CWD = "/pi-history-test/seed-regen-project";
const DIR = "--pi-history-test-seed-regen-project--";

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "seed2-"));
  return {
    root: path.join(base, "h"),
    sessionsRoot: path.join(base, "sessions"),
    stateDir: path.join(base, "state"),
  };
}

function writeSession(sessionsRoot: string, texts: string[]): void {
  const dir = path.join(sessionsRoot, DIR);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session",
      version: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
  ];
  let ms = 1700000000000;
  for (const text of texts) {
    lines.push(
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: text, timestamp: ms++ },
      }),
    );
  }
  fs.writeFileSync(path.join(dir, "s1.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

test("an existing seed is never regenerated (deleted prompts stay gone)", () => {
  const { root, sessionsRoot } = setup();
  writeSession(sessionsRoot, ["keep", "delete-me"]);
  bootstrapProjectSeed(root, CWD, sessionsRoot, 500);
  // User deletes "delete-me" from the seed file (scope delete).
  const seed = seedFilePath(root, CWD);
  const kept = fs
    .readFileSync(seed, "utf8")
    .split("\n")
    .filter((l) => !l.includes("delete-me"))
    .join("\n");
  fs.writeFileSync(seed, kept, "utf8");
  // A NEW session bootstraps again -> must not resurrect from transcripts.
  const again = bootstrapProjectSeed(root, CWD, sessionsRoot, 500);
  assert.deepEqual(again, { seeded: 0, ran: false });
  const texts = fs
    .readFileSync(seed, "utf8")
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { text: string }).text);
  assert.deepEqual(texts, ["keep"]);
});

test("tombstoned prompts are not seeded from transcripts", () => {
  const { root, sessionsRoot, stateDir } = setup();
  writeSession(sessionsRoot, ["visible", "hidden-prompt"]);
  // Tombstone "hidden-prompt" (same key shape hide-prompts writes).
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "hidden.json"),
    JSON.stringify(["hidden-prompt"]),
    "utf8",
  );
  bootstrapProjectSeed(root, CWD, sessionsRoot, 500, stateDir);
  const texts = fs
    .readFileSync(seedFilePath(root, CWD), "utf8")
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { text: string }).text);
  assert.deepEqual(texts, ["visible"]);
});
