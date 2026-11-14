import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findAll, flush, heardGeneration, inspectorPick, loadCanvas, memoryStorage, read, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// The token inspector (canvas-tokens.js): with Technical details on (a checkbox in the rail's Settings,
// off by default, saved in this browser), Comment mode shows a panel beside the frame of the hovered
// element (inspector.js gd:inspect) with its computed values, the design/system.md token each one
// matches or "⚠ no token" with the nearest, the WCAG contrast, Ask the agent to fix and Copy. Covers
// every reload, stale-identity and exit path the maintainer probes (S7). Every assertion compares
// strings, numbers or booleans, never fake elements, which node:assert would walk whole on a failure.

const TOKENS_URL = "/t/api/system/tokens";
const TECHNICAL_KEY = "gentle-design:technical";
const HIDE_MS = 300;
// While a panel shows, the pointer must rest this long on another element before the panel follows it.
const DWELL_MS = 250;

const TOKEN_SET = { exists: true, tokens: [
	{ name: "--bg", value: "#1a1218", section: "Colors", group: "color" },
	{ name: "--surface-2", value: "#342230", section: "Colors", group: "color" },
	{ name: "--border", value: "#342230", section: "Colors", group: "color" },
	{ name: "--text", value: "#f6eff3", section: "Colors", group: "color" },
	{ name: "--text-muted", value: "#a78e9b", section: "Colors", group: "color" },
	{ name: "--text-faint", value: "#76616b", section: "Colors", group: "color" },
	{ name: "--paper", value: "#ffffff", section: "Colors", group: "color" },
	{ name: "--font-sans", value: 'Inter, "SF Pro Text", system-ui, sans-serif', section: "Typography", group: "font" },
	{ name: "--radius-sm", value: "8px", section: "Radius", group: "radius" },
	{ name: "--radius-md", value: "12px", section: "Radius", group: "radius" },
	{ name: "--rail-width", value: "60px", section: "Layout", group: "layout" },
] };
const EXTRA_TOKENS = { exists: true, tokens: [...TOKEN_SET.tokens,
	{ name: "--space-2", value: "8px", section: "Spacing", group: "spacing" },
	{ name: "--space-4", value: "16px", section: "Spacing", group: "spacing" },
	{ name: "--text-sm", value: "12px", section: "Typography", group: "font" },
	{ name: "--text-md", value: "14px", section: "Typography", group: "font" },
] };

/** What inspector.js reports for one element (gd:inspect): computed values, lengths in CSS px. */
const MEASURE = {
	selector: "main > p.or", label: "p.or", text: "or pay with card", hasText: true,
	rect: { x: 30, y: 40, width: 200, height: 20 },
	color: { r: 118, g: 97, b: 107, a: 1 }, background: { r: 255, g: 255, b: 255 },
	fontFamily: 'Inter, "SF Pro Text", system-ui, sans-serif', fontSize: 14, fontWeight: 400, lineHeight: 21,
	margin: [8, 0, 8, 0], padding: [0, 0, 0, 0], radius: [0, 0, 0, 0],
};
// Off the system: #96828c is no token and 3.6 : 1 on white; a 10 px radius sits between the radius tokens.
const OFF = { ...MEASURE, color: { r: 150, g: 130, b: 140, a: 1 }, radius: [10, 10, 10, 10] };
const MATCHING = { ...MEASURE, color: { r: 246, g: 239, b: 243, a: 1 }, background: { r: 26, g: 18, b: 24 } };

const WIDE_ALPHA = { "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [
	{ file: "01-a.html", title: "First", tradeoff: "", width: 1200, height: 800 },
	{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 },
] } };
const SYSTEM_REPLY = { "/t/api/system": { exists: true, file: "system.html", width: 800, height: 600 } };

type Options = { replies?: Record<string, unknown>; tokens?: unknown; stored?: string; broken?: boolean; extraWindow?: Record<string, unknown>; timers?: boolean };

/** The canvas with an in-memory localStorage; `timers` keeps the canvas's timeouts until the test runs them. */
async function loadTokens(options: Options = {}) {
	const storage = memoryStorage(options.stored === undefined ? {} : { [TECHNICAL_KEY]: options.stored }, options.broken);
	// Every timer the canvas set, in order; its id is its index + 1, and `done` once it ran or was cleared.
	const timers: Array<{ callback: () => void; ms: number; done: boolean }> = [];
	const clock = options.timers ? {
		setTimeout: (callback: () => void, ms = 0) => timers.push({ callback, ms, done: false }),
		clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].done = true; },
	} : {};
	const replies = { ...(options.tokens === undefined ? { [TOKENS_URL]: TOKEN_SET } : options.tokens === null ? {} : { [TOKENS_URL]: options.tokens }), ...options.replies };
	const canvas = await loadCanvas(300, replies, {}, { localStorage: storage.localStorage, ...clock, ...options.extraWindow });
	// The fake DOM starts every element visible; index.html starts these hidden.
	for (const id of ["gd-popover", "gd-menu", "gd-device-menu", "gd-inspector"]) canvas.document.getElementById(id).hidden = true;
	/** Runs the pending timers of `ms` (every pending one without it), as if that time passed; others stay pending. */
	const run = (ms?: number) => {
		for (const timer of timers.slice()) {
			if (timer.done || (ms !== undefined && timer.ms !== ms)) continue;
			timer.done = true;
			timer.callback();
		}
	};
	/** The panel's pending hide timers (the 300 ms ones). */
	const runHide = () => run(HIDE_MS);
	/** The panel's pending switch to another element (the 250 ms rest). */
	const runDwell = () => run(DWELL_MS);
	return { ...canvas, storage, run, runHide, runDwell, timers };
}
type Canvas = Awaited<ReturnType<typeof loadTokens>>;

const $ = (canvas: Canvas, id: string) => canvas.document.getElementById(id);
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };
function deferred() {
	let answer!: (value: unknown) => void;
	const promise = new Promise((resolve) => { answer = resolve; });
	return { promise, answer };
}

const menuEl = (canvas: Canvas) => $(canvas, "gd-menu");
const settingsItems = (canvas: Canvas) => findAll(menuEl(canvas), (element) => (element.getAttribute("role") ?? "").startsWith("menuitem"));
const technicalItem = (canvas: Canvas) => settingsItems(canvas).find((item) => texts(item, "gd-menu-label")[0] === "Technical details");
/** Technical details as Settings shows it: "true" or "false" (aria-checked), the menu closed again. */
function technicalShown(canvas: Canvas) {
	$(canvas, "gd-rail-settings").dispatch("click");
	const checked = technicalItem(canvas)?.getAttribute("aria-checked") ?? "missing";
	$(canvas, "gd-rail-settings").dispatch("click");
	return checked;
}
function toggleTechnical(canvas: Canvas) {
	$(canvas, "gd-rail-settings").dispatch("click");
	technicalItem(canvas)!.dispatch("click");
}
const commentMode = (canvas: Canvas) => $(canvas, "gd-comment").dispatch("click");
/** Technical details on and Comment mode on, the way a person turns them on. */
async function inspecting(options: Options = {}) {
	const canvas = await loadTokens(options);
	canvas.viewport.rect = { left: 0, top: 50, width: 1000, height: 1400 };
	toggleTechnical(canvas);
	commentMode(canvas);
	return canvas;
}
/** A gd:inspect as inspector.js posts it from `frame`'s page now: tagged with the size generation that page heard last. */
function inspect(canvas: Canvas, frame: FakeElement, element: unknown = MEASURE, generation = heardGeneration(frame)) {
	canvas.message(frame.contentWindow, { type: "gd:inspect", element, generation });
}

