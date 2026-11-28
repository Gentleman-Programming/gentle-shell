import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";
import { DESKTOP_RPC_SCHEMA, DesktopRpcRouter } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_TELEMETRY_EVENTS,
	DESKTOP_TELEMETRY_METHODS,
	INVALID_TELEMETRY_PARAMS,
	TELEMETRY_BINARY_MISSING,
	TELEMETRY_COMMAND_FAILED,
	TELEMETRY_OUTPUT_INVALID,
	TELEMETRY_POLICY_UNSUPPORTED,
	TELEMETRY_TIMEOUT,
	deriveTelemetryToggle,
} from "../lib/desktop-rpc-telemetry.ts";
import { DesktopTelemetryBridge } from "../lib/desktop-telemetry-service.ts";
import type { ExecFileRequest, ExecFileResult } from "../lib/native-review-cli.ts";

// get_telemetry / set_telemetry (gentle-shell#3586). The tests drive the real
// Desktop router with the bridge as its domain and a fake gentle-ai that
// models the binary's own policy decision (state file, first-run notice, env
// locks), counting every invocation.

const SECRET_INSTALL_ID = "11111111-2222-3333-4444-555555555555";
const SECRET_ENDPOINT = "https://telemetry.example.invalid/v1/events";

interface FakeState {
	/** undefined = the state file does not exist. */
	enabled?: boolean;
	noticeShown: boolean;
	/** An environment lock (DO_NOT_TRACK, GENTLE_AI_TELEMETRY, CI) wins over the state. */
	lock?: string;
}

function result(partial: Partial<ExecFileResult> = {}): ExecFileResult {
	return { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false, ...partial };
}

function policyOf(state: FakeState): Record<string, unknown> {
	if (state.lock !== undefined) return { enabled: false, source: state.lock, reason: "disabled" };
	if (state.enabled === undefined) return { enabled: false, source: "state", reason: "state_unavailable" };
	if (!state.enabled) return { enabled: false, source: "state", reason: "disabled" };
	if (!state.noticeShown) return { enabled: false, source: "default", reason: "enrollment_pending" };
	return { enabled: true, source: "state", reason: "enabled" };
}

type Override = (args: readonly string[]) => ExecFileResult | undefined;

function fakeGentleAi(state: FakeState, override: Override = () => undefined) {
	const calls: Array<{ args: readonly string[]; request: ExecFileRequest }> = [];
	const exec = async (request: ExecFileRequest): Promise<ExecFileResult> => {
		calls.push({ args: request.arguments, request });
		const custom = override(request.arguments);
		if (custom !== undefined) return custom;
		const [group, verb] = request.arguments;
		assert.equal(group, "telemetry");
		if (verb === "policy") return result({ stdout: `${JSON.stringify(policyOf(state))}\n` });
		if (verb === "enable" || verb === "disable") {
			state.enabled = verb === "enable";
			// Real gentle-ai prints identifiers here; the bridge must drop them.
			return result({ stdout: JSON.stringify({ enabled: state.enabled, install_id: SECRET_INSTALL_ID, endpoint: SECRET_ENDPOINT }) });
		}
		if (verb === "status") {
			// `status` creates the state file as a side effect.
			state.enabled ??= false;
			return result({ stdout: "{}" });
		}
		return result({ exitCode: 2, stderr: `unknown telemetry command ${verb}` });
	};
	return { exec, calls, verbs: () => calls.map((call) => call.args.join(" ")) };
}

function harness(exec: (request: ExecFileRequest) => Promise<ExecFileResult>, options: { resolveBinary?: () => string } = {}) {
	const bridge = new DesktopTelemetryBridge({ exec, resolveBinary: options.resolveBinary ?? (() => "/fake/gentle-ai") });
	const lines: any[] = [];
	const router = new DesktopRpcRouter(["capabilities", "get_snapshot", ...DESKTOP_TELEMETRY_METHODS], [], () => ({}), (method, params) => bridge.handle(method, params));
	router.start((line) => lines.push(JSON.parse(line)));
	let n = 0;
	return {
		lines,
		async call(method: string, params: Record<string, unknown> = {}) {
			const requestId = `req-${++n}`;
			await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }));
			const response = lines.find((line) => line.requestId === requestId);
			assert.ok(response, "exactly one response");
			return response;
		},
	};
}

