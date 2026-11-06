import assert from "node:assert/strict";
import test from "node:test";
import { type TuiMouseEvent } from "@earendil-works/pi-tui";
import { TASK_STATUS, TaskStore, type TaskRecord } from "../lib/agents-protocol.ts";
import { AgentsView } from "../lib/agents-view.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

const plainTheme = { fg: (_color: string, text: string) => text };

function task(id: string, parentSessionId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		id,
		agent: "worker",
		mode: "task",
		prompt: "p",
		label: "p",
		cwd: "/r",
		parentSessionId,
		status: TASK_STATUS.RUNNING,
		createdAt: 1000,
		startedAt: 1000,
		endedAt: null,
		model: "gpt",
		thinking: undefined,
		sessionPath: "/sessions/child.jsonl",
		error: null,
		result: null,
		lastStep: "working",
		lastActivityAt: 1000,
		turns: 0,
		toolCalls: 0,
		tokens: 0,
		cost: 0,
		...overrides,
	};
}

function harness(rows = 12, now = () => 10_000) {
	const store = new TaskStore();
	const view = new AgentsView({
		theme: plainTheme,
		rows,
		store,
		sessionId: "current-session-id",
		now,
		onCancel: () => {},
		onOpen: () => {},
		onClose: () => {},
		requestRender: () => {},
	});
	return { store, view };
}

