import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createStore } from "../assets/design-canvas/canvas-store.js";
import { DESIGN_CANVAS_ASSETS } from "../lib/design-canvas-assets.ts";
import { findAll, flush, inspectorPick, loadCanvas, read, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// Partial implementations (canvas-parts.js): Implement only this in the comment popover, the
// "Partial implementations · N" section at the bottom of the panel (state in words, time, excerpt,
// the agent's note, Show) and Remove for a part the agent never took up (S2), with every reload and
// design-switch race the maintainer probes (S7). Every assertion compares strings, numbers or
// booleans, never fake elements, which node:assert would walk whole on a failure.

const PARTS_URL = "/t/api/designs/alpha/parts";
const BETA_PARTS_URL = "/t/api/designs/beta/parts";
const PART_URL = "/t/api/designs/alpha/implement-part";
const REMOVE_URL = "/t/api/designs/alpha/parts/remove";
const ONLINE = { delivery: { part: true } };

async function loadParts(replies: Record<string, unknown> = {}, config: Record<string, unknown> = ONLINE) {
	const canvas = await loadCanvas(300, replies, config);
	// The fake DOM starts every element visible; index.html starts these hidden.
	for (const id of ["gd-popover", "gd-menu", "gd-device-menu"]) canvas.document.getElementById(id).hidden = true;
	return canvas;
}
type Canvas = Awaited<ReturnType<typeof loadParts>>;

const $ = (canvas: Canvas, id: string) => canvas.document.getElementById(id);
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };
/** A reply the test answers later: the request stays in flight until then. */
function deferred() {
	let answer!: (value: unknown) => void;
	const promise = new Promise((resolve) => { answer = resolve; });
	return { promise, answer };
}

function todayAt(hours: number, minutes: number) {
	const date = new Date();
	date.setHours(hours, minutes, 0, 0);
	return date.toISOString();
}
function storedPart(extra: Record<string, unknown> = {}) {
	return { id: "p1", file: "01-a.html", selector: "nav.side", excerpt: "Home Tours", status: "sent", queued: false, sentAt: todayAt(9, 30), startedAt: null, implementedAt: null, ...extra };
}
const partsDoc = (...parts: unknown[]) => ({ version: 1, parts });

const items = (canvas: Canvas) => withClass($(canvas, "gd-parts-list"), "gd-part");
const one = (root: FakeElement, name: string) => withClass(root, name)[0];
const text = (root: FakeElement, name: string) => texts(root, name)[0] ?? "";
const row = (item: FakeElement) => [text(item, "gd-part-title"), text(item, "gd-part-state"), text(item, "gd-part-excerpt"), text(item, "gd-part-time"), text(item, "gd-part-note")];
const bodiesTo = (canvas: Canvas, url: string) => canvas.posts.filter((post) => post.url === url).map((post) => post.body);
const fetchCount = (canvas: Canvas, url: string) => canvas.fetched.filter((fetched) => fetched === url).length;

function pick(canvas: Canvas, index: number, data: Record<string, unknown> = {}) {
	if ($(canvas, "gd-comment").getAttribute("aria-pressed") !== "true") $(canvas, "gd-comment").dispatch("click");
	const frame = canvas.frames()[index];
	canvas.message(frame.contentWindow, inspectorPick(frame, { type: "gd:pick", selector: "nav.side", excerpt: "Home Tours", rect: { x: 1, y: 1, width: 10, height: 10 }, ...data }));
}
function implementOnlyThis(canvas: Canvas, index: number, data: Record<string, unknown> = {}, note = "") {
	pick(canvas, index, data);
	$(canvas, "gd-popover-text").value = note;
	$(canvas, "gd-popover-part").dispatch("click");
}
/** Remove, then the confirm's Remove, on the part at `index`. */
function confirmRemove(canvas: Canvas, index: number) {
	const item = items(canvas)[index];
	one(item, "gd-part-remove").dispatch("click");
	one(item, "gd-part-confirm-yes").dispatch("click");
}

// ---- Implement only this (S8: parts in the popover)

test("Implement only this sits between Cancel and Send, enabled only when the page config's delivery.part is true", async () => {
	const html = read("index.html");
	const actions = html.slice(html.indexOf('<div class="gd-popover-actions">'), html.indexOf("</form>"));
	assert.match(actions, /<button type="button" id="gd-popover-part" data-i18n="implementOnly" disabled>Implement only this<\/button>/);
	assert.ok(actions.indexOf("gd-popover-cancel") < actions.indexOf("gd-popover-part") && actions.indexOf("gd-popover-part") < actions.indexOf("gd-popover-send"), "after Cancel, before Send");
	const cases: Array<[Record<string, unknown>, boolean]> = [[ONLINE, true], [{}, false], [{ delivery: { part: false } }, false], [{ delivery: { part: "yes" } }, false]];
	for (const [config, enabled] of cases) {
		const canvas = await loadParts({ [PART_URL]: { ok: true, id: "p1", queued: false } }, config);
		pick(canvas, 0);
		assert.equal($(canvas, "gd-popover").hidden, false);
		const button = $(canvas, "gd-popover-part");
		assert.equal(button.disabled, !enabled, JSON.stringify(config));
		if (enabled) {
			assert.equal(button.title, "Build only this element in the project; the field is an optional note");
			continue;
		}
		assert.equal(button.title, "The canvas is not connected to a Pi session; open it with /gentle:design open");
		button.dispatch("click");
		await settle();
		assert.deepEqual(canvas.posts, [], "a disabled button sends nothing");
	}
});

