import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createNativeFullscreenInteraction } from "../lib/native-fullscreen-interaction.ts";
import { type QuestionParams, QuestionParamsSchema } from "../lib/questionnaire/schema.ts";
import {
	QuestionnaireView,
	type AnswerRow,
	type QuestionnaireResult,
} from "../lib/questionnaire/questionnaire-view.ts";
import { validateQuestionnaire, type QuestionnaireError } from "../lib/questionnaire/validate.ts";

const QUESTION_TOOL_NAME = "ask_user_question";
const ASK_USER_QUESTION_BLOCKED_EVENT = "gentle-pi:ask-user-question:blocked";

/** Maximum characters kept from a renderCall question summary. */
const CALL_SUMMARY_LIMIT = 120;

/** Structured details returned by the tool for UI rendering and callers. */
interface QuestionnaireDetails {
	cancelled?: boolean;
	answers?: AnswerRow[];
	error?: QuestionnaireError;
	errorKind?: string;
}

/** Content plus details returned by `execute`. */
interface QuestionnaireToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: QuestionnaireDetails;
}

/**
 * Invalid-parameter result. `AgentToolResult` has no `isError` field, so this
 * follows the repository convention for rejected tool input: a leading error
 * sentence in `content` plus a machine-readable payload in `details`
 * (`extensions/gentle-todo.ts` returns `Error: ...` with `details.error`).
 */
function invalidQuestionnaireResult(error: QuestionnaireError): QuestionnaireToolResult {
	return {
		content: [{ type: "text", text: `Invalid questionnaire: ${error.message}` }],
		details: { error, errorKind: error.code },
	};
}

/** Non-interactive result; parity with ask_user_choice's TUI-only guard. */
function unavailableResult(): QuestionnaireToolResult {
	return {
		content: [{ type: "text", text: "Error: ask_user_question is unavailable outside the interactive TUI" }],
		details: { errorKind: "unavailable_outside_tui" },
	};
}

/**
 * Human-readable body for one answer. A custom answer on a multiSelect
 * question keeps the toggled options, so the text must name them explicitly:
 * the free-text value alone would silently drop the user's selections. Plain
 * custom answers (no selections) stay concise.
 */
function answerBody(answer: AnswerRow): string {
	if (answer.kind === "multi") return `selected: ${(answer.selected ?? []).join(", ")}`;
	if (answer.kind === "custom") {
		const body = `(custom) ${answer.answer ?? ""}`;
		const selected = answer.selected ?? [];
		return selected.length > 0 ? `${body} — selected: ${selected.join(", ")}` : body;
	}
	return answer.answer ?? "";
}

/**
 * Compact LLM-facing transcript of the committed answers. Each row keeps the
 * original one-based question index so a partially answered questionnaire
 * (the last question committed early) still reads in order.
 */
function answersText(answers: AnswerRow[]): string {
	if (answers.length === 0) return "The user answered the questionnaire.";
	const lines: string[] = [];
	for (const answer of answers) {
		const prefix = `${answer.questionIndex + 1}. ${answer.question}`;
		lines.push(`${prefix} — ${answerBody(answer)}`);
		if (answer.preview !== undefined) lines.push(`   selected preview: ${answer.preview}`);
	}
	return lines.join("\n");
}

