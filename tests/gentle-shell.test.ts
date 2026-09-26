import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext, type SlashCommandInfo, type SourceInfo } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import installGentleShell, { buildShellBarModel, createActiveProfileReader, changesShortcut, devBinaryCard, extractQueuedText, fetchCodexUsage, fetchNanUsage, loadFileDiff, shellGitRunner, openInExternalEditor, usageShortcut, GentlePromptEditor } from "../extensions/gentle-shell.ts";
import { USAGE_SOURCE_EVENT, USAGE_SOURCE_SCHEMA } from "../lib/shell-usage.ts";
import { createVimEditorAdapter } from "../lib/vim-editor-adapter.ts";
import { buildCommandPaletteGroups } from "../lib/command-palette-catalog.ts";
import { CHANGE_STATUS } from "../lib/shell-changes.ts";
import { sidebarState, type SidebarRail } from "../lib/shell-sidebar.ts";
import type { ShellBarTheme } from "../lib/shell-bar.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { resolveVisualSettings, writeVisualSettings } from "../lib/visual-customization-policy.ts";
import { resolveAnimationPolicy } from "../lib/animation-policy.ts";
import { resolveVimPolicy, writeVimPolicy } from "../lib/vim-policy.ts";
import { readBannerConfig } from "../extensions/startup-banner.ts";
import { listVisualProfiles, saveVisualProfile } from "../lib/visual-profiles.ts";
import { oddPhaseRegistry } from "../lib/odd-phase.ts";

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
	description?: string;
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

function fakeContext(options: { hasUI?: boolean; entries?: unknown[]; oauth?: boolean; pending?: boolean; idle?: boolean; editorFactory?: unknown; token?: string; select?: (title: string, options: string[]) => Promise<string | undefined> } = {}): { ctx: ExtensionContext; ui: FakeUi; overlayReady: Promise<void> } {
	const ui: FakeUi = { footerFactory: undefined, editorFactory: options.editorFactory, widgets: new Map(), widgetSets: 0, workingVisible: undefined, notices: [], overlay: undefined, overlayView: undefined, closeOverlay: undefined };
	let resolveOverlay: () => void;
	const overlayReady = new Promise<void>((resolve) => { resolveOverlay = resolve; });
	const entries = options.entries ?? [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: "tui",
		hasPendingMessages: () => options.pending ?? false,
		isIdle: () => options.idle ?? true,
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
			getAllThemes: () => [{ name: "dark", path: undefined }, { name: "light", path: undefined }],
			getTheme: (name: string) => name === "dark" || name === "light" ? { name } : undefined,
			setTheme: (name: string) => ({ success: name === "dark" || name === "light" }),
			// Added only when requested: an absent select keeps the no-menu fallback
			// that every pre-existing test relies on.
			...(options.select ? { select: options.select } : {}),
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
					// An identity bg mock hides focused rows; omit it so overlay navigation
					// remains inspectable through Commands' ▸ fallback.
					ui.overlayView = factory(fakeTui, { ...plainTheme, bg: undefined }, fakeKeybindings, (value: T) => resolve(value));
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

test("the fullscreen Status rail carries a live digest so a profile switch refreshes it", async () => {
	const { pi, handlers } = fakePi();
	let profile: string | undefined = "team";
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { activeProfile: () => profile });
	const { ctx, ui } = fakeContext();
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
		assert.doesNotMatch(rail.render(46).join("\n"), /gpt-5\.5/, "model now lives in the header, not the Status card");

		assert.match(rail.render(46).join("\n"), /Profile.*team/);
		const beforeProfile = live();
		profile = "other";
		assert.notEqual(live(), beforeProfile);
		assert.match(rail.render(46).join("\n"), /Profile.*other/);
		profile = undefined;
		assert.doesNotMatch(rail.render(46).join("\n"), /Profile/);

		const beforeStatus = live();
		statuses.set("mcp", "MCP: 3 servers enabled");
		assert.notEqual(live(), beforeStatus, "extension statuses have no event and must change the digest");
		assert.match(rail.render(46).join("\n"), /MCP: 3 servers enabled/);
		assert.equal(live(), live(), "an unchanged digest still reuses the prepared rail");
	} finally {
		component.dispose();
	}
});

test("the fullscreen header rail carries a live digest so model, context, and cost changes refresh it", async () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" });
	const entries: unknown[] = [];
	const { ctx, ui } = fakeContext({ entries });
	await fire(handlers, "session_start", ctx);

	const liveFooterData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map([["mcp", "MCP: 3 servers enabled"]]), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };
	const tui = { terminal: { rows: 40, columns: 160 }, requestRender() {} };
	const factory = ui.footerFactory as (tui: unknown, theme: ShellBarTheme, footerData: unknown) => { render(width: number): string[]; dispose(): void };
	const component = factory(tui, plainTheme, liveFooterData);
	try {
		const header = sidebarState(tui as unknown as TUI).parts.get("header") as SidebarRail;
		assert.equal(typeof header.digest, "function", "the header paints live state every frame and must declare a digest");
		const live = () => header.digest?.();
		const text = () => header.render(160).join("\n");
		assert.match(text(), /gpt-5\.5/);
		assert.doesNotMatch(text(), /MCP: 3 servers/, "extension statuses never reach the header");
		assert.doesNotMatch(text(), /working/i, "the working state never reaches the header");

		const beforeModel = live();
		(ctx.model as { id: string }).id = "gpt-5.6";
		assert.notEqual(live(), beforeModel, "/model must change the header digest");
		assert.match(text(), /gpt-5\.6/);

		const beforeUsage = live();
		(ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: 200_000, contextWindow: 272_000, percent: 74 });
		assert.notEqual(live(), beforeUsage, "context usage must change the header digest");
		assert.match(text(), /74%/);

		const beforeCost = live();
		entries.push(assistantEntry({ input: 100, output: 20, cost: 0.42 }));
		assert.notEqual(live(), beforeCost, "session cost must change the header digest");
		assert.match(text(), /\$0\.420/);
		assert.equal(live(), live(), "an unchanged digest still reuses the prepared header");
	} finally {
		component.dispose();
	}
});

test("clicking the header's usage segment opens the usage panel; other header clicks are ignored", async () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" });
	const { ctx, ui } = fakeContext();
	await fire(handlers, "session_start", ctx);

	const liveFooterData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };
	const tui = { terminal: { rows: 40, columns: 160 }, requestRender() {} };
	const factory = ui.footerFactory as (tui: unknown, theme: ShellBarTheme, footerData: unknown) => { render(width: number): string[]; dispose(): void };
	const component = factory(tui, plainTheme, liveFooterData);
	try {
		const header = sidebarState(tui as unknown as TUI).parts.get("header") as SidebarRail;
		const line = header.render(160).join("");
		const usageAt = line.indexOf("usage");
		assert.ok(usageAt >= 0, "the header shows a standing usage segment");

		const click = (x: number) => header.handleMouse?.({ type: "click", button: "left", x, y: 0, screenX: x, screenY: 0, width: 160, height: 1, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
		assert.equal(click(0), undefined, "a click on the brand does not open the panel");
		const hit = click(usageAt + 1);
		assert.equal(hit?.handled, true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.match(ui.overlayView!.render(90).join("\n"), /Subscriptions/);
		ui.closeOverlay?.();
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

test("bound profile reader follows pin precedence and keeps frames free of resolution", (t) => {
	const home = mkdtempSync(join(tmpdir(), "shell-effective-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const repo = join(home, "repo");
	const commonDir = join(home, "git");
	const local = join(commonDir, "gentle-ai", "profile-pin.json");
	const shared = join(repo, ".pi", "gentle-ai", "profile.json");
	mkdirSync(join(commonDir, "gentle-ai"), { recursive: true });
	mkdirSync(join(repo, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(join(home, "profiles.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, active: "team", profiles: { team: {}, other: {} } }));
	const pin = (path: string, profile: string) => writeFileSync(path, JSON.stringify({ kind: "gentle-pi.agent_model_profile_pin", version: 1, profile }));
	const read = createActiveProfileReader({ GENTLE_PI_CONFIG_HOME: home });
	let resolutions = 0;
	const resolver = () => { resolutions++; return { root: repo, commonDir }; };
	assert.equal(read(), "team");
	read.bind(repo, resolver);
	assert.equal(read(), "team");
	pin(shared, "other");
	assert.equal(read(), "team", "edits wait for a refresh");
	assert.equal(read.refresh(), true);
	assert.equal(read(), "other (repo)");
	pin(local, "other");
	assert.equal(read.refresh(), true, "same name with a different source changes the display");
	assert.equal(read(), "other (local)");
	for (let i = 0; i < 20; i++) assert.equal(read(), "other (local)");
	assert.equal(resolutions, 1, "bound frames and polls reuse the worktree identity");
	pin(local, "stale");
	assert.equal(read.refresh(), true);
	assert.equal(read(), "other (repo)");
	writeFileSync(shared, "invalid");
	assert.equal(read.refresh(), true);
	assert.equal(read(), "team");
	read.reset();
	assert.equal(read(), "team");
	assert.equal(read.refresh(), false);
});

test("profile polling refreshes both fullscreen surfaces only on change and stops across sessions", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "shell-poll-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const repo = join(home, "repo");
	const commonDir = join(home, "git");
	const local = join(commonDir, "gentle-ai", "profile-pin.json");
	mkdirSync(join(commonDir, "gentle-ai"), { recursive: true });
	mkdirSync(repo);
	writeFileSync(join(home, "profiles.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, active: "team", profiles: { team: {}, other: {} } }));
	const intervals: Array<{ tick: () => void; delay: number; stopped: boolean }> = [];
	t.mock.method(globalThis, "setInterval", (tick: () => void, delay: number) => {
		const timer = { tick, delay, stopped: false };
		intervals.push(timer);
		return { unref() {}, timer };
	});
	t.mock.method(globalThis, "clearInterval", (handle: { timer: (typeof intervals)[number] }) => { handle.timer.stopped = true; });
	const { pi, handlers } = fakePi();
	let resolutions = 0;
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home, GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, {
		resolveWorktree: () => { resolutions++; return { root: repo, commonDir }; },
	});
	const first = fakeContext();
	await fire(handlers, "session_start", first.ctx);
	const tui = { terminal: { rows: 40, columns: 160 }, requestRender: t.mock.fn() };
	const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {} };
	const factory = first.ui.footerFactory as (tui: unknown, theme: ShellBarTheme, data: unknown) => { dispose(): void };
	const component = factory(tui, plainTheme, footerData);
	const state = sidebarState(tui as unknown as TUI);
	const status = () => (state.parts.get("footer") as SidebarRail).render(60).join("\n");
	const header = () => (state.parts.get("header") as SidebarRail).render(160).join("\n");
	try {
		const timer = intervals.find((entry) => entry.delay === 2000);
		assert.ok(timer, "UI session installs the 2000ms profile refresh");
		assert.match(status(), /Profile.*team/);
		assert.match(header(), /team/);
		const before = tui.requestRender.mock.callCount();
		timer.tick();
		assert.equal(tui.requestRender.mock.callCount(), before, "unchanged poll does not render");
		writeFileSync(local, JSON.stringify({ kind: "gentle-pi.agent_model_profile_pin", version: 1, profile: "other" }));
		assert.match(status(), /Profile.*team/, "external edits do not read during render");
		timer.tick();
		assert.equal(tui.requestRender.mock.callCount(), before + 1);
		assert.match(status(), /Profile.*other \(local\)/);
		assert.match(header(), /other \(local\)/);
		timer.tick();
		assert.equal(tui.requestRender.mock.callCount(), before + 1);
		const afterBind = resolutions;
		status(); header(); timer.tick();
		assert.equal(resolutions, afterBind, "poll and render reuse the session Git identity");
		const second = fakeContext();
		await fire(handlers, "session_start", second.ctx);
		assert.equal(timer.stopped, true);
		const replacement = intervals.filter((entry) => entry.delay === 2000).at(-1)!;
		assert.notEqual(replacement, timer);
		writeFileSync(local, "invalid");
		timer.tick();
		assert.equal(tui.requestRender.mock.callCount(), before + 1, "old session cannot repaint");
		await fire(handlers, "session_shutdown", second.ctx);
		assert.equal(replacement.stopped, true);
		replacement.tick();
		assert.equal(tui.requestRender.mock.callCount(), before + 1);
	} finally {
		component.dispose();
	}
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

function installedPrompt(
	ctx: ExtensionContext,
	ui: FakeUi,
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>,
	keybindings: unknown = fakeKeybindings,
): GentlePromptEditor {
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	const factory = ui.editorFactory as (tui: unknown, theme: unknown, keybindings: unknown) => GentlePromptEditor;
	return factory(fakeTui, editorTheme, keybindings);
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

test("an explicit ODD phase reported for the session renders in the working label", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
		oddPhaseRegistry.report(ctx.sessionManager.getSessionId(), "exploring");
		assert.match(editor.render(60).map(stripAnsi)[0], /^╭─ .+ exploring… ─+╮$/);
	} finally {
		oddPhaseRegistry.clear(ctx.sessionManager.getSessionId());
		editor.dispose();
	}
});

test("an unknown or unreported phase falls back to the generic working label", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
		assert.match(editor.render(60).map(stripAnsi)[0], /^╭─ .+ working… ─+╮$/);
	} finally {
		editor.dispose();
	}
});

test("agent_start clears a previous turn's phase so it never leaks into the next turn", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
		oddPhaseRegistry.report(ctx.sessionManager.getSessionId(), "checking");
		for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
		assert.match(editor.render(60).map(stripAnsi)[0], /^╭─ .+ working… ─+╮$/, "a new turn must start unlabeled");
	} finally {
		editor.dispose();
	}
});

test("agent_settled going idle clears the reported phase, including after an abort", async () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
		oddPhaseRegistry.report(ctx.sessionManager.getSessionId(), "implementing");
		await fire(handlers, "agent_settled", ctx);
		assert.equal(oddPhaseRegistry.get(ctx.sessionManager.getSessionId()), undefined);
	} finally {
		editor.dispose();
	}
});

test("session_shutdown clears the reported phase", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	oddPhaseRegistry.report(ctx.sessionManager.getSessionId(), "researching");
	for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
	assert.equal(oddPhaseRegistry.get(ctx.sessionManager.getSessionId()), undefined);
	editor.dispose();
});

test("a phase reported for one session never leaks into another session's prompt", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
		oddPhaseRegistry.report("a-background-child-session", "exploring");
		assert.match(editor.render(60).map(stripAnsi)[0], /^╭─ .+ working… ─+╮$/, "a different session's report must not override this prompt");
	} finally {
		oddPhaseRegistry.clear("a-background-child-session");
		editor.dispose();
	}
});

test("a reported phase does not override the queued label", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext({ pending: true });
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
		oddPhaseRegistry.report(ctx.sessionManager.getSessionId(), "checking");
		assert.match(editor.render(60).map(stripAnsi)[0], /^╭─ .+ queued ─+╮$/);
	} finally {
		oddPhaseRegistry.clear(ctx.sessionManager.getSessionId());
		editor.dispose();
	}
});

test("reporting an ODD phase requests an immediate redraw even under the potato animation policy, which runs no pulse loop at all", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	let renders = 0;
	const localTui = { terminal: { rows: 40, columns: 120 }, requestRender() { renders += 1; } };
	const factory = ui.editorFactory as (tui: unknown, theme: unknown, keybindings: unknown) => GentlePromptEditor;
	const editor = factory(localTui, editorTheme, fakeKeybindings);
	try {
		editor.setAnimationPolicy("potato");
		for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
		renders = 0;
		oddPhaseRegistry.report(ctx.sessionManager.getSessionId(), "planning");
		assert.ok(renders > 0, "a phase report must trigger a redraw directly; potato mode schedules no pulse interval to pick it up later");
	} finally {
		oddPhaseRegistry.clear(ctx.sessionManager.getSessionId());
		editor.dispose();
	}
});

test("session_shutdown stops requesting redraws for a since-closed session", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	let renders = 0;
	const localTui = { terminal: { rows: 40, columns: 120 }, requestRender() { renders += 1; } };
	const factory = ui.editorFactory as (tui: unknown, theme: unknown, keybindings: unknown) => GentlePromptEditor;
	const editor = factory(localTui, editorTheme, fakeKeybindings);
	for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
	renders = 0;
	oddPhaseRegistry.report(ctx.sessionManager.getSessionId(), "closing");
	assert.equal(renders, 0, "a session that already shut down must not receive further redraw requests");
	oddPhaseRegistry.clear(ctx.sessionManager.getSessionId());
	editor.dispose();
});

test("dot replays at a new cursor; each repeat and insert session is one undo unit", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("one two three"); editor.handleInput("\x1b");
    editor.handleInput("0"); editor.handleInput("x");
    assert.equal(editor.getText(), "ne two three");
    editor.handleInput("w"); editor.handleInput(".");
    assert.equal(editor.getText(), "ne wo three");
    editor.handleInput("u"); assert.equal(editor.getText(), "ne two three");
    editor.handleInput("u"); assert.equal(editor.getText(), "one two three");
    editor.handleInput("i");
    for (const key of ["é", " ", "👩‍💻"]) editor.handleInput(key);
    editor.handleInput("\x1b");
    assert.equal(editor.getText(), "é 👩‍💻one two three");
    editor.handleInput("u"); assert.equal(editor.getText(), "one two three");
  } finally { editor.dispose(); }
});

test("completed insert and change replay as semantic Unicode edits with one undo per dot", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("one two three"); editor.handleInput("\x1b"); editor.handleInput("0");
    editor.handleInput("c"); editor.handleInput("w"); editor.handleInput("👩‍💻"); editor.handleInput("é"); editor.handleInput("\x1b");
    assert.equal(editor.getText(), "👩‍💻étwo three");
    editor.handleInput("w"); editor.handleInput(".");
    assert.equal(editor.getText(), "👩‍💻étwo 👩‍💻é");
    editor.handleInput("u"); assert.equal(editor.getText(), "👩‍💻étwo three");
    editor.handleInput("u"); assert.equal(editor.getText(), "one two three");
    editor.handleInput("i"); editor.handleInput("雪"); editor.handleInput("\x1b");
    editor.handleInput("w"); editor.handleInput("2"); editor.handleInput(".");
    assert.equal((editor.getText().match(/雪/gu) ?? []).length, 3);
    editor.handleInput("u"); assert.equal((editor.getText().match(/雪/gu) ?? []).length, 2);
    editor.handleInput("u"); assert.equal((editor.getText().match(/雪/gu) ?? []).length, 1);
  } finally { editor.dispose(); }
});

test("open-line, substitute and motion shift remain bounded across multiline replay", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("one\ntwo\nthree"); editor.handleInput("\x1b");
    editor.handleInput("g"); editor.handleInput("g"); editor.handleInput(">"); editor.handleInput("j");
    assert.equal(editor.getText(), "  one\n  two\nthree");
    editor.handleInput("u"); assert.equal(editor.getText(), "one\ntwo\nthree");
    editor.handleInput("g"); editor.handleInput("g"); editor.handleInput("o");
    editor.handleInput("雪"); editor.handleInput("\x1b");
    assert.equal(editor.getText(), "one\n雪\ntwo\nthree");
    editor.handleInput("j"); editor.handleInput(".");
    assert.equal(editor.getText(), "one\n雪\ntwo\n雪\nthree");
    editor.handleInput("u"); assert.equal(editor.getText(), "one\n雪\ntwo\nthree");
    editor.handleInput("u"); assert.equal(editor.getText(), "one\ntwo\nthree");
  } finally { editor.dispose(); }
});

