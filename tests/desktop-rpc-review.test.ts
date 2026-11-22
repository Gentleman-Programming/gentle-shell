import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_REVIEW_EVENTS,
	DESKTOP_REVIEW_METHODS,
	DESKTOP_REVIEW_SERVICE_CHANNEL,
	DESKTOP_REVIEW_SERVICE_SCHEMA,
	type DesktopReviewOwnerRead,
	type DesktopReviewOwnerStatus,
	type DesktopReviewOwnerWrite,
	type DesktopReviewService,
	type DesktopReviewSetRequest,
} from "../lib/desktop-rpc-review.ts";
import { DesktopReviewBridge, discoverDesktopReviewService } from "../lib/desktop-review-service.ts";
import { beginDesktopReviewModeSet, desktopReviewModeConfirmation, endDesktopReviewModeSet } from "../lib/desktop-rpc-review.ts";
import { NATIVE_REVIEW_ERROR_CODE, NATIVE_REVIEW_OPERATION, NativeReviewCliError, type NativeReviewCli, type NativeReviewModeRequest } from "../lib/native-review-cli.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// #3324 (odd/tasks/desktop-rpc-review-mode.md, S1-S6): Desktop reads and
// toggles the user-owned review (RDD) switch through the same native adapter
// the TUI uses, with a confirmation step, fail-closed reads, and no CLI detail
// on the wire. Nothing here runs the real gentle-ai binary: every owner below
// is a fake service or a fake native adapter.

const context = { cwd: "/repo" } as unknown as ExtensionContext;

const UNAVAILABLE = { code: "review_unavailable", message: "Review mode is not available in this session" };
const UNREADABLE = { code: "review_unavailable", message: "Review mode could not be read; nothing was changed" };
const UNCONFIRMED = { code: "review_unavailable", message: "The review mode change did not complete; re-read the mode" };
const BUSY = { code: "review_mode_busy", message: "Another review mode change is in progress" };
const INVALID_GET = { code: "invalid_request", message: "Invalid get_review_mode parameters" };
const INVALID_SET = { code: "invalid_request", message: "Invalid set_review_mode parameters" };
const UNKNOWN_MODE = { effective: "unknown", source: "unknown", scopes: { global: "unknown", clone: "unknown" } };

type Scope = "on" | "off" | "";

/** The owner's semantics: a global off wins, then a clone-local off; clone enable only clears a clone-local off. */
function evaluate(global: Scope, cloneLocal: Scope): DesktopReviewOwnerStatus {
	if (global === "off") return { global, cloneLocal, effective: "off", source: "global" };
	if (cloneLocal === "off") return { global, cloneLocal, effective: "off", source: "clone_local" };
	return { global, cloneLocal, effective: "on", source: global === "on" ? "global" : "default" };
}

function applyWrite(state: { global: Scope; cloneLocal: Scope }, request: DesktopReviewSetRequest): void {
	if (request.scope === "global") state.global = request.enabled ? "on" : "off";
	else state.cloneLocal = request.enabled ? "" : "off";
}

interface FakeOwner extends DesktopReviewService {
	state: { global: Scope; cloneLocal: Scope };
	reads: number;
	writes: DesktopReviewSetRequest[];
	disposed: number;
	nextRead?: DesktopReviewOwnerRead;
	nextWrite?: DesktopReviewOwnerWrite;
	gate?: Promise<void>;
}

function fakeOwner(global: Scope = "", cloneLocal: Scope = ""): FakeOwner {
	const owner: FakeOwner = {
		schema: DESKTOP_REVIEW_SERVICE_SCHEMA,
		state: { global, cloneLocal },
		reads: 0,
		writes: [],
		disposed: 0,
		async read() {
			owner.reads += 1;
			if (owner.nextRead) return owner.nextRead;
			return { kind: "status", status: evaluate(owner.state.global, owner.state.cloneLocal) };
		},
		async write(request) {
			owner.writes.push(request);
			if (owner.gate) await owner.gate;
			if (owner.nextWrite) return owner.nextWrite;
			applyWrite(owner.state, request);
			return { kind: "status", status: evaluate(owner.state.global, owner.state.cloneLocal) };
		},
		dispose() { owner.disposed += 1; },
	};
	return owner;
}

function bridgeWith(owner: DesktopReviewService | undefined): DesktopReviewBridge {
	const bridge = new DesktopReviewBridge({} as ExtensionAPI, { discover: async () => owner });
	bridge.attach(context);
	return bridge;
}

