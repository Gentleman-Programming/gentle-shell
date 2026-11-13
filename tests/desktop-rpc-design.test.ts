import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import gentleDesign from "../extensions/gentle-design.ts";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET, DesktopRpcRouter, type DesktopRpcDomain } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_DESIGN_EVENT,
	DESKTOP_DESIGN_EVENTS,
	DESKTOP_DESIGN_METHODS,
	DESKTOP_DESIGN_SERVICE_CHANNEL,
	DESKTOP_DESIGN_SERVICE_SCHEMA,
	DESIGN_UNAVAILABLE,
	isDesktopDesignServiceShape,
	parseDesignCanvasParams,
	type DesktopDesignEntry,
	type DesktopDesignOwnerState,
	type DesktopDesignOwnerTransition,
	type DesktopDesignService,
} from "../lib/desktop-rpc-design.ts";
import { DesktopDesignBridge, discoverDesktopDesignService } from "../lib/desktop-design-service.ts";
import { createDesignCanvas, type DesignCanvasTransition } from "../lib/gentle-design.ts";
import type { DesignCanvasServer, DesignCanvasServerOptions } from "../lib/design-canvas-server.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// ---- Fixtures ----

const scratchDirs: string[] = [];
test.after(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratchCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "desktop-design-test-"));
	scratchDirs.push(dir);
	return dir;
}

function writeDesign(cwd: string, slug: string, title: string): void {
	mkdirSync(join(cwd, "design", slug), { recursive: true });
	writeFileSync(
		join(cwd, "design", slug, "design.json"),
		JSON.stringify({ title, brief: "b", artboards: [{ file: "01-a.html", title: "A", tradeoff: "t", width: 800, height: 600 }] }),
	);
	writeFileSync(join(cwd, "design", slug, "01-a.html"), "<h1>A</h1>");
}

function makeCanvasState(running: boolean, slug: string | null, connectedClients: number): DesktopDesignOwnerState {
	return { running, slug, connectedClients };
}

function makeService(initial: { state?: DesktopDesignOwnerState; url?: string; designs?: DesktopDesignEntry[] } = {}) {
	const observers = new Set<(transition: DesktopDesignOwnerTransition) => void>();
	let state = initial.state ?? makeCanvasState(false, null, 0);
	let url = initial.url;
	let designs = initial.designs ?? [];
	const service: DesktopDesignService = {
		schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
		read: async () => state,
		url: () => url,
		listDesigns: () => designs,
		observe: (options, onTransition) => {
			const callback = (transition: DesktopDesignOwnerTransition) => {
				onTransition({ ...transition, ...(options.includeUrl && url !== undefined ? { url } : {}) });
			};
			observers.add(callback);
			return () => observers.delete(callback);
		},
		dispose: () => { observers.clear(); },
	};
	return {
		service,
		observers,
		setState(next: DesktopDesignOwnerState) { state = next; },
		setUrl(next: string | undefined) { url = next; },
		setDesigns(next: DesktopDesignEntry[]) { designs = next; },
		notify(transition: DesktopDesignOwnerTransition) { for (const observer of [...observers]) observer(transition); },
	};
}

function makeBridge(service: DesktopDesignService, options: { trusted?: boolean } = {}) {
	const bridge = new DesktopDesignBridge({} as ExtensionAPI, {
		discover: async () => service,
		trusted: () => options.trusted ?? true,
	});
	bridge.attach({} as ExtensionContext);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	bridge.wire((event, data) => events.push({ event, data }));
	return { bridge, events };
}

// ---- Pure contract ----

test("parseDesignCanvasParams accepts empty or an explicit includeUrl boolean only", () => {
	assert.deepEqual(parseDesignCanvasParams({}), { includeUrl: false });
	assert.deepEqual(parseDesignCanvasParams({ includeUrl: true }), { includeUrl: true });
	assert.deepEqual(parseDesignCanvasParams({ includeUrl: false }), { includeUrl: false });
	for (const params of [
		{ includeUrl: "yes" },
		{ includeUrl: 1 },
		{ includeUrl: true, extra: true },
		{ unexpected: true },
	]) {
		const parsed = parseDesignCanvasParams(params);
		assert.equal("error" in parsed, true, JSON.stringify(params));
		assert.deepEqual((parsed as { error: unknown }).error, { code: "invalid_request", message: "Invalid design canvas parameters" });
	}
});

