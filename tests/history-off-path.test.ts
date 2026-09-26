import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import promptHistoryExtension from "../extensions/history/index.ts";

// The module-level selector gate reads process.env directly (that path has
// no deps.env injection); keep the suite hermetic regardless of the ambient
// shell so the off-path assertions cannot be flipped by the environment.
delete process.env.GENTLE_PI_HISTORY_CAPTURE;

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-off-"));
}

const CWD = "/pi-history-test/project-off";

interface Harness {
  commandHandler: (args: unknown, ctx: unknown) => Promise<void>;
}

/**
 * Load the extension against a temp root and capture the registered
 * shortcut + history command handlers from the fake pi.
 */
function loadWithCommand(env: NodeJS.ProcessEnv, root: string): Harness {
  const shortcuts: Array<[string, { handler: unknown }]> = [];
  const commands: Array<[string, { handler: unknown }]> = [];
  const pi = {
    on: () => {},
    registerShortcut: (key: string, def: { handler: unknown }) => {
      shortcuts.push([key, def]);
    },
    registerCommand: (name: string, def: { handler: unknown }) => {
      commands.push([name, def]);
    },
  };
  promptHistoryExtension(pi as never, {
    env,
    root,
    cwd: CWD,
    instanceId: "inst-off",
    now: () => 1700000000000,
    // Keep any opted-in warm-up away from the real ~/.pi/agent.
    agentDir: path.join(root, "agent"),
    sessionsRoot: path.join(root, "sessions"),
  });
  const command = commands.find(([name]) => name === "history");
  assert.ok(command, "the history command must be registered");
  assert.equal(shortcuts.length, 1, "the shortcut must still be registered");
  return {
    commandHandler: command[1].handler as Harness["commandHandler"],
  };
}

function fakeCtx(notifyCalls: Array<[string, string]>) {
  return {
    ui: {
      notify: (message: string, level: string) => {
        notifyCalls.push([message, level]);
      },
    },
  };
}

// The open flow reads the injected deps (env/root/cwd), never the module
// defaults, so the enabled direction is testable against a temp root too.

test("with capture disabled, extension load writes nothing", async () => {
  const root = makeRoot();
  loadWithCommand({}, root);
  // Flush the setImmediate warm-up.
  await new Promise((resolve) => setImmediate(resolve));
  // Nothing at all: no registry, no seed, no store file.
  assert.deepEqual(fs.readdirSync(root), []);
});

test("with capture disabled, the history command imports nothing and warns", async () => {
  const root = makeRoot();
  const { commandHandler } = loadWithCommand({}, root);
  await new Promise((resolve) => setImmediate(resolve));
  const notifyCalls: Array<[string, string]> = [];
  await commandHandler([], fakeCtx(notifyCalls));
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0][1], "warning");
  assert.ok(
    notifyCalls[0][0].includes("GENTLE_PI_HISTORY_CAPTURE"),
    `the warning must name the switch, got: ${notifyCalls[0][0]}`,
  );
  // The gate must fire before the drain: no migration, no seed, no store.
  assert.deepEqual(fs.readdirSync(root), []);
});

test("with capture enabled, opening the selector reads without initializing the store", async () => {
  const root = makeRoot();
  const { commandHandler } = loadWithCommand({ GENTLE_PI_HISTORY_CAPTURE: "1" }, root);
  // Open before the opted-in warm-up tick: the open flow alone must not
  // migrate, register, seed, or create a capture file.
  const notifyCalls: Array<[string, string]> = [];
  await commandHandler([], fakeCtx(notifyCalls));
  assert.deepEqual(notifyCalls, [["No prompt history available.", "warning"]]);
  assert.deepEqual(fs.readdirSync(root), []);
});