async function confirmToken(bridge: DesktopReviewBridge, params: Record<string, unknown>): Promise<string> {
	const outcome = await bridge.handle("set_review_mode", params);
	assert.ok(outcome && outcome.ok, JSON.stringify(outcome));
	const data = outcome.data as { status: string; confirmation: { token: string } };
	assert.equal(data.status, "confirmation_required");
	return data.confirmation.token;
}

// ---- S2: get_review_mode ----

test("get_review_mode projects the owner status onto the wire contract", async () => {
	const cases: Array<[Scope, Scope, unknown]> = [
		["", "", { effective: "enabled", source: "default", scopes: { global: "unset", clone: "unset" } }],
		["off", "", { effective: "disabled", source: "global", scopes: { global: "disabled", clone: "unset" } }],
		["on", "off", { effective: "disabled", source: "clone", scopes: { global: "enabled", clone: "disabled" } }],
		["on", "", { effective: "enabled", source: "global", scopes: { global: "enabled", clone: "unset" } }],
	];
	for (const [global, cloneLocal, expected] of cases) {
		const owner = fakeOwner(global, cloneLocal);
		assert.deepEqual(await bridgeWith(owner).handle("get_review_mode", {}), { ok: true, data: expected }, `${global}/${cloneLocal}`);
		assert.equal(owner.writes.length, 0, "a read never writes");
		assert.equal(owner.disposed, 1, "the owner service is disposed after each request");
	}
});

test("get_review_mode fails closed to unknown on a failed, timed-out, or malformed read", async () => {
	const failed = fakeOwner();
	failed.nextRead = { kind: "unknown" };
	assert.deepEqual(await bridgeWith(failed).handle("get_review_mode", {}), { ok: true, data: UNKNOWN_MODE });

	const malformed = fakeOwner();
	malformed.nextRead = { kind: "status", status: { global: "maybe", cloneLocal: "", effective: "on", source: "default" } as unknown as DesktopReviewOwnerStatus };
	assert.deepEqual(await bridgeWith(malformed).handle("get_review_mode", {}), { ok: true, data: UNKNOWN_MODE }, "an unrecognized owner value is never echoed");

	const throwing = { ...fakeOwner(), read: async () => { throw new Error("spawn C:\\Users\\me\\gentle-ai.exe ETIMEDOUT"); } } satisfies DesktopReviewService;
	const outcome = await bridgeWith(throwing).handle("get_review_mode", {});
	assert.deepEqual(outcome, { ok: true, data: UNKNOWN_MODE });
	assert.doesNotMatch(JSON.stringify(outcome), /gentle-ai|Users|ETIMEDOUT/);
});

test("get_review_mode answers review_unavailable when the owner, host, or command is missing", async () => {
	const unsupported = fakeOwner();
	unsupported.nextRead = { kind: "unavailable" };
	assert.deepEqual(await bridgeWith(unsupported).handle("get_review_mode", {}), { ok: false, error: UNAVAILABLE });
	assert.deepEqual(await bridgeWith(undefined).handle("get_review_mode", {}), { ok: false, error: UNAVAILABLE });
	const detached = new DesktopReviewBridge({} as ExtensionAPI, { discover: async () => fakeOwner() });
	assert.deepEqual(await detached.handle("get_review_mode", {}), { ok: false, error: UNAVAILABLE });
	const reset = bridgeWith(fakeOwner());
	reset.reset();
	assert.deepEqual(await reset.handle("get_review_mode", {}), { ok: false, error: UNAVAILABLE }, "a reset drops the host");
	assert.equal(await bridgeWith(fakeOwner()).handle("list_jobs", {}), undefined, "other methods fall through");
});

test("malformed params are rejected before the owner is discovered", async () => {
	let discovered = 0;
	const bridge = new DesktopReviewBridge({} as ExtensionAPI, { discover: async () => { discovered += 1; return fakeOwner(); } });
	bridge.attach(context);
	assert.deepEqual(await bridge.handle("get_review_mode", { scope: "clone" }), { ok: false, error: INVALID_GET });
	for (const params of [
		{},
		{ enabled: true },
		{ scope: "clone" },
		{ enabled: "true", scope: "clone" },
		{ enabled: true, scope: "both" },
		{ enabled: true, scope: "clone", confirmationToken: 1 },
		{ enabled: true, scope: "clone", confirmationToken: "" },
		{ enabled: true, scope: "clone", confirmationToken: "x".repeat(129) },
		{ enabled: true, scope: "clone", cwd: "/elsewhere" },
	]) {
		assert.deepEqual(await bridge.handle("set_review_mode", params), { ok: false, error: INVALID_SET }, JSON.stringify(params));
	}
	assert.equal(discovered, 0);
});

// ---- S3: confirmation, token, single flight ----