test("O and S replay multiline text with one undo unit and no raw-key playback", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("a\nb"); editor.handleInput("\x1b");
    editor.handleInput("O"); editor.handleInput("雪"); editor.handleInput("\x1b");
    assert.equal(editor.getText(), "a\n雪\nb");
    editor.handleInput("g"); editor.handleInput("g"); editor.handleInput(".");
    assert.equal(editor.getText(), "雪\na\n雪\nb");
    editor.handleInput("u"); assert.equal(editor.getText(), "a\n雪\nb");
    editor.handleInput("u"); assert.equal(editor.getText(), "a\nb");
    editor.handleInput("S"); editor.handleInput("👩‍💻"); editor.handleInput("\x1b");
    editor.handleInput("g"); editor.handleInput("g"); editor.handleInput(".");
    assert.equal(editor.getText(), "👩‍💻\n👩‍💻");
    editor.handleInput("u"); assert.equal(editor.getText(), "a\n👩‍💻");
  } finally { editor.dispose(); }
});

test("substitute and append replay at the new cursor without changing the register", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("ab cd"); editor.handleInput("\x1b"); editor.handleInput("0");
    editor.handleInput("s"); editor.handleInput("é"); editor.handleInput("\x1b");
    editor.handleInput("w"); editor.handleInput(".");
    assert.equal(editor.getText(), "éb éd");
    editor.handleInput("u"); assert.equal(editor.getText(), "éb cd");
    editor.handleInput("u"); assert.equal(editor.getText(), "ab cd");
    editor.handleInput("0"); editor.handleInput("a"); editor.handleInput("雪"); editor.handleInput("\x1b");
    editor.handleInput("w"); editor.handleInput(".");
    assert.equal((editor.getText().match(/雪/gu) ?? []).length, 2);
  } finally { editor.dispose(); }
});

test("empty insert and interrupted insert do not replace the last completed repeat", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers,
    { matches: (data: string, action: string) => action === "app.interrupt" && data === "\x03" });
  try {
    editor.setVimPolicy("on"); editor.setText("abcd"); editor.handleInput("\x1b"); editor.handleInput("0");
    editor.handleInput("x"); editor.handleInput("i"); editor.handleInput("\x1b");
    editor.handleInput("."); assert.equal(editor.getText(), "cd");
    editor.handleInput("i"); editor.handleInput("雪"); editor.handleInput("\x03");
    editor.handleInput("."); assert.equal(editor.getText(), "雪d");
  } finally { editor.dispose(); }
});

test("change plus its insert session undoes as one complete change", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("one two"); editor.handleInput("\x1b"); editor.handleInput("0");
    editor.handleInput("c"); editor.handleInput("w");
    editor.handleInput("é"); editor.handleInput(" "); editor.handleInput("👩‍💻"); editor.handleInput("\x1b");
    assert.equal(editor.getText(), "é 👩‍💻two");
    editor.handleInput("u"); assert.equal(editor.getText(), "one two");
  } finally { editor.dispose(); }
});

test("counted dot, canceled operator, empty changes and unsupported visual do not corrupt the draft", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("abcde"); editor.handleInput("\x1b");
    editor.handleInput("0"); editor.handleInput("x");
    editor.handleInput("2"); editor.handleInput(".");
    assert.equal(editor.getText(), "de");
    editor.handleInput("u"); assert.equal(editor.getText(), "cde");
    editor.handleInput("u"); assert.equal(editor.getText(), "bcde");
    editor.handleInput("d"); editor.handleInput("\x1b");
    editor.handleInput("v"); editor.handleInput("y"); editor.handleInput(".");
    assert.equal(editor.getText(), "cde");
  } finally { editor.dispose(); }
});

test("visual char and line selections paint effective inverse in the framed editor and Esc keeps the draft", () => {
  const { pi, handlers } = fakePi();
  gentleShell(pi, {});
  const { ctx, ui } = fakeContext();
  const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on");
    editor.setText("ab\ncd");
    editor.handleInput("\x1b");
    editor.handleInput("v");
    editor.handleInput("2"); editor.handleInput("h");
    assert.deepEqual(reverseColumns(editor.render(30)[2]!), [1, 2], "selection includes both c and d");
    editor.handleInput("V");
    assert.deepEqual(reverseColumns(editor.render(30)[2]!), [1, 2]);
    editor.handleInput("k");
    assert.deepEqual(reverseColumns(editor.render(30)[1]!), [1, 2]);
    editor.handleInput("\x1b");
    assert.equal(editor.getText(), "ab\ncd");
    assert.match(editor.render(30).join("\n"), /NORMAL/);
  } finally { editor.dispose(); }
});

test("visual line delete, yank/paste, change and shifts use one undo step without leaking NORMAL text", () => {
  const { pi, handlers } = fakePi();
  gentleShell(pi, {});
  const { ctx, ui } = fakeContext();
  const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("one\ntwo\nthree"); editor.handleInput("\x1b");
    editor.handleInput("V"); editor.handleInput("k"); editor.handleInput("y");
    assert.equal(editor.getText(), "one\ntwo\nthree");
    editor.handleInput("p"); assert.equal(editor.getText(), "one\ntwo\ntwo\nthree\nthree");
    editor.handleInput("u"); assert.equal(editor.getText(), "one\ntwo\nthree");
    editor.handleInput("V"); editor.handleInput("k"); editor.handleInput("d");
    assert.equal(editor.getText(), "three");
    editor.handleInput("u"); assert.equal(editor.getText(), "one\ntwo\nthree");
    editor.handleInput("V"); editor.handleInput(">");
    assert.equal(editor.getText(), "  one\ntwo\nthree");
    editor.handleInput("u"); assert.equal(editor.getText(), "one\ntwo\nthree");
    editor.handleInput("G"); editor.handleInput("v"); editor.handleInput("c");
    assert.match(editor.render(30).join("\n"), /INSERT/);
    editor.handleInput("Z"); assert.equal(editor.getText(), "one\ntwo\nZhree");
  } finally { editor.dispose(); }
});

test("visual anchor swap, grapheme delete and registered paste rejection keep selection safe", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("a👩‍💻b"); editor.handleInput("\x1b");
    editor.handleInput("0"); editor.handleInput("v"); editor.handleInput("l");
    editor.handleInput("o"); assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    editor.handleInput("d"); assert.equal(editor.getText(), "b");
    editor.handleInput("u"); assert.equal(editor.getText(), "a👩‍💻b");
    editor.setText(""); editor.handleInput("i");
    editor.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
    const before = editor.getExpandedText();
    editor.handleInput("\x1b"); editor.handleInput("0"); editor.handleInput("v"); editor.handleInput("y");
    assert.equal(editor.getExpandedText(), before);
    assert.match(editor.render(30).join("\n"), /VISUAL/);
    editor.handleInput("\x1b"); assert.match(editor.render(30).join("\n"), /NORMAL/);
  } finally { editor.dispose(); }
});

test("visual text objects select exact range then operate, with failed match retaining selection and register", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText('one two (é 👩‍💻) "hi"'); editor.handleInput("\x1b");
    editor.handleInput("g"); editor.handleInput("g"); editor.handleInput("v");
    for (const key of ["i", "w", "y"]) editor.handleInput(key);
    assert.equal(editor.getText(), 'one two (é 👩‍💻) "hi"');
    editor.handleInput("f"); editor.handleInput("("); editor.handleInput("v");
    for (const key of ["i", "(", "d"]) editor.handleInput(key);
    assert.equal(editor.getText(), 'one two () "hi"');
    editor.handleInput("u");
    editor.handleInput("v"); editor.handleInput("i"); editor.handleInput('"');
    assert.match(editor.render(30).join("\n"), /VISUAL/);
    assert.equal(editor.getText(), 'one two (é 👩‍💻) "hi"');
    editor.handleInput("d"); assert.equal(editor.getText(), 'one two (é ) "hi"');
  } finally { editor.dispose(); }
});

test("visual word, WORD and quoted objects replace only the selected text and allow shortcut handoff", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText('alpha beta "é👩‍💻"'); editor.handleInput("\x1b");
    editor.handleInput("g"); editor.handleInput("g"); editor.handleInput("v");
    for (const key of ["i", "w", "y"]) editor.handleInput(key);
    editor.handleInput("v"); editor.handleInput("a"); editor.handleInput("w"); editor.handleInput("d");
    assert.equal(editor.getText(), 'beta "é👩‍💻"');
    editor.handleInput("u");
    editor.handleInput("f"); editor.handleInput('"'); editor.handleInput("v"); editor.handleInput("a"); editor.handleInput('"');
    editor.handleInput("c");
    assert.equal(editor.getText(), 'alpha beta ');
    assert.match(editor.render(30).join("\n"), /INSERT/);
    editor.handleInput("\x1b"); editor.handleInput("v");
    editor.onExtensionShortcut = (data) => {
      if (data !== "ctrl+k") return false;
      assert.match(editor.render(30).join("\n"), /INSERT/);
      return true;
    };
    editor.handleInput("i"); editor.handleInput("ctrl+k");
    assert.match(editor.render(30).join("\n"), /INSERT/);
  } finally { editor.dispose(); }
});

test("visual object selection refuses registered paste markers without moving or changing text", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("(abc)"); editor.handleInput("\x1b");
    editor.handleInput("g"); editor.handleInput("g"); editor.handleInput("l"); editor.handleInput("i"); editor.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
    const original = editor.getExpandedText();
    editor.handleInput("\x1b"); editor.handleInput("v");
    const cursor = editor.getCursor();
    editor.handleInput("i"); editor.handleInput("(");
    assert.equal(editor.getExpandedText(), original);
    assert.deepEqual(editor.getCursor(), cursor);
    assert.match(editor.render(30).join("\n"), /VISUAL/);
  } finally { editor.dispose(); }
});

test("visual entry at EOF selects the last grapheme and empty document cannot clobber the register", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("abc"); editor.handleInput("\x1b");
    editor.handleInput("v");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
    editor.handleInput("d"); assert.equal(editor.getText(), "ab");
    editor.handleInput("u"); assert.equal(editor.getText(), "abc");
    editor.setText(""); editor.handleInput("v"); editor.handleInput("d");
    assert.equal(editor.getText(), "");
    editor.handleInput("p"); assert.equal(editor.getText(), "c");
  } finally { editor.dispose(); }
});

test("visual entry and yank clear a pending delete before a normal motion", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("abc def"); editor.handleInput("\x1b");
    editor.handleInput("h");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
    for (const key of ["d", "v", "y", "0"]) editor.handleInput(key);
    assert.equal(editor.getText(), "abc def");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    editor.handleInput("P");
    assert.equal(editor.getText(), "fabc def", "visual yank remains available after clearing the pending operator");
  } finally { editor.dispose(); }
});

test("empty visual-line delete leaves the previous register available", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("saved"); editor.handleInput("\x1b");
    editor.handleInput("v"); editor.handleInput("y");
    editor.setText("");
    editor.handleInput("V"); editor.handleInput("d");
    assert.equal(editor.getText(), "");
    editor.handleInput("p");
    assert.equal(editor.getText(), "d", "the no-op delete must not replace the saved character with a newline");
  } finally { editor.dispose(); }
});

test("visual p replaces a Unicode selection atomically and yanks overwritten text", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("👩‍💻é z"); editor.handleInput("\x1b");
    editor.handleInput("0"); editor.handleInput("v"); editor.handleInput("y");
    editor.handleInput("l"); editor.handleInput("v"); editor.handleInput("p");
    assert.equal(editor.getText(), "👩‍💻👩‍💻 z");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
    assert.match(editor.render(30).join("\n"), /NORMAL/);
    editor.handleInput("u"); assert.equal(editor.getText(), "👩‍💻é z");
    editor.handleInput("P"); assert.equal(editor.getText(), "👩‍💻éé z", "overwritten selection becomes the register");
  } finally { editor.dispose(); }
});

test("visual line p swaps whole lines, one undo restores the selection, and paste marker rejection retains mode", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("alpha\nbeta\ngamma"); editor.handleInput("\x1b");
    editor.handleInput("V"); editor.handleInput("y");
    editor.handleInput("k"); editor.handleInput("V"); editor.handleInput("p");
    assert.equal(editor.getText(), "alpha\ngamma\ngamma");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
    editor.handleInput("u"); assert.equal(editor.getText(), "alpha\nbeta\ngamma");
    editor.setText(""); editor.handleInput("i");
    editor.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
    const original = editor.getExpandedText();
    editor.handleInput("\x1b"); editor.handleInput("0"); editor.handleInput("v"); editor.handleInput("p");
    assert.equal(editor.getExpandedText(), original);
    assert.match(editor.render(30).join("\n"), /VISUAL/);
  } finally { editor.dispose(); }
});

test("full-line characterwise VISUAL c/p on ordinary text retain frame and autocomplete", () => {
  for (const command of ["c", "p"] as const) {
    const { pi, handlers } = fakePi(); gentleShell(pi, {});
    const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
    try {
      editor.setVimPolicy("on"); editor.setText("asdf asdf asd f"); editor.handleInput("\x1b");
      editor.handleInput("0"); editor.handleInput("v"); editor.handleInput("$");
      const before = editor.render(30);
      assert.match(before.join("\n"), /VISUAL(?! LINE)/);
      assert.deepEqual(reverseColumns(before[1]!).filter((col) => col >= 1 && col <= 15).length, 15);
      assert.ok(before.every((row) => visibleWidth(row) === 30));
      const internal = editor as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] } };
      if (command === "p") {
        editor.handleInput("y"); editor.handleInput("0"); editor.handleInput("v"); editor.handleInput("$");
      }
      internal.autocompleteState = "force";
      internal.autocompleteList = { render: () => ["completion"] };
      editor.handleInput(command);
      assert.equal(ui.notices.length, 0);
      assert.equal(editor.getText(), command === "c" ? "" : "asdf asdf asd f");
      assert.match(editor.render(30).join("\n"), command === "c" ? /INSERT/ : /NORMAL/);
      assert.equal(editor.isShowingAutocomplete(), false);
      assert.ok(editor.render(30).every((row) => visibleWidth(row) === 30));
    } finally { editor.dispose(); }
  }
});

test("typed INSERT draft can enter VISUAL c after Escape across repeated mode cycles", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on");
    // Pi installs a global shortcut probe even when no extension owns the key.
    editor.onExtensionShortcut = () => false;
    for (const key of "asdf asdf") editor.handleInput(key);
    editor.handleInput("\x1b");
    assert.match(editor.render(30).join("\n"), /NORMAL/);
    editor.handleInput("0"); editor.handleInput("v"); editor.handleInput("l"); editor.handleInput("c");
    assert.deepEqual(ui.notices, []);
    assert.equal(editor.getText(), "df asdf");
    assert.match(editor.render(30).join("\n"), /INSERT/);
    editor.handleInput("X"); editor.handleInput("\x1b");
    assert.match(editor.render(30).join("\n"), /NORMAL/);
    editor.handleInput("p");
    assert.equal(editor.getText(), "Xdasf asdf");
    editor.handleInput("u");
    assert.equal(editor.getText(), "Xdf asdf");
    editor.handleInput("u");
    assert.equal(editor.getText(), "asdf asdf");
    editor.handleInput("i"); editor.handleInput("!"); editor.handleInput("\x1b");
    editor.handleInput("0"); editor.handleInput("v"); editor.handleInput("l"); editor.handleInput("c");
    assert.deepEqual(ui.notices, []);
    assert.equal(editor.getText(), "sdf asdf");
    assert.match(editor.render(30).join("\n"), /INSERT/);
  } finally { editor.dispose(); }
});

test("VISUAL c/p report unsafe registered paste selections without changing draft or register", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("saved"); editor.handleInput("\x1b");
    editor.handleInput("0"); editor.handleInput("v"); editor.handleInput("y");
    editor.setText(""); editor.handleInput("i");
    editor.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
    const draft = editor.getExpandedText();
    editor.handleInput("\x1b"); editor.handleInput("0"); editor.handleInput("v");
    for (const command of ["c", "p"]) {
      const count = ui.notices.length;
      editor.handleInput(command);
      assert.equal(editor.getExpandedText(), draft);
      assert.match(editor.render(30).join("\n"), /VISUAL/);
      assert.equal(ui.notices.length, count + 1);
      assert.match(ui.notices.at(-1)!, /selection.*paste marker.*\[readRange:paste-marker\]/i);
      assert.ok(!ui.notices.at(-1)!.includes("z".repeat(20)));
    }
    editor.handleInput("\x1b"); editor.setText("xx"); editor.handleInput("0"); editor.handleInput("v"); editor.handleInput("p");
    assert.equal(editor.getText(), "sx", "unsafe c/p must not overwrite the Vim register");
  } finally { editor.dispose(); }
});

test("VISUAL replace failure reports a bounded stage without leaking raw host errors", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("asdf asdf asd f"); editor.handleInput("\x1b");
    editor.handleInput("0"); editor.handleInput("v"); editor.handleInput("$");
    const internal = editor as unknown as { pushUndoSnapshot(): void };
    const originalSnapshot = internal.pushUndoSnapshot;
    internal.pushUndoSnapshot = () => { throw new Error("private /secret/draft asdf asdf asd f"); };
    editor.handleInput("c");
    assert.equal(editor.getText(), "asdf asdf asd f");
    assert.match(editor.render(30).join("\n"), /VISUAL/);
    assert.equal(ui.notices.at(-1), "Vim selection cannot be edited safely; try a different selection. [replace:unexpected]");
    assert.ok(!ui.notices.at(-1)!.includes("/secret/"));
    internal.pushUndoSnapshot = originalSnapshot;
    editor.handleInput("c");
    assert.equal(ui.notices.length, 1, "failed replacement must close its insert session before retry");
    assert.equal(editor.getText(), "");
    assert.match(editor.render(30).join("\n"), /INSERT/);
  } finally { editor.dispose(); }
});

test("visual case, replace, join and shift operators act on selected text without escaping ownership", () => {
  const { pi, handlers } = fakePi(); gentleShell(pi, {});
  const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
  try {
    editor.setVimPolicy("on"); editor.setText("aB\ncD"); editor.handleInput("\x1b");
    editor.handleInput("g"); editor.handleInput("g"); editor.handleInput("v"); editor.handleInput("l"); editor.handleInput("U");
    assert.equal(editor.getText(), "AB\ncD");
    editor.handleInput("u"); assert.equal(editor.getText(), "aB\ncD");
    editor.onExtensionShortcut = () => false;
    editor.handleInput("g"); editor.handleInput("g"); editor.handleInput("v"); editor.handleInput("r"); editor.handleInput("👩‍💻");
    assert.equal(editor.getText(), "👩‍💻B\ncD");
    editor.handleInput("u"); assert.equal(editor.getText(), "aB\ncD");
    editor.handleInput("G"); editor.handleInput("V"); editor.handleInput("k"); editor.handleInput("J");
    assert.equal(editor.getText(), "aB cD");
    editor.handleInput("u"); assert.equal(editor.getText(), "aB\ncD");
    editor.handleInput("G"); editor.handleInput("V"); editor.handleInput("k"); editor.handleInput("<");
    assert.equal(editor.getText(), "aB\ncD");
    editor.handleInput("G"); editor.handleInput("v"); editor.handleInput("l"); editor.handleInput("u");
    assert.equal(editor.getText(), "aB\ncd");
    editor.handleInput("u"); assert.equal(editor.getText(), "aB\ncD");
    editor.handleInput("G"); editor.handleInput("V"); editor.handleInput("x"); assert.equal(editor.getText(), "aB");
  } finally { editor.dispose(); }
});

