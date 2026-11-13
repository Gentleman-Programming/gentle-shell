import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findAll, flush, heardGeneration, loadCanvas, read, texts, withClass, type FakeElement } from "./support/design-canvas-dom.ts";

// Accessibility checks (canvas-checks.js): each design artboard's own frame checks its page after it loads and
// after a resize (inspector.js gd:checks); the panel's Quality tab lists the findings per artboard, with Show
// (zoom in, center, a ring on the canvas) and Ask the agent to fix (the comment box, prefilled). The panel has two
// tabs, Comments and Quality, with counts. Covers the reload, design-switch, stale-identity and every-exit-path
// cases the maintainer probes (S7). Assertions compare strings, numbers and booleans, never fake elements.

const SYSTEM_REPLY = { "/t/api/system": { exists: true, file: "system.html", width: 800, height: 600 } };
const CHECKS: Array<[string, string]> = [["contrast", "Text contrast"], ["target", "Target size"], ["alt", "Images have alt text"], ["label", "Form fields have labels"], ["heading", "Headings in order"]];
const DETAIL = '"or pay with card" is 3.1 : 1 (#999999 on #ffffff); WCAG AA needs 4.5 : 1.';
const finding = (extra: Record<string, unknown> = {}) => ({ check: "contrast", severity: "fail", title: "Low contrast", detail: DETAIL, selector: "main > p.or", label: "p.or", excerpt: "or pay with card", rect: { x: 30, y: 40, width: 200, height: 20 }, ...extra });
const advice = (extra: Record<string, unknown> = {}) => finding({ check: "target", severity: "advice", title: "Touch target under 44 px", detail: '"Pay" is 100 × 28 px; 44 × 44 px is recommended for touch.', selector: "#pay", label: "button#pay", rect: { x: 10, y: 250, width: 4, height: 2 }, ...extra });

function checksReport(issues: Array<Record<string, any>> = []) {
	const checks = CHECKS.map(([id, label]) => ({
		id, label,
		count: issues.filter((entry) => entry.check === id && entry.severity === "fail").length,
		advice: issues.filter((entry) => entry.check === id && entry.severity === "advice").length,
	}));
	return { type: "gd:checks", checks, issues };
}

async function loadChecks(replies: Record<string, unknown> = {}) {
	const canvas = await loadCanvas(300, replies);
	// The fake DOM starts every element visible; index.html starts these hidden.
	for (const id of ["gd-popover", "gd-menu", "gd-device-menu", "gd-inspector", "gd-quality"]) canvas.document.getElementById(id).hidden = true;
	canvas.boards.forEach((board, index) => { board.frame.rect = { left: 100 + index * 500, top: 120, width: 400, height: 300 }; });
	return canvas;
}
type Canvas = Awaited<ReturnType<typeof loadChecks>>;

const $ = (canvas: Canvas, id: string) => canvas.document.getElementById(id);
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };
/** A gd:checks as inspector.js posts it from `frame`'s page: tagged with the size generation that page heard last (or `generation`). */
const report = (canvas: Canvas, frame: FakeElement, issues: Array<Record<string, any>> = [], generation = heardGeneration(frame)) => canvas.message(frame.contentWindow, { ...checksReport(issues), generation });
const openQuality = (canvas: Canvas) => $(canvas, "gd-tab-quality").dispatch("click");
const quality = (canvas: Canvas) => $(canvas, "gd-quality");
const count = (canvas: Canvas) => $(canvas, "gd-count-quality").textContent;
const cards = (canvas: Canvas) => withClass(quality(canvas), "gd-check");
const groups = (canvas: Canvas) => withClass(quality(canvas), "gd-check-group").map((group) => `${texts(group, "gd-check-heading")[0]}: ${texts(group, "gd-check-summary")[0]}`);
const showButton = (canvas: Canvas, index: number) => withClass(cards(canvas)[index], "gd-check-show")[0];
const fixButton = (canvas: Canvas, index: number) => withClass(cards(canvas)[index], "gd-check-fix")[0];
const showCard = (canvas: Canvas, index: number) => showButton(canvas, index).dispatch("click");
/** The rings on the page (the world and the All sizes frames both live in the viewport). */
const marks = (canvas: Canvas) => withClass(canvas.viewport, "gd-check-mark");
const markBox = (canvas: Canvas) => marks(canvas).map((ring) => [ring.style.left, ring.style.top, ring.style["--gd-mark-w"], ring.style["--gd-mark-h"]].join(" "));
/** The cards marked as the ring's (aria-current), by index. */
const activeCards = (canvas: Canvas) => cards(canvas).flatMap((card, index) => (card.getAttribute("aria-current") === "true" ? [index] : []));
const ringIn = (root: FakeElement) => withClass(root, "gd-check-mark").length;
const frameBox = (canvas: Canvas, index: number) => canvas.boards[index].frame.parentElement!;
const pressed = (canvas: Canvas, id: string) => $(canvas, id).getAttribute("aria-pressed");
const focusOn = (canvas: Canvas, index = 0) => canvas.boards[index].shield!.dispatch("keydown", { key: "Enter" });
const chooseSize = (canvas: Canvas, size: string) => {
	if ($(canvas, "gd-device-menu").hidden) $(canvas, "gd-device").dispatch("click");
	findAll($(canvas, "gd-device-menu"), (element) => element.dataset.size === size)[0].dispatch("click");
};
const sizeSections = (canvas: Canvas) => withClass(canvas.viewport, "gd-size-frame");
const iframeOf = (root: FakeElement) => findAll(root, (element) => element.localName === "iframe")[0];
const view = (canvas: Canvas) => {
	const match = /^translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\) scale\(([\d.e+-]+)\)$/.exec(canvas.world.style.transform);
	assert.ok(match, `a world transform: ${canvas.world.style.transform}`);
	return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
};
/** A key press delivered to the document's keydown listeners, as the browser would from `target`. */
function press(canvas: Canvas, key: string, init: Record<string, unknown> = {}, target?: FakeElement) {
	const event: any = { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: target ?? canvas.document.body, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, ...init };
	for (const listener of canvas.document.listeners.get("keydown") ?? []) listener(event);
	return event;
}
const lastOf = (frame: FakeElement, type: string) => frame.contentWindow!.posted.filter((message) => message.type === type).at(-1) ?? null;
const activeId = (canvas: Canvas) => canvas.document.activeElement?.id ?? "";