test("the first set_review_mode asks for confirmation and writes nothing", async () => {
	const owner = fakeOwner("", "off");
	const outcome = await bridgeWith(owner).handle("set_review_mode", { enabled: true, scope: "clone" });
	assert.ok(outcome?.ok);
	assert.equal(outcome.event, undefined, "a confirmation emits no event");
	const data = outcome.data as { status: string; enabled: boolean; scope: string; mode: unknown; confirmation: { title: string; message: string; token: string } };
	assert.equal(data.status, "confirmation_required");
	assert.equal(data.enabled, true);
	assert.equal(data.scope, "clone");
	assert.deepEqual(data.mode, { effective: "disabled", source: "clone", scopes: { global: "unset", clone: "disabled" } });
	assert.equal(data.confirmation.title, "Turn review mode on for this repository?");
	assert.match(data.confirmation.message, /currently off/);
	assert.match(data.confirmation.token, /^[0-9a-f]{64}$/);
	assert.deepEqual(owner.writes, []);
});

test("only a second call with the matching token applies, re-reads, and emits one event", async () => {
	const owner = fakeOwner("", "");
	const bridge = bridgeWith(owner);
	const token = await confirmToken(bridge, { enabled: false, scope: "global" });
	const readsBefore = owner.reads;
	const outcome = await bridge.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: token });
	assert.deepEqual(owner.writes, [{ enabled: false, scope: "global" }]);
	assert.ok(owner.reads > readsBefore, "the state is read before the write");
	const mode = { effective: "disabled", source: "global", scopes: { global: "disabled", clone: "unset" } };
	const previousMode = { effective: "enabled", source: "default", scopes: { global: "unset", clone: "unset" } };
	assert.deepEqual(outcome, {
		ok: true,
		data: { status: "applied", enabled: false, scope: "global", changed: true, mode },
		event: { name: "review_mode_changed", data: { mode, previousMode } },
	});
});

test("a wrong or stale token asks again with a fresh token and writes nothing", async () => {
	const owner = fakeOwner("", "");
	const bridge = bridgeWith(owner);
	const token = await confirmToken(bridge, { enabled: false, scope: "clone" });
	const wrong = await bridge.handle("set_review_mode", { enabled: false, scope: "clone", confirmationToken: "f".repeat(64) });
	assert.equal((wrong?.ok && (wrong.data as { status: string }).status), "confirmation_required");
	assert.equal((wrong?.ok && (wrong.data as { confirmation: { token: string } }).confirmation.token), token, "same state, same token");

	const otherRequest = await confirmToken(bridge, { enabled: false, scope: "global" });
	assert.notEqual(otherRequest, token, "the token binds the request");

	owner.state.global = "on"; // changed elsewhere (TUI, another process)
	const stale = await bridge.handle("set_review_mode", { enabled: false, scope: "clone", confirmationToken: token });
	assert.ok(stale?.ok);
	const data = stale.data as { status: string; confirmation: { token: string } };
	assert.equal(data.status, "confirmation_required");
	assert.notEqual(data.confirmation.token, token, "a state change yields a fresh token");
	assert.equal(stale.event, undefined);
	assert.deepEqual(owner.writes, []);
});

test("a set cannot be confirmed against an unreadable or unavailable state", async () => {
	const unknown = fakeOwner();
	unknown.nextRead = { kind: "unknown" };
	assert.deepEqual(await bridgeWith(unknown).handle("set_review_mode", { enabled: true, scope: "clone" }), { ok: false, error: UNREADABLE });
	const unsupported = fakeOwner();
	unsupported.nextRead = { kind: "unavailable" };
	assert.deepEqual(await bridgeWith(unsupported).handle("set_review_mode", { enabled: true, scope: "clone" }), { ok: false, error: UNAVAILABLE });
	assert.deepEqual(await bridgeWith(undefined).handle("set_review_mode", { enabled: true, scope: "clone" }), { ok: false, error: UNAVAILABLE });
	assert.deepEqual([...unknown.writes, ...unsupported.writes], []);
});

test("set_review_mode is single-flight: a second change answers busy while one is writing", async () => {
	const owner = fakeOwner("", "");
	const bridge = bridgeWith(owner);
	const token = await confirmToken(bridge, { enabled: false, scope: "clone" });
	let release!: () => void;
	owner.gate = new Promise((resolve) => { release = resolve; });
	const first = bridge.handle("set_review_mode", { enabled: false, scope: "clone", confirmationToken: token });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(await bridge.handle("set_review_mode", { enabled: true, scope: "global" }), { ok: false, error: BUSY });
	assert.deepEqual(await bridgeWith(fakeOwner()).handle("set_review_mode", { enabled: true, scope: "global" }), { ok: false, error: BUSY }, "the gate is process-wide");
	assert.equal((await bridge.handle("get_review_mode", {}))?.ok, true, "reads are never gated");
	release();
	const settled = await first;
	assert.equal(settled?.ok && (settled.data as { status: string }).status, "applied");
	assert.equal((await bridge.handle("set_review_mode", { enabled: true, scope: "clone" }))?.ok, true, "the gate is released after the write");
	assert.equal(owner.writes.length, 1);
});

