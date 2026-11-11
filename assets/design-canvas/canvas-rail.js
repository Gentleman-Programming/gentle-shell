// The tool rail on the left: Move and Comment (one pressed pair over Comment
// mode), Overview (Fit) and Settings (a menu with the design system board and the
// keyboard shortcuts). Its single-key shortcuts, and the ? list where a person
// gives any of them another single key, saved in this browser for every design
// the canvas server shows (per address: a restarted server has a new port).

// Every string the rail shows, in English until the i18n PR keys them.
const TEXT = Object.freeze({
	settings: "Settings",
	system: "Design system board",
	keys: "Keyboard shortcuts",
	navigateTitle: (key) => `Move around the canvas (${key})`,
	commentTitle: (key) => `Comment on an element (${key})`,
	fitTitle: (key) => `See all the directions (${key})`,
	panelTitle: (key) => `Comments panel (${key})`,
	actions: {
		navigate: "Move around the canvas",
		comment: "Comment on an element",
		fit: "Overview (fit all directions)",
		panel: "Show or hide the comments panel",
		help: "Show keyboard shortcuts",
	},
	change: "Change",
	changeAria: (action, key) => `Change the key for “${action}” (${key})`,
	reset: "Reset",
	resetAria: (action, key) => `Reset “${action}” to ${key}`,
	waiting: "Press a key…",
	waitingMessage: (action) => `Press the new key for “${action}”, or Esc to cancel.`,
	assigned: (action, key) => `“${action}” is now ${key}.`,
	kept: (action, key) => `“${action}” keeps ${key}.`,
	taken: (key, action) => `${key} is already used by “${action}”. Nothing changed.`,
	fixed: (key) => `${key} is a fixed key and can’t be assigned. Nothing changed.`,
	invalid: "Use a single letter, digit or punctuation key, without Ctrl, Alt or Cmd. Nothing changed.",
	unsaved: "This browser could not save the change, so it holds for this page only.",
	resetDone: (action, key) => `“${action}” is back to ${key}.`,
	restored: "All shortcuts are back to their defaults.",
	spaceKey: "Space",
});

