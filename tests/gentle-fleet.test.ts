import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import gentleFleet, { FLEET_DIGEST_MESSAGE_TYPE, FLEET_WAKE_WINDOW_MS, type FleetDeps } from "../extensions/gentle-fleet.ts";
import { DEFAULT_MAX_LIVE_MEMBERS } from "../lib/fleet-config.ts";
import type { FleetLedgerState } from "../lib/fleet-ledger.ts";
import { runGit } from "../lib/fleet-worktree.ts";
import gentleAgents, { type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { writeJsonFileAtomicallySync } from "../lib/agent-profiles.ts";
import { ADOPT_POLL_MS, writeAdoptHandoff } from "../lib/fleet-adopt.ts";
import { FLEET_ROLE_ENV } from "../lib/fleet-role.ts";
import type { PermissionMode } from "../lib/permission-mode-policy.ts";
import { registerYoloSessionPolicy } from "../lib/yolo-session-policy.ts";
import { sidebarState } from "../lib/shell-sidebar.ts";
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
	const commands = new Map<string, { description?: string; handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const userMessages: Array<{ content: unknown; options: unknown }> = [];
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
		sendUserMessage: async (content: unknown, options: unknown) => { userMessages.push({ content, options }); },
		registerCommand: (name: string, registration: { description?: string; handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, registration),
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
	return { pi, tools, commands, handlers, sent, userMessages, fire, activeSets, activeTools: () => [...active], activate };
}

const mainCwd = join(scratch, "main");
// T8: fleet_spawn needs an existing project directory (or create: true).
const webCwd = join(scratch, "web");
mkdirSync(mainCwd, { recursive: true });
mkdirSync(webCwd, { recursive: true });

// A plain theme: every role paints its text unchanged.
const plainTheme = { fg: (_role: string, text: string) => text, bold: (text: string) => text, bg: (_role: string, text: string) => text };

function fakeContext(sessionId = "fleet-session-1", cwd = mainCwd) {
	const widgets = new Map<string, unknown>();
	const placements = new Map<string, unknown>();
	const notices: Array<[string, string]> = [];
	const inputs: Array<(data: string) => { consume?: boolean } | undefined> = [];
	const overlays: Array<{ component: { render(width: number): string[]; handleInput?(data: string): void }; options: unknown; closed: boolean }> = [];
	let editorText = "";
	let entriesRead = 0;
	let renders = 0;
	// The prompt editor has the focus unless a test moves it to a dialog; like
	// Pi, an overlay takes the focus while it is open.
	const editor = { getText: () => editorText, isShowingAutocomplete: () => false };
	const dialog = { kind: "dialog" };
	let focused: unknown = editor;
	const tui = { requestRender: () => { renders += 1; }, getFocusedComponent: () => focused, terminal: { rows: 40, columns: 100 } };
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		ui: {
			// Like Pi's TUI, a widget factory is mounted when it is set.
			setWidget: (key: string, content: unknown, options?: unknown) => {
				widgets.set(key, content);
				placements.set(key, options);
				if (typeof content === "function") content(tui, plainTheme);
			},
			setStatus() {},
			notify: (message: string, level: string) => notices.push([message, level]),
			onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
				inputs.push(handler);
				return () => { inputs.splice(inputs.indexOf(handler), 1); };
			},
			getEditorText: () => editorText,
			setEditorText: (text: string) => { editorText = text; },
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown, options: unknown) => new Promise(resolve => {
				const overlay = { component: undefined as never, options, closed: false };
				const before = focused;
				overlay.component = factory(tui, plainTheme, {}, value => { overlay.closed = true; focused = before; resolve(value); }) as never;
				focused = overlay.component;
				overlays.push(overlay);
			}),
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => {
				entriesRead += 1;
				return [{ type: "message", message: { role: "assistant", usage: { totalTokens: 5758, cost: { total: 0.061 } } } }];
			},
		},
	} as unknown as ExtensionContext;
	/** Mounts a widget factory like Pi does and renders it. */
	const render = (key: string, width = 100): string[] => {
		const content = widgets.get(key);
		if (typeof content !== "function") return (content as string[] | undefined) ?? [];
		return (content(tui, plainTheme) as { render(width: number): string[] }).render(width);
	};
	/** Raw terminal input, through the listeners like Pi's TUI; true when one consumed it. */
	const press = (...keys: string[]) => keys.map(key => inputs.some(handler => handler(key)?.consume === true));
	const type = (text: string) => {
		const consumed = press(...text.split(""));
		editorText += text;
		return consumed;
	};
	return {
		ctx, widgets, placements, notices, inputs, overlays, render, press, type,
		setEditor: (text: string) => { editorText = text; },
		/** Pi focuses a dialog when it opens; the relay's own dialog by default. */
		focusDialog: (component: unknown = dialog) => { focused = component; },
		focusEditor: () => { focused = editor; },
		entriesRead: () => entriesRead,
		renders: () => renders,
	};
}

let harnesses = 0;

type HarnessOptions = {
	fleetConfig?: Record<string, unknown> | string;
	/** The controller's live permission mode; null reads it through the real yolo channel. */
	permissionMode?: (() => Promise<PermissionMode>) | null;
	events?: Parameters<typeof fakePi>[0];
	/** Another controller process over the same agent home (a reopened fleet). */
	agentHome?: string;
	adoptTransport?: FleetDeps["adoptTransport"];
	alive?: (pid: number) => boolean;
};

function harness(env: NodeJS.ProcessEnv = controllerEnv, options: HarnessOptions = {}) {
	harnesses += 1;
	const h = fakePi(options.events);
	const agentHome = options.agentHome ?? join(scratch, `agent-${harnesses}`);
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
		...(options.adoptTransport ? { adoptTransport: options.adoptTransport } : {}),
		...(options.alive ? { isProcessAlive: options.alive } : {}),
	};
	gentleFleet(h.pi, env, deps);
	const runTimers = () => {
		for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
	};
	const wakeTimers = () => timers.filter(timer => timer.ms === FLEET_WAKE_WINDOW_MS && !timer.cancelled);
	return { ...h, children, spawned, timers, runTimers, wakeTimers, writes, agentHome, configHome, gitCalls };
}

