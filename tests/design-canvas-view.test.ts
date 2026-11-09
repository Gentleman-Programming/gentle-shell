import assert from "node:assert/strict";
import test from "node:test";
import { click, loadCanvas, read, type CanvasFixture, type FakeElement } from "./support/design-canvas-dom.ts";

// The view transform: pan, zoom, Fit and refit (canvas-view.js).

test("a drag over an artboard pans the canvas, and in comment mode a click is routed to the inspector as a pick", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	first.frame.rect = { left: 100, top: 100, width: 200, height: 150 };
	const before = canvas.world.style.transform;
	first.shield!.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 150, clientY: 150 });
	first.shield!.dispatch("pointermove", { pointerId: 1, clientX: 190, clientY: 170 });
	first.shield!.dispatch("pointerup", { button: 0, pointerId: 1, clientX: 190, clientY: 170 });
	assert.notEqual(canvas.world.style.transform, before, "the drag panned");
	assert.equal(canvas.navMode.textContent, "Navigating", "a drag never enters focus mode");

	canvas.document.getElementById("gd-comment").dispatch("click");
	click(first.shield!, 150, 130);
	assert.equal(canvas.navMode.textContent, "Navigating", "comment mode picks instead of focusing");
	// The frame shows a 400x300 artboard at half size: (150-100)/0.5, (130-100)/0.5.
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:pick-at", x: 100, y: 60 });
});

const panTargets: Array<[string, (canvas: CanvasFixture) => FakeElement]> = [
	["viewport", (canvas) => canvas.viewport],
	["gap between artboards", (canvas) => canvas.world],
	["artboard gap", (canvas) => canvas.boards[0].wrapper],
	["frame box", (canvas) => canvas.boards[0].frame.parentElement!],
	["artboard title", (canvas) => canvas.boards[0].wrapper.children[0].children[0]],
	["actions gap", (canvas) => canvas.boards[0].wrapper.children[0].children.find((child) => child.classes.has("gd-board-actions"))!],
	["shield", (canvas) => canvas.boards[0].shield!],
];

