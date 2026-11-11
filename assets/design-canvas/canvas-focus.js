// Navigation and focus modes: the shield hover, activating a board, focus mode at
// 100% with centerFocus, and the Back to canvas button.

const FOCUS_MARGIN = 16;
// Room below a focused artboard for the floating "Back to canvas" button.
const BACK_SPACE = 64;

export function init(ctx) {
	const { els, store, actions } = ctx;
	const { state } = store;

	function allBoards() {
		return state.systemBoard ? [state.systemBoard, ...state.boards] : state.boards;
	}

	function boardOfShield(shield) {
		return allBoards().find((board) => board.shield === shield) ?? null;
	}

	/** A viewport point in the artboard's own CSS pixels. */
	function framePoint(board, clientX, clientY) {
		const rect = board.frame.getBoundingClientRect();
		const scale = rect.width / board.artboard.width || 1;
		return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
	}

	function activateBoard(board, clientX, clientY) {
		if (!state.commenting) enterFocus(board);
		else if (!board.system) board.frame.contentWindow?.postMessage({ type: "gd:pick-at", ...framePoint(board, clientX, clientY) }, "*");
	}

	function setHoverBoard(board) {
		if (state.hoverBoard && state.hoverBoard !== board) state.hoverBoard.frame.contentWindow?.postMessage({ type: "gd:hover-at", x: null, y: null }, "*");
		store.setHover(board);
	}

	/** Comment mode in navigation: the shield routes the hover to the inspector so it can outline the element. */
	function hoverAt(event) {
		if (!state.commenting || state.focus) return setHoverBoard(null);
		const shield = event.target.closest(".gd-shield");
		const board = shield ? boardOfShield(shield) : null;
		setHoverBoard(board && !board.system ? board : null);
		if (state.hoverBoard) state.hoverBoard.frame.contentWindow?.postMessage({ type: "gd:hover-at", ...framePoint(board, event.clientX, event.clientY) }, "*");
	}

	function sendFocus(board) {
		board.frame.contentWindow?.postMessage({ type: "gd:focus", enabled: board === state.focus }, "*");
	}

	/** The artboard's visible height: its manifest height, or the viewport's while focused on a taller one. */
	function setFrameHeight(board, height) {
		board.viewHeight = height;
		board.frame.style.height = `${height}px`;
	}

	/**
	 * 100% zoom with the focused artboard centered and its label (Implement this) in view.
	 * A taller artboard is top-aligned and its frame is clipped to the viewport, so it
	 * scrolls inside like a browser window instead of leaving its bottom out of reach
	 * while the canvas cannot pan.
	 */
	function centerFocus() {
		const board = state.focus;
		if (!board) return;
		const viewport = els.viewport.getBoundingClientRect();
		// Layout offsets inside the world ignore its transform, so re-centering is idempotent
		// (a scaled bounding rect carries sub-pixel error that shifted the board by 1 px).
		const box = board.frame.parentElement;
		const left = box.offsetLeft;
		const top = box.offsetTop;
		const labelSpace = box.offsetTop - board.wrapper.offsetTop;
		const { width, height } = board.artboard;
		const minTop = FOCUS_MARGIN + labelSpace;
		const available = viewport.height - minTop - BACK_SPACE;
		const tall = height > available;
		setFrameHeight(board, tall ? Math.max(120, Math.floor(available)) : height);
		store.setView({
			zoom: 1,
			x: Math.round(width + FOCUS_MARGIN * 2 <= viewport.width ? (viewport.width - width) / 2 - left : FOCUS_MARGIN - left),
			y: Math.round((tall ? minTop : Math.max(minTop, (viewport.height - height) / 2)) - top),
		});
		actions.applyView();
	}

	/** Shields, dimming, inert boards, toolbar controls and the mode label follow state.focus. */
	function applyFocusState() {
		const focused = state.focus;
		els.viewport.classList.toggle("gd-focused", Boolean(focused));
		for (const board of allBoards()) {
			const active = board === focused;
			board.wrapper.classList.toggle("gd-focus-board", active);
			board.wrapper.inert = Boolean(focused) && !active;
			board.shield.hidden = active;
			if (!active && board.viewHeight !== board.artboard.height) setFrameHeight(board, board.artboard.height);
			sendFocus(board);
		}
		for (const control of [els.zoomOut, els.zoomIn, els.fit]) control.disabled = Boolean(focused);
		// The rail's Overview sits under Compare: a reload while it is open must not turn it back on.
		els.railFit.disabled = Boolean(focused || state.compare);
		els.design.disabled = Boolean(focused) || state.designCount === 0;
		els.back.hidden = !focused;
		els.navMode.textContent = focused ? `Using: ${focused.artboard.title} · Shift+Esc to exit` : "Navigating";
		els.navMode.classList.toggle("gd-using", Boolean(focused));
	}

	function enterFocus(board) {
		if (state.focus === board) return;
		if (!state.focus) {
			// The artboard keeps its designed width at 100%; hiding the panel gains room for it.
			store.setFocus({ savedView: { zoom: state.zoom, x: state.x, y: state.y }, savedPanel: !els.panel.hidden });
			actions.setPanel(false);
		}
		actions.closePopover();
		setHoverBoard(null);
		store.setFocus({ focus: board });
		centerFocus();
		applyFocusState();
		board.frame.focus();
	}

	function exitFocus() {
		if (!state.focus) return;
		actions.closePopover();
		store.setFocus({ focus: null });
		if (state.savedPanel !== null) actions.setPanel(state.savedPanel);
		store.setFocus({ savedPanel: null });
		if (state.savedView) store.setView(state.savedView);
		store.setFocus({ savedView: null });
		actions.applyView();
		applyFocusState();
		els.viewport.focus();
	}

	els.back.addEventListener("click", exitFocus);

	return { allBoards, boardOfShield, activateBoard, setHoverBoard, hoverAt, sendFocus, setFrameHeight, centerFocus, applyFocusState, enterFocus, exitFocus };
}
