// Screen sizes in focus mode: the top bar's device button and its menu (Phone,
// Tablet, Desktop, All sizes and a custom width), and the size each one gives the focused
// artboard's frame (focusSize, which canvas-focus.js centers). A size resizes the
// frame in place, so the design's own media queries respond; nothing reloads.
// The size lives in the store (setFocus), and the menu is the shared one
// (canvas-menu.js) with its own element, #gd-device-menu.
//
// All sizes shows the focused artboard at Phone, Tablet and as designed at once: a real iframe per
// size ("size frame") at its true width, scaled together outside the world. A board and its size
// frames are its "surfaces": each takes picks, shows pins, reports overflow and records the size a
// comment was made at (viewportOf), so the other modules handle a size frame as they handle a board.
// This module owns the board fields it changes in place (canvas-store.js): board.sizeFrames,
// board.sizesView, board.overflow and board.generation, and each size frame's own rects and overflow. The other
// modules change a frame's overflow only through setOverflow, and its generation only through resized.
//
// A frame's generation counts the sizes it has had. The canvas tells the frame's page (gd:size) when it loads and
// whenever the frame changes size, and the page tags each pick with the generation it heard last: a pick made before
// a resize, whose reply arrives after it, carries an older one and is refused (canvas-messages.js), so a comment is
// never sent with a size it was not made at. The same message tells the page that the canvas dropped its overflow
// report, so the page reports again even when its answer did not change.