const panelOf = (canvas: Canvas) => $(canvas, "gd-inspector");
const shown = (canvas: Canvas) => !panelOf(canvas).hidden;
function allText(element: FakeElement): string {
	return [element.textContent, ...element.children.map(allText)].filter(Boolean).join(" ");
}
const rows = (canvas: Canvas) => withClass($(canvas, "gd-inspector-list"), "gd-inspector-row");
const rowOf = (canvas: Canvas, label: string) => rows(canvas).find((row) => texts(row, "gd-inspector-label")[0] === label);
const rowText = (canvas: Canvas, label: string) => { const row = rowOf(canvas, label); return row ? allText(withClass(row, "gd-inspector-value")[0]) : ""; };
const flagged = (canvas: Canvas, label: string) => withClass(rowOf(canvas, label)!, "gd-inspector-bad").length;

const focusOn = (canvas: Canvas, index = 0) => canvas.boards[index].shield!.dispatch("keydown", { key: "Enter" });
const chooseSize = (canvas: Canvas, size: string) => {
	if ($(canvas, "gd-device-menu").hidden) $(canvas, "gd-device").dispatch("click");
	findAll($(canvas, "gd-device-menu"), (element) => element.dataset.size === size)[0].dispatch("click");
};
const sizeFrames = (canvas: Canvas) => withClass(canvas.viewport, "gd-size-frame").map((root) => findAll(root, (element) => element.localName === "iframe")[0]);

// ---- tokens: load and reload (S8)

test("the canvas reads the tokens at start and again when design/system.md changes, and only then", async () => {
	const canvas = await loadTokens();
	const reads = () => canvas.fetched.filter((url) => url === TOKENS_URL).length;
	assert.equal(reads(), 1, "once at start");
	await canvas.serverEvent("change", { slug: null, file: "system.md" });
	assert.equal(reads(), 2, "again when system.md changes");
	await canvas.serverEvent("change", { slug: null, file: "system.html" });
	await canvas.serverEvent("change", { slug: "alpha", file: "system.md" });
	assert.equal(reads(), 2, "system.html is the board, and only the root system.md holds the tokens");
});

test("a missing, failing or malformed tokens reply never touches the status line", async () => {
	for (const reply of [null, { __http: 500, error: "boom" }, { __throw: "down" }, { exists: true, tokens: "nope" }, "text", { exists: true, tokens: [{ name: 3 }, null, { name: "--a", value: "#fff" }] }]) {
		const canvas = await loadTokens({ tokens: reply });
		assert.equal($(canvas, "gd-status").textContent, "", JSON.stringify(reply));
		assert.equal(canvas.frames().length, 2, "the canvas still shows the design");
		await canvas.serverEvent("change", { slug: null, file: "system.md" });
		assert.equal($(canvas, "gd-status").textContent, "", JSON.stringify(reply));
		assert.equal($(canvas, "gd-status").classes.has("gd-error"), false);
	}
});

test("a system.md change while a tokens read is in flight: the newest read wins, and a failed read keeps the last tokens", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	const ink = (name: string) => ({ exists: true, tokens: [{ name, value: "#010203", section: "Colors", group: "color" }] });
	const late = deferred();
	canvas.replies[TOKENS_URL] = late.promise;
	await canvas.serverEvent("change", { slug: null, file: "system.md" });
	canvas.replies[TOKENS_URL] = ink("--ink-new");
	await canvas.serverEvent("change", { slug: null, file: "system.md" });
	late.answer(ink("--ink-old"));
	await settle();
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 1, g: 2, b: 3, a: 1 } });
	assert.equal(rowText(canvas, "Color"), "#010203 ✓ --ink-new", "the older reply, landing last, changes nothing");
	for (const reply of [{ __http: 500 }, { __throw: "down" }, { exists: true, tokens: "nope" }]) {
		canvas.replies[TOKENS_URL] = reply;
		await canvas.serverEvent("change", { slug: null, file: "system.md" });
		inspect(canvas, first.frame, { ...MEASURE, color: { r: 1, g: 2, b: 3, a: 1 } });
		assert.equal(rowText(canvas, "Color"), "#010203 ✓ --ink-new", `a failed read keeps the tokens: ${JSON.stringify(reply)}`);
	}
	// A system.md that is gone (exists: false) has no tokens.
	canvas.replies[TOKENS_URL] = { exists: false, tokens: [] };
	await canvas.serverEvent("change", { slug: null, file: "system.md" });
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 1, g: 2, b: 3, a: 1 } });
	assert.equal(rowText(canvas, "Color"), "#010203");
	assert.equal($(canvas, "gd-inspector-note").hidden, false);
});

test("only well-formed tokens count: a custom property name, a value, at most 500", async () => {
	const many = Array.from({ length: 501 }, (_, index) => ({ name: `--c${index}`, value: index === 500 ? "#010203" : "#ffffff", section: "Colors", group: "color" }));
	const bad = [{ name: "ink", value: "#010203" }, { name: "--ink", value: "" }, { name: "--ink;x", value: "#010203" }, { name: "--ink", value: 3 }];
	for (const tokens of [many, bad]) {
		const canvas = await inspecting({ tokens: { exists: true, tokens } });
		inspect(canvas, canvas.boards[0].frame, { ...MEASURE, color: { r: 1, g: 2, b: 3, a: 1 } });
		assert.ok(!/✓/.test(rowText(canvas, "Color")), JSON.stringify(tokens.slice(-1)));
	}
});

// ---- Technical details in Settings (S8)

test("Technical details is a checkbox item in Settings, off by default and remembered in this browser", async () => {
	const canvas = await loadTokens();
	$(canvas, "gd-rail-settings").dispatch("click");
	assert.deepEqual(settingsItems(canvas).map((item) => texts(item, "gd-menu-label")[0]), ["Design system board", "Keyboard shortcuts", "Technical details", "Español", "English", "Match the browser"]);
	const item = technicalItem(canvas)!;
	assert.equal(item.getAttribute("role"), "menuitemcheckbox");
	assert.equal(item.getAttribute("aria-checked"), "false");
	assert.equal(withClass(item, "gd-menu-check").length, 1, "a check mark, shown while it is on");
	assert.equal(findAll(item, (element) => element.localName === "use")[0].getAttribute("href"), "#i-code");
	item.dispatch("click");
	assert.equal(menuEl(canvas).hidden, true, "choosing it closes the menu");
	assert.equal(canvas.document.activeElement?.id, "gd-rail-settings");
	assert.equal(technicalShown(canvas), "true");
	const writes = () => canvas.storage.writes.filter(([key]) => key === TECHNICAL_KEY).map(([, value]) => value);
	assert.deepEqual(writes(), ["on"]);
	toggleTechnical(canvas);
	assert.equal(technicalShown(canvas), "false");
	assert.deepEqual(writes(), ["on", "off"]);

	for (const [stored, checked] of [["on", "true"], ["off", "false"], ["yes", "false"], ["", "false"]]) {
		assert.equal(technicalShown(await loadTokens({ stored })), checked, `stored "${stored}"`);
	}
});

test("storage that throws starts Technical details off and still lets it be turned on for the page", async () => {
	const canvas = await loadTokens({ broken: true });
	assert.equal(technicalShown(canvas), "false");
	toggleTechnical(canvas);
	assert.equal(technicalShown(canvas), "true");
	commentMode(canvas);
	inspect(canvas, canvas.boards[0].frame);
	assert.equal(shown(canvas), true);
	assert.equal($(canvas, "gd-status").classes.has("gd-error"), false);
});

// ---- when the panel shows (S8)

