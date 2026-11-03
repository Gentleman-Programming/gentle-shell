import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PassThrough } from "node:stream";
import test from "node:test";
import { CHILD_PACKAGE_INJECTION_ENV, encodeChildPackageInjection } from "../lib/child-package-injection.ts";
import { FLEET_ROLE_ENV } from "../lib/fleet-role.ts";
import { buildMemberLaunch, FleetMember, latestMemberSessionFile, type FleetMemberEvent } from "../lib/fleet-member.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(options: { platform?: NodeJS.Platform; pid?: number; closeStdoutOnExit?: boolean } = {}) {
	const children: FakeChild[] = [];
	const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
	const events: FleetMemberEvent[] = [];
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	const groupKills: Array<[number, string]> = [];
	const counts = { changes: 0, subagents: 0 };
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
		onChange: () => { counts.changes += 1; },
		onSubagents: () => { counts.subagents += 1; },
	});
	return { member, children, spawned, events, timers, groupKills, counts };
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
	assert.match(line, /1\.5k new tok/, "new tokens: input + output + cache write");
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
	assert.match(h.member.digest(), /120 new tok · \$0\.25/);
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
	// T2b (L32): the cwd resolves the member's own Engram project.
	assert.match(inspected, /^cwd: \/work\/api$/m);
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

// T3 (S2): the fleet answers member dialogs with the RPC response shapes of
// pi-coding-agent docs/rpc-extension-ui.md:176-193; protected ones only by code.

async function waitingMember() {
	const h = harness();
	h.member.start();
	h.member.prompt("go");
	await tick();
	return { h, child: h.children[0] };
}

const responses = (child: FakeChild) => child.written.filter(command => command.type === "extension_ui_response");