test("GentlePromptEditor visual selection uses adapter inside the fixed-width frame", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	editor.setVimPolicy("on");
	editor.setText("abcd");
	editor.handleInput("\x1b");
	editor.handleInput("h");
	editor.handleInput("h");
	editor.handleInput("v");
	editor.handleInput("l");
	const lines = editor.render(30);
	assert.ok(lines.some((line) => /\x1b\[7mc/.test(line)), "selection must cover c, not merely the software cursor");
	assert.ok(lines.every((line) => [...stripAnsi(line)].length === 30), "frame retains requested width");
	editor.dispose();
});

test("GentlePromptEditor preserves autocomplete below the bottom border during visual selection", () => {
 const { pi, handlers } = fakePi();
 gentleShell(pi, {});
 const { ctx, ui } = fakeContext();
 const editor = installedPrompt(ctx, ui, handlers);
 editor.setVimPolicy("on");
 editor.setText("abcd");
 editor.handleInput("\x1b");
 editor.handleInput("h");
 editor.handleInput("h");
 editor.handleInput("v");
 editor.handleInput("l");
 const internal = editor as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] } };
 internal.autocompleteState = "force";
 internal.autocompleteList = { render: () => ["completion one", "completion two"] };
 try {
  const rows = editor.render(30).map(stripAnsi);
  assert.ok(rows.some((row) => row.includes("completion one")));
  assert.ok(rows.some((row) => row.includes("completion two")));
  assert.match(rows[rows.length - 3]!, /^╰.*╯$/);
  assert.ok(rows.every((row) => [...row].length === 30));
  assert.ok(editor.render(30).some((row) => /\x1b\[7mc/.test(row)));
 } finally { editor.dispose(); }
});

for (const kind of ["char", "line"] as const) {
	for (const autocomplete of [false, true]) {
		test(`VISUAL ${kind} c edits the selection with autocomplete ${autocomplete ? "visible" : "hidden"}`, () => {
			const { pi, handlers } = fakePi(); gentleShell(pi, {});
			const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
			try {
				editor.setVimPolicy("on"); editor.setText(kind === "char" ? "abcd" : "one\ntwo\nthree");
				editor.handleInput("\x1b");
				if (kind === "char") { editor.handleInput("h"); editor.handleInput("h"); editor.handleInput("v"); editor.handleInput("l"); }
				else { editor.handleInput("g"); editor.handleInput("g"); editor.handleInput("V"); editor.handleInput("j"); }
				const internal = editor as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] } };
				if (autocomplete) { internal.autocompleteState = "force"; internal.autocompleteList = { render: () => ["completion"] }; }
				editor.handleInput("c");
				assert.equal(editor.getText(), kind === "char" ? "ab" : "\nthree", "c must not be inserted or discard the unselected draft");
				assert.match(editor.render(30).join("\n"), /INSERT/);
				assert.equal(editor.isShowingAutocomplete(), false);
			} finally { editor.dispose(); }
		});
		test(`VISUAL ${kind} p replaces from register with autocomplete ${autocomplete ? "visible" : "hidden"}`, () => {
			const { pi, handlers } = fakePi(); gentleShell(pi, {});
			const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
			try {
				editor.setVimPolicy("on"); editor.setText(kind === "char" ? "abc def" : "one\ntwo\nthree");
				editor.handleInput("\x1b"); editor.handleInput("g"); editor.handleInput("g");
				if (kind === "char") {
					editor.handleInput("v"); editor.handleInput("l"); editor.handleInput("y");
					editor.handleInput("w"); editor.handleInput("v"); editor.handleInput("l");
				} else {
					editor.handleInput("V"); editor.handleInput("y");
					editor.handleInput("j"); editor.handleInput("V");
				}
				const internal = editor as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] } };
				if (autocomplete) { internal.autocompleteState = "force"; internal.autocompleteList = { render: () => ["completion"] }; }
				editor.handleInput("p");
				assert.equal(editor.getText(), kind === "char" ? "abc abf" : "one\none\nthree", "p must not insert its key or discard surrounding draft");
				assert.match(editor.render(30).join("\n"), /NORMAL/);
				assert.equal(editor.isShowingAutocomplete(), false);
			} finally { editor.dispose(); }
		});
	}
}

test("VISUAL owns h/l and counts despite visible autocomplete; no bytes enter the draft", () => {
	for (const kind of ["v", "V"] as const) {
		const { pi, handlers } = fakePi(); gentleShell(pi, {});
		const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
		try {
			editor.setVimPolicy("on"); editor.setText(kind === "v" ? "abcdef" : "one\ntwo\nthree\nfour");
			editor.handleInput("\x1b"); editor.handleInput("g"); editor.handleInput("g");
			editor.handleInput(kind);
			const internal = editor as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] } };
			internal.autocompleteState = "force";
			internal.autocompleteList = { render: () => ["completion"] };
			const draft = editor.getText();
			editor.handleInput("2"); editor.handleInput(kind === "v" ? "l" : "j");
			assert.equal(editor.getText(), draft);
			assert.deepEqual(editor.getCursor(), kind === "v" ? { line: 0, col: 2 } : { line: 2, col: 0 });
			assert.match(editor.render(30).join("\n"), /VISUAL/);
			assert.equal(editor.isShowingAutocomplete(), false);
			editor.handleInput(kind === "v" ? "h" : "k");
			assert.deepEqual(editor.getCursor(), kind === "v" ? { line: 0, col: 1 } : { line: 1, col: 0 });
			assert.equal(editor.getText(), draft);
		} finally { editor.dispose(); }
	}
});

test("VISUAL Escape dismisses visible autocomplete and selection without clearing the draft", () => {
	const { pi, handlers } = fakePi(); gentleShell(pi, {});
	const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on"); editor.setText("abcd"); editor.handleInput("\x1b"); editor.handleInput("h"); editor.handleInput("v");
		const internal = editor as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] } };
		internal.autocompleteState = "force";
		internal.autocompleteList = { render: () => ["completion"] };
		editor.handleInput("\x1b");
		assert.equal(editor.getText(), "abcd");
		assert.match(editor.render(30).join("\n"), /NORMAL/);
		assert.equal(editor.isShowingAutocomplete(), false);
	} finally { editor.dispose(); }
});

test("GentlePromptEditor keeps visual selection when autocomplete offers printable input", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("abcd");
		editor.handleInput("\x1b");
		editor.handleInput("h");
		editor.handleInput("h");
		editor.handleInput("v");
		editor.handleInput("l");
		const internal = editor as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] } };
		internal.autocompleteState = "force";
		internal.autocompleteList = { render: () => ["completion"] };
		assert.deepEqual(reverseColumns(editor.render(30)[1]!), [3, 4]);
		editor.handleInput("z");
		assert.equal(editor.getText(), "abcd");
		assert.match(editor.render(30).join("\n"), /VISUAL/);
		assert.equal(editor.isShowingAutocomplete(), false);
		assert.deepEqual(reverseColumns(editor.render(30)[1]!), [3, 4], "the selected range remains anchored");
	} finally { editor.dispose(); }
});

test("VISUAL autocomplete leaves app shortcut ownership ahead of c and p", () => {
	const { pi, handlers } = fakePi(); gentleShell(pi, {});
	const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on"); editor.setText("abcd"); editor.handleInput("\x1b");
		editor.handleInput("h"); editor.handleInput("v");
		const internal = editor as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] } };
		internal.autocompleteState = "force"; internal.autocompleteList = { render: () => ["completion"] };
		let called = 0;
		editor.onExtensionShortcut = (data) => {
			if (data !== "c") return false;
			called++;
			assert.match(editor.render(30).join("\n"), /INSERT/);
			return true;
		};
		editor.handleInput("c");
		assert.equal(called, 1);
		assert.equal(editor.getText(), "abcd");
		assert.match(editor.render(30).join("\n"), /INSERT/);
	} finally { editor.dispose(); }
});

test("GentlePromptEditor enters INSERT before an app shortcut writes from NORMAL", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("abcd");
		editor.handleInput("\x1b");
		editor.handleInput("h");
		editor.handleInput("h");
		editor.handleInput("v");
		editor.handleInput("l");
		editor.onExtensionShortcut = (data) => {
			if (data !== "ctrl+k") return false;
			assert.match(editor.render(30).join("\n"), /INSERT/, "the shortcut must not write in NORMAL");
			editor.insertTextAtCursor("X");
			return true;
		};
		editor.handleInput("ctrl+k");
		assert.equal(editor.getText(), "abcXd");
		assert.deepEqual(reverseColumns(editor.render(30)[1]!), [5], "the old visual range must be gone");
	} finally { editor.dispose(); }
});

test("throwing shortcut probes restore NORMAL or VISUAL and permit a subsequent insert session", () => {
	for (const visual of [false, true]) {
		const { pi, handlers } = fakePi(); gentleShell(pi, {});
		const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
		try {
			editor.setVimPolicy("on"); editor.setText("abcd"); editor.handleInput("\x1b");
			editor.handleInput("h"); editor.handleInput("h");
			if (visual) { editor.handleInput("v"); editor.handleInput("l"); }
			const failure = new Error("shortcut failed");
			editor.onExtensionShortcut = () => { throw failure; };
			assert.throws(() => editor.handleInput("ctrl+k"), (error) => error === failure);
			assert.equal(editor.getText(), "abcd");
			assert.match(editor.render(30).join("\n"), visual ? /VISUAL/ : /NORMAL/);
			if (visual) assert.deepEqual(reverseColumns(editor.render(30)[1]!), [3, 4]);
			editor.onExtensionShortcut = () => false;
			editor.handleInput("ctrl+k");
			assert.match(editor.render(30).join("\n"), visual ? /VISUAL/ : /NORMAL/);
			if (visual) assert.deepEqual(reverseColumns(editor.render(30)[1]!), [3, 4]);
			if (visual) editor.handleInput("\x1b");
			editor.handleInput("i"); editor.handleInput("X"); editor.handleInput("\x1b");
			assert.match(editor.getText(), /X/);
		} finally { editor.dispose(); }
	}
});

test("throwing shortcuts that change a draft retain INSERT ownership from NORMAL or VISUAL", () => {
	for (const visual of [false, true]) {
		const { pi, handlers } = fakePi(); gentleShell(pi, {});
		const { ctx, ui } = fakeContext(); const editor = installedPrompt(ctx, ui, handlers);
		try {
			editor.setVimPolicy("on"); editor.setText("abcd"); editor.handleInput("\x1b");
			editor.handleInput("h"); editor.handleInput("h");
			if (visual) { editor.handleInput("v"); editor.handleInput("l"); }
			const failure = new Error("shortcut failed after writing");
			editor.onExtensionShortcut = () => { editor.insertTextAtCursor("X"); throw failure; };
			assert.throws(() => editor.handleInput("ctrl+k"), (error) => error === failure);
			assert.equal(editor.getText(), visual ? "abcXd" : "abXcd");
			assert.match(editor.render(30).join("\n"), /INSERT/);
			assert.equal(reverseColumns(editor.render(30)[1]!).length, 1, "old visual range must be gone");
			editor.onExtensionShortcut = () => false;
			editor.handleInput("Y");
			assert.match(editor.getText(), /Y/);
		} finally { editor.dispose(); }
	}
});

test("unhandled shortcut and blocked printable input leave NORMAL selection unchanged", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("abcd");
		editor.handleInput("\x1b");
		editor.handleInput("h");
		editor.handleInput("h");
		editor.handleInput("v");
		editor.handleInput("l");
		editor.onExtensionShortcut = () => false;
		editor.handleInput("z");
		editor.handleInput("ctrl+k");
		assert.equal(editor.getText(), "abcd");
		assert.match(editor.render(30).join("\n"), /VISUAL/);
		assert.deepEqual(reverseColumns(editor.render(30)[1]!), [3, 4]);
	} finally { editor.dispose(); }
});

function reverseColumns(row: string): number[] {
	let inverse = false;
	let column = 0;
	const selected: number[] = [];
	const tokens = row.match(/\x1b\[[0-9;]*m|\x1b_pi:c\x07|[^\x1b]/g) ?? [];
	assert.equal(tokens.join(""), row);
	for (const token of tokens) {
		if (token === CURSOR_MARKER) continue;
		if (token.startsWith("\x1b[")) {
			for (const code of token.slice(2, -1).split(";").map(Number)) {
				if (code === 0 || code === 27) inverse = false;
				if (code === 7) inverse = true;
			}
		} else {
			if (inverse) selected.push(column);
			column++;
		}
	}
	return selected;
}

test("focused framed selection preserves hardware cursor position and software cursor cell", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("abcd");
		editor.focused = true;
		editor.handleInput("\x1b");
		editor.handleInput("h");
		editor.handleInput("h");
		editor.handleInput("v");
		editor.handleInput("l");
		const original = editor.render(30);
		const row = original[1]!;
		assert.ok(row.includes(CURSOR_MARKER));
		assert.equal(visibleWidth(row.split(CURSOR_MARKER)[0]!), 4,
			"frame border adds one column to the native cursor over d");
		assert.deepEqual(reverseColumns(row), [3, 4], "c is selected; d is Pi's software cursor");
		assert.ok(original.every((line) => visibleWidth(line) === 30));
	} finally { editor.dispose(); }
});

test("autocomplete below a focused visual selection retains both cursor and framed row geometry", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("abcd");
		editor.handleInput("\x1b");
		editor.handleInput("h");
		editor.handleInput("h");
		editor.handleInput("v");
		editor.handleInput("l");
		editor.focused = true;
		const internal = editor as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] } };
		internal.autocompleteState = "force";
		internal.autocompleteList = { render: () => ["completion one", "completion two"] };
		const rows = editor.render(30);
		assert.deepEqual(reverseColumns(rows[1]!), [3, 4]);
		assert.equal(visibleWidth(rows[1]!.split(CURSOR_MARKER)[0]!), 4);
		assert.match(stripAnsi(rows[2]!), /^╰.*╯$/);
		assert.deepEqual(rows.slice(3).map((row) => stripAnsi(row).slice(1, 15)), ["completion one", "completion two"]);
		assert.ok(rows.every((row) => visibleWidth(row) === 30));
	} finally { editor.dispose(); }
});

test("focused framed empty logical line keeps hardware cursor at column zero inside the border", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("a\n\nb");
		editor.focused = true;
		const adapter = createVimEditorAdapter(editor, "0.87.1");
		adapter.move({ line: 0, col: 0 });
		editor.handleInput("\x1b");
		editor.handleInput("v");
		adapter.move({ line: 1, col: 0 });
		const rows = editor.render(30);
		assert.deepEqual(reverseColumns(rows[1]!), [1]);
		assert.equal(visibleWidth(rows[2]!.split(CURSOR_MARKER)[0]!), 1);
		assert.deepEqual(reverseColumns(rows[2]!), [1], "only native empty-line cursor is inverted");
		assert.ok(rows.every((row) => visibleWidth(row) === 30));
	} finally { editor.dispose(); }
});

test("framed scrolled paste marker paints exactly its split visible cells", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("a".repeat(100));
		editor.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
		const pasteEnd = editor.getText().length;
		editor.insertTextAtCursor("TAIL");
		const adapter = createVimEditorAdapter(editor, "0.87.1");
		adapter.move({ line: 0, col: 100 });
		editor.handleInput("\x1b");
		editor.handleInput("v");
		adapter.move({ line: 0, col: pasteEnd });
		editor.focused = true;
		const rows = editor.render(10);
		const internal = editor as unknown as { scrollOffset: number; layoutText(width: number): Array<{ text: string; hasCursor: boolean; cursorPos?: number }> };
		const layout = internal.layoutText(7);
		let offset = layout.slice(0, internal.scrollOffset).reduce((n, chunk) => n + chunk.text.length, 0);
		assert.ok(internal.scrollOffset > 0);
		const selected = rows.slice(1, -1).map((row, index) => {
			const chunk = layout[internal.scrollOffset + index]!;
			const expected = [...chunk.text].flatMap((_, col) => offset + col >= 100 && offset + col < pasteEnd ? [col + 1] : []);
			if (chunk.hasCursor && chunk.cursorPos !== undefined) expected.push(chunk.cursorPos + 1);
			offset += chunk.text.length;
			assert.deepEqual(reverseColumns(row), expected);
			assert.equal(visibleWidth(row), 10);
			return row;
		});
		assert.ok(selected.some((row) => row.includes("[")));
		assert.ok(selected.some((row) => row.includes("]")));
		assert.ok(rows.every((row) => visibleWidth(row) === 10));
		assert.equal(editor.getExpandedText(), "a".repeat(100) + "z".repeat(1001) + "TAIL");
	} finally { editor.dispose(); }
});

test("owned frame fails closed when the installed TUI version does not match the adapter", () => {
	const notices: string[] = [];
	const editor = new GentlePromptEditor(fakeTui as never, editorTheme as never, fakeKeybindings as never, {
		fg: (_color, text) => text, bold: (text) => text, requestRender() {},
		pending: () => false, now: () => 0, doubleEscCancelEnabled: () => false,
		dispatchQueuedText() {}, tuiVersion: () => "0.85.1", notifyCompatibility: (message: string) => notices.push(message),
	});
	try {
		editor.setVimPolicy("on");
		editor.setText("abcd");
		editor.focused = true;
		editor.handleInput("\x1b");
		editor.handleInput("h");
		editor.handleInput("h");
		editor.handleInput("v");
		editor.handleInput("l");
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /vim.*unsupported.*ordinary editing/i);
		editor.handleInput("z");
		assert.equal(notices.length, 1);
		const frame = editor.render(30);
		assert.deepEqual(reverseColumns(frame[1]!), [10], "only Pi's own software cursor remains inverse");
		assert.equal(visibleWidth(frame[1]!.split(CURSOR_MARKER)[0]!), 10);
		assert.ok(frame.every((row) => visibleWidth(row) === 30));
		assert.equal(editor.getText(), "abcdhhvlz", "unsupported Vim never enters inert NORMAL: ordinary input still works");
	} finally { editor.dispose(); }
});

test("duplicate registered paste marker disables Vim visibly and keeps ordinary editing", () => {
	const notices: string[] = [];
	const editor = new GentlePromptEditor(fakeTui as never, editorTheme as never, fakeKeybindings as never, {
		fg: (_color, text) => text, bold: (text) => text, requestRender() {},
		pending: () => false, now: () => 0, doubleEscCancelEnabled: () => false,
		dispatchQueuedText() {}, notifyCompatibility: (message: string) => notices.push(message),
	});
	try {
		editor.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
		const markerText = editor.getText();
		editor.insertTextAtCursor(` ${markerText}`);
		const before = editor.getExpandedText();
		editor.setVimPolicy("on");
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /unsupported.*ordinary editing/i);
		editor.handleInput("x");
		assert.equal(editor.getExpandedText(), before + "x");
	} finally { editor.dispose(); }
});

