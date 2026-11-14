import assert from "node:assert/strict";
import { test } from "node:test";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET, DesktopRpcRouter, type DesktopRpcDomain, type DesktopRpcOutcome } from "../lib/desktop-rpc.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

type WidgetCall = { key: string; lines: string[] };

function interactiveHost(t: test.TestContext): void {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
}

function widgetPayload(call: WidgetCall): any {
	assert.equal(call.key, DESKTOP_RPC_WIDGET);
	assert.equal(call.lines.length, 1);
	return JSON.parse(call.lines[0]!);
}

function harness(t: test.TestContext) {
	interactiveHost(t);
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: any) => void>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { events.set(name, handler); },
	};
	desktopRpc(pi as any);
	const widgets: WidgetCall[] = [];
	const ctx = {
		mode: "rpc",
		ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } },
	};
	return {
		commands,
		events,
		ctx,
		widgets,
		start() { events.get("session_start")?.({}, ctx); },
		async invoke(request: unknown, targetCtx: any = ctx) {
			const raw = typeof request === "string" ? request : JSON.stringify(request);
			await commands.get("gentle:desktop")!.handler(raw, targetCtx);
		},
	};
}

function request(method: string, params: Record<string, unknown> = {}) {
	return { schema: DESKTOP_RPC_SCHEMA, requestId: `request-${method}`, method, params };
}

test("capabilities and snapshots use correlated structured responses", async (t) => {
	const app = harness(t);
	app.start();

	await app.invoke(request("capabilities"));
	assert.deepEqual(widgetPayload(app.widgets[0]!), {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: "request-capabilities",
		ok: true,
		data: {
			schema: DESKTOP_RPC_SCHEMA,
			command: "gentle:desktop",
			widget: DESKTOP_RPC_WIDGET,
			methods: ["capabilities", "get_snapshot", "get_config", "set_config", "get_permission_mode", "set_permission_mode", "get_subscription_usage", "refresh_subscription_usage", "get_design_canvas", "list_jobs", "cancel_job", "list_subagents", "cancel_subagent"],
			events: ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "agents_update"],
		},
	});

	await app.invoke(request("get_snapshot"));
	assert.deepEqual(widgetPayload(app.widgets[1]!), {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: "request-get_snapshot",
		ok: true,
		data: { schema: DESKTOP_RPC_SCHEMA, sequence: 0, state: {} },
	});
});

test("malformed input and unsupported methods return bounded typed errors", async (t) => {
	const app = harness(t);
	app.start();

	await app.invoke("{not-json");
	assert.deepEqual(widgetPayload(app.widgets[0]!), {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: null,
		ok: false,
		error: { code: "invalid_request", message: "Request must be a valid JSON object" },
	});

	await app.invoke({ ...request("capabilities"), requestId: "bad-method", method: "unknown" });
	assert.deepEqual(widgetPayload(app.widgets[1]!).error, {
		code: "unsupported_method",
		message: "Unsupported Desktop RPC method",
	});
	assert.equal(widgetPayload(app.widgets[1]!).requestId, "bad-method");

	await app.invoke({ ...request("capabilities"), requestId: "bad-schema", schema: "other/v1" });
	assert.equal(widgetPayload(app.widgets[2]!).error.code, "invalid_request");
	assert.equal(widgetPayload(app.widgets[2]!).requestId, "bad-schema");

	await app.invoke({ ...request("capabilities"), requestId: "bad-method-format", method: ":42" });
	assert.equal(widgetPayload(app.widgets[3]!).requestId, "bad-method-format");
	assert.equal(widgetPayload(app.widgets[3]!).error.code, "invalid_request");
});

test("events advance after delivery, move to a replacement publisher, and reset on restart", () => {
	const router = new DesktopRpcRouter();
	const first: string[] = [];
	const second: string[] = [];
	router.start((line) => first.push(line));
	router.emit("jobs_update", { jobs: [] });
	router.emit("jobs_update", { jobs: [] });
	assert.equal(JSON.parse(first[0]!).seq, 1);
	assert.equal(JSON.parse(first[1]!).seq, 2);
	assert.equal(router.snapshot().sequence, 2);

	router.start((line) => second.push(line));
	router.emit("jobs_update", { jobs: [] });
	assert.equal(first.length, 2);
	assert.equal(JSON.parse(second[0]!).seq, 1);
	router.stop();
	assert.equal(router.snapshot().sequence, 0);
	router.emit("jobs_update", { jobs: [] });
	assert.equal(second.length, 1);
});

