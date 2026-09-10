import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import installGentleShell, { buildShellBarModel, changesShortcut, devBinaryCard, fetchCodexUsage, fetchOpenCodeGoUsage, loadFileDiff, shellGitRunner, openInExternalEditor, type GentlePromptEditor } from "../extensions/gentle-shell.ts";
import { CHANGE_STATUS } from "../lib/shell-changes.ts";
import type { ShellBarTheme } from "../lib/shell-bar.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The Gentle Shell extension wires the pure bar renderer into pi's footer
// slot. These tests drive it with a fake ExtensionAPI and context.

initTheme("dark");

const resolveWorktree = (path: string) => ({ root: path.startsWith("/repo") || path === "." ? "/repo" : path, commonDir: "/clone/git" });
const gentleShell: typeof installGentleShell = (pi, env, deps) => installGentleShell(pi, env, { resolveWorktree, gitRunner: (cwd) => async (args) => pi.exec("git", ["-C", cwd, ...args], { timeout: 5000 }), ...deps });

const plainTheme = {
	fg(_color: string, value: string) {
		return value;
	},
	bold(value: string) {
		return value;
	},
	bg(_color: string, value: string) {
		return value;
	},
	getBgAnsi() {
		return "";
	},
} satisfies ShellBarTheme & { bg(color: string, value: string): string; getBgAnsi(): string };

interface FakeUi {
	footerFactory: unknown;
	editorFactory: unknown;
	widgets: Map<string, unknown>;
	widgetSets: number;
	workingVisible: boolean | undefined;
	notices: string[];
	overlay: unknown;
	overlayView: { render(width: number): string[]; handleInput(data: string): void } | undefined;
	closeOverlay: (() => void) | undefined;
}

interface GitScript {
	numstat: string;
	porcelain: string;
}

interface CommandRegistration {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

interface ShortcutRegistration {
	handler: (ctx: ExtensionContext) => Promise<void>;
}

type MessageRenderer = (message: { customType: string; content: unknown }, options: { expanded: boolean }, theme: unknown) => { render(width: number): string[] };
const renderers = new Map<string, MessageRenderer>();

function fakePi(script: GitScript[] = [{ numstat: "", porcelain: "" }]) {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, CommandRegistration>();
	const shortcuts = new Map<string, ShortcutRegistration>();
	const git: string[][] = [];
	let entries: unknown[] = [];
	const tools = new Map<string, { renderShell?: string; execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<unknown> }>();
	const listeners = new Map<string, (data: unknown) => void>();
	let round = 0;
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), (payload, ctx) => {
				entries = ctx.sessionManager.getEntries();
				return handler(payload, ctx);
			}]);
		},
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		events: { on(name: string, fn: (data: unknown) => void) { listeners.set(name, fn); return () => listeners.delete(name); }, emit(name: string, data: unknown) { listeners.get(name)?.(data); } },
		registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); },
		registerCommand(name: string, registration: CommandRegistration) {
			commands.set(name, registration);
		},
		registerShortcut(key: string, registration: ShortcutRegistration) {
			shortcuts.set(key, registration);
		},
		registerMessageRenderer(type: string, renderer: MessageRenderer) {
			renderers.set(type, renderer);
		},
		getThinkingLevel() {
			return "medium";
		},
		async exec(_command: string, args: string[]) {
			git.push(args);
			if (args.includes("worktree")) return { stdout: "worktree /repo\0branch refs/heads/main\0\0", stderr: "", code: 0, killed: false };
			const isNumstat = args.includes("diff");
			const step = script[Math.min(isNumstat ? round : round++, script.length - 1)];
			return { stdout: isNumstat ? step.numstat : step.porcelain, stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, git, commands, shortcuts, tools };
}

async function fire(handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>, event: string, ctx: ExtensionContext): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
}

function fakeContext(options: { hasUI?: boolean; entries?: unknown[]; oauth?: boolean; pending?: boolean; editorFactory?: unknown; token?: string; tokens?: Record<string, string | undefined> } = {}): { ctx: ExtensionContext; ui: FakeUi; overlayReady: Promise<void> } {
	const ui: FakeUi = { footerFactory: undefined, editorFactory: options.editorFactory, widgets: new Map(), widgetSets: 0, workingVisible: undefined, notices: [], overlay: undefined, overlayView: undefined, closeOverlay: undefined };
	let resolveOverlay: () => void;
	const overlayReady = new Promise<void>((resolve) => { resolveOverlay = resolve; });
	const entries = options.entries ?? [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		hasPendingMessages: () => options.pending ?? false,
		cwd: "/repo",
		model: { id: "gpt-5.5", provider: "openai-codex", reasoning: true, contextWindow: 272_000 },
		sessionManager: {
			getCwd: () => "/repo",
			getSessionName: () => "Release notes",
			getEntries: () => entries,
			getSessionId: () => "shell-session",
		},
		modelRegistry: {
			isUsingOAuth: () => options.oauth ?? true,
			getApiKeyForProvider: async (provider: string) => options.tokens ? options.tokens[provider] : provider === "openai-codex" ? options.token : undefined,
		},
		getContextUsage: () => ({ tokens: 122_400, contextWindow: 272_000, percent: 45 }),
		ui: {
			theme: plainTheme,
			setFooter(factory: unknown) {
				ui.footerFactory = factory;
			},
			setEditorComponent(factory: unknown) {
				ui.editorFactory = factory;
			},
			getEditorComponent() {
				return ui.editorFactory;
			},
			setWidget(key: string, content: unknown) {
				ui.widgetSets += 1;
				if (content === undefined) ui.widgets.delete(key);
				else ui.widgets.set(key, content);
			},
			notify(message: string) {
				ui.notices.push(message);
			},
			setWorkingVisible(visible: boolean) {
				ui.workingVisible = visible;
			},
			custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: null) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
				ui.overlay = factory;
				return new Promise<null>((resolve) => {
					ui.closeOverlay = () => resolve(null);
					ui.overlayView = factory(fakeTui, plainTheme, fakeKeybindings, () => resolve(null));
					resolveOverlay();
				});
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, ui, overlayReady };
}

