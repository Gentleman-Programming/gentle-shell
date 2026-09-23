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

function statePendingTimer(rowState: Record<string, unknown>): unknown {
	return (rowState.gentleAiRender as Record<string, unknown> | undefined)?.pendingTimer;
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

test("a historical replay never invents a duration: fresh state, preparing render, stored result, invalidation", async () => {
	const rowState: Record<string, unknown> = {};
	const initial = renderGentleAiLifecycleCall("review status", plainTheme, { state: rowState, executionStarted: false, argsComplete: false } as never, undefined, 90_000);
	const initialLines = initial.render(90).map(stripAnsi);
	assert.match(initialLines[0], /· preparing · review status /);
	assert.doesNotMatch(initialLines.join("\n"), /\d+s/);
	assert.equal(stateStartedAt(rowState), undefined, "the preparing render of a replayed row must not invent a start");
	const resultCard = renderGentleAiResult({ content: [{ type: "text", text: "x" }] } as never, { expanded: false }, plainTheme, { state: rowState, invalidate: () => {} } as never);
	const resultLines = resultCard.render(90).map(stripAnsi);
	assert.doesNotMatch(resultLines.join("\n"), /\d+s/, "no persisted stamps means no duration on the closing rule");
	await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
	const replayed = renderGentleAiLifecycleCall("review status", plainTheme, { state: rowState, executionStarted: false, argsComplete: false } as never, undefined, 90_040);
	const replayedLine = replayed.render(90).map(stripAnsi)[0];
	assert.match(replayedLine, /· completed · review status /);
	assert.doesNotMatch(replayedLine, /\d+s/, "a replayed row with no persisted timestamps omits the unknown duration");
	assert.equal(stateStartedAt(rowState), undefined);
	assert.equal(stateEndedAt(rowState), undefined);
});

test("a replayed row restores its true frozen duration from durable session timing", async () => {
	const rowState: Record<string, unknown> = {};
	const durable = new Map([["call-1", { toolCallId: "call-1", startedAt: 1_000, endedAt: 31_000 }]]);
	const context = {
		state: rowState,
		toolCallId: "call-1",
		elapsedTiming: { lookup: (id: string) => durable.get(id) },
		executionStarted: false,
		argsComplete: false,
		invalidate: () => {},
	};
	const initial = renderGentleAiLifecycleCall("review status", plainTheme, context as never, undefined, 90_000);
	assert.match(initial.render(90).map(stripAnsi).join("\n"), / 30s ╯$/, "the seeded preparing card shows the durable duration");
	assert.equal(stateStartedAt(rowState), 1_000);
	assert.equal(stateEndedAt(rowState), 31_000);
	const resultCard = renderGentleAiResult({ content: [{ type: "text", text: "x" }] } as never, { expanded: false }, plainTheme, { state: rowState, invalidate: context.invalidate } as never);
	assert.match(resultCard.render(90).map(stripAnsi).join("\n"), /─* 30s ╯$/, "the stored result closes the frame with the frozen duration");
	await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
	const replayed = renderGentleAiLifecycleCall("review status", plainTheme, { ...context } as never, undefined, 90_040);
	const replayedLines = replayed.render(90).map(stripAnsi);
	assert.match(replayedLines[0], /· completed · review status /);
	assert.doesNotMatch(replayedLines[0], /90s|89s/, "the terminal re-render never grows the duration to the replay clock");
	assert.equal(stateStartedAt(rowState), 1_000, "the durable start survives the replay");
	assert.equal(stateEndedAt(rowState), 31_000, "the replayed row must not invent a new end");
	assert.equal(statePendingTimer(rowState), undefined, "the transient replay timer is cleared by the terminal render");
});

test("a replayed row with a start-only durable record never invents an end", async () => {
	const rowState: Record<string, unknown> = {};
	const durable = new Map([["call-2", { toolCallId: "call-2", startedAt: 1_000 }]]);
	const context = {
		state: rowState,
		toolCallId: "call-2",
		elapsedTiming: { lookup: (id: string) => durable.get(id) },
		executionStarted: false,
		argsComplete: false,
		invalidate: () => {},
	};
	const initial = renderGentleAiLifecycleCall("review status", plainTheme, context as never, undefined, 90_000);
	assert.doesNotMatch(initial.render(90).map(stripAnsi).join("\n"), /\d+s/, "a start without a durable end shows no duration");
	renderGentleAiResult({ content: [{ type: "text", text: "x" }] } as never, { expanded: false }, plainTheme, { state: rowState, invalidate: context.invalidate } as never);
	await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
	const replayed = renderGentleAiLifecycleCall("review status", plainTheme, { ...context } as never, undefined, 90_040);
	assert.match(replayed.render(90).map(stripAnsi)[0], /· completed · review status /);
	assert.equal(stateEndedAt(rowState), undefined, "a live-only end freeze must not fire on a replayed row");
	const final = renderGentleAiResult({ content: [{ type: "text", text: "x" }] } as never, { expanded: false }, plainTheme, { state: rowState } as never);
	assert.doesNotMatch(final.render(90).map(stripAnsi).join("\n"), /\d+s/);
});

test("running renders keep a single pending duration timer and the terminal render clears it", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const rowState: Record<string, unknown> = {};
	let invalidations = 0;
	const context = { state: rowState, argsComplete: true, executionStarted: false, invalidate: () => { invalidations += 1; } };
	renderGentleAiLifecycleCall("review capture", plainTheme, context as never, undefined, 1_000);
	const firstTimer = statePendingTimer(rowState);
	assert.ok(firstTimer, "a live running row keeps one pending duration timer");
	renderGentleAiLifecycleCall("review capture", plainTheme, context as never, undefined, 1_500);
	assert.notEqual(statePendingTimer(rowState), firstTimer, "a new render replaces the pending timer instead of stacking one");
	t.mock.timers.tick(1_000);
	assert.equal(invalidations, 1, "only the latest timer fires; the replaced one was cleared");
	renderGentleAiLifecycleCall("review capture", plainTheme, { ...context, executionStarted: true, isPartial: false } as never, undefined, 31_000);
	assert.equal(statePendingTimer(rowState), undefined, "a terminal render clears the pending timer");
	t.mock.timers.tick(60_000);
	assert.equal(invalidations, 1, "no timer outlives the terminal render");
});

