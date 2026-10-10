import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { createStatsLoader, type CurrentSessionStats, type SessionRecord } from "../lib/stats-collector.ts";
import { StatsView, type StatsViewDeps } from "../lib/stats-view.ts";

// The /gentle:stats panel: Overview / Models / Session tabs over the
// collector, with range and scope toggles, q/esc close, and a clickable
// footer. Rendered against the collector fixtures with a fixed clock.

const SESSIONS = fileURLToPath(new URL("./fixtures/stats/sessions", import.meta.url));
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const ROWS = 40;
const plainTheme = { fg: (_role: string, text: string) => text };
// Zero-width role markers: one 256-color SGR per role, so widths stay honest.
const ROLES = ["accent", "borderMuted"];
const roleCode = (role: string) => `\x1b[38;5;${ROLES.indexOf(role) + 1}m`;
const roleTheme = { fg: (role: string, text: string) => `${roleCode(role)}${text}\x1b[39m` };
const CURRENT: CurrentSessionStats = {
	totals: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, total: 135, cost: 0.125 },
	messages: 1,
	model: "claude-opus-5-5",
	durationMs: 30 * 60 * 1000,
	lines: { added: 2, removed: 1 },
};

function makeView(overrides: Partial<StatsViewDeps> = {}) {
	const events: string[] = [];
	const view = new StatsView({
		theme: plainTheme,
		rows: ROWS,
		cwd: "/work/alpha",
		now: () => NOW,
		dayKey: (ms) => new Date(ms).toISOString().slice(0, 10),
		load: () => createStatsLoader().load(SESSIONS),
		current: () => CURRENT,
		onClose: () => events.push("close"),
		requestRender: () => events.push("render"),
		...overrides,
	});
	return { view, events };
}

async function ready(overrides: Partial<StatsViewDeps> = {}) {
	const made = makeView(overrides);
	await made.view.load();
	return made;
}

const plain = (view: StatsView, width = 100) => view.render(width).map(stripAnsi);
const joined = (view: StatsView, width = 100) => plain(view, width).join("\n");

function assertFits(view: StatsView, width: number) {
	const lines = view.render(width);
	assert.equal(lines.length, ROWS);
	for (const line of lines) assert.equal(visibleWidth(line), width, `"${stripAnsi(line)}" is not ${width} wide`);
}

function click(view: StatsView, width: number, y: number, label: string) {
	const lines = plain(view, width);
	const x = lines[y].indexOf(label);
	assert.ok(x >= 0, `"${label}" not on row ${y}: ${lines[y]}`);
	const event: TuiMouseEvent = { type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: ROWS, shift: false, alt: false, ctrl: false };
	return view.handleMouse(event);
}

test("StatsView shows a loading state, then the overview once sessions load", async () => {
	let resolve!: (sessions: SessionRecord[]) => void;
	const { view, events } = makeView({ load: () => new Promise((done) => { resolve = done; }) });
	const loading = view.load();
	assert.match(joined(view), /Loading local sessions…/);
	resolve(await createStatsLoader().load(SESSIONS));
	await loading;
	assert.ok(events.includes("render"));
	const text = joined(view);
	assert.doesNotMatch(text, /Loading/);
	assert.match(text, /✿ Stats/);
	assert.match(text, /\[× Close\]/);
	assert.match(text, /Overview/);
	assert.match(text, /All time · All projects/);
});

test("Overview pins every headline figure from the fixtures", async () => {
	const { view } = await ready();
	const text = joined(view);
	assert.match(text, /Favorite model +claude-opus-5-5/);
	assert.match(text, /Total tokens +2\.8k/);
	assert.match(text, /Sessions +3/);
	assert.match(text, /Longest session +2h00m/);
	assert.match(text, /Active days +4\/31/);
	assert.match(text, /Longest streak +3 days/);
	assert.match(text, /Most active day +Sep 28/);
	assert.match(text, /Current streak +3 days/);
	assert.match(text, /in 810 · out 740 · cache read 1\.0k · cache write 200/);
	assert.match(text, /Cost +\$2\.05/);
	assert.match(text, /Don Quixote/);
	assert.match(text, /Less .* More/);
	assert.match(text, /Mon/);
	assert.match(text, /Local Pi sessions on this machine · subagent runs not included/);
	assertFits(view, 100);
});

