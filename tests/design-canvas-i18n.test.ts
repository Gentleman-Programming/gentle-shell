import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { init as i18nInit } from "../assets/design-canvas/canvas-i18n.js";
import { ES } from "../assets/design-canvas/canvas-i18n-es.js";
import { createStore } from "../assets/design-canvas/canvas-store.js";
import { DESIGN_CANVAS_ASSETS } from "../lib/design-canvas-assets.ts";
import { ASSET_DIR, boardsOf, click, FakeDocument, findAll, flush, loadCanvas, memoryStorage, read, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// The canvas language (canvas-i18n.js, canvas-i18n-es.js; odd/tasks/canvas-i18n.md S1-S8): Español, English or
// Match the browser in the rail's Settings, saved in this browser, applied at once; the shell's strings in Spanish.

const LANGUAGE_KEY = "gentle-design:language";
const LANGUAGE_ITEMS = ["Español", "English", "Match the browser"];
const NOTE = "Messages to the agent stay in English.";
// Every canvas module with a TEXT block, by its ES name (canvas-<name>.js): the catalog covers them all.
const MODULE_FILES = readdirSync(ASSET_DIR).filter((name) => /^canvas-[a-z-]+\.js$/.test(name)).sort();
const COVERED = MODULE_FILES.filter((name) => read(name).includes("const TEXT = Object.freeze({")).map((name) => name.slice("canvas-".length, -".js".length));

type Browser = { languages?: string[]; language?: string } | null;

/** The canvas with index.html's language markup, a browser language and an in-memory (or throwing) localStorage. */
async function loadLanguage(options: { browser?: Browser; stored?: string; broken?: boolean; replies?: Record<string, unknown> } = {}) {
	const storage = memoryStorage(options.stored === undefined ? {} : { [LANGUAGE_KEY]: options.stored }, options.broken);
	const navigator = options.browser === null ? undefined : { languages: ["en-US"], language: "en-US", ...options.browser };
	const canvas = await loadCanvas(300, options.replies ?? {}, {}, { localStorage: storage.localStorage, navigator }, true);
	// The fake DOM starts every element visible; index.html starts these hidden.
	canvas.document.getElementById("gd-popover").hidden = true;
	canvas.document.getElementById("gd-menu").hidden = true;
	const languageWrites = () => storage.writes.filter(([key]) => key === LANGUAGE_KEY).map(([, value]) => value);
	return { ...canvas, storage, navigator, languageWrites };
}
type Canvas = Awaited<ReturnType<typeof loadLanguage>>;

const $ = (canvas: Canvas, id: string) => canvas.document.getElementById(id);
const lang = (canvas: Canvas) => canvas.document.documentElement.getAttribute("lang");
const menuEl = (canvas: Canvas) => $(canvas, "gd-menu");
const settingsItems = (canvas: Canvas) => findAll(menuEl(canvas), (element) => (element.getAttribute("role") ?? "").startsWith("menuitem"));
const labels = (items: FakeElement[]) => items.map((item) => texts(item, "gd-menu-label")[0]);
const openSettings = (canvas: Canvas) => {
	$(canvas, "gd-rail-settings").dispatch("click");
	return settingsItems(canvas);
};
const keyOn = (target: FakeElement, key: string) => target.dispatch("keydown", { key, shiftKey: false });
/** Opens Settings and chooses the language item `label` with Enter. */
function choose(canvas: Canvas, label: string) {
	const items = openSettings(canvas);
	const item = items[labels(items).indexOf(label)];
	item.focus();
	keyOn(item, "Enter");
}
/** The text of the markup element keyed `key` (data-i18n), and an attribute of one keyed by data-i18n-<attribute>. */
const marked = (canvas: Canvas, key: string) => findAll(canvas.document.body, (element) => element.getAttribute("data-i18n") === key).map((element) => element.textContent);
const markedAttribute = (canvas: Canvas, attribute: string, key: string) => findAll(canvas.document.body, (element) => element.getAttribute(`data-i18n-${attribute}`) === key).map((element) => element.getAttribute(attribute));
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };

