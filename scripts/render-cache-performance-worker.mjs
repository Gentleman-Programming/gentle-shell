import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const config = JSON.parse(process.argv[2]);
const piVersion = JSON.parse(readFileSync(resolve(config.piRoot, "package.json"), "utf8")).version;
const tuiVersion = JSON.parse(readFileSync(resolve(config.piRoot, "node_modules/@earendil-works/pi-tui/package.json"), "utf8")).version;
assert.equal(piVersion, "1.1.0", "private frame API audited only on Pi 1.1.0");
assert.equal(tuiVersion, piVersion, "host TUI package must match");
const hostImport = (path) => import(pathToFileURL(resolve(config.piRoot, "dist", path)).href);
const { createJiti } = await hostImport("core/extensions/jiti-loader.js");
const { VIRTUAL_MODULES } = await hostImport("core/extensions/virtual-modules.js");
const pi = VIRTUAL_MODULES["@earendil-works/pi-coding-agent"];
const { Container, TuiAltScreen } = VIRTUAL_MODULES["@earendil-works/pi-tui"];
const nativeTheme = await hostImport("modes/interactive/theme/theme.js");
const { KeybindingsManager } = await hostImport("core/keybindings.js");
const { ToolExecutionComponent } = await hostImport("modes/interactive/components/tool-execution.js");
const { UserMessageComponent } = await hostImport("modes/interactive/components/user-message.js");
const { AssistantMessageComponent } = await hostImport("modes/interactive/components/assistant-message.js");
const { createChatViewport } = await hostImport("modes/interactive/chat-viewport.js");
const loader = createJiti(import.meta.url, { moduleCache: false, fsCache: false, virtualModules: VIRTUAL_MODULES, tryNative: false });
const source = (path) => loader.import(resolve(config.root, path));
const shell = await source("extensions/gentle-shell.ts");
const quiet = await source("extensions/quiet-tools.ts");
const bar = await source("lib/shell-bar.ts");
const sidebar = await source("lib/shell-sidebar.ts");
const layout = await source("lib/shell-sidebar-layout.ts");
const cards = await source("lib/shell-card.ts");
assert.equal(Object.getPrototypeOf(shell.GentlePromptEditor.prototype), pi.CustomEditor.prototype, "editor must extend this exact host class");
const memory = () => Object.fromEntries(Object.entries(process.memoryUsage()).map(([key, bytes]) => [key, bytes / 1024 / 1024]));
const digest = (lines) => createHash("sha256").update(lines.join("\n")).digest("hex");
const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };

function fixture(spec, live = false) {
	pi.initTheme("dark");
	cards.setCardStyle(spec.style);
	const counts = { paints: 0, projections: 0, entries: 0, requests: 0, pulses: 0, bytes: 0 };
	const theme = { fg: (...args) => nativeTheme.theme.fg(...args), bg: (...args) => nativeTheme.theme.bg(...args), bold: (text) => nativeTheme.theme.bold(text) };
	const toolTheme = { ...theme, fg: (...args) => { counts.paints++; return theme.fg(...args); }, bg: (...args) => { counts.paints++; return theme.bg(...args); } };
	const geometry = { columns: spec.width, rows: 32 };
	let inputHandler;
	const terminal = {
		start(onInput) { inputHandler = onInput; }, stop() {}, async drainInput() {}, write(text) { counts.bytes += Buffer.byteLength(text); },
		get columns() { return geometry.columns; }, get rows() { return geometry.rows; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
		setTitle() {}, setProgress() {}, kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
	};
	const tui = new TuiAltScreen(terminal, false);
	const manager = pi.SessionManager.inMemory("/performance", { id: "performance-session" });
	const getEntries = manager.getEntries.bind(manager);
	manager.getEntries = () => { counts.entries++; return getEntries(); };
	const model = { id: "synthetic-model", provider: "synthetic", reasoning: true, contextWindow: 200000 };
	const ctx = { model, sessionManager: manager, modelRegistry: { isUsingOAuth: () => false },
		getContextUsage() { counts.projections++; return pi.AgentSession.prototype.getContextUsage.call({ sessionManager: manager, _limitsModel: () => model }); } };
	const api = { getThinkingLevel: () => "high" };
	const footerData = { getGitBranch: () => "performance", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
	let clock = 0;
	const editor = new shell.GentlePromptEditor(tui, nativeTheme.getEditorTheme(), new KeybindingsManager(), {
		...theme, pending: () => false, now: () => live ? Date.now() : clock, doubleEscCancelEnabled: () => false,
		dispatchQueuedText() {}, requestRender() { counts.requests++; if (live) tui.requestRender(); },
	});
	let pulse = () => {};
	if (live) editor.setWorking(true);
	else {
		// Capture the actual quality interval callback, not a reimplementation.
		const original = globalThis.setInterval;
		try { globalThis.setInterval = (fn, ms) => { assert.equal(ms, 80); pulse = () => { counts.pulses++; fn(); }; return { unref() {} }; }; editor.setWorking(true); }
		finally { globalThis.setInterval = original; }
	}
	const document = new Container();
	const renderer = quiet.createQuietToolRenderer("read");
	const definition = { ...renderer, renderCall: (args, _theme, context) => renderer.renderCall(args, toolTheme, context),
		renderResult: (result, options, _theme, context) => renderer.renderResult(result, options, toolTheme, context) };
	let toolCount = 0;
	let latest;
	const append = () => {
		const id = `tool-${toolCount++}`;
		const args = { path: `src/file-${id}.ts` };
		const text = `Inspect **${id}** with Unicode 広い and ANSI-safe content.`;
		manager.appendMessage({ role: "user", content: text, timestamp: 1 });
		const assistant = { role: "assistant", content: [{ type: "text", text: "Checking `source` and a **settled** paragraph." }, { type: "toolCall", id, name: "read", arguments: args }],
			api: "openai-responses", provider: "synthetic", model: model.id, stopReason: "toolUse", timestamp: 1, usage };
		manager.appendMessage(assistant);
		const result = { content: [{ type: "text", text: `Result ${id}\nconst answer = 42;\n${"long wrapped output ".repeat(12)}` }], details: {}, isError: false };
		manager.appendMessage({ ...result, role: "toolResult", toolCallId: id, toolName: "read", timestamp: 1 });
		document.addChild(new UserMessageComponent(text));
		document.addChild(new AssistantMessageComponent(assistant));
		latest = new ToolExecutionComponent("read", id, args, {}, definition, tui, "/performance");
		latest.setArgsComplete(); latest.updateResult(result); document.addChild(latest);
	};
	for (let index = 0; index < spec.tools; index++) append();
	const footer = new Container();
	const modelForFrame = () => shell.buildShellBarModel(api, ctx, footerData);
	const bottom = shell.createShellBarComponent(api, ctx, tui, theme, footerData);
	footer.addChild(sidebar.sidebarPart(tui, "footer", bottom, {
		digest: () => JSON.stringify(modelForFrame()), render: (width) => bar.renderShellSidebarBar(modelForFrame(), theme, width), invalidate() {},
	}));
	const disposeHeader = sidebar.sidebarHeader(tui, { digest: () => JSON.stringify(modelForFrame()),
		render: (width) => bar.renderShellHeaderChrome(bar.buildShellHeaderModel(modelForFrame()), theme, width).rows, invalidate() {} });
	const viewport = createChatViewport({ document, pendingMessages: new Container(), status: new Container(), widgetsAbove: new Container(),
		editor, widgetsBelow: new Container(), footer, scrollbar: "hidden" });
	tui.setLayoutRoot(viewport.root); tui.setFocus(editor);
	let uninstall = layout.installSidebar(tui, theme);
	tui.start();
	const render = () => {
		tui.doRender();
		assert.equal(sidebar.sidebarState(tui).active, geometry.columns >= layout.SIDEBAR_BREAKPOINT, "sidebar must really own wide frames");
		assert.equal(cards.cardStyle(), spec.style);
		return [...tui.previousScreen];
	};
	return { tui, editor, manager, counts, render, input: (data) => inputHandler(data),
		advance() { clock += 80; pulse(); },
		apply(scenario, index) {
			if (scenario === "scroll") { if (index % 2) viewport.transcript.scrollToEnd(); else viewport.transcript.scrollTo(0, { disableFollow: true }); }
			if (scenario === "typing") { const text = editor.getText(); editor.handleInput("x"); assert.equal(editor.getText(), text + "x"); }
			if (scenario === "stream") latest.updateResult({ content: [{ type: "text", text: `stream ${index} ${"partial ".repeat(index + 1)}` }], details: {} }, true);
			if (scenario === "append") append();
			if (scenario === "resize") { const previous = geometry.columns; geometry.columns = index % 2 ? spec.width : Math.max(40, spec.width - 60); assert.notEqual(geometry.columns, previous); }
			if (scenario === "theme") {
				const previous = theme.bg("toolSuccessBg", "");
				pi.initTheme(index % 2 ? "dark" : "light");
				assert.notEqual(theme.bg("toolSuccessBg", ""), previous);
				document.invalidate(); editor.invalidate();
				uninstall(); uninstall = layout.installSidebar(tui, { ...theme });
			}
		},
		close() { editor.dispose(); disposeHeader(); uninstall(); bottom.dispose(); tui.stop(); },
	};
}

function controlled(spec) {
	globalThis.gc();
	const idleMemory = memory();
	const buildStart = performance.now();
	const scene = fixture(spec);
	const buildMs = performance.now() - buildStart;
	assert.equal(scene.counts.projections, 0, "first frame must not already have rendered");
	const coldStart = performance.now();
	const coldLines = scene.render();
	const coldMs = performance.now() - coldStart;
	const coldScreen = digest(coldLines);
	for (let index = 0; index < config.warmup; index++) { scene.advance(); scene.render(); }
	globalThis.gc();
	const warmMemory = memory();
	const initial = { ...scene.counts };
	const result = { spec, buildMs, coldMs, coldScreen, idleMemory, warmMemory, wallMs: [], cpuMs: [], screens: [] };
	const samples = ["resize", "theme"].includes(spec.scenario) ? Math.min(8, config.samples) : config.samples;
	try {
		for (let index = 0; index < samples; index++) {
			const cpu = process.cpuUsage();
			const start = performance.now();
			scene.advance(); scene.apply(spec.scenario, index);
			const screen = scene.render();
			result.wallMs.push(performance.now() - start);
			const used = process.cpuUsage(cpu);
			result.cpuMs.push((used.user + used.system) / 1000);
			result.screens.push(digest(screen));
		}
		result.counters = Object.fromEntries(Object.entries(scene.counts).map(([key, value]) => [key, value - initial[key]]));
		assert.equal(result.counters.pulses, samples, "every controlled frame advances the real quality pulse");
	} finally { scene.close(); }
	return result;
}

async function live(spec) {
	const scene = fixture(spec, true);
	for (let index = 0; index < config.warmup; index++) scene.render();
	scene.editor.setWorking(false); scene.editor.setWorking(true); // Align real pulse onset after warmup.
	const original = scene.tui.doRender.bind(scene.tui);
	const result = { spec, durationMs: config.liveMs, frameMs: [], inputToFrameMs: [], inputTimerDriftMs: [] };
	const started = performance.now();
	const initial = { ...scene.counts };
	let pendingInput;
	let expected = started + 100;
	scene.tui.doRender = () => {
		const start = performance.now(); original();
		result.frameMs.push(performance.now() - start);
		if (pendingInput !== undefined) { result.inputToFrameMs.push(performance.now() - pendingInput); pendingInput = undefined; }
	};
	const input = setInterval(() => {
		result.inputTimerDriftMs.push(performance.now() - expected); expected += 100;
		pendingInput ??= performance.now(); scene.input("x");
	}, 100);
	try { await new Promise((resolve) => setTimeout(resolve, config.liveMs)); }
	finally { clearInterval(input); scene.close(); }
	result.actualDurationMs = performance.now() - started;
	result.counters = Object.fromEntries(Object.entries(scene.counts).map(([key, value]) => [key, value - initial[key]]));
	return result;
}

const cases = [];
for (const tools of config.counts) for (const width of config.widths) for (const style of config.styles) {
	for (const scenario of ["pulse", "scroll", "typing", "stream", "append", "resize", "theme"]) {
		const result = controlled({ tools, width, style, scenario });
		// WeakRef keep-alive lasts until the job boundary; collect only after it.
		await new Promise((resolve) => setImmediate(resolve)); globalThis.gc(); result.closedMemory = memory(); cases.push(result);
	}
}
const liveRuns = config.liveMs ? [await live({ tools: Math.max(...config.counts), width: Math.max(...config.widths), style: config.styles[0], scenario: "real-quality-timers-and-typing" })] : [];
const metadata = { piVersion, tuiVersion,
	editorIdentityVerified: true, animation: "quality/80ms", terminal: "in-memory ANSI sink; no emulator", scheduler: "controlled quality callback; separate real-timer run" };
console.log(JSON.stringify({ metadata, cases, live: liveRuns }));
