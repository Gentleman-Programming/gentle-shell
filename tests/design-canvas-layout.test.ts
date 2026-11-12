import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DESIGN_CANVAS_ASSETS } from "../lib/design-canvas-assets.ts";
import { click, flush, handoffDoc, loadCanvas, read, setHandoffs, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// Where the artboards sit (canvas-layout.js): design/<slug>/layout.json through the
// api/designs/<slug>/layout routes, Row / Column / Grid (Free once moved by hand),
// moving an artboard by dragging any part of it in Move mode, the selected artboard,
// Space + drag to pan, and focus mode centering a moved artboard.

const LAYOUT_URL = "/t/api/designs/alpha/layout";
const NO_LAYOUT = { [LAYOUT_URL]: { layout: null } };
const SYSTEM_REPLY = { "/t/api/system": { exists: true, file: "system.html", width: 800, height: 600 } };
const ARRANGE_IDS = ["gd-arrange-row", "gd-arrange-column", "gd-arrange-grid"];
const NAVIGATING = "Navigating";

async function loadLayout(replies: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
	const canvas = await loadCanvas(300, replies, config);
	// The fake DOM starts every element visible; index.html starts these hidden.
	canvas.document.getElementById("gd-popover").hidden = true;
	canvas.document.getElementById("gd-menu").hidden = true;
	return canvas;
}
type Canvas = Awaited<ReturnType<typeof loadLayout>>;

/** Where a world child sits, as the canvas wrote it: [left, top]. */
const placed = (wrapper: FakeElement) => [wrapper.style.left, wrapper.style.top];
const worldBox = (canvas: Canvas) => [canvas.world.style.width, canvas.world.style.height];
const pressedArrangements = (canvas: Canvas) => ARRANGE_IDS.map((id) => canvas.document.getElementById(id).getAttribute("aria-pressed"));
const layoutPosts = (canvas: Canvas) => canvas.posts.filter((post) => post.url === LAYOUT_URL);
/** The title in an artboard's label header. */
const boardTitle = (wrapper: FakeElement) => withClass(wrapper, "gd-artboard-title")[0];
const implementButton = (wrapper: FakeElement) => withClass(wrapper, "gd-implement-start")[0];
const translation = (canvas: Canvas) => /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(canvas.world.style.transform)!.slice(1).map(Number);
/** Indexes of the selected world children; never the fake elements, which node:assert would walk whole on a failure. */
const selectedBoards = (canvas: Canvas) => canvas.world.children.flatMap((wrapper, index) => (wrapper.classes.has("gd-selected") ? [index] : []));

/** A press on `target`, moves through `path`, and a release (or a cancel) at the last point. */
async function dragFrom(target: FakeElement, from: [number, number], path: Array<[number, number]>, end = "pointerup") {
	target.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: from[0], clientY: from[1] });
	for (const [x, y] of path) target.dispatch("pointermove", { pointerId: 3, clientX: x, clientY: y });
	const [x, y] = path.length > 0 ? path[path.length - 1] : from;
	target.dispatch(end, { button: 0, pointerId: 3, clientX: x, clientY: y });
	for (let i = 0; i < 5; i++) await flush();
}

/** A key event on `target` (its listeners, then its ancestors'), then on the document's listeners, like the browser. */
function keyAt(canvas: Canvas, type: "keydown" | "keyup", key: string, target: FakeElement = canvas.document.body, init: Record<string, unknown> = {}) {
	const event = target.dispatch(type, { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...init });
	for (const listener of canvas.document.listeners.get(type) ?? []) listener(event);
	return event;
}

// ---- where the boards sit (S3)

test("without layout.json the artboards sit in a row, 80 px apart and top-aligned, the system board first", async () => {
	const canvas = await loadLayout(SYSTEM_REPLY);
	assert.ok(canvas.fetched.includes(LAYOUT_URL), "the canvas asks for the saved layout");
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["880px", "0px"], ["1360px", "0px"]]);
	assert.deepEqual(worldBox(canvas), ["1760px", "600px"], "the world is as big as the boards' bounds");
	assert.deepEqual(pressedArrangements(canvas), ["true", "false", "false"], "Row is the arrangement");
	assert.deepEqual(canvas.posts, [], "opening a design saves nothing");
});

test("a saved layout is restored; an artboard it does not know goes after the others and one the design lost drops out of the next save", async () => {
	const saved = { arrangement: "free", positions: { "01-a.html": { x: 0, y: 500 }, "02-b.html": { x: 600, y: 0 }, "gone.html": { x: 5000, y: 5000 } } };
	const manifest = { slug: "alpha", title: "Alpha", brief: "", artboards: [
		{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: 300 },
		{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 },
		{ file: "03-c.html", title: "Third", tradeoff: "", width: 400, height: 300 },
	] };
	const canvas = await loadLayout({ [LAYOUT_URL]: { layout: saved }, "/t/api/designs/alpha": manifest });
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "500px"], ["600px", "0px"], ["1080px", "0px"]]);
	assert.deepEqual(worldBox(canvas), ["1480px", "800px"]);
	assert.deepEqual(pressedArrangements(canvas), ["false", "false", "false"], "a hand-made layout is none of the arrangements");
	assert.deepEqual(canvas.posts, [], "restoring saves nothing");
	await dragFrom(boardTitle(canvas.world.children[2]), [800, 100], [[800, 140]]);
	assert.deepEqual(layoutPosts(canvas), [{ url: LAYOUT_URL, body: { arrangement: "free", positions: { "01-a.html": { x: 0, y: 500 }, "02-b.html": { x: 600, y: 0 }, "03-c.html": { x: 1080, y: 40 } } } }]);
});

test("a design whose layout cannot be read opens in the row", async () => {
	for (const reply of [{ __http: 500 }, { __throw: "offline" }, { layout: { arrangement: "diagonal", positions: {} } }, { layout: { arrangement: "free", positions: { "01-a.html": { x: "far", y: 0 } } } }, { layout: "row" }]) {
		const canvas = await loadLayout({ [LAYOUT_URL]: reply });
		assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], JSON.stringify(reply));
		assert.deepEqual(pressedArrangements(canvas), ["true", "false", "false"]);
	}
});

test("a layout.json change from another page moves the artboards without reloading any; the page's own save changes nothing", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const frames = canvas.frames();
	const sources = frames.map((frame) => frame.src);
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	const own = layoutPosts(canvas)[0].body;
	canvas.replies[LAYOUT_URL] = { layout: own };
	await canvas.serverEvent("change", { slug: "alpha", file: "layout.json" });
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "0px"]]);
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "column", positions: {} } };
	await canvas.serverEvent("change", { slug: "alpha", file: "layout.json" });
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "a column, as the other page chose");
	assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"]);
	assert.ok(canvas.frames().every((frame, index) => frame === frames[index] && frame.src === sources[index]), "no artboard reloads");
	assert.equal(layoutPosts(canvas).length, 1, "and nothing is saved back");
	await canvas.serverEvent("change", { slug: "beta", file: "layout.json" });
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "another design's layout is not this one's");
});

test("a layout that cannot be saved says so in the status line, and the artboard stays where it was put", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: { __http: 400, error: "invalid-layout", reason: "positions may hold at most 100 boards" } });
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	assert.equal(layoutPosts(canvas).length, 1);
	const status = canvas.document.getElementById("gd-status");
	assert.equal(status.textContent, "The layout of alpha could not be saved: positions may hold at most 100 boards");
	assert.ok(status.classes.has("gd-error"));
	assert.deepEqual(placed(canvas.world.children[1]), ["520px", "0px"]);
});

// ---- saves and reads of layout.json in flight

/** A reply the test gives later: a request for it stays in flight until `resolve`. */
function deferred() {
	let resolve!: (reply: unknown) => void;
	const promise = new Promise<unknown>((done) => { resolve = done; });
	return { promise, resolve };
}
const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };
const LAYOUT_CHANGE = { slug: "alpha", file: "layout.json" };

test("layout saves go out one at a time in gesture order: a move made while the previous save is on its way is sent after it", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const firstSave = deferred();
	canvas.replies[LAYOUT_URL] = firstSave.promise;
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	canvas.replies[LAYOUT_URL] = { ok: true };
	await dragFrom(boardTitle(canvas.world.children[0]), [100, 100], [[100, 140]]);
	const first = { arrangement: "free", positions: { "01-a.html": { x: 0, y: 0 }, "02-b.html": { x: 520, y: 0 } } };
	const second = { arrangement: "free", positions: { "01-a.html": { x: 0, y: 40 }, "02-b.html": { x: 520, y: 0 } } };
	assert.deepEqual(layoutPosts(canvas).map((post) => post.body), [first], "the second save waits for the first one's reply");
	firstSave.resolve({ ok: true });
	await settle();
	assert.deepEqual(layoutPosts(canvas).map((post) => post.body), [first, second], "then goes out, so the server writes the newer layout last");
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "40px"], ["520px", "0px"]]);
});