// ---- the tabs (S8)

test("the panel has two tabs, Comments and Quality, with counts; the arrows, Home and End move between them", async () => {
	const comments = { comments: [
		{ id: "c1", file: "01-a.html", selector: "#x", excerpt: "", comment: "one", status: "open", createdAt: "2026-10-26T10:00:00.000Z", sentAt: null },
		{ id: "c2", file: "01-a.html", selector: "#y", excerpt: "", comment: "two", status: "open", createdAt: "2026-10-26T10:00:00.000Z", sentAt: null },
		{ id: "c3", file: "02-b.html", selector: "#z", excerpt: "", comment: "three", status: "resolved", createdAt: "2026-10-26T10:00:00.000Z", sentAt: null },
	] };
	const canvas = await loadChecks({ "/t/api/designs/alpha/comments": comments });
	const tabs = () => ["gd-tab-comments", "gd-tab-quality"].map((id) => `${$(canvas, id).getAttribute("aria-selected")}/${$(canvas, id).getAttribute("tabindex") ?? "0"}`);
	const panels = () => [$(canvas, "gd-tabpanel-comments").hidden, quality(canvas).hidden];
	assert.equal($(canvas, "gd-count-comments").textContent, "2", "Comments counts the open comments");
	assert.equal(count(canvas), "", "no count before an artboard reports");
	openQuality(canvas);
	assert.deepEqual([tabs(), panels()], [["false/-1", "true/0"], [true, false]]);
	assert.deepEqual(texts(quality(canvas), "gd-check-summary"), ["Not checked yet", "Not checked yet"], "a group per design artboard, before it reports");
	report(canvas, canvas.boards[1].frame, []);
	assert.equal(count(canvas), "0", "one artboard reported, with no problems");

	const tablist = $(canvas, "gd-tabs");
	const right = tablist.dispatch("keydown", { key: "ArrowRight" });
	assert.deepEqual([right.defaultPrevented, tabs(), panels(), activeId(canvas)], [true, ["true/0", "false/-1"], [false, true], "gd-tab-comments"], "the arrows wrap around and move focus to the tab");
	tablist.dispatch("keydown", { key: "ArrowLeft" });
	assert.deepEqual([tabs(), activeId(canvas)], [["false/-1", "true/0"], "gd-tab-quality"]);
	tablist.dispatch("keydown", { key: "Home" });
	assert.deepEqual([tabs(), activeId(canvas)], [["true/0", "false/-1"], "gd-tab-comments"]);
	tablist.dispatch("keydown", { key: "End" });
	assert.deepEqual([tabs(), activeId(canvas)], [["false/-1", "true/0"], "gd-tab-quality"]);
	const other = tablist.dispatch("keydown", { key: "Enter" });
	assert.deepEqual([other.defaultPrevented, tabs()], [false, ["false/-1", "true/0"]], "other keys stay with the tab");
	$(canvas, "gd-tab-comments").dispatch("click");
	assert.deepEqual(panels(), [false, true]);
});

test("Partial implementations stays at the panel's bottom in both tabs", async () => {
	const part = { id: "p1", file: "01-a.html", selector: "#x", excerpt: "Pay", status: "sent", queued: false, sentAt: "2026-10-26T10:00:00.000Z", startedAt: null, implementedAt: null };
	const canvas = await loadChecks({ "/t/api/designs/alpha/parts": { version: 1, parts: [part] } });
	assert.equal($(canvas, "gd-parts").hidden, false);
	openQuality(canvas);
	assert.equal($(canvas, "gd-parts").hidden, false, "Quality keeps it");
	const html = read("index.html");
	const panel = html.slice(html.indexOf('<aside id="gd-panel"'), html.indexOf("</aside>"));
	const at = (id: string) => panel.indexOf(`id="${id}"`);
	assert.ok(at("gd-tabpanel-comments") > 0 && at("gd-tabpanel-comments") < at("gd-quality") && at("gd-quality") < at("gd-parts"), "outside both tab panels, after them");
});

test("clicking a comment's pin while Quality shows brings the Comments tab back", async () => {
	const comments = { comments: [{ id: "c1", file: "01-a.html", selector: "#x", excerpt: "", comment: "one", status: "open", createdAt: "2026-10-26T10:00:00.000Z", sentAt: null }] };
	const canvas = await loadChecks({ "/t/api/designs/alpha/comments": comments });
	canvas.message(canvas.boards[0].frame.contentWindow, { type: "gd:pin-rects", rects: [{ id: "c1", rect: { x: 10, y: 10, width: 20, height: 20 } }] });
	openQuality(canvas);
	withClass(canvas.world, "gd-pin")[0].dispatch("click");
	assert.deepEqual([$(canvas, "gd-tab-comments").getAttribute("aria-selected"), $(canvas, "gd-tabpanel-comments").hidden, quality(canvas).hidden], ["true", false, true]);
});

// ---- what the artboards report

test("only each design artboard's own frame is asked to check itself: never a size frame or the system board", async () => {
	const canvas = await loadChecks(SYSTEM_REPLY);
	const [system, first] = canvas.frames();
	for (const frame of canvas.frames()) frame.dispatch("load");
	assert.deepEqual([lastOf(system, "gd:run-checks"), lastOf(first, "gd:run-checks")], [null, { type: "gd:run-checks" }]);
	assert.deepEqual(lastOf(canvas.frames()[2], "gd:run-checks"), { type: "gd:run-checks" });
	canvas.world.children[1].children.find((child) => child.classes.has("gd-frame-box"))!.children.find((child) => child.classes.has("gd-shield"))!.dispatch("keydown", { key: "Enter" });
	chooseSize(canvas, "all");
	for (const section of sizeSections(canvas)) iframeOf(section).dispatch("load");
	assert.deepEqual(sizeSections(canvas).map((section) => lastOf(iframeOf(section), "gd:run-checks")), [null, null, null], "the size frames would only repeat the work, and the canvas ignores them");
});