test("the panel shows only with Technical details on, in Comment mode, the comment box closed, from a trusted design frame", async () => {
	const canvas = await loadTokens();
	const [first] = canvas.boards;
	commentMode(canvas);
	inspect(canvas, first.frame);
	assert.equal(shown(canvas), false, "Technical details is off by default");
	toggleTechnical(canvas);
	$(canvas, "gd-tool-navigate").dispatch("click");
	inspect(canvas, first.frame);
	assert.equal(shown(canvas), false, "not in Move mode");
	commentMode(canvas);
	canvas.message({}, { type: "gd:inspect", element: MEASURE });
	assert.equal(shown(canvas), false, "a stranger is not trusted");
	for (const bad of [undefined, 3, "x", {}, { ...MEASURE, rect: null }, { ...MEASURE, margin: [1] }, { ...MEASURE, selector: "" }, { ...MEASURE, selector: "x".repeat(501) }, { ...MEASURE, fontSize: "big" }, { ...MEASURE, color: { r: 999, g: 0, b: 0, a: 1 } }, { ...MEASURE, background: { r: 1, g: 2 } }, { ...MEASURE, lineHeight: "21px" }]) {
		canvas.message(first.frame.contentWindow, { type: "gd:inspect", element: bad });
		assert.equal(shown(canvas), false, JSON.stringify(bad));
	}
	inspect(canvas, first.frame);
	assert.equal(shown(canvas), true);
	// The comment box takes the panel's place, and no report reopens the panel while the box is open.
	canvas.message(first.frame.contentWindow, inspectorPick(first.frame, { type: "gd:pick", selector: "main > p.or", excerpt: "", rect: { x: 1, y: 1, width: 2, height: 2 } }));
	assert.equal($(canvas, "gd-popover").hidden, false);
	assert.equal(shown(canvas), false, "the comment box opening hides the panel");
	inspect(canvas, first.frame);
	assert.equal(shown(canvas), false, "not while the comment box is open");
	$(canvas, "gd-popover-cancel").dispatch("click");
	inspect(canvas, first.frame);
	assert.equal(shown(canvas), true);
});

test("the design system board never shows the panel", async () => {
	const canvas = await inspecting({ replies: SYSTEM_REPLY });
	const [system, first] = canvas.frames();
	inspect(canvas, system);
	assert.equal(shown(canvas), false);
	inspect(canvas, first);
	assert.equal(shown(canvas), true);
});

test("in focus mode only the focused artboard and its All sizes frames show the panel; another artboard's report is ignored", async () => {
	const canvas = await inspecting({ replies: WIDE_ALPHA });
	const [first, second] = canvas.boards;
	focusOn(canvas, 0);
	inspect(canvas, second.frame);
	assert.equal(shown(canvas), false, "another artboard than the focused one");
	inspect(canvas, first.frame);
	assert.equal(shown(canvas), true);
	chooseSize(canvas, "all");
	assert.equal(shown(canvas), false, "a new size hides it: the frame it was beside changed");
	const [phone] = sizeFrames(canvas);
	phone.rect = { left: 100, top: 200, width: 195, height: 422 };
	inspect(canvas, second.frame);
	assert.equal(shown(canvas), false, "still not another artboard's frame");
	inspect(canvas, phone, { ...MEASURE, rect: { x: 40, y: 100, width: 100, height: 40 } });
	assert.equal(shown(canvas), true, "a size frame of the focused artboard");
	// Placed against the scaled 390 px frame (195 px on screen): right of it, level with the element.
	assert.equal(panelOf(canvas).style.left, `${295 + 12}px`);
	assert.equal(panelOf(canvas).style.top, `${200 + 100 * 0.5 - 50}px`);
});

test("the panel sits beside the frame, not over the element: right, else left, else below it inside the viewport", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	const place = () => [Number.parseFloat(panelOf(canvas).style.left), Number.parseFloat(panelOf(canvas).style.top) + 50];
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	inspect(canvas, first.frame);
	assert.deepEqual(place(), [512, 160], "right of the frame, level with the element");
	first.frame.rect = { left: 560, top: 120, width: 400, height: 300 };
	inspect(canvas, first.frame);
	assert.deepEqual(place(), [560 - 12 - 280, 160], "no room on the right: left of the frame");
	canvas.viewport.rect = { left: 0, top: 50, width: 420, height: 1400 };
	first.frame.rect = { left: 10, top: 120, width: 400, height: 300 };
	inspect(canvas, first.frame);
	assert.deepEqual(place(), [40, 188], "no room on either side: below the element, inside the viewport");
});

// ---- what the panel says (S8)

test("the panel names the element, its values and the token each one matches", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MATCHING, radius: [8, 8, 8, 8] });
	assert.equal($(canvas, "gd-inspector-title").textContent, "p.or");
	assert.equal($(canvas, "gd-inspector-selector").textContent, "main > p.or");
	assert.deepEqual(rows(canvas).map((row) => texts(row, "gd-inspector-label")[0]), ["Color", "Background", "Contrast", "Font", "Size", "Line height", "Spacing", "Radius"]);
	assert.equal(rowText(canvas, "Color"), "#f6eff3 ✓ --text");
	assert.equal(rowText(canvas, "Background"), "#1a1218 ✓ --bg");
	assert.match(rowText(canvas, "Contrast"), /^✓ \d+(\.\d+)? : 1 AA \(4\.5 : 1\)$/);
	assert.equal(rowText(canvas, "Font"), "Inter ✓ --font-sans");
	assert.equal(rowText(canvas, "Size"), "14 px weight 400", "no font size tokens: the value alone");
	assert.equal(rowText(canvas, "Line height"), "21 px");
	assert.equal(rowText(canvas, "Spacing"), "margin 8 0 8 0", "no spacing tokens: the value alone");
	assert.equal(rowText(canvas, "Radius"), "8 px ✓ --radius-sm");
	assert.equal(withClass($(canvas, "gd-inspector-list"), "gd-inspector-bad").length, 0, "nothing flagged");
	assert.deepEqual(withClass($(canvas, "gd-inspector-list"), "gd-inspector-swatch").map((swatch) => swatch.style.background), ["rgb(246, 239, 243)", "rgb(26, 18, 24)"]);
	assert.equal($(canvas, "gd-inspector-note").hidden, true, "there are tokens");
	// Two tokens with one value: both named.
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 52, g: 34, b: 48, a: 1 } });
	assert.equal(rowText(canvas, "Color"), "#342230 ✓ --surface-2 / --border");
});

test("a value off the system shows ⚠ no token and the nearest token: colors by OKLab distance, lengths by numeric distance", async () => {
	const canvas = await inspecting({ tokens: EXTRA_TOKENS });
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 119, g: 97, b: 107, a: 1 } });
	assert.equal(rowText(canvas, "Color"), "#77616b ⚠ no token Nearest --text-faint #76616b");
	assert.equal(flagged(canvas, "Color"), 1);
	inspect(canvas, first.frame, { ...MEASURE, background: { r: 40, g: 10, b: 20 } });
	assert.equal(rowText(canvas, "Background"), "#280a14 ⚠ no token Nearest --bg #1a1218", "a dark reddish background is perceptually nearest the dark plum");
	inspect(canvas, first.frame, { ...MEASURE, fontFamily: "Arial, sans-serif", fontSize: 13.4, radius: [10, 10, 10, 10], margin: [8, 0, 12, 0], padding: [0, 16, 0, 16] });
	assert.equal(rowText(canvas, "Font"), "Arial ⚠ no token");
	assert.equal(rowText(canvas, "Size"), "13.4 px ⚠ no token Nearest --text-md 14px weight 400");
	assert.equal(rowText(canvas, "Radius"), "10 px ⚠ no token Nearest --radius-sm 8px");
	assert.equal(rowText(canvas, "Spacing"), "margin 8 0 12 0 padding 0 16 0 16 ⚠ 12 px off scale Nearest --space-2 8px");
	inspect(canvas, first.frame, { ...MEASURE, fontSize: 12, margin: [8, 0, 16, 0], fontFamily: "inter, Arial" });
	assert.equal(rowText(canvas, "Size"), "12 px ✓ --text-sm weight 400");
	assert.equal(rowText(canvas, "Spacing"), "margin 8 0 16 0 ✓ on scale");
	assert.equal(rowText(canvas, "Font"), "inter ✓ --font-sans", "the first family of a token's stack counts, in any case");
	inspect(canvas, first.frame, { ...MEASURE, radius: [8, 8, 0, 12], lineHeight: null });
	assert.equal(rowText(canvas, "Radius"), "8 8 0 12 px", "mixed corners on the scale");
	assert.equal(rowText(canvas, "Line height"), "normal");
	inspect(canvas, first.frame, { ...MEASURE, radius: [8, 8, 0, 9] });
	assert.equal(rowText(canvas, "Radius"), "8 8 0 9 px ⚠ 9 px no token");
});

