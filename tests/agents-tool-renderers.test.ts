import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CARD_CONTENT, cardContent, setCardContent } from "../lib/card-content-policy.ts";
import { applyTaskEvent, emptyThread, RETAINED_DIFF_MAX_BYTES, RETAINED_DIFF_MAX_LINES, TASK_EVENT, type ToolItem } from "../lib/agents-protocol.ts";
import productionQuietTools from "../extensions/quiet-tools.ts";
import {
	agentToolRowRenderer,
	isReusableAgentToolRenderer,
	renderAgentToolItem,
	type AgentToolRendererTheme,
} from "../lib/agents-tool-renderers.ts";

initTheme("dark");

const plainTheme: AgentToolRendererTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

// The roles a card names, so an assertion can see which tone drew a row.
const taggedTheme: AgentToolRendererTheme = {
	fg: (color, text) => `[${color}]${text}`,
	bold: (text) => text,
};

// Every quiet tool's own retained arguments: the boundary must draw each one
// with the chat's renderer, so an availability test needs a real call per tool.
const CALL_ARGS: Record<string, Record<string, unknown>> = {
	read: { path: "src/a.ts" },
	grep: { pattern: "needle", path: "src" },
	find: { pattern: "*.ts", path: "src" },
	ls: { path: "src" },
	edit: { path: "src/b.ts", edits: [] },
	write: { path: "src/c.ts", content: "body" },
	bash: { command: "printf hi" },
};

function toolItem(overrides: Partial<ToolItem> & { name: string }): ToolItem {
	return {
		kind: "tool",
		callId: "call-1",
		args: CALL_ARGS[overrides.name] ?? {},
		output: "",
		running: false,
		isError: false,
		...overrides,
	};
}

function textResult(text: string) {
	return { content: [{ type: "text", text }], details: undefined };
}

function plainComponent() {
	return { render: () => [], invalidate() {} };
}

interface QuietToolsHost {
	tools: Map<string, any>;
	resolvers: Array<(toolName: string, next: () => unknown) => unknown>;
}

/** Loads the production quiet-tools extension against a fake pi, capturing what it actually registers. */
function registeredQuietTools(env: { quietTools?: string } = {}): QuietToolsHost {
	const tools = new Map<string, any>();
	const resolvers: Array<(toolName: string, next: () => unknown) => unknown> = [];
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		on() {},
		registerToolRenderer(resolver: (toolName: string, next: () => unknown) => unknown) {
			resolvers.push(resolver);
		},
	};
	const previous = process.env.GENTLE_PI_QUIET_TOOLS;
	if (env.quietTools === undefined) delete process.env.GENTLE_PI_QUIET_TOOLS;
	else process.env.GENTLE_PI_QUIET_TOOLS = env.quietTools;
	try {
		productionQuietTools(pi as any);
	} finally {
		if (previous === undefined) delete process.env.GENTLE_PI_QUIET_TOOLS;
		else process.env.GENTLE_PI_QUIET_TOOLS = previous;
	}
	return { tools, resolvers };
}

function useCardContent(t: { after(fn: () => void): void }, level: (typeof CARD_CONTENT)[keyof typeof CARD_CONTENT]): void {
	const previous = cardContent();
	t.after(() => setCardContent(previous));
	setCardContent(level);
}

test("the row draws with the very renderer the chat's canvas was handed", (t) => {
	const { tools } = registeredQuietTools();
	const row = agentToolRowRenderer("read");
	assert.notEqual(row, undefined, "the chat's read renderer is offered");
	const handed = tools.get("read");
	assert.equal(row!.renderCall, handed.renderCall, "the call slot is the function the host was handed, not a lookalike");
	assert.equal(row!.renderResult, handed.renderResult, "the result slot is the function the host was handed");
	assert.equal(row!.renderShell, "self", "the offered renderer owns its frame");

	useCardContent(t, CARD_CONTENT.MINIMAL);
	const minimal = registeredQuietTools();
	const native = { native: true };
	const bash = minimal.resolvers.at(-1)!("bash", () => native) as any;
	assert.notEqual(bash, native, "minimal content takes over bash drawing");
	const bashRow = agentToolRowRenderer("bash");
	assert.equal(bashRow!.renderCall, bash.renderCall, "the offered bash renderer is the object the resolver handed the host");
	assert.equal(bashRow!.renderResult, bash.renderResult);
});