function expectOk(response: any, data: Record<string, unknown>): void {
	assert.equal(response.ok, true);
	assert.deepEqual(response.data, data);
}

function expectError(response: any, error: { code: string; message: string }): void {
	assert.equal(response.ok, false);
	assert.deepEqual(response.error, error);
	assert.equal(response.data, undefined);
}

// ---- Capabilities ----

test("the methods are advertised, and the event only where a watcher backs it", async () => {
	assert.deepEqual([...DESKTOP_TELEMETRY_METHODS], ["get_telemetry", "set_telemetry"]);
	assert.deepEqual([...DESKTOP_TELEMETRY_EVENTS], ["telemetry_changed"]);
	// The bare router below is given no events: nothing backs telemetry_changed there.
	const app = harness(fakeGentleAi({ noticeShown: false }).exec);
	const response = await app.call("capabilities");
	assert.ok(response.data.methods.includes("get_telemetry"));
	assert.ok(response.data.methods.includes("set_telemetry"));
	assert.ok(!response.data.events.includes("telemetry_changed"));
});

// ---- S2 table, one case per row ----

const ROWS: Array<{ name: string; state: FakeState; policy: Record<string, unknown>; toggle: string; locked: boolean }> = [
	{ name: "enabled", state: { enabled: true, noticeShown: true }, policy: { enabled: true, source: "state", reason: "enabled" }, toggle: "on", locked: false },
	{ name: "enrollment_pending", state: { enabled: true, noticeShown: false }, policy: { enabled: false, source: "default", reason: "enrollment_pending" }, toggle: "on", locked: false },
	{ name: "disabled by the user's own state", state: { enabled: false, noticeShown: true }, policy: { enabled: false, source: "state", reason: "disabled" }, toggle: "off", locked: false },
	{ name: "disabled by DO_NOT_TRACK", state: { enabled: true, noticeShown: true, lock: "DO_NOT_TRACK" }, policy: { enabled: false, source: "DO_NOT_TRACK", reason: "disabled" }, toggle: "off", locked: true },
	{ name: "disabled by GENTLE_AI_TELEMETRY", state: { enabled: true, noticeShown: true, lock: "GENTLE_AI_TELEMETRY" }, policy: { enabled: false, source: "GENTLE_AI_TELEMETRY", reason: "disabled" }, toggle: "off", locked: true },
	{ name: "disabled by CI", state: { noticeShown: false, lock: "CI" }, policy: { enabled: false, source: "CI", reason: "disabled" }, toggle: "off", locked: true },
	{ name: "state_unavailable (missing state file)", state: { noticeShown: false }, policy: { enabled: false, source: "state", reason: "state_unavailable" }, toggle: "unset", locked: false },
];

for (const row of ROWS) {
	test(`get_telemetry: ${row.name} -> toggle ${row.toggle}, locked ${row.locked}`, async () => {
		const fake = fakeGentleAi(row.state);
		const app = harness(fake.exec);
		expectOk(await app.call("get_telemetry"), { ...row.policy, toggle: row.toggle, locked: row.locked });
		assert.deepEqual(fake.verbs(), ["telemetry policy --json"], "reads run policy --json only");
		assert.equal(fake.calls[0]!.request.timeoutMs, 5_000);
	});
}

