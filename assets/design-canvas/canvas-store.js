// The canvas state and the only functions that change it. `store.state` reads
// the live values through getters: nothing is copied or frozen per read, so the
// wheel and pan paths stay cheap, and assigning to it throws. Each mutator
// changes one concern; a patch naming a field of another concern is refused
// whole, before any field changes.
//
// The values are shared, not copied: boards and the Compare object stay objects
// that their owning module may still change in place (board.rects, board.viewWidth
// and board.viewHeight in canvas-messages.js, canvas-focus.js and canvas-boards.js;
// board.overflow, board.sizeFrames and board.sizesView, the All sizes frames, and
// each size frame's own overflow in canvas-sizes.js, whose setOverflow is the only way
// canvas-messages.js and canvas-focus.js change an overflow; board.generation in canvas-sizes.js,
// whose resized is the only way canvas-focus.js changes it; each size frame's own rects
// in canvas-sizes.js, canvas-messages.js and canvas-boards.js; compare.loaded in canvas-compare.js). Comments and handoffs are plain data
// with no such owner, so setComments and setHandoffs freeze them once, when they
// are set (never on read): changing them means setting new values.

// The first view sits FIT_PADDING (canvas-view.js) from the viewport's top left.
const START_OFFSET = 48;

/** initial: the design to show first, `{ slug }` (null: the system-only view). */
export function createStore(initial = {}) {
	const state = {
		slug: typeof initial.slug === "string" ? initial.slug : null,
		manifest: null,
		boards: [],
		systemBoard: null,
		zoom: 1,
		// True while the view is the one Fit gave; a resize then fits again (refit).
		fitted: false,
		x: START_OFFSET,
		y: START_OFFSET,
		commenting: false,
		pick: null,
		// The one screenshot of the open popover: { mimeType, data: base64 }, or null.
		shot: null,
		shotToken: 0,
		closeTimer: 0,
		comments: freezeComments([]),
		filter: "open",
		// canvas-boot.js restores the stored send mode before anything reads it.
		mode: "send",
		activeId: null,
		designCount: 0,
		// The focused board, and the view to restore when focus mode ends.
		focus: null,
		savedView: null,
		savedPanel: null,
		// The focused artboard's screen size (canvas-sizes.js): { kind: "phone" | "tablet" | "desktop" | "all" }
		// or { kind: "custom", width }. Every focus session starts at Desktop.
		size: Object.freeze({ kind: "desktop" }),
		hoverBoard: null,
		// The handoffs.json of design `slug`; boards of another design ignore it.
		handoffs: freezeHandoffs({ slug: null, chosen: null, handoffs: {} }),
		// The open Compare view: { board, preview, artboardFrame, timer }.
		compare: null,
		toastTimer: 0,
		// The open menu (canvas-menu.js): { button, root, items, byItem }, or null; root is the menu's element
		// (#gd-menu, or #gd-device-menu for the screen sizes), so one menu at a time is open.
		menu: null,
		// Where the boards sit (canvas-layout.js): { slug, view (which read of it this is), arrangement, positions, saved (what layout.json is known to hold), unsaved (its last save failed) } for the design
		// shown, or null (the system-only view); replaced whole on every change, never changed in place.
		layout: null,
		// The artboard pressed last (outlined until a press elsewhere or Esc), or null.
		selected: null,
		// True while Space is held: every press on the canvas pans.
		space: false,
		// The minimap shows (M toggles it).
		minimap: true,
	};
	const read = Object.freeze(Object.defineProperties({}, Object.fromEntries(Object.keys(state).map((key) => [key, { enumerable: true, get: () => state[key] }]))));

	/** A mutator that assigns the given fields, all of them part of one concern. */
	const patch = (concern, keys) => (values) => {
		for (const key in values) {
			if (!keys.includes(key)) throw new TypeError(`${concern} cannot change ${key}`);
		}
		for (const key in values) state[key] = key === "comments" ? freezeComments(values[key]) : values[key];
	};

	return Object.freeze({
		state: read,
		/** The selected design, its manifest and boards, the system board and the design count. */
		setDesign: patch("setDesign", ["slug", "manifest", "boards", "systemBoard", "designCount"]),
		/** Zoom and pan; `fitted` while the view is the one Fit gave. */
		setView: patch("setView", ["zoom", "x", "y", "fitted"]),
		/** The focused board, its screen size, and the view and panel to restore when focus mode ends. */
		setFocus: patch("setFocus", ["focus", "savedView", "savedPanel", "size"]),
		setHover(board) { state.hoverBoard = board; },
		setCommenting(enabled) { state.commenting = enabled; },
		/** The design's comments, the active one and the list filter. */
		setComments: patch("setComments", ["comments", "activeId", "filter"]),
		setMode(mode) { state.mode = mode; },
		/** The open popover's pick and screenshot, the read token and the close timer. */
		setPopover: patch("setPopover", ["pick", "shot", "shotToken", "closeTimer"]),
		setHandoffs(handoffs) { state.handoffs = freezeHandoffs(handoffs); },
		setCompare(compare) { state.compare = compare; },
		setToastTimer(timer) { state.toastTimer = timer; },
		/** The open shared menu, or null when none is open. */
		setMenu(menu) { state.menu = menu; },
		/** The layout of the design shown. */
		setLayout: patch("setLayout", ["layout"]),
		setSelected(board) { state.selected = board; },
		setSpace(space) { state.space = space; },
		setMinimap(show) { state.minimap = show; },
	});
}

/** Freezes the comment list and each comment, so only setComments changes them. */
function freezeComments(comments) {
	if (Array.isArray(comments)) comments.forEach(freezeObject);
	return freezeObject(comments);
}

/** Freezes the handoffs, their map and each entry, so only setHandoffs changes them. */
function freezeHandoffs(handoffs) {
	if (handoffs && typeof handoffs === "object" && handoffs.handoffs && typeof handoffs.handoffs === "object") {
		Object.values(handoffs.handoffs).forEach(freezeObject);
		freezeObject(handoffs.handoffs);
	}
	return freezeObject(handoffs);
}

function freezeObject(value) {
	return value && typeof value === "object" ? Object.freeze(value) : value;
}
