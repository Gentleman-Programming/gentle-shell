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
  type DrainResult,
} from "../extensions/history/store.ts";

// Portable project identity: a never-existing literal. projectHash falls
// back to hashing the raw string when realpath fails, so the identity is
// deterministic on every machine (no machine-specific absolute paths).

const CWD = "/pi-history-test/drain-hidden-project";

function write(file: string, texts: string[], ts = 100): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${texts.map((t) => JSON.stringify({ v: 1, text: t, ts })).join("\n")}\n`,
    "utf8",
  );
}

// Unwrap the ok shape. Drains FAIL CLOSED: the blocked variant carries no
// prompts field at all (asserted in the blocked test below).
function okPrompts(result: DrainResult): string[] {
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("unreachable");
  return result.prompts;
}

test("drains skip tombstoned prompts in seeds and session files", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hid-"));
  const root = path.join(base, "h");
  const stateDir = path.join(base, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "hidden.json"),
    JSON.stringify(["deleted from seed", "deleted from session"]),
    "utf8",
  );
  const dir = path.join(root, "projects", projectHash(CWD));
  write(path.join(dir, "seed.jsonl"), ["keep", "deleted from seed"], 100);
  write(path.join(dir, "s1.jsonl"), ["also keep", "deleted from session"], 200);
  write(globalSeedPath(root), ["deleted from seed", "legacy keep"], 50);

  assert.deepEqual(okPrompts(drainProject(root, CWD, 1000, stateDir)), [
    "also keep",
    "keep",
  ]);
  assert.deepEqual(okPrompts(drainGlobal(root, 1000, stateDir)), [
    "also keep",
    "keep",
    "legacy keep",
  ]);
  // Without a stateDir the filter is off (raw drain semantics).
  assert.equal(
    okPrompts(drainProject(root, CWD)).includes("deleted from seed"),
    true,
  );
});

// Fail-closed seam: an untrusted hidden.json BLOCKS both drains with the
// recovery message and no prompts field; a stateDir whose hidden.json is
// MISSING stays the safe empty-tombstones case (the full expected prompts).
test("corrupt hidden.json blocks both drains with no prompts field; a missing file drains normally", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hid-blocked-"));
  const root = path.join(base, "h");
  const stateDir = path.join(base, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "hidden.json"),
    "{corrupt bytes",
    "utf8",
  );
  const dir = path.join(root, "projects", projectHash(CWD));
  write(path.join(dir, "seed.jsonl"), ["secret prompt", "keeper"], 100);

  for (const result of [
    drainProject(root, CWD, 1000, stateDir),
    drainGlobal(root, 1000, stateDir),
  ]) {
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") throw new Error("unreachable");
    assert.ok(result.message.includes("hidden.json"));
    // The blocked shape carries no prompts to render.
    assert.equal("prompts" in result, false);
  }

  // Missing file: safe empty tombstones — the full drain comes back.
  const missingBase = fs.mkdtempSync(path.join(os.tmpdir(), "hid-missing-"));
  const missingRoot = path.join(missingBase, "h");
  const missingState = path.join(missingBase, "state");
  fs.mkdirSync(missingState, { recursive: true });
  const missingDir = path.join(missingRoot, "projects", projectHash(CWD));
  write(path.join(missingDir, "seed.jsonl"), ["kept", "shown"], 100);
  assert.deepEqual(
    okPrompts(drainProject(missingRoot, CWD, 1000, missingState)),
    ["shown", "kept"],
  );
  assert.deepEqual(okPrompts(drainGlobal(missingRoot, 1000, missingState)), [
    "shown",
    "kept",
  ]);
});
