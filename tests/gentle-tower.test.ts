import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTowerPublisher } from "../extensions/gentle-tower.ts";
import { readTowerSnapshots } from "../lib/tower-hub.ts";
import { TODO_PROGRESS_EVENT } from "../lib/shell-todo.ts";
import { startTowerServer } from "../lib/tower-server.ts";
import { TOWER_CHAT_TURNS } from "../lib/tower-snapshot.ts";
import { sentMessage, settleOutbox, type Outgoing } from "../web/tower/src/model.ts";

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

interface YoloFake { readSnapshot?: (current: string) => Promise<unknown>; setMode?: (m: string, commit: () => void) => Promise<boolean> }
function actionPi(mode: string, cancel?: (id: string) => Promise<boolean>, yoloFake: YoloFake = {}) {
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
		readSnapshot: async () => (yoloFake.readSnapshot ? yoloFake.readSnapshot(current) : { yolo: "OFF", mode: current, defaultMode: "normal" }),
		setMode: async (m: string) => {
			modes.push(m);
			if (yoloFake.setMode) return yoloFake.setMode(m, () => { current = m; });
			current = m;
			return true;
		},
	}));
	events.on("gentle:desktop:agents-service", (req) => (req as { respond(a: unknown): void }).respond({
		read: () => ({ sessionId: "sess-1", agents: [{ id: "t1", agent: "gentle-ai-worker", status: "running", model: "m", lastStep: "editing", usage: { total: 10, cost: 0.01 } }] }),
		schema: DESKTOP_AGENTS_SERVICE_SCHEMA, observe: () => () => {}, cancel: cancel ?? (async (id: string) => { cancelled.push(id); return true; }), dispose() {},
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
	// The message shows up in the conversation itself; no standalone "delivered" notice.
	assert.equal(readTowerSnapshots(dir)[0].notice, undefined);
	await fire("session_shutdown", ctx);
});

test("a Tower follow-up survives the publisher and outbox after many tool turns", async () => {
	const dir = hub(), web = join(dir, "..", "web");
	mkdirSync(web, { recursive: true }); writeFileSync(join(web, "index.html"), "<title>test</title>");
	const T = 1_700_000_000_000;
	const branch: unknown[] = [
		{ type: "message", message: { role: "user", content: "terminal question", timestamp: T - 1000 } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "previous reply" }], timestamp: T - 500 } },
	];
	const action = actionPi("normal");
	const send = action.pi.sendUserMessage;
	(action.pi as unknown as { sendUserMessage: (text: string, opts?: unknown) => void }).sendUserMessage = (text, opts) => {
		send(text, opts as never);
		// Pi persists an extension-sent user message as a normal branch entry.
		branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: T + 10 } });
	};
	const ctx = { ...fakeCtx(branch), isIdle: () => false } as unknown as ExtensionContext;
	createTowerPublisher(action.pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, reviewCli: async () => "{}", now: () => T + 1000 });
	await action.fire("session_start", ctx);
	await wait(150);
	const server = await startTowerServer({ hubDir: dir, webDir: web, token: "tok-123" });
	const sessions = async () => (await (await fetch(`${server.url}api/sessions`)).json() as { sessions: Array<{ chat: Array<{ role: "you" | "agent"; text: string; at: number }> }> }).sessions;
	try {
		const before = (await sessions())[0].chat;
		const outgoing: Outgoing = { ...sentMessage("tower question", T, before), state: "sent" };
		const accepted = await fetch(`${server.url}api/action`, { method: "POST", headers: { Origin: `http://127.0.0.1:${server.port}`, "Content-Type": "application/json" }, body: JSON.stringify({ type: "message", sessionId: "sess-1", text: "tower question" }) });
		assert.equal(accepted.status, 202);
		await wait(100);
		assert.deepEqual(action.sent, [{ text: "tower question", opts: { deliverAs: "followUp" } }]);
		await action.fire("turn_end", ctx); await wait(80);
		const echo = (await sessions())[0].chat;
		assert.deepEqual(echo.map((t) => t.text), ["terminal question", "previous reply", "tower question"]);
		const consumed = new Set<string>();
		assert.deepEqual(settleOutbox([outgoing], echo, consumed).keep, []);
		for (let i = 0; i < TOWER_CHAT_TURNS; i++) branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `working ${i}` }, { type: "toolCall", id: `t${i}`, name: "read", arguments: {} }], timestamp: T + 20 + i } });
		branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "final answer" }], timestamp: T + 200 } });
		await action.fire("turn_end", ctx); await wait(80);
		const chat = (await sessions())[0].chat;
		assert.equal(chat.length, TOWER_CHAT_TURNS);
		assert.deepEqual(chat[0], { role: "you", text: "tower question", at: T + 10 });
		assert.deepEqual(chat.at(-1), { role: "agent", text: "final answer", at: T + 200 });
		assert.deepEqual(settleOutbox([], chat, consumed).show, []);
	} finally {
		await action.fire("session_shutdown", ctx);
		await server.close();
	}
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

