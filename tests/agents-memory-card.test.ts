import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ToolItem } from "../lib/agents-protocol.ts";
import { isMemoryToolName, memoryToolArgument, memoryToolCard, memoryToolLabel } from "../lib/agents-memory-card.ts";

const plainTheme = { fg: (_color: string, text: string) => text };
const taggedTheme = { fg: (color: string, text: string) => `[${color}]${text}` };

function memoryItem(overrides: Partial<ToolItem> = {}): ToolItem {
	return { kind: "tool", callId: "call", name: "mem_save", args: { title: "Design notes", content: "a body" }, output: '{"ok":true}', running: false, isError: false, ...overrides };
}

test("only the memory tool namespace is claimed", () => {
	for (const name of ["mem_save", "mem_search", "mem_get_observation", "mem_session_summary", "mem_future_tool"]) {
		assert.equal(isMemoryToolName(name), true, `${name} belongs to the namespace`);
	}
	for (const name of ["mem", "mem_", "memory_save", "memories", "webfetch", "subagent_start", "mcp__tools__mem_save", "bash_read"]) {
		assert.equal(isMemoryToolName(name), false, `${name} is not a memory tool`);
	}
});

test("a memory tool reads as the plugin's friendly label, sanitized before it is drawn", () => {
	assert.equal(memoryToolLabel("mem_save"), "save");
	assert.equal(memoryToolLabel("mem_get_observation"), "get observation");
	assert.equal(memoryToolLabel("mem_session_summary"), "session summary");
	assert.equal(memoryToolLabel("mem_\u001b[31mweird"), "weird", "the derived label never carries an escape");
});

test("a finished memory call is exactly the plugin's two rows", () => {
	assert.deepEqual(memoryToolCard(memoryItem({ name: "mem_get_observation", args: { id: 9692 }, output: "payload" }), plainTheme, 60), [
		"🧠 get observation #9692 …",
		"↳ ✓ observation #9692",
	]);
});

test("the call row always ends with the plugin's ellipsis, never with a truncation marker", () => {
	const rows = memoryToolCard(memoryItem({ output: "a\nb\nc\nd\ne\nf" }), plainTheme, 60);
	assert.equal(rows[0], "🧠 save “Design notes” …", "the ellipsis is the style, not a withheld preview");
	assert.equal(rows.length, 2, "a result never adds rows of its own");
	assert.doesNotMatch(rows.join("\n"), /more lines?|ctrl\+o|expand/, "the card offers no preview and no key");
});

test("the result row reports the plugin's status word for every memory tool", () => {
	const cases: Array<[string, Record<string, unknown>, string]> = [
		["mem_search", { query: "phase" }, "✓ results"],
		["mem_search", {}, "✓ results"],
		["mem_save", { title: "Design notes" }, "✓ saved"],
		["mem_save", { title: "Design notes", id: 12 }, "✓ saved #12"],
		["mem_update", { id: 7, title: "t" }, "✓ updated #7"],
		["mem_update", { title: "t" }, "✓ updated"],
		["mem_delete", { id: 9 }, "✓ deleted #9"],
		["mem_delete", {}, "✓ deleted"],
		["mem_suggest_topic_key", { title: "t" }, "✓ suggested"],
		["mem_save_prompt", { content: "c" }, "✓ prompt saved"],
		["mem_session_start", { id: "s1" }, "✓ started"],
		["mem_session_end", { id: "s1" }, "✓ ended"],
		["mem_current_project", { cwd: "/repo" }, "✓ detected"],
		["mem_doctor", { check: "db" }, "✓ checked"],
		["mem_capture_passive", { content: "c" }, "✓ captured"],
		["mem_judge", { judgment_id: "j1" }, "✓ judged"],
		["mem_judge_many", {}, "✓ judged"],
		["mem_compare", { memory_id_a: 1, memory_id_b: 2 }, "✓ compared"],
		["mem_review", { action: "list" }, "✓ reviewed"],
		["mem_list_projects", {}, "✓ done"],
		["mem_context", {}, "✓ loaded"],
		["mem_consolidate", { new_title: "n" }, "✓ done"],
		["mem_pin", { id: 3 }, "✓ done"],
		["mem_unpin", { id: 3 }, "✓ done"],
		["mem_timeline", { observation_id: 5 }, "✓ timeline"],
		["mem_stats", {}, "✓ loaded"],
		["mem_session_summary", { content: "c" }, "✓ saved"],
		["mem_session_summary", { content: "c", id: 4 }, "✓ saved #4"],
		["mem_session_finalize", { project: "p" }, "✓ done"],
		["mem_get_observation", { id: 9692 }, "✓ observation #9692"],
		["mem_get_observation", {}, "✓ loaded"],
		["mem_future_tool", { anything: "x" }, "✓ done"],
	];
	for (const [name, args, expected] of cases) {
		assert.equal(memoryToolCard(memoryItem({ name, args, output: "payload" }), plainTheme, 80)[1], `↳ ${expected}`, `${name} reports its own status`);
	}
});

