// The minimap at the viewport's bottom right: every board drawn small where the layout
// puts it, the visible area as an outlined rectangle, and a click or drag in it to move
// the view there. M (a single key of the rail) shows or hides it.

// The map box in CSS px (canvas.css gives .gd-minimap-map the same size), the pad kept
// free around the blocks, the smallest block drawn, and the smallest visible-area outline.
const MINIMAP = Object.freeze({ width: 204, height: 96, pad: 6, minBlock: 2, minView: 4 });

// Every string this module shows, in English; canvas-i18n-es.js has the Spanish (its own plural).
const TEXT = Object.freeze({
	label: (count) => `Position of the visible area among ${count} artboard${count === 1 ? "" : "s"}. Click or drag to move the view.`,
});

const rounded = (value) => `${Number(value.toFixed(2))}px`;

export function init(ctx) {
	const { doc, els, store, actions } = ctx;
	const { state } = store;
	const T = ctx.i18n.text("minimap", TEXT);

	// This module's own state: the block of each board, and what the last full render measured (where the world's
	// (0, 0) lands in the map and how big a world px is there; the viewport's size), so a pan or a wheel only
	// moves the outline and never reads a board's layout or measures the viewport.
	const blocks = new Map();
	let map = null;
	let viewport = null;
	let dragging = null;

	function measureViewport() {
		const rect = els.viewport.getBoundingClientRect();
		viewport = { width: rect.width, height: rect.height };
	}

	/** The boards on the canvas, in the world's order. */
	function placedBoards() {
		return actions.allBoards().filter((board) => board.wrapper.parentElement === els.world && board.wrapper.layoutAt);
	}

	/** The boards' bounds fitted to the map, keeping their aspect, centered. */
	function scaleOf(rects) {
		const minX = Math.min(...rects.map((rect) => rect.x));
		const minY = Math.min(...rects.map((rect) => rect.y));
		const width = Math.max(1, Math.max(...rects.map((rect) => rect.x + rect.width)) - minX);
		const height = Math.max(1, Math.max(...rects.map((rect) => rect.y + rect.height)) - minY);
		const scale = Math.min((MINIMAP.width - MINIMAP.pad * 2) / width, (MINIMAP.height - MINIMAP.pad * 2) / height);
		return { scale, x: (MINIMAP.width - width * scale) / 2 - minX * scale, y: (MINIMAP.height - height * scale) / 2 - minY * scale };
	}

	function blockOf(board) {
		let block = blocks.get(board.wrapper);
		if (!block) {
			block = doc.createElement("span");
			block.className = "gd-minimap-block";
			block.setAttribute("aria-hidden", "true");
			blocks.set(board.wrapper, block);
		}
		return block;
	}

	/**
	 * The boards and the visible area, drawn small: hidden when switched off, while an artboard is in use, in Compare
	 * and with no boards. Blocks are plain boxes; each artboard's own shield stays the keyboard path.
	 */
	function renderMinimap() {
		const boards = placedBoards();
		const show = state.minimap && !state.focus && !state.compare && boards.length > 0;
		els.minimap.hidden = !show;
		if (!show) return;
		measureViewport();
		const rects = boards.map((board) => ({ ...board.wrapper.layoutAt, ...actions.layoutSize(board.wrapper) }));
		map = scaleOf(rects);
		const { handoffs } = state;
		const current = boards.map((board, index) => {
			const block = blockOf(board);
			const rect = rects[index];
			block.title = board.artboard.title;
			block.classList.toggle("gd-minimap-system", Boolean(board.system));
			block.classList.toggle("gd-minimap-chosen", !board.system && handoffs.slug === board.slug && handoffs.chosen === board.artboard.file);
			block.style.left = rounded(map.x + rect.x * map.scale);
			block.style.top = rounded(map.y + rect.y * map.scale);
			block.style.width = rounded(Math.max(MINIMAP.minBlock, rect.width * map.scale));
			block.style.height = rounded(Math.max(MINIMAP.minBlock, rect.height * map.scale));
			return block;
		});
		for (const wrapper of [...blocks.keys()]) {
			if (!boards.some((board) => board.wrapper === wrapper)) blocks.delete(wrapper);
		}
		const children = [...current, els.minimapView];
		// Only when the set of boards changed: re-attaching nodes on every pointer move is wasted work.
		const old = Array.from(els.minimapMap.children);
		if (old.length !== children.length || old.some((child, index) => child !== children[index])) els.minimapMap.replaceChildren(...children);
		els.minimapMap.setAttribute("aria-label", T.label(boards.filter((board) => !board.system).length));
		renderMinimapView();
	}

	/**
	 * One side of the visible area in map px, clipped to [0, limit] and at least MINIMAP.minView long, so a view far
	 * past an edge still shows as a sliver pinned there, pointing the way: [start, size].
	 */
	function viewSpan(start, end, limit) {
		const clamp = (value) => Math.min(limit, Math.max(0, value));
		const from = clamp(start);
		const to = clamp(end);
		const size = Math.max(MINIMAP.minView, to - from);
		return [Math.min(limit - size, Math.max(0, (from + to - size) / 2)), size];
	}

	/** The visible area in world px, pinned inside the map so it still points the way when the view is far away. */
	function renderMinimapView() {
		if (!map || !viewport || els.minimap.hidden) return;
		const [left, width] = viewSpan(map.x - (state.x / state.zoom) * map.scale, map.x + ((viewport.width - state.x) / state.zoom) * map.scale, MINIMAP.width);
		const [top, height] = viewSpan(map.y - (state.y / state.zoom) * map.scale, map.y + ((viewport.height - state.y) / state.zoom) * map.scale, MINIMAP.height);
		els.minimapView.style.left = rounded(left);
		els.minimapView.style.top = rounded(top);
		els.minimapView.style.width = rounded(width);
		els.minimapView.style.height = rounded(height);
	}

	/** The viewport changed size (a window resize, the comments panel): measure it again for the outline. */
	function measureMinimap() {
		measureViewport();
		renderMinimapView();
	}

	function toggleMinimap() {
		store.setMinimap(!state.minimap);
		renderMinimap();
	}

	/** Centers the view on the world point under a pointer in the map, kept to the map's edges while dragging; the zoom stays. */
	function panToMinimap(event) {
		if (!map || !viewport || map.scale <= 0) return;
		const rect = els.minimapMap.getBoundingClientRect();
		const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
		const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top));
		const worldX = (x - map.x) / map.scale;
		const worldY = (y - map.y) / map.scale;
		store.setView({ x: viewport.width / 2 - worldX * state.zoom, y: viewport.height / 2 - worldY * state.zoom, fitted: false });
		actions.applyView();
		actions.closePopover();
	}

	els.minimapMap.addEventListener("pointerdown", (event) => {
		// One drag at a time: another pointer pressed meanwhile is ignored.
		if (event.button !== 0 || dragging !== null) return;
		dragging = event.pointerId;
		els.minimapMap.setPointerCapture(event.pointerId);
		panToMinimap(event);
	});
	els.minimapMap.addEventListener("pointermove", (event) => {
		if (dragging === event.pointerId) panToMinimap(event);
	});
	const endDrag = (event) => {
		if (dragging === event.pointerId) dragging = null;
	};
	els.minimapMap.addEventListener("pointerup", endDrag);
	els.minimapMap.addEventListener("pointercancel", endDrag);
	// The browser took the capture away (a context menu, a lost window): the release may never come.
	els.minimapMap.addEventListener("lostpointercapture", endDrag);

	// A new language: the map's name (index.html's title is keyed); the blocks carry the artboards' titles as written.
	return { renderMinimap, renderMinimapView, measureMinimap, toggleMinimap, relabel: renderMinimap };
}
