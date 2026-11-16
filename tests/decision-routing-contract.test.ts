import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// ---------------------------------------------------------------------------
// harness-continuity S4 (T3): decision routing in Pi's own surfaces.
//
// The canonical route lives once in the mirrored routing/pi.md ODD step 3
// (no genuine human decision continues the authorized work, a remaining
// representable decision asks through the available compatible tool, text
// is the restricted fallback for a genuinely open clarification or no usable
// compatible interface, independent ordinary decisions batch when the interface
// supports it, and provider-owned consent keeps its closed lossless protocol so
// text is never its approval). Pi adds only what is Pi's own: the tool metadata
// that makes the available interface selectable in both workflow modes, the
// condensed core Ask row that defers to step 3, and the lazy interface shapes.
// These are contract checks through public registration and the rendered
// prompt, not model-adherence proof.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");
const ASSETS = join(REPO_ROOT, "assets");
const MODES = ["organic", "full-delegation"] as const;
const ACTIVE_TOOLS = ["read", "bash", "edit", "write", "subagent_run"] as const;
const INTERACTIVE_HOST_ENV = "GENTLE_SHELL_INTERACTIVE_HOST";

// Isolate config/home state before the extensions that read it are imported.
const scratch = mkdtempSync(join(tmpdir(), "decision-routing-"));
const project = join(scratch, "project");
process.env.GENTLE_PI_CONFIG_HOME = join(scratch, "config");
const previousInteractiveHost = process.env[INTERACTIVE_HOST_ENV];
const { default: askUserChoice } = await import("../extensions/ask-user-choice.ts");
const { default: askUserQuestion } = await import("../extensions/ask-user-question.ts");
const { __testing } = await import("../extensions/gentle-ai.ts");

after(() => {
	if (previousInteractiveHost === undefined) delete process.env[INTERACTIVE_HOST_ENV];
	else process.env[INTERACTIVE_HOST_ENV] = previousInteractiveHost;
	rmSync(scratch, { recursive: true, force: true });
});

// --- Change 1: the canonical step 3 route reaches both workflow modes ------

const CANONICAL_ROUTE = [
	"Continue when no human decision remains",
	"ask with the available compatible tool",
	"text only for a genuinely open clarification or no usable compatible interface",
	"batch independent ordinary decisions when the interface supports it",
	"Provider consent keeps its closed lossless protocol; text is never its approval",
] as const;

function render(mode: (typeof MODES)[number]): string {
	return __testing.buildGentlePrompt("gentleman", project, ACTIVE_TOOLS, undefined, undefined, mode).replaceAll(ASSETS, "/a");
}

test("S4: the rendered primary prompt carries the canonical decision route in both modes", () => {
	for (const mode of MODES) {
		const prompt = render(mode);
		for (const clause of CANONICAL_ROUTE) assert.ok(prompt.includes(clause), `[${mode}] canonical S4 route is missing: ${clause}`);
		assert.ok(!prompt.includes("ask one focused user question only for a real unresolved product decision"), `[${mode}] the retired text-only ask rule is still rendered`);
	}
});

test("S4: the rendered Ask row in both workflow modes defers to ODD step 3 and keeps its stop-and-wait", () => {
	for (const mode of MODES) {
		const row = render(mode).split("\n").find((line) => line.startsWith("1. **Ask** —"));
		assert.ok(row, `[${mode}] the prompt carries its condensed Ask row`);
		assert.ok(row.includes("open product or design decision"), `[${mode}] the Ask row keeps naming the human decision`);
		assert.ok(row.includes("ODD step 3"), `[${mode}] the Ask row defers the route to the canonical step 3`);
		assert.ok(!row.includes("one focused question"), `[${mode}] the Ask row no longer implies that every decision is a text question`);
		assert.match(row, /stop and wait\.$/, `[${mode}] the Ask row keeps its stop-and-wait`);
	}
});

test("S4: the condensed always-on Ask rows defer to ODD step 3 instead of restating a text-only question", () => {
	for (const name of ["orchestrator.md", "orchestrator-full-delegation.md"]) {
		const row = readFileSync(join(ASSETS, name), "utf8").split("\n").find((line) => line.startsWith("1. **Ask** —"));
		assert.ok(row, `${name} keeps its condensed Ask row`);
		assert.ok(row.includes("open product or design decision"), `${name} keeps naming the human decision`);
		assert.ok(row.includes("ODD step 3"), `${name} defers the route to the canonical step 3`);
		assert.ok(!row.includes("one focused question"), `${name} no longer implies that every decision is a text question`);
		assert.ok(row.endsWith("stop and wait."), `${name} keeps its stop-and-wait`);
	}
});

