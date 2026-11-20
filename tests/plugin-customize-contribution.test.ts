import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleShell, { appendPluginCustomizeRows } from "../extensions/gentle-shell.ts";
import type { CustomizeRow } from "../lib/visual-customize-view.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The same process-wide, versioned key a third-party Pi package reaches with
// `Symbol.for`; this canary acts as a plugin and installs a plain `Map`.
const CONTRIBUTIONS = Symbol.for("gentle-pi.contributions/v1");

const slot = () => globalThis as unknown as Record<symbol, unknown>;

function installContributions(contributions: Record<string, unknown>): void {
	slot()[CONTRIBUTIONS] = new Map(Object.entries(contributions));
}

function clearContributions(): void {
	delete slot()[CONTRIBUTIONS];
}

interface OverlayView {
	render(width: number): string[];
	handleInput(data: string): void;
	focus(label: string): boolean;
}

interface Harness {
	open(): Promise<OverlayView>;
	close(): Promise<void>;
	notices: string[];
	home: string;
}

/** Drives the real `/gentle:customize` command, the only entry point that builds rows. */
function harness(t: test.TestContext): Harness {
	const home = mkdtempSync(join(tmpdir(), "plugin-customize-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const notices: string[] = [];
	let resolveView: ((view: OverlayView) => void) | undefined;
	const viewReady = new Promise<OverlayView>((resolve) => { resolveView = resolve; });
	const theme = {
		name: "plain",
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		getBgAnsi: () => "",
	};
	const pi = {
		events: { on: () => () => {}, emit: () => {} },
		on() {},
		registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) { commands.set(name, command); },
		registerShortcut() {},
		registerTool() {},
		registerMessageRenderer() {},
		getThinkingLevel: () => "medium",
		getCommands: () => [],
		sendUserMessage() {},
		async exec() { return { stdout: "", stderr: "", code: 0, killed: false }; },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: home,
		mode: "tui",
		hasUI: true,
		sessionManager: { getSessionId: () => "plugin-customize-session", getCwd: () => home, getEntries: () => [] },
		ui: {
			theme,
			getAllThemes: () => [{ name: "plain" }],
			getTheme: (name: string) => name === "plain" ? { name: "plain" } : undefined,
			setTheme: () => ({ success: true }),
			notify(message: string) { notices.push(message); },
			custom(factory: (tui: unknown, viewTheme: unknown, keys: unknown, done: () => void) => OverlayView) {
				return new Promise<null>((resolve) => {
					resolveView?.(factory({ requestRender() {}, terminal: { rows: 40 } }, theme, {}, () => resolve(null)));
				});
			},
		},
	} as unknown as ExtensionContext;
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home, GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, {
		activeProfile: () => undefined,
		fetch: async () => { throw new Error("network disabled"); },
		devBinary: () => undefined,
		resolveWorktree: () => ({ root: home, commonDir: home }),
		gitRunner: () => async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		rootExists: () => true,
	});
	let view: OverlayView | undefined;
	let pending: Promise<void> | undefined;
	return {
		home,
		notices,
		async open() {
			pending = commands.get("gentle:customize")!.handler("", ctx);
			view = await viewReady;
			return view;
		},
		async close() {
			view?.handleInput("\x1b");
			await pending;
		},
	};
}

function text(view: OverlayView): string {
	return view.render(120).map(stripAnsi).join("\n");
}

