import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_VISUAL_SETTINGS } from "../lib/visual-customization-policy.ts";
import {
	buildShellHeaderModel,
	formatCost,
	formatTokens,
	gaugeTone,
	renderGauge,
	renderShellBar,
	renderShellHeaderBar,
	renderShellHeaderRule,
	renderShellSidebarBar,
	shellEnabled,
	type ShellBarModel,
	type ShellBarTheme,
} from "../lib/shell-bar.ts";

// The Gentle Shell bar replaces pi's three-line footer with one line of
// segments. Rendering is pure so it can be verified without a TUI.

const taggedTheme: ShellBarTheme = {
	fg(color: string, value: string) {
		return `<${color}>${value}</${color}>`;
	},
	bold(value: string) {
		return value;
	},
};

const plainTheme: ShellBarTheme = {
	fg(_color: string, value: string) {
		return value;
	},
	bold(value: string) {
		return value;
	},
};

function model(overrides: Partial<ShellBarModel> = {}): ShellBarModel {
	return {
		cwd: "~/work/gentle-pi",
		branch: "main",
		dirty: undefined,
		sessionName: undefined,
		modelId: "gpt-5.5",
		effort: "medium",
		contextPercent: 45,
		contextWindow: 272_000,
		costTotal: 9.49,
		subscription: true,
		usage: undefined,
		statuses: [],
		...overrides,
	};
}

test("visual visibility hides only selected optional status segments", () => {
	const settings = { ...DEFAULT_VISUAL_SETTINGS, visibility: { ...DEFAULT_VISUAL_SETTINGS.visibility, changes: false, modelDetails: false, usageCost: false } };
	const data = model({ changes: { files: 2, added: 1, deleted: 1 } });
	assert.doesNotMatch(renderShellBar(data, plainTheme, 160, settings).join(""), /gpt-5\.5|ctx|\$9\.49/);
	assert.doesNotMatch(renderShellSidebarBar(data, plainTheme, 50, settings).join(""), /Changes|2 files/);
	assert.doesNotMatch(renderShellHeaderBar(buildShellHeaderModel(data), plainTheme, 160, undefined, settings).text, /gpt-5\.5|ctx|\$9\.49|usage/);
});

test("Status title stays plain without an active review", () => {
	const lines = renderShellSidebarBar(model(), plainTheme, 60);
	assert.match(lines[0], /^╭─ ✿ Status ─+╮$/);
	assert.doesNotMatch(lines.slice(1).join("\n"), /🌹 RDD/);
});

test("Status title stays plain above the review lifecycle block", () => {
	const lines = renderShellSidebarBar(model({ review: { state: "reviewing", scope: "first.ts +2" } }), plainTheme, 60);
	assert.match(lines[0], /^╭─ ✿ Status ─+╮$/);
	assert.match(lines.slice(1).join("\n"), /🌹 RDD[\s\S]*Reviewing[\s\S]*first\.ts \+2/);
});

test("Status and review lifecycle block respect terminal width", () => {
	for (const width of [8, 12, 16, 20, 32, 60]) {
		for (const review of [undefined, { state: "reviewing" as const, scope: "first.ts +2" }]) {
			const lines = renderShellSidebarBar(model({ review }), plainTheme, width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
			if (width >= 20) assert.match(lines[0], /^╭─ ✿ Status ─+╮$/);
		}
	}
});

test("renderGauge fills cells proportionally to the percentage", () => {
	assert.equal(renderGauge(45, 8), "▰▰▰▰▱▱▱▱");
	assert.equal(renderGauge(0, 8), "▱▱▱▱▱▱▱▱");
	assert.equal(renderGauge(100, 8), "▰▰▰▰▰▰▰▰");
	assert.equal(renderGauge(null, 8), "▱▱▱▱▱▱▱▱");
});

test("gaugeTone turns to warning at 80% and error at 95%", () => {
	assert.equal(gaugeTone(45), "accent");
	assert.equal(gaugeTone(79.9), "accent");
	assert.equal(gaugeTone(80), "warning");
	assert.equal(gaugeTone(95), "error");
	assert.equal(gaugeTone(null), "dim");
});

test("formatTokens and formatCost keep the bar compact", () => {
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(4_200), "4.2k");
	assert.equal(formatTokens(272_000), "272k");
	assert.equal(formatTokens(13_000_000), "13M");
	assert.equal(formatCost(9.49, true), "$9.49 sub");
	assert.equal(formatCost(0.004, false), "$0.004");
});