/** What the shell shows, as strings: the surfaces this PR translates. */
function shell(canvas: Canvas) {
	const board = boardsOf(canvas)[0];
	const shield = withClass(board, "gd-shield")[0];
	const start = withClass(board, "gd-implement-start")[0];
	const confirm = withClass(board, "gd-implement-confirm")[0];
	const tools = ["gd-tool-navigate", "gd-comment", "gd-rail-fit", "gd-panel-toggle"].map((id) => $(canvas, id).title);
	const rows = findAll($(canvas, "gd-keys-custom"), (element) => element.classes.has("gd-key-row"));
	return {
		lang: lang(canvas),
		tools,
		railLabels: ["move", "comment", "overview", "settings"].flatMap((key) => marked(canvas, key)),
		railName: markedAttribute(canvas, "aria-label", "tools"),
		settingsTitle: markedAttribute(canvas, "title", "settingsTitle"),
		artboards: markedAttribute(canvas, "aria-label", "artboards"),
		back: [...marked(canvas, "back"), ...markedAttribute(canvas, "title", "backTitle")],
		bar: [...marked(canvas, "fit"), ...marked(canvas, "sendNow"), ...marked(canvas, "collect"), ...marked(canvas, "comments"), ...markedAttribute(canvas, "aria-label", "zoomIn"), ...markedAttribute(canvas, "title", "arrangeGrid")],
		dialog: [...marked(canvas, "shortcutsTitle"), ...marked(canvas, "fitAll"), ...marked(canvas, "restore"), ...marked(canvas, "close")],
		row: [texts(rows[0], "gd-key-action")[0], withClass(rows[0], "gd-key-change")[0].textContent, withClass(rows[0], "gd-key-change")[0].getAttribute("aria-label"), withClass(rows[0], "gd-key-reset")[0].textContent],
		nav: canvas.navMode.textContent,
		implement: [start.textContent, start.getAttribute("aria-label"), confirm.getAttribute("aria-label"), confirm.children[0].textContent],
		shield: [shield.getAttribute("aria-label"), texts(shield, "gd-shield-hint")[0], canvas.frames()[0].title],
		docTitle: canvas.document.title,
	};
}

const ENGLISH = {
	lang: "en",
	tools: ["Move around the canvas (V)", "Comment on an element (C)", "See all the directions (F)", "Comments panel (])"],
	railLabels: ["Move", "Comment", "Overview", "Settings"],
	railName: ["Tools"],
	settingsTitle: ["Settings: design system, keyboard shortcuts and technical details"],
	artboards: ["Artboards"],
	back: ["Back to canvas", "Back to canvas (Shift+Esc)"],
	bar: ["Fit", "Send now", "Collect", "Comments", "Zoom in", "Arrange in a grid"],
	dialog: ["Keyboard shortcuts", "Fit all directions", "Restore defaults", "Close"],
	row: ["Move around the canvas", "Change", "Change the key for “Move around the canvas” (V)", "Reset"],
	nav: "Navigating",
	implement: ["Implement this", "Implement First in the project", "Confirm implementing First", "Send it to the session to implement?"],
	shield: ["Use First", "Click to use this design", "First artboard"],
	docTitle: "Alpha · Gentle Design",
};

const SPANISH = {
	lang: "es",
	tools: ["Moverte por el canvas (V)", "Comentar un elemento (C)", "Ver todas las propuestas (F)", "Panel de comentarios (])"],
	railLabels: ["Mover", "Comentar", "Ver todo", "Ajustes"],
	railName: ["Herramientas"],
	settingsTitle: ["Ajustes: design system, atajos de teclado y detalles técnicos"],
	artboards: ["Propuestas"],
	back: ["Volver al canvas", "Volver al canvas (Mayús+Esc)"],
	bar: ["Ajustar", "Enviar ya", "Acumular", "Comentarios", "Acercar", "Organizar en cuadrícula"],
	dialog: ["Atajos de teclado", "Ajustar todas las propuestas", "Restablecer valores predeterminados", "Cerrar"],
	row: ["Moverte por el canvas", "Cambiar", "Cambiar la tecla de “Moverte por el canvas” (V)", "Restablecer"],
	nav: "Navegando",
	implement: ["Implementar", "Implementar First en el proyecto", "Confirmar la implementación de First", "¿Enviarla a la sesión para implementarla?"],
	shield: ["Usar First", "Haz clic para usar este diseño", "Propuesta First"],
	// The design's title and the product's name: nothing to translate.
	docTitle: "Alpha · Gentle Design",
};