test("isDesktopDesignServiceShape accepts only the versioned adapter", () => {
	const good = {
		schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
		read: async () => makeCanvasState(false, null, 0),
		url: () => undefined,
		listDesigns: () => [],
		observe: () => () => {},
		dispose: () => {},
	};
	assert.equal(isDesktopDesignServiceShape(good), true);
	assert.equal(isDesktopDesignServiceShape({ ...good, schema: "gentle-pi.desktop-design-service/v0" }), false);
	assert.equal(isDesktopDesignServiceShape({ ...good, read: undefined }), false);
	assert.equal(isDesktopDesignServiceShape({ ...good, url: undefined }), false);
	assert.equal(isDesktopDesignServiceShape({ ...good, listDesigns: undefined }), false);
	assert.equal(isDesktopDesignServiceShape({ ...good, observe: undefined }), false);
	assert.equal(isDesktopDesignServiceShape({ ...good, dispose: undefined }), false);
	assert.equal(isDesktopDesignServiceShape(null), false);
	assert.equal(isDesktopDesignServiceShape("nope"), false);
});

// ---- Canvas owner: state and observed transitions ----

test("createDesignCanvas reports state and observes actual open/refresh/stop transitions", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "login", "Login screen");
	const pages = { connected: 0 };
	const transitions: DesignCanvasTransition[] = [];
	const canvas = createDesignCanvas(
		() => ({ queued: false }),
		{
			startServer: async (options: DesignCanvasServerOptions) => ({
				port: 4100,
				token: "tok",
				url: "http://127.0.0.1:4100/tok/",
				close: async () => {},
				connectedClients: () => pages.connected,
				show: (slug) => { void slug; return pages.connected; },
			} as DesignCanvasServer),
			openBrowser: async () => ({ opened: true }),
		},
	);
	canvas.observe((transition) => transitions.push(transition));

	assert.deepEqual(await canvas.state(), makeCanvasState(false, null, 0));

	await canvas.open(cwd, "login");
	assert.deepEqual(await canvas.state(), makeCanvasState(true, "login", 0));
	assert.deepEqual(transitions, [{ transition: "open", ...makeCanvasState(true, "login", 0) }]);

	pages.connected = 2;
	await canvas.open(cwd, "login");
	assert.deepEqual(transitions.at(-1), { transition: "refresh", ...makeCanvasState(true, "login", 2) });

	assert.equal(await canvas.stop(), true);
	assert.deepEqual(await canvas.state(), makeCanvasState(false, null, 0));
	assert.deepEqual(transitions.at(-1), { transition: "stop", ...makeCanvasState(false, null, 0) });

	const count = transitions.length;
	assert.equal(await canvas.stop(), false, "a stop with nothing running is a no-op");
	assert.equal(transitions.length, count, "a no-op stop emits nothing");
});

test("failed and no-op canvas actions emit no transition", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "login", "Login screen");
	const transitions: DesignCanvasTransition[] = [];
	const canvas = createDesignCanvas(
		() => ({ queued: false }),
		{
			startServer: async () => ({ port: 4100, token: "tok", url: "http://127.0.0.1:4100/tok/", close: async () => {}, connectedClients: () => 0, show: () => 0 } as DesignCanvasServer),
			openBrowser: async () => ({ opened: false, error: "spawn xdg-open ENOENT" }),
		},
	);
	canvas.observe((transition) => transitions.push(transition));

	// Unknown slug refuses without starting the server.
	const unknown = await canvas.open(cwd, "missing");
	assert.equal(unknown.level, "warning");
	assert.equal(transitions.length, 0, "a refused open emits nothing");

	// A browser that cannot launch is a failed open, not an open transition.
	const failed = await canvas.open(cwd, "login");
	assert.equal(failed.opened, false);
	assert.equal(transitions.length, 0, "a failed browser open emits nothing");

	// A server that cannot start is also failed and emits nothing.
	const broken = createDesignCanvas(
		() => ({ queued: false }),
		{ startServer: async () => { throw new Error("bind EADDRINUSE private-port"); }, openBrowser: async () => ({ opened: true }) },
	);
	const brokenTransitions: DesignCanvasTransition[] = [];
	broken.observe((transition) => brokenTransitions.push(transition));
	const startFailure = await broken.open(cwd, "login");
	assert.equal(startFailure.level, "error");
	assert.equal(brokenTransitions.length, 0, "a failed start emits nothing");
});

