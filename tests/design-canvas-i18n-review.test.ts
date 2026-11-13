import assert from "node:assert/strict";
import test from "node:test";
import { findAll, flush, handoffDoc, heardGeneration, inspectorPick, loadCanvas, memoryStorage, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// The canvas language over the review surfaces (odd/tasks/canvas-i18n.md S2, S3, S8, S9): the comments panel and its
// filter, Send all, the comment box, the handoff row, Partial implementations, the token inspector and the Quality
// tab, each in Spanish after choosing Español and the exact English again after English, relabeled in place. What
// goes to the agent stays English (S3). Every assertion compares strings, numbers or booleans, never fake elements.

const LANGUAGE_KEY = "gentle-design:language";
const TECHNICAL_KEY = "gentle-design:technical";
const COMMENTS_URL = "/t/api/designs/alpha/comments";
const SEND_ALL_URL = "/t/api/designs/alpha/comments/send-all";
const PARTS_URL = "/t/api/designs/alpha/parts";

/** The canvas with index.html's language markup, an English browser, Implement only this online and the language `stored`. */
async function loadLanguage(replies: Record<string, unknown> = {}, stored?: string, seed: Record<string, string> = {}) {
	const storage = memoryStorage({ ...seed, ...(stored === undefined ? {} : { [LANGUAGE_KEY]: stored }) });
	const navigator = { languages: ["en-US"], language: "en-US" };
	const canvas = await loadCanvas(300, replies, { delivery: { part: true } }, { localStorage: storage.localStorage, navigator }, true);
	// The fake DOM starts every element visible; index.html starts these hidden.
	for (const id of ["gd-popover", "gd-menu", "gd-device-menu", "gd-inspector", "gd-quality"]) canvas.document.getElementById(id).hidden = true;
	canvas.boards.forEach((board, index) => { board.frame.rect = { left: 100 + index * 500, top: 120, width: 400, height: 300 }; });
	return canvas;
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
/** Runs `read` in English, Spanish and English again, checking each against what is expected, and that no frame reloads. */
async function bothWays<T>(canvas: Canvas, read: () => T, english: T, spanish: T) {
	const frames = canvas.frames();
	const sources = frames.map((frame) => frame.src);
	const fetched = canvas.fetched.length;
	assert.deepEqual(read(), english);
	choose(canvas, "Español");
	assert.deepEqual(read(), spanish);
	choose(canvas, "English");
	assert.deepEqual(read(), english);
	await settle();
	assert.equal(canvas.fetched.length, fetched, "a switch fetches nothing");
	assert.ok(canvas.frames().length === frames.length && canvas.frames().every((frame, index) => frame === frames[index] && frame.src === sources[index]), "the same frames, none reloaded");
}

// ---- the comments panel, its filter and Send all (canvas-comments.js, index.html)

const comment = (id: string, file: string, extra: Record<string, unknown> = {}) => ({ id, file, selector: `#${id}`, excerpt: "", comment: `Text of ${id}`, status: "open", createdAt: "2026-10-26T10:00:00.000Z", sentAt: null, ...extra });
const COMMENTS = { comments: [
	comment("c1", "01-a.html", { viewport: { width: 390, height: 844 } }),
	comment("c2", "01-a.html", { sentAt: "2026-10-26T11:00:00.000Z", screenshot: { mimeType: "image/png" } }),
	comment("c3", "02-b.html", { status: "resolved" }),
] };

function panel(canvas: Canvas) {
	const items = withClass($(canvas, "gd-comment-list"), "gd-comment-item").map((item) => {
		const show = withClass(item, "gd-comment-show")[0];
		const toggle = withClass(item, "gd-comment-actions")[0].children[0];
		const chip = withClass(item, "gd-comment-viewport")[0];
		const shot = withClass(item, "gd-comment-shot")[0];
		return [show.getAttribute("aria-label"), ...texts(item, "gd-badge"), chip ? `${chip.textContent} | ${chip.title}` : "", shot ? shot.alt : "", toggle.textContent, toggle.getAttribute("aria-label")];
	});
	return {
		review: [...marked(canvas, "review"), ...markedAttribute(canvas, "aria-label", "review")],
		tabs: [...marked(canvas, "comments"), ...marked(canvas, "tabComments"), ...marked(canvas, "quality"), $(canvas, "gd-count-comments").textContent],
		filter: [...markedAttribute(canvas, "aria-label", "showComments"), $(canvas, "gd-filter-open").textContent, $(canvas, "gd-filter-resolved").textContent],
		list: markedAttribute(canvas, "aria-label", "comments"),
		sendAll: $(canvas, "gd-send-all").textContent,
		items,
		pins: withClass(canvas.world, "gd-pin").map((pin) => pin.getAttribute("aria-label")),
	};
}

test("the comments panel in Spanish: tabs, filter counts, Send all (n), each card's badges, size chip and Resolve, and the pins; the exact English again", async () => {
	const canvas = await loadLanguage({ [COMMENTS_URL]: COMMENTS });
	canvas.message(canvas.boards[0].frame.contentWindow, { type: "gd:pin-rects", rects: [{ id: "c1", rect: { x: 10, y: 10, width: 20, height: 20 } }, { id: "c2", rect: null }] });
	const english = {
		review: ["Review", "Review"],
		tabs: ["Comments", "Comments", "Quality", "2"],
		filter: ["Show comments", "Open (2)", "Resolved (1)"],
		list: ["Comments"],
		sendAll: "Send all (1)",
		items: [
			["Show comment 1 on 01-a.html", "Not sent", "Phone 390 × 844 | Made at Phone 390 × 844", "", "Resolve", "Resolve comment 1"],
			["Show comment 2 on 01-a.html", "Sent", "Detached", "", "Screenshot of comment 2", "Resolve", "Resolve comment 2"],
		],
		pins: ["Comment 1 (open): Text of c1"],
	};
	const spanish = {
		review: ["Revisión", "Revisión"],
		tabs: ["Comentarios", "Comentarios", "Calidad", "2"],
		filter: ["Mostrar comentarios", "Abiertos (2)", "Resueltos (1)"],
		list: ["Comentarios"],
		sendAll: "Enviar todo (1)",
		items: [
			["Mostrar el comentario 1 en 01-a.html", "Aún no enviado", "Móvil 390 × 844 | Hecho en Móvil 390 × 844", "", "Resolver", "Resolver el comentario 1"],
			["Mostrar el comentario 2 en 01-a.html", "Enviado", "Desvinculado", "", "Captura del comentario 2", "Resolver", "Resolver el comentario 2"],
		],
		pins: ["Comentario 1 (abierto): Text of c1"],
	};
	await bothWays(canvas, () => panel(canvas), english, spanish);

	// The resolved filter: Reopen.
	$(canvas, "gd-filter-resolved").dispatch("click");
	const resolved = () => panel(canvas).items;
	await bothWays(canvas, resolved, [["Show comment 3 on 02-b.html", "Not sent", "", "", "Reopen", "Reopen comment 3"]], [["Mostrar el comentario 3 en 02-b.html", "Aún no enviado", "", "", "Reabrir", "Reabrir el comentario 3"]]);
});

test("the comments panel's empty states in Spanish, and the exact English again", async () => {
	const none = await loadLanguage();
	const empty = (canvas: Canvas) => [$(canvas, "gd-panel-empty").hidden, $(canvas, "gd-panel-empty").textContent, $(canvas, "gd-filter-open").textContent, $(canvas, "gd-send-all").textContent];
	await bothWays(none, () => empty(none), [false, "No comments yet. Turn on Comment mode and click an element.", "Open (0)", "Send all (0)"], [false, "Aún no hay comentarios. Activa el modo Comentar y haz clic en un elemento.", "Abiertos (0)", "Enviar todo (0)"]);

	const open = await loadLanguage({ [COMMENTS_URL]: { comments: [comment("c1", "01-a.html")] } });
	$(open, "gd-filter-resolved").dispatch("click");
	await bothWays(open, () => empty(open)[1], "No resolved comments.", "No hay comentarios resueltos.");
});

test("a switch keeps Send all disabled while its request is in flight, so a second click cannot send again", async () => {
	const canvas = await loadLanguage({ [COMMENTS_URL]: COMMENTS, [SEND_ALL_URL]: { ok: true, sent: 1 } });
	const sends = () => canvas.posts.filter((post) => post.url === SEND_ALL_URL).length;
	$(canvas, "gd-send-all").dispatch("click");
	assert.equal($(canvas, "gd-send-all").disabled, true, "disabled while sending");
	choose(canvas, "Español");
	assert.equal($(canvas, "gd-send-all").disabled, true, "still disabled after the switch, before the reply");
	if (!$(canvas, "gd-send-all").disabled) $(canvas, "gd-send-all").dispatch("click");
	await settle();
	assert.equal(sends(), 1, "one request");
	assert.equal($(canvas, "gd-send-all").textContent.startsWith("Enviar todo"), true, "and the button is in the new language once it settles");
});

test("in Spanish the status lines of Send all (one or two), Resolve and Comment mode, and the Save button in Collect", async () => {
	const canvas = await loadLanguage({ [COMMENTS_URL]: COMMENTS, [SEND_ALL_URL]: { ok: true, sent: 1 } }, "es");
	const status = () => $(canvas, "gd-status").textContent;
	$(canvas, "gd-send-all").dispatch("click");
	await settle();
	assert.equal(status(), "Se envió 1 comentario a la sesión");
	assert.deepEqual(canvas.posts.at(-1), { url: SEND_ALL_URL, body: {} });
	canvas.replies[SEND_ALL_URL] = { ok: true, sent: 2 };
	$(canvas, "gd-send-all").disabled = false;
	$(canvas, "gd-send-all").dispatch("click");
	await settle();
	assert.equal(status(), "Se enviaron 2 comentarios a la sesión");
	canvas.replies[`${COMMENTS_URL}/c1/status`] = { ok: true };
	withClass($(canvas, "gd-comment-list"), "gd-comment-actions")[0].children[0].dispatch("click");
	await settle();
	assert.equal(status(), "Comentario resuelto");
	$(canvas, "gd-comment").dispatch("click");
	assert.equal(status(), "Modo Comentar: haz clic en un elemento de una propuesta");

	$(canvas, "gd-mode-collect").dispatch("change");
	assert.equal($(canvas, "gd-popover-send").textContent, "Guardar");
	choose(canvas, "English");
	assert.equal($(canvas, "gd-popover-send").textContent, "Save");
	choose(canvas, "Español");
	assert.equal($(canvas, "gd-popover-send").textContent, "Guardar");
	$(canvas, "gd-mode-send").dispatch("change");
	assert.equal($(canvas, "gd-popover-send").textContent, "Enviar");
});

// ---- the comment box (canvas-popover.js, index.html)

function pick(canvas: Canvas, index = 0) {
	if ($(canvas, "gd-comment").getAttribute("aria-pressed") !== "true") $(canvas, "gd-comment").dispatch("click");
	const frame = canvas.frames()[index];
	canvas.message(frame.contentWindow, inspectorPick(frame, { type: "gd:pick", selector: "nav.side", excerpt: "Home Tours", rect: { x: 1, y: 1, width: 10, height: 10 } }));
}

test("the comment box in Spanish: its title, field, placeholder, screenshot controls, buttons and the limit message; the exact English again", async () => {
	const canvas = await loadLanguage();
	pick(canvas);
	const box = () => {
		$(canvas, "gd-popover-text").value = "";
		$(canvas, "gd-popover-form").dispatch("submit");
		return [
			...marked(canvas, "commentOn"), $(canvas, "gd-popover-target").textContent, ...marked(canvas, "commentLabel"), ...markedAttribute(canvas, "placeholder", "placeholder"),
			$(canvas, "gd-shot-attach").textContent, $(canvas, "gd-shot-attach").getAttribute("title"), $(canvas, "gd-shot-image").getAttribute("alt"), $(canvas, "gd-shot-remove").textContent,
			$(canvas, "gd-popover-cancel").textContent, $(canvas, "gd-popover-part").textContent, $(canvas, "gd-popover-part").title, $(canvas, "gd-popover-send").textContent,
			$(canvas, "gd-popover-message").textContent,
		];
	};
	await bothWays(canvas, box, [
		"Comment on", "01-a.html · nav.side", "Comment", "What should change?",
		"Attach screenshot", "Or paste an image, or drop one here (PNG, JPEG, WebP or GIF, up to 5 MB)", "Attached screenshot", "Remove",
		"Cancel", "Implement only this", "Build only this element in the project; the field is an optional note", "Send",
		"Write a comment of 1 to 2000 characters.",
	], [
		"Comentar en", "01-a.html · nav.side", "Comentario", "¿Qué debería cambiar?",
		"Adjuntar captura", "O pega una imagen, o suéltala aquí (PNG, JPEG, WebP o GIF, hasta 5 MB)", "Captura adjunta", "Quitar",
		"Cancelar", "Implementar solo esto", "Construir solo este elemento en el proyecto; el campo es una nota opcional", "Enviar",
		"Escribe un comentario de 1 a 2000 caracteres.",
	]);
});

test("a validation message already on screen is worded again when the language switches", async () => {
	const canvas = await loadLanguage();
	pick(canvas);
	$(canvas, "gd-popover-text").value = "";
	$(canvas, "gd-popover-form").dispatch("submit");
	assert.equal($(canvas, "gd-popover-message").textContent, "Write a comment of 1 to 2000 characters.");
	choose(canvas, "Español");
	assert.equal($(canvas, "gd-popover-message").textContent, "Escribe un comentario de 1 a 2000 caracteres.", "the message follows the language");
	assert.equal($(canvas, "gd-popover-message").classes.has("gd-error"), true, "and stays an error");
	choose(canvas, "English");
	assert.equal($(canvas, "gd-popover-message").textContent, "Write a comment of 1 to 2000 characters.");
	// A message that is a server's own text (a failed send) is not the canvas's wording: it stays as it came.
	$(canvas, "gd-popover-text").value = "x";
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	choose(canvas, "Español");
	assert.doesNotMatch($(canvas, "gd-popover-message").textContent, /^Escribe un comentario/, "a later message replaced the validation one");
});

test("a switch leaves Implement only this's own message alone, even after a comment-box message", async () => {
	const canvas = await loadLanguage({ "/t/api/designs/alpha/implement-part": { __http: 409, error: "too-many-parts" } });
	pick(canvas);
	$(canvas, "gd-popover-text").value = "";
	$(canvas, "gd-popover-form").dispatch("submit");
	$(canvas, "gd-popover-text").value = "note";
	$(canvas, "gd-popover-part").dispatch("click");
	await settle();
	const refusal = $(canvas, "gd-popover-message").textContent;
	assert.notEqual(refusal, "Write a comment of 1 to 2000 characters.", "the refusal replaced the validation message");
	choose(canvas, "Español");
	assert.equal($(canvas, "gd-popover-message").textContent, refusal, "the parts message is not the comment box's to word again");
	assert.doesNotMatch($(canvas, "gd-popover-message").textContent, /Escribe un comentario/);
	assert.equal($(canvas, "gd-popover-message").title, "too-many-parts");
});

test("identical comment and Parts errors preserve display ownership across language switches", async () => {
	const canvas = await loadLanguage({
		"/t/api/comments": { __throw: "Failed to fetch" },
		"/t/api/designs/alpha/implement-part": { __http: 500, error: "Failed to fetch" },
	});
	pick(canvas);
	const content = "  Keep my wording: más grande  ";
	$(canvas, "gd-popover-text").value = content;
	const message = () => {
		const line = $(canvas, "gd-popover-message");
		return [line.textContent, line.title, line.classes.has("gd-error")];
	};
	const fetched = canvas.fetched.length;
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	await bothWays(canvas, message, ["Not sent: Failed to fetch", "", true], ["No se envió: Failed to fetch", "", true]);
	assert.equal($(canvas, "gd-popover-text").value, content, "a failed comment keeps the user's field");

	$(canvas, "gd-popover-part").dispatch("click");
	await settle();
	await bothWays(canvas, message, ["Not sent: Failed to fetch", "Failed to fetch", true], ["Not sent: Failed to fetch", "Failed to fetch", true]);
	assert.equal($(canvas, "gd-popover-text").value, content, "a failed part and both switches keep the user's field");
	assert.equal(canvas.fetched.length, fetched + 2, "only the two submits fetch");
	assert.deepEqual(canvas.posts, [
		{ url: "/t/api/comments", body: { slug: "alpha", file: "01-a.html", selector: "nav.side", excerpt: "Home Tours", comment: content.trim(), mode: "send" } },
		{ url: "/t/api/designs/alpha/implement-part", body: { file: "01-a.html", selector: "nav.side", excerpt: "Home Tours", note: content.trim() } },
	]);

	// A new comment validation takes the line back and drops the Parts refusal's raw-code tooltip.
	$(canvas, "gd-popover-text").value = "";
	$(canvas, "gd-popover-form").dispatch("submit");
	await bothWays(canvas, message, ["Write a comment of 1 to 2000 characters.", "", true], ["Escribe un comentario de 1 a 2000 caracteres.", "", true]);
	assert.equal(canvas.posts.length, 2, "validation sends nothing");
	assert.equal(canvas.fetched.length, fetched + 2, "validation and switches fetch nothing");
	assert.equal($(canvas, "gd-count-comments").textContent, "0", "failed submits add no comments");
	assert.equal($(canvas, "gd-parts").hidden, true, "failed submits add no parts");
});

test("the offline note of Implement only this is in the stored language from the start, not only after a switch", async () => {
	const storage = memoryStorage({ [LANGUAGE_KEY]: "es" });
	const navigator = { languages: ["en-US"], language: "en-US" };
	const canvas = await loadCanvas(300, {}, { delivery: {} }, { localStorage: storage.localStorage, navigator }, true);
	for (const id of ["gd-popover", "gd-menu", "gd-device-menu", "gd-inspector", "gd-quality"]) canvas.document.getElementById(id).hidden = true;
	canvas.boards.forEach((board, index) => { board.frame.rect = { left: 100 + index * 500, top: 120, width: 400, height: 300 }; });
	pick(canvas as unknown as Canvas);
	const note = () => findAll(canvas.document.getElementById("gd-popover-form"), (element) => element.id === "gd-popover-part-note")[0].textContent;
	assert.equal(note(), "El canvas no está conectado a una sesión de Pi; ábrelo con /gentle:design open");
	choose(canvas as unknown as Canvas, "English");
	assert.equal(note(), "The canvas is not connected to a Pi session; open it with /gentle:design open");
});

test("in Spanish a comment is posted as written, with no word of the canvas in it, and the box says it was sent in Spanish", async () => {
	const canvas = await loadLanguage({ "/t/api/comments": { __http: 202, ok: true } }, "es");
	pick(canvas);
	$(canvas, "gd-popover-text").value = "  Hazlo más grande  ";
	$(canvas, "gd-popover-form").dispatch("submit");
	assert.equal($(canvas, "gd-popover-message").textContent, "Enviando…");
	await settle();
	assert.deepEqual(canvas.posts.at(-1), { url: "/t/api/comments", body: { slug: "alpha", file: "01-a.html", selector: "nav.side", excerpt: "Home Tours", comment: "Hazlo más grande", mode: "send" } });
	assert.deepEqual([$(canvas, "gd-popover-message").textContent, $(canvas, "gd-status").textContent], ["Enviado a la sesión", "Enviado a la sesión"]);
	pick(canvas);
	canvas.replies["/t/api/comments"] = { __http: 500, reason: "disk full" };
	$(canvas, "gd-popover-text").value = "Otra";
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	assert.equal($(canvas, "gd-popover-message").textContent, "No se envió: disk full");
});

// ---- the handoff row (canvas-handoffs.js)

test("the handoff row in Spanish: Chosen, Alternative, the state, the feature's tooltip and Compare; the exact English again", async () => {
	const doc = handoffDoc("01-a.html", { "01-a.html": { status: "implemented", previewUrl: "http://localhost:5173/login", feature: "odd/tasks/login.md" } });
	const canvas = await loadLanguage({ "/t/api/designs/alpha/handoffs": doc });
	const row = () => canvas.boards.map(({ wrapper }) => {
		const handoff = withClass(wrapper, "gd-handoff")[0];
		const compare = withClass(handoff, "gd-compare-start")[0];
		const feature = withClass(handoff, "gd-handoff-feature")[0];
		return [...texts(handoff, "gd-choice"), ...texts(handoff, "gd-handoff-badge"), feature ? `${feature.textContent} | ${feature.title}` : "", compare ? `${compare.textContent} | ${compare.getAttribute("aria-label")}` : ""];
	});
	await bothWays(canvas, row, [
		["Chosen", "Implemented ✓", "odd/tasks/login.md | Tracked in this ODD feature document", "Compare | Compare First with the running app"],
		["Alternative", "", ""],
	], [
		["Elegida", "Implementada ✓", "odd/tasks/login.md | Seguido en este documento de funcionalidad de ODD", "Comparar | Comparar First con la app en marcha"],
		["Alternativa", "", ""],
	]);
});

// ---- Partial implementations (canvas-parts.js, index.html)

test("Partial implementations in Spanish: the title with its count, states, times with a Spanish date, Show and Remove; the exact English again", async () => {
	const today = new Date();
	today.setHours(9, 30, 0, 0);
	const parts = { version: 1, parts: [
		{ id: "p1", file: "01-a.html", selector: "nav.side", excerpt: "Home Tours", status: "sent", queued: false, sentAt: today.toISOString(), startedAt: null, implementedAt: null },
		{ id: "p2", file: "02-b.html", selector: "#pay", excerpt: "", status: "implemented", queued: false, sentAt: "2020-03-01T08:00:00.000Z", startedAt: null, implementedAt: new Date(2020, 2, 4, 9, 5).toISOString(), note: "Done" },
	] };
	const canvas = await loadLanguage({ [PARTS_URL]: parts });
	const list = () => [
		...marked(canvas, "partsTitle"),
		...withClass($(canvas, "gd-parts-list"), "gd-part").map((item) => [...["gd-part-title", "gd-part-state", "gd-part-excerpt", "gd-part-time", "gd-part-note"].map((name) => texts(item, name)[0] ?? ""), ...withClass(item, "gd-part-actions")[0].children.filter((child) => child.localName === "button").map((button) => `${button.textContent} | ${button.getAttribute("aria-label")}`)].join(" / ")),
		texts($(canvas, "gd-parts-list"), "gd-part-question")[0],
	];
	await bothWays(canvas, list, [
		"Partial implementations · 2",
		"First / Sent / “Home Tours” / Sent at 09:30 /  / Show | Show part 1 in 01-a.html / Remove | Remove part 1 in 01-a.html",
		"Second / Implemented ✓ /  / Implemented on Mar 4 2020, 09:05 / “Done” / Show | Show part 2 in 02-b.html",
		"Remove this part? The agent can no longer report on it.",
	], [
		"Implementaciones parciales · 2",
		"First / Enviada / «Home Tours» / Enviada a las 09:30 /  / Mostrar | Mostrar la parte 1 en 01-a.html / Quitar | Quitar la parte 1 en 01-a.html",
		"Second / Implementada ✓ /  / Implementada el 4 mar 2020, 09:05 / «Done» / Mostrar | Mostrar la parte 2 en 02-b.html",
		"¿Quitar esta parte? El agente ya no podrá informar sobre ella.",
	]);
});

// ---- the token inspector (canvas-tokens.js, index.html)

const TOKENS = { exists: true, tokens: [
	{ name: "--text", value: "#f6eff3", section: "Colors", group: "color" },
	{ name: "--paper", value: "#ffffff", section: "Colors", group: "color" },
	{ name: "--font-sans", value: "Inter, sans-serif", section: "Typography", group: "font" },
	{ name: "--radius-sm", value: "8px", section: "Radius", group: "radius" },
	{ name: "--space-2", value: "8px", section: "Spacing", group: "spacing" },
] };
const MEASURE = {
	selector: "main > p.or", label: "p.or", text: "or pay with card", hasText: true, rect: { x: 30, y: 40, width: 200, height: 20 },
	color: { r: 150, g: 130, b: 140, a: 1 }, background: { r: 255, g: 255, b: 255 },
	fontFamily: "Inter, sans-serif", fontSize: 14, fontWeight: 400, lineHeight: null,
	margin: [8, 0, 8, 0], padding: [0, 0, 0, 0], radius: [10, 10, 10, 10],
};

async function inspecting(stored?: string) {
	const canvas = await loadLanguage({ "/t/api/system/tokens": TOKENS }, stored, { [TECHNICAL_KEY]: "on" });
	canvas.viewport.rect = { left: 0, top: 50, width: 1000, height: 1400 };
	$(canvas, "gd-comment").dispatch("click");
	const frame = canvas.boards[0].frame;
	canvas.message(frame.contentWindow, { type: "gd:inspect", element: MEASURE, generation: heardGeneration(frame) });
	return canvas;
}

test("a switch in focus mode keeps the token panel open, translated and beside its element", async () => {
	const canvas = await inspecting();
	canvas.boards[0].shield!.dispatch("keydown", { key: "Enter" });
	const frame = canvas.boards[0].frame;
	canvas.message(frame.contentWindow, { type: "gd:inspect", element: MEASURE, generation: heardGeneration(frame) });
	assert.equal($(canvas, "gd-inspector").hidden, false, "the panel shows in focus mode");
	choose(canvas, "Español");
	assert.equal($(canvas, "gd-inspector").hidden, false, "it stays open across the switch");
	assert.equal($(canvas, "gd-inspector-copy").textContent, "Copiar", "and is translated");
	choose(canvas, "English");
	assert.equal($(canvas, "gd-inspector").hidden, false);
	assert.equal($(canvas, "gd-inspector-copy").textContent, "Copy");
});

test("the token inspector in Spanish: each row's label and words, its buttons; the exact English again", async () => {
	const canvas = await inspecting();
	const all = (element: FakeElement): string => [element.textContent, ...element.children.map(all)].filter(Boolean).join(" ");
	const inspector = () => [
		...withClass($(canvas, "gd-inspector-list"), "gd-inspector-row").map((row) => `${texts(row, "gd-inspector-label")[0]}: ${all(withClass(row, "gd-inspector-value")[0])}`),
		$(canvas, "gd-inspector-fix").textContent, $(canvas, "gd-inspector-copy").textContent,
	];
	await bothWays(canvas, inspector, [
		"Color: #96828c ⚠ no token Nearest --text #f6eff3",
		"Background: #ffffff ✓ --paper",
		"Contrast: ⚠ 3.57 : 1 needs 4.5 : 1",
		"Font: Inter ✓ --font-sans",
		"Size: 14 px weight 400",
		"Line height: normal",
		"Spacing: margin 8 0 8 0 ✓ on scale",
		"Radius: 10 px ⚠ no token Nearest --radius-sm 8px",
		"Ask the agent to fix", "Copy",
	], [
		"Color: #96828c ⚠ sin token Más cercano: --text #f6eff3",
		"Fondo: #ffffff ✓ --paper",
		"Contraste: ⚠ 3.57 : 1 necesita 4.5 : 1",
		"Fuente: Inter ✓ --font-sans",
		"Tamaño: 14 px peso 400",
		"Interlineado: normal",
		"Espaciado: margen 8 0 8 0 ✓ en la escala",
		"Radio: 10 px ⚠ sin token Más cercano: --radius-sm 8px",
		"Pedir al agente que lo corrija", "Copiar",
	]);
});

test("in Spanish Ask the agent to fix in the token inspector prefills the same English request", async () => {
	const prefill = async (stored: string) => {
		const canvas = await inspecting(stored);
		$(canvas, "gd-inspector-fix").dispatch("click");
		return $(canvas, "gd-popover-text").value;
	};
	const english = await prefill("en");
	assert.match(english, /^Fix the values on main > p\.or that are off the design system \(design\/system\.md\):\n- Text color #96828c is not a token/);
	assert.equal(await prefill("es"), english);
});

// ---- the Quality tab (canvas-checks.js, inspector.js findings, index.html)

const CHECK_IDS = ["contrast", "target", "alt", "label", "heading"];
const LOW = '"or pay with card" is 3.1 : 1 (#999999 on #ffffff); WCAG AA needs 4.5 : 1.';
const VARS = { text: "or pay with card", ratio: "3.1", foreground: "#999999", background: "#ffffff", needed: 4.5 };
const finding = (selector: string, extra: Record<string, unknown> = {}) => ({ check: "contrast", severity: "fail", title: "Low contrast", detail: LOW, key: "contrast", vars: VARS, selector, label: `p${selector}`, excerpt: "or pay with card", rect: { x: 30, y: 40, width: 200, height: 20 }, ...extra });
function report(canvas: Canvas, index: number, issues: Array<Record<string, unknown>>) {
	const frame = canvas.boards[index].frame;
	const checks = CHECK_IDS.map((id) => ({ id, label: id, count: issues.filter((issue) => issue.check === id && issue.severity === "fail").length, advice: issues.filter((issue) => issue.check === id && issue.severity === "advice").length }));
	canvas.message(frame.contentWindow, { type: "gd:checks", checks, issues, generation: heardGeneration(frame) });
}
function quality(canvas: Canvas) {
	return withClass($(canvas, "gd-quality"), "gd-check-group").map((group) => [
		group.getAttribute("aria-label"), texts(group, "gd-check-summary")[0],
		...withClass(group, "gd-check").map((card) => [texts(card, "gd-check-title")[0], texts(card, "gd-check-kind")[0], texts(card, "gd-check-detail")[0], withClass(card, "gd-check-show")[0].getAttribute("aria-label"), withClass(card, "gd-check-fix")[0].textContent].join(" | ")),
		...texts(group, "gd-check-passed"),
	]);
}

test("Quality in Spanish: the tab, one problem or two, a contrast finding translated from its key and vars, Show and Ask the agent to fix; the exact English again", async () => {
	const canvas = await loadLanguage();
	$(canvas, "gd-tab-quality").dispatch("click");
	report(canvas, 0, [finding("#a")]);
	report(canvas, 1, [finding("#b"), finding("#c", { key: "contrastLarge", vars: { ...VARS, needed: 3 }, detail: LOW.replace("4.5 : 1.", "3 : 1 for large text.") })]);
	const read = () => [...marked(canvas, "quality"), $(canvas, "gd-count-quality").textContent, ...quality(canvas).flat()];
	await bothWays(canvas, read, [
		"Quality", "3",
		"Accessibility checks of 01 First", "1 check",
		`Low contrast | Problem | ${LOW} | Show Low contrast on p#a in 01 First | Ask the agent to fix`,
		"Passed: Target size · Images have alt text · Form fields have labels · Headings in order",
		"Accessibility checks of 02 Second", "2 checks",
		`Low contrast | Problem | ${LOW} | Show Low contrast on p#b in 02 Second | Ask the agent to fix`,
		`Low contrast | Problem | ${LOW.replace("4.5 : 1.", "3 : 1 for large text.")} | Show Low contrast on p#c in 02 Second | Ask the agent to fix`,
		"Passed: Target size · Images have alt text · Form fields have labels · Headings in order",
	], [
		"Calidad", "3",
		"Comprobaciones de accesibilidad de 01 First", "1 problema",
		"Contraste bajo | Problema | «or pay with card» tiene 3.1 : 1 (#999999 sobre #ffffff); WCAG AA pide 4.5 : 1. | Mostrar Contraste bajo en p#a de 01 First | Pedir al agente que lo corrija",
		"Superadas: Tamaño de los objetivos · Las imágenes tienen texto alternativo · Los campos de formulario tienen etiqueta · Encabezados en orden",
		"Comprobaciones de accesibilidad de 02 Second", "2 problemas",
		"Contraste bajo | Problema | «or pay with card» tiene 3.1 : 1 (#999999 sobre #ffffff); WCAG AA pide 4.5 : 1. | Mostrar Contraste bajo en p#b de 02 Second | Pedir al agente que lo corrija",
		"Contraste bajo | Problema | «or pay with card» tiene 3.1 : 1 (#999999 sobre #ffffff); WCAG AA pide 3 : 1 para texto grande. | Mostrar Contraste bajo en p#c de 02 Second | Pedir al agente que lo corrija",
		"Superadas: Tamaño de los objetivos · Las imágenes tienen texto alternativo · Los campos de formulario tienen etiqueta · Encabezados en orden",
	]);
});

test("in Spanish a finding without a known key or with vars that do not fit shows the English it was sent", async () => {
	const canvas = await loadLanguage({}, "es");
	$(canvas, "gd-tab-quality").dispatch("click");
	const cases: Array<Record<string, unknown>> = [
		{ key: undefined, vars: undefined },
		{ key: "unknown" },
		{ key: "toString" },
		{ vars: { ...VARS, needed: undefined } },
		{ vars: { ...VARS, extra: "x" } },
		{ vars: { ...VARS, text: { nested: true } } },
		{ vars: { ...VARS, text: "x".repeat(500) } },
		{ vars: { ...VARS, needed: Number.NaN } },
		{ vars: [] },
		{ vars: "text" },
	];
	report(canvas, 0, cases.map((extra, index) => finding(`#f${index}`, extra)));
	const shown = quality(canvas)[0].slice(2, 2 + cases.length).map((card) => (card as string).split(" | ").slice(0, 3).join(" | "));
	assert.deepEqual(shown, cases.map(() => `Low contrast | Problema | ${LOW}`));
	assert.equal(texts($(canvas, "gd-quality"), "gd-check-summary")[0], `${cases.length} problemas`, "the report itself is kept");
});

test("in Spanish Ask the agent to fix on a finding prefills the English request with the English title and detail", async () => {
	const canvas = await loadLanguage({}, "es");
	$(canvas, "gd-tab-quality").dispatch("click");
	report(canvas, 0, [finding("#a")]);
	withClass($(canvas, "gd-quality"), "gd-check-fix")[0].dispatch("click");
	assert.equal($(canvas, "gd-popover-text").value, `Accessibility check on #a: Low contrast.\n${LOW}\nFix it so it meets WCAG 2.2 AA, keeping the design's tokens.`);
	// What the canvas posts is that English, as the person leaves it.
	canvas.replies["/t/api/comments"] = { __http: 202, ok: true };
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	assert.equal((canvas.posts.at(-1)!.body as Record<string, unknown>).comment, `Accessibility check on #a: Low contrast.\n${LOW}\nFix it so it meets WCAG 2.2 AA, keeping the design's tokens.`);
});