test("S4: the lazy Ask trigger defers to ODD step 3 and keeps its stop-and-wait", () => {
	const row = readFileSync(join(ASSETS, "orchestrator-delegation.md"), "utf8").split("\n").find((line) => line.startsWith("1. **Ask:**"));
	assert.ok(row, "the lazy delegation card keeps its Ask trigger");
	assert.ok(row.includes("open product or design decision"), "the lazy trigger keeps naming the human decision");
	assert.ok(row.includes("ODD step 3"), "the lazy trigger defers the route to the canonical step 3");
	assert.ok(!row.includes("one focused user question"), "the lazy trigger no longer asks a text question for every decision");
	assert.ok(row.endsWith("stop and wait."), "the lazy trigger keeps its stop-and-wait");
});

test("S4: the lazy prompt port points at Pi's ask interfaces and keeps the closed provider contract", () => {
	const lazy = readFileSync(join(ASSETS, "orchestrator-prompts.md"), "utf8");
	assert.ok(lazy.includes("a decision needing Pi's ask interfaces"), "the lazy port is loaded for a decision that needs an ask interface");
	// The provider-owned envelope contract is untouched: exact opaque values,
	// lossless ordering and no partial relay, and an explicit closed flag:
	// ask_user_choice now offers free text by default, so every relayed closed
	// envelope must pass allowCustomResponse: false.
	for (const clause of [
		"Preserve the user-facing envelope",
		"Never summarize, abbreviate, reorder, relabel, merge, or omit choices",
		"Never silently split an atomic business choice across multiple interactions",
		"Pass each closed-envelope option's user-facing label and description plus its envelope-owned canonical option token as opaque `value`",
		"never for a closed domain",
		"pass `allowCustomResponse: false` for every such envelope, including provider-owned consent prompts, maintenance authorizations, and any exact opaque-token decision",
	]) assert.ok(lazy.includes(clause), `the lazy provider contract lost: ${clause}`);
	assert.ok(!lazy.includes("closed by default"), "the lazy port must not claim ask_user_choice is closed by default");
});

test("S4: the Pi ODD reference documents the routed decision instead of a text-only question", () => {
	const reference = readFileSync(join(REPO_ROOT, "docs", "readme-reference.md"), "utf8");
	for (const clause of [
		"continue when no human decision remains",
		"the available compatible tool that represents it asks",
		"text only for a genuinely open clarification or no usable compatible interface",
		"Independent ordinary decisions batch when the interface supports it",
		"provider consent keeps its closed lossless protocol and text is never its approval",
	]) assert.ok(reference.includes(clause), `the ODD reference is missing the routed decision: ${clause}`);
	assert.ok(!reference.includes("optional research or one focused product question only for a real unresolved decision"), "the ODD reference keeps the retired text-only summary");
	assert.ok(!reference.includes("The parent asks one focused product question only when needed"), "the research bullet keeps the retired text-only ask");
});

// --- Change 2: the available interface is selectable in both modes ---------

