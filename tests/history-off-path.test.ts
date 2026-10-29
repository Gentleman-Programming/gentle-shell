import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import promptHistoryExtension from "../extensions/history/index.ts";
import { writeHistoryCapturePolicy } from "../lib/history-capture-policy.ts";

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
function loadWithCommand(
  env: NodeJS.ProcessEnv,
  root: string,
  configHome: string = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-off-config-")),
): Harness {
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
    // An empty config home by default: the Customize preference is unset (off).
    gentlePiConfigHome: configHome,
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
  assert.ok(
    notifyCalls[0][0].includes("Gentle → Customize"),
    `the warning must name the Customize control, got: ${notifyCalls[0][0]}`,
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

test("the Customize preference opens the selector without the env switch", async () => {
  const root = makeRoot();
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-off-config-"));
  const { commandHandler } = loadWithCommand({}, root, configHome);
  const notifyCalls: Array<[string, string]> = [];
  await commandHandler([], fakeCtx(notifyCalls));
  assert.equal(notifyCalls[0][1], "warning");
  assert.match(notifyCalls[0][0], /disabled/);
  // The same loaded extension honors a later toggle without restart.
  writeHistoryCapturePolicy("on", { gentlePiConfigHome: configHome });
  await commandHandler([], fakeCtx(notifyCalls));
  assert.deepEqual(notifyCalls[1], ["No prompt history available.", "warning"]);
});

test("an explicit env off names the override instead of the Customize fix", async () => {
  const root = makeRoot();
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-off-config-"));
  writeHistoryCapturePolicy("on", { gentlePiConfigHome: configHome });
  const { commandHandler } = loadWithCommand({ GENTLE_PI_HISTORY_CAPTURE: "false" }, root, configHome);
  const notifyCalls: Array<[string, string]> = [];
  await commandHandler([], fakeCtx(notifyCalls));
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0][0], /disabled by GENTLE_PI_HISTORY_CAPTURE, which overrides the Gentle → Customize → History preference/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("a malformed Customize preference is reported as invalid, not just off", async () => {
  const root = makeRoot();
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-off-config-"));
  const preference = path.join(configHome, "history-capture.json");
  fs.writeFileSync(preference, "{not json", "utf8");
  const { commandHandler } = loadWithCommand({}, root, configHome);
  const notifyCalls: Array<[string, string]> = [];
  await commandHandler([], fakeCtx(notifyCalls));
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0][1], "warning");
  assert.match(notifyCalls[0][0], /Gentle → Customize → History preference is invalid or unreadable/);
  assert.ok(notifyCalls[0][0].includes(preference), `the warning must name the file, got: ${notifyCalls[0][0]}`);
  assert.ok(notifyCalls[0][0].includes("GENTLE_PI_HISTORY_CAPTURE=1"));
  // Reporting never repairs: the malformed file and the store stay untouched.
  assert.equal(fs.readFileSync(preference, "utf8"), "{not json");
  assert.deepEqual(fs.readdirSync(root), []);
});

test("an env value that defers to a malformed preference still reports it", async () => {
  const root = makeRoot();
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-off-config-"));
  fs.writeFileSync(path.join(configHome, "history-capture.json"), "[]", "utf8");
  const { commandHandler } = loadWithCommand({ GENTLE_PI_HISTORY_CAPTURE: "maybe" }, root, configHome);
  const notifyCalls: Array<[string, string]> = [];
  await commandHandler([], fakeCtx(notifyCalls));
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0][0], /preference is invalid or unreadable/);
});
