import {
	CUSTOM_ROW_LABEL,
	MAX_HEADER_LENGTH,
	MAX_LABEL_LENGTH,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionParams,
} from "./schema.ts";

/**
 * A single questionnaire validation violation, keyed by `code` so callers can
 * branch without parsing the human-readable message.
 */
export type QuestionnaireError =
	| { code: "no_questions"; message: string }
	| { code: "empty_options"; message: string; questionIndex: number }
	| { code: "option_count"; message: string; questionIndex: number; count: number }
	| { code: "too_many_questions"; message: string; count: number }
	| { code: "duplicate_question"; message: string; questionIndex: number }
	| { code: "duplicate_option_label"; message: string; questionIndex: number; optionIndex: number; label: string }
	| { code: "label_too_long"; message: string; questionIndex: number; optionIndex: number; length: number }
	| { code: "header_too_long"; message: string; questionIndex: number; length: number }
	| { code: "reserved_label"; message: string; questionIndex: number; optionIndex: number; label: string };

/**
 * Validate questionnaire parameters and return the first violation in a fixed
 * precedence order, or `undefined` when the parameters are valid.
 *
 * Precedence: no questions, empty options, option count, question count,
 * duplicate question text, duplicate option label, label length, header
 * length, then reserved custom-row labels.
 */
export function validateQuestionnaire(params: QuestionParams): QuestionnaireError | undefined {
	const questions = Array.isArray(params?.questions) ? params.questions : [];

	if (questions.length === 0) {
		return { code: "no_questions", message: "At least one question is required." };
	}

	for (const [questionIndex, question] of questions.entries()) {
		if (!Array.isArray(question?.options) || question.options.length === 0) {
			return {
				code: "empty_options",
				message: `Question ${questionIndex + 1} must declare at least one option.`,
				questionIndex,
			};
		}
	}

	for (const [questionIndex, question] of questions.entries()) {
		const count = question.options.length;
		if (count < MIN_OPTIONS || count > MAX_OPTIONS) {
			return {
				code: "option_count",
				message: `Question ${questionIndex + 1} must have between ${MIN_OPTIONS} and ${MAX_OPTIONS} options, received ${count}.`,
				questionIndex,
				count,
			};
		}
	}

	if (questions.length > MAX_QUESTIONS) {
		return {
			code: "too_many_questions",
			message: `A questionnaire accepts at most ${MAX_QUESTIONS} questions, received ${questions.length}.`,
			count: questions.length,
		};
	}

	const seenQuestions = new Set<string>();
	for (const [questionIndex, question] of questions.entries()) {
		if (seenQuestions.has(question.question)) {
			return {
				code: "duplicate_question",
				message: `Question ${questionIndex + 1} duplicates an earlier question text.`,
				questionIndex,
			};
		}
		seenQuestions.add(question.question);
	}

	// Checked after duplicate questions so a repeated question points at the
	// duplicate itself rather than one of its option labels.
	for (const [questionIndex, question] of questions.entries()) {
		const seenLabels = new Set<string>();
		for (const [optionIndex, option] of question.options.entries()) {
			if (seenLabels.has(option.label)) {
				return {
					code: "duplicate_option_label",
					message: `Question ${questionIndex + 1} option ${optionIndex + 1} duplicates the label "${option.label}".`,
					questionIndex,
					optionIndex,
					label: option.label,
				};
			}
			seenLabels.add(option.label);
		}
	}

	for (const [questionIndex, question] of questions.entries()) {
		for (const [optionIndex, option] of question.options.entries()) {
			if (option.label.length > MAX_LABEL_LENGTH) {
				return {
					code: "label_too_long",
					message: `Question ${questionIndex + 1} option ${optionIndex + 1} label exceeds ${MAX_LABEL_LENGTH} characters.`,
					questionIndex,
					optionIndex,
					length: option.label.length,
				};
			}
		}
	}

	for (const [questionIndex, question] of questions.entries()) {
		if (question.header.length > MAX_HEADER_LENGTH) {
			return {
				code: "header_too_long",
				message: `Question ${questionIndex + 1} header exceeds ${MAX_HEADER_LENGTH} characters.`,
				questionIndex,
				length: question.header.length,
			};
		}
	}

	for (const [questionIndex, question] of questions.entries()) {
		for (const [optionIndex, option] of question.options.entries()) {
			if (option.label === "Other" || option.label === CUSTOM_ROW_LABEL) {
				return {
					code: "reserved_label",
					message: `Question ${questionIndex + 1} option ${optionIndex + 1} uses the reserved label "${option.label}".`,
					questionIndex,
					optionIndex,
					label: option.label,
				};
			}
		}
	}

	return undefined;
}
