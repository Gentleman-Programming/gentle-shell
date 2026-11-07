import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyThread, TASK_EVENT, applyTaskEvent, type ToolItem } from "../lib/agents-protocol.ts";
import { renderThreadItem } from "../lib/agents-thread-view.ts";
import { renderAgentToolItem } from "../lib/agents-tool-renderers.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import productionQuietTools from "../extensions/quiet-tools.ts";

const plainTheme = { fg: (_color: string, text: string) => text };
const taggedTheme = { fg: (color: string, text: string) => `[${color}]${text}` };

// Card mode is only real when the chat's renderers are actually registered, so
// this loads the production extension against a minimal host.
let quietToolsLoaded = false;
function loadQuietTools(): void {
	if (quietToolsLoaded) return;
	quietToolsLoaded = true;
	initTheme("dark");
	productionQuietTools({ registerTool() {}, registerCommand() {}, on() {}, registerToolRenderer() {} } as any);
}

function readItem(overrides: Partial<ToolItem> = {}): ToolItem {
	return { kind: "tool", callId: "call", name: "read", args: { path: "src/a.ts" }, output: "line 0\nline 1\nline 2\nline 3\nline 4", running: false, isError: false, ...overrides };
}

test("renderThreadItem presents every protocol kind as labeled, indented blocks", () => {
	assert.deepEqual(renderThreadItem({ kind: "text", text: "alpha\n\n  code" }, plainTheme, 30), ["Text", "  alpha", "  ", "    code"]);
	assert.deepEqual(renderThreadItem({ kind: "thinking", text: "first\nsecond\nthird" }, plainTheme, 30), ["Thinking", "  first", "  second", "  third"]);
	assert.deepEqual(renderThreadItem({ kind: "note", text: "keep this" }, plainTheme, 30), ["Note", "  keep this"]);
	assert.deepEqual(renderThreadItem({ kind: "tool", callId: "call", name: "bash", args: { command: "echo hi" }, output: "one\n\n  code", running: true, isError: false }, plainTheme, 30), ["Tool · bash · Running", "  Output", "    one", "    ", "      code"]);
});

test("renderThreadItem keeps multiline content and every retained tool-output line across terminal widths", () => {
	const toolOutput = Array.from({ length: 11 }, (_, index) => `output line ${index}`).join("\n");
	for (const width of [20, 30, 40, 60, 80, 120]) {
		const lines = renderThreadItem({ kind: "tool", callId: "call", name: "long-running-command", args: {}, output: toolOutput, running: false, isError: false }, plainTheme, width);
		assert.equal(lines[0].startsWith("Tool ·"), true, `tool remains labeled at width ${width}`);
		assert.equal(lines[1], "  Output");
		assert.equal(lines.includes("    output line 0"), true, `first retained output line remains visible at width ${width}`);
		assert.equal(lines.includes("    output line 10"), true, `last retained output line remains visible at width ${width}`);
		assert.equal(lines.filter((line) => line.startsWith("    output line")).length, 11, `no retained output line is capped at width ${width}`);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `"${line}" fits width ${width}`);
	}
	assert.deepEqual(renderThreadItem({ kind: "thinking", text: "one\n\ntwo\n  code" }, plainTheme, 40), ["Thinking", "  one", "  ", "  two", "    code"]);
});

test("the thread keeps its labeled log unless the caller selects cards", () => {
	loadQuietTools();
	const item = readItem();
	const log = ["Tool · read · Complete", "  Output", "    line 0", "    line 1", "    line 2", "    line 3", "    line 4"];
	assert.deepEqual(renderThreadItem(item, plainTheme, 40), log, "the default presentation is the existing log");
	assert.deepEqual(renderThreadItem(item, plainTheme, 40, { presentation: "log" }), log);
	const cards = renderThreadItem(item, plainTheme, 40, { presentation: "cards" });
	assert.deepEqual(cards, renderAgentToolItem(item, plainTheme, 40, { expanded: false }), "cards are the chat's own renderer output, not a second drawing");
	assert.match(cards.join("\n"), /≡ read/, "the offered read card draws the call");
	assert.equal(cards.includes("Tool · read · Complete"), false, "a card replaces the generic block instead of stacking on it");
	assert.deepEqual(renderThreadItem({ kind: "text", text: "alpha" }, plainTheme, 40, { presentation: "cards" }), ["Text", "  alpha"], "prose keeps its labeled block in card mode");
});

