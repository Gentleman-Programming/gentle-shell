import {
	Container,
	Input,
	Key,
	isKeyRelease,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	type Focusable,
	type KeybindingsManager,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { CUSTOM_ROW_LABEL, type QuestionData } from "./schema.ts";

/** Minimum terminal width at which the preview pane splits beside the list. */
export const MIN_PREVIEW_WIDTH = 80;

/** Fraction of the width given to the option column when a preview pane is shown. */
const PREVIEW_SPLIT = 0.45;

/** Two-space gutter between the option column and the preview pane. No divider frame. */
const PREVIEW_GAP = "  ";

/**
 * Terminal rows assumed when the host cannot report a height. An unknown
 * height must fail safe: the preview window stays bounded either way, because
 * a preview that grows with its content pushes the transcript off screen.
 */
const DEFAULT_TERMINAL_ROWS = 24;

/** Rows the view spends on the tab strip, the blank separators, and the hint. */
const OWN_CHROME_ROWS = 4;

/** Rows reserved for the two frame borders the host draws around the view. */
const HOST_FRAME_ROWS = 2;

/**
 * Floor for the body so a short terminal still shows the active question.
 * Below this the options, not the preview, are the thing worth keeping.
 */
const MIN_BODY_ROWS = 6;

/**
 * Fraction of the terminal the preview pane may claim. Half keeps the option
 * list readable and leaves the transcript room to stay visible, which is the
 * whole point of the dock swap over an overlay.
 */
const PREVIEW_HEIGHT_RATIO = 0.5;

/** Floor for the preview window so a short preview renders without scrolling. */
const MIN_PREVIEW_ROWS = 4;

/** Theme surface used by the questionnaire, compatible with the Pi TUI theme. */
export interface QuestionnaireTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
}

/** One committed answer for a question. */
export interface AnswerRow {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	preview?: string;
}

/** Final questionnaire outcome handed to the caller. */
export interface QuestionnaireResult {
	cancelled: boolean;
	answers: AnswerRow[];
}

/** Construction options for {@link QuestionnaireView}. */
export interface QuestionnaireViewOptions {
	questions: QuestionData[];
	theme: QuestionnaireTheme;
	keybindings?: KeybindingsManager;
	onComplete?: (result: QuestionnaireResult) => void;
	/**
	 * Terminal rows, or a getter for them. The view bounds its own height from
	 * this value; an unknown or unreadable height falls back to
	 * {@link DEFAULT_TERMINAL_ROWS} instead of rendering an unbounded preview.
	 */
	rows?: number | (() => number);
}

interface QuestionState {
	cursor: number;
	toggled: Set<number>;
	answer: AnswerRow | undefined;
	customDraft: string;
}

interface LineOwner {
	questionIndex: number;
	rowIndex: number;
}

/** Small inline text editor for the free-text row; owns an {@link Input}. */
class CustomTextEditor extends Container {
	private readonly input = new Input({ prompt: "> ", placeholder: "Type your response" });
	private readonly keybindings: KeybindingsManager | undefined;
	private readonly onSubmit: (value: string) => void;
	private readonly onCancel: () => void;

	constructor(
		keybindings: KeybindingsManager | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.keybindings = keybindings;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
		this.input.focused = false;
		this.addChild(new Text("Custom response", 1, 0));
		this.addChild(this.input);
		this.addChild(new Text("Enter to submit • Esc to return to choices", 1, 0));
	}

	setFocused(focused: boolean): void {
		this.input.focused = focused;
	}

	getValue(): string {
		return this.input.getValue();
	}

