import assert from "node:assert/strict";
import test from "node:test";
import {
	CURSOR_MARKER,
	KeybindingsManager,
	TUI_KEYBINDINGS,
	visibleWidth,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
	ASK_PANEL_DEFAULT_STATE,
	ASK_PANEL_INDICATOR,
	type AskPanelPreferences,
} from "../lib/ask-panel-policy.ts";
import {
	MIN_PREVIEW_WIDTH,
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

const two = (): QuestionData[] => [
	question("First?", [option("Alpha"), option("Beta")], { header: "First" }),
	question("Second?", [option("Gamma"), option("Delta")], { header: "Second" }),
];

function createView(
	questions: QuestionData[],
	options: {
		onComplete?: (result: QuestionnaireResult) => void;
		keybindings?: KeybindingsManager;
		preferences?: AskPanelPreferences;
		terminalRows?: number;
	} = {},
): QuestionnaireView {
	return new QuestionnaireView({
		questions,
		theme,
		onComplete: options.onComplete,
		...(options.keybindings === undefined ? {} : { keybindings: options.keybindings }),
		...(options.preferences === undefined ? {} : { preferences: options.preferences }),
		...(options.terminalRows === undefined ? {} : { terminalRows: options.terminalRows }),
	});
}

function viewWithResult(
	questions: QuestionData[],
	keybindings?: KeybindingsManager,
	options: { preferences?: AskPanelPreferences; terminalRows?: number } = {},
) {
	const completed: QuestionnaireResult[] = [];
	const view = createView(questions, {
		onComplete: (result) => completed.push(result),
		...(keybindings === undefined ? {} : { keybindings }),
		...(options.preferences === undefined ? {} : { preferences: options.preferences }),
		...(options.terminalRows === undefined ? {} : { terminalRows: options.terminalRows }),
	});
	return { view, completed };
}

function render(view: QuestionnaireView, width = 100): string {
	return view.render(width).join("\n");
}

/** Strip SGR styling so assertions see the visible text, not cursor escape codes. */
function plain(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function assertFits(view: QuestionnaireView, width: number): void {
	for (const line of view.render(width)) {
		assert.ok(
			visibleWidth(line) <= width,
			`rendered line exceeds width ${width}: ${JSON.stringify(line)}`,
		);
	}
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

// Real terminal key sequences: legacy (ESC [) and application-cursor (ESC O).
const KEY = {
	up: ["\x1b[A", "\x1bOA"],
	down: ["\x1b[B", "\x1bOB"],
	enter: "\r",
	space: " ",
	tab: "\t",
	shiftTab: "\x1b[Z",
	escape: "\x1b",
	ctrlO: "\x0f",
	ctrlE: "\x05",
} as const;

test("renders exactly one active question plus a tab strip for all questions", () => {
	const { view } = viewWithResult(two());
	const rendered = render(view);

	// Tab strip: progress plus every header, active one marked.
	assert.match(rendered, /\[1\/2\]/);
	assert.match(rendered, /▸ First/);
	assert.match(rendered, /Second/);

	// Only the first question body renders; the second body is absent.
	assert.match(rendered, /First\?/);
	assert.match(rendered, /❯ Alpha/);
	assert.doesNotMatch(rendered, /Gamma/);
	assert.doesNotMatch(rendered, /Delta/);
	assert.doesNotMatch(rendered, /Second\?/);
});

test("Tab and Shift-Tab switch the active question and preserve cursor and toggles", () => {
	const { view, completed } = viewWithResult([
		question("First?", [option("Alpha"), option("Beta")], { header: "First" }),
		question("Second?", [option("Gamma"), option("Delta")], { header: "Second", multiSelect: true }),
	]);

	view.handleInput(KEY.down[0]); // First: cursor -> Beta
	view.handleInput(KEY.tab);
	let rendered = render(view);
	assert.match(rendered, /\[2\/2\]/);
	assert.match(rendered, /▸ Second/);
	assert.match(rendered, /❯ \[ \] Gamma/);
	assert.doesNotMatch(rendered, /❯ Beta/);
	assert.doesNotMatch(rendered, /First\?/);

	view.handleInput(KEY.space); // Second: toggle Gamma
	assert.match(render(view), /❯ \[x\] Gamma/);

	view.handleInput(KEY.shiftTab);
	rendered = render(view);
	assert.match(rendered, /\[1\/2\]/);
	assert.match(rendered, /❯ Beta/); // cursor preserved
	assert.doesNotMatch(rendered, /Gamma/); // second body hidden again

	view.handleInput(KEY.tab);
	assert.match(render(view), /❯ \[x\] Gamma/); // toggle preserved
	assert.equal(completed.length, 0);
});

test("real key sequences drive the cursor and commit in legacy and application-cursor form", () => {
	for (const down of KEY.down) {
		const { view, completed } = viewWithResult(single());
		view.handleInput(down);
		assert.match(render(view), /❯ Beta/, `down sequence ${JSON.stringify(down)} should move the cursor`);
		view.handleInput(KEY.enter);
		assert.equal(completed.length, 1, `enter after ${JSON.stringify(down)} should commit`);
		assert.deepEqual(view.getResult().answers, [
			{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Beta" },
		]);
	}

	for (const up of KEY.up) {
		const { view } = viewWithResult(single());
		view.handleInput(KEY.down[0]);
		view.handleInput(KEY.down[0]);
		view.handleInput(up);
		assert.match(render(view), /❯ Beta/, `up sequence ${JSON.stringify(up)} should move the cursor back`);
	}
});

test("the injected KeybindingsManager drives the same navigation and commit", () => {
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	const { view, completed } = viewWithResult(single(), keybindings);

	assert.ok(keybindings.matches(KEY.down[0], "tui.select.down"));
	view.handleInput(KEY.down[0]);
	assert.match(render(view), /❯ Beta/);
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
	assert.equal(view.getResult().answers[0]?.answer, "Beta");
});

test("single-select commits on Enter and advances to the next unanswered question", () => {
	const { view, completed } = viewWithResult(two());

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "the questionnaire is not done while a question is unanswered");
	assert.equal(view.getResult().answers.length, 1);
	assert.equal(view.activeQuestion, 1, "a commit advances to the next unanswered question");
	assert.match(render(view), /\[2\/2\]/);
	assert.match(render(view), /❯ Gamma/);

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "First?", kind: "option", answer: "Alpha" },
		{ questionIndex: 1, question: "Second?", kind: "option", answer: "Gamma" },
	]);
});