function assistantEntry(usage: { input: number; output: number; cost: number }) {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: { input: usage.input, output: usage.output, cacheRead: 0, cacheWrite: 0, cost: { total: usage.cost } },
		},
	};
}

test("buildShellBarModel reads session, model, and footer data", () => {
	const { pi } = fakePi();
	const { ctx } = fakeContext({
		entries: [assistantEntry({ input: 1000, output: 200, cost: 0.5 }), assistantEntry({ input: 500, output: 100, cost: 0.25 }), { type: "message", message: { role: "user" } }],
	});
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map([["mcp", "MCP: 3 servers enabled"]]),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const built = buildShellBarModel(pi, ctx, footerData, { home: "/home/alan" });
	assert.equal(built.cwd, "/repo");
	assert.equal(built.branch, "main");
	assert.equal(built.sessionName, "Release notes");
	assert.equal(built.modelId, "gpt-5.5");
	assert.equal(built.effort, "medium");
	assert.equal(built.contextPercent, 45);
	assert.equal(built.costTotal, 0.75);
	assert.equal(built.subscription, true);
	assert.deepEqual(built.statuses, ["MCP: 3 servers enabled"]);
});

test("buildShellBarModel treats OpenCode Go API-key usage as subscription-backed", () => {
	const { pi } = fakePi();
	const { ctx } = fakeContext({ oauth: false });
	(ctx as unknown as { model: { provider: string } }).model.provider = "opencode-go";
	const footerData = { getGitBranch: () => null, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };
	assert.equal(buildShellBarModel(pi, ctx, footerData).subscription, true);
});

test("buildShellBarModel shortens the home directory and hides effort for non-reasoning models", () => {
	const { pi } = fakePi();
	const { ctx } = fakeContext();
	(ctx as unknown as { model: { reasoning: boolean } }).model.reasoning = false;
	(ctx.sessionManager as unknown as { getCwd: () => string }).getCwd = () => "/home/alan/work/gentle-pi";
	const footerData = {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const built = buildShellBarModel(pi, ctx, footerData, { home: "/home/alan" });
	assert.equal(built.cwd, "~/work/gentle-pi");
	assert.equal(built.effort, undefined);
	assert.equal(built.branch, null);
});

test("gentleShell installs the footer on session_start when a UI exists", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	assert.equal(typeof ui.footerFactory, "function");

	const factory = ui.footerFactory as (tui: unknown, theme: ShellBarTheme, footerData: unknown) => { render(width: number): string[] };
	const component = factory(
		{ requestRender() {} },
		plainTheme,
		{ getGitBranch: () => "main", getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
	);
	const lines = component.render(120);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /main ⟡ gpt-5\.5 · medium/);
});

test("gentleShell stays out of the way without a UI or when disabled", () => {
	const disabled = fakePi();
	gentleShell(disabled.pi, { GENTLE_PI_SHELL: "0" });
	assert.equal(disabled.handlers.size, 0);

	const headless = fakePi();
	gentleShell(headless.pi, {});
	const { ctx, ui } = fakeContext({ hasUI: false });
	for (const handler of headless.handlers.get("session_start") ?? []) handler({}, ctx);
	assert.equal(ui.footerFactory, undefined);
});

const fakeTui = { terminal: { rows: 40, columns: 120 }, requestRender() {} };
const editorTheme = { borderColor: (text: string) => text, selectList: {} };
const fakeKeybindings = { matches: () => false };

function installedPrompt(ctx: ExtensionContext, ui: FakeUi, handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>): GentlePromptEditor {
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	const factory = ui.editorFactory as (tui: unknown, theme: unknown, keybindings: unknown) => GentlePromptEditor;
	return factory(fakeTui, editorTheme, fakeKeybindings);
}