	setValue(value: string): void {
		this.input.setValue(value);
		// Place the caret at the end of a restored draft so typing appends to it.
		this.input.handleInput("\x1b[F");
		this.invalidate();
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (this.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		if (this.matches(data, "tui.input.submit")) {
			this.onSubmit(this.input.getValue());
			return;
		}
		this.input.handleInput(data);
		this.invalidate();
	}

	private matches(data: string, binding: "tui.select.cancel" | "tui.input.submit"): boolean {
		if (this.keybindings?.matches) return this.keybindings.matches(data, binding);
		const key = binding === "tui.select.cancel" ? "escape" : "enter";
		return matchesKey(data, key);
	}
}

/**
 * One-question-at-a-time questionnaire.
 *
 * The whole questionnaire is represented as a compact tab strip: exactly one
 * question body is rendered at a time, and Tab/Shift-Tab switches the active
 * question while each question keeps its own cursor, toggles, and custom-text
 * draft. This keeps the component's height bounded for one to four questions
 * so it fits the native dock area instead of overflowing the viewport.
 *
 * Option previews are the other unbounded input, so they render through a
 * window rather than growing the panel: the pane claims at most half the
 * terminal, pageUp/pageDown (and ctrl+k/ctrl+j) scroll it, and an indicator
 * names the visible slice. A preview taller than the window used to push the
 * panel past the viewport, hiding the transcript and the options with it.
 *
 * Native dock-swap component: it is a {@link Container}, never an overlay, so
 * the transcript stays scrollable while it is focused. Keyboard handling uses
 * the public Pi TUI input protocol (`matchesKey()` and the injected
 * `KeybindingsManager`), matching how the shipped agent views read input.
 */
export class QuestionnaireView extends Container implements Focusable {
	private readonly questions: QuestionData[];
	private readonly theme: QuestionnaireTheme;
	private readonly keybindings: KeybindingsManager | undefined;
	private readonly onComplete: ((result: QuestionnaireResult) => void) | undefined;
	private readonly states: QuestionState[];
	private readonly editor: CustomTextEditor;
	private focusedQuestion = 0;
	private editingQuestion: number | undefined;
	private readonly rows: number | (() => number) | undefined;
	private completed = false;
	private result: QuestionnaireResult | undefined;
	private lineOwners: Array<LineOwner | undefined> = [];
	private previewScroll = 0;
	/** Wrapped preview rows available to scroll; 0 when no preview is shown. */
	private previewTotal = 0;
	/** Preview rows the last render could show; 0 when no preview is shown. */
	private previewVisibleRows = 0;
	private _focused = false;

	constructor(options: QuestionnaireViewOptions) {
		super();
		this.questions = options.questions;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.onComplete = options.onComplete;
		this.rows = options.rows;
		this.states = options.questions.map(() => ({
			cursor: 0,
			toggled: new Set<number>(),
			answer: undefined,
			customDraft: "",
		}));
		this.editor = new CustomTextEditor(
			options.keybindings,
			(value) => this.submitCustom(value),
			() => this.closeEditor(),
		);
	}

	/** Focusable: propagate focus so the free-text input gets the IME cursor. */
	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.setFocused(value);
		this.invalidate();
	}

	/** Current committed result. Safe to call before completion. */
	getResult(): QuestionnaireResult {
		return this.result ?? { cancelled: false, answers: this.collectedAnswers() };
	}

	/** Active question index; exposed for tests and for callers that drive the view. */
	get activeQuestion(): number {
		return this.focusedQuestion;
	}

	handleInput(data: string): void {
		if (this.completed || isKeyRelease(data)) return;

		if (this.editingQuestion !== undefined) {
			// Tab still switches questions while editing; the draft is preserved.
			if (this.matchesTab(data, false)) {
				this.closeEditor();
				this.moveFocus(1);
				return;
			}
			if (this.matchesTab(data, true)) {
				this.closeEditor();
				this.moveFocus(-1);
				return;
			}
			this.editor.handleInput(data);
			return;
		}

		if (this.matches(data, "tui.select.cancel")) {
			this.finish({ cancelled: true, answers: this.collectedAnswers() });
			return;
		}

		if (this.matchesTab(data, false)) {
			this.moveFocus(1);
			return;
		}

		if (this.matchesTab(data, true)) {
			this.moveFocus(-1);
			return;
		}

		if (this.matches(data, "tui.select.up")) {
			this.moveCursor(-1);
			return;
		}

		if (this.matches(data, "tui.select.down")) {
			this.moveCursor(1);
			return;
		}

		if (matchesKey(data, "space")) {
			const question = this.questions[this.focusedQuestion];
			if (question?.multiSelect) {
				this.toggleCursor();
				return;
			}
		}

		// ctrl+j arrives as a bare line feed, which pi also reads as enter, so the
		// preview scroll keys are checked before the commit key.
		if (this.scrollPreviewKey(data)) return;

		if (this.matches(data, "tui.select.confirm")) {
			this.commit();
		}
	}

