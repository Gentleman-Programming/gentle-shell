import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BRAND_FRAMES, BRAND_GLYPH } from "../lib/brand-glyph.ts";
import { buildShellHeaderModel, renderShellBar, renderShellHeaderBar, SHELL_BAR_BRAND, type ShellBarModel, type ShellBarTheme } from "../lib/shell-bar.ts";
import { CARD_STYLE, CARD_TONE, cardStyle, renderCard, setCardStyle } from "../lib/shell-card.ts";
import { renderPanelSheet } from "../lib/shell-panel.ts";
import { PROMPT_STATE, framePromptLines, petalGlyph } from "../lib/shell-prompt.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// Identidad de marca compartida: el glifo es el emoji de dragón de dos celdas y
// ninguna superficie propia muestra flores heredadas ni desborda el ancho.

const plainTheme: ShellBarTheme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
};

const taggedTheme: ShellBarTheme = {
	fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
	bold: (value: string) => value,
};

// El estilo de tarjeta por defecto es float; estas aserciones fijan el marco
// contorneado (neon) salvo que la prueba cambie el estilo.
const initialCardStyle = cardStyle();
before(() => setCardStyle(CARD_STYLE.NEON));
after(() => setCardStyle(initialCardStyle));

const HEREDADAS = /[✿❀❁✾]/u;

function model(overrides: Partial<ShellBarModel> = {}): ShellBarModel {
	return {
		cwd: "~/work/drakonc-pi",
		branch: "main",
		dirty: undefined,
		sessionName: "Review",
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

/** Cada superficie propia que pinta el glifo de marca, con el ancho pedido. */
function surfaces(width: number): Array<[string, string[]]> {
	const data = model();
	const promptOptions = { state: PROMPT_STATE.IDLE, tick: 0, borderColor: (text: string) => text, fg: (_color: string, text: string) => text };
	const promptLines = ["─".repeat(width - 2), ` ${" ".repeat(Math.max(0, width - 3))}`, "─".repeat(width - 2)];
	const parts = new Map([["footer", { render: (inner: number) => [`${BRAND_GLYPH} panel body`.padEnd(inner)] }]]);
	return [
		["barra", renderShellBar(data, plainTheme, width)],
		["encabezado", [renderShellHeaderBar(buildShellHeaderModel(data), plainTheme, width).text]],
		["prompt", framePromptLines(promptLines, width, promptOptions)],
		["panel", renderPanelSheet(parts, plainTheme, width, { rows: 6, scrollTop: 0 }).lines],
		["tarjeta", renderCard({ title: "Drakonc AI", body: ["one"], tone: CARD_TONE.INFO }, plainTheme, width, { expanded: true })],
	];
}

test("el glifo de marca y cada fotograma miden dos celdas y no llevan selector de variación", () => {
	assert.equal(BRAND_GLYPH, "🐉");
	assert.equal(BRAND_GLYPH, "\u{1F409}");
	assert.deepEqual([...BRAND_GLYPH].map((char) => char.codePointAt(0)), [0x1f409]);
	for (const frame of BRAND_FRAMES) {
		assert.equal([...frame].length, 1, `"${frame}" es un único punto de código`);
		assert.equal(visibleWidth(frame), 2, `"${frame}" ocupa dos celdas`);
		assert.doesNotMatch(frame, /\uFE0F|\uFE0E|\u200D/u, `"${frame}" no lleva selectores ni ZWJ`);
	}
	assert.deepEqual([...BRAND_FRAMES], ["🐉", "🔥"]);
	assert.deepEqual([...BRAND_FRAMES].map((frame) => frame.codePointAt(0)), [0x1f409, 0x1f525]);
	assert.equal(visibleWidth(BRAND_GLYPH), 2);
	assert.equal(visibleWidth(petalGlyph(PROMPT_STATE.IDLE, 0)), 2);
	for (const tick of [0, 1, 2, 3]) assert.equal(visibleWidth(petalGlyph(PROMPT_STATE.WORKING, tick)), 2);
});

test("el nombre de marca de la barra conserva el glifo y no aparecen flores heredadas", () => {
	assert.equal(SHELL_BAR_BRAND, "🐉 drakonc shell");
	for (const width of [40, 80, 120]) {
		for (const [name, lines] of surfaces(width)) {
			assert.doesNotMatch(stripAnsi(lines.join("\n")), HEREDADAS, `${name} a ${width} columnas`);
		}
	}
});

test("ninguna línea con el glifo desborda el ancho en 40, 80 y 120 columnas", () => {
	for (const width of [40, 80, 120]) {
		for (const [name, lines] of surfaces(width)) {
			for (const line of lines) {
				assert.ok(visibleWidth(stripAnsi(line)) <= width, `${name} a ${width}: "${stripAnsi(line)}" ocupa ${visibleWidth(stripAnsi(line))}`);
			}
		}
	}
});

test("drakonc/Drakonc usa el rol de acento y shell/Shell el rol de texto", () => {
	const bar = renderShellBar(model(), taggedTheme, 160).join("\n");
	assert.match(bar, /<accent>🐉 drakonc<\/accent> <text>shell<\/text>/);
	const header = renderShellHeaderBar(buildShellHeaderModel(model()), taggedTheme, 160).text;
	assert.match(header, /<accent>🐉 Drakonc<\/accent> <text>Shell<\/text>/);
	assert.doesNotMatch(header, /<accent>🐉 Drakonc Shell<\/accent>/);
});