// ---- the default (S1)

test("the default is the browser's language: es* is Spanish, anything else or no browser language is English", async () => {
	const cases: Array<[Browser, string]> = [
		[{ languages: ["es-AR", "en"] }, "es"],
		[{ languages: ["ES"] }, "es"],
		[{ languages: [], language: "es-ES" }, "es"],
		[{ languages: ["en-GB", "es"] }, "en"],
		[{ languages: ["eu-ES"] }, "en"],
		[{ languages: ["est"] }, "en"],
		[null, "en"],
	];
	for (const [browser, expected] of cases) {
		const canvas = await loadLanguage({ browser });
		assert.equal(lang(canvas), expected, JSON.stringify(browser));
		assert.equal(canvas.navMode.textContent, expected === "es" ? "Navegando" : "Navigating", JSON.stringify(browser));
		assert.deepEqual(canvas.languageWrites(), [], "the default is not saved");
	}
});

// ---- the switch in Settings (S1, S8)

test("Settings ends with Español, English and Match the browser as radio items and the note, with the menu's keys", async () => {
	const canvas = await loadLanguage();
	const items = openSettings(canvas);
	assert.deepEqual(labels(items), ["Design system board", "Keyboard shortcuts", "Technical details", ...LANGUAGE_ITEMS]);
	assert.deepEqual(items.slice(3).map((item) => [item.getAttribute("role"), item.getAttribute("aria-checked")]), [["menuitemradio", "false"], ["menuitemradio", "false"], ["menuitemradio", "true"]], "Match the browser is the default");
	assert.deepEqual(texts(menuEl(canvas), "gd-menu-note"), [NOTE]);
	assert.deepEqual(withClass(menuEl(canvas), "gd-menu-note").map((note) => note.getAttribute("role")), ["none"], "a menu owns only items, groups and separators: the note is presentational");
	assert.equal(withClass(menuEl(canvas), "gd-menu-separator").length, 1, "a separator before the language");
	// The menu's keys: the arrows go from Technical details to the radios and wrap.
	items[2].focus();
	keyOn(items[2], "ArrowDown");
	assert.equal(canvas.document.activeElement, items[3]);
	keyOn(items[3], "End");
	assert.equal(canvas.document.activeElement, items[5]);
	keyOn(items[5], "ArrowDown");
	assert.equal(canvas.document.activeElement, items[0]);
	keyOn(items[0], "Escape");
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(lang(canvas), "en", "Esc changes nothing");

	// Enter on Español: the menu closes, focus is back on Settings, and the canvas is Spanish at once.
	choose(canvas, "Español");
	assert.equal(menuEl(canvas).hidden, true);
	assert.equal(canvas.document.activeElement?.id, "gd-rail-settings");
	assert.equal(lang(canvas), "es");
	assert.deepEqual(canvas.languageWrites(), ["es"]);
	const spanish = openSettings(canvas);
	assert.equal(menuEl(canvas).getAttribute("aria-label"), "Ajustes");
	assert.deepEqual(labels(spanish), ["Tablero del design system", "Atajos de teclado", "Detalles técnicos", "Español", "English", "Igual que el navegador"]);
	assert.deepEqual(spanish.slice(3).map((item) => item.getAttribute("aria-checked")), ["true", "false", "false"]);
	assert.deepEqual(texts(menuEl(canvas), "gd-menu-note"), ["Los mensajes al agente siguen en inglés."]);
	// Space chooses too.
	const english = spanish[4];
	english.focus();
	keyOn(english, " ");
	assert.equal(lang(canvas), "en");
	choose(canvas, "Match the browser");
	assert.equal(lang(canvas), "en", "the browser is English");
	assert.deepEqual(canvas.languageWrites(), ["es", "en", "auto"]);
});

