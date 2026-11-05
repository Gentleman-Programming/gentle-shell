import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";
import gentleShell from "../extensions/gentle-shell.ts";
import type { NativeReviewCli, NativeReviewModeRequest, NativeReviewModeResult } from "../lib/native-review-cli.ts";

const OPTIONS = ["Enable RDD for this repository", "Disable RDD for this repository", "Enable RDD machine-wide", "Disable RDD machine-wide"];
type View = { focus(label: string): boolean; render(width: number): string[]; handleInput(data: string): void; handleMouse(event: TuiMouseEvent): unknown; invalidate(): void };
type Mode = "" | "on" | "off";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

function fixture(t: TestContext, options: { owner?: boolean; child?: boolean; provider?: boolean; global?: Mode; badBridge?: boolean; throwingBridge?: boolean; invalidStatusBridge?: boolean } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "rdd-customize-")));
	const cwd = join(root, "workspace"), home = join(root, "home"), config = join(root, "config");
	mkdirSync(cwd); mkdirSync(home); mkdirSync(config);
	const env = { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "xdg"), PI_CODING_AGENT_DIR: home,
		GENTLE_PI_AGENT_HOME: home, GENTLE_PI_CONFIG_HOME: config, GENTLE_AI_TELEMETRY: "0",
		GENTLE_PI_AGENTS_CHILD: options.child ? "1" : "0", GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" };
	const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	__testing.clearRddStatusMemoForTesting();
	t.after(() => {
		__testing.clearRddStatusMemoForTesting();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	let global: Mode = options.global ?? "", clone: Mode = "";
	const calls: Array<{ operation: string; cwd: string; scope?: string }> = [];
	const writes: Array<{ operation: string; cwd: string; scope?: string }> = [];
	let statusFailure = false;
	let heldStatus: { started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
	const native = {
		async reviewMode(request: NativeReviewModeRequest) {
			const call = { operation: request.operation, cwd: request.cwd, ...(request.scope ? { scope: request.scope } : {}) };
			calls.push(call);
			if (request.operation === "status" && heldStatus) {
				const held = heldStatus; heldStatus = undefined; held.started.resolve(); await held.release.promise;
			}
			if (request.operation === "status" && statusFailure) throw new Error("fixture unavailable");
			if (request.operation !== "status") {
				if (request.scope === "global") global = request.operation === "enable" ? "on" : "off";
				else clone = request.operation === "disable" ? "off" : "";
				writes.push(call);
			}
			const source = clone === "off" ? "clone_local" : global ? "global" : "default";
			const status = { global, cloneLocal: clone, effective: clone === "off" ? "off" : global || "on", source };
			return { operation: request.operation, scope: request.scope ?? "clone", status } as NativeReviewModeResult;
		},
	} as unknown as NativeReviewCli;
	const events = createEventBus();
	const ownerHandlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const shellHandlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const notices: Array<{ message: string; type?: string }> = [];
	const prompts: Array<{ title: string; options: string[] }> = [];
	const themeChanges: string[] = [];
	const theme = { name: "dark", fg: (_role: string, value: string) => value, bg: (_role: string, value: string) => value };
	let sessionId = "fixture-session", managerCwd = cwd, view: View | undefined, finish: (() => void) | undefined;
	let select: (title: string, options: string[]) => Promise<string | undefined> = async () => undefined;
	let opened = deferred<void>(), renders = 0, discovery = 0, cardClosed = true;
	const manager = { getSessionId: () => sessionId, getCwd: () => managerCwd, getEntries: () => [], getBranch: () => [] };
	const ui = new Proxy({
		theme,
		getAllThemes: () => [{ name: "dark" }, { name: "light" }],
		getTheme: (name: string) => ({ ...theme, name }),
		setTheme: (name: string) => { themeChanges.push(name); return { success: true }; },
		notify: (message: string, type?: string) => notices.push({ message, type }),
		select: async (title: string, choices: string[]) => {
			assert.equal(cardClosed, true, "owner selector must not be hidden by the Customize overlay");
			prompts.push({ title, options: choices });
			return select(title, choices);
		},
		custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => View) => new Promise<void>(resolve => {
			cardClosed = false;
			finish = () => { cardClosed = true; resolve(); };
			view = factory({ requestRender: () => { renders++; }, terminal: { rows: 30 } }, theme, {}, finish);
			opened.resolve();
		}),
	}, { get(target, key) { return key in target ? Reflect.get(target, key) : () => undefined; } });
	const ctx = { cwd, mode: "tui", hasUI: true, sessionManager: manager, ui } as unknown as ExtensionContext;
	const makePi = (handlers: typeof ownerHandlers) => ({
		events, on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) { commands.set(name, command); },
		registerTool() {}, registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {},
		getActiveTools: () => [], getThinkingLevel: () => "off", getCommands: () => [],
		sendUserMessage() { assert.fail("Customize must not synthesize a command"); },
	}) as unknown as ExtensionAPI;
	events.on("gentle:rdd:host-ui", () => { discovery++; });
	if (options.badBridge) events.on("gentle:rdd:host-ui", payload => (payload as { respond(value: unknown): void }).respond({ read: "invalid" }));
	if (options.throwingBridge) events.on("gentle:rdd:host-ui", payload => (payload as { respond(value: unknown): void }).respond({
		read() { throw new Error("bridge unavailable"); }, open() { assert.fail("a failed bridge cannot open"); },
	}));
	if (options.invalidStatusBridge) events.on("gentle:rdd:host-ui", payload => (payload as { respond(value: unknown): void }).respond({
		async read() { return { effective: "on", source: "invalid" }; }, open() { assert.fail("an invalid status cannot open"); },
	}));
	if (options.owner !== false) createGentleAiExtension({ nativeReviewCli: options.provider === false ? null : native, candidateViews: null,
		processEnv: env, resolveTelemetryTriggerBinary: () => { throw new Error("disabled"); } })(makePi(ownerHandlers));
	gentleShell(makePi(shellHandlers), env, { fetch: async () => { throw new Error("network disabled"); }, activeProfile: () => undefined, devBinary: () => undefined });
	const emit = async (handlers: typeof ownerHandlers, name: string) => { for (const fn of handlers.get(name) ?? []) await fn({ type: name, reason: "startup" }, ctx); };
	const text = () => { assert.ok(view); return view.render(140).join("\n"); };
	return {
		ctx, calls, writes, notices, prompts, themeChanges, text,
		state: () => ({ global, clone }), renders: () => renders, discovery: () => discovery,
		hasCommand: (name: string) => commands.has(name),
		setId: (id: string) => { sessionId = id; }, setManagerCwd: (value: string) => { managerCwd = value; },
		setSelect: (fn: typeof select) => { select = fn; }, failStatus: () => { statusFailure = true; },
		holdStatus() { heldStatus = { started: deferred<void>(), release: deferred<void>() }; return heldStatus; },
		async start() { await emit(ownerHandlers, "session_start"); notices.length = 0; calls.length = 0; },
		async shutdown() { await emit(ownerHandlers, "session_shutdown"); await emit(shellHandlers, "session_shutdown"); },
		async command(name: string, args = "") { const command = commands.get(name); assert.ok(command, `/${name} is registered`); await command.handler(args, ctx); },
		async open() {
			opened = deferred<void>();
			const command = commands.get("gentle:customize"); assert.ok(command, "/gentle:customize is registered");
			const result = command.handler("", ctx);
			await Promise.race([opened.promise, result.then(() => { throw new Error("Customize did not open"); })]);
			assert.ok(view);
			return { view, result, close: () => { view?.handleInput("\x1b"); finish?.(); } };
		},
	};
}

