import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../../assets/design-canvas/canvas-boot.js";

// The canvas modules run in the browser; the canvas tests boot them with a
// minimal fake window and DOM so their contracts are checked without a browser.
// No module touches the DOM or window when it is imported, so they load as
// ordinary ES modules.

export const ASSET_DIR = fileURLToPath(new URL("../../assets/design-canvas/", import.meta.url));
export const read = (name: string) => readFileSync(join(ASSET_DIR, name), "utf8");

export type Listener = (event: any) => void;
// postMessage clones its message, so a test sees a plain copy.
export const structuredCopy = (message: unknown) => JSON.parse(JSON.stringify(message));
type Rect = { left: number; top: number; width: number; height: number };
export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";
// index.html elements the canvas looks up by id whose tag matters to it; any other id is a div.
const TAGS: Record<string, [string, string?]> = { "gd-back": ["button"], "gd-shortcuts": ["dialog"], "gd-sprite": ["svg", SVG_NS] };

export class FakeElement {
	localName: string;
	namespaceURI = HTML_NS;
	id = "";
	children: FakeElement[] = [];
	parentElement: FakeElement | null = null;
	attributes = new Map<string, string>();
	classes = new Set<string>();
	listeners = new Map<string, Listener[]>();
	style: Record<string, any> = { setProperty(name: string, value: string) { this[name] = value; } };
	dataset: Record<string, string> = {};
	textContent = "";
	title = "";
	hidden = false;
	disabled = false;
	inert = false;
	value = "";
	// Set by the canvas on iframes, the Open in new tab link and the Scale to fit checkbox.
	src = "";
	href = "";
	checked = false;
	rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
	capturedPointers: number[] = [];
	contentWindow: { posted: any[]; postMessage(message: any): void } | null = null;
	doc: FakeDocument;

	constructor(tag: string, doc: FakeDocument) {
		this.localName = tag;
		this.doc = doc;
		// node:assert diffs a failed comparison with its own inspect (depth 1000, custom inspect off):
		// back-references would let it walk the whole cyclic document and exhaust memory.
		// It skips non-enumerable properties, so hide them.
		for (const key of ["doc", "parentElement"]) Object.defineProperty(this, key, { enumerable: false, writable: true, value: (this as any)[key] });
		if (tag === "iframe") {
			const posted: any[] = [];
			this.contentWindow = { posted, postMessage: (message) => posted.push(structuredCopy(message)) };
		}
	}

	get className() { return [...this.classes].join(" "); }
	set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
	get classList() {
		const classes = this.classes;
		return {
			add: (name: string) => classes.add(name),
			remove: (name: string) => classes.delete(name),
			contains: (name: string) => classes.has(name),
			toggle: (name: string, force?: boolean) => {
				const on = force === undefined ? !classes.has(name) : force;
				if (on) classes.add(name);
				else classes.delete(name);
				return on;
			},
		};
	}

