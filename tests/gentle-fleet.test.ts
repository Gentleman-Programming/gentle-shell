import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleFleet, { FLEET_DIGEST_MESSAGE_TYPE, FLEET_WAKE_WINDOW_MS, type FleetDeps } from "../extensions/gentle-fleet.ts";
import { DEFAULT_MAX_LIVE_MEMBERS } from "../lib/fleet-config.ts";
import type { FleetLedgerState } from "../lib/fleet-ledger.ts";
import { runGit } from "../lib/fleet-worktree.ts";
import gentleAgents, { type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { writeJsonFileAtomicallySync } from "../lib/agent-profiles.ts";
import { FLEET_ROLE_ENV } from "../lib/fleet-role.ts";
import type { PermissionMode } from "../lib/permission-mode-policy.ts";
import { registerYoloSessionPolicy } from "../lib/yolo-session-policy.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
// Scratch stays outside the worktree; it is reported, not removed.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gentle-fleet-test-")));
const controllerEnv = { PATH: "/bin", [FLEET_ROLE_ENV]: "controller" };

type Tool = { name: string; execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: ExtensionContext): Promise<{ content: Array<{ text: string }>; details?: unknown }> };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

// Tools other extensions and Pi register in a full session, besides the fleet's.
const MEMORY_TOOLS = ["mem_search", "mem_save", "mem_context", "mem_get_observation", "mem_current_project", "mem_update", "mem_delete", "mem_session_summary", "mem_judge", "mem_timeline", "mem_stats"];
const OTHER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "codemode", "orchestrator_session_id", "ask_user_question", "ask_user_choice", ...MEMORY_TOOLS, "subagent_run", "hidden_mem_tool"];

function fakePi(events: { on(...args: unknown[]): unknown; emit(...args: unknown[]): unknown } = { on: () => () => {}, emit() {} }) {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const registered = [...OTHER_TOOLS];
	let active = OTHER_TOOLS.filter(name => name !== "hidden_mem_tool");
	const activeSets: string[][] = [];
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: Tool) => {
			tools.set(tool.name, tool);
			registered.push(tool.name);
			active.push(tool.name);
		},
		sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => sent.push({ message, options }),
		registerCommand() {},
		events,
		getAllTools: () => registered.map(name => ({ name, exposure: name === "hidden_mem_tool" ? "hidden" : "direct" })),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			activeSets.push([...names]);
			active = names.filter(name => registered.includes(name));
		},
	} as unknown as ExtensionAPI;
	const fire = async (name: string, ctx: ExtensionContext, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const activate = (name: string) => { registered.push(name); active.push(name); };
	return { pi, tools, handlers, sent, fire, activeSets, activeTools: () => [...active], activate };
}

const mainCwd = join(scratch, "main");

function fakeContext(sessionId = "fleet-session-1", cwd = mainCwd) {
	const widgets = new Map<string, string[] | undefined>();
	const notices: Array<[string, string]> = [];
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: { setWidget: (key: string, lines: string[] | undefined) => widgets.set(key, lines), setStatus() {}, notify: (message: string, level: string) => notices.push([message, level]) },
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
	return { ctx, widgets, notices };
}

let harnesses = 0;

type HarnessOptions = {
	fleetConfig?: Record<string, unknown> | string;
	/** The controller's live permission mode; null reads it through the real yolo channel. */
	permissionMode?: (() => Promise<PermissionMode>) | null;
	events?: Parameters<typeof fakePi>[0];
};

function harness(env: NodeJS.ProcessEnv = controllerEnv, options: HarnessOptions = {}) {
	harnesses += 1;
	const h = fakePi(options.events);
	const agentHome = join(scratch, `agent-${harnesses}`);
	// Never the user's config home: each harness owns its fleet.json.
	const configHome = join(scratch, `config-${harnesses}`);
	if (options.fleetConfig !== undefined) {
		mkdirSync(configHome, { recursive: true });
		writeFileSync(join(configHome, "fleet.json"), typeof options.fleetConfig === "string" ? options.fleetConfig : JSON.stringify(options.fleetConfig));
	}
	const gitCalls: string[][] = [];
	const writes: string[] = [];
	const children: FakeChild[] = [];
	const spawned: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	const deps: Partial<FleetDeps> = {
		spawn: (command, args, options) => {
			spawned.push({ command, args, cwd: options.cwd, env: options.env });
			const child = fakeChild({ exitOnKill: true });
			// A real process closes its stdout when it exits; the fake does not.
			child.child.on("exit", () => (child.child.stdout as PassThrough | null)?.end());
			children.push(child);
			return child.child;
		},
		schedule: (fn, ms) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		},
		pi: { command: "pi", args: [] },
		agentHome,
		process: { platform: "darwin", kill() {} },
		now: () => new Date("2026-11-02T12:00:00.000Z"),
		writeFile: (path, text) => {
			writes.push(path);
			writeJsonFileAtomicallySync(path, text);
		},
		configHome,
		git: (args, cwd) => {
			gitCalls.push(args);
			return runGit(args, cwd);
		},
		permissionMode: options.permissionMode === null ? undefined : options.permissionMode ?? (async () => "normal"),
	};
	gentleFleet(h.pi, env, deps);
	const runTimers = () => {
		for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
	};
	const wakeTimers = () => timers.filter(timer => timer.ms === FLEET_WAKE_WINDOW_MS && !timer.cancelled);
	return { ...h, children, spawned, timers, runTimers, wakeTimers, writes, agentHome, configHome, gitCalls };
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
	assert.deepEqual([...harness().tools.keys()].sort(), ["fleet_answer", "fleet_grant", "fleet_inspect", "fleet_objective", "fleet_revoke", "fleet_send", "fleet_spawn", "fleet_status", "fleet_stop"]);
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
	assert.equal(launch.cwd, mainCwd, "cwd defaults to the controller session cwd");
	assert.equal(launch.env[FLEET_ROLE_ENV], "member");
	const dir = launch.args[launch.args.indexOf("--session-dir") + 1];
	assert.equal(dir, join(h.agentHome, "gentle-fleet", "sessions", "fleet-session-1", "api"));
	assert.deepEqual(launch.args.slice(-2), ["--model", "anthropic/claude-sonnet-5-5"]);
	assert.deepEqual(h.children[0].written[0], { id: "api-1", type: "prompt", message: "Own the api front" });
	await spawnMember(h, ctx, "web", { cwd: "/work/web" });
	assert.equal(h.spawned[1].cwd, "/work/web");
});

