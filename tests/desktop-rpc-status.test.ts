import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_STATUS_EVENTS,
	DESKTOP_STATUS_METHODS,
	DESKTOP_STATUS_SERVICE_CHANNEL,
	DESKTOP_STATUS_SERVICE_SCHEMA,
	INVALID_STATUS_PARAMS,
	STATUS_UNAVAILABLE,
	type DesktopPackageStatus,
	type DesktopStatusOwnerRead,
} from "../lib/desktop-rpc-status.ts";
import { DesktopStatusBridge } from "../lib/desktop-status-service.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";
import { GENTLE_AI_DEV_BINARY_ENV } from "../lib/gentle-ai-binary.ts";

// get_status: the facts `/gentle:status` prints, read through the owner's
// versioned service in `extensions/gentle-ai.ts`, without paths, command hints,
// or display text.

const CLEAN: DesktopPackageStatus = {
	package: "active",
	odd: "active",
	persona: "gentleman",
	devBinary: { state: "inactive", sha256Prefix: null },
	assets: { delegation: { stale: 0, userOverrides: 0, activeAgentOverrides: 0 }, review: { stale: 0, userOverrides: 0, activeAgentOverrides: 0 } },
	modelConfig: { global: "missing", routing: "missing" },
	severity: "info",
};

function bus() {
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	return {
		on(channel: string, listener: (payload: unknown) => void) { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); return () => {}; },
		emit(channel: string, payload: unknown) { for (const listener of listeners.get(channel) ?? []) listener(payload); },
	};
}

/** A fake owner answering the status channel with `read`. */
function fakeOwner(read: () => Promise<DesktopStatusOwnerRead> | DesktopStatusOwnerRead) {
	const events = bus();
	const calls = { reads: 0, disposed: 0 };
	events.on(DESKTOP_STATUS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({
			schema: DESKTOP_STATUS_SERVICE_SCHEMA,
			async read() { calls.reads += 1; return await read(); },
			dispose() { calls.disposed += 1; },
		});
	});
	return { pi: { events } as unknown as ExtensionAPI, calls };
}

const ctx = { cwd: "/fixture/repo", mode: "rpc", sessionManager: { getCwd: () => "/fixture/repo" } } as unknown as ExtensionContext;

function bridgeOver(pi: ExtensionAPI) {
	const bridge = new DesktopStatusBridge(pi);
	bridge.attach(ctx);
	return bridge;
}

// ---- Capabilities ----

test("the Desktop transport advertises get_status once and no new event", async (t) => {
	assert.deepEqual([...DESKTOP_STATUS_METHODS], ["get_status"]);
	assert.deepEqual([...DESKTOP_STATUS_EVENTS], []);
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {},
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on() { return () => {}; }, emit() {} },
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	const widgets: string[] = [];
	const host = { mode: "rpc", cwd: "/x", sessionManager: { getCwd: () => "/x", getSessionId: () => "s", getEntries: () => [] }, ui: { setWidget(_k: string, lines: string[]) { widgets.push(...lines); } } };
	for (const handler of handlers.get("session_start") ?? []) handler({}, host);
	await commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "cap", method: "capabilities", params: {} }), host);
	const data = JSON.parse(widgets.at(-1)!).data;
	assert.equal(data.methods.filter((method: string) => method === "get_status").length, 1);
	assert.deepEqual(data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed"]);
});

// ---- Contract over a fake owner ----

test("get_status answers the owner's status and disposes the owner", async () => {
	const owner = fakeOwner(() => ({ kind: "status", status: CLEAN }));
	assert.deepEqual(await bridgeOver(owner.pi).handle("get_status", {}), { ok: true, data: CLEAN });
	assert.deepEqual(owner.calls, { reads: 1, disposed: 1 });
});

test("get_status recomputes severity and drops anything the contract does not name", async () => {
	const status = {
		...CLEAN,
		severity: "info",
		devBinary: { state: "active", sha256Prefix: "0123456789abcdef", path: "C:\\Users\\x\\gentle-ai.exe" },
		assets: { ...CLEAN.assets, review: { stale: 2, userOverrides: 0, activeAgentOverrides: 0, hint: "/gentle:install-review --force" } },
		modelConfig: { global: "present", routing: "invalid", path: "/home/x/.pi/models.json" },
	};
	const outcome = await bridgeOver(fakeOwner(() => ({ kind: "status", status: status as never })).pi).handle("get_status", {});
	assert.deepEqual(outcome, {
		ok: true,
		data: {
			...CLEAN,
			devBinary: { state: "active", sha256Prefix: "0123456789abcdef" },
			assets: { ...CLEAN.assets, review: { stale: 2, userOverrides: 0, activeAgentOverrides: 0 } },
			modelConfig: { global: "present", routing: "invalid" },
			severity: "warning",
		},
	});
});

