import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	CARD_STYLE, CARD_TONE, cardAwaitingResult, cardRunningLine, cardStyle, cardTopRows, markCardResult, renderCard, setCardStyle,
	type Card, type CardStyle, type CardTone,
} from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// Cards are how Gentle notices look: the same rounded frame as the prompt,
// with the title in the notice tone. They collapse to one body line when pi
// asks for it.

const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
};

const taggedTheme = {
	fg(color: string, text: string) {
		return `<${color}>${text}</${color}>`;
	},
};

const ansiTheme = {
	fg(_color: string, text: string) {
		return `\x1b[35m${text}\x1b[0m`;
	},
};

function card(overrides: Partial<Card> = {}): Card {
	return {
		title: "Gentle AI",
		subtitle: "review preflight",
		body: ["Receipt-driven development is enabled, and this worktree holds an unreviewed candidate.", "", "Call the gentle_review tool with inspect and follow the transition it returns."],
		tone: CARD_TONE.INFO,
		...overrides,
	};
}

test("renderCard draws the rounded frame with the title in the top rule and wraps the body inside", () => {
	const lines = renderCard(card(), plainTheme, 48, { expanded: true }).map(stripAnsi);
	assert.match(lines[0], /^╭─ ✿ Gentle AI · review preflight ─+╮$/);
	assert.match(lines[1], /^│ Receipt-driven development is enabled, and +│$/);
	for (const line of lines) assert.equal(visibleWidth(line), 48, `"${line}" is not 48 wide`);
	assert.ok(lines.some((line) => /^│ +│$/.test(line)), "blank body lines keep the frame");
	assert.ok(lines.some((line) => line.includes("gentle_review")), "every paragraph is rendered when expanded");
	assert.match(lines[lines.length - 1], /^╰─+╯$/);
});

test("renderCard collapses to the frame and the first body line with an expand hint", () => {
	const lines = renderCard(card(), plainTheme, 60, { expanded: false }).map(stripAnsi);
	assert.equal(lines.length, 3);
	assert.match(lines[1], /^│ Receipt-driven development is enabled.*… +│$/);
	assert.equal(visibleWidth(lines[1]), 60);
});

test("renderCard uses the card tone across the full frame while preserving content roles", () => {
	// INFO paints the rose frame: the rounded border in the plain border role,
	// the title in accent — the same look every sidebar card already used.
	const info = renderCard(card(), taggedTheme, 80, { expanded: true });
	assert.match(info[0], /^<border>╭<\/border><border>─ <\/border><accent>✿ Gentle AI<\/accent> <muted>·<\/muted> <muted>review preflight<\/muted><border> ─+<\/border><border>╮<\/border>$/);
	assert.match(info[1], /^<border>│<\/border> <text>.*<border>│<\/border>$/);
	assert.match(info[info.length - 1], /^<border>╰<\/border><border>─+╯<\/border>$/);

	const warning = renderCard(card({ tone: CARD_TONE.WARNING, subtitle: undefined }), taggedTheme, 80, { expanded: true });
	assert.match(warning[0], /^<warning>╭<\/warning>/);
	assert.match(warning[0], /<warning>✿ Gentle AI<\/warning>/);
	assert.match(warning[1], /^<warning>│<\/warning> /);
	assert.match(warning[warning.length - 1], /^<warning>╰<\/warning>/);

	const error = renderCard(card({ tone: CARD_TONE.ERROR }), taggedTheme, 80, { expanded: true, hint: "ctrl+o to expand" });
	assert.match(error[0], /^<error>╭<\/error><error>─ <\/error><error>✿ Gentle AI<\/error> <muted>·<\/muted> <muted>review preflight<\/muted><error> ─+<\/error> <dim>ctrl\+o to expand<\/dim> <error>╮<\/error>$/);
	assert.match(error[1], /^<error>│<\/error> <text>.*<error>│<\/error>$/);
	assert.match(error[error.length - 1], /^<error>╰<\/error><error>─+╯<\/error>$/);
	assert.equal(CARD_TONE.SUCCESS, "success");
});

