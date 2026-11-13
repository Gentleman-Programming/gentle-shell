import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { click, findAll, inspectorPick, loadCanvas, read, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// Screen sizes in focus mode (canvas-sizes.js): the top bar's device button and its menu
// (Phone, Tablet, Desktop and a custom width), the focused artboard's frame at that size,
// and the focus geometry it needs (canvas-focus.js): 8 px margins, a 48 px band for Back to
// canvas, Desktop as wide as the window. Every assertion compares strings, numbers or
// booleans, never fake elements, which node:assert would walk whole on a failure.

/** First artboard 1200 x 800 so Desktop is wider than the 1000 px test viewport. */
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
const focusOn = (canvas: Canvas, index = 0) => click(canvas.boards[index].shield!, 200, 200);
const back = (canvas: Canvas) => $(canvas, "gd-back").dispatch("click");
const tallViewport = (canvas: Canvas) => { canvas.viewport.rect = { left: 0, top: 50, width: 1000, height: 1400 }; };
const keyOn = (target: FakeElement, key: string) => target.dispatch("keydown", { key, shiftKey: false });
const isActive = (canvas: Canvas, element: FakeElement | undefined) => canvas.document.activeElement === element;

const deviceButton = (canvas: Canvas) => $(canvas, "gd-device");
const deviceMenu = (canvas: Canvas) => $(canvas, "gd-device-menu");
const deviceItems = (canvas: Canvas) => findAll(deviceMenu(canvas), (element) => element.getAttribute("role") === "menuitemradio");
const openDevices = (canvas: Canvas) => { if (deviceMenu(canvas).hidden) deviceButton(canvas).dispatch("click"); };
const chooseSize = (canvas: Canvas, size: string) => {
	openDevices(canvas);
	deviceItems(canvas).find((item) => item.dataset.size === size)!.dispatch("click");
};
/** The checked items of the device menu, read with the menu open, then closed again when it was closed. */
const pressedSizes = (canvas: Canvas) => {
	const closed = deviceMenu(canvas).hidden;
	openDevices(canvas);
	const sizes = deviceItems(canvas).filter((item) => item.getAttribute("aria-checked") === "true").map((item) => item.dataset.size);
	if (closed) deviceButton(canvas).dispatch("click");
	return sizes;
};
/** What the device button reads: the size's short name and, in focus mode, its width × height. */
const readout = (canvas: Canvas) => [$(canvas, "gd-device-name").textContent, $(canvas, "gd-device-size").textContent].filter(Boolean).join(" ");
const deviceIcon = (canvas: Canvas) => $(canvas, "gd-device-icon").getAttribute("href");
const customInput = (canvas: Canvas) => {
	openDevices(canvas);
	return withClass(deviceMenu(canvas), "gd-device-input")[0];
};
const customRow = (canvas: Canvas) => withClass(deviceMenu(canvas), "gd-device-custom")[0];
const sizeError = (canvas: Canvas) => withClass(deviceMenu(canvas), "gd-device-error")[0];
/** Types a width in the custom field and presses Enter, the only key that applies it. */
const setCustom = (canvas: Canvas, value: string) => {
	const input = customInput(canvas);
	input.value = value;
	input.dispatch("keydown", { key: "Enter" });
	return input;
};
const frameSize = (canvas: Canvas, index = 0) => [canvas.boards[index].frame.style.width, canvas.boards[index].frame.style.height];

// ---- focus geometry (canvas-layout S5 and S8)

test("canvas-layout S8: Desktop fills the viewport's width at 100% in focus, the fixed sizes keep theirs, and the other artboards are hidden", async () => {
	const canvas = await loadSizes();
	focusOn(canvas);
	// A 400 px artboard in the 1000 px viewport: Desktop is 1000 - 2 * 8 wide, at 100%, from the left margin.
	assert.deepEqual(frameSize(canvas), ["984px", "300px"]);
	assert.equal(canvas.zoomLevel.textContent, "100%");
	assert.equal(canvas.world.style.transform, "translate(8px, 200px) scale(1)");
	assert.equal(readout(canvas), "Desktop 984 × 300");
	chooseSize(canvas, "phone");
	assert.deepEqual(frameSize(canvas), ["390px", "644px"], "844 px is clipped to the 700 px viewport less its 8 px margin and the 48 px band");
	chooseSize(canvas, "desktop");
	assert.deepEqual(frameSize(canvas), ["984px", "300px"]);
	// A wider window widens Desktop with it.
	canvas.viewport.rect = { left: 0, top: 50, width: 1600, height: 700 };
	canvas.windowEvent("resize");
	assert.equal(canvas.boards[0].frame.style.width, "1584px");
	assert.equal(readout(canvas), "Desktop 1584 × 300", "the button follows the window");
	back(canvas);
	assert.deepEqual(frameSize(canvas), ["400px", "300px"], "leaving focus restores the artboard's own size");
	assert.match(read("canvas.css"), /\.gd-focused \.gd-world > :not\(\.gd-focus-board\) \{ visibility: hidden; \}/);
});

test("canvas-layout S5: a tall artboard keeps 8 px margins and a 48 px band for Back to canvas, idempotently", async () => {
	const canvas = await loadSizes({}, 1600);
	const [first] = canvas.boards;
	first.frame.parentElement!.offsetLeft = 480;
	first.frame.parentElement!.offsetTop = 20;
	focusOn(canvas);
	// 700 - (8 + 20) - 48 = 624 px of frame; x puts Desktop at the left margin: 8 - 480; y its top 8 + 20 px down: 28 - 20.
	assert.deepEqual(frameSize(canvas), ["984px", "624px"]);
	assert.equal(canvas.world.style.transform, "translate(-472px, 8px) scale(1)");
	canvas.windowEvent("resize");
	assert.equal(canvas.world.style.transform, "translate(-472px, 8px) scale(1)");
	back(canvas);
	assert.deepEqual(frameSize(canvas), ["400px", "1600px"]);
});

test("canvas-layout S5: an artboard wider than the window is drawn smaller to fit from the 8 px margin, and centered when it fits", async () => {
	const canvas = await loadSizes({ "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [
		{ file: "01-a.html", title: "First", tradeoff: "", width: 1440, height: 900 },
		{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 },
	] } });
	const [first] = canvas.boards;
	first.frame.parentElement!.offsetTop = 32;
	focusOn(canvas);
	// 1440 px drawn into 1000 - 2 * 8: 68%; 900 * 0.68 = 615 px fits under the 8 px margin and the 32 px label (22 px on screen), above the 48 px band.
	const zoom = 984 / 1440;
	assert.equal(canvas.zoomLevel.textContent, "68%");
	assert.deepEqual(frameSize(canvas), ["1440px", "900px"], "the design still renders at its real width");
	assert.equal(canvas.world.style.transform, `translate(8px, ${Math.round((700 - 900 * zoom) / 2 - 32 * zoom)}px) scale(${zoom})`);
	assert.equal(readout(canvas), "Desktop 1440 × 900");
});

