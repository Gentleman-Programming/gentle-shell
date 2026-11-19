import assert from "node:assert/strict";
import test from "node:test";
import { findAll, flush, handoffDoc, loadCanvas, memoryStorage, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// The canvas language over the layout, the minimap, the sizes, the export and Compare (odd/tasks/canvas-i18n.md
// S2, S8, S9): each in Spanish after choosing Español in Settings, the exact English again after English, relabeled
// in place without reloading a frame. Every assertion compares strings, numbers or booleans, never fake elements.

const LANGUAGE_KEY = "gentle-design:language";
const LAYOUT_URL = "/t/api/designs/alpha/layout";
const COMPARE = { "/t/api/designs/alpha/handoffs": handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:5173/login" } }) };

/** The canvas with index.html's language markup, an English browser and the language `stored` (none: Match the browser). */
async function loadLanguage(replies: Record<string, unknown> = {}, stored?: string, config: Record<string, unknown> = {}) {
	const storage = memoryStorage(stored === undefined ? {} : { [LANGUAGE_KEY]: stored });
	const navigator = { languages: ["en-US"], language: "en-US" };
	const canvas = await loadCanvas(300, replies, config, { localStorage: storage.localStorage, navigator }, true);
	// The fake DOM starts every element visible; index.html starts these hidden.
	for (const id of ["gd-popover", "gd-menu", "gd-device-menu"]) canvas.document.getElementById(id).hidden = true;
	return { ...canvas, navigator };
}
type Canvas = Awaited<ReturnType<typeof loadLanguage>>;

const $ = (canvas: Canvas, id: string) => canvas.document.getElementById(id);
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };
const label = (item: FakeElement) => texts(item, "gd-menu-label")[0];
/** Opens Settings and chooses the language item `name` with Enter. */
function choose(canvas: Canvas, name: string) {
	$(canvas, "gd-rail-settings").dispatch("click");
	const item = findAll($(canvas, "gd-menu"), (element) => element.getAttribute("role") === "menuitemradio").find((candidate) => label(candidate) === name)!;
	item.focus();
	item.dispatch("keydown", { key: "Enter", shiftKey: false });
}
const marked = (canvas: Canvas, key: string) => findAll(canvas.document.body, (element) => element.getAttribute("data-i18n") === key).map((element) => element.textContent);
const markedAttribute = (canvas: Canvas, attribute: string, key: string) => findAll(canvas.document.body, (element) => element.getAttribute(`data-i18n-${attribute}`) === key).map((element) => element.getAttribute(attribute));
const focusOn = (canvas: Canvas) => canvas.boards[0].shield!.dispatch("keydown", { key: "Enter" });
const deviceItems = (canvas: Canvas) => findAll($(canvas, "gd-device-menu"), (element) => element.getAttribute("role") === "menuitemradio");

// ---- the focused layout after a switch

test("a switch re-centers the focused artboard, since a longer label can change the room above its frame", async () => {
	const canvas = await loadLanguage();
	canvas.viewport.rect = { left: 0, top: 50, width: 1000, height: 700 };
	focusOn(canvas);
	const board = canvas.boards[0];
	const before = canvas.world.style.transform;
	// The Spanish label wraps to more lines: the frame sits lower inside its box.
	board.frame.parentElement!.offsetTop += 36;
	choose(canvas, "Español");
	assert.notEqual(canvas.world.style.transform, before, "the view was worked out again with the new label height");
	board.frame.parentElement!.offsetTop -= 36;
	choose(canvas, "English");
	assert.equal(canvas.world.style.transform, before, "and back with the English one");
});

// ---- the device button, its menu and the custom width (canvas-sizes.js)

/** The device button as it reads now, and its menu opened, with a bad custom width entered, then closed. */
function device(canvas: Canvas) {
	const button = $(canvas, "gd-device");
	const shown = [$(canvas, "gd-device-name").textContent, button.getAttribute("aria-label"), button.title];
	if (button.disabled) return { shown };
	button.dispatch("click");
	const menu = $(canvas, "gd-device-menu");
	const items = deviceItems(canvas);
	const [input] = withClass(menu, "gd-device-input");
	const [group] = withClass(menu, "gd-device-custom-group");
	input.value = "9";
	input.dispatch("keydown", { key: "Enter" });
	const result = {
		shown,
		menu: menu.getAttribute("aria-label"),
		items: items.map(label),
		titles: items.map((item) => item.title),
		custom: [texts(menu, "gd-device-custom-label")[0], input.getAttribute("aria-label"), group.getAttribute("aria-label")],
		error: texts(menu, "gd-device-error")[0],
	};
	button.dispatch("click");
	return result;
}

test("the device button, its menu and the custom width's error in Spanish, and the exact English again", async () => {
	const canvas = await loadLanguage();
	const englishOff = { shown: ["Desktop", "Preview size: Desktop", "Open an artboard to choose its preview size"] };
	const spanishOff = { shown: ["Escritorio", "Tamaño de vista previa: Escritorio", "Abre una propuesta para elegir su tamaño de vista previa"] };
	assert.deepEqual(device(canvas), englishOff);
	choose(canvas, "Español");
	assert.deepEqual(device(canvas), spanishOff);
	choose(canvas, "English");
	assert.deepEqual(device(canvas), englishOff);

	focusOn(canvas);
	const dims = $(canvas, "gd-device-size").textContent;
	const english = {
		shown: ["Desktop", `Preview size: Desktop ${dims}`, "Preview size of the open artboard"],
		menu: "Preview size",
		items: ["Phone", "Tablet", "Desktop", "All sizes"],
		titles: ["Phone 390 × 844", "Tablet 820 × 1180", `Desktop ${dims}`, "All sizes: Phone, Tablet and the artboard as designed, side by side"],
		custom: ["Custom", "Custom width in pixels", "Custom width"],
		error: "Enter a whole number from 240 to 2560 (px).",
	};
	const spanish = {
		shown: ["Escritorio", `Tamaño de vista previa: Escritorio ${dims}`, "Tamaño de vista previa de la propuesta abierta"],
		menu: "Tamaño de vista previa",
		items: ["Móvil", "Tablet", "Escritorio", "Todos los tamaños"],
		titles: ["Móvil 390 × 844", "Tablet 820 × 1180", `Escritorio ${dims}`, "Todos los tamaños: móvil, tablet y la propuesta tal como se diseñó, lado a lado"],
		custom: ["Personalizado", "Ancho personalizado en píxeles", "Ancho personalizado"],
		error: "Escribe un número entero de 240 a 2560 (px).",
	};
	assert.deepEqual(device(canvas), english);
	choose(canvas, "Español");
	assert.deepEqual(device(canvas), spanish);
	choose(canvas, "English");
	assert.deepEqual(device(canvas), english);
});

// ---- All sizes and the Overflows chip (canvas-sizes.js)

/** All sizes' group name, and per frame: its name, label, frame title, header title and its Overflows chip with its note. */
function allSizes(canvas: Canvas) {
	const [view] = withClass(canvas.viewport, "gd-sizes-all");
	const frames = withClass(view, "gd-size-frame").map((root) => {
		const [frame] = findAll(root, (element) => element.localName === "iframe");
		const [flag] = withClass(root, "gd-overflow-flag");
		return [root.getAttribute("aria-label"), texts(root, "gd-size-name")[0], frame.title, withClass(root, "gd-size-head")[0].title, flag.hidden ? "" : `${texts(flag, "gd-overflow-text")[0]} | ${flag.title}`];
	});
	return { group: view.getAttribute("aria-label"), frames };
}

test("All sizes' labels and the Overflows chip in Spanish, and the exact English again, with the same frames", async () => {
	const canvas = await loadLanguage();
	focusOn(canvas);
	$(canvas, "gd-device").dispatch("click");
	deviceItems(canvas).find((item) => item.dataset.size === "all")!.dispatch("click");
	const iframes = () => findAll(canvas.viewport, (element) => element.localName === "iframe");
	const before = iframes();
	const sources = before.map((frame) => frame.src);
	const phone = withClass(canvas.viewport, "gd-size-iframe")[0];
	canvas.message(phone.contentWindow, { type: "gd:overflow", overflow: true, width: 390, scrollWidth: 500 });
	const scale = (index: number) => texts(withClass(canvas.viewport, "gd-size-frame")[index], "gd-size-scale")[0];
	const english = {
		group: "All sizes",
		frames: [
			["Phone 390 by 844", "Phone", "First artboard at Phone 390 × 844", `Phone 390 × 844 ${scale(0)}`, "Overflows | Content is wider than 390 px, so part of it is cut off or needs sideways scrolling at this size."],
			["Tablet 820 by 1180", "Tablet", "First artboard at Tablet 820 × 1180", `Tablet 820 × 1180 ${scale(1)}`, ""],
			["As designed 400 by 300", "As designed", "First artboard as designed, 400 × 300", `As designed 400 × 300 ${scale(2)}`, ""],
		],
	};
	const spanish = {
		group: "Todos los tamaños",
		frames: [
			["Móvil de 390 por 844", "Móvil", "Propuesta First en Móvil 390 × 844", `Móvil 390 × 844 ${scale(0)}`, "Se desborda | El contenido es más ancho que 390 px, así que a este tamaño una parte queda cortada o hay que desplazarse en horizontal."],
			["Tablet de 820 por 1180", "Tablet", "Propuesta First en Tablet 820 × 1180", `Tablet 820 × 1180 ${scale(1)}`, ""],
			["Tal como se diseñó de 400 por 300", "Tal como se diseñó", "Propuesta First tal como se diseñó, 400 × 300", `Tal como se diseñó 400 × 300 ${scale(2)}`, ""],
		],
	};
	assert.match(scale(0), /^· \d+%$/);
	assert.deepEqual(allSizes(canvas), english);
	choose(canvas, "Español");
	assert.deepEqual(allSizes(canvas), spanish);
	choose(canvas, "English");
	assert.deepEqual(allSizes(canvas), english);
	await settle();
	assert.equal(iframes().length, before.length);
	assert.ok(iframes().every((frame, index) => frame === before[index] && frame.src === sources[index]), "the same frames, relabeled in place, none reloaded");
});

// ---- the minimap (canvas-minimap.js)

test("the minimap's title and name in Spanish, one propuesta or two, and the exact English again", async () => {
	const minimap = (canvas: Canvas) => [...marked(canvas, "minimap"), $(canvas, "gd-minimap-map").getAttribute("aria-label")];
	const two = await loadLanguage();
	const englishTwo = ["Minimap", "Position of the visible area among 2 artboards. Click or drag to move the view."];
	assert.deepEqual(minimap(two), englishTwo);
	choose(two, "Español");
	assert.deepEqual(minimap(two), ["Minimapa", "Posición del área visible entre 2 propuestas. Haz clic o arrastra para mover la vista."]);
	choose(two, "English");
	assert.deepEqual(minimap(two), englishTwo);

	const one = await loadLanguage({}, "es", { slug: "beta" });
	assert.deepEqual(minimap(one), ["Minimapa", "Posición del área visible entre 1 propuesta. Haz clic o arrastra para mover la vista."]);
	choose(one, "English");
	assert.deepEqual(minimap(one), ["Minimap", "Position of the visible area among 1 artboard. Click or drag to move the view."]);
});

// ---- the ⋯ export menu (canvas-export.js)

test("the ⋯ menu, its items and an export failure in Spanish, and the exact English again", async () => {
	const canvas = await loadLanguage();
	const button = withClass(canvas.boards[0].wrapper, "gd-menu-button")[0];
	const menu = () => {
		button.dispatch("click");
		const items = findAll($(canvas, "gd-menu"), (element) => element.getAttribute("role") === "menuitem");
		const result = [button.getAttribute("aria-label"), $(canvas, "gd-menu").getAttribute("aria-label"), ...items.map(label)];
		items[0].dispatch("click");
		return [...result, $(canvas, "gd-status").textContent];
	};
	const english = ["More actions for First", "First actions", "Export as PNG", "Export as PNG at 2×", "Export as PDF", "Download HTML", "Could not export the artboard. Tab capture is not available in this browser. Use your browser's screenshot tool instead."];
	assert.deepEqual(menu(), english);
	choose(canvas, "Español");
	assert.equal(button.getAttribute("aria-label"), "Más acciones para First", "the ⋯ button is relabeled in place");
	assert.deepEqual(menu(), ["Más acciones para First", "Acciones de First", "Exportar como PNG", "Exportar como PNG a 2×", "Exportar como PDF", "Descargar HTML", "No se pudo exportar la propuesta. La captura de pestañas no está disponible en este navegador. Usa la herramienta de capturas de tu navegador."]);
	choose(canvas, "English");
	assert.deepEqual(menu(), english);
});

// ---- Compare (canvas-compare.js)

test("Compare, open while the browser's language changes, relabels its title, captions, frames, hint and controls in place", async () => {
	const canvas = await loadLanguage(COMPARE);
	withClass(canvas.boards[0].wrapper, "gd-compare-start")[0].dispatch("click");
	const panes = $(canvas, "gd-compare-panes");
	const frames = findAll(panes, (element) => element.localName === "iframe");
	const sources = frames.map((frame) => frame.src);
	const compare = () => [
		$(canvas, "gd-compare-title").textContent,
		...texts(panes, "gd-compare-caption"),
		...findAll(panes, (element) => element.localName === "iframe").map((frame) => frame.title),
		$(canvas, "gd-compare-message").textContent,
		...marked(canvas, "scaleToFit"),
		$(canvas, "gd-compare-open").textContent,
		$(canvas, "gd-compare-back").textContent,
		$(canvas, "gd-compare-back").getAttribute("title"),
	];
	const english = ["Compare: First", "Design: 01-a.html", "Implementation: http://localhost:5173/login", "First artboard", "Running app at http://localhost:5173/login", "If the app refuses to be framed, use Open in new tab.", "Scale to fit", "Open in new tab", "Back to canvas", "Back to canvas (Shift+Esc)"];
	assert.deepEqual(compare(), english);
	canvas.navigator.languages = ["es-ES"];
	canvas.windowEvent("languagechange");
	assert.deepEqual(compare(), ["Comparar: First", "Diseño: 01-a.html", "Implementación: http://localhost:5173/login", "Propuesta First", "App en marcha en http://localhost:5173/login", "Si la app no deja mostrarse en un marco, usa Abrir en una pestaña nueva.", "Ajustar a la ventana", "Abrir en una pestaña nueva", "Volver al canvas", "Volver al canvas (Mayús+Esc)"]);
	canvas.navigator.languages = ["en-GB"];
	canvas.windowEvent("languagechange");
	assert.deepEqual(compare(), english);
	const now = findAll(panes, (element) => element.localName === "iframe");
	assert.ok(now.length === 2 && now.every((frame, index) => frame === frames[index] && frame.src === sources[index]), "the same artboard and app frames, none reloaded");
	assert.equal($(canvas, "gd-compare").hidden, false, "Compare stays open");
});

// ---- the layout's save error (canvas-layout.js)

test("a failed layout save says so in Spanish, and a later save that succeeds clears it even after a switch to English", async () => {
	const canvas = await loadLanguage({ [LAYOUT_URL]: { layout: null } }, "es");
	const status = $(canvas, "gd-status");
	const arrange = async (kind: string, reply: unknown) => {
		canvas.replies[LAYOUT_URL] = reply;
		$(canvas, `gd-arrange-${kind}`).dispatch("click");
		await settle();
	};
	await arrange("column", { __http: 400, error: "invalid-layout", reason: "disk full" });
	assert.deepEqual([status.textContent, status.classes.has("gd-error")], ["No se pudo guardar la disposición de alpha: disk full", true]);
	choose(canvas, "English");
	assert.equal(status.textContent, "No se pudo guardar la disposición de alpha: disk full", "the status line keeps the language it had");
	await arrange("grid", { ok: true });
	assert.deepEqual([status.textContent, status.classes.has("gd-error")], ["", false], "the save that succeeded clears it");
	await arrange("row", { __http: 400, error: "invalid-layout", reason: "disk full" });
	assert.equal(status.textContent, "The layout of alpha could not be saved: disk full");
	choose(canvas, "Español");
	await arrange("grid", { ok: true });
	assert.deepEqual([status.textContent, status.classes.has("gd-error")], ["", false]);
});
