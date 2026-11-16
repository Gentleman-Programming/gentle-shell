// The canvas theme: Gentleman (the Gentleman brand's pink on plum) or Neutral (the gray and blue
// of :root, the default), chosen in the rail's Settings, saved in this browser and applied at once.
// canvas.css holds the palettes: Neutral is :root's own --gd-* tokens, Gentleman is
// :root[data-theme="gentleman"], which sets every one of them; artboards keep their own colors, but the
// Comment mode outlines drawn inside them are canvas chrome: gd:mode carries the theme's (canvas-boards.js),
// and a change of theme sends only the new colors (gd:colors) to every frame. theme-early.js, a classic script in index.html's <head>,
// paints a saved Gentleman before the first frame; startTheme() stays the source of truth for the store.

// Every string the theme shows, in English; canvas-i18n-es.js has the Spanish. Gentleman is a name and stays as is.
const TEXT = Object.freeze({
	theme: "Theme",
	gentleman: "Gentleman",
	neutral: "Neutral",
});

// The choice in this browser, for every design at this canvas address: "gentleman" or "neutral".
const THEME_KEY = "gentle-design:theme";
// Settings' theme radios, in order: the choice, its label and its icon.
const THEMES = [["gentleman", "gentleman", "i-mustache"], ["neutral", "neutral", "i-contrast"]];
const CHOICES = THEMES.map(([choice]) => choice);
const DEFAULT_THEME = "neutral";

export function init(ctx) {
	const { win, doc, store, actions } = ctx;
	const { state } = store;
	const T = ctx.i18n.text("theme", TEXT);

	/** The saved choice; an unreadable or unknown one is Neutral. */
	function storedTheme() {
		try {
			const choice = win.localStorage.getItem(THEME_KEY);
			return CHOICES.includes(choice) ? choice : DEFAULT_THEME;
		} catch {
			return DEFAULT_THEME;
		}
	}

	/** Neutral is :root's own palette, so it needs no attribute. */
	function apply(choice) {
		store.setTheme(choice);
		if (choice === DEFAULT_THEME) doc.documentElement.removeAttribute("data-theme");
		else doc.documentElement.setAttribute("data-theme", choice);
	}

	/** The choice made in Settings: saved in this browser (or for this page only, when storage refuses it) and applied at once. */
	function setTheme(choice) {
		if (!CHOICES.includes(choice)) return;
		try {
			win.localStorage.setItem(THEME_KEY, choice);
		} catch {
			// Storage refused it: the choice holds for this page.
		}
		apply(choice);
		// The outlines inside every frame, All sizes frames included, take the new colors at once.
		actions.allBoards().flatMap(actions.surfacesOf).forEach(actions.sendColors);
	}

	/** The saved theme, before anything renders. */
	function startTheme() {
		apply(storedTheme());
	}

	/** Settings' theme radios under their heading (canvas-rail.js). */
	function themeActions() {
		return [{ group: T.theme, actions: THEMES.map(([choice, label, icon]) => ({ label: T[label], icon, radio: true, checked: state.theme === choice, run: () => setTheme(choice) })) }];
	}

	return { setTheme, startTheme, themeActions };
}