test("multi-select toggles with space and requires a non-empty selection to commit", () => {
	const { view, completed } = viewWithResult([
		question("Pick?", [option("One"), option("Two")], { multiSelect: true }),
	]);
	assert.match(render(view), /\[ \] One/);

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "an empty multiSelect commit is a no-op");
	assert.equal(view.getResult().answers.length, 0);

	view.handleInput(KEY.space);
	assert.match(render(view), /\[x\] One/);

	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.space);
	assert.match(render(view), /\[x\] Two/);

	view.handleInput(KEY.space);
	assert.match(render(view), /\[ \] Two/);

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: ["One"] },
	]);
});

test("custom row opens the editor, empty submit returns, and the draft survives a tab switch", () => {
	const { view, completed } = viewWithResult(two());

	// Move to the custom row on question one and open the editor.
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	assert.match(render(view), /Custom response/);
	assert.match(render(view), /> /);

	view.handleInput("   ");
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "a whitespace-only submission stays uncommitted");
	assert.doesNotMatch(render(view), /Custom response/);

	// Reopen, type a draft, switch away, and come back: the draft is preserved.
	view.handleInput(KEY.enter);
	view.handleInput("draft text");
	view.handleInput(KEY.tab);
	assert.equal(view.activeQuestion, 1, "tab switches question even while editing");
	view.handleInput(KEY.shiftTab);
	assert.equal(view.activeQuestion, 0);
	view.handleInput(KEY.enter); // still on the custom row
	assert.match(plain(render(view)), /draft text/, "the custom draft is restored on reopen");

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "one of two questions answered is not completion");
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "First?", kind: "custom", answer: "draft text" },
	]);
});