test("gentleShell frames the editor with the petal prompt and a hint while empty", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	assert.equal(ui.workingVisible, false, "pi's own Working row must be hidden");
	editor.focused = true;
	const lines = editor.render(60).map(stripAnsi);
	assert.match(lines[0], /^╭─ ✿ ─+╮$/);
	assert.doesNotMatch(editor.render(60).join("\n"), /\x1b\[44m/, "prompt must not paint passive backgrounds");
	assert.match(lines[1], /^│.*type, or \/ for commands +│$/);
	assert.match(lines[lines.length - 1], /^╰─+╯$/);
	editor.setText("hola");
	assert.doesNotMatch(editor.render(60).map(stripAnsi)[1], /type, or/);
	editor.dispose();
});

test("registered prompt stays transparent while idle, working, and queued", () => {
	const { pi, handlers, tools } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	ctx.ui.theme = { ...plainTheme, getBgAnsi: () => "\x1b[44m" } as typeof ctx.ui.theme;
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		for (const state of ["idle", "working", "queued"]) {
			if (state === "working") for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
			(ctx as unknown as { hasPendingMessages(): boolean }).hasPendingMessages = () => state === "queued";
			for (const width of [8, 40, 80]) assert.doesNotMatch(editor.render(width).join("\n"), /\x1b\[44m/, state);
		}
	} finally {
		editor.dispose();
	}
	assert.equal(tools.get("session_worktree_register")?.renderShell, "self");
});

test("gentleShell shows working while the agent runs and queued when messages wait", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const pending = { value: false };
	const { ctx, ui } = fakeContext();
	(ctx as unknown as { hasPendingMessages: () => boolean }).hasPendingMessages = () => pending.value;
	const editor = installedPrompt(ctx, ui, handlers);

	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	assert.match(stripAnsi(editor.render(60)[0]), /^╭─ [✿❀❁✾] working ─+╮$/);
	pending.value = true;
	assert.match(stripAnsi(editor.render(60)[0]), /^╭─ [✿❀❁✾] queued ─+╮$/);
	for (const handler of handlers.get("agent_end") ?? []) handler({}, ctx);
	pending.value = false;
	assert.match(stripAnsi(editor.render(60)[0]), /^╭─ ✿ ─+╮$/);
	editor.dispose();
});

test("gentleShell leaves an editor another extension already installed", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const theirs = () => ({});
	const { ctx, ui } = fakeContext({ editorFactory: theirs });
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	assert.equal(ui.editorFactory, theirs);
});

const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };

function renderFooter(ui: FakeUi): string {
	const factory = ui.footerFactory as (tui: unknown, theme: ShellBarTheme, footerData: unknown) => { render(width: number): string[] };
	return factory(fakeTui, plainTheme, footerData).render(160)[0];
}

test("gentleShell shows working-tree changes in a widget below the editor and in the bar", async () => {
	const { pi, handlers, git } = fakePi([
		{ numstat: "", porcelain: "" },
		{ numstat: "10\t0\tlib/b.ts\n", porcelain: "A  lib/b.ts\0" },
	]);
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" });
	const { ctx, ui } = fakeContext();
	await fire(handlers, "session_start", ctx);
	assert.deepEqual(git[0].slice(0, 2), ["-C", "/repo"]);
	assert.equal(ui.widgets.has("gentle-shell-changes"), false);
	assert.doesNotMatch(renderFooter(ui), /±/);

	await fire(handlers, "tool_execution_end", ctx);
	const factory = ui.widgets.get("gentle-shell-changes") as (tui: unknown, theme: ShellBarTheme) => { render(width: number): string[] };
	const [line] = factory(fakeTui, plainTheme).render(120);
	assert.match(line, /^✎ 1 file · \+10 −0 · lib\/b\.ts +\/gentle:changes$/);
	assert.match(renderFooter(ui), /main ±1/);
});