test("Implement only this posts the element with the optional note, says Sent or Queued, lists the part at once and saves no comment", async () => {
	const canvas = await loadParts({ [PART_URL]: { ok: true, id: "p1", queued: false } });
	assert.equal($(canvas, "gd-parts").hidden, true, "no parts, no section");
	implementOnlyThis(canvas, 0, {}, "  only the menu\r\nnot the header ");
	await settle();
	assert.deepEqual(bodiesTo(canvas, PART_URL), [{ file: "01-a.html", selector: "nav.side", excerpt: "Home Tours", note: "only the menu\nnot the header" }]);
	assert.deepEqual(canvas.posts.map((post) => post.url), [PART_URL], "no comment is saved or sent");
	const sent = "Sent: the session is building only this part of First now.";
	assert.equal($(canvas, "gd-toast").textContent, sent);
	assert.equal($(canvas, "gd-status").textContent, sent);
	assert.equal($(canvas, "gd-popover-text").value, "", "the field is cleared");
	assert.equal($(canvas, "gd-popover-message").textContent, "Sent to the session");
	assert.equal($(canvas, "gd-popover-message").classes.has("gd-error"), false);
	assert.equal($(canvas, "gd-popover-part").disabled, true, "sent: disabled until the popover opens again");
	assert.deepEqual(texts(canvas.world, "gd-choice"), [], "no direction is chosen");
	assert.equal($(canvas, "gd-parts").hidden, false, "the part shows before its parts.json change event");
	assert.equal($(canvas, "gd-parts-title").textContent, "Partial implementations · 1");
	assert.deepEqual(items(canvas).map((item) => row(item).slice(0, 3)), [["First", "Sent", "“Home Tours”"]]);
	assert.match(text(items(canvas)[0], "gd-part-time"), /^Sent at \d\d:\d\d$/);

	// The note is optional: the textarea's `required` never blocks it.
	canvas.replies[PART_URL] = { ok: true, id: "p2", queued: true };
	implementOnlyThis(canvas, 1, { selector: "footer", excerpt: "" });
	await settle();
	assert.deepEqual(bodiesTo(canvas, PART_URL)[1], { file: "02-b.html", selector: "footer", excerpt: "" });
	assert.equal($(canvas, "gd-toast").textContent, "Queued: the session will build only this part of Second after its current task.");
	assert.deepEqual(items(canvas).map((item) => row(item).slice(0, 3)), [["First", "Sent", "“Home Tours”"], ["Second", "Queued", ""]]);

	// The parts.json change event that follows lists the same part once.
	canvas.replies[PARTS_URL] = partsDoc(storedPart(), storedPart({ id: "p2", file: "02-b.html", selector: "footer", excerpt: "", queued: true }));
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["p1", "p2"]);
});

test("Implement only this refuses a long note, disables itself while in flight and explains each server error", async () => {
	const canvas = await loadParts();
	implementOnlyThis(canvas, 0, {}, "n".repeat(2001));
	await settle();
	assert.deepEqual(canvas.posts, []);
	assert.equal($(canvas, "gd-popover-message").textContent, "The note can have at most 2000 characters.");
	assert.equal($(canvas, "gd-popover-message").classes.has("gd-error"), true);

	const cases: Array<[Record<string, unknown>, string]> = [
		[{ __http: 500, error: "delivery-failed", slug: "alpha", file: "01-a.html", reason: "session closed" }, "Not sent: the session did not take it (session closed)."],
		[{ __http: 501, error: "implement-part-unavailable" }, "Not sent: the canvas is not connected to a Pi session; open it with /gentle:design open."],
		[{ __http: 409, error: "too-many-parts", reason: "at most 100" }, "Not sent: this design already has 100 parts; remove one first."],
		[{ __http: 409, error: "parts-too-large", reason: "1 MiB" }, "Not sent: parts.json is full; remove a part first."],
		[{ __http: 422, error: "invalid-parts", reason: "bad json" }, "Not sent: parts.json cannot be read; fix it or delete it."],
		[{ __http: 400, error: "invalid-file", reason: "x" }, "Not sent: that artboard is no longer in the design."],
		[{ __http: 404, error: "not-found" }, "Not sent: the design is gone."],
		[{ __http: 418, error: "teapot" }, "Not sent: teapot"],
		[{ __throw: "offline" }, "Not sent: offline"],
	];
	for (const [reply, message] of cases) {
		const flight = deferred();
		canvas.replies[PART_URL] = flight.promise;
		implementOnlyThis(canvas, 0, {}, "only the menu");
		await settle();
		assert.equal($(canvas, "gd-popover-part").disabled, true, "disabled while in flight");
		assert.equal($(canvas, "gd-popover-message").textContent, "Sending…");
		flight.answer(reply);
		await settle();
		assert.equal($(canvas, "gd-popover-message").textContent, message, JSON.stringify(reply));
		assert.equal($(canvas, "gd-popover-message").classes.has("gd-error"), true);
		assert.equal($(canvas, "gd-popover-message").title, typeof reply.error === "string" ? reply.error : "", "the raw code in the tooltip");
		assert.equal($(canvas, "gd-popover-part").disabled, false, "it can be retried");
		assert.equal($(canvas, "gd-popover-text").value, "only the menu", "the note is kept");
	}
	assert.equal($(canvas, "gd-parts").hidden, true, "a refused part is never listed");
});