test("get_status rejects any param before reaching the owner", async () => {
	const owner = fakeOwner(() => ({ kind: "status", status: CLEAN }));
	assert.deepEqual(await bridgeOver(owner.pi).handle("get_status", { verbose: true }), { ok: false, error: INVALID_STATUS_PARAMS });
	assert.equal(owner.calls.reads, 0);
});

test("an absent, unavailable, malformed, or throwing owner answers status_unavailable without detail", async () => {
	const absent = new DesktopStatusBridge({ events: bus() } as unknown as ExtensionAPI);
	absent.attach(ctx);
	assert.deepEqual(await absent.handle("get_status", {}), { ok: false, error: STATUS_UNAVAILABLE });
	for (const read of [
		() => ({ kind: "unavailable" }) as DesktopStatusOwnerRead,
		() => ({ kind: "status", status: { ...CLEAN, persona: "pirate" } }) as never,
		() => { throw new Error("EACCES C:\\Users\\secret\\models.json"); },
	]) {
		const owner = fakeOwner(read);
		assert.deepEqual(await bridgeOver(owner.pi).handle("get_status", {}), { ok: false, error: STATUS_UNAVAILABLE });
		assert.equal(owner.calls.disposed, 1);
	}
});

test("a reset during the read drops its answer", async () => {
	let release: (value: DesktopStatusOwnerRead) => void = () => {};
	const owner = fakeOwner(() => new Promise<DesktopStatusOwnerRead>((resolve) => { release = resolve; }));
	const bridge = bridgeOver(owner.pi);
	const pending = bridge.handle("get_status", {});
	await new Promise((resolve) => setImmediate(resolve));
	bridge.reset();
	release({ kind: "status", status: CLEAN });
	assert.deepEqual(await pending, { ok: false, error: STATUS_UNAVAILABLE });
});

// ---- The real owner ----

test("the real gentle-ai owner answers the same facts /gentle:status prints, path-free", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "desktop-rpc-status-"));
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	const cwd = join(root, "repo");
	mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
	mkdirSync(configHome, { recursive: true });
	mkdirSync(agentHome, { recursive: true });
	writeFileSync(join(cwd, ".pi", "gentle-ai", "persona.json"), JSON.stringify({ mode: "neutral" }));
	const saved = { config: process.env.GENTLE_PI_CONFIG_HOME, agent: process.env.GENTLE_PI_AGENT_HOME, dev: process.env[GENTLE_AI_DEV_BINARY_ENV] };
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	delete process.env[GENTLE_AI_DEV_BINARY_ENV];
	t.after(() => {
		for (const [key, value] of [["GENTLE_PI_CONFIG_HOME", saved.config], ["GENTLE_PI_AGENT_HOME", saved.agent], [GENTLE_AI_DEV_BINARY_ENV, saved.dev]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const events = bus();
	const pi = { on() {}, registerCommand() {}, registerTool() {}, events } as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, processEnv: { GENTLE_AI_TELEMETRY: "0" } })(pi);
	const bridge = new DesktopStatusBridge(pi);
	bridge.attach({ ...ctx, cwd, sessionManager: { getCwd: () => cwd } } as unknown as ExtensionContext);
	const outcome = await bridge.handle("get_status", {});
	assert.ok(outcome?.ok, JSON.stringify(outcome));
	const data = outcome.data as unknown as DesktopPackageStatus;
	assert.equal(data.persona, "neutral", "the project persona file wins, as in /gentle:status");
	assert.deepEqual(data.devBinary, { state: "inactive", sha256Prefix: null });
	assert.deepEqual(data.modelConfig, { global: "missing", routing: "missing" });
	assert.ok(data.assets.delegation.stale > 0, "an empty agent home has every managed delegation asset missing");
	assert.equal(data.severity, "warning");
	assert.equal(JSON.stringify(data).includes(root.replaceAll("\\", "\\\\")), false);
	assert.equal(JSON.stringify(data).includes("--force"), false);
});
