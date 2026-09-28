import assert from "node:assert/strict";
import test from "node:test";
import askUserQuestion, { askMultiSelect } from "../extensions/ask-user-question.ts";

/** Plain theme fake: identity styling keeps rendered assertions readable. */
interface Theme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
}

const theme: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

interface Renderable {
	render(width: number): string[];
	handleInput?(data: string): void;
}

type CustomFactory = (
	tui: { requestRender(): void },
	theme: Theme,
	keybindings: unknown,
	done: (value: unknown) => void,
) => Renderable;

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
}

interface RegisteredTool {
	name: string;
	label: string;
	description?: string;
	renderShell?: string;
	promptGuidelines?: string[];
	parameters: {
		additionalProperties?: boolean;
		properties?: {
			questions?: {
				minItems?: number;
				maxItems?: number;
				items?: { additionalProperties?: boolean; properties?: Record<string, unknown> };
			};
		};
	};
	executionMode?: string;
	execute(...args: unknown[]): Promise<ToolResult>;
	renderCall(args: unknown, theme: Theme): Renderable;
	renderResult(result: unknown, options: unknown, theme: Theme): Renderable;
}

interface LifecycleEvent {
	channel: string;
	data: { active: boolean };
}

/** One fake extension slot: Pi keys tools per extension by name (`loader.js:240`). */
interface ExtensionSlot {
	path: string;
	tools: Map<string, RegisteredTool>;
}

const OURS_PATH = "gentle-pi/extensions/ask-user-question.ts";

function registerQuestionTool(slot?: ExtensionSlot): { tool: RegisteredTool; slot: ExtensionSlot; emitted: LifecycleEvent[] } {
	const target: ExtensionSlot = slot ?? { path: OURS_PATH, tools: new Map() };
	const emitted: LifecycleEvent[] = [];
	const pi = {
		registerTool(tool: RegisteredTool) {
			target.tools.set(tool.name, tool);
		},
		events: {
			emit(channel: string, data: { active: boolean }) {
				emitted.push({ channel, data });
			},
		},
	};
	askUserQuestion(pi as never);
	const tool = target.tools.get("ask_user_question");
	if (!tool) throw new Error("ask_user_question must register");
	return { tool, slot: target, emitted };
}

function tuiContext(inputs: readonly string[], rendered?: { value: string }) {
	return {
		mode: "tui",
		ui: {
			custom: async (factory: CustomFactory) => {
				let result: unknown;
				const component = factory({ requestRender() {} }, theme, {}, (value) => {
					result = value;
				});
				if (rendered) rendered.value = component.render(100).join("\n");
				for (const input of inputs) component.handleInput?.(input);
				return result;
			},
		},
	};
}

function run(tool: RegisteredTool, params: unknown, ctx: unknown): Promise<ToolResult> {
	return tool.execute("call", params, new AbortController().signal, undefined, ctx);
}

const INTERACTIVE_HOST_ENV = "GENTLE_SHELL_INTERACTIVE_HOST";

/** Fake interactive-RPC-host ctx: scripted `select` answers, one per call. */
function rpcHostContext(selectAnswers: readonly (string | undefined)[]) {
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	let index = 0;
	return {
		ctx: {
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async (title: string, options: string[]) => {
					selectCalls.push({ title, options });
					const answer = selectAnswers[index];
					index += 1;
					return answer;
				},
			},
		},
		selectCalls,
	};
}

function withInteractiveHostEnv(t: { after(fn: () => void): void }): void {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
}

const option = (label: string, description = `${label} description`, preview?: string) =>
	preview === undefined ? { label, description } : { label, description, preview };

const single = () => [
	{ question: "Proceed?", header: "Proceed", options: [option("Alpha"), option("Beta")] },
];

test("ask_user_question opts out of the painted shell and pins the schema limits", () => {
	const { tool } = registerQuestionTool();
	const questions = tool.parameters.properties?.questions;

	assert.equal(tool.renderShell, "self");
	assert.equal(tool.name, "ask_user_question");
	assert.equal(tool.label, "Ask User Question");
	assert.equal(tool.executionMode, "sequential");
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(questions?.minItems, 1);
	assert.equal(questions?.maxItems, 4);
	assert.equal(questions?.items?.additionalProperties, false);
	assert.deepEqual(Object.keys(questions?.items?.properties ?? {}).sort(), ["header", "multiSelect", "options", "question"]);
});

