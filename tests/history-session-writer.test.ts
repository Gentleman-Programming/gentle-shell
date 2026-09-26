import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendSessionCapture,
  openSessionWriter,
  projectHash,
  seedFilePath,
  sessionFilePath,
} from "../extensions/history/store.ts";
import promptHistoryExtension, { captureEnabled } from "../extensions/history/index.ts";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-writer-"));
}

const CWD = "/pi-history-test/project-a";

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

/** Load the extension against a temp root and return its event handlers. */
function handlersWith(
  env: NodeJS.ProcessEnv,
  root: string,
): Map<string, (event: unknown) => void> {
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
    agentDir: path.join(root, "agent"),
    sessionsRoot: path.join(root, "sessions"),
  });
  return new Map(
    registered.map(([event, handler]) => [
      event,
      handler as (event: unknown) => void,
    ]),
  );
}

/** Load the extension against a temp root and return the capture handler. */
function captureHandlerWith(env: NodeJS.ProcessEnv, root: string) {
  const handler = handlersWith(env, root).get("before_agent_start");
  assert.ok(handler, "the capture handler is registered");
  return handler;
}

/** Fill the project dir past the default GC file threshold (50 files). */
function fillProjectDir(root: string, files: number): string {
  const dir = path.join(root, "projects", projectHash(CWD));
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= files; i++) {
    const file = path.join(dir, `peer-${String(i).padStart(3, "0")}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ v: 1, text: `peer ${i}` })}\n`);
    fs.utimesSync(file, new Date(i * 1000), new Date(i * 1000));
  }
  return dir;
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

test("the extension entry registers exactly the slice-6 wiring surface", () => {
  // Module load must stay side-effect free (importing index.ts parses the
  // whole graph without touching the real ~/.pi store root). Wiring as of
  // slice 6: before_agent_start capture, session_shutdown GC, tool_call
  // overlay dismiss, the ctrl+shift+r shortcut, and the history command.
  const registered: Array<[string, unknown]> = [];
  const shortcuts: Array<[string, unknown]> = [];
  const commands: Array<[string, unknown]> = [];
  const pi = {
    on: (event: string, handler: unknown) => {
      registered.push([event, handler]);
    },
    registerShortcut: (key: string, def: unknown) => {
      shortcuts.push([key, def]);
    },
    registerCommand: (name: string, def: unknown) => {
      commands.push([name, def]);
    },
  };
  promptHistoryExtension(pi as never);
  assert.deepEqual(
    registered.map(([event]) => event),
    ["before_agent_start", "session_shutdown", "tool_call"],
  );
  assert.deepEqual(shortcuts.map(([key]) => key), ["ctrl+shift+r"]);
  assert.deepEqual(commands.map(([name]) => name), ["history"]);
  // Handlers are callable but are NEVER invoked here: a real invocation
  // would run getWriter() against the user's real ~/.pi/agent/history.
  for (const [, handler] of registered) {
    assert.equal(typeof handler, "function");
  }
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
  // The unshipped rename from the contributor branch is not a switch.
  assert.equal(captureEnabled({ [`GENTLE_PI_HISTORY_${"ENABLE"}`]: "1" }), false);
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

test("opted-in capture imports into its own root and defers seed on untrusted tombstones", () => {
  const root = makeRoot();
  const sessions = path.join(root, "sessions", "--pi-history-test-project-a--");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "s.jsonl"), [
    JSON.stringify({ type: "session", version: 3 }),
    JSON.stringify({ type: "message", message: { role: "user", content: "transcript prompt" } }),
  ].join("\n") + "\n");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "editor-history.jsonl"),
    JSON.stringify({ v: 1, text: "legacy prompt" }) + "\n");
  fs.writeFileSync(path.join(root, "hidden.json"), "{invalid");
  const handler = captureHandlerWith({ GENTLE_PI_HISTORY_CAPTURE: "1" }, root);
  handler({ prompt: "current prompt" });
  assert.deepEqual(fileTexts(path.join(root, "history-global.jsonl")), ["legacy prompt"]);
  assert.equal(fs.existsSync(seedFilePath(root, CWD)), false);
  assert.deepEqual(fileTexts(sessionFilePath(root, CWD, "inst-entry")), ["current prompt"]);
  fs.writeFileSync(path.join(root, "hidden.json"), JSON.stringify(["transcript prompt"]));
  // A new instance retries bootstrap after tombstones become trusted.
  captureHandlerWith({ GENTLE_PI_HISTORY_CAPTURE: "1" }, root)({ prompt: "next prompt" });
  assert.equal(fs.existsSync(seedFilePath(root, CWD)), false);
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

test("session_shutdown GC is a no-op while capture is off", () => {
  const root = makeRoot();
  const dir = fillProjectDir(root, 60);
  const before = fs.readdirSync(dir).sort();
  const shutdown = handlersWith({}, root).get("session_shutdown");
  assert.ok(shutdown, "the shutdown handler is registered");
  shutdown({});
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.deepEqual(fs.readdirSync(root).sort(), ["projects"]);
});

test("session_shutdown GC compacts the injected root and keeps its own file", () => {
  const root = makeRoot();
  const dir = fillProjectDir(root, 60);
  // This instance's own capture file is the oldest one in the dir.
  const own = sessionFilePath(root, CWD, "inst-entry");
  fs.writeFileSync(own, `${JSON.stringify({ v: 1, text: "own" })}\n`);
  fs.utimesSync(own, new Date(1), new Date(1));
  const shutdown = handlersWith({ GENTLE_PI_HISTORY_CAPTURE: "1" }, root).get(
    "session_shutdown",
  );
  assert.ok(shutdown, "the shutdown handler is registered");
  shutdown({});
  const names = fs.readdirSync(dir);
  // Default policy: the newest 10 peers stay, the other 50 merge into one
  // compact file, and the own file is never a merge candidate.
  assert.equal(names.filter((n) => n.startsWith("compact-")).length, 1);
  assert.equal(names.filter((n) => n.startsWith("peer-")).length, 10);
  assert.equal(fs.existsSync(own), true);
  assert.deepEqual(fileTexts(own), ["own"]);
});