test("a failing action is reported and the rest of the batch still runs", async () => {
	const dir = hub();
	const action = actionPi("normal", async () => { throw new Error("agent host gone"); });
	createTowerPublisher(action.pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, reviewCli: async () => "{}" });
	const ctx = busyCtx(true);
	await action.fire("session_start", ctx);
	await wait(150);
	writeTowerAction(dir, { type: "cancel-helper", sessionId: "sess-1", helperId: "t1" });
	writeTowerAction(dir, { type: "message", sessionId: "sess-1", text: "still here?" });
	await wait(150);
	assert.deepEqual(action.sent.map((m) => m.text), ["still here?"]);
	const notice = readTowerSnapshots(dir)[0].notice;
	assert.equal(notice?.ok, false);
	assert.match(notice?.text ?? "", /Could not stop the helper: agent host gone/);
	// The message itself shows in the conversation; only the failure is a notice.
	assert.equal(notice?.text, "Could not stop the helper: agent host gone");
	await action.fire("session_shutdown", ctx);
});

test("an action that never answers times out, so the inbox keeps working", async () => {
	const dir = hub();
	const action = actionPi("normal", () => new Promise(() => {}));
	createTowerPublisher(action.pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, actionTimeoutMs: 60, reviewCli: async () => "{}" });
	const ctx = busyCtx(true);
	await action.fire("session_start", ctx);
	await wait(150);
	writeTowerAction(dir, { type: "cancel-helper", sessionId: "sess-1", helperId: "t1" });
	await wait(200);
	writeTowerAction(dir, { type: "message", sessionId: "sess-1", text: "after the hang" });
	await wait(150);
	assert.deepEqual(action.sent.map((m) => m.text), ["after the hang"]);
	await action.fire("session_shutdown", ctx);
});

const confirmCtx = (confirm?: (title: string, message: string) => Promise<boolean>) => ({ ...fakeCtx([assistant(0.1)]), isIdle: () => true, hasUI: confirm !== undefined, ui: confirm ? { confirm, notify() {} } : undefined }) as unknown as ExtensionContext;

async function doorCase(start: string, mode: "normal" | "auto" | "yolo" | "super-yolo", ctx: ExtensionContext) {
	const dir = hub();
	const action = actionPi(start);
	createTowerPublisher(action.pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, reviewCli: async () => "{}" });
	await action.fire("session_start", ctx);
	await wait(150);
	assert.equal(readTowerSnapshots(dir)[0].permission, start);
	writeTowerAction(dir, { type: "permission", sessionId: "sess-1", mode });
	await wait(150);
	const s = readTowerSnapshots(dir)[0];
	await action.fire("session_shutdown", ctx);
	return { ...action, s };
}

