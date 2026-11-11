import assert from "node:assert/strict";
import test from "node:test";
import { click, loadCanvas } from "./support/design-canvas-dom.ts";

// Navigation and focus modes (canvas-focus.js).

test("a click on an artboard's shield enters focus mode at 100% and only that artboard can end it", async () => {
	const canvas = await loadCanvas();
	assert.equal(canvas.boards.length, 2);
	const [first, second] = canvas.boards;
	assert.ok(first.shield && second.shield, "every artboard has an interaction shield");
	assert.equal(canvas.navMode.textContent, "Navigating");

	// Start from a non-default view so restoring it is observable.
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	canvas.viewport.dispatch("wheel", { deltaX: 30, deltaY: 20, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	const before = canvas.world.style.transform;
	const zoomBefore = canvas.zoomLevel.textContent;
	assert.notEqual(zoomBefore, "100%");

	first.frame.rect = { left: 120, top: 140, width: 268, height: 201 };
	click(first.shield!, 200, 200);
	assert.equal(canvas.zoomLevel.textContent, "100%");
	assert.match(canvas.world.style.transform, /scale\(1\)$/);
	assert.equal(first.shield!.hidden, true, "the focused artboard loses its shield");
	assert.equal(second.shield!.hidden, false);
	assert.equal(second.wrapper.inert, true, "the other artboards are inert");
	assert.equal(canvas.document.activeElement, first.frame, "keyboard focus moves into the artboard");
	assert.match(canvas.navMode.textContent, /^Using: First · Shift\+Esc to exit$/);
	assert.deepEqual(first.frame.contentWindow!.posted.at(-1), { type: "gd:focus", enabled: true });

	// Canvas pan and zoom are off while focused.
	const focusedTransform = canvas.world.style.transform;
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 80, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 10, clientY: 10 });
	canvas.message(first.frame.contentWindow, { type: "gd:wheel", deltaX: 0, deltaY: 80, deltaMode: 0, zoom: true, shift: false, x: 5, y: 5 });
	assert.equal(canvas.world.style.transform, focusedTransform);

	// gd:exit-focus is accepted only from the focused artboard's own window.
	canvas.message(second.frame.contentWindow, { type: "gd:exit-focus" });
	canvas.message({}, { type: "gd:exit-focus" });
	assert.equal(canvas.zoomLevel.textContent, "100%");
	canvas.message(first.frame.contentWindow, { type: "gd:exit-focus" });
	assert.equal(canvas.world.style.transform, before, "the previous zoom and pan return exactly");
	assert.equal(canvas.zoomLevel.textContent, zoomBefore);
	assert.equal(first.shield!.hidden, false);
	assert.equal(second.wrapper.inert, false);
	assert.equal(canvas.navMode.textContent, "Navigating");
});

test("a taller artboard is top-aligned and clipped to the viewport while focused, then restored", async () => {
	const canvas = await loadCanvas(1600);
	const [first] = canvas.boards;
	assert.equal(first.frame.style.height, "1600px");
	// In world coordinates the frame box sits at (480, 20), under a 20 px label.
	first.frame.parentElement!.offsetLeft = 480;
	first.frame.parentElement!.offsetTop = 20;
	click(first.shield!, 200, 200);
	// The 700 px viewport keeps a 16 px margin, the 20 px label and a 64 px band for the Back button.
	assert.equal(first.frame.style.height, "600px");
	// x centers the 400 px board in 1000 px: 300 - 480; y puts its top 16 + 20 px down: 36 - 20.
	assert.equal(canvas.world.style.transform, "translate(-180px, 16px) scale(1)");
	// Re-centering (window resize, panel toggle) is idempotent.
	canvas.windowEvent("resize");
	assert.equal(canvas.world.style.transform, "translate(-180px, 16px) scale(1)");
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(first.frame.style.height, "1600px");
});

test("entering focus hides an open panel and exiting restores it; a closed panel stays closed", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	const panel = canvas.document.getElementById("gd-panel");
	const toggle = canvas.document.getElementById("gd-panel-toggle");
	assert.equal(panel.hidden, false);
	click(first.shield!, 200, 200);
	assert.equal(panel.hidden, true, "focus mode hides the open panel to gain width");
	assert.equal(toggle.getAttribute("aria-pressed"), "false");
	canvas.message(first.frame.contentWindow, { type: "gd:exit-focus" });
	assert.equal(panel.hidden, false, "exiting reopens it");
	assert.equal(toggle.getAttribute("aria-pressed"), "true");

	toggle.dispatch("click");
	assert.equal(panel.hidden, true);
	click(first.shield!, 200, 200);
	assert.equal(panel.hidden, true);
	canvas.document.getElementById("gd-back").dispatch("click");
	assert.equal(panel.hidden, true, "a closed panel stays closed");
	assert.equal(toggle.getAttribute("aria-pressed"), "false");
});

test("the Back to canvas button and Shift+Esc in the canvas both leave focus mode", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	const back = canvas.document.getElementById("gd-back");
	assert.equal(back.hidden, true);
	click(first.shield!, 200, 200);
	assert.equal(back.hidden, false);
	back.dispatch("click");
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.equal(back.hidden, true);

	click(first.shield!, 200, 200);
	const keydown = canvas.document.listeners.get("keydown") ?? [];
	const plain: any = { key: "Escape", shiftKey: false, target: back, defaultPrevented: false, preventDefault() { plain.defaultPrevented = true; } };
	keydown.forEach((listener) => listener(plain));
	assert.match(canvas.navMode.textContent, /^Using:/, "plain Esc does not leave focus mode");
	const chord: any = { key: "Escape", shiftKey: true, target: back, defaultPrevented: false, preventDefault() { chord.defaultPrevented = true; } };
	keydown.forEach((listener) => listener(chord));
	assert.equal(canvas.navMode.textContent, "Navigating");
});
