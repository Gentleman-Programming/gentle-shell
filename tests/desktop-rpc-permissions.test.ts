import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET } from "../lib/desktop-rpc.ts";
import { PERMISSION_MODE_SCHEMA, permissionModePolicyFile, writePermissionModePolicy } from "../lib/permission-mode-policy.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";
import { registerYoloSessionPolicy } from "../lib/yolo-session-policy.ts";

type WidgetCall = { key: string; lines: string[] };

function isolatedEnvironment(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "gentle-desktop-permissions-"));
	const home = join(root, "config");
	const workspace = join(root, "workspace");
	mkdirSync(home);
	mkdirSync(workspace);
	const previous = {
		host: process.env[INTERACTIVE_HOST_ENV],
		configHome: process.env.GENTLE_PI_CONFIG_HOME,
		child: process.env.GENTLE_PI_AGENTS_CHILD,
	};
	process.env[INTERACTIVE_HOST_ENV] = "1";
	process.env.GENTLE_PI_CONFIG_HOME = home;
	delete process.env.GENTLE_PI_AGENTS_CHILD;
	t.after(() => {
		if (previous.host === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous.host;
		if (previous.configHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous.configHome;
		if (previous.child === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
		else process.env.GENTLE_PI_AGENTS_CHILD = previous.child;
		rmSync(root, { recursive: true, force: true });
	});
	return { root, home, workspace, policyFile: permissionModePolicyFile({ gentlePiConfigHome: home }) };
}

function desktopHost(t: test.TestContext, options: { owner?: boolean } = {}) {
	const dirs = isolatedEnvironment(t);
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const lifecycle = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const hostUi = new Map<string, (value: unknown) => void>();
	const tools: string[] = [];
	const pi = {
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, command);
		},
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { lifecycle.set(name, handler); },
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		events: {
			on(name: string, handler: (value: unknown) => void) { hostUi.set(name, handler); },
			emit(name: string, value: unknown) { hostUi.get(name)?.(value); },
		},
	} as unknown as ExtensionAPI;
	const owner = options.owner === false
		? undefined
		: registerYoloSessionPolicy(pi, process.env, { resolveIdentity: async () => "workspace:test" });
	desktopRpc(pi);
	const widgets: WidgetCall[] = [];
	const notices: string[] = [];
	const statuses = new Map<string, string | undefined>();
	const session = { id: "session-1" };
	const ctx = {
		mode: "rpc",
		hasUI: true,
		cwd: dirs.workspace,
		sessionManager: { getSessionId: () => session.id },
		ui: {
			setWidget(key: string, lines: string[]) { if (key === DESKTOP_RPC_WIDGET) widgets.push({ key, lines }); },
			setStatus(key: string, value?: string) { statuses.set(key, value); },
			notify(message: string) { notices.push(message); },
			select: async () => undefined,
			getAllThemes: () => [],
		},
	} as unknown as ExtensionContext;
	return {
		...dirs,
		owner,
		pi,
		tools,
		ctx,
		widgets,
		notices,
		statuses,
		session,
		start() { lifecycle.get("session_start")?.({}, ctx); },
		shutdown() { lifecycle.get("session_shutdown")?.({}, ctx); },
		async invoke(method: string, params: Record<string, unknown> = {}, requestId = `request-${method}`) {
			assert.deepEqual([...commands.keys()].includes("gentle:desktop"), true);
			await commands.get("gentle:desktop")!.handler(
				JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }),
				ctx,
			);
		},
		lines() { return widgets.map((call) => JSON.parse(call.lines[0]!)); },
	};
}

const eventOf = (line: any) => line.kind === "event";

test("capabilities advertise the wired permission domain and no agent tool", async (t) => {
	const app = desktopHost(t);
	app.start();
	await app.invoke("capabilities");
	const [response] = app.lines();
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
	assert.deepEqual(app.tools, [], "the control surface is never an agent-callable tool");
});

