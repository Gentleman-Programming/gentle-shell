import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
	CUSTOM_ROW_LABEL,
	MAX_HEADER_LENGTH,
	MAX_LABEL_LENGTH,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	QuestionParamsSchema,
	type OptionData,
	type QuestionParams,
} from "../lib/questionnaire/schema.ts";
import { validateQuestionnaire, type QuestionnaireError } from "../lib/questionnaire/validate.ts";

const H = "Header";
const option = (label: string, preview?: string): OptionData =>
	preview === undefined ? { label, description: `${label} description` } : { label, description: `${label} description`, preview };

const question = (
	text: string,
	options: OptionData[],
	overrides: { header?: string; multiSelect?: boolean } = {},
) => ({
	question: text,
	header: overrides.header ?? H,
	options,
	...(overrides.multiSelect === undefined ? {} : { multiSelect: overrides.multiSelect }),
});

const params = (questions: ReturnType<typeof question>[]): QuestionParams => ({ questions });
const valid = (): ReturnType<typeof question>[] => [question("First?", [option("Alpha"), option("Beta")])];

interface Case {
	name: string;
	input: ReturnType<typeof params>;
	expected: QuestionnaireError | undefined;
}

function makeCases(): Case[] {
	return [
		{ name: "accepts a minimal valid questionnaire", input: params(valid()), expected: undefined },
		{
			name: "accepts exactly one question with two options",
			input: params([question("Solo?", [option("A"), option("B")])]),
			expected: undefined,
		},
		{
			name: "accepts exactly four questions and four options",
			input: params([
				question("Q1", [option("A1"), option("B1"), option("C1"), option("D1")]),
				question("Q2", [option("A2"), option("B2")]),
				question("Q3", [option("A3"), option("B3")]),
				question("Q4", [option("A4"), option("B4")]),
			]),
			expected: undefined,
		},
		{
			name: "accepts a header at the 16 character limit",
			input: params([question("Long header?", [option("A"), option("B")], { header: "x".repeat(MAX_HEADER_LENGTH) })]),
			expected: undefined,
		},
		{
			name: "accepts a label at the 60 character limit",
			input: params([question("Long label?", [option("y".repeat(MAX_LABEL_LENGTH)), option("B")])]),
			expected: undefined,
		},
		{
			name: "rejects an empty question list",
			input: params([]),
			expected: { code: "no_questions", message: "At least one question is required." },
		},
		{
			name: "rejects a question with empty options",
			input: params([question("Empty?", [])]),
			expected: {
				code: "empty_options",
				message: "Question 1 must declare at least one option.",
				questionIndex: 0,
			},
		},
		{
			name: "rejects a single option below the minimum",
			input: params([question("One?", [option("Only")])]),
			expected: {
				code: "option_count",
				message: "Question 1 must have between 2 and 4 options, received 1.",
				questionIndex: 0,
				count: 1,
			},
		},
		{
			name: "rejects five options above the maximum",
			input: params([question("Five?", [option("A"), option("B"), option("C"), option("D"), option("E")])]),
			expected: {
				code: "option_count",
				message: "Question 1 must have between 2 and 4 options, received 5.",
				questionIndex: 0,
				count: 5,
			},
		},
		{
			name: "rejects more than four questions",
			input: params([
				question("Q1", [option("A1"), option("B1")]),
				question("Q2", [option("A2"), option("B2")]),
				question("Q3", [option("A3"), option("B3")]),
				question("Q4", [option("A4"), option("B4")]),
				question("Q5", [option("A5"), option("B5")]),
			]),
			expected: {
				code: "too_many_questions",
				message: "A questionnaire accepts at most 4 questions, received 5.",
				count: 5,
			},
		},
		{
			name: "rejects duplicate question text",
			input: params([
				question("Same?", [option("A1"), option("B1")]),
				question("Same?", [option("A2"), option("B2")]),
			]),
			expected: {
				code: "duplicate_question",
				message: "Question 2 duplicates an earlier question text.",
				questionIndex: 1,
			},
		},
		{
			name: "rejects a duplicate option label within one question",
			input: params([question("Dupe?", [option("Alpha"), option("Alpha")])]),
			expected: {
				code: "duplicate_option_label",
				message: 'Question 1 option 2 duplicates the label "Alpha".',
				questionIndex: 0,
				optionIndex: 1,
				label: "Alpha",
			},
		},
		{
			name: "rejects a label over the 60 character limit",
			input: params([question("Too long?", [option("z".repeat(MAX_LABEL_LENGTH + 1)), option("B")])]),
			expected: {
				code: "label_too_long",
				message: "Question 1 option 1 label exceeds 60 characters.",
				questionIndex: 0,
				optionIndex: 0,
				length: MAX_LABEL_LENGTH + 1,
			},
		},
		{
			name: "rejects a header over the 16 character limit",
			input: params([question("Header too long?", [option("A"), option("B")], { header: "x".repeat(MAX_HEADER_LENGTH + 1) })]),
			expected: {
				code: "header_too_long",
				message: "Question 1 header exceeds 16 characters.",
				questionIndex: 0,
				length: MAX_HEADER_LENGTH + 1,
			},
		},
		{
			name: "rejects the reserved Other label",
			input: params([question("Reserved?", [option("Other"), option("B")])]),
			expected: {
				code: "reserved_label",
				message: 'Question 1 option 1 uses the reserved label "Other".',
				questionIndex: 0,
				optionIndex: 0,
				label: "Other",
			},
		},
		{
			name: "rejects the reserved custom-row label",
			input: params([question("Reserved?", [option(CUSTOM_ROW_LABEL), option("B")])]),
			expected: {
				code: "reserved_label",
				message: `Question 1 option 1 uses the reserved label "${CUSTOM_ROW_LABEL}".`,
				questionIndex: 0,
				optionIndex: 0,
				label: CUSTOM_ROW_LABEL,
			},
		},
		{
			name: "does not treat a reserved label with different casing as reserved",
			input: params([question("Case?", [option("other"), option("type something.")])]),
			expected: undefined,
		},
		{
			name: "reports a duplicated question before its duplicated option label",
			input: params([
				question("Same?", [option("A"), option("B")]),
				question("Same?", [option("A"), option("B")]),
			]),
			expected: {
				code: "duplicate_question",
				message: "Question 2 duplicates an earlier question text.",
				questionIndex: 1,
			},
		},
	];
}

