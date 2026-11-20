// The token inspector. With Technical details on (a checkbox in the rail's Settings, off by
// default, saved in this browser), Comment mode shows a panel beside the frame of the element
// under the pointer: inspector.js measures it (gd:inspect) and this module compares its computed
// color, background, font, sizes, spacing and radius with the tokens of design/system.md, computes
// the WCAG contrast, and offers Ask the agent to fix (the comment box, prefilled) and Copy.
// While a panel shows, it follows another element only once the pointer rests on it (hover intent),
// so the pointer can cross the artboard to the panel's buttons; Esc in the panel closes it.
// These are heuristics: a background image or gradient leaves the background unknown, and the
// match uses computed values, not the CSS that produced them.
// The tokens and Technical details live in the store (setTokens, setTechnical); the element the
// panel shows, the one it may switch to, its timers and whether the pointer is on it are this
// module's own view state. The panel's words follow the canvas language (canvas-i18n-es.js); what Ask the agent
// to fix prefills (TEXT.session) stays English, since it is an instruction for the session.

const TEXT = Object.freeze({
	labels: { color: "Color", background: "Background", contrast: "Contrast", font: "Font", size: "Size", lineHeight: "Line height", spacing: "Spacing", radius: "Radius" },
	unreadable: "unreadable",
	imageBackground: "image or gradient",
	unknownBackground: "unknown background",
	aa: "AA (4.5 : 1)",
	aaLarge: "AA large text (3 : 1)",
	needs: (needed) => `needs ${needed} : 1`,
	needsLarge: (needed) => `needs ${needed} : 1 (large text)`,
	ok: (text) => `✓ ${text}`,
	bad: (text) => `⚠ ${text}`,
	noToken: "no token",
	nearest: (name) => `Nearest ${name}`,
	ratio: (ratio) => `${ratio} : 1`,
	px: (value) => `${value} px`,
	weight: (value) => `weight ${value}`,
	normal: "normal",
	margin: (sides) => `margin ${sides}`,
	padding: (sides) => `padding ${sides}`,
	onScale: "on scale",
	offScale: (value) => `${value} px off scale`,
	radiusNoToken: (value) => `${value} px no token`,
	none: "—",
	noTokens: "No design/system.md tokens found, so values and contrast are shown without a comparison.",
	// Why the server read no tokens from a design/system.md that exists (api/system/tokens `problem`).
	problems: {
		"too-large": "design/system.md is over 256 KB, so its tokens were not read: values and contrast are shown without a comparison.",
		unreadable: "design/system.md could not be read, so values and contrast are shown without a comparison.",
	},
	nothingToFix: "Nothing is off the design system, so there is nothing to fix.",
	copied: "Copied",
	copyFailed: "Could not copy. Use Ask the agent to fix and copy the text from the comment box.",
	// The comment Ask the agent to fix prefills: instructions for the session.
	session: {
		textColor: "Text color",
		background: "Background",
		fontSize: "Font size",
		radius: "Border radius",
		color: (label, hex, near) => `${label} ${hex} is not a token${near ? `; nearest is ${near.name} (${near.value})` : ""}.`,
		length: (label, value, near) => `${label} ${value}px is not a token${near ? `; nearest is ${near.name} (${near.value})` : ""}.`,
		contrast: (ratio, needed, large) => `Contrast ${ratio}:1 is below WCAG AA (${needed}:1 for ${large ? "large" : "normal"} text).`,
		family: (first, names) => `Font family "${first}" is not a token (${names}).`,
		spacing: (value, near) => `Spacing ${value}px is not on the token scale${near ? `; nearest is ${near.name} (${near.value})` : ""}.`,
		fix: (selector, flags) => `Fix the values on ${selector} that are off the design system (design/system.md):\n${flags.map((flag) => `- ${flag}`).join("\n")}`,
		nothing: (selector) => `Nothing is off the design system on ${selector}.`,
	},
});