async function until(check: () => boolean) {
	for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
	assert.ok(check(), "expected visible result within one second");
}
async function focusRdd(h: ReturnType<typeof fixture>, view: View, expected: RegExp) {
	await until(() => { view.focus("RDD:"); return expected.test(h.text()); });
	assert.ok(view.focus("RDD:"));
	view.render(140);
}

test("opening, highlighting, navigation, rendering and Escape show truthful status without opening or changing RDD", async t => {
	const h = fixture(t); await h.start();
	const card = await h.open();
	await focusRdd(h, card.view, /RDD: on \(decided by default\)/);
	const before = h.state();
	for (const width of [20, 60, 80, 140]) assert.ok(card.view.render(width).every(line => visibleWidth(line) <= width));
	card.view.render(140); card.view.handleInput("\x1b[B"); card.view.handleInput("\x1b[A");
	card.view.invalidate(); h.text();
	assert.deepEqual(h.prompts, []); assert.deepEqual(h.writes, []); assert.deepEqual(h.state(), before);
	card.close(); await card.result;
	assert.deepEqual(h.prompts, []); assert.deepEqual(h.writes, []); assert.deepEqual(h.state(), before);
});

test("explicit application hands off to the owner selector and reopening refreshes effective mode and source", async t => {
	const h = fixture(t); await h.start();
	const card = await h.open(); await focusRdd(h, card.view, /RDD: on \(decided by default\)/);
	h.setSelect(async () => OPTIONS[1]);
	card.view.handleInput("\r"); await card.result;
	assert.deepEqual(h.prompts, [{ title: "Receipt-driven development: on (decided by default)", options: OPTIONS }]);
	assert.deepEqual(h.writes, [{ cwd: h.ctx.cwd, operation: "disable" }]);
	assert.deepEqual(h.notices.at(-1), { message: "receipt-driven development: off (decided by clone_local)", type: "info" });
	const again = await h.open(); await focusRdd(h, again.view, /RDD: off \(decided by clone_local\)/);
	again.close(); await again.result;
	assert.equal(h.prompts.length, 1); assert.equal(h.writes.length, 1);
});

