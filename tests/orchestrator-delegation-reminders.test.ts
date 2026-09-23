import assert from "node:assert/strict";
import test from "node:test";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	DELEGATION_REMINDER_TYPE,
	EXPLORATION_MESSAGE,
	LONG_SESSION_MESSAGE,
	OrchestratorDelegationReminders,
	READ_FILES_MESSAGE,
	WRITE_FILES_MESSAGE,
	isExplorationTool,
	isOddTasksPath,
	isSkillsPath,
	normalizeReminderPath,
	reminderPathKey,
} from "../lib/orchestrator-delegation-reminders.ts";

const CWD = "/repo";

// ODR-1 unit contract: thresholds, scope exclusions, reset, collisions, and
// once-per-signal-per-interval. Delivery shape (customType, steer,
// triggerTurn, untouched result) is covered through the extension wiring
// tests at the bottom of this file.

function record(
	tracker: OrchestratorDelegationReminders,
	toolName: string,
	input: unknown = {},
	sessionId = "s1",
	isError = false,
	cwd = CWD,
): string | undefined {
	return tracker.record({ sessionId, toolName, input, cwd, isError });
}

function read(tracker: OrchestratorDelegationReminders, path: string, sessionId = "s1"): string | undefined {
	return record(tracker, "read", { path }, sessionId, false);
}

test("normalizeReminderPath strips a :line suffix but keeps genuine colons", () => {
	assert.equal(normalizeReminderPath("src/a.ts:1-500"), "src/a.ts");
	assert.equal(normalizeReminderPath("src/a.ts:10"), "src/a.ts");
	assert.equal(normalizeReminderPath("  src/a.ts:3  "), "src/a.ts");
	assert.equal(normalizeReminderPath("src/a.ts"), "src/a.ts");
	assert.equal(normalizeReminderPath("data:5"), "data:5");
});

test("isSkillsPath matches any skills segment, isOddTasksPath matches the pair", () => {
	assert.equal(isSkillsPath("skills/foo.md"), true);
	assert.equal(isSkillsPath("/x/skills/foo.md"), true);
	assert.equal(isSkillsPath("/x/askills/foo.md"), false);
	assert.equal(isSkillsPath("src/skillsy/a.ts"), false);
	assert.equal(isOddTasksPath("odd/tasks/thing.md"), true);
	assert.equal(isOddTasksPath("/repo/odd/tasks/thing.md"), true);
	assert.equal(isOddTasksPath("odd/other.md"), false);
	assert.equal(isOddTasksPath("src/oddish/tasks.md"), false);
});

test("reminderPathKey treats :line repeats as the same file", () => {
	assert.equal(reminderPathKey("src/a.ts:1-500", CWD), reminderPathKey("src/a.ts", CWD));
	assert.notEqual(reminderPathKey("src/a.ts", CWD), reminderPathKey("src/b.ts", CWD));
});

test("isExplorationTool matches exactly the four listed ids", () => {
	for (const name of ["read", "grep", "find", "codegraph_codegraph_explore"]) {
		assert.equal(isExplorationTool(name), true, name);
	}
	// Generic codegraph init/query and lookalike aliases are not explore
	// operations and must not count.
	for (const name of ["codegraph", "codegraph_explore", "ns.codegraph_explore", "bash", "edit", "write", "subagent_run", "mem_save", "ls"]) {
		assert.equal(isExplorationTool(name), false, name);
	}
});

test("3 distinct successful reads remind once per interval", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(read(tracker, "src/a.ts"), undefined);
	assert.equal(read(tracker, "src/b.ts"), undefined);
	assert.equal(read(tracker, "src/c.ts"), READ_FILES_MESSAGE);
	assert.equal(read(tracker, "src/d.ts"), undefined);
});

test("repeated reads and :line suffixed repeats add no new file", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(read(tracker, "src/a.ts"), undefined);
	assert.equal(read(tracker, "src/a.ts"), undefined);
	assert.equal(read(tracker, "src/a.ts:1-500"), undefined);
	assert.equal(read(tracker, "src/b.ts"), undefined);
	// Repeats are still exploration calls: the 5th read fires exploration
	// while the file set is still {a, b}, then the third distinct file
	// fires read-files next.
	assert.equal(read(tracker, "src/b.ts:10"), EXPLORATION_MESSAGE);
	assert.equal(read(tracker, "src/c.ts"), READ_FILES_MESSAGE);
});

