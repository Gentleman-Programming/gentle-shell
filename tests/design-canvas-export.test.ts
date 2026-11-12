import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DESIGN_CANVAS_ASSETS } from "../lib/design-canvas-assets.ts";
import { injectInspector } from "../lib/design-canvas-server.ts";
import { boardsOf, click, findAll, flush, handoffDoc, inspectorPick, loadCanvas, read, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// Export (canvas-export.js): a ⋯ button in each design artboard's header opens the shared
// menu (canvas-menu.js) with the export items only: Export as PNG (the browser's tab
// capture, cropped to the artboard), at 2×, Export as PDF (the print dialog) and Download
// HTML (the file without the injected inspector). Nothing is uploaded: PDF and HTML only
// read the artboard file from the canvas server. Every
// assertion compares strings, numbers or booleans, never fake elements, which node:assert
// would walk whole on a failure.

const SYSTEM_REPLY = { "/t/api/system": { exists: true, file: "system.html", width: 800, height: 600 } };
const EXPORT_ITEMS = ["Export as PNG", "Export as PNG at 2×", "Export as PDF", "Download HTML"];
const ARTBOARD_URL = "/t/files/alpha/01-a.html";

async function loadExport(replies: Record<string, unknown> = {}, extraWindow: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
	const canvas = await loadCanvas(300, replies, config, extraWindow);
	// The fake DOM starts every element visible; index.html starts these hidden.
	for (const id of ["gd-popover", "gd-menu", "gd-device-menu"]) canvas.document.getElementById(id).hidden = true;
	return canvas;
}
type Canvas = Awaited<ReturnType<typeof loadExport>>;

const $ = (canvas: Canvas, id: string) => canvas.document.getElementById(id);
const keyOn = (target: FakeElement, key: string) => target.dispatch("keydown", { key, shiftKey: false });
const isActive = (canvas: Canvas, element: FakeElement | undefined) => canvas.document.activeElement === element;
const menuEl = (canvas: Canvas) => $(canvas, "gd-menu");
const menuItems = (canvas: Canvas) => findAll(menuEl(canvas), (element) => element.getAttribute("role") === "menuitem");
const itemLabels = (canvas: Canvas) => menuItems(canvas).map((item) => texts(item, "gd-menu-label")[0]);
const itemNamed = (canvas: Canvas, label: string) => menuItems(canvas).find((item) => texts(item, "gd-menu-label")[0] === label)!;
const menuButtonOf = (wrapper: FakeElement) => withClass(wrapper, "gd-menu-button")[0];
/** Opens the ⋯ menu of the design artboard `index` and returns its button. */
const openMenu = (canvas: Canvas, index = 0) => {
	const button = menuButtonOf(canvas.boards[index].wrapper);
	button.dispatch("click");
	return button;
};
const choose = (canvas: Canvas, label: string, index = 0) => {
	openMenu(canvas, index);
	itemNamed(canvas, label).dispatch("click");
};
const settle = async (times = 8) => { for (let i = 0; i < times; i++) await flush(); };
const statusText = (canvas: Canvas) => $(canvas, "gd-status").textContent;
const statusIsError = (canvas: Canvas) => $(canvas, "gd-status").classes.has("gd-error");
const toastText = (canvas: Canvas) => $(canvas, "gd-toast").textContent;
/** A key press delivered to the document's keydown listeners, as the browser would from `target`. */
function press(canvas: Canvas, key: string, target: FakeElement) {
	const event: any = { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
	for (const listener of canvas.document.listeners.get("keydown") ?? []) listener(event);
	return event;
}

// ---- the ⋯ menu (S7: the export items only)

test("each design artboard has a ⋯ menu button named after it beside Implement this, collapsed; the system board has none", async () => {
	const canvas = await loadExport(SYSTEM_REPLY);
	const [system, first, second] = boardsOf(canvas);
	assert.equal(withClass(system, "gd-menu-button").length, 0, "the system board has no menu");
	for (const [wrapper, title] of [[first, "First"], [second, "Second"]] as const) {
		const buttons = withClass(wrapper, "gd-menu-button");
		assert.equal(buttons.length, 1);
		const button = buttons[0];
		assert.equal(button.localName, "button");
		assert.equal((button as unknown as { type?: string }).type, "button");
		assert.equal(button.getAttribute("aria-label"), `More actions for ${title}`);
		assert.equal(button.getAttribute("aria-haspopup"), "menu");
		assert.equal(button.getAttribute("aria-expanded"), "false");
		assert.equal(button.getAttribute("aria-controls"), "gd-menu");
		assert.equal(button.textContent, "", "an icon, not text");
		assert.equal(withClass(button, "gd-i")[0].children[0].getAttribute("href"), "#i-more");
		assert.ok(withClass(wrapper, "gd-board-actions")[0].contains(button), "in the header's actions, beside Implement this");
	}
	assert.equal(menuEl(canvas).hidden, true);
});

test("S7: the menu lists only the export items, marks the button expanded, focuses the first item and toggles from the button", async () => {
	const canvas = await loadExport();
	const button = openMenu(canvas, 1);
	assert.equal(menuEl(canvas).hidden, false);
	assert.equal(button.getAttribute("aria-expanded"), "true");
	assert.equal(menuEl(canvas).getAttribute("aria-label"), "Second actions");
	assert.deepEqual(itemLabels(canvas), EXPORT_ITEMS);
	assert.deepEqual(menuItems(canvas).map((item) => withClass(item, "gd-i")[0].children[0].getAttribute("href")), ["#i-image", "#i-image", "#i-file", "#i-download"]);
	assert.equal(withClass(menuEl(canvas), "gd-menu-separator").length, 0);
	assert.ok(menuItems(canvas).every((item) => item.localName === "button" && item.getAttribute("tabindex") === "-1"));
	assert.ok(isActive(canvas, menuItems(canvas)[0]));
	button.dispatch("click");
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(button.getAttribute("aria-expanded"), "false");
	assert.ok(isActive(canvas, button), "closing with the button keeps focus on it");
});

test("S7: an implemented artboard with a running app still gets only the export items: no Compare, Implement or another direction", async () => {
	const canvas = await loadExport({ "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:3000/" } }) });
	openMenu(canvas, 0);
	assert.deepEqual(itemLabels(canvas), EXPORT_ITEMS);
	assert.equal(withClass(canvas.boards[0].wrapper, "gd-compare-start").length, 1, "Compare stays where it was, in the handoff row");
});

test("the keyboard opens the menu with the arrows, and moves with arrows, Home and End", async () => {
	const canvas = await loadExport();
	const button = menuButtonOf(canvas.boards[0].wrapper);
	const down = keyOn(button, "ArrowDown");
	assert.equal(down.defaultPrevented, true);
	assert.equal(menuEl(canvas).hidden, false);
	assert.ok(isActive(canvas, menuItems(canvas)[0]));
	keyOn(button, "Escape");
	assert.equal(menuEl(canvas).hidden, true);
	keyOn(button, "ArrowUp");
	const items = menuItems(canvas);
	assert.ok(isActive(canvas, items[items.length - 1]), "ArrowUp opens on the last item");
	const at = () => items.findIndex((item) => item === canvas.document.activeElement);
	keyOn(items[at()], "ArrowDown");
	assert.equal(at(), 0, "ArrowDown wraps to the first");
	keyOn(items[at()], "ArrowUp");
	assert.equal(at(), items.length - 1, "ArrowUp wraps to the last");
	keyOn(items[at()], "Home");
	assert.equal(at(), 0);
	keyOn(items[at()], "End");
	assert.equal(at(), items.length - 1);
	assert.equal(menuEl(canvas).hidden, false, "moving never closes it");
});

test("Enter and Space on an item choose it; Escape returns focus to the button; Tab closes", async () => {
	let printed = 0;
	const canvas = await loadExport({}, { print: () => printed++ });
	const button = openMenu(canvas, 0);
	const escape = keyOn(menuItems(canvas)[1], "Escape");
	assert.equal(escape.defaultPrevented, true);
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(button.getAttribute("aria-expanded"), "false");
	assert.ok(isActive(canvas, button), "Esc returns focus to the button");

	for (const key of ["Enter", " "]) {
		openMenu(canvas, 0);
		const chosen = keyOn(itemNamed(canvas, "Export as PDF"), key);
		assert.equal(chosen.defaultPrevented, true, key);
		assert.equal(menuEl(canvas).hidden, true, key);
		assert.equal(withClass(canvas.document.body, "gd-print").length, 1, `${key} chose Export as PDF`);
	}

	openMenu(canvas, 0);
	const tab = keyOn(menuItems(canvas)[0], "Tab");
	assert.equal(tab.defaultPrevented, false, "Tab keeps its move");
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(button.getAttribute("aria-expanded"), "false");
	assert.equal(printed, 0);
});