test("an implement-part reply after a design switch leaves the new design's list alone and still says it was sent", async () => {
	const flight = deferred();
	const canvas = await loadParts({ [PART_URL]: flight.promise, [BETA_PARTS_URL]: partsDoc(storedPart({ id: "b1", file: "01-only.html", excerpt: "Beta part" })) });
	implementOnlyThis(canvas, 0);
	await settle();
	await canvas.serverEvent("show", { slug: "beta" });
	assert.equal($(canvas, "gd-popover").hidden, true, "the switch closed the popover");
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["b1"]);
	flight.answer({ ok: true, id: "p9", queued: false });
	await settle();
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["b1"], "the alpha part is not added to beta's list");
	assert.equal($(canvas, "gd-toast").textContent, "Sent: the session is building only this part of First now.");

	// A refusal after the switch reaches the status line, since its popover is gone.
	const second = deferred();
	const other = await loadParts({ [PART_URL]: second.promise });
	implementOnlyThis(other, 0);
	await settle();
	await other.serverEvent("show", { slug: "beta" });
	second.answer({ __http: 500, error: "delivery-failed", reason: "session closed" });
	await settle();
	assert.equal($(other, "gd-status").textContent, "Not sent: the session did not take it (session closed).");
	assert.equal($(other, "gd-status").classes.has("gd-error"), true);
});

test("after a part is sent, Implement only this stays disabled until the popover opens again: a second click sends nothing", async () => {
	const canvas = await loadParts({ [PART_URL]: { ok: true, id: "p1", queued: false } });
	implementOnlyThis(canvas, 0);
	await settle();
	assert.equal(bodiesTo(canvas, PART_URL).length, 1);
	assert.equal($(canvas, "gd-popover").hidden, false, "the popover is still open before it closes itself");
	assert.equal($(canvas, "gd-popover-part").disabled, true);
	$(canvas, "gd-popover-part").dispatch("click");
	await settle();
	assert.equal(bodiesTo(canvas, PART_URL).length, 1, "no duplicate part");
	pick(canvas, 1);
	assert.equal($(canvas, "gd-popover-part").disabled, false, "a new pick enables it again");
});

test("the popover message's tooltip (a refusal's raw code) goes when the popover opens again or the message changes", async () => {
	const canvas = await loadParts({ [PART_URL]: { __http: 500, error: "delivery-failed", reason: "session closed" }, "/t/api/comments": { __http: 202, ok: true } });
	implementOnlyThis(canvas, 0);
	await settle();
	assert.equal($(canvas, "gd-popover-message").title, "delivery-failed");
	pick(canvas, 1);
	assert.deepEqual([$(canvas, "gd-popover-message").textContent, $(canvas, "gd-popover-message").title], ["", ""], "a new pick starts clean");
	implementOnlyThis(canvas, 1);
	await settle();
	assert.equal($(canvas, "gd-popover-message").title, "delivery-failed");
	$(canvas, "gd-popover-text").value = "Fix the menu";
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	assert.deepEqual([$(canvas, "gd-popover-message").textContent, $(canvas, "gd-popover-message").title], ["Sent to the session", ""], "a comment sent after it drops the code");
});

test("without a Pi session the reason Implement only this is disabled is a note under the buttons, which the button points to", async () => {
	const offline = await loadParts({}, {});
	pick(offline, 0);
	const button = $(offline, "gd-popover-part");
	assert.equal(button.disabled, true);
	const noteId = button.getAttribute("aria-describedby");
	assert.equal(noteId, "gd-popover-part-note");
	const notes = findAll($(offline, "gd-popover-form"), (element) => element.id === noteId);
	assert.equal(notes.length, 1, "the note is in the popover");
	assert.deepEqual([notes[0].hidden, notes[0].textContent], [false, "The canvas is not connected to a Pi session; open it with /gentle:design open"]);
	assert.equal(notes[0].classes.has("gd-popover-note"), true);

	const online = await loadParts();
	pick(online, 0);
	assert.equal($(online, "gd-popover-part").getAttribute("aria-describedby"), null, "connected: nothing to explain");
	assert.deepEqual(findAll($(online, "gd-popover-form"), (element) => element.id === "gd-popover-part-note").map((note) => note.hidden), [true]);
	const css = read("canvas.css");
	assert.match(css, /\.gd-popover-note \{[^}]*var\(--gd-muted\)/, "styled on the --gd-* tokens");
});

// ---- Partial implementations (S8: at the bottom of the panel, hidden with no parts)

