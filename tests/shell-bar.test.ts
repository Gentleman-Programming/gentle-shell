import assert from "node:assert/strict";
import test, { after, before, type TestContext } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_VISUAL_SETTINGS } from "../lib/visual-customization-policy.ts";
import {
	buildShellHeaderModel,
	formatCost,
	formatTokens,
	gaugeTone,
	renderGauge,
	renderShellBar,
	renderShellBottomOnlyBar,
	renderShellBelowInputFloat,
	renderShellHeaderBar,
	renderShellHeaderChrome,
	renderShellHeaderRule,
	renderShellSidebarBar,
	shellEnabled,
	shellHeaderUsageHit,
	type ShellBarModel,
	type ShellBarTheme,
} from "../lib/shell-bar.ts";
import { REVIEW_SCOPE_UNAVAILABLE } from "../lib/review-sidebar-state.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { CARD_STYLE, cardStyle, setCardStyle, type CardStyle } from "../lib/shell-card.ts";

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

// The card style defaults to float; these assertions pin the outlined (neon)
// panels unless a test switches the style itself.
const initialCardStyle = cardStyle();
before(() => setCardStyle(CARD_STYLE.NEON));
after(() => setCardStyle(initialCardStyle));

function useCardStyle(t: TestContext, style: CardStyle): void {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	setCardStyle(style);
}

const BG_OPEN = "\x1b[48;5;22m";
const BG_CLOSE = "\x1b[49m";

/** The same theme with a background, so the float style applies (without one panels keep the frame). */
function withBackground<T extends object>(theme: T): T & { bg(color: string, text: string): string } {
	return { ...theme, bg: (_color: string, text: string) => `${BG_OPEN}${text}${BG_CLOSE}` };
}

/** Float panel rows: a painted panel inside transparent one-column margins, between padding rows that keep the accent bar. */
function assertFloatRows(lines: readonly string[], width: number): void {
	for (const line of lines) {
		assert.equal(visibleWidth(line), width, `"${stripAnsi(line)}" is not ${width} wide`);
		assert.ok(line.startsWith(` ${BG_OPEN}`) && line.endsWith(`${BG_CLOSE} `), `painted inside the margins: ${JSON.stringify(line)}`);
	}
	const padding = ` ▎${" ".repeat(width - 3)} `;
	assert.equal(stripAnsi(lines[0]!), padding, "a padding row with the accent bar sits above the header");
	assert.equal(stripAnsi(lines.at(-1)!), padding, "a padding row with the accent bar replaces the bottom rule");
}

/** The text of a body row, without the neon side rails or the float accent bar. */
function bodyText(row: string): string {
	return stripAnsi(row).replace(/^ ?[│▎] /u, "").replace(/ ?│? ?$/u, "").trimEnd();
}

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