test("the derivation never keys on source alone", () => {
	assert.deepEqual(deriveTelemetryToggle({ reason: "state_unavailable", source: "state" }), { toggle: "unset", locked: false });
	assert.deepEqual(deriveTelemetryToggle({ reason: "disabled", source: "state" }), { toggle: "off", locked: false });
	assert.deepEqual(deriveTelemetryToggle({ reason: "enabled", source: "CI" }), { toggle: "on", locked: false });
	assert.equal(deriveTelemetryToggle({ reason: "disabled", source: "something_new" }), undefined);
	assert.equal(deriveTelemetryToggle({ reason: "something_new", source: "state" }), undefined);
});

test("get_telemetry passes the policy fields through unchanged", async () => {
	const stdout = JSON.stringify({ enabled: true, source: "state", reason: "enabled", extra: { a: 1 } });
	const app = harness(fakeGentleAi({ noticeShown: true }, () => result({ stdout })).exec);
	expectOk(await app.call("get_telemetry"), { enabled: true, source: "state", reason: "enabled", extra: { a: 1 }, toggle: "on", locked: false });
});

// ---- set_telemetry ----

test("set_telemetry enable on a fresh install answers on + enrollment_pending and never touches the notice", async () => {
	const state: FakeState = { noticeShown: false };
	const fake = fakeGentleAi(state);
	const app = harness(fake.exec);
	expectOk(await app.call("set_telemetry", { enabled: true }), { enabled: false, source: "default", reason: "enrollment_pending", toggle: "on", locked: false });
	assert.deepEqual(fake.verbs(), ["telemetry enable --json", "telemetry policy --json"]);
	assert.equal(state.noticeShown, false);
});

test("set_telemetry disable writes the preference and answers the re-read policy", async () => {
	const state: FakeState = { enabled: true, noticeShown: true };
	const fake = fakeGentleAi(state);
	const app = harness(fake.exec);
	expectOk(await app.call("set_telemetry", { enabled: false }), { enabled: false, source: "state", reason: "disabled", toggle: "off", locked: false });
	assert.deepEqual(fake.verbs(), ["telemetry disable --json", "telemetry policy --json"]);
	assert.equal(state.enabled, false);
});

test("set_telemetry on an unset install can enable and then disable", async () => {
	const app = harness(fakeGentleAi({ noticeShown: true }).exec);
	assert.equal((await app.call("get_telemetry")).data.toggle, "unset");
	assert.equal((await app.call("set_telemetry", { enabled: true })).data.toggle, "on");
	assert.equal((await app.call("set_telemetry", { enabled: false })).data.toggle, "off");
});

test("set_telemetry while locked still writes the preference and returns the locked policy", async () => {
	const state: FakeState = { enabled: false, noticeShown: true, lock: "DO_NOT_TRACK" };
	const fake = fakeGentleAi(state);
	const app = harness(fake.exec);
	expectOk(await app.call("set_telemetry", { enabled: true }), { enabled: false, source: "DO_NOT_TRACK", reason: "disabled", toggle: "off", locked: true });
	assert.deepEqual(fake.verbs(), ["telemetry enable --json", "telemetry policy --json"]);
	assert.equal(state.enabled, true, "the preference was written");
});

test("install_id and endpoint never reach the wire, and status is never invoked", async () => {
	const fake = fakeGentleAi({ noticeShown: false });
	const app = harness(fake.exec);
	await app.call("get_telemetry");
	await app.call("set_telemetry", { enabled: true });
	await app.call("set_telemetry", { enabled: false });
	const wire = JSON.stringify(app.lines);
	assert.ok(!wire.includes(SECRET_INSTALL_ID));
	assert.ok(!wire.includes(SECRET_ENDPOINT));
	assert.ok(!wire.includes("install_id"));
	assert.ok(!wire.includes("endpoint"));
	assert.ok(fake.calls.every((call) => call.args[1] !== "status"), "status is never run");
});

// ---- Parameters ----

test("invalid params are refused before gentle-ai runs", async () => {
	const fake = fakeGentleAi({ noticeShown: false });
	const app = harness(fake.exec);
	for (const params of [{}, { enabled: "yes" }, { enabled: 1 }, { enabled: true, extra: 1 }, { other: true }]) {
		expectError(await app.call("set_telemetry", params), INVALID_TELEMETRY_PARAMS);
	}
	expectError(await app.call("get_telemetry", { enabled: true }), INVALID_TELEMETRY_PARAMS);
	assert.equal(fake.calls.length, 0);
});

