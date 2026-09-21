import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { renderGentleAiLifecycleCall, renderGentleAiResult, GentleAiCallCard } from "../lib/gentle-ai-renderer.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

initTheme("dark");

// Rose cards: exactly one component closes the frame in every state. While
// a call runs, the call card draws the bottom rule (a partial result never
// does); once the final result is in, the result card closes the frame.

const plainTheme = { fg: (_color: string, text: string) => text };

test("a running call card closes its own frame and a completed one leaves that to the result", () => {
	const card = new GentleAiCallCard();
	card.update("running", "review capture · reliability", plainTheme);
	const running = card.render(60).map(stripAnsi);
	assert.equal(running.length, 2);
	assert.match(running[0], /^╭─ 🌹︎ Gentle AI · running · review capture · reliability ─*╮$/);
	assert.match(running[1], /^╰─+╯$/);
	card.update("preparing", "review status", plainTheme, "$ gentle-ai review status");
	assert.match(card.render(60).map(stripAnsi)[2], /^╰─+╯$/);
	card.update("completed", "review status", plainTheme, undefined, "ctrl+o to expand");
	const completed = card.render(80).map(stripAnsi);
	assert.equal(completed.length, 1);
	assert.match(completed[0], /ctrl\+o to expand ╮$/);
	assert.equal(visibleWidth(completed[0]), 80);
});

test("completed review cards fit Pi's default Box at terminal width 57", () => {
	for (const operationPath of ["review inspect", "review status", "review capture · reliability", "review acknowledge approved"]) {
		const card = new GentleAiCallCard();
		card.update("completed", operationPath, plainTheme, undefined, "ctrl+o to expand");
		const box = new Box(1, 1);
		box.addChild(card);
		const lines = box.render(57).map(stripAnsi);
		for (const line of lines) assert.equal(visibleWidth(line), 57, `${operationPath}: ${JSON.stringify(line)}`);
		if (operationPath === "review inspect") {
			assert.equal(lines[1], " ╭─ 🌹︎ Gentle AI · completed · review inspect ─────────╮ ");
		}
	}
});

test("review registrations own their shell", () => {
	const tools: ToolDefinition[] = [];
	createGentleAiExtension({ nativeReviewCli: null } as never)({
		on() {}, registerCommand() {}, registerTool(tool: ToolDefinition) { tools.push(tool); },
	} as unknown as ExtensionAPI);
	const review = tools.filter((tool) => tool.name.startsWith("gentle_review"));
	assert.equal(review.length, 4);
	for (const tool of review) assert.equal(tool.renderShell, "self", tool.name);
});

