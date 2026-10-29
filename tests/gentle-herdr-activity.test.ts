import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrActivityExtension } from "../extensions/gentle-herdr-activity.ts";
import { oddPhaseRegistry } from "../lib/odd-phase.ts";
import { metadataArgs } from "../lib/herdr-activity.ts";

type Handler = (event: any, ctx: ExtensionContext) => void;
function harness(overrides: NodeJS.ProcessEnv = {}, socket = true) {
	const home = resolve("odd/work/herdr-auto-apply-B/activity");
	mkdirSync(home, { recursive: true });
	const configHome = mkdtempSync(join(home, "session-"));
	const subscribers = new Set<(data: unknown) => void>();
	const handlers = new Map<string, Handler>();
	const values: Array<string | null> = [];
	const reports: string[][] = [];
	let tick: (() => void) | undefined;
	let stopped = false;
	let now = 1000;
	let columns = 30;
	const options = {
		gentlePiConfigHome: configHome,
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane", HERDR_SOCKET_PATH: "/socket", ...overrides },
		isSocket: () => socket,
		now: () => now,
		columns: () => columns,
		send: async (summary: string | null, seq: number) => {
			values.push(summary); reports.push(metadataArgs("pane", summary, seq));
		},
		watch: (fn: () => void) => { tick = fn; return () => { stopped = true; }; },
	};
	createHerdrActivityExtension(options)({
		on: (name: string, fn: Handler) => handlers.set(name, fn),
		events: { on: (name: string, fn: (data: unknown) => void) => {
			assert.equal(name, "gentle-pi:herdr-task-summary:changed");
			subscribers.add(fn); return () => subscribers.delete(fn);
		} },
	} as unknown as ExtensionAPI);
	const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "root", getBranch: () => [] } } as unknown as ExtensionContext;
	return { handlers, values, reports, ctx, tick: () => tick?.(), stopped: () => stopped,
		listeners: () => subscribers.size,
		settings: (enabled: boolean) => writeFileSync(join(configHome, "herdr-task-summary.json"), JSON.stringify({
			schema: "gentle-pi.herdr-task-summary/v1", enabled, summaryColor: "success", continuationColor: "dim",
		})),
		change: (home = configHome) => { for (const fn of subscribers) fn({ configHome: home }); },
		malformed: () => writeFileSync(join(configHome, "herdr-task-summary.json"), "{"),
		advance: (ms: number) => { now += ms; }, columns: (value: number) => { columns = value; },
		fire: (name: string, event = {}, context = ctx) => handlers.get(name)?.(event, context) };
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 180));
const todo = (title?: string) => ({ toolName: "todo", result: { details: { gentleTodo: {
	tasks: title === undefined ? [] : [{ title, status: "in_progress" }],
} } } });
test("live disable clears only owned rows, tracks Todo and resumes latest working title", async () => {
	const h = harness(); assert.equal(h.listeners(), 0);
	h.fire("session_start"); assert.equal(h.listeners(), 1);
	h.fire("agent_start"); h.fire("tool_execution_end", todo("first")); await wait();
	const before = h.values.length;
	h.settings(false); h.change("/different-home"); await wait(); assert.equal(h.values.length, before);
	h.change(); assert.equal(h.values.at(-1), null); await wait();
	assert.equal(h.values.length, before + 1);
	assert.deepEqual(h.reports.at(-1)?.slice(-4), ["--clear-token", "summary", "--clear-token", "summary2"]);
	h.fire("tool_execution_end", todo("latest")); h.advance(10000); h.tick(); await wait();
	assert.equal(h.values.length, before + 1);
	h.settings(true); h.change(); await wait(); assert.equal(h.values.at(-1), "◐ latest");
	assert.deepEqual(h.reports.at(-1)?.slice(-4), ["--token", "summary=◐ latest", "--clear-token", "summary2"]);
	for (let i = 1; i < h.reports.length; i++) assert.equal(Number(h.reports[i][8]), Number(h.reports[i - 1][8]) + 1);
	h.fire("session_shutdown"); await wait(); assert.equal(h.listeners(), 0); assert.ok(h.stopped());
	const closed = h.values.length; h.settings(false); h.change(); h.tick(); await wait();
	assert.equal(h.values.length, closed);
});

test("disable supersedes queued title; idle and replaced sessions cannot resume stale activity", async () => {
	const h = harness(); h.fire("session_start"); h.fire("agent_start");
	h.fire("tool_execution_end", todo("queued")); h.settings(false); h.change(); await wait();
	assert.ok(!h.values.includes("◐ queued"));
	h.fire("tool_execution_end", todo("hidden")); h.fire("agent_settled");
	const idle = h.values.length; h.settings(true); h.change(); await wait(); assert.equal(h.values.length, idle);
	h.fire("agent_start"); await wait(); assert.equal(h.values.at(-1), "◐ hidden");
	h.settings(false); h.change(); h.fire("session_start"); assert.equal(h.listeners(), 1); await wait();
	const replaced = h.values.length; h.settings(true); h.change(); await wait(); assert.equal(h.values.length, replaced);
	h.fire("session_shutdown");
	const child = harness({ GENTLE_PI_AGENTS_CHILD: "1" }); child.settings(false);
	child.fire("session_start"); child.settings(true); child.change(); child.fire("agent_start");
	child.fire("tool_execution_end", todo("child")); await wait();
	assert.deepEqual(child.values, []); assert.equal(child.listeners(), 0);
});

test("initial disabled preference and rejected live changes have no summary effects", async () => {
	const h = harness(); h.settings(false); h.fire("session_start"); h.fire("agent_start");
	h.fire("tool_execution_end", todo("hidden")); h.tick(); await wait(); assert.deepEqual(h.values, [null]);
	h.malformed(); h.change(); h.tick(); await wait(); assert.deepEqual(h.values, [null]);
	h.settings(true); h.change(); await wait(); assert.deepEqual(h.values, [null, "◐ hidden"]);
	const reports = structuredClone(h.reports);
	h.malformed(); h.change(); h.tick(); await wait(); assert.deepEqual(h.reports, reports);
	h.fire("session_shutdown");
});

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