test("canvas-layout S5: the label above the frame is measured at the focused width, so one that wraps narrower keeps its space", async () => {
	const canvas = await loadSizes();
	const [first] = canvas.boards;
	const box = first.frame.parentElement!;
	// The label wraps to two lines once the frame is narrower than 400 px: 40 px above the frame instead of 20.
	Object.defineProperty(box, "offsetTop", { configurable: true, get: () => (Number.parseInt(String(first.frame.style.width), 10) < 400 ? 40 : 20) });
	focusOn(canvas);
	chooseSize(canvas, "phone");
	// 700 - (8 + 40) - 48 = 604 px of frame, the frame's top 8 + 40 px down: 48 - 40.
	assert.deepEqual(frameSize(canvas), ["390px", "604px"]);
	assert.equal(canvas.world.style.transform, "translate(305px, 8px) scale(1)");
});

// ---- the device button and its menu (canvas-layout S6)

test("canvas-layout S6: the top bar's device button opens a menu of Phone, Tablet, Desktop, All sizes and a custom width, Desktop checked", async () => {
	const canvas = await loadSizes();
	const button = deviceButton(canvas);
	assert.equal(button.disabled, true, "outside an open artboard the button does nothing");
	assert.equal(button.title, "Open an artboard to choose its preview size");
	assert.equal(button.getAttribute("aria-label"), "Preview size: Desktop");
	button.dispatch("click");
	assert.equal(deviceMenu(canvas).hidden, true, "and opens nothing");
	focusOn(canvas);
	assert.equal(button.disabled, false);
	assert.equal(button.title, "Preview size of the open artboard");
	assert.equal(button.getAttribute("aria-label"), "Preview size: Desktop 984 × 300");
	assert.equal(readout(canvas), "Desktop 984 × 300", "the button reads the current size");
	assert.equal(deviceIcon(canvas), "#i-monitor");
	button.dispatch("click");
	const menu = deviceMenu(canvas);
	assert.equal(menu.hidden, false);
	assert.equal(button.getAttribute("aria-expanded"), "true");
	assert.equal(menu.getAttribute("aria-label"), "Preview size");
	const items = deviceItems(canvas);
	assert.deepEqual(items.map((item) => item.dataset.size), ["phone", "tablet", "desktop", "all"]);
	assert.deepEqual(items.map((item) => texts(item, "gd-menu-label")[0]), ["Phone", "Tablet", "Desktop", "All sizes"]);
	assert.deepEqual(items.map((item) => texts(item, "gd-device-dim")[0] ?? ""), ["390 × 844", "820 × 1180", "984 × 300", ""]);
	assert.deepEqual(items.map((item) => item.title), ["Phone 390 × 844", "Tablet 820 × 1180", "Desktop 984 × 300", "All sizes: Phone, Tablet and the artboard as designed, side by side"]);
	assert.deepEqual(items.map((item) => item.getAttribute("aria-checked")), ["false", "false", "true", "false"], "Desktop is checked when focus mode starts");
	assert.deepEqual(items.map((item) => (item as FakeElement & { type?: string }).type), ["button", "button", "button", "button"]);
	for (const item of items) assert.equal(withClass(item, "gd-i")[0].getAttribute("aria-hidden"), "true", "icons are decoration");
	assert.deepEqual(items.map((item) => withClass(item, "gd-i")[0].children[0].getAttribute("href")), ["#i-phone", "#i-tablet", "#i-monitor", "#i-devices"]);
	assert.ok(isActive(canvas, items[0]), "focus moves to the first item");
	const input = customInput(canvas);
	assert.equal(input.getAttribute("aria-label"), "Custom width in pixels");
	assert.deepEqual([(input as FakeElement & { type?: string }).type, (input as FakeElement & { name?: string }).name, input.getAttribute("min"), input.getAttribute("max"), input.getAttribute("step")], ["number", "gd-custom-width", "240", "2560", "1"]);
	assert.deepEqual(texts(menu, "gd-device-custom-label"), ["Custom"]);
	assert.equal(input.value, "");
	assert.equal(sizeError(canvas).hidden, true);
	assert.equal(sizeError(canvas).getAttribute("role"), "alert");
});