interface Declaration {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	executionMode?: string;
	execute(...args: unknown[]): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

function register(extension: (pi: never) => void): Declaration {
	let tool: Declaration | undefined;
	const pi = {
		registerTool(candidate: Declaration) {
			tool = candidate;
		},
		on() {},
		events: { on() {}, emit() {} },
	};
	extension(pi as never);
	assert.ok(tool, "the extension must register its tool");
	return tool;
}

const TOOLS = {
	ask_user_choice: () => register(askUserChoice),
	ask_user_question: () => register(askUserQuestion),
} as const;

const SNIPPET_SHAPE = {
	ask_user_choice: /one single-select question.*2-4.*Type your answer/i,
	ask_user_question: /one to four structured questions.*one call/i,
} as const;

test("S4: both ask tools publish a one-line snippet so the model can select them in either mode", () => {
	for (const name of Object.keys(TOOLS) as Array<keyof typeof TOOLS>) {
		const tool = TOOLS[name]();
		assert.equal(tool.executionMode, "sequential", `${name} stays sequential`);
		assert.ok(tool.promptSnippet, `${name} must publish a promptSnippet to appear in the tools section`);
		assert.ok(tool.promptSnippet.length > 0, `${name} promptSnippet is empty`);
		assert.ok(!tool.promptSnippet.includes("\n"), `${name} promptSnippet must be one line`);
		assert.match(tool.promptSnippet, SNIPPET_SHAPE[name], `${name} promptSnippet must name its shape`);
	}
});

const ROUTING_GUIDELINES = [
	/only when a genuine human decision remains/i,
	/when no genuine human decision remains,? execute the authorized work/i,
] as const;

test("S4: both tools route a real decision to themselves and forbid asking when none remains", () => {
	for (const name of Object.keys(TOOLS) as Array<keyof typeof TOOLS>) {
		const guidelines = (TOOLS[name]().promptGuidelines ?? []).join(" ");
		assert.ok(guidelines.length > 0, `${name} publishes promptGuidelines`);
		for (const pattern of ROUTING_GUIDELINES) assert.match(guidelines, pattern, `${name} guidelines are missing the decision route`);
		assert.match(guidelines, /When .* is available for a genuine human decision it represents, use it instead of asking in text\./, `${name} guidelines must rank the available tool over text`);
		assert.match(guidelines, new RegExp(`a technical decision the agent owns never becomes an ${name} call`), `${name} guidelines must keep technical decisions with the agent`);
	}
});

test("S4: the questionnaire batches independent ordinary decisions and never takes provider consent", () => {
	const guidelines = (TOOLS.ask_user_question().promptGuidelines ?? []).join(" ");
	assert.match(guidelines, /[Bb]atch independent ordinary decisions as separate questions in one ask_user_question call/);
	assert.match(guidelines, /Consent, maintenance authorizations and exact-token decisions use ask_user_choice, never this tool\./);
	assert.match(guidelines, /Ordinary contextual approval of an action the human already understands needs no ask_user_question call and stays valid as text/);
});

test("S4: the ordinary text approval stays valid and the prohibition is scoped to provider consent, never universal", () => {
	for (const name of Object.keys(TOOLS) as Array<keyof typeof TOOLS>) {
		const guidelines = (TOOLS[name]().promptGuidelines ?? []).join(" ");
		assert.match(guidelines, /Ordinary contextual approval .* stays valid as text/, `${name} must not negate ordinary text approval`);
		assert.match(guidelines, /provider-owned consent/, `${name} prohibition must name the consent owner`);
		assert.doesNotMatch(guidelines, /text is never (?:an )?approval/i, `${name} must not state a universal text-approval ban`);
		assert.doesNotMatch(guidelines, /never approve|approval is always invalid/i, `${name} must not negate contextual approval`);
	}
});

test("S4: the choice offers its own-answer entry by default and consent relays must close it explicitly", () => {
	const guidelines = (TOOLS.ask_user_choice().promptGuidelines ?? []).join(" ");
	assert.match(guidelines, /Pass allowCustomResponse: false to ask_user_choice for provider-owned consent prompts, maintenance authorizations, or any decision that requires an exact opaque token\./);
	assert.match(guidelines, /ask_user_choice shows a "Type your answer" free-text entry by default/);
	assert.match(guidelines, /ask_user_choice is never a text fallback: text is the route only for a genuinely open clarification or no usable compatible interface/);
	assert.match(guidelines, /Ordinary contextual approval of an action the human already understands needs no ask_user_choice call and stays valid as text/);
});

// --- Retained independent-verifier PRESERVE probe (T3/S4) ------------------
// The digest pins only the JSON-facing declaration surface: every field other
// than promptSnippet/promptGuidelines, serialized as JSON with each function
// replaced by the string "[fn]". It therefore protects name, label,
// renderShell, description, parameters/schema, executionMode and the presence
// of the render/execute functions, and it does NOT detect a change inside any
// function body. Handler and execute behavior is established by the execute
// tests below and the untouched ask-tool suites, never by this digest alone.
// ask_user_choice re-pinned (was e34ac3c1…e113e55) when its description and
// allowCustomResponse/options schema descriptions moved to the opt-out
// "Type your answer" free-text default; the schema shape is unchanged.
const DECLARATION_DIGESTS = {
	ask_user_choice: "ceab2f357cf7b4d6dd769dcd9592b6859be3277f141c20078a402d6ddaeebcba",
	ask_user_question: "3252d437f1da7cc2836dfc061c1dd9a70c018837c2b481b0be1fee5c5e76eb22",
} as const;

function declarationDigest(tool: Declaration): string {
	const { promptSnippet: _promptSnippet, promptGuidelines: _promptGuidelines, ...rest } = tool;
	const serialized = JSON.stringify(rest, (_key, value: unknown) => (typeof value === "function" ? "[fn]" : value));
	return createHash("sha256").update(serialized, "utf8").digest("hex");
}

test("PRESERVE (independent verifier): the public ask declarations keep their JSON-facing shape and schema", () => {
	for (const name of Object.keys(TOOLS) as Array<keyof typeof TOOLS>) {
		assert.equal(
			declarationDigest(TOOLS[name]()),
			DECLARATION_DIGESTS[name],
			`${name} declaration drifted outside promptSnippet/promptGuidelines (function bodies are not covered by this digest)`,
		);
	}
});

// promptGuidelines are flattened into one global rules list with no tool-name
// prefix, so a routed guideline that omits its own tool name would read as a
// rule for every tool. Each guideline this probe matches must name its owner.
const SCOPED_GUIDELINE = /genuine human decision remains|instead of asking in text|never a text fallback|Ordinary contextual approval|Batch independent ordinary decisions/;

test("PRESERVE (independent verifier): every routed guideline names its own tool so flattening keeps its scope", () => {
	for (const name of Object.keys(TOOLS) as Array<keyof typeof TOOLS>) {
		const routed = (TOOLS[name]().promptGuidelines ?? []).filter((guideline) => SCOPED_GUIDELINE.test(guideline));
		assert.ok(routed.length > 0, `${name} keeps the routed guidelines this probe covers`);
		for (const guideline of routed) assert.ok(guideline.includes(name), `${name} guideline loses its scope when flattened: ${guideline}`);
	}
});

// --- Change 3: synthetic execution keeps the exact public behavior ---------

const CHOICE_OPTIONS = [
	{ label: "Authorize observed hash", description: "Accept the baseline hash observed in this runtime.", value: "authorize_observed_hash" },
	{ label: "Preserve requested hash", description: "Keep the hash from the original request.", value: "preserve_requested_hash" },
] as const;

interface SelectCall {
	title: string;
	options: string[];
}

function rpcContext(selectAnswers: readonly (string | undefined)[], inputAnswers: readonly (string | undefined)[] = []) {
	const selectCalls: SelectCall[] = [];
	const inputCalls: Array<{ title: string; placeholder?: string }> = [];
	let selectIndex = 0;
	let inputIndex = 0;
	return {
		ctx: {
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async (title: string, options: string[]) => {
					selectCalls.push({ title, options });
					return selectAnswers[selectIndex++];
				},
				input: async (title: string, placeholder?: string) => {
					inputCalls.push({ title, placeholder });
					return inputAnswers[inputIndex++];
				},
			},
		},
		selectCalls,
		inputCalls,
	};
}

