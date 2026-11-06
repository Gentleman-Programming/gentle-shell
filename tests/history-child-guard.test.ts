import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import promptHistoryExtension from "../extensions/history/index.ts";

// gentle-shell#1690: delegated children (GENTLE_PI_AGENTS_CHILD=1) receive
// the package too. Their before_agent_start prompt is a delegation brief,
// not user history, so a child must never initialize, capture or GC the
// store, even when capture is opted in. The selector may still register.

const CWD = "/pi-history-test/project-child";

type Handler = (...args: unknown[]) => unknown;

function load(child: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-child-"));
  const handlers = new Map<string, Handler[]>();
  const commands: string[] = [];
  const shortcuts: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerShortcut: (key: string) => { shortcuts.push(key); },
    registerCommand: (name: string) => { commands.push(name); },
  };
  promptHistoryExtension(pi as never, {
    env: { GENTLE_PI_HISTORY_CAPTURE: "1", GENTLE_PI_AGENTS_CHILD: child ? "1" : "0" },
    root,
    cwd: CWD,
    instanceId: `inst-${child ? "child" : "parent"}`,
    now: () => 1700000000000,
    agentDir: path.join(root, "agent"),
    sessionsRoot: path.join(root, "sessions"),
    gentlePiConfigHome: fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-child-config-")),
  });
  const fire = async (name: string, event: unknown) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, {});
  };
  return { root, fire, commands, shortcuts };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a delegated child never initializes, captures or GCs prompt history", async () => {
  const { root, fire, commands, shortcuts } = load(true);
  await flush();
  assert.deepEqual(fs.readdirSync(root), [], "no warm-up writer init");
  await fire("before_agent_start", { prompt: "delegated task brief" });
  assert.deepEqual(fs.readdirSync(root), [], "no prompt capture");
  await fire("session_shutdown", {});
  assert.deepEqual(fs.readdirSync(root), [], "no GC rewrite");
  assert.deepEqual(commands, ["history"]);
  assert.equal(shortcuts.length, 1);
});

test("an opted-in parent still captures prompt history", async () => {
  const { root, fire } = load(false);
  await flush();
  await fire("before_agent_start", { prompt: "parent prompt" });
  const files = fs.readdirSync(root, { recursive: true }).map(String);
  assert.ok(files.length > 0, "the parent initializes its store");
  const captured = files
    .map((file) => path.join(root, file))
    .filter((file) => fs.statSync(file).isFile())
    .some((file) => fs.readFileSync(file, "utf8").includes("parent prompt"));
  assert.ok(captured, `the parent prompt is persisted: ${JSON.stringify(files)}`);
});