test("Settings heads the language radios with Language / Idioma: visible, out of the arrow keys, and the radios' group name", async () => {
	const canvas = await loadLanguage();
	const heading = () => {
		const items = openSettings(canvas);
		const [title] = withClass(menuEl(canvas), "gd-menu-heading");
		const [group] = findAll(menuEl(canvas), (element) => element.getAttribute("role") === "group");
		const grouped = labels(findAll(group, (element) => element.getAttribute("role") === "menuitemradio"));
		// From Technical details the arrows go straight to the first radio and back: the heading is never a stop.
		items[2].focus();
		keyOn(items[2], "ArrowDown");
		const down = canvas.document.activeElement === items[3];
		keyOn(items[3], "ArrowUp");
		const up = canvas.document.activeElement === items[2];
		const result = [title.textContent, title.getAttribute("role"), title.getAttribute("tabindex"), group.getAttribute("aria-labelledby") === title.id && title.id !== "", grouped, down, up];
		keyOn(canvas.document.activeElement!, "Escape");
		return result;
	};
	assert.deepEqual(heading(), ["Language", null, null, true, LANGUAGE_ITEMS, true, true]);
	choose(canvas, "Español");
	assert.deepEqual(heading(), ["Idioma", null, null, true, ["Español", "English", "Igual que el navegador"], true, true]);
});

test("the saved choice wins over the browser; an unknown or unreadable one is Match the browser, and storage that throws still lets the page switch", async () => {
	assert.equal(lang(await loadLanguage({ stored: "es" })), "es");
	assert.equal(lang(await loadLanguage({ stored: "en", browser: { languages: ["es-MX"] } })), "en");
	assert.equal(lang(await loadLanguage({ stored: "auto", browser: { languages: ["es-MX"] } })), "es");
	assert.equal(lang(await loadLanguage({ stored: "fr", browser: { languages: ["es-MX"] } })), "es");

	const broken = await loadLanguage({ broken: true, browser: { languages: ["es-CO"] } });
	assert.equal(lang(broken), "es", "unreadable storage follows the browser");
	const checked = () => {
		const items = openSettings(broken);
		const value = items.slice(3).map((item) => item.getAttribute("aria-checked"));
		$(broken, "gd-rail-settings").dispatch("click");
		return value;
	};
	assert.deepEqual(checked(), ["false", "false", "true"]);
	choose(broken, "English");
	assert.equal(lang(broken), "en", "the choice holds for the page");
	assert.equal(broken.navMode.textContent, "Navigating");
	assert.deepEqual(checked(), ["false", "true", "false"]);
});

test("switching the language reloads no artboard and fetches nothing", async () => {
	const canvas = await loadLanguage();
	const sources = () => canvas.frames().map((frame) => frame.src);
	const before = sources();
	const fetched = canvas.fetched.length;
	const frames = canvas.frames();
	choose(canvas, "Español");
	choose(canvas, "English");
	await settle();
	assert.deepEqual(sources(), before);
	assert.equal(canvas.fetched.length, fetched);
	assert.equal(canvas.frames().length, frames.length);
	assert.ok(canvas.frames().every((frame, index) => frame === frames[index]), "the same frames, relabeled in place");
});

// ---- the shell in Spanish, and back (S2, S6)

test("the shell in Spanish: rail labels and tooltips with their keys, top bar, nav chip, Implement this, the shortcuts list; English again gives the exact English", async () => {
	const canvas = await loadLanguage({ browser: { languages: ["es-ES"] } });
	assert.deepEqual(shell(canvas), SPANISH);
	choose(canvas, "English");
	assert.deepEqual(shell(canvas), ENGLISH);
	choose(canvas, "Español");
	assert.deepEqual(shell(canvas), SPANISH);

	// Focus mode's chip names the artboard as written.
	click(withClass(boardsOf(canvas)[0], "gd-shield")[0], 200, 200);
	assert.equal(canvas.navMode.textContent, "Usando: First · Mayús+Esc para salir");
	choose(canvas, "English");
	assert.equal(canvas.navMode.textContent, "Using: First · Shift+Esc to exit");
});

test("an English canvas from the start shows the same English as before", async () => {
	assert.deepEqual(shell(await loadLanguage()), ENGLISH);
});