// ---- Bridge reads ----

test("get_design_canvas reports stopped state and design metadata without the URL by default", async () => {
	const { service } = makeService({
		state: makeCanvasState(false, null, 0),
		designs: [{ slug: "login", title: "Login screen", mtime: 1000 }],
		url: "http://127.0.0.1:4100/tok/d/login/",
	});
	const { bridge, events } = makeBridge(service);
	const outcome = await bridge.handle("get_design_canvas", {});
	assert.equal(outcome.ok, true);
	assert.deepEqual(outcome.data, {
		running: false,
		slug: null,
		connectedClients: 0,
		designs: [{ slug: "login", title: "Login screen", mtime: 1000 }],
	});
	assert.equal("url" in (outcome as { ok: true; data: Record<string, unknown> }).data, false, "the URL is a capability, omitted by default");
	assert.equal(events.length, 0, "a read emits nothing");
});

test("get_design_canvas reports running slug and clients and includes the URL only after explicit includeUrl and trust", async () => {
	const { service } = makeService({
		state: makeCanvasState(true, "login", 3),
		url: "http://127.0.0.1:4100/tok/d/login/",
	});

	// Default: no url even though the client is trusted.
	const defaultBridge = makeBridge(service, { trusted: true });
	const omitted = await defaultBridge.bridge.handle("get_design_canvas", {});
	assert.equal((omitted as { ok: true; data: Record<string, unknown> }).data.url, undefined);

	// Explicit includeUrl on a trusted host.
	const included = await defaultBridge.bridge.handle("get_design_canvas", { includeUrl: true });
	assert.deepEqual((included as { ok: true; data: Record<string, unknown> }).data, {
		running: true,
		slug: "login",
		connectedClients: 3,
		designs: [],
		url: "http://127.0.0.1:4100/tok/d/login/",
	});

	// Explicit includeUrl without trust still omits the capability.
	const untrusted = makeBridge(service, { trusted: false });
	const blocked = await untrusted.bridge.handle("get_design_canvas", { includeUrl: true });
	assert.equal("url" in (blocked as { ok: true; data: Record<string, unknown> }).data, false);
});

test("no owner answers design_unavailable rather than inventing running:false", async () => {
	const bridge = new DesktopDesignBridge({} as ExtensionAPI, { discover: async () => undefined, trusted: () => true });
	bridge.attach({} as ExtensionContext);
	const outcome = await bridge.handle("get_design_canvas", {});
	assert.equal(outcome.ok, false);
	assert.deepEqual(outcome.error, DESIGN_UNAVAILABLE);
});

test("malformed get_design_canvas params are typed rejections without events", async () => {
	const { service } = makeService();
	const { bridge, events } = makeBridge(service);
	for (const params of [{ includeUrl: "yes" }, { includeUrl: 1 }, { includeUrl: true, extra: true }, { unexpected: true }]) {
		const outcome = await bridge.handle("get_design_canvas", params);
		assert.equal(outcome.ok, false);
		assert.deepEqual(outcome.error, { code: "invalid_request", message: "Invalid design canvas parameters" });
	}
	assert.equal(events.length, 0);
});