test("pointer hover and press are inert; a click hands off the explicitly named machine-wide choice", async t => {
	const h = fixture(t); await h.start(); const card = await h.open();
	await focusRdd(h, card.view, /RDD: on \(decided by default\)/);
	const frame = card.view.render(140), y = frame.findIndex(line => line.includes("RDD:"));
	assert.ok(y >= 0); const x = visibleWidth(frame[y]!.slice(0, frame[y]!.indexOf("RDD:")));
	const event = { x, y, screenX: x, screenY: y, width: 140, height: frame.length, shift: false, alt: false, ctrl: false };
	card.view.handleMouse({ ...event, type: "move", button: "none" });
	card.view.handleMouse({ ...event, type: "press", button: "left" });
	assert.deepEqual(h.prompts, []); assert.deepEqual(h.writes, []);
	h.setSelect(async () => OPTIONS[3]);
	card.view.handleMouse({ ...event, type: "click", button: "left" }); await card.result;
	assert.deepEqual(h.prompts, [{ title: "Receipt-driven development: on (decided by default)", options: OPTIONS }]);
	assert.deepEqual(h.writes, [{ cwd: h.ctx.cwd, operation: "disable", scope: "global" }]);
	assert.deepEqual(h.notices.at(-1), { message: "receipt-driven development: off (decided by global)", type: "info" });
});

test("owner cancellation after explicit application leaves mode and write count unchanged", async t => {
	const h = fixture(t, { global: "off" }); await h.start();
	const card = await h.open(); await focusRdd(h, card.view, /RDD: off \(decided by global\)/);
	const before = h.state(); card.view.handleInput(" "); await card.result;
	assert.deepEqual(h.prompts, [{ title: "Receipt-driven development: off (decided by global)", options: OPTIONS }]);
	assert.deepEqual(h.writes, []); assert.deepEqual(h.state(), before); assert.deepEqual(h.notices, []);
});

test("missing bridge, unavailable provider and failed reads show unavailable and cannot invoke the selector", async t => {
	for (const options of [{ owner: false }, { owner: false, badBridge: true }, { owner: false, throwingBridge: true }, { owner: false, invalidStatusBridge: true }, { provider: false }, { fail: true }]) await t.test(JSON.stringify(options), async st => {
		const h = fixture(st, options); await h.start(); if (options.fail) h.failStatus();
		const before = h.state(); const card = await h.open();
		await focusRdd(h, card.view, /RDD: unavailable/i);
		card.view.handleInput("\r");
		await until(() => h.notices.some(({ message }) => /RDD.*unavailable/i.test(message)));
		assert.deepEqual(h.prompts, []); assert.deepEqual(h.writes, []); assert.deepEqual(h.state(), before);
		card.close(); await card.result;
	});
});

test("headless and child contexts cannot acquire RDD authority", async t => {
	await t.test("headless", async st => {
		const h = fixture(st); await h.start(); Object.assign(h.ctx, { mode: "print", hasUI: false });
		const before = h.state(); await h.command("gentle:customize");
		assert.equal(h.discovery(), 0); assert.deepEqual(h.prompts, []); assert.deepEqual(h.writes, []); assert.deepEqual(h.state(), before);
	});
	await t.test("rpc", async st => {
		const h = fixture(st); await h.start(); Object.assign(h.ctx, { mode: "rpc" });
		const before = h.state(); await h.command("gentle:customize");
		assert.equal(h.discovery(), 0); assert.deepEqual(h.prompts, []); assert.deepEqual(h.writes, []); assert.deepEqual(h.state(), before);
		assert.deepEqual(h.notices, [{ message: "Customization requires an interactive terminal.", type: "warning" }]);
	});
	await t.test("child", async st => {
		const h = fixture(st, { child: true }); await h.start(); const before = h.state();
		assert.equal(h.hasCommand("gentle:customize"), false, "the shell is not registered in a child");
		assert.equal(h.discovery(), 0); assert.deepEqual(h.prompts, []); assert.deepEqual(h.writes, []); assert.deepEqual(h.state(), before);
	});
});