// ---- S4 + S5: owner semantics, re-read, events ----

test("clone enable under a global off says so, applies the owner's no-op, and emits nothing", async () => {
	const owner = fakeOwner("off", "");
	const bridge = bridgeWith(owner);
	const confirm = await bridge.handle("set_review_mode", { enabled: true, scope: "clone" });
	assert.ok(confirm?.ok);
	const message = (confirm.data as { confirmation: { message: string } }).confirmation.message;
	assert.match(message, /off machine-wide/);
	assert.match(message, /cannot override/);
	assert.doesNotMatch(message, /gentle-ai|--scope|\//, "no command line or path in the dialog");
	const token = (confirm.data as { confirmation: { token: string } }).confirmation.token;
	const applied = await bridge.handle("set_review_mode", { enabled: true, scope: "clone", confirmationToken: token });
	const mode = { effective: "disabled", source: "global", scopes: { global: "disabled", clone: "unset" } };
	assert.deepEqual(applied, { ok: true, data: { status: "applied", enabled: true, scope: "clone", changed: false, mode } });
	assert.deepEqual(owner.writes, [{ enabled: true, scope: "clone" }]);
});

test("a write whose re-read changes only a scope still emits review_mode_changed", async () => {
	const owner = fakeOwner("off", "");
	const bridge = bridgeWith(owner);
	const token = await confirmToken(bridge, { enabled: false, scope: "clone" });
	const outcome = await bridge.handle("set_review_mode", { enabled: false, scope: "clone", confirmationToken: token });
	assert.ok(outcome?.ok);
	assert.equal((outcome.data as { changed: boolean }).changed, true);
	assert.equal((outcome.data as { mode: { effective: string } }).mode.effective, "disabled", "effective unchanged");
	assert.equal(outcome.event?.name, "review_mode_changed");
});

test("a failed write answers review_unavailable with no event and no owner detail", async () => {
	const failed = fakeOwner();
	const bridge = bridgeWith(failed);
	const token = await confirmToken(bridge, { enabled: false, scope: "global" });
	failed.nextWrite = { kind: "failed" };
	assert.deepEqual(await bridge.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: token }), { ok: false, error: UNCONFIRMED });

	const unsupported = fakeOwner();
	const second = bridgeWith(unsupported);
	const secondToken = await confirmToken(second, { enabled: false, scope: "global" });
	unsupported.nextWrite = { kind: "unavailable" };
	assert.deepEqual(await second.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: secondToken }), { ok: false, error: UNAVAILABLE });

	const throwing = fakeOwner();
	const third = bridgeWith(throwing);
	const thirdToken = await confirmToken(third, { enabled: false, scope: "global" });
	throwing.write = async () => { throw new Error("gentle-ai review mode disable --scope global --cwd /home/me/repo exited 1"); };
	const outcome = await third.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: thirdToken });
	assert.deepEqual(outcome, { ok: false, error: UNCONFIRMED });
	assert.doesNotMatch(JSON.stringify(outcome), /gentle-ai|--scope|home/);
});

test("an unreadable re-read after a write answers unknown with no event", async () => {
	const owner = fakeOwner();
	const bridge = bridgeWith(owner);
	const token = await confirmToken(bridge, { enabled: false, scope: "global" });
	owner.nextWrite = { kind: "unknown" };
	assert.deepEqual(await bridge.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: token }), {
		ok: true,
		data: { status: "applied", enabled: false, scope: "global", changed: false, mode: UNKNOWN_MODE },
	});
});

test("discovery accepts only a schema-shaped owner", async () => {
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	const pi = {
		events: {
			on(channel: string, listener: (payload: unknown) => void) { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); },
			emit(channel: string, payload: unknown) { for (const listener of listeners.get(channel) ?? []) listener(payload); },
		},
	} as unknown as ExtensionAPI;
	assert.equal(await discoverDesktopReviewService(pi, context), undefined, "no owner times out");
	const owner = fakeOwner();
	pi.events.on(DESKTOP_REVIEW_SERVICE_CHANNEL, (payload) => {
		const request = payload as { context: unknown; respond(value: unknown): void };
		assert.equal(request.context, context);
		request.respond({ schema: "other/v1", read: owner.read, write: owner.write, dispose: owner.dispose });
		request.respond({ schema: DESKTOP_REVIEW_SERVICE_SCHEMA, read: owner.read, dispose: owner.dispose });
		request.respond(owner);
	});
	assert.equal(await discoverDesktopReviewService(pi, context), owner);
});

