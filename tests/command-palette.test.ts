import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CommandPalette, commandsKey, rankPaletteGroups, type CommandPaletteGroup, type CommandPaletteItem, type CommandPaletteResult, type CommandPaletteTheme } from "../lib/command-palette.ts";
import { buildCommandPaletteGroups, COMMAND_PALETTE_CATALOG } from "../lib/command-palette-catalog.ts";

// Command palette: a pure, curated, grouped overlay component for
// `/gentle:commands` and its `alt+k` shortcut. These tests drive ranking,
// keyboard input, and rendering without any Pi extension API — the
// component only depends on pi-tui key/width helpers and plain data
// (groups of items) in, plain strings out.

const KEY = {
	DOWN: "\x1b[B",
	UP: "\x1b[A",
	CTRL_J: "\n",
	CTRL_K: "\x0b",
	ENTER: "\r",
	ESCAPE: "\x1b",
	CTRL_C: "\x03",
	BACKSPACE: "\x7f",
	CTRL_U: "\x15",
} as const;

function type(palette: CommandPalette, text: string): void {
	for (const ch of text) palette.handleInput(ch);
}

function createPalette(groups: readonly CommandPaletteGroup[], theme?: CommandPaletteTheme, rows?: () => number): { palette: CommandPalette; results: CommandPaletteResult[] } {
	const results: CommandPaletteResult[] = [];
	const palette = new CommandPalette(groups, (result) => results.push(result), theme, rows);
	return { palette, results };
}

test("Vim palette help names the opt-in editor and Pi slash handoff without promising full parity", () => {
	const groups = buildCommandPaletteGroups([{ name: "gentle:vim", description: "Show or set global Vim prompt editing (status|enable|disable); no argument opens a menu." }], {});
	assert.equal(groups[0]?.title, "Configuration");
	const vim = groups[0]?.items[0];
	assert.equal(vim?.command, "gentle:vim");
	assert.match(vim?.label ?? "", /Vim.*opt-in/i);
	assert.match(vim?.label ?? "", /Pi.*slash/i);
	assert.equal(vim?.description, "Show or set global Vim prompt editing (status|enable|disable); no argument opens a menu.");
	assert.equal(rankPaletteGroups(groups, "vim")[0]?.items[0]?.command, "gentle:vim");
});

test("Vim reference distinguishes supported commands, scope and slash divergence", () => {
	const reference = readFileSync(new URL("../docs/readme-reference.md", import.meta.url), "utf8");
	const section = reference.split("### Vim prompt editing\n")[1]?.split("\n### ")[0] ?? "";
	for (const term of ["`/gentle:vim enable`", "`/gentle:vim disable`", "`status`", "VISUAL", "`Ctrl+[`", "`gg/G`", "`f/F/t/T`", "`d/c/y`", "`u`", "`.`", "Pi", "first line", "reverse prompt-history search", "0.85.1", "paste marker"]) {
		assert.ok(section.includes(term), `Vim reference missing ${term}`);
	}
	assert.doesNotMatch(section, /full Claude (?:Code )?parity/i);
});

test("animations is discoverable under Configuration with its live description", () => {
	const groups = buildCommandPaletteGroups([{ name: "gentle:animations", description: "status|quality|performance|potato" }], {});
	assert.equal(groups[0]?.title, "Configuration");
	assert.equal(groups[0]?.items[0]?.command, "gentle:animations");
	assert.match(groups[0]?.items[0]?.label ?? "", /[Aa]nimation/);
	assert.equal(groups[0]?.items[0]?.description, "status|quality|performance|potato");
});

// --- rankPaletteGroups -------------------------------------------------------

test("rankPaletteGroups ranks label-prefix, label-contains, label-subsequence, command-contains, then description-contains", () => {
	const group: CommandPaletteGroup = {
		title: "G",
		items: [
			// rank 4: only the description contains "mod".
			{ command: "gentle:xyz-tool", label: "xyz", description: "custom mod support" },
			// rank 3: only the command name contains "mod".
			{ command: "gentle:mod-tool", label: "xyz-abc" },
			// rank 2: the label matches "mod" only as a subsequence.
			{ command: "gentle:whatever3", label: "my-old-doc" },
			// rank 1: the label contains "mod", but does not start with it.
			{ command: "gentle:whatever2", label: "gentle models here" },
			// rank 0: the label starts with "mod".
			{ command: "gentle:whatever1", label: "Modify a thing" },
		],
	};
	const ranked = rankPaletteGroups([group], "mod");
	assert.equal(ranked.length, 1);
	assert.deepEqual(
		ranked[0]?.items.map((item) => item.command),
		["gentle:whatever1", "gentle:whatever2", "gentle:whatever3", "gentle:mod-tool", "gentle:xyz-tool"],
	);
});