test("renderCard places a hint at the right end of the top rule without background fill", () => {
	const lines = renderCard(card(), plainTheme, 60, { expanded: false, hint: "ctrl+o expand" });
	assert.match(stripAnsi(lines[0]), /^╭─ ✿ Gentle AI · review preflight ─+ ctrl\+o expand ╮$/);
	assert.equal(visibleWidth(lines[0]), 60);

	assert.doesNotMatch(lines.join("\n"), /\x1b\[44m/);
});

test("cards remain transparent across content resets and narrow widths", () => {
	for (const width of [0, 1, 2, 3, 4, 8, 40]) {
		const lines = renderCard(card({ body: ["red\x1b[0m blue", ""] }), ansiTheme, width, { expanded: true });
		for (const [row, line] of lines.entries()) {
			let painted = false, column = 0;
			for (const token of line.match(/\x1b\[[\d;]*m|[^\x1b]/gu) ?? []) {
				if (token.startsWith("\x1b")) {
					for (const code of token.slice(2, -1).split(";").map(Number)) {
						if (code === 0 || code === 49) painted = false;
						if (code === 44) painted = true;
					}
				} else {
					assert.equal(painted, false, `row ${row}, cell ${column}`);
					column += visibleWidth(token);
				}
			}
			assert.equal(painted, false, "background must not leak into host padding");
			assert.equal(visibleWidth(line), width);
		}
	}
});

test("renderCard accepts a custom glyph and an empty body", () => {
	const lines = renderCard(card({ glyph: "✎", body: [] }), plainTheme, 40, { expanded: true }).map(stripAnsi);
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^╭─ ✎ Gentle AI · review preflight ─+╮$/);
	assert.match(lines[1], /^╰─+╯$/);
});

test("renderCard keeps the top rule at width with a two-cell glyph", () => {
	const lines = renderCard(card({ glyph: "\u{1F339}\uFE0E" }), plainTheme, 60, { expanded: false, hint: "ctrl+o expand" });
	for (const line of lines) assert.equal(visibleWidth(line), 60, `"${stripAnsi(line)}" is not 60 wide`);
});

test("renderCard drops the hint before truncating title content", () => {
	const lines = renderCard(card(), plainTheme, 40, { expanded: false, hint: "ctrl+o expand" }).map(stripAnsi);
	assert.equal(lines[0], "╭─ ✿ Gentle AI · review preflight ─────╮");
	assert.ok(!lines[0].includes("ctrl+o"));
	assert.equal(visibleWidth(lines[0]), 40);
});

test("renderCard truncates ANSI-styled title content at display width", () => {
	const lines = renderCard(
		card({ glyph: "\u{1F339}\uFE0E", title: "Gentle AI review", subtitle: "completed · review acknowledge approved" }),
		ansiTheme,
		30,
		{ expanded: false, hint: "ctrl+o to expand" },
	);
	assert.match(stripAnsi(lines[0]), /^╭─ 🌹︎ Gentle AI review.*╮$/);
	assert.ok(!stripAnsi(lines[0]).includes("ctrl+o"));
	for (const line of lines) assert.equal(visibleWidth(line), 30, `"${stripAnsi(line)}" is not 30 wide`);
});

test("tool heading continuation reserves configured hint columns before ANSI and Unicode wrapping", () => {
	const title = "bash $ printf 界e\u0301 alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
	const hint = "\x1b[36mconfigured key to expand\x1b[0m";
	const value = card({ title: `\x1b[1m${title}\x1b[0m`, subtitle: undefined, glyph: "🌹︎", body: [] });
	for (const width of [60, 80, 120]) {
		const lines = cardTopRows(value, ansiTheme, width, hint);
		assert.match(stripAnsi(lines[0]), /configured key to expand ╮$/);
		assert.match(stripAnsi(lines[0]), /^╭─ 🌹︎ bash \$ printf/);
		assert.ok(lines.length > 1, "long heading continues inside the same frame");
		assert.ok(lines.every((line) => visibleWidth(line) === width));
		const content = lines.map(stripAnsi).map((line, index) => index === 0
			? line.replace(/^╭─ 🌹︎ /, "").replace(/ ─+ configured key to expand ╮$/, "")
			: line.replace(/^│ /, "").replace(/ +│$/, "")).join(" ").replace(/\s+/g, " ").trim();
		assert.equal(content, title, "hint reservation must not lose any command text");
	}
	for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
		const lines = cardTopRows(value, ansiTheme, width, hint);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(!lines.some((line) => stripAnsi(line).includes("configured key")));
	}
});

test("tool previews share the frame with a configurable physical-row budget", () => {
	const value = card({ body: ["first useful row", "界🌹e\u0301".repeat(80), "last"], tone: CARD_TONE.ERROR });
	for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8, 24, 100]) {
		const lines = renderCard(value, ansiTheme, width, { expanded: false, previewRows: 3 });
		assert.ok(lines.length <= 5);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		if (width === 0) assert.deepEqual(lines, []);
		if (width === 100) assert.match(stripAnsi(lines[1]), /first useful row/);
	}
	assert.equal(renderCard(card({ body: ["one", "two", "three", "four"] }), plainTheme, 60, { expanded: false, previewRows: 3 }).length, 5);
	const multiline = renderCard(card({ body: ["one\ntwo\nthree\nfour"] }), plainTheme, 60, { expanded: false, previewRows: 3 });
	assert.equal(multiline.length, 5);
	assert.ok(multiline.every((line) => !line.includes("\n")), "each returned row is physically one terminal row");
	assert.doesNotMatch(multiline.join("\n"), /four/);
});

