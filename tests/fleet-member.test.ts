import assert from "node:assert/strict";
import type { PassThrough } from "node:stream";
import test from "node:test";
import { CHILD_PACKAGE_INJECTION_ENV, encodeChildPackageInjection } from "../lib/child-package-injection.ts";
import { FLEET_ROLE_ENV } from "../lib/fleet-role.ts";
import { buildMemberLaunch, FleetMember, type FleetMemberEvent } from "../lib/fleet-member.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(options: { platform?: NodeJS.Platform; pid?: number; closeStdoutOnExit?: boolean } = {}) {
	const children: FakeChild[] = [];
	const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
	const events: FleetMemberEvent[] = [];
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	const groupKills: Array<[number, string]> = [];
	const member = new FleetMember({
		name: "api",
		objective: "Build the API",
		launch: { command: "pi", args: ["--mode", "rpc"], env: { PATH: "/bin" }, cwd: "/work/api" },
		stdoutDrainMs: 2000,
		spawn: (command, args, spawnOptions) => {
			spawned.push({ command, args, options: spawnOptions as unknown as Record<string, unknown> });
			const child = fakeChild({ pid: options.pid, exitOnStdinEnd: false, exitOnKill: false });
			// A real process closes its stdout when it exits; the fake does not.
			if (options.closeStdoutOnExit !== false) child.child.on("exit", () => (child.child.stdout as PassThrough | null)?.end());
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

// Verifier B1: a member pipe error must never crash the controller.
test("a stdin pipe error is recorded instead of crashing the controller", async () => {
	const h = harness();
	h.member.start();
	assert.doesNotThrow(() => h.children[0].child.stdin!.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
	assert.match(h.member.digest(), /error: write EPIPE/);
});

test("a stopping member refuses new commands and a second stop starts no second escalation", async () => {
	const h = harness({ pid: 4242 });
	h.member.start();
	h.member.prompt("go");
	await tick();
	h.member.stop();
	assert.equal(h.member.stopping, true);
	assert.equal(h.member.prompt("more"), false);
	assert.equal(h.member.steer("more"), false);
	await tick();
	assert.deepEqual(h.children[0].written.map(command => command.type), ["prompt"]);
	const timers = h.timers.length;
	h.member.stop();
	assert.equal(h.timers.length, timers, "no second escalation chain");
	h.timers.at(-1)!.fn();
	h.timers.at(-1)!.fn();
	assert.deepEqual(h.groupKills, [[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
});

// Verifier L10 advisory 2: lines the member wrote before exiting still count.
test("stdout lines that arrive after the process exit are still counted before the member exits", async () => {
	const h = harness({ closeStdoutOnExit: false });
	h.member.start();
	h.member.prompt("go");
	await tick();
	const child = h.children[0];
	// The process exit event can beat the last lines still in the stdout pipe.
	child.exit(0, null);
	child.emit(assistantEnd({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, costTotal: 0.25 }, "final answer"));
	child.emit({ type: "agent_settled", aborted: false });
	(child.child.stdout as PassThrough).end();
	await tick();
	assert.equal(h.member.status, "exited");
	assert.ok(h.timers.every(timer => timer.cancelled), "the stdout close finished the member, not the drain fallback");
	assert.equal(h.member.usage.totalTokens, 120, "the final message_end is counted");
	assert.ok(Math.abs(h.member.usage.cost - 0.25) < 1e-9);
	assert.equal(h.member.lastText, "final answer");
	assert.deepEqual(h.events.map(event => event.kind), ["settled", "exit"], "exit is reported last, once");
	assert.match(h.member.digest(), /120 tok · \$0\.25/);
});

test("a member whose stdout never closes still exits after the bounded drain and refuses commands meanwhile", async () => {
	const h = harness({ closeStdoutOnExit: false });
	h.member.start();
	h.member.prompt("go");
	await tick();
	const child = h.children[0];
	child.exit(0, null);
	await tick();
	assert.equal(h.member.prompt("more"), false, "an exited process takes no commands");
	child.emit(assistantEnd({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, costTotal: 0 }));
	await tick();
	assert.equal(h.member.usage.totalTokens, 10, "late lines count while draining");
	assert.deepEqual(h.events, []);
	const drain = h.timers.at(-1)!;
	assert.equal(drain.ms, 2000);
	drain.fn();
	assert.equal(h.member.status, "exited");
	assert.deepEqual(h.events, [{ kind: "exit", code: 0, signal: null }]);
	assert.equal(h.member.exitCode, 0);
});

test("inspect returns the detail plus a bounded activity tail and the member's ODD feature document", async () => {
	const h = harness();
	h.member.start();
	h.member.prompt("go");
	await tick();
	const child = h.children[0];
	for (let i = 0; i < 60; i++) child.emit({ type: "tool_execution_start", toolCallId: `r${i}`, toolName: i % 2 ? "read" : "grep", args: {} });
	child.emit({ type: "tool_execution_start", toolCallId: "e1", toolName: "edit", args: { path: "odd/tasks/billing-api.md", edits: [] } });
	child.emit(assistantEnd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costTotal: 0 }, `working on routes ${"z".repeat(3000)}`));
	child.emit({ type: "extension_ui_request", id: "q1", method: "select", title: "Pick a database", options: ["postgres", "sqlite"] });
	await tick();
	const inspected = h.member.inspect(5);
	assert.ok(inspected.startsWith(h.member.detail()), "starts with the detail");
	assert.match(inspected, /^feature document: \/work\/api\/odd\/tasks\/billing-api\.md$/m);
	const tail = inspected.slice(inspected.indexOf("recent activity")).split("\n");
	assert.equal(tail.length, 6);
	assert.equal(tail[0], "recent activity (last 5 of 63):");
	assert.deepEqual(tail.slice(1, 4), ["- tool grep", "- tool read", "- tool edit"]);
	assert.match(tail[4], /^- reply: working on routes z+…$/);
	assert.ok(tail[4].length <= 170, `a reply entry is bounded (${tail[4].length})`);
	assert.equal(tail[5], "- question (select): Pick a database [postgres | sqlite]");
	assert.ok(inspected.length < 2500, `inspect is bounded (${inspected.length})`);
	assert.equal(h.member.inspect(1000).split("\n").filter(line => line.startsWith("- ")).length, 63, "the tail holds every entry under its cap");
	const plain = harness();
	plain.member.start();
	await tick();
	assert.doesNotMatch(plain.member.inspect(40), /feature document/, "no document line when none appeared");
});