test("the empty state, the feature line and the system board follow the language", async () => {
	const replies = {
		"/t/api/system": { exists: true, file: "system.html", width: 1440, height: 1200 },
		"/t/api/designs/alpha": { slug: "alpha", title: "Alpha", feature: "checkout", brief: "", artboards: [] },
		"/t/api/designs": { designs: [{ slug: "alpha", title: "Alpha", valid: true }, { slug: "broken", valid: false }] },
	};
	const canvas = await loadLanguage({ replies });
	const system = () => {
		const board = boardsOf(canvas)[0];
		return [texts(board, "gd-artboard-title")[0], texts(board, "gd-artboard-tradeoff")[0], texts(board, "gd-system-note")[0], texts(board, "gd-shield-hint")[0], $(canvas, "gd-feature").textContent, ...$(canvas, "gd-design").children.map((option) => option.textContent)];
	};
	assert.deepEqual(system(), ["Design system", "Project tokens (design/system.md)", "Comments off on this board", "Click to view the design system", "Feature: checkout", "Alpha", "broken (invalid design.json)"]);
	choose(canvas, "Español");
	assert.deepEqual(system(), ["Design system", "Tokens del proyecto (design/system.md)", "Comentarios desactivados en este tablero", "Haz clic para ver el design system", "Funcionalidad: checkout", "Alpha", "broken (design.json no válido)"]);
	assert.equal($(canvas, "gd-design").disabled, false, "the design list stays as it was");

	const empty = await loadLanguage({ replies: { "/t/api/designs/alpha": replies["/t/api/designs/alpha"] }, stored: "es" });
	assert.equal($(empty, "gd-empty").textContent, "Este diseño aún no tiene propuestas.");
	choose(empty, "English");
	assert.equal($(empty, "gd-empty").textContent, "This design has no artboards yet.");
});

test("languagechange re-resolves Match the browser, and leaves a saved choice alone", async () => {
	const auto = await loadLanguage();
	auto.navigator!.languages = ["es-419"];
	auto.windowEvent("languagechange");
	assert.equal(lang(auto), "es");
	assert.equal(auto.navMode.textContent, "Navegando");
	assert.deepEqual(auto.languageWrites(), [], "following the browser saves nothing");

	const fixed = await loadLanguage({ stored: "en" });
	fixed.navigator!.languages = ["es-419"];
	fixed.windowEvent("languagechange");
	assert.equal(lang(fixed), "en");
	assert.equal(fixed.navMode.textContent, "Navigating");
});

// ---- agent-bound text stays English (S3)

test("Implement this in Spanish sends the same request and says it in Spanish", async () => {
	const canvas = await loadLanguage({ stored: "es", replies: { "/t/api/designs/alpha/implement": { ok: true, slug: "alpha", file: "01-a.html", queued: false } } });
	const [control] = withClass(boardsOf(canvas)[0], "gd-implement");
	withClass(control, "gd-implement-start")[0].dispatch("click");
	withClass(control, "gd-primary")[0].dispatch("click");
	await settle();
	assert.deepEqual(canvas.posts.at(-1), { url: "/t/api/designs/alpha/implement", body: { file: "01-a.html" } });
	assert.equal($(canvas, "gd-toast").textContent, "Enviado: la sesión está implementando First ahora.");
});

test("a module's text view: Spanish per key with English fallback, nested keys, and session always English", () => {
	const store = createStore();
	const document = new FakeDocument();
	const win = { addEventListener() {}, localStorage: { getItem: () => "es", setItem() {} }, navigator: { languages: ["en"] } };
	const i18n = i18nInit({ win, doc: document, store }, { demo: { a: "A es", nested: { b: (n: number) => `${n} es` }, session: { ask: "pregunta" } }, html: {} }, () => {});
	const T = i18n.text("demo", Object.freeze({ a: "A", c: "C", nested: Object.freeze({ b: (n: number) => `${n} en` }), session: Object.freeze({ ask: "Ask the agent" }) }));
	assert.deepEqual([T.a, T.c, T.nested.b(2), T.session.ask], ["A", "C", "2 en", "Ask the agent"], "English before the language starts");
	i18n.startLanguage();
	assert.equal(store.state.language, "es");
	assert.deepEqual([T.a, T.c, T.nested.b(2), T.session.ask], ["A es", "C", "2 es", "Ask the agent"]);
	i18n.setLanguage("en");
	assert.deepEqual([T.a, T.nested.b(2)], ["A", "2 en"]);
});