test("odd/tasks and skills reads never count toward file or exploration signals", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(read(tracker, "odd/tasks/feature.md"), undefined);
	assert.equal(read(tracker, "skills/explore/SKILL.md"), undefined);
	assert.equal(read(tracker, "/abs/skills/deep/SKILL.md"), undefined);
	assert.equal(read(tracker, "src/a.ts"), undefined);
	assert.equal(read(tracker, "src/b.ts"), undefined);
	// Only a.ts + b.ts counted: the next distinct source read is the third.
	assert.equal(read(tracker, "src/c.ts"), READ_FILES_MESSAGE);
});

test("unsuccessful reads and writes count for nothing except the 20-call total", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(record(tracker, "read", { path: "src/a.ts" }, "s1", true), undefined);
	assert.equal(record(tracker, "write", { path: "src/a.ts", content: "x" }, "s1", true), undefined);
	assert.equal(read(tracker, "src/a.ts"), undefined);
	assert.equal(read(tracker, "src/b.ts"), undefined);
	assert.equal(read(tracker, "src/c.ts"), READ_FILES_MESSAGE);
});

test("5 eligible exploration calls remind", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(record(tracker, "grep", { pattern: "x" }), undefined);
	assert.equal(record(tracker, "find", { pattern: "*.ts" }), undefined);
	assert.equal(record(tracker, "codegraph_codegraph_explore", { query: "q" }), undefined);
	assert.equal(read(tracker, "src/a.ts"), undefined);
	assert.equal(record(tracker, "grep", { pattern: "y" }), EXPLORATION_MESSAGE);
	// Once per signal per interval: further exploration stays quiet.
	assert.equal(record(tracker, "grep", { pattern: "z" }), undefined);
});

test("exploration excludes odd/tasks everywhere but skills only for reads", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(read(tracker, "odd/tasks/feature.md"), undefined);
	assert.equal(read(tracker, "skills/x/SKILL.md"), undefined);
	assert.equal(record(tracker, "grep", { pattern: "x", path: "odd/tasks" }), undefined);
	assert.equal(record(tracker, "grep", { pattern: "x" }), undefined);
	assert.equal(record(tracker, "find", { pattern: "*.ts" }), undefined);
	assert.equal(record(tracker, "read", {}), undefined);
	assert.equal(record(tracker, "bash", { command: "ls" }), undefined);
});

test("grep and find over skills paths still count as exploration", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(record(tracker, "grep", { pattern: "x", path: "skills/y" }), undefined);
	assert.equal(record(tracker, "find", { pattern: "*.md", path: "skills/y" }), undefined);
	assert.equal(record(tracker, "grep", { pattern: "x", path: "skills/y" }), undefined);
	assert.equal(record(tracker, "grep", { pattern: "x", path: "skills/y" }), undefined);
	assert.equal(record(tracker, "find", { pattern: "*.md", path: "skills/y" }), EXPLORATION_MESSAGE);
});

test("odd/tasks grep/find paths never count as exploration", () => {
	const tracker = new OrchestratorDelegationReminders();
	for (let i = 0; i < 4; i++) {
		assert.equal(record(tracker, "grep", { pattern: "x", path: "odd/tasks" }), undefined);
		assert.equal(record(tracker, "find", { pattern: "*.md", path: "odd/tasks/area" }), undefined);
	}
	assert.equal(record(tracker, "grep", { pattern: "x" }), undefined);
	assert.equal(record(tracker, "grep", { pattern: "y" }), undefined);
	assert.equal(record(tracker, "grep", { pattern: "z" }), undefined);
	assert.equal(record(tracker, "find", { pattern: "*.ts" }), undefined);
	assert.equal(record(tracker, "grep", { pattern: "w" }), EXPLORATION_MESSAGE);
});