test("multi-select can commit a custom answer with the toggled options", () => {
	const { view } = viewWithResult([question("Pick?", [option("One"), option("Two")], { multiSelect: true })]);
	view.handleInput(KEY.space);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);

	assert.match(render(view), /Custom response/);
	view.handleInput("free note");
	view.handleInput(KEY.enter);

	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Pick?", kind: "custom", answer: "free note", selected: ["One"] },
	]);
});

test("preview renders beside the list only while the focused option has one", () => {
	const { view } = viewWithResult(single("Preview body line"));
	const wide = render(view, 100);
	assert.match(wide, /Preview body line/);
	assert.match(wide, /❯ Alpha/);

	view.handleInput(KEY.down[0]); // Beta has no preview
	const collapsed = render(view, 100);
	assert.doesNotMatch(collapsed, /Preview body line/);
	assert.match(collapsed, /❯ Beta/);
	assertFits(view, 100);
});

test("the preview pane wraps cleanly and never exceeds the terminal width", () => {
	const body = "lorem ipsum dolor sit amet ".repeat(12);
	const { view } = viewWithResult([
		question("Proceed?", [option("Alpha", "First choice", body), option("Beta")]),
	]);
	for (const width of [MIN_PREVIEW_WIDTH, 100, 120]) {
		assertFits(view, width);
	}
	assert.match(render(view, 100), /lorem ipsum/);
});

test("narrow widths render the preview inline without corrupting the body", () => {
	const { view } = viewWithResult(single("Inline preview body"));
	const narrow = render(view, 60);
	assert.match(narrow, /Inline preview body/);
	assert.match(narrow, /❯ Alpha/);
	assert.match(narrow, /Type something\./);
	assertFits(view, 60);
});

test("height stays bounded as the question count grows", () => {
	const one = viewWithResult([question("Only?", [option("A"), option("B")], { header: "Only" })]);
	const many = viewWithResult([
		question("One?", [option("A"), option("B")], { header: "One" }),
		question("Two?", [option("C"), option("D")], { header: "Two" }),
		question("Three?", [option("E"), option("F")], { header: "Three" }),
		question("Four?", [option("G"), option("H")], { header: "Four" }),
	]);

	const oneLines = one.view.render(100).length;
	const manyLines = many.view.render(100).length;
	assert.ok(
		manyLines <= oneLines + 2,
		`four questions must not stack bodies (one=${oneLines}, many=${manyLines})`,
	);
	// Only the first body renders, so later bodies stay absent.
	const rendered = render(many.view, 100);
	assert.doesNotMatch(rendered, /Two\?/);
	assert.doesNotMatch(rendered, /Four\?/);
	assert.match(rendered, /❯ A/);
});

test("Escape cancels the questionnaire with a cancelled result", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput(KEY.escape);
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult(), { cancelled: true, answers: [] });
});

test("focus propagates to the free-text input for IME cursor positioning", () => {
	const { view } = viewWithResult(single());
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);

	view.focused = true;
	assert.ok(render(view).includes(CURSOR_MARKER), "a focused view positions the input cursor");

	view.focused = false;
	assert.ok(!render(view).includes(CURSOR_MARKER), "an unfocused view hides the input cursor");
});

