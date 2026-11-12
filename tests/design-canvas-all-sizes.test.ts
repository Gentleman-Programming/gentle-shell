import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DESIGN_VIEWPORT_LIMITS } from "../lib/design-comments.ts";
import { findAll, flush, inspectorPick, loadCanvas, read, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// All sizes (canvas-sizes.js): the focused artboard at Phone, Tablet and as designed at once, each a
// real iframe ("size frame") that takes picks and shows pins like the artboard's own frame; the
// Overflows chip a frame shows while its page is wider than it (inspector.js gd:overflow); and the
// size a comment was made at (its viewport), sent with the comment and shown on its card.
// Every assertion compares strings, numbers or booleans, never fake elements, which node:assert
// would walk whole on a failure.

/** First artboard 1200 x 800 so Desktop is the artboard's own width in the 1000 px test viewport. */
const WIDE_ALPHA = { "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [
	{ file: "01-a.html", title: "First", tradeoff: "", width: 1200, height: 800 },
	{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 },
] } };

async function loadSizes(replies: Record<string, unknown> = {}, firstHeight = 300) {
	const canvas = await loadCanvas(firstHeight, replies);
	// The fake DOM starts every element visible; index.html starts these hidden.
	for (const id of ["gd-popover", "gd-menu", "gd-device-menu"]) canvas.document.getElementById(id).hidden = true;
	return canvas;
}
type Canvas = Awaited<ReturnType<typeof loadSizes>>;

const $ = (canvas: Canvas, id: string) => canvas.document.getElementById(id);
// Enter on the shield opens the artboard in Comment mode too (a click there is a pick).
const focusOn = (canvas: Canvas, index = 0) => canvas.boards[index].shield!.dispatch("keydown", { key: "Enter" });
const back = (canvas: Canvas) => $(canvas, "gd-back").dispatch("click");
const commentMode = (canvas: Canvas) => $(canvas, "gd-comment").dispatch("click");
const tallViewport = (canvas: Canvas) => { canvas.viewport.rect = { left: 0, top: 50, width: 1000, height: 1400 }; };

const deviceButton = (canvas: Canvas) => $(canvas, "gd-device");
const deviceMenu = (canvas: Canvas) => $(canvas, "gd-device-menu");
const deviceItems = (canvas: Canvas) => findAll(deviceMenu(canvas), (element) => element.getAttribute("role") === "menuitemradio");
const openDevices = (canvas: Canvas) => { if (deviceMenu(canvas).hidden) deviceButton(canvas).dispatch("click"); };
const chooseSize = (canvas: Canvas, size: string) => {
	openDevices(canvas);
	deviceItems(canvas).find((item) => item.dataset.size === size)!.dispatch("click");
};
const pressedSizes = (canvas: Canvas) => {
	const closed = deviceMenu(canvas).hidden;
	openDevices(canvas);
	const sizes = deviceItems(canvas).filter((item) => item.getAttribute("aria-checked") === "true").map((item) => item.dataset.size);
	if (closed) deviceButton(canvas).dispatch("click");
	return sizes;
};
const readout = (canvas: Canvas) => [$(canvas, "gd-device-name").textContent, $(canvas, "gd-device-size").textContent].filter(Boolean).join(" ");
const setCustom = (canvas: Canvas, value: string) => {
	openDevices(canvas);
	const input = withClass(deviceMenu(canvas), "gd-device-input")[0];
	input.value = value;
	// A custom width applies on Enter only (leaving the field applies nothing).
	input.dispatch("keydown", { key: "Enter" });
};

const sizeSections = (canvas: Canvas) => withClass(canvas.viewport, "gd-size-frame");
const iframeOf = (root: FakeElement) => findAll(root, (element) => element.localName === "iframe")[0];
const overflowChip = (root: FakeElement) => withClass(root, "gd-overflow-flag")[0];
const report = (width: number, scrollWidth: number) => ({ type: "gd:overflow", overflow: scrollWidth > width, width, scrollWidth });
const scaleOf = (section: FakeElement) => Number(/^scale\(([\d.]+)\)$/.exec(withClass(section, "gd-size-stage")[0].style.transform)?.[1]);

function comment(id: string, file: string, status = "open", extra: Record<string, unknown> = {}) {
	return { id, file, selector: `main > .${id}`, excerpt: "", comment: `Text of ${id}`, status, sentAt: null, ...extra };
}
const commentsDoc = (...comments: unknown[]) => ({ "/t/api/designs/alpha/comments": { comments } });
async function setComments(canvas: Canvas, ...comments: unknown[]) {
	canvas.replies["/t/api/designs/alpha/comments"] = { comments };
	await canvas.serverEvent("change", { slug: "alpha", file: "comments.json" });
}
const lastOf = (frame: FakeElement, type: string) => frame.contentWindow!.posted.filter((message) => message.type === type).at(-1);
const commentPosts = (canvas: Canvas) => canvas.posts.filter((post) => post.url === "/t/api/comments").map((post) => post.body as Record<string, any>);

// ---- the frames (S3)

