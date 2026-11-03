import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleFleet, { FLEET_DIGEST_MESSAGE_TYPE, FLEET_MEMBER_CAP, type FleetDeps } from "../extensions/gentle-fleet.ts";
import gentleAgents, { type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { FLEET_ROLE_ENV } from "../lib/fleet-role.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
// Scratch stays outside the worktree; it is reported, not removed.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gentle-fleet-test-")));
const controllerEnv = { PATH: "/bin", [FLEET_ROLE_ENV]: "controller" };

type Tool = { name: string; execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: ExtensionContext): Promise<{ content: Array<{ text: string }>; details?: unknown }> };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakePi() {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => sent.push({ message, options }),
		events: { on: () => () => {}, emit() {} },
	} as unknown as ExtensionAPI;
	const fire = async (name: string, ctx: ExtensionContext, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { pi, tools, handlers, sent, fire };
}

function fakeContext() {
	const widgets = new Map<string, string[] | undefined>();
	const ctx = {
		cwd: "/work/main",
		hasUI: true,
		mode: "tui",
		ui: { setWidget: (key: string, lines: string[] | undefined) => widgets.set(key, lines), setStatus() {}, notify() {} },
		sessionManager: { getSessionId: () => "fleet-session-1" },
	} as unknown as ExtensionContext;
	return { ctx, widgets };
}

function harness(env: NodeJS.ProcessEnv = controllerEnv) {
	const h = fakePi();
	const children: FakeChild[] = [];
	const spawned: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	const deps: Partial<FleetDeps> = {
		spawn: (command, args, options) => {
			spawned.push({ command, args, cwd: options.cwd, env: options.env });
			const child = fakeChild({ exitOnKill: true });
			children.push(child);
			return child.child;
		},
		schedule: (fn, ms) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		},
		pi: { command: "pi", args: [] },
		agentHome: join(scratch, "agent"),
		process: { platform: "darwin", kill() {} },
	};
	gentleFleet(h.pi, env, deps);
	const runTimers = () => {
		for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
	};
	return { ...h, children, spawned, timers, runTimers };
}

async function spawnMember(h: ReturnType<typeof harness>, ctx: ExtensionContext, name: string, extra: Record<string, unknown> = {}) {
	return h.tools.get("fleet_spawn")!.execute(`spawn-${name}`, { name, objective: `Own the ${name} front`, ...extra }, undefined, undefined, ctx);
}

test("the fleet extension registers nothing unless this session is the fleet controller", () => {
	for (const env of [{}, { [FLEET_ROLE_ENV]: "member" }, { [FLEET_ROLE_ENV]: "other" }]) {
		const h = harness(env);
		assert.equal(h.tools.size, 0, JSON.stringify(env));
		assert.equal(h.handlers.size, 0, JSON.stringify(env));
	}
	assert.deepEqual([...harness().tools.keys()].sort(), ["fleet_send", "fleet_spawn", "fleet_status", "fleet_stop"]);
});

test("fleet_spawn launches a member session under the fleet session dir and sends the objective first", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const result = await spawnMember(h, ctx, "api", { model: "anthropic/claude-sonnet-5-5" });
	await tick();
	assert.match(result.content[0].text, /api/);
	assert.equal(h.spawned.length, 1);
	const launch = h.spawned[0];
	assert.equal(launch.cwd, "/work/main", "cwd defaults to the controller session cwd");
	assert.equal(launch.env[FLEET_ROLE_ENV], "member");
	const dir = launch.args[launch.args.indexOf("--session-dir") + 1];
	assert.equal(dir, join(scratch, "agent", "gentle-fleet", "sessions", "fleet-session-1", "api"));
	assert.deepEqual(launch.args.slice(-2), ["--model", "anthropic/claude-sonnet-5-5"]);
	assert.deepEqual(h.children[0].written[0], { id: "api-1", type: "prompt", message: "Own the api front" });
	await spawnMember(h, ctx, "web", { cwd: "/work/web" });
	assert.equal(h.spawned[1].cwd, "/work/web");
});

test(`fleet_spawn rejects a member beyond the ${FLEET_MEMBER_CAP}-member cap and a duplicate live name`, async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	for (const name of ["a", "b", "c"]) await spawnMember(h, ctx, name);
	const duplicate = await spawnMember(h, ctx, "a");
	assert.match(duplicate.content[0].text, /already/);
	const fourth = await spawnMember(h, ctx, "d");
	assert.match(fourth.content[0].text, /at most 3 live members/);
	assert.equal(h.spawned.length, 3);
	await h.tools.get("fleet_stop")!.execute("stop", { name: "a" }, undefined, undefined, ctx);
	await tick();
	await spawnMember(h, ctx, "d");
	assert.equal(h.spawned.length, 4, "a stopped member frees its slot");
});