test("a committed option carries its preview on the answer row", () => {
	const { view } = viewWithResult(single("Preview body line"));
	view.handleInput(KEY.enter);
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

test("pointer click toggles a multi-select option instead of committing", () => {
	const { view, completed } = viewWithResult([
		question("Pick?", [option("One"), option("Two")], { multiSelect: true }),
	]);

	let lines = view.render(100);
	assert.equal(view.handleMouse(mouseEvent(lines, lines.findIndex((line) => line.includes("One")), "click"))?.handled, true);
	assert.equal(completed.length, 0, "a multi-select click toggles without committing");
	assert.match(render(view), /\[x\] One/);

	// Clicking the same option again un-toggles it; still no commit.
	lines = view.render(100);
	view.handleMouse(mouseEvent(lines, lines.findIndex((line) => line.includes("One")), "click"));
	assert.match(render(view), /\[ \] One/);
	assert.equal(completed.length, 0);

	// Toggle two options with the mouse, then commit with the keyboard.
	lines = view.render(100);
	view.handleMouse(mouseEvent(lines, lines.findIndex((line) => line.includes("One")), "click"));
	lines = view.render(100);
	view.handleMouse(mouseEvent(lines, lines.findIndex((line) => line.includes("Two")), "click"));
	assert.match(render(view), /\[x\] One/);
	assert.match(render(view), /\[x\] Two/);

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: ["One", "Two"] },
	]);
});

test("pointer click on the custom row opens the editor without committing", () => {
	for (const questions of [single(), [question("Pick?", [option("One"), option("Two")], { multiSelect: true })]]) {
		const { view, completed } = viewWithResult(questions);
		const lines = view.render(100);
		const customRow = lines.findIndex((line) => line.includes(CUSTOM_ROW_LABEL));
		assert.ok(customRow >= 0);

		assert.equal(view.handleMouse(mouseEvent(lines, customRow, "click"))?.handled, true);
		assert.match(render(view), /Custom response/);
		assert.equal(completed.length, 0, "opening the custom editor never commits");
	}
});

test("the custom row is always appended after the authored options", () => {
	const { view } = viewWithResult(single());
	const lines = view.render(100);
	const betaRow = lines.findIndex((line) => line.includes("Beta"));
	const customRow = lines.findIndex((line) => line.includes(CUSTOM_ROW_LABEL));
	assert.ok(betaRow >= 0 && customRow >= 0);
	assert.ok(customRow > betaRow);
});

test("every rendered line fits the width across 1-4 questions", () => {
	const questions = [
		question("One?", [option("A"), option("B", "B description", "preview ".repeat(20))], { header: "One" }),
		question("Two?", [option("C"), option("D")], { header: "Two", multiSelect: true }),
		question("Three?", [option("E"), option("F")], { header: "Three" }),
		question("Four?", [option("G"), option("H")], { header: "Four" }),
	];
	const { view } = viewWithResult(questions);
	for (const width of [40, 60, 80, 100, 140]) {
		assertFits(view, width);
	}
});

// --- Minimized panel (ask_panel preferences) ---

const collapsedPreferences = (
	indicator: AskPanelPreferences["indicator"] = ASK_PANEL_INDICATOR.MINIMAL,
): AskPanelPreferences => ({ indicator, defaultState: ASK_PANEL_DEFAULT_STATE.COLLAPSED });

test("the minimal minimized bar names the question and toggle key on one fitting line", () => {
	const { view } = viewWithResult(single(), undefined, { preferences: collapsedPreferences() });
	const lines = view.render(100);
	assert.equal(lines.length, 1);
	assert.match(plain(lines[0]!), /▸ 1\/1 · Header · 2 options · ctrl\+o expand · esc cancel/);
	for (const width of [20, 40, 100]) {
		assertFits(view, width);
	}
});

test("the tabbed minimized indicator keeps the tab strip and adds one bar line", () => {
	const { view } = viewWithResult(two(), undefined, { preferences: collapsedPreferences(ASK_PANEL_INDICATOR.TABBED) });
	const lines = view.render(100).map(plain);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /\[1\/2\]/);
	assert.match(lines[0]!, /▸ First/);
	assert.match(lines[1]!, /▸ minimized · ctrl\+o expand · esc cancel/);
	assertFits(view, 100);
});

