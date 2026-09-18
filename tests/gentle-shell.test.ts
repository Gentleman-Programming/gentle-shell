import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext, type SlashCommandInfo, type SourceInfo } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import installGentleShell, { buildShellBarModel, createActiveProfileReader, changesShortcut, devBinaryCard, fetchCodexUsage, fetchNanUsage, loadFileDiff, shellGitRunner, openInExternalEditor, type GentlePromptEditor } from "../extensions/gentle-shell.ts";
import { CHANGE_STATUS } from "../lib/shell-changes.ts";
import { sidebarState, type SidebarRail } from "../lib/shell-sidebar.ts";
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

const FAKE_SOURCE_INFO: SourceInfo = { path: "extensions/gentle-shell.ts", source: "gentle-shell", scope: "project", origin: "top-level" };

const DEFAULT_COMMANDS: SlashCommandInfo[] = [
	{ name: "gentle:models", description: "Configure models", source: "extension", sourceInfo: FAKE_SOURCE_INFO },
	{ name: "gentle:changes", description: "Browse changes", source: "extension", sourceInfo: FAKE_SOURCE_INFO },
	{ name: "gentle:status", description: "Show Gentle AI status", source: "extension", sourceInfo: FAKE_SOURCE_INFO },
	{ name: "skill-registry:refresh", description: "Regenerate the skill registry", source: "extension", sourceInfo: FAKE_SOURCE_INFO },
	{ name: "gentle:commands", description: "Open the command palette", source: "extension", sourceInfo: FAKE_SOURCE_INFO },
	{ name: "gentle:not-in-catalog", description: "Not a curated command", source: "extension", sourceInfo: FAKE_SOURCE_INFO },
	{ name: "skill:foo", description: "A skill", source: "skill", sourceInfo: FAKE_SOURCE_INFO },
];

function fakePi(script: GitScript[] = [{ numstat: "", porcelain: "" }], commandsList: SlashCommandInfo[] = DEFAULT_COMMANDS) {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, CommandRegistration>();
	const shortcuts = new Map<string, ShortcutRegistration>();
	const git: string[][] = [];
	let entries: unknown[] = [];
	const sentMessages: Array<{ content: string; options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean } }> = [];
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
		getCommands() {
			return commandsList;
		},
		sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }) {
			sentMessages.push({ content, options });
		},
		async exec(_command: string, args: string[]) {
			git.push(args);
			if (args.includes("worktree")) return { stdout: "worktree /repo\0branch refs/heads/main\0\0", stderr: "", code: 0, killed: false };
			const isNumstat = args.includes("diff");
			const step = script[Math.min(isNumstat ? round : round++, script.length - 1)];
			return { stdout: isNumstat ? step.numstat : step.porcelain, stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, git, commands, shortcuts, tools, sentMessages };
}

async function fire(handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>, event: string, ctx: ExtensionContext): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
}

