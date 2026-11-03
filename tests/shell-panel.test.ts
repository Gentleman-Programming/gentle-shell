import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { paintPanelSurface, PANEL_SURFACE_ROLE, panelSheetBackHit, renderPanelHeader, renderPanelRow, renderPanelSheet, renderWorkRow } from "../lib/shell-panel.ts";
import { renderTodoSection, todoWorkSummary, type TodoState } from "../lib/shell-todo.ts";
import { renderJobsSection } from "../lib/jobs-widget.ts";
import { JOB_GLYPH } from "../lib/background-jobs-tools.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { renderShellSidebarBar, renderShellStatusBar, renderShellStatusSections, renderShellTitleRow } from "../lib/shell-bar.ts";

// The fullscreen rail draws its sections as one panel (design/shell-rework/02-proposal.html):
// a one-row header `▾ NAME … count` and dense rows, no card chrome.

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `*${text}*`,
	strikethrough: (text: string) => `~${text}~`,
};
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text };

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

/** `left` and `right` on one row of `width` columns, the way a panel row aligns them. */
const edge = (left: string, right: string, width: number) => left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;

test("the rail Status draws Changes, Review and Integrations as panel sections and never repeats the header", () => {
	const model = {
		cwd: "/project", branch: "main", dirty: 2, sessionName: "session", profile: "claude (session)",
		modelId: "model", effort: "high", contextPercent: 45, contextWindow: 1000,
		costTotal: 1, subscription: false, usage: undefined,
		changes: { files: 22, added: 802, deleted: 352 },
		review: { state: "consent" as const, scope: "app.ts +2 files" },
		statuses: ["🧠 gentle-pi · ready", "💥 SUPER YOLO ON — no permission prompts; private paths stay blocked"],
	};
	const lines = renderShellSidebarBar(model, plain as never, 48, { density: "comfortable", visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true } }, "ctrl+shift+t todos · alt+u usage");
	for (const line of lines) assert.equal(visibleWidth(line), 48, `row fills the rail: ${line}`);
	const rows = lines.map((line) => line.trimEnd());
	assert.deepEqual(rows, [
		edge("▾ CHANGES", "22 files", 48),
		edge("  +802 −352", "/gentle:changes", 48),
		"",
		edge("▾ REVIEW", "needs you", 48),
		"  Needs your consent",
		"  app.ts +2 files",
		"",
		edge("▾ INTEGRATIONS", "2", 48),
		"  🧠 gentle-pi · ready",
		"  💥 SUPER YOLO ON — no permission prompts;",
		"  private paths stay blocked",
		"",
		"  ctrl+shift+t todos · alt+u usage",
	]);
	assert.doesNotMatch(rows.join("\n"), /project|Branch|Profile|session/, "location and profile live in the header, once");
});

test("the rail Status keeps an empty Changes row, hides Review without evidence and honors its toggles", () => {
	const base = { cwd: "/p", branch: null, dirty: undefined, sessionName: undefined, modelId: "m", effort: undefined, contextPercent: null, contextWindow: 0, costTotal: 0, subscription: false, usage: undefined, statuses: [] };
	const visibility = { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true };
	const rows = renderShellSidebarBar(base, plain as never, 40, { density: "compact", visibility }).map((line) => line.trimEnd());
	assert.deepEqual(rows, [edge("▾ CHANGES", "clean", 40), edge("  no captured changes", "/gentle:changes", 40), edge("▾ INTEGRATIONS", "none", 40), "  no status reported"]);
	const hidden = renderShellSidebarBar(base, plain as never, 40, { density: "compact", visibility: { ...visibility, changes: false } }).map((line) => line.trimEnd());
	assert.doesNotMatch(hidden.join("\n"), /CHANGES/);
});

// The wide fullscreen chrome (design/shell-rework/02-proposal.html): a title row
// with the project identity above, one status bar row below.
const chromeModel = {
	cwd: "~/work/gentle-pi", branch: "feat/shell-ide-rework", dirty: 3, sessionName: "fleet adopt", profile: "claude (session)",
	modelId: "claude-opus-5-5", effort: "high", contextPercent: 27, contextWindow: 1000,
	costTotal: 0, subscription: false, usage: undefined,
	permission: { mode: "SUPER-YOLO", detail: "no permission prompts; private paths stay blocked" },
	statuses: ["Permissions: SUPER-YOLO", "💥 SUPER YOLO ON — no permission prompts; private paths stay blocked", "🧠 gentle-pi · ready"],
	integrations: ["🧠 gentle-pi · ready"],
};

test("the title row names the project once and always keeps the session and profile", () => {
	const row = stripAnsi(renderShellTitleRow(chromeModel, plain as never, 90));
	assert.equal(visibleWidth(row), 90);
	assert.match(row, /^ ✿ gentle-pi  ~\/work\/gentle-pi +fleet adopt · claude \(session\) $/);
	const narrow = stripAnsi(renderShellTitleRow(chromeModel, plain as never, 44));
	assert.equal(visibleWidth(narrow), 44);
	assert.match(narrow, /fleet adopt · claude \(session\) $/, "the path gives way before the profile");
	assert.doesNotMatch(stripAnsi(renderShellTitleRow({ ...chromeModel, sessionName: undefined, profile: undefined }, plain as never, 90)), /·/);
});