test("Partial implementations lists each part live from parts.json: state in words, time, excerpt, the agent's note", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(
		storedPart(),
		storedPart({ id: "p2", file: "02-b.html", selector: "footer", excerpt: "", queued: true, sentAt: todayAt(9, 40) }),
		storedPart({ id: "p3", file: "02-b.html", selector: "aside", excerpt: "Filters", status: "in_progress", startedAt: todayAt(9, 48), note: "Building the filters" }),
		storedPart({ id: "p4", file: "09-gone.html", selector: "header", excerpt: "Logo", status: "implemented", startedAt: "2020-03-04T08:00:00", implementedAt: "2020-03-04T09:05:00", note: "src/Header.tsx" }),
	) });
	assert.equal($(canvas, "gd-parts").hidden, false);
	assert.equal($(canvas, "gd-parts-title").textContent, "Partial implementations · 4");
	assert.deepEqual(items(canvas).map(row), [
		["First", "Sent", "“Home Tours”", "Sent at 09:30", ""],
		["Second", "Queued", "", "Queued at 09:40", ""],
		["Second", "In progress", "“Filters”", "In progress since 09:48", "“Building the filters”"],
		["09-gone.html", "Implemented ✓", "“Logo”", "Implemented on Mar 4 2020, 09:05", "“src/Header.tsx”"],
	]);
	assert.deepEqual(items(canvas).map((item) => item.dataset.status), ["sent", "queued", "in_progress", "implemented"]);
	assert.deepEqual(items(canvas).map((item) => withClass(item, "gd-part-remove").length), [1, 1, 0, 0], "Remove only while the agent has not taken it up");
	assert.deepEqual(items(canvas).map((item) => one(item, "gd-part-show").disabled), [false, false, false, true], "no Show without its artboard");
	assert.equal(withClass($(canvas, "gd-parts"), "gd-part-selector").length, 0, "no selector without Technical details");

	const before = canvas.frames().map((frame) => frame.src);
	const fetches = fetchCount(canvas, PARTS_URL);
	canvas.replies[PARTS_URL] = partsDoc(storedPart({ status: "implemented", startedAt: todayAt(9, 50), implementedAt: todayAt(10, 5), note: "src/layout/Sidebar.tsx" }));
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	assert.equal(fetchCount(canvas, PARTS_URL), fetches + 1);
	assert.deepEqual(items(canvas).map(row), [["First", "Implemented ✓", "“Home Tours”", "Implemented at 10:05", "“src/layout/Sidebar.tsx”"]]);
	assert.deepEqual(canvas.frames().map((frame) => frame.src), before, "a parts.json change reloads no artboard");
	await canvas.serverEvent("change", { slug: "beta", file: "parts.json" });
	assert.equal(fetchCount(canvas, PARTS_URL), fetches + 1, "another design's parts.json is not fetched");

	canvas.replies[PARTS_URL] = partsDoc(null, { id: 3, file: "01-a.html" }, storedPart({ status: "weird" }), storedPart({ selector: 4 }));
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	assert.equal($(canvas, "gd-parts").hidden, true, "malformed parts are skipped; none left, no section");
	assert.equal($(canvas, "gd-parts-list").children.length, 0);

	canvas.replies[PARTS_URL] = { __http: 422, error: "invalid-parts", reason: "parts.json is not valid JSON" };
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	assert.equal($(canvas, "gd-status").textContent, "parts.json for alpha cannot be read: parts.json is not valid JSON");
	assert.equal($(canvas, "gd-status").classes.has("gd-error"), true);
});

test("Show opens the part's artboard and highlights its element in every frame of it", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart(), storedPart({ id: "p2", file: "02-b.html", selector: "footer" })) });
	const show = one(items(canvas)[1], "gd-part-show");
	assert.equal(show.textContent, "Show");
	assert.equal(show.getAttribute("aria-label"), "Show part 2 in 02-b.html");
	show.dispatch("click");
	assert.equal(canvas.navMode.textContent, "Using: Second · Shift+Esc to exit");
	const highlights = (frame: FakeElement) => frame.contentWindow!.posted.filter((message) => message.type === "gd:highlight");
	assert.deepEqual(highlights(canvas.frames()[1]), [{ type: "gd:highlight", selector: "footer" }]);
	assert.deepEqual(highlights(canvas.frames()[0]), []);

	// In All sizes each size frame highlights it too.
	$(canvas, "gd-back").dispatch("click");
	canvas.boards[0].shield!.dispatch("keydown", { key: "Enter" });
	$(canvas, "gd-device").dispatch("click");
	findAll($(canvas, "gd-device-menu"), (element) => element.dataset.size === "all")[0].dispatch("click");
	const sizeFrames = withClass(canvas.viewport, "gd-size-frame").map((section) => findAll(section, (element) => element.localName === "iframe")[0]);
	assert.equal(sizeFrames.length, 3);
	one(items(canvas)[0], "gd-part-show").dispatch("click");
	assert.deepEqual([canvas.frames()[0], ...sizeFrames].map((frame) => highlights(frame).at(-1)?.selector), ["nav.side", "nav.side", "nav.side", "nav.side"]);
	assert.equal(withClass(canvas.viewport, "gd-size-frame").length, 3, "Show keeps the size the artboard is open at");
});

test("Show looks its artboard up at click time: a board a manifest reload dropped is not opened", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart({ id: "p2", file: "02-b.html", selector: "footer" })) });
	const stale = one(items(canvas)[0], "gd-part-show");
	assert.equal(stale.disabled, false);
	const manifest = canvas.replies["/t/api/designs/alpha"] as { artboards: unknown[] };
	manifest.artboards = manifest.artboards.slice(0, 1);
	const parts = deferred();
	canvas.replies[PARTS_URL] = parts.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	assert.equal(canvas.frames().length, 1);
	stale.dispatch("click");
	assert.equal(canvas.navMode.textContent, "Navigating", "nothing opens");
	assert.equal($(canvas, "gd-status").textContent, "Not shown: the artboard of this part is no longer in the design.");
	parts.answer(partsDoc(storedPart({ id: "p2", file: "02-b.html", selector: "footer" })));
	await settle();
	assert.equal(one(items(canvas)[0], "gd-part-show").disabled, true, "the reloaded list disables it");
	assert.equal(text(items(canvas)[0], "gd-part-title"), "02-b.html");
});

test("a design switch drops the old parts at once and ignores a parts fetch still in flight for the old design", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart()) });
	assert.equal(items(canvas).length, 1);
	const late = deferred();
	canvas.replies[PARTS_URL] = late.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	const beta = deferred();
	canvas.replies[BETA_PARTS_URL] = beta.promise;
	await canvas.serverEvent("show", { slug: "beta" });
	assert.equal($(canvas, "gd-parts").hidden, true, "alpha's parts go with alpha");
	assert.equal(items(canvas).length, 0);
	late.answer(partsDoc(storedPart({ id: "late" })));
	await settle();
	assert.equal(items(canvas).length, 0, "a late alpha reply is ignored");
	beta.answer(partsDoc(storedPart({ id: "b1", file: "01-only.html", excerpt: "Beta" })));
	await settle();
	assert.deepEqual(items(canvas).map((item) => row(item).slice(0, 3)), [["Only", "Sent", "“Beta”"]]);
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["b1"]);

	await canvas.serverEvent("show", { slug: null });
	assert.equal($(canvas, "gd-parts").hidden, true, "the system-only view has no parts");
});