test("the bash renderer is offered as soon as minimal content is active, before the host resolves it", (t) => {
	useCardContent(t, CARD_CONTENT.MINIMAL);
	const { resolvers } = registeredQuietTools();
	// No resolver call has been made yet: the host has not asked for bash.
	const row = agentToolRowRenderer("bash");
	assert.notEqual(row, undefined, "the chat's bash renderer is offered before the host asks for it");
	const lines = renderAgentToolItem(toolItem({ name: "bash", output: "hi" }), plainTheme, 80, { expanded: false });
	assert.match(lines!.join("\n"), /printf hi/, "and it draws the chat's bash card");

	const native = { native: true };
	const handed = resolvers.at(-1)!("bash", () => native) as any;
	assert.notEqual(handed, native, "the host takes over bash drawing under minimal content");
	assert.equal(handed, row, "the host is handed the very object that was offered, not a copy");
});

test("the bash offer follows the Card content preference live", (t) => {
	useCardContent(t, CARD_CONTENT.MINIMAL);
	const { resolvers } = registeredQuietTools();
	const native = { native: true };
	const offered = agentToolRowRenderer("bash");
	assert.notEqual(offered, undefined, "minimal content offers bash");
	assert.notEqual(resolvers.at(-1)!("bash", () => native), native, "and the host defers nothing while minimal content is active");

	setCardContent(CARD_CONTENT.DEFAULT);
	assert.equal(agentToolRowRenderer("bash"), undefined, "the offer withdraws when the chat goes back to pi's drawing");
	assert.equal(resolvers.at(-1)!("bash", () => native), native, "and the host defers to pi again");

	setCardContent(CARD_CONTENT.MINIMAL);
	assert.equal(agentToolRowRenderer("bash"), offered, "returning to minimal content offers the same object again");
});

test("a disabled extension publishes no renderer to reuse", () => {
	const host = registeredQuietTools({ quietTools: "0" });
	assert.equal(host.tools.size, 0, "a disabled extension registers no tool");
	assert.equal(agentToolRowRenderer("read"), undefined, "and offers no renderer");
	assert.equal(renderAgentToolItem(toolItem({ name: "read", output: "line one" }), plainTheme, 80, { expanded: false }), undefined);
});

test("native bash is not claimed while quiet-tools keeps pi's own drawing", () => {
	const { resolvers } = registeredQuietTools();
	const native = { native: true };
	assert.equal(resolvers.at(-1)!("bash", () => native), native, "the default content preference leaves bash to pi");
	assert.equal(agentToolRowRenderer("bash"), undefined, "so no bash renderer is offered as reusable");
	assert.equal(renderAgentToolItem(toolItem({ name: "bash", output: "hi" }), plainTheme, 80, { expanded: false }), undefined);
});

test("the row gate requires a frame the renderer owns and a call slot", () => {
	assert.equal(isReusableAgentToolRenderer(undefined), false, "nothing registered is nothing to reuse");
	assert.equal(isReusableAgentToolRenderer({ renderShell: "default", renderCall: plainComponent } as any), false, "a renderer that does not own its frame cannot draw a whole row");
	assert.equal(isReusableAgentToolRenderer({ renderShell: "self" } as any), false, "a renderer with no call slot cannot draw the call");
	assert.equal(isReusableAgentToolRenderer({ renderShell: "self", renderCall: plainComponent } as any), true, "a self-shelled renderer with a call slot is reusable");
	// A renderer that says nothing about the result is still reusable: it draws its
	// call slot alone, which is different from a tool with no card at all.
	assert.equal(isReusableAgentToolRenderer({ renderShell: "self", renderCall: plainComponent, renderResult: undefined } as any), true);
	assert.equal(renderAgentToolItem(toolItem({ name: "webfetch", output: "page" }), plainTheme, 80, { expanded: false }), undefined, "a tool with no registered card keeps the generic block");
});