test("a layout.json change from another page while a save is on its way is read once the save is done", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const save = deferred();
	canvas.replies[LAYOUT_URL] = save.promise;
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	// The page's save landed, then another page chose Column; its change comes before this page's reply.
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "column", positions: {} } };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "0px"]], "the page's own move stays while its save is on its way");
	save.resolve({ ok: true });
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "then the other page's column shows");
	assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"]);
	assert.equal(layoutPosts(canvas).length, 1, "and nothing is saved back");
});

test("an older layout read that answers last never replaces a newer one", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const older = deferred();
	canvas.replies[LAYOUT_URL] = older.promise;
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "column", positions: {} } };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "the newer read shows");
	older.resolve({ layout: { arrangement: "row", positions: {} } });
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "the older read that answered last is dropped");
	assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"]);
});

test("a layout read on its way when the page saves never undoes the page's newer move", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const read = deferred();
	canvas.replies[LAYOUT_URL] = read.promise;
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	canvas.replies[LAYOUT_URL] = { ok: true };
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	assert.equal(layoutPosts(canvas).length, 1, "the move is saved");
	read.resolve({ layout: { arrangement: "column", positions: {} } });
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "0px"]], "the read from before the save is dropped");
	assert.deepEqual(pressedArrangements(canvas), ["false", "false", "false"]);
});

test("a layout.json change that comes during a press on an artboard shows once the press ends without a move", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const title = boardTitle(canvas.world.children[1]);
	// A still press: the change waits for the release, then shows.
	title.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 500, clientY: 100 });
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "column", positions: {} } };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], "nothing moves under the press");
	title.dispatch("pointerup", { button: 0, pointerId: 3, clientX: 500, clientY: 100 });
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "the other page's column shows after the release");
	// A cancelled move: the artboard goes back, then the change shows.
	title.dispatch("pointerdown", { button: 0, pointerId: 4, clientX: 100, clientY: 400 });
	title.dispatch("pointermove", { pointerId: 4, clientX: 160, clientY: 400 });
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "row", positions: {} } };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(placed(canvas.world.children[1]), ["60px", "380px"], "the moved artboard stays under the pointer");
	title.dispatch("pointercancel", { button: 0, pointerId: 4, clientX: 160, clientY: 400 });
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], "the row shows after the cancel");
	assert.deepEqual(pressedArrangements(canvas), ["true", "false", "false"]);
	assert.deepEqual(canvas.posts, [], "and nothing is saved");
});

test("a layout.json change from another page that comes while an artboard is dragged shows once the drag is cancelled", async () => {
	// Page A sits in a row; page B chooses Column while A drags an artboard; A's drag is then cancelled.
	const canvas = await loadLayout(NO_LAYOUT);
	const title = boardTitle(canvas.world.children[1]);
	title.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 500, clientY: 100 });
	title.dispatch("pointermove", { pointerId: 3, clientX: 560, clientY: 100 });
	assert.deepEqual(placed(canvas.world.children[1]), ["540px", "0px"], "the artboard follows the drag");
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "column", positions: {} } };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(placed(canvas.world.children[1]), ["540px", "0px"], "nothing moves under the drag");
	title.dispatch("pointercancel", { button: 0, pointerId: 3, clientX: 560, clientY: 100 });
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "B's column shows after the cancel");
	assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"]);
	assert.deepEqual(canvas.posts, [], "and the cancelled drag saves nothing");
});

test("an arrangement whose save failed stays until another page changes layout.json: the page's own earlier save, notified late, never replaces it", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const status = canvas.document.getElementById("gd-status");
	const arrange = async (id: string) => {
		canvas.document.getElementById(id).dispatch("click");
		await settle();
	};
	// Grid is saved; Column's save is rejected.
	canvas.replies[LAYOUT_URL] = { ok: true };
	await arrange("gd-arrange-grid");
	const grid = layoutPosts(canvas)[0].body;
	canvas.replies[LAYOUT_URL] = { __http: 400, error: "invalid-layout", reason: "disk full" };
	await arrange("gd-arrange-column");
	assert.equal(layoutPosts(canvas).length, 2);
	assert.equal(status.textContent, "The layout of alpha could not be saved: disk full");
	// The file event of the Grid save comes late: layout.json still holds the page's own Grid.
	canvas.replies[LAYOUT_URL] = { layout: grid };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "the unsaved column stays");
	assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"]);
	assert.equal(status.textContent, "The layout of alpha could not be saved: disk full", "and the error still names it");
	assert.ok(status.classes.has("gd-error"));
	// A design.json reload reads the same Grid: still no news.
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "a reload keeps the unsaved column too");
	assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"]);
	// Another page writes Row: the file now holds something this page never saved, so it shows.
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "row", positions: {} } };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], "the other page's row wins");
	assert.deepEqual(pressedArrangements(canvas), ["true", "false", "false"]);
	assert.equal(layoutPosts(canvas).length, 2, "and nothing is saved back");
});

test("a design.json reload whose layout read answers after the page's newer save is done never undoes the page's move", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const read = deferred();
	canvas.replies[LAYOUT_URL] = read.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	canvas.replies[LAYOUT_URL] = { ok: true };
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	assert.equal(layoutPosts(canvas).length, 1, "the move is saved, and its save is done");
	read.resolve({ layout: null });
	await settle();
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "0px"]], "the reload's older read is dropped");
	assert.deepEqual(pressedArrangements(canvas), ["false", "false", "false"]);
	assert.equal(layoutPosts(canvas).length, 1);
});

test("a design.json reload whose layout read answers while the page's save is still on its way keeps the page's move", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const save = deferred();
	canvas.replies[LAYOUT_URL] = save.promise;
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	canvas.replies[LAYOUT_URL] = { layout: null };
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "0px"]], "the file read before the save landed is older than the move");
	save.resolve({ ok: true });
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "0px"]]);
	assert.equal(layoutPosts(canvas).length, 1);
});

test("a layout read that fails keeps the layout shown: a design.json reload after a failed save keeps the unsaved column and saves nothing", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: { layout: { arrangement: "grid", positions: {} } } });
	canvas.replies[LAYOUT_URL] = { __http: 400, error: "invalid-layout", reason: "disk full" };
	canvas.document.getElementById("gd-arrange-column").dispatch("click");
	await settle();
	assert.equal(layoutPosts(canvas).length, 1, "Column's save is rejected");
	for (const reply of [{ __http: 500 }, { __throw: "offline" }]) {
		canvas.replies[LAYOUT_URL] = reply;
		await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
		await settle();
		assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], `the unsaved column stays (${JSON.stringify(reply)})`);
		assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"]);
	}
	assert.equal(layoutPosts(canvas).length, 1, "and nothing is saved");
});

test("a layout.json change whose read fails keeps the layout shown instead of falling back to the row", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: { layout: { arrangement: "column", positions: {} } } });
	for (const reply of [{ __http: 500 }, { __throw: "offline" }]) {
		canvas.replies[LAYOUT_URL] = reply;
		await canvas.serverEvent("change", LAYOUT_CHANGE);
		assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], JSON.stringify(reply));
		assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"]);
	}
	// The next read that answers still shows another page's change.
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "row", positions: {} } };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]]);
	assert.deepEqual(canvas.posts, [], "nothing is saved");
});

test("a design.json reload of an unchanged layout with negative positions leaves the view where it is", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: { layout: { arrangement: "free", positions: { "01-a.html": { x: -200, y: -100 }, "02-b.html": { x: 480, y: 0 } } } } });
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["680px", "100px"]]);
	const view = translation(canvas);
	for (let reload = 1; reload <= 2; reload++) {
		await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
		await settle();
		assert.deepEqual(translation(canvas), view, `reload ${reload} keeps the view`);
		assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["680px", "100px"]]);
	}
	assert.deepEqual(canvas.posts, []);
});

test("a layout.json change of the next design that comes before its design.json never moves or saves the boards still shown", async () => {
	const BETA_LAYOUT = "/t/api/designs/beta/layout";
	const canvas = await loadLayout(NO_LAYOUT);
	const betaManifest = deferred();
	const beta = canvas.replies["/t/api/designs/beta"];
	canvas.replies["/t/api/designs/beta"] = betaManifest.promise;
	canvas.replies[BETA_LAYOUT] = { layout: { arrangement: "column", positions: {} } };
	const select = canvas.document.getElementById("gd-design");
	select.value = "beta";
	select.dispatch("change");
	await canvas.serverEvent("change", { slug: "beta", file: "layout.json" });
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], "alpha's boards keep alpha's row");
	assert.deepEqual(pressedArrangements(canvas), ["true", "false", "false"]);
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	assert.deepEqual(canvas.posts.filter((post) => post.url === BETA_LAYOUT), [], "alpha's boards are never written to beta's layout.json");
	betaManifest.resolve(beta);
	await settle();
	assert.equal(canvas.world.children.length, 1, "beta's board shows");
	assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"], "in beta's column");
	assert.deepEqual(canvas.posts.filter((post) => post.url === BETA_LAYOUT), []);
});