test("a search result without details prints no count", () => {
	const rows = memoryToolCard(memoryItem({ name: "mem_search", args: { query: "phase" }, output: '[{"id":1},{"id":2},{"id":3}]' }), plainTheme, 60);
	assert.equal(rows[1], "↳ ✓ results", "the plugin's count lives in details this pane never sees");
	assert.doesNotMatch(rows[1], /\d/, "no digit is invented");
});

test("the call row names the call with the plugin's own argument for that tool", () => {
	assert.equal(memoryToolArgument("mem_save", { title: "Design notes" }), "“Design notes”");
	assert.equal(memoryToolArgument("mem_save", { type: "decision", title: "later" }), "“later”", "the tool's own key order wins over the object's");
	assert.equal(memoryToolArgument("mem_get_observation", { id: 9692 }), "#9692", "an id is never quoted");
	assert.equal(memoryToolArgument("mem_compare", { memory_id_a: 3, memory_id_b: 4 }), "#3");
	assert.equal(memoryToolArgument("mem_timeline", { observation_id: 5 }), "#5");
	assert.equal(memoryToolArgument("mem_current_project", { cwd: "/repo" }), "“/repo”");
	assert.equal(memoryToolArgument("mem_judge_many", { ids: [1, 2] }), undefined, "a tool with no argument key shows none");
	assert.equal(memoryToolArgument("mem_future_tool", { anything: "x" }), undefined, "an unknown tool shows no argument either");
	assert.equal(memoryToolArgument("mem_save", { title: "   ", content: "" }), undefined, "blank arguments name nothing");
	assert.equal(memoryToolArgument("mem_save", undefined), undefined);
	assert.equal(memoryToolArgument("mem_search", { capture_prompt: false, query: "kept" }), "“kept”", "a boolean is not a name");
	assert.equal(memoryToolCard(memoryItem({ name: "mem_judge_many", args: {}, output: "" }), plainTheme, 60)[0], "🧠 judge many …", "a call with no argument is its label alone");
});

test("a quoted argument collapses to one row and keeps the plugin's bound", () => {
	assert.equal(memoryToolArgument("mem_save", { title: "a\nb\tc" }), "“a b c”", "a multi-line argument collapses to one row");
	const argument = memoryToolArgument("mem_save", { title: "A".repeat(200) });
	assert.ok(argument?.startsWith("“") && argument.endsWith("…”"), "a long argument is cut, never shown whole");
	assert.ok(argument !== undefined && visibleWidth(argument) <= 50, "the argument keeps its bounded width");
	assert.equal(memoryToolArgument("mem_get_observation", { id: "B".repeat(200) })?.endsWith("…"), true, "an id is bounded the same way");
});

test("a review call composes its argument the way the plugin does", () => {
	assert.equal(memoryToolArgument("mem_review", { action: "list", project: "gentle-shell", limit: 5 }), "“list” “gentle-shell” limit 5");
	assert.equal(memoryToolArgument("mem_review", { action: "show", observation_id: 9692, project: "p", limit: "3" }), "“show” #9692 “p” limit 3");
	assert.equal(memoryToolArgument("mem_review", { id: 7 }), "#7", "an observation id falls back to the call's id");
	assert.equal(memoryToolArgument("mem_review", { project: "p" }), "“p”", "a missing part is skipped, never filled in");
	assert.equal(memoryToolArgument("mem_review", {}), undefined);
});