test(`with no fleet.json fleet_spawn caps live members at ${DEFAULT_MAX_LIVE_MEMBERS} and rejects a duplicate live name`, async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
	for (const name of names) assert.match((await spawnMember(h, ctx, name)).content[0].text, /^Spawned/, name);
	const duplicate = await spawnMember(h, ctx, "a");
	assert.match(duplicate.content[0].text, /already/);
	const ninth = await spawnMember(h, ctx, "i");
	assert.equal(ninth.content[0].text, `Error: the fleet runs at most 8 live members (maxLiveMembers in ${join(h.configHome, "fleet.json")}). Send the work to an existing member or stop one first.`);
	assert.equal(h.spawned.length, 8);
	await h.tools.get("fleet_stop")!.execute("stop", { name: "a" }, undefined, undefined, ctx);
	await tick();
	await spawnMember(h, ctx, "i");
	assert.equal(h.spawned.length, 9, "a stopped member frees its slot");
	assert.equal(existsSync(h.configHome), false, "the controller never writes the fleet config");
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
	assert.equal(h.wakeTimers().length, 0, "tool activity schedules no wake");
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

// --- T2 (S2, S5): fleet objective, general fleet document, ledger, inspect.

const readLedger = (h: ReturnType<typeof harness>, session = "fleet-session-1") =>
	JSON.parse(readFileSync(join(h.agentHome, "gentle-fleet", "sessions", session, "ledger.json"), "utf8")) as FleetLedgerState;

test("fleet_objective names the fleet and writes the general fleet document by code at once", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const result = await h.tools.get("fleet_objective")!.execute("o1", { title: "Billing API v2", objective: "Ship the billing API with tests." }, undefined, undefined, ctx);
	const path = join(mainCwd, "odd", "fleet", "billing-api-v2.md");
	assert.match(result.content[0].text, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.equal((result.details as { gentleFleet: { documentPath: string } }).gentleFleet.documentPath, path);
	const doc = readFileSync(path, "utf8");
	assert.match(doc, /^# Fleet: Billing API v2$/m);
	assert.match(doc, /^Objective: Ship the billing API with tests\.$/m);
	assert.match(doc, /^Fleet session: `fleet-session-1`$/m);
	assert.equal(readLedger(h).objective, "Ship the billing API with tests.");
	const empty = await h.tools.get("fleet_objective")!.execute("o2", { title: "  ", objective: "x" }, undefined, undefined, ctx);
	assert.match(empty.content[0].text, /^Error: /);
});

test("member spawn, settle, question, send, stop and exit land in the ledger and the document", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await h.tools.get("fleet_objective")!.execute("o1", { title: "Billing", objective: "Ship billing." }, undefined, undefined, ctx);
	await spawnMember(h, ctx, "api");
	await spawnMember(h, ctx, "web", { cwd: "/work/web" });
	await tick();
	const [api, web] = h.children;
	api.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "todo", isError: false, result: { content: [], details: { gentleTodo: { tasks: [{ id: 1, title: "Design", status: "done" }, { id: 2, title: "Routes", status: "in_progress" }], nextId: 3, updatedTurn: 1 } } } });
	api.emit({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 1000, output: 234, cacheRead: 0, cacheWrite: 0, totalTokens: 1234, cost: { total: 0.5 } } } });
	api.emit({ type: "agent_settled", aborted: false });
	web.emit({ type: "extension_ui_request", id: "q1", method: "select", title: "Pick a database", options: ["postgres", "sqlite"] });
	await tick();
	await h.tools.get("fleet_send")!.execute("s1", { name: "api", message: "add docs", mode: "steer" }, undefined, undefined, ctx);
	await h.tools.get("fleet_stop")!.execute("st", { name: "web" }, undefined, undefined, ctx);
	await tick();
	h.runTimers();
	const doc = readFileSync(join(mainCwd, "odd", "fleet", "billing.md"), "utf8");
	assert.match(doc, /^\| api \| Own the api front \| working \| 1\/2 \| Routes \| 1\.2k \/ \$0\.50 \| — \| — \| — \|$/m);
	assert.match(doc, /^\| web \| Own the web front \| exited \|/m);
	const log = doc.slice(doc.indexOf("## Log"));
	assert.deepEqual([...log.matchAll(/^- \S+ · (\w+) · (\S+)/gm)].map(match => `${match[1]}:${match[2]}`), ["objective:fleet", "spawn:api", "spawn:web", "settle:api", "question:web", "send:api", "stop:web", "exit:web"]);
	const saved = readLedger(h);
	assert.deepEqual(saved.members.map(member => [member.name, member.cwd, member.status]), [["api", mainCwd, "working"], ["web", "/work/web", "exited"]]);
	assert.equal(saved.members[1].exitCode, 0);
	assert.equal(saved.members[1].exitedAt, "2026-11-02T12:00:00.000Z");
	assert.equal(saved.log.find(entry => entry.kind === "question")?.text, "Pick a database [postgres | sqlite]");
});

test("before fleet_objective the document uses a default slug, a burst writes once and shutdown flushes", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	assert.deepEqual(h.writes, [], "a session without fleet activity writes nothing");
	await spawnMember(h, ctx, "api");
	await tick();
	for (let i = 0; i < 10; i++) h.children[0].emit({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "read", args: {} });
	h.children[0].emit({ type: "agent_settled", aborted: false });
	await tick();
	assert.deepEqual(h.writes, [], "nothing is written inside the window");
	const writeWindows = h.timers.filter(timer => timer.ms === 1000 && !timer.cancelled);
	assert.equal(writeWindows.length, 1, "one write window for the burst");
	writeWindows[0].fn();
	const doc = join(mainCwd, "odd", "fleet", "fleet-fleet-session-1.md");
	assert.deepEqual(h.writes, [join(h.agentHome, "gentle-fleet", "sessions", "fleet-session-1", "ledger.json"), doc]);
	await h.tools.get("fleet_send")!.execute("s1", { name: "api", message: "more" }, undefined, undefined, ctx);
	await h.fire("session_shutdown", ctx, { reason: "quit" });
	assert.equal(h.writes.length, 4, "shutdown flushes the pending change");
	assert.match(readFileSync(doc, "utf8"), /· send · api/);
});