test("Status groups running job descriptions beside RDD without a compact count", () => {
	const data = model({ jobs: [
		{ id: "job-2", label: "CI for PR 1860", startedAt: 2 },
		{ id: "job-1", label: "Build runtime", startedAt: 1 },
	], review: { state: "reviewing", scope: "first.ts" } });
	for (const width of [30, 60]) {
		const lines = renderShellSidebarBar(data, plainTheme, width);
		const text = lines.join("\n");
		assert.match(text, /Jobs[\s\S]*CI for PR 1860[\s\S]*Build runtime/);
		assert.match(text, /🌹 RDD/);
		assert.doesNotMatch(text, /2 jobs/);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	assert.doesNotMatch(renderShellSidebarBar(model({ jobs: [] }), plainTheme, 60).join("\n"), /Jobs/);
});

test("header shows only the running job count when requested and preserves it at mobile widths", () => {
	const data = model({ jobs: [{ id: "job-1", label: "CI for PR 1860", startedAt: 1 }] });
	for (const width of [40, 80, 160]) {
		const text = renderShellHeaderBar(buildShellHeaderModel(data, true), plainTheme, width).text;
		assert.match(text, /⧗ 1 job/);
		assert.doesNotMatch(text, /CI for PR/);
		assert.ok(visibleWidth(text) <= width);
	}
	assert.doesNotMatch(renderShellHeaderBar(buildShellHeaderModel(data), plainTheme, 160).text, /1 job/);
	assert.doesNotMatch(renderShellHeaderBar(buildShellHeaderModel(model({ jobs: [] }), true), plainTheme, 160).text, /jobs?/);
});

test("bottom-only and hidden below-input chrome retain a compact jobs count", (t) => {
	const data = model({ jobs: [{ id: "job-1", label: "CI for PR 1860", startedAt: 1 }] });
	assert.match(renderShellBottomOnlyBar(data, plainTheme, 80).join("\n"), /⧗ 1 job/);
	useCardStyle(t, CARD_STYLE.FLOAT);
	const settings = { ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "below-input" as const, statusPlacement: "hidden" as const };
	const rows = renderShellBelowInputFloat(data, withBackground(plainTheme), 80, undefined, settings)?.rows;
	assert.ok(rows);
	assert.match(rows.join("\n"), /⧗ 1 job/);
	assert.doesNotMatch(rows.join("\n"), /CI for PR/);
	assert.ok(rows.every((line) => visibleWidth(line) <= 80));
});

test("Status title stays plain without an active review", () => {
	const lines = renderShellSidebarBar(model(), plainTheme, 60);
	assert.match(lines[0], /^╭─ ✿ Status ─+╮$/);
	assert.doesNotMatch(lines.slice(1).join("\n"), /🌹 RDD/);
});

test("Status title stays plain above the review lifecycle block", () => {
	const lines = renderShellSidebarBar(model({ review: { state: "reviewing", scope: "first.ts +2 files" } }), plainTheme, 60);
	assert.match(lines[0], /^╭─ ✿ Status ─+╮$/);
	assert.match(lines.slice(1).join("\n"), /🌹 RDD[\s\S]*Reviewers running…[\s\S]*first\.ts \+2 files/);
});

test("review lifecycle block omits the scope line when the candidate scope is unknown", () => {
	const known = renderShellSidebarBar(model({ review: { state: "checking", scope: "first.ts" } }), plainTheme, 60);
	const unknown = renderShellSidebarBar(model({ review: { state: "checking", scope: REVIEW_SCOPE_UNAVAILABLE } }), plainTheme, 60);
	const text = unknown.join("\n");
	assert.match(text, /🌹 RDD[\s\S]*Updating…/);
	assert.doesNotMatch(text, /Candidate scope unavailable/);
	assert.equal(unknown.length, known.length - 1);
});

test("rdd visibility hides only the review lifecycle block", () => {
	const data = model({ review: { state: "reviewing", scope: "first.ts +2" }, changes: { files: 2, added: 1, deleted: 1 } });
	assert.match(renderShellSidebarBar(data, plainTheme, 60, DEFAULT_VISUAL_SETTINGS).join("\n"), /🌹 RDD[\s\S]*Reviewers running…/);
	const hidden = renderShellSidebarBar(data, plainTheme, 60, { ...DEFAULT_VISUAL_SETTINGS, visibility: { ...DEFAULT_VISUAL_SETTINGS.visibility, rdd: false } }).join("\n");
	assert.doesNotMatch(hidden, /🌹 RDD|Reviewers running|first\.ts \+2 files/);
	assert.match(hidden, /Changes[\s\S]*2 files/);
});

test("Status and review lifecycle block respect terminal width", () => {
	for (const width of [8, 12, 16, 20, 32, 60]) {
		for (const review of [undefined, { state: "reviewing" as const, scope: "first.ts +2 files" }, { state: "approved" as const, scope: REVIEW_SCOPE_UNAVAILABLE }]) {
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

test("the sidebar Status card in the float style is a float panel two rows taller than neon, with a separator row after the header", (t) => {
	const theme = withBackground(plainTheme);
	const neon = renderShellSidebarBar(model({ review: { state: "reviewing", scope: "first.ts +2 files" } }), theme, 60);
	useCardStyle(t, CARD_STYLE.FLOAT);
	const float = renderShellSidebarBar(model({ review: { state: "reviewing", scope: "first.ts +2 files" } }), theme, 60);
	assert.equal(float.length, neon.length + 2);
	assert.equal(stripAnsi(float[1]!), ` ▎ ✿ Status${" ".repeat(49)}`);
	assert.equal(stripAnsi(float[2]!), ` ▎${" ".repeat(57)} `, "a blank separator row follows the header");
	assertFloatRows(float, 60);
	assert.deepEqual(float.slice(3, -1).map(bodyText), neon.slice(1, -1).map(bodyText));
});

// The float top bar has full-width painted padding above and below its
// content, followed by a transparent bottom edge. Neon keeps two rows.

// The left inset before the header content.
const FLOAT_HEADER_OFFSET = 2;
// Both insets around the content.
const FLOAT_HEADER_CHROME = 4;

test("renderShellHeaderBar in the float style is one full-width background row", (t) => {
	const theme = withBackground(plainTheme);
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	// Without a background the header keeps the neon cascade, even in the float style.
	const neonInner = renderShellHeaderBar(header, plainTheme, 140 - FLOAT_HEADER_CHROME, "alt+u");
	useCardStyle(t, CARD_STYLE.FLOAT);
	const float = renderShellHeaderBar(header, theme, 140, "alt+u");
	assert.equal(float.text.split("\n").length, 1, "the header stays one row tall");
	assert.equal(visibleWidth(float.text), 140);
	// The background reaches both edges: no side rules and no unpainted cell.
	assert.ok(float.text.startsWith(`${BG_OPEN}  `) && float.text.endsWith(`${BG_OPEN} ${BG_CLOSE}`), `painted edge to edge: ${JSON.stringify(float.text)}`);
	assert.equal(stripAnsi(float.text), `  ${neonInner.text}  `);
});

test("renderShellHeaderBar draws no float side rules", (t) => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	useCardStyle(t, CARD_STYLE.FLOAT);
	const { text } = renderShellHeaderBar(header, withBackground(taggedTheme), 140, "alt+u");
	assert.ok(!text.includes("│"), `no side rules: ${JSON.stringify(text.slice(0, 40))}`);
});

test("renderShellHeaderBar shifts the float usage span past its two-column inset", (t) => {
	const theme = withBackground(plainTheme);
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	useCardStyle(t, CARD_STYLE.FLOAT);
	for (const width of [140, 100, 90]) {
		const { text, usageSpan } = renderShellHeaderBar(header, theme, width, "alt+u");
		const neonInner = renderShellHeaderBar(header, plainTheme, width - FLOAT_HEADER_CHROME, "alt+u");
		assert.deepEqual(usageSpan, neonInner.usageSpan && { start: neonInner.usageSpan.start + FLOAT_HEADER_OFFSET, end: neonInner.usageSpan.end + FLOAT_HEADER_OFFSET });
		if (!usageSpan) continue;
		const plain = stripAnsi(text);
		assert.match(plain.slice(usageSpan.start, usageSpan.end), /^usage/);
		assert.equal(usageSpan.end, visibleWidth(plain) - FLOAT_HEADER_OFFSET, "the usage segment ends before the right inset");
	}
});

test("renderShellHeaderRule in the float style closes the tab with a top-hugging edge line", (t) => {
	const theme = withBackground(taggedTheme);
	useCardStyle(t, CARD_STYLE.FLOAT);
	// `▔` sits at the top of its cell, touching the tab background with no gap and no painted overshoot below it.
	assert.equal(renderShellHeaderRule(theme, 40), `<border>${"▔".repeat(40)}</border>`);
	assert.equal(renderShellHeaderRule(theme, 0), renderShellHeaderRule(taggedTheme, 0), "a zero width keeps the neon rule");
});

test("the float header keeps the neon output below the float minimum width or without a background", (t) => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	const neonNarrow = renderShellHeaderBar(header, withBackground(plainTheme), 9, "alt+u");
	const neonWide = renderShellHeaderBar(header, plainTheme, 140, "alt+u");
	const neonRule = renderShellHeaderRule(taggedTheme, 9);
	useCardStyle(t, CARD_STYLE.FLOAT);
	assert.deepEqual(renderShellHeaderBar(header, withBackground(plainTheme), 9, "alt+u"), neonNarrow, "width < 10 falls back to neon");
	assert.deepEqual(renderShellHeaderBar(header, plainTheme, 140, "alt+u"), neonWide, "a theme without bg falls back to neon");
	assert.equal(renderShellHeaderRule(withBackground(taggedTheme), 9), neonRule);
	assert.equal(renderShellHeaderRule(taggedTheme, 40), "<border>" + "─".repeat(40) + "</border>");
});

test("neon header bar and rule are byte-identical with a background-capable theme", () => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	for (const width of [140, 100, 60, 12]) {
		assert.deepEqual(renderShellHeaderBar(header, withBackground(taggedTheme), width, "alt+u"), renderShellHeaderBar(header, taggedTheme, width, "alt+u"));
		assert.equal(renderShellHeaderRule(withBackground(taggedTheme), width), "<border>" + "─".repeat(width) + "</border>");
	}
});

test("float header chrome shares padded geometry with usage hit-testing", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	const theme = withBackground(plainTheme);
	for (const width of [10, 40, 90, 100, 140, 140.9]) {
		const chrome = renderShellHeaderChrome(header, theme, width, "alt+u");
		const target = Math.floor(width);
		assert.equal(chrome.headerRow, 1);
		assert.equal(chrome.rows.length, 4, "padding, content, padding, transparent edge");
		assert.equal(chrome.rows[0], `${BG_OPEN}${" ".repeat(target)}${BG_CLOSE}`);
		assert.equal(chrome.rows[2], chrome.rows[0]);
		assert.equal(chrome.rows[1], renderShellHeaderBar(header, theme, width, "alt+u").text);
		assert.equal(chrome.rows[3], "▔".repeat(target));
		for (const row of chrome.rows) {
			assert.equal(visibleWidth(row), target);
			assert.doesNotMatch(stripAnsi(row), /[│▎╭╮╰╯└┘]/u, "no side rules");
		}
		const span = chrome.usageSpan;
		if (!span) {
			assert.equal(shellHeaderUsageHit(chrome, 0, 1), false, "hidden usage never clicks");
			continue;
		}
		assert.match(stripAnsi(chrome.rows[chrome.headerRow]!).slice(span.start, span.end), /^usage/);
		for (const y of [-1, 0, 2, 3, 4]) assert.equal(shellHeaderUsageHit(chrome, span.start, y), false, `decorative row ${y}`);
		assert.equal(shellHeaderUsageHit(chrome, span.start - 1, 1), false);
		assert.equal(shellHeaderUsageHit(chrome, span.start, 1), true);
		assert.equal(shellHeaderUsageHit(chrome, span.end - 1, 1), true);
		assert.equal(shellHeaderUsageHit(chrome, span.end, 1), false, "exclusive end");
	}
});

test("float header paints every available cell even after ANSI resets", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const theme = withBackground({
		fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[0m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[m`,
	});
	const header = buildShellHeaderModel(model({ cwd: "directory " + "x".repeat(180) }));
	for (const width of [10, 40, 90, 140]) {
		const { rows } = renderShellHeaderChrome(header, theme, width, "alt+u");
		for (const [index, row] of rows.entries()) {
			let painted = false;
			let columns = 0;
			for (const token of row.split(/(\x1b\[[\d;]*m)/u)) {
				if (token.startsWith("\x1b")) {
					if (token === BG_OPEN) painted = true;
					if (/^\x1b\[(?:0|49)?m$/u.test(token)) painted = false;
				} else if (token) {
					assert.equal(painted, index !== 3, `row ${index} at width ${width}: ${JSON.stringify(token)}`);
					columns += visibleWidth(token);
				}
			}
			assert.equal(columns, width, "background reaches both terminal edges");
		}
	}
});

test("float header usage clicks move to row one and reject row zero", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const chrome = renderShellHeaderChrome(buildShellHeaderModel(model()), withBackground(plainTheme), 140, "alt+u");
	assert.ok(chrome.usageSpan);
	assert.equal(shellHeaderUsageHit(chrome, chrome.usageSpan.start, 1), true, "content row is clickable");
	assert.equal(shellHeaderUsageHit(chrome, chrome.usageSpan.start, 0), false, "top padding is decorative");
});

test("header chrome preserves neon bytes and row-zero interactions for every fallback", (t) => {
	const header = buildShellHeaderModel(model());
	const theme = withBackground(plainTheme);
	for (const width of [-3, 0, 9, 10, 90, 140]) {
		setCardStyle(CARD_STYLE.NEON);
		const neon = renderShellHeaderChrome(header, theme, width, "alt+u");
		assert.deepEqual(neon.rows, [renderShellHeaderBar(header, plainTheme, width, "alt+u").text, renderShellHeaderRule(plainTheme, width)]);
		assert.equal(neon.headerRow, 0);
		if (neon.usageSpan) {
			assert.equal(shellHeaderUsageHit(neon, neon.usageSpan.start, 0), true);
			assert.equal(shellHeaderUsageHit(neon, neon.usageSpan.start, 1), false);
		}
		useCardStyle(t, CARD_STYLE.FLOAT);
		for (const fallback of [
			plainTheme,
			{ ...plainTheme, bg: (_color: string, text: string) => text },
			{ ...plainTheme, bg: () => { throw new Error("missing theme token"); } },
		]) assert.deepEqual(renderShellHeaderChrome(header, fallback, width, "alt+u"), neon, "missing background falls back");
		if (width < 10) assert.deepEqual(renderShellHeaderChrome(header, theme, width, "alt+u"), neon, "narrow fallback");
	}
});

test("below-input float chrome mirrors only the edge and moves usage clicks to row two", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	const theme = withBackground(plainTheme);
	const presentation = { ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "below-input" as const };
	for (const width of [10, 40, 90, 100, 140, 140.9]) {
		const above = renderShellHeaderChrome(header, theme, width, "alt+u");
		const below = renderShellHeaderChrome(header, theme, width, "alt+u", presentation);
		assert.deepEqual(below.rows, ["▁".repeat(Math.floor(width)), ...above.rows.slice(0, 3)]);
		assert.equal(below.headerRow, 2);
		assert.deepEqual(below.usageSpan, above.usageSpan);
		if (!below.usageSpan) {
			assert.equal(shellHeaderUsageHit(below, 0, 2), false);
			continue;
		}
		const { start, end } = below.usageSpan;
		for (const y of [-1, 0, 1, 3, 4]) assert.equal(shellHeaderUsageHit(below, start, y), false);
		assert.equal(shellHeaderUsageHit(below, start, 2), true);
		assert.equal(shellHeaderUsageHit(below, end - 1, 2), true);
		assert.equal(shellHeaderUsageHit(below, start - 1, 2), false);
		assert.equal(shellHeaderUsageHit(below, end, 2), false);
	}
});

test("below-input placement preserves neon and float fallback bytes", (t) => {
	const header = buildShellHeaderModel(model());
	const presentation = { ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "below-input" as const };
	useCardStyle(t, CARD_STYLE.NEON);
	for (const width of [0, 9, 10, 100, 140]) {
		const theme = withBackground(plainTheme);
		const neon = renderShellHeaderChrome(header, theme, width, "alt+u");
		const data = model({ statuses: ["mcp ok"] });
		const bottom = renderShellBottomOnlyBar(data, theme, width, "alt+u");
		assert.deepEqual(renderShellHeaderChrome(header, theme, width, "alt+u", presentation), neon);
		assert.deepEqual(renderShellBottomOnlyBar(data, theme, width, "alt+u", presentation), bottom);
		setCardStyle(CARD_STYLE.FLOAT);
		assert.deepEqual(renderShellHeaderChrome(header, plainTheme, width, "alt+u", presentation), neon);
		assert.deepEqual(renderShellBottomOnlyBar(data, plainTheme, width, "alt+u", presentation), bottom);
		if (width < 10) {
			assert.deepEqual(renderShellHeaderChrome(header, theme, width, "alt+u", presentation), neon);
			assert.deepEqual(renderShellBottomOnlyBar(data, theme, width, "alt+u", presentation), bottom);
		}
		setCardStyle(CARD_STYLE.NEON);
	}
});

test("below-input bottom-only float bar retains mirrored padding and extension statuses", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const theme = withBackground(plainTheme);
	const presentation = { ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "below-input" as const };
	for (const width of [10, 60, 80, 100]) {
		for (const statuses of [[], ["mcp ok", "notice\nready"]]) {
			const data = model({ usage: USAGE_TWO_WINDOWS, statuses });
			const rows = renderShellBottomOnlyBar(data, theme, width, "alt+u", presentation);
			const chrome = renderShellHeaderChrome(buildShellHeaderModel(data), theme, width, "alt+u", presentation);
			assert.deepEqual(rows.slice(0, 3), chrome.rows.slice(0, 3));
			assert.equal(rows.length, statuses.length ? 5 : 4);
			assert.equal(rows.at(-1), chrome.rows.at(-1), "padding closes the entire group");
			if (statuses.length) {
				assert.match(stripAnsi(rows[3]!), width === 10 ? /^  mcp o…/ : /^  mcp ok/);
				assert.ok(rows[3]!.startsWith(BG_OPEN), "statuses share the full-width background");
			}
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
		}
	}
});

test("unified below-input float includes optional Changes and sanitized statuses inside one painted group", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const theme = withBackground({ ...plainTheme, fg: (_role: string, text: string) => `\x1b[31m${text}\x1b[0m` });
	const presentation = { ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "below-input" as const };
	const changes = { files: [{ path: "lib/live.ts", added: 3, deleted: 1, status: "modified" as const }], added: 3, deleted: 1 };
	for (const width of [10, 40, 139, 140, 240]) {
		for (const captured of [undefined, { files: [], added: 0, deleted: 0 }, changes]) {
			for (const statuses of [[], ["\x1b[31mMCP\x1b[0m\nready\t now", "notice"]]) {
				const chrome = renderShellBelowInputFloat(model({ statuses }), theme, width, "alt+u", presentation, captured)!;
				const hasChanges = Boolean(captured?.files.length);
				assert.equal(chrome.headerRow, hasChanges ? 3 : 2);
				assert.equal(chrome.rows.length, 4 + Number(hasChanges) + Number(statuses.length > 0));
				assert.equal(stripAnsi(chrome.rows[0]!), "▁".repeat(width));
				for (const row of chrome.rows.slice(1)) {
					let painted = false;
					for (const token of row.split(/(\x1b\[[\d;]*m)/u)) {
						if (token === BG_OPEN) painted = true;
						else if (/^\x1b\[(?:0|49)?m$/u.test(token)) painted = false;
						else if (token && !token.startsWith("\x1b")) assert.equal(painted, true, JSON.stringify(token));
					}
					assert.equal(visibleWidth(row), width);
				}
				if (width === 240 && hasChanges) assert.match(stripAnsi(chrome.rows[2]!), /^  .*lib\/live.ts/);
				if (width >= 40 && statuses.length) assert.match(stripAnsi(chrome.rows.at(-2)!), /^  MCP ready now ⟡ notice/);
				if (chrome.usageSpan) {
					assert.equal(shellHeaderUsageHit(chrome, chrome.usageSpan.start, chrome.headerRow), true);
					for (let y = 0; y < chrome.rows.length; y++) if (y !== chrome.headerRow) assert.equal(shellHeaderUsageHit(chrome, chrome.usageSpan.start, y), false);
				}
			}
		}
	}
	const hidden = renderShellBelowInputFloat(model({ statuses: ["secret status"] }), theme, 140, "alt+u", { ...presentation, statusPlacement: "hidden", visibility: { ...presentation.visibility, changes: false } }, changes)!;
	assert.equal(hidden.rows.length, 4);
	assert.equal(hidden.headerRow, 2);
	assert.doesNotMatch(stripAnsi(hidden.rows.join("\n")), /secret status|live.ts/);
	for (const width of [9, 10]) {
		assert.equal(renderShellBelowInputFloat(model(), plainTheme, width, "alt+u", presentation, changes), undefined);
		if (width === 9) assert.equal(renderShellBelowInputFloat(model(), theme, width, "alt+u", presentation, changes), undefined);
	}
	assert.equal(renderShellBelowInputFloat(model(), theme, 140, "alt+u", DEFAULT_VISUAL_SETTINGS, changes), undefined);
	setCardStyle(CARD_STYLE.NEON);
	assert.equal(renderShellBelowInputFloat(model(), theme, 140, "alt+u", presentation, changes), undefined);
});

test("the narrow-layout bottom-only bar stays unchanged in the float style", (t) => {
	const theme = withBackground(taggedTheme);
	const data = model({ usage: USAGE_TWO_WINDOWS, statuses: ["mcp ok"] });
	const neon = renderShellBottomOnlyBar(data, theme, 100, "alt+u");
	useCardStyle(t, CARD_STYLE.FLOAT);
	assert.deepEqual(renderShellBottomOnlyBar(data, theme, 100, "alt+u"), neon);
});