async function spawnMember(h: ReturnType<typeof harness>, ctx: ExtensionContext, name: string, extra: Record<string, unknown> = {}) {
	// T8: cwd is required; these tests pass the controller's own cwd unless they choose one.
	return h.tools.get("fleet_spawn")!.execute(`spawn-${name}`, { name, objective: `Own the ${name} front`, cwd: ctx.cwd, ...extra }, undefined, undefined, ctx);
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
	assert.equal(launch.cwd, mainCwd);
	assert.equal(launch.env[FLEET_ROLE_ENV], "member");
	const dir = launch.args[launch.args.indexOf("--session-dir") + 1];
	assert.equal(dir, join(h.agentHome, "gentle-fleet", "sessions", "fleet-session-1", "api"));
	assert.deepEqual(launch.args.slice(-2), ["--model", "anthropic/claude-sonnet-5-5"]);
	assert.deepEqual(h.children[0].written[0], { id: "api-1", type: "prompt", message: "Own the api front" });
	await spawnMember(h, ctx, "web", { cwd: webCwd });
	assert.equal(h.spawned[1].cwd, webCwd);
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

test("outside the TUI (rpc) the fleet widget keeps one digest line per member", async () => {
	const h = harness();
	const { ctx, widgets } = fakeContext();
	Object.assign(ctx, { mode: "rpc" });
	await h.fire("session_start", ctx);
	await spawnMember(h, ctx, "api");
	await tick();
	h.children[0].emit({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} });
	await tick();
	const lines = widgets.get("gentle-fleet") as string[] | undefined;
	assert.ok(Array.isArray(lines) && lines.some(line => /api \[working\].*last tool read/.test(line)), JSON.stringify(lines));
	assert.deepEqual([...widgets.keys()], ["gentle-fleet"], "no deck widgets outside the TUI");
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
	await spawnMember(h, ctx, "web", { cwd: webCwd });
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
	assert.deepEqual(saved.members.map(member => [member.name, member.cwd, member.status]), [["api", mainCwd, "working"], ["web", webCwd, "exited"]]);
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

// --- T8 (L54): every member runs in its own project directory, given as cwd.
// The first real fleet spawned a member without cwd: it ran in a worktree of
// the controller's repository while its objective was another project.

const spawnTool = (h: ReturnType<typeof harness>) => h.tools.get("fleet_spawn") as unknown as { description: string; parameters: { required?: string[]; properties: Record<string, { description?: string }> } };
const sessionDirOf = (h: ReturnType<typeof harness>, name: string) => join(h.agentHome, "gentle-fleet", "sessions", "fleet-session-1", name);

test("T8: fleet_spawn requires cwd, described as the member's own project directory, and spawns nothing without it", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const tool = spawnTool(h);
	assert.ok(tool.parameters.required?.includes("cwd"), "cwd is a required parameter");
	assert.equal(tool.parameters.required?.includes("create"), false);
	assert.match(String(tool.parameters.properties.cwd.description), /^The member's own project directory/);
	assert.match(String(tool.parameters.properties.create.description), /mkdir -p/);
	assert.match(tool.description, /project directory as cwd/);
	for (const cwd of [undefined, "", "  "]) {
		const result = await spawnMember(h, ctx, "api", { cwd });
		assert.equal(result.content[0].text, "Error: cwd is required: pass the member's own project directory (create: true for a new project).", String(cwd));
	}
	assert.equal(h.spawned.length, 0);
	assert.equal(existsSync(sessionDirOf(h, "api")), false);
	assert.deepEqual(h.gitCalls, []);
});

test("T8: a missing project directory is refused without create, naming create: true, and nothing is created", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const parent = join(scratch, "t8-missing");
	const missing = join(parent, "github-swipe");
	for (const extra of [{}, { create: false }]) {
		const result = await spawnMember(h, ctx, "swipe", { cwd: missing, ...extra });
		assert.equal(result.content[0].text, `Error: ${missing} does not exist. Pass the member's existing project directory as cwd, or create: true to start a new project there.`);
	}
	const file = join(scratch, "t8-a-file");
	writeFileSync(file, "x");
	assert.equal((await spawnMember(h, ctx, "swipe", { cwd: file, create: true })).content[0].text, `Error: ${file} is not a directory.`);
	assert.equal(h.spawned.length, 0);
	assert.equal(existsSync(parent), false);
	assert.equal(existsSync(sessionDirOf(h, "swipe")), false);
	assert.deepEqual(h.gitCalls, []);
});

test("T8: create: true makes the directory with its parents and nothing else, then runs the member there", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const target = join(scratch, "t8-create", "projects", "github-swipe");
	const result = await spawnMember(h, ctx, "swipe", { cwd: target, create: true });
	assert.equal(result.content[0].text, `Spawned fleet member "swipe" in ${target} (new project directory). Its digest arrives when it settles, asks a question or exits.`);
	assert.equal(h.spawned[0].cwd, target);
	assert.deepEqual(readdirSync(target), [], "no git init, no files");
	assert.deepEqual(h.gitCalls.map(args => args.slice(0, 2)), [["rev-parse", "--show-toplevel"]], "git is only asked whether it is a repository");
	// Relative to the controller's cwd; an existing directory with create: true runs in place.
	await spawnMember(h, ctx, "notes", { cwd: join("t8-rel", "notes"), create: true });
	assert.equal(h.spawned[1].cwd, join(mainCwd, "t8-rel", "notes"));
	assert.match((await spawnMember(h, ctx, "web", { cwd: webCwd, create: true })).content[0].text, new RegExp(`in ${webCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Its digest`));
	h.runTimers();
	assert.deepEqual(readLedger(h).members.map(member => [member.name, member.cwd]), [["swipe", target], ["notes", join(mainCwd, "t8-rel", "notes")], ["web", webCwd]]);
});

test("T8: a member never falls back to the controller's repository: its own non-git project runs in place", async () => {
	const h = harness();
	const { repo, root, branches, worktrees } = scratchRepo();
	const { ctx } = fakeContext("fleet-session-1", repo);
	await h.fire("session_start", ctx);
	await h.tools.get("fleet_objective")!.execute("o1", { title: "Swipe", objective: "Build the swipe app." }, undefined, undefined, ctx);
	const project = join(scratch, "t8-elsewhere", "github-swipe");
	mkdirSync(project, { recursive: true });
	await spawnMember(h, ctx, "swipe", { cwd: project });
	assert.equal(h.spawned[0].cwd, project);
	assert.deepEqual([branches(), worktrees()], [["main"], [repo]], "no worktree or branch in the controller's repository");
	assert.deepEqual(readdirSync(root), ["app"]);
});

test("T8: an explicit cwd keeps the T4 worktree rules: a git project gets a worktree beside it, a plain directory runs in place", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await h.tools.get("fleet_objective")!.execute("o1", { title: "Billing", objective: "Ship billing." }, undefined, undefined, ctx);
	const { root, repo, branches, worktrees } = scratchRepo();
	const path = join(root, "app.fleet", "billing", "api");
	const result = await spawnMember(h, ctx, "api", { cwd: repo });
	assert.equal(result.content[0].text, `Spawned fleet member "api" in ${path} on new branch fleet/billing/api (worktree of ${repo}). Its digest arrives when it settles, asks a question or exits.`);
	assert.equal(h.spawned[0].cwd, path);
	assert.deepEqual([branches(), worktrees()], [["fleet/billing/api", "main"], [repo, path]]);
	await spawnMember(h, ctx, "pub", { cwd: webCwd });
	assert.equal(h.spawned[1].cwd, webCwd);
});

test("T8: digests and fleet_status show new tokens and cost; the ledger keeps new and cached; fleet_inspect the breakdown", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await spawnMember(h, ctx, "swipe");
	await tick();
	const [swipe] = h.children;
	swipe.emit({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 20000, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 22000, cost: { total: 1 } } } });
	swipe.emit({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 1000, output: 3000, cacheRead: 880000, cacheWrite: 25000, totalTokens: 909000, cost: { total: 0.65 } } } });
	swipe.emit({ type: "agent_settled", aborted: false });
	await tick();
	h.runTimers();
	const digest = String(h.sent.at(-1)?.message.content);
	assert.match(digest, /swipe \[idle\] · 51\.0k new tok · \$1\.65/);
	assert.doesNotMatch(digest, /931\.0k/);
	assert.match((await h.tools.get("fleet_status")!.execute("s", {}, undefined, undefined, ctx)).content[0].text, /51\.0k new tok · \$1\.65/);
	assert.match((await h.tools.get("fleet_inspect")!.execute("i", { name: "swipe" }, undefined, undefined, ctx)).content[0].text, /^tokens: 51\.0k new \(input 21\.0k, output 5\.0k, cache write 25\.0k\) · 880\.0k cached · 931\.0k with cache$/m);
	const saved = readLedger(h).members[0];
	assert.deepEqual([saved.tokens, saved.newTokens, saved.cacheRead], [931000, 51000, 880000]);
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

// --- T5-U2 (S1, S4, S7): the calm deck in the controller TUI.

// The deck's keys from anywhere (user, T5-U3): alt+1-4 lenses, alt+z zoom, alt+m density.
const ALT_1 = "\x1b1", ALT_2 = "\x1b2", ALT_3 = "\x1b3", ALT_4 = "\x1b4", ALT_Z = "\x1bz", ALT_M = "\x1bm", TAB = "\t";
const FUNCTION_KEYS = ["\x1bOP", "\x1bOQ", "\x1bOR", "\x1bOS", "\x1b[15~"];

async function deckFleet(options: HarnessOptions = {}) {
	const h = harness(controllerEnv, options);
	const view = fakeContext();
	const asked: Array<{ title: string; options?: string[]; signal?: AbortSignal }> = [];
	const ui = view.ctx.ui as unknown as Record<string, unknown>;
	// The human has not answered the open dialog yet.
	// Like Pi, the open dialog has the focus until it closes.
	const open = (signal?: AbortSignal) => {
		view.focusDialog();
		signal?.addEventListener("abort", () => view.focusEditor(), { once: true });
		return new Promise(() => {});
	};
	ui.select = (title: string, choices: string[], opts?: { signal?: AbortSignal }) => { asked.push({ title, options: choices, signal: opts?.signal }); return open(opts?.signal); };
	ui.confirm = (title: string, _message: string, opts?: { signal?: AbortSignal }) => { asked.push({ title, signal: opts?.signal }); return open(opts?.signal); };
	await h.fire("session_start", view.ctx);
	await h.tools.get("fleet_objective")!.execute("o", { title: `deck-${harnesses}`, objective: "Ship team workspaces." }, undefined, undefined, view.ctx);
	await spawnMember(h, view.ctx, "web-invites", { worktree: false });
	await tick();
	const child = h.children[0];
	const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
	const status = () => view.render("gentle-fleet-status").join("\n");
	const responses = () => child.written.filter(command => command.type === "extension_ui_response");
	return { h, ...view, asked, child, settle, status, responses };
}