test("renderShellBar renders one line with the segments in order", () => {
	const [line, ...rest] = renderShellBar(model(), plainTheme, 160);
	assert.equal(rest.length, 0);
	assert.equal(
		line,
		"✿ gentle shell ⟡ ~/work/gentle-pi main ⟡ gpt-5.5 · medium ⟡ ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub",
	);
});

test("renderShellBar colors the brand, model, effort, and gauge by role", () => {
	const [line] = renderShellBar(model(), taggedTheme, 400);
	assert.match(line, /<accent>✿ gentle shell<\/accent>/);
	assert.match(line, /<text>gpt-5\.5<\/text>/);
	assert.match(line, /<syntaxFunction>medium<\/syntaxFunction>/);
	assert.match(line, /<accent>▰▰▰▰<\/accent><border>▱▱▱▱<\/border>/);
	assert.match(line, /<dim>⟡<\/dim>/);
});

test("renderShellBar shows the branch as dirty-neutral and omits it outside git", () => {
	const [line] = renderShellBar(model({ branch: null }), plainTheme, 160);
	assert.match(line, /⟡ ~\/work\/gentle-pi ⟡/);
});

test("renderShellBar shows the session dirty count next to the branch", () => {
	const [line] = renderShellBar(model({ dirty: 3 }), taggedTheme, 400);
	assert.match(line, /<text>main<\/text> <warning>±3<\/warning>/);
	const [clean] = renderShellBar(model({ dirty: 0 }), plainTheme, 160);
	assert.doesNotMatch(clean, /±/);
});

test("renderShellBar adds the subscription windows after the cost when usage is known", () => {
	const usage = {
		provider: "openai-codex",
		plan: "pro",
		fetchedAt: 0,
		limits: [{ name: "codex", limitReached: false, windows: [
			{ label: "5h", usedPercent: 62, windowSeconds: 18_000, resetAt: null },
			{ label: "week", usedPercent: 31, windowSeconds: 604_800, resetAt: null },
		] }],
	};
	const [line] = renderShellBar(model({ usage }), plainTheme, 200);
	assert.match(line, /\$9\.49 sub ⟡ codex 5h ▰▰▰▰▰▱▱▱ 62% · week 31%$/);
});

test("renderShellBar meters the model the session is using inside a multi-model provider", () => {
	const usage = {
		provider: "nan",
		plan: undefined,
		fetchedAt: 0,
		limits: [
			{ name: "deepseek-v4-flash", limitReached: false, windows: [{ label: "", usedPercent: 18, windowSeconds: 0, resetAt: null, used: 545_000_000, budget: 3_000_000_000 }] },
			{ name: "glm5.3-flash", limitReached: false, windows: [{ label: "", usedPercent: 10, windowSeconds: 0, resetAt: null, used: 200_000_000, budget: 2_000_000_000 }] },
		],
	};
	const [glm] = renderShellBar(model({ modelId: "glm5.3-flash", usage }), plainTheme, 200);
	assert.match(glm, /glm5\.3-flash ▰▱▱▱▱▱▱▱ 10%$/);
	assert.doesNotMatch(glm, /deepseek-v4-flash ▰/);
	const [other] = renderShellBar(model({ modelId: "deepseek-v4-flash", usage }), plainTheme, 200);
	assert.match(other, /deepseek-v4-flash ▰▱▱▱▱▱▱▱ 18%$/);
});