test("the custom width field and its error sit in a group named Custom width, the only kind of non-item a menu may own", async () => {
	const canvas = await loadSizes();
	tallViewport(canvas);
	focusOn(canvas);
	$(canvas, "gd-device").dispatch("click");
	const roles = deviceMenu(canvas).children.map((child) => child.getAttribute("role"));
	assert.deepEqual(roles.filter((role) => role !== "menuitemradio"), ["separator", "group"], "besides its items, the menu owns only a separator and a group");
	const group = deviceMenu(canvas).children[roles.indexOf("group")];
	assert.equal(group.getAttribute("aria-label"), "Custom width");
	assert.deepEqual(group.children.map((child) => child.className), ["gd-device-custom", "gd-device-error"], "the field's row and its error are inside the group");
});

test("canvas-layout S6: choosing a size closes the menu, gives focus back to the button and shows the size's icon and name on it", async () => {
	const canvas = await loadSizes();
	tallViewport(canvas);
	focusOn(canvas);
	const shown: Array<Array<string | null>> = [];
	for (const size of ["phone", "tablet", "desktop"]) {
		chooseSize(canvas, size);
		assert.equal(deviceMenu(canvas).hidden, true, size);
		assert.equal(deviceButton(canvas).getAttribute("aria-expanded"), "false");
		assert.ok(isActive(canvas, deviceButton(canvas)), `${size}: focus is back on the button`);
		shown.push([deviceIcon(canvas), readout(canvas), deviceButton(canvas).getAttribute("aria-label")]);
	}
	setCustom(canvas, "600");
	shown.push([deviceIcon(canvas), readout(canvas), deviceButton(canvas).getAttribute("aria-label")]);
	assert.deepEqual(shown, [
		["#i-phone", "Phone 390 × 844", "Preview size: Phone 390 × 844"],
		["#i-tablet", "Tablet 820 × 1180", "Preview size: Tablet 820 × 1180"],
		["#i-monitor", "Desktop 984 × 300", "Preview size: Desktop 984 × 300"],
		["#i-width", "Custom 600 × 300", "Preview size: Custom 600 × 300"],
	]);
	back(canvas);
	assert.equal(deviceButton(canvas).disabled, true, "back on the canvas it is off again");
	assert.equal(readout(canvas), "Desktop", "naming no size of its own");
	assert.equal(deviceIcon(canvas), "#i-monitor");
});