test("get_permission_mode reports the live owner state and never persists a default", async (t) => {
	const app = desktopHost(t);
	app.start();
	await app.invoke("get_permission_mode");
	const lines = app.lines();
	assert.equal(lines.length, 1, "a read never emits an event");
	assert.deepEqual(lines[0], {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: "request-get_permission_mode",
		ok: true,
		data: { mode: "normal", default_mode: "normal" },
	});
	assert.equal(await app.owner!.mode(app.ctx), "normal");
	assert.equal(existsSync(app.policyFile), false, "a read never writes the default store");

	// The owner initializes a session lazily, so this first call pinned the session
	// to the default in effect then; a later default change belongs to new sessions.
	writePermissionModePolicy("auto", { gentlePiConfigHome: app.home });
	await app.invoke("get_permission_mode", {}, "request-read-2");
	assert.deepEqual(app.lines().at(-1).data, { mode: "normal", default_mode: "auto" });
	assert.equal(app.lines().filter((line) => line.kind === "event").length, 0, "reads never emit events");
});

test("set_permission_mode applies every mode immediately with one ordered event", async (t) => {
	const app = desktopHost(t);
	app.start();
	const order = ["auto", "yolo", "super-yolo", "normal"] as const;
	const previous = ["normal", "auto", "yolo", "super-yolo"];
	for (const [index, mode] of order.entries()) {
		await app.invoke("set_permission_mode", { mode }, `set-${mode}`);
		const lines = app.lines();
		const response = lines.at(-2);
		const event = lines.at(-1);
		assert.equal(response.requestId, `set-${mode}`);
		assert.deepEqual(response.data, { mode, default_mode: "normal", persisted: false, changed: true });
		assert.equal(eventOf(event), true, `${mode}: the event follows its response`);
		assert.equal(event.event, "permission_mode_changed");
		assert.equal(event.seq, index + 1);
		assert.deepEqual(event.data, {
			mode,
			previous_mode: previous[index],
			default_mode: "normal",
			persisted: false,
			source: "desktop",
		});
		assert.equal(await app.owner!.mode(app.ctx), mode, `${mode}: applied without a restart`);
	}
	await app.invoke("get_snapshot");
	assert.equal(app.lines().at(-1).data.sequence, order.length);
	assert.equal(existsSync(app.policyFile), false, "session changes never persist by accident");
});

test("set_permission_mode persists the default only when explicitly requested", async (t) => {
	const app = desktopHost(t);
	app.start();
	await app.invoke("set_permission_mode", { mode: "yolo" });
	assert.equal(existsSync(app.policyFile), false);
	assert.deepEqual(app.lines().at(-2).data, { mode: "yolo", default_mode: "normal", persisted: false, changed: true });

	await app.invoke("set_permission_mode", { mode: "auto", persist: true });
	assert.equal(readFileSync(app.policyFile, "utf8"), `${JSON.stringify({ schema: PERMISSION_MODE_SCHEMA, mode: "auto" })}\n`);
	assert.equal(statSync(app.policyFile).mode & 0o777, 0o600);
	assert.deepEqual(app.lines().at(-2).data, { mode: "auto", default_mode: "auto", persisted: true, changed: true });
	assert.deepEqual(app.lines().at(-1).data, {
		mode: "auto",
		previous_mode: "yolo",
		default_mode: "auto",
		persisted: true,
		source: "desktop",
	});

	await app.invoke("set_permission_mode", { mode: "yolo", persist: false });
	assert.match(readFileSync(app.policyFile, "utf8"), /"mode":"auto"/);
	assert.deepEqual(app.lines().at(-2).data, { mode: "yolo", default_mode: "auto", persisted: false, changed: true });
});