// ---- Transport: capabilities, ordering, owner absence ----

function interactiveHost(t: test.TestContext): void {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
}

function desktopHarness(t: test.TestContext, owner?: DesktopReviewService) {
	interactiveHost(t);
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { handlers.set(name, handler); },
		events: {
			on(channel: string, listener: (payload: unknown) => void) { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); },
			emit(channel: string, payload: unknown) { for (const listener of listeners.get(channel) ?? []) listener(payload); },
		},
	} as unknown as ExtensionAPI;
	if (owner) pi.events.on(DESKTOP_REVIEW_SERVICE_CHANNEL, (payload) => (payload as { respond(value: unknown): void }).respond(owner));
	desktopRpc(pi);
	const lines: any[] = [];
	const ctx = { mode: "rpc", cwd: "/repo", ui: { setWidget(key: string, widget: string[]) { assert.equal(key, DESKTOP_RPC_WIDGET); lines.push(JSON.parse(widget[0]!)); } } };
	handlers.get("session_start")?.({}, ctx);
	let next = 0;
	const invoke = async (method: string, params: Record<string, unknown> = {}) => {
		next += 1;
		await commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: `review-${next}`, method, params }), ctx);
	};
	return { lines, invoke };
}

test("the Desktop transport advertises the review methods and event", async (t) => {
	const app = desktopHarness(t);
	await app.invoke("capabilities");
	const data = app.lines[0]!.data;
	assert.deepEqual(DESKTOP_REVIEW_METHODS, ["get_review_mode", "set_review_mode"]);
	assert.deepEqual(DESKTOP_REVIEW_EVENTS, ["review_mode_changed"]);
	const at = data.methods.indexOf("get_review_mode");
	assert.notEqual(at, -1);
	assert.deepEqual(data.methods.slice(at, at + 2), ["get_review_mode", "set_review_mode"]);
	assert.deepEqual(data.events.slice(-2), ["review_mode_changed", "profile_binding_changed"]);
});

test("get_review_mode answers review_unavailable through the transport without an owner extension", async (t) => {
	const app = desktopHarness(t);
	await app.invoke("get_review_mode");
	assert.equal(app.lines.length, 1);
	assert.deepEqual({ ok: app.lines[0]!.ok, error: app.lines[0]!.error }, { ok: false, error: UNAVAILABLE });
});

test("a confirmed change publishes its response before one review_mode_changed event; reads and no-ops emit nothing", async (t) => {
	const owner = fakeOwner("", "");
	const app = desktopHarness(t, owner);
	await app.invoke("get_review_mode");
	await app.invoke("set_review_mode", { enabled: false, scope: "clone" });
	const token = app.lines[1]!.data.confirmation.token;
	assert.equal(app.lines.length, 2, "a read and a confirmation emit no event");
	await app.invoke("set_review_mode", { enabled: false, scope: "clone", confirmationToken: token });
	assert.equal(app.lines.length, 4);
	assert.equal(app.lines[2]!.kind, "response");
	assert.equal(app.lines[2]!.requestId, "review-3");
	assert.equal(app.lines[2]!.data.changed, true);
	assert.equal(app.lines[3]!.kind, "event");
	assert.equal(app.lines[3]!.event, "review_mode_changed");
	assert.deepEqual(app.lines[3]!.data.mode, app.lines[2]!.data.mode);

	await app.invoke("set_review_mode", { enabled: false, scope: "clone" });
	const again = app.lines[4]!.data.confirmation.token;
	await app.invoke("set_review_mode", { enabled: false, scope: "clone", confirmationToken: again });
	assert.equal(app.lines.length, 6, "a confirmed no-op emits no event");
	assert.equal(app.lines[5]!.data.changed, false);
});

// ---- The real owner: extensions/gentle-ai.ts over a fake native adapter ----

function fakeNativeReviewCli(global: Scope = "", cloneLocal: Scope = "") {
	const state = { global, cloneLocal };
	const calls: Array<Omit<NativeReviewModeRequest, "signal">> = [];
	const fake = {
		state,
		calls,
		failWith: undefined as unknown,
		hang: false,
		cli: {
			async reviewMode(request: NativeReviewModeRequest) {
				calls.push({ cwd: request.cwd, operation: request.operation, ...(request.scope === undefined ? {} : { scope: request.scope }) });
				if (fake.hang) return await new Promise<never>(() => {});
				if (fake.failWith !== undefined) throw fake.failWith;
				if (request.operation !== "status") applyWrite(state, { enabled: request.operation === "enable", scope: request.scope ?? "clone" });
				return { operation: request.operation, scope: request.scope ?? "clone", status: evaluate(state.global, state.cloneLocal) };
			},
		} as unknown as NativeReviewCli,
	};
	return fake;
}

