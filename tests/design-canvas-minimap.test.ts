import assert from "node:assert/strict";
import test from "node:test";
import { click, findAll, handoffDoc, loadCanvas, memoryStorage, read, setHandoffs, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// The minimap (canvas-minimap.js): every board drawn small where the layout puts it,
// the visible area as an outlined rectangle, a click or drag in it to move the view,
// and M (a single key of the rail) to show or hide it.

const SYSTEM_REPLY = { "/t/api/system": { exists: true, file: "system.html", width: 800, height: 600 } };
// With the system board (800 x 600) the row is [0, 0, 800, 600], [880, 0, 400, 300], [1360, 0, 560, 840]: 1920 x 840
// world bounds into the 204 x 96 map with a 6 px pad, a scale of exactly 0.1 and a 6 px offset.
const WIDE_SECOND = {
	"/t/api/designs/alpha": {
		slug: "alpha",
		title: "Alpha",
		brief: "",
		artboards: [
			{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: 300 },
			{ file: "02-b.html", title: "Second", tradeoff: "", width: 560, height: 840 },
		],
	},
};

async function loadMinimap(replies: Record<string, unknown> = {}, extraWindow: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
	const canvas = await loadCanvas(300, replies, config, extraWindow);
	// The fake DOM starts every element visible; index.html starts these hidden.
	canvas.document.getElementById("gd-popover").hidden = true;
	canvas.document.getElementById("gd-menu").hidden = true;
	// index.html nests the minimap inside the viewport, at its bottom right.
	const panel = miniPanelOf(canvas.document);
	panel.className = "gd-minimap";
	canvas.viewport.append(panel);
	panel.append(canvas.document.getElementById("gd-minimap-map"));
	// The map sits at (1000, 600) on the page.
	canvas.document.getElementById("gd-minimap-map").rect = { left: 1000, top: 600, width: 204, height: 96 };
	return canvas;
}
type Canvas = Awaited<ReturnType<typeof loadMinimap>>;

const miniPanelOf = (document: Canvas["document"]) => document.getElementById("gd-minimap");
const miniPanel = (canvas: Canvas) => miniPanelOf(canvas.document);
const miniMap = (canvas: Canvas) => canvas.document.getElementById("gd-minimap-map");
const miniView = (canvas: Canvas) => canvas.document.getElementById("gd-minimap-view");
const miniBlocks = (canvas: Canvas) => withClass(miniMap(canvas), "gd-minimap-block");
const miniBox = (element: FakeElement) => ["left", "top", "width", "height"].map((key) => Number.parseFloat(element.style[key]));
const near = (actual: number[], expected: number[]) => {
	assert.equal(actual.length, expected.length);
	actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 0.05, `${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`));
};
const minimapCanvas = (replies: Record<string, unknown> = {}, extraWindow: Record<string, unknown> = {}) => loadMinimap({ ...SYSTEM_REPLY, ...WIDE_SECOND, ...replies }, extraWindow);
const mapPointer = (canvas: Canvas, type: string, worldX: number, worldY: number, init: Record<string, unknown> = {}) =>
	miniMap(canvas).dispatch(type, { button: 0, pointerId: 7, clientX: 1000 + 6 + worldX * 0.1, clientY: 600 + 6 + worldY * 0.1, ...init });

/** A key press delivered to the document's keydown listeners, as the browser would from `target`. */
function press(canvas: Canvas, key: string, init: Record<string, unknown> = {}, target?: FakeElement) {
	const event: any = { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: target ?? canvas.document.body, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, ...init };
	for (const listener of canvas.document.listeners.get("keydown") ?? []) listener(event);
	return event;
}

// ---- the map

test("the minimap draws every board as a block at its place in the layout, the system board first", async () => {
	const canvas = await minimapCanvas();
	const blocks = miniBlocks(canvas);
	assert.equal(blocks.length, 3, "the system board and both artboards");
	near(miniBox(blocks[0]), [6, 6, 80, 60]);
	near(miniBox(blocks[1]), [94, 6, 40, 30]);
	near(miniBox(blocks[2]), [142, 6, 56, 84]);
	assert.ok(blocks[0].classes.has("gd-minimap-system"), "the first block is the system board");
	assert.ok(!blocks[1].classes.has("gd-minimap-system") && !blocks[2].classes.has("gd-minimap-system"));
	assert.equal(miniPanel(canvas).hidden, false);
	assert.equal(miniMap(canvas).children.at(-1), miniView(canvas), "the visible area is drawn over the blocks");
});

