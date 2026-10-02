import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import gentleShell from "../extensions/gentle-shell.ts";
import * as yolo from "../lib/yolo-session-policy.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { VisualCustomizeView } from "../lib/visual-customize-view.ts";

initTheme("dark");
const theme = getThemeByName("dark")!;
interface View { render(width: number): string[]; handleInput(data: string): void; invalidate(): void; dispose?(): void }

function fixture(t: test.TestContext, order = "owner-first", env: NodeJS.ProcessEnv = {}, observeActionReady = false) {
	const home = mkdtempSync(join(tmpdir(), "yolo-customize-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const events = createEventBus();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const statuses = new Map<string, unknown>();
	const widgets = new Map<string, unknown>();
	const notices: string[] = [];
	let renders = 0, sessionId = "menu-session";
	let view: View | undefined, finish: (() => void) | undefined;
	let component: VisualCustomizeView | undefined, actionReady: (() => void) | undefined;
	if (observeActionReady) {
		const handleInput = VisualCustomizeView.prototype.handleInput;
		t.mock.method(VisualCustomizeView.prototype, "handleInput", function(this: VisualCustomizeView, data: string) {
			component = this;
			handleInput.call(this, data);
		});
	}
	const requestRender = () => {
		renders++;
		// The real view's action finally clears busy BEFORE requesting this
		// render. Inspect that latch read-only; never clear it or infer readiness
		// from a label updated by an earlier observer/refresh render.
		const busy: unknown = component && Reflect.get(component, "busy");
		if (actionReady && busy === false) { view?.render(140); actionReady(); }
	};
	let ready!: () => void;
	let opened = new Promise<void>(resolve => { ready = resolve; });
	const pi = {
		events, on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
		registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) { commands.set(name, command); },
		registerShortcut() {}, registerTool() {}, registerMessageRenderer() {},
		sendUserMessage() { assert.fail("menu must not send synthetic user messages"); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(), mode: "tui", hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			theme, getAllThemes: () => [{ name: "dark" }], getTheme: () => theme, getEditorComponent: () => undefined,
			notify: (text: string) => notices.push(text),
			setStatus: (key: string, value: unknown) => statuses.set(key, value),
			setWidget: (key: string, value: unknown) => widgets.set(key, value),
			custom(factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => View) {
				return new Promise<void>(resolve => {
					finish = resolve;
					view = factory({ requestRender, terminal: { rows: 30 } }, theme, {}, resolve);
					ready();
				});
			},
		},
	} as unknown as ExtensionContext;
	let controller: yolo.YoloSessionController | undefined;
	const owner = () => { controller = yolo.registerYoloSessionPolicy(pi, env); };
	const shell = () => gentleShell(pi, { ...env, GENTLE_PI_CONFIG_HOME: home, GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, {
		fetch: async () => { assert.fail("network disabled"); }, activeProfile: () => undefined, devBinary: () => undefined,
	});
	if (order === "owner-first") { owner(); shell(); }
	else { shell(); if (order !== "absent") owner(); }
	const snapshot = () => Object.fromEntries(readdirSync(home).sort().map(name => [name, readFileSync(join(home, name), "utf8")]));
	return {
		pi, ctx, home, events, notices, statuses, widgets, snapshot, controller: () => controller!, renders: () => renders,
		setSessionId: (id: string) => { sessionId = id; }, view: () => { assert.ok(view); return view; },
		async command(args: string) { await commands.get("gentle:yolo")!.handler(args, ctx); },
		async apply(data: string) {
			assert.ok(observeActionReady && view, "action-ready observation is enabled");
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await new Promise<void>((resolve, reject) => {
					actionReady = resolve;
					timeout = setTimeout(() => reject(new Error("real customize action never became ready")), 5_000);
					view!.handleInput(data);
				});
			} finally { clearTimeout(timeout); actionReady = undefined; }
		},
		async open() {
			opened = new Promise<void>(resolve => { ready = resolve; });
			const result = commands.get("gentle:customize")!.handler("", ctx);
			await opened;
			return { result, close: () => { view?.handleInput("\x1b"); finish?.(); } };
		},
		async shutdown() { for (const fn of handlers.get("session_shutdown") ?? []) await fn({}, ctx); },
	};
}
function selectYolo(view: View) {
	for (let i = 0; i < 3; i++) view.handleInput("j");
	view.handleInput("\x1b[C");
	view.handleInput("j"); view.handleInput("j");
	view.render(140);
}
async function settle(check: () => boolean) {
	for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
	assert.ok(check(), "state settles within the bounded test window");
}
function text(view: View) { return view.render(140).map(stripAnsi).join("\n"); }

for (const order of ["owner-first", "shell-first"]) test(`Editor YOLO menu and slash share one owner (${order})`, async t => {
	const h = fixture(t, order, {}, true);
	for (const name of ["vim-policy.json", "visual-settings.json", "visual-profiles.json", "runtime-guardrails.json", "history-capture-policy.json", "agent-profiles.json"]) writeFileSync(join(h.home, name), "{}\n");
	const before = h.snapshot();
	const open = await h.open(); const view = h.view(); selectYolo(view);
	const initial = text(view);
	assert.match(initial, /Vim: disable[\s\S]*YOLO: OFF · session only/);
	assert.match(initial, /ordinary scoped commits\/push\/PR/);
	assert.match(initial, /destructive confirmations remain/);
	assert.match(initial, /review consent unchanged/);
	assert.match(initial, /reset on reload/);
	assert.equal(await h.controller().active(h.ctx), false, "render/preview/navigation never grant");
	await h.apply("\r");
	assert.match(text(view), /YOLO: ON · session only/);
	assert.equal(h.statuses.get(yolo.YOLO_STATUS_KEY), yolo.YOLO_STATUS_TEXT);
	await h.command("disable"); await settle(() => /YOLO: OFF/.test(text(view)));
	assert.equal(h.widgets.get(yolo.YOLO_STATUS_KEY), undefined);
	await h.command("enable"); await settle(() => /YOLO: ON/.test(text(view)));
	await h.apply(" "); assert.match(text(view), /YOLO: OFF/);
	assert.equal(await h.controller().active(h.ctx), false);
	assert.deepEqual(h.snapshot(), before, "YOLO never writes configuration or profile snapshots");
	open.close(); await open.result;
	assert.equal(await h.controller().active(h.ctx), false, "Escape never grants");
});

for (const invalid of [false, true]) test(`absent/invalid owner is unavailable, bounded and cannot activate (invalid: ${invalid})`, async t => {
	const h = fixture(t, "absent");
	if (invalid) h.events.on("gentle:yolo:host-ui", data => {
		const request = data as { respond(value: unknown): void };
		request.respond({ enabled: true });
	});
	const open = await h.open(); selectYolo(h.view());
	assert.match(text(h.view()), /YOLO: UNAVAILABLE · session only/);
	h.view().handleInput("\r"); await settle(() => h.notices.some(n => /YOLO.*unavailable/i.test(n)));
	assert.equal(h.statuses.get(yolo.YOLO_STATUS_KEY), undefined);
	open.close(); await open.result;
});

test("scope revocation refreshes without notification recursion or Git during render", async t => {
	const h = fixture(t); await h.command("enable");
	const open = await h.open(); const view = h.view(); selectYolo(view);
	assert.match(text(view), /YOLO: ON/);
	const count = h.renders();
	for (let i = 0; i < 20; i++) view.render(70);
	assert.equal(h.renders(), count, "render only reads the display snapshot");
	h.setSessionId("replacement"); await h.controller().active(h.ctx);
	await settle(() => /YOLO: UNAVAILABLE/.test(text(view)));
	const settled = h.renders(); await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(h.renders(), settled, "read/publish/observe settles rather than looping");
	view.handleInput("\r"); assert.equal(await h.controller().active(h.ctx), false);
	open.close(); await open.result;
});

test("closed/replaced/reloaded menus cancel pending action and suppress late renders", async t => {
	for (const reason of ["close", "replace", "reset", "shutdown"]) {
		const h = fixture(t); const open = await h.open(); const old = h.view(); selectYolo(old);
		old.handleInput("\r");
		if (reason === "reset") h.controller().reset(h.ctx);
		if (reason === "shutdown") await h.shutdown();
		if (reason === "replace") { const replacement = await h.open(); replacement.close(); await replacement.result; }
		open.close(); await open.result;
		const count = h.renders();
		await new Promise(resolve => setTimeout(resolve, 50));
		old.handleInput(" "); old.invalidate(); old.render(140);
		assert.equal(await h.controller().active(h.ctx), false, reason);
		assert.equal(h.renders(), count, `${reason}: obsolete callbacks cannot repaint`);
	}
});

test("off wins over pending menu on; child/headless/RPC cannot acquire adapter authority", async t => {
	const h = fixture(t); const open = await h.open(); selectYolo(h.view());
	h.view().handleInput("\r"); await h.command("disable");
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(await h.controller().active(h.ctx), false);
	open.close(); await open.result;
	assert.equal(typeof yolo.discoverYoloUiAdapter, "function");
	for (const variant of ["child", "headless", "rpc", "missing-clone"]) {
		const f = fixture(t, "owner-first", variant === "child" ? { GENTLE_PI_AGENTS_CHILD: "1" } : {});
		if (variant === "headless") Object.assign(f.ctx, { hasUI: false });
		if (variant === "rpc") Object.assign(f.ctx, { mode: "rpc" });
		if (variant === "missing-clone") Object.assign(f.ctx, { cwd: "/" });
		const adapter = await yolo.discoverYoloUiAdapter(f.pi, f.ctx);
		if (adapter) { assert.equal(await adapter.read(), "UNAVAILABLE"); await adapter.toggle(); adapter.dispose(); }
		assert.equal(await f.controller().active(f.ctx), false, variant);
	}
});

test("closing a completed activation keeps permission but removes menu observers and actions", async t => {
	const h = fixture(t); const open = await h.open(); const view = h.view(); selectYolo(view);
	view.handleInput("\r"); await settle(() => /YOLO: ON/.test(text(view)));
	open.close(); await open.result;
	const renders = h.renders();
	assert.equal(await h.controller().active(h.ctx), true);
	await h.command("disable"); await new Promise(resolve => setTimeout(resolve, 30));
	view.handleInput("\r"); assert.deepEqual(view.render(140), []);
	assert.equal(h.renders(), renders);
	assert.equal(await h.controller().active(h.ctx), false);
});

test("adapter callbacks fail closed after reset, disposal and context invalidation", async t => {
	for (const reason of ["reset", "dispose", "session", "runtime"]) {
		const h = fixture(t);
		const adapter = await yolo.discoverYoloUiAdapter(h.pi, h.ctx); assert.ok(adapter);
		assert.equal(await adapter.read(), "OFF");
		let changes = 0;
		const unobserve = adapter.observe(() => { changes++; });
		await h.command("enable"); assert.equal(await adapter.read(), "ON");
		const observed = changes;
		for (let i = 0; i < 3; i++) await adapter.read();
		assert.equal(changes, observed, "unchanged reads never notify");
		if (reason === "reset") h.controller().reset(h.ctx);
		if (reason === "dispose") { adapter.dispose(); await h.command("disable"); }
		if (reason === "session") h.setSessionId("new-session");
		if (reason === "runtime") Object.defineProperty(h.ctx, "sessionManager", { get() { throw new Error("inactive SDK context"); } });
		assert.equal(await adapter.read(), "UNAVAILABLE");
		const count = h.notices.length;
		await adapter.toggle(); assert.equal(h.notices.length, count, "old adapter cannot act or notify");
		unobserve(); adapter.dispose();
	}
});

test("late discovery callback is disposed rather than reviving a timed-out interaction", async t => {
	const h = fixture(t, "absent");
	let respond!: (value: unknown) => void;
	h.events.on("gentle:yolo:host-ui", data => { respond = (data as { respond(value: unknown): void }).respond; });
	assert.equal(await yolo.discoverYoloUiAdapter(h.pi, h.ctx), undefined);
	let disposed = 0;
	respond({ read: async () => "ON", toggle: async () => assert.fail("late callback must not act"), observe: () => () => {}, dispose: () => { disposed++; } });
	assert.equal(disposed, 1);
});

test("real Theme and existing component obey narrow dimensions with invisible controls inert", async t => {
	const h = fixture(t); const open = await h.open(); const view = h.view(); selectYolo(view);
	assert.match(text(view), /YOLO: OFF/);
	assert.ok(view.render(140).some(line => /\x1b\[/.test(line)), "real Theme emits styling");
	for (const width of [0, 1, 3, 6, 20, 45, 59, 60, 90]) {
		const lines = view.render(width);
		assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
	}
	view.render(1); view.handleInput("\r"); await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(await h.controller().active(h.ctx), false);
	open.close(); await open.result;
});