test("every renderer quiet-tools actually registers is offered, and nothing else is", (t) => {
	const { tools } = registeredQuietTools();
	const registeredNames = [...tools.keys()].sort();
	const offered = registeredNames.filter((name) => agentToolRowRenderer(name) !== undefined);
	assert.deepEqual(offered, ["edit", "find", "grep", "ls", "read", "write"], "every quiet tool card is offered, derived from what was registered");
	assert.equal(registeredNames.includes("codemode"), true, "the extension also decorates the compact codemode tool");
	// Its renderer wraps a tool definition only the codemode extension can build, so
	// there is no registered quiet renderer to reuse here.
	assert.equal(agentToolRowRenderer("codemode"), undefined);
	assert.equal(agentToolRowRenderer("webfetch"), undefined);
	for (const name of offered) {
		assert.ok(renderAgentToolItem(toolItem({ name, output: "retained output" }), plainTheme, 80, { expanded: false })!.length > 0, `${name}: the card is not empty`);
	}
});

test("a finished item draws through the extension's registered renderer, not a copy", () => {
	const { tools } = registeredQuietTools();
	const registered = tools.get("grep");
	const item = toolItem({ name: "grep", args: { pattern: "needle", path: "src" }, output: "src/a.ts:1:needle\nsrc/b.ts:7:needle" });
	// A transcript row renders the call slot and then the result slot; the same
	// two components pi handed the chat, at the same width, are the contract.
	const context = {
		args: item.args,
		toolCallId: item.callId,
		cwd: "",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		isError: false,
		expanded: false,
		lastComponent: undefined,
		invalidate() {},
	};
	const expected = [
		...registered.renderCall(item.args, plainTheme, context).render(80),
		...registered.renderResult(textResult(item.output), { expanded: false, isPartial: false }, plainTheme, context).render(80),
	];
	assert.deepEqual(renderAgentToolItem(item, plainTheme, 80, { expanded: false }), expected);
	assert.match(expected.join("\n"), /needle/, "the expected rows carry the real match");
});

test("the offered card keeps running, final, error, and expanded states distinct", () => {
	registeredQuietTools();
	const running = renderAgentToolItem(toolItem({ name: "read", running: true, output: "" }), plainTheme, 60, { expanded: false })!;
	assert.match(running.join("\n"), /running…/, "a running call says it is still waiting");
	assert.equal(running.at(-1)!.startsWith("╰"), true, "a running call closes its own frame");
	assert.doesNotMatch(running.join("\n"), /line one/, "no result rows before output arrives");

	const output = "line one\nline two\nline three\nline four";
	const finished = renderAgentToolItem(toolItem({ name: "read", output }), plainTheme, 60, { expanded: false })!;
	assert.match(finished[0], /^╭─ ≡ read src\/a\.ts/, "the finished row still names the call");
	assert.match(finished.join("\n"), /line one/, "the collapsed card previews the result");
	assert.doesNotMatch(finished.join("\n"), /line four/, "a collapsed preview stays bounded");
	assert.equal(finished.at(-1)!.startsWith("╰"), true, "the result slot closes the frame");

	const expanded = renderAgentToolItem(toolItem({ name: "read", output }), plainTheme, 60, { expanded: true })!;
	assert.match(expanded.join("\n"), /line four/, "expanding reveals the rest of the result");

	const failed = renderAgentToolItem(toolItem({ name: "read", isError: true, output: "boom one\nboom two" }), taggedTheme, 80, { expanded: false })!;
	assert.match(failed.join("\n"), /\[error\]/, "a failed call is drawn in the error tone");
	assert.match(failed.join("\n"), /boom one/, "a failed call says why while collapsed");
});

test("the minimal Card content preference is honored by the offered card", (t) => {
	useCardContent(t, CARD_CONTENT.MINIMAL);
	registeredQuietTools();
	const lines = renderAgentToolItem(toolItem({ name: "read", output: "line one\nline two" }), plainTheme, 60, { expanded: false })!;
	assert.match(lines.join("\n"), /read src\/a\.ts/, "the command alone is still named");
	assert.doesNotMatch(lines.join("\n"), /line one/, "minimal content draws no result rows while collapsed");
});