test("a press outside, a pan or zoom, or opening another artboard's menu closes it; a press inside does not", async () => {
	const canvas = await loadExport();
	const first = openMenu(canvas, 0);
	const pointerdown = (target: FakeElement) => (canvas.document.listeners.get("pointerdown") ?? []).forEach((listener) => listener({ target, button: 0 }));
	pointerdown(menuItems(canvas)[0]);
	assert.equal(menuEl(canvas).hidden, false, "inside the menu");
	pointerdown(first);
	assert.equal(menuEl(canvas).hidden, false, "the button toggles on its own click, not on pointerdown");
	pointerdown(canvas.viewport);
	assert.equal(menuEl(canvas).hidden, true, "outside");
	assert.equal(first.getAttribute("aria-expanded"), "false");

	openMenu(canvas, 0);
	canvas.viewport.dispatch("keydown", { key: "+" });
	assert.equal(menuEl(canvas).hidden, true, "a zoom closes it: the button moved away from under the menu");
	openMenu(canvas, 0);
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	assert.equal(menuEl(canvas).hidden, true, "a pan closes it");

	const one = openMenu(canvas, 0);
	const two = openMenu(canvas, 1);
	assert.equal(one.getAttribute("aria-expanded"), "false");
	assert.equal(two.getAttribute("aria-expanded"), "true");
	assert.equal(menuEl(canvas).getAttribute("aria-label"), "Second actions");
});

test("the Settings menu and the device menu stay open through a pan: only an artboard's menu follows its button", async () => {
	const canvas = await loadExport();
	$(canvas, "gd-rail-settings").dispatch("click");
	assert.equal(menuEl(canvas).hidden, false);
	canvas.viewport.dispatch("keydown", { key: "+" });
	assert.equal(menuEl(canvas).hidden, false, "Settings sits on the rail, which never moves");
});

test("single-key shortcuts stay off while the menu is open", async () => {
	const canvas = await loadExport();
	openMenu(canvas, 0);
	const before = $(canvas, "gd-comment").getAttribute("aria-pressed");
	press(canvas, "c", menuItems(canvas)[0]);
	assert.equal($(canvas, "gd-comment").getAttribute("aria-pressed"), before, "C did nothing");
	keyOn(menuItems(canvas)[0], "Escape");
	press(canvas, "c", canvas.document.body);
	assert.equal($(canvas, "gd-comment").getAttribute("aria-pressed"), "true", "back to normal after it closes");
});

test("the menu is measured at a neutral position, so a stale position cannot push it off the right edge", async () => {
	const canvas = await loadExport();
	const menu = menuEl(canvas);
	// Like a fixed box without a width: it shrinks to the room right of its left edge, up to its content width.
	Object.defineProperty(menu, "offsetWidth", { get: () => Math.min(500, 1200 - (parseFloat(menu.style.left) || 0)) });
	menu.style.left = "1100px";
	const button = menuButtonOf(canvas.boards[0].wrapper);
	// A DOMRect also has right and bottom; placeMenu reads bottom.
	button.rect = { left: 1150, top: 40, width: 28, height: 28, right: 1178, bottom: 68 } as FakeElement["rect"];
	button.dispatch("click");
	assert.equal(parseFloat(menu.style.left), 1200 - 500 - 12);
	assert.equal(menu.style.top, "72px", "under the button");
});

test("a design reload closes an open artboard menu: its artboard is gone", async () => {
	const canvas = await loadExport();
	openMenu(canvas, 0);
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	assert.equal(menuEl(canvas).hidden, true);
});

// ---- Export as PNG

type PngLog = { calls: string[]; draw: number[][]; names: string[]; during: Array<{ exporting: boolean; transform: string; width: string; height: string; highlight: string; mode: string }>; output: { width: number; height: number } | null; statusAtCapture: string[]; timeouts: number[] };

/**
 * The canvas with a tab capture that hands back one 1200 x 800 frame (this window at 1×) and a canvas that records what it draws.
 * `stalled`: the video never paints a new frame (sharing stopped); `setTimeout` then runs at once and logs its delay.
 * `frozen`: the video never paints a new frame and no timer ever fires, so only the track's `ended` event can end the waits.
 * `permission`: the capture's answer waits for it, like the browser's selector; a rejection is a denial.
 * `ended`: the track has already ended when the capture is granted (an inactive stream).
 * `replies`: more server replies, such as the design's comments.
 * `track.end()` ends the shared track like the browser's Stop sharing: readyState "ended", then its `ended` event.
 * `held`: the video paints its new frames only once `releaseFrames()` is called.
 * `during[].highlight` is what the first artboard's inspector last heard about its highlight when the frame was grabbed,
 * `during[].mode` what it last heard about comment mode.
 */
async function pngCanvas(extra: { surface?: string; play?: () => Promise<void>; frame?: { width: number; height: number }; stalled?: boolean; frozen?: boolean; held?: boolean; permission?: Promise<void>; ended?: boolean; replies?: Record<string, unknown> } = {}) {
	const log: PngLog = { calls: [], draw: [], names: [], during: [], output: null, statusAtCapture: [], timeouts: [] };
	const endedListeners: Array<() => void> = [];
	let holding = extra.held === true;
	const heldFrames: Array<() => void> = [];
	const releaseFrames = () => { holding = false; heldFrames.splice(0).forEach((done) => done()); };
	const track = {
		readyState: extra.ended ? "ended" : "live",
		stop: () => log.calls.push("stop"),
		getSettings: () => (extra.surface ? { displaySurface: extra.surface } : {}),
		addEventListener: (type: string, listener: () => void) => { if (type === "ended") endedListeners.push(listener); },
		end() { track.readyState = "ended"; endedListeners.splice(0).forEach((listener) => listener()); },
	};
	const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
	let status: FakeElement | null = null;
	const canvas = await loadExport(extra.replies ?? {}, {
		confirm: () => { log.calls.push("confirm"); return true; },
		navigator: { mediaDevices: { getDisplayMedia: async (options: unknown) => {
			log.calls.push(`capture ${JSON.stringify(options)}`);
			log.statusAtCapture.push(status!.textContent);
			if (extra.permission) await extra.permission;
			return stream;
		} } },
		URL: { createObjectURL: () => { log.calls.push("url"); return "blob:test"; }, revokeObjectURL: () => log.calls.push("revoke") },
		...(extra.stalled ? { setTimeout: (callback: () => void, ms?: number) => { log.timeouts.push(ms ?? 0); const timer = setTimeout(callback, 0); timer.unref(); return timer; } } : {}),
		...(extra.frozen ? { setTimeout: (_callback: () => void, ms?: number) => { log.timeouts.push(ms ?? 0); return 0; } } : {}),
	});
	status = $(canvas, "gd-status");
	const frame = extra.frame ?? { width: 400, height: 300 };
	canvas.boards[0].frame.rect = { left: 100, top: 100, ...frame };
	const document = canvas.document as any;
	const create = document.createElement.bind(document);
	document.createElement = (tag: string) => {
		if (tag === "video") return { videoWidth: 1200, videoHeight: 800, play: extra.play ?? (async () => { log.calls.push("play"); }), requestVideoFrameCallback: (done: () => void) => {
			log.calls.push("frame");
			if (holding) heldFrames.push(done);
			else if (!extra.stalled && !extra.frozen) done();
		} };
		if (tag === "canvas") {
			const output: any = {
				width: 0,
				height: 0,
				getContext: () => ({ drawImage: (_video: unknown, ...args: number[]) => {
					log.draw.push(args);
					log.during.push({ exporting: canvas.document.body.classes.has("gd-exporting"), transform: canvas.world.style.transform, width: canvas.boards[0].frame.style.width, height: canvas.boards[0].frame.style.height, highlight: lastHighlight(canvas.boards[0].frame), mode: lastMode(canvas.boards[0].frame) });
					log.calls.push("draw");
				} }),
				toBlob: (done: (blob: object) => void) => { log.calls.push("encode"); done({}); },
			};
			log.output = output;
			return output;
		}
		if (tag === "a") return { click() { log.names.push(this.download); }, href: "", download: "" };
		return create(tag);
	};
	return { canvas, log, track, releaseFrames };
}

/** The last highlight message an artboard frame got: "gd:highlight <id>", "gd:clear" or "" for none. */
function lastHighlight(frame: FakeElement) {
	const last = frame.contentWindow!.posted.filter((message) => message.type === "gd:highlight" || message.type === "gd:clear").at(-1);
	return last ? `${last.type}${last.id ? ` ${last.id}` : ""}` : "";
}

/** What an artboard frame last heard about comment mode: "on", "off" or "" for nothing. */
function lastMode(frame: FakeElement) {
	const last = frame.contentWindow!.posted.filter((message) => message.type === "gd:mode").at(-1);
	return last ? (last.enabled ? "on" : "off") : "";
}

