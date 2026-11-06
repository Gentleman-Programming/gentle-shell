import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSessionProfileIntegration } from "../lib/session-profile-integration.ts";
import { normalizeProfilesFile, PROFILES_KIND, PROFILES_VERSION, createProfile, duplicateProfile, emptyProfilesFile, parseProfileExportText, parseProfilesFileText, serializeProfileExport, serializeProfilesFile } from "../lib/agent-profiles.ts";
import { createSessionProfileBind, readSessionProfileEntry, replaySessionProfileBranch, SESSION_PROFILE_CUSTOM_TYPE } from "../lib/session-profile-persistence.ts";
import { normalizeRoutingEntry } from "../lib/model-routing-authority.ts";
import { parseAgentsConfig, resolveAgentProfile, withPinnedModelProfiles } from "../lib/agents-config.ts";
import { __testing } from "../extensions/gentle-ai.ts";
import fast from "../extensions/gentle-fast.ts";
import { CHILD_TIER_ENV, PROFILE_TIER_EVENT } from "../lib/openai-fast-tier.ts";
import { runInProcessReviewer } from "../lib/inprocess-reviewer.ts";
import { bindSessionProfile, clearSessionProfileBinding } from "../lib/session-profile-binding.ts";
import { freezeSessionProfileAtStartup, readFrozenDefaultOrchestrator, readFrozenInheritedProfile, setFrozenDefaultOrchestrator } from "../lib/session-profile-freeze.ts";

test("All Fast sets compatible routes without toggling existing Fast or changing other fields", () => {
 const model = "openai/gpt-6.1-sol";
 const codex = "openai-codex/gpt-6.1-terra";
 const draft = { orchestrator: { model, thinking: "high" as const, tier: "standard" as const }, worker: { model: codex, thinking: "medium" as const }, verify: { model, tier: "fast" as const }, other: { model: "other/model", tier: "standard" as const }, inherited: { thinking: "high" as const } };
 const original = structuredClone(draft);
 for (const width of [72, 120]) {
  const results: any[] = [];
  __testing.routingTablePanel(draft, [model, codex], ["worker", "verify", "other", "inherited"], width, undefined, undefined, ["a", "a", "s"], [], results, { fastModels: [model, codex] });
  assert.equal(results.length, 1);
  assert.equal(results[0].type, "save");
  assert.equal(results[0].name, "current");
  assert.deepEqual(results[0].config, { ...original, orchestrator: { ...original.orchestrator, tier: "fast" }, worker: { ...original.worker, tier: "fast" } });
  assert.deepEqual(draft, original, "editing does not mutate the original profile");
 }
});

test("All Fast is clickable at narrow and wide widths and does not save or apply by itself", () => {
 const model = "openai/gpt-6.1-sol";
 const draft = { orchestrator: { model }, worker: { model } };
 for (const width of [72, 120]) {
  const args: [typeof draft, string[], string[], number, undefined, undefined] = [draft, [model], ["worker"], width, undefined, undefined];
  const options = { fastModels: [model] };
  const before = __testing.routingTablePanel(...args, [], [], [], options);
  const y = before.findIndex(line => line.includes("All Fast"));
  assert.notEqual(y, -1, `All Fast is visible at ${width} columns`);
  const results: any[] = [];
  const after = __testing.routingTablePanel(...args, [], [{ type: "click", x: before[y].indexOf("All Fast") + 2, y }], results, options);
  assert.equal(after.filter(line => line.includes("Fast ▾")).length, 2);
  assert.match(after.join("\n"), /2 unsaved/);
  assert.deepEqual(results, [], "bulk edit does not silently save or change session/defaults");
 }
});

test("individual tier selection still overrides All Fast", () => {
 const model = "openai/gpt-6.1-sol";
 const results: any[] = [];
 __testing.routingTablePanel({ orchestrator: { model }, worker: { model } }, [model], ["worker"], 120, undefined, undefined, ["a", "t", "s"], [], results, { fastModels: [model] });
 assert.equal(results[0].config.orchestrator.tier, "standard");
 assert.equal(results[0].config.worker.tier, "fast");
});

test("profile UI saves Fast for both providers and independent roles", () => {
 for (const provider of ["openai", "openai-codex"]) {
  const model = `${provider}/gpt-5.6-luna`;
  const results: any[] = [];
  const lines = __testing.routingTablePanel({ orchestrator: { model }, worker: { model } }, [model], ["worker"], 120, undefined, undefined, ["t", "j", "j", "t", "s"], [], results, { fastModels: [model] });
  assert.match(lines.join("\n"), /Fast/);
  assert.equal(results[0].type, "save");
  assert.equal(results[0].config.orchestrator.tier, "fast");
  assert.equal(results[0].config.worker.tier, "fast");
 }
});