test("a throwing owner never leaks raw errors or the tokenized URL", async () => {
	const service: DesktopDesignService = {
		schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
		read: async () => { throw new Error("secret-token-xyz http://127.0.0.1:4100/tok/d/login/ /etc/passwd"); },
		url: () => "http://127.0.0.1:4100/tok/d/login/",
		listDesigns: () => [],
		observe: () => () => {},
		dispose: () => {},
	};
	const { bridge } = makeBridge(service, { trusted: true });
	const outcome = await bridge.handle("get_design_canvas", { includeUrl: true });
	assert.equal(outcome.ok, false);
	const text = JSON.stringify(outcome);
	assert.equal(text.includes("secret-token-xyz"), false);
	assert.equal(text.includes("/tok/"), false);
	assert.equal(text.includes("/etc/passwd"), false);
	assert.deepEqual(outcome.error, DESIGN_UNAVAILABLE);
});

test("a malformed owner state is design_unavailable, never a malformed success", async () => {
	const malformedStates = [
		{ running: "yes", slug: "login", connectedClients: 0 },
		{ running: true, slug: 42, connectedClients: 0 },
		{ running: true, slug: "", connectedClients: 0 },
		{ running: true, slug: "login", connectedClients: "many" },
		{ running: true, slug: "login", connectedClients: -1 },
		{ running: true, slug: "login", connectedClients: 1.5 },
		null,
	];
	for (const state of malformedStates) {
		const service: DesktopDesignService = {
			schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
			read: async () => state as unknown as DesktopDesignOwnerState,
			url: () => undefined,
			listDesigns: () => [],
			observe: () => () => {},
			dispose: () => {},
		};
		const { bridge } = makeBridge(service);
		const outcome = await bridge.handle("get_design_canvas", {});
		assert.equal(outcome.ok, false, JSON.stringify(state));
		assert.deepEqual(outcome.error, DESIGN_UNAVAILABLE);
	}
});

test("a malformed design list is design_unavailable, never a malformed success", async () => {
	const malformedLists = [
		{ not: "an array" },
		[{ slug: 42, title: "Login", mtime: 1 }],
		[{ slug: "", title: "Login", mtime: 1 }],
		[{ slug: "login", title: 42, mtime: 1 }],
		[{ slug: "login", title: "Login", mtime: "yesterday" }],
		[{ slug: "login", title: "Login", mtime: Number.NaN }],
		[null],
	];
	for (const designs of malformedLists) {
		const service: DesktopDesignService = {
			schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
			read: async () => makeCanvasState(true, "login", 0),
			url: () => undefined,
			listDesigns: () => designs as unknown as DesktopDesignEntry[],
			observe: () => () => {},
			dispose: () => {},
		};
		const { bridge } = makeBridge(service);
		const outcome = await bridge.handle("get_design_canvas", {});
		assert.equal(outcome.ok, false, JSON.stringify(designs));
		assert.deepEqual(outcome.error, DESIGN_UNAVAILABLE);
	}
});

test("a malformed tokenized URL is omitted, never emitted as a capability", async () => {
	const junkUrls = [42, "", null, {}, ["http://127.0.0.1:4100/tok/d/login/"]];
	for (const junk of junkUrls) {
		const service: DesktopDesignService = {
			schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
			read: async () => makeCanvasState(true, "login", 1),
			url: () => junk as unknown as string,
			listDesigns: () => [{ slug: "login", title: "Login screen", mtime: 1 }],
			observe: () => () => {},
			dispose: () => {},
		};
		const { bridge } = makeBridge(service, { trusted: true });
		const outcome = await bridge.handle("get_design_canvas", { includeUrl: true });
		assert.equal(outcome.ok, true, JSON.stringify(junk));
		assert.equal("url" in (outcome as { ok: true; data: Record<string, unknown> }).data, false, `junk url ${JSON.stringify(junk)} must be dropped`);
	}
});