test("the answers minimized indicator lists the active answer or none", () => {
	const unanswered = viewWithResult(single(), undefined, { preferences: collapsedPreferences(ASK_PANEL_INDICATOR.ANSWERS) });
	assert.match(plain(unanswered.view.render(100)[0]!), /▸ 1\/1 · Header · answered: none · ctrl\+o expand/);

	const { view } = viewWithResult(two(), undefined, { preferences: { indicator: ASK_PANEL_INDICATOR.ANSWERS, defaultState: ASK_PANEL_DEFAULT_STATE.EXPANDED } });
	view.handleInput(KEY.enter); // commit First Alpha and advance to Second
	view.handleInput(KEY.tab); // back to First, which now holds an answer
	assert.equal(view.activeQuestion, 0);
	view.handleInput(KEY.ctrlO); // collapse
	assert.match(plain(view.render(100)[0]!), /▸ 1\/2 · First · answered: Alpha · ctrl\+o expand/);
});

test("the toggle collapses and expands preserving cursor, toggles and committed answers", () => {
	const questions = [
		question("First?", [option("Alpha"), option("Beta")], { header: "First", multiSelect: true }),
		question("Second?", [option("Gamma"), option("Delta")], { header: "Second" }),
	];
	const { view } = viewWithResult(questions);

	view.handleInput(KEY.space); // toggle Alpha
	view.handleInput(KEY.down[0]); // cursor -> Beta
	view.handleInput(KEY.ctrlO); // collapse
	assert.match(plain(render(view, 100)), /ctrl\+o expand/);

	view.handleInput(KEY.ctrlO); // expand
	assert.match(render(view), /\[x\] Alpha/); // toggle preserved
	assert.match(render(view), /❯ \[ \] Beta/); // cursor preserved

	view.handleInput(KEY.tab);
	view.handleInput(KEY.enter); // commit Second Gamma
	assert.equal(view.getResult().answers.length, 1);
	view.handleInput(KEY.ctrlO); // collapse again
	view.handleInput(KEY.ctrlO); // expand
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 1, question: "Second?", kind: "option", answer: "Gamma" },
	]);
	assert.match(render(view), /\[x\] Alpha/);
});

test("escape still cancels while minimized", () => {
	const { view, completed } = viewWithResult(single(), undefined, { preferences: collapsedPreferences() });
	view.handleInput(KEY.escape);
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult(), { cancelled: true, answers: [] });
});

test("arrows, enter and space while minimized move and commit nothing", () => {
	const { view, completed } = viewWithResult(
		[question("Pick?", [option("Alpha"), option("Beta")], { multiSelect: true })],
		undefined,
		{ preferences: collapsedPreferences() },
	);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.up[0]);
	view.handleInput(KEY.space);
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0);
	assert.equal(view.getResult().answers.length, 0);

	view.handleInput(KEY.ctrlO); // expand
	assert.match(render(view), /❯ \[ \] Alpha/, "the cursor never moved and space never toggled while minimized");
});

test("toggling while the free-text editor is open preserves the draft", () => {
	const { view } = viewWithResult(two());
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter); // open the custom-row editor
	view.handleInput("draft text");
	assert.match(render(view), /Custom response/);

	view.handleInput(KEY.ctrlO); // minimize closes the editor through closeEditor()
	assert.doesNotMatch(render(view), /Custom response/);
	assert.equal(view.getResult().answers.length, 0, "closing the editor never commits");

	view.handleInput(KEY.ctrlO); // expand
	view.handleInput(KEY.enter); // reopen the custom row, which is still focused
	assert.match(plain(render(view)), /draft text/, "the draft is restored on reopen");
});