// ---- Typed errors ----

test("a missing binary is telemetry_binary_missing (resolver throws, or ENOENT)", async () => {
	const fake = fakeGentleAi({ noticeShown: false });
	const unresolved = harness(fake.exec, { resolveBinary: () => { throw new Error("C:\\secret\\path is missing"); } });
	expectError(await unresolved.call("get_telemetry"), TELEMETRY_BINARY_MISSING);
	expectError(await unresolved.call("set_telemetry", { enabled: true }), TELEMETRY_BINARY_MISSING);
	assert.equal(fake.calls.length, 0);
	const enoent = harness(async () => { throw Object.assign(new Error("spawn C:\\secret ENOENT"), { code: "ENOENT" }); });
	expectError(await enoent.call("get_telemetry"), TELEMETRY_BINARY_MISSING);
});

test("a timeout is telemetry_timeout, on a read and on the write", async () => {
	const app = harness(fakeGentleAi({ noticeShown: false }, () => result({ timedOut: true, exitCode: 1 })).exec);
	expectError(await app.call("get_telemetry"), TELEMETRY_TIMEOUT);
	expectError(await app.call("set_telemetry", { enabled: false }), TELEMETRY_TIMEOUT);
});

test("a non-zero exit is telemetry_command_failed and never carries the process output", async () => {
	const app = harness(fakeGentleAi({ noticeShown: false }, () => result({ exitCode: 1, stderr: `boom ${SECRET_ENDPOINT} C:\\secret` })).exec);
	expectError(await app.call("get_telemetry"), TELEMETRY_COMMAND_FAILED);
	expectError(await app.call("set_telemetry", { enabled: true }), TELEMETRY_COMMAND_FAILED);
	assert.ok(!JSON.stringify(app.lines).includes("secret"));
});

test("a failed write does not re-read or answer a policy", async () => {
	const fake = fakeGentleAi({ noticeShown: false }, (args) => (args[1] === "enable" ? result({ exitCode: 1 }) : undefined));
	const app = harness(fake.exec);
	expectError(await app.call("set_telemetry", { enabled: true }), TELEMETRY_COMMAND_FAILED);
	assert.deepEqual(fake.verbs(), ["telemetry enable --json"]);
});

test("unparseable policy output is telemetry_output_invalid, never a fabricated policy", async () => {
	const outputs = [
		"not json",
		"[]",
		"null",
		"{}",
		"",
		JSON.stringify({ enabled: "yes", source: "state", reason: "enabled" }),
		JSON.stringify({ enabled: false, source: "state", reason: "brand_new_reason" }),
		JSON.stringify({ enabled: false, source: "elsewhere", reason: "disabled" }),
	];
	for (const stdout of outputs) {
		const app = harness(fakeGentleAi({ noticeShown: false }, () => result({ stdout })).exec);
		expectError(await app.call("get_telemetry"), TELEMETRY_OUTPUT_INVALID);
	}
	const exceeded = harness(fakeGentleAi({ noticeShown: false }, () => result({ outputLimitExceeded: true })).exec);
	expectError(await exceeded.call("get_telemetry"), TELEMETRY_OUTPUT_INVALID);
});

test("an older gentle-ai without `telemetry policy` is telemetry_policy_unsupported", async () => {
	const old: Override = (args) => (args[1] === "policy" ? result({ exitCode: 2, stderr: "unknown telemetry command policy\n" }) : undefined);
	const app = harness(fakeGentleAi({ noticeShown: false }, old).exec);
	expectError(await app.call("get_telemetry"), TELEMETRY_POLICY_UNSUPPORTED);
	expectError(await app.call("set_telemetry", { enabled: true }), TELEMETRY_POLICY_UNSUPPORTED);
});