test("retained input reaches the card cleaned, and the item itself is never mutated", () => {
	registeredQuietTools();
	const written = toolItem({
		name: "write",
		args: { path: "/repo/\u001b[31msecret.ts", content: "body\u0007" },
		output: "Successfully wrote 4 bytes",
	});
	const painted = renderAgentToolItem(written, plainTheme, 80, { expanded: true })!.join("\n");
	assert.equal(painted.includes("\u001b"), false, "escape sequences never reach the terminal");
	assert.equal(painted.includes("\u0007"), false, "control bytes never reach the terminal");
	assert.match(painted, /body/, "the written content is drawn cleaned");
	assert.equal(written.args.path, "/repo/\u001b[31msecret.ts", "the retained item is the caller's, not a scratch copy to clean");

	const read = toolItem({ name: "read", args: { path: "/repo/\u001b[31msecret.ts" }, output: "\u001b[2Jvisible" });
	const visible = renderAgentToolItem(read, plainTheme, 80, { expanded: false })!.join("\n");
	assert.equal(visible.includes("\u001b"), false, "the retained output is cleaned too");
	assert.match(visible, /visible/, "the clean text is still drawn");
	assert.equal(read.output, "\u001b[2Jvisible", "the retained output is forwarded, not rewritten in place");
});

test("a renderer that cannot draw leaves the row to the generic fallback", () => {
	registeredQuietTools();
	const brokenTheme: AgentToolRendererTheme = {
		fg: () => {
			throw new Error("theme cannot paint");
		},
	};
	assert.equal(renderAgentToolItem(toolItem({ name: "read", output: "line one" }), brokenTheme, 80, { expanded: false }), undefined, "a throwing card returns the row to its fallback instead of breaking it");
	assert.deepEqual(renderAgentToolItem(toolItem({ name: "read" }), plainTheme, 0, { expanded: false }), [], "a zero-width row draws nothing");
});

test("the offered card fits every terminal width it is drawn at", () => {
	registeredQuietTools();
	const output = Array.from({ length: 8 }, (_, index) => `line ${index} of the retained result`).join("\n");
	for (const width of [8, 12, 20, 40, 80, 120]) {
		for (const running of [true, false]) {
			const lines = renderAgentToolItem(toolItem({ name: "read", output, running }), plainTheme, width, { expanded: false })!;
			assert.ok(lines.length > 0, `width ${width}: the card draws`);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `"${line}" fits width ${width}`);
		}
	}
});

/** A retained edit item exactly as the protocol leaves one after its tool_end. */
function retainedEdit(diff: string | undefined, overrides: Partial<ToolItem> = {}): ToolItem {
	let thread = applyTaskEvent(emptyThread(), { type: TASK_EVENT.TOOL_START, callId: "call-1", name: "edit", args: CALL_ARGS.edit! });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_END, callId: "call-1", output: "Successfully replaced 1 block", isError: false, ...(diff === undefined ? {} : { diff }) });
	return { ...(thread.items[0] as ToolItem), ...overrides };
}

/** The rows the chat draws for this item, with the details the chat itself was handed. */
function chatRows(item: ToolItem, details: unknown): string[] {
	const renderer = agentToolRowRenderer(item.name)!;
	const context = { args: item.args, toolCallId: item.callId, cwd: "", executionStarted: true, argsComplete: true,
		isPartial: item.running, isError: item.isError, expanded: false, lastComponent: undefined, invalidate() {} };
	const rows = renderer.renderCall(item.args, plainTheme as any, context as any).render(80);
	if (item.running && item.output.length === 0) return rows;
	return [...rows, ...renderer.renderResult!({ content: [{ type: "text", text: item.output }], details },
		{ expanded: false, isPartial: item.running }, plainTheme as any, context as any).render(80)];
}

test("an edit card draws the retained diff through the chat's renderer, counters included", () => {
	registeredQuietTools();
	const diff = "+added line\n-removed line";
	const item = retainedEdit(diff);
	assert.deepEqual(renderAgentToolItem(item, plainTheme, 80, { expanded: false }), chatRows(item, { diff }), "the chat's own result slot is handed the diff, and nothing is drawn around it");
	const painted = renderAgentToolItem(item, plainTheme, 80, { expanded: false })!.join("\n");
	assert.match(painted, /✓ \+1 \/ -1/, "the counters the chat derives from the diff are drawn");
	assert.match(painted, /\+added line/, "an added row is drawn");
	assert.match(painted, /-removed line/, "a removed row is drawn");
});

test("a running edit with no diff yet draws only its call row", () => {
	registeredQuietTools();
	const item = toolItem({ name: "edit", running: true, output: "" });
	const renderer = agentToolRowRenderer("edit")!;
	const context = { args: item.args, toolCallId: item.callId, cwd: "", executionStarted: true, argsComplete: true,
		isPartial: true, isError: false, expanded: false, lastComponent: undefined, invalidate() {} };
	const lines = renderAgentToolItem(item, plainTheme, 80, { expanded: false })!;
	assert.deepEqual(lines, renderer.renderCall(item.args, plainTheme as any, context as any).render(80), "the call slot closes the frame until a result arrives");
	assert.doesNotMatch(lines.join("\n"), /✓/, "no result summary is drawn");
});