test("generic codegraph calls do not count; only the exact explore id does", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(record(tracker, "codegraph", { query: "q" }), undefined);
	assert.equal(record(tracker, "codegraph_explore", { query: "q" }), undefined);
	assert.equal(record(tracker, "ns.codegraph_explore", { query: "q" }), undefined);
	assert.equal(record(tracker, "codegraph", { query: "q" }), undefined);
	assert.equal(record(tracker, "codegraph_codegraph_explore", { query: "q" }), undefined);
	assert.equal(record(tracker, "codegraph_codegraph_explore", { query: "q" }), undefined);
	assert.equal(record(tracker, "codegraph_codegraph_explore", { query: "q" }), undefined);
	assert.equal(record(tracker, "codegraph_codegraph_explore", { query: "q" }), undefined);
	assert.equal(record(tracker, "codegraph_codegraph_explore", { query: "q" }), EXPLORATION_MESSAGE);
});

test("2 distinct successful writes remind once per interval", () => {
	const tracker = new OrchestratorDelegationReminders();
	const write = (path: string) => record(tracker, "write", { path, content: "x" });
	assert.equal(write("src/a.ts"), undefined);
	assert.equal(write("src/a.ts"), undefined);
	assert.equal(record(tracker, "edit", { path: "src/a.ts", edits: [] }), undefined);
	assert.equal(write("src/b.ts"), WRITE_FILES_MESSAGE);
	assert.equal(write("src/c.ts"), undefined);
});

test("odd/tasks writes are excluded from the write signal", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(record(tracker, "write", { path: "odd/tasks/notes.md", content: "x" }), undefined);
	assert.equal(record(tracker, "write", { path: "src/a.ts", content: "x" }), undefined);
	assert.equal(record(tracker, "write", { path: "src/b.ts", content: "x" }), WRITE_FILES_MESSAGE);
});

test("unsuccessful writes never count toward the write signal", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(record(tracker, "write", { path: "src/a.ts", content: "x" }, "s1", true), undefined);
	assert.equal(record(tracker, "edit", { path: "src/b.ts", edits: [] }, "s1", true), undefined);
	assert.equal(record(tracker, "write", { path: "src/a.ts", content: "x" }), undefined);
	assert.equal(record(tracker, "write", { path: "src/b.ts", content: "x" }), WRITE_FILES_MESSAGE);
});

test("20 mixed calls remind, including skills, odd/tasks, failures, unknown tools", () => {
	const tracker = new OrchestratorDelegationReminders();
	let message: string | undefined;
	const calls: Array<[string, unknown, boolean]> = [
		["read", { path: "skills/x/SKILL.md" }, false],
		["read", { path: "odd/tasks/n.md" }, false],
		["read", { path: "src/gone.ts" }, true],
		["brand_new_tool", {}, false],
		["bash", { command: "ls" }, false],
		["mem_save", { title: "t", content: "c" }, false],
	];
	for (let i = calls.length; i < 19; i++) calls.push(["bash", { command: `echo ${i}` }, i % 3 === 0]);
	for (const [toolName, input, isError] of calls) {
		message = record(tracker, toolName, input, "s1", isError);
		assert.equal(message, undefined);
	}
	message = record(tracker, "bash", { command: "echo last" });
	assert.equal(message, LONG_SESSION_MESSAGE);
	assert.equal(record(tracker, "bash", { command: "echo after" }), undefined);
});

test("simultaneous crossings emit only the most specific signal and suppress the rest", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(read(tracker, "src/a.ts"), undefined);
	assert.equal(read(tracker, "src/b.ts"), undefined);
	assert.equal(record(tracker, "grep", { pattern: "x" }), undefined);
	assert.equal(record(tracker, "grep", { pattern: "y" }), undefined);
	// Third distinct read is also the 5th exploration call: read-files wins,
	// exploration is consumed silently for this interval.
	assert.equal(read(tracker, "src/c.ts"), READ_FILES_MESSAGE);
	assert.equal(record(tracker, "grep", { pattern: "z" }), undefined);
	assert.equal(read(tracker, "src/d.ts"), undefined);
});

test("write wins when it collides with the long-session crossing", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(record(tracker, "write", { path: "src/a.ts", content: "x" }), undefined);
	for (let i = 0; i < 18; i++) {
		assert.equal(record(tracker, "bash", { command: `echo ${i}` }), undefined);
	}
	// Call 20 is also the 2nd distinct write: write wins, long-session
	// is consumed silently and never re-emits afterwards.
	assert.equal(record(tracker, "write", { path: "src/b.ts", content: "x" }), WRITE_FILES_MESSAGE);
	assert.equal(record(tracker, "bash", { command: "echo after" }), undefined);
});