test("gentleShell registers /gentle:changes and opens the overlay only when there are changes", async () => {
	const { pi, handlers, commands } = fakePi([
		{ numstat: "", porcelain: "" },
		{ numstat: "", porcelain: "" },
		{ numstat: "10\t0\tlib/b.ts\n", porcelain: "A  lib/b.ts\0" },
	]);
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	await fire(handlers, "session_start", ctx);
	const command = commands.get("gentle:changes");
	assert.ok(command, "command not registered");

	await command.handler("", ctx);
	assert.deepEqual(ui.notices, ["No changes in the working tree."]);
	assert.equal(ui.overlay, undefined);

	await fire(handlers, "tool_execution_end", ctx);
	const opened = command.handler("", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(typeof ui.overlay, "function");
	ui.closeOverlay?.();
	await opened;
});

test("changes overlay follows registered linked roots on open, refresh and polling and scopes diff git cwd", async () => {
	const { pi, handlers, commands, tools } = fakePi();
	let roots = ["/repo"];
	const diffs: string[][] = [];
	pi.exec = (async (_command: string, args: string[]) => {
		let stdout = "";
		if (args.includes("worktree")) stdout = roots.map((root) => `worktree ${root}\0branch refs/heads/${root.slice(1)}\0\0`).join("");
		else if (args.includes("status")) stdout = " M same.ts\0";
		else if (args.includes("--numstat")) stdout = "1\t1\tsame.ts\n";
		else { diffs.push(args); stdout = `+${args[1]}`; }
		return { stdout, stderr: "", code: 0, killed: false };
	}) as ExtensionAPI["exec"];
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off", GENTLE_PI_SHELL_CHANGES_POLL_MS: "5" });
	const { ctx, ui } = fakeContext();
	await fire(handlers, "session_start", ctx);
	roots.push("/linked");
	await tools.get("session_worktree_register")!.execute("register", { path: "/linked" }, undefined, undefined, ctx);
	const open = commands.get("gentle:changes")!.handler("", ctx);
	try {
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.match(ui.overlayView!.render(120).join("\n"), /linked · linked/);
		assert.equal(diffs.length, 0);
		ui.overlayView!.handleInput("j");
		ui.overlayView!.handleInput("\r");
		ui.overlayView!.handleInput("j");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(diffs[0], ["-C", "/linked", "diff", "HEAD", "--", "same.ts"]);
		ui.overlayView!.handleInput("\x1b[D");
		roots.push("/new");
		await tools.get("session_worktree_register")!.execute("register", { path: "/new" }, undefined, undefined, ctx);
		ui.overlayView!.handleInput("r");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.match(ui.overlayView!.render(120).join("\n"), /new · new/);
		roots.push("/polled");
		await tools.get("session_worktree_register")!.execute("register", { path: "/polled" }, undefined, undefined, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.match(ui.overlayView!.render(120).join("\n"), /polled · polled/);
	} finally {
		ui.closeOverlay?.();
		await open;
		await fire(handlers, "session_shutdown", ctx);
	}
});

test("successful direct tools register whole roots, failures and shell contents do not, and all UI counts agree", async () => {
	const { pi, handlers, tools, commands } = fakePi();
	const queried: string[] = [];
	pi.exec = (async (_command: string, args: string[]) => {
		const root = args[1];
		if (args.includes("status")) queried.push(root);
		const stdout = args.includes("worktree") ? ["/repo", "/used", "/failed", "/opaque", "/hidden"].map((path) => `worktree ${path}\0\0`).join("")
			: args.includes("status") ? " M preexisting.ts\0?? new.ts\0"
			: args.includes("--numstat") ? "2\t1\tpreexisting.ts\n" : "+diff";
		return { stdout, stderr: "", code: 0, killed: false };
	}) as ExtensionAPI["exec"];
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" });
	const { ctx, ui, overlayReady } = fakeContext();
	await fire(handlers, "session_start", ctx);
	const emit = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const complete = async (toolName: string, input: unknown, isError = false) => {
		await emit("tool_execution_start", { toolCallId: "call", toolName, args: input });
		await emit("tool_result", { toolCallId: "call", toolName, input, isError: false });
		await emit("tool_execution_end", { toolCallId: "call", toolName, isError });
	};
	await complete("read", { path: "/failed" }, true);
	await complete("bash", { command: "cd /opaque && edit stuff", path: "/opaque" });
	assert.deepEqual(new Set(queried), new Set(["/repo"]));
	await complete("read", { path: "/used" });
	await complete("write", { path: "/used" });
	assert.deepEqual(new Set(queried), new Set(["/repo", "/used"]));
	assert.equal(ctx.sessionManager.getEntries().length, 2, "multiple completed tools dedupe");
	assert.match(renderFooter(ui), /±4/);
	const widget = ui.widgets.get("gentle-shell-changes") as (host: unknown, theme: unknown) => { render(width: number): string[] };
	assert.match(widget(fakeTui, plainTheme).render(140)[0], /4 files/);
	const open = commands.get("gentle:changes")!.handler("", ctx);
	await overlayReady;
	assert.doesNotMatch(ui.overlayView!.render(140).join("\n"), /hidden|opaque|failed/);
	ui.closeOverlay?.();
	await open;
	await tools.get("session_worktree_register")!.execute("explicit", { path: "/opaque" }, undefined, undefined, ctx);
	assert.match(renderFooter(ui), /±6/);
	await fire(handlers, "session_shutdown", ctx);
});

test("session switching drops pending tool and foreign launch events while same-session entries restore", async () => {
	const h = fakePi([{ numstat: "1\t0\ta.ts\n", porcelain: " M a.ts\0" }]);
	gentleShell(h.pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" });
	const first = fakeContext();
	await fire(h.handlers, "session_start", first.ctx);
	for (const handler of h.handlers.get("tool_execution_start") ?? []) await handler({ toolCallId: "old", toolName: "read", args: { path: "/foreign" } }, first.ctx);
	const next = fakeContext({ entries: [...first.ctx.sessionManager.getEntries()] });
	(next.ctx.sessionManager as unknown as { getSessionId(): string }).getSessionId = () => "new-session";
	await fire(h.handlers, "session_start", next.ctx);
	for (const handler of h.handlers.get("tool_result") ?? []) await handler({ toolCallId: "old", toolName: "read", input: { path: "/foreign" } }, next.ctx);
	for (const handler of h.handlers.get("tool_execution_end") ?? []) await handler({ toolCallId: "old", toolName: "read", isError: false }, next.ctx);
	const before = h.git.length;
	h.pi.events.emit("gentle-pi:session-worktree-changed", { sessionId: "shell-session", root: "/foreign" });
	assert.equal(h.git.length, before);
	assert.match(renderFooter(next.ui), /±1/);
	assert.ok(!h.git.some((args) => args[1] === "/foreign"));
	await fire(h.handlers, "session_shutdown", next.ctx);
});

test("registered canonical root governs real Git discovery, status and diff despite inherited routing", async (t) => {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "shell-git-routing-")));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	const selected = join(fixture, "selected");
	const foreign = join(fixture, "foreign");
	const empty = join(fixture, "empty");
	mkdirSync(empty);
	writeFileSync(join(empty, "config"), "");
	const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	Object.assign(cleanEnv, { GIT_CONFIG_GLOBAL: join(empty, "config"), GIT_CONFIG_NOSYSTEM: "1" });
	const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, "-c", `core.hooksPath=${empty}`, "-c", "commit.gpgsign=false", ...args], { env: cleanEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	for (const root of [selected, foreign]) {
		git(fixture, ["init", "--initial-branch=main", `--template=${empty}`, root]);
		writeFileSync(join(root, "tracked.txt"), "before\n");
		git(root, ["add", "tracked.txt"]);
		git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture"]);
	}
	writeFileSync(join(selected, "tracked.txt"), "selected change\n");
	writeFileSync(join(selected, "selected-only.txt"), "selected untracked\n");
	writeFileSync(join(foreign, "tracked.txt"), "foreign change\n");
	writeFileSync(join(foreign, "foreign-only.txt"), "foreign untracked\n");
	const poisoned = { ...cleanEnv, GIT_DIR: join(foreign, ".git"), GIT_WORK_TREE: foreign, GIT_INDEX_FILE: join(foreign, ".git", "index") };
	const h = fakePi();
	// Pi exec has no env option and inherits routing. Model that boundary with
	// a child-only env, without changing this test process's environment.
	h.pi.exec = ((command: string, args: string[], options: { timeout?: number } = {}) => new Promise((resolve) => {
		execFile(command, args, { env: poisoned, encoding: "utf8", timeout: options.timeout, maxBuffer: Infinity }, (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? typeof error.code === "number" ? error.code : 1 : 0, killed: Boolean(error?.killed) }));
	})) as ExtensionAPI["exec"];
	const { ctx, ui, overlayReady } = fakeContext();
	(ctx as unknown as { cwd: string }).cwd = selected;
	(ctx.sessionManager as unknown as { getCwd(): string }).getCwd = () => selected;
	const run = shellGitRunner(selected, poisoned);
	const discovery = await run(["worktree", "list", "--porcelain", "-z"]);
	assert.match(discovery.stdout, new RegExp(`worktree ${selected}`));
	assert.ok(!discovery.stdout.includes(foreign));
	installGentleShell(h.pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { devBinary: () => undefined, gitRunner: (cwd) => shellGitRunner(cwd, poisoned) });
	await fire(h.handlers, "session_start", ctx);
	t.after(() => fire(h.handlers, "session_shutdown", ctx));
	const widget = ui.widgets.get("gentle-shell-changes") as (host: unknown, theme: unknown) => { render(width: number): string[] };
	const rendered = widget(fakeTui, plainTheme).render(300).join("\n");
	assert.match(rendered, /selected-only\.txt/);
	assert.doesNotMatch(rendered, /foreign-only\.txt/);
	const diff = await loadFileDiff(run, { path: "tracked.txt", added: 1, deleted: 1, status: CHANGE_STATUS.MODIFIED });
	assert.match(diff, /\+selected change/);
	assert.doesNotMatch(diff, /foreign change/);
	const untracked = await loadFileDiff(run, { path: "selected-only.txt", added: 1, deleted: 0, status: CHANGE_STATUS.UNTRACKED });
	assert.match(untracked, /\+selected untracked/);
	assert.equal((await run(["rev-parse", "--verify", "missing-ref"])).code, 128, "Git failure codes stay intact");
	assert.equal(poisoned.GIT_DIR, join(foreign, ".git"), "caller environment is not mutated");
	assert.equal((await shellGitRunner(selected, { PATH: empty })(["status"])).code, 1, "spawn errors remain failed results rather than uncaught exceptions");
	writeFileSync(join(selected, "tracked.txt"), "selected large line\n".repeat(70_000) + "selected final marker\n");
	const largeDiff = await run(["diff", "HEAD", "--", "tracked.txt"]);
	assert.equal(largeDiff.code, 0);
	assert.ok(largeDiff.stdout.length > 1024 * 1024, "output must not inherit execFile's default one MiB cap");
	assert.match(largeDiff.stdout, /\+selected final marker/);
	const open = h.commands.get("gentle:changes")!.handler("", ctx);
	await overlayReady;
	ui.overlayView!.handleInput("\r");
	ui.overlayView!.handleInput("j");
	ui.closeOverlay?.();
	await open;
});

