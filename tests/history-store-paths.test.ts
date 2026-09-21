import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  globalSeedPath,
  projectDir,
  projectHash,
  registryPath,
  seedFilePath,
  sessionFilePath,
} from "../extensions/history/store.ts";

const ROOT = path.join(os.tmpdir(), "pi-history-test-root");

test("projectHash returns 16 lowercase hex chars", () => {
  const hash = projectHash("/Users/admin/Dev/pi/pi-history");
  assert.match(hash, /^[0-9a-f]{16}$/);
});

test("known vector: stable hash for a fixed path", () => {
  assert.equal(
    projectHash("/Users/admin/Dev/pi/pi-history"),
    "28e0f06819c468cb",
  );
});

test("distinct paths produce distinct hashes", () => {
  assert.notEqual(
    projectHash("/Users/admin/Dev/pi/pi-history"),
    projectHash("/Users/admin/Dev/github/pi"),
  );
});

test("symlinked cwd resolves to the same hash as its target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paths-sym-"));
  const target = path.join(dir, "real-project");
  fs.mkdirSync(target);
  const link = path.join(dir, "link-project");
  fs.symlinkSync(target, link);
  assert.equal(projectHash(link), projectHash(target));
});

test("trailing slash does not change the identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paths-slash-"));
  assert.equal(projectHash(dir), projectHash(`${dir}/`));
});

test("nonexistent path falls back to hashing the raw string (no throw)", () => {
  const missing = path.join(os.tmpdir(), "paths-missing-does-not-exist");
  const hash = projectHash(missing);
  assert.match(hash, /^[0-9a-f]{16}$/);
});

test("path derivations compose under the root", () => {
  const cwd = "/Users/admin/Dev/pi/pi-history";
  const hash = projectHash(cwd);
  assert.equal(projectDir(ROOT, cwd), path.join(ROOT, "projects", hash));
  assert.equal(
    sessionFilePath(ROOT, cwd, "abc-123"),
    path.join(ROOT, "projects", hash, "abc-123.jsonl"),
  );
  assert.equal(
    seedFilePath(ROOT, cwd),
    path.join(ROOT, "projects", hash, "seed.jsonl"),
  );
  assert.equal(globalSeedPath(ROOT), path.join(ROOT, "history-global.jsonl"));
  assert.equal(registryPath(ROOT), path.join(ROOT, "registry.json"));
});

test("two cwds map to sibling project dirs", () => {
  const a = projectDir(ROOT, "/Users/admin/Dev/pi/pi-history");
  const b = projectDir(ROOT, "/Users/admin/Dev/github/pi");
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), path.dirname(b));
});
