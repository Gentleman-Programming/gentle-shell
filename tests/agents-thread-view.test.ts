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

test("cards draw reasoning in the chat's own token and italic, and the log keeps its tone", () => {
	const theme = { fg: (color: string, text: string) => `[${color}]${text}`, italic: (text: string) => `<i>${text}</i>` };
	const reasoning = { kind: "thinking" as const, text: "why" };
	assert.deepEqual(renderThreadItem(reasoning, theme, 40, { presentation: "cards", thinkingExpanded: false }), ["<i>[thinkingText]Thinking...</i>"], "hidden reasoning wears the transcript's token and italic");
	assert.deepEqual(renderThreadItem(reasoning, theme, 40, { presentation: "cards", thinkingExpanded: true }), ["[customMessageLabel]Thinking", "<i>[thinkingText]  why</i>"], "shown reasoning is italic too");
	assert.deepEqual(renderThreadItem(reasoning, theme, 40), ["[customMessageLabel]Thinking", "[dim]  why"], "the labeled log keeps the tone it always had");
	assert.deepEqual(renderThreadItem(reasoning, { fg: (color: string, text: string) => `[${color}]${text}` }, 40, { presentation: "cards", thinkingExpanded: false }), ["[thinkingText]Thinking..."], "a theme without italic still draws the row");
});

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

test("the labelled log draws Markdown prose exactly as it always did", () => {
	loadQuietTools();
	for (const width of [20, 40, 80]) {
		assert.deepEqual(renderThreadItem({ kind: "text", text: "## Handoff\n\nplain words" }, plainTheme, width), ["Text", "  ## Handoff", "  ", "  plain words"], `the log keeps its label and its source at width ${width}`);
	}
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
	const prose = renderThreadItem({ kind: "text", text: "alpha" }, plainTheme, 40, { presentation: "cards" }).map((row) => row.trimEnd());
	assert.deepEqual(prose, [" alpha"], "prose is Markdown prose in card mode, with no label of its own");
});

