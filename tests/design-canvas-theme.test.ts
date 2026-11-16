import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { DESIGN_CANVAS_ASSETS } from "../lib/design-canvas-assets.ts";
import { cssTokens, findAll, loadCanvas, memoryStorage, read, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// The canvas theme (canvas-theme.js): Gentleman or Neutral, radio items under a Theme heading in the
// rail's Settings, saved in this browser and applied at once through :root[data-theme] in canvas.css.

const THEME_KEY = "gentle-design:theme";
const THEME_ITEMS = ["Gentleman", "Neutral"];
const LANGUAGE_ITEMS = ["Español", "English", "Match the browser"];

/** The canvas with an in-memory (or throwing) localStorage; `stored` seeds the theme entry. */
async function loadTheme(options: { stored?: string; broken?: boolean; full?: boolean } = {}) {
	const storage = memoryStorage(options.stored === undefined ? {} : { [THEME_KEY]: options.stored }, options.broken);
	// `full`: reads work, every write throws (a full or read-only storage).
	const localStorage = options.full ? { getItem: storage.localStorage.getItem, setItem() { throw new Error("QuotaExceededError"); } } : storage.localStorage;
	// getComputedStyle reads canvas.css's own tokens, so the outline colors the frames get are the stylesheet's.
	const canvas = await loadCanvas(300, {}, {}, { localStorage, navigator: { languages: ["en-US"], language: "en-US" }, getComputedStyle: cssTokens }, true);
	canvas.document.getElementById("gd-popover").hidden = true;
	canvas.document.getElementById("gd-menu").hidden = true;
	const themeWrites = () => storage.writes.filter(([key]) => key === THEME_KEY).map(([, value]) => value);
	return { ...canvas, storage, themeWrites };
}
type Canvas = Awaited<ReturnType<typeof loadTheme>>;

const menuEl = (canvas: Canvas) => canvas.document.getElementById("gd-menu");
const theme = (canvas: Canvas) => canvas.document.documentElement.getAttribute("data-theme");
const labels = (items: FakeElement[]) => items.map((item) => texts(item, "gd-menu-label")[0]);
function openSettings(canvas: Canvas) {
	canvas.document.getElementById("gd-rail-settings").dispatch("click");
	return findAll(menuEl(canvas), (element) => (element.getAttribute("role") ?? "").startsWith("menuitem"));
}
function choose(canvas: Canvas, label: string) {
	const item = openSettings(canvas).find((candidate) => texts(candidate, "gd-menu-label")[0] === label);
	assert.ok(item, `Settings offers ${label}`);
	item.focus();
	item.dispatch("keydown", { key: "Enter", shiftKey: false });
}

test("Settings offers Gentleman and Neutral as radio items under a Theme heading, before the language; Neutral is the default", async () => {
	const canvas = await loadTheme();
	assert.equal(theme(canvas), null, "Neutral is :root's own palette: no data-theme");
	const items = openSettings(canvas);
	assert.deepEqual(labels(items), ["Design system board", "Keyboard shortcuts", "Technical details", ...THEME_ITEMS, ...LANGUAGE_ITEMS]);
	assert.deepEqual(items.slice(3, 5).map((item) => [item.getAttribute("role"), item.getAttribute("aria-checked")]), [["menuitemradio", "false"], ["menuitemradio", "true"]]);
	const groups = findAll(menuEl(canvas), (element) => element.getAttribute("role") === "group");
	const headings = withClass(menuEl(canvas), "gd-menu-heading");
	assert.deepEqual(headings.map((heading) => heading.textContent), ["Theme", "Language"]);
	assert.deepEqual(groups.map((group) => group.getAttribute("aria-labelledby")), headings.map((heading) => heading.id), "each group is named by its own heading");
	assert.equal(new Set(headings.map((heading) => heading.id)).size, 2, "the headings' ids are unique");
	assert.equal(withClass(menuEl(canvas), "gd-menu-separator").length, 2, "a separator before the theme and one before the language");
	// The note speaks of the language only: the theme radios are not described by it.
	assert.deepEqual(items.slice(3, 5).map((item) => item.getAttribute("aria-describedby")), [null, null]);
	assert.deepEqual(items.slice(5).map((item) => item.getAttribute("aria-describedby")), ["gd-menu-note", "gd-menu-note", "gd-menu-note"]);
	// Gentleman leads with the mustache from the page's sprite, Neutral with a half-filled circle.
	const icons = items.slice(3, 5).map((item) => findAll(item, (element) => element.localName === "use")[0]?.getAttribute("href"));
	assert.deepEqual(icons, ["#i-mustache", "#i-contrast"]);
});

test("choosing Gentleman applies it at once and saves it; Neutral goes back to :root and saves that", async () => {
	const canvas = await loadTheme();
	choose(canvas, "Gentleman");
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(theme(canvas), "gentleman");
	assert.deepEqual(canvas.themeWrites(), ["gentleman"]);
	assert.deepEqual(openSettings(canvas).slice(3, 5).map((item) => item.getAttribute("aria-checked")), ["true", "false"]);
	canvas.document.activeElement!.dispatch("keydown", { key: "Escape", shiftKey: false });
	choose(canvas, "Neutral");
	assert.equal(theme(canvas), null);
	assert.deepEqual(canvas.themeWrites(), ["gentleman", "neutral"]);
});

test("the saved theme applies on load; an unknown or unreadable one is Neutral, and storage that refuses a write still switches the page", async () => {
	assert.equal(theme(await loadTheme({ stored: "gentleman" })), "gentleman");
	assert.equal(theme(await loadTheme({ stored: "neutral" })), null);
	assert.equal(theme(await loadTheme({ stored: "pink" })), null);
	assert.equal(theme(await loadTheme({ broken: true })), null);
	const full = await loadTheme({ full: true });
	choose(full, "Gentleman");
	assert.equal(theme(full), "gentleman", "the choice holds for this page");
});

test("in Spanish the heading is Tema and Neutral is Neutro; Gentleman keeps its name", async () => {
	const canvas = await loadTheme();
	choose(canvas, "Español");
	const items = openSettings(canvas);
	assert.deepEqual(labels(items.slice(3, 5)), ["Gentleman", "Neutro"]);
	assert.equal(withClass(menuEl(canvas), "gd-menu-heading")[0].textContent, "Tema");
});

test("the ⋯ export menu has no group, heading, note or aria-describedby", async () => {
	const canvas = await loadTheme();
	withClass(canvas.boards[0].wrapper, "gd-menu-button")[0].dispatch("click");
	const menu = menuEl(canvas);
	assert.equal(menu.hidden, false, "the ⋯ menu opened");
	assert.equal(findAll(menu, (element) => element.getAttribute("role") === "group").length, 0);
	assert.equal(withClass(menu, "gd-menu-heading").length, 0);
	assert.equal(findAll(menu, (element) => element.getAttribute("aria-describedby") !== null).length, 0);
});

test("a saved theme must match exactly: case, spaces or other keys make it Neutral", async () => {
	for (const stored of ["Gentleman", " gentleman", "", "__proto__"]) assert.equal(theme(await loadTheme({ stored })), null, JSON.stringify(stored));
});

test("from a saved Gentleman, Neutral removes data-theme and saves neutral", async () => {
	const canvas = await loadTheme({ stored: "gentleman" });
	assert.deepEqual(openSettings(canvas).slice(3, 5).map((item) => item.getAttribute("aria-checked")), ["true", "false"]);
	canvas.document.activeElement!.dispatch("keydown", { key: "Escape", shiftKey: false });
	choose(canvas, "Neutral");
	assert.equal(theme(canvas), null);
	assert.deepEqual(canvas.themeWrites(), ["neutral"]);
});

test("canvas.css: Gentleman sets every color token of :root on --gd-* names, and no rule hard-codes main's accent", () => {
	const css = read("canvas.css");
	const block = (selector: string) => {
		const start = css.indexOf(`${selector} {`);
		assert.ok(start >= 0, `${selector} is styled`);
		return css.slice(start, css.indexOf("}", start));
	};
	const names = (text: string) => [...text.matchAll(/(--gd-[\w-]+):/g)].map((match) => match[1]).sort();
	assert.deepEqual(names(block(':root[data-theme="gentleman"]')), names(block(":root")));
	// Past :root, main's accent and the pin's outline are only read through their tokens.
	const rules = css.slice(css.indexOf("}") + 1);
	assert.ok(!/rgba\(138, 180, 255/.test(rules), "the shield's wash is a token");
	assert.ok(!/#0b1220/.test(rules), "the pin's outline is a token");
});

test("the docs describe the theme radios and where the choice is saved", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	for (const part of ["**Theme**", "**Gentleman**", "**Neutral**", "`gentle-design:theme`"]) assert.ok(docs.includes(part), `the docs mention ${part}`);
});

// The Comment mode outlines inside an artboard (inspector.js) are canvas chrome: gd:mode carries the theme's
// colors, read from canvas.css (--gd-accent, --gd-highlight-wash, --gd-focus). Neutral's are main's outlines.
const NEUTRAL = { accent: "#8ab4ff", wash: "rgba(138, 180, 255, 0.12)", focus: "#ffd479" };
const GENTLEMAN = { accent: "#f095c8", wash: "rgba(240, 149, 200, 0.12)", focus: "#e0c27a" };
const lastMode = (frame: FakeElement) => frame.contentWindow!.posted.filter((message) => message.type === "gd:mode").at(-1);

const lastPosted = (frame: FakeElement) => frame.contentWindow!.posted.at(-1);

test("gd:mode carries the theme's outline colors, and choosing a theme sends only gd:colors to every frame at once", async () => {
	const canvas = await loadTheme();
	for (const frame of canvas.frames()) frame.dispatch("load");
	for (const frame of canvas.frames()) assert.deepEqual(lastMode(frame), { type: "gd:mode", enabled: false, inspect: false, colors: NEUTRAL });
	const modes = canvas.frames().map((frame) => frame.contentWindow!.posted.filter((message) => message.type === "gd:mode").length);
	choose(canvas, "Gentleman");
	for (const frame of canvas.frames()) assert.deepEqual(lastPosted(frame), { type: "gd:colors", colors: GENTLEMAN });
	assert.deepEqual(canvas.frames().map((frame) => frame.contentWindow!.posted.filter((message) => message.type === "gd:mode").length), modes, "no gd:mode: the frame's mode and outlines stay");
	canvas.document.getElementById("gd-comment").dispatch("click");
	for (const frame of canvas.frames()) assert.deepEqual(lastMode(frame), { type: "gd:mode", enabled: true, inspect: false, colors: GENTLEMAN }, "Comment mode keeps the theme");
	choose(canvas, "Neutral");
	for (const frame of canvas.frames()) assert.deepEqual(lastPosted(frame), { type: "gd:colors", colors: NEUTRAL });
});

test("a saved Gentleman reaches each frame's first gd:mode; with no readable colors gd:mode leaves them out", async () => {
	const canvas = await loadTheme({ stored: "gentleman" });
	for (const frame of canvas.frames()) frame.dispatch("load");
	for (const frame of canvas.frames()) assert.deepEqual(lastMode(frame), { type: "gd:mode", enabled: false, inspect: false, colors: GENTLEMAN });
	// No getComputedStyle (or a stylesheet not applied yet): the frames keep the outlines they have.
	const bare = await loadCanvas();
	for (const frame of bare.frames()) frame.dispatch("load");
	for (const frame of bare.frames()) assert.deepEqual(lastMode(frame), { type: "gd:mode", enabled: false, inspect: false });
});

// theme-early.js: a classic script in index.html's <head> that paints a saved Gentleman before the first frame;
// canvas-theme.js (startTheme) stays the source of truth for the store.
function runEarly(localStorage: unknown) {
	const attributes = new Map<string, string>();
	const documentElement = { setAttribute: (name: string, value: string) => attributes.set(name, String(value)) };
	const context: Record<string, unknown> = { document: { documentElement } };
	Object.defineProperty(context, "localStorage", { get: () => (localStorage instanceof Error ? (() => { throw localStorage; })() : localStorage) });
	vm.runInNewContext(read("theme-early.js"), context);
	return attributes.get("data-theme") ?? null;
}

test("index.html loads theme-early.js as a classic, synchronous script in <head>, before the stylesheet and canvas.js", () => {
	const html = read("index.html");
	const head = html.slice(0, html.indexOf("</head>"));
	const tag = '<script src="{{BASE}}assets/theme-early.js"></script>';
	assert.ok(head.includes(tag), "a plain <script src> (no type, async or defer)");
	assert.ok(head.indexOf(tag) < head.indexOf('<link rel="stylesheet"'), "before the stylesheet");
	assert.ok(head.indexOf(tag) < head.indexOf("assets/canvas.js"), "before canvas.js");
	assert.equal(DESIGN_CANVAS_ASSETS["theme-early.js"], "text/javascript; charset=utf-8", "allowlisted, served as JavaScript");
});

test("theme-early.js sets data-theme only for a saved gentleman, and leaves Neutral on anything else or any error", () => {
	const storage = (value: string | null) => ({ getItem: (key: string) => (key === THEME_KEY ? value : null) });
	assert.equal(runEarly(storage("gentleman")), "gentleman");
	for (const value of ["neutral", "Gentleman", " gentleman", "", "pink", null]) assert.equal(runEarly(storage(value)), null, JSON.stringify(value));
	assert.equal(runEarly({ getItem() { throw new Error("denied"); } }), null, "getItem throws");
	assert.equal(runEarly(new Error("SecurityError")), null, "reaching localStorage throws");
	assert.equal(runEarly(undefined), null, "no localStorage");
});