test("a failed call reports the first line of what it retained, bounded", () => {
	assert.deepEqual(memoryToolCard(memoryItem({ isError: true, output: "boom: bad input\n    at frame\n    at other" }), taggedTheme, 80), [
		"[error]🧠 save “Design notes” …",
		"[muted]↳ ✗ boom: bad input",
	]);
	const long = memoryToolCard(memoryItem({ isError: true, output: `${"x".repeat(200)}\nsecond line` }), plainTheme, 120);
	assert.equal(long.length, 2, "a stack or a JSON dump never adds rows");
	assert.ok(visibleWidth(long[1]) <= 68, "the failure line is bounded to 64 columns plus the marker");
	assert.equal(long[1].endsWith("…"), true, "and says it was cut");
	const json = memoryToolCard(memoryItem({ isError: true, output: '{"error":"nope","stack":"a\\nb"}' }), plainTheme, 120);
	assert.equal(json.length, 2, "a JSON failure is one bounded row, never a dump");
	assert.deepEqual(memoryToolCard(memoryItem({ isError: true, output: "" }), plainTheme, 60), ["🧠 save “Design notes” …", "↳ ✗"], "a failure with nothing retained claims only failure");
	assert.deepEqual(memoryToolCard(memoryItem({ isError: true, output: "  \n collapsed \t words  " }), plainTheme, 60)[1], "↳ ✗ collapsed words", "the first retained words are collapsed to one row");
});

test("a running memory call draws its call row and claims no result", () => {
	assert.deepEqual(memoryToolCard(memoryItem({ name: "mem_search", args: { query: "phase" }, output: "", running: true }), plainTheme, 60), ["🧠 search “phase” …"]);
	assert.deepEqual(memoryToolCard(memoryItem({ output: "partial", running: true }), plainTheme, 60), ["🧠 save “Design notes” …"], "a running call with retained output still claims nothing");
	assert.deepEqual(memoryToolCard(memoryItem({ running: false, output: "" }), plainTheme, 60), ["🧠 save “Design notes” …", "↳ ✓ saved"], "a finished call reports its status with or without retained output");
});

test("no expansion flag changes a memory row", () => {
	const wider: (item: ToolItem, theme: typeof plainTheme, width: number, options: { expanded: boolean; hint?: string }) => string[] = memoryToolCard;
	const item = memoryItem({ output: Array.from({ length: 6 }, (_, index) => `line ${index}`).join("\n") });
	const rows = memoryToolCard(item, plainTheme, 60);
	assert.deepEqual(wider(item, plainTheme, 60, { expanded: false }), rows);
	assert.deepEqual(wider(item, plainTheme, 60, { expanded: true }), rows, "expanding changes nothing");
	assert.deepEqual(wider(item, plainTheme, 60, { expanded: true, hint: "ctrl+o to expand" }), rows, "a hint changes nothing");
});

test("terminal escapes and control characters never reach a memory row", () => {
	const item = memoryItem({
		args: { title: "\u001b[31mred\u001b[0m\u001b]0;title\u0007" },
		output: "safe\u001b]8;;http://example.invalid\u0007link\u001b]8;;\u0007\u0007",
	});
	const rows = memoryToolCard(item, plainTheme, 60);
	for (const row of rows) {
		assert.equal(row.includes("\u001b"), false, `"${row}" carries no escape`);
		assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(row), false, `"${row}" carries no control character`);
	}
	assert.equal(rows[0], "🧠 save “red” …", "the visible part of the argument is kept");

	const failed = memoryToolCard(memoryItem({ isError: true, output: "safe\u001b]8;;http://example.invalid\u0007link\u001b]8;;\u0007" }), plainTheme, 60);
	assert.equal(failed[1], "↳ ✗ safelink", "the visible part of the retained failure is kept");
});

test("a memory card fits every width it is asked to draw", () => {
	const items = [
		memoryItem(),
		memoryItem({ name: "mem_get_observation", args: { id: 9692 }, output: "payload" }),
		memoryItem({ running: true, output: "" }),
		memoryItem({ isError: true, output: Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n") }),
		memoryItem({ args: { title: "A".repeat(300) }, output: "x".repeat(300) }),
	];
	assert.deepEqual(memoryToolCard(memoryItem(), plainTheme, 0), [], "a zero width draws nothing");
	for (const width of [1, 3, 20, 80]) {
		for (const item of items) {
			const rows = memoryToolCard(item, plainTheme, width);
			assert.ok(rows.length > 0, `width ${width}: the card draws`);
			for (const row of rows) assert.ok(visibleWidth(row) <= width, `"${row}" fits width ${width}`);
		}
	}
});