test("the door lowers permissions from the web at once, without asking", async () => {
	const asked: string[] = [];
	const { modes, current, s } = await doorCase("yolo", "normal", confirmCtx(async (t) => { asked.push(t); return true; }));
	assert.deepEqual(asked, []);
	assert.deepEqual(modes, ["normal"]);
	assert.equal(current(), "normal");
	assert.equal(s.permission, "normal");
	assert.equal(s.notice?.ok, true);
});

test("raising permissions from the web applies only after the terminal approves", async () => {
	const asked: Array<[string, string]> = [];
	const { modes, current, s } = await doorCase("normal", "yolo", confirmCtx(async (t, m) => { asked.push([t, m]); return true; }));
	assert.equal(asked.length, 1);
	assert.equal(asked[0][0], "Gentle Tower");
	assert.match(asked[0][1], /from normal to yolo/);
	assert.deepEqual(modes, ["yolo"]);
	assert.equal(current(), "yolo");
	assert.equal(s.permission, "yolo");
	assert.deepEqual([s.notice?.ok, s.notice?.text], [true, "Permissions: yolo (approved in the terminal)"]);
});

test("a raise declined in the terminal changes nothing", async () => {
	for (const answer of [async () => false, async () => undefined as unknown as boolean, async () => { throw new Error("closed"); }]) {
		const { modes, current, s } = await doorCase("normal", "super-yolo", confirmCtx(answer));
		assert.deepEqual(modes, []);
		assert.equal(current(), "normal");
		assert.equal(s.permission, "normal");
		assert.deepEqual([s.notice?.ok, s.notice?.text], [false, "Raising permissions to super-yolo was declined in the terminal"]);
	}
});

test("a raise is refused when the session cannot ask in its terminal", async () => {
	for (const ctx of [busyCtx(true), confirmCtx(), ({ ...fakeCtx([assistant(0.1)]), hasUI: false, ui: { confirm: async () => true } }) as unknown as ExtensionContext]) {
		const { modes, current, s } = await doorCase("auto", "yolo", ctx);
		assert.deepEqual(modes, []);
		assert.equal(current(), "auto");
		assert.equal(s.permission, "auto");
		assert.deepEqual([s.notice?.ok, s.notice?.text], [false, "Raising permissions to yolo needs the terminal: this session cannot ask"]);
	}
});

test("permissions fail closed: when the current mode cannot be read, neither a raise nor a lower is applied", async () => {
	const hang = () => new Promise<never>(() => {});
	const reject = async () => { throw new Error("yolo host gone"); };
	for (const broken of [reject, hang]) {
		for (const mode of ["super-yolo", "normal"] as const) {
			const dir = hub();
			let readable = true;
			const asked: string[] = [];
			const action = actionPi("yolo", undefined, { readSnapshot: (current) => (readable ? Promise.resolve({ yolo: "OFF", mode: current, defaultMode: "normal" }) : broken()) });
			createTowerPublisher(action.pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, actionTimeoutMs: 60, reviewCli: async () => "{}" });
			const ctx = confirmCtx(async (t) => { asked.push(t); return true; });
			await action.fire("session_start", ctx);
			await wait(150);
			assert.equal(readTowerSnapshots(dir)[0].permission, "yolo");
			readable = false;
			writeTowerAction(dir, { type: "permission", sessionId: "sess-1", mode });
			await wait(250);
			const s = readTowerSnapshots(dir)[0];
			assert.deepEqual(asked, [], `${mode}: never asks the terminal`);
			assert.deepEqual(action.modes, [], `${mode}: never calls setMode`);
			assert.equal(action.current(), "yolo");
			assert.deepEqual([s.notice?.ok, s.notice?.text], [false, "Permissions unchanged: could not read the current mode"]);
			assert.equal(s.permission, undefined, "an unknown mode is not shown as the old one");
			await action.fire("session_shutdown", ctx);
		}
	}
});

