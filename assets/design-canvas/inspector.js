// Gentle Design artboard inspector, injected by the canvas server into every
// artboard. In comment mode it highlights the hovered element and reports the
// clicked one to the canvas; otherwise it only forwards canvas zoom and pan.
// It also reports where each commented element is, so the canvas can pin it.
// In navigation mode the canvas covers the artboard with a shield, and a click opens focus mode
// (in Comment mode too), so picks happen at full size; gd:hover-at and gd:pick-at still take a
// point routed from the canvas. In focus mode the artboard
// owns the wheel and the keyboard, and Shift+Esc asks the canvas to leave.
// It also says whether the page is wider than its frame (gd:overflow), so the canvas can flag
// a size at which content is cut off or needs sideways scrolling.
// In Comment mode it also measures the element under the pointer (gd:inspect): the canvas compares
// those values with the project's design tokens and shows them next to the artboard.
// After the page loads it also runs a few accessibility checks (gd:checks): text contrast, target size,
// images without alt, unlabeled form fields and skipped heading levels. They are heuristics, not an audit.
// A finding whose element is out of sight (hidden or off-screen) says so, so the canvas draws no mark for it.
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
	let overflowQueued = false;
	let lastOverflow = "";
	let hovered = null;
	let selected = null;
	// The element last measured for the canvas, so a pointer moving inside it is not reported again.
	let inspected = null;
	let checksTimer = 0;
	let lastChecks = "";

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
		reportInspect(false);
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

	// ---- measuring (token inspector) ----

	const MAX_FAMILY = 300;
	const MAX_LABEL = 80;

	/** `rgb()`/`rgba()` as a browser reports a computed color (comma or space syntax), else null. */
	function parseColor(text) {
		if (typeof text !== "string") return null;
		const match = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(text.trim());
		if (!match) return null;
		const alpha = match[4] === undefined ? 1 : Number(match[4]) / (match[5] ? 100 : 1);
		const color = { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
		return [color.r, color.g, color.b].every((channel) => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1 ? color : null;
	}

	/** `top` composited over the opaque `under`, rounded to whole channels. */
	function over(top, under) {
		const mix = (a, b) => Math.round(a * top.a + b * (1 - top.a));
		return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b) };
	}

	/**
	 * The color behind an element: its own and its ancestors' backgrounds up to the first opaque one,
	 * composited; the white page when none is opaque; null when an image or gradient is in the way.
	 */
	function backgroundOf(element) {
		const layers = [];
		for (let node = element; node; node = node.parentElement) {
			const style = getComputedStyle(node);
			if (style.backgroundImage && style.backgroundImage !== "none") return null;
			const color = parseColor(style.backgroundColor);
			if (color === null && style.backgroundColor && style.backgroundColor !== "transparent") return null;
			if (color && color.a > 0) {
				layers.push(color);
				if (color.a >= 1) break;
			}
		}
		let base = { r: 255, g: 255, b: 255 };
		for (let index = layers.length - 1; index >= 0; index--) base = layers[index].a >= 1 ? { r: layers[index].r, g: layers[index].g, b: layers[index].b } : over(layers[index], base);
		return base;
	}

	function px(value, basis) {
		if (typeof value !== "string") return 0;
		const number = Number.parseFloat(value);
		if (!Number.isFinite(number)) return 0;
		return value.endsWith("%") ? Math.round(number * basis) / 100 : number;
	}

	function weightOf(value) {
		if (value === "bold") return 700;
		const number = Number.parseFloat(value);
		return Number.isFinite(number) ? number : 400;
	}

	function ownText(element) {
		let text = "";
		for (const node of element.childNodes || []) if (node.nodeType === 3) text += node.textContent;
		return text.replace(/\s+/g, " ").trim();
	}

	function labelOf(element) {
		const id = element.id ? `#${element.id}` : "";
		const className = typeof element.className === "string" ? element.className.trim().split(/\s+/)[0] : "";
		return `${element.localName}${id}${!id && className ? `.${className}` : ""}`.slice(0, MAX_LABEL);
	}

	/** What the canvas needs to compare one element with the design tokens; lengths in CSS px. */
	function measure(element) {
		const style = getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		const basis = Math.min(rect.width, rect.height);
		const sides = (names) => names.map((name) => px(style[name], basis));
		const lineHeight = Number.parseFloat(style.lineHeight);
		const text = ownText(element);
		return {
			selector: cssSelector(element),
			label: labelOf(element),
			text: text.slice(0, MAX_EXCERPT),
			hasText: text.length > 0,
			rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
			color: parseColor(style.color),
			background: backgroundOf(element),
			fontFamily: String(style.fontFamily || "").slice(0, MAX_FAMILY),
			fontSize: px(style.fontSize, 0),
			fontWeight: weightOf(style.fontWeight),
			lineHeight: Number.isFinite(lineHeight) ? lineHeight : null,
			margin: sides(["marginTop", "marginRight", "marginBottom", "marginLeft"]),
			padding: sides(["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]),
			radius: sides(["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"]),
		};
	}

	/** Tells the canvas which element is under the pointer, once per element; null when none (or not commenting). */
	function reportInspect(force) {
		const element = enabled ? hovered : null;
		if (!force && element === inspected) return;
		inspected = element;
		post({ type: "gd:inspect", element: element ? measure(element) : null });
	}

	// ---- accessibility checks ----

	const CHECKS = [["contrast", "Text contrast"], ["target", "Target size"], ["alt", "Images have alt text"], ["label", "Form fields have labels"], ["heading", "Headings in order"]];
	const MAX_FAILURES = 20;
	const MAX_ADVICE = 10;
	const MAX_SCAN = 3000;
	const MIN_TARGET = 24;
	const ADVISED_TARGET = 44;
	const SKIPPED = new Set(["html", "head", "meta", "link", "script", "style", "noscript", "template", "title", "base"]);
	const UNLABELED_INPUTS = new Set(["hidden", "submit", "button", "reset", "image"]);

	function linear(value) {
		const unit = value / 255;
		return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	}

	function luminance(color) {
		return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
	}

	/** WCAG contrast ratio shown to two decimals, never rounded up. */
	function contrastOf(a, b) {
		const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		const ratio = (high + 0.05) / (low + 0.05);
		return { ratio, text: String(Math.floor(ratio * 100) / 100) };
	}

	const hexOf = (color) => `#${[color.r, color.g, color.b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
	const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

	/** Drawn on the page: not display:none or hidden, not fully transparent, with a box. */
	function isShown(element, style) {
		if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number.parseFloat(style.opacity) === 0) return false;
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	}

	function boxOf(element) {
		const rect = element.getBoundingClientRect();
		return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
	}

	function nameOf(element) {
		const text = (element.getAttribute("aria-label") || ownText(element) || element.getAttribute("value") || element.getAttribute("title") || element.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
		return clip(text, 40);
	}

	/**
	 * Out of sight though it is on the page: about no size, cut away by a clip or by an ancestor that clips, or outside the
	 * page where no scroll reaches it (a skip link before it gets focus). Below the fold is not out of sight: it scrolls into view.
	 */
	function isOutOfSight(element) {
		const rect = element.getBoundingClientRect();
		if (rect.width < 2 || rect.height < 2) return true;
		const style = getComputedStyle(element);
		const clip = /^rect\(([^)]*)\)$/.exec(String(style.clip || "").trim());
		if (clip) {
			const [top, right, bottom, left] = clip[1].split(/[\s,]+/).map((value) => Number.parseFloat(value));
			if (bottom <= top || right <= left) return true;
		}
		if (/^inset\(\s*(50|100)%/.test(String(style.clipPath || "").trim())) return true;
		const x = rect.left + (window.scrollX || 0);
		const y = rect.top + (window.scrollY || 0);
		const pageWidth = document.documentElement.scrollWidth;
		if (x + rect.width <= 0 || y + rect.height <= 0 || (Number.isFinite(pageWidth) && x >= pageWidth)) return true;
		for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
			const parent = getComputedStyle(node);
			if (![parent.overflow, parent.overflowX, parent.overflowY].some((value) => value === "hidden" || value === "clip")) continue;
			const box = node.getBoundingClientRect();
			if (rect.left >= box.left + box.width || rect.left + rect.width <= box.left || rect.top >= box.top + box.height || rect.top + rect.height <= box.top) return true;
		}
		return false;
	}

	/** One finding; `hidden: true` only when its element is out of sight, so a visible finding reads as it always did. */
	function issue(check, severity, title, detail, element) {
		const found = { check, severity, title, detail, selector: cssSelector(element), label: labelOf(element), rect: boxOf(element) };
		if (isOutOfSight(element)) found.hidden = true;
		return found;
	}

	function isInteractive(element) {
		const tag = element.localName;
		if (element.hasAttribute("disabled")) return false;
		if (tag === "a") return element.hasAttribute("href");
		if (tag === "button" || tag === "select" || tag === "textarea") return true;
		if (tag === "input") return (element.getAttribute("type") || "").toLowerCase() !== "hidden";
		if (element.getAttribute("role") === "button") return true;
		const tabindex = element.getAttribute("tabindex");
		return tabindex !== null && /^\s*\d+\s*$/.test(tabindex);
	}

	function hasAccessibleLabel(element, everything) {
		if ((element.getAttribute("aria-label") || "").trim()) return true;
		if ((element.getAttribute("title") || "").trim()) return true;
		const named = (id) => {
			const target = document.getElementById(id);
			return Boolean(target && ((target.textContent || "").trim() || (target.getAttribute("aria-label") || "").trim()));
		};
		if ((element.getAttribute("aria-labelledby") || "").split(/\s+/).some((id) => id && named(id))) return true;
		const labels = everything.filter((candidate) => candidate.localName === "label");
		if (element.id && labels.some((label) => label.getAttribute("for") === element.id && (label.textContent || "").trim())) return true;
		for (let node = element.parentElement; node; node = node.parentElement) if (node.localName === "label" && (node.textContent || "").trim()) return true;
		return false;
	}

	function fieldKind(element) {
		if (element.localName === "select") return "select";
		if (element.localName === "textarea") return "text area";
		return `${(element.getAttribute("type") || "text").toLowerCase()} field`;
	}

	function headingLevel(element) {
		const match = /^h([1-6])$/.exec(element.localName);
		if (match) return Number(match[1]);
		if (element.getAttribute("role") !== "heading") return 0;
		const level = Number.parseInt(element.getAttribute("aria-level"), 10);
		return level >= 1 && level <= 6 ? level : 2;
	}

	/** Runs the checks over the page; counts are complete, the lists are capped. */
	function collectChecks() {
		const everything = Array.from(document.querySelectorAll("*")).filter((element) => element instanceof Element && !isOwn(element) && !SKIPPED.has(element.localName)).slice(0, MAX_SCAN);
		const found = { contrast: [], target: [], alt: [], label: [], heading: [] };
		let previousHeading = 0;
		for (const element of everything) {
			const style = getComputedStyle(element);
			const shown = isShown(element, style);
			const text = ownText(element);

			if (shown && text && !element.hasAttribute("disabled")) {
				const color = parseColor(style.color);
				const behind = backgroundOf(element);
				if (color && behind) {
					const foreground = color.a < 1 ? over(color, behind) : color;
					const { ratio, text: shownRatio } = contrastOf(foreground, behind);
					const size = px(style.fontSize, 0);
					const large = size >= 24 || (size >= 18.66 && weightOf(style.fontWeight) >= 700);
					const needed = large ? 3 : 4.5;
					if (ratio < needed) found.contrast.push(issue("contrast", "fail", "Low contrast", `"${clip(text, 40)}" is ${shownRatio} : 1 (${hexOf(foreground)} on ${hexOf(behind)}); WCAG AA needs ${needed} : 1${large ? " for large text" : ""}.`, element));
				}
			}

			if (shown && isInteractive(element) && !(element.localName === "a" && style.display === "inline")) {
				const rect = element.getBoundingClientRect();
				const width = Math.round(rect.width);
				const height = Math.round(rect.height);
				const name = nameOf(element);
				const subject = name ? `"${name}"` : labelOf(element);
				if (width < MIN_TARGET || height < MIN_TARGET) found.target.push(issue("target", "fail", "Small touch target", `${subject} is ${width} × ${height} px; WCAG 2.2 needs at least ${MIN_TARGET} × ${MIN_TARGET} px.`, element));
				else if (width < ADVISED_TARGET || height < ADVISED_TARGET) found.target.push(issue("target", "advice", "Touch target under 44 px", `${subject} is ${width} × ${height} px; ${ADVISED_TARGET} × ${ADVISED_TARGET} px is recommended for touch.`, element));
			}

			const tag = element.localName;
			const type = (element.getAttribute("type") || "").toLowerCase();
			const role = element.getAttribute("role");
			if ((tag === "img" || (tag === "input" && type === "image")) && style.display !== "none" && !element.hasAttribute("alt") && role !== "presentation" && role !== "none" && element.getAttribute("aria-hidden") !== "true") {
				const source = (element.getAttribute("src") || "").split(/[?#]/)[0].split("/").pop();
				found.alt.push(issue("alt", "fail", "Image without alt text", `${source ? clip(source, 60) : "The image"} has no alt attribute. Describe it, or use alt="" if it is decorative.`, element));
			}

			if (shown && (tag === "select" || tag === "textarea" || (tag === "input" && !UNLABELED_INPUTS.has(type))) && !hasAccessibleLabel(element, everything)) {
				const hint = (element.getAttribute("placeholder") || "").trim();
				found.label.push(issue("label", "fail", "Form field without a label", `The ${fieldKind(element)}${hint ? ` "${clip(hint, 40)}"` : ""} has no label. Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label.`, element));
			}

			const level = shown ? headingLevel(element) : 0;
			if (level > 0) {
				if (previousHeading > 0 && level > previousHeading + 1) {
					const missing = Array.from({ length: level - previousHeading - 1 }, (_, index) => `h${previousHeading + 1 + index}`);
					found.heading.push(issue("heading", "fail", "Heading level skipped", `h${level} "${clip((element.textContent || "").replace(/\s+/g, " ").trim(), 40)}" follows h${previousHeading}: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing.`, element));
				}
				previousHeading = level;
			}
		}
		const issues = [];
		const checks = CHECKS.map(([id, label]) => {
			const list = found[id];
			const failures = list.filter((entry) => entry.severity === "fail");
			const advice = list.filter((entry) => entry.severity === "advice");
			issues.push(...failures.slice(0, MAX_FAILURES), ...advice.slice(0, MAX_ADVICE));
			return { id, label, count: failures.length, advice: advice.length };
		});
		return { type: "gd:checks", checks, issues };
	}

	function runChecks() {
		checksTimer = 0;
		const result = collectChecks();
		const key = JSON.stringify(result);
		if (key === lastChecks) return;
		lastChecks = key;
		post(result);
	}

	/** Checks wait a moment after load or resize so late images, fonts and scripts are in place. */
	function scheduleChecks(delay) {
		clearTimeout(checksTimer);
		checksTimer = setTimeout(runChecks, delay);
	}

	function setHovered(element) {
		hovered = element;
		refresh();
		reportInspect(false);
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

	/** Whether the page is wider than this frame; said once per change of width, scroll width or answer. */
	function reportOverflow() {
		overflowQueued = false;
		const root = document.documentElement;
		const width = window.innerWidth;
		const scrollWidth = root.scrollWidth;
		const overflow = scrollWidth > root.clientWidth;
		const key = `${overflow}/${width}/${scrollWidth}`;
		if (key === lastOverflow) return;
		lastOverflow = key;
		post({ type: "gd:overflow", overflow, width, scrollWidth });
	}

	function queueOverflow() {
		if (overflowQueued) return;
		overflowQueued = true;
		requestAnimationFrame(reportOverflow);
	}

	function setPins(value) {
		if (!Array.isArray(value)) return;
		pins = value.slice(0, MAX_PINS).filter((pin) => pin && typeof pin.id === "string" && pin.id.length <= 32 && typeof pin.selector === "string" && pin.selector.length <= MAX_SELECTOR)
			.map((pin) => ({ id: pin.id, selector: pin.selector }));
		// An empty list still answers, so the canvas learns there is nothing to pin.
		reportQueued = true;
		requestAnimationFrame(reportPins);
	}

	/** The element of a comment pin (`id`) or of a check result (`selector`). */
	function highlight(data) {
		let element = null;
		if (typeof data.selector === "string") element = data.selector.length <= MAX_SELECTOR ? find(data.selector) : null;
		else {
			const pin = pins.find((candidate) => candidate.id === data.id);
			element = pin ? find(pin.selector) : null;
		}
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
		else if (event.data.type === "gd:highlight") highlight(event.data);
		else if (event.data.type === "gd:focus") focused = event.data.enabled === true;
		else if (event.data.type === "gd:pick-at") {
			if (enabled) pick(elementAt(event.data));
		} else if (event.data.type === "gd:hover-at") {
			if (!enabled) return;
			setHovered(elementAt(event.data));
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
		setHovered(targetOf(event));
	}, true);

	// Leaving the page altogether (the pointer goes out of the frame) is the end of the hover.
	window.addEventListener("pointerout", (event) => {
		if (enabled && !event.relatedTarget) setHovered(null);
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

	window.addEventListener("scroll", () => { refresh(); queueReport(); if (enabled && hovered) reportInspect(true); }, true);
	window.addEventListener("resize", () => { refresh(); queueReport(); queueOverflow(); scheduleChecks(400); });
	window.addEventListener("load", () => { queueReport(); queueOverflow(); scheduleChecks(250); });
	// Layout changes (late images, artboard scripts) move pinned elements; the inspector's own boxes do not count.
	new MutationObserver((records) => {
		if (records.some((record) => !(record.target instanceof Element && record.target.hasAttribute(MARK)))) { queueReport(); queueOverflow(); }
	}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
})();