function fakeContext(options: { hasUI?: boolean; entries?: unknown[]; oauth?: boolean; pending?: boolean; editorFactory?: unknown; token?: string } = {}): { ctx: ExtensionContext; ui: FakeUi; overlayReady: Promise<void> } {
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
		modelRegistry: { isUsingOAuth: () => options.oauth ?? true, getApiKeyForProvider: async () => options.token },
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
			// Generic over the result type: real callers resolve `custom` with
			// whatever their `done` callback is given (see ExtensionUIContext.custom
			// in pi-coding-agent), not always null. `closeOverlay` stays a
			// null-resolving escape hatch for tests that only need to end the wait.
			custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => { render(width: number): string[]; handleInput(data: string): void }) {
				ui.overlay = factory;
				return new Promise<T | null>((resolve) => {
					ui.closeOverlay = () => resolve(null);
					ui.overlayView = factory(fakeTui, plainTheme, fakeKeybindings, (value: T) => resolve(value));
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

test("the fullscreen Status rail carries a live digest so a model switch refreshes it", async () => {
	const { pi, handlers } = fakePi();
	let profile: string | undefined = "team";
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { activeProfile: () => profile });
	const entries: unknown[] = [];
	const { ctx, ui } = fakeContext({ entries });
	await fire(handlers, "session_start", ctx);

	const statuses = new Map<string, string>();
	const liveFooterData = { getGitBranch: () => "main", getExtensionStatuses: () => statuses, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };
	const tui = { terminal: { rows: 40, columns: 160 }, requestRender() {} };
	const factory = ui.footerFactory as (tui: unknown, theme: ShellBarTheme, footerData: unknown) => { render(width: number): string[]; dispose(): void };
	const component = factory(tui, plainTheme, liveFooterData);
	try {
		const rail = sidebarState(tui as unknown as TUI).parts.get("footer") as SidebarRail;
		const live = () => rail.digest?.();
		assert.equal(typeof rail.digest, "function", "the Status card paints live state and must declare a digest");
		assert.match(rail.render(46).join("\n"), /gpt-5\.5/);

		assert.match(rail.render(46).join("\n"), /Profile.*team/);
		const beforeProfile = live();
		profile = "other";
		assert.notEqual(live(), beforeProfile);
		assert.match(rail.render(46).join("\n"), /Profile.*other/);
		profile = undefined;
		assert.doesNotMatch(rail.render(46).join("\n"), /Profile/);

		const beforeModel = live();
		(ctx.model as { id: string }).id = "gpt-5.6";
		assert.notEqual(live(), beforeModel, "/model must change the digest");
		assert.match(rail.render(46).join("\n"), /gpt-5\.6/);

		const beforeUsage = live();
		(ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: 200_000, contextWindow: 272_000, percent: 74 });
		assert.notEqual(live(), beforeUsage, "context usage must change the digest");
		assert.match(rail.render(46).join("\n"), /74%/);

		const beforeCost = live();
		entries.push(assistantEntry({ input: 100, output: 20, cost: 0.42 }));
		assert.notEqual(live(), beforeCost, "session cost must change the digest");
		assert.match(rail.render(46).join("\n"), /\$0\.420/);

		const beforeStatus = live();
		statuses.set("mcp", "MCP: 3 servers enabled");
		assert.notEqual(live(), beforeStatus, "extension statuses have no event and must change the digest");
		assert.match(rail.render(46).join("\n"), /MCP: 3 servers enabled/);
		assert.equal(live(), live(), "an unchanged digest still reuses the prepared rail");
	} finally {
		component.dispose();
	}
});

test("profile reader follows store changes and rejects missing or invalid active markers", (t) => {
	const root = mkdtempSync(join(tmpdir(), "shell-profile-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "profiles.json");
	const read = createActiveProfileReader({ GENTLE_PI_CONFIG_HOME: root });
	const save = (active: string | undefined) => writeFileSync(path, JSON.stringify({
		kind: "gentle-pi.agent_model_profiles", version: 1, active, profiles: { team: {}, other: {} },
	}));
	assert.equal(read(), undefined);
	save("team");
	assert.equal(read(), "team");
	assert.equal(read(), "team");
	save("other");
	assert.equal(read(), "other");
	const replacement = join(root, "replacement.json");
	writeFileSync(replacement, JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, active: "team", profiles: { team: {} } }));
	renameSync(replacement, path);
	assert.equal(read(), "team", "atomic replacement refreshes the cached profile");
	const isolated = createActiveProfileReader({ GENTLE_PI_CONFIG_HOME: join(root, "other-home") });
	assert.equal(isolated(), undefined);
	assert.equal(read(), "team", "another shell's config home does not alter this cache");
	save("missing");
	assert.equal(read(), undefined);
	save(undefined);
	assert.equal(read(), undefined);
	writeFileSync(path, "{broken");
	assert.equal(read(), undefined);
	save("team");
	assert.equal(read(), "team");
	rmSync(path);
	assert.equal(read(), undefined);
});

test("gentleShell stays out of the way without a UI or when disabled", () => {
	const disabled = fakePi();
	gentleShell(disabled.pi, { GENTLE_PI_SHELL: "0" });
	assert.equal(disabled.commands.size, 0);
	assert.ok(disabled.handlers.has("tool_call"), "capture remains available to headless children");

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
	assert.match(stripAnsi(editor.render(60)[0]), /^╭─ ✿ working… ─+╮$/);
	pending.value = true;
	assert.match(stripAnsi(editor.render(60)[0]), /^╭─ [✿❀❁✾] queued ─+╮$/);
	for (const handler of handlers.get("agent_end") ?? []) handler({}, ctx);
	assert.match(stripAnsi(editor.render(60)[0]), /queued/, "low-level run end is not settled");
	pending.value = false;
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.match(stripAnsi(editor.render(60)[0]), /^╭─ ✿ ─+╮$/);
	editor.dispose();
});

test("prompt uses the compact banner cadence and releases its unref timer at settlement", (t) => {
	const delays: number[] = [];
	let active = 0;
	let unrefs = 0;
	t.mock.method(globalThis, "setInterval", (_callback: () => void, delay: number) => {
		delays.push(delay);
		active++;
		return { unref() { unrefs++; } };
	});
	t.mock.method(globalThis, "clearInterval", () => { active--; });
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	assert.equal(active, 0);
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	assert.deepEqual(delays, [80]);
	assert.equal(unrefs, 1);
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.equal(active, 0);
	editor.dispose();
	assert.equal(active, 0);
});

test("gentleShell leaves an editor another extension already installed", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const theirs = () => ({});
	const { ctx, ui } = fakeContext({ editorFactory: theirs });
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	assert.equal(ui.editorFactory, theirs);
	assert.notEqual(ui.workingVisible, false, "a custom owner still needs native working feedback");
});

