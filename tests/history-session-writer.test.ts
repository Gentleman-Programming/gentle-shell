import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendSessionCapture,
  projectHash,
  sessionFilePath,
} from "../extensions/history/store.ts";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-writer-"));
}

const CWD = "/pi-history-fixtures/project-a";

function fileTexts(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => (JSON.parse(l) as { text: string }).text);
}

test("no file is created until the first capture", () => {
  const root = makeRoot();
  const state = openWriterForTest(root, "sess-1");
  const file = sessionFilePath(root, CWD, "sess-1");
  assert.equal(fs.existsSync(file), false);
  assert.equal(state.lineCount, 0);
});

test("first capture lazily creates the file and appends one line", () => {
  const root = makeRoot();
  const state = openWriterForTest(root, "sess-1");
  appendSessionCapture(state, "hello world", 1234);
  const file = sessionFilePath(root, CWD, "sess-1");
  assert.equal(fs.existsSync(file), true);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.text, "hello world");
  assert.equal(parsed.ts, 1234);
  assert.equal(parsed.v, 1);
  assert.equal(state.lineCount, 1);
});

test("captures append in order; count tracks", () => {
  const root = makeRoot();
  const state = openWriterForTest(root, "sess-2");
  appendSessionCapture(state, "one");
  appendSessionCapture(state, "two");
  appendSessionCapture(state, "three");
  assert.deepEqual(fileTexts(sessionFilePath(root, CWD, "sess-2")), [
    "one",
    "two",
    "three",
  ]);
  assert.equal(state.lineCount, 3);
});

test("command-like and empty captures are skipped", () => {
  const root = makeRoot();
  const state = openWriterForTest(root, "sess-3");
  appendSessionCapture(state, "/compact");
  appendSessionCapture(state, "   ");
  appendSessionCapture(state, "");
  appendSessionCapture(state, "kept");
  assert.deepEqual(fileTexts(sessionFilePath(root, CWD, "sess-3")), ["kept"]);
  assert.equal(state.lineCount, 1);
});

test("two writers own separate files in the same project dir", () => {
  const root = makeRoot();
  const a = openWriterForTest(root, "inst-a");
  const b = openWriterForTest(root, "inst-b");
  appendSessionCapture(a, "from-a");
  appendSessionCapture(b, "from-b");
  const dir = path.join(root, "projects", projectHash(CWD));
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ["inst-a.jsonl", "inst-b.jsonl"]);
});

// Helper kept local: openWriter is the U3 surface under test.
import { openSessionWriter } from "../extensions/history/store.ts";

function openWriterForTest(root: string, instanceId: string) {
  return openSessionWriter(root, CWD, instanceId);
}