test("the design selector drops the old parts at once, before the new design.json answers and when it fails", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart()) });
	assert.equal(items(canvas).length, 1);
	const held = deferred();
	canvas.replies["/t/api/designs/beta"] = held.promise;
	const select = $(canvas, "gd-design");
	select.value = "beta";
	select.dispatch("change");
	await settle();
	assert.equal($(canvas, "gd-parts").hidden, true, "alpha's parts go before beta's design.json answers");
	assert.equal(items(canvas).length, 0, "no Remove of alpha's part is left");
	held.answer({ __http: 500, error: "invalid-design", reason: "bad json" });
	await settle();
	assert.equal($(canvas, "gd-parts").hidden, true, "nor after beta's design.json fails");
	assert.equal(items(canvas).length, 0);
	assert.deepEqual(bodiesTo(canvas, REMOVE_URL), []);
});

test("parts.json replies that land out of order: the newest load wins, an older one changes nothing", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart()) });
	const older = deferred();
	canvas.replies[PARTS_URL] = older.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	const newer = deferred();
	canvas.replies[PARTS_URL] = newer.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	newer.answer(partsDoc(storedPart({ status: "in_progress", startedAt: todayAt(9, 48) })));
	await settle();
	older.answer(partsDoc(storedPart({ queued: true }), storedPart({ id: "removed" })));
	await settle();
	assert.deepEqual(items(canvas).map((item) => [item.dataset.id, item.dataset.status]), [["p1", "in_progress"]]);

	// An older load that fails after a newer one says nothing either.
	const stale = deferred();
	canvas.replies[PARTS_URL] = stale.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	canvas.replies[PARTS_URL] = partsDoc(storedPart({ status: "implemented", implementedAt: todayAt(10, 5) }));
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	stale.answer({ __http: 422, error: "invalid-parts", reason: "parts.json is not valid JSON" });
	await settle();
	assert.equal($(canvas, "gd-status").textContent.startsWith("parts.json for alpha cannot be read"), false);
	assert.deepEqual(items(canvas).map((item) => item.dataset.status), ["implemented"]);
});

test("a parts.json reply older than a part Implement only this just listed does not drop that part", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart()), [PART_URL]: { __http: 202, ok: true, id: "p2", queued: false } });
	const held = deferred();
	canvas.replies[PARTS_URL] = held.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	// What parts.json holds once the server accepted p2, for the fresh read that follows.
	canvas.replies[PARTS_URL] = partsDoc(storedPart(), storedPart({ id: "p2", file: "02-b.html", selector: "footer", excerpt: "" }));
	implementOnlyThis(canvas, 1, { selector: "footer", excerpt: "" });
	await settle();
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["p1", "p2"]);
	held.answer(partsDoc());
	await settle();
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["p1", "p2"], "the older reply changes nothing");
});

test("a parts.json reply older than a succeeded Remove does not bring the removed part back", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart()), [REMOVE_URL]: { ok: true, id: "p1" } });
	const held = deferred();
	canvas.replies[PARTS_URL] = held.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	// What parts.json holds once the server removed p1, for the fresh read that follows.
	canvas.replies[PARTS_URL] = partsDoc();
	confirmRemove(canvas, 0);
	await settle();
	assert.equal(items(canvas).length, 0);
	held.answer(partsDoc(storedPart()));
	await settle();
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), [], "the older reply changes nothing");
	assert.equal($(canvas, "gd-parts").hidden, true);
});

test("after Implement only this lists a part, a fresh parts.json read keeps the other parts' updates an in-flight read carried", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart()), [PART_URL]: { __http: 202, ok: true, id: "p2", queued: false } });
	const held = deferred();
	canvas.replies[PARTS_URL] = held.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	const fetches = fetchCount(canvas, PARTS_URL);
	const implemented = storedPart({ status: "implemented", implementedAt: todayAt(10, 5) });
	canvas.replies[PARTS_URL] = partsDoc(implemented, storedPart({ id: "p2", file: "02-b.html", selector: "footer", excerpt: "" }));
	implementOnlyThis(canvas, 1, { selector: "footer", excerpt: "" });
	await settle();
	assert.equal(fetchCount(canvas, PARTS_URL), fetches + 1, "a fresh read follows the local change");
	held.answer(partsDoc(implemented));
	await settle();
	assert.deepEqual(items(canvas).map((item) => [item.dataset.id, item.dataset.status]), [["p1", "implemented"], ["p2", "sent"]]);
});

test("after a succeeded Remove, a fresh parts.json read keeps the other parts' updates an in-flight read carried", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart(), storedPart({ id: "p2", file: "02-b.html", selector: "footer" })), [REMOVE_URL]: { ok: true, id: "p2" } });
	const held = deferred();
	canvas.replies[PARTS_URL] = held.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	const fetches = fetchCount(canvas, PARTS_URL);
	const implemented = storedPart({ status: "implemented", implementedAt: todayAt(10, 5) });
	canvas.replies[PARTS_URL] = partsDoc(implemented);
	confirmRemove(canvas, 1);
	await settle();
	assert.equal(fetchCount(canvas, PARTS_URL), fetches + 1, "a fresh read follows the local change");
	held.answer(partsDoc(implemented, storedPart({ id: "p2", file: "02-b.html", selector: "footer" })));
	await settle();
	assert.deepEqual(items(canvas).map((item) => [item.dataset.id, item.dataset.status]), [["p1", "implemented"]]);
});