test("ask_user_question guides the model toward the supported contract", () => {
	const { tool } = registerQuestionTool();
	const guidelines = (tool.promptGuidelines ?? []).join(" ");

	assert.match(tool.description ?? "", /one to four structured questions/i);
	assert.match(guidelines, /at most 16 characters/);
	assert.match(guidelines, /at most 60 characters/);
	assert.match(guidelines, /preview/);
	assert.match(guidelines, /multiSelect/);
	assert.match(guidelines, /Type something\./);
	assert.match(guidelines, /Never use this tool for decisions that must not be delegated to the user\./);
});

test("ask_user_question rejects invalid parameters before mounting any UI", async () => {
	const { tool, emitted } = registerQuestionTool();
	let customCalls = 0;
	const ctx = {
		mode: "tui",
		ui: {
			custom: async () => {
				customCalls++;
				return undefined;
			},
		},
	};

	const result = await run(tool, { questions: [] }, ctx);

	assert.equal(result.content[0]?.text, "Invalid questionnaire: At least one question is required.");
	assert.equal(result.details.errorKind, "no_questions");
	assert.deepEqual(result.details.error, { code: "no_questions", message: "At least one question is required." });
	assert.equal(customCalls, 0, "invalid input never reaches ctx.ui.custom");
	assert.deepEqual(emitted, [], "invalid input emits no lifecycle event");
});

test("ask_user_question stays unavailable outside the interactive TUI", async () => {
	const { tool, emitted } = registerQuestionTool();
	let customCalls = 0;
	const ctx = {
		mode: "print",
		ui: {
			custom: async () => {
				customCalls++;
				return undefined;
			},
		},
	};

	const result = await run(tool, { questions: single() }, ctx);

	assert.match(result.content[0]?.text ?? "", /unavailable outside the interactive TUI/);
	assert.equal(result.details.errorKind, "unavailable_outside_tui");
	assert.equal(customCalls, 0);
	assert.deepEqual(emitted, []);
});

test("ask_user_question stays unavailable on a plain rpc host without the interactive-host variable", async (t) => {
	const { tool, emitted } = registerQuestionTool();
	let selectCalls = 0;
	const ctx = {
		mode: "rpc",
		hasUI: true,
		ui: { select: async () => { selectCalls++; return undefined; } },
	};
	t.after(() => { delete process.env[INTERACTIVE_HOST_ENV]; });
	delete process.env[INTERACTIVE_HOST_ENV];

	const result = await run(tool, { questions: single() }, ctx);

	assert.match(result.content[0]?.text ?? "", /unavailable outside the interactive TUI/);
	assert.equal(result.details.errorKind, "unavailable_outside_tui");
	assert.equal(selectCalls, 0);
	assert.deepEqual(emitted, []);
});

test("ask_user_question resolves a single-select answer through RPC dialogs on an interactive host", async (t) => {
	withInteractiveHostEnv(t);
	const { tool, emitted } = registerQuestionTool();
	const { ctx, selectCalls } = rpcHostContext(["Alpha"]);

	const result = await run(tool, { questions: single() }, ctx);

	assert.equal(selectCalls.length, 1);
	assert.equal(selectCalls[0]?.title, "Proceed: Proceed?");
	assert.deepEqual(selectCalls[0]?.options, ["Alpha", "Beta"]);
	assert.equal(result.content[0]?.text, "1. Proceed? — Alpha");
	assert.deepEqual(result.details.answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Alpha" },
	]);
	assert.deepEqual(emitted, [
		{ channel: "gentle-pi:ask-user-question:blocked", data: { active: true } },
		{ channel: "gentle-pi:ask-user-question:blocked", data: { active: false } },
	]);
});

