import assert from "node:assert/strict";
import test from "node:test";
import { CHILD_PACKAGE_INJECTION_ENV, encodeChildPackageInjection } from "../lib/child-package-injection.ts";
import { FLEET_ROLE_ENV } from "../lib/fleet-role.ts";
import { buildMemberLaunch, FleetMember, type FleetMemberEvent } from "../lib/fleet-member.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(options: { platform?: NodeJS.Platform; pid?: number } = {}) {
	const children: FakeChild[] = [];
	const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
	const events: FleetMemberEvent[] = [];
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	const groupKills: Array<[number, string]> = [];
	const member = new FleetMember({
		name: "api",
		objective: "Build the API",
		launch: { command: "pi", args: ["--mode", "rpc"], env: { PATH: "/bin" }, cwd: "/work/api" },
		spawn: (command, args, spawnOptions) => {
			spawned.push({ command, args, options: spawnOptions as unknown as Record<string, unknown> });
			const child = fakeChild({ pid: options.pid, exitOnStdinEnd: false, exitOnKill: false });
			children.push(child);
			return child.child;
		},
		schedule: (fn, ms) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		},
		process: { platform: options.platform ?? "darwin", kill: (pid, signal) => { groupKills.push([pid, String(signal)]); } },
		onEvent: (_member, event) => events.push(event),
	});
	return { member, children, spawned, events, timers, groupKills };
}

function assistantEnd(usage: Record<string, number>, text = "") {
	return { type: "message_end", message: { role: "assistant", content: text ? [{ type: "text", text }] : [], usage: { ...usage, cost: { total: usage.costTotal ?? 0 } } } };
}

function todoEnd(tasks: Array<{ id: number; title: string; status: string }>) {
	return { type: "tool_execution_end", toolCallId: "t1", toolName: "todo", isError: false, result: { content: [{ type: "text", text: "ok" }], details: { gentleTodo: { tasks, nextId: tasks.length + 1, updatedTurn: 1 } } } };
}

test("buildMemberLaunch starts a full headless Gentle Shell session marked as a fleet member", () => {
	const injection = encodeChildPackageInjection({ noExtensions: true, extensionPaths: ["/pkg/gentle-pi"] });
	const launch = buildMemberLaunch({
		env: {
			PATH: "/bin",
			[CHILD_PACKAGE_INJECTION_ENV]: injection,
			[FLEET_ROLE_ENV]: "controller",
			GENTLE_PI_AGENTS_CHILD: "1",
			GENTLE_PI_AGENTS_OWNED_IPC: "x",
			GENTLE_PI_AGENTS_REQUESTED_TOOLS: "read",
			GENTLE_PI_AGENTS_PARENT_PERMISSION_FD: "3",
		},
		cwd: "/work/api",
		sessionDir: "/home/agent/gentle-fleet/sessions/f1/api",
		model: "anthropic/claude-sonnet-5-5",
		pi: { command: "node", args: ["/pi/cli.js"] },
	});
	assert.equal(launch.command, "node");
	assert.deepEqual(launch.args, ["/pi/cli.js", "--mode", "rpc", "--session-dir", "/home/agent/gentle-fleet/sessions/f1/api", "--no-extensions", "--extension", "/pkg/gentle-pi", "--model", "anthropic/claude-sonnet-5-5"]);
	assert.ok(!launch.args.includes("--tools") && !launch.args.includes("--append-system-prompt"), "a member keeps every tool and the normal prompt");
	assert.equal(launch.cwd, "/work/api");
	assert.equal(launch.env[FLEET_ROLE_ENV], "member");
	assert.equal(launch.env.GENTLE_SHELL_INTERACTIVE_HOST, "1");
	for (const key of ["GENTLE_PI_AGENTS_CHILD", "GENTLE_PI_AGENTS_OWNED_IPC", "GENTLE_PI_AGENTS_REQUESTED_TOOLS", "GENTLE_PI_AGENTS_PARENT_PERMISSION_FD"]) assert.equal(key in launch.env, false, key);
	assert.equal(launch.env.PATH, "/bin");
});

test("buildMemberLaunch without an injection or model adds no extension or model flags", () => {
	const launch = buildMemberLaunch({ env: {}, cwd: "/w", sessionDir: "/s", pi: { command: "pi", args: [] } });
	assert.deepEqual(launch.args, ["--mode", "rpc", "--session-dir", "/s"]);
});

