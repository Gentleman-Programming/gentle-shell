import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { paintPanelSurface, PANEL_SURFACE_ROLE, renderPanelHeader, renderPanelRow } from "../lib/shell-panel.ts";
import { renderTodoSection, type TodoState } from "../lib/shell-todo.ts";
import { renderJobsSection } from "../lib/jobs-widget.ts";
import { JOB_GLYPH } from "../lib/background-jobs-tools.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The fullscreen rail draws its sections as one panel (design/shell-rework/02-proposal.html):
// a one-row header `▾ NAME … count` and dense rows, no card chrome.

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `*${text}*`,
	strikethrough: (text: string) => `~${text}~`,
};
const plain = { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text };

test("a panel header names the section in bold caps with its count right-aligned", () => {
	assert.equal(visibleWidth(renderPanelHeader(plain, 40, { title: "Todos", count: "2/6", open: true })), 40);
	const row = renderPanelHeader(theme, 80, { title: "Todos", count: "2/6", open: true });
	assert.match(row, /<muted>▾<\/muted> <text>\*TODOS\*<\/text>/);
	assert.match(row, /<muted>2\/6<\/muted>$/);
	assert.match(renderPanelHeader(theme, 40, { title: "Todos", count: "2/6", open: false }), /<muted>▸<\/muted>/);
});

test("a hovered panel header paints its glyph with the shared hover role", () => {
	assert.match(renderPanelHeader(theme, 40, { title: "Jobs", open: true, hovered: true }), /<warning>▾<\/warning>/);
});

test("a panel row keeps the right column and clips the left one to the width", () => {
	const row = stripAnsi(renderPanelRow(30, "● job-1 a very long command line that does not fit", "2m03s"));
	assert.equal(visibleWidth(row), 30);
	assert.match(row, /^  ● job-1 .*…\s+2m03s$/);
	assert.equal(stripAnsi(renderPanelRow(20, "short")), "  short".padEnd(20));
});

test("the panel surface paints the rail role behind the row and re-arms it after resets", () => {
	const bg = (color: string, text: string) => `[${color}]${text}\x1b[49m`;
	const painted = paintPanelSurface({ fg: plain.fg, bg }, ["a\x1b[0mb"]);
	assert.equal(PANEL_SURFACE_ROLE, "customMessageBg");
	assert.deepEqual(painted, ["[customMessageBg]a\x1b[0m[customMessageBg]b\x1b[49m"]);
	assert.deepEqual(paintPanelSurface(plain, ["row"]), ["row"], "a theme without bg keeps rows unpainted");
});

const state = (tasks: Array<[string, string, string?]>): TodoState => ({
	tasks: tasks.map(([title, status, note], index) => ({ id: index + 1, title, status: status as never, ...(note ? { note } : {}) })),
	nextId: tasks.length + 1,
	updatedTurn: 0,
});

test("the Todos section folds finished work into one row and keeps open tasks one row each", () => {
	const todos = state([["Rebuild the chain", "done"], ["Create the issue", "done"], ["Run the full suite", "in_progress", "job-1"], ["Push the tracker", "pending"], ["Drop it", "dropped"]]);
	const section = renderTodoSection(todos, plain, 40, { collapsed: false, staleTurns: 0 });
	assert.equal(stripAnsi(section.header).trim().replace(/\s+/g, " "), "▾ TODOS 2/4");
	assert.deepEqual(section.body.map((row) => stripAnsi(row).trimEnd()), [
		"  ✓ 2 done",
		"  ✕ 1 dropped",
		"  ◐ Run the full suite",
		"    └ job-1",
		"  ○ Push the tracker",
	]);
	for (const row of [section.header, ...section.body]) assert.equal(visibleWidth(stripAnsi(row)), 40);
});

test("the task in progress wraps its title and note so the current work is readable in full", () => {
	const todos = state([["Run the focused tests, the typecheck and the full suite", "in_progress", "job-1 pnpm test in the worktree"], ["A pending task with a very long title that clips", "pending"]]);
	const rows = renderTodoSection(todos, plain, 30, { collapsed: false, staleTurns: 0 }).body.map((row) => stripAnsi(row).trimEnd());
	assert.deepEqual(rows, [
		"  ◐ Run the focused tests, the",
		"    typecheck and the full",
		"    suite",
		"    └ job-1 pnpm test in the",
		"      worktree",
		"  ○ A pending task with a ver…",
	]);
});

test("a collapsed Todos section keeps only the task in progress", () => {
	const todos = state([["Done", "done"], ["Current", "in_progress"], ["Next", "pending"]]);
	const section = renderTodoSection(todos, plain, 30, { collapsed: true, staleTurns: 0 });
	assert.match(stripAnsi(section.header), /^▸ TODOS/);
	assert.deepEqual(section.body.map((row) => stripAnsi(row).trimEnd()), ["  ◐ Current"]);
});

test("a stale Todos section says so in its count, in the warning role", () => {
	const section = renderTodoSection(state([["Current", "in_progress"]]), theme, 120, { collapsed: false, staleTurns: 3 });
	assert.match(section.header, /<warning>stale · 3 turns · 0\/1<\/warning>/);
	assert.deepEqual(renderTodoSection(state([]), plain, 40, { collapsed: false, staleTurns: 0 }), { header: "", body: [] });
});

test("the Jobs section lists each job with its id, label and elapsed time", () => {
	const jobs = [{ id: "job-1", label: "pnpm test", startedAt: 0 }, { id: "job-2", label: "pnpm build", startedAt: 0, status: "exited" as const, exitCode: 0, endedAt: 1_000 }];
	const shape = (row: string) => stripAnsi(row).trimEnd().replace(/(\S)\s{2,}/g, "$1 | ");
	const lines = renderJobsSection(jobs as never, plain, 40, 30_000, { collapsed: false });
	assert.deepEqual(lines.map(shape), ["▾ JOBS | 1 running · 1 finished", `  ${JOB_GLYPH} job-1 pnpm test | 30s`, "  ✓ job-2 pnpm build | 1s"]);
	for (const row of lines) assert.equal(visibleWidth(stripAnsi(row)), 40);
	assert.deepEqual(renderJobsSection([], plain, 40, 0, { collapsed: false }), []);
	const collapsed = renderJobsSection(jobs as never, plain, 40, 30_000, { collapsed: true }).map(shape);
	assert.deepEqual(collapsed, ["▸ JOBS | 1 running · 1 finished", `  ${JOB_GLYPH} job-1 pnpm test | 30s`, "  … 1 more"]);
	assert.match(stripAnsi(renderJobsSection(jobs as never, plain, 40, 123_000, { collapsed: false })[1]!), /2m 3s$/, "a running job keeps ticking past the finished TTL");
});