test("foreign token fields in owner entries are dropped, never echoed", async () => {
	const service: DesktopDesignService = {
		schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
		read: async () => ({ running: true, slug: "login", connectedClients: 0, token: "secret-tok" }) as unknown as DesktopDesignOwnerState,
		url: () => undefined,
		listDesigns: () => [{ slug: "login", title: "Login screen", mtime: 1, token: "secret-tok", url: "http://127.0.0.1:4100/tok/d/login/" }] as unknown as DesktopDesignEntry[],
		observe: () => () => {},
		dispose: () => {},
	};
	const { bridge } = makeBridge(service);
	const outcome = await bridge.handle("get_design_canvas", {});
	assert.equal(outcome.ok, true);
	const data = (outcome as { ok: true; data: Record<string, unknown> }).data;
	assert.equal(JSON.stringify(data).includes("secret-tok"), false);
	assert.deepEqual(data, { running: true, slug: "login", connectedClients: 0, designs: [{ slug: "login", title: "Login screen", mtime: 1 }] });
});

test("invalid get_design_canvas params are rejected before any owner discovery", async () => {
	let discoveries = 0;
	const service: DesktopDesignService = {
		schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
		read: async () => makeCanvasState(true, "login", 0),
		url: () => undefined,
		listDesigns: () => [],
		observe: () => () => {},
		dispose: () => {},
	};
	const bridge = new DesktopDesignBridge({} as ExtensionAPI, {
		discover: async () => { discoveries += 1; return service; },
		trusted: () => true,
	});
	bridge.attach({} as ExtensionContext);
	for (const params of [{ includeUrl: "yes" }, { unexpected: true }]) {
		const outcome = await bridge.handle("get_design_canvas", params);
		assert.equal(outcome.ok, false);
		assert.deepEqual(outcome.error, { code: "invalid_request", message: "Invalid design canvas parameters" });
	}
	assert.equal(discoveries, 0, "invalid params never reach discovery");

	// A valid request still discovers exactly once and answers.
	const ok = await bridge.handle("get_design_canvas", {});
	assert.equal(ok.ok, true);
	assert.equal(discoveries, 1);
});

// ---- Bridge events: agent-driven canvas work reaches the app ----

test("agent-driven transitions become sanitized design_canvas events and the URL follows trust", async () => {
	const { service, notify, setUrl } = makeService({ url: "http://127.0.0.1:4100/tok/d/login/" });

	// Untrusted host: sanitized state only, never the URL.
	const untrusted = makeBridge(service, { trusted: false });
	await untrusted.bridge.handle("get_design_canvas", {});
	notify({ transition: "open", ...makeCanvasState(true, "login", 0) });
	assert.equal(untrusted.events.length, 1);
	assert.deepEqual(untrusted.events[0], {
		event: DESKTOP_DESIGN_EVENT,
		data: { transition: "open", running: true, slug: "login", connectedClients: 0 },
	});

	// Trusted host: the same transition carries the tokenized URL.
	const trusted = makeBridge(service, { trusted: true });
	await trusted.bridge.handle("get_design_canvas", {});
	notify({ transition: "refresh", ...makeCanvasState(true, "login", 2) });
	assert.deepEqual(trusted.events[0], {
		event: DESKTOP_DESIGN_EVENT,
		data: { transition: "refresh", running: true, slug: "login", connectedClients: 2, url: "http://127.0.0.1:4100/tok/d/login/" },
	});

	// A stop transition has no URL even for a trusted host.
	setUrl(undefined);
	notify({ transition: "stop", ...makeCanvasState(false, null, 0) });
	assert.deepEqual(trusted.events[1].data, { transition: "stop", running: false, slug: null, connectedClients: 0 });
});