test("successful subagent_run resets counts and fired flags; failed does not", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(read(tracker, "src/a.ts"), undefined);
	assert.equal(read(tracker, "src/b.ts"), undefined);
	assert.equal(record(tracker, "subagent_run", { agent: "worker" }, "s1", true), undefined);
	assert.equal(read(tracker, "src/c.ts"), READ_FILES_MESSAGE);
	assert.equal(record(tracker, "subagent_run", { agent: "worker" }, "s1", false), undefined);
	assert.equal(read(tracker, "src/d.ts"), undefined);
	assert.equal(read(tracker, "src/e.ts"), undefined);
	assert.equal(read(tracker, "src/f.ts"), READ_FILES_MESSAGE);
});

test("intervals are independent per session", () => {
	const tracker = new OrchestratorDelegationReminders();
	assert.equal(read(tracker, "src/a.ts", "s1"), undefined);
	assert.equal(read(tracker, "src/b.ts", "s1"), undefined);
	assert.equal(read(tracker, "src/a.ts", "s2"), undefined);
	assert.equal(read(tracker, "src/c.ts", "s1"), READ_FILES_MESSAGE);
	assert.equal(read(tracker, "src/b.ts", "s2"), undefined);
	assert.equal(read(tracker, "src/c.ts", "s2"), READ_FILES_MESSAGE);
});

// Extension wiring: post-tool next-decision delivery through the real
// registered tool_result hook. The result is never blocked or modified;
// the reminder rides as a steer message into the active turn only.

type AnyHandler = (event: any, ctx: any) => any;
type SentMessage = { message: Record<string, unknown>; options: Record<string, unknown> };

function wiringHarness(processEnv: NodeJS.ProcessEnv = {}): {
	handlers: Map<string, AnyHandler>;
	sent: SentMessage[];
} {
	const handlers = new Map<string, AnyHandler>();
	const sent: SentMessage[] = [];
	const pi = {
		on(name: string, handler: AnyHandler) { handlers.set(name, handler); },
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
		getFlag: () => undefined,
		getActiveTools: () => ["read", "edit", "write", "subagent_run"],
		sendMessage(message: Record<string, unknown>, options: Record<string, unknown> = {}) {
			sent.push({ message, options });
		},
		appendEntry() {},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv,
		resolveTelemetryTriggerBinary: () => "/usr/bin/true",
		telemetryTriggerSpawn: (() => undefined) as never,
	})(pi);
	return { handlers, sent };
}

function wiringCtx(sessionId: string, cwd: string, mode?: string): any {
	return {
		cwd,
		hasUI: false,
		...(mode === undefined ? {} : { mode }),
		ui: { notify() {} },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
	};
}

async function successfulResult(handlers: Map<string, AnyHandler>, ctx: any, toolName: string, input: unknown): Promise<unknown> {
	return handlers.get("tool_result")!(
		{ type: "tool_result", toolName, toolCallId: `${toolName}-${Math.random()}`, input, content: [], isError: false },
		ctx,
	);
}

test("wiring delivers the read-files reminder as steer without touching the result", async () => {
	const { handlers, sent } = wiringHarness();
	const ctx = wiringCtx("wiring-steer", "/repo");
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/a.ts" }), undefined);
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/b.ts" }), undefined);
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/c.ts" }), undefined);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.message.customType, DELEGATION_REMINDER_TYPE);
	assert.equal(sent[0]!.message.display, false);
	assert.equal(sent[0]!.message.content, READ_FILES_MESSAGE);
	assert.deepEqual(sent[0]!.options, { deliverAs: "steer", triggerTurn: true });
});

test("wiring never blocks tool_call", async () => {
	const { handlers } = wiringHarness();
	const ctx = wiringCtx("wiring-noblock", "/repo");
	assert.equal(await handlers.get("tool_call")!({ toolName: "read", input: { path: "src/a.ts" } }, ctx), undefined);
	assert.equal(await handlers.get("tool_call")!({ toolName: "write", input: { path: "src/a.ts", content: "x" } }, ctx), undefined);
});