for (const [name, navigator] of [
	["missing", undefined],
	["denied", { mediaDevices: { getDisplayMedia: async () => { throw new Error("Permission denied."); } } }],
] as const) test(`a ${name} tab capture says so on the status line and the toast, and suggests the browser screenshot tool`, async () => {
	const canvas = await loadExport({}, { navigator });
	const before = canvas.world.style.transform;
	choose(canvas, "Export as PNG");
	await settle();
	const reason = name === "missing" ? "Tab capture is not available in this browser." : "Permission denied.";
	assert.equal(statusText(canvas), `Could not export the artboard. ${reason} Use your browser's screenshot tool instead.`);
	assert.equal(statusIsError(canvas), true);
	assert.equal(toastText(canvas), statusText(canvas));
	assert.equal($(canvas, "gd-toast").hidden, false);
	assert.equal(canvas.world.style.transform, before);
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.deepEqual(canvas.posts, []);
});

const CHOOSE_TAB = "Choose this canvas tab in the browser's capture selector. Choosing another tab or screen may export the wrong content.";

for (const scale of [1, 2]) test(`export ${scale}× warns about the tab on the status line, crops this tab's frame to the artboard at 100% and stops the capture`, async () => {
	const { canvas, log } = await pngCanvas();
	const before = canvas.world.style.transform;
	choose(canvas, scale === 1 ? "Export as PNG" : "Export as PNG at 2×");
	await settle();
	assert.equal(log.calls[0], 'capture {"video":{"displaySurface":"browser"},"audio":false,"preferCurrentTab":true}');
	assert.deepEqual(log.statusAtCapture, [CHOOSE_TAB], "the status line names the tab to choose while the selector is open");
	assert.deepEqual(log.draw, [[100, 100, 400, 300, 0, 0, 400 * scale, 300 * scale]]);
	assert.deepEqual(log.names, [`01-a${scale === 2 ? "@2x" : ""}.png`]);
	assert.equal(log.output?.width, 400 * scale);
	assert.equal(log.output?.height, 300 * scale);
	assert.equal(log.calls.filter((call) => call === "stop").length, 1);
	assert.ok(log.calls.indexOf("stop") < log.calls.indexOf("encode"), "the capture stops right after the frame is grabbed");
	assert.ok(log.calls.indexOf("frame") > log.calls.indexOf("play") && log.calls.indexOf("frame") < log.calls.indexOf("draw"), "the frame drawn is a new one, painted after the layout");
	assert.ok(log.calls.indexOf("revoke") > log.calls.indexOf("url"), "the download link is released");
	assert.equal(log.during.length, 1);
	assert.equal(log.during[0].exporting, true, "the canvas chrome is hidden while the frame is grabbed");
	assert.match(log.during[0].transform, /scale\(1\)$/, "the artboard is at 100%");
	assert.deepEqual([log.during[0].width, log.during[0].height], ["400px", "300px"], "at its own size, not Desktop's window width (canvas-layout S8)");
	assert.equal(canvas.document.body.classes.has("gd-exporting"), false, "the chrome comes back");
	assert.equal(canvas.world.style.transform, before, "the view comes back");
	assert.equal(canvas.navMode.textContent, "Navigating", "and so does navigation mode");
	assert.equal(canvas.boards[0].frame.style.width, "400px");
	assert.equal(toastText(canvas), scale === 2 ? "Exported PNG at 2× (upscaled)." : "Exported PNG.", "1× pixels upscaled to 2× say so");
	assert.equal(statusText(canvas), toastText(canvas), "the tab warning gives way to the result");
	assert.equal(statusIsError(canvas), false);
	assert.deepEqual(canvas.posts, []);
});

test("D1: Export as PNG asks for the capture at once, from the menu click: no confirm dialog spends the click's activation", async () => {
	const { canvas, log } = await pngCanvas();
	choose(canvas, "Export as PNG");
	assert.deepEqual(log.calls.slice(0, 1), ['capture {"video":{"displaySurface":"browser"},"audio":false,"preferCurrentTab":true}'], "the capture starts within the click itself");
	await settle();
	assert.equal(log.calls.includes("confirm"), false, "no blocking dialog before the capture");
	assert.deepEqual(log.statusAtCapture, [CHOOSE_TAB]);
});

test("D4: a capture that stops painting frames gives up waiting after 500 ms and still exports and restores the canvas", async () => {
	const { canvas, log } = await pngCanvas({ stalled: true });
	const before = canvas.world.style.transform;
	choose(canvas, "Export as PNG");
	await settle(16);
	assert.equal(log.calls.filter((call) => call === "frame").length, 2, "both frame waits were asked for");
	assert.equal(log.timeouts.filter((ms) => ms === 500).length, 2, "each bounded by 500 ms");
	assert.deepEqual(log.draw, [[100, 100, 400, 300, 0, 0, 400, 300]]);
	assert.deepEqual(log.names, ["01-a.png"]);
	assert.equal(canvas.document.body.classes.has("gd-exporting"), false, "the chrome comes back");
	assert.equal(canvas.world.style.transform, before);
	assert.equal(canvas.navMode.textContent, "Navigating");
});

// #3153 review, case 2: sharing that ends without a frame must end the export and give the canvas back.

const STOPPED = "Could not export the artboard. Sharing stopped before the artboard was captured. Use your browser's screenshot tool instead.";

test("#3153 case 2: no frame callback, then the track's ended event: the export ends at once with a reason and restores the canvas", async () => {
	const { canvas, log, track } = await pngCanvas({ frozen: true });
	const before = canvas.world.style.transform;
	choose(canvas, "Export as PNG");
	await settle();
	assert.equal(log.calls.filter((call) => call === "frame").length, 1, "waiting for the first new frame");
	assert.equal(canvas.document.body.classes.has("gd-exporting"), true, "still waiting, no timer fired");
	track.end();
	await settle();
	assert.deepEqual(log.draw, [], "nothing grabbed");
	assert.deepEqual(log.names, [], "nothing downloaded");
	assert.equal(log.calls.filter((call) => call === "stop").length, 1, "the capture is stopped once");
	assert.equal(canvas.document.body.classes.has("gd-exporting"), false, "the chrome comes back");
	assert.equal(canvas.world.style.transform, before, "the view comes back");
	assert.equal(canvas.navMode.textContent, "Navigating", "the artboard it opened is closed again");
	assert.equal(statusText(canvas), STOPPED);
	assert.equal(statusIsError(canvas), true);
	assert.equal(toastText(canvas), STOPPED);
});

test("#3153 case 2: a capture whose track has already ended when it is granted (an inactive stream) exports nothing and never opens the artboard", async () => {
	const { canvas, log } = await pngCanvas({ frozen: true, ended: true });
	const before = canvas.world.style.transform;
	choose(canvas, "Export as PNG");
	await settle();
	assert.equal(log.calls.includes("frame"), false, "no frame is waited for");
	assert.deepEqual(log.draw, []);
	assert.equal(log.calls.filter((call) => call === "stop").length, 1);
	assert.equal(canvas.document.body.classes.has("gd-exporting"), false);
	assert.equal(canvas.world.style.transform, before);
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.equal(statusText(canvas), STOPPED);
});

// #3153 review, case 1: a design.json reload while the capture's permission is pending replaces every board object.

/** Focuses the first artboard, starts a PNG export whose permission waits, then reloads design.json; returns how to answer. */
async function exportAcrossReload(focused: boolean, replies: Record<string, unknown> = {}) {
	let grant!: () => void;
	let deny!: (error: Error) => void;
	const permission = new Promise<void>((resolve, reject) => { grant = resolve; deny = reject; });
	permission.catch(() => {});
	const { canvas, log } = await pngCanvas({ permission });
	if (focused) click(canvas.boards[0].shield!, 200, 200);
	const view = canvas.world.style.transform;
	choose(canvas, "Export as PNG");
	await settle();
	assert.equal(log.calls.filter((call) => call.startsWith("capture ")).length, 1, "the browser's selector is open");
	Object.assign(canvas.replies, replies);
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	// A replaced board leaves the page: like a browser, its frame no longer has a box.
	canvas.boards[0].frame.rect = { left: 0, top: 0, width: 0, height: 0 };
	const current = boardsOf(canvas);
	assert.ok(current.every((wrapper) => !canvas.boards.some((old) => old.wrapper === wrapper)), "the reload built new board objects");
	return { canvas, log, view, current, grant, deny };
}

const frameOf = (wrapper: FakeElement) => findAll(wrapper, (element) => element.localName === "iframe")[0];