test("a report fills Quality: a group per design artboard with its summary, a card per finding, the passed checks once, and a count of problems", async () => {
	const canvas = await loadChecks();
	const [first, second] = canvas.boards;
	report(canvas, first.frame, [
		finding(),
		finding({ check: "label", title: "Form field without a label", detail: "The select has no label.", selector: "#size", label: "select#size" }),
		advice(),
	]);
	report(canvas, second.frame, [advice({ selector: "#other" })]);
	assert.equal(count(canvas), "2", "advice does not count");
	openQuality(canvas);
	assert.deepEqual(groups(canvas), ["01 First: 2 checks", "02 Second: Accessible ✓"]);
	assert.deepEqual(cards(canvas).map((card) => `${texts(card, "gd-check-title")[0]} | ${texts(card, "gd-check-kind")[0]} | ${card.classes.has("gd-check-fail") ? "fail" : "advice"}`), [
		"Low contrast | Problem | fail", "Form field without a label | Problem | fail", "Touch target under 44 px | Advice | advice", "Touch target under 44 px | Advice | advice",
	]);
	assert.equal(texts(cards(canvas)[0], "gd-check-detail")[0], DETAIL, "the finding as the artboard reported it");
	assert.deepEqual(texts(quality(canvas), "gd-check-passed"), ["Passed: Target size · Images have alt text · Headings in order", "Passed: Text contrast · Target size · Images have alt text · Form fields have labels · Headings in order"]);
	assert.equal(showButton(canvas, 0).getAttribute("aria-label"), "Show Low contrast on p.or in 01 First");
	assert.equal(fixButton(canvas, 0).getAttribute("aria-label"), "Ask the agent to fix Low contrast on p.or");
	assert.equal(withClass(quality(canvas), "gd-check-group")[0].getAttribute("aria-label"), "Accessibility checks of 01 First");
	// The same report again (a resize with nothing new) leaves the count alone; a cleaner one lowers it.
	report(canvas, first.frame, [finding()]);
	assert.deepEqual([count(canvas), groups(canvas)[0]], ["1", "01 First: 1 check"]);
});

test("keyboard focus on a card's button survives a new report; a finding that went sends it to the Quality tab, never the page", async () => {
	const canvas = await loadChecks();
	const [first, second] = canvas.boards;
	report(canvas, first.frame, [finding(), advice()]);
	openQuality(canvas);
	fixButton(canvas, 1).focus();
	const focused = () => { const element = canvas.document.activeElement!; return element.id || `${element.dataset.control}:${element.dataset.key?.split("\n").at(-1)}`; };
	assert.equal(focused(), "fix:#pay");
	report(canvas, second.frame, [finding()]);
	assert.equal(focused(), "fix:#pay", "another artboard's report re-renders Quality");
	report(canvas, first.frame, [advice()]);
	assert.equal(focused(), "fix:#pay", "the same finding, now first");
	report(canvas, first.frame, []);
	assert.equal(focused(), "gd-tab-quality");
});

test("reports from an unknown frame, a size frame or the system board are ignored, and a malformed one never throws or touches the status line", async () => {
	const canvas = await loadChecks(SYSTEM_REPLY);
	const [system, first, second] = canvas.frames();
	$(canvas, "gd-status").textContent = "before";
	canvas.message({}, checksReport([finding()]));
	report(canvas, system, [finding()]);
	const bad: unknown[] = [
		{ type: "gd:checks" },
		{ ...checksReport(), checks: "no" },
		{ ...checksReport(), issues: "no" },
		{ ...checksReport(), checks: [5] },
		{ ...checksReport(), checks: [null] },
		{ ...checksReport(), checks: [{ id: "contrast", count: -1, advice: 0 }] },
		{ ...checksReport(), checks: [{ id: "contrast", count: 1.5, advice: 0 }] },
		{ ...checksReport(), checks: [{ id: "contrast", count: 1, advice: 0 }, { id: "contrast", count: 1, advice: 0 }] },
		{ ...checksReport(), checks: Array.from({ length: 11 }, () => ({ id: "alt", count: 0, advice: 0 })) },
		checksReport([finding({ rect: null })]),
		checksReport([finding({ rect: { x: "1", y: 0, width: 1, height: 1 } })]),
		checksReport([finding({ selector: "" })]),
		checksReport([finding({ selector: "x".repeat(501) })]),
		checksReport([finding({ title: 5 })]),
		checksReport([finding({ severity: "boom" })]),
		checksReport([finding({ check: "unknown" })]),
		checksReport([finding({ excerpt: 5 })]),
		checksReport([finding({ excerpt: undefined })]),
		{ ...checksReport(), issues: [null] },
		{ ...checksReport(), issues: [5] },
		checksReport(Array.from({ length: 201 }, () => finding())),
	];
	for (const data of bad) assert.doesNotThrow(() => canvas.message(second.contentWindow, data));
	assert.deepEqual([count(canvas), $(canvas, "gd-status").textContent, $(canvas, "gd-status").classes.has("gd-error")], ["", "before", false]);
	openQuality(canvas);
	assert.deepEqual(groups(canvas), ["01 First: Not checked yet", "02 Second: Not checked yet"], "the system board has no group");

	// In All sizes only the artboard's own frame speaks for it.
	focusOn(canvas, 1);
	chooseSize(canvas, "all");
	for (const section of sizeSections(canvas)) report(canvas, iframeOf(section), [finding()]);
	assert.equal(count(canvas), "", "size frames are not the artboard");
	report(canvas, first, [finding()]);
	assert.equal(count(canvas), "1");
});

test("a reload of an artboard drops its result until it reports again", async () => {
	const canvas = await loadChecks();
	const [first] = canvas.boards;
	report(canvas, first.frame, [finding()]);
	openQuality(canvas);
	assert.deepEqual(groups(canvas)[0], "01 First: 1 check");
	await canvas.serverEvent("change", { slug: "alpha", file: "01-a.html" });
	first.frame.dispatch("load");
	assert.deepEqual([groups(canvas)[0], count(canvas), cards(canvas).length], ["01 First: Not checked yet", "", 0]);
	report(canvas, first.frame, []);
	assert.deepEqual(groups(canvas)[0], "01 First: Accessible ✓");
});

