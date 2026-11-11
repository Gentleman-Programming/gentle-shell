// Where the artboards sit: design/<slug>/layout.json through the api/designs/<slug>/layout
// routes, Row / Column / Grid (Free once an artboard is moved by hand), moving an artboard
// by dragging any part of it, the selected artboard, and Space held to pan from anywhere.
// Artboards are placed in the world by position, not by the flow of a row: the world is as
// big as their bounds, so Fit, the minimap and focus mode read it as before.

// The room between boards in every arrangement, and the system board's key in layout.json,
// where every artboard is keyed by its file (which ends in .html, so the two never meet).
const BOARD_GAP = 80;
const SYSTEM_KEY = "system";
const ARRANGEMENTS = ["row", "column", "grid"];

// Every string this module shows, in English until the i18n PR keys them.
const TEXT = Object.freeze({
	saveFailed: (slug, reason) => `The layout of ${slug} could not be saved: ${reason}`,
});

export function init(ctx) {
	const { win, doc, els, store, api, ui, actions } = ctx;
	const { state } = store;
	const { getJson, postJson } = api;
	const { setStatus } = ui;

	// The artboard being moved by the pointer (canvas-view.js hands it over): { board, from, moved }.
	// This module's own state, like the pan drag in canvas-view.js.
	let moving = null;
	// Saves go out one after another, in gesture order, so the server writes the newest layout last.
	let saving = Promise.resolve();
	// Layout saves queued or on their way to the server.
	let saves = 0;
	// The latest layout read (onLayoutChange, readLayoutNow); a newer read or a save makes an older read's reply stale.
	let reads = 0;
	// A layout.json change came while saves were on their way or a press was on an artboard: layout.json is read
	// again once both are over.
	let readPending = false;

	/** A board's key in layout.json: its artboard file, or the system board's own key. */
	function layoutKey(board) {
		return board.system ? SYSTEM_KEY : board.artboard.file;
	}

	/** A world child's box in world px: its manifest width, and its frame (at its manifest height) below its label. */
	function layoutSize(wrapper) {
		const box = wrapper.children[wrapper.children.length - 1];
		const size = wrapper.layoutSize ?? { width: 0, height: 0 };
		return { width: size.width, height: (box ? box.offsetTop : 0) + size.height };
	}

	/** api/designs/<slug>/layout's layout, or null when it is none or cannot be read (the boards then sit in a row). */
	function readLayout(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		if (value.arrangement !== "free" && !ARRANGEMENTS.includes(value.arrangement)) return null;
		const raw = value.positions;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const positions = {};
		for (const [key, position] of Object.entries(raw)) {
			if (!position || !Number.isInteger(position.x) || !Number.isInteger(position.y)) return null;
			positions[key] = { x: position.x, y: position.y };
		}
		return { arrangement: value.arrangement, positions };
	}

	/**
	 * The saved layout of design `slug`: null when it has none or holds none this page can use; undefined when the read
	 * itself failed (an error reply, no connection), which says nothing about the file (the canvas never fails on it).
	 */
	async function fetchLayout(slug) {
		try {
			const data = await getJson(`api/designs/${encodeURIComponent(slug)}/layout`);
			return readLayout(data && data.layout);
		} catch {
			return undefined;
		}
	}

	/**
	 * Takes `layout` (null: none, a row) as design `slug`'s; the boards move at the next applyLayout. `saved` is what
	 * layout.json is known to hold (this read, or later a save the server took); `unsaved` marks a layout whose last
	 * save failed, which stays until layout.json holds something else.
	 */
	function useLayout(slug, layout) {
		store.setLayout({ layout: { slug, arrangement: layout ? layout.arrangement : "row", positions: layout ? layout.positions : {}, saved: JSON.stringify(layout) } });
	}

	/** loadManifest's read of design `slug`'s layout: { layout, read }, numbered like onLayoutChange's reads. */
	async function readLayoutNow(slug) {
		const read = ++reads;
		return { layout: await fetchLayout(slug), read };
	}

	/**
	 * loadManifest's layout: taken unless this page already shows a layout of the design that is newer than the read
	 * (a save or a read went out after it, or a save is still in flight, which is newer than the file), or the file
	 * still holds what this page knew (the layout shown, already placed, or one whose save failed). A read that failed
	 * keeps the layout shown; with none shown the boards sit in a row.
	 */
	function takeLayout(slug, { layout, read }) {
		const shown = state.layout && state.layout.slug === slug ? state.layout : null;
		if (layout === undefined) {
			if (!shown) useLayout(slug, null);
			return;
		}
		if (!shown || (read === reads && saves === 0 && JSON.stringify(layout) !== shown.saved)) useLayout(slug, layout);
	}

	/** No design shown (the system-only view, an empty notice): no layout, nothing selected, nothing to arrange. */
	function clearLayout() {
		store.setLayout({ layout: null });
		selectBoard(null);
		renderArrange();
	}

	/** The top left of a box right of the boxes `rects`, top-aligned with them. */
	function spotAfter(rects) {
		if (rects.length === 0) return { x: 0, y: 0 };
		return { x: Math.max(...rects.map((rect) => rect.x + rect.width)) + BOARD_GAP, y: Math.min(...rects.map((rect) => rect.y)) };
	}

	/**
	 * Positions of `boards` in arrangement `kind`, in order, BOARD_GAP apart: a grid of roughly square columns, each as
	 * wide as its widest board, and rows as tall as their tallest; a row is a grid of one row, a column one of one column.
	 */
	function arranged(kind, boards) {
		const columns = Math.max(1, kind === "row" ? boards.length : kind === "column" ? 1 : Math.ceil(Math.sqrt(boards.length)));
		const widths = [];
		const heights = [];
		boards.forEach((board, index) => {
			const size = layoutSize(board.wrapper);
			const column = index % columns;
			const row = Math.floor(index / columns);
			widths[column] = Math.max(widths[column] ?? 0, size.width);
			heights[row] = Math.max(heights[row] ?? 0, size.height);
		});
		const starts = (lengths) => lengths.map((_, index) => lengths.slice(0, index).reduce((sum, length) => sum + length + BOARD_GAP, 0));
		const xs = starts(widths);
		const ys = starts(heights);
		return Object.fromEntries(boards.map((board, index) => [layoutKey(board), { x: xs[index % columns], y: ys[Math.floor(index / columns)] }]));
	}

	function place(wrapper, at) {
		wrapper.layoutAt = at;
		wrapper.style.left = `${at.x}px`;
		wrapper.style.top = `${at.y}px`;
	}

	/** The world as big as the bounds of the boards placed in it, so Fit sees every board. */
	function sizeWorld() {
		let right = 0;
		let bottom = 0;
		for (const board of actions.allBoards()) {
			if (!board.wrapper.layoutAt) continue;
			const size = layoutSize(board.wrapper);
			right = Math.max(right, board.wrapper.layoutAt.x + size.width);
			bottom = Math.max(bottom, board.wrapper.layoutAt.y + size.height);
		}
		els.world.style.width = `${right}px`;
		els.world.style.height = `${bottom}px`;
	}

	/**
	 * Puts every board where the layout says and sizes the world to their bounds. An arrangement is laid out again
	 * from the boards' sizes; a free layout keeps each board's position, a board it does not know goes after the
	 * others, and one the design lost drops out. No board sits left of or above the world's top left: when one went
	 * there, everything shifts back and the view (or, in focus mode, the view to restore) follows, so nothing jumps.
	 * Without a layout (the system-only view) the boards sit in a row.
	 */
	function applyLayout() {
		const boards = actions.allBoards();
		const layout = state.layout;
		const arrangement = layout ? layout.arrangement : "row";
		const keys = boards.map(layoutKey);
		let positions = {};
		if (arrangement === "free") {
			const rects = [];
			const known = boards.filter((board, index) => layout.positions[keys[index]]);
			for (const board of [...known, ...boards.filter((board) => !known.includes(board))]) {
				const key = layoutKey(board);
				positions[key] = layout.positions[key] ?? spotAfter(rects);
				rects.push({ ...positions[key], ...layoutSize(board.wrapper) });
			}
		} else positions = arranged(arrangement, boards);
		const shiftX = Math.min(0, ...keys.map((key) => positions[key].x));
		const shiftY = Math.min(0, ...keys.map((key) => positions[key].y));
		const placed = Object.fromEntries(keys.map((key) => [key, { x: positions[key].x - shiftX, y: positions[key].y - shiftY }]));
		if (layout) store.setLayout({ layout: { ...layout, positions: placed } });
		boards.forEach((board, index) => place(board.wrapper, placed[keys[index]]));
		sizeWorld();
		if (shiftX !== 0 || shiftY !== 0) {
			if (!state.focus) {
				store.setView({ x: state.x + shiftX * state.zoom, y: state.y + shiftY * state.zoom });
				actions.applyView();
			} else if (state.savedView) {
				const saved = state.savedView;
				store.setFocus({ savedView: { ...saved, x: saved.x + shiftX * saved.zoom, y: saved.y + shiftY * saved.zoom } });
			}
		}
		actions.renderMinimap();
	}

	/**
	 * placeBoards' layout step: a move or a selection of a board that was replaced ends, then every board is placed,
	 * and a layout.json change put off until the design's boards showed is read.
	 */
	function layoutBoards(boards) {
		if (moving && !boards.includes(moving.board)) moving = null;
		if (state.selected && !boards.includes(state.selected)) selectBoard(null);
		applyLayout();
		readAgain();
	}

	/** Puts `board` at `at` while it is dragged; it is saved on release (finishMove). */
	function moveBoard(board, at) {
		store.setLayout({ layout: { ...state.layout, positions: { ...state.layout.positions, [layoutKey(board)]: at } } });
		board.wrapper.classList.add("gd-lifted");
		place(board.wrapper, at);
		sizeWorld();
		actions.renderMinimap();
	}

	/** A press on `board` that may become a move; false when the board has no place in a layout (nothing to move). */
	function beginMove(board) {
		const from = state.layout ? state.layout.positions[layoutKey(board)] : null;
		if (!from) return false;
		moving = { board, from, moved: false };
		return true;
	}

	/** The pointer went (dx, dy) screen px from where the move began: in world px, so the board stays under it at any zoom. */
	function moveBy(dx, dy) {
		if (!moving) return;
		moving.moved = true;
		moveBoard(moving.board, { x: Math.round(moving.from.x + dx / state.zoom), y: Math.round(moving.from.y + dy / state.zoom) });
	}

	/** The press ended: a release keeps a moved board where it is, by hand; a cancel (the browser took the pointer) puts it back. */
	function endMove(keep) {
		const ended = moving;
		moving = null;
		if (ended) {
			if (ended.moved) {
				if (keep) finishMove();
				else moveBoard(ended.board, ended.from);
			}
			ended.board.wrapper.classList.remove("gd-lifted");
		}
		readAgain();
	}

	/** A board moved by hand: the layout is free from now on, and it is saved once. */
	function finishMove() {
		store.setLayout({ layout: { ...state.layout, arrangement: "free" } });
		applyLayout();
		renderArrange();
		saveLayout();
	}

	/**
	 * Writes the layout of the design shown to its layout.json, after the saves before it; a failure says so in the
	 * status line and the boards stay, unsaved, until layout.json holds something this page did not know (another
	 * page's change wins); a later save that succeeds clears that error. A read on its way is older than this layout,
	 * and a change that came meanwhile is read once the last save is done. Nothing is saved while the boards shown
	 * are still another design's.
	 */
	function saveLayout() {
		const slug = state.slug;
		const layout = state.layout;
		if (!slug || !state.manifest || state.manifest.slug !== slug || !layout || layout.slug !== slug) return;
		const body = { arrangement: layout.arrangement, positions: layout.positions };
		reads += 1;
		saves += 1;
		saving = saving.then(async () => {
			const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/layout`, body).catch((error) => ({ ok: false, body: { error: error.message } }));
			saves -= 1;
			if (state.layout && state.layout.slug === slug) {
				store.setLayout({ layout: reply.ok ? { ...state.layout, saved: JSON.stringify(body), unsaved: false } : { ...state.layout, unsaved: true } });
			}
			if (!reply.ok && slug === state.slug) setStatus(TEXT.saveFailed(slug, reply.body.reason || reply.body.error || "error"), true);
			// A retry that succeeds clears this design's save error, never another status.
			else if (reply.ok && els.status.classList.contains("gd-error") && els.status.textContent.startsWith(TEXT.saveFailed(slug, ""))) setStatus("", false);
			readAgain();
		}).catch(() => {});
	}

	/** The layout.json change put off by a save or a press is read once no save is on its way and no press is on an artboard. */
	function readAgain() {
		if (!readPending || saves > 0 || moving) return;
		readPending = false;
		onLayoutChange().catch(() => {});
	}

	/**
	 * layout.json changed: another page moved or arranged the boards, so they move here too; the page's own save is no
	 * news, a read that fails keeps the layout shown, and a change of a design whose boards are not shown yet (a design
	 * switch still loading) is read once they are.
	 */
	async function onLayoutChange() {
		const slug = state.slug;
		if (!slug) return;
		if (saves > 0 || moving) {
			readPending = true;
			return;
		}
		const read = ++reads;
		const layout = await fetchLayout(slug);
		if (read !== reads || slug !== state.slug || layout === undefined) return;
		if (moving || !state.manifest || state.manifest.slug !== slug) {
			readPending = true;
			return;
		}
		if (state.layout && JSON.stringify(layout) === state.layout.saved) return;
		useLayout(slug, layout);
		applyLayout();
		renderArrange();
		if (state.focus) actions.centerFocus();
	}

	/**
	 * The boards changed size after they were placed (a handoff row grew or shrank their labels): an arrangement is
	 * laid out again, so its gaps stay 80 px; a free layout, or a board being moved, stays where it is. The artboard
	 * in use stays centered, since focus mode cannot pan.
	 */
	function boardsResized() {
		if (!moving && (!state.layout || state.layout.arrangement !== "free")) applyLayout();
		else {
			sizeWorld();
			actions.renderMinimap();
		}
		if (state.focus) actions.centerFocus();
	}

	/** The Row / Column / Grid buttons: the current arrangement pressed (none for a hand-made layout), off without a design, inside an artboard and in Compare. */
	function renderArrange() {
		const arrangement = state.layout ? state.layout.arrangement : "row";
		const off = Boolean(state.focus) || Boolean(state.compare) || !state.manifest;
		for (const kind of ARRANGEMENTS) {
			els.arrange[kind].setAttribute("aria-pressed", String(arrangement === kind));
			els.arrange[kind].disabled = off;
		}
	}

	/** Lays every board out as a row, a column or a grid, saves it and shows them all. */
	function arrange(kind) {
		if (state.focus || state.compare || !state.manifest || state.manifest.slug !== state.slug || !state.layout) return;
		store.setLayout({ layout: { ...state.layout, arrangement: kind } });
		applyLayout();
		renderArrange();
		saveLayout();
		actions.fit();
	}

	for (const kind of ARRANGEMENTS) els.arrange[kind].addEventListener("click", () => arrange(kind));

	/** The artboard pressed last shows selected, all of it; null clears it. */
	function selectBoard(board) {
		store.setSelected(board);
		for (const candidate of actions.allBoards()) candidate.wrapper.classList.toggle("gd-selected", candidate === board);
	}

	// Esc clears the selected artboard first; the next Esc reaches the popover's (leave Comment mode). Not while an
	// artboard is in use, a dialog, a menu or the comment box is open: their Esc is theirs.
	doc.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.key !== "Escape" || event.shiftKey || !state.selected) return;
		if (state.focus || state.compare || state.menu || !els.popover.hidden || els.shortcuts.hasAttribute("open")) return;
		event.preventDefault();
		selectBoard(null);
	});

	// Space held pans from anywhere, over an artboard too. Not while typing or from a button or a link (Space is
	// theirs), with the comment box, a menu or the shortcuts list open, in Compare or while an artboard is in use.
	// A shield opens its artboard on Space first (its own keydown), so this one then sees focus mode and stays out.
	const spaceTarget = (target) => target === doc.body || target === doc.documentElement || target === els.viewport || Boolean(target && typeof target.closest === "function" && target.closest(".gd-shield"));
	function releaseSpace() {
		store.setSpace(false);
		els.viewport.classList.remove("gd-space-pan");
	}
	doc.addEventListener("keydown", (event) => {
		if (event.key !== " " || event.ctrlKey || event.metaKey || event.altKey || !spaceTarget(event.target)) return;
		if (state.focus || state.compare || state.menu || !els.popover.hidden || els.shortcuts.hasAttribute("open")) return;
		event.preventDefault();
		store.setSpace(true);
		els.viewport.classList.add("gd-space-pan");
	});
	doc.addEventListener("keyup", (event) => {
		if (event.key === " " && state.space) releaseSpace();
	});
	// The release never comes once the window loses focus.
	win.addEventListener("blur", () => {
		if (state.space) releaseSpace();
	});

	return { layoutSize, readLayoutNow, takeLayout, clearLayout, sizeWorld, layoutBoards, boardsResized, beginMove, moveBy, endMove, onLayoutChange, renderArrange, selectBoard };
}