/** Single-line summary of one question for the collapsed tool call row. */
function callSummary(question: unknown, index: number): string {
	const source = typeof question === "object" && question !== null ? question as { header?: unknown; options?: unknown } : {};
	const header = typeof source.header === "string" ? source.header : "";
	const labels = Array.isArray(source.options)
		? source.options
			.map((option) => (typeof option === "object" && option !== null && typeof (option as { label?: unknown }).label === "string"
				? (option as { label: string }).label
				: ""))
			.filter((label) => label.length > 0)
		: [];
	const labelsPart = labels.length > 0 ? ` (${labels.join(", ")})` : "";
	return `${index + 1}. ${header}${labelsPart}`;
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Register the first-party questionnaire tool.
 *
 * Name-collision semantics (live-verified against the installed Pi runtime):
 * - Tool names are exclusive across extensions. Pi has no precedence, override,
 *   or silent shadowing: loading two extensions that register the same tool
 *   name fails the whole load with a hard error
 *   (`Tool "ask_user_question" conflicts with <other extension>`; the runtime
 *   exits non-zero). The name is either free or fatal, full stop.
 * - `registerTool` writes into the calling extension's own tool map keyed by
 *   name, so re-registering inside one extension overwrites that entry
 *   (`loader.js:240`). That same-name write is the only one Pi tolerates.
 * - This first-party tool ships as THE `ask_user_question` provider. A competing
 *   provider such as the third-party `@juicesharp/rpiv-ask-user-question`
 *   package fails the load by design and must be removed from the user's Pi
 *   settings; that deletion is the documented migration path, not a runtime
 *   precedence choice.
 */
export default function askUserQuestion(pi: ExtensionAPI): void {
	pi.registerTool({
		name: QUESTION_TOOL_NAME,
		renderShell: "self",
		label: "Ask User Question",
		description: "Ask one to four structured questions in a single call, each with two to four ordered options, and read the user's answers back in one result.",
		promptGuidelines: [
			"Use ask_user_question to collect decisions in one batch: ask one to four questions at a time, each with two to four options.",
			"Keep each header a short chip of at most 16 characters and each option label at most 60 characters.",
			"Add a preview to an option when the user needs to compare rich detail side-by-side with the options.",
			"Set multiSelect when the choices are not mutually exclusive.",
			"The free-text \"Type something.\" row is always available and is also how the user bails out into a normal conversation; never rely on it as a hidden escape hatch.",
			"Never use this tool for decisions that must not be delegated to the user.",
		],
		parameters: QuestionParamsSchema,
		executionMode: "sequential",
		async execute(
			_toolCallId: string,
			params: QuestionParams,
			_signal: AbortSignal | undefined,
			_onUpdate: undefined,
			ctx,
		): Promise<QuestionnaireToolResult> {
			const error = validateQuestionnaire(params);
			if (error) return invalidQuestionnaireResult(error);
			if (ctx.mode !== "tui") return unavailableResult();

			let selection: QuestionnaireResult | undefined;
			try {
				pi.events.emit(ASK_USER_QUESTION_BLOCKED_EVENT, { active: true });
				selection = await ctx.ui.custom<QuestionnaireResult>((tui, theme, keybindings, done) => {
					const view = new QuestionnaireView({
						questions: params.questions,
						theme,
						keybindings,
						onComplete: (result) => done(result),
					});
					// Native dock swap, never an overlay: the transcript stays scrollable
					// while the questionnaire owns focus. No `overlay` option is passed.
					const container = createNativeFullscreenInteraction({
						keyboardTarget: view,
						requestRender: () => tui.requestRender(),
					});
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					container.addChild(view);
					container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
					return container;
				});
			}
			finally {
				pi.events.emit(ASK_USER_QUESTION_BLOCKED_EVENT, { active: false });
			}

			if (selection === undefined || selection.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: { cancelled: true },
				};
			}
			return {
				content: [{ type: "text", text: answersText(selection.answers) }],
				details: { answers: selection.answers },
			};
		},
		renderCall(args: QuestionParams, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const summary = truncate(questions.map((question, index) => callSummary(question, index)).join(" "), CALL_SUMMARY_LIMIT);
			return new Text(
				theme.fg("toolTitle", theme.bold("ask_user_question ")) +
				theme.fg("muted", summary),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as QuestionnaireDetails | undefined;
			if (details?.cancelled === true) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const answers = Array.isArray(details?.answers) ? details.answers : [];
			if (answers.length === 0) return new Text(theme.fg("warning", "No answers"), 0, 0);
			const lines = answers.map((answer) => {
				if (answer.kind === "multi") return theme.fg("success", `✓ ${answer.question} — ${(answer.selected ?? []).join(", ")}`);
				if (answer.kind === "custom") return theme.fg("success", `✓ ${answer.question} — ${answerBody(answer)}`);
				return theme.fg("success", `✓ ${answer.question} — ${answer.answer ?? ""}`);
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