test("minimap blocks carry no text; each names its artboard on hover", async () => {
	const canvas = await minimapCanvas();
	const blocks = miniBlocks(canvas);
	assert.deepEqual(blocks.map((block) => block.children.length), [0, 0, 0], "no label inside the blocks");
	assert.deepEqual(blocks.map((block) => block.title), ["Design system", "First", "Second"]);
});

test("blocks keep the world's aspect and are centered in the map", async () => {
	// Wide and short bounds (3840 x 400): the width limits the scale to 0.05 and the height is centered.
	const canvas = await loadMinimap({
		"/t/api/system": { exists: true, file: "system.html", width: 2000, height: 400 },
		"/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [
			{ file: "01-a.html", title: "First", tradeoff: "", width: 800, height: 400 },
			{ file: "02-b.html", title: "Second", tradeoff: "", width: 880, height: 400 },
		] },
	});
	const blocks = miniBlocks(canvas);
	near(miniBox(blocks[0]), [6, 38, 100, 20]);
	near(miniBox(blocks[2]), [154, 38, 44, 20]);
});

test("the chosen artboard's block is the accent one, live, and no other block is marked", async () => {
	const canvas = await minimapCanvas();
	assert.deepEqual(miniBlocks(canvas).map((block) => block.classes.has("gd-minimap-chosen")), [false, false, false]);
	await setHandoffs(canvas, handoffDoc("02-b.html", { "02-b.html": {} }));
	assert.deepEqual(miniBlocks(canvas).map((block) => block.classes.has("gd-minimap-chosen")), [false, false, true]);
	assert.ok(miniBlocks(canvas).every((block) => [...block.classes].every((name) => ["gd-minimap-block", "gd-minimap-system", "gd-minimap-chosen"].includes(name))), "the alternatives carry no discarded styling");
	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.deepEqual(miniBlocks(canvas).map((block) => block.classes.has("gd-minimap-chosen")), [false, false, false]);
});

test("a moved artboard moves its block while it is dragged", async () => {
	const canvas = await minimapCanvas({ "/t/api/designs/alpha/layout": { layout: null } });
	const title = withClass(canvas.world.children[1], "gd-artboard-title")[0];
	title.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 900, clientY: 100 });
	title.dispatch("pointermove", { pointerId: 3, clientX: 900, clientY: 200 });
	near(miniBox(miniBlocks(canvas)[1]), [94, 16, 40, 30]);
	title.dispatch("pointerup", { button: 0, pointerId: 3, clientX: 900, clientY: 200 });
	near(miniBox(miniBlocks(canvas)[1]), [94, 16, 40, 30]);
});

// ---- the visible area

test("the visible area is an outlined rectangle that follows pan and zoom", async () => {
	const canvas = await minimapCanvas();
	// Initial view: world offset (48, 48) at 100% in a 1000 x 700 viewport shows world x -48..952, y -48..652.
	near(miniBox(miniView(canvas)), [1.2, 1.2, 100, 70]);
	// A key pan of 50 px to the left moves the view 50 world px right.
	canvas.viewport.dispatch("keydown", { key: "ArrowRight" });
	near(miniBox(miniView(canvas)), [6.2, 1.2, 100, 70]);
	canvas.viewport.dispatch("keydown", { key: "ArrowLeft" });
	// Zoom in 25% around the center: x = -65, y = -27.5 shows world x 52..852, y 22..582.
	canvas.viewport.dispatch("keydown", { key: "+" });
	near(miniBox(miniView(canvas)), [11.2, 8.2, 80, 56]);
	assert.equal(miniView(canvas).getAttribute("aria-hidden"), null, "the rectangle lives inside the map, which carries the name");
});