// ---- Transport wiring ----

test("the Desktop transport advertises get_telemetry and set_telemetry, telemetry_changed only when its watcher is wired, and answers through gentle:desktop", async (t) => {
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
	const fake = fakeGentleAi({ noticeShown: false });
	// The watch seam refuses: the event must not be advertised without a watcher.
	desktopRpc(pi, { telemetryExec: fake.exec, telemetryResolveBinary: () => "/fake/gentle-ai", watch: () => { throw new Error("cannot watch"); } });
	const widgets: string[] = [];
	const ctx = {
		mode: "rpc",
		cwd: "/home/devel/project",
		sessionManager: { getCwd: () => "/home/devel/project", getSessionId: () => "session-a", getEntries: () => [] },
		ui: { setWidget(_key: string, lines: string[]) { widgets.push(...lines); } },
	};
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	const invoke = (requestId: string, method: string, params: Record<string, unknown> = {}) =>
		commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }), ctx);
	await invoke("cap", "capabilities");
	await invoke("set", "set_telemetry", { enabled: true });
	await invoke("get", "get_telemetry");
	const responses = widgets.map((line) => JSON.parse(line));
	const caps = responses.find((response) => response.requestId === "cap");
	assert.equal(caps.data.methods.filter((method: string) => method === "get_telemetry").length, 1);
	assert.equal(caps.data.methods.filter((method: string) => method === "set_telemetry").length, 1);
	assert.ok(!caps.data.events.includes("telemetry_changed"));
	const expected = { enabled: false, source: "default", reason: "enrollment_pending", toggle: "on", locked: false };
	assert.deepEqual(responses.find((response) => response.requestId === "set").data, expected);
	assert.deepEqual(responses.find((response) => response.requestId === "get").data, expected);
});

// ---- telemetry_changed (S7) ----

/** Manual timers: nothing fires until the test advances them. */
function manualTimers() {
	let now = 0;
	let next = 0;
	const pending = new Map<number, { at: number; fn: () => void }>();
	return {
		timers: {
			set(fn: () => void, ms: number) { const id = ++next; pending.set(id, { at: now + ms, fn }); return id; },
			clear(handle: unknown) { pending.delete(handle as number); },
		},
		open: () => pending.size,
		async advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...pending]) {
				if (timer.at > now) continue;
				pending.delete(id);
				timer.fn();
			}
			// Let the re-read the timer started settle.
			for (let i = 0; i < 20; i += 1) await Promise.resolve();
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

/** A watch seam that records every watched directory and lets a test fire changes. */
function fakeWatch(fails: boolean) {
	const watched = new Map<string, Array<(filename: string | undefined, removed?: boolean) => void>>();
	const closed: string[] = [];
	return {
		watch: (dir: string, onChange: (filename: string | undefined, removed?: boolean) => void) => {
			if (fails) throw new Error("cannot watch");
			watched.set(dir, [...(watched.get(dir) ?? []), onChange]);
			return () => { closed.push(dir); };
		},
		watched,
		closed,
		fire(dir: string, filename: string | undefined = "telemetry.json") {
			for (const listener of watched.get(dir) ?? []) listener(filename);
		},
	};
}

