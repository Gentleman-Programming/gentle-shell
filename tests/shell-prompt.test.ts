import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../lib/terminal-theme.ts";
import {
	framePromptLines,
	scanWorkingText,
	PROMPT_STATE,
	petalGlyph,
	petalTone,
	SHELL_PULSE_MS,
	SHELL_SCANNER_STEPS,
	withPromptHint,
	type PromptFrameOptions,
} from "../lib/shell-prompt.ts";

test("scanner reflects a symmetric light wave across working text at Pi's original cadence", () => {
	const fg = (role: string, char: string) => `<${role}>${char}</${role}>`;
	assert.equal(SHELL_PULSE_MS, 80);
	assert.equal(SHELL_SCANNER_STEPS, 15);
	for (const word of ["working…", "Thinking…"]) {
		for (let tick = 0; tick < SHELL_SCANNER_STEPS; tick++) {
			const frame = scanWorkingText(word, tick, fg);
			assert.equal(frame.replace(/<[^>]+>/g, ""), word);
		}
		assert.match(scanWorkingText(word, 0, fg), /^(<muted>.<\/muted>)+$/);
		assert.match(scanWorkingText(word, 3, fg), new RegExp(`^<borderAccent>${word[0]}</borderAccent><accent>${word[1]}</accent><thinkingHigh>${word[2]}</thinkingHigh>`));
		assert.match(scanWorkingText(word, 4, fg), new RegExp(`^<accent>${word[0]}</accent><borderAccent>${word[1]}</borderAccent><accent>${word[2]}</accent>`));
		assert.match(scanWorkingText(word, 5, fg), new RegExp(`^<thinkingHigh>${word[0]}</thinkingHigh><accent>${word[1]}</accent><borderAccent>${word[2]}</borderAccent>`));
		assert.match(scanWorkingText(word, 14, fg), /^(<muted>.<\/muted>)+$/);
		assert.equal(scanWorkingText(word, SHELL_SCANNER_STEPS, fg), scanWorkingText(word, 0, fg));
	}
	for (const width of [1, 8, 20, 40]) {
		for (let tick = 0; tick < SHELL_SCANNER_STEPS; tick++) {
			const lines = framePromptLines(editorLines(Math.max(4, width)), width, options({ state: PROMPT_STATE.WORKING, tick, fg: (_role, text) => text }));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	}
});

test("compact banner pulse rises from ink through fresh color to a bright tip then fades", () => {
	const tones = Array.from({ length: 8 }, (_, tick) => petalTone(PROMPT_STATE.WORKING, tick));
	assert.deepEqual(tones, ["mdQuoteBorder", "thinkingHigh", "accent", "borderAccent", "accent", "thinkingHigh", "mdQuoteBorder", "mdQuoteBorder"]);
	assert.equal(petalTone(PROMPT_STATE.WORKING, 8), tones[0]);
});

// The Gentle Shell prompt wraps pi's editor output (a top rule, padded content
// lines, a bottom rule) in a rounded frame with a petal that shows the agent
// state. Framing is pure: it takes the editor's lines and returns new ones.

const CURSOR = "\x1b[7m \x1b[0m";

function options(overrides: Partial<PromptFrameOptions> = {}): PromptFrameOptions {
	return {
		state: PROMPT_STATE.IDLE,
		tick: 0,
		borderColor: (text) => text,
		fg: (color, text) => `<${color}>${text}</${color}>`,
		...overrides,
	};
}

test("framePromptLines sets the petal in bold when the theme offers it", () => {
	const lines = framePromptLines(editorLines(40), 40, options({ bold: (text) => `*${text}*` }));
	assert.match(lines[0], /<borderAccent>\*✿\*<\/borderAccent>/);
});

function editorLines(width: number, content: string[] = [` ${CURSOR}`]): string[] {
	const inner = width - 2;
	return ["─".repeat(inner), ...content.map((line) => line + " ".repeat(inner - visibleWidth(line))), "─".repeat(inner)];
}

test("framePromptLines draws rounded corners, side rules, and keeps every line at width", () => {
	const width = 40;
	const lines = framePromptLines(editorLines(width), width, options({ fg: (_c, t) => t }));
	assert.equal(lines.length, 3);
	for (const line of lines) assert.equal(visibleWidth(line), width, `line "${stripAnsi(line)}" is not ${width} wide`);
	assert.match(stripAnsi(lines[0]), /^╭─ ✿ ─+╮$/);
	assert.match(stripAnsi(lines[1]), /^│ .* │$/);
	assert.match(stripAnsi(lines[2]), /^╰─+╯$/);
});

test("framePromptLines paints the frame with the editor border color and the petal with the state tone", () => {
	const lines = framePromptLines(editorLines(40), 40, options({ borderColor: (text) => `[b]${text}[/b]`, bold: (text) => `*${text}*` }));
	assert.match(lines[0], /^\[b\]╭─ \[\/b\]<borderAccent>\*✿\*<\/borderAccent>\[b\] ─+╮\[\/b\]$/);
	assert.match(lines[1], /^\[b\]│\[\/b\].*\[b\]│\[\/b\]$/);
	assert.match(lines[2], /^\[b\]╰─+╯\[\/b\]$/);
});

test("petalTone rests bright, walks the rose ramp while working, and turns to warning when queued", () => {
	assert.equal(petalTone(PROMPT_STATE.IDLE, 2), "borderAccent");
	assert.deepEqual([0, 1, 2, 3, 4].map((tick) => petalTone(PROMPT_STATE.WORKING, tick)), ["mdQuoteBorder", "thinkingHigh", "accent", "borderAccent", "accent"]);
	assert.equal(petalTone(PROMPT_STATE.QUEUED, 1), "warning");
});

test("petalGlyph spins through the flowers while working and rests otherwise", () => {
	assert.equal(petalGlyph(PROMPT_STATE.IDLE, 3), "✿");
	assert.deepEqual([0, 1, 2, 3, 4].map((tick) => petalGlyph(PROMPT_STATE.WORKING, tick)), ["✿", "❀", "❁", "✾", "✿"]);
	assert.equal(petalGlyph(PROMPT_STATE.QUEUED, 1), "❀");
});

test("framePromptLines scans the working word while preserving the frame and queued state", () => {
	const plain = (_color: string, text: string) => text;
	const working = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.WORKING, tick: 3 }));
	assert.match(working[0], /<borderAccent>✾<\/borderAccent>/);
	assert.match(working[0], /<borderAccent>w<\/borderAccent><accent>o<\/accent><thinkingHigh>r<\/thinkingHigh>/);
	assert.equal(working[0].replace(/<[^>]+>/g, "").includes("working…"), true);
	const workingPlain = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.WORKING, tick: 3, fg: plain }));
	assert.match(stripAnsi(workingPlain[0]), /^╭─ ✾ working… ─+╮$/);
	assert.equal(visibleWidth(workingPlain[0]), 40);

	const queued = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.QUEUED }));
	assert.match(queued[0], /<warning>✿<\/warning>/);
	assert.match(queued[0], /<muted>queued<\/muted>/);
	const queuedPlain = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.QUEUED, fg: plain }));
	assert.match(stripAnsi(queuedPlain[0]), /^╭─ ✿ queued ─+╮$/);
	assert.equal(visibleWidth(queuedPlain[0]), 40);
});

