import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { TASK_EVENT, TASK_STATUS, TaskStore, type TaskRecord } from "../lib/agents-protocol.ts";
import { AgentsView } from "../lib/agents-view.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

const plainTheme = { fg: (_color: string, text: string) => text };

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
	return { id, agent: id, mode: "task", prompt: "p", label: "p", cwd: "/r", parentSessionId: "session", status: TASK_STATUS.RUNNING, createdAt: 1000, startedAt: 1000, endedAt: null, model: "model", thinking: undefined, sessionPath: "/sessions/task.jsonl", error: null, result: null, lastStep: "working", lastActivityAt: 1000, turns: 0, toolCalls: 0, tokens: 0, cost: 0, ...overrides };
}

function mouse(x: number, y: number, width: number, height: number, type: TuiMouseEvent["type"] = "click"): TuiMouseEvent {
	return { type, button: type === "move" || type === "wheel" ? "none" : "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false };
}

test("AgentsView integrates flat current-session selection, semantic scrolling, live geometry, and idempotent close", () => {
	const store = new TaskStore();
	let rows = 8;
	const closes: string[] = [];
	const view = new AgentsView({
		theme: plainTheme,
		rows: () => rows,
		store,
		sessionId: "session",
		now: () => 61_000,
		onCancel() {},
		onOpen() {},
		onClose: () => closes.push("close"),
		requestRender() {},
	});
	store.add(task("first"));
	store.add(task("second"));
	for (let index = 0; index < 12; index += 1) store.apply("first", { type: TASK_EVENT.TEXT, text: `semantic line ${index}\n` }, 2000);

	const wide = 80;
	let frame = view.render(wide);
	const header = stripAnsi(frame[0] ?? "");
	assert.equal(visibleWidth(header), wide);
	assert.match(header, /\[× Close\]/, "a pane-capable header exposes the wide close control");
	const closeX = visibleWidth(header.slice(0, header.indexOf("[× Close]")));

	view.handleInput("k");
	view.handleInput("\x1b[D");
	assert.equal(view.selectedTask()?.id, "first", "up and left keep the first task selected without a group heading");
	rows = 6;
	assert.equal(view.handleMouse(mouse(closeX, 0, wide, frame.length)), undefined, "old close bounds are inert before the live resize frame");
	frame = view.render(wide);
	assert.equal(frame.length, rows, "the next frame uses the live height budget");
	assert.doesNotMatch(frame.map(stripAnsi).join("\n"), /Current orchestrator|Select a task to inspect its thread/, "current-session tasks stay flat with an active detail pane");
	assert.match(frame.map(stripAnsi).join("\n"), /semantic line 11/, "the selected task still follows its thread after resizing");

	view.handleInput("\x1b[C");
	assert.equal(view.selectedTask()?.id, "first", "right does not expand a heading in the flat list");
	view.handleInput("j");
	assert.equal(view.selectedTask()?.id, "second", "down selects the next task directly");
	view.handleInput("k");
	assert.equal(view.selectedTask()?.id, "first", "up returns directly to the first task");
	view.render(wide);
	view.handleInput("\x1b[5~");
	frame = view.render(wide);
	assert.doesNotMatch(frame.map(stripAnsi).join("\n"), /semantic line 11/, "manual thread scrolling remains off the tail after resizing");
	const narrow = view.render(59).map(stripAnsi);
	assert.equal(narrow.length, rows, "width 59 keeps a narrow single viewport");
	assert.match(narrow[0] ?? "", /\[×\]/, "narrow mode keeps only the compact close control");
	view.handleInput("\t");
	const details = view.render(59).map(stripAnsi);
	assert.match(details[0] ?? "", /\[← Back\]/, "Tab opens selected-task details directly from the flat list");
	assert.match(details.join("\n"), /first · running/, "details belong to the selected task");
	view.handleInput("\t");
	assert.equal(view.selectedTask()?.id, "first", "returning from details preserves task selection");
	rows = 2;
	const fallback = view.render(59).map(stripAnsi);
	assert.equal(fallback.length, 1, "a two-row terminal uses the one-line fallback");
	assert.match(fallback[0] ?? "", /^× Close/, "fallback mode keeps a single Close cell");
	assert.equal(view.handleMouse(mouse(1, 0, 59, fallback.length)), undefined, "fallback routing outside the Close cell is inert");

	rows = 6;
	frame = view.render(wide);
	const reopenedHeader = stripAnsi(frame[0] ?? "");
	const reopenedCloseX = visibleWidth(reopenedHeader.slice(0, reopenedHeader.indexOf("[× Close]")));
	let notifications = 0;
	const unsubscribe = store.subscribe("first", () => {
		notifications += 1;
		if (notifications > 1) throw new Error("the selected listener was rebound during a live update");
	});
	store.apply("first", { type: TASK_EVENT.TEXT, text: "after reopen" }, 2000);
	assert.equal(notifications, 1, "reopening panes retains an idempotent selected-task subscription");
	assert.equal(view.handleMouse(mouse(reopenedCloseX, 0, wide, frame.length)), undefined, "a task update invalidates the old close bounds");
	frame = view.render(wide);
	const currentHeader = stripAnsi(frame[0] ?? "");
	const currentCloseX = visibleWidth(currentHeader.slice(0, currentHeader.indexOf("[× Close]")));
	unsubscribe();
	assert.equal(view.handleMouse(mouse(currentCloseX, 0, wide, frame.length))?.handled, true);
	view.handleInput("\x1b");
	view.handleInput("q");
	assert.deepEqual(closes, ["close"], "pointer, Escape, and q share the same idempotent close action");
	view.dispose();
});