// The keys a person gave the single-key shortcuts in this browser, for every design at this canvas address: a JSON object, action id -> key.
const SHORTCUTS_KEY = "gentle-design:shortcuts";
// Never assignable: Esc, Shift+Esc, Enter, Tab, Space, the arrows and the zoom keys keep their meaning.
const FIXED_KEYS = ["Escape", "Enter", "Tab", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0"];
const ARROW_KEYS = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
// Pressed alone while a Change waits, these keep it waiting: Shift (and AltGr) are how many keyboards type ? or ].
const MODIFIER_KEYS = ["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock", "Hyper", "Super", "Symbol", "SymbolLock"];
const TYPING_TAGS = ["input", "textarea", "select"];

/** One printable character (a letter, a digit or punctuation). */
const printable = (key) => typeof key === "string" && [...key].length === 1 && /^\S$/u.test(key);
/**
 * The key a shortcut can take from `key`: one printable character, lower case, that is still one printable
 * character once lower case (İ is not: it lowers to i plus a combining dot); otherwise "".
 */
const singleKey = (key) => (printable(key) && printable(key.toLowerCase()) ? key.toLowerCase() : "");
/**
 * Ctrl, Alt or Cmd held for a browser chord. AltGr, which types a character, reports Ctrl and Alt
 * on some systems and AltGraph in getModifierState: that press is a printable key, not a chord.
 */
const isChord = (event) => Boolean(event.metaKey || ((event.ctrlKey || event.altKey) && !(typeof event.getModifierState === "function" && event.getModifierState("AltGraph"))));
/** How a key is written: a letter upper case, as on the keyboard. */
const keyText = (key) => (key.toUpperCase().length === key.length ? key.toUpperCase() : key);

export function init(ctx) {
	const { win, doc, els, store, actions } = ctx;
	const { state } = store;

	// The rail and panel actions, each with its default key; keys match without letter case, so they are kept lower case.
	const SHORTCUTS = [
		{ id: "navigate", key: "v", run: () => actions.setCommenting(false) },
		{ id: "comment", key: "c", run: () => actions.setCommenting(true) },
		{ id: "fit", key: "f", run: () => actions.fit() },
		{ id: "panel", key: "]", run: () => actions.setPanel(els.panel.hidden) },
		{ id: "help", key: "?", run: () => openShortcuts() },
	];
	const shortcutById = (id) => SHORTCUTS.find((shortcut) => shortcut.id === id);
	const labelOf = (shortcut) => TEXT.actions[shortcut.id];

	/** The custom keys saved in this browser; an entry that is no usable key, names no action or takes another action's key is left out. */
	function storedShortcuts() {
		let stored = null;
		try {
			stored = JSON.parse(win.localStorage.getItem(SHORTCUTS_KEY) ?? "null");
		} catch {
			stored = null;
		}
		const custom = {};
		if (!stored || typeof stored !== "object" || Array.isArray(stored)) return custom;
		for (const shortcut of SHORTCUTS) {
			if (!Object.prototype.hasOwnProperty.call(stored, shortcut.id)) continue;
			const key = singleKey(stored[shortcut.id]);
			if (key && !FIXED_KEYS.includes(key) && key !== shortcut.key) custom[shortcut.id] = key;
		}
		// A key two actions would share is neither's custom key: those fall back to their defaults, until no two share one.
		for (;;) {
			const keyOf = (shortcut) => custom[shortcut.id] ?? shortcut.key;
			const shared = SHORTCUTS.filter((shortcut) => shortcut.id in custom && SHORTCUTS.some((other) => other !== shortcut && keyOf(other) === custom[shortcut.id]));
			if (shared.length === 0) return custom;
			for (const shortcut of shared) delete custom[shortcut.id];
		}
	}

	// This module's own state, like the pan drag in canvas-view.js: the custom keys, the
	// shortcut whose Change waits for the next key (or null), and the list's rows.
	let customKeys = storedShortcuts();
	let keyWait = null;
	const shortcutRows = new Map();
	const shortcutKey = (shortcut) => customKeys[shortcut.id] ?? shortcut.key;

	/** Saves the custom keys in this browser; false when storage refused them (they then hold for this page only). */
	function saveShortcuts() {
		try {
			win.localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(customKeys));
			return true;
		} catch {
			return false;
		}
	}

	/** The message after a change: `text`, plus a warning (read as an error) when it could not be saved. */
	function showSavedMessage(text, saved) {
		showKeysMessage(saved ? text : `${text} ${TEXT.unsaved}`, !saved);
	}

	/** The line under the list that says what a Change did; a refusal reads as an error. No text clears it. */
	function showKeysMessage(text, refused = false) {
		els.keysMessage.textContent = text ?? "";
		els.keysMessage.classList.toggle("gd-error", refused);
	}

	/** Move and Comment are one pressed pair. */
	function renderTools() {
		els.comment.setAttribute("aria-pressed", String(state.commenting));
		els.toolNavigate.setAttribute("aria-pressed", String(!state.commenting));
	}

	// Where the rail and the top bar name a key: in the tooltip, and in aria-keyshortcuts for screen readers.
	const SHORTCUT_HINTS = [["navigate", els.toolNavigate, TEXT.navigateTitle], ["comment", els.comment, TEXT.commentTitle], ["fit", els.railFit, TEXT.fitTitle], ["panel", els.panelToggle, TEXT.panelTitle]];

	/** Every place that shows a key shows the current one: the rail, the comments panel button and the list. */
	function renderShortcuts() {
		for (const [id, element, title] of SHORTCUT_HINTS) {
			const key = keyText(shortcutKey(shortcutById(id)));
			element.setAttribute("aria-keyshortcuts", key);
			element.title = title(key);
		}
		for (const shortcut of SHORTCUTS) renderShortcutRow(shortcut);
	}

	/** A row of the list: the action, its key, Change and Reset. Built once and kept, so a change never takes the focus away. */
	function renderShortcutRow(shortcut) {
		let row = shortcutRows.get(shortcut.id);
		if (!row) {
			const root = doc.createElement("li");
			root.className = "gd-key-row";
			root.dataset.shortcut = shortcut.id;
			const action = doc.createElement("span");
			action.className = "gd-key-action";
			action.textContent = labelOf(shortcut);
			const key = doc.createElement("kbd");
			key.className = "gd-key-current";
			const change = doc.createElement("button");
			change.type = "button";
			change.className = "gd-key-change gd-small";
			const reset = doc.createElement("button");
			reset.type = "button";
			reset.className = "gd-key-reset gd-small";
			reset.textContent = TEXT.reset;
			change.addEventListener("click", () => {
				if (keyWait !== shortcut) startKeyWait(shortcut);
				else {
					stopKeyWait();
					showKeysMessage(TEXT.kept(labelOf(shortcut), keyText(shortcutKey(shortcut))));
				}
			});
			// Leaving the button (a click elsewhere, Restore defaults) ends its wait.
			change.addEventListener("blur", () => {
				if (keyWait !== shortcut) return;
				stopKeyWait();
				showKeysMessage(null);
			});
			reset.addEventListener("click", () => {
				stopKeyWait();
				assignKey(shortcut, shortcut.key, TEXT.resetDone);
			});
			root.append(action, key, change, reset);
			els.keysCustom.append(root);
			row = { root, key, change, reset };
			shortcutRows.set(shortcut.id, row);
		}
		const key = keyText(shortcutKey(shortcut));
		const waiting = keyWait === shortcut;
		row.root.classList.toggle("gd-key-waiting", waiting);
		row.key.textContent = key;
		row.change.textContent = waiting ? TEXT.waiting : TEXT.change;
		// While it waits, its visible text is its name.
		if (waiting) row.change.removeAttribute("aria-label");
		else row.change.setAttribute("aria-label", TEXT.changeAria(labelOf(shortcut), key));
		row.reset.setAttribute("aria-label", TEXT.resetAria(labelOf(shortcut), keyText(shortcut.key)));
	}

	function startKeyWait(shortcut) {
		const previous = keyWait;
		keyWait = shortcut;
		if (previous) renderShortcutRow(previous);
		renderShortcutRow(shortcut);
		showKeysMessage(TEXT.waitingMessage(labelOf(shortcut)));
		shortcutRows.get(shortcut.id).change.focus();
	}

	function stopKeyWait() {
		const shortcut = keyWait;
		if (!shortcut) return;
		keyWait = null;
		renderShortcutRow(shortcut);
	}

	/** Gives `shortcut` the key, unless another action has it; `done` writes the message that says it was given. */
	function assignKey(shortcut, key, done) {
		const owner = SHORTCUTS.find((other) => other !== shortcut && shortcutKey(other) === key);
		if (owner) {
			showKeysMessage(TEXT.taken(keyText(key), labelOf(owner)), true);
			return;
		}
		if (key === shortcut.key) delete customKeys[shortcut.id];
		else customKeys[shortcut.id] = key;
		const saved = saveShortcuts();
		renderShortcuts();
		showSavedMessage(done(labelOf(shortcut), keyText(key)), saved);
	}

	function openShortcuts() {
		showKeysMessage(null);
		if (typeof els.shortcuts.showModal === "function") els.shortcuts.showModal();
		else els.shortcuts.setAttribute("open", "");
	}

	function closeShortcuts() {
		stopKeyWait();
		if (typeof els.shortcuts.close === "function") els.shortcuts.close();
		else els.shortcuts.removeAttribute("open");
		els.railSettings.focus();
	}

	/** What Settings offers: the design system board (when there is one, and not over Compare) and the keyboard shortcuts. */
	function settingsActions() {
		return [
			// Checked again when chosen: a live reload may have removed the board while the menu was open.
			{ label: TEXT.system, icon: "i-palette", disabled: !state.systemBoard || Boolean(state.compare), run: () => {
				if (state.systemBoard && !state.compare) actions.enterFocus(state.systemBoard);
			} },
			{ label: TEXT.keys, icon: "i-keys", shortcut: keyText(shortcutKey(shortcutById("help"))), run: openShortcuts },
		];
	}

	/** The first render of the rail and the list, and the Settings menu; boot() runs it once every module is ready. */
	function startRail() {
		renderTools();
		renderShortcuts();
		actions.wireMenu(els.railSettings, (last) => actions.showMenu(els.railSettings, settingsActions(), TEXT.settings, last, true));
	}

	els.toolNavigate.addEventListener("click", () => actions.setCommenting(false));
	els.railFit.addEventListener("click", () => actions.fit());

	// The browser closes the modal list on Esc too (not while a Change waits: that Esc only cancels the wait).
	els.shortcuts.addEventListener("close", stopKeyWait);
	els.shortcutsClose.addEventListener("click", closeShortcuts);
	els.keysRestore.addEventListener("click", () => {
		stopKeyWait();
		customKeys = {};
		const saved = saveShortcuts();
		renderShortcuts();
		showSavedMessage(TEXT.restored, saved);
	});

	// While a Change waits, the next key is the new one and nothing else gets it; Esc cancels the wait (in the capture
	// phase, ahead of every other key handler, and without closing the list). Tab ends the wait as leaving the button
	// does, and still moves focus.
	doc.addEventListener("keydown", (event) => {
		const shortcut = keyWait;
		if (!shortcut || MODIFIER_KEYS.includes(event.key)) return;
		if (event.key === "Tab") {
			stopKeyWait();
			showKeysMessage(null);
			return;
		}
		event.preventDefault();
		stopKeyWait();
		if (event.key === "Escape" && !event.shiftKey) {
			showKeysMessage(TEXT.kept(labelOf(shortcut), keyText(shortcutKey(shortcut))));
			return;
		}
		if (FIXED_KEYS.includes(event.key)) {
			const name = event.key === "Escape" ? "Shift+Esc" : event.key === " " ? TEXT.spaceKey : ARROW_KEYS[event.key] ?? event.key;
			showKeysMessage(TEXT.fixed(name), true);
			return;
		}
		const key = isChord(event) ? "" : singleKey(event.key);
		if (key) assignKey(shortcut, key, TEXT.assigned);
		else showKeysMessage(TEXT.invalid, true);
	}, true);

	// The shortcuts never fire while typing, with a browser chord, while the comment box, a menu or the list (where the
	// help key closes it) is open, in Compare, or in focus mode (the artboard owns the keyboard; Shift+Esc is handled apart).
	// A held key runs its shortcut once: the browser's repeated keydowns would toggle the panel or the list again.
	doc.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.repeat || isChord(event)) return;
		const target = event.target;
		if (target && (TYPING_TAGS.includes(target.localName) || target.isContentEditable)) return;
		const key = singleKey(event.key);
		const shortcut = key ? SHORTCUTS.find((entry) => shortcutKey(entry) === key) : null;
		if (els.shortcuts.hasAttribute("open")) {
			if (shortcut && shortcut.id === "help") {
				event.preventDefault();
				closeShortcuts();
			}
			return;
		}
		if (!shortcut || !els.popover.hidden || state.focus || state.compare || state.menu) return;
		event.preventDefault();
		shortcut.run();
	});

	return { renderTools, renderShortcuts, startRail };
}