test("renderShellBar keeps its own zero-window contract independent of the sidebar", () => {
	const usage = {
		provider: "openai-codex",
		plan: "pro",
		fetchedAt: 0,
		limits: [{ name: "codex", limitReached: false, windows: [
			{ label: "5h", usedPercent: 0, windowSeconds: 18_000, resetAt: null },
			{ label: "week", usedPercent: 0, windowSeconds: 604_800, resetAt: null },
		] }],
	};
	assert.match(renderShellBar(model({ usage }), plainTheme, 200)[0], /codex 5h ▱▱▱▱▱▱▱▱ 0% · week 0%$/);
});

test("renderShellBar shows an unknown context as a question mark after compaction", () => {
	const [line] = renderShellBar(model({ contextPercent: null }), plainTheme, 160);
	assert.match(line, /ctx ▱▱▱▱▱▱▱▱ \?%/);
});

test("renderShellBar right-aligns the session name when it fits", () => {
	const [line] = renderShellBar(model({ sessionName: "Release notes" }), plainTheme, 120);
	assert.equal(visibleWidth(line), 120);
	assert.match(line, /Release notes$/);
});

test("renderShellBar appends extension statuses as trailing segments", () => {
	const [line] = renderShellBar(model({ statuses: ["🔌 MCP: 3 servers\tenabled"] }), plainTheme, 160);
	assert.match(line, /⟡ 🔌 MCP: 3 servers enabled$/);
});

test("renderShellBar repaints extension statuses in the bar role, discarding colors the extension embedded", () => {
	const tagged = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text };
	const [line] = renderShellBar(model({ statuses: ["\x1b[38;2;255;0;0mMCP: 3/3 servers\x1b[0m"] }), tagged, 400);
	assert.match(line, /<muted>MCP: 3\/3 servers<\/muted>$/);
	assert.doesNotMatch(line, /\x1b\[/);
});

test("renderShellBar compacts the path and branch before it sacrifices an extension status", () => {
	const long = model({ branch: "fix/shell-bar-status-ansi", dirty: 2, statuses: ["MCP: 3/3 servers"] });
	const [full] = renderShellBar(long, plainTheme, 160);
	assert.match(full, /~\/work\/gentle-pi fix\/shell-bar-status-ansi ±2 .* MCP: 3\/3 servers$/);
	const [compact] = renderShellBar(long, plainTheme, 118);
	assert.ok(visibleWidth(compact) <= 118, `line overflowed: ${visibleWidth(compact)}`);
	assert.match(compact, /⟡ gentle-pi fix\/shell-bar-… ±2 ⟡/);
	assert.match(compact, /MCP: 3\/3 servers$/);
});

test("renderShellBar drops the session name, then trailing segments, before truncating", () => {
	const wide = model({ sessionName: "Release notes", statuses: ["MCP: 3 servers enabled"] });
	const [atNinety] = renderShellBar(wide, plainTheme, 90);
	assert.ok(visibleWidth(atNinety) <= 90, `line overflowed: ${visibleWidth(atNinety)}`);
	assert.doesNotMatch(atNinety, /Release notes/);
	assert.match(atNinety, /gpt-5\.5/);

	const [atFifty] = renderShellBar(wide, plainTheme, 50);
	assert.ok(visibleWidth(atFifty) <= 50, `line overflowed: ${visibleWidth(atFifty)}`);
	assert.match(atFifty, /^✿ gentle shell/);
});

test("shellEnabled stays off inside a Gentle Agents child", () => {
	assert.equal(shellEnabled({ GENTLE_PI_AGENTS_CHILD: "1" }), false);
});

test("shellEnabled honors GENTLE_PI_SHELL=0", () => {
	assert.equal(shellEnabled({}), true);
	assert.equal(shellEnabled({ GENTLE_PI_SHELL: "1" }), true);
	assert.equal(shellEnabled({ GENTLE_PI_SHELL: "0" }), false);
	assert.equal(shellEnabled({ GENTLE_PI_SHELL: "false" }), false);
});

test("renderShellSidebarBar paints the Status card frame with border and the title with accent", () => {
	const lines = renderShellSidebarBar(model(), taggedTheme, 46);
	assert.match(lines[0], /^<border>╭<\/border>/);
	assert.match(lines[0], /<accent>✿ Status<\/accent>/);
	assert.match(lines[lines.length - 1], /^<border>╰<\/border>/);
});

