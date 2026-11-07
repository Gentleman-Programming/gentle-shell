import assert from "node:assert/strict";
import test from "node:test";

import { createContextBackstopSignal } from "../lib/context-backstop.ts";
import { createExplorationBudget } from "../lib/exploration-budget.ts";
import { todoPromptBlock } from "../lib/shell-todo.ts";

// ---------------------------------------------------------------------------
// full-delegation-mode-conflicts S5: runtime notices emitted in full delegation
// mode never tell the parent to work inline. Organic notices keep their exact
// text. The mode is passed as a thunk so it is resolved only when a notice is
// actually emitted, never on every tool result.
// ---------------------------------------------------------------------------

const INLINE = /stays? inline|inline write|do it and report/;
const env = { GENTLE_PI_CONTEXT_BACKSTOP_TOKENS: "1000" };
const usage = { tokens: 5_000, contextWindow: 100_000 };

test("S5: the context backstop notice in full delegation mode has no inline clause", () => {
	const notice = createContextBackstopSignal(env)("full", usage, () => "full-delegation");
	assert.ok(notice);
	assert.doesNotMatch(notice, INLINE);
	assert.match(notice, /delegate the next bounded unit/);
});

test("S5: the organic context backstop notice is unchanged", () => {
	const organic = createContextBackstopSignal(env)("organic", usage, () => "organic");
	const legacy = createContextBackstopSignal(env)("legacy", usage);
	assert.equal(organic, legacy, "an organic mode and no mode at all read the same");
	assert.match(organic ?? "", /while single small edits and state checks stay inline\.$/);
});

test("S5: the mode is resolved only when the backstop notice is emitted", () => {
	let resolved = 0;
	const signal = createContextBackstopSignal(env);
	signal("lazy", { tokens: 10, contextWindow: 100_000 }, () => { resolved += 1; return "full-delegation"; });
	assert.equal(resolved, 0, "below the backstop nothing reads the mode");
	signal("lazy", usage, () => { resolved += 1; return "full-delegation"; });
	signal("lazy", usage, () => { resolved += 1; return "full-delegation"; });
	assert.equal(resolved, 1, "one notice per crossing, one resolution");
});

function overBudget(mode?: () => "organic" | "full-delegation"): string | undefined {
	const budget = createExplorationBudget();
	budget.start("s");
	let notice: string | undefined;
	for (let index = 0; index < 5; index++) {
		const id = `call-${index}`;
		budget.call("s", id, "read");
		notice ??= budget.result("s", { toolCallId: id, toolName: "read", isError: false, content: [{ type: "text", text: "x".repeat(20_000) }] } as never, true, false, mode);
	}
	return notice;
}

test("S5: the exploration budget notice in full delegation mode names the writer, not an inline write", () => {
	const notice = overBudget(() => "full-delegation");
	assert.ok(notice);
	assert.doesNotMatch(notice, INLINE);
	assert.match(notice, /Reading that prepares a writer belongs in that writer's prompt\./);
});

test("S5: the organic exploration budget notice is unchanged", () => {
	const organic = overBudget(() => "organic");
	assert.equal(organic, overBudget());
	assert.match(organic ?? "", /Preparation for an already-understood authorized inline write remains exempt\./);
});

test("S5: the todo block in full delegation mode delegates small tasks instead of doing them", () => {
	assert.doesNotMatch(todoPromptBlock("full-delegation"), INLINE);
	assert.match(todoPromptBlock("full-delegation"), /A small task \(Task Size\) uses no todo list: delegate it and report\./);
});

test("S5: the organic todo block is byte-identical", () => {
	assert.equal(todoPromptBlock("organic"), todoPromptBlock());
	assert.match(todoPromptBlock(), /A small task \(Task Size\) uses no todo list: do it and report\./);
});