function withInteractiveHost(t: { after(fn: () => void): void }): void {
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previousInteractiveHost === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previousInteractiveHost;
	});
}

test("S4: ask_user_choice relays one exact opaque value and its cancellation through the public execute", async (t) => {
	withInteractiveHost(t);
	const tool = TOOLS.ask_user_choice();
	const signal = new AbortController().signal;

	const selected = await tool.execute("call-1", { question: "Authorize?", options: CHOICE_OPTIONS }, signal, undefined, rpcContext(["Preserve requested hash"]).ctx);
	assert.equal(selected.content[0]?.text, "User selected: 2. Preserve requested hash (value: preserve_requested_hash)");
	assert.deepEqual(selected.details.selection, { value: "preserve_requested_hash", label: "Preserve requested hash", index: 2 });

	const cancelled = await tool.execute("call-2", { question: "Authorize?", options: CHOICE_OPTIONS }, signal, undefined, rpcContext([undefined]).ctx);
	assert.equal(cancelled.content[0]?.text, "User cancelled the choice");
	assert.equal(cancelled.details.cancelled, true);

	const closed = rpcContext(["Authorize observed hash"]);
	await tool.execute("call-3", { question: "Authorize?", options: CHOICE_OPTIONS, allowCustomResponse: false }, signal, undefined, closed.ctx);
	assert.deepEqual(closed.selectCalls[0]?.options, CHOICE_OPTIONS.map((option) => option.label), "closed mode offers no free-text entry");

	const ordinary = rpcContext(["Authorize observed hash"]);
	await tool.execute("call-3b", { question: "Authorize?", options: CHOICE_OPTIONS }, signal, undefined, ordinary.ctx);
	assert.deepEqual(ordinary.selectCalls[0]?.options, [...CHOICE_OPTIONS.map((option) => option.label), "Type your answer"], "an ordinary call offers the own-answer entry by default");

	await assert.rejects(
		tool.execute("call-4", { question: "Authorize?", options: CHOICE_OPTIONS }, signal, undefined, { mode: "print", ui: {} }),
		/ask_user_choice is unavailable outside the interactive TUI/,
	);
});