test("a duplicate marker introduced after Vim enable exits NORMAL with a visible warning", () => {
	const notices: string[] = [];
	const editor = new GentlePromptEditor(fakeTui as never, editorTheme as never, fakeKeybindings as never, {
		fg: (_color, text) => text, bold: (text) => text, requestRender() {},
		pending: () => false, now: () => 0, doubleEscCancelEnabled: () => false,
		dispatchQueuedText() {}, notifyCompatibility: (message: string) => notices.push(message),
	});
	try {
		editor.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
		editor.setVimPolicy("on");
		const markerText = editor.getText();
		editor.insertTextAtCursor(` ${markerText}`);
		editor.handleInput("\x1b");
		assert.equal(notices.length, 1);
		const before = editor.getExpandedText();
		editor.handleInput("x");
		assert.equal(editor.getExpandedText(), before + "x");
	} finally { editor.dispose(); }
});

test("GentlePromptEditor autocomplete respects narrow frame widths", () => {
 const { pi, handlers } = fakePi();
 gentleShell(pi, {});
 const { ctx, ui } = fakeContext();
 const editor = installedPrompt(ctx, ui, handlers);
 const internal = editor as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] } };
 internal.autocompleteState = "force";
 internal.autocompleteList = { render: () => ["completion"] };
 try {
  for (const width of [0, 1, 2, 30]) {
   const rows = editor.render(width).map(stripAnsi);
   assert.ok(rows.every((row) => [...row].length <= width), `width ${width}: ${JSON.stringify(rows)}`);
   if (width === 30) assert.ok(rows.some((row) => row.includes("completion")));
  }
 } finally { editor.dispose(); }
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

test("visual customization and Vim register once and remain independently discoverable", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const { pi, commands } = fakePi();
	const registrations: string[] = [];
	const register = pi.registerCommand.bind(pi);
	pi.registerCommand = ((name, registration) => {
		registrations.push(name);
		register(name, registration);
	}) as typeof pi.registerCommand;
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	for (const name of ["gentle:customize", "gentle:vim"]) {
		assert.equal(registrations.filter((registered) => registered === name).length, 1, `${name} must register once`);
		assert.ok(commands.has(name));
	}
	const groups = buildCommandPaletteGroups([...commands].map(([name, value]) => ({ name, description: value.description })), {});
	const configuration = groups.find((group) => group.title === "Configuration")!;
	assert.deepEqual(configuration.items.filter((item) => ["gentle:customize", "gentle:vim"].includes(item.command)).map((item) => item.command), ["gentle:customize", "gentle:vim"]);
	const { ctx, ui, overlayReady } = fakeContext();
	await commands.get("gentle:vim")!.handler("enable", ctx);
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	assert.ok(ui.overlayView!.render(90).some((row) => row.includes("Animations: quality")));
	ui.overlayView!.handleInput("\x1b");
	await pending;
	assert.equal(JSON.parse(readFileSync(join(home, "vim.json"), "utf8")).policy, "on");
});

test("vim command enables a live prompt and INSERT Escape enters NORMAL without clearing", async (t) => {
 const configHome = mkdtempSync(join(tmpdir(), "gentle-vim-shell-"));
 const { pi, handlers, commands } = fakePi();
 gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
 const { ctx, ui } = fakeContext();
 const editor = installedPrompt(ctx, ui, handlers);
 editor.setText("hello");
 await commands.get("gentle:vim")!.handler("enable", ctx);
 editor.handleInput("\x1b");
 assert.equal(editor.getText(), "hello");
 assert.match(editor.render(60).join("\n"), /NORMAL/);
 editor.handleInput("i");
 assert.match(editor.render(60).join("\n"), /INSERT/);
 editor.dispose();
});

test("vim command distinguishes persisted preference from rejected live editor and recovers on next start", async () => {
 const configHome = mkdtempSync(join(tmpdir(), "gentle-vim-rejected-"));
 const { pi, handlers, commands } = fakePi();
 gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome }, { vimRuntimeVersion: () => "unsupported" });
 const { ctx, ui } = fakeContext();
 const editor = installedPrompt(ctx, ui, handlers);
 try {
  editor.setText("draft");
  await commands.get("gentle:vim")!.handler("enable", ctx);
  assert.equal(JSON.parse(readFileSync(join(configHome, "vim.json"), "utf8")).policy, "on");
  assert.match(ui.notices.at(-1)!, /vim: on.*ordinary editing remains active/i);
  assert.doesNotMatch(ui.notices.at(-1)!, /applies now/i);
  editor.handleInput("h");
  assert.equal(editor.getText(), "drafth");
  // Split bracketed paste must not leak its framing bytes or run modal commands.
  for (const part of ["\x1b[200~", "z", "\x1b[20", "1~"]) editor.handleInput(part);
  assert.equal(editor.getExpandedText(), "drafthz");
  await commands.get("gentle:vim")!.handler("status", ctx);
  assert.match(ui.notices.at(-1)!, /vim: on.*ordinary editing remains active/i);
  editor.dispose();
  const next = installedPrompt(ctx, ui, handlers);
  try {
   assert.doesNotMatch(next.render(40).join("\n"), /NORMAL|INSERT/);
   next.handleInput("h");
   assert.equal(next.getText(), "h");
   await commands.get("gentle:vim")!.handler("disable", ctx);
   assert.match(ui.notices.at(-1)!, /vim: off.*ordinary editing/i);
  } finally { next.dispose(); }
 } finally { editor.dispose(); }
});

test("compatible vim command reports live activation and disable returns ordinary editing", async () => {
 const { pi, handlers, commands } = fakePi();
 gentleShell(pi, { GENTLE_PI_CONFIG_HOME: mkdtempSync(join(tmpdir(), "gentle-vim-compatible-")) }, { vimRuntimeVersion: () => "0.87.1" });
 const { ctx, ui } = fakeContext();
 const editor = installedPrompt(ctx, ui, handlers);
 try {
  await commands.get("gentle:vim")!.handler("enable", ctx);
  assert.match(ui.notices.at(-1)!, /Prompt applies now/);
  editor.handleInput("\x1b");
  assert.match(editor.render(40).join("\n"), /NORMAL/);
  await commands.get("gentle:vim")!.handler("disable", ctx);
  assert.doesNotMatch(editor.render(40).join("\n"), /NORMAL|INSERT/);
  editor.handleInput("h");
  assert.equal(editor.getText(), "h");
 } finally { editor.dispose(); }
});

test("vim NORMAL slash uses Pi's command and skill completion without displacing a draft", async () => {
	const theme = { ...editorTheme, selectList: {
		selectedText: (text: string) => text, description: (text: string) => text,
		noMatch: (text: string) => text, scrollInfo: (text: string) => text,
	} };
	const editor = new GentlePromptEditor(fakeTui as never, theme as never, {
		matches: (data: string, action: string) => action === "app.interrupt" && data === "\x1b",
	} as never, {
		fg: (_color, text) => text, bold: (text) => text, requestRender() {}, pending: () => false,
		now: () => 0, doubleEscCancelEnabled: () => false, dispatchQueuedText() {}, tuiVersion: () => "0.87.1",
	});
	const entries = ["gentle:vim", "gentle:models", "skill:example"];
	const requests: string[] = [];
	editor.setAutocompleteProvider({
		async getSuggestions(lines: string[], line: number, col: number) {
			const prefix = lines[line]!.slice(0, col);
			requests.push(prefix);
			const items = entries.filter((name) => name.startsWith(prefix.slice(1))).map((name) => ({ value: `/${name}`, label: name }));
			return { prefix, items };
		},
		applyCompletion(lines: string[], line: number, col: number, selected: { value: string }) {
			return { lines: [selected.value + lines[line]!.slice(col)], cursorLine: line, cursorCol: selected.value.length };
		},
	} as never);
	try {
		editor.setVimPolicy("on");
		editor.handleInput("\x1b");
		editor.handleInput("/");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(editor.getText(), "/");
		assert.ok(editor.isShowingAutocomplete(), "Pi opens the native slash menu");
		assert.deepEqual(requests, ["/"]);
		assert.match(editor.render(40).join("\n"), /INSERT/);
		for (const char of "skill:") editor.handleInput(char);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(requests.at(-1), "/skill:");
		assert.ok(editor.isShowingAutocomplete(), "Pi filters skill entries");
		editor.handleInput("\x1b");
		assert.equal(editor.getText(), "/skill:");
		assert.equal(editor.isShowingAutocomplete(), false);
		assert.match(editor.render(40).join("\n"), /INSERT/);
		editor.handleInput("\x1b");
		assert.match(editor.render(40).join("\n"), /NORMAL/);
		editor.setText("");
		editor.handleInput("/");
		for (const char of "gentle:") editor.handleInput(char);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(requests.at(-1), "/gentle:");
		assert.ok(editor.isShowingAutocomplete(), "Pi filters command entries");
		editor.handleInput("\x1b");
		editor.handleInput("\x1b");
		editor.setText("saved draft");
		const before = requests.length;
		editor.handleInput("/");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(editor.getText(), "saved draft/", "Pi inserts slash at the cursor, without moving the draft");
		assert.equal(requests.length, before, "Pi does not open the slash menu after draft text");
		assert.equal(editor.isShowingAutocomplete(), false);
		assert.match(editor.render(40).join("\n"), /INSERT/);
		editor.handleInput("\x1b");
		assert.match(editor.render(40).join("\n"), /NORMAL/);
		editor.setVimPolicy("off");
		editor.handleInput("z");
		assert.equal(editor.getText(), "saved draft/z");
	} finally { editor.dispose(); }
});

test("vim NORMAL gives extension and app shortcuts precedence over modal letters without writing in NORMAL", () => {
	const editor = new GentlePromptEditor(fakeTui as never, editorTheme as never, {
		matches: (data: string, action: string) => data === "h" && action === "app.model.select",
	} as never, {
		fg: (_color, text) => text, bold: (text) => text, requestRender() {}, pending: () => false,
		now: () => 0, doubleEscCancelEnabled: () => false, dispatchQueuedText() {},
	});
	try {
		editor.setVimPolicy("on");
		editor.setText("abcd");
		editor.handleInput("\x1b");
		const before = editor.getCursor();
		let calls = 0;
		editor.onAction("app.model.select", () => {
			calls++;
			assert.match(editor.render(30).join("\n"), /INSERT/);
		});
		editor.handleInput("h");
		assert.equal(calls, 1);
		assert.deepEqual(editor.getCursor(), before);
		assert.equal(editor.getText(), "abcd");
		editor.handleInput("\x1b");
		editor.onExtensionShortcut = (data) => {
			if (data !== "i") return false;
			calls++;
			assert.match(editor.render(30).join("\n"), /INSERT/);
			return true;
		};
		editor.handleInput("i");
		assert.equal(calls, 2);
		assert.equal(editor.getText(), "abcd");
	} finally { editor.dispose(); }
});

test("vim NORMAL blocks Kitty and emoji text, handles encoded motions and ignores releases", async () => {
 const { pi, handlers, commands } = fakePi();
 gentleShell(pi, { GENTLE_PI_CONFIG_HOME: mkdtempSync(join(tmpdir(), "gentle-vim-keys-")) });
 const { ctx, ui } = fakeContext();
 const editor = installedPrompt(ctx, ui, handlers, { matches: (data: string, binding: string) => binding === "app.interrupt" && data === "\x1b" });
 await commands.get("gentle:vim")!.handler("enable", ctx);
 editor.setText("ab\n雪🙂");
 editor.handleInput("\x1b");
 editor.handleInput("\x1b[120u");
 editor.handleInput("\x1b[27;1;120~");
 editor.handleInput("\x1b[200~pasted\x1b[201~");
 editor.handleInput("🙂");
 editor.handleInput("\x1b[105;1:3u");
 assert.equal(editor.getText(), "ab\n雪🙂");
 assert.match(editor.render(60).join("\n"), /NORMAL/);
 editor.handleInput("\x1b[104u");
 editor.handleInput("\x1b[105u");
 assert.match(editor.render(60).join("\n"), /INSERT/);
 editor.dispose();
});

test("vim bracketed paste frames split across editor events never run NORMAL commands", () => {
	const editor = new GentlePromptEditor(fakeTui as never, editorTheme as never, fakeKeybindings as never, {
		fg: (_color, text) => text, bold: (text) => text, requestRender() {}, pending: () => false,
		now: () => 0, doubleEscCancelEnabled: () => false, dispatchQueuedText() {}, tuiVersion: () => "0.87.1",
	});
	try {
		editor.setVimPolicy("on");
		editor.setText("saved draft");
		editor.handleInput("\x1b");
		for (const chunk of ["\x1b[200~", "a", "z", "\x1b[20", "1~"]) {
			editor.handleInput(chunk);
			assert.equal(editor.getText(), "saved draft", `partial paste ${JSON.stringify(chunk)}`);
			assert.match(editor.render(40).join("\n"), /NORMAL/);
		}
		editor.handleInput("i");
		assert.match(editor.render(40).join("\n"), /INSERT/);
		for (const chunk of ["\x1b[200~", "hello", "\x1b[20", "1~"]) editor.handleInput(chunk);
		assert.equal(editor.getText(), "saved drafthello");
		assert.match(editor.render(40).join("\n"), /INSERT/);
	} finally { editor.dispose(); }
});

test("vim paste overflow and policy cancellation discard partial frames without leaking modal commands", () => {
	const editor = new GentlePromptEditor(fakeTui as never, editorTheme as never, fakeKeybindings as never, {
		fg: (_color, text) => text, bold: (text) => text, requestRender() {}, pending: () => false,
		now: () => 0, doubleEscCancelEnabled: () => false, dispatchQueuedText() {}, tuiVersion: () => "0.87.1",
	});
	try {
		editor.setVimPolicy("on");
		editor.handleInput("\x1b[200~");
		editor.handleInput("z".repeat(1024 * 1024 + 1));
		editor.handleInput("\x1b[20");
		editor.handleInput("1~");
		assert.equal(editor.getText(), "", "oversized paste is discarded in INSERT");
		editor.handleInput("\x1b[200~");
		editor.handleInput("a");
		editor.setVimPolicy("off");
		editor.setVimPolicy("on");
		editor.handleInput("\x1b");
		editor.handleInput("z");
		assert.equal(editor.getText(), "", "canceled paste and NORMAL input remain isolated");
		assert.match(editor.render(40).join("\n"), /NORMAL/);
	} finally { editor.dispose(); }
});

test("vim NORMAL rejects encoded insertions and paste without losing Unicode multiline draft", async () => {
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: mkdtempSync(join(tmpdir(), "gentle-vim-safety-")) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	await commands.get("gentle:vim")!.handler("enable", ctx);
	editor.setText("雪🙂\nhello");
	editor.handleInput("\x1b");
	for (const input of ["\x1b[13u", "\x1b[9u", "\x1b[200~", "pasted", "\x1b[201~", "\x1b[27;5;120~", "\x1b[27;1;120~", "\x1b[105;2u", "\x1b[105;1:2u"]) {
		editor.handleInput(input);
		assert.equal(editor.getText(), "雪🙂\nhello", `NORMAL input ${JSON.stringify(input)}`);
	}
	editor.dispose();
});

test("vim NORMAL hands autocomplete and bash-mode input to Pi only after entering INSERT", () => {
	const editor = new GentlePromptEditor(fakeTui as never, editorTheme as never, fakeKeybindings as never, {
		fg: (_color, text) => text, bold: (text) => text, requestRender() {}, pending: () => false,
		now: () => 0, doubleEscCancelEnabled: () => false, dispatchQueuedText() {},
	});
	try {
		editor.setVimPolicy("on");
		editor.setText("abcd");
		editor.handleInput("\x1b");
		const internal = editor as unknown as { autocompleteState: string; autocompleteList: { render(width: number): string[] } };
		internal.autocompleteState = "force";
		internal.autocompleteList = { render: () => ["completion"] };
		editor.handleInput("z");
		assert.match(editor.render(30).join("\n"), /INSERT/);
		assert.equal(editor.getText(), "abcdz");
		internal.autocompleteState = "none";
		editor.setText("!echo");
		editor.handleInput("\x1b");
		assert.match(editor.render(30).join("\n"), /NORMAL/);
		editor.handleInput("z");
		assert.match(editor.render(30).join("\n"), /INSERT/);
		assert.equal(editor.getText(), "!echoz");
	} finally { editor.dispose(); }
});

test("vim bash draft reaches Pi's Escape handler on second Esc", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, {
		matches: (data: string, binding: string) => binding === "app.interrupt" && data === "\x1b",
	});
	try {
		editor.setVimPolicy("on");
		editor.setText("!echo");
		let escapes = 0;
		editor.onEscape = () => { escapes++; };
		editor.handleInput("\x1b");
		assert.equal(escapes, 0, "INSERT Esc only enters NORMAL");
		assert.equal(editor.getText(), "!echo");
		assert.match(editor.render(40).join("\n"), /NORMAL/);
		editor.handleInput("\x1b");
		assert.equal(escapes, 1, "NORMAL Esc reaches Pi's bash-mode Escape handler");
		assert.equal(editor.getText(), "!echo");
	} finally { editor.dispose(); }
});

test("vim NORMAL motions and insert/open commands use Unicode and multiline cursor positions", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("a👩‍💻z\n  snow");
		editor.handleInput("\x1b");
		createVimEditorAdapter(editor, "0.87.1").move({ line: 0, col: 0 });
		for (const key of ["l", "l", "j", "k", "g", "g", "G", "0", "^", "$"]) editor.handleInput(key);
		assert.deepEqual(editor.getCursor(), { line: 1, col: 6 });
		editor.handleInput("O");
		assert.equal(editor.getText(), "a👩‍💻z\n\n  snow");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
		assert.match(editor.render(40).join("\n"), /INSERT/);
	} finally { editor.dispose(); }
});

test("unhandled extension shortcut probes preserve pending NORMAL gg and 2j", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("a\nb\nc");
		editor.onExtensionShortcut = () => false;
		editor.handleInput("\x1b");
		editor.handleInput("g");
		editor.handleInput("g");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
		editor.handleInput("2");
		editor.handleInput("j");
		assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });
		assert.match(editor.render(30).join("\n"), /NORMAL/);
	} finally { editor.dispose(); }
});

test("NORMAL first non-whitespace motion and insert land after a combining grapheme", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText(" \u0301a");
		editor.handleInput("\x1b");
		createVimEditorAdapter(editor, "0.87.1").move({ line: 0, col: 0 });
		editor.handleInput("^");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
		createVimEditorAdapter(editor, "0.87.1").move({ line: 0, col: 0 });
		editor.handleInput("I");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
		assert.match(editor.render(30).join("\n"), /INSERT/);
	} finally { editor.dispose(); }
});

test("NORMAL h crosses a collapsed paste marker without entering its interior", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("a");
		editor.handleInput(`\x1b[200~${"z".repeat(1001)}\x1b[201~`);
		const before = editor.getText();
		const expanded = editor.getExpandedText();
		editor.handleInput("\x1b");
		editor.handleInput("h");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
		assert.equal(editor.getText(), before);
		assert.equal(editor.getExpandedText(), expanded);
		editor.handleInput("l");
		assert.deepEqual(editor.getCursor(), { line: 0, col: before.length });
	} finally { editor.dispose(); }
});