test("a manifest reload builds new boards: Quality re-renders, the ring goes, and a card of an old board does nothing", async () => {
	const canvas = await loadChecks();
	report(canvas, canvas.boards[0].frame, [finding()]);
	openQuality(canvas);
	showCard(canvas, 0);
	const staleShow = showButton(canvas, 0);
	const staleFix = fixButton(canvas, 0);
	assert.equal(marks(canvas).length, 1);
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	assert.deepEqual([groups(canvas), count(canvas), marks(canvas).length], [["01 First: Not checked yet", "02 Second: Not checked yet"], "", 0]);
	const fresh = canvas.frames();
	const posted = fresh.map((frame) => frame.contentWindow!.posted.length);
	staleShow.dispatch("click");
	staleFix.dispatch("click");
	assert.deepEqual([marks(canvas).length, $(canvas, "gd-popover").hidden, fresh.map((frame) => frame.contentWindow!.posted.length)], [0, true, posted], "nothing drawn, opened or highlighted");
	// The old frame is no longer trusted; the new one is.
	report(canvas, canvas.boards[0].frame, [finding()]);
	assert.equal(count(canvas), "");
	report(canvas, fresh[0], [finding()]);
	assert.equal(count(canvas), "1");
});

test("a design switch clears Quality and the ring at once, by the design menu and by the server's show event", async () => {
	for (const how of ["menu", "show"]) {
		const canvas = await loadChecks();
		report(canvas, canvas.boards[0].frame, [finding()]);
		openQuality(canvas);
		showCard(canvas, 0);
		if (how === "menu") {
			$(canvas, "gd-design").value = "beta";
			$(canvas, "gd-design").dispatch("change");
		} else canvas.serverEvent("show", { slug: "beta" });
		assert.deepEqual([count(canvas), groups(canvas), marks(canvas).length], ["", [], 0], `${how}: nothing of alpha shows while beta loads`);
		report(canvas, canvas.boards[0].frame, [finding()]);
		assert.equal(count(canvas), "", `${how}: a late report of alpha's frame is ignored`);
		await settle();
		assert.deepEqual(groups(canvas), ["01 Only: Not checked yet"], `${how}: beta's artboard`);
	}
});

// ---- Show and the ring

test("Show draws one ring on the canvas over the element, in its severity, and highlights it in the artboard", async () => {
	const canvas = await loadChecks();
	const [first, second] = canvas.boards;
	report(canvas, first.frame, [finding(), advice()]);
	report(canvas, second.frame, [finding({ selector: "#second" })]);
	openQuality(canvas);
	assert.equal(marks(canvas).length, 0);
	showCard(canvas, 0);
	assert.deepEqual([marks(canvas).length, ringIn(frameBox(canvas, 0)), markBox(canvas)], [1, 1, ["130px 50px 200px 20px"]], "centered on the rect, in artboard px, beside the frame in the world");
	const ring = marks(canvas)[0];
	assert.deepEqual([ring.getAttribute("aria-hidden"), ring.classes.has("gd-check-mark-fail"), texts(ring, "gd-check-mark-label")], ["true", true, ["Low contrast"]]);
	assert.deepEqual([lastOf(first.frame, "gd:highlight"), activeCards(canvas)], [{ type: "gd:highlight", selector: "main > p.or", locate: true }, [0]], "the frame is asked where the element is once in view");
	showCard(canvas, 1);
	assert.deepEqual([marks(canvas).length, marks(canvas)[0].classes.has("gd-check-mark-advice"), markBox(canvas), activeCards(canvas)], [1, true, ["12px 251px 4px 2px"], [1]], "one ring at a time");
	$(canvas, "gd-zoom-in").dispatch("click");
	assert.deepEqual(markBox(canvas), ["12px 251px 4px 2px"], "a zoom keeps it");
	showCard(canvas, 2);
	assert.deepEqual([ringIn(frameBox(canvas, 0)), ringIn(frameBox(canvas, 1))], [0, 1], "another artboard's finding moves it there");
	// A new report keeps the ring on the same finding at its new rect, or drops it.
	report(canvas, second.frame, [advice(), finding({ selector: "#second", rect: { x: 0, y: 0, width: 50, height: 10 } })]);
	assert.deepEqual([markBox(canvas), activeCards(canvas)], [["25px 5px 50px 10px"], [3]]);
	report(canvas, second.frame, [advice()]);
	assert.deepEqual([marks(canvas).length, activeCards(canvas)], [0, []]);
});

