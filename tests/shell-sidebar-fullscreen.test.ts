import assert from "node:assert/strict";
import test from "node:test";
import { Container, Spacer, TuiAltScreen, type Component } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { sidebarHeader, sidebarPart } from "../lib/shell-sidebar.ts";

// End-to-end through pi-tui's real alt-screen renderer and Pi's real chat
// viewport: the unit fixtures elsewhere hand-build layout nodes, which is how
// two earlier attempts at this row passed their tests and still failed live.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\s+$/, "");
const lines = (rows: string[]): Component => ({ render: () => rows, invalidate() {} });

async function renderViewport(columns: number, rows: number, sidebar: boolean): Promise<string[]> {
	const terminal = {
		start() {}, stop() {}, async drainInput() {}, write() {},
		get columns() { return columns; }, get rows() { return rows; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
		kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
	} as never;
	const above = new Container();
	above.addChild(new Spacer(1)); // Pi adds a spacer above the editor when no widget is shown
	const footer = new Container();
	const viewport = createChatViewport({
		document: lines(Array.from({ length: 12 }, (_, i) => `transcript ${i + 1}`)),
		pendingMessages: new Container(), status: new Container(), widgetsAbove: above,
		editor: lines(["╭─ editor ─╮", "│ prompt   │", "╰──────────╯"]),
		widgetsBelow: new Container(), footer, scrollbar: "auto",
	});
	const tui = new TuiAltScreen(terminal, false);
	tui.setLayoutRoot(viewport.root);
	if (sidebar) {
		footer.addChild(sidebarPart(tui, "footer", lines(["BOTTOM BAR"]), { render: () => ["Status card"], invalidate() {} }));
		sidebarHeader(tui, { render: (width: number) => [`HEADER ${width}`], invalidate() {} });
		installSidebar(tui, theme);
	} else {
		footer.addChild(lines(["BOTTOM BAR"]));
	}
	tui.start();
	tui.requestRender(true);
	await new Promise((resolve) => setTimeout(resolve, 20));
	tui.stop();
	return ((tui as unknown as { previousScreen: string[] }).previousScreen ?? []).map(strip);
}

test("fullscreen with the sidebar leaves no blank row between the editor and the terminal edge", async () => {
	const screen = await renderViewport(140, 24, true);
	assert.equal(screen[0], "HEADER 138", "the header owns the first row");
	assert.match(screen[screen.length - 1] ?? "", /^╰/, `the editor's bottom border sits on the last row, got ${JSON.stringify(screen.slice(-3))}`);
	assert.ok(screen.some((row) => row.startsWith("╭─ editor")), "the editor is still painted");
	assert.ok(screen.some((row) => row.includes("Status card")), "the rail is still painted");
});

test("fullscreen without the sidebar keeps Pi's bottom bar on the last row", async () => {
	const screen = await renderViewport(140, 24, false);
	assert.equal(screen[screen.length - 1], "BOTTOM BAR");
	assert.match(screen[screen.length - 2] ?? "", /^╰/);
});