	// Layout offsets inside the offset parent; unlike rects, the world's transform never changes them.
	offsetLeft = 0;
	offsetTop = 0;
	get offsetWidth() { return 0; }
	get offsetHeight() { return 0; }
	setAttribute(name: string, value: unknown) {
		this.attributes.set(name, String(value));
		// SVG elements take their class through the attribute (className is not a string there).
		if (name === "class") this.className = String(value);
	}
	getAttribute(name: string) { return this.attributes.get(name) ?? null; }
	hasAttribute(name: string) { return this.attributes.has(name); }
	removeAttribute(name: string) { this.attributes.delete(name); }
	append(...nodes: FakeElement[]) {
		for (const node of nodes) {
			node.parentElement = this;
			this.children.push(node);
		}
	}
	replaceChildren(...nodes: FakeElement[]) {
		for (const child of this.children) child.parentElement = null;
		this.children = [];
		this.append(...nodes);
	}
	contains(node: FakeElement | null) {
		for (let current = node; current; current = current.parentElement) if (current === this) return true;
		return false;
	}
	matches(selector: string) {
		return selector.split(",").some((part) => {
			const name = part.trim();
			if (name === "[contenteditable]") return this.hasAttribute("contenteditable");
			return name.startsWith(".") ? this.classes.has(name.slice(1)) : this.localName === name;
		});
	}
	get isContentEditable(): boolean {
		const value = this.getAttribute("contenteditable");
		if (value === "" || value === "true" || value === "plaintext-only") return true;
		if (value === "false") return false;
		return this.parentElement?.isContentEditable ?? false;
	}
	closest(selector: string) {
		for (let current: FakeElement | null = this; current; current = current.parentElement) if (current.matches(selector)) return current;
		return null;
	}
	querySelector() { return null; }
	addEventListener(type: string, listener: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	/** Bubbles from this element through its ancestors, like a DOM event. */
	dispatch(type: string, init: Record<string, unknown> = {}) {
		const event: any = { type, target: this, defaultPrevented: false, ...init, preventDefault() { event.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
		for (let current: FakeElement | null = this; current; current = current.parentElement) {
			for (const listener of current.listeners.get(type) ?? []) listener(event);
		}
		return event;
	}
	focus() { this.doc.activeElement = this; }
	getBoundingClientRect() { return this.rect; }
	setPointerCapture(pointerId: number) { this.capturedPointers.push(pointerId); }
	scrollIntoView() {}
	/** <dialog>: open as a modal, and close with its close event, like the browser (the event comes at once here). */
	showModal() { this.setAttribute("open", ""); }
	close() {
		if (!this.hasAttribute("open")) return;
		this.removeAttribute("open");
		this.dispatch("close");
	}
}

export class FakeDocument {
	activeElement: FakeElement | null = null;
	body: FakeElement;
	documentElement: FakeElement;
	title = "";
	byId = new Map<string, FakeElement>();
	listeners = new Map<string, Listener[]>();

	constructor() {
		this.documentElement = new FakeElement("html", this);
		this.body = new FakeElement("body", this);
		this.documentElement.append(this.body);
		this.activeElement = this.body;
	}
	createElement(tag: string) { return new FakeElement(tag, this); }
	createElementNS(namespace: string, tag: string) {
		const element = new FakeElement(tag, this);
		element.namespaceURI = namespace;
		return element;
	}
	getElementById(id: string) {
		let element = this.byId.get(id);
		if (!element) {
			const [tag, namespace] = TAGS[id] ?? ["div"];
			element = new FakeElement(tag, this);
			if (namespace) element.namespaceURI = namespace;
			element.id = id;
			this.byId.set(id, element);
		}
		return element;
	}
	addEventListener(type: string, listener: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	querySelectorAll() { return []; }
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A localStorage that keeps what the canvas stores, seeded with `seed`; `broken` throws on every call,
 * like a browser that denies storage. `writes` lists every setItem as [key, value].
 */
export function memoryStorage(seed: Record<string, string> = {}, broken = false) {
	const data = new Map<string, string>(Object.entries(seed));
	const writes: Array<[string, string]> = [];
	const localStorage = broken
		? { getItem(): string | null { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }
		: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, String(value)); writes.push([key, String(value)]); } };
	return { localStorage, data, writes };
}

/** config: fields merged into #gd-config; extraWindow: window fields that replace the defaults (a localStorage, for one). */
export async function loadCanvas(firstHeight = 300, extraReplies: Record<string, unknown> = {}, config: Record<string, unknown> = {}, extraWindow: Record<string, unknown> = {}) {
	const document = new FakeDocument();
	document.getElementById("gd-config").textContent = JSON.stringify({ base: "/t/", slug: "alpha", ...config });
	const viewport = document.getElementById("gd-viewport");
	const world = document.getElementById("gd-world");
	viewport.append(world);
	viewport.rect = { left: 0, top: 50, width: 1000, height: 700 };
	const windowListeners = new Map<string, Listener[]>();
	const replies: Record<string, unknown> = {
		"/t/api/system": { exists: false },
		"/t/api/designs": { designs: [{ slug: "alpha", title: "Alpha", valid: true }] },
		"/t/api/designs/alpha": {
			slug: "alpha",
			title: "Alpha",
			brief: "",
			artboards: [
				{ file: "01-a.html", title: "First", tradeoff: "", width: 400, height: firstHeight },
				{ file: "02-b.html", title: "Second", tradeoff: "", width: 400, height: 300 },
			],
		},
		"/t/api/designs/alpha/comments": { comments: [] },
		"/t/api/designs/alpha/handoffs": { version: 1, chosen: null, handoffs: {} },
		"/t/api/designs/beta": {
			slug: "beta",
			title: "Beta",
			brief: "",
			artboards: [{ file: "01-only.html", title: "Only", tradeoff: "", width: 500, height: 400 }],
		},
		"/t/api/designs/beta/comments": { comments: [] },
		"/t/api/designs/beta/handoffs": { version: 1, chosen: null, handoffs: {} },
		...extraReplies,
	};
	const fetched: string[] = [];
	const posts: Array<{ url: string; body: unknown }> = [];
	const urls: string[] = [];
	const sourceListeners = new Map<string, Listener[]>();
	// No ResizeObserver or FileReader: the canvas falls back to window resize events.
	const window: Record<string, any> = {
		// Canvas timers (toasts, the preview load timeout) must not keep the test process alive.
		setTimeout: (callback: () => void, ms?: number) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; },
		clearTimeout,
		location: { port: "4100", origin: "http://127.0.0.1:4100" },
		URL,
		innerWidth: 1200,
		innerHeight: 800,
		CSS: { escape: (value: string) => value },
		history: { replaceState(_state: unknown, _title: string, url: string) { urls.push(url); } },
		localStorage: { getItem: () => null, setItem() {} },
		requestAnimationFrame: (callback: () => void) => { callback(); return 0; },
		fetch: async (url: string, init?: { method?: string; body?: string }) => {
			if (init?.method === "POST") posts.push({ url, body: JSON.parse(init.body ?? "null") });
			fetched.push(url);
			return { ok: url in replies, status: url in replies ? 200 : 404, json: async () => replies[url] ?? {} };
		},
		EventSource: class {
			addEventListener(type: string, listener: Listener) {
				sourceListeners.set(type, [...(sourceListeners.get(type) ?? []), listener]);
			}
		},
		addEventListener(type: string, listener: Listener) {
			windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
		},
		...extraWindow,
	};
	boot(window, document);
	for (let i = 0; i < 10; i++) await flush();
	const boards = world.children.map((wrapper) => {
		const box = wrapper.children.find((child) => child.classes.has("gd-frame-box"))!;
		const frame = box.children.find((child) => child.localName === "iframe")!;
		const shield = box.children.find((child) => child.classes.has("gd-shield"));
		return { wrapper, frame, shield };
	});
	const message = (source: unknown, data: unknown) => {
		for (const listener of windowListeners.get("message") ?? []) listener({ source, data });
	};
	const windowEvent = (type: string) => {
		for (const listener of windowListeners.get(type) ?? []) listener({ type });
	};
	/** A server-sent event on the canvas's live-reload stream, then the async work it starts. */
	const serverEvent = async (type: string, data: unknown) => {
		for (const listener of sourceListeners.get(type) ?? []) listener({ type, data: JSON.stringify(data) });
		for (let i = 0; i < 10; i++) await flush();
	};
	const frames = () => world.children.map((wrapper) => wrapper.children.find((child) => child.classes.has("gd-frame-box"))!.children.find((child) => child.localName === "iframe")!);
	return { document, viewport, world, boards, message, windowEvent, serverEvent, frames, fetched, posts, urls, replies, zoomLevel: document.getElementById("gd-zoom-level"), navMode: document.getElementById("gd-nav-mode") };
}

export type CanvasFixture = Awaited<ReturnType<typeof loadCanvas>>;

export function click(target: FakeElement, x: number, y: number) {
	target.dispatch("pointerdown", { button: 0, pointerId: 1, clientX: x, clientY: y });
	target.dispatch("pointerup", { button: 0, pointerId: 1, clientX: x, clientY: y });
}

/** Every element under `root` (itself included) that matches `test`. */
export function findAll(root: FakeElement, test: (element: FakeElement) => boolean): FakeElement[] {
	const found: FakeElement[] = test(root) ? [root] : [];
	for (const child of root.children) found.push(...findAll(child, test));
	return found;
}

export const withClass = (root: FakeElement, name: string) => findAll(root, (element) => element.classes.has(name));
export const texts = (root: FakeElement, name: string) => withClass(root, name).map((element) => element.textContent);

export function handoffDoc(chosen: string | null, handoffs: Record<string, Record<string, unknown>>) {
	const entries = Object.fromEntries(Object.entries(handoffs).map(([file, entry]) => [file, { status: "sent", queued: false, sentAt: "2026-10-26T10:00:00.000Z", startedAt: null, implementedAt: null, ...entry }]));
	return { version: 1, chosen, handoffs: entries };
}

export async function setHandoffs(canvas: CanvasFixture, document: unknown) {
	canvas.replies["/t/api/designs/alpha/handoffs"] = document;
	await canvas.serverEvent("change", { slug: "alpha", file: "handoffs.json" });
}

export const boardsOf = (canvas: CanvasFixture) => canvas.world.children;
