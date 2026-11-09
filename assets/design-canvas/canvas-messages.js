// The inspector postMessage protocol, as the canvas receives it. Artboards run in
// iframes sandboxed with scripts only, so each one has an opaque origin; messages
// are trusted only by matching event.source to a known artboard. The canvas's own
// messages to artboards (gd:mode, gd:focus, gd:pins, gd:pick-at, gd:hover-at,
// gd:highlight, gd:clear) are posted by the module that owns each state.

export function init(ctx) {
	const { win, els, store, api, actions } = ctx;
	const { state } = store;
	const { isFiniteNumber } = api;

	win.addEventListener("message", (event) => {
		// Shift+Esc inside the compared artboard leaves Compare; nothing else from it is trusted.
		if (state.compare && event.source === state.compare.artboardFrame.contentWindow) {
			if (event.data && typeof event.data === "object" && event.data.type === "gd:exit-focus") actions.exitCompare(true);
			return;
		}
		const system = state.systemBoard && state.systemBoard.frame.contentWindow === event.source ? state.systemBoard : null;
		const board = system ?? state.boards.find((candidate) => candidate.frame.contentWindow === event.source);
		if (!board || !event.data || typeof event.data !== "object") return;
		const data = event.data;
		if (data.type === "gd:pick") {
			// The system board never takes comments, even if its page posts a pick.
			if (!state.commenting || board.system || (state.focus && board !== state.focus)) return;
			const pick = actions.readPick(data);
			if (pick) actions.openPopover(board, pick);
		} else if (data.type === "gd:wheel") {
			if (![data.deltaX, data.deltaY, data.deltaMode, data.x, data.y].every(isFiniteNumber)) return;
			const frameRect = board.frame.getBoundingClientRect();
			const scale = frameRect.width / board.artboard.width || 1;
			actions.handleWheel(data.deltaX, data.deltaY, data.deltaMode, data.zoom === true, data.shift === true, frameRect.left + data.x * scale, frameRect.top + data.y * scale);
		} else if (data.type === "gd:pin-rects") {
			if (board.system) return;
			const rects = actions.readRects(data);
			if (!rects) return;
			const detachedBefore = actions.detachedKey();
			board.rects = rects;
			actions.renderPins(board);
			// Re-render the list only when a badge changes, so keyboard focus in it survives.
			if (actions.detachedKey() !== detachedBefore) actions.renderList();
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