test("ask_user_question echoes an option preview through RPC dialogs", async (t) => {
	withInteractiveHostEnv(t);
	const { tool } = registerQuestionTool();
	const questions = [
		{ question: "Proceed?", header: "Proceed", options: [option("Alpha", "First choice", "Preview A"), option("Beta")] },
	];
	const { ctx } = rpcHostContext(["Alpha"]);

	const result = await run(tool, { questions }, ctx);

	assert.equal(result.content[0]?.text, "1. Proceed? — Alpha\n   selected preview: Preview A");
	assert.deepEqual(result.details.answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Alpha", preview: "Preview A" },
	]);
});

test("ask_user_question loops select with a trailing Done entry for a multiSelect question on an interactive host", async (t) => {
	withInteractiveHostEnv(t);
	const { tool } = registerQuestionTool();
	const questions = [
		{ question: "Pick?", header: "Pick", options: [option("One"), option("Two")], multiSelect: true },
	];
	const { ctx, selectCalls } = rpcHostContext(["[ ] One", "Done"]);

	const result = await run(tool, { questions }, ctx);

	assert.deepEqual(selectCalls[0]?.options, ["[ ] One", "[ ] Two", "Done"]);
	assert.deepEqual(selectCalls[1]?.options, ["[x] One", "[ ] Two", "Done"]);
	assert.equal(result.content[0]?.text, "1. Pick? — selected: One");
	assert.deepEqual(result.details.answers, [
		{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: ["One"] },
	]);
});

test("ask_user_question multiSelect finishes once every option is toggled without needing Done", async (t) => {
	withInteractiveHostEnv(t);
	const { tool } = registerQuestionTool();
	const questions = [
		{ question: "Pick?", header: "Pick", options: [option("One"), option("Two")], multiSelect: true },
	];
	const { ctx, selectCalls } = rpcHostContext(["[ ] One", "[ ] Two"]);

	const result = await run(tool, { questions }, ctx);

	assert.equal(selectCalls.length, 2, "bounded by the safety cap, but finished early once fully toggled");
	assert.deepEqual(result.details.answers, [
		{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: ["One", "Two"] },
	]);
});

test("ask_user_question multiSelect toggle/untoggle/toggle sequence still selects correctly after Done", async (t) => {
	withInteractiveHostEnv(t);
	const { tool } = registerQuestionTool();
	const questions = [
		{ question: "Pick?", header: "Pick", options: [option("One"), option("Two")], multiSelect: true },
	];
	// Toggle One on, then off, then on again, then explicit Done: four rounds,
	// one more than the old options.length + 1 = 3 round bound, so an
	// un-toggle must never count against the loop's budget.
	const { ctx, selectCalls } = rpcHostContext(["[ ] One", "[x] One", "[ ] One", "Done"]);

	const result = await run(tool, { questions }, ctx);

	assert.equal(selectCalls.length, 4);
	assert.deepEqual(result.details.answers, [
		{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: ["One"] },
	]);
});

test("ask_user_question multiSelect cancels once the safety cap is hit without Done", async (t) => {
	withInteractiveHostEnv(t);
	const { tool } = registerQuestionTool();
	const questions = [
		{ question: "Pick?", header: "Pick", options: [option("One"), option("Two")], multiSelect: true },
	];
	// Toggle only "One" back and forth forever: "Two" never toggles, so the
	// loop never auto-finishes, and Done is never picked. It must hit the
	// hard safety cap and refuse to commit whatever was toggled at that point.
	const selectAnswers = Array.from({ length: 32 }, (_, round) => (round % 2 === 0 ? "[ ] One" : "[x] One"));
	const { ctx, selectCalls } = rpcHostContext(selectAnswers);

	const result = await run(tool, { questions }, ctx);

	assert.equal(selectCalls.length, 32, "every round of the safety cap must be spent before giving up");
	assert.equal(result.content[0]?.text, "User cancelled the questionnaire");
	assert.deepEqual(result.details, { cancelled: true });
});