test("Show follows the element where its page scrolled it: the ring and the pan use the frame's located rect, not the checks' rect", async () => {
	const canvas = await loadChecks();
	const [first, second] = canvas.boards;
	// The checks saw the element below the fold of its 300 px tall frame; Show scrolls the page to it.
	report(canvas, first.frame, [finding({ rect: { x: 30, y: 900, width: 200, height: 20 } })]);
	report(canvas, second.frame, [finding()]);
	openQuality(canvas);
	showCard(canvas, 0);
	assert.deepEqual(lastOf(first.frame, "gd:highlight"), { type: "gd:highlight", selector: "main > p.or", locate: true });
	assert.deepEqual([marks(canvas).length, marks(canvas)[0].hidden], [1, true], "never drawn below its frame, over the canvas or the next artboard");
	const located = (frame: FakeElement, selector: string, y: number) => canvas.message(frame.contentWindow, { type: "gd:located", selector, rect: { x: 30, y, width: 200, height: 20 } });
	// The frame where the view puts it now: where the element's center at y 250 is in the world.
	const before = view(canvas);
	first.frame.rect = { left: 100, top: 120, width: 400 * before.zoom, height: 300 * before.zoom };
	const world = { x: (100 + 130 * before.zoom - before.x) / before.zoom, y: (120 + 260 * before.zoom - 50 - before.y) / before.zoom };
	const lands = () => { const now = view(canvas); return [Math.round(now.x + world.x * now.zoom), Math.round(50 + now.y + world.y * now.zoom)]; };
	located(first.frame, "main > p.or", 250);
	assert.deepEqual([markBox(canvas), marks(canvas)[0].hidden, lands()], [["130px 260px 200px 20px"], false, [500, 400]], "the ring inside the frame, the element at the viewport's center");
	const centered = view(canvas);
	located(first.frame, "main > p.or", 100);
	assert.deepEqual([markBox(canvas), marks(canvas)[0].hidden, view(canvas)], [["130px 110px 200px 20px"], false, centered], "a scroll moves the ring; only the first report re-centers");
	located(first.frame, "main > p.or", 400);
	assert.deepEqual([markBox(canvas), marks(canvas)[0].hidden], [["130px 410px 200px 20px"], true], "scrolled out of its frame: no ring outside it");
	located(first.frame, "main > p.or", 100);
	// Another board's frame, another selector or a malformed rect change nothing.
	located(second.frame, "main > p.or", 20);
	located(first.frame, "#other", 20);
	canvas.message(first.frame.contentWindow, { type: "gd:located", selector: "main > p.or", rect: { x: "1", y: 20, width: 200, height: 20 } });
	canvas.message(first.frame.contentWindow, { type: "gd:located", selector: "main > p.or" });
	canvas.message({}, { type: "gd:located", selector: "main > p.or", rect: { x: 30, y: 20, width: 200, height: 20 } });
	assert.deepEqual([markBox(canvas), view(canvas)], [["130px 110px 200px 20px"], centered]);
	// A new report keeps the ring on its finding, at the rect the page reported then.
	report(canvas, first.frame, [finding({ rect: { x: 30, y: 60, width: 200, height: 20 } })]);
	assert.deepEqual(markBox(canvas), ["130px 70px 200px 20px"]);
	// With no ring, a late report draws nothing.
	press(canvas, "Escape");
	located(first.frame, "main > p.or", 100);
	assert.deepEqual([marks(canvas).length, view(canvas)], [0, centered]);
});

test("in All sizes the ring follows only the frame it is drawn on, the frame as designed", async () => {
	const canvas = await loadChecks();
	const [first] = canvas.boards;
	report(canvas, first.frame, [finding({ rect: { x: 30, y: 900, width: 200, height: 20 } })]);
	openQuality(canvas);
	focusOn(canvas, 0);
	chooseSize(canvas, "all");
	showCard(canvas, 0);
	const [phone, , designed] = sizeSections(canvas).map(iframeOf);
	const located = (frame: FakeElement, y: number) => canvas.message(frame.contentWindow, { type: "gd:located", selector: "main > p.or", rect: { x: 30, y, width: 200, height: 20 } });
	located(first.frame, 250);
	located(phone, 250);
	assert.deepEqual([markBox(canvas), marks(canvas)[0].hidden], [["130px 910px 200px 20px"], true], "the artboard's own frame, hidden behind, and the other sizes are not where the ring is");
	located(designed, 250);
	assert.deepEqual([markBox(canvas), marks(canvas)[0].hidden], [["130px 260px 200px 20px"], false]);
});

test("S5: in All sizes a new report from the artboard's own frame keeps the ring where the frame as designed located it", async () => {
	const canvas = await loadChecks();
	const [first] = canvas.boards;
	report(canvas, first.frame, [finding()]);
	openQuality(canvas);
	focusOn(canvas, 0);
	chooseSize(canvas, "all");
	showCard(canvas, 0);
	const designed = sizeSections(canvas).map(iframeOf).at(-1)!;
	canvas.message(designed.contentWindow, { type: "gd:located", selector: "main > p.or", rect: { x: 30, y: 92, width: 200, height: 20 } });
	assert.deepEqual([markBox(canvas), marks(canvas)[0].hidden], [["130px 102px 200px 20px"], false], "the ring where the frame as designed shows the element");
	// The hidden own frame reports the same finding at its own coordinates: the displayed element has not moved.
	report(canvas, first.frame, [finding({ title: "Lower contrast", rect: { x: 30, y: 252, width: 200, height: 20 } })]);
	assert.deepEqual([markBox(canvas), marks(canvas)[0].hidden, texts(marks(canvas)[0], "gd-check-mark-label"), activeCards(canvas)], [["130px 102px 200px 20px"], false, ["Lower contrast"], [0]], "the same ring, on the same finding, still where it was located");
	// The finding gone from a report still clears it.
	report(canvas, first.frame, []);
	assert.equal(marks(canvas).length, 0);
});

test("Show zooms in under 100% about the element and centers it, and never zooms out", async () => {
	const canvas = await loadChecks();
	const [first] = canvas.boards;
	report(canvas, first.frame, [finding(), finding({ selector: "#page", rect: { x: 0, y: 0, width: 2000, height: 100 } })]);
	openQuality(canvas);
	/** Shows card `index` with the frame where the current view puts it; where the element's center lands, and the zoom. */
	const showAt = (index: number, rect: { x: number; y: number; width: number; height: number }) => {
		const before = view(canvas);
		first.frame.rect = { left: 100, top: 120, width: 400 * before.zoom, height: 300 * before.zoom };
		const x = 100 + (rect.x + rect.width / 2) * before.zoom;
		const y = 120 + (rect.y + rect.height / 2) * before.zoom;
		const world = { x: (x - before.x) / before.zoom, y: (y - 50 - before.y) / before.zoom };
		showCard(canvas, index);
		const after = view(canvas);
		return { zoom: Number(after.zoom.toFixed(4)), lands: [Math.round(after.x + world.x * after.zoom), Math.round(50 + after.y + world.y * after.zoom)] };
	};
	$(canvas, "gd-zoom-out").dispatch("click");
	$(canvas, "gd-zoom-out").dispatch("click");
	assert.equal(view(canvas).zoom.toFixed(2), "0.64");
	assert.deepEqual(showAt(0, finding().rect), { zoom: 1, lands: [500, 400] }, "to 100%, the element at the viewport's center");
	$(canvas, "gd-zoom-out").dispatch("click");
	assert.deepEqual(showAt(1, { x: 0, y: 0, width: 2000, height: 100 }), { zoom: 0.8, lands: [500, 400] }, "a wide element would fit only under 0.8: the zoom stays");
	for (let i = 0; i < 4; i++) $(canvas, "gd-zoom-in").dispatch("click");
	const zoomed = view(canvas).zoom;
	assert.deepEqual(showAt(0, finding().rect), { zoom: Number(zoomed.toFixed(4)), lands: [500, 400] }, "over 100% it only centers");
});

