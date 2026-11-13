// The canvas language: Spanish or English, chosen in the rail's Settings (Español, English or
// Match the browser), saved in this browser and applied at once, without reloading an artboard.
// Each module keeps its English strings in its TEXT block and reads them through
// `const T = ctx.i18n.text("<module>", TEXT)`: T gives the Spanish of canvas-i18n-es.js for a
// key it has while the canvas is Spanish, else the English. TEXT.session (what the canvas sends
// to the agent) is never translated. index.html's text is keyed with data-i18n (and
// data-i18n-title, -aria-label, -placeholder, -alt), and applyMarkup rewrites it from ES.html,
// or back to the English it read when the language started. User content (comments, artboard
// titles and tradeoffs) and file names stay as written.

// The choice in this browser, for every design at this canvas address: "es", "en" or "auto".
const LANGUAGE_KEY = "gentle-design:language";
const CHOICES = ["es", "en", "auto"];
const ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];
const MARKUP = ["[data-i18n]", ...ATTRIBUTES.map((name) => `[data-i18n-${name}]`)].join(",");

/** es: the Spanish catalog (canvas-i18n-es.js); changed: what canvas-boot.js runs once the language changed. */
export function init(ctx, es, changed) {
	const { win, doc, store } = ctx;
	const { state } = store;
	// Each keyed element of the page and the English it held when the language started.
	const english = new WeakMap();

	/** The browser's language: Spanish for es and es-*, English for anything else. */
	function browserLanguage() {
		const navigator = win.navigator;
		const tag = navigator ? navigator.languages?.[0] ?? navigator.language : "";
		return /^es(-|$)/i.test(String(tag ?? "")) ? "es" : "en";
	}

	const resolve = (choice) => (choice === "auto" ? browserLanguage() : choice);

	/** The saved choice; an unreadable or unknown one is "auto". */
	function storedChoice() {
		try {
			const choice = win.localStorage.getItem(LANGUAGE_KEY);
			return CHOICES.includes(choice) ? choice : "auto";
		} catch {
			return "auto";
		}
	}

	/** A live view of a module's TEXT: each read gives the Spanish of that key while the canvas is Spanish and it has one, else the English. */
	function view(source, spanish) {
		const result = {};
		for (const [key, value] of Object.entries(source)) {
			const translated = key !== "session" && spanish && typeof spanish === "object" && Object.hasOwn(spanish, key) ? spanish[key] : undefined;
			if (key === "session" || (value && typeof value === "object" && !Array.isArray(value))) {
				// Agent instructions stay English whole; any other group is a view of its own.
				Object.defineProperty(result, key, { enumerable: true, value: key === "session" ? value : view(value, translated) });
			} else {
				Object.defineProperty(result, key, { enumerable: true, get: () => (state.language === "es" && translated !== undefined ? translated : value) });
			}
		}
		return Object.freeze(result);
	}

	const text = (module, source) => view(source, es[module]);

	/** Rewrites the page's keyed text and attributes in the current language. */
	function applyMarkup() {
		const spanish = state.language === "es" && es.html ? es.html : {};
		const pick = (key, fallback) => (Object.hasOwn(spanish, key) ? spanish[key] : fallback);
		for (const element of doc.querySelectorAll(MARKUP)) {
			if (!english.has(element)) english.set(element, { text: element.textContent, attributes: Object.fromEntries(ATTRIBUTES.map((name) => [name, element.getAttribute(name)])) });
			const original = english.get(element);
			const key = element.getAttribute("data-i18n");
			if (key) element.textContent = pick(key, original.text);
			for (const name of ATTRIBUTES) {
				const attributeKey = element.getAttribute(`data-i18n-${name}`);
				if (attributeKey && original.attributes[name] !== null) element.setAttribute(name, pick(attributeKey, original.attributes[name]));
			}
		}
	}

	/** Sets the choice and its language; a new language rewrites the page (changed). */
	function apply(choice) {
		const language = resolve(choice);
		const switched = language !== state.language;
		store.setLanguage(choice, language);
		doc.documentElement.setAttribute("lang", language);
		if (switched) changed();
	}

	/** The choice made in Settings: saved in this browser (or for this page only, when storage refuses it) and applied at once. */
	function setLanguage(choice) {
		if (!CHOICES.includes(choice)) return;
		try {
			win.localStorage.setItem(LANGUAGE_KEY, choice);
		} catch {
			// Storage refused it: the choice holds for this page.
		}
		apply(choice);
	}

	/** The first language, before anything renders; then Match the browser follows the browser's language. */
	function startLanguage() {
		const choice = storedChoice();
		store.setLanguage(choice, resolve(choice));
		doc.documentElement.setAttribute("lang", state.language);
		applyMarkup();
		win.addEventListener("languagechange", () => {
			if (state.languageChoice === "auto") apply("auto");
		});
	}

	return { text, applyMarkup, setLanguage, startLanguage };
}
