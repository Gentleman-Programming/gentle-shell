// Gentle Design artboard inspector, injected by the canvas server into every
// artboard. In comment mode it highlights the hovered element and reports the
// clicked one to the canvas; otherwise it only forwards canvas zoom and pan.
// It also reports where each commented element is, so the canvas can pin it,
// and whether the page is wider than its frame (the canvas's Overflows chip).
// The canvas numbers each size it gives the frame (gd:size): every pick carries
// the number the page heard last, so a pick made before a resize is known stale.
// In navigation mode the canvas covers the artboard with a shield and routes
// comment-mode hovers and clicks here as points; in focus mode the artboard
// owns the wheel and the keyboard, and Shift+Esc asks the canvas to leave.
// In comment mode with Technical details on (gd:mode `inspect`) it also measures the element under
// the pointer (gd:inspect), once per element and again after a scroll, a late load or a page change (at most
// once per animation frame): the canvas's token inspector compares those computed values with the project's design
// tokens (canvas-tokens.js). With Technical details off it measures nothing.
// When the canvas asks (gd:run-checks: only the artboard's own frame, never a size frame or the system
// board) it runs a few accessibility checks once the page settles after load and after each resize
// (gd:checks): text contrast, target size, images without alt, unlabeled form fields and skipped heading
// levels. They are heuristics, not an audit; a finding whose element is out of sight says so (`hidden`).
// A highlight with `locate` (Show of a check) answers gd:located with where the element is once scrolled into
// view, and again after a scroll (at most once per animation frame) while it stays the selected element,
// until gd:clear or another highlight: the canvas keeps its ring on the element as the page scrolls.
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
	// The frame's size generation, as the canvas last said it (gd:size); 0 until it does.
	let generation = 0;
	let hovered = null;
	let selected = null;
	// The element last reported with gd:inspect (null: none), whether the canvas wants those reports
	// (Technical details on), and whether a re-measure after a scroll waits for the next frame.
	let inspected = null;
	let inspecting = false;
	let inspectQueued = false;
	// Whether the canvas asked this frame for the accessibility checks, the pending run and the last result posted.
	let checking = false;
	let checksTimer = 0;
	let lastChecks = "";
	// The element whose place the canvas follows ({ selector, element }, from a highlight with `locate`) and
	// whether a report after a scroll waits for the next frame.
	let locating = null;
	let locateQueued = false;

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

	function setHovered(element) {
		hovered = element;
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

	// ---- measuring (the token inspector)

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
	 * composited; the white page when none is opaque; null when an image, a gradient or a color it
	 * cannot read is in the way.
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

	/** `top` composited over `under`, either of them translucent (alpha kept, channels not premultiplied), rounded to whole channels. */
	function overLayer(top, under) {
		const a = top.a + under.a * (1 - top.a);
		if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
		const mix = (t, u) => Math.round((t * top.a + u * under.a * (1 - top.a)) / a);
		return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a };
	}

	/** Whether the element or an ancestor has an opacity under 1. */
	function fadedUp(element) {
		for (let node = element; node; node = node.parentElement) {
			const own = Number.parseFloat(getComputedStyle(node).opacity);
			if (Number.isFinite(own) && own < 1) return true;
		}
		return false;
	}

	/**
	 * The element's text `color` and the background next to it as finally seen: each element from it up to the page draws
	 * its background under what it holds, and its opacity fades all of that (text and background together) over what lies
	 * behind it; the white page under everything. Null when the text is not drawn at all (an opacity of 0, a transparent
	 * color), or when an image, a gradient or a color it cannot read shows through. With no opacity under 1 on the
	 * way, the colors are worked out as they always were (backgroundOf, then the text over it), so their rounding
	 * and the reported hex values stay the same.
	 */
	function seenColorsOf(element, color) {
		if (!fadedUp(element)) {
			const behind = backgroundOf(element);
			if (!behind || color.a <= 0) return null;
			return { foreground: color.a < 1 ? over(color, behind) : { r: color.r, g: color.g, b: color.b }, background: behind };
		}
		let text = color;
		let beside = { r: 0, g: 0, b: 0, a: 0 };
		let drawn = color.a;
		for (let node = element; node; node = node.parentElement) {
			const style = getComputedStyle(node);
			// Under an opaque layer a background does not show, until an opacity above fades the layer over it.
			const covered = text.a >= 1 && beside.a >= 1;
			if (!covered) {
				if (style.backgroundImage && style.backgroundImage !== "none") return null;
				const fill = parseColor(style.backgroundColor);
				if (fill === null && style.backgroundColor && style.backgroundColor !== "transparent") return null;
				if (fill && fill.a > 0) {
					text = overLayer(text, fill);
					beside = overLayer(beside, fill);
				}
			}
			const own = Number.parseFloat(style.opacity);
			if (Number.isFinite(own) && own < 1) {
				const fade = Math.max(own, 0);
				drawn *= fade;
				text = { ...text, a: text.a * fade };
				beside = { ...beside, a: beside.a * fade };
			}
		}
		if (drawn <= 0) return null;
		const page = { r: 255, g: 255, b: 255, a: 1 };
		const seen = (layer) => {
			const { r, g, b } = overLayer(layer, page);
			return { r, g, b };
		};
		return { foreground: seen(text), background: seen(beside) };
	}

	/** CSS px of a computed length; a percentage (a radius) of `basis`. */
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

	/** The element's own text, not its children's. */
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
			// The page's root font size, so the canvas converts rem tokens in this page's px (16, the browser default, when unreadable).
			rootFontSize: px(getComputedStyle(document.documentElement).fontSize, 0) || 16,
		};
	}

	/**
	 * Tells the canvas which element is under the pointer, once per element (`force`: again, it moved); null when none
	 * or not commenting. With Technical details off nothing is measured, and the element counts as not reported yet, so
	 * turning it on reports the hovered one at once.
	 */
	function reportInspect(force) {
		if (!inspecting) {
			inspected = null;
			return;
		}
		const element = enabled ? hovered : null;
		if (!force && element === inspected) return;
		inspected = element;
		// Tagged like a pick: a measurement made before the page heard of the frame's latest size is refused by the canvas.
		post({ type: "gd:inspect", element: element ? measure(element) : null, generation });
	}

	/** Scrolling, a late load or a page change moves or resizes the hovered element: measure it again on the next frame, however many came. */
	function queueInspect() {
		if (inspectQueued) return;
		inspectQueued = true;
		requestAnimationFrame(() => {
			inspectQueued = false;
			if (enabled && hovered) reportInspect(true);
		});
	}

	// ---- accessibility checks (gd:checks)

	const CHECKS = [["contrast", "Text contrast"], ["target", "Target size"], ["alt", "Images have alt text"], ["label", "Form fields have labels"], ["heading", "Headings in order"]];
	const MAX_FAILURES = 20;
	const MAX_ADVICE = 10;
	const MAX_SCAN = 3000;
	const MIN_TARGET = 24;
	const ADVISED_TARGET = 44;
	// How long the page settles before a run: after load (late images, fonts, scripts) and after a resize.
	const LOAD_DELAY = 250;
	const RESIZE_DELAY = 400;
	const SKIPPED = new Set(["html", "head", "meta", "link", "script", "style", "noscript", "template", "title", "base"]);
	const UNLABELED_INPUTS = new Set(["hidden", "submit", "button", "reset", "image"]);
	const LABEL_HINT = "Add a <label for>, aria-label or aria-labelledby; a placeholder is not a label.";

	function linear(value) {
		const unit = value / 255;
		return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	}

	function luminance(color) {
		return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
	}

	/** WCAG contrast ratio, and the same to two decimals, never rounded up (4.499 must not read as a pass). */
	function contrastOf(a, b) {
		const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		const ratio = (high + 0.05) / (low + 0.05);
		return { ratio, text: String(Math.floor(ratio * 100) / 100) };
	}

	const hexOf = (color) => `#${[color.r, color.g, color.b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
	const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
	const squeeze = (text) => String(text || "").replace(/\s+/g, " ").trim();

	/** Drawn on the page: not display:none or hidden, not fully transparent, with a box. */
	function isShown(element, style) {
		if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number.parseFloat(style.opacity) === 0) return false;
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	}

	/**
	 * Out of sight though it is on the page: about no size, cut away by a clip or by an ancestor that clips, or outside the
	 * page where no scroll reaches it (a skip link before it gets focus). Below the fold is not out of sight: it scrolls into view.
	 */
	function isOutOfSight(element) {
		const rect = element.getBoundingClientRect();
		if (rect.width < 2 || rect.height < 2) return true;
		const style = getComputedStyle(element);
		const box = /^rect\(([^)]*)\)$/.exec(String(style.clip || "").trim());
		if (box) {
			const [top, right, bottom, left] = box[1].split(/[\s,]+/).map((value) => Number.parseFloat(value));
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
			const edge = node.getBoundingClientRect();
			if (rect.left >= edge.left + edge.width || rect.left + rect.width <= edge.left || rect.top >= edge.top + edge.height || rect.top + rect.height <= edge.top) return true;
		}
		return false;
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

	/** A target's name: its aria-label, own text, value, title or alt; "" when it has none. */
	function nameOf(element) {
		return clip(squeeze(element.getAttribute("aria-label") || ownText(element) || element.getAttribute("value") || element.getAttribute("title") || element.getAttribute("alt")), 40);
	}

	/** A name for a target: its name, quoted; else its tag and id or class. */
	function subjectOf(element) {
		const name = nameOf(element);
		return name ? `"${name}"` : labelOf(element);
	}

	/** `label`: the ids a <label for> with text names, read once per run. */
	function hasAccessibleLabel(element, labelled) {
		if (squeeze(element.getAttribute("aria-label")) || squeeze(element.getAttribute("title"))) return true;
		const named = (id) => {
			const target = document.getElementById(id);
			return Boolean(target && (squeeze(target.textContent) || squeeze(target.getAttribute("aria-label"))));
		};
		if ((element.getAttribute("aria-labelledby") || "").split(/\s+/).some((id) => id && named(id))) return true;
		if (element.id && labelled().has(element.id)) return true;
		for (let node = element.parentElement; node; node = node.parentElement) if (node.localName === "label" && squeeze(node.textContent)) return true;
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

	/**
	 * Runs the checks over the page's first MAX_SCAN elements. The counts cover all of those; each list keeps the first
	 * MAX_FAILURES problems and MAX_ADVICE advice items, and only those are described (selector, text, box, whether out of sight).
	 */
	function collectChecks() {
		const everything = Array.from(document.querySelectorAll("*")).filter((element) => element instanceof Element && !isOwn(element) && !SKIPPED.has(element.localName)).slice(0, MAX_SCAN);
		const found = Object.fromEntries(CHECKS.map(([id]) => [id, { count: 0, advice: 0, failures: [], advised: [] }]));
		// key and vars name the finding for the canvas, which shows it in its own language (canvas-checks.js findings); the
		// English title and detail go with them, for the agent and for a canvas that cannot read them.
		const add = (check, severity, key, vars, title, detail, element) => {
			const entry = found[check];
			const fail = severity === "fail";
			const list = fail ? entry.failures : entry.advised;
			if (fail) entry.count += 1;
			else entry.advice += 1;
			if (list.length >= (fail ? MAX_FAILURES : MAX_ADVICE)) return;
			const rect = element.getBoundingClientRect();
			const issue = { check, severity, title, detail, selector: cssSelector(element), label: labelOf(element), excerpt: excerptOf(element), rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, key, vars };
			// Only a finding out of sight carries `hidden`, so the canvas draws no ring for it.
			if (isOutOfSight(element)) issue.hidden = true;
			list.push(issue);
		};
		let labelledIds = null;
		const labelled = () => {
			labelledIds ??= new Set(everything.filter((node) => node.localName === "label" && node.getAttribute("for") && squeeze(node.textContent)).map((node) => node.getAttribute("for")));
			return labelledIds;
		};
		let previousHeading = 0;
		for (const element of everything) {
			const style = getComputedStyle(element);
			const shown = isShown(element, style);
			const tag = element.localName;
			const text = shown ? ownText(element) : "";

			if (text && !element.hasAttribute("disabled")) {
				const color = parseColor(style.color);
				const seen = color ? seenColorsOf(element, color) : null;
				if (seen) {
					const { foreground, background: behind } = seen;
					const { ratio, text: shownRatio } = contrastOf(foreground, behind);
					const size = px(style.fontSize, 0);
					const large = size >= 24 || (size >= 18.66 && weightOf(style.fontWeight) >= 700);
					const needed = large ? 3 : 4.5;
					const vars = { text: clip(text, 40), ratio: shownRatio, foreground: hexOf(foreground), background: hexOf(behind), needed };
					if (ratio < needed) add("contrast", "fail", large ? "contrastLarge" : "contrast", vars, "Low contrast", `"${vars.text}" is ${shownRatio} : 1 (${vars.foreground} on ${vars.background}); WCAG AA needs ${needed} : 1${large ? " for large text" : ""}.`, element);
				}
			}

			if (shown && isInteractive(element) && !(tag === "a" && style.display === "inline")) {
				const rect = element.getBoundingClientRect();
				const width = Math.round(rect.width);
				const height = Math.round(rect.height);
				// Advice, never a problem: WCAG 2.2 accepts a smaller target with enough space around it, which this cannot measure.
				const subject = { name: nameOf(element), element: labelOf(element), width, height };
				if (width < MIN_TARGET || height < MIN_TARGET) add("target", "advice", "targetSmall", { ...subject, min: MIN_TARGET }, "Small touch target", `${subjectOf(element)} is ${width} × ${height} px; WCAG 2.2 asks for ${MIN_TARGET} × ${MIN_TARGET} px, or enough space around it that a ${MIN_TARGET} px circle on it touches no other target.`, element);
				else if (width < ADVISED_TARGET || height < ADVISED_TARGET) add("target", "advice", "targetAdvised", { ...subject, advised: ADVISED_TARGET }, "Touch target under 44 px", `${subjectOf(element)} is ${width} × ${height} px; ${ADVISED_TARGET} × ${ADVISED_TARGET} px is recommended for touch.`, element);
			}

			const type = (element.getAttribute("type") || "").toLowerCase();
			const role = element.getAttribute("role");
			// Not rendered (display: none on it or an ancestor): no box at all. A rendered image not loaded yet has one, even 0 × 0.
			if ((tag === "img" || (tag === "input" && type === "image")) && element.getClientRects().length > 0 && !element.hasAttribute("alt") && role !== "presentation" && role !== "none" && element.getAttribute("aria-hidden") !== "true") {
				const source = (element.getAttribute("src") || "").split(/[?#]/)[0].split("/").pop();
				add("alt", "fail", "alt", { source: source ? clip(source, 60) : "" }, "Image without alt text", `${source ? clip(source, 60) : "The image"} has no alt attribute. Describe it, or use alt="" if it is decorative.`, element);
			}

			if (shown && (tag === "select" || tag === "textarea" || (tag === "input" && !UNLABELED_INPUTS.has(type))) && !hasAccessibleLabel(element, labelled)) {
				const hint = squeeze(element.getAttribute("placeholder"));
				const field = tag === "input" ? "input" : tag;
				add("label", "fail", "label", { field, type: field === "input" ? (type || "text") : "", hint: hint ? clip(hint, 40) : "" }, "Form field without a label", `The ${fieldKind(element)}${hint ? ` "${clip(hint, 40)}"` : ""} has no label. ${LABEL_HINT}`, element);
			}

			const level = shown ? headingLevel(element) : 0;
			if (level > 0) {
				if (previousHeading > 0 && level > previousHeading + 1) {
					const missing = Array.from({ length: level - previousHeading - 1 }, (_, index) => `h${previousHeading + 1 + index}`);
					const vars = { level, previous: previousHeading, text: clip(squeeze(element.textContent), 40), missing: missing.join(", "), count: missing.length };
					add("heading", "fail", "heading", vars, "Heading level skipped", `h${level} "${vars.text}" follows h${previousHeading}: ${vars.missing} ${missing.length === 1 ? "is" : "are"} missing.`, element);
				}
				previousHeading = level;
			}
		}
		const issues = [];
		const checks = CHECKS.map(([id, label]) => {
			const entry = found[id];
			issues.push(...entry.failures, ...entry.advised);
			return { id, label, count: entry.count, advice: entry.advice };
		});
		// Tagged like a pick: a scan made before the page heard of the frame's latest size describes a size it no longer has.
		return { type: "gd:checks", checks, issues, generation };
	}

	/** Posts the result when it differs from the last one posted. */
	function runChecks() {
		checksTimer = 0;
		const result = collectChecks();
		const key = JSON.stringify(result);
		if (key === lastChecks) return;
		lastChecks = key;
		post(result);
	}

	/** One run, once the page has settled for `delay` ms: a newer request replaces a pending one. */
	function scheduleChecks(delay) {
		clearTimeout(checksTimer);
		checksTimer = setTimeout(runChecks, delay);
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

	/**
	 * The element of a comment pin (`id`), of a part (`selector`, canvas-parts.js Show) or of a check (`selector` with
	 * `locate`, canvas-checks.js Show: then where it is once in view, and after each scroll). Any highlight ends the last follow.
	 */
	function highlight(data) {
		locating = null;
		let element = null;
		if (typeof data.selector === "string") element = data.selector.length <= MAX_SELECTOR ? find(data.selector) : null;
		else {
			const pin = pins.find((candidate) => candidate.id === data.id);
			element = pin ? find(pin.selector) : null;
		}
		if (!element) return;
		ensureBoxes();
		selected = element;
		const locate = data.locate === true && typeof data.selector === "string";
		// The place is read right after the scroll, so a page with smooth scrolling jumps there at once.
		element.scrollIntoView(locate ? { block: "nearest", inline: "nearest", behavior: "instant" } : { block: "nearest", inline: "nearest" });
		refresh();
		if (!locate) return;
		locating = { selector: data.selector, element };
		reportLocated();
	}

	/** Where the followed element is now; nothing once it is no longer the selected one (a pick, gd:clear, leaving Comment mode). */
	function reportLocated() {
		locateQueued = false;
		if (!locating || selected !== locating.element) {
			locating = null;
			return;
		}
		const rect = locating.element.getBoundingClientRect();
		post({ type: "gd:located", selector: locating.selector, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } });
	}

	/** Scrolling moves the followed element: one report on the next frame, however many scroll events came. */
	function queueLocate() {
		if (locateQueued || !locating) return;
		locateQueued = true;
		requestAnimationFrame(reportLocated);
	}

	window.addEventListener("message", (event) => {
		if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
		if (event.data.type === "gd:mode") {
			inspecting = event.data.inspect === true;
			setEnabled(event.data.enabled === true);
		}
		else if (event.data.type === "gd:pins") setPins(event.data.pins);
		else if (event.data.type === "gd:highlight") highlight(event.data);
		else if (event.data.type === "gd:run-checks") {
			// The canvas asks once per page load; resizes keep the result current from then on.
			checking = true;
			scheduleChecks(LOAD_DELAY);
		}
		else if (event.data.type === "gd:focus") focused = event.data.enabled === true;
		else if (event.data.type === "gd:size") {
			if (Number.isInteger(event.data.generation) && event.data.generation >= 0) generation = event.data.generation;
			// The canvas dropped what this page reported (it loaded, or the frame changed size): say it again, even unchanged.
			lastOverflow = "";
			queueOverflow();
		}
		else if (event.data.type === "gd:pick-at") {
			if (enabled) pick(elementAt(event.data));
		} else if (event.data.type === "gd:hover-at") {
			if (!enabled) return;
			setHovered(elementAt(event.data));
		} else if (event.data.type === "gd:clear") {
			selected = null;
			locating = null;
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
			generation,
		});
	}

	window.addEventListener("pointerover", (event) => {
		if (!enabled) return;
		setHovered(targetOf(event));
	}, true);

	// Leaving the page altogether (the pointer goes out of the frame) ends the hover.
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

	window.addEventListener("scroll", () => { refresh(); queueReport(); if (enabled && hovered && inspecting) queueInspect(); if (locating) queueLocate(); }, true);
	window.addEventListener("resize", () => { refresh(); queueReport(); queueOverflow(); if (checking) scheduleChecks(RESIZE_DELAY); });
	window.addEventListener("load", () => { queueReport(); queueOverflow(); });
	// An image that loads after the page did can widen it with no mutation or resize; its load does not bubble, so the
	// document catches it on the way down. It can also resize the hovered element: measure it again.
	document.addEventListener("load", () => { refresh(); queueReport(); queueOverflow(); if (enabled && hovered && inspecting) queueInspect(); }, true);
	// A web font that loads late can widen the page the same way, with no mutation, resize or load event, and resize the
	// hovered element: measure it again.
	document.fonts?.addEventListener("loadingdone", () => { refresh(); queueReport(); queueOverflow(); if (enabled && hovered && inspecting) queueInspect(); });
	// Layout changes (late images, artboard scripts) move pinned elements, may widen the page and resize the hovered
	// element; the inspector's own boxes do not count (refresh moves them, so it cannot loop).
	new MutationObserver((records) => {
		if (records.some((record) => !(record.target instanceof Element && record.target.hasAttribute(MARK)))) { refresh(); queueReport(); queueOverflow(); if (enabled && hovered && inspecting) queueInspect(); }
	}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
})();