test("askMultiSelect scales its round cap so a 40-option question can toggle every option and still reach Done", async () => {
	// The shipped `ask_user_question` tool schema caps authored options at 4
	// (`lib/questionnaire/schema.ts`'s `MAX_OPTIONS`), so this exercises
	// `askMultiSelect` directly rather than through the schema-validated tool,
	// the same way a future caller with more options would.
	const labels = Array.from({ length: 40 }, (_, index) => `Option ${index + 1}`);
	const question = { question: "Pick?", header: "Pick", options: labels.map((label) => option(label)), multiSelect: true };
	// Toggle the first 39 options on, one per round, then an explicit Done:
	// 40 rounds total, past the old flat 32-round cap but inside the new
	// `Math.max(32, options.length + 2)` = 42 bound.
	const toggleAnswers = labels.slice(0, 39).map((label) => `[ ] ${label}`);
	const { ctx, selectCalls } = rpcHostContext([...toggleAnswers, "Done"]);

	const answer = await askMultiSelect(ctx as never, question as never);

	assert.equal(selectCalls.length, 40, "every toggle plus the explicit Done fits inside the scaled cap");
	assert.deepEqual(answer, { questionIndex: -1, question: "Pick?", kind: "multi", answer: null, selected: labels.slice(0, 39) });
});

test("ask_user_question multiSelect cancels on an unrecognised host answer instead of committing a partial state", async (t) => {
	withInteractiveHostEnv(t);
	const { tool } = registerQuestionTool();
	const questions = [
		{ question: "Pick?", header: "Pick", options: [option("One"), option("Two")], multiSelect: true },
	];
	// "One" gets toggled on first, then the host answers with something that
	// matches none of the current round's options: the loop must cancel the
	// whole questionnaire, never commit the partial "One" toggle.
	const { ctx, selectCalls } = rpcHostContext(["[ ] One", "not a real option"]);

	const result = await run(tool, { questions }, ctx);

	assert.equal(selectCalls.length, 2);
	assert.equal(result.content[0]?.text, "User cancelled the questionnaire");
	assert.deepEqual(result.details, { cancelled: true });
});

test("ask_user_question cancels through RPC dialogs like the TUI path when select returns undefined", async (t) => {
	withInteractiveHostEnv(t);
	const { tool, emitted } = registerQuestionTool();
	const { ctx } = rpcHostContext([undefined]);

	const result = await run(tool, { questions: single() }, ctx);

	assert.equal(result.content[0]?.text, "User cancelled the questionnaire");
	assert.deepEqual(result.details, { cancelled: true });
	assert.deepEqual(emitted, [
		{ channel: "gentle-pi:ask-user-question:blocked", data: { active: true } },
		{ channel: "gentle-pi:ask-user-question:blocked", data: { active: false } },
	]);
});

test("ask_user_question cancels a questionnaire through RPC dialogs on a later question", async (t) => {
	withInteractiveHostEnv(t);
	const { tool } = registerQuestionTool();
	const questions = [
		{ question: "First?", header: "First", options: [option("Alpha"), option("Beta")] },
		{ question: "Second?", header: "Second", options: [option("Gamma"), option("Delta")] },
	];
	const { ctx, selectCalls } = rpcHostContext(["Alpha", undefined]);

	const result = await run(tool, { questions }, ctx);

	assert.equal(selectCalls.length, 2, "the first question is answered before the cancel is observed");
	assert.deepEqual(result.details, { cancelled: true });
});

test("ask_user_question commits a single-select answer end-to-end", async () => {
	const { tool, emitted } = registerQuestionTool();
	const rendered = { value: "" };

	const result = await run(tool, { questions: single() }, tuiContext(["\r"], rendered));

	assert.match(rendered.value, /\[1\/1\]/);
	assert.match(rendered.value, /▸ Proceed/);
	assert.match(rendered.value, /Alpha/);
	assert.equal(result.content[0]?.text, "1. Proceed? — Alpha");
	assert.deepEqual(result.details.answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Alpha" },
	]);
	assert.deepEqual(emitted, [
		{ channel: "gentle-pi:ask-user-question:blocked", data: { active: true } },
		{ channel: "gentle-pi:ask-user-question:blocked", data: { active: false } },
	]);
});

test("ask_user_question mounts through ctx.ui.custom without an overlay option", async () => {
	const { tool } = registerQuestionTool();
	let customArgCount = -1;
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (...args: unknown[]) => {
				customArgCount = args.length;
				const factory = args[0] as CustomFactory;
				let result: unknown;
				const component = factory({ requestRender() {} }, theme, {}, (value) => {
					result = value;
				});
				component.handleInput?.("\r");
				return result;
			},
		},
	};

	await run(tool, { questions: single() }, ctx);

	assert.equal(customArgCount, 1, "a dock swap passes the factory only; no overlay options");
});

