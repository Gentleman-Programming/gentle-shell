import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { initTheme, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, setCapabilityOverrides, TuiAltScreen, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { buildShellBarModel, type ShellFooterData } from "../extensions/gentle-shell.ts";
import { createQuietToolRenderer } from "../extensions/quiet-tools.ts";
import gentleAgents, { AGENTS_RESULT_TYPE } from "../extensions/gentle-agents.ts";
import { JOB_NOTICE_TYPE } from "../lib/background-jobs-tools.ts";
import { CARD_CONTENT, cardContent, setCardContent } from "../lib/card-content-policy.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";

// Freeze the ANSI mode of the host-generated key hints in the byte checks.
setCapabilityOverrides({ trueColor: true });
initTheme("dark");

function transcriptCards(t: TestContext) {
	const home = mkdtempSync(join(tmpdir(), "render-cards-"));
	const previousStyle = cardStyle();
	const previousContent = cardContent();
	t.after(() => {
		setCardStyle(previousStyle);
		setCardContent(previousContent);
		rmSync(home, { recursive: true, force: true });
	});
	setCardStyle(CARD_STYLE.FLOAT);
	setCardContent(CARD_CONTENT.MINIMAL);
	const renderers = new Map<string, Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>();
	const tools = new Map<string, ToolDefinition>();
	gentleAgents({
		registerMessageRenderer: (type: string, render: Parameters<ExtensionAPI["registerMessageRenderer"]>[1]) => renderers.set(type, render),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand() {}, registerShortcut() {}, registerEntryRenderer() {}, registerMarkdownTransformer() {},
		on() {}, events: { on: () => () => {}, emit() {} },
	} as unknown as ExtensionAPI, { GENTLE_PI_CONFIG_HOME: home }, { home });
	const work = { agent: 0, job: 0, bash: 0, bashBody: 0, agentTool: 0 };
	let palette = 31;
	const theme = {
		fg(role: string, text: string) {
			// renderCard colors body paragraphs immediately before cardBodyRows wraps them.
			if (role === "text" && text.startsWith("Agent paragraph")) work.agent++;
			if (role === "text" && text.startsWith("Job paragraph")) work.job++;
			if (role === "toolOutput" && text.startsWith("Bash result")) work.bashBody++;
			return `\x1b[${palette}m${text}\x1b[39m`;
		},
		bg(role: string, text: string) {
			// The completed agent tool enters floatRows once before it wraps its answer.
			if (role === "toolSuccessBg") work.agentTool++;
			return `\x1b[48;5;${role === "toolErrorBg" ? 52 : 235}m${text}\x1b[49m`;
		},
		// Every bash heading uses bold exactly once before cardTopRows wraps it.
		bold(text: string) { work.bash++; return `\x1b[1m${text}\x1b[22m`; },
	};
	const agent = (index: number, expanded = false, status = "completed", extra = "") => renderers.get(AGENTS_RESULT_TYPE)!({
		content: `Agent paragraph ${index}: ${"analysis and verification 広い ".repeat(15)}${extra}`,
		details: { gentleAgents: { taskId: `task-${index}`, agent: "worker", status, model: "synthetic/test" } },
	} as never, { expanded } as never, theme as never)!;
	const job = (index: number, expanded = false, status = "exited", extra = "") => renderers.get(JOB_NOTICE_TYPE)!({
		content: `Job paragraph ${index}: ${"background output record 広い ".repeat(15)}${extra}`,
		details: { gentleJobs: { label: `job-${index}`, kind: status === "running" ? "monitor" : "bash", status, exitCode: status === "failed" ? 1 : 0, event: status === "running" ? "events" : undefined } },
	} as never, { expanded } as never, theme as never)!;
	const agentTool = (index: number, expanded = false, status = "completed", extra = "") => tools.get("subagent_result")!.renderResult!({
		content: [{ type: "text", text: `Agent tool paragraph ${index}: ${"analysis and verification 広い ".repeat(15)}${extra}` }],
		details: { gentleAgents: { taskId: `task-${index}`, agent: "worker", status, model: "synthetic/test" } },
	}, { expanded, isPartial: false }, theme as never, { state: {}, isError: status === "failed" } as never);
	const tool = createQuietToolRenderer("bash");
	const bashArgs = (index: number) => ({ command: `cd /repo && printf 'command ${index} ${"long Bash argument ".repeat(14)}'\nprintf done` });
	const bash = (index: number, expanded = false, running = false): Component => {
		const args = bashArgs(index);
		return tool.renderCall!(args, theme as never, { args, argsComplete: true, expanded, isPartial: running, state: {} } as never);
	};
	const bashBody = (index: number) => tool.renderResult!({
		content: [{ type: "text", text: `Bash result ${index}: ${"output record 広い ".repeat(20)}` }], details: {},
	}, { expanded: true, isPartial: false }, theme as never, {} as never);
	return { agent, job, agentTool, bash, bashBody, bashArgs, tool, work, changeTheme: () => { palette = 32; } };
}

for (const kind of ["agent", "job", "bash", "bashBody", "agentTool"] as const) test(`settled ${kind} cards wrap once per transcript width`, (t) => {
	const fixture = transcriptCards(t);
	const transcript = new Container();
	const count = 12;
	for (let index = 0; index < count; index++) transcript.addChild(fixture[kind](index));
	const lines = transcript.render(100);
	assert.equal(fixture.work[kind], count, "one cold wrap per card");
	for (let frame = 0; frame < 12; frame++) assert.deepEqual(transcript.render(100), lines);
	assert.equal(fixture.work[kind], count, "steady frames must not rewrap settled rows");
	assert.notDeepEqual(transcript.render(75), lines);
	assert.equal(fixture.work[kind], count * 2, "one new wrap per narrower card");
	assert.deepEqual(transcript.render(100), lines);
	assert.equal(fixture.work[kind], count * 3, "replacing a width evicts the previous frame");
});

// Opt-in raw ANSI rows for a differential run against the same fixture on HEAD.
function recordFrames(t: TestContext, kind: string, frames: Record<string, readonly string[]>) {
	if (process.env.GENTLE_PI_CARD_FRAME_DUMP === "1") t.diagnostic(`CARD-FRAMES ${kind} ${Buffer.from(JSON.stringify(frames)).toString("base64")}`);
}

for (const kind of ["agent", "job", "agentTool"] as const) test(`${kind} card preserves its settled and updated notices`, (t) => {
	const fixture = transcriptCards(t);
	const card = fixture[kind](0);
	const first = card.render(100);
	const resized = card.render(76);
	const narrow = card.render(8);
	const expanded = fixture[kind](0, true).render(100);
	const updated = fixture[kind](0, true, undefined, "\nnew output line").render(100);
	const failed = fixture[kind](0, true, "failed", "\nerror output line").render(100);
	const progress = fixture[kind](0, true, "running", "\nprogress output line").render(100);
	assert.ok(expanded.length > first.length);
	assert.deepEqual(fixture[kind](0).render(100), first, "collapsing returns to the original bytes");
	assert.match(stripAnsi(updated.join("\n")), /new output line/);
	assert.match(stripAnsi(failed.join("\n")), /error output line/);
	assert.notDeepEqual(failed, updated);
	if (kind === "agentTool") assert.deepEqual(progress, [], "polling a running answer is deliberately hidden");
	else assert.match(stripAnsi(progress.join("\n")), kind === "agent" ? /RUNNING/ : /Monitor/);
	assert.deepEqual(card.render(100), first);
	setCardStyle(CARD_STYLE.NEON);
	const neon = card.render(100);
	assert.notDeepEqual(neon, first);
	setCardStyle(CARD_STYLE.FLOAT);
	assert.deepEqual(card.render(100), first);
	fixture.changeTheme();
	card.invalidate();
	const recolored = card.render(100);
	assert.notDeepEqual(recolored, first, "invalidation repaints at the same width and style");
	recordFrames(t, kind, { first, resized, narrow, expanded, updated, failed, progress, neon, recolored });
});

test("Bash heading preserves its settled and running appearance", (t) => {
	const fixture = transcriptCards(t);
	const card = fixture.bash(0);
	const first = card.render(100);
	const resized = card.render(76);
	const updated = fixture.bash(1).render(100);
	const expanded = fixture.bash(0, true).render(100);
	const pending = fixture.bash(0, false, true).render(100);
	assert.notDeepEqual(updated, first);
	assert.ok(expanded.length > first.length);
	assert.match(stripAnsi(pending.join("\n")), /running…/);
	assert.deepEqual(card.render(100), first);
	fixture.changeTheme();
	card.invalidate();
	const recolored = card.render(100);
	assert.notDeepEqual(recolored, first);
	setCardContent(CARD_CONTENT.DEFAULT);
	const preview = fixture.bash(0).render(100);
	recordFrames(t, "bash-heading", { first, resized, updated, expanded, pending, recolored, preview });
});

test("Bash heading cache reflows on a live Card content preference change", (t) => {
	const fixture = transcriptCards(t);
	const card = fixture.bash(0);
	const minimal = card.render(100);
	setCardContent(CARD_CONTENT.DEFAULT);
	const preview = fixture.bash(0).render(100);
	assert.notDeepEqual(preview, minimal);
	const beforePreferenceChange = fixture.work.bash;
	assert.deepEqual(card.render(100), preview, "same width and theme must not reuse the old bash heading after content level changes");
	assert.equal(fixture.work.bash, beforePreferenceChange + 1);
	assert.deepEqual(card.render(100), preview);
	assert.equal(fixture.work.bash, beforePreferenceChange + 1, "the new presentation is also cached");
});

test("Pi keeps Bash output live, mouse-expands it and repaints settled rows", (t) => {
	const { tool, bashArgs } = transcriptCards(t);
	const card = new ToolExecutionComponent("bash", "call-0", bashArgs(0), {}, tool, { requestRender() {} } as never, "/repo");
	const width = 100;
	const text = (frame: readonly string[]) => stripAnsi(frame.join("\n"));
	const show = (line: string, isPartial: boolean, isError = false) => card.updateResult({ content: [{ type: "text", text: line }], isError }, isPartial);
	const mouse = (type: TuiMouseEvent["type"], button: TuiMouseEvent["button"], height: number): TuiMouseEvent => ({ type, button, x: 5, y: 2, screenX: 5, screenY: 2, width, height, shift: false, alt: false, ctrl: false });
	card.setArgsComplete();
	card.markExecutionStarted();
	const running = card.render(width);
	assert.match(text(running), /running…/);
	card.setExpanded(true);
	show("first chunk", true);
	const partial = card.render(width);
	assert.match(text(partial), /first chunk/);
	assert.doesNotMatch(text(partial), /running…/, "only the result slot closes the frame after output arrives");
	show("first chunk\nsecond chunk", true);
	const streaming = card.render(width);
	assert.match(text(streaming), /second chunk/);
	show("first chunk\nsecond chunk\ndone", false);
	const done = card.render(width);
	assert.match(text(done), /\bdone\b/);
	assert.doesNotMatch(text(done), /… bash/);
	assert.equal(card.handleMouse(mouse("move", "none", done.length)), undefined);
	assert.deepEqual(card.render(width), done, "hover does not change card chrome");
	assert.equal(card.handleMouse(mouse("click", "left", done.length))?.handled, true);
	const collapsed = card.render(width);
	assert.doesNotMatch(text(collapsed), /second chunk/);
	assert.equal(card.handleMouse(mouse("click", "left", collapsed.length))?.handled, true);
	assert.deepEqual(card.render(width), done);
	show("failure on exit", false, true);
	const failed = card.render(width);
	assert.match(text(failed), /failure on exit/);
	assert.doesNotMatch(text(failed), /second chunk/);
	const resized = card.render(76);
	assert.notDeepEqual(resized, failed);
	card.render(width);
	initTheme("light");
	t.after(() => initTheme("dark"));
	card.invalidate();
	const recolored = card.render(width);
	assert.notDeepEqual(recolored, failed);
	assert.equal(text(recolored), text(failed));
	recordFrames(t, "bash-lifecycle", { running, partial, streaming, done, collapsed, failed, resized, recolored });
});

test("quiet Bash still advances and freezes the timer on a live Gentle AI card", async (t) => {
	const { tool } = transcriptCards(t);
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
	let requested = 0;
	const card = new ToolExecutionComponent("bash", "clock", { command: "gentle-ai review status" }, {}, tool,
		{ requestRender() { requested++; } } as never, "/repo");
	card.setArgsComplete();
	card.markExecutionStarted();
	const running = card.render(100);
	assert.match(stripAnsi(running.join("\n")), /0s/);
	const requests = requested;
	t.mock.timers.tick(1000);
	const tick = card.render(100);
	assert.equal(requested, requests + 1, "the live clock schedules a repaint");
	assert.match(stripAnsi(tick.join("\n")), /1s/);
	card.updateResult({ content: [{ type: "text", text: "finished" }], isError: false });
	await Promise.resolve(); // let the result renderer's scheduled invalidation finish
	const done = card.render(100);
	assert.match(stripAnsi(done.join("\n")), /1s/);
	const settledRequests = requested;
	t.mock.timers.tick(10_000);
	assert.deepEqual(card.render(100), done);
	assert.equal(requested, settledRequests, "a settled card does not schedule further ticks");
	recordFrames(t, "bash-clock", { running, tick, done });
});

test("mixed settled-card frame timing", { skip: process.env.GENTLE_PI_CARD_FRAME_BENCH !== "1" }, (t) => {
	const { agent, job, bash, bashBody, agentTool, work } = transcriptCards(t);
	const transcript = new Container();
	for (let index = 0; index < 16; index++) {
		transcript.addChild(agent(index));
		transcript.addChild(job(index * 2));
		transcript.addChild(job(index * 2 + 1));
		const toolCard = new Container();
		toolCard.addChild(bash(index, true));
		toolCard.addChild(bashBody(index));
		transcript.addChild(toolCard);
		transcript.addChild(agentTool(index));
	}
	for (let frame = 0; frame < 10; frame++) transcript.render(100);
	const warm = { ...work };
	const samples = Array.from({ length: 80 }, () => {
		const start = performance.now();
		transcript.render(100);
		return performance.now() - start;
	}).sort((a, b) => a - b);
	const wrapStarts = Object.fromEntries((Object.keys(work) as Array<keyof typeof work>).map((kind) => [kind, work[kind] - warm[kind]]));
	t.diagnostic(`80 cards / ${samples.length} frames: median ${samples[40]!.toFixed(3)} ms; p95 ${samples[75]!.toFixed(3)} ms; wrap starts: ${JSON.stringify(wrapStarts)}`);
});

test("native fullscreen scroll frames reuse complete tool cards and session statistics", () => {
	let decoration = 0;
	let scans = 0;
	let projections = 0;
	const theme = {
		fg: (_color: string, text: string) => { decoration++; return text; },
		bg: (_color: string, text: string) => { decoration++; return `\x1b[48;5;235m${text}\x1b[49m`; },
		bold: (text: string) => text,
	};
	const ctx = {
		model: { id: "model", contextWindow: 1000 },
		getContextUsage() { projections++; return { percent: 10, contextWindow: 1000 }; },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getEntries() { scans++; return []; }, getSessionId: () => "session", getLeafId: () => "leaf",
			getCwd: () => "/repo", getSessionName: () => "session",
		},
	} as unknown as ExtensionContext;
	const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map() } as unknown as ShellFooterData;
	const pi = { getThinkingLevel: () => "high" } as unknown as ExtensionAPI;
	const document = new Container();
	const renderer = createQuietToolRenderer("read");
	for (let tool = 0; tool < 50; tool++) {
		const context = { args: { path: `src/file-${tool}.ts` }, state: {}, isPartial: false, executionStarted: true };
		document.addChild(renderer.renderCall!(context.args, theme as never, context as never));
		document.addChild(renderer.renderResult!({ content: [{ type: "text", text: `result-${tool}` }], details: {} },
			{ expanded: false, isPartial: false }, theme as never, context as never));
	}
	const footer = new Container();
	footer.addChild({ render: () => [`cost ${buildShellBarModel(pi, ctx, footerData).costTotal}`], invalidate() {} });
	const viewport = createChatViewport({
		document, pendingMessages: new Container(), status: new Container(), widgetsAbove: new Container(),
		editor: { render: () => ["prompt"], invalidate() {} }, widgetsBelow: new Container(), footer, scrollbar: "hidden",
	});
	const terminal = {
		start() {}, stop() {}, async drainInput() {}, write() {}, columns: 100, rows: 24,
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
		setTitle() {}, setProgress() {}, kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
	} as never;
	const tui = new TuiAltScreen(terminal, false);
	tui.setLayoutRoot(viewport.root);
	const host = tui as unknown as { doRender(): void; previousScreen: string[] };
	tui.start();
	try {
		host.doRender();
		const warmDecoration = decoration;
		assert.deepEqual([scans, projections], [1, 1]);
		const screens: string[] = [];
		for (let frame = 0; frame < 20; frame++) {
			if (frame % 2) viewport.transcript.scrollToEnd();
			else viewport.transcript.scrollTo(0, { disableFollow: true });
			host.doRender();
			screens.push(host.previousScreen.join("\n"));
		}
		assert.notEqual(screens[0], screens[1], "scroll really changes the visible transcript");
		assert.equal(decoration, warmDecoration, "even the native frame path reuses settled chrome");
		assert.deepEqual([scans, projections], [1, 1], "scroll/pulse-like frames do not rescan unchanged session state");
	} finally { tui.stop(); }
});