test("All sizes shows Phone, Tablet and the artboard as designed as real iframes at their true widths, scaled to fit together and labeled", async () => {
	const canvas = await loadSizes(WIDE_ALPHA);
	const [first] = canvas.boards;
	focusOn(canvas);
	const src = first.frame.src;
	openDevices(canvas);
	const all = deviceItems(canvas).find((item) => item.dataset.size === "all")!;
	assert.deepEqual(deviceItems(canvas).map((item) => item.dataset.size), ["phone", "tablet", "desktop", "all"], "All sizes comes after the presets");
	assert.equal(all.title, "All sizes: Phone, Tablet and the artboard as designed, side by side");
	assert.deepEqual(texts(all, "gd-menu-label"), ["All sizes"]);
	assert.deepEqual(texts(all, "gd-device-dim"), [], "no single size to show");
	assert.equal(withClass(all, "gd-i")[0].children[0].getAttribute("href"), "#i-devices");
	all.dispatch("click");
	assert.deepEqual(pressedSizes(canvas), ["all"]);
	assert.equal(readout(canvas), "All sizes");
	assert.equal($(canvas, "gd-device-icon").getAttribute("href"), "#i-devices");
	assert.equal(deviceButton(canvas).getAttribute("aria-label"), "Preview size: All sizes");
	assert.ok(first.wrapper.classes.has("gd-all-sizes"));

	const views = withClass(canvas.viewport, "gd-sizes-all");
	assert.equal(views.length, 1);
	assert.equal(canvas.viewport.children.filter((child) => child.classes.has("gd-sizes-all")).length, 1, "outside the transformed world");
	assert.equal(views[0].getAttribute("role"), "group");
	assert.equal(views[0].getAttribute("aria-label"), "All sizes");
	const sections = sizeSections(canvas);
	assert.deepEqual(sections.map((section) => section.getAttribute("aria-label")), ["Phone 390 by 844", "Tablet 820 by 1180", "As designed 1200 by 800"]);
	const frames = sections.map(iframeOf);
	assert.deepEqual(frames.map((frame) => [frame.style.width, frame.style.height]), [["390px", "844px"], ["820px", "1180px"], ["1200px", "800px"]]);
	for (const frame of frames) {
		assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
		assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
		assert.equal(frame.src, "/t/files/alpha/01-a.html");
	}
	assert.deepEqual(frames.map((frame) => frame.title), ["First artboard at Phone 390 × 844", "First artboard at Tablet 820 × 1180", "First artboard as designed, 1200 × 800"]);

	// One scale for the three, small enough that they fit the viewport together.
	const scales = sections.map(scaleOf);
	assert.ok(scales.every((scale) => scale === scales[0] && scale > 0 && scale < 1));
	const boxes = sections.map((section) => withClass(section, "gd-size-scaled")[0]);
	const widths = boxes.map((box) => Number.parseInt(box.style.width, 10));
	const heights = boxes.map((box) => Number.parseInt(box.style.height, 10));
	assert.deepEqual(widths, [390, 820, 1200].map((width) => Math.round(width * scales[0])));
	assert.deepEqual(heights, [844, 1180, 800].map((height) => Math.round(height * scales[0])));
	assert.ok(widths.reduce((sum, width) => sum + width, 0) <= 1000 - 16 - 40, "side by side within the viewport width, less the margins and gaps");
	// Below the 8 px margin and 8 px more, a 28 px band per label, and above the 48 px Back to canvas band.
	assert.ok(Math.max(...heights) <= 700 - 8 - 8 - 28 - 48, "and above the Back to canvas band");
	assert.deepEqual([views[0].style.left, views[0].style.right, views[0].style.top, views[0].style.bottom], ["8px", "8px", "16px", "48px"]);
	const percent = Math.round(scales[0] * 100);
	assert.deepEqual(sections.map((section) => texts(section, "gd-size-name")[0]), ["Phone", "Tablet", "As designed"], "L12: the third frame is the artboard as designed, never Desktop");
	assert.deepEqual(sections.map((section) => texts(section, "gd-size-dim")[0]), ["390 × 844", "820 × 1180", "1200 × 800"]);
	assert.deepEqual(sections.map((section) => texts(section, "gd-size-scale")[0]), [`· ${percent}%`, `· ${percent}%`, `· ${percent}%`]);
	assert.equal(withClass(sections[0], "gd-i").length, 1, "each label carries its icon");
	assert.deepEqual(sections.map((section) => withClass(section, "gd-i")[0].children[0].getAttribute("href")), ["#i-phone", "#i-tablet", "#i-fit"], "the artboard's own size, not a monitor");
	assert.equal(canvas.zoomLevel.textContent, "100%", "the label stays at 100% above the frames");

	assert.equal(first.frame.src, src, "the artboard's own iframe is not reloaded");
	chooseSize(canvas, "desktop");
	assert.equal(sizeSections(canvas).length, 0, "leaving All sizes removes the extra frames");
	assert.equal(withClass(canvas.viewport, "gd-sizes-all").length, 0);
	assert.ok(!first.wrapper.classes.has("gd-all-sizes"));
	assert.equal(first.frame.style.width, "1200px");
	assert.equal(first.frame.src, src);
});