test("#3153 case 1: focus, export with the permission pending, reload design.json, deny: the reloaded artboard is focused again, not the replaced one", async () => {
	const { canvas, view, current, deny } = await exportAcrossReload(true);
	assert.match(canvas.navMode.textContent, /^Using: First/, "the reload kept focus mode on the same file");
	deny(new Error("Permission denied."));
	await settle();
	assert.equal(statusText(canvas), "Could not export the artboard. Permission denied. Use your browser's screenshot tool instead.");
	assert.deepEqual(current.map((wrapper) => wrapper.classes.has("gd-focus-board")), [true, false], "the current First is the open artboard");
	assert.deepEqual(current.map((wrapper) => wrapper.inert), [false, true], "only the other artboard is inert");
	assert.match(canvas.navMode.textContent, /^Using: First/);
	assert.equal(canvas.world.style.transform, view, "the focus view comes back");
	assert.ok(isActive(canvas, menuButtonOf(current[0])), "keyboard focus on the current First's ⋯ button");
});

test("#3153 case 1: a capture granted after a design.json reload exports the reloaded artboard and gives it back focused", async () => {
	const { canvas, log, view, current, grant } = await exportAcrossReload(true);
	frameOf(current[0]).rect = { left: 100, top: 100, width: 400, height: 300 };
	grant();
	await settle();
	assert.deepEqual(log.draw, [[100, 100, 400, 300, 0, 0, 400, 300]], "cropped from the current frame");
	assert.deepEqual(log.names, ["01-a.png"]);
	assert.equal(statusText(canvas), "Exported PNG.");
	assert.deepEqual(current.map((wrapper) => wrapper.classes.has("gd-focus-board")), [true, false]);
	assert.deepEqual(current.map((wrapper) => wrapper.inert), [false, true]);
	assert.equal(canvas.world.style.transform, view);
	assert.ok(isActive(canvas, menuButtonOf(current[0])));
});

test("#3153 case 1: when the reload removed the artboard, the export says so, grabs nothing and leaves the canvas navigating", async () => {
	const manifest = { slug: "alpha", title: "Alpha", brief: "", artboards: [{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 }] };
	const { canvas, log, view, current, grant } = await exportAcrossReload(false, { "/t/api/designs/alpha": manifest });
	assert.equal(current.length, 1);
	grant();
	await settle();
	assert.deepEqual(log.draw, []);
	assert.equal(log.calls.filter((call) => call === "stop").length, 1);
	assert.equal(statusText(canvas), "Could not export the artboard. The artboard is no longer in the design. Use your browser's screenshot tool instead.");
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.deepEqual(current.map((wrapper) => wrapper.inert), [false]);
	assert.equal(canvas.document.body.classes.has("gd-exporting"), false);
	assert.equal(canvas.world.style.transform, view);
});

test("#3153 case 1: when a reload removed the open artboard, the export leaves focus mode cleanly instead of reopening it", async () => {
	const manifest = { slug: "alpha", title: "Alpha", brief: "", artboards: [{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 }] };
	const { canvas, current, deny } = await exportAcrossReload(true, { "/t/api/designs/alpha": manifest });
	assert.equal(canvas.navMode.textContent, "Navigating", "the reload already left focus mode");
	const overview = canvas.world.style.transform;
	deny(new Error("Permission denied."));
	await settle();
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.deepEqual(current.map((wrapper) => wrapper.inert), [false]);
	assert.equal(canvas.world.style.transform, overview, "the overview stays, not the old focus view");
});

test("D5: after a PNG export, focus is back on the artboard's ⋯ button", async () => {
	const { canvas, log } = await pngCanvas();
	const button = openMenu(canvas, 0);
	itemNamed(canvas, "Export as PNG").dispatch("click");
	await settle();
	assert.equal(log.draw.length, 1, "it exported");
	assert.ok(isActive(canvas, button), "not left on the viewport or the closed artboard");
});

test("an export from an open artboard at Phone size grabs it at its own size and gives it back at Phone, still open", async () => {
	const { canvas, log } = await pngCanvas();
	click(canvas.boards[0].shield!, 200, 200);
	$(canvas, "gd-device").dispatch("click");
	findAll($(canvas, "gd-device-menu"), (element) => element.dataset.size === "phone")[0].dispatch("click");
	assert.equal(canvas.boards[0].frame.style.width, "390px");
	const before = canvas.world.style.transform;
	choose(canvas, "Export as PNG");
	await settle();
	assert.deepEqual([log.during[0].width, log.during[0].height], ["400px", "300px"], "Desktop's own size, not Phone's");
	assert.match(canvas.navMode.textContent, /^Using: First/, "the artboard stays open");
	assert.equal(canvas.boards[0].frame.style.width, "390px", "at Phone again");
	assert.equal($(canvas, "gd-device-name").textContent, "Phone");
	assert.equal(canvas.world.style.transform, before);
});

test("an export from All sizes grabs the artboard's own frame without the size frames and gives All sizes back", async () => {
	const { canvas, log } = await pngCanvas();
	click(canvas.boards[0].shield!, 200, 200);
	$(canvas, "gd-device").dispatch("click");
	findAll($(canvas, "gd-device-menu"), (element) => element.dataset.size === "all")[0].dispatch("click");
	const sizeFrames = () => withClass(canvas.viewport, "gd-size-frame").length;
	assert.equal(sizeFrames(), 3);
	const during: number[] = [];
	const document = canvas.document as any;
	const create = document.createElement;
	document.createElement = (tag: string) => {
		if (tag === "video") during.push(sizeFrames());
		return create(tag);
	};
	choose(canvas, "Export as PNG");
	await settle();
	assert.deepEqual(during, [0], "Desktop while the frame is grabbed: no size frames");
	assert.deepEqual([log.during[0].width, log.during[0].height], ["400px", "300px"]);
	assert.match(canvas.navMode.textContent, /^Using: First/, "the artboard stays open");
	assert.equal($(canvas, "gd-device-name").textContent, "All sizes");
	assert.equal(sizeFrames(), 3, "All sizes again");
	assert.ok(canvas.boards[0].wrapper.classes.has("gd-all-sizes"));
});

test("E1: an export while the comment box is open on an All sizes frame closes it first: that frame clears its outline before it is removed", async () => {
	const { canvas } = await pngCanvas();
	click(canvas.boards[0].shield!, 200, 200);
	$(canvas, "gd-device").dispatch("click");
	findAll($(canvas, "gd-device-menu"), (element) => element.dataset.size === "all")[0].dispatch("click");
	$(canvas, "gd-comment").dispatch("click");
	const phoneSection = withClass(canvas.viewport, "gd-size-frame")[0];
	const phone = findAll(phoneSection, (element) => element.localName === "iframe")[0];
	canvas.message(phone.contentWindow, inspectorPick(phone, { type: "gd:pick", selector: "#cta", excerpt: "Buy", rect: { x: 1, y: 1, width: 10, height: 10 } }));
	const popover = $(canvas, "gd-popover");
	assert.equal(popover.hidden, false, "the comment box is open on the Phone frame");
	// Whether the Phone frame was still in the viewport when it was told to clear its outline.
	const shown = (element: FakeElement) => {
		for (let at: FakeElement | null = element; at; at = at.parentElement) if (at === canvas.viewport) return true;
		return false;
	};
	const clears: boolean[] = [];
	const post = phone.contentWindow!.postMessage;
	phone.contentWindow!.postMessage = (message: any) => {
		if (message.type === "gd:clear") clears.push(shown(phoneSection));
		post(message);
	};
	choose(canvas, "Export as PNG");
	await settle();
	assert.equal(popover.hidden, true, "no comment box is left on a frame that is gone");
	assert.deepEqual(clears, [true], "the Phone frame cleared its outline while it was still shown");
	assert.equal($(canvas, "gd-device-name").textContent, "All sizes", "All sizes comes back");
	assert.equal(shown(phoneSection), false, "with new size frames");
	$(canvas, "gd-popover-cancel").dispatch("click");
	assert.deepEqual(clears, [true], "a later Cancel sends nothing to the removed frame");
});

test("an artboard bigger than the window names the window size it needs and grabs nothing", async () => {
	const { canvas, log } = await pngCanvas({ frame: { width: 1440, height: 900 } });
	const before = canvas.world.style.transform;
	choose(canvas, "Export as PNG");
	await settle();
	assert.deepEqual(log.draw, []);
	assert.equal(log.calls.filter((call) => call === "stop").length, 1);
	assert.equal(statusText(canvas), "Could not export the artboard. The artboard needs a browser window of at least 1440 × 900 px. Make the window bigger or use full screen (F11), then try again. Use your browser's screenshot tool instead.");
	assert.equal(canvas.document.body.classes.has("gd-exporting"), false);
	assert.equal(canvas.world.style.transform, before);
	assert.deepEqual(canvas.posts, []);
});

