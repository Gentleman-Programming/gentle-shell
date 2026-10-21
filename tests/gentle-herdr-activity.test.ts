import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrActivityExtension } from "../extensions/gentle-herdr-activity.ts";
import { oddPhaseRegistry } from "../lib/odd-phase.ts";
import { metadataArgs } from "../lib/herdr-activity.ts";

type Handler = (event: any, ctx: ExtensionContext) => void;
function harness(overrides: NodeJS.ProcessEnv = {}, socket = true) {
	const handlers = new Map<string, Handler>();
	const values: Array<string | null> = [];
	const reports: string[][] = [];
	let tick: (() => void) | undefined;
	let stopped = false;
	let now = 1000;
	let columns = 30;
	const options = {
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane", HERDR_SOCKET_PATH: "/socket", ...overrides },
		isSocket: () => socket,
		now: () => now,
		columns: () => columns,
		send: async (summary: string | null, seq: number) => {
			values.push(summary); reports.push(metadataArgs("pane", summary, seq));
		},
		watch: (fn: () => void) => { tick = fn; return () => { stopped = true; }; },
	};
	createHerdrActivityExtension(options)({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as unknown as ExtensionAPI);
	const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "root", getBranch: () => [] } } as unknown as ExtensionContext;
	return { handlers, values, reports, ctx, tick: () => tick?.(), stopped: () => stopped,
		advance: (ms: number) => { now += ms; }, columns: (value: number) => { columns = value; },
		fire: (name: string, event = {}, context = ctx) => handlers.get(name)?.(event, context) };
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 180));
const todo = (title?: string) => ({ toolName: "todo", result: { details: { gentleTodo: {
	tasks: title === undefined ? [] : [{ title, status: "in_progress" }],
} } } });
test("tools and failed Todo snapshots never supply fallback summaries", async () => {
	const h = harness(); h.fire("session_start"); h.fire("agent_start");
	h.fire("tool_execution_start", { toolName: "read", args: { path: "secret" } });
	h.tick(); await wait(); assert.equal(h.values.at(-1), null);
	h.fire("tool_execution_end", { toolName: "read" });
	h.tick(); await wait(); assert.equal(h.values.at(-1), null);
	h.fire("tool_execution_end", { toolName: "todo", isError: true,
		result: { details: { gentleTodo: { tasks: [{ title: "failed", status: "in_progress" }] } } } });
	h.tick(); await wait(); assert.equal(h.values.at(-1), null);
	h.fire("session_shutdown");
});
test("children, missing Herdr and socket, and non-TUI never publish", async () => {
	for (const h of [harness({ GENTLE_PI_AGENTS_CHILD: "1" }), harness({ HERDR_ENV: "0" }), harness({ HERDR_PANE_ID: "" }), harness({}, false)]) {
		h.fire("session_start"); h.fire("agent_start"); await wait(); assert.deepEqual(h.values, []);
	}
	const h = harness();
	h.fire("session_start", {}, { ...h.ctx, mode: "rpc" } as ExtensionContext);
	h.fire("agent_start"); await wait(); assert.deepEqual(h.values, []);
});

test("root uses only Todo despite ODD; TTL, idle, ownership and cleanup remain guarded", async () => {
	const h = harness(); h.fire("session_start"); h.fire("agent_start");
	oddPhaseRegistry.report("root", "exploring");
	h.fire("tool_execution_end", { toolName: "todo", result: { details: { gentleTodo: { tasks: [{ title: "Revisar integración Herdr", status: "in_progress" }] } } } });
	h.tick(); await wait(); assert.equal(h.values.at(-1), "◐ Revisar integración Herdr");
	const count = h.values.length;
	h.tick(); await wait(); assert.equal(h.values.length, count);
	h.advance(10000); h.tick(); await wait(); assert.equal(h.values.length, count + 1);
	h.fire("agent_settled", {}, { ...h.ctx, sessionManager: { getSessionId: () => "child" } } as ExtensionContext);
	assert.notEqual(h.values.at(-1), null);
	h.fire("agent_settled"); await wait(); assert.equal(h.values.at(-1), null);
	h.fire("agent_start"); h.tick(); await wait();
	h.fire("session_start"); await wait(); assert.equal(h.values.at(-1), null);
	h.fire("session_shutdown"); await wait(); assert.ok(h.stopped());
	oddPhaseRegistry.clear("root");
});

test("width changes reproject and long-to-short/no-task/idle clear both rows together", async () => {
	const h = harness(); h.fire("session_start"); h.fire("agent_start"); h.columns(12);
	h.fire("tool_execution_end", todo("one two three four")); h.tick(); await wait();
	assert.equal(h.values.at(-1), "◐ one two\n  three four");
	h.columns(30); h.tick(); await wait();
	assert.equal(h.values.at(-1), "◐ one two three four");
	h.columns(12); h.tick(); await wait();
	h.fire("tool_execution_end", todo("short")); h.tick(); await wait();
	assert.equal(h.values.at(-1), "◐ short");
	assert.deepEqual(h.reports.at(-1)?.slice(-4), ["--token", "summary=◐ short", "--clear-token", "summary2"]);
	h.fire("tool_execution_end", todo()); h.tick(); await wait();
	assert.equal(h.values.at(-1), null);
	h.fire("tool_execution_end", todo("active")); h.tick(); await wait();
	h.fire("session_tree"); await wait(); assert.equal(h.values.at(-1), null);
	assert.deepEqual(h.reports.at(-1)?.slice(-4), ["--clear-token", "summary", "--clear-token", "summary2"]);
	h.fire("session_shutdown");
});

test("malformed successful Todo snapshots clear previous activity, unlike failed snapshots", async () => {
	const h = harness(); h.fire("session_start"); h.fire("agent_start");
	for (const tasks of [null, {}, [{ title: 42, status: "in_progress" }]]) {
		h.fire("tool_execution_end", todo("valid")); h.tick(); await wait();
		h.fire("tool_execution_end", { toolName: "todo", result: { details: { gentleTodo: { tasks } } } });
		h.tick(); await wait(); assert.equal(h.values.at(-1), null);
	}
	h.fire("session_shutdown");
});
