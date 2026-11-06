import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen, visibleWidth, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { JobRecord } from "../lib/background-jobs.ts";
import { JobsView, type JobsViewDeps } from "../lib/jobs-view.ts";
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

function harness(jobs: JobRecord[], rows = 14, colors: JobsViewDeps["theme"] = theme) {
	const stopped: string[] = [];
	let closed = 0;
	let renders = 0;
	const view = new JobsView({
		theme: colors,
		rows: () => rows,
		jobs: () => jobs,
		now: () => 125_000,
		onStop: (selected) => { stopped.push(selected.id); },
		onClose: () => { closed += 1; },
		requestRender: () => { renders += 1; },
	});
	const interaction = view;
	const frame = (width = 100) => interaction.render(width);
	const screen = (width = 100) => frame(width).map(stripAnsi);
	return { view, interaction, frame, screen, stopped, closed: () => closed, renders: () => renders, setRows: (next: number) => { rows = next; } };
}

function mouse(frame: string[], text: string, type: TuiMouseEvent["type"] = "click", button: TuiMouseEvent["button"] = type === "move" ? "none" : "left"): TuiMouseEvent {
	const lines = frame.map(stripAnsi);
	const y = lines.findIndex((line) => line.includes(text));
	assert.ok(y >= 0, `Missing ${text}:\n${lines.join("\n")}`);
	const x = visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf(text)));
	return { type, button, x, y, screenX: x, screenY: y, width: visibleWidth(lines[0]!), height: lines.length, shift: false, alt: false, ctrl: false };
}

function click(h: ReturnType<typeof harness>, frame: string[], text: string): void {
	h.interaction.handleMouse(mouse(frame, text, "press"));
	h.interaction.handleMouse(mouse(frame, text));
}

const gentleTheme = loadThemeFromPath("themes/Gentle.json", "truecolor");

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

test("pointer hover uses the shared warning role without selecting, stopping or repeatedly redrawing", () => {
	const h = harness([job({ id: "first" }), job({ id: "second" })], 14, gentleTheme);
	try {
		let frame = h.frame();
		const event = mouse(frame, "second", "move");
		const before = h.renders();
		assert.equal(h.interaction.handleMouse(event)?.render, true);
		frame = h.frame();
		const hovered = frame[event.y]!;
		assert.ok(hovered.includes(gentleTheme.getFgAnsi("warning")), "the rendered job row uses the warning token");
		assert.match(frame.map(stripAnsi).join("\n"), /› ◐ first/);
		assert.deepEqual(h.stopped, []);
		assert.equal(h.closed(), 0);
		assert.equal(h.interaction.handleMouse(event)?.render, false, "the same target does not redraw");
		assert.equal(h.renders(), before);
		const blank = { ...event, x: 3, screenX: 3, y: 7, screenY: 7 };
		h.interaction.handleMouse(blank);
		assert.equal(h.renders(), before + 1, "moving to a blank row clears the hover");
		assert.ok(!h.frame()[event.y]!.includes(gentleTheme.getFgAnsi("warning")));
	} finally { h.view.dispose(); }
});

test("clicking a visible row selects its exact job and never implicitly stops it", () => {
	const h = harness([job({ id: "first" }), job({ id: "second", tail: ["second output"] })]);
	try {
		let frame = h.frame();
		h.interaction.handleMouse(mouse(frame, "second", "press"));
		assert.match(h.screen().join("\n"), /› ◐ first/, "press alone does not select");
		frame = h.frame();
		h.interaction.handleMouse(mouse(frame, "second", "click", "right"));
		assert.match(h.screen().join("\n"), /› ◐ first/, "right click does nothing");
		frame = h.frame();
		click(h, frame, "second");
		assert.match(h.screen().join("\n"), /› ◐ second/);
		assert.match(h.screen().join("\n"), /second output/);
		assert.deepEqual(h.stopped, []);
		assert.equal(h.closed(), 0);
	} finally { h.view.dispose(); }
});

test("stale rows, hidden rows and invalid geometry never select or stop a different job", () => {
	const jobs = [job({ id: "first", startedAt: 20 }), job({ id: "second", startedAt: 10 })];
	const h = harness(jobs);
	try {
		const frame = h.frame();
		const stale = mouse(frame, "second");
		jobs.push(job({ id: "newest", startedAt: 30 }));
		h.interaction.handleMouse(stale);
		assert.match(h.screen().join("\n"), /› ◐ first/, "a reordered row is rejected");
		const fresh = h.frame();
		const title = mouse(fresh, "Jobs");
		const blank = { ...title, x: 3, screenX: 3, y: 8, screenY: 8 };
		h.interaction.handleMouse(title);
		h.interaction.handleMouse(blank);
		h.interaction.handleMouse({ ...mouse(fresh, "second"), width: 99 });
		assert.match(h.screen().join("\n"), /› ◐ first/);
		assert.deepEqual(h.stopped, []);
		assert.equal(h.closed(), 0);
	} finally { h.view.dispose(); }
});