test("validateQuestionnaire reports the first violation for each guard", () => {
	for (const testCase of makeCases()) {
		const actual = validateQuestionnaire(testCase.input);
		assert.deepEqual(actual, testCase.expected, testCase.name);
	}
});

test("schema constants expose the documented limits", () => {
	assert.equal(MAX_QUESTIONS, 4);
	assert.equal(MIN_OPTIONS, 2);
	assert.equal(MAX_OPTIONS, 4);
	assert.equal(MAX_HEADER_LENGTH, 16);
	assert.equal(MAX_LABEL_LENGTH, 60);
	assert.equal(CUSTOM_ROW_LABEL, "Type something.");
});

test("QuestionParamsSchema pins the questionnaire parameter shape", () => {
	const root = QuestionParamsSchema as unknown as {
		additionalProperties?: boolean;
		properties?: {
			questions?: {
				minItems?: number;
				maxItems?: number;
				items?: {
					additionalProperties?: boolean;
					properties?: Record<string, unknown>;
					required?: string[];
				};
			};
		};
	};
	const questions = root.properties?.questions;
	const questionSchema = questions?.items;
	const questionProperties = questionSchema?.properties ?? {};

	assert.equal(root.additionalProperties, false);
	assert.equal(questions?.minItems, 1);
	assert.equal(questions?.maxItems, MAX_QUESTIONS);
	assert.equal(questionSchema?.additionalProperties, false);
	assert.deepEqual([...(questionSchema?.required ?? [])].sort(), ["header", "options", "question"]);
	assert.deepEqual(Object.keys(questionProperties).sort(), ["header", "multiSelect", "options", "question"]);
});

test("schema rejects malformed questionnaire parameters", () => {
	const validParams = params(valid());
	assert.equal(Value.Check(QuestionParamsSchema, validParams), true);

	const invalidCases: Array<[string, unknown]> = [
		["missing questions", {}],
		["empty questions", { questions: [] }],
		["five questions", params([
			question("Q1", [option("A1"), option("B1")]),
			question("Q2", [option("A2"), option("B2")]),
			question("Q3", [option("A3"), option("B3")]),
			question("Q4", [option("A4"), option("B4")]),
			question("Q5", [option("A5"), option("B5")]),
		])],
		["one option", params([question("One?", [option("Only")])])],
		["label over the limit", params([question("Long?", [option("z".repeat(MAX_LABEL_LENGTH + 1)), option("B")])])],
		["header over the limit", params([question("Long?", [option("A"), option("B")], { header: "x".repeat(MAX_HEADER_LENGTH + 1) })])],
		["unknown root property", { questions: valid(), extra: true }],
	];
	for (const [name, subject] of invalidCases) {
		assert.equal(Value.Check(QuestionParamsSchema, subject), false, name);
	}
});

test("schema accepts multiSelect and preview as optional fields", () => {
	const withOptionals = params([question("Options?", [option("A", "Preview A"), option("B")], { multiSelect: true })]);
	assert.equal(Value.Check(QuestionParamsSchema, withOptionals), true);
});