test("wiring resets the interval after a successful subagent_run, not a failed one", async () => {
	const { handlers, sent } = wiringHarness();
	const ctx = wiringCtx("wiring-reset", "/repo");
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/a.ts" }), undefined);
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/b.ts" }), undefined);
	await handlers.get("tool_result")!(
		{ type: "tool_result", toolName: "subagent_run", toolCallId: "delegated-1", input: {}, content: [], isError: true },
		ctx,
	);
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/c.ts" }), undefined);
	assert.equal(sent.length, 1, "a failed delegation must not reset the interval");
	assert.equal(sent[0]!.message.content, READ_FILES_MESSAGE);

	const ctx2 = wiringCtx("wiring-reset-ok", "/repo");
	assert.equal(await successfulResult(handlers, ctx2, "read", { path: "src/a.ts" }), undefined);
	assert.equal(await successfulResult(handlers, ctx2, "read", { path: "src/b.ts" }), undefined);
	await handlers.get("tool_result")!(
		{ type: "tool_result", toolName: "subagent_run", toolCallId: "delegated-2", input: {}, content: [], isError: false },
		ctx2,
	);
	const before = sent.length;
	assert.equal(await successfulResult(handlers, ctx2, "read", { path: "src/c.ts" }), undefined);
	assert.equal(await successfulResult(handlers, ctx2, "read", { path: "src/d.ts" }), undefined);
	assert.equal(sent.length, before, "a successful delegation resets the interval silently");
	assert.equal(await successfulResult(handlers, ctx2, "read", { path: "src/e.ts" }), undefined);
});

test("wiring stays quiet for RPC children and agent-child processes", async () => {
	const { handlers, sent } = wiringHarness();
	const rpc = wiringCtx("wiring-rpc", "/repo", "rpc");
	assert.equal(await successfulResult(handlers, rpc, "read", { path: "src/a.ts" }), undefined);
	assert.equal(await successfulResult(handlers, rpc, "read", { path: "src/b.ts" }), undefined);
	assert.equal(await successfulResult(handlers, rpc, "read", { path: "src/c.ts" }), undefined);
	assert.deepEqual(sent, []);

	const child = wiringHarness({ GENTLE_PI_AGENTS_CHILD: "1" });
	const childCtx = wiringCtx("wiring-child", "/repo");
	assert.equal(await successfulResult(child.handlers, childCtx, "read", { path: "src/a.ts" }), undefined);
	assert.equal(await successfulResult(child.handlers, childCtx, "read", { path: "src/b.ts" }), undefined);
	assert.equal(await successfulResult(child.handlers, childCtx, "read", { path: "src/c.ts" }), undefined);
	assert.deepEqual(child.sent, []);
});

test("wiring stays quiet inside named-agent loops and resumes for the primary loop", async () => {
	const { handlers, sent } = wiringHarness();
	const ctx = wiringCtx("wiring-named", "/repo");
	await handlers.get("before_agent_start")!({ agentName: "worker", systemPrompt: "child" }, ctx);
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/a.ts" }), undefined);
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/b.ts" }), undefined);
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/c.ts" }), undefined);
	assert.deepEqual(sent, [], "an SDD executor or worker loop must not receive parent reminders");
	await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/a.ts" }), undefined);
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/b.ts" }), undefined);
	assert.equal(await successfulResult(handlers, ctx, "read", { path: "src/c.ts" }), undefined);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.message.content, READ_FILES_MESSAGE);
});

test("malformed inputs never throw and still feed the long-session total", () => {
	const tracker = new OrchestratorDelegationReminders();
	const seen: Array<string | undefined> = [];
	for (let i = 0; i < 10; i++) {
		assert.doesNotThrow(() => {
			seen.push(record(tracker, "read", undefined));
			seen.push(record(tracker, "read", { path: 42 }));
			seen.push(record(tracker, "write", null));
		});
	}
	// 30 malformed results: exactly one long-session reminder at call 20.
	assert.equal(seen.filter((message) => message === LONG_SESSION_MESSAGE).length, 1);
	assert.equal(seen[19], LONG_SESSION_MESSAGE);
});
