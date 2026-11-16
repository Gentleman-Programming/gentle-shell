import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Container, Markdown, Spacer, TuiAltScreen, visibleWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { installSidebar, type SidebarDestination } from "../lib/shell-sidebar-layout.ts";
import { sidebarHeader, sidebarPart, type SidebarRail } from "../lib/shell-sidebar.ts";
import { SidebarGitFrameCache, SidebarGitHistory } from "../lib/sidebar-git-graph.ts";

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
// A realistic over-long identity: the rail is 50 columns wide, so neither the
// branch name nor a ref of `HEAD -> branch, origin/branch` fits in its card.
const LONG_BRANCH = "feature/2750-git-sidebar-destination-with-a-very-long-branch-name-overflow";
const historyLines = (refs: string, count = 12) => Array.from({ length: count }, (_, index) =>
	`* \x1e${(0x8d2f1aa - index * 0x10101).toString(16)}\x1f${index === 0 ? refs : ""}\x1f${index === 0 ? "feat(sidebar): add the git history destination" : `fix(sidebar): keep the rail ${index}`}\x1e`);
const REFRESHED_HISTORY = [...historyLines("HEAD -> main, origin/main"), `* \x1e9b0c4d2\x1f\x1ffix(sidebar): repaint only the git section\x1e`];
const markdownTheme = Object.fromEntries([
	"heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder",
	"hr", "listBullet", "bold", "italic", "strikethrough", "underline",
].map((key) => [key, (text: string) => `\x1b[36m${text}\x1b[39m`])) as unknown as MarkdownTheme;

function createFixture(columns: number, rowCount: number, sidebar: boolean, workload: Workload = "plain", tabs = false) {
	const rows = Array.from({ length: rowCount }, (_, index) => `ROW-${String(index).padStart(5, "0")} settled transcript`);
	const counts = { transcript: 0, header: 0, rail: 0, railDigest: 0, git: 0, publish: 0, markdownMiss: 0, widthBuild: 0, lastWidth: 0 };
	// The repository the GIT destination reads; a test mutates it to simulate a refresh.
	const repository = { branch: "main", lines: historyLines("HEAD -> main, origin/main") };
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
	// The production GIT destination: a real SidebarGitHistory over a fake Git
	// runner, its frame cache, and the extension's publish wiring (request a
	// render; never invalidate the rail). `tabs` mirrors the Tabs setting being
	// on, so the navigation provider advertises MAIN and GIT.
	let navigation: () => readonly SidebarDestination[] | undefined = () => undefined;
	let onDestination: (id: string | undefined) => void = () => {};
	let onViewport: (id: string, height: number) => void = () => {};
	let history: SidebarGitHistory | undefined;
	const destinations: SidebarDestination[] = sidebar && tabs ? [{ id: "main", label: "MAIN" }] : [];
	if (sidebar && tabs) {
		const frame = new SidebarGitFrameCache();
		let viewport = 1, offset = 0;
		const maxOffset = () => Math.max(0, (history?.graph.state === "ready" ? history.graph.lines.length : 0) - Math.max(1, viewport - 1));
		const gitRail: SidebarRail = {
			surface: "panel",
			digest: () => `${history!.revision}:${viewport}:${offset}:false:false`,
			render: (width) => { counts.git++; return frame.render(history!.graph, history!.revision, theme, width, viewport, Math.min(offset, maxOffset()), false, false); },
			invalidate() {},
		};
		const gitHistory = new SidebarGitHistory(async (args) => {
			if (args[0] === "symbolic-ref") return { code: 0, stdout: `${repository.branch}\n` };
			if (args[0] === "rev-parse") return { code: 0, stdout: "8d2f1aa\n" };
			return { code: 0, stdout: `${repository.lines.join("\n")}\n` };
		}, async () => "clean", () => { counts.publish++; tui.requestRender(); });
		history = gitHistory;
		destinations.push({ id: "git", label: "GIT", rail: gitRail });
		navigation = () => destinations;
		// The extension activates Git history only while its destination is shown,
		// and republishes the rail viewport the frame it measured.
		onDestination = (id) => gitHistory.setActive(id === "git");
		onViewport = (id, height) => {
			if (id !== "git" || height === viewport) return;
			viewport = Math.max(1, height);
			offset = Math.min(offset, maxOffset());
			queueMicrotask(() => tui.requestRender());
		};
	}
	if (sidebar) footer.addChild(sidebarPart(tui, "footer", {
		digest: () => { counts.railDigest++; return "status"; },
		render: () => { counts.rail++; return ["Status card"]; },
		invalidate() {},
	}));
	else footer.addChild(leaf(["Status card"]));
	// Main's narrow fallback keeps the header even without a rail. Give the
	// width-matched fallback control the same header and native layout hook.
	if (sidebar || columns === 100) {
		sidebarHeader(tui, { render: (width: number) => { counts.header++; return [`HEADER ${width}`]; }, invalidate() {} });
		dispose = installSidebar(tui, theme, () => "auto", () => "split", () => "comfortable", navigation, onDestination, onViewport);
	}
	tui.start();
	const render = () => {
		// Use the real alt-screen frame pipeline, not a hand-built layout node.
		(tui as unknown as { doRender(): void }).doRender();
		return [...((tui as unknown as { previousScreen: string[] }).previousScreen ?? [])];
	};
	render(); // establish native viewport height and scroll bounds before sampling
	return { columns, rowCount, sidebar, workload, counts, document, viewport, tui, repository, history, render, stop: () => { dispose(); tui.stop(); } };
}

