import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { renderGentleAiLifecycleCall, renderGentleAiResult, GentleAiCallCard } from "../lib/gentle-ai-renderer.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
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
	assert.match(running[0], /^╭─ 🌹 rdd running · capture · reliability ─*╮$/);
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
			assert.equal(lines[1], " ╭─ 🌹 rdd inspect ────────────────── ctrl+o to expand ╮ ");
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

test("review call and result cards have no passive background fill", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	setCardStyle(CARD_STYLE.NEON);
	const theme = { ...plainTheme, bg: (_role: string, text: string) => `\x1b[44m${text}\x1b[49m` };
	for (const options of [
		{ expanded: true }, { expanded: false },
		{ expanded: true, isPartial: true }, { expanded: false, isPartial: true },
		{ expanded: true, isError: true }, { expanded: false, isError: true },
	]) {
		const call = new GentleAiCallCard();
		call.update(options.isPartial ? "running" : "completed", "review capture", theme, "$ capture");
		const lines = [...call.render(40), ...renderGentleAiResult({ content: [{ type: "text", text: "Result" }], details: {} }, options, theme).render(40)];
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
	const partial = renderGentleAiResult({ content: [{ type: "text", text: "half" }], details: {} }, { expanded: false, isPartial: true }, plainTheme).render(60).map(stripAnsi);
	assert.deepEqual(partial.map((line) => line.slice(0, 1)), ["│"], "only the preview row, no closing rule");
	const final = renderGentleAiResult({ content: [{ type: "text", text: "one\ntwo" }], details: {} }, { expanded: false }, plainTheme).render(60).map(stripAnsi);
	assert.equal(final.length, 3);
	assert.match(final[0], /^│ one +│$/);
	assert.match(final[1], /^│ two +│$/);
	assert.match(final[2], /^╰─+╯$/);
	const empty = renderGentleAiResult({ content: [], details: {} }, { expanded: false }, plainTheme).render(60).map(stripAnsi);
	assert.deepEqual(empty.map((line) => line.slice(0, 1)), ["╰"]);
});

test("promoting the shared state to finished invalidates after the render returns, never inside it", async () => {
	const state: Record<string, unknown> = {};
	let invalidations = 0;
	const context = { state, invalidate: () => (invalidations += 1) };
	renderGentleAiResult({ content: [{ type: "text", text: "done" }], details: {} }, { expanded: false }, plainTheme, context as never);
	assert.equal(invalidations, 0, "no reentrant invalidate while rendering");
	await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
	assert.equal(invalidations, 1);
	renderGentleAiResult({ content: [{ type: "text", text: "done" }], details: {} }, { expanded: false }, plainTheme, context as never);
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
	assert.match(runningLines[0], /^╭─ 🌹 rdd running · capture · risk ─*╮$/);
	assert.match(runningLines[runningLines.length - 1], / 0s ╯$/, "the live duration ticks on the bottom rule");
	assert.equal(stateStartedAt(rowState), 1_000);
	const done = renderGentleAiLifecycleCall("review capture · risk", plainTheme, { state: rowState, executionStarted: true, isPartial: false } as never, undefined, 31_000);
	const doneLine = done.render(120).map(stripAnsi)[0];
	assert.match(doneLine, /^╭─ 🌹 rdd capture · risk ─+\s+to expand ╮$/);
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
	assert.match(persistedLines[0], /^╭─ 🌹 rdd status ─+\s+to expand ╮$/);
	const persistedResult = renderGentleAiResult({ content: [{ type: "text", text: "x" }] } as never, { expanded: false }, plainTheme, { state: persistedRow } as never).render(90).map(stripAnsi);
	assert.match(persistedResult[persistedResult.length - 1], /─* 30s ╯$/, "a replay with persisted stamps shows its frozen duration on the closing rule");
	const promotedRow: Record<string, unknown> = { gentleAiRender: { finished: true } };
	const promoted = renderGentleAiLifecycleCall("review status", plainTheme, { state: promotedRow, executionStarted: false } as never, undefined, 90_000);
	const promotedLine = promoted.render(90).map(stripAnsi)[0];
	assert.match(promotedLine, /^╭─ 🌹 rdd status ─*\s*to expand ╮$/, "a result-promoted replay shows only the expand key");
	assert.doesNotMatch(promotedLine, /\d+s/);
});