test("canvas-layout S6: the device menu keeps the shared menu's keys, and the width field keeps its own", async () => {
	const canvas = await loadSizes();
	tallViewport(canvas);
	focusOn(canvas);
	const button = deviceButton(canvas);
	assert.equal(keyOn(button, "ArrowDown").defaultPrevented, true);
	assert.equal(deviceMenu(canvas).hidden, false);
	assert.ok(isActive(canvas, deviceItems(canvas)[0]), "ArrowDown opens on the first item");
	assert.equal(keyOn(button, "Escape").defaultPrevented, true);
	assert.equal(deviceMenu(canvas).hidden, true);
	assert.equal(button.getAttribute("aria-expanded"), "false");
	keyOn(button, "ArrowUp");
	const items = deviceItems(canvas);
	const input = withClass(deviceMenu(canvas), "gd-device-input")[0];
	assert.ok(isActive(canvas, input), "ArrowUp opens on the last entry, the width field");
	keyOn(input, "ArrowDown");
	assert.ok(isActive(canvas, items[0]), "ArrowDown wraps to the first");
	keyOn(items[0], "ArrowUp");
	assert.ok(isActive(canvas, input), "ArrowUp wraps to the field");
	keyOn(input, "ArrowUp");
	assert.ok(isActive(canvas, items[3]), "All sizes is the last item before the field");
	keyOn(items[3], "Home");
	assert.ok(isActive(canvas, items[0]));
	keyOn(items[0], "End");
	assert.ok(isActive(canvas, input));
	for (const key of ["Home", "End", "5", " "]) assert.equal(keyOn(input, key).defaultPrevented, false, `${JSON.stringify(key)} stays with the field`);
	assert.ok(isActive(canvas, input));
	assert.equal(deviceMenu(canvas).hidden, false, "moving never closes it");
	assert.equal(keyOn(input, "Escape").defaultPrevented, true);
	assert.equal(deviceMenu(canvas).hidden, true);
	assert.ok(isActive(canvas, button), "Esc returns focus to the button");

	for (const key of ["Enter", " "]) {
		button.dispatch("click");
		const chosen = keyOn(deviceItems(canvas)[0], key);
		assert.equal(chosen.defaultPrevented, true, key);
		assert.equal(readout(canvas), "Phone 390 × 844", key);
		assert.equal(deviceMenu(canvas).hidden, true, key);
		chooseSize(canvas, "desktop");
	}

	button.dispatch("click");
	assert.equal(keyOn(deviceItems(canvas)[1], "Tab").defaultPrevented, false, "Tab keeps its move");
	assert.equal(deviceMenu(canvas).hidden, true);

	button.dispatch("click");
	const pointerdown = (target: FakeElement) => (canvas.document.listeners.get("pointerdown") ?? []).forEach((listener) => listener({ target, button: 0 }));
	pointerdown(deviceMenu(canvas));
	pointerdown(withClass(deviceMenu(canvas), "gd-device-input")[0]);
	assert.equal(deviceMenu(canvas).hidden, false, "a press inside does not close it");
	pointerdown(button);
	assert.equal(deviceMenu(canvas).hidden, false, "the button toggles on its own click");
	pointerdown(canvas.viewport);
	assert.equal(deviceMenu(canvas).hidden, true, "a press outside closes it");
	assert.equal(button.getAttribute("aria-expanded"), "false");
	button.dispatch("click");
	button.dispatch("click");
	assert.equal(deviceMenu(canvas).hidden, true, "the button closes it again");
	assert.equal(readout(canvas), "Desktop 984 × 300", "closing chose nothing");
});

test("canvas-layout S6: the device and Settings menus close each other, and leaving the artboard closes the device menu", async () => {
	const canvas = await loadSizes();
	focusOn(canvas);
	const settings = $(canvas, "gd-rail-settings");
	const menu = $(canvas, "gd-menu");
	deviceButton(canvas).dispatch("click");
	settings.dispatch("click");
	assert.equal(deviceMenu(canvas).hidden, true);
	assert.equal(deviceButton(canvas).getAttribute("aria-expanded"), "false");
	assert.equal(menu.hidden, false);
	deviceButton(canvas).dispatch("click");
	assert.equal(menu.hidden, true);
	assert.equal(settings.getAttribute("aria-expanded"), "false");
	assert.equal(deviceMenu(canvas).hidden, false);
	canvas.message(canvas.boards[0].frame.contentWindow, { type: "gd:exit-focus" });
	assert.equal(deviceMenu(canvas).hidden, true);
	assert.equal(deviceButton(canvas).getAttribute("aria-expanded"), "false");
	assert.equal(deviceButton(canvas).disabled, true);
	assert.equal(deviceMenu(canvas).children.length, 0, "the menu is emptied when it closes");
});