test("tier and fallback controls coexist at narrow and wide widths", () => {
 const model = "openai/gpt-5.6-luna";
 const draft = { orchestrator: { model } };
 const fallbacks = { chain: () => [{ model: "fallback/model" }], save: () => undefined };
 for (const width of [72, 120]) {
  const options = { fastModels: [model], fallbacks };
  const screen = __testing.routingTablePanel(draft, [model], [], width, undefined, undefined, [], [], [], options);
  const row = screen.findIndex((line) => line.includes("Standard ▾"));
  assert.notEqual(row, -1, `tier is fully visible at ${width} columns`);
  const tierX = screen[row].indexOf("Standard") + 1;
  const clicked = __testing.routingTablePanel(draft, [model], [], width, undefined, undefined, [], [{ type: "click", x: tierX, y: row }], [], options);
  assert.match(clicked.join("\n"), /Fast ▾/);
  assert.match(clicked.join("\n"), /↑↓ agent/);
  if (width === 72) assert.doesNotMatch(clicked.join("\n"), /t tier/);
  else assert.match(clicked.join("\n"), /t tier/);
 }
 const wide = __testing.routingTablePanel(draft, [model], [], 120, undefined, undefined, ["t"], [], [], { fastModels: [model], fallbacks });
 assert.match(wide.join("\n"), /Fast ▾\s+↪ fallback\/model/);
 const fallbackCard = __testing.routingTablePanel(draft, [model], [], 120, undefined, undefined, ["f"], [], [], { fastModels: [model], fallbacks });
 assert.match(fallbackCard.join("\n"), /Fallbacks for the orchestrator/);
});

test("profile UI does not offer tier for an unsupported route", () => {
 const results: any[] = [];
 __testing.routingTablePanel({ orchestrator: { model: "openai/other" } }, [], [], 100, undefined, undefined, ["t", "s"], [], results, { fastModels: [] });
 assert.deepEqual(results, []);
});

for (const provider of ["openai", "openai-codex"]) {
 test(`${provider} profile retains Fast through normalization and session replay`, () => {
  const model = `${provider}/gpt-5.6-luna`;
  const result = normalizeProfilesFile({ kind: PROFILES_KIND, version: PROFILES_VERSION, profiles: { work: { orchestrator: { model, thinking: "high", tier: "fast" } } } });
  assert.ok(result);
  assert.deepEqual(result.file.profiles.work.orchestrator, { model, thinking: "high", tier: "fast" });
  const binding = createSessionProfileBind("work", result.file.profiles.work);
  assert.deepEqual(replaySessionProfileBranch([{ type: "custom", customType: SESSION_PROFILE_CUSTOM_TYPE, data: binding }]), { status: "bound", binding, entryIndex: 0 });
 });
}

test("profile clone, file and export roundtrips preserve independent tier routes", () => {
 const route = { orchestrator: { model: "openai/gpt-5.6-luna", thinking: "high" as const, tier: "fast" as const }, worker: { model: "openai-codex/gpt-5.6-sol", tier: "standard" as const } };
 const file = duplicateProfile(createProfile(emptyProfilesFile(), "work", route), "work", "copy");
 route.orchestrator.tier = "standard" as any;
 assert.equal(file.profiles.copy.orchestrator.tier, "fast");
 const parsed = parseProfilesFileText(serializeProfilesFile(file));
 assert.equal(parsed.status, "valid");
 if (parsed.status === "valid") assert.equal(parsed.file.profiles.copy.worker.tier, "standard");
 assert.deepEqual(JSON.parse(JSON.stringify(parseProfileExportText(serializeProfileExport("work", file.profiles.work))?.config)), file.profiles.work);
});

test("child profile resolver carries the tier from the selected route", () => {
 const config = withPinnedModelProfiles(parseAgentsConfig(undefined, undefined), { worker: { model: "openai/gpt-5.6-luna", thinking: "high", tier: "fast" } });
 const agent = { name: "worker", description: "", filePath: "", scope: "global" as const, instructions: "", model: undefined, thinking: undefined, mode: undefined, tools: [] };
 assert.equal(resolveAgentProfile(agent, config).tier, "fast");
});

