import assert from "node:assert/strict";
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
	const router = new DesktopRpcRouter(["capabilities", "get_snapshot", ...DESKTOP_TELEMETRY_METHODS], [...DESKTOP_TELEMETRY_EVENTS], () => ({}), (method, params) => bridge.handle(method, params));
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

test("the methods are advertised and no telemetry event is", async () => {
	assert.deepEqual([...DESKTOP_TELEMETRY_METHODS], ["get_telemetry", "set_telemetry"]);
	assert.deepEqual([...DESKTOP_TELEMETRY_EVENTS], []);
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

test("the Desktop transport advertises get_telemetry and set_telemetry, no telemetry_changed, and answers through gentle:desktop", async (t) => {
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
	desktopRpc(pi, { telemetryExec: fake.exec, telemetryResolveBinary: () => "/fake/gentle-ai" });
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
