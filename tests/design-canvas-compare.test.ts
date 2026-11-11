import assert from "node:assert/strict";
import test from "node:test";
import { boardsOf, findAll, handoffDoc, loadCanvas, withClass } from "./support/design-canvas-dom.ts";

// S15: Compare (canvas-compare.js).

test("Compare shows the artboard and the sandboxed app side by side at the artboard size, and Shift+Esc or Back exits", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:5173/login" } }) });
	const overlay = canvas.document.getElementById("gd-compare");
	const panes = canvas.document.getElementById("gd-compare-panes");
	const open = () => withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	open();
	assert.equal(overlay.hidden, false);
	const frames = findAll(panes, (element) => element.localName === "iframe");
	assert.equal(frames.length, 2);
	const [artboard, preview] = frames;
	assert.equal(artboard.getAttribute("sandbox"), "allow-scripts", "the artboard stays sandboxed as on the canvas");
	assert.equal(artboard.src, "/t/files/alpha/01-a.html");
	assert.equal(preview.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-forms allow-popups");
	assert.equal(preview.getAttribute("referrerpolicy"), "no-referrer");
	assert.equal(preview.src, "http://localhost:5173/login");
	for (const frame of frames) assert.deepEqual([frame.style.width, frame.style.height], ["400px", "300px"]);
	const link = canvas.document.getElementById("gd-compare-open");
	assert.equal(link.href, "http://localhost:5173/login");
	assert.equal(link.getAttribute("rel"), "noopener noreferrer");
	assert.equal(link.getAttribute("target"), "_blank");
	assert.equal(canvas.viewport.inert, true, "the canvas underneath is inert");

	const keydown = canvas.document.listeners.get("keydown") ?? [];
	const press = (shiftKey: boolean) => {
		const event: any = { key: "Escape", shiftKey, target: canvas.document.body, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
		keydown.forEach((listener) => listener(event));
	};
	press(false);
	assert.equal(overlay.hidden, false, "plain Esc stays");
	press(true);
	assert.equal(overlay.hidden, true, "Shift+Esc exits Compare");
	assert.deepEqual(panes.children, [], "the app frame is removed");
	assert.equal(canvas.viewport.inert, false);

	open();
	canvas.document.getElementById("gd-compare-back").dispatch("click");
	assert.equal(overlay.hidden, true, "Back to canvas exits Compare");

	open();
	const [shownArtboard] = findAll(panes, (element) => element.localName === "iframe");
	canvas.message({}, { type: "gd:exit-focus" });
	assert.equal(overlay.hidden, false, "only the compared artboard may ask to exit");
	canvas.message(shownArtboard.contentWindow, { type: "gd:exit-focus" });
	assert.equal(overlay.hidden, true, "Shift+Esc inside the artboard exits Compare");
});

test("Compare offers scale to fit when the pair is wider than the window", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:3000/" } }) });
	const stage = canvas.document.getElementById("gd-compare-stage");
	stage.rect = { left: 0, top: 0, width: 500, height: 600 };
	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	const fit = canvas.document.getElementById("gd-compare-fit");
	const field = canvas.document.getElementById("gd-compare-fit-field");
	const panes = canvas.document.getElementById("gd-compare-panes");
	assert.equal(field.hidden, false, "two 400 px boards do not fit in 500 px");
	assert.equal(panes.style.transform, "none", "Compare starts at 100%");
	fit.checked = true;
	fit.dispatch("change");
	assert.match(panes.style.transform, /^scale\(0\.\d+\)$/);
	canvas.document.getElementById("gd-compare-back").dispatch("click");
	stage.rect = { left: 0, top: 0, width: 2000, height: 600 };
	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	assert.equal(field.hidden, true, "no toggle when the pair fits");
	assert.equal(panes.style.transform, "none");
});

test("an [::1] preview says browsers refuse to frame it, and keeps Open in new tab", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://[::1]:3000/" } }) });
	withClass(boardsOf(canvas)[0], "gd-compare-start")[0].dispatch("click");
	const message = canvas.document.getElementById("gd-compare-message");
	assert.equal(message.textContent, "Browsers do not frame [::1] under the canvas policy (CSP has no IPv6 sources): use Open in new tab, or report the preview on localhost.");
	assert.equal(canvas.document.getElementById("gd-compare-open").href, "http://[::1]:3000/");
});
