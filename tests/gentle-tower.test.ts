import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTowerPublisher } from "../extensions/gentle-tower.ts";
import { readTowerSnapshots } from "../lib/tower-hub.ts";
import { TODO_PROGRESS_EVENT } from "../lib/shell-todo.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function hub(): string {
	const r = mkdtempSync(join(tmpdir(), "gentle-tower-ext-"));
	roots.push(r);
	return join(r, "sessions");
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		on(name: string, fn: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
		events: {
			on(name: string, fn: (data: unknown) => void) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => {}; },
			emit(name: string, data: unknown) { for (const fn of listeners.get(name) ?? []) fn(data); },
		},
		getThinkingLevel: () => "high",
		registerCommand() {},
	} as unknown as ExtensionAPI;
	const fire = async (name: string, ctx: ExtensionContext) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
	return { pi, fire, emit: (name: string, data: unknown) => (pi.events as unknown as { emit(n: string, d: unknown): void }).emit(name, data) };
}

const todoEntry = (tasks: unknown[]) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details: { gentleTodo: { tasks, nextId: tasks.length + 1 } } } });
const assistant = (cost: number) => ({ type: "message", message: { role: "assistant", usage: { input: 1000, output: 100, cost: { total: cost } } } });

function fakeCtx(branch: unknown[], id = "sess-1"): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => id, getSessionName: () => "Token refresh fix", getCwd: () => "/work/gentle-ai", getBranch: () => branch },
		model: { id: "claude-opus-5-5", reasoning: true },
		getContextUsage: () => ({ percent: 38, contextWindow: 200000 }),
	} as unknown as ExtensionContext;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a finished turn publishes the session's real snapshot", async () => {
	const dir = hub();
	const { pi, fire } = fakePi();
	const branch = [assistant(0.3), todoEntry([{ id: 1, title: "Reproduce", status: "done" }, { id: 2, title: "Fix it", status: "in_progress", note: "editing" }]), assistant(0.12)];
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, now: () => 42 });
	const ctx = fakeCtx(branch);
	await fire("session_start", ctx);
	await fire("turn_end", ctx);
	await wait(180);
	const [s] = readTowerSnapshots(dir);
	assert.equal(s.sessionId, "sess-1");
	assert.equal(s.name, "Token refresh fix");
	assert.deepEqual(s.project, { cwd: "/work/gentle-ai", name: "gentle-ai" });
	assert.equal(s.model, "claude-opus-5-5");
	assert.equal(s.effort, "high");
	assert.deepEqual(s.context, { percent: 38, window: 200000 });
	assert.ok(Math.abs(s.cost.total - 0.42) < 1e-9);
	assert.equal(s.cost.input, 2000);
	assert.deepEqual(s.todos.map((t) => [t.title, t.status]), [["Reproduce", "done"], ["Fix it", "in_progress"]]);
	assert.deepEqual(s.subagents, []);
	assert.equal(s.updatedAt, 42);
});

test("a subagent child session never publishes a floor", async () => {
	const dir = hub();
	const { pi, fire } = fakePi();
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir, GENTLE_PI_AGENTS_CHILD: "1" }, debounceMs: 0 });
	const ctx = fakeCtx([assistant(0.1)]);
	await fire("session_start", ctx);
	await fire("turn_end", ctx);
	await wait(180);
	assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0);
});

test("closing the session removes its floor", async () => {
	const dir = hub();
	const { pi, fire } = fakePi();
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0 });
	const ctx = fakeCtx([assistant(0.1)]);
	await fire("session_start", ctx);
	await fire("turn_end", ctx);
	await wait(180);
	assert.equal(readTowerSnapshots(dir).length, 1);
	await fire("session_shutdown", ctx);
	assert.deepEqual(readTowerSnapshots(dir), []);
});

test("a todo change republishes the floor's tasks", async () => {
	const dir = hub();
	const { pi, fire, emit } = fakePi();
	const branch: unknown[] = [todoEntry([{ id: 1, title: "Plan", status: "in_progress" }])];
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0 });
	const ctx = fakeCtx(branch);
	await fire("session_start", ctx);
	await wait(180);
	assert.deepEqual(readTowerSnapshots(dir)[0].todos.map((t) => t.status), ["in_progress"]);
	branch.push(todoEntry([{ id: 1, title: "Plan", status: "done" }]));
	emit(TODO_PROGRESS_EVENT, { sessionId: "sess-1", done: 1, total: 1 });
	await wait(180);
	assert.deepEqual(readTowerSnapshots(dir)[0].todos.map((t) => t.status), ["done"]);
});

function commandPi() {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void; description?: string }>();
	const base = fakePi();
	(base.pi as unknown as { registerCommand: unknown }).registerCommand = (name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void; description?: string }) => commands.set(name, spec);
	return { ...base, commands };
}
function uiCtx(messages: string[]): ExtensionContext {
	return { ...fakeCtx([]), ui: { notify: (m: string) => messages.push(m) } } as unknown as ExtensionContext;
}

test("/gentle:tower opens the local tower once and reuses it", async () => {
	const dir = hub();
	const web = join(dir, "..", "web");
	(await import("node:fs")).mkdirSync(web, { recursive: true });
	(await import("node:fs")).writeFileSync(join(web, "index.html"), "<title>Gentle Tower</title>");
	const { pi, commands } = commandPi();
	const opened: string[] = [];
	const tower = createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, webDir: web, openUrl: (u) => opened.push(u) });
	const cmd = commands.get("gentle:tower");
	assert.ok(cmd, "command registered");
	assert.match(cmd.description ?? "", /tower/i);
	const messages: string[] = [];
	await cmd.handler("", uiCtx(messages));
	await cmd.handler("", uiCtx(messages));
	assert.equal(opened.length, 2);
	assert.equal(opened[0], opened[1]);
	assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32,}\/$/);
	assert.match(messages[0], /Gentle Tower: http:\/\/127\.0\.0\.1/);
	await tower?.close();
});

test("/gentle:tower explains when the web app is not built", async () => {
	const dir = hub();
	const { pi, commands } = commandPi();
	const opened: string[] = [];
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, webDir: join(dir, "missing"), openUrl: (u) => opened.push(u) });
	const messages: string[] = [];
	await commands.get("gentle:tower")!.handler("", uiCtx(messages));
	assert.deepEqual(opened, []);
	assert.match(messages[0], /web app is not built/);
});