test("a save that lands after the page left the design and came back shows once its layout.json change comes", async () => {
	const grid = { arrangement: "grid", positions: {} };
	const canvas = await loadLayout({ [LAYOUT_URL]: { layout: grid } });
	const select = canvas.document.getElementById("gd-design");
	const open = async (slug: string) => {
		select.value = slug;
		select.dispatch("change");
		await settle();
	};
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], "alpha opens in its grid");
	// Column's save stays on its way while the page goes to beta and back; alpha's layout.json still holds the grid.
	const save = deferred();
	canvas.replies[LAYOUT_URL] = save.promise;
	canvas.document.getElementById("gd-arrange-column").dispatch("click");
	await settle();
	assert.deepEqual(layoutPosts(canvas).map((post) => (post.body as { arrangement: string }).arrangement), ["column"]);
	const column = layoutPosts(canvas)[0].body;
	canvas.replies[LAYOUT_URL] = { layout: grid };
	await open("beta");
	assert.equal(canvas.world.children.length, 1, "beta's board shows");
	await open("alpha");
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], "back in alpha, the file's grid shows");
	assert.deepEqual(pressedArrangements(canvas), ["false", "false", "true"]);
	// The server takes the column, then its layout.json change comes.
	save.resolve({ ok: true });
	await settle();
	canvas.replies[LAYOUT_URL] = { layout: column };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "the column the server took shows");
	assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"]);
	assert.equal(layoutPosts(canvas).length, 1, "and nothing is saved back");
});

test("a second pointer pressed during a move never takes the move over: the moved artboard is saved on its own release", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	canvas.replies[LAYOUT_URL] = { ok: true };
	const wrapper = canvas.world.children[1];
	const title = boardTitle(wrapper);
	title.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 500, clientY: 100 });
	title.dispatch("pointermove", { pointerId: 3, clientX: 560, clientY: 100 });
	canvas.viewport.dispatch("pointerdown", { button: 0, pointerId: 4, clientX: 900, clientY: 600 });
	canvas.viewport.dispatch("pointerup", { button: 0, pointerId: 4, clientX: 900, clientY: 600 });
	title.dispatch("pointerup", { button: 0, pointerId: 3, clientX: 560, clientY: 100 });
	await settle();
	assert.deepEqual(layoutPosts(canvas).map((post) => post.body), [{ arrangement: "free", positions: { "01-a.html": { x: 0, y: 0 }, "02-b.html": { x: 540, y: 0 } } }]);
	assert.equal(wrapper.classes.has("gd-lifted"), false, "the artboard is put down");
	assert.deepEqual(selectedBoards(canvas), [1], "the second press changes no selection");
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "column", positions: {} } };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "a later layout.json change shows");
});

test("a save that succeeds after a failed one clears the save error, never another status", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const status = canvas.document.getElementById("gd-status");
	canvas.replies[LAYOUT_URL] = { __http: 400, error: "invalid-layout", reason: "disk full" };
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	assert.equal(status.textContent, "The layout of alpha could not be saved: disk full");
	canvas.replies[LAYOUT_URL] = { ok: true };
	await dragFrom(boardTitle(canvas.world.children[1]), [540, 100], [[560, 100]]);
	assert.equal(layoutPosts(canvas).length, 2);
	assert.equal(status.textContent, "", "the retry's success clears the error");
	assert.equal(status.classes.has("gd-error"), false);
	// Another status shown after the failure stays.
	canvas.replies[LAYOUT_URL] = { __http: 400, error: "invalid-layout", reason: "disk full" };
	await dragFrom(boardTitle(canvas.world.children[1]), [560, 100], [[580, 100]]);
	await canvas.serverEvent("error", {});
	canvas.replies[LAYOUT_URL] = { ok: true };
	await dragFrom(boardTitle(canvas.world.children[1]), [580, 100], [[600, 100]]);
	assert.equal(layoutPosts(canvas).length, 4);
	assert.equal(status.textContent, "Live reload disconnected, retrying…");
	assert.ok(status.classes.has("gd-error"));
});

// ---- moving an artboard (S1, S9) in Move mode

test("dragging an artboard's title moves it in world px at any zoom and saves it once, on release, as a free layout", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const [first, second] = canvas.world.children;
	canvas.document.getElementById("gd-zoom-out").dispatch("click");
	assert.equal(canvas.zoomLevel.textContent, "80%");
	const view = canvas.world.style.transform;
	// Within the 4 px click slop nothing moves; then 80 x 40 screen px at 80% are 100 x 50 world px.
	boardTitle(second).dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 500, clientY: 300 });
	assert.ok(canvas.viewport.classes.has("gd-moving"), "the grabbing cursor of a move");
	boardTitle(second).dispatch("pointermove", { pointerId: 3, clientX: 503, clientY: 302 });
	assert.deepEqual(placed(second), ["480px", "0px"], "a still press does not move");
	boardTitle(second).dispatch("pointermove", { pointerId: 3, clientX: 580, clientY: 340 });
	assert.deepEqual(placed(second), ["580px", "50px"]);
	assert.ok(second.classes.has("gd-lifted"), "the moved artboard is lifted above the others");
	assert.equal(layoutPosts(canvas).length, 0, "nothing is saved while it moves");
	boardTitle(second).dispatch("pointerup", { button: 0, pointerId: 3, clientX: 580, clientY: 340 });
	for (let i = 0; i < 5; i++) await flush();
	assert.ok(!canvas.viewport.classes.has("gd-moving"));
	assert.ok(!second.classes.has("gd-lifted"));
	assert.equal(canvas.world.style.transform, view, "moving an artboard never pans");
	assert.equal(canvas.navMode.textContent, NAVIGATING, "nor opens it");
	assert.deepEqual(canvas.posts, [{ url: LAYOUT_URL, body: { arrangement: "free", positions: { "01-a.html": { x: 0, y: 0 }, "02-b.html": { x: 580, y: 50 } } } }]);
	assert.deepEqual(pressedArrangements(canvas), ["false", "false", "false"], "a hand-made layout is none of the arrangements");
	assert.deepEqual(worldBox(canvas), ["980px", "350px"]);
	assert.deepEqual(placed(first), ["0px", "0px"], "the other artboard stays");

	// Left of everything: the boards keep their place on screen and the world's top left stays the bounds' top left.
	const [x, y] = translation(canvas);
	await dragFrom(boardTitle(first), [100, 100], [[-100, 100]]);
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["830px", "50px"]]);
	assert.equal(canvas.world.style.transform, `translate(${x - 200}px, ${y}px) scale(0.8)`);
	assert.deepEqual(layoutPosts(canvas).at(-1)!.body, { arrangement: "free", positions: { "01-a.html": { x: 0, y: 0 }, "02-b.html": { x: 830, y: 50 } } });
	assert.equal(layoutPosts(canvas).length, 2, "one save per move");
});

test("a still click on a title moves nothing, and a cancelled move puts the artboard back unsaved", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const second = canvas.world.children[1];
	click(boardTitle(second), 500, 300);
	await dragFrom(boardTitle(second), [500, 300], [[600, 400]], "pointercancel");
	assert.deepEqual(placed(second), ["480px", "0px"]);
	assert.ok(!second.classes.has("gd-lifted"), "and lays it down");
	assert.deepEqual(canvas.posts, []);
	assert.equal(canvas.navMode.textContent, NAVIGATING);
});

const moveTargets: Array<[string, (canvas: Canvas) => FakeElement]> = [
	["artboard gap", (canvas) => canvas.boards[0].wrapper],
	["frame box", (canvas) => canvas.boards[0].frame.parentElement!],
	["artboard title", (canvas) => boardTitle(canvas.boards[0].wrapper)],
	["actions gap", (canvas) => withClass(canvas.boards[0].wrapper, "gd-board-actions")[0]],
	["shield", (canvas) => canvas.boards[0].shield!],
];