test("a card with no render state stays honest about unknown duration", () => {
	const card = renderGentleAiLifecycleCall("review capture", plainTheme, { executionStarted: true, isPartial: false } as never, undefined, 5_000);
	const line = card.render(80).map(stripAnsi)[0];
	assert.match(line, / rdd capture /);
	assert.doesNotMatch(line, /completed/);
	assert.doesNotMatch(line, /\d+s/);
});

test("a historical replay never invents a duration: fresh state, preparing render, stored result, invalidation", async () => {
	const rowState: Record<string, unknown> = {};
	const initial = renderGentleAiLifecycleCall("review status", plainTheme, { state: rowState, executionStarted: false, argsComplete: false } as never, undefined, 90_000);
	const initialLines = initial.render(90).map(stripAnsi);
	assert.match(initialLines[0], / rdd preparing · status /);
	assert.doesNotMatch(initialLines.join("\n"), /\d+s/);
	assert.equal(stateStartedAt(rowState), undefined, "the preparing render of a replayed row must not invent a start");
	const resultCard = renderGentleAiResult({ content: [{ type: "text", text: "x" }] } as never, { expanded: false }, plainTheme, { state: rowState, invalidate: () => {} } as never);
	const resultLines = resultCard.render(90).map(stripAnsi);
	assert.doesNotMatch(resultLines.join("\n"), /\d+s/, "no persisted stamps means no duration on the closing rule");
	await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
	const replayed = renderGentleAiLifecycleCall("review status", plainTheme, { state: rowState, executionStarted: false, argsComplete: false } as never, undefined, 90_040);
	const replayedLine = replayed.render(90).map(stripAnsi)[0];
	assert.match(replayedLine, / rdd status /);
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
	assert.match(replayedLines[0], / rdd status /);
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
	assert.match(replayed.render(90).map(stripAnsi)[0], / rdd status /);
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

test("native review registration passes host failure context into the rose result", () => {
	const tools: ToolDefinition[] = [];
	createGentleAiExtension({ nativeReviewCli: null } as never)({
		on() {}, registerCommand() {}, registerTool(tool: ToolDefinition) { tools.push(tool); },
	} as unknown as ExtensionAPI);
	const tool = tools.find((tool) => tool.name === "gentle_review");
	assert.ok(tool?.renderResult);
	const roles: string[] = [];
	const theme = { fg: (role: string, text: string) => { roles.push(role); return text; } };
	const result = { content: [{ type: "text" as const, text: "candidate unavailable" }], details: undefined };
	const component = tool.renderResult(result, { expanded: false, isPartial: false }, theme as never, { isError: true, state: {} } as never);
	assert.match(component.render(80).join("\n"), /candidate unavailable/);
	assert.ok(roles.includes("error"));
	assert.ok(!roles.includes("success"));
});

test("native context failures keep red useful previews and promote replay state", async () => {
	const state = {};
	const roles: string[] = [];
	const theme = { fg: (role: string, text: string) => { roles.push(role); return text; } };
	const text = "authority unavailable\nretry with the bound candidate\nthird detail\nfourth detail";
	const ctx = { state, isError: true, executionStarted: false };
	const result = { content: [{ type: "text" as const, text }], details: undefined };
	const collapsed = renderGentleAiResult(result, { expanded: false }, theme, ctx);
	assert.match(collapsed.render(80).join("\n"), /authority unavailable/);
	assert.ok(roles.includes("error"));
	assert.ok(!roles.includes("success"));
	await Promise.resolve();
	const call = renderGentleAiLifecycleCall("review status", theme, { state });
	assert.match(call.render(100)[0], /🌹 rdd failed · status /);
	for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8, 24, 100]) {
		const rows = collapsed.render(width);
		assert.ok(rows.length <= 4);
		assert.ok(rows.every((row) => visibleWidth(row) <= width));
		assert.equal(rows.filter((row) => row.startsWith("╰")).length, width === 0 ? 0 : 1);
	}
	assert.match(renderGentleAiResult(result, { expanded: true }, theme, ctx).render(80).join("\n"), /fourth detail/);
	roles.length = 0;
	const partial = renderGentleAiResult(result, { expanded: false, isPartial: true }, theme, { state: {} });
	assert.match(partial.render(80).join("\n"), /authority unavailable/);
	assert.ok(roles.includes("warning"));
	assert.ok(!roles.includes("success"));
	roles.length = 0;
	const success = renderGentleAiResult(result, { expanded: false }, theme, { state: {} });
	assert.match(success.render(80).join("\n"), /authority unavailable/);
	assert.ok(roles.includes("success"), "status comes from the host, not text classification");
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
	assert.match(line, / rdd running · status /, "a replayed unfinished row computes to running (absent argsComplete)");
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

// JSON envelopes (review inspect/assess and friends) collapse to one human
// summary line instead of raw JSON rows; expanding shows the pretty envelope.

const digest = `sha256:${"a".repeat(64)}`;
const inspectEnvelope = {
	operation: "inspect",
	status: "blocked",
	result: {
		schema: "gentle-ai.review-integration.status/v9",
		target_identity: digest,
		action: "start",
		next_transition: {
			kind: "execute",
			reason_code: "fresh_target_ready",
			execute: { operation: "review.start", arguments: [{ name: "lineage", token: "--lineage=review-fixture" }], binding: { target_identity: digest } },
		},
	},
};
const assessEnvelope = {
	operation: "assess",
	schema: "gentle-pi.review-assessment-plan/v1",
	risk: "unassessable",
	reasons: [{ code: "non-zero", detail: "native review assess failed: Error: untracked files require an explicit declaration; pass intendedUntracked with the exact paths" }],
	changedPaths: 0,
	changedLines: 0,
	candidate: null,
	rddLine: "on",
	nativeReviewOutcome: "unknown",
	plan: { verifier: "independent", commands: ["gentle-ai review assess --cwd . --json"] },
};

function jsonResult(value: unknown, compact = true) {
	return { content: [{ type: "text" as const, text: compact ? JSON.stringify(value) : JSON.stringify(value, null, 2) }], details: undefined };
}

function bodyRows(lines: string[]): string[] {
	return lines.map(stripAnsi).filter((line) => line.startsWith("│")).map((line) => line.slice(1, -1).trim());
}

test("a collapsed inspect envelope shows one readable summary instead of raw JSON", () => {
	const lines = renderGentleAiResult(jsonResult(inspectEnvelope), { expanded: false }, plainTheme).render(120);
	assert.deepEqual(bodyRows(lines), ["blocked · start · fresh_target_ready"]);
	const text = lines.join("\n");
	assert.doesNotMatch(text, /\{"|schema|sha256|review-integration|--lineage|review\.start/);
	assert.match(stripAnsi(lines[lines.length - 1]), /^╰─+╯$/);
});

test("a collapsed assess envelope shows its risk and the diagnostic message", () => {
	for (const compact of [true, false]) {
		const lines = renderGentleAiResult(jsonResult(assessEnvelope, compact), { expanded: false }, plainTheme).render(120);
		assert.deepEqual(bodyRows(lines), ["unassessable · native review assess failed: untracked files require an explicit declaration"]);
		assert.doesNotMatch(lines.join("\n"), /\{"|schema|assessment-plan|gentle-ai review|Error:/);
	}
});

test("an expanded JSON envelope is pretty-printed in full", () => {
	const lines = renderGentleAiResult(jsonResult(inspectEnvelope), { expanded: true }, plainTheme).render(160);
	const raw = lines.map(stripAnsi).filter((line) => line.startsWith("│")).map((line) => line.slice(2).replace(/ *│$/, ""));
	assert.equal(raw.join("\n"), JSON.stringify(inspectEnvelope, null, 2));
	assert.equal(lines.filter((line) => stripAnsi(line).startsWith("╰")).length, 1);
});

test("an error envelope keeps the red frame and shows the error message", () => {
	const roles: string[] = [];
	const theme = { fg: (role: string, text: string) => { roles.push(role); return text; } };
	const envelope = {
		operation: "start",
		status: "blocked",
		outcome: "native-status-package-binary-missing",
		diagnostics: { operation: "status", error_code: "package-binary-missing", timed_out: false, output_limit_exceeded: false, stderr: "gentle-ai binary not found\nsecond line" },
		recovery_command: "npm install --global gentle-ai",
	};
	const lines = renderGentleAiResult(jsonResult(envelope), { expanded: false }, theme, { isError: true, state: {} }).render(120);
	assert.deepEqual(bodyRows(lines), ["blocked · native-status-package-binary-missing · package-binary-missing · gentle-ai binary not found"]);
	assert.ok(roles.includes("error"));
	assert.ok(!roles.includes("success"));
	assert.doesNotMatch(lines.join("\n"), /npm install|second line/);
});

test("a JSON object without known fields collapses to a field count", () => {
	const lines = renderGentleAiResult(jsonResult({ version: 1, sha256: digest, cursor: 0, totalPaths: 1, entries: [] }), { expanded: false }, plainTheme).render(80);
	assert.deepEqual(bodyRows(lines), ["5 fields"]);
	const shorthand = renderGentleAiResult(jsonResult({ next_transition: "stop" }), { expanded: false }, plainTheme).render(80);
	assert.deepEqual(bodyRows(shorthand), ["stop"], "a string transition is its own reason");
});

test("decoded escape sequences inside JSON values never reach the terminal", () => {
	const lines = renderGentleAiResult(jsonResult({ status: "blocked\u001b[31m", reason: "bad\u0007 input" }), { expanded: false }, plainTheme).render(80);
	assert.deepEqual(bodyRows(lines), ["blocked · bad input"]);
	assert.doesNotMatch(lines.join(""), /[\u0000-\u0008\u000b-\u001f\u007f]/);
	const expanded = renderGentleAiResult(jsonResult({ status: "blocked\u001b[31m" }), { expanded: true }, plainTheme).render(80).join("\n");
	assert.doesNotMatch(expanded, /\u001b/);
	assert.match(expanded, /\\u001b\[31m/);
});

test("non-JSON results keep the text preview", () => {
	for (const text of ["{not json", "[1, 2, 3]", "plain one\nplain two"]) {
		const lines = renderGentleAiResult({ content: [{ type: "text", text }], details: undefined }, { expanded: false }, plainTheme).render(80);
		assert.deepEqual(bodyRows(lines), text.split("\n"));
	}
});

test("JSON summaries stay bounded at every width", () => {
	for (const envelope of [inspectEnvelope, assessEnvelope]) {
		for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8, 24, 80]) {
			const rows = renderGentleAiResult(jsonResult(envelope), { expanded: false }, plainTheme).render(width);
			if (width === 0) { assert.deepEqual(rows, []); continue; }
			assert.ok(rows.length <= 3, `width ${width}: ${rows.length} rows`);
			assert.ok(rows.every((row) => visibleWidth(row) <= width), `width ${width}`);
			assert.equal(rows.filter((row) => stripAnsi(row).startsWith("╰")).length, 1);
		}
	}
	const narrow = bodyRows(renderGentleAiResult(jsonResult(assessEnvelope), { expanded: false }, plainTheme).render(40));
	assert.equal(narrow.length, 1);
	assert.match(narrow[0], /^unassessable · native.*…$/);
});

// The rose call card reads like the quiet read card: glyph, a short name and
// the operation as its argument, in one title span without a muted subtitle.

test("rose call cards title the operation as rdd <op>, or gentle-ai <op> outside review", () => {
	const title = (status: "preparing" | "running" | "completed" | "failed", operationPath: string) => {
		const card = new GentleAiCallCard();
		card.update(status, operationPath, plainTheme);
		return stripAnsi(card.render(120)[0]).replace(/^╭─ /, "").replace(/ ─+╮$/, "");
	};
	assert.equal(title("completed", "review inspect"), "\u{1F339} rdd inspect");
	assert.equal(title("completed", "review assess"), "\u{1F339} rdd assess");
	assert.equal(title("running", "review start"), "\u{1F339} rdd running · start");
	assert.equal(title("failed", "review capture · risk"), "\u{1F339} rdd failed · capture · risk");
	assert.equal(title("preparing", "review mode enable"), "\u{1F339} rdd preparing · mode enable");
	assert.equal(title("running", "review"), "\u{1F339} rdd running");
	assert.equal(title("completed", "review"), "\u{1F339} rdd");
	assert.equal(title("completed", "version"), "\u{1F339} gentle-ai version");
	assert.equal(title("running", "command"), "\u{1F339} gentle-ai running · command");
});

test("the rose is a colored emoji and the title is one span in the outcome tone", () => {
	const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>` };
	const card = new GentleAiCallCard();
	card.update("completed", "review inspect", theme, undefined, "ctrl+o to expand");
	const top = card.render(80)[0];
	assert.match(top, /<success>\u{1F339} rdd inspect<\/success>/u);
	assert.doesNotMatch(top, /\uFE0E|Gentle AI|<muted>/);
	assert.equal(visibleWidth("\u{1F339}"), 2);
});

test("rose call cards stay exactly as wide as the terminal with the 2-cell emoji", () => {
	for (const [status, operationPath, hint] of [
		["completed", "review inspect", "ctrl+o to expand"],
		["running", "review capture group · risk · resilience · readability · reliability", undefined],
		["failed", "version", "ctrl+o to expand"],
	] as const) {
		const card = new GentleAiCallCard();
		card.update(status, operationPath, plainTheme, undefined, hint);
		for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8, 24, 40, 80, 120]) {
			const lines = card.render(width);
			if (width === 0) { assert.deepEqual(lines, []); continue; }
			for (const line of lines) assert.equal(visibleWidth(line), width, `${operationPath} at ${width}: ${JSON.stringify(line)}`);
		}
	}
});

// Float style: the rose call card and its result read as one borderless panel.
const floatTheme = {
	fg: (_color: string, text: string) => `\x1b[38;5;114m${text}\x1b[39m`,
	bg: (color: string, text: string) => `\x1b[48;5;${color === "toolErrorBg" ? 52 : color === "toolPendingBg" ? 58 : 22}m${text}\x1b[49m`,
};

function withFloatCards<T>(run: () => T): T {
	setCardStyle(CARD_STYLE.FLOAT);
	try {
		return run();
	} finally {
		setCardStyle(CARD_STYLE.NEON);
	}
}

const BLANK = /^ ▎ +$/;

test("float rose cards join the call and the JSON summary into one panel", () => {
	const rows = withFloatCards(() => {
		const call = new GentleAiCallCard();
		call.update("completed", "review inspect", floatTheme, "$ gentle-ai review inspect", "ctrl+o to expand");
		const envelope = JSON.stringify({ schema: "x/v1", status: "ready", risk: "medium" });
		const result = renderGentleAiResult({ content: [{ type: "text", text: envelope }] } as never, { expanded: false }, floatTheme);
		return [...call.render(70), ...result.render(70)];
	});
	const plain = rows.map(stripAnsi);
	for (const line of rows) {
		assert.equal(visibleWidth(line), 70);
		assert.ok(line.startsWith(" \x1b[48;5;22m") && line.endsWith("\x1b[49m "), JSON.stringify(line));
	}
	assert.doesNotMatch(plain.join("\n"), /[╭╮╰╯│─]/);
	assert.match(plain[0]!, BLANK);
	assert.match(plain[1]!, /^ ▎ 🌹 rdd inspect +ctrl\+o to expand {4}$/);
	assert.match(plain[2]!, /^ ▎ \$ gentle-ai review inspect +$/, "the command stays with the heading");
	assert.match(plain[3]!, BLANK);
	assert.match(plain[4]!, /^ ▎ ready · medium +$/);
	assert.match(plain[5]!, BLANK);
	assert.equal(plain.length, 6);
	assert.equal(plain[1]!.indexOf("🌹"), plain[4]!.indexOf("ready"));
});

test("float rose cards keep the elapsed time on the blank closing row and add no separator under a running call", () => {
	const rows = withFloatCards(() => {
		const call = new GentleAiCallCard();
		call.update("running", "review status", floatTheme, undefined, undefined, "3s");
		const partial = renderGentleAiResult({ content: [{ type: "text", text: "working" }] } as never, { isPartial: true }, floatTheme);
		return [...call.render(40), ...partial.render(40)];
	});
	const plain = rows.map(stripAnsi);
	assert.match(plain[0]!, BLANK);
	assert.match(plain[1]!, /^ ▎ 🌹 rdd running · status +$/);
	assert.match(plain[2]!, /^ ▎ +3s {3}$/);
	assert.match(plain[3]!, /^ ▎ working +$/);
	assert.equal(plain.length, 4);
	for (const line of rows) assert.ok(line.startsWith(" \x1b[48;5;58m"), JSON.stringify(line));
});

test("float rose error results paint the error background on every row", () => {
	const rows = withFloatCards(() => renderGentleAiResult({ content: [{ type: "text", text: "boom\nsecond" }] } as never, { isError: true }, floatTheme).render(40));
	const plain = rows.map(stripAnsi);
	assert.deepEqual(plain.map((line) => BLANK.test(line)), [true, false, false, true]);
	for (const line of rows) assert.ok(line.startsWith(" \x1b[48;5;52m"), JSON.stringify(line));
});
