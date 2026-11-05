import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShellHeaderModel, renderShellChromeBar, renderShellHeaderChrome, renderShellStatusBar, shellHeaderUsageHit } from "../lib/shell-bar.ts";
import { chromeSurface, renderPanelSheet, setChromeSurface } from "../lib/shell-panel.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { DEFAULT_VISUAL_SETTINGS, resolveVisualSettings, writeVisualSettings } from "../lib/visual-customization-policy.ts";

const painted = { fg: (_role: string, text: string) => text, bold: (text: string) => text, bg: (role: string, text: string) => `\x1b[48;5;${role === "customMessageBg" ? 171 : 120}m${text}\x1b[49m` };
const model = { cwd: "/repo", branch: "main", dirty: 0, sessionName: "s", modelId: "gpt-5.5", effort: "medium", contextPercent: 45, contextWindow: 1000, costTotal: 0, subscription: true, usage: undefined, statuses: [] };

const unstyled = (rows: string[]) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));

test("a transparent surface keeps the float header's margins and drops only its background", (t) => {
	const [style, surface] = [cardStyle(), chromeSurface()];
	t.after(() => { setCardStyle(style); setChromeSurface(surface); });
	setCardStyle(CARD_STYLE.FLOAT);
	for (const headerPlacement of ["top", "below-input"] as const) {
		const header = () => renderShellHeaderChrome(buildShellHeaderModel(model as never), painted as never, 107, "alt+u", { ...DEFAULT_VISUAL_SETTINGS, headerPlacement });
		setChromeSurface("tinted");
		const tinted = header();
		assert.match(tinted.rows.join("\n"), /\x1b\[48;5;\d+m/, `${headerPlacement}: the tinted float header keeps its card`);
		setChromeSurface("transparent");
		const clear = header();
		assert.doesNotMatch(clear.rows.join("\n"), /\x1b\[48;5;\d+m/, `${headerPlacement}: no background`);
		assert.deepEqual(unstyled(clear.rows), unstyled(tinted.rows), `${headerPlacement}: same rows, margins and text`);
		assert.equal(clear.headerRow, tinted.headerRow);
		assert.deepEqual(clear.usageSpan, tinted.usageSpan, `${headerPlacement}: the usage click target does not move`);
	}
});

test("the chrome bar is the split status bar row, centered between two painted margin rows when comfortable", (t) => {
	const [style, surface] = [cardStyle(), chromeSurface()];
	t.after(() => { setCardStyle(style); setChromeSurface(surface); });
	const barModel = { ...model, permission: { mode: "SUPER-YOLO" } };
	for (const cards of [CARD_STYLE.FLOAT, CARD_STYLE.NEON]) {
		setCardStyle(cards);
		setChromeSurface("tinted");
		const status = renderShellStatusBar(barModel as never, painted as never, 110, "alt+u", DEFAULT_VISUAL_SETTINGS);
		const below = renderShellChromeBar(barModel as never, painted as never, 110, "alt+u", DEFAULT_VISUAL_SETTINGS, undefined);
		assert.deepEqual(below.rows[1], status.rows[0], `${cards}: the same row as the split status bar`);
		assert.equal(below.rows.length, 3, `${cards}: a margin row on each side centers the bar's text`);
		assert.equal(below.headerRow, 1);
		assert.deepEqual(below.rows[0], below.rows[2], `${cards}: both margin rows are the same blank chrome row`);
		for (const row of below.rows) assert.match(row, /\x1b\[48;5;171m/, `${cards}: the margin row is painted like the bar`);
		const text = unstyled(below.rows)[1]!;
		assert.match(text, /💥 SUPER-YOLO/);
		assert.ok(shellHeaderUsageHit(below, text.indexOf("usage"), 1), "usage stays clickable on the bar row");
		assert.equal(shellHeaderUsageHit(below, text.indexOf("usage"), 0), false, "the margins are not targets");
		assert.equal(shellHeaderUsageHit(below, text.indexOf("usage"), 2), false);
		for (const density of ["compact", "minimal"] as const) {
			assert.equal(renderShellChromeBar(barModel as never, painted as never, 110, "alt+u", { ...DEFAULT_VISUAL_SETTINGS, density }, undefined).rows.length, 1, `${cards}: ${density} has no margin row`);
		}
		setChromeSurface("transparent");
		const clear = renderShellChromeBar(barModel as never, painted as never, 110, "alt+u", DEFAULT_VISUAL_SETTINGS, undefined);
		assert.doesNotMatch(clear.rows.join("\n"), /\x1b\[48;5;\d+m/, `${cards}: transparent floats it`);
		assert.deepEqual(unstyled(clear.rows), unstyled(below.rows));
	}
});

test("the panel sheet follows the chrome surface", (t) => {
	const surface = chromeSurface();
	t.after(() => setChromeSurface(surface));
	const parts = new Map([["footer", { render: () => ["Status row"] }]]);
	const sheet = () => renderPanelSheet(parts as never, painted as never, 60, { rows: 10, scrollTop: 0 } as never).lines.join("\n");
	setChromeSurface("tinted");
	assert.match(sheet(), /\x1b\[48;5;171m/);
	setChromeSurface("transparent");
	assert.doesNotMatch(sheet(), /\x1b\[48;5;171m/);
});

test("invalid surface or header writes keep the stored file byte-identical", () => {
	const home = mkdtempSync(join(tmpdir(), "visual-invalid-"));
	try {
		writeVisualSettings({ ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "split", surface: "transparent" }, { gentlePiConfigHome: home });
		const file = join(home, "visual-customization.json");
		const before = readFileSync(file, "utf8");
		for (const bad of [{ surface: "glass" }, { surface: "Transparent" }, { headerPlacement: "above-input" }]) {
			assert.throws(() => writeVisualSettings({ ...DEFAULT_VISUAL_SETTINGS, ...bad } as never, { gentlePiConfigHome: home }), /Invalid visual settings/);
			assert.equal(readFileSync(file, "utf8"), before);
		}
		const { surface: _surface, ...legacy } = DEFAULT_VISUAL_SETTINGS;
		assert.throws(() => writeVisualSettings(legacy as never, { gentlePiConfigHome: home }));
		assert.equal(resolveVisualSettings({ gentlePiConfigHome: home }).settings.surface, "transparent");
	} finally { rmSync(home, { recursive: true, force: true }); }
});
