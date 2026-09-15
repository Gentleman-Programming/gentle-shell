import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatCost,
	formatTokens,
	gaugeTone,
	renderGauge,
	renderShellBar,
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
		"✿ gentle-pi ⟡ ~/work/gentle-pi main ⟡ gpt-5.5 · medium ⟡ ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub",
	);
});

test("renderShellBar colors the brand, model, effort, and gauge by role", () => {
	const [line] = renderShellBar(model(), taggedTheme, 400);
	assert.match(line, /<accent>✿ gentle-pi<\/accent>/);
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
	assert.match(atFifty, /^✿ gentle-pi/);
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