test("the explicit stop control rechecks the rendered identity and current running status", () => {
	const first = job({ id: "first" });
	const second = job({ id: "second" });
	const h = harness([first, second], 14, gentleTheme);
	try {
		let frame = h.frame();
		const stop = mouse(frame, "s Stop");
		h.interaction.handleMouse({ ...stop, type: "move", button: "none" });
		assert.ok(h.frame()[stop.y]!.includes(gentleTheme.getFgAnsi("warning")));
		assert.deepEqual(h.stopped, []);
		h.interaction.handleMouse({ ...stop, type: "press" });
		h.view.handleInput("j");
		frame = h.frame();
		h.interaction.handleMouse(mouse(frame, "s Stop"));
		assert.deepEqual(h.stopped, [], "a press on first cannot stop second after selection changes");
		click(h, frame, "s Stop");
		assert.deepEqual(h.stopped, ["second"]);
		frame = h.frame();
		const staleStop = mouse(frame, "s Stop");
		second.status = "exited";
		h.interaction.handleMouse(staleStop);
		assert.deepEqual(h.stopped, ["second"], "a finished job cannot be stopped using an old control");
		assert.doesNotMatch(h.screen().at(-2)!, /s Stop/);
		assert.equal(first.status, "running");
	} finally { h.view.dispose(); }
});

test("narrow details/list and close controls work by click while hidden controls stay inert", () => {
	const h = harness([job({ id: "first" }), job({ id: "second", command: "show second" })], 14, gentleTheme);
	try {
		let frame = h.frame(40);
		click(h, frame, "second");
		frame = h.frame(40);
		assert.match(frame.map(stripAnsi).join("\n"), /show second/);
		assert.doesNotMatch(frame.map(stripAnsi).join("\n"), /› ◐ second/);
		const back = mouse(frame, "tab list", "move");
		h.interaction.handleMouse(back);
		assert.ok(h.frame(40)[back.y]!.includes(gentleTheme.getFgAnsi("warning")));
		frame = h.frame(40);
		click(h, frame, "tab list");
		frame = h.frame(40);
		assert.match(frame.map(stripAnsi).join("\n"), /› ◐ second/);
		click(h, frame, "tab details");
		frame = h.frame(40);
		assert.match(frame.map(stripAnsi).join("\n"), /show second/);
		const close = mouse(frame, "q close", "move");
		h.interaction.handleMouse(close);
		assert.ok(h.frame(40)[close.y]!.includes(gentleTheme.getFgAnsi("warning")));
		assert.equal(h.closed(), 0, "hovering close does not close the overlay");
		click(h, h.frame(40), "q close");
		assert.equal(h.closed(), 1);
		assert.deepEqual(h.stopped, []);
	} finally { h.view.dispose(); }
});

test("very narrow details retain visible mouse back and close controls", () => {
	for (const width of [12, 14, 20, 24, 30, 40]) {
		const h = harness([job({ id: "first" }), job({ id: "second", command: "second detail" })]);
		try {
			h.frame(width);
			h.view.handleInput("\t");
			let frame = h.frame(width);
			const footer = stripAnsi(frame.at(-2)!);
			const back = footer.includes("tab list") ? "tab list" : "←";
			const close = footer.includes("q close") ? "q close" : "×";
			assert.ok(footer.includes(back) && footer.includes(close), `${width} columns: ${footer}`);
			click(h, frame, back);
			frame = h.frame(width);
			const listFooter = stripAnsi(frame.at(-2)!);
			assert.ok(listFooter.includes("tab details") || listFooter.includes("→"), `${width} columns: ${listFooter}`);
			assert.deepEqual(h.stopped, []);
			assert.equal(h.closed(), 0);
		} finally { h.view.dispose(); }
	}
});

test("a changed row under a pending press cannot select the replacement", () => {
	const jobs = [job({ id: "first", startedAt: 20 }), job({ id: "second", startedAt: 10 })];
	const h = harness(jobs);
	try {
		const before = h.frame();
		const row = mouse(before, "second");
		h.interaction.handleMouse({ ...row, type: "press" });
		jobs.push(job({ id: "newest", startedAt: 30 }));
		h.frame();
		h.interaction.handleMouse(row);
		assert.match(h.screen().join("\n"), /› ◐ first/);
		assert.deepEqual(h.stopped, []);
		assert.equal(h.closed(), 0);
	} finally { h.view.dispose(); }
});

