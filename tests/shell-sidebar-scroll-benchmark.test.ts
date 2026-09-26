import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Container, Markdown, Spacer, TuiAltScreen, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { sidebarHeader, sidebarPart } from "../lib/shell-sidebar.ts";

// Diagnostic baseline, not a speed gate. Keep the document settled: the same
// prebuilt lines and component survive every native fullscreen scroll frame.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trimEnd();
const median = (samples: number[]) => {
	const ordered = [...samples].sort((a, b) => a - b);
	return (ordered[Math.floor((ordered.length - 1) / 2)]! + ordered[Math.floor(ordered.length / 2)]!) / 2;
};
const leaf = (rows: string[]): Component => ({ render: () => rows, invalidate() {} });

type Fixture = ReturnType<typeof createFixture>;
type Workload = "plain" | "ansi" | "markdown";
const markdownTheme = Object.fromEntries([
	"heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder",
	"hr", "listBullet", "bold", "italic", "strikethrough", "underline",
].map((key) => [key, (text: string) => `\x1b[36m${text}\x1b[39m`])) as unknown as MarkdownTheme;

function createFixture(columns: number, rowCount: number, sidebar: boolean, workload: Workload = "plain") {
	const rows = Array.from({ length: rowCount }, (_, index) => `ROW-${String(index).padStart(5, "0")} settled transcript`);
	const counts = { transcript: 0, header: 0, rail: 0, markdownMiss: 0, widthBuild: 0, lastWidth: 0 };
	const markdown = workload === "markdown" ? new Markdown(
		rows.map((row) => `${row} **bold** and *italic* with a longer wrapped passage for the real Markdown parser.`).join("\n\n"),
		0, 0, markdownTheme, undefined,
		{ transform: (source) => { counts.markdownMiss++; return source; } },
	) : undefined;
	const wrapped = new Map<number, string[]>();
	const document: Component = {
		render: (width) => {
			counts.transcript++;
			counts.lastWidth = width;
			if (markdown) return markdown.render(width);
			if (workload === "plain") return rows;
			let result = wrapped.get(width);
			if (!result) {
				counts.widthBuild++;
				result = rows.flatMap((row) => wrapTextWithAnsi(`\x1b[35m${row} ${"ANSI styled long content ".repeat(8)}\x1b[39m`, width));
				wrapped.set(width, result);
			}
			return result;
		},
		invalidate: () => { markdown?.invalidate(); wrapped.clear(); },
	};
	const terminal = {
		start() {}, stop() {}, async drainInput() {}, write() {},
		get columns() { return columns; }, get rows() { return 24; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
		kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
	} as never;
	const above = new Container();
	above.addChild(new Spacer(1));
	const footer = new Container();
	const viewport = createChatViewport({
		document, pendingMessages: new Container(), status: new Container(), widgetsAbove: above,
		editor: leaf(["╭─ editor ─╮", "│ prompt   │", "╰──────────╯"]),
		widgetsBelow: new Container(), footer, scrollbar: "hidden",
	});
	const tui = new TuiAltScreen(terminal, false);
	tui.setLayoutRoot(viewport.root);
	let dispose = () => {};
	if (sidebar) footer.addChild(sidebarPart(tui, "footer", { render: () => { counts.rail++; return ["Status card"]; }, invalidate() {} }));
	else footer.addChild(leaf(["Status card"]));
	// Main's narrow fallback keeps the header even without a rail. Give the
	// width-matched fallback control the same header and native layout hook.
	if (sidebar || columns === 100) {
		sidebarHeader(tui, { render: (width: number) => { counts.header++; return [`HEADER ${width}`]; }, invalidate() {} });
		dispose = installSidebar(tui, theme);
	}
	tui.start();
	const render = () => {
		// Use the real alt-screen frame pipeline, not a hand-built layout node.
		(tui as unknown as { doRender(): void }).doRender();
		return [...((tui as unknown as { previousScreen: string[] }).previousScreen ?? [])];
	};
	render(); // establish native viewport height and scroll bounds before sampling
	return { columns, rowCount, sidebar, workload, counts, document, viewport, render, stop: () => { dispose(); tui.stop(); } };
}

function measure(fixture: Fixture, invalidate = false, anchors?: number[]) {
	const { transcript, header, rail, markdownMiss, widthBuild } = fixture.counts;
	fixture.viewport.transcript.scrollToEnd();
	const maxTop = fixture.viewport.transcript.scrollTop;
	const positions = anchors ?? [0, Math.floor(maxTop / 4), Math.floor(maxTop / 2), Math.floor(maxTop * 3 / 4), maxTop];
	const samples: number[] = [];
	const cpuSamples: number[] = [];
	const screens: string[][] = [];
	const rawScreens: string[][] = [];
	for (let repeat = 0; repeat < 3; repeat++) {
		for (const position of positions) {
			fixture.viewport.transcript.scrollTo(position, { disableFollow: true });
			if (invalidate) fixture.document.invalidate();
			const cpuStart = process.cpuUsage();
			const start = performance.now();
			const rawScreen = fixture.render();
			samples.push(performance.now() - start);
			const cpu = process.cpuUsage(cpuStart);
			cpuSamples.push((cpu.user + cpu.system) / 1000);
			rawScreens.push(rawScreen);
			screens.push(rawScreen.map(strip));
		}
	}
	return {
		positions, screens, rawScreens, samplesMs: samples.map((time) => Number(time.toFixed(3))),
		medianMs: Number(median(samples).toFixed(3)), medianCpuMs: Number(median(cpuSamples).toFixed(3)),
		renderCalls: { transcript: fixture.counts.transcript - transcript, header: fixture.counts.header - header, rail: fixture.counts.rail - rail,
			markdownMiss: fixture.counts.markdownMiss - markdownMiss, widthBuild: fixture.counts.widthBuild - widthBuild },
		contentWidth: fixture.counts.lastWidth,
		viewportHeight: fixture.viewport.transcript.viewportHeight,
	};
}

// At narrow widths the top header is the only status row: against the control
// that still docks "Status card", every frame keeps the same header and
// transcript bytes, the same spacer and editor bytes, and gives the reclaimed
// footer row to one more transcript row.
const DOCK_ROWS = 4; // spacer + three editor rows
function assertNarrowOwnsStatus(narrow: string[][], control: string[][], label: string) {
	assert.equal(narrow.length, control.length, `${label} samples the same frames`);
	for (const [frame, screen] of narrow.entries()) {
		const reference = control[frame]!;
		assert.equal(screen.length, reference.length, `${label} keeps terminal height`);
		assert.equal(strip(reference.at(-1)!), "Status card", `${label} control docks Status`);
		assert.deepEqual(screen.slice(-DOCK_ROWS), reference.slice(-DOCK_ROWS - 1, -1), `${label} keeps spacer and editor bytes`);
		const body = reference.length - DOCK_ROWS - 1;
		assert.deepEqual(screen.slice(0, body), reference.slice(0, body), `${label} keeps header and transcript bytes`);
	}
}

function transcriptRows(screen: string[]) {
	return screen.flatMap((line) => [...line.matchAll(/ROW-\d{5} settled transcript/g)].map(([match]) => match));
}

test("characterize settled native fullscreen scroll frames with and without the sidebar", () => {
	for (const rowCount of [120, 1200]) {
		const fixtures = [createFixture(140, rowCount, true), createFixture(140, rowCount, false), createFixture(100, rowCount, true), createFixture(100, rowCount, false)];
		try {
			const desktop = measure(fixtures[0]!);
			// The narrow sidebar reclaims the footer row, so its taller viewport has a
			// different maxTop; the narrow control samples its exact anchors.
			const narrow = measure(fixtures[2]!);
			const results = [desktop, measure(fixtures[1]!, false, desktop.positions), narrow, measure(fixtures[3]!, false, narrow.positions)];
			for (let i = 0; i < fixtures.length; i++) {
				const fixture = fixtures[i]!;
				const result = results[i]!;
				assert.equal(result.screens.length, result.positions.length * 3);
				assert.equal(result.rawScreens.length, result.screens.length);
				assert.equal(result.renderCalls.transcript, result.positions.length * 3, "every scroll traverses the settled document");
				for (const [frame, screen] of result.screens.entries()) {
					assert.equal(screen.length, 24, "native fullscreen retains terminal height");
					assert.ok(screen.some((line) => line.startsWith("╭─ editor")), "editor remains visible");
					const visible = transcriptRows(screen);
					assert.ok(visible.length > 0, "transcript remains visible");
					assert.equal(visible[0], `ROW-${String(result.positions[frame % result.positions.length]).padStart(5, "0")} settled transcript`, "visible scroll anchor matches requested position");
					if (fixture.sidebar && fixture.columns === 140) {
						assert.ok(screen.some((line) => line.includes("Status card")), "desktop rail is painted");
						assert.equal(screen[0], "HEADER 138");
					} else {
						if (fixture.columns === 100) assert.equal(screen[0], "HEADER 100", "narrow fallback retains the full-width header");
						else assert.ok(!screen.some((line) => line.startsWith("HEADER ")), "desktop sidebar-off control has no header");
						if (fixture.sidebar) {
							assert.equal(screen.at(-1), "╰──────────╯", "the narrow top header owns Status and reclaims the footer row");
							assert.ok(!screen.some((line) => line.includes("Status card")), "no second status row at narrow width");
						} else {
							assert.equal(screen.at(-1), "Status card", "footer stays in the native dock");
						}
					}
				}
			}
			// Narrow installation only swaps the footer row for one more transcript row.
			assertNarrowOwnsStatus(results[2]!.rawScreens, results[3]!.rawScreens, "narrow fallback");
			// Desktop compositions have different geometry, but share the exact
			// transcript rows at matching scroll anchors wherever both are visible.
			assert.deepEqual(results[0]!.positions, results[1]!.positions);
			for (let frame = 0; frame < results[0]!.screens.length; frame++) {
				const on = transcriptRows(results[0]!.screens[frame]!);
				const off = transcriptRows(results[1]!.screens[frame]!);
				assert.deepEqual(on, off.slice(0, on.length));
			}
			console.log("scroll baseline", JSON.stringify(fixtures.map((fixture, index) => ({
				rows: rowCount, columns: fixture.columns, sidebar: fixture.sidebar,
				viewportHeight: results[index]!.viewportHeight, contentWidth: results[index]!.contentWidth,
				medianMs: results[index]!.medianMs, medianCpuMs: results[index]!.medianCpuMs,
				samplesMs: results[index]!.samplesMs, renderCalls: results[index]!.renderCalls,
			}))));
		} finally {
			for (const fixture of fixtures) fixture.stop();
		}
	}
});

test("wrapped ANSI and native Markdown distinguish width composition from settled cache hits and misses", () => {
	for (const workload of ["ansi", "markdown"] as const) {
		for (const rowCount of [120, 1200]) {
			// The actual desktop transcript width is discovered from the native
			// viewport render; the no-sidebar control uses that exact width.
			const desktop = createFixture(140, rowCount, true, workload);
			const width = desktop.counts.lastWidth;
			const control = createFixture(width, rowCount, false, workload);
			const narrow = createFixture(100, rowCount, true, workload);
			const narrowControl = createFixture(100, rowCount, false, workload);
			const fixtures = [desktop, control, narrow, narrowControl];
			try {
				const desktopHit = measure(desktop);
				const narrowHit = measure(narrow);
				const hits = [desktopHit, measure(control, false, desktopHit.positions), narrowHit, measure(narrowControl, false, narrowHit.positions)];
				const misses = fixtures.map((fixture, index) => measure(fixture, true, hits[index]!.positions));
				assert.equal(width, 87, "desktop transcript geometry stays fixed");
				assert.equal(hits[0]!.contentWidth, hits[1]!.contentWidth);
				for (let index = 0; index < fixtures.length; index++) {
					const hit = hits[index]!;
					const miss = misses[index]!;
					assert.equal(hit.renderCalls.transcript, 15);
					assert.equal(miss.renderCalls.transcript, 15);
					assert.equal(hit.rawScreens.length, 15);
					assert.equal(miss.rawScreens.length, 15);
					assert.deepEqual(hit.rawScreens, miss.rawScreens, "invalidating only the document preserves frame bytes");
					if (workload === "markdown") {
						assert.equal(hit.renderCalls.markdownMiss, 0, "settled Markdown is served from its instance cache");
						assert.equal(miss.renderCalls.markdownMiss, 15, "instance invalidation forces a parse each frame");
					} else {
						assert.equal(hit.renderCalls.widthBuild, 0, "settled ANSI wrapping is width-cached");
						assert.equal(miss.renderCalls.widthBuild, 15);
					}
				}
				assertNarrowOwnsStatus(hits[2]!.rawScreens, hits[3]!.rawScreens, "narrow fallback");
				assertNarrowOwnsStatus(misses[2]!.rawScreens, misses[3]!.rawScreens, "invalidated narrow fallback");
				// Desktop header and dock are distinct; compare only the actual
				// transcript viewport at equal width and scroll position.
				assert.deepEqual(hits[0]!.positions, hits[1]!.positions);
				for (const results of [hits, misses]) {
					const height = Math.min(results[0]!.viewportHeight, results[1]!.viewportHeight);
					const transcript = (screen: string[], start: number) => screen.slice(start, start + height).map((line) => line.slice(0, width).trimEnd());
					for (let frame = 0; frame < results[0]!.screens.length; frame++) {
						assert.deepEqual(transcript(results[0]!.screens[frame]!, 1), transcript(results[1]!.screens[frame]!, 0), "width-matched transcript pixels agree");
					}
				}
				console.log("scroll workload", JSON.stringify(fixtures.map((fixture, index) => ({
					workload, rows: rowCount, columns: fixture.columns, contentWidth: hits[index]!.contentWidth,
					sidebar: fixture.sidebar, viewportHeight: hits[index]!.viewportHeight,
					hit: { medianMs: hits[index]!.medianMs, medianCpuMs: hits[index]!.medianCpuMs, samplesMs: hits[index]!.samplesMs, calls: hits[index]!.renderCalls },
					miss: { medianMs: misses[index]!.medianMs, medianCpuMs: misses[index]!.medianCpuMs, samplesMs: misses[index]!.samplesMs, calls: misses[index]!.renderCalls },
				}))));
			} finally {
				for (const fixture of fixtures) fixture.stop();
			}
		}
	}
});