test("fleet_inspect returns a member's bounded detail and activity tail, never a transcript", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await spawnMember(h, ctx, "api");
	await tick();
	for (let i = 0; i < 250; i++) h.children[0].emit({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "read", args: { path: "odd/tasks/billing.md" } });
	await tick();
	const inspect = h.tools.get("fleet_inspect")!;
	const lines = async (params: Record<string, unknown>) => (await inspect.execute("i", { name: "api", ...params }, undefined, undefined, ctx)).content[0].text.split("\n").filter(line => line.startsWith("- ")).length;
	assert.equal(await lines({}), 40, "default tail");
	assert.equal(await lines({ lines: 3 }), 3);
	assert.equal(await lines({ lines: 5000 }), 200, "capped tail");
	const text = (await inspect.execute("i", { name: "api" }, undefined, undefined, ctx)).content[0].text;
	assert.match(text, /^api \[working\]/);
	assert.match(text, new RegExp(`^feature document: ${join(mainCwd, "odd", "tasks", "billing.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
	const missing = await inspect.execute("i", { name: "nope" }, undefined, undefined, ctx);
	assert.match(missing.content[0].text, /No fleet member named "nope"/);
});

// T2b (L27): the controller recalls and records its own memory; memory
// maintenance, session and judgment tools belong to the members.
test("the controller session keeps only the fleet, read-only and five memory tools active", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const allowed = ["read", "grep", "find", "ls", "ask_user_question", "ask_user_choice", "mem_search", "mem_context", "mem_get_observation", "mem_save", "mem_current_project", "fleet_spawn", "fleet_send", "fleet_status", "fleet_stop", "fleet_objective", "fleet_inspect", "fleet_answer", "fleet_grant", "fleet_revoke"];
	assert.deepEqual(h.activeTools().sort(), [...allowed].sort());
	assert.equal(h.activeSets.length, 1);
	await h.fire("before_agent_start", ctx, { prompt: "hi" });
	assert.equal(h.activeSets.length, 1, "an unchanged active set is not set again");
	h.activate("mcp__docs__search");
	await h.fire("before_agent_start", ctx, { prompt: "hi" });
	assert.equal(h.activeSets.length, 2, "a tool activated later is dropped before the next request");
	assert.deepEqual(h.activeTools().sort(), [...allowed].sort());
});

// Verifier T2 B1: outside the TUI ask-user-choice deactivates ask_user_choice;
// the allowlist only removes tools, so it never brings a disabled one back.
test("the controller allowlist never re-activates a tool another extension disabled", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	const disableChoice = () => h.pi.setActiveTools(h.activeTools().filter(name => name !== "ask_user_choice"));
	disableChoice();
	await h.fire("session_start", ctx);
	assert.equal(h.activeTools().includes("ask_user_choice"), false);
	assert.ok(h.activeTools().includes("fleet_spawn") && h.activeTools().includes("read"));
	assert.equal(h.activeTools().includes("bash"), false);
	const sets = h.activeSets.length;
	for (let turn = 0; turn < 2; turn += 1) {
		disableChoice();
		await h.fire("before_agent_start", ctx, { prompt: "hi" });
		assert.equal(h.activeTools().includes("ask_user_choice"), false);
	}
	assert.equal(h.activeSets.length, sets + 2, "only the other extension sets tools on later turns");
});

test("a normal session and a fleet member keep every tool", async () => {
	for (const env of [{ PATH: "/bin" }, { PATH: "/bin", [FLEET_ROLE_ENV]: "member" }]) {
		const h = harness(env);
		const before = h.activeTools();
		const { ctx } = fakeContext();
		await h.fire("session_start", ctx);
		await h.fire("before_agent_start", ctx, { prompt: "hi" });
		assert.deepEqual(h.activeSets, [], JSON.stringify(env));
		assert.deepEqual(h.activeTools(), before, JSON.stringify(env));
		assert.ok(h.activeTools().includes("bash") && h.activeTools().includes("codemode"));
	}
});

// Verifier L10 advisory 5: a new session must not inherit the old members.
test("a new session start stops and forgets the previous session's members so they cannot wake it", async () => {
	const h = harness();
	const first = fakeContext("fleet-session-1");
	await h.fire("session_start", first.ctx);
	await spawnMember(h, first.ctx, "api");
	await tick();
	const old = h.children[0];
	const second = fakeContext("fleet-session-2");
	await h.fire("session_start", second.ctx);
	assert.equal(old.child.stdin!.writableEnded, true, "the old member was stopped");
	// The old member exits only after the new session started.
	await tick();
	h.runTimers();
	assert.equal(h.sent.length, 0, "an old member never wakes the new session");
	const status = await h.tools.get("fleet_status")!.execute("st", {}, undefined, undefined, second.ctx);
	assert.equal(status.content[0].text, "No fleet members.");
	assert.ok(existsSync(join(h.agentHome, "gentle-fleet", "sessions", "fleet-session-1", "ledger.json")), "the old ledger was flushed");
	await spawnMember(h, second.ctx, "api");
	await tick();
	const dir = h.spawned[1].args[h.spawned[1].args.indexOf("--session-dir") + 1];
	assert.equal(dir, join(h.agentHome, "gentle-fleet", "sessions", "fleet-session-2", "api"));
	h.runTimers();
	assert.deepEqual(readLedger(h, "fleet-session-2").members.map(member => member.name), ["api"]);
});

// --- T4 (S3, L15): configurable live-member limit, budgets, worktree per git member.

const description = (h: ReturnType<typeof harness>, name: string) => (h.tools.get(name) as unknown as { description: string }).description;
const usage = (cost: number) => ({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: cost } } } });
const budgetLines = (content: string) => content.split("\n").filter(line => line.startsWith("budget: "));

test("fleet.json sets the live-member limit the tool description and the refusal name; the next spawn rereads it", async () => {
	const h = harness(controllerEnv, { fleetConfig: { maxLiveMembers: 2 } });
	const path = join(h.configHome, "fleet.json");
	assert.match(description(h, "fleet_spawn"), /At most 2 live members \(maxLiveMembers in the human's fleet\.json\)\./);
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await spawnMember(h, ctx, "a");
	await spawnMember(h, ctx, "b");
	const third = await spawnMember(h, ctx, "c");
	assert.equal(third.content[0].text, `Error: the fleet runs at most 2 live members (maxLiveMembers in ${path}). Send the work to an existing member or stop one first.`);
	assert.equal(h.spawned.length, 2);
	writeFileSync(path, JSON.stringify({ maxLiveMembers: 3 }));
	assert.match((await spawnMember(h, ctx, "c")).content[0].text, /^Spawned/, "a raised limit applies to the next spawn");
	assert.equal(JSON.parse(readFileSync(path, "utf8")).maxLiveMembers, 3, "the controller never rewrites the file");
});

test("an invalid fleet.json falls back to the defaults and tells the human once per session", async () => {
	const h = harness(controllerEnv, { fleetConfig: { maxLiveMembers: 0, fleetBudgetUsd: -2 } });
	assert.match(description(h, "fleet_spawn"), /At most 8 live members/);
	const { ctx, notices } = fakeContext();
	await h.fire("session_start", ctx);
	assert.deepEqual(notices, [[`Gentle Fleet ignored invalid values in ${join(h.configHome, "fleet.json")} and uses the defaults for: maxLiveMembers (an integer of at least 1), fleetBudgetUsd (a number of USD above 0).`, "warning"]]);
	for (const name of ["a", "b", "c", "d"]) assert.match((await spawnMember(h, ctx, name)).content[0].text, /^Spawned/);
	assert.equal(notices.length, 1, "spawns reread the file without repeating the notice");
	const broken = harness(controllerEnv, { fleetConfig: "{oops" });
	const second = fakeContext();
	await broken.fire("session_start", second.ctx);
	assert.match((await spawnMember(broken, second.ctx, "a")).content[0].text, /^Spawned/, "a malformed file never crashes a spawn");
});

test("budgets add one digest line and one blocker per crossed threshold, stop nothing, and refuse spawns at the fleet budget", async () => {
	const h = harness(controllerEnv, { fleetConfig: { fleetBudgetUsd: 2, memberBudgetUsd: 1 } });
	const configPath = join(h.configHome, "fleet.json");
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await h.tools.get("fleet_objective")!.execute("o1", { title: "Budgets", objective: "Watch spend." }, undefined, undefined, ctx);
	await spawnMember(h, ctx, "api");
	await spawnMember(h, ctx, "web");
	await tick();
	const [api, web] = h.children;
	const settle = async (child: typeof api) => {
		child.emit({ type: "agent_settled", aborted: false });
		await tick();
		const before = h.sent.length;
		for (const timer of h.wakeTimers()) { timer.cancelled = true; timer.fn(); }
		assert.equal(h.sent.length, before + 1, "one wake");
		return budgetLines(String(h.sent.at(-1)!.message.content));
	};
	api.emit(usage(0.85));
	await tick();
	assert.equal(h.wakeTimers().length, 0, "a crossed budget wakes nothing by itself");
	assert.deepEqual(await settle(api), ["budget: member api spent $0.85 of its $1.00 budget (80%)"]);
	api.emit(usage(0.05));
	assert.deepEqual(await settle(api), [], "a threshold warns once");
	api.emit(usage(0.2));
	web.emit(usage(0.6));
	assert.deepEqual(await settle(api), ["budget: member api spent $1.10 of its $1.00 budget (100%); it keeps working", "budget: fleet spent $1.70 of its $2.00 budget (80%)"]);
	assert.equal(api.child.stdin!.writableEnded, false, "crossing a member budget stops nothing");
	web.emit(usage(0.35));
	assert.deepEqual(await settle(web), ["budget: member web spent $0.95 of its $1.00 budget (80%)", "budget: fleet spent $2.05 of its $2.00 budget (100%); fleet_spawn refuses new members"]);
	const refused = await spawnMember(h, ctx, "docs");
	assert.equal(refused.content[0].text, `Error: the fleet spent $2.05 of its $2.00 budget (fleetBudgetUsd in ${configPath}). Existing members keep working: send them work with fleet_send, or ask the human to raise the budget.`);
	assert.equal(h.spawned.length, 2);
	assert.equal((await h.tools.get("fleet_send")!.execute("s", { name: "api", message: "finish" }, undefined, undefined, ctx)).content[0].text, `Sent to "api" (prompt).`);
	h.runTimers();
	const doc = readFileSync(join(mainCwd, "odd", "fleet", "budgets.md"), "utf8");
	const blockers = doc.slice(doc.indexOf("## Blockers"), doc.indexOf("## Log")).split("\n").filter(line => line.startsWith("- "));
	assert.deepEqual(blockers, [
		"- api: budget — member api spent $0.85 of its $1.00 budget (80%)",
		"- api: budget — member api spent $1.10 of its $1.00 budget (100%); it keeps working",
		"- fleet: budget — fleet spent $1.70 of its $2.00 budget (80%)",
		"- web: budget — member web spent $0.95 of its $1.00 budget (80%)",
		"- fleet: budget — fleet spent $2.05 of its $2.00 budget (100%); fleet_spawn refuses new members",
	]);
	assert.equal(readLedger(h).budgetWarnings.length, 5);
});

test("a jump past both thresholds warns once at 100%, and a respawned name keeps the fleet's earlier spend", async () => {
	const h = harness(controllerEnv, { fleetConfig: { fleetBudgetUsd: 3, memberBudgetUsd: 1 } });
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await spawnMember(h, ctx, "api");
	await tick();
	h.children[0].emit(usage(2.5));
	h.children[0].emit({ type: "agent_settled", aborted: false });
	await tick();
	h.runTimers();
	assert.deepEqual(budgetLines(String(h.sent[0].message.content)), ["budget: member api spent $2.50 of its $1.00 budget (100%); it keeps working", "budget: fleet spent $2.50 of its $3.00 budget (80%)"]);
	await h.tools.get("fleet_stop")!.execute("stop", { name: "api" }, undefined, undefined, ctx);
	await tick();
	h.runTimers();
	await spawnMember(h, ctx, "api");
	await tick();
	h.children[1].emit(usage(0.6));
	h.children[1].emit({ type: "agent_settled", aborted: false });
	await tick();
	h.runTimers();
	assert.deepEqual(budgetLines(String(h.sent.at(-1)!.message.content)), ["budget: fleet spent $3.10 of its $3.00 budget (100%); fleet_spawn refuses new members"], "the new api starts its own member budget; the fleet counts both");
});

function gitIn(cwd: string, ...args: string[]): string {
	const result = runGit(["-c", "user.name=Fleet Test", "-c", "user.email=fleet@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], cwd);
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

let repos = 0;
function scratchRepo() {
	repos += 1;
	const root = join(scratch, `repo-${repos}`);
	const repo = join(root, "app");
	mkdirSync(repo, { recursive: true });
	gitIn(repo, "init", "-q", "-b", "main");
	gitIn(repo, "commit", "-q", "--allow-empty", "-m", "initial");
	const branches = () => gitIn(repo, "branch", "--format=%(refname:short)").split("\n").sort();
	const worktrees = () => gitIn(repo, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
	return { root, repo, branches, worktrees };
}

test("a member in a git repository runs in its own worktree and branch, shown in the ledger, the document and fleet_inspect, and kept after it exits", async () => {
	const h = harness();
	const { root, repo, branches, worktrees } = scratchRepo();
	const { ctx } = fakeContext("fleet-session-1", repo);
	await h.fire("session_start", ctx);
	await h.tools.get("fleet_objective")!.execute("o1", { title: "Billing", objective: "Ship billing." }, undefined, undefined, ctx);
	const path = join(root, "app.fleet", "billing", "api");
	const result = await spawnMember(h, ctx, "api");
	assert.equal(result.content[0].text, `Spawned fleet member "api" in ${path} on new branch fleet/billing/api (worktree of ${repo}). Its digest arrives when it settles, asks a question or exits.`);
	assert.equal(h.spawned[0].cwd, path);
	assert.deepEqual(branches(), ["fleet/billing/api", "main"]);
	assert.deepEqual(worktrees(), [repo, path]);
	const inspect = (await h.tools.get("fleet_inspect")!.execute("i", { name: "api" }, undefined, undefined, ctx)).content[0].text;
	assert.match(inspect, new RegExp(`^worktree: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(branch fleet/billing/api\\)$`, "m"));
	const inPlace = await spawnMember(h, ctx, "pub", { worktree: false });
	assert.match(inPlace.content[0].text, new RegExp(`^Spawned fleet member "pub" in ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. `));
	assert.equal(h.spawned[1].cwd, repo, "worktree: false runs the member in place");
	assert.deepEqual(branches(), ["fleet/billing/api", "main"]);
	await h.tools.get("fleet_stop")!.execute("st", { name: "api" }, undefined, undefined, ctx);
	await tick();
	await h.fire("session_shutdown", ctx, { reason: "quit" });
	await tick();
	h.runTimers();
	assert.deepEqual(branches(), ["fleet/billing/api", "main"], "stop and exit keep the branch");
	assert.deepEqual(worktrees(), [repo, path], "stop and exit keep the worktree");
	assert.ok(h.gitCalls.every(args => !["remove", "prune", "-D", "-d", "--force", "-f"].some(flag => args.includes(flag))), JSON.stringify(h.gitCalls));
	assert.deepEqual(readdirSync(root).sort(), ["app", "app.fleet"]);
	const saved = readLedger(h);
	assert.deepEqual(saved.members.map(member => [member.name, member.cwd, member.worktree, member.branch]), [["api", path, path, "fleet/billing/api"], ["pub", repo, null, null]]);
	const doc = readFileSync(join(repo, "odd", "fleet", "billing.md"), "utf8");
	assert.ok(doc.includes(`| \`fleet/billing/api\` | \`${path}\` |\n`), doc);
});