for (const [surface, reason] of [["window", "You shared a window, not this tab, so the artboard cannot be cropped from it."], ["monitor", "You shared a screen, not this tab, so the artboard cannot be cropped from it."]]) {
	test(`sharing a ${surface} instead of the tab exports nothing and explains it`, async () => {
		const { canvas, log } = await pngCanvas({ surface });
		const before = canvas.world.style.transform;
		choose(canvas, "Export as PNG");
		await settle();
		assert.deepEqual(log.draw, []);
		assert.equal(log.calls.filter((call) => call === "stop").length, 1);
		assert.equal(statusText(canvas), `Could not export the artboard. ${reason} Use your browser's screenshot tool instead.`);
		assert.equal(canvas.navMode.textContent, "Navigating", "the artboard never opened");
		assert.equal(canvas.world.style.transform, before);
		assert.deepEqual(canvas.posts, []);
	});
}

// CodeRabbit 4541511182: the inspector draws a selected comment's outline inside the artboard, where .gd-exporting cannot hide it.
const COMMENTS = (file: string) => ({ "/t/api/designs/alpha/comments": { comments: [{ id: "abc123", file, selector: "h1", excerpt: "First", comment: "Update", status: "open", sentAt: null }] } });
const showComment = (canvas: Canvas) => withClass($(canvas, "gd-comment-list"), "gd-comment-show")[0].dispatch("click");

test("M-D1: a selected comment's highlight inside the artboard is cleared for the grabbed frame and shown again afterwards", async () => {
	const { canvas, log } = await pngCanvas({ replies: COMMENTS("01-a.html") });
	showComment(canvas);
	assert.equal(lastHighlight(canvas.boards[0].frame), "gd:highlight abc123");
	choose(canvas, "Export as PNG");
	await settle();
	assert.equal(log.draw.length, 1, "it exported");
	assert.equal(log.during[0].highlight, "gd:clear", "no comment outline in the PNG");
	assert.equal(lastHighlight(canvas.boards[0].frame), "gd:highlight abc123", "the outline comes back");
});

test("M-D1: a failed export also gives the selected comment's highlight back", async () => {
	const { canvas, log } = await pngCanvas({ replies: COMMENTS("01-a.html"), frame: { width: 1440, height: 900 } });
	showComment(canvas);
	choose(canvas, "Export as PNG");
	await settle();
	assert.deepEqual(log.draw, []);
	assert.ok(canvas.boards[0].frame.contentWindow!.posted.some((message) => message.type === "gd:clear"), "cleared for the capture");
	assert.equal(lastHighlight(canvas.boards[0].frame), "gd:highlight abc123");
});

test("M-D1: with no selected comment on the artboard, the export clears it and sends no highlight back", async () => {
	const { canvas, log } = await pngCanvas({ replies: COMMENTS("02-b.html") });
	showComment(canvas);
	assert.equal(lastHighlight(canvas.boards[1].frame), "gd:highlight abc123");
	choose(canvas, "Export as PNG");
	await settle();
	assert.equal(log.during[0].highlight, "gd:clear");
	assert.equal(lastHighlight(canvas.boards[0].frame), "gd:clear", "the other artboard's comment is not highlighted in this one");
	assert.equal(lastHighlight(canvas.boards[1].frame), "gd:highlight abc123", "nor cleared in its own");
});

// CodeRabbit round 2 (#3153): a second export, a resize, the hover outline and a reload during the frame waits.

test("S3a: a second PNG export while one is waiting for the capture is ignored; the next one after it runs", async () => {
	let grant!: () => void;
	const permission = new Promise<void>((resolve) => { grant = resolve; });
	const { canvas, log } = await pngCanvas({ permission });
	choose(canvas, "Export as PNG");
	choose(canvas, "Export as PNG at 2×");
	await settle();
	assert.equal(log.calls.filter((call) => call.startsWith("capture ")).length, 1, "one capture request, not two");
	grant();
	await settle();
	assert.deepEqual(log.draw, [[100, 100, 400, 300, 0, 0, 400, 300]], "only the first export grabbed a frame");
	assert.deepEqual(log.names, ["01-a.png"]);
	assert.equal(statusText(canvas), "Exported PNG.");
	choose(canvas, "Export as PNG");
	await settle();
	assert.equal(log.calls.filter((call) => call.startsWith("capture ")).length, 2, "a finished export lets the next one start");
	assert.deepEqual(log.names, ["01-a.png", "01-a.png"]);
});

test("S3b: a fitted overview resized while the capture is pending stays fitted to the new size after the export", async () => {
	let deny!: (error: Error) => void;
	const permission = new Promise<void>((_resolve, reject) => { deny = reject; });
	permission.catch(() => {});
	const { canvas } = await pngCanvas({ permission });
	Object.defineProperty(canvas.world, "offsetWidth", { get: () => 9000 });
	Object.defineProperty(canvas.world, "offsetHeight", { get: () => 1000 });
	canvas.viewport.rect = { left: 0, top: 50, width: 400, height: 300 };
	$(canvas, "gd-fit").dispatch("click");
	assert.equal(canvas.zoomLevel.textContent, "5%");
	choose(canvas, "Export as PNG");
	await settle();
	canvas.viewport.rect = { left: 0, top: 50, width: 1800, height: 900 };
	canvas.windowEvent("resize");
	assert.equal(canvas.zoomLevel.textContent, "19%", "the overview refit while the selector was open");
	deny(new Error("Permission denied."));
	await settle();
	assert.equal(canvas.zoomLevel.textContent, "19%", "not the view from before the resize");
	const after = canvas.world.style.transform;
	$(canvas, "gd-fit").dispatch("click");
	assert.equal(after, canvas.world.style.transform, "the view Fit gives at the new size");
});

test("S3b: an open artboard resized while the capture is pending is centered for the new size after the export", async () => {
	let deny!: (error: Error) => void;
	const permission = new Promise<void>((_resolve, reject) => { deny = reject; });
	permission.catch(() => {});
	const { canvas } = await pngCanvas({ permission });
	click(canvas.boards[0].shield!, 200, 200);
	const small = canvas.world.style.transform;
	choose(canvas, "Export as PNG");
	await settle();
	canvas.viewport.rect = { left: 0, top: 50, width: 1800, height: 900 };
	canvas.windowEvent("resize");
	const centered = canvas.world.style.transform;
	assert.notEqual(centered, small, "the resize centered the artboard again");
	deny(new Error("Permission denied."));
	await settle();
	assert.match(canvas.navMode.textContent, /^Using: First/);
	assert.equal(canvas.world.style.transform, centered, "not the focus view from before the resize");
});

test("S3c: comment mode is off in the artboard while its frame is grabbed, so no hover outline is in the PNG; it comes back after", async () => {
	const { canvas, log } = await pngCanvas();
	$(canvas, "gd-comment").dispatch("click");
	assert.equal(lastMode(canvas.boards[0].frame), "on");
	choose(canvas, "Export as PNG");
	await settle();
	assert.equal(log.draw.length, 1, "it exported");
	assert.equal(log.during[0].mode, "off", "the inspector draws no hover outline in the grabbed frame");
	assert.equal(lastMode(canvas.boards[0].frame), "on", "comment mode is back in the artboard");
	assert.equal(lastMode(canvas.boards[1].frame), "on", "the other artboard was never touched");
});

test("S3c: a failed export also gives comment mode back to the artboard", async () => {
	const { canvas, log } = await pngCanvas({ frame: { width: 1440, height: 900 } });
	$(canvas, "gd-comment").dispatch("click");
	choose(canvas, "Export as PNG");
	await settle();
	assert.deepEqual(log.draw, []);
	assert.ok(canvas.boards[0].frame.contentWindow!.posted.some((message) => message.type === "gd:mode" && message.enabled === false), "off for the capture");
	assert.equal(lastMode(canvas.boards[0].frame), "on");
});

const CHANGED = "Could not export the artboard. The artboard was reloaded or closed during the capture. Use your browser's screenshot tool instead.";