test("a contributed row is appended after every built-in customize row", async (t) => {
	const calls: unknown[][] = [];
	installContributions({
		"ext.demo": {
			id: "ext.demo",
			owner: "ext",
			contract: 1,
			rows: [
				{ category: "Animations", label: "Ext: demo switch", action: (...args: unknown[]) => { calls.push(args); } },
				{ category: "Demo", label: "Ext: custom category", action: (...args: unknown[]) => { calls.push(args); } },
			],
		},
	});
	t.after(clearContributions);
	const h = harness(t);
	const before = readdirSync(h.home).sort();
	// The adapter is the seam the command uses: it must append and never replace.
	const builtIn: CustomizeRow = { category: "Animations", label: "Built-in row", action() {} };
	const rows: CustomizeRow[] = [builtIn];
	appendPluginCustomizeRows(rows, () => {});
	assert.equal(rows[0], builtIn, "no built-in row is replaced or reordered");
	assert.equal(rows.length, 3, "every contributed row is appended");
	assert.equal(typeof rows[1]!.label === "function" ? rows[1]!.label() : rows[1]!.label, "Ext: demo switch");
	assert.equal(rows[2]!.category, "Demo", "a contributed category name typechecks");
	const view = await h.open();
	try {
		assert.equal(view.focus("Ext: demo switch"), true, "the contributed row reaches the panel");
		const lines = view.render(120).map(stripAnsi);
		const settingLine = lines.findIndex((line) => line.includes("▸ Animations"));
		const pluginLine = lines.findIndex((line) => line.includes("Ext: demo switch"));
		assert.ok(settingLine >= 0, "the built-in setting line still renders");
		assert.match(lines[settingLine]!, /● quality\s+○ performance\s+○ potato/, "no built-in value is replaced or reordered");
		assert.ok(pluginLine > settingLine, "contributed rows come after the built-in ones");
		assert.equal(view.focus("Ext: custom category"), true, "a contributed category name is accepted");
		const nav = view.render(120).map(stripAnsi)
			.map((line) => line.split("│"))
			.filter((parts) => parts.length === 4)
			.map((parts) => parts[1]!);
		assert.ok(nav.length > 1, "the category column renders");
		assert.match(nav.at(-1)!, /Demo/, "the contributed category is appended after the built-ins");
		assert.match(nav.at(-2)!, /Reset/, "the built-in categories keep their order and place");
		assert.equal(view.focus("Ext: demo switch"), true);
		view.render(120);
		view.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, [[]], "the plugin action runs untouched, with no internal bridge");
		assert.deepEqual(readdirSync(h.home).sort(), before, "a plugin action never writes gentle-pi preferences");
	} finally { await h.close(); }
});

test("an empty contribution box leaves the built-in rows exactly as they are", async (t) => {
	installContributions({});
	t.after(clearContributions);
	const h = harness(t);
	// No-op proof: with an empty box the adapter adds nothing at all.
	const builtIn: CustomizeRow = { category: "Animations", label: "Built-in row", action() {} };
	const rows: CustomizeRow[] = [builtIn];
	appendPluginCustomizeRows(rows, () => {});
	assert.deepEqual(rows, [builtIn], "an empty box leaves the built-in rows exactly as they are");
	const view = await h.open();
	try {
		assert.equal(view.focus("Ext: demo switch"), false, "an empty box adds no row");
		const frame = text(view);
		assert.match(frame, /▸ Animations\s+● quality/, "the built-in rows still render");
		assert.ok(!frame.includes("Demo"), "an empty box adds no category");
	} finally { await h.close(); }
});

test("a contributed row whose label throws is dropped without breaking the others", async (t) => {
	installContributions({
		"ext.broken": {
			id: "ext.broken",
			owner: "ext",
			contract: 1,
			rows: [
				{ category: "Demo", label: () => { throw new Error("plugin label exploded"); }, action: () => {} },
				{ category: "Demo", label: "Ext: healthy row", action: () => {} },
			],
		},
	});
	t.after(clearContributions);
	const h = harness(t);
	const view = await h.open();
	try {
		assert.equal(view.focus("Ext: healthy row"), true, "a healthy sibling row still reaches the panel");
		const frame = text(view);
		assert.ok(frame.includes("Ext: healthy row"), "the healthy row renders");
		assert.ok(!frame.includes("Plugin row"), "the throwing row is dropped, not shown with a fallback label");
		assert.ok(h.notices.some((notice) => notice.includes("ext.broken")), "the rejection is reported");
		assert.equal(view.focus("Animations: quality"), true, "the panel still works after a broken plugin");
	} finally { await h.close(); }
});
