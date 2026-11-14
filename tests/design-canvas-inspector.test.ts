import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { findAll, loadCanvas, read, structuredCopy, withClass, type Listener } from "./support/design-canvas-dom.ts";

// inspector.js is a classic script injected into each artboard, so it still runs
// in a vm context with a minimal fake DOM.

function loadInspector({ fonts = false } = {}) {
	const posted: any[] = [];
	const listeners = new Map<string, Listener[]>();
	// The document's capture-phase listeners: an image's load does not bubble, so only these see it.
	const captures = new Map<string, Listener[]>();
	// The MutationObserver callbacks the page registers, for the test to call with records.
	const observers: Array<(records: unknown[]) => void> = [];
	// document.fonts (a FontFaceSet) when the test asks for one; older engines and the other tests have none.
	const fontListeners = new Map<string, Listener[]>();
	class Element {}
	const style = () => ({ cursor: "" });
	const makeNode = () => Object.assign(new Element(), {
		style: style(),
		isConnected: false,
		setAttribute() {},
		hasAttribute: () => false,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
	});
	// The ids of the elements scrolled into view (a highlight).
	const scrolled: string[] = [];
	// `computed`: the element's computed style, as getComputedStyle reports it (the token inspector measures it).
	const created: any[] = [];
	const button: Record<string, any> = Object.assign(new Element(), {
		id: "cta",
		isConnected: true,
		scrollIntoView() { scrolled.push("cta"); },
		localName: "button",
		className: "buy primary",
		innerText: "Buy now",
		childNodes: [{ nodeType: 3, textContent: " Buy  now " }, { nodeType: 1, textContent: "icon" }],
		parentElement: null,
		hasAttribute: () => false,
		getAttribute: () => null,
		getBoundingClientRect: () => ({ left: 4, top: 8, width: 60, height: 20 }),
		computed: {},
	});
	const scrolling = { scrollTop: 0, scrollLeft: 0, clientHeight: 100, scrollHeight: 100, clientWidth: 100, scrollWidth: 100, parentElement: null };
	// The page's width as the frame lays it out (clientWidth) and as wide as its content is (scrollWidth).
	const documentElement = Object.assign(makeNode(), { append() {}, clientWidth: 100, scrollWidth: 100 });
	const document = {
		documentElement,
		body: makeNode(),
		scrollingElement: scrolling,
		createElement: () => {
			const node = makeNode();
			created.push(node);
			return node;
		},
		elementFromPoint: () => button,
		querySelectorAll: (selector: string) => (selector === "#cta" ? [button] : []),
		querySelector: (selector: string) => (selector === "#cta" ? button : null),
		addEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }) {
			const capture = options === true || (typeof options === "object" && options.capture === true);
			if (capture) captures.set(type, [...(captures.get(type) ?? []), listener]);
		},
		...(fonts ? { fonts: { addEventListener(type: string, listener: Listener) { fontListeners.set(type, [...(fontListeners.get(type) ?? []), listener]); } } } : {}),
	};
	const parent = { postMessage: (message: any) => posted.push(structuredCopy(message)) };
	// Animation frames wait until the test runs them, and so do timers (id: index + 1; `done` once run or cleared).
	const frames: Array<() => void> = [];
	const timeouts: Array<{ callback: () => void; ms: number; done: boolean }> = [];
	const context: Record<string, any> = {
		setTimeout: (callback: () => void, ms = 0) => timeouts.push({ callback, ms, done: false }),
		clearTimeout: (id: number) => { if (timeouts[id - 1]) timeouts[id - 1].done = true; },
		innerWidth: 100,
		document,
		Element,
		CSS: { escape: (value: string) => value },
		getComputedStyle: (node: any) => ({ overflowX: "hidden", overflowY: "hidden", ...node?.computed }),
		requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length; },
		MutationObserver: class { constructor(callback: (records: unknown[]) => void) { observers.push(callback); } observe() {} },
		parent,
		addEventListener(type: string, listener: Listener) {
			listeners.set(type, [...(listeners.get(type) ?? []), listener]);
		},
	};
	context.window = context;
	vm.runInNewContext(read("inspector.js"), context);
	const fire = (type: string, init: Record<string, unknown>) => {
		const event: any = { defaultPrevented: false, propagationStopped: false, ...init, preventDefault() { event.defaultPrevented = true; }, stopPropagation() { event.propagationStopped = true; }, stopImmediatePropagation() { event.propagationStopped = true; } };
		for (const listener of listeners.get(type) ?? []) listener(event);
		return event;
	};
	const fromParent = (data: unknown) => fire("message", { source: parent, data });
	/** An event that does not bubble (an image's load) reaching the document on its way down. */
	const captureOnDocument = (type: string, target: unknown) => {
		for (const listener of captures.get(type) ?? []) listener({ type, target });
	};
	/** The page changed: every MutationObserver gets these records. */
	const mutate = (records: unknown[]) => {
		for (const callback of observers) callback(records);
	};
	/** The page's font set finished loading fonts (loadingdone). */
	const fontsLoaded = () => {
		for (const listener of fontListeners.get("loadingdone") ?? []) listener({ type: "loadingdone" });
	};
	const runFrames = () => { while (frames.length > 0) frames.shift()!(); };
	const pendingTimeouts = () => timeouts.filter((timer) => !timer.done).map((timer) => timer.ms);
	const runTimeouts = () => {
		for (const timer of timeouts.slice()) {
			if (timer.done) continue;
			timer.done = true;
			timer.callback();
		}
	};
	// The inspector makes its hover outline first, then the selected one.
	const [hoverBox, selectedBox] = created;
	return { posted, fire, fromParent, context, document, documentElement, runFrames, scrolled, button, Element, pendingTimeouts, runTimeouts, captureOnDocument, mutate, fontsLoaded, makeNode, hoverBox, selectedBox };
}

test("the inspector reports whether its page is wider than the frame, once per change", () => {
	const inspector = loadInspector();
	const root = inspector.documentElement as unknown as Record<string, unknown>;
	inspector.context.innerWidth = 390;
	root.clientWidth = 375;
	root.scrollWidth = 520;
	inspector.fire("load", {});
	assert.deepEqual(inspector.posted, [], "reports wait for the next frame");
	inspector.runFrames();
	assert.deepEqual(inspector.posted, [{ type: "gd:overflow", overflow: true, width: 390, scrollWidth: 520 }]);
	inspector.fire("resize", {});
	inspector.runFrames();
	assert.equal(inspector.posted.length, 1, "an unchanged report is not repeated");
	root.scrollWidth = 375;
	inspector.fire("resize", {});
	inspector.fire("resize", {});
	inspector.runFrames();
	assert.deepEqual(inspector.posted.slice(1), [{ type: "gd:overflow", overflow: false, width: 390, scrollWidth: 375 }], "two resizes in one frame report once");
	inspector.context.innerWidth = 820;
	root.clientWidth = 805;
	root.scrollWidth = 805;
	inspector.fire("resize", {});
	inspector.runFrames();
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:overflow", overflow: false, width: 820, scrollWidth: 805 }, "a new frame width is reported even when the page still fits");
});

test("the inspector checks the page's width again when the MutationObserver sees a page change, not its own boxes", () => {
	const inspector = loadInspector();
	const root = inspector.documentElement as unknown as Record<string, unknown>;
	inspector.fire("load", {});
	inspector.runFrames();
	assert.deepEqual(inspector.posted, [{ type: "gd:overflow", overflow: false, width: 100, scrollWidth: 100 }]);
	root.scrollWidth = 260;
	const ownBox = Object.assign(inspector.makeNode(), { hasAttribute: () => true });
	inspector.mutate([{ type: "attributes", target: ownBox }]);
	inspector.runFrames();
	assert.equal(inspector.posted.length, 1, "the inspector's own boxes moving is no page change");
	inspector.mutate([{ type: "childList", target: inspector.makeNode() }]);
	inspector.runFrames();
	assert.deepEqual(inspector.posted.slice(1), [{ type: "gd:overflow", overflow: true, width: 100, scrollWidth: 260 }]);
});