test("ask_user_question mounts exactly one active question and switches with Tab", async () => {
	const { tool } = registerQuestionTool();
	const questions = [
		{ question: "First?", header: "First", options: [option("Alpha"), option("Beta")] },
		{ question: "Second?", header: "Second", options: [option("Gamma"), option("Delta")] },
	];
	let component: Renderable | undefined;
	const pending = run(tool, { questions }, {
		mode: "tui",
		ui: {
			custom: (factory: CustomFactory) => new Promise((resolve) => {
				component = factory({ requestRender() {} }, theme, {}, resolve);
			}),
		},
	});

	assert.ok(component, "the tool mounts the questionnaire component");
	const first = component!.render(100).join("\n");
	assert.match(first, /\[1\/2\]/);
	assert.match(first, /▸ First/);
	assert.match(first, /❯ Alpha/);
	assert.doesNotMatch(first, /Gamma/);
	assert.doesNotMatch(first, /Second\?/);

	component!.handleInput?.("\t");
	const second = component!.render(100).join("\n");
	assert.match(second, /\[2\/2\]/);
	assert.match(second, /▸ Second/);
	assert.match(second, /❯ Gamma/);
	assert.doesNotMatch(second, /First\?/);

	component!.handleInput?.("\x1b"); // cancel to settle the tool
	await pending;
});

test("ask_user_question echoes an option preview beside the answer", async () => {
	const { tool } = registerQuestionTool();
	const questions = [
		{ question: "Proceed?", header: "Proceed", options: [option("Alpha", "First choice", "Preview A"), option("Beta")] },
	];

	const result = await run(tool, { questions }, tuiContext(["\r"]));

	assert.equal(result.content[0]?.text, "1. Proceed? — Alpha\n   selected preview: Preview A");
	assert.deepEqual(result.details.answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Alpha", preview: "Preview A" },
	]);
});

test("ask_user_question commits a multiSelect answer with every toggled option", async () => {
	const { tool } = registerQuestionTool();
	const questions = [
		{ question: "Pick?", header: "Pick", options: [option("One"), option("Two")], multiSelect: true },
	];

	const result = await run(tool, { questions }, tuiContext([" ", "\r"]));

	assert.equal(result.content[0]?.text, "1. Pick? — selected: One");
	assert.deepEqual(result.details.answers, [
		{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: ["One"] },
	]);
});

test("ask_user_question commits a free-text custom answer", async () => {
	const { tool } = registerQuestionTool();

	const result = await run(
		tool,
		{ questions: single() },
		tuiContext(["\x1b[B", "\x1b[B", "\r", "custom text", "\r"]),
	);

	assert.equal(result.content[0]?.text, "1. Proceed? — (custom) custom text");
	assert.deepEqual(result.details.answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "custom", answer: "custom text" },
	]);
});

test("ask_user_question keeps toggled options in a multiSelect custom answer", async () => {
	const { tool } = registerQuestionTool();
	const questions = [
		{ question: "Pick?", header: "Pick", options: [option("One"), option("Two")], multiSelect: true },
	];

	// Toggle One, move to the custom row, open the editor, type, and submit.
	const result = await run(
		tool,
		{ questions },
		tuiContext([" ", "\x1b[B", "\x1b[B", "\r", "free note", "\r"]),
	);

	assert.equal(result.content[0]?.text, "1. Pick? — (custom) free note — selected: One");
	assert.deepEqual(result.details.answers, [
		{ questionIndex: 0, question: "Pick?", kind: "custom", answer: "free note", selected: ["One"] },
	]);

	const rendered = tool.renderResult(result, { expanded: false }, theme).render(200).join("\n");
	assert.equal(rendered.trimEnd(), "✓ Pick? — (custom) free note — selected: One");
});