test("a parts.json load that fails keeps the parts shown and says why in the status line", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart()) });
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["p1"]);
	canvas.replies[PARTS_URL] = { __http: 500, error: "internal", reason: "disk busy" };
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	await settle();
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["p1"], "the shown list is kept");
	assert.equal($(canvas, "gd-parts").hidden, false);
	assert.equal($(canvas, "gd-parts-title").textContent, "Partial implementations · 1");
	assert.equal($(canvas, "gd-status").textContent, "parts.json for alpha cannot be read: disk busy");
	assert.equal($(canvas, "gd-status").classes.has("gd-error"), true);
});

test("Implement only this sends an element once while its request is in flight, even after the popover closes and the same element is picked again", async () => {
	const flight = deferred();
	const canvas = await loadParts({ [PART_URL]: flight.promise });
	implementOnlyThis(canvas, 0);
	await settle();
	$(canvas, "gd-popover-cancel").dispatch("click");
	assert.equal($(canvas, "gd-popover").hidden, true);
	pick(canvas, 0);
	assert.equal($(canvas, "gd-popover-part").disabled, true, "the same element in flight: disabled");
	$(canvas, "gd-popover-part").dispatch("click");
	await settle();
	assert.equal(bodiesTo(canvas, PART_URL).length, 1, "no second request");
	pick(canvas, 1);
	assert.equal($(canvas, "gd-popover-part").disabled, false, "another element can be sent");
	pick(canvas, 0);
	assert.equal($(canvas, "gd-popover-part").disabled, true);

	// The reply releases the element: a refusal lets it be sent again.
	flight.answer({ __http: 500, error: "delivery-failed", reason: "session closed" });
	await settle();
	assert.equal($(canvas, "gd-popover-part").disabled, false, "released when the reply arrives");
	canvas.replies[PART_URL] = { ok: true, id: "p1", queued: false };
	$(canvas, "gd-popover-part").dispatch("click");
	await settle();
	assert.equal(bodiesTo(canvas, PART_URL).length, 2);
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["p1"]);
});

test("an implement-part reply that lands after its part was listed and removed does not bring the part back", async () => {
	const flight = deferred();
	const canvas = await loadParts({ [PART_URL]: flight.promise, [REMOVE_URL]: { ok: true, id: "p1" } });
	implementOnlyThis(canvas, 0);
	await settle();
	// Delivery completed: the parts.json change event lists the part before the send's reply arrives.
	canvas.replies[PARTS_URL] = partsDoc(storedPart());
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	await settle();
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["p1"]);
	canvas.replies[PARTS_URL] = partsDoc();
	confirmRemove(canvas, 0);
	await settle();
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	await settle();
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), []);

	flight.answer({ ok: true, id: "p1", queued: false });
	await settle();
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), [], "the older send reply does not add the removed part again");
	assert.equal($(canvas, "gd-parts").hidden, true);
	assert.equal($(canvas, "gd-status").textContent, "Sent: the session is building only this part of First now.", "it still says it was sent");
});

test("Show stays disabled until the shown design's boards are installed and never opens another design's board with the same file", async () => {
	const canvas = await loadParts();
	const manifest = deferred();
	canvas.replies["/t/api/designs/beta"] = manifest.promise;
	canvas.replies[BETA_PARTS_URL] = partsDoc(storedPart({ id: "b1", selector: "main.beta", excerpt: "Beta" }));
	const alphaFrames = canvas.frames();
	await canvas.serverEvent("show", { slug: "beta" });
	// Beta's parts arrive while its design.json is held: alpha's boards are still the installed ones, and alpha has 01-a.html too.
	await canvas.serverEvent("change", { slug: "beta", file: "parts.json" });
	await settle();
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["b1"]);
	const show = one(items(canvas)[0], "gd-part-show");
	assert.equal(show.disabled, true, "no beta board is installed yet");
	assert.equal(text(items(canvas)[0], "gd-part-title"), "01-a.html", "alpha's board title is not borrowed");
	show.dispatch("click");
	assert.equal(canvas.navMode.textContent, "Navigating", "alpha's old board is not focused");
	const highlights = (frame: FakeElement) => frame.contentWindow!.posted.filter((message) => message.type === "gd:highlight");
	assert.deepEqual(alphaFrames.flatMap(highlights), [], "alpha's board never gets beta's selector");

	manifest.answer({ slug: "beta", title: "Beta", brief: "", artboards: [{ file: "01-a.html", title: "Beta A", tradeoff: "", width: 500, height: 400 }] });
	await settle();
	const ready = one(items(canvas)[0], "gd-part-show");
	assert.equal(ready.disabled, false, "enabled once beta's boards are installed");
	assert.equal(text(items(canvas)[0], "gd-part-title"), "Beta A");
	ready.dispatch("click");
	assert.equal(canvas.navMode.textContent, "Using: Beta A · Shift+Esc to exit");
	assert.deepEqual(highlights(canvas.frames()[0]), [{ type: "gd:highlight", selector: "main.beta" }]);
	assert.deepEqual(alphaFrames.flatMap(highlights), []);
});

// ---- Remove (S2: a part the agent never reports would stay sent forever)

