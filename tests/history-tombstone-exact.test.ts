import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hidePrompt,
  readHiddenPrompts,
  tombstoneKey,
} from "../extensions/history/hide-prompts.ts";
import {
  bootstrapProjectSeed,
  drainGlobal,
  drainProject,
  projectHash,
  seedFilePath,
} from "../extensions/history/store.ts";

// Exact tombstones (PR #1393 adaptation): a deletion hides ONLY the exact
// normalized prompt (whitespace-collapsed, trimmed, case-insensitive) —
// never every prompt that shares a 120-character prefix. hidden.json keeps
// its JSON-array-of-strings shape; new entries are hashes, and plaintext
// entries written by the earlier prefix format stay readable and honored.

const CWD = "/pi-history-test/tombstone-exact";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-tomb-"));
}

function writeLines(file: string, texts: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${texts.map((t) => JSON.stringify({ v: 1, text: t })).join("\n")}\n`,
    "utf8",
  );
}

function drainedProject(root: string): string[] {
  const drained = drainProject(root, CWD, 1000, root);
  assert.equal(drained.status, "ok");
  if (drained.status !== "ok") throw new Error("unreachable");
  return drained.prompts;
}

const PREFIX = `${"shared context ".repeat(10)}`; // 150 chars, > 120
const LONG_A = `${PREFIX}then deploy staging`;
const LONG_B = `${PREFIX}then deploy production`;

test("tombstoneKey normalizes whitespace and case but never truncates", () => {
  assert.equal(tombstoneKey("Fix\t the   BUILD "), tombstoneKey("fix the build"));
  assert.notEqual(tombstoneKey(LONG_A), tombstoneKey(LONG_B));
  assert.match(tombstoneKey("fix the build"), /^sha256:[0-9a-f]{64}$/);
});

test("hidden.json stores a hash, never the deleted prompt's text", () => {
  const root = makeRoot();
  assert.deepEqual(hidePrompt(root, "my secret token abc123"), {
    status: "written",
  });
  const raw = fs.readFileSync(path.join(root, "hidden.json"), "utf8");
  assert.equal(raw.includes("secret"), false);
  assert.deepEqual(JSON.parse(raw), [tombstoneKey("my secret token abc123")]);
});

test("hiding one long prompt keeps a sibling that shares its 120-char prefix", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(CWD));
  writeLines(path.join(dir, "s.jsonl"), [LONG_A, LONG_B, "short keep"]);
  assert.deepEqual(hidePrompt(root, LONG_A), { status: "written" });

  const prompts = drainedProject(root);
  assert.equal(prompts.includes(LONG_A), false, "the deleted prompt stays hidden");
  assert.ok(prompts.includes(LONG_B), "the prefix sibling must stay visible");
  assert.ok(prompts.includes("short keep"));

  const global = drainGlobal(root, 1000, root);
  assert.equal(global.status, "ok");
  if (global.status !== "ok") throw new Error("unreachable");
  assert.equal(global.prompts.includes(LONG_A), false);
  assert.ok(global.prompts.includes(LONG_B));
});

test("a tombstone hides whitespace and case variants of the exact prompt", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(CWD));
  writeLines(path.join(dir, "s.jsonl"), ["Deploy   THE api", "deploy the api now"]);
  hidePrompt(root, "deploy the api");
  assert.deepEqual(drainedProject(root), ["deploy the api now"]);
});

test("plaintext entries from the earlier prefix format stay readable and honored", () => {
  const root = makeRoot();
  const dir = path.join(root, "projects", projectHash(CWD));
  writeLines(path.join(dir, "s.jsonl"), ["Legacy   Hidden", "visible prompt"]);
  // The earlier writer stored promptDedupKey output: the whitespace-
  // collapsed, 120-char, lowercased text.
  fs.writeFileSync(
    path.join(root, "hidden.json"),
    JSON.stringify(["legacy hidden"]),
    "utf8",
  );
  assert.equal(readHiddenPrompts(root).status, "trusted");
  assert.deepEqual(drainedProject(root), ["visible prompt"]);

  // A new hide appends a hash entry and preserves the legacy entry.
  hidePrompt(root, "visible prompt");
  const stored = JSON.parse(
    fs.readFileSync(path.join(root, "hidden.json"), "utf8"),
  );
  assert.deepEqual(stored, ["legacy hidden", tombstoneKey("visible prompt")]);
  assert.deepEqual(drainedProject(root), []);
});

test("seed bootstrap skips an exact tombstone but seeds its prefix sibling", () => {
  const root = makeRoot();
  const sessionsRoot = path.join(root, "sessions");
  const sessions = path.join(sessionsRoot, "--pi-history-test-tombstone-exact--");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, "s.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3 }),
      JSON.stringify({ type: "message", message: { role: "user", content: LONG_A } }),
      JSON.stringify({ type: "message", message: { role: "user", content: LONG_B } }),
    ].join("\n") + "\n",
  );
  hidePrompt(root, LONG_A);

  const result = bootstrapProjectSeed(root, CWD, sessionsRoot, 500, root);
  assert.deepEqual(result, { seeded: 1, ran: true });
  const seeded = fs
    .readFileSync(seedFilePath(root, CWD), "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { text: string }).text);
  assert.deepEqual(seeded, [LONG_B]);
});