test("the inspector checks the page's width again when an image loads late, though load does not bubble", () => {
	const inspector = loadInspector();
	const root = inspector.documentElement as unknown as Record<string, unknown>;
	inspector.fire("load", {});
	inspector.runFrames();
	assert.deepEqual(inspector.posted, [{ type: "gd:overflow", overflow: false, width: 100, scrollWidth: 100 }]);
	// A lazy image without a fixed size loads after the window's load and widens the page: no mutation, no resize.
	root.scrollWidth = 340;
	inspector.captureOnDocument("load", inspector.makeNode());
	inspector.runFrames();
	assert.deepEqual(inspector.posted.slice(1), [{ type: "gd:overflow", overflow: true, width: 100, scrollWidth: 340 }]);
});

test("the inspector checks the page's width again when a web font loads late", () => {
	const inspector = loadInspector({ fonts: true });
	const root = inspector.documentElement as unknown as Record<string, unknown>;
	inspector.fire("load", {});
	inspector.runFrames();
	assert.deepEqual(inspector.posted, [{ type: "gd:overflow", overflow: false, width: 100, scrollWidth: 100 }]);
	// A web font that swaps in after the window's load widens the page: no mutation, no resize, no load event.
	root.scrollWidth = 340;
	inspector.fontsLoaded();
	inspector.runFrames();
	assert.deepEqual(inspector.posted.slice(1), [{ type: "gd:overflow", overflow: true, width: 100, scrollWidth: 340 }]);
});

test("gd:size: the inspector reports its overflow again even when unchanged, and tags its picks with that size's generation", () => {
	const inspector = loadInspector();
	inspector.fire("load", {});
	inspector.runFrames();
	assert.deepEqual(inspector.posted, [{ type: "gd:overflow", overflow: false, width: 100, scrollWidth: 100 }]);
	// The canvas dropped what the page reported (a load, a new size): the same answer is said again.
	inspector.fromParent({ type: "gd:size", generation: 3 });
	inspector.runFrames();
	assert.deepEqual(inspector.posted.slice(1), [{ type: "gd:overflow", overflow: false, width: 100, scrollWidth: 100 }]);
	inspector.fromParent({ type: "gd:mode", enabled: true });
	inspector.fromParent({ type: "gd:pick-at", x: 10, y: 12 });
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:pick", selector: "#cta", excerpt: "Buy now", rect: { x: 4, y: 8, width: 60, height: 20 }, generation: 3 });
	inspector.fromParent({ type: "gd:size", generation: "4" });
	inspector.fromParent({ type: "gd:size", generation: -1 });
	inspector.fromParent({ type: "gd:pick-at", x: 10, y: 12 });
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:pick", selector: "#cta", excerpt: "Buy now", rect: { x: 4, y: 8, width: 60, height: 20 }, generation: 3 }, "a malformed generation is ignored");
});

/**
 * The canvas and a size frame's real inspector, wired together: what the canvas posts to the frame reaches the
 * inspector at once, and deliver() hands the canvas what the inspector posted so far.
 */
async function allSizesWithInspector() {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha": { slug: "alpha", title: "Alpha", brief: "", artboards: [
		{ file: "01-a.html", title: "First", tradeoff: "", width: 1200, height: 800 },
	] } });
	const $ = (id: string) => canvas.document.getElementById(id);
	for (const id of ["gd-popover", "gd-menu", "gd-device-menu"]) $(id).hidden = true;
	canvas.boards[0].shield!.dispatch("keydown", { key: "Enter" });
	$("gd-device").dispatch("click");
	findAll($("gd-device-menu"), (element) => element.dataset.size === "all")[0].dispatch("click");
	const phoneSection = withClass(canvas.viewport, "gd-size-frame")[0];
	const phone = findAll(phoneSection, (element) => element.localName === "iframe")[0];
	const chipHidden = () => withClass(phoneSection, "gd-overflow-flag")[0].hidden;
	// The page the Phone frame shows now: a navigation replaces it, and the old one hears nothing more.
	let current: ReturnType<typeof loadInspector> | null = null;
	const window = phone.contentWindow!;
	const post = window.postMessage;
	window.postMessage = (message: unknown) => {
		post(message);
		current?.fromParent(structuredCopy(message));
	};
	/** A page loading in the Phone frame: a fresh inspector, 390 px wide, whose content is `scrollWidth` wide. */
	const page = (scrollWidth: number) => {
		const inspector = loadInspector();
		inspector.context.innerWidth = 390;
		Object.assign(inspector.documentElement as unknown as Record<string, unknown>, { clientWidth: 390, scrollWidth });
		current = inspector;
		const deliver = () => {
			inspector.runFrames();
			for (const message of inspector.posted.splice(0)) canvas.message(window, message);
		};
		return { inspector, deliver };
	};
	return { phone, chipHidden, page };
}

test("S26: the Overflows chip survives the frame's load event that comes after an early overflow report", async () => {
	const { phone, chipHidden, page } = await allSizesWithInspector();
	const { inspector, deliver } = page(520);
	// An image loads before the page does and the page reports that it overflows.
	inspector.captureOnDocument("load", inspector.makeNode());
	deliver();
	assert.equal(chipHidden(), false, "the early report shows the chip");
	// The page's own load queues a check; the canvas sees the frame's load before that check runs.
	inspector.fire("load", {});
	phone.dispatch("load");
	deliver();
	assert.equal(chipHidden(), false, "the page still overflows, so the chip is shown again after the load");
});

test("S26: a frame that navigates to another page shows that page's answer, not the previous one's", async () => {
	const { phone, chipHidden, page } = await allSizesWithInspector();
	const first = page(520);
	first.inspector.fire("load", {});
	phone.dispatch("load");
	first.deliver();
	assert.equal(chipHidden(), false);
	// The next page fits: its own reports decide, whether they come before or after the frame's load.
	const next = page(390);
	next.inspector.captureOnDocument("load", next.inspector.makeNode());
	next.deliver();
	assert.equal(chipHidden(), true, "the new page's early report hides the chip");
	next.inspector.fire("load", {});
	phone.dispatch("load");
	next.deliver();
	assert.equal(chipHidden(), true);
	const back = page(520);
	back.inspector.fire("load", {});
	phone.dispatch("load");
	back.deliver();
	assert.equal(chipHidden(), false, "a page that overflows again shows it");
});

test("the inspector posts gd:exit-focus on Shift+Esc and keeps plain Esc for the design", () => {
	const inspector = loadInspector();
	const plain = inspector.fire("keydown", { key: "Escape", shiftKey: false });
	assert.deepEqual(inspector.posted, []);
	assert.equal(plain.defaultPrevented, false);
	const chord = inspector.fire("keydown", { key: "Escape", shiftKey: true });
	assert.deepEqual(inspector.posted, [{ type: "gd:exit-focus" }]);
	assert.equal(chord.defaultPrevented, true);
	inspector.fire("keydown", { key: "Enter", shiftKey: true });
	assert.equal(inspector.posted.length, 1);
});

test("the inspector picks the element under a routed point only in comment mode", () => {
	const inspector = loadInspector();
	inspector.fromParent({ type: "gd:pick-at", x: 10, y: 12 });
	assert.deepEqual(inspector.posted, [], "no pick outside comment mode");
	inspector.fromParent({ type: "gd:mode", enabled: true });
	inspector.fromParent({ type: "gd:pick-at", x: 10, y: 12 });
	assert.deepEqual(inspector.posted, [{ type: "gd:pick", selector: "#cta", excerpt: "Buy now", rect: { x: 4, y: 8, width: 60, height: 20 }, generation: 0 }], "a page that heard no size yet tags generation 0");
	inspector.fromParent({ type: "gd:pick-at", x: "10", y: 12 });
	assert.equal(inspector.posted.length, 1, "non-numeric points are ignored");
});