test("a permission change that times out is followed until it settles and reports the real result", async () => {
	const dir = hub();
	const action = actionPi("yolo", undefined, { setMode: (_m, commit) => new Promise((done) => setTimeout(() => { commit(); done(true); }, 250)) });
	createTowerPublisher(action.pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, actionTimeoutMs: 60, reviewCli: async () => "{}" });
	const ctx = confirmCtx(async () => true);
	await action.fire("session_start", ctx);
	await wait(150);
	writeTowerAction(dir, { type: "permission", sessionId: "sess-1", mode: "normal" });
	await wait(150);
	let s = readTowerSnapshots(dir)[0];
	assert.deepEqual([s.notice?.ok, s.notice?.text], [false, "Permissions: the change to normal is still pending; the session is in yolo"]);
	assert.equal(s.permission, "yolo");
	await wait(300);
	s = readTowerSnapshots(dir)[0];
	assert.equal(action.current(), "normal");
	assert.equal(s.permission, "normal");
	assert.deepEqual([s.notice?.ok, s.notice?.text], [true, "Permissions: normal"]);
	await action.fire("session_shutdown", ctx);
});

test("a permission change still applies normally when it answers in time", async () => {
	const { modes, s } = await doorCase("auto", "normal", confirmCtx(async () => true));
	assert.deepEqual(modes, ["normal"]);
	assert.deepEqual([s.permission, s.notice?.ok, s.notice?.text], ["normal", true, "Permissions: normal"]);
});

test("closing the session that opened the tower closes its server", async () => {
	const dir = hub();
	const web = join(dir, "..", "web");
	(await import("node:fs")).mkdirSync(web, { recursive: true });
	(await import("node:fs")).writeFileSync(join(web, "index.html"), "<title>Gentle Tower</title>");
	const { pi, commands, fire } = commandPi();
	const opened: string[] = [];
	const tower = createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, webDir: web, openUrl: (u) => opened.push(u) });
	const ctx = fakeCtx([assistant(0.1)]);
	await fire("session_start", ctx);
	await commands.get("gentle:tower")!.handler("", uiCtx([]));
	assert.equal((await fetch(opened[0])).status, 200);
	await fire("session_shutdown", ctx);
	await wait(50);
	await assert.rejects(fetch(opened[0]), "the listener is gone");
	await tower?.close();
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

test("the floor carries the conversation: your messages and the agent's visible replies, in order", async () => {
	const dir = hub();
	const { pi, fire } = fakePi();
	const branch = [
		{ type: "message", message: { role: "user", content: "what did you do?", timestamp: 10 } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "read", arguments: {} }, { type: "text", text: "Fixed the token refresh." }], timestamp: 20, usage: { input: 1, output: 1, cost: { total: 0 } } } },
		{ type: "message", message: { role: "custom", customType: "gentle-todo-reminder", content: "injected", display: false, timestamp: 25 } },
	];
	createTowerPublisher(pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, reviewCli: async () => "{}" });
	const ctx = fakeCtx(branch);
	await fire("session_start", ctx);
	await wait(180);
	const s = readTowerSnapshots(dir)[0];
	assert.deepEqual(s.chat, [{ role: "you", text: "what did you do?", at: 10 }, { role: "agent", text: "Fixed the token refresh.", at: 20 }]);
	assert.equal(s.said, "Fixed the token refresh.");
	await fire("session_shutdown", ctx);
});

test("only live helpers are on the floor; finished ones leave the building", async () => {
	const dir = hub();
	const base = fakePi();
	const events = (base.pi as unknown as { events: { on(n: string, fn: (d: unknown) => void): () => void } }).events;
	const entry = (id: string, status: string) => ({ id, agent: "gentle-ai-explore", status, model: "m", lastStep: "reading", usage: { total: 1, cost: 0 } });
	events.on("gentle:desktop:agents-service", (req) => (req as { respond(a: unknown): void }).respond({
		schema: DESKTOP_AGENTS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "sess-1", agents: [entry("q", "queued"), entry("r", "running"), entry("w", "waiting"), entry("c", "completed"), entry("f", "failed"), entry("x", "cancelled"), entry("t", "timed_out")] }),
		observe: () => () => {}, cancel: async () => true, dispose() {},
	}));
	createTowerPublisher(base.pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, reviewCli: async () => "{}" });
	const ctx = fakeCtx([assistant(0.1)]);
	await base.fire("session_start", ctx);
	await wait(180);
	assert.deepEqual(readTowerSnapshots(dir)[0].subagents.map((a) => a.id), ["q", "r", "w"]);
	await base.fire("session_shutdown", ctx);
});

