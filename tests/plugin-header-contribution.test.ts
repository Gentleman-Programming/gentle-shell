import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	CONTRACT_VERSION,
	CONTRIBUTIONS,
	contributionSlot,
	readContributionReport,
	readContributions,
} from "../lib/plugin-contract.ts";
import type { Contribution, PluginHeaderContext } from "../lib/plugin-contract.ts";
import { DEFAULT_VISUAL_SETTINGS, writeVisualSettings } from "../lib/visual-customization-policy.ts";
import { sidebarState } from "../lib/shell-sidebar.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import gentleShell from "../extensions/gentle-shell.ts";

// Canary for the header read point: contributed rows are appended after the
// core header rows in every placement, never in place of them. The core header
// keeps its own surface; there is no way for a plugin to replace it.

const HEADER_WIDGET_KEY = "gentle-shell-below-input-header";
const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const plainTheme = {
	name: "plain",
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_color: string, text: string) => text,
	getBgAnsi: () => "",
};

function reset(): void {
	delete (globalThis as unknown as { [key: symbol]: unknown })[CONTRIBUTIONS];
}

function install(contributions: Record<string, unknown>): void {
	contributionSlot();
	for (const [key, value] of Object.entries(contributions)) contributionSlot().set(key, value as Contribution);
}

interface Harness {
	/** The rows the real header paints at this width, through the mode's own surface. */
	headerRows(width: number): string[];
	notices: string[];
	tui: { mode: string; terminal: { rows: number; columns: number }; requestRender(): void };
}

/**
 * Boots the real extension with one persisted placement, so the header is
 * driven through the same widget or rail a session paints.
 */
async function harness(t: test.TestContext, placement: "top" | "below-input" | "split"): Promise<Harness> {
	const home = mkdtempSync(join(tmpdir(), "gentle-plugin-header-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	writeVisualSettings(
		{ ...DEFAULT_VISUAL_SETTINGS, headerPlacement: placement, statusPlacement: "hidden" },
		{ gentlePiConfigHome: home },
	);
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const notices: string[] = [];
	const widgets = new Map<string, unknown>();
	let footerFactory: unknown;
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		events: { on: () => () => {}, emit: () => {} },
		registerCommand() {},
		registerShortcut() {},
		registerTool() {},
		registerMessageRenderer() {},
		appendEntry() {},
		getThinkingLevel: () => "medium",
		getCommands: () => [],
		sendUserMessage() {},
		async exec() {
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;
	const ui = {
		theme: plainTheme,
		getAllThemes: () => [{ name: "plain" }],
		getTheme: (name: string) => (name === "plain" ? { name: "plain" } : undefined),
		setTheme: () => ({ success: true }),
		notify(message: string) {
			notices.push(message);
		},
		setFooter(factory: unknown) {
			footerFactory = factory;
		},
		setWidget(key: string, content: unknown) {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, content);
		},
		setWorkingVisible() {},
		setEditorComponent() {},
		getEditorComponent() {
			return undefined;
		},
		custom() {
			return new Promise<null>(() => {});
		},
	};
	const ctx = {
		cwd: home,
		mode: "tui",
		hasUI: true,
		model: { id: "gpt-5.5", provider: "openai-codex", reasoning: true, contextWindow: 272_000 },
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 100, contextWindow: 272_000, percent: 45 }),
		sessionManager: {
			getCwd: () => home,
			getSessionName: () => "Header",
			getEntries: () => [],
			getSessionId: () => "plugin-header-session",
		},
		modelRegistry: { isUsingOAuth: () => true, getApiKeyForProvider: async () => undefined },
		ui,
	} as unknown as ExtensionContext;
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home, GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, {
		activeProfile: () => undefined,
		fetch: async () => {
			throw new Error("network disabled");
		},
		devBinary: () => undefined,
		resolveWorktree: () => ({ root: home, commonDir: home }),
		gitRunner: () => async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		rootExists: () => true,
	});
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	const root = { render: () => ["transcript"], invalidate() {}, [NODE]: () => ({ type: "vstack", entries: [] }) };
	const tui = { mode: "fullscreen", terminal: { rows: 40, columns: 160 }, layoutRoot: root, requestRender() {} };
	const footer = (footerFactory as (host: unknown, theme: unknown, data: unknown) => { dispose(): void })(tui, plainTheme, {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	});
	t.after(() => footer.dispose());
	const headerRows = (width: number): string[] =>
		placement === "below-input"
			? (widgets.get(HEADER_WIDGET_KEY) as () => { render(width: number): string[] })().render(width)
			: sidebarState(tui as unknown as TUI).parts.get("header")!.render(width);
	return { headerRows, notices, tui };
}