function mouse(x: number, y: number, width: number, height: number, type: TuiMouseEvent["type"] = "move"): TuiMouseEvent {
	return { type, button: type === "move" ? "none" : "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false };
}

test("AgentsView shows direct current children and groups only open orchestrators in the directory", () => {
	const { store, view } = harness();
	store.add(task("current", "current-session-id", { agent: "current-worker" }));
	store.add(task("other", "other-session-123456", { agent: "other-worker" }));

	const plain = view.render(100).map(stripAnsi).join("\n");
	assert.doesNotMatch(plain, /Current orchestrator/);
	assert.match(plain, /Subagent current-worker/);
	assert.doesNotMatch(plain, /other-worker/, "the default scope excludes another parent session");
	view.handleInput("a");
	assert.doesNotMatch(view.render(100).map(stripAnsi).join("\n"), /Orchestrator other-se/);
	assert.match(view.render(100).join("\n"), /Current orchestrator/);
	view.dispose();
});

test("AgentsView never infers unknown open sessions and keeps manual directory expansion", () => {
	const { store, view } = harness();
	store.add(task("current", "current-session-id", { lastActivityAt: 500 }));
	store.add(task("other", "other-session-123456", { lastActivityAt: 400 }));
	store.add(task("unknown-active", "", { agent: "unknown-active", lastActivityAt: 300 }));
	store.add(task("unknown-terminal", "", { agent: "unknown-terminal", status: TASK_STATUS.COMPLETED, endedAt: 9000, lastActivityAt: 200 }));
	view.handleInput("a");

	let lines = view.render(100);
	let plain = lines.map(stripAnsi).join("\n");
	assert.doesNotMatch(plain, /Unknown session|unknown-active|other-worker/, "retained origins are not presence evidence");
	assert.doesNotMatch(plain, /unknown-terminal/, "a terminal-only group starts collapsed");
	const terminalHeading = lines.map(stripAnsi).findIndex((line) => /Current orchestrator/.test(line));
	assert.equal(view.handleMouse(mouse(4, terminalHeading, 100, lines.length, "click"))?.handled, true, "left click toggles a heading");
	assert.doesNotMatch(view.render(100).map(stripAnsi).join("\n"), /Subagent worker/, "click collapses the local directory group");
	store.update("unknown-terminal", { status: TASK_STATUS.FAILED });
	assert.doesNotMatch(view.render(100).map(stripAnsi).join("\n"), /Subagent worker/, "manual collapse persists across unrelated updates");
	view.handleMouse(mouse(4, terminalHeading, 100, lines.length, "click"));
	store.update("unknown-terminal", { status: TASK_STATUS.CANCELLED });
	assert.match(view.render(100).map(stripAnsi).join("\n"), /Subagent worker/, "manual expansion persists across unrelated updates");
	assert.doesNotMatch(view.render(100).join("\n"), /unknown-termina/, "unknown terminal history remains excluded");
	view.dispose();
});

test("AgentsView keeps headings non-actionable and clears a hidden selected child thread", () => {
	const { store, view } = harness();
	store.add(task("first", "current-session-id", { createdAt: 2000, lastActivityAt: 200 }));
	store.add(task("child", "current-session-id", { lastActivityAt: 100 }));
	assert.equal(view.selectedTask()?.id, "first", "the first visible child starts selected");
	view.handleInput("a");
	view.handleInput("k");
	view.handleInput("\x1b[D");
	assert.equal(view.selectedTask(), undefined, "collapsing selects the heading instead of a hidden child");
	assert.match(view.render(100).map(stripAnsi).join("\n"), /Select a task to inspect its thread/);
	view.handleInput("\x1b[C");
	assert.equal(view.selectedTask(), undefined, "expanding preserves heading focus until a child is selected");
	view.handleInput("s");
	view.handleInput("o");
	view.dispose();
});

test("AgentsView keeps finished children listed as history instead of dropping them", () => {
	let now = 10_000;
	const { store, view } = harness(12, () => now);
	store.add(task("live", "current-session-id", { agent: "retained" }));
	store.add(task("other", "other-session", { agent: "excluded" }));
	store.apply("live", { type: "text", text: "kept thread" }, now);
	store.update("live", { status: TASK_STATUS.COMPLETED, endedAt: now });
	now += 60_000;
	const output = view.render(100).map(stripAnsi).join("\n");
	assert.match(output, /Subagent retained/, "a finished task of this session stays listed, long after it ended");
	assert.equal(store.thread("live").items.length, 1, "its retained thread remains available");
	assert.doesNotMatch(output, /excluded/, "another session's task never shows");
	now += 60_000;
	store.add(task("archive", "current-session-id", { agent: "archived", status: TASK_STATUS.COMPLETED, endedAt: now }));
	assert.match(view.render(100).join("\n"), /Subagent archived/, "a later finished task joins the history too");
	view.dispose();
});

test("AgentsView keeps an explicit collapse across a finish, and reveals the finished child as history on re-expand", () => {
	const { store, view } = harness();
	store.add(task("live", "current-session-id", { agent: "hidden" }));
	view.handleInput("a");
	view.render(100);
	view.handleInput("k");
	view.handleInput("\x1b[D");
	store.update("live", { status: TASK_STATUS.COMPLETED, endedAt: 10_000 });
	assert.doesNotMatch(view.render(100).join("\n"), /Subagent hidden/, "an explicit collapse persists across the child finishing");
	view.handleInput("\x1b[C");
	const revealed = view.render(100).join("\n");
	assert.match(revealed, /Subagent hidden/, "re-expanding reveals the finished child as history, not nothing");
	assert.match(revealed, /Current orchestrator · 1 Su/, "the group's own count now includes the finished child");
	assert.match(revealed, /0 active · 1 finished/, "the panel header reflects the finished child too");
	store.add(task("replacement", "current-session-id", { agent: "replacement" }));
	assert.match(view.render(100).join("\n"), /Subagent replacement/);
	view.dispose();
});

test("AgentsView orders children by creation then ID, not renewed activity", () => {
	const { store, view } = harness();
	store.add(task("old", "current-session-id", { agent: "old", createdAt: 100 }));
	store.add(task("b", "current-session-id", { agent: "new-b", createdAt: 200 }));
	store.add(task("a", "current-session-id", { agent: "new-a", createdAt: 200 }));
	store.update("old", { lastActivityAt: 20_000 });
	const output = view.render(100).join("\n");
	assert.ok(output.indexOf("Subagent new-a") < output.indexOf("Subagent new-b"));
	assert.ok(output.indexOf("Subagent new-b") < output.indexOf("Subagent old"));
	assert.equal(view.selectedTask()?.id, "old", "reordering preserves selection");
	view.dispose();
});

test("AgentsView keeps its selected listener stable while another listener receives a stream update", () => {
	const { store, view } = harness();
	store.add(task("stream", "current-session-id"));
	let notifications = 0;
	const unsubscribe = store.subscribe("stream", () => {
		notifications += 1;
		if (notifications > 1) throw new Error("selected listener was re-added during notification");
	});
	store.apply("stream", { type: "text", text: "one" }, 2000);
	assert.equal(notifications, 1, "a live listener set never revisits the same streaming update");
	unsubscribe();
	view.dispose();
});

// A1 (odd/tasks/usage-click-and-changes-attribution.md): finished subagents
// stay listed as history instead of vanishing, ordered active first and then
// newest-ended-first, with the panel header reading "N active . M finished",
// and never cancellable or reorderable by later activity.

test("AgentsView lists active children before finished ones, newest ended first", () => {
	const { store, view } = harness();
	store.add(task("old-finished", "current-session-id", { agent: "old-finished", status: TASK_STATUS.COMPLETED, endedAt: 1000, createdAt: 100 }));
	store.add(task("new-finished", "current-session-id", { agent: "new-finished", status: TASK_STATUS.FAILED, endedAt: 3000, createdAt: 100 }));
	store.add(task("active", "current-session-id", { agent: "active-one", createdAt: 50 }));
	const output = view.render(100).join("\n");
	const activeIndex = output.indexOf("Subagent active-one");
	const newFinishedIndex = output.indexOf("Subagent new-finished");
	const oldFinishedIndex = output.indexOf("Subagent old-finished");
	assert.ok(activeIndex >= 0 && newFinishedIndex >= 0 && oldFinishedIndex >= 0, "every task is listed");
	assert.ok(activeIndex < newFinishedIndex, "active tasks list before finished ones");
	assert.ok(newFinishedIndex < oldFinishedIndex, "finished tasks order newest ended first, regardless of creation order");
	view.dispose();
});

test("the panel header counts active and finished separately", () => {
	const { store, view } = harness();
	store.add(task("active-1", "current-session-id", { agent: "active-1" }));
	store.add(task("done-1", "current-session-id", { agent: "done-1", status: TASK_STATUS.COMPLETED, endedAt: 1000 }));
	store.add(task("done-2", "current-session-id", { agent: "done-2", status: TASK_STATUS.FAILED, endedAt: 2000 }));
	assert.match(view.render(100).join("\n"), /❀ Agents · this session · 1 active · 2 finished/);
	view.dispose();
});

test("a finished task's row offers no stop control and ignores the stop key", () => {
	const { store, view } = harness();
	store.add(task("done", "current-session-id", { agent: "done", status: TASK_STATUS.COMPLETED, endedAt: 1000 }));
	let cancelled: string | undefined;
	view.dispose();
	const cancelView = new AgentsView({
		theme: plainTheme,
		rows: 12,
		store,
		sessionId: "current-session-id",
		now: () => 10_000,
		onCancel: (task) => { cancelled = task.id; },
		onOpen: () => {},
		onClose: () => {},
		requestRender: () => {},
	});
	assert.doesNotMatch(cancelView.render(100).join("\n"), /Stop selected/, "the footer never offers to stop a finished task");
	cancelView.handleInput("s");
	assert.equal(cancelled, undefined, "the stop key is a no-op on a finished task's row");
	cancelView.dispose();
});

test("history retention caps finished tasks at 200 per session", () => {
	const { store, view } = harness();
	for (let i = 0; i < 202; i += 1) {
		store.add(task(`f${i}`, "current-session-id", { agent: `f${i}`, status: TASK_STATUS.COMPLETED, endedAt: i, createdAt: i }));
	}
	assert.match(view.render(100).join("\n"), /0 active · 200 finished/, "the oldest finished tasks beyond the cap are dropped");
	view.dispose();
});