test("Back to canvas and focusing another artboard leave All sizes and restore the manifest size", async () => {
	const canvas = await loadSizes({ ...WIDE_ALPHA, "/t/api/system": { exists: true, file: "system.html", width: 800, height: 600 } });
	// The system board comes first.
	const first = canvas.boards[1];
	focusOn(canvas, 1);
	chooseSize(canvas, "all");
	assert.equal(sizeSections(canvas).length, 3);
	back(canvas);
	assert.equal(sizeSections(canvas).length, 0);
	assert.equal(first.frame.style.width, "1200px");
	assert.ok(!first.wrapper.classes.has("gd-all-sizes"));
	assert.equal(readout(canvas), "Desktop");

	focusOn(canvas, 1);
	chooseSize(canvas, "all");
	// Settings > Design system board focuses another artboard.
	$(canvas, "gd-rail-settings").dispatch("click");
	findAll($(canvas, "gd-menu"), (element) => element.getAttribute("role") === "menuitem" && texts(element, "gd-menu-label")[0] === "Design system board")[0].dispatch("click");
	assert.equal(sizeSections(canvas).length, 0, "another artboard starts at Desktop");
	assert.ok(!first.wrapper.classes.has("gd-all-sizes"));
	assert.deepEqual(pressedSizes(canvas), ["desktop"]);
	// The system board shows at every size too, and takes no comments there.
	chooseSize(canvas, "all");
	assert.deepEqual(sizeSections(canvas).map((section) => section.getAttribute("aria-label")), ["Phone 390 by 844", "Tablet 820 by 1180", "As designed 800 by 600"]);
	assert.equal(iframeOf(sizeSections(canvas)[0]).src, "/t/system.html");
	commentMode(canvas);
	const phone = iframeOf(sizeSections(canvas)[0]);
	phone.dispatch("load");
	assert.deepEqual(lastOf(phone, "gd:mode"), { type: "gd:mode", enabled: false });
	assert.equal(phone.contentWindow!.posted.filter((message) => message.type === "gd:pins").length, 0, "no pins either");
	canvas.message(phone.contentWindow, inspectorPick(phone, { type: "gd:pick", selector: "#x", excerpt: "", rect: { x: 0, y: 0, width: 1, height: 1 } }));
	assert.equal($(canvas, "gd-popover").hidden, true);
});

test("All sizes follows the viewport and a manifest refresh, and live reload reloads the size frames", async () => {
	const canvas = await loadSizes(WIDE_ALPHA);
	focusOn(canvas);
	chooseSize(canvas, "all");
	const before = scaleOf(sizeSections(canvas)[0]);
	canvas.viewport.rect = { left: 0, top: 50, width: 700, height: 700 };
	canvas.windowEvent("resize");
	assert.ok(scaleOf(sizeSections(canvas)[0]) < before, "a narrower viewport scales the sizes down");
	assert.equal(sizeSections(canvas).length, 3, "the same frames, laid out again");

	await canvas.serverEvent("change", { slug: "alpha", file: "01-a.html" });
	assert.ok(sizeSections(canvas).map(iframeOf).every((frame) => /^\/t\/files\/alpha\/01-a\.html\?v=\d+$/.test(frame.src)), "every size frame reloads");
	assert.match(canvas.boards[0].frame.src, /^\/t\/files\/alpha\/01-a\.html\?v=\d+$/, "and the artboard's own frame");
	assert.equal(sizeSections(canvas).length, 3);

	await canvas.serverEvent("show", { slug: "alpha" });
	assert.equal(sizeSections(canvas).length, 3, "a refresh keeps All sizes, with no orphaned frames");
	assert.equal(canvas.viewport.children.filter((child) => child.classes.has("gd-sizes-all")).length, 1);
	assert.deepEqual(pressedSizes(canvas), ["all"]);
	assert.ok(canvas.world.children[0].classes.has("gd-all-sizes"), "the refreshed artboard wears it");
});

test("E5: the server switching to the system-only view leaves no All sizes frames behind", async () => {
	const canvas = await loadSizes({ ...WIDE_ALPHA, "/t/api/system": { exists: true, file: "system.html", width: 800, height: 600 } });
	focusOn(canvas, 1);
	chooseSize(canvas, "all");
	assert.equal(withClass(canvas.viewport, "gd-sizes-all").length, 1);
	await canvas.serverEvent("show", { slug: null });
	assert.equal(withClass(canvas.viewport, "gd-sizes-all").length, 0, "no size frames left in the viewport");
	assert.equal(sizeSections(canvas).length, 0);
	assert.equal(canvas.navMode.textContent, "Navigating");
	assert.equal(canvas.world.children.length, 1, "only the system board is shown");
	assert.equal(canvas.world.children.filter((child) => child.classes.has("gd-all-sizes")).length, 0);
});

