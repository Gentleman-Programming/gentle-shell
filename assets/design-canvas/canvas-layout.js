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
// The farthest a board may sit from the origin on each axis, as the server's layout.json rules say
// (DESIGN_LAYOUT_COORDINATE_MAX in lib/design-layout.ts): a layout past it is none this page uses.
const COORDINATE_MAX = 2_000_000;

// Every string this module shows, in English; canvas-i18n-es.js has the Spanish. A server's reason stays as it came.
const TEXT = Object.freeze({
	saveFailed: (slug, reason) => `The layout of ${slug} could not be saved: ${reason}`,
	readFailed: (slug, reason) => `design/${slug}/layout.json could not be read: ${reason}`,
	unusable: "it holds no layout this page can use",
	error: "error",
});
// fetchLayout's reason for a layout.json that holds no layout this page can use: TEXT.unusable, in the language shown.
const UNUSABLE = Object.freeze({});

export function init(ctx) {
	const { win, doc, els, store, api, ui, actions } = ctx;
	const { state } = store;
	const { getJson, postJson } = api;
	const { setStatus } = ui;
	const T = ctx.i18n.text("layout", TEXT);

	// The artboard being moved by the pointer (canvas-view.js hands it over): { board, from, moved, view }, `view` the
	// layout view it was pressed in. This module's own state, like the pan drag in canvas-view.js.
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
	// The layout views taken so far (useLayout): a save's reply only touches the view it was made from, never one
	// taken after the page left the design and came back.
	let views = 0;
	// layout.json change reads on their way (onLayoutChange): a save that makes one stale and then fails reads the
	// file again, so another page's change is never lost.
	let changeReads = 0;
	// The layout errors the status line keeps showing for a design ({ slug, reason }): the last save that failed, while
	// the layout it left is still unsaved, and the last read of layout.json that failed, until one answers or a save succeeds.
	// While that read error stands nothing is saved (saveLayout): the file is never written over before it can be read.
	let saveError = null;
	let readError = null;
	// The layout error the status line was given last ({ slug, kind, text }), in the language it was shown in: an answer
	// or a save that succeeds clears the status line only while it still shows that text, whatever the language is now.
	let shownError = null;

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

	const isCoordinate = (value) => Number.isInteger(value) && Math.abs(value) <= COORDINATE_MAX;

	/**
	 * api/designs/<slug>/layout's layout, or null when it holds none this page can use: an unknown arrangement, or a
	 * position that is no integer within COORDINATE_MAX (so the world and the minimap keep a sane size). Positions are
	 * keyed in an object without a prototype, so a key such as `__proto__` is just another board's key.
	 */
	function readLayout(value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		if (value.arrangement !== "free" && !ARRANGEMENTS.includes(value.arrangement)) return null;
		const raw = value.positions;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const positions = Object.create(null);
		for (const [key, position] of Object.entries(raw)) {
			if (!position || !isCoordinate(position.x) || !isCoordinate(position.y)) return null;
			positions[key] = { x: position.x, y: position.y };
		}
		return { arrangement: value.arrangement, positions };
	}

	/**
	 * The saved layout of design `slug`, as { layout, error }: layout null when it has none; undefined when layout.json
	 * cannot be used (the server cannot read or use it, or it holds a layout this page's readLayout rejects) or the read
	 * itself failed (an error reply, no connection), with `error` saying why. A failed read says nothing about the
	 * boards: the canvas never fails on it.
	 */
	async function fetchLayout(slug) {
		try {
			const data = await getJson(`api/designs/${encodeURIComponent(slug)}/layout`);
			const value = data ? data.layout : null;
			if (value === null || value === undefined) return { layout: null, error: "" };
			const layout = readLayout(value);
			return layout ? { layout, error: "" } : { layout: undefined, error: UNUSABLE };
		} catch (error) {
			// Only a layout.json the server cannot read or use is news for the status line; an HTTP error or no
			// connection says nothing about the file, and the layout shown stays without a word, as before.
			const unreadable = Boolean(error && error.body && error.body.error === "unreadable-layout");
			return { layout: undefined, error: unreadable ? error.message || T.error : null };
		}
	}

	/** The text of a layout error of `kind` ("save" or "read") in the current language, now given to the status line. */
	function errorText(kind, { slug, reason }) {
		const text = kind === "save" ? T.saveFailed(slug, reason) : T.readFailed(slug, reason === UNUSABLE ? T.unusable : reason);
		shownError = { slug, kind, text };
		return text;
	}

	/** The status line still shows the layout error of `slug` given last (of `kind`, when named): the exact text, or the start of it with `prefix`. */
	function showsError(slug, kind, prefix) {
		if (!shownError || shownError.slug !== slug || (kind && shownError.kind !== kind) || !els.status.classList.contains("gd-error")) return false;
		const text = els.status.textContent;
		return prefix ? text.startsWith(shownError.text) : text === shownError.text;
	}

	/** The layout error the status line shows for the design shown: a failed save while its layout is unsaved, then a failed read. */
	function layoutError() {
		const slug = state.slug;
		const shown = state.layout && state.layout.slug === slug ? state.layout : null;
		if (saveError && saveError.slug === slug && shown && shown.unsaved) return errorText("save", saveError);
		if (readError && readError.slug === slug) return errorText("read", readError);
		return "";
	}

	/** A read of design `slug`'s layout answered (`error` empty) or failed: its read error is kept, or cleared from the status line. */
	function noteRead(slug, error, show) {
		// null: the read failed for a reason that says nothing about layout.json (keep what the status line says).
		if (error === null) return;
		if (error) {
			readError = { slug, reason: error };
			if (show) setStatus(errorText("read", readError), true);
			return;
		}
		if (!readError || readError.slug !== slug) return;
		readError = null;
		if (show && showsError(slug, "read", false)) {
			const rest = layoutError();
			setStatus(rest, Boolean(rest));
		}
	}

	/**
	 * Takes `layout` (null: none, a row) as design `slug`'s; the boards move at the next applyLayout. `saved` is what
	 * layout.json is known to hold (this read, or later a save the server took); `unsaved` marks a layout whose last
	 * save failed, which stays until layout.json holds something else. Each call is a new view of the layout.
	 */
	function useLayout(slug, layout) {
		views += 1;
		store.setLayout({ layout: { slug, view: views, arrangement: layout ? layout.arrangement : "row", positions: layout ? layout.positions : {}, saved: JSON.stringify(layout) } });
	}

	/** loadManifest's read of design `slug`'s layout: { layout, error, read }, numbered like onLayoutChange's reads. */
	async function readLayoutNow(slug) {
		const read = ++reads;
		return { ...(await fetchLayout(slug)), read };
	}

	/**
	 * loadManifest's layout: taken unless this page already shows a layout of the design that is newer than the read
	 * (a save or a read went out after it, or a save is still in flight, which is newer than the file), or the file
	 * still holds what this page knew (the layout shown, already placed, or one whose save failed). A read that failed
	 * keeps the layout shown; with none shown the boards sit in a row. loadManifest then shows layoutError's text.
	 */
	function takeLayout(slug, { layout, read, error }) {
		const shown = state.layout && state.layout.slug === slug ? state.layout : null;
		noteRead(slug, error, false);
		if (layout === undefined) {
			if (!shown) useLayout(slug, null);
			return;
		}
		if (!shown || (read === reads && saves === 0 && JSON.stringify(layout) !== shown.saved)) useLayout(slug, layout);
	}

	/** No design shown (the system-only view, an empty notice): no layout, nothing selected, nothing to arrange. */
	function clearLayout() {
		cancelMove();
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
		if (moving && (!state.layout || state.layout.view !== moving.view)) cancelMove();
		else if (moving && !boards.includes(moving.board)) {
			// The same layout, rebuilt (a design.json reload): the move goes on with the board that replaced this one.
			const key = layoutKey(moving.board);
			const next = boards.find((board) => layoutKey(board) === key);
			if (next) {
				moving.board = next;
				next.wrapper.classList.add("gd-lifted");
			} else moving = null;
		}
		if (state.selected && !boards.includes(state.selected)) selectBoard(null);
		// An arrangement places every board again: a board already moved stays where it was dragged until the release.
		const dragged = moving && moving.moved && state.layout.arrangement !== "free" ? state.layout.positions[layoutKey(moving.board)] : null;
		applyLayout();
		if (dragged) moveBoard(moving.board, dragged);
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
		moving = { board, from, moved: false, view: state.layout.view };
		return true;
	}

	/**
	 * A move whose layout is gone (another design, another page's layout taken meanwhile, no design shown) ends
	 * without a save: its offsets belong to the layout it was pressed in.
	 */
	function cancelMove() {
		if (!moving) return;
		moving.board.wrapper.classList.remove("gd-lifted");
		moving = null;
	}

	/** The pointer went (dx, dy) screen px from where the move began: in world px, so the board stays under it at any zoom. */
	function moveBy(dx, dy) {
		if (!moving || !state.layout) return;
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
	 * are still another design's, nor while layout.json cannot be used (the last read of it failed with the reason in
	 * the status line): moves and arrangements then change only the view, and saves resume once a read answers with a
	 * layout or with none. A reply that comes after the page left the design and came back leaves the layout
	 * read since alone: what it holds is what layout.json held then, so the save's own change event still shows.
	 */
	function saveLayout() {
		const slug = state.slug;
		const layout = state.layout;
		if (!slug || !state.manifest || state.manifest.slug !== slug || !layout || layout.slug !== slug) return;
		if (readError && readError.slug === slug) return;
		const body = { arrangement: layout.arrangement, positions: layout.positions };
		// A change read this save makes stale: a save that fails leaves the file as that change wrote it, so it is read again.
		const staleChange = changeReads > 0;
		reads += 1;
		saves += 1;
		saving = saving.then(async () => {
			const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/layout`, body).catch((error) => ({ ok: false, body: { error: error.message } }));
			saves -= 1;
			// A read that went out while this save was on its way may hold the file from before it.
			if (reply.ok) reads += 1;
			else if (staleChange) readPending = true;
			if (state.layout && state.layout.view === layout.view) {
				store.setLayout({ layout: reply.ok ? { ...state.layout, saved: JSON.stringify(body), unsaved: false } : { ...state.layout, unsaved: true } });
			}
			if (!reply.ok) {
				// Kept while the layout is unsaved, so a design.json reload shows it again (loadManifest).
				saveError = { slug, reason: reply.body.reason || reply.body.error || T.error };
				if (slug === state.slug) setStatus(errorText("save", saveError), true);
			} else {
				if (saveError && saveError.slug === slug) saveError = null;
				// layout.json now holds this save: an earlier failed read of it is over too.
				if (readError && readError.slug === slug) readError = null;
				// A retry that succeeds clears this design's layout error, in the language it was shown in, never another status.
				if (showsError(slug, null, true)) setStatus("", false);
			}
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
		changeReads += 1;
		const { layout, error } = await fetchLayout(slug).finally(() => {
			changeReads -= 1;
		});
		if (read !== reads || slug !== state.slug) return;
		noteRead(slug, error, true);
		if (layout === undefined) return;
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
	function boardsResized(options) {
		if (!moving && (!state.layout || state.layout.arrangement !== "free")) applyLayout();
		else {
			sizeWorld();
			actions.renderMinimap();
		}
		if (state.focus) actions.centerFocus(options);
	}

	/**
	 * The Row / Column / Grid buttons: the current arrangement pressed (none for a hand-made layout), off without a
	 * design or with no board shown (an empty notice), inside an artboard and in Compare.
	 */
	function renderArrange() {
		const arrangement = state.layout ? state.layout.arrangement : "row";
		const shown = actions.allBoards().some((board) => board.wrapper.parentElement === els.world);
		const off = Boolean(state.focus) || Boolean(state.compare) || !state.manifest || !shown;
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
	// Row / Column / Grid keep the focus a click gave them: there Space pans too, unless the keyboard reached the
	// button (it shows its focus ring, :focus-visible), where Space presses it as on any button.
	const pointerFocusedArrange = (target) => ARRANGEMENTS.some((kind) => els.arrange[kind] === target) && !target.matches(":focus-visible");
	const spaceTarget = (target) => target === doc.body || target === doc.documentElement || target === els.viewport || Boolean(target && typeof target.closest === "function" && target.closest(".gd-shield")) || Boolean(target && pointerFocusedArrange(target));
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
		if (event.key !== " " || !state.space) return;
		// The release of a Space that panned presses no button (a browser activates a button on Space's keyup).
		event.preventDefault();
		releaseSpace();
	});
	// The release never comes once the window loses focus.
	win.addEventListener("blur", () => {
		if (state.space) releaseSpace();
	});

	return { layoutSize, readLayoutNow, takeLayout, layoutError, clearLayout, sizeWorld, layoutBoards, boardsResized, beginMove, moveBy, endMove, onLayoutChange, renderArrange, selectBoard };
}