for (const [name, targetOf] of moveTargets) {
	test(`a drag on the ${name} moves the artboard in Move mode, without panning or selecting text`, async () => {
		const canvas = await loadLayout(NO_LAYOUT);
		const [board, other] = canvas.boards;
		const view = canvas.world.style.transform;
		const down = targetOf(canvas).dispatch("pointerdown", { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
		canvas.viewport.dispatch("pointermove", { pointerId: 7, clientX: 45, clientY: 30 });
		assert.equal(down.defaultPrevented, true, "the press suppresses the pointer default");
		assert.deepEqual(canvas.viewport.capturedPointers, [7]);
		assert.equal(canvas.viewport.classes.has("gd-moving"), true);
		assert.equal(canvas.viewport.classes.has("gd-panning"), false);
		canvas.viewport.dispatch("pointerup", { button: 0, pointerId: 7, clientX: 45, clientY: 30 });
		assert.deepEqual(placed(board.wrapper), ["35px", "20px"], "the artboard followed the pointer");
		assert.deepEqual(placed(other.wrapper), ["480px", "0px"]);
		assert.equal(canvas.world.style.transform, view, "the canvas did not pan");
		assert.equal(canvas.viewport.classes.has("gd-moving"), false);
		assert.equal(canvas.navMode.textContent, NAVIGATING, "a drag does not focus a shield");
	});
}

test("in Move mode the empty canvas still pans, a still click on the body still opens it, header buttons keep their default, and focus mode moves nothing", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const [first, second] = canvas.boards;
	const before = canvas.world.style.transform;
	await dragFrom(second.shield!, [550, 150], [[590, 170]]);
	assert.equal(canvas.world.style.transform, before, "the body moves its artboard instead of panning");
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "20px"]]);
	assert.equal(layoutPosts(canvas).length, 1);
	await dragFrom(canvas.world, [700, 600], [[650, 560]]);
	assert.notEqual(canvas.world.style.transform, before, "the empty canvas pans");
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "20px"]], "and no artboard moved");
	const implement = implementButton(second.wrapper);
	const press = implement.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 700, clientY: 120 });
	assert.equal(press.defaultPrevented, false, "a header button keeps its press");
	implement.dispatch("pointermove", { pointerId: 3, clientX: 800, clientY: 200 });
	implement.dispatch("pointerup", { button: 0, pointerId: 3, clientX: 800, clientY: 200 });
	assert.deepEqual(placed(second.wrapper), ["520px", "20px"], "a press on a header button does not move the artboard");
	click(second.shield!, 600, 200);
	assert.match(canvas.navMode.textContent, /^Using: Second/, "a still click on the body opens it");
	assert.equal(canvas.document.getElementById("gd-arrange-grid").disabled, true, "no arrangement while an artboard is in use");
	await dragFrom(boardTitle(second.wrapper), [500, 60], [[600, 160]]);
	await dragFrom(first.shield!, [100, 160], [[200, 260]]);
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "20px"]], "focus mode moves nothing");
	assert.equal(layoutPosts(canvas).length, 1);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(canvas.document.getElementById("gd-arrange-grid").disabled, false);
});

test("Comment mode keeps main's pick routing: a press on an artboard pans instead of moving it, and a still click picks an element", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const [first] = canvas.boards;
	canvas.document.getElementById("gd-comment").dispatch("click");
	const [x, y] = translation(canvas);
	await dragFrom(first.shield!, [150, 150], [[190, 170]]);
	await dragFrom(boardTitle(first.wrapper), [150, 20], [[160, 20]]);
	assert.deepEqual(translation(canvas), [x + 50, y + 20], "the frame and the title pan");
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], "and no artboard moves");
	assert.deepEqual(selectedBoards(canvas), [], "nor is selected");
	assert.deepEqual(canvas.posts, []);
	first.frame.rect = { left: 100, top: 100, width: 200, height: 150 };
	click(first.shield!, 150, 130);
	assert.equal(canvas.navMode.textContent, NAVIGATING, "comment mode picks instead of focusing");
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:pick-at", x: 100, y: 60 });
});

// ---- Space + drag pans (S9)

test("holding Space pans from anywhere, over an artboard too, with a grab cursor, and never scrolls the page", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const [, second] = canvas.boards;
	const [x, y] = translation(canvas);
	assert.equal(keyAt(canvas, "keydown", " ").defaultPrevented, true, "Space does not scroll the page");
	assert.ok(canvas.viewport.classes.has("gd-space-pan"), "a grab cursor while it is held");
	assert.equal(keyAt(canvas, "keydown", " ", undefined, { repeat: true }).defaultPrevented, true, "nor does its auto-repeat");
	await dragFrom(second.shield!, [500, 300], [[540, 320]]);
	await dragFrom(boardTitle(second.wrapper), [500, 60], [[520, 60]]);
	assert.deepEqual(translation(canvas), [x + 60, y + 20], "the frame and the title pan");
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], "and no artboard moves");
	click(second.shield!, 500, 300);
	assert.equal(canvas.navMode.textContent, NAVIGATING, "a still press with Space opens nothing");
	assert.deepEqual(selectedBoards(canvas), [], "nor selects");
	assert.deepEqual(canvas.posts, []);
	keyAt(canvas, "keyup", " ");
	assert.ok(!canvas.viewport.classes.has("gd-space-pan"));
	await dragFrom(second.shield!, [500, 300], [[540, 320]]);
	assert.deepEqual(placed(second.wrapper), ["520px", "20px"], "without Space a drag moves the artboard again");
	assert.deepEqual(translation(canvas), [x + 60, y + 20]);
	// A window that loses focus never sees the release: Space lets go.
	keyAt(canvas, "keydown", " ");
	canvas.windowEvent("blur");
	assert.ok(!canvas.viewport.classes.has("gd-space-pan"));
	await dragFrom(second.shield!, [500, 300], [[510, 300]]);
	assert.deepEqual(placed(second.wrapper), ["530px", "20px"]);

	const css = read("canvas.css");
	assert.match(css, /\.gd-viewport\.gd-space-pan, \.gd-viewport\.gd-space-pan \* \{ cursor: grab; \}/);
	assert.match(css, /\.gd-viewport\.gd-space-pan\.gd-panning, \.gd-viewport\.gd-space-pan\.gd-panning \* \{ cursor: grabbing; \}/);
});

test("Space stays with fields, buttons, the comment box, a menu, the shortcuts list and an artboard in use; on a shield it still opens it", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const [first] = canvas.boards;
	const editable = canvas.document.createElement("div");
	editable.setAttribute("contenteditable", "true");
	for (const target of [...["input", "textarea", "select", "button", "a"].map((tag) => canvas.document.createElement(tag)), editable]) {
		assert.equal(keyAt(canvas, "keydown", " ", target).defaultPrevented, false, `${target.localName}: Space keeps its default`);
		assert.ok(!canvas.viewport.classes.has("gd-space-pan"), target.localName);
	}
	const popover = canvas.document.getElementById("gd-popover");
	popover.hidden = false;
	assert.equal(keyAt(canvas, "keydown", " ").defaultPrevented, false, "the comment box keeps it");
	popover.hidden = true;
	canvas.document.getElementById("gd-rail-settings").dispatch("click");
	assert.equal(keyAt(canvas, "keydown", " ").defaultPrevented, false, "an open menu keeps it");
	canvas.document.getElementById("gd-rail-settings").dispatch("click");
	canvas.document.getElementById("gd-shortcuts").setAttribute("open", "");
	assert.equal(keyAt(canvas, "keydown", " ").defaultPrevented, false, "the shortcuts list keeps it");
	canvas.document.getElementById("gd-shortcuts").removeAttribute("open");
	assert.ok(!canvas.viewport.classes.has("gd-space-pan"));

	// From the keyboard an artboard's shield is a button: Space opens it, as before.
	assert.equal(keyAt(canvas, "keydown", " ", first.shield!).defaultPrevented, true);
	assert.match(canvas.navMode.textContent, /^Using: First/);
	assert.ok(!canvas.viewport.classes.has("gd-space-pan"), "and starts no pan");
	// Inside an artboard Space belongs to it and to the Back button.
	assert.equal(keyAt(canvas, "keydown", " ").defaultPrevented, false, "focus mode keeps it");
	assert.ok(!canvas.viewport.classes.has("gd-space-pan"));
});

// ---- the selected artboard (S10)

test("pressing an artboard outlines all of it as selected until a press elsewhere or Esc, one at a time; opening it clears it", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const [first, second] = canvas.boards;
	assert.deepEqual(selectedBoards(canvas), []);
	second.shield!.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 500, clientY: 300 });
	assert.deepEqual(selectedBoards(canvas), [1], "on the press, before it moves");
	second.shield!.dispatch("pointermove", { pointerId: 3, clientX: 540, clientY: 320 });
	second.shield!.dispatch("pointerup", { button: 0, pointerId: 3, clientX: 540, clientY: 320 });
	for (let i = 0; i < 5; i++) await flush();
	assert.deepEqual(selectedBoards(canvas), [1], "and after the drop");
	await dragFrom(boardTitle(first.wrapper), [100, 20], []);
	assert.deepEqual(selectedBoards(canvas), [0], "another artboard's title takes it: one at a time");
	await dragFrom(canvas.world, [700, 600], [[650, 560]]);
	assert.deepEqual(selectedBoards(canvas), [], "a press on the background clears it");
	await dragFrom(second.shield!, [500, 300], [[510, 300]]);
	implementButton(second.wrapper).dispatch("pointerdown", { button: 0, pointerId: 4, clientX: 700, clientY: 20 });
	assert.deepEqual(selectedBoards(canvas), [1], "a header button keeps it");
	const shiftEsc = keyAt(canvas, "keydown", "Escape", undefined, { shiftKey: true });
	assert.equal(shiftEsc.defaultPrevented, false);
	assert.deepEqual(selectedBoards(canvas), [1], "Shift+Esc is not for the selection");
	const esc = keyAt(canvas, "keydown", "Escape");
	assert.equal(esc.defaultPrevented, true);
	assert.deepEqual(selectedBoards(canvas), [], "Esc clears it");
	// With an artboard selected in Comment mode, Esc clears the selection first, then leaves Comment mode.
	await dragFrom(second.shield!, [500, 300], [[510, 300]]);
	canvas.document.getElementById("gd-comment").dispatch("click");
	keyAt(canvas, "keydown", "Escape");
	assert.deepEqual(selectedBoards(canvas), []);
	assert.equal(canvas.document.getElementById("gd-comment").getAttribute("aria-pressed"), "true");
	keyAt(canvas, "keydown", "Escape");
	assert.equal(canvas.document.getElementById("gd-comment").getAttribute("aria-pressed"), "false");
	await dragFrom(second.shield!, [500, 300], [[510, 300]]);
	click(first.shield!, 150, 150);
	assert.match(canvas.navMode.textContent, /^Using: First/);
	assert.deepEqual(selectedBoards(canvas), [], "a still click opens it, selected only for the press");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.deepEqual(selectedBoards(canvas), []);

	const css = read("canvas.css");
	const start = css.indexOf("\n.gd-world .gd-selected {");
	assert.ok(start >= 0, "the selected artboard is styled");
	const rule = css.slice(start, css.indexOf("}", start) + 1);
	assert.match(rule, /outline:[^;]*var\(--gd-accent\)/, "an accent outline around the whole artboard");
	assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|transition|animation/.test(rule), "tokens only, and no motion");
});

