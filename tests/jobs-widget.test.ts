import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { JOBS_GLYPH, renderJobsSection, widgetJobs } from "../lib/jobs-widget.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The Jobs rail section (a panel section, see lib/shell-panel.ts). Rendering is
// pure, so it verifies without a TUI: newest job first, one row per job with
// its elapsed time, collapsible like Agents and Todos.

// Width math counts every painted character, so these assertions use a plain
// theme; colored roles are covered by the widget's paint calls, not here.
const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

const jobs = [
	{ id: "job-2", label: "Watcher CI ronda 2", startedAt: 40_000 },
	{ id: "job-1", label: "Build runtime", startedAt: 10_000 },
];

test("the jobs section lists running jobs newest first with elapsed time", () => {
	const lines = renderJobsSection(jobs, plainTheme, 50, 100_000, { collapsed: false });
	const text = lines.join("\n");
	assert.match(lines[0]!, /^▾ JOBS +2 running$/);
	assert.match(text, new RegExp(`${JOBS_GLYPH} job-2 Watcher CI ronda 2`));
	const watcher = text.indexOf("Watcher CI ronda 2");
	const build = text.indexOf("Build runtime");
	assert.ok(watcher >= 0, "the newest job paints");
	assert.ok(build > watcher, "newest first, matching the /gentle:jobs running group");
	assert.match(text, /1m 0s/, "the 60s job shows its elapsed time");
	assert.match(text, /1m 30s/, "the 90s job shows its elapsed time");
	for (const line of lines) assert.equal(visibleWidth(stripAnsi(line)), 50, `row fills the section: ${stripAnsi(line)}`);
});

test("an empty job list paints nothing", () => {
	assert.deepEqual(renderJobsSection([], plainTheme, 50, 100_000, { collapsed: false }), []);
});

test("a collapsed jobs section keeps the newest job and folds the rest", () => {
	const lines = renderJobsSection(jobs, plainTheme, 64, 100_000, { collapsed: true });
	const text = lines.join("\n");
	assert.match(lines[0]!, /^▸ JOBS/);
	assert.match(text, /Watcher CI ronda 2/);
	assert.doesNotMatch(text, /Build runtime/);
	assert.match(text, /… 1 more/);
});

test("the sort never mutates the snapshot", () => {
	const snapshot = [{ id: "job-1", label: "Build runtime", startedAt: 10_000 }];
	const sorted = widgetJobs(snapshot, 100_000);
	assert.deepEqual(snapshot, [{ id: "job-1", label: "Build runtime", startedAt: 10_000 }]);
	assert.equal(sorted[0]?.id, "job-1");
});

// Finished tails mirror the Agents card's results: an exit lingers for a
// minute with the /gentle:jobs outcome glyph, its elapsed frozen at the end.

const exitedJob = { id: "job-1", label: "Build runtime", startedAt: 10_000, status: "exited" as const, endedAt: 70_000, exitCode: 0 as number | null };

function finishedJobs(): Array<typeof exitedJob> {
	return [1, 2, 3, 4].map((n) => ({ ...exitedJob, id: `job-${n}`, label: `Job ${n}`, startedAt: n * 1_000, endedAt: 100_000 + n * 1_000 }));
}

test("a finished job lingers with a ✓ row and its elapsed frozen at the end", () => {
	const lines = renderJobsSection([exitedJob], plainTheme, 50, 100_000, { collapsed: false });
	const text = lines.join("\n");
	assert.match(text, /✓ job-1 Build runtime/);
	assert.match(text, /1m 0s/, "elapsed freezes at endedAt instead of ticking to 1m 30s");
	assert.match(text, /1 finished/);
	for (const line of lines) assert.ok(visibleWidth(stripAnsi(line)) <= 50, `row fits: ${stripAnsi(line)}`);
});

test("a nonzero exit paints ✗ and a stopped job paints –", () => {
	const lines = renderJobsSection([
		{ ...exitedJob, exitCode: 1 },
		{ id: "job-2", label: "Watcher CI", startedAt: 5_000, status: "stopped", endedAt: 60_000 },
	], plainTheme, 50, 100_000, { collapsed: false });
	const text = lines.join("\n");
	assert.match(text, /✗ job-1 Build runtime/);
	assert.match(text, /– job-2 Watcher CI/);
	assert.match(text, /2 finished/);
});

test("a failed job rides the tail with the ✗ glyph", () => {
	const lines = renderJobsSection([{ ...exitedJob, status: "failed" as const }], plainTheme, 50, 100_000, { collapsed: false });
	const text = lines.join("\n");
	assert.match(text, /✗ job-1 Build runtime/);
	assert.match(text, /1m 0s/, "elapsed freezes at endedAt like the other outcomes");
	assert.match(text, /1 finished/);
});

test("finished jobs past the TTL paint nothing", () => {
	// now - endedAt lands exactly on the TTL: not fresh anymore.
	assert.deepEqual(renderJobsSection([{ ...exitedJob, endedAt: 40_000 }], plainTheme, 50, 100_000, { collapsed: false }), []);
});

test("at most the three newest finished jobs survive", () => {
	const jobs = finishedJobs();
	const shown = widgetJobs(jobs, 105_000);
	assert.deepEqual(shown.map((job) => job.id), ["job-4", "job-3", "job-2"]);
	assert.deepEqual(jobs, finishedJobs(), "the TTL filter never mutates the snapshot");
});

test("running entries sort before the finished tail and never expire", () => {
	const snapshot = [
		{ ...exitedJob, id: "done", label: "Old build", startedAt: 1_000 },
		{ id: "old", label: "Old run", startedAt: 1_000 },
		{ id: "new", label: "New run", startedAt: 50_000 },
	];
	const shown = widgetJobs(snapshot, 100_000);
	assert.deepEqual(shown.map((job) => job.id), ["new", "old", "done"]);
});

test("the header count mixes running and finished jobs", () => {
	const lines = renderJobsSection([
		{ id: "job-1", label: "New run", startedAt: 50_000 },
		{ id: "job-2", label: "Watcher CI", startedAt: 5_000, status: "stopped", endedAt: 60_000 },
	], plainTheme, 50, 100_000, { collapsed: false });
	assert.match(lines.join("\n"), /1 running · 1 finished/);
});
