// The inspector postMessage protocol, as the canvas receives it. Artboards run in
// iframes sandboxed with scripts only, so each one has an opaque origin; messages
// are trusted only by matching event.source to a known artboard's frame or, in All
// sizes, one of its size frames (canvas-sizes.js). The canvas's own messages to
// artboards (gd:mode, gd:focus, gd:size, gd:pins, gd:pick-at, gd:hover-at, gd:highlight,
// gd:clear) are posted by the module that owns each state.

export function init(ctx) {
	const { win, els, store, api, actions } = ctx;
	const { state } = store;
	const { isFiniteNumber } = api;

	/** The board frame or size frame that posted `event`, or null: nothing else is trusted. */
	function surfaceOf(event) {
		const sent = (candidate) => candidate.frame.contentWindow === event.source;
		const inBoard = (board) => (sent(board) ? board : board.sizeFrames.find(sent) ?? null);
		const system = state.systemBoard ? inBoard(state.systemBoard) : null;
		if (system) return system;
		for (const board of state.boards) {
			const surface = inBoard(board);
			if (surface) return surface;
		}
		return null;
	}

	win.addEventListener("message", (event) => {
		// Shift+Esc inside the compared artboard leaves Compare; nothing else from it is trusted.
		if (state.compare && event.source === state.compare.artboardFrame.contentWindow) {
			if (event.data && typeof event.data === "object" && event.data.type === "gd:exit-focus") actions.exitCompare(true);
			return;
		}
		const surface = surfaceOf(event);
		if (!surface || !event.data || typeof event.data !== "object") return;
		const board = actions.ownerOf(surface);
		const data = event.data;
		if (data.type === "gd:pick") {
			// The system board never takes comments, even if its page posts a pick.
			if (!state.commenting || board.system || (state.focus && board !== state.focus)) return;
			// A pick the page made before it heard of the frame's latest size (gd:size) belongs to a size the frame
			// no longer has: the comment would record the wrong one, so it opens nothing (canvas-sizes.js resized).
			if (data.generation !== surface.generation) return;
			const pick = actions.readPick(data);
			if (pick) actions.openPopover(surface, pick);
		} else if (data.type === "gd:wheel") {
			if (![data.deltaX, data.deltaY, data.deltaMode, data.x, data.y].every(isFiniteNumber)) return;
			const frameRect = surface.frame.getBoundingClientRect();
			const scale = frameRect.width / surface.viewWidth || 1;
			actions.handleWheel(data.deltaX, data.deltaY, data.deltaMode, data.zoom === true, data.shift === true, frameRect.left + data.x * scale, frameRect.top + data.y * scale);
		} else if (data.type === "gd:pin-rects") {
			if (board.system) return;
			const rects = actions.readRects(data);
			if (!rects) return;
			const detachedBefore = actions.detachedKey();
			surface.rects = rects;
			actions.renderPins(surface);
			// Re-render the list only when a badge changes, so keyboard focus in it survives.
			// Only the artboard's own frame says whether a comment is detached.
			if (actions.detachedKey() !== detachedBefore) actions.renderList();
		} else if (data.type === "gd:overflow") {
			if (board.system || typeof data.overflow !== "boolean" || !isFiniteNumber(data.width) || !isFiniteNumber(data.scrollWidth)) return;
			// A report for another width is a late one from before the frame was resized.
			if (Math.round(data.width) !== surface.viewWidth) return;
			actions.setOverflow(surface, data.overflow ? { scrollWidth: data.scrollWidth } : null);
		} else if (data.type === "gd:escape") {
			if (!els.popover.hidden) actions.closePopover();
			else if (state.commenting) actions.setCommenting(false);
		} else if (data.type === "gd:exit-focus") {
			// Only the focused artboard may end its own focus mode.
			if (board === state.focus) actions.exitFocus();
		}
	});

	return {};
}