test("Gentle replaces its retained factory on reload so new lifecycle handlers own the prompt", () => {
	const first = fakePi();
	gentleShell(first.pi, {});
	const { ctx, ui } = fakeContext();
	const oldEditor = installedPrompt(ctx, ui, first.handlers);
	const previousFactory = ui.editorFactory;
	const next = fakePi();
	gentleShell(next.pi, {});
	const editor = installedPrompt(ctx, ui, next.handlers);
	try {
		assert.notEqual(ui.editorFactory, previousFactory);
		for (const handler of next.handlers.get("agent_start") ?? []) handler({}, ctx);
		assert.match(stripAnsi(editor.render(60)[0]), /working/);
	} finally {
		oldEditor.dispose();
		editor.dispose();
	}
});

const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };

function renderFooter(ui: FakeUi): string {
	const factory = ui.footerFactory as (tui: unknown, theme: ShellBarTheme, footerData: unknown) => { render(width: number): string[] };
	return factory(fakeTui, plainTheme, footerData).render(160)[0];
}

function sessionChange(ctx: ExtensionContext, id: string, root: string, path: string, before = "", after = "agent\n"): void {
 const entries = ctx.sessionManager.getEntries() as any[];
 entries.push({ type: "custom", customType: "gentle-pi.session-change/v1", data: {
  sessionId: ctx.sessionManager.getSessionId(),
  evidence: { id, root, path, before: before ? {kind:"text",text:before} : {kind:"absent"}, after:{kind:"text",text:after} },
 } });
}

test("captured changes update the widget and bar without repository scans", async () => {
 const { pi, handlers, git } = fakePi([{numstat:"999\t0\tforeign.ts\n",porcelain:"?? foreign.ts\0"}]);
 gentleShell(pi,{});
 const {ctx,ui}=fakeContext();
 await fire(handlers,"session_start",ctx);
 assert.equal(git.length,0);
 assert.equal(ui.widgets.has("gentle-shell-changes"),false);
 sessionChange(ctx,"a","/repo","lib/b.ts","","one\ntwo\n");
 pi.events.emit("gentle-pi:session-change",{sessionId:ctx.sessionManager.getSessionId()});
 await new Promise(resolve=>setImmediate(resolve));
 const factory=ui.widgets.get("gentle-shell-changes") as any;
 assert.match(factory(fakeTui,plainTheme).render(140)[0],/1 file · \+2 −0/);
 assert.match(renderFooter(ui),/main ±1/);
 const rail = sidebarState(fakeTui as unknown as TUI).parts.get("footer")!;
 const digest = rail.digest!();
 assert.match(rail.render(46).join("\n"), /1 file · \+2 −0/);
 sessionChange(ctx,"b","/repo","lib/b.ts","one\ntwo\n","one\ntwo\nthree\n");
 await fire(handlers,"agent_end",ctx);
 assert.notEqual(rail.digest!(), digest, "same-count line changes invalidate the unified Status");
 assert.match(rail.render(46).join("\n"), /1 file · \+3 −0/);
 assert.equal(git.length,0);
 await fire(handlers,"session_shutdown",ctx);
});