for (const [name, targetOf] of panTargets) {
	test(`navigation pan starts on ${name} without selecting`, async () => {
		const canvas = await loadCanvas();
		const target = targetOf(canvas);
		const down = target.dispatch("pointerdown", { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
		canvas.viewport.dispatch("pointermove", { pointerId: 7, clientX: 45, clientY: 30 });
		assert.equal(canvas.world.style.transform, "translate(83px, 68px) scale(1)");
		assert.equal(down.defaultPrevented, true, "only an accepted pan suppresses the pointer default");
		assert.deepEqual(canvas.viewport.capturedPointers, [7]);
		assert.equal(canvas.viewport.classes.has("gd-panning"), true);
		canvas.viewport.dispatch("pointerup", { button: 0, pointerId: 7, clientX: 45, clientY: 30 });
		assert.equal(canvas.viewport.classes.has("gd-panning"), false);
		assert.equal(canvas.navMode.textContent, "Navigating", "a drag does not focus a shield");
	});
}

test("navigation pan cancels a stale native drag and continues until pointerup", async () => {
	const canvas = await loadCanvas();
	const title = canvas.boards[0].wrapper.children[0].children[0];
	assert.equal(title.dispatch("dragstart").defaultPrevented, true, "a native viewport drag is canceled even before a pan");
	const down = title.dispatch("pointerdown", { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
	const dragstart = title.dispatch("dragstart");
	assert.equal(dragstart.defaultPrevented, true, "an old selection cannot start a native drag");
	assert.equal(down.defaultPrevented, true);
	canvas.viewport.dispatch("pointermove", { pointerId: 2, clientX: 40, clientY: 25 });
	assert.equal(canvas.world.style.transform, "translate(78px, 63px) scale(1)");
	canvas.viewport.dispatch("pointerup", { pointerId: 2, clientX: 40, clientY: 25 });
	assert.equal(canvas.viewport.classes.has("gd-panning"), false);
});

test("navigation pan leaves secondary buttons and interactive descendants to the browser", async () => {
	const canvas = await loadCanvas();
	const label = canvas.boards[0].wrapper.children[0];
	const before = canvas.world.style.transform;
	const secondary = label.dispatch("pointerdown", { button: 2, pointerId: 1, clientX: 10, clientY: 10 });
	assert.equal(secondary.defaultPrevented, false);
	canvas.viewport.dispatch("pointermove", { pointerId: 1, clientX: 40, clientY: 25 });
	assert.equal(canvas.world.style.transform, before);
	for (const name of ["button", "a", "input", "select", "textarea", "iframe", "editable", "plaintext-only"]) {
		const control = canvas.document.createElement(name === "editable" || name === "plaintext-only" ? "div" : name);
		if (name === "editable" || name === "plaintext-only") control.setAttribute("contenteditable", name === "editable" ? "true" : name);
		const child = canvas.document.createElement("span");
		control.append(child);
		label.append(control);
		const down = child.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 10, clientY: 10 });
		assert.equal(down.defaultPrevented, false, `${name} pointer default`);
		assert.equal(child.dispatch("dragstart").defaultPrevented, false, `${name} native drag default`);
		canvas.viewport.dispatch("pointermove", { pointerId: 3, clientX: 40, clientY: 25 });
		canvas.viewport.dispatch("pointerup", { pointerId: 3, clientX: 40, clientY: 25 });
		assert.equal(canvas.world.style.transform, before, `${name} did not pan`);
		assert.equal(canvas.viewport.classes.has("gd-panning"), false);
	}
	assert.deepEqual(canvas.viewport.capturedPointers, []);
	const editable = canvas.document.createElement("div");
	editable.setAttribute("contenteditable", "true");
	const noneditable = canvas.document.createElement("div");
	noneditable.setAttribute("contenteditable", "false");
	editable.append(noneditable);
	label.append(editable);
	assert.equal(noneditable.dispatch("pointerdown", { button: 0, pointerId: 6, clientX: 10, clientY: 10 }).defaultPrevented, true);
	canvas.viewport.dispatch("pointermove", { pointerId: 6, clientX: 40, clientY: 25 });
	canvas.viewport.dispatch("pointerup", { pointerId: 6, clientX: 40, clientY: 25 });
	assert.equal(canvas.world.style.transform, "translate(78px, 63px) scale(1)", "noneditable descendants remain pannable");
});

test("navigation pan preserves implement controls, comment pins and toolbar zoom", async () => {
	const comment = { id: "abc123", file: "01-a.html", selector: "h1", excerpt: "First", comment: "Update", status: "open", sentAt: null };
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/comments": { comments: [comment] } });
	const board = canvas.boards[0];
	const label = board.wrapper.children[0];
	const actions = label.children.find((child) => child.classes.has("gd-board-actions"))!;
	const implement = actions.children.find((child) => child.classes.has("gd-implement"))!;
	const start = implement.children.find((child) => child.classes.has("gd-implement-start"))!;
	const before = canvas.world.style.transform;
	assert.equal(start.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 10, clientY: 10 }).defaultPrevented, false);
	canvas.viewport.dispatch("pointermove", { pointerId: 1, clientX: 30, clientY: 30 });
	canvas.viewport.dispatch("pointerup", { pointerId: 1, clientX: 30, clientY: 30 });
	assert.equal(canvas.world.style.transform, before);
	start.dispatch("click");
	const confirm = implement.children.find((child) => child.classes.has("gd-implement-confirm"))!;
	assert.equal(confirm.hidden, false);
	assert.equal(canvas.document.activeElement, confirm.children[1]);
	// The text in the confirmation is not a control and can start a pan.
	const down = confirm.children[0].dispatch("pointerdown", { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
	canvas.viewport.dispatch("pointermove", { pointerId: 2, clientX: 20, clientY: 20 });
	canvas.viewport.dispatch("pointerup", { pointerId: 2, clientX: 20, clientY: 20 });
	assert.equal(canvas.world.style.transform, "translate(58px, 58px) scale(1)");
	assert.equal(down.defaultPrevented, true);

	canvas.message(board.frame.contentWindow, { type: "gd:pin-rects", rects: [{ id: comment.id, rect: { x: 10, y: 10, width: 30, height: 20 } }] });
	const pins = board.frame.parentElement!.children.find((child) => child.classes.has("gd-pins"))!;
	const pin = pins.children[0];
	const beforePin = canvas.world.style.transform;
	assert.equal(pin.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 10, clientY: 10 }).defaultPrevented, false);
	canvas.viewport.dispatch("pointermove", { pointerId: 3, clientX: 40, clientY: 40 });
	canvas.viewport.dispatch("pointerup", { pointerId: 3, clientX: 40, clientY: 40 });
	assert.equal(canvas.world.style.transform, beforePin);
	pin.dispatch("click");
	assert.deepEqual(board.frame.contentWindow!.posted.at(-1), { type: "gd:highlight", id: comment.id });
	assert.equal(canvas.document.getElementById("gd-comment-list").children[0].classes.has("gd-active"), true);
	canvas.document.getElementById("gd-zoom-in").dispatch("click");
	assert.equal(canvas.zoomLevel.textContent, "125%");
});