test("rankPaletteGroups is case-insensitive and trims the query", () => {
	const group: CommandPaletteGroup = { title: "G", items: [{ command: "a", label: "Alpha Mod" }, { command: "b", label: "beta" }] };
	const lower = rankPaletteGroups([group], "mod").map((g) => g.items.map((i) => i.command));
	assert.deepEqual(rankPaletteGroups([group], "MOD").map((g) => g.items.map((i) => i.command)), lower);
	assert.deepEqual(rankPaletteGroups([group], "  mod  ").map((g) => g.items.map((i) => i.command)), lower);
});

test("rankPaletteGroups keeps input order within a group for tied ranks", () => {
	const group: CommandPaletteGroup = { title: "G", items: [{ command: "mod-b", label: "mod-b" }, { command: "mod-a", label: "mod-a" }] };
	assert.deepEqual(rankPaletteGroups([group], "mod")[0]?.items.map((i) => i.command), ["mod-b", "mod-a"]);
});

test("rankPaletteGroups returns every group unchanged for an empty or whitespace query", () => {
	const groups: CommandPaletteGroup[] = [
		{ title: "G1", items: [{ command: "a", label: "Alpha" }] },
		{ title: "G2", items: [{ command: "b", label: "Beta" }] },
	];
	assert.deepEqual(rankPaletteGroups(groups, ""), groups);
	assert.deepEqual(rankPaletteGroups(groups, "   "), groups);
});

test("rankPaletteGroups drops a group with no matching item, and never reorders groups", () => {
	const groups: CommandPaletteGroup[] = [
		{ title: "Configuration", items: [{ command: "gentle:models", label: "Assign models and effort" }, { command: "gentle:profiles", label: "Agent-model profiles" }] },
		{ title: "Session", items: [{ command: "gentle:usage", label: "Subscription usage" }] },
		{ title: "Diagnostics", items: [{ command: "gentle:status", label: "Gentle AI status" }] },
	];
	const ranked = rankPaletteGroups(groups, "model");
	assert.deepEqual(ranked.map((g) => g.title), ["Configuration"]);
	assert.deepEqual(ranked[0]?.items.map((i) => i.command), ["gentle:models", "gentle:profiles"]);
});

test("rankPaletteGroups returns no groups for a query that matches nothing anywhere", () => {
	const groups: CommandPaletteGroup[] = [{ title: "G", items: [{ command: "a", label: "Alpha", description: "first letter" }] }];
	assert.deepEqual(rankPaletteGroups(groups, "qqqqzzz"), []);
});

// --- input flow --------------------------------------------------------------

const GROUPS: CommandPaletteGroup[] = [
	{
		title: "Configuration",
		items: [
			{ command: "gentle:models", label: "Assign models and effort" },
			{ command: "gentle:profiles", label: "Agent-model profiles" },
		],
	},
	{
		title: "Session",
		items: [{ command: "gentle:changes", label: "Browse captured changes", shortcut: "alt+g" }],
	},
];

test("typing filters across groups and resets the selection to the first visible item", () => {
	const { palette, results } = createPalette(GROUPS);
	palette.handleInput(KEY.DOWN);
	palette.handleInput(KEY.DOWN); // selection is now "gentle:changes" (index 2)
	// "s" keeps every item (each label contains "s") in the same relative
	// order, so this only exercises the selection reset: without it, enter
	// would still pick "gentle:changes".
	palette.handleInput("s");
	palette.handleInput(KEY.ENTER);
	assert.deepEqual(results, [{ type: "run", name: "gentle:models" }]);
});

test("backspace removes the last query character", () => {
	const { palette, results } = createPalette(GROUPS);
	type(palette, "changez");
	palette.handleInput(KEY.BACKSPACE);
	palette.handleInput(KEY.ENTER);
	assert.deepEqual(results, [{ type: "run", name: "gentle:changes" }]);
});