test("the status bar shows branch, permission mode, model, context, cost and usage in one row", () => {
	const chrome = renderShellStatusBar(chromeModel, plain as never, 120, "alt+u");
	assert.equal(chrome.rows.length, 1);
	const row = stripAnsi(chrome.rows[0]!);
	assert.equal(visibleWidth(row), 120);
	assert.match(row, /^ feat\/shell-ide-rework ±3 │ SUPER-YOLO +claude-opus-5-5 · high │ ctx [▰▱]+ 27% │ \$0\.000 │ usage · alt\+u $/);
	assert.equal((row.match(/SUPER-YOLO/g) ?? []).length, 1, "the permission mode appears once");
	assert.ok(chrome.usageSpan && row.slice(chrome.usageSpan.start, chrome.usageSpan.end).startsWith("usage"), "the usage segment is the click target");
	const normal = stripAnsi(renderShellStatusBar({ ...chromeModel, permission: { mode: "NORMAL" } }, plain as never, 120, "alt+u").rows[0]!);
	assert.doesNotMatch(normal, /NORMAL/, "the default permission mode stays quiet");
});

test("a narrow status bar drops usage before the model and keeps the branch", () => {
	const row = stripAnsi(renderShellStatusBar(chromeModel, plain as never, 95, "alt+u").rows[0]!);
	assert.equal(visibleWidth(row), 95);
	assert.match(row, /feat\/shell-ide-rework/);
	assert.match(row, /claude-opus-5-5/);
	assert.doesNotMatch(row, /usage/, "usage gives way first");
	const tighter = stripAnsi(renderShellStatusBar(chromeModel, plain as never, 70, "alt+u").rows[0]!);
	assert.equal(visibleWidth(tighter), 70);
	assert.doesNotMatch(tighter, /claude-opus/, "then the model");
	assert.match(tighter, /feat\/shell-ide-rework ±3 │ SUPER-YOLO +ctx [▰▱]+ 27% │ \$0\.000 $/, "branch, mode, context and cost stay");
	const hidden = stripAnsi(renderShellStatusBar(chromeModel, plain as never, 120, "alt+u", { density: "comfortable", visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: false, modelDetails: false, contextWarning: true } }).rows[0]!);
	assert.doesNotMatch(hidden, /claude-opus|ctx|\$0\.000|usage/, "the visibility toggles hide model, context, cost and usage");
});

test("Integrations explains the permission mode without repeating it", () => {
	const rows = renderShellSidebarBar(chromeModel, plain as never, 48).map((line) => line.trimEnd());
	const at = rows.findIndex((row) => row.startsWith("▾ INTEGRATIONS"));
	assert.deepEqual(rows.slice(at + 1), ["  permissions no permission prompts; private", "  paths stay blocked", "  🧠 gentle-pi · ready"]);
	assert.doesNotMatch(rows.join("\n"), /SUPER-YOLO|SUPER YOLO/);
});

// Mobile (design/shell-rework/05-mobile.html, 07-many-agents-mobile.html): below
// the rail breakpoint live work folds into one row above the editor, and
// /gentle:panel opens the rail's sections as a full-width sheet.
test("the work row shows the current todo, or the agents while they run, with the todo count", () => {
	const todo = todoWorkSummary(state([["Done", "done"], ["Run the full suite", "in_progress"], ["Next", "pending"]]), plain);
	assert.deepEqual(todo, { left: "◐ Run the full suite", right: "1/3", rightLabel: "todos" });
	assert.equal(todoWorkSummary(state([]), plain), undefined);
	const row = stripAnsi(renderWorkRow([todo!], plain, 40)!);
	assert.equal(visibleWidth(row), 40);
	assert.match(row, /^ ▸ ◐ Run the full suite +1\/3 $/);
	const withAgents = stripAnsi(renderWorkRow([todo!, { left: "◐ 3 agents · ? 1 waiting", priority: 1 }], plain, 56)!);
	assert.match(withAgents, /^ ▸ ◐ 3 agents · \? 1 waiting +1\/3 todos $/, "agents lead while they run; the todo count stays");
	assert.equal(renderWorkRow([], plain, 40), undefined);
});