test("the visible-area rectangle is clipped to the map when the view is away from the boards, and never shrinks to nothing", async () => {
	const canvas = await minimapCanvas();
	for (let i = 0; i < 40; i++) canvas.viewport.dispatch("keydown", { key: "ArrowRight", shiftKey: true });
	const [left, top, width, height] = miniBox(miniView(canvas));
	assert.ok(left >= 0 && top >= 0 && left + width <= 204.01 && top + height <= 96.01, "never outside the map");
	assert.ok(left + width > 203.9 && Math.abs(width - 4) < 0.05, "pinned to the right edge at 4 px, pointing to where the view went");
	assert.ok(height > 60);
	// Far up and to the left: pinned to the top left corner, 4 px each way.
	for (let i = 0; i < 80; i++) canvas.viewport.dispatch("keydown", { key: "ArrowLeft", shiftKey: true });
	for (let i = 0; i < 40; i++) canvas.viewport.dispatch("keydown", { key: "ArrowUp", shiftKey: true });
	near(miniBox(miniView(canvas)), [0, 0, 4, 4]);
});

test("a pan or a wheel only moves the outline: it reads no board's layout and does not measure the viewport", async () => {
	const canvas = await minimapCanvas();
	let reads = 0;
	for (const element of findAll(canvas.world, () => true)) {
		for (const key of ["offsetLeft", "offsetTop", "offsetWidth", "offsetHeight"]) {
			const value = (element as any)[key];
			Object.defineProperty(element, key, { configurable: true, get: () => { reads += 1; return value; } });
		}
	}
	let measured = 0;
	const rect = canvas.viewport.rect;
	canvas.viewport.getBoundingClientRect = () => { measured += 1; return rect; };
	for (let i = 0; i < 5; i++) canvas.viewport.dispatch("wheel", { deltaX: 20, deltaY: 10, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	canvas.viewport.dispatch("keydown", { key: "ArrowDown" });
	canvas.viewport.dispatch("pointerdown", { button: 0, pointerId: 9, clientX: 10, clientY: 10 });
	canvas.viewport.dispatch("pointermove", { pointerId: 9, clientX: 30, clientY: 10 });
	canvas.viewport.dispatch("pointerup", { button: 0, pointerId: 9, clientX: 30, clientY: 10 });
	near(miniBox(miniView(canvas)), [1.2 + 10 - 2, 1.2 + 5 + 5, 100, 70]);
	assert.equal(reads, 0, "no board offsets per pan");
	assert.equal(measured, 0, "no viewport measure per pan");
});

// ---- moving the view from the map

test("a click in the minimap centers the view on that world point; zoom stays", async () => {
	const canvas = await minimapCanvas();
	canvas.viewport.dispatch("keydown", { key: "+" });
	const zoom = canvas.zoomLevel.textContent;
	// Click world point (400, 300): at 125% the viewport's center (500, 350) goes there.
	mapPointer(canvas, "pointerdown", 400, 300);
	assert.equal(canvas.world.style.transform, "translate(0px, -25px) scale(1.25)");
	mapPointer(canvas, "pointerup", 400, 300);
	assert.equal(canvas.zoomLevel.textContent, zoom);
	near(miniBox(miniView(canvas)), [6, 8, 80, 56]);
	assert.equal(canvas.navMode.textContent, "Navigating", "a click in the map never focuses an artboard");
	assert.deepEqual(canvas.viewport.capturedPointers, [], "nor starts a pan of the canvas underneath");
});

test("dragging in the minimap pans with the pointer until it is released", async () => {
	const canvas = await minimapCanvas();
	mapPointer(canvas, "pointerdown", 400, 300);
	assert.equal(canvas.world.style.transform, "translate(100px, 50px) scale(1)");
	assert.deepEqual(miniMap(canvas).capturedPointers, [7]);
	mapPointer(canvas, "pointermove", 600, 400);
	assert.equal(canvas.world.style.transform, "translate(-100px, -50px) scale(1)");
	near(miniBox(miniView(canvas)), [16, 11, 100, 70]);
	mapPointer(canvas, "pointerup", 600, 400);
	mapPointer(canvas, "pointermove", 1000, 700);
	assert.equal(canvas.world.style.transform, "translate(-100px, -50px) scale(1)", "moves after the release do nothing");
});

test("only the primary button pans the minimap, and another pointer's moves are ignored", async () => {
	const canvas = await minimapCanvas();
	const before = canvas.world.style.transform;
	mapPointer(canvas, "pointerdown", 400, 300, { button: 2 });
	assert.equal(canvas.world.style.transform, before);
	mapPointer(canvas, "pointerdown", 400, 300);
	const after = canvas.world.style.transform;
	mapPointer(canvas, "pointermove", 900, 500, { pointerId: 8 });
	assert.equal(canvas.world.style.transform, after);
	mapPointer(canvas, "pointercancel", 400, 300);
	mapPointer(canvas, "pointermove", 900, 500);
	assert.equal(canvas.world.style.transform, after, "a cancelled drag ends too");
});

test("a second pointer pressed during a minimap drag is ignored, and losing the capture ends the drag", async () => {
	const canvas = await minimapCanvas();
	mapPointer(canvas, "pointerdown", 400, 300);
	assert.equal(canvas.world.style.transform, "translate(100px, 50px) scale(1)");
	mapPointer(canvas, "pointerdown", 900, 500, { pointerId: 8 });
	assert.equal(canvas.world.style.transform, "translate(100px, 50px) scale(1)", "the second press does not move the view");
	assert.deepEqual(miniMap(canvas).capturedPointers, [7], "nor takes the capture");
	mapPointer(canvas, "pointermove", 900, 500, { pointerId: 8 });
	assert.equal(canvas.world.style.transform, "translate(100px, 50px) scale(1)");
	mapPointer(canvas, "pointermove", 600, 400);
	assert.equal(canvas.world.style.transform, "translate(-100px, -50px) scale(1)", "the first pointer still drags");
	mapPointer(canvas, "pointerup", 900, 500, { pointerId: 8 });
	mapPointer(canvas, "pointermove", 500, 300);
	assert.equal(canvas.world.style.transform, "translate(0px, 50px) scale(1)", "the second pointer's release does not end the first one's drag");
	mapPointer(canvas, "lostpointercapture", 500, 300);
	mapPointer(canvas, "pointermove", 600, 400);
	assert.equal(canvas.world.style.transform, "translate(0px, 50px) scale(1)", "a lost capture ends the drag");
});

test("a minimap drag past the map's edges stops at them", async () => {
	const canvas = await minimapCanvas();
	mapPointer(canvas, "pointerdown", 400, 300);
	// Far past the bottom right: the map's corner (204, 96) is world (1980, 900).
	mapPointer(canvas, "pointermove", 9000, 4000);
	assert.equal(canvas.world.style.transform, "translate(-1480px, -550px) scale(1)");
	// Far past the top left: the map's corner (0, 0) is world (-60, -60).
	mapPointer(canvas, "pointermove", -9000, -4000);
	assert.equal(canvas.world.style.transform, "translate(560px, 410px) scale(1)");
	mapPointer(canvas, "pointerup", -9000, -4000);
});

test("the minimap follows the view for every kind of pan, a resize and a change of boards", async () => {
	const canvas = await minimapCanvas();
	const view = () => miniBox(miniView(canvas));
	canvas.viewport.dispatch("wheel", { deltaX: 100, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	near(view(), [1.2 + 10, 1.2, 100, 70]);
	canvas.viewport.rect = { left: 0, top: 50, width: 500, height: 700 };
	canvas.windowEvent("resize");
	near(view(), [11.2, 1.2, 50, 70]);
	// A third artboard widens the world to 2400: everything is redrawn at 0.08.
	// A new manifest object: WIDE_SECOND is shared by every test in this file.
	const manifest = canvas.replies["/t/api/designs/alpha"] as { artboards: unknown[] };
	canvas.replies["/t/api/designs/alpha"] = { ...manifest, artboards: [...manifest.artboards, { file: "03-c.html", title: "Third", tradeoff: "", width: 400, height: 300 }] };
	await canvas.serverEvent("show", { slug: "alpha" });
	assert.equal(miniBlocks(canvas).length, 4);
	near(miniBox(miniBlocks(canvas)[3]), [166, 14.4, 32, 24]);
	assert.match(miniMap(canvas).getAttribute("aria-label")!, /among 3 artboards\./);
});

test("a ResizeObserver on the viewport measures it again for the minimap", async () => {
	const observers: Array<() => void> = [];
	class FakeResizeObserver {
		constructor(callback: () => void) { observers.push(callback); }
		observe() {}
	}
	const canvas = await minimapCanvas({}, { ResizeObserver: FakeResizeObserver });
	near(miniBox(miniView(canvas)), [1.2, 1.2, 100, 70]);
	canvas.viewport.rect = { left: 0, top: 50, width: 500, height: 700 };
	for (const callback of observers) callback();
	near(miniBox(miniView(canvas)), [1.2, 1.2, 50, 70]);
});

// ---- showing and hiding it

test("M shows and hides the minimap with the other single keys' rules", async () => {
	const canvas = await minimapCanvas();
	assert.equal(press(canvas, "m").defaultPrevented, true);
	assert.equal(miniPanel(canvas).hidden, true);
	press(canvas, "M");
	assert.equal(miniPanel(canvas).hidden, false, "case does not matter");
	press(canvas, "m");
	assert.equal(miniPanel(canvas).hidden, true);
	press(canvas, "m");
	assert.equal(miniPanel(canvas).hidden, false);
	// A view change while it was hidden shows when it comes back.
	press(canvas, "m");
	canvas.viewport.dispatch("keydown", { key: "+" });
	press(canvas, "m");
	near(miniBox(miniView(canvas)), [11.2, 8.2, 80, 56]);
});

test("M is ignored while typing, with a chord, with the comment box, a menu or the shortcuts open, and in focus mode", async () => {
	const canvas = await minimapCanvas();
	for (const tag of ["input", "textarea", "select"]) press(canvas, "m", {}, canvas.document.createElement(tag));
	for (const chord of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) press(canvas, "m", chord);
	assert.equal(miniPanel(canvas).hidden, false, "typing and browser chords never toggle it");
	canvas.document.getElementById("gd-popover").hidden = false;
	press(canvas, "m");
	canvas.document.getElementById("gd-popover").hidden = true;
	canvas.document.getElementById("gd-rail-settings").dispatch("click");
	press(canvas, "m");
	canvas.document.getElementById("gd-rail-settings").dispatch("click");
	canvas.document.getElementById("gd-shortcuts").setAttribute("open", "");
	press(canvas, "m");
	canvas.document.getElementById("gd-shortcuts").removeAttribute("open");
	assert.equal(miniPanel(canvas).hidden, false, "the open comment box, menu and shortcuts list leave it alone");

	click(canvas.boards[1].shield!, 200, 200);
	const event = press(canvas, "m");
	assert.equal(event.defaultPrevented, false, "the focused artboard owns the keyboard");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(miniPanel(canvas).hidden, false, "M in focus mode did not switch it off behind the scenes");
});

test("the minimap is hidden in focus mode and comes back, as it was, on Back to canvas", async () => {
	const canvas = await minimapCanvas();
	click(canvas.boards[1].shield!, 200, 200);
	assert.equal(miniPanel(canvas).hidden, true);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(miniPanel(canvas).hidden, false);
	near(miniBox(miniView(canvas)), [1.2, 1.2, 100, 70]);
	press(canvas, "m");
	click(canvas.boards[1].shield!, 200, 200);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(miniPanel(canvas).hidden, true, "a minimap switched off with M stays off after focus");
});

test("the minimap is hidden while Compare is open and returns when it closes", async () => {
	const canvas = await minimapCanvas({ "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:5173/login" } }) });
	assert.equal(miniPanel(canvas).hidden, false);
	withClass(canvas.world.children[1], "gd-compare-start")[0].dispatch("click");
	assert.equal(canvas.document.getElementById("gd-compare").hidden, false);
	assert.equal(miniPanel(canvas).hidden, true);
	canvas.document.getElementById("gd-compare-back").dispatch("click");
	assert.equal(miniPanel(canvas).hidden, false);
});

test("the minimap is hidden when there is nothing to show", async () => {
	const canvas = await loadMinimap({ "/t/api/designs": { designs: [] } }, {}, { slug: null });
	assert.equal(miniPanel(canvas).hidden, true);
});

// ---- accessibility, markup, shortcut and styles

test("the map carries an accessible name with the artboard count, and nothing in it takes the keyboard", async () => {
	const canvas = await minimapCanvas();
	assert.equal(miniMap(canvas).getAttribute("aria-label"), "Position of the visible area among 2 artboards. Click or drag to move the view.");
	for (const block of miniBlocks(canvas)) {
		assert.equal(block.getAttribute("tabindex"), null);
		assert.notEqual(block.localName, "button");
		assert.equal(block.getAttribute("role"), null);
		assert.equal(block.getAttribute("aria-hidden"), "true");
	}
	assert.equal(miniView(canvas).getAttribute("tabindex"), null);
	assert.equal(withClass(canvas.world, "gd-minimap-block").length, 0, "blocks live in the minimap, not in the world");
});

test("the map's name says 1 artboard in the singular", async () => {
	const canvas = await loadMinimap({ "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: 300 }] } });
	assert.equal(miniMap(canvas).getAttribute("aria-label"), "Position of the visible area among 1 artboard. Click or drag to move the view.");
});

test("the shortcuts list has a row for M, and a changed key shows in the minimap's title and toggles it", async () => {
	const canvas = await minimapCanvas();
	const row = withClass(canvas.document.getElementById("gd-keys-custom"), "gd-key-row").find((entry) => entry.dataset.shortcut === "minimap")!;
	assert.deepEqual([texts(row, "gd-key-current")[0], texts(row, "gd-key-action")[0]], ["M", "Show or hide the minimap"]);
	assert.equal(canvas.document.getElementById("gd-minimap-key").textContent, "M");

	const storage = memoryStorage({ "gentle-design:shortcuts": JSON.stringify({ minimap: "n" }) });
	const custom = await minimapCanvas({}, { localStorage: storage.localStorage });
	assert.equal(custom.document.getElementById("gd-minimap-key").textContent, "N");
	assert.equal(press(custom, "m").defaultPrevented, false, "the old key is free");
	assert.equal(miniPanel(custom).hidden, false);
	press(custom, "n");
	assert.equal(miniPanel(custom).hidden, true);
});

test("index.html carries the minimap inside the viewport, hidden until there are boards", () => {
	const html = read("index.html");
	const section = html.match(/<section id="gd-minimap"[^>]*>[^]*?<\/section>/)![0];
	assert.match(section, /^<section id="gd-minimap" class="gd-minimap" aria-labelledby="gd-minimap-title" hidden>/);
	assert.match(section, /<h2 id="gd-minimap-title" class="gd-minimap-title"><span>Minimap<\/span><kbd id="gd-minimap-key" aria-hidden="true">M<\/kbd><\/h2>/);
	assert.match(section, /<div id="gd-minimap-map" class="gd-minimap-map" role="img" aria-label="[^"]+">/);
	assert.match(section, /<b id="gd-minimap-view" class="gd-minimap-view"><\/b>/);
	assert.ok(!/tabindex|<button|data-i18n/.test(section), "nothing in the minimap takes the keyboard, and its words are English literals");
	const viewport = html.slice(html.indexOf('<main id="gd-viewport"'), html.indexOf("</main>"));
	assert.ok(viewport.includes('id="gd-minimap"'), "the minimap is inside the viewport");
});

test("canvas.css styles the minimap with tokens only, at the viewport's bottom right, with no motion and no dots", () => {
	const css = read("canvas.css");
	const block = (selector: string) => {
		const start = css.indexOf(`\n${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start) + 1);
	};
	for (const selector of [".gd-minimap", ".gd-minimap-title", ".gd-minimap-map", ".gd-minimap-block", ".gd-minimap-system", ".gd-minimap-chosen", ".gd-minimap-view"]) {
		const text = block(selector);
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(text), `${selector}: tokens only`);
		assert.ok(!/transition|animation/.test(text), `${selector}: no motion`);
		assert.ok(!/border-radius:\s*50%/.test(text), `${selector}: no dots`);
	}
	assert.match(block(".gd-minimap"), /position:\s*absolute[^}]*right:\s*16px[^}]*bottom:\s*16px/);
	assert.match(block(".gd-minimap"), /background:\s*var\(--gd-panel\)/);
	assert.match(block(".gd-minimap-map"), /width:\s*204px[^}]*height:\s*96px/);
	assert.match(block(".gd-minimap-map"), /overflow:\s*hidden/);
	assert.match(block(".gd-minimap-map"), /touch-action:\s*none/);
	assert.match(block(".gd-minimap-chosen"), /var\(--gd-accent\)/);
	assert.match(block(".gd-minimap-view"), /var\(--gd-focus\)/);
	assert.match(block(".gd-minimap-view"), /pointer-events:\s*none/);
	assert.doesNotMatch(css, /gd-minimap-discarded|gd-minimap-placeholder/, "no discarded or placeholder styling");
});