test("sidebar unifies project, captured changes and integrations in one frame", () => {
	const data = model({ changes: { files: 2, added: 7, deleted: 3, notice: "capture warning" }, statuses: ["MCP connected"] });
	const lines = renderShellSidebarBar(data, plainTheme, 46);
	const text = lines.join("\n");
	assert.equal(lines.filter((line) => line.startsWith("╭")).length, 1);
	let previous = -1;
	for (const heading of ["Status", "Project", "Changes", "Integrations"]) {
		const index = text.indexOf(heading);
		assert.ok(index > previous, heading);
		previous = index;
	}
	assert.match(text, /2 files.*\+7.*−3/);
	assert.match(text, /capture warning/);
	assert.match(text, /\/gentle:changes/);
	assert.match(text, /main/);
	for (const width of [1, 8, 24, 46]) assert.ok(renderShellSidebarBar(data, plainTheme, width).every((line) => visibleWidth(line) <= width));
	const empty = renderShellSidebarBar(model(), plainTheme, 46).join("\n");
	assert.match(empty, /No captured changes/);
	assert.match(empty, /Integrations/);
});

test("sidebar profile wraps long names without changing the compact bar", () => {
	const profile = "team-" + "x".repeat(59);
	const base = model();
	const active = model({ profile });
	for (const width of [24, 46]) {
		const lines = renderShellSidebarBar(active, plainTheme, width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /Profile/);
		assert.ok(lines.join("").replace(/[│\s]/g, "").includes(profile));
	}
	assert.deepEqual(renderShellBar(active, plainTheme, 120), renderShellBar(base, plainTheme, 120));
});

test("sidebar Status card drops Model, Effort, Context, Cost and Usage, keeping Project, Changes and Integrations", () => {
	const usage = {
		provider: "openai-codex",
		plan: "pro",
		fetchedAt: 0,
		limits: [{ name: "codex", limitReached: false, windows: [{ label: "5h", usedPercent: 62, windowSeconds: 18_000, resetAt: null }] }],
	};
	const data = model({ profile: "team", sessionName: "session", usage, changes: { files: 1, added: 2, deleted: 1 }, statuses: ["MCP connected"] });
	const text = renderShellSidebarBar(data, plainTheme, 60).join("\n");
	assert.doesNotMatch(text, /Usage/);
	assert.doesNotMatch(text, /Model/);
	assert.doesNotMatch(text, /Effort/);
	assert.doesNotMatch(text, /Context/);
	assert.doesNotMatch(text, /Cost/);
	assert.doesNotMatch(text, /\$9\.49/);
	assert.doesNotMatch(text, /codex 5h/);
	for (const heading of ["Status", "Project", "Changes", "Integrations"]) assert.match(text, new RegExp(heading));
	assert.match(text, /Branch.*main/);
	assert.match(text, /Session.*session/);
	assert.match(text, /Profile.*team/);
});

// The live header row above the fullscreen rail: identity on the left (brand,
// location, model · effort · profile), the per-frame counters right-aligned
// (context gauge, cost). Never the working/thinking state or extension
// statuses — those stay in the prompt and the Status card.

test("buildShellHeaderModel keeps only the header's fields from the bar model", () => {
	const header = buildShellHeaderModel(model({ profile: "team", statuses: ["MCP: 3 servers"] }));
	assert.deepEqual(header, {
		cwd: "~/work/gentle-pi",
		branch: "main",
		dirty: undefined,
		modelId: "gpt-5.5",
		effort: "medium",
		profile: "team",
		contextPercent: 45,
		costTotal: 9.49,
		subscription: true,
		usage: undefined,
	});
	assert.ok(!("statuses" in header), "extension statuses never reach the header");
});

test("renderShellHeaderBar draws the brand, identity, and right-aligned counters (plus the standing usage segment) in one line", () => {
	const header = buildShellHeaderModel(model({ profile: "team" }));
	const { text: line } = renderShellHeaderBar(header, plainTheme, 120);
	const left = "✿ Gentle Shell ⟡ ~/work/gentle-pi main ⟡ gpt-5.5 · medium · team";
	const right = "ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub ⟡ usage";
	assert.equal(line, left + " ".repeat(120 - visibleWidth(left) - visibleWidth(right)) + right);
	assert.equal(visibleWidth(line), 120);
});