// ---- Row, Column and Grid (S2)

const MIXED_REPLY = {
	...SYSTEM_REPLY,
	...NO_LAYOUT,
	"/t/api/designs/alpha": {
		slug: "alpha",
		title: "Alpha",
		brief: "",
		artboards: [
			{ file: "01-a.html", title: "A", tradeoff: "", width: 400, height: 300 },
			{ file: "02-b.html", title: "B", tradeoff: "", width: 200, height: 500 },
			{ file: "03-c.html", title: "C", tradeoff: "", width: 300, height: 100 },
			{ file: "04-d.html", title: "D", tradeoff: "", width: 100, height: 200 },
		],
	},
};
const MIXED_KEYS = ["system", "01-a.html", "02-b.html", "03-c.html", "04-d.html"];
const positionsOf = (rows: number[][]) => Object.fromEntries(rows.map(([x, y], index) => [MIXED_KEYS[index], { x, y }]));

test("Row, Column and Grid arrange every artboard with 80 px between them, save the arrangement and fit the view", async () => {
	const canvas = await loadLayout(MIXED_REPLY);
	Object.defineProperty(canvas.world, "offsetWidth", { get: () => Number.parseFloat(canvas.world.style.width) });
	Object.defineProperty(canvas.world, "offsetHeight", { get: () => Number.parseFloat(canvas.world.style.height) });
	const arrange = async (id: string) => {
		canvas.document.getElementById(id).dispatch("click");
		for (let i = 0; i < 5; i++) await flush();
	};
	// Grid: 5 boards in 3 columns as wide as their widest, rows as tall as their tallest.
	await arrange("gd-arrange-grid");
	const grid = [[0, 0], [880, 0], [1360, 0], [0, 680], [880, 680]];
	assert.deepEqual(canvas.world.children.map(placed), grid.map(([x, y]) => [`${x}px`, `${y}px`]));
	assert.deepEqual(worldBox(canvas), ["1560px", "880px"]);
	assert.deepEqual(pressedArrangements(canvas), ["false", "false", "true"]);
	assert.deepEqual(layoutPosts(canvas).at(-1)!.body, { arrangement: "grid", positions: positionsOf(grid) });
	// Column: one above the other, left-aligned.
	await arrange("gd-arrange-column");
	const column = [[0, 0], [0, 680], [0, 1060], [0, 1640], [0, 1820]];
	assert.deepEqual(canvas.world.children.map(placed), column.map(([x, y]) => [`${x}px`, `${y}px`]));
	assert.deepEqual(worldBox(canvas), ["800px", "2020px"]);
	assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"]);
	assert.deepEqual(layoutPosts(canvas).at(-1)!.body, { arrangement: "column", positions: positionsOf(column) });
	// Fit shows the whole column: 604 / 2020 of the 700 px viewport, 48 px from the top.
	assert.equal(canvas.zoomLevel.textContent, "30%");
	assert.match(canvas.world.style.transform, /^translate\([\d.]+px, 48px\) scale\(0\.29900990099/);
	// Row: side by side, top-aligned.
	await arrange("gd-arrange-row");
	const row = [[0, 0], [880, 0], [1360, 0], [1640, 0], [2020, 0]];
	assert.deepEqual(canvas.world.children.map(placed), row.map(([x, y]) => [`${x}px`, `${y}px`]));
	assert.deepEqual(layoutPosts(canvas).at(-1)!.body, { arrangement: "row", positions: positionsOf(row) });
	assert.equal(layoutPosts(canvas).length, 3, "one save per choice");
	// After an arrangement each artboard can still be moved by hand: the layout becomes free and the others stay.
	await arrange("gd-arrange-column");
	await dragFrom(boardTitle(canvas.world.children[2]), [300, 300], [[330, 300]]);
	assert.deepEqual(layoutPosts(canvas).at(-1)!.body, { arrangement: "free", positions: positionsOf([[0, 0], [0, 680], [100, 1060], [0, 1640], [0, 1820]]) });
	assert.deepEqual(pressedArrangements(canvas), ["false", "false", "false"]);
});

test("a handoff that grows the artboard labels after they were placed lays the arrangement out again; a free layout keeps its positions", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: { layout: { arrangement: "column", positions: {} } } });
	// Like the browser: the handoff row in an artboard's header (.gd-has-handoff) pushes its frame box 30 px down.
	for (const board of canvas.boards) Object.defineProperty(board.frame.parentElement!, "offsetTop", { get: () => (board.wrapper.classes.has("gd-has-handoff") ? 50 : 20) });
	await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": {} }));
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "430px"]], "80 px below the grown first artboard");
	assert.deepEqual(worldBox(canvas), ["400px", "780px"]);
	assert.deepEqual(canvas.posts, [], "laid out again, not saved");
	canvas.replies[LAYOUT_URL] = { ok: true };
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 500], [[540, 500]]);
	await setHandoffs(canvas, handoffDoc(null, {}));
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["40px", "430px"]], "a free layout stays where it was put");
	assert.deepEqual(worldBox(canvas), ["440px", "750px"], "and the world follows the smaller labels");
	assert.equal(layoutPosts(canvas).length, 1);
});

test("a handoff that grows the labels while an artboard is in use keeps that artboard where it was on screen", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: { layout: { arrangement: "column", positions: {} } } });
	// Like the browser: an artboard sits at its position and the handoff row pushes its frame box 30 px down.
	for (const board of canvas.boards) {
		Object.defineProperty(board.frame.parentElement!, "offsetTop", { get: () => (board.wrapper.classes.has("gd-has-handoff") ? 50 : 20) });
		Object.defineProperty(board.wrapper, "offsetTop", { get: () => Number.parseFloat(board.wrapper.style.top) });
	}
	const [, second] = canvas.boards;
	const frameTop = () => translation(canvas)[1] + Number.parseFloat(second.wrapper.style.top) + second.frame.parentElement!.offsetTop;
	click(second.shield!, 200, 200);
	assert.match(canvas.navMode.textContent, /^Using: Second/);
	const onScreen = frameTop();
	await setHandoffs(canvas, handoffDoc("01-a.html", { "01-a.html": {} }));
	assert.deepEqual(placed(second.wrapper), ["0px", "430px"], "the column is laid out again below the grown first artboard");
	assert.equal(frameTop(), onScreen, "the artboard in use stays put on screen");
	assert.deepEqual(canvas.posts, []);
});

test("the arrangement buttons are off without a design, in focus mode and in Compare", async () => {
	const empty = await loadLayout({ "/t/api/designs": { designs: [] }, ...SYSTEM_REPLY }, { slug: null });
	assert.ok(ARRANGE_IDS.every((id) => empty.document.getElementById(id).disabled), "the system-only view has nothing to arrange");
	const canvas = await loadLayout({ ...NO_LAYOUT, "/t/api/designs/alpha/handoffs": { version: 1, chosen: "01-a.html", handoffs: { "01-a.html": { status: "implemented", queued: false, sentAt: "2026-10-26T10:00:00.000Z", startedAt: null, implementedAt: null, previewUrl: "http://localhost:5173/login" } } } });
	assert.ok(ARRANGE_IDS.every((id) => !canvas.document.getElementById(id).disabled));
	withClass(canvas.world.children[0], "gd-compare-start")[0].dispatch("click");
	assert.ok(ARRANGE_IDS.every((id) => canvas.document.getElementById(id).disabled), "Compare covers the canvas");
	canvas.document.getElementById("gd-compare-back").dispatch("click");
	assert.ok(ARRANGE_IDS.every((id) => !canvas.document.getElementById(id).disabled));
});

// ---- focus mode and the view (S3: store mutators only)