test("the heatmap shades days with theme roles and leaves future days blank", async () => {
	const { view } = await ready({ theme: roleTheme });
	const text = view.render(100).join("\n");
	const heat = text.split("\n").slice(4, 11).join("\n");
	assert.ok(heat.includes(`${roleCode("accent")}█`), "the busiest day takes the strongest shade");
	assert.ok(heat.includes(`${roleCode("accent")}░`), "a light day takes the faintest shade");
	assert.ok(heat.includes(`${roleCode("borderMuted")}·`), "idle days stay visible as dots");
	// 96 content cells hold 46 two-cell weeks after the 4-cell weekday label.
	const x = 2 + 4 + (Math.floor((96 - 4) / 2) - 1) * 2;
	const thisWeek = stripAnsi(text).split("\n").slice(4, 11).map((line) => line[x]);
	assert.deepEqual(thisWeek, ["█", "░", "░", "·", " ", " ", " "], "Mon–Thu of this week are drawn, Fri–Sun are still blank");
	assert.doesNotMatch(text, /#[0-9a-f]{6}|\x1b\[38;2/i, "no hardcoded colors");
});

test("range and scope toggles re-aggregate and relabel the panel", async () => {
	const { view, events } = await ready();
	view.handleInput("r");
	assert.match(joined(view), /Last 7 days · All projects/);
	assert.match(joined(view), /Total tokens +1\.8k/);
	assert.match(joined(view), /Active days +3\/7/);
	view.handleInput("r");
	assert.match(joined(view), /Last 30 days/);
	view.handleInput("r");
	assert.match(joined(view), /All time/);
	view.handleInput("s");
	assert.match(joined(view), /All time · This project/);
	assert.match(joined(view), /Sessions +2/);
	assert.ok(events.filter((event) => event === "render").length >= 4);
});

test("tabs switch with Tab, shift+Tab, arrows, and digits", async () => {
	const { view } = await ready();
	view.handleInput("\t");
	let text = joined(view);
	assert.match(text, /claude-opus-5-5 .*53% .*1\.4k .*\$0\.800 .*3/);
	assert.match(text, /gpt-5\.5 .*36%/);
	assert.match(text, /gpt-6\.1-sol .*11%/);
	view.handleInput("\x1b[C");
	text = joined(view);
	assert.match(text, /Model +claude-opus-5-5/);
	assert.match(text, /Cost +\$0\.125/);
	assert.match(text, /Duration +30m00s/);
	assert.match(text, /Lines +\+2 −1/);
	assert.match(text, /135 total · in 10 · out 5 · cache read 100 · cache write 20/);
	view.handleInput("\x1b[Z");
	assert.match(joined(view), /Share/);
	view.handleInput("1");
	assert.match(joined(view), /Favorite model/);
	view.handleInput("\x1b[D");
	assert.match(joined(view), /Duration/);
	view.handleInput("2");
	assert.match(joined(view), /Share/);
});

test("q and esc close exactly once", async () => {
	const { view, events } = await ready();
	view.handleInput("q");
	view.handleInput("q");
	view.handleInput("\x1b");
	assert.equal(events.filter((event) => event === "close").length, 1);
	const escaped = await ready();
	escaped.view.handleInput("\x1b");
	assert.equal(escaped.events.filter((event) => event === "close").length, 1);
});

test("empty and failing loads render a calm state without throwing", async () => {
	const empty = await ready({ load: async () => [] });
	assert.match(joined(empty.view), /No usage recorded yet/);
	empty.view.handleInput("2");
	assert.match(joined(empty.view), /No usage recorded yet/);
	assertFits(empty.view, 100);
	const failed = await ready({ load: async () => { throw new Error("disk on fire"); } });
	assert.match(joined(failed.view), /Could not read local sessions: disk on fire/);
	assertFits(failed.view, 100);
});

test("narrow terminals keep every line inside the frame", async () => {
	const { view } = await ready();
	for (const tab of ["1", "2", "3"]) {
		view.handleInput(tab);
		assertFits(view, 48);
		assertFits(view, 120);
	}
});

test("clickable header and footer controls switch tabs, toggle filters, and close", async () => {
	const { view, events } = await ready();
	const width = 100;
	assert.deepEqual(click(view, width, 1, "Models"), { handled: true, render: true });
	assert.match(joined(view), /Share/);
	const footer = ROWS - 2;
	click(view, width, footer, "r range");
	assert.match(joined(view), /Last 7 days/);
	click(view, width, footer, "s scope");
	assert.match(joined(view), /This project/);
	click(view, width, 0, "[× Close]");
	assert.equal(events.filter((event) => event === "close").length, 1);
});