test("legacy renderCard keeps its empty-row shape at nonpositive widths while opt-in previews stay empty", () => {
	// Agents, Todos and Status call renderCard without their own width guard, so
	// their row count at width zero must remain the pre-preview shape: every
	// row is present and empty. Only the opt-in previewRows path returns nothing.
	const paragraphs = card({ subtitle: "2 running", body: ["ab", "", "c d"] });
	const empty = card({ glyph: "✎", subtitle: undefined, body: [], tone: CARD_TONE.WARNING });
	for (const width of [0, -1, -7]) {
		for (const theme of [plainTheme, taggedTheme, ansiTheme]) {
			assert.deepEqual(renderCard(paragraphs, theme, width, { expanded: true }), ["", "", "", "", "", "", ""], `expanded at ${width}`);
			assert.deepEqual(renderCard(paragraphs, theme, width, { expanded: true, hint: "ctrl+o expand" }), ["", "", "", "", "", "", ""], `hinted at ${width}`);
			assert.deepEqual(renderCard(paragraphs, theme, width, { expanded: false }), ["", "", ""], `collapsed at ${width}`);
			assert.deepEqual(renderCard(empty, theme, width, { expanded: true }), ["", ""], `empty body at ${width}`);
			assert.deepEqual(renderCard(paragraphs, theme, width, { expanded: false, previewRows: 3 }), [], `preview at ${width}`);
			assert.deepEqual(renderCard(paragraphs, theme, width, { expanded: true, previewRows: 3 }), [], `expanded preview at ${width}`);
		}
	}
});

test("renderCard never exceeds extremely narrow supplied widths", () => {
	for (const width of [0, 1, 2, 3, 4, 5, 8, 16]) {
		const lines = renderCard(card({ glyph: "\u{1F339}\uFE0E" }), ansiTheme, width, { expanded: true, hint: "ctrl+o to expand" });
		for (const line of lines) assert.equal(visibleWidth(line), width, `"${stripAnsi(line)}" is not ${width} wide`);
	}
});

// Float style: the same rows become a borderless panel. Content cells keep a
// tone-matched background, the frame turns into a tone accent bar and spaces,
// and a one-column margin stays outside the panel on both sides.
const FG_CODE: Record<string, number> = { border: 240, accent: 211, success: 114, warning: 221, error: 203, dim: 245, muted: 244, text: 252 };
const BG_CODE: Record<string, number> = { toolSuccessBg: 22, toolPendingBg: 58, toolErrorBg: 52 };
const floatTheme = {
	fg(color: string, text: string) {
		return `\x1b[38;5;${FG_CODE[color] ?? 250}m${text}\x1b[39m`;
	},
	bg(color: string, text: string) {
		return `\x1b[48;5;${BG_CODE[color] ?? 17}m${text}\x1b[49m`;
	},
};

function withCardStyle<T>(style: CardStyle, run: () => T): T {
	setCardStyle(style);
	try {
		return run();
	} finally {
		setCardStyle(CARD_STYLE.NEON);
	}
}

