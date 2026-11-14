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

// ---------- T5: actions requested from the web view ----------
import { writeTowerAction } from "../lib/tower-actions.ts";
import { DESKTOP_AGENTS_SERVICE_SCHEMA } from "../lib/desktop-rpc-agents.ts";

function actionPi(mode: string) {
	const base = fakePi();
	const sent: Array<{ text: string; opts?: unknown }> = [];
	const cancelled: string[] = [];
	const modes: string[] = [];
	let current = mode;
	const pi = base.pi as unknown as Record<string, unknown>;
	pi.sendUserMessage = (text: string, opts?: unknown) => sent.push({ text, opts });
	const events = pi.events as { on(n: string, fn: (d: unknown) => void): () => void };
	events.on("gentle:yolo:host-ui", (req) => (req as { respond(a: unknown): void }).respond({
		read: async () => "OFF", toggle: async () => {}, observe: () => () => {}, dispose() {},
		readSnapshot: async () => ({ yolo: "OFF", mode: current, defaultMode: "normal" }),
		setMode: async (m: string) => { modes.push(m); current = m; return true; },
	}));
	events.on("gentle:desktop:agents-service", (req) => (req as { respond(a: unknown): void }).respond({
		read: () => ({ sessionId: "sess-1", agents: [{ id: "t1", agent: "gentle-ai-worker", status: "running", model: "m", lastStep: "editing", usage: { total: 10, cost: 0.01 } }] }),
		schema: DESKTOP_AGENTS_SERVICE_SCHEMA, observe: () => () => {}, cancel: async (id: string) => { cancelled.push(id); return true; }, dispose() {},
	}));
	return { ...base, sent, cancelled, modes, current: () => current };
}
const busyCtx = (idle: boolean) => ({ ...fakeCtx([assistant(0.1)]), isIdle: () => idle }) as unknown as ExtensionContext;

test("a web message reaches the floor: a new turn when idle, a follow-up when busy", async () => {
	const dir = hub();
	const { pi, fire, sent } = actionPi("normal");
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, reviewCli: async () => "{}" });
	let idle = true;
	const ctx = { ...busyCtx(true), isIdle: () => idle } as unknown as ExtensionContext;
	await fire("session_start", ctx);
	await wait(150);
	writeTowerAction(dir, { type: "message", sessionId: "sess-1", text: "also update the docs" });
	await wait(120);
	idle = false;
	writeTowerAction(dir, { type: "message", sessionId: "sess-1", text: "and the changelog" });
	await wait(120);
	assert.deepEqual(sent, [{ text: "also update the docs", opts: undefined }, { text: "and the changelog", opts: { deliverAs: "followUp" } }]);
	await fire("session_shutdown", ctx);
});

test("stop helper cancels exactly that subagent", async () => {
	const dir = hub();
	const { pi, fire, cancelled } = actionPi("normal");
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, reviewCli: async () => "{}" });
	const ctx = busyCtx(false);
	await fire("session_start", ctx);
	await wait(150);
	writeTowerAction(dir, { type: "cancel-helper", sessionId: "sess-1", helperId: "t1" });
	await wait(120);
	assert.deepEqual(cancelled, ["t1"]);
	assert.match(readTowerSnapshots(dir)[0].notice?.text ?? "", /Stopped worker/);
	await fire("session_shutdown", ctx);
});

test("the door only lowers permissions from the web; raising stays in the terminal", async () => {
	const dir = hub();
	const { pi, fire, modes, current } = actionPi("yolo");
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, reviewCli: async () => "{}" });
	const ctx = busyCtx(true);
	await fire("session_start", ctx);
	await wait(150);
	assert.equal(readTowerSnapshots(dir)[0].permission, "yolo");
	writeTowerAction(dir, { type: "permission", sessionId: "sess-1", mode: "normal" });
	await wait(150);
	assert.deepEqual(modes, ["normal"]);
	assert.equal(readTowerSnapshots(dir)[0].permission, "normal");
	writeTowerAction(dir, { type: "permission", sessionId: "sess-1", mode: "auto" });
	await wait(150);
	assert.deepEqual(modes, ["normal"], "raising to auto is refused");
	assert.equal(current(), "normal");
	const s = readTowerSnapshots(dir)[0];
	assert.equal(s.notice?.ok, false);
	assert.match(s.notice?.text ?? "", /terminal/);
	await fire("session_shutdown", ctx);
});

test("the review switch runs the review mode command and shows the new state", async () => {
	const dir = hub();
	const calls: string[][] = [];
	let state = "on";
	const { pi, fire } = actionPi("normal");
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, reviewCli: async (args) => {
		calls.push(args);
		if (args[2] === "disable") state = "off";
		if (args[2] === "enable") state = "on";
		return JSON.stringify({ status: { effective: state } });
	} });
	const ctx = busyCtx(true);
	await fire("session_start", ctx);
	await wait(150);
	assert.equal(readTowerSnapshots(dir)[0].review, "on");
	writeTowerAction(dir, { type: "review", sessionId: "sess-1", enabled: false });
	await wait(150);
	assert.deepEqual(calls.map((a) => a.join(" ")), ["review mode status --json", "review mode disable", "review mode status --json"]);
	assert.equal(readTowerSnapshots(dir)[0].review, "off");
	await fire("session_shutdown", ctx);
});

test("a question waiting in the terminal shows on the floor", async () => {
	const dir = hub();
	const { pi, fire, emit } = actionPi("normal");
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, reviewCli: async () => "{}" });
	const ctx = busyCtx(false);
	await fire("session_start", ctx);
	emit("gentle-pi:ask-user-question:blocked", { active: true });
	await wait(150);
	assert.equal(readTowerSnapshots(dir)[0].waiting, true);
	emit("gentle-pi:ask-user-question:blocked", { active: false });
	await wait(80);
	assert.equal(readTowerSnapshots(dir)[0].waiting, undefined);
	await fire("session_shutdown", ctx);
});

test("the floor carries the orchestrator's latest words, bounded", async () => {
	const dir = hub();
	const { pi, fire } = fakePi();
	const long = "Found it. ".repeat(100);
	const branch = [
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "old reply" }], usage: { input: 1, output: 1, cost: { total: 0 } } } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "read", arguments: {} }, { type: "text", text: long }], usage: { input: 1, output: 1, cost: { total: 0 } } } },
	];
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, reviewCli: async () => "{}" });
	const ctx = fakeCtx(branch);
	await fire("session_start", ctx);
	await wait(180);
	const said = readTowerSnapshots(dir)[0].said ?? "";
	assert.ok(said.startsWith("Found it."));
	assert.ok(said.length <= 600);
	assert.doesNotMatch(said, /hidden|old reply/);
	await fire("session_shutdown", ctx);
});