test("a contributed header row appears after the core header rows, and an empty row stays blank", async (t) => {
	reset();
	t.after(reset);
	install({
		"acme.banner": {
			id: "acme.banner",
			owner: "acme",
			contract: CONTRACT_VERSION,
			header: { rows: ["", "acme: all systems nominal"] },
		},
	});
	const f = await harness(t, "top");
	const rows = f.headerRows(160).map(stripAnsi);
	assert.ok(rows.length >= 3, `the core header still paints: ${rows.join("\n")}`);
	assert.equal(rows.at(-2), "", "an empty contributed row is a blank line");
	assert.equal(rows.at(-1), "acme: all systems nominal");
});

test("the rows function receives the live width and the placement each mode uses", async (t) => {
	for (const placement of ["top", "below-input", "split"] as const) {
		reset();
		const seen: PluginHeaderContext[] = [];
		install({
			"acme.probe": {
				id: "acme.probe",
				owner: "acme",
				contract: CONTRACT_VERSION,
				header: {
					rows: (context: PluginHeaderContext) => {
						seen.push(context);
						return [`acme probe ${context.placement}`];
					},
				},
			},
		});
		const f = await harness(t, placement);
		const rows = f.headerRows(133).map(stripAnsi);
		const core = f.headerRows(133).map(stripAnsi);
		assert.equal(rows.at(-1), `acme probe ${placement}`, `${placement}: the contributed row paints last\n${rows.join("\n")}`);
		assert.deepEqual(core.at(-1), `acme probe ${placement}`);
		assert.deepEqual(seen, [
			{ width: 133, placement },
			{ width: 133, placement },
		], `${placement}: the function is called on each render with the live context`);
		assert.ok(seen.every((context) => context.width > 0));
	}
	reset();
});

test("a throwing rows function adds nothing and is reported once", async (t) => {
	reset();
	t.after(reset);
	install({
		"acme.broken": {
			id: "acme.broken",
			owner: "acme",
			contract: CONTRACT_VERSION,
			header: {
				rows: () => {
					throw new Error("header exploded");
				},
			},
		},
	});
	const f = await harness(t, "split");
	const withThrower = f.headerRows(160);
	assert.ok(f.headerRows(160).length > 0, "the core header still paints");
	reset();
	const withoutContribution = f.headerRows(160);
	assert.deepEqual(withThrower, withoutContribution, "a throwing rows function contributes no rows");
	assert.deepEqual(f.notices, ["Plugin acme.broken: header exploded"], "one report per contribution, not per frame");
});

test("a header with a non-string row is refused as malformed-header while its customize rows still load", () => {
	reset();
	install({
		"acme.mixed": {
			id: "acme.mixed",
			owner: "acme",
			contract: CONTRACT_VERSION,
			header: { rows: ["fine", 7] },
			rows: [{ category: "Acme", label: "Still here", action() {} }],
		},
		"acme.empty": {
			id: "acme.empty",
			owner: "acme",
			contract: CONTRACT_VERSION,
			header: { rows: ["", "blank line"] },
		},
	});
	const loaded = readContributions();
	assert.deepEqual(loaded.map((entry) => entry.id), ["acme.mixed", "acme.empty"]);
	assert.equal(loaded[0].header, undefined, "the malformed header is dropped, not repaired");
	assert.deepEqual(loaded[0].rows?.map((row) => row.label), ["Still here"], "the other payloads of the same contribution load");
	assert.deepEqual(loaded[1].header?.rows, ["", "blank line"], "empty string rows are allowed");
	assert.deepEqual(
		readContributionReport().skipped.map((issue) => [issue.id, issue.code]),
		[["acme.mixed", "malformed-header"]],
	);
	reset();
});

test("an empty box appends no header rows", async (t) => {
	reset();
	t.after(reset);
	// A contribution that declares only customize rows paints no header row, so
	// the box with an unrelated payload and the empty box paint identically.
	install({
		"acme.rows": {
			id: "acme.rows",
			owner: "acme",
			contract: CONTRACT_VERSION,
			rows: [{ category: "Acme", label: "Row", action() {} }],
		},
	});
	const f = await harness(t, "below-input");
	const withUnrelated = f.headerRows(160);
	reset();
	assert.deepEqual(f.headerRows(160), withUnrelated);
	assert.ok(withUnrelated.length > 0, "the core header rows still paint");
});