async function realOwner(t: test.TestContext, native: ReturnType<typeof fakeNativeReviewCli> | null, env: NodeJS.ProcessEnv = {}) {
	const configHome = mkdtempSync(join(tmpdir(), "desktop-rpc-review-config-"));
	const previousConfig = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	t.after(() => {
		if (previousConfig === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfig;
		rmSync(configHome, { recursive: true, force: true });
	});
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	const pi = {
		on() {},
		registerCommand() {},
		registerTool() {},
		events: {
			on(channel: string, listener: (payload: unknown) => void) { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); return () => {}; },
			emit(channel: string, payload: unknown) { for (const listener of listeners.get(channel) ?? []) listener(payload); },
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: native?.cli ?? null, processEnv: { GENTLE_AI_TELEMETRY: "0", ...env } })(pi);
	const ctx = { cwd: "/fixture/repo", hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => "desktop-review", getCwd: () => "/fixture/repo" }, ui: { notify() {} } } as unknown as ExtensionContext;
	const bridge = new DesktopReviewBridge(pi);
	bridge.attach(ctx);
	return { pi, ctx, bridge };
}

test("the real owner reads through the native reviewMode STATUS and writes the requested scope, then re-reads", async (t) => {
	const native = fakeNativeReviewCli("", "");
	const { bridge } = await realOwner(t, native);
	assert.deepEqual(await bridge.handle("get_review_mode", {}), { ok: true, data: { effective: "enabled", source: "default", scopes: { global: "unset", clone: "unset" } } });
	assert.deepEqual(native.calls, [{ cwd: "/fixture/repo", operation: "status" }]);

	const token = await confirmToken(bridge, { enabled: false, scope: "global" });
	native.calls.length = 0;
	const outcome = await bridge.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: token });
	assert.deepEqual(native.calls, [
		{ cwd: "/fixture/repo", operation: "status" },
		{ cwd: "/fixture/repo", operation: "disable", scope: "global" },
		{ cwd: "/fixture/repo", operation: "status" },
	], "read, write, then re-read after the write");
	assert.ok(outcome?.ok);
	assert.deepEqual((outcome.data as { mode: unknown }).mode, { effective: "disabled", source: "global", scopes: { global: "disabled", clone: "unset" } });
	assert.equal(outcome.event?.name, "review_mode_changed");

	const cloneToken = await confirmToken(bridge, { enabled: true, scope: "clone" });
	native.calls.length = 0;
	const clone = await bridge.handle("set_review_mode", { enabled: true, scope: "clone", confirmationToken: cloneToken });
	assert.deepEqual(native.calls[1], { cwd: "/fixture/repo", operation: "enable", scope: "clone" });
	assert.ok(clone?.ok);
	assert.equal((clone.data as { changed: boolean }).changed, false, "clone enable cannot override the global off");
	assert.equal(clone.event, undefined);
});

test("the real owner answers review_unavailable without a native adapter or with an unsupported command", async (t) => {
	const missing = await realOwner(t, null);
	assert.deepEqual(await missing.bridge.handle("get_review_mode", {}), { ok: false, error: UNAVAILABLE });

	for (const code of [NATIVE_REVIEW_ERROR_CODE.UNAVAILABLE, NATIVE_REVIEW_ERROR_CODE.VERSION_INCOMPATIBLE, NATIVE_REVIEW_ERROR_CODE.PACKAGE_BINARY_MISSING]) {
		const native = fakeNativeReviewCli();
		native.failWith = new NativeReviewCliError(code, NATIVE_REVIEW_OPERATION.MODE, false, false, "native process could not start at C:\\tools\\gentle-ai.exe");
		const { bridge } = await realOwner(t, native);
		const outcome = await bridge.handle("get_review_mode", {});
		assert.deepEqual(outcome, { ok: false, error: UNAVAILABLE }, code);
		assert.doesNotMatch(JSON.stringify(outcome), /gentle-ai|tools/);
	}
});