test("invalid params and unknown modes are typed rejections without events", async (t) => {
	const app = desktopHost(t);
	app.start();
	const cases: Array<[Record<string, unknown>, string]> = [
		[{ mode: "turbo" }, "Unknown permission mode"],
		[{}, "Invalid permission mode parameters"],
		[{ mode: 7 }, "Invalid permission mode parameters"],
		[{ mode: "auto", persist: "yes" }, "Invalid permission mode parameters"],
		[{ mode: "auto", unexpected: true }, "Invalid permission mode parameters"],
	];
	for (const [params, message] of cases) {
		await app.invoke("set_permission_mode", params, "invalid");
		const lines = app.lines();
		assert.equal(lines.at(-1).requestId, "invalid");
		assert.deepEqual(lines.at(-1).error, { code: "invalid_request", message });
		assert.equal(lines.filter(eventOf).length, 0, "rejections never emit events");
	}
	await app.invoke("get_snapshot");
	assert.equal(app.lines().at(-1).data.sequence, 0);
	assert.equal(await app.owner!.mode(app.ctx), "normal");
	assert.equal(existsSync(app.policyFile), false);

	await app.invoke("get_permission_mode", { mode: "auto" }, "invalid-read");
	assert.deepEqual(app.lines().at(-1).error, { code: "invalid_request", message: "Invalid permission mode parameters" });
	assert.equal(app.lines().filter(eventOf).length, 0);
});

test("repeating the current mode is a no-op with actual state and no event", async (t) => {
	const app = desktopHost(t);
	app.start();
	await app.invoke("set_permission_mode", { mode: "normal" });
	const lines = app.lines();
	assert.equal(lines.length, 1);
	assert.deepEqual(lines[0].data, { mode: "normal", default_mode: "normal", persisted: false, changed: false });
	assert.equal(lines.filter(eventOf).length, 0);
	await app.invoke("get_snapshot");
	assert.equal(app.lines().at(-1).data.sequence, 0);
});

test("owner absence and stale sessions map to safe typed errors", async (t) => {
	const absent = desktopHost(t, { owner: false });
	absent.start();
	await absent.invoke("get_permission_mode");
	await absent.invoke("set_permission_mode", { mode: "yolo" });
	const lines = absent.lines();
	assert.equal(lines.length, 2);
	for (const line of lines) {
		assert.deepEqual(line.error, {
			code: "permission_unavailable",
			message: "Permission owner unavailable for this session",
		});
	}
	assert.equal(lines.filter(eventOf).length, 0);
	assert.equal(absent.lines().some((line) => JSON.stringify(line).includes(tmpdir())), false, "no paths leak");

	const app = desktopHost(t);
	app.start();
	await app.invoke("set_permission_mode", { mode: "yolo" });
	app.session.id = "session-2";
	const before = app.lines().length;
	await app.invoke("get_permission_mode");
	await app.invoke("set_permission_mode", { mode: "auto" });
	const after = app.lines().slice(before);
	assert.equal(after.length, 2);
	for (const line of after) assert.equal(line.error.code, "permission_unavailable");
	assert.equal(app.lines().filter(eventOf).length, 1, "only the successful change emitted");
});

test("a failed default save keeps the session change and reports a safe typed error", async (t) => {
	const app = desktopHost(t);
	app.start();
	writeFileSync(app.policyFile, "{");
	await app.invoke("set_permission_mode", { mode: "auto", persist: true });
	const response = app.lines().at(-2);
	assert.deepEqual(response.data, {
		mode: "auto",
		default_mode: "normal",
		persisted: false,
		changed: true,
		persist_error: { code: "default_unchanged", message: "Default permission mode unchanged" },
	});
	assert.equal(readFileSync(app.policyFile, "utf8"), "{", "a malformed preference is never repaired");
	assert.equal(JSON.stringify(app.lines()).includes(tmpdir()), false, "no paths leak");
	const event = app.lines().at(-1);
	assert.equal(event.event, "permission_mode_changed");
	assert.deepEqual(event.data, {
		mode: "auto",
		previous_mode: "normal",
		default_mode: "normal",
		persisted: false,
		source: "desktop",
	});
});

test("TUI and headless hosts keep the permission channel closed", async (t) => {
	const app = desktopHost(t);
	app.start();
	delete process.env[INTERACTIVE_HOST_ENV];
	app.ctx.mode = "rpc";
	await app.invoke("set_permission_mode", { mode: "yolo" });
	process.env[INTERACTIVE_HOST_ENV] = "1";
	app.ctx.mode = "tui";
	await app.invoke("set_permission_mode", { mode: "yolo" });
	assert.deepEqual(app.lines(), []);
	assert.equal(await app.owner!.mode(app.ctx), "normal");
});