test("loadFileDiff asks git for a HEAD diff, or a no-index diff for untracked files", async () => {
	const calls: string[][] = [];
	const git = async (args: string[]) => {
		calls.push(args);
		return { stdout: "@@ -0,0 +1 @@\n+hello", code: args.includes("--no-index") ? 1 : 0 };
	};
	assert.match(await loadFileDiff(git, { path: "lib/a.ts", added: 1, deleted: 0, status: CHANGE_STATUS.MODIFIED }), /\+hello/);
	assert.match(await loadFileDiff(git, { path: "notes.md", added: 0, deleted: 0, status: CHANGE_STATUS.UNTRACKED }), /\+hello/);
	assert.deepEqual(calls, [
		["diff", "HEAD", "--", "lib/a.ts"],
		["diff", "--no-index", "--", "/dev/null", "notes.md"],
	]);
});

test("shell Git runner hides initial and repeated background polling children", async () => {
	const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
	const run = ((command: string, args: readonly string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string) => void) => {
		calls.push({ command, args, options });
		callback(null, "", "");
	}) as typeof import("node:child_process").execFile;
	const git = shellGitRunner("/repo with spaces & metacharacters", { PATH: process.env.PATH }, run);
	await git(["status", "--porcelain=v1", "-z"]);
	await git(["status", "--porcelain=v1", "-z"]);
	assert.equal(calls.length, 2, "the same safe runner serves startup and repeated polling");
	for (const call of calls) {
		assert.equal(call.command, "git");
		assert.deepEqual(call.args, ["-C", "/repo with spaces & metacharacters", "status", "--porcelain=v1", "-z"]);
		assert.equal(call.options.shell, false);
		assert.equal(call.options.windowsHide, true);
	}
});