test("vim NORMAL counted find and repeats remain Unicode/paste-safe and do not change the draft", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("a👩‍💻x👩‍💻x\nnext");
		editor.handleInput("\x1b");
		createVimEditorAdapter(editor, "0.87.1").move({ line: 0, col: 0 });
		for (const key of ["2", "f", "👩‍💻"]) editor.handleInput(key);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 7 });
		editor.handleInput(",");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
		editor.handleInput(";");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 7 });
		editor.handleInput("f");
		editor.handleInput("z");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 7 }, "no match never moves onto another line");
		assert.equal(editor.getText(), "a👩‍💻x👩‍💻x\nnext");
		assert.match(editor.render(40).join("\n"), /NORMAL/);
	} finally { editor.dispose(); }
});

test("vim operator session edits, cancels, and restores the draft with Pi undo", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("👩‍💻 hello\nnext");
		editor.handleInput("\x1b");
		createVimEditorAdapter(editor, "0.87.1").move({ line: 0, col: 0 });
		for (const key of ["d", "w"]) editor.handleInput(key);
		assert.equal(editor.getText(), "hello\nnext");
		editor.handleInput("u");
		assert.equal(editor.getText(), "👩‍💻 hello\nnext");
		editor.handleInput("d");
		editor.handleInput("\x1b");
		editor.handleInput("l");
		assert.equal(editor.getText(), "👩‍💻 hello\nnext");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
	} finally { editor.dispose(); }
});

test("vim join and shift are single undo units and Escape cancels pending shift", () => {
	const editor = new GentlePromptEditor(fakeTui as never, editorTheme as never, fakeKeybindings as never, {
		fg: (_color, text) => text, bold: (text) => text, requestRender() {}, pending: () => false,
		now: () => 0, doubleEscCancelEnabled: () => false, dispatchQueuedText() {},
	});
	try {
		editor.setVimPolicy("on");
		editor.setText("👩‍💻 one\n  two\nthird");
		editor.handleInput("\x1b");
		createVimEditorAdapter(editor, "0.87.1").move({ line: 0, col: 0 });
		editor.handleInput(">");
		editor.handleInput("\x1b");
		editor.handleInput("J");
		assert.equal(editor.getText(), "👩‍💻 one two\nthird");
		editor.handleInput("u");
		assert.equal(editor.getText(), "👩‍💻 one\n  two\nthird");
		for (const key of ["2", ">", ">"]) editor.handleInput(key);
		assert.equal(editor.getText(), "  👩‍💻 one\n    two\nthird");
		editor.handleInput("u");
		assert.equal(editor.getText(), "👩‍💻 one\n  two\nthird");
	} finally { editor.dispose(); }
});

test("vim operator survives an unhandled extension shortcut probe", () => {
	const editor = new GentlePromptEditor(fakeTui as never, editorTheme as never, fakeKeybindings as never, {
		fg: (_color, text) => text, bold: (text) => text, requestRender() {}, pending: () => false,
		now: () => 0, doubleEscCancelEnabled: () => false, dispatchQueuedText() {},
	});
	try {
		editor.setVimPolicy("on");
		editor.setText("abc def");
		editor.onExtensionShortcut = () => false;
		editor.handleInput("\x1b");
		createVimEditorAdapter(editor, "0.87.1").move({ line: 0, col: 0 });
		editor.handleInput("d");
		editor.handleInput("w");
		assert.equal(editor.getText(), "def");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
	} finally { editor.dispose(); }
});

test("vim final-line yy/P, cc and empty S keep line boundaries and INSERT state", () => {
	const editor = new GentlePromptEditor(fakeTui as never, editorTheme as never, fakeKeybindings as never, {
		fg: (_color, text) => text, bold: (text) => text, requestRender() {}, pending: () => false,
		now: () => 0, doubleEscCancelEnabled: () => false, dispatchQueuedText() {},
	});
	try {
		editor.setVimPolicy("on");
		editor.setText("one\ntwo");
		editor.handleInput("\x1b");
		createVimEditorAdapter(editor, "0.87.1").move({ line: 1, col: 0 });
		for (const key of ["y", "y", "P"]) editor.handleInput(key);
		assert.equal(editor.getText(), "one\ntwo\ntwo");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
		editor.handleInput("u");
		assert.equal(editor.getText(), "one\ntwo");
		createVimEditorAdapter(editor, "0.87.1").move({ line: 1, col: 0 });
		for (const key of ["c", "c"]) editor.handleInput(key);
		assert.equal(editor.getText(), "one\n");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
		assert.match(editor.render(40).join("\n"), /INSERT/);
		editor.setText("one");
		editor.handleInput("\x1b");
		createVimEditorAdapter(editor, "0.87.1").move({ line: 0, col: 0 });
		for (const key of ["c", "c"]) editor.handleInput(key);
		assert.equal(editor.getText(), "");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
		assert.match(editor.render(40).join("\n"), /INSERT/);
		editor.handleInput("\x1b");
		editor.handleInput("S");
		assert.equal(editor.getText(), "");
		assert.match(editor.render(40).join("\n"), /INSERT/);
	} finally { editor.dispose(); }
});

test("vim NORMAL Escape cancels pending find without inserting the next character", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		editor.setVimPolicy("on");
		editor.setText("ax");
		editor.handleInput("\x1b");
		createVimEditorAdapter(editor, "0.87.1").move({ line: 0, col: 0 });
		editor.handleInput("f");
		editor.handleInput("\x1b");
		editor.handleInput("l");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "Escape consumes the pending find, not the next motion");
		assert.equal(editor.getText(), "ax");
	} finally { editor.dispose(); }
});

test("vim NORMAL k at the first visual line does not recall history", () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, {});
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, {
		matches: (data: string, binding: string) => binding === "app.interrupt" && data === "\x1b" ||
			binding === "tui.editor.historyPrevious" && data === "\x1b[A",
	});
	try {
		editor.setVimPolicy("on");
		editor.addToHistory("previous prompt");
		editor.setText("draft\nsecond line");
		editor.handleInput("\x1b");
		createVimEditorAdapter(editor, "0.87.1").move({ line: 1, col: 0 });
		editor.handleInput("k");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
		const before = editor.getText();
		editor.handleInput("k");
		assert.equal(editor.getText(), before, "top-edge k must not replace the draft with history");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
		assert.match(editor.render(40).join("\n"), /NORMAL/);
		createVimEditorAdapter(editor, "0.87.1").move({ line: 1, col: 0 });
		editor.handleInput("j");
		assert.equal(editor.getText(), before, "bottom-edge j must not browse history");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
		createVimEditorAdapter(editor, "0.87.1").move({ line: 0, col: 0 });
		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "previous prompt", "explicit Pi history binding still works");
		assert.match(editor.render(40).join("\n"), /INSERT/);
	} finally { editor.dispose(); }
});

test("vim status preserves NORMAL and frame remains width-safe in every state", async () => {
 const { pi, handlers, commands } = fakePi();
 gentleShell(pi, { GENTLE_PI_CONFIG_HOME: mkdtempSync(join(tmpdir(), "gentle-vim-frame-")) });
 const { ctx, ui } = fakeContext();
 const editor = installedPrompt(ctx, ui, handlers);
 await commands.get("gentle:vim")!.handler("enable", ctx);
 editor.handleInput("\x1b");
 await commands.get("gentle:vim")!.handler("status", ctx);
 for (const state of ["idle", "working", "queued"]) {
  editor.setWorking(state !== "idle");
  if (state === "queued") ctx.hasPendingMessages = () => true;
  for (const width of [12, 18, 60]) {
   const rendered = editor.render(width).map(stripAnsi);
   for (const line of rendered) assert.ok([...line].length <= width, `${state} width ${width}: ${line}`);
   if (width === 60) assert.match(editor.render(width).join("\n"), /NORMAL/);
  }
 }
 editor.dispose();
});

test("vim NORMAL Escape retains working cancellation and idle draft clearing", async () => {
 const { pi, handlers, commands } = fakePi();
 gentleShell(pi, { GENTLE_PI_CONFIG_HOME: mkdtempSync(join(tmpdir(), "gentle-vim-esc-")) });
 const { ctx, ui } = fakeContext();
 const editor = installedPrompt(ctx, ui, handlers, { matches: (data: string, binding: string) => binding === "app.interrupt" && data === "\x1b" });
 await commands.get("gentle:vim")!.handler("enable", ctx);
 let aborted = 0;
 editor.onEscape = () => { aborted++; };
 editor.setWorking(true);
 editor.handleInput("\x1b");
 assert.equal(aborted, 0);
 editor.handleInput("\x1b");
 assert.equal(aborted, 1);
 editor.setWorking(false);
 editor.setText("draft");
 editor.handleInput("\x1b");
 assert.equal(editor.getText(), "draft");
 editor.handleInput("\x1b");
 assert.equal(editor.getText(), "");
 editor.dispose();
});

test("vim live disable restores ordinary input, re-enable starts INSERT, and invalid persisted preference fails closed", async () => {
	const home = mkdtempSync(join(tmpdir(), "gentle-vim-toggle-"));
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		await commands.get("gentle:vim")!.handler("enable", ctx);
		editor.setText("draft");
		editor.handleInput("\x1b");
		editor.handleInput("z");
		assert.equal(editor.getText(), "draft");
		await commands.get("gentle:vim")!.handler("disable", ctx);
		editor.handleInput("z");
		assert.equal(editor.getText(), "draftz");
		await commands.get("gentle:vim")!.handler("enable", ctx);
		assert.match(editor.render(40).join("\n"), /INSERT/);
		writeFileSync(join(home, "vim.json"), '{"schema":"gentle-pi.vim/v1","policy":"invalid"}');
		await commands.get("gentle:vim")!.handler("status", ctx);
		assert.match(ui.notices.at(-1)!, /vim: off.*falling back to off/);
		assert.doesNotMatch(editor.render(40).join("\n"), /INSERT|NORMAL/);
	} finally { editor.dispose(); }
});

test("vim selector exposes enable, disable and status; status and cancellation do not write", async (t) => {
 const home = mkdtempSync(join(tmpdir(), "gentle-vim-menu-"));
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const { pi, handlers, commands } = fakePi();
 gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
 let selected: string | undefined = "enable";
 const choices: string[][] = [];
 const { ctx, ui } = fakeContext({ select: async (_title, options) => { choices.push(options); return selected; } });
 const editor = installedPrompt(ctx, ui, handlers);
 try {
  const command = commands.get("gentle:vim")!;
  await command.handler("", { ...ctx, hasUI: false });
  assert.match(ui.notices.at(-1)!, /vim: off/);
  assert.equal(existsSync(join(home, "vim.json")), false);
  await command.handler("", ctx);
  assert.deepEqual(choices.at(-1), ["enable", "disable", "status"]);
  assert.equal(JSON.parse(readFileSync(join(home, "vim.json"), "utf8")).policy, "on");
  editor.handleInput("\x1b");
  const saved = readFileSync(join(home, "vim.json"), "utf8");
  selected = "status";
  await command.handler("", ctx);
  assert.equal(readFileSync(join(home, "vim.json"), "utf8"), saved);
  assert.match(editor.render(60).join("\n"), /NORMAL/);
  selected = undefined;
  await command.handler("", ctx);
  assert.equal(readFileSync(join(home, "vim.json"), "utf8"), saved);
  selected = "disable";
  await command.handler("", ctx);
  assert.equal(JSON.parse(readFileSync(join(home, "vim.json"), "utf8")).policy, "off");
  assert.doesNotMatch(editor.render(60).join("\n"), /INSERT|NORMAL/);
 } finally { editor.dispose(); }
});

test("animations command reports without writing and switches the live pulse", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const delays: number[] = [];
	let active = 0;
	t.mock.method(globalThis, "setInterval", (_callback: () => void, delay: number) => {
		delays.push(delay); active++; return { unref() {} };
	});
	t.mock.method(globalThis, "clearInterval", () => { active--; });
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	const command = commands.get("gentle:animations");
	assert.ok(command);
	await command.handler("", ctx);
	assert.match(ui.notices.at(-1)!, /animations: quality/);
	assert.equal(existsSync(join(configHome, "animations.json")), false);
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	assert.deepEqual(delays, [2000, 80]);
	await command.handler("performance", ctx);
	assert.deepEqual(delays, [2000, 80, 1000]);
	assert.equal(active, 2);
	await command.handler("potato", ctx);
	assert.equal(active, 1);
	assert.match(stripAnsi(editor.render(60)[0]), /working/);
	assert.equal(JSON.parse(readFileSync(join(configHome, "animations.json"), "utf8")).policy, "potato");
	await command.handler("invalid", ctx);
	assert.equal(JSON.parse(readFileSync(join(configHome, "animations.json"), "utf8")).policy, "potato");
	await command.handler("quality", ctx);
	assert.deepEqual(delays, [2000, 80, 1000, 80]);
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.equal(active, 1);
	editor.dispose();
	await fire(handlers, "session_shutdown", ctx);
	assert.equal(active, 0);
});

test("potato repaints start/settle and shows queued state on the host's next render without intervals", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	writeFileSync(join(configHome, "animations.json"), '{"schema":"gentle-pi.animations/v1","policy":"potato"}');
	const intervals = t.mock.method(globalThis, "setInterval", (_callback: () => void, delay: number) => {
		assert.equal(delay, 2000, "potato must not animate");
		return { unref() {} };
	});
	const renders = t.mock.method(fakeTui, "requestRender", () => {});
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	const pending = { value: false };
	(ctx as unknown as { hasPendingMessages(): boolean }).hasPendingMessages = () => pending.value;
	const editor = installedPrompt(ctx, ui, handlers);
	let before = renders.mock.callCount();
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	assert.ok(renders.mock.callCount() > before);
	assert.match(stripAnsi(editor.render(60)[0]), /✿ working/);
	before = renders.mock.callCount();
	pending.value = true;
	assert.equal(renders.mock.callCount(), before, "changing the queue flag is not a Gentle repaint event");
	// Pi owns enqueue and its repaint scheduling; this fake context exposes only
	// hasPendingMessages, not Pi's enqueue path. Simulate the host's render request:
	// this proves next-render visibility, not real Pi enqueue-to-paint latency.
	fakeTui.requestRender();
	assert.equal(renders.mock.callCount(), before + 1);
	assert.match(stripAnsi(editor.render(60)[0]), /✿ queued/);
	before = renders.mock.callCount();
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.ok(renders.mock.callCount() > before);
	assert.doesNotMatch(stripAnsi(editor.render(60)[0]), /working|queued/);
	await commands.get("gentle:animations")!.handler("status", ctx);
	assert.match(ui.notices.at(-1)!, /animations: potato/);
	for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
	assert.equal(intervals.mock.callCount(), 1);
});

test("animations status attributes malformed files and reports a failed write", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const path = join(configHome, "animations.json");
	writeFileSync(path, "broken");
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	await commands.get("gentle:animations")!.handler("", ctx);
	assert.match(ui.notices.at(-1)!, /animations: quality.*global file.*malformed/);
	assert.equal(readFileSync(path, "utf8"), "broken");
	rmSync(path);
	mkdirSync(path);
	await commands.get("gentle:animations")!.handler("potato", ctx);
	assert.match(ui.notices.at(-1)!, /EISDIR|ENOTEMPTY|EPERM/);
});

test("animations with no argument opens a selectable menu and applies the chosen policy", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const path = join(configHome, "animations.json");
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	// No editor/prompt is installed: the handler's `prompt?.setAnimationPolicy`
	// optional chain must tolerate the interactive menu without one.
	const chosen = fakeContext({
		select: async (title, options) => {
			assert.match(title, /Gentle animations/);
			assert.deepEqual(options, ["quality", "performance", "potato", "status"]);
			return "potato";
		},
	});
	await commands.get("gentle:animations")!.handler("", chosen.ctx);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).policy, "potato");
	assert.match(chosen.ui.notices.at(-1)!, /animations: potato/);

	// A dismissed menu (undefined selection) reports nothing and writes nothing.
	const dismissHome = scopedDoubleEscCancelConfigHome(t);
	const { pi: dismissPi, commands: dismissCommands } = fakePi();
	gentleShell(dismissPi, { GENTLE_PI_CONFIG_HOME: dismissHome });
	const dismissed = fakeContext({ select: async () => undefined });
	await dismissCommands.get("gentle:animations")!.handler("", dismissed.ctx);
	assert.equal(dismissed.ui.notices.length, 0);
	assert.equal(existsSync(join(dismissHome, "animations.json")), false);
});

test("prompt uses the compact banner cadence and releases its unref timer at settlement", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	writeFileSync(join(configHome, "animations.json"), '{"schema":"gentle-pi.animations/v1","policy":"quality"}');
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
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	assert.equal(active, 1);
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	assert.deepEqual(delays, [2000, 80]);
	assert.equal(unrefs, 2);
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.equal(active, 1);
	editor.dispose();
	await fire(handlers, "session_shutdown", ctx);
	assert.equal(active, 0);
});

// ---------------------------------------------------------------------------
// double-esc-cancel (issue #1163): opt-in, off by default. While the prompt
// is working and autocomplete is hidden, the first Esc is swallowed and the
// frame shows a hint; a second Esc within the window falls through to
// CustomEditor's own handleInput so Pi's onEscape performs the abort exactly
// as it always has. Idle double-Esc (tree/fork), bash-mode Esc, and
// autocomplete cancel live entirely in Pi's own onEscape/CustomEditor and are
// untouched by this gate.
// ---------------------------------------------------------------------------

const escapeKeybindings = { matches: (_data: string, keybinding: string) => keybinding === "app.interrupt" };

test("double-esc-cancel default off: a single Esc while working still aborts immediately, exactly as before", (t) => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	assert.equal(aborted, 1);
	assert.doesNotMatch(stripAnsi(editor.render(60).join("\n")), /esc again to cancel/);
	editor.dispose();
});

function scopedDoubleEscCancelConfigHome(t: { after(callback: () => void): void }): string {
	const configHome = mkdtempSync(join(tmpdir(), "gp-esc-cfg-"));
	t.after(() => rmSync(configHome, { recursive: true, force: true }));
	return configHome;
}

function findCustomizeRow(ui: FakeUi, label: string, width = 90): boolean {
	const view = ui.overlayView!;
	view.handleInput("\x1b[D");
	for (let category = 0; category < 8; category++) {
		view.handleInput("\x1b[C");
		for (let index = 0; index < 35; index++) {
			if (view.render(width).some((line) => line.includes(`▸ ${label}`))) return true;
			view.handleInput("\x1b[B");
		}
		view.handleInput("\x1b[D");
		view.handleInput("\x1b[B");
	}
	return false;
}

async function customizeAction(ui: FakeUi, label: string): Promise<void> {
	assert.ok(findCustomizeRow(ui, label), `missing ${label}`);
	const notices = ui.notices.length;
	ui.overlayView!.handleInput("\r");
	for (let attempt = 0; attempt < 100 && ui.notices.length === notices; attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.ok(ui.notices.length > notices, `action did not finish: ${label}`);
}

test("customize Editor rows preview global preference without applying until Enter or Space", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	assert.ok(findCustomizeRow(ui, "Vim: enable"));
	assert.match(ui.overlayView!.render(90).join("\n"), /Preview · Vim[\s\S]*preference: off.*effective: no active prompt/i);
	assert.equal(existsSync(join(home, "vim.json")), false);
	await customizeAction(ui, "Vim: enable");
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(resolveVimPolicy({ gentlePiConfigHome: home }).policy, "on");
	assert.ok(findCustomizeRow(ui, "Vim: disable"));
	assert.match(ui.overlayView!.render(90).join("\n"), /preference: on.*effective:/i);
	ui.overlayView!.handleInput(" ");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(resolveVimPolicy({ gentlePiConfigHome: home }).policy, "off");
	ui.overlayView!.handleInput("\x1b"); await pending;
});