test("old and invalid-tier routes preserve model and effort normalization", () => {
 assert.deepEqual(normalizeRoutingEntry({ model: "openai/gpt-5.6-luna", effort: "high" }), { model: "openai/gpt-5.6-luna", thinking: "high" });
 assert.deepEqual(normalizeRoutingEntry({ model: "openai/gpt-5.6-luna", thinking: "low", tier: "invalid" }), { model: "openai/gpt-5.6-luna", thinking: "low" });
});

test("profile application switches tiers without affecting unsupported models", async () => {
 const handlers = new Map<string, Function>();
 const bus = new Map<string, Function>();
 const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-luna" };
 const ctx: any = { model, hasUI: false, sessionManager: { getSessionId: () => "profile-test" }, ui: { notify() {} } };
 fast({ on: (name: string, fn: Function) => handlers.set(name, fn), events: { on: (name: string, fn: Function) => bus.set(name, fn) } } as any);
 handlers.get("session_start")!({}, ctx);
 const request = () => handlers.get("before_provider_request")!({ payload: {} }, ctx);
 bus.get(PROFILE_TIER_EVENT)!({ sessionId: "profile-test", tier: "fast", model: "openai-codex/gpt-5.6-luna" });
 assert.equal(request().service_tier, "priority");
 bus.get(PROFILE_TIER_EVENT)!({ sessionId: "profile-test", tier: "standard", model: "openai-codex/gpt-5.6-luna" });
 assert.equal(request().service_tier, "default");
 bus.get(PROFILE_TIER_EVENT)!({ sessionId: "profile-test", tier: undefined });
 assert.equal(request(), undefined);
 bus.get(PROFILE_TIER_EVENT)!({ sessionId: "other", tier: "fast" });
 assert.equal(request(), undefined);
 bus.get(PROFILE_TIER_EVENT)!({ sessionId: "profile-test", tier: "fast", model: "openai-codex/gpt-5.6-luna" });
 ctx.model = { ...model, id: "gpt-5.6-sol" };
 handlers.get("model_select")!({ model: ctx.model }, ctx);
 assert.equal(request(), undefined);
 ctx.model = { ...model, api: "openai-completions" };
 assert.equal(request(), undefined);
});