async function wiredTransport(t: any, state: FakeState, options: { createDirectory?: boolean; watchFails?: boolean; override?: Override } = {}) {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	const root = mkdtempSync(join(tmpdir(), "gs-telemetry-watch-"));
	const stateDirectory = join(root, "gentle-ai");
	if (options.createDirectory !== false) mkdirSync(stateDirectory);
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
		rmSync(root, { recursive: true, force: true });
	});
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {},
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on() { return () => {}; }, emit() {} },
	} as unknown as ExtensionAPI;
	const fake = fakeGentleAi(state, options.override);
	const timers = manualTimers();
	const fs = fakeWatch(options.watchFails === true);
	desktopRpc(pi, {
		telemetryExec: fake.exec,
		telemetryResolveBinary: () => "/fake/gentle-ai",
		telemetryStateDirectory: () => stateDirectory,
		watch: fs.watch,
		timers: timers.timers,
	});
	const widgets: string[] = [];
	const ctx = {
		mode: "rpc",
		cwd: "/home/devel/project",
		sessionManager: { getCwd: () => "/home/devel/project", getSessionId: () => "session-a", getEntries: () => [] },
		ui: { setWidget(_key: string, lines: string[]) { widgets.push(...lines); } },
	};
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	const shutdown = () => { for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx); };
	const invoke = (requestId: string, method: string, params: Record<string, unknown> = {}) =>
		commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }), ctx);
	const parsed = () => widgets.map((line) => JSON.parse(line));
	return {
		fake, timers, fs, invoke, shutdown, root, stateDirectory,
		// The config bridge shares the watch seam: only this test's own directories count.
		watchedHere: () => [...fs.watched.keys()].filter((dir) => dir.startsWith(root)),
		events: () => parsed().filter((line) => line.kind === "event" && line.event === "telemetry_changed"),
		response: (requestId: string) => parsed().find((line) => line.requestId === requestId),
	};
}

test("telemetry_changed is advertised once the watcher is wired, and watches gentle-ai's state directory", async (t) => {
	const app = await wiredTransport(t, { enabled: true, noticeShown: true });
	await app.invoke("cap", "capabilities");
	assert.equal(app.response("cap").data.events.filter((event: string) => event === "telemetry_changed").length, 1);
	assert.deepEqual(app.watchedHere(), [app.stateDirectory]);
});

test("an external change fires telemetry_changed with the get_telemetry payload, from policy --json only", async (t) => {
	const state: FakeState = { enabled: true, noticeShown: true };
	const app = await wiredTransport(t, state);
	await app.invoke("before", "get_telemetry");
	state.enabled = false; // `gentle-ai telemetry disable` in a terminal
	app.fs.fire(app.stateDirectory);
	assert.equal(app.events().length, 0, "nothing before the debounce window closes");
	await app.timers.advance(250);
	await app.invoke("after", "get_telemetry");
	const events = app.events();
	assert.equal(events.length, 1);
	assert.deepEqual(events[0].data, app.response("after").data);
	assert.deepEqual(events[0].data, { enabled: false, source: "state", reason: "disabled", toggle: "off", locked: false });
	assert.ok(app.fake.verbs().every((verb) => verb === "telemetry policy --json"), `only policy reads: ${app.fake.verbs()}`);
});

test("a burst of changes is one debounced re-read and one event", async (t) => {
	const state: FakeState = { enabled: true, noticeShown: true };
	const app = await wiredTransport(t, state);
	await app.invoke("before", "get_telemetry");
	const before = app.fake.calls.length;
	state.enabled = false;
	for (let i = 0; i < 5; i += 1) {
		app.fs.fire(app.stateDirectory);
		await app.timers.advance(100);
	}
	assert.equal(app.events().length, 0, "each change restarts the window");
	await app.timers.advance(250);
	assert.equal(app.events().length, 1);
	assert.equal(app.fake.calls.length - before, 1);
});

test("an unrelated file in the directory is ignored", async (t) => {
	const state: FakeState = { enabled: true, noticeShown: true };
	const app = await wiredTransport(t, state);
	state.enabled = false;
	app.fs.fire(app.stateDirectory, "state.json");
	assert.equal(app.timers.open(), 0);
	await app.timers.advance(1000);
	assert.equal(app.events().length, 0);
});

test("the Desktop's own set_telemetry is not echoed", async (t) => {
	const state: FakeState = { enabled: true, noticeShown: true };
	const app = await wiredTransport(t, state);
	await app.invoke("set", "set_telemetry", { enabled: false });
	assert.equal(app.response("set").ok, true);
	app.fs.fire(app.stateDirectory); // the file change the write caused
	await app.timers.advance(250);
	assert.equal(app.events().length, 0);
	// A later genuine change still gets through.
	state.enabled = true;
	app.fs.fire(app.stateDirectory);
	await app.timers.advance(250);
	assert.equal(app.events().length, 1);
	assert.equal(app.events()[0].data.toggle, "on");
});

