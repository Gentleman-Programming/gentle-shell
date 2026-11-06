import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, TuiAltScreen } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { buildShellBarModel, type ShellFooterData } from "../extensions/gentle-shell.ts";
import { createQuietToolRenderer } from "../extensions/quiet-tools.ts";

initTheme("dark");

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