test("Remove asks an inline confirm, then removes a sent or queued part and stays disabled while in flight", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(
		storedPart(),
		storedPart({ id: "p2", file: "02-b.html", selector: "footer", queued: true }),
		storedPart({ id: "p3", status: "in_progress", startedAt: todayAt(9, 48) }),
	) });
	const item = items(canvas)[0];
	const remove = one(item, "gd-part-remove");
	const confirm = one(item, "gd-part-confirm");
	assert.equal(remove.textContent, "Remove");
	assert.equal(remove.getAttribute("aria-label"), "Remove part 1 in 01-a.html");
	assert.equal(confirm.hidden, true);
	remove.dispatch("click");
	assert.deepEqual([confirm.hidden, remove.hidden], [false, true]);
	assert.equal(text(confirm, "gd-part-question"), "Remove this part? The agent can no longer report on it.");
	assert.equal(confirm.getAttribute("role"), "group");
	assert.equal(canvas.document.activeElement?.textContent, "Remove", "the keyboard moves to the confirm's Remove");
	one(confirm, "gd-part-confirm-no").dispatch("click");
	assert.deepEqual([confirm.hidden, remove.hidden], [true, false]);
	assert.equal(canvas.document.activeElement?.getAttribute("aria-label"), "Remove part 1 in 01-a.html", "Cancel returns to Remove");
	remove.dispatch("click");
	const escape = confirm.dispatch("keydown", { key: "Escape" });
	assert.equal(escape.defaultPrevented, true);
	assert.deepEqual([confirm.hidden, remove.hidden], [true, false], "Esc cancels too");
	assert.deepEqual(bodiesTo(canvas, REMOVE_URL), [], "nothing is removed without the confirm");

	const flight = deferred();
	canvas.replies[REMOVE_URL] = flight.promise;
	confirmRemove(canvas, 0);
	await settle();
	assert.deepEqual(bodiesTo(canvas, REMOVE_URL), [{ id: "p1" }]);
	assert.equal(one(items(canvas)[0], "gd-part-confirm-yes").getAttribute("aria-disabled"), "true", "marked disabled while in flight, still focusable");
	// A parts.json change while it is in flight re-renders the list; the part stays disabled.
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	assert.equal(one(items(canvas)[0], "gd-part-confirm").hidden, false, "the open confirm survives a re-render");
	assert.equal(one(items(canvas)[0], "gd-part-confirm-yes").getAttribute("aria-disabled"), "true");
	one(items(canvas)[0], "gd-part-confirm-yes").dispatch("click");
	await settle();
	assert.equal(bodiesTo(canvas, REMOVE_URL).length, 1, "a second click while in flight posts nothing");

	canvas.replies[PARTS_URL] = partsDoc(storedPart({ id: "p2", file: "02-b.html", selector: "footer", queued: true }), storedPart({ id: "p3", status: "in_progress", startedAt: todayAt(9, 48) }));
	flight.answer({ ok: true, id: "p1" });
	await settle();
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["p2", "p3"], "the part goes at once");
	assert.equal($(canvas, "gd-status").textContent, "Part removed. The agent can no longer report on it.");
	assert.equal($(canvas, "gd-parts-title").textContent, "Partial implementations · 2");

	// The queued one goes the same way.
	canvas.replies[REMOVE_URL] = { ok: true, id: "p2" };
	confirmRemove(canvas, 0);
	await settle();
	assert.deepEqual(bodiesTo(canvas, REMOVE_URL).at(-1), { id: "p2" });
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["p3"]);
});

test("keyboard focus stays on the confirm's Remove while it is in flight, and Cancel and Esc wait for the reply", async () => {
	const flight = deferred();
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart(), storedPart({ id: "p2", file: "02-b.html", selector: "footer" })), [REMOVE_URL]: flight.promise });
	const active = () => canvas.document.activeElement!;
	const focusAt = () => [active().dataset.control ?? "", active().closest(".gd-part")?.dataset.id ?? "", active().getAttribute("aria-disabled") ?? "", $(canvas, "gd-parts-list").contains(active())];
	one(items(canvas)[0], "gd-part-remove").dispatch("click");
	one(items(canvas)[0], "gd-part-confirm-yes").dispatch("click");
	await settle();
	assert.deepEqual(focusAt(), ["yes", "p1", "true", true], "the redraw keeps focus on the confirm's Remove");
	await canvas.serverEvent("change", { slug: "alpha", file: "parts.json" });
	assert.deepEqual(focusAt(), ["yes", "p1", "true", true], "a parts.json redraw too");
	assert.equal(one(items(canvas)[0], "gd-part-confirm-no").disabled, true, "Cancel waits for the reply");
	one(items(canvas)[0], "gd-part-confirm-no").dispatch("click");
	one(items(canvas)[0], "gd-part-confirm").dispatch("keydown", { key: "Escape" });
	assert.equal(one(items(canvas)[0], "gd-part-confirm").hidden, false, "neither closes the confirm while in flight");
	assert.deepEqual(focusAt(), ["yes", "p1", "true", true]);
	assert.equal(active() === canvas.document.body, false);

	flight.answer({ __http: 422, error: "invalid-parts", reason: "bad" });
	await settle();
	assert.equal(active() === canvas.document.body, false, "focus never falls to the body");
	assert.deepEqual([active().disabled, active().hidden, $(canvas, "gd-parts-list").contains(active())], [false, false, true]);
	assert.equal(one(items(canvas)[0], "gd-part-confirm-no").disabled, false, "Cancel works again");
});

