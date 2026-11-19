// The view transform: zoom, pan, Fit and refit, the wheel, the pointer on the canvas
// (pan, or move an artboard through canvas-layout.js), the view keys and the zoom buttons.

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const FIT_PADDING = 48;
const CLICK_SLOP = 4;

export function init(ctx) {
	const { els, store, actions } = ctx;
	const { state } = store;

	function clampZoom(value) {
		return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
	}

	function applyView() {
		els.world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
		els.world.style.setProperty("--gd-inv-zoom", String(1 / state.zoom));
		els.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
		actions.renderMinimapView();
		// An artboard's ⋯ menu would stay behind while its button moves away.
		actions.closeBoardMenu();
	}

	/** Zoom so the world point under (px, py) in viewport coordinates stays put. */
	function zoomAt(nextZoom, px, py) {
		const zoom = clampZoom(nextZoom);
		store.setView({
			x: px - (px - state.x) * (zoom / state.zoom),
			y: py - (py - state.y) * (zoom / state.zoom),
			zoom,
			fitted: false,
		});
		applyView();
		actions.closePopover();
	}

	function zoomAtCenter(factor) {
		const rect = els.viewport.getBoundingClientRect();
		zoomAt(state.zoom * factor, rect.width / 2, rect.height / 2);
	}

	function panBy(dx, dy) {
		store.setView({ x: state.x + dx, y: state.y + dy, fitted: false });
		applyView();
		actions.closePopover();
	}

	function fit() {
		if (state.focus) return;
		// A label may have grown (a handoff row, a wrapped tradeoff) since the boards were placed.
		actions.sizeWorld();
		const rect = els.viewport.getBoundingClientRect();
		const width = els.world.offsetWidth;
		const height = els.world.offsetHeight;
		if (!width || !height) return;
		const zoom = clampZoom(Math.min((rect.width - FIT_PADDING * 2) / width, (rect.height - FIT_PADDING * 2) / height, 1));
		store.setView({ zoom, x: (rect.width - width * zoom) / 2, y: Math.max(FIT_PADDING, (rect.height - height * zoom) / 2), fitted: true });
		applyView();
		actions.closePopover();
	}

	/**
	 * A fitted overview follows the viewport's size (a window that opens small, the comments panel); a zoom or pan of yours stays.
	 * While a comment is being written it waits, since fit() closes the comment box; the next size change fits again.
	 */
	function refit() {
		if (state.fitted && !state.focus && els.popover.hidden) fit();
	}

	function wheelPixels(delta, mode) {
		return mode === 1 ? delta * 16 : mode === 2 ? delta * 400 : delta;
	}

	/** Shared by native wheel events and wheel events forwarded from artboards. */
	function handleWheel(deltaX, deltaY, deltaMode, zooming, shift, clientX, clientY) {
		if (state.focus) return;
		const dx = wheelPixels(deltaX, deltaMode);
		const dy = wheelPixels(deltaY, deltaMode);
		if (zooming) {
			const rect = els.viewport.getBoundingClientRect();
			const step = Math.max(-50, Math.min(50, dy));
			zoomAt(state.zoom * Math.exp(-step * 0.01), clientX - rect.left, clientY - rect.top);
		} else if (shift && dx === 0) {
			panBy(-dy, 0);
		} else {
			panBy(-dx, -dy);
		}
	}

	els.viewport.addEventListener("wheel", (event) => {
		event.preventDefault();
		handleWheel(event.deltaX, event.deltaY, event.deltaMode, event.ctrlKey || event.metaKey, event.shiftKey, event.clientX, event.clientY);
	}, { passive: false });

	function interactiveTarget(target) {
		const editable = target.closest("[contenteditable]");
		return Boolean(target.closest("button, a, input, select, textarea, iframe") || (editable && editable.isContentEditable));
	}

	// A press on any part of an artboard that is not a control moves that artboard and selects it, saved once on
	// release; a press on the background pans and clears the selection. With Space held every press pans and
	// changes nothing else; in Comment mode a press on an artboard pans, as on the background. A shield released
	// without moving is a click on that artboard: a routed pick in Comment mode, else focus mode.
	// The press in progress is this module's own state, never shared; another pointer pressed meanwhile is ignored,
	// so it never takes over a move or a pan before its own pointer is released.
	let drag = null;
	els.viewport.addEventListener("pointerdown", (event) => {
		if (drag || state.focus || event.button !== 0 || interactiveTarget(event.target)) return;
		const target = event.target;
		const shield = target.closest(".gd-shield");
		const wrapper = target.closest(".gd-artboard");
		// Anything else in the viewport (the minimap) keeps its own press.
		if (!shield && !wrapper && target !== els.viewport && target !== els.world) return;
		event.preventDefault();
		const space = state.space;
		const board = space ? null : shield ? actions.boardOfShield(shield) : wrapper ? actions.allBoards().find((candidate) => candidate.wrapper === wrapper) ?? null : null;
		const moving = Boolean(board && !state.commenting && actions.beginMove(board));
		if (!space && !state.commenting) actions.selectBoard(moving ? board : null);
		drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, board: shield ? board : null, moving };
		els.viewport.setPointerCapture(event.pointerId);
		els.viewport.classList.add(moving ? "gd-moving" : "gd-panning");
	});
	// An old text selection can still initiate a native drag and cancel the pan.
	els.viewport.addEventListener("dragstart", (event) => {
		if (!state.focus && !interactiveTarget(event.target)) event.preventDefault();
	});
	els.viewport.addEventListener("pointermove", (event) => {
		if (!drag || drag.id !== event.pointerId) {
			if (!drag) actions.hoverAt(event);
			return;
		}
		if (Math.abs(event.clientX - drag.startX) > CLICK_SLOP || Math.abs(event.clientY - drag.startY) > CLICK_SLOP) drag.moved = true;
		if (drag.moving) {
			// A still press moves nothing.
			if (drag.moved) actions.moveBy(event.clientX - drag.startX, event.clientY - drag.startY);
			return;
		}
		panBy(event.clientX - drag.x, event.clientY - drag.y);
		drag.x = event.clientX;
		drag.y = event.clientY;
	});
	const endDrag = (event) => {
		if (!drag || drag.id !== event.pointerId) return;
		const ended = drag;
		drag = null;
		els.viewport.classList.remove("gd-panning");
		els.viewport.classList.remove("gd-moving");
		if (ended.moving) actions.endMove(event.type === "pointerup");
		if (event.type === "pointerup" && ended.board && !ended.moved) actions.activateBoard(ended.board, event.clientX, event.clientY);
	};
	els.viewport.addEventListener("pointerup", endDrag);
	els.viewport.addEventListener("pointercancel", endDrag);
	// A capture lost without a pointerup (the browser or the system took the pointer) ends the press like a cancel, so
	// a press that never ends never blocks the next one; the capture a pointerup releases comes once the press is over.
	els.viewport.addEventListener("lostpointercapture", endDrag);
	els.viewport.addEventListener("pointerleave", () => actions.setHoverBoard(null));

	els.viewport.addEventListener("keydown", (event) => {
		if (event.target !== els.viewport || state.focus) return;
		const step = event.shiftKey ? 200 : 50;
		const actions = {
			ArrowLeft: () => panBy(step, 0),
			ArrowRight: () => panBy(-step, 0),
			ArrowUp: () => panBy(0, step),
			ArrowDown: () => panBy(0, -step),
			"+": () => zoomAtCenter(1.25),
			"=": () => zoomAtCenter(1.25),
			"-": () => zoomAtCenter(0.8),
			"0": fit,
		};
		const action = actions[event.key];
		if (!action) return;
		event.preventDefault();
		action();
	});

	els.zoomIn.addEventListener("click", () => zoomAtCenter(1.25));
	els.zoomOut.addEventListener("click", () => zoomAtCenter(0.8));
	els.fit.addEventListener("click", fit);

	return { applyView, zoomAt, panBy, fit, refit, handleWheel };
}
