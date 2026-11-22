import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import {
	BACKGROUND_SUBAGENTS_BUSY,
	BACKGROUND_SUBAGENTS_UNAVAILABLE,
	DESKTOP_BACKGROUND_SUBAGENTS_EVENTS,
	DESKTOP_BACKGROUND_SUBAGENTS_METHODS,
	DESKTOP_BACKGROUND_SUBAGENTS_SERVICE_CHANNEL,
	DESKTOP_BACKGROUND_SUBAGENTS_SERVICE_SCHEMA,
	INVALID_SET_BACKGROUND_SUBAGENTS,
	type DesktopBackgroundSubagentsState,
} from "../lib/desktop-rpc-background-subagents.ts";
import { DesktopBackgroundSubagentsBridge } from "../lib/desktop-background-subagents-service.ts";
import { BACKGROUND_SUBAGENTS_FILE, BACKGROUND_SUBAGENTS_SCHEMA } from "../lib/background-subagents-policy.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// get/set_background_subagents: the `/gentle:background-subagents` policy read
// and written through its owner in `extensions/gentle-ai.ts`, with the same
// two-call confirmation as `set_review_mode`.

function bus() {
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	return {
		on(channel: string, listener: (payload: unknown) => void) { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); return () => {}; },
		emit(channel: string, payload: unknown) { for (const listener of listeners.get(channel) ?? []) listener(payload); },
	};
}

/** The real owner over temporary config and project directories. */
function realOwner(t: test.TestContext, processEnv: NodeJS.ProcessEnv = {}) {
	const root = mkdtempSync(join(tmpdir(), "desktop-rpc-bg-"));
	const configHome = join(root, "config");
	const cwd = join(root, "repo");
	mkdirSync(configHome, { recursive: true });
	mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
	const saved = { config: process.env.GENTLE_PI_CONFIG_HOME, policy: process.env.GENTLE_PI_BACKGROUND_SUBAGENTS };
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	delete process.env.GENTLE_PI_BACKGROUND_SUBAGENTS;
	t.after(() => {
		if (saved.config === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = saved.config;
		if (saved.policy !== undefined) process.env.GENTLE_PI_BACKGROUND_SUBAGENTS = saved.policy;
		rmSync(root, { recursive: true, force: true });
	});
	const events = bus();
	const pi = { on() {}, registerCommand() {}, registerTool() {}, getActiveTools: () => ["read", "subagent_run"], events } as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, processEnv: { GENTLE_AI_TELEMETRY: "0", ...processEnv } })(pi);
	const bridge = new DesktopBackgroundSubagentsBridge(pi);
	bridge.attach({ cwd, mode: "rpc", sessionManager: { getCwd: () => cwd } } as unknown as ExtensionContext);
	return { bridge, globalFile: join(configHome, BACKGROUND_SUBAGENTS_FILE), projectFile: join(cwd, ".pi", "gentle-ai", BACKGROUND_SUBAGENTS_FILE) };
}

const DEFAULT_STATE: DesktopBackgroundSubagentsState = { effective: "off", source: "default", malformed: false, projectFile: "absent", globalFile: "absent", capability: "ready" };

async function token(bridge: DesktopBackgroundSubagentsBridge, policy: "on" | "off"): Promise<string> {
	const outcome = await bridge.handle("set_background_subagents", { policy });
	assert.ok(outcome?.ok);
	return ((outcome.data as { confirmation: { token: string } }).confirmation).token;
}

// ---- Capabilities ----