test("focus mode centers a moved artboard from where it sits", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: { layout: { arrangement: "free", positions: { "01-a.html": { x: 0, y: 0 }, "02-b.html": { x: 600, y: 900 } } } } });
	const [, second] = canvas.boards;
	assert.deepEqual(placed(second.wrapper), ["600px", "900px"]);
	// The browser lays an absolutely placed artboard out at its position; its frame box sits under the label, inside it.
	second.wrapper.offsetLeft = 600;
	second.wrapper.offsetTop = 900;
	second.frame.parentElement!.offsetTop = 20;
	click(second.shield!, 200, 200);
	// Desktop fills the 1000 px viewport less its 8 px margins, so x is the left margin: 8 - 600; y centers its 300 px below
	// the 8 px margin and the label: 200 - 920.
	assert.equal(canvas.world.style.transform, "translate(-592px, -720px) scale(1)");
});

test("a layout change while an artboard is in use shifts the view to restore, so Back to canvas shows the boards where they were", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const [first] = canvas.boards;
	assert.equal(canvas.world.style.transform, "translate(48px, 48px) scale(1)");
	click(first.shield!, 200, 200);
	assert.match(canvas.navMode.textContent, /^Using: First/);
	// Another page put the first artboard 200 px left of and 100 px above the second: the bounds' top left moves.
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "free", positions: { "01-a.html": { x: -200, y: -100 }, "02-b.html": { x: 480, y: 0 } } } };
	await canvas.serverEvent("change", { slug: "alpha", file: "layout.json" });
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["680px", "100px"]]);
	assert.match(canvas.navMode.textContent, /^Using: First/, "focus mode stays");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(canvas.world.style.transform, "translate(-152px, -52px) scale(1)", "the saved view moved with the world");
});

test("no canvas module changes the view in place: zoom and pan go through the store's mutators", () => {
	for (const name of Object.keys(DESIGN_CANVAS_ASSETS).filter((file) => file.startsWith("canvas-") && file.endsWith(".js"))) {
		const source = read(name);
		assert.ok(!/\b(?:state|view|savedView)\.(?:x|y|zoom|fitted)\s*(?:[-+*/]?=)(?!=)/.test(source), `${name} assigns no view field`);
		assert.ok(!/Object\.assign\(\s*state\b/.test(source), `${name} does not assign into state`);
	}
	const layout = read("canvas-layout.js");
	assert.match(layout, /store\.setView\(/, "the layout shifts the view through setView");
	assert.match(layout, /store\.setFocus\(\{ savedView/, "and the view to restore through setFocus");
});

// ---- markup, styles and docs

test("the arrangement control sits in the top bar after the zoom, named in English, styled with tokens; boards are placed absolutely", () => {
	const html = read("index.html");
	const bar = html.slice(html.indexOf('<header class="gd-bar"'), html.indexOf("</header>"));
	const group = /<div class="gd-group gd-arrange" role="group" aria-label="Arrange the artboards">([^]*?)<\/div>/.exec(bar);
	assert.ok(group, "a labelled group in the top bar");
	for (const [kind, name] of [["row", "Row"], ["column", "Column"], ["grid", "Grid"]]) {
		assert.match(group![1], new RegExp(`<button type="button" id="gd-arrange-${kind}" aria-pressed="${kind === "row"}" aria-label="${name}" title="Arrange in a ${kind}" disabled><svg class="gd-i" aria-hidden="true"><use href="#i-${kind}"/></svg></button>`));
		assert.match(html, new RegExp(`<symbol id="i-${kind}" viewBox="0 0 24 24">`));
	}
	assert.ok(bar.indexOf('aria-label="Zoom"') < bar.indexOf("gd-arrange") && bar.indexOf("gd-arrange") < bar.indexOf('id="gd-nav-mode"'), "after the zoom, before the mode label");
	assert.ok(!/data-i18n/.test(html), "English literals, no catalog keys yet");
	const css = read("canvas.css");
	const pressed = /\.gd-arrange button\[aria-pressed="true"\]\s*{([^}]*)}/.exec(css);
	assert.ok(pressed && /var\(--gd-/.test(pressed[1]) && !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(pressed[1]), "the chosen arrangement shows, in tokens");
	assert.match(css, /\.gd-world \.gd-artboard\s*{[^}]*position:\s*absolute/, "artboards sit where the layout puts them");
	const world = /\n\.gd-world\s*{([^}]*)}/.exec(css)![1];
	assert.ok(!/display:\s*flex|gap:/.test(world), "the world is no longer a flex row");
	assert.match(css, /\.gd-viewport\.gd-moving, \.gd-viewport\.gd-moving \* \{ cursor: grabbing; \}/);
});

test("the shortcuts list names Space + drag and Esc clears the selection, and the docs describe the layout", () => {
	const html = read("index.html");
	const dialog = html.slice(html.indexOf('<dialog id="gd-shortcuts"'), html.indexOf("</dialog>"));
	assert.match(dialog, /<dt><kbd>Space<\/kbd> \+ drag<\/dt><dd>Pan from anywhere, even over an artboard<\/dd>/);
	assert.ok(dialog.indexOf("&darr;") < dialog.indexOf("<kbd>Space</kbd>") && dialog.indexOf("<kbd>Space</kbd>") < dialog.indexOf("<dt><kbd>Esc</kbd></dt>"), "after the arrow keys");
	assert.match(dialog, /<dt><kbd>Esc<\/kbd><\/dt><dd>[^<]*selected artboard[^<]*<\/dd>/);
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"));
	const start = section.indexOf("- **Layout**");
	assert.ok(start >= 0, "a Layout entry");
	const layout = section.slice(start, section.indexOf("\n", start));
	for (const part of ["any part of it", "`Space`", "selected", "empty canvas", "**Row**", "**Column**", "**Grid**", "`design/<slug>/layout.json`", "Comment mode"]) assert.ok(layout.includes(part), `the Layout entry mentions ${part}`);
	assert.ok(!section.includes("drag always pan or zoom the canvas, even over an artboard"), "the old gesture is gone");
	assert.ok(!section.includes("pan by dragging or scrolling"));
});


// ---- CodeRabbit round 2: reads, saves and moves that cross a reload, a design switch or the system-only view

const DESIGN_CHANGE = { slug: "alpha", file: "design.json" };
/** A pointer event on the viewport, which holds the pointer capture once a press began. */
const onViewport = (canvas: Canvas, type: string, x: number, y: number) => canvas.viewport.dispatch(type, { button: 0, pointerId: 3, clientX: x, clientY: y });

test("a design.json reload whose layout read went out during a save and answers after the save succeeded never rolls the move back", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const save = deferred();
	canvas.replies[LAYOUT_URL] = save.promise;
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	const read = deferred();
	canvas.replies[LAYOUT_URL] = read.promise;
	await canvas.serverEvent("change", DESIGN_CHANGE);
	save.resolve({ ok: true });
	await settle();
	read.resolve({ layout: null });
	await settle();
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "0px"]], "the read of the file from before the save is dropped");
	assert.deepEqual(pressedArrangements(canvas), ["false", "false", "false"]);
	assert.equal(layoutPosts(canvas).length, 1);
});

test("another page's layout.json change whose read a failed save made stale is read again once the save fails", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: { layout: { arrangement: "column", positions: {} } } });
	const external = deferred();
	canvas.replies[LAYOUT_URL] = external.promise;
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	const save = deferred();
	canvas.replies[LAYOUT_URL] = save.promise;
	canvas.document.getElementById("gd-arrange-row").dispatch("click");
	await settle();
	// Another page wrote Grid; this page's Row is rejected.
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "grid", positions: {} } };
	external.resolve({ layout: { arrangement: "grid", positions: {} } });
	await settle();
	save.resolve({ __http: 400, error: "invalid-layout", reason: "disk full" });
	await settle();
	await settle();
	assert.deepEqual(pressedArrangements(canvas), ["false", "false", "true"], "the other page's grid shows");
	assert.equal(layoutPosts(canvas).length, 1, "and nothing is saved back");
});

test("a move of the system board ends unsaved when the system-only view takes its layout away", async () => {
	const canvas = await loadLayout({ ...SYSTEM_REPLY, ...NO_LAYOUT });
	boardTitle(canvas.world.children[0]).dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 100, clientY: 100 });
	onViewport(canvas, "pointermove", 140, 100);
	await canvas.serverEvent("show", { slug: null });
	await settle();
	onViewport(canvas, "pointermove", 180, 100);
	onViewport(canvas, "pointerup", 180, 100);
	await settle();
	assert.deepEqual(canvas.posts, [], "nothing is saved");
	assert.equal(canvas.navMode.textContent, NAVIGATING);
});