test("openInExternalEditor stops the TUI around the editor and honors $VISUAL over $EDITOR", () => {
	const events: string[] = [];
	const host = { stop: () => events.push("stop"), start: () => events.push("start"), requestRender: (force?: boolean) => events.push(`render:${force}`) };
	const spawn = ((command: string, args: string[]) => {
		events.push(`spawn:${command} ${args.join(" ")}`);
		return { status: 0 } as ReturnType<typeof import("node:child_process").spawnSync>;
	}) as typeof import("node:child_process").spawnSync;
	assert.equal(openInExternalEditor(host, "lib/a.ts", { VISUAL: "nvim -u none", EDITOR: "vi" }, spawn), true);
	assert.deepEqual(events, ["stop", "spawn:nvim -u none lib/a.ts", "start", "render:true"]);
	assert.equal(openInExternalEditor(host, "lib/a.ts", {}, spawn), false);
});

test("external editor receives the selected worktree as process cwd", () => {
	let cwd: string | undefined;
	const spawn = ((_command: string, _args: string[], options: { cwd?: string }) => {
		cwd = options.cwd;
		return { status: 0 };
	}) as typeof import("node:child_process").spawnSync;
	openInExternalEditor({ stop() {}, start() {}, requestRender() {} }, "same.ts", { EDITOR: "vi" }, spawn, "/linked");
	assert.equal(cwd, "/linked");
});

test("changesShortcut defaults to alt+g and can be overridden or disabled", () => {
	assert.equal(changesShortcut({}), "alt+g");
	assert.equal(changesShortcut({ GENTLE_PI_SHELL_CHANGES_KEY: "ctrl+shift+g" }), "ctrl+shift+g");
	assert.equal(changesShortcut({ GENTLE_PI_SHELL_CHANGES_KEY: "off" }), undefined);
	assert.equal(changesShortcut({ GENTLE_PI_SHELL_CHANGES_KEY: "" }), undefined);
});

test("gentleShell binds the changes shortcut to the same handler as the command", async () => {
	const { pi, handlers, shortcuts } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	await fire(handlers, "session_start", ctx);
	const shortcut = shortcuts.get("alt+g");
	assert.ok(shortcut, "alt+g not registered");
	await shortcut.handler(ctx);
	assert.deepEqual(ui.notices, ["No changes in the working tree."]);

	const silent = fakePi();
	gentleShell(silent.pi, { GENTLE_PI_SHELL_CHANGES_KEY: "off" });
	assert.equal(silent.shortcuts.size, 0);
});