function measure(fixture: Fixture, invalidate = false, anchors?: number[]) {
	const { transcript, header, rail, railDigest, git, markdownMiss, widthBuild } = fixture.counts;
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
			railDigest: fixture.counts.railDigest - railDigest, git: fixture.counts.git - git,
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
						assert.equal(screen[0], "HEADER 140", "the header bar reaches the window edge");
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

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
// The navigation row is a leaf of the native layout tree, so the real
// alt-screen mouse dispatch is the only public route into the GIT tab.
function openTab(fixture: Fixture, label: string) {
	const screen = fixture.render();
	const row = screen.findIndex((line) => new RegExp(`(^|\\s)${label}(\\s|$)`).test(strip(line)));
	assert.ok(row >= 0, `the ${label} tab is painted in the rail`);
	const x = strip(screen[row]!).indexOf(label);
	const result = (fixture.tui as unknown as { dispatchMouseToLayout(event: object): unknown }).dispatchMouseToLayout({
		type: "click", button: "left", x, y: row, screenX: x, screenY: row, width: fixture.columns, height: 24,
		shift: false, alt: false, ctrl: false,
	});
	assert.ok(result, `the ${label} tab accepts the click`);
	return fixture.render();
}
function openGit(fixture: Fixture) {
	return openTab(fixture, "GIT");
}
const sectionCounts = (counts: Fixture["counts"]) => ({ header: counts.header, rail: counts.rail, railDigest: counts.railDigest, git: counts.git });

test("the GIT destination keeps the transcript and header byte-identical to the disabled destination", async () => {
	// Control: the Tabs setting off, so no navigation and no Git destination at all.
	const disabled = createFixture(140, 120, true);
	const enabled = createFixture(140, 120, true, "plain", true);
	try {
		disabled.render();
		const clicked = openGit(enabled);
		assert.match(clicked.join("\n"), /\[GIT\]/, "the click selects the GIT destination");
		await settle(); // the activation capture publishes the first history snapshot
		enabled.render();
		await settle(); // the published viewport settles the visible history rows
		const activated = enabled.render();
		assert.match(activated.join("\n"), /▾ GIT/, "the GIT card is painted");
		assert.match(activated.join("\n"), /8d2f1aa/, "the history body is painted");
		assert.match(disabled.render().join("\n"), /Status card/);
		const off = measure(disabled);
		const on = measure(enabled, false, off.positions);
		console.log("git destination", JSON.stringify({ off: off.renderCalls, on: on.renderCalls, contentWidth: on.contentWidth, viewportHeight: on.viewportHeight }));
		// Both destinations do the same transcript work, and a settled GIT frame
		// never re-renders the shared header.
		assert.equal(on.renderCalls.transcript, off.renderCalls.transcript);
		assert.equal(on.renderCalls.header, off.renderCalls.header);
		assert.equal(on.renderCalls.transcript, off.positions.length * 3);
		// MAIN's own sections are not even digested while GIT is the destination.
		assert.equal(off.renderCalls.railDigest, off.positions.length * 3, "the control digests its MAIN section every frame");
		assert.equal(on.renderCalls.railDigest, 0, "GIT never reads a MAIN section digest");
		assert.equal(on.renderCalls.rail, 0, "GIT never renders a MAIN section");
		assert.equal(on.renderCalls.git, 0, "a settled GIT frame reuses its cached rows");
		// Visible output of the unrelated sections is identical frame by frame.
		assert.deepEqual(on.positions, off.positions);
		for (let frame = 0; frame < off.screens.length; frame++) {
			const reference = off.screens[frame]!;
			const screen = on.screens[frame]!;
			assert.equal(screen.length, reference.length, "the GIT destination keeps the terminal height");
			assert.equal(screen[0], reference[0], "the header row is unchanged");
			assert.equal(screen[0], "HEADER 140");
			assert.deepEqual(transcriptRows(screen), transcriptRows(reference), "the transcript is unchanged");
			const column = (lines: string[], width: number) => lines.map((line) => line.slice(0, width).trimEnd());
			assert.deepEqual(column(screen, on.contentWidth), column(reference, off.contentWidth), "the conversation column is byte-identical");
			assert.ok(!screen.some((line) => line.includes("Status card")), "the GIT destination does not paint the MAIN footer");
			assert.ok(!reference.some((line) => line.includes("GIT")), "the control has no GIT destination");
		}
	} finally {
		disabled.stop();
		enabled.stop();
	}
});

test("a Git refresh repaints only its own section and renders nothing by itself", async () => {
	const fixture = createFixture(140, 120, true, "plain", true);
	try {
		openGit(fixture);
		await settle();
		fixture.render();
		await settle();
		const settledFrame = fixture.render();
		assert.doesNotMatch(settledFrame.join("\n"), /9b0c4d2/, "the new commit is not painted before the refresh");
		// Settled: two frames cost two transcript renders and no section work.
		const settled = { ...fixture.counts };
		const frames = [fixture.render(), fixture.render()];
		assert.equal(fixture.counts.transcript - settled.transcript, 2);
		assert.deepEqual(sectionCounts(fixture.counts), sectionCounts(settled));
		// A repository change publishes one fingerprint and only requests a render.
		fixture.repository.lines = REFRESHED_HISTORY;
		const beforeRefresh = { ...fixture.counts };
		await fixture.history!.refresh();
		assert.equal(fixture.counts.publish - beforeRefresh.publish, 1, "the refresh publishes one fingerprint");
		assert.deepEqual(sectionCounts(fixture.counts), sectionCounts(beforeRefresh), "publishing and requesting a render paints nothing and invalidates nothing");
		// The single requested frame repaints the GIT section and nothing else.
		const refreshed = fixture.render();
		const delta = { transcript: fixture.counts.transcript - beforeRefresh.transcript, header: fixture.counts.header - beforeRefresh.header, rail: fixture.counts.rail - beforeRefresh.rail, railDigest: fixture.counts.railDigest - beforeRefresh.railDigest, git: fixture.counts.git - beforeRefresh.git };
		console.log("git refresh", JSON.stringify(delta));
		assert.equal(delta.transcript, 1, "one frame renders the transcript once");
		assert.equal(delta.git, 1, "only the GIT section repaints");
		assert.equal(delta.rail, 0, "MAIN sections never render");
		assert.equal(delta.railDigest, 0, "MAIN sections never read a digest");
		assert.ok(delta.header <= 1, "the shared header stays live at most once per frame");
		assert.match(refreshed.join("\n"), /9b0c4d2/, "the refreshed history is painted");
		assert.deepEqual(transcriptRows(refreshed), transcriptRows(frames[1]!), "the transcript is untouched");
		// The following frame is settled again: no section work at all.
		const after = { ...fixture.counts };
		fixture.render();
		assert.equal(fixture.counts.transcript - after.transcript, 1, "the next frame renders the transcript once");
		assert.deepEqual(sectionCounts(fixture.counts), sectionCounts(after), "the next frame is settled again: no section work at all");
	} finally {
		fixture.stop();
	}
});

test("a very long branch and ref name clip inside the rail and keep it painted", async () => {
	const fixture = createFixture(140, 120, true, "plain", true);
	fixture.repository.branch = LONG_BRANCH;
	fixture.repository.lines = historyLines(`HEAD -> ${LONG_BRANCH}, origin/${LONG_BRANCH}`);
	try {
		openGit(fixture);
		await settle();
		fixture.render();
		await settle();
		const screen = fixture.render();
		const text = screen.join("\n");
		// The rail stays painted: the conversation and the GIT card share the frame.
		assert.ok(transcriptRows(screen).length > 0, "the transcript is still visible");
		assert.match(text, /GIT/, "the GIT card is still visible");
		assert.ok(screen.some((line) => line.includes("8d2f1aa")), "the history body is still visible");
		// Nothing overflows the terminal, and the history identity is clipped.
		for (const line of screen) assert.ok(visibleWidth(line) <= 140, `no frame row exceeds the terminal width: ${JSON.stringify(strip(line))}`);
		// The rail is 50 columns wide and flush with the right edge (`RAIL_WIDTH`);
		// the three columns before it are the conversation/rail gap.
		const railColumn = screen.map((line) => strip(line).slice(140 - 50));
		assert.ok(railColumn.some((row) => row.includes("8d2f1aa")), "the clipped card keeps its content");
		assert.ok(railColumn.some((row) => row.includes("…")), "the over-long identity shows the truncation marker");
		assert.ok(!text.includes(LONG_BRANCH), "the over-long branch name is not painted whole");
		assert.ok(!railColumn.every((row) => row.trim() === ""), "the rail column is painted");
		console.log("long branch", JSON.stringify({ rail: railColumn.map((row) => row.trimEnd()).filter(Boolean).slice(0, 8), width: railColumn.map(visibleWidth).slice(0, 4) }));
	} finally {
		fixture.stop();
	}
});

