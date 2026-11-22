import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_PROFILE_BINDING_EVENTS,
	DESKTOP_PROFILE_BINDING_METHODS,
	DesktopProfileBindingBridge,
	INVALID_PROFILE_BINDING_PARAMS,
	PROFILE_BINDING_BUSY,
	PROFILE_BINDING_UNAVAILABLE,
} from "../lib/desktop-rpc-profile-binding.ts";
import { DESKTOP_PROFILES_SERVICE_SCHEMA, type DesktopProfilesService } from "../lib/desktop-rpc-profiles.ts";
import { bindSessionProfile, clearSessionProfileBinding, resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// get_profile_binding / clear_profile_binding / profile_binding_changed
// (gentle-shell-gpui parity, T1): the session's profile through the single rule
// launches use, every binding write as an event, and the owner's clear.

function fixture(t: test.TestContext, service?: Partial<DesktopProfilesService>) {
	resetSessionProfileBindingsForTesting();
	t.after(resetSessionProfileBindingsForTesting);
	const root = mkdtempSync(join(tmpdir(), "desktop-profile-binding-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "repo");
	const configHome = join(root, "config");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(configHome, { recursive: true });
	const calls = { discover: 0 };
	const pi = { events: { on() { return () => {}; }, emit() {} } } as unknown as ExtensionAPI;
	const bridge = new DesktopProfileBindingBridge(pi, {
		configHome,
		env: { GENTLE_PI_CONFIG_HOME: configHome },
		resolveWorktree: () => undefined,
		discover: async () => {
			calls.discover += 1;
			return service ? ({ schema: DESKTOP_PROFILES_SERVICE_SCHEMA, apply: async () => ({ status: "not_applied", notes: [] }), dispose() {}, ...service } as DesktopProfilesService) : undefined;
		},
	});
	const host = { cwd, sessionManager: { getSessionId: () => "session-a", getCwd: () => cwd } } as unknown as ExtensionContext;
	bridge.attach(host);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	return { bridge, calls, events, emit: (event: string, data: Record<string, unknown>) => events.push({ event, data }) };
}

// ---- Capabilities ----

test("the Desktop transport advertises both methods and the change event once", async (t) => {
	assert.deepEqual([...DESKTOP_PROFILE_BINDING_METHODS], ["get_profile_binding", "clear_profile_binding"]);
	assert.deepEqual([...DESKTOP_PROFILE_BINDING_EVENTS], ["profile_binding_changed"]);
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
	for (const method of DESKTOP_PROFILE_BINDING_METHODS) assert.equal(data.methods.filter((name: string) => name === method).length, 1);
	assert.equal(data.events.filter((name: string) => name === "profile_binding_changed").length, 1);
});

// ---- Read ----

test("get_profile_binding answers the explicit session choice, including one made outside Desktop", async (t) => {
	const f = fixture(t);
	const before = await f.bridge.handle("get_profile_binding", {});
	assert.ok(before?.ok);
	assert.equal((before.data as { profile: unknown }).profile, null, "no profile anywhere: the routing without a profile");
	bindSessionProfile("session-a", "fast", { worker: { model: "openai/gpt-probe" } });
	assert.deepEqual(await f.bridge.handle("get_profile_binding", {}), { ok: true, data: { kind: "explicit", profile: "fast", origin: "session" } });
});

test("get_profile_binding rejects params and answers unavailable without a session", async (t) => {
	const f = fixture(t);
	assert.deepEqual(await f.bridge.handle("get_profile_binding", { session: "x" }), { ok: false, error: INVALID_PROFILE_BINDING_PARAMS });
	f.bridge.reset();
	assert.deepEqual(await f.bridge.handle("get_profile_binding", {}), { ok: false, error: PROFILE_BINDING_UNAVAILABLE });
});

// ---- Event ----

test("a binding written outside Desktop emits one external profile_binding_changed for this session only", async (t) => {
	const f = fixture(t);
	f.bridge.wire(f.emit);
	bindSessionProfile("other-session", "slow", {});
	assert.equal(f.events.length, 0, "another session's binding is not this session's change");
	bindSessionProfile("session-a", "fast", {});
	bindSessionProfile("session-a", "fast", {});
	assert.deepEqual(f.events, [{ event: "profile_binding_changed", data: { kind: "explicit", profile: "fast", origin: "session", source: "external" } }]);
	f.bridge.reset();
	clearSessionProfileBinding("session-a");
	assert.equal(f.events.length, 1, "a reset disconnects the observer");
});

// ---- Clear ----

test("clear_profile_binding runs the owner clear and reports the change once, as desktop", async (t) => {
	const f = fixture(t, { clear: async () => { clearSessionProfileBinding("session-a"); return { status: "cleared" }; } });
	f.bridge.wire(f.emit);
	bindSessionProfile("session-a", "fast", {});
	f.events.length = 0;
	const outcome = await f.bridge.handle("clear_profile_binding", {});
	assert.ok(outcome?.ok);
	assert.equal((outcome.data as { status: string }).status, "cleared");
	assert.equal((outcome.data as { changed: boolean }).changed, true);
	assert.equal(((outcome.data as { binding: { profile: unknown } }).binding).profile, null);
	assert.equal(outcome.event?.name, "profile_binding_changed");
	assert.equal((outcome.event?.data as { source: string }).source, "desktop");
	assert.equal(f.events.length, 0, "the Desktop's own clear is not echoed as external");
});

test("clear_profile_binding with nothing to clear answers unchanged and no event", async (t) => {
	const f = fixture(t, { clear: async () => ({ status: "unchanged" }) });
	const outcome = await f.bridge.handle("clear_profile_binding", {});
	assert.ok(outcome?.ok);
	assert.deepEqual({ status: (outcome.data as any).status, changed: (outcome.data as any).changed }, { status: "unchanged", changed: false });
	assert.equal(outcome.event, undefined);
});

test("clear_profile_binding answers busy during a profile apply and unavailable for an owner without clear", async (t) => {
	const busy = fixture(t, { clear: async () => ({ status: "busy" }) });
	assert.deepEqual(await busy.bridge.handle("clear_profile_binding", {}), { ok: false, error: PROFILE_BINDING_BUSY });
	const old = fixture(t, {});
	assert.deepEqual(await old.bridge.handle("clear_profile_binding", {}), { ok: false, error: PROFILE_BINDING_UNAVAILABLE });
	const bad = fixture(t, { clear: async () => ({ status: "cleared" }) });
	assert.deepEqual(await bad.bridge.handle("clear_profile_binding", { profile: "fast" }), { ok: false, error: INVALID_PROFILE_BINDING_PARAMS });
	assert.equal(bad.calls.discover, 0, "malformed params never reach the owner");
});

test("overlapping Desktop clears keep suppressing external echoes until the last one finishes", async (t) => {
	const releases: Array<() => void> = [];
	const f = fixture(t, { clear: () => new Promise((resolve) => { releases.push(() => { clearSessionProfileBinding("session-a"); resolve({ status: "cleared" }); }); }) });
	f.bridge.wire(f.emit);
	const first = f.bridge.handle("clear_profile_binding", {});
	const second = f.bridge.handle("clear_profile_binding", {});
	await new Promise((resolve) => setImmediate(resolve));
	releases[0]!();
	await first;
	bindSessionProfile("session-a", "fast", {});
	assert.equal(f.events.length, 0, "a write while the second clear runs is not reported as external");
	releases[1]!();
	await second;
});

test("a binding written while a Desktop clear ends busy or failing is still reported as external", async (t) => {
	for (const ending of ["busy", "throws"] as const) {
		let release: () => void = () => {};
		const f = fixture(t, { clear: () => new Promise((resolve, reject) => { release = () => (ending === "busy" ? resolve({ status: "busy" }) : reject(new Error("owner failed"))); }) });
		f.bridge.wire(f.emit);
		const pending = f.bridge.handle("clear_profile_binding", {});
		await new Promise((resolve) => setImmediate(resolve));
		bindSessionProfile("session-a", `fast-${ending}`, {});
		assert.equal(f.events.length, 0, "suppressed while the clear runs");
		release();
		await pending;
		assert.deepEqual(f.events, [{ event: "profile_binding_changed", data: { kind: "explicit", profile: `fast-${ending}`, origin: "session", source: "external" } }], ending);
	}
});

test("a clear that started before a reset never lowers the new session's clear count", async (t) => {
	const releases: Array<() => void> = [];
	const f = fixture(t, { clear: () => new Promise((resolve) => { releases.push(() => resolve({ status: "unchanged" })); }) });
	f.bridge.wire(f.emit);
	const stale = f.bridge.handle("clear_profile_binding", {});
	await new Promise((resolve) => setImmediate(resolve));
	f.bridge.reset();
	f.bridge.attach({ cwd: "/x", sessionManager: { getSessionId: () => "session-a", getCwd: () => "/x" } } as unknown as ExtensionContext);
	f.bridge.wire(f.emit);
	const fresh = f.bridge.handle("clear_profile_binding", {});
	await new Promise((resolve) => setImmediate(resolve));
	releases[0]!();
	await stale;
	bindSessionProfile("session-a", "during-fresh-clear", {});
	assert.equal(f.events.length, 0, "the fresh clear still suppresses echoes");
	releases[1]!();
	await fresh;
});
