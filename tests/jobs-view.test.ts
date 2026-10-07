import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { JobRecord } from "../lib/background-jobs.ts";
import { JobsView } from "../lib/jobs-view.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

const theme = { fg: (_role: string, text: string) => text };

function job(overrides: Partial<JobRecord> & Pick<JobRecord, "id">): JobRecord {
	return {
		kind: "command",
		label: overrides.id,
		command: `run ${overrides.id}`,
		cwd: "/repo",
		ownerSessionId: "s1",
		outputPath: `/tmp/jobs/${overrides.id}.log`,
		startedAt: 0,
		status: "running",
		tail: [],
		...overrides,
	};
}

function harness(jobs: JobRecord[], rows = 14) {
	const stopped: string[] = [];
	let closed = 0;
	let renders = 0;
	const view = new JobsView({
		theme,
		rows: () => rows,
		jobs: () => jobs,
		now: () => 125_000,
		onStop: (selected) => { stopped.push(selected.id); },
		onClose: () => { closed += 1; },
		requestRender: () => { renders += 1; },
	});
	const screen = (width = 100) => view.render(width).map(stripAnsi);
	return { view, screen, stopped, closed: () => closed, renders: () => renders };
}

test("the split view lists this session's jobs beside the selected job's details and output tail", () => {
	const h = harness([
		job({ id: "job-1", label: "CI for PR 1834", command: "gh run watch 42 --exit-status", tail: ["check lint: pass", "check test: pending"] }),
		job({ id: "job-2", label: "build", status: "exited", exitCode: 1, endedAt: 4_000 }),
	]);
	try {
		const lines = h.screen();
		assert.equal(lines.length, 14, "the overlay fills the terminal height");
		for (const line of lines) assert.equal(visibleWidth(line), 100, "every row spans the full width");
		const text = lines.join("\n");
		assert.match(lines[0]!, /Jobs · 1 running · 1 finished/);
		assert.match(text, /◐ CI for PR 1834 +2m 5s/);
		assert.match(text, /✗ build +4s/);
		assert.match(text, /gh run watch 42 --exit-status/);
		assert.match(text, /running/);
		assert.match(text, /\/tmp\/jobs\/job-1\.log/);
		assert.match(text, /check test: pending/);
		assert.match(lines.at(-2)!, /s Stop/);
	} finally { h.view.dispose(); }
});

test("j/k move the selection, s stops only a running job, and q closes", () => {
	const h = harness([job({ id: "job-1" }), job({ id: "job-2", status: "exited", exitCode: 0, endedAt: 1_000, tail: ["done"] })]);
	try {
		h.view.handleInput("j");
		const text = h.screen().join("\n");
		assert.match(text, /exited with code 0/);
		assert.match(text, /done/);
		assert.doesNotMatch(h.screen().at(-2)!, /s Stop/, "a finished job offers no stop");
		h.view.handleInput("s");
		assert.deepEqual(h.stopped, []);
		h.view.handleInput("k");
		h.view.handleInput("s");
		assert.deepEqual(h.stopped, ["job-1"]);
		h.view.handleInput("q");
		assert.equal(h.closed(), 1);
	} finally { h.view.dispose(); }
});

test("jobs show running first and newest first within each group without changing source order", () => {
	const jobs = [
		job({ id: "old-finished", status: "exited", exitCode: 0, startedAt: 1_000, endedAt: 2_000 }),
		job({ id: "old-running", startedAt: 3_000 }),
		job({ id: "new-finished", status: "stopped", startedAt: 9_000, endedAt: 10_000 }),
		job({ id: "new-running", startedAt: 5_000 }),
	];
	const h = harness(jobs);
	try {
		const lines = h.screen();
		const names = ["new-running", "old-running", "new-finished", "old-finished"];
		const positions = names.map((name) => lines.findIndex((line) => line.includes(name)));
		assert.ok(positions.every((index, i) => index > 0 && (i === 0 || index > positions[i - 1]!)));
		h.view.handleInput("s");
		assert.deepEqual(h.stopped, ["new-running"], "the default selection follows display order");
		h.view.handleInput("j");
		h.view.handleInput("s");
		assert.deepEqual(h.stopped, ["new-running", "old-running"], "navigation follows the same sorted order");
		jobs.push(job({ id: "latest-running", startedAt: 11_000 }));
		assert.match(h.screen().join("\n"), /› ◐ old-running/, "a new job preserves selection by ID");
		assert.deepEqual(jobs.map((entry) => entry.id), ["old-finished", "old-running", "new-finished", "new-running", "latest-running"]);
	} finally { h.view.dispose(); }
});

test("initial selection survives new jobs and completion before any keyboard navigation", () => {
	const first = job({ id: "job-A", startedAt: 1_000 });
	const jobs = [first];
	const h = harness(jobs);
	try {
		assert.match(h.screen().join("\n"), /› ◐ job-A/);
		jobs.push(job({ id: "job-B", startedAt: 2_000 }));
		assert.match(h.screen().join("\n"), /› ◐ job-A/, "a newly started job does not steal selection");
		h.view.handleInput("s");
		assert.deepEqual(h.stopped, ["job-A"], "stop still targets the initially selected job");
		first.status = "exited";
		first.exitCode = 0;
		first.endedAt = 3_000;
		assert.match(h.screen().join("\n"), /› ✓ job-A/, "completion does not steal selection");
		assert.match(h.screen().join("\n"), /exited with code 0/);
		h.view.handleInput("s");
		assert.deepEqual(h.stopped, ["job-A"], "stop on a finished selection does not target another running job");
		assert.deepEqual(jobs.map((entry) => entry.id), ["job-A", "job-B"]);
	} finally { h.view.dispose(); }
});

test("an empty session says so", () => {
	const h = harness([]);
	try {
		const text = h.screen().join("\n");
		assert.match(text, /Jobs · 0 running · 0 finished/);
		assert.match(text, /No background jobs in this session/);
	} finally { h.view.dispose(); }
});

test("a narrow terminal shows the list, and tab toggles the selected job's details", () => {
	const h = harness([job({ id: "job-1", label: "ci", command: "gh run watch 7", tail: ["waiting"] })]);
	try {
		let text = h.screen(40).join("\n");
		assert.match(text, /◐ ci/);
		assert.doesNotMatch(text, /gh run watch 7/);
		h.view.handleInput("\t");
		text = h.screen(40).join("\n");
		assert.match(text, /gh run watch 7/);
		assert.match(text, /waiting/);
		h.view.handleInput("\u001b");
		assert.equal(h.closed(), 0, "escape from details goes back to the list first");
		assert.doesNotMatch(h.screen(40).join("\n"), /gh run watch 7/);
		h.view.handleInput("\u001b");
		assert.equal(h.closed(), 1);
	} finally { h.view.dispose(); }
});

test("a monitor shows its kind and event count in the list and details", () => {
	const h = harness([job({ id: "job-1", kind: "monitor", label: "errors", command: "tail -f app.log | grep ERROR", events: 3, tail: ["ERROR x"] })]);
	try {
		const text = h.screen().join("\n");
		assert.match(text, /◉ errors/);
		assert.match(text, /Status +running · .* · 3 events/);
	} finally { h.view.dispose(); }
});
