import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerYoloSessionPolicy, discoverYoloUiAdapter } from "../lib/yolo-session-policy.ts";
import { parsePermissionModePolicyFile, resolvePermissionModePolicy, writePermissionModePolicy, permissionModePolicyFile, PERMISSION_MODE_SCHEMA } from "../lib/permission-mode-policy.ts";

function fixture(t: test.TestContext) {
 const home = mkdtempSync(join(tmpdir(), "gentle-mode-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 return { gentlePiConfigHome: home };
}
function host(home: string, env: NodeJS.ProcessEnv = {}, onChange?: () => void) {
 const commands = new Map<string, { handler(args: string, context: ExtensionContext): Promise<void> }>();
 const listeners = new Map<string, (value: unknown) => void>();
 const notices: string[] = [];
 const statuses = new Map<string, string | undefined>();
 let sessionId = "first";
 const context = { cwd: home, mode: "tui", hasUI: true,
  sessionManager: { getSessionId: () => sessionId },
  ui: { notify: (s: string) => notices.push(s), setStatus: (k: string, s?: string) => statuses.set(k, s), setWidget() {} },
 } as unknown as ExtensionContext;
 const pi = { registerCommand: (n: string, c: { handler(args: string, context: ExtensionContext): Promise<void> }) => commands.set(n, c),
  events: { on: (n: string, fn: (value: unknown) => void) => listeners.set(n, fn), emit: (n: string, v: unknown) => listeners.get(n)?.(v) },
 } as unknown as ExtensionAPI;
 const controller = registerYoloSessionPolicy(pi, { ...env, GENTLE_PI_CONFIG_HOME: home }, { onChange });
 return { controller, context, pi, commands, notices, statuses, next: () => { sessionId = "next"; } };
}

test("superseded YOLO enables stay silent while genuine activation failure warns", async t => {
 const options = fixture(t), h = host(options.gentlePiConfigHome);
 const original = fsPromises.realpath;
 const captures: Array<{ release(): void }> = [];
 let captured!: () => void;
 const firstCaptured = new Promise<void>(resolve => { captured = resolve; });
 t.mock.method(fsPromises, "realpath", async (path: string) => {
  await new Promise<void>(resolve => { captures.push({ release: resolve }); captured(); });
  return original(path);
 });
 syncBuiltinESMExports();
 t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
 const older = h.controller.humanAction("on", h.context);
 await firstCaptured;
 const newer = h.controller.humanAction("on", h.context);
 assert.equal(captures.length, 2);
 captures[1].release(); await newer;
 captures[0].release(); await older;
 assert.deepEqual(h.notices, ["🚀 YOLO ON 🔥 — destructive confirmations remain"]);
 t.mock.restoreAll(); syncBuiltinESMExports();
 assert.equal(await h.controller.mode(h.context), "yolo");
 Object.assign(h.context, { hasUI: false, mode: "json" });
 await h.controller.humanAction("on", h.context);
 assert.deepEqual(h.notices, ["🚀 YOLO ON 🔥 — destructive confirmations remain",
  "YOLO OFF — activation requires an interactive primary TUI session and an identifiable workspace."]);
});

test("strict global policy defaults Normal; round trips all modes atomically and privately", t => {
 const options = fixture(t);
 assert.equal(resolvePermissionModePolicy(options).mode, "normal");
 for (const mode of ["normal", "auto", "yolo"] as const) {
  const path = writePermissionModePolicy(mode, options);
  assert.equal(path, permissionModePolicyFile(options));
  assert.equal(resolvePermissionModePolicy(options).mode, mode);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(options.gentlePiConfigHome), ["permission-mode.json"]);
  assert.equal(parsePermissionModePolicyFile(readFileSync(path, "utf8")), mode);
 }
});

test("malformed, extra-field, invalid and unreadable preferences fail Normal and refuse overwrite", t => {
 const options = fixture(t);
 for (const raw of ["{", "null", "[]", JSON.stringify({ schema: PERMISSION_MODE_SCHEMA, mode: "AUTO" }), JSON.stringify({ schema: PERMISSION_MODE_SCHEMA, mode: "yolo", extra: true })]) {
  writeFileSync(permissionModePolicyFile(options), raw);
  assert.equal(resolvePermissionModePolicy(options).mode, "normal");
  assert.equal(resolvePermissionModePolicy(options).malformed, true);
  assert.throws(() => writePermissionModePolicy("auto", options));
  assert.equal(readFileSync(permissionModePolicyFile(options), "utf8"), raw);
 }
 assert.throws(() => writePermissionModePolicy("invalid" as "normal", options));
 assert.equal(resolvePermissionModePolicy({ gentlePiConfigHome: permissionModePolicyFile(options) }).mode, "normal");
});

test("non-Git primary uses exclusive live modes; saved defaults affect fresh sessions only", async t => {
 const options = fixture(t), h = host(options.gentlePiConfigHome);
 assert.equal(await h.controller.mode(h.context), "normal");
 assert.equal(await h.controller.saveDefault("auto", h.context), true);
 assert.match(h.notices.at(-1)!, /additional model calls.*separate usage/i);
 assert.equal(await h.controller.mode(h.context), "normal");
 assert.equal(await h.controller.setMode("yolo", h.context), true);
 assert.equal(await h.controller.active(h.context), true);
 assert.equal(await h.controller.setMode("auto", h.context), true);
 assert.equal(await h.controller.active(h.context), false);
 assert.match(h.statuses.get("gentle:mode")!, /AUTO/);
 assert.equal(await h.controller.setMode("normal", h.context), true);
 assert.equal(await h.controller.mode(h.context), "normal");
 h.next(); h.controller.reset(h.context);
 assert.equal(await h.controller.mode(h.context), "auto");
 h.controller.reset(h.context);
 assert.equal(await h.controller.mode(h.context), "normal", "same-session revocation does not replay defaults");
 const fresh = host(options.gentlePiConfigHome);
 assert.equal(await fresh.controller.mode(fresh.context), "auto");
 assert.equal(fresh.notices.length, 0, "saved preference does not repeatedly prompt");
});

test("trusted defaults support headless primary but never children or headless mutation", async t => {
 const options = fixture(t);
 writePermissionModePolicy("yolo", options);
 const h = host(options.gentlePiConfigHome);
 Object.assign(h.context, { hasUI: false, mode: "json" });
 assert.equal(await h.controller.mode(h.context), "yolo");
 assert.equal(await h.controller.setMode("auto", h.context), false);
 assert.equal(await h.controller.saveDefault("normal", h.context), false);
 assert.equal(h.controller.defaultMode(), "yolo");
 const child = host(options.gentlePiConfigHome, { GENTLE_PI_AGENTS_CHILD: "1" });
 assert.equal(await child.controller.mode(child.context), "normal");
 assert.equal(await child.controller.saveDefault("auto", child.context), false);
});

test("slash and optional adapter operations share mode state; invalid arguments do not mutate", async t => {
 const options = fixture(t), h = host(options.gentlePiConfigHome);
 const command = h.commands.get("gentle:mode"); assert.ok(command);
 await command.handler("auto", h.context);
 assert.equal(await h.controller.mode(h.context), "auto");
 await command.handler("default yolo", h.context);
 assert.equal(h.controller.defaultMode(), "yolo");
 assert.equal(await h.controller.mode(h.context), "auto");
 await command.handler("invalid", h.context);
 assert.equal(await h.controller.mode(h.context), "auto");
 const adapter = await discoverYoloUiAdapter(h.pi, h.context); assert.ok(adapter);
 assert.equal(await adapter.readMode!(), "auto");
 assert.equal(await adapter.setMode!("normal"), true);
 assert.equal(await adapter.read(), "OFF");
 await adapter.toggle(); assert.equal(await adapter.read(), "ON");
 const epoch = h.controller.epoch();
 h.next();
 assert.equal(await adapter.setMode!("auto"), false);
 assert.equal(await adapter.saveDefault!("normal"), false);
 assert.equal(await adapter.read(), "UNAVAILABLE");
 h.controller.reset(h.context); assert.ok(h.controller.epoch() > epoch);
 adapter.dispose();
});

test("disposing the UI adapter during pending activation discards its mode choice", async t => {
 const options = fixture(t), h = host(options.gentlePiConfigHome);
 const adapter = await discoverYoloUiAdapter(h.pi, h.context); assert.ok(adapter);
 const pending = adapter.setMode!("auto");
 adapter.dispose();
 assert.equal(await pending, false);
 assert.equal(await h.controller.mode(h.context), "normal");
});

test("reset during initial default capture revokes without replaying that session default", async t => {
 const options = fixture(t);
 writePermissionModePolicy("auto", options);
 const h = host(options.gentlePiConfigHome);
 const pending = h.controller.mode(h.context);
 h.controller.reset(h.context);
 assert.equal(await pending, "normal");
 assert.equal(await h.controller.mode(h.context), "normal");
});

test("a concurrent mode switch during default-save initialization discards the stale save", async t => {
 const options = fixture(t);
 let once = true;
 let superseding: Promise<boolean> | undefined;
 const h = host(options.gentlePiConfigHome, {}, () => {
  if (!once) return;
  once = false;
  superseding = h.controller.setMode("normal", h.context);
 });
 assert.equal(await h.controller.saveDefault("yolo", h.context), false);
 await superseding;
 assert.equal(h.controller.defaultMode(), "normal");
});

test("stale pending activation, scope loss and malformed preference remain closed", async t => {
 const options = fixture(t), h = host(options.gentlePiConfigHome);
 const pending = h.controller.setMode("auto", h.context);
 h.controller.reset(h.context);
 assert.equal(await pending, false);
 assert.equal(await h.controller.mode(h.context), "normal");
 assert.equal(await h.controller.setMode("auto", h.context), true);
 Object.assign(h.context, { cwd: "/" });
 assert.equal(await h.controller.mode(h.context), "normal");
 Object.assign(h.context, { cwd: options.gentlePiConfigHome });
 assert.equal(await h.controller.mode(h.context), "normal", "revoked modes do not resurrect");
 writeFileSync(permissionModePolicyFile(options), "{");
 assert.equal(await h.controller.saveDefault("yolo", h.context), false);
 assert.equal(readFileSync(permissionModePolicyFile(options), "utf8"), "{");
});