test("size frames are registered like the artboard's frame: they get focus, mode and pins when they load", async () => {
	const canvas = await loadSizes({ ...WIDE_ALPHA, ...commentsDoc(comment("a1", "01-a.html")) });
	focusOn(canvas);
	chooseSize(canvas, "all");
	const frames = sizeSections(canvas).map(iframeOf);
	for (const frame of frames) {
		frame.dispatch("load");
		assert.deepEqual(lastOf(frame, "gd:focus"), { type: "gd:focus", enabled: true });
		assert.deepEqual(lastOf(frame, "gd:mode"), { type: "gd:mode", enabled: false });
		assert.deepEqual(lastOf(frame, "gd:pins"), { type: "gd:pins", pins: [{ id: "a1", selector: "main > .a1" }] });
	}
	commentMode(canvas);
	for (const frame of frames) assert.deepEqual(frame.contentWindow!.posted.at(-1), { type: "gd:mode", enabled: true });
	assert.ok(withClass(canvas.viewport, "gd-sizes-all")[0].classes.has("gd-commenting"), "the frames wear the comment-mode outline");
	$(canvas, "gd-tool-navigate").dispatch("click");
	for (const frame of frames) assert.deepEqual(frame.contentWindow!.posted.at(-1), { type: "gd:mode", enabled: false });
	assert.ok(!withClass(canvas.viewport, "gd-sizes-all")[0].classes.has("gd-commenting"));
	// Frames made while Comment mode is on start with the outline.
	commentMode(canvas);
	chooseSize(canvas, "phone");
	chooseSize(canvas, "all");
	assert.ok(withClass(canvas.viewport, "gd-sizes-all")[0].classes.has("gd-commenting"));
	back(canvas);
	for (const frame of frames) assert.deepEqual(lastOf(frame, "gd:focus"), { type: "gd:focus", enabled: true }, "removed frames hear nothing more");
});

// ---- picks and pins (S4)

const PICK = { type: "gd:pick", selector: "#cta", excerpt: "Buy", rect: { x: 30, y: 40, width: 60, height: 20 } };

test("in All sizes every size frame takes picks; the popover opens beside the picked element in that frame", async () => {
	const canvas = await loadSizes(WIDE_ALPHA);
	focusOn(canvas);
	chooseSize(canvas, "all");
	const [phone, tablet, designed] = sizeSections(canvas).map(iframeOf);
	const popover = $(canvas, "gd-popover");

	canvas.message(phone.contentWindow, inspectorPick(phone, PICK));
	assert.equal(popover.hidden, true, "a pick needs Comment mode");
	commentMode(canvas);
	canvas.message({}, PICK);
	assert.equal(popover.hidden, true, "a stranger window is ignored");

	phone.rect = { left: 100, top: 200, width: 150, height: 325 };
	canvas.message(phone.contentWindow, inspectorPick(phone, PICK));
	assert.equal(popover.hidden, false);
	assert.equal($(canvas, "gd-popover-target").textContent, "01-a.html · #cta");
	// The frame is shown at 150/390 of its width.
	assert.equal(popover.style.left, `${100 + 30 * (150 / 390)}px`);
	assert.equal(popover.style.top, `${200 + (40 + 20) * (150 / 390) + 8}px`);

	$(canvas, "gd-popover-text").value = "Tighter";
	$(canvas, "gd-popover-form").dispatch("submit");
	await flush();
	assert.deepEqual(commentPosts(canvas).map((body) => [body.slug, body.file, body.selector]), [["alpha", "01-a.html", "#cta"]]);

	$(canvas, "gd-popover-cancel").dispatch("click");
	assert.deepEqual(phone.contentWindow!.posted.at(-1), { type: "gd:clear" }, "the frame that was picked clears its outline");
	designed.rect = { left: 300, top: 100, width: 400, height: 267 };
	canvas.message(designed.contentWindow, inspectorPick(designed, PICK));
	assert.equal(popover.hidden, false, "the as designed frame takes picks too");
	assert.equal(popover.style.left, `${300 + 30 * (400 / 1200)}px`);
	assert.match(canvas.navMode.textContent, /^Using:/);
	canvas.message(tablet.contentWindow, { type: "gd:exit-focus" });
	assert.doesNotMatch(canvas.navMode.textContent, /^Using:/, "Shift+Esc from a size frame leaves focus mode");
	assert.equal(sizeSections(canvas).length, 0);
	assert.equal(popover.hidden, true);
});

test("a pick from another artboard is refused while one is focused, also with its size frames shown", async () => {
	const canvas = await loadSizes(WIDE_ALPHA);
	focusOn(canvas);
	chooseSize(canvas, "all");
	commentMode(canvas);
	canvas.message(canvas.boards[1].frame.contentWindow, inspectorPick(canvas.boards[1].frame, { type: "gd:pick", selector: "#x", excerpt: "", rect: { x: 0, y: 0, width: 1, height: 1 } }));
	assert.equal($(canvas, "gd-popover").hidden, true);
	// A frame that was removed is a stranger.
	const [phone] = sizeSections(canvas).map(iframeOf);
	chooseSize(canvas, "tablet");
	canvas.message(phone.contentWindow, inspectorPick(phone, PICK));
	assert.equal($(canvas, "gd-popover").hidden, true);
});

test("a wheel from a size frame lands where it is under the pointer, at that frame's scale", async () => {
	const canvas = await loadSizes(WIDE_ALPHA);
	focusOn(canvas);
	chooseSize(canvas, "all");
	const [phone] = sizeSections(canvas).map(iframeOf);
	phone.rect = { left: 100, top: 200, width: 195, height: 422 };
	const before = canvas.world.style.transform;
	// Focus mode keeps the canvas still: the forwarded wheel is accepted and changes nothing.
	canvas.message(phone.contentWindow, { type: "gd:wheel", deltaX: 0, deltaY: 40, deltaMode: 0, zoom: false, shift: false, x: 10, y: 10 });
	assert.equal(canvas.world.style.transform, before);
	assert.match(read("canvas-messages.js"), /frameRect\.width \/ surface\.viewWidth/, "the scale is the frame's own width");
});