test("renderShellHeaderBar never shows working state or extension statuses", () => {
	const header = buildShellHeaderModel(model({ statuses: ["MCP: 3 servers", "working…"] }));
	const { text: line } = renderShellHeaderBar(header, plainTheme, 120);
	assert.doesNotMatch(line, /MCP: 3 servers/);
	assert.doesNotMatch(line, /working/);
});

test("renderShellHeaderBar colors the brand bold and by role", () => {
	const bolding = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `**${text}**` };
	const header = buildShellHeaderModel(model());
	const { text: line } = renderShellHeaderBar(header, bolding, 120);
	assert.match(line, /<accent>\*\*✿ Gentle Shell\*\*<\/accent>/);
});

test("renderShellHeaderBar drops the profile, then the effort, then the whole location before the right group", () => {
	const withProfile = buildShellHeaderModel(model({ profile: "team" }));
	const { text: wide } = renderShellHeaderBar(withProfile, plainTheme, 120);
	assert.match(wide, /gpt-5\.5 · medium · team/);
	assert.match(wide, /~\/work\/gentle-pi main/);
	assert.match(wide, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub ⟡ usage$/);

	// 100 cols: the profile no longer fits, but effort and location still do.
	const { text: noProfile } = renderShellHeaderBar(withProfile, plainTheme, 100);
	assert.doesNotMatch(noProfile, /team/);
	assert.match(noProfile, /gpt-5\.5 · medium/);
	assert.match(noProfile, /~\/work\/gentle-pi main/);
	assert.equal(visibleWidth(noProfile), 100);

	// 90 cols: effort goes too, only the bare model id remains next to location.
	const { text: noEffort } = renderShellHeaderBar(withProfile, plainTheme, 90);
	assert.doesNotMatch(noEffort, /medium/);
	assert.doesNotMatch(noEffort, /team/);
	assert.match(noEffort, /gpt-5\.5/);
	assert.match(noEffort, /~\/work\/gentle-pi main/);
	assert.equal(visibleWidth(noEffort), 90);

	// 82 cols: the whole location segment goes; brand and model survive with the counters.
	const { text: noLocation } = renderShellHeaderBar(withProfile, plainTheme, 82);
	assert.doesNotMatch(noLocation, /~\/work\/gentle-pi/);
	assert.match(noLocation, /gpt-5\.5/);
	assert.match(noLocation, /✿ Gentle Shell/);
	assert.match(noLocation, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub ⟡ usage$/);
	assert.equal(visibleWidth(noLocation), 82);

	// 60 cols: even the standing usage segment is gone now; brand+model and ctx/cost survive.
	const { text: noUsage } = renderShellHeaderBar(withProfile, plainTheme, 60);
	assert.doesNotMatch(noUsage, /~\/work\/gentle-pi/);
	assert.doesNotMatch(noUsage, /usage/);
	assert.match(noUsage, /gpt-5\.5/);
	assert.match(noUsage, /✿ Gentle Shell/);
	assert.match(noUsage, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub$/);
	assert.equal(visibleWidth(noUsage), 60);
});

test("renderShellHeaderBar returns an empty string only once the brand itself cannot fit", () => {
	assert.equal(renderShellHeaderBar(buildShellHeaderModel(model()), plainTheme, 3).text, "");
	assert.match(renderShellHeaderBar(buildShellHeaderModel(model()), plainTheme, 40).text, /✿ Gentle Shell/);
});

// T8: the usage segment. It rides after cost in the right group, shows every
// window of the active provider's main limit, and degrades (gauges, then
// secondary windows, then the whole segment) before ctx/cost is ever touched.

const USAGE_TWO_WINDOWS = {
	provider: "openai-codex",
	plan: "pro",
	fetchedAt: 0,
	limits: [{ name: "codex", limitReached: false, windows: [
		{ label: "5h", usedPercent: 26, windowSeconds: 18_000, resetAt: null },
		{ label: "week", usedPercent: 12, windowSeconds: 604_800, resetAt: null },
	] }],
};

