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
} from "../extensions/history/store.ts";

const CWD = "/Users/admin/Dev/pi/pi-history";

function write(file: string, texts: string[], ts = 100): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${texts.map((t) => JSON.stringify({ v: 1, text: t, ts })).join("\n")}\n`,
    "utf8",
  );
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

  assert.deepEqual(drainProject(root, CWD, 1000, stateDir), [
    "also keep",
    "keep",
  ]);
  assert.deepEqual(drainGlobal(root, 1000, stateDir), [
    "also keep",
    "keep",
    "legacy keep",
  ]);
  // Without a stateDir the filter is off (raw drain semantics).
  assert.equal(drainProject(root, CWD).includes("deleted from seed"), true);
});