	override handleMouse(event: TuiMouseEvent) {
		if (this.completed) return undefined;
		if (this.editingQuestion !== undefined) return this.editor.handleMouse(event);

		const owner = this.lineOwners[event.y];
		if (!owner || owner.rowIndex < 0 || event.button !== "left") return undefined;

		if (event.type === "press") {
			const changed = this.focusRow(owner.questionIndex, owner.rowIndex);
			return { handled: true as const, focus: true, render: changed, target: this.mouseTarget(event) };
		}

		if (event.type === "click") {
			const question = this.questions[owner.questionIndex];
			this.focusRow(owner.questionIndex, owner.rowIndex);
			// A multiSelect option toggles in place; only single-select (or the
			// custom row, which opens the editor) commits on click.
			if (question?.multiSelect && owner.rowIndex < question.options.length) {
				this.toggleCursor();
			}
			else {
				this.commit();
			}
			return { handled: true as const, render: true, target: this.mouseTarget(event) };
		}

		return undefined;
	}

	override render(width: number): string[] {
		const viewport = Math.max(1, width);
		const lines: string[] = [];
		const owners: Array<LineOwner | undefined> = [];
		const push = (text: string, owner?: LineOwner) => {
			for (const line of this.wrap(text, viewport)) {
				lines.push(line);
				owners.push(owner);
			}
		};

		if (this.questions.length === 0) {
			this.lineOwners = [];
			return [];
		}

		push(this.renderTabs());
		push("");

		const bodyBudget = this.bodyRows();
		const preview = this.currentPreview();
		if (preview === undefined) {
			this.previewTotal = 0;
			this.previewVisibleRows = 0;
		}

		if (preview !== undefined && viewport >= MIN_PREVIEW_WIDTH) {
			const leftWidth = Math.max(1, Math.floor(viewport * PREVIEW_SPLIT));
			const rightWidth = Math.max(1, viewport - leftWidth - PREVIEW_GAP.length);
			const left = this.bodyWithin(leftWidth, false, bodyBudget);
			const right = this.windowedPreview(preview, rightWidth, this.previewRows());
			const rows = Math.min(bodyBudget, Math.max(left.lines.length, right.length));
			for (let index = 0; index < rows; index++) {
				lines.push(`${padTo(left.lines[index] ?? "", leftWidth)}${PREVIEW_GAP}${right[index] ?? ""}`);
				owners.push(left.owners[index]);
			}
		}
		else {
			const body = this.bodyWithin(viewport, preview !== undefined, bodyBudget);
			lines.push(...body.lines);
			owners.push(...body.owners);
		}

		push("");
		push(this.hint());

		this.lineOwners = owners;
		return lines;
	}

	override invalidate(): void {
		this.lineOwners = [];
		super.invalidate();
		this.editor.setFocused(this._focused);
	}

	/** Compact tab strip: every question is a chip, exactly one is active. */
	private renderTabs(): string {
		const total = this.questions.length;
		const progress = this.theme.fg("dim", `[${this.focusedQuestion + 1}/${total}]`);
		const chips = this.questions.map((question, index) => {
			const answered = this.states[index]?.answer !== undefined;
			const label = `${answered ? "✓ " : ""}${question.header}`;
			return index === this.focusedQuestion
				? this.accent(`▸ ${label}`)
				: this.theme.fg("muted", `  ${label}`);
		});
		return `${progress}  ${chips.join("   ")}`;
	}