test("rem tokens are converted with the root font size the frame reports, 16 px when it reports none", async () => {
	const REM_TOKENS = { exists: true, tokens: [...TOKEN_SET.tokens,
		{ name: "--space-4", value: "1.6rem", section: "Spacing", group: "spacing" },
		{ name: "--text-md", value: "1.4rem", section: "Typography", group: "font" },
	] };
	const canvas = await inspecting({ tokens: REM_TOKENS });
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MEASURE, rootFontSize: 10, fontSize: 14, margin: [0, 0, 0, 0], padding: [16, 16, 16, 16] });
	assert.equal(rowText(canvas, "Spacing"), "padding 16 16 16 16 ✓ on scale", "1.6rem is 16 px under a 10 px root");
	assert.equal(rowText(canvas, "Size"), "14 px ✓ --text-md weight 400", "1.4rem is 14 px under a 10 px root");
	assert.equal(withClass($(canvas, "gd-inspector-list"), "gd-inspector-bad").length, 0, "nothing flagged");
	inspect(canvas, first.frame, { ...MEASURE, fontSize: 22.4, margin: [0, 0, 0, 0], padding: [25.6, 0, 0, 0] });
	assert.equal(rowText(canvas, "Spacing"), "padding 25.6 0 0 0 ✓ on scale", "no root font size reported: 16 px");
	assert.equal(rowText(canvas, "Size"), "22.4 px ✓ --text-md weight 400");
	inspect(canvas, first.frame, { ...MEASURE, rootFontSize: 16, fontSize: 14, margin: [0, 0, 0, 0], padding: [16, 0, 0, 0] });
	assert.equal(rowText(canvas, "Spacing"), "padding 16 0 0 0 ⚠ 16 px off scale Nearest --space-4 1.6rem", "under a 16 px root 1.6rem is 25.6 px");
	assert.equal(rowText(canvas, "Size"), "14 px ⚠ no token Nearest --text-md 1.4rem weight 400");
});

test("negative margins are checked against the spacing scale by their size", async () => {
	const canvas = await inspecting({ tokens: EXTRA_TOKENS });
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MEASURE, margin: [-12, 0, 0, 0] });
	assert.equal(rowText(canvas, "Spacing"), "margin -12 0 0 0 ⚠ -12 px off scale Nearest --space-2 8px");
	assert.equal(flagged(canvas, "Spacing"), 1);
	inspect(canvas, first.frame, { ...MEASURE, margin: [-8, 0, 16, 0] });
	assert.equal(rowText(canvas, "Spacing"), "margin -8 0 16 0 ✓ on scale", "-8 px is the 8 px token pulled the other way");
	assert.equal(flagged(canvas, "Spacing"), 0);
});

test("contrast is the WCAG ratio, flagged under AA (4.5 : 1, 3 : 1 for large text) and never rounded up", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	const grey = (value: number, a = 1) => ({ r: value, g: value, b: value, a });
	const contrast = (extra: Record<string, unknown>) => {
		inspect(canvas, first.frame, { ...MEASURE, ...extra });
		return [rowText(canvas, "Contrast"), flagged(canvas, "Contrast")];
	};
	assert.deepEqual(contrast({ color: grey(0x76) }), ["✓ 4.54 : 1 AA (4.5 : 1)", 0]);
	assert.deepEqual(contrast({ color: grey(0x77) }), ["⚠ 4.47 : 1 needs 4.5 : 1", 1], "4.478 shows as 4.47");
	assert.deepEqual(contrast({ color: grey(0x77), fontSize: 24 }), ["✓ 4.47 : 1 AA large text (3 : 1)", 0]);
	assert.deepEqual(contrast({ color: grey(0x77), fontSize: 18.66, fontWeight: 700 }), ["✓ 4.47 : 1 AA large text (3 : 1)", 0]);
	assert.deepEqual(contrast({ color: grey(0x77), fontSize: 18.66, fontWeight: 400 }), ["⚠ 4.47 : 1 needs 4.5 : 1", 1], "18.66 px regular is not large");
	assert.deepEqual(contrast({ color: grey(0xaa), fontSize: 24 }), ["⚠ 2.32 : 1 needs 3 : 1 (large text)", 1]);
	assert.deepEqual(contrast({ color: grey(0) }), ["✓ 21 : 1 AA (4.5 : 1)", 0]);
	assert.deepEqual(contrast({ color: grey(0, 0.5) }), ["⚠ 3.94 : 1 needs 4.5 : 1", 1], "translucent text is composited over its background");
	assert.deepEqual(contrast({ hasText: false }), ["—", 0], "no text, no ratio");
	assert.deepEqual(contrast({ background: null }), ["unknown background", 0]);
	assert.equal(rowText(canvas, "Background"), "image or gradient");
	inspect(canvas, first.frame, { ...MEASURE, color: null });
	assert.equal(rowText(canvas, "Color"), "unreadable");
});

test("without tokens, or without tokens of a kind, the panel shows the values and compares nothing", async () => {
	for (const tokens of [null, { exists: false, tokens: [] }]) {
		const canvas = await inspecting({ tokens });
		inspect(canvas, canvas.boards[0].frame);
		assert.equal(shown(canvas), true);
		assert.equal(rowText(canvas, "Color"), "#76616b");
		assert.ok(!/no token/.test(allText($(canvas, "gd-inspector-list"))));
		assert.equal($(canvas, "gd-inspector-note").hidden, false);
		assert.equal($(canvas, "gd-inspector-note").textContent, "No design/system.md tokens found, so values and contrast are shown without a comparison.");
	}
});

// ---- hiding (S8: the 300 ms timer and every exit path)