test("review call and result cards have no passive background fill", () => {
	const theme = { ...plainTheme, bg: (_role: string, text: string) => `\x1b[44m${text}\x1b[49m` };
	for (const options of [
		{ expanded: true }, { expanded: false },
		{ expanded: true, isPartial: true }, { expanded: false, isPartial: true },
		{ expanded: true, isError: true }, { expanded: false, isError: true },
	]) {
		const call = new GentleAiCallCard();
		call.update(options.isPartial ? "running" : "completed", "review capture", theme, "$ capture");
		const lines = [...call.render(40), ...renderGentleAiResult({ content: [{ type: "text", text: "Result" }] }, options, theme).render(40)];
		for (const [row, line] of lines.entries()) {
			let bg = false, column = 0;
			for (const token of line.match(/\x1b\[[\d;]*m|[^\x1b]/gu) ?? []) {
				if (token === "\x1b[44m") bg = true;
				else if (token === "\x1b[49m" || token === "\x1b[0m") bg = false;
				else if (!token.startsWith("\x1b")) {
					assert.equal(bg, false, `row ${row}, cell ${column} must remain transparent`);
					column += visibleWidth(token);
				}
			}
			assert.equal(bg, false);
			assert.equal(visibleWidth(line), 40);
		}
	}
});

test("a partial result draws no bottom rule and a final one draws exactly one", () => {
	const partial = renderGentleAiResult({ content: [{ type: "text", text: "half" }] }, { expanded: false, isPartial: true }, plainTheme).render(60).map(stripAnsi);
	assert.deepEqual(partial.map((line) => line.slice(0, 1)), ["│"], "only the count row, no closing rule");
	const final = renderGentleAiResult({ content: [{ type: "text", text: "one\ntwo" }] }, { expanded: false }, plainTheme).render(60).map(stripAnsi);
	assert.equal(final.length, 2);
	assert.match(final[0], /^│ 2 lines +│$/);
	assert.match(final[1], /^╰─+╯$/);
	const empty = renderGentleAiResult({ content: [] }, { expanded: false }, plainTheme).render(60).map(stripAnsi);
	assert.deepEqual(empty.map((line) => line.slice(0, 1)), ["╰"]);
});

test("promoting the shared state to finished invalidates after the render returns, never inside it", async () => {
	const state: Record<string, unknown> = {};
	let invalidations = 0;
	const context = { state, invalidate: () => (invalidations += 1) };
	renderGentleAiResult({ content: [{ type: "text", text: "done" }] }, { expanded: false }, plainTheme, context as never);
	assert.equal(invalidations, 0, "no reentrant invalidate while rendering");
	await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
	assert.equal(invalidations, 1);
	renderGentleAiResult({ content: [{ type: "text", text: "done" }] }, { expanded: false }, plainTheme, context as never);
	await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
	assert.equal(invalidations, 1, "an unchanged state does not invalidate again");
});

function stateStartedAt(rowState: Record<string, unknown>): number | undefined {
	return (rowState.gentleAiRender as Record<string, unknown> | undefined)?.startedAt as number | undefined;
}

function stateEndedAt(rowState: Record<string, unknown>): number | undefined {
	return (rowState.gentleAiRender as Record<string, unknown> | undefined)?.endedAt as number | undefined;
}

test("a call card stamps its duration from first sight to terminal freeze", () => {
	const rowState: Record<string, unknown> = {};
	const running = renderGentleAiLifecycleCall("review capture · risk", plainTheme, { state: rowState, argsComplete: true, executionStarted: false } as never, undefined, 1_000);
	const runningLines = running.render(100).map(stripAnsi);
	assert.match(runningLines[0], /^╭─ 🌹︎ Gentle AI · running · review capture · risk ─*╮$/);
	assert.match(runningLines[runningLines.length - 1], / 0s ╯$/, "the live duration ticks on the bottom rule");
	assert.equal(stateStartedAt(rowState), 1_000);
	const done = renderGentleAiLifecycleCall("review capture · risk", plainTheme, { state: rowState, executionStarted: true, isPartial: false } as never, undefined, 31_000);
	const doneLine = done.render(120).map(stripAnsi)[0];
	assert.match(doneLine, /^╭─ 🌹︎ Gentle AI · completed · review capture · risk ─+\s+to expand ╮$/);
	const doneResult = renderGentleAiResult({ content: [{ type: "text", text: "x" }] } as never, { expanded: false }, plainTheme, { state: rowState } as never).render(90).map(stripAnsi);
	assert.match(doneResult[doneResult.length - 1], /─* 30s ╯$/, "the frozen duration closes the frame, right-aligned");
	assert.equal(stateEndedAt(rowState), 31_000);
	const frozen = renderGentleAiLifecycleCall("review capture · risk", plainTheme, { state: rowState, executionStarted: true, isPartial: false } as never, undefined, 99_000);
	const frozenResult = renderGentleAiResult({ content: [{ type: "text", text: "x" }] } as never, { expanded: false }, plainTheme, { state: rowState } as never).render(90).map(stripAnsi);
	assert.match(frozenResult[frozenResult.length - 1], / 30s ╯$/, "a late re-render never grows the duration");
});

test("a replayed call shows its persisted duration; one without a start stays honest", () => {
	const persistedRow: Record<string, unknown> = { gentleAiRender: { startedAt: 1_000, endedAt: 31_000, finished: true } };
	const persisted = renderGentleAiLifecycleCall("review status", plainTheme, { state: persistedRow, executionStarted: false } as never, undefined, 90_000);
	const persistedLines = persisted.render(90).map(stripAnsi);
	assert.match(persistedLines[0], /^╭─ 🌹︎ Gentle AI · completed · review status ─+\s+to expand ╮$/);
	const persistedResult = renderGentleAiResult({ content: [{ type: "text", text: "x" }] } as never, { expanded: false }, plainTheme, { state: persistedRow } as never).render(90).map(stripAnsi);
	assert.match(persistedResult[persistedResult.length - 1], /─* 30s ╯$/, "a replay with persisted stamps shows its frozen duration on the closing rule");
	const promotedRow: Record<string, unknown> = { gentleAiRender: { finished: true } };
	const promoted = renderGentleAiLifecycleCall("review status", plainTheme, { state: promotedRow, executionStarted: false } as never, undefined, 90_000);
	const promotedLine = promoted.render(90).map(stripAnsi)[0];
	assert.match(promotedLine, /^╭─ 🌹︎ Gentle AI · completed · review status ─*\s*to expand ╮$/, "a result-promoted replay shows only the expand key");
	assert.doesNotMatch(promotedLine, /\d+s/);
});

test("a card with no render state stays honest about unknown duration", () => {
	const card = renderGentleAiLifecycleCall("review capture", plainTheme, { executionStarted: true, isPartial: false } as never, undefined, 5_000);
	const line = card.render(80).map(stripAnsi)[0];
	assert.match(line, /· completed · review capture /);
	assert.doesNotMatch(line, /\d+s/);
});