test("framePromptLines keeps the editor scroll indicators inside the frame", () => {
	const width = 40;
	const inner = width - 2;
	const top = `─── ↑ 2 more ${"─".repeat(inner - 13)}`;
	const bottom = `─── ↓ 3 more ${"─".repeat(inner - 13)}`;
	const lines = framePromptLines([top, ` x${" ".repeat(inner - 2)}`, bottom], width, options({ fg: (_c, t) => t }));
	assert.match(stripAnsi(lines[0]), /^╭─ ✿ ↑ 2 more ─+╮$/);
	assert.match(stripAnsi(lines[2]), /^╰─ ↓ 3 more ─+╯$/);
	for (const line of lines) assert.equal(visibleWidth(line), width);
});

test("withPromptHint places a dim hint after the cursor on an empty editor line", () => {
	const inner = 38;
	const line = ` ${CURSOR}${" ".repeat(inner - 2)}`;
	const hinted = withPromptHint(line, "type, or / for commands", (color, text) => `<${color}>${text}</${color}>`);
	assert.match(hinted, /\x1b\[7m \x1b\[0m <dim>type, or \/ for commands<\/dim> +$/);
	const hintedPlain = withPromptHint(line, "type, or / for commands", (_c, t) => t);
	assert.equal(visibleWidth(hintedPlain), inner);
});

test("withPromptHint leaves the line alone when the hint does not fit", () => {
	const line = ` ${CURSOR}${" ".repeat(6)}`;
	const hinted = withPromptHint(line, "type, or / for commands", (_c, t) => t);
	assert.equal(hinted, line);
});

test("working prompt stays transparent at narrow and normal widths", () => {
	for (const width of [0, 1, 2, 3, 8, 40]) {
		const lines = framePromptLines(["──", ` ${CURSOR}界`, "──"], width, options({
			state: PROMPT_STATE.WORKING, fg: (_c, t) => t,
		}));
		for (const [row, line] of lines.entries()) {
			assert.ok(visibleWidth(line) <= width);
			let bg = false, cell = 0;
			for (const token of line.match(/\x1b\[[\d;]*m|[^\x1b]/gu) ?? []) {
				if (token.startsWith("\x1b")) {
					for (const code of token.slice(2, -1).split(";").map(Number)) {
						if (code === 0 || code === 49) bg = false;
						if (code === 44) bg = true;
					}
				} else {
					assert.equal(bg, false, `row ${row}, cell ${cell} must remain transparent`);
					cell += visibleWidth(token);
				}
			}
			assert.equal(bg, false);
		}
	}
});

test("transparent prompt preserves pi's cursor reset", () => {
	const lines = framePromptLines(editorLines(40), 40, options({ fg: (_c, t) => t }));
	assert.ok(lines[1].includes(CURSOR));
	assert.doesNotMatch(lines.join("\n"), /\x1b\[44m/);
});
