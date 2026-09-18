import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TASK_STATUS, type TaskRecord } from "../lib/agents-protocol.ts";
import { formatElapsed, renderAgentsCard, widgetExpiryMs, widgetRows, widgetTasks } from "../lib/agents-widget.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// Gentle Agents widget: the card above the editor that shows what the
// subagents are doing, drawn from task records only (never from threads).
// Layout: glyph, agent, task summary (wrapped), then model · tokens · cost · time.

const plainTheme = { fg: (_color: string, text: string) => text };

function task(overrides: Partial<TaskRecord>): TaskRecord {
	return { id: "t", agent: "sdd-explore", mode: "task", prompt: "map footer data sources", label: "map footer data sources", cwd: "/r", parentSessionId: "s", status: TASK_STATUS.RUNNING, createdAt: 1000, startedAt: 1000, endedAt: null, model: "anthropic/claude-sonnet-5", thinking: undefined, sessionPath: null, error: null, result: null, lastStep: "grep", lastActivityAt: 1000, turns: 0, toolCalls: 0, tokens: 34_000, cost: 0.27, ...overrides };
}

test("formatElapsed renders seconds, minutes, and hours compactly", () => {
	assert.equal(formatElapsed(4_000), "4s");
	assert.equal(formatElapsed(65_000), "1m05s");
	assert.equal(formatElapsed(3_720_000), "1h02m");
	assert.equal(formatElapsed(-5), "0s");
});

test("widgetTasks keeps active tasks in start order and only recently finished ones", () => {
	const tasks = [
		task({ id: "old-done", status: TASK_STATUS.COMPLETED, endedAt: 10_000 }),
		task({ id: "new-done", status: TASK_STATUS.FAILED, endedAt: 95_000 }),
		task({ id: "queued", status: TASK_STATUS.QUEUED, createdAt: 3000, startedAt: null }),
		task({ id: "running", createdAt: 2000, startedAt: 2000 }),
	];
	assert.deepEqual(widgetTasks(tasks, 100_000).map((entry) => entry.id), ["new-done", "running", "queued"]);
	assert.deepEqual(widgetTasks([], 100_000), []);
});

test("widgetExpiryMs says how long until the next finished row leaves the card", () => {
	const running = task({ id: "running", createdAt: 2000, startedAt: 2000 });
	const done = task({ id: "done", status: TASK_STATUS.COMPLETED, endedAt: 95_000 });
	const later = task({ id: "later", status: TASK_STATUS.COMPLETED, endedAt: 99_000 });
	assert.equal(widgetExpiryMs([running, done, later], 100_000), 55_000, "the oldest shown row expires first");
	assert.equal(widgetExpiryMs([done], 155_000), undefined, "a row past its minute is already gone");
	assert.equal(widgetExpiryMs([running], 100_000), undefined, "active rows never expire");
	assert.equal(widgetExpiryMs([], 100_000), undefined);
});

test("renderAgentsCard draws columns for agent, task, and model · tokens · cost · time, with the batch time in the rule", () => {
	const tasks = [
		task({ id: "a", status: TASK_STATUS.COMPLETED, startedAt: 1000, endedAt: 26_000 }),
		task({ id: "b", agent: "sdd-apply", label: "write gentle-shell footer", startedAt: 44_000, tokens: 12_000, cost: 0.09 }),
	];
	const lines = renderAgentsCard(tasks, plainTheme, 84, 85_000, { collapsed: false });
	for (const line of lines) assert.equal(visibleWidth(line), 84, `"${stripAnsi(line)}" is not 84 wide`);
	const plain = lines.map(stripAnsi);
	assert.match(plain[0], /^╭─ ❀ Agents · 1 active · 1 done ─+ 1m24s ╮$/);
	assert.match(plain[1], /^│ ✓  sdd-explore  map footer data sources +claude-sonnet-5 · 34k · \$0\.27 · 25s │$/);
	assert.match(plain[2], /^│ ◐  sdd-apply    write gentle-shell footer +claude-sonnet-5 · 12k · \$0\.09 · 41s │$/);
	assert.match(plain[3], /^╰─+╯$/);
	assert.deepEqual(renderAgentsCard([], plainTheme, 60, 0, { collapsed: false }), []);
});

test("renderAgentsCard renders singleton elapsed time only on its task row", () => {
	const lines = renderAgentsCard([task({})], plainTheme, 84, 5_000, { collapsed: false }).map(stripAnsi);
	assert.equal(lines.join("\n").match(/4s/g)?.length, 1);
	assert.match(lines[1], /4s/);
});

test("renderAgentsCard keeps every task on one line, clipping long labels, and drops the task column when the card is narrow", () => {
	const tasks = [task({ id: "a", label: "write the gentle shell footer and all of its tests before lunch" })];
	const wide = renderAgentsCard(tasks, plainTheme, 84, 5_000, { collapsed: false }).map(stripAnsi);
	assert.equal(wide.length, 3);
	assert.match(wide[1], /^│ ◐  sdd-explore  write the gentle shell foot… +claude-sonnet-5 · 34k · \$0\.27 · 4s │$/);
	const narrow = renderAgentsCard(tasks, plainTheme, 44, 5_000, { collapsed: false }).map(stripAnsi);
	assert.equal(narrow.length, 3);
	assert.match(narrow[1], /^│ ◐  sdd-explore +claude-sonnet-5 +│$/);
});