test("navigation pan does not cancel defaults or move the canvas in focus mode", async () => {
	const canvas = await loadCanvas();
	const board = canvas.boards[0];
	click(board.shield!, 10, 10);
	assert.equal(canvas.document.activeElement, board.frame);
	const before = canvas.world.style.transform;
	const title = board.wrapper.children[0].children[0];
	const down = title.dispatch("pointerdown", { button: 0, pointerId: 5, clientX: 10, clientY: 10 });
	assert.equal(down.defaultPrevented, false);
	assert.equal(title.dispatch("dragstart").defaultPrevented, false);
	assert.equal(board.frame.dispatch("pointerdown", { button: 0, pointerId: 8, clientX: 10, clientY: 10 }).defaultPrevented, false);
	assert.equal(board.frame.dispatch("dragstart").defaultPrevented, false);
	canvas.viewport.dispatch("pointermove", { pointerId: 5, clientX: 40, clientY: 25 });
	canvas.viewport.dispatch("pointerup", { pointerId: 5, clientX: 40, clientY: 25 });
	assert.equal(canvas.world.style.transform, before);
	assert.equal(canvas.viewport.classes.has("gd-panning"), false);
	assert.equal(canvas.document.activeElement, board.frame);
});

test("navigation pan preserves keyboard activation of the artboard shield", async () => {
	const canvas = await loadCanvas();
	const board = canvas.boards[0];
	const key = board.shield!.dispatch("keydown", { key: "Enter" });
	assert.equal(key.defaultPrevented, true);
	assert.equal(canvas.document.activeElement, board.frame);
	assert.match(canvas.navMode.textContent, /^Using: First/);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(canvas.document.activeElement, canvas.viewport);
	assert.equal(canvas.navMode.textContent, "Navigating");
});

test("navigation pan ends on pointercancel without focusing the shield", async () => {
	const canvas = await loadCanvas();
	const shield = canvas.boards[0].shield!;
	const down = shield.dispatch("pointerdown", { button: 0, pointerId: 4, clientX: 10, clientY: 10 });
	assert.equal(down.defaultPrevented, true);
	canvas.viewport.dispatch("pointercancel", { pointerId: 4, clientX: 10, clientY: 10 });
	canvas.viewport.dispatch("pointermove", { pointerId: 4, clientX: 40, clientY: 25 });
	assert.equal(canvas.world.style.transform, "translate(48px, 48px) scale(1)");
	assert.equal(canvas.viewport.classes.has("gd-panning"), false);
	assert.equal(canvas.navMode.textContent, "Navigating");
});

