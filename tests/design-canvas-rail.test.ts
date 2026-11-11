import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { boardsOf, click, findAll, handoffDoc, loadCanvas, memoryStorage, read, SVG_NS, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// The tool rail and its shortcuts (canvas-rail.js) and the shared menu (canvas-menu.js):
// Move, Comment, Overview and Settings; the ? list of keyboard shortcuts; single keys a
// person can change, saved in this browser.

const SHORTCUTS_KEY = "gentle-design:shortcuts";
const SHORTCUT_IDS = ["navigate", "comment", "fit", "panel", "help"];
const DEFAULT_KEYS = ["V", "C", "F", "]", "?"];
const SYSTEM_REPLY = { "/t/api/system": { exists: true, file: "system.html", width: 1440, height: 1200 } };
const COMMENT_STATUS = "Comment mode: click an element in an artboard";
const UNSAVED = "This browser could not save the change, so it holds for this page only.";

/** The canvas with an in-memory (or a throwing) localStorage; `stored` seeds the shortcuts entry (a string goes in as is). */
async function loadRail(options: { stored?: unknown; broken?: boolean; full?: boolean; replies?: Record<string, unknown> } = {}) {
	const seed = options.stored === undefined ? {} : { [SHORTCUTS_KEY]: typeof options.stored === "string" ? options.stored : JSON.stringify(options.stored) };
	const storage = memoryStorage(seed, options.broken);
	// `full`: reads work, every write throws (a full or read-only storage).
	const localStorage = options.full ? { getItem: storage.localStorage.getItem, setItem() { throw new Error("QuotaExceededError"); } } : storage.localStorage;
	const canvas = await loadCanvas(300, options.replies ?? {}, {}, { localStorage });
	// The fake DOM starts every element visible; index.html starts these hidden.
	canvas.document.getElementById("gd-popover").hidden = true;
	canvas.document.getElementById("gd-menu").hidden = true;
	const shortcutWrites = () => storage.writes.filter(([key]) => key === SHORTCUTS_KEY).map(([, value]) => value);
	const stored = () => (storage.data.has(SHORTCUTS_KEY) ? JSON.parse(storage.data.get(SHORTCUTS_KEY)!) : undefined);
	return { ...canvas, storage, shortcutWrites, stored };
}
type Rail = Awaited<ReturnType<typeof loadRail>>;

const $ = (canvas: Rail, id: string) => canvas.document.getElementById(id);

/** A key press delivered to the document's keydown listeners, as the browser would from `target`. */
function press(canvas: Rail, key: string, init: Record<string, unknown> = {}, target?: FakeElement) {
	const event: any = { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: target ?? canvas.document.body, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, ...init };
	for (const listener of canvas.document.listeners.get("keydown") ?? []) listener(event);
	return event;
}

const pressed = (canvas: Rail, id: string) => $(canvas, id).getAttribute("aria-pressed");
const keyOn = (target: FakeElement, key: string, init: Record<string, unknown> = {}) => target.dispatch("keydown", { key, shiftKey: false, ...init });
const menuEl = (canvas: Rail) => $(canvas, "gd-menu");
const menuItems = (canvas: Rail) => findAll(menuEl(canvas), (element) => element.getAttribute("role") === "menuitem");
const itemLabels = (canvas: Rail) => menuItems(canvas).map((item) => texts(item, "gd-menu-label")[0]);
const settingsButton = (canvas: Rail) => $(canvas, "gd-rail-settings");
const openSettings = (canvas: Rail) => {
	settingsButton(canvas).dispatch("click");
	return menuItems(canvas);
};
const fitWorld = (canvas: Rail) => {
	Object.defineProperty(canvas.world, "offsetWidth", { value: 2000 });
	Object.defineProperty(canvas.world, "offsetHeight", { value: 400 });
};
const zoomIn = (canvas: Rail) => canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });

// ---- the rail

test("the rail's Move and Comment form a pressed pair over Comment mode", async () => {
	const canvas = await loadRail();
	const navigate = $(canvas, "gd-tool-navigate");
	const comment = $(canvas, "gd-comment");
	assert.deepEqual([pressed(canvas, "gd-tool-navigate"), pressed(canvas, "gd-comment")], ["true", "false"]);

	comment.dispatch("click");
	assert.deepEqual([pressed(canvas, "gd-tool-navigate"), pressed(canvas, "gd-comment")], ["false", "true"]);
	assert.ok(canvas.world.classes.has("gd-commenting"));
	assert.equal($(canvas, "gd-status").textContent, COMMENT_STATUS);
	assert.deepEqual(canvas.frames()[0].contentWindow!.posted.at(-1), { type: "gd:mode", enabled: true });

	navigate.dispatch("click");
	assert.deepEqual([pressed(canvas, "gd-tool-navigate"), pressed(canvas, "gd-comment")], ["true", "false"]);
	assert.ok(!canvas.world.classes.has("gd-commenting"));
	assert.deepEqual(canvas.frames()[0].contentWindow!.posted.at(-1), { type: "gd:mode", enabled: false });

	// Comment keeps toggling, Move while moving changes nothing, and the nav chip stays main's.
	comment.dispatch("click");
	comment.dispatch("click");
	assert.equal(pressed(canvas, "gd-comment"), "false");
	navigate.dispatch("click");
	assert.equal(pressed(canvas, "gd-tool-navigate"), "true");
	assert.equal(canvas.navMode.textContent, "Navigating");

	// Esc in the canvas leaves Comment mode and the pair follows.
	comment.dispatch("click");
	press(canvas, "Escape");
	assert.deepEqual([pressed(canvas, "gd-tool-navigate"), pressed(canvas, "gd-comment")], ["true", "false"]);
});

test("comment mode on the rail keeps main's pick routing: a click on an artboard picks instead of focusing", async () => {
	const canvas = await loadRail();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 100, width: 200, height: 150 };
	$(canvas, "gd-comment").dispatch("click");
	click(first.shield!, 150, 130);
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:pick-at", x: 100, y: 60 });
});