test("a left click on the minimized bar expands without committing", () => {
	const { view, completed } = viewWithResult(single(), undefined, { preferences: collapsedPreferences() });
	const lines = view.render(100);
	assert.equal(lines.length, 1);
	assert.equal(view.handleMouse(mouseEvent(lines, 0, "click"))?.handled, true);
	assert.equal(completed.length, 0, "the bar click never commits");

	const expanded = render(view, 100);
	assert.match(expanded, /❯ Alpha/);
	assert.match(plain(expanded), /ctrl\+o minimize/);
});

test("defaultState collapsed starts minimized while expanded never minimizes", () => {
	const collapsed = viewWithResult(single(), undefined, { preferences: collapsedPreferences() });
	assert.equal(collapsed.view.render(100).length, 1);

	const expanded = viewWithResult(single(), undefined, {
		preferences: { indicator: ASK_PANEL_INDICATOR.MINIMAL, defaultState: ASK_PANEL_DEFAULT_STATE.EXPANDED },
		terminalRows: 5,
	});
	assert.match(render(expanded.view, 100), /❯ Alpha/, "a tiny terminal never minimizes the default expanded state");
});

test("auto minimizes on a short terminal but not on a tall or unknown one", () => {
	const preferences: AskPanelPreferences = { indicator: ASK_PANEL_INDICATOR.MINIMAL, defaultState: ASK_PANEL_DEFAULT_STATE.AUTO };

	const short = viewWithResult(single(), undefined, { preferences, terminalRows: 19 });
	assert.equal(short.view.render(100).length, 1, "8 expanded lines do not fit 19 rows minus 12 reserved");

	const tall = viewWithResult(single(), undefined, { preferences, terminalRows: 40 });
	assert.match(render(tall.view, 100), /❯ Alpha/);

	const unknown = viewWithResult(single(), undefined, { preferences });
	assert.match(render(unknown.view, 100), /❯ Alpha/, "no terminal rows means no automatic minimization");
});

test("an explicit toggle overrides automatic minimization for the instance", () => {
	const { view } = viewWithResult(single(), undefined, {
		preferences: { indicator: ASK_PANEL_INDICATOR.MINIMAL, defaultState: ASK_PANEL_DEFAULT_STATE.AUTO },
		terminalRows: 19,
	});
	assert.equal(view.render(100).length, 1, "auto minimized first");

	view.handleInput(KEY.ctrlO); // explicit expand
	assert.match(render(view, 100), /❯ Alpha/);
	assert.match(render(view, 100), /❯ Alpha/, "the user's choice sticks even though it still does not fit");
});

test("automatic minimization is sticky once it triggers", () => {
	const questions = [
		question("Proceed?", [option("Alpha"), option("Beta", "Second choice", "PREVIEW ".repeat(40))]),
	];
	const { view } = viewWithResult(questions, undefined, {
		preferences: { indicator: ASK_PANEL_INDICATOR.MINIMAL, defaultState: ASK_PANEL_DEFAULT_STATE.AUTO },
		terminalRows: 21,
	});
	assert.match(render(view, 80), /minimize/, "Alpha has no preview, so the panel fits and stays expanded");

	view.handleInput(KEY.down[0]); // Beta's long preview no longer fits
	assert.match(render(view, 80), /ctrl\+o expand/, "the overflowing panel minimizes");
	assert.match(render(view, 80), /ctrl\+o expand/, "the automatic decision stays minimized");
});

test("a remapped app.tools.expand binding toggles and labels the minimized bar", () => {
	const keybindings = new KeybindingsManager(
		{ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } },
		{ "app.tools.expand": "ctrl+e" },
	);
	const { view } = viewWithResult(single(), keybindings, { preferences: collapsedPreferences() });
	assert.match(plain(view.render(100)[0]!), /ctrl\+e expand/);

	view.handleInput(KEY.ctrlE);
	assert.match(render(view, 100), /❯ Alpha/, "the remapped key expands the panel");
});