for (const [name, interrupt] of [
	["a design.json reload replaces the board", (canvas: Canvas) => canvas.serverEvent("change", { slug: "alpha", file: "design.json" })],
	["Back closes the artboard", async (canvas: Canvas) => { $(canvas, "gd-back").dispatch("click"); }],
	// S11(a): the artboard's file changed, so its frame reloads in place: same board object, new src.
	["the artboard's file changes and its frame reloads in place", (canvas: Canvas) => canvas.serverEvent("change", { slug: "alpha", file: "01-a.html" })],
] as const) {
	test(`S3d: when ${name} while the capture's frames are awaited, nothing is drawn or downloaded and the export fails`, async () => {
		const { canvas, log, releaseFrames } = await pngCanvas({ held: true });
		const before = canvas.world.style.transform;
		choose(canvas, "Export as PNG");
		await settle();
		assert.equal(log.calls.filter((call) => call === "frame").length, 1, "waiting for a new frame");
		await interrupt(canvas);
		releaseFrames();
		await settle();
		assert.deepEqual(log.draw, [], "the old rectangle is never cropped from the frame");
		assert.deepEqual(log.names, [], "nothing downloaded");
		assert.equal(log.calls.filter((call) => call === "stop").length, 1, "the capture is stopped once");
		assert.equal(statusText(canvas), CHANGED);
		assert.equal(statusIsError(canvas), true);
		assert.equal(toastText(canvas), CHANGED);
		assert.equal(canvas.document.body.classes.has("gd-exporting"), false, "the chrome comes back");
		assert.equal(canvas.navMode.textContent, "Navigating");
		assert.equal(canvas.world.style.transform, before, "the view comes back");
	});
}

// S11(b): an artboard open before the export and left during the capture stays closed afterwards.
for (const [name, leave] of [
	["Back", (canvas: Canvas) => { $(canvas, "gd-back").dispatch("click"); }],
	["Shift+Esc", (canvas: Canvas) => {
		const chord: any = { key: "Escape", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, target: $(canvas, "gd-back"), defaultPrevented: false, preventDefault() { chord.defaultPrevented = true; } };
		for (const listener of canvas.document.listeners.get("keydown") ?? []) listener(chord);
	}],
] as const) {
	test(`S11b: an open artboard left with ${name} while the capture's frames are awaited is not reopened after the failed export`, async () => {
		const { canvas, log, releaseFrames } = await pngCanvas({ held: true });
		click(canvas.boards[0].shield!, 200, 200);
		assert.match(canvas.navMode.textContent, /^Using: First/);
		choose(canvas, "Export as PNG");
		await settle();
		assert.equal(log.calls.filter((call) => call === "frame").length, 1, "waiting for a new frame");
		leave(canvas);
		assert.equal(canvas.navMode.textContent, "Navigating", "the artboard was left");
		const left = canvas.world.style.transform;
		releaseFrames();
		await settle();
		assert.deepEqual(log.draw, []);
		assert.deepEqual(log.names, []);
		assert.equal(statusText(canvas), CHANGED);
		assert.equal(canvas.navMode.textContent, "Navigating", "not reopened");
		assert.deepEqual(boardsOf(canvas).map((wrapper) => wrapper.classes.has("gd-focus-board")), [false, false], "no artboard is open");
		assert.deepEqual(boardsOf(canvas).map((wrapper) => wrapper.inert), [false, false]);
		assert.equal(canvas.world.style.transform, left, "the overview leaving gave, not the focus view from before");
		assert.equal(canvas.document.body.classes.has("gd-exporting"), false);
	});
}

// S21 E1: a design.json reload builds new board objects, so the artboard left during the capture must stay closed
// whether the reload comes before or after Back.
for (const [name, interrupt] of [
	["Back, then a design.json reload", async (canvas: Canvas) => {
		$(canvas, "gd-back").dispatch("click");
		await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	}],
	["a design.json reload, then Back", async (canvas: Canvas) => {
		await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
		assert.match(canvas.navMode.textContent, /^Using: First/, "the reload kept focus mode on the same file");
		$(canvas, "gd-back").dispatch("click");
	}],
] as const) {
	test(`S21 E1: an open artboard left during the capture stays closed after ${name}`, async () => {
		const { canvas, log, releaseFrames } = await pngCanvas({ held: true });
		click(canvas.boards[0].shield!, 200, 200);
		assert.match(canvas.navMode.textContent, /^Using: First/);
		choose(canvas, "Export as PNG");
		await settle();
		assert.equal(log.calls.filter((call) => call === "frame").length, 1, "waiting for a new frame");
		await interrupt(canvas);
		assert.equal(canvas.navMode.textContent, "Navigating", "the artboard was left");
		releaseFrames();
		await settle();
		assert.deepEqual(log.draw, [], "nothing drawn");
		assert.deepEqual(log.names, [], "nothing downloaded");
		assert.equal(statusText(canvas), CHANGED);
		assert.equal(canvas.navMode.textContent, "Navigating", "not reopened");
		assert.deepEqual(boardsOf(canvas).map((wrapper) => wrapper.classes.has("gd-focus-board")), [false, false], "no artboard is open");
		assert.deepEqual(boardsOf(canvas).map((wrapper) => wrapper.inert), [false, false]);
		assert.equal(canvas.document.body.classes.has("gd-exporting"), false);
	});
}

// S21 E2: a design switch during an export keeps the new design's view; the old design's view is not restored over it.
test("S21 E2: a show event for another design while the capture is pending leaves that design's fit, not the old design's view", async () => {
	// The fake world has no box, which Fit needs; alpha is zoomed in, so its view is not the fit any design gets.
	const zoomed = (canvas: Canvas) => {
		Object.defineProperty(canvas.world, "offsetWidth", { get: () => 2000 });
		Object.defineProperty(canvas.world, "offsetHeight", { get: () => 1000 });
		$(canvas, "gd-zoom-in").dispatch("click");
		return canvas.world.style.transform;
	};
	const plain = await pngCanvas();
	const alphaView = zoomed(plain.canvas);
	await plain.canvas.serverEvent("show", { slug: "beta" });
	await settle();
	const betaFit = plain.canvas.world.style.transform;
	assert.notEqual(betaFit, alphaView, "beta's fit differs from alpha's view");

	let grant!: () => void;
	const permission = new Promise<void>((resolve) => { grant = resolve; });
	const { canvas, log } = await pngCanvas({ permission });
	assert.equal(zoomed(canvas), alphaView);
	choose(canvas, "Export as PNG");
	await settle();
	assert.equal(log.calls.filter((call) => call.startsWith("capture ")).length, 1, "the browser's selector is open");
	await canvas.serverEvent("show", { slug: "beta" });
	await settle();
	assert.equal(canvas.world.style.transform, betaFit, "beta loaded and fitted");
	grant();
	await settle();
	assert.deepEqual(log.draw, []);
	assert.deepEqual(log.names, []);
	assert.equal(canvas.document.getElementById("gd-title").textContent, "Beta");
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.equal(canvas.world.style.transform, betaFit, "beta's fit, not alpha's view from before the export");
	assert.equal(canvas.document.body.classes.has("gd-exporting"), false);
});

test("a capture failure stops the stream and restores the canvas view", async () => {
	const { canvas, log } = await pngCanvas({ play: async () => { throw new Error("The video could not play."); } });
	const before = canvas.world.style.transform;
	choose(canvas, "Export as PNG");
	await settle();
	assert.equal(log.calls.filter((call) => call === "stop").length, 1);
	assert.equal(canvas.world.style.transform, before);
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.equal(canvas.document.body.classes.has("gd-exporting"), false);
	assert.equal(statusText(canvas), "Could not export the artboard. The video could not play. Use your browser's screenshot tool instead.");
	assert.deepEqual(canvas.posts, []);
});

// ---- Export as PDF and Download HTML

/** Both design artboard files, as the server serves them. */
const ARTBOARD_FILES = { [ARTBOARD_URL]: { __text: "<p>A</p>" }, "/t/files/alpha/02-b.html": { __text: "<p>B</p>" } };

test("Export as PDF prints the artboard alone at its size once its frame has loaded, then cleans up", async () => {
	let printed = 0;
	const canvas = await loadExport(ARTBOARD_FILES, { print: () => printed++ });
	choose(canvas, "Export as PDF");
	await settle(4);
	const body = canvas.document.body;
	const holders = withClass(body, "gd-print");
	assert.equal(holders.length, 1, "a print container is added to the page");
	assert.equal(body.classes.has("gd-printing"), true);
	const frame = holders[0].children[0];
	assert.equal(frame.localName, "iframe");
	assert.equal(frame.getAttribute("src"), ARTBOARD_URL);
	assert.equal(frame.getAttribute("sandbox"), "allow-scripts", "sandboxed like the canvas frames");
	assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
	assert.equal(frame.title, "First artboard");
	assert.deepEqual([frame.style.width, frame.style.height], ["400px", "300px"]);
	assert.equal(printed, 0, "printing waits for the artboard");
	frame.dispatch("load");
	assert.equal(printed, 1);
	canvas.windowEvent("afterprint");
	assert.equal(withClass(body, "gd-print").length, 0, "the container is removed after printing");
	assert.equal(body.classes.has("gd-printing"), false);
	assert.deepEqual(canvas.posts, [], "nothing is sent to the server");
});

