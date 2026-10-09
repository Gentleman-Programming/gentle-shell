import assert from "node:assert/strict";
import test from "node:test";
import {
 existsSync,
 mkdirSync,
 mkdtempSync,
 readFileSync,
 renameSync,
 rmSync,
 writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
 AgentSessionRuntime,
 createAgentSession,
 createEventBus,
 createExtensionRuntime,
 ModelRuntime,
 SessionManager,
 SettingsManager,
 type AgentSession,
 type ExtensionAPI,
 type ExtensionUIContext,
 type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { readSessionProfileBinding } from "../lib/session-profile-binding.ts";
import { SESSION_PROFILE_CUSTOM_TYPE } from "../lib/session-profile-persistence.ts";

// Actual SDK factory loader, AgentSession and replacement runtime. Only resource,
// auth and UI boundaries are fixture-owned. No prompts, provider streams or Git.
async function fixture(t: test.TestContext, memory = false, flushed = true) {
 const root = mkdtempSync(join(tmpdir(), "u3-public-"));
 const config = join(root, "config"),
  agentDir = join(root, "agent");
 mkdirSync(config);
 mkdirSync(agentDir);
 const originalConfig = process.env.GENTLE_PI_CONFIG_HOME;
 process.env.GENTLE_PI_CONFIG_HOME = config;
 const profilesPath = join(config, "profiles.json");
 const profiles = {
  team: { worker: { model: "openai/gpt-4o" } },
  empty: {},
  live: { orchestrator: { model: "openai/gpt-5.2", thinking: "high" } },
 };
 const saveProfiles = () =>
  writeFileSync(
   profilesPath,
   JSON.stringify({
    kind: "gentle-pi.agent_model_profiles",
    version: 1,
    profiles,
   }),
  );
 saveProfiles();
 const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
 });
 const baseModel = modelRuntime.getModel("openai", "gpt-4o");
 assert.ok(baseModel, "fixture model catalog prerequisite");
 assert.ok(
  modelRuntime.getModel("openai", "gpt-5.2"),
  "fixture live model catalog prerequisite",
 );
 let authCalls = 0,
  providerCalls = 0;
 let auth: () => Promise<unknown> = async () => ({ type: "api-key" });
 modelRuntime.hasConfiguredAuth = () => true;
 modelRuntime.checkAuth = (async () => {
  authCalls++;
  return auth();
 }) as typeof modelRuntime.checkAuth;
 modelRuntime.streamSimple = () => {
  providerCalls++;
  assert.fail("no provider requests");
 };
 const notices: Array<{ text: string; severity?: string }> = [],
  errors: string[] = [],
  events: string[] = [];
 let selection: keyof typeof profiles | undefined;
 let currentApi: ExtensionAPI | undefined;
 let cancel = false;
 const ui = {
  theme: getThemeByName("dark")!,
  getAllThemes: () => [{ name: "dark" }],
  notify: (text: string, severity?: string) => notices.push({ text, severity }),
  setStatus() {},
  setWidget() {},
  custom(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
   return new Promise((resolve) => {
    void Promise.resolve(
     factory(
      {
       terminal: { rows: 24 },
       requestRender() {},
       stop() {},
       start() {},
      } as never,
      getThemeByName("dark")!,
      {} as never,
      resolve as never,
     ),
    ).then((panel) => {
     if (selection === undefined) panel.handleInput?.("\x1b");
     else {
      // The list keeps store order; arrows move it (j/k scroll the detail).
      const names = Object.keys(profiles);
      for (let i = 0; i < names.length; i++) panel.handleInput?.("\x1b[A");
      for (let i = 0; i < names.indexOf(selection); i++)
       panel.handleInput?.("\x1b[B");
      selection = undefined;
      panel.handleInput?.("\r");
     }
    });
   });
  },
 } as unknown as ExtensionUIContext;
 const make = async (
  manager: SessionManager,
  startEvent: {
   type: "session_start";
   reason: "startup" | "new" | "resume" | "fork";
   previousSessionFile?: string;
  },
 ) => {
  let extensionRuntime = createExtensionRuntime();
  let loaded: Awaited<ReturnType<typeof loadExtensionFromFactory>>[] = [];
  const reload = async () => {
   extensionRuntime = createExtensionRuntime();
   const bus = createEventBus();
   loaded = [
    await loadExtensionFromFactory(
     (pi) => {
      currentApi = pi;
      createGentleAiExtension({
       nativeReviewCli: null,
       candidateViews: null,
       processEnv: { GENTLE_PI_AGENTS_CHILD: "1" },
       resolveTelemetryTriggerBinary: () => {
        throw Error("disabled fixture telemetry");
       },
      })(pi);
     },
     root,
     bus,
     extensionRuntime,
    ),
    await loadExtensionFromFactory(
     (pi) => {
      pi.on("session_before_fork", () =>
       cancel ? { cancel: true } : undefined,
      );
      pi.on("session_before_tree", () =>
       cancel ? { cancel: true } : undefined,
      );
      pi.on("session_before_switch", () =>
       cancel ? { cancel: true } : undefined,
      );
      pi.on("session_start", (e) => {
       events.push(`start:${e.reason}`);
      });
      pi.on("session_shutdown", (e) => {
       events.push(`shutdown:${e.reason}`);
      });
     },
     root,
     bus,
     extensionRuntime,
    ),
   ];
  };
  const loader: ResourceLoader = {
   getExtensions: () => ({
    extensions: loaded,
    errors: [],
    runtime: extensionRuntime,
   }),
   getSkills: () => ({ skills: [], diagnostics: [] }),
   getPrompts: () => ({ prompts: [], diagnostics: [] }),
   getThemes: () => ({ themes: [], diagnostics: [] }),
   getAgentsFiles: () => ({ agentsFiles: [] }),
   getSystemPrompt: () => "Offline U3 fixture",
   getSystemPromptSource: () => undefined,
   getAppendSystemPrompt: () => [],
   getAppendSystemPromptSources: () => [],
   extendResources() {},
   reload,
  };
  await reload();
  const created = await createAgentSession({
   cwd: root,
   agentDir,
   modelRuntime,
   model: baseModel,
   thinkingLevel: "off",
   tools: [],
   resourceLoader: loader,
   settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
   }),
   sessionManager: manager,
   sessionStartEvent: startEvent,
  });
  return { ...created, loader };
 };
 const manager = memory
  ? SessionManager.inMemory(root)
  : SessionManager.create(root, join(root, "sessions"));
 if (flushed)
  manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
 const first = await make(manager, {
  type: "session_start",
  reason: "startup",
 });
 const bind = (session: AgentSession) =>
  session.bindExtensions({
   uiContext: ui,
   mode: "tui",
   onError: (e) => errors.push(JSON.stringify(e)),
  });
 await bind(first.session);
 const runtime = new AgentSessionRuntime(
  first.session,
  { cwd: root, agentDir } as never,
  async (options) => {
   const next = await make(
    options.sessionManager,
    options.sessionStartEvent! as never,
   );
   return {
    ...next,
    services: { cwd: root, agentDir } as never,
    diagnostics: [],
   };
  },
 );
 runtime.setRebindSession(bind);
 t.after(async () => {
  await runtime.dispose();
  if (originalConfig === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = originalConfig;
  rmSync(root, { recursive: true, force: true });
  assert.equal(providerCalls, 0);
  assert.deepEqual(errors, []);
 });
 const enter = async (
  name: keyof typeof profiles = "team",
  session: AgentSession = runtime.session,
 ) => {
  selection = name;
  const command = session.extensionRunner.getCommand("gentle:profiles");
  assert.ok(command);
  await command.handler("", session.extensionRunner.createCommandContext());
 };
 const binding = () =>
  readSessionProfileBinding(runtime.session.sessionManager.getSessionId());
 const family = () =>
  runtime.session.sessionManager
   .getBranch()
   .filter(
    (e) => e.type === "custom" && e.customType === SESSION_PROFILE_CUSTOM_TYPE,
   );
 const protectedBytes = () => [
  readFileSync(profilesPath, "utf8"),
  existsSync(join(config, "models.json")),
  existsSync(join(agentDir, "settings.json")),
  existsSync(join(root, ".pi", "subagents.json")),
 ];
 return {
  root,
  runtime,
  manager,
  notices,
  events,
  errors,
  profiles,
  saveProfiles,
  enter,
  binding,
  family,
  protectedBytes,
  api: () => currentApi!,
  authCalls: () => authCalls,
  setAuth: (fn: typeof auth) => {
   auth = fn;
  },
  cancel: (value: boolean) => {
   cancel = value;
  },
 };
}

