import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

// Source-parsing tests (preview-layout.test.ts pattern): never import
// src/index.ts — it pulls the pi-tui runtime graph (design §D3).

const sourcePath = fileURLToPath(new URL("../extensions/history/index.ts", import.meta.url));
const source = fs.readFileSync(sourcePath, "utf8");

test("openHistorySelector is extracted once and shared by both entry points", () => {
  const definitions =
    source.split("async function openHistorySelector(").length - 1;
  assert.strictEqual(
    definitions,
    1,
    "openHistorySelector should be defined exactly once",
  );

  const calls = source.split("openHistorySelector(ctx)").length - 1;
  assert.strictEqual(
    calls,
    2,
    "registerShortcut and registerCommand handlers should both call openHistorySelector(ctx)",
  );

  const start = source.indexOf("async function openHistorySelector(");
  const end = source.indexOf("export default function", start);
  assert.notStrictEqual(end, -1, "extension entry point should follow");
  const body = source.slice(start, end);
  assert.ok(
    !body.includes('"No prompt history available."'),
    "the warning is removed; the selector always opens (AC-P1-5.2)",
  );
});

test("the /history command is registered beside the shortcut", () => {
  const index = source.indexOf('pi.registerCommand("history"');
  assert.ok(index >= 0, 'pi.registerCommand("history", ...) should exist');

  const slice = source.slice(index, index + 200);
  assert.ok(
    slice.includes('"Search prompt history"'),
    "command should carry the same description as the shortcut",
  );
  assert.ok(
    slice.includes("openHistorySelector(ctx)"),
    "command handler should route through the shared entry point",
  );
});

test("in-UI hint describes multi-word AND substring matching, not fuzzy", () => {
  assert.ok(
    !source.includes("fzf-style fuzzy match"),
    "the fzf-style fuzzy match claim must be removed (AC-P1-6.1)",
  );
  assert.ok(
    source.includes("multi-word AND substring"),
    "hint should describe multi-word AND substring filtering (AC-P1-6.1)",
  );
});

test("writer init is scheduled off the first-prompt path via setImmediate", () => {
  const entry = source.indexOf("export default function promptHistoryExtension");
  assert.notStrictEqual(entry, -1, "extension entry point should exist");

  const body = source.slice(entry);
  assert.ok(
    body.includes("setImmediate(() => {"),
    "init must be scheduled with setImmediate so bootstrap never runs on\nthe first-prompt path",
  );
  assert.ok(
    /setImmediate\(\(\) => \{[\s\S]*?getWriter\(\);/.test(body),
    "the scheduled callback should warm getWriter()",
  );
  // The synchronous fallback stays: a prompt arriving before the
  // scheduled call still initializes lazily inside the capture handler.
  assert.ok(
    /before_agent_start[\s\S]*?appendSessionCapture\(getWriter\(\)/.test(body),
    "capture handler keeps the synchronous getWriter() fallback",
  );
});