// "on" while Technical details is on in this browser; anything else (or nothing) is off.
const TECHNICAL_KEY = "gentle-design:technical";
const TOKEN_NAME = /^--[A-Za-z0-9_-]+$/;
const LIMITS = { tokens: 500, selector: 500, excerpt: 300, comment: 2000, label: 80, family: 300 };
// The panel's size before it is laid out, its gap to the frame and the viewport's edges, and how long it
// stays after the element is left (the pointer may be on its way to the buttons).
const INSPECTOR_WIDTH = 280;
const INSPECTOR_HEIGHT = 340;
const INSPECTOR_GAP = 12;
const HIDE_MS = 300;
// While a panel shows, how long the pointer must rest on another element before the panel follows it: quicker
// passes (the pointer crossing the artboard on its way to the panel) keep the element and the place.
const DWELL_MS = 250;
// Channels are whole numbers, so a token matches only when it is the same color; alpha tolerates hex rounding.
const ALPHA_EPSILON = 0.01;
const NEAR_ALPHA = 0.05;
const SIZE_EPSILON = 0.01;
// The root font size a rem token is converted with when a frame reports none (the browser default).
const ROOT_FONT_SIZE = 16;

// ---- comparing values with tokens (pure)

function parseTokenColor(value) {
	const hex = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value.trim());
	if (hex) {
		const digits = hex[1].length <= 4 ? Array.from(hex[1], (digit) => digit + digit).join("") : hex[1];
		const channel = (index) => Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
		return { r: channel(0), g: channel(1), b: channel(2), a: digits.length === 8 ? Math.round((channel(3) / 255) * 100) / 100 : 1 };
	}
	const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value.trim());
	if (rgb && [rgb[1], rgb[2], rgb[3]].every((channel) => Number(channel) <= 255)) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Math.min(1, Number(rgb[4])) };
	return null;
}

/** A token like `8px` or `0.5rem`: its number and whether it is rem (converted per page, with its root font size), else null. */
function parseTokenLength(value) {
	const match = /^(-?\d*\.?\d+)(px|rem)$/.exec(value.trim());
	return match ? { size: Number(match[1]), rem: match[2] === "rem" } : null;
}

/** The tokens by what they can be compared with: colors, font families, and lengths by purpose. Parsed once per load. */
function tokenKinds(tokens) {
	const kinds = { color: [], family: [], radius: [], spacing: [], fontSize: [] };
	for (const token of tokens) {
		const color = parseTokenColor(token.value);
		const length = color ? null : parseTokenLength(token.value);
		if (color) kinds.color.push({ token, color });
		else if (length !== null) {
			if (token.group === "radius" || /radius/.test(token.name)) kinds.radius.push({ token, length });
			else if (token.group === "spacing" || /(^|-)(space|spacing|gap|pad|padding|margin)(-|$)/.test(token.name)) kinds.spacing.push({ token, length });
			else if (token.group === "font" || /font|text|type/.test(token.name)) kinds.fontSize.push({ token, length });
		} else if ((token.group === "font" || /font|family/.test(token.name)) && /[a-zA-Z]/.test(token.value)) kinds.family.push({ token, families: familyList(token.value) });
	}
	return kinds;
}