	/**
	 * Body for the active question. `inlinePreviewRows` is the row budget for the
	 * focused option's inline preview, or `undefined` when no preview is drawn.
	 */
	private renderBody(width: number, inlinePreviewRows: number | undefined): { lines: string[]; owners: Array<LineOwner | undefined> } {
		const lines: string[] = [];
		const owners: Array<LineOwner | undefined> = [];
		const push = (text: string, owner?: LineOwner) => {
			for (const line of this.wrap(text, width)) {
				lines.push(line);
				owners.push(owner);
			}
		};

		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return { lines, owners };

		const headerOwner: LineOwner = { questionIndex: this.focusedQuestion, rowIndex: -1 };
		push(this.accent(question.question), headerOwner);

		if (this.editingQuestion === this.focusedQuestion) {
			for (const line of this.editor.render(width)) {
				lines.push(line);
				owners.push(headerOwner);
			}
			return { lines, owners };
		}

		const customIndex = question.options.length;
		for (const [optionIndex, option] of question.options.entries()) {
			const owner: LineOwner = { questionIndex: this.focusedQuestion, rowIndex: optionIndex };
			const cursor = state.cursor === optionIndex ? this.accent("❯ ") : "  ";
			const marker = question.multiSelect ? `${state.toggled.has(optionIndex) ? "[x]" : "[ ]"} ` : "";
			push(`${cursor}${marker}${option.label}`, owner);
			push(`    ${this.theme.fg("dim", option.description)}`, owner);
			if (inlinePreviewRows !== undefined && state.cursor === optionIndex && option.preview !== undefined) {
				for (const line of this.windowedPreview(option.preview, Math.max(1, width - 4), inlinePreviewRows)) {
					push(`    ${line}`, owner);
				}
			}
		}

		const customOwner: LineOwner = { questionIndex: this.focusedQuestion, rowIndex: customIndex };
		const customCursor = state.cursor === customIndex ? this.accent("❯ ") : "  ";
		const customDone = state.answer?.kind === "custom" ? "✓ " : "";
		push(`${customCursor}${customDone}${CUSTOM_ROW_LABEL}`, customOwner);

		return { lines, owners };
	}

	/**
	 * Body within `bodyBudget` rows. The inline preview shares the body with the
	 * option list and the rows after it, so the list is measured first and the
	 * preview window takes exactly what is left over. Sizing the window from the
	 * rows spent so far would push the free-text row off the panel.
	 */
	private bodyWithin(
		width: number,
		inlinePreview: boolean,
		bodyBudget: number,
	): { lines: string[]; owners: Array<LineOwner | undefined> } {
		if (!inlinePreview) return this.renderBody(width, undefined);
		const measured = this.renderBody(width, undefined);
		const remaining = Math.max(1, bodyBudget - measured.lines.length);
		const body = this.renderBody(width, remaining);
		return { lines: body.lines.slice(0, bodyBudget), owners: body.owners.slice(0, bodyBudget) };
	}

	/** Bottom hint for the active question's interaction model. */
	private hint(): string {
		const question = this.questions[this.focusedQuestion];
		const parts = ["↑↓ move"];
		if (question?.multiSelect) parts.push("space toggle");
		parts.push("enter select", "tab switch", "esc cancel");
		return this.theme.fg("dim", parts.join(" · "));
	}

	private wrap(text: string, width: number): string[] {
		return new Text(text, 0, 0).render(Math.max(1, width));
	}

	private accent(text: string): string {
		const bold = this.theme.bold ? this.theme.bold(text) : text;
		return this.theme.fg("accent", bold);
	}

	/** Terminal rows the host reports, or a safe default when it cannot tell. */
	private terminalRows(): number {
		const source = this.rows;
		const rows = typeof source === "function" ? source() : source;
		return typeof rows === "number" && Number.isFinite(rows) && rows > 0
			? Math.trunc(rows)
			: DEFAULT_TERMINAL_ROWS;
	}

	/**
	 * Hard ceiling for the body. The panel plus the host's frame must fit the
	 * terminal, or the host clips the tail and the hint disappears with it.
	 */
	private bodyRows(): number {
		return Math.max(MIN_BODY_ROWS, this.terminalRows() - OWN_CHROME_ROWS - HOST_FRAME_ROWS);
	}

	/**
	 * Rows the preview pane may occupy: half the terminal, floored at
	 * {@link MIN_PREVIEW_ROWS} so a short preview needs no scrolling, and capped
	 * by the body ceiling so it can never exceed the terminal.
	 */
	private previewRows(): number {
		const target = Math.floor(this.terminalRows() * PREVIEW_HEIGHT_RATIO);
		return Math.max(MIN_PREVIEW_ROWS, Math.min(this.bodyRows(), target));
	}