// ---- one catalog (S4, S8)

/** A module's English TEXT block, evaluated from its source. */
function englishText(module: string): Record<string, unknown> {
	const source = read(`canvas-${module}.js`);
	const start = source.indexOf("const TEXT = Object.freeze({");
	assert.ok(start >= 0 && start < source.indexOf("export function init"), `canvas-${module}.js: one TEXT block before init`);
	const block = source.slice(start + "const TEXT = ".length, source.indexOf("\n});", start) + 3);
	return new Function(`return ${block}`)();
}

function sameShape(english: Record<string, unknown>, spanish: Record<string, unknown>, path: string) {
	assert.deepEqual(Object.keys(spanish).sort(), Object.keys(english).filter((key) => key !== "session").sort(), `${path}: the same keys`);
	for (const [key, value] of Object.entries(spanish)) {
		const source = english[key];
		if (typeof source === "function") {
			assert.equal(typeof value, "function", `${path}.${key}`);
			assert.equal((value as Function).length, source.length, `${path}.${key}: the same parameters`);
		} else if (source && typeof source === "object") sameShape(source as Record<string, unknown>, value as Record<string, unknown>, `${path}.${key}`);
		else assert.equal(typeof value, "string", `${path}.${key}`);
	}
}

test("ES has every key of each covered module's TEXT, with the same parameters, and nothing else, never session", () => {
	assert.deepEqual(COVERED, ["boards", "checks", "comments", "compare", "events", "export", "focus", "handoffs", "layout", "minimap", "parts", "popover", "rail", "sizes", "tokens"], "every module that shows text has a TEXT block");
	assert.deepEqual(Object.keys(ES).filter((key) => key !== "html").sort(), [...COVERED].sort());
	for (const module of COVERED) sameShape(englishText(module), ES[module as keyof typeof ES] as Record<string, unknown>, module);
	assert.ok(!Object.hasOwn(ES, "session") && Object.values(ES).every((entry) => !Object.hasOwn(entry as object, "session")), "no session key");
	assert.ok(Object.isFrozen(ES));
});

