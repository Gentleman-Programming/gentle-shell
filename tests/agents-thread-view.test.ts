import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyThread, TASK_EVENT, applyTaskEvent } from "../lib/agents-protocol.ts";
import { renderThreadItem } from "../lib/agents-thread-view.ts";

const plainTheme = { fg: (_color: string, text: string) => text };
const taggedTheme = { fg: (color: string, text: string) => `[${color}]${text}` };

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