	/**
	 * Wrap `text` to `width` and return the visible slice for `rows`, recording
	 * the scrollable totals read by {@link scrollPreviewKey}. When the text does
	 * not fit, the last row becomes a dim indicator naming the slice and the
	 * keys, so the pane stays informative instead of silently truncating.
	 */
	private windowedPreview(text: string, width: number, rows: number): string[] {
		const wrapped = this.wrap(this.theme.fg("dim", text), Math.max(1, width));
		const budget = Math.max(1, Math.trunc(rows));
		if (wrapped.length <= budget) {
			this.previewTotal = wrapped.length;
			this.previewVisibleRows = wrapped.length;
			this.previewScroll = 0;
			return wrapped;
		}
		const contentRows = Math.max(1, budget - 1);
		const offset = Math.max(0, Math.min(wrapped.length - contentRows, this.previewScroll));
		this.previewTotal = wrapped.length;
		this.previewVisibleRows = contentRows;
		this.previewScroll = offset;
		return [
			...wrapped.slice(offset, offset + contentRows),
			// Truncated, not wrapped: the indicator must own exactly one row of the
			// window, and a long counter would otherwise widen the pane.
			truncateToWidth(
				this.theme.fg("dim", `… ${offset + contentRows}/${wrapped.length} lines · pageUp/pageDown scroll`),
				Math.max(1, width),
			),
		];
	}