test("a drag pans and keeps the ring; a still click on the canvas or an artboard clears it, and its card's mark", async () => {
	const canvas = await loadChecks();
	report(canvas, canvas.boards[0].frame, [finding()]);
	openQuality(canvas);
	showCard(canvas, 0);
	const before = view(canvas);
	canvas.viewport.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 500, clientY: 400 });
	canvas.viewport.dispatch("pointermove", { pointerId: 1, clientX: 560, clientY: 430 });
	canvas.viewport.dispatch("pointerup", { button: 0, pointerId: 1, clientX: 560, clientY: 430 });
	assert.deepEqual([view(canvas).x - before.x, marks(canvas).length], [60, 1], "a pan moves the ring with the world");
	canvas.viewport.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 500, clientY: 400 });
	canvas.viewport.dispatch("pointerup", { button: 0, pointerId: 1, clientX: 501, clientY: 401 });
	assert.deepEqual([marks(canvas).length, activeCards(canvas)], [0, []]);
	showCard(canvas, 0);
	const label = canvas.world.children[1].children[0];
	label.dispatch("pointerdown", { button: 0, pointerId: 2, clientX: 700, clientY: 100 });
	label.dispatch("pointerup", { button: 0, pointerId: 2, clientX: 700, clientY: 100 });
	assert.equal(marks(canvas).length, 0, "a click on an artboard's header is on the canvas too");
});

test("a finding out of sight gets no ring: its card says why and Show centers the artboard", async () => {
	const canvas = await loadChecks();
	report(canvas, canvas.boards[0].frame, [finding({ check: "target", severity: "advice", title: "Small touch target", detail: '"Skip" is 120 × 20 px; WCAG 2.2 asks for 24 × 24 px, or enough space around it that a 24 px circle on it touches no other target.', selector: "#skip", hidden: true })]);
	openQuality(canvas);
	const note = withClass(cards(canvas)[0], "gd-check-hidden")[0];
	assert.equal(note.textContent, "Out of sight (hidden or off-screen), so Show centers its artboard without a ring.");
	assert.equal(showButton(canvas, 0).getAttribute("aria-describedby"), note.id);
	showCard(canvas, 0);
	assert.deepEqual([marks(canvas).length, lastOf(canvas.boards[0].frame, "gd:highlight")], [0, { type: "gd:highlight", selector: "#skip" }]);
});

test("the ring goes when its frame goes: another size, leaving All sizes, focus on another artboard, a reload", async () => {
	const canvas = await loadChecks();
	const [first] = canvas.boards;
	report(canvas, first.frame, [finding()]);
	openQuality(canvas);
	focusOn(canvas, 0);
	showCard(canvas, 0);
	assert.deepEqual([ringIn(frameBox(canvas, 0)), lastOf(first.frame, "gd:highlight")], [1, { type: "gd:highlight", selector: "main > p.or", locate: true }], "in focus mode on the open artboard");
	chooseSize(canvas, "phone");
	assert.equal(marks(canvas).length, 0, "another size");
	chooseSize(canvas, "all");
	showCard(canvas, 0);
	const sections = sizeSections(canvas);
	assert.deepEqual(sections.map(ringIn), [0, 0, 1], "in All sizes, on the frame as designed, where the checks ran");
	assert.deepEqual(sections.map((section) => lastOf(iframeOf(section), "gd:highlight")), [{ type: "gd:highlight", selector: "main > p.or" }, { type: "gd:highlight", selector: "main > p.or" }, { type: "gd:highlight", selector: "main > p.or", locate: true }], "the element is highlighted in every frame, and the ring's frame says where it is");
	$(canvas, "gd-back").dispatch("click");
	assert.deepEqual([marks(canvas).length, activeCards(canvas)], [0, []], "leaving focus mode drops the size frames and the ring");
	focusOn(canvas, 0);
	chooseSize(canvas, "all");
	showCard(canvas, 0);
	assert.equal(marks(canvas).length, 1);
	iframeOf(sizeSections(canvas)[2]).dispatch("load");
	assert.equal(marks(canvas).length, 0, "its frame reloads");
	chooseSize(canvas, "desktop");
	showCard(canvas, 0);
	first.frame.dispatch("load");
	assert.equal(marks(canvas).length, 0, "the artboard reloads");
});

test("Esc goes to the comment box, Compare and the dialogs first, then clears the ring, then the selected artboard, then Comment mode", async () => {
	const canvas = await loadChecks();
	const [first] = canvas.boards;
	report(canvas, first.frame, [finding()]);
	openQuality(canvas);
	const label = canvas.world.children[1].children[0];
	label.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 700, clientY: 100 });
	label.dispatch("pointerup", { button: 0, pointerId: 1, clientX: 700, clientY: 100 });
	const selected = () => canvas.world.children.flatMap((wrapper, index) => (wrapper.classes.has("gd-selected") ? [index] : []));
	assert.deepEqual(selected(), [1]);
	showCard(canvas, 0);
	assert.equal(press(canvas, "Escape", { defaultPrevented: true }).defaultPrevented, true);
	assert.equal(marks(canvas).length, 1, "an Esc something else took keeps the ring");
	$(canvas, "gd-shortcuts").setAttribute("open", "");
	press(canvas, "Escape");
	assert.equal(marks(canvas).length, 1, "a dialog keeps its Esc");
	$(canvas, "gd-shortcuts").removeAttribute("open");
	$(canvas, "gd-popover").hidden = false;
	press(canvas, "Escape");
	assert.equal(marks(canvas).length, 1, "the comment box keeps its Esc");
	$(canvas, "gd-popover").hidden = true;
	assert.equal(press(canvas, "Escape", { shiftKey: true }).defaultPrevented, false, "Shift+Esc is not the ring's");
	const first_ = press(canvas, "Escape");
	assert.deepEqual([first_.defaultPrevented, marks(canvas).length, activeCards(canvas), selected()], [true, 0, [], [1]], "the ring first");
	press(canvas, "Escape");
	assert.deepEqual(selected(), [], "then the selected artboard");

	// Comment mode: Esc in the canvas and Esc forwarded by an artboard clear the ring before leaving Comment mode.
	$(canvas, "gd-comment").dispatch("click");
	showCard(canvas, 0);
	press(canvas, "Escape");
	assert.deepEqual([marks(canvas).length, pressed(canvas, "gd-comment")], [0, "true"]);
	press(canvas, "Escape");
	assert.equal(pressed(canvas, "gd-comment"), "false");
	$(canvas, "gd-comment").dispatch("click");
	showCard(canvas, 0);
	canvas.message(first.frame.contentWindow, { type: "gd:escape" });
	assert.deepEqual([marks(canvas).length, pressed(canvas, "gd-comment")], [0, "true"]);
	canvas.message(first.frame.contentWindow, { type: "gd:escape" });
	assert.equal(pressed(canvas, "gd-comment"), "false");
});