test("external Vim preference change while customize is open never implies a compatibility failure", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home }, { vimRuntimeVersion: () => "0.87.1" });
	const { ctx, ui, overlayReady } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	try {
		const pending = commands.get("gentle:customize")!.handler("", ctx);
		await overlayReady;
		assert.ok(findCustomizeRow(ui, "Vim: enable"));
		writeVimPolicy("on", { gentlePiConfigHome: home }); // Another session changes the global preference.
		assert.equal(editor.effectiveVimPolicy, "off");
		const preview = ui.overlayView!.render(90).join("\n");
		assert.match(preview, /preference: on.*effective: off/i);
		assert.doesNotMatch(preview, /compatibility rejected|unsupported/i);
		await commands.get("gentle:vim")!.handler("status", ctx);
		assert.equal(editor.effectiveVimPolicy, "on");
		assert.doesNotMatch(ui.notices.at(-1)!, /compatibility rejected|unsupported/i);
		ui.overlayView!.handleInput("\x1b"); await pending;
	} finally { editor.dispose(); }
});

test("customize updates live Vim prompt and reports unsupported effective state without attributing its cause", async (t) => {
	for (const version of ["0.87.1", "unsupported"]) {
		const home = scopedDoubleEscCancelConfigHome(t);
		const { pi, handlers, commands } = fakePi();
		gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home }, { vimRuntimeVersion: () => version });
		const { ctx, ui, overlayReady } = fakeContext();
		const editor = installedPrompt(ctx, ui, handlers);
		try {
			const pending = commands.get("gentle:customize")!.handler("", ctx); await overlayReady;
			await customizeAction(ui, "Vim: enable");
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(editor.effectiveVimPolicy, version === "unsupported" ? "off" : "on");
			assert.match(ui.notices.at(-1)!, version === "unsupported" ? /Effective prompt: off; saved preference and prompt differ; ordinary editing remains active/i : /Prompt applies now/i);
			assert.ok(findCustomizeRow(ui, "Vim: enable"));
			assert.match(ui.overlayView!.render(90).join("\n"), version === "unsupported" ? /preference: on.*effective: off.*preference and prompt differ/i : /preference: on.*effective: on/i);
			await customizeAction(ui, "Vim: disable");
			assert.equal(editor.effectiveVimPolicy, "off");
			ui.overlayView!.handleInput("\x1b"); await pending;
		} finally { editor.dispose(); }
	}
});

test("customize Vim reports a persistence error without changing the live prompt", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers, commands } = fakePi(); gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers);
	const pending = commands.get("gentle:customize")!.handler("", ctx); await overlayReady;
	chmodSync(home, 0o500);
	try {
		await customizeAction(ui, "Vim: enable");
		assert.match(ui.notices.at(-1)!, /Visual customization:/);
		assert.equal(editor.effectiveVimPolicy, "off");
		assert.equal(resolveVimPolicy({ gentlePiConfigHome: home }).policy, "off");
	} finally {
		chmodSync(home, 0o700);
		ui.overlayView!.handleInput("\x1b"); await pending;
		editor.dispose();
	}
});

test("customize Vim refuses malformed or unreadable policy without false success", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const path = join(home, "vim.json");
	writeFileSync(path, "invalid");
	const { pi, commands } = fakePi(); gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	const pending = commands.get("gentle:customize")!.handler("", ctx); await overlayReady;
	assert.ok(findCustomizeRow(ui, "Vim: enable"));
	assert.match(ui.overlayView!.render(90).join("\n"), /malformed or unreadable/i);
	await customizeAction(ui, "Vim: enable");
	assert.equal(readFileSync(path, "utf8"), "invalid");
	assert.match(ui.notices.at(-1)!, /malformed or unreadable/i);
	rmSync(path); mkdirSync(path);
	assert.ok(findCustomizeRow(ui, "Vim: disable"));
	assert.match(ui.overlayView!.render(90).join("\n"), /malformed or unreadable/i);
	await customizeAction(ui, "Vim: disable");
	assert.match(ui.notices.at(-1)!, /malformed or unreadable/i);
	assert.equal(resolveVimPolicy({ gentlePiConfigHome: home }).malformed, true);
	ui.overlayView!.handleInput("\x1b"); await pending;
});

test("customize command updates displayed settings and applies layout immediately", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	assert.match(ui.overlayView!.render(90).join("\n"), /Animations: quality.*current/);
	await customizeAction(ui, "Animations: performance");
	assert.equal(resolveAnimationPolicy({ gentlePiConfigHome: home }).policy, "performance");
	assert.match(ui.overlayView!.render(90).join("\n"), /Animations: performance.*current/);
	assert.match(ui.notices.at(-1)!, /Prompt applies now.*banner.*next startup/i);
	await customizeAction(ui, "Banner rose");
	assert.equal((await readBannerConfig(home)).showRose, false);
	assert.match(ui.overlayView!.render(90).join("\n"), /Banner rose: off/);
	assert.match(ui.notices.at(-1)!, /next startup/i);
	await customizeAction(ui, "Status placement: hidden");
	assert.equal(resolveVisualSettings({ gentlePiConfigHome: home }).settings.statusPlacement, "hidden");
	assert.match(ui.overlayView!.render(90).join("\n"), /Status placement: hidden.*current/);
	assert.match(ui.notices.at(-1)!, /saved and applied/);
	ui.overlayView!.handleInput("\x1b");
	await pending;
});

test("below-input header remains a fullscreen widget without the rail and follows live placement", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	await fire(handlers, "session_start", ctx);
	const tui = { mode: "fullscreen", terminal: { rows: 40, columns: 180 }, requestRender() {} };
	const footer = (ui.footerFactory as (tui: unknown, theme: ShellBarTheme, data: unknown) => { dispose(): void })(tui, plainTheme, {
		getGitBranch: () => "main", getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1, onBranchChange: () => () => {},
	});
	try {
		const widget = ui.widgets.get("gentle-shell-below-input-header") as (tui: unknown, theme: ShellBarTheme) => { render(width: number): string[] };
		assert.deepEqual(widget(tui, plainTheme).render(180), []);
		const pending = commands.get("gentle:customize")!.handler("", ctx);
		await overlayReady;
		await customizeAction(ui, "Header placement: below-input");
		assert.match(widget(tui, plainTheme).render(180).join("\n"), /Gentle Shell/);
		assert.equal(widget(tui, plainTheme).render(180).length, 2);
		tui.mode = "regular";
		assert.deepEqual(widget(tui, plainTheme).render(180), []);
		ui.overlayView!.handleInput("\x1b");
		await pending;
	} finally { footer.dispose(); }
});

test("narrow fullscreen with a below-input header shows only the bottom bar, carrying the header's data and extension statuses", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	await fire(handlers, "session_start", ctx);
	const tui = { mode: "fullscreen", terminal: { rows: 40, columns: 100 }, requestRender() {} };
	const footer = (ui.footerFactory as (tui: unknown, theme: ShellBarTheme, data: unknown) => { render(width: number): string[]; dispose(): void })(tui, plainTheme, {
		getGitBranch: () => "main", getExtensionStatuses: () => new Map([["mcp", "MCP: 2 servers"]]), getAvailableProviderCount: () => 1, onBranchChange: () => () => {},
	});
	try {
		const widget = ui.widgets.get("gentle-shell-below-input-header") as (tui: unknown, theme: ShellBarTheme) => { render(width: number): string[] };
		const topBottom = footer.render(100);
		assert.equal(topBottom.length, 1, "top placement keeps the compact bar contract");
		assert.match(topBottom[0]!, /gentle shell/);
		const pending = commands.get("gentle:customize")!.handler("", ctx);
		await overlayReady;
		await customizeAction(ui, "Header placement: below-input");
		assert.deepEqual(widget(tui, plainTheme).render(100), [], "no second status row below the input at narrow width");
		const narrow = footer.render(100);
		assert.equal(narrow.length, 2);
		assert.match(narrow[0]!, /Gentle Shell/, "bottom-only bar reuses the header row");
		assert.match(narrow[0]!, /ctx .* 45%/);
		assert.match(narrow[0]!, /\$0\.000 sub/);
		assert.match(narrow[0]!, /usage/);
		assert.match(narrow[1]!, /MCP: 2 servers/, "extension statuses survive on their own line");
		assert.ok(narrow.every((line) => visibleWidth(line) <= 100));
		for (const width of [60, 80]) {
			tui.terminal.columns = width;
			const mobile = footer.render(width);
			assert.match(mobile[0]!, /ctx/, `${width} keeps context before location`);
			assert.ok(mobile.every((line) => visibleWidth(line) <= width));
		}
		tui.terminal.columns = 180;
		assert.equal(widget(tui, plainTheme).render(180).length, 2, "wide keeps the below-input header");
		assert.match(footer.render(180).join("\n"), /gentle shell/, "wide keeps the compact bottom bar");
		tui.terminal.columns = 100;
		await customizeAction(ui, "Status placement: hidden");
		assert.deepEqual(footer.render(100), [], "hidden never paints a bottom bar");
		assert.equal(widget(tui, plainTheme).render(100).length, 2, "with no bottom bar the below-input header stays");
		tui.mode = "regular";
		await customizeAction(ui, "Status placement: bottom");
		assert.equal(footer.render(100).length, 1, "regular mode keeps the compact bar");
		ui.overlayView!.handleInput("\x1b");
		await pending;
	} finally { footer.dispose(); }
});

test("customize previews installed source palette without selecting until Enter", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const source = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url).pathname;
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	const themeApi = ctx.ui as unknown as { getTheme(name: string): { name: string; sourcePath?: string } | undefined; setTheme(name: string): { success: boolean } };
	const original = themeApi.getTheme;
	themeApi.getTheme = (name) => name === "dark" ? { name, sourcePath: source } : original(name);
	const applied: string[] = [];
	themeApi.setTheme = (name) => { applied.push(name); return { success: true }; };
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	assert.ok(findCustomizeRow(ui, "Theme: dark"), "missing Theme: dark");
	const lines = ui.overlayView!.render(90).join("\n");
	assert.match(lines, /dark · source palette/);
	assert.match(lines, /sample text/);
	assert.deepEqual(applied, []);
	ui.overlayView!.handleInput("\r");
	assert.deepEqual(applied, ["dark"]);
	ui.overlayView!.handleInput("\x1b");
	await pending;
});

test("customize preserves invalid visual settings and reports failed theme selection", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const path = join(home, "visual-customization.json");
	writeFileSync(path, "invalid");
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	const api = ctx.ui as unknown as { getTheme(name: string): unknown; setTheme(name: string): unknown };
	api.getTheme = () => undefined;
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	await customizeAction(ui, "Status placement: hidden");
	assert.equal(readFileSync(path, "utf8"), "invalid");
	assert.match(ui.notices.at(-1)!, /malformed/);
	await customizeAction(ui, "Theme: light");
	assert.match(ui.notices.at(-1)!, /unavailable/);
	ui.overlayView!.handleInput("\x1b");
	await pending;
});

test("customize never overwrites malformed banner through toggle, color or reset", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const bannerPath = join(home, "banner.json");
	writeFileSync(bannerPath, "invalid banner");
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	for (const action of ["Banner rose", "Banner color: cyan", "Reset visual, banner and animation defaults"]) {
		await customizeAction(ui, action);
		assert.equal(readFileSync(bannerPath, "utf8"), "invalid banner");
		assert.match(ui.notices.at(-1)!, /malformed.*banner/i);
	}
	assert.equal(resolveVisualSettings({ gentlePiConfigHome: home }).source, "default");
	ui.overlayView!.handleInput("\x1b");
	await pending;
});

test("customize refuses an unreadable banner path before modifying visual settings", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	mkdirSync(join(home, "banner.json"));
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	await customizeAction(ui, "Banner color: cyan");
	assert.match(ui.notices.at(-1)!, /unreadable banner/i);
	await customizeAction(ui, "Reset visual, banner and animation defaults");
	assert.match(ui.notices.at(-1)!, /unreadable banner/i);
	assert.equal(resolveVisualSettings({ gentlePiConfigHome: home }).source, "default");
	ui.overlayView!.handleInput("\x1b");
	await pending;
});

test("customize reports a partial reset and identifies committed stores on animation write failure", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const options = { gentlePiConfigHome: home };
	writeVisualSettings({ ...resolveVisualSettings(options).settings, statusPlacement: "hidden" }, options);
	mkdirSync(join(home, "animations.json"));
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	await customizeAction(ui, "Reset visual, banner and animation defaults");
	assert.equal(resolveVisualSettings(options).settings.statusPlacement, "auto");
	assert.match(ui.notices.at(-1)!, /Partial reset.*visual.*changed.*banner.*changed.*animation.*unchanged/i);
	ui.overlayView!.handleInput("\x1b");
	await pending;
});

test("named profile applies installed theme, banner, animation and visual settings only after confirmation", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const options = { gentlePiConfigHome: home };
	const visual = { ...resolveVisualSettings(options).settings, statusPlacement: "hidden" as const };
	saveVisualProfile("night", { themeName: "light", animationPolicy: "performance", banner: { showRose: false, showTextLogo: true, color: "cyan" }, visual }, options);
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	const applied: string[] = [];
	(ctx.ui as unknown as { setTheme(name: string): { success: boolean } }).setTheme = (name) => { applied.push(name); return { success: true }; };
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	const view = ui.overlayView!;
	view.handleInput("p");
	assert.match(view.render(90).join("\n"), /night.*Theme: light/s);
	assert.deepEqual(applied, [], "preview has no side effects");
	view.handleInput("a");
	assert.match(view.render(90).join("\n"), /Confirm apply night/);
	view.handleInput("y");
	for (let i = 0; i < 100 && !ui.notices.some(notice => /profile night applied/.test(notice)); i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
	assert.deepEqual(applied, ["light"]);
	assert.equal(resolveVisualSettings(options).settings.statusPlacement, "hidden");
	assert.deepEqual(await readBannerConfig(home), { showRose: false, showTextLogo: true, color: "cyan" });
	assert.equal(resolveAnimationPolicy(options).policy, "performance");
	assert.match(ui.notices.at(-1)!, /profile night applied.*banner applies at next startup/i);
	view.handleInput("\x1b");
	view.handleInput("\x1b");
	await pending;
});

test("saving a profile refuses an active theme that is not installed or resolvable", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	(ctx.ui as unknown as { theme: { name: string } }).theme = { name: "phantom" };
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	const view = ui.overlayView!;
	view.handleInput("p");
	view.render(90);
	view.handleInput("s");
	for (const char of "ghost") view.handleInput(char);
	view.render(90);
	view.handleInput("\r");
	for (let i = 0; i < 100 && !ui.notices.some(notice => /unavailable|invalid/i.test(notice)); i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
	assert.deepEqual(listVisualProfiles({ gentlePiConfigHome: home }), [], "no profile should be written for an unresolvable theme");
	assert.match(ui.notices.at(-1)!, /theme.*(unavailable|invalid|not installed)/i);
	view.handleInput("\x1b");
	view.handleInput("\x1b");
	await pending;
});

test("saving a profile refuses a malformed or unreadable animation policy store", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	mkdirSync(join(home, "animations.json"));
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	(ctx.ui as unknown as { theme: { name: string } }).theme = { name: "dark" };
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	const view = ui.overlayView!;
	view.handleInput("p");
	view.render(90);
	view.handleInput("s");
	for (const char of "broken") view.handleInput(char);
	view.render(90);
	view.handleInput("\r");
	for (let i = 0; i < 100 && !ui.notices.some(notice => /animation/i.test(notice)); i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
	assert.deepEqual(listVisualProfiles({ gentlePiConfigHome: home }), [], "no profile should be written while the animation store is unreadable");
	assert.match(ui.notices.at(-1)!, /(animation.*(unreadable|malformed|cannot read))|(cannot read animation)/i);
	view.handleInput("\x1b");
	view.handleInput("\x1b");
	await pending;
});