test("navigation pan declares selection suppression without disabling editable text", () => {
	const css = read("canvas.css");
	const viewport = /\.gd-viewport\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
	assert.match(viewport, /(?:^|;)\s*-webkit-user-select:\s*none\s*;/);
	assert.match(viewport, /(?:^|;)\s*user-select:\s*none\s*;/);
	const editable = /\.gd-viewport input,\s*\.gd-viewport textarea,\s*\.gd-viewport \[contenteditable\]:not\(\[contenteditable="false"\]\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
	assert.match(editable, /(?:^|;)\s*-webkit-user-select:\s*text\s*;/);
	assert.match(editable, /(?:^|;)\s*user-select:\s*text\s*;/);
	const focused = /\.gd-viewport\.gd-focused\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
	assert.match(focused, /(?:^|;)\s*-webkit-user-select:\s*auto\s*;/);
	assert.match(focused, /(?:^|;)\s*user-select:\s*auto\s*;/);
});

test("the overview fits again when the window settles at another size, until you zoom or pan yourself", async () => {
	const canvas = await loadCanvas();
	Object.defineProperty(canvas.world, "offsetWidth", { get: () => 9000 });
	Object.defineProperty(canvas.world, "offsetHeight", { get: () => 1000 });
	// A browser window that opens small and is then given its size (a tiling window manager, a restored window).
	canvas.viewport.rect = { left: 0, top: 50, width: 400, height: 300 };
	canvas.document.getElementById("gd-fit").dispatch("click");
	assert.equal(canvas.zoomLevel.textContent, "5%");
	canvas.viewport.rect = { left: 0, top: 50, width: 1800, height: 900 };
	canvas.windowEvent("resize");
	const settled = canvas.zoomLevel.textContent;
	canvas.document.getElementById("gd-fit").dispatch("click");
	assert.deepEqual([settled, canvas.zoomLevel.textContent], ["19%", "19%"], "the same view Fit gives at the new size");
	// Once you zoom, a resize leaves your view alone.
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: -40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	const zoomed = canvas.world.style.transform;
	canvas.viewport.rect = { left: 0, top: 50, width: 400, height: 300 };
	canvas.windowEvent("resize");
	assert.equal(canvas.world.style.transform, zoomed);
	// Fit starts following the viewport again; a pan of yours ends it too.
	canvas.document.getElementById("gd-fit").dispatch("click");
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	const panned = canvas.world.style.transform;
	canvas.viewport.rect = { left: 0, top: 50, width: 1800, height: 900 };
	canvas.windowEvent("resize");
	assert.equal(canvas.world.style.transform, panned);
	assert.equal(canvas.zoomLevel.textContent, "5%");
});

test("the overview fits again when the review panel opens or closes, also where ResizeObserver is missing", async () => {
	const canvas = await loadCanvas();
	Object.defineProperty(canvas.world, "offsetWidth", { get: () => 9000 });
	Object.defineProperty(canvas.world, "offsetHeight", { get: () => 1000 });
	canvas.viewport.rect = { left: 0, top: 50, width: 400, height: 300 };
	canvas.document.getElementById("gd-fit").dispatch("click");
	assert.equal(canvas.zoomLevel.textContent, "5%");
	// Closing the panel gives the viewport its width; no window resize event fires.
	canvas.viewport.rect = { left: 0, top: 50, width: 1800, height: 900 };
	canvas.document.getElementById("gd-panel-toggle").dispatch("click");
	assert.equal(canvas.zoomLevel.textContent, "19%");
});

test("a comment being written keeps its element and view when the panel toggles on a fitted overview", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	Object.defineProperty(canvas.world, "offsetWidth", { get: () => 9000 });
	Object.defineProperty(canvas.world, "offsetHeight", { get: () => 1000 });
	canvas.viewport.rect = { left: 0, top: 50, width: 400, height: 300 };
	canvas.document.getElementById("gd-fit").dispatch("click");
	canvas.document.getElementById("gd-comment").dispatch("click");
	canvas.message(first.frame.contentWindow, { type: "gd:pick", selector: "#cta", excerpt: "Buy now", rect: { x: 4, y: 8, width: 60, height: 20 } });
	const popover = canvas.document.getElementById("gd-popover");
	assert.equal(popover.hidden, false);
	const view = canvas.world.style.transform;
	canvas.viewport.rect = { left: 0, top: 50, width: 1800, height: 900 };
	canvas.document.getElementById("gd-panel-toggle").dispatch("click");
	assert.equal(popover.hidden, false, "the comment box stays open");
	assert.equal(canvas.document.getElementById("gd-popover-target").textContent, "01-a.html · #cta");
	assert.equal(canvas.world.style.transform, view, "the view waits until the comment box closes");
	// Once it closes, the next size change fits again.
	canvas.document.getElementById("gd-popover-cancel").dispatch("click");
	canvas.windowEvent("resize");
	assert.equal(canvas.zoomLevel.textContent, "19%");
});
