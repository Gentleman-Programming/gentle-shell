import assert from "node:assert/strict";
import test from "node:test";
import { click, loadCanvas } from "./support/design-canvas-dom.ts";

// S14: `open` while a canvas page is connected sends it a show event instead of opening a tab.

test("a show event for the same design re-fetches its manifest and reloads its artboards, keeping zoom, pan and focus", async () => {
	const canvas = await loadCanvas();
	// A laid-out world, so a fit() during the refresh would visibly change the view.
	Object.defineProperty(canvas.world, "offsetWidth", { get: () => 2000 });
	Object.defineProperty(canvas.world, "offsetHeight", { get: () => 900 });
	canvas.viewport.dispatch("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, clientX: 300, clientY: 300 });
	const view = canvas.world.style.transform;
	const zoom = canvas.zoomLevel.textContent;
	const before = canvas.frames();
	const manifestFetches = canvas.fetched.filter((url) => url === "/t/api/designs/alpha").length;
	// A file written while the page missed the change event: the refresh must still pick it up.
	(canvas.replies["/t/api/designs/alpha"] as { artboards: unknown[] }).artboards.push({ file: "03-c.html", title: "Third", tradeoff: "", width: 400, height: 300 });
	await canvas.serverEvent("show", { slug: "alpha" });
	assert.equal(canvas.fetched.filter((url) => url === "/t/api/designs/alpha").length, manifestFetches + 1, "the manifest is fetched again");
	const after = canvas.frames();
	assert.equal(after.length, 3, "the new artboard appears");
	assert.ok(after.every((frame) => !before.includes(frame)), "every artboard is reloaded");
	assert.equal(canvas.world.style.transform, view, "pan and zoom stay");
	assert.equal(canvas.zoomLevel.textContent, zoom);
	assert.equal(canvas.urls.at(-1), "/t/d/alpha/");

	// Focus mode survives a refresh of the same design, on the same artboard.
	const shield = canvas.frames()[0].parentElement!.children.find((child) => child.classes.has("gd-shield"))!;
	click(shield, 200, 200);
	assert.match(canvas.navMode.textContent, /^Using: First/);
	await canvas.serverEvent("show", { slug: "alpha" });
	assert.match(canvas.navMode.textContent, /^Using: First/, "focus stays on the same artboard");
	assert.equal(canvas.zoomLevel.textContent, "100%");
});

test("a show event for another design leaves focus, loads that design and replaces the URL", async () => {
	const canvas = await loadCanvas();
	const [first] = canvas.boards;
	click(first.shield!, 200, 200);
	assert.match(canvas.navMode.textContent, /^Using:/);
	await canvas.serverEvent("show", { slug: "beta" });
	assert.ok(canvas.fetched.includes("/t/api/designs/beta"), "the other design's manifest is loaded");
	assert.ok(canvas.fetched.includes("/t/api/designs/beta/comments"), "and its comments");
	assert.equal(canvas.urls.at(-1), "/t/d/beta/");
	assert.equal(canvas.document.getElementById("gd-title").textContent, "Beta");
	assert.equal(canvas.document.getElementById("gd-design").value, "beta", "the design selector follows");
	assert.equal(canvas.navMode.textContent, "Navigating", "focus mode ends when the design changes");
	assert.deepEqual(canvas.frames().map((frame) => frame.title), ["Only artboard"]);

	await canvas.serverEvent("show", { slug: null });
	assert.equal(canvas.urls.at(-1), "/t/", "null shows the system-only view at the root URL");
	assert.equal(canvas.document.getElementById("gd-title").textContent, "Gentle Design");
	assert.deepEqual(canvas.frames(), []);

	const fetches = canvas.fetched.length;
	for (const data of [{ slug: 3 }, {}, "beta", { slug: "../x" }]) await canvas.serverEvent("show", data);
	assert.equal(canvas.fetched.length, fetches, "a malformed show event is ignored");
});