test("gd:highlight finds the element by a part's selector or by a comment pin's id", () => {
	const inspector = loadInspector();
	inspector.fromParent({ type: "gd:highlight", selector: "#cta" });
	assert.deepEqual(inspector.scrolled, ["cta"], "a part's selector");
	inspector.fromParent({ type: "gd:highlight", selector: "#missing" });
	inspector.fromParent({ type: "gd:highlight", selector: `#${"x".repeat(500)}` });
	inspector.fromParent({ type: "gd:highlight", selector: 3 });
	assert.deepEqual(inspector.scrolled, ["cta"], "no match, a selector over 500 characters or not text: nothing");
	inspector.fromParent({ type: "gd:highlight", id: "c1" });
	assert.deepEqual(inspector.scrolled, ["cta"], "an id with no pin finds nothing");
	inspector.fromParent({ type: "gd:pins", pins: [{ id: "c1", selector: "#cta" }] });
	inspector.fromParent({ type: "gd:highlight", id: "c1" });
	assert.deepEqual(inspector.scrolled, ["cta", "cta"], "a comment pin's id still works");
	assert.deepEqual(inspector.posted, [], "a highlight posts nothing");
});

test("gd:highlight with locate says where the element is once in view, and again after scrolls (once per frame) until gd:clear or another highlight", () => {
	const inspector = loadInspector();
	const located = () => inspector.posted.filter((message) => message.type === "gd:located");
	inspector.fromParent({ type: "gd:highlight", selector: "#cta", locate: true });
	assert.deepEqual([inspector.scrolled, inspector.posted], [["cta"], [{ type: "gd:located", selector: "#cta", rect: { x: 4, y: 8, width: 60, height: 20 } }]], "after it scrolls into view");
	inspector.button.getBoundingClientRect = () => ({ left: 4, top: 120, width: 60, height: 20 });
	inspector.fire("scroll", {});
	inspector.fire("scroll", {});
	assert.equal(located().length, 1, "reports wait for the next frame");
	inspector.runFrames();
	assert.deepEqual(located().slice(1), [{ type: "gd:located", selector: "#cta", rect: { x: 4, y: 120, width: 60, height: 20 } }], "two scrolls, one report");
	inspector.fire("scroll", {});
	inspector.fromParent({ type: "gd:clear" });
	inspector.runFrames();
	inspector.fire("scroll", {});
	inspector.runFrames();
	assert.equal(located().length, 2, "nothing after gd:clear, not even a scroll queued before it");
	inspector.fromParent({ type: "gd:highlight", selector: "#cta", locate: true });
	inspector.fromParent({ type: "gd:highlight", selector: "#cta" });
	inspector.fire("scroll", {});
	inspector.runFrames();
	assert.equal(located().length, 3, "a highlight without locate (a part, a comment) ends it");
	inspector.fromParent({ type: "gd:highlight", selector: "#missing", locate: true });
	inspector.fire("scroll", {});
	inspector.runFrames();
	assert.equal(located().length, 3, "no element, no report");
});

test("gd:mode off hides the hover and selected outlines, which a PNG export relies on, and hovers stay hidden until it is on again", () => {
	const inspector = loadInspector();
	inspector.fromParent({ type: "gd:mode", enabled: true });
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	inspector.fromParent({ type: "gd:pick-at", x: 10, y: 12 });
	assert.deepEqual([inspector.hoverBox.style.display, inspector.selectedBox.style.display], ["block", "block"]);
	inspector.fromParent({ type: "gd:mode", enabled: false });
	assert.deepEqual([inspector.hoverBox.style.display, inspector.selectedBox.style.display], ["none", "none"]);
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	assert.equal(inspector.hoverBox.style.display, "none", "no hover outline while comment mode is off");
	inspector.fromParent({ type: "gd:mode", enabled: true });
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	assert.equal(inspector.hoverBox.style.display, "block", "hover works again once it is back on");
});

test("in focus mode the inspector leaves the wheel to the artboard and never pans the canvas", () => {
	const inspector = loadInspector();
	const wheel = { deltaX: 0, deltaY: 50, deltaMode: 0, shiftKey: false, clientX: 1, clientY: 1, target: null };
	const unfocused = inspector.fire("wheel", { ...wheel, ctrlKey: false, metaKey: false });
	assert.equal(unfocused.defaultPrevented, true);
	assert.equal(inspector.posted.at(-1).type, "gd:wheel");
	inspector.posted.length = 0;
	inspector.fromParent({ type: "gd:focus", enabled: true });
	const plain = inspector.fire("wheel", { ...wheel, ctrlKey: false, metaKey: false });
	assert.equal(plain.defaultPrevented, false, "the artboard scrolls natively");
	const zoom = inspector.fire("wheel", { ...wheel, ctrlKey: true, metaKey: false });
	assert.equal(zoom.defaultPrevented, true, "Ctrl/Cmd+wheel never zooms the browser page");
	assert.deepEqual(inspector.posted, []);
});

// ---- the token inspector's measure (gd:inspect)

/** The computed style of a 14 px bold button with padding and rounded corners, as a browser reports it. */
const BUTTON_STYLE = {
	color: "rgb(17, 17, 17)", backgroundColor: "rgb(255, 212, 121)", backgroundImage: "none",
	fontFamily: "Inter, sans-serif", fontSize: "14px", fontWeight: "bold", lineHeight: "20px",
	marginTop: "0px", marginRight: "4px", marginBottom: "0px", marginLeft: "4px",
	paddingTop: "8px", paddingRight: "16px", paddingBottom: "8px", paddingLeft: "16px",
	borderTopLeftRadius: "6px", borderTopRightRadius: "6px", borderBottomRightRadius: "50%", borderBottomLeftRadius: "6px",
};
const BUTTON_MEASURE = {
	selector: "#cta", label: "button#cta", text: "Buy now", hasText: true,
	rect: { x: 4, y: 8, width: 60, height: 20 },
	color: { r: 17, g: 17, b: 17, a: 1 }, background: { r: 255, g: 212, b: 121 },
	fontFamily: "Inter, sans-serif", fontSize: 14, fontWeight: 700, lineHeight: 20,
	margin: [0, 4, 0, 4], padding: [8, 16, 8, 16], radius: [6, 6, 10, 6], rootFontSize: 16,
};
const inspects = (inspector: ReturnType<typeof loadInspector>) => inspector.posted.filter((message) => message.type === "gd:inspect");

test("in Comment mode with Technical details on the inspector measures the hovered element once per element, and says when none is hovered", () => {
	const inspector = loadInspector();
	inspector.button.computed = BUTTON_STYLE;
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	inspector.fire("pointerover", { target: inspector.button });
	assert.deepEqual(inspector.posted, [], "nothing outside Comment mode");
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: true });
	assert.deepEqual(inspector.posted, [], "Comment mode with nothing hovered says nothing");
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	assert.deepEqual(inspector.posted, [{ type: "gd:inspect", element: BUTTON_MEASURE, generation: 0 }]);
	inspector.fromParent({ type: "gd:hover-at", x: 11, y: 12 });
	inspector.fire("pointerover", { target: inspector.button });
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: true });
	assert.equal(inspector.posted.length, 1, "the same element is reported once");
	inspector.fire("scroll", {});
	inspector.runFrames();
	assert.equal(inspects(inspector).length, 2, "a scroll moves the element: reported again");
	inspector.fire("pointerout", { relatedTarget: inspector.button });
	assert.equal(inspects(inspector).length, 2, "moving to another element of the page is not leaving it");
	inspector.fire("pointerout", { relatedTarget: null });
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:inspect", element: null, generation: 0 }, "the pointer left the page");
	inspector.fire("scroll", {});
	inspector.runFrames();
	assert.equal(inspects(inspector).length, 3, "nothing hovered, nothing to report on scroll");
	inspector.fire("pointerover", { target: inspector.button });
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:inspect", element: BUTTON_MEASURE, generation: 0 });
	inspector.fromParent({ type: "gd:mode", enabled: false, inspect: true });
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:inspect", element: null, generation: 0 }, "leaving Comment mode clears it");
	assert.equal(inspects(inspector).length, 5);
});

