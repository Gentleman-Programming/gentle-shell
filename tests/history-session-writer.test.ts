import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendSessionCapture,
  openSessionWriter,
  projectHash,
  sessionFilePath,
} from "../extensions/history/store.ts";
import promptHistoryExtension, {
  captureEnabled,
} from "../extensions/history/index.ts";

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

function openWriterForTest(root: string, instanceId: string) {
  return openSessionWriter(root, CWD, instanceId);
}

/** Load the extension against a temp root and return the capture handler. */
function captureHandlerWith(env: NodeJS.ProcessEnv, root: string) {
  const registered: Array<[string, unknown]> = [];
  const pi = {
    on: (event: string, handler: unknown) => {
      registered.push([event, handler]);
    },
    // Slice-3+ wiring surface: the factory also registers the shortcut,
    // command, and tool_call dismissal; the capture handler stays the
    // first registration, so these no-ops only absorb the extra wiring.
    registerShortcut: () => {},
    registerCommand: () => {},
  };
  promptHistoryExtension(pi as never, {
    env,
    root,
    cwd: CWD,
    instanceId: "inst-entry",
    now: () => 1700000000000,
  });
  return registered[0][1] as (event: unknown) => void;
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

test("the extension entry wires capture first, then the selector surface", () => {
  // Module load must stay side-effect free (importing index.ts parses the
  // whole extension graph without touching the real ~/.pi store root).
  // Capture is registered first; the selector adds session_shutdown GC,
  // tool_call dismissal, the shortcut, and the /history command beside it.
  const registered: Array<[string, unknown]> = [];
  const pi = {
    on: (event: string, handler: unknown) => {
      registered.push([event, handler]);
    },
    registerShortcut: () => {},
    registerCommand: () => {},
  };
  promptHistoryExtension(pi as never);
  assert.deepEqual(
    registered.map(([event]) => event),
    ["before_agent_start", "session_shutdown", "tool_call"],
  );
  // The capture handler is callable but is NEVER invoked here: a real
  // invocation would run getWriter() against ~/.pi/agent/history.
  assert.equal(typeof registered[0][1], "function");
});

test("captureEnabled is a strict opt-in", () => {
  assert.equal(captureEnabled({}), false);
  assert.equal(captureEnabled({ GENTLE_PI_HISTORY_CAPTURE: "0" }), false);
  assert.equal(captureEnabled({ GENTLE_PI_HISTORY_CAPTURE: "false" }), false);
  assert.equal(captureEnabled({ GENTLE_PI_HISTORY_CAPTURE: "off" }), false);
  assert.equal(captureEnabled({ GENTLE_PI_HISTORY_CAPTURE: "yes" }), false);
  assert.equal(captureEnabled({ GENTLE_PI_HISTORY_CAPTURE: " 1 " }), true);
  assert.equal(captureEnabled({ GENTLE_PI_HISTORY_CAPTURE: "TRUE" }), true);
  assert.equal(captureEnabled({ GENTLE_PI_HISTORY_CAPTURE: "On" }), true);
});

test("the capture handler is a no-op unless the user opts in", () => {
  const root = makeRoot();
  const handler = captureHandlerWith({}, root);
  handler({ prompt: "sensitive prompt" });
  handler({ prompt: "another one" });
  // Nothing at all: no capture file, no project dir, no registry entry.
  assert.deepEqual(fs.readdirSync(root), []);
});

test("an opted-in session captures delivered prompts", () => {
  const root = makeRoot();
  const handler = captureHandlerWith({ GENTLE_PI_HISTORY_CAPTURE: "1" }, root);
  handler({ prompt: "hello store" });
  assert.deepEqual(fileTexts(sessionFilePath(root, CWD, "inst-entry")), [
    "hello store",
  ]);
});

test("disabling capture stops new lines and leaves existing files alone", () => {
  const root = makeRoot();
  const env: NodeJS.ProcessEnv = { GENTLE_PI_HISTORY_CAPTURE: "true" };
  const handler = captureHandlerWith(env, root);
  handler({ prompt: "kept" });
  const file = sessionFilePath(root, CWD, "inst-entry");
  assert.equal(fs.existsSync(file), true);
  delete env.GENTLE_PI_HISTORY_CAPTURE;
  handler({ prompt: "never written" });
  assert.deepEqual(fileTexts(file), ["kept"]);
});