test("session tree restores its frozen profile binding", async () => {
 const handlers = new Map<string, Function>();
 const bus = new Map<string, Function>();
 const model = { provider: "openai", api: "openai-responses", id: "gpt-5.6-luna" };
 const ctx: any = { model, hasUI: false, sessionManager: { getSessionId: () => "tier-restore-test" }, ui: { notify() {} } };
 fast({ on: (name: string, fn: Function) => handlers.set(name, fn), events: { on: (name: string, fn: Function) => bus.set(name, fn) } } as any);
 const previousChild = process.env.GENTLE_PI_AGENTS_CHILD;
 process.env.GENTLE_PI_AGENTS_CHILD = "0";
 bindSessionProfile("tier-restore-test", "work", { orchestrator: { model: "openai/gpt-5.6-luna", tier: "fast" } });
 try {
  handlers.get("session_start")!({}, ctx);
  const request = () => handlers.get("before_provider_request")!({ payload: {} }, ctx);
  assert.equal(request().service_tier, "priority");
  bus.get(PROFILE_TIER_EVENT)!({ sessionId: "tier-restore-test", tier: "standard", model: "openai/gpt-5.6-luna" });
  assert.equal(request().service_tier, "default");
  handlers.get("session_tree")!({}, ctx);
  assert.equal(request().service_tier, "priority");
 } finally {
  clearSessionProfileBinding("tier-restore-test");
  if (previousChild === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
  else process.env.GENTLE_PI_AGENTS_CHILD = previousChild;
 }
});

test("child runtime uses only its launch route and rejects model mismatches", () => {
 const oldChild = process.env.GENTLE_PI_AGENTS_CHILD;
 const oldTier = process.env[CHILD_TIER_ENV];
 const handlers = new Map<string, Function>();
 const ctx: any = { model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-luna" }, hasUI: false, sessionManager: { getSessionId: () => "child" }, ui: { notify() {} } };
 fast({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
 try {
  process.env.GENTLE_PI_AGENTS_CHILD = "1";
  process.env[CHILD_TIER_ENV] = JSON.stringify({ model: "openai-codex/gpt-5.6-luna", tier: "fast" });
  handlers.get("session_start")!({}, ctx);
  assert.equal(handlers.get("before_provider_request")!({ payload: {} }, ctx).service_tier, "priority");
  process.env[CHILD_TIER_ENV] = JSON.stringify({ model: "openai/gpt-5.6-luna", tier: "fast" });
  handlers.get("session_start")!({}, ctx);
  assert.equal(handlers.get("before_provider_request")!({ payload: {} }, ctx), undefined);
 } finally {
  if (oldChild === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD; else process.env.GENTLE_PI_AGENTS_CHILD = oldChild;
  if (oldTier === undefined) delete process.env[CHILD_TIER_ENV]; else process.env[CHILD_TIER_ENV] = oldTier;
 }
});

test("fresh default tier is frozen per session and used only for its model", () => {
 let current: any = { model: "openai/gpt-5.6-luna", tier: "fast" };
 const options: any = { sessionId: "tier-default-test", cwd: "/nonexistent", configHome: "/nonexistent", env: {}, resolveWorktree: () => undefined, readDefaultOrchestrator: () => current };
 freezeSessionProfileAtStartup(options);
 current = { model: "openai/gpt-5.6-luna", tier: "standard" };
 freezeSessionProfileAtStartup(options);
 assert.equal(readFrozenInheritedProfile("tier-default-test")?.defaultOrchestrator?.tier, "fast");
 freezeSessionProfileAtStartup({ ...options, sessionId: "tier-default-new" });
 assert.equal(readFrozenInheritedProfile("tier-default-new")?.defaultOrchestrator?.tier, "standard");
 freezeSessionProfileAtStartup({ ...options, sessionId: "tier-default-follow", env: { GENTLE_PI_PROFILE_FOLLOW: "1" } });
 current = { model: "openai/gpt-5.6-luna", tier: "fast" };
 freezeSessionProfileAtStartup({ ...options, sessionId: "tier-default-follow", env: { GENTLE_PI_PROFILE_FOLLOW: "1" } });
 assert.equal(readFrozenDefaultOrchestrator("tier-default-follow")?.tier, "standard");
 current = { model: "openai/gpt-5.6-luna", tier: "standard" };
 const handlers = new Map<string, Function>();
 const ctx: any = { model: { provider: "openai", api: "openai-responses", id: "gpt-5.6-luna" }, cwd: "/nonexistent", hasUI: false, sessionManager: { getSessionId: () => "tier-default-test" }, ui: { notify() {} } };
 fast({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
 const old = process.env.GENTLE_PI_AGENTS_CHILD;
 try {
  process.env.GENTLE_PI_AGENTS_CHILD = "0";
  handlers.get("session_start")!({}, ctx);
  assert.equal(handlers.get("before_provider_request")!({ payload: {} }, ctx)?.service_tier, "priority");
  bindSessionProfile("tier-default-test", "explicit", { orchestrator: { model: "openai/gpt-5.6-luna", tier: "standard" } });
  handlers.get("session_start")!({}, ctx);
  assert.equal(handlers.get("before_provider_request")!({ payload: {} }, ctx)?.service_tier, "default");
  bindSessionProfile("tier-default-test", "old", { worker: { model: "openai/gpt-5.6-luna" } });
  handlers.get("session_start")!({}, ctx);
  assert.equal(handlers.get("before_provider_request")!({ payload: {} }, ctx), undefined);
  clearSessionProfileBinding("tier-default-test");
  setFrozenDefaultOrchestrator("tier-default-test", current);
  handlers.get("session_start")!({}, ctx);
  assert.equal(handlers.get("before_provider_request")!({ payload: {} }, ctx)?.service_tier, "default");
  ctx.model = { ...ctx.model, id: "gpt-5.6-sol" };
  handlers.get("session_start")!({}, ctx);
  assert.equal(handlers.get("before_provider_request")!({ payload: {} }, ctx), undefined);
 } finally { if (old === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD; else process.env.GENTLE_PI_AGENTS_CHILD = old; }
});

for (const provider of ["openai", "openai-codex"]) for (const order of ["fast-first", "profiles-first"]) {
 test(`${provider}/${order} selecting a thinking-only profile clears Fast without switching models`, async () => {
  const model = { provider, api: provider === "openai" ? "openai-responses" : "openai-codex-responses", id: "gpt-5.6-luna" };
  const ref = `${provider}/${model.id}`;
  const manager = SessionManager.inMemory("/nonexistent");
  const integration = createSessionProfileIntegration();
  integration.start(manager, (type, data) => { manager.appendCustomEntry(type, data); }, { reason: "startup" });
  const handlers = new Map<string, Function>();
  const listeners = new Map<string, Function[]>();
  const bus: any = { on: (name: string, fn: Function) => listeners.set(name, [...(listeners.get(name) ?? []), fn]), emit: (name: string, data: unknown) => { for (const fn of listeners.get(name) ?? []) fn(data); } };
  const fastCtx: any = { model, hasUI: false, sessionManager: { getSessionId: () => manager.getSessionId() }, ui: { notify() {} } };
  const ctx: any = { model, sessionManager: manager, modelRegistry: { find: () => model }, hasUI: false, ui: { notify() {} } };
  let switched = 0;
  let succeeds = true;
  const live: any = { events: bus, setModel: async () => { switched++; return succeeds; }, setThinkingLevel() { throw new Error("thinking-only must not change thinking"); }, getThinkingLevel: () => "high" };
  const file = createProfile(createProfile(createProfile(emptyProfilesFile(), "fast", { orchestrator: { model: ref, tier: "fast" } }), "old", { orchestrator: { thinking: "high" } }), "standard", { orchestrator: { model: ref, tier: "standard" } });
  const installFast = () => fast({ on: (name: string, fn: Function) => handlers.set(name, fn), events: bus } as any);
  let select!: (name: string) => Promise<void>;
  const installProfiles = () => { select = async (name) => {
   const result: any[] = [];
   __testing.routingTablePanel(file.profiles[name], [ref], [], 100, undefined, undefined, ["u"], [], result, { file, profileName: name, fastModels: [ref] });
   assert.equal(result[0]?.type, "use-session");
   await __testing.runProfilesPanelAction(ctx, live, "/nonexistent/profiles.json", file, result[0]);
  }; };
  if (order === "fast-first") { installFast(); installProfiles(); } else { installProfiles(); installFast(); }
  handlers.get("session_start")!({}, fastCtx);
  const request = () => handlers.get("before_provider_request")!({ payload: {} }, fastCtx);
  await select("fast");
  assert.equal(request()?.service_tier, "priority", `${provider}/${order}: fast selection`);
  const previousSwitches = switched;
  await select("old");
  assert.equal(request(), undefined, `${provider}/${order}: thinking-only must clear Fast`);
  assert.equal(switched, previousSwitches, `${provider}/${order}: no model switch`);
  await select("fast");
  assert.equal(request()?.service_tier, "priority");
  succeeds = false;
  await select("standard");
  assert.equal(request()?.service_tier, "priority", `${provider}/${order}: failed Standard switch preserves profile Fast`);
 });
}

test("live switching emits tier only for successful and current model switches", async () => {
 const model: any = { provider: "openai", api: "openai-responses", id: "gpt-5.6-luna" };
 const ctx: any = { sessionManager: { getSessionId: () => "test" }, modelRegistry: { find: () => model }, hasUI: false };
 const emitted: any[] = [];
 let success = false;
 let current = true;
 const live: any = { setModel: async () => success, getThinkingLevel: () => "high", setThinkingLevel() {}, events: { emit: (...args: any[]) => emitted.push(args) } };
 const route: any = { model: "openai/gpt-5.6-luna", tier: "fast" };
 await __testing.switchLiveOrchestrator(ctx, live, route, () => current);
 assert.equal(emitted.length, 0);
 success = true;
 current = false;
 await __testing.switchLiveOrchestrator(ctx, live, route, () => current);
 assert.equal(emitted.length, 0);
 current = true;
 await __testing.switchLiveOrchestrator(ctx, live, route, () => current);
 assert.deepEqual(emitted, [[PROFILE_TIER_EVENT, { sessionId: "test", tier: "fast", model: "openai/gpt-5.6-luna" }]]);
});

test("direct provider route applies tier through the provider payload hook", async () => {
 for (const [provider, api] of [["openai", "openai-responses"], ["openai-codex", "openai-codex-responses"]]) {
  const model: any = { provider, api, id: "gpt-5.6-luna", reasoning: false };
  let options: any;
  const registry: any = { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true }) };
  const complete: any = async (_model: any, _context: any, value: any) => { options = value; return { content: [{ type: "text", text: "ok" }], stopReason: "stop" }; };
  const result = await runInProcessReviewer({ selection: `${provider}/${model.id}`, tier: "fast", prompt: Buffer.from("test"), timeoutMs: 1000, routingKey: "review-risk" }, { registry, complete });
  assert.equal(result.kind, "text");
  assert.deepEqual(await options.onPayload({ input: "x" }, model), { input: "x", service_tier: "priority" });
 }
});

test("session snapshots reject invalid tier instead of silently changing binding", () => {
 const entry = { type: "custom", customType: SESSION_PROFILE_CUSTOM_TYPE, data: { kind: "bind", origin: "user", name: "work", modelProfiles: { worker: { model: "openai/gpt-5.6-luna", tier: "invalid" } } } };
 assert.deepEqual(readSessionProfileEntry(entry), { status: "invalid" });
});