test("Remove that loses the race to the agent (409) or to a failed delivery (404) reloads the parts and says why", async () => {
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart()), [REMOVE_URL]: { __http: 409, error: "part-not-sent", reason: "p1 is in_progress" } });
	// The agent took it up between the render and the confirm.
	canvas.replies[PARTS_URL] = partsDoc(storedPart({ status: "in_progress", startedAt: todayAt(9, 48) }));
	const fetches = fetchCount(canvas, PARTS_URL);
	confirmRemove(canvas, 0);
	await settle();
	assert.equal($(canvas, "gd-status").textContent, "Not removed: the agent already took this part up.");
	assert.equal($(canvas, "gd-status").classes.has("gd-error"), true);
	assert.equal($(canvas, "gd-toast").textContent, "Not removed: the agent already took this part up.");
	assert.equal(fetchCount(canvas, PARTS_URL), fetches + 1, "the parts are reloaded");
	assert.deepEqual(items(canvas).map((item) => [text(item, "gd-part-state"), withClass(item, "gd-part-remove").length]), [["In progress", 0]]);

	const gone = await loadParts({ [PARTS_URL]: partsDoc(storedPart()), [REMOVE_URL]: { __http: 404, error: "not-found" } });
	gone.replies[PARTS_URL] = partsDoc();
	confirmRemove(gone, 0);
	await settle();
	assert.equal($(gone, "gd-status").textContent, "Not removed: this part is gone; its delivery failed or it was removed already.");
	assert.equal($(gone, "gd-parts").hidden, true);

	const broken = await loadParts({ [PARTS_URL]: partsDoc(storedPart()), [REMOVE_URL]: { __http: 422, error: "invalid-parts", reason: "bad" } });
	confirmRemove(broken, 0);
	await settle();
	assert.equal($(broken, "gd-status").textContent, "Not removed: parts.json cannot be read; fix it or delete it.");
	assert.equal(one(items(broken)[0], "gd-part-remove").disabled, false, "it can be tried again");
});

test("a Remove reply after a design switch touches only the old design: no reload of its parts into the new list", async () => {
	const flight = deferred();
	const canvas = await loadParts({ [PARTS_URL]: partsDoc(storedPart()), [REMOVE_URL]: flight.promise, [BETA_PARTS_URL]: partsDoc(storedPart({ id: "b1", file: "01-only.html" })) });
	confirmRemove(canvas, 0);
	await settle();
	await canvas.serverEvent("show", { slug: "beta" });
	const fetches = fetchCount(canvas, PARTS_URL);
	flight.answer({ __http: 409, error: "part-not-sent" });
	await settle();
	assert.equal(fetchCount(canvas, PARTS_URL), fetches, "alpha's parts are not fetched for beta's list");
	assert.deepEqual(items(canvas).map((item) => item.dataset.id), ["b1"]);
	assert.equal($(canvas, "gd-status").textContent, "Not removed: the agent already took this part up.");
});

// ---- store, registration, styles and docs (S3, S4, S6)

test("parts change only through setParts, frozen once when set", () => {
	const store = createStore();
	assert.deepEqual(store.state.parts, { slug: null, parts: [] });
	assert.throws(() => { (store.state.parts.parts as unknown[]).push({}); }, TypeError, "the initial parts are protected too");
	const parts = [{ id: "p1", status: "sent" }];
	store.setParts({ slug: "alpha", parts });
	assert.equal(store.state.parts.parts, parts, "the same array, frozen when it is set, not copied per read");
	assert.throws(() => { (store.state.parts as any).slug = "beta"; }, TypeError);
	assert.throws(() => { (store.state.parts.parts as unknown[]).push({ id: "p2" }); }, TypeError);
	assert.throws(() => { (store.state.parts.parts[0] as any).status = "implemented"; }, TypeError);
	assert.deepEqual(store.state.parts, { slug: "alpha", parts: [{ id: "p1", status: "sent" }] });
	assert.ok(read("canvas-store.js").includes("setComments, setHandoffs and setParts freeze them once"));
});

test("canvas-parts.js is registered, groups its English text and styles its section on the --gd-* tokens with the state in words", () => {
	assert.equal(DESIGN_CANVAS_ASSETS["canvas-parts.js"], "text/javascript; charset=utf-8");
	assert.match(read("canvas-boot.js"), /^import \* as parts from "\.\/canvas-parts\.js";$/m);
	const source = read("canvas-parts.js");
	assert.match(source, /^const TEXT = Object\.freeze\(\{$/m, "the English text sits in one TEXT block");
	assert.ok(!/(?:textContent|title) = ["'`]/.test(source), "every visible string comes from TEXT");
	assert.ok(!/\bstate\.\w+\s*=[^=]/.test(source), "state changes only through the store");

	const html = read("index.html");
	const panel = html.slice(html.indexOf('<aside id="gd-panel"'), html.indexOf("</aside>"));
	assert.match(panel, /<section id="gd-parts" class="gd-parts" aria-labelledby="gd-parts-title" hidden>\s*<h3 id="gd-parts-title" class="gd-parts-title" data-i18n="partsTitle">Partial implementations<\/h3>\s*<ol id="gd-parts-list" class="gd-parts-list"><\/ol>\s*<\/section>\s*$/, "the last thing in the panel");

	const css = read("canvas.css");
	const rules = css.split("}").filter((rule) => /(^|\n)\.gd-part/.test(rule.trim().split("{")[0]) || /^\s*\.gd-part/.test(rule));
	assert.ok(rules.length >= 6, "the section is styled");
	for (const rule of rules) {
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(rule), `${rule.trim()}: tokens only`);
		for (const name of rule.match(/var\((--[\w-]+)/g) ?? []) assert.ok(name.startsWith("var(--gd-"), `${name}: a --gd-* token`);
		assert.ok(!/::before|::after|50%/.test(rule), `${rule.trim()}: no dot for the state (S4)`);
	}
	assert.match(css, /\.gd-part\[data-status="implemented"\] \.gd-part-state \{[^}]*var\(--gd-success\)/);
});

test("the docs describe Implement only this, Partial implementations and Remove", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"), docs.indexOf("### Gentle Music"));
	for (const words of ["**Implement only this**", "**Partial implementations**", "**Show**", "**Remove**", "can no longer report", "Pi session", "does not choose a direction"]) {
		assert.ok(section.includes(words), `the Gentle Design docs mention ${words}`);
	}
});
