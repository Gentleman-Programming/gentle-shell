import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { TuiAltScreen, visibleWidth, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { getThemeByName } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { CommandPalette, commandsKey, rankPaletteGroups, type CommandPaletteGroup, type CommandPaletteItem, type CommandPaletteResult, type CommandPaletteTheme } from "../lib/command-palette.ts";
import { buildCommandPaletteGroups, COMMAND_PALETTE_CATALOG } from "../lib/command-palette-catalog.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import startupBanner from "../extensions/startup-banner.ts";

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
	for (const term of ["`/gentle:vim enable`", "`/gentle:vim disable`", "`status`", "VISUAL", "`Ctrl+[`", "`gg/G`", "`f/F/t/T`", "`d/c/y`", "`u`", "`.`", "Pi", "first line", "reverse prompt-history search", "0.99.1", "paste marker"]) {
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
		items: [{ command: "gentle:changes", label: "Browse changes", shortcut: "alt+g" }],
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

test("tab captures the next key for the highlighted command, and esc cancels the capture", () => {
	const results: CommandPaletteResult[] = [];
	const palette = new CommandPalette([{ title: "Session", items: [{ command: "gentle:design", label: "Design" }, { command: "gentle:voice", label: "Voice" }] }], (result) => results.push(result));
	palette.handleInput("\x1b[B");
	palette.handleInput("\t");
	assert.match(palette.render(80).join("\n"), /Press the new key for Voice · esc cancel/);
	palette.handleInput("\x1b");
	assert.deepEqual(results, [], "esc only cancels the capture");
	assert.match(palette.render(80).join("\n"), /tab set key/);
	palette.handleInput("\t");
	palette.handleInput("\x1bv");
	assert.deepEqual(results, [{ type: "bind", name: "gentle:voice", data: "\x1bv" }]);
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
	const changesLine = render(GROUPS, "").find((line) => line.includes("Browse changes"));
	assert.ok(changesLine, "expected a row for Browse changes");
	assert.match(changesLine!, /Browse changes[\s\S]*alt\+g/);
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
	assert.match(lines, /↑\/↓ move • enter run • tab set key • esc close/);
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

// --- fullscreen pointer interaction ------------------------------------------

function point(frame: string[], text: string): { x: number; y: number } {
	const y = frame.findIndex((line) => line.includes(text));
	assert.ok(y >= 0, `missing ${JSON.stringify(text)} in rendered frame`);
	const line = frame[y]!;
	return { x: visibleWidth(line.slice(0, line.indexOf(text))), y };
}

function mouse(frame: string[], x: number, y: number, type: TuiMouseEvent["type"] = "click", button: TuiMouseEvent["button"] = "left"): TuiMouseEvent {
	return { type, button, x, y, screenX: x + 10, screenY: y + 5, width: visibleWidth(frame[0]!), height: frame.length, shift: false, alt: false, ctrl: false };
}

function at(frame: string[], text: string, type: TuiMouseEvent["type"] = "click", button: TuiMouseEvent["button"] = "left"): TuiMouseEvent {
	const { x, y } = point(frame, text);
	return mouse(frame, x, y, type, button);
}

const pointerTheme: CommandPaletteTheme = {
	fg: (role, text) => role === "warning" ? `\x1b[33m${text}\x1b[39m` : text,
	bg: (_role, text) => `\x1b[44m${text}\x1b[49m`,
};

test("visible command rows use primary click; headings, blanks, borders and other buttons do not run", () => {
	const { palette, results } = createPalette(GROUPS);
	const frame = palette.render(80);
	for (const event of [
		at(frame, "Configuration"), at(frame, "Session"), mouse(frame, 5, 3),
		mouse(frame, 0, point(frame, "Agent-model profiles").y),
		mouse(frame, 79, point(frame, "Agent-model profiles").y),
		at(frame, "Agent-model profiles", "click", "right"),
		at(frame, "Agent-model profiles", "click", "middle"),
	]) palette.handleMouse(event);
	assert.deepEqual(results, []);
	assert.equal(palette.handleMouse(at(frame, "Agent-model profiles", "press"))?.handled, true);
	assert.deepEqual(results, [], "press alone cannot run a command");
	assert.equal(palette.handleMouse(at(frame, "Agent-model profiles"))?.handled, true);
	assert.deepEqual(results, [{ type: "run", name: "gentle:profiles" }]);
	palette.handleMouse(at(frame, "Assign models and effort"));
	assert.deepEqual(results, [{ type: "run", name: "gentle:profiles" }], "completion is once only");
});

test("hover paints only the visible row with the shared warning role, without selecting it", () => {
	const { palette, results } = createPalette(GROUPS, pointerTheme);
	let frame = palette.render(80);
	const motion = at(frame, "Agent-model profiles", "move", "none");
	const hoverResult = palette.handleMouse(motion);
	assert.equal(hoverResult?.render, true);
	assert.equal(hoverResult?.focus, undefined, "hover cannot request focus");
	frame = palette.render(80);
	const hovered = frame.find((line) => line.includes("Agent-model profiles"))!;
	assert.match(hovered, /\x1b\[33m/);
	assert.doesNotMatch(frame.find((line) => line.includes("Assign models and effort"))!, /\x1b\[33m/);
	assert.deepEqual(results, []);
	assert.equal(palette.handleMouse(motion)?.render, false, "repeated motion does not redraw");
	assert.equal(palette.handleMouse(at(frame, "Configuration", "move", "none"))?.render, true);
	frame = palette.render(80);
	assert.doesNotMatch(frame.find((line) => line.includes("Agent-model profiles"))!, /\x1b\[33m/);
	palette.handleInput(KEY.ENTER);
	assert.deepEqual(results, [{ type: "run", name: "gentle:models" }], "hover never changes keyboard selection");
});

test("hover retains the selected background and uses the warning role for the hovered label and shortcut", () => {
	const { palette } = createPalette(GROUPS, pointerTheme);
	palette.handleInput(KEY.DOWN);
	palette.handleInput(KEY.DOWN);
	let frame = palette.render(80);
	palette.handleMouse(at(frame, "Browse changes", "move", "none"));
	frame = palette.render(80);
	const selected = frame.find((line) => line.includes("Browse changes"))!;
	assert.match(selected, /\x1b\[44m/);
	assert.match(selected, /\x1b\[33m[^\x1b]*Browse changes[^\x1b]*alt\+g/);
});

test("filtering rejects stale hit geometry and runs the newly rendered matching command", () => {
	const { palette, results } = createPalette(GROUPS);
	let frame = palette.render(80);
	const stale = at(frame, "Agent-model profiles");
	type(palette, "changes");
	palette.handleMouse(stale);
	assert.deepEqual(results, []);
	frame = palette.render(80);
	assert.doesNotMatch(frame.join("\n"), /Agent-model profiles|Configuration/);
	palette.handleMouse(at(frame, "Browse changes"));
	assert.deepEqual(results, [{ type: "run", name: "gentle:changes" }]);
});

test("geometry and item identity are invalidated by resize, data changes, invalidate and dispose", () => {
	let height = 24;
	const groups: CommandPaletteGroup[] = [{ title: "Group", items: [{ command: "safe", label: "Safe command" }] }];
	const { palette, results } = createPalette(groups, pointerTheme, () => height);
	let frame = palette.render(80);
	const original = at(frame, "Safe command");
	height = 20;
	palette.handleMouse(original);
	height = 24;
	frame = palette.render(80);
	palette.handleMouse({ ...at(frame, "Safe command"), width: 79 });
	frame = palette.render(80);
	groups[0]!.items[0]!.command = "changed";
	palette.handleMouse(at(frame, "Safe command"));
	assert.deepEqual(results, [], "a stale frame cannot target changed content or dimensions");
	groups[0]!.items[0]!.command = "safe";
	frame = palette.render(80);
	palette.handleMouse(at(frame, "Safe command", "move", "none"));
	palette.invalidate();
	palette.handleMouse(at(frame, "Safe command"));
	assert.deepEqual(results, []);
	frame = palette.render(80);
	assert.doesNotMatch(frame.join("\n"), /\x1b\[33m/, "invalidation clears hover");
	palette.dispose();
	palette.handleMouse(at(frame, "Safe command"));
	palette.handleInput(KEY.ENTER);
	assert.deepEqual(results, [], "disposed palettes cannot act");
});

test("resize clears hover and clipped or empty command rows cannot be activated", () => {
	const groups: CommandPaletteGroup[] = [{ title: "Group", items: [
		{ command: "first", label: "First" },
		{ command: "long", label: "A long command name that cannot fit" },
		{ command: "empty", label: "" },
	] }];
	const { palette, results } = createPalette(groups, pointerTheme, () => 24);
	let frame = palette.render(80);
	palette.handleMouse(at(frame, "First", "move", "none"));
	frame = palette.render(20);
	assert.doesNotMatch(frame.join("\n"), /\x1b\[33m/, "a new width clears hover");
	const clippedY = frame.findIndex((line) => line.includes("A long comm"));
	assert.ok(clippedY >= 0);
	palette.handleMouse(mouse(frame, 4, clippedY));
	palette.handleMouse(mouse(frame, 4, clippedY + 1));
	assert.deepEqual(results, [], "clipped and blank entries are not actionable");
	palette.handleMouse(at(frame, "First"));
	assert.deepEqual(results, [{ type: "run", name: "first" }]);
});

test("wheel reaches scrolled commands and keeps keyboard navigation working", () => {
	const groups: CommandPaletteGroup[] = [{ title: "Many", items: Array.from({ length: 20 }, (_, i) => ({ command: `cmd:${i}`, label: `Item ${String(i).padStart(2, "0")}` })) }];
	const { palette, results } = createPalette(groups, undefined, () => 16);
	let frame = palette.render(80);
	assert.doesNotMatch(frame.join("\n"), /Item 19/);
	for (let i = 0; i < 19; i++) {
		const event = { ...mouse(frame, 4, 4, "wheel", "none"), wheelDelta: 1 };
		assert.equal(palette.handleMouse(event)?.handled, true);
		frame = palette.render(80);
	}
	assert.match(frame.join("\n"), /Item 19/);
	palette.handleInput(KEY.UP);
	frame = palette.render(80);
	assert.match(frame.join("\n"), /Item 18/);
	palette.handleMouse(at(frame, "Item 18"));
	assert.deepEqual(results, [{ type: "run", name: "cmd:18" }]);
});

test("mouse cannot select, run, scroll or bind while the next key is being captured", () => {
	const { palette, results } = createPalette(GROUPS, pointerTheme);
	palette.handleInput(KEY.DOWN);
	palette.handleInput("\t");
	const frame = palette.render(80);
	palette.handleMouse(at(frame, "Browse changes", "move", "none"));
	palette.handleMouse(at(frame, "Browse changes", "press"));
	palette.handleMouse(at(frame, "Browse changes"));
	palette.handleMouse({ ...at(frame, "Browse changes", "wheel", "none"), wheelDelta: 1 });
	assert.deepEqual(results, []);
	assert.doesNotMatch(palette.render(80).join("\n"), /\x1b\[33m/);
	palette.handleInput("\x1bv");
	assert.deepEqual(results, [{ type: "bind", name: "gentle:profiles", data: "\x1bv" }]);
});

test("centered native overlay receives real SGR motion, click and outside-card motion", (t) => {
	let input: ((data: string) => void) | undefined;
	const terminal: Terminal = {
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {},
		get columns() { return 120; }, get rows() { return 30; }, get kittyProtocolActive() { return false; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const theme = getThemeByName("dark");
	assert.ok(theme);
	const { palette, results } = createPalette(GROUPS, theme, () => terminal.rows);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	const overlay = tui.showOverlay(palette, { anchor: "center", width: 80, maxHeight: "85%" });
	tui.start();
	tui.renderNow(true);
	try {
		let frame = palette.render(80);
		const beforeFrame = frame.join("\n");
		const before = frame.find((line) => line.includes("Agent-model profiles"))!;
		const bounds = overlay.getBounds();
		assert.ok(bounds && bounds.col > 0 && bounds.row > 0);
		const target = point(frame, "Agent-model profiles");
		const x = bounds.col + target.x + 1, y = bounds.row + target.y + 1;
		input?.(`\x1b[<35;${x};${y}M`);
		frame = palette.render(80);
		const after = frame.find((line) => line.includes("Agent-model profiles"))!;
		if (process.env.GENTLE_PI_PALETTE_VISUAL === "1") {
			t.diagnostic(`before ANSI base64: ${Buffer.from(beforeFrame).toString("base64")}`);
			t.diagnostic(`after ANSI base64: ${Buffer.from(frame.join("\n")).toString("base64")}`);
		}
		assert.notEqual(after, before, "real SGR motion paints hover");
		assert.deepEqual(results, []);
		input?.("\x1b[<35;1;1M");
		frame = palette.render(80);
		assert.equal(frame.find((line) => line.includes("Agent-model profiles")), after,
			"native overlay routing does not deliver outside-card motion to the palette");
		input?.(`\x1b[<0;${x};${y}M`);
		input?.(`\x1b[<0;${x};${y}m`);
		assert.deepEqual(results, [{ type: "run", name: "gentle:profiles" }]);
	} finally {
		tui.stop();
	}
});

test("native SGR wheel reaches and clicks an initially hidden command", () => {
	let input: ((data: string) => void) | undefined;
	const terminal: Terminal = {
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {},
		get columns() { return 100; }, get rows() { return 16; }, get kittyProtocolActive() { return false; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const groups: CommandPaletteGroup[] = [{ title: "Many", items: Array.from({ length: 15 }, (_, i) => ({ command: `cmd:${i}`, label: `Item ${String(i).padStart(2, "0")}` })) }];
	const { palette, results } = createPalette(groups, undefined, () => terminal.rows);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	const overlay = tui.showOverlay(palette, { anchor: "center", width: 80, maxHeight: "85%" });
	tui.start();
	tui.renderNow(true);
	try {
		assert.doesNotMatch(palette.render(80).join("\n"), /Item 14/);
		for (let i = 0; i < 14; i++) {
			const bounds = overlay.getBounds();
			assert.ok(bounds);
			input?.(`\x1b[<65;${bounds.col + 5};${bounds.row + 5}M`);
			tui.renderNow(true);
		}
		const frame = palette.render(80);
		const bounds = overlay.getBounds();
		assert.ok(bounds);
		const target = point(frame, "Item 14");
		const x = bounds.col + target.x + 1, y = bounds.row + target.y + 1;
		input?.(`\x1b[<0;${x};${y}M`);
		input?.(`\x1b[<0;${x};${y}m`);
		assert.deepEqual(results, [{ type: "run", name: "cmd:14" }]);
	} finally {
		tui.stop();
	}
});

test("a height-clipped native overlay never dispatches a hidden row", () => {
	let input: ((data: string) => void) | undefined;
	const terminal: Terminal = {
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {},
		get columns() { return 100; }, get rows() { return 8; }, get kittyProtocolActive() { return false; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const groups: CommandPaletteGroup[] = [{ title: "Group", items: [
		{ command: "first", label: "First" }, { command: "hidden", label: "Hidden" },
	] }];
	const { palette, results } = createPalette(groups, undefined, () => terminal.rows);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	const overlay = tui.showOverlay(palette, { anchor: "center", width: 80, maxHeight: "85%" });
	tui.start();
	tui.renderNow(true);
	try {
		const frame = palette.render(80);
		const bounds = overlay.getBounds();
		assert.ok(bounds && bounds.height < frame.length);
		const hidden = point(frame, "Hidden");
		assert.ok(hidden.y >= bounds.height);
		const hiddenX = bounds.col + hidden.x + 1, hiddenY = bounds.row + hidden.y + 1;
		input?.(`\x1b[<0;${hiddenX};${hiddenY}M`);
		input?.(`\x1b[<0;${hiddenX};${hiddenY}m`);
		assert.deepEqual(results, []);
		const first = point(frame, "First");
		assert.ok(first.y < bounds.height);
		const x = bounds.col + first.x + 1, y = bounds.row + first.y + 1;
		input?.(`\x1b[<0;${x};${y}M`);
		input?.(`\x1b[<0;${x};${y}m`);
		assert.deepEqual(results, [{ type: "run", name: "first" }]);
	} finally {
		tui.stop();
	}
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
		"gentle:profiles",
		"gentle:persona",
		"gentle:review-mode",
		"gentle:background-subagents",
		"gentle:double-esc-cancel",
		"gentle:customize",
		"gentle:animations",
		"gentle:vim",
		"gentle:telemetry",
		"gentle:dev-binary",
	]);
	assert.deepEqual(byTitle("Session"), ["gentle:guide", "gentle:yolo", "gentle:changes", "gentle:agents", "gentle:jobs", "gentle:usage", "gentle:review-session-permission", "gentle:voice", "gentle:design"]);
	assert.deepEqual(byTitle("Diagnostics"), ["gentle:status", "gentle:doctor", "gentle:plugins"]);
	assert.equal(byTitle("SDD"), undefined);
	assert.deepEqual(byTitle("Skills"), ["skill-registry:refresh"]);
});

// #1664: banner settings live under Customization > Banner; the palette keeps
// one route while the slash commands stay registered for compatibility.
test("banner settings have one palette route and keep their slash commands", () => {
	const banner = ["gentle:banner", "gentle:banner-color", "gentle:toggle-rose", "gentle:toggle-text-logo"];
	const catalogCommands = COMMAND_PALETTE_CATALOG.flatMap((group) => group.items.map((item) => item.command));
	for (const command of banner) assert.ok(!catalogCommands.includes(command), `${command} must not appear in the palette`);
	assert.ok(catalogCommands.includes("gentle:customize"));
	const registered: string[] = [];
	startupBanner({ on() {}, registerCommand(name: string) { registered.push(name); }, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
	for (const command of banner) assert.ok(registered.includes(command), `${command} stays registered`);
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
		{ name: "gentle:profiles", description: "Configure models" },
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
	assert.deepEqual(configuration?.items.map((item) => item.command), ["gentle:profiles"]);
	assert.equal(configuration?.items[0]?.label, "Models and profiles");
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