test("member settles, questions and exits wake the controller once per coalescing window, never per tool call", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await spawnMember(h, ctx, "api");
	await spawnMember(h, ctx, "web");
	await tick();
	const [api, web] = h.children;
	api.emit({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} });
	api.emit({ type: "tool_execution_end", toolCallId: "1", toolName: "bash", isError: false, result: { content: [] } });
	await tick();
	assert.equal(h.timers.length, 0, "tool activity schedules no wake");
	api.emit({ type: "agent_settled", aborted: false });
	web.emit({ type: "extension_ui_request", id: "q1", method: "confirm", title: "Delete the old table?", message: "irreversible" });
	await tick();
	assert.equal(h.sent.length, 0, "the wake waits for the window");
	h.runTimers();
	assert.equal(h.sent.length, 1, "one coalesced wake");
	const { message, options } = h.sent[0];
	assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
	assert.equal(message.customType, FLEET_DIGEST_MESSAGE_TYPE);
	const content = String(message.content);
	assert.match(content, /api \[idle\]/);
	assert.match(content, /web \[waiting-question\]/);
	assert.match(content, /Delete the old table\?/);
	web.exit(1, null);
	await tick();
	h.runTimers();
	assert.equal(h.sent.length, 2);
	assert.match(String(h.sent[1].message.content), /web \[exited\]/);
	assert.doesNotMatch(String(h.sent[1].message.content), /api/, "only members with news are reported");
});

test("fleet_send prompts or steers a member and fleet_status returns code-built digests", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await spawnMember(h, ctx, "api");
	await tick();
	await h.tools.get("fleet_send")!.execute("s1", { name: "api", message: "add tests", mode: "steer" }, undefined, undefined, ctx);
	await h.tools.get("fleet_send")!.execute("s2", { name: "api", message: "then docs" }, undefined, undefined, ctx);
	await tick();
	assert.deepEqual(h.children[0].written.slice(1).map(command => [command.type, command.message, command.streamingBehavior]), [["steer", "add tests", undefined], ["prompt", "then docs", "followUp"]]);
	const missing = await h.tools.get("fleet_send")!.execute("s3", { name: "nope", message: "x" }, undefined, undefined, ctx);
	assert.match(missing.content[0].text, /No fleet member named "nope"/);
	const status = await h.tools.get("fleet_status")!.execute("st", {}, undefined, undefined, ctx);
	assert.match(status.content[0].text, /^api \[working\]/m);
	const detail = await h.tools.get("fleet_status")!.execute("st", { name: "api" }, undefined, undefined, ctx);
	assert.match(detail.content[0].text, /Own the api front/);
});

test("the fleet widget shows one digest line per member", async () => {
	const h = harness();
	const { ctx, widgets } = fakeContext();
	await h.fire("session_start", ctx);
	await spawnMember(h, ctx, "api");
	await tick();
	h.children[0].emit({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} });
	await tick();
	const lines = widgets.get("gentle-fleet");
	assert.ok(lines && lines.some(line => /api \[working\].*last tool read/.test(line)), JSON.stringify(lines));
});

test("session shutdown stops every member", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await spawnMember(h, ctx, "api");
	await spawnMember(h, ctx, "web");
	await h.fire("session_shutdown", ctx, { reason: "quit" });
	await tick();
	const status = await h.tools.get("fleet_status")!.execute("st", {}, undefined, undefined, ctx);
	assert.match(status.content[0].text, /api \[exited\]/);
	assert.match(status.content[0].text, /web \[exited\]/);
});

// --- gentle-agents: members talk only through their controller (star topology).

function agentsHarness(role: string | undefined) {
	let registries = 0;
	const transport: SessionTransportFactory = {
		createRegistry: async () => { registries += 1; return { list: async () => [], listActivations: async () => [] }; },
		createListener: registry => ({ registry, start: async () => {}, close: async () => {} }),
		createClient: () => ({ close() {}, sendNotification: async () => { throw new Error("offline"); } }),
	};
	const handlers = new Map<string, Handler[]>();
	const noop = () => () => {};
	const pi = new Proxy({
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on: noop, emit() {} },
	} as Record<string, unknown>, { get: (target, key) => key in target ? target[key as string] : noop }) as unknown as ExtensionAPI;
	const home = join(scratch, `agents-${role ?? "none"}`);
	const env = { PATH: "/bin", GENTLE_PI_CONFIG_HOME: join(home, "config"), ...(role ? { [FLEET_ROLE_ENV]: role } : {}) };
	gentleAgents(pi, env, { home, agentHome: join(home, ".pi", "agent"), env, pi: { command: "pi", args: [] }, spawn: () => fakeChild().child, schedule: () => () => {}, sessionTransport: transport, resolveWorktree: () => undefined });
	const ui = new Proxy({}, { get: () => () => undefined });
	const ctx = { cwd: home, hasUI: false, mode: "rpc", ui, sessionManager: { getSessionId: () => "s-transport", getCwd: () => home, getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined, getSessionName: () => undefined } } as unknown as ExtensionContext;
	const start = async () => {
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		for (let i = 0; i < 20; i++) await tick();
		return registries;
	};
	return { start };
}

test("a fleet member session never starts the peer session transport", async () => {
	assert.equal(await agentsHarness("member").start(), 0);
});

test("a normal session and the fleet controller still start the peer session transport", async () => {
	assert.equal(await agentsHarness(undefined).start(), 1);
	assert.equal(await agentsHarness("controller").start(), 1);
});
