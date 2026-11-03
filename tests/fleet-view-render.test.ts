import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FLEET_DENSITIES, FLEET_LENSES, attentionQueue, fleetStatus, lensRows, objectiveProgress, type FleetViewSnapshot } from "../lib/fleet-view.ts";
import {
	FLEET_HINT_CONTEXTS,
	renderFocalBar,
	renderHintLine,
	renderFleetColumn,
	renderLensBar,
	renderLensPanel,
	renderObjectiveStrip,
	renderStatusLine,
	renderWelcomeCard,
	type FleetViewTheme,
} from "../lib/fleet-view-render.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { inkwellFleet } from "./support/fleet-view-fixture.ts";

// Every role gets its own 256-color code, so a test can tell which role
// painted a run of text; accent and bold are the focal item's visual weight.
const ACCENT = "\x1b[38;5;201m";
const BOLD = "\x1b[1m";
const codes = new Map<string, number>();
const theme: FleetViewTheme = {
	fg: (role, text) => {
		if (!codes.has(role)) codes.set(role, 16 + codes.size);
		return `${role === "accent" ? ACCENT : `\x1b[38;5;${codes.get(role)}m`}${text}\x1b[39m`;
	},
	bold: (text) => `${BOLD}${text}\x1b[22m`,
	bg: (_role, text) => `\x1b[48;5;236m${text}\x1b[49m`,
};

// Every group open, so every member row is drawn.
const OPEN = { collapsed: new Set<string>() };

function screen(snapshot: FleetViewSnapshot, width: number, lens: (typeof FLEET_LENSES)[number], density: (typeof FLEET_DENSITIES)[number]) {
	const queue = attentionQueue(snapshot);
	return {
		strip: renderObjectiveStrip(objectiveProgress(snapshot), queue, width, theme),
		focal: renderFocalBar(queue, width, theme),
		lensBar: renderLensBar(lens, width, theme),
		panel: renderLensPanel(lensRows(lens, density, snapshot), width, theme, OPEN),
		status: renderStatusLine(fleetStatus(snapshot, queue), lens, density, width, theme),
		hints: FLEET_HINT_CONTEXTS.flatMap((context) => renderHintLine(context, queue, density, width, theme)),
	};
}

function quiet(): FleetViewSnapshot {
	const snapshot = inkwellFleet();
	snapshot.escalations = [];
	for (const m of snapshot.members) {
		Object.assign(m, { dialogs: [], question: null, lastError: null, exitCode: m.exitCode === 1 ? 0 : m.exitCode });
		delete m.review;
	}
	return snapshot;
}

// Wide glyphs take two cells each; widths must be measured, not counted.
function wide(): FleetViewSnapshot {
	const snapshot = inkwellFleet();
	snapshot.title = "チームのワークスペース for Inkwell 🚀";
	Object.assign(snapshot.members[2], { name: "文档-迁移-团队工作区-数据库", front: "文档" });
	snapshot.members[2].todo.current = "邀请令牌表迁移 🔐 with a unique index on (workspace_id, email)";
	snapshot.escalations[0].title = "招待リンクの有効期限：7日ですか、それとも30日ですか？ 🗓️";
	return snapshot;
}

test("no rendered line exceeds the width at 80 and 180 columns, in every lens, density and hint context", () => {
	for (const snapshot of [inkwellFleet(), quiet(), wide()]) for (const width of [80, 180]) for (const lens of FLEET_LENSES) for (const density of FLEET_DENSITIES) {
		for (const [part, lines] of Object.entries(screen(snapshot, width, lens, density))) {
			assert.ok(lines.length > 0 || part === "focal", `${part} renders at ${width}`);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${part} ${lens}/${density} @${width}: ${visibleWidth(line)} > ${width}: ${stripAnsi(line)}`);
		}
	}
});

test("rows keep their columns aligned with wide glyphs in member names", () => {
	const lines = renderLensPanel(lensRows("flows", "power", wide()), 180, theme, OPEN).map(stripAnsi).filter((line) => /^ {2}\S /.test(line));
	assert.equal(lines.length, 20);
	const gaugeColumns = new Set(lines.map((line) => visibleWidth(line.slice(0, line.search(/[▰▱]/)))));
	assert.equal(gaugeColumns.size, 1, [...gaugeColumns].join(","));
	const costColumns = new Set(lines.map((line) => visibleWidth(line)));
	assert.equal(costColumns.size, 1, "the cost column ends every row at the same cell");
});

test("accent and bold mark only the focal item: the strip, the focal bar and the focal member's row", () => {
	for (const lens of FLEET_LENSES) for (const density of FLEET_DENSITIES) {
		const parts = screen(inkwellFleet(), 180, lens, density);
		const weighted = (lines: string[]) => lines.filter((line) => line.includes(ACCENT) || line.includes(BOLD)).map(stripAnsi);
		assert.equal(weighted(parts.strip).length, 1);
		assert.match(weighted(parts.strip)[0], /Your call → Invite links: expire after 7 days or 30 days\?/);
		assert.ok(weighted(parts.focal).length >= 1);
		for (const line of weighted(parts.focal)) assert.match(line, /Your call → Invite links/);
		assert.deepEqual(weighted(parts.panel).map((line) => line.includes("web-invite-flow")), [true], `${lens}/${density}`);
		for (const part of [parts.status, parts.hints]) assert.deepEqual(weighted(part), []);
		// The other weight is the active tab (T5-U3): its label and its underline.
		assert.equal(weighted(parts.lensBar).length, 2);
		assert.match(weighted(parts.lensBar)[0], new RegExp(lens.charAt(0).toUpperCase() + lens.slice(1)));
	}
	// With nothing focal, only the active tab carries the weight.
	const calm = screen(quiet(), 180, "flows", "power");
	for (const [part, lines] of Object.entries(calm)) if (part !== "lensBar") for (const line of lines) assert.ok(!line.includes(ACCENT) && !line.includes(BOLD), stripAnsi(line));
});

test("the objective strip shows progress, next step and the focal item with then: N more", () => {
	const [objective, focal] = renderObjectiveStrip(objectiveProgress(inkwellFleet()), attentionQueue(inkwellFleet()), 180, theme).map(stripAnsi);
	assert.match(objective, /◎ Team workspaces for Inkwell .*▰▰▰▰▱▱▱▱ 49% of the plan .*0 of 5 fronts done .*next: Add invite token table migration \(api-migration\)/);
	assert.match(focal, /Your call → .*then: 2 more.*tab from the input/);
	// When narrow, the count outlives the key hint.
	const [, narrow] = renderObjectiveStrip(objectiveProgress(inkwellFleet()), attentionQueue(inkwellFleet()), 80, theme).map(stripAnsi);
	assert.equal(narrow, "Your call → Invite links: expire after 7 days or 30 days?  then: 2 more");
	const [, calm] = renderObjectiveStrip(objectiveProgress(quiet()), attentionQueue(quiet()), 180, theme).map(stripAnsi);
	assert.match(calm, /◌ Nothing needs you\. The fleet keeps going; next update around 14:40/);
});

test("the focal bar asks the question with numbered options and the count that follows", () => {
	const lines = renderFocalBar(attentionQueue(inkwellFleet()), 120, theme).map(stripAnsi);
	assert.match(lines[0], /◆ Your call → Invite links: expire after 7 days or 30 days\?.*then: 2 more/);
	assert.ok(lines.some((line) => line.includes("web-invite-flow asks: Invite links")));
	assert.ok(lines.some((line) => /\[1\] 7 days +\[2\] 30 days +\[3\] Never \(revoke\) +\[4\] Type an answer…/.test(line)));
	assert.deepEqual(renderFocalBar(attentionQueue(quiet()), 120, theme), []);
});

test("the lens bar names every lens with its key and the panel keeps one row per member", () => {
	assert.match(stripAnsi(renderLensBar("costs", 80, theme)[0]), /^ Flows {2}Map {2}Costs {2}Log +alt\+1-4$/);
	const snapshot = inkwellFleet();
	for (const lens of FLEET_LENSES) {
		const text = renderLensPanel(lensRows(lens, "normal", snapshot), 180, theme, OPEN).map(stripAnsi);
		const rows = snapshot.members.map((m) => text.findIndex((line) => new RegExp(`^ +. ${m.name}\\b`).test(line)));
		assert.ok(rows.every((index) => index >= 0), `${lens}: every member has a row`);
		// The fixture lists members in attention order already.
		assert.deepEqual(rows, [...rows].sort((a, b) => a - b), lens);
	}
	const flows = renderLensPanel(lensRows("flows", "light", snapshot), 180, theme).map(stripAnsi);
	assert.ok(flows.some((line) => /◆ web-invite-flow +→ your call, above the input/.test(line)));
	// 05 folds Waiting on others and Done until the user opens them.
	assert.ok(flows.includes("▾ Needs you (1)") && flows.includes("▸ Done (3)"));
	assert.ok(!flows.some((line) => line.includes("seed-data")));
});

test("the status line counts live members and the queue; the budget shows only in power", () => {
	const snapshot = inkwellFleet();
	const queue = attentionQueue(snapshot);
	const light = stripAnsi(renderStatusLine(fleetStatus(snapshot, queue), "flows", "light", 180, theme)[0]);
	assert.match(light, /16 of 20 members live · 1 decision · 1 blocked · 3 reviews/);
	assert.match(light, /lens flows · density light/);
	assert.doesNotMatch(light, /\$/);
	assert.match(stripAnsi(renderStatusLine(fleetStatus(snapshot, queue), "map", "power", 180, theme)[0]), /\$\d+\.\d\d of \$40\.00/);
	assert.match(stripAnsi(renderStatusLine(fleetStatus(quiet(), attentionQueue(quiet())), "flows", "light", 180, theme)[0]), /nothing needs you/);
});

test("the hint line teaches the next key for the focused place", () => {
	const queue = attentionQueue(inkwellFleet());
	const hint = (context: (typeof FLEET_HINT_CONTEXTS)[number], density: (typeof FLEET_DENSITIES)[number] = "light") => stripAnsi(renderHintLine(context, queue, density, 180, theme)[0]);
	assert.match(hint("input"), /tab your call .*enter send .*alt\+1-4 lenses .*alt\+z zoom .*alt\+m detail/);
	for (const context of FLEET_HINT_CONTEXTS) for (const density of ["light", "power"] as const) assert.doesNotMatch(hint(context, density), /\bF\d/, `${context}/${density}`);
	// Letter keys act only outside the input, so the input hint never offers them.
	assert.doesNotMatch(hint("input"), /\? help|f m \$ l/);
	assert.doesNotMatch(hint("input"), /more detail|the current task per member/, "the short hint");
	assert.match(hint("focal"), /1-4 choose .*tab back to the conversation .*f m \$ l lenses .*z zoom .*\? help/);
	assert.match(hint("lens"), /f m \$ l switch lens .*z zoom/);
	assert.match(hint("zoom"), /z back to the conversation/);
});

// T5-U3 (design/fleet-tui/05-calm-deck.html): the deck renders from the first
// frame, with an empty state in every part, and the permission mode lives in
// the status line instead of a card.
const EMPTY: FleetViewSnapshot = { title: null, objective: null, members: [], log: [] };

test("an empty fleet invites the human to state the objective and says nothing needs them yet", () => {
	const queue = attentionQueue(EMPTY);
	const [objective, focal] = renderObjectiveStrip(objectiveProgress(EMPTY), queue, 180, theme).map(stripAnsi);
	assert.equal(objective, "◎ No objective yet — tell the fleet what you want to achieve");
	assert.equal(focal, "◌ Nothing needs you yet. No member is working yet.");
	assert.deepEqual(renderFocalBar(queue, 180, theme), []);
	assert.match(stripAnsi(renderStatusLine(fleetStatus(EMPTY, queue), "flows", "light", 180, theme)[0]), /^0 of 0 members live · nothing needs you +lens flows · density light$/);
	// A stated objective without members keeps the progress strip.
	const stated = { ...EMPTY, title: "Ship team workspaces" };
	assert.match(stripAnsi(renderObjectiveStrip(objectiveProgress(stated), attentionQueue(stated), 180, theme)[0]), /^◎ Ship team workspaces · .*0% of the plan/);
});

test("each lens's empty state is one short, muted, centered line in light density", () => {
	const expected = { flows: "No members yet", map: "No map yet", costs: "No spend yet", log: "No events yet" };
	for (const lens of FLEET_LENSES) for (const width of [30, 46]) {
		const lines = renderLensPanel(lensRows(lens, "light", EMPTY), width, theme);
		const text = lines.map(stripAnsi).filter((line) => line.trim());
		assert.deepEqual(text.map((line) => line.trim()), [expected[lens]], `${lens}@${width}`);
		const pad = text[0].length - text[0].trimStart().length;
		assert.ok(Math.abs(pad - (width - expected[lens].length - pad)) <= 1, `${lens}@${width} centered`);
		for (const line of lines) assert.ok(visibleWidth(line) <= width && !line.includes(ACCENT));
	}
});

test("the status line carries the controller's super-yolo as one segment; other modes add nothing", () => {
	const line = (permission?: string) => stripAnsi(renderStatusLine(fleetStatus({ ...EMPTY, permission }), "flows", "light", 180, theme)[0]);
	assert.match(line("super-yolo"), /^0 of 0 members live · nothing needs you · super-yolo: auto-approves guarded prompts +lens flows/);
	for (const permission of [undefined, "normal", "yolo", "auto"]) assert.doesNotMatch(line(permission), /yolo|auto-approves/, String(permission));
});

test("the lens bar is a tab bar: four tabs, the active one selected in accent, an alt+1-4 hint, and an underline", () => {
	const [tabs, rule] = renderLensBar("costs", 46, theme);
	assert.match(stripAnsi(tabs), /^ Flows {2}Map {2}Costs {2}Log +alt\+1-4$/);
	assert.equal(visibleWidth(tabs), 46);
	assert.ok(tabs.includes(`\x1b[48;5;236m${BOLD}${ACCENT} Costs `), "the active tab: selected background, bold, accent");
	assert.equal(stripAnsi(rule), `${"─".repeat(12)}${"━".repeat(7)}${"─".repeat(27)}`, "the rule underlines the active tab");
	for (const width of [20, 30]) for (const line of renderLensBar("flows", width, theme)) assert.ok(visibleWidth(line) <= width);
});

test("the fleet column: title, objective with a slim gauge, the tab bar, a blank row, then the lens; filled to its height", () => {
	const stated = inkwellFleet();
	const lines = renderFleetColumn("flows", lensRows("flows", "light", stated), objectiveProgress(stated), 47, theme, 40);
	assert.equal(lines.length, 40);
	const text = lines.map(stripAnsi);
	assert.ok(text.every((line) => line.startsWith("│ ")), "one edge and one column of padding on every row");
	assert.equal(text[0].trimEnd(), "│ ✿ Fleet");
	assert.equal(text[1].trimEnd(), "│ Team workspaces for Inkwell");
	assert.match(text[2], /^│ [▰▱]{8} 0 of 5 fronts/);
	assert.equal(text[3].trim(), "│");
	assert.match(text[4], /^│ {2}Flows {2}Map/);
	assert.match(text[5], /^│ ━+─+/);
	assert.equal(text[6].trim(), "│");
	assert.ok(text.some((line) => line.includes("web-invite-flow")));
	for (const line of lines) assert.ok(visibleWidth(line) <= 47);
	// Accent marks only the active tab and the focal member.
	assert.deepEqual(lines.filter((line) => line.includes(ACCENT)).map((line) => stripAnsi(line).includes("Flows") || stripAnsi(line).includes("web-invite-flow") || /━/.test(stripAnsi(line))), lines.filter((line) => line.includes(ACCENT)).map(() => true));
});

test("an empty fleet column has no objective block and centers the lens's empty line in the space left", () => {
	const lines = renderFleetColumn("map", lensRows("map", "light", EMPTY), objectiveProgress(EMPTY), 47, theme, 30).map(stripAnsi);
	assert.equal(lines.length, 30);
	assert.equal(lines[0].trimEnd(), "│ ✿ Fleet");
	assert.equal(lines[1].trim(), "│");
	assert.match(lines[2], /^│ {2}Flows {2}Map/);
	const row = lines.findIndex((line) => line.includes("No map yet"));
	assert.ok(row > 10 && row < 20, `vertically centered: row ${row}`);
	// Taller content keeps every line; the rail scrolls.
	assert.ok(renderFleetColumn("flows", lensRows("flows", "normal", inkwellFleet()), objectiveProgress(inkwellFleet()), 47, theme, 5).length > 5);
});

test("before the objective, a welcome card offers the first message: a sentence, example prompts and the keys", () => {
	for (const width of [60, 120]) {
		const lines = renderWelcomeCard(width, theme);
		// The card wraps long lines; read it as words.
		const text = lines.map(stripAnsi).join(" ").replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
		assert.match(text, /Start a fleet/);
		assert.match(text, /Describe the objective; the fleet splits it into fronts and runs a member for each\./);
		assert.match(text, /Ship team workspaces for Inkwell: API, web app and docs/);
		assert.match(text, /Run my YouTube channel this week: script, edit, publish shorts/);
		assert.match(text, /enter send · alt\+1-4 lenses · alt\+z zoom · alt\+m detail/);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${stripAnsi(line)}`);
	}
});

// T10 (S9): the hints and the welcome card list the members' agents modal key.
test("the hints and the welcome card offer alt+w from the input and w in the focal bar and the zoom", () => {
	const queue = attentionQueue(inkwellFleet());
	const hint = (context: (typeof FLEET_HINT_CONTEXTS)[number]) => stripAnsi(renderHintLine(context, queue, "light", 180, theme)[0]);
	assert.match(hint("input"), /alt\+m detail .*alt\+w agents .*@name talk to one member/);
	assert.match(hint("focal"), /z zoom .*w agents .*\? help/);
	assert.match(hint("zoom"), /f m \$ l switch lens .*w agents/);
	assert.doesNotMatch(hint("input"), /(^|\s)w agents/, "no bare letter from the input");
	const welcome = renderWelcomeCard(120, theme).map(stripAnsi).join(" ").replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
	assert.match(welcome, /alt\+m detail · alt\+w agents/);
});