test("the pins of the artboard show on every size frame at their element's position in that frame", async () => {
	const canvas = await loadSizes({ ...WIDE_ALPHA, ...commentsDoc(comment("a1", "01-a.html"), comment("b1", "02-b.html")) });
	focusOn(canvas);
	chooseSize(canvas, "all");
	const sections = sizeSections(canvas);
	const [phone, tablet, desktop] = sections.map(iframeOf);
	const pinsOf = (section: FakeElement) => withClass(section, "gd-pin");
	assert.deepEqual(sections.map((section) => pinsOf(section).length), [0, 0, 0], "none until a frame reports where the element is");

	canvas.message(phone.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 30, y: 40, width: 60, height: 20 } }] });
	canvas.message(desktop.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 300, y: 10, width: 60, height: 20 } }] });
	assert.deepEqual(pinsOf(sections[0]).map((pin) => [pin.style.left, pin.style.top, pin.textContent]), [["30px", "40px", "1"]]);
	assert.equal(pinsOf(sections[1]).length, 0, "the Tablet frame has not reported yet");
	assert.deepEqual(pinsOf(sections[2]).map((pin) => [pin.style.left, pin.style.top]), [["300px", "10px"]]);
	assert.equal(pinsOf(sections[0])[0].getAttribute("aria-label"), "Comment 1 (open): Text of a1");
	assert.equal(withClass(canvas.boards[0].wrapper, "gd-pin").length, 0, "a size frame's report never pins the artboard's own frame");

	// An element outside the frame at that size has no pin there; the other artboard's comments never show.
	canvas.message(tablet.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 900, y: 10, width: 60, height: 20 } }, { id: "b1", rect: { x: 5, y: 5, width: 5, height: 5 } }] });
	assert.equal(pinsOf(sections[1]).length, 0);
	canvas.message(phone.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 500, y: 40, width: 60, height: 20 } }] });
	assert.equal(pinsOf(sections[0]).length, 0, "x 500 is outside the 390 px frame");
	canvas.message(phone.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 30, y: 40, width: 60, height: 20 } }] });

	// Only the artboard's own frame says whether a comment is detached.
	canvas.message(phone.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: null }] });
	assert.equal(texts($(canvas, "gd-comment-list"), "gd-badge-detached").length, 0);
	canvas.message(phone.contentWindow, { type: "gd:pin-rects", rects: [{ id: "a1", rect: { x: 30, y: 40, width: 60, height: 20 } }] });

	// Selecting a pin highlights the element in every frame.
	pinsOf(sections[0])[0].dispatch("click");
	for (const frame of [phone, tablet, desktop, canvas.boards[0].frame]) assert.deepEqual(frame.contentWindow!.posted.at(-1), { type: "gd:highlight", id: "a1" });

	// New comments reach every frame.
	await setComments(canvas, comment("a1", "01-a.html"), comment("a2", "01-a.html"));
	for (const frame of [phone, tablet, desktop]) assert.equal(lastOf(frame, "gd:pins").pins.length, 2);
	assert.equal(pinsOf(sizeSections(canvas)[0]).length, 1, "the pins are drawn again with the new list");
});

// ---- the Overflows chip (S5)

test("a size whose page is wider than its frame shows an Overflows chip titled with the width; none when it fits", async () => {
	const canvas = await loadSizes();
	tallViewport(canvas);
	const [first] = canvas.boards;
	const chip = overflowChip(first.wrapper);
	assert.equal(chip.hidden, true);
	assert.equal(chip.parentElement === first.frame.parentElement, true, "it sits on the artboard's frame");
	focusOn(canvas);
	chooseSize(canvas, "phone");
	assert.equal(chip.hidden, true, "no chip before the page reports");

	canvas.message(first.frame.contentWindow, report(390, 520));
	assert.equal(chip.hidden, false);
	assert.deepEqual(texts(chip, "gd-overflow-text"), ["Overflows"]);
	assert.equal(chip.title, "Content is wider than 390 px, so part of it is cut off or needs sideways scrolling at this size.");
	assert.deepEqual(texts(chip, "gd-visually-hidden"), [chip.title], "the explanation reaches assistive technology too");

	canvas.message(first.frame.contentWindow, report(390, 390));
	assert.equal(chip.hidden, true, "no chip when it fits");
	canvas.message(first.frame.contentWindow, report(390, 520));
	assert.equal(chip.hidden, false);

	// Reports for another width are stale; strangers and malformed reports are ignored.
	chooseSize(canvas, "tablet");
	assert.equal(chip.hidden, true, "a new size clears the chip until the page reports again");
	canvas.message(first.frame.contentWindow, report(390, 520));
	assert.equal(chip.hidden, true, "a late report for the previous width is ignored");
	canvas.message({}, report(820, 900));
	assert.equal(chip.hidden, true);
	canvas.message(first.frame.contentWindow, { type: "gd:overflow", overflow: true, width: "820", scrollWidth: 900 });
	canvas.message(first.frame.contentWindow, { type: "gd:overflow", overflow: "yes", width: 820, scrollWidth: 900 });
	canvas.message(first.frame.contentWindow, { type: "gd:overflow", overflow: true, width: 820, scrollWidth: null });
	assert.equal(chip.hidden, true);
	canvas.message(first.frame.contentWindow, report(820, 900));
	assert.match(chip.title, /wider than 820 px/);
	assert.equal(chip.hidden, false);
	first.frame.dispatch("load");
	assert.equal(chip.hidden, true, "a reloaded artboard reports again");
});