// R4-replay-running-start-fabrication regressions. Real replays carry NO
// argsComplete (pi omits it on historical rows), unlike the older replay
// fixtures above that pass argsComplete: false (the PREPARING path).

test("a replayed row without argsComplete renders running but never fabricates a start", () => {
	const rowState: Record<string, unknown> = {};
	let invalidations = 0;
	const context = { state: rowState, executionStarted: false, invalidate: () => { invalidations += 1; } };
	const replayed = renderGentleAiLifecycleCall("review status", plainTheme, context as never, undefined, 90_000);
	const line = replayed.render(90).map(stripAnsi)[0];
	assert.match(line, /· running · review status /, "a replayed unfinished row computes to running (absent argsComplete)");
	assert.doesNotMatch(line, /\d+s/, "a replayed running row without durable stamps shows no duration");
	assert.equal(stateStartedAt(rowState), undefined, "an unexplained RUNNING on a replayed row must not stamp a start");
	assert.equal(statePendingTimer(rowState), undefined, "no start means no ticking timer for a dead row");
	assert.equal(invalidations, 0, "no invalidation fires during the render itself");
});

test("a start-only durable record under an args-less replay stays honest", () => {
	const rowState: Record<string, unknown> = {};
	const durable = new Map([["call-3", { toolCallId: "call-3", startedAt: 1_000 }]]);
	const context = {
		state: rowState,
		toolCallId: "call-3",
		elapsedTiming: { lookup: (id: string) => durable.get(id) },
		executionStarted: false,
		invalidate: () => {},
	};
	const initial = renderGentleAiLifecycleCall("review status", plainTheme, context as never, undefined, 90_000);
	assert.doesNotMatch(initial.render(90).map(stripAnsi).join("\n"), /\d+s/, "a start-only record shows no duration");
	assert.equal(stateStartedAt(rowState), undefined, "the start-only record is not seeded onto the replay");
	assert.equal(statePendingTimer(rowState), undefined, "no fabricated start means the 1 Hz invalidate loop never arms");
});

test("a live running row still stamps its start and keeps one timer", () => {
	const rowState: Record<string, unknown> = {};
	const context = { state: rowState, argsComplete: true, executionStarted: false, invalidate: () => {} };
	renderGentleAiLifecycleCall("review capture", plainTheme, context as never, undefined, 1_000);
	assert.equal(stateStartedAt(rowState), 1_000, "live evidence (argsComplete true) still stamps the start");
	assert.match(renderGentleAiLifecycleCall("review capture", plainTheme, { ...context } as never, undefined, 1_500).render(90).map(stripAnsi).join("\n"), /\d+s/);
	assert.ok(statePendingTimer(rowState), "the live row keeps its duration timer");
});

test("a seeded replay with a frozen end arms no ticking timer", () => {
	const rowState: Record<string, unknown> = {};
	const durable = new Map([["call-4", { toolCallId: "call-4", startedAt: 1_000, endedAt: 31_000 }]]);
	const context = {
		state: rowState,
		toolCallId: "call-4",
		elapsedTiming: { lookup: (id: string) => durable.get(id) },
		executionStarted: false,
		invalidate: () => {},
	};
	renderGentleAiLifecycleCall("review status", plainTheme, context as never, undefined, 90_000);
	assert.equal(stateStartedAt(rowState), 1_000, "the durable start is seeded");
	assert.equal(stateEndedAt(rowState), 31_000, "the durable end is seeded");
	assert.equal(statePendingTimer(rowState), undefined, "a frozen duration needs no wake-up timer");
});