test("a design.json reload during a move hands the move to the rebuilt artboard, saved once on release", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	boardTitle(canvas.world.children[1]).dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 500, clientY: 100 });
	onViewport(canvas, "pointermove", 540, 100);
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await settle();
	onViewport(canvas, "pointermove", 560, 100);
	assert.deepEqual(placed(canvas.world.children[1]), ["540px", "0px"], "the rebuilt artboard follows the pointer");
	onViewport(canvas, "pointerup", 560, 100);
	await settle();
	assert.deepEqual(layoutPosts(canvas).map((post) => post.body), [{ arrangement: "free", positions: { "01-a.html": { x: 0, y: 0 }, "02-b.html": { x: 540, y: 0 } } }]);
});

test("a design.json reload during a move in an arrangement keeps the dragged position, saved on a release without another move", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	boardTitle(canvas.world.children[1]).dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 500, clientY: 100 });
	onViewport(canvas, "pointermove", 540, 100);
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await settle();
	assert.deepEqual(placed(canvas.world.children[1]), ["520px", "0px"], "the rebuilt artboard stays where it was dragged");
	onViewport(canvas, "pointerup", 540, 100);
	await settle();
	assert.deepEqual(layoutPosts(canvas).map((post) => post.body), [{ arrangement: "free", positions: { "01-a.html": { x: 0, y: 0 }, "02-b.html": { x: 520, y: 0 } } }]);
});

test("a move of the system board across a design switch is cancelled and never written to the next design's layout.json", async () => {
	const BETA_LAYOUT = "/t/api/designs/beta/layout";
	const canvas = await loadLayout({ ...SYSTEM_REPLY, ...NO_LAYOUT });
	const betaManifest = deferred();
	const beta = canvas.replies["/t/api/designs/beta"];
	canvas.replies["/t/api/designs/beta"] = betaManifest.promise;
	canvas.replies[BETA_LAYOUT] = { layout: null };
	const select = canvas.document.getElementById("gd-design");
	select.value = "beta";
	select.dispatch("change");
	boardTitle(canvas.world.children[0]).dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 100, clientY: 100 });
	onViewport(canvas, "pointermove", 160, 100);
	betaManifest.resolve(beta);
	await settle();
	onViewport(canvas, "pointermove", 200, 100);
	onViewport(canvas, "pointerup", 200, 100);
	await settle();
	assert.deepEqual(canvas.posts.map((post) => post.url), [], "nothing is saved, to alpha or beta");
});

test("a still press on an artboard that a design.json reload replaced opens nothing on release", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	withClass(canvas.world.children[1], "gd-shield")[0].dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 500, clientY: 300 });
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await settle();
	onViewport(canvas, "pointerup", 500, 300);
	await settle();
	assert.equal(canvas.navMode.textContent, NAVIGATING, "no detached artboard is opened");
});

test("a failed design load that answers after the system-only view showed leaves that view alone", async () => {
	const canvas = await loadLayout({ ...SYSTEM_REPLY, ...NO_LAYOUT });
	const manifest = deferred();
	canvas.replies["/t/api/designs/alpha"] = manifest.promise;
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await canvas.serverEvent("show", { slug: null });
	await settle();
	assert.equal(canvas.world.children.length, 1, "the system board shows");
	manifest.resolve({ __http: 500 });
	await settle();
	assert.equal(canvas.world.children.length, 1, "it still shows");
	assert.ok(!canvas.document.getElementById("gd-status").classes.has("gd-error"), "and no design error is reported");
});

// ---- egdev6's review of #3146: the layout errors in the status line, Space on an arrangement button, nothing to arrange

/** The reply of the canvas server's GET layout route for a layout.json it cannot read or use (canvas-layout S17). */
const UNREADABLE = { __http: 422, error: "unreadable-layout", reason: "not valid JSON" };
const READ_FAILED = "design/alpha/layout.json could not be read: not valid JSON";

test("a layout.json the server cannot read keeps the layout shown, says so in the status line and saves nothing, until a read that answers", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const status = canvas.document.getElementById("gd-status");
	canvas.replies[LAYOUT_URL] = { ok: true };
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	assert.equal(layoutPosts(canvas).length, 1, "the free layout is saved");
	const free = [["0px", "0px"], ["520px", "0px"]];
	canvas.replies[LAYOUT_URL] = UNREADABLE;
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(canvas.world.children.map(placed), free, "a layout.json change that cannot be read is no row");
	assert.deepEqual(pressedArrangements(canvas), ["false", "false", "false"]);
	assert.equal(status.textContent, READ_FAILED);
	assert.ok(status.classes.has("gd-error"));
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), free, "nor is a design.json reload's read of it");
	assert.equal(status.textContent, READ_FAILED, "and the reload still says so");
	assert.ok(status.classes.has("gd-error"));
	assert.equal(layoutPosts(canvas).length, 1, "nothing is saved over the file");
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "column", positions: {} } };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "a read that answers shows the file again");
	assert.equal(status.textContent, "", "and clears the read error");
	assert.equal(status.classes.has("gd-error"), false);
	assert.equal(layoutPosts(canvas).length, 1);
});

test("a design opened while its layout.json cannot be read sits in a row, says so, and saves nothing", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: UNREADABLE });
	const status = canvas.document.getElementById("gd-status");
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]]);
	assert.equal(status.textContent, READ_FAILED);
	assert.ok(status.classes.has("gd-error"));
	assert.deepEqual(canvas.posts, []);
});

test("a failed save stays in the status line across a design.json reload while the layout is unsaved; a later save clears it", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	const status = canvas.document.getElementById("gd-status");
	canvas.replies[LAYOUT_URL] = { __http: 400, error: "invalid-layout", reason: "disk full" };
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	assert.equal(status.textContent, "The layout of alpha could not be saved: disk full");
	// The file still holds no layout: the reload keeps the unsaved move, and its error.
	canvas.replies[LAYOUT_URL] = { layout: null };
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await settle();
	assert.deepEqual(placed(canvas.world.children[1]), ["520px", "0px"], "the unsaved move stays");
	assert.equal(status.textContent, "The layout of alpha could not be saved: disk full", "the reload does not hide the failed save");
	assert.ok(status.classes.has("gd-error"));
	canvas.replies[LAYOUT_URL] = { ok: true };
	await dragFrom(boardTitle(canvas.world.children[1]), [540, 100], [[560, 100]]);
	assert.equal(status.textContent, "", "a save that succeeds clears it");
	assert.equal(status.classes.has("gd-error"), false);
	canvas.replies[LAYOUT_URL] = { layout: layoutPosts(canvas).at(-1)!.body };
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await settle();
	assert.equal(status.textContent, "", "and a reload after it shows no error");
});

test("Space held on an arrangement button just clicked pans instead of pressing it again; reached by the keyboard it keeps Space", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	canvas.replies[LAYOUT_URL] = { ok: true };
	const grid = canvas.document.getElementById("gd-arrange-grid");
	grid.focus();
	grid.dispatch("click");
	await settle();
	assert.equal(layoutPosts(canvas).length, 1, "Grid is saved");
	const [x, y] = translation(canvas);
	assert.equal(keyAt(canvas, "keydown", " ", grid).defaultPrevented, true, "Space does not press the button");
	assert.ok(canvas.viewport.classes.has("gd-space-pan"));
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 60], [[540, 80]]);
	assert.deepEqual(translation(canvas), [x + 40, y + 20], "the drag pans");
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], "and moves no artboard");
	assert.equal(keyAt(canvas, "keyup", " ", grid).defaultPrevented, true, "nor does its release");
	assert.ok(!canvas.viewport.classes.has("gd-space-pan"));
	assert.equal(layoutPosts(canvas).length, 1, "nothing more is saved");
	// A button reached with Tab shows its focus ring (:focus-visible): Space presses it, as on any button.
	grid.matches = (selector: string) => selector === ":focus-visible";
	assert.equal(keyAt(canvas, "keydown", " ", grid).defaultPrevented, false);
	assert.ok(!canvas.viewport.classes.has("gd-space-pan"));
});

