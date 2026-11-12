// Screen sizes in focus mode: the top bar's device button and its menu (Phone,
// Tablet, Desktop and a custom width), and the size each one gives the focused
// artboard's frame (focusSize, which canvas-focus.js centers). A size resizes the
// frame in place, so the design's own media queries respond; nothing reloads.
// The size lives in the store (setFocus), and the menu is the shared one
// (canvas-menu.js) with its own element, #gd-device-menu.

// Every string the sizes show, in English until the i18n PR keys them.
const TEXT = Object.freeze({
	group: "Preview size",
	phone: "Phone",
	tablet: "Tablet",
	desktop: "Desktop",
	custom: "Custom",
	customAria: "Custom width in pixels",
	customGroup: "Custom width",
	error: (min, max) => `Enter a whole number from ${min} to ${max} (px).`,
	itemTitle: (name, width, height) => `${name} ${width} × ${height}`,
	button: (size) => `Preview size: ${size}`,
	buttonTitle: "Preview size of the open artboard",
	buttonOff: "Open an artboard to choose its preview size",
});

// Phone and Tablet are fixed sizes; Desktop fills the viewport beside the focus margins, never
// narrower than the artboard was designed (canvas-layout S8), at the artboard's manifest height.
const SIZE_PRESETS = [
	{ kind: "phone", width: 390, height: 844 },
	{ kind: "tablet", width: 820, height: 1180 },
	{ kind: "desktop" },
];
// The custom width: whole CSS px in this range, with the manifest height.
const CUSTOM_WIDTH = { min: 240, max: 2560 };
// The device button wears the icon of the size it shows (canvas-layout S6).
const SIZE_ICONS = { phone: "i-phone", tablet: "i-tablet", desktop: "i-monitor", custom: "i-width" };