test("session reset disconnects observers and drops stale async outcomes", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const observers = new Set<(transition: DesktopDesignOwnerTransition) => void>();
	const service: DesktopDesignService = {
		schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
		read: async () => { await gate; return makeCanvasState(true, "login", 1); },
		url: () => "http://127.0.0.1:4100/tok/d/login/",
		listDesigns: () => [],
		observe: (_options, onTransition) => { observers.add(onTransition); return () => observers.delete(onTransition); },
		dispose: () => { observers.clear(); },
	};
	const bridge = new DesktopDesignBridge({} as ExtensionAPI, { discover: async () => service, trusted: () => true });
	bridge.attach({} as ExtensionContext);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	bridge.wire((event, data) => events.push({ event, data }));

	// Subscribe, then reset before the read settles and before any transition.
	const pending = bridge.handle("get_design_canvas", {});
	bridge.reset();
	for (const observer of [...observers]) observer({ transition: "open", ...makeCanvasState(true, "login", 0) });
	assert.equal(events.length, 0, "a disposed session never delivers a transition");
	release!();
	const outcome = await pending;
	assert.equal(outcome.ok, false, "a stale read resolves to a safe typed answer");
	assert.deepEqual(outcome.error, DESIGN_UNAVAILABLE);
});

test("a late discovery after reset is disposed and never cached for the next session", async () => {
	let releaseOld: (service: DesktopDesignService) => void = () => {};
	const oldGate = new Promise<DesktopDesignService>((resolve) => { releaseOld = resolve; });
	const disposed: string[] = [];
	const oldService: DesktopDesignService = {
		schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
		read: async () => makeCanvasState(false, null, 0),
		url: () => undefined,
		listDesigns: () => [],
		observe: () => () => {},
		dispose: () => { disposed.push("old"); },
	};
	const newService: DesktopDesignService = {
		schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
		read: async () => makeCanvasState(true, "login", 1),
		url: () => undefined,
		listDesigns: () => [],
		observe: () => () => {},
		dispose: () => {},
	};
	let discoverCount = 0;
	const bridge = new DesktopDesignBridge({} as ExtensionAPI, {
		discover: () => { discoverCount += 1; return discoverCount === 1 ? oldGate : Promise.resolve(newService); },
		trusted: () => true,
	});
	bridge.attach({} as ExtensionContext);
	const first = bridge.handle("get_design_canvas", {});
	bridge.reset();
	releaseOld(oldService);
	const firstOutcome = await first;
	assert.equal(firstOutcome.ok, false, "the superseded discovery answers unavailable");
	assert.deepEqual(disposed, ["old"], "the late adapter is disposed, never cached");

	// The next session discovers its own owner, not the stale one.
	bridge.attach({} as ExtensionContext);
	bridge.wire(() => {});
	const second = await bridge.handle("get_design_canvas", {});
	assert.equal(second.ok, true);
	assert.equal(discoverCount, 2);
	assert.deepEqual((second as { ok: true; data: Record<string, unknown> }).data, { running: true, slug: "login", connectedClients: 1, designs: [] });
});

// ---- Discovery: versioned, defensive adapter ----

test("discoverDesktopDesignService accepts the versioned adapter and ignores malformed responders", async () => {
	const listeners = new Map<string, (value: unknown) => void>();
	const pi = {
		events: {
			on(name: string, handler: (value: unknown) => void) { listeners.set(name, handler); return () => listeners.delete(name); },
			emit(name: string, value: unknown) { listeners.get(name)?.(value); },
		},
	} as unknown as ExtensionAPI;
	const ctx = {} as ExtensionContext;

	listeners.set(DESKTOP_DESIGN_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({
			schema: DESKTOP_DESIGN_SERVICE_SCHEMA,
			read: async () => makeCanvasState(false, null, 0),
			url: () => undefined,
			listDesigns: () => [],
			observe: () => () => {},
			dispose: () => {},
		});
	});
	const service = await discoverDesktopDesignService(pi, ctx);
	assert.equal(service?.schema, DESKTOP_DESIGN_SERVICE_SCHEMA);

	listeners.set(DESKTOP_DESIGN_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({ schema: "gentle-pi.desktop-design-service/v0", read: async () => makeCanvasState(false, null, 0) });
	});
	assert.equal(await discoverDesktopDesignService(pi, ctx), undefined);
});

// ---- Real owner service ----