test("the panel sheet stacks the rail sections under a title row and scrolls within its rows", () => {
	const parts = new Map<string, { render(width: number): string[]; invalidate(): void }>([
		["todo", { render: (width: number) => ["▾ TODOS".padEnd(width), "  ○ one".padEnd(width)], invalidate() {} }],
		["agents", { render: (width: number) => ["▾ AGENTS".padEnd(width)], invalidate() {} }],
		["footer", { render: (width: number) => ["▾ CHANGES".padEnd(width), "  clean".padEnd(width)], invalidate() {} }],
	]);
	const sheet = renderPanelSheet(parts as never, plain, 30, { rows: 20, scrollTop: 0 });
	const rows = sheet.lines.map((line) => stripAnsi(line).trimEnd());
	assert.deepEqual(rows, [edge(" ✿ Panel", "esc back ", 30).trimEnd(), "", " ▾ TODOS", "   ○ one", "", " ▾ AGENTS", "", " ▾ CHANGES", "   clean"]);
	for (const line of sheet.lines) assert.equal(visibleWidth(stripAnsi(line)), 30);
	const clipped = renderPanelSheet(parts as never, plain, 30, { rows: 5, scrollTop: 2 });
	assert.equal(clipped.lines.length, 5, "title row plus four content rows");
	assert.match(stripAnsi(clipped.lines[1]!), /○ one/, "the content scrolls under the fixed title row");
	assert.equal(clipped.maxScroll, 4, "eight content rows in a four-row viewport");
	assert.match(stripAnsi(clipped.lines.at(-1)!), /↓ 3 more · scroll/);
	const end = renderPanelSheet(parts as never, plain, 30, { rows: 5, scrollTop: 4 }).lines.map((line) => stripAnsi(line).trimEnd());
	assert.deepEqual(end.slice(1), [" ▾ AGENTS", "", " ▾ CHANGES", "   clean"], "the last page shows the last rows without a more row");
});

test("the mobile title row carries the model, since the narrow status bar leaves it out", () => {
	const row = stripAnsi(renderShellTitleRow(chromeModel, plain as never, 56, { model: true }));
	assert.equal(visibleWidth(row), 56);
	assert.match(row, /^ ✿ gentle-pi .*claude-opus-5-5 · high $/);
});

test("a long branch gives way before the context and cost in a phone-width status bar", () => {
	const longBranch = { ...chromeModel, branch: "feat/shell-ide-rework-07-mobile", dirty: undefined };
	const narrowSettings = { density: "comfortable" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: false, contextWarning: true } };
	const row = stripAnsi(renderShellStatusBar(longBranch, plain as never, 56, "alt+u", narrowSettings).rows[0]!);
	assert.equal(visibleWidth(row), 56);
	assert.match(row, /ctx [▰▱]+ 27% │ \$0\.000 $/, "context and cost stay");
	assert.match(row, /^ feat\/shell-\S*… │ SUPER-YOLO /, "the branch is clipped and the permission mode stays");
});

test("the rail Status sections are click targets: headers collapse them and the Changes row opens /gentle:changes", () => {
	const model = { ...chromeModel, changes: { files: 2, added: 7, deleted: 3 }, review: undefined };
	const open = renderShellStatusSections(model, plain as never, 48, undefined, undefined, {});
	const at = (pattern: RegExp) => open.lines.findIndex((line) => pattern.test(stripAnsi(line)));
	assert.deepEqual(open.targets, [
		{ row: at(/^▾ CHANGES/), kind: "toggle", section: "changes" },
		{ row: at(/\+7 −3/), kind: "open-changes" },
		{ row: at(/^▾ INTEGRATIONS/), kind: "toggle", section: "integrations" },
	]);
	const collapsed = renderShellStatusSections(model, plain as never, 48, undefined, undefined, { collapsed: new Set(["integrations"]) }).lines.map((line) => stripAnsi(line).trimEnd());
	assert.ok(collapsed.some((line) => /^▸ INTEGRATIONS/.test(line)), "a collapsed section keeps its header with ▸");
	assert.ok(!collapsed.some((line) => /gentle-pi · ready/.test(line)), "and hides its rows");
	const hovered = renderShellStatusSections(model, theme as never, 120, undefined, undefined, { hovered: "changes" }).lines.join("\n");
	assert.match(hovered, /<warning>▾<\/warning> <text>\*CHANGES\*<\/text>/, "a hovered header paints the shared hover role");
	const hoveredOpen = renderShellStatusSections(model, theme as never, 120, undefined, undefined, { hovered: "open-changes" }).lines.join("\n");
	assert.match(hoveredOpen, /<warning>\/gentle:changes<\/warning>/, "a hovered Changes row paints its command in the hover role");
	assert.deepEqual(renderShellSidebarBar(model, plain as never, 48), open.lines, "renderShellSidebarBar stays the lines of the same render");
});

test("the work row and the sheet's esc back show they are clickable", () => {
	const hovered = renderWorkRow([{ left: "◐ Run the suite", right: "1/3" }], theme as never, 80, true)!;
	assert.match(hovered, /<warning>▸<\/warning>/, "a hovered work row paints its affordance in the hover role");
	assert.doesNotMatch(renderWorkRow([{ left: "◐ Run the suite", right: "1/3" }], theme as never, 80)!, /<warning>/);
	const parts = new Map([["todo", { render: (width: number) => ["▾ TODOS".padEnd(width)] }]]);
	assert.match(renderPanelSheet(parts as never, theme as never, 80, { rows: 10, scrollTop: 0, backHovered: true }).lines[0]!, /<warning>esc back<\/warning>/);
	assert.equal(panelSheetBackHit(30, 25, 0), true, "a click on esc back closes the sheet");
	assert.equal(panelSheetBackHit(30, 5, 0), false);
	assert.equal(panelSheetBackHit(30, 25, 1), false, "only the title row carries the control");
});
