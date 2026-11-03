import assert from "node:assert/strict";
import test from "node:test";
import fast from "../extensions/gentle-fast.ts";
import { PROFILE_TIER_EVENT } from "../lib/openai-fast-tier.ts";

const native = { provider: "openai", api: "openai-responses", id: "gpt-6.1-sol" };
const legacy = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" };

function harness(model: any = native) {
 const events = new Map<string, Function>();
 const bus = new Map<string, Function>();
 const commands = new Map<string, any>();
 const statuses: (string | undefined)[] = [];
 const ctx: any = { model, hasUI: true, sessionManager: { getSessionId: () => "fast-test" }, ui: { setStatus: (_key: string, value?: string) => statuses.push(value) } };
 fast({ on: (name: string, fn: Function) => events.set(name, fn), events: { on: (name: string, fn: Function) => bus.set(name, fn) }, registerCommand: (name: string, command: any) => commands.set(name, command) } as any);
 events.get("session_start")!({}, ctx);
 return {
  ctx, commands, statuses, hasEvent: (name: string) => events.has(name),
  profile(tier?: string, ref = `${ctx.model.provider}/${ctx.model.id}`, id = "fast-test") { bus.get(PROFILE_TIER_EVENT)!({ sessionId: id, tier, model: ref }); },
  event: (name: string, event: any = {}) => events.get(name)!(event, ctx),
  request: (payload: unknown) => events.get("before_provider_request")!({ payload }, ctx),
  stream: (data: unknown, source: any = ctx.model) => events.get("provider_stream_event")?.({ provider: source.provider, api: source.api, model: source.id, data }, ctx),
 };
}

test("Profiles replaces the slash selector", () => {
 const h = harness();
 assert.equal(h.commands.has("fast"), false);
});

test("Fast request handling publishes no integration status or response observer", () => {
 for (const model of [native, legacy]) {
  const h = harness(model);
  h.profile("fast");
  assert.equal((h.request({}) as any).service_tier, "priority");
  h.stream({ type: "response.completed", response: { service_tier: "default" } });
  assert.deepEqual(h.statuses, []);
  assert.equal(h.hasEvent("provider_stream_event"), false);
 }
});

test("profile, model, session and tree changes keep request tier authority", () => {
 const h = harness();
 h.profile("fast"); assert.equal((h.request({}) as any).service_tier, "priority");
 h.profile("standard", undefined, "foreign-session");
 assert.equal((h.request({}) as any).service_tier, "priority");
 h.profile("standard"); assert.equal((h.request({}) as any).service_tier, "default");
 h.ctx.model = legacy; h.event("model_select", { model: legacy });
 assert.equal(h.request({}), undefined);
 h.profile("fast"); assert.equal((h.request({}) as any).service_tier, "priority");
 h.event("session_tree"); assert.equal(h.request({}), undefined);
 h.profile("fast"); h.event("session_start"); assert.equal(h.request({}), undefined);
});

test("profile tiers rewrite only supported routes and preserve payload fields", () => {
 const ids = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra"];
 for (const model of [native, legacy, ...ids.map((id) => ({ ...native, id }))]) {
  const h = harness(model); h.profile("fast");
  const payload = { model: model.id, input: [{ text: "hello" }], service_tier: "flex", tools: [{ type: "function" }] };
  assert.deepEqual(h.request(payload), { ...payload, service_tier: "priority" });
  assert.equal(payload.service_tier, "flex");
  h.profile("standard"); assert.equal((h.request(payload) as any).service_tier, "default");
  for (const invalid of [null, [], "text"]) assert.equal(h.request(invalid), undefined);
 }
 for (const model of [{ ...native, provider: "proxy" }, { ...native, api: "openai-completions" }, { ...native, provider: "openai-codex" }, { ...legacy, provider: "openai" }, { ...native, id: "gpt-6.1-sol-future" }, { ...native, id: "gpt-5.5" }]) {
  const h = harness(model); h.profile("fast");
  assert.equal(h.request({ service_tier: "flex" }), undefined);
  h.stream({ type: "response.completed", response: { service_tier: "priority" } });
  assert.deepEqual(h.statuses, []);
 }
 const h = harness();
 assert.equal(h.request({ service_tier: "flex" }), undefined);
});
