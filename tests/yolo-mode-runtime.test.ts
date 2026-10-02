import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import gentleShell from "../extensions/gentle-shell.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { createEventBus, createExtensionRuntime, ExtensionRunner, SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { discoverYoloUiAdapter, registerYoloSessionPolicy, YOLO_STATUS_KEY, YOLO_STATUS_TEXT } from "../lib/yolo-session-policy.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

test("complete Gentle AI extension registers and executes YOLO through the actual SDK loader", async () => {
	const cwd = process.cwd();
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(createGentleAiExtension({ nativeReviewCli: null, candidateViews: null, processEnv: {} }), cwd, createEventBus(), runtime);
	assert.equal(extension.handlers.get("session_start")?.length, 1, "original startup hook remains the sole handler");
	assert.equal(extension.handlers.get("session_shutdown")?.length, 1, "original shutdown hook remains the sole handler");
	const runner = new ExtensionRunner([extension], runtime, cwd, SessionManager.inMemory(cwd), {} as never);
	const statuses = new Map<string, string | undefined>();
	runner.setUIContext({ notify() {}, setStatus: (key: string, text?: string) => statuses.set(key, text), setWidget() {}, getAllThemes: () => [{ name: "test" }] } as unknown as ExtensionUIContext, "tui");
	runner.bindCommandContext();
	assert.equal(runner.getAllRegisteredTools().some(({ definition }) => definition.name.includes("yolo")), false);
	assert.equal(runner.getCommand("yolo"), undefined, "bare yolo command is not registered");
	const command = runner.getCommand("gentle:yolo"); assert.ok(command);
	await command.handler("enable", runner.createCommandContext());
	assert.equal(statuses.get(YOLO_STATUS_KEY), YOLO_STATUS_TEXT);
	await command.handler("disable", runner.createCommandContext());
	assert.equal(statuses.get(YOLO_STATUS_KEY), undefined);
	await command.handler("enable", runner.createCommandContext());
	await runner.emit({ type: "session_shutdown", reason: "reload" });
	assert.equal(statuses.get(YOLO_STATUS_KEY), undefined, "production shutdown hook resets even on reload");
	await command.handler("status", runner.createCommandContext());
	assert.equal(statuses.get(YOLO_STATUS_KEY), undefined);
	runner.invalidate();
});

// Actual SDK factory loader, context/command runner and in-memory SessionManager.
// Lifecycle events are dispatched through the real runner; the terminal UI is stubbed.
// No providers, persisted sessions, global assets or real tool execution are needed.
test("SDK-loaded YOLO command resets across actual runner lifecycle dispatch and extension replacement", async () => {
	const cwd = process.cwd();
	const manager = SessionManager.inMemory(cwd);
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	const ui = {
		setStatus: (key: string, text?: string) => statuses.set(key, text),
		setWidget: (key: string, value: unknown) => widgets.set(key, value),
		notify() {}, getAllThemes: () => [{ name: "test" }],
	} as unknown as ExtensionUIContext;
	const load = async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory((pi) => {
			const yolo = registerYoloSessionPolicy(pi, {});
			// Match production ownership: the host's existing hooks reset the controller.
			pi.on("session_start", (_event, ctx) => yolo.reset(ctx));
			pi.on("session_shutdown", (_event, ctx) => yolo.reset(ctx));
		}, cwd, createEventBus(), runtime);
		const runner = new ExtensionRunner([extension], runtime, cwd, manager, {} as never);
		runner.setUIContext(ui, "tui");
		runner.bindCommandContext();
		return runner;
	};
	let runner = await load();
	const command = async (args: string) => {
		const registered = runner.getCommand("gentle:yolo"); assert.ok(registered);
		await registered.handler(args, runner.createCommandContext());
	};
	await runner.emit({ type: "session_start", reason: "startup" });
	await command("status"); assert.equal(statuses.get(YOLO_STATUS_KEY), undefined);
	for (const reason of ["reload", "new", "resume", "fork", "quit"] as const) {
		await command("enable"); assert.equal(statuses.get(YOLO_STATUS_KEY), YOLO_STATUS_TEXT);
		await runner.emit({ type: "session_shutdown", reason });
		assert.equal(statuses.get(YOLO_STATUS_KEY), undefined);
		assert.equal(widgets.get(YOLO_STATUS_KEY), undefined);
		runner.invalidate();
		runner = await load();
		if (reason !== "quit") await runner.emit({ type: "session_start", reason });
		await command("status"); assert.equal(statuses.get(YOLO_STATUS_KEY), undefined);
	}
	await command("enable");
	manager.newSession();
	await command("status"); assert.equal(statuses.get(YOLO_STATUS_KEY), undefined, "live SDK session ID replacement revokes without relying on an event");
	runner.setUIContext(ui, "rpc");
	await command("enable"); assert.equal(statuses.get(YOLO_STATUS_KEY), undefined);
});