test("scrolled lists target only the visible job identities and fallback close remains clickable", () => {
	const h = harness(Array.from({ length: 6 }, (_, index) => job({ id: `job-${index}`, startedAt: 6 - index })), 6);
	try {
		const stale = mouse(h.frame(), "job-1");
		for (let index = 0; index < 4; index += 1) h.view.handleInput("j");
		h.interaction.handleMouse(stale);
		let frame = h.frame();
		assert.match(frame.map(stripAnsi).join("\n"), /› ◐ job-4/);
		assert.ok(!frame.map(stripAnsi).some((line) => line.includes("job-0")));
		click(h, frame, "job-3");
		assert.match(h.screen().join("\n"), /› ◐ job-3/);
		assert.deepEqual(h.stopped, []);
		frame = h.frame(8);
		click(h, frame, "×");
		assert.equal(h.closed(), 1);
	} finally { h.view.dispose(); }
});

test("resize, invalidation and disposal discard pointer geometry and hover", () => {
	const h = harness([job({ id: "first" }), job({ id: "second" })], 14, gentleTheme);
	try {
		let frame = h.frame();
		const row = mouse(frame, "second");
		h.interaction.handleMouse({ ...row, type: "move", button: "none" });
		h.setRows(8);
		h.interaction.handleMouse(row);
		assert.deepEqual(h.stopped, []);
		frame = h.frame(80);
		assert.ok(!frame.join("\n").includes(gentleTheme.getFgAnsi("warning")));
		assert.match(frame.map(stripAnsi).join("\n"), /› ◐ first/);
		const fresh = mouse(frame, "second");
		h.interaction.handleMouse({ ...fresh, type: "move", button: "none" });
		assert.ok(h.frame(80)[fresh.y]!.includes(gentleTheme.getFgAnsi("warning")));
		h.view.invalidate();
		h.interaction.handleMouse(fresh);
		frame = h.frame(80);
		assert.ok(!frame.join("\n").includes(gentleTheme.getFgAnsi("warning")));
		assert.match(frame.map(stripAnsi).join("\n"), /› ◐ first/);
		h.interaction.handleMouse({ ...fresh, type: "move", button: "none" });
		h.view.dispose();
		h.interaction.handleMouse(fresh);
		assert.ok(!h.frame(80).join("\n").includes(gentleTheme.getFgAnsi("warning")));
		assert.deepEqual(h.stopped, []);
		assert.equal(h.closed(), 0);
	} finally { h.view.dispose(); }
});

test("real centered TuiAltScreen SGR events hover, select and stop the visible job", () => {
	let input: ((data: string) => void) | undefined;
	const terminal: Terminal = {
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {}, get columns() { return 120; }, get rows() { return 30; }, get kittyProtocolActive() { return false; }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const h = harness([job({ id: "first" }), job({ id: "second" })], 14, gentleTheme);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	const overlay = tui.showOverlay(h.interaction, { anchor: "center", width: 80, maxHeight: 14 });
	tui.start();
	tui.renderNow(true);
	try {
		const bounds = overlay.getBounds();
		assert.ok(bounds && bounds.col > 0 && bounds.row > 0);
		let frame = h.frame(80);
		const row = mouse(frame, "second");
		const x = bounds.col + row.x + 1, y = bounds.row + row.y + 1;
		input?.(`\x1b[<35;${x};${y}M`);
		frame = h.frame(80);
		assert.ok(frame[row.y]!.includes(gentleTheme.getFgAnsi("warning")));
		assert.match(frame.map(stripAnsi).join("\n"), /› ◐ first/);
		input?.("\x1b[<35;1;1M");
		assert.ok(h.frame(80)[row.y]!.includes(gentleTheme.getFgAnsi("warning")), "native overlay dispatch does not deliver outside-card motion");
		input?.(`\x1b[<0;${x};${y}M`);
		input?.(`\x1b[<0;${x};${y}m`);
		tui.renderNow(true);
		frame = h.frame(80);
		assert.match(frame.map(stripAnsi).join("\n"), /› ◐ second/);
		assert.deepEqual(h.stopped, []);
		const stop = mouse(frame, "s Stop");
		const sx = bounds.col + stop.x + 1, sy = bounds.row + stop.y + 1;
		input?.(`\x1b[<0;${sx};${sy}M`);
		input?.(`\x1b[<0;${sx};${sy}m`);
		assert.deepEqual(h.stopped, ["second"]);
	} finally { tui.stop(); h.view.dispose(); }
});