test("S1: each measurement is tagged with the size generation the page heard last, so the canvas can drop one made at an old size", () => {
	const inspector = loadInspector();
	inspector.button.computed = BUTTON_STYLE;
	inspector.fromParent({ type: "gd:size", generation: 3 });
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: true });
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	assert.deepEqual(inspects(inspector), [{ type: "gd:inspect", element: BUTTON_MEASURE, generation: 3 }]);
	inspector.fromParent({ type: "gd:size", generation: 4 });
	inspector.fire("scroll", {});
	inspector.runFrames();
	assert.deepEqual(inspects(inspector).at(-1), { type: "gd:inspect", element: BUTTON_MEASURE, generation: 4 });
});

test("the measured background composites translucent layers up to the first opaque one, and is unknown over an image or gradient", () => {
	const inspector = loadInspector();
	const layer = (computed: Record<string, string>, parentElement: unknown = null) => ({ computed, parentElement });
	const page = layer({ backgroundColor: "rgb(0, 0, 255)", backgroundImage: "none" });
	const tint = layer({ backgroundColor: "rgba(255, 0, 0, 0.5)", backgroundImage: "none" }, page);
	inspector.button.computed = { ...BUTTON_STYLE, backgroundColor: "rgba(0, 0, 0, 0)", color: "rgb(10 20 30 / 50%)", lineHeight: "normal", fontWeight: "500" };
	inspector.button.parentElement = tint;
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: true });
	inspector.fromParent({ type: "gd:hover-at", x: 1, y: 1 });
	const element = inspector.posted.at(-1).element;
	assert.deepEqual([element.background, element.color, element.lineHeight, element.fontWeight], [{ r: 128, g: 0, b: 128 }, { r: 10, g: 20, b: 30, a: 0.5 }, null, 500]);

	// No opaque layer at all: the white page is behind it.
	page.computed = { backgroundColor: "transparent", backgroundImage: "none" };
	inspector.fire("scroll", {});
	inspector.runFrames();
	assert.deepEqual(inspector.posted.at(-1).element.background, { r: 255, g: 128, b: 128 });
	page.computed = { backgroundColor: "rgb(0, 0, 255)", backgroundImage: "linear-gradient(red, blue)" };
	inspector.fire("scroll", {});
	inspector.runFrames();
	assert.equal(inspector.posted.at(-1).element.background, null, "a gradient behind: unknown");
	page.computed = { backgroundColor: "color(display-p3 1 0 0)", backgroundImage: "none" };
	inspector.fire("scroll", {});
	inspector.runFrames();
	assert.equal(inspector.posted.at(-1).element.background, null, "a color it cannot read: unknown");
});

test("with Technical details off the inspector outlines the element but never measures it; turning it on reports the hovered one", () => {
	const inspector = loadInspector();
	inspector.button.computed = BUTTON_STYLE;
	const computed = inspector.context.getComputedStyle;
	let styles = 0;
	inspector.context.getComputedStyle = (node: unknown) => { styles += 1; return computed(node); };
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: false });
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	inspector.fire("scroll", {});
	inspector.fire("pointerout", { relatedTarget: null });
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	inspector.runFrames();
	assert.deepEqual([inspects(inspector).length, styles], [0, 0], "nothing measured, nothing posted");
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: true });
	assert.deepEqual(inspects(inspector), [{ type: "gd:inspect", element: BUTTON_MEASURE, generation: 0 }], "on: the element already hovered, at once");
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: true });
	assert.equal(inspects(inspector).length, 1, "still on: not again");
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: false });
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: true });
	assert.equal(inspects(inspector).length, 2, "off and on again: reported again, so the panel can come back");
});

test("scrolls in one animation frame re-measure the hovered element once", () => {
	const inspector = loadInspector();
	inspector.button.computed = BUTTON_STYLE;
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: true });
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	assert.equal(inspects(inspector).length, 1);
	inspector.fire("scroll", {});
	inspector.fire("scroll", {});
	assert.equal(inspects(inspector).length, 1, "reports wait for the next frame");
	inspector.runFrames();
	assert.equal(inspects(inspector).length, 2, "two scrolls, one report");
	inspector.fire("scroll", {});
	inspector.fire("pointerout", { relatedTarget: null });
	inspector.runFrames();
	assert.deepEqual(inspects(inspector).slice(2), [{ type: "gd:inspect", element: null, generation: 0 }], "the pointer left before the frame: nothing to re-measure");
});

// ---- accessibility checks (gd:checks)

type PageSpec = { tag: string; attrs?: Record<string, string>; style?: Record<string, string>; size?: [number, number]; at?: [number, number]; text?: string; kids?: PageSpec[] };

/** What getComputedStyle reports for an element with no style of its own. */
const BASE_STYLE = {
	display: "block", visibility: "visible", opacity: "1", color: "rgb(0, 0, 0)", backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none",
	fontSize: "16px", fontWeight: "400", overflow: "visible", overflowX: "visible", overflowY: "visible", clip: "auto", clipPath: "none",
};

/** A small page for the inspector: elements in document order, with computed styles and boxes. */
function checkPage(specs: PageSpec[]) {
	const inspector = loadInspector();
	const Element = inspector.Element as new () => any;
	const all: any[] = [];
	const build = (spec: PageSpec, parent: any): any => {
		const node = new Element();
		all.push(node);
		const attrs = spec.attrs ?? {};
		Object.assign(node, {
			localName: spec.tag, parentElement: parent, id: attrs.id ?? "", className: attrs.class ?? "", styleSpec: spec.style ?? {},
			size: spec.size ?? [100, 24], childNodes: [], children: [], isConnected: true,
			getAttribute: (name: string) => attrs[name] ?? null,
			hasAttribute: (name: string) => name in attrs,
			scrollIntoView() {},
		});
		node.index = all.length;
		Object.defineProperty(node, "textContent", { get: () => node.childNodes.map((child: any) => child.textContent).join("") });
		// `at` places the box (left, top); without it the elements stack down the page.
		node.getBoundingClientRect = () => ({ left: spec.at?.[0] ?? 8, top: spec.at?.[1] ?? 8 + node.index * 30, width: node.size[0], height: node.size[1] });
		// Like the browser: no box at all under display: none (its own or an ancestor's); a box, even 0 × 0, otherwise.
		node.getClientRects = () => {
			for (let current = node; current; current = current.parentElement) if (current.styleSpec.display === "none") return [];
			return [node.getBoundingClientRect()];
		};
		if (spec.text) node.childNodes.push({ nodeType: 3, textContent: spec.text });
		for (const kid of spec.kids ?? []) {
			const child = build(kid, node);
			child.nodeType = 1;
			node.children.push(child);
			node.childNodes.push(child);
		}
		return node;
	};
	const body = build({ tag: "body", kids: specs }, null);
	const doc = inspector.document as any;
	doc.body = body;
	doc.querySelectorAll = (selector: string) => (selector === "*" ? all : selector.startsWith("#") ? all.filter((node) => node.id === selector.slice(1)) : []);
	doc.querySelector = (selector: string) => (selector.startsWith("#") ? all.find((node) => node.id === selector.slice(1)) ?? null : null);
	doc.getElementById = (id: string) => all.find((node) => node.id === id) ?? null;
	Object.assign(inspector.documentElement, { scrollWidth: 1200, clientWidth: 1200 });
	let styles = 0;
	inspector.context.getComputedStyle = (element: any) => {
		styles += 1;
		return { ...BASE_STYLE, ...(element?.styleSpec ?? {}) };
	};
	const reports = () => inspector.posted.filter((message) => message.type === "gd:checks");
	/** The canvas asks this frame to check itself (its artboard's own frame), and the page settles. */
	const run = () => {
		inspector.fromParent({ type: "gd:run-checks" });
		inspector.runTimeouts();
		return reports().at(-1) as { checks: Array<{ id: string; label: string; count: number; advice: number }>; issues: Array<Record<string, any>> };
	};
	return { inspector, all, run, reports, styles: () => styles };
}