test("a tool the chat offered no renderer keeps the generic block in card mode", () => {
	loadQuietTools();
	const item = readItem({ name: "webfetch", args: {}, output: "page body" });
	assert.equal(renderAgentToolItem(item, plainTheme, 40, { expanded: false }), undefined, "the chat registers no webfetch card");
	assert.deepEqual(renderThreadItem(item, plainTheme, 40, { presentation: "cards" }), ["Tool · webfetch · Complete", "  Output", "    page body"], "the generic fallback is the existing labeled block, not a per-tool copy");
	assert.deepEqual(renderThreadItem({ ...item, isError: true }, plainTheme, 40, { presentation: "cards" })[0], "Tool · webfetch · Error");
});

test("cards keep running, final, error, expansion, and width from the chat's drawing", () => {
	loadQuietTools();
	const running = renderThreadItem(readItem({ running: true, output: "" }), plainTheme, 32, { presentation: "cards" });
	assert.match(running.join("\n"), /running…/, "a running call says it is still waiting");
	assert.equal(running.at(-1)?.startsWith("╰"), true, "a running call closes its own frame");
	assert.doesNotMatch(running.join("\n"), /line 0/, "no result rows before output arrives");

	const collapsed = renderThreadItem(readItem(), plainTheme, 32, { presentation: "cards" });
	assert.match(collapsed.join("\n"), /line 0/, "a finished card previews the result");
	assert.doesNotMatch(collapsed.join("\n"), /line 4/, "a collapsed preview stays bounded");
	assert.match(renderThreadItem(readItem(), plainTheme, 32, { presentation: "cards", expanded: true }).join("\n"), /line 4/, "expanding reveals the rest of the result");

	const failed = renderThreadItem(readItem({ isError: true, output: "boom one" }), taggedTheme, 40, { presentation: "cards" });
	assert.match(failed.join("\n"), /\[error\]/, "a failed call keeps the chat's error tone");
	assert.match(failed.join("\n"), /boom one/, "a failed call says why while collapsed");

	for (const width of [8, 12, 20, 40, 80]) {
		for (const expanded of [false, true]) {
			const lines = renderThreadItem(readItem(), plainTheme, width, { presentation: "cards", expanded });
			assert.ok(lines.length > 0, `width ${width}: the card draws`);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `"${line}" fits width ${width}`);
		}
	}
});