test("Changes opens only for captured mutations, not registered dirty roots", async () => {
 const {pi,handlers,commands,tools,git}=fakePi();
 gentleShell(pi,{});
 const {ctx,ui,overlayReady}=fakeContext();
 await fire(handlers,"session_start",ctx);
 await tools.get("session_worktree_register")!.execute("r",{path:"/linked"},undefined,undefined,ctx);
 await commands.get("gentle:changes")!.handler("",ctx);
 assert.match(ui.notices.join("\n"),/No captured agent changes/);
 assert.equal(ui.overlay,undefined);
 sessionChange(ctx,"a","/linked","file.ts");
 await fire(handlers,"agent_end",ctx);
 const opened=commands.get("gentle:changes")!.handler("",ctx);
 await overlayReady;
 assert.match(ui.overlayView!.render(140).join("\n"),/linked/);
 assert.equal(git.length,0);
 ui.closeOverlay?.(); await opened;
 await fire(handlers,"session_shutdown",ctx);
});

test("overlay groups captured roots and refreshes same-count diffs without HEAD or external files", async () => {
 const {pi,handlers,commands,git}=fakePi();
 gentleShell(pi,{GENTLE_PI_SHELL_CHANGES_POLL_MS:"5"});
 const {ctx,ui,overlayReady}=fakeContext();
 sessionChange(ctx,"a","/repo","same.ts","old\n","first\n");
 sessionChange(ctx,"child:a","/linked","same.ts","old\n","child\n");
 await fire(handlers,"session_start",ctx);
 const opened=commands.get("gentle:changes")!.handler("",ctx);
 await overlayReady;
 try {
  ui.overlayView!.handleInput("\r"); ui.overlayView!.handleInput("j");
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.match(ui.overlayView!.render(140).join("\n"),/first/);
  sessionChange(ctx,"b","/repo","same.ts","first\n","second\n");
  pi.events.emit("gentle-pi:session-change",{sessionId:ctx.sessionManager.getSessionId()});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.match(ui.overlayView!.render(140).join("\n"),/second/);
  assert.doesNotMatch(ui.overlayView!.render(140).join("\n"),/first/);
  assert.equal(git.length,0);
 } finally { ui.closeOverlay?.(); await opened; await fire(handlers,"session_shutdown",ctx); }
});

test("new sessions ignore inherited captures, while reload restores the same session", async () => {
 const h=fakePi(); gentleShell(h.pi,{});
 const first=fakeContext();
 sessionChange(first.ctx,"a","/repo","own.ts");
 await fire(h.handlers,"session_start",first.ctx);
 assert.match(renderFooter(first.ui),/±1/);
 await fire(h.handlers,"session_start",first.ctx);
 assert.match(renderFooter(first.ui),/±1/);
 const next=fakeContext({entries:[...first.ctx.sessionManager.getEntries()]});
 (next.ctx.sessionManager as any).getSessionId=()=>"new-session";
 await fire(h.handlers,"session_start",next.ctx);
 h.pi.events.emit("gentle-pi:session-change",{sessionId:"shell-session"});
 assert.doesNotMatch(renderFooter(next.ui),/±1/);
 assert.equal(h.git.length,0);
 await fire(h.handlers,"session_shutdown",next.ctx);
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
	assert.equal(ui.widgets.has("gentle-shell-changes"), false, "preexisting dirty files are not agent changes");
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
	await h.commands.get("gentle:changes")!.handler("", ctx);
	assert.equal(ui.overlay, undefined);
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
	assert.match(ui.notices.join("\n"), /No captured agent changes/);

	const silent = fakePi();
	gentleShell(silent.pi, { GENTLE_PI_SHELL_CHANGES_KEY: "off" });
	assert.equal(silent.shortcuts.has("alt+g"), false, "the changes shortcut must not register when disabled");
});