// Every string the sizes show, in English; canvas-i18n-es.js has the Spanish. Artboard titles stay as written.
const TEXT = Object.freeze({
	group: "Preview size",
	phone: "Phone",
	tablet: "Tablet",
	desktop: "Desktop",
	all: "All sizes",
	allTitle: "All sizes: Phone, Tablet and the artboard as designed, side by side",
	designed: "As designed",
	custom: "Custom",
	customAria: "Custom width in pixels",
	customGroup: "Custom width",
	error: (min, max) => `Enter a whole number from ${min} to ${max} (px).`,
	itemTitle: (name, width, height) => `${name} ${width} × ${height}`,
	button: (size) => `Preview size: ${size}`,
	buttonTitle: "Preview size of the open artboard",
	buttonOff: "Open an artboard to choose its preview size",
	frameAria: (name, width, height) => `${name} ${width} by ${height}`,
	frameTitle: (title, name, width, height) => `${title} artboard at ${name} ${width} × ${height}`,
	designedTitle: (title, width, height) => `${title} artboard as designed, ${width} × ${height}`,
	scale: (percent) => `· ${percent}%`,
	overflow: "Overflows",
	overflowNote: (width) => `Content is wider than ${width} px, so part of it is cut off or needs sideways scrolling at this size.`,
	madeAt: (label) => `Made at ${label}`,
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
const SIZE_ICONS = { phone: "i-phone", tablet: "i-tablet", desktop: "i-monitor", all: "i-devices", custom: "i-width" };
// All sizes' third frame is the artboard at its own size in design.json, not a device: it wears the artboard frame icon.
const DESIGNED_ICON = "i-fit";
// What comments.json accepts for the size a comment was made at (lib/design-comments.ts).
const VIEWPORT_LIMITS = { minWidth: 240, maxWidth: 4096, minHeight: 1, maxHeight: 20000 };
// All sizes: the gap between the frames, the band each label takes above its frame, and the smallest scale.
const SIZES_GAP = 20;
const SIZES_HEAD = 28;
const MIN_SIZES_SCALE = 0.05;

export function init(ctx) {
	const { doc, els, store, actions } = ctx;
	const { state } = store;
	const T = ctx.i18n.text("sizes", TEXT);

	const nameOf = (kind) => T[kind] ?? T.desktop;
	const dims = (size) => `${size.width} × ${size.height}`;

	/** Desktop: the viewport's whole width at 100%, never narrower than the artboard was designed. */
	function desktopSize(board) {
		return { width: Math.max(board.artboard.width, actions.focusRoom()), height: board.artboard.height };
	}

	function presetSize(board, preset) {
		return preset.kind === "desktop" ? desktopSize(board) : { width: preset.width, height: preset.height };
	}

	/** The artboard's own size in design.json. */
	function manifestSize(board) {
		return { width: board.artboard.width, height: board.artboard.height };
	}

	/**
	 * What the focused size means for `board`: its frame's width and height before the viewport clips a tall one.
	 * All sizes keeps the artboard's own frame (hidden behind the size frames) at its manifest size.
	 */
	function focusSize(board) {
		const size = state.size;
		if (size.kind === "custom") return { width: size.width, height: board.artboard.height };
		if (size.kind === "all") return manifestSize(board);
		return presetSize(board, SIZE_PRESETS.find((preset) => preset.kind === size.kind) ?? SIZE_PRESETS[2]);
	}

	/** The board's own frame, then the size frames All sizes adds: every one takes picks and shows pins the same way. */
	function surfacesOf(board) {
		return board.sizeFrames.length > 0 ? [board, ...board.sizeFrames] : [board];
	}

	/** The artboard a frame belongs to: a board is its own, a size frame names its board. */
	function ownerOf(surface) {
		return surface.board ?? surface;
	}

	/**
	 * The device button: the icon and short name of the focused size and its width × height.
	 * Outside focus mode it is off: the sizes act on an open artboard only (canvas-layout S6).
	 */
	function renderDevice() {
		const board = state.focus;
		const kind = board && SIZE_ICONS[state.size.kind] ? state.size.kind : "desktop";
		const name = nameOf(kind);
		// All sizes has no one size to name.
		const size = board && kind !== "all" ? dims(focusSize(board)) : "";
		els.deviceIcon.setAttribute("href", `#${SIZE_ICONS[kind]}`);
		els.deviceName.textContent = name;
		els.deviceSize.textContent = size;
		els.device.disabled = !board;
		els.device.title = board ? T.buttonTitle : T.buttonOff;
		els.device.setAttribute("aria-label", T.button(size ? `${name} ${size}` : name));
	}

	/** A span with a class and text. */
	function chip(className, text) {
		const span = doc.createElement("span");
		span.className = className;
		span.textContent = text;
		return span;
	}

	/** One radio item of the device menu: icon, name, its size for the focused artboard (none for All sizes) and a check when it is the current one. */
	function deviceItem(kind, title, size) {
		const item = doc.createElement("button");
		item.type = "button";
		item.className = "gd-menu-item gd-device-item";
		item.setAttribute("role", "menuitemradio");
		item.setAttribute("aria-checked", String(state.size.kind === kind));
		item.setAttribute("tabindex", "-1");
		item.dataset.size = kind;
		item.title = title;
		item.append(actions.icon(SIZE_ICONS[kind], "gd-i gd-i-s"), chip("gd-menu-label", nameOf(kind)));
		if (size) item.append(chip("gd-device-dim", dims(size)));
		item.append(actions.icon("i-check", "gd-i gd-i-s gd-device-check"));
		item.addEventListener("click", () => chooseDeviceItem(item));
		return item;
	}

	function presetItem(board, preset) {
		const size = presetSize(board, preset);
		return deviceItem(preset.kind, T.itemTitle(nameOf(preset.kind), size.width, size.height), size);
	}

	// The open menu's width field and its error line; null while the device menu is closed.
	let custom = null;

	/**
	 * The device menu, built when it opens: Phone, Tablet, Desktop and All sizes as radio items, then the
	 * custom width field. The arrows reach the field as the last entry; inside it the other keys stay with the field.
	 */
	function openDeviceMenu(last) {
		const board = state.focus;
		if (!board) return;
		const items = [...SIZE_PRESETS.map((preset) => presetItem(board, preset)), deviceItem("all", T.allTitle, null)];
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
		input.setAttribute("aria-label", T.customAria);
		input.setAttribute("min", String(CUSTOM_WIDTH.min));
		input.setAttribute("max", String(CUSTOM_WIDTH.max));
		input.setAttribute("step", "1");
		input.setAttribute("inputmode", "numeric");
		input.value = state.size.kind === "custom" ? String(state.size.width) : "";
		const unit = chip("gd-device-unit", "px");
		unit.setAttribute("aria-hidden", "true");
		row.append(actions.icon(SIZE_ICONS.custom, "gd-i gd-i-s"), chip("gd-device-custom-label", T.custom), input, unit);
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
		group.setAttribute("aria-label", T.customGroup);
		group.append(row, error);
		actions.openMenu(els.device, els.deviceMenu, [...items, separator, group], [...items, input], T.group, last ? input : items[0]);
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
			error.textContent = T.error(CUSTOM_WIDTH.min, CUSTOM_WIDTH.max);
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
		// A check's ring was drawn for the frame at its old size.
		actions.clearMark();
		store.setFocus({ size: Object.freeze(size) });
		// centerFocus lays the frames out for the size (layoutSizes): All sizes adds its frames, another size removes them.
		actions.centerFocus();
	}

	// ---- All sizes: a frame per size, registered like the board's own frame

	/**
	 * The sizes All sizes shows: Phone and Tablet, and the artboard as designed, at its own size in design.json
	 * (L12: labelled by what it is, never Desktop; side by side, nothing fills the window).
	 */
	function allSizes(board) {
		return SIZE_PRESETS.map((preset) => (preset.kind === "desktop" ? { kind: "designed", ...manifestSize(board) } : { kind: preset.kind, ...presetSize(board, preset) }));
	}

	/**
	 * Brings `board`'s size frames in line with the focused size, from canvas-focus.js's centerFocus: the
	 * focused board in All sizes gets them, laid out in `box` (the viewport's size, the margins kept free
	 * and the top below the artboard's label); any other loses them. Its own chip follows the size.
	 */
	function layoutSizes(board, box) {
		if (state.focus === board && state.size.kind === "all") {
			if (!board.sizesView) createSizeFrames(board);
			placeSizeFrames(board, box);
		} else removeSizeFrames(board);
		renderOverflow(board);
	}

	/** A real iframe per size at its true width (so the design's media queries apply), shown outside the world. */
	function createSizeFrames(board) {
		const view = doc.createElement("div");
		view.className = "gd-sizes-all";
		view.classList.toggle("gd-commenting", state.commenting && !board.system);
		view.setAttribute("role", "group");
		board.sizeFrames = allSizes(board).map((size) => createSizeFrame(board, size));
		view.append(...board.sizeFrames.map((surface) => surface.root));
		board.sizesView = view;
		labelSizesView(board);
		board.wrapper.classList.add("gd-all-sizes");
		els.viewport.append(view);
	}

	function createSizeFrame(board, { kind, width, height }) {
		const root = doc.createElement("section");
		root.className = "gd-size-frame";
		const head = doc.createElement("div");
		head.className = "gd-size-head";
		const scaleLabel = chip("gd-size-scale", "");
		const nameLabel = chip("gd-size-name", "");
		const designed = kind === "designed";
		head.append(actions.icon(designed ? DESIGNED_ICON : SIZE_ICONS[kind], "gd-i gd-i-s"), nameLabel, chip("gd-size-dim", dims({ width, height })), scaleLabel);
		const scaled = doc.createElement("div");
		scaled.className = "gd-size-scaled";
		const stage = doc.createElement("div");
		stage.className = "gd-size-stage";
		stage.style.width = `${width}px`;
		stage.style.height = `${height}px`;
		const frame = doc.createElement("iframe");
		frame.className = "gd-size-iframe";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.style.width = `${width}px`;
		frame.style.height = `${height}px`;
		const pins = doc.createElement("div");
		pins.className = "gd-pins";
		const flag = overflowFlag();
		stage.append(frame, pins);
		scaled.append(stage, flag);
		root.append(head, scaled);
		// rects and overflow: null until this frame's page reports them (canvas-messages.js). A size frame never
		// changes size, so its generation stays 0.
		const surface = { board, kind, width, height, viewWidth: width, viewHeight: height, frame, pins, flag, rects: null, overflow: null, generation: 0, root, head, scaled, stage, scaleLabel, nameLabel, scale: null };
		labelSizeFrame(surface);
		frame.addEventListener("load", () => surfaceLoaded(surface));
		frame.src = actions.boardUrl(board);
		return surface;
	}

	/** A size frame's own text in the current language: its name, its label and its frame's title. */
	function labelSizeFrame(surface) {
		const { board, kind, width, height } = surface;
		const name = nameOf(kind);
		surface.root.setAttribute("aria-label", T.frameAria(name, width, height));
		surface.nameLabel.textContent = name;
		surface.frame.title = kind === "designed" ? T.designedTitle(board.artboard.title, width, height) : T.frameTitle(board.artboard.title, name, width, height);
	}

	/** All sizes' group name, and each frame's scale and header title once it has a scale (placeSizeFrames). */
	function labelSizesView(board) {
		board.sizesView.setAttribute("aria-label", T.all);
		for (const surface of board.sizeFrames) {
			if (surface.scale === null) continue;
			surface.scaleLabel.textContent = T.scale(Math.round(surface.scale * 100));
			surface.head.title = `${nameOf(surface.kind)} ${dims(surface)} ${surface.scaleLabel.textContent}`;
		}
	}

	/**
	 * Drops `board`'s size frames. A comment box open on one of them closes first, while that frame still
	 * shows, so it clears its outline and no later Cancel reaches a removed frame (an export, for one,
	 * leaves All sizes without setSize).
	 */
	function removeSizeFrames(board) {
		board.wrapper.classList.remove("gd-all-sizes");
		if (!board.sizesView) return;
		if (state.pick && board.sizeFrames.includes(state.pick.surface)) actions.closePopover();
		board.sizesView.remove();
		board.sizesView = null;
		board.sizeFrames = [];
		// The token inspector's panel and a check's ring go with their frame.
		actions.hideGoneInspector();
		actions.clearMark(board);
	}

	/**
	 * One scale for the frames: small enough that they fit side by side under the label and above Back to canvas.
	 * Each frame is as wide as its scaled iframe, so a label longer than that ends in an ellipsis (canvas.css) and
	 * keeps its full text in a title; the room leaves half a pixel per frame for rounding the sizes.
	 */
	function placeSizeFrames(board, box) {
		const view = board.sizesView;
		const frames = board.sizeFrames;
		view.style.left = `${box.side}px`;
		view.style.right = `${box.side}px`;
		view.style.top = `${box.top}px`;
		view.style.bottom = `${box.bottom}px`;
		const availableWidth = box.width - box.side * 2 - SIZES_GAP * (frames.length - 1) - frames.length / 2;
		const availableHeight = box.height - box.top - box.bottom - SIZES_HEAD - 0.5;
		const totalWidth = frames.reduce((sum, surface) => sum + surface.width, 0);
		const tallest = Math.max(...frames.map((surface) => surface.height));
		const scale = Math.max(MIN_SIZES_SCALE, Math.min(1, availableWidth / totalWidth, availableHeight / tallest));
		for (const surface of frames) {
			const width = `${Math.round(surface.width * scale)}px`;
			surface.root.style.width = width;
			surface.scaled.style.width = width;
			surface.scaled.style.height = `${Math.round(surface.height * scale)}px`;
			surface.stage.style.transform = `scale(${scale})`;
			// Pins keep their size at any scale, as in the world.
			surface.stage.style.setProperty("--gd-inv-zoom", String(1 / scale));
			surface.scale = scale;
		}
		labelSizesView(board);
	}

	/**
	 * A frame (the board's own or a size frame) finished loading: it knows nothing yet, so tell it the state.
	 * Its page may have reported overflow before this load event (a resource that loaded first) and, keeping
	 * unchanged answers to itself, would not report it again: gd:size, sent after the chip is cleared, asks for a
	 * fresh report, so the chip follows the page that now shows, after a reload or a navigation to another page.
	 */
	function surfaceLoaded(surface) {
		// First, so the frame's last messages stay the state below: a ring on this artboard goes, its own frame checks itself.
		actions.checksLoaded(surface);
		surface.rects = null;
		setOverflow(surface, null);
		sendSize(surface);
		actions.sendMode(surface);
		actions.sendFocus(surface);
		if (!ownerOf(surface).system) actions.sendPins(surface);
	}

	/** Tells the frame's page its size generation; it tags its picks with it and reports its overflow afresh. */
	function sendSize(surface) {
		surface.frame.contentWindow?.postMessage({ type: "gd:size", generation: surface.generation }, "*");
	}

	/** The frame changed size: a pick its page made before it hears so belongs to the old size. */
	function resized(surface) {
		surface.generation += 1;
		sendSize(surface);
	}

	// ---- the Overflows chip

	/** The "Overflows" chip of one frame, hidden until its page reports content wider than the frame (renderOverflow). */
	function overflowFlag() {
		const flag = doc.createElement("span");
		flag.className = "gd-overflow-flag";
		flag.hidden = true;
		flag.append(chip("gd-overflow-text", ""), chip("gd-visually-hidden", ""));
		labelOverflow(flag);
		return flag;
	}

	/** The chip's own word, in the current language; its note follows the report (renderOverflow). */
	function labelOverflow(flag) {
		flag.children[0].textContent = T.overflow;
	}

	/**
	 * What a frame's page last reported: `{ scrollWidth }` while its content is wider than the frame, null when it
	 * fits or has not reported for this width. The one way any module changes surface.overflow; the chip follows.
	 */
	function setOverflow(surface, overflow) {
		surface.overflow = overflow;
		renderOverflow(surface);
	}

	/**
	 * Shown while the page last reported content wider than this frame (setOverflow).
	 * The artboard's own frame shows it only at a single focused size; in All sizes each size frame has its own.
	 */
	function renderOverflow(surface) {
		const board = ownerOf(surface);
		const shown = Boolean(surface.overflow) && (surface !== board || (state.focus === board && state.size.kind !== "all"));
		surface.flag.hidden = !shown;
		if (!shown) return;
		const note = T.overflowNote(surface.viewWidth);
		surface.flag.title = note;
		surface.flag.children[1].textContent = note;
	}

	// ---- the size a comment was made at

	/**
	 * The size a pick was made at, for the comment: the focused Phone, Tablet or custom width, or the picked size
	 * frame of All sizes. Null at the artboard's own size (nothing to record), at Desktop (L12: it fills the window,
	 * so its width is the window's, not a size of the design) and when comments.json would refuse it.
	 */
	function viewportOf(surface) {
		const board = ownerOf(surface);
		let size;
		if (surface !== board) size = { width: surface.width, height: surface.height };
		else if (state.focus === board && state.size.kind !== "all" && state.size.kind !== "desktop") size = focusSize(board);
		else return null;
		if (size.width === board.artboard.width && size.height === board.artboard.height) return null;
		const { minWidth, maxWidth, minHeight, maxHeight } = VIEWPORT_LIMITS;
		const fits = size.width >= minWidth && size.width <= maxWidth && size.height >= minHeight && size.height <= maxHeight;
		return fits && Number.isInteger(size.width) && Number.isInteger(size.height) ? { width: size.width, height: size.height } : null;
	}

	/** `Phone 390 × 844`, `Tablet 820 × 1180` or `<w> × <h>`: the preset's name only for its exact size. */
	function describeViewport(viewport) {
		const preset = SIZE_PRESETS.find((candidate) => candidate.width === viewport.width && candidate.height === viewport.height);
		return preset ? `${nameOf(preset.kind)} ${dims(viewport)}` : dims(viewport);
	}

	/** The comment card's chip naming the size the comment was made at, or null for one made at the artboard's own size. */
	function viewportChip(viewport) {
		if (!viewport || typeof viewport !== "object" || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)) return null;
		const label = describeViewport(viewport);
		const element = chip("gd-comment-viewport", label);
		element.title = T.madeAt(label);
		return element;
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

	/**
	 * A new language: the device button, and every frame's text built once, in place (no frame reloads): All sizes' labels
	 * and each Overflows chip with its note. The device menu is built when it opens, so it opens in the language shown.
	 */
	function relabel() {
		renderDevice();
		for (const board of actions.allBoards()) {
			if (board.sizesView) labelSizesView(board);
			for (const surface of surfacesOf(board)) {
				if (surface !== board) labelSizeFrame(surface);
				labelOverflow(surface.flag);
				renderOverflow(surface);
			}
		}
	}

	return { relabel, focusSize, surfacesOf, ownerOf, renderDevice, closeDeviceMenu, startSizes, layoutSizes, removeSizeFrames, surfaceLoaded, resized, overflowFlag, setOverflow, renderOverflow, viewportOf, viewportChip };
}