for (const shellFirst of [false, true]) test(`SDK loads both extensions on one bus and drives real customize view (shell first: ${shellFirst})`, async t => {
	const home = mkdtempSync(join(tmpdir(), "yolo-sdk-menu-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const cwd = process.cwd(), runtime = createExtensionRuntime(), bus = createEventBus();
	const env = { GENTLE_PI_CONFIG_HOME: home, GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" };
	const ownerFactory = createGentleAiExtension({ nativeReviewCli: null, candidateViews: null, processEnv: env,
		resolveTelemetryTriggerBinary: () => { throw new Error("disabled in test"); },
	});
	const shellFactory = (pi: Parameters<typeof gentleShell>[0]) => gentleShell(pi, env, {
		fetch: async () => { assert.fail("no network calls"); }, devBinary: () => undefined, activeProfile: () => undefined,
	});
	const extensions = [];
	for (const factory of shellFirst ? [shellFactory, ownerFactory] : [ownerFactory, shellFactory]) {
		extensions.push(await loadExtensionFromFactory(factory, cwd, bus, runtime));
	}
	const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), {} as never);
	t.after(() => runner.invalidate());
	const theme = getThemeByName("dark")!;
	let view: Component | undefined;
	let opened!: () => void;
	const ready = new Promise<void>(resolve => { opened = resolve; });
	const statuses = new Map<string, string | undefined>();
	const notices: string[] = [];
	let renders = 0;
	runner.setUIContext({
		theme, getAllThemes: () => [{ name: "dark" }], getTheme: () => theme,
		notify: (text: string) => notices.push(text), setStatus: (key: string, text?: string) => statuses.set(key, text), setWidget() {},
		custom(factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Component) {
			return new Promise<void>(resolve => {
				view = factory({ terminal: { rows: 30 }, requestRender: () => { renders++; } }, theme, {}, resolve);
				opened();
			});
		},
	} as unknown as ExtensionUIContext, "tui");
	runner.bindCommandContext();
	const ctx = runner.createCommandContext();
	// The compatibility SDK omits mode; annotate the transport we explicitly
	// bound above. All other getters retain real SDK invalidation semantics.
	if (ctx.mode === undefined) Object.defineProperty(ctx, "mode", { value: "tui" });
	const command = runner.getCommand("gentle:yolo")!, customize = runner.getCommand("gentle:customize")!;
	assert.ok(command); assert.ok(customize);
	const menu = customize.handler("", ctx);
	await ready; assert.ok(view);
	for (let i = 0; i < 3; i++) view.handleInput?.("j");
	view.handleInput?.("\x1b[C"); view.handleInput?.("j"); view.handleInput?.("j");
	const text = () => view!.render(140).map(stripAnsi).join("\n");
	assert.match(text(), /YOLO: OFF · session only/);
	view.handleInput?.("\r");
	for (let i = 0; i < 100 && statuses.get(YOLO_STATUS_KEY) !== YOLO_STATUS_TEXT; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(statuses.get(YOLO_STATUS_KEY), YOLO_STATUS_TEXT);
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.match(text(), /YOLO: ON/);
	await command.handler("disable", ctx);
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.match(text(), /YOLO: OFF/);
	for (const width of [1, 20, 45, 60, 140]) assert.ok(view.render(width).every(line => visibleWidth(line) <= width));
	const adapter = await discoverYoloUiAdapter({
		events: { emit: (name: string, data: unknown) => bus.emit(name, data) },
	} as Parameters<typeof discoverYoloUiAdapter>[0], ctx);
	assert.ok(adapter);
	await runner.emit({ type: "session_shutdown", reason: "reload" });
	await menu;
	assert.equal(await adapter.read(), "UNAVAILABLE");
	await adapter.toggle();
	assert.equal(statuses.get(YOLO_STATUS_KEY), undefined);
	const count = renders;
	view.handleInput?.(" "); view.invalidate(); assert.deepEqual(view.render(140), []);
	assert.equal(renders, count);
	assert.deepEqual(readdirSync(home), [], "no settings persisted by menu or activation");
	assert.ok(notices.some(n => n === YOLO_STATUS_TEXT));
	adapter.dispose();
});