test("in All sizes each size frame has its own chip", async () => {
	const canvas = await loadSizes(WIDE_ALPHA);
	focusOn(canvas);
	chooseSize(canvas, "all");
	const sections = sizeSections(canvas);
	const [phone, tablet, desktop] = sections.map(iframeOf);
	assert.deepEqual(sections.map((section) => overflowChip(section).hidden), [true, true, true]);
	canvas.message(tablet.contentWindow, report(820, 1010));
	assert.deepEqual(sections.map((section) => overflowChip(section).hidden), [true, false, true]);
	assert.match(overflowChip(sections[1]).title, /wider than 820 px/);
	canvas.message(phone.contentWindow, report(390, 390));
	canvas.message(desktop.contentWindow, report(1200, 1200));
	assert.deepEqual(sections.map((section) => overflowChip(section).hidden), [true, false, true]);
	canvas.message(tablet.contentWindow, report(820, 820));
	assert.deepEqual(sections.map((section) => overflowChip(section).hidden), [true, true, true]);
	canvas.message(tablet.contentWindow, report(820, 1010));
	tablet.dispatch("load");
	assert.equal(overflowChip(sections[1]).hidden, true, "a reloaded frame reports again");
});

test("the artboard's own chip shows only while focused at a single size, and a report made earlier shows on focus", async () => {
	// canvas-layout S8: Desktop is the artboard's own width only when it is wider than the viewport, so a 1200 px one here.
	const canvas = await loadSizes(WIDE_ALPHA);
	const [first] = canvas.boards;
	const chip = overflowChip(first.wrapper);
	canvas.message(first.frame.contentWindow, report(1200, 1250));
	assert.equal(chip.hidden, true, "not on the canvas overview");
	focusOn(canvas);
	assert.equal(chip.hidden, false, "Desktop is 1200 px wide: the earlier report applies");
	chooseSize(canvas, "all");
	assert.equal(chip.hidden, true, "All sizes has a chip per frame instead");
	back(canvas);
	assert.equal(chip.hidden, true);
});

test("the system board never shows the chip", async () => {
	const canvas = await loadSizes({ "/t/api/system": { exists: true, file: "system.html", width: 800, height: 600 } });
	const [system] = canvas.boards;
	focusOn(canvas, 0);
	tallViewport(canvas);
	chooseSize(canvas, "phone");
	canvas.message(system.frame.contentWindow, report(390, 520));
	assert.equal(overflowChip(system.wrapper).hidden, true);
});

// ---- the size a comment was made at (S7)

const submitComment = async (canvas: Canvas, text = "Tighter") => {
	$(canvas, "gd-popover-text").value = text;
	$(canvas, "gd-popover-form").dispatch("submit");
	await flush();
	return commentPosts(canvas).at(-1)!;
};

test("L12: a comment made at the manifest size or at Desktop carries no viewport: Desktop is the window's width, not a size of the design", async () => {
	const canvas = await loadSizes();
	tallViewport(canvas);
	const [first] = canvas.boards;
	commentMode(canvas);
	first.frame.rect = { left: 0, top: 0, width: 400, height: 300 };
	canvas.message(first.frame.contentWindow, inspectorPick(first.frame, PICK));
	assert.equal("viewport" in await submitComment(canvas), false, "not focused");
	focusOn(canvas);
	first.frame.rect = { left: 0, top: 0, width: 984, height: 300 };
	canvas.message(first.frame.contentWindow, inspectorPick(first.frame, PICK));
	assert.equal($(canvas, "gd-device-size").textContent, "984 × 300", "Desktop fills the window here (canvas-layout S8)");
	assert.equal("viewport" in await submitComment(canvas), false, "Desktop records no size");
	// A custom width equal to the manifest width is the manifest size too.
	setCustom(canvas, "400");
	canvas.message(first.frame.contentWindow, inspectorPick(first.frame, PICK));
	assert.equal("viewport" in await submitComment(canvas), false);
});

test("a comment at a preset or custom width carries the viewport of that size, with the manifest height for a custom width", async () => {
	const canvas = await loadSizes();
	tallViewport(canvas);
	const [first] = canvas.boards;
	focusOn(canvas);
	commentMode(canvas);
	first.frame.rect = { left: 0, top: 0, width: 390, height: 844 };
	const sizes: Array<Array<string | number>> = [];
	const viewportOf = async () => {
		canvas.message(first.frame.contentWindow, inspectorPick(first.frame, PICK));
		const { viewport } = await submitComment(canvas);
		return viewport ? [viewport.width, viewport.height] : ["none"];
	};
	chooseSize(canvas, "phone");
	sizes.push(["phone", ...(await viewportOf())]);
	chooseSize(canvas, "tablet");
	sizes.push(["tablet", ...(await viewportOf())]);
	setCustom(canvas, "720");
	sizes.push(["custom", ...(await viewportOf())]);
	// The size is the one at the pick: back at Desktop the next comment records none (L12).
	chooseSize(canvas, "desktop");
	sizes.push(["desktop", ...(await viewportOf())]);
	assert.deepEqual(sizes, [["phone", 390, 844], ["tablet", 820, 1180], ["custom", 720, 300], ["desktop", "none"]]);
});