test("state failures are internal errors and publisher failures are never retried", () => {
	const internal = new DesktopRpcRouter(undefined, undefined, () => { throw new Error("private path"); });
	const lines: string[] = [];
	internal.start((line) => lines.push(line));
	internal.handle(JSON.stringify(request("get_snapshot")));
	assert.deepEqual(JSON.parse(lines[0]!), {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: "request-get_snapshot",
		ok: false,
		error: { code: "internal_error", message: "Desktop RPC operation failed" },
	});
	assert.equal(lines[0]!.includes("private path"), false);

	const circular: Record<string, unknown> = {};
	circular.self = circular;
	const unserializable = new DesktopRpcRouter(undefined, undefined, () => circular);
	unserializable.start((line) => lines.push(line));
	unserializable.handle(JSON.stringify(request("get_snapshot")));
	assert.equal(JSON.parse(lines[1]!).error.code, "internal_error");
	assert.equal(JSON.parse(lines[1]!).requestId, "request-get_snapshot");

	const unknown = new DesktopRpcRouter(["future_method"]);
	unknown.start((line) => lines.push(line));
	unknown.handle(JSON.stringify(request("future_method")));
	assert.equal(JSON.parse(lines[2]!).error.code, "unsupported_method");

	const broken = new DesktopRpcRouter();
	let calls = 0;
	broken.start(() => { calls += 1; throw new Error("closed"); });
	assert.throws(() => broken.handle(JSON.stringify(request("capabilities"))), /closed/);
	assert.equal(calls, 1);
	assert.throws(() => broken.emit("jobs_update", {}), /closed/);
	assert.equal(broken.snapshot().sequence, 0);
});

test("async domain outcomes answer before their single event and drop superseded sessions", async () => {
	const lines: string[] = [];
	let settle: (value: DesktopRpcOutcome) => void = () => {};
	const domain: DesktopRpcDomain = () => new Promise((resolve) => { settle = resolve; });
	const methods = ["capabilities", "get_snapshot", "set_permission_mode"];
	const router = new DesktopRpcRouter(methods, ["permission_mode_changed"], undefined, domain);
	router.start((line) => lines.push(line));
	const pending = router.handle(JSON.stringify(request("set_permission_mode")));
	assert.equal(lines.length, 0, "nothing is published before the owner answers");
	settle({ ok: true, data: { mode: "auto" }, event: { name: "permission_mode_changed", data: { mode: "auto" } } });
	await pending;
	assert.deepEqual(lines.map((line) => JSON.parse(line).kind), ["response", "event"]);
	assert.equal(JSON.parse(lines[0]!).requestId, "request-set_permission_mode");
	assert.deepEqual(JSON.parse(lines[1]!).data, { mode: "auto" });

	const slowDomain: DesktopRpcDomain = async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		return { ok: true, data: {}, event: { name: "permission_mode_changed", data: {} } };
	};
	const stale = new DesktopRpcRouter(methods, ["permission_mode_changed"], undefined, slowDomain);
	const staleLines: string[] = [];
	stale.start((line) => staleLines.push(line));
	const replacing = stale.handle(JSON.stringify(request("set_permission_mode")));
	stale.start((line) => staleLines.push(line));
	await replacing;
	assert.deepEqual(staleLines, [], "a superseded publisher never answers or emits");

	const rejectingDomain: DesktopRpcDomain = () => Promise.reject(new Error("private owner detail"));
	const failing = new DesktopRpcRouter(methods, ["permission_mode_changed"], undefined, rejectingDomain);
	const failedLines: string[] = [];
	failing.start((line) => failedLines.push(line));
	await failing.handle(JSON.stringify(request("set_permission_mode")));
	assert.deepEqual(JSON.parse(failedLines[0]!).error, {
		code: "internal_error",
		message: "Desktop RPC operation failed",
	});
	assert.equal(failedLines.some((line) => line.includes("private owner detail")), false);
});

test("session lifecycle replaces the publisher and shutdown stops all responses", async (t) => {
	const app = harness(t);
	app.start();
	const replacementWidgets: WidgetCall[] = [];
	const replacement = {
		mode: "rpc",
		ui: { setWidget(key: string, lines: string[]) { replacementWidgets.push({ key, lines }); } },
	};
	app.events.get("session_start")?.({}, replacement);
	await app.invoke(request("capabilities"), replacement);
	assert.equal(app.widgets.length, 0);
	assert.equal(replacementWidgets.length, 1);

	app.events.get("session_shutdown")?.({}, replacement);
	await app.invoke(request("capabilities"), replacement);
	assert.equal(replacementWidgets.length, 1);
});

test("transport failures do not leak raw producer errors", async (t) => {
	const app = harness(t);
	const brokenCtx = {
		mode: "rpc",
		ui: { setWidget() { throw new Error("private transport detail"); } },
	};
	app.events.get("session_start")?.({}, brokenCtx);
	await assert.rejects(
		app.invoke(request("capabilities"), brokenCtx),
		(error: Error) => error.message === "Desktop RPC transport unavailable" && !error.message.includes("private"),
	);
});

test("TUI and headless RPC sessions do not activate the Desktop channel", async (t) => {
	const app = harness(t);
	delete process.env[INTERACTIVE_HOST_ENV];
	app.start();
	await app.invoke(request("capabilities"));
	assert.equal(app.widgets.length, 0);

	process.env[INTERACTIVE_HOST_ENV] = "1";
	app.ctx.mode = "tui";
	app.start();
	await app.invoke(request("capabilities"));
	assert.equal(app.widgets.length, 0);
});