	/**
	 * Preview scroll keys, checked before the commit key because ctrl+j arrives
	 * as a bare line feed that pi also reads as enter. The keys are only claimed
	 * while the preview has hidden rows, so a plain Enter still commits.
	 *
	 * The bounds come from the last render: the window depends on the wrap width,
	 * which only a render knows. The host renders a focused component before it
	 * dispatches input, so a key press always reads a measured window, and a
	 * never-rendered view reports "nothing to scroll" instead of guessing.
	 */
	private scrollPreviewKey(data: string): boolean {
		if (this.previewTotal <= this.previewVisibleRows) return false;
		if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("j"))) {
			return this.scrollPreview(this.previewVisibleRows);
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("k"))) {
			return this.scrollPreview(-this.previewVisibleRows);
		}
		return false;
	}

	/** Move the preview window, clamped to the rows the last render measured. */
	private scrollPreview(delta: number): boolean {
		const max = Math.max(0, this.previewTotal - this.previewVisibleRows);
		if (max === 0) return false;
		const next = Math.max(0, Math.min(max, this.previewScroll + Math.trunc(delta)));
		if (next === this.previewScroll) return false;
		this.previewScroll = next;
		this.invalidate();
		return true;
	}

	/**
	 * Reset the preview window when the selection moves: an offset measured
	 * against one option's preview reads as lost content on the next one.
	 */
	private resetPreviewScroll(): void {
		this.previewScroll = 0;
	}

	private currentPreview(): string | undefined {
		if (this.completed || this.editingQuestion !== undefined) return undefined;
		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return undefined;
		if (state.cursor < 0 || state.cursor >= question.options.length) return undefined;
		return question.options[state.cursor]?.preview;
	}

	private moveFocus(delta: number): void {
		const total = this.questions.length;
		if (total === 0) return;
		this.focusedQuestion = (this.focusedQuestion + delta + total) % total;
		this.resetPreviewScroll();
		this.invalidate();
	}

	private moveCursor(delta: number): void {
		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return;
		const total = question.options.length + 1;
		state.cursor = Math.max(0, Math.min(total - 1, state.cursor + delta));
		this.resetPreviewScroll();
		this.invalidate();
	}

	private toggleCursor(): void {
		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return;
		if (state.cursor === question.options.length) {
			this.openEditor(this.focusedQuestion);
			return;
		}
		if (state.toggled.has(state.cursor)) state.toggled.delete(state.cursor);
		else state.toggled.add(state.cursor);
		this.resetPreviewScroll();
		this.invalidate();
	}

	private focusRow(questionIndex: number, rowIndex: number): boolean {
		const question = this.questions[questionIndex];
		const state = this.states[questionIndex];
		if (!question || !state) return false;
		const changed = this.focusedQuestion !== questionIndex || state.cursor !== rowIndex;
		this.focusedQuestion = questionIndex;
		state.cursor = Math.max(0, Math.min(question.options.length, rowIndex));
		this.resetPreviewScroll();
		this.invalidate();
		return changed;
	}

	private commit(): void {
		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return;
		const customIndex = question.options.length;

		if (state.cursor === customIndex) {
			this.openEditor(this.focusedQuestion);
			return;
		}

		if (question.multiSelect) {
			const toggled = [...state.toggled]
				.filter((index) => index < customIndex)
				.sort((a, b) => a - b);
			if (toggled.length === 0) return;
			state.answer = {
				questionIndex: this.focusedQuestion,
				question: question.question,
				kind: "multi",
				answer: null,
				selected: toggled.map((index) => question.options[index]!.label),
			};
			this.afterCommit(this.focusedQuestion);
			return;
		}

		const option = question.options[state.cursor];
		if (!option) return;
		state.answer = {
			questionIndex: this.focusedQuestion,
			question: question.question,
			kind: "option",
			answer: option.label,
			...(option.preview !== undefined ? { preview: option.preview } : {}),
		};
		this.afterCommit(this.focusedQuestion);
	}

	private openEditor(questionIndex: number): void {
		const state = this.states[questionIndex];
		if (!state) return;
		this.editingQuestion = questionIndex;
		this.editor.setValue(state.customDraft);
		this.editor.setFocused(this._focused);
		this.invalidate();
	}

	private closeEditor(): void {
		if (this.editingQuestion === undefined) return;
		const state = this.states[this.editingQuestion];
		if (state) state.customDraft = this.editor.getValue();
		this.editingQuestion = undefined;
		this.editor.setValue("");
		this.editor.setFocused(false);
		this.invalidate();
	}

	private submitCustom(value: string): void {
		const questionIndex = this.editingQuestion;
		if (questionIndex === undefined) return;
		const question = this.questions[questionIndex];
		const state = this.states[questionIndex];
		if (!question || !state) {
			this.closeEditor();
			return;
		}
		if (value.trim().length === 0) {
			// Whitespace-only is treated as empty: discard it so reopening is clean.
			this.editor.setValue("");
			this.closeEditor();
			return;
		}
		const customIndex = question.options.length;
		const selected = [...state.toggled]
			.filter((index) => index < customIndex)
			.sort((a, b) => a - b)
			.map((index) => question.options[index]!.label);
		state.customDraft = value;
		state.answer = {
			questionIndex,
			question: question.question,
			kind: "custom",
			answer: value,
			...(question.multiSelect && selected.length > 0 ? { selected } : {}),
		};
		this.closeEditor();
		this.afterCommit(questionIndex);
	}

	private afterCommit(questionIndex: number): void {
		if (this.states.every((state) => state.answer !== undefined)) {
			this.finish({ cancelled: false, answers: this.collectedAnswers() });
			return;
		}
		// Advance to the first unanswered question so a commit is visible and the
		// tab strip keeps moving; committed answers stay reachable with Tab.
		const next = this.states.findIndex((state) => state.answer === undefined);
		if (next !== -1 && next !== questionIndex) this.focusedQuestion = next;
		this.invalidate();
	}

	private collectedAnswers(): AnswerRow[] {
		return this.states
			.map((state) => state.answer)
			.filter((answer): answer is AnswerRow => answer !== undefined);
	}

	private finish(result: QuestionnaireResult): void {
		if (this.completed) return;
		this.completed = true;
		this.result = result;
		this.onComplete?.(result);
		this.invalidate();
	}

	private matches(
		data: string,
		binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
	): boolean {
		if (this.keybindings?.matches) return this.keybindings.matches(data, binding);
		const key = binding === "tui.select.up" ? "up"
			: binding === "tui.select.down" ? "down"
				: binding === "tui.select.confirm" ? "enter" : "escape";
		return matchesKey(data, key);
	}

	private matchesTab(data: string, shift: boolean): boolean {
		if (!shift && this.keybindings?.matches) return this.keybindings.matches(data, "tui.input.tab");
		return matchesKey(data, shift ? "shift+tab" : "tab");
	}

	private mouseTarget(event: TuiMouseEvent) {
		return {
			component: this,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		};
	}
}

function padTo(line: string, width: number): string {
	const padding = width - visibleWidth(line);
	return padding > 0 ? `${line}${" ".repeat(padding)}` : line;
}