test("an existing member branch refuses the spawn before any member, session dir or ledger entry exists", async () => {
	const h = harness();
	const { root, repo, branches, worktrees } = scratchRepo();
	gitIn(repo, "branch", "fleet/billing/api");
	const { ctx } = fakeContext("fleet-session-1", repo);
	await h.fire("session_start", ctx);
	await h.tools.get("fleet_objective")!.execute("o1", { title: "Billing", objective: "Ship billing." }, undefined, undefined, ctx);
	const result = await spawnMember(h, ctx, "api");
	assert.match(result.content[0].text, /^Error: could not give member "api" its own worktree: branch fleet\/billing\/api already exists/);
	assert.equal(h.spawned.length, 0);
	assert.equal((await h.tools.get("fleet_status")!.execute("st", {}, undefined, undefined, ctx)).content[0].text, "No fleet members.");
	assert.equal(existsSync(join(h.agentHome, "gentle-fleet", "sessions", "fleet-session-1", "api")), false);
	h.runTimers();
	assert.deepEqual(readLedger(h).members, []);
	assert.deepEqual(branches(), ["fleet/billing/api", "main"]);
	assert.deepEqual(worktrees(), [repo]);
	assert.deepEqual(readdirSync(root), ["app"]);
});

test("outside a git repository a member runs in place and git is only asked where the repository is", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await spawnMember(h, ctx, "pub");
	assert.equal(h.spawned[0].cwd, mainCwd);
	assert.deepEqual(h.gitCalls.map(args => args.slice(0, 2)), [["rev-parse", "--show-toplevel"]]);
	await spawnMember(h, ctx, "posts", { worktree: false });
	assert.equal(h.gitCalls.length, 1, "worktree: false never calls git");
	h.runTimers();
	assert.deepEqual(readLedger(h).members.map(member => [member.name, member.worktree, member.branch]), [["pub", null, null], ["posts", null, null]]);
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

// T3 (S2): the fleet answers member dialogs on the human's behalf; protected
// classes reach the human through the controller's own UI, by code.

type UiCall = { method: string; title: string; detail?: string; options?: string[] };
type UiScript = { select?: string; confirm?: boolean; input?: string; editor?: string };

function dialogContext(script: UiScript = {}, overrides: Record<string, unknown> = {}) {
	const base = fakeContext();
	const calls: UiCall[] = [];
	const ui = base.ctx.ui as unknown as Record<string, unknown>;
	ui.select = async (title: string, options: string[]) => { calls.push({ method: "select", title, options }); return script.select; };
	ui.confirm = async (title: string, detail: string) => { calls.push({ method: "confirm", title, detail }); return script.confirm ?? false; };
	ui.input = async (title: string, detail?: string) => { calls.push({ method: "input", title, detail }); return script.input; };
	ui.editor = async (title: string, detail?: string) => { calls.push({ method: "editor", title, detail }); return script.editor; };
	Object.assign(base.ctx, overrides);
	return { ...base, calls };
}

async function fleetWithMember(options: HarnessOptions & { script?: UiScript; ctx?: Record<string, unknown>; env?: NodeJS.ProcessEnv } = {}) {
	const h = harness(options.env ?? controllerEnv, options);
	const slug = `relay-${harnesses}`;
	const view = dialogContext(options.script, options.ctx);
	await h.fire("session_start", view.ctx);
	await h.tools.get("fleet_objective")!.execute("o1", { title: slug, objective: "Ship it." }, undefined, undefined, view.ctx);
	await spawnMember(h, view.ctx, "web", { worktree: false });
	await tick();
	const child = h.children[0];
	const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
	const answer = (params: Record<string, unknown>) => h.tools.get("fleet_answer")!.execute("a", { name: "web", ...params }, undefined, undefined, view.ctx);
	const document = () => {
		h.runTimers();
		return readFileSync(join(mainCwd, "odd", "fleet", `${slug}.md`), "utf8");
	};
	const responses = () => child.written.filter(command => command.type === "extension_ui_response");
	const lastDigest = () => {
		h.runTimers();
		return String(h.sent.at(-1)?.message.content ?? "");
	};
	return { h, ...view, child, settle, answer, document, responses, lastDigest };
}

const DATA_LOSS = { method: "confirm", title: "Allow recognized data-loss command?", message: "rm build" };
const GUARDED = { method: "confirm", title: "Allow guarded git push?", message: "git push origin main" };
const MESSAGING = { method: "select", title: "Authorize cross-orchestrator message to peer?\nReason: sync", options: ["Allow once", "Allow for this session", "Deny"] };
const FOREIGN = { method: "confirm", title: "Authorize foreign clone subagent", message: "Launch a subagent in /other?" };
const REVIEW_CONSENT = { method: "select", title: "Review this change?\nOwnership: ...", options: ["1. Run review\nEffect: a", "2. Skip review\nEffect: b", "3. Review and allow this session\nEffect: c"] };
const MODEL_COST = { method: "select", title: "Model-cost permission only: one direct model run", options: ["Allow once", "Decline"] };

test("fleet_answer writes the member's RPC response, clears the blocker and logs that the fleet answered", async () => {
	const f = await fleetWithMember();
	f.child.emit({ type: "extension_ui_request", id: "q1", method: "select", title: "Pick a database", options: ["postgres", "sqlite"] });
	await f.settle();
	const before = f.document();
	assert.match(before.slice(before.indexOf("## Blockers")), /- web: question — Pick a database/);
	const result = await f.answer({ answer: "2" });
	assert.equal(result.content[0].text, `Answered web's select "Pick a database" with "sqlite".`);
	await f.settle();
	assert.deepEqual(f.responses(), [{ id: "q1", type: "extension_ui_response", value: "sqlite" }]);
	const doc = f.document();
	assert.doesNotMatch(doc.slice(doc.indexOf("## Blockers"), doc.indexOf("## Grants")), /Pick a database/);
	assert.match(doc, /· answer · web — fleet answered "Pick a database": sqlite$/m);
});

test("fleet_answer refuses an invalid answer, a missing dialog and an empty call, writing nothing", async () => {
	const f = await fleetWithMember();
	assert.equal((await f.answer({ answer: "x" })).content[0].text, "Error: no pending dialog for web.");
	f.child.emit({ type: "extension_ui_request", id: "q1", method: "confirm", title: "Use the cache?" });
	await f.settle();
	assert.match((await f.answer({ answer: "maybe" })).content[0].text, /^Error: .*yes or no/);
	assert.equal((await f.answer({})).content[0].text, "Error: give an answer or cancel: true.");
	await f.settle();
	assert.deepEqual(f.responses(), []);
	assert.equal((await f.answer({ cancel: true })).content[0].text, `Answered web's confirm "Use the cache?" with cancel.`);
	await f.settle();
	assert.deepEqual(f.responses(), [{ id: "q1", type: "extension_ui_response", cancelled: true }]);
});

test("the wake digest carries each pending dialog's id, method, title, message and numbered options, bounded", async () => {
	const f = await fleetWithMember();
	f.child.emit({ type: "extension_ui_request", id: "q1", method: "select", title: "Pick a database", message: "for the billing tables", options: ["postgres", "sqlite", "o".repeat(200)] });
	await f.settle();
	const digest = f.lastDigest();
	assert.match(digest, /^ {2}question q1 \(select\) for the fleet: Pick a database — for the billing tables \[1\. postgres \| 2\. sqlite \| 3\. o+…\] → fleet_answer$/m);
	assert.ok(digest.split("\n").every(line => line.length <= 700), "digest lines are bounded");
});

test("previous behavior: a dialog still surfaces in the digest and the member stays pending until answered", async () => {
	const f = await fleetWithMember();
	f.child.emit({ type: "extension_ui_request", id: "q1", method: "input", title: "Release name" });
	await f.settle();
	assert.match(f.lastDigest(), /web \[waiting-question\]/);
	const status = () => f.h.tools.get("fleet_status")!.execute("s", {}, undefined, undefined, f.ctx);
	assert.match((await status()).content[0].text, /web \[waiting-question\].*question: Release name/);
	await f.answer({ answer: "v2" });
	assert.match((await status()).content[0].text, /web \[working\]/);
});

const PROTECTED_CASES: Array<{ label: string; request: Record<string, unknown>; script: UiScript; response: Record<string, unknown> }> = [
	{ label: "review consent", request: REVIEW_CONSENT, script: { select: "2. Skip review\nEffect: b" }, response: { value: "2. Skip review\nEffect: b" } },
	{ label: "data-loss command", request: DATA_LOSS, script: { confirm: true }, response: { confirmed: true } },
	{ label: "guarded command", request: GUARDED, script: { confirm: false }, response: { confirmed: false } },
	{ label: "messaging grant", request: MESSAGING, script: { select: "Deny" }, response: { value: "Deny" } },
	{ label: "foreign clone grant", request: FOREIGN, script: { confirm: true }, response: { confirmed: true } },
	{ label: "model-cost permission", request: MODEL_COST, script: {}, response: { cancelled: true } },
];

for (const item of PROTECTED_CASES) {
	test(`a protected ${item.label} dialog is relayed by code to the human, refused to fleet_answer, and the human's answer is forwarded`, async () => {
		const f = await fleetWithMember({ script: item.script });
		f.child.emit({ type: "extension_ui_request", id: "p1", ...item.request });
		await f.settle();
		assert.equal(f.calls.length, 1, "the human saw the dialog once");
		assert.equal(f.calls[0].method, item.request.method);
		assert.equal(f.calls[0].title, `Fleet member "web": ${item.request.title}`);
		if (item.request.options) assert.deepEqual(f.calls[0].options, item.request.options);
		if (item.request.message) assert.equal(f.calls[0].detail, item.request.message);
		assert.deepEqual(f.responses(), [{ id: "p1", type: "extension_ui_response", ...item.response }]);
		assert.match((await f.answer({ answer: "1", dialog: "p1" })).content[0].text, /^Error: /, "answered dialogs are gone");
		assert.match(f.document(), /· answer · web — human answered \(relayed by the fleet\) /);
	});
}

test("fleet_answer refuses a protected dialog while the human still decides, and the digest says it was relayed", async () => {
	let release!: (value: boolean) => void;
	const f = await fleetWithMember();
	(f.ctx.ui as unknown as Record<string, unknown>).confirm = (title: string) => { f.calls.push({ method: "confirm", title }); return new Promise<boolean>(resolve => { release = resolve; }); };
	f.child.emit({ type: "extension_ui_request", id: "p1", ...DATA_LOSS });
	await f.settle();
	const refused = await f.answer({ answer: "yes" });
	assert.equal(refused.content[0].text, `Error: dialog p1 ("Allow recognized data-loss command?") is relayed to the human; you cannot answer it.`);
	assert.match(f.lastDigest(), /^ {2}protected question p1 \(confirm\) relayed to the human by code: Allow recognized data-loss command\?/m);
	assert.deepEqual(f.responses(), []);
	release(true);
	await f.settle();
	assert.deepEqual(f.responses(), [{ id: "p1", type: "extension_ui_response", confirmed: true }]);
});

for (const [label, ctx] of [
	["no UI", { hasUI: false }],
	["print mode", { hasUI: false, mode: "print" }],
	["rpc without an interactive host", { mode: "rpc" }],
] as const) {
	test(`with ${label} a protected dialog is cancelled for the member and recorded as a blocker, never approved`, async () => {
		const f = await fleetWithMember({ ctx: { ...ctx } });
		f.child.emit({ type: "extension_ui_request", id: "p1", ...DATA_LOSS });
		await f.settle();
		assert.deepEqual(f.calls, [], "nobody was asked");
		assert.deepEqual(f.responses(), [{ id: "p1", type: "extension_ui_response", cancelled: true }]);
		const doc = f.document();
		assert.match(doc.slice(doc.indexOf("## Blockers"), doc.indexOf("## Grants")), /^- web: protected question cancelled — Allow recognized data-loss command\? \(no interactive UI to relay it to the human\)$/m);
		assert.match(f.lastDigest(), /protected question p1 \(confirm\) cancelled by code: no interactive UI to relay it to the human/);
	});
}

test("an rpc controller with the interactive host signal relays protected dialogs to its UI", async () => {
	const f = await fleetWithMember({ ctx: { mode: "rpc" }, env: { ...controllerEnv, GENTLE_SHELL_INTERACTIVE_HOST: "1" }, script: { confirm: true } });
	f.child.emit({ type: "extension_ui_request", id: "p1", ...DATA_LOSS });
	await f.settle();
	assert.equal(f.calls.length, 1);
	assert.deepEqual(f.responses(), [{ id: "p1", type: "extension_ui_response", confirmed: true }]);
});

test("an unknown dialog stays model-answerable and never reaches the human's UI", async () => {
	const f = await fleetWithMember({ script: { confirm: true } });
	f.child.emit({ type: "extension_ui_request", id: "q1", method: "confirm", title: "Delete the old table?", message: "irreversible" });
	await f.settle();
	assert.deepEqual(f.calls, []);
	assert.deepEqual(f.responses(), []);
	assert.match((await f.answer({ answer: "no" })).content[0].text, /^Answered/);
});

// Super YOLO in the controller (user, T3 scope addition): code approves the
// guard, permission and access classes for every member and audits each one.
const AUTO_CASES: Array<{ label: string; request: Record<string, unknown>; response: Record<string, unknown>; shown: string }> = [
	{ label: "data-loss command", request: DATA_LOSS, response: { confirmed: true }, shown: "yes" },
	{ label: "guarded command", request: GUARDED, response: { confirmed: true }, shown: "yes" },
	{ label: "messaging grant", request: MESSAGING, response: { value: "Allow once" }, shown: "Allow once" },
	{ label: "foreign clone grant", request: FOREIGN, response: { confirmed: true }, shown: "yes" },
];

for (const item of AUTO_CASES) {
	test(`under the controller's Super YOLO a ${item.label} dialog is auto-approved by code and audited`, async () => {
		const f = await fleetWithMember({ permissionMode: async () => "super-yolo" });
		f.child.emit({ type: "extension_ui_request", id: "p1", ...item.request });
		await f.settle();
		assert.deepEqual(f.calls, [], "the human was not asked");
		assert.deepEqual(f.responses(), [{ id: "p1", type: "extension_ui_response", ...item.response }]);
		const doc = f.document();
		const audit = doc.slice(doc.indexOf("## Auto-approvals"), doc.indexOf("## Log"));
		const title = String(item.request.title).split("\n")[0];
		assert.ok(audit.split("\n").some(line => line.startsWith(`- 2026-11-02T12:00:00.000Z · web — ${title}`) && line.endsWith(` → ${item.shown}`)), audit);
		const saved = readLedger(f.h);
		assert.equal(saved.autoApprovals.length, 1);
		assert.equal(saved.autoApprovals[0].member, "web");
		assert.equal(saved.autoApprovals[0].answer, item.shown);
		assert.match(f.lastDigest(), /protected question p1 \(\w+\) auto-approved by code under the controller's Super YOLO/);
	});
}

test("under Super YOLO provider consent and anything touching secrets still go to the human", async () => {
	const f = await fleetWithMember({ permissionMode: async () => "super-yolo", script: { select: "2. Skip review\nEffect: b", confirm: false } });
	const requests = [
		{ id: "r1", ...REVIEW_CONSENT },
		{ id: "m1", ...MODEL_COST },
		{ id: "s1", ...DATA_LOSS, message: "rm ~/.ssh/old_key" },
		{ id: "s2", ...GUARDED, message: "cp .env.production out" },
		{ id: "s3", ...FOREIGN, message: "Launch a subagent in /home/me/.aws?" },
	];
	for (const request of requests) {
		f.child.emit({ type: "extension_ui_request", ...request });
		await f.settle();
	}
	assert.deepEqual(f.calls.map(call => call.method), ["select", "select", "confirm", "confirm", "confirm"], "every one reached the human");
	assert.deepEqual(f.responses().map(response => response.id), ["r1", "m1", "s1", "s2", "s3"]);
	f.document();
	assert.deepEqual(readLedger(f.h).autoApprovals, []);
});

test("in any other controller mode protected dialogs are relayed, and switching Super YOLO off stops auto-approval at the next dialog", async () => {
	let mode: PermissionMode = "yolo";
	const f = await fleetWithMember({ permissionMode: async () => mode, script: { confirm: false } });
	for (const [id, next] of [["p1", "super-yolo"], ["p2", "normal"], ["p3", "auto"], ["p4", "auto"]] as const) {
		f.child.emit({ type: "extension_ui_request", id, ...DATA_LOSS });
		await f.settle();
		mode = next;
	}
	assert.equal(f.calls.length, 3, "yolo, normal and auto asked the human");
	assert.deepEqual(f.responses().map(response => response.confirmed), [false, true, false, false]);
	f.document();
	assert.equal(readLedger(f.h).autoApprovals.length, 1);
});

test("the controller's live mode is read through the real yolo host channel", async () => {
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	const events = {
		on: (name: string, listener: (payload: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {}; },
		emit: (name: string, payload: unknown) => { for (const listener of listeners.get(name) ?? []) listener(payload); },
	};
	const yolo = registerYoloSessionPolicy({ registerCommand() {}, events } as unknown as ExtensionAPI, { ...controllerEnv, GENTLE_PI_CONFIG_HOME: join(scratch, "yolo-config") }, { resolveIdentity: async () => undefined });
	const f = await fleetWithMember({ permissionMode: null, events, script: { confirm: false } });
	assert.equal(await yolo.setMode("super-yolo", f.ctx), true);
	f.child.emit({ type: "extension_ui_request", id: "p1", ...DATA_LOSS });
	await f.settle();
	assert.deepEqual(f.calls, []);
	assert.deepEqual(f.responses(), [{ id: "p1", type: "extension_ui_response", confirmed: true }]);
	assert.equal(await yolo.setMode("normal", f.ctx), true);
	f.child.emit({ type: "extension_ui_request", id: "p2", ...DATA_LOSS });
	await f.settle();
	assert.equal(f.calls.length, 1, "after switching off the human is asked again");
});

test("fleet_grant and fleet_revoke need the human's confirmation and edit the Grants section", async () => {
	const f = await fleetWithMember({ script: { confirm: true } });
	const grant = await f.h.tools.get("fleet_grant")!.execute("g", { scope: "publish:social", description: "Publish scheduled posts on X and LinkedIn from the content calendar" }, undefined, undefined, f.ctx);
	assert.match(grant.content[0].text, /^Recorded standing permission g1 for publish:social\./);
	assert.equal(f.calls[0].method, "confirm");
	assert.match(String(f.calls[0].detail), /Publish scheduled posts on X and LinkedIn/);
	assert.match(String(f.calls[0].detail), /never cover/);
	assert.match(f.document().slice(f.document().indexOf("## Grants")), /^- g1 · `publish:social` — Publish scheduled posts/m);
	assert.match((await f.h.tools.get("fleet_status")!.execute("s", {}, undefined, undefined, f.ctx)).content[0].text, /Standing permissions: g1 publish:social/);
	const revoke = (id: string) => f.h.tools.get("fleet_revoke")!.execute("r", { id }, undefined, undefined, f.ctx);
	(f.ctx.ui as unknown as Record<string, unknown>).confirm = async () => false;
	assert.match((await revoke("g1")).content[0].text, /declined/);
	assert.match(f.document(), /- g1 ·/, "a declined revoke keeps the grant");
	(f.ctx.ui as unknown as Record<string, unknown>).confirm = async () => true;
	assert.match((await revoke("g1")).content[0].text, /^Revoked standing permission g1/);
	assert.doesNotMatch(f.document(), /- g1 ·/);
	assert.match((await revoke("g9")).content[0].text, /^Error: no standing permission g9/);
});

test("fleet_grant is refused when the human declines or there is no interactive UI", async () => {
	const declined = await fleetWithMember({ script: { confirm: false } });
	assert.match((await declined.h.tools.get("fleet_grant")!.execute("g", { scope: "publish:x", description: "Post on X" }, undefined, undefined, declined.ctx)).content[0].text, /declined; nothing was recorded/);
	assert.doesNotMatch(declined.document(), /publish:x/);
	const headless = await fleetWithMember({ ctx: { hasUI: false } });
	assert.match((await headless.h.tools.get("fleet_grant")!.execute("g", { scope: "publish:x", description: "Post on X" }, undefined, undefined, headless.ctx)).content[0].text, /^Error: fleet_grant needs the human's confirmation/);
	assert.deepEqual(headless.calls, []);
	assert.doesNotMatch(headless.document(), /publish:x/);
});

test("a grant never lets the fleet answer a protected dialog", async () => {
	const f = await fleetWithMember({ script: { confirm: true } });
	await f.h.tools.get("fleet_grant")!.execute("g", { scope: "publish:all", description: "Push and publish anything" }, undefined, undefined, f.ctx);
	let release!: (value: boolean) => void;
	(f.ctx.ui as unknown as Record<string, unknown>).confirm = () => new Promise<boolean>(resolve => { release = resolve; });
	f.child.emit({ type: "extension_ui_request", id: "p1", ...GUARDED });
	await f.settle();
	assert.match((await f.answer({ answer: "yes" })).content[0].text, /relayed to the human/);
	release(false);
	await f.settle();
	assert.deepEqual(f.responses(), [{ id: "p1", type: "extension_ui_response", confirmed: false }]);
});
