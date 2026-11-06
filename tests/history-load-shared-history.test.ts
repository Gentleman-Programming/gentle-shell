import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSharedHistory } from "../extensions/history/load-shared-history.ts";

function makeTempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-load-"));
  const file = path.join(dir, "editor-history.json");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

test("returns empty array when file is missing", () => {
  assert.deepEqual(loadSharedHistory("/definitely/missing.json"), []);
});

test("returns empty array for malformed json", () => {
  const file = makeTempFile("{not-json");
  assert.deepEqual(loadSharedHistory(file), []);
});

test("supports string entries", () => {
  const file = makeTempFile(JSON.stringify(["one", "two"]));
  assert.deepEqual(loadSharedHistory(file), ["one", "two"]);
});

test("supports object entries with text field", () => {
  const file = makeTempFile(JSON.stringify([{ text: "one" }, { text: "two" }]));
  assert.deepEqual(loadSharedHistory(file), ["one", "two"]);
});

test("ignores malformed object entries", () => {
  const file = makeTempFile(
    JSON.stringify([{ text: "one" }, { text: 2 }, { nope: "three" }]),
  );
  assert.deepEqual(loadSharedHistory(file), ["one"]);
});

test("ignores empty string entries", () => {
  const file = makeTempFile(
    JSON.stringify(["", "one", { text: "" }, { text: "two" }]),
  );
  assert.deepEqual(loadSharedHistory(file), ["one", "two"]);
});

test("keeps only valid strings from mixed arrays", () => {
  const file = makeTempFile(
    JSON.stringify(["one", null, false, 42, { text: "two" }, { text: 1 }]),
  );
  assert.deepEqual(loadSharedHistory(file), ["one", "two"]);
});
