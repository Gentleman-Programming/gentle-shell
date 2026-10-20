import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { WorksView, observeActivity } from "../lib/gentle-works-view.ts";
import type { Work } from "../lib/gentle-works.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
const work: Work = { id: "work", cloneIdentity: "clone", revision: 1, title: "Title\x1b[2J\x07", objective: "完整 objective", summary: "summary", status: "completed", session: { id: "session", file: "/session" }, worktree: "/gone", odd: "odd/task.md" };
test("S2: activity requires exact current locator, never changes work status", () => {
	const before = structuredClone(work);
	assert.equal(observeActivity(work, work.session, true).state, "waiting");
	assert.equal(observeActivity(work, work.session, false).state, "running");
	assert.ok(observeActivity(work, work.session, true).observedAt);
	for (const current of [undefined, { id: "other", file: "/session" }, { id: "session", file: "/other" }]) {
		assert.deepEqual(observeActivity(work, current, false), { state: "unknown" });
	}
	assert.deepEqual(work, before);
});
test("S3: list keyboard selects create/inspect; escape is a no-op result", () => {
	const results: unknown[] = [];
	const view = new WorksView([work], result => results.push(result));
	assert.match(view.render(80).join("\n"), /completed/);
	assert.match(view.render(80).join("\n"), /\/gone/);
	view.handleInput("\x1b[B"); view.handleInput("\r");
	assert.deepEqual(results, [{ action: "inspect", id: "work" }]);
	const closed: unknown[] = [];
	const close = new WorksView([], result => closed.push(result)); close.handleInput("\x1b");
	assert.deepEqual(closed, [{ action: "close" }]);
});
test("S3,S5: detail screen exposes locator and full scrollable content; narrow safe render", () => {
	const results: unknown[] = [];
	const view = new WorksView([work], result => results.push(result), undefined, work,
		["Activity: unknown", "Worktree: missing", "Session file: missing", "Objective: " + "long ".repeat(100), "END objective", "Session ID: session", "Session file: /session"]);
	for (const width of [0, 1, 4, 12, 40, 80]) {
		const lines = view.render(width);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		assert.doesNotMatch(stripAnsi(lines.join("")), /[\x00-\x1f\x7f-\x9f]/);
		assert.doesNotMatch(lines.join(""), /\x1b\[2J|\x07/);
	}
	for (let i = 0; i < 100; i++) view.handleInput("\x1b[6~");
	assert.match(view.render(80).join("\n"), /Session file: \/session/);
	view.handleInput("e"); assert.deepEqual(results, [{ action: "edit", id: "work" }]);
});
