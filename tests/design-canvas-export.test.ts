import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DESIGN_CANVAS_ASSETS } from "../lib/design-canvas-assets.ts";
import { boardsOf, click, findAll, flush, handoffDoc, loadCanvas, read, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// Export (canvas-export.js): a ⋯ button in each design artboard's header opens the shared
// menu (canvas-menu.js) with the export items only: Export as PNG (the browser's tab
// capture, cropped to the artboard), at 2×, Export as PDF (the print dialog) and Download
// HTML (the file without the injected inspector). Nothing goes to the server. Every
// assertion compares strings, numbers or booleans, never fake elements, which node:assert
// would walk whole on a failure.

const SYSTEM_REPLY = { "/t/api/system": { exists: true, file: "system.html", width: 800, height: 600 } };
const EXPORT_ITEMS = ["Export as PNG", "Export as PNG at 2×", "Export as PDF", "Download HTML"];
const ARTBOARD_URL = "/t/files/alpha/01-a.html";

async function loadExport(replies: Record<string, unknown> = {}, extraWindow: Record<string, unknown> = {}) {
	const canvas = await loadCanvas(300, replies, {}, extraWindow);
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
		assert.equal(button.type, "button");
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
	assert.deepEqual(menuItems(canvas).map((item) => withClass(item, "gd-i")[0].children[0].getAttribute("href")), ["#i-image", "#i-image", "#i-image", "#i-download"]);
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

type PngLog = { calls: string[]; draw: number[][]; names: string[]; during: Array<{ exporting: boolean; transform: string; width: string; height: string }>; output: { width: number; height: number } | null };

/** The canvas with a tab capture that hands back one 1200 x 800 frame (this window at 1×) and a canvas that records what it draws. */
async function pngCanvas(extra: { surface?: string; play?: () => Promise<void>; confirm?: boolean; frame?: { width: number; height: number } } = {}) {
	const log: PngLog = { calls: [], draw: [], names: [], during: [], output: null };
	const track = { stop: () => log.calls.push("stop"), getSettings: () => (extra.surface ? { displaySurface: extra.surface } : {}) };
	const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
	const canvas = await loadExport({}, {
		confirm: (message: string) => { log.calls.push(message); return extra.confirm ?? true; },
		navigator: { mediaDevices: { getDisplayMedia: async (options: unknown) => { log.calls.push(`capture ${JSON.stringify(options)}`); return stream; } } },
		URL: { createObjectURL: () => { log.calls.push("url"); return "blob:test"; }, revokeObjectURL: () => log.calls.push("revoke") },
	});
	const frame = extra.frame ?? { width: 400, height: 300 };
	canvas.boards[0].frame.rect = { left: 100, top: 100, ...frame };
	const document = canvas.document as any;
	const create = document.createElement.bind(document);
	document.createElement = (tag: string) => {
		if (tag === "video") return { videoWidth: 1200, videoHeight: 800, play: extra.play ?? (async () => { log.calls.push("play"); }), requestVideoFrameCallback: (done: () => void) => { log.calls.push("frame"); done(); } };
		if (tag === "canvas") {
			const output: any = {
				width: 0,
				height: 0,
				getContext: () => ({ drawImage: (_video: unknown, ...args: number[]) => {
					log.draw.push(args);
					log.during.push({ exporting: canvas.document.body.classes.has("gd-exporting"), transform: canvas.world.style.transform, width: canvas.boards[0].frame.style.width, height: canvas.boards[0].frame.style.height });
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
	return { canvas, log };
}

for (const [name, navigator] of [
	["missing", undefined],
	["denied", { mediaDevices: { getDisplayMedia: async () => { throw new Error("Permission denied."); } } }],
] as const) test(`a ${name} tab capture says so on the status line and the toast, and suggests the browser screenshot tool`, async () => {
	const canvas = await loadExport({}, { navigator, confirm: () => true });
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

for (const scale of [1, 2]) test(`export ${scale}× warns about the tab first, crops this tab's frame to the artboard at 100% and stops the capture`, async () => {
	const { canvas, log } = await pngCanvas();
	const before = canvas.world.style.transform;
	choose(canvas, scale === 1 ? "Export as PNG" : "Export as PNG at 2×");
	await settle();
	assert.equal(log.calls[0], "Choose this canvas tab in the browser's capture selector. Choosing another tab or screen may export the wrong content.");
	assert.equal(log.calls[1], 'capture {"video":{"displaySurface":"browser"},"audio":false,"preferCurrentTab":true}');
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
	assert.equal(statusIsError(canvas), false);
	assert.deepEqual(canvas.posts, []);
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

test("cancelling the tab warning starts no capture and changes nothing", async () => {
	const { canvas, log } = await pngCanvas({ confirm: false });
	const before = canvas.world.style.transform;
	choose(canvas, "Export as PNG");
	await settle();
	assert.equal(log.calls.filter((call) => call.startsWith("capture")).length, 0);
	assert.equal(canvas.world.style.transform, before);
	assert.equal(statusText(canvas), "");
	assert.deepEqual(canvas.posts, []);
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

test("Export as PDF prints the artboard alone at its size once its frame has loaded, then cleans up", async () => {
	let printed = 0;
	const canvas = await loadExport({}, { print: () => printed++ });
	choose(canvas, "Export as PDF");
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

test("a second Export as PDF replaces the first one's container", async () => {
	const canvas = await loadExport({}, { print: () => {} });
	choose(canvas, "Export as PDF", 0);
	choose(canvas, "Export as PDF", 1);
	const holders = withClass(canvas.document.body, "gd-print");
	assert.equal(holders.length, 1);
	assert.equal(holders[0].children[0].getAttribute("src"), "/t/files/alpha/02-b.html");
});

test("Download HTML saves the artboard file as written, without the inspector the server injects", async () => {
	const names: string[] = [];
	const blobs: Array<{ parts: unknown[]; type: string }> = [];
	const original = "<!doctype html><title>A</title><p>Hello</p></body></html>";
	const served = original.replace("</body>", '<script src="/t/assets/inspector.js"></script></body>');
	const canvas = await loadExport({ [ARTBOARD_URL]: { __text: served } }, {
		Blob: class { constructor(parts: unknown[], options: { type: string }) { blobs.push({ parts, type: options.type }); } },
		URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => names.push("revoked") },
	});
	const document = canvas.document as any;
	const create = document.createElement.bind(document);
	document.createElement = (tag: string) => (tag === "a" ? { click() { names.push(this.download); }, href: "", download: "" } : create(tag));
	choose(canvas, "Download HTML");
	await settle(4);
	assert.deepEqual(names, ["01-a.html", "revoked"]);
	assert.deepEqual(JSON.parse(JSON.stringify(blobs)), [{ parts: [original], type: "text/html" }]);
	assert.ok(canvas.fetched.includes(ARTBOARD_URL));
	assert.deepEqual(canvas.posts, []);
	assert.equal(statusIsError(canvas), false);
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
	for (const used of ["win.navigator", "win.confirm", "win.print", "win.URL", "win.Blob", "win.fetch", "win.requestAnimationFrame", "doc.body", "doc.createElement"]) assert.ok(body.includes(used), used);
	assert.match(body, /store\.setView\(/);
	assert.match(body, /store\.setFocus\(\{ size/, "the size goes back through setFocus, the sizes PR's path");
	assert.match(body, /actions\.setFrameSize\(/);
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
	for (const icon of ["i-more", "i-image", "i-download"]) assert.match(html, new RegExp(`<symbol id="${icon}" viewBox="0 0 24 24">`));
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
	for (const part of ["**⋯**", "not the Design system board", "**Export as PNG**", "**Export as PNG at 2×**", "**Export as PDF**", "**Download HTML**", "*Save as PDF*", "canvas tab", "`<artboard>@2x.png`", "`F11`", "Chromium", "screenshot tool", "inspector", "Nothing goes to the canvas server"]) assert.ok(entry.includes(part), `the Export entry mentions ${part}`);
	assert.ok(entry.includes("opens a menu with **Export as PNG**, **Export as PNG at 2×**, **Export as PDF** and **Download HTML**,"), "the export items, and only them (S7)");
	for (const cut of ["Try another direction", "Compare with app"]) assert.ok(!entry.includes(cut), `${cut} is not in this menu`);
});