test("gentleShell keeps the open overlay in sync with git while it stays open", async () => {
	const { pi, handlers, commands } = fakePi([
		{ numstat: "10\t0\tlib/b.ts\n", porcelain: "A  lib/b.ts\0" },
		{ numstat: "10\t0\tlib/b.ts\n", porcelain: "A  lib/b.ts\0" },
		{ numstat: "10\t0\tlib/b.ts\n3\t1\tlib/c.ts\n", porcelain: "A  lib/b.ts\0 M lib/c.ts\0" },
	]);
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_POLL_MS: "5" });
	const { ctx, ui } = fakeContext();
	await fire(handlers, "session_start", ctx);
	const open = commands.get("gentle:changes")!.handler("", ctx);
	await new Promise((resolve) => setTimeout(resolve, 40));
	ui.overlayView!.handleInput("\r");
	const plain = ui.overlayView!.render(100).map(stripAnsi);
	assert.match(plain[2], /2 files · \+13 −1/);
	assert.match(plain[3], /lib\/c\.ts/);
	assert.match(renderFooter(ui), /main ±2/);
	ui.closeOverlay?.();
	await open;
});

test("gentleShell watches git in the background so the widget and bar follow external edits", async () => {
	const { pi, handlers, git } = fakePi([
		{ numstat: "", porcelain: "" },
		{ numstat: "", porcelain: "" },
		{ numstat: "3\t1\tlib/c.ts\n", porcelain: " M lib/c.ts\0" },
	]);
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "5" });
	const { ctx, ui } = fakeContext();
	await fire(handlers, "session_start", ctx);
	assert.equal(ui.widgets.has("gentle-shell-changes"), false);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(ui.widgets.has("gentle-shell-changes"), true);
	assert.match(renderFooter(ui), /main ±1/);
	assert.ok(git.length >= 6, "background watch should keep polling git");

	const widgetSetsBefore = ui.widgetSets;
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(ui.widgetSets, widgetSetsBefore, "unchanged tree must not rewrite the widget");
	await fire(handlers, "session_shutdown", ctx);
	const gitCallsAfterShutdown = git.length;
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(git.length, gitCallsAfterShutdown, "shutdown must stop the watch");
});