test("the arrangement buttons are off when no boards show: a design without artboards, or one whose design.json cannot be read", async () => {
	const off = (canvas: Canvas) => ARRANGE_IDS.map((id) => canvas.document.getElementById(id).disabled);
	const empty = await loadLayout({ ...NO_LAYOUT, "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [] } });
	assert.deepEqual(off(empty), [true, true, true], "a design without artboards");
	const canvas = await loadLayout(NO_LAYOUT);
	assert.deepEqual(off(canvas), [false, false, false]);
	const manifest = canvas.replies["/t/api/designs/alpha"];
	canvas.replies["/t/api/designs/alpha"] = { __http: 422, error: "invalid-manifest", reason: "broken" };
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await settle();
	assert.equal(canvas.world.children.length, 0, "no boards show");
	assert.deepEqual(off(canvas), [true, true, true], "a design.json that cannot be read");
	canvas.replies["/t/api/designs/alpha"] = manifest;
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await settle();
	assert.deepEqual(off(canvas), [false, false, false], "they come back with the boards");
});

test("a design.json reload still shows the manifest's warnings and the no-artboards notice; a standing save error comes first", async () => {
	const manifest = (artboards: unknown[], warnings?: string[]) => ({ slug: "alpha", title: "Alpha", brief: "", artboards, ...(warnings ? { warnings } : {}) });
	const two = [{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: 300 }, { file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 }];
	const canvas = await loadLayout({ ...SYSTEM_REPLY, ...NO_LAYOUT, "/t/api/designs/alpha": manifest(two, ["feature was ignored", "one more"]) });
	const status = canvas.document.getElementById("gd-status");
	assert.equal(status.textContent, "design.json: feature was ignored; one more");
	assert.ok(status.classes.has("gd-error"));
	canvas.replies["/t/api/designs/alpha"] = manifest([]);
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await settle();
	assert.equal(status.textContent, "This design has no artboards yet.", "the system board shows alone");
	assert.equal(status.classes.has("gd-error"), false);
	canvas.replies["/t/api/designs/alpha"] = manifest(two, ["feature was ignored"]);
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await settle();
	canvas.replies[LAYOUT_URL] = { __http: 400, error: "invalid-layout", reason: "disk full" };
	await dragFrom(boardTitle(canvas.world.children[2]), [1400, 100], [[1440, 100]]);
	canvas.replies[LAYOUT_URL] = { layout: null };
	await canvas.serverEvent("change", DESIGN_CHANGE);
	await settle();
	assert.equal(status.textContent, "The layout of alpha could not be saved: disk full; design.json: feature was ignored");
	assert.ok(status.classes.has("gd-error"));
});

test("a layout read that fails for another reason than an unreadable layout.json (an HTTP error, no connection) keeps the layout and says nothing", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: { layout: { arrangement: "column", positions: {} } } });
	const status = canvas.document.getElementById("gd-status");
	for (const reply of [{ __http: 500 }, { __http: 404 }, { __throw: "offline" }]) {
		canvas.replies[LAYOUT_URL] = reply;
		await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
		await settle();
		assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"], `the column stays (${JSON.stringify(reply)})`);
		assert.deepEqual([status.textContent, status.classes.has("gd-error")], ["", false], `nothing in the status line (${JSON.stringify(reply)})`);
	}
	assert.deepEqual(canvas.posts, []);
});

// ---- egdev6's second review of #3146: a lost pointer capture, and no saves while layout.json cannot be used

test("a move whose pointer capture is lost puts the artboard back unsaved, and the next press on the empty canvas pans", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	canvas.replies[LAYOUT_URL] = { ok: true };
	boardTitle(canvas.world.children[1]).dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 500, clientY: 100 });
	onViewport(canvas, "pointermove", 560, 100);
	assert.deepEqual(placed(canvas.world.children[1]), ["540px", "0px"], "the artboard follows the pointer");
	onViewport(canvas, "lostpointercapture", 560, 100);
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], "the artboard goes back");
	assert.equal(canvas.viewport.classes.has("gd-moving"), false, "the grabbing cursor goes");
	assert.deepEqual(canvas.posts, [], "nothing is saved");
	const [x, y] = translation(canvas);
	await dragFrom(canvas.viewport, [900, 600], [[940, 620]]);
	assert.deepEqual(translation(canvas), [x + 40, y + 20], "a new press on the empty canvas pans");
	assert.deepEqual(canvas.posts, []);
});

test("a pan whose pointer capture is lost ends, so the next press works; a capture lost after the release changes nothing", async () => {
	const canvas = await loadLayout(NO_LAYOUT);
	canvas.replies[LAYOUT_URL] = { ok: true };
	const [x, y] = translation(canvas);
	onViewport(canvas, "pointerdown", 900, 600);
	onViewport(canvas, "pointermove", 920, 600);
	onViewport(canvas, "lostpointercapture", 920, 600);
	assert.equal(canvas.viewport.classes.has("gd-panning"), false, "the pan ends");
	await dragFrom(canvas.viewport, [900, 600], [[900, 640]]);
	assert.deepEqual(translation(canvas), [x + 20, y + 40], "the next press pans");
	// The browser releases the capture after a pointerup too: that release has already saved the move once.
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	onViewport(canvas, "lostpointercapture", 540, 100);
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "0px"]], "the moved artboard stays");
	assert.deepEqual(layoutPosts(canvas).map((post) => post.body), [{ arrangement: "free", positions: { "01-a.html": { x: 0, y: 0 }, "02-b.html": { x: 520, y: 0 } } }]);
});

test("while layout.json cannot be read, a move and Row/Column/Grid change only the view and save nothing; saves resume once it reads again", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: UNREADABLE });
	const status = canvas.document.getElementById("gd-status");
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "0px"]], "the artboard moves on screen");
	assert.deepEqual(canvas.posts, [], "nothing is saved over the file");
	assert.deepEqual([status.textContent, status.classes.has("gd-error")], [READ_FAILED, true], "the status line still says why");
	canvas.document.getElementById("gd-arrange-column").dispatch("click");
	await settle();
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["0px", "380px"]], "Column arranges the boards on screen");
	assert.deepEqual(pressedArrangements(canvas), ["false", "true", "false"]);
	assert.deepEqual(canvas.posts, [], "and saves nothing");
	assert.deepEqual([status.textContent, status.classes.has("gd-error")], [READ_FAILED, true]);
	// The file can be read again: the next move is saved.
	canvas.replies[LAYOUT_URL] = { layout: { arrangement: "row", positions: {} } };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	assert.deepEqual(pressedArrangements(canvas), ["true", "false", "false"], "the file's layout shows");
	assert.deepEqual([status.textContent, status.classes.has("gd-error")], ["", false]);
	canvas.replies[LAYOUT_URL] = { ok: true };
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	assert.equal(layoutPosts(canvas).length, 1, "the move is saved");
	assert.equal((layoutPosts(canvas)[0].body as { arrangement: string }).arrangement, "free");
});

test("a layout.json missing again after it could not be read lets the page save once more", async () => {
	const canvas = await loadLayout({ [LAYOUT_URL]: UNREADABLE });
	canvas.replies[LAYOUT_URL] = { layout: null };
	await canvas.serverEvent("change", LAYOUT_CHANGE);
	canvas.replies[LAYOUT_URL] = { ok: true };
	await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
	assert.deepEqual(layoutPosts(canvas).map((post) => post.body), [{ arrangement: "free", positions: { "01-a.html": { x: 0, y: 0 }, "02-b.html": { x: 520, y: 0 } } }]);
});

test("a layout the page cannot use (a fraction, a position out of range) sits in a row, says so, and a move or an arrangement saves nothing", async () => {
	for (const position of [{ x: 1.5, y: 0 }, { x: 1e300, y: 0 }, { x: 0, y: -2_000_001 }]) {
		const label = JSON.stringify(position);
		const canvas = await loadLayout({ [LAYOUT_URL]: { layout: { arrangement: "free", positions: { "01-a.html": { x: 0, y: 0 }, "02-b.html": position } } } });
		const status = canvas.document.getElementById("gd-status");
		assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["480px", "0px"]], label);
		const unusable = "design/alpha/layout.json could not be read: it holds no layout this page can use";
		assert.deepEqual([status.textContent, status.classes.has("gd-error")], [unusable, true], label);
		canvas.replies[LAYOUT_URL] = { ok: true };
		await dragFrom(boardTitle(canvas.world.children[1]), [500, 100], [[540, 100]]);
		assert.deepEqual(canvas.world.children.map(placed), [["0px", "0px"], ["520px", "0px"]], `${label}: the move shows`);
		canvas.document.getElementById("gd-arrange-column").dispatch("click");
		await settle();
		assert.deepEqual(canvas.posts, [], `${label}: nothing is saved`);
		assert.equal(status.textContent, unusable, label);
	}
	// The farthest position the server accepts is one the page uses too.
	const edge = await loadLayout({ [LAYOUT_URL]: { layout: { arrangement: "free", positions: { "01-a.html": { x: 0, y: 0 }, "02-b.html": { x: 2_000_000, y: 0 } } } } });
	assert.deepEqual(edge.world.children.map(placed), [["0px", "0px"], ["2000000px", "0px"]]);
});

test("a __proto__ key in a saved layout is an unknown board like any other: it changes no prototype and drops out of the next save", async () => {
	const layout = JSON.parse('{"arrangement":"free","positions":{"__proto__":{"x":7,"y":9},"01-a.html":{"x":0,"y":500},"02-b.html":{"x":600,"y":0}}}');
	const canvas = await loadLayout({ [LAYOUT_URL]: { layout } });
	assert.deepEqual(canvas.world.children.map(placed), [["0px", "500px"], ["600px", "0px"]]);
	assert.equal((Object.prototype as Record<string, unknown>).x, undefined, "Object.prototype is untouched");
	canvas.replies[LAYOUT_URL] = { ok: true };
	await dragFrom(boardTitle(canvas.world.children[1]), [700, 100], [[740, 100]]);
	assert.deepEqual(layoutPosts(canvas).map((post) => JSON.stringify(post.body)), [JSON.stringify({ arrangement: "free", positions: { "01-a.html": { x: 0, y: 500 }, "02-b.html": { x: 640, y: 0 } } })]);
});
