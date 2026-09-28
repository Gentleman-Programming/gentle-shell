import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../extensions/history/atomic-write.ts";

// Shared atomic writer (design §D3): tmp+rename in the TARGET's directory.
// Fixtures live under the OS temp dir — never the workspace tmp. Failure
// paths exercise the catch branch: false return, no throw, and the staging
// file unlinked so `.tmp-*` files never accumulate beside the target.

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
}

function tmpLeftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
}

test("success: missing parent dirs are created recursively and the JSON parses back", () => {
  const root = makeRoot();
  const target = path.join(root, "deep", "nested", "state.json");
  const value = { key: "value", nested: { n: 1 } };
  assert.equal(writeJsonAtomic(target, value), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), value);
  assert.deepEqual(tmpLeftovers(path.dirname(target)), []);
});

test("a parent chain holding a regular file (ENOTDIR) returns false without throwing", () => {
  const root = makeRoot();
  const blocker = path.join(root, "blocker");
  fs.writeFileSync(blocker, "regular file", "utf8");
  const target = path.join(blocker, "child", "state.json");
  assert.equal(writeJsonAtomic(target, { a: 1 }), false);
  assert.equal(fs.existsSync(target), false);
});

test("an existing directory as the target fails the rename: false and no leftover staging file", () => {
  const root = makeRoot();
  const target = path.join(root, "state.json");
  fs.mkdirSync(target, { recursive: true });
  assert.equal(writeJsonAtomic(target, { a: 1 }), false);
  // The catch branch unlinked its staging file — no `.tmp-*` accumulation.
  assert.deepEqual(tmpLeftovers(root), []);
  // The directory itself is untouched.
  assert.equal(fs.statSync(target).isDirectory(), true);
});

test("overwrite of an existing target replaces the content", () => {
  const root = makeRoot();
  const target = path.join(root, "state.json");
  assert.equal(writeJsonAtomic(target, { v: 1 }), true);
  assert.equal(writeJsonAtomic(target, { v: 2 }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { v: 2 });
  assert.deepEqual(tmpLeftovers(root), []);
});
