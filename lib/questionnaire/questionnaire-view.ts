import {
	Container,
	Input,
	isKeyRelease,
	matchesKey,
	Text,
	visibleWidth,
	type KeybindingsManager,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { CUSTOM_ROW_LABEL, type QuestionData } from "./schema.ts";

/** Minimum terminal width at which the preview pane splits beside the list. */
export const MIN_PREVIEW_WIDTH = 80;

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
}

interface QuestionState {
	cursor: number;
	toggled: Set<number>;
	answer: AnswerRow | undefined;
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
		this.input.focused = true;
		this.addChild(new Text("Custom response", 1, 0));
		this.addChild(this.input);
		this.addChild(new Text("Enter to submit • Esc to return", 1, 0));
	}

	reset(): void {
		this.input.setValue("");
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
 * A single questionnaire view that renders every question as a vertical stack.
 *
 * Native dock-swap component: it is a {@link Container}, never an overlay, so
 * the transcript stays scrollable while it is focused. It owns keyboard and
 * pointer handling for all questions and completes through the `onComplete`
 * callback in the same shape as a `ctx.ui.custom` factory.
 */
export class QuestionnaireView extends Container {
	private readonly questions: QuestionData[];
	private readonly theme: QuestionnaireTheme;
	private readonly keybindings: KeybindingsManager | undefined;
	private readonly onComplete: ((result: QuestionnaireResult) => void) | undefined;
	private readonly states: QuestionState[];
	private readonly editor: CustomTextEditor;
	private focusedQuestion = 0;
	private editingQuestion: number | undefined;
	private completed = false;
	private result: QuestionnaireResult | undefined;
	private lineOwners: Array<LineOwner | undefined> = [];

	constructor(options: QuestionnaireViewOptions) {
		super();
		this.questions = options.questions;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.onComplete = options.onComplete;
		this.states = options.questions.map(() => ({ cursor: 0, toggled: new Set<number>(), answer: undefined }));
		this.editor = new CustomTextEditor(
			options.keybindings,
			(value) => this.submitCustom(value),
			() => this.closeEditor(),
		);
	}

	/** Current committed result. Safe to call before completion. */
	getResult(): QuestionnaireResult {
		return this.result ?? { cancelled: false, answers: this.collectedAnswers() };
	}

	handleInput(data: string): void {
		if (this.completed || isKeyRelease(data)) return;

		if (this.editingQuestion !== undefined) {
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

		const question = this.questions[this.focusedQuestion];
		if (question?.multiSelect && matchesKey(data, "space")) {
			this.toggleCursor();
			return;
		}

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
			this.focusRow(owner.questionIndex, owner.rowIndex);
			this.commit();
			return { handled: true as const, render: true, target: this.mouseTarget(event) };
		}

		return undefined;
	}

	override render(width: number): string[] {
		const preview = this.currentPreview();
		if (preview !== undefined && width >= MIN_PREVIEW_WIDTH) {
			return this.renderWithPreview(width, preview);
		}
		const { lines, owners } = this.renderQuestions(width, true);
		this.lineOwners = owners;
		return lines;
	}

	override invalidate(): void {
		this.lineOwners = [];
		super.invalidate();
	}

	private renderWithPreview(width: number, preview: string): string[] {
		const separator = " │ ";
		const leftWidth = Math.max(1, Math.floor(width * 0.45));
		const rightWidth = Math.max(1, width - leftWidth - separator.length);
		const { lines: left, owners } = this.renderQuestions(leftWidth, false);
		const right = this.wrapPreview(preview, rightWidth);
		const rows = Math.max(left.length, right.length);
		const out: string[] = [];
		this.lineOwners = [];
		for (let index = 0; index < rows; index++) {
			out.push(`${padTo(left[index] ?? "", leftWidth)}${separator}${right[index] ?? ""}`);
			this.lineOwners.push(owners[index]);
		}
		return out;
	}

	private renderQuestions(width: number, inlinePreview: boolean): { lines: string[]; owners: Array<LineOwner | undefined> } {
		const lines: string[] = [];
		const owners: Array<LineOwner | undefined> = [];
		const push = (text: string, owner?: LineOwner) => {
			for (const line of new Text(text, 0, 0).render(width)) {
				lines.push(line);
				owners.push(owner);
			}
		};

		for (const [questionIndex, question] of this.questions.entries()) {
			if (questionIndex > 0) push("");
			const headerOwner: LineOwner = { questionIndex, rowIndex: -1 };
			push(this.theme.fg("accent", `[${questionIndex + 1}/${this.questions.length}] ${question.header}`), headerOwner);
			push(this.accent(question.question), headerOwner);

			if (this.editingQuestion === questionIndex) {
				for (const line of this.editor.render(width)) {
					lines.push(line);
					owners.push(headerOwner);
				}
				continue;
			}

			const state = this.states[questionIndex];
			const isFocused = questionIndex === this.focusedQuestion;
			const customIndex = question.options.length;

			for (const [optionIndex, option] of question.options.entries()) {
				const owner: LineOwner = { questionIndex, rowIndex: optionIndex };
				const cursor = isFocused && state.cursor === optionIndex ? this.theme.fg("accent", "❯ ") : "  ";
				const marker = question.multiSelect ? `${state.toggled.has(optionIndex) ? "[x]" : "[ ]"} ` : "";
				push(`${cursor}${marker}${option.label}`, owner);
				push(`    ${this.theme.fg("dim", option.description)}`, owner);
				if (inlinePreview && isFocused && state.cursor === optionIndex && option.preview !== undefined) {
					for (const line of this.wrapPreview(option.preview, Math.max(1, width - 4))) {
						push(`    ${line}`, owner);
					}
				}
			}

			const customOwner: LineOwner = { questionIndex, rowIndex: customIndex };
			const customCursor = isFocused && state.cursor === customIndex ? this.theme.fg("accent", "❯ ") : "  ";
			const customMarker = question.multiSelect ? `${state.toggled.has(customIndex) ? "[x]" : "[ ]"} ` : "";
			push(`${customCursor}${customMarker}${CUSTOM_ROW_LABEL}`, customOwner);
		}

		return { lines, owners };
	}

	private wrapPreview(preview: string, width: number): string[] {
		return new Text(this.theme.fg("dim", preview), 0, 0).render(Math.max(1, width));
	}

	private accent(text: string): string {
		const bold = this.theme.bold ? this.theme.bold(text) : text;
		return this.theme.fg("accent", bold);
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
		this.invalidate();
	}

	private moveCursor(delta: number): void {
		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return;
		const total = question.options.length + 1;
		state.cursor = Math.max(0, Math.min(total - 1, state.cursor + delta));
		this.invalidate();
	}

	private toggleCursor(): void {
		const state = this.states[this.focusedQuestion];
		if (!state) return;
		if (state.toggled.has(state.cursor)) state.toggled.delete(state.cursor);
		else state.toggled.add(state.cursor);
		this.invalidate();
	}

	private focusRow(questionIndex: number, rowIndex: number): boolean {
		const question = this.questions[questionIndex];
		const state = this.states[questionIndex];
		if (!question || !state) return false;
		const changed = this.focusedQuestion !== questionIndex || state.cursor !== rowIndex;
		this.focusedQuestion = questionIndex;
		state.cursor = Math.max(0, Math.min(question.options.length, rowIndex));
		this.invalidate();
		return changed;
	}

	private commit(): void {
		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return;
		const customIndex = question.options.length;

		if (question.multiSelect) {
			if (state.toggled.has(customIndex)) {
				this.openEditor(this.focusedQuestion);
				return;
			}
			const toggled = [...state.toggled].filter((index) => index < customIndex).sort((a, b) => a - b);
			if (toggled.length === 0) return;
			state.answer = {
				questionIndex: this.focusedQuestion,
				question: question.question,
				kind: "multi",
				answer: null,
				selected: toggled.map((index) => question.options[index].label),
			};
			this.afterCommit(this.focusedQuestion);
			return;
		}

		if (state.cursor === customIndex) {
			this.openEditor(this.focusedQuestion);
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
		this.editingQuestion = questionIndex;
		this.editor.reset();
		this.invalidate();
	}

	private closeEditor(): void {
		if (this.editingQuestion === undefined) return;
		this.editingQuestion = undefined;
		this.editor.reset();
		this.invalidate();
	}

	private submitCustom(value: string): void {
		const questionIndex = this.editingQuestion;
		if (questionIndex === undefined) return;
		if (value.trim().length === 0) {
			this.closeEditor();
			return;
		}
		const question = this.questions[questionIndex];
		const state = this.states[questionIndex];
		if (!question || !state) {
			this.closeEditor();
			return;
		}
		const customIndex = question.options.length;
		const selected = [...state.toggled]
			.filter((index) => index < customIndex)
			.sort((a, b) => a - b)
			.map((index) => question.options[index].label);
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
		if (questionIndex === this.questions.length - 1 || this.states.every((state) => state.answer !== undefined)) {
			this.finish({ cancelled: false, answers: this.collectedAnswers() });
			return;
		}
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
