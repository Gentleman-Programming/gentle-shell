import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { JOBS_GLYPH, renderJobsCard, widgetJobs } from "../lib/jobs-widget.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The Jobs sidebar card replaces the Jobs group the Status card used to print.
// Rendering is pure, so it verifies without a TUI: newest job first, one row
// per running job with its elapsed time, collapsible like Agents and Todos.

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

// The card style defaults to float; these assertions pin the outlined (neon)
// panels unless a test switches the style itself.
const initialCardStyle = cardStyle();
before(() => setCardStyle(CARD_STYLE.NEON));
after(() => setCardStyle(initialCardStyle));

test("the jobs card lists running jobs newest first with elapsed time", () => {
	const lines = renderJobsCard(jobs, plainTheme, 50, 100_000, { collapsed: false, collapseControl: true });
	const text = lines.join("\n");
	assert.match(text, new RegExp(`${JOBS_GLYPH} Jobs`));
	assert.match(text, /2 running/);
	const watcher = text.indexOf("Watcher CI ronda 2");
	const build = text.indexOf("Build runtime");
	assert.ok(watcher >= 0, "the newest job paints");
	assert.ok(build > watcher, "newest first, matching the /gentle:jobs running group");
	assert.match(text, /1m 0s/, "the 60s job shows its elapsed time");
	assert.match(text, /1m 30s/, "the 90s job shows its elapsed time");
	assert.match(text, /▾ Collapse/);
	for (const line of lines) assert.ok(visibleWidth(stripAnsi(line)) <= 50, `row fits: ${stripAnsi(line)}`);
});

test("an empty job list paints nothing", () => {
	assert.deepEqual(renderJobsCard([], plainTheme, 50, 100_000, { collapsed: false }), []);
});

test("a collapsed jobs card keeps the newest job and folds the rest", () => {
	// Wide enough for the header to also fit the "ctrl+shift+j expand" hint.
	const lines = renderJobsCard(jobs, plainTheme, 64, 100_000, { collapsed: true, collapseKey: "ctrl+shift+j", collapseControl: true });
	const text = lines.join("\n");
	assert.match(text, /Watcher CI ronda 2/);
	assert.doesNotMatch(text, /Build runtime/);
	assert.match(text, /… 1 more/);
	assert.match(text, /ctrl\+shift\+j expand/);
	assert.match(text, /▸ Expand/);
});

test("the collapse control is opt-in and the sort never mutates the snapshot", () => {
	const snapshot = [{ id: "job-1", label: "Build runtime", startedAt: 10_000 }];
	const lines = renderJobsCard(snapshot, plainTheme, 50, 100_000, { collapsed: false });
	assert.doesNotMatch(lines.join("\n"), /Collapse|Expand/);
	const sorted = widgetJobs(snapshot);
	assert.deepEqual(snapshot, [{ id: "job-1", label: "Build runtime", startedAt: 10_000 }]);
	assert.equal(sorted[0]?.id, "job-1");
});
