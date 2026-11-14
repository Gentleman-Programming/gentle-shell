import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CARD_TONE } from "../lib/shell-card.ts";
import { AGENT_MESSAGE, agentMessageCard, agentTheme, steeredMessage } from "../lib/agents-message-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

const plainTheme = { fg: (_color: string, text: string) => text };
const taggedTheme = { fg: (color: string, text: string) => `[${color}]${text}` };

// The iris chrome the chat's agent cards wear, as truecolor SGR.
const IRIS_FG = "\x1b[38;2;185;167;242m";
const IRIS_DEEP_FG = "\x1b[38;2;143;122;217m";

test("a received message draws the chat's Messaging agent heading, glyph and iris chrome", () => {
	const rows = agentMessageCard("Please also update the docs", taggedTheme, 60);
	const head = rows[0] ?? "";
	assert.equal(stripAnsi(head).includes(`${AGENT_MESSAGE.glyph} ${AGENT_MESSAGE.title}`), true, "heading and glyph come from the shared identity");
	assert.match(stripAnsi(head), /✉ {2}Messaging agent/, "the envelope keeps its own space and the chrome adds one more, so the icon never sits against the title");
	assert.ok(head.includes(IRIS_FG), "the title takes the iris accent the chat's messaging card uses");
	assert.ok(head.includes(IRIS_DEEP_FG), "the frame takes the iris border the chat's messaging card uses");
	assert.match(rows.join("\n"), /Please also update the docs/, "the message body is drawn");
	assert.doesNotMatch(rows.join("\n"), /\[text\]/, "the body is never repainted in a role: the chat's messaging card draws it as handed");
	assert.equal(agentTheme(taggedTheme, CARD_TONE.INFO).fg("accent", "x"), `${IRIS_FG}x\x1b[39m`, "the shared theme is the iris accent");
});

test("a received message is drawn whole, because a thread row has no expand affordance", () => {
	const message = Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n");
	const frame = stripAnsi(agentMessageCard(message, plainTheme, 80).join("\n"));
	for (let index = 0; index < 8; index += 1) assert.match(frame, new RegExp(`line ${index}`), `line ${index} is retained`);
	assert.doesNotMatch(frame, /more lines/, "nothing is withheld behind a preview marker");
	assert.match(frame, /Messaging agent/);
});

test("a received message fits the width it is drawn in and never emits an escape it was handed", () => {
	for (const width of [10, 12, 20, 40, 80]) {
		const rows = agentMessageCard("a message the child received\nwith a second row", plainTheme, width);
		assert.ok(rows.length > 0, `width ${width}: the card draws`);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `"${row}" fits width ${width}`);
	}
	const rows = agentMessageCard("\u001b[31mred\u001b[0m text", plainTheme, 60);
	assert.equal(rows.join("\n").includes("\u001b[31m"), false, "terminal escapes are stripped before drawing");
	assert.match(stripAnsi(rows.join("\n")), /red text/);
});

test("only the runner's own marker makes a retained note a received message", () => {
	assert.equal(steeredMessage("steered: skip the tests"), "skip the tests");
	assert.equal(steeredMessage("steered: "), "");
	assert.equal(steeredMessage("steered: first\nsteered: second"), "first\nsteered: second", "only the marker that leads the note is removed");
	assert.equal(steeredMessage("steered: \nsecond line"), "\nsecond line", "a body starting with a blank row is kept as it is");
	for (const text of [
		"asked: choose a target file",
		"retrying (1/3)",
		"error: the child crashed",
		"extension error: boom",
		"gentle-agents: requested tools missing in child: codegraph",
		"Steered: uppercase is a different note",
		" steered: a leading space is a different note",
		"steered:no space is a different note",
		"a note that mentions steered: inline",
		"",
	]) {
		assert.equal(steeredMessage(text), undefined, `"${text}" is not a delivered message`);
	}
});