// ---- one size at a time (S1, S2)

test("S1: Desktop is the artboard's own manifest size when it is wider than the window (canvas-layout S8), and each focus session starts at Desktop", async () => {
	const canvas = await loadSizes(WIDE_ALPHA);
	focusOn(canvas);
	assert.equal(readout(canvas), "Desktop 1200 × 800");
	openDevices(canvas);
	assert.equal(deviceItems(canvas)[2].title, "Desktop 1200 × 800");
	chooseSize(canvas, "phone");
	back(canvas);
	focusOn(canvas);
	assert.deepEqual(pressedSizes(canvas), ["desktop"]);
	assert.equal(readout(canvas), "Desktop 1200 × 800");
});

test("S2: Phone, Tablet and Desktop resize the focused iframe in place, centered at 100%", async () => {
	const canvas = await loadSizes();
	tallViewport(canvas);
	const [first] = canvas.boards;
	const src = first.frame.src;
	focusOn(canvas);
	chooseSize(canvas, "phone");
	assert.deepEqual(frameSize(canvas), ["390px", "844px"]);
	assert.equal(canvas.world.style.transform, "translate(305px, 278px) scale(1)");
	assert.equal(canvas.zoomLevel.textContent, "100%");
	assert.deepEqual(pressedSizes(canvas), ["phone"]);
	assert.equal(readout(canvas), "Phone 390 × 844");

	chooseSize(canvas, "tablet");
	assert.deepEqual(frameSize(canvas), ["820px", "1180px"]);
	assert.equal(canvas.world.style.transform, "translate(90px, 110px) scale(1)");
	assert.deepEqual(pressedSizes(canvas), ["tablet"]);
	assert.equal(readout(canvas), "Tablet 820 × 1180");

	chooseSize(canvas, "desktop");
	assert.deepEqual(frameSize(canvas), ["984px", "300px"]);
	assert.equal(canvas.world.style.transform, "translate(8px, 550px) scale(1)");
	assert.deepEqual(pressedSizes(canvas), ["desktop"]);
	assert.equal(first.frame.src, src, "the artboard is not reloaded");
	assert.ok(canvas.frames()[0] === first.frame, "and keeps its iframe");
});

test("S2: a size taller than the viewport keeps the clip, and one wider than it is drawn smaller to fit", async () => {
	const canvas = await loadSizes(WIDE_ALPHA);
	const [first] = canvas.boards;
	first.frame.parentElement!.offsetLeft = 480;
	first.frame.parentElement!.offsetTop = 20;
	focusOn(canvas);
	// Desktop is 1200 wide in a 1000 px viewport: it keeps its 1200 px width, drawn at (1000 - 2 * 8) / 1200, from the left margin.
	const scale = 984 / 1200;
	assert.equal(first.frame.style.width, "1200px", "the design still renders at its real width");
	assert.equal(canvas.world.style.transform, `translate(${Math.round(8 - 480 * scale)}px, 8px) scale(${scale})`);
	assert.equal(canvas.zoomLevel.textContent, "82%", "the zoom says how much smaller it is drawn");
	chooseSize(canvas, "phone");
	assert.equal(first.frame.style.height, "624px", "844 px does not fit the 700 px viewport (less the 8 px margin, the 20 px label and the 48 px band)");
	assert.equal(readout(canvas), "Phone 390 × 844", "the readout keeps the preset height");
	assert.equal(canvas.world.style.transform, "translate(-175px, 8px) scale(1)");
});

