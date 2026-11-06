import { type Static, Type } from "typebox";

/** Maximum number of questions accepted by one questionnaire. */
export const MAX_QUESTIONS = 4;

/** Minimum number of authored options per question. */
export const MIN_OPTIONS = 2;

/** Maximum number of authored options per question. */
export const MAX_OPTIONS = 4;

/** Maximum length of a question header chip. */
export const MAX_HEADER_LENGTH = 16;

/** Maximum length of an authored option label. */
export const MAX_LABEL_LENGTH = 60;

/**
 * Label of the free-text row that the view always appends after the authored
 * options. Authors must not create an option that collides with it.
 */
export const CUSTOM_ROW_LABEL = "Type something.";

const OptionSchema = Type.Object(
	{
		label: Type.String({
			maxLength: MAX_LABEL_LENGTH,
			description: "Short user-facing option label",
		}),
		description: Type.String({
			description: "One-line explanation shown under the label",
		}),
		preview: Type.Optional(Type.String({
			description: "Optional markdown-flavored preview shown beside the focused option",
		})),
	},
	{ additionalProperties: false },
);

const QuestionSchema = Type.Object(
	{
		question: Type.String({ description: "The full question text" }),
		header: Type.String({
			maxLength: MAX_HEADER_LENGTH,
			description: "Short progress header, at most 16 characters",
		}),
		options: Type.Array(OptionSchema, {
			minItems: MIN_OPTIONS,
			maxItems: MAX_OPTIONS,
			description: "Two to four ordered options",
		}),
		multiSelect: Type.Optional(Type.Boolean({
			default: false,
			description: "Allow selecting more than one option for this question",
		})),
	},
	{ additionalProperties: false },
);

/**
 * Typebox parameters for the native `ask_user_question` tool: one to four
 * questions rendered together as a single questionnaire.
 */
export const QuestionParamsSchema = Type.Object(
	{
		questions: Type.Array(QuestionSchema, {
			minItems: 1,
			maxItems: MAX_QUESTIONS,
			description: "One to four questions rendered as a single questionnaire",
		}),
	},
	{ additionalProperties: false },
);

/** One authored option as received from the tool call. */
export type OptionData = Static<typeof OptionSchema>;

/** One authored question as received from the tool call. */
export type QuestionData = Static<typeof QuestionSchema>;

/** Validated tool parameters for the questionnaire. */
export type QuestionParams = Static<typeof QuestionParamsSchema>;