test("leaving the element hides the panel after 300 ms unless the pointer or the keyboard is in it, or another element came", async () => {
	const canvas = await inspecting({ timers: true });
	const [first, second] = canvas.boards;
	inspect(canvas, first.frame);
	inspect(canvas, first.frame, null);
	assert.equal(shown(canvas), true, "not at once: the pointer may be on its way to the buttons");
	canvas.runHide();
	assert.equal(shown(canvas), false);

	inspect(canvas, first.frame);
	inspect(canvas, second.frame, null);
	canvas.runHide();
	assert.equal(shown(canvas), true, "another frame leaving its element does not hide this one");

	panelOf(canvas).dispatch("pointerenter");
	inspect(canvas, first.frame, null);
	canvas.runHide();
	assert.equal(shown(canvas), true, "the pointer is on the panel");
	panelOf(canvas).dispatch("pointerleave");
	canvas.runHide();
	assert.equal(shown(canvas), false, "and leaves when it leaves");

	inspect(canvas, first.frame);
	const copy = $(canvas, "gd-inspector-copy");
	copy.parentElement = panelOf(canvas);
	copy.focus();
	inspect(canvas, first.frame, null);
	canvas.runHide();
	assert.equal(shown(canvas), true, "keyboard focus inside keeps it");
	canvas.document.body.focus();
	copy.dispatch("focusout", { relatedTarget: canvas.document.body });
	canvas.runHide();
	assert.equal(shown(canvas), false, "and it goes once focus leaves it");

	inspect(canvas, first.frame);
	inspect(canvas, first.frame, null);
	inspect(canvas, first.frame, { ...MEASURE, selector: "main > h1", label: "h1" });
	canvas.runHide();
	assert.equal(shown(canvas), true, "a new element cancels the pending hide");
	canvas.runDwell();
	assert.equal($(canvas, "gd-inspector-title").textContent, "h1", "and the panel follows it once the pointer rests on it");
});

test("focus leaving the panel hides it after the grace, unless it stays in the panel or the pointer is on it; Esc in the panel closes it", async () => {
	const canvas = await inspecting({ timers: true });
	const [first] = canvas.boards;
	const copy = $(canvas, "gd-inspector-copy");
	const fix = $(canvas, "gd-inspector-fix");
	copy.parentElement = panelOf(canvas);
	fix.parentElement = panelOf(canvas);
	inspect(canvas, first.frame, OFF);
	fix.focus();
	copy.dispatch("focusout", { relatedTarget: fix });
	canvas.runHide();
	assert.equal(shown(canvas), true, "Tab from Copy to Ask the agent to fix stays in the panel");
	panelOf(canvas).dispatch("pointerenter");
	canvas.document.body.focus();
	fix.dispatch("focusout", { relatedTarget: canvas.document.body });
	canvas.runHide();
	assert.equal(shown(canvas), true, "the pointer is on the panel");
	panelOf(canvas).dispatch("pointerleave");
	canvas.runHide();
	assert.equal(shown(canvas), false);

	inspect(canvas, first.frame, OFF);
	copy.focus();
	canvas.document.activeElement = null;
	copy.dispatch("focusout", { relatedTarget: null });
	canvas.runHide();
	assert.equal(shown(canvas), false, "focus leaving the page");

	inspect(canvas, first.frame, OFF);
	copy.focus();
	const esc = copy.dispatch("keydown", { key: "Escape" });
	assert.equal(shown(canvas), false, "Esc closes it at once");
	assert.equal(esc.defaultPrevented, true, "and only it: Comment mode stays on");
	assert.equal(canvas.document.activeElement?.id, "gd-viewport", "focus goes back to the canvas");
	assert.equal($(canvas, "gd-status").textContent, "Comment mode: click an element in an artboard");

	focusOn(canvas, 0);
	inspect(canvas, first.frame, OFF);
	copy.focus();
	copy.dispatch("keydown", { key: "Escape" });
	assert.equal(shown(canvas), false);
	assert.equal(canvas.document.activeElement === first.frame, true, "in focus mode, to the open artboard");
});

// ---- hover intent (L4: the pointer must be able to reach the panel's buttons)

test("while the panel shows, quick passes over other elements keep it, so the pointer can reach Ask the agent to fix", async () => {
	const canvas = await inspecting({ timers: true });
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	const place = () => [panelOf(canvas).style.left, panelOf(canvas).style.top];
	const title = () => $(canvas, "gd-inspector-title").textContent;
	inspect(canvas, first.frame, OFF);
	assert.equal(shown(canvas), true, "the first panel shows at once");
	const at = place();
	// On its way to the panel the pointer crosses other elements of the artboard, then leaves the frame.
	inspect(canvas, first.frame, { ...MEASURE, selector: "main > h1", label: "h1", rect: { x: 30, y: 200, width: 200, height: 30 } });
	inspect(canvas, first.frame, { ...MEASURE, selector: "main > button", label: "button", rect: { x: 30, y: 260, width: 120, height: 32 } });
	assert.deepEqual([title(), ...place()], ["p.or", ...at], "quick passes keep the element and the place");
	inspect(canvas, first.frame, null);
	panelOf(canvas).dispatch("pointerenter");
	canvas.run();
	assert.deepEqual([shown(canvas), title(), ...place()], [true, "p.or", ...at], "on the panel nothing changes");
	inspect(canvas, first.frame, { ...MATCHING, selector: "main > h2", label: "h2" });
	canvas.run();
	assert.equal(title(), "p.or", "no report changes it while the pointer is on it");
	$(canvas, "gd-inspector-fix").dispatch("click");
	assert.equal($(canvas, "gd-popover-target").textContent, "01-a.html · main > p.or", "Ask the agent to fix opens the element the panel showed");
	assert.match($(canvas, "gd-popover-text").value, /^Fix the values on main > p\.or /);
});

test("S2: re-measures of the element the pointer rests on do not restart the 250 ms rest; the panel switches with its latest values", async () => {
	const canvas = await inspecting({ timers: true });
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	const title = () => $(canvas, "gd-inspector-title").textContent;
	const h1 = { ...MEASURE, selector: "main > h1", label: "h1", rect: { x: 30, y: 200, width: 200, height: 30 } };
	inspect(canvas, first.frame);
	inspect(canvas, first.frame, h1);
	// Late loads or page changes re-measure h1 about every 100 ms while the pointer stays on it.
	inspect(canvas, first.frame, { ...h1, rect: { ...h1.rect, y: 190 } });
	inspect(canvas, first.frame, { ...h1, rect: { ...h1.rect, y: 180 } });
	assert.equal(title(), "p.or", "before the rest the panel keeps its element");
	// Only the 250 ms that started when the pointer reached h1 pass.
	const rest = canvas.timers.find((timer) => !timer.done && timer.ms === DWELL_MS)!;
	rest.done = true;
	rest.callback();
	assert.deepEqual([title(), panelOf(canvas).style.top], ["h1", "250px"], "250 ms after the pointer reached h1, its latest measurement");
	assert.equal(canvas.timers.filter((timer) => !timer.done && timer.ms === DWELL_MS).length, 0, "no second rest is waiting");
});

test("resting 250 ms on another element switches the panel to it; its own element re-places it at once; leaving everything hides it", async () => {
	const canvas = await inspecting({ timers: true });
	const [first, second] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	second.frame.rect = { left: 100, top: 520, width: 400, height: 300 };
	const title = () => $(canvas, "gd-inspector-title").textContent;
	const top = () => panelOf(canvas).style.top;
	const h1 = { ...MEASURE, selector: "main > h1", label: "h1", rect: { x: 30, y: 200, width: 200, height: 30 } };
	inspect(canvas, first.frame);
	inspect(canvas, first.frame, h1);
	assert.deepEqual([title(), top()], ["p.or", "110px"]);
	canvas.runDwell();
	assert.deepEqual([title(), top()], ["h1", "270px"], "the pointer rested on it");
	inspect(canvas, first.frame, { ...h1, rect: { ...h1.rect, y: 100 } });
	assert.equal(top(), "170px", "the shown element, scrolled: re-placed at once");

	inspect(canvas, first.frame);
	inspect(canvas, first.frame, h1);
	canvas.runDwell();
	assert.deepEqual([title(), top()], ["h1", "270px"], "back on the shown element before the rest: no switch");

	// The pointer goes to another artboard: its frame's element after the rest, the first frame's leaving ignored.
	inspect(canvas, second.frame);
	inspect(canvas, first.frame, null);
	canvas.runDwell();
	canvas.runHide();
	assert.deepEqual([shown(canvas), title(), top()], [true, "p.or", "510px"]);

	// Leaving the page before the rest: no switch, and the panel goes after the grace.
	inspect(canvas, second.frame, h1);
	inspect(canvas, second.frame, null);
	canvas.runDwell();
	assert.equal(title(), "p.or");
	canvas.runHide();
	assert.equal(shown(canvas), false);

	// A pending switch on another frame than the panel's, then the pointer leaves that frame too: the panel goes.
	inspect(canvas, first.frame);
	inspect(canvas, first.frame, null);
	inspect(canvas, second.frame, h1);
	inspect(canvas, second.frame, null);
	canvas.run();
	assert.equal(shown(canvas), false, "the pointer is on no element");

	// A pending switch ends with the panel: Technical details off and on again before the rest.
	inspect(canvas, first.frame);
	inspect(canvas, first.frame, h1);
	toggleTechnical(canvas);
	toggleTechnical(canvas);
	canvas.run();
	assert.equal(shown(canvas), false);
});