test("S27: a pick made at Phone whose reply arrives after the switch to Tablet opens no comment box and posts nothing; a pick made at the current size still posts it", async () => {
	const canvas = await loadSizes();
	tallViewport(canvas);
	const [first] = canvas.boards;
	focusOn(canvas);
	commentMode(canvas);
	first.frame.rect = { left: 0, top: 0, width: 390, height: 844 };
	const sent = (body: Record<string, any> | undefined) => (body?.viewport ? `${body.viewport.width} × ${body.viewport.height}` : "none");
	chooseSize(canvas, "phone");
	canvas.message(first.frame.contentWindow, inspectorPick(first.frame, PICK));
	assert.equal(sent(await submitComment(canvas)), "390 × 844", "a pick made and received at Phone");

	// The page picks at Phone; the reply is still on its way when Tablet resizes the frame.
	const madeAtPhone = inspectorPick(first.frame, PICK);
	chooseSize(canvas, "tablet");
	canvas.message(first.frame.contentWindow, madeAtPhone);
	assert.equal($(canvas, "gd-popover").hidden, true, "the stale pick opens no comment box");
	const before = commentPosts(canvas).length;
	await submitComment(canvas);
	assert.equal(commentPosts(canvas).length, before, "nothing is posted for it");
	assert.ok(!commentPosts(canvas).some((body) => sent(body) === "820 × 1180"), "no comment made at Phone is sent as Tablet");

	// A pick the page makes once it heard of the new size is Tablet's.
	canvas.message(first.frame.contentWindow, inspectorPick(first.frame, PICK));
	assert.equal(sent(await submitComment(canvas)), "820 × 1180");
	// A pick with no generation cannot say which size it was made at: it is refused too.
	chooseSize(canvas, "phone");
	canvas.message(first.frame.contentWindow, PICK);
	assert.equal($(canvas, "gd-popover").hidden, true, "a pick without a generation is refused");
});

test("in All sizes the comment carries the size of the frame that was picked; the as designed frame is the manifest size", async () => {
	const canvas = await loadSizes();
	focusOn(canvas);
	chooseSize(canvas, "all");
	commentMode(canvas);
	const frames = sizeSections(canvas).map(iframeOf);
	const sent: Array<string> = [];
	for (const frame of frames) {
		frame.rect = { left: 100, top: 100, width: 100, height: 100 };
		canvas.message(frame.contentWindow, inspectorPick(frame, PICK));
		const body = await submitComment(canvas);
		sent.push(body.viewport ? `${body.viewport.width} × ${body.viewport.height}` : "none");
	}
	assert.deepEqual(sent, ["390 × 844", "820 × 1180", "none"], "as designed = the 400 × 300 manifest size");
	// The artboard's own frame is hidden in All sizes; a pick from it records no size.
	canvas.message(canvas.boards[0].frame.contentWindow, inspectorPick(canvas.boards[0].frame, PICK));
	assert.equal("viewport" in await submitComment(canvas), false);
});

test("a viewport the server would refuse is left out of the request instead of failing the comment", async () => {
	const canvas = await loadSizes({}, 30000);
	tallViewport(canvas);
	const [first] = canvas.boards;
	focusOn(canvas);
	commentMode(canvas);
	setCustom(canvas, "600");
	first.frame.rect = { left: 0, top: 0, width: 600, height: 700 };
	canvas.message(first.frame.contentWindow, inspectorPick(first.frame, PICK));
	assert.equal("viewport" in await submitComment(canvas), false, "30000 px is beyond the 20000 px the file accepts");
});

test("the comment card shows the size it was made at: Phone, Tablet or width × height, and nothing without one", async () => {
	const canvas = await loadSizes(commentsDoc(
		comment("a1", "01-a.html", "open", { viewport: { width: 390, height: 844 } }),
		comment("a2", "01-a.html", "open", { viewport: { width: 820, height: 1180 } }),
		comment("a3", "01-a.html", "open", { viewport: { width: 720, height: 820 } }),
		comment("a4", "01-a.html"),
		comment("a5", "01-a.html", "open", { viewport: { width: "wide", height: 820 } }),
	));
	const list = $(canvas, "gd-comment-list");
	assert.equal(list.children.length, 5);
	assert.deepEqual(list.children.map((item) => texts(item, "gd-comment-viewport")), [["Phone 390 × 844"], ["Tablet 820 × 1180"], ["720 × 820"], [], []]);
	assert.equal(withClass(list.children[0], "gd-comment-viewport")[0].title, "Made at Phone 390 × 844");
	await setComments(canvas, comment("a1", "01-a.html", "resolved", { viewport: { width: 390, height: 844 } }));
	$(canvas, "gd-filter-resolved").dispatch("click");
	assert.deepEqual(list.children.map((item) => texts(item, "gd-comment-viewport")), [["Phone 390 × 844"]]);
});

// ---- source pins, markup and styles