test("ask_user_question reports cancellation without answers", async () => {
	const { tool, emitted } = registerQuestionTool();

	const result = await run(tool, { questions: single() }, tuiContext(["\x1b"]));

	assert.equal(result.content[0]?.text, "User cancelled the questionnaire");
	assert.deepEqual(result.details, { cancelled: true });
	assert.deepEqual(emitted, [
		{ channel: "gentle-pi:ask-user-question:blocked", data: { active: true } },
		{ channel: "gentle-pi:ask-user-question:blocked", data: { active: false } },
	]);
});

test("ask_user_question settles its lifecycle after a custom UI error", async () => {
	const { tool, emitted } = registerQuestionTool();
	const failure = new Error("custom UI failed");

	await assert.rejects(
		() => run(tool, { questions: single() }, { mode: "tui", ui: { custom: async () => { throw failure; } } }),
		(error: unknown) => error === failure,
	);

	assert.deepEqual(emitted, [
		{ channel: "gentle-pi:ask-user-question:blocked", data: { active: true } },
		{ channel: "gentle-pi:ask-user-question:blocked", data: { active: false } },
	]);
});

test("ask_user_question owns an exclusive tool name across extensions", () => {
	// Live-verified against the installed Pi runtime: tool names are exclusive
	// across extensions. Loading two extensions that register
	// `ask_user_question` aborts the whole load with a hard error
	// (`Tool "ask_user_question" conflicts with <other extension>`; the runtime
	// exits non-zero) -- there is no precedence, override, or silent shadowing.
	// This fake registry is a per-extension Map and cannot reproduce Pi's
	// cross-extension load error, so it pins the part it can: our single
	// registration owns the name within its own extension, and the runtime, not
	// resource order, enforces exclusivity outside it. The competing
	// `@juicesharp/rpiv-ask-user-question` package must be removed from the
	// user's settings before this extension can load.
	const ours: ExtensionSlot = { path: OURS_PATH, tools: new Map() };
	const registration = registerQuestionTool(ours);

	assert.equal(ours.tools.get("ask_user_question"), registration.tool, "the first-party extension owns its name");
	assert.equal(registration.tool.name, "ask_user_question");
	assert.equal(registration.tool.label, "Ask User Question");
});

test("re-registering inside one extension overwrites its own tool entry", () => {
	const slot: ExtensionSlot = { path: OURS_PATH, tools: new Map() };
	registerQuestionTool(slot);
	const first = slot.tools.get("ask_user_question");
	registerQuestionTool(slot);
	const second = slot.tools.get("ask_user_question");

	assert.equal(slot.tools.size, 1, "the extension map is keyed by tool name");
	assert.notEqual(first, second, "a later registration replaces the same-name entry");
});

test("ask_user_question renderCall summarizes the questions and option labels", () => {
	const { tool } = registerQuestionTool();
	const rendered = tool.renderCall({ questions: single() }, theme).render(100).join("\n");

	assert.match(rendered, /ask_user_question/);
	assert.match(rendered, /1\. Proceed \(Alpha, Beta\)/);
});

test("ask_user_question renderCall truncates an oversized summary", () => {
	const { tool } = registerQuestionTool();
	const labels = [option("a".repeat(60)), option("b".repeat(60)), option("c".repeat(60))];
	const rendered = tool.renderCall(
		{ questions: [{ question: "Long?", header: "Long", options: labels }] },
		theme,
	).render(200).join("\n");

	assert.match(rendered, /…\s*$/);
});

test("ask_user_question renderResult renders answered and cancelled rows", () => {
	const { tool } = registerQuestionTool();
	const answered = tool.renderResult(
		{
			content: [],
			details: {
				answers: [
					{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Beta" },
					{ questionIndex: 1, question: "Pick?", kind: "multi", answer: null, selected: ["One", "Two"] },
					{ questionIndex: 2, question: "Explain?", kind: "custom", answer: "because" },
				],
			},
		},
		{ expanded: false },
		theme,
	).render(200).join("\n");
	assert.match(answered, /✓ Proceed\? — Beta/);
	assert.match(answered, /✓ Pick\? — One, Two/);
	assert.match(answered, /✓ Explain\? — \(custom\) because/);

	const cancelled = tool.renderResult(
		{ content: [], details: { cancelled: true } },
		{ expanded: false },
		theme,
	).render(200).join("\n");
	assert.match(cancelled, /Cancelled/);
});