test("cards draw assistant prose as the chat's Markdown, and the log keeps its labelled source", () => {
	const theme = {
		fg: (color: string, text: string) => `[${color}]${text}`,
		bold: (text: string) => `<b>${text}</b>`,
		italic: (text: string) => `<i>${text}</i>`,
	};
	const prose = { kind: "text" as const, text: "## Handoff\n\nsome *prose* here\n\n- one\n- two" };
	const cards = renderThreadItem(prose, theme, 40, { presentation: "cards" }).join("\n");
	assert.match(cards, /\[mdHeading\].*Handoff/, "a heading is drawn in the chat's heading role");
	assert.match(cards, /<b>Handoff<\/b>/, "and in the heading's own weight");
	assert.match(cards, /<i>prose<\/i>/, "inline emphasis is drawn, not echoed as source");
	assert.match(cards, /\[mdListBullet\]/, "a list keeps the chat's bullet role");
	assert.doesNotMatch(cards, /## Handoff|\*prose\*/, "the raw Markdown source never reaches a card");
	assert.doesNotMatch(cards, /\[customMessageLabel\]Text/, "a card carries no Text label");

	const log = renderThreadItem(prose, theme, 40, { presentation: "log" });
	assert.deepEqual(log, ["[customMessageLabel]Text", "[text]  ## Handoff", "[text]  ", "[text]  some *prose* here", "[text]  ", "[text]  - one", "[text]  - two"], "the log is byte-identical to the labelled source it always drew");

	for (const width of [12, 20, 40, 80]) {
		for (const row of renderThreadItem(prose, plainTheme, width, { presentation: "cards" })) assert.ok(visibleWidth(row) <= width, `"${row}" fits width ${width}`);
	}
	assert.deepEqual(renderThreadItem({ kind: "text", text: "alpha" }, theme, 10, { presentation: "cards" }).map((row) => row.trimEnd()), ["[text] alpha"], "below the Markdown renderer's own chrome the pane keeps plain wrapped prose");
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

test("the log draws thinking and every retained output line whole, whatever detail it is handed", () => {
	const resolved: ToolItem = { kind: "tool", callId: "call", name: "bash", args: {}, output: Array.from({ length: 8 }, (_, index) => `output line ${index}`).join("\n"), running: false, isError: false };
	const reasoning = { kind: "thinking" as const, text: Array.from({ length: 6 }, (_, index) => `thought ${index}`).join("\n") };
	const toolLines = (indent: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${indent}output line ${index}`);
	const whole = ["Tool · bash · Complete", "  Output", ...toolLines("    ", 8)];

	assert.deepEqual(renderThreadItem(resolved, plainTheme, 40), whole, "the log keeps its original whole result");
	assert.deepEqual(renderThreadItem(resolved, plainTheme, 40, { presentation: "log", expanded: false }), whole, "the log has no collapsed result");
	assert.deepEqual(renderThreadItem(resolved, plainTheme, 40, { presentation: "log", expanded: false, expandHint: "ctrl+o to expand" }), whole, "the log advertises no detail key");
	assert.deepEqual(renderThreadItem(reasoning, plainTheme, 40, { presentation: "log", thinkingExpanded: false }), ["Thinking", ...Array.from({ length: 6 }, (_, index) => `  thought ${index}`)], "the log never hides thinking");
	assert.deepEqual(renderThreadItem(reasoning, plainTheme, 40, { presentation: "log", thinkingExpanded: false }), ["Thinking", ...Array.from({ length: 6 }, (_, index) => `  thought ${index}`)], "nothing hides thinking in the log");
	assert.deepEqual(renderThreadItem({ kind: "thinking", text: "short single thought" }, plainTheme, 40, { thinkingExpanded: false }), ["Thinking", "  short single thought"], "short reasoning stays visible in the log too");
});

test("cards bound a collapsed result and hide thinking while expansion keeps every retained line", () => {
	const resolved: ToolItem = { kind: "tool", callId: "call", name: "bash", args: {}, output: Array.from({ length: 8 }, (_, index) => `output line ${index}`).join("\n"), running: false, isError: false };
	const reasoning = { kind: "thinking" as const, text: Array.from({ length: 6 }, (_, index) => `thought ${index}`).join("\n") };
	const toolLines = (indent: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${indent}output line ${index}`);

	assert.deepEqual(renderThreadItem(resolved, plainTheme, 40, { presentation: "cards", expanded: false }), ["Tool · bash · Complete", "  Output", ...toolLines("    ", 3), "    … 5 more lines"], "a collapsed card result keeps its bounded preview and the count it withholds");
	assert.deepEqual(renderThreadItem(resolved, plainTheme, 40, { presentation: "cards", expanded: false, expandHint: "ctrl+o to expand" }), ["Tool · bash · Complete", "  Output", ...toolLines("    ", 3), "    … 5 more lines · ctrl+o to expand"], "the preview names the key that draws the rest");
	assert.deepEqual(renderThreadItem(resolved, plainTheme, 40, { presentation: "cards", expanded: true }), ["Tool · bash · Complete", "  Output", ...toolLines("    ", 8)], "expanding draws every retained line");

	assert.deepEqual(renderThreadItem(reasoning, plainTheme, 40, { presentation: "cards", thinkingExpanded: false }), ["Thinking..."], "hidden thinking is exactly the chat's own row, never a preview of the reasoning");
	assert.deepEqual(renderThreadItem(reasoning, plainTheme, 40, { presentation: "cards", thinkingExpanded: true }), ["Thinking", ...Array.from({ length: 6 }, (_, index) => `  thought ${index}`)], "cards show every thinking line when shown");

	for (const text of ["only thought", "first thought\nsecond thought", "a\nb\nc"]) {
		assert.deepEqual(renderThreadItem({ kind: "thinking", text }, plainTheme, 40, { presentation: "cards", thinkingExpanded: false }), ["Thinking..."], "a short reasoning is hidden whole, never previewed");
		assert.deepEqual(renderThreadItem({ kind: "thinking", text }, plainTheme, 40, { presentation: "cards", thinkingExpanded: true }), ["Thinking", ...text.split("\n").map((line) => `  ${line}`)], "showing it again restores every line");
	}
	assert.deepEqual(renderThreadItem({ kind: "thinking", text: "" }, plainTheme, 40, { presentation: "cards", thinkingExpanded: false }), ["Thinking..."], "an empty thinking item is hidden the same way, with no content and no hint");
	assert.deepEqual(renderThreadItem(reasoning, plainTheme, 40, { presentation: "cards", thinkingExpanded: false, expandHint: "ctrl+o to expand" }), ["Thinking..."], "a collapsed tool hint never leaks onto hidden thinking");

	const short: ToolItem = { ...resolved, output: "one\ntwo" };
	assert.deepEqual(renderThreadItem(short, plainTheme, 40, { presentation: "cards", expanded: false }), ["Tool · bash · Complete", "  Output", "    one", "    two"], "a short result is never cut, so no remainder is invented");
	const empty: ToolItem = { ...resolved, output: "" };
	assert.deepEqual(renderThreadItem(empty, plainTheme, 40, { presentation: "cards", expanded: false }), ["Tool · bash · Complete"], "a call with nothing retained still claims no output");
	for (const width of [4, 8, 10, 20, 40, 80]) {
		for (const lines of [
			renderThreadItem(resolved, plainTheme, width, { presentation: "cards", expanded: false }),
			renderThreadItem(reasoning, plainTheme, width, { presentation: "cards", thinkingExpanded: false }),
			renderThreadItem(reasoning, plainTheme, width, { presentation: "cards", thinkingExpanded: false, expandHint: "ctrl+o to expand" }),
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