test("external edits do not pollute Changes or trigger background Git scans", async () => {
 const {pi,handlers,git}=fakePi([{numstat:"4\t2\texternal.ts\n",porcelain:" M external.ts\0"}]);
 gentleShell(pi,{GENTLE_PI_SHELL_CHANGES_WATCH_MS:"5"});
 const {ctx,ui}=fakeContext();
 await fire(handlers,"session_start",ctx);
 await new Promise(resolve=>setTimeout(resolve,30));
 await fire(handlers,"agent_end",ctx);
 assert.equal(git.length,0);
 assert.equal(ui.widgets.has("gentle-shell-changes"),false);
 assert.doesNotMatch(renderFooter(ui),/±/);
 await fire(handlers,"session_shutdown",ctx);
});

const JWT = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.s`;
const USAGE_PAYLOAD = { plan_type: "pro", rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: 1_788_777_491 } } };

function fakeFetch(payload: unknown = USAGE_PAYLOAD, ok = true) {
	const calls: Array<{ url: string; headers: Record<string, string>; init: RequestInit }> = [];
	const fetchFn = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, init: init ?? {} });
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

const NAN_QUOTA_PAYLOAD = {
	periodEnd: "2026-10-01T00:00:00.000Z",
	models: [
		{
			model: "glm5.3",
			cap: 3_000_000_000,
			fullCap: 3_000_000_000,
			tokensUsed: 820_000_000,
			windowHours: 4,
			windowTokens: 400_000_000,
			windowTokensUsed: 120_000_000,
			windowResetsAt: 1_788_620_161,
		},
	],
};

test("fetchNanUsage sends the key to the fixed quota origin and never follows a redirect", async () => {
	const { fetchFn, calls } = fakeFetch(NAN_QUOTA_PAYLOAD);
	const usage = await fetchNanUsage("sk-nan-secret", fetchFn, 1_788_600_000_000);
	assert.equal(usage?.provider, "nan");
	assert.equal(usage?.limits[0].name, "glm5.3");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://cloud-api.nan.builders/api/usage/quota");
	assert.equal(calls[0].headers.Authorization, "Bearer sk-nan-secret");
	assert.equal(calls[0].init.redirect, "error", "a redirect would forward the bearer to another origin");
	assert.equal(calls[0].init.cache, "no-store");
	assert.equal(JSON.stringify(usage).includes("sk-nan-secret"), false);
});

test("fetchNanUsage degrades to no snapshot without ever throwing", async () => {
	const noKey = fakeFetch(NAN_QUOTA_PAYLOAD);
	assert.equal(await fetchNanUsage(undefined, noKey.fetchFn, 0), undefined);
	assert.equal(await fetchNanUsage("", noKey.fetchFn, 0), undefined);
	assert.equal(noKey.calls.length, 0, "no key, no request");

	assert.equal(await fetchNanUsage("sk-nan-secret", fakeFetch(NAN_QUOTA_PAYLOAD, false).fetchFn, 0), undefined, "a non-OK response is not a snapshot");
	assert.equal(await fetchNanUsage("sk-nan-secret", fakeFetch({ models: [] }).fetchFn, 0), undefined, "an empty quota is not a snapshot");
	assert.equal(await fetchNanUsage("sk-nan-secret", fakeFetch({ models: [{ model: "glm5.3", cap: 0, tokensUsed: 0 }] }).fetchFn, 0), undefined);
	const refused = (async () => {
		throw new TypeError("redirect mode is not supported");
	}) as unknown as typeof fetch;
	assert.equal(await fetchNanUsage("sk-nan-secret", refused, 0), undefined, "a refused redirect degrades silently");
});

test("gentleShell fetches NaN quota on session start and shows it in the bar", async () => {
	const { pi, handlers } = fakePi();
	const { fetchFn, calls } = fakeFetch(NAN_QUOTA_PAYLOAD);
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { fetch: fetchFn, now: () => 1_788_600_000_000 });
	const { ctx, ui } = fakeContext({ token: "sk-nan-secret" });
	(ctx as unknown as { model: { provider: string } }).model.provider = "nan";
	await fire(handlers, "session_start", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://cloud-api.nan.builders/api/usage/quota");
	// The fixture's session model holds no NaN allowance of its own, so the
	// account names the meter: a NaN payload of one model is still per-model data.
	assert.match(renderFooter(ui), /\$0\.000 sub ⟡ nan total ▰+▱+ 27%/);

	await fire(handlers, "agent_end", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(calls.length, 1, "agent_end must not refetch within the refresh window");
});

test("a failed NaN refresh keeps the last valid snapshot", async () => {
	const { pi, handlers } = fakePi();
	const calls: string[] = [];
	let fail = false;
	const fetchFn = (async (url: string | URL) => {
		calls.push(String(url));
		if (fail) throw new TypeError("network down");
		return { ok: true, json: async () => NAN_QUOTA_PAYLOAD } as Response;
	}) as typeof fetch;
	let now = 1_788_600_000_000;
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { fetch: fetchFn, now: () => now });
	const { ctx, ui } = fakeContext({ token: "sk-nan-secret" });
	(ctx as unknown as { model: { provider: string } }).model.provider = "nan";
	await fire(handlers, "session_start", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.match(renderFooter(ui), /nan total ▰+▱+/);

	fail = true;
	now += 6 * 60_000;
	await fire(handlers, "agent_end", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(calls.length, 2, "the refresh window elapsed, so the retry was attempted");
	assert.match(renderFooter(ui), /nan total ▰+▱+/, "a failed refresh cannot erase the last valid snapshot");
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

test("a provider switch refreshes the new provider inside the same window", async () => {
	const { pi, handlers } = fakePi();
	const { fetchFn, calls } = fakeFetch(NAN_QUOTA_PAYLOAD);
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { fetch: fetchFn, now: () => 1_788_600_000_000 });
	const { ctx } = fakeContext({ token: JWT });
	await fire(handlers, "session_start", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(calls.length, 1);

	// The 5-minute rule is per provider: the timestamp one provider set cannot
	// leave the next one waiting for a fetch it never made.
	(ctx as unknown as { model: { provider: string } }).model.provider = "nan";
	await fire(handlers, "agent_end", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(calls.length, 2, "a provider switch is a reason to fetch, not to wait");
	assert.equal(calls[1].url, "https://cloud-api.nan.builders/api/usage/quota");
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

test("gentle:commands registers alt+k by default", () => {
	const { pi, shortcuts } = fakePi();
	gentleShell(pi, {});
	assert.ok(shortcuts.has("alt+k"));
});

test("gentle:commands honors GENTLE_PI_COMMANDS_KEY", () => {
	const { pi, shortcuts } = fakePi();
	gentleShell(pi, { GENTLE_PI_COMMANDS_KEY: "ctrl+p" });
	assert.ok(shortcuts.has("ctrl+p"));
	assert.equal(shortcuts.has("alt+k"), false);
});

test("GENTLE_PI_COMMANDS_KEY=off registers no command-palette shortcut", () => {
	const { pi, shortcuts } = fakePi();
	gentleShell(pi, { GENTLE_PI_COMMANDS_KEY: "off" });
	assert.equal(shortcuts.has("alt+k"), false);
	assert.ok(shortcuts.has("alt+g"), "the unrelated changes shortcut still registers");
});

test("/gentle:commands shows only curated, registered commands, grouped, by their labels", async () => {
	const { pi, commands } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui, overlayReady } = fakeContext();
	const opened = commands.get("gentle:commands")!.handler("", ctx);
	await overlayReady;
	const lines = ui.overlayView!.render(100);
	const rendered = lines.join("\n");
	assert.match(rendered, /Configuration/);
	assert.match(rendered, /Session/);
	assert.match(rendered, /Diagnostics/);
	assert.match(rendered, /Skills/);
	assert.doesNotMatch(rendered, /\bSDD\b/, "the SDD group has no registered commands and must not appear");
	assert.match(rendered, /Assign models and effort/);
	assert.match(rendered, /Browse captured changes/);
	assert.match(rendered, /Gentle AI status/);
	assert.match(rendered, /Refresh skill registry/);
	assert.doesNotMatch(rendered, /gentle:models|gentle:changes|gentle:status|skill-registry:refresh/, "raw command names must not leak; only labels are shown");
	assert.doesNotMatch(rendered, /gentle:not-in-catalog/);
	assert.doesNotMatch(rendered, /skill:foo/);
	const changesLine = lines.find((line) => line.includes("Browse captured changes"));
	assert.match(changesLine ?? "", /alt\+g/, "expected the configured alt+g shortcut hint next to Browse captured changes");
	ui.overlayView!.handleInput("\x1b");
	await opened;
});

test("selecting a command from the palette by its label sends the underlying command as a slash message", async () => {
	const { pi, commands, sentMessages } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui, overlayReady } = fakeContext();
	const opened = commands.get("gentle:commands")!.handler("", ctx);
	await overlayReady;
	// "mod" only matches the "Assign models and effort" label (it contains
	// "mod" via "models"); nothing else in the fixture does.
	for (const ch of "mod") ui.overlayView!.handleInput(ch);
	assert.match(ui.overlayView!.render(100).join("\n"), /Assign models and effort/);
	ui.overlayView!.handleInput("\r");
	await opened;
	assert.deepEqual(sentMessages, [{ content: "/gentle:models", options: { expandPromptTemplates: true } }]);
});

test("escaping the palette sends no message", async () => {
	const { pi, commands, sentMessages } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui, overlayReady } = fakeContext();
	const opened = commands.get("gentle:commands")!.handler("", ctx);
	await overlayReady;
	ui.overlayView!.handleInput("\x1b");
	await opened;
	assert.deepEqual(sentMessages, []);
});

test("/gentle:commands notifies when nothing in the catalog is registered", async () => {
	const { pi, commands } = fakePi(undefined, [
		{ name: "skill:foo", description: "A skill", source: "skill", sourceInfo: FAKE_SOURCE_INFO },
		{ name: "gentle:not-in-catalog", description: "Not curated", source: "extension", sourceInfo: FAKE_SOURCE_INFO },
	]);
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	await commands.get("gentle:commands")!.handler("", ctx);
	assert.match(ui.notices.join("\n"), /No Gentle commands are registered\./);
	assert.equal(ui.overlay, undefined);
});

test("/gentle:commands does nothing in a headless context", async () => {
	const { pi, commands, sentMessages } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext({ hasUI: false });
	await commands.get("gentle:commands")!.handler("", ctx);
	assert.equal(ui.overlay, undefined);
	assert.deepEqual(sentMessages, []);
});

test("the alt+k shortcut opens the same command palette as the command", async () => {
	const { pi, shortcuts } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui, overlayReady } = fakeContext();
	const shortcut = shortcuts.get("alt+k");
	assert.ok(shortcut, "alt+k not registered");
	const opened = shortcut.handler(ctx);
	await overlayReady;
	assert.match(ui.overlayView!.render(100).join("\n"), /Assign models and effort/);
	ui.overlayView!.handleInput("\x1b");
	await opened;
});

test("resolving the overlay through closeOverlay sends nothing and does not throw", async () => {
	const { pi, commands, sentMessages } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui, overlayReady } = fakeContext();
	const opened = commands.get("gentle:commands")!.handler("", ctx);
	await overlayReady;
	ui.closeOverlay?.();
	await opened;
	assert.deepEqual(sentMessages, []);
});