test("clearing the ring clears the element's highlight in its page too: Esc, a still click, and in every All sizes frame", async () => {
	const canvas = await loadChecks();
	const [first, second] = canvas.boards;
	report(canvas, first.frame, [finding()]);
	openQuality(canvas);
	const last = (frame: FakeElement) => frame.contentWindow!.posted.at(-1);
	showCard(canvas, 0);
	press(canvas, "Escape");
	assert.deepEqual([marks(canvas).length, last(first.frame), lastOf(second.frame, "gd:clear")], [0, { type: "gd:clear" }, null], "Esc: only the ring's artboard");
	showCard(canvas, 0);
	canvas.viewport.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 500, clientY: 400 });
	canvas.viewport.dispatch("pointerup", { button: 0, pointerId: 1, clientX: 500, clientY: 400 });
	assert.deepEqual([marks(canvas).length, last(first.frame)], [0, { type: "gd:clear" }], "a still click");
	showCard(canvas, 0);
	canvas.viewport.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: 500, clientY: 400 });
	canvas.viewport.dispatch("pointermove", { pointerId: 1, clientX: 560, clientY: 430 });
	canvas.viewport.dispatch("pointerup", { button: 0, pointerId: 1, clientX: 560, clientY: 430 });
	assert.deepEqual([marks(canvas).length, last(first.frame)], [1, { type: "gd:highlight", selector: "main > p.or", locate: true }], "a drag pans and keeps both");
	press(canvas, "Escape");
	focusOn(canvas, 0);
	chooseSize(canvas, "all");
	showCard(canvas, 0);
	press(canvas, "Escape");
	assert.deepEqual([first.frame, ...sizeSections(canvas).map(iframeOf)].map(last), [{ type: "gd:clear" }, { type: "gd:clear" }, { type: "gd:clear" }, { type: "gd:clear" }]);
});

// ---- Ask the agent to fix