test("a result without details.diff keeps today's card exactly", () => {
	registeredQuietTools();
	const plainEdit = retainedEdit(undefined);
	assert.deepEqual(renderAgentToolItem(plainEdit, plainTheme, 80, { expanded: false }), chatRows(plainEdit, undefined), "no details are invented for an edit that carried no diff");
	assert.match(renderAgentToolItem(plainEdit, plainTheme, 80, { expanded: false })!.join("\n"), /✓ applied/, "and the card says applied, as it does today");
});

test("an oversized diff is never retained or drawn, and the card falls back to the plain result", () => {
	registeredQuietTools();
	const atLineCap = Array.from({ length: RETAINED_DIFF_MAX_LINES }, () => "+x").join("\n");
	const lineKept = retainedEdit(atLineCap);
	assert.equal(lineKept.diff, atLineCap, "a diff exactly at the line cap is kept");
	assert.match(renderAgentToolItem(lineKept, plainTheme, 80, { expanded: false })!.join("\n"), /✓ \+400 \/ -0/, "and its counters are drawn");
	const overLines = retainedEdit(`${atLineCap}\n+x`);
	assert.equal(overLines.diff, undefined, "one line over the cap is dropped whole");
	assert.match(renderAgentToolItem(overLines, plainTheme, 80, { expanded: false })!.join("\n"), /✓ applied/, "the card falls back to the plain result");

	const atByteCap = `+${"x".repeat(RETAINED_DIFF_MAX_BYTES - 1)}`;
	const byteKept = retainedEdit(atByteCap);
	assert.equal(byteKept.diff, atByteCap, "a diff exactly at the byte cap is kept");
	assert.match(renderAgentToolItem(byteKept, plainTheme, 200, { expanded: false })!.join("\n"), /✓ \+1 \/ -0/, "and its counters are drawn");
	const overBytes = retainedEdit(`${atByteCap}x`);
	assert.equal(overBytes.diff, undefined, "one byte over the cap is dropped whole");
	assert.match(renderAgentToolItem(overBytes, plainTheme, 80, { expanded: false })!.join("\n"), /✓ applied/, "no partial diff and no marker row is drawn");
});

test("a retained diff reaches the card cleaned, and the item itself is never rewritten", () => {
	registeredQuietTools();
	const diff = "\u001b[31m+red\u001b[0m\n\u0007-blue";
	const item = toolItem({ name: "edit", diff });
	const painted = renderAgentToolItem(item, plainTheme, 80, { expanded: false })!.join("\n");
	assert.equal(painted.includes("\u001b"), false, "escape sequences in a restored diff never reach the terminal");
	assert.equal(painted.includes("\u0007"), false, "control bytes in a restored diff never reach the terminal");
	assert.match(painted, /\+red/, "the clean row is still drawn");
	assert.equal(item.diff, diff, "the retained item is the caller's, not a scratch copy to clean");
});

test("the edit diff changes no other result: errors and non-edit cards stay as they are", (t) => {
	registeredQuietTools();
	const failed = retainedEdit("+x", { isError: true, output: "boom one\nboom two" });
	assert.deepEqual(renderAgentToolItem(failed, plainTheme, 80, { expanded: false }), chatRows(failed, undefined), "an errored edit keeps the chat's error drawing");
	assert.match(renderAgentToolItem(failed, plainTheme, 80, { expanded: false })!.join("\n"), /boom one/);
	const read = toolItem({ name: "read", output: "line one" });
	assert.deepEqual(renderAgentToolItem(read, plainTheme, 80, { expanded: false }), chatRows(read, undefined), "a read card is byte-identical to the chat's drawing without details");
	useCardContent(t, CARD_CONTENT.MINIMAL);
	const bash = toolItem({ name: "bash", output: "hi" });
	assert.deepEqual(renderAgentToolItem(bash, plainTheme, 80, { expanded: false }), chatRows(bash, undefined), "a bash card is byte-identical to the chat's drawing without details");
});

