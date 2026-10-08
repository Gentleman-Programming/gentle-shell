import assert from "node:assert/strict";
import test from "node:test";
import {
	AGENT_LIFECYCLE_STATUS,
	GentleAgentCallCard,
	GentleAgentResultCard,
	renderGentleAgentCall,
	renderGentleAgentResult,
	agentOperationSubtitle,
	formatLiveTaskActivity,
	getGentleAgentRenderState,
} from "../lib/agents-renderer.ts";
import { CARD_TONE } from "../lib/shell-card.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
};

test("agentOperationSubtitle builds descriptive headers for all subagent tools", () => {
	assert.equal(
		agentOperationSubtitle("run", { agent: "gentle-ai-worker", label: "fix login bug" }, AGENT_LIFECYCLE_STATUS.RUNNING),
		"running · gentle-ai-worker · fix login bug",
	);
	assert.equal(
		agentOperationSubtitle("run", { agent: "gentle-ai-explore", task: "Investigate database schema.\nFind all tables." }, AGENT_LIFECYCLE_STATUS.COMPLETED),
		"completed · gentle-ai-explore · Investigate database schema",
	);
	assert.equal(
		agentOperationSubtitle("continue", { task_id: "task-42", label: "add tests" }, AGENT_LIFECYCLE_STATUS.RUNNING),
		"running · continue · task-42 · add tests",
	);
	assert.equal(
		agentOperationSubtitle("status", { task_id: "task-99" }, AGENT_LIFECYCLE_STATUS.COMPLETED),
		"completed · status · task-99",
	);
	assert.equal(
		agentOperationSubtitle("cancel", { task_id: "task-99" }, AGENT_LIFECYCLE_STATUS.FAILED),
		"failed · cancel · task-99",
	);
	assert.equal(
		agentOperationSubtitle("list_agents", {}, AGENT_LIFECYCLE_STATUS.COMPLETED),
		"completed · list agents",
	);
});

test("renderGentleAgentCall renders Gentle AI cards with appropriate tone and headers", () => {
	const call = renderGentleAgentCall("run", { agent: "gentle-ai-worker", label: "TASK-01" }, plainTheme, {
		executionStarted: true,
		isPartial: false,
	});
	assert.ok(call instanceof GentleAgentCallCard);
	const lines = call.render(70);
	assert.match(lines[0], /╭─ ❀ Gentle AI · completed · gentle-ai-worker · TASK-01/);
	assert.equal(call.tone, CARD_TONE.SUCCESS);
});

test("renderGentleAgentCall handles preparing, running, completed, and failed statuses", () => {
	const preparing = renderGentleAgentCall("run", { agent: "worker" }, plainTheme, {
		argsComplete: false,
	});
	assert.equal(preparing.status, AGENT_LIFECYCLE_STATUS.PREPARING);
	assert.equal(preparing.tone, CARD_TONE.WARNING);

	const running = renderGentleAgentCall("run", { agent: "worker" }, plainTheme, {
		executionStarted: true,
		isPartial: true,
	});
	assert.equal(running.status, AGENT_LIFECYCLE_STATUS.RUNNING);
	assert.equal(running.tone, CARD_TONE.WARNING);

	const failed = renderGentleAgentCall("run", { agent: "worker" }, plainTheme, {
		executionStarted: true,
		isError: true,
	});
	assert.equal(failed.status, AGENT_LIFECYCLE_STATUS.FAILED);
	assert.equal(failed.tone, CARD_TONE.ERROR);
});

test("renderGentleAgentCall displays detail rows like model and thinking", () => {
	const call = renderGentleAgentCall(
		"run",
		{ agent: "gentle-ai-worker", label: "refactor" },
		plainTheme,
		{ executionStarted: true, isPartial: true },
		["openai/gpt-5.6 · thinking: high"],
	);
	const rendered = call.render(70).join("\n");
	assert.match(rendered, /openai\/gpt-5\.6 · thinking: high/);
	assert.match(rendered, /╰─+╯/);
});

test("renderGentleAgentResult renders partial streaming updates cleanly", () => {
	const result = renderGentleAgentResult(
		{ content: [{ type: "text", text: "↳ running bash: npm test" }], details: {} },
		{ isPartial: true, expanded: false },
		plainTheme,
	);
	assert.ok(result instanceof GentleAgentResultCard);
	const lines = result.render(70);
	assert.match(lines.join("\n"), /↳ running bash: npm test/);
	assert.doesNotMatch(lines[lines.length - 1], /╰─+╯/, "partial updates do not prematurely close the card bottom");
});

test("renderGentleAgentResult renders completed results with card bottom", () => {
	const result = renderGentleAgentResult(
		{ content: [{ type: "text", text: "Completed implementation successfully.\nSecond line.\nThird line." }], details: {} },
		{ isPartial: false, expanded: false },
		plainTheme,
	);
	const lines = result.render(70);
	assert.match(lines[0], /Completed implementation successfully/);
	assert.match(lines[lines.length - 1], /╰─+╯/, "final result closes the card");
});

test("renderGentleAgentResult formats errors prominently even when collapsed", () => {
	const errorText = 'Writer tasks must include the exact Markdown heading "## Allowed edit surfaces"';
	const result = renderGentleAgentResult(
		{ content: [{ type: "text", text: errorText }], details: {} },
		{ isPartial: false, expanded: false, isError: true },
		plainTheme,
	);
	assert.equal(result.tone, CARD_TONE.ERROR);
	const rendered = result.render(70).join("\n");
	assert.match(rendered, /Allowed[\s\S]*edit surfaces/);
	assert.match(rendered, /╰─+╯/);
});

test("formatLiveTaskActivity formats in-flight tools and fallback steps", () => {
	assert.equal(
		formatLiveTaskActivity(
			{ turns: 0, toolCalls: 1, lastStep: "bash" },
			{ items: [{ kind: "tool", name: "bash", args: { command: "npm test" }, running: true }] },
		),
		"↳ $ npm test (turn 1 · 1 tool)",
	);
	assert.equal(
		formatLiveTaskActivity(
			{ turns: 2, toolCalls: 5, lastStep: "edit" },
			{ items: [{ kind: "tool", name: "edit", args: { path: "src/auth.ts" }, running: true }] },
		),
		"↳ edit src/auth.ts (turn 3 · 5 tools)",
	);
	assert.equal(
		formatLiveTaskActivity({ turns: 0, toolCalls: 0, lastStep: "starting" }),
		"↳ starting subprocess (turn 1)",
	);
});

test("render state records outcomes and triggers invalidation on completion", async () => {
	let invalidated = false;
	const state: Record<string, unknown> = {};
	const context = {
		state,
		invalidate: () => { invalidated = true; },
	};

	renderGentleAgentResult(
		{ content: [{ type: "text", text: "Done" }], details: {} },
		{ isPartial: false, expanded: false },
		plainTheme,
		context,
	);

	await new Promise<void>((resolve) => { queueMicrotask(() => resolve()); });
	assert.equal(invalidated, true);

	const agentState = getGentleAgentRenderState(state);
	assert.equal(agentState?.finished, true);
	assert.equal(agentState?.failed, false);
});
