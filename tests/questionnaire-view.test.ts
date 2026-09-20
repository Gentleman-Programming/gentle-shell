import assert from "node:assert/strict";
import test from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	QuestionnaireView,
	type QuestionnaireResult,
	type QuestionnaireTheme,
} from "../lib/questionnaire/questionnaire-view.ts";
import { CUSTOM_ROW_LABEL, type OptionData, type QuestionData } from "../lib/questionnaire/schema.ts";

const theme: QuestionnaireTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const option = (label: string, description = `${label} description`, preview?: string): OptionData =>
	preview === undefined ? { label, description } : { label, description, preview };

const question = (
	text: string,
	options: OptionData[],
	overrides: { header?: string; multiSelect?: boolean } = {},
): QuestionData => ({
	question: text,
	header: overrides.header ?? "Header",
	options,
	...(overrides.multiSelect === undefined ? {} : { multiSelect: overrides.multiSelect }),
});

const single = (preview?: string): QuestionData[] => [
	question("Proceed?", [option("Alpha", "First choice", preview), option("Beta", "Second choice")]),
];

function createView(questions: QuestionData[], onComplete?: (result: QuestionnaireResult) => void): QuestionnaireView {
	return new QuestionnaireView({ questions, theme, onComplete });
}

function viewWithResult(questions: QuestionData[]): { view: QuestionnaireView; completed: QuestionnaireResult[] } {
	const completed: QuestionnaireResult[] = [];
	return { view: createView(questions, (result) => completed.push(result)), completed };
}

function mouseEvent(lines: string[], row: number, type: TuiMouseEvent["type"]): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 1,
		y: row,
		screenX: 1,
		screenY: row,
		width: 100,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

test("single-select renders the stack and commits the focused option", () => {
	const { view, completed } = viewWithResult(single());
	const rendered = view.render(100).join("\n");

	assert.match(rendered, /\[1\/1\] Header/);
	assert.match(rendered, /Proceed\?/);
	assert.match(rendered, /❯ Alpha/);
	assert.match(rendered, /Beta/);
	assert.match(rendered, /Type something\./);

	view.handleInput("\x1b[B");
	assert.match(view.render(100).join("\n"), /❯ Beta/);

	view.handleInput("\r");
	assert.equal(completed.length, 1);
	const result = view.getResult();
	assert.equal(result.cancelled, false);
	assert.deepEqual(result.answers, [{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Beta" }]);
});

test("single-select cursor moves with arrows over options and the custom row", () => {
	const { view } = viewWithResult(single());
	view.handleInput("\x1b[B");
	view.handleInput("\x1b[B");
	assert.match(view.render(100).join("\n"), /❯ Type something\./);
	view.handleInput("\x1b[A");
	assert.match(view.render(100).join("\n"), /❯ Beta/);
	view.handleInput("\x1b[A");
	view.handleInput("\x1b[A");
	assert.match(view.render(100).join("\n"), /❯ Alpha/);
});

test("multiSelect toggles with space and requires at least one selection to commit", () => {
	const { view, completed } = viewWithResult([
		question("Pick?", [option("One"), option("Two")], { multiSelect: true }),
	]);
	const initial = view.render(100).join("\n");
	assert.match(initial, /\[ \] One/);

	view.handleInput("\r");
	assert.equal(completed.length, 0, "an empty multiSelect commit is a no-op");
	assert.equal(view.getResult().answers.length, 0);

	view.handleInput(" ");
	assert.match(view.render(100).join("\n"), /\[x\] One/);

	view.handleInput("\x1b[B");
	view.handleInput(" ");
	assert.match(view.render(100).join("\n"), /\[x\] Two/);

	view.handleInput(" ");
	assert.match(view.render(100).join("\n"), /\[ \] Two/);

	view.handleInput("\r");
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: ["One"] },
	]);
});

test("free-text row opens the editor, empty submit returns, and text commits a custom answer", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput("\x1b[B");
	view.handleInput("\x1b[B");
	view.handleInput("\r");

	const editing = view.render(100).join("\n");
	assert.match(editing, /Custom response/);
	assert.match(editing, /> /);

	view.handleInput("   ");
	view.handleInput("\r");
	assert.equal(completed.length, 0, "a whitespace-only submission stays uncommitted");
	assert.doesNotMatch(view.render(100).join("\n"), /Custom response/);

	view.handleInput("\r");
	assert.match(view.render(100).join("\n"), /Custom response/);
	view.handleInput("custom text");
	view.handleInput("\r");

	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "custom", answer: "custom text" },
	]);
});

