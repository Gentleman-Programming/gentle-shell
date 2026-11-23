import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// S9 + publicar-paquetes-drakonc 1.6: the store, its legacy files and the
// transcript scan follow the agent home Pi runs with (PI_CODING_AGENT_DIR),
// bundled or not. A plain pi session resolves that home to ~/.pi/agent, where
// existing histories live, so nothing moves for it.

// The OS home is a temporary folder before the extension is imported, so even
// a resolver that ignores PI_CODING_AGENT_DIR (or reads the OS home at import)
// can never write into the real home.
const osHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-os-home-"));
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = osHome;
process.env.USERPROFILE = osHome;
const { default: promptHistoryExtension } = await import("../extensions/history/index.ts");
const { setBundledInstallForTesting } = await import("../lib/drakonc-shell-bundled.ts");
after(() => {
  for (const [name, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(osHome, { recursive: true, force: true });
});

type Handler = (...args: unknown[]) => unknown;

function load(env: NodeJS.ProcessEnv) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerShortcut: () => {},
    registerCommand: () => {},
  };
  promptHistoryExtension(pi as never, {
    env: { DRAKONC_PI_HISTORY_CAPTURE: "1", ...env },
    cwd: "/pi-history-test/project-agent-home",
    instanceId: "inst-agent-home",
    now: () => 1700000000000,
    drakoncPiConfigHome: fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-agent-home-config-")),
  });
  return async (prompt: string) => {
    await new Promise((resolve) => setImmediate(resolve));
    for (const handler of handlers.get("before_agent_start") ?? []) await handler({ prompt }, {});
  };
}

function holds(store: string, prompt: string): boolean {
  if (!fs.existsSync(store)) return false;
  return fs.readdirSync(store, { recursive: true }).map(String)
    .map((file) => path.join(store, file))
    .filter((file) => fs.statSync(file).isFile())
    .some((file) => fs.readFileSync(file, "utf8").includes(prompt));
}

test("outside a bundled install prompt history follows the agent home Pi runs with (1.6)", async (t) => {
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-agent-home-"));
  t.after(() => fs.rmSync(agentHome, { recursive: true, force: true }));
  // The isolated launcher's home, and a prefix variable this package is not installed in.
  await load({ PI_CODING_AGENT_DIR: agentHome, DRAKONC_SHELL_PREFIX: agentHome })("isolated home prompt");
  assert.ok(holds(path.join(agentHome, "history"), "isolated home prompt"));
  assert.equal(holds(path.join(osHome, ".pi", "agent", "history"), "isolated home prompt"), false);
});

test("without an agent home override prompt history stays under ~/.pi/agent", async (t) => {
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-agent-home-"));
  t.after(() => fs.rmSync(agentHome, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previous !== undefined) process.env.PI_CODING_AGENT_DIR = previous;
  });
  // Un Pi normal no define el override: el hogar por defecto sigue siendo el de siempre.
  await load({ DRAKONC_SHELL_PREFIX: agentHome })("default home prompt");
  assert.ok(holds(path.join(osHome, ".pi", "agent", "history"), "default home prompt"));
  assert.equal(holds(path.join(agentHome, "history"), "default home prompt"), false);
});

test("in a bundled install prompt history lives under the agent home Pi runs with", async (t) => {
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-agent-home-"));
  const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-prefix-")));
  // The testing overlay stands in for this package running from that prefix.
  setBundledInstallForTesting({ root: prefix });
  t.after(() => {
    setBundledInstallForTesting(undefined);
    for (const dir of [agentHome, prefix]) fs.rmSync(dir, { recursive: true, force: true });
  });
  await load({ PI_CODING_AGENT_DIR: agentHome, DRAKONC_SHELL_PREFIX: prefix })("bundled prompt");
  assert.ok(holds(path.join(agentHome, "history"), "bundled prompt"));
  assert.equal(holds(path.join(osHome, ".pi", "agent", "history"), "bundled prompt"), false);
});