test("renderShellHeaderBar shows every usage window with its gauge and the shortcut hint, after cost", () => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	const { text, usageSpan } = renderShellHeaderBar(header, plainTheme, 140, "alt+u");
	assert.match(text, /\$9\.49 sub ⟡ usage 5h ▰▰▱▱▱▱▱▱ 26% · week ▰▱▱▱▱▱▱▱ 12% · alt\+u$/);
	assert.ok(usageSpan);
	assert.equal(text.slice(usageSpan.start, usageSpan.end), "usage 5h ▰▰▱▱▱▱▱▱ 26% · week ▰▱▱▱▱▱▱▱ 12% · alt+u");
});

test("renderShellHeaderBar shows 'usage · <shortcut>' with no data, and drops the hint when the shortcut is disabled", () => {
	const withHint = renderShellHeaderBar(buildShellHeaderModel(model({ usage: undefined })), plainTheme, 140, "alt+u");
	assert.match(withHint.text, /usage · alt\+u$/);
	const noHint = renderShellHeaderBar(buildShellHeaderModel(model({ usage: undefined })), plainTheme, 140, undefined);
	assert.match(noHint.text, /usage$/);
	assert.doesNotMatch(noHint.text, /alt\+u/);
});

test("renderShellHeaderBar degrades the usage segment (gauges, then secondary windows, then the whole segment) before touching ctx/cost", () => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	const full = renderShellHeaderBar(header, plainTheme, 140, "alt+u").text;
	assert.match(full, /5h ▰▰▱▱▱▱▱▱ 26% · week ▰▱▱▱▱▱▱▱ 12%/);

	// 100 cols: the gauges no longer fit, but both windows still show as text
	// (a positive match on the bare "5h 26% · week 12%" run rules out any
	// gauge glyph sneaking in between them; ctx's own gauge is unrelated).
	const noGauges = renderShellHeaderBar(header, plainTheme, 100, "alt+u").text;
	assert.match(noGauges, /usage 5h 26% · week 12% · alt\+u$/);
	assert.match(noGauges, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub/, "ctx/cost are untouched while usage still degrades");
	assert.equal(visibleWidth(noGauges), 100);

	// 80 cols: only the first window remains.
	const primaryOnly = renderShellHeaderBar(header, plainTheme, 80, "alt+u").text;
	assert.match(primaryOnly, /usage 5h 26% · alt\+u$/);
	assert.doesNotMatch(primaryOnly, /week/);
	assert.match(primaryOnly, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub/);
	assert.equal(visibleWidth(primaryOnly), 80);

	// 70 cols: the whole usage segment is gone, ctx/cost remain intact.
	const noUsage = renderShellHeaderBar(header, plainTheme, 70, "alt+u").text;
	assert.doesNotMatch(noUsage, /usage/);
	assert.match(noUsage, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub$/);
	assert.equal(visibleWidth(noUsage), 70);
});

test("renderShellHeaderBar's usage span always points at the usage text, not ctx/cost", () => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	for (const width of [140, 100, 90]) {
		const { text, usageSpan } = renderShellHeaderBar(header, plainTheme, width, "alt+u");
		if (!usageSpan) continue;
		assert.match(text.slice(usageSpan.start, usageSpan.end), /^usage/);
		assert.equal(usageSpan.end, visibleWidth(text), "the usage segment always ends at the right edge");
	}
});

test("renderShellHeaderRule paints one full-width line in the editor frame color", () => {
	assert.equal(renderShellHeaderRule(taggedTheme, 4), "<border>────</border>", "the rule uses the editor frame's border role");
	assert.equal(renderShellHeaderRule(plainTheme, 12), "─".repeat(12), "the rule spans the full width");
	assert.equal(renderShellHeaderRule(plainTheme, 0), "");
	assert.equal(renderShellHeaderRule(plainTheme, -3), "", "negative widths clamp to an empty rule");
});