test("multiSelect can commit a custom answer with the toggled options", () => {
	const { view } = viewWithResult([question("Pick?", [option("One"), option("Two")], { multiSelect: true })]);
	view.handleInput(" ");
	view.handleInput("\x1b[B");
	view.handleInput("\x1b[B");
	view.handleInput(" ");
	view.handleInput("\r");

	assert.match(view.render(100).join("\n"), /Custom response/);
	view.handleInput("free note");
	view.handleInput("\r");

	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Pick?", kind: "custom", answer: "free note", selected: ["One"] },
	]);
});

test("preview renders as a side pane on wide terminals and inline on narrow ones", () => {
	const { view } = viewWithResult(single("Preview body line"));

	const wide = view.render(100).join("\n");
	assert.match(wide, /│/);
	assert.match(wide, /Preview body line/);

	const narrow = view.render(70).join("\n");
	assert.doesNotMatch(narrow, /│/);
	assert.match(narrow, /Preview body line/);
});

test("preview pane collapses when the focused option has no preview", () => {
	const { view } = viewWithResult(single("Preview body line"));
	assert.match(view.render(100).join("\n"), /Preview body line/);

	view.handleInput("\x1b[B");
	const rendered = view.render(100).join("\n");
	assert.doesNotMatch(rendered, /│/);
	assert.doesNotMatch(rendered, /Preview body line/);
});

test("Tab and Shift-Tab navigate questions and preserve each cursor", () => {
	const { view, completed } = viewWithResult([
		question("First?", [option("Alpha"), option("Beta")]),
		question("Second?", [option("Gamma"), option("Delta")]),
	]);

	view.handleInput("\x1b[B");
	view.handleInput("\t");
	let rendered = view.render(100).join("\n");
	assert.match(rendered, /❯ Gamma/);
	assert.doesNotMatch(rendered, /❯ Beta/);

	view.handleInput("\x1b[Z");
	rendered = view.render(100).join("\n");
	assert.match(rendered, /❯ Beta/);

	assert.equal(completed.length, 0);
});

test("only the final commit completes the questionnaire", () => {
	const { view, completed } = viewWithResult([
		question("First?", [option("Alpha"), option("Beta")]),
		question("Second?", [option("Gamma"), option("Delta")]),
	]);

	view.handleInput("\r");
	assert.equal(completed.length, 0, "committing a non-final question does not complete");
	assert.equal(view.getResult().answers.length, 1);

	view.handleInput("\t");
	view.handleInput("\r");
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "First?", kind: "option", answer: "Alpha" },
		{ questionIndex: 1, question: "Second?", kind: "option", answer: "Gamma" },
	]);
});

test("Escape cancels the questionnaire with a cancelled result", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput("\x1b");
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult(), { cancelled: true, answers: [] });
});

test("a committed option carries its preview on the answer row", () => {
	const { view } = viewWithResult(single("Preview body line"));
	view.handleInput("\r");
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Alpha", preview: "Preview body line" },
	]);
});

test("pointer press focuses a row and click commits it", () => {
	const { view, completed } = viewWithResult(single());
	const lines = view.render(100);
	const betaRow = lines.findIndex((line) => line.includes("Beta"));
	assert.ok(betaRow >= 0);

	assert.equal(view.handleMouse(mouseEvent(lines, betaRow, "press"))?.handled, true);
	assert.equal(completed.length, 0, "press focuses but never answers");
	const afterPress = view.render(100);
	const betaRowAfterPress = afterPress.findIndex((line) => line.includes("Beta"));
	assert.equal(view.handleMouse(mouseEvent(afterPress, betaRowAfterPress, "click"))?.handled, true);
	assert.equal(completed.length, 1);
	assert.equal(view.getResult().answers[0]?.answer, "Beta");
});

test("the custom row is always appended after the authored options", () => {
	const { view } = viewWithResult(single());
	const lines = view.render(100);
	const betaRow = lines.findIndex((line) => line.includes("Beta"));
	const customRow = lines.findIndex((line) => line.includes(CUSTOM_ROW_LABEL));
	assert.ok(betaRow >= 0 && customRow >= 0);
	assert.ok(customRow > betaRow);
});