// ---- the panel follows what changes under it

test("tokens that change while the panel shows re-describe it at once, with no new report", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	inspect(canvas, first.frame, { ...MEASURE, color: { r: 1, g: 2, b: 3, a: 1 } });
	assert.match(rowText(canvas, "Color"), /^#010203 ⚠ no token/);
	assert.equal($(canvas, "gd-inspector-fix").disabled, false);
	canvas.replies[TOKENS_URL] = { exists: true, tokens: [{ name: "--ink", value: "#010203", section: "Colors", group: "color" }, { name: "--paper", value: "#ffffff", section: "Colors", group: "color" }] };
	await canvas.serverEvent("change", { slug: null, file: "system.md" });
	assert.equal(shown(canvas), true);
	assert.equal(rowText(canvas, "Color"), "#010203 ✓ --ink");
	assert.equal($(canvas, "gd-inspector-fix").disabled, true, "nothing is off the new tokens");
	// A hidden panel stays hidden.
	toggleTechnical(canvas);
	toggleTechnical(canvas);
	canvas.replies[TOKENS_URL] = TOKEN_SET;
	await canvas.serverEvent("change", { slug: null, file: "system.md" });
	assert.equal(shown(canvas), false);
});

test("a re-center the canvas makes in focus mode (a layout.json change) hides the panel, which would be misplaced", async () => {
	const layoutUrl = "/t/api/designs/alpha/layout";
	const canvas = await inspecting({ replies: { [layoutUrl]: { layout: null } } });
	focusOn(canvas, 0);
	inspect(canvas, canvas.boards[0].frame);
	assert.equal(shown(canvas), true);
	canvas.replies[layoutUrl] = { layout: { arrangement: "column", positions: {} } };
	await canvas.serverEvent("change", { slug: "alpha", file: "layout.json" });
	assert.equal(shown(canvas), false);
});

test("a design/system.md the server could not read says why in the panel", async () => {
	const noTokens = "No design/system.md tokens found, so values and contrast are shown without a comparison.";
	const tooLarge = "design/system.md is over 256 KB, so its tokens were not read: values and contrast are shown without a comparison.";
	const unreadable = "design/system.md could not be read, so values and contrast are shown without a comparison.";
	for (const [problem, note] of [["too-large", tooLarge], ["unreadable", unreadable], ["other", noTokens], [3, noTokens]]) {
		const canvas = await inspecting({ tokens: { exists: true, tokens: [], problem } });
		inspect(canvas, canvas.boards[0].frame);
		assert.deepEqual([$(canvas, "gd-inspector-note").hidden, $(canvas, "gd-inspector-note").textContent], [false, note], String(problem));
	}
	// The panel open while system.md grows too large, then is fixed.
	const canvas = await inspecting();
	inspect(canvas, canvas.boards[0].frame);
	assert.equal($(canvas, "gd-inspector-note").hidden, true);
	canvas.replies[TOKENS_URL] = { exists: true, tokens: [], problem: "too-large" };
	await canvas.serverEvent("change", { slug: null, file: "system.md" });
	assert.deepEqual([$(canvas, "gd-inspector-note").hidden, $(canvas, "gd-inspector-note").textContent, rowText(canvas, "Color")], [false, tooLarge, "#76616b"]);
	canvas.replies[TOKENS_URL] = TOKEN_SET;
	await canvas.serverEvent("change", { slug: null, file: "system.md" });
	assert.equal($(canvas, "gd-inspector-note").hidden, true);
});

// ---- measuring only with Technical details on (T1)

test("gd:mode tells every frame, size frames included, whether Technical details is on, so a frame measures only then", async () => {
	const canvas = await loadTokens({ replies: WIDE_ALPHA });
	const lastMode = (frame: FakeElement) => JSON.stringify(frame.contentWindow!.posted.filter((message) => message.type === "gd:mode").at(-1) ?? null);
	const modes = (frames: FakeElement[]) => frames.map(lastMode);
	const all = () => [...canvas.frames(), ...sizeFrames(canvas)];
	const mode = (enabled: boolean, inspect: boolean) => JSON.stringify({ type: "gd:mode", enabled, inspect });
	commentMode(canvas);
	assert.deepEqual(modes(all()), [mode(true, false), mode(true, false)]);
	toggleTechnical(canvas);
	assert.deepEqual(modes(all()), [mode(true, true), mode(true, true)], "turning it on tells the frames at once");
	focusOn(canvas, 0);
	chooseSize(canvas, "all");
	for (const frame of sizeFrames(canvas)) frame.dispatch("load");
	assert.deepEqual(modes(sizeFrames(canvas)), [mode(true, true), mode(true, true), mode(true, true)], "a size frame that loads is told too");
	toggleTechnical(canvas);
	assert.deepEqual(modes(all()), all().map(() => mode(true, false)), "off: no frame measures");
});

test("the panel hides when its frame goes or its context ends: every exit path", async () => {
	const exits: Array<[string, (canvas: Canvas) => Promise<void> | void]> = [
		["Back to canvas", (canvas) => $(canvas, "gd-back").dispatch("click")],
		["Shift+Esc", (canvas) => { canvas.message(canvas.boards[0].frame.contentWindow, { type: "gd:exit-focus" }); }],
		["Move (leaving Comment mode)", (canvas) => $(canvas, "gd-tool-navigate").dispatch("click")],
		["Technical details off", (canvas) => toggleTechnical(canvas)],
		["another size", (canvas) => chooseSize(canvas, "phone")],
		["a design switch", (canvas) => canvas.serverEvent("show", { slug: "beta" })],
		["a design.json reload", (canvas) => canvas.serverEvent("change", { slug: "alpha", file: "design.json" })],
	];
	for (const [name, exit] of exits) {
		const canvas = await inspecting();
		focusOn(canvas, 0);
		inspect(canvas, canvas.boards[0].frame);
		assert.equal(shown(canvas), true, name);
		await exit(canvas);
		assert.equal(shown(canvas), false, name);
	}
	// In the overview, a pan or a zoom moves the frame away from the panel.
	const canvas = await inspecting();
	inspect(canvas, canvas.boards[0].frame);
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	assert.equal(shown(canvas), false, "a pan");
});