test("the log bounds a collapsed result and thinking while expansion keeps every retained line", () => {
	const resolved: ToolItem = { kind: "tool", callId: "call", name: "bash", args: {}, output: Array.from({ length: 8 }, (_, index) => `output line ${index}`).join("\n"), running: false, isError: false };
	const reasoning = { kind: "thinking" as const, text: Array.from({ length: 6 }, (_, index) => `thought ${index}`).join("\n") };
	const toolLines = (indent: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${indent}output line ${index}`);

	assert.deepEqual(renderThreadItem(resolved, plainTheme, 40, { presentation: "log", expanded: false }), ["Tool · bash · Complete", "  Output", ...toolLines("    ", 3), "    … 5 more lines"], "a collapsed result is a bounded preview with the count it withholds");
	assert.deepEqual(renderThreadItem(resolved, plainTheme, 40, { expanded: false, expandHint: { output: "ctrl+o to expand" } }), ["Tool · bash · Complete", "  Output", ...toolLines("    ", 3), "    … 5 more lines · ctrl+o to expand"], "the marker carries the key that draws the rest");
	assert.deepEqual(renderThreadItem(resolved, plainTheme, 40, { presentation: "log", expanded: true }), ["Tool · bash · Complete", "  Output", ...toolLines("    ", 8)], "expanding draws every retained line");
	assert.deepEqual(renderThreadItem(resolved, plainTheme, 40), ["Tool · bash · Complete", "  Output", ...toolLines("    ", 8)], "the log keeps drawing the whole retained result unless collapse is asked for");

	assert.deepEqual(renderThreadItem(reasoning, plainTheme, 40, { presentation: "log", thinkingExpanded: false }), ["Thinking", "  … hidden"], "hiding thinking keeps a neutral placeholder, not a preview of the reasoning");
	assert.deepEqual(renderThreadItem(reasoning, plainTheme, 40, { thinkingExpanded: false, expandHint: { thinking: "ctrl+t to expand" } }), ["Thinking", "  … hidden · ctrl+t to expand"], "the placeholder names the key that shows it again");
	assert.deepEqual(renderThreadItem(reasoning, plainTheme, 40, { thinkingExpanded: true }), ["Thinking", ...Array.from({ length: 6 }, (_, index) => `  thought ${index}`)], "thinking is shown whole when expanded");
	assert.deepEqual(renderThreadItem(reasoning, plainTheme, 40), ["Thinking", ...Array.from({ length: 6 }, (_, index) => `  thought ${index}`)], "thinking stays whole by default");
	assert.deepEqual(renderThreadItem(reasoning, plainTheme, 40, { presentation: "cards", thinkingExpanded: false }), ["Thinking", "  … hidden"], "both presentations hide thinking the same way");

	for (const text of ["only thought", "first thought\nsecond thought", "a\nb\nc"]) {
		for (const presentation of ["log", "cards"] as const) {
			const hidden = renderThreadItem({ kind: "thinking", text }, plainTheme, 40, { presentation, thinkingExpanded: false });
			assert.deepEqual(hidden, ["Thinking", "  … hidden"], `${presentation}: a short reasoning is hidden whole, never previewed`);
			assert.deepEqual(renderThreadItem({ kind: "thinking", text }, plainTheme, 40, { presentation, thinkingExpanded: true }), ["Thinking", ...text.split("\n").map((line) => `  ${line}`)], `${presentation}: showing it again restores every line`);
		}
	}
	assert.deepEqual(renderThreadItem({ kind: "thinking", text: "" }, plainTheme, 40, { thinkingExpanded: false }), ["Thinking"], "a thinking item with nothing retained claims nothing hidden");

	const short: ToolItem = { ...resolved, output: "one\ntwo" };
	assert.deepEqual(renderThreadItem(short, plainTheme, 40, { presentation: "log", expanded: false }), ["Tool · bash · Complete", "  Output", "    one", "    two"], "a short result is never cut, so no remainder is invented");
	const empty: ToolItem = { ...resolved, output: "" };
	assert.deepEqual(renderThreadItem(empty, plainTheme, 40, { presentation: "log", expanded: false }), ["Tool · bash · Complete"], "a call with nothing retained still claims no output");
	for (const width of [4, 8, 10, 20, 40, 80]) {
		for (const lines of [
			renderThreadItem(resolved, plainTheme, width, { expanded: false }),
			renderThreadItem(reasoning, plainTheme, width, { thinkingExpanded: false }),
			renderThreadItem(reasoning, plainTheme, width, { thinkingExpanded: false, expandHint: { thinking: "ctrl+t to expand" } }),
		]) {
			for (const rendered of lines) assert.ok(visibleWidth(rendered) <= width, `"${rendered}" fits width ${width}`);
		}
	}
});

test("a delivered message draws as the chat's Messaging agent card in cards only", () => {
	const note = { kind: "note" as const, text: "steered: also update the docs" };
	const cards = renderThreadItem(note, plainTheme, 60, { presentation: "cards" });
	const frame = stripAnsi(cards.join("\n"));
	assert.match(frame, /✉ {2}Messaging agent/, "a delivered message wears the chat's messaging identity, envelope gap included");
	assert.match(frame, /also update the docs/, "the delivered text is the card body");
	assert.doesNotMatch(frame, /^Note$/m, "the note label is replaced, not stacked on");
	assert.doesNotMatch(frame, /steered: also/, "the runner's marker is not part of the message");

	const log = ["Note", "  steered: also update the docs"];
	assert.deepEqual(renderThreadItem(note, plainTheme, 60), log, "the log keeps its labeled note");
	assert.deepEqual(renderThreadItem(note, plainTheme, 60, { presentation: "log" }), log, "naming the log changes nothing");

	for (const width of [10, 12, 20, 40, 60]) {
		for (const rendered of renderThreadItem(note, plainTheme, width, { presentation: "cards" })) {
			assert.ok(visibleWidth(rendered) <= width, `"${rendered}" fits width ${width}`);
		}
	}
});

test("a note that is not a delivered message keeps its own labeled block in card mode", () => {
	for (const text of [
		"asked: choose a target file",
		"retrying (1/2)",
		"error: the child crashed",
		"gentle-agents: requested tools missing in child: codegraph",
		"steered:   ",
	]) {
		assert.deepEqual(
			renderThreadItem({ kind: "note", text }, plainTheme, 60, { presentation: "cards" }),
			["Note", `  ${text}`],
			`"${text}" keeps its own label and its retained text`,
		);
	}
});

test("only a marker that leads the whole note makes it a received message", () => {
	const nested = { kind: "note" as const, text: "line one\nsteered: not a marker here" };
	assert.deepEqual(renderThreadItem(nested, plainTheme, 60, { presentation: "cards" }), ["Note", "  line one", "  steered: not a marker here"], "a marker on a later line is note text, not a message");
	const inline = { kind: "note" as const, text: "note about steered: text" };
	assert.deepEqual(renderThreadItem(inline, plainTheme, 60, { presentation: "cards" }), ["Note", "  note about steered: text"], "a marker inside a sentence is note text");

	const multiline = { kind: "note" as const, text: "steered: first line\nsteered: second line" };
	const rows = renderThreadItem(multiline, plainTheme, 60, { presentation: "cards" });
	const frame = stripAnsi(rows.join("\n"));
	assert.match(frame, /✉ {2}Messaging agent/, "a multiline delivery is still one received message");
	assert.match(frame, /first line/);
	assert.match(frame, /steered: second line/, "only the leading marker is removed; a later marker is message text");
	assert.doesNotMatch(frame, /^Note$/m);

	const spaced = { kind: "note" as const, text: "steered:  two spaces are the body" };
	assert.match(stripAnsi(renderThreadItem(spaced, plainTheme, 60, { presentation: "cards" }).join("\n")), /two spaces are the body/, "the marker is exactly `steered: ` and the rest is the body");
});

test("renderThreadItem renders actual sanitized retention markers and error status color", () => {
	let thread = emptyThread({ maxOutputChars: 24 });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_START, callId: "call", name: "bash", args: {} });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_END, callId: "call", output: "\u001b[31mfirst retained line\nlast retained line", isError: true });
	const item = thread.items[0];
	assert.equal(item?.kind, "tool");
	if (item?.kind !== "tool") throw new Error("expected the actual tool event to create a tool item");
	assert.equal(item.output.includes("\u001b"), false, "applyTaskEvent sanitizes terminal escapes before rendering");
	assert.equal(item.output.startsWith("…"), true, "the existing retention marker reaches the view unchanged");
	const lines = renderThreadItem(item, taggedTheme, 60);
	assert.equal(lines[0], "[error]Tool · bash · Error");
	assert.equal(lines[1], "[muted]  Output");
	assert.equal(lines.some((line) => line.includes("…")), true, "the renderer retains the protocol marker rather than inventing one");
	assert.deepEqual(renderThreadItem({ kind: "unknown" } as never, plainTheme, 30), []);
});