for (const memory of [false, true])
 for (const flushed of [false, true])
  test(`U3 Enter public component persists or explicitly reports preflush (${memory}, ${flushed})`, async (t) => {
   const f = await fixture(t, memory, flushed),
    before = f.protectedBytes();
   await f.enter();
   assert.equal(
    f.family().length,
    1,
    "Enter appends one public profile record before publication",
   );
   assert.equal(f.authCalls(), 0);
   assert.deepEqual(f.protectedBytes(), before);
   // A flushed in-memory session never corroborates its append (published
   // append controller: append-not-corroborated), so Enter adopts nothing.
   if (memory && flushed) {
    assert.equal(f.binding(), undefined);
    assert.match(f.notices.at(-1)?.text ?? "", /Session profile authority is unavailable/);
   } else {
    assert.equal(f.binding()?.name, "team");
    assert.deepEqual(f.binding()?.modelProfiles, f.profiles.team);
    assert.match(
     f.notices.at(-1)?.text ?? "",
     memory || !flushed ? /not yet persisted/ : /persisted/,
    );
   }
   await f.runtime.session.reload();
   assert.equal(
    f.binding()?.name,
    memory || !flushed ? undefined : "team",
    "reload restores only disk-corroborated state",
   );
   assert.equal(
    f.authCalls(),
    0,
    "no restoration-time orchestrator application",
   );
  });