test("the real owner fails closed to unknown on a native failure or timeout", async (t) => {
	const failing = fakeNativeReviewCli();
	failing.failWith = new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, NATIVE_REVIEW_OPERATION.MODE, true, false, "gentle-ai exited 1: /home/me/.config");
	const first = await realOwner(t, failing);
	const outcome = await first.bridge.handle("get_review_mode", {});
	assert.deepEqual(outcome, { ok: true, data: UNKNOWN_MODE });
	assert.doesNotMatch(JSON.stringify(outcome), /gentle-ai|home/);

	const hanging = fakeNativeReviewCli();
	hanging.hang = true;
	const second = await realOwner(t, hanging, { GENTLE_PI_RDD_STATUS_TIMEOUT_MS: "30" });
	const started = Date.now();
	assert.deepEqual(await second.bridge.handle("get_review_mode", {}), { ok: true, data: UNKNOWN_MODE });
	assert.ok(Date.now() - started < 2000, "the read is bounded by the status timeout");
});

test("a subagent child never answers the review owner seam", async (t) => {
	const native = fakeNativeReviewCli();
	const { pi, ctx } = await realOwner(t, native, { GENTLE_PI_AGENTS_CHILD: "1" });
	assert.equal(await discoverDesktopReviewService(pi, ctx), undefined);
	assert.deepEqual(native.calls, []);
});

// ---- Independent verifier probes (P1-P9), kept as regressions ----

type S = { global: "on" | "off" | ""; cloneLocal: "on" | "off" | ""; effective: "on" | "off"; source: "default" | "global" | "clone_local"; revision?: string };

function probeOwner(initial: S, opts: { writeGate?: Promise<void>; throwOn?: "read" | "write" } = {}) {
	let state = { ...initial };
	const writes: unknown[] = [];
	const service = {
		schema: DESKTOP_REVIEW_SERVICE_SCHEMA,
		async read() { if (opts.throwOn === "read") throw new Error("C:\\secret\\path gentle-ai review mode status --json"); return { kind: "status" as const, status: { ...state } }; },
		async write(req: { enabled: boolean; scope: "clone" | "global" }) {
			writes.push(req);
			if (opts.writeGate) await opts.writeGate;
			if (opts.throwOn === "write") throw new Error("C:\\secret\\path boom");
			if (req.scope === "global") state.global = req.enabled ? "on" : "off";
			else state.cloneLocal = req.enabled ? "" : "off";
			const eff = state.global === "off" || state.cloneLocal === "off" ? "off" : "on";
			state.effective = eff;
			state.source = state.cloneLocal === "off" ? "clone_local" : state.global !== "" ? "global" : "default";
			return { kind: "status" as const, status: { ...state } };
		},
		dispose() {},
		set(next: S) { state = { ...next }; },
	};
	return { service, writes };
}

function probeBridge(service: unknown) {
	const b = new DesktopReviewBridge({} as never, { discover: async () => service as never });
	b.attach({ cwd: "x" } as never);
	return b;
}

const ON: S = { global: "", cloneLocal: "", effective: "on", source: "default" };

test("P1 token for a different request (enabled or scope) never writes", async () => {
	const { service, writes } = probeOwner(ON);
	const b = probeBridge(service);
	const tokFalseClone = desktopReviewModeConfirmation({ enabled: false, scope: "clone" }, ON).token;
	for (const params of [{ enabled: true, scope: "clone" }, { enabled: false, scope: "global" }, { enabled: true, scope: "global" }]) {
		const r = await b.handle("set_review_mode", { ...params, confirmationToken: tokFalseClone }) as any;
		assert.equal(r.ok, true); assert.equal(r.data.status, "confirmation_required");
	}
	assert.equal(writes.length, 0);
});

test("P2 replay after apply is stale and never writes again", async () => {
	const { service, writes } = probeOwner(ON);
	const b = probeBridge(service);
	const first = await b.handle("set_review_mode", { enabled: false, scope: "global" }) as any;
	const token = first.data.confirmation.token;
	const applied = await b.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: token }) as any;
	assert.equal(applied.data.status, "applied"); assert.equal(applied.data.changed, true); assert.ok(applied.event);
	const replay = await b.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: token }) as any;
	assert.equal(replay.data.status, "confirmation_required");
	assert.equal(writes.length, 1);
});

test("P3 stale token after an out-of-band revision change never writes", async () => {
	const st: S = { ...ON, revision: "r1" };
	const { service, writes } = probeOwner(st);
	const b = probeBridge(service);
	const token = ((await b.handle("set_review_mode", { enabled: false, scope: "clone" })) as any).data.confirmation.token;
	service.set({ ...st, revision: "r2" });
	const r = await b.handle("set_review_mode", { enabled: false, scope: "clone", confirmationToken: token }) as any;
	assert.equal(r.data.status, "confirmation_required"); assert.notEqual(r.data.confirmation.token, token);
	assert.equal(writes.length, 0);
});