test("a second Export as PDF replaces the first one's container and ends the first one: one page rule, one afterprint listener (D3)", async () => {
	const canvas = await loadExport(ARTBOARD_FILES, { print: () => {} });
	// canvas.css with a CSSOM, where each export sets its page size.
	const rules: string[] = [];
	const sheet = { href: "/t/assets/canvas.css", cssRules: rules, insertRule: (text: string, index: number) => { rules.splice(index, 0, text); return index; }, deleteRule: (index: number) => { rules.splice(index, 1); } };
	(canvas.document as any).styleSheets = [sheet];
	const listeners = canvas.windowListenerCount("afterprint");
	choose(canvas, "Export as PDF", 0);
	assert.deepEqual(rules, ["@page { size: 400px 300px; }"]);
	choose(canvas, "Export as PDF", 1);
	await settle(4);
	const holders = withClass(canvas.document.body, "gd-print");
	assert.equal(holders.length, 1);
	assert.equal(holders[0].children[0].getAttribute("src"), "/t/files/alpha/02-b.html");
	assert.deepEqual(rules, ["@page { size: 400px 300px; }"], "the first export's page rule is gone, only the second's is left");
	assert.equal(canvas.windowListenerCount("afterprint"), listeners + 1, "the first export no longer waits for afterprint");
	assert.equal(canvas.document.body.classes.has("gd-printing"), true);
	canvas.windowEvent("afterprint");
	assert.deepEqual(rules, []);
	assert.equal(withClass(canvas.document.body, "gd-print").length, 0);
	assert.equal(canvas.document.body.classes.has("gd-printing"), false);
});

/** canvas.css with a CSSOM, where each PDF export sets its page size; `rules` is what it holds. */
function printSheet(canvas: Canvas) {
	const rules: string[] = ["@page { margin: 0; }"];
	const sheet = { href: "/t/assets/canvas.css", cssRules: rules, insertRule: (text: string, index: number) => { rules.splice(index, 0, text); return index; }, deleteRule: (index: number) => { rules.splice(index, 1); } };
	(canvas.document as any).styleSheets = [sheet];
	return rules;
}

test("#3153 case 3: two PDFs started before the first frame loads, then the second one printed: neither page rule, container nor listener is left", async () => {
	let printed = 0;
	const canvas = await loadExport(ARTBOARD_FILES, { print: () => printed++ });
	const rules = printSheet(canvas);
	const listeners = canvas.windowListenerCount("afterprint");
	choose(canvas, "Export as PDF", 0);
	choose(canvas, "Export as PDF", 1);
	assert.deepEqual(rules, ["@page { margin: 0; }", "@page { size: 400px 300px; }"], "the superseded export's rule is gone at once");
	await settle(4);
	const holders = withClass(canvas.document.body, "gd-print");
	assert.equal(holders.length, 1);
	holders[0].children[0].dispatch("load");
	assert.equal(printed, 1, "only the second one prints");
	canvas.windowEvent("afterprint");
	assert.deepEqual(rules, ["@page { margin: 0; }"], "canvas.css's own rules stay, no export rule survives");
	assert.equal(withClass(canvas.document.body, "gd-print").length, 0);
	assert.equal(canvas.document.body.classes.has("gd-printing"), false);
	assert.equal(canvas.windowListenerCount("afterprint"), listeners);
});

test("an Export as PDF whose print() throws cleans up its container, page rule and listener and says so", async () => {
	const canvas = await loadExport(ARTBOARD_FILES, { print: () => { throw new Error("Printing is blocked"); } });
	const rules = printSheet(canvas);
	const listeners = canvas.windowListenerCount("afterprint");
	choose(canvas, "Export as PDF");
	await settle(4);
	withClass(canvas.document.body, "gd-print")[0].children[0].dispatch("load");
	assert.deepEqual(rules, ["@page { margin: 0; }"]);
	assert.equal(withClass(canvas.document.body, "gd-print").length, 0);
	assert.equal(canvas.document.body.classes.has("gd-printing"), false);
	assert.equal(canvas.windowListenerCount("afterprint"), listeners);
	assert.equal(statusText(canvas), "Could not print the artboard (Printing is blocked). Open it from design/ in your project instead.");
	assert.equal(statusIsError(canvas), true);
	assert.equal(toastText(canvas), statusText(canvas));
});

// CodeRabbit 4543489161: an iframe also fires load for the server's 404 page, which would then be printed.
for (const [name, reply, reason] of [["is gone (404)", undefined, "HTTP 404"], ["cannot be fetched", { __throw: "Failed to fetch" }, "Failed to fetch"]] as const) {
	test(`M-D2: Export as PDF of an artboard file that ${name} says so, prints nothing and leaves no container, page rule or listener`, async () => {
		let printed = 0;
		const canvas = await loadExport(reply ? { [ARTBOARD_URL]: reply } : {}, { print: () => printed++ });
		const rules = printSheet(canvas);
		const listeners = canvas.windowListenerCount("afterprint");
		choose(canvas, "Export as PDF");
		await settle(4);
		assert.equal(printed, 0);
		assert.equal(withClass(canvas.document.body, "gd-print").length, 0);
		assert.equal(canvas.document.body.classes.has("gd-printing"), false);
		assert.deepEqual(rules, ["@page { margin: 0; }"]);
		assert.equal(canvas.windowListenerCount("afterprint"), listeners);
		assert.ok(canvas.fetched.includes(ARTBOARD_URL), "the file was read before the frame loads it");
		assert.equal(statusText(canvas), `Could not print the artboard (${reason}). Open it from design/ in your project instead.`);
		assert.equal(statusIsError(canvas), true);
		assert.equal(toastText(canvas), statusText(canvas));
		assert.deepEqual(canvas.posts, []);
	});
}

test("M-D2: a PDF export superseded while its file is read reports nothing when that read fails; the newer one prints", async () => {
	let printed = 0;
	let answer!: (reply: unknown) => void;
	const canvas = await loadExport({ [ARTBOARD_URL]: new Promise((resolve) => { answer = resolve; }), "/t/files/alpha/02-b.html": { __text: "<p>B</p>" } }, { print: () => printed++ });
	const rules = printSheet(canvas);
	choose(canvas, "Export as PDF", 0);
	choose(canvas, "Export as PDF", 1);
	await settle(4);
	answer({ __http: 404 });
	await settle(4);
	assert.equal(statusIsError(canvas), false, "the superseded export says nothing");
	const holders = withClass(canvas.document.body, "gd-print");
	assert.equal(holders.length, 1);
	assert.equal(holders[0].children[0].getAttribute("src"), "/t/files/alpha/02-b.html");
	assert.deepEqual(rules, ["@page { margin: 0; }", "@page { size: 400px 300px; }"]);
	holders[0].children[0].dispatch("load");
	assert.equal(printed, 1);
});

test("S3e: the print frame's blank load before its src is set never prints; the artboard's own load does", async () => {
	let printed = 0;
	let answer!: (reply: unknown) => void;
	const canvas = await loadExport({ [ARTBOARD_URL]: new Promise((resolve) => { answer = resolve; }) }, { print: () => printed++ });
	choose(canvas, "Export as PDF");
	await settle(4);
	const frame = withClass(canvas.document.body, "gd-print")[0].children[0];
	assert.equal(frame.getAttribute("src"), null, "the file is still being read");
	// Firefox before 148 loads the empty frame's about:blank asynchronously, after its insertion.
	frame.dispatch("load");
	assert.equal(printed, 0, "about:blank is not the artboard");
	answer({ __text: "<p>A</p>" });
	await settle(4);
	assert.equal(frame.getAttribute("src"), ARTBOARD_URL);
	frame.dispatch("load");
	assert.equal(printed, 1, "printed once the artboard loaded");
});

/**
 * Download HTML under the canvas base `base`, the artboard served through the server's own injection
 * (injectInspector), so a change in the injected tag fails here. Returns the downloads and the saved blobs.
 */
async function downloadServed(base: string, original: string) {
	const names: string[] = [];
	const blobs: Array<{ parts: unknown[]; type: string }> = [];
	const fileUrl = `${base}files/alpha/01-a.html`;
	// The default replies live under /t/; any other base needs its own design load.
	const designReplies = base === "/t/" ? {} : {
		[`${base}api/system`]: { exists: false },
		[`${base}api/designs`]: { designs: [{ slug: "alpha", title: "Alpha", valid: true }] },
		[`${base}api/designs/alpha`]: { slug: "alpha", title: "Alpha", brief: "", artboards: [{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: 300 }] },
		[`${base}api/designs/alpha/comments`]: { comments: [] },
		[`${base}api/designs/alpha/handoffs`]: { version: 1, chosen: null, handoffs: {} },
	};
	const canvas = await loadExport({ ...designReplies, [fileUrl]: { __text: injectInspector(original, base) } }, {
		Blob: class { constructor(parts: unknown[], options: { type: string }) { blobs.push({ parts, type: options.type }); } },
		URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => names.push("revoked") },
	}, { base });
	const document = canvas.document as any;
	const create = document.createElement.bind(document);
	document.createElement = (tag: string) => (tag === "a" ? { click() { names.push(this.download); }, href: "", download: "" } : create(tag));
	choose(canvas, "Download HTML");
	await settle(4);
	return { canvas, names, blobs: JSON.parse(JSON.stringify(blobs)), fileUrl };
}

