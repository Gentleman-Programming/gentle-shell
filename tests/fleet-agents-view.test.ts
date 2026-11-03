import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyThread, type TaskRecord, type ThreadItem } from "../lib/agents-protocol.ts";
import { renderThreadItem } from "../lib/agents-thread-view.ts";
import { taskHeader } from "../lib/agents-view.ts";
import { FleetAgentsView, type FleetAgentsMember } from "../lib/fleet-agents-view.ts";
import type { FleetMemberSubagent } from "../lib/fleet-member.ts";

// T10 (S9): the members-and-their-subagents modal of the fleet controller.

const theme = { fg: (_role: string, text: string) => text };
const NOW = 100_000;
const ESC = "\x1b";

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		id, agent: "sdd-apply", label: `Label of ${id}`, status: "running", createdAt: 1000, startedAt: 40_000, endedAt: null, lastActivityAt: 90_000,
		lastStep: `step of ${id}`, error: null, turns: 1, toolCalls: 2, mode: "background", prompt: "", cwd: "", parentSessionId: "",
		model: "", thinking: undefined, sessionPath: null, result: null, tokens: 0, cost: 0, ...overrides,
	};
}

function subagent(id: string, overrides: Partial<TaskRecord> = {}, items: ThreadItem[] = []): FleetMemberSubagent {
	return { task: task(id, overrides), thread: { ...emptyThread(), items } };
}

function member(name: string, status: string, subagents: FleetMemberSubagent[], extra: Partial<FleetAgentsMember> = {}): FleetAgentsMember & { list: FleetMemberSubagent[] } {
	const entry = { name, status, list: subagents, subagents: () => entry.list, ...extra };
	return entry;
}

function view(members: () => readonly FleetAgentsMember[], rows = 24) {
	const calls = { closed: 0, renders: 0 };
	const component = new FleetAgentsView({ theme, rows, members, now: () => NOW, onClose: () => { calls.closed += 1; }, requestRender: () => { calls.renders += 1; } });
	return { component, calls, text: (width = 120) => component.render(width).join("\n") };
}

const ITEMS: ThreadItem[] = [
	{ kind: "text", text: "Reading the invite routes" },
	{ kind: "tool", callId: "0", name: "edit", args: {}, output: "patched routes.ts", running: false, isError: false },
];

test("the list groups each member's state line, then its subagents with agent, status and elapsed", () => {
	const api = member("api", "working", [subagent("t1", { agent: "sdd-apply" }), subagent("t2", { agent: "explorer", status: "completed", endedAt: 70_000 })], { todo: { done: 2, total: 5, current: "Write routes" } });
	const web = member("web", "idle", [subagent("t3", { agent: "sdd-verify", status: "waiting" })]);
	const { text } = view(() => [api, web]);
	const lines = text().split("\n");
	const list = lines.map((line) => line.slice(0, 40));
	const at = (pattern: RegExp) => list.findIndex((line) => pattern.test(line));
	assert.match(lines[0], /Fleet agents · 2 members · 2 active subagents/);
	assert.ok(at(/api · working · todo 2\/5/) < at(/└ sdd-apply · running {2}1m00s/), "member line first, then its subagents");
	assert.ok(at(/└ sdd-apply · running/) < at(/└ explorer · completed {2}30s/));
	assert.ok(at(/└ explorer/) < at(/web · idle/));
	assert.ok(at(/web · idle/) < at(/└ sdd-verify · waiting/));
	assert.match(lines.at(-2)!, /j\/k select .*ctrl\+j\/k scroll .*f follow .*esc close/);
	assert.doesNotMatch(text(), /\bs\b stop|cancel|\[Stop\]/i, "read-only: no stop or cancel");
});

test("the selected subagent shows the /gentle:agents header, its label, last step and the thread through the shared renderer", () => {
	const api = member("api", "working", [subagent("t1", {}, ITEMS)]);
	const { component, text } = view(() => [api]);
	const output = text(120);
	const header = taskHeader(api.list[0].task, NOW);
	assert.equal(header, "sdd-apply · running · 1m00s");
	assert.ok(output.includes(header), "the right pane opens with taskHeader");
	assert.match(output, /Label of t1/);
	assert.match(output, /last step: step of t1/);
	// The right pane is 120 - 2 - 34 - 4 = 80 columns (measureAgentsViewLayout).
	for (const item of ITEMS) for (const line of renderThreadItem(item, theme, 80)) assert.ok(output.includes(line.trimEnd()), line);
	// j moves back to the member line: its summary instead of a thread.
	component.handleInput("k");
	assert.match(text(), /1 subagent · 1 active/);
});

test("empty states: no members, and a member with no subagents", () => {
	assert.match(view(() => []).text(), /no members yet/);
	const quiet = view(() => [member("docs", "idle", [])]);
	const output = quiet.text();
	assert.match(output, /docs · idle · no subagents/);
	assert.match(output, /no subagents yet/);
});

test("the modal is live: a new member push shows on the next render, and the selection stays on the same subagent", () => {
	const api = member("api", "working", [subagent("t1")]);
	const { component, text } = view(() => [api]);
	assert.match(text(), /└ sdd-apply · running/);
	api.list = [subagent("t0", { agent: "explorer" }), subagent("t1", { status: "completed", endedAt: 95_000 })];
	const output = text();
	assert.match(output, /└ explorer · running/);
	assert.match(output, /sdd-apply · completed · 55s/, "still the selected t1, now completed");
	component.handleInput("k");
	assert.match(text(), /explorer · running · 1m00s/);
});

test("esc, q and w close it; in a narrow terminal tab opens the details and esc goes back first", () => {
	for (const key of [ESC, "q", "w"]) {
		const { component, calls } = view(() => [member("api", "working", [subagent("t1")])]);
		component.handleInput(key);
		assert.equal(calls.closed, 1, JSON.stringify(key));
	}
	const narrow = view(() => [member("api", "working", [subagent("t1", {}, ITEMS)])]);
	assert.doesNotMatch(narrow.text(50), /Reading the invite routes/);
	assert.match(narrow.text(50), /tab details/);
	narrow.component.handleInput("\t");
	assert.match(narrow.text(50), /Reading the invite routes/);
	narrow.component.handleInput(ESC);
	assert.equal(narrow.calls.closed, 0);
	assert.doesNotMatch(narrow.text(50), /Reading the invite routes/);
	narrow.component.handleInput(ESC);
	assert.equal(narrow.calls.closed, 1);
});

test("the thread follows its tail, ctrl+k scrolls up, f follows again; no line exceeds the width", () => {
	const long = Array.from({ length: 30 }, (_, index): ThreadItem => ({ kind: "note", text: `note ${index}` }));
	const { component, text } = view(() => [member("api", "working", [subagent("t1", {}, long)])], 16);
	assert.match(text(), /note 29/);
	assert.doesNotMatch(text(), /note 0\b/);
	component.handleInput("\x0b");
	component.handleInput("\x0b");
	assert.doesNotMatch(text(), /note 29/);
	component.handleInput("f");
	assert.match(text(), /note 29/);
	for (const width of [8, 30, 50, 80, 160]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
	assert.equal(component.render(120).length, 16, "the modal fills the rows it is given");
});
