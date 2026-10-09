import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { pendingReviewMutation, pendingReviewMutationProfiles, REVIEW_REMINDER_RECEIPT } from "../lib/review-reminder-receipt.ts";
import { SESSION_WORKTREE_ENTRY, SESSION_WORKTREE_CHANGED, resolveSessionWorktree } from "../lib/session-worktree-registry.ts";
import { installSessionChangeCapture } from "../lib/session-change-capture.ts";
import { SessionChanges, type SessionChangeEvidence } from "../lib/session-changes.ts";
import test, { after, afterEach, before, mock } from "node:test";
import type { TestContext } from "node:test";
import { generateUnifiedPatch, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { sidebarState } from "../lib/shell-sidebar.ts";
import { CHILD_PACKAGE_INJECTION_ENV, encodeChildPackageInjection } from "../lib/child-package-injection.ts";
import gentleAgents, { agentRuntimePaths, agentsCollapseKey, agentsEnabled, agentsStopKey, agentsViewKey, agentResultPreview, answerThroughUi, childContextExtensionPaths, completionText, createDefaultSessionTransport, legacySubagentsInstalled, PARENT_WAKE_GRACE_MS, type AgentsDeps, type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { ActiveSessionClient, ActiveSessionListener, SessionPresenceRegistry } from "../lib/agents-session-transport.ts";
import { WindowsActiveSessionClient, WindowsActiveSessionListener } from "../lib/windows-session-transport.ts";
import { historyDir, loadHistory, saveTask } from "../lib/agents-history.ts";
import { STALE_COMPLETION_MS } from "../lib/agents-completion-delivery.ts";
import { applyTaskEvent, emptyThread, MISSING_TOOLS_NOTE_PREFIX, TASK_EVENT, TASK_STATUS, TaskStore, type TaskRecord } from "../lib/agents-protocol.ts";
import { NativePointerScope } from "../lib/native-pointer-region.ts";
import { PresenceCursor, PresencePublisher, listPresence, readActivity, readDiscovery } from "../lib/orchestrator-presence.ts";
import { OrchestratorScopeCache } from "../lib/orchestrator-scope.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";
import { AgentRunner, REQUESTED_TOOLS_ENV } from "../lib/agents-runner.ts";
import { bindSessionRepositoryPreparation } from "../lib/bounded-writer-admission.ts";
import { bindSessionProfile, resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import { CHILD_METRICS_EVENT } from "../lib/runtime-metrics-children.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
// The card style defaults to float; these assertions pin the outlined (neon)
// panels unless a test switches the style itself.
const initialCardStyle = cardStyle();
before(() => setCardStyle(CARD_STYLE.NEON));
after(() => setCardStyle(initialCardStyle));

// Gentle Agents extension: the subagent_* tools drive isolated pi children,
// the card above the editor follows the store, and dialogs reach the host UI.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface Registered {
	parameters: { properties: Record<string, unknown> };
	renderShell?: string;
	name: string;
	execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
	renderCall(args: unknown, theme: unknown): { render(width: number): string[] };
	renderResult(result: { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }, options: { expanded: boolean }, theme: unknown): { render(width: number): string[] };
}

const plainTheme = { fg: (_color: string, text: string) => text };
// Session shutdown persists finished subagent history asynchronously, so a
// late write can race a teardown removal; Node retries ENOTEMPTY/EBUSY here
// instead of failing the test (macOS showed it, #1840).
const TEST_DIR_REMOVAL = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const fakeTui = { requestRender() {} };
const inertSessionTransport: SessionTransportFactory = {
	createRegistry: async () => ({ list: async () => [], listActivations: async () => [] }),
	createListener: (registry) => ({ registry, start: async () => {}, close: async () => {} }),
	createClient: () => ({ close() {}, sendNotification: async () => { throw new Error("inert session transport must not send notifications"); } }),
};

function containsResolvedPath(
	candidate: string,
	path: string,
	paths: Pick<typeof win32, "isAbsolute" | "relative" | "sep"> = { isAbsolute, relative, sep },
): boolean {
	const fromCandidate = paths.relative(candidate, path);
	return fromCandidate === "" || (!paths.isAbsolute(fromCandidate) && fromCandidate !== ".." && !fromCandidate.startsWith(`..${paths.sep}`));
}

type Overlay = {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse?(event: TuiMouseEvent): unknown;
};

function mouse(
	type: TuiMouseEvent["type"],
	button: TuiMouseEvent["button"],
	x: number,
	y: number,
	width: number,
	height: number,
): TuiMouseEvent {
	return { type, button, x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false };
}
const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-agents-ext-")));
const activeSessionTeardowns = new Set<() => Promise<void>>();
const stopActiveSessions = () => Promise.all([...activeSessionTeardowns].map((shutdown) => shutdown()));
afterEach(stopActiveSessions);
// subagent_run's default mode now reads the background-subagents policy
// in-process (gentle-pi#background-subagents-default-mode), which falls
// back to the real ~/.pi/gentle-ai/background-subagents.json when
// GENTLE_PI_CONFIG_HOME is unset. Point it at an empty scratch directory so
// this file's expectations never depend on the developer's own global
// policy file (a real "on" file on the runner's machine would otherwise
// flip every unrelated fixture's default mode to background).
const previousGentlePiConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
process.env.GENTLE_PI_CONFIG_HOME = join(root, "gentle-ai-config-home");
after(async () => {
	try { await stopActiveSessions(); }
	finally {
		if (previousGentlePiConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousGentlePiConfigHome;
		rmSync(root, TEST_DIR_REMOVAL);
	}
});
const home = join(root, "home");
const cwd = join(root, "project");
const nonGitCwd = join(root, "non-git-project");
mkdirSync(join(home, ".pi", "agent", "agents"), { recursive: true });
mkdirSync(cwd, { recursive: true });
mkdirSync(nonGitCwd, { recursive: true });
writeFileSync(join(home, ".pi", "agent", "agents", "explore.md"), "---\ndescription: maps things\nmodel: openai-codex/gpt-5.6-terra\nthinking: high\ntools: [read, grep]\n---\nYou map things.");
writeFileSync(join(home, ".pi", "agent", "subagents.json"), JSON.stringify({ max_concurrency: 2, model_profiles: { explore: { effort: "low" } } }));

// Existing prompt-lifecycle regressions exercise the bridge route by default.
function fakePi(initialProvider: string = "claude-bridge") {
	const transformers: Array<Parameters<ExtensionAPI["registerMarkdownTransformer"]>[0]> = [];
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Registered>();
	const shortcuts = new Map<string, { description: string; handler(ctx: ExtensionContext): Promise<void> }>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	// `delivery` records custom messages and user wakes in dispatch order.
	const userMessages: Array<{ content: unknown; options: Record<string, unknown> | undefined }> = [];
	const delivery: string[] = [];
	// A live idle flag shared by every context fired through this host, like
	// Pi's ctx.isIdle(): busy from agent_start until agent_settled. Tests can
	// force it to simulate compaction or other non-run busy states.
	let selectedProvider: string | undefined = initialProvider;
	const setProvider = (provider: string | undefined) => { selectedProvider = provider; };
	let parentIdle = true;
	const setIdle = (idle: boolean) => { parentIdle = idle; };
	const renderers = new Map<string, (message: unknown, options: { expanded: boolean }, theme: unknown) => { render(width: number): string[] }>();
	const entryRenderers = new Map<string, (entry: { type: string; customType: string; data: unknown }, options: { expanded: boolean }, theme: unknown) => { render(width: number): string[] }>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const events: Array<{ name: string; data: unknown }> = [];
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerMarkdownTransformer: (transformer: Parameters<ExtensionAPI["registerMarkdownTransformer"]>[0]) => transformers.push(transformer),
		events: {
			emit: (name: string, data: unknown) => { events.push({ name, data }); for (const listener of listeners.get(name) ?? []) listener(data); },
			on: (name: string, listener: (data: unknown) => void) => {
				const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(listener);
				return () => { set.delete(listener); };
			},
		},
		sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => { sent.push({ message, options }); delivery.push(`custom:${String(message.customType)}`); },
		sendUserMessage: (content: unknown, options?: Record<string, unknown>) => { userMessages.push({ content, options }); delivery.push("user"); },
		registerMessageRenderer: (type: string, renderer: (message: unknown, options: { expanded: boolean }, theme: unknown) => { render(width: number): string[] }) => renderers.set(type, renderer),
		registerEntryRenderer: (type: string, renderer: (entry: { type: string; customType: string; data: unknown }, options: { expanded: boolean }, theme: unknown) => { render(width: number): string[] }) => entryRenderers.set(type, renderer),
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (tool: Registered) => tools.set(tool.name, tool),
		registerShortcut: (key: string, registration: { description: string; handler(ctx: ExtensionContext): Promise<void> }) => shortcuts.set(key, registration),
		registerCommand: (name: string, registration: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, registration),
	} as unknown as ExtensionAPI;
	let activeSession: ExtensionContext | undefined;
	const teardown = async () => {
		const ctx = activeSession;
		if (ctx === undefined) return;
		await fire("session_shutdown", ctx, { reason: "quit" });
	};
	const fire = async (event: string, ctx: ExtensionContext, payload: unknown = {}) => {
		const results: unknown[] = [];
		if (!("isIdle" in ctx)) Object.assign(ctx, { isIdle: () => parentIdle });
		if (!("model" in ctx)) Object.defineProperty(ctx, "model", {
			configurable: true,
			get: () => selectedProvider === undefined ? undefined : { provider: selectedProvider },
		});
		if (event === "agent_start") parentIdle = false;
		else if (event === "agent_settled") parentIdle = true;
		try {
			for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
			return results;
		} finally {
			if (event === "session_start") {
				activeSession = ctx;
				activeSessionTeardowns.add(teardown);
			} else if (event === "session_shutdown" && activeSession === ctx) {
				activeSession = undefined;
				activeSessionTeardowns.delete(teardown);
			}
		}
	};
	return { pi, tools, shortcuts, commands, fire, sent, userMessages, delivery, setIdle, setProvider, renderers, entryRenderers, entries, events, listeners, transformers };
}

function fakeContext(tui: { requestRender(): void } = fakeTui, confirmResult: (title: string, message: string) => Promise<boolean> = async () => true, inputResult: (title: string, placeholder: string | undefined) => Promise<string | undefined> = async () => undefined, overlayTui: { terminal: { rows: number }; requestRender(): void } = { terminal: { rows: 30 }, requestRender() {} }, selectResult: (title: string, options: string[]) => Promise<string | undefined> = async (_title, options) => options[0]) {
	const widgets = new Map<string, (tui: unknown, theme: unknown) => { render(width: number): string[] }>();
	const dialogs: string[] = [];
	const overlays: Overlay[] = [];
	const customCompletions: unknown[] = [];
	const customOptions: unknown[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionId: () => "s1", getCwd: () => cwd, getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined },
		ui: {
			notify: (message: string) => dialogs.push(`notify:${message}`),
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => Overlay, options: unknown) =>
				new Promise((resolve) => {
					customOptions.push(options);
					const done = (value: unknown) => {
						customCompletions.push(value);
						resolve(value);
					};
					const component = factory(overlayTui, plainTheme, {}, done);
					overlays.push(component);
				}),
			setWidget(key: string, content: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined) {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, content);
			},
			select: async (title: string, options: string[]) => {
				dialogs.push(`select:${title}:${options.join("|")}`);
				return selectResult(title, options);
			},
			confirm: async (title: string, message: string) => {
				dialogs.push(`confirm:${title}:${message}`);
				return confirmResult(title, message);
			},
			input: async (title: string, placeholder: string | undefined) => {
				dialogs.push(`input:${title}`);
				return inputResult(title, placeholder);
			},
			editor: async () => "edited",
		},
	} as unknown as ExtensionContext;
	const widget = () => {
		const factory = widgets.get("gentle-agents");
		return factory ? factory(tui, plainTheme).render(72).map(stripAnsi) : undefined;
	};
	return { ctx, widget, dialogs, overlays, customCompletions, customOptions };
}

for (const scenario of ["background", "task", "append-failure", "overflow", "bytes", "replacement", "task-replacement", "unsafe-id", "no-transport"] as const) {
	test(`explicit run work publication: ${scenario}`, async t => {
		const h = fakePi(), runtime = deps(), { ctx } = fakeContext();
		gentleAgents(h.pi, {}, runtime.deps);
		await h.fire("session_start", ctx);
		const initial = { objective: "Keep objective", work: { area: "Owner", tasks: { historical: { area: "Old" } } as Record<string, { area: string }> } };
		if (scenario === "overflow") for (let i = 0; i < 7; i++) initial.work.tasks[`old-${i}`] = { area: "Old" };
		if (scenario === "bytes") initial.objective = "x".repeat(1980);
		await h.tools.get("orchestrator_session_id")!.execute("publish", { state: initial }, undefined, undefined, ctx);
		const before = h.entries.length;
		if (scenario === "append-failure") t.mock.method(h.pi, "appendEntry", () => { throw new Error("private credential detail"); });
		let allocated: TaskRecord;
		const run = t.mock.method(AgentRunner.prototype, "run", request => {
			assert.equal(Object.hasOwn(request, "work"), false);
			assert.equal(request.prompt, "Map");
			allocated = { id: scenario === "unsafe-id" ? "constructor" : "actual-allocated-id", agent: "explore", label: "Map", mode: request.mode,
				status: TASK_STATUS.COMPLETED, cwd, prompt: request.prompt, parentSessionId: request.parentSessionId,
				createdAt: 1, startedAt: 1, endedAt: 2, model: "fixture", thinking: undefined,
				sessionPath: null, error: null, result: "Done", lastStep: "Done", lastActivityAt: 2,
				turns: 1, toolCalls: 0, tokens: 0, cost: 0 };
			if (scenario === "replacement") ctx.sessionManager = { ...ctx.sessionManager };
			return allocated;
		});
		t.mock.method(AgentRunner.prototype, "waitForQuery", async () => undefined);
		t.mock.method(AgentRunner.prototype, "waitFor", async () => {
			if (scenario === "task-replacement") ctx.sessionManager = { ...ctx.sessionManager };
			return allocated;
		});
		if (scenario === "no-transport") await h.fire("session_shutdown", ctx);
		const result = await h.tools.get("subagent_run")!.execute("run", { agent: "explore", task: "Map",
			mode: scenario === "task" || scenario === "task-replacement" ? "task" : "background", work: { area: "Auth" } }, undefined, undefined, ctx);
		assert.equal(run.mock.callCount(), 1);
		assert.equal((result.details.gentleAgents as { taskId: string }).taskId, allocated!.id);
		assert.equal(Object.hasOwn(allocated!, "work"), false);
		const success = scenario === "background" || scenario === "task";
		assert.equal((result.details.workPublication as { status: string }).status, success ? "recorded" : "unavailable");
		assert.equal(h.entries.length, before + (success || scenario === "task-replacement" ? 1 : 0));
		assert.doesNotMatch(result.content[0].text, /private credential/);
		if (success) {
			const state = (h.entries.at(-1)!.data as { state: typeof initial }).state;
			assert.equal(state.objective, "Keep objective");
			assert.deepEqual(state.work.tasks, { historical: { area: "Old" }, "actual-allocated-id": { area: "Auth" } });
			const unclassified = await h.tools.get("subagent_run")!.execute("plain", { agent: "explore", task: "Map", mode: "background" }, undefined, undefined, ctx);
			assert.equal(unclassified.details.workPublication, undefined);
			assert.equal(h.entries.length, before + 1);
		}
	});
}

test("invalid run work rejects before foreign consent or allocation", async t => {
	const h = fakePi(), runtime = deps(), { ctx, dialogs } = fakeContext();
	gentleAgents(h.pi, {}, runtime.deps);
	await h.fire("session_start", ctx);
	const run = t.mock.method(AgentRunner.prototype, "run", () => { throw new Error("allocation reached"); });
	for (const work of [{}, { tasks: { guessed: { area: "Auth" } } }, { area: "bad\n" }]) {
		await assert.rejects(h.tools.get("subagent_run")!.execute("invalid", { agent: "explore", task: "Map",
			repository_root: "/foreign", work }, undefined, undefined, ctx), /invalid-published-state/);
	}
	assert.equal(run.mock.callCount(), 0);
	assert.deepEqual(dialogs, []);
});

// Records deps.schedule calls so a test fires exactly the timers it means to;
// unrelated runner timers stay pending.
function recordTimers(target: Partial<AgentsDeps>) {
	const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	target.schedule = (fn, ms) => {
		const timer = { fn, ms, cancelled: false };
		pending.push(timer);
		return () => { timer.cancelled = true; };
	};
	const due = (ms: number) => pending.filter((timer) => timer.ms === ms && !timer.cancelled);
	return {
		pending: (ms: number) => due(ms).length,
		// Capture a known newly armed timer before other same-duration timers
		// (for example child query expiry) are added.
		takeLast: (ms: number) => {
			const timer = due(ms).at(-1);
			assert.ok(timer, `expected a pending ${ms}ms timer`);
			pending.splice(pending.indexOf(timer), 1);
			return () => { if (!timer.cancelled) timer.fn(); };
		},
		run: (ms: number) => {
			const timers = due(ms);
			for (const timer of timers) {
				pending.splice(pending.indexOf(timer), 1);
				timer.fn();
			}
			return timers.length;
		},
	};
}

function deps(): { deps: Partial<AgentsDeps>; children: FakeChild[]; spawned: string[][] } {
	const children: FakeChild[] = [];
	const spawned: string[][] = [];
	let clock = 1000;
	return {
		children,
		spawned,
		deps: {
			runtimeMetricsPolicy: { resolve: () => { throw new Error("Policy not configured in fixture"); } },
			spawn: (command, args) => {
				spawned.push([command, ...args]);
				const child = fakeChild();
				children.push(child);
				return child.child;
			},
			now: () => (clock += 500),
			schedule: () => () => {},
			pi: { command: "pi", args: [] },
			home,
			resolveWorktree: (path, base) => ({ root: resolve(base, path), commonDir: "/fixture/common" }),
			env: { PATH: "/bin" },
			sessionTransport: inertSessionTransport,
		},
	};
}

test("cache warming follows actual Gentle Agents ownership and completion lifecycle", async (t) => {
	const h = fakePi();
	const runtime = deps();
	let store: TaskStore | undefined;
	const list = TaskStore.prototype.list;
	t.mock.method(TaskStore.prototype, "list", function (this: TaskStore, ...args: Parameters<TaskStore["list"]>) {
		store = this;
		return list.apply(this, args);
	});
	const scheduled = t.mock.fn(() => () => {});
	runtime.deps.schedule = scheduled;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	let sessionId = "warming-parent";
	ctx.sessionManager.getSessionId = () => sessionId;
	await h.fire("session_start", ctx);
	const candidate = { type: "cache_warming_decision", warmCost: 0.01, missCost: 0.1, continuationProbability: 0.15, action: "stop" };
	const run = t.mock.method(AgentRunner.prototype, "run");
	const status = t.mock.method(h.tools.get("subagent_status")!, "execute");
	const result = t.mock.method(h.tools.get("subagent_result")!, "execute");
	const decide = async (expected: unknown) => {
		const before = [runtime.spawned.length, run.mock.callCount(), scheduled.mock.callCount(), status.mock.callCount(), result.mock.callCount()];
		const sent = [...h.sent], entries = [...h.entries];
		const childTraffic = runtime.children.map(child => JSON.stringify([child.written, child.sent, child.killed]));
		const timeout = t.mock.method(globalThis, "setTimeout");
		const interval = t.mock.method(globalThis, "setInterval");
		try {
			assert.deepEqual(await h.fire("cache_warming_decision", ctx, candidate), [expected]);
			assert.equal(timeout.mock.callCount(), 0);
			assert.equal(interval.mock.callCount(), 0);
		} finally { timeout.mock.restore(); interval.mock.restore(); }
		assert.deepEqual([runtime.spawned.length, run.mock.callCount(), scheduled.mock.callCount(), status.mock.callCount(), result.mock.callCount()], before);
		assert.deepEqual(h.sent, sent, "no maintenance or duplicate completion message");
		assert.deepEqual(h.entries, entries, "no maintenance context entry");
		assert.deepEqual(runtime.children.map(child => JSON.stringify([child.written, child.sent, child.killed])), childTraffic, "no child inspection, steering, or cancellation");
	};
	await decide(undefined);
	const launch = await h.tools.get("subagent_run")!.execute("warming-launch", { agent: "explore", task: "Map warming", mode: "background" }, undefined, undefined, ctx);
	await tick();
	const taskId = (launch.details.gentleAgents as { taskId: string }).taskId;
	assert.equal(runtime.children.length, 1);
	await decide({ action: "warm" });
	// The same live owned child is foreign when the active session changes.
	sessionId = "other-parent";
	await decide(undefined);
	sessionId = "warming-parent";
	await decide({ action: "warm" });
	runtime.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "mapped" }] }] });
	await tick();
	await decide({ action: "warm" });
	assert.equal(h.sent.length, 0, "agent_end is not settlement");
	runtime.children[0].emit({ type: "agent_settled" });
	await tick();
	await decide(undefined);
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].message.customType, "gentle-agents.result");
	assert.match(JSON.stringify(h.sent[0].message), new RegExp(taskId));
	assert.equal(h.sent[0].options.triggerTurn, false, "an idle parent stores the completion without a direct turn");
	assert.equal(h.userMessages.length, 1, "the idle parent is woken once through the prompt lifecycle");
	assert.equal(run.mock.callCount(), 1, "warming never launches equivalent work");
	// Seed the actual history-restore path with a stale live-looking record:
	// sharing the parent ID and running status must not confer ownership.
	assert.equal(store!.restore({ ...store!.get(taskId)!, id: "warming-restored", status: TASK_STATUS.RUNNING }, emptyThread()), true);
	await decide(undefined);
	await h.fire("session_shutdown", ctx);
	await decide(undefined);
});

// `pi -p` and `pi --mode json` share pi's one-shot runner: it disposes the
// runtime once the prompt returns, so neither can receive a background result.
const SINGLE_SHOT_BACKGROUND_ERROR = "Background subagents are unavailable in single-shot modes: pi -p and pi --mode json exit before a parent session can receive results. Use task mode, RPC mode, or interactive Pi.";

for (const hostMode of ["print", "json"] as const) for (const continuation of [false, true]) {
	test(`${hostMode} mode rejects background ${continuation ? "continuation" : "launch"} before allocating a task`, async (t) => {
		const h = fakePi();
		const runtime = deps();
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		Object.assign(ctx, { mode: hostMode, hasUI: false });
		await h.fire("session_start", ctx);
		let taskId: string | undefined;
		if (continuation) {
			const pending = h.tools.get("subagent_run")!.execute("seed", { agent: "explore", task: "Map", mode: "task" }, undefined, undefined, ctx);
			await tick();
			runtime.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "mapped" }] }] });
			runtime.children[0].emit({ type: "agent_settled" });
			const result = await pending;
			taskId = (result.details.gentleAgents as { taskId: string }).taskId;
		}
		const run = t.mock.method(AgentRunner.prototype, "run");
		const spawnedBefore = runtime.spawned.length;
		const entriesBefore = [...h.entries];
		const historyBefore = await loadHistory(home);
		const listBefore = await h.tools.get("subagent_list_tasks")!.execute("before", {}, undefined, undefined, ctx);
		const tool = h.tools.get(continuation ? "subagent_continue" : "subagent_run")!;
		await assert.rejects(tool.execute("denied", continuation
			? { task_id: taskId, prompt: "Follow up", mode: "background" }
			: { agent: "explore", task: "Map", mode: "background" }, undefined, undefined, ctx), { message: SINGLE_SHOT_BACKGROUND_ERROR });
		await tick();
		assert.equal(run.mock.callCount(), 0, "rejection must precede runner task ID allocation");
		assert.equal(runtime.spawned.length, spawnedBefore, "no child spawned");
		assert.deepEqual(await h.tools.get("subagent_list_tasks")!.execute("after", {}, undefined, undefined, ctx), listBefore, "no new task record");
		assert.deepEqual(await loadHistory(home), historyBefore, "no history write");
		assert.deepEqual(h.entries, entriesBefore, "no worktree registration");
	});
}

for (const mode of ["print", "json", "tui", "rpc"] as const) {
	const singleShot = mode === "print" || mode === "json";
	test(`${mode} preserves ${singleShot ? "bounded task" : "background"} execution`, async () => {
		const h = fakePi();
		const runtime = deps();
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		Object.assign(ctx, { mode, hasUI: mode === "tui" });
		await h.fire("session_start", ctx);
		let resolved = false;
		const pending = h.tools.get("subagent_run")!.execute("control", { agent: "explore", task: "Map", mode: singleShot ? "task" : "background" }, undefined, undefined, ctx).then(result => { resolved = true; return result; });
		await tick();
		assert.equal(runtime.spawned.length, 1);
		assert.equal(resolved, !singleShot, "only task mode waits for completion");
		runtime.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "mapped" }] }] });
		runtime.children[0].emit({ type: "agent_settled" });
		const result = await pending;
		const taskId = (result.details.gentleAgents as { taskId: string }).taskId;
		assert.ok(taskId);
		if (singleShot) assert.equal(result.content[0].text, `Subagent explore (task ${taskId}, "Map") finished.\n\nmapped`, "the task result names its real id for subagent_continue");
		if (!singleShot) {
			await tick();
			assert.match((await h.tools.get("subagent_status")!.execute("status", { task_id: taskId }, undefined, undefined, ctx)).content[0].text, /completed · background/);
			assert.equal(h.sent.length, 1, "settlement delivers exactly one completion");
			assert.equal(h.sent[0].message.customType, "gentle-agents.result");
			assert.equal(h.sent[0].message.content, `Subagent explore (task ${taskId}, "Map") finished.\n\nmapped`);
			assert.equal(h.sent[0].message.display, true);
			assert.deepEqual(h.sent[0].options, { triggerTurn: false });
			assert.deepEqual(h.delivery, ["custom:gentle-agents.result", "user"], "the idle wake follows the stored completion");
			await h.fire("turn_end", ctx);
			await h.fire("turn_end", ctx);
			await tick();
			assert.equal(h.sent.length, 1, "later turns must not redeliver the completion");
			assert.equal((await h.tools.get("subagent_result")!.execute("result", { task_id: taskId }, undefined, undefined, ctx)).content[0].text, "mapped");
		}
	});
}

/** Controllable fake for `AgentsDeps.schedule`: records every scheduled callback instead of running it, so a test can fire the RPC publisher's coalescing window deterministically. */
function fakeScheduler() {
	const pending: Array<{ id: number; fn: () => void }> = [];
	let nextId = 0;
	return {
		schedule: (fn: () => void, _ms: number) => {
			const id = nextId++;
			pending.push({ id, fn });
			return () => {
				const index = pending.findIndex((entry) => entry.id === id);
				if (index !== -1) pending.splice(index, 1);
			};
		},
		flushAll: () => {
			const due = pending.splice(0, pending.length);
			for (const entry of due) entry.fn();
		},
	};
}

for (const scenario of [
	{ label: "an interactive RPC host", mode: "rpc", env: { PATH: "/bin", GENTLE_SHELL_INTERACTIVE_HOST: "1" }, expectPublish: true },
	{ label: "plain RPC without the interactive-host variable", mode: "rpc", env: { PATH: "/bin" }, expectPublish: false },
	{ label: "TUI", mode: "tui", env: { PATH: "/bin" }, expectPublish: false },
] as const) {
	test(`gentle-agents publishes the live activity payload through setWidget only on ${scenario.label}`, async (t) => {
		const h = fakePi();
		const runtime = deps();
		const scheduler = fakeScheduler();
		runtime.deps.schedule = scheduler.schedule;
		runtime.deps.env = scenario.env;
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		Object.assign(ctx, { mode: scenario.mode, hasUI: scenario.mode === "tui" || scenario.mode === "rpc" });
		const setWidget = t.mock.method(ctx.ui, "setWidget");

		await h.fire("session_start", ctx);
		scheduler.flushAll(); // consume the publisher's own start-time frame, if any
		setWidget.mock.resetCalls();

		await h.tools.get("subagent_run")!.execute("control", { agent: "explore", task: "Map", mode: "background" }, undefined, undefined, ctx);
		scheduler.flushAll();

		// The TUI card's own setWidget call always carries a component-factory
		// function, never an array; only the RPC publisher pushes an array.
		const activityCalls = setWidget.mock.calls.filter((call) => call.arguments[0] === "gentle-agents" && Array.isArray(call.arguments[1]));
		if (!scenario.expectPublish) {
			assert.deepEqual(activityCalls, [], "no array-shaped setWidget push outside an interactive RPC host");
			return;
		}
		assert.equal(activityCalls.length, 1, "one push per coalescing window");
		// The fake `ui.setWidget` types `content` as the TUI-only component factory;
		// the RPC publisher instead calls it with a plain `string[]` (real pi's
		// RPC-mode contract), which needs an unknown-mediated cast here.
		const [key, lines] = activityCalls[0]!.arguments as unknown as [string, string[]];
		assert.equal(key, "gentle-agents");
		assert.equal(lines.length, 1);
		const activity = JSON.parse(lines[0]!) as { schema: string; tasks: Array<{ summary: { id: string } }> };
		assert.equal(activity.schema, "gentle-agents.activity/v1");
		assert.ok(activity.tasks.some((task) => typeof task.summary.id === "string" && task.summary.id.length > 0), "the newly launched task must be in the payload");
	});
}

test("gentle-agents notifies once, deduplicated, when the RPC activity publisher's setWidget throws", async (t) => {
	const h = fakePi();
	const runtime = deps();
	const scheduler = fakeScheduler();
	runtime.deps.schedule = scheduler.schedule;
	runtime.deps.env = { PATH: "/bin", GENTLE_SHELL_INTERACTIVE_HOST: "1" };
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	Object.assign(ctx, { mode: "rpc", hasUI: true });
	const notify = t.mock.method(ctx.ui, "notify");
	// Only the publisher's array-shaped push fails; the TUI card's own
	// component-factory push (`showWidget`) must stay untouched.
	ctx.ui.setWidget = ((_key: string, content: unknown) => {
		if (Array.isArray(content)) throw new Error("boom");
	}) as typeof ctx.ui.setWidget;

	await h.fire("session_start", ctx);
	scheduler.flushAll(); // the publisher's own start-time frame fails: one notify

	await h.tools.get("subagent_run")!.execute("control", { agent: "explore", task: "Map", mode: "background" }, undefined, undefined, ctx);
	scheduler.flushAll(); // a second flush with the same recurring failure must not notify again

	assert.equal(notify.mock.callCount(), 1, "the same recurring setWidget failure is deduplicated to one notify per session");
	assert.match(String(notify.mock.calls[0]?.arguments[0]), /boom/);
	assert.equal(notify.mock.calls[0]?.arguments[1], "warning");
});

// Regression for the desktop app's Helpers tab showing helpers from every
// session: a resumed session's own finished tasks restore from disk into
// the shared `TaskStore` (see "resuming a session restores its own
// finished tasks as history, never another session's" above for the
// overlay-render side of this), and the RPC activity publisher created on
// `session_start` must scope its `setWidget` payload to the same session,
// never surfacing another session's restored task.
test("gentle-agents' RPC activity payload excludes a restored task from another session", async (t) => {
	const h = fakePi();
	const runtime = deps();
	const scheduler = fakeScheduler();
	runtime.deps.schedule = scheduler.schedule;
	runtime.deps.env = { PATH: "/bin", GENTLE_SHELL_INTERACTIVE_HOST: "1" };
	const historyHome = join(root, "rpc-restore-history-home");
	const own: TaskRecord = { id: "own-1", agent: "explore-a", mode: "background", prompt: "p", label: "p", cwd, parentSessionId: "resumed-session", status: TASK_STATUS.COMPLETED, createdAt: 1, startedAt: 1, endedAt: 100, model: "m", thinking: undefined, sessionPath: null, error: null, result: "done", lastStep: "responded", lastActivityAt: 100, turns: 1, toolCalls: 0, tokens: 0, cost: 0 };
	const other: TaskRecord = { ...own, id: "not-mine", agent: "explore-other", parentSessionId: "other-session" };
	await saveTask(historyDir(historyHome), own, emptyThread());
	await saveTask(historyDir(historyHome), other, emptyThread());
	runtime.deps.home = historyHome;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	Object.assign(ctx, { mode: "rpc", hasUI: true });
	ctx.sessionManager.getSessionId = () => "resumed-session";
	const setWidget = t.mock.method(ctx.ui, "setWidget");

	await h.fire("session_start", ctx, { reason: "resume" });

	// The disk history read behind restoreSessionHistory is fire-and-forget
	// real async I/O, unrelated to the fake coalescing scheduler; poll both
	// until the resumed session's own restored task reaches a flushed frame.
	let activity: { tasks: Array<{ summary: { id: string } }> } | undefined;
	for (let attempt = 0; attempt < 40 && !activity; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		scheduler.flushAll();
		const activityCalls = setWidget.mock.calls.filter((call) => call.arguments[0] === "gentle-agents" && Array.isArray(call.arguments[1]));
		if (activityCalls.length === 0) continue;
		const [, lines] = activityCalls.at(-1)!.arguments as unknown as [string, string[]];
		const parsed = JSON.parse(lines[0]!) as { tasks: Array<{ summary: { id: string } }> };
		if (parsed.tasks.some((entry) => entry.summary.id === "own-1")) activity = parsed;
	}

	assert.ok(activity, "the RPC activity payload must eventually include the resumed session's own restored task");
	assert.ok(!activity!.tasks.some((entry) => entry.summary.id === "not-mine"), "another session's restored task must never appear in the RPC activity payload");
	await h.fire("session_shutdown", ctx);
});

test("all nine subagent registrations own their transcript shell", () => {
	const { pi, tools } = fakePi();
	gentleAgents(pi, {}, deps().deps);
	const subagentTools = [...tools.values()].filter((tool) => tool.name.startsWith("subagent_"));
	assert.equal(subagentTools.length, 9);
	assert.equal(tools.has("subagent_reconcile"), false);
	for (const tool of subagentTools) assert.equal(tool.renderShell, "self", tool.name);
});

test("host query delivery exposes correlation and accepts one current-session reply", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const started = await tools.get("subagent_run")!.execute("query", { agent: "explore", task: "Ask once", mode: "background" }, undefined, undefined, ctx);
	const taskId = (started.details.gentleAgents as { taskId: string }).taskId;
	await tick();
	harness.children[0].message({ id: "q1", kind: "query", message: "Which file?" });
	await tick();
	assert.match(String(sent.at(-1)?.message.content), new RegExp(`Task ID: ${taskId}\\nRequest ID: q1`));
	assert.equal(sent.at(-1)?.message.display, true, "an explicit child query remains visible");
	(ctx.sessionManager as { getSessionId(): string }).getSessionId = () => "s2";
	assert.match((await tools.get("subagent_reply")!.execute("stale", { task_id: taskId, request_id: "q1", message: "wrong" }, undefined, undefined, ctx)).content[0].text, /unavailable/);
	(ctx.sessionManager as { getSessionId(): string }).getSessionId = () => "s1";
	assert.equal((await tools.get("subagent_reply")!.execute("reply", { task_id: taskId, request_id: "q1", message: "src/a.ts" }, undefined, undefined, ctx)).content[0].text, "Reply accepted for delivery.");
	assert.deepEqual(harness.children[0].sent.at(-1), { id: "q1", kind: "reply", message: "src/a.ts" });
	assert.match((await tools.get("subagent_reply")!.execute("duplicate", { task_id: taskId, request_id: "q1", message: "again" }, undefined, undefined, ctx)).content[0].text, /unavailable/);
});

test("first foreground query yields while its child runs and delivers one completion", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const pending = tools.get("subagent_run")!.execute("foreground", { agent: "explore", task: "Ask then finish" }, undefined, undefined, ctx);
	await tick();
	harness.children[0].message({ id: "q1", kind: "query", message: "Which file?" });
	const yielded = await pending;
	const taskId = (yielded.details.gentleAgents as { taskId: string }).taskId;
	assert.equal((yielded as { terminate?: boolean }).terminate, true);
	assert.deepEqual(harness.children[0].killed, []);
	await tools.get("subagent_reply")!.execute("reply", { task_id: taskId, request_id: "q1", message: "src/a.ts" }, undefined, undefined, ctx);
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 1);
});

test("cancelling a yielded foreground task prevents completion follow-up", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const pending = tools.get("subagent_run")!.execute("cancel", { agent: "explore", task: "cancel after query" }, undefined, undefined, ctx);
	await tick();
	harness.children[0].message({ id: "q1", kind: "query", message: "q" });
	const yielded = await pending;
	const taskId = (yielded.details.gentleAgents as { taskId: string }).taskId;
	assert.match((await tools.get("subagent_cancel")!.execute("stop", { task_id: taskId }, undefined, undefined, ctx)).content[0].text, /Cancelled task/);
	await tick();
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "late" }], stopReason: "stop" }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 0);
});

test("yielded foreground completion is suppressed after session replacement or cancellation", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const pending = tools.get("subagent_run")!.execute("switch", { agent: "explore", task: "switch session" }, undefined, undefined, ctx);
	await tick();
	harness.children[0].message({ id: "q1", kind: "query", message: "q" });
	const yielded = await pending;
	const taskId = (yielded.details.gentleAgents as { taskId: string }).taskId;
	(ctx.sessionManager as { getSessionId(): string }).getSessionId = () => "s2";
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 0);
	(ctx.sessionManager as { getSessionId(): string }).getSessionId = () => "s1";
	assert.match((await tools.get("subagent_cancel")!.execute("cancel", { task_id: taskId }, undefined, undefined, ctx)).content[0].text, /not running/);
});

test("first handoff failure keeps ordinary completion, later failure retains yielded completion", async () => {
	const first = fakePi();
	const firstHarness = deps();
	gentleAgents(first.pi, {}, firstHarness.deps);
	const firstContext = fakeContext();
	await first.fire("session_start", firstContext.ctx);
	(first.pi as unknown as { sendMessage(): void }).sendMessage = () => { throw new Error("host unavailable"); };
	const ordinary = first.tools.get("subagent_run")!.execute("first", { agent: "explore", task: "fail handoff" }, undefined, undefined, firstContext.ctx);
	await tick();
	firstHarness.children[0].message({ id: "q1", kind: "query", message: "q" });
	firstHarness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ordinary" }], stopReason: "stop" }] });
	firstHarness.children[0].emit({ type: "agent_settled" });
	assert.match((await ordinary).content[0].text, /^Subagent explore \(task [^,]+, "fail handoff"\) finished\.\n\nordinary$/);

	const second = fakePi();
	const secondHarness = deps();
	gentleAgents(second.pi, {}, secondHarness.deps);
	const secondContext = fakeContext();
	await second.fire("session_start", secondContext.ctx);
	let sends = 0;
	(second.pi as unknown as { sendMessage(message: Record<string, unknown>, options: Record<string, unknown>): void }).sendMessage = (message, options) => {
		sends += 1;
		if (sends === 2) throw new Error("second unavailable");
		second.sent.push({ message, options });
	};
	const pending = second.tools.get("subagent_run")!.execute("second", { agent: "explore", task: "two queries" }, undefined, undefined, secondContext.ctx);
	await tick();
	secondHarness.children[0].message({ id: "q1", kind: "query", message: "first" });
	await pending;
	secondHarness.children[0].message({ id: "q2", kind: "query", message: "second" });
	secondHarness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }] });
	secondHarness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(second.sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 1);
});

test("foreground handoff survives settlement before its original await resumes", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const pending = tools.get("subagent_run")!.execute("race", { agent: "explore", task: "query then settle" }, undefined, undefined, ctx);
	await tick();
	harness.children[0].message({ id: "q1", kind: "query", message: "q" });
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "race result" }], stopReason: "stop" }] });
	harness.children[0].emit({ type: "agent_settled" });
	assert.equal((await pending as { terminate?: boolean }).terminate, true);
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 1);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
type LifecycleOutcome = { status: "fulfilled" } | { status: "rejected"; error: unknown };
type LifecycleState = { status: "pending" | "fulfilled" | "rejected"; outcome?: LifecycleOutcome };
const observeLifecycle = <T>(promise: Promise<T>, state: LifecycleState): Promise<LifecycleOutcome> => promise.then(() => { const outcome = { status: "fulfilled" as const }; state.status = outcome.status; state.outcome = outcome; return outcome; }, (error) => { const outcome = { status: "rejected" as const, error }; state.status = outcome.status; state.outcome = outcome; return outcome; });
const boundedLifecycle = async <T>(promise: Promise<T>, label: string) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2000); })]); }
	finally { if (timer) clearTimeout(timer); }
};

const drainLifecycle = async (label: string, promise: Promise<LifecycleOutcome>) => {
	try { return { label, outcome: await boundedLifecycle(promise, label) }; }
	catch (error) { return { label, error }; }
};

// The disk history read behind restoreSessionHistory is fire-and-forget from
// session_start, so nothing signals when it lands. Poll the overlay's own
// render output (backed by the live, shared TaskStore) on setImmediate ticks
// instead of sleeping a fixed guess: fast when the restore already landed,
// bounded at 2s so a genuine regression still fails instead of hanging.
async function waitForOverlayMatch(render: () => string, pattern: RegExp, timeoutMs = 2000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let rendered = render();
	while (!pattern.test(rendered) && Date.now() < deadline) {
		await tick();
		rendered = render();
	}
	return rendered;
}

test("overlapping session transport startups preserve ownership and shutdown waits for every pending operation", async (t: TestContext) => {
	const h = fakePi();
	const runtime = deps();
	let sessionId = "old";
	const registryGates: Array<() => void> = [];
	const listenerStarts: string[] = [], listenerCloses: string[] = [], clientCloses: string[] = [], registryCloseCalls: string[] = [], registryCloseEffects: string[] = [];
	const registries = new Map<string, { closed: boolean; close(): Promise<void> }>();
	const transport: SessionTransportFactory = {
		createRegistry: async () => {
			const id = sessionId;
			await new Promise<void>((resolve) => registryGates.push(resolve));
			const registry = { sessionId: id, closed: false, list: async () => [], listActivations: async () => [], close: async () => { registryCloseCalls.push(id); if (!registry.closed) { registry.closed = true; registryCloseEffects.push(id); } } };
			registries.set(id, registry);
			return registry;
		},
		createListener: (registry, id) => ({ registry, closesRegistry: true, start: async () => { listenerStarts.push(id); }, close: async () => { listenerCloses.push(id); await registry.close?.(); } }),
		createClient: (_registry, id) => ({ close: () => { clientCloses.push(id); }, sendNotification: async () => ({ id: "unused", accepted: true }) }),
	};
	runtime.deps.sessionTransport = transport;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	(ctx.sessionManager as { getSessionId(): string }).getSessionId = () => sessionId;
	const launched: Array<{ state: LifecycleState; outcome: Promise<LifecycleOutcome> }> = [];
	const launch = <T>(promise: Promise<T>) => { const state: LifecycleState = { status: "pending" }; const outcome = observeLifecycle(promise, state); launched.push({ state, outcome }); return { state, outcome }; };
	let shutdownRecord: ReturnType<typeof launch> | undefined;
	let primary: unknown;
	try {
		const first = h.fire("session_start", ctx, { reason: "startup" });
		launch(first);
		await tick();
		sessionId = "new";
		const second = h.fire("session_start", ctx, { reason: "new" });
		const secondRecord = launch(second);
		await tick();
		assert.equal(registryGates.length, 2, "both starts must own pending registry creation");
		registryGates[1]!();
		await eventually(() => listenerStarts.includes("new"), "current startup must publish after its registry is ready");
		const shutdown = h.fire("session_shutdown", ctx, { reason: "quit" });
		shutdownRecord = launch(shutdown);
		await tick();
		assert.equal(secondRecord.state.status, "fulfilled", "the current startup settles before shutdown begins");
		assert.equal(shutdownRecord?.state.status, "pending", "shutdown must wait for the older pending startup, not only the current startup");
		registryGates[0]!();
		assert.equal(registries.has("old"), false, "the released old registry gate has not yet completed acquisition");
		assert.equal(registries.get("old")?.closed, undefined, "the retained old registry cannot be closed before acquisition completes");
		await eventually(() => launched.every(({ state }) => state.status !== "pending"), "all launched lifecycle operations must settle after gate release");
		const outcomes = await Promise.all(launched.map(({ outcome }) => outcome));
		assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"), "all launched lifecycle operations must fulfill");
		assert.deepEqual(listenerStarts, ["new"], "the stale startup must never publish");
		assert.deepEqual(clientCloses, ["new"], "the current client closes exactly once");
		assert.deepEqual(listenerCloses, ["new"], "the current listener closes exactly once");
		assert.deepEqual(registryCloseCalls.sort(), ["new", "old"], "each owned registry close is invoked exactly once");
		assert.deepEqual(registryCloseEffects.sort(), ["new", "old"], "each owned registry closes exactly once");
		assert.equal(registries.get("old")?.closed, true);
		assert.equal(registries.get("new")?.closed, true);
	} catch (error) {
		primary = error;
	} finally {
		for (const release of registryGates) release();
		if (shutdownRecord === undefined) shutdownRecord = launch(h.fire("session_shutdown", ctx, { reason: "cleanup" }));
		if (launched.length > 0) {
			try {
				await eventually(() => launched.every(({ state }) => state.status !== "pending"), "all launched lifecycle operations must settle during cleanup");
				const outcomes = await Promise.all(launched.map(({ outcome }) => outcome));
				const cleanupFailure = outcomes.find((outcome) => outcome.status === "rejected");
				if (cleanupFailure?.status === "rejected") {
					if (primary === undefined) primary = cleanupFailure.error;
					else t.diagnostic(`Lifecycle cleanup secondary failure: ${cleanupFailure.error instanceof Error ? cleanupFailure.error.message : String(cleanupFailure.error)}`);
				}
			} catch (error) {
				if (primary === undefined) primary = error;
				else t.diagnostic(`Lifecycle cleanup secondary failure: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	if (primary !== undefined) throw primary;
});

test("session_start does not block a subsequently registered handler on registry creation", async (t: TestContext) => {
	const h = fakePi();
	const runtime = deps();
	let registryEntered = false;
	let listenerCreated = false;
	let clientCreated = false;
	let listenerClosed = 0;
	let clientClosed = 0;
	let releaseRegistry!: () => void;
	const registryGate = new Promise<void>((resolve) => { releaseRegistry = resolve; });
	const transport: SessionTransportFactory = {
		createRegistry: async () => {
			registryEntered = true;
			await registryGate;
			return { list: async () => [], listActivations: async () => [] };
		},
		createListener: (registry) => { listenerCreated = true; return { registry, start: async () => {}, close: async () => { listenerClosed++; } }; },
		createClient: () => { clientCreated = true; return { close() { clientClosed++; }, sendNotification: async () => ({ id: "unused", accepted: true }) }; },
	};
	runtime.deps.sessionTransport = transport;
	gentleAgents(h.pi, {}, runtime.deps);
	let laterFinished = false;
	h.pi.on("session_start", async () => { laterFinished = true; });
	const { ctx } = fakeContext();
	let outcome: Promise<LifecycleOutcome> | undefined;
	let lifecycleState: LifecycleState | undefined;
	let primary: unknown;
	try {
		const started = h.fire("session_start", ctx, { reason: "startup" });
		lifecycleState = { status: "pending" };
		outcome = observeLifecycle(started, lifecycleState);
		await eventually(() => registryEntered, "registry gate must be entered before the bounded handler assertion");
		await eventually(() => laterFinished, "a subsequently registered session_start handler must finish while registry creation is gated");
		releaseRegistry();
		assert.ok(outcome);
		assert.equal((await outcome).status, "fulfilled");
	} catch (error) {
		primary = error;
	} finally {
		releaseRegistry();
		try {
			if (outcome !== undefined) {
				await eventually(() => listenerCreated && clientCreated, "registry-gated startup must acquire owned resources before cleanup shutdown");
				const shutdownState: LifecycleState = { status: "pending" };
				const shutdownOutcome = observeLifecycle(h.fire("session_shutdown", ctx, { reason: "cleanup" }), shutdownState);
				await eventually(() => lifecycleState?.status !== "pending" && shutdownState.status !== "pending", "registry-gated startup cleanup must settle all launched operations");
				const cleanupOutcomes = await Promise.all([outcome, shutdownOutcome]);
				assert.equal(listenerClosed, 1, "cleanup closes the owned listener");
				assert.equal(clientClosed, 1, "cleanup closes the owned client");
				const cleanupFailure = cleanupOutcomes.find((value) => value.status === "rejected");
				if (cleanupFailure?.status === "rejected") {
					if (primary === undefined) primary = cleanupFailure.error;
					else t.diagnostic(`Registry-gate cleanup secondary failure: ${cleanupFailure.error instanceof Error ? cleanupFailure.error.message : String(cleanupFailure.error)}`);
				}
			}
		} catch (error) {
			if (primary === undefined) primary = error;
			else t.diagnostic(`Registry-gate cleanup secondary failure: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (primary !== undefined) throw primary;
});

test("session_start does not block a subsequently registered handler on listener publication", async (t: TestContext) => {
	const h = fakePi();
	const runtime = deps();
	let listenerEntered = false;
	let listenerClosed = 0;
	let clientClosed = 0;
	let releaseListener!: () => void;
	const listenerGate = new Promise<void>((resolve) => { releaseListener = resolve; });
	const registry = { list: async () => [], listActivations: async () => [] };
	const transport: SessionTransportFactory = {
		createRegistry: async () => registry,
		createListener: (ownedRegistry) => ({
			registry: ownedRegistry,
			start: async () => { listenerEntered = true; await listenerGate; },
			close: async () => { listenerClosed++; },
		}),
		createClient: () => ({ close() { clientClosed++; }, sendNotification: async () => ({ id: "unused", accepted: true }) }),
	};
	runtime.deps.sessionTransport = transport;
	gentleAgents(h.pi, {}, runtime.deps);
	let laterFinished = false;
	h.pi.on("session_start", async () => { laterFinished = true; });
	const { ctx } = fakeContext();
	let outcome: Promise<LifecycleOutcome> | undefined;
	let lifecycleState: LifecycleState | undefined;
	let primary: unknown;
	try {
		const started = h.fire("session_start", ctx, { reason: "startup" });
		lifecycleState = { status: "pending" };
		outcome = observeLifecycle(started, lifecycleState);
		await eventually(() => listenerEntered, "listener gate must be entered after registry creation");
		await eventually(() => laterFinished, "a subsequently registered session_start handler must finish while listener publication is gated");
		releaseListener();
		assert.ok(outcome);
		assert.equal((await outcome).status, "fulfilled");
	} catch (error) {
		primary = error;
	} finally {
		releaseListener();
		try {
			if (outcome !== undefined) {
				const shutdownState: LifecycleState = { status: "pending" };
				const shutdownOutcome = observeLifecycle(h.fire("session_shutdown", ctx, { reason: "cleanup" }), shutdownState);
				await eventually(() => lifecycleState?.status !== "pending" && shutdownState.status !== "pending", "listener-gated startup cleanup must settle all launched operations");
				const cleanupOutcomes = await Promise.all([outcome, shutdownOutcome]);
				assert.equal(listenerClosed, 1, "cleanup closes the owned listener");
				assert.equal(clientClosed, 1, "cleanup closes the owned client");
				const cleanupFailure = cleanupOutcomes.find((value) => value.status === "rejected");
				if (cleanupFailure?.status === "rejected") {
					if (primary === undefined) primary = cleanupFailure.error;
					else t.diagnostic(`Listener-gate cleanup secondary failure: ${cleanupFailure.error instanceof Error ? cleanupFailure.error.message : String(cleanupFailure.error)}`);
				}
			}
		} catch (error) {
			if (primary === undefined) primary = error;
			else t.diagnostic(`Listener-gate cleanup secondary failure: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (primary !== undefined) throw primary;
});

test("replacement closes a gated stale listener once and leaves the successor owned until shutdown", async (t: TestContext) => {
	const h = fakePi();
	const runtime = deps();
	let sessionId = "alpha";
	let releaseAlpha!: () => void;
	const alphaGate = new Promise<void>((resolve) => { releaseAlpha = resolve; });
	let alphaEntered = false, betaStarted = false, betaClientCreated = false;
	let alphaCallback: ((notification: { id: string; senderSessionId: string; message: string }) => Promise<void>) | undefined;
	let alphaCloses = 0, betaCloses = 0, alphaClientCloses = 0, betaClientCloses = 0;
	const registryCloseCalls: string[] = [], registryCloseEffects: string[] = [];
	const transport: SessionTransportFactory = {
		createRegistry: async () => {
			const id = sessionId;
			const ownedRegistry = { list: async () => [], listActivations: async () => [], closed: false, close: async () => { registryCloseCalls.push(id); if (!ownedRegistry.closed) { ownedRegistry.closed = true; registryCloseEffects.push(id); } } };
			return ownedRegistry;
		},
		createListener: (ownedRegistry, id, callback) => {
			if (id === "alpha") alphaCallback = callback;
			return { registry: ownedRegistry, closesRegistry: true, start: async () => { if (id === "alpha") { alphaEntered = true; await alphaGate; } else betaStarted = true; }, close: async () => { if (id === "alpha") alphaCloses++; else betaCloses++; await ownedRegistry.close?.(); } };
		},
		createClient: (_registry, id) => { if (id === "beta") betaClientCreated = true; return { close: () => { if (id === "alpha") alphaClientCloses++; else betaClientCloses++; }, sendNotification: async () => ({ id: "unused", accepted: true }) }; },
	};
	runtime.deps.sessionTransport = transport;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	(ctx.sessionManager as { getSessionId(): string }).getSessionId = () => sessionId;
	let primary: unknown;
	let alphaOutcome: Promise<LifecycleOutcome> | undefined;
	let betaOutcome: Promise<LifecycleOutcome> | undefined;
	let shutdownOutcome: Promise<LifecycleOutcome> | undefined;
	let shutdownState: LifecycleState | undefined;
	try {
		alphaOutcome = observeLifecycle(h.fire("session_start", ctx, { reason: "alpha" }), { status: "pending" });
		await eventually(() => alphaEntered, "replacement test must enter the alpha listener gate");
		sessionId = "beta";
		betaOutcome = observeLifecycle(h.fire("session_start", ctx, { reason: "beta" }), { status: "pending" });
		assert.ok(betaOutcome);
		assert.equal((await boundedLifecycle(betaOutcome, "successor startup")).status, "fulfilled");
		await eventually(() => betaClientCreated && betaStarted, "replacement must acquire and publish the successor before ownership assertions");
		assert.equal(betaClientCloses, 0, "replacement must not close the successor client");
		assert.equal(betaCloses, 0, "replacement must not close the successor listener");
		assert.ok(alphaCallback, "the gated listener registered its callback before start");
		await boundedLifecycle(assert.rejects(alphaCallback!({ id: "late", senderSessionId: "peer", message: "late" }), /stale session transport/), "stale callback rejection");
		shutdownState = { status: "pending" };
		shutdownOutcome = observeLifecycle(h.fire("session_shutdown", ctx, { reason: "quit" }), shutdownState);
		await boundedLifecycle(tick(), "replacement shutdown scheduling");
		assert.equal(shutdownState.status, "pending", "shutdown waits while the replaced listener startup remains gated");
		releaseAlpha();
		assert.ok(alphaOutcome);
		assert.equal((await boundedLifecycle(alphaOutcome, "stale alpha startup")).status, "fulfilled");
		assert.equal(alphaClientCloses, 1, "stale alpha client closes once after its gate releases");
		assert.equal(alphaCloses, 1, "stale alpha listener closes once after its gate releases");
		assert.ok(shutdownOutcome);
		assert.equal((await boundedLifecycle(shutdownOutcome, "successor shutdown")).status, "fulfilled");
		assert.equal(betaClientCloses, 1, "shutdown closes the successor client once");
		assert.equal(betaCloses, 1, "shutdown closes the successor listener once");
		assert.deepEqual(registryCloseCalls.sort(), ["alpha", "beta"], "each owned registry close is invoked once");
		assert.deepEqual(registryCloseEffects.sort(), ["alpha", "beta"], "each owned registry closes once");
	} catch (error) {
		primary = error;
	} finally {
		releaseAlpha();
		try {
			if (shutdownOutcome === undefined) shutdownOutcome = observeLifecycle(h.fire("session_shutdown", ctx, { reason: "cleanup" }), { status: "pending" });
			const cleanup = await Promise.all([
				...(alphaOutcome === undefined ? [] : [drainLifecycle("alpha cleanup", alphaOutcome)]),
				...(betaOutcome === undefined ? [] : [drainLifecycle("beta cleanup", betaOutcome)]),
				...(shutdownOutcome === undefined ? [] : [drainLifecycle("shutdown cleanup", shutdownOutcome)]),
			]);
			for (const result of cleanup) {
				if ("error" in result) {
					if (primary === undefined) primary = result.error;
					else t.diagnostic(`${result.label} secondary failure: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
				} else if (result.outcome.status === "rejected") {
					if (primary === undefined) primary = result.outcome.error;
					else t.diagnostic(`${result.label} secondary rejection: ${result.outcome.error instanceof Error ? result.outcome.error.message : String(result.outcome.error)}`);
				}
			}
		} catch (error) {
			if (primary === undefined) primary = error;
			else t.diagnostic(`replacement cleanup secondary failure: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (primary !== undefined) throw primary;
});

test("startup cleanup contains client-close failure and still closes the remaining owned resources", async (t: TestContext) => {
	const h = fakePi();
	const runtime = deps();
	const startupError = new Error("listener unavailable");
	const clientError = new Error("client close failed");
	let listenerCloses = 0, registryCloses = 0, clientCloseAttempts = 0;
	const registry = { list: async () => [], listActivations: async () => [], close: async () => { registryCloses++; } };
	runtime.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: () => ({ registry, start: async () => { throw startupError; }, close: async () => { listenerCloses++; } }),
		createClient: () => ({ close: () => { clientCloseAttempts++; throw clientError; }, sendNotification: async () => ({ id: "unused", accepted: true }) }),
	};
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	const outcome = observeLifecycle(h.fire("session_start", ctx, { reason: "startup" }), { status: "pending" });
	let shutdownOutcome: Promise<LifecycleOutcome> | undefined;
	let primary: unknown;
	try {
		assert.equal((await boundedLifecycle(outcome, "startup failure settlement")).status, "fulfilled", "startup failure remains contained");
		await eventually(() => clientCloseAttempts === 1 && listenerCloses === 1 && registryCloses === 1, "startup cleanup attempts all owned resources before counter assertions");
		assert.equal(clientCloseAttempts, 1, "startup cleanup attempts the owned client once");
		assert.equal(listenerCloses, 1, "startup cleanup attempts the owned listener once");
		assert.equal(registryCloses, 1, "startup cleanup attempts the owned registry once");
		shutdownOutcome = observeLifecycle(h.fire("session_shutdown", ctx, { reason: "verified-cleanup" }), { status: "pending" });
		assert.equal((await boundedLifecycle(shutdownOutcome, "verified startup shutdown")).status, "fulfilled");
	} catch (error) {
		primary = error;
	} finally {
		try {
			if (shutdownOutcome === undefined) shutdownOutcome = observeLifecycle(h.fire("session_shutdown", ctx, { reason: "cleanup" }), { status: "pending" });
			assert.ok(shutdownOutcome);
			const cleanup = await Promise.all([
				drainLifecycle("startup cleanup", outcome),
				drainLifecycle("startup shutdown", shutdownOutcome),
			]);
			for (const result of cleanup) {
				if ("error" in result) {
					if (primary === undefined) primary = result.error;
					else t.diagnostic(`${result.label} secondary failure: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
				} else if (result.outcome.status === "rejected") {
					if (primary === undefined) primary = result.outcome.error;
					else t.diagnostic(`${result.label} secondary rejection: ${result.outcome.error instanceof Error ? result.outcome.error.message : String(result.outcome.error)}`);
				}
			}
		} catch (error) {
			if (primary === undefined) primary = error;
			else t.diagnostic(`startup cleanup secondary failure: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (primary !== undefined) throw primary;
});

test("child parent-message tooling admits notifications and the active parent preserves raw model text", async () => {
	const child = fakePi();
	const listeners = new Map<string, Array<(value: Record<string, unknown>) => void>>();
	const frames: Array<Record<string, unknown>> = [];
	gentleAgents(child.pi, { GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_OWNED_IPC: "fixture" }, {
		childIpc: {
			send: (frame: Record<string, unknown>) => { frames.push(frame); return true; },
			on: (event: string, listener: (value: Record<string, unknown>) => void) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
		},
	});
	assert.deepEqual([...child.tools.keys()], ["subagent_parent_message"]);
	const pending = child.tools.get("subagent_parent_message")!.execute("message", { message: "raw\u001B[2J text" }, undefined, undefined, {} as ExtensionContext);
	assert.deepEqual(frames, [{ id: "n1", kind: "notification", message: "raw\u001B[2J text" }]);
	for (const listener of listeners.get("message") ?? []) listener({ id: "n1", kind: "ack", accepted: true });
	assert.equal((await pending).content[0].text, "Notification accepted by the parent.");

	const parent = fakePi();
	const runtime = deps();
	gentleAgents(parent.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	await parent.fire("session_start", ctx);
	await parent.tools.get("subagent_run")!.execute("run", { agent: "explore", task: "notify", mode: "background" }, undefined, undefined, ctx);
	await tick();
	runtime.children[0].message({ id: "n1", kind: "notification", message: "raw\u001B[2J text" });
	await tick();
	assert.equal(parent.sent[0]?.message.content, "raw\u001B[2J text");
	assert.equal(parent.sent[0]?.message.display, false, "ordinary child notifications remain model-visible but do not render in the transcript");
	assert.deepEqual(parent.sent[0]?.options, { triggerTurn: false });
	assert.deepEqual(parent.delivery, ["custom:gentle-agents.message", "user"], "an idle parent is woken after the stored notification");
	const rendered = parent.renderers.get("gentle-agents.message")!(parent.sent[0]?.message, { expanded: true }, plainTheme).render(80).join("\n");
	assert.match(rendered, /raw\\x1B\[2J text/);
	(ctx.sessionManager as unknown as { getSessionId(): string }).getSessionId = () => "s2";
	await parent.fire("session_start", ctx, { type: "session_start", reason: "new" });
	runtime.children[0].message({ id: "n2", kind: "notification", message: "must not reach a replacement session" });
	await tick();
	assert.equal(parent.sent.length, 1, "a child from the prior session delivers no notification after session replacement");
	assert.deepEqual(runtime.children[0].sent, [{ id: "n1", kind: "ack", accepted: true }, { id: "n2", kind: "ack", accepted: false, error: "task parent is not the active host session" }]);
	await parent.fire("session_shutdown", ctx);
});
for (const boundary of ["allowed", "env", "session", "replacement", "bus-throws", "no-spawn", "long-running"] as const) {
	test(`local child composition through real extensions and RPC runner: ${boundary}`, async (t) => {
		const discarded: number[] = [];
		const discard = AgentRunner.prototype.discardResponseObservations;
		t.mock.method(AgentRunner.prototype, "discardResponseObservations", function (this: AgentRunner, id: string) {
			const live = Reflect.get(this, "live").get(id);
			discarded.push(live?.observations?.responses.length ?? 0);
			discard.call(this, id);
			assert.equal(live?.observations, undefined, "buffer gone synchronously, without another RPC");
		});
		const h = fakePi();
		const runtime = deps();
		const context = fakeContext();
		const spawn = runtime.deps.spawn!;
		runtime.deps.spawn = (...args) => {
			const child = spawn(...args);
			const on = child.on.bind(child);
			child.on = ((event: string, listener: (...args: any[]) => void) => {
				if (event === "spawn" && boundary !== "no-spawn") queueMicrotask(() => listener());
				return on(event as any, listener);
			}) as typeof child.on;
			return child;
		};
		let clock = 1;
		const renewalTimers = new Map<number, () => void>();
		const metricsSchedule = (fn: () => void, ms: number) => {
			const at = clock + ms; renewalTimers.set(at, fn); return () => { renewalTimers.delete(at); };
		};
		let calls = 0;
		const policy = { resolve: () => "fixture", exec: async () => {
			calls++;
			return { stdout: JSON.stringify({ schema: "gentle-ai.telemetry-policy/v1", operation: "policy", enabled: true,
				source: "state", reason: "enabled" }), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		} };
		const env: NodeJS.ProcessEnv = {};
		const profile = join(root, `metrics-${boundary}`);
		mkdirSync(join(profile, "agents"), { recursive: true });
		writeFileSync(join(profile, "agents", "gentle-ai-worker.md"), readFileSync(new URL("../assets/agents/gentle-ai-worker.md", import.meta.url)));
		writeFileSync(join(profile, "subagents.json"), JSON.stringify({ model_profiles: { "gentle-ai-worker": { model: "openai/gpt-4o", effort: "high" } } }));
		gentleAgents(h.pi, env, { ...runtime.deps, env, agentHome: profile, runtimeMetricsPolicy: policy, metricsNow: () => clock, metricsSchedule });
		const listenerCounts = () => [...h.listeners].map(([name, set]) => [name, set.size]);
		await h.fire("session_start", context.ctx);
		const initialListeners = listenerCounts();
		const result = h.tools.get("subagent_run")!.execute("call", { agent: "gentle-ai-worker", task: "private task\n## Allowed edit surfaces\nsrc/app.ts\n## Return\nReport", mode: "task" }, undefined, undefined, context.ctx);
		await tick();
		assert.equal(runtime.children.length, 1);
		const child = runtime.children[0];
		const launchedCalls = calls;
		for (let i = 0; i < 10; i++) child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "private streamed text" } });
		assert.equal(calls, launchedCalls, "no per-chunk policy process");
		if (boundary === "long-running") {
			for (let i = 0; i < 6; i++) {
				clock += 20_000;
				for (const [at, fn] of [...renewalTimers]) if (at <= clock) { renewalTimers.delete(at); fn(); }
				await tick();
				child.emit({ type: "message_end", message: { role: "assistant", model: "gpt-4o", provider: "openai",
					providerThinkingLevel: "low", stopReason: "stop", usage: { input: 7, output: 3 } } });
			}
			assert.equal(calls, launchedCalls, "no telemetry policy renewal during a two-minute child");
			assert.equal(renewalTimers.size, 0, "child telemetry never schedules a lease timer");
		}
		if (boundary === "env") env.DO_NOT_TRACK = "yes";
		if (boundary === "session" || boundary === "replacement") {
			child.emit({ type: "message_end", message: { role: "assistant", model: "gpt-4o", provider: "openai",
				stopReason: "stop", usage: { input: 7, output: 3 } } });
			if (boundary === "replacement") {
				Object.assign(context.ctx.sessionManager, { getSessionId: () => "replacement" });
				await h.fire("session_start", context.ctx);
			} else await h.fire("session_shutdown", context.ctx);
			assert.deepEqual(discarded, [1], "idle buffered response discarded at lifecycle boundary");
			assert.equal(renewalTimers.size, 0);
			if (boundary === "session") {
				assert.ok([...h.listeners.values()].every(set => set.size === 0), "old bus subscriptions removed");
				const fresh = fakePi();
				Object.assign(fresh.pi, { events: h.pi.events });
				gentleAgents(fresh.pi, env, { ...runtime.deps, env, runtimeMetricsPolicy: policy, metricsSchedule });
				await fresh.fire("session_start", context.ctx);
				assert.deepEqual(listenerCounts(), initialListeners, "fresh instance installs one subscription set, including visual preference updates");
				await fresh.fire("session_shutdown", context.ctx);
				assert.ok([...h.listeners.values()].every(set => set.size === 0));
				assert.equal(renewalTimers.size, 0);
			}
		}
		if (boundary === "bus-throws") h.pi.events.on(CHILD_METRICS_EVENT, () => { throw new Error("private bus error"); });
		for (const model of ["gpt-4o", "gpt-4o-mini"]) child.emit({ type: "message_end", message: {
			role: "assistant", model, provider: "openai", providerThinkingLevel: "low", stopReason: "stop", usage: { input: 7, output: 3 } } });
		child.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
		child.emit({ type: "agent_settled" });
		assert.match((await result).content[0].text, boundary === "session" ? /cancelled/ : /done/);
		await tick(); await tick();
		const events = h.events.filter(event => event.name === CHILD_METRICS_EVENT);
		const admitted = boundary === "allowed" || boundary === "bus-throws" || boundary === "long-running";
		assert.equal(events.length, Number(admitted));
		if (admitted) {
			assert.ok(!JSON.stringify(events).includes("private"));
			const event = events[0].data as import("../lib/runtime-metrics-children.ts").ChildMetricsEvent;
			assert.equal(event.launch.agentClass, "worker");
			assert.equal(event.launch.selectedEffort, "high");
			assert.equal(event.responses.length, boundary === "long-running" ? 8 : 2);
			assert.ok(event.responses.every(row => row.agentClass === "worker" && row.effort === "high"
				&& row.selectedProvider === "openai" && row.selectedModelId === "gpt-4o"));
			assert.equal(event.agentSettled, true);
			child.emit({ type: "agent_settled" });
			await tick();
			assert.equal(h.events.filter(event => event.name === CHILD_METRICS_EVENT).length, 1, "completion consumed once, even after bus failure");
		}
		assert.equal(calls, 0, "child telemetry performs no launch, renewal or pending-forward policy query");
		assert.equal(renewalTimers.size, 0, "no renewal timer after the last task finishes");
		assert.ok(!JSON.stringify(h.entries).includes("launch_configuration"));
		await h.fire("session_shutdown", context.ctx);
	});
}

async function eventually(check: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 120; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(message);
}

function liveProfile(name: string): string {
	const profile = join(realpathSync(root), name);
	mkdirSync(join(profile, "agents"), { recursive: true });
	for (const agent of ["local", "peer"]) {
		writeFileSync(join(profile, "agents", `${agent}.md`), `---\ndescription: ${agent}\n---\nFixture agent.`);
	}
	return profile;
}

function liveInstance(t: test.TestContext, profile: string, sessionId: string, metadata = false) {
	const h = fakePi();
	const runtime = deps();
	const context = fakeContext();
	if (metadata) {
		runtime.deps.sessionTransport = {
			...inertSessionTransport,
			createListener: registry => ({ registry, record: { version: 1, sessionId, endpoint: `/fixture/${sessionId}`, createdAt: 1 }, start: async () => {}, close: async () => {} }),
		};
	}
	Object.assign(context.ctx.sessionManager, {
		getSessionId: () => sessionId,
		getSessionName: () => sessionId,
		getCwd: () => join(realpathSync(root), sessionId),
	});
	runtime.deps.schedule = (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref();
		return () => clearTimeout(timer);
	};
	gentleAgents(h.pi, {}, { ...runtime.deps, agentHome: profile });
	t.after(async () => {
		for (const overlay of context.overlays) overlay.handleInput("q");
		await h.fire("session_shutdown", context.ctx, { reason: "quit" });
	});
	return { ...h, ...context, ...runtime };
}

async function liveOverlay(instance: ReturnType<typeof liveInstance>) {
	const opened = instance.commands.get("gentle:agents")!.handler("", instance.ctx);
	await eventually(() => instance.overlays.length > 0, "overlay must mount without waiting for an unbounded directory scan");
	const overlay = instance.overlays.at(-1)!;
	const frame = () => overlay.render(160).map(stripAnsi).join("\n");
	return { overlay, frame, opened };
}

test("live-only extension instances discover same-profile peers across cwd boundaries without importing their tasks", async (t) => {
	const profile = liveProfile("live-peer-profile");
	const local = liveInstance(t, profile, "local-live", true);
	const peer = liveInstance(t, profile, "peer-live", true);
	assert.equal(listPresence(profile).entries.length, 0, "factory construction starts no presence resources");
	await local.fire("session_start", local.ctx, { reason: "startup" });
	await peer.fire("session_start", peer.ctx, { reason: "startup" });
	assert.equal(listPresence(profile).entries.length, 2, "idle open orchestrators publish empty activity");
	for (const header of listPresence(profile).entries) assert.deepEqual(readActivity(profile, header).activity?.tasks, []);
	const panel = await liveOverlay(local);
	panel.overlay.handleInput("a");
	await eventually(() => /peer-live/.test(panel.frame()), "an idle peer with zero children must be discoverable");
	const run = async (instance: typeof local, agent: string) => {
		const result = await instance.tools.get("subagent_run")!.execute(agent, { agent, task: agent, mode: "background" }, undefined, undefined, instance.ctx);
		return (result.details.gentleAgents as { taskId: string }).taskId;
	};
	await run(local, "local");
	const peerId = await run(peer, "peer");
	await eventually(() => listPresence(profile).entries.some(header => readDiscovery(profile, header)?.tasks.some(task => task.id === peerId)), "admitted runtime-owned tasks publish without subsequent child events");
	const scope = listPresence(profile).entries.map(header => readDiscovery(profile, header)?.scope).find(scope => scope?.tasks.some(task => task.id === peerId));
	assert.equal(scope?.tasks.find(task => task.id === peerId)?.repository.root, peer.ctx.sessionManager.getCwd());
	assert.equal(scope?.host.cloneHash, scope?.tasks.find(task => task.id === peerId)?.repository.cloneHash);
	await tick();
	peer.children[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "peer streamed text" } });
	await eventually(() => listPresence(profile).entries.some((header) => readActivity(profile, header).activity?.tasks.some((row) => row.summary.id === peerId && row.thread.items.some((item) => item.text === "peer streamed text"))), "task deltas, not just status changes, must publish peer activity");
	await eventually(() => /Subagent peer/.test(panel.frame()), "open directory refreshes peer children without reopening");
	const peerPanel = await liveOverlay(peer);
	peerPanel.overlay.handleInput("a");
	await eventually(() => /Subagent local/.test(peerPanel.frame()), "discovery is symmetric across extension instances");
	const lines = panel.overlay.render(160).map(stripAnsi);
	const y = lines.findIndex((line) => line.includes("Subagent peer"));
	assert.ok(y > 0);
	panel.overlay.handleMouse?.(mouse("click", "left", 4, y, 160, lines.length));
	assert.match(panel.frame(), /peer streamed text/, "remote inspection reads the peer's pinned activity, not a local thread");
	for (const key of ["s", "c", "o", "\r"]) panel.overlay.handleInput(key);
	assert.deepEqual(local.customCompletions, [], "remote rows never route Open into the local editor");
	assert.deepEqual(local.children[0].killed, [], "remote Stop never cancels the local child");
	assert.deepEqual(peer.children[0].killed, [], "peer rows provide no remote control channel");
	assert.doesNotMatch((await local.tools.get("subagent_list_tasks")!.execute("list", {}, undefined, undefined, local.ctx)).content[0].text, /· peer ·/);
	assert.match((await local.tools.get("subagent_status")!.execute("status", { task_id: peerId }, undefined, undefined, local.ctx)).content[0].text, /no task/, "peer discovery must never restore into local TaskStore");
	panel.overlay.handleInput("a");
	assert.doesNotMatch(panel.frame(), /Subagent peer|peer-live|Current orchestrator/);
	assert.match(panel.frame(), /Subagent local/);
	panel.overlay.handleInput("a");
	await peer.fire("session_shutdown", peer.ctx, { reason: "resume" });
	await eventually(() => !/peer-live|Subagent peer/.test(panel.frame()), "shutdown removes the peer from an already-open directory");
	assert.equal(listPresence(profile).entries.length, 1);
	panel.overlay.handleInput("q");
	peerPanel.overlay.handleInput("q");
	await Promise.all([panel.opened, peerPanel.opened]);
});

test("manual agents command warns once in RPC mode and stays quiet without UI", async (t) => {
	const local = liveInstance(t, liveProfile("live-non-tui"), "non-tui");
	Object.assign(local.ctx, { mode: "rpc" });
	const notify = t.mock.method(local.ctx.ui, "notify");
	await local.commands.get("gentle:agents")!.handler("", local.ctx);
	assert.equal(notify.mock.callCount(), 1);
	assert.equal(notify.mock.calls[0].arguments[1], "warning");
	assert.deepEqual(local.overlays, []);
	Object.assign(local.ctx, { hasUI: false });
	await local.commands.get("gentle:agents")!.handler("", local.ctx);
	assert.equal(notify.mock.callCount(), 1, "headless invocation adds no notification");
	assert.deepEqual(local.overlays, []);
});

for (const scenario of ["recover", "shutdown", "replacement"] as const) {
	test(`live presence after owned-target publication failure: ${scenario}`, async (t) => {
		const profile = liveProfile(`live-io-${scenario}`);
		const local = liveInstance(t, profile, "io-original");
		await local.fire("session_start", local.ctx);
		const original = listPresence(profile).entries[0]!;
		const peer = scenario === "recover" ? liveInstance(t, profile, "io-original") : undefined;
		if (peer) await peer.fire("session_start", peer.ctx);
		const panel = peer ? await liveOverlay(local) : undefined;
		if (panel) {
			panel.overlay.handleInput("a");
			await eventually(() => /io-original/.test(panel.frame()), "same-session peer is visible before publication failure");
		}
		const target = join(profile, "gentle-agents", "presence", `${original.sessionHash}.${original.incarnation}.activity.json`);
		const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
		const rename = fs.renameSync;
		let failures = 0;
		const fault = t.mock.method(fs, "renameSync", (from, to) => {
			if (to === target) {
				failures++;
				throw Object.assign(new Error("fixture publication failure"), { code: "EIO" });
			}
			return rename(from, to);
		});
		syncBuiltinESMExports();
		try {
			await local.tools.get("subagent_run")!.execute("io", { agent: "local", task: "Recover activity", mode: "background" }, undefined, undefined, local.ctx);
			await eventually(() => failures > 0 && !listPresence(profile).entries.some((header) => header.incarnation === original.incarnation), "guarded flush failure must dispose the owned publication");
		} finally {
			fault.mock.restore();
			syncBuiltinESMExports();
		}
		if (scenario === "shutdown") await local.fire("session_shutdown", local.ctx);
		if (scenario === "replacement") {
			const next = fakeContext().ctx;
			next.sessionManager.getSessionId = () => "io-replacement";
			await local.fire("session_start", next);
		}
		const replacement = listPresence(profile).entries[0];
		local.children[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "activity after IO recovery" } });
		await tick();
		if (scenario === "recover") {
			await eventually(() => listPresence(profile).entries.some((header) => readActivity(profile, header).activity?.tasks.some((row) => row.thread.items.some((item) => item.text === "activity after IO recovery"))), "ordinary task delta must recreate presence with current activity");
			const recovered = listPresence(profile).entries;
			assert.equal(recovered.length, 2, "recovery preserves the distinct same-session peer");
			assert.ok(recovered.every((header) => header.sessionHash === original.sessionHash));
			assert.ok(recovered.every((header) => header.incarnation !== original.incarnation));
			const scans = t.mock.method(PresenceCursor.prototype, "next");
			await peer!.tools.get("subagent_run")!.execute("peer", { agent: "peer", task: "Peer after recovery", mode: "background" }, undefined, undefined, peer!.ctx);
			// The second scan starts only after the first post-recovery traversal is displayed.
			await eventually(() => scans.mock.callCount() >= 2 && /Subagent peer/.test(panel!.frame()), "same-session peer remains visible after recovery without reopening");
			assert.equal((panel!.frame().match(/Subagent local/g) ?? []).length, 1, "recovered local activity appears once, never as a read-only peer duplicate");
			assert.equal((panel!.frame().match(/Subagent peer/g) ?? []).length, 1, "the actual same-session peer remains independently visible");
		} else if (scenario === "shutdown") {
			assert.deepEqual(listPresence(profile).entries, [], "shutdown and late child events never recreate presence");
		} else {
			const headers = listPresence(profile).entries;
			assert.equal(headers.length, 1, "late old-session activity cannot resurrect its publisher");
			assert.notEqual(headers[0].sessionHash, original.sessionHash);
			assert.equal(headers[0].incarnation, replacement!.incarnation);
			assert.deepEqual(readActivity(profile, headers[0]).activity?.tasks, [], "replacement must not publish old-session tasks");
		}
	});
}

test("live-only instances sharing a session ID remain distinct and withdraw only their own incarnation", async (t) => {
	const profile = liveProfile("live-incarnation-profile");
	const local = liveInstance(t, profile, "same-live");
	const peer = liveInstance(t, profile, "same-live");
	peer.ctx.sessionManager.getCwd = () => join(realpathSync(root), "peer-cwd");
	for (const [instance, agent] of [[local, "local"], [peer, "peer"]] as const) {
		await instance.fire("session_start", instance.ctx, { reason: "startup" });
		await instance.tools.get("subagent_run")!.execute(agent, { agent, task: agent, mode: "background" }, undefined, undefined, instance.ctx);
	}
	const headers = listPresence(profile).entries;
	assert.equal(headers.length, 2);
	assert.equal(headers[0].sessionHash, headers[1].sessionHash);
	assert.notEqual(headers[0].incarnation, headers[1].incarnation);
	const panel = await liveOverlay(local);
	panel.overlay.handleInput("a");
	await eventually(() => /Subagent peer/.test(panel.frame()), "same-session peers remain independently visible");
	assert.equal((panel.frame().match(/Subagent local/g) ?? []).length, 1, "own publication is not duplicated as a peer");
	await local.fire("session_shutdown", local.ctx, { reason: "quit" });
	await panel.opened;
	assert.equal(listPresence(profile).entries.length, 1, "shutdown removes only this activation");
	assert.deepEqual(peer.children[0].killed, []);
});

test("live-only directory traverses presence overflow, excludes expired and other-profile peers, and replaces sessions", async (t) => {
	const profile = liveProfile("live-paged-profile");
	const now = Date.now();
	const oldClock = mock.method(Date, "now", () => now - 16_000);
	let expired: PresencePublisher;
	try {
		expired = PresencePublisher.start({ profile, sessionId: "expired", label: "Expired peer", activity: [] });
	} finally {
		oldClock.mock.restore();
	}
	// Simulate an abruptly closed publisher: retained files, but no renewing heartbeat.
	const stem = join(profile, "gentle-agents", "presence", `${expired.target.sessionHash}.${expired.target.incarnation}`);
	const staleFiles = ["header", "activity"].map((kind) => ({ path: `${stem}.${kind}.json`, bytes: readFileSync(`${stem}.${kind}.json`) }));
	expired.dispose();
	for (const { path, bytes } of staleFiles) writeFileSync(path, bytes, { mode: 0o600 });
	const isolated = PresencePublisher.start({ profile: liveProfile("live-isolated-profile"), sessionId: "isolated", label: "Isolated peer", activity: [] });
	t.after(() => isolated.dispose());
	for (let index = 0; index < 130; index++) {
		const publisher = PresencePublisher.start({ profile, sessionId: `idle-${index}`, label: `Idle peer ${index}`, activity: [] });
		t.after(() => publisher.dispose());
	}
	assert.equal(listPresence(profile).overflow, true, "fixture exceeds the foundation's first-page budget");
	let pageReadThisTurn = false;
	const next = PresenceCursor.prototype.next;
	const pages = t.mock.method(PresenceCursor.prototype, "next", function (this: PresenceCursor, ...args: Parameters<PresenceCursor["next"]>) {
		assert.equal(pageReadThisTurn, false, "directory pages must yield instead of blocking the UI with an unbounded loop");
		pageReadThisTurn = true;
		setImmediate(() => { pageReadThisTurn = false; });
		return next.apply(this, args);
	});
	const local = liveInstance(t, profile, "directory-local");
	await local.fire("session_start", local.ctx, { reason: "startup" });
	const panel = await liveOverlay(local);
	panel.overlay.handleInput("a");
	const seen = new Set<string>();
	await eventually(() => {
		for (let step = 0; step < 140; step++) {
			const frame = panel.frame();
			assert.doesNotMatch(frame, /Expired peer|Isolated peer/);
			for (const match of frame.matchAll(/Idle peer (\d+)/g)) seen.add(match[1]);
			panel.overlay.handleInput("j");
		}
		for (let step = 0; step < 140; step++) panel.overlay.handleInput("k");
		return seen.size === 130;
	}, "every idle orchestrator beyond the 128-entry page must eventually be reachable");
	assert.ok(pages.mock.callCount() >= 3, "the directory traversed all three fixture pages");
	panel.overlay.handleInput("q");
	await panel.opened;
	const readsAtClose = pages.mock.callCount();
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.equal(pages.mock.callCount(), readsAtClose, "closing the overlay cancels future directory scans");
	pages.mock.restore();
	await local.fire("session_shutdown", local.ctx, { reason: "new" });
	const replacement = liveInstance(t, profile, "replacement-live");
	await replacement.fire("session_start", replacement.ctx, { reason: "new" });
	const cursor = new PresenceCursor(profile);
	const labels: string[] = [];
	try {
		let page;
		do {
			page = cursor.next();
			labels.push(...page.entries.map((entry) => entry.label));
		} while (page.overflow);
	} finally {
		cursor.close();
	}
	assert.ok(labels.some((label) => label.includes("replacement-live")));
	assert.ok(labels.every((label) => !label.includes("directory-local")), "session replacement withdraws the old activation");
	panel.overlay.handleInput("q");
	await panel.opened;
});

// #1690: Pi drops unknown --tools names without a diagnostic, so the child
// compares the runner's requested list with its own tools at the first
// before_agent_start, after every extension's session_start has registered.
function missingToolsChild(env: NodeJS.ProcessEnv, toolNames: string[] | (() => string[])) {
	const child = fakePi();
	Object.assign(child.pi, { getAllTools: () => (typeof toolNames === "function" ? toolNames() : toolNames).map((name) => ({ name })) });
	gentleAgents(child.pi, { GENTLE_PI_AGENTS_CHILD: "1", ...env });
	const notes: Array<{ message: string; type: unknown }> = [];
	const ctx = { hasUI: true, ui: { notify: (message: string, type?: unknown) => notes.push({ message, type }) } } as unknown as ExtensionContext;
	return {
		start: () => child.fire("session_start", ctx, { type: "session_start", reason: "startup" }),
		prompt: () => child.fire("before_agent_start", ctx, { type: "before_agent_start", prompt: "go", systemPrompt: "base", systemPromptOptions: {} }),
		notes,
	};
}

test("a child warns once about requested tools it does not have", async () => {
	const child = missingToolsChild({ [REQUESTED_TOOLS_ENV]: "read,gentle_review_scope,grep,codegraph,subagent_parent_message" }, ["read", "grep", "subagent_parent_message"]);
	await child.start();
	assert.deepEqual(child.notes, [], "session_start runs before later extensions register their tools");
	assert.deepEqual(await child.prompt(), [undefined], "the check never alters the prompt");
	assert.deepEqual(child.notes, [{ message: `${MISSING_TOOLS_NOTE_PREFIX} gentle_review_scope, codegraph`, type: "warning" }]);
	await child.start();
	assert.deepEqual(await child.prompt(), [undefined]);
	assert.equal(child.notes.length, 1, "later prompts and session replacements do not repeat the warning");
});

test("a child does not report a tool that a later extension registers in its own session_start", async () => {
	const tools = ["read", "grep"];
	const child = missingToolsChild({ [REQUESTED_TOOLS_ENV]: "read,late_tool" }, () => tools);
	await child.start();
	// Pi runs session_start handlers in load order; an extension loaded after
	// gentle-agents registers late_tool only now.
	tools.push("late_tool");
	const results = await child.prompt();
	assert.deepEqual(child.notes, []);
	assert.deepEqual(results, [undefined]);
});

test("a child stays quiet when every checkable requested tool exists or nothing was requested", async () => {
	for (const [label, env] of [
		["all present", { [REQUESTED_TOOLS_ENV]: "read,grep,subagent_parent_message" }],
		["MCP names register late", { [REQUESTED_TOOLS_ENV]: "read,mcp__github__search,mcp__x" }],
		["frontmatter wildcard entries are not tool names", { [REQUESTED_TOOLS_ENV]: "read,\"*\": false,*, ," }],
		["no requested list", {}],
		["empty requested list", { [REQUESTED_TOOLS_ENV]: "" }],
	] as const) {
		const child = missingToolsChild(env, ["read", "grep", "subagent_parent_message"]);
		await child.start();
		const results = await child.prompt();
		assert.ok(results.every((result) => result === undefined), label);
		assert.deepEqual(child.notes, [], label);
	}
});

test("the missing-tools check never throws into before_agent_start", async () => {
	const child = missingToolsChild({ [REQUESTED_TOOLS_ENV]: "read,codegraph" }, () => { throw new Error("tool registry unavailable"); });
	await child.start();
	assert.deepEqual(await child.prompt(), [undefined]);
	assert.deepEqual(child.notes, []);
});

test("retired managed SDD child envelopes deny all tools without registering a delegation host", () => {
	for (const env of [{ GENTLE_PI_RESEARCH_TOOLS: '["read"]' }, { GENTLE_PI_RESEARCH_SELECTION: '{}' }, { GENTLE_PI_RESEARCH_ARTIFACT: '{}' }, { GENTLE_PI_SDD_REMEDIATION_PLAN: '{}' }]) {
		const hooks = new Map<string, (event: { toolName: string }) => { block: boolean }>();
		const pi = { on: (name: string, handler: (event: { toolName: string }) => { block: boolean }) => hooks.set(name, handler) } as never;
		gentleAgents(pi, { GENTLE_PI_AGENTS_CHILD: "1", ...env });
		assert.equal(hooks.get("tool_call")!({ toolName: "read" }).block, true);
		assert.equal(hooks.get("tool_call")!({ toolName: "bash" }).block, true);
	}
});

async function shutdownAndRestoreNativeSpawn(
	childProcess: typeof import("node:child_process"),
	originalSpawn: typeof import("node:child_process").spawn,
	shutdown: () => Promise<unknown>,
): Promise<void> {
	try {
		await shutdown();
	} finally {
		childProcess.spawn = originalSpawn;
		syncBuiltinESMExports();
	}
}

for (const matching of [true, false]) {
 test("owned child diff relay validates the exact file independently of review bookkeeping: "+matching, async () => {
  const h=fakePi(), d=deps(), {ctx}=fakeContext();
  const target=realpathSync(cwd);
  (ctx as any).cwd=target;
  ctx.sessionManager.getCwd=()=>target;
  ctx.sessionManager.getEntries=(()=>h.entries) as any;
  ctx.sessionManager.getBranch=(()=>h.entries) as any;
  d.deps.resolveWorktree=(path,base)=>{
   const full=resolve(base,path);
   return full===target||full.startsWith(target+"/")?{root:target,commonDir:"/fixture/common"}:undefined;
  };
  const spawn=d.deps.spawn!;
  d.deps.spawn=(...args)=>{
   const child=spawn(...args),on=child.on.bind(child);
   child.on=((event,listener)=>{if(event==="spawn")queueMicrotask(listener);return on(event,listener);}) as any;
   return child;
  };
  gentleAgents(h.pi,{},d.deps);
  await h.fire("session_start",ctx);
  await h.tools.get("subagent_run")!.execute("diff",{agent:"explore",task:"Write",mode:"background",workspace_root:target},undefined,undefined,ctx);
  await tick();
  writeFileSync(join(target,"session-diff-test.ts"),"agent\n");
  const evidence={id:"write",root:target,path:matching?"session-diff-test.ts":"different.ts",before:{kind:"text",text:"original\n"},after:{kind:"text",text:"agent\n"}};
  d.children[0].emit({type:"tool_execution_start",toolCallId:"write",toolName:"write",args:{path:"session-diff-test.ts"}});
  d.children[0].emit({type:"tool_execution_end",toolCallId:"write",isError:false,result:{content:[],details:{gentleSessionChange:evidence}}});
  const relays=h.events.filter(event=>event.name==="gentle-pi:child-session-change");
  assert.equal(relays.length,matching?1:0);
  if(matching) assert.match((relays[0].data as any).evidence.id,/:write$/);
  assert.equal(h.entries.filter(entry=>entry.customType===REVIEW_REMINDER_RECEIPT).length,1);
  await h.fire("session_shutdown",ctx); await tick();
 });
}

// Runs the CHILD half of installSessionChangeCapture against a real repo, the
// same way an actual subagent process would: a tool_call/tool_result pair
// with GENTLE_PI_AGENTS_CHILD set, using the real git-backed resolver rather
// than a stub. Returns exactly the evidence object the child would put in
// its tool result's details.gentleSessionChange.
async function childSessionChangeEvidence(root: string, relPath: string, toolCallId: string, content: string): Promise<SessionChangeEvidence> {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const childPi = {
		on: (key: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(key, fn),
		appendEntry: () => {},
		events: { on: () => () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	const childCtx = { cwd: root, sessionManager: { getSessionId: () => "child-session", getEntries: () => [] } } as unknown as ExtensionContext;
	installSessionChangeCapture(childPi, { GENTLE_PI_AGENTS_CHILD: "1" }, resolveSessionWorktree);
	await handlers.get("session_start")?.({}, childCtx);
	const event = { toolCallId, toolName: "write", input: { path: relPath, content } };
	await handlers.get("tool_call")?.(event, childCtx);
	writeFileSync(join(root, relPath), content);
	const result = (await handlers.get("tool_result")?.({ ...event, isError: false }, childCtx)) as { details: { gentleSessionChange: SessionChangeEvidence } } | undefined;
	assert.ok(result?.details.gentleSessionChange, "the child must attach session-change evidence to its tool result");
	return result.details.gentleSessionChange;
}

async function childSessionEditEvidence(root: string, relPath: string, toolCallId: string, before: string, after: string): Promise<SessionChangeEvidence> {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const childPi = {
		on: (key: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(key, fn),
		appendEntry: () => {},
		events: { on: () => () => {}, emit: () => {} },
	} as unknown as ExtensionAPI;
	const childCtx = { cwd: root, sessionManager: { getSessionId: () => "child-session", getEntries: () => [] } } as unknown as ExtensionContext;
	installSessionChangeCapture(childPi, { GENTLE_PI_AGENTS_CHILD: "1" }, resolveSessionWorktree);
	await handlers.get("session_start")?.({}, childCtx);
	writeFileSync(join(root, relPath), before);
	const event = { toolCallId, toolName: "edit", input: { path: relPath, oldText: before, newText: after } };
	await handlers.get("tool_call")?.(event, childCtx);
	writeFileSync(join(root, relPath), after);
	const details = { patch: generateUnifiedPatch(relPath, before, after) };
	const result = (await handlers.get("tool_result")?.({ ...event, isError: false, details }, childCtx)) as { details: { gentleSessionChange: SessionChangeEvidence } } | undefined;
	assert.ok(result?.details.gentleSessionChange, "successful child edit must carry captured evidence");
	return result.details.gentleSessionChange;
}

// C1 investigation (odd/tasks/usage-click-and-changes-attribution.md): tried
// to reproduce the live session's "16 subagent_run calls, zero relayed"
// evidence end to end — real repo, real git-backed resolver on both the
// child and parent sides (not the trivial path-echoing stub the other
// fixtures in this file use), a real child tool_call/tool_result pair
// producing the session-change evidence, and the real onSuccessfulMutation
// guard chain in extensions/gentle-agents.ts, round-tripped through actual
// JSON serialization the same way agents-fake-child.ts's emit() does for
// every other test here. With every guard input constructed faithfully, the
// relay fires correctly: parentSessionId/ownedTaskIds, root === childRoot,
// worktrees.roots().includes(root), tool.evidence.root === root, and the
// realpath comparison all pass.
//
// The one drop this file could reproduce was a test-harness gap, not a
// product bug: SessionWorktreeRegistry.start() is never called for this
// extension's own registry (registryFor() in extensions/gentle-agents.ts),
// so worktrees.roots() is empty until some subagent's onLaunch callback
// registers a root on the real child process's "spawn" event. In production
// that event always fires before any tool call can complete, so the root is
// registered well before any mutation; the fake child here only reproduces
// that if the test explicitly wires "spawn" (as this test does). Making
// registryFor() call start() eagerly was tried and reverted: it makes the
// parent's own cwd a registered root at session start regardless of whether
// any subagent ever actually launches into it, which breaks two existing,
// deliberate invariants — "child mutation attribution through registered
// subagent_run: unregistered" (a queued-but-never-spawned task must not be
// attributed) and "queueing and returning a child handle do not register
// roots" / "delayed child spawn retains the originating session..." (merely
// constructing the registry must not append an entry). Deciding whether the
// session's own root should be trusted before any subagent proves it by
// actually spawning is a product/security question, not a guard bug fix, so
// it was left to the parent instead of guessed at here.
test("C1 investigation: the relay mechanism is correct when every guard input is real", async () => {
	// A real repository, spawned through the real (unstubbed) git-backed
	// resolver on both the child and parent sides — the same resolver the
	// live session used — rather than the trivial path-echoing stub the other
	// fixtures in this file use.
	const repoRoot = mkdtempSync(join(tmpdir(), "gentle-agents-c1-"));
	// Isolate every git spawn below from the developer's own environment: no
	// global/system config, no ambient $HOME gitconfig, no signing prompt, and
	// no hooks -- only the identity this fixture supplies explicitly.
	const gitHome = mkdtempSync(join(tmpdir(), "gentle-agents-c1-git-home-"));
	const gitHooksDir = mkdtempSync(join(tmpdir(), "gentle-agents-c1-git-hooks-"));
	const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: gitHome };
	const gitIdentity = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${gitHooksDir}`];
	const runGit = (args: string[]) => execFileSync("git", [...gitIdentity, ...args], { env: gitEnv });
	try {
		runGit(["init", "--quiet", "-b", "main", repoRoot]);
		writeFileSync(join(repoRoot, "README.md"), "seed\n");
		runGit(["-C", repoRoot, "add", "README.md"]);
		runGit(["-C", repoRoot, "commit", "--quiet", "-m", "seed"]);

		const h = fakePi();
		const d = deps();
		const { ctx } = fakeContext();
		ctx.sessionManager.getCwd = () => repoRoot;
		ctx.sessionManager.getEntries = (() => h.entries) as typeof ctx.sessionManager.getEntries;
		ctx.sessionManager.getBranch = (() => h.entries) as typeof ctx.sessionManager.getBranch;
		d.deps.resolveWorktree = resolveSessionWorktree;
		// Mirror a real child process: the OS "spawn" event fires as soon as the
		// process starts, which is what triggers onLaunch -> registry.register.
		const spawn = d.deps.spawn!;
		d.deps.spawn = (...args) => {
			const child = spawn(...args);
			const on = child.on.bind(child);
			child.on = ((event: string, listener: () => void) => {
				if (event === "spawn") queueMicrotask(listener);
				return on(event as "spawn", listener);
			}) as typeof child.on;
			return child;
		};
		gentleAgents(h.pi, {}, d.deps);
		await h.fire("session_start", ctx);

		const launched = await h.tools.get("subagent_run")!.execute("mutation", { agent: "explore", task: "Write a file", mode: "background" }, undefined, undefined, ctx);
		await tick();
		const gentleAgentsDetails = launched.details.gentleAgents as { taskId: string; cwd: string };
		const taskId = gentleAgentsDetails.taskId;
		// The task's cwd is whatever buildRequest resolved from the real
		// resolver: confirming this here pins down which value onSuccessfulMutation
		// will later compare against the freshly-resolved root.
		const childCwd = gentleAgentsDetails.cwd;

		const evidence = await childSessionChangeEvidence(childCwd, "notes.md", "write", "agent output\n");

		d.children[0].emit({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "notes.md" } });
		d.children[0].emit({ type: "tool_execution_end", toolCallId: "write", isError: false, result: { content: [], details: { gentleSessionChange: evidence } } });
		await tick();

		const relays = h.events.filter((event) => event.name === "gentle-pi:child-session-change");
		assert.equal(relays.length, 1, `expected the child mutation to relay; evidence=${JSON.stringify(evidence)} childCwd=${childCwd}`);
		assert.equal((relays[0].data as { evidence: { id: string } }).evidence.id, `${taskId}:write`);

		await h.fire("session_shutdown", ctx);
		await tick();
	} finally {
		rmSync(repoRoot, TEST_DIR_REMOVAL);
		rmSync(gitHome, TEST_DIR_REMOVAL);
		rmSync(gitHooksDir, TEST_DIR_REMOVAL);
	}
});

for (const scenario of ["own", "other-root", "escaped", "sibling", "session-switch", "shutdown", "unregistered"] as const) {
	test(`child mutation attribution through registered subagent_run: ${scenario}`, async () => {
		const h = fakePi();
		const d = deps();
		const { ctx } = fakeContext();
		let sessionId = "s1";
		const sibling = join(root, "sibling");
		const childRoot = scenario === "other-root" ? sibling : cwd;
		ctx.sessionManager.getSessionId = () => sessionId;
		ctx.sessionManager.getEntries = (() => h.entries) as typeof ctx.sessionManager.getEntries;
		ctx.sessionManager.getBranch = (() => h.entries) as typeof ctx.sessionManager.getBranch;
		// The cheap session/ownership guards run before any worktree resolution:
		// a mutation from a switched-away session must never reach git.
		let resolutions = 0;
		d.deps.resolveWorktree = (path, base) => {
			resolutions++;
			const absolute = resolve(base, path);
			const worktree = [cwd, sibling].find((candidate) => containsResolvedPath(candidate, absolute));
			return worktree ? { root: worktree, commonDir: "/fixture/common" } : undefined;
		};
		const spawn = d.deps.spawn!;
		d.deps.spawn = (...args) => {
			const child = spawn(...args);
			const on = child.on.bind(child);
			child.on = ((event: string, listener: () => void) => {
				if (event === "spawn" && scenario !== "unregistered") queueMicrotask(listener);
				return on(event as "spawn", listener);
			}) as typeof child.on;
			return child;
		};
		gentleAgents(h.pi, {}, d.deps);
		await h.fire("session_start", ctx);
		await h.tools.get("subagent_run")!.execute("mutation", { agent: "explore", task: "Write", mode: "background", workspace_root: childRoot }, undefined, undefined, ctx);
		await tick();
		assert.equal(h.entries.filter((entry) => entry.customType === REVIEW_REMINDER_RECEIPT).length, 0, "spawn alone is not ownership");
		if (scenario === "session-switch") sessionId = "s2";
		if (scenario === "shutdown") await h.fire("session_shutdown", ctx);
		const path = scenario === "escaped" ? "../../outside.ts" : scenario === "sibling" ? join(sibling, "file.ts") : "file.ts";
		d.children[0].emit({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path } });
		d.children[0].emit({ type: "tool_execution_end", toolCallId: "write", isError: false, result: { content: [] } });
		const accepted = scenario === "own" || scenario === "other-root";
		assert.equal(h.entries.filter((entry) => entry.customType === REVIEW_REMINDER_RECEIPT).length, accepted ? 1 : 0);
		assert.equal(Boolean(pendingReviewMutation(ctx.sessionManager, cwd)), scenario === "own", "another registered root never authorizes current-root STATUS");
		if (scenario === "other-root") assert.ok(pendingReviewMutation(ctx.sessionManager, sibling));
		await h.fire("session_shutdown", ctx);
		await tick();
	});
}

// gentle-pi#1175 (T2): the subagent mutation receipt carries the model and
// effort the runtime resolved for the task, so ASSESS never re-trusts a model
// declaration. An inherited (unresolved) model is omitted, never "default".
for (const scenario of ["resolved", "inherited"] as const) {
	test(`subagent mutation receipt records the runtime-resolved writer profile: ${scenario}`, async () => {
		const h = fakePi();
		const d = deps();
		const { ctx } = fakeContext();
		if (scenario === "inherited") {
			const fixtureHome = realpathSync(mkdtempSync(join(root, "inherited-writer-")));
			mkdirSync(join(fixtureHome, ".pi", "agent", "agents"), { recursive: true });
			writeFileSync(join(fixtureHome, ".pi", "agent", "agents", "explore.md"), "---\ndescription: inherits the parent model\ntools: [read]\n---\nYou map things.");
			d.deps.home = fixtureHome;
		}
		ctx.sessionManager.getEntries = (() => h.entries) as typeof ctx.sessionManager.getEntries;
		ctx.sessionManager.getBranch = (() => h.entries) as typeof ctx.sessionManager.getBranch;
		d.deps.resolveWorktree = (path, base) => containsResolvedPath(cwd, resolve(base, path)) ? { root: cwd, commonDir: "/fixture/common" } : undefined;
		const spawn = d.deps.spawn!;
		d.deps.spawn = (...args) => {
			const child = spawn(...args);
			const on = child.on.bind(child);
			child.on = ((event: string, listener: () => void) => {
				if (event === "spawn") queueMicrotask(listener);
				return on(event as "spawn", listener);
			}) as typeof child.on;
			return child;
		};
		gentleAgents(h.pi, {}, d.deps);
		await h.fire("session_start", ctx);
		await h.tools.get("subagent_run")!.execute("mutation", { agent: "explore", task: "Write", mode: "background", workspace_root: cwd }, undefined, undefined, ctx);
		await tick();
		d.children[0].emit({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "file.ts" } });
		d.children[0].emit({ type: "tool_execution_end", toolCallId: "write", isError: false, result: { content: [] } });
		await tick();
		const receipts = h.entries.filter((entry) => entry.customType === REVIEW_REMINDER_RECEIPT);
		assert.equal(receipts.length, 1);
		const data = receipts[0].data as Record<string, unknown>;
		if (scenario === "resolved") {
			assert.equal(data.writerModelId, "openai-codex/gpt-5.6-terra");
			assert.equal(data.writerEffort, "low", "the profile effort override is the runtime-resolved effort");
		} else {
			assert.equal(Object.hasOwn(data, "writerModelId"), false, "an inherited model is unknown here and must never be recorded as \"default\"");
			assert.equal(Object.hasOwn(data, "writerEffort"), false);
		}
		assert.deepEqual(pendingReviewMutationProfiles(ctx.sessionManager, cwd), [scenario === "resolved" ? { writerModelId: "openai-codex/gpt-5.6-terra", writerEffort: "low" } : {}]);
		await h.fire("session_shutdown", ctx);
		await tick();
	});
}

// C1 diagnostics (odd/tasks/usage-click-and-changes-attribution.md): the
// guard chain's posture is unchanged (spawn-gated registration stays, a
// parent decision) -- these only verify each drop explains itself once, in
// the task's own thread, naming the exact guard that fired.
async function openTaskThread(commands: ReturnType<typeof fakePi>["commands"], ctx: ExtensionContext, overlays: Overlay[]): Promise<string> {
	const opened = commands.get("gentle:agents")!.handler("", ctx);
	for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	const overlay = overlays[0];
	const text = overlay ? stripAnsi(overlay.render(100).join("\n")) : "";
	overlay?.handleInput("\x1b");
	await opened;
	overlays.length = 0;
	return text;
}

for (const [scenario, guard] of [
	["escaped", "root-unresolved"],
	["sibling", "root-mismatch"],
	["session-switch", "parent-session-mismatch"],
	["unregistered", "root-not-registered"],
] as const) {
	test(`a dropped mutation explains itself in the task thread: ${scenario} -> ${guard}`, async () => {
		const h = fakePi();
		const d = deps();
		const { ctx, overlays } = fakeContext();
		let sessionId = "s1";
		const sibling = join(root, `sibling-${scenario}`);
		ctx.sessionManager.getSessionId = () => sessionId;
		ctx.sessionManager.getEntries = (() => h.entries) as typeof ctx.sessionManager.getEntries;
		ctx.sessionManager.getBranch = (() => h.entries) as typeof ctx.sessionManager.getBranch;
		// The cheap session/ownership guards run before any worktree resolution:
		// a mutation from a switched-away session must never reach git.
		let resolutions = 0;
		d.deps.resolveWorktree = (path, base) => {
			resolutions++;
			const absolute = resolve(base, path);
			const worktree = [cwd, sibling].find((candidate) => containsResolvedPath(candidate, absolute));
			return worktree ? { root: worktree, commonDir: "/fixture/common" } : undefined;
		};
		const spawn = d.deps.spawn!;
		d.deps.spawn = (...args) => {
			const child = spawn(...args);
			const on = child.on.bind(child);
			child.on = ((event: string, listener: () => void) => {
				if (event === "spawn" && scenario !== "unregistered") queueMicrotask(listener);
				return on(event as "spawn", listener);
			}) as typeof child.on;
			return child;
		};
		gentleAgents(h.pi, {}, d.deps);
		await h.fire("session_start", ctx);
		await h.tools.get("subagent_run")!.execute("mutation", { agent: "explore", task: "Write", mode: "background", workspace_root: cwd }, undefined, undefined, ctx);
		await tick();
		if (scenario === "session-switch") sessionId = "s2";
		const path = scenario === "escaped" ? "../../outside.ts" : scenario === "sibling" ? join(sibling, "file.ts") : "file.ts";
		resolutions = 0; // spawn-time registration may resolve; only the mutation matters here
		d.children[0].emit({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path } });
		d.children[0].emit({ type: "tool_execution_end", toolCallId: "write", isError: false, result: { content: [] } });
		await tick();
		if (scenario === "session-switch") assert.equal(resolutions, 0, "session mismatch is decided before resolving any worktree");
		if (scenario === "session-switch") sessionId = "s1"; // back to the task's own session to inspect its thread
		const rendered = await openTaskThread(h.commands, ctx, overlays);
		assert.match(rendered, new RegExp(`changes not attributed: ${guard}\\b`), `expected the ${guard} guard to explain itself`);
		// The same drop repeated for the same task must not add a second note.
		d.children[0].emit({ type: "tool_execution_start", toolCallId: "write2", toolName: "write", args: { path } });
		d.children[0].emit({ type: "tool_execution_end", toolCallId: "write2", isError: false, result: { content: [] } });
		await tick();
		const renderedAgain = await openTaskThread(h.commands, ctx, overlays);
		assert.equal((renderedAgain.match(new RegExp(`changes not attributed: ${guard}`, "g")) ?? []).length, 1, "one note per (task, guard), not one per file");
		await h.fire("session_shutdown", ctx);
		await tick();
	});
}

test("a mutation dropped for lacking any session-change evidence explains itself once", async () => {
	const h = fakePi();
	const d = deps();
	const { ctx, overlays } = fakeContext();
	ctx.sessionManager.getEntries = (() => h.entries) as typeof ctx.sessionManager.getEntries;
	ctx.sessionManager.getBranch = (() => h.entries) as typeof ctx.sessionManager.getBranch;
	d.deps.resolveWorktree = (path, base) => {
		const full = resolve(base, path);
		return full === cwd || full.startsWith(cwd + "/") ? { root: cwd, commonDir: "/fixture/common" } : undefined;
	};
	const spawn = d.deps.spawn!;
	d.deps.spawn = (...args) => {
		const child = spawn(...args);
		const on = child.on.bind(child);
		child.on = ((event: string, listener: () => void) => { if (event === "spawn") queueMicrotask(listener); return on(event as "spawn", listener); }) as typeof child.on;
		return child;
	};
	gentleAgents(h.pi, {}, d.deps);
	await h.fire("session_start", ctx);
	await h.tools.get("subagent_run")!.execute("mutation", { agent: "explore", task: "Write", mode: "background", workspace_root: cwd }, undefined, undefined, ctx);
	await tick();
	// No details.gentleSessionChange at all -- the evidence never surfaced.
	d.children[0].emit({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "file.ts" } });
	d.children[0].emit({ type: "tool_execution_end", toolCallId: "write", isError: false, result: { content: [] } });
	await tick();
	const rendered = await openTaskThread(h.commands, ctx, overlays);
	assert.match(rendered, /changes not attributed: evidence-missing\b/);
	await h.fire("session_shutdown", ctx);
	await tick();
});

test("a mutation dropped for evidence pointing at a different worktree root explains itself once", async () => {
	const h = fakePi();
	const d = deps();
	const { ctx, overlays } = fakeContext();
	const target = realpathSync(cwd);
	(ctx as unknown as { cwd: string }).cwd = target;
	ctx.sessionManager.getCwd = () => target;
	ctx.sessionManager.getEntries = (() => h.entries) as typeof ctx.sessionManager.getEntries;
	ctx.sessionManager.getBranch = (() => h.entries) as typeof ctx.sessionManager.getBranch;
	d.deps.resolveWorktree = (path, base) => {
		const full = resolve(base, path);
		return full === target || full.startsWith(target + "/") ? { root: target, commonDir: "/fixture/common" } : undefined;
	};
	const spawn = d.deps.spawn!;
	d.deps.spawn = (...args) => {
		const child = spawn(...args);
		const on = child.on.bind(child);
		child.on = ((event: string, listener: () => void) => { if (event === "spawn") queueMicrotask(listener); return on(event as "spawn", listener); }) as typeof child.on;
		return child;
	};
	gentleAgents(h.pi, {}, d.deps);
	await h.fire("session_start", ctx);
	await h.tools.get("subagent_run")!.execute("mutation", { agent: "explore", task: "Write", mode: "background", workspace_root: target }, undefined, undefined, ctx);
	await tick();
	writeFileSync(join(target, "evidence-root-mismatch-test.ts"), "agent\n");
	// The evidence names a different root than the one the mutation actually
	// resolved into -- distinct from having no evidence at all.
	const evidence = { id: "write", root: join(target, "elsewhere"), path: "evidence-root-mismatch-test.ts", before: { kind: "text", text: "original\n" }, after: { kind: "text", text: "agent\n" } };
	d.children[0].emit({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "evidence-root-mismatch-test.ts" } });
	d.children[0].emit({ type: "tool_execution_end", toolCallId: "write", isError: false, result: { content: [], details: { gentleSessionChange: evidence } } });
	await tick();
	const rendered = await openTaskThread(h.commands, ctx, overlays);
	assert.match(rendered, /changes not attributed: evidence-root-mismatch\b/);
	await h.fire("session_shutdown", ctx);
	await tick();
});

test("a mutation dropped for an unreadable evidence target explains itself once", async () => {
	const h = fakePi();
	const d = deps();
	const { ctx, overlays } = fakeContext();
	const target = realpathSync(cwd);
	(ctx as unknown as { cwd: string }).cwd = target;
	ctx.sessionManager.getCwd = () => target;
	ctx.sessionManager.getEntries = (() => h.entries) as typeof ctx.sessionManager.getEntries;
	ctx.sessionManager.getBranch = (() => h.entries) as typeof ctx.sessionManager.getBranch;
	d.deps.resolveWorktree = (path, base) => {
		const full = resolve(base, path);
		return full === target || full.startsWith(target + "/") ? { root: target, commonDir: "/fixture/common" } : undefined;
	};
	const spawn = d.deps.spawn!;
	d.deps.spawn = (...args) => {
		const child = spawn(...args);
		const on = child.on.bind(child);
		child.on = ((event: string, listener: () => void) => { if (event === "spawn") queueMicrotask(listener); return on(event as "spawn", listener); }) as typeof child.on;
		return child;
	};
	gentleAgents(h.pi, {}, d.deps);
	await h.fire("session_start", ctx);
	await h.tools.get("subagent_run")!.execute("mutation", { agent: "explore", task: "Write", mode: "background", workspace_root: target }, undefined, undefined, ctx);
	await tick();
	// The tool's own path never lands on disk -- realpathSync must throw
	// rather than report a plain mismatch.
	const evidence = { id: "write", root: target, path: "missing-target-test.ts", before: { kind: "text", text: "original\n" }, after: { kind: "text", text: "agent\n" } };
	d.children[0].emit({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "missing-target-test.ts" } });
	d.children[0].emit({ type: "tool_execution_end", toolCallId: "write", isError: false, result: { content: [], details: { gentleSessionChange: evidence } } });
	await tick();
	const rendered = await openTaskThread(h.commands, ctx, overlays);
	assert.match(rendered, /changes not attributed: evidence-path-unreadable\b/);
	await h.fire("session_shutdown", ctx);
	await tick();
});

test("a mutation dropped for mismatched session-change evidence explains itself once", async () => {
	const h = fakePi();
	const d = deps();
	const { ctx, overlays } = fakeContext();
	const target = realpathSync(cwd);
	(ctx as unknown as { cwd: string }).cwd = target;
	ctx.sessionManager.getCwd = () => target;
	ctx.sessionManager.getEntries = (() => h.entries) as typeof ctx.sessionManager.getEntries;
	ctx.sessionManager.getBranch = (() => h.entries) as typeof ctx.sessionManager.getBranch;
	d.deps.resolveWorktree = (path, base) => {
		const full = resolve(base, path);
		return full === target || full.startsWith(target + "/") ? { root: target, commonDir: "/fixture/common" } : undefined;
	};
	const spawn = d.deps.spawn!;
	d.deps.spawn = (...args) => {
		const child = spawn(...args);
		const on = child.on.bind(child);
		child.on = ((event: string, listener: () => void) => { if (event === "spawn") queueMicrotask(listener); return on(event as "spawn", listener); }) as typeof child.on;
		return child;
	};
	gentleAgents(h.pi, {}, d.deps);
	await h.fire("session_start", ctx);
	await h.tools.get("subagent_run")!.execute("mutation", { agent: "explore", task: "Write", mode: "background", workspace_root: target }, undefined, undefined, ctx);
	await tick();
	writeFileSync(join(target, "evidence-mismatch-test.ts"), "agent\n");
	const evidence = { id: "write", root: target, path: "different-file.ts", before: { kind: "text", text: "original\n" }, after: { kind: "text", text: "agent\n" } };
	d.children[0].emit({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "evidence-mismatch-test.ts" } });
	d.children[0].emit({ type: "tool_execution_end", toolCallId: "write", isError: false, result: { content: [], details: { gentleSessionChange: evidence } } });
	await tick();
	const rendered = await openTaskThread(h.commands, ctx, overlays);
	assert.match(rendered, /changes not attributed: evidence-path-mismatch\b/);
	await h.fire("session_shutdown", ctx);
	await tick();
});

test("a successfully attributed mutation adds no drop note", async () => {
	const h = fakePi();
	const d = deps();
	const { ctx, overlays } = fakeContext();
	const target = realpathSync(cwd);
	(ctx as unknown as { cwd: string }).cwd = target;
	ctx.sessionManager.getCwd = () => target;
	ctx.sessionManager.getEntries = (() => h.entries) as typeof ctx.sessionManager.getEntries;
	ctx.sessionManager.getBranch = (() => h.entries) as typeof ctx.sessionManager.getBranch;
	d.deps.resolveWorktree = (path, base) => {
		const full = resolve(base, path);
		return full === target || full.startsWith(target + "/") ? { root: target, commonDir: "/fixture/common" } : undefined;
	};
	const spawn = d.deps.spawn!;
	d.deps.spawn = (...args) => {
		const child = spawn(...args);
		const on = child.on.bind(child);
		child.on = ((event: string, listener: () => void) => { if (event === "spawn") queueMicrotask(listener); return on(event as "spawn", listener); }) as typeof child.on;
		return child;
	};
	gentleAgents(h.pi, {}, d.deps);
	await h.fire("session_start", ctx);
	await h.tools.get("subagent_run")!.execute("mutation", { agent: "explore", task: "Write", mode: "background", workspace_root: target }, undefined, undefined, ctx);
	await tick();
	writeFileSync(join(target, "happy-path-test.ts"), "agent\n");
	const evidence = { id: "write", root: target, path: "happy-path-test.ts", before: { kind: "text", text: "original\n" }, after: { kind: "text", text: "agent\n" } };
	d.children[0].emit({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "happy-path-test.ts" } });
	d.children[0].emit({ type: "tool_execution_end", toolCallId: "write", isError: false, result: { content: [], details: { gentleSessionChange: evidence } } });
	await tick();
	const rendered = await openTaskThread(h.commands, ctx, overlays);
	assert.doesNotMatch(rendered, /changes not attributed/);
	await h.fire("session_shutdown", ctx);
	await tick();
});

test("worktree attribution containment respects Windows path boundaries", () => {
	const candidate = win32.resolve("C:\\fixture", "project");
	assert.equal(containsResolvedPath(candidate, win32.resolve(candidate), win32), true, "the worktree root itself is contained");
	assert.equal(containsResolvedPath(candidate, win32.resolve(candidate, "nested", "file.ts"), win32), true, "Windows descendants are contained");
	assert.equal(containsResolvedPath(candidate, win32.resolve(candidate, ".."), win32), false, "the parent is excluded");
	assert.equal(containsResolvedPath(candidate, win32.resolve("C:\\fixture", "project-sibling", "file.ts"), win32), false, "a sibling prefix is excluded");
});

test("default Node spawn adapter distinguishes IPC-only and permission-capable canonical Git children", async () => {
	const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
	const originalSpawn = childProcess.spawn;
	type CapturedSpawnOptions = { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean; windowsHide?: boolean; detached?: boolean; stdio?: string[] };
	const captured: Array<{ command: string; args: readonly string[]; options: CapturedSpawnOptions }> = [];
	const children: FakeChild[] = [];
	const shutdown: Array<() => Promise<void>> = [];
	const canonicalGitFixture = mkdtempSync(join(tmpdir(), "gentle-agents-canonical-git-"));
	const canonicalGitCwd = join(canonicalGitFixture, "project");
	const gitTemplate = join(canonicalGitFixture, "template");
	try {
		mkdirSync(gitTemplate);
		execFileSync("git", ["init", "--quiet", `--template=${gitTemplate}`, canonicalGitCwd]);
	} catch (error) {
		rmSync(canonicalGitFixture, TEST_DIR_REMOVAL);
		throw error;
	}
	childProcess.spawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
		captured.push({ command, args, options: options as unknown as CapturedSpawnOptions });
		const child = fakeChild();
		children.push(child);
		return child.child;
	}) as unknown as typeof childProcess.spawn;
	syncBuiltinESMExports();
	try {
		const launch = async (mode: "task" | "background", env: NodeJS.ProcessEnv, sessionCwd = nonGitCwd) => {
			const h = fakePi();
			gentleAgents(h.pi, env, { home, agentHome: join(home, ".pi", "agent"), env, pi: { command: "/fixture/pi", args: ["--host-flag"] }, resolveWorktree: () => undefined, sessionTransport: inertSessionTransport });
			const { ctx } = fakeContext();
			(ctx.sessionManager as unknown as { getCwd(): string }).getCwd = () => sessionCwd;
			await h.fire("session_start", ctx);
			shutdown.push(async () => { await h.fire("session_shutdown", ctx); });
			return { h, ctx, result: h.tools.get("subagent_run")!.execute(`spawn-${mode}`, { agent: "explore", task: `Capture ${mode}`, mode }, undefined, undefined, ctx) };
		};
		const task = await launch("task", { PATH: "/bin", FIXTURE: "task" });
		await tick();
		children[0]!.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "task complete" }] }] });
		children[0]!.emit({ type: "agent_settled" });
		await task.result;
		const background = await launch("background", { PATH: "/bin", FIXTURE: "background" });
		await background.result;
		await tick();
		const permission = await launch("task", { PATH: "/bin", FIXTURE: "permission" }, canonicalGitCwd);
		await tick();
		children[2]!.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "permission complete" }] }] });
		children[2]!.emit({ type: "agent_settled" });
		await permission.result;

		const args = ["--host-flag", "--mode", "rpc", "--session-dir", join(home, ".pi", "agent", "gentle-agents", "sessions"), ...childContextExtensionPaths().flatMap((path) => ["--extension", path]), "--model", "openai-codex/gpt-5.6-terra:low", "--tools", "read,grep,subagent_parent_message", "--append-system-prompt", "You map things."];
		assert.equal(captured.length, 3, "the extension reaches Node's spawn boundary for IPC-only and permission-channel launches");
		const permissionChannelStdio = process.platform === "win32" ? "overlapped" : "pipe";
		for (const [index, fixture] of ["task", "background", "permission"].entries()) {
			const permissionChannel = index === 2;
			const ownedIpc = captured[index]?.options.env.GENTLE_PI_AGENTS_OWNED_IPC;
			assert.match(ownedIpc ?? "", /^\d+-[a-z0-9]+$/, "the child receives an opaque owned-IPC marker");
			assert.equal(captured[index]?.command, "/fixture/pi");
			assert.deepEqual(captured[index]?.args, args);
			assert.equal(captured[index]?.options.cwd, permissionChannel ? canonicalGitCwd : nonGitCwd);
			assert.deepEqual(captured[index]?.options.env, { PATH: "/bin", FIXTURE: fixture, GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_OWNED_IPC: ownedIpc, ...(permissionChannel ? { GENTLE_PI_AGENTS_PARENT_PERMISSION_FD: "3" } : {}), [REQUESTED_TOOLS_ENV]: "read,grep,subagent_parent_message" });
			assert.equal(captured[index]?.options.shell, undefined, "the adapter does not invoke a shell");
			assert.equal(captured[index]?.options.windowsHide, true, "the adapter always hides a Windows console");
			assert.equal(captured[index]?.options.detached, process.platform !== "win32", "the adapter forwards the runner's platform selection");
			assert.deepEqual(captured[index]?.options.stdio, permissionChannel ? ["pipe", "pipe", "pipe", permissionChannelStdio, "ipc"] : ["pipe", "pipe", "pipe", "ipc"], permissionChannel ? "canonical repository children retain an fd3 permission channel and receive messaging IPC at fd4" : "IPC-only children have no inherited permission fd");
		}
		await Promise.all(shutdown.map((close) => close()));
		assert.deepEqual(children[1]?.killed, ["SIGTERM"], "session shutdown cleans up an active background child");
		shutdown.length = 0;
	} finally {
		try {
			await shutdownAndRestoreNativeSpawn(childProcess, originalSpawn, () => Promise.all(shutdown.map((close) => close())));
		} finally {
			rmSync(canonicalGitFixture, TEST_DIR_REMOVAL);
		}
	}
});

test("native spawn interception restores CommonJS and ESM exports after rejected shutdown and assertion failure", async () => {
	const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
	const originalSpawn = childProcess.spawn;
	const assertRestored = async () => {
		assert.equal(childProcess.spawn, originalSpawn, "CommonJS spawn is restored");
		assert.equal((await import("node:child_process")).spawn, originalSpawn, "ESM spawn is restored");
	};
	const installMock = () => {
		childProcess.spawn = (() => fakeChild().child) as unknown as typeof childProcess.spawn;
		syncBuiltinESMExports();
	};
	const start = async (rejectShutdown: boolean) => {
		const h = fakePi();
		const fire = h.fire;
		if (rejectShutdown) {
			h.fire = async (event, ctx, payload) => {
				await fire(event, ctx, payload);
				if (event === "session_shutdown") throw new Error("forced shutdown rejection");
				return undefined;
			};
		}
		gentleAgents(h.pi, {}, { home, agentHome: join(home, ".pi", "agent"), env: { PATH: "/bin" }, pi: { command: "/fixture/pi", args: [] }, resolveWorktree: () => undefined, sessionTransport: inertSessionTransport });
		const { ctx } = fakeContext();
		await h.fire("session_start", ctx);
		await h.tools.get("subagent_run")!.execute("cleanup", { agent: "explore", task: "Keep cleanup live", mode: "background" }, undefined, undefined, ctx);
		await tick();
		return { h, ctx };
	};

	let mocked = false;
	installMock();
	mocked = true;
	try {
		const rejected = await start(true);
		await assert.rejects(shutdownAndRestoreNativeSpawn(childProcess, originalSpawn, () => rejected.h.fire("session_shutdown", rejected.ctx)), /forced shutdown rejection/);
		mocked = false;
		await assertRestored();
	} finally {
		if (mocked) {
			childProcess.spawn = originalSpawn;
			syncBuiltinESMExports();
		}
	}

	installMock();
	mocked = true;
	try {
		const asserted = await start(false);
		await assert.rejects(async () => {
			try {
				assert.fail("forced assertion failure");
			} finally {
				await shutdownAndRestoreNativeSpawn(childProcess, originalSpawn, () => asserted.h.fire("session_shutdown", asserted.ctx));
			}
		}, /forced assertion failure/);
		mocked = false;
		await assertRestored();
	} finally {
		if (mocked) {
			childProcess.spawn = originalSpawn;
			syncBuiltinESMExports();
		}
	}
});

test("foreign clone tool requires consent before queueing and never enters parent Changes", async (t) => {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "foreign-target-")));
	const parent = join(fixture, "parent"), foreign = join(fixture, "foreign");
	const template = join(fixture, "template");
	mkdirSync(template);
	try {
		for (const path of [parent, foreign]) execFileSync("git", ["init", "--quiet", `--template=${template}`, path]);
		const configHome = join(fixture, "config");
		mkdirSync(configHome);
		writeFileSync(join(configHome, "profiles.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, profiles: { pinned: { explore: { model: "openai/foreign-model", thinking: "minimal" } } } }));
		mkdirSync(join(foreign, ".git", "gentle-ai"));
		writeFileSync(join(foreign, ".git", "gentle-ai", "profile-pin.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profile_pin", version: 1, profile: "pinned" }));
		const h = fakePi(), runtime = deps();
		runtime.deps.env = { PATH: "/bin", GENTLE_PI_CONFIG_HOME: configHome };
		runtime.deps.resolveWorktree = resolveSessionWorktree;
		const spawned: string[] = [];
		const spawnEnvs: Array<Record<string, string | undefined>> = [];
		const spawn = runtime.deps.spawn!;
		runtime.deps.spawn = (command, args, options) => { spawned.push(options.cwd); spawnEnvs.push(options.env); return spawn(command, args, options); };
		const runnerRun = t.mock.method(AgentRunner.prototype, "run");
		gentleAgents(h.pi, {}, runtime.deps);
		let resolveConsent!: (answer: boolean) => void;
		let prompts = 0;
		const { ctx } = fakeContext(fakeTui, () => { prompts++; return new Promise<boolean>(resolve => { resolveConsent = resolve; }); });
		ctx.sessionManager.getCwd = () => parent;
		await h.fire("session_start", ctx);
		const run = h.tools.get("subagent_run")!;
		assert.match(JSON.stringify(run.parameters.properties.repository_root), /interactive session-scoped consent/i);
		await assert.rejects(run.execute("wrong-selector", { agent: "explore", task: "Map", workspace_root: foreign, mode: "background" }, undefined, undefined, ctx), /same Git clone/);
		await assert.rejects(run.execute("both", { agent: "explore", task: "Map", workspace_root: parent, repository_root: foreign, mode: "background" }, undefined, undefined, ctx), /mutually exclusive/);
		await assert.rejects(run.execute("both-malformed", { agent: "explore", task: "Map", workspace_root: parent, repository_root: 123, mode: "background" }, undefined, undefined, ctx), /mutually exclusive/);
		// Blank selectors name no destination, so they must not read as a second target.
		const blank = await run.execute("blank-roots", { agent: "__absent__", task: "Map", workspace_root: "", repository_root: "", mode: "background" }, undefined, undefined, ctx);
		assert.match(JSON.stringify(blank), /no subagent named/, "blank selectors pass the exclusivity guard and reach agent lookup");
		assert.deepEqual(spawned, [], "a blank selector must not spawn a child");
		assert.deepEqual(h.entries.filter(entry => entry.customType === SESSION_WORKTREE_ENTRY), [], "a blank selector must not register a worktree");
		const pending = run.execute("foreign", { agent: "explore", task: "Map", repository_root: foreign, mode: "background" }, undefined, undefined, ctx);
		await tick();
		assert.equal(prompts, 1);
		assert.deepEqual(spawned, []);
		assert.deepEqual(h.entries.filter(entry => entry.customType === SESSION_WORKTREE_ENTRY), []);
		resolveConsent(true);
		const result = await pending;
		await tick();
		assert.deepEqual(spawned, [foreign]);
		assert.equal((runnerRun.mock.calls[0]?.arguments[0] as { authorizeParentStandingReviewPermission?: unknown }).authorizeParentStandingReviewPermission, undefined, "foreign child must not receive parent review permission channel");
		assert.equal(runtime.spawned[0]?.[runtime.spawned[0]!.indexOf("--model") + 1], "openai/foreign-model:minimal");
		assert.equal((result.details.gentleAgents as { cwd: string }).cwd, foreign);
		assert.deepEqual(h.entries.filter(entry => entry.customType === SESSION_WORKTREE_ENTRY), []);
		const reused = await run.execute("reuse", { agent: "explore", task: "Map again", repository_root: foreign, mode: "background" }, undefined, undefined, ctx);
		assert.equal(prompts, 1);
		assert.equal((reused.details.gentleAgents as { cwd: string }).cwd, foreign);
		// Git's ambient routing must not turn an explicit foreign destination into the parent's repository.
		const oldGitDir = process.env.GIT_DIR;
		const oldGitWorkTree = process.env.GIT_WORK_TREE;
		try {
			process.env.GIT_DIR = join(parent, ".git");
			process.env.GIT_WORK_TREE = parent;
			runtime.deps.env!.GIT_DIR = join(parent, ".git");
			runtime.deps.env!.GIT_WORK_TREE = parent;
			const injected = await run.execute("injected-git", { agent: "explore", task: "Map with ambient Git routing", repository_root: foreign, mode: "background" }, undefined, undefined, ctx);
			assert.equal((injected.details.gentleAgents as { cwd: string }).cwd, foreign);
			assert.equal(prompts, 1);
			// Drain the active child so the queued injected launch reaches the actual OS spawn.
			runtime.children[0].emit({ type: "agent_end", messages: [] });
			runtime.children[0].emit({ type: "agent_settled" });
			runtime.children[0].exit(0);
			await tick();
			assert.equal(spawned.at(-1), foreign);
			assert.equal(spawnEnvs.at(-1)?.GIT_DIR, undefined);
			assert.equal(spawnEnvs.at(-1)?.GIT_WORK_TREE, undefined);
		} finally {
			delete runtime.deps.env!.GIT_DIR;
			delete runtime.deps.env!.GIT_WORK_TREE;
			if (oldGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldGitDir;
			if (oldGitWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = oldGitWorkTree;
		}
		const queued = await run.execute("queued", { agent: "explore", task: "Third map", repository_root: foreign, mode: "background" }, undefined, undefined, ctx);
		assert.equal((queued.details.gentleAgents as { cwd: string }).cwd, foreign);
		assert.equal(runtime.children.length, 3, "later launches wait in the runner queue");
		await run.execute("same-clone", { agent: "explore", task: "Map parent", workspace_root: parent, mode: "background" }, undefined, undefined, ctx);
		assert.equal(typeof (runnerRun.mock.calls.at(-1)?.arguments[0] as { authorizeParentStandingReviewPermission?: unknown }).authorizeParentStandingReviewPermission, "function", "same-clone child retains parent review permission channel");
		const { ctx: successor } = fakeContext();
		successor.sessionManager.getCwd = () => parent;
		await h.fire("session_start", successor);
		assert.notEqual(successor.sessionManager, ctx.sessionManager);
		assert.equal(successor.sessionManager.getSessionId(), ctx.sessionManager.getSessionId(), "replacement retains the same session ID");
		runtime.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
		runtime.children[0].emit({ type: "agent_settled" });
		runtime.children[0].exit(0);
		await tick();
		assert.equal(runtime.children.length, 3, "stale queued foreign task must fail before OS spawn");
		await h.fire("session_shutdown", successor);
	} finally { rmSync(fixture, TEST_DIR_REMOVAL); }
});

test("foreign child Changes require successful target-bound tool evidence, never model claims or sibling writes", async () => {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "foreign-changes-")));
	const parent = join(fixture, "parent"), foreign = join(fixture, "foreign"), sibling = join(fixture, "sibling"), template = join(fixture, "template");
	mkdirSync(template);
	try {
		for (const path of [parent, foreign, sibling]) execFileSync("git", ["init", "--quiet", `--template=${template}`, path]);
		const h = fakePi(), runtime = deps();
		runtime.deps.resolveWorktree = resolveSessionWorktree;
		const spawn = runtime.deps.spawn!;
		let proveSpawn: (() => void) | undefined;
		runtime.deps.spawn = (...args) => {
			const child = spawn(...args);
			const on = child.on.bind(child);
			child.on = ((event: string, listener: () => void) => {
				if (event === "spawn") proveSpawn = listener;
				return on(event as "spawn", listener);
			}) as typeof child.on;
			return child;
		};
		installSessionChangeCapture(h.pi, {}, resolveSessionWorktree);
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		ctx.sessionManager.getCwd = () => parent;
		ctx.sessionManager.getEntries = (() => h.entries) as typeof ctx.sessionManager.getEntries;
		ctx.sessionManager.getBranch = (() => h.entries) as typeof ctx.sessionManager.getBranch;
		await h.fire("session_start", ctx);
		const launched = await h.tools.get("subagent_run")!.execute("foreign-evidence", { agent: "explore", task: "Write", repository_root: foreign, mode: "background" }, undefined, undefined, ctx);
		await tick();
		const taskId = (launched.details.gentleAgents as { taskId: string }).taskId;
		const child = runtime.children[0];
		const send = async (id: string, root: string, path: string, error = false, forgedRoot?: string) => {
			const captured = await childSessionChangeEvidence(root, path, id, "agent output\n");
			const evidence = forgedRoot ? { ...captured, root: forgedRoot } : captured;
			child.emit({ type: "tool_execution_start", toolCallId: id, toolName: "write", args: { path } });
			child.emit({ type: "tool_execution_end", toolCallId: id, isError: error, result: { content: [], details: { gentleSessionChange: evidence } } });
			await tick();
		};
		child.emit({ type: "message_update", text: `I edited ${join(foreign, "claimed.md")}` });
		await send("unspawned", foreign, "unspawned.md");
		assert.equal(h.entries.some(entry => entry.customType === "gentle-pi.session-change/v1"), false, "unproven spawn cannot attribute a mutation");
		assert.ok(proveSpawn);
		proveSpawn();
		await tick();
		await send("sibling", sibling, "sibling.md");
		await send("forged", foreign, "forged.md", false, parent);
		await send("failed", foreign, "failed.md", true);
		assert.equal(h.entries.some(entry => entry.customType === "gentle-pi.session-change/v1"), false);
		await send("accepted", foreign, "accepted.md");
		const spacedEvidence = await childSessionChangeEvidence(foreign, "space name.md", "unicode-space", "agent output\n");
		child.emit({ type: "tool_execution_start", toolCallId: "unicode-space", toolName: "write", args: { path: "space\u00a0name.md" } });
		child.emit({ type: "tool_execution_end", toolCallId: "unicode-space", isError: false, result: { content: [], details: { gentleSessionChange: spacedEvidence } } });
		await tick();
		const editEvidence = await childSessionEditEvidence(foreign, "edited.md", "edit-accepted", "original\n", "changed\n");
		child.emit({ type: "tool_execution_start", toolCallId: "edit-accepted", toolName: "edit", args: { path: "edited.md" } });
		child.emit({ type: "tool_execution_end", toolCallId: "edit-accepted", isError: false, result: { content: [], details: { gentleSessionChange: editEvidence } } });
		await tick();
		const changes = new SessionChanges(ctx.sessionManager.getSessionId()!, h.entries);
		assert.deepEqual(changes.worktrees.map(tree => tree.root), [foreign]);
		assert.deepEqual(changes.model.files.map(file => file.path).sort(), ["accepted.md", "edited.md", "space name.md"]);
		assert.deepEqual(h.entries.filter(entry => entry.customType === SESSION_WORKTREE_ENTRY), []);
		assert.equal(h.events.some(event => event.name === "gentle-pi:child-session-change"), false);
		assert.equal(h.entries.filter(entry => entry.customType === "gentle-pi.session-change/v1").length, 3);
		assert.equal(changes.worktrees[0]?.model.files.find(file => file.path === "accepted.md")?.status, "added");
		assert.equal(changes.worktrees[0]?.model.files.find(file => file.path === "edited.md")?.status, "modified");
		mkdirSync(join(foreign, "nested"));
		const rebound = await childSessionChangeEvidence(foreign, "nested/rebound.md", "rebound", "not attributed\n");
		child.emit({ type: "tool_execution_start", toolCallId: "rebound", toolName: "write", args: { path: "nested/rebound.md" } });
		execFileSync("git", ["init", "--quiet", `--template=${template}`, join(foreign, "nested")]);
		child.emit({ type: "tool_execution_end", toolCallId: "rebound", isError: false, result: { content: [], details: { gentleSessionChange: rebound } } });
		await tick();
		assert.equal(h.entries.filter(entry => entry.customType === "gentle-pi.session-change/v1").length, 3, "new nested Git identity must not inherit foreign target attribution");
		const stale = await childSessionChangeEvidence(foreign, "stale.md", "stale", "not attributed\n");
		child.emit({ type: "tool_execution_start", toolCallId: "stale", toolName: "write", args: { path: "stale.md" } });
		const { ctx: successor } = fakeContext();
		successor.sessionManager.getCwd = () => parent;
		await h.fire("session_start", successor);
		child.emit({ type: "tool_execution_end", toolCallId: "stale", isError: false, result: { content: [], details: { gentleSessionChange: stale } } });
		await tick();
		assert.equal(h.entries.filter(entry => entry.customType === "gentle-pi.session-change/v1").length, 3, "session replacement during a tool cannot attribute its result");
		assert.equal(h.entries.filter(entry => entry.customType === SESSION_WORKTREE_ENTRY).length, 0);
		await h.fire("session_shutdown", successor);
	} finally { rmSync(fixture, TEST_DIR_REMOVAL); }
});

test("foreign task mode waits for the child and continuation reuses its live grant", async () => {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "foreign-task-")));
	const parent = join(fixture, "parent"), foreign = join(fixture, "foreign"), template = join(fixture, "template");
	mkdirSync(template);
	try {
		for (const path of [parent, foreign]) execFileSync("git", ["init", "--quiet", `--template=${template}`, path]);
		const h = fakePi(), runtime = deps();
		runtime.deps.resolveWorktree = resolveSessionWorktree;
		const spawn = runtime.deps.spawn!;
		runtime.deps.spawn = (...args) => {
			const child = spawn(...args);
			const on = child.on.bind(child);
			child.on = ((event: string, listener: () => void) => {
				if (event === "spawn") queueMicrotask(listener);
				return on(event as "spawn", listener);
			}) as typeof child.on;
			return child;
		};
		gentleAgents(h.pi, {}, runtime.deps);
		let prompts = 0;
		const { ctx } = fakeContext(fakeTui, async () => { prompts++; return true; });
		ctx.sessionManager.getCwd = () => parent;
		await h.fire("session_start", ctx);
		let finished = false;
		const pending = h.tools.get("subagent_run")!.execute("task", { agent: "explore", task: "Map", repository_root: foreign, mode: "task" }, undefined, undefined, ctx).then(result => { finished = true; return result; });
		await tick();
		assert.equal(finished, false, "task mode waits for settlement");
		assert.equal(runtime.children.length, 1);
		assert.equal(prompts, 1);
		runtime.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "mapped" }] }] });
		runtime.children[0].emit({ type: "agent_settled" });
		runtime.children[0].exit(0);
		const first = await pending;
		assert.equal((first.details.gentleAgents as { cwd: string }).cwd, foreign);
		const taskId = (first.details.gentleAgents as { taskId: string }).taskId;
		const continued = h.tools.get("subagent_continue")!.execute("follow-up", { task_id: taskId, prompt: "Follow up", mode: "task" }, undefined, undefined, ctx);
		await tick();
		assert.equal(runtime.children.length, 2);
		assert.equal(prompts, 1, "continuation cannot prompt for a second grant");
		runtime.children[1].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "continued" }] }] });
		runtime.children[1].emit({ type: "agent_settled" });
		runtime.children[1].exit(0);
		assert.equal(((await continued).details.gentleAgents as { cwd: string }).cwd, foreign);
		assert.equal(runtime.spawned.length, 2);
		await h.fire("session_shutdown", ctx);
	} finally { rmSync(fixture, TEST_DIR_REMOVAL); }
});

test("aborting during foreign consent cannot grant or queue a background child", async () => {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "foreign-abort-")));
	const parent = join(fixture, "parent"), foreign = join(fixture, "foreign"), template = join(fixture, "template");
	mkdirSync(template);
	try {
		for (const path of [parent, foreign]) execFileSync("git", ["init", "--quiet", `--template=${template}`, path]);
		const h = fakePi(), runtime = deps();
		runtime.deps.resolveWorktree = resolveSessionWorktree;
		gentleAgents(h.pi, {}, runtime.deps);
		let confirm!: (answer: boolean) => void;
		const { ctx } = fakeContext(fakeTui, () => new Promise(resolve => { confirm = resolve; }));
		ctx.sessionManager.getCwd = () => parent;
		await h.fire("session_start", ctx);
		const abort = new AbortController();
		const pending = h.tools.get("subagent_run")!.execute("abort", { agent: "explore", task: "Map", repository_root: foreign, mode: "background" }, abort.signal, undefined, ctx);
		await tick();
		abort.abort("interrupted");
		confirm(true);
		await assert.rejects(pending, /abort|cancel/i);
		assert.equal(runtime.children.length, 0);
		assert.deepEqual(h.entries.filter(entry => entry.customType === SESSION_WORKTREE_ENTRY), []);
		await h.fire("session_shutdown", ctx);
	} finally { rmSync(fixture, TEST_DIR_REMOVAL); }
});

test("an interactive non-Git umbrella can target an independent repository without registering it", async () => {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "foreign-umbrella-")));
	const umbrella = join(fixture, "umbrella"), foreign = join(fixture, "foreign"), template = join(fixture, "template");
	mkdirSync(umbrella); mkdirSync(template);
	try {
		execFileSync("git", ["init", "--quiet", `--template=${template}`, foreign]);
		const h = fakePi(), runtime = deps();
		runtime.deps.resolveWorktree = resolveSessionWorktree;
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		ctx.sessionManager.getCwd = () => umbrella;
		await h.fire("session_start", ctx);
		const run = h.tools.get("subagent_run")!;
		const launched = await run.execute("umbrella", { agent: "explore", task: "Map", repository_root: foreign, mode: "background" }, undefined, undefined, ctx);
		assert.equal((launched.details.gentleAgents as { cwd: string }).cwd, foreign);
		assert.deepEqual(h.entries.filter(entry => entry.customType === SESSION_WORKTREE_ENTRY), []);
		await h.fire("session_shutdown", ctx);
	} finally { rmSync(fixture, TEST_DIR_REMOVAL); }
});

test("foreign selector rejects RPC and retired SDD selections before consent", async () => {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "foreign-callers-")));
	const parent = join(fixture, "parent"), foreign = join(fixture, "foreign"), template = join(fixture, "template");
	mkdirSync(template);
	try {
		for (const path of [parent, foreign]) execFileSync("git", ["init", "--quiet", `--template=${template}`, path]);
		const h = fakePi(), runtime = deps();
		runtime.deps.resolveWorktree = resolveSessionWorktree;
		const agentHome = join(fixture, "agent-home");
		mkdirSync(join(agentHome, ".pi", "agent", "agents"), { recursive: true });
		writeFileSync(join(agentHome, ".pi", "agent", "agents", "explore.md"), "---\ndescription: explore\ntools: [read]\n---\nExplore");
		writeFileSync(join(agentHome, ".pi", "agent", "agents", "sdd-apply.md"), "---\ndescription: apply\ntools: [read]\n---\nApply");
		runtime.deps.home = agentHome;
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx, dialogs } = fakeContext();
		ctx.sessionManager.getCwd = () => parent;
		await h.fire("session_start", ctx);
		ctx.mode = "rpc";
		const run = h.tools.get("subagent_run")!;
		const base = { agent: "explore", task: "Map", repository_root: foreign, mode: "background" };
		await assert.rejects(run.execute("rpc", base, undefined, undefined, ctx), /interactive parent session/);
		ctx.mode = "print";
		await assert.rejects(run.execute("print", { ...base, mode: "task" }, undefined, undefined, ctx), /interactive parent session/);
		ctx.mode = "tui";
		assert.match((await run.execute("remediate", { ...base, remediation: {} }, undefined, undefined, ctx)).content[0].text, /retired SDD/);
		assert.match((await run.execute("foreign-sdd", { ...base, agent: "sdd-apply", sdd_change: { changeName: "alpha", workspaceRoot: foreign, phase: "apply" } }, undefined, undefined, ctx)).content[0].text, /retired SDD/);
		assert.equal(existsSync(join(agentHome, ".pi", "agent", "sessions")), false, "foreign explicit selection rejection must precede child session directory creation");
		const childHost = fakePi();
		gentleAgents(childHost.pi, { GENTLE_PI_AGENTS_CHILD: "1" }, runtime.deps);
		assert.equal(childHost.tools.has("subagent_run"), false, "child-originated foreign launches have no delegation tool");
		assert.equal(dialogs.length, 0);
		assert.equal(runtime.children.length, 0);
		await h.fire("session_shutdown", ctx);
	} finally { rmSync(fixture, TEST_DIR_REMOVAL); }
});

test("foreign clone rejects aliases, absent UI, decline and changed session before any child starts", async () => {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "foreign-denials-")));
	const parent = join(fixture, "parent"), foreign = join(fixture, "foreign"), template = join(fixture, "template");
	mkdirSync(template);
	try {
		for (const path of [parent, foreign]) execFileSync("git", ["init", "--quiet", `--template=${template}`, path]);
		const h = fakePi(), runtime = deps();
		runtime.deps.resolveWorktree = resolveSessionWorktree;
		gentleAgents(h.pi, {}, runtime.deps);
		let decision!: (answer: boolean) => void;
		const { ctx, dialogs } = fakeContext(fakeTui, () => new Promise(resolve => { decision = resolve; }));
		ctx.sessionManager.getCwd = () => parent;
		let id = "original";
		ctx.sessionManager.getSessionId = () => id;
		await h.fire("session_start", ctx);
		const run = h.tools.get("subagent_run")!;
		const args = (path: string) => ({ agent: "explore", task: "Map", repository_root: path, mode: "background" });
		await assert.rejects(run.execute("alias", args(`${foreign}/.`), undefined, undefined, ctx), /canonical independent Git repository/);
		ctx.hasUI = false;
		await assert.rejects(run.execute("no-ui", args(foreign), undefined, undefined, ctx), /interactive/);
		ctx.hasUI = true;
		const declined = run.execute("decline", args(foreign), undefined, undefined, ctx);
		await tick(); decision(false);
		await assert.rejects(declined, /interactive/);
		const drift = run.execute("drift", args(foreign), undefined, undefined, ctx);
		await tick(); id = "replacement"; decision(true);
		await assert.rejects(drift, /identity changed/);
		assert.equal(runtime.spawned.length, 0);
		assert.equal(dialogs.filter(dialog => dialog.startsWith("confirm:")).length, 2);
		assert.deepEqual(h.entries.filter(entry => entry.customType === SESSION_WORKTREE_ENTRY), []);
		await h.fire("session_shutdown", ctx);
	} finally { rmSync(fixture, TEST_DIR_REMOVAL); }
});

test("explicit child roots launch and continue in the actual cwd, persist without shell, and reject other clones", async () => {
	const h = fakePi();
	const runtime = deps();
	const childRoot = join(root, "child-worktree");
	const launched: string[] = [];
	const spawnEvents: Array<() => void> = [];
	const baseSpawn = runtime.deps.spawn!;
	runtime.deps.spawn = (command, args, options) => {
		launched.push(options.cwd);
		const child = baseSpawn(command, args, options);
		const on = child.on.bind(child);
		child.on = ((event: string, listener: () => void) => {
			if (event === "spawn") spawnEvents.push(listener);
			else on(event as "exit", listener);
			return child;
		}) as typeof child.on;
		return child;
	};
	runtime.deps.resolveWorktree = (path, base) => ({ root: resolve(base, path), commonDir: path === "/other-clone" ? "/other/git" : "/fixture/common" });
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	(ctx.sessionManager as unknown as { getEntries(): unknown[] }).getEntries = () => h.entries;
	await h.fire("session_start", ctx);
	const run = h.tools.get("subagent_run")!;
	await assert.rejects(run.execute("bad", { agent: "explore", task: "Map", workspace_root: "/other-clone", mode: "background" }, undefined, undefined, ctx), /same Git clone/);
	assert.deepEqual(launched, []);
	const result = await run.execute("one", { agent: "explore", task: "Map /other-clone mentioned in prose", workspace_root: childRoot, mode: "background" }, undefined, undefined, ctx);
	await tick();
	assert.deepEqual(launched, [childRoot]);
	assert.deepEqual(h.entries, [], "queueing and returning a child handle do not register roots");
	spawnEvents[0]();
	assert.deepEqual(h.entries, [{ type: "custom", customType: SESSION_WORKTREE_ENTRY, data: { sessionId: "s1", root: childRoot, evidence: "subagent:spawn" } }]);
	assert.deepEqual(h.events.filter(event => event.name === SESSION_WORKTREE_CHANGED), [{ name: SESSION_WORKTREE_CHANGED, data: { sessionId: "s1" } }]);
	const details = result.details.gentleAgents as { taskId: string; cwd: string };
	assert.equal(details.cwd, childRoot);
	runtime.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "mapped" }] }] });
	runtime.children[0].emit({ type: "agent_settled" });
	await tick();
	await h.tools.get("subagent_continue")!.execute("continue", { task_id: details.taskId, prompt: "Follow up", mode: "background" }, undefined, undefined, ctx);
	await tick();
	assert.deepEqual(launched, [childRoot, childRoot]);
	spawnEvents[1]();
	assert.equal(h.entries.filter(entry => entry.customType === SESSION_WORKTREE_ENTRY).length, 1, "continuation dedupes the original root");
	const status = await h.tools.get("subagent_status")!.execute("status", { task_id: details.taskId }, undefined, undefined, ctx);
	assert.match(status.content[0].text, /cwd:/);
	await h.fire("session_shutdown", ctx);
	spawnEvents[1]();
	assert.equal(h.entries.filter(entry => entry.customType === SESSION_WORKTREE_ENTRY).length, 1, "late process events after shutdown cannot register roots");
	await tick();
});

test("retired SDD agent names and selection are rejected before dispatch", async () => {
	const h = fakePi();
	const runtime = deps();
	const fixtureHome = join(root, "sdd-selection-home");
	mkdirSync(join(fixtureHome, ".pi", "agent", "agents"), { recursive: true });
	writeFileSync(join(fixtureHome, ".pi", "agent", "agents", "sdd-apply.md"), "---\ndescription: apply\ntools: [read]\n---\nSDD apply executor");
	writeFileSync(join(fixtureHome, ".pi", "agent", "agents", "explore.md"), "---\ndescription: explore\ntools: [read]\n---\nExplore");
	gentleAgents(h.pi, {}, { ...runtime.deps, home: fixtureHome });
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const tool = h.tools.get("subagent_run")!;
	for (const agent of ["sdd-apply", "sdd-verify", "sdd-archive", "sdd-research", "sdd-remediate", "sdd-custom"]) {
		const rejected = await tool.execute(agent, { agent, task: "Retired phase", mode: "background" }, undefined, undefined, ctx);
		assert.match(rejected.content[0].text, /retired SDD/i, agent);
	}
	for (const selector of ["sdd_change", "remediation", "research_selection"] as const) {
		const rejected = await tool.execute(selector, { agent: "explore", task: "Map", [selector]: {} }, undefined, undefined, ctx);
		assert.match(rejected.content[0].text, /retired SDD/i, selector);
	}
	assert.equal(runtime.spawned.length, 0);
	const ordinary = await tool.execute("ordinary", { agent: "explore", task: "Map", mode: "background" }, undefined, undefined, ctx);
	await tick();
	assert.equal(runtime.spawned.length, 1, "ordinary named agents remain dispatchable");
	const id = (ordinary.details.gentleAgents as { taskId: string }).taskId;
	for (const selector of ["sdd_change", "remediation", "research_selection"] as const) {
		const rejected = await h.tools.get("subagent_continue")!.execute(selector, { task_id: id, prompt: "Follow up", [selector]: {} }, undefined, undefined, ctx);
		assert.match(rejected.content[0].text, /retired SDD/i, selector);
	}
	assert.equal(runtime.spawned.length, 1);
	await h.fire("session_shutdown", ctx);
});

for (const drift of ["loss", "common-dir", "root"] as const) {
	test(`established writer authority rejects metadata ${drift} before preparation or queue`, async () => {
		const fixture = realpathSync(mkdtempSync(join(root, "established-writer-")));
		const project = join(fixture, "project");
		const cwd = join(project, "nested");
		const home = join(fixture, "home");
		mkdirSync(cwd, { recursive: true });
		const definitions = join(home, ".pi", "agent", "agents");
		mkdirSync(definitions, { recursive: true });
		writeFileSync(join(definitions, "worker.md"), "---\ndescription: fixture\nmodel: offline/good\n---\nFixture");
		execFileSync("git", ["init", "--quiet", project]);
		const h = fakePi();
		const runtime = deps();
		Object.assign(runtime.deps, { home, resolveWorktree: resolveSessionWorktree });
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		Object.assign(ctx, { cwd, modelRegistry: { find: () => ({ provider: "offline", id: "good" }) } });
		ctx.sessionManager.getCwd = () => cwd;
		await h.fire("session_start", ctx);
		let statusCalls = 0;
		const unbind = bindSessionRepositoryPreparation(ctx.sessionManager, cwd, async () => { statusCalls++; return true; }, () => true);
		try {
			if (drift === "root") execFileSync("git", ["init", "--quiet", cwd]);
			else {
				renameSync(join(project, ".git"), join(project, "saved-git"));
				if (drift === "common-dir") {
					const alternate = join(fixture, "alternate");
					mkdirSync(alternate);
					execFileSync("git", ["init", "--quiet", alternate]);
					writeFileSync(join(project, ".git"), `gitdir: ${join(alternate, ".git")}\n`);
				}
			}
			await assert.rejects(h.tools.get("subagent_run")!.execute("lost-authority", { agent: "worker", task: "Implement\n## Allowed edit surfaces\nsrc/app.ts", mode: "background" }, undefined, undefined, ctx));
			assert.equal(statusCalls, 0, "no bootstrap-capable STATUS after established identity drift");
			assert.equal(runtime.children.length, 0, "no writer queued/spawned after established identity drift");
		} finally { unbind(); await h.fire("session_shutdown", ctx); }
	});
}

for (const scenario of ["implicit-worker", "explicit-worker", "implicit-gentle-ai-worker", "explicit-gentle-ai-worker", "scope", "task", "mode", "model", "profile-model", "profile-valid", "foreign", "nested", "repository", "print", "cancelled", "missing", "off", "shutdown", "replacement", "changed-id", "during-cancel", "docs", "read-only", "review", "jd"] as const) {
	test(`bounded writer executor admission before bootstrap: ${scenario}`, async t => {
		const fixture = realpathSync(mkdtempSync(join(root, "writer-admission-")));
		const project = join(fixture, "project");
		const fixtureHome = join(fixture, "home");
		const definitions = join(fixtureHome, ".pi", "agent", "agents");
		mkdirSync(definitions, { recursive: true });
		mkdirSync(project);
		mkdirSync(join(project, "nested"));
		for (const role of ["worker", "gentle-ai-worker", "explore", "reviewer", "jd-fix-agent"]) writeFileSync(join(definitions, `${role}.md`), `---\ndescription: fixture\nmodel: offline/good\ntools: [read]\n---\nFixture`);
		const h = fakePi();
		const runtime = deps();
		runtime.deps.home = fixtureHome;
		runtime.deps.resolveWorktree = resolveSessionWorktree;
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		Object.assign(ctx, { cwd: project, modelRegistry: { find: (_provider: string, model: string) => scenario === "model" || model === "bad" ? undefined : { provider: "offline", id: model } } });
		ctx.sessionManager.getCwd = () => project;
		ctx.sessionManager.getEntries = () => h.entries as never;
		await h.fire("session_start", ctx);
		if (scenario === "profile-model" || scenario === "profile-valid") {
			mkdirSync(join(project, ".pi", "gentle-ai"), { recursive: true });
			writeFileSync(join(project, ".pi", "gentle-ai", "profile.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profile_pin", version: 1, profile: "invalid" }));
			const config = runtime.deps.env!.GENTLE_PI_CONFIG_HOME = join(fixture, "config");
			mkdirSync(config, { recursive: true });
			writeFileSync(join(config, "profiles.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, profiles: { invalid: { worker: { model: scenario === "profile-valid" ? "offline/pinned-good" : "offline/bad" } } } }));
		}
		let calls = 0;
		const abort = new AbortController();
		const unbind = scenario === "missing" ? () => {} : bindSessionRepositoryPreparation(ctx.sessionManager, project, async (_root, current) => {
			calls++;
			if (scenario === "shutdown") await h.fire("session_shutdown", ctx);
			if (scenario === "replacement") { const next = fakeContext(); next.ctx.sessionManager.getCwd = () => project; await h.fire("session_start", next.ctx); }
			if (scenario === "changed-id") ctx.sessionManager.getSessionId = () => "changed";
			if (scenario === "during-cancel") abort.abort();
			if (!current() || scenario === "off" || ["shutdown", "replacement"].includes(scenario)) return false;
			execFileSync("git", ["init", "--quiet", project], { env: { PATH: process.env.PATH, HOME: fixtureHome, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe" });
			return true;
		}, () => true);
		t.after(() => { unbind(); });
		if (scenario === "cancelled") abort.abort();
		if (scenario === "print") Object.assign(ctx, { mode: "print", hasUI: false });
		const agent = scenario.includes("gentle-ai-worker") ? "gentle-ai-worker" : scenario === "read-only" ? "explore" : scenario === "review" ? "reviewer" : scenario === "jd" ? "jd-fix-agent" : "worker";
		const task = `Implement source\n## Allowed edit surfaces\n${scenario === "docs" ? "odd/tasks/feature.md" : "src/app.ts"}\n## Return\nReport`;
		const params = { agent, task: scenario === "scope" ? "No surface" : scenario === "task" ? 42 : task, mode: scenario === "mode" ? "invalid" : "background", ...(scenario.startsWith("explicit") ? { workspace_root: project } : {}), ...(scenario === "nested" ? { workspace_root: join(project, "nested") } : {}), ...(scenario === "foreign" ? { workspace_root: fixtureHome } : {}), ...(scenario === "repository" ? { repository_root: fixtureHome } : {}) };
		const accepted = scenario.startsWith("implicit-") || scenario.startsWith("explicit-") || scenario === "profile-valid" || ["docs", "read-only", "review", "jd"].includes(scenario);
		const result = h.tools.get("subagent_run")!.execute("admission", params, abort.signal, undefined, ctx);
		if (accepted) await result; else await assert.rejects(result);
		await tick();
		const prepared = scenario.startsWith("implicit-") || scenario.startsWith("explicit-") || scenario === "profile-valid";
		if (scenario === "profile-valid") assert.ok(runtime.spawned[0]?.includes("offline/pinned-good"), "repository declaration retains effective profile through bootstrap");
		assert.equal(calls, prepared || ["off", "shutdown", "replacement", "changed-id", "during-cancel"].includes(scenario) ? 1 : 0);
		assert.equal(existsSync(join(project, ".git")), prepared);
		assert.equal(runtime.children.length, accepted ? 1 : 0, "invalid admission never queues/spawns");
	});
}

// gentle-shell#1558 (barbatdev review): the non-git writer admission and the
// launch path must resolve the same model. Before the session-binding layer,
// both read pin/global only; with a binding present the launch resolves it
// first while admission still read the declaration, so a bound session killed
// its own writer mid-preparation with a false "profile or session changed".
test("a session binding keeps writer admission and launch resolution in agreement", async t => {
	t.after(() => resetSessionProfileBindingsForTesting());
	const fixture = realpathSync(mkdtempSync(join(root, "writer-session-binding-")));
	const project = join(fixture, "project");
	const fixtureHome = join(fixture, "home");
	const definitions = join(fixtureHome, ".pi", "agent", "agents");
	mkdirSync(definitions, { recursive: true });
	mkdirSync(project);
	writeFileSync(join(definitions, "worker.md"), "---\ndescription: fixture\nmodel: offline/good\ntools: [read]\n---\nFixture");
	// The unversioned project declaration routes the writer at one model and the
	// session binding at another: only agreement between the two resolutions can
	// let this launch through, and both must pick the binding's model.
	mkdirSync(join(project, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(join(project, ".pi", "gentle-ai", "profile.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profile_pin", version: 1, profile: "declared" }));
	const configHome = join(fixture, "config");
	mkdirSync(configHome, { recursive: true });
	writeFileSync(join(configHome, "profiles.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, profiles: { declared: { worker: { model: "offline/pinned-good" } }, bound: { worker: { model: "offline/bound-good" } } } }));
	bindSessionProfile("s1", "bound", { worker: { model: "offline/bound-good" } });
	const h = fakePi();
	const runtime = deps();
	runtime.deps.home = fixtureHome;
	runtime.deps.env!.GENTLE_PI_CONFIG_HOME = configHome;
	runtime.deps.resolveWorktree = resolveSessionWorktree;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	Object.assign(ctx, { cwd: project, modelRegistry: { find: (_provider: string, model: string) => ({ provider: "offline", id: model }) } });
	ctx.sessionManager.getCwd = () => project;
	await h.fire("session_start", ctx);
	const unbind = bindSessionRepositoryPreparation(ctx.sessionManager, project, async (_root, current) => {
		if (!current()) return false;
		execFileSync("git", ["init", "--quiet", project], { env: { PATH: process.env.PATH, HOME: fixtureHome, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe" });
		return true;
	}, () => true);
	try {
		await h.tools.get("subagent_run")!.execute("session-binding-admission", { agent: "worker", task: "Implement source\n## Allowed edit surfaces\nsrc/app.ts\n## Return\nReport", mode: "background" }, undefined, undefined, ctx);
		await tick();
		assert.equal(runtime.children.length, 1, "the bound session's writer launches instead of dying as a false profile/session drift");
		assert.ok(runtime.spawned[0]?.includes("offline/bound-good"), "admission and launch both resolve the binding ahead of the project declaration");
	} finally { unbind(); await h.fire("session_shutdown", ctx); await tick(); }
});

for (const explicit of [false, true]) {
	test(`same manager and ID after bootstrap permit ${explicit ? "explicit" : "implicit"} launch registration`, async () => {
		const h = fakePi();
		const runtime = deps();
		let bootstrapped = false;
		const baseSpawn = runtime.deps.spawn!;
		runtime.deps.spawn = (command, args, options) => {
			const child = baseSpawn(command, args, options);
			const on = child.on.bind(child);
			child.on = ((event: string, listener: () => void) => {
				if (event === "spawn") queueMicrotask(listener);
				else on(event as "exit", listener);
				return child;
			}) as typeof child.on;
			return child;
		};
		runtime.deps.resolveWorktree = (path, base) => bootstrapped ? { root: resolve(base, path), commonDir: "/bootstrap/git" } : undefined;
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		const manager = ctx.sessionManager;
		ctx.sessionManager.getEntries = () => h.entries as never;
		await h.fire("session_start", ctx);
		assert.deepEqual(h.entries, []);
		bootstrapped = true;
		const result = await h.tools.get("subagent_run")!.execute("bootstrap", { agent: "explore", task: "Map", mode: "background", ...(explicit ? { workspace_root: cwd } : {}) }, undefined, undefined, ctx);
		await tick();
		assert.equal(runtime.children.length, 1);
		assert.equal(ctx.sessionManager, manager);
		assert.equal(ctx.sessionManager.getSessionId(), "s1");
		assert.equal(h.entries.filter(entry => entry.customType === SESSION_WORKTREE_ENTRY).length, 1);
		runtime.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "mapped" }] }] });
		runtime.children[0].emit({ type: "agent_settled" });
		await tick();
		const taskId = (result.details.gentleAgents as { taskId: string }).taskId;
		assert.match((await h.tools.get("subagent_status")!.execute("status", { task_id: taskId }, undefined, undefined, ctx)).content[0].text, /completed/);
		assert.equal(h.entries.some(entry => entry.customType === REVIEW_REMINDER_RECEIPT), false, "spawn registration is not mutation evidence");
	});
}

test("ordinary non-Git tasks still continue in their original cwd without registering a worktree", async () => {
	const h = fakePi();
	const runtime = deps();
	runtime.deps.resolveWorktree = () => undefined;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const result = await h.tools.get("subagent_run")!.execute("run", { agent: "explore", task: "Map", mode: "background" }, undefined, undefined, ctx);
	await tick();
	runtime.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "mapped" }] }] });
	runtime.children[0].emit({ type: "agent_settled" });
	await tick();
	const taskId = (result.details.gentleAgents as { taskId: string }).taskId;
	await h.tools.get("subagent_continue")!.execute("continue", { task_id: taskId, prompt: "Follow up", mode: "background" }, undefined, undefined, ctx);
	await tick();
	assert.equal(runtime.children.length, 2);
	assert.deepEqual(h.entries.filter(entry => entry.customType !== "gentle-agents.wake-identity"), []);
	await h.fire("session_shutdown", ctx);
	await tick();
});

for (const sameId of [false, true]) {
	test(`delayed child spawn cannot append into a ${sameId ? "same-ID manager" : "new-ID session"} replacement`, async () => {
		const h = fakePi();
		const runtime = deps();
		const spawnEvents: Array<() => void> = [];
		const baseSpawn = runtime.deps.spawn!;
		runtime.deps.spawn = (command, args, options) => {
			const child = baseSpawn(command, args, options);
			const on = child.on.bind(child);
			child.on = ((event: string, listener: () => void) => {
				if (event === "spawn") spawnEvents.push(listener);
				else on(event as "exit", listener);
				return child;
			}) as typeof child.on;
			return child;
		};
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		await h.fire("session_start", ctx);
		await h.tools.get("subagent_run")!.execute("run", { agent: "explore", task: "Map", workspace_root: join(root, "old-root"), mode: "background" }, undefined, undefined, ctx);
		await tick();
		const next = fakeContext();
		(next.ctx.sessionManager as unknown as { getSessionId(): string }).getSessionId = () => sameId ? "s1" : "s2";
		await h.fire("session_start", next.ctx);
		spawnEvents[0]();
		await tick();
		assert.deepEqual(h.entries.filter(entry => entry.customType !== "gentle-agents.wake-identity"), [], "captured registry is closed instead of appending worktree state to the new bound API");
		await h.fire("session_shutdown", next.ctx);
	});
}

test("agentRuntimePaths isolates sessions and transcripts by profile and retains the explicit-home fallback", () => {
	assert.deepEqual(agentRuntimePaths("/home/x", "/profiles/pi-principal/agent"), {
		sessions: join("/profiles/pi-principal/agent", "gentle-agents", "sessions"),
		transcripts: join("/profiles/pi-principal/agent", "gentle-agents", "transcripts"),
	});
	assert.deepEqual(agentRuntimePaths("/home/x", "/profiles/pi-lab/agent"), {
		sessions: join("/profiles/pi-lab/agent", "gentle-agents", "sessions"),
		transcripts: join("/profiles/pi-lab/agent", "gentle-agents", "transcripts"),
	});
	assert.deepEqual(agentRuntimePaths("/home/x"), {
		sessions: join("/home/x", ".pi", "agent", "gentle-agents", "sessions"),
		transcripts: join("/home/x", ".pi", "agent", "gentle-agents", "transcripts"),
	});
});

test("extension resolves each profile environment at setup time without changing HOME", async () => {
	const principalHome = join(root, "pi-principal", "agent");
	const labHome = join(root, "pi-lab", "agent");
	for (const [agentHome, name] of [[principalHome, "principal"], [labHome, "lab"]] as const) {
		mkdirSync(join(agentHome, "agents"), { recursive: true });
		writeFileSync(join(agentHome, "agents", `${name}.md`), `---\ndescription: ${name}\n---\n${name}`);
	}
	const withoutExplicitHome = () => {
		const harness = deps();
		const { home: _home, env: _env, ...overrides } = harness.deps;
		return overrides;
	};
	const principal = fakePi();
	gentleAgents(principal.pi, { GENTLE_PI_AGENT_HOME: principalHome, PI_CODING_AGENT_DIR: labHome }, withoutExplicitHome());
	const principalContext = fakeContext();
	await principal.fire("session_start", principalContext.ctx);
	assert.match((await principal.tools.get("subagent_list_agents")!.execute("p1", {}, undefined, undefined, principalContext.ctx)).content[0].text, /principal/);
	const lab = fakePi();
	gentleAgents(lab.pi, { PI_CODING_AGENT_DIR: labHome }, withoutExplicitHome());
	const labContext = fakeContext();
	await lab.fire("session_start", labContext.ctx);
	assert.match((await lab.tools.get("subagent_list_agents")!.execute("l1", {}, undefined, undefined, labContext.ctx)).content[0].text, /lab/);
});

for (const [key, tilde] of [["GENTLE_PI_AGENT_HOME", false], ["PI_CODING_AGENT_DIR", false], ["GENTLE_PI_AGENT_HOME", true], ["PI_CODING_AGENT_DIR", true]] as const) {
	test(`${key} ${tilde ? "tilde" : "relative"} profile shares an absolute parent and child session root`, async () => {
		const agentHome = join(root, `${key}-${tilde}`, "agent");
		mkdirSync(join(agentHome, "agents"), { recursive: true });
		writeFileSync(join(agentHome, "agents", "relative.md"), "---\ndescription: relative profile\n---\nMap things.");
		writeFileSync(join(agentHome, "subagents.json"), JSON.stringify({ default_model: "openai/profile-model" }));
		const env = { [key]: tilde ? `~/${relative(homedir(), agentHome)}` : relative(process.cwd(), agentHome) };
		const harness = deps();
		const { home: _home, env: _env, ...overrides } = harness.deps;
		const { pi, tools, fire } = fakePi();
		gentleAgents(pi, env, overrides);
		const { ctx } = fakeContext();
		assert.notEqual(ctx.sessionManager.getCwd(), process.cwd());
		await fire("session_start", ctx);
		await tools.get("subagent_run")!.execute("relative", { agent: "relative", task: "Map", mode: "background" }, undefined, undefined, ctx);
		await tick();
		try {
			const args = harness.spawned[0];
			const sessionDir = args[args.indexOf("--session-dir") + 1];
			const expected = join(agentHome, "gentle-agents", "sessions");
			assert.equal(sessionDir, expected);
			assert.equal(resolve(ctx.sessionManager.getCwd(), sessionDir), expected);
			assert.equal(existsSync(expected), true, "parent created the exact child session root");
			assert.match(args[args.indexOf("--model") + 1], /profile-model/);
		} finally {
			await fire("session_shutdown", ctx);
			await tick();
		}
	});
}

// A per-repository profile pin is resolved at launch against the global profiles
// store. The fixture writes both layers into a sandbox instead of a real clone and
// binds them to the launch through the worktree resolver the launch already uses,
// so these tests never depend on the ambient Git state.
function pinFixture(name: string) {
	const base = join(root, `pin-${name}`);
	const worktreeRoot = join(base, "worktree");
	const commonDir = join(base, "git-common");
	const configHome = join(base, "config");
	for (const dir of [worktreeRoot, commonDir, configHome]) mkdirSync(dir, { recursive: true });
	const writePinText = (path: string, profile: string) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ kind: "gentle-pi.agent_model_profile_pin", version: 1, profile }, null, 2)}\n`);
	};
	const localPinPath = join(commonDir, "gentle-ai", "profile-pin.json");
	const declarationPath = join(worktreeRoot, ".pi", "gentle-ai", "profile.json");
	return {
		root: worktreeRoot,
		commonDir,
		configHome,
		localPinPath,
		declarationPath,
		writePin: (profile: string) => writePinText(localPinPath, profile),
		writeDeclaration: (profile: string) => writePinText(declarationPath, profile),
		writeStore: (profiles: Record<string, unknown>) => {
			writeFileSync(join(configHome, "profiles.json"), `${JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, profiles }, null, 2)}\n`);
		},
	};
}

// The model the child was actually spawned with, resolved for the repository the
// pin fixture binds to the launch.
async function launchPinned(base: ReturnType<typeof pinFixture>): Promise<string> {
	const harness = deps();
	harness.deps.resolveWorktree = () => ({ root: base.root, commonDir: base.commonDir });
	harness.deps.env = { PATH: "/bin", GENTLE_PI_CONFIG_HOME: base.configHome };
	const { pi, tools, fire } = fakePi();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	try {
		await tools.get("subagent_run")!.execute("pin", { agent: "explore", task: "Map", mode: "background" }, undefined, undefined, ctx);
		await tick();
		const args = harness.spawned[0];
		return args[args.indexOf("--model") + 1];
	} finally {
		await fire("session_shutdown", ctx);
		await tick();
	}
}

test("a local pin routes the repository's subagent launches through the pinned profile", async () => {
	const base = pinFixture("local");
	base.writeStore({
		pinned: {
			// The reserved orchestrator key travels inside the profile but is never
			// subagent routing.
			orchestrator: { model: "nan/glm5.3", thinking: "max" },
			explore: { model: "openai/alpha", thinking: "minimal" },
		},
	});
	base.writePin("pinned");
	assert.equal(await launchPinned(base), "openai/alpha:minimal");
});

test("a pinned profile replaces global subagent routing instead of merging it", async () => {
	const base = pinFixture("replace");
	// The global subagents.json routes explore at a lower effort and the pinned
	// profile does not mention explore at all: wholesale replacement returns it to
	// its definition routing instead of inheriting the global profile.
	base.writeStore({ pinned: { helper: { model: "openai/beta" } } });
	base.writePin("pinned");
	assert.equal(await launchPinned(base), "openai-codex/gpt-5.6-terra:high");
});

test("a committed repository declaration pins the worktree when no local pin exists", async () => {
	const base = pinFixture("declaration");
	base.writeStore({ declared: { explore: { model: "openai/alpha" } } });
	base.writeDeclaration("declared");
	assert.equal(await launchPinned(base), "openai/alpha:high");
});

test("a local pin takes precedence over the worktree's repository declaration", async () => {
	const base = pinFixture("precedence");
	base.writeStore({
		declared: { explore: { model: "openai/alpha" } },
		local: { explore: { model: "openai/beta" } },
	});
	base.writeDeclaration("declared");
	base.writePin("local");
	assert.equal(await launchPinned(base), "openai/beta:high");
});

test("a stale or unreadable pin degrades to the global routing instead of failing the launch", async () => {
	const base = pinFixture("stale");
	base.writeStore({ other: { explore: { model: "openai/alpha" } } });
	base.writePin("deleted-profile");
	assert.equal(await launchPinned(base), "openai-codex/gpt-5.6-terra:low");
	writeFileSync(base.localPinPath, "{ not json\n");
	assert.equal(await launchPinned(base), "openai-codex/gpt-5.6-terra:low");
});

// gentle-shell#1558 (barbatdev review): the two registered launch-seam gaps.
// The pure helpers were covered, but the real subagent_run seam had no
// committed test for the session layer.
test("a session binding outranks the repository pin at the launch seam", async t => {
	t.after(() => resetSessionProfileBindingsForTesting());
	const base = pinFixture("session-over-pin");
	base.writeStore({
		pinned: { explore: { model: "openai/alpha", thinking: "minimal" } },
		bound: { explore: { model: "openai/beta" } },
	});
	base.writePin("pinned");
	// fakeContext's session id is "s1"; the binding is process state, so it is
	// bound before the launch and reset by t.after so later pin tests stay pure.
	bindSessionProfile("s1", "bound", { explore: { model: "openai/beta" } });
	assert.equal(await launchPinned(base), "openai/beta:high", "the session binding wins over a winning repository pin");
});

test("a queued launch keeps the session routing frozen across a rebind", async t => {
	t.after(() => resetSessionProfileBindingsForTesting());
	const base = pinFixture("queue-freeze");
	base.writeStore({
		first: { explore: { model: "openai/alpha", thinking: "minimal" } },
		second: { explore: { model: "openai/beta" } },
	});
	bindSessionProfile("s1", "first", { explore: { model: "openai/alpha", thinking: "minimal" } });
	const harness = deps();
	harness.deps.resolveWorktree = () => ({ root: base.root, commonDir: base.commonDir });
	harness.deps.env = { PATH: "/bin", GENTLE_PI_CONFIG_HOME: base.configHome };
	const { pi, tools, fire } = fakePi();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	try {
		const model = (args: string[]) => args[args.indexOf("--model") + 1];
		// The first launch freezes first's routing into its task request and its
		// spawned child. Rebinding the session must leave that request untouched;
		// only a request created afterwards resolves the new binding.
		await tools.get("subagent_run")!.execute("freeze-1", { agent: "explore", task: "Map first", mode: "background" }, undefined, undefined, ctx);
		bindSessionProfile("s1", "second", { explore: { model: "openai/beta" } });
		await tools.get("subagent_run")!.execute("freeze-2", { agent: "explore", task: "Map second", mode: "background" }, undefined, undefined, ctx);
		await tick();
		assert.equal(model(harness.spawned[0]), "openai/alpha:minimal", "the request created before the rebind keeps its frozen routing");
		assert.equal(model(harness.spawned[1]), "openai/beta:high", "only requests created after the rebind resolve the new binding");
	} finally {
		await fire("session_shutdown", ctx);
		await tick();
	}
});

test("agentsEnabled and agentsCollapseKey read their flags and stay off inside a child", () => {
	assert.equal(agentsEnabled({}), true);
	assert.equal(agentsEnabled({ GENTLE_PI_AGENTS: "off" }), false);
	assert.equal(agentsEnabled({ GENTLE_PI_AGENTS_CHILD: "1" }), false);
	assert.equal(agentsCollapseKey({}), "ctrl+shift+a");
	assert.equal(agentsCollapseKey({ GENTLE_PI_AGENTS_KEY: "off" }), undefined);
	assert.equal(agentsViewKey({}), "alt+a");
	assert.equal(agentsViewKey({ GENTLE_PI_AGENTS_VIEW_KEY: "off" }), undefined);
	assert.equal(agentsStopKey({}), "alt+s");
	assert.equal(agentsStopKey({ GENTLE_PI_AGENTS_STOP_KEY: "" }), undefined);
	assert.equal(agentsStopKey({ GENTLE_PI_AGENTS_STOP_KEY: "off" }), undefined);
	const off = fakePi();
	gentleAgents(off.pi, { GENTLE_PI_AGENTS: "0" });
	assert.equal(off.tools.size, 0);
});

test("while pi-subagents-j0k3r is still installed the tools stay unregistered and the user is told how to switch", async () => {
	const legacyHome = join(root, "legacy-home");
	mkdirSync(join(legacyHome, ".pi", "agent"), { recursive: true });
	writeFileSync(join(legacyHome, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:pi-subagents-j0k3r", "../../work/gentle-pi"] }));
	assert.equal(legacySubagentsInstalled(legacyHome), true);
	assert.equal(legacySubagentsInstalled(home), false);
	assert.equal(legacySubagentsInstalled(join(root, "missing")), false);
	const { pi, tools, fire } = fakePi();
	gentleAgents(pi, {}, { ...deps().deps, home: legacyHome });
	assert.equal(tools.size, 0);
	const notices: string[] = [];
	const ctx = { hasUI: true, ui: { notify: (message: string, level: string) => notices.push(`${level}:${message}`) } } as unknown as ExtensionContext;
	await fire("session_start", ctx);
	assert.match(notices[0] ?? "", /^warning:❀ Gentle Agents is waiting: remove the old package first with "pi remove npm:pi-subagents-j0k3r"/);
});

test("subagent_list_agents publishes each agent's declared tool inventory so routing can check capabilities", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "capability-catalog-"));
	const agentHome = join(fixture, "agent-home");
	mkdirSync(join(agentHome, ".pi", "agent", "agents"), { recursive: true });
	writeFileSync(join(agentHome, ".pi", "agent", "agents", "explore.md"), "---\ndescription: maps things\ntools: [read, grep, find, codegraph]\n---\nYou map things.");
	writeFileSync(join(agentHome, ".pi", "agent", "agents", "open.md"), "---\ndescription: no allowlist\n---\nYou are open.");
	writeFileSync(join(agentHome, ".pi", "agent", "agents", "unknown.md"), "---\ndescription: unverified name\ntools: [glob]\n---\nYou explore.");
	writeFileSync(join(agentHome, ".pi", "agent", "agents", "lens.md"), "---\ndescription: review lane\ntools:\n  - \"*\": false\n  - read\n  - grep\n  - gentle_review_scope\n---\nYou review.");
	writeFileSync(join(agentHome, ".pi", "agent", "agents", "denied.md"), "---\ndescription: only a wildcard\ntools:\n  - \"*\": false\n---\nYou are denied.");
	try {
		const h = fakePi(), runtime = deps();
		runtime.deps.home = agentHome;
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		await h.fire("session_start", ctx);
		const listed = await h.tools.get("subagent_list_agents")!.execute("c0", {}, undefined, undefined, ctx);
		assert.match(listed.content[0].text, /- explore \(global\): maps things \[declared tools \(not verified\): read, grep, find, codegraph\]/);
		// gentle-shell#1269: a definition without an allowlist keeps Pi's default
		// tool set, so the catalog must never render it as having no tools at all.
		assert.match(listed.content[0].text, /- open \(global\): no allowlist \[declared tools: Pi defaults \(no allowlist\)\]/);
		// The review lane declares the `"*": false` wildcard, which Pi drops: it is
		// not a capability and must not appear as one in the routing surface.
		assert.match(listed.content[0].text, /- lens \(global\): review lane \[declared tools \(not verified\): read, grep, gentle_review_scope\]/);
		assert.doesNotMatch(listed.content[0].text, /false/);
		assert.match(listed.content[0].text, /- unknown \(global\): unverified name \[declared tools \(not verified\): glob\]/);
		assert.match(listed.content[0].text, /- denied \(global\): only a wildcard \[declared tools: no tool names declared\]/);
	} finally { rmSync(fixture, TEST_DIR_REMOVAL); }
});

test("subagent_list_agents and subagent_run in task mode launch a child with the resolved profile and return its answer", async () => {
	const { pi, tools, fire } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx, widget } = fakeContext();
	await fire("session_start", ctx);
	assert.deepEqual([...tools.keys()].sort(), ["bash_background", "job_list", "job_stop", "monitor", "orchestrator_consult", "orchestrator_list", "orchestrator_send_message", "orchestrator_session_id", "subagent_cancel", "subagent_continue", "subagent_list_agents", "subagent_list_tasks", "subagent_reply", "subagent_result", "subagent_run", "subagent_send_message", "subagent_status"]);
	const listed = await tools.get("subagent_list_agents")!.execute("c0", {}, undefined, undefined, ctx);
	assert.match(listed.content[0].text, /- explore \(global\): maps things/);

	const running = tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Map lib/ and report every module.", label: "map lib modules", context: "Focus on agents-*.ts" }, undefined, undefined, ctx);
	await tick();
	const [args] = harness.spawned;
	assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.6-terra:low", "the profile effort overrides the definition");
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep,subagent_parent_message");
	await tick();
	assert.match(String(harness.children[0].written[1].message), /Map lib\/ and report every module\.\n\n## Context\nFocus on agents-\*\.ts/);
	assert.match(widget()![0], /^╭─ ❀ Agents · 1 active ─+╮$/);
	assert.match(widget()![1], /^│ ◐  explore  map lib modules +gpt-5\.6-terra · low · \d+s │$/);
	harness.children[0].emit({ type: "tool_execution_start", toolCallId: "c", toolName: "grep", args: {} });
	harness.children[0].emit({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 12_000, cost: { total: 0.09 } } } });
	await tick();
	assert.match(widget()![1], /◐  explore  map lib modules +gpt-5\.6-terra · low · 12k · \$0\.090 · \d+s │$/);
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "lib has three agent files." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	const result = await running;
	const runId = (result.details.gentleAgents as { taskId: string }).taskId;
	assert.equal(result.content[0].text, `Subagent explore (task ${runId}, "map lib modules") finished.\n\nlib has three agent files.`, "the model sees the real task id and label, not only details");
	assert.deepEqual(tools.get("subagent_run")!.renderResult(result as Parameters<Registered["renderResult"]>[0], { expanded: false }, plainTheme).render(80).map((line) => line.trimEnd()), ["lib has three agent files."], "the collapsed card still leads with the answer");
	assert.equal((result.details.gentleAgents as { status: string }).status, "completed");
	assert.match(widget()![1], /✓  explore  map lib modules/);
	const orphan = tools.get("subagent_run")!.execute("c9", { agent: "explore", task: "Orphan", mode: "background" }, undefined, undefined, ctx);
	await orphan;
	await tick();
	await fire("session_shutdown", ctx);
	await tick();
	assert.deepEqual(harness.children[1].killed, ["SIGTERM"], "closing pi stops the running children");
	assert.match(tools.get("subagent_run")!.renderCall({ agent: "explore" }, plainTheme).render(60).join(""), /❀ agent run · explore/);
});

test("running subagent_result polls hide only their tool chrome, not the model result or final completion", async () => {
	const { pi, tools, fire, sent, renderers } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const started = await tools.get("subagent_run")!.execute("start", { agent: "explore", task: "Long job", mode: "background" }, undefined, undefined, ctx);
	const id = (started.details.gentleAgents as { taskId: string }).taskId;
	await tick();
	const resultTool = tools.get("subagent_result")!;
	for (const expanded of [false, true]) {
		const poll = await resultTool.execute("poll", { task_id: id }, undefined, undefined, ctx);
		assert.match(poll.content[0].text, /still running/, "poll remains available to the model");
		assert.deepEqual(resultTool.renderCall({ task_id: id }, plainTheme).render(80), [], "poll title is hidden");
		assert.deepEqual(resultTool.renderResult(poll as Parameters<Registered["renderResult"]>[0], { expanded }, plainTheme).render(80), [], "poll body is hidden");
	}
	assert.match(tools.get("subagent_status")!.renderCall({ task_id: id }, plainTheme).render(80).join(""), /agent status/, "other tools retain their rendering");
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "All done." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	const finished = await resultTool.execute("finished", { task_id: id }, undefined, undefined, ctx);
	assert.equal(finished.content[0].text, "All done.");
	assert.match(resultTool.renderResult(finished as Parameters<Registered["renderResult"]>[0], { expanded: true }, plainTheme).render(80).join("\n"), /agent result.*All done\./s, "completed result remains visible");
	assert.equal(sent.length, 1);
	assert.match(renderers.get("gentle-agents.result")!(sent[0].message, { expanded: true }, plainTheme).render(80).join("\n"), /Agent result.*All done\./s, "background completion card remains visible");
});

test("the Agents widget never registers a sidebar rail part and stays visible even while the fullscreen sidebar owns the host", async () => {
	const { pi, tools, fire } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	// A terminal-bearing host is what makes sidebarPart do anything at all
	// (a host with no .terminal is already a passthrough); this is the host
	// shape the fullscreen layout actually uses.
	const terminalTui = { requestRender() {}, terminal: { columns: 160, rows: 40 } };
	const { ctx, widget } = fakeContext(terminalTui);
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Map lib/", label: "map lib modules", mode: "background" }, undefined, undefined, ctx);
	await tick();

	// The factory only runs (and only then could register a rail part) once
	// something actually renders the widget, exactly like the real host.
	assert.match(widget()![1]!, /explore  map lib modules/);
	const state = sidebarState(terminalTui as unknown as TUI);
	assert.equal(state.parts.has("agents"), false, "Agents never claims a rail slot; the above-editor widget is its only surface");

	// Simulate the fullscreen sidebar actively owning the host, the same
	// condition sidebarPart used to suppress a registered bottom widget under.
	state.active = true;
	state.ownsHost = () => true;
	assert.match(widget()![1]!, /explore  map lib modules/, "the widget keeps rendering regardless of sidebar ownership");
});

test("background runs return at once; status, result, send_message, cancel, and continue follow the task", async () => {
	const { pi, tools, fire, sent, renderers } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const started = await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Long job", mode: "background" }, undefined, undefined, ctx);
	const id = (started.details.gentleAgents as { taskId: string }).taskId;
	assert.match(started.content[0].text, new RegExp(`background as task ${id}`));
	await tick();
	assert.match((await tools.get("subagent_status")!.execute("c2", { task_id: id }, undefined, undefined, ctx)).content[0].text, /running · background/);
	assert.match((await tools.get("subagent_result")!.execute("c3", { task_id: id }, undefined, undefined, ctx)).content[0].text, /still running/);
	assert.match((await tools.get("subagent_send_message")!.execute("c4", { task_id: id, message: "Skip tests" }, undefined, undefined, ctx)).content[0].text, /queued/);
	await tick();
	assert.equal(harness.children[0].written.at(-1)?.message, "Skip tests");
	assert.match((await tools.get("subagent_continue")!.execute("c5", { task_id: id, prompt: "more" }, undefined, undefined, ctx)).content[0].text, /cannot be continued yet/);
	assert.match((await tools.get("subagent_list_tasks")!.execute("c6", {}, undefined, undefined, ctx)).content[0].text, new RegExp(`^${id} · explore · running`));
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "All done." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal((await tools.get("subagent_result")!.execute("c7", { task_id: id }, undefined, undefined, ctx)).content[0].text, "All done.");
	assert.equal(sent.length, 1, "a background result is delivered to the model once");
	assert.equal(sent[0].message.customType, "gentle-agents.result");
	assert.equal(sent[0].message.display, true, "completion cards remain visible");
	// The completion path must never regress to "followUp": the host drains the
	// follow-up queue only when the parent run stops calling tools, which is the
	// hour-long #867 delay. An idle parent stores it and is woken through the
	// normal prompt lifecycle; an active parent keeps the bounded steer route.
	assert.deepEqual(sent[0].options, { triggerTurn: false });
	assert.match(String(sent[0].message.content), new RegExp(`^Subagent explore \\(task ${id}, "Long job"\\) finished\\.\n\nAll done\\.$`));
	const card = renderers.get("gentle-agents.result")!(sent[0].message, { expanded: true }, plainTheme).render(70).map(stripAnsi);
	assert.match(card[0], /^╭─ ❀ Agent result · explore ─+ collapse ╮$/);
	assert.match(card[1], /Subagent explore/);
	assert.match(card[card.length - 2], /All done\./);
	const resumed = tools.get("subagent_continue")!.execute("c8", { task_id: id, prompt: "Now summarize", mode: "task" }, undefined, undefined, ctx);
	await tick();
	const args = harness.spawned[1];
	assert.equal(args[args.indexOf("--session") + 1], "/sessions/child.jsonl");
	await tick();
	harness.children[1].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Summary." }] }] });
	harness.children[1].emit({ type: "agent_settled" });
	const summary = await resumed;
	assert.equal(summary.content[0].text, `Subagent explore (task ${(summary.details.gentleAgents as { taskId: string }).taskId}, "Now summarize") finished.\n\nSummary.`);
	assert.match((await tools.get("subagent_cancel")!.execute("c9", { task_id: id }, undefined, undefined, ctx)).content[0].text, /not running/);
	assert.match((await tools.get("subagent_status")!.execute("c10", { task_id: "nope" }, undefined, undefined, ctx)).content[0].text, /Error: no task nope/);
	// gentle-shell#1713: a guessed id ("1") must point back to real ids.
	// Review follow-up: a call without a context still gets the structured error.
	assert.match((await tools.get("subagent_status")!.execute("c10c", { task_id: "1" }, undefined, undefined, undefined as never)).content[0].text, /^Error: no task 1\./);
	for (const name of ["subagent_status", "subagent_result"]) assert.match((await tools.get(name)!.execute("c10a", { task_id: "1" }, undefined, undefined, ctx)).content[0].text, new RegExp(`^Error: no task 1\\. Recent task ids: .*${id} \\(explore\\)`), name);
	assert.match((await tools.get("subagent_continue")!.execute("c10b", { task_id: "1", prompt: "more" }, undefined, undefined, ctx)).content[0].text, new RegExp(`^Error: no task 1\\. Recent task ids: .*${id} \\(explore\\)`));
	assert.match((await tools.get("subagent_run")!.execute("c11", { agent: "ghost", task: "x" }, undefined, undefined, ctx)).content[0].text, /no subagent named "ghost"\. Known: explore/);
});

test("once the last task is done the card asks for one frame when its finished row expires, so an idle terminal clears it", async () => {
	const { pi, tools, fire } = fakePi();
	const harness = deps();
	let clock = 1000;
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	harness.deps.now = () => clock;
	harness.deps.schedule = (fn, ms) => {
		const timer = { fn, ms, cancelled: false };
		timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	};
	gentleAgents(pi, {}, harness.deps);
	let frames = 0;
	const { ctx, widget } = fakeContext({ requestRender: () => (frames += 1) });
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Short job", mode: "background" }, undefined, undefined, ctx);
	await tick();
	widget();
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.match(widget()![1], /✓  explore  Short job/);
	const expiry = timers.filter((timer) => !timer.cancelled && timer.ms === 60_000);
	assert.equal(expiry.length, 1, "exactly one timer waits for the finished row to leave the card");
	clock += 60_000;
	const before = frames;
	expiry[0].fn();
	assert.equal(frames, before + 1, "the expiry asks the terminal for a frame");
	assert.deepEqual(widget(), [], "the card is gone");
	assert.equal(timers.filter((timer) => !timer.cancelled && timer.ms === 60_000).length, 0, "nothing is rescheduled once the card is empty");
});

test("completionText names the outcome before the answer", () => {
	const base = { id: "t1", agent: "explore", mode: "background", prompt: "p", label: "map lib", cwd: "/r", parentSessionId: "s", status: "failed" as const, createdAt: 1, startedAt: 1, endedAt: 2, model: "m", thinking: undefined, sessionPath: null, error: "pi exited with code 1", result: null, lastStep: "x", lastActivityAt: 2, turns: 0, toolCalls: 0, tokens: 0, cost: 0 };
	assert.equal(completionText(base), 'Subagent explore (task t1, "map lib") failed.\n\nSubagent explore failed: pi exited with code 1');
	assert.equal(completionText({ ...base, status: "timed_out", error: "stalled for 4 min" }), 'Subagent explore (task t1, "map lib") timed out.\n\nSubagent explore timed_out: stalled for 4 min');
});

test("the Agent result card previews the answer or error when collapsed and keeps the full completion text expanded", () => {
	const { pi, renderers } = fakePi();
	gentleAgents(pi, {}, deps().deps);
	const render = renderers.get("gentle-agents.result")!;
	const base = { id: "t1", agent: "explore", mode: "background", prompt: "p", label: "map lib", cwd: "/r", parentSessionId: "s", status: "completed" as const, createdAt: 1, startedAt: 1, endedAt: 2, model: "m", thinking: undefined, sessionPath: null, error: null, result: "All done.", lastStep: "x", lastActivityAt: 2, turns: 0, toolCalls: 0, tokens: 0, cost: 0 };
	const message = (task: typeof base | (Omit<typeof base, "status" | "error"> & { status: "failed"; error: string })) => ({ customType: "gentle-agents.result", content: completionText(task as Parameters<typeof completionText>[0]), details: { gentleAgents: { agent: task.agent, status: task.status } } });
	const taggedTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };

	const done = render(message(base), { expanded: false }, plainTheme).render(80).map(stripAnsi);
	assert.ok(done.length <= 5, "the collapsed card stays bounded");
	assert.match(done[0]!, /^╭─ ❀ Agent result · explore ─+ expand ╮$/);
	assert.match(done[1]!, /^│ All done\. +│$/, "the answer leads the collapsed preview");
	assert.doesNotMatch(done.join("\n"), /Subagent explore \(task/, "the bookkeeping header stays out of the collapsed preview");
	assert.match(render(message(base), { expanded: false }, taggedTheme).render(80)[0]!, /^<success>╭/);

	const failed = { ...base, status: "failed" as const, error: "pi exited with code 1", result: null };
	const failedRows = render(message(failed as never), { expanded: false }, taggedTheme).render(80);
	assert.match(failedRows[0]!, /^<error>╭/, "a failed result keeps the error frame");
	assert.match(stripAnsi(failedRows[1]!.replace(/<\/?[a-z]+>/g, "")), /^│ Subagent explore failed: pi exited with code 1 +│$/, "the error leads the collapsed preview");

	const long = { ...base, result: "one\ntwo\n\nthree\nfour\nfive" };
	const collapsed = render(message(long), { expanded: false }, plainTheme).render(80).map(stripAnsi);
	assert.deepEqual(collapsed.slice(1, -1).map((row) => row.slice(2).trim().replace(/ │$/, "").trim()), ["one", "two", "three"], "three non-blank answer rows");
	assert.match(collapsed.at(-1)!, /^╰─+╯$/);
	const expanded = render(message(long), { expanded: true }, plainTheme).render(80).map(stripAnsi).join("\n");
	assert.match(expanded, /Subagent explore \(task t1, "map lib"\) finished\./, "expanded keeps the header");
	for (const line of ["one", "two", "three", "four", "five"]) assert.match(expanded, new RegExp(`│ ${line} +│`));

	const legacy = { customType: "gentle-agents.result", content: [{ type: "text", text: "Older answer without a header." }], details: { gentleAgents: { agent: "explore", status: "completed" } } };
	assert.match(render(legacy, { expanded: false }, plainTheme).render(80).map(stripAnsi)[1]!, /^│ Older answer without a header\. +│$/, "headerless content falls back to the full text");
	assert.equal(agentResultPreview('Subagent explore (task t1, "x") finished.\n\n'), 'Subagent explore (task t1, "x") finished.\n\n', "a header without an answer keeps the full text");
	assert.equal(agentResultPreview("Plain answer.\n\nMore."), "Plain answer.\n\nMore.");

	for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8, 24]) {
		const rows = render(message(long), { expanded: false }, plainTheme).render(width);
		if (width === 0) assert.deepEqual(rows, []);
		assert.ok(rows.length <= 5, `width ${width} stays within the row budget`);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `width ${width} row fits: ${JSON.stringify(row)}`);
	}
});

test("the Stale agent result card previews its truthful warning when collapsed", () => {
	const { pi, entryRenderers } = fakePi();
	gentleAgents(pi, {}, deps().deps);
	const render = entryRenderers.get("gentle-agents.stale-result")!;
	const entry = { type: "custom", customType: "gentle-agents.stale-result", data: { taskId: "t9", agent: "explore", label: "map lib", status: "completed", ageSeconds: 120 } };
	const collapsed = render(entry, { expanded: false }, plainTheme).render(80).map(stripAnsi);
	assert.ok(collapsed.length > 3 && collapsed.length <= 5, "a bounded multi-row preview");
	assert.match(collapsed[0]!, /^╭─ ❀ Stale agent result · explore · task t9 ─+ expand ╮$/);
	assert.match(collapsed.join("\n"), /Subagent explore \(task t9, "map lib"\) completed about 2m ago/);
	assert.doesNotMatch(collapsed.join("\n"), /All done|Last answer/, "no invented answer");
	assert.match(render(entry, { expanded: false }, { fg: (color: string, text: string) => `<${color}>${text}</${color}>` }).render(80)[0]!, /^<warning>╭/);
	assert.match(render(entry, { expanded: true }, plainTheme).render(80).map(stripAnsi).join("\n"), /subagent_status and subagent_result/);
	assert.deepEqual(render(entry, { expanded: false }, plainTheme).render(0), []);
});

test("a task-mode child's dialog reaches the host UI and the answer goes back to the child", async () => {
	const { pi, tools, fire } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx, dialogs, widget } = fakeContext();
	await fire("session_start", ctx);
	const running = tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Ask me" }, undefined, undefined, ctx);
	await tick();
	harness.children[0].emit({ type: "extension_ui_request", id: "u1", method: "select", title: "Which file?", options: ["a.ts", "b.ts"] });
	await tick();
	await tick();
	assert.deepEqual(dialogs, ["select:❀ Which file?:a.ts|b.ts"]);
	assert.deepEqual(harness.children[0].written.at(-1), { type: "extension_ui_response", id: "u1", value: "a.ts" });
	assert.match(widget()![1], /◐  explore  Ask me/);
	harness.children[0].emit({ type: "agent_end", messages: [] });
	harness.children[0].emit({ type: "agent_settled" });
	await running;
	assert.deepEqual(await answerThroughUi(ctx.ui, { id: "u2", method: "confirm", title: "Sure?" }, { message: "really" }), { confirmed: true });
	assert.deepEqual(await answerThroughUi(ctx.ui, { id: "u3", method: "input", title: "Name" }, {}), { cancelled: true });
	assert.deepEqual(await answerThroughUi(ctx.ui, { id: "u4", method: "editor", title: "Edit" }, {}), { value: "edited" });
	assert.deepEqual(await answerThroughUi(undefined, { id: "u5", method: "select", title: "x" }, {}), { cancelled: true });
});

test("AgentsView production composition observes each pointer event once and accepts only left clicks", async () => {
	const { pi, tools, fire, commands } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx, overlays, customCompletions } = fakeContext();
	await fire("session_start", ctx);

	await tools.get("subagent_run")!.execute("b", { agent: "explore", task: "b", mode: "background" }, undefined, undefined, ctx);
	await tick();
	await tools.get("subagent_run")!.execute("a", { agent: "explore", task: "a", mode: "background" }, undefined, undefined, ctx);
	await tick();

	const originalCreateMouseObserver = NativePointerScope.prototype.createMouseObserver;
	let beforeCalls = 0;
	let afterCalls = 0;
	const spy = mock.method(NativePointerScope.prototype, "createMouseObserver", function (
		this: NativePointerScope,
		requestRender?: () => void,
	) {
		const observer = originalCreateMouseObserver.call(this, requestRender);
		return {
			beforeMouse(event: TuiMouseEvent) {
				beforeCalls += 1;
				observer.beforeMouse(event);
			},
			afterMouse(event: TuiMouseEvent) {
				afterCalls += 1;
				observer.afterMouse(event);
			},
		};
	});
	try {
		const opened = commands.get("gentle:agents")!.handler("", ctx);
		for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
		const overlay = overlays[0];
		assert.ok(overlay, "the production extension mounted its fullscreen interaction");
		overlay.handleInput("a"); // Directory headings remain non-actionable; Current has no wrapper.
		const lines = overlay.render(80);
		const dispatch = (event: TuiMouseEvent) => {
			const before = beforeCalls;
			const after = afterCalls;
			const result = overlay.handleMouse?.(event);
			assert.deepEqual([beforeCalls - before, afterCalls - after], [1, 1], "the root owns one observer lifecycle per event");
			return result;
		};

		assert.match(stripAnsi(overlay.render(80)[1] ?? ""), /Current orchestrator/, "the parent heading is the first visible row");
		assert.doesNotMatch(stripAnsi(overlay.render(80)[1] ?? ""), /▸/, "the heading is not a selected task");
		assert.match(stripAnsi(overlay.render(80)[2] ?? ""), /▸ └ .*Subagent/, "the first child starts selected beneath its heading");
		overlay.handleInput("k");
		overlay.handleInput("s");
		overlay.handleInput("o");
		assert.deepEqual(harness.children.map((child) => child.killed), [[], []], "heading actions never stop a child");
		assert.deepEqual(customCompletions, [], "heading actions never open a child session");
		overlay.handleInput("j");
		assert.equal(dispatch(mouse("click", "right", 4, 3, 80, lines.length)), undefined, "right click is inert");
		assert.match(stripAnsi(overlay.render(80)[2] ?? ""), /▸ └ .*Subagent/, "right click cannot select another child");
		assert.equal(dispatch(mouse("press", "left", 4, 3, 80, lines.length)), undefined, "press is inert");
		assert.equal(dispatch(mouse("click", "middle", 4, 3, 80, lines.length)), undefined, "middle click is inert");
		const leftClick = dispatch(mouse("click", "left", 4, 3, 80, lines.length));
		assert.equal((leftClick as { handled?: boolean } | undefined)?.handled, true, "left click selects a child task");
		assert.match(stripAnsi(overlay.render(80)[3] ?? ""), /▸ └ .*Subagent/, "left click selects the second child");
		overlay.handleInput("\x1b");
		await opened;
	} finally {
		spy.mock.restore();
	}
});

test("AgentsView production footer uses rendered bounds and invalidates them before the next frame", async () => {
	writeFileSync(join(home, ".pi", "agent", "agents", "寿司.md"), "---\ndescription: unicode footer target\nmodel: openai-codex/gpt-5.6-terra\n---\nFooter target.");
	const { pi, tools, fire, commands } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx, overlays, customCompletions } = fakeContext();
	Object.assign(ctx.sessionManager, { getSessionId: () => "footer-session" });
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "寿司", task: "Footer target", mode: "background" }, undefined, undefined, ctx);
	await tick();

	let store: TaskStore | undefined;
	const subscribeSummary = TaskStore.prototype.subscribeSummary;
	const captureStore = mock.method(TaskStore.prototype, "subscribeSummary", function (this: TaskStore, ...args: Parameters<TaskStore["subscribeSummary"]>) {
		store ??= this;
		return subscribeSummary.apply(this, args);
	});
	try {
		const opened = commands.get("gentle:agents")!.handler("", ctx);
		for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
		const overlay = overlays[0];
		assert.ok(overlay, "the production extension mounted its fullscreen interaction");
		assert.ok(store, "the overlay subscribed to the production task store");
		const selected = store.list().find((entry) => entry.parentSessionId === "footer-session");
		assert.ok(selected?.sessionPath, "the selected unicode task initially has an openable session");
		for (let index = 0; index < 12; index += 1) store.apply(selected.id, { type: TASK_EVENT.TEXT, text: `line ${index}\n` }, 2000 + index);

		const buttons = (lines: string[], label: string) => {
			const footer = lines.at(-2) ?? "";
			const start = footer.indexOf(label);
			assert.ok(start > 0, `the roomy footer exposes ${label}`);
			return { x: visibleWidth(footer.slice(0, start)), y: lines.length - 2 };
		};
		let lines = overlay.render(160).map(stripAnsi);
		let follow = buttons(lines, "[ Follow ]");
		let open = buttons(lines, "[ Open session ]");
		assert.match(lines[1] ?? "", /寿司/, "a unicode task remains inside the body, not the header or footer");
		assert.match(lines[follow.y] ?? "", /s Stop selected.*a all sessions/, "the existing stop and scope shortcuts remain beside the footer buttons");
		assert.match(overlay.render(59).map(stripAnsi).at(-2) ?? "", /\[Scope\]/, "the narrow list keeps mouse-accessible scope controls");
		lines = overlay.render(160).map(stripAnsi);
		follow = buttons(lines, "[ Follow ]");
		open = buttons(lines, "[ Open session ]");
		assert.equal(overlay.handleMouse?.(mouse("click", "left", follow.x, 0, 160, lines.length)), undefined, "header coordinates never route to a footer button");
		assert.equal(overlay.handleMouse?.(mouse("click", "left", follow.x, follow.y - 1, 160, lines.length)), undefined, "body coordinates never route to a footer button");
		assert.equal(overlay.handleMouse?.(mouse("press", "left", follow.x, follow.y, 160, lines.length)), undefined, "press is inert");
		assert.equal(overlay.handleMouse?.(mouse("click", "right", follow.x, follow.y, 160, lines.length)), undefined, "right click is inert");
		assert.equal(overlay.handleMouse?.(mouse("click", "middle", follow.x, follow.y, 160, lines.length)), undefined, "middle click is inert");
		assert.equal((overlay.handleMouse?.(mouse("move", "none", follow.x, follow.y, 160, lines.length)) as { handled?: boolean } | undefined)?.handled, true, "hover does not activate Follow");

		overlay.handleInput("\x1b[5~");
		assert.equal((overlay.handleMouse?.(mouse("click", "left", follow.x, follow.y, 160, lines.length)) as { handled?: boolean } | undefined)?.handled, true, "Follow restores tail tracking");
		assert.equal((overlay.handleMouse?.(mouse("click", "left", follow.x, follow.y, 160, lines.length)) as { handled?: boolean } | undefined)?.handled, true, "repeated Follow remains enabled instead of toggling off");
		store.apply(selected.id, { type: TASK_EVENT.TEXT, text: "line 12\n" }, 2012);
		lines = overlay.render(160).map(stripAnsi);
		assert.ok(lines.some((line) => /line 12/.test(line)), "Follow keeps the stream at its tail after manual scrolling");
		follow = buttons(lines, "[ Follow ]");
		open = buttons(lines, "[ Open session ]");
		assert.equal((overlay.handleMouse?.(mouse("click", "left", open.x, open.y, 160, lines.length)) as { handled?: boolean } | undefined)?.handled, true, "Open delegates exactly one eligible click to the existing callback");
		assert.equal(customCompletions.length, 1, "Open completes the actual ui.custom callback exactly once");
		const openedTask = customCompletions[0] as TaskRecord | undefined;
		assert.equal(openedTask?.id, selected.id, "Open completes ui.custom with the selected task before Escape");
		assert.equal(openedTask?.sessionPath, selected.sessionPath, "Open preserves the selected task's openable session in the ui.custom result");

		store.update(selected.id, { sessionPath: null });
		assert.equal(overlay.handleMouse?.(mouse("click", "left", follow.x, follow.y, 160, lines.length)), undefined, "a selected task update makes old footer coordinates inert until render");
		lines = overlay.render(160).map(stripAnsi);
		follow = buttons(lines, "[ Follow ]");
		overlay.handleInput("a");
		assert.equal(overlay.handleMouse?.(mouse("click", "left", follow.x, follow.y, 160, lines.length)), undefined, "a scope change makes old footer coordinates inert until render");
		overlay.handleInput("\x1b");
		await opened;
	} finally {
		captureStore.mock.restore();
	}
});

test("a task that finishes live stays visible as history, in both scopes, and its result also resolves after a restart", async () => {
	const { pi, tools, fire, commands, shortcuts } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx, overlays } = fakeContext();
	await fire("session_start", ctx);
	const started = await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Persist me", mode: "background" }, undefined, undefined, ctx);
	const id = (started.details.gentleAgents as { taskId: string }).taskId;
	await tick();
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Kept." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	const tasksDir = join(home, ".pi", "agent", "gentle-agents", "tasks");
	let stored = await loadHistory(tasksDir);
	for (let attempt = 0; attempt < 40 && !stored.some((entry) => entry.task.id === id); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		stored = await loadHistory(tasksDir);
	}
	assert.ok(stored.some((entry) => entry.task.id === id && entry.task.result === "Kept."), "the finished task is on disk");

	// A completely different session still resolves it by id on demand, with
	// nothing restored in advance.
	const fresh = fakePi();
	gentleAgents(fresh.pi, {}, deps().deps);
	const again = fakeContext();
	await fresh.fire("session_start", again.ctx);
	assert.equal((await fresh.tools.get("subagent_result")!.execute("c2", { task_id: id }, undefined, undefined, again.ctx)).content[0].text, "Kept.");

	// Back in the session where it actually finished, it stays listed as
	// history -- in the current-session view and under "all sessions" too.
	assert.ok(commands.has("gentle:agents") && shortcuts.has("alt+a"));
	const opened = commands.get("gentle:agents")!.handler("", ctx);
	for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
	const overlay = overlays[0];
	assert.ok(overlay, "the overlay component was created");
	assert.match(overlay.render(80).map(stripAnsi).join("\n"), /finished|Subagent explore/, "the task that finished in this session stays visible as history");
	overlay.handleInput("a");
	overlay.handleInput("\x1b[C");
	assert.match(overlay.render(80).map(stripAnsi).join("\n"), /Subagent explore/, "the current session's own history shows under all sessions too");
	overlay.handleInput("\x1b");
	await opened;
});

test("the overlay confirms a running task once and reports when it finishes during confirmation", async () => {
	const { pi, tools, fire, commands, sent } = fakePi();
	const harness = deps();
	const modalHome = join(root, "modal-home");
	mkdirSync(join(modalHome, ".pi", "agent", "agents"), { recursive: true });
	writeFileSync(join(modalHome, ".pi", "agent", "agents", "explore.md"), "---\ndescription: maps things\nmodel: openai-codex/gpt-5.6-terra\n---\nYou map things.");
	writeFileSync(join(modalHome, ".pi", "agent", "subagents.json"), JSON.stringify({ max_concurrency: 2 }));
	harness.deps.home = modalHome;
	let answerConfirmation: (confirmed: boolean) => void = () => {};
	gentleAgents(pi, {}, harness.deps);
	const { ctx, dialogs, overlays } = fakeContext(fakeTui, () => new Promise((resolve) => {
		answerConfirmation = resolve;
	}));
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Race", mode: "background" }, undefined, undefined, ctx);
	await tick();
	const opened = commands.get("gentle:agents")!.handler("", ctx);
	for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
	const overlay = overlays[0];
	assert.ok(overlay, "the overlay component was created");
	overlay.handleInput("s");
	overlay.handleInput("c");
	await tick();
	assert.deepEqual(dialogs, ["confirm:Stop explore?:Current work may be incomplete."], "s and its compatibility alias share one confirmation");
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Finished first." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	answerConfirmation(true);
	await tick();
	assert.match(dialogs.at(-1) ?? "", /^notify:Task explore already finished\.$/);
	assert.equal(sent.length, 1, "a normal completion during confirmation still reaches the parent");
	overlay.handleInput("\x1b");
	await opened;
});

test("the overlay stops a queued selection immediately without confirmation", async () => {
	const { pi, tools, fire, commands } = fakePi();
	const harness = deps();
	const queueHome = join(root, "queue-home");
	mkdirSync(join(queueHome, ".pi", "agent", "agents"), { recursive: true });
	writeFileSync(join(queueHome, ".pi", "agent", "agents", "explore.md"), "---\ndescription: maps things\n---\nYou map things.");
	writeFileSync(join(queueHome, ".pi", "agent", "subagents.json"), JSON.stringify({ max_concurrency: 1 }));
	harness.deps.home = queueHome;
	gentleAgents(pi, {}, harness.deps);
	const { ctx, dialogs, overlays } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "First", mode: "background" }, undefined, undefined, ctx);
	await tick();
	const queued = await tools.get("subagent_run")!.execute("c2", { agent: "explore", task: "Queued", mode: "background" }, undefined, undefined, ctx);
	const queuedId = (queued.details.gentleAgents as { taskId: string }).taskId;
	const opened = commands.get("gentle:agents")!.handler("", ctx);
	for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
	overlays[0]!.handleInput("s");
	await tick();
	assert.deepEqual(dialogs, ["notify:Stopped explore."], "queued work stops without confirmation");
	assert.match((await tools.get("subagent_status")!.execute("c3", { task_id: queuedId }, undefined, undefined, ctx)).content[0].text, /cancelled/);
	overlays[0]!.handleInput("\x1b");
	await opened;
});

test("the overlay explains that stopping a waiting subagent dismisses its question", async () => {
	const { pi, tools, fire, commands } = fakePi();
	const harness = deps();
	const waitingHome = join(root, "waiting-home");
	mkdirSync(join(waitingHome, ".pi", "agent", "agents"), { recursive: true });
	writeFileSync(join(waitingHome, ".pi", "agent", "agents", "explore.md"), "---\ndescription: maps things\n---\nYou map things.");
	harness.deps.home = waitingHome;
	let answerInput: (value: string | undefined) => void = () => {};
	gentleAgents(pi, {}, harness.deps);
	const { ctx, dialogs, overlays } = fakeContext(fakeTui, async () => true, () => new Promise<string | undefined>((resolve) => {
		answerInput = resolve;
	}));
	await fire("session_start", ctx);
	const running = tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Ask", mode: "task" }, undefined, undefined, ctx);
	await tick();
	harness.children[0].emit({ type: "extension_ui_request", id: "wait", method: "input", title: "Need input" });
	await tick();
	const opened = commands.get("gentle:agents")!.handler("", ctx);
	for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
	overlays[0]!.handleInput("s");
	await tick();
	assert.ok(dialogs.includes("confirm:Stop explore?:Its pending question will be dismissed."));
	assert.match((await running).content[0].text, /cancelled/);
	answerInput(undefined);
	overlays[0]!.handleInput("\x1b");
	await opened;
});

test("restored task history cannot enter the live panel or discovery during synchronous summary callbacks", async (t) => {
	const { pi, fire, commands, tools } = fakePi();
	const harness = deps();
	const historyHome = join(root, "history-home");
	const historical: TaskRecord = { id: "history-running", agent: "explore", mode: "background", prompt: "p", label: "p", cwd, parentSessionId: "s1", status: TASK_STATUS.RUNNING, createdAt: 1, startedAt: 1, endedAt: null, model: "m", thinking: undefined, sessionPath: null, error: null, result: null, lastStep: "working", lastActivityAt: 1, turns: 0, toolCalls: 0, tokens: 0, cost: 0 };
	harness.deps.home = historyHome;
	const profile = liveProfile("restored-discovery");
	await saveTask(historyDir(historyHome, profile), historical, emptyThread());
	chmodSync(join(profile, "gentle-agents"), 0o755);
	harness.deps.agentHome = profile;
	const registry = { list: async () => [], listActivations: async () => [] };
	harness.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: (_, sessionId) => ({ registry, record: { version: 1, sessionId, endpoint: "/fixture/restore", createdAt: 1 }, start: async () => {}, close: async () => {} }),
		createClient: inertSessionTransport.createClient,
	};
	let checked = false;
	let leaked: unknown;
	const update = PresencePublisher.prototype.update;
	let snapshot: unknown;
	t.mock.method(PresencePublisher.prototype, "update", function (this: PresencePublisher, input: Parameters<PresencePublisher["update"]>[0]) {
		snapshot = input.map(row => row.task.id);
		return update.call(this, input);
	});
	const restore = TaskStore.prototype.restore;
	t.mock.method(TaskStore.prototype, "restore", function (this: TaskStore, ...args: Parameters<TaskStore["restore"]>) {
		const result = restore.apply(this, args);
		leaked = snapshot;
		checked = true;
		return result;
	});
	gentleAgents(pi, {}, harness.deps);
	const { ctx, dialogs, overlays } = fakeContext();
	await fire("session_start", ctx);
	await tick();
	await fire("session_start", ctx, { reason: "resume" });
	await eventually(() => checked, "restoration callback checked");
	assert.deepEqual(leaked, [], "summary callback must not publish restored running history");
	assert.deepEqual(readDiscovery(profile, listPresence(profile).entries[0])?.tasks, []);
	const opened = commands.get("gentle:agents")!.handler("", ctx);
	for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.doesNotMatch(stripAnsi(overlays[0]!.render(80).join("\n")), /Stop selected|Subagent explore/);
	overlays[0]!.handleInput("s");
	overlays[0]!.handleInput("c");
	await tick();
	assert.deepEqual(dialogs, []);
	overlays[0]!.handleInput("\x1b");
	await opened;
});

// A1 (odd/tasks/usage-click-and-changes-attribution.md): resuming a session
// brings its own finished subagents back as visible history, never another
// session's, and a brand-new session starts with none restored.
test("resuming a session restores its own finished tasks as history, never another session's", async () => {
	const { pi, fire, commands } = fakePi();
	const harness = deps();
	const historyHome = join(root, "resume-history-home");
	const base: TaskRecord = { id: "own-1", agent: "explore-a", mode: "background", prompt: "p", label: "p", cwd, parentSessionId: "resumed-session", status: TASK_STATUS.COMPLETED, createdAt: 1, startedAt: 1, endedAt: 100, model: "m", thinking: undefined, sessionPath: null, error: null, result: "done", lastStep: "responded", lastActivityAt: 100, turns: 1, toolCalls: 0, tokens: 0, cost: 0 };
	const own1 = base;
	const own2: TaskRecord = { ...base, id: "own-2", agent: "explore-b", status: TASK_STATUS.FAILED, endedAt: 200, error: "boom", result: null };
	const other: TaskRecord = { ...base, id: "not-mine", agent: "explore-other", parentSessionId: "other-session" };
	await saveTask(historyDir(historyHome), own1, emptyThread());
	await saveTask(historyDir(historyHome), own2, emptyThread());
	await saveTask(historyDir(historyHome), other, emptyThread());
	harness.deps.home = historyHome;
	gentleAgents(pi, {}, harness.deps);
	const { ctx, overlays } = fakeContext();
	ctx.sessionManager.getSessionId = () => "resumed-session";
	await fire("session_start", ctx, { reason: "resume" });
	const opened = commands.get("gentle:agents")!.handler("", ctx);
	for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
	// The disk history read behind restoreSessionHistory is fire-and-forget,
	// so poll the overlay's own render output instead of sleeping a guess.
	const rendered = await waitForOverlayMatch(() => stripAnsi(overlays[0]!.render(100).join("\n")), /Subagent explore-a/);
	assert.match(rendered, /Subagent explore-a/, "the resumed session's own finished task is restored");
	assert.match(rendered, /Subagent explore-b/, "a second finished task of the same session is restored too");
	assert.doesNotMatch(rendered, /explore-other/, "another session's finished task never restores here");
	overlays[0]!.handleInput("\x1b");
	await opened;
	await fire("session_shutdown", ctx);

	const { pi: freshPi, fire: freshFire, commands: freshCommands } = fakePi();
	gentleAgents(freshPi, {}, harness.deps);
	const { ctx: freshCtx, overlays: freshOverlays } = fakeContext();
	freshCtx.sessionManager.getSessionId = () => "brand-new-session";
	await freshFire("session_start", freshCtx, { reason: "new" });
	await tick();
	const freshOpened = freshCommands.get("gentle:agents")!.handler("", freshCtx);
	for (let attempt = 0; attempt < 40 && freshOverlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.doesNotMatch(stripAnsi(freshOverlays[0]!.render(100).join("\n")), /explore/, "a brand-new session restores nothing");
	freshOverlays[0]!.handleInput("\x1b");
	await freshOpened;
	await freshFire("session_shutdown", freshCtx);
});

// A1 follow-up: Pi reports "startup" (not "resume") when the CLI is launched
// directly into an existing session file (--continue / --resume picker,
// agent-session.js:152) -- "resume" is only the in-session /resume switch.
// A startup into a session that already has entries must restore its history
// too; a "startup" with no entries (nothing pre-existing to restore) must not.
test("starting up into an existing session also restores its own finished history; a startup with no prior entries does not", async () => {
	const historyHome = join(root, "startup-history-home");
	const finished: TaskRecord = { id: "startup-1", agent: "explore-startup", mode: "background", prompt: "p", label: "p", cwd, parentSessionId: "startup-session", status: TASK_STATUS.COMPLETED, createdAt: 1, startedAt: 1, endedAt: 100, model: "m", thinking: undefined, sessionPath: null, error: null, result: "done", lastStep: "responded", lastActivityAt: 100, turns: 1, toolCalls: 0, tokens: 0, cost: 0 };
	await saveTask(historyDir(historyHome), finished, emptyThread());

	{
		// Startup into a session file that already has entries: restores.
		const { pi, fire, commands } = fakePi();
		const harness = deps();
		harness.deps.home = historyHome;
		gentleAgents(pi, {}, harness.deps);
		const { ctx, overlays } = fakeContext();
		ctx.sessionManager.getSessionId = () => "startup-session";
		ctx.sessionManager.getEntries = (() => [{ type: "message" }]) as typeof ctx.sessionManager.getEntries;
		await fire("session_start", ctx, { reason: "startup" });
		const opened = commands.get("gentle:agents")!.handler("", ctx);
		for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
		// The disk history read behind restoreSessionHistory is fire-and-forget,
		// so poll the overlay's own render output instead of sleeping a guess.
		const rendered = await waitForOverlayMatch(() => stripAnsi(overlays[0]!.render(100).join("\n")), /Subagent explore-startup/);
		assert.match(rendered, /Subagent explore-startup/, "startup into an existing session restores its own finished history");
		overlays[0]!.handleInput("\x1b");
		await opened;
		await fire("session_shutdown", ctx);
	}
	{
		// Startup reported for a session with no prior entries: nothing to
		// restore, even though the reason is "startup" and the id matches.
		const { pi, fire, commands } = fakePi();
		const harness = deps();
		harness.deps.home = historyHome;
		gentleAgents(pi, {}, harness.deps);
		const { ctx, overlays } = fakeContext();
		ctx.sessionManager.getSessionId = () => "startup-session";
		await fire("session_start", ctx, { reason: "startup" });
		// getEntries defaults to [] here, so preexisting is false and
		// restoreSessionHistory never runs -- nothing to wait for beyond
		// letting the already-fired session_start handler settle.
		await tick();
		const opened = commands.get("gentle:agents")!.handler("", ctx);
		for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.doesNotMatch(stripAnsi(overlays[0]!.render(100).join("\n")), /explore-startup/, "a startup report with no prior entries restores nothing");
		overlays[0]!.handleInput("\x1b");
		await opened;
		await fire("session_shutdown", ctx);
	}
});

test("Alt+S confirms a snapshot of active subagents and suppresses their follow-up delivery", async () => {
	const { pi, tools, fire, shortcuts, sent } = fakePi();
	const harness = deps();
	let answerConfirmation: (confirmed: boolean) => void = () => {};
	gentleAgents(pi, {}, harness.deps);
	const { ctx, dialogs } = fakeContext(fakeTui, () => new Promise<boolean>((resolve) => {
		answerConfirmation = resolve;
	}));
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "First", mode: "background" }, undefined, undefined, ctx);
	await tick();
	const shortcut = shortcuts.get("alt+s");
	assert.ok(shortcut, "Alt+S is registered by default");
	assert.equal(shortcut.description, "Stop active subagent(s)");
	const stopping = shortcut.handler(ctx);
	await tick();
	await tools.get("subagent_run")!.execute("c2", { agent: "explore", task: "Second", mode: "background" }, undefined, undefined, ctx);
	await tick();
	answerConfirmation(true);
	await stopping;
	assert.deepEqual(dialogs, ["confirm:Stop 1 active subagent?:Only these 1 subagent will stop. Current work may be incomplete.", "notify:Stopped 1 subagent."]);
	assert.equal(sent.length, 0, "intentional cancellation does not start a follow-up turn");
	assert.match((await tools.get("subagent_list_tasks")!.execute("c3", {}, undefined, undefined, ctx)).content[0].text, /running/, "a subagent started during confirmation remains active");
	const secondConfirmation = shortcut.handler(ctx);
	await tick();
	assert.match(dialogs.at(-1) ?? "", /^confirm:Stop 1 active subagent\?/);
	answerConfirmation(false);
	await secondConfirmation;
	await fire("session_shutdown", ctx);
});

test("the card follows the active session: after /new the earlier session's tasks leave it, and come back on /resume", async () => {
	const { pi, tools, commands, fire } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx, widget, overlays } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Long job", mode: "background" }, undefined, undefined, ctx);
	await tick();
	assert.match(widget()![1], /◐  explore  Long job/);
	const sessions = ctx as unknown as { sessionManager: { getSessionId(): string; getCwd(): string; getBranch(): []; getEntries(): []; getSessionFile(): undefined } };
	sessions.sessionManager = { getSessionId: () => "s2", getCwd: () => cwd, getBranch: () => [], getEntries: () => [], getSessionFile: () => undefined };
	await fire("session_start", ctx, { type: "session_start", reason: "new" });
	assert.deepEqual(widget(), [], "the new session starts with an empty card");
	assert.match((await tools.get("subagent_list_tasks")!.execute("c2", {}, undefined, undefined, ctx)).content[0].text, /No subagent tasks in this session/);
	const opened = commands.get("gentle:agents")!.handler("", ctx);
	for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
	const overlay = overlays[0]!;
	assert.match(stripAnsi(overlay.render(80)[0]), /this session · 0 active/, "the overlay opens on the active session");
	overlay.handleInput("a");
	assert.doesNotMatch(overlay.render(80).map(stripAnsi).join("\n"), /◐ Subagent explore/, "retained children of a replaced session do not imply an open orchestrator");
	overlay.handleInput("\x1b");
	await opened;
	sessions.sessionManager = { getSessionId: () => "s1", getCwd: () => cwd, getBranch: () => [], getEntries: () => [], getSessionFile: () => undefined };
	await fire("session_start", ctx, { type: "session_start", reason: "resume" });
	assert.match(widget()![1], /◐  explore  Long job/, "resuming the first session shows its task again");
});

test("the card caps its rows to the terminal height and says how many tasks are hidden", async () => {
	const { pi, tools, fire } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx, widget } = fakeContext({ requestRender() {}, terminal: { rows: 20 } } as { requestRender(): void });
	await fire("session_start", ctx);
	for (let index = 0; index < 6; index += 1) await tools.get("subagent_run")!.execute(`c${index}`, { agent: "explore", task: `Job ${index}`, label: `job ${index}`, mode: "background" }, undefined, undefined, ctx);
	await tick();
	const card = widget()!;
	assert.equal(card.length, 8, "a 20-row terminal gets five card rows (four tasks and the overflow line) inside the frame, then the spacer");
	assert.match(card[0], /2 active · 4 queued/);
	assert.match(card[5], /^│ … 2 more · alt\+a to view +│$/);
});

test("the production overlay reads terminal rows at render time without a minimum-height override", async () => {
	const { pi, fire, commands } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	let rows = 10;
	const overlayTui = { terminal: { get rows() { return rows; } }, requestRender() {} };
	const { ctx, overlays, customOptions } = fakeContext(fakeTui, async () => true, async () => undefined, overlayTui);
	await fire("session_start", ctx);
	const opened = commands.get("gentle:agents")!.handler("", ctx);
	for (let attempt = 0; attempt < 40 && overlays.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
	const overlay = overlays[0]!;
	assert.deepEqual(customOptions[0], { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } });
	assert.equal(overlay.render(80).length, 10, "the overlay uses the full terminal height");
	rows = 5;
	assert.equal(overlay.render(80).length, 5, "a live terminal resize changes the production frame budget");
	rows = 2;
	assert.equal(overlay.render(80).length, 1, "tiny terminals retain bounded controls rather than forced chrome");
	overlay.handleInput("\x1b");
	await opened;
});


test("default session transport selects Windows or POSIX classes without mutating the process platform", () => {
	const registry = {} as never;
	const onNotification = async () => {};
	const windows = createDefaultSessionTransport("win32");
	assert.ok(windows.createListener(registry, "s1", onNotification) instanceof WindowsActiveSessionListener);
	assert.ok(windows.createClient(registry, "s1") instanceof WindowsActiveSessionClient);
	const posix = createDefaultSessionTransport("linux");
	assert.ok(posix.createListener(registry, "s1", onNotification) instanceof ActiveSessionListener);
	assert.ok(posix.createClient(registry, "s1") instanceof ActiveSessionClient);
	assert.equal(posix.createRegistry, createDefaultSessionTransport("darwin").createRegistry);
	assert.equal(windows.createRegistry, createDefaultSessionTransport("win32").createRegistry);
	assert.notEqual(windows.createRegistry, posix.createRegistry);
});

test("session transport startup failure cleans the constructed Windows-capable transport and stays unavailable", async () => {
	const h = fakePi();
	const runtime = deps();
	let registryCloses = 0;
	let listenerCloses = 0;
	let clientCloses = 0;
	const registry = {
		list: async () => [],
		listActivations: async () => [],
		close: async () => { registryCloses += 1; },
	};
	const transport: SessionTransportFactory = {
		createRegistry: async () => registry,
		createListener: () => ({
			registry,
			start: async () => { throw new Error("unavailable"); },
			close: async () => { listenerCloses += 1; },
		}),
		createClient: () => ({
			close: () => { clientCloses += 1; },
			sendNotification: async () => ({ id: "unused", accepted: true }),
		}),
	};
	runtime.deps.sessionTransport = transport;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await eventually(() => clientCloses === 1 && listenerCloses === 1 && registryCloses === 1, "startup failure cleanup completes");
	assert.equal(clientCloses, 1);
	assert.equal(listenerCloses, 1);
	assert.equal(registryCloses, 1);
	assert.match((await h.tools.get("orchestrator_session_id")!.execute("id", {}, undefined, undefined, ctx)).content[0].text, /not ready/);
});

test("registered session identity declares subjects and refreshes canonical idle renames", async (t) => {
	const h = fakePi();
	const runtime = deps();
	const profile = realpathSync(mkdtempSync(join(root, "subject-runtime-")));
	runtime.deps.agentHome = profile;
	let ready = false;
	const registry = { list: async () => [], listActivations: async () => [] };
	runtime.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: (_registry, sessionId) => ({ registry,
			record: { version: 1 as const, sessionId, endpoint: "/fixture/subject.sock", createdAt: 1 },
			start: async () => { ready = true; }, close: async () => {} }),
		createClient: () => ({ close() {}, sendNotification: async () => { throw new Error("no messages expected"); } }),
	};
	const heartbeats: (() => void)[] = [];
	const interval = globalThis.setInterval;
	t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => {
		if (ms === 5000) heartbeats.push(callback);
		return interval(callback, ms);
	});
	let name = "";
	const names: string[] = [];
	Object.assign(h.pi, { setSessionName: (value: string) => { name = value; names.push(value); } });
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	const registrations = [{ type: "custom", customType: SESSION_WORKTREE_ENTRY, data: { sessionId: "s1", root: cwd, evidence: "fixture" } }];
	Object.assign(ctx.sessionManager, { getSessionName: () => name, getEntries: () => registrations });
	await h.fire("session_start", ctx);
	await eventually(() => ready, "subject transport ready");
	const tool = h.tools.get("orchestrator_session_id")!;
	const declare = (subject?: unknown, context = ctx) => tool.execute("id", { subject }, undefined, undefined, context);
	const initialWrites = h.entries.length;
	await assert.rejects(() => tool.execute("invalid-work", { subject: "No effect", state: { work: { topic: "Login" } } }, undefined, undefined, ctx), /invalid/);
	assert.equal(name, "");
	assert.equal(h.entries.length, initialWrites);
	assert.equal(readDiscovery(profile, listPresence(profile).entries[0])?.state, undefined);
	const result = await declare("\u001b[31m Fix\n auth\u202e ");
	assert.equal(name, "Fix auth");
	assert.match(result.content[0].text, /Active session ID: s1.*\n.*Fix auth/);
	assert.deepEqual(result.details.gentleAgents, { senderSessionId: "s1", alias: "Fix auth" });
	const before = listPresence(profile).entries[0]!;
	assert.equal(before.label, "Fix auth");
	assert.equal(readDiscovery(profile, before)?.state, undefined, "no implicit summary");
	Object.assign(ctx.sessionManager, { getBranch: () => h.entries });
	const work = { area: "Auth", topic: "Login", tags: ["Review"], refs: [
		{ kind: "issue", repository: "github.com/Owner/Repo", id: "12" },
	] };
	await tool.execute("publish", { state: { objective: "Verify auth", decisions: "Advisory only", work } }, undefined, undefined, ctx);
	assert.equal(readDiscovery(profile, listPresence(profile).entries[0])?.state?.state?.objective, "Verify auth");
	assert.deepEqual(readDiscovery(profile, listPresence(profile).entries[0])?.state?.state?.work, work);
	const published = h.entries.at(-1)!;
	const writes = h.entries.length;
	await assert.rejects(() => tool.execute("invalid", { subject: "No effect", state: { grant: "yes" } }, undefined, undefined, ctx), /invalid/);
	assert.equal(h.entries.length, writes);
	assert.equal(name, "Fix auth");
	await declare();
	assert.equal(h.entries.length, writes, "omission leaves notes unchanged");
	assert.equal(readDiscovery(profile, before)?.workspace, cwd);
	assert.equal(readDiscovery(profile, before)?.scope?.host.root, cwd);
	assert.equal(readDiscovery(profile, before)?.scope?.registered[0]?.root, cwd);
	name = "Human rename";
	heartbeats[0](); // Existing publisher heartbeat, without any task/model activity.
	const renamed = listPresence(profile).entries[0]!;
	assert.equal(renamed.label, name);
	assert.equal(renamed.generation, before.generation);
	assert.deepEqual(readActivity(profile, renamed).activity?.tasks, []);
	assert.equal(readDiscovery(profile, renamed)?.scope?.host.resolvedAt, readDiscovery(profile, before)?.scope?.host.resolvedAt);
	registrations.push({ ...registrations[0], data: { ...registrations[0].data, root: join(cwd, "registered") } });
	h.pi.events.emit(SESSION_WORKTREE_CHANGED, { sessionId: "s1" });
	assert.deepEqual(readDiscovery(profile, listPresence(profile).entries[0])?.scope?.registered.map(fact => fact.root), [cwd, join(cwd, "registered")]);
	await declare("Do not overwrite");
	assert.deepEqual(names, ["Fix auth"]);
	assert.match((await declare()).content[0].text, /Human rename/);
	name = "";
	await declare("\u0000\u001b[31m");
	assert.equal(name, "", "control-only subject never names a session");
	await declare("😀".repeat(130));
	assert.equal(Array.from(name).length, 120);
	await tool.execute("withdraw", { state: null }, undefined, undefined, ctx);
	await h.fire("session_start", ctx, { reason: "reload" });
	await eventually(() => readDiscovery(profile, listPresence(profile).entries[0])?.state?.state === null, "withdrawal reload");
	Object.assign(ctx.sessionManager, { getBranch: () => [published] });
	await h.fire("session_tree", ctx);
	assert.equal(readDiscovery(profile, listPresence(profile).entries[0])?.state?.state?.objective, "Verify auth");
	const sameId = fakeContext().ctx;
	Object.assign(sameId.sessionManager, { getSessionName: () => name, getBranch: () => [] });
	await h.fire("session_start", sameId, { reason: "resume" });
	assert.equal(readDiscovery(profile, listPresence(profile).entries[0])?.state, undefined);
	const replacement = fakeContext().ctx;
	Object.assign(replacement.sessionManager, { getSessionId: () => "s2", getSessionName: () => "Replacement" });
	await h.fire("session_start", replacement, { reason: "new" });
	heartbeats[0]();
	assert.equal(listPresence(profile).entries.length, 1);
	assert.equal(listPresence(profile).entries[0].label, "Replacement");
	assert.equal(readDiscovery(profile, listPresence(profile).entries[0])?.scope?.host.root, cwd);
	const stale = await declare("Stale subject", ctx);
	assert.match(stale.content[0].text, /not ready/);
	assert.equal(names.length, 2);
	assert.equal(runtime.spawned.length, 0);
	assert.equal(h.sent.length, 0);
	assert.equal(h.userMessages.length, 0);
});

test("registered orchestrator_list joins peer metadata without child launches or messages", async () => {
	const h = fakePi();
	const runtime = deps();
	const profile = realpathSync(mkdtempSync(join(root, "discovery-runtime-")));
	const peer = { version: 1 as const, sessionId: "peer", endpoint: "/fixture/peer.sock", createdAt: 1 };
	const publisher = PresencePublisher.start({ profile, sessionId: "peer", label: "Auth review", activity: [] });
	try {
		const scope = new OrchestratorScopeCache(path => ({ root: path, commonDir: "/clone" })).project("/repo", [{ id: "child", cwd: "/repo-child" }], ["/repo"]);
		const tasks = [{ id: "child", label: "Check auth", status: "waiting", cwd: "/repo-child" },
			...Array.from({ length: 9 }, (_, i) => ({ id: `extra${i}`, label: `Extra ${i}`, status: "running", cwd: `/child/${i}` }))];
		publisher.updateDiscovery(peer, { workspace: "/repo", tasks, registered: Array.from({ length: 10 }, (_, i) => `/registered/${i}`), scope,
			state: { schema: 2, sessionId: "peer", cwd: "/repo", recordedAt: 1, source: "owner-curated",
				ownerReply: false, authority: "none", state: { work: { tasks: { child: { area: "Auth" }, extra8: { area: "Billing" } } } } },
		});
		let ready = false;
		let probes = 0;
		const resolveWorktree = runtime.deps.resolveWorktree;
		runtime.deps.resolveWorktree = (...args) => { probes++; return resolveWorktree(...args); };
		let gate: (() => Promise<void>) | undefined;
		let scans = 0;
		const registry = { list: async () => [], listActivations: async () => { scans++; await gate?.(); return [peer]; } };
		runtime.deps.agentHome = profile;
		runtime.deps.sessionTransport = {
			createRegistry: async () => registry,
			createListener: () => ({ registry, start: async () => { ready = true; }, close: async () => {} }),
			createClient: () => ({ close() {}, sendNotification: async () => { throw new Error("no messages expected"); } }),
		};
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		await h.fire("session_start", ctx);
		await eventually(() => ready, "discovery transport ready");
		ctx.ui.select = async () => { throw new Error("metadata consultation must not ask for consent"); };
		const result = await h.tools.get("orchestrator_list")!.execute("list", {}, undefined, undefined, ctx);
		assert.match(result.content[0].text, /peer.*Auth review.*recorded workspace: \/repo/);
		assert.match(result.content[0].text, /Check auth \[waiting\].*launch workspace: \/repo-child/);
		assert.match(result.content[0].text, /reachability is unknown/);
		assert.equal((result.details.gentleAgents as any).candidates[0].scope.host.root, "/repo");
		assert.equal((result.details.gentleAgents as any).candidates[0].scope.tasks[0].repository.root, "/repo-child");
		assert.match(result.content[0].text, /clone: [a-f0-9]{64}/);
		const cursor = (result.details.gentleAgents as any).candidates[0].catalog.cursor;
		const next = await h.tools.get("orchestrator_list")!.execute("next", { recipient_session_id: "peer", cursor }, undefined, undefined, ctx);
		assert.deepEqual((next.details.gentleAgents as any).candidates[0].catalog.tasks.map((t: any) => t.id), ["extra7", "extra8"]);
		assert.deepEqual((next.details.gentleAgents as any).candidates[0].catalog.registered, ["/registered/8", "/registered/9"]);
		assert.equal(h.userMessages.length, 0);
		const selectedWork = await h.tools.get("orchestrator_list")!.execute("selected-work", {
			filter: {}, recipient_session_id: "peer", cursor,
		}, undefined, undefined, ctx);
		assert.deepEqual(JSON.parse(selectedWork.content[0].text).matches.map((row: any) => row.taskId), ["extra8"]);
		const firstWorkPage = await h.tools.get("orchestrator_list")!.execute("first-work", {
			filter: {}, recipient_session_id: "peer",
		}, undefined, undefined, ctx);
		assert.deepEqual(JSON.parse(firstWorkPage.content[0].text).matches.map((row: any) => row.taskId), ["child"]);
		publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [], state: {
			schema: 2, sessionId: "peer", cwd: "/repo", recordedAt: 1, source: "owner-curated",
			ownerReply: false, authority: "none", state: { progress: "Explicit summary", work: { area: "Auth" } },
		} });
		const noted = await h.tools.get("orchestrator_list")!.execute("note", { recipient_session_id: "peer" }, undefined, undefined, ctx);
		assert.match(noted.content[0].text, /Explicit summary/);
		assert.equal((noted.details.gentleAgents as any).candidates[0].state.recordedAt, 1);
		assert.deepEqual((noted.details.gentleAgents as any).candidates[0].state.state.work, { area: "Auth" });
		const list = h.tools.get("orchestrator_list")!;
		const workResult = await list.execute("work", { filter: {} }, undefined, undefined, ctx);
		const work = JSON.parse(workResult.content[0].text);
		assert.deepEqual(JSON.parse(JSON.stringify((workResult.details.gentleAgents as any).workSearch)), work);
		assert.equal(work.schema, 1);
		assert.deepEqual(work.matches[0].work, { area: "Auth" });
		assert.equal(work.coverage.exhaustive, false);
		assert.doesNotMatch(workResult.content[0].text, /Explicit summary|endpoint|activation|cursor|capabilities/);
		const defaultList = await list.execute("default", {}, undefined, undefined, ctx);
		assert.doesNotMatch(defaultList.content[0].text, /Explicit summary|"work"/);
		assert.equal((defaultList.details.gentleAgents as any).candidates[0].state, undefined);
		const beforeInvalid = scans;
		for (const invalid of [null, [], { unexpected: true }, { filter: null }, { filter: { topic: "Login" } },
			{ filter: { area: 1 } }, { filter: { area: "é".repeat(33) } }, { filter: { text: "bad\u0000text" } },
			{ filter: { ref: { kind: "issue", repository: "github.com/A/B", id: "01" } } },
			{ filter: { related_to: { session_id: "peer", extra: true } } }]) {
			await assert.rejects(list.execute("invalid", invalid, undefined, undefined, ctx), /Invalid orchestrator list/);
		}
		for (const args of [{ cursor: "x" }, { filter: {}, cursor: "x" }]) {
			const invalidCursor = await list.execute("cursor", args, undefined, undefined, ctx);
			assert.equal(invalidCursor.details.error, "invalid-cursor");
			assert.equal(invalidCursor.content[0].text, "Error: cursor requires recipient_session_id.");
		}
		assert.equal(scans, beforeInvalid, "invalid arguments never reach peer/profile discovery");
		const consult = h.tools.get("orchestrator_consult")!;
		const probesBeforeConsult = probes;
		const receipt = JSON.parse((await consult.execute("consult", { recipient_session_id: "peer" }, undefined, undefined, ctx)).content[0].text);
		assert.equal(receipt.snapshot.state.state.progress, "Explicit summary");
		assert.equal(receipt.snapshot.state.recordedAt, 1);
		assert.deepEqual(receipt.snapshot.state.state.work, { area: "Auth" });
		assert.equal(receipt.ownerReply, false);
		assert.equal(receipt.authority, "none");
		assert.equal(receipt.targetSessionId, "peer");
		assert.doesNotMatch(JSON.stringify(receipt), /endpoint|activation|prompt|thread/);
		for (const invalid of [{ recipient_session_id: "peer", kind: "reasoning" }, { recipient_session_id: "peer", question: "secret" }, {}]) {
			await assert.rejects(consult.execute("invalid", invalid, undefined, undefined, ctx), /Invalid metadata/);
		}
		assert.equal(probes, probesBeforeConsult);
		publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [], state: {
			schema: 2, sessionId: "peer", cwd: "/repo", recordedAt: 2, source: "owner-curated",
			ownerReply: false, authority: "none", state: { work: { topic: "Missing area" } },
		} });
		const malformed = await h.tools.get("orchestrator_list")!.execute("malformed", { recipient_session_id: "peer" }, undefined, undefined, ctx);
		assert.equal((malformed.details.gentleAgents as any).candidates[0].sessionId, "peer");
		assert.equal((malformed.details.gentleAgents as any).candidates[0].state, undefined);
		assert.ok(readActivity(profile, listPresence(profile).entries[0]).activity);
		publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [] });
		const legacy = await h.tools.get("orchestrator_list")!.execute("legacy", {}, undefined, undefined, ctx);
		assert.match(legacy.content[0].text, /repository: unknown/);
		assert.equal((legacy.details.gentleAgents as any).candidates[0].sessionId, "peer");
		let release!: () => void;
		gate = () => new Promise<void>(resolve => { release = resolve; });
		const pending = consult.execute("pending", { recipient_session_id: "peer" }, undefined, undefined, ctx);
		await h.fire("session_shutdown", ctx);
		release();
		assert.equal(JSON.parse((await pending).content[0].text).status, "unavailable");
		assert.equal(runtime.spawned.length, 0);
		assert.equal(h.sent.length, 0);
		assert.equal(h.userMessages.length, 0);
		await h.fire("session_shutdown", ctx);
	} finally { publisher.dispose(); }
});

test("registered reasoning and revocation use live SDK host and published source only", async () => {
	const h = fakePi(), runtime = deps();
	const profile = realpathSync(mkdtempSync(join(root, "reasoning-runtime-")));
	const peer = { version: 1 as const, sessionId: "peer", endpoint: "/fixture/peer.sock", createdAt: 1 };
	const publisher = PresencePublisher.start({ profile, sessionId: "peer", label: "Published peer", activity: [] });
	const publish = (progress = "Recorded") => publisher.updateDiscovery(peer, { workspace: "/repo", tasks: [], state: {
		schema: 1, sessionId: "peer", cwd: "/repo", recordedAt: 1, source: "owner-curated",
		ownerReply: false, authority: "none", state: { progress },
	} });
	publish(); let ready = false, dialogs = 0, calls = 0, choice = "Decline";
	let complete: (() => void) | undefined, hang = false;
	let peers = [peer];
	let duringDialog: (() => Promise<void> | void) | undefined;
	const registry = { list: async () => [], listActivations: async () => peers };
	runtime.deps.agentHome = profile;
	runtime.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: () => ({ registry, start: async () => { ready = true; }, close: async () => {} }),
		createClient: () => ({ close() {}, sendNotification: async () => { throw Error("no owner message"); } }),
	};
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	const answer = { role: "assistant", api: "fixture", provider: "fixture", model: "local", timestamp: 1,
		stopReason: "stop", content: [{ type: "text", text: "Published advice" }], usage: {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
	Object.assign(ctx, { model: { id: "local", provider: "fixture", maxTokens: 1024 }, modelRegistry: {
		streamSimple(_model: unknown, context: { tools: unknown[]; messages: unknown[] }, options: { maxRetries: number }) {
			calls++; assert.deepEqual(context.tools, []); assert.equal(context.messages.length, 1);
			assert.equal(options.maxRetries, 0);
			const stream = createAssistantMessageEventStream();
			stream.result = hang ? () => new Promise(resolve => { complete = () => resolve(answer); }) : async () => answer;
			return stream;
		},
	} });
	// Test-simulated supported UI choices, NOT evidence of actual human approval.
	ctx.ui.select = async (title, options) => {
		dialogs++; assert.match(title, /Model-cost permission only/);
		assert.deepEqual(options, ["Allow once", "Allow this target + model for this session", "Decline"]);
		await duringDialog?.(); return choice;
	};
	try {
		await h.fire("session_start", ctx); await eventually(() => ready, "reasoning transport ready");
		const tool = h.tools.get("orchestrator_consult")!;
		const run = async (kind = "reasoning", patch = {}, caller = ctx, signal?: AbortSignal) => JSON.parse((await tool.execute("c",
			{ recipient_session_id: "peer", kind, ...(kind === "reasoning" ? { question: "What is published?" } : {}), ...patch }, signal, undefined, caller)).content[0].text);
		assert.equal((await run("metadata")).status, "available"); assert.deepEqual([dialogs, calls], [0, 0]);
		assert.equal((await run()).code, "permission-required"); assert.deepEqual([dialogs, calls], [1, 0]);
		choice = "Allow once"; const advice = await run();
		assert.equal(advice.source, "helper_advice"); assert.equal(advice.ownerReply, false); assert.equal(advice.authority, "none");
		assert.equal(advice.requestCaps.maxTokens, 512); assert.equal(advice.usage.totalTokens, 2);
		assert.deepEqual(advice.actualModel, { provider: "fixture", id: "local" }); assert.deepEqual([dialogs, calls], [2, 1]);
		choice = "Allow this target + model for this session"; await run();
		publisher.updateDiscovery(peer, { workspace: "/updated-public", tasks: [] }); await run();
		assert.deepEqual([dialogs, calls], [3, 3]);
		Object.assign(ctx, { hasUI: false });
		assert.equal((await run("revoke-reasoning")).status, "revoked");
		assert.deepEqual([dialogs, calls], [3, 3]); Object.assign(ctx, { hasUI: true });
		choice = "Decline"; assert.equal((await run()).code, "permission-required");
		for (const patch of [{ hasUI: false }, { mode: "print" }, { mode: "json" }]) {
			Object.assign(ctx, patch); assert.equal((await run()).code, "permission-required");
		}
		Object.assign(ctx, { hasUI: true, mode: "rpc" }); choice = "Allow once";
		assert.equal((await run()).status, "available");
		const before = [dialogs, calls];
		for (const args of [{ question: "implicit" }, { kind: "reasoning" }, { kind: "revoke-reasoning", cursor: "x" },
			{ kind: "metadata", question: "irrelevant" }, { kind: "reasoning", question: "é".repeat(513) },
			{ kind: null }, { kind: "unknown" }, { cursor: "x".repeat(1025) }, { unexpected: true }]) {
			await assert.rejects(tool.execute("bad", { recipient_session_id: "peer", ...args }, undefined, undefined, ctx), /Invalid metadata/);
		}
		assert.deepEqual([dialogs, calls], before);
		choice = "Allow this target + model for this session"; await run();
		for (const event of ["session_tree", "resources_discover", "session_before_switch", "session_before_fork", "session_before_tree", "model_select", "session_start"]) {
			await h.fire(event, ctx); choice = "Decline";
			assert.equal((await run()).code, "permission-required");
			choice = "Allow this target + model for this session"; await run();
		}
		await run("revoke-reasoning"); choice = "Allow once"; hang = true;
		for (const change of ["public", "activation", "unavailable", "private", "abort", "revoke"]) {
			publish(); peers = [peer]; const controller = new AbortController();
			const pending = run("reasoning", {}, ctx, controller.signal);
			await eventually(() => !!complete, "helper pending");
			if (change === "public") publish("Changed progress");
			if (change === "activation") peers = [{ ...peer, endpoint: "/fixture/replaced.sock" }];
			if (change === "unavailable") peers = [];
			if (change === "private") { publisher.update([]); publisher.refreshLabel(); }
			if (change === "abort") controller.abort();
			if (change === "revoke") await run("revoke-reasoning");
			complete!(); complete = undefined;
			const outcome = await pending;
			assert.equal(outcome.status, change === "private" ? "available" : "unavailable");
		}
		hang = false; peers = [peer];
		for (const change of [() => Object.assign(ctx, { model: { ...ctx.model! } }),
			() => publish("Changed after dialog"),
			() => h.fire("session_tree", ctx), () => run("revoke-reasoning"),
			() => h.fire("session_shutdown", ctx),
			() => h.fire("session_start", fakeContext().ctx, { reason: "new" })]) {
			await h.fire("session_start", ctx); await new Promise(resolve => setImmediate(resolve));
			publish(); duringDialog = async () => { await change(); }; const count = calls;
			assert.equal((await run()).status, "unavailable"); assert.equal(calls, count);
		}
		assert.equal((await run("metadata", {}, ctx)).status, "unavailable");
		assert.equal(runtime.spawned.length, 0); assert.equal(h.sent.length, 0); assert.equal(h.userMessages.length, 0);
	} finally { await h.fire("session_shutdown", ctx); publisher.dispose(); }
});

test("session transport adds host tools, forwards notifications, and closes on shutdown", async () => {
	const h = fakePi();
	const runtime = deps();
	let callback: ((notification: { id: string; senderSessionId: string; message: string }) => Promise<void>) | undefined;
	let listenerStarts = 0;
	let listenerCloses = 0;
	let clientCloses = 0;
	const registry = { list: async () => [{ sessionId: "peer", reachability: "unknown" }], listActivations: async () => [{ version: 1 as const, sessionId: "peer", endpoint: "/fixture/peer.sock", createdAt: 1 }] };
	runtime.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: (_registry, _sessionId, received) => {
			callback = received;
			return { registry, start: async () => { listenerStarts += 1; }, close: async () => { listenerCloses += 1; } };
		},
		createClient: () => ({ close: () => { clientCloses += 1; } }),
	} as never;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await eventually(() => listenerStarts === 1, "session transport listener starts");
	assert.equal(listenerStarts, 1);
	assert.ok(h.tools.has("orchestrator_session_id"));
	assert.ok(h.tools.has("orchestrator_list"));
	assert.ok(h.tools.has("orchestrator_send_message"));
	assert.match((await h.tools.get("orchestrator_list")!.execute("list", {}, undefined, undefined, ctx)).content[0].text, /peer/);
	assert.ok(callback, "listener receives the inbound callback");
	Object.assign(ctx.sessionManager, { getSessionName: () => "Integration" });
	await callback!({ id: "message-1", senderSessionId: "peer", message: "\u001b[31mraw model content" });
	assert.equal(h.sent.at(-1)?.message.customType, "gentle-agents.orchestrator-message");
	assert.match(String(h.sent.at(-1)?.message.content), /\u001b\[31mraw model content/);
	assert.deepEqual(h.sent.at(-1)?.options, { deliverAs: "followUp", triggerTurn: true });
	const renderer = h.renderers.get("gentle-agents.orchestrator-message")!;
	const compact = renderer(h.sent.at(-1)!.message, { expanded: false }, plainTheme).render(80).join("\n");
	assert.match(compact, /Message received/);
	assert.match(compact, /🤖 Orchestrator → 🤖 Integration/);
	assert.match(compact, /raw model content/);
	assert.doesNotMatch(compact, /Session message from|correlation|message-1|\u001b/);
	const expanded = renderer(h.sent.at(-1)!.message, { expanded: true }, plainTheme).render(80).join("\n");
	assert.match(expanded, /message-1/);
	assert.match(expanded, /Sender session: peer/);
	await h.fire("session_shutdown", ctx);
	assert.equal(clientCloses, 1);
	assert.equal(listenerCloses, 1);
});

test("session transport accepts a notification while listener publication is still starting", async () => {
	const h = fakePi();
	const runtime = deps();
	let callback: ((notification: { id: string; senderSessionId: string; message: string }) => Promise<void>) | undefined;
	const registry = { list: async () => [], listActivations: async () => [] };
	runtime.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: (_registry, _sessionId, received) => {
			callback = received;
			return { registry, start: async () => { await callback!({ id: "published", senderSessionId: "peer", message: "during publication" }); }, close: async () => {} };
		},
		createClient: () => ({ close: () => {} }),
	} as never;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	await eventually(() => h.sent.at(-1)?.message.customType === "gentle-agents.orchestrator-message", "publication callback completes");
	assert.equal(h.sent.at(-1)?.message.customType, "gentle-agents.orchestrator-message");
	assert.match(String(h.sent.at(-1)?.message.content), /during publication/);
});

test("session transport selects a peer for outbound delivery and rejects stale callbacks after replacement", async () => {
	const h = fakePi();
	const runtime = deps();
	const callbacks: Array<(notification: { id: string; senderSessionId: string; message: string }) => Promise<void>> = [];
	const sent: Array<{ recipient: string; message: string; expectedActivation?: unknown }> = [];
	let closed = 0;
	const records = [
		{ version: 1, sessionId: "alpha", endpoint: "/alpha.sock", createdAt: 1 },
		{ version: 1, sessionId: "beta", endpoint: "/beta.sock", createdAt: 2 },
	];
	const registry = { list: async () => [], listActivations: async () => records };
	runtime.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: (_registry, _sessionId, received) => {
			callbacks.push(received);
			return { registry, start: async () => {}, close: async () => { closed += 1; } };
		},
		createClient: () => ({
			close: () => { closed += 1; },
			sendNotification: async (recipient: string, message: string, options: { expectedActivation?: unknown }) => {
				sent.push({ recipient, message, expectedActivation: options.expectedActivation });
				return { id: "accepted-1", accepted: true };
			},
		}),
	} as never;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx, dialogs } = fakeContext();
	await h.fire("session_start", ctx);
	await eventually(() => callbacks.length === 1, "initial transport callback registration");
	Object.assign(ctx.sessionManager, { getSessionName: () => "Backend" });
	const result = await h.tools.get("orchestrator_send_message")!.execute("send", { message: "hello peer", reason: "because the peer needs an update" }, undefined, undefined, ctx);
	assert.deepEqual(dialogs, [
		"select:Select recipient orchestrator:Orchestrator alpha|Orchestrator beta",
		"select:Authorize cross-orchestrator message to alpha?\nReason: because the peer needs an update\nMessage: hello peer:Allow once|Allow for this session|Deny",
	]);
	assert.deepEqual(sent, [{ recipient: "alpha", message: "hello peer", expectedActivation: records[0] }]);
	assert.match(result.content[0].text, /accepted for delivery; it is not a delivery or read receipt/);
	const tool = h.tools.get("orchestrator_send_message")!;
	assert.equal(tool.renderShell, "self", "do not nest the card in Pi's default tool box");
	const args = { message: "hello peer", reason: "because the peer needs an update" };
	const renderContext = { args, state: {}, expanded: false, isPartial: false };
	const call = (tool.renderCall as Function)(args, plainTheme, renderContext);
	const output = (tool.renderResult as Function)(result, { expanded: false }, plainTheme, renderContext);
	const compact = [...call.render(80), ...output.render(80)].join("\n");
	assert.match(compact, /Message queued/);
	assert.match(compact, /🤖 Backend → 🤖 Orchestrator/);
	assert.match(compact, /hello peer/);
	assert.doesNotMatch(compact, /accepted-1|Sender session:|Recipient session:|because the peer/);
	const expanded = (tool.renderResult as Function)(result, { expanded: true }, plainTheme, { ...renderContext, expanded: true }).render(80).join("\n");
	assert.match(expanded, /accepted-1/);
	assert.match(expanded, /not a delivery or read receipt/);
	const original = callbacks[0]!;
	(ctx.sessionManager as unknown as { getSessionId(): string }).getSessionId = () => "s2";
	await h.fire("session_start", ctx);
	await eventually(() => closed === 2, "replacement closes the old client and listener");
	assert.equal(closed, 2, "replacement closes the old client and listener before activating its successor");
	await assert.rejects(original({ id: "late", senderSessionId: "alpha", message: "late callback" }), /stale session transport/);
	await h.fire("session_shutdown", ctx);
});

// Issue #1364: user consent before cross-orchestrator communication
test("orchestrator_send_message requires consent on explicit recipient ID and sends nothing when denied", async () => {
	const h = fakePi();
	const records = [{ version: 1, sessionId: "target-peer", endpoint: "/target.sock", createdAt: 1 }];
	const sent: unknown[] = [];
	const runtime = deps();
	const registry = { list: async () => [], listActivations: async () => records };
	runtime.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: () => ({ registry, start: async () => {}, close: async () => {} }),
		createClient: () => ({
			close: () => {},
			sendNotification: async (recipient: string, message: string) => {
				sent.push({ recipient, message });
				return { id: "msg-1", accepted: true };
			},
		}),
	} as never;
	gentleAgents(h.pi, {}, runtime.deps);

	const { ctx, dialogs } = fakeContext(
		undefined,
		undefined,
		undefined,
		undefined,
		async (_title, options) => options[2] // "Deny"
	);
	await h.fire("session_start", ctx);

	const result = await h.tools.get("orchestrator_send_message")!.execute(
		"send",
		{ recipient_session_id: "target-peer", message: "sensitive task details", reason: "status check" },
		undefined,
		undefined,
		ctx
	);

	assert.deepEqual(dialogs, [
		"select:Authorize cross-orchestrator message to target-peer?\nReason: status check\nMessage: sensitive task details:Allow once|Allow for this session|Deny",
	]);
	assert.equal(sent.length, 0, "nothing must be sent when user denies consent");
	assert.match(result.content[0].text, /denied by user/);
	assert.equal((result.details as { error: string }).error, "denied");
	await h.fire("session_shutdown", ctx);
});

test("orchestrator_send_message with Allow for this session skips prompt on subsequent sends to same recipient", async () => {
	const h = fakePi();
	const records = [{ version: 1, sessionId: "target-peer", endpoint: "/target.sock", createdAt: 1 }];
	const sent: unknown[] = [];
	const runtime = deps();
	const registry = { list: async () => [], listActivations: async () => records };
	runtime.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: () => ({ registry, start: async () => {}, close: async () => {} }),
		createClient: () => ({
			close: () => {},
			sendNotification: async (recipient: string, message: string) => {
				sent.push({ recipient, message });
				return { id: "msg-1", accepted: true };
			},
		}),
	} as never;
	gentleAgents(h.pi, {}, runtime.deps);

	const { ctx, dialogs } = fakeContext(
		undefined,
		undefined,
		undefined,
		undefined,
		async (_title, options) => options[1] // "Allow for this session"
	);
	await h.fire("session_start", ctx);

	// First send
	const res1 = await h.tools.get("orchestrator_send_message")!.execute(
		"send-1",
		{ recipient_session_id: "target-peer", message: "msg 1", reason: "because the first update is needed" },
		undefined,
		undefined,
		ctx
	);
	assert.match(res1.content[0].text, /accepted for delivery/);
	assert.equal(dialogs.length, 1);
	assert.equal(sent.length, 1);

	// Second send to same recipient in same session must NOT prompt again
	const res2 = await h.tools.get("orchestrator_send_message")!.execute(
		"send-2",
		{ recipient_session_id: "target-peer", message: "msg 2", reason: "because the next update is needed" },
		undefined,
		undefined,
		ctx
	);
	assert.match(res2.content[0].text, /accepted for delivery/);
	assert.equal(dialogs.length, 1, "must not open a second consent dialog for the same session-granted recipient");
	assert.equal(sent.length, 2);
	await h.fire("session_shutdown", ctx);
});

test("orchestrator_send_message fails closed in headless mode without UI", async () => {
	const h = fakePi();
	const records = [{ version: 1, sessionId: "target-peer", endpoint: "/target.sock", createdAt: 1 }];
	const sent: unknown[] = [];
	const runtime = deps();
	const registry = { list: async () => [], listActivations: async () => records };
	runtime.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: () => ({ registry, start: async () => {}, close: async () => {} }),
		createClient: () => ({
			close: () => {},
			sendNotification: async (recipient: string, message: string) => {
				sent.push({ recipient, message });
				return { id: "msg-1", accepted: true };
			},
		}),
	} as never;
	gentleAgents(h.pi, {}, runtime.deps);

	const { ctx } = fakeContext();
	(ctx as { hasUI: boolean }).hasUI = false;
	(ctx as { ui?: unknown }).ui = undefined;
	await h.fire("session_start", ctx);

	const result = await h.tools.get("orchestrator_send_message")!.execute(
		"send",
		{ recipient_session_id: "target-peer", message: "hello", reason: "because this is needed" },
		undefined,
		undefined,
		ctx
	);

	assert.equal(sent.length, 0, "nothing must be sent without interactive UI");
	assert.match(result.content[0].text, /requires interactive human consent/);
	assert.equal((result.details as { error: string }).error, "denied");
	await h.fire("session_shutdown", ctx);
});

test("orchestrator_send_message requires a concrete trimmed reason within UTF-8 bounds", async () => {
	const h = fakePi();
	const records = [{ version: 1, sessionId: "target-peer", endpoint: "/target.sock", createdAt: 1 }];
	let listenerStarted = false;
	let listCalls = 0;
	const sent: unknown[] = [];
	const runtime = deps();
	const registry = { list: async () => [], listActivations: async () => { listCalls++; return records; } };
	runtime.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: () => ({ registry, start: async () => { listenerStarted = true; }, close: async () => {} }),
		createClient: () => ({ close: () => {}, sendNotification: async (...args: unknown[]) => { sent.push(args); return { id: "msg-1", accepted: true }; } }),
	} as never;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx, dialogs } = fakeContext();
	await h.fire("session_start", ctx);
	await eventually(() => listenerStarted, "session transport listener starts");

	const tool = h.tools.get("orchestrator_send_message")!;
	const schema = tool.parameters as unknown as { required: string[]; properties: { reason: { minLength: number; maxLength: number; description: string } } };
	assert.ok(schema.required.includes("reason"));
	assert.equal(schema.properties.reason.minLength, 8);
	assert.equal(schema.properties.reason.maxLength, 512);
	for (const reason of [undefined, "   short  ", "é".repeat(257)]) {
		const result = await tool.execute("invalid", { message: "hello", reason }, undefined, undefined, ctx);
		assert.equal((result.details as { error: string }).error, "invalid input");
	}
	assert.equal(dialogs.length, 0, "invalid reasons must be rejected before any consent UI");
	assert.equal(listCalls, 0, "reason validation must precede asynchronous recipient discovery");
	assert.equal(sent.length, 0);
	await h.fire("session_shutdown", ctx);
});

test("orchestrator_send_message snapshots message and reason before recipient and consent selection", async () => {
	const h = fakePi();
	const records = [
		{ version: 1, sessionId: "alpha", endpoint: "/alpha.sock", createdAt: 1 },
		{ version: 1, sessionId: "beta", endpoint: "/beta.sock", createdAt: 2 },
	];
	const sent: Array<{ recipient: string; message: string }> = [];
	let listenerStarted = false;
	let chooseRecipient!: (value: string | undefined) => void;
	let chooseConsent!: (value: string | undefined) => void;
	const recipientSelection = new Promise<string | undefined>((resolve) => { chooseRecipient = resolve; });
	const consentSelection = new Promise<string | undefined>((resolve) => { chooseConsent = resolve; });
	const runtime = deps();
	const registry = { list: async () => [], listActivations: async () => records };
	runtime.deps.sessionTransport = {
		createRegistry: async () => registry,
		createListener: () => ({ registry, start: async () => { listenerStarted = true; }, close: async () => {} }),
		createClient: () => ({ close: () => {}, sendNotification: async (recipient: string, message: string) => { sent.push({ recipient, message }); return { id: "msg-1", accepted: true }; } }),
	} as never;
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx, dialogs } = fakeContext(undefined, undefined, undefined, undefined, async (title) => title.startsWith("Select recipient") ? recipientSelection : consentSelection);
	await h.fire("session_start", ctx);
	await eventually(() => listenerStarted, "session transport listener starts");

	const originalMessage = "original\r\nReason: forged\ttab\u2028next";
	const originalReason = "because the update is needed\r\nMessage: forged";
	const params: { message: string; reason: string } = { message: originalMessage, reason: originalReason };
	const pending = h.tools.get("orchestrator_send_message")!.execute("send", params, undefined, undefined, ctx);
	await eventually(() => dialogs.length === 1, "recipient selector opens");
	params.message = "mutated during recipient selection";
	params.reason = "mutated reason one";
	chooseRecipient("Orchestrator alpha");
	await eventually(() => dialogs.length === 2, "consent selector opens");
	params.message = "mutated during consent selection";
	params.reason = "mutated reason two";
	chooseConsent("Allow once");
	await pending;

	assert.match(dialogs[1]!, /Reason: because the update is needed\\r\\nMessage: forged/);
	assert.match(dialogs[1]!, /Message: original\\r\\nReason: forged\\ttab\\u2028next/);
	assert.doesNotMatch(dialogs[1]!, /mutated/);
	assert.deepEqual(sent, [{ recipient: "alpha", message: originalMessage }], "the exact snapshotted payload is sent, including real line separators");
	await h.fire("session_shutdown", ctx);
});

// Issue #867: a completion settling while the parent agent run is active must
// be held by the extension and flushed at the next turn boundary, not parked
// in the host's followUp queue until the whole orchestrator run stops calling
// tools.
test("a background completion settling while the parent agent runs is delivered exactly once at the next turn end", async () => {
	const { pi, tools, fire, sent, userMessages } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const started = await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Chained turns", mode: "background" }, undefined, undefined, ctx);
	const id = (started.details.gentleAgents as { taskId: string }).taskId;
	await tick();
	await fire("agent_start", ctx);
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Chained done." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 0, "nothing enters the conversation while the parent agent run is active");
	await fire("turn_end", ctx);
	const results = sent.filter((entry) => entry.message.customType === "gentle-agents.result");
	assert.equal(results.length, 1, "the held completion is delivered exactly once at turn_end");
	assert.match(String(results[0]!.message.content), new RegExp(`task ${id}, "Chained turns"`));
	// Pins the delivery mode against the host's drain semantics: "followUp" is
	// drained by the run loop only in its stop branch, so a parent that keeps
	// calling tools would see the completion when the whole run ends. "steer" is
	// polled every turn and injected before the next LLM call, bounding the wait
	// to the current turn.
	assert.deepEqual(results[0]!.options, { deliverAs: "steer", triggerTurn: true });
	await fire("turn_end", ctx);
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 1, "a later turn_end never replays the completion");
	assert.equal(userMessages.length, 0, "an active parent is never woken through a separate user message");
	await fire("session_shutdown", ctx);
});

test("Bridge identity is durable, session-owned and registered once across session changes", async () => {
	const h = fakePi();
	const runtime = deps();
	gentleAgents(h.pi, {}, runtime.deps);
	const { ctx } = fakeContext();
	ctx.sessionManager.getEntries = () => h.entries as unknown as ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;
	await h.fire("session_start", ctx);
	await h.tools.get("subagent_run")!.execute("one", { agent: "explore", task: "Wake identity", mode: "background" }, undefined, undefined, ctx);
	await tick();
	runtime.children[0].message({ id: "q1", kind: "query", message: "Question" });
	await tick();
	const wake = String(h.userMessages[0].content);
	const transform = h.transformers[0];
	const context = { messageType: "user" as const, isStreaming: false, availableWidth: 80 };
	assert.equal(transform(wake, context), "");
	assert.equal(h.entries.filter(entry => entry.customType === "gentle-agents.wake-identity").length, 1);
	await h.fire("session_start", ctx, { reason: "reload" });
	assert.equal(transform(wake, context), "", "reload reconstructs ownership");
	ctx.sessionManager.getSessionId = () => "other-session";
	await h.fire("session_start", ctx, { reason: "new" });
	assert.equal(transform(wake, context), wake, "another session cannot claim the old identity");
	ctx.sessionManager.getSessionId = () => "s1";
	await h.fire("session_start", ctx, { reason: "resume" });
	assert.equal(transform(wake, context), "");
	assert.equal(h.transformers.length, 1, "session changes do not register again");
	assert.equal(transform(`Quoted: ${wake}`, context), `Quoted: ${wake}`);
	assert.equal(transform(` ${wake}`, context), ` ${wake}`);
	await h.fire("session_shutdown", ctx);
	assert.equal(transform(wake, context), wake, "shutdown releases the old owner");
});

for (const failure of ["missing-api", "persistence", "warning-ui"] as const) {
	test(`Bridge ${failure} fallback preserves continuation and flags visible wake`, async () => {
		const h = fakePi();
		const runtime = deps();
		if (failure !== "persistence") delete (h.pi as Partial<ExtensionAPI>).registerMarkdownTransformer;
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx, dialogs } = fakeContext();
		if (failure === "warning-ui") ctx.ui.notify = () => { throw new Error("UI unavailable"); };
		await h.fire("session_start", ctx);
		if (failure === "persistence") h.pi.appendEntry = () => { throw new Error("Persistence unavailable"); };
		await h.tools.get("subagent_run")!.execute("fallback", { agent: "explore", task: "Fallback", mode: "background" }, undefined, undefined, ctx);
		await tick();
		runtime.children[0].message({ id: "q1", kind: "query", message: "Question" });
		await tick();
		assert.equal(h.userMessages.length, 1);
		assert.equal(h.sent.length, 1, "payload is stored once despite compatibility fallback");
		assert.doesNotMatch(String(h.userMessages[0].content), /gentle-agents wake:/);
		if (failure !== "warning-ui") assert.ok(dialogs.some(message => message.includes("cannot hide Claude Bridge")));
	});
}

for (const provider of ["openai", "anthropic", "custom-extension", undefined, "claude-bridge"]) {
	for (const kind of ["completion", "query"] as const) {
		test(`idle ${kind} wake uses the selected ${provider ?? "missing"} provider route`, async () => {
			const h = fakePi();
			h.setProvider(provider);
			const harness = deps();
			gentleAgents(h.pi, {}, harness.deps);
			const { ctx } = fakeContext();
			await h.fire("session_start", ctx);
			await h.tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Route wake", mode: "background" }, undefined, undefined, ctx);
			await tick();
			if (kind === "query") harness.children[0].message({ id: "q1", kind: "query", message: "Child payload" });
			else {
				harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Child payload" }] }] });
				harness.children[0].emit({ type: "agent_settled" });
			}
			await tick();
			assert.deepEqual(h.sent[0]!.options, { triggerTurn: false });
			assert.match(String(h.sent[0]!.message.content), /Child payload/);
			if (provider === "claude-bridge") {
				assert.equal(h.sent.length, 1);
				assert.equal(h.userMessages.length, 1);
				assert.match(String(h.userMessages[0].content), /\[gentle-agents wake: [0-9a-f-]+\]$/);
				assert.deepEqual(h.userMessages[0].options, { deliverAs: "steer" });
				assert.equal(h.transformers[0](String(h.userMessages[0].content), { messageType: "user", isStreaming: false, availableWidth: 80 }), "");
				assert.equal(h.delivery.at(-1), "user");
			} else {
				assert.equal(h.userMessages.length, 0, "native and unclassified providers never receive a synthetic user turn");
				assert.equal(h.sent.length, 2, "the stored payload still gets a continuation turn");
				assert.deepEqual(h.sent[1]!.options, { deliverAs: "steer", triggerTurn: true });
				assert.equal(h.sent[1]!.message.display, false);
				assert.equal(h.sent[1]!.message.customType, "gentle-agents.wake");
				assert.equal(h.sent[1]!.message.content, "Review the delivered subagent output and continue.");
				assert.deepEqual(h.delivery, [`custom:gentle-agents.${kind === "query" ? "message" : "result"}`, "custom:gentle-agents.wake"]);
			}
			await h.fire("session_shutdown", ctx);
		});
	}
}

for (const [from, to] of [["openai", "claude-bridge"], ["claude-bridge", "openai"]]) {
	test(`wake reads the live provider after storage: ${from} to ${to}`, async () => {
		const h = fakePi(from);
		const harness = deps();
		gentleAgents(h.pi, {}, harness.deps);
		const { ctx } = fakeContext();
		await h.fire("session_start", ctx);
		await h.tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Switch before dispatch", mode: "background" }, undefined, undefined, ctx);
		await tick();
		const sendMessage = h.pi.sendMessage;
		Object.assign(h.pi, { sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => {
			sendMessage(...args);
			// Storage happens synchronously, dispatch in the queued microtask.
			if (args[0].customType === "gentle-agents.message") h.setProvider(to);
		} });
		harness.children[0].message({ id: "q1", kind: "query", message: "Switch?" });
		await tick();
		assert.equal(h.userMessages.length, to === "claude-bridge" ? 1 : 0);
		assert.equal(h.sent.filter((entry) => entry.message.customType === "gentle-agents.wake").length, to === "openai" ? 1 : 0);
		await h.fire("session_shutdown", ctx);
	});
}

for (const boundary of ["session_compact", "session_compact_failed"] as const) {
	test(`native wake preserves holds, coalescing and grace after ${boundary}`, async () => {
		const h = fakePi("openai");
		const harness = deps();
		const timers = recordTimers(harness.deps);
		gentleAgents(h.pi, {}, harness.deps);
		const { ctx } = fakeContext();
		await h.fire("session_start", ctx);
		for (const task of ["Ask", "Finish"]) await h.tools.get("subagent_run")!.execute(task, { agent: "explore", task, mode: "background" }, undefined, undefined, ctx);
		await tick();
		h.setIdle(false);
		harness.children[0].message({ id: "q1", kind: "query", message: "Held question" });
		harness.children[1].emit({ type: "agent_settled" });
		await tick();
		assert.equal(h.sent.length, 0);
		await h.fire(boundary, ctx);
		assert.equal(h.sent.length, 0);
		h.setIdle(true);
		assert.equal(timers.run(0), 1);
		await tick();
		assert.deepEqual(h.delivery, ["custom:gentle-agents.message", "custom:gentle-agents.result", "custom:gentle-agents.wake"]);
		assert.deepEqual(h.sent.map((entry) => entry.options), [{ triggerTurn: false }, { triggerTurn: false }, { deliverAs: "steer", triggerTurn: true }]);
		const expireWakeGrace = timers.takeLast(PARENT_WAKE_GRACE_MS);
		harness.children[0].message({ id: "q2", kind: "query", message: "Later question" });
		await tick();
		assert.equal(h.sent.length, 4, "content arriving in the grace window shares the pending wake");
		expireWakeGrace();
		await tick();
		assert.equal(h.sent.length, 5, "an unstarted wake cannot suppress new content beyond grace");
		assert.equal(h.sent[4]!.message.display, false);
		assert.deepEqual(h.sent[4]!.options, { deliverAs: "steer", triggerTurn: true });
		await h.fire("agent_start", ctx);
		harness.children[0].message({ id: "q3", kind: "query", message: "Busy question" });
		await tick();
		assert.equal(h.sent.length, 5, "busy content stays queued until the turn boundary");
		await h.fire("turn_end", ctx);
		assert.equal(h.sent.at(-1)!.message.customType, "gentle-agents.message");
		assert.deepEqual(h.sent.at(-1)!.options, { deliverAs: "steer", triggerTurn: true }, "busy native delivery keeps the original steering route");
		assert.equal(h.userMessages.length, 0);
		await h.fire("session_shutdown", ctx);
	});
}

// Bridge custom-message turns skip the prompt lifecycle needed for capture.
// Store the structured result durably and wake the bridge by a user message.
test("an idle parent stores the structured completion and is woken through the normal prompt lifecycle", async () => {
	const { pi, tools, fire, sent, userMessages, delivery, renderers } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const started = await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Idle wake", mode: "background" }, undefined, undefined, ctx);
	const id = (started.details.gentleAgents as { taskId: string }).taskId;
	await tick();
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Idle answer." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	const results = sent.filter((entry) => entry.message.customType === "gentle-agents.result");
	assert.equal(results.length, 1, "the completion is stored exactly once");
	assert.deepEqual(results[0]!.options, { triggerTurn: false }, "no direct custom-message turn bypasses before_agent_start");
	assert.equal(results[0]!.message.display, true, "the completion card stays visible");
	assert.equal((results[0]!.message.details as { gentleAgents?: { taskId?: string } }).gentleAgents?.taskId, id, "structured details stay on the durable message");
	assert.match(renderers.get("gentle-agents.result")!(results[0]!.message, { expanded: true }, plainTheme).render(70).map(stripAnsi).join("\n"), /Idle answer\./);
	assert.equal(userMessages.length, 1, "the idle parent is woken exactly once");
	assert.deepEqual(userMessages[0]!.options, { deliverAs: "steer" }, "a wake racing a new run is steered instead of rejected");
	const wake = String(userMessages[0]!.content);
	assert.match(wake, /system-generated/i, "the wake never claims human authorship");
	assert.doesNotMatch(wake, /Idle answer\./, "the wake never duplicates child content");
	assert.deepEqual(delivery, ["custom:gentle-agents.result", "user"], "the structured result is stored before the wake");
	await fire("turn_end", ctx);
	await fire("agent_settled", ctx);
	assert.equal(sent.length, 1, "later boundaries never replay the completion");
	assert.equal(userMessages.length, 1, "later boundaries never repeat the wake");
	await fire("session_shutdown", ctx);
});

test("idle deliveries before the woken run starts share one wake, and the next idle window wakes again", async () => {
	const { pi, tools, fire, sent, userMessages, delivery } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "First", mode: "background" }, undefined, undefined, ctx);
	await tools.get("subagent_run")!.execute("c2", { agent: "explore", task: "Second", mode: "background" }, undefined, undefined, ctx);
	await tick();
	for (const child of harness.children.slice(0, 2)) {
		child.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
		child.emit({ type: "agent_settled" });
		await tick();
	}
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 2, "both completions are stored");
	assert.equal(userMessages.length, 1, "a pending wake already covers results stored before its run starts");
	assert.deepEqual(delivery, ["custom:gentle-agents.result", "user", "custom:gentle-agents.result"]);
	await fire("agent_start", ctx);
	await fire("agent_end", ctx);
	await fire("agent_settled", ctx);
	await tools.get("subagent_run")!.execute("c3", { agent: "explore", task: "Third", mode: "background" }, undefined, undefined, ctx);
	await tick();
	harness.children[2]!.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	harness.children[2]!.emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 3);
	assert.equal(userMessages.length, 2, "a completion after the woken run settles wakes the parent again");
	await fire("session_shutdown", ctx);
});

test("a child query to an idle parent is stored with its structured details and wakes the parent once", async () => {
	const { pi, tools, fire, sent, userMessages, delivery } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Ask idle", mode: "background" }, undefined, undefined, ctx);
	await tick();
	harness.children[0].message({ id: "q1", kind: "query", message: "Which branch?" });
	await tick();
	const queries = sent.filter((entry) => entry.message.customType === "gentle-agents.message");
	assert.equal(queries.length, 1);
	assert.deepEqual(queries[0]!.options, { triggerTurn: false });
	assert.equal((queries[0]!.message.details as { gentleAgents?: { kind?: string } }).gentleAgents?.kind, "query", "the query keeps its structured details");
	assert.match(String(queries[0]!.message.content), /Which branch\?/);
	assert.equal(userMessages.length, 1);
	assert.doesNotMatch(String(userMessages[0]!.content), /Which branch\?/, "the wake never duplicates the child question");
	assert.deepEqual(delivery, ["custom:gentle-agents.message", "user"]);
	await fire("session_shutdown", ctx);
});

// Pi reports a compaction without an agent run as not idle, yet it is not
// streaming either: a steer + triggerTurn message would then start a direct
// custom-message turn that skips before_agent_start. Child content is held
// instead and delivered once the compaction boundary leaves the parent idle.
for (const boundary of ["session_compact", "session_compact_failed"] as const) {
	test(`a parent compacting outside an agent run holds child content until ${boundary}, then wakes it through the prompt lifecycle`, async () => {
		const { pi, tools, fire, sent, userMessages, delivery, setIdle } = fakePi();
		const harness = deps();
		const timers = recordTimers(harness.deps);
		gentleAgents(pi, {}, harness.deps);
		const { ctx } = fakeContext();
		await fire("session_start", ctx);
		await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Asks during compaction", mode: "background" }, undefined, undefined, ctx);
		await tools.get("subagent_run")!.execute("c2", { agent: "explore", task: "Ends during compaction", mode: "background" }, undefined, undefined, ctx);
		await tick();
		setIdle(false);
		harness.children[0].message({ id: "q1", kind: "query", message: "Which branch?" });
		harness.children[1].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
		harness.children[1].emit({ type: "agent_settled" });
		await tick();
		assert.equal(sent.length, 0, "no direct custom-message turn starts while the parent compacts");
		assert.equal(userMessages.length, 0, "no wake is sent while the parent compacts");
		assert.equal(harness.children[0].sent.filter((frame) => (frame as { id?: string }).id === "q1").length, 0, "a held query is not rejected back to the child");
		await fire(boundary, ctx);
		assert.equal(sent.length, 0, "the boundary handler runs before Pi leaves the compacting state");
		setIdle(true);
		assert.equal(timers.run(0), 1, "one deferred flush is scheduled for the compaction boundary");
		await tick();
		assert.deepEqual(sent.map((entry) => entry.options), [{ triggerTurn: false }, { triggerTurn: false }], "held content is stored without a direct turn");
		assert.equal((sent[0]!.message.details as { gentleAgents?: { kind?: string } }).gentleAgents?.kind, "query", "the held query keeps its structured details");
		assert.deepEqual(delivery, ["custom:gentle-agents.message", "custom:gentle-agents.result", "user"], "one wake follows all held content");
		await fire("session_shutdown", ctx);
	});
}

test("between agent_end and agent_settled the parent run is still active, so child content keeps the steer route", async () => {
	const { pi, tools, fire, sent, userMessages } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Post-run window", mode: "background" }, undefined, undefined, ctx);
	await tick();
	await fire("agent_start", ctx);
	await fire("agent_end", ctx);
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.deepEqual(sent.map((entry) => entry.options), [{ deliverAs: "steer", triggerTurn: true }]);
	assert.equal(userMessages.length, 0);
	await fire("session_shutdown", ctx);
});

// sendUserMessage is fire-and-forget: an input handler can swallow the wake,
// or the host can reject it, and neither emits an extension event. A wake
// that never starts a run must not suppress later wakes beyond a bounded grace.
test("a handled or rejected wake never suppresses later deliveries beyond the bounded grace", async () => {
	const { pi, tools, fire, sent, userMessages } = fakePi();
	const harness = deps();
	const timers = recordTimers(harness.deps);
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	for (const [index, task] of ["First", "Second", "Third"].entries()) {
		await tools.get("subagent_run")!.execute(`c${index}`, { agent: "explore", task, mode: "background" }, undefined, undefined, ctx);
	}
	await tick();
	const finish = async (index: number) => {
		harness.children[index]!.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
		harness.children[index]!.emit({ type: "agent_settled" });
		await tick();
	};
	await finish(0);
	assert.equal(userMessages.length, 1, "the first idle completion wakes the parent");
	assert.equal(timers.pending(PARENT_WAKE_GRACE_MS), 1, "the wake arms one bounded grace");
	// The wake was handled without starting a run: no agent_start ever fires.
	assert.equal(timers.run(PARENT_WAKE_GRACE_MS), 1);
	await tick();
	assert.equal(userMessages.length, 1, "an expired grace with nothing new to report sends no wake");
	await finish(1);
	assert.equal(userMessages.length, 2, "a later completion wakes the parent again");
	await finish(2);
	assert.equal(sent.length, 3, "every completion is stored once");
	assert.equal(userMessages.length, 2, "a completion stored while a wake is in flight shares that wake");
	assert.equal(timers.run(PARENT_WAKE_GRACE_MS), 1);
	await tick();
	assert.equal(userMessages.length, 3, "content stored behind a wake that never started a run gets its own wake after the grace");
	assert.equal(sent.length, 3, "no completion is stored twice");
	await fire("session_shutdown", ctx);
});

test("a wake that throws synchronously fails closed without blocking the next wake", async () => {
	const { pi, tools, fire, sent, userMessages } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Throwing wake", mode: "background" }, undefined, undefined, ctx);
	await tools.get("subagent_run")!.execute("c2", { agent: "explore", task: "Next wake", mode: "background" }, undefined, undefined, ctx);
	await tick();
	const sendUserMessage = pi.sendUserMessage;
	Object.assign(pi, { sendUserMessage: () => { throw new Error("stale runtime"); } });
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.length, 1, "the completion is stored before the wake fails");
	Object.assign(pi, { sendUserMessage });
	harness.children[1].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	harness.children[1].emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.length, 2);
	assert.equal(userMessages.length, 1, "a failed wake leaves no starting state behind");
	await fire("session_shutdown", ctx);
});

test("a delivery while a parent prompt is starting is stored for that run without an extra wake", async () => {
	const { pi, tools, fire, sent, userMessages } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "During prompt start", mode: "background" }, undefined, undefined, ctx);
	await tick();
	// Pi stays idle between before_agent_start and the run it starts.
	await fire("before_agent_start", ctx, { type: "before_agent_start", prompt: "user prompt" });
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.deepEqual(sent.map((entry) => entry.options), [{ triggerTurn: false }], "the completion is stored for the starting run");
	assert.equal(userMessages.length, 0, "no second prompt races the one already starting");
	await fire("agent_start", ctx);
	await fire("agent_end", ctx);
	await fire("agent_settled", ctx);
	await tick();
	assert.equal(userMessages.length, 0, "the run that started already carried the stored completion");
	await fire("session_shutdown", ctx);
});

test("a stale parent context fails closed: child completions and notifications are not delivered", async () => {
	const { pi, tools, fire, sent, userMessages } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Stale", mode: "background" }, undefined, undefined, ctx);
	await tick();
	Object.assign(ctx, { isIdle: () => { throw new Error("This extension ctx is stale after session replacement or reload."); } });
	harness.children[0].message({ id: "n1", kind: "notification", message: "progress" });
	harness.children[0].message({ id: "q1", kind: "query", message: "Proceed?" });
	await tick();
	// Notifications keep their existing best-effort, at-most-once contract;
	// a query is the delivery that fails visibly back to the child.
	assert.deepEqual(harness.children[0].sent.filter((frame) => (frame as { id?: string }).id === "q1"), [{ id: "q1", kind: "reply", error: "parent rejected query" }], "the child learns its query was not delivered");
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.length, 0, "nothing is delivered through a stale context");
	assert.equal(userMessages.length, 0, "no wake is sent through a stale context");
	await fire("session_shutdown", ctx);
});

test("a completion held past the stale window keeps its report out of the conversation and shows the human a stale card", async () => {
	const { pi, tools, fire, sent, entries, entryRenderers } = fakePi();
	const harness = deps();
	let clock = 1000;
	harness.deps.now = () => clock;
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const started = await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Slow orchestrator", mode: "background" }, undefined, undefined, ctx);
	const id = (started.details.gentleAgents as { taskId: string }).taskId;
	await tick();
	await fire("agent_start", ctx);
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Late answer." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	clock += STALE_COMPLETION_MS + 1_000;
	await fire("turn_end", ctx);
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 0, "a stale completion never enters the model context");
	const stale = entries.filter((entry) => entry.customType === "gentle-agents.stale-result");
	assert.equal(stale.length, 1, "the human still sees the stale completion as durable transcript content");
	assert.match(JSON.stringify(stale[0]!.data), new RegExp(id), "the stale notice names the task");
	const rendered = entryRenderers.get("gentle-agents.stale-result")!(stale[0]!, { expanded: true }, plainTheme).render(90).map(stripAnsi).join("\n");
	assert.match(rendered, /stale/i);
	assert.match(rendered, new RegExp(id));
	assert.match(rendered, /explore/);
	assert.match(rendered, /ago/);
	await fire("session_shutdown", ctx);
});

// Issue #1821/#1092: the parent is told never to poll, so an unread stale
// completion must still tell the model a result is waiting, without replaying
// the report itself.
test("an unread completion held past the stale window steers a compact notice into the running parent", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	let clock = 1000;
	harness.deps.now = () => clock;
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const started = await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Long tool call", mode: "background" }, undefined, undefined, ctx);
	const id = (started.details.gentleAgents as { taskId: string }).taskId;
	await tick();
	await fire("agent_start", ctx);
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Late answer." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	clock += STALE_COMPLETION_MS + 1_000;
	await fire("turn_end", ctx);
	const notices = sent.filter((entry) => entry.message.customType === "gentle-agents.stale-notice");
	assert.equal(notices.length, 1, "the model is told once that an unread result is waiting");
	assert.deepEqual(notices[0]!.options, { deliverAs: "steer", triggerTurn: true });
	const content = String(notices[0]!.message.content);
	assert.match(content, new RegExp(id));
	assert.match(content, /subagent_result/);
	assert.doesNotMatch(content, /Late answer\./, "the stale report itself is never replayed");
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 0);
	await fire("turn_end", ctx);
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.stale-notice").length, 1, "the notice is sent at most once");
	await fire("session_shutdown", ctx);
});

test("an unread stale completion flushed at an idle boundary stores its notice and wakes the parent", async () => {
	const { pi, tools, fire, sent, userMessages, setIdle } = fakePi();
	const harness = deps();
	let clock = 1000;
	harness.deps.now = () => clock;
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Ends idle", mode: "background" }, undefined, undefined, ctx);
	await tick();
	await fire("agent_start", ctx);
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Late answer." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	clock += STALE_COMPLETION_MS + 1_000;
	setIdle(true);
	await fire("agent_end", ctx);
	await tick();
	const notices = sent.filter((entry) => entry.message.customType === "gentle-agents.stale-notice");
	assert.equal(notices.length, 1);
	assert.deepEqual(notices[0]!.options, { triggerTurn: false });
	assert.equal(userMessages.length, 1, "an idle parent is woken instead of waiting forever");
	await fire("session_shutdown", ctx);
});

test("a completion whose forwarding throws stays queued and is delivered at the next boundary", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Flaky host", mode: "background" }, undefined, undefined, ctx);
	await tick();
	await fire("agent_start", ctx);
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Retried answer." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	const sendMessage = pi.sendMessage;
	Object.assign(pi, { sendMessage: () => { throw new Error("host busy"); } });
	await fire("turn_end", ctx);
	assert.equal(sent.length, 0);
	Object.assign(pi, { sendMessage });
	await fire("turn_end", ctx);
	const results = sent.filter((entry) => entry.message.customType === "gentle-agents.result");
	assert.equal(results.length, 1, "a failed forward is retried, not lost");
	assert.match(String(results[0]!.message.content), /Retried answer\./);
	await fire("turn_end", ctx);
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 1, "a delivered completion is never sent twice");
	await fire("session_shutdown", ctx);
});

test("a completion whose forwarding throws while the parent is idle is retried after the bounded grace", async () => {
	const { pi, tools, fire, sent, userMessages } = fakePi();
	const harness = deps();
	const timers = recordTimers(harness.deps);
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Idle flaky host", mode: "background" }, undefined, undefined, ctx);
	await tick();
	const sendMessage = pi.sendMessage;
	Object.assign(pi, { sendMessage: () => { throw new Error("host busy"); } });
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Idle retried answer." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.length, 0);
	assert.equal(userMessages.length, 0);
	Object.assign(pi, { sendMessage });
	// No turn boundary is coming for an idle parent, so the retry is a timer.
	assert.equal(timers.run(PARENT_WAKE_GRACE_MS), 1, "one bounded retry flush is armed");
	await tick();
	const results = sent.filter((entry) => entry.message.customType === "gentle-agents.result");
	assert.equal(results.length, 1, "the requeued completion reaches the idle parent");
	assert.match(String(results[0]!.message.content), /Idle retried answer\./);
	assert.equal(userMessages.length, 1, "and the idle parent is woken for it");
	// Only the dispatched wake's own grace remains; expiring it resends nothing.
	assert.equal(timers.run(PARENT_WAKE_GRACE_MS), 1);
	await tick();
	assert.equal(sent.length, 1, "a successful retry never delivers the completion twice");
	assert.equal(userMessages.length, 1);
	await fire("session_shutdown", ctx);
});

test("retries for a failing idle delivery stop after the bounded limit", async () => {
	const { pi, tools, fire, sent, userMessages } = fakePi();
	const harness = deps();
	const timers = recordTimers(harness.deps);
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Broken host", mode: "background" }, undefined, undefined, ctx);
	await tick();
	Object.assign(pi, { sendUserMessage: () => { throw new Error("host rejected prompt"); } });
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	let retries = 0;
	while (timers.run(PARENT_WAKE_GRACE_MS) > 0) {
		retries += 1;
		await tick();
		assert.ok(retries <= 3, "a permanently failing wake never retries forever");
	}
	assert.equal(retries, 3);
	assert.equal(sent.length, 1, "retries never store the completion twice");
	assert.equal(userMessages.length, 0);
	await fire("session_shutdown", ctx);
});

test("a wake that throws stays owed and is retried after the bounded grace", async () => {
	const { pi, tools, fire, sent, userMessages } = fakePi();
	const harness = deps();
	const timers = recordTimers(harness.deps);
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Lost wake", mode: "background" }, undefined, undefined, ctx);
	await tick();
	const sendUserMessage = pi.sendUserMessage;
	Object.assign(pi, { sendUserMessage: () => { throw new Error("host rejected prompt"); } });
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.length, 1, "the completion is stored before the wake fails");
	assert.equal(userMessages.length, 0);
	Object.assign(pi, { sendUserMessage });
	assert.equal(timers.run(PARENT_WAKE_GRACE_MS), 1, "one bounded retry is armed");
	await tick();
	assert.equal(userMessages.length, 1, "the idle parent is finally woken");
	assert.equal(sent.length, 1, "the retry wakes without storing the completion again");
	await fire("session_shutdown", ctx);
});

test("a completion the parent already pulled is dropped silently at the next turn end", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	const started = await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Pulled early", mode: "background" }, undefined, undefined, ctx);
	const id = (started.details.gentleAgents as { taskId: string }).taskId;
	await tick();
	await fire("agent_start", ctx);
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Pulled answer." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 0);
	assert.match((await tools.get("subagent_result")!.execute("c2", { task_id: id }, undefined, undefined, ctx)).content[0].text, /Pulled answer\./);
	await fire("turn_end", ctx);
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 0, "a consumed completion is dropped instead of replayed");
	await fire("session_shutdown", ctx);
});

test("a session restart never replays a completion still pending from before it", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Restarted", mode: "background" }, undefined, undefined, ctx);
	await tick();
	await fire("agent_start", ctx);
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Unclaimed answer." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 0);
	await fire("session_start", ctx, { reason: "resume" });
	await fire("turn_end", ctx);
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 0, "a resumed session starts with an empty completion queue");
	await fire("session_shutdown", ctx);
});

test("a background completion owned by a prior session is dropped, never delivered into the current session", async () => {
	const { pi, tools, fire, sent, entries } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Cross session", mode: "background" }, undefined, undefined, ctx);
	await tick();
	(ctx.sessionManager as { getSessionId(): string }).getSessionId = () => "s2";
	await fire("session_start", ctx, { type: "session_start", reason: "new" });
	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Cross answer." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();
	await fire("turn_end", ctx);
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.result").length, 0, "the replacement session receives no completion it does not own");
	assert.equal(entries.filter((entry) => entry.customType === "gentle-agents.stale-result").length, 0);
	await fire("session_shutdown", ctx);
});

test("aborting the caller's signal cancels the subagent, records it, and says why", async () => {
	const { pi, tools, fire } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx, dialogs } = fakeContext();
	await fire("session_start", ctx);
	const controller = new AbortController();
	const pending = tools.get("subagent_run")!.execute("abort", { agent: "explore", task: "keep working" }, controller.signal, undefined, ctx);
	await tick();
	controller.abort();
	await tick();
	const yielded = await pending;
	const details = (yielded.details as { gentleAgents?: { taskId: string; status: string } }).gentleAgents!;
	assert.equal(details.status, "cancelled", "the run is recorded as cancelled");
	assert.match((yielded as { content: Array<{ text: string }> }).content[0].text, /cancelled/);
	assert.ok(
		dialogs.some((entry) => entry.startsWith("notify:") && /cancelled/.test(entry) && /tool call was aborted/.test(entry)),
		"a warning names the abort and the cancellation",
	);
	assert.equal(harness.children[0].killed.length > 0, true, "the runner terminated the child");
});

test("issue #1162: notifications from a child that settles during parent turn are dropped and never re-enter conversation", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);

	const started = await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Worker task", mode: "background" }, undefined, undefined, ctx);
	const id = (started.details.gentleAgents as { taskId: string }).taskId;
	await tick();

	await fire("agent_start", ctx);

	harness.children[0].message({ id: "n1", kind: "notification", message: "Step 1 progress" });
	await tick();

	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Finished successfully." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();

	assert.equal(sent.length, 0, "nothing sent mid-turn while active parent agent runs");

	await fire("turn_end", ctx);

	const results = sent.filter((entry) => entry.message.customType === "gentle-agents.result");
	const notifications = sent.filter((entry) => entry.message.customType === "gentle-agents.message");
	assert.equal(results.length, 1, "completion is delivered");
	assert.equal(notifications.length, 0, "stale notification from settled task is dropped");
	assert.deepEqual(results[0]!.options, { deliverAs: "steer", triggerTurn: true });

	await fire("turn_end", ctx);
	await fire("agent_end", ctx);
	assert.equal(sent.filter((entry) => entry.message.customType === "gentle-agents.message").length, 0, "notification never replays");
	await fire("session_shutdown", ctx);
});

test("issue #1162: a live notification on a running child is delivered promptly at turn_end via steer", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);

	const started = await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Long runner", mode: "background" }, undefined, undefined, ctx);
	await tick();

	await fire("agent_start", ctx);
	harness.children[0].message({ id: "n1", kind: "notification", message: "Live status update" });
	await tick();

	await fire("turn_end", ctx);

	const notifications = sent.filter((entry) => entry.message.customType === "gentle-agents.message");
	assert.equal(notifications.length, 1, "live notification is delivered at turn_end");
	assert.equal(notifications[0]!.message.content, "Live status update");
	assert.deepEqual(notifications[0]!.options, { deliverAs: "steer", triggerTurn: true });

	await fire("session_shutdown", ctx);
});

test("issue #1162: an answered subagent query is dropped and never replays after task completion", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);

	const started = await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Interactive worker", mode: "background" }, undefined, undefined, ctx);
	const id = (started.details.gentleAgents as { taskId: string }).taskId;
	await tick();

	await fire("agent_start", ctx);
	harness.children[0].message({ id: "q1", kind: "query", message: "Confirm deletion?" });
	await tick();

	const replyResult = await tools.get("subagent_reply")!.execute("r1", { task_id: id, request_id: "q1", message: "yes proceed" }, undefined, undefined, ctx);
	assert.match(replyResult.content[0].text, /accepted/);

	harness.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Done after reply." }] }] });
	harness.children[0].emit({ type: "agent_settled" });
	await tick();

	await fire("turn_end", ctx);

	const queries = sent.filter((entry) => entry.message.customType === "gentle-agents.message" && (entry.message.details as { gentleAgents?: { kind?: string } })?.gentleAgents?.kind === "query");
	assert.equal(queries.length, 0, "answered query is never delivered to the model");

	const results = sent.filter((entry) => entry.message.customType === "gentle-agents.result");
	assert.equal(results.length, 1, "completion is delivered");

	await fire("session_shutdown", ctx);
});

test("issue #1162: a rejected query reply preserves the live query for delivery at turn boundary", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);

	const started = await tools.get("subagent_run")!.execute("c1", { agent: "explore", task: "Interactive worker", mode: "background" }, undefined, undefined, ctx);
	const id = (started.details.gentleAgents as { taskId: string }).taskId;
	await tick();

	await fire("agent_start", ctx);
	harness.children[0].message({ id: "q1", kind: "query", message: "Confirm deletion?" });
	await tick();

	const wrongSessionCtx = {
		...ctx,
		sessionManager: {
			...ctx.sessionManager,
			getSessionId: () => "wrong-session",
		},
	};
	const rejectedResult = await tools.get("subagent_reply")!.execute("r1", { task_id: id, request_id: "q1", message: "unauthorized" }, undefined, undefined, wrongSessionCtx as typeof ctx);
	assert.match(rejectedResult.content[0].text, /unavailable/);

	await fire("turn_end", ctx);

	const queries = sent.filter((entry) => entry.message.customType === "gentle-agents.message" && (entry.message.details as { gentleAgents?: { kind?: string } })?.gentleAgents?.kind === "query");
	assert.equal(queries.length, 1, "query is delivered to the parent session at turn_end");
	assert.match(String(queries[0].message.content), /Confirm deletion\?/);

	await fire("session_shutdown", ctx);
});

test("issue #1162: task-mode subagent_run includes question directly in waiting result and avoids duplicate delivery", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	gentleAgents(pi, {}, harness.deps);
	const { ctx } = fakeContext();
	await fire("session_start", ctx);

	await fire("agent_start", ctx);
	const pending = tools.get("subagent_run")!.execute("foreground", { agent: "explore", task: "Ask question directly" }, undefined, undefined, ctx);
	await tick();

	harness.children[0].message({ id: "q1", kind: "query", message: "Which directory should I inspect?" });
	const yielded = await pending;

	assert.equal((yielded as { terminate?: boolean }).terminate, true);
	assert.match(yielded.content[0].text, /Subagent explore is waiting for your reply to request q1/);
	assert.match(yielded.content[0].text, /Question:\nWhich directory should I inspect\?/);
	assert.equal((yielded.details as { gentleAgents?: { question?: string } })?.gentleAgents?.question, "Which directory should I inspect?");

	await fire("turn_end", ctx);

	const queries = sent.filter((entry) => entry.message.customType === "gentle-agents.message");
	assert.equal(queries.length, 0, "directly handed-off query is not sent as duplicate message");

	await fire("session_shutdown", ctx);
});


// gentle-shell#1587: children do not load the gentle-pi package in the
// isolated Gentle Shell home, so every child receives the child-context
// extension explicitly through --extension.
test("children receive context and safety extensions, and missing files are omitted", async () => {
	const expected = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "child-context.ts");
	const safety = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "child-safety.ts");
	// gentle-shell#1731 T32: the nan provider is registered by a gentle-pi
	// extension, so a child routed to nan/* could not resolve its model.
	const nanProvider = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "nan-provider.ts");
	assert.deepEqual(childContextExtensionPaths(), [resolve(expected), resolve(safety), resolve(nanProvider)]);
	assert.deepEqual(childContextExtensionPaths(() => false), [], "a missing extension file fails safe to no --extension");
	const extensionArguments = (args: string[]) => args.filter((_, index) => args[index - 1] === "--extension");
	for (const scenario of ["present", "missing"] as const) {
		const h = fakePi();
		const runtime = deps();
		if (scenario === "missing") runtime.deps.childExtensionPaths = [];
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		await h.fire("session_start", ctx);
		try {
			await h.tools.get("subagent_run")!.execute(`child-context-${scenario}`, { agent: "explore", task: "Map", mode: "background" }, undefined, undefined, ctx);
			await tick();
			assert.equal(runtime.spawned.length, 1);
			assert.deepEqual(extensionArguments(runtime.spawned[0]!), scenario === "present" ? [resolve(expected), resolve(safety), resolve(nanProvider)] : []);
		} finally {
			await h.fire("session_shutdown", ctx);
			await tick();
		}
	}
});

// gentle-shell#1713 (review R3-001): prove the subagent_continue wiring end to
// end, not only the helper. A writer follow-up without its own section reaches
// the child with the surfaces its original launch was admitted with.
test("a writer continuation without its own section inherits the admitted surfaces end to end", async () => {
	const h = fakePi();
	const runtime = deps();
	const profile = mkdtempSync(join(tmpdir(), "gentle-agents-continue-"));
	mkdirSync(join(profile, "agents"), { recursive: true });
	writeFileSync(join(profile, "agents", "gentle-ai-worker.md"), readFileSync(new URL("../assets/agents/gentle-ai-worker.md", import.meta.url)));
	writeFileSync(join(profile, "subagents.json"), JSON.stringify({ model_profiles: { "gentle-ai-worker": { model: "openai/gpt-4o", effort: "high" } } }));
	const env: NodeJS.ProcessEnv = {};
	gentleAgents(h.pi, env, { ...runtime.deps, env, agentHome: profile });
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const launched = h.tools.get("subagent_run")!.execute("run", { agent: "gentle-ai-worker", task: "Do T2.\n\n## Allowed edit surfaces\n- src/app.ts\n- `docs/with space.md`\n\n## Return\nReport", mode: "task" }, undefined, undefined, ctx);
	await tick();
	runtime.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }] }] });
	runtime.children[0].emit({ type: "agent_settled" });
	const taskId = ((await launched).details.gentleAgents as { taskId: string }).taskId;
	const continued = h.tools.get("subagent_continue")!.execute("follow", { task_id: taskId, prompt: "Continue with the remaining specs.", mode: "task" }, undefined, undefined, ctx);
	await tick();
	assert.equal(runtime.children.length, 2, "the continuation is admitted instead of rejected");
	const prompt = String(runtime.children[1].written.find(frame => typeof frame.message === "string")?.message);
	assert.match(prompt, /^Continue with the remaining specs\.\n\n## Allowed edit surfaces\n`docs\/with space\.md`\n`src\/app\.ts`\n/);
	runtime.children[1].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	runtime.children[1].emit({ type: "agent_settled" });
	await continued;
	await h.fire("session_shutdown", ctx);
	rmSync(profile, TEST_DIR_REMOVAL);
});

// #1690: the launcher's injection signal in the host env replaces the curated
// child entries; without a valid signal children keep the curated entries.
test("children receive the launcher's package injection instead of the curated entries", async () => {
	const curated = ["/curated/child-context.ts", "/curated/child-safety.ts"];
	const takeover = ["/agent/npm/node_modules/other", "/agent/extensions/a b.ts", "/pkg"];
	const scenarios: Array<{ name: string; value: string | undefined; expected: string[] }> = [
		{ name: "takeover", value: encodeChildPackageInjection({ noExtensions: true, extensionPaths: takeover }), expected: ["--no-extensions", ...takeover.flatMap((path) => ["--extension", path])] },
		{ name: "package-root", value: encodeChildPackageInjection({ noExtensions: false, extensionPaths: ["/pkg"] }), expected: ["--extension", "/pkg"] },
		{ name: "absent", value: undefined, expected: curated.flatMap((path) => ["--extension", path]) },
		{ name: "malformed", value: JSON.stringify({ version: 1, noExtensions: true, extensionPaths: ["relative/pkg"] }), expected: curated.flatMap((path) => ["--extension", path]) },
	];
	for (const scenario of scenarios) {
		const h = fakePi();
		const runtime = deps();
		runtime.deps.childExtensionPaths = curated;
		runtime.deps.env = { PATH: "/bin", ...(scenario.value === undefined ? {} : { [CHILD_PACKAGE_INJECTION_ENV]: scenario.value }) };
		gentleAgents(h.pi, {}, runtime.deps);
		const { ctx } = fakeContext();
		await h.fire("session_start", ctx);
		try {
			await h.tools.get("subagent_run")!.execute(`injection-${scenario.name}`, { agent: "explore", task: "Map", mode: "background" }, undefined, undefined, ctx);
			await tick();
			assert.equal(runtime.spawned.length, 1, scenario.name);
			const argv = runtime.spawned[0]!;
			const start = argv.indexOf("--session-dir") + 2;
			assert.deepEqual(argv.slice(start, start + scenario.expected.length), scenario.expected, scenario.name);
			assert.equal(argv[start + scenario.expected.length], "--model", `${scenario.name}: no other extension arguments`);
			assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,subagent_parent_message", scenario.name);
		} finally {
			await h.fire("session_shutdown", ctx);
			await tick();
		}
	}
});

// gentle-shell#1731 T4 (S2, AC6): subagent_run and subagent_continue admit a
// writer only while no live writer in the same worktree claims an overlapping
// `## Allowed edit surfaces` entry; read-only agents are never registered.
test("parallel writers are admitted only with disjoint Allowed edit surfaces end to end", async () => {
	const h = fakePi();
	const runtime = deps();
	const profile = mkdtempSync(join(tmpdir(), "gentle-agents-parallel-writers-"));
	mkdirSync(join(profile, "agents"), { recursive: true });
	writeFileSync(join(profile, "agents", "gentle-ai-worker.md"), readFileSync(new URL("../assets/agents/gentle-ai-worker.md", import.meta.url)));
	writeFileSync(join(profile, "agents", "explore.md"), "---\ndescription: maps things\ntools: [read, grep]\n---\nYou map things.");
	writeFileSync(join(profile, "subagents.json"), JSON.stringify({ max_concurrency: 5, model_profiles: { "gentle-ai-worker": { model: "openai/gpt-4o", effort: "high" } } }));
	const env: NodeJS.ProcessEnv = {};
	gentleAgents(h.pi, env, { ...runtime.deps, env, agentHome: profile });
	const { ctx } = fakeContext();
	await h.fire("session_start", ctx);
	const scoped = (surface: string) => `Write it.\n\n## Allowed edit surfaces\n${surface}\n\n## Return\nReport`;
	const run = (agent: string, task: string) => h.tools.get("subagent_run")!.execute("run", { agent, task, mode: "background" }, undefined, undefined, ctx);
	const taskId = (result: { details: Record<string, unknown> }) => (result.details.gentleAgents as { taskId: string }).taskId;
	const finish = async (child: FakeChild, id: string) => {
		child.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
		child.emit({ type: "agent_settled" });
		for (let attempt = 0; attempt < 40; attempt++) {
			const status = await h.tools.get("subagent_status")!.execute("status", { task_id: id }, undefined, undefined, ctx);
			if ((status.details.gentleAgents as { status?: string } | undefined)?.status === TASK_STATUS.COMPLETED) return;
			await tick();
		}
		assert.fail(`task ${id} never completed`);
	};
	try {
		const app = taskId(await run("gentle-ai-worker", scoped("src/app.ts")));
		const other = taskId(await run("gentle-ai-worker", scoped("`src/other.ts`")));
		await tick();
		assert.equal(runtime.children.length, 2, "disjoint writers run concurrently");
		await assert.rejects(run("gentle-ai-worker", scoped("src/*.ts")), (error: Error) => {
			assert.match(error.message, new RegExp(`task ${app}`));
			assert.match(error.message, new RegExp(`task ${other}`));
			assert.match(error.message, /`src\/\*\.ts` overlaps `src\/app\.ts`/);
			return true;
		});
		await run("explore", "Map src/app.ts and src/other.ts");
		await tick();
		assert.equal(runtime.children.length, 3, "read-only agents are never blocked by live writers");
		await finish(runtime.children[0], app);
		// The continuation inherits src/app.ts and is admitted again only while no
		// live writer claims an overlapping entry.
		await assert.rejects(run("gentle-ai-worker", scoped("src/**")), new RegExp(`task ${other}`), "src/** still overlaps the live src/other.ts writer");
		const blocking = taskId(await run("gentle-ai-worker", scoped("src/app.ts")));
		await assert.rejects(h.tools.get("subagent_continue")!.execute("follow", { task_id: app, prompt: "Continue.", mode: "background" }, undefined, undefined, ctx), new RegExp(`task ${blocking}`));
		await finish(runtime.children[3], blocking);
		await h.tools.get("subagent_continue")!.execute("follow", { task_id: app, prompt: "Continue.", mode: "background" }, undefined, undefined, ctx);
		await tick();
		assert.equal(runtime.children.length, 5, "the continuation is admitted once its surfaces are free");
	} finally {
		await h.fire("session_shutdown", ctx);
		rmSync(profile, TEST_DIR_REMOVAL);
	}
});

// Second verify A1: writers claim surfaces under the canonical worktree root,
// so a writer spawned in the session's subdirectory cwd and one sent to the
// worktree root through workspace_root are compared.
test("a subdirectory session cwd and workspace_root of the same worktree share one writer key", async () => {
	const h = fakePi();
	const runtime = deps();
	const profile = mkdtempSync(join(tmpdir(), "gentle-agents-writer-root-"));
	mkdirSync(join(profile, "agents"), { recursive: true });
	writeFileSync(join(profile, "agents", "gentle-ai-worker.md"), readFileSync(new URL("../assets/agents/gentle-ai-worker.md", import.meta.url)));
	writeFileSync(join(profile, "subagents.json"), JSON.stringify({ max_concurrency: 5, model_profiles: { "gentle-ai-worker": { model: "openai/gpt-4o", effort: "high" } } }));
	const sub = join(cwd, "sub");
	mkdirSync(sub, { recursive: true });
	// Git semantics: any path inside the project resolves to the project root.
	const resolveWorktree = (path: string, base: string) => {
		const target = resolve(base, path);
		return { root: target === cwd || target.startsWith(`${cwd}${sep}`) ? cwd : target, commonDir: "/fixture/common" };
	};
	const env: NodeJS.ProcessEnv = {};
	gentleAgents(h.pi, env, { ...runtime.deps, resolveWorktree, env, agentHome: profile });
	const { ctx } = fakeContext();
	Object.assign(ctx, { cwd: sub, sessionManager: { getSessionId: () => "s1", getCwd: () => sub, getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined } });
	await h.fire("session_start", ctx);
	const task = "Write it.\n\n## Allowed edit surfaces\nsrc/app.ts\n\n## Return\nReport";
	try {
		const first = await h.tools.get("subagent_run")!.execute("run", { agent: "gentle-ai-worker", task, mode: "background" }, undefined, undefined, ctx);
		const firstId = (first.details.gentleAgents as { taskId: string }).taskId;
		await assert.rejects(h.tools.get("subagent_run")!.execute("run", { agent: "gentle-ai-worker", task, workspace_root: cwd, mode: "background" }, undefined, undefined, ctx), new RegExp(`task ${firstId}`));
	} finally {
		await h.fire("session_shutdown", ctx);
		rmSync(profile, TEST_DIR_REMOVAL);
	}
});

// Background jobs share the subagent parent delivery router: the exit notice
// is stored and woken like an idle completion, or steered into a running turn.
function fakeJobShell() {
	const runs: Array<{ command: string; onData(data: Buffer): void; signal?: AbortSignal; exit(code: number): void }> = [];
	const shell = () => ({
		operations: {
			exec: (command: string, _cwd: string, options: { onData(data: Buffer): void; signal?: AbortSignal }) => new Promise<{ exitCode: number | null }>((done, fail) => {
				options.signal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
				runs.push({ command, onData: options.onData, signal: options.signal, exit: (code) => done({ exitCode: code }) });
			}),
		},
	});
	const dir = mkdtempSync(join(tmpdir(), "gentle-jobs-agents-"));
	return { runs, shell, dir, cleanup: () => rmSync(dir, TEST_DIR_REMOVAL) };
}
// A job settles only after its log file closes, which takes real I/O turns.
const jobIo = () => new Promise((done) => setTimeout(done, 50));
const toolText = (result: { content: Array<{ text?: string }> }) => result.content.map((part) => part.text ?? "").join("\n");

test("bash_background returns at once, and an idle parent gets one stored exit notice and one wake", async () => {
	const { pi, tools, fire, sent, userMessages, delivery, renderers } = fakePi();
	const jobs = fakeJobShell();
	gentleAgents(pi, {}, { ...deps().deps, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
	const { ctx } = fakeContext();
	try {
		await fire("session_start", ctx);
		const started = toolText(await tools.get("bash_background")!.execute("b1", { command: "gh run watch 42 --exit-status", label: "CI" }, undefined, undefined, ctx));
		assert.match(started, /job-1/);
		assert.ok(started.includes(join(jobs.dir, "job-1.log")), "the output file path is returned");
		assert.match(started, /notified once/i);
		assert.equal(jobs.runs[0]!.command, "gh run watch 42 --exit-status");
		assert.equal(sent.length, 0, "nothing reaches the parent while the job runs");
		jobs.runs[0]!.onData(Buffer.from("check build: fail\n"));
		jobs.runs[0]!.exit(1);
		await eventually(
			() => sent.some((entry) => entry.message.customType === "gentle-jobs.notice") && userMessages.length > 0,
			"the closed job log must deliver its exit notice and wake before assertions",
		);
		const notices = sent.filter((entry) => entry.message.customType === "gentle-jobs.notice");
		assert.equal(notices.length, 1, "the exit is reported exactly once");
		assert.deepEqual(notices[0]!.options, { triggerTurn: false }, "an idle parent stores the notice without a direct turn");
		const content = String(notices[0]!.message.content);
		for (const expected of [/job-1/, /"CI"/, /exited with code 1/, /gh run watch 42 --exit-status/, /check build: fail/, /job-1\.log/]) assert.match(content, expected);
		assert.equal(userMessages.length, 1, "the idle parent is woken exactly once");
		assert.deepEqual(delivery, ["custom:gentle-jobs.notice", "user"], "the notice is stored before the wake");
		assert.match(renderers.get("gentle-jobs.notice")!(notices[0]!.message, { expanded: true }, plainTheme).render(70).map(stripAnsi).join("\n"), /exited with code 1/);
		await fire("turn_end", ctx);
		await fire("agent_settled", ctx);
		assert.equal(sent.length, 1, "later boundaries never replay the notice");
		assert.equal(userMessages.length, 1, "later boundaries never repeat the wake");
	} finally {
		await fire("session_shutdown", ctx);
		jobs.cleanup();
	}
});

test("a busy parent gets the exit notice steered into its run at the next turn boundary", async () => {
	const { pi, tools, fire, sent, userMessages } = fakePi();
	const jobs = fakeJobShell();
	gentleAgents(pi, {}, { ...deps().deps, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
	const { ctx } = fakeContext();
	try {
		await fire("session_start", ctx);
		await fire("agent_start", ctx);
		await tools.get("bash_background")!.execute("b1", { command: "make build" }, undefined, undefined, ctx);
		jobs.runs[0]!.exit(0);
		await jobIo();
		assert.equal(sent.length, 0, "a busy parent is not interrupted mid-tool-call");
		await fire("turn_end", ctx);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]!.options, { deliverAs: "steer", triggerTurn: true });
		assert.match(String(sent[0]!.message.content), /job-1 \("make build"\) exited with code 0/);
		assert.equal(userMessages.length, 0, "a running parent needs no wake");
	} finally {
		await fire("session_shutdown", ctx);
		jobs.cleanup();
	}
});

test("job_list and job_stop cover this session's jobs; stopped jobs send no notice and shutdown stops the rest", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const jobs = fakeJobShell();
	gentleAgents(pi, {}, { ...deps().deps, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
	const { ctx } = fakeContext();
	try {
		await fire("session_start", ctx);
		assert.match(toolText(await tools.get("job_list")!.execute("l0", {}, undefined, undefined, ctx)), /No background jobs/);
		await tools.get("bash_background")!.execute("b1", { command: "sleep 100", label: "long" }, undefined, undefined, ctx);
		await tools.get("bash_background")!.execute("b2", { command: "npm run dev" }, undefined, undefined, ctx);
		const listed = toolText(await tools.get("job_list")!.execute("l1", {}, undefined, undefined, ctx));
		assert.match(listed, /job-1 · running · long/);
		assert.match(listed, /job-2 · running · npm run dev/);
		assert.match(toolText(await tools.get("job_stop")!.execute("s1", { job_id: "job-1" }, undefined, undefined, ctx)), /Stopped job-1/);
		assert.equal(jobs.runs[0]!.signal?.aborted, true, "the job's process tree is killed");
		await assert.rejects(async () => tools.get("job_stop")!.execute("s2", { job_id: "job-9" }, undefined, undefined, ctx), /No background job job-9 in this session/);
		await jobIo();
		assert.equal(sent.length, 0, "a stopped job sends no exit notice");
		assert.match(toolText(await tools.get("job_list")!.execute("l2", {}, undefined, undefined, ctx)), /job-1 · stopped · long/);
		await fire("session_shutdown", ctx);
		assert.equal(jobs.runs[1]!.signal?.aborted, true, "session shutdown stops every running job");
		await jobIo();
		assert.equal(sent.length, 0);
	} finally {
		jobs.cleanup();
	}
});

test("/gentle:jobs opens this session's jobs overlay, stops the selected job, and the footer counts running jobs", async () => {
	const { pi, tools, commands, fire, sent } = fakePi();
	const jobs = fakeJobShell();
	gentleAgents(pi, {}, { ...deps().deps, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
	const { ctx, overlays } = fakeContext();
	const statuses: Array<string | undefined> = [];
	const snapshots: Array<{ sessionId: string; snapshot: { jobs: Array<{ id: string; label: string; startedAt: number }> } }> = [];
	const unsubscribe = pi.events.on("gentle-ai:jobs-sidebar", (value) => { snapshots.push(value as typeof snapshots[number]); });
	Object.assign(ctx.ui, { setStatus: (key: string, value: string | undefined) => { if (key === "gentle-jobs") statuses.push(value); } });
	try {
		await fire("session_start", ctx);
		await tools.get("bash_background")!.execute("b1", { command: "gh run watch 42 --exit-status", label: "CI" }, undefined, undefined, ctx);
		assert.equal(statuses.at(-1), "⧗ 1 job");
		assert.equal(snapshots.at(-1)?.sessionId, ctx.sessionManager.getSessionId());
		assert.deepEqual(snapshots.at(-1)?.snapshot.jobs.map(({ id, label }) => ({ id, label })), [{ id: "job-1", label: "CI" }]);
		const opened = commands.get("gentle:jobs")!.handler("", ctx);
		await tick();
		const view = overlays.at(-1)!;
		const screen = view.render(100).map(stripAnsi).join("\n");
		assert.match(screen, /Jobs · 1 running · 0 finished/);
		assert.match(screen, /gh run watch 42 --exit-status/);
		view.handleInput("s");
		assert.equal(jobs.runs[0]!.signal?.aborted, true, "s stops the selected job");
		assert.equal(statuses.at(-1), undefined, "the footer count clears when nothing runs");
		assert.deepEqual(snapshots.at(-1)?.snapshot.jobs, [], "the Status descriptions clear when nothing runs");
		await jobIo();
		const notices = sent.filter((entry) => entry.message.customType === "gentle-jobs.notice");
		assert.equal(notices.length, 1, "the agent was told it would be notified, so a human stop is reported once");
		assert.match(String(notices[0]!.message.content), /job-1 \("CI"\) was stopped by the user/);
		view.handleInput("q");
		await opened;
	} finally {
		unsubscribe();
		await fire("session_shutdown", ctx);
		jobs.cleanup();
	}
});

test("a job exit notice whose forwarding throws while the parent is idle is retried after the bounded grace", async () => {
	const { pi, tools, fire, sent, userMessages } = fakePi();
	const harness = deps();
	const timers = recordTimers(harness.deps);
	const jobs = fakeJobShell();
	gentleAgents(pi, {}, { ...harness.deps, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
	const { ctx } = fakeContext();
	try {
		await fire("session_start", ctx);
		await tools.get("bash_background")!.execute("b1", { command: "make ci" }, undefined, undefined, ctx);
		const sendMessage = pi.sendMessage;
		Object.assign(pi, { sendMessage: () => { throw new Error("host busy"); } });
		jobs.runs[0]!.exit(0);
		await jobIo();
		assert.equal(sent.length, 0);
		assert.equal(userMessages.length, 0);
		Object.assign(pi, { sendMessage });
		// No turn boundary is coming for an idle parent, so the retry is a timer.
		assert.equal(timers.run(PARENT_WAKE_GRACE_MS), 1, "one bounded retry flush is armed");
		await tick();
		const notices = sent.filter((entry) => entry.message.customType === "gentle-jobs.notice");
		assert.equal(notices.length, 1, "the requeued notice reaches the idle parent");
		assert.match(String(notices[0]!.message.content), /job-1 \("make ci"\) exited with code 0/);
		assert.equal(userMessages.length, 1, "and the idle parent is woken for it");
		assert.equal(timers.run(PARENT_WAKE_GRACE_MS), 1);
		await tick();
		assert.equal(sent.length, 1, "a successful retry never delivers the notice twice");
	} finally {
		await fire("session_shutdown", ctx);
		jobs.cleanup();
	}
});

for (const boundary of ["session_compact", "session_compact_failed"] as const) {
	test(`a parent compacting outside an agent run holds a job exit notice until ${boundary}, then wakes it`, async () => {
		const { pi, tools, fire, sent, userMessages, delivery, setIdle } = fakePi();
		const harness = deps();
		const timers = recordTimers(harness.deps);
		const jobs = fakeJobShell();
		gentleAgents(pi, {}, { ...harness.deps, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
		const { ctx } = fakeContext();
		try {
			await fire("session_start", ctx);
			await tools.get("bash_background")!.execute("b1", { command: "make ci" }, undefined, undefined, ctx);
			setIdle(false);
			jobs.runs[0]!.exit(1);
			await jobIo();
			assert.equal(sent.length, 0, "no direct custom-message turn starts while the parent compacts");
			assert.equal(userMessages.length, 0, "no wake is sent while the parent compacts");
			await fire(boundary, ctx);
			assert.equal(sent.length, 0, "the boundary handler runs before Pi leaves the compacting state");
			setIdle(true);
			assert.equal(timers.run(0), 1, "one deferred flush is scheduled for the compaction boundary");
			await tick();
			assert.deepEqual(sent.map((entry) => entry.options), [{ triggerTurn: false }], "the held notice is stored without a direct turn");
			assert.deepEqual(delivery, ["custom:gentle-jobs.notice", "user"], "one wake follows the held notice");
		} finally {
			await fire("session_shutdown", ctx);
			jobs.cleanup();
		}
	});
}

test("session shutdown removes the default background job log directory", async () => {
	const { pi, tools, fire } = fakePi();
	const jobs = fakeJobShell();
	gentleAgents(pi, {}, { ...deps().deps, jobShell: jobs.shell });
	const { ctx } = fakeContext();
	try {
		await fire("session_start", ctx);
		const started = toolText(await tools.get("bash_background")!.execute("b1", { command: "sleep 100" }, undefined, undefined, ctx));
		const outputPath = /Output: (.+)$/m.exec(started)![1]!;
		assert.ok(existsSync(dirname(outputPath)), "the job log directory exists while the session runs");
		await fire("session_shutdown", ctx);
		assert.equal(existsSync(dirname(outputPath)), false, "the job log directory is removed with the session");
	} finally {
		jobs.cleanup();
	}
});

test("session shutdown never hangs on a job whose process ignores the stop", { timeout: 5000 }, async () => {
	const { pi, tools, fire } = fakePi();
	const dir = mkdtempSync(join(tmpdir(), "gentle-jobs-stuck-"));
	// A process that never exits, even after its abort signal.
	const stuck = () => ({ operations: { exec: () => new Promise<{ exitCode: number | null }>(() => {}) } });
	const schedule: AgentsDeps["schedule"] = (fn, ms) => { const timer = setTimeout(fn, Math.min(ms, 10)); timer.unref(); return () => clearTimeout(timer); };
	gentleAgents(pi, {}, { ...deps().deps, schedule, jobShell: stuck });
	const { ctx } = fakeContext();
	try {
		await fire("session_start", ctx);
		await tools.get("bash_background")!.execute("b1", { command: "sleep 100" }, undefined, undefined, ctx);
		await fire("session_shutdown", ctx);
	} finally {
		rmSync(dir, TEST_DIR_REMOVAL);
	}
});

// A monitor reports output lines while it runs, through the same router.
test("monitor delivers line events to an idle parent with one wake, and reports its end with the event count", async () => {
	const { pi, tools, fire, sent, userMessages, renderers } = fakePi();
	const harness = deps();
	const timers = recordTimers(harness.deps);
	const jobs = fakeJobShell();
	gentleAgents(pi, {}, { ...harness.deps, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
	const { ctx } = fakeContext();
	try {
		await fire("session_start", ctx);
		const started = toolText(await tools.get("monitor")!.execute("m1", { command: "gh run watch 7", label: "CI checks", timeout_seconds: 900 }, undefined, undefined, ctx));
		assert.match(started, /Started monitor job-1 \("CI checks"\)/);
		assert.match(started, /900s/);
		jobs.runs[0]!.onData(Buffer.from("lint: pass\nunit: fail\n"));
		assert.equal(sent.length, 0, "lines wait for the batch window");
		assert.equal(timers.run(200), 1);
		await tick();
		const events = sent.filter((entry) => entry.message.customType === "gentle-jobs.notice");
		assert.equal(events.length, 1);
		assert.deepEqual(events[0]!.options, { triggerTurn: false });
		assert.match(String(events[0]!.message.content), /Monitor job-1 \("CI checks"\) reported 2 new lines:\nlint: pass\nunit: fail/);
		assert.equal(userMessages.length, 1, "the idle parent is woken for the events");
		assert.match(renderers.get("gentle-jobs.notice")!(events[0]!.message, { expanded: true }, plainTheme).render(70).map(stripAnsi).join("\n"), /unit: fail/);
		jobs.runs[0]!.onData(Buffer.from("e2e: pass\n"));
		jobs.runs[0]!.exit(1);
		await jobIo();
		const contents = sent.filter((entry) => entry.message.customType === "gentle-jobs.notice").map((entry) => String(entry.message.content));
		assert.equal(contents.length, 3, "pending lines are delivered before the end notice");
		assert.match(contents[1]!, /reported 1 new line:\ne2e: pass/);
		assert.match(contents[2]!, /Monitor job-1 \("CI checks"\) exited with code 1 after .* 3 events\./);
	} finally {
		await fire("session_shutdown", ctx);
		jobs.cleanup();
	}
});

test("monitor events wait for a busy parent's turn boundary and coalesce into one notice", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	const timers = recordTimers(harness.deps);
	const jobs = fakeJobShell();
	gentleAgents(pi, {}, { ...harness.deps, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
	const { ctx } = fakeContext();
	try {
		await fire("session_start", ctx);
		await fire("agent_start", ctx);
		await tools.get("monitor")!.execute("m1", { command: "tail -f log", timeout_seconds: 60 }, undefined, undefined, ctx);
		jobs.runs[0]!.onData(Buffer.from("ERROR a\n"));
		timers.run(200);
		jobs.runs[0]!.onData(Buffer.from("ERROR b\n"));
		timers.run(200);
		assert.equal(sent.length, 0, "a busy parent is not interrupted mid-tool-call");
		await fire("turn_end", ctx);
		assert.equal(sent.length, 1, "both batches arrive as one notice");
		assert.deepEqual(sent[0]!.options, { deliverAs: "steer", triggerTurn: true });
		assert.match(String(sent[0]!.message.content), /reported 2 new lines:\nERROR a\nERROR b/);
		// job_stop ends the monitor without any further notice.
		assert.match(toolText(await tools.get("job_stop")!.execute("s1", { job_id: "job-1" }, undefined, undefined, ctx)), /Stopped job-1/);
		jobs.runs[0]!.onData(Buffer.from("ERROR c\n"));
		timers.run(200);
		timers.run(60_000);
		await jobIo();
		await fire("turn_end", ctx);
		assert.equal(sent.length, 1, "a stopped monitor reports nothing more");
	} finally {
		await fire("session_shutdown", ctx);
		jobs.cleanup();
	}
});

test("monitor rejects a missing or out-of-range timeout before starting anything", async () => {
	const { pi, tools, fire } = fakePi();
	const jobs = fakeJobShell();
	gentleAgents(pi, {}, { ...deps().deps, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
	const { ctx } = fakeContext();
	try {
		await fire("session_start", ctx);
		for (const params of [{ command: "x" }, { command: "x", timeout_seconds: 0 }, { command: "x", timeout_seconds: 3600 }]) {
			await assert.rejects(async () => tools.get("monitor")!.execute("m", params, undefined, undefined, ctx), /timeout_seconds must be a whole number from 1 to 1800/);
		}
		assert.equal(jobs.runs.length, 0);
	} finally {
		await fire("session_shutdown", ctx);
		jobs.cleanup();
	}
});

test("events from two interleaved monitors coalesce per monitor while the parent is busy", async () => {
	const { pi, tools, fire, sent } = fakePi();
	const harness = deps();
	const timers = recordTimers(harness.deps);
	const jobs = fakeJobShell();
	gentleAgents(pi, {}, { ...harness.deps, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
	const { ctx } = fakeContext();
	try {
		await fire("session_start", ctx);
		await fire("agent_start", ctx);
		await tools.get("monitor")!.execute("m1", { command: "watch a", label: "A", timeout_seconds: 60 }, undefined, undefined, ctx);
		await tools.get("monitor")!.execute("m2", { command: "watch b", label: "B", timeout_seconds: 60 }, undefined, undefined, ctx);
		for (const round of [1, 2, 3]) {
			jobs.runs[0]!.onData(Buffer.from(`a${round}\n`));
			jobs.runs[1]!.onData(Buffer.from(`b${round}\n`));
			timers.run(200);
		}
		await fire("turn_end", ctx);
		const contents = sent.map((entry) => String(entry.message.content));
		assert.equal(contents.length, 2, "one notice per monitor, not one per batch");
		assert.match(contents[0]!, /\("A"\) reported 3 new lines:\na1\na2\na3/);
		assert.match(contents[1]!, /\("B"\) reported 3 new lines:\nb1\nb2\nb3/);
	} finally {
		await fire("session_shutdown", ctx);
		jobs.cleanup();
	}
});

test("a human stop of a monitor from /gentle:jobs delivers its pending lines, then one stop notice, then nothing", async () => {
	const { pi, tools, commands, fire, sent } = fakePi();
	const harness = deps();
	const timers = recordTimers(harness.deps);
	const jobs = fakeJobShell();
	gentleAgents(pi, {}, { ...harness.deps, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
	const { ctx, overlays } = fakeContext();
	try {
		await fire("session_start", ctx);
		await fire("agent_start", ctx);
		await tools.get("monitor")!.execute("m1", { command: "tail -f log", label: "log", timeout_seconds: 60 }, undefined, undefined, ctx);
		jobs.runs[0]!.onData(Buffer.from("ERROR seen\n"));
		const opened = commands.get("gentle:jobs")!.handler("", ctx);
		await tick();
		overlays.at(-1)!.handleInput("s");
		overlays.at(-1)!.handleInput("q");
		await opened;
		assert.equal(jobs.runs[0]!.signal?.aborted, true);
		jobs.runs[0]!.onData(Buffer.from("ERROR after stop\n"));
		timers.run(200);
		timers.run(60_000);
		await jobIo();
		await fire("turn_end", ctx);
		const contents = sent.map((entry) => String(entry.message.content));
		assert.equal(contents.length, 2, `notices: ${JSON.stringify(contents)}`);
		assert.match(contents[0]!, /reported 1 new line:\nERROR seen/);
		assert.match(contents[1]!, /Monitor job-1 \("log"\) was stopped by the user after .*, 1 event\./);
	} finally {
		await fire("session_shutdown", ctx);
		jobs.cleanup();
	}
});