/** The slot quiet-tools publishes its cards through; a test can publish one the way the extension does. */
const PUBLISHED_RENDERERS = Symbol.for("gentle-pi.quiet-tool-renderers");

/** Publishes a card that records every result object it is handed, restoring the slot afterwards. */
function recordingRenderer(t: { after(fn: () => void): void }, toolName: string): Array<Record<string, any>> {
	const slot = ((globalThis as any)[PUBLISHED_RENDERERS] ??= new Map<string, any>()) as Map<string, any>;
	const previous = slot.get(toolName);
	const results: Array<Record<string, any>> = [];
	slot.set(toolName, {
		renderer: {
			renderShell: "self",
			renderCall: plainComponent,
			renderResult(result: Record<string, any>) {
				results.push(result);
				return plainComponent();
			},
		},
		active: () => true,
	});
	t.after(() => {
		if (previous === undefined) slot.delete(toolName);
		else slot.set(toolName, previous);
	});
	return results;
}

test("the same retained item is handed the same result object on every frame", (t) => {
	const seen = recordingRenderer(t, "read");
	const item = toolItem({ name: "read", output: "line one" });
	renderAgentToolItem(item, plainTheme, 80, { expanded: false });
	renderAgentToolItem(item, plainTheme, 80, { expanded: false });
	assert.equal(seen.length, 2, "the card's result slot draws on both frames");
	assert.equal(seen[0], seen[1], "so a cache keyed on the result object can hit on the second frame");
	assert.deepEqual(seen[0], textResult("line one"), "and the object handed over is the chat's own result");
	// The width and the expanded flag are drawn per frame, so neither changes the object.
	renderAgentToolItem(item, plainTheme, 40, { expanded: true });
	assert.equal(seen[2], seen[0], "a resize or an expansion reuses the same retained result");
});

test("two retained items never share one result object", (t) => {
	const seen = recordingRenderer(t, "read");
	const first = toolItem({ name: "read", output: "line one" });
	const second = toolItem({ name: "read", output: "line one", callId: "call-2" });
	renderAgentToolItem(first, plainTheme, 80, { expanded: false });
	renderAgentToolItem(second, plainTheme, 80, { expanded: false });
	assert.equal(seen.length, 2, "both items drew a result");
	assert.notEqual(seen[0], seen[1], "identical text from two calls is still two results");
	assert.deepEqual(seen[0], seen[1], "with the same content each");
});

test("an item whose output changed is handed a different result object", (t) => {
	const seen = recordingRenderer(t, "read");
	let thread = applyTaskEvent(emptyThread(), { type: TASK_EVENT.TOOL_START, callId: "call-1", name: "read", args: CALL_ARGS.read! });
	thread = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_END, callId: "call-1", output: "line one", isError: false });
	const first = thread.items[0] as ToolItem;
	renderAgentToolItem(first, plainTheme, 80, { expanded: false });
	const updated = applyTaskEvent(thread, { type: TASK_EVENT.TOOL_UPDATE, callId: "call-1", output: "line one\nline two" });
	const second = updated.items[0] as ToolItem;
	assert.notEqual(second, first, "the protocol replaces the item when its output changes");
	renderAgentToolItem(second, plainTheme, 80, { expanded: false });
	assert.notEqual(seen[1], seen[0], "so the replacement item reads its own result instead of the stale one");
	assert.equal(seen[1]!.content[0].text, "line one\nline two", "and the new output is the one handed over");
});

test("reusing one result object changes no drawn row", (t) => {
	registeredQuietTools();
	const diff = "+added line\n-removed line";
	const cases: Array<{ label: string; item: ToolItem; details: unknown }> = [
		{ label: "edit with a retained diff", item: retainedEdit(diff), details: { diff } },
		{ label: "grep", item: toolItem({ name: "grep", output: "src/a.ts:1:needle\nsrc/b.ts:7:needle" }), details: undefined },
		{ label: "read", item: toolItem({ name: "read", output: "line one\nline two" }), details: undefined },
		{ label: "an error result", item: toolItem({ name: "read", isError: true, output: "boom one\nboom two" }), details: undefined },
	];
	for (const { label, item, details } of cases) {
		const expected = chatRows(item, details);
		assert.ok(expected.length > 0, `${label}: the chat draws rows for this call`);
		assert.deepEqual(renderAgentToolItem(item, plainTheme, 80, { expanded: false }), expected, `${label}: the first frame draws the chat's rows`);
		assert.deepEqual(renderAgentToolItem(item, plainTheme, 80, { expanded: false }), expected, `${label}: a frame reusing the result draws those same rows`);
	}
	useCardContent(t, CARD_CONTENT.MINIMAL);
	const minimalBash = toolItem({ name: "bash", output: "hi" });
	assert.deepEqual(renderAgentToolItem(minimalBash, plainTheme, 80, { expanded: false }), chatRows(minimalBash, undefined), "a bash card under minimal content draws the same rows on both frames");
});