test("P4 two concurrent confirmed sets: second is busy, gate frees after", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	const { service, writes } = probeOwner(ON, { writeGate: gate });
	const b = probeBridge(service);
	const token = desktopReviewModeConfirmation({ enabled: false, scope: "global" }, ON).token;
	const p1 = b.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: token });
	await new Promise((r) => setTimeout(r, 10));
	const second = await b.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: token }) as any;
	assert.equal(second.ok, false); assert.equal(second.error.code, "review_mode_busy");
	// get is not gated
	const g = await b.handle("get_review_mode", {}) as any; assert.equal(g.ok, true);
	release(); await p1;
	assert.equal(writes.length, 1);
	assert.equal(beginDesktopReviewModeSet(), true); endDesktopReviewModeSet();
});

test("P5 gate released on read throw, write throw, and discover throw; no detail on wire", async () => {
	for (const throwOn of ["read", "write"] as const) {
		const { service } = probeOwner(ON, { throwOn });
		const b = probeBridge(service);
		const token = desktopReviewModeConfirmation({ enabled: false, scope: "clone" }, ON).token;
		const r = await b.handle("set_review_mode", { enabled: false, scope: "clone", confirmationToken: token }) as any;
		assert.equal(r.ok, false); assert.equal(r.error.code, "review_unavailable");
		assert.doesNotMatch(JSON.stringify(r), /secret|gentle-ai|boom/);
		assert.equal(beginDesktopReviewModeSet(), true); endDesktopReviewModeSet();
	}
	const b = new DesktopReviewBridge({} as never, { discover: async () => { throw new Error("x"); } });
	b.attach({ cwd: "x" } as never);
	const r = await b.handle("set_review_mode", { enabled: true, scope: "clone" }) as any;
	assert.equal(r.error.code, "review_unavailable");
	assert.equal(beginDesktopReviewModeSet(), true); endDesktopReviewModeSet();
});

test("P6 read throw on get -> effective unknown, no detail", async () => {
	const { service } = probeOwner(ON, { throwOn: "read" });
	const r = await probeBridge(service).handle("get_review_mode", {}) as any;
	assert.equal(r.data.effective, "unknown"); assert.doesNotMatch(JSON.stringify(r), /secret|gentle-ai/);
});

test("P7 reset during a pending discover returns unavailable and never writes", async () => {
	const { service, writes } = probeOwner(ON);
	let resolveDiscover!: (v: unknown) => void;
	const b = new DesktopReviewBridge({} as never, { discover: () => new Promise((r) => { resolveDiscover = r; }) as never });
	b.attach({ cwd: "x" } as never);
	const token = desktopReviewModeConfirmation({ enabled: false, scope: "global" }, ON).token;
	const p = b.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: token });
	await new Promise((r) => setTimeout(r, 5));
	b.reset();
	resolveDiscover(service);
	const r = await p as any;
	assert.equal(r.error.code, "review_unavailable"); assert.equal(writes.length, 0);
});

test("P8 a reset during the pending pre-write read never writes and emits nothing", async () => {
	let releaseRead!: () => void;
	const readGate = new Promise<void>((r) => { releaseRead = r; });
	const { service, writes } = probeOwner(ON);
	const origRead = service.read;
	service.read = async () => { await readGate; return origRead(); };
	const b = probeBridge(service);
	const token = desktopReviewModeConfirmation({ enabled: false, scope: "global" }, ON).token;
	const p = b.handle("set_review_mode", { enabled: false, scope: "global", confirmationToken: token });
	await new Promise((r) => setTimeout(r, 5));
	b.reset(); releaseRead();
	const r = await p as any;
	assert.equal(writes.length, 0, "a superseded session never writes the switch");
	assert.equal(r?.event, undefined, "no event follows a stale outcome");
	assert.deepEqual(r, { ok: false, error: UNAVAILABLE });
	assert.equal(beginDesktopReviewModeSet(), true, "the gate is released"); endDesktopReviewModeSet();
});

test("P9 clone enable under global off: applied, changed false, no event", async () => {
	const st: S = { global: "off", cloneLocal: "", effective: "off", source: "global" };
	const { service } = probeOwner(st);
	const b = probeBridge(service);
	const c = await b.handle("set_review_mode", { enabled: true, scope: "clone" }) as any;
	assert.match(c.data.confirmation.message, /cannot override/);
	const r = await b.handle("set_review_mode", { enabled: true, scope: "clone", confirmationToken: c.data.confirmation.token }) as any;
	assert.equal(r.data.changed, false); assert.equal(r.event, undefined); assert.equal(r.data.mode.effective, "disabled");
});