export function init(ctx) {
	const { doc, els, store, actions } = ctx;
	const { state } = store;

	const nameOf = (kind) => TEXT[kind] ?? TEXT.desktop;
	const dims = (size) => `${size.width} × ${size.height}`;

	/** Desktop: the viewport's whole width at 100%, never narrower than the artboard was designed. */
	function desktopSize(board) {
		return { width: Math.max(board.artboard.width, actions.focusRoom()), height: board.artboard.height };
	}

	function presetSize(board, preset) {
		return preset.kind === "desktop" ? desktopSize(board) : { width: preset.width, height: preset.height };
	}

	/** What the focused size means for `board`: its frame's width and height before the viewport clips a tall one. */
	function focusSize(board) {
		const size = state.size;
		if (size.kind === "custom") return { width: size.width, height: board.artboard.height };
		return presetSize(board, SIZE_PRESETS.find((preset) => preset.kind === size.kind) ?? SIZE_PRESETS[2]);
	}

	/**
	 * The device button: the icon and short name of the focused size and its width × height.
	 * Outside focus mode it is off: the sizes act on an open artboard only (canvas-layout S6).
	 */
	function renderDevice() {
		const board = state.focus;
		const kind = board && SIZE_ICONS[state.size.kind] ? state.size.kind : "desktop";
		const name = nameOf(kind);
		const size = board ? dims(focusSize(board)) : "";
		els.deviceIcon.setAttribute("href", `#${SIZE_ICONS[kind]}`);
		els.deviceName.textContent = name;
		els.deviceSize.textContent = size;
		els.device.disabled = !board;
		els.device.title = board ? TEXT.buttonTitle : TEXT.buttonOff;
		els.device.setAttribute("aria-label", TEXT.button(size ? `${name} ${size}` : name));
	}

	/** A span with a class and text. */
	function chip(className, text) {
		const span = doc.createElement("span");
		span.className = className;
		span.textContent = text;
		return span;
	}

	/** One radio item of the device menu: icon, name, its size for the focused artboard and a check when it is the current one. */
	function deviceItem(board, preset) {
		const size = presetSize(board, preset);
		const item = doc.createElement("button");
		item.type = "button";
		item.className = "gd-menu-item gd-device-item";
		item.setAttribute("role", "menuitemradio");
		item.setAttribute("aria-checked", String(state.size.kind === preset.kind));
		item.setAttribute("tabindex", "-1");
		item.dataset.size = preset.kind;
		item.title = TEXT.itemTitle(nameOf(preset.kind), size.width, size.height);
		item.append(actions.icon(SIZE_ICONS[preset.kind], "gd-i gd-i-s"), chip("gd-menu-label", nameOf(preset.kind)), chip("gd-device-dim", dims(size)), actions.icon("i-check", "gd-i gd-i-s gd-device-check"));
		item.addEventListener("click", () => chooseDeviceItem(item));
		return item;
	}

	// The open menu's width field and its error line; null while the device menu is closed.
	let custom = null;

	/**
	 * The device menu, built when it opens: Phone, Tablet and Desktop as radio items, then the
	 * custom width field. The arrows reach the field as the last entry; inside it the other keys stay with the field.
	 */
	function openDeviceMenu(last) {
		const board = state.focus;
		if (!board) return;
		const items = SIZE_PRESETS.map((preset) => deviceItem(board, preset));
		const separator = doc.createElement("div");
		separator.className = "gd-menu-separator";
		separator.setAttribute("role", "separator");
		const row = doc.createElement("label");
		row.className = "gd-device-custom";
		row.classList.toggle("gd-selected", state.size.kind === "custom");
		const input = doc.createElement("input");
		input.type = "number";
		// A name keeps the browser from flagging an anonymous form field.
		input.name = "gd-custom-width";
		input.className = "gd-device-input";
		input.setAttribute("aria-label", TEXT.customAria);
		input.setAttribute("min", String(CUSTOM_WIDTH.min));
		input.setAttribute("max", String(CUSTOM_WIDTH.max));
		input.setAttribute("step", "1");
		input.setAttribute("inputmode", "numeric");
		input.value = state.size.kind === "custom" ? String(state.size.width) : "";
		const unit = chip("gd-device-unit", "px");
		unit.setAttribute("aria-hidden", "true");
		row.append(actions.icon(SIZE_ICONS.custom, "gd-i gd-i-s"), chip("gd-device-custom-label", TEXT.custom), input, unit);
		const error = doc.createElement("p");
		error.className = "gd-device-error";
		error.setAttribute("role", "alert");
		error.hidden = true;
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			applyCustomWidth();
		});
		custom = { input, error };
		// A menu owns only items, separators and groups: the field and its error sit in a named group, so screen readers in
		// menu mode still reach and announce them.
		const group = doc.createElement("div");
		group.className = "gd-device-custom-group";
		group.setAttribute("role", "group");
		group.setAttribute("aria-label", TEXT.customGroup);
		group.append(row, error);
		actions.openMenu(els.device, els.deviceMenu, [...items, separator, group], [...items, input], TEXT.group, last ? input : items[0]);
	}

	const deviceMenuOpen = () => Boolean(state.menu && state.menu.root === els.deviceMenu);

	/** Closes the device menu when it is the open one (focus goes back to the button when it was inside). */
	function closeDeviceMenu(refocus = false) {
		if (deviceMenuOpen()) actions.closeMenu(refocus);
	}

	function chooseDeviceItem(item) {
		// The field is an entry of the arrow keys, not a choice: Enter in it applies the width.
		if (!deviceMenuOpen() || !item.dataset.size) return;
		closeDeviceMenu(true);
		setSize({ kind: item.dataset.size });
	}

	/** The custom width: whole px from 240 to 2560; anything else keeps the menu open with the error under the field. */
	function applyCustomWidth() {
		if (!deviceMenuOpen() || !custom) return;
		const { input, error } = custom;
		const text = String(input.value).trim();
		const width = Number(text);
		if (!/^\d+$/.test(text) || width < CUSTOM_WIDTH.min || width > CUSTOM_WIDTH.max) {
			input.setAttribute("aria-invalid", "true");
			error.textContent = TEXT.error(CUSTOM_WIDTH.min, CUSTOM_WIDTH.max);
			error.hidden = false;
			return;
		}
		input.removeAttribute("aria-invalid");
		error.hidden = true;
		closeDeviceMenu(true);
		setSize({ kind: "custom", width });
	}

	/** Gives the focused artboard a size; a bad custom width never gets here (the field refuses it). */
	function setSize(size) {
		if (!state.focus) return;
		actions.closePopover();
		store.setFocus({ size: Object.freeze(size) });
		actions.centerFocus();
	}

	/** The device button opens its menu like Settings (click, arrows, Esc); boot() runs it once every module is ready. */
	function startSizes() {
		renderDevice();
		actions.wireMenu(els.device, openDeviceMenu);
	}

	els.deviceMenu.addEventListener("keydown", (event) => {
		if (!deviceMenuOpen() || !custom) return;
		// In the width field typing, Home, End, Space and Enter stay with it (applyCustomWidth).
		if (event.target === custom.input && !["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(event.key)) return;
		actions.menuKeydown(event, state.menu.items, actions.closeMenu, chooseDeviceItem);
	});

	return { focusSize, renderDevice, closeDeviceMenu, startSizes };
}