test("S4: default custom text never becomes an opaque-token answer", async (t) => {
	withInteractiveHost(t);
	const tool = TOOLS.ask_user_choice();
	const result = await tool.execute(
		"call-1",
		{ question: "Describe the constraint", options: CHOICE_OPTIONS },
		new AbortController().signal,
		undefined,
		rpcContext(["Type your answer"], ["free text"]).ctx,
	);
	assert.equal(result.content[0]?.text, "User responded: free text");
	assert.deepEqual(result.details.customResponse, "free text");
	assert.equal(result.details.selection, undefined, "a custom answer is never mapped to an opaque value");
});

test("S4: ask_user_question batches two ordinary decisions in one call and keeps cancellation exact", async (t) => {
	withInteractiveHost(t);
	const tool = TOOLS.ask_user_question();
	const questions = [
		{ question: "Which scope?", header: "Scope", options: [{ label: "One file", description: "Change one file." }, { label: "Two files", description: "Change two files." }] },
		{ question: "Which check?", header: "Check", options: [{ label: "Focused", description: "Run the focused test." }, { label: "Suite", description: "Run the suite." }] },
	];
	const batched = rpcContext(["One file", "Focused"]);
	const answers = await tool.execute("call-1", { questions }, new AbortController().signal, undefined, batched.ctx);
	assert.equal(batched.selectCalls.length, 2, "one execute asks both questions");
	assert.equal(answers.content[0]?.text, "1. Which scope? — One file\n2. Which check? — Focused");
	assert.deepEqual((answers.details.answers as Array<{ answer: string }>).map((answer) => answer.answer), ["One file", "Focused"]);

	const multi = await tool.execute(
		"call-2",
		{ questions: [{ question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "Unit", description: "Unit tests." }, { label: "Lint", description: "Lint." }] }] },
		new AbortController().signal,
		undefined,
		rpcContext(["[ ] Unit", "Done"]).ctx,
	);
	assert.equal(multi.content[0]?.text, "1. Which checks? — selected: Unit");
	assert.deepEqual((multi.details.answers as Array<{ kind: string; selected: string[] }>)[0], { questionIndex: 0, question: "Which checks?", kind: "multi", answer: null, selected: ["Unit"] });

	const cancelled = await tool.execute("call-3", { questions }, new AbortController().signal, undefined, rpcContext(["One file", undefined]).ctx);
	assert.equal(cancelled.content[0]?.text, "User cancelled the questionnaire");
	assert.equal(cancelled.details.cancelled, true);
});

test("S4: invalid questionnaire input is rejected before any UI mount and changes no state", async (t) => {
	withInteractiveHost(t);
	const tool = TOOLS.ask_user_question();
	const rejected = rpcContext([]);
	const result = await tool.execute("call-1", { questions: [] }, new AbortController().signal, undefined, rejected.ctx);
	assert.equal(result.content[0]?.text, "Invalid questionnaire: At least one question is required.");
	assert.deepEqual(result.details.error, { code: "no_questions", message: "At least one question is required." });
	assert.equal(result.details.errorKind, "no_questions");
	assert.deepEqual(rejected.selectCalls, [], "a rejected questionnaire never opens a dialog");
	assert.deepEqual(result.details.answers, undefined, "a rejected questionnaire stores no answer");

	const outsideTui = await tool.execute("call-2", { questions: [{ question: "Q", header: "H", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] }, new AbortController().signal, undefined, { mode: "print", ui: {} });
	assert.equal(outsideTui.content[0]?.text, "Error: ask_user_question is unavailable outside the interactive TUI");
	assert.equal(outsideTui.details.errorKind, "unavailable_outside_tui");
});