test("a design switch: the old design's frames are not trusted for the panel while the new design loads", async () => {
	const beta = deferred();
	const canvas = await inspecting({ replies: { "/t/api/designs/beta": beta.promise } });
	const [first] = canvas.boards;
	inspect(canvas, first.frame);
	assert.equal(shown(canvas), true);
	await canvas.serverEvent("show", { slug: "beta" });
	assert.equal(shown(canvas), false, "the switch hides it");
	inspect(canvas, first.frame);
	assert.equal(shown(canvas), false, "a late report from the old design's frame");
	beta.answer({ slug: "beta", title: "Beta", brief: "", artboards: [{ file: "01-only.html", title: "Only", tradeoff: "", width: 500, height: 400 }] });
	await settle();
	inspect(canvas, canvas.frames()[0]);
	assert.equal(shown(canvas), true, "the new design's frame");

	// The design list too.
	const other = await inspecting();
	inspect(other, other.boards[0].frame);
	$(other, "gd-design").value = "beta";
	$(other, "gd-design").dispatch("change");
	assert.equal(shown(other), false);
});

test("a design.json reload builds new frames: a report from a replaced frame is ignored", async () => {
	const canvas = await inspecting();
	const [old] = canvas.boards;
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	inspect(canvas, old.frame);
	assert.equal(shown(canvas), false, "the replaced frame");
	inspect(canvas, canvas.frames()[0]);
	assert.equal(shown(canvas), true, "its replacement");
});

test("an All sizes frame that goes without a size change (a PNG export) takes the panel with it", async () => {
	const track: Record<string, any> = { readyState: "live", getSettings: () => ({ displaySurface: "browser" }), addEventListener() {}, stop() {} };
	const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
	const canvas = await inspecting({ replies: WIDE_ALPHA, extraWindow: { navigator: { mediaDevices: { getDisplayMedia: async () => stream } } } });
	focusOn(canvas, 0);
	chooseSize(canvas, "all");
	const [phone] = sizeFrames(canvas);
	inspect(canvas, phone);
	assert.equal(shown(canvas), true);
	withClass(canvas.boards[0].wrapper, "gd-menu-button")[0].dispatch("click");
	findAll(menuEl(canvas), (element) => texts(element, "gd-menu-label")[0] === "Export as PNG" && element.getAttribute("role") === "menuitem")[0].dispatch("click");
	await settle();
	assert.equal(sizeFrames(canvas).length, 3, "All sizes is back after the export, with new frames");
	assert.equal(shown(canvas), false, "the panel of a removed frame is gone");
	inspect(canvas, phone);
	assert.equal(shown(canvas), false, "and the removed frame is not trusted");
	inspect(canvas, sizeFrames(canvas)[0]);
	assert.equal(shown(canvas), true);
});

test("the pointer moving onto the panel keeps the hovered element's outline in the artboard", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	canvas.viewport.dispatch("pointermove", { pointerId: 1, clientX: 150, clientY: 150, target: first.shield });
	inspect(canvas, first.frame);
	const hovers = () => first.frame.contentWindow!.posted.filter((message) => message.type === "gd:hover-at").length;
	const before = hovers();
	canvas.viewport.dispatch("pointermove", { pointerId: 1, clientX: 600, clientY: 200, target: panelOf(canvas) });
	assert.equal(hovers(), before, "no hover-at reached the artboard");
	assert.equal(shown(canvas), true);
});

// ---- Ask the agent to fix and Copy (S8)

test("Ask the agent to fix opens the comment box on that element, prefilled with the flagged values, and sends it as a comment", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 120, width: 400, height: 300 };
	inspect(canvas, first.frame, OFF);
	assert.equal($(canvas, "gd-inspector-fix").disabled, false);
	$(canvas, "gd-inspector-fix").dispatch("click");
	assert.equal($(canvas, "gd-popover").hidden, false);
	assert.equal(shown(canvas), false, "the comment box takes the panel's place");
	assert.equal($(canvas, "gd-popover-target").textContent, "01-a.html · main > p.or");
	const text = $(canvas, "gd-popover-text").value;
	const lines = text.split("\n");
	assert.equal(lines[0], "Fix the values on main > p.or that are off the design system (design/system.md):");
	assert.match(lines[1], /^- Text color #96828c is not a token; nearest is --text-muted \(#a78e9b\)\.$/);
	assert.match(lines[2], /^- Contrast 3\.\d\d:1 is below WCAG AA \(4\.5:1 for normal text\)\.$/);
	assert.equal(lines[3], "- Border radius 10px is not a token; nearest is --radius-sm (8px).");
	assert.equal(lines.length, 4, "values that match a token are not listed");
	assert.equal(canvas.document.activeElement?.id, "gd-popover-text");
	$(canvas, "gd-popover-text").value = `${text}\nAlso check the hover state.`;
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	const post = canvas.posts.at(-1)!;
	assert.equal(post.url, "/t/api/comments");
	const body = post.body as Record<string, unknown>;
	assert.deepEqual([body.slug, body.file, body.selector, body.excerpt, body.mode, "viewport" in body], ["alpha", "01-a.html", "main > p.or", "or pay with card", "send", false]);
	assert.match(String(body.comment), /Also check the hover state\.$/);
});

test("Ask the agent to fix from an All sizes frame records that size; a long list still fits the comment limit", async () => {
	const canvas = await inspecting({ replies: WIDE_ALPHA });
	focusOn(canvas, 0);
	chooseSize(canvas, "all");
	const [phone] = sizeFrames(canvas);
	inspect(canvas, phone, { ...OFF, selector: `main > ${"div > ".repeat(80)}p` });
	$(canvas, "gd-inspector-fix").dispatch("click");
	assert.ok($(canvas, "gd-popover-text").value.length <= 2000);
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	assert.deepEqual((canvas.posts.at(-1)!.body as Record<string, unknown>).viewport, { width: 390, height: 844 });
});

test("S1: a measurement made at Phone whose report arrives after the switch to Tablet shows nothing and files nothing; a report made at Tablet files Tablet's size", async () => {
	const canvas = await inspecting({ replies: WIDE_ALPHA });
	const [first] = canvas.boards;
	focusOn(canvas, 0);
	chooseSize(canvas, "phone");
	const phoneGeneration = heardGeneration(first.frame);
	chooseSize(canvas, "tablet");
	assert.notEqual(heardGeneration(first.frame), phoneGeneration, "the switch tells the page its new size generation");
	inspect(canvas, first.frame, { ...OFF, fontSize: 13 }, phoneGeneration);
	assert.equal(shown(canvas), false, "the Phone-era report opens no panel");
	assert.equal($(canvas, "gd-popover").hidden, true);
	const before = canvas.posts.length;
	inspect(canvas, first.frame, OFF);
	assert.equal(shown(canvas), true, "a report made at the current size still shows");
	$(canvas, "gd-inspector-fix").dispatch("click");
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	assert.equal(canvas.posts.length, before + 1);
	assert.equal(canvas.posts.at(-1)!.url, "/t/api/comments");
	const body = canvas.posts.at(-1)!.body as Record<string, unknown>;
	assert.deepEqual(body.viewport, { width: 820, height: 1180 });
	assert.doesNotMatch(String(body.comment), /13px/);
});

test("with nothing off the system Ask the agent to fix is disabled and says why; Copy still works", async () => {
	const canvas = await inspecting();
	const [first] = canvas.boards;
	inspect(canvas, first.frame, MATCHING);
	const fix = $(canvas, "gd-inspector-fix");
	assert.equal(fix.disabled, true);
	assert.equal(fix.title, "Nothing is off the design system, so there is nothing to fix.");
	assert.equal($(canvas, "gd-inspector-copy").disabled, false);
	fix.dispatch("click");
	assert.equal($(canvas, "gd-popover").hidden, true);
	inspect(canvas, first.frame, OFF);
	assert.equal(fix.disabled, false);
	assert.equal(fix.title, "");
});