test("a file change that settles while set_telemetry is still writing is not an event", async (t) => {
	const state: FakeState = { enabled: true, noticeShown: true };
	let app: Awaited<ReturnType<typeof wiredTransport>> | undefined;
	app = await wiredTransport(t, state, {
		override: (args) => {
			// The write's own file change settles its debounce window mid-write.
			if (args[1] === "disable") {
				app!.fs.fire(app!.stateDirectory);
				void app!.timers.advance(250);
			}
			return undefined;
		},
	});
	await app.invoke("set", "set_telemetry", { enabled: false });
	await app.timers.advance(250);
	assert.equal(app.events().length, 0);
});

test("a rewrite that leaves the policy unchanged (a heartbeat timestamp) is not an event", async (t) => {
	const app = await wiredTransport(t, { enabled: true, noticeShown: true });
	await app.invoke("before", "get_telemetry");
	app.fs.fire(app.stateDirectory);
	await app.timers.advance(250);
	assert.equal(app.events().length, 0);
});

test("a failed re-read emits nothing and never fabricates a policy", async (t) => {
	let broken = false;
	const app = await wiredTransport(t, { enabled: true, noticeShown: true }, { override: () => (broken ? result({ exitCode: 1, stderr: "boom" }) : undefined) });
	await app.invoke("before", "get_telemetry");
	broken = true;
	app.fs.fire(app.stateDirectory);
	await app.timers.advance(250);
	assert.equal(app.events().length, 0);
});

test("a missing state directory (fresh install) is watched through its parent and fires once gentle-ai creates it", async (t) => {
	const state: FakeState = { noticeShown: false };
	const app = await wiredTransport(t, state, { createDirectory: false });
	await app.invoke("cap", "capabilities");
	assert.ok(app.response("cap").data.events.includes("telemetry_changed"));
	assert.deepEqual(app.watchedHere(), [app.root]);
	await app.invoke("before", "get_telemetry");
	assert.equal(app.response("before").data.toggle, "unset");
	// gentle-ai creates its home and the user enables from a terminal.
	mkdirSync(app.stateDirectory);
	state.enabled = true;
	state.noticeShown = true;
	app.fs.fire(app.root, "gentle-ai");
	await app.timers.advance(250);
	assert.equal(app.events().length, 1);
	assert.equal(app.events()[0].data.toggle, "on");
	assert.deepEqual(app.watchedHere(), [app.root, app.stateDirectory], "now watches the real directory");
});

test("a watcher that cannot be created leaves the event unadvertised and the methods working", async (t) => {
	const app = await wiredTransport(t, { enabled: true, noticeShown: true }, { watchFails: true });
	await app.invoke("cap", "capabilities");
	await app.invoke("get", "get_telemetry");
	assert.ok(!app.response("cap").data.events.includes("telemetry_changed"));
	assert.equal(app.response("get").ok, true);
});

test("shutdown closes the watcher, cancels the pending window and emits nothing after", async (t) => {
	const state: FakeState = { enabled: true, noticeShown: true };
	const app = await wiredTransport(t, state);
	await app.invoke("before", "get_telemetry");
	state.enabled = false;
	app.fs.fire(app.stateDirectory);
	assert.equal(app.timers.open(), 1);
	app.shutdown();
	assert.deepEqual(app.fs.closed.filter((dir) => dir.startsWith(app.root)), [app.stateDirectory]);
	assert.equal(app.timers.open(), 0);
	await app.timers.advance(1000);
	assert.equal(app.events().length, 0);
	app.fs.fire(app.stateDirectory);
	assert.equal(app.timers.open(), 0);
});

