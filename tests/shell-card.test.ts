import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CARD_TONE, renderCard, type Card } from "../lib/shell-card.ts";
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
	const info = renderCard(card(), taggedTheme, 80, { expanded: true });
	assert.match(info[0], /^<customMessageLabel>╭<\/customMessageLabel><customMessageLabel>─ <\/customMessageLabel><customMessageLabel>✿ Gentle AI<\/customMessageLabel> <muted>·<\/muted> <muted>review preflight<\/muted><customMessageLabel> ─+<\/customMessageLabel><customMessageLabel>╮<\/customMessageLabel>$/);
	assert.match(info[1], /^<customMessageLabel>│<\/customMessageLabel> <text>.*<customMessageLabel>│<\/customMessageLabel>$/);
	assert.match(info[info.length - 1], /^<customMessageLabel>╰<\/customMessageLabel><customMessageLabel>─+╯<\/customMessageLabel>$/);

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

test("renderCard never exceeds extremely narrow supplied widths", () => {
	for (const width of [0, 1, 2, 3, 4, 5, 8, 16]) {
		const lines = renderCard(card({ glyph: "\u{1F339}\uFE0E" }), ansiTheme, width, { expanded: true, hint: "ctrl+o to expand" });
		for (const line of lines) assert.equal(visibleWidth(line), width, `"${stripAnsi(line)}" is not ${width} wide`);
	}
});
