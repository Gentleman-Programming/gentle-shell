import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentStatus } from "../lib/agent-status.ts";

type Handler = (event: any, ctx: ExtensionContext) => void;
const temporaryRoots: string[] = [];
after(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });
async function harness(env: NodeJS.ProcessEnv = {}, failing = false) {
	const { createAgentStatusExtension } = await import("../extensions/gentle-agent-status.ts");
	const home = mkdtempSync(join(tmpdir(), "agent-status-extension-")); temporaryRoots.push(home);
	const handlers = new Map<string, Handler>(); const listeners = new Map<string, (data: any) => void>();
	const values: AgentStatus[] = []; let now = 0; let tick = () => {}; let flush = () => {}; let stopped = false; let removed = 0; let attempts = 0;
	createAgentStatusExtension({ env, gentlePiConfigHome: home, now: () => now,
		store: () => ({ write: (value: AgentStatus) => { attempts++; if (failing) throw Error("disk"); values.push(value); return true; }, remove: () => { removed++; if (failing) throw Error("disk"); } }),
		watch: (fn) => { tick = fn; return () => { stopped = true; }; },
		schedule: (fn) => { flush = fn; return () => { flush = () => {}; }; },
	})({ on: (name: string, fn: Handler) => handlers.set(name, fn), events: { on: (name: string, fn: (data: any) => void) => {
		listeners.set(name, fn); return () => { listeners.delete(name); };
	} } } as unknown as ExtensionAPI);
	const ctx = { cwd: "/workspace", mode: "tui", hasUI: true, isIdle: () => true,
		sessionManager: { getSessionId: () => "root", getBranch: () => [] } } as unknown as ExtensionContext;
	return { values, ctx, listeners, fire: (name: string, event = {}, context = ctx) => { handlers.get(name)?.(event, context); flush(); },
		burst: () => { handlers.get("agent_start")?.({}, ctx); handlers.get("agent_settled")?.({}, ctx); flush(); },
		attention: (active: boolean) => { listeners.get("herdr:blocked")?.({ active }); flush(); },
		settings: (enabled: boolean) => { writeFileSync(join(home, "herdr-task-summary.json"), JSON.stringify({ schema: "gentle-pi.herdr-task-summary/v1", enabled, summaryColor: "accent", continuationColor: "muted" })); },
		change: () => { listeners.get("gentle-pi:herdr-task-summary:changed")?.({ configHome: home }); flush(); },
		pulse: (ms: number) => { now += ms; tick(); flush(); }, stopped: () => stopped, removed: () => removed, attempts: () => attempts, fail: (value: boolean) => { failing = value; } };
}
const todo = (title: string) => ({ toolName: "todo", result: { details: { gentleTodo: { tasks: [{ title, status: "in_progress" }] } } } });
test("S2/S3: initial state, blocked dominance, settled idle guard and label", async () => {
	const h = await harness({ GENTLE_SHELL_HERDR_REPORTER: "1" }); h.fire("session_start");
	assert.equal(h.values.at(-1)?.agent, "gentle-shell"); assert.equal(h.values.at(-1)?.state, "idle");
	h.fire("agent_start"); assert.equal(h.values.at(-1)?.state, "working");
	h.fire("agent_settled", {}, { ...h.ctx, isIdle: () => false }); assert.equal(h.values.at(-1)?.state, "working");
	h.attention(true); h.attention(true); h.fire("agent_start"); h.fire("agent_settled");
	assert.equal(h.values.at(-1)?.state, "blocked"); h.attention(false); assert.equal(h.values.at(-1)?.state, "blocked");
	h.attention(false); assert.equal(h.values.at(-1)?.state, "idle");
	const active = await harness(); active.fire("session_start", {}, { ...active.ctx, isIdle: () => false });
	assert.equal(active.values.at(-1)?.state, "working"); assert.equal(active.values.at(-1)?.agent, "pi");
});
test("S4: task preference, live changes, successful Todo only, settled/tree clear", async () => {
	const h = await harness(); h.settings(false); h.fire("session_start"); h.fire("agent_start");
	h.fire("tool_execution_end", todo("raw\ntitle")); assert.equal(h.values.at(-1)?.task, null);
	h.settings(true); h.change(); assert.deepEqual(h.values.at(-1)?.task, { title: "raw title" });
	h.fire("tool_execution_end", { ...todo("failed"), isError: true }); assert.deepEqual(h.values.at(-1)?.task, { title: "raw title" });
	h.settings(false); h.change(); assert.equal(h.values.at(-1)?.task, null);
	h.settings(true); h.change();
	h.fire("tool_execution_end", { toolName: "todo", result: { details: { gentleTodo: { tasks: [] } } } });
	assert.equal(h.values.at(-1)?.task, null); h.fire("tool_execution_end", todo("raw title"));
	h.fire("agent_settled"); assert.equal(h.values.at(-1)?.task, null);
	h.fire("agent_start"); assert.deepEqual(h.values.at(-1)?.task, { title: "raw title" });
	h.fire("session_tree"); assert.equal(h.values.at(-1)?.task, null);
});
test("S6: coalescing, refresh within 10 seconds, shutdown cancellation/removal", async () => {
	const h = await harness(); h.fire("session_start"); const before = h.values.length;
	h.burst(); assert.equal(h.values.length, before); h.pulse(8999); assert.equal(h.values.length, before);
	h.pulse(1); assert.equal(h.values.length, before + 1); assert.equal(h.values.at(-1)?.updatedAt, "1970-01-01T00:00:09.000Z");
	h.fire("session_shutdown"); assert.ok(h.stopped()); assert.equal(h.removed(), 1); assert.equal(h.listeners.size, 0);
	h.pulse(10000); h.fire("agent_start"); assert.equal(h.values.length, before + 1);
});
test("S7: children and noninteractive excluded; Herdr not required; ownership guarded", async () => {
	for (const [env, mode] of [[{ GENTLE_PI_AGENTS_CHILD: "1" }, "tui"], [{}, "rpc"], [{}, "json"]] as const) {
		const h = await harness(env); h.fire("session_start", {}, { ...h.ctx, mode } as ExtensionContext); h.fire("agent_start"); assert.deepEqual(h.values, []);
	}
	const h = await harness(); h.fire("session_start"); assert.equal(h.values.length, 1);
	h.fire("agent_start", {}, { ...h.ctx, sessionManager: { getSessionId: () => "other" } } as ExtensionContext);
	assert.equal(h.values.at(-1)?.state, "idle");
});
test("S6: writer and removal failures never escape into Pi", async () => {
	const h = await harness({}, true);
	assert.doesNotThrow(() => { h.fire("session_start"); h.fire("agent_start"); h.pulse(10000); h.fire("session_shutdown"); });
});
test("S6: a refused store backs off instead of retrying every tick", async () => {
	const h = await harness({}, true); h.fire("session_start"); assert.equal(h.attempts(), 1);
	for (let i = 0; i < 29; i++) h.pulse(1000);
	h.fire("agent_start"); assert.equal(h.attempts(), 1);
	h.pulse(1000); assert.equal(h.attempts(), 2);
});
test("S4: disabling task summaries redacts the title even during write backoff", async () => {
	const h = await harness(); h.settings(true); h.fire("session_start"); h.fire("agent_start");
	h.fire("tool_execution_end", todo("secret title")); assert.deepEqual(h.values.at(-1)?.task, { title: "secret title" });
	h.fail(true); h.pulse(10000); const attempts = h.attempts();
	h.fail(false); h.settings(false); h.change();
	assert.equal(h.attempts(), attempts + 1); assert.equal(h.values.at(-1)?.task, null);
});