function linearChannel(value) {
	const unit = value / 255;
	return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB color. */
function luminance(color) {
	return 0.2126 * linearChannel(color.r) + 0.7152 * linearChannel(color.g) + 0.0722 * linearChannel(color.b);
}

/** WCAG contrast ratio, 1 to 21. */
function contrastRatio(a, b) {
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
}

/** OKLab coordinates, so distances follow perceived difference rather than sRGB channel values. */
function oklab(color) {
	const r = linearChannel(color.r);
	const g = linearChannel(color.g);
	const b = linearChannel(color.b);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function colorDistance(a, b) {
	const [x, y] = [oklab(a), oklab(b)];
	return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const hex2 = (value) => Math.round(value).toString(16).padStart(2, "0");
const colorHex = (color) => `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}${color.a !== undefined && color.a < 1 ? hex2(color.a * 255) : ""}`;
const fmt = (value) => String(Number(value.toFixed(2)));
/** Contrast shown to two decimals, never rounded up: 4.499 must not read as a pass. */
const fmtRatio = (ratio) => String(Math.floor(ratio * 100) / 100);
const sides = (values) => values.map(fmt).join(" ");

/** Families of a font stack, quotes stripped, split on commas outside quotes. */
function familyList(value) {
	const families = [];
	let current = "";
	let quote = "";
	for (const char of value) {
		if (quote) {
			if (char === quote) quote = "";
			else current += char;
		} else if (char === "\"" || char === "'") quote = char;
		else if (char === ",") {
			families.push(current);
			current = "";
		} else current += char;
	}
	families.push(current);
	return families.map((family) => family.trim()).filter(Boolean);
}

const sameFamilies = (a, b) => a.length === b.length && a.every((family, index) => family.toLowerCase() === b[index].toLowerCase());

/** A length against the tokens of one kind, rem in px of the page's `root` font size: exact token names, else the nearest by numeric distance. */
function matchLength(px, candidates, root) {
	const sized = candidates.map((candidate) => ({ token: candidate.token, px: candidate.length.size * (candidate.length.rem ? root : 1) }));
	const exact = sized.filter((candidate) => Math.abs(candidate.px - px) < SIZE_EPSILON).map((candidate) => candidate.token);
	if (exact.length > 0) return { exact, nearest: null };
	let nearest = null;
	for (const candidate of sized) if (!nearest || Math.abs(candidate.px - px) < Math.abs(nearest.px - px)) nearest = candidate;
	return { exact: [], nearest: nearest ? nearest.token : null };
}

/** The token nearest `color` by OKLab distance among those of about its opacity, or null. */
function nearestColor(color, candidates) {
	let nearest = null;
	let best = Infinity;
	for (const entry of candidates) {
		if (Math.abs(entry.color.a - (color.a ?? 1)) > NEAR_ALPHA) continue;
		const distance = colorDistance(color, entry.color);
		if (distance < best) {
			best = distance;
			nearest = entry.token;
		}
	}
	return nearest;
}

export function init(ctx) {
	const { win, doc, els, store, api, ui, actions } = ctx;
	const { state } = store;
	const { getJson, isFiniteNumber } = api;
	const T = ctx.i18n.text("tokens", TEXT);

	// The tokens parsed by kind, once per load (never per hover), and the latest load: an older reply landing last changes nothing.
	let kinds = tokenKinds([]);
	let tokenLoads = 0;
	// Why the last read found no tokens in an existing design/system.md ("too-large", "unreadable"), else "".
	let problem = "";
	// The element the panel shows ({ surface, measure, flags, text, copy }) or null; the generation a pending hide
	// belongs to (a newer element or a hide cancels it); the element the panel may switch to ({ surface, measure })
	// or null, and the generation of that pending switch; whether the pointer is on the panel.
	let inspect = null;
	let generation = 0;
	let pending = null;
	let switches = 0;
	let pointerOn = false;

	// ---- tokens and Technical details

	/** The tokens of design/system.md; a read that fails or answers no token list keeps the ones shown (never the status line). */
	async function loadTokens() {
		const load = ++tokenLoads;
		let data = null;
		try { data = await getJson("api/system/tokens"); } catch { data = null; }
		if (load !== tokenLoads || !data || typeof data !== "object" || !Array.isArray(data.tokens)) return;
		const tokens = data.tokens.slice(0, LIMITS.tokens)
			.filter((token) => token && typeof token.name === "string" && TOKEN_NAME.test(token.name) && typeof token.value === "string" && token.value.length > 0)
			.map((token) => ({ name: token.name, value: token.value, section: typeof token.section === "string" ? token.section : "", group: typeof token.group === "string" ? token.group : "other" }));
		store.setTokens(tokens);
		kinds = tokenKinds(state.tokens);
		problem = typeof data.problem === "string" ? data.problem : "";
		// An open panel compares with the new tokens at once, where it is.
		if (inspect) renderInspector(inspect.surface, inspect.measure);
	}

	function storedTechnical() {
		try {
			return win.localStorage.getItem(TECHNICAL_KEY) === "on";
		} catch {
			return false;
		}
	}

	/** Technical details on or off; saved in this browser when it can be (otherwise it holds for this page). */
	function setTechnical(on) {
		store.setTechnical(on);
		try { win.localStorage.setItem(TECHNICAL_KEY, on ? "on" : "off"); } catch { /* storage may be unavailable */ }
		// Every frame, All sizes frames included, measures only while it is on (gd:mode `inspect`).
		actions.allBoards().flatMap(actions.surfacesOf).forEach(actions.sendMode);
		if (!on) hideInspector();
	}

	/** Technical details as saved, and the first tokens read; boot() runs it once every module is ready. */
	function startTokens() {
		store.setTechnical(storedTechnical());
		loadTokens().catch(() => {});
	}

	// ---- the panel's rows

	function chip(className, text) {
		const span = doc.createElement("span");
		span.className = className;
		span.textContent = text;
		return span;
	}

	const code = (text) => chip("gd-inspector-code", text);
	const near = (text) => chip("gd-inspector-near", text);
	const okChip = (text) => chip("gd-inspector-ok", T.ok(text));
	const badChip = (text) => chip("gd-inspector-bad", T.bad(text));
	const names = (tokens) => tokens.map((token) => token.name).join(" / ");

	function swatch(color) {
		const box = chip("gd-inspector-swatch", "");
		box.setAttribute("aria-hidden", "true");
		box.style.background = color.a === undefined || color.a >= 1 ? `rgb(${color.r}, ${color.g}, ${color.b})` : `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
		return box;
	}

	function rowElement(label, nodes) {
		const item = doc.createElement("div");
		item.className = "gd-inspector-row";
		const term = doc.createElement("dt");
		term.className = "gd-inspector-label";
		term.textContent = label;
		const value = doc.createElement("dd");
		value.className = "gd-inspector-value";
		value.append(...nodes);
		item.append(term, value);
		return item;
	}

	/** A color row: swatch and hex, the matching token(s), or ⚠ no token with the nearest one. */
	function colorValue(color, flags, label) {
		const nodes = [swatch(color), code(colorHex(color))];
		if (kinds.color.length === 0) return nodes;
		const same = kinds.color.filter((entry) => entry.color.r === color.r && entry.color.g === color.g && entry.color.b === color.b && Math.abs(entry.color.a - (color.a ?? 1)) < ALPHA_EPSILON);
		if (same.length > 0) return [...nodes, okChip(names(same.map((entry) => entry.token)))];
		nodes.push(badChip(T.noToken));
		const nearest = nearestColor(color, kinds.color);
		if (nearest) nodes.push(near(T.nearest(nearest.name)), code(nearest.value));
		flags.push(T.session.color(label, colorHex(color), nearest));
		return nodes;
	}

	/** A px value against the tokens of one kind (rem in px of the page's `root` font size); no tokens of that kind means nothing to compare. */
	function lengthValue(px, candidates, root, flags, label) {
		const nodes = [code(T.px(fmt(px)))];
		if (candidates.length === 0) return nodes;
		const match = matchLength(px, candidates, root);
		if (match.exact.length > 0) return [...nodes, okChip(names(match.exact))];
		nodes.push(badChip(T.noToken));
		if (match.nearest) nodes.push(near(T.nearest(match.nearest.name)), code(match.nearest.value));
		flags.push(T.session.length(label, fmt(px), match.nearest));
		return nodes;
	}

	function contrastValue(m, flags) {
		const text = m.color;
		const behind = m.background;
		if (!m.hasText || !text) return [code(T.none)];
		if (!behind) return [code(T.unknownBackground)];
		// Translucent text is composited over its background first.
		const shown = text.a < 1 ? { r: Math.round(text.r * text.a + behind.r * (1 - text.a)), g: Math.round(text.g * text.a + behind.g * (1 - text.a)), b: Math.round(text.b * text.a + behind.b * (1 - text.a)) } : text;
		const ratio = fmtRatio(contrastRatio(shown, behind));
		const large = m.fontSize >= 24 || (m.fontSize >= 18.66 && m.fontWeight >= 700);
		const needed = large ? 3 : 4.5;
		if (Number(ratio) >= needed) return [okChip(T.ratio(ratio)), near(large ? T.aaLarge : T.aa)];
		flags.push(T.session.contrast(ratio, needed, large));
		return [badChip(T.ratio(ratio)), near(large ? T.needsLarge(needed) : T.needs(needed))];
	}

	function familyValue(m, flags) {
		const mine = familyList(m.fontFamily);
		const first = mine[0] || T.none;
		const nodes = [code(first)];
		nodes[0].title = m.fontFamily;
		if (kinds.family.length === 0) return nodes;
		const exact = kinds.family.filter((entry) => sameFamilies(entry.families, mine));
		const byFirst = exact.length > 0 ? exact : kinds.family.filter((entry) => mine.length > 0 && entry.families[0]?.toLowerCase() === mine[0].toLowerCase());
		if (byFirst.length > 0) return [...nodes, okChip(names(byFirst.map((entry) => entry.token)))];
		flags.push(T.session.family(first, kinds.family.map((entry) => entry.token.name).join(", ")));
		return [...nodes, badChip(T.noToken)];
	}

	function spacingValue(m, flags) {
		const nodes = [];
		if (m.margin.some((value) => value !== 0)) nodes.push(code(T.margin(sides(m.margin))));
		if (m.padding.some((value) => value !== 0)) nodes.push(code(T.padding(sides(m.padding))));
		if (nodes.length === 0) return [code(T.none)];
		if (kinds.spacing.length === 0) return nodes;
		// A negative margin pulls by a step of the scale: its size is what is checked.
		const values = [...new Set([...m.margin, ...m.padding].filter((value) => value !== 0))];
		const off = values.map((value) => ({ value, match: matchLength(Math.abs(value), kinds.spacing, m.rootFontSize) })).filter((entry) => entry.match.exact.length === 0);
		if (off.length === 0) nodes.push(okChip(T.onScale));
		for (const { value, match } of off) {
			nodes.push(badChip(T.offScale(fmt(value))));
			if (match.nearest) nodes.push(near(T.nearest(match.nearest.name)), code(match.nearest.value));
			flags.push(T.session.spacing(fmt(value), match.nearest));
		}
		return nodes;
	}

	function radiusValue(m, flags) {
		const corners = m.radius;
		if (corners.every((value) => value === 0)) return [code(T.none)];
		if (corners.every((value) => value === corners[0])) return lengthValue(corners[0], kinds.radius, m.rootFontSize, flags, T.session.radius);
		const nodes = [code(T.px(sides(corners)))];
		if (kinds.radius.length === 0) return nodes;
		for (const value of new Set(corners.filter((corner) => corner > 0))) {
			const match = matchLength(value, kinds.radius, m.rootFontSize);
			if (match.exact.length > 0) continue;
			nodes.push(badChip(T.radiusNoToken(fmt(value))));
			flags.push(T.session.length(T.session.radius, fmt(value), match.nearest));
		}
		return nodes;
	}

	/**
	 * The panel's rows for one measured element, the flagged values, the comment that asks to fix them, and the
	 * rows as plain text (`label: value`, one per line), which Copy copies after the element's label and selector.
	 */
	function describe(m) {
		const flags = [];
		const { labels } = T;
		const lines = [];
		const row = (label, nodes) => {
			lines.push(`${label}: ${nodes.map((node) => node.textContent).filter(Boolean).join(" ")}`);
			return rowElement(label, nodes);
		};
		const rows = [
			row(labels.color, m.color ? colorValue(m.color, flags, T.session.textColor) : [code(T.unreadable)]),
			row(labels.background, m.background ? colorValue(m.background, flags, T.session.background) : [code(T.imageBackground)]),
			row(labels.contrast, contrastValue(m, flags)),
			row(labels.font, familyValue(m, flags)),
			row(labels.size, [...lengthValue(m.fontSize, kinds.fontSize, m.rootFontSize, flags, T.session.fontSize), near(T.weight(m.fontWeight))]),
			row(labels.lineHeight, [code(m.lineHeight === null ? T.normal : T.px(fmt(m.lineHeight)))]),
			row(labels.spacing, spacingValue(m, flags)),
			row(labels.radius, radiusValue(m, flags)),
		];
		const text = flags.length > 0 ? T.session.fix(m.selector, flags) : T.session.nothing(m.selector);
		return { rows, flags, text: text.slice(0, LIMITS.comment), lines };
	}

	// ---- what an artboard reports (gd:inspect)

	function finiteRgb(value, withAlpha) {
		if (value === null) return null;
		if (!value || typeof value !== "object") return undefined;
		if (!["r", "g", "b"].every((key) => isFiniteNumber(value[key]) && value[key] >= 0 && value[key] <= 255)) return undefined;
		if (!withAlpha) return { r: value.r, g: value.g, b: value.b };
		return isFiniteNumber(value.a) && value.a >= 0 && value.a <= 1 ? { r: value.r, g: value.g, b: value.b, a: value.a } : undefined;
	}

	function fourNumbers(value) {
		return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber) ? value.slice() : null;
	}

	/** A measurement checked field by field (the page is the design's own code, not trusted); null when malformed. */
	function readMeasure(raw) {
		if (!raw || typeof raw !== "object") return null;
		const selector = typeof raw.selector === "string" ? raw.selector.trim() : "";
		const rect = raw.rect && typeof raw.rect === "object" ? raw.rect : null;
		const color = finiteRgb(raw.color, true);
		const background = finiteRgb(raw.background, false);
		const margin = fourNumbers(raw.margin);
		const padding = fourNumbers(raw.padding);
		const radius = fourNumbers(raw.radius);
		if (!selector || selector.length > LIMITS.selector || !rect || !["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key]))) return null;
		if (color === undefined || background === undefined || !margin || !padding || !radius) return null;
		if (!isFiniteNumber(raw.fontSize) || !isFiniteNumber(raw.fontWeight) || typeof raw.fontFamily !== "string" || (raw.lineHeight !== null && !isFiniteNumber(raw.lineHeight))) return null;
		return {
			selector,
			label: typeof raw.label === "string" && raw.label ? raw.label.slice(0, LIMITS.label) : selector.slice(0, LIMITS.label),
			text: typeof raw.text === "string" ? raw.text.slice(0, LIMITS.excerpt) : "",
			hasText: raw.hasText === true,
			rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			color, background, fontFamily: raw.fontFamily.slice(0, LIMITS.family), fontSize: raw.fontSize, fontWeight: raw.fontWeight, lineHeight: raw.lineHeight,
			margin, padding, radius,
			// A frame that reports no usable root font size converts rem at the browser default.
			rootFontSize: isFiniteNumber(raw.rootFontSize) && raw.rootFontSize > 0 ? raw.rootFontSize : ROOT_FONT_SIZE,
		};
	}

	/**
	 * Whether a report from `surface` may show the panel: only with Technical details on, in Comment mode, with the
	 * comment box closed, outside Compare, for a design artboard of the design shown (an old design's frames may still
	 * report while the new one loads) and, in focus mode, for the focused artboard's frames only.
	 */
	function accepts(surface) {
		const board = actions.ownerOf(surface);
		if (!state.technical || !state.commenting || !els.popover.hidden || state.compare || board.system || board.slug !== state.slug) return false;
		return !state.focus || board === state.focus;
	}

	/**
	 * A gd:inspect from `surface` (a board's frame or an All sizes frame, canvas-messages.js). The first panel shows at
	 * once, and its own element again (scrolled) re-places it at once; another element waits for the pointer to rest on
	 * it (waitToSwitch), and with the pointer on the panel nothing changes. `element` null: the pointer left that frame's
	 * page, so a switch waiting on it is off and the panel goes soon.
	 */
	function inspectFrom(surface, element) {
		if (!accepts(surface)) return;
		if (element === null) {
			const waiting = Boolean(pending && pending.surface === surface);
			if (waiting) cancelSwitch();
			if (inspect && (waiting || inspect.surface === surface)) scheduleHide();
			return;
		}
		const measure = readMeasure(element);
		if (!measure || pointerOn) return;
		if (!inspect || (inspect.surface === surface && inspect.measure.selector === measure.selector)) showInspector(surface, measure);
		else waitToSwitch(surface, measure);
	}

	/**
	 * Another element while the panel shows: the pointer is on an element, so no hide; the switch comes after the rest.
	 * The rest counts from when the pointer reached that element: its re-measures (late loads, page changes) only
	 * refresh the values the switch will show, so they cannot hold the panel on the old element.
	 */
	function waitToSwitch(surface, measure) {
		generation += 1;
		if (pending && pending.surface === surface && pending.measure.selector === measure.selector) {
			pending.measure = measure;
			return;
		}
		pending = { surface, measure };
		const current = ++switches;
		win.setTimeout(() => {
			if (current !== switches || !pending) return;
			const next = pending;
			pending = null;
			if (!pointerOn && accepts(next.surface)) showInspector(next.surface, next.measure);
		}, DWELL_MS);
	}

	function cancelSwitch() {
		switches += 1;
		pending = null;
	}

	// ---- the panel

	/** Beside the frame (right, else left), level with the element; below or above it when the frame leaves no room. */
	function placeInspector(surface, rect) {
		const viewport = els.viewport.getBoundingClientRect();
		const box = surface.frame.getBoundingClientRect();
		const scale = box.width / surface.viewWidth || 1;
		const right = box.left + box.width;
		const top = box.top + rect.y * scale;
		const bottom = box.top + (rect.y + rect.height) * scale;
		const width = els.inspector.offsetWidth || INSPECTOR_WIDTH;
		const height = els.inspector.offsetHeight || INSPECTOR_HEIGHT;
		const minX = viewport.left + INSPECTOR_GAP;
		const maxX = viewport.left + viewport.width - width - INSPECTOR_GAP;
		const minY = viewport.top + INSPECTOR_GAP;
		const maxY = Math.max(minY, viewport.top + viewport.height - height - INSPECTOR_GAP);
		const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
		let x;
		let y = clamp(top, minY, maxY);
		if (right + INSPECTOR_GAP <= maxX) x = right + INSPECTOR_GAP;
		else if (box.left - INSPECTOR_GAP - width >= minX) x = box.left - INSPECTOR_GAP - width;
		else {
			x = clamp(box.left + rect.x * scale, minX, Math.max(minX, maxX));
			y = clamp(bottom + 8 + height <= viewport.top + viewport.height - INSPECTOR_GAP ? bottom + 8 : top - 8 - height, minY, maxY);
		}
		els.inspector.style.left = `${x - viewport.left}px`;
		els.inspector.style.top = `${y - viewport.top}px`;
	}

	function showInspector(surface, measure) {
		// A new element cancels a pending hide and a pending switch.
		generation += 1;
		cancelSwitch();
		renderInspector(surface, measure);
		els.inspector.hidden = false;
		placeInspector(surface, measure.rect);
	}

	/** The panel's title, rows, note and Ask the agent to fix for `measure`, compared with the current tokens. */
	function renderInspector(surface, measure) {
		const result = describe(measure);
		// Copy copies what the panel shows: the element, its selector and every row.
		const copy = [measure.label, measure.selector, ...result.lines].join("\n");
		inspect = { surface, measure, flags: result.flags, text: result.text, copy };
		els.inspectorTitle.textContent = measure.label;
		els.inspectorSelector.textContent = measure.selector;
		els.inspectorSelector.title = measure.selector;
		els.inspectorList.replaceChildren(...result.rows);
		els.inspectorNote.textContent = Object.hasOwn(T.problems, problem) ? T.problems[problem] : T.noTokens;
		els.inspectorNote.hidden = state.tokens.length > 0;
		const nothing = result.flags.length === 0;
		els.inspectorFix.disabled = nothing;
		els.inspectorFix.title = nothing ? T.nothingToFix : "";
	}

	/**
	 * Hides the panel: the comment box opens or closes (closePopover runs this first, so every path that closes it
	 * — focus mode ending, another size, Comment mode off, a pan — hides the panel too), Technical details goes off,
	 * another design shows, its frame goes (hideGoneInspector), the focused artboard is re-centered (centerFocus) or Esc
	 * is pressed in it. A pending switch ends with it. Keyboard focus in it goes back to the canvas.
	 */
	function hideInspector() {
		generation += 1;
		cancelSwitch();
		pointerOn = false;
		if (!inspect && els.inspector.hidden) return;
		inspect = null;
		const focused = els.inspector.contains(doc.activeElement);
		els.inspector.hidden = true;
		if (focused) (state.focus ? state.focus.frame : els.viewport).focus();
	}

	/** Hides the panel when the frame it is beside is gone (a design.json reload, All sizes frames removed); a switch to a gone frame is off. */
	function hideGoneInspector() {
		if (!inspect && !pending) return;
		const surfaces = actions.allBoards().flatMap(actions.surfacesOf);
		if (pending && !surfaces.includes(pending.surface)) cancelSwitch();
		if (inspect && !surfaces.includes(inspect.surface)) hideInspector();
	}

	/** The element was left: the panel goes soon, unless the pointer or the keyboard is in it by then. */
	function scheduleHide() {
		const pending = ++generation;
		win.setTimeout(() => {
			if (pending !== generation || pointerOn || els.inspector.contains(doc.activeElement)) return;
			hideInspector();
		}, HIDE_MS);
	}

	// With the pointer on the panel nothing changes: a switch it passed on its way is off.
	els.inspector.addEventListener("pointerenter", () => {
		pointerOn = true;
		cancelSwitch();
	});
	els.inspector.addEventListener("pointerleave", () => {
		pointerOn = false;
		if (inspect) scheduleHide();
	});
	// Keyboard focus leaving the panel (not to another of its buttons) lets it go like the pointer does (WCAG 1.4.13).
	els.inspector.addEventListener("focusout", (event) => {
		if (!inspect || pointerOn || els.inspector.contains(event.relatedTarget)) return;
		scheduleHide();
	});
	// Esc closes only the panel (Comment mode stays on), focus back on the canvas.
	els.inspector.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.shiftKey) return;
		event.preventDefault();
		hideInspector();
	});
	// The panel is not part of the canvas: the wheel over it never pans or zooms.
	els.inspector.addEventListener("wheel", (event) => event.stopPropagation());

	els.inspectorFix.addEventListener("click", () => {
		const current = inspect;
		if (!current || current.flags.length === 0) return;
		const { surface, measure, text } = current;
		actions.openPopover(surface, { selector: measure.selector, excerpt: measure.text, rect: measure.rect });
		els.text.value = text;
	});

	/** The Clipboard API, else the browser's copy command through a hidden text area. */
	async function copyText(text) {
		const clipboard = win.navigator && win.navigator.clipboard;
		try {
			if (clipboard && typeof clipboard.writeText === "function") {
				await clipboard.writeText(text);
				return true;
			}
		} catch { /* denied or unavailable: use the fallback */ }
		const previous = doc.activeElement;
		const area = doc.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.className = "gd-visually-hidden";
		doc.body.append(area);
		try {
			area.focus();
			area.select?.();
			return typeof doc.execCommand === "function" && doc.execCommand("copy") === true;
		} catch {
			return false;
		} finally {
			area.remove();
			previous?.focus?.();
		}
	}

	els.inspectorCopy.addEventListener("click", async () => {
		const current = inspect;
		if (!current) return;
		const ok = await copyText(current.copy);
		ui.showToast(ok ? T.copied : T.copyFailed, !ok);
	});

	/** A new language: an open panel's rows, note and tooltip, where it is. */
	function relabel() {
		if (inspect) renderInspector(inspect.surface, inspect.measure);
	}

	/** The panel beside its element again, after the artboard moved (a language switch re-centers it). */
	function placeInspectorAgain() {
		if (inspect && !els.inspector.hidden) placeInspector(inspect.surface, inspect.measure.rect);
	}

	return { relabel, placeInspector: placeInspectorAgain, loadTokens, setTechnical, startTokens, inspectFrom, hideInspector, hideGoneInspector };
}