test("Download HTML saves the artboard file as written, without the inspector the server injects", async () => {
	const original = "<!doctype html><title>A</title><p>Hello</p></body></html>";
	const { canvas, names, blobs, fileUrl } = await downloadServed("/t/", original);
	assert.deepEqual(names, ["01-a.html", "revoked"]);
	assert.deepEqual(blobs, [{ parts: [original], type: "text/html" }]);
	assert.ok(canvas.fetched.includes(fileUrl));
	assert.deepEqual(canvas.posts, []);
	assert.equal(statusIsError(canvas), false);
});

test("S25: Download HTML removes the inspector the server injects when the base holds characters the server escapes", async () => {
	const original = "<!doctype html><title>A</title><p>Hello</p></body></html>";
	const base = "/t&x\"'<>/";
	const { canvas, names, blobs, fileUrl } = await downloadServed(base, original);
	assert.deepEqual(names, ["01-a.html", "revoked"]);
	assert.deepEqual(blobs, [{ parts: [original], type: "text/html" }], "no inspector tag left");
	assert.ok(canvas.fetched.includes(fileUrl));
	assert.equal(statusIsError(canvas), false);
	// An artboard without </body> gets the tag at its end; it is removed there too.
	const bare = "<p>No body end</p>";
	assert.deepEqual((await downloadServed(base, bare)).blobs, [{ parts: [bare], type: "text/html" }]);
});

test("a failed Download HTML says so with the reason and downloads nothing", async () => {
	const names: string[] = [];
	const canvas = await loadExport({}, { Blob: class {}, URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} } });
	const document = canvas.document as any;
	const create = document.createElement.bind(document);
	document.createElement = (tag: string) => (tag === "a" ? { click() { names.push(this.download); }, href: "", download: "" } : create(tag));
	choose(canvas, "Download HTML");
	await settle(4);
	assert.deepEqual(names, []);
	assert.equal(statusText(canvas), "Could not download the artboard (HTTP 404). Open it from design/ in your project instead.");
	assert.equal(statusIsError(canvas), true);
	assert.equal(toastText(canvas), statusText(canvas));
	assert.deepEqual(canvas.posts, []);
});

// ---- source pins, markup, styles and docs

/** The source without its comments, so a word in a sentence never counts as code. */
const code = (source: string) => source.replace(/\/\*[^]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("canvas-export.js reaches the browser only through ctx.win and ctx.doc, changes the view through the store and keeps its English strings in one TEXT block", () => {
	const source = read("canvas-export.js");
	const body = code(source);
	for (const global of ["window", "document", "navigator", "URL", "Blob", "fetch", "requestAnimationFrame", "setTimeout", "print", "confirm", "innerWidth", "innerHeight", "localStorage"]) {
		assert.ok(!new RegExp(`(?<![\\w.$])${global}\\s*[.(\\[]`).test(body), `${global} only through win or doc`);
	}
	for (const used of ["win.navigator", "win.print", "win.URL", "win.Blob", "win.fetch", "win.requestAnimationFrame", "doc.body", "doc.createElement"]) assert.ok(body.includes(used), used);
	assert.match(body, /store\.setView\(/);
	assert.match(body, /store\.setFocus\(\{ size/, "the size goes back through setFocus, the sizes PR's path");
	assert.match(body, /actions\.setFrameSize\(/);
	assert.ok(!/\.confirm\(/.test(body), "no blocking confirm before the capture: it would spend the click's activation (D1)");
	assert.match(body, /return \{ boardMenuButton, closeBoardMenu \};\s*\}\s*$/, "the other modules only need the button and closing its menu (D2)");
	assert.ok(!/\bstate\.(?:size|focus|menu)\s*=(?!=)/.test(body));
	assert.ok(source.indexOf("const TEXT = Object.freeze({") >= 0 && source.indexOf("const TEXT = Object.freeze({") < source.indexOf("export function init"), "the strings sit in one TEXT block before init");
	assert.ok(!/\bloc\(|\bt\(|data-i18n|CATALOG|createAlert|explain\(|setRaw|variant|Try another direction|Compare with app|Implement this|enterCompare/.test(body), "no i18n, no alert helpers, no other menu items");
	assert.ok(!/\b(?:state|view|savedView)\.(?:x|y|zoom|fitted)\s*(?:[-+*/]?=)(?!=)/.test(body));
	assert.ok(!/Object\.assign\(\s*state\b/.test(body));
	assert.ok(!/https?:\/\//i.test(source), "no remote URL literals");
});

test("canvas-export.js is an allowlisted module wired by canvas-boot.js", () => {
	assert.equal(DESIGN_CANVAS_ASSETS["canvas-export.js"], "text/javascript; charset=utf-8");
	const boot = read("canvas-boot.js");
	assert.match(boot, /import \* as exporter from "\.\/canvas-export\.js";/);
	assert.match(boot, /const MODULES = \[[^\]]*\bexporter\b[^\]]*\];/);
	assert.match(read("canvas-boards.js"), /actions\.boardMenuButton\(board\)/, "the boards ask for the button when they are built, never at init");
});

test("index.html's sprite holds the menu and export icons", () => {
	const html = read("index.html");
	for (const icon of ["i-more", "i-image", "i-file", "i-download"]) assert.match(html, new RegExp(`<symbol id="${icon}" viewBox="0 0 24 24">`));
	assert.ok(!/data-i18n/.test(html));
});

/** The body of the first `selector {` rule in canvas.css. */
function rule(css: string, selector: string) {
	const start = css.indexOf(`\n${selector} {`);
	assert.ok(start >= 0, `${selector} is styled`);
	return css.slice(start, css.indexOf("}", start) + 1);
}

test("canvas.css: one Export section on --gd-* tokens hides the chrome while exporting and prints only the print container", () => {
	const css = read("canvas.css");
	assert.equal(css.split("/* Export (canvas-export.js)").length - 1, 1, "one Export section");
	const section = css.slice(css.indexOf("/* Export (canvas-export.js)"));
	for (const selector of [".gd-menu-button", ".gd-exporting .gd-viewport", ".gd-print"]) {
		const text = rule(section, selector);
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(text), `${selector}: tokens only`);
		assert.ok(!/var\(--(?!gd-)/.test(text), `${selector}: only --gd-* tokens`);
		assert.ok(!/transition|animation/.test(text), `${selector}: no motion`);
	}
	assert.match(css, /\.gd-menu-button:focus-visible[^{]*{[^}]*outline:\s*2px solid var\(--gd-focus\)/);
	assert.match(css, /\.gd-exporting \.gd-viewport\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/);
	assert.match(css, /\.gd-exporting \.gd-viewport > :not\(\.gd-world\)/);
	for (const hidden of ["gd-pins", "gd-artboard:not(.gd-focus-board)"]) assert.ok(section.includes(`.gd-exporting .${hidden}`), hidden);
	assert.match(css, /@media print\s*\{[^]*body\.gd-printing > :not\(\.gd-print\)\s*\{\s*display:\s*none/);
	assert.match(css, /@page\s*\{\s*margin:\s*0/);
	assert.ok(!/border-radius:\s*50%/.test(section), "S4: no dots");
});

test("the docs describe the artboard menu and its exports", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"), docs.indexOf("### Gentle Music"));
	const start = section.indexOf("- **Export**");
	assert.ok(start >= 0, "an Export entry");
	const entry = section.slice(start, section.indexOf("\n", start));
	for (const part of ["**⋯**", "not the Design system board", "**Export as PNG**", "**Export as PNG at 2×**", "**Export as PDF**", "**Download HTML**", "*Save as PDF*", "canvas tab", "`<artboard>@2x.png`", "`F11`", "Chromium", "screenshot tool", "inspector", "only read the artboard file from the canvas server", "nothing is uploaded"]) assert.ok(entry.includes(part), `the Export entry mentions ${part}`);
	assert.ok(entry.includes("opens a menu with **Export as PNG**, **Export as PNG at 2×**, **Export as PDF** and **Download HTML**,"), "the export items, and only them (S7)");
	for (const cut of ["Try another direction", "Compare with app"]) assert.ok(!entry.includes(cut), `${cut} is not in this menu`);
	assert.ok(!entry.includes("Nothing goes to the canvas server"), "PDF and HTML read the artboard from the server (S3f)");
});