test("answer writes the exact RPC response for each dialog method and clears the dialog", async () => {
	const { h, child } = await waitingMember();
	child.emit({ type: "extension_ui_request", id: "s1", method: "select", title: "Pick a database", options: ["postgres", "sqlite"] });
	child.emit({ type: "extension_ui_request", id: "s2", method: "select", title: "Pick a region", options: ["eu", "us"] });
	child.emit({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Use the cache?" });
	child.emit({ type: "extension_ui_request", id: "i1", method: "input", title: "Release name" });
	child.emit({ type: "extension_ui_request", id: "e1", method: "editor", title: "Edit notes", prefill: "a" });
	child.emit({ type: "extension_ui_request", id: "x1", method: "confirm", title: "Continue?" });
	await tick();
	assert.equal(h.member.answer({ answer: "sqlite" }).ok, true, "defaults to the oldest pending dialog");
	assert.equal(h.member.answer({ answer: "2" }, "s2").ok, true);
	assert.equal(h.member.answer({ answer: "no" }, "c1").ok, true);
	assert.equal(h.member.answer({ answer: "v1.2" }, "i1").ok, true);
	assert.equal(h.member.answer({ answer: "line 1\nline 2" }, "e1").ok, true);
	assert.equal(h.member.status, "waiting-question", "one dialog is still pending");
	assert.equal(h.member.answer({ cancel: true }).ok, true);
	await tick();
	assert.deepEqual(responses(child), [
		{ id: "s1", type: "extension_ui_response", value: "sqlite" },
		{ id: "s2", type: "extension_ui_response", value: "us" },
		{ id: "c1", type: "extension_ui_response", confirmed: false },
		{ id: "i1", type: "extension_ui_response", value: "v1.2" },
		{ id: "e1", type: "extension_ui_response", value: "line 1\nline 2" },
		{ id: "x1", type: "extension_ui_response", cancelled: true },
	]);
	assert.deepEqual(h.member.dialogs, []);
	assert.equal(h.member.status, "working", "the answered member runs on");
});

test("an invalid or unknown answer is refused and nothing is written", async () => {
	const { h, child } = await waitingMember();
	child.emit({ type: "extension_ui_request", id: "s1", method: "select", title: "Pick a database", options: ["postgres", "sqlite"] });
	await tick();
	const wrong = h.member.answer({ answer: "mysql" });
	assert.equal(wrong.ok, false);
	if (!wrong.ok) assert.match(wrong.error, /not one of the offered options/);
	const missing = h.member.answer({ answer: "sqlite" }, "nope");
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.match(missing.error, /no pending dialog "nope"/);
	await tick();
	assert.deepEqual(responses(child), []);
	assert.equal(h.member.dialogs.length, 1, "the dialog stays pending");
	assert.equal(h.member.status, "waiting-question");
});

test("a protected dialog is marked, refused to the fleet's answer, and answered only through respond", async () => {
	const { h, child } = await waitingMember();
	child.emit({ type: "extension_ui_request", id: "g1", method: "confirm", title: "Allow recognized data-loss command?", message: "rm -rf build" });
	await tick();
	assert.deepEqual(h.member.dialogs[0].protected, { class: "destructive", marker: "data-loss command" });
	const refused = h.member.answer({ answer: "yes" });
	assert.equal(refused.ok, false);
	if (!refused.ok) assert.match(refused.error, /relayed to the human/);
	await tick();
	assert.deepEqual(responses(child), []);
	assert.equal(h.member.respond("g1", { confirmed: true }), true);
	await tick();
	assert.deepEqual(responses(child), [{ id: "g1", type: "extension_ui_response", confirmed: true }]);
	assert.deepEqual(h.member.dialogs, []);
});

test("a protected dialog keeps its full text for the human relay while the digest stays bounded", async () => {
	const { h, child } = await waitingMember();
	const title = `Authorize cross-orchestrator message to peer?\nReason: ${"r".repeat(600)}`;
	child.emit({ type: "extension_ui_request", id: "m1", method: "select", title, options: ["Allow once", "Allow for this session", "Deny"] });
	await tick();
	assert.equal(h.member.dialogs[0].relay?.title, title);
	assert.ok(h.member.dialogs[0].title.length <= 300);
	assert.match(h.member.digest(), /question \(relayed to the human\): Authorize cross-orchestrator/);
});

test("buildMemberLaunch strips the parent's autonomy override so a member never starts with standing permissions", () => {
	const launch = buildMemberLaunch({ env: { PATH: "/bin", GENTLE_PI_AUTONOMOUS_MODE: "1", GENTLE_PI_AGENTS_PARENT_PERMISSION_FD: "3" }, cwd: "/w", sessionDir: "/s", pi: { command: "pi", args: [] } });
	for (const key of ["GENTLE_PI_AUTONOMOUS_MODE", "GENTLE_PI_AGENTS_PARENT_PERMISSION_FD"]) assert.equal(key in launch.env, false, key);
	assert.equal(launch.env.PATH, "/bin");
});

// T6 (S2, S3): a resumed member continues its own session file in its session dir.
test("buildMemberLaunch with a session file reopens that session in the member's session dir", () => {
	const launch = buildMemberLaunch({ env: {}, cwd: "/w", sessionDir: "/s", sessionFile: "/s/2026-11-02T12-00-00-000Z_abc.jsonl", pi: { command: "pi", args: [] } });
	assert.deepEqual(launch.args, ["--mode", "rpc", "--session-dir", "/s", "--session", "/s/2026-11-02T12-00-00-000Z_abc.jsonl"]);
});

test("latestMemberSessionFile picks the newest .jsonl of a member's session dir, or none", () => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-fleet-member-sessions-"));
	assert.equal(latestMemberSessionFile(join(dir, "missing")), undefined);
	assert.equal(latestMemberSessionFile(dir), undefined);
	writeFileSync(join(dir, "notes.txt"), "x");
	writeFileSync(join(dir, "2026-11-02T10-00-00-000Z_old.jsonl"), "{}\n");
	writeFileSync(join(dir, "2026-11-02T11-00-00-000Z_new.jsonl"), "{}\n");
	utimesSync(join(dir, "2026-11-02T10-00-00-000Z_old.jsonl"), new Date("2026-11-02T10:00:00Z"), new Date("2026-11-02T10:00:00Z"));
	utimesSync(join(dir, "2026-11-02T11-00-00-000Z_new.jsonl"), new Date("2026-11-02T11:00:00Z"), new Date("2026-11-02T11:00:00Z"));
	assert.equal(latestMemberSessionFile(dir), join(dir, "2026-11-02T11-00-00-000Z_new.jsonl"));
});

test("a resumed member keeps counting from its earlier tokens and cost", async () => {
	const fake = fakeChild();
	const member = new FleetMember({
		name: "api",
		launch: { command: "pi", args: [], env: {}, cwd: "/w" },
		usage: { totalTokens: 1200, cost: 0.5 },
		spawn: () => fake.child,
		schedule: () => () => {},
	});
	member.start();
	assert.deepEqual([member.usage.totalTokens, member.usage.cost], [1200, 0.5]);
	fake.emit(assistantEnd({ input: 10, output: 5, totalTokens: 15, costTotal: 0.25 }));
	await tick();
	assert.deepEqual([member.usage.totalTokens, member.usage.cost], [1215, 0.75]);
});

// T8 (L54): 933k "tokens" were ~95% cache reads, so the digest misled. The
// digest shows NEW tokens (input + output + cache write) next to the cost;
// detail and inspect keep the full breakdown.
test("the digest shows new tokens and cost, never the cache-inclusive total; detail and inspect keep the breakdown", async () => {
	const h = harness();
	h.member.start();
	h.member.prompt("go");
	await tick();
	const child = h.children[0];
	child.emit(assistantEnd({ input: 20000, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 22000, costTotal: 1 }));
	child.emit(assistantEnd({ input: 1000, output: 3000, cacheRead: 880000, cacheWrite: 25000, totalTokens: 909000, costTotal: 0.65 }));
	await tick();
	assert.equal(h.member.newTokens, 51000);
	const line = h.member.digest();
	assert.match(line, / · 51\.0k new tok · \$1\.65/);
	assert.doesNotMatch(line, /931\.0k|880\.0k/, "no cache-inclusive total in the digest");
	for (const text of [h.member.detail(), h.member.inspect(5)]) {
		assert.match(text, /^tokens: 51\.0k new \(input 21\.0k, output 5\.0k, cache write 25\.0k\) · 880\.0k cached · 931\.0k with cache$/m);
		assert.match(text, /^prefix 20\.0k tok$/m);
	}
});

test("a resumed member keeps counting its new and cached tokens", async () => {
	const fake = fakeChild();
	const member = new FleetMember({
		name: "api",
		launch: { command: "pi", args: [], env: {}, cwd: "/w" },
		usage: { totalTokens: 50000, cost: 0.5, newTokens: 8000, cacheRead: 42000 },
		spawn: () => fake.child,
		schedule: () => () => {},
	});
	member.start();
	assert.deepEqual([member.newTokens, member.usage.cacheRead], [8000, 42000]);
	fake.emit(assistantEnd({ input: 10, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 115, costTotal: 0.25 }));
	await tick();
	assert.deepEqual([member.newTokens, member.usage.cacheRead, member.usage.totalTokens], [8015, 42100, 50115]);
	assert.match(member.digest(), /8\.0k new tok · \$0\.75/);
});

// --- T10 (S9): a member's own subagents, from the gentle-agents activity
// widget it already pushes over RPC (lib/agents-rpc-publisher.ts).

function activityTask(id: string, overrides: Record<string, unknown> = {}, items: unknown[] = []) {
	return {
		summary: { id, agent: "sdd-apply", label: "Write the invite routes", prompt: "p", status: "running", createdAt: 1000, startedAt: 2000, endedAt: null, lastStep: "tool edit", lastActivityAt: 3000, turns: 2, toolCalls: 3, error: null, ...overrides },
		thread: { version: 4, dropped: 0, items },
	};
}

function activityWidget(tasks: unknown[], extra: Record<string, unknown> = {}) {
	const activity = { schema: "gentle-agents.activity/v1", summary: { running: tasks.length, queued: 0, waiting: 0, finished: 0 }, tasks, ...extra };
	return { type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "gentle-agents", widgetLines: [JSON.stringify(activity)] };
}

async function startedMember() {
	const h = harness();
	h.member.start();
	h.member.prompt("go");
	await tick();
	return { ...h, child: h.children[0] };
}

test("a member keeps its latest gentle-agents activity as its subagents, without waking the controller or changing its digest", async () => {
	const h = await startedMember();
	const digest = h.member.digest();
	const changes = h.counts.changes;
	assert.deepEqual(h.member.subagents(), []);
	h.child.emit(activityWidget([activityTask("t1", {}, [
		{ kind: "text", text: "Reading the routes\nnext line" },
		{ kind: "tool", name: "edit", args: "{\"path\":\"a.ts\"}", running: true, isError: false, output: "patched" },
	])]));
	await tick();
	const [subagent] = h.member.subagents();
	assert.equal(h.member.subagents().length, 1);
	assert.deepEqual(
		[subagent.task.id, subagent.task.agent, subagent.task.label, subagent.task.status, subagent.task.lastStep, subagent.task.startedAt, subagent.task.endedAt],
		["t1", "sdd-apply", "Write the invite routes", "running", "tool edit", 2000, null],
	);
	assert.deepEqual(subagent.thread.items, [
		{ kind: "text", text: "Reading the routes\nnext line" },
		{ kind: "tool", callId: "1", name: "edit", args: {}, running: true, isError: false, output: "patched" },
	]);
	assert.equal(h.counts.subagents, 1, "the modal hears about it");
	assert.equal(h.counts.changes, changes, "no member change: no ledger, widget or digest refresh");
	assert.deepEqual(h.events, [], "never a wake");
	assert.equal(h.member.digest(), digest);
	assert.deepEqual(h.member.dialogs, []);
	assert.equal(h.member.status, "working");
	// The next push replaces the previous one.
	h.child.emit(activityWidget([activityTask("t2", { status: "completed", endedAt: 5000 })]));
	await tick();
	assert.deepEqual(h.member.subagents().map(entry => [entry.task.id, entry.task.status]), [["t2", "completed"]]);
});

test("a malformed or foreign activity payload is ignored and the last good one is kept; a cleared widget clears it", async () => {
	const h = await startedMember();
	h.child.emit(activityWidget([activityTask("t1")]));
	await tick();
	const bad = [
		{ ...activityWidget([activityTask("x")]), widgetLines: ["not json"] },
		{ ...activityWidget([activityTask("x")]), widgetLines: [JSON.stringify({ schema: "other/v1", tasks: [] })] },
		{ ...activityWidget([activityTask("x")]), widgetLines: [JSON.stringify({ schema: "gentle-agents.activity/v1", tasks: "nope" })] },
		{ ...activityWidget([activityTask("x")]), widgetLines: "a string" },
		{ ...activityWidget([activityTask("x")]), widgetLines: [42] },
		{ ...activityWidget([activityTask("x")]), widgetLines: [`${JSON.stringify({ schema: "gentle-agents.activity/v1", tasks: [] })}${" ".repeat(600 * 1024)}`] },
	];
	for (const event of bad) h.child.emit(event);
	await tick();
	assert.deepEqual(h.member.subagents().map(entry => entry.task.id), ["t1"]);
	assert.equal(h.counts.subagents, 1);
	// Entries that do not fit are skipped one by one.
	h.child.emit(activityWidget([activityTask("t3"), activityTask("", {}), activityTask("t4", { status: "dancing" }), { summary: null }, "x", activityTask("t5", {}, [{ kind: "image", data: "z" }, { kind: "text", text: 7 }])]));
	await tick();
	assert.deepEqual(h.member.subagents().map(entry => entry.task.id), ["t3", "t5"]);
	assert.deepEqual(h.member.subagents()[1].thread.items, [{ kind: "text", text: "" }]);
	h.child.emit({ type: "extension_ui_request", id: "w9", method: "setWidget", widgetKey: "gentle-agents" });
	await tick();
	assert.deepEqual(h.member.subagents(), []);
});

test("member subagents are bounded and stripped of terminal control sequences", async () => {
	const h = await startedMember();
	const items = Array.from({ length: 90 }, (_, index) => ({ kind: "note", text: `n${index}` }));
	const tasks = Array.from({ length: 80 }, (_, index) => activityTask(`t${index}`, index === 0 ? { label: `\x1b[31mred\x1b[0m ${"l".repeat(900)}`, agent: "a\u0007b" } : {}, index === 0 ? items : []));
	h.child.emit(activityWidget(tasks));
	await tick();
	const subagents = h.member.subagents();
	assert.equal(subagents.length, 50);
	const first = subagents[0];
	assert.equal(first.task.agent, "ab");
	assert.ok(first.task.label.startsWith("red l") && first.task.label.length <= 300, first.task.label.slice(0, 20));
	assert.equal(first.thread.items.length, 40);
	assert.deepEqual([first.thread.items[0], first.thread.dropped], [{ kind: "note", text: "n50" }, 50]);
});

test("an exited member keeps no subagents: its process group took them down", async () => {
	const h = await startedMember();
	h.child.emit(activityWidget([activityTask("t1")]));
	await tick();
	h.child.exit(0, null);
	await tick();
	assert.equal(h.member.status, "exited");
	assert.deepEqual(h.member.subagents(), []);
	assert.equal(h.counts.subagents, 2);
});

// Pinned (T10): every other non-dialog UI request is still dropped.
test("other non-dialog UI requests are still dropped: no subagents, dialog, wake or digest change", async () => {
	const h = await startedMember();
	const digest = h.member.digest();
	const changes = h.counts.changes;
	for (const event of [
		{ type: "extension_ui_request", id: "u1", method: "setWidget", widgetKey: "gentle-todo", widgetLines: [JSON.stringify({ schema: "gentle-agents.activity/v1", summary: {}, tasks: [activityTask("t1")] })] },
		{ type: "extension_ui_request", id: "u2", method: "notify", message: "hello", notifyType: "info" },
		{ type: "extension_ui_request", id: "u3", method: "setStatus", statusKey: "k", statusText: "busy" },
		{ type: "extension_ui_request", id: "u4", method: "setTitle", title: "pi" },
		{ type: "extension_ui_request", id: "u5", method: "set_editor_text", text: "x" },
	]) h.child.emit(event);
	await tick();
	assert.deepEqual(h.member.subagents(), []);
	assert.deepEqual(h.member.dialogs, []);
	assert.deepEqual(h.events, []);
	assert.deepEqual([h.counts.changes, h.counts.subagents], [changes, 0]);
	assert.equal(h.member.digest(), digest);
	assert.deepEqual(h.children[0].written.filter(command => command.type === "extension_ui_response"), []);
});
