import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuestionParams } from "./questionnaire/schema.ts";
import type { AnswerRow } from "./questionnaire/questionnaire-view.ts";
import { isInteractiveMode } from "./rpc-host.ts";

type AnswerContext = Pick<ExtensionContext, "sessionManager" | "cwd" | "mode" | "hasUI">;
export type HumanAnswer =
	| { readonly kind: "option" | "custom"; readonly text: string; readonly selected?: readonly string[] }
	| { readonly kind: "multi"; readonly selected: readonly string[] };
export interface HumanAnswerReceipt {
	readonly sessionManager: ExtensionContext["sessionManager"];
	readonly sessionId: string;
	readonly cwd: string;
	readonly branchAnchor: string | null;
	readonly toolName: "ask_user_choice" | "ask_user_question";
	readonly toolCallId: string;
	readonly questionIndex: number;
	/** Untrusted referent, never an instruction or an authorization. */
	readonly question: string;
	/** Full original prompt context, untrusted and inseparable from its answer. */
	readonly prompt: string;
	/** Authenticated human response; opaque tokens and previews are excluded. */
	readonly answer: HumanAnswer;
}
interface Subscription {
	ctx: AnswerContext;
	sessionId: string;
	cwd: string;
	callback: (receipt: HumanAnswerReceipt) => void;
}
const subscriptions = new WeakMap<object, Set<Subscription>>();

/** Subscribe from a trusted host context; dispose on session shutdown/replacement. */
export function subscribeHumanAnswers(ctx: AnswerContext, callback: (receipt: HumanAnswerReceipt) => void): () => void {
	if (!ctx.sessionManager || !isInteractiveMode(ctx.mode, process.env) || ctx.hasUI === false) return () => {};
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionId || !ctx.cwd) return () => {};
	let listeners = subscriptions.get(ctx.sessionManager);
	if (!listeners) subscriptions.set(ctx.sessionManager, listeners = new Set());
	const subscription = { ctx, sessionId, cwd: ctx.cwd, callback };
	listeners.add(subscription);
	return () => { listeners.delete(subscription); };
}

/** Host-only capture seam. Call before mounting UI, never from tool_result. */
function beginCapture(ctx: AnswerContext, toolName: HumanAnswerReceipt["toolName"], toolCallId: string, questions: ReadonlyArray<{ question: string; prompt: string }>, signal?: AbortSignal) {
	const manager = ctx.sessionManager;
	const sessionId = manager?.getSessionId();
	const cwd = ctx.cwd;
	const branchAnchor = manager?.getLeafId?.();
	const listeners = manager ? subscriptions.get(manager) : undefined;
	const eligible = [...(listeners ?? [])].filter((entry) => entry.sessionId === sessionId && entry.cwd === cwd);
	const interactive = isInteractiveMode(ctx.mode, process.env) && ctx.hasUI !== false;
	let finished = false;
	return (answers: ReadonlyArray<{ questionIndex: number; answer: HumanAnswer }>) => {
		if (finished) return;
		finished = true;
		if (!interactive || !isInteractiveMode(ctx.mode, process.env) || ctx.hasUI === false ||
			!manager || !sessionId || signal?.aborted || ctx.sessionManager !== manager ||
			manager.getSessionId() !== sessionId || ctx.cwd !== cwd || branchAnchor === undefined || manager.getLeafId() !== branchAnchor) return;
		for (const { questionIndex, answer } of answers) {
			const referent = questions[questionIndex];
			if (referent === undefined) continue;
			const { question, prompt } = referent;
			const receipt = Object.freeze({ sessionManager: manager, sessionId, cwd, branchAnchor, toolName, toolCallId, questionIndex, question, prompt,
				answer: Object.freeze({ ...answer, ...(answer.selected ? { selected: Object.freeze([...answer.selected]) } : {}) }) });
			for (const entry of eligible) {
				if (!listeners?.has(entry) || !isInteractiveMode(entry.ctx.mode, process.env) || entry.ctx.hasUI === false ||
					entry.ctx.sessionManager !== manager || entry.ctx.cwd !== cwd ||
					manager.getSessionId() !== sessionId || manager.getLeafId() !== branchAnchor || signal?.aborted) continue;
				// Observers must not change the existing public tool outcome.
				try { entry.callback(receipt); } catch { /* Isolate host observer failures. */ }
			}
		}
	};
}

interface ChoicePrompt {
	question: string;
	options: Array<{ label: string; description?: string; value: string }>;
	allowCustomResponse?: boolean;
}
export function captureChoiceAnswer(ctx: AnswerContext, toolCallId: string, params: ChoicePrompt, signal?: AbortSignal) {
	const options = params.options.map((option) => ({ ...option }));
	const allowCustom = params.allowCustomResponse === true;
	const prompt = JSON.stringify({ question: params.question,
		options: options.map(({ label, description }) => ({ label, description })), allowCustomResponse: allowCustom });
	const publish = beginCapture(ctx, "ask_user_choice", toolCallId, [{ question: params.question, prompt }], signal);
	return (selection: { value: string; label: string; index: number } | { customResponse: string } | undefined) => {
		if (!selection) return;
		if ("customResponse" in selection) {
			if (allowCustom && typeof selection.customResponse === "string" && selection.customResponse.trim())
				publish([{ questionIndex: 0, answer: { kind: "custom", text: selection.customResponse } }]);
			return;
		}
		const option = options[selection.index - 1];
		if (Number.isInteger(selection.index) && option && selection.label === option.label && selection.value === option.value)
			publish([{ questionIndex: 0, answer: { kind: "option", text: option.label } }]);
	};
}

export function captureQuestionnaireAnswers(ctx: AnswerContext, toolCallId: string, params: QuestionParams, signal?: AbortSignal) {
	const questions = params.questions.map((question) => ({ ...question, options: question.options.map((option) => ({ ...option })) }));
	const referents = questions.map((question) => ({ question: question.question, prompt: JSON.stringify({
		question: question.question, header: question.header, multiSelect: question.multiSelect === true,
		options: question.options.map(({ label, description, preview }) => ({ label, description,
			...(ctx.mode === "tui" && preview !== undefined ? { preview } : {}) })),
	}) }));
	const publish = beginCapture(ctx, "ask_user_question", toolCallId, referents, signal);
	return (rows: AnswerRow[] | undefined) => {
		if (!rows?.length) return;
		const seen = new Set<number>();
		const answers: Array<{ questionIndex: number; answer: HumanAnswer }> = [];
		for (const row of rows) {
			const question = questions[row.questionIndex];
			if (!Number.isInteger(row.questionIndex) || !question || seen.has(row.questionIndex) || row.question !== question.question) return;
			seen.add(row.questionIndex);
			const labels = question.options.map((option) => option.label);
			const selected = row.selected;
			if (selected && (!question.multiSelect || new Set(selected).size !== selected.length || selected.some((label) => !labels.includes(label)))) return;
			let answer: HumanAnswer;
			if (row.kind === "option" && typeof row.answer === "string" && labels.includes(row.answer) && !question.multiSelect && !selected)
				answer = { kind: "option", text: row.answer };
			else if (row.kind === "custom" && typeof row.answer === "string" && row.answer.trim())
				answer = { kind: "custom", text: row.answer, ...(selected ? { selected } : {}) };
			else if (row.kind === "multi" && question.multiSelect && selected && row.answer === null)
				answer = { kind: "multi", selected };
			else return;
			answers.push({ questionIndex: row.questionIndex, answer });
		}
		publish(answers);
	};
}
