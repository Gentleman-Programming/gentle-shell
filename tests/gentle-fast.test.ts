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
  ctx, commands, statuses,
  profile(tier?: string, ref = `${ctx.model.provider}/${ctx.model.id}`, id = "fast-test") { bus.get(PROFILE_TIER_EVENT)!({ sessionId: id, tier, model: ref }); },
  event: (name: string, event: any = {}) => events.get(name)!(event, ctx),
  request: (payload: unknown) => events.get("before_provider_request")!({ payload }, ctx),
  stream: (data: unknown, source: any = ctx.model) => events.get("provider_stream_event")!({ provider: source.provider, api: source.api, model: source.id, data }, ctx),
 };
}

test("Profiles replaces the slash selector", () => {
 const h = harness();
 assert.equal(h.commands.has("fast"), false);
});

test("footer reports the terminal server tier separately from the requested tier", () => {
 for (const model of [native, legacy]) {
  const h = harness(model);
  h.profile("fast");
  assert.match(h.statuses.at(-1) ?? "", /fast requested.*not yet observed/i);
  for (const tier of ["priority", "fast", "default", undefined, "flex"]) {
   const requested = tier === "priority" || tier === "fast" ? "standard" : "fast";
   h.profile(requested);
   const payload = { input: [{ text: "private input" }] };
   assert.deepEqual(h.request(payload), { ...payload, service_tier: requested === "fast" ? "priority" : "default" });
   const data = { type: model === legacy ? "response.done" : "response.completed", response: { id: "r", service_tier: tier, output: [{ secret: "private output" }] } };
   const copy = structuredClone(data);
   h.stream({ type: "response.created", response: { id: "r", service_tier: "priority" } });
   h.stream(data);
   assert.deepEqual(data, copy);
   assert.match(h.statuses.at(-1) ?? "", tier === "priority" || tier === "fast" ? /standard requested.*last response.*fast/i : tier === "default" ? /fast requested.*last response.*standard/i : /fast requested.*cannot confirm/i);
   assert.doesNotMatch(h.statuses.join(" "), /private/);
  }
 }
});

test("observation respects request, source and response ID", () => {
 const h = harness();
 h.profile("fast");
 h.request({});
 h.stream({ type: "response.created", response: { id: "current" } });
 for (const model of [legacy, { ...native, provider: "proxy" }, { ...native, id: "gpt-5.5" }, { ...native, api: "openai-completions" }]) h.stream({ type: "response.completed", response: { id: "current", service_tier: "priority" } }, model);
 h.stream({ type: "response.completed", response: { id: "other", service_tier: "priority" } });
 assert.match(h.statuses.at(-1) ?? "", /not yet observed/i);
 h.stream({ type: "response.completed", response: { id: "current", service_tier: "default" } });
 assert.match(h.statuses.at(-1) ?? "", /last response.*standard/i);
 h.request({});
 h.stream({ type: "response.created", response: { id: "new" } });
 h.stream({ type: "response.completed", response: { service_tier: "priority" } });
 assert.match(h.statuses.at(-1) ?? "", /cannot confirm/i);
});

test("model, session, tree and profile changes clear observations and invalidate in-flight events", () => {
 const h = harness();
 function observe() {
  h.request({}); h.stream({ type: "response.incomplete", response: { service_tier: "priority" } });
  assert.match(h.statuses.at(-1) ?? "", /last response.*fast/i);
  h.request({}); h.stream({ type: "response.created", response: { id: "pending" } });
 }
 h.profile("fast"); observe();
 h.profile("standard");
 h.stream({ type: "response.completed", response: { id: "pending", service_tier: "priority" } });
 assert.match(h.statuses.at(-1) ?? "", /standard requested.*not yet observed/i);
 assert.equal((h.request({}) as any).service_tier, "default");
 observe();
 h.ctx.model = legacy; h.event("model_select", { model: legacy });
 assert.equal(h.statuses.at(-1), undefined);
 assert.equal(h.request({}), undefined);
 h.profile("fast"); observe();
 h.event("session_tree");
 assert.equal(h.statuses.at(-1), undefined);
 h.profile("fast"); observe();
 h.event("session_start");
 h.stream({ type: "response.completed", response: { id: "pending", service_tier: "priority" } });
 assert.equal(h.statuses.at(-1), undefined);
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
  assert.match(h.statuses.at(-1) ?? "", /inactive.*not yet observed/i);
 }
 const h = harness();
 assert.equal(h.request({ service_tier: "flex" }), undefined);
});