test("the real gentle-design owner service answers stopped canvas state and design list", async () => {
	const cwd = scratchCwd();
	writeDesign(cwd, "login", "Login screen");
	const listeners = new Map<string, (value: unknown) => void>();
	const pi = {
		registerCommand() {},
		registerTool() {},
		getCommands() { return []; },
		sendUserMessage() {},
		on() { return () => {}; },
		events: {
			on(name: string, handler: (value: unknown) => void) { listeners.set(name, handler); return () => { if (listeners.get(name) === handler) listeners.delete(name); }; },
			emit(name: string, value: unknown) { listeners.get(name)?.(value); },
		},
	} as unknown as ExtensionAPI;
	gentleDesign(pi, {});
	const ctx = { cwd } as ExtensionContext;

	const service = await discoverDesktopDesignService(pi, ctx);
	assert.ok(service, "the owner seam must answer in-process");
	assert.equal(service.schema, DESKTOP_DESIGN_SERVICE_SCHEMA);
	assert.deepEqual(await service.read(), makeCanvasState(false, null, 0));
	assert.equal(service.url(), undefined);
	assert.deepEqual(
		service.listDesigns().map((design) => `${design.slug}:${design.title}`),
		["login:Login screen"],
	);
	service.dispose();
});

// ---- Transport: capabilities and owner absence ----

test("the Desktop transport advertises the design method and event", async (t) => {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: any) => void>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { events.set(name, handler); },
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	const widgets: Array<{ key: string; lines: string[] }> = [];
	const ctx = { mode: "rpc", ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } } };
	events.get("session_start")?.({}, ctx);
	await commands.get("gentle:desktop")!.handler(
		JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "cap-1", method: "capabilities", params: {} }),
		ctx,
	);
	assert.equal(widgets[0].key, DESKTOP_RPC_WIDGET);
	const response = JSON.parse(widgets[0].lines[0]);
	assert.deepEqual(response.data.methods, [
		"capabilities",
		"get_snapshot",
		"get_config",
		"set_config",
		"get_permission_mode",
		"set_permission_mode",
		"get_subscription_usage",
		"refresh_subscription_usage",
		"get_design_canvas",
		"list_jobs",
		"cancel_job",
		"list_subagents",
		"cancel_subagent",
	]);
	assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "agents_update"]);
});

test("get_design_canvas answers design_unavailable through the transport without an owner extension", async (t) => {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: any) => void>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { events.set(name, handler); },
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	const widgets: Array<{ key: string; lines: string[] }> = [];
	const ctx = { mode: "rpc", ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } } };
	events.get("session_start")?.({}, ctx);
	await commands.get("gentle:desktop")!.handler(
		JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "design-1", method: "get_design_canvas", params: {} }),
		ctx,
	);
	const response = JSON.parse(widgets[0].lines[0]);
	assert.equal(response.ok, false);
	assert.deepEqual(response.error, DESIGN_UNAVAILABLE);
});

// ---- Router sequencing: response before event ----

test("the router publishes a design read response without an event and drops superseded sessions", async () => {
	const { service } = makeService({ state: makeCanvasState(true, "login", 0), url: "http://127.0.0.1:4100/tok/d/login/" });
	const bridge = new DesktopDesignBridge({} as ExtensionAPI, { discover: async () => service, trusted: () => true });
	bridge.attach({} as ExtensionContext);
	const domain: DesktopRpcDomain = (method, params) => bridge.handle(method, params as Record<string, unknown>);
	const lines: string[] = [];
	const router = new DesktopRpcRouter(
		["capabilities", "get_snapshot", ...DESKTOP_DESIGN_METHODS],
		[...DESKTOP_DESIGN_EVENTS],
		undefined,
		domain,
	);
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "design-read", method: "get_design_canvas", params: { includeUrl: true } }));
	assert.deepEqual(lines.map((line) => JSON.parse(line).kind), ["response"]);
	assert.deepEqual(JSON.parse(lines[0]!).data, { running: true, slug: "login", connectedClients: 0, designs: [], url: "http://127.0.0.1:4100/tok/d/login/" });
});