/** Background code of every visible cell, following resets exactly as a terminal does. */
function cellBackgrounds(line: string): (number | undefined)[] {
	const cells: (number | undefined)[] = [];
	let bg: number | undefined;
	for (const token of line.match(/\x1b\[[\d;]*m|[^\x1b]/gu) ?? []) {
		if (!token.startsWith("\x1b")) {
			for (let cell = 0; cell < visibleWidth(token); cell++) cells.push(bg);
			continue;
		}
		const codes = token.slice(2, -1).split(";").map((code) => (code === "" ? 0 : Number(code)));
		for (let index = 0; index < codes.length; index++) {
			if (codes[index] === 0 || codes[index] === 49) bg = undefined;
			if (codes[index] === 48 && codes[index + 1] === 5) bg = codes[index + 2];
		}
	}
	return cells;
}

const floatCard = (overrides: Partial<Card> = {}) => card({ title: "read", subtitle: undefined, glyph: "⌖", body: ["alpha", "beta"], tone: CARD_TONE.SUCCESS, ...overrides });

test("card style defaults to the float style and lives in a process-wide slot", () => {
	const slot = Symbol.for("gentle-pi.card-style");
	const state = globalThis as typeof globalThis & { [slot]?: string };
	// Own the slot for this test only, whatever earlier tests left behind.
	const found = state[slot];
	try {
		delete state[slot];
		assert.equal(cardStyle(), CARD_STYLE.FLOAT, "an unset slot reads as the float style");
		withCardStyle(CARD_STYLE.FLOAT, () => assert.equal(state[slot], CARD_STYLE.FLOAT));
		state[slot] = "neon";
		assert.equal(cardStyle(), CARD_STYLE.NEON, "another loader's copy sees the same slot");
		state[slot] = "bogus";
		assert.equal(cardStyle(), CARD_STYLE.FLOAT, "unknown values read as the float style");
	} finally {
		if (found === undefined) delete state[slot];
		else state[slot] = found;
	}
});

test("float cards are borderless panels with a margin, an accent bar and balanced blank rows", () => {
	const width = 40;
	const lines = withCardStyle(CARD_STYLE.FLOAT, () => renderCard(floatCard(), floatTheme, width, { expanded: false, previewRows: 3, hint: "ctrl+o" }));
	const plain = lines.map(stripAnsi);
	assert.deepEqual(plain, [
		` ▎${" ".repeat(width - 3)} `,
		` ▎ ⌖ read${" ".repeat(width - 19)}ctrl+o    `,
		` ▎${" ".repeat(width - 3)} `,
		` ▎ alpha${" ".repeat(width - 9)} `,
		` ▎ beta${" ".repeat(width - 8)} `,
		` ▎${" ".repeat(width - 3)} `,
	]);
	for (const line of lines) assert.equal(visibleWidth(line), width);
	assert.doesNotMatch(plain.join("\n"), /[╭╮╰╯│─]/);
	// The glyph starts in the same column as the body text.
	assert.equal(plain[1]!.indexOf("⌖"), plain[3]!.indexOf("alpha"));
	for (const line of lines) {
		const cells = cellBackgrounds(line);
		assert.equal(cells[0], undefined, "left margin stays transparent");
		assert.equal(cells[width - 1], undefined, "right margin stays transparent");
		assert.deepEqual(cells.slice(1, -1), Array(width - 2).fill(BG_CODE.toolSuccessBg));
		assert.ok(line.startsWith(` \x1b[48;5;${BG_CODE.toolSuccessBg}m\x1b[38;5;${FG_CODE.success}m▎`), "the bar carries the tone colour");
	}
});

test("float panels pick the background from the tone", () => {
	const expected = { [CARD_TONE.INFO]: BG_CODE.toolSuccessBg, [CARD_TONE.SUCCESS]: BG_CODE.toolSuccessBg, [CARD_TONE.WARNING]: BG_CODE.toolPendingBg, [CARD_TONE.ERROR]: BG_CODE.toolErrorBg };
	for (const [tone, code] of Object.entries(expected)) {
		const lines = withCardStyle(CARD_STYLE.FLOAT, () => renderCard(floatCard({ tone: tone as CardTone }), floatTheme, 30, { expanded: true, previewRows: 3 }));
		for (const line of lines) assert.deepEqual(cellBackgrounds(line).slice(1, -1), Array(28).fill(code), `${tone}: ${JSON.stringify(line)}`);
		assert.ok(stripAnsi(lines[1]!).startsWith(" ▎ "));
		assert.ok(lines[1]!.includes(`\x1b[38;5;${FG_CODE[tone === CARD_TONE.INFO ? "border" : tone]}m▎`));
	}
});

test("float panels keep body text with box-drawing characters intact", () => {
	const body = "│ keep ╭─╮ and ╰─╯ │";
	const lines = withCardStyle(CARD_STYLE.FLOAT, () => renderCard(floatCard({ body: [body], title: "a ─ title │ ╮" }), floatTheme, 50, { expanded: true, previewRows: 3 })).map(stripAnsi);
	assert.equal(lines[3], ` ▎ ${body}${" ".repeat(50 - 4 - visibleWidth(body))} `);
	assert.ok(lines[1]!.startsWith(" ▎ ⌖ a ─ title │ ╮ "), JSON.stringify(lines[1]));
});

test("float panels re-arm their background after content and truncation resets", () => {
	// A long heading is truncated, and pi-tui's truncation inserts its own reset.
	const long = `red\x1b[0m blue\x1b[49m tail`;
	const lines = withCardStyle(CARD_STYLE.FLOAT, () => renderCard(floatCard({ title: "x".repeat(80), body: [long] }), floatTheme, 30, { expanded: false, previewRows: 1 }));
	assert.match(lines[1]!, /\x1b\[0m/, "the truncated heading carries a reset");
	for (const line of lines) {
		assert.equal(visibleWidth(line), 30);
		assert.deepEqual(cellBackgrounds(line).slice(1, -1), Array(28).fill(BG_CODE.toolSuccessBg), JSON.stringify(line));
	}
});

test("float cards without a body skip the separator and keep the blank rows around the heading", () => {
	const lines = withCardStyle(CARD_STYLE.FLOAT, () => renderCard(floatCard({ body: [] }), floatTheme, 30, { expanded: true, previewRows: 3 })).map(stripAnsi);
	assert.deepEqual(lines, [` ▎${" ".repeat(27)} `, ` ▎ ⌖ read${" ".repeat(20)} `, ` ▎${" ".repeat(27)} `]);
});

test("float falls back to the outlined card without a theme background or below ten columns", () => {
	const plainOptions = { expanded: false, previewRows: 3, hint: "ctrl+o" };
	for (const width of [0, 1, 5, 9, 40]) {
		const outlined = renderCard(floatCard(), ansiTheme, width, plainOptions);
		assert.deepEqual(withCardStyle(CARD_STYLE.FLOAT, () => renderCard(floatCard(), ansiTheme, width, plainOptions)), outlined, `no bg at ${width}`);
	}
	const throwing = { ...floatTheme, bg(color: string, text: string): string { throw new Error(`unknown background ${color}${text}`); } };
	assert.deepEqual(withCardStyle(CARD_STYLE.FLOAT, () => renderCard(floatCard(), throwing, 40, plainOptions)), renderCard(floatCard(), throwing, 40, plainOptions), "a missing background token");
	for (const width of [0, 1, 5, 9]) {
		assert.deepEqual(withCardStyle(CARD_STYLE.FLOAT, () => renderCard(floatCard(), floatTheme, width, plainOptions)), renderCard(floatCard(), floatTheme, width, plainOptions), `narrow ${width}`);
	}
	assert.match(stripAnsi(withCardStyle(CARD_STYLE.FLOAT, () => renderCard(floatCard(), floatTheme, 10, plainOptions))[1]!), /^ ▎ ⌖ r {4}$/);
});

test("the neon style paints no background even when the theme can", () => {
	for (const width of [8, 40]) {
		for (const line of renderCard(floatCard(), floatTheme, width, { expanded: true, previewRows: 3 })) {
			assert.ok(cellBackgrounds(line).every((cell) => cell === undefined), JSON.stringify(line));
		}
	}
});

test("legacy renderCard panels stay byte-identical in the float style", () => {
	const paragraphs = card({ subtitle: "2 running", body: ["ab", "", "c d", "│ ╭─╮"] });
	for (const width of [-3, 0, 1, 4, 9, 10, 40, 80]) {
		for (const options of [{ expanded: true }, { expanded: false }, { expanded: true, hint: "ctrl+o" }]) {
			for (const theme of [plainTheme, taggedTheme, floatTheme]) {
				const outlined = renderCard(paragraphs, theme, width, options);
				assert.deepEqual(withCardStyle(CARD_STYLE.FLOAT, () => renderCard(paragraphs, theme, width, options)), outlined, `width ${width}`);
			}
		}
	}
});

test("a call card awaits its result until pi finishes the row or a result renderer marks it", () => {
	const state = {};
	assert.equal(cardAwaitingResult({ isPartial: true, state }), true);
	assert.equal(cardAwaitingResult({ state }), true, "an unknown lifecycle is still pending");
	assert.equal(cardAwaitingResult({ isPartial: true }), true, "no shared state: only the final flag closes it");
	assert.equal(cardAwaitingResult({ isPartial: false, state }), false, "a final result always exists");
	markCardResult(state);
	assert.equal(cardAwaitingResult({ isPartial: true, state }), false, "a partial result component closes the frame");
	assert.deepEqual(Object.keys(state), [], "the mark never shows up as ordinary row state");
	for (const value of [undefined, null, 1, "state"]) {
		assert.doesNotThrow(() => markCardResult(value));
		assert.equal(cardAwaitingResult({ isPartial: true, state: value }), true);
	}
	assert.equal(cardRunningLine(CARD_TONE.WARNING, plainTheme, 20), `│ running…${" ".repeat(8)} │`);
	for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8]) assert.ok(visibleWidth(cardRunningLine(CARD_TONE.WARNING, plainTheme, width)) <= width);
});
