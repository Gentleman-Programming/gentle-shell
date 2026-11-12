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
	// Animation frames wait until the test runs them.
	const frames: Array<() => void> = [];
	const context: Record<string, any> = {
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
	// The inspector makes its hover outline first, then the selected one.
	const [hoverBox, selectedBox] = created;
	return { posted, fire, fromParent, context, documentElement, runFrames, scrolled, button, captureOnDocument, mutate, fontsLoaded, makeNode, Element, hoverBox, selectedBox };
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
	assert.deepEqual(inspector.posted, [{ type: "gd:inspect", element: BUTTON_MEASURE }]);
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
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:inspect", element: null }, "the pointer left the page");
	inspector.fire("scroll", {});
	inspector.runFrames();
	assert.equal(inspects(inspector).length, 3, "nothing hovered, nothing to report on scroll");
	inspector.fire("pointerover", { target: inspector.button });
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:inspect", element: BUTTON_MEASURE });
	inspector.fromParent({ type: "gd:mode", enabled: false, inspect: true });
	assert.deepEqual(inspector.posted.at(-1), { type: "gd:inspect", element: null }, "leaving Comment mode clears it");
	assert.equal(inspects(inspector).length, 5);
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
	assert.deepEqual(inspects(inspector), [{ type: "gd:inspect", element: BUTTON_MEASURE }], "on: the element already hovered, at once");
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
	assert.deepEqual(inspects(inspector).slice(2), [{ type: "gd:inspect", element: null }], "the pointer left before the frame: nothing to re-measure");
});

/** Comment mode with Technical details on and the button hovered and measured; then the button grows without a scroll. */
function measuredThenResized({ fonts = false } = {}) {
	const inspector = loadInspector({ fonts });
	inspector.button.computed = BUTTON_STYLE;
	inspector.fromParent({ type: "gd:mode", enabled: true, inspect: true });
	inspector.fromParent({ type: "gd:hover-at", x: 10, y: 12 });
	assert.deepEqual(inspects(inspector), [{ type: "gd:inspect", element: BUTTON_MEASURE }]);
	inspector.button.getBoundingClientRect = () => ({ left: 4, top: 8, width: 120, height: 48 });
	inspector.button.computed = { ...BUTTON_STYLE, fontSize: "18px" };
	return inspector;
}
const RESIZED = { type: "gd:inspect", element: { ...BUTTON_MEASURE, rect: { x: 4, y: 8, width: 120, height: 48 }, fontSize: 18, radius: [6, 6, 24, 6] } };

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