test("S3: Copy copies the panel's text: the element, its selector and every row as shown, also with nothing off the system", async () => {
	const written: string[] = [];
	const canvas = await inspecting({ extraWindow: { navigator: { clipboard: { writeText: async (text: string) => { written.push(text); } } } } });
	inspect(canvas, canvas.boards[0].frame, MATCHING);
	const labels = rows(canvas).map((row) => texts(row, "gd-inspector-label")[0]);
	assert.deepEqual(labels, ["Color", "Background", "Contrast", "Font", "Size", "Line height", "Spacing", "Radius"]);
	$(canvas, "gd-inspector-copy").dispatch("click");
	await settle();
	assert.equal(written.length, 1);
	const lines = written[0].split("\n");
	assert.deepEqual(lines, ["p.or", "main > p.or", ...labels.map((label) => `${label}: ${rowText(canvas, label)}`)]);
	assert.match(lines[2], /^Color: #f6eff3 ✓ --text$/);
	assert.doesNotMatch(written[0], /Nothing is off the design system/);
});

test("Copy writes the panel's text to the clipboard, falls back to the copy command, and says when neither works", async () => {
	const written: string[] = [];
	const canvas = await inspecting({ extraWindow: { navigator: { clipboard: { writeText: async (text: string) => { written.push(text); } } } } });
	inspect(canvas, canvas.boards[0].frame, OFF);
	$(canvas, "gd-inspector-copy").dispatch("click");
	await settle();
	assert.equal(written.length, 1);
	assert.deepEqual(written[0].split("\n").slice(0, 3), ["p.or", "main > p.or", `Color: ${rowText(canvas, "Color")}`]);
	assert.match(written[0], /⚠ no token/, "the flagged values are in the rows it copies");
	assert.equal($(canvas, "gd-toast").textContent, "Copied");
	assert.equal($(canvas, "gd-toast").classes.has("gd-error"), false);
	$(canvas, "gd-inspector-fix").dispatch("click");
	assert.match($(canvas, "gd-popover-text").value, /^Fix the values on main > p\.or /, "Ask the agent to fix still prefills the instructions");

	const commands: Array<[string, string]> = [];
	const refused = await inspecting({ extraWindow: { navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } } } });
	(refused.document as any).execCommand = (command: string) => { commands.push([command, refused.document.activeElement?.value ?? ""]); return true; };
	inspect(refused, refused.boards[0].frame, OFF);
	refused.document.activeElement = $(refused, "gd-inspector-copy");
	$(refused, "gd-inspector-copy").dispatch("click");
	await settle();
	assert.equal(commands.length, 1);
	assert.equal(commands[0][0], "copy");
	assert.deepEqual(commands[0][1].split("\n").slice(0, 2), ["p.or", "main > p.or"], "the hidden text area holds the text");
	assert.equal($(refused, "gd-toast").textContent, "Copied");
	assert.equal(refused.document.body.children.filter((child) => child.localName === "textarea").length, 0, "the text area is removed");
	assert.equal(refused.document.activeElement?.id, "gd-inspector-copy", "focus goes back");

	const none = await inspecting();
	inspect(none, none.boards[0].frame, OFF);
	$(none, "gd-inspector-copy").dispatch("click");
	await settle();
	assert.equal($(none, "gd-toast").textContent, "Could not copy. Use Ask the agent to fix and copy the text from the comment box.");
	assert.equal($(none, "gd-toast").classes.has("gd-error"), true);
});

// ---- markup, styles, module rules and docs (S3, S4, S6)

test("index.html has the panel in the viewport, hidden, with a heading and real buttons, and the code icon", () => {
	const html = read("index.html");
	const main = html.slice(html.indexOf('<main id="gd-viewport"'), html.indexOf("</main>"));
	assert.match(main, /<section id="gd-inspector" class="gd-inspector" aria-labelledby="gd-inspector-title" hidden>/);
	assert.match(main, /<h2 id="gd-inspector-title" class="gd-inspector-title"><\/h2>/);
	assert.match(main, /<dl id="gd-inspector-list" class="gd-inspector-list"><\/dl>/);
	assert.match(main, /<button type="button" id="gd-inspector-fix"[^>]*>Ask the agent to fix<\/button>/);
	assert.match(main, /<button type="button" id="gd-inspector-copy"[^>]*>Copy<\/button>/);
	assert.match(html, /<symbol id="i-code" viewBox="0 0 24 24">/);
	// Its buttons are keyed for the language (ES.html); the rows come from canvas-tokens.js.
	assert.match(main, /id="gd-inspector-fix"[^>]*data-i18n="inspectorFix"/);
	assert.match(main, /id="gd-inspector-copy"[^>]*data-i18n="inspectorCopy"/);
});

test("canvas.css styles the panel in one section on --gd-* tokens, the warning in words, no dots", () => {
	const css = read("canvas.css");
	assert.equal(css.split("/* Token inspector").length - 1, 1, "one Token inspector section");
	const section = css.slice(css.indexOf("/* Token inspector"), css.indexOf("/*", css.indexOf("/* Token inspector") + 2));
	for (const selector of [".gd-inspector {", ".gd-inspector[hidden]", ".gd-inspector-row {", ".gd-inspector-swatch {", ".gd-inspector-ok {", ".gd-inspector-bad {"]) assert.ok(section.includes(selector), `${selector} is styled`);
	for (const name of section.match(/var\(--[\w-]+/g) ?? []) assert.ok(name.startsWith("var(--gd-"), `${name}: a --gd-* token`);
	assert.ok(!/::before|::after|border-radius: 50%/.test(section), "no dots");
	assert.match(section, /\.gd-inspector-bad \{[^}]*var\(--gd-focus\)/);
	assert.match(section, /\.gd-inspector-ok \{[^}]*var\(--gd-success\)/);
	assert.match(css, /\.gd-menu-item\[aria-checked="true"\] \.gd-menu-check \{ visibility: visible; \}/);
});

test("canvas-tokens.js keeps its English strings in one block, reaches the browser only through ctx and never calls an action from init", () => {
	const source = read("canvas-tokens.js");
	const init = source.indexOf("export function init");
	assert.ok(source.indexOf("const TEXT = Object.freeze({") >= 0 && source.indexOf("const TEXT = Object.freeze({") < init);
	assert.ok(!/(?<![.\w])(navigator|document|window|localStorage|setTimeout)\b/.test(source.slice(init).replace(/\/\/.*$|\/\*[^]*?\*\//gm, "")), "only ctx.win and ctx.doc");
	assert.ok(source.includes('"gentle-design:technical"'));
	assert.ok(!/state\.(tokens|technical)\s*=/.test(source), "store mutators only");
});

test("the docs describe the token inspector with the heuristics note, and Technical details in the Tool rail", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"), docs.indexOf("### Gentle Music"));
	const start = section.indexOf("- **Tokens**");
	assert.ok(start >= 0, "a Tokens entry");
	const entry = section.slice(start, section.indexOf("\n", start));
	assert.ok(entry.includes("These are heuristics: an element with a background image or gradient has no known background, and the match uses computed values, not the CSS that produced them."));
	for (const words of ["**Technical details**", "Comment mode", "⚠ no token", "OKLab", "WCAG", "**Ask the agent to fix**", "**Copy**", "`design/system.md`", "`gentle-design:technical`", "only after the pointer rests on it (250 ms)", "`Esc` in the panel closes it", "keyboard focus leaves the panel", "over 256 KB or could not be read", "measure the element under the pointer only while Technical details is on"]) assert.ok(entry.includes(words), `the Tokens entry mentions ${words}`);
	const rail = section.slice(section.indexOf("- **Tool rail**"), section.indexOf("\n", section.indexOf("- **Tool rail**")));
	assert.ok(rail.includes("**Technical details**"), "the Tool rail entry names Technical details");
});
