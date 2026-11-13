// Navigation and focus modes: the shield hover, activating a board, focus mode at
// 100% with centerFocus, and the Back to canvas button. The focused artboard's frame
// has the screen size canvas-sizes.js gives it (focusSize), and All sizes lays its size frames
// out below the artboard's label (layoutSizes).

// canvas-layout S5: an open artboard keeps 8 px from the viewport's edges, and 48 px below it for the
// floating "Back to canvas" button (32 px high, 8 px from the bottom).
const FOCUS_MARGIN = 8;
const BACK_SPACE = 48;
// Every focus session starts at Desktop.
const DESKTOP = Object.freeze({ kind: "desktop" });

// The mode chip in the top bar, in English; canvas-i18n-es.js has the Spanish.
const TEXT = Object.freeze({
	navigating: "Navigating",
	using: (title) => `Using: ${title} · Shift+Esc to exit`,
});

export function init(ctx) {
	const { els, store, actions } = ctx;
	const { state } = store;
	const T = ctx.i18n.text("focus", TEXT);

	function allBoards() {
		return state.systemBoard ? [state.systemBoard, ...state.boards] : state.boards;
	}

	function boardOfShield(shield) {
		return allBoards().find((board) => board.shield === shield) ?? null;
	}

	/** A viewport point in the artboard's own CSS pixels. */
	function framePoint(board, clientX, clientY) {
		const rect = board.frame.getBoundingClientRect();
		const scale = rect.width / board.viewWidth || 1;
		return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
	}

	function activateBoard(board, clientX, clientY) {
		// A board a reload replaced since the press is no longer on the canvas.
		if (!allBoards().includes(board)) return;
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
		// The token inspector's panel floats over the canvas: the pointer on it keeps the hovered element.
		if (els.inspector.contains(event.target)) return;
		const shield = event.target.closest(".gd-shield");
		const board = shield ? boardOfShield(shield) : null;
		setHoverBoard(board && !board.system ? board : null);
		if (state.hoverBoard) state.hoverBoard.frame.contentWindow?.postMessage({ type: "gd:hover-at", ...framePoint(board, event.clientX, event.clientY) }, "*");
	}

	/** A board's frame or one of its size frames (canvas-sizes.js): focused with its artboard. */
	function sendFocus(surface) {
		surface.frame.contentWindow?.postMessage({ type: "gd:focus", enabled: actions.ownerOf(surface) === state.focus }, "*");
	}

	/**
	 * The artboard's visible size: its manifest size, or the focused screen size, its height
	 * clipped to the viewport while that is taller. A report of horizontal overflow belongs to
	 * one width, so a new width clears it until the page reports again; any new size starts a new
	 * generation, so a pick the page made at the old one is refused (canvas-sizes.js resized).
	 */
	function setFrameSize(board, width, height) {
		const changed = board.viewWidth !== width || board.viewHeight !== height;
		if (board.viewWidth !== width) {
			board.viewWidth = width;
			board.frame.style.width = `${width}px`;
			actions.setOverflow(board, null);
		}
		board.viewHeight = height;
		board.frame.style.height = `${height}px`;
		if (changed) actions.resized(board);
	}

	/** The width a focused artboard has beside the margins: Desktop fills it (canvas-layout S8). */
	function focusRoom() {
		return Math.floor(els.viewport.getBoundingClientRect().width - FOCUS_MARGIN * 2);
	}

	/**
	 * 100% zoom with the focused artboard centered at its screen size and its label (Implement
	 * this) in view. A wider artboard keeps its real width and is drawn smaller to fit the
	 * viewport (the zoom says how much), since the canvas cannot pan in focus mode.
	 * A taller artboard is top-aligned and its frame is clipped to the viewport, so it
	 * scrolls inside like a browser window instead of leaving its bottom out of reach.
	 * All sizes keeps the label at 100% at the top left and fits the size frames below it.
	 */
	function centerFocus(options) {
		const board = state.focus;
		if (!board) return;
		// The artboard moves under the token inspector's panel (a layout change, a resize): it would sit misplaced. A
		// language switch (`keepInspector`) moves it only by a label's height, so the panel is placed again instead.
		const keep = Boolean(options) && options.keepInspector === true;
		if (!keep) actions.hideInspector();
		const viewport = els.viewport.getBoundingClientRect();
		const { width, height } = actions.focusSize(board);
		// The label above the frame wraps at the frame's width: apply the width before measuring it.
		setFrameSize(board, width, board.viewHeight);
		// Layout offsets inside the world ignore its transform, so re-centering is idempotent
		// (a scaled bounding rect carries sub-pixel error that shifted the board by 1 px). The artboard
		// sits where the layout put it, and its frame box below its label, inside it.
		const box = board.frame.parentElement;
		const left = board.wrapper.offsetLeft + box.offsetLeft;
		const top = board.wrapper.offsetTop + box.offsetTop;
		const labelSpace = box.offsetTop;
		const all = state.size.kind === "all";
		// Screen pixels per artboard pixel: 1 when it fits beside the margins.
		const zoom = all ? 1 : Math.min(1, (viewport.width - FOCUS_MARGIN * 2) / width);
		const minTop = FOCUS_MARGIN + labelSpace * zoom;
		const available = viewport.height - minTop - BACK_SPACE;
		const tall = all || height * zoom > available;
		setFrameSize(board, width, tall ? Math.max(120, Math.floor(available / zoom)) : height);
		store.setView({
			zoom,
			x: Math.round(!all && width * zoom + FOCUS_MARGIN * 2 <= viewport.width ? (viewport.width - width * zoom) / 2 - left * zoom : FOCUS_MARGIN - left * zoom),
			y: Math.round((tall ? minTop : Math.max(minTop, (viewport.height - height * zoom) / 2)) - top * zoom),
		});
		actions.applyView();
		// The size frames sit a margin below the label, beside the margins and above the Back to canvas band.
		actions.layoutSizes(board, { top: minTop + FOCUS_MARGIN, side: FOCUS_MARGIN, bottom: BACK_SPACE, width: viewport.width, height: viewport.height });
		actions.renderDevice();
		if (keep) actions.placeInspector();
	}

	/** Shields, hidden and inert boards, toolbar controls and the mode label follow state.focus. */
	function applyFocusState() {
		const focused = state.focus;
		els.viewport.classList.toggle("gd-focused", Boolean(focused));
		for (const board of allBoards()) {
			const active = board === focused;
			board.wrapper.classList.toggle("gd-focus-board", active);
			board.wrapper.inert = Boolean(focused) && !active;
			board.shield.hidden = active;
			if (!active) {
				// Leaving focus mode, or focusing another artboard, restores the manifest size and drops the size frames.
				if (board.viewWidth !== board.artboard.width || board.viewHeight !== board.artboard.height) setFrameSize(board, board.artboard.width, board.artboard.height);
				actions.removeSizeFrames(board);
			}
			actions.renderOverflow(board);
			actions.surfacesOf(board).forEach(sendFocus);
		}
		// The device menu belongs to the artboard it opened on.
		actions.closeDeviceMenu();
		actions.renderDevice();
		for (const control of [els.zoomOut, els.zoomIn, els.fit]) control.disabled = Boolean(focused);
		// The rail's Overview sits under Compare: a reload while it is open must not turn it back on.
		els.railFit.disabled = Boolean(focused || state.compare);
		els.design.disabled = Boolean(focused) || state.designCount === 0;
		els.back.hidden = !focused;
		renderNavMode();
		els.navMode.classList.toggle("gd-using", Boolean(focused));
		actions.renderArrange();
		actions.renderMinimap();
	}

	/** The mode chip: navigating, or the artboard in use. */
	function renderNavMode() {
		els.navMode.textContent = state.focus ? T.using(state.focus.artboard.title) : T.navigating;
	}

	function enterFocus(board) {
		if (state.focus === board) return;
		if (!state.focus) {
			// Desktop fills the viewport's width at 100%; hiding the panel gains room for it.
			store.setFocus({ savedView: { zoom: state.zoom, x: state.x, y: state.y }, savedPanel: !els.panel.hidden });
			actions.setPanel(false);
		}
		actions.closePopover();
		setHoverBoard(null);
		actions.selectBoard(null);
		store.setFocus({ focus: board, size: DESKTOP });
		centerFocus();
		applyFocusState();
		board.frame.focus();
	}

	function exitFocus() {
		if (!state.focus) return;
		actions.closePopover();
		store.setFocus({ focus: null, size: DESKTOP });
		if (state.savedPanel !== null) actions.setPanel(state.savedPanel);
		store.setFocus({ savedPanel: null });
		if (state.savedView) store.setView(state.savedView);
		store.setFocus({ savedView: null });
		actions.applyView();
		applyFocusState();
		els.viewport.focus();
	}

	els.back.addEventListener("click", exitFocus);

	return { allBoards, boardOfShield, activateBoard, setHoverBoard, hoverAt, sendFocus, setFrameSize, focusRoom, centerFocus, applyFocusState, enterFocus, exitFocus, relabel: renderNavMode };
}