test("renderAgentsCard shows questions and failures in place of the task, and collapses to the first row", () => {
	const tasks = [
		task({ id: "a", status: TASK_STATUS.WAITING, lastStep: "asked: Delete?", tokens: 0, cost: 0 }),
		task({ id: "b", status: TASK_STATUS.FAILED, endedAt: 2000, error: "pi exited with code 1", lastStep: "pi exited with code 1" }),
		task({ id: "c", status: TASK_STATUS.QUEUED, createdAt: 1500, startedAt: null, tokens: 0, cost: 0 }),
	];
	const plain = renderAgentsCard(tasks, plainTheme, 80, 3000, { collapsed: false }).map(stripAnsi);
	assert.match(plain[0], /^╭─ ❀ Agents · 1 waiting · 1 queued · 1 failed ─+ 2s ╮$/);
	assert.match(plain[1], /^│ \?  sdd-explore  asked: Delete\? +claude-sonnet-5 · 2s │$/);
	assert.match(plain[2], /^│ ✗  sdd-explore  pi exited with code 1 +claude-sonnet-5 · 34k · \$0\.27 · 1s │$/);
	assert.match(plain[3], /^│ ○  sdd-explore  map footer data sources +queued │$/);
	const collapsed = renderAgentsCard(tasks, plainTheme, 80, 3000, { collapsed: true, collapseKey: "ctrl+shift+a" }).map(stripAnsi);
	assert.equal(collapsed.length, 3);
	assert.match(collapsed[0], /ctrl\+shift\+a expand ╮$/);
	assert.match(collapsed[1], /^│ \?  sdd-explore  asked: Delete\?/);
});

test("agent model and effort outrank usage at sidebar widths without inventing unknown values", () => {
	for (const width of [32, 44, 60, 100]) {
		const lines = renderAgentsCard([task({ agent: "worker", model: "openai/gpt-5", thinking: "high" })], plainTheme, width, 5000, { collapsed: false });
		assert.equal(lines.length, 3);
		assert.match(lines[1], /worker/);
		assert.match(lines[1], /gpt-5 · high/);
		for (const line of lines) assert.equal(visibleWidth(line), width);
		if (width <= 44) assert.doesNotMatch(lines[1], /34k|\$0\.27|4s/);
	}
	for (const width of [0, 1, 2, 3, 4, 8, 16, 24]) {
		const lines = renderAgentsCard([task({ agent: "界worker", thinking: "xhigh" })], plainTheme, width, 5000, { collapsed: false });
		assert.ok(lines.length <= 4, "narrow metadata gets at most one dedicated row");
		for (const line of lines) assert.equal(visibleWidth(line), width);
	}
	const sidebar = renderAgentsCard([task({ agent: "gentle-ai-worker", model: "openai/gpt-5.6", thinking: "high" })], plainTheme, 32, 5000, { collapsed: false });
	assert.match(sidebar.join("\n"), /gentle-ai-worker/);
	assert.match(sidebar.join("\n"), /gpt-5\.6 · high/);
	for (const line of sidebar) assert.equal(visibleWidth(line), 32);
	const unknown = renderAgentsCard([task({ model: "default", thinking: undefined })], plainTheme, 80, 5000, { collapsed: false }).join("\n");
	assert.doesNotMatch(unknown, /default|undefined|high|off/);
	const off = renderAgentsCard([task({ thinking: "off" })], plainTheme, 80, 5000, { collapsed: false }).join("\n");
	assert.match(off, /claude-sonnet-5 · off/);
});

test("widgetRows caps the card at a quarter of the terminal, between three and eight rows", () => {
	assert.equal(widgetRows(40), 8, "tall terminals still stop at eight rows");
	assert.equal(widgetRows(24), 6);
	assert.equal(widgetRows(10), 3, "short terminals keep three rows");
	assert.equal(widgetRows(undefined), 8, "without a terminal the widest default applies");
});

test("renderAgentsCard caps the rows at maxRows, keeps active tasks ahead of finished ones, and says how many are hidden", () => {
	const tasks = [
		task({ id: "done", status: TASK_STATUS.COMPLETED, startedAt: 500, endedAt: 2000 }),
		...Array.from({ length: 6 }, (_, index) => task({ id: `run${index}`, label: `job ${index}`, createdAt: 1000 + index, startedAt: 1000 + index })),
	];
	const plain = renderAgentsCard(tasks, plainTheme, 80, 5000, { collapsed: false, maxRows: 4, viewKey: "alt+a" }).map(stripAnsi);
	assert.equal(plain.length, 6, "frame plus four rows");
	assert.match(plain[0], /6 active · 1 done/, "the title still counts every shown task");
	assert.match(plain[1], /◐  sdd-explore  job 0/);
	assert.match(plain[3], /◐  sdd-explore  job 2/);
	assert.match(plain[4], /^│ … 4 more · alt\+a to view +│$/, "the finished row gives way to running ones");
	assert.equal(renderAgentsCard(tasks, plainTheme, 80, 5000, { collapsed: false }).length, 9, "without a cap every row shows");
	assert.equal(renderAgentsCard(tasks, plainTheme, 80, 5000, { collapsed: false, maxRows: 7 }).length, 9, "at the cap no row is hidden");
	assert.match(renderAgentsCard(tasks, plainTheme, 80, 5000, { collapsed: false, maxRows: 4 }).map(stripAnsi)[4], /^│ … 4 more +│$/, "no view key, no hint");
	const waiting = [...tasks, task({ id: "ask", status: TASK_STATUS.WAITING, lastStep: "asked: Delete?", createdAt: 4000, startedAt: 4000 })];
	assert.match(renderAgentsCard(waiting, plainTheme, 80, 5000, { collapsed: false, maxRows: 2 }).map(stripAnsi)[1], /^│ \?  sdd-explore  asked: Delete\?/, "a question is never hidden");
});