test("ES.html has exactly the keys index.html's data-i18n* attributes name", () => {
	const html = read("index.html");
	const keys = new Set([...html.matchAll(/\bdata-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((match) => match[1]));
	assert.deepEqual(Object.keys(ES.html).sort(), [...keys].sort());
	for (const match of html.matchAll(/\bdata-i18n-([a-z-]+)="/g)) assert.ok(["title", "aria-label", "placeholder", "alt"].includes(match[1]), match[1]);
	// A data-i18n element holds only text: a child element would be wiped.
	for (const match of html.matchAll(/<([a-z0-9]+)\s[^>]*\bdata-i18n="[^"]+"[^>]*>([^<]*)<\/([a-z0-9]+)>/g)) assert.equal(match[3], match[1], `${match[2]}: text only`);
	assert.equal(html.match(/\bdata-i18n="/g)?.length, [...html.matchAll(/<([a-z0-9]+)\s[^>]*\bdata-i18n="[^"]+"[^>]*>([^<]*)<\/\1>/g)].length, "every data-i18n element holds only text");
});

test("the covered modules read their strings through ctx.i18n, and the language modules are allowlisted assets", () => {
	for (const module of COVERED) {
		const source = read(`canvas-${module}.js`);
		const body = source.slice(source.indexOf("export function init"));
		assert.match(body, new RegExp(`const T = ctx\\.i18n\\.text\\("${module}", TEXT\\);`), `canvas-${module}.js`);
		assert.equal(body.match(/\bTEXT\b/g)?.length, 1, `canvas-${module}.js reads TEXT only through T`);
	}
	for (const name of ["canvas-i18n.js", "canvas-i18n-es.js"]) assert.equal(DESIGN_CANVAS_ASSETS[name], "text/javascript; charset=utf-8");
	const i18n = read("canvas-i18n.js");
	assert.ok(i18n.includes('"gentle-design:language"'));
	assert.ok(!/state\.language(Choice)?\s*=(?!=)/.test(i18n), "store mutators only");
	const boot = read("canvas-boot.js").replace(/\n\/\/ ?/g, " ");
	assert.ok(boot.includes("relabel"), "canvas-boot.js documents the relabel rule");
});

// ---- every canvas string comes from the catalog (S4): a structural check over the modules and index.html

// Strings with letters that are no canvas text, each left out on purpose.
const NOT_TEXT = new Set([
	// The keys the canvas compares event.key with.
	"Escape", "Enter", "Tab", "Home", "End", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight",
	"Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock", "Hyper", "Super", "Symbol", "SymbolLock",
	// Key caps, which read the same in both languages.
	"Esc",
	// An HTTP header and method, the DataTransfer type of dropped files, a link's rel, a CSS selector and a print rule.
	"Content-Type", "POST", "Files", "noopener noreferrer", "button, a, input, select, textarea, iframe", "@page { size:  px  px; }",
	// The product's name (the page title adds it after the design's).
	"Gentle Design", "· Gentle Design",
	// Errors for the developer, thrown only when the code itself is wrong.
	"canvas:   is exported by two modules", "cannot change",
]);

/**
 * The string literals of a module's code, comments left out: quoted strings, and each template literal's text with its
 * interpolations blanked (the code inside them is read as code). Regular expression literals are skipped.
 */
function literals(source: string): string[] {
	const found: string[] = [];
	let index = 0;
	let previous = "";
	const code = (end: string | null) => {
		let depth = 0;
		while (index < source.length) {
			const char = source[index];
			if (end && char === "}" && depth === 0) return;
			if (source.startsWith("//", index)) index = source.indexOf("\n", index) === -1 ? source.length : source.indexOf("\n", index);
			else if (source.startsWith("/*", index)) index = source.indexOf("*/", index) + 2;
			else if (char === '"' || char === "'") {
				let text = "";
				for (index += 1; source[index] !== char; index += 1) text += source[index] === "\\" ? source[++index] : source[index];
				index += 1;
				found.push(text);
				previous = "a";
			} else if (char === "`") {
				let text = "";
				for (index += 1; source[index] !== "`"; ) {
					if (source.startsWith("${", index)) {
						index += 2;
						code("}");
						index += 1;
						text += " ";
					} else text += source[index] === "\\" ? source[(index += 2) - 1] : source[index++];
				}
				index += 1;
				found.push(text);
				previous = "a";
			} else if (char === "/" && (previous === "" || "(,=:[!&|?{};+".includes(previous))) {
				// A regular expression: up to its closing slash, past classes and escapes.
				let inClass = false;
				for (index += 1; inClass || source[index] !== "/"; index += 1) {
					if (source[index] === "\\") index += 1;
					else if (source[index] === "[") inClass = true;
					else if (source[index] === "]") inClass = false;
				}
				index += 1;
				previous = "a";
			} else {
				if (char === "{") depth += 1;
				else if (char === "}") depth -= 1;
				if (!/\s/.test(char)) previous = /[\w$)\]]/.test(char) ? "a" : char;
				if (/\w/.test(char) && /^(return|typeof|case)\b/.test(source.slice(index)) && !/\w/.test(source[index - 1] ?? "")) {
					const word = /^\w+/.exec(source.slice(index))![0];
					index += word.length;
					previous = "(";
					continue;
				}
				index += 1;
			}
		}
	};
	code(null);
	return found;
}

/**
 * Whether a literal reads as words a person sees: a capitalized word, or two words in a row, once code-like tokens
 * (class names, file names, message types, paths, selectors) are taken out. A single lowercase word is not caught; the
 * per-surface tests in tests/design-canvas-i18n*.test.ts cover those.
 */
function isText(literal: string) {
	const words = literal.split(/\s+/).filter((token) => token && !/[-_:#./=*>[\]()@]|^\d|^[a-z]+[A-Z]/.test(token.replace(/[.,;?!…]+$/, ""))).join(" ");
	return !NOT_TEXT.has(literal.trim()) && (/\p{Lu}\p{Ll}+/u.test(words) || /\p{Ll}{2,}[,;]? \p{Ll}{2,}/u.test(words));
}

test("every visible string of the canvas modules comes from their TEXT block: no word outside it", () => {
	assert.deepEqual(literals('a("Hi", `x ${b ? `Inner text` : "y"} z`, /"no"/g); // "Gone"'), ["Hi", "Inner text", "y", "x   z"], "the literal reader");
	assert.deepEqual(["Sent", "the session did not take it.", "gd-check gd-check-fail", "api/designs/", "Escape", "#i-target", "gd:pins", "image/png"].map(isText), [true, true, false, false, false, false, false, false]);
	const outside: string[] = [];
	for (const name of MODULE_FILES.filter((file) => file !== "canvas-i18n-es.js")) {
		const source = read(name);
		const start = source.indexOf("const TEXT = Object.freeze({");
		const code = start < 0 ? source : source.slice(0, start) + source.slice(source.indexOf("\n});", start) + 4);
		for (const literal of literals(code)) if (isText(literal)) outside.push(`${name}: ${literal}`);
	}
	assert.deepEqual(outside, []);
});

/** index.html's text and words in title, aria-label, placeholder and alt, script, style and the icon sprite left out, each with whether it is keyed. */
function markupStrings(html: string) {
	const body = html.slice(html.indexOf("<body>")).replace(/<svg id="gd-sprite"[^]*?<\/svg>/, "").replace(/<(script|style)\b[^]*?<\/\1>/g, "");
	const strings: Array<{ text: string; keyed: boolean }> = [];
	const open: string[] = [];
	for (const [, closing, tag, attributes, text] of body.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/g)) {
		if (text !== undefined) {
			const words = text.replace(/&[a-z]+;/g, "").trim();
			if (/\p{L}{2,}/u.test(words) && !NOT_TEXT.has(words)) strings.push({ text: words, keyed: /\bdata-i18n="/.test(open.at(-1) ?? "") });
			continue;
		}
		if (closing) {
			open.pop();
			continue;
		}
		for (const name of ["title", "aria-label", "placeholder", "alt"]) {
			const value = new RegExp(`\\s${name}="([^"]*)"`).exec(attributes)?.[1];
			if (value && /\p{L}{2,}/u.test(value)) strings.push({ text: `${name}=${value}`, keyed: new RegExp(`\\sdata-i18n-${name}="`).test(attributes) });
		}
		if (!attributes.endsWith("/") && !["meta", "link", "input", "img", "br", "use"].includes(tag)) open.push(attributes);
	}
	return strings;
}

test("every word index.html shows, as text or in a title, aria-label, placeholder or alt, is keyed for the language", () => {
	const sample = markupStrings('<body><p data-i18n="a">One</p><p>Two <span id="x">3</span></p><b title="Tip" data-i18n-title="t">&minus;</b><img alt="Pic"><kbd>Esc</kbd></body>');
	assert.deepEqual(sample, [{ text: "One", keyed: true }, { text: "Two", keyed: false }, { text: "title=Tip", keyed: true }, { text: "alt=Pic", keyed: false }], "the markup reader");
	assert.deepEqual(markupStrings(read("index.html")).filter((entry) => !entry.keyed).map((entry) => entry.text), []);
});

test("the docs describe the language in Settings: the choices, the default, where it is saved and what stays as written", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"));
	const start = section.indexOf("- **Tool rail**");
	const rail = section.slice(start, section.indexOf("\n", start));
	for (const part of ["**Español**", "**English**", "**Match the browser**", "browser's language", "`gentle-design:language`", "without reloading", "comment text", "artboard titles", "file names", "Messages to the agent stay in English"]) {
		assert.ok(rail.includes(part), `the rail entry mentions ${part}`);
	}
	// Every surface switches; what goes to the agent, the accessibility findings included, stays English.
	for (const part of ["every surface", "Comments panel", "comment box", "**Partial implementations**", "token inspector", "**Quality**", "**Ask the agent to fix** prefills", "findings"]) {
		assert.ok(rail.includes(part), `the rail entry mentions ${part}`);
	}
	const quality = section.slice(section.indexOf("- **Quality**"), section.indexOf("\n", section.indexOf("- **Quality**")));
	assert.ok(quality.includes("in the canvas language") && !quality.includes("(in English)"), "Quality shows each finding in the canvas language");
});