test("S2: a custom width resizes the iframe with the manifest height; the field accepts whole px from 240 to 2560 only", async () => {
	const canvas = await loadSizes();
	tallViewport(canvas);
	focusOn(canvas);
	setCustom(canvas, "600");
	assert.deepEqual(frameSize(canvas), ["600px", "300px"], "height keeps the artboard's manifest height");
	assert.equal(deviceMenu(canvas).hidden, true, "a valid width closes the menu");
	assert.equal(readout(canvas), "Custom 600 × 300");
	assert.equal(canvas.world.style.transform, "translate(200px, 550px) scale(1)");
	assert.deepEqual(pressedSizes(canvas), [], "no preset is checked");
	assert.equal(customInput(canvas).value, "600", "the field shows the width when the menu opens again");
	assert.ok(customRow(canvas).classes.has("gd-selected"));

	for (const bad of ["239", "2561", "abc", "500.5", "", "-300", "1e3"]) {
		const input = setCustom(canvas, bad);
		assert.equal(canvas.boards[0].frame.style.width, "600px", `${JSON.stringify(bad)} is refused`);
		assert.equal(readout(canvas), "Custom 600 × 300");
		assert.equal(input.getAttribute("aria-invalid"), "true");
		assert.equal(sizeError(canvas).hidden, false);
		assert.equal(sizeError(canvas).textContent, "Enter a whole number from 240 to 2560 (px).");
		assert.equal(deviceMenu(canvas).hidden, false, "the menu stays open to correct it");
	}
	for (const edge of ["240", "2560"]) {
		setCustom(canvas, edge);
		assert.equal(canvas.boards[0].frame.style.width, `${edge}px`, `${edge} is accepted with Enter`);
		assert.equal(deviceMenu(canvas).hidden, true);
		assert.ok(isActive(canvas, deviceButton(canvas)));
		assert.equal(customInput(canvas).getAttribute("aria-invalid"), null, "the menu is built again, without the error, when it opens");
		assert.equal(sizeError(canvas).hidden, true);
		deviceButton(canvas).dispatch("click");
	}
	// A size wider than the viewport starts at the left margin, like a wide artboard.
	assert.match(canvas.world.style.transform, /^translate\(8px, /);
	chooseSize(canvas, "phone");
	assert.equal(customInput(canvas).value, "", "a preset clears the custom field");
	assert.ok(!customRow(canvas).classes.has("gd-selected"));
});

test("S2: the custom width applies on Enter only: leaving the field (change) applies nothing, so Phone chosen next is Phone", async () => {
	const canvas = await loadSizes();
	tallViewport(canvas);
	focusOn(canvas);
	const input = customInput(canvas);
	input.value = "600";
	input.dispatch("change");
	assert.equal(deviceMenu(canvas).hidden, false, "a change event (blur, spinner step) keeps the menu open");
	assert.equal(readout(canvas), "Desktop 984 × 300", "and applies no width");
	deviceItems(canvas).find((item) => item.dataset.size === "phone")?.dispatch("click");
	assert.equal(readout(canvas), "Phone 390 × 844");
	assert.deepEqual(frameSize(canvas), ["390px", "844px"]);
	assert.equal(deviceMenu(canvas).hidden, true);
});

test("S2: leaving focus mode, or focusing another artboard, restores the manifest size", async () => {
	const canvas = await loadSizes({ "/t/api/system": { exists: true, file: "system.html", width: 800, height: 600 } });
	tallViewport(canvas);
	// The system board comes first.
	focusOn(canvas, 1);
	chooseSize(canvas, "tablet");
	back(canvas);
	assert.deepEqual(frameSize(canvas, 1), ["400px", "300px"]);

	focusOn(canvas, 1);
	chooseSize(canvas, "phone");
	// Settings > Design system board focuses another artboard.
	$(canvas, "gd-rail-settings").dispatch("click");
	findAll($(canvas, "gd-menu"), (element) => element.getAttribute("role") === "menuitem" && texts(element, "gd-menu-label")[0] === "Design system board")[0].dispatch("click");
	assert.deepEqual(frameSize(canvas, 1), ["400px", "300px"], "the artboard left behind is restored");
	assert.deepEqual(pressedSizes(canvas), ["desktop"], "the new focus starts at Desktop");
	assert.deepEqual(frameSize(canvas, 0), ["984px", "600px"], "Desktop is the viewport's width (canvas-layout S8)");
	canvas.message(canvas.boards[0].frame.contentWindow, { type: "gd:exit-focus" });
	assert.deepEqual(frameSize(canvas, 0), ["800px", "600px"]);
});

test("S2: the size survives a manifest refresh of the focused artboard", async () => {
	const canvas = await loadSizes();
	tallViewport(canvas);
	focusOn(canvas);
	chooseSize(canvas, "phone");
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	assert.equal(canvas.frames()[0].style.width, "390px");
	assert.deepEqual(pressedSizes(canvas), ["phone"]);
	assert.equal(readout(canvas), "Phone 390 × 844");
});

test("S2: pins and the comment box measure the frame at its focused width, not the manifest's", async () => {
	const comment = { id: "abc123", file: "01-a.html", selector: "h1", excerpt: "First", comment: "Update", status: "open", sentAt: null };
	const canvas = await loadSizes({ "/t/api/designs/alpha/comments": { comments: [comment] } });
	tallViewport(canvas);
	const [first] = canvas.boards;
	focusOn(canvas);
	chooseSize(canvas, "phone");
	const pins = withClass(first.frame.parentElement!, "gd-pins")[0];
	canvas.message(first.frame.contentWindow, { type: "gd:pin-rects", rects: [{ id: comment.id, rect: { x: 395, y: 10, width: 4, height: 4 } }] });
	assert.equal(pins.children.length, 0, "beyond the 390 px frame (inside the 400 px manifest width) the pin is hidden");
	canvas.message(first.frame.contentWindow, { type: "gd:pin-rects", rects: [{ id: comment.id, rect: { x: 380, y: 10, width: 4, height: 4 } }] });
	assert.equal(pins.children.length, 1);
	// The frame is 390 px wide on screen at 100%: a pick 100 px in is 100 px right of its left edge.
	$(canvas, "gd-comment").dispatch("click");
	first.frame.rect = { left: 305, top: 50, width: 390, height: 844 };
	canvas.message(first.frame.contentWindow, inspectorPick(first.frame, { type: "gd:pick", selector: "h1", excerpt: "First", rect: { x: 100, y: 20, width: 30, height: 40 } }));
	assert.equal($(canvas, "gd-popover").hidden, false);
	assert.equal($(canvas, "gd-popover").style.left, "405px");
});

// ---- All sizes in a narrow viewport

test("All sizes fits a narrow viewport: each frame is as wide as its scaled iframe, the row fits the room, and a cut label keeps its full text in a title", async () => {
	const canvas = await loadSizes({ "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [
		{ file: "01-a.html", title: "First", tradeoff: "", width: 4000, height: 800 },
		{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 },
	] } });
	focusOn(canvas);
	chooseSize(canvas, "all");
	const px = (value: unknown) => Number.parseFloat(String(value));
	const view = withClass(canvas.viewport, "gd-sizes-all")[0];
	const sections = withClass(canvas.viewport, "gd-size-frame");
	const scaled = sections.map((section) => withClass(section, "gd-size-scaled")[0]);
	const widths = scaled.map((box) => px(box.style.width));
	// The label cannot widen its frame: the section is exactly as wide as the scaled iframe.
	assert.deepEqual(sections.map((section) => px(section.style.width)), widths);
	// The 1000 px viewport less the side margins and the two 20 px gaps.
	const room = 1000 - px(view.style.left) - px(view.style.right) - 20 * 2;
	const total = widths.reduce((sum, width) => sum + width, 0);
	assert.ok(total <= room, `${total} px of frames fit the ${room} px room`);
	const tallest = Math.max(...scaled.map((box) => px(box.style.height)));
	assert.ok(tallest <= 700 - px(view.style.top) - px(view.style.bottom) - 28, `${tallest} px fit under the 28 px labels`);
	const percent = texts(sections[0], "gd-size-scale")[0];
	assert.deepEqual(sections.map((section) => withClass(section, "gd-size-head")[0].title), [`Phone 390 × 844 ${percent}`, `Tablet 820 × 1180 ${percent}`, `As designed 4000 × 800 ${percent}`]);

	const css = read("canvas.css");
	const block = (selector: string) => {
		const start = css.indexOf(`\n${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start) + 1);
	};
	const head = block(".gd-size-head");
	for (const rule of [/overflow: hidden;/, /text-overflow: ellipsis;/, /white-space: nowrap;/]) assert.match(head, rule, "a label longer than its frame ends in an ellipsis");
	const row = block(".gd-sizes-all");
	assert.match(row, /justify-content: safe center;/, "a row wider than the viewport starts at its left edge, never cut on both sides");
	assert.match(row, /overflow-x: auto;/, "and scrolls sideways at the smallest scale");
});

// ---- markup, styles, store and docs

test("canvas-layout S6: the device selector's markup sits after the arrangements in English, and its styles use --gd-* tokens, a focus ring and no motion", () => {
	const html = read("index.html");
	const bar = html.slice(html.indexOf('<header class="gd-bar"'), html.indexOf("</header>"));
	assert.match(bar, /<button type="button" id="gd-device" class="gd-device-button" aria-haspopup="menu" aria-expanded="false" aria-controls="gd-device-menu" aria-label="Preview size: Desktop" title="Open an artboard to choose its preview size" data-i18n-aria-label="previewDesktop" data-i18n-title="previewOff" disabled><svg class="gd-i gd-i-s" aria-hidden="true"><use id="gd-device-icon" href="#i-monitor"\/><\/svg><span id="gd-device-name" data-i18n="desktop">Desktop<\/span><span id="gd-device-size" class="gd-device-size"><\/span><\/button>/);
	assert.ok(bar.indexOf('id="gd-arrange-grid"') < bar.indexOf('id="gd-device"') && bar.indexOf('id="gd-device"') < bar.indexOf('id="gd-nav-mode"'), "after the arrangements, before the mode label");
	assert.match(html, /<div id="gd-device-menu" class="gd-menu gd-device-menu" role="menu" aria-label="Preview size" data-i18n-aria-label="previewSize" hidden><\/div>/);
	for (const icon of ["i-phone", "i-tablet", "i-monitor", "i-devices", "i-width", "i-check"]) assert.match(html, new RegExp(`<symbol id="${icon}" viewBox="0 0 24 24">`));
	// The English stays in the markup, keyed for the language (ES.html, tests/design-canvas-i18n.test.ts); renderDevice rewrites it.
	const css = read("canvas.css");
	const block = (selector: string) => {
		const start = css.indexOf(`\n${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start) + 1);
	};
	for (const selector of [".gd-device-button", ".gd-device-menu", ".gd-device-item", ".gd-device-dim", ".gd-device-custom", ".gd-device-input", ".gd-device-error"]) {
		const text = block(selector);
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(text), `${selector}: tokens only`);
		assert.ok(!/var\(--(?!gd-)/.test(text), `${selector}: only --gd-* tokens`);
		assert.ok(!/transition|animation/.test(text), `${selector}: no motion`);
	}
	assert.match(css, /\.gd-device-item\[aria-checked="true"\][^{]*{[^}]*background:\s*var\(--gd-stage\)/);
	assert.match(css, /\.gd-device-item\[aria-checked="true"\] \.gd-device-check[^{]*{[^}]*visibility:\s*visible/);
	assert.match(css, /\.gd-device-button:focus-visible[^{]*{[^}]*outline:\s*2px solid var\(--gd-focus\)/);
	assert.match(css, /\.gd-device-input\[aria-invalid="true"\][^{]*{[^}]*border-color:\s*var\(--gd-danger\)/);
	assert.match(css, /\.gd-bar > \.gd-device-button \{ flex: none; \}/, "it never shrinks under its text");
	assert.match(block(".gd-back"), /bottom: 8px;/, "Back to canvas floats in the 48 px band");
});

test("the focus margins live in canvas-focus.js, and the size changes only through the store's setFocus", () => {
	const focus = read("canvas-focus.js");
	assert.match(focus, /const FOCUS_MARGIN = 8;/);
	assert.match(focus, /const BACK_SPACE = 48;/);
	assert.ok(!/setFrameHeight/.test(focus), "the frame is sized whole: setFrameSize");
	const sizes = read("canvas-sizes.js");
	assert.match(sizes, /store\.setFocus\(\{ size/);
	assert.ok(!/\bstate\.size\s*=(?!=)/.test(sizes), "never assigned in place");
});

test("the docs describe the preview size in the top bar, All sizes, the Overflows chip, the comment's size and focus mode as wide as the window", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"), docs.indexOf("### Gentle Music"));
	const start = section.indexOf("- **Sizes**");
	assert.ok(start >= 0, "a Sizes entry");
	const sizes = section.slice(start, section.indexOf("\n", start));
	for (const part of ["**Preview size**", "top bar", "disabled", "**Phone** (390 × 844)", "**Tablet** (820 × 1180)", "**Desktop**", "**Custom**", "240", "2560", "8 px", "drawn smaller", "Leaving focus mode"]) assert.ok(sizes.includes(part), `the Sizes entry mentions ${part}`);
	for (const part of ["**All sizes**", "side by side", "its own iframe", "Comment mode", "**Overflows**", "wider than", "the size it was made at", "**As designed**", "Desktop records none"]) assert.ok(sizes.includes(part), `the Sizes entry mentions ${part}`);
	assert.ok(!section.includes("at its designed width at 100%"), "focus mode is no longer the designed width");
	assert.ok(!section.includes("the rest of the canvas is dimmed"), "the other artboards are hidden now");
});