test("in the TUI the deck replaces the one-line widget: strip and focal bar above the input, lens panel, status and hint below", async () => {
	const d = await deckFleet();
	assert.equal(typeof d.widgets.get("gentle-fleet"), "function", "a component, not digest lines");
	assert.deepEqual(d.placements.get("gentle-fleet"), { placement: "aboveEditor" });
	assert.deepEqual(d.placements.get("gentle-fleet-top"), { placement: "aboveEditor" });
	assert.deepEqual(d.placements.get("gentle-fleet-status"), { placement: "belowEditor" });
	assert.deepEqual([...d.widgets.keys()].filter(key => key.startsWith("gentle-fleet")), ["gentle-fleet-top", "gentle-fleet-lens", "gentle-fleet", "gentle-fleet-status"], "strip, lens fallback, focal bar, then below the input");
	assert.match(d.render("gentle-fleet-top")[0], /◎ deck-\d+ · .* 0% of the plan · 0 of 1 fronts done/);
	assert.match(d.render("gentle-fleet-top")[1], /Nothing needs you/);
	assert.deepEqual(d.render("gentle-fleet"), [], "no focal item: no focal bar");
	const lens = d.render("gentle-fleet-lens").join("\n");
	assert.match(lens, /Flows {2}Map {2}Costs {2}Log +alt\+1-4/);
	assert.match(lens, /● web-invites/);
	assert.match(d.status(), /1 of 1 members live · nothing needs you .*lens flows · density light/);
	assert.match(d.status(), /enter send .*alt\+1-4 lenses .*alt\+z zoom .*alt\+m detail/);
	assert.doesNotMatch(d.status(), /\bF\d/, "no function keys in the hints");
});

test("member changes refresh the deck coalesced: many events, one snapshot per render", async () => {
	const d = await deckFleet();
	d.render("gentle-fleet");
	const reads = d.entriesRead();
	const renders = d.renders();
	for (let i = 0; i < 20; i++) d.child.emit({ type: "tool_execution_start", toolCallId: String(i), toolName: "read", args: {} });
	await d.settle();
	assert.ok(d.renders() > renders, "a change asks Pi for a render");
	assert.equal(d.entriesRead(), reads, "nothing is rebuilt before Pi renders");
	d.render("gentle-fleet");
	d.render("gentle-fleet-lens");
	d.render("gentle-fleet-status");
	assert.equal(d.entriesRead(), reads + 1, "one snapshot serves every widget of the frame");
	assert.match(d.status(), /1 of 1 members live/);
});

test("alt+1-4 switch the lens, alt+m cycles the density, alt+z zooms and z or alt+z closes the zoom; F-keys do nothing", async () => {
	const d = await deckFleet();
	assert.deepEqual(d.press(...FUNCTION_KEYS), FUNCTION_KEYS.map(() => false));
	assert.equal(d.overlays.length, 0);
	assert.deepEqual(d.press(ALT_2), [true]);
	assert.match(d.status(), /lens map · density light/);
	d.press(ALT_3);
	assert.match(d.render("gentle-fleet-lens").join("\n"), /\$0\.00/, "the costs lens shows spend");
	d.press(ALT_4, ALT_1);
	assert.match(d.status(), /lens flows/);
	d.press(ALT_M);
	assert.match(d.status(), /density normal/);
	d.press(ALT_M, ALT_M);
	assert.match(d.status(), /density light/, "power wraps back to light");
	assert.deepEqual(d.press(ALT_Z), [true]);
	assert.equal(d.overlays.length, 1);
	assert.deepEqual(d.overlays[0].options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } });
	assert.match(d.overlays[0].component.render(100).join("\n"), /Flows {2}Map.*\n[\s\S]*web-invites/);
	assert.match(d.status(), /z back to the conversation/);
	// Inside the zoom, letters switch the lens.
	assert.deepEqual(d.press("m"), [true]);
	assert.match(d.status(), /lens map/);
	assert.deepEqual(d.press("z"), [true]);
	assert.equal(d.overlays[0].closed, true);
	await d.settle();
	d.press(ALT_Z);
	d.press(ALT_Z);
	assert.equal(d.overlays[1].closed, true, "the zoom key closes it too");
});

test("typing a message that starts with a lens letter keeps every character and switches nothing", async () => {
	const d = await deckFleet();
	for (const text of ["fix the login", "make it so", "listo", "zoom in", "$5 budget", "? what now"]) {
		d.setEditor("");
		assert.ok(d.type(text).every(consumed => !consumed), text);
		assert.match(d.status(), /lens flows · density light/, text);
	}
	assert.equal(d.overlays.length, 0);
});

test("tab reaches the focal bar only from an empty input with a focal item", async () => {
	const d = await deckFleet();
	assert.deepEqual(d.press(TAB), [false], "nothing needs the human: Pi's tab");
	d.child.emit({ type: "extension_ui_request", id: "p1", ...MESSAGING });
	await d.settle();
	d.setEditor("draft");
	assert.deepEqual(d.press(TAB), [false], "a draft keeps Pi's tab (autocomplete)");
	d.setEditor("");
	assert.deepEqual(d.press(TAB), [true]);
	assert.match(d.status(), /1-3 choose .*tab back to the conversation/);
	assert.deepEqual(d.press(TAB), [true]);
	assert.match(d.status(), /tab your call .*enter send/);
});

test("1-4 on a relayed dialog forward the human's choice through the relay, once, and close its open dialog", async () => {
	const d = await deckFleet();
	d.child.emit({ type: "extension_ui_request", id: "p1", ...MESSAGING });
	await d.settle();
	assert.equal(d.asked.length, 1, "the relay opened its one dialog");
	// The relay dialog has the focus; tab and the digits still reach the deck.
	d.focusDialog();
	const focal = d.render("gentle-fleet").join("\n");
	assert.match(focal, /Your call → Authorize cross-orchestrator message to peer\?/);
	assert.match(focal, /\[1\] Allow once {3}\[2\] Allow for this session {3}\[3\] Deny/);
	assert.deepEqual(d.press(TAB, "3"), [true, true]);
	await d.settle();
	assert.deepEqual(d.responses(), [{ id: "p1", type: "extension_ui_response", value: "Deny" }]);
	assert.equal(d.asked[0].signal?.aborted, true, "the open dialog is dismissed");
	d.h.runTimers();
	const ledger = readLedger(d.h);
	assert.ok(ledger.log.some(entry => entry.kind === "answer" && /human answered \(relayed by the fleet\) "Authorize cross-orchestrator message to peer\? Reason: sync": Deny/.test(entry.text)), JSON.stringify(ledger.log));
	assert.deepEqual(d.render("gentle-fleet"), [], "the focal bar leaves");
	assert.match(d.render("gentle-fleet-top").join("\n"), /Nothing needs you/);
	assert.deepEqual(d.h.userMessages, [], "a relayed answer never goes to the fleet model");
});