const issuesOf = (report: { issues: Array<Record<string, any>> }, check: string, severity?: string) => report.issues.filter((issue) => issue.check === check && (severity === undefined || issue.severity === severity));
const gray = (value: number) => ({ color: `rgb(${value}, ${value}, ${value})` });

test("S4: each check result is tagged with the size generation the page heard last, and a new size sends even an unchanged result again", () => {
	const page = checkPage([{ tag: "p", attrs: { id: "faint" }, text: "World", style: gray(200) }]);
	page.inspector.fromParent({ type: "gd:size", generation: 2 });
	const first = page.run() as unknown as Record<string, unknown>;
	assert.equal(first.generation, 2);
	page.inspector.fromParent({ type: "gd:size", generation: 3 });
	page.inspector.fire("resize", {});
	page.inspector.runTimeouts();
	assert.equal(page.reports().length, 2, "the same findings at a new size are reported again");
	assert.equal((page.reports().at(-1) as Record<string, unknown>).generation, 3);
});

test("checks run only in a frame the canvas asks (the artboard's own), once the page settles after load and after a resize, and post a changed result only", () => {
	const page = checkPage([{ tag: "h1", text: "Hello" }, { tag: "p", attrs: { id: "faint" }, text: "World", style: gray(200) }, { tag: "button", text: "Go", size: [120, 48] }]);
	page.inspector.fire("load", {});
	page.inspector.fire("resize", {});
	page.inspector.runTimeouts();
	page.inspector.runFrames();
	assert.deepEqual([page.reports().length, page.styles(), page.inspector.pendingTimeouts().length], [0, 0, 0], "not asked (a size frame, the system board): nothing scanned, nothing posted");
	page.inspector.fire("message", { source: {}, data: { type: "gd:run-checks" } });
	assert.deepEqual(page.inspector.pendingTimeouts(), [], "only the canvas can ask");
	page.inspector.fromParent({ type: "gd:run-checks" });
	assert.deepEqual(page.inspector.pendingTimeouts(), [250], "after a short wait, so late images, fonts and scripts are in");
	assert.equal(page.reports().length, 0);
	page.inspector.runTimeouts();
	assert.equal(page.reports().length, 1);
	const first = page.reports()[0];
	assert.deepEqual(first.checks.map((check: { id: string; label: string; count: number; advice: number }) => [check.id, check.label, check.count, check.advice]), [
		["contrast", "Text contrast", 1, 0], ["target", "Target size", 0, 0], ["alt", "Images have alt text", 0, 0], ["label", "Form fields have labels", 0, 0], ["heading", "Headings in order", 0, 0],
	]);
	page.inspector.fire("resize", {});
	page.inspector.fire("resize", {});
	assert.deepEqual(page.inspector.pendingTimeouts(), [400], "two resizes in a row: one run, once the size settles");
	page.inspector.runTimeouts();
	assert.equal(page.reports().length, 1, "an unchanged result is not sent again");
	page.all.find((node) => node.localName === "button").size = [10, 10];
	page.inspector.fire("resize", {});
	page.inspector.runTimeouts();
	assert.equal(page.reports().length, 2, "a resize that changes the result sends it");
	assert.equal(page.reports()[1].issues.find((issue: { check: string }) => issue.check === "target").selector, "body > button");
});