test("profile save, replace, delete and reset succeed through the modal and persist to the catalog", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	(ctx.ui as unknown as { theme: { name: string } }).theme = { name: "dark" };
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	const view = ui.overlayView!;
	view.handleInput("p");
	view.render(90);
	view.handleInput("s");
	for (const char of "work") view.handleInput(char);
	view.render(90);
	let before = ui.notices.length;
	view.handleInput("\r");
	for (let i = 0; i < 100 && ui.notices.length === before; i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
	await new Promise<void>(resolve => setTimeout(resolve, 5));
	assert.match(ui.notices.at(-1)!, /profile work saved/i);
	assert.deepEqual(listVisualProfiles({ gentlePiConfigHome: home }), ["work"]);
	view.render(90);
	view.handleInput("r");
	view.render(90);
	before = ui.notices.length;
	view.handleInput("y");
	for (let i = 0; i < 100 && ui.notices.length === before; i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
	await new Promise<void>(resolve => setTimeout(resolve, 5));
	assert.match(ui.notices.at(-1)!, /profile work saved/i);
	assert.deepEqual(listVisualProfiles({ gentlePiConfigHome: home }), ["work"], "replace keeps the same single entry");
	view.render(90);
	view.handleInput("d");
	view.render(90);
	before = ui.notices.length;
	view.handleInput("y");
	for (let i = 0; i < 100 && ui.notices.length === before; i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
	await new Promise<void>(resolve => setTimeout(resolve, 5));
	assert.match(ui.notices.at(-1)!, /profile work deleted/i);
	assert.deepEqual(listVisualProfiles({ gentlePiConfigHome: home }), []);
	saveVisualProfile("leftover", { themeName: "dark", animationPolicy: "quality", banner: { showRose: true, showTextLogo: false, color: "pink" }, visual: resolveVisualSettings({ gentlePiConfigHome: home }).settings }, { gentlePiConfigHome: home });
	view.render(90);
	view.handleInput("z");
	view.render(90);
	before = ui.notices.length;
	view.handleInput("y");
	for (let i = 0; i < 100 && ui.notices.length === before; i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
	assert.match(ui.notices.at(-1)!, /catalog cleared/i);
	assert.deepEqual(listVisualProfiles({ gentlePiConfigHome: home }), []);
	view.handleInput("\x1b");
	view.handleInput("\x1b");
	await pending;
});

test("named profile reports PARTIAL when animation store fails, and never activates an unavailable theme", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const options = { gentlePiConfigHome: home };
	const visual = { ...resolveVisualSettings(options).settings, statusPlacement: "hidden" as const };
	saveVisualProfile("missing", { themeName: "not-installed", animationPolicy: "potato", banner: { showRose: false, showTextLogo: false, color: "green" }, visual }, options);
	mkdirSync(join(home, "animations.json"));
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	const applied: string[] = [];
	(ctx.ui as unknown as { setTheme(name: string): { success: boolean } }).setTheme = (name) => { applied.push(name); return { success: true }; };
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	const view = ui.overlayView!;
	view.handleInput("p");
	view.render(90);
	view.handleInput("a");
	view.render(90);
	view.handleInput("y");
	for (let i = 0; i < 100 && !ui.notices.some(notice => /PARTIAL profile apply/.test(notice)); i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
	assert.deepEqual(applied, [], "unknown theme never reaches setTheme");
	assert.equal(resolveVisualSettings(options).settings.statusPlacement, "hidden");
	assert.equal((await readBannerConfig(home)).color, "green");
	assert.equal(resolveAnimationPolicy(options).policy, "quality");
	assert.match(ui.notices.at(-1)!, /PARTIAL profile apply: visual, banner changed; theme:.*unavailable.*animation:/i);
	assert.doesNotMatch(ui.notices.at(-1)!, /profile missing applied/i);
	assert.doesNotMatch(view.render(90).join("\n"), /Create theme|Edit theme|Import theme|Export theme/);
	view.handleInput("\x1b");
	view.handleInput("\x1b");
	await pending;
});

test("customize degrades unavailable theme APIs and refuses noninteractive UI", async (t) => {
	const home = scopedDoubleEscCancelConfigHome(t);
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home });
	const { ctx, ui, overlayReady } = fakeContext();
	(ctx.ui as unknown as { getAllThemes(): unknown }).getAllThemes = () => { throw new Error("theme lookup failed"); };
	const pending = commands.get("gentle:customize")!.handler("", ctx);
	await overlayReady;
	assert.ok(findCustomizeRow(ui, "Themes unavailable; use Pi /settings"), "missing Themes unavailable message");
	ui.overlayView!.handleInput("\x1b");
	await pending;
	const { ctx: rpc, ui: rpcUi } = fakeContext();
	(rpc as unknown as { mode: string }).mode = "rpc";
	await commands.get("gentle:customize")!.handler("", rpc);
	assert.equal(rpcUi.overlayView, undefined);
	assert.match(rpcUi.notices.at(-1)!, /interactive terminal/);
});

test("double-esc-cancel enabled: the first Esc while working is swallowed and shows the hint instead of aborting", (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_DOUBLE_ESC_CANCEL: "on", GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	assert.equal(aborted, 0, "the first Esc must be swallowed, not aborted");
	assert.match(stripAnsi(editor.render(60).join("\n")), /esc again to cancel/);
	editor.dispose();
});

test("double-esc-cancel enabled: a second Esc within the window falls through and aborts, clearing the hint", (t) => {
	let now = 1_000_000;
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_DOUBLE_ESC_CANCEL: "on", GENTLE_PI_CONFIG_HOME: configHome }, { now: () => now });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	assert.equal(aborted, 0);
	now += 500;
	editor.handleInput("\x1b");
	assert.equal(aborted, 1, "the second Esc within the window must fall through to abort");
	assert.doesNotMatch(stripAnsi(editor.render(60).join("\n")), /esc again to cancel/);
	editor.dispose();
});

test("double-esc-cancel enabled: an Esc after the window expires is a fresh first press, not an abort", (t) => {
	let now = 1_000_000;
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_DOUBLE_ESC_CANCEL: "on", GENTLE_PI_CONFIG_HOME: configHome }, { now: () => now });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	assert.equal(aborted, 0);
	now += 1001;
	editor.handleInput("\x1b");
	assert.equal(aborted, 0, "the window expired, so this must be treated as a new first press");
	assert.match(stripAnsi(editor.render(60).join("\n")), /esc again to cancel/);
	editor.dispose();
});

test("double-esc-cancel enabled: Esc while idle passes straight through, untouched by this gate", (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_DOUBLE_ESC_CANCEL: "on", GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	// agent_start never fired: the prompt stays idle.
	editor.handleInput("\x1b");
	assert.equal(aborted, 1, "idle Esc must be unaffected by the policy");
	editor.dispose();
});

test("double-esc-cancel enabled: Esc while autocomplete is visible bypasses this gate entirely", (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_DOUBLE_ESC_CANCEL: "on", GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	(editor as unknown as { isShowingAutocomplete(): boolean }).isShowingAutocomplete = () => true;
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	assert.doesNotMatch(stripAnsi(editor.render(60).join("\n")), /esc again to cancel/, "autocomplete must bypass the gate, matching CustomEditor's own guard");
	editor.dispose();
});

// ---------------------------------------------------------------------------
// Working-cancel keeps the queue moving (issue #1218). Pi's own onEscape
// restores `[queuedText, currentText].filter(t => t.trim()).join("\n\n")`
// into the editor and aborts. These tests fake that join in `onEscape` (the
// same seam the double-esc-cancel tests above use), then check that the
// user's own draft is all that is left in the editor and that the queued
// text is sent exactly once, after the aborted run settles.
// ---------------------------------------------------------------------------

test("extractQueuedText reverses Pi's queued+draft join", () => {
	assert.equal(extractQueuedText("follow up\n\ndraft reply", "draft reply"), "follow up");
	assert.equal(extractQueuedText("draft reply", "draft reply"), "", "no queue: the join degenerates to the draft alone");
	assert.equal(extractQueuedText("only queued", ""), "only queued", "empty draft: the join degenerates to the queue alone");
	assert.equal(extractQueuedText("", ""), "", "both empty");
	assert.equal(extractQueuedText("unrelated text", "draft reply"), undefined, "a shape that does not match the join is unrecognized, not an empty queue: Pi's own text must win, not be discarded");
});

test("extractQueuedText treats a whitespace-only draft as empty, matching Pi's own trim filter", () => {
	assert.equal(extractQueuedText("only queued", "   "), "only queued", "a whitespace-only draft never survives Pi's filter, so the whole join is the queue");
	assert.equal(extractQueuedText("", "   "), "", "whitespace-only draft with no queue is still no queue, not unrecognized");
});

test("working cancel: an aborted turn with a queued message sends it once settled and keeps the draft", (t) => {
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.onEscape = () => { editor.setText(`follow up\n\n${editor.getText()}`); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "draft reply", "the user's own draft stays in the editor");
	assert.equal(sentMessages.length, 0, "nothing is sent until the aborted run settles");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.deepEqual(sentMessages.map((m) => m.content), ["follow up"]);
	editor.dispose();
});

test("vim INSERT Esc only enters NORMAL; NORMAL Esc hands off queued text after settlement", async (t) => {
	const { pi, handlers, commands, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	try {
		await commands.get("gentle:vim")!.handler("enable", ctx);
		editor.setText("draft reply");
		let aborts = 0;
		editor.onEscape = () => { aborts++; editor.setText(`follow up\n\n${editor.getText()}`); };
		await fire(handlers, "agent_start", ctx);
		editor.handleInput("\x1b");
		assert.equal(aborts, 0);
		assert.equal(editor.getText(), "draft reply");
		assert.match(editor.render(60).join("\n"), /NORMAL/);
		editor.handleInput("\x1b");
		assert.equal(aborts, 1);
		assert.equal(editor.getText(), "draft reply");
		assert.equal(sentMessages.length, 0);
		await fire(handlers, "agent_settled", ctx);
		assert.deepEqual(sentMessages.map((message) => message.content), ["follow up"]);
	} finally { editor.dispose(); }
});

test("working cancel: an aborted turn with no queued messages behaves exactly as before, with no redundant setText", (t) => {
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	// Pi's own onEscape restore is the one real setText call on this path
	// (it always writes the combined text, even when that equals the
	// draft); the spy below counts every call, so it must see only that one
	// and none added by abortAndDispatchQueued itself.
	editor.onEscape = () => { editor.setText(editor.getText()); };
	let setTextCalls = 0;
	const originalSetText = editor.setText.bind(editor);
	(editor as unknown as { setText(text: string): void }).setText = (text: string) => { setTextCalls++; originalSetText(text); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	assert.equal(setTextCalls, 1, "the no-queue path must not add its own write on top of Pi's own restore");
	assert.equal(editor.getText(), "draft reply");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.equal(sentMessages.length, 0, "an empty queue must never trigger a send");
	editor.dispose();
});

test("working cancel: an unrecognized restore shape leaves Pi's own text untouched and dispatches nothing", (t) => {
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	// Simulates a future Pi restore shape this code does not recognize.
	editor.onEscape = () => { editor.setText("an unrecognized shape"); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "an unrecognized shape", "Pi's own restore wins on a shape mismatch; nothing here overwrites it");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.equal(sentMessages.length, 0, "an unrecognized shape must never be dispatched as if it were queued text");
	editor.dispose();
});

test("working cancel: an empty draft with a queued message sends the whole queue and leaves the editor empty", (t) => {
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.onEscape = () => { editor.setText("only queued"); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "", "an empty draft stays empty");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.deepEqual(sentMessages.map((m) => m.content), ["only queued"]);
	editor.dispose();
});

test("working cancel: the same dispatch applies to the confirming second Esc when double-esc-cancel is enabled", (t) => {
	let now = 1_000_000;
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_DOUBLE_ESC_CANCEL: "on", GENTLE_PI_CONFIG_HOME: configHome }, { now: () => now });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.onEscape = () => { editor.setText(`follow up\n\n${editor.getText()}`); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	now += 500;
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "draft reply");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.deepEqual(sentMessages.map((m) => m.content), ["follow up"]);
	editor.dispose();
});

test("working cancel: queued text is never sent twice even if agent_settled fires again", (t) => {
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.onEscape = () => { editor.setText(`follow up\n\n${editor.getText()}`); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.deepEqual(sentMessages.map((m) => m.content), ["follow up"]);
	editor.dispose();
});

test("working cancel: a new agent_start before the aborted run settles keeps the pending text and sends it once that turn settles", (t) => {
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.onEscape = () => { editor.setText(`follow up\n\n${editor.getText()}`); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	// The user sent the draft (or another turn started) before the aborted
	// run's own agent_settled fired. Nothing is sent from inside agent_start:
	// Pi is mid-turn there, so the text waits for that turn to settle.
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	assert.equal(sentMessages.length, 0, "never send from inside agent_start");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.deepEqual(sentMessages.map((m) => ({ content: m.content, deliverAs: m.options?.deliverAs })), [{ content: "follow up", deliverAs: undefined }]);
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.equal(sentMessages.length, 1, "the pending text must not be delivered a second time");
	editor.dispose();
});

test("working cancel: a whitespace-only recognized queue is treated as no queue and never dispatched", (t) => {
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.onEscape = () => { editor.setText(`   \n\n${editor.getText()}`); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.equal(sentMessages.length, 0, "whitespace is not a message");
	assert.equal(editor.getText(), "draft reply", "the recognized whitespace prefix is stripped and the draft comes back alone");
	editor.dispose();
});

test("working cancel: a failing sendUserMessage on settle is reported, not thrown, and the prompt still leaves the working state", (t) => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.onEscape = () => { editor.setText(`follow up\n\n${editor.getText()}`); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	(pi as unknown as { sendUserMessage: (content: string) => void }).sendUserMessage = () => { throw new Error("session is switching"); };
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.ok(ui.notices.some((notice) => /session is switching/.test(notice)), "the failure surfaces as a notice");
	assert.equal(editor.getText(), "follow up\n\ndraft reply", "the queued text is put back in front of the draft, exactly as Pi's own restore would have left it");
	assert.doesNotMatch(stripAnsi(editor.render(60).join("\n")), /esc again to cancel/, "the prompt is idle again");
	editor.dispose();
});

test("working cancel: a failing send reported through a context without UI still restores the queued text into the editor", (t) => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const headless = fakeContext({ hasUI: false });
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.onEscape = () => { editor.setText(`follow up\n\n${editor.getText()}`); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	(pi as unknown as { sendUserMessage: (content: string) => void }).sendUserMessage = () => { throw new Error("session is switching"); };
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, headless.ctx);
	assert.equal(headless.ui.notices.length, 0, "no UI, no notice");
	assert.equal(editor.getText(), "follow up\n\ndraft reply", "with or without a UI to tell the user, the text is never dropped");
	editor.dispose();
});

test("working cancel: agent_settled never sends while another turn is still in flight; the text waits for an idle settle", (t) => {
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const busy = fakeContext({ idle: false }).ctx;
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.onEscape = () => { editor.setText(`follow up\n\n${editor.getText()}`); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, busy);
	assert.equal(sentMessages.length, 0, "a settle reported while not idle must not inject the text mid-turn");
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	editor.handleInput("\x1b");
	assert.equal(aborted, 1, "a run is still in flight, so the prompt stays working and Esc takes the cancel path");
	assert.doesNotMatch(stripAnsi(editor.render(60).join("\n")), /esc again to clear/, "not the idle clear");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.deepEqual(sentMessages.map((m) => m.content), ["follow up"]);
	editor.dispose();
});

test("working cancel: two aborts before an idle settle deliver both queued texts, in order, as one message", (t) => {
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const busy = fakeContext({ idle: false }).ctx;
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	let aborts = 0;
	editor.onEscape = () => { aborts++; editor.setText(aborts === 1 ? "first" : "second"); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, busy);
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.deepEqual(sentMessages.map((m) => m.content), ["first\n\nsecond"], "nothing from the first abort is lost, and order is preserved");
	editor.dispose();
});

test("working cancel: pending queued text never crosses a session boundary", (t) => {
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.onEscape = () => { editor.setText(`follow up\n\n${editor.getText()}`); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.equal(sentMessages.length, 0, "the old session's queued text must not be sent into the next session");
});

test("working cancel: agent_settled firing first delivers the pending text without a deliverAs override", (t) => {
	const { pi, handlers, sentMessages } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.onEscape = () => { editor.setText(`follow up\n\n${editor.getText()}`); };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);
	assert.deepEqual(sentMessages.map((m) => ({ content: m.content, deliverAs: m.options?.deliverAs })), [{ content: "follow up", deliverAs: undefined }]);
	// The next turn's own agent_start must not re-deliver the already-sent text.
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	assert.equal(sentMessages.length, 1);
	editor.dispose();
});

// ---------------------------------------------------------------------------
// Idle double-Esc clears the draft (issue #1218). With the prompt idle,
// autocomplete hidden, and a non-empty draft, a first Esc shows a hint
// instead of doing nothing; a second Esc within 500ms adds the draft to
// history and clears it. An empty editor, autocomplete, or the working state
// are all untouched: Pi's own idle double-Esc (tree/fork) and the
// working-cancel gate above keep deciding those cases.
// ---------------------------------------------------------------------------

test("idle draft: the first Esc shows the clear hint and keeps the text", (t) => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	editor.handleInput("\x1b");
	assert.equal(aborted, 0, "the first Esc must be swallowed, not passed to Pi's own idle handler");
	assert.equal(editor.getText(), "draft reply");
	assert.match(stripAnsi(editor.render(60).join("\n")), /esc again to clear/);
	editor.dispose();
});

test("idle draft: a second Esc within the window adds the draft to history and clears it", (t) => {
	let now = 1_000_000;
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) }, { now: () => now });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	const history: string[] = [];
	(editor as unknown as { addToHistory(text: string): void }).addToHistory = (text: string) => history.push(text);
	editor.handleInput("\x1b");
	now += 400;
	editor.handleInput("\x1b");
	assert.deepEqual(history, ["draft reply"]);
	assert.equal(editor.getText(), "");
	assert.doesNotMatch(stripAnsi(editor.render(60).join("\n")), /esc again to clear/);
	editor.dispose();
});

test("idle draft: an Esc after the window expires is a fresh first press, not a clear", (t) => {
	let now = 1_000_000;
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) }, { now: () => now });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.handleInput("\x1b");
	now += 501;
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "draft reply", "the window expired, so this is a new first press, not a clear");
	assert.match(stripAnsi(editor.render(60).join("\n")), /esc again to clear/);
	editor.dispose();
});

test("idle empty editor: Esc passes straight through to Pi's own tree/fork double-Esc", (t) => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	editor.handleInput("\x1b");
	assert.equal(aborted, 1, "an empty editor must be untouched by the idle-clear gate");
	editor.dispose();
});

test("idle draft: Esc while autocomplete is visible bypasses the idle-clear gate", (t) => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	(editor as unknown as { isShowingAutocomplete(): boolean }).isShowingAutocomplete = () => true;
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "draft reply", "autocomplete cancel must never clear the draft");
	assert.doesNotMatch(stripAnsi(editor.render(60).join("\n")), /esc again to clear/, "autocomplete must bypass the idle-clear gate, matching CustomEditor's own guard");
	editor.dispose();
});

test("working state: a non-empty draft's Esc is decided by the working-cancel gate, never the idle-clear hint", (t) => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.onEscape = () => { editor.setText(editor.getText()); };
	editor.handleInput("\x1b");
	assert.doesNotMatch(stripAnsi(editor.render(60).join("\n")), /esc again to clear/, "working must never show the idle-clear hint");
	editor.dispose();
});

test("idle draft: editing the text between two Esc presses starts a fresh clear window instead of clearing the edit away", (t) => {
	let now = 1_000_000;
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) }, { now: () => now });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("draft reply");
	editor.handleInput("\x1b");
	editor.setText("draft reply, edited");
	assert.doesNotMatch(stripAnsi(editor.render(60).join("\n")), /esc again to clear/, "the edit invalidates the pending clear, so the hint goes away with it");
	now += 400;
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "draft reply, edited", "an edit invalidates the earlier snapshot, so this must not clear");
	assert.match(stripAnsi(editor.render(60).join("\n")), /esc again to clear/, "the edit starts a fresh first press, with its own hint");
	now += 400;
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "", "the fresh window's own second Esc, on the unchanged edited text, does clear");
	editor.dispose();
});

test("idle draft: typing and deleting between two Esc presses still invalidates the pending clear", (t) => {
	let now = 1_000_000;
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) }, { now: () => now });
	const { ctx, ui } = fakeContext();
	// Esc-only matching: ordinary keystrokes must reach the editor as text.
	const preciseEscape = { matches: (data: string, keybinding: string) => keybinding === "app.interrupt" && data === "\x1b" };
	const editor = installedPrompt(ctx, ui, handlers, preciseEscape);
	editor.setText("draft reply");
	editor.handleInput("\x1b");
	editor.handleInput("x");
	editor.handleInput("\x7f");
	assert.equal(editor.getText(), "draft reply", "type then backspace lands on the same text");
	now += 400;
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "draft reply", "an intervening keystroke invalidates the confirmation even when the text ends up identical");
	editor.dispose();
});

test("idle draft: a bash-mode draft's Esc bypasses the idle-clear gate entirely", (t) => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("!ls");
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	editor.handleInput("\x1b");
	assert.equal(aborted, 1, "a bash-mode draft's first Esc must reach Pi's own bash-mode onEscape, which clears bash mode");
	assert.equal(editor.getText(), "!ls", "this gate never touches bash-mode text; Pi's own onEscape owns it");
	assert.doesNotMatch(stripAnsi(editor.render(60).join("\n")), /esc again to clear/, "bash mode must bypass the idle-clear gate, matching Pi's own bash-mode Esc");
	editor.dispose();
});

test("idle draft: a bash-mode draft with leading whitespace still bypasses the idle-clear gate", (t) => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: scopedDoubleEscCancelConfigHome(t) });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	editor.setText("  !ls");
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	editor.handleInput("\x1b");
	assert.equal(aborted, 1, "Pi detects bash mode from the trimmed start of the text, so this gate must match the same rule");
	editor.dispose();
});