test("E4: the client's viewport limits and the Phone and Tablet presets match what comments.json accepts and names (lib/design-comments.ts)", () => {
	const sizes = read("canvas-sizes.js");
	const server = readFileSync(fileURLToPath(new URL("../lib/design-comments.ts", import.meta.url)), "utf8");
	const numbers = (text: string) => Object.fromEntries([...text.matchAll(/(\w+): (\d+)/g)].map((match) => [match[1], Number(match[2])]));
	const limits = /const VIEWPORT_LIMITS = (\{[^}]*\});/.exec(sizes);
	assert.ok(limits, "canvas-sizes.js declares VIEWPORT_LIMITS");
	assert.deepEqual(Object.entries(numbers(limits[1])), Object.entries(DESIGN_VIEWPORT_LIMITS));
	const clientPresets = /const SIZE_PRESETS = \[([^]*?)\];/.exec(sizes);
	const serverPresets = /const VIEWPORT_PRESETS[^=]*= \[([^]*?)\];/.exec(server);
	assert.ok(clientPresets && serverPresets, "both declare their presets");
	const nameOf = (kind: string) => new RegExp(`\\n\\t${kind}: "([^"]+)",`).exec(sizes)?.[1];
	const client = [...clientPresets[1].matchAll(/\{ kind: "(\w+)", width: (\d+), height: (\d+) \}/g)].map((match) => `${nameOf(match[1])} ${match[2]} × ${match[3]}`);
	const named = [...serverPresets[1].matchAll(/\{ name: "(\w+)", width: (\d+), height: (\d+) \}/g)].map((match) => `${match[1]} ${match[2]} × ${match[3]}`);
	assert.deepEqual(client, ["Phone 390 × 844", "Tablet 820 × 1180"]);
	assert.deepEqual(named, client, "the server names the same sizes the card names");
});

test("All sizes keeps the module rules: state through the store, board fields documented, English strings in TEXT", () => {
	const sizes = read("canvas-sizes.js");
	assert.ok(sizes.indexOf("const TEXT = Object.freeze({") < sizes.indexOf("export function init"), "the strings sit in one TEXT block before init");
	for (const literal of ["All sizes", "Overflows", "Made at"]) assert.ok(sizes.slice(0, sizes.indexOf("export function init")).includes(literal), `${literal} is in TEXT`);
	assert.ok(!/\bstate\.size\s*=(?!=)/.test(sizes));
	assert.ok(!/data-i18n|\bloc\(|\bt\(/.test(sizes));
	assert.match(sizes, /setAttribute\("sandbox", "allow-scripts"\)/, "size frames keep the scripts-only sandbox");
	assert.ok(!/setAttribute\("style"|\.cssText/.test(sizes), "styles go through the CSSOM");
	const store = read("canvas-store.js");
	for (const field of ["board.sizeFrames", "board.sizesView", "board.overflow"]) assert.ok(store.includes(field), `canvas-store.js documents ${field} as changed in place`);
	assert.match(store, /"all"/, "the size kinds include all");
	const messages = read("canvas-messages.js");
	assert.match(messages, /gd:overflow/);
	assert.match(messages, /candidate\.frame\.contentWindow === event\.source/, "a frame is trusted only by its window");
	// E6: canvas-sizes.js owns a frame's overflow; the other modules change it through setOverflow.
	for (const name of ["canvas-messages.js", "canvas-focus.js", "canvas-boards.js"]) {
		assert.ok(!/\.overflow\s*=(?!=)/.test(read(name)), `${name} never assigns an overflow`);
	}
	assert.equal(sizes.match(/\.overflow\s*=(?!=)/g)?.length, 1, "one assignment, in setOverflow");
	assert.match(messages, /actions\.setOverflow\(surface, /);
});

test("index.html has the All sizes icon, and canvas.css styles the frames, the chip and the comment's size in the Sizes section on --gd-* tokens", () => {
	const html = read("index.html");
	assert.match(html, /<symbol id="i-devices" viewBox="0 0 24 24">/);
	assert.ok(!/data-i18n/.test(html));
	const css = read("canvas.css");
	const start = css.indexOf("/* Screen sizes (canvas-sizes.js)");
	assert.ok(start >= 0 && css.split("/* Screen sizes (canvas-sizes.js)").length === 2, "one Sizes section");
	// It runs until the next module's section, Export.
	const section = css.slice(start, css.indexOf("\n/* Export (canvas-export.js)", start));
	const block = (selector: string) => {
		const at = section.indexOf(`\n${selector} {`);
		assert.ok(at >= 0, `${selector} is styled in the Sizes section`);
		return section.slice(at, section.indexOf("}", at) + 1);
	};
	for (const selector of [".gd-sizes-all", ".gd-size-frame", ".gd-size-head", ".gd-size-scaled", ".gd-size-stage", ".gd-size-iframe", ".gd-overflow-flag", ".gd-comment-viewport"]) {
		const text = block(selector);
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(text), `${selector}: tokens only`);
		assert.ok(!/var\(--(?!gd-)/.test(text), `${selector}: only --gd-* tokens`);
		assert.ok(!/transition|animation/.test(text), `${selector}: no motion`);
	}
	assert.match(section, /\.gd-all-sizes \.gd-frame-box \{ visibility: hidden; \}/, "the artboard's own frame stays loaded but hidden");
	assert.match(section, /\.gd-commenting \.gd-size-scaled[^{]*{[^}]*outline:[^}]*var\(--gd-accent\)/);
	assert.match(section, /\.gd-exporting \.gd-overflow-flag \{ visibility: hidden; \}/);
	assert.ok(!/border-radius:\s*50%/.test(section), "S4: no dots");
});
