import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { read, structuredCopy, type Listener } from "./support/design-canvas-dom.ts";

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
	const created: any[] = [];
	const button = Object.assign(new Element(), {
		id: "cta",
		isConnected: true,
		localName: "button",
		innerText: "Buy now",
		parentElement: null,
		hasAttribute: () => false,
		getAttribute: () => null,
		getBoundingClientRect: () => ({ left: 4, top: 8, width: 60, height: 20 }),
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
		querySelector: () => null,
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
		getComputedStyle: () => ({ overflowX: "hidden", overflowY: "hidden" }),
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
	return { posted, fire, fromParent, context, documentElement, runFrames, captureOnDocument, mutate, fontsLoaded, makeNode, Element, hoverBox, selectedBox };
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
	assert.deepEqual(inspector.posted, [{ type: "gd:pick", selector: "#cta", excerpt: "Buy now", rect: { x: 4, y: 8, width: 60, height: 20 } }]);
	inspector.fromParent({ type: "gd:pick-at", x: "10", y: 12 });
	assert.equal(inspector.posted.length, 1, "non-numeric points are ignored");
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