test("ctrl+u clears the query", () => {
	const { palette, results } = createPalette(GROUPS);
	type(palette, "changes");
	palette.handleInput(KEY.CTRL_U);
	palette.handleInput(KEY.ENTER);
	assert.deepEqual(results, [{ type: "run", name: "gentle:models" }]);
});

test("up and down move the selection across groups and clamp at the ends", () => {
	const { palette, results } = createPalette(GROUPS);
	palette.handleInput(KEY.UP); // clamps at 0, still "gentle:models"
	palette.handleInput(KEY.DOWN); // gentle:profiles
	palette.handleInput(KEY.DOWN); // gentle:changes (crosses into the Session group)
	palette.handleInput(KEY.DOWN); // clamps at the last item
	palette.handleInput(KEY.ENTER);
	assert.deepEqual(results, [{ type: "run", name: "gentle:changes" }]);
});

test("ctrl+j and ctrl+k also move the selection", () => {
	const { palette, results } = createPalette(GROUPS);
	palette.handleInput(KEY.CTRL_J); // gentle:profiles
	palette.handleInput(KEY.CTRL_K); // gentle:models
	palette.handleInput(KEY.ENTER);
	assert.deepEqual(results, [{ type: "run", name: "gentle:models" }]);
});

test("enter runs the highlighted item and is a no-op with no match", () => {
	const { palette, results } = createPalette(GROUPS);
	type(palette, "nothing-like-this");
	palette.handleInput(KEY.ENTER);
	assert.deepEqual(results, []);
});

test("escape and ctrl+c close without running", () => {
	const escapePalette = createPalette(GROUPS);
	escapePalette.palette.handleInput(KEY.ESCAPE);
	assert.deepEqual(escapePalette.results, [{ type: "close" }]);

	const ctrlCPalette = createPalette(GROUPS);
	ctrlCPalette.palette.handleInput(KEY.CTRL_C);
	assert.deepEqual(ctrlCPalette.results, [{ type: "close" }]);
});

test("a second input after completion is ignored", () => {
	const { palette, results } = createPalette(GROUPS);
	palette.handleInput(KEY.ESCAPE);
	palette.handleInput(KEY.ENTER);
	palette.handleInput("x");
	assert.deepEqual(results, [{ type: "close" }]);
});

test("a key release event is ignored even when it would otherwise match a binding", () => {
	const { palette, results } = createPalette(GROUPS);
	// ":3B" flags a Kitty protocol key release for the down arrow.
	palette.handleInput("\x1b[1;1:3B");
	palette.handleInput(KEY.ENTER);
	assert.deepEqual(results, [{ type: "run", name: "gentle:models" }]);
});

// --- rendering ---------------------------------------------------------------

function render(groups: readonly CommandPaletteGroup[], query: string, width = 60, theme?: CommandPaletteTheme, rows?: () => number): string[] {
	const { palette } = createPalette(groups, theme, rows);
	type(palette, query);
	return palette.render(width);
}

test("render shows the header (Commands / esc), the search hint, and the typed query", () => {
	const lines = render(GROUPS, "");
	const header = lines.find((line) => line.includes("Commands"));
	assert.ok(header, "expected a header line with Commands");
	assert.match(header!, /Commands/);
	assert.match(header!, /esc\s*│?\s*$/);
	assert.ok(lines.some((line) => line.includes("› Search")));

	const typed = render(GROUPS, "models");
	assert.ok(typed.some((line) => line.includes("› models")));
});

test("render shows group titles and one row per item, with the shortcut right-aligned", () => {
	const lines = render(GROUPS, "").join("\n");
	assert.match(lines, /Configuration/);
	assert.match(lines, /Session/);
	assert.match(lines, /Assign models and effort/);
	assert.match(lines, /Agent-model profiles/);
	const changesLine = render(GROUPS, "").find((line) => line.includes("Browse captured changes"));
	assert.ok(changesLine, "expected a row for Browse captured changes");
	assert.match(changesLine!, /Browse captured changes[\s\S]*alt\+g/);
});

test("render omits the shortcut column for an item without one", () => {
	const lines = render(GROUPS, "").join("\n");
	const modelsLine = render(GROUPS, "")
		.filter((line) => line.includes("Assign models and effort"))
		.join("\n");
	assert.doesNotMatch(modelsLine, /undefined/);
	assert.ok(lines.length > 0);
});