test("stale card session or workspace cannot dispatch the owner selector", async t => {
	for (const cause of ["session", "workspace", "manager-cwd"] as const) await t.test(cause, async st => {
		const h = fixture(st); await h.start(); const card = await h.open(); await focusRdd(h, card.view, /RDD: on/);
		const before = h.state(), calls = h.calls.length;
		if (cause === "session") h.setId("replacement");
		if (cause === "workspace") Object.assign(h.ctx, { cwd: `${h.ctx.cwd}-other` });
		if (cause === "manager-cwd") h.setManagerCwd(`${h.ctx.cwd}-other`);
		card.view.handleInput("\r"); await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepEqual(h.prompts, []); assert.deepEqual(h.writes, []); assert.deepEqual(h.state(), before); assert.equal(h.calls.length, calls);
		card.close(); await card.result;
	});
});

test("session, workspace and shutdown changes reject a stale owner selection", async t => {
	for (const cause of ["session", "workspace", "manager-cwd", "shutdown"] as const) await t.test(cause, async st => {
		const h = fixture(st); await h.start(); const card = await h.open(); await focusRdd(h, card.view, /RDD: on/);
		const answer = deferred<string | undefined>(), selecting = deferred<void>();
		h.setSelect(async () => { selecting.resolve(); return answer.promise; });
		const before = h.state(); card.view.handleInput("\r"); await selecting.promise;
		if (cause === "session") h.setId("replacement");
		if (cause === "workspace") Object.assign(h.ctx, { cwd: `${h.ctx.cwd}-other` });
		if (cause === "manager-cwd") h.setManagerCwd(`${h.ctx.cwd}-other`);
		if (cause === "shutdown") await h.shutdown();
		answer.resolve(OPTIONS[3]); await card.result;
		assert.equal(h.prompts.length, 1); assert.deepEqual(h.writes, []); assert.deepEqual(h.state(), before); assert.deepEqual(h.notices, []);
	});
});

test("a replacement Customize card cancels an obsolete queued selector handoff", async t => {
	const h = fixture(t); await h.start(); const first = await h.open(); await focusRdd(h, first.view, /RDD: on/);
	const before = h.state(); h.setSelect(async () => OPTIONS[3]);
	first.view.handleInput("\r");
	const replacing = h.open();
	await first.result;
	const second = await replacing; await focusRdd(h, second.view, /RDD: on/);
	assert.deepEqual(h.prompts, []); assert.deepEqual(h.writes, []); assert.deepEqual(h.state(), before);
	second.close(); await second.result;
});

test("closing a card during a pending status read cannot revive the selector or repaint", async t => {
	const h = fixture(t); await h.start(); const held = h.holdStatus();
	const card = await h.open(); await held.started.promise;
	await focusRdd(h, card.view, /RDD: checking/);
	card.close(); await card.result;
	const count = h.renders(), before = h.state();
	held.release.resolve(); card.view.handleInput("\r"); card.view.invalidate();
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.deepEqual(h.prompts, []); assert.deepEqual(h.writes, []); assert.deepEqual(h.state(), before); assert.equal(h.renders(), count);
});

test("existing Customize theme and live animation controls retain their application behavior", async t => {
	const h = fixture(t); await h.start(); const card = await h.open();
	assert.ok(card.view.focus("Theme: light")); card.view.render(140);
	assert.deepEqual(h.themeChanges, []); card.view.handleInput("\r");
	await until(() => h.themeChanges.length === 1);
	assert.deepEqual(h.themeChanges, ["light"]);
	await until(() => card.view.focus("Animations: quality")); card.view.render(140);
	card.view.handleInput("\x1b[C");
	await until(() => h.notices.some(({ message }) => message === "Animation saved. Prompt applies now; startup banner applies at next startup."));
	assert.deepEqual(h.writes, []); assert.deepEqual(h.prompts, []);
	card.close(); await card.result;
});