test("the rail's Overview fits the canvas, and is off in focus mode and in Compare", async () => {
	const canvas = await loadRail({ replies: { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:5173/" } }) } });
	fitWorld(canvas);
	zoomIn(canvas);
	assert.notEqual(canvas.zoomLevel.textContent, "45%");
	const fit = $(canvas, "gd-rail-fit");
	fit.dispatch("click");
	assert.equal(canvas.zoomLevel.textContent, "45%");

	click(canvas.boards[0].shield!, 200, 200);
	assert.equal(fit.disabled, true, "off while an artboard is in focus");
	$(canvas, "gd-back").dispatch("click");
	assert.equal(fit.disabled, false);

	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	assert.equal(fit.disabled, true, "off over Compare");
	$(canvas, "gd-compare-back").dispatch("click");
	assert.equal(fit.disabled, false);
});

const IMPLEMENTED_REPLY = { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:5173/" } }) };

test("Compare covers the rail: it is inert until Back to canvas, keys leave the mode alone, and a design.json reload keeps Overview off", async () => {
	const canvas = await loadRail({ replies: IMPLEMENTED_REPLY });
	const rail = $(canvas, "gd-rail");
	const fit = $(canvas, "gd-rail-fit");
	assert.equal(rail.inert, false);

	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	assert.equal($(canvas, "gd-compare").hidden, false);
	assert.equal(rail.inert, true, "Move, Comment, Overview and Settings leave the keyboard and the pointer while Compare covers them");
	assert.equal(press(canvas, "c").defaultPrevented, false);
	assert.equal(pressed(canvas, "gd-comment"), "false", "Comment mode does not change behind Compare");

	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	assert.equal($(canvas, "gd-compare").hidden, false, "the reload keeps Compare open");
	assert.equal(fit.disabled, true, "Overview stays off after a design.json reload");
	assert.equal(rail.inert, true, "and the rail stays inert");

	$(canvas, "gd-compare-back").dispatch("click");
	assert.deepEqual([rail.inert, fit.disabled], [false, false]);
	press(canvas, "c");
	assert.equal(pressed(canvas, "gd-comment"), "true", "the keys work again after Compare");
});

// ---- single-key shortcuts

test("V, C, F, ] and ? drive the tools from the keyboard, without letter case", async () => {
	const canvas = await loadRail();
	fitWorld(canvas);
	const panel = $(canvas, "gd-panel");

	assert.equal(press(canvas, "c").defaultPrevented, true);
	assert.equal(pressed(canvas, "gd-comment"), "true");
	press(canvas, "v");
	assert.equal(pressed(canvas, "gd-comment"), "false");
	press(canvas, "C");
	assert.equal(pressed(canvas, "gd-comment"), "true", "the shortcuts ignore letter case");
	press(canvas, "V");
	assert.equal(pressed(canvas, "gd-tool-navigate"), "true");

	zoomIn(canvas);
	press(canvas, "f");
	assert.equal(canvas.zoomLevel.textContent, "45%");

	press(canvas, "]");
	assert.equal(panel.hidden, true);
	assert.equal(pressed(canvas, "gd-panel-toggle"), "false");
	press(canvas, "]");
	assert.equal(panel.hidden, false);

	press(canvas, "?", { shiftKey: true });
	assert.ok($(canvas, "gd-shortcuts").hasAttribute("open"));
	// Single keys do nothing while the list is open, except ? which closes it.
	assert.equal(press(canvas, "c").defaultPrevented, false);
	assert.equal(pressed(canvas, "gd-comment"), "false");
	press(canvas, "?", { shiftKey: true });
	assert.ok(!$(canvas, "gd-shortcuts").hasAttribute("open"));
	assert.equal(canvas.document.activeElement, settingsButton(canvas), "closing the list returns focus to Settings");
});

test("browser chords, typing, the open comment box and focus mode leave single keys alone; Shift+Esc still leaves focus", async () => {
	const canvas = await loadRail();
	for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) assert.equal(press(canvas, "c", init).defaultPrevented, false);
	assert.equal(pressed(canvas, "gd-comment"), "false", "browser chords are left alone");

	const editable = canvas.document.createElement("div");
	editable.setAttribute("contenteditable", "true");
	const typing = [...["input", "textarea", "select"].map((tag) => canvas.document.createElement(tag)), editable];
	for (const field of typing) {
		for (const key of ["c", "v", "f", "]", "?"]) assert.equal(press(canvas, key, {}, field).defaultPrevented, false);
	}
	assert.equal(pressed(canvas, "gd-comment"), "false", "typing never switches tools");
	assert.equal($(canvas, "gd-panel").hidden, false);
	assert.ok(!$(canvas, "gd-shortcuts").hasAttribute("open"));

	const popover = $(canvas, "gd-popover");
	popover.hidden = false;
	press(canvas, "c");
	press(canvas, "]");
	assert.equal(pressed(canvas, "gd-comment"), "false", "no shortcuts while the comment box is open");
	assert.equal($(canvas, "gd-panel").hidden, false);
	popover.hidden = true;

	click(canvas.boards[0].shield!, 200, 200);
	const transform = canvas.world.style.transform;
	for (const key of ["c", "v", "f", "]", "?"]) assert.equal(press(canvas, key).defaultPrevented, false, `${key} is left alone in focus mode`);
	assert.equal(pressed(canvas, "gd-comment"), "false");
	assert.equal(canvas.world.style.transform, transform);
	press(canvas, "Escape", { shiftKey: true });
	assert.equal(canvas.navMode.textContent, "Navigating", "Shift+Esc still leaves focus mode");
	press(canvas, "c");
	assert.equal(pressed(canvas, "gd-comment"), "true", "shortcuts work again outside focus mode");
});

// AltGr reports Ctrl+Alt on Windows; getModifierState("AltGraph") tells it apart from a chord.
const ALT_GRAPH = { ctrlKey: true, altKey: true, getModifierState: (modifier: string) => modifier === "AltGraph" };
const CTRL_ALT = { ctrlKey: true, altKey: true, getModifierState: () => false };

test("a key typed with AltGr is a printable key, while Ctrl, Alt and Cmd chords stay ignored", async () => {
	const canvas = await loadRail();
	const panel = $(canvas, "gd-panel");
	assert.equal(press(canvas, "]", ALT_GRAPH).defaultPrevented, true, "] typed with AltGr");
	assert.equal(panel.hidden, true, "toggles the comments panel");
	for (const init of [CTRL_ALT, { ctrlKey: true, getModifierState: () => false }, { altKey: true }, { ...ALT_GRAPH, metaKey: true }]) {
		assert.equal(press(canvas, "]", init).defaultPrevented, false, JSON.stringify(init));
	}
	assert.equal(panel.hidden, true, "chords leave the panel alone");

	assert.equal(changeKey(canvas, "comment", "@", ALT_GRAPH).defaultPrevented, true);
	assert.equal(keysMessage(canvas), "“Comment on an element” is now @.", "AltGr punctuation can be assigned");
	assert.equal(rowKey(canvas, "comment"), "@");
	for (const init of [CTRL_ALT, { ...ALT_GRAPH, metaKey: true }]) {
		changeKey(canvas, "fit", "#", init);
		assert.equal(keysMessage(canvas), "Use a single letter, digit or punctuation key, without Ctrl, Alt or Cmd. Nothing changed.", JSON.stringify(init));
	}
	assert.deepEqual(canvas.stored(), { comment: "@" });
	closeList(canvas);
	assert.equal(press(canvas, "@", ALT_GRAPH).defaultPrevented, true);
	assert.equal(pressed(canvas, "gd-comment"), "true", "the AltGr key runs its action");
});

test("M and [ are not shortcuts in this canvas", async () => {
	const canvas = await loadRail();
	for (const key of ["m", "[", "z"]) assert.equal(press(canvas, key).defaultPrevented, false, key);
	assert.equal($(canvas, "gd-panel").hidden, false);
	assert.equal(pressed(canvas, "gd-comment"), "false");
});

// ---- Settings and the shared menu

test("Settings opens the shared menu with Design system board and Keyboard shortcuts, with the menu keyboard behavior", async () => {
	const canvas = await loadRail();
	const settings = settingsButton(canvas);
	const dialog = $(canvas, "gd-shortcuts");
	const items = openSettings(canvas);
	assert.equal(menuEl(canvas).hidden, false);
	assert.equal(settings.getAttribute("aria-expanded"), "true");
	assert.equal(menuEl(canvas).getAttribute("aria-label"), "Settings");
	assert.deepEqual(itemLabels(canvas), ["Design system board", "Keyboard shortcuts"]);
	assert.deepEqual(items.map((item) => [item.localName, item.getAttribute("tabindex")]), [["button", "-1"], ["button", "-1"]]);
	// Each item leads with a sprite icon built in the SVG namespace of the page's sprite.
	for (const [item, name] of [[items[0], "#i-palette"], [items[1], "#i-keys"]] as const) {
		const [svg] = findAll(item, (element) => element.localName === "svg");
		assert.equal(svg.namespaceURI, SVG_NS);
		assert.equal(svg.getAttribute("aria-hidden"), "true");
		assert.deepEqual(findAll(svg, (element) => element.localName === "use").map((use) => [use.namespaceURI, use.getAttribute("href")]), [[SVG_NS, name]]);
	}
	assert.equal(canvas.document.activeElement, items[0], "focus moves to the first item");
	assert.equal(items[0].getAttribute("aria-disabled"), "true", "no design system board, nothing to show");
	assert.equal(items[1].getAttribute("aria-keyshortcuts"), "?");
	assert.deepEqual(texts(items[1], "gd-menu-kbd"), ["?"]);
	items[0].dispatch("click");
	assert.equal(menuEl(canvas).hidden, false, "a disabled item does nothing");
	assert.equal(canvas.navMode.textContent, "Navigating");

	keyOn(items[0], "ArrowDown");
	assert.equal(canvas.document.activeElement, items[1]);
	keyOn(items[1], "ArrowDown");
	assert.equal(canvas.document.activeElement, items[0], "the arrows wrap");
	keyOn(items[0], "End");
	assert.equal(canvas.document.activeElement, items[1]);
	keyOn(items[1], "Home");
	assert.equal(canvas.document.activeElement, items[0]);
	keyOn(items[0], "ArrowUp");
	assert.equal(canvas.document.activeElement, items[1]);
	assert.equal(press(canvas, "c", {}, items[1]).defaultPrevented, false, "single keys stay off while it is open");
	assert.equal(pressed(canvas, "gd-comment"), "false");
	assert.equal(keyOn(items[1], "Escape").defaultPrevented, true);
	assert.equal(menuEl(canvas).hidden, true);
	assert.deepEqual(menuEl(canvas).children, [], "a closed menu keeps no items");
	assert.equal(settings.getAttribute("aria-expanded"), "false");
	assert.equal(canvas.document.activeElement, settings, "Escape returns focus to Settings");

	keyOn(settings, "ArrowUp");
	const again = menuItems(canvas);
	assert.equal(canvas.document.activeElement, again[again.length - 1], "ArrowUp opens on the last item");
	keyOn(again[1], "Enter");
	assert.equal(menuEl(canvas).hidden, true);
	assert.ok(dialog.hasAttribute("open"), "Keyboard shortcuts opens the list");
	$(canvas, "gd-shortcuts-close").dispatch("click");
	assert.ok(!dialog.hasAttribute("open"));
	assert.equal(canvas.document.activeElement, settings, "closing the list returns focus to Settings");

	keyOn(settings, "ArrowDown");
	assert.equal(canvas.document.activeElement, menuItems(canvas)[0], "ArrowDown opens on the first item");
	keyOn(menuItems(canvas)[0], "Tab");
	assert.equal(menuEl(canvas).hidden, true, "Tab closes it");

	const pointerdown = (target: FakeElement) => (canvas.document.listeners.get("pointerdown") ?? []).forEach((listener) => listener({ target, button: 0 }));
	openSettings(canvas);
	pointerdown(menuItems(canvas)[1]);
	assert.equal(menuEl(canvas).hidden, false, "a press inside keeps it open");
	pointerdown(canvas.viewport);
	assert.equal(menuEl(canvas).hidden, true, "a press outside closes it");
	openSettings(canvas);
	settings.dispatch("click");
	assert.equal(menuEl(canvas).hidden, true, "Settings toggles it");
	assert.equal(canvas.document.activeElement, settings);
});

test("Settings' Design system board shows the system board in focus mode", async () => {
	const canvas = await loadRail({ replies: SYSTEM_REPLY });
	const [system] = openSettings(canvas);
	assert.equal(system.getAttribute("aria-disabled"), null);
	system.dispatch("click");
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(canvas.navMode.textContent, "Using: Design system · Shift+Esc to exit");
	assert.equal($(canvas, "gd-rail-fit").disabled, true);
	$(canvas, "gd-back").dispatch("click");
	assert.equal($(canvas, "gd-rail-fit").disabled, false);
});

test("Settings' Design system board rechecks the board when chosen: if it vanished meanwhile, the focused view and panel stay", async () => {
	const canvas = await loadRail({ replies: SYSTEM_REPLY });
	const panel = $(canvas, "gd-panel");
	// The system board is the first board; focus the design's first artboard.
	click(canvas.boards[1].shield!, 200, 200);
	const using = "Using: First · Shift+Esc to exit";
	assert.equal(canvas.navMode.textContent, using);
	assert.equal(panel.hidden, true);
	const transform = canvas.world.style.transform;

	const [system] = openSettings(canvas);
	assert.equal(system.getAttribute("aria-disabled"), null);
	canvas.replies["/t/api/system"] = { exists: false };
	await canvas.serverEvent("change", { slug: null, file: "system.html" });
	assert.equal(boardsOf(canvas).length, 2, "the system board is gone");
	assert.equal(canvas.navMode.textContent, using, "the focused artboard is still focused");

	let thrown = "";
	try {
		system.dispatch("click");
	} catch (error) {
		thrown = String(error);
	}
	assert.equal(thrown, "", "choosing it does not throw");
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(canvas.navMode.textContent, using, "focus mode is unchanged");
	assert.equal(boardsOf(canvas).findIndex((wrapper) => wrapper.classes.has("gd-focus-board")), 0, "on the same artboard");
	assert.equal($(canvas, "gd-back").hidden, false);
	assert.equal(panel.hidden, true, "the panel stays as it was");
	assert.equal(canvas.world.style.transform, transform, "and so does the view");
	$(canvas, "gd-back").dispatch("click");
	assert.deepEqual([canvas.navMode.textContent, panel.hidden], ["Navigating", false], "Back to canvas still restores the panel");
});

// ---- changing the single keys

const keyRows = (canvas: Rail) => withClass($(canvas, "gd-keys-custom"), "gd-key-row");
const keyRow = (canvas: Rail, id: string) => keyRows(canvas).find((row) => row.dataset.shortcut === id)!;
const rowKey = (canvas: Rail, id: string) => texts(keyRow(canvas, id), "gd-key-current")[0];
const rowKeys = (canvas: Rail) => SHORTCUT_IDS.map((id) => rowKey(canvas, id));
const rowChange = (canvas: Rail, id: string) => withClass(keyRow(canvas, id), "gd-key-change")[0];
const rowReset = (canvas: Rail, id: string) => withClass(keyRow(canvas, id), "gd-key-reset")[0];
const keysMessage = (canvas: Rail) => $(canvas, "gd-keys-message").textContent;
const shortcutsOpen = (canvas: Rail) => $(canvas, "gd-shortcuts").hasAttribute("open");
const closeList = (canvas: Rail) => $(canvas, "gd-shortcuts-close").dispatch("click");
/** Opens the list (as Settings' Keyboard shortcuts does), presses Change on `id`'s row and then `key`; returns the key's event. */
function changeKey(canvas: Rail, id: string, key: string, init: Record<string, unknown> = {}) {
	if (!shortcutsOpen(canvas)) openSettings(canvas)[1].dispatch("click");
	rowChange(canvas, id).dispatch("click");
	return press(canvas, key, init, rowChange(canvas, id));
}

test("the shortcuts list shows each rail and panel action with its key, Change and Reset, and one Restore defaults", async () => {
	const canvas = await loadRail();
	assert.deepEqual(keyRows(canvas).map((row) => row.dataset.shortcut), SHORTCUT_IDS, "the five single-key actions, in this order");
	const labels = SHORTCUT_IDS.map((id) => texts(keyRow(canvas, id), "gd-key-action")[0]);
	// The fixed rows below (0 fits too) never repeat a changeable action's name.
	const fixedRows = [...read("index.html").matchAll(/<dd>([^<]+)<\/dd>/g)].map((match) => match[1]);
	for (const label of labels) assert.ok(!fixedRows.includes(label), `${label} is named once in the list`);
	assert.deepEqual(labels, ["Move around the canvas", "Comment on an element", "Overview (fit all directions)", "Show or hide the comments panel", "Show keyboard shortcuts"]);
	assert.deepEqual(rowKeys(canvas), DEFAULT_KEYS);
	assert.equal(rowChange(canvas, "navigate").textContent, "Change");
	assert.equal(rowChange(canvas, "navigate").getAttribute("aria-label"), "Change the key for “Move around the canvas” (V)");
	assert.equal(rowReset(canvas, "comment").textContent, "Reset");
	assert.equal(rowReset(canvas, "comment").getAttribute("aria-label"), "Reset “Comment on an element” to C");
	assert.equal(keysMessage(canvas), "");
	assert.deepEqual(canvas.shortcutWrites(), [], "reading the defaults writes nothing");
	// Every place that names a key names the current one.
	for (const [id, key, title] of [["gd-tool-navigate", "V", "Move around the canvas (V)"], ["gd-comment", "C", "Comment on an element (C)"], ["gd-rail-fit", "F", "See all the directions (F)"], ["gd-panel-toggle", "]", "Comments panel (])"]]) {
		assert.equal($(canvas, id).title, title);
		assert.equal($(canvas, id).getAttribute("aria-keyshortcuts"), key);
	}
});

test("a new key triggers its action, the old one does not, and the rail, the list and Settings show it", async () => {
	const canvas = await loadRail();
	assert.equal(changeKey(canvas, "comment", "k").defaultPrevented, true, "the key is taken by the list");
	assert.equal(pressed(canvas, "gd-comment"), "false", "assigning does not run the action");
	assert.equal(rowKey(canvas, "comment"), "K");
	assert.equal(keysMessage(canvas), "“Comment on an element” is now K.");
	assert.deepEqual(canvas.stored(), { comment: "k" });
	closeList(canvas);
	assert.equal(press(canvas, "c").defaultPrevented, false, "the old key is free");
	assert.equal(pressed(canvas, "gd-comment"), "false");
	assert.equal(press(canvas, "K").defaultPrevented, true, "case does not matter");
	assert.equal(pressed(canvas, "gd-comment"), "true");
	assert.equal($(canvas, "gd-comment").title, "Comment on an element (K)");
	assert.equal($(canvas, "gd-comment").getAttribute("aria-keyshortcuts"), "K");
	assert.equal(rowChange(canvas, "comment").getAttribute("aria-label"), "Change the key for “Comment on an element” (K)");
	assert.equal(rowReset(canvas, "comment").getAttribute("aria-label"), "Reset “Comment on an element” to C", "Reset names the default");

	changeKey(canvas, "navigate", "x");
	changeKey(canvas, "fit", "g");
	changeKey(canvas, "panel", "p");
	changeKey(canvas, "help", "/");
	assert.deepEqual(canvas.stored(), { navigate: "x", comment: "k", fit: "g", panel: "p", help: "/" });
	closeList(canvas);
	assert.equal($(canvas, "gd-tool-navigate").title, "Move around the canvas (X)");
	assert.equal($(canvas, "gd-rail-fit").title, "See all the directions (G)");
	assert.equal($(canvas, "gd-panel-toggle").title, "Comments panel (P)");
	assert.equal($(canvas, "gd-panel-toggle").getAttribute("aria-keyshortcuts"), "P");
	press(canvas, "x");
	assert.equal(pressed(canvas, "gd-comment"), "false", "X moves around the canvas");
	press(canvas, "k");
	assert.equal(pressed(canvas, "gd-comment"), "true", "K selects Comment");
	assert.equal(press(canvas, "v").defaultPrevented, false, "the old Move key is free");
	assert.equal(pressed(canvas, "gd-comment"), "true", "V no longer selects Move");
	press(canvas, "]");
	assert.equal($(canvas, "gd-panel").hidden, false, "] is free");
	press(canvas, "p");
	assert.equal($(canvas, "gd-panel").hidden, true, "P toggles the comments panel");
	const items = openSettings(canvas);
	assert.equal(items[1].getAttribute("aria-keyshortcuts"), "/");
	assert.deepEqual(texts(items[1], "gd-menu-kbd"), ["/"]);
	keyOn(items[1], "Escape");
	press(canvas, "?", { shiftKey: true });
	assert.equal(shortcutsOpen(canvas), false, "? is free");
	press(canvas, "/");
	assert.equal(shortcutsOpen(canvas), true, "/ opens the list");
	press(canvas, "?", { shiftKey: true });
	assert.equal(shortcutsOpen(canvas), true);
	press(canvas, "/");
	assert.equal(shortcutsOpen(canvas), false, "and closes it");
});

test("holding a shortcut key runs it once: the browser's repeated keydowns are ignored", async () => {
	const canvas = await loadRail();
	const panel = $(canvas, "gd-panel");
	press(canvas, "]");
	assert.equal(panel.hidden, true);
	assert.equal(press(canvas, "]", { repeat: true }).defaultPrevented, false, "a repeat is not taken");
	assert.equal(panel.hidden, true, "and does not show the panel again");
	press(canvas, "c");
	press(canvas, "v", { repeat: true });
	assert.equal(pressed(canvas, "gd-comment"), "true", "a held V does not switch to Move");
	press(canvas, "?", { shiftKey: true });
	press(canvas, "?", { shiftKey: true, repeat: true });
	assert.equal(shortcutsOpen(canvas), true, "a held ? leaves the list open");
	// Holding the key just given to the list's own action does not close the list either.
	changeKey(canvas, "help", "/");
	assert.equal(press(canvas, "/", { repeat: true }).defaultPrevented, false);
	assert.equal(shortcutsOpen(canvas), true);
	press(canvas, "/");
	assert.equal(shortcutsOpen(canvas), false, "a new press still closes it");
});

test("custom keys are restored on load, and a stored entry that is unusable, unknown or taken is ignored", async () => {
	const restored = await loadRail({ stored: { navigate: "x", help: "/" } });
	assert.deepEqual(rowKeys(restored), ["X", "C", "F", "]", "/"]);
	assert.equal($(restored, "gd-tool-navigate").title, "Move around the canvas (X)");
	press(restored, "/");
	assert.equal(shortcutsOpen(restored), true);
	assert.deepEqual(restored.shortcutWrites(), [], "loading writes nothing");

	for (const stored of ["not json", "[1, 2]", "\"x\"", "null", "42", JSON.stringify({ navigate: "vv", comment: "Enter", fit: " ", panel: 7, help: "0", minimap: "z", bogus: "z" })]) {
		const canvas = await loadRail({ stored });
		assert.deepEqual(rowKeys(canvas), DEFAULT_KEYS, stored);
		press(canvas, "c");
		assert.equal(pressed(canvas, "gd-comment"), "true", `${stored}: the canvas still works`);
		assert.equal(press(canvas, "z").defaultPrevented, false, `${stored}: z names no action here`);
		press(canvas, "v");
		assert.equal(pressed(canvas, "gd-comment"), "false");
	}
	// Two actions stored on one key: neither takes it.
	const twice = await loadRail({ stored: { navigate: "q", comment: "q", fit: "w" } });
	assert.deepEqual(rowKeys(twice), ["V", "C", "W", "]", "?"]);
	// A stored key equal to another action's default is refused too, and that refusal can free another one.
	const chained = await loadRail({ stored: { navigate: "c" } });
	assert.deepEqual(rowKeys(chained), DEFAULT_KEYS);
	// Keys swapped between two actions are both kept.
	const swapped = await loadRail({ stored: { navigate: "c", comment: "v" } });
	assert.deepEqual(rowKeys(swapped), ["C", "V", "F", "]", "?"]);
	press(swapped, "c");
	assert.equal(pressed(swapped, "gd-comment"), "false", "C now moves around the canvas");
	press(swapped, "v");
	assert.equal(pressed(swapped, "gd-comment"), "true");

	const broken = await loadRail({ broken: true, stored: { navigate: "x" } });
	assert.deepEqual(rowKeys(broken), DEFAULT_KEYS, "unreadable storage keeps the defaults");
	changeKey(broken, "comment", "k");
	assert.equal(rowKey(broken, "comment"), "K", "and a change still applies for this page");
	assert.equal(keysMessage(broken), `“Comment on an element” is now K. ${UNSAVED}`);
	closeList(broken);
	press(broken, "k");
	assert.equal(pressed(broken, "gd-comment"), "true");
});

test("when the browser cannot save a key, the list says it holds for this page only", async () => {
	const canvas = await loadRail({ full: true, stored: { navigate: "x" } });
	assert.deepEqual(rowKeys(canvas), ["X", "C", "F", "]", "?"], "a readable storage still restores the keys");
	changeKey(canvas, "comment", "k");
	assert.equal(keysMessage(canvas), `“Comment on an element” is now K. ${UNSAVED}`);
	assert.ok($(canvas, "gd-keys-message").classes.has("gd-error"), "the warning reads as an error");
	assert.equal(rowKey(canvas, "comment"), "K", "the key holds for this page");
	rowReset(canvas, "comment").dispatch("click");
	assert.equal(keysMessage(canvas), `“Comment on an element” is back to C. ${UNSAVED}`);
	$(canvas, "gd-keys-restore").dispatch("click");
	assert.equal(keysMessage(canvas), `All shortcuts are back to their defaults. ${UNSAVED}`);
	assert.deepEqual(rowKeys(canvas), DEFAULT_KEYS);
	assert.deepEqual(canvas.shortcutWrites(), [], "nothing was written");

	// A storage that saves keeps the plain message.
	const saving = await loadRail();
	changeKey(saving, "comment", "k");
	assert.equal(keysMessage(saving), "“Comment on an element” is now K.");
	assert.ok(!$(saving, "gd-keys-message").classes.has("gd-error"));
});

test("a key whose lower case is not one character, like İ, is refused when assigned and ignored when stored", async () => {
	const canvas = await loadRail();
	changeKey(canvas, "comment", "İ", { shiftKey: true });
	assert.equal(keysMessage(canvas), "Use a single letter, digit or punctuation key, without Ctrl, Alt or Cmd. Nothing changed.");
	assert.equal(rowKey(canvas, "comment"), "C");
	assert.deepEqual(canvas.shortcutWrites(), []);
	// A letter beyond ASCII whose lower case is one character still works, in either case.
	changeKey(canvas, "comment", "Ñ", { shiftKey: true });
	assert.equal(keysMessage(canvas), "“Comment on an element” is now Ñ.");
	assert.deepEqual(canvas.stored(), { comment: "ñ" });

	for (const stored of [{ comment: "İ" }, { comment: "i̇" }]) {
		const reloaded = await loadRail({ stored });
		assert.deepEqual(rowKeys(reloaded), DEFAULT_KEYS, JSON.stringify(stored));
		press(reloaded, "c");
		assert.equal(pressed(reloaded, "gd-comment"), "true", `${JSON.stringify(stored)}: C still comments`);
	}
	const kept = await loadRail({ stored: { comment: "Ñ" } });
	assert.equal(rowKey(kept, "comment"), "Ñ", "a stored Ñ is kept, lower case");
});

test("a key another action uses is refused with a message naming it, and nothing changes", async () => {
	const canvas = await loadRail();
	assert.equal(changeKey(canvas, "navigate", "C", { shiftKey: true }).defaultPrevented, true);
	assert.equal(keysMessage(canvas), "C is already used by “Comment on an element”. Nothing changed.");
	assert.ok($(canvas, "gd-keys-message").classes.has("gd-error"), "a refusal reads as an error");
	assert.deepEqual([rowKey(canvas, "navigate"), rowKey(canvas, "comment")], ["V", "C"]);
	assert.deepEqual(canvas.shortcutWrites(), [], "nothing stored");
	assert.equal(rowChange(canvas, "navigate").textContent, "Change", "the wait is over");
	changeKey(canvas, "panel", "?", { shiftKey: true });
	assert.equal(keysMessage(canvas), "? is already used by “Show keyboard shortcuts”. Nothing changed.");
	assert.equal(shortcutsOpen(canvas), true, "? did not close the list while it waited");
	// A custom key is taken too.
	changeKey(canvas, "fit", "g");
	assert.ok(!$(canvas, "gd-keys-message").classes.has("gd-error"));
	changeKey(canvas, "panel", "g");
	assert.equal(keysMessage(canvas), "G is already used by “Overview (fit all directions)”. Nothing changed.");
	assert.deepEqual(canvas.stored(), { fit: "g" });
	closeList(canvas);
	press(canvas, "]");
	assert.equal($(canvas, "gd-panel").hidden, true, "] still toggles the panel");
});

test("fixed keys and keys that are not one printable key are refused; Esc cancels the wait; nothing fires while it waits", async () => {
	const canvas = await loadRail();
	const fixed: Array<[string, Record<string, unknown>, string]> = [
		["Escape", { shiftKey: true }, "Shift+Esc"], ["Enter", {}, "Enter"], [" ", {}, "Space"], ["ArrowLeft", {}, "←"], ["ArrowDown", {}, "↓"], ["0", {}, "0"], ["+", { shiftKey: true }, "+"], ["-", {}, "-"], ["=", {}, "="],
	];
	for (const [key, init, name] of fixed) {
		assert.equal(changeKey(canvas, "navigate", key, init).defaultPrevented, true, key);
		assert.equal(keysMessage(canvas), `${name} is a fixed key and can’t be assigned. Nothing changed.`);
		assert.equal(rowKey(canvas, "navigate"), "V");
	}
	// Tab is fixed too, but it moves focus on as usual: it ends the wait, and is neither taken nor reported.
	for (const init of [{}, { shiftKey: true }]) {
		assert.equal(changeKey(canvas, "navigate", "Tab", init).defaultPrevented, false, `Tab ${JSON.stringify(init)} still moves focus`);
		assert.equal(rowChange(canvas, "navigate").textContent, "Change", "and ends the wait");
		assert.equal(keysMessage(canvas), "");
		assert.equal(rowKey(canvas, "navigate"), "V");
	}
	for (const [key, init] of [["F5", {}], ["k", { ctrlKey: true }], ["k", { altKey: true }], ["k", { metaKey: true }], ["Dead", {}]] as const) {
		changeKey(canvas, "navigate", key, init);
		assert.equal(keysMessage(canvas), "Use a single letter, digit or punctuation key, without Ctrl, Alt or Cmd. Nothing changed.", `${key} ${JSON.stringify(init)}`);
	}
	assert.equal(rowKey(canvas, "navigate"), "V");
	assert.deepEqual(canvas.shortcutWrites(), []);

	// Waiting: the button says so; a modifier alone keeps it waiting; Esc cancels and keeps the list open.
	rowChange(canvas, "navigate").dispatch("click");
	assert.equal(rowChange(canvas, "navigate").textContent, "Press a key…");
	assert.equal(rowChange(canvas, "navigate").getAttribute("aria-label"), null, "while it waits, its visible text is its name");
	assert.equal(canvas.document.activeElement, rowChange(canvas, "navigate"));
	assert.ok(keyRow(canvas, "navigate").classes.has("gd-key-waiting"));
	assert.equal(keysMessage(canvas), "Press the new key for “Move around the canvas”, or Esc to cancel.");
	assert.equal(press(canvas, "Shift", { shiftKey: true }).defaultPrevented, false);
	assert.equal(rowChange(canvas, "navigate").textContent, "Press a key…", "still waiting");
	assert.equal(press(canvas, "Escape").defaultPrevented, true, "the list does not close on this Esc");
	assert.equal(shortcutsOpen(canvas), true);
	assert.equal(rowChange(canvas, "navigate").textContent, "Change");
	assert.ok(!keyRow(canvas, "navigate").classes.has("gd-key-waiting"));
	assert.equal(keysMessage(canvas), "“Move around the canvas” keeps V.");
	assert.deepEqual(canvas.shortcutWrites(), []);
	press(canvas, "x");
	assert.equal(rowKey(canvas, "navigate"), "V", "after the wait a key changes nothing");

	// Change again on the waiting row cancels it; Change on another row moves the wait there.
	rowChange(canvas, "fit").dispatch("click");
	rowChange(canvas, "fit").dispatch("click");
	assert.equal(rowChange(canvas, "fit").textContent, "Change");
	assert.equal(keysMessage(canvas), "“Overview (fit all directions)” keeps F.");
	rowChange(canvas, "fit").dispatch("click");
	rowChange(canvas, "panel").dispatch("click");
	assert.equal(rowChange(canvas, "fit").textContent, "Change");
	press(canvas, "b");
	assert.deepEqual([rowKey(canvas, "panel"), rowKey(canvas, "fit")], ["B", "F"]);

	// Nothing fires while it waits: the next key is the new one, even the comment mode Esc.
	closeList(canvas);
	press(canvas, "c");
	assert.equal(pressed(canvas, "gd-comment"), "true");
	openSettings(canvas)[1].dispatch("click");
	rowChange(canvas, "fit").dispatch("click");
	press(canvas, "Escape", {}, canvas.document.body);
	assert.equal(pressed(canvas, "gd-comment"), "true", "the Esc that cancels a wait does not leave Comment mode");
	rowChange(canvas, "fit").dispatch("click");
	assert.equal(press(canvas, "v").defaultPrevented, true);
	assert.equal(pressed(canvas, "gd-comment"), "true", "V did not switch to Move");
	assert.equal(keysMessage(canvas), "V is already used by “Move around the canvas”. Nothing changed.");
	// Closing the list ends a wait.
	changeKey(canvas, "navigate", "Shift", { shiftKey: true });
	closeList(canvas);
	press(canvas, "x");
	assert.equal(rowKey(canvas, "navigate"), "V");
	// So does the browser closing it (Esc on the modal), and leaving the Change button.
	openSettings(canvas)[1].dispatch("click");
	rowChange(canvas, "navigate").dispatch("click");
	$(canvas, "gd-shortcuts").close();
	assert.equal(rowChange(canvas, "navigate").textContent, "Change");
	openSettings(canvas)[1].dispatch("click");
	assert.equal(keysMessage(canvas), "", "opening the list clears the last message");
	rowChange(canvas, "navigate").dispatch("click");
	rowChange(canvas, "navigate").dispatch("blur");
	assert.equal(rowChange(canvas, "navigate").textContent, "Change");
	assert.equal(keysMessage(canvas), "");
});

test("Reset puts one action back on its default key and Restore defaults puts them all back", async () => {
	const canvas = await loadRail({ stored: { navigate: "x", comment: "k", help: "/" } });
	rowReset(canvas, "comment").dispatch("click");
	assert.equal(rowKey(canvas, "comment"), "C");
	assert.equal(keysMessage(canvas), "“Comment on an element” is back to C.");
	assert.deepEqual(canvas.stored(), { navigate: "x", help: "/" });
	assert.equal($(canvas, "gd-comment").title, "Comment on an element (C)");
	press(canvas, "c");
	assert.equal(pressed(canvas, "gd-comment"), "true");
	$(canvas, "gd-keys-restore").dispatch("click");
	assert.deepEqual(rowKeys(canvas), DEFAULT_KEYS);
	assert.equal(keysMessage(canvas), "All shortcuts are back to their defaults.");
	assert.deepEqual(canvas.stored(), {});
	assert.equal($(canvas, "gd-tool-navigate").title, "Move around the canvas (V)");
	press(canvas, "v");
	assert.equal(pressed(canvas, "gd-comment"), "false");
	// A Reset taken by another action's custom key is refused like a change.
	changeKey(canvas, "navigate", "q");
	changeKey(canvas, "comment", "v");
	rowReset(canvas, "navigate").dispatch("click");
	assert.equal(keysMessage(canvas), "V is already used by “Comment on an element”. Nothing changed.");
	assert.equal(rowKey(canvas, "navigate"), "Q");
	assert.deepEqual(canvas.stored(), { navigate: "q", comment: "v" });
});

// ---- markup, styles, docs

test("index.html: a labeled rail with Move, Comment, Overview and Settings, one sprite, the menu and the shortcuts dialog, in English with no i18n hooks", () => {
	const html = read("index.html");
	const railStart = html.indexOf('<nav id="gd-rail" class="gd-rail" aria-label="Tools">');
	assert.ok(railStart > 0, "a labeled rail");
	const rail = html.slice(railStart, html.indexOf("</nav>", railStart));
	const buttons = [...rail.matchAll(/<button type="button" id="([^"]+)"([^>]*)>([^]*?)<\/button>/g)];
	assert.deepEqual(buttons.map((match) => match[1]), ["gd-tool-navigate", "gd-comment", "gd-rail-fit", "gd-rail-settings"], "four tools, in this order");
	const labels = { "gd-tool-navigate": ["hand", "Move"], "gd-comment": ["comment", "Comment"], "gd-rail-fit": ["fit", "Overview"], "gd-rail-settings": ["gear", "Settings"] } as const;
	for (const [, id, attributes, inner] of buttons) {
		const [iconName, label] = labels[id as keyof typeof labels];
		assert.equal(inner, `<svg class="gd-i" aria-hidden="true"><use href="#i-${iconName}"/></svg><span class="gd-tool-label">${label}</span>`, id);
		assert.ok(!/aria-label=/.test(attributes), `${id}: the visible label is its name`);
		assert.match(attributes, /title="[^"]+"/, `${id}: a tooltip`);
	}
	for (const [id, key] of [["gd-tool-navigate", "V"], ["gd-comment", "C"], ["gd-rail-fit", "F"]]) {
		assert.match(rail, new RegExp(`id="${id}"[^>]*aria-keyshortcuts="${key}"[^>]*title="[^"]*\\(${key}\\)"`), `${id} names ${key}`);
	}
	assert.match(rail, /id="gd-rail-settings" class="gd-tool gd-bottom" aria-haspopup="menu" aria-expanded="false" aria-controls="gd-menu" title="Settings: design system and keyboard shortcuts"/);
	assert.match(html, /id="gd-panel-toggle"[^>]*aria-keyshortcuts="\]" title="Comments panel \(\]\)"/);

	// Comment moved from the top bar into the rail, and the rail sits beside the viewport.
	const bar = html.slice(html.indexOf('<header class="gd-bar"'), html.indexOf("</header>"));
	assert.ok(!bar.includes('id="gd-comment"'), "Comment is no longer in the top bar");
	assert.equal(html.split('id="gd-comment"').length - 1, 1);
	assert.ok(html.indexOf('<div class="gd-main">') < railStart && railStart < html.indexOf('<main id="gd-viewport"'), "the rail is the first column of the main area");

	// One sprite, with each used icon in it, and only icons something uses.
	const sprite = /<svg id="gd-sprite" class="gd-sprite" width="0" height="0" aria-hidden="true" focusable="false">([^]*?)<\/svg>/.exec(html);
	assert.ok(sprite, "a hidden sprite");
	const symbols = [...sprite![1].matchAll(/<symbol id="([^"]+)" viewBox="0 0 24 24">/g)].map((match) => match[1]);
	assert.equal(new Set(symbols).size, symbols.length, "sprite ids are unique");
	assert.deepEqual(symbols.sort(), ["i-comment", "i-fit", "i-gear", "i-hand", "i-keys", "i-palette"]);
	for (const match of html.matchAll(/<use href="#([^"]+)"/g)) assert.ok(symbols.includes(match[1]), `${match[1]} exists in the sprite`);

	assert.match(html, /<div id="gd-menu" class="gd-menu" role="menu" hidden><\/div>/);
	const dialog = html.slice(html.indexOf('<dialog id="gd-shortcuts"'), html.indexOf("</dialog>"));
	assert.match(dialog, /^<dialog id="gd-shortcuts" class="gd-dialog" aria-labelledby="gd-shortcuts-title">/);
	assert.match(dialog, /<h2 id="gd-shortcuts-title" class="gd-dialog-title">Keyboard shortcuts<\/h2>/);
	assert.match(dialog, /<ul id="gd-keys-custom" class="gd-keys-custom" aria-label="Shortcuts you can change"><\/ul>/);
	assert.match(dialog, /<p id="gd-keys-message" class="gd-keys-message" role="status" aria-live="polite"><\/p>/);
	assert.match(dialog, /<button type="button" id="gd-keys-restore" class="gd-keys-restore">Restore defaults<\/button><button type="button" id="gd-shortcuts-close" class="gd-primary">Close<\/button>/);
	// The fixed keys of this canvas are listed; Space-pan and the minimap arrive with their own features.
	for (const fixed of [/<dt><kbd>0<\/kbd><\/dt><dd>Fit all directions<\/dd>/, /<dt><kbd>\+<\/kbd> <kbd>-<\/kbd><\/dt><dd>Zoom in and out<\/dd>/, /<kbd>&larr;<\/kbd>/, /<dt><kbd>Esc<\/kbd><\/dt>/, /<dt><kbd>Shift<\/kbd> \+ <kbd>Esc<\/kbd><\/dt>/]) assert.match(dialog, fixed);
	assert.ok(!/Space|[Mm]inimap/.test(dialog), "no Space or minimap keys yet");

	assert.ok(!html.includes("data-i18n"), "no i18n hooks: English literals until the i18n PR");
	for (const cut of ["gd-appearance", "gd-theme", "gd-language", "i-help", "gd-variant", "gd-mark", "data-theme"]) assert.ok(!html.includes(cut), `${cut} stays out`);
	assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(html), "no emoji icons");
});

test("canvas-rail.js and canvas-menu.js keep their English strings grouped at the top, with no catalog, theme or help", () => {
	for (const name of ["canvas-rail.js", "canvas-menu.js"]) {
		const source = read(name);
		assert.ok(!/\bloc\(|\bt\(|data-i18n|CATALOG|refreshLoc|applyLanguage/.test(source), `${name}: no i18n`);
		assert.ok(!/theme|appearance|renderGuide|guideBlocked|variant|minimap/i.test(source), `${name}: no cut feature`);
	}
	const rail = read("canvas-rail.js");
	assert.ok(rail.indexOf("const TEXT = Object.freeze({") >= 0 && rail.indexOf("const TEXT = Object.freeze({") < rail.indexOf("export function init"), "the rail's strings sit in one TEXT block before init");
	assert.ok(rail.includes('"gentle-design:shortcuts"'));
});

/** The body of the first `selector {` rule in canvas.css. */
function rule(css: string, selector: string) {
	const start = css.indexOf(`${selector} {`);
	assert.ok(start >= 0, `${selector} is styled`);
	return css.slice(start, css.indexOf("}", start) + 1);
}

test("canvas.css styles the rail, the menu and the shortcuts list on main's --gd-* tokens, in their own sections", () => {
	const css = read("canvas.css");
	for (const heading of ["/* Tool rail", "/* The shared menu", "/* Keyboard shortcuts"]) assert.equal(css.split(heading).length - 1, 1, `one ${heading} section`);
	const selectors = [".gd-rail", ".gd-rail .gd-tool", ".gd-tool-label", ".gd-i", ".gd-menu", ".gd-menu-item", ".gd-menu-kbd", ".gd-dialog", ".gd-keys", ".gd-keys-custom", ".gd-key-row", ".gd-key-waiting", ".gd-keys-message"];
	for (const selector of selectors) {
		const text = rule(css, selector);
		assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(text), `${selector}: no raw hex`);
		assert.ok(!/transition|animation/.test(text), `${selector}: no motion`);
	}
	for (const selector of [".gd-rail", ".gd-menu", ".gd-dialog"]) assert.match(rule(css, selector), /var\(--gd-panel\)/, `${selector} sits on the panel color`);
	// Only main's tokens: none of the other branch's token names come along.
	const tokens = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]));
	for (const token of tokens) assert.ok(token.startsWith("--gd-"), `${token} is a --gd-* token`);
	assert.match(rule(css, ".gd-menu-item[aria-disabled=\"true\"]"), /cursor: not-allowed/);
	assert.match(css, /\.gd-menu\[hidden\] { display: none; }/);
});

test("the docs describe the rail, the Settings menu and the changeable keys saved in this browser", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"));
	const start = section.indexOf("- **Tool rail**");
	assert.ok(start >= 0, "a Tool rail entry");
	const rail = section.slice(start, section.indexOf("\n", start));
	for (const part of ["**Move** (`V`", "**Comment** (`C`)", "**Overview**", "(`F`)", "**Settings**", "**Design system board**", "**Keyboard shortcuts** (`?`)", "**Change**", "**Reset**", "**Restore defaults**", "`gentle-design:shortcuts`", "saved in this browser", "a new port", "`Tab` moves on and ends it", "holds for this page only", "AltGr", "Compare covers the rail", "`]`", "`Esc`, `Shift+Esc`, the arrows, `Space`, `Enter`, `Tab`"]) {
		assert.ok(rail.includes(part), `the rail entry mentions ${part}`);
	}
	assert.ok(!/Appearance|theme|language|Step-by-step|minimap/i.test(rail), "nothing that does not ship here");
});