test("the Desktop transport advertises both methods once and no new event", async (t) => {
	assert.deepEqual([...DESKTOP_BACKGROUND_SUBAGENTS_METHODS], ["get_background_subagents", "set_background_subagents"]);
	assert.deepEqual([...DESKTOP_BACKGROUND_SUBAGENTS_EVENTS], []);
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
	for (const method of DESKTOP_BACKGROUND_SUBAGENTS_METHODS) assert.equal(data.methods.filter((name: string) => name === method).length, 1);
	assert.deepEqual(data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed"]);
});

// ---- The real owner ----

test("get_background_subagents reads the owner's resolution without paths", async (t) => {
	const owner = realOwner(t);
	assert.deepEqual(await owner.bridge.handle("get_background_subagents", {}), { ok: true, data: DEFAULT_STATE });
	writeFileSync(owner.projectFile, "{ broken");
	assert.deepEqual(await owner.bridge.handle("get_background_subagents", {}), { ok: true, data: { ...DEFAULT_STATE, source: "project", malformed: true, projectFile: "present" } });
});

test("set_background_subagents asks first, writes the global file only with the shown token, and answers the re-read", async (t) => {
	const owner = realOwner(t);
	const first = await owner.bridge.handle("set_background_subagents", { policy: "on" });
	assert.ok(first?.ok);
	const asked = first.data as { status: string; policy: string; state: unknown; confirmation: { title: string; message: string; token: string } };
	assert.equal(asked.status, "confirmation_required");
	assert.deepEqual(asked.state, DEFAULT_STATE);
	assert.equal(asked.confirmation.title, "Turn background subagents on machine-wide?");
	assert.match(asked.confirmation.token, /^[0-9a-f]{64}$/);
	assert.equal(existsSync(owner.globalFile), false, "asking never writes");

	const applied = await owner.bridge.handle("set_background_subagents", { policy: "on", confirmationToken: asked.confirmation.token });
	assert.deepEqual(applied, { ok: true, data: { status: "applied", policy: "on", changed: true, state: { ...DEFAULT_STATE, effective: "on", source: "global", globalFile: "present" } } });
	assert.deepEqual(JSON.parse(readFileSync(owner.globalFile, "utf8")), { schema: BACKGROUND_SUBAGENTS_SCHEMA, policy: "on" });
});

test("a token shown before the state changed asks again and writes nothing", async (t) => {
	const owner = realOwner(t);
	const stale = await token(owner.bridge, "on");
	writeFileSync(owner.projectFile, JSON.stringify({ schema: BACKGROUND_SUBAGENTS_SCHEMA, policy: "off" }));
	const outcome = await owner.bridge.handle("set_background_subagents", { policy: "on", confirmationToken: stale });
	assert.ok(outcome?.ok);
	const data = outcome.data as { status: string; confirmation: { message: string } };
	assert.equal(data.status, "confirmation_required");
	assert.match(data.confirmation.message, /this project's file decides here/);
	assert.equal(existsSync(owner.globalFile), false);
});

test("a write a project file outranks reports the unchanged effective policy", async (t) => {
	const owner = realOwner(t);
	writeFileSync(owner.projectFile, JSON.stringify({ schema: BACKGROUND_SUBAGENTS_SCHEMA, policy: "off" }));
	const outcome = await owner.bridge.handle("set_background_subagents", { policy: "on", confirmationToken: await token(owner.bridge, "on") });
	assert.deepEqual(outcome, { ok: true, data: { status: "applied", policy: "on", changed: true, state: { ...DEFAULT_STATE, source: "project", projectFile: "present", globalFile: "present" } } });
});

test("malformed set params are rejected before the owner and write nothing", async (t) => {
	const owner = realOwner(t);
	for (const params of [{}, { policy: "yes" }, { policy: "on", scope: "project" }, { policy: "on", confirmationToken: "" }, { policy: "on", confirmationToken: 7 }]) {
		assert.deepEqual(await owner.bridge.handle("set_background_subagents", params), { ok: false, error: INVALID_SET_BACKGROUND_SUBAGENTS });
	}
	assert.equal(existsSync(owner.globalFile), false);
});

test("a subagent process never answers the owner channel", async (t) => {
	const owner = realOwner(t, { GENTLE_PI_AGENTS_CHILD: "1" });
	assert.deepEqual(await owner.bridge.handle("get_background_subagents", {}), { ok: false, error: BACKGROUND_SUBAGENTS_UNAVAILABLE });
});

// ---- Gate ----

test("a second change while one is pending answers background_subagents_busy", async () => {
	const events = bus();
	let release: () => void = () => {};
	events.on(DESKTOP_BACKGROUND_SUBAGENTS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({
			schema: DESKTOP_BACKGROUND_SUBAGENTS_SERVICE_SCHEMA,
			read: () => new Promise((resolve) => { release = () => resolve({ kind: "status", state: DEFAULT_STATE }); }),
			write: async () => ({ kind: "failed" }),
			dispose() {},
		});
	});
	const bridge = new DesktopBackgroundSubagentsBridge({ events } as unknown as ExtensionAPI);
	bridge.attach({ cwd: "/x" } as unknown as ExtensionContext);
	const first = bridge.handle("set_background_subagents", { policy: "on" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(await bridge.handle("set_background_subagents", { policy: "off" }), { ok: false, error: BACKGROUND_SUBAGENTS_BUSY });
	release();
	const settled = await first;
	assert.ok(settled?.ok);
	assert.equal((settled.data as { status: string }).status, "confirmation_required");
});

test("a change dispatched before a session reset is refused and writes nothing", async (t) => {
	const owner = realOwner(t);
	const dispatched = owner.bridge.dispatchGeneration();
	const shown = await token(owner.bridge, "on");
	owner.bridge.reset();
	owner.bridge.attach({ cwd: "/replacement" } as unknown as ExtensionContext);
	assert.deepEqual(await owner.bridge.handle("set_background_subagents", { policy: "on", confirmationToken: shown }, dispatched), { ok: false, error: BACKGROUND_SUBAGENTS_UNAVAILABLE });
	assert.equal(existsSync(owner.globalFile), false);
});