test("U3 Enter composes append, exact publication and existing live controls without shared writes", async (t) => {
 const f = await fixture(t),
  before = f.protectedBytes();
 f.setAuth(async () => {
  assert.equal(f.binding()?.name, "live", "publication precedes live effects");
  assert.equal(f.family().length, 1);
  assert.ok(
   readFileSync(f.runtime.session.sessionFile!, "utf8").includes(
    SESSION_PROFILE_CUSTOM_TYPE,
   ),
  );
  return { type: "api-key" };
 });
 await f.enter("live");
 assert.equal(f.runtime.session.model?.id, "gpt-5.2");
 assert.equal(f.runtime.session.thinkingLevel, "high");
 assert.equal(f.authCalls(), 1);
 assert.deepEqual(f.protectedBytes(), before);
 await f.enter("empty");
 assert.deepEqual(f.binding()?.modelProfiles, {});
 assert.equal(f.authCalls(), 1, "empty profile does not switch model");
});

for (const failure of ["before-append", "EISDIR"] as const)
 test(`U3 failed Enter ${failure} adopts nothing and applies no live effects`, async (t) => {
  const f = await fixture(t);
  await f.enter();
  const file = f.manager.getSessionFile()!,
   disk = readFileSync(file, "utf8"),
   before = f.protectedBytes();
  const append = f.manager.appendCustomEntry.bind(f.manager);
  if (failure === "EISDIR") {
   renameSync(file, `${file}.saved`);
   mkdirSync(file);
  } else
   f.manager.appendCustomEntry = () => {
    throw Error("fixture rejected append");
   };
  await f.enter("live");
  assert.equal(f.authCalls(), 0);
  assert.equal(f.runtime.session.model?.id, "gpt-4o");
  assert.equal(f.binding()?.name, failure === "EISDIR" ? undefined : "team");
  assert.equal(f.notices.at(-1)?.severity, "warning");
  assert.doesNotMatch(f.notices.at(-1)?.text ?? "", /bound profile "live"/);
  assert.deepEqual(f.protectedBytes(), before);
  f.manager.appendCustomEntry = append;
  if (failure === "EISDIR") {
   rmSync(file, { recursive: true });
   renameSync(`${file}.saved`, file);
  }
  assert.equal(
   readFileSync(file, "utf8"),
   disk,
   "rejected entry did not reach disk",
  );
  await f.runtime.session.reload();
  assert.equal(
   f.binding()?.name,
   "team",
   "quarantine survives module replacement",
  );
  assert.equal(f.authCalls(), 0);
 });

for (const customType of [
 SESSION_PROFILE_CUSTOM_TYPE,
 "gentle-pi.session-profile/v99",
])
 test(`U3 terminal invalid/future selection ${customType} blocks until explicit recovery`, async (t) => {
  const f = await fixture(t);
  await f.enter();
  f.manager.appendCustomEntry(customType, { invalid: true });
  await f.runtime.session.reload();
  assert.equal(f.binding(), undefined);
  await f.enter();
  assert.equal(f.binding()?.name, "team");
  assert.equal(f.authCalls(), 0);
 });