const JWT = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.s`;
const USAGE_PAYLOAD = { plan_type: "pro", rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: 1_788_777_491 } } };

function fakeFetch(payload: unknown = USAGE_PAYLOAD, ok = true) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetchFn = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
		return { ok, json: async () => payload } as Response;
	}) as typeof fetch;
	return { fetchFn, calls };
}

test("fetchCodexUsage sends the token and account id and parses the payload", async () => {
	const { fetchFn, calls } = fakeFetch();
	const usage = await fetchCodexUsage(JWT, fetchFn, 1_788_600_000_000);
	assert.equal(usage?.plan, "pro");
	assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(calls[0].headers.Authorization, `Bearer ${JWT}`);
	assert.equal(calls[0].headers["chatgpt-account-id"], "acct-1");

	const plain = fakeFetch();
	assert.equal(await fetchCodexUsage("sk-plain-api-key", plain.fetchFn, 0), undefined);
	assert.equal(plain.calls.length, 0, "a non-OAuth key must not be sent anywhere");
	assert.equal(await fetchCodexUsage(JWT, fakeFetch({}, false).fetchFn, 0), undefined);
	assert.equal(await fetchCodexUsage(undefined, plain.fetchFn, 0), undefined);
});

test("fetchOpenCodeGoUsage uses only the bearer key and fails closed for non-200 or malformed payloads", async () => {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetchFn = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
		return { status: 200, json: async () => ({ usage: { rolling: { percent: 20, resetsAt: "2026-09-01T12:00:00.000Z" } } }) } as Response;
	}) as typeof fetch;
	const usage = await fetchOpenCodeGoUsage("go-key", fetchFn, 0);
	assert.equal(usage?.provider, "opencode-go");
	assert.deepEqual(calls, [{ url: "https://opencode.ai/zen/go/v1/usage", headers: { Authorization: "Bearer go-key", Accept: "application/json" } }]);
	assert.equal(await fetchOpenCodeGoUsage("go-key", (async () => ({ status: 403 } as Response)) as typeof fetch, 0), undefined);
	assert.equal(await fetchOpenCodeGoUsage("go-key", (async () => ({ status: 200, json: async () => ({ usage: {} }) } as Response)) as typeof fetch, 0), undefined);
});

test("gentleShell fetches Codex usage on session start and shows it in the bar", async () => {
	const { pi, handlers } = fakePi();
	const { fetchFn, calls } = fakeFetch();
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { fetch: fetchFn, now: () => 1_788_600_000_000 });
	const { ctx, ui } = fakeContext({ token: JWT });
	await fire(handlers, "session_start", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(calls.length, 1);
	assert.match(renderFooter(ui), /\$0\.000 sub ⟡ codex week ▰▰▰▱▱▱▱▱ 40%/);

	await fire(handlers, "agent_end", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(calls.length, 1, "agent_end must not refetch within the refresh window");
});

test("gentleShell records SSE rate-limit headers from provider responses", async () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { fetch: fakeFetch({}, false).fetchFn, now: () => 0 });
	const { ctx, ui } = fakeContext();
	await fire(handlers, "session_start", ctx);
	for (const handler of handlers.get("after_provider_response") ?? []) {
		handler({ status: 200, headers: { "x-codex-primary-used-percent": "62", "x-codex-primary-window-minutes": "300", "x-codex-secondary-used-percent": "31", "x-codex-secondary-window-minutes": "10080" } }, ctx);
	}
	assert.match(renderFooter(ui), /codex 5h ▰▰▰▰▰▱▱▱ 62% · week 31%/);

	(ctx as unknown as { model: { provider: string } }).model.provider = "anthropic";
	for (const handler of handlers.get("after_provider_response") ?? []) {
		handler({ status: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.25", "anthropic-ratelimit-unified-7d-utilization": "0.9" } }, ctx);
	}
	assert.match(renderFooter(ui), /claude 5h ▰▰▱▱▱▱▱▱ 25% · week 90%/);
	assert.doesNotMatch(renderFooter(ui), /codex/);
});

test("gentleShell registers /gentle:usage and opens the subscriptions overlay", async () => {
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { fetch: fakeFetch().fetchFn, now: () => 1_788_600_000_000 });
	const { ctx, ui } = fakeContext({ token: JWT });
	await fire(handlers, "session_start", ctx);
	const opened = commands.get("gentle:usage")!.handler("", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const plain = ui.overlayView!.render(90).map(stripAnsi);
	assert.match(plain[0], /Subscriptions/);
	assert.match(plain[1], /✿ openai-codex · pro/);
	ui.closeOverlay?.();
	await opened;
});

test("gentleShell draws the review preflight message as a Gentle card", () => {
	const { pi } = fakePi();
	gentleShell(pi, {});
	const renderer = renderers.get("gentle-pi.review-preflight");
	assert.ok(renderer, "renderer not registered");
	const message = { customType: "gentle-pi.review-preflight", content: "Receipt-driven development is enabled.\n\nCall the gentle_review tool." };
	const sentinelTheme = { ...plainTheme, bg: (_role: string, text: string) => `\x1b[44m${text}\x1b[49m` };
	for (const expanded of [true, false]) {
		assert.doesNotMatch(renderer(message, { expanded }, sentinelTheme).render(80).join("\n"), /\x1b\[44m/);
	}
	const expanded = renderer(message, { expanded: true }, plainTheme).render(80).map(stripAnsi);
	assert.match(expanded[0], /^╭─ ✿ Gentle AI · review preflight ─+ .*collapse ╮$/);
	assert.match(expanded[1], /^│ Receipt-driven development is enabled\. +│$/);
	assert.ok(expanded.some((line) => line.includes("gentle_review")));
	const collapsed = renderer({ ...message, content: [{ type: "text", text: message.content }] }, { expanded: false }, plainTheme).render(80).map(stripAnsi);
	assert.equal(collapsed.length, 3);
});

test("gentleShell keeps a dev-binary override visible above the editor for the whole session", async () => {
	const { pi, handlers } = fakePi();
	const deps = { fetch: fakeFetch({}, false).fetchFn, now: () => 0, devBinary: () => ({ state: "active" as const, path: "/Users/me/go/bin/gentle-ai", sha256: "6e53bfc6305a3949deadbeef" }) };
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, deps);
	const { ctx, ui } = fakeContext();
	await fire(handlers, "session_start", ctx);
	const factory = ui.widgets.get("gentle-shell-dev-binary") as (tui: unknown, theme: unknown) => { render(width: number): string[] };
	assert.ok(factory, "dev binary widget missing");
	const lines = factory(fakeTui, plainTheme).render(100).map(stripAnsi);
	assert.match(lines[0], /^╭─ ✿ Gentle AI · dev binary override · field-test only ─+╮$/);
	assert.match(lines[1], /^│ \/Users\/me\/go\/bin\/gentle-ai · sha256:6e53bfc6305a3949 +│$/);
	assert.match(lines[2], /^╰─+╯$/);
	assert.equal(lines[3], "", "a blank line keeps the card off the prompt frame");
	const painted = factory(fakeTui, { ...plainTheme, bg: (_role: string, text: string) => `\x1b[44m${text}\x1b[49m` }).render(100);
	assert.equal(painted[0], lines[0], "top frame cells have no background");
	assert.equal(painted[1], lines[1], "body interior remains transparent");
	assert.equal(painted[2], lines[2], "bottom frame cells have no background");
	assert.equal(painted[3], "", "external spacer has no background");
	await fire(handlers, "agent_start", ctx);
	assert.equal(ui.widgets.has("gentle-shell-dev-binary"), false, "the startup notice leaves with the first prompt");

	const clean = fakePi();
	gentleShell(clean.pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { ...deps, devBinary: () => undefined });
	const fresh = fakeContext();
	await fire(clean.handlers, "session_start", fresh.ctx);
	assert.equal(fresh.ui.widgets.has("gentle-shell-dev-binary"), false);

	assert.equal(devBinaryCard({ state: "invalid", reason: "binary missing" }).tone, "error");
});