test("the contrast check flags text under AA (4.5 : 1, 3 : 1 for large text) on its real background", () => {
	const page = checkPage([
		{ tag: "p", attrs: { id: "low" }, text: "or pay with card", style: gray(119) },
		{ tag: "p", attrs: { id: "ok" }, text: "fine", style: gray(118) },
		{ tag: "p", attrs: { id: "large-ok" }, text: "Big", style: { ...gray(119), fontSize: "24px" } },
		{ tag: "p", attrs: { id: "large-low" }, text: "Big", style: { ...gray(170), fontSize: "24px" } },
		{ tag: "p", attrs: { id: "bold-ok" }, text: "Bold", style: { ...gray(119), fontSize: "19px", fontWeight: "700" } },
		{ tag: "p", attrs: { id: "bold-low" }, text: "Not bold", style: { ...gray(119), fontSize: "19px", fontWeight: "400" } },
		{ tag: "p", attrs: { id: "alpha" }, text: "Faint", style: { color: "rgba(0, 0, 0, 0.2)" } },
		{ tag: "p", attrs: { id: "dark" }, text: "Light on dark", style: { color: "rgb(246, 239, 243)", backgroundColor: "rgb(26, 18, 24)" } },
		{ tag: "div", style: { backgroundColor: "rgb(0, 0, 0)" }, kids: [{ tag: "p", attrs: { id: "inherits" }, text: "Dark text on a dark parent", style: gray(40) }] },
		{ tag: "div", style: { backgroundImage: "linear-gradient(red, blue)" }, kids: [{ tag: "p", attrs: { id: "on-image" }, text: "Unknown", style: gray(200) }] },
		{ tag: "p", attrs: { id: "hidden" }, text: "Hidden", style: { ...gray(200), display: "none" } },
		{ tag: "p", attrs: { id: "invisible" }, text: "Hidden", style: { ...gray(200), visibility: "hidden" } },
		{ tag: "p", attrs: { id: "empty" }, text: "Zero", style: gray(200), size: [0, 0] },
		{ tag: "button", attrs: { id: "off", disabled: "" }, text: "Disabled", style: gray(200), size: [100, 40] },
		{ tag: "p", attrs: { id: "no-text" }, text: "   ", style: gray(200) },
		{ tag: "script", text: "var x", style: gray(255) },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "contrast").map((issue) => issue.selector), ["#low", "#large-low", "#bold-low", "#alpha", "#inherits"]);
	const low = issuesOf(report, "contrast")[0];
	assert.deepEqual(low, {
		check: "contrast", severity: "fail", title: "Low contrast", selector: "#low", label: "p#low", excerpt: "or pay with card", rect: { x: 8, y: 68, width: 100, height: 24 },
		detail: '"or pay with card" is 4.47 : 1 (#777777 on #ffffff); WCAG AA needs 4.5 : 1.',
		key: "contrast", vars: { text: "or pay with card", ratio: "4.47", foreground: "#777777", background: "#ffffff", needed: 4.5 },
	});
	assert.match(issuesOf(report, "contrast")[1].detail, /WCAG AA needs 3 : 1 for large text\.$/);
	assert.match(issuesOf(report, "contrast")[3].detail, /\(#cccccc on #ffffff\)/, "translucent text is judged as composited over its background");
	assert.deepEqual(report.checks.find((check) => check.id === "contrast"), { id: "contrast", label: "Text contrast", count: 5, advice: 0 });
});

test("the contrast check fades the text by its own alpha and by the opacity of the element and its ancestors", () => {
	const page = checkPage([
		{ tag: "p", attrs: { id: "half" }, text: "Half", style: { opacity: "0.5" } },
		{ tag: "div", style: { opacity: "0.5" }, kids: [{ tag: "p", attrs: { id: "in-faded" }, text: "Inside" }] },
		{ tag: "div", style: { opacity: "0.9" }, kids: [{ tag: "p", attrs: { id: "slight" }, text: "Slight" }] },
		{ tag: "div", style: { opacity: "0" }, kids: [{ tag: "p", attrs: { id: "invisible" }, text: "Gone" }] },
		{ tag: "p", attrs: { id: "plain" }, text: "Plain" },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "contrast").map((issue) => issue.selector), ["#half", "#in-faded"]);
	assert.equal(issuesOf(report, "contrast")[0].detail, '"Half" is 3.94 : 1 (#808080 on #ffffff); WCAG AA needs 4.5 : 1.', "black on white at opacity 0.5 is about 3.95 : 1, not 21 : 1");
	assert.equal(issuesOf(report, "contrast")[1].detail, '"Inside" is 3.94 : 1 (#808080 on #ffffff); WCAG AA needs 4.5 : 1.', "an ancestor's opacity counts too");
});

test("S6: an ancestor's opacity fades the text and its opaque background together over what lies behind that ancestor", () => {
	const page = checkPage([
		{ tag: "div", style: { opacity: "0.5" }, kids: [{ tag: "p", attrs: { id: "opaque-child" }, text: "On its own white", style: { color: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)" } }] },
		{ tag: "div", style: { opacity: "0.5" }, kids: [{ tag: "p", attrs: { id: "in-faded" }, text: "Inside" }] },
		{ tag: "p", attrs: { id: "opaque-unfaded" }, text: "Not faded", style: { color: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)" } },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "contrast").map((issue) => issue.selector), ["#opaque-child", "#in-faded"], "no finding for black on an opaque white with no faded ancestor");
	assert.equal(issuesOf(report, "contrast")[0].detail, '"On its own white" is 3.94 : 1 (#808080 on #ffffff); WCAG AA needs 4.5 : 1.', "black on white faded to 0.5 over the white page: #808080 on #ffffff, not 21 : 1");
	assert.equal(issuesOf(report, "contrast")[1].detail, '"Inside" is 3.94 : 1 (#808080 on #ffffff); WCAG AA needs 4.5 : 1.', "the transparent-child control is unchanged");
	assert.equal(report.checks.find((check) => check.id === "contrast")?.count, 2, "only the two faded paragraphs fail");
});

test("S6: nested, zero and dark-backdrop opacities fade the group as drawn; a gradient behind a faded group stays unknown; with no opacity the colors are as before", () => {
	const white = { color: "rgb(0, 0, 0)", backgroundColor: "rgb(255, 255, 255)" };
	const page = checkPage([
		{ tag: "div", style: { opacity: "0.5" }, kids: [{ tag: "div", style: { opacity: "0.5" }, kids: [{ tag: "p", attrs: { id: "nested" }, text: "x", style: white }] }] },
		{ tag: "div", style: { backgroundColor: "rgb(0, 0, 0)" }, kids: [{ tag: "div", style: { opacity: "0.5" }, kids: [{ tag: "p", attrs: { id: "on-black" }, text: "x", style: white }] }] },
		{ tag: "div", style: { backgroundImage: "linear-gradient(red, blue)" }, kids: [{ tag: "div", style: { opacity: "0.5" }, kids: [{ tag: "p", attrs: { id: "on-gradient" }, text: "x", style: white }] }] },
		{ tag: "div", style: { opacity: "0" }, kids: [{ tag: "p", attrs: { id: "unseen" }, text: "x", style: { color: "rgb(200, 200, 200)", backgroundColor: "rgb(255, 255, 255)" } }] },
		{ tag: "p", attrs: { id: "translucent" }, text: "x", style: { color: "rgba(0, 0, 0, 0.3)", backgroundColor: "rgba(255, 0, 0, 0.2)" } },
	]);
	const found = issuesOf(page.run(), "contrast");
	assert.deepEqual(found.map((issue) => issue.selector), ["#nested", "#translucent"], "black on white faded to 0.5 over black passes (about 5.3 : 1), a gradient behind is unknown, opacity 0 is not drawn");
	assert.equal(found[0].detail, '"x" is 1.83 : 1 (#bfbfbf on #ffffff); WCAG AA needs 4.5 : 1.', "0.5 × 0.5: the group at 0.25");
	assert.equal(found[1].detail, '"x" is 2.03 : 1 (#b38f8f on #ffcccc); WCAG AA needs 4.5 : 1.', "translucent text on a translucent background, no opacity: the same colors as before");
});

test("a target under 24 × 24 px is advice, never a problem: the spacing exception cannot be measured", () => {
	const report = checkPage([{ tag: "button", attrs: { id: "tiny" }, text: "Go", size: [20, 20] }]).run();
	assert.deepEqual(issuesOf(report, "target").map((issue) => [issue.selector, issue.severity, issue.title, issue.detail]), [
		["#tiny", "advice", "Small touch target", '"Go" is 20 × 20 px; WCAG 2.2 asks for 24 × 24 px, or enough space around it that a 24 px circle on it touches no other target.'],
	]);
	assert.deepEqual(report.checks.find((check) => check.id === "target"), { id: "target", label: "Target size", count: 0, advice: 1 });
});

test("the target check advises on interactive elements under 24 × 24 px and under 44 px", () => {
	const page = checkPage([
		{ tag: "button", attrs: { id: "tiny" }, text: "Go", size: [20, 20] },
		{ tag: "button", attrs: { id: "narrow" }, text: "Go", size: [100, 23] },
		{ tag: "a", attrs: { id: "advice", href: "/pay" }, text: "Pay", size: [100, 28] },
		{ tag: "button", attrs: { id: "edge" }, text: "Edge", size: [24, 24] },
		{ tag: "button", attrs: { id: "big" }, text: "Big", size: [120, 48] },
		{ tag: "a", attrs: { id: "no-href" }, text: "Not a link", size: [10, 10] },
		{ tag: "a", attrs: { id: "inline", href: "/x" }, text: "inline link", size: [60, 14], style: { display: "inline" } },
		{ tag: "button", attrs: { id: "disabled", disabled: "" }, text: "Off", size: [10, 10] },
		{ tag: "input", attrs: { id: "hidden", type: "hidden" }, size: [0, 0] },
		{ tag: "div", attrs: { id: "tab0", tabindex: "0" }, size: [20, 20] },
		{ tag: "div", attrs: { id: "tab-1", tabindex: "-1" }, size: [10, 10] },
		{ tag: "div", attrs: { id: "role-button", role: "button", "aria-label": "Close" }, size: [12, 12] },
		{ tag: "select", attrs: { id: "pick", "aria-label": "Size" }, size: [80, 22] },
		{ tag: "button", attrs: { id: "gone" }, text: "Hidden", size: [0, 0] },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "target", "fail").map((issue) => issue.selector), []);
	assert.deepEqual(issuesOf(report, "target", "advice").map((issue) => [issue.selector, issue.title]), [
		["#tiny", "Small touch target"], ["#narrow", "Small touch target"], ["#advice", "Touch target under 44 px"], ["#edge", "Touch target under 44 px"],
		["#tab0", "Small touch target"], ["#role-button", "Small touch target"], ["#pick", "Small touch target"],
	]);
	assert.deepEqual([issuesOf(report, "target")[0].title, issuesOf(report, "target")[0].detail], ["Small touch target", '"Go" is 20 × 20 px; WCAG 2.2 asks for 24 × 24 px, or enough space around it that a 24 px circle on it touches no other target.']);
	assert.deepEqual([issuesOf(report, "target", "advice")[2].title, issuesOf(report, "target", "advice")[2].detail], ["Touch target under 44 px", '"Pay" is 100 × 28 px; 44 × 44 px is recommended for touch.']);
	assert.match(issuesOf(report, "target").find((issue) => issue.selector === "#role-button")!.detail, /^"Close" is 12 × 12 px/, "named by its aria-label");
	assert.deepEqual(report.checks.find((check) => check.id === "target"), { id: "target", label: "Target size", count: 0, advice: 7 });
});

test("the alt check flags images without an alt attribute; alt=\"\", presentation and aria-hidden are fine", () => {
	const page = checkPage([
		{ tag: "img", attrs: { id: "bad", src: "/img/hero-photo.png?x=1" } },
		{ tag: "img", attrs: { id: "empty", src: "a.png", alt: "" } },
		{ tag: "img", attrs: { id: "named", src: "b.png", alt: "A cup" } },
		{ tag: "img", attrs: { id: "role", src: "c.png", role: "presentation" } },
		{ tag: "img", attrs: { id: "none", src: "d.png", role: "none" } },
		{ tag: "img", attrs: { id: "aria", src: "e.png", "aria-hidden": "true" } },
		{ tag: "img", attrs: { id: "nosrc" } },
		{ tag: "input", attrs: { id: "btn", type: "image", src: "f.png", "aria-label": "Go" }, size: [48, 48] },
		{ tag: "input", attrs: { id: "btn-ok", type: "image", src: "f.png", alt: "Go" }, size: [48, 48] },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "alt").map((issue) => issue.selector), ["#bad", "#nosrc", "#btn"]);
	assert.deepEqual([issuesOf(report, "alt")[0].title, issuesOf(report, "alt")[0].detail], ["Image without alt text", 'hero-photo.png has no alt attribute. Describe it, or use alt="" if it is decorative.']);
	assert.equal(issuesOf(report, "alt")[1].detail, 'The image has no alt attribute. Describe it, or use alt="" if it is decorative.');
	assert.equal(report.checks.find((check) => check.id === "alt")?.count, 3);
});

test("the alt check skips images that are not rendered (inside a display: none parent); a rendered image not loaded yet still needs alt", () => {
	const page = checkPage([
		{ tag: "div", style: { display: "none" }, kids: [{ tag: "img", attrs: { id: "in-hidden", src: "menu.png" } }] },
		{ tag: "img", attrs: { id: "own-hidden", src: "tab.png" }, style: { display: "none" } },
		{ tag: "img", attrs: { id: "loading", src: "late.png" }, size: [0, 0] },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "alt").map((issue) => issue.selector), ["#loading"]);
	assert.equal(report.checks.find((check) => check.id === "alt")?.count, 1);
});

test("the label check flags form fields without an accessible label, and accepts each way of labeling", () => {
	const page = checkPage([
		{ tag: "input", attrs: { id: "aria", type: "text", "aria-label": "Email" } },
		{ tag: "label", attrs: { for: "for" }, text: "Street" },
		{ tag: "input", attrs: { id: "for", type: "text" } },
		{ tag: "label", text: "City", kids: [{ tag: "input", attrs: { id: "wrapped", type: "text" } }] },
		{ tag: "span", attrs: { id: "name" }, text: "Postal code" },
		{ tag: "input", attrs: { id: "by", type: "text", "aria-labelledby": "missing name" } },
		{ tag: "input", attrs: { id: "title", type: "text", title: "Phone" } },
		{ tag: "input", attrs: { id: "placeholder", type: "text", placeholder: "Search" } },
		{ tag: "select", attrs: { id: "select" } },
		{ tag: "textarea", attrs: { id: "area" } },
		{ tag: "input", attrs: { id: "blank", type: "text", "aria-label": "  " } },
		{ tag: "label", attrs: { for: "empty-label" }, text: " " },
		{ tag: "input", attrs: { id: "empty-label", type: "text" } },
		{ tag: "input", attrs: { id: "dangling", type: "text", "aria-labelledby": "nowhere" } },
		{ tag: "input", attrs: { id: "submit", type: "submit", value: "Pay" } },
		{ tag: "input", attrs: { id: "button", type: "button" } },
		{ tag: "input", attrs: { id: "reset", type: "reset" } },
		{ tag: "input", attrs: { id: "hidden", type: "hidden" } },
		{ tag: "input", attrs: { id: "invisible", type: "text" }, style: { display: "none" } },
		{ tag: "input", attrs: { id: "no-type" } },
		{ tag: "input", attrs: { id: "email", type: "email" } },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "label").map((issue) => issue.selector), ["#placeholder", "#select", "#area", "#blank", "#empty-label", "#dangling", "#no-type", "#email"]);
	assert.deepEqual([issuesOf(report, "label")[0].title, issuesOf(report, "label")[0].detail], ["Form field without a label", 'The text field "Search" has no label. Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label.']);
	assert.equal(issuesOf(report, "label")[1].detail, "The select has no label. Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label.");
	assert.equal(issuesOf(report, "label")[2].detail, "The text area has no label. Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label.");
	assert.equal(issuesOf(report, "label")[7].detail, "The email field has no label. Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label.");
	assert.equal(report.checks.find((check) => check.id === "label")?.count, 8);
});

test("the heading check flags levels that skip, in document order", () => {
	const page = checkPage([
		{ tag: "h1", text: "Title" }, { tag: "h2", text: "A" },
		{ tag: "h4", attrs: { id: "skip1" }, text: "Detail" },
		{ tag: "h2", text: "B" }, { tag: "h3", text: "B1" }, { tag: "h3", text: "B2" },
		{ tag: "h6", attrs: { id: "skip2" }, text: "Fine print" },
		{ tag: "h1", text: "Again" }, { tag: "h2", text: "Ok" },
		{ tag: "div", attrs: { id: "aria", role: "heading", "aria-level": "4" }, text: "ARIA heading" },
		{ tag: "h5", attrs: { id: "hidden" }, text: "Hidden", style: { display: "none" } },
	]);
	const report = page.run();
	assert.deepEqual(issuesOf(report, "heading").map((issue) => issue.selector), ["#skip1", "#skip2", "#aria"]);
	assert.deepEqual([issuesOf(report, "heading")[0].title, issuesOf(report, "heading")[0].detail], ["Heading level skipped", 'h4 "Detail" follows h2: h3 is missing.']);
	assert.equal(issuesOf(report, "heading")[1].detail, 'h6 "Fine print" follows h3: h4, h5 are missing.');
	const clean = checkPage([{ tag: "h2", text: "Starts at two" }, { tag: "h3", text: "x" }, { tag: "h2", text: "y" }]);
	assert.deepEqual(clean.run().issues, [], "the first heading may be any level; going back up is fine");
});

/** canvas-checks.js's English TEXT block, evaluated from its source: the canvas's own English for each finding key. */
function canvasFindings(): Record<string, { title: string; detail: (vars: Record<string, unknown>) => string }> {
	const source = read("canvas-checks.js");
	const start = source.indexOf("const TEXT = Object.freeze({");
	return new Function(`return ${source.slice(start + "const TEXT = ".length, source.indexOf("\n});", start) + 3)}`)().findings;
}

test("each finding carries its key and plain vars, from which the canvas's English gives back the inspector's title and detail", () => {
	const page = checkPage([
		{ tag: "p", attrs: { id: "low" }, text: "or pay with card", style: gray(119) },
		{ tag: "p", attrs: { id: "large-low" }, text: "Big", style: { ...gray(170), fontSize: "24px" } },
		{ tag: "button", attrs: { id: "tiny" }, text: "Go", size: [20, 20] },
		{ tag: "div", attrs: { id: "tab0", tabindex: "0" }, size: [20, 20] },
		{ tag: "a", attrs: { id: "advice", href: "/pay" }, text: "Pay", size: [100, 28] },
		{ tag: "img", attrs: { id: "bad", src: "/img/hero-photo.png?x=1" } },
		{ tag: "img", attrs: { id: "nosrc" } },
		{ tag: "input", attrs: { id: "placeholder", type: "text", placeholder: "Search" } },
		{ tag: "select", attrs: { id: "select" } },
		{ tag: "textarea", attrs: { id: "area" } },
		{ tag: "h1", text: "Title" }, { tag: "h2", text: "A" }, { tag: "h4", attrs: { id: "skip1" }, text: "Detail" },
		{ tag: "h3", text: "B1" }, { tag: "h6", attrs: { id: "skip2" }, text: "Fine print" },
	]);
	const findings = canvasFindings();
	const issues = page.run().issues;
	assert.deepEqual([...new Set(issues.map((issue) => issue.key))].sort(), ["alt", "contrast", "contrastLarge", "heading", "label", "targetAdvised", "targetSmall"]);
	assert.deepEqual(Object.keys(findings).sort(), ["alt", "contrast", "contrastLarge", "heading", "label", "targetAdvised", "targetSmall"]);
	for (const issue of issues) {
		assert.ok(Object.values(issue.vars).every((value) => typeof value === "string" || Number.isFinite(value)), `${issue.selector}: plain vars`);
		assert.deepEqual([findings[issue.key].title, findings[issue.key].detail(issue.vars)], [issue.title, issue.detail], issue.selector);
	}
	assert.deepEqual(issues.filter((issue) => issue.check !== "contrast").map((issue) => [issue.selector, issue.key, JSON.stringify(issue.vars)]), [
		["#tiny", "targetSmall", '{"name":"Go","element":"button#tiny","width":20,"height":20,"min":24}'],
		["#tab0", "targetSmall", '{"name":"","element":"div#tab0","width":20,"height":20,"min":24}'],
		["#advice", "targetAdvised", '{"name":"Pay","element":"a#advice","width":100,"height":28,"advised":44}'],
		["#placeholder", "targetAdvised", '{"name":"","element":"input#placeholder","width":100,"height":24,"advised":44}'],
		["#select", "targetAdvised", '{"name":"","element":"select#select","width":100,"height":24,"advised":44}'],
		["#area", "targetAdvised", '{"name":"","element":"textarea#area","width":100,"height":24,"advised":44}'],
		["#bad", "alt", '{"source":"hero-photo.png"}'],
		["#nosrc", "alt", '{"source":""}'],
		["#placeholder", "label", '{"field":"input","type":"text","hint":"Search"}'],
		["#select", "label", '{"field":"select","type":"","hint":""}'],
		["#area", "label", '{"field":"textarea","type":"","hint":""}'],
		["#skip1", "heading", '{"level":4,"previous":2,"text":"Detail","missing":"h3","count":1}'],
		["#skip2", "heading", '{"level":6,"previous":3,"text":"Fine print","missing":"h4, h5","count":2}'],
	]);
});

test("each check lists at most 20 problems and 10 advice items, with the full counts", () => {
	const page = checkPage(Array.from({ length: 45 }, (_, index) => ({ tag: "p", attrs: { id: `p${index}` }, text: `text ${index}`, style: gray(200) })));
	const report = page.run();
	assert.deepEqual([issuesOf(report, "contrast").length, report.checks.find((check) => check.id === "contrast")!.count], [20, 45]);
	assert.deepEqual(issuesOf(report, "contrast").map((issue) => issue.selector).slice(0, 2), ["#p0", "#p1"], "the first ones in document order");
	const advice = checkPage(Array.from({ length: 30 }, (_, index) => ({ tag: "button", attrs: { id: `b${index}` }, text: "x", size: [30, 30] as [number, number] }))).run();
	assert.deepEqual([issuesOf(advice, "target", "advice").length, advice.checks.find((check) => check.id === "target")!.advice], [10, 30]);
});

test("a finding whose element is out of sight says hidden: true; below the fold is not out of sight", () => {
	const page = checkPage([
		{ tag: "a", attrs: { id: "skip", href: "#main" }, text: "Skip to content", size: [120, 20], at: [-500, 8] },
		{ tag: "button", attrs: { id: "clipped" }, text: "x", size: [1, 1] },
		{ tag: "button", attrs: { id: "rect" }, text: "y", size: [10, 10], style: { clip: "rect(0px, 0px, 0px, 0px)" } },
		{ tag: "div", attrs: { id: "box" }, size: [100, 100], at: [0, 0], style: { overflow: "hidden", overflowX: "hidden", overflowY: "hidden" }, kids: [{ tag: "button", attrs: { id: "cut" }, text: "z", size: [10, 10], at: [300, 0] }] },
		{ tag: "button", attrs: { id: "fold" }, text: "w", size: [10, 10], at: [8, 5000] },
		{ tag: "button", attrs: { id: "right" }, text: "v", size: [10, 10], at: [1300, 8] },
	]);
	const report = page.run();
	const hidden = Object.fromEntries(issuesOf(report, "target").map((issue) => [issue.selector, issue.hidden === true]));
	assert.deepEqual(hidden, { "#skip": true, "#clipped": true, "#rect": true, "#cut": true, "#fold": false, "#right": true });
	assert.equal(Object.hasOwn(issuesOf(report, "target").find((issue) => issue.selector === "#fold")!, "hidden"), false, "a visible finding has no hidden field");
});

/** Comment mode with Technical details on and the button hovered and measured; then the button grows without a scroll. */
function measuredThenResized({ fonts = false } = {}) {
	const inspector = loadInspector({ fonts });
	inspector.button.computed = BUTTON_STYLE;
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: true });
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	assert.deepEqual(inspects(inspector), [{ type: "gd:inspect", element: BUTTON_MEASURE, generation: 0 }]);
	inspector.button.getBoundingClientRect = () => ({ left: 4, top: 8, width: 120, height: 48 });
	inspector.button.computed = { ...BUTTON_STYLE, fontSize: "18px" };
	return inspector;
}
const RESIZED = { type: "gd:inspect", element: { ...BUTTON_MEASURE, rect: { x: 4, y: 8, width: 120, height: 48 }, fontSize: 18, radius: [6, 6, 24, 6] }, generation: 0 };

test("a late load on the page re-measures the hovered element once per frame", () => {
	const inspector = measuredThenResized();
	inspector.captureOnDocument("load", inspector.makeNode());
	inspector.captureOnDocument("load", inspector.makeNode());
	assert.equal(inspects(inspector).length, 1, "reports wait for the next frame");
	inspector.runFrames();
	assert.deepEqual(inspects(inspector).slice(1), [RESIZED], "two loads in one frame, one report with the new size");
});

test("a late web font re-measures the hovered element once per frame", () => {
	const inspector = measuredThenResized({ fonts: true });
	inspector.fontsLoaded();
	inspector.fontsLoaded();
	assert.equal(inspects(inspector).length, 1, "reports wait for the next frame");
	inspector.runFrames();
	assert.deepEqual(inspects(inspector).slice(1), [RESIZED], "two font loads in one frame, one report with the new size");
});

test("a page change re-measures the hovered element once per frame; the inspector's own boxes do not", () => {
	const inspector = measuredThenResized();
	const ownBox = Object.assign(inspector.makeNode(), { hasAttribute: () => true });
	inspector.mutate([{ type: "attributes", target: ownBox }]);
	inspector.runFrames();
	assert.equal(inspects(inspector).length, 1, "the inspector's own boxes moving is no page change");
	inspector.mutate([{ type: "childList", target: inspector.makeNode() }]);
	inspector.mutate([{ type: "attributes", target: inspector.makeNode() }]);
	assert.equal(inspects(inspector).length, 1, "reports wait for the next frame");
	inspector.runFrames();
	assert.deepEqual(inspects(inspector).slice(1), [RESIZED], "two changes in one frame, one report with the new size");
});

test("the measure reports the page's root font size, so rem tokens are compared in this page's px; 16 when unreadable", () => {
	const inspector = loadInspector();
	inspector.button.computed = BUTTON_STYLE;
	const root = inspector.documentElement as unknown as Record<string, unknown>;
	root.computed = { fontSize: "10px" };
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: true });
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	assert.equal(inspector.posted.at(-1).element.rootFontSize, 10);
	root.computed = { fontSize: "" };
	inspector.fire("scroll", {});
	inspector.runFrames();
	assert.equal(inspector.posted.at(-1).element.rootFontSize, 16, "no readable root font size: the browser default");
});
