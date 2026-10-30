// Gentle Design artboard inspector, injected by the canvas server into every
// artboard. In comment mode it highlights the hovered element and reports the
// clicked one to the canvas; otherwise it only forwards canvas zoom and pan.
// It also reports where each commented element is, so the canvas can pin it.
// In navigation mode the canvas covers the artboard with a shield and routes
// comment-mode hovers and clicks here as points; in focus mode the artboard
// owns the wheel and the keyboard, and Shift+Esc asks the canvas to leave.
(() => {
	"use strict";

	if (window.parent === window) return;
	const MAX_SELECTOR = 500;
	const MAX_EXCERPT = 300;
	const MARK = "data-gd-inspector";
	const MAX_PINS = 500;
	let enabled = false;
	let focused = false;
	let pins = [];
	let reportQueued = false;
	let hovered = null;
	let selected = null;

	function makeBox(color) {
		const box = document.createElement("div");
		box.setAttribute(MARK, "");
		box.setAttribute("aria-hidden", "true");
		Object.assign(box.style, {
			position: "fixed",
			pointerEvents: "none",
			zIndex: "2147483647",
			border: `2px solid ${color}`,
			background: "rgba(138, 180, 255, 0.12)",
			borderRadius: "2px",
			display: "none",
			margin: "0",
			padding: "0",
		});
		return box;
	}

	// Attached to <html>, not <body>, so body child positions (and selectors) stay unchanged.
	const hoverBox = makeBox("#8ab4ff");
	const selectedBox = makeBox("#ffd479");

	function place(box, element) {
		if (!element || !element.isConnected) {
			box.style.display = "none";
			return;
		}
		const rect = element.getBoundingClientRect();
		Object.assign(box.style, {
			display: "block",
			left: `${rect.left - 2}px`,
			top: `${rect.top - 2}px`,
			width: `${rect.width + 4}px`,
			height: `${rect.height + 4}px`,
		});
	}

	function refresh() {
		place(hoverBox, enabled ? hovered : null);
		place(selectedBox, selected);
	}

	function ensureBoxes() {
		if (!hoverBox.isConnected) document.documentElement.append(hoverBox, selectedBox);
	}

	function setEnabled(next) {
		enabled = next;
		if (enabled) ensureBoxes();
		document.documentElement.style.cursor = enabled ? "crosshair" : "";
		if (!enabled) {
			hovered = null;
			selected = null;
		}
		refresh();
	}

	function isOwn(node) {
		return node instanceof Element && node.hasAttribute(MARK);
	}

	function elementOf(node) {
		if (!(node instanceof Element) || isOwn(node)) return null;
		return node === document.documentElement ? document.body : node;
	}

	function targetOf(event) {
		return elementOf(event.target);
	}

	/** The element under a point the canvas routed from its shield, in artboard coordinates. */
	function elementAt(data) {
		if (typeof data.x !== "number" || typeof data.y !== "number" || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return null;
		return elementOf(document.elementFromPoint(data.x, data.y));
	}

	function hasUniqueId(element) {
		if (!element.id) return false;
		try {
			return document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1;
		} catch {
			return false;
		}
	}

	/** Stable selector: a unique id when there is one, else a tag:nth-of-type chain up to body. */
	function cssSelector(element) {
		if (!element || element === document.body || element === document.documentElement) return "body";
		const parts = [];
		let anchored = false;
		for (let node = element; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
			if (hasUniqueId(node)) {
				parts.unshift(`#${CSS.escape(node.id)}`);
				anchored = true;
				break;
			}
			const tag = node.localName;
			const parent = node.parentElement;
			const siblings = parent ? Array.from(parent.children).filter((child) => child.localName === tag) : [];
			parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
		}
		if (!anchored) parts.unshift("body");
		while (parts.join(" > ").length > MAX_SELECTOR && parts.length > 1) parts.shift();
		return parts.join(" > ").slice(0, MAX_SELECTOR);
	}

	function excerptOf(element) {
		const text = element.innerText || element.textContent || element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title") || "";
		return text.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT);
	}

	function post(message) {
		window.parent.postMessage(message, "*");
	}

	function find(selector) {
		try {
			return document.querySelector(selector);
		} catch {
			return null;
		}
	}

	/** Where each pinned comment's element is now; null when its selector no longer matches. */
	function reportPins() {
		reportQueued = false;
		post({
			type: "gd:pin-rects",
			rects: pins.map((pin) => {
				const element = find(pin.selector);
				if (!element) return { id: pin.id, rect: null };
				const rect = element.getBoundingClientRect();
				return { id: pin.id, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
			}),
		});
	}

	function queueReport() {
		if (reportQueued || pins.length === 0) return;
		reportQueued = true;
		requestAnimationFrame(reportPins);
	}

	function setPins(value) {
		if (!Array.isArray(value)) return;
		pins = value.slice(0, MAX_PINS).filter((pin) => pin && typeof pin.id === "string" && pin.id.length <= 32 && typeof pin.selector === "string" && pin.selector.length <= MAX_SELECTOR)
			.map((pin) => ({ id: pin.id, selector: pin.selector }));
		// An empty list still answers, so the canvas learns there is nothing to pin.
		reportQueued = true;
		requestAnimationFrame(reportPins);
	}

	function highlight(id) {
		const pin = pins.find((candidate) => candidate.id === id);
		const element = pin ? find(pin.selector) : null;
		if (!element) return;
		ensureBoxes();
		selected = element;
		element.scrollIntoView({ block: "nearest", inline: "nearest" });
		refresh();
	}

	window.addEventListener("message", (event) => {
		if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
		if (event.data.type === "gd:mode") setEnabled(event.data.enabled === true);
		else if (event.data.type === "gd:pins") setPins(event.data.pins);
		else if (event.data.type === "gd:highlight") highlight(event.data.id);
		else if (event.data.type === "gd:focus") focused = event.data.enabled === true;
		else if (event.data.type === "gd:pick-at") {
			if (enabled) pick(elementAt(event.data));
		} else if (event.data.type === "gd:hover-at") {
			if (!enabled) return;
			hovered = elementAt(event.data);
			refresh();
		} else if (event.data.type === "gd:clear") {
			selected = null;
			refresh();
		}
	});

	function pick(element) {
		if (!element) return;
		selected = element;
		refresh();
		const rect = element.getBoundingClientRect();
		post({
			type: "gd:pick",
			selector: cssSelector(element),
			excerpt: excerptOf(element),
			rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
		});
	}

	window.addEventListener("pointerover", (event) => {
		if (!enabled) return;
		hovered = targetOf(event);
		refresh();
	}, true);

	window.addEventListener("click", (event) => {
		if (!enabled) return;
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		pick(targetOf(event));
	}, true);

	// While commenting, the artboard's own handlers, links and forms stay inert.
	for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick", "contextmenu", "submit"]) {
		window.addEventListener(type, (event) => {
			if (!enabled) return;
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
		}, true);
	}

	// Shift+Esc is reserved for leaving focus mode, even while typing; plain Esc stays with the design.
	// The canvas accepts the request only from the focused artboard.
	window.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (event.shiftKey) {
			event.preventDefault();
			event.stopImmediatePropagation();
			post({ type: "gd:exit-focus" });
		} else if (enabled) post({ type: "gd:escape" });
	}, true);

	function scrollableBy(element, dx, dy) {
		if (!element) return false;
		const root = element === document.scrollingElement;
		const style = getComputedStyle(element);
		const scrolls = (overflow) => root ? overflow !== "hidden" && overflow !== "clip" : overflow === "auto" || overflow === "scroll";
		if (dy !== 0 && scrolls(style.overflowY) && (dy > 0 ? element.scrollTop + element.clientHeight < element.scrollHeight - 1 : element.scrollTop > 0)) return true;
		if (dx !== 0 && scrolls(style.overflowX) && (dx > 0 ? element.scrollLeft + element.clientWidth < element.scrollWidth - 1 : element.scrollLeft > 0)) return true;
		return false;
	}

	function canScroll(node, dx, dy) {
		for (let element = node instanceof Element ? node : null; element; element = element.parentElement) {
			if (element !== document.scrollingElement && scrollableBy(element, dx, dy)) return true;
		}
		return scrollableBy(document.scrollingElement, dx, dy);
	}

	// Ctrl/Cmd + wheel (and trackpad pinch) always zooms the canvas; a plain wheel
	// pans the canvas only when the artboard itself cannot scroll that way.
	// In focus mode the canvas stays put: the artboard scrolls natively, and
	// Ctrl/Cmd + wheel is swallowed so it never zooms the browser page.
	window.addEventListener("wheel", (event) => {
		const zoom = event.ctrlKey || event.metaKey;
		if (focused) {
			if (zoom) event.preventDefault();
			return;
		}
		if (!zoom && canScroll(event.target, event.deltaX, event.deltaY)) return;
		event.preventDefault();
		post({ type: "gd:wheel", deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, zoom, shift: event.shiftKey, x: event.clientX, y: event.clientY });
	}, { passive: false, capture: true });

	window.addEventListener("scroll", () => { refresh(); queueReport(); }, true);
	window.addEventListener("resize", () => { refresh(); queueReport(); });
	window.addEventListener("load", queueReport);
	// Layout changes (late images, artboard scripts) move pinned elements; the inspector's own boxes do not count.
	new MutationObserver((records) => {
		if (records.some((record) => !(record.target instanceof Element && record.target.hasAttribute(MARK)))) queueReport();
	}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
})();
