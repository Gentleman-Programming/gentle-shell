import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShellHeaderModel, renderShellHeaderChrome } from "../lib/shell-bar.ts";
import { chromeSurface, renderPanelSheet, setChromeSurface } from "../lib/shell-panel.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { DEFAULT_VISUAL_SETTINGS, resolveVisualSettings, writeVisualSettings } from "../lib/visual-customization-policy.ts";

const painted = { fg: (_role: string, text: string) => text, bold: (text: string) => text, bg: (role: string, text: string) => `\x1b[48;5;${role === "customMessageBg" ? 171 : 120}m${text}\x1b[49m` };
const model = { cwd: "/repo", branch: "main", dirty: 0, sessionName: "s", modelId: "gpt-5.5", effort: "medium", contextPercent: 45, contextWindow: 1000, costTotal: 0, subscription: true, usage: undefined, statuses: [] };

test("a transparent surface leaves the float header bar unpainted, and tinted keeps it", (t) => {
	const [style, surface] = [cardStyle(), chromeSurface()];
	t.after(() => { setCardStyle(style); setChromeSurface(surface); });
	setCardStyle(CARD_STYLE.FLOAT);
	const header = () => renderShellHeaderChrome(buildShellHeaderModel(model as never), painted as never, 107, "alt+u", DEFAULT_VISUAL_SETTINGS).rows.join("\n");
	setChromeSurface("tinted");
	assert.match(header(), /\x1b\[48;5;\d+m/, "the tinted float header keeps its card");
	setChromeSurface("transparent");
	assert.doesNotMatch(header(), /\x1b\[48;5;\d+m/);
	assert.match(header(), /gpt-5\.5/, "the header content stays");
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