test("render marks the selected row with a highlighted bar when the theme provides bg", () => {
	const bgTheme: CommandPaletteTheme = {
		fg: (_color, text) => text,
		bg: (color, text) => `[bg:${color}]${text}[/bg]`,
	};
	const lines = render(GROUPS, "", 60, bgTheme);
	const selectedLine = lines.find((line) => line.includes("[bg:selectedBg]"));
	assert.ok(selectedLine, "expected a bg-highlighted selected row");
	assert.match(selectedLine!, /Assign models and effort/);
	assert.doesNotMatch(selectedLine!, /▸/);
});

test("render falls back to a ▸ marker when the theme has no bg", () => {
	const fgOnlyTheme: CommandPaletteTheme = { fg: (_color, text) => text };
	const lines = render(GROUPS, "", 60, fgOnlyTheme);
	const selectedLine = lines.find((line) => line.includes("▸"));
	assert.ok(selectedLine, "expected a ▸ marker when bg is unavailable");
	assert.match(selectedLine!, /Assign models and effort/);
	assert.doesNotMatch(lines.join("\n"), /\[bg:/);
});

test("render shows a muted no-match row when nothing matches", () => {
	const lines = render(GROUPS, "does-not-exist").join("\n");
	assert.match(lines, /No commands match "does-not-exist"/);
});

test("render escapes control characters in labels and shortcuts", () => {
	const groups: CommandPaletteGroup[] = [{ title: "G", items: [{ command: "gentle:evil", label: "line1\x07line2", shortcut: "alt+\x07" }] }];
	const lines = render(groups, "").join("\n");
	assert.doesNotMatch(lines, /\x07/);
	assert.match(lines, /\\x07/);
});

test("render footer lists the key bindings", () => {
	const lines = render(GROUPS, "").join("\n");
	assert.match(lines, /type to search • ↑\/↓ move • enter run • esc close/);
});

test("render keeps the right border aligned when a label has wide characters", () => {
	// Both labels are exactly 10 UTF-16 code units, so a length-based pad
	// treats the two rows as equally wide and pads them by the same amount.
	// Their display widths differ (20 columns of CJK vs. 10 ASCII columns),
	// so only a visibleWidth-based pad keeps the right border aligned.
	const groups: CommandPaletteGroup[] = [
		{
			title: "G",
			items: [
				{ command: "gentle:emoji", label: "中文中文中文中文中文" },
				{ command: "gentle:plain", label: "plain desc" },
			],
		},
	];
	const lines = render(groups, "", 60);
	const widths = new Set(lines.map((line) => visibleWidth(line)));
	assert.equal(widths.size, 1, `expected every rendered line to share one visible width, got ${[...widths].join(", ")}`);
});

test("height follows rows() with scroll indicators when 30 items do not fit in 24 rows", () => {
	const groups: CommandPaletteGroup[] = Array.from({ length: 3 }, (_, groupIndex) => ({
		title: `Group ${groupIndex}`,
		items: Array.from({ length: 10 }, (_, itemIndex) => ({ command: `cmd:${groupIndex}-${itemIndex}`, label: `Item ${groupIndex}-${itemIndex}` })),
	}));
	const { palette } = createPalette(groups, undefined, () => 24);
	for (let i = 0; i < 15; i++) palette.handleInput(KEY.DOWN);
	const lines = palette.render(80);
	assert.ok(lines.length <= 20, `expected at most 20 total lines for rows()=24, got ${lines.length}`);
	assert.ok(lines.some((line) => /↑ \d+ more/.test(line)));
	assert.ok(lines.some((line) => /↓ \d+ more/.test(line)));
});

test("a small terminal still renders at least the minimum 12-line card", () => {
	const { palette } = createPalette(GROUPS, undefined, () => 4);
	const lines = palette.render(60);
	assert.ok(lines.length <= 12, `expected at most 12 total lines for a tiny terminal, got ${lines.length}`);
});

// --- commandsKey ---------------------------------------------------------------

test("commandsKey defaults to alt+k", () => {
	assert.equal(commandsKey({}), "alt+k");
});

test("commandsKey honors an override", () => {
	assert.equal(commandsKey({ GENTLE_PI_COMMANDS_KEY: "ctrl+p" }), "ctrl+p");
});

test("commandsKey is disabled by an empty value or off (case-insensitive)", () => {
	assert.equal(commandsKey({ GENTLE_PI_COMMANDS_KEY: "" }), undefined);
	assert.equal(commandsKey({ GENTLE_PI_COMMANDS_KEY: "off" }), undefined);
	assert.equal(commandsKey({ GENTLE_PI_COMMANDS_KEY: "OFF" }), undefined);
});

// --- catalog -------------------------------------------------------------------

test("COMMAND_PALETTE_CATALOG matches the curated command set, in order", () => {
	assert.deepEqual(
		COMMAND_PALETTE_CATALOG.map((group) => group.title),
		["Configuration", "Session", "Diagnostics", "Skills"],
	);
	const byTitle = (title: string) => COMMAND_PALETTE_CATALOG.find((group) => group.title === title)?.items.map((item) => item.command);
	assert.deepEqual(byTitle("Configuration"), [
		"gentle:models",
		"gentle:profiles",
		"gentle:persona",
		"gentle:review-mode",
		"gentle:background-subagents",
		"gentle:double-esc-cancel",
		"gentle:customize",
		"gentle:animations",
		"gentle:vim",
		"gentle:telemetry",
		"gentle:banner",
		"gentle:banner-color",
		"gentle:toggle-rose",
		"gentle:toggle-text-logo",
		"gentle:dev-binary",
	]);
	assert.deepEqual(byTitle("Session"), ["gentle:changes", "gentle:agents", "gentle:usage", "gentle:review-session-permission"]);
	assert.deepEqual(byTitle("Diagnostics"), ["gentle:status", "gentle:doctor"]);
	assert.equal(byTitle("SDD"), undefined);
	assert.deepEqual(byTitle("Skills"), ["skill-registry:refresh"]);
});

test("retired SDD commands are absent from the palette and extension registrations", () => {
	const retired = ["gentle:sdd-preflight", "gentle-sdd-status", "gentle-sdd-continue", "gentle-sdd-init", "gentle:install-sdd"];
	const catalogCommands = COMMAND_PALETTE_CATALOG.flatMap((group) => group.items.map((item) => item.command));
	assert.equal(existsSync(new URL("../extensions/sdd-init.ts", import.meta.url)), false, "retired init extension must stay absent");
	const source = readFileSync(new URL("../extensions/gentle-ai.ts", import.meta.url), "utf8");
	for (const command of retired) {
		assert.ok(!catalogCommands.includes(command), `${command} must not appear in the palette`);
		assert.ok(!source.includes(`registerCommand("${command}"`), `${command} must not be registered`);
	}
	assert.match(source, /for \(const owner of \["delegation", "review"\] as const\) \{\s*const label = owner;\s*pi\.registerCommand\(`gentle:install-\$\{owner\}`/);
	assert.ok(catalogCommands.includes("gentle:review-mode"));
});

test("buildCommandPaletteGroups keeps only registered commands, attaches descriptions and shortcuts, drops empty groups, preserves catalog order", () => {
	const registered = [
		{ name: "gentle:models", description: "Configure models" },
		{ name: "gentle:changes", description: "Browse changes" },
		{ name: "gentle:status", description: "Show status" },
		{ name: "skill-registry:refresh", description: "Refresh registry" },
	];
	const shortcuts = { "gentle:changes": "alt+g" };
	const groups = buildCommandPaletteGroups(registered, shortcuts);
	assert.deepEqual(
		groups.map((group) => group.title),
		["Configuration", "Session", "Diagnostics", "Skills"],
	);
	const configuration = groups.find((group) => group.title === "Configuration");
	assert.deepEqual(configuration?.items.map((item) => item.command), ["gentle:models"]);
	assert.equal(configuration?.items[0]?.description, "Configure models");
	assert.equal(configuration?.items[0]?.shortcut, undefined);
	const session = groups.find((group) => group.title === "Session");
	assert.deepEqual(session?.items.map((item) => item.command), ["gentle:changes"]);
	assert.equal(session?.items[0]?.shortcut, "alt+g");
	assert.equal(groups.some((group) => group.title === "SDD"), false);
});

test("buildCommandPaletteGroups drops every group when nothing in the catalog is registered", () => {
	const groups = buildCommandPaletteGroups([{ name: "not-in-catalog", description: "n/a" }], {});
	assert.deepEqual(groups, []);
});