test("a raise is decided on the action's own read, even when an earlier late write lands in between", async () => {
	const dir = hub();
	const base = fakePi();
	const confirms: string[] = [];
	const modes: string[] = [];
	let current = "normal";
	let releaseSlow: () => void = () => {};
	let slowSettled = false;
	/** While set, reads take the mode at call time and wait here; released together, they finish in call order, step by step. */
	let gate: { open: () => void; wait: Promise<void>; reads: number } | undefined;
	const events = (base.pi as unknown as { events: { on(n: string, fn: (d: unknown) => void): () => void } }).events;
	(base.pi as unknown as { sendUserMessage: unknown }).sendUserMessage = () => {};
	events.on("gentle:yolo:host-ui", (req) => (req as { respond(a: unknown): void }).respond({
		read: async () => "OFF", toggle: async () => {}, observe: () => () => {}, dispose() {},
		readSnapshot: async () => {
			const mode = current;
			if (gate) {
				gate.reads++;
				// The second action's own read: the earlier write now lands, and its follow-up re-reads.
				if (gate.reads === 1) releaseSlow();
				// That follow-up read: release both, so its result lands right after the action's own.
				else setTimeout(gate.open, 0);
				await gate.wait;
			}
			return { yolo: "OFF", mode, defaultMode: "normal" };
		},
		setMode: (m: string) => {
			modes.push(m);
			// The first write (to super-yolo) hangs past the timeout, then lands late.
			if (modes.length === 1) return new Promise<boolean>((r) => { releaseSlow = () => { current = m; slowSettled = true; r(true); }; });
			current = m; return Promise.resolve(true);
		},
	}));
	createTowerPublisher(base.pi, { env: { GENTLE_TOWER_HOME: dir }, debounceMs: 0, inboxMs: 20, actionTimeoutMs: 50, reviewCli: async () => "{}" });
	// The first raise is approved in the terminal; the second is declined.
	const ctx = { ...fakeCtx([assistant(0.1)]), hasUI: true, isIdle: () => true, ui: { notify() {}, confirm: async (_t: string, m: string) => { confirms.push(m); return confirms.length === 1; } } } as unknown as ExtensionContext;
	await base.fire("session_start", ctx);
	await wait(150);
	writeTowerAction(dir, { type: "permission", sessionId: "sess-1", mode: "super-yolo" });
	await wait(300);
	assert.deepEqual(modes, ["super-yolo"], "the approved write started");
	assert.match(readTowerSnapshots(dir)[0].notice?.text ?? "", /change to super-yolo is still pending; the session is in normal/);
	// The second action reads "normal". Between that read and its decision, the late write lands and
	// its follow-up read publishes "super-yolo": a decision on the shared value would see a lowering.
	let release = () => {};
	gate = { open: () => { gate = undefined; release(); }, wait: new Promise<void>((r) => { release = r; }), reads: 0 };
	writeTowerAction(dir, { type: "permission", sessionId: "sess-1", mode: "yolo" });
	await wait(300);
	assert.equal(slowSettled, true, "the earlier write settled");
	assert.equal(confirms.length, 2, "the second action was treated as a raise and asked in the terminal");
	assert.match(confirms[1], /from normal to yolo/);
	assert.ok(!modes.includes("yolo"), "the declined raise never applied");
	assert.equal(readTowerSnapshots(dir)[0].permission, "super-yolo", "the late write landed and was published");
	await base.fire("session_shutdown", ctx);
});