for (const memory of [false, true])
 for (const cut of ["before", "at", "root", "label"] as const)
  test(`U3 actual runtime fork retained cut ${cut} (${memory})`, async (t) => {
   const f = await fixture(t, memory);
   const root = f.manager.getBranch()[0].id;
   await f.enter();
   const profile = f.manager.getLeafId()!;
   const user = f.manager.appendMessage({
    role: "user",
    content: "cut",
    timestamp: 2,
   });
   f.manager.appendLabelChange(profile, "profile-label");
   const before = readSessionProfileBinding(f.manager.getSessionId());
   const target =
    cut === "root" ? root : cut === "at" || cut === "label" ? profile : user;
   const result = await f.runtime.fork(target, {
    position: cut === "root" || cut === "before" ? "before" : "at",
   });
   assert.equal(result.cancelled, false);
   assert.equal(
    f.binding()?.name,
    cut === "root" || memory ? undefined : "team",
    "only retained corroborated records restore",
   );
   assert.equal(f.authCalls(), 0);
   // In memory the flushed append is never corroborated, so nothing was bound.
   assert.deepEqual(before?.modelProfiles, memory ? undefined : f.profiles.team);
   assert.ok(f.events.includes("shutdown:fork"));
   assert.ok(f.events.includes("start:fork"));
  });

test("U3 public runtime cancellation and unsaved rejection preserve explicit authority", async (t) => {
 const f = await fixture(t, false, false);
 await f.enter();
 const leaf = f.manager.getLeafId()!;
 const branch = f.manager.getBranch(),
  before = f.binding();
 f.cancel(true);
 assert.equal((await f.runtime.fork(leaf, { position: "at" })).cancelled, true);
 assert.equal((await f.runtime.newSession()).cancelled, true);
 assert.deepEqual(f.manager.getBranch(), branch);
 assert.deepEqual(f.binding(), before);
 f.cancel(false);
 await assert.rejects(
  f.runtime.fork(leaf, { position: "at" }),
  /has not been saved/,
 );
 assert.deepEqual(f.binding(), before);
 assert.equal(
  f.events.some((e) => e.startsWith("shutdown")),
  false,
 );
});

test("U3 actual new/resume/tree/reload revoke stale public contexts without restoration effects", async (t) => {
 const f = await fixture(t);
 await f.enter();
 const file = f.manager.getSessionFile()!,
  old = f.runtime.session;
 const profile = f.manager.getLeafId()!;
 const later = f.manager.appendCustomEntry("ordinary", {});
 await old.navigateTree(profile);
 assert.equal(f.binding()?.name, "team");
 await old.navigateTree(later);
 assert.equal(f.binding()?.name, "team");
 await f.runtime.newSession();
 assert.equal(f.binding(), undefined);
 await assert.rejects(f.enter("live", old));
 assert.equal(f.authCalls(), 0);
 await f.runtime.switchSession(file);
 assert.equal(f.binding()?.name, "team");
 await f.runtime.session.reload();
 assert.equal(f.binding()?.name, "team");
 assert.equal(f.authCalls(), 0);
 assert.ok(f.events.includes("start:new"));
 assert.ok(f.events.includes("start:resume"));
});

for (const transition of ["fork", "tree", "reload", "new"] as const)
 test(`U3 pending Enter serializes before ${transition} on actual public SDK`, async (t) => {
  const f = await fixture(t);
  const leaf = f.manager.getLeafId()!;
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((resolve) => {
   started = resolve;
  });
  f.setAuth(() => {
   started();
   return new Promise((resolve) => {
    release = () => resolve({ type: "api-key" });
   });
  });
  const enter = f.enter("live");
  // RED must fail an assertion, not hang waiting for a nonexistent live call.
  await Promise.race([ready, enter]);
  assert.equal(f.authCalls(), 1, "Enter reaches the existing live control");
  let transitioned = false;
  const move = (
   transition === "fork"
    ? f.runtime.fork(leaf, { position: "at" })
    : transition === "tree"
      ? f.runtime.session.navigateTree(leaf)
      : transition === "reload"
        ? f.runtime.session.reload()
        : f.runtime.newSession()
  ).then(() => {
   transitioned = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const wasSerialized = !transitioned;
  release();
  await Promise.all([enter, move]);
  assert.equal(
   wasSerialized,
   true,
   "transition cannot copy/change/detach while Enter awaits authentication",
  );
  assert.equal(f.authCalls(), 1);
 });
