import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureRegistryEntry,
  lookupCwd,
  projectHash,
  registryPath,
} from "../extensions/history/store.ts";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-registry-"));
}

function makeProject(prefix = "pi-history-registry-proj-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("creates the registry with the first entry (idempotent)", () => {
  const root = makeRoot();
  const cwd = makeProject();
  const result = ensureRegistryEntry(root, cwd);
  assert.deepEqual(result, { hash: projectHash(cwd), created: true });
  ensureRegistryEntry(root, cwd);
  const raw = JSON.parse(
    fs.readFileSync(path.join(root, "registry.json"), "utf8"),
  );
  assert.deepEqual(raw, { [projectHash(cwd)]: cwd });
});

test("second project appends without touching the first", () => {
  const root = makeRoot();
  const cwdA = makeProject();
  const cwdB = makeProject();
  ensureRegistryEntry(root, cwdA);
  const b = ensureRegistryEntry(root, cwdB);
  assert.equal(b.created, true);
  const raw = JSON.parse(
    fs.readFileSync(path.join(root, "registry.json"), "utf8"),
  );
  assert.equal(Object.keys(raw).length, 2);
  assert.equal(raw[b.hash], cwdB);
});

test("lookupCwd resolves known hashes and null for unknown", () => {
  const root = makeRoot();
  const cwd = makeProject();
  const { hash } = ensureRegistryEntry(root, cwd);
  assert.equal(lookupCwd(root, hash), cwd);
  assert.equal(lookupCwd(root, "0000000000000000"), null);
  assert.equal(lookupCwd(makeRoot(), hash), null);
});

test("corrupt registry json is treated as empty and rebuilt on next entry", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "registry.json"), "{not-json", "utf8");
  assert.equal(lookupCwd(root, "0000000000000000"), null);
  const cwd = makeProject();
  const result = ensureRegistryEntry(root, cwd);
  assert.equal(result.created, true);
  const raw = JSON.parse(
    fs.readFileSync(path.join(root, "registry.json"), "utf8"),
  );
  assert.deepEqual(raw, { [projectHash(cwd)]: cwd });
});

test("no leftover tmp files after writes", () => {
  const root = makeRoot();
  ensureRegistryEntry(root, "/a");
  ensureRegistryEntry(root, "/b");
  const leftovers = fs.readdirSync(root).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("hash collision re-keys the existing occupant; the new cwd keeps the short hash", () => {
  const root = makeRoot();
  const cwd = makeProject();
  const hash = projectHash(cwd);
  // Simulate a collision: the short hash is pre-mapped to a different cwd.
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    registryPath(root),
    JSON.stringify({ [hash]: "/some/other/project" }),
    "utf8",
  );
  const result = ensureRegistryEntry(root, cwd);
  assert.deepEqual(result, { hash, created: true });
  const raw = JSON.parse(fs.readFileSync(registryPath(root), "utf8"));
  assert.equal(raw[hash], cwd);
  const longKeys = Object.keys(raw).filter((k) => k.length === 24);
  assert.equal(longKeys.length, 1);
  assert.equal(raw[longKeys[0]], "/some/other/project");
  assert.equal(lookupCwd(root, hash), cwd);
  assert.equal(lookupCwd(root, longKeys[0]), "/some/other/project");
});

test("wrong-shaped registry (array / scalar / null) fails open and is rebuilt on the next entry", () => {
  // Valid JSON, wrong shape: the readRegistry shape guard treats each as an
  // empty registry — lookups fail open to null, and the next entry rebuilds
  // a valid object-mapped registry around itself.
  const shapes: unknown[] = [["an", "array"], "scalar-string", null];
  const cwd = makeProject();
  for (const shape of shapes) {
    const root = makeRoot();
    fs.writeFileSync(registryPath(root), JSON.stringify(shape), "utf8");
    assert.equal(lookupCwd(root, projectHash(cwd)), null);
    const result = ensureRegistryEntry(root, cwd);
    assert.deepEqual(result, { hash: projectHash(cwd), created: true });
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, "registry.json"), "utf8"),
    );
    assert.deepEqual(raw, { [projectHash(cwd)]: cwd });
  }
});