// ---------------------------------------------------------------------------
// /gentle:double-esc-cancel (issue #1163). Unlike /gentle:background-subagents,
// no argument toggles the effective policy rather than merely reporting it.
// ---------------------------------------------------------------------------

test("gentle:double-esc-cancel is registered and declares user-initiated sub-actions with a toggling no-argument form", () => {
	const { pi, commands } = fakePi();
	gentleShell(pi, {});
	const command = commands.get("gentle:double-esc-cancel");
	assert.ok(command, "gentle:double-esc-cancel must be registered");
	assert.match(command!.description ?? "", /status\|enable\|disable/);
	assert.match(command!.description ?? "", /no argument toggles/);
});

test("gentle:double-esc-cancel status reports off by default and writes nothing", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	await commands.get("gentle:double-esc-cancel")!.handler("status", ctx);
	assert.equal(ui.notices.length, 1);
	assert.match(ui.notices[0]!, /^double-esc-cancel: off \(decided by built-in default\)/);
	assert.equal(existsSync(join(configHome, "double-esc-cancel.json")), false);
});

test("gentle:double-esc-cancel enable writes the global file, reports it, and takes effect immediately", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	await commands.get("gentle:double-esc-cancel")!.handler("enable", ctx);
	assert.match(ui.notices[0]!, /^double-esc-cancel: on \(decided by global file/);
	assert.match(ui.notices[0]!, /Wrote on to the global file/);
	assert.deepEqual(
		JSON.parse(readFileSync(join(configHome, "double-esc-cancel.json"), "utf8")),
		{ schema: "gentle-pi.double-esc-cancel/v1", policy: "on" },
	);
});

test("gentle:double-esc-cancel disable writes off", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	await commands.get("gentle:double-esc-cancel")!.handler("enable", ctx);
	await commands.get("gentle:double-esc-cancel")!.handler("disable", ctx);
	assert.match(ui.notices[1]!, /^double-esc-cancel: off \(decided by global file/);
	assert.deepEqual(
		JSON.parse(readFileSync(join(configHome, "double-esc-cancel.json"), "utf8")),
		{ schema: "gentle-pi.double-esc-cancel/v1", policy: "off" },
	);
});

test("gentle:double-esc-cancel with no argument toggles the effective policy each time", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	await commands.get("gentle:double-esc-cancel")!.handler("", ctx);
	assert.match(ui.notices[0]!, /^double-esc-cancel: on /, "off -> on on the first toggle");
	await commands.get("gentle:double-esc-cancel")!.handler("", ctx);
	assert.match(ui.notices[1]!, /^double-esc-cancel: off /, "on -> off on the second toggle");
});

test("gentle:double-esc-cancel reports a malformed global file as fail-closed, not as an ordinary off", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	mkdirSync(configHome, { recursive: true });
	writeFileSync(join(configHome, "double-esc-cancel.json"), "{malformed");
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	await commands.get("gentle:double-esc-cancel")!.handler("status", ctx);
	assert.match(ui.notices[0]!, /present but malformed/);
});

test("gentle:double-esc-cancel an unknown sub-action warns and changes nothing", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	await commands.get("gentle:double-esc-cancel")!.handler("toggle", ctx);
	assert.match(ui.notices[0]!, /Unknown \/gentle:double-esc-cancel sub-action "toggle"/);
	assert.equal(existsSync(join(configHome, "double-esc-cancel.json")), false);
});

test("gentle:double-esc-cancel enable updates the in-memory policy so an already-installed prompt picks it up without re-reading the file", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	editor.handleInput("\x1b");
	assert.equal(aborted, 1, "off by default: the first Esc still aborts");
	await commands.get("gentle:double-esc-cancel")!.handler("enable", ctx);
	editor.handleInput("\x1b");
	assert.equal(aborted, 1, "now on: the same prompt instance must swallow the first Esc instead of aborting");
	assert.match(stripAnsi(editor.render(60).join("\n")), /esc again to cancel/);
	editor.dispose();
});

test("gentle:double-esc-cancel re-syncs the keypress gate from the global file so status, toggle direction, and Esc behavior agree", async (t) => {
	const configHome = scopedDoubleEscCancelConfigHome(t);
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: configHome });
	const { ctx, ui } = fakeContext();
	const editor = installedPrompt(ctx, ui, handlers, escapeKeybindings);
	let aborted = 0;
	editor.onEscape = () => { aborted++; };
	for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
	// Another session (or a hand edit) turns the preference on underneath this one.
	mkdirSync(configHome, { recursive: true });
	writeFileSync(join(configHome, "double-esc-cancel.json"), JSON.stringify({ schema: "gentle-pi.double-esc-cancel/v1", policy: "on" }));
	await commands.get("gentle:double-esc-cancel")!.handler("status", ctx);
	assert.match(ui.notices[0]!, /^double-esc-cancel: on \(decided by global file/);
	editor.handleInput("\x1b");
	assert.equal(aborted, 0, "status reported on, so the gate must swallow the first Esc rather than abort");
	assert.match(stripAnsi(editor.render(60).join("\n")), /esc again to cancel/);
	// The no-argument toggle flips relative to that same on-disk value: on -> off.
	await commands.get("gentle:double-esc-cancel")!.handler("", ctx);
	assert.match(ui.notices[1]!, /^double-esc-cancel: off /);
	assert.deepEqual(JSON.parse(readFileSync(join(configHome, "double-esc-cancel.json"), "utf8")), { schema: "gentle-pi.double-esc-cancel/v1", policy: "off" });
	editor.dispose();
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


// The changes overlay may ask Git for each captured root's HEAD label, and
// nothing else: no status, diff, numstat or worktree scan behind the user's
// back. Labelling is metadata, scanning is the behaviour these tests forbid.
const onlyHeadLabels = (git: readonly string[][]) => git.every((args) => {
 const command = args[0] === "-C" ? args.slice(2) : args;
 return command[0] === "symbolic-ref" || (command[0] === "rev-parse" && command.includes("--verify"));
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
 assert.ok(onlyHeadLabels(git), `overlay ran more than HEAD labelling: ${JSON.stringify(git)}`);
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
  assert.ok(onlyHeadLabels(git), `overlay ran more than HEAD labelling: ${JSON.stringify(git)}`);
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

// A generic hook: any extension can register a usage source for its own
// provider on `pi.events`, and gentle-shell dispatches to it exactly like it
// dispatches to the built-in Codex/NaN fetchers, without knowing the
// provider's name ahead of time.

function acmeSource(onFetch: (apiKey: string | undefined) => void, plan = "Acme cloud"): unknown {
	return {
		schema: USAGE_SOURCE_SCHEMA,
		provider: "acme-cloud",
		fetch: async (apiKey: string | undefined) => {
			onFetch(apiKey);
			return {
				provider: "acme-cloud",
				plan,
				limits: [{ name: "acme-cloud", windows: [{ label: "week", usedPercent: 40, windowSeconds: 604_800, resetAt: null }], limitReached: false }],
				fetchedAt: 0,
			};
		},
	};
}

test("gentleShell fetches usage through a source registered before session start", async () => {
	const { pi, handlers } = fakePi();
	const seen: Array<string | undefined> = [];
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { now: () => 1_788_600_000_000 });
	pi.events.emit(USAGE_SOURCE_EVENT, acmeSource((apiKey) => seen.push(apiKey)));
	const { ctx, ui } = fakeContext({ token: "acme-token" });
	(ctx as unknown as { model: { provider: string } }).model.provider = "acme-cloud";
	await fire(handlers, "session_start", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(seen, ["acme-token"], "the registered fetch gets the api key modelRegistry resolves for its provider");
	assert.match(renderFooter(ui), /acme-cloud week ▰▰▰▱▱▱▱▱ 40%/);
});

test("gentleShell forces one refresh when a usage source registers after session start for the active provider", async () => {
	const { pi, handlers } = fakePi();
	let calls = 0;
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { now: () => 1_788_600_000_000 });
	const { ctx, ui } = fakeContext({ token: "acme-token" });
	(ctx as unknown as { model: { provider: string } }).model.provider = "acme-cloud";
	await fire(handlers, "session_start", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.doesNotMatch(renderFooter(ui), /acme-cloud/, "no source registered yet, nothing to show");

	pi.events.emit(USAGE_SOURCE_EVENT, acmeSource(() => { calls += 1; }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(calls, 1, "late registration for the active provider triggers one forced refresh, not a wait for the next turn");
	assert.match(renderFooter(ui), /acme-cloud week ▰▰▰▱▱▱▱▱ 40%/);
});

test("a usage source registered for a different provider does not force a refresh", async () => {
	const { pi, handlers } = fakePi();
	let calls = 0;
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { now: () => 1_788_600_000_000 });
	const { ctx, ui } = fakeContext({ token: "acme-token" });
	(ctx as unknown as { model: { provider: string } }).model.provider = "openai-codex";
	await fire(handlers, "session_start", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));

	pi.events.emit(USAGE_SOURCE_EVENT, acmeSource(() => { calls += 1; }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(calls, 0, "the active provider is codex, so an acme-cloud registration fetches nothing yet");
	assert.doesNotMatch(renderFooter(ui), /acme-cloud/);
});

test("gentleShell shows the unsupported note for a provider with no built-in or registered source", async () => {
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { now: () => 1_788_600_000_000 });
	const { ctx, ui } = fakeContext({ token: undefined });
	(ctx as unknown as { model: { provider: string } }).model.provider = "acme-cloud";
	await fire(handlers, "session_start", ctx);
	const opened = commands.get("gentle:usage")!.handler("", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const plain = ui.overlayView!.render(90).map(stripAnsi);
	assert.match(plain[1], /✿ acme-cloud · no subscription usage for this provider/);
	ui.closeOverlay?.();
	await opened;
});

test("gentleShell ignores a malformed usage-source registration payload", async () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { now: () => 1_788_600_000_000 });
	pi.events.emit(USAGE_SOURCE_EVENT, { schema: "wrong-schema", provider: "acme-cloud", fetch: async () => undefined });
	pi.events.emit(USAGE_SOURCE_EVENT, { schema: USAGE_SOURCE_SCHEMA, provider: "acme-cloud", fetch: "not-a-function" });
	pi.events.emit(USAGE_SOURCE_EVENT, "not-an-object");
	pi.events.emit(USAGE_SOURCE_EVENT, undefined);
	const { ctx, ui } = fakeContext({ token: undefined });
	(ctx as unknown as { model: { provider: string } }).model.provider = "acme-cloud";
	await fire(handlers, "session_start", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.doesNotMatch(renderFooter(ui), /acme-cloud/, "no malformed payload registered a usable source");
});

// A registered source is foreign code running inside a fire-and-forget
// refresh (`void refreshUsage(...)`, both at session_start and on a late
// registration): if its fetch rejects and nothing catches it, the rejection
// is unhandled and, under Node's default policy, takes the whole process
// down. The doc promises a foreign source is "ignored rather than crashing
// the shell", so a throw must degrade exactly like a built-in fetcher's.
test("a registered source's rejecting fetch never crashes the shell or poisons the store", async () => {
	const { pi, handlers, commands } = fakePi();
	let calls = 0;
	const rejectingSource = () => ({
		schema: USAGE_SOURCE_SCHEMA,
		provider: "acme-cloud",
		fetch: async () => {
			calls += 1;
			throw new Error("acme is down");
		},
	});
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { now: () => 1_788_600_000_000 });
	const { ctx, ui } = fakeContext({ token: "acme-token" });
	(ctx as unknown as { model: { provider: string } }).model.provider = "acme-cloud";

	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		// Registered before session start: session_start's own fire-and-forget
		// refresh dispatches straight to the rejecting fetch.
		pi.events.emit(USAGE_SOURCE_EVENT, rejectingSource());
		await fire(handlers, "session_start", ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(calls, 1);
		assert.doesNotMatch(renderFooter(ui), /acme-cloud/, "a rejecting fetch must never be recorded as a snapshot");

		// A second, late registration for the already-active provider dispatches
		// through the USAGE_SOURCE_EVENT handler's own fire-and-forget refresh.
		pi.events.emit(USAGE_SOURCE_EVENT, rejectingSource());
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(calls, 2);
		assert.doesNotMatch(renderFooter(ui), /acme-cloud/);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	assert.deepEqual(unhandled, [], "a foreign source's rejection must never surface as an unhandled rejection");

	// The panel still explains itself with the pending note, never a crash,
	// even through the awaited refresh openUsage runs on open.
	const opened = commands.get("gentle:usage")!.handler("", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const plain = ui.overlayView!.render(90).map(stripAnsi);
	assert.match(plain[1], /✿ acme-cloud · no usage yet · r to fetch/);
	ui.closeOverlay?.();
	await opened;
});

// A registered source's resolved value is foreign code's own object: it must
// be validated like any other parsed payload (never trusted to name the
// provider it actually is, never trusted to be well-formed), and a source
// that gets replaced mid-flight must never let its late, stale answer land
// after the replacement already recorded its own.

test("a registered source resolving usage for another provider is rejected without overwriting that provider's snapshot", async () => {
	const { pi, handlers } = fakePi();
	const { fetchFn } = fakeFetch(NAN_QUOTA_PAYLOAD);
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { fetch: fetchFn, now: () => 1_788_600_000_000 });
	const { ctx, ui } = fakeContext({ token: "sk-nan-secret" });
	(ctx as unknown as { model: { provider: string } }).model.provider = "nan";
	await fire(handlers, "session_start", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.match(renderFooter(ui), /nan total ▰+▱+/, "the real nan snapshot recorded first");

	(ctx as unknown as { model: { provider: string } }).model.provider = "acme-cloud";
	pi.events.emit(USAGE_SOURCE_EVENT, {
		schema: USAGE_SOURCE_SCHEMA,
		provider: "acme-cloud",
		fetch: async () => ({ provider: "nan", plan: undefined, limits: [], fetchedAt: 0 }),
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.doesNotMatch(renderFooter(ui), /acme-cloud/, "a resolution naming another provider must not surface as the active one");

	(ctx as unknown as { model: { provider: string } }).model.provider = "nan";
	assert.match(renderFooter(ui), /nan total ▰+▱+/, "the real nan snapshot must survive a mismatched acme-cloud resolution untouched");
});

test("gentleShell leaves the pending note when a registered source resolves a malformed usage", async () => {
	const { pi, handlers, commands } = fakePi();
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { now: () => 1_788_600_000_000 });
	pi.events.emit(USAGE_SOURCE_EVENT, {
		schema: USAGE_SOURCE_SCHEMA,
		provider: "acme-cloud",
		fetch: async () => ({ provider: "acme-cloud", plan: "Acme", fetchedAt: 0, limits: "nope" }),
	});
	const { ctx, ui } = fakeContext({ token: "acme-token" });
	(ctx as unknown as { model: { provider: string } }).model.provider = "acme-cloud";
	await fire(handlers, "session_start", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.doesNotMatch(renderFooter(ui), /acme-cloud/, "a malformed result must never be recorded");

	const opened = commands.get("gentle:usage")!.handler("", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const plain = ui.overlayView!.render(90).map(stripAnsi);
	assert.match(plain[1], /✿ acme-cloud · no usage yet · r to fetch/);
	ui.closeOverlay?.();
	await opened;
});

test("a slow fetch from a replaced source never records after its replacement resolves", async () => {
	const { pi, handlers } = fakePi();
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { now: () => 1_788_600_000_000 });
	const { ctx, ui } = fakeContext({ token: "acme-token" });
	(ctx as unknown as { model: { provider: string } }).model.provider = "acme-cloud";

	let resolveSlow!: (value: unknown) => void;
	const slow = new Promise((resolve) => { resolveSlow = resolve; });
	pi.events.emit(USAGE_SOURCE_EVENT, {
		schema: USAGE_SOURCE_SCHEMA,
		provider: "acme-cloud",
		fetch: async () => {
			await slow;
			return { provider: "acme-cloud", plan: "Stale", fetchedAt: 0, limits: [{ name: "acme-cloud", limitReached: false, windows: [{ label: "week", usedPercent: 10, windowSeconds: 604_800, resetAt: null }] }] };
		},
	});
	await fire(handlers, "session_start", ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.doesNotMatch(renderFooter(ui), /acme-cloud/, "the slow fetch has not resolved yet");

	// Replace the source before the slow fetch resolves; the late registration
	// forces its own refresh, which resolves immediately.
	pi.events.emit(USAGE_SOURCE_EVENT, {
		schema: USAGE_SOURCE_SCHEMA,
		provider: "acme-cloud",
		fetch: async () => ({ provider: "acme-cloud", plan: "Fresh", fetchedAt: 0, limits: [{ name: "acme-cloud", limitReached: false, windows: [{ label: "week", usedPercent: 40, windowSeconds: 604_800, resetAt: null }] }] }),
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.match(renderFooter(ui), /acme-cloud week ▰▰▰▱▱▱▱▱ 40%/, "the replacement's own refresh recorded first");

	// Now let the stale fetch resolve; it must never overwrite the fresh record.
	resolveSlow(undefined);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.match(renderFooter(ui), /acme-cloud week ▰▰▰▱▱▱▱▱ 40%/, "the stale refresh must never record after being replaced");
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

test("usageShortcut defaults to alt+u and can be overridden or disabled", () => {
	assert.equal(usageShortcut({}), "alt+u");
	assert.equal(usageShortcut({ GENTLE_PI_SHELL_USAGE_KEY: "ctrl+shift+u" }), "ctrl+shift+u");
	assert.equal(usageShortcut({ GENTLE_PI_SHELL_USAGE_KEY: "off" }), undefined);
	assert.equal(usageShortcut({ GENTLE_PI_SHELL_USAGE_KEY: "" }), undefined);
});

test("gentleShell binds the usage shortcut to the same handler as /gentle:usage", async () => {
	const { pi, handlers, shortcuts } = fakePi();
	gentleShell(pi, { GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, { fetch: fakeFetch().fetchFn, now: () => 1_788_600_000_000 });
	const { ctx, ui } = fakeContext({ token: JWT });
	await fire(handlers, "session_start", ctx);
	const shortcut = shortcuts.get("alt+u");
	assert.ok(shortcut, "alt+u not registered");
	const opened = shortcut.handler(ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const plain = ui.overlayView!.render(90).map(stripAnsi);
	assert.match(plain[0], /Subscriptions/);
	ui.closeOverlay?.();
	await opened;

	const silent = fakePi();
	gentleShell(silent.pi, { GENTLE_PI_SHELL_USAGE_KEY: "off" });
	assert.equal(silent.shortcuts.has("alt+u"), false, "the usage shortcut must not register when disabled");
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

test("the review preflight card paints the rose INFO frame (border) and title (accent)", () => {
	const { pi } = fakePi();
	gentleShell(pi, {});
	const renderer = renderers.get("gentle-pi.review-preflight")!;
	const taggedTheme = { ...plainTheme, fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
	const message = { customType: "gentle-pi.review-preflight", content: "Receipt-driven development is enabled." };
	const lines = renderer(message, { expanded: true }, taggedTheme).render(60);
	assert.match(lines[0]!, /^<border>╭<\/border>/);
	assert.match(lines[0]!, /<accent>✿ Gentle AI<\/accent>/);
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