test("a member tracks todo progress, last tool, usage, request prefix and bounded last text from events", async () => {
	const h = harness();
	h.member.start();
	h.member.prompt("Build the API");
	await tick();
	assert.deepEqual(h.children[0].written[0], { id: "api-1", type: "prompt", message: "Build the API" });
	assert.equal(h.member.status, "working");
	const child = h.children[0];
	child.emit({ type: "agent_start" });
	child.emit({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: {} });
	child.emit(todoEnd([{ id: 1, title: "Design", status: "done" }, { id: 2, title: "Write routes", status: "in_progress" }, { id: 3, title: "Test", status: "pending" }]));
	child.emit(assistantEnd({ input: 1000, output: 50, cacheRead: 120000, cacheWrite: 3000, totalTokens: 124050, costTotal: 0.5 }));
	child.emit(assistantEnd({ input: 200, output: 80, cacheRead: 124000, cacheWrite: 100, totalTokens: 124380, costTotal: 0.1 }, `${"x".repeat(1000)}END`));
	child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ignored" } });
	await tick();
	assert.deepEqual(h.member.todo, { done: 1, total: 3, current: "Write routes" });
	assert.equal(h.member.lastTool, "todo");
	assert.equal(h.member.usage.totalTokens, 124050 + 124380);
	assert.ok(Math.abs(h.member.usage.cost - 0.6) < 1e-9);
	assert.equal(h.member.prefixTokens, 1000 + 120000 + 3000, "the first request's prefix only");
	assert.ok(h.member.lastText.length <= 400);
	assert.ok(h.member.lastText.endsWith("END"));
	assert.deepEqual(h.events, [], "tool calls and usage never wake the controller");
});

test("a member reports settle, dialog and exit, and keeps dialogs pending until the run settles", async () => {
	const h = harness();
	h.member.start();
	h.member.prompt("go");
	await tick();
	const child = h.children[0];
	child.emit({ type: "extension_ui_request", id: "ui-1", method: "setWidget", widgetKey: "x", widgetLines: [] });
	child.emit({ type: "extension_ui_request", id: "ui-2", method: "select", title: "Pick a database", options: ["postgres", "sqlite"] });
	await tick();
	assert.equal(h.member.status, "waiting-question");
	assert.deepEqual(h.member.dialogs, [{ id: "ui-2", method: "select", title: "Pick a database", options: ["postgres", "sqlite"] }]);
	assert.deepEqual(h.events.map(event => event.kind), ["dialog"]);
	child.emit({ type: "agent_settled", aborted: false });
	await tick();
	assert.equal(h.member.status, "idle");
	assert.deepEqual(h.member.dialogs, []);
	child.exit(1, null);
	await tick();
	assert.equal(h.member.status, "exited");
	assert.deepEqual(h.events.map(event => event.kind), ["dialog", "settled", "exit"]);
});

test("a prompt to a working member queues as a follow-up and steer uses the steer command", async () => {
	const h = harness();
	h.member.start();
	h.member.prompt("first");
	h.member.prompt("second");
	h.member.steer("change course");
	await tick();
	assert.deepEqual(h.children[0].written.map(command => [command.type, command.message, command.streamingBehavior]), [
		["prompt", "first", undefined],
		["prompt", "second", "followUp"],
		["steer", "change course", undefined],
	]);
});

test("steering an idle member starts a new prompt instead", async () => {
	const h = harness();
	h.member.start();
	await tick();
	assert.equal(h.member.status, "starting");
	h.member.steer("look at this");
	await tick();
	assert.deepEqual(h.children[0].written.map(command => command.type), ["prompt"]);
});

test("digest is one compact line built by code and detail stays bounded", async () => {
	const h = harness();
	h.member.start();
	h.member.prompt("go");
	await tick();
	const child = h.children[0];
	child.emit({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: {} });
	child.emit(todoEnd([{ id: 1, title: "Write routes", status: "in_progress" }, { id: 2, title: "Test", status: "pending" }]));
	child.emit(assistantEnd({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 12345, costTotal: 0.4567 }, `secret transcript ${"y".repeat(5000)}`));
	await tick();
	const line = h.member.digest();
	assert.equal(line.includes("\n"), false);
	assert.match(line, /^api \[working\]/);
	assert.match(line, /todo 0\/2 "Write routes"/);
	assert.match(line, /last tool todo/);
	assert.match(line, /12\.3k tok/);
	assert.match(line, /\$0\.46/);
	assert.doesNotMatch(line, /secret transcript/);
	const detail = h.member.detail();
	assert.match(detail, /Build the API/);
	assert.match(detail, /prefix 1\.0k tok/);
	assert.ok(detail.length < 1200, `detail is bounded (${detail.length})`);
});

test("stop closes stdin, then signals the owned process group after the grace period", async () => {
	const h = harness({ pid: 4242 });
	h.member.start();
	assert.equal(h.spawned[0].options.detached, true);
	h.member.stop();
	await tick();
	assert.equal(h.groupKills.length, 0, "stdin closes first");
	h.timers.at(-1)!.fn();
	assert.deepEqual(h.groupKills, [[-4242, "SIGTERM"]]);
	h.timers.at(-1)!.fn();
	assert.deepEqual(h.groupKills, [[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
});

test("stop on Windows kills the child handle only", async () => {
	const h = harness({ platform: "win32", pid: 7 });
	h.member.start();
	assert.equal(h.spawned[0].options.detached, false);
	h.member.stop();
	h.timers.at(-1)!.fn();
	assert.deepEqual(h.groupKills, []);
	assert.deepEqual(h.children[0].killed, ["SIGTERM"]);
});
