// Gentle Shell Desktop answers for sessions outside Herdr app (odd/tasks/herdr-desktop.md
// T11, S10). The ask tools (extensions/ask-user-choice.ts, ask-user-question.ts) register one
// handle per open TUI list, by tool call id, in a process-wide registry (not on the event bus:
// the tools' bus traffic stays exactly as it was); the desktop feed looks the open question's
// handle up and, for an `answer_question { via: "session" }` action, answers through it. The handle finishes
// the list exactly as a click or Enter in it would (the same result shape, once), so the tool,
// its renderer and its answer capture see an ordinary answer. Which questions the desktop may
// answer at all is still decided by lib/desktop-feed-actions.ts (no relayed consent, no
// multi-question or multi-select list); the handle only refuses what its list cannot take.

/** One registry per process, whichever copy of this module an extension loaded. */
const REGISTRY = Symbol.for("gentle-pi.desktop.ask-answer-handles/v1");
/** Open lists remembered at most; finished ones are dropped at the next registration. */
const MAX_HANDLES = 16;

export interface AskAnswerPick { option?: number; text?: string }

export interface AskAnswerHandle {
	toolCallId: string;
	/** Answers the list once; false when it is finished or cannot take this answer. */
	answer(pick: AskAnswerPick): boolean;
}

interface Entry { handle: AskAnswerHandle; finished: () => boolean }

function registry(): Map<string, Entry> {
	const global = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>;
	let map = global[REGISTRY];
	if (!(map instanceof Map)) { map = new Map(); global[REGISTRY] = map; }
	return map;
}

/** The answer handle of the open ask tool list with this tool call id, if it is still open. */
export function askAnswerHandle(toolCallId: string): AskAnswerHandle | undefined {
	const entry = registry().get(toolCallId);
	if (!entry) return undefined;
	let finished = true;
	try { finished = entry.finished(); } catch { finished = true; }
	if (finished) { registry().delete(toolCallId); return undefined; }
	return entry.handle;
}

export function isAskAnswerHandle(value: unknown): value is AskAnswerHandle {
	if (value === null || typeof value !== "object") return false;
	const handle = value as Partial<AskAnswerHandle>;
	return typeof handle.toolCallId === "string" && handle.toolCallId.length > 0 && typeof handle.answer === "function";
}

const optionIndex = (pick: AskAnswerPick, count: number): number | undefined =>
	Number.isInteger(pick.option) && (pick.option as number) >= 0 && (pick.option as number) < count ? pick.option : undefined;
// A relayed provider consent's own answers: never given from the desktop, whatever
// lib/desktop-feed-actions.ts decided (defence in depth).
const CONSENT_TOKENS = new Set(["granted", "declined"]);
const consentToken = (value: string | undefined): boolean => value !== undefined && CONSENT_TOKENS.has(value.trim().toLowerCase());
const typed = (pick: AskAnswerPick): string | undefined =>
	typeof pick.text === "string" && pick.text.trim().length > 0 && !consentToken(pick.text) ? pick.text : undefined;

function register(handle: AskAnswerHandle, finished: () => boolean): void {
	const map = registry();
	for (const [id, entry] of map) {
		let done = true;
		try { done = entry.finished(); } catch { done = true; }
		if (done) map.delete(id);
	}
	map.delete(handle.toolCallId);
	map.set(handle.toolCallId, { handle, finished });
	while (map.size > MAX_HANDLES) map.delete(map.keys().next().value as string);
}

interface ChoiceParamsLike {
	options: ReadonlyArray<{ label: string; value: string }>;
	allowCustomResponse?: boolean;
}
type ChoiceAnswer = { value: string; label: string; index: number } | { customResponse: string };

/** ask_user_choice: `finish` is the list's own finish (an option or the Other… response). */
export function publishChoiceAnswerHandle(toolCallId: string, params: ChoiceParamsLike, finish: (result: ChoiceAnswer) => void, finished: () => boolean): void {
	const handle: AskAnswerHandle = {
		toolCallId,
		answer(pick) {
			if (finished()) return false;
			if (pick.text !== undefined) {
				const text = typed(pick);
				if (params.allowCustomResponse !== true || text === undefined) return false;
				finish({ customResponse: text });
				return true;
			}
			const index = optionIndex(pick, params.options.length);
			const option = index === undefined ? undefined : params.options[index];
			if (index === undefined || !option || consentToken(option.value) || consentToken(option.label)) return false;
			finish({ value: option.value, label: option.label, index: index + 1 });
			return true;
		},
	};
	register(handle, finished);
}

interface QuestionLike {
	question: string;
	multiSelect?: boolean;
	options: ReadonlyArray<{ label: string; preview?: string }>;
}
interface QuestionnaireAnswer {
	cancelled: false;
	answers: Array<{ questionIndex: number; question: string; kind: "option" | "custom"; answer: string; preview?: string }>;
}

/** ask_user_question: one single-select question only; `complete` is the view's own completion. */
export function publishQuestionnaireAnswerHandle(toolCallId: string, questions: ReadonlyArray<QuestionLike>, complete: (result: QuestionnaireAnswer) => void, finished: () => boolean): void {
	const handle: AskAnswerHandle = {
		toolCallId,
		answer(pick) {
			const question = questions[0];
			if (finished() || questions.length !== 1 || !question || question.multiSelect === true) return false;
			if (pick.text !== undefined) {
				const text = typed(pick);
				if (text === undefined) return false;
				complete({ cancelled: false, answers: [{ questionIndex: 0, question: question.question, kind: "custom", answer: text }] });
				return true;
			}
			const index = optionIndex(pick, question.options.length);
			const option = index === undefined ? undefined : question.options[index];
			if (!option || consentToken(option.label)) return false;
			complete({ cancelled: false, answers: [{ questionIndex: 0, question: question.question, kind: "option", answer: option.label, ...(option.preview !== undefined ? { preview: option.preview } : {}) }] });
			return true;
		},
	};
	register(handle, finished);
}