test("Ask the agent to fix opens the comment box on that artboard's element, prefilled and editable", async () => {
	const canvas = await loadChecks();
	const [first, second] = canvas.boards;
	report(canvas, first.frame, [finding()]);
	report(canvas, second.frame, [advice()]);
	openQuality(canvas);
	focusOn(canvas, 1);
	fixButton(canvas, 0).dispatch("click");
	assert.deepEqual([canvas.navMode.textContent, $(canvas, "gd-popover").hidden, $(canvas, "gd-popover-target").textContent], ["Navigating", false, "01-a.html · main > p.or"], "another artboard's focus ends first");
	assert.equal($(canvas, "gd-popover-text").value, `Accessibility check on main > p.or: Low contrast.\n${DETAIL}\nFix it so it meets WCAG 2.2 AA, keeping the design's tokens.`);
	assert.deepEqual(lastOf(first.frame, "gd:highlight"), { type: "gd:highlight", selector: "main > p.or" });
	$(canvas, "gd-popover-text").value += "\nAlso on hover.";
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	const body = canvas.posts.at(-1)!.body as Record<string, unknown>;
	assert.deepEqual([body.file, body.selector, body.excerpt, String(body.comment).endsWith("Also on hover.")], ["01-a.html", "main > p.or", "or pay with card", true], "the element's text, as a pick sends it, not its CSS label");
	report(canvas, first.frame, [finding({ excerpt: "x".repeat(400) })]);
	fixButton(canvas, 0).dispatch("click");
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	assert.equal((canvas.posts.at(-1)!.body as Record<string, unknown>).excerpt, "x".repeat(300), "bounded like a pick's excerpt");
	fixButton(canvas, 1).dispatch("click");
	assert.match($(canvas, "gd-popover-text").value, /^Accessibility advice on #pay: Touch target under 44 px\.\n"Pay" is 100 × 28 px; 44 × 44 px is recommended for touch\.\nConsider fixing it, keeping the design's tokens\.$/);
});

test("S4: a finding made at Phone keeps Phone's size when Ask the agent to fix files it after the switch to Tablet; a Phone report arriving late is dropped", async () => {
	const canvas = await loadChecks();
	const [first] = canvas.boards;
	const phoneDetail = '"or pay with card" is 2.32 : 1 (#999999 on #ffffff); WCAG AA needs 4.5 : 1.';
	const tabletDetail = '"or pay with card" is 4.47 : 1 (#767676 on #ffffff); WCAG AA needs 4.5 : 1.';
	openQuality(canvas);
	focusOn(canvas, 0);
	chooseSize(canvas, "phone");
	const phoneGeneration = heardGeneration(first.frame);
	report(canvas, first.frame, [finding({ detail: phoneDetail })]);
	chooseSize(canvas, "tablet");
	// The page's scan from before it heard of Tablet arrives now: it describes Phone and changes nothing.
	report(canvas, first.frame, [finding({ detail: "late" })], phoneGeneration);
	assert.deepEqual(texts(quality(canvas), "gd-check-detail"), [phoneDetail], "the late Phone report is dropped");
	// Before Tablet's own scan, the retained Phone finding is filed with the size it was found at.
	fixButton(canvas, 0).dispatch("click");
	assert.match($(canvas, "gd-popover-text").value, /2\.32 : 1/);
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	let body = canvas.posts.at(-1)!.body as Record<string, unknown>;
	assert.deepEqual([body.selector, body.viewport], ["main > p.or", { width: 390, height: 844 }], "Phone's finding, Phone's size");
	// Tablet's scan arrives: its finding is filed with Tablet's size.
	report(canvas, first.frame, [finding({ detail: tabletDetail })]);
	fixButton(canvas, 0).dispatch("click");
	assert.match($(canvas, "gd-popover-text").value, /4\.47 : 1/);
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	body = canvas.posts.at(-1)!.body as Record<string, unknown>;
	assert.deepEqual(body.viewport, { width: 820, height: 1180 });
});

test("in All sizes Ask the agent to fix asks on the frame as designed, with no size recorded", async () => {
	const canvas = await loadChecks();
	report(canvas, canvas.boards[0].frame, [finding()]);
	openQuality(canvas);
	focusOn(canvas, 0);
	chooseSize(canvas, "all");
	fixButton(canvas, 0).dispatch("click");
	$(canvas, "gd-popover-form").dispatch("submit");
	await settle();
	const body = canvas.posts.at(-1)!.body as Record<string, unknown>;
	assert.deepEqual([body.selector, Object.hasOwn(body, "viewport")], ["main > p.or", false]);
});

// ---- module rules, markup, styles and docs

test("canvas-checks.js keeps its words in one TEXT block, changes state only through the store, and runs before the layout's Esc", () => {
	const source = read("canvas-checks.js");
	assert.match(source, /^const TEXT = Object\.freeze\(\{$/m);
	assert.ok(!/(?:textContent|title) = ["'`]/.test(source), "every visible string comes from TEXT");
	assert.ok(!/\bstate\.\w+\s*=[^=]/.test(source), "state changes only through the store");
	assert.ok(source.includes("they are heuristics, not a full audit"), "the module header says what the checks are");
	const boot = read("canvas-boot.js");
	const modules = /const MODULES = \[([^\]]*)\]/.exec(boot)![1].split(",").map((name) => name.trim());
	assert.ok(modules.indexOf("checks") >= 0 && modules.indexOf("checks") < modules.indexOf("layout"), "its Esc listener comes before the layout's");
	const store = read("canvas-store.js").replace(/\n\/\/ ?/g, " ");
	assert.ok(store.includes("board.checks") && store.includes("setChecks"), "the store header names board.checks and its one mutator");
});

test("index.html has the tabs, the Quality panel and the Show icon; canvas.css styles them on --gd-* tokens and hides the ring in exports", () => {
	const html = read("index.html");
	// Each tab's word in its own keyed span (ES.html), so the language never wipes its count.
	assert.match(html, /<div id="gd-tabs" class="gd-tabs" role="tablist" aria-label="Review" data-i18n-aria-label="review">/);
	assert.match(html, /<button type="button" role="tab" id="gd-tab-comments" class="gd-tab" aria-selected="true" aria-controls="gd-tabpanel-comments"><span data-i18n="tabComments">Comments<\/span> <span id="gd-count-comments" class="gd-count">0<\/span><\/button>/);
	assert.match(html, /<button type="button" role="tab" id="gd-tab-quality" class="gd-tab" aria-selected="false" aria-controls="gd-quality" tabindex="-1"><span data-i18n="quality">Quality<\/span> <span id="gd-count-quality" class="gd-count"><\/span><\/button>/);
	assert.match(html, /<div id="gd-quality" class="gd-quality" role="tabpanel" aria-labelledby="gd-tab-quality" hidden><\/div>/);
	assert.match(html, /<div id="gd-tabpanel-comments" class="gd-tabpanel" role="tabpanel" aria-labelledby="gd-tab-comments">/);
	assert.match(html, /<symbol id="i-target" viewBox="0 0 24 24">/);
	const css = read("canvas.css");
	const rules = css.split("}").filter((rule) => /(^|\n)\.gd-(check|tab|quality|count)/.test(rule.trim().split("{")[0]));
	assert.ok(rules.length >= 10, "the tabs, the cards and the ring are styled");
	for (const rule of rules) {
		assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(rule), `${rule.trim()}: tokens only`);
		for (const name of rule.match(/var\((--[\w-]+)/g) ?? []) assert.ok(name.startsWith("var(--gd-"), `${name}: a --gd-* token`);
		assert.ok(!/::before|::after|50%\s*;/.test(rule) || /translate\(-50%, -50%\)/.test(rule), `${rule.trim()}: no dots (S4)`);
	}
	assert.match(css, /\.gd-check-mark \{[^}]*border: calc\(2px \* var\(--gd-inv-zoom, 1\)\) solid/, "the ring keeps its screen width at any zoom");
	assert.match(css, /\.gd-exporting \.gd-check-mark \{ visibility: hidden; \}/);
});

test("the docs describe the Quality tab, Show and the checks' limits in the heuristics note", () => {
	const docs = readFileSync(fileURLToPath(new URL("../docs/gentle-shell.md", import.meta.url)), "utf8");
	const section = docs.slice(docs.indexOf("### Gentle Design"), docs.indexOf("### Gentle Music"));
	assert.ok(section.includes("The checks run inside the artboard's own frame, so they describe the artboard at the size it is shown, and they are heuristics, not a full audit: they miss keyboard, focus-order, motion and screen-reader problems, each list is capped (20 problems and 10 advice items per check, with the full count reported), and a page with more than 3000 elements is checked only up to its 3000th, so its counts cover that part only."));
	assert.ok(section.includes("The ring follows the element as its page scrolls"), "the docs say the ring follows the element");
	for (const words of ["**Quality**", "**Comments**", "**Show**", "**Ask the agent to fix**", "`Accessible ✓`"]) assert.ok(section.includes(words), `the Gentle Design docs mention ${words}`);
});