/** Writes the shared slot as a third party would, restored once after the test. */
function rawSlot(t: { after(fn: () => void): void }): { set(value: unknown): void } {
	const state = globalThis as any;
	const had = Object.prototype.hasOwnProperty.call(state, PUBLISHED_RENDERERS);
	const previous = state[PUBLISHED_RENDERERS];
	t.after(() => {
		if (had) state[PUBLISHED_RENDERERS] = previous;
		else delete state[PUBLISHED_RENDERERS];
	});
	return {
		set(value: unknown) {
			state[PUBLISHED_RENDERERS] = value;
		},
	};
}

/** A card another extension could publish with no quiet-tools involved at all. */
const foreignCard = { renderShell: "self", renderCall: plainComponent };

test("a card published into the shared slot by another extension is offered, with no active flag needed", (t) => {
	const slot = new Map<string, any>();
	rawSlot(t).set(slot);
	slot.set("codegraph", { renderer: foreignCard });
	assert.equal(agentToolRowRenderer("codegraph"), foreignCard, "the pane reads the shared slot itself, so a publisher needs nothing from quiet-tools");
	assert.deepEqual(renderAgentToolItem(toolItem({ name: "codegraph", output: "graph" }), plainTheme, 80, { expanded: false }), [], "and the item draws through that card");

	slot.set("codegraph", { renderer: foreignCard, active: () => true });
	assert.equal(agentToolRowRenderer("codegraph"), foreignCard, "an active flag that says yes offers the card");
	slot.set("codegraph", { renderer: foreignCard, active: () => false });
	assert.equal(agentToolRowRenderer("codegraph"), undefined, "an active flag that says no withdraws it");
	assert.equal(renderAgentToolItem(toolItem({ name: "codegraph", output: "graph" }), plainTheme, 80, { expanded: false }), undefined, "and the item falls back");
});

test("a shared slot holding garbage offers nothing and never breaks a frame", (t) => {
	const slot = rawSlot(t);
	const cases: Array<[string, unknown]> = [
		["a string slot", "not a map"],
		["a plain object slot", { codegraph: { renderer: foreignCard } }],
		["a null slot", null],
	];
	for (const [label, value] of cases) {
		slot.set(value);
		assert.equal(agentToolRowRenderer("codegraph"), undefined, `${label}: nothing is offered`);
		assert.equal(renderAgentToolItem(toolItem({ name: "codegraph", output: "graph" }), plainTheme, 80, { expanded: false }), undefined, `${label}: the pane draws its own fallback instead of throwing`);
	}

	const throwingLookup = new Map<string, any>();
	throwingLookup.get = () => {
		throw new Error("third party broke its own map");
	};
	slot.set(throwingLookup);
	assert.equal(agentToolRowRenderer("codegraph"), undefined, "a lookup that throws offers nothing");

	const records: Array<[string, unknown]> = [
		["a null record", null],
		["a string record", "card"],
		["a record naming no renderer", {}],
		["a renderer that is not an object", { renderer: "card" }],
		["an active flag that is not a function", { renderer: foreignCard, active: true }],
		["an active flag that throws", { renderer: foreignCard, active: () => { throw new Error("boom"); } }],
		["a renderer without a call slot", { renderer: { renderShell: "self" } }],
		["a renderer that does not own its frame", { renderer: { renderShell: "default", renderCall: plainComponent } }],
	];
	const map = new Map<string, any>();
	slot.set(map);
	for (const [label, record] of records) {
		map.set("codegraph", record);
		assert.equal(agentToolRowRenderer("codegraph"), undefined, `${label}: nothing is offered`);
		assert.equal(renderAgentToolItem(toolItem({ name: "codegraph", output: "graph" }), plainTheme, 80, { expanded: false }), undefined, `${label}: the pane draws its own fallback`);
	}
});