test("fleet_answer escalate brings a member question to the deck; the human's choice goes to the fleet as a user message", async () => {
	const d = await deckFleet();
	d.child.emit({ type: "extension_ui_request", id: "q1", method: "select", title: "Invite links expire after?", options: ["7 days", "30 days"] });
	await d.settle();
	const result = await d.h.tools.get("fleet_answer")!.execute("e", { name: "web-invites", escalate: true }, undefined, undefined, d.ctx);
	assert.match(result.content[0].text, /^Brought web-invites's select "Invite links expire after\?" to the human/);
	assert.match(d.render("gentle-fleet").join("\n"), /Your call → Invite links expire after\?[\s\S]*\[1\] 7 days {3}\[2\] 30 days/);
	assert.match((await d.h.tools.get("fleet_answer")!.execute("e2", { name: "web-invites", escalate: true }, undefined, undefined, d.ctx)).content[0].text, /^Error: .*already/);
	assert.deepEqual(d.press(TAB, "2"), [true, true]);
	await d.settle();
	assert.equal(d.h.userMessages.length, 1);
	assert.match(String(d.h.userMessages[0].content), /^The human answered web-invites's escalated question q1 \("Invite links expire after\?"\): 30 days\. Answer the member with fleet_answer\.$/);
	assert.deepEqual(d.responses(), [], "the fleet, not the deck, answers the member");
	assert.deepEqual(d.render("gentle-fleet"), [], "the focal bar leaves");
	assert.match(d.render("gentle-fleet-top").join("\n"), /Nothing needs you/);
	await d.h.tools.get("fleet_answer")!.execute("a", { name: "web-invites", answer: "30 days" }, undefined, undefined, d.ctx);
	d.h.runTimers();
	assert.deepEqual(readLedger(d.h).escalations, []);
});

test("a protected dialog cannot be escalated: it already goes to the human", async () => {
	const d = await deckFleet();
	d.child.emit({ type: "extension_ui_request", id: "p1", ...DATA_LOSS });
	await d.settle();
	const result = await d.h.tools.get("fleet_answer")!.execute("e", { name: "web-invites", escalate: true }, undefined, undefined, d.ctx);
	assert.match(result.content[0].text, /^Error: dialog p1 .* is relayed to the human/);
});

test("previous behavior with the deck mounted: a settle still wakes the controller with one code-built digest", async () => {
	const d = await deckFleet();
	d.child.emit({ type: "agent_settled", aborted: false });
	await d.settle();
	assert.equal(d.h.wakeTimers().length, 1);
	d.h.runTimers();
	assert.equal(d.h.sent.length, 1);
	assert.equal(d.h.sent[0].message.customType, FLEET_DIGEST_MESSAGE_TYPE);
	assert.match(String(d.h.sent[0].message.content), /^Fleet update \(code-built digest\):\n- web-invites \[idle\]/);
	assert.deepEqual(d.h.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("fleet_send refuses a slash command and sends nothing", async () => {
	const d = await deckFleet();
	for (const message of ["/gentle:review-mode disable", "  /gentle:telemetry enable"]) {
		const result = await d.h.tools.get("fleet_send")!.execute("s", { name: "web-invites", message }, undefined, undefined, d.ctx);
		assert.equal(result.content[0].text, "Error: fleet_send sends instructions, not slash commands.");
	}
	assert.equal(d.child.written.length, 1, "only the objective prompt");
	assert.match((await d.h.tools.get("fleet_send")!.execute("s", { name: "web-invites", message: "use the /api/invites route" }, undefined, undefined, d.ctx)).content[0].text, /^Sent/);
});

test("the controller drops the residual skills catalog from its prompt; members and normal sessions keep theirs", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const skills = [{ name: "branch-pr", description: "Create PRs", filePath: "/skills/branch-pr/SKILL.md" }];
	const event = { systemPromptOptions: { skills: [...skills], appendSystemPrompt: "" } };
	await h.fire("before_agent_start", ctx, event);
	assert.deepEqual(event.systemPromptOptions.skills, []);
	for (const env of [{}, { [FLEET_ROLE_ENV]: "member" }]) assert.equal(harness(env).handlers.get("before_agent_start"), undefined, JSON.stringify(env));
});

test("without the deck (rpc) fleet_answer escalate is refused and the question stays with the fleet", async () => {
	const f = await fleetWithMember({ ctx: { mode: "rpc" } });
	f.child.emit({ type: "extension_ui_request", id: "q1", method: "confirm", title: "Ship today?" });
	await f.settle();
	const result = await f.answer({ escalate: true });
	assert.equal(result.content[0].text, "Error: the human has no fleet deck in this mode; ask them with ask_user_question or ask_user_choice.");
	assert.deepEqual(f.h.userMessages, []);
	assert.match((await f.answer({ answer: "yes" })).content[0].text, /^Answered/);
});

// --- T5-U3 (S1, S4, S7): the deck is the controller's whole screen from the
// first frame (design/fleet-tui/05-calm-deck.html), empty fleet included.

test("the deck renders from the first frame of an empty fleet: invitation, nothing needs you yet, empty lenses", async () => {
	const h = harness();
	const view = fakeContext();
	await h.fire("session_start", view.ctx);
	const welcome = view.render("gentle-fleet-top").join("\n");
	assert.match(welcome, /Start a fleet[\s\S]*Describe the objective[\s\S]*Ship team workspaces for Inkwell/);
	assert.doesNotMatch(welcome, /◎/, "no objective strip before the objective");
	assert.deepEqual(view.render("gentle-fleet"), []);
	for (const [key, empty] of [[ALT_1, /No members yet/], [ALT_2, /No map yet/], [ALT_3, /No spend yet/], [ALT_4, /No events yet/]] as const) {
		view.press(key);
		assert.match(view.render("gentle-fleet-lens").join("\n"), empty);
	}
	assert.match(view.render("gentle-fleet-status")[0], /^0 of 0 members live · nothing needs you +lens log · density light$/);
});

test("the controller's super-yolo is one segment of the status line; normal adds none", async () => {
	for (const [mode, segment] of [["super-yolo", true], ["normal", false], ["yolo", false]] as const) {
		const h = harness(controllerEnv, { permissionMode: async () => mode });
		const view = fakeContext();
		await h.fire("session_start", view.ctx);
		await tick();
		const status = view.render("gentle-fleet-status")[0];
		assert.equal(/· super-yolo: auto-approves guarded prompts/.test(status), segment, `${mode}: ${status}`);
	}
});

test("on the fullscreen rail the lens card is the fleet part and the objective strip is the fleet-top part", async () => {
	const h = harness();
	const view = fakeContext();
	await h.fire("session_start", view.ctx);
	const tui = { requestRender() {}, getFocusedComponent: () => undefined, terminal: { rows: 40, columns: 180 } } as unknown as TUI;
	(view.widgets.get("gentle-fleet-top") as (tui: TUI, theme: unknown) => unknown)(tui, plainTheme);
	(view.widgets.get("gentle-fleet-lens") as (tui: TUI, theme: unknown) => unknown)(tui, plainTheme);
	const parts = sidebarState(tui).parts;
	assert.match(parts.get("fleet")!.render(48).join("\n"), /✿ Fleet[\s\S]*Flows {2}Map {2}Costs {2}Log[\s\S]*No members yet/);
	const fill = (parts.get("fleet") as { fill?(width: number, height: number): string[] }).fill;
	assert.equal(fill?.(48, 33).length, 33, "the lens card fills the rail's height");
	assert.match(parts.get("fleet-top")!.render(120).join("\n"), /Start a fleet/);
	await h.tools.get("fleet_objective")!.execute("o", { title: "Ship team workspaces", objective: "API, web app and docs." }, undefined, undefined, view.ctx);
	assert.match(parts.get("fleet-top")!.render(120)[0], /◎ Ship team workspaces/, "the objective strip replaces the welcome card");
	assert.match(parts.get("fleet")!.render(48).join("\n"), /✿ Fleet\s*\n.*Ship team workspaces\s*\n.*[▰▱]{8} 0 of 0 fronts/);
});

// Verifier B on c5ff132d4 (Risk item 2): focal mode belongs to the component
// that had the keys when it began; a dialog opened over it gets every key.
test("verifier B: a dialog opened over focal mode on a relayed protected dialog gets every key and approves nothing", async () => {
	const d = await deckFleet();
	d.child.emit({ type: "extension_ui_request", id: "p1", ...MESSAGING });
	await d.settle();
	assert.deepEqual(d.press(TAB), [true], "the relay dialog has the keys: focal mode starts");
	d.focusDialog({ kind: "ask_user_question input" });
	assert.deepEqual(d.type("1 week"), [false, false, false, false, false, false]);
	await d.settle();
	assert.deepEqual(d.responses(), [], "nothing is written to the member");
	assert.equal(d.asked[0].signal?.aborted, false, "the relay dialog stays open");
	assert.match(d.status(), /tab your call/, "focal mode ended");
});

test("verifier B: a dialog opened over focal mode on an escalation sends no fabricated answer", async () => {
	const d = await deckFleet();
	d.child.emit({ type: "extension_ui_request", id: "q1", method: "select", title: "Invite links expire after?", options: ["7 days", "30 days"] });
	await d.settle();
	await d.h.tools.get("fleet_answer")!.execute("e", { name: "web-invites", escalate: true }, undefined, undefined, d.ctx);
	assert.deepEqual(d.press(TAB), [true]);
	d.focusDialog({ kind: "ask_user_question input" });
	assert.deepEqual(d.type("1 hour"), [false, false, false, false, false, false]);
	await d.settle();
	assert.deepEqual(d.h.userMessages, [], "no answer reaches the fleet");
	assert.deepEqual(d.responses(), []);
	assert.match(d.render("gentle-fleet").join("\n"), /Your call → Invite links expire after\?/, "the question still waits for the human");
});

test("verifier B: letters typed in a dialog over focal mode or the zoom keep every character", async () => {
	const d = await deckFleet();
	d.child.emit({ type: "extension_ui_request", id: "q1", method: "select", title: "Ship today?", options: ["Yes", "No"] });
	await d.settle();
	await d.h.tools.get("fleet_answer")!.execute("e", { name: "web-invites", escalate: true }, undefined, undefined, d.ctx);
	d.press(TAB);
	d.focusDialog({ kind: "input" });
	assert.deepEqual(d.type("fine"), [false, false, false, false]);
	assert.match(d.status(), /lens flows/);
	d.focusEditor();
	d.press(ALT_Z);
	d.focusDialog({ kind: "input over the zoom" });
	assert.deepEqual(d.type("map zoom"), [false, false, false, false, false, false, false, false]);
	assert.match(d.status(), /lens flows/);
	assert.equal(d.overlays[0].closed, false);
});

test("verifier B: focal mode on the relay dialog ends when that dialog closes", async () => {
	const d = await deckFleet();
	d.child.emit({ type: "extension_ui_request", id: "p1", ...MESSAGING });
	await d.settle();
	d.press(TAB);
	// The human answers in the dialog itself; Pi gives the keys back to the editor.
	d.focusEditor();
	assert.deepEqual(d.press("1"), [false]);
	assert.deepEqual(d.responses(), []);
});

// Verifier advisories on c5ff132d4, folded into the same correction.
test("advisory 1: fleet_spawn refuses an objective that starts with a slash command and spawns nothing", async () => {
	const h = harness();
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	for (const objective of ["/gentle:review-mode disable", "  /gentle:telemetry enable"]) {
		const result = await spawnMember(h, ctx, "web", { objective, worktree: false });
		assert.equal(result.content[0].text, "Error: fleet_spawn sends instructions, not slash commands.");
	}
	assert.equal(h.children.length, 0);
	assert.match((await spawnMember(h, ctx, "web", { objective: "Wire the /api/invites route", worktree: false })).content[0].text, /web/);
	assert.equal(h.children.length, 1);
});

test("advisory 2: in focal mode a digit past the options, or a key the bar does not use, leaves focal mode untouched", async () => {
	const d = await deckFleet();
	d.child.emit({ type: "extension_ui_request", id: "q1", method: "select", title: "Ship today?", options: ["Yes", "No"] });
	await d.settle();
	await d.h.tools.get("fleet_answer")!.execute("e", { name: "web-invites", escalate: true }, undefined, undefined, d.ctx);
	for (const key of ["3", "x"]) {
		assert.deepEqual(d.press(TAB), [true], key);
		assert.deepEqual(d.press(key), [false], `${key} reaches the input`);
		assert.match(d.status(), /tab your call .*enter send/, `${key} ends focal mode`);
	}
	assert.deepEqual(d.h.userMessages, []);
});

test("advisory 3: escape leaves focal mode and never reaches the editor as Pi's interrupt", async () => {
	const d = await deckFleet();
	d.child.emit({ type: "extension_ui_request", id: "q1", method: "select", title: "Ship today?", options: ["Yes", "No"] });
	await d.settle();
	await d.h.tools.get("fleet_answer")!.execute("e", { name: "web-invites", escalate: true }, undefined, undefined, d.ctx);
	d.press(TAB);
	assert.deepEqual(d.press("\x1b"), [true]);
	assert.match(d.status(), /tab your call .*enter send/);
	assert.deepEqual(d.press("\x1b"), [false], "outside focal mode escape is Pi's");
});

// --- T6 (S2, S3, S5): reopening a fleet controller session (Pi's --continue,
// --resume or --session) resumes its fleet from the ledger.

const RESUME_SESSION = "fleet-resume";
const ticks = async () => { for (let i = 0; i < 5; i++) await tick(); };

/** A fleet that ran and stopped with its controller: two live members, one stopped by the fleet after a respawn. */
async function stoppedFleet(options: { sessionFiles?: string[] } = {}) {
	const config = { memberBudgetUsd: 1, fleetBudgetUsd: 1.5 };
	const first = harness(controllerEnv, { fleetConfig: config, permissionMode: async () => "super-yolo" });
	const repo = scratchRepo();
	const view = fakeContext(RESUME_SESSION, repo.repo);
	(view.ctx.ui as unknown as Record<string, unknown>).confirm = async () => true;
	await first.fire("session_start", view.ctx, { reason: "startup" });
	const tool = (name: string, params: Record<string, unknown>) => first.tools.get(name)!.execute(name, params, undefined, undefined, view.ctx);
	await tool("fleet_objective", { title: "Resume me", objective: "Ship the resume flow." });
	await spawnMember(first, view.ctx, "api");
	await spawnMember(first, view.ctx, "pub", { worktree: false });
	await spawnMember(first, view.ctx, "old", { worktree: false });
	await tick();
	const [api, pub, old] = first.children;
	old.emit(usage(0.2));
	await tool("fleet_stop", { name: "old" });
	await ticks();
	await spawnMember(first, view.ctx, "old", { worktree: false });
	await tool("fleet_stop", { name: "old" });
	api.emit(usage(0.85));
	pub.emit(usage(0.3));
	api.emit({ type: "extension_ui_request", id: "p1", ...GUARDED });
	pub.emit({ type: "extension_ui_request", id: "q1", method: "select", title: "Pick a channel", options: ["X", "LinkedIn"] });
	await ticks();
	await tool("fleet_answer", { name: "pub", escalate: true });
	await tool("fleet_grant", { scope: "publish:social", description: "Publish scheduled posts" });
	await first.fire("session_shutdown", view.ctx, { reason: "quit" });
	await ticks();
	first.runTimers();
	const sessionDir = (name: string) => join(first.agentHome, "gentle-fleet", "sessions", RESUME_SESSION, name);
	const sessionFile = (name: string) => join(sessionDir(name), "2026-11-02T12-00-00-000Z_member.jsonl");
	for (const name of options.sessionFiles ?? ["api", "pub"]) writeFileSync(sessionFile(name), "{}\n");
	return { first, repo, config, sessionDir, sessionFile, saved: readLedger(first, RESUME_SESSION), document: join(repo.repo, "odd", "fleet", "resume-me.md"), apiWorktree: join(repo.root, "app.fleet", "resume-me", "api") };
}

/** The human reopens the controller session: a new controller process over the same agent home. */
async function reopen(fleet: Awaited<ReturnType<typeof stoppedFleet>>, options: { fleetConfig?: Record<string, unknown>; sessionId?: string; mode?: string } = {}) {
	const h = harness(controllerEnv, { agentHome: fleet.first.agentHome, fleetConfig: options.fleetConfig ?? fleet.config });
	const view = fakeContext(options.sessionId ?? RESUME_SESSION, fleet.repo.repo);
	if (options.mode) Object.assign(view.ctx, { mode: options.mode });
	await h.fire("session_start", view.ctx, { reason: "startup" });
	await ticks();
	const ledger = () => {
		h.runTimers();
		return readLedger(h, options.sessionId ?? RESUME_SESSION);
	};
	const choose = async (key: string) => {
		const consumed = view.press(TAB, key);
		await ticks();
		return consumed;
	};
	return { h, ...view, ledger, choose, focal: () => view.render("gentle-fleet").join("\n") };
}

const settleAndDigest = async (h: ReturnType<typeof harness>, child: FakeChild, cost: number) => {
	child.emit(usage(cost));
	child.emit({ type: "agent_settled", aborted: false });
	await ticks();
	h.runTimers();
	return budgetLines(String(h.sent.at(-1)?.message.content ?? ""));
};

test("a reopened fleet session loads its ledger: objective, document, grants, auto-approvals, budget warnings, retired cost, escalations and log", async () => {
	const fleet = await stoppedFleet();
	assert.deepEqual([...fleet.saved.interrupted].sort(), ["api", "pub"], "shutdown records the members it stopped");
	const r = await reopen(fleet);
	assert.equal(r.h.spawned.length, 0, "nothing restarts before the human chooses");
	const saved = r.ledger();
	assert.deepEqual([saved.title, saved.objective, saved.slug, saved.documentPath], ["Resume me", "Ship the resume flow.", "resume-me", fleet.document]);
	assert.deepEqual(saved.grants.map(grant => [grant.id, grant.scope]), [["g1", "publish:social"]]);
	assert.deepEqual(saved.autoApprovals, fleet.saved.autoApprovals);
	assert.equal(saved.autoApprovals.length, 1);
	assert.deepEqual(saved.budgetWarnings, fleet.saved.budgetWarnings);
	assert.deepEqual(saved.budgetWarnings.map(warning => [warning.member, warning.threshold]), [["api", 80], [null, 80]]);
	assert.equal(saved.retiredCost, 0.2);
	assert.deepEqual(saved.escalations.map(entry => [entry.member, entry.dialogId, entry.title]), [["pub", "q1", "Pick a channel"]]);
	assert.deepEqual(saved.log.slice(0, fleet.saved.log.length), fleet.saved.log);
	assert.ok(saved.log.some(entry => entry.kind === "resume" && /api, pub/.test(entry.text)), JSON.stringify(saved.log.slice(-3)));
	assert.deepEqual(saved.members.map(member => [member.name, member.status]), [["api", "stopped"], ["pub", "stopped"], ["old", "exited"]]);
	const document = readFileSync(fleet.document, "utf8");
	assert.match(document, /^# Fleet: Resume me$/m);
	assert.match(document, /^- g1 · `publish:social`/m);
	// Resumed members continue their spend: thresholds already warned stay quiet.
	await r.choose("1");
	const api = r.h.children[0];
	assert.deepEqual(await settleAndDigest(r.h, api, 0.05), [], "no 80% warning repeats");
	assert.deepEqual(await settleAndDigest(r.h, api, 0.2), ["budget: member api spent $1.10 of its $1.00 budget (100%); it keeps working", "budget: fleet spent $1.60 of its $1.50 budget (100%); fleet_spawn refuses new members"]);
});

test("the resume question is the deck's one focal item, asked once, without a dialog or a wake", async () => {
	const r = await reopen(await stoppedFleet());
	const focal = r.focal();
	assert.match(focal, /Your call → Resume 2 members\?/);
	assert.match(focal, /\[1\] Resume all {3}\[2\] Keep them stopped/);
	assert.equal(focal.match(/Your call/g)?.length, 1);
	assert.deepEqual(r.h.sent, [], "the fleet model is not woken before the human chooses");
	assert.deepEqual(r.h.userMessages, []);
	assert.deepEqual(r.notices, []);
});

test("[1] resumes each member with its own session file in its existing worktree, creating no worktree", async () => {
	const fleet = await stoppedFleet();
	const before = [fleet.repo.branches(), fleet.repo.worktrees()];
	const r = await reopen(fleet);
	assert.deepEqual(await r.choose("1"), [true, true]);
	const sessionArgs = (args: string[]) => args.slice(args.indexOf("--session-dir"), args.indexOf("--session-dir") + 4);
	assert.deepEqual(r.h.spawned.map(launch => [launch.cwd, sessionArgs(launch.args)]), [
		[fleet.apiWorktree, ["--session-dir", fleet.sessionDir("api"), "--session", fleet.sessionFile("api")]],
		[fleet.repo.repo, ["--session-dir", fleet.sessionDir("pub"), "--session", fleet.sessionFile("pub")]],
	]);
	assert.deepEqual([fleet.repo.branches(), fleet.repo.worktrees()], before);
	assert.ok(r.h.gitCalls.every(args => args[0] === "rev-parse"), JSON.stringify(r.h.gitCalls));
	assert.deepEqual(r.h.children.map(child => child.written.filter(command => command.type === "prompt")), [[], []], "each continues its own conversation");
	const status = (await r.h.tools.get("fleet_status")!.execute("s", {}, undefined, undefined, r.ctx)).content[0].text.split("\n");
	assert.deepEqual(status.slice(0, 2), ["api [starting] · 110 new tok · $0.85", "pub [starting] · 110 new tok · $0.30"], "a resumed member keeps counting from its earlier spend");
	assert.match(String(r.h.sent.at(-1)?.message.content), /resumed api, pub/);
	assert.doesNotMatch(r.focal(), /Resume/);
	const saved = r.ledger();
	assert.deepEqual(saved.interrupted, []);
	assert.deepEqual(saved.members.map(member => [member.name, member.status]), [["api", "starting"], ["pub", "starting"], ["old", "exited"]]);
});

test("[2] keeps the members stopped: marked exited, and the next reopen asks nothing", async () => {
	const fleet = await stoppedFleet();
	const r = await reopen(fleet);
	await r.choose("2");
	assert.equal(r.h.spawned.length, 0);
	const saved = r.ledger();
	assert.deepEqual(saved.members.map(member => [member.name, member.status]), [["api", "exited"], ["pub", "exited"], ["old", "exited"]]);
	assert.deepEqual(saved.interrupted, []);
	assert.ok(saved.log.some(entry => entry.kind === "stop" && entry.member === "api" && /kept stopped/.test(entry.text)));
	assert.doesNotMatch(r.focal(), /Resume|api stopped|pub stopped/);
	// The escalation from before the stop is still the human's: the answer goes to the fleet.
	assert.match(r.focal(), /Your call → Pick a channel/);
	await r.choose("2");
	assert.match(String(r.h.userMessages.at(-1)?.content), /^The human answered pub's escalated question q1 \("Pick a channel"\) from before the fleet stopped: LinkedIn\./);
	assert.deepEqual(r.ledger().escalations, []);
	await r.h.fire("session_shutdown", r.ctx, { reason: "quit" });
	const again = await reopen(fleet);
	assert.doesNotMatch(again.focal(), /Resume/);
	assert.equal(again.h.spawned.length, 0);
});

test("a member whose worktree or session file is missing gets a Blocker and is not resumed", async () => {
	const fleet = await stoppedFleet({ sessionFiles: ["api"] });
	renameSync(fleet.apiWorktree, `${fleet.apiWorktree}-moved`);
	const r = await reopen(fleet);
	await r.choose("1");
	assert.equal(r.h.spawned.length, 0);
	const saved = r.ledger();
	assert.deepEqual(saved.blockers.map(note => note.member), ["api", "pub"]);
	assert.match(saved.blockers[0].text, /not resumed: worktree .*resume-me\/api is missing/);
	assert.match(saved.blockers[1].text, /not resumed: no session file in /);
	assert.deepEqual(saved.members.map(member => member.status), ["exited", "exited", "exited"]);
	assert.match(r.focal(), /Your call → Pick a channel .*then: 1 more/, "the restored escalation first, then api's blocker");
	assert.match(readFileSync(fleet.document, "utf8"), /^- api: not resumed: worktree .* is missing$/m);
	assert.ok(r.h.gitCalls.every(args => args[0] === "rev-parse"), JSON.stringify(r.h.gitCalls));
});

test("the member limit and the fleet budget apply to resumes like spawns", async () => {
	const limited = await reopen(await stoppedFleet(), { fleetConfig: { memberBudgetUsd: 1, fleetBudgetUsd: 1.5, maxLiveMembers: 1 } });
	await limited.choose("1");
	assert.deepEqual(limited.h.spawned.map(launch => launch.args[launch.args.indexOf("--session-dir") + 1].split("/").at(-1)), ["api"]);
	assert.match(limited.ledger().blockers.map(note => `${note.member}: ${note.text}`).join("\n"), /^pub: not resumed: the fleet runs at most 1 live members/m);
	const spent = await reopen(await stoppedFleet(), { fleetConfig: { fleetBudgetUsd: 1.3 } });
	await spent.choose("1");
	assert.equal(spent.h.spawned.length, 0);
	assert.deepEqual(spent.ledger().blockers.map(note => note.text.replace(/\$[\d.]+/g, "$")), ["not resumed: the fleet spent $ of its $ budget", "not resumed: the fleet spent $ of its $ budget"]);
});

test("without the deck (rpc) the stopped members wait for a terminal reopen: nothing restarts, nothing is decided", async () => {
	const fleet = await stoppedFleet();
	const r = await reopen(fleet, { mode: "rpc" });
	assert.equal(r.h.spawned.length, 0);
	assert.deepEqual([...r.ledger().interrupted].sort(), ["api", "pub"]);
	await r.h.fire("session_shutdown", r.ctx, { reason: "quit" });
	assert.match((await reopen(fleet)).focal(), /Resume 2 members\?/);
});

test("switching sessions in one controller process and back (Pi's /resume) asks to resume the members the switch stopped", async () => {
	const h = harness();
	const first = fakeContext("fleet-a");
	await h.fire("session_start", first.ctx, { reason: "startup" });
	await spawnMember(h, first.ctx, "api", { worktree: false });
	await tick();
	const other = fakeContext("fleet-b");
	await h.fire("session_start", other.ctx, { reason: "resume" });
	await ticks();
	h.runTimers();
	assert.equal(other.render("gentle-fleet").join("\n"), "", "the other fleet has nothing to resume");
	const back = fakeContext("fleet-a");
	await h.fire("session_start", back.ctx, { reason: "resume" });
	assert.match(back.render("gentle-fleet").join("\n"), /Your call → Resume 1 member\?/);
	assert.equal(h.spawned.length, 1, "nothing restarted by itself");
});

test("a fresh fleet session over the same agent home starts empty: no restored state, no resume question", async () => {
	const fleet = await stoppedFleet();
	const r = await reopen(fleet, { sessionId: "fleet-fresh" });
	assert.equal(r.focal(), "");
	assert.equal((await r.h.tools.get("fleet_status")!.execute("s", {}, undefined, undefined, r.ctx)).content[0].text, "No fleet members.");
	await r.h.tools.get("fleet_objective")!.execute("o", { title: "Fresh", objective: "Start over." }, undefined, undefined, r.ctx);
	const saved = readLedger(r.h, "fleet-fresh");
	assert.deepEqual([saved.members, saved.grants, saved.budgetWarnings, saved.escalations, saved.autoApprovals, saved.retiredCost, saved.interrupted], [[], [], [], [], [], 0, []]);
	assert.deepEqual(saved.log.map(entry => entry.kind), ["objective"]);
});

test("previous behavior: a new fleet session writes a new ledger and asks no resume question", async () => {
	const h = harness();
	const { ctx, render } = fakeContext("fleet-brand-new");
	await h.fire("session_start", ctx, { reason: "startup" });
	await h.tools.get("fleet_objective")!.execute("o", { title: "Brand new", objective: "Start clean." }, undefined, undefined, ctx);
	const saved = readLedger(h, "fleet-brand-new");
	assert.deepEqual(saved.log.map(entry => entry.kind), ["objective"]);
	assert.deepEqual(render("gentle-fleet"), []);
	assert.equal(h.spawned.length, 0);
});

test("alt+1-4 switch the lens from the input and every typed character still reaches the editor", async () => {
	const d = await deckFleet();
	for (const [key, lens] of [["\x1b2", "map"], ["\x1b3", "costs"], ["\x1b4", "log"], ["\x1b1", "flows"]] as const) {
		assert.deepEqual(d.press(key), [true], lens);
		assert.match(d.status(), new RegExp(`lens ${lens} · density light`));
	}
	d.setEditor("");
	assert.ok(d.type("1 fix map 2 costs").every(consumed => !consumed));
	assert.match(d.status(), /lens flows/);
	assert.match(d.status(), /alt\+1-4 lenses/);
});

// T8 verifier B1: create: true inside an existing repository repeated L54 (a
// worktree of the controller's repository). A new project must live outside it.
test("T8: create: true inside an existing git repository is refused and creates nothing", async () => {
	const h = harness();
	const { repo, root, branches, worktrees } = scratchRepo();
	const { ctx } = fakeContext("fleet-session-1", repo);
	await h.fire("session_start", ctx);
	await h.tools.get("fleet_objective")!.execute("o1", { title: "Swipe", objective: "Build the swipe app." }, undefined, undefined, ctx);
	for (const cwd of ["github-swipe", join(repo, "nested", "github-swipe")]) {
		const target = isAbsolute(cwd) ? cwd : join(repo, cwd);
		const result = await spawnMember(h, ctx, "swipe", { cwd, create: true });
		assert.equal(result.content[0].text, `Error: ${target} is inside the git repository ${repo}; a new project needs its own directory outside it (for example ${join(dirname(repo), basename(target))}).`, cwd);
		assert.equal(existsSync(target), false, "nothing created");
	}
	assert.deepEqual(h.spawned, []);
	assert.deepEqual([branches(), worktrees()], [["main"], [repo]]);
	assert.deepEqual(readdirSync(root), ["app"]);
});

// --- T9 (S8): the human adopts an already-open Gentle Shell session from the
// fleet TUI with /fleet:adopt; it continues headless as a member on its own
// session file once its window handed off and exited.

const ADOPT_PID = 31337;

type AdoptPeer = { sessionId: string; label: string; workspace: string; refuse?: string; silent?: boolean };

/** A fake transport whose peers act like the target's gentle-agents: they write the accepted (or refused) hand-off. */
function adoptPeers(agentHome: () => string, peers: AdoptPeer[]) {
	const sent: Array<{ fleet: string; recipient: string; request: { fleetSlug: string; token: string } }> = [];
	const listed: string[] = [];
	const transport: NonNullable<FleetDeps["adoptTransport"]> = {
		candidates: async fleet => {
			listed.push(fleet);
			return peers.map(({ sessionId, label, workspace }) => ({ sessionId, label, workspace }));
		},
		send: async (fleet, recipient, request) => {
			sent.push({ fleet, recipient, request });
			const peer = peers.find(entry => entry.sessionId === recipient)!;
			if (peer.silent) return false;
			mkdirSync(agentHome(), { recursive: true });
			if (peer.refuse) {
				writeAdoptHandoff(agentHome(), request.token, { state: "refused", reason: peer.refuse });
				return false;
			}
			writeAdoptHandoff(agentHome(), request.token, { state: "accepted", pid: ADOPT_PID, label: peer.label });
			return true;
		},
	};
	return { transport, sent, listed };
}

async function adoptHarness(peers: AdoptPeer[], options: HarnessOptions & { env?: NodeJS.ProcessEnv } = {}) {
	let home = "";
	const fake = adoptPeers(() => home, peers);
	const alive = new Set([ADOPT_PID]);
	const h = harness(options.env ?? controllerEnv, { ...options, adoptTransport: fake.transport, alive: pid => alive.has(pid) });
	home = h.agentHome;
	const view = fakeContext();
	const selects: Array<{ title: string; options: string[] }> = [];
	let pick: (options: string[]) => string | undefined = options => options[0];
	(view.ctx.ui as unknown as Record<string, unknown>).select = async (title: string, options: string[]) => {
		selects.push({ title, options });
		return pick(options);
	};
	await h.fire("session_start", view.ctx, { reason: "startup" });
	const adopt = () => h.commands.get("fleet:adopt")!.handler("", view.ctx);
	const token = () => fake.sent.at(-1)!.request.token;
	const ready = (handoff: Partial<{ sessionFile: string; cwd: string; label: string }> = {}) => {
		const sessionFile = handoff.sessionFile ?? join(scratch, "pi-sessions", "--work-blog--", "2026-11-02T11-00-00-000Z_blog.jsonl");
		mkdirSync(dirname(sessionFile), { recursive: true });
		writeFileSync(sessionFile, "{}\n");
		writeAdoptHandoff(h.agentHome, token(), { state: "ready", pid: ADOPT_PID, label: handoff.label ?? "Blog posts", sessionFile, sessionDir: dirname(sessionFile), cwd: handoff.cwd ?? webCwd });
		return sessionFile;
	};
	const pollTimers = () => h.timers.filter(timer => timer.ms === ADOPT_POLL_MS && !timer.cancelled);
	const poll = () => { for (const timer of pollTimers()) { h.timers.splice(h.timers.indexOf(timer), 1); timer.fn(); } };
	return { h, ...view, fake, alive, selects, adopt, token, ready, poll, pollTimers, choose: (fn: typeof pick) => { pick = fn; } };
}

test("/fleet:adopt is a human-only command: no tool is added and the controller allowlist is unchanged", () => {
	const h = harness();
	assert.match(h.commands.get("fleet:adopt")?.description ?? "", /Adopt a running Gentle Shell session/);
	assert.deepEqual([...h.tools.keys()].filter(name => /adopt/.test(name)), []);
	assert.equal(h.tools.size, 9);
	for (const env of [{}, { [FLEET_ROLE_ENV]: "member" }]) assert.equal(harness(env).commands.size, 0, "only the controller registers it");
});

test("with no other open session /fleet:adopt shows a notice and asks nothing", async () => {
	const a = await adoptHarness([]);
	await a.adopt();
	assert.deepEqual(a.selects, []);
	assert.deepEqual(a.fake.sent, []);
	assert.deepEqual(a.fake.listed, ["fleet-session-1"], "the fleet's own session is excluded by the registry");
	assert.deepEqual(a.notices.at(-1), ["No other Gentle Shell session is open to adopt.", "info"]);
	assert.equal(a.h.spawned.length, 0);
});

test("the picker lists open sessions by label and directory, never another fleet controller", async () => {
	const a = await adoptHarness([
		{ sessionId: "peer-blog-0001", label: "Blog posts", workspace: "/work/blog" },
		{ sessionId: "other-fleet-01", label: "Other fleet", workspace: "/work/other" },
		{ sessionId: "peer-nolabel-1", label: "", workspace: "" },
	]);
	mkdirSync(join(a.h.agentHome, "gentle-fleet", "sessions", "other-fleet-01"), { recursive: true });
	a.choose(() => undefined);
	await a.adopt();
	assert.equal(a.selects.length, 1);
	assert.match(a.selects[0].title, /Adopt which session/);
	assert.deepEqual(a.selects[0].options, ["Blog posts · /work/blog · peer-blo", "unnamed · unknown directory · peer-nol"]);
	assert.deepEqual(a.fake.sent, [], "a dismissed picker sends nothing");
});

test("an adopted session respawns headless on its own session file only after its hand-off exists and its window exited", async () => {
	const a = await adoptHarness([{ sessionId: "peer-blog-0001", label: "Blog posts", workspace: "/work/blog" }], { env: { ...controllerEnv, GENTLE_PI_AUTONOMOUS_MODE: "1" } });
	await a.adopt();
	assert.deepEqual(a.fake.sent.map(entry => [entry.fleet, entry.recipient, entry.request.fleetSlug]), [["fleet-session-1", "peer-blog-0001", "fleet-fleet-session-1"]]);
	assert.match(a.token(), /^[A-Za-z0-9_-]{8,128}$/);
	assert.match(a.notices.at(-1)?.[0] ?? "", /Adopting "Blog posts": it finishes its current turn, closes its window and joins the fleet/);
	a.poll();
	assert.equal(a.h.spawned.length, 0, "no hand-off yet");
	const sessionFile = a.ready();
	a.poll();
	assert.equal(a.h.spawned.length, 0, "the window has not exited yet: never two writers on one session file");
	a.alive.delete(ADOPT_PID);
	a.poll();
	assert.equal(a.h.spawned.length, 1);
	const launch = a.h.spawned[0];
	assert.equal(launch.cwd, webCwd, "the session's own directory, no worktree");
	assert.deepEqual(launch.args.slice(launch.args.indexOf("--session-dir"), launch.args.indexOf("--session-dir") + 4), ["--session-dir", dirname(sessionFile), "--session", sessionFile]);
	assert.equal(launch.env[FLEET_ROLE_ENV], "member");
	assert.equal(launch.env.GENTLE_PI_AUTONOMOUS_MODE, undefined, "members always start in normal permission mode");
	assert.deepEqual(a.h.gitCalls, [], "nothing is created for an adopted member");
	assert.deepEqual(a.h.children[0].written.filter(command => command.type === "prompt"), [], "it continues its own conversation");
	assert.equal(a.pollTimers().length, 0);
	assert.match(String(a.h.sent.at(-1)?.message.content), /adopted blog-posts: the human's session "Blog posts" in .* continues as a member/);
	a.h.runTimers();
	const saved = readLedger(a.h);
	assert.deepEqual(saved.members.map(member => [member.name, member.cwd, member.sessionFile, member.adopted, member.worktree]), [["blog-posts", webCwd, sessionFile, true, null]]);
	assert.match(readFileSync(saved.documentPath, "utf8"), /^\| blog-posts \| Adopted session "Blog posts" \|/m);
	const status = (await a.h.tools.get("fleet_status")!.execute("s", {}, undefined, undefined, a.ctx)).content[0].text;
	assert.match(status, /^blog-posts \[starting\]/);
});

test("a refused, silent or vanished adoption leaves one Blockers entry and a notice, and spawns nothing", async () => {
	const refused = await adoptHarness([{ sessionId: "peer-rpc-00001", label: "Desktop", workspace: "/w", refuse: "this is not an interactive terminal session (rpc mode)" }]);
	await refused.adopt();
	refused.h.runTimers();
	assert.deepEqual(readLedger(refused.h).blockers.map(note => [note.member, note.text]), [["desktop", "not adopted: this is not an interactive terminal session (rpc mode)"]]);
	assert.deepEqual(refused.notices.at(-1), ["Gentle Fleet did not adopt \"Desktop\": this is not an interactive terminal session (rpc mode).", "warning"]);
	const silent = await adoptHarness([{ sessionId: "peer-old-00001", label: "Old shell", workspace: "/w", silent: true }]);
	await silent.adopt();
	silent.h.runTimers();
	assert.match(readLedger(silent.h).blockers[0].text, /^not adopted: it did not accept the adopt request/);
	const vanished = await adoptHarness([{ sessionId: "peer-blog-0001", label: "Blog posts", workspace: "/w" }]);
	await vanished.adopt();
	vanished.alive.delete(ADOPT_PID);
	vanished.poll();
	vanished.h.runTimers();
	assert.deepEqual(readLedger(vanished.h).blockers.map(note => note.text), ["not adopted: the session closed without a hand-off"]);
	for (const a of [refused, silent, vanished]) assert.equal(a.h.spawned.length, 0);
});

test("the member limit and the fleet budget refuse before any adopt request is sent", async () => {
	const limited = await adoptHarness([{ sessionId: "peer-blog-0001", label: "Blog posts", workspace: "/w" }], { fleetConfig: { maxLiveMembers: 1 } });
	await spawnMember(limited.h, limited.ctx, "api");
	await limited.adopt();
	assert.deepEqual([limited.fake.listed, limited.fake.sent], [[], []]);
	assert.match(limited.notices.at(-1)?.[0] ?? "", /^Gentle Fleet cannot adopt a session: the fleet runs at most 1 live members/);
	const spent = await adoptHarness([{ sessionId: "peer-blog-0001", label: "Blog posts", workspace: "/w" }], { fleetConfig: { fleetBudgetUsd: 0.1 } });
	await spawnMember(spent.h, spent.ctx, "api");
	spent.h.children[0].emit(usage(0.2));
	await tick();
	await spent.adopt();
	assert.deepEqual(spent.fake.sent, []);
	assert.match(spent.notices.at(-1)?.[0] ?? "", /^Gentle Fleet cannot adopt a session: the fleet spent \$0\.20 of its \$0\.10 budget/);
});

test("an adopted member's name is unique among members, and the controller's shutdown clears a pending adoption", async () => {
	const a = await adoptHarness([{ sessionId: "peer-blog-0001", label: "api", workspace: "/w" }]);
	await spawnMember(a.h, a.ctx, "api");
	await a.adopt();
	a.ready({ label: "api" });
	a.alive.delete(ADOPT_PID);
	a.poll();
	assert.deepEqual(a.h.spawned.map(launch => launch.args.includes("--session")), [false, true]);
	a.h.runTimers();
	assert.deepEqual(readLedger(a.h).members.map(member => member.name), ["api", "api-2"]);
	const pending = await adoptHarness([{ sessionId: "peer-blog-0001", label: "Blog posts", workspace: "/w" }]);
	await pending.adopt();
	assert.equal(pending.pollTimers().length, 1);
	await pending.h.fire("session_shutdown", pending.ctx, { reason: "quit" });
	assert.equal(pending.pollTimers().length, 0, "no watch timer outlives the controller session");
});

test("a reopened fleet resumes an adopted member on its recorded session file", async () => {
	const a = await adoptHarness([{ sessionId: "peer-blog-0001", label: "Blog posts", workspace: "/w" }]);
	await a.adopt();
	const sessionFile = a.ready({ sessionFile: join(scratch, "pi-sessions", "--work-resume--", "2026-11-02T11-30-00-000Z_resume.jsonl") });
	a.alive.delete(ADOPT_PID);
	a.poll();
	await a.h.fire("session_shutdown", a.ctx, { reason: "quit" });
	a.h.runTimers();
	const h = harness(controllerEnv, { agentHome: a.h.agentHome });
	const view = fakeContext();
	await h.fire("session_start", view.ctx, { reason: "startup" });
	await ticks();
	view.press(TAB, "1");
	await ticks();
	assert.equal(h.spawned.length, 1);
	const args = h.spawned[0].args;
	assert.deepEqual(args.slice(args.indexOf("--session-dir"), args.indexOf("--session-dir") + 4), ["--session-dir", dirname(sessionFile), "--session", sessionFile]);
	assert.equal(h.spawned[0].cwd, webCwd);
});
