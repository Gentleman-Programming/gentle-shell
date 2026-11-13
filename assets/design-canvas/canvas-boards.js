// Designs and artboards: the design list, each board's sandboxed iframe, header
// and Implement this control (with the ⋯ menu of canvas-export.js beside it),
// manifest loading, the system board, the show event and the first load.
// design/system.html, when present, is the first board of every design; it is
// kept out of state.boards so comments never apply to it.

// Every string the boards show, in English; canvas-i18n-es.js has the Spanish. Artboard titles and tradeoffs stay as written.
const TEXT = Object.freeze({
	systemTitle: "Design system",
	systemTradeoff: "Project tokens (design/system.md)",
	systemNote: "Comments apply to design artboards only. To change the system, update the project's design sources and run /gentle:design sync.",
	systemOff: "Comments off on this board",
	invalidDesign: (slug) => `${slug} (invalid design.json)`,
	frameTitle: (title) => `${title} artboard`,
	viewSystem: (title) => `View ${title} (read-only)`,
	use: (title) => `Use ${title}`,
	systemHint: "Click to view the design system",
	useHint: "Click to use this design",
	implement: "Implement this",
	implementAria: (title) => `Implement ${title} in the project`,
	confirmAria: (title) => `Confirm implementing ${title}`,
	question: "Send it to the session to implement?",
	send: "Send",
	cancel: "Cancel",
	queued: (title) => `Queued: the session will implement ${title} after its current task.`,
	sent: (title) => `Sent: the session is implementing ${title} now.`,
	notSent: (reason) => `Not sent: ${reason}`,
	error: "error",
	feature: (feature) => `Feature: ${feature}`,
	noDesigns: "No designs yet. Run /gentle:design with a brief to create one.",
	cannotShow: (slug, reason) => `Design "${slug}" cannot be shown: ${reason}`,
	invalidManifest: (slug) => `design.json for ${slug} is invalid`,
	noArtboards: "This design has no artboards yet.",
	cannotList: (reason) => `Designs cannot be listed: ${reason}`,
});

export function init(ctx) {
	const { win, doc, els, store, api, ui, actions } = ctx;
	const { state } = store;
	const { base, fileUrl, getJson, postJson, isFiniteNumber } = api;
	const { setStatus, showToast } = ui;
	const T = ctx.i18n.text("boards", TEXT);
	// What relabel rewrites: each board's own labels, the empty notice shown (a function of the language) and the invalid designs' options.
	const labelers = new WeakMap();
	let emptyText = null;
	let invalidOptions = [];

	/** text: the notice, as a function so a new language writes it again. */
	function showEmpty(text) {
		actions.exitFocus();
		els.world.replaceChildren();
		store.setDesign({ boards: [] });
		actions.hideGoneInspector();
		actions.refreshChecks();
		actions.clearLayout();
		actions.renderMinimap();
		emptyText = text;
		els.empty.textContent = text();
		els.empty.hidden = false;
	}

	function renderDesignOptions(designs) {
		invalidOptions = [];
		const options = designs.map((design) => {
			const option = doc.createElement("option");
			option.value = design.slug;
			option.textContent = design.valid ? design.title : T.invalidDesign(design.slug);
			if (!design.valid) invalidOptions.push([option, design.slug]);
			return option;
		});
		els.design.replaceChildren(...options);
		store.setDesign({ designCount: designs.length });
		els.design.disabled = designs.length === 0 || Boolean(state.focus);
		els.designField.hidden = designs.length === 0;
		if (state.slug) els.design.value = state.slug;
	}

	/** pickLatest: with no design selected, select the most recent one (not for the system-only view). */
	async function refreshDesigns(pickLatest = true) {
		const { designs } = await getJson("api/designs");
		if (pickLatest && !state.slug && designs.length > 0) store.setDesign({ slug: designs[0].slug });
		renderDesignOptions(designs);
		return designs;
	}

	/**
	 * A board's frame or one of its size frames (canvas-sizes.js): comment mode never reaches the system board.
	 * `inspect`: Technical details is on, so the frame measures the hovered element for the token inspector.
	 */
	function sendMode(surface) {
		surface.frame.contentWindow?.postMessage({ type: "gd:mode", enabled: state.commenting && !actions.ownerOf(surface).system, inspect: state.technical }, "*");
	}

	function boardUrl(board) {
		return board.system ? `${base}system.html` : fileUrl(board.slug, board.artboard.file);
	}

	function createBoard(slug, artboard, system = false) {
		const wrapper = doc.createElement("section");
		wrapper.className = system ? "gd-artboard gd-system-board" : "gd-artboard";
		const label = doc.createElement("div");
		label.className = "gd-artboard-label";
		const title = doc.createElement("h2");
		title.className = "gd-artboard-title";
		label.append(title);
		const tradeoff = artboard.tradeoff ? doc.createElement("p") : null;
		if (tradeoff) {
			tradeoff.className = "gd-artboard-tradeoff";
			label.append(tradeoff);
		}
		// The handoff state, the chosen badge and Compare (rendered by renderHandoff) stack above
		// Implement this, at screen size, so neither covers the other at any zoom.
		const handoff = doc.createElement("div");
		handoff.className = "gd-handoff";
		handoff.hidden = true;
		let boardActions = null;
		const implement = system ? null : createImplementControl(slug, artboard);
		if (implement) {
			boardActions = doc.createElement("div");
			boardActions.className = "gd-board-actions";
			boardActions.append(handoff, implement.box);
			label.append(boardActions);
		}
		const note = system ? doc.createElement("p") : null;
		if (note) {
			note.className = "gd-system-note";
			label.append(note);
		}
		const frame = doc.createElement("iframe");
		frame.className = "gd-artboard-frame";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		const box = doc.createElement("div");
		box.className = "gd-frame-box";
		const shield = doc.createElement("div");
		shield.className = "gd-shield";
		shield.setAttribute("role", "button");
		shield.tabIndex = 0;
		const hint = doc.createElement("span");
		hint.className = "gd-shield-hint";
		hint.setAttribute("aria-hidden", "true");
		shield.append(hint);
		// Every text of the board, written again in place for a new language (the system board's title is the canvas's).
		const labelBoard = () => {
			wrapper.setAttribute("aria-label", artboard.title);
			title.textContent = artboard.title;
			if (tradeoff) tradeoff.textContent = artboard.tradeoff;
			if (note) {
				label.title = T.systemNote;
				note.title = T.systemNote;
				note.textContent = T.systemOff;
			}
			frame.title = T.frameTitle(artboard.title);
			shield.setAttribute("aria-label", system ? T.viewSystem(artboard.title) : T.use(artboard.title));
			hint.textContent = system ? T.systemHint : T.useHint;
			if (implement) implement.label();
		};
		labelBoard();
		const pins = doc.createElement("div");
		pins.className = "gd-pins";
		// The Overflows chip (canvas-sizes.js) on the frame.
		const flag = actions.overflowFlag();
		// The size the layout places (canvas-layout.js layoutSize): the frame at its manifest size.
		wrapper.layoutSize = { width: artboard.width, height: artboard.height };
		// rects: null until the artboard reports where each commented element is.
		// viewWidth and viewHeight: the frame's size, the manifest's or the focused screen size (canvas-focus.js).
		// overflow, sizeFrames and sizesView: the page's overflow report and the All sizes frames (canvas-sizes.js).
		// checks: the artboard's last accessibility checks, null until its frame reports them (canvas-checks.js).
		// generation: how many sizes the frame has had, which its page tags its picks with (canvas-sizes.js resized).
		const board = { slug, artboard, frame, wrapper, shield, pins, flag, handoff, rects: null, system, viewWidth: 0, viewHeight: 0, overflow: null, generation: 0, sizeFrames: [], sizesView: null, checks: null };
		labelers.set(board, labelBoard);
		actions.setFrameSize(board, artboard.width, artboard.height);
		actions.renderHandoff(board);
		// The ⋯ menu (export) sits beside Implement this; the system board has none.
		if (boardActions) boardActions.append(actions.boardMenuButton(board));
		shield.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			actions.enterFocus(board);
		});
		frame.addEventListener("load", () => {
			actions.surfaceLoaded(board);
			// A live reload of the focused artboard keeps focus mode and its keyboard focus.
			if (state.focus === board && els.popover.hidden && (doc.activeElement === frame || doc.activeElement === doc.body)) frame.focus();
		});
		frame.src = boardUrl(board);
		box.append(frame, shield, pins, flag);
		wrapper.append(label, box);
		return board;
	}

	/** "Implement this" with an inline confirm step, and `label`, which writes its text; the system board never gets one. */
	function createImplementControl(slug, artboard) {
		const box = doc.createElement("div");
		box.className = "gd-implement";
		const start = doc.createElement("button");
		start.type = "button";
		start.className = "gd-implement-start";
		const confirm = doc.createElement("div");
		confirm.className = "gd-implement-confirm";
		confirm.setAttribute("role", "group");
		confirm.hidden = true;
		const question = doc.createElement("span");
		const yes = doc.createElement("button");
		yes.type = "button";
		yes.className = "gd-primary";
		const no = doc.createElement("button");
		no.type = "button";
		const label = () => {
			start.textContent = T.implement;
			start.setAttribute("aria-label", T.implementAria(artboard.title));
			confirm.setAttribute("aria-label", T.confirmAria(artboard.title));
			question.textContent = T.question;
			yes.textContent = T.send;
			no.textContent = T.cancel;
		};
		confirm.append(question, yes, no);
		const close = (focus) => {
			confirm.hidden = true;
			start.hidden = false;
			if (focus) start.focus();
		};
		start.addEventListener("click", () => {
			start.hidden = true;
			confirm.hidden = false;
			yes.disabled = false;
			yes.focus();
		});
		no.addEventListener("click", () => close(true));
		confirm.addEventListener("keydown", (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close(true);
		});
		yes.addEventListener("click", async () => {
			yes.disabled = true;
			const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/implement`, { file: artboard.file }).catch((error) => ({ ok: false, body: { error: error.message } }));
			if (reply.ok) {
				const queued = reply.body.queued === true;
				const text = queued ? T.queued(artboard.title) : T.sent(artboard.title);
				setStatus(text, false);
				showToast(text, false);
				// The server recorded it before answering; the handoffs.json change event confirms it.
				actions.noteHandoff(slug, artboard.file, queued);
			} else {
				const text = T.notSent(reply.body.reason || reply.body.error || T.error);
				setStatus(text, true);
				showToast(text, true);
			}
			close(true);
		});
		box.append(start, confirm);
		return { box, label };
	}

	function showFeature(manifest) {
		const feature = manifest && typeof manifest.feature === "string" ? manifest.feature : "";
		els.feature.textContent = feature ? T.feature(feature) : "";
		els.feature.hidden = !feature;
	}

	/** No design selected: only the system board, or the empty notice. */
	function showSystemOnly() {
		store.setDesign({ manifest: null, boards: [] });
		actions.clearLayout();
		showFeature(null);
		els.title.textContent = "Gentle Design";
		if (!state.systemBoard) {
			showEmpty(() => T.noDesigns);
			return;
		}
		els.empty.hidden = true;
		placeBoards();
		setStatus("", false);
		win.requestAnimationFrame(actions.fit);
	}

	// The latest loadManifest: an older load, of this design too, that answers after it changes nothing.
	let loads = 0;

	async function loadManifest(slug, keepView) {
		const load = ++loads;
		let manifest;
		try {
			manifest = await getJson(`api/designs/${encodeURIComponent(slug)}`);
		} catch (error) {
			if (load !== loads || slug !== state.slug) return;
			showEmpty(() => T.cannotShow(slug, error.message));
			setStatus(T.invalidManifest(slug), true);
			return;
		}
		if (load !== loads || slug !== state.slug) return;
		// Where the boards sit, before they are placed.
		const layout = await actions.readLayoutNow(slug);
		if (load !== loads || slug !== state.slug) return;
		actions.takeLayout(slug, layout);
		actions.closePopover();
		store.setDesign({ manifest });
		showFeature(manifest);
		els.title.textContent = manifest.title;
		doc.title = `${manifest.title} · Gentle Design`;
		win.history.replaceState(null, "", `${base}d/${encodeURIComponent(slug)}/`);
		if (manifest.artboards.length === 0 && !state.systemBoard) {
			showEmpty(() => T.noArtboards);
			return;
		}
		els.empty.hidden = true;
		const focusFile = state.focus && !state.focus.system ? state.focus.artboard.file : null;
		// The boards are built again: the old ones' All sizes frames go with them (the focused one gets new ones).
		for (const board of state.boards) actions.removeSizeFrames(board);
		store.setDesign({ boards: manifest.artboards.map((artboard) => createBoard(slug, artboard)) });
		// A manifest reload keeps focus mode on the same artboard file while it still exists.
		if (focusFile) store.setFocus({ focus: state.boards.find((board) => board.artboard.file === focusFile) ?? state.focus });
		placeBoards();
		if (state.focus) win.requestAnimationFrame(actions.centerFocus);
		const warnings = Array.isArray(manifest.warnings) ? manifest.warnings.filter((warning) => typeof warning === "string") : [];
		// A layout error that still holds (a failed save while the layout is unsaved, a failed read) stays first.
		const layoutError = actions.layoutError();
		const notice = warnings.length > 0 ? `design.json: ${warnings.join("; ")}` : "";
		if (layoutError || notice) setStatus([layoutError, notice].filter(Boolean).join("; "), true);
		else setStatus(state.boards.length === 0 ? T.noArtboards : "", false);
		if (!keepView) win.requestAnimationFrame(actions.fit);
		await actions.loadHandoffs();
		await actions.loadComments();
		await actions.loadParts();
	}

	/** Reloads the artboard in its own frame and in every size frame of All sizes. */
	function reloadBoard(board) {
		const url = `${boardUrl(board)}?v=${Date.now()}`;
		for (const surface of actions.surfacesOf(board)) {
			surface.rects = null;
			surface.frame.src = url;
		}
	}

	/** The system board first, then the design's artboards, each where the layout puts it. */
	function placeBoards() {
		// An open artboard menu belongs to a board this may replace.
		actions.closeBoardMenu();
		const boards = actions.allBoards();
		els.world.replaceChildren(...boards.map((board) => board.wrapper));
		// The token inspector's frame may be one this replaced, and Quality lists the boards placed now.
		actions.hideGoneInspector();
		actions.refreshChecks();
		actions.layoutBoards(boards);
		if (state.focus && !boards.includes(state.focus)) actions.exitFocus();
		else actions.applyFocusState();
	}

	/** Reads api/system and creates or drops the system board; true when it appeared or went away. */
	async function refreshSystem() {
		let info = null;
		try { info = await getJson("api/system"); } catch { info = null; }
		const exists = Boolean(info && info.exists === true && isFiniteNumber(info.width) && isFiniteNumber(info.height));
		if (exists === Boolean(state.systemBoard)) return false;
		if (state.systemBoard) actions.removeSizeFrames(state.systemBoard);
		// Its title and tradeoff are the canvas's, so they read in the current language.
		const artboard = exists ? { file: String(info.file), get title() { return T.systemTitle; }, get tradeoff() { return T.systemTradeoff; }, width: info.width, height: info.height } : null;
		store.setDesign({ systemBoard: artboard ? createBoard(null, artboard, true) : null });
		return true;
	}

	async function onSystemChange() {
		if (!(await refreshSystem())) {
			if (state.systemBoard) reloadBoard(state.systemBoard);
			return;
		}
		if (state.focus && !actions.allBoards().includes(state.focus)) actions.exitFocus();
		if (!state.slug) {
			showSystemOnly();
			return;
		}
		if (!state.manifest || state.manifest.slug !== state.slug) return;
		if (state.boards.length === 0 && !state.systemBoard) showEmpty(() => T.noArtboards);
		else {
			els.empty.hidden = true;
			placeBoards();
		}
	}

	els.design.addEventListener("change", () => {
		actions.exitCompare(false);
		store.setDesign({ slug: els.design.value });
		actions.hideInspector();
		// The old design's checks and ring go at once too.
		actions.refreshChecks();
		// The old design's parts go at once: loadManifest may never reach loadParts (a failed or empty design.json).
		actions.clearParts();
		loadManifest(state.slug, false);
	});

	/**
	 * The server's show event (S14): `open` while this page is connected switches it to
	 * that design (null: the system-only view) and reloads every board from the server, so
	 * a change event this page missed is caught up. The same design refreshes in place and
	 * keeps zoom, pan and focus mode on the same artboard; another design leaves focus mode
	 * first, since its artboards differ.
	 */
	async function showDesign(slug) {
		const same = slug === state.slug;
		if (!same) {
			actions.exitCompare(false);
			actions.exitFocus();
			store.setDesign({ slug });
			actions.hideInspector();
			actions.refreshChecks();
			store.setComments({ comments: [], activeId: null });
			actions.renderComments();
			// The old design's parts go with it, before the new design's parts.json is read.
			actions.clearParts();
		}
		if (!(await refreshSystem()) && state.systemBoard) reloadBoard(state.systemBoard);
		if (slug !== state.slug) return;
		try {
			await refreshDesigns(false);
		} catch (error) {
			setStatus(T.cannotList(error.message), true);
		}
		if (slug !== state.slug) return;
		if (slug === null) {
			win.history.replaceState(null, "", base);
			doc.title = "Gentle Design";
			if (!same || !state.systemBoard) showSystemOnly();
			return;
		}
		await loadManifest(slug, same);
	}

	async function start() {
		actions.applyView();
		await refreshSystem();
		try {
			await refreshDesigns();
		} catch (error) {
			showEmpty(() => T.cannotList(error.message));
			return;
		}
		if (!state.slug) {
			showSystemOnly();
			return;
		}
		await loadManifest(state.slug, false);
	}

	/** A new language: every board's labels in place (no frame reloads), the feature line, the empty notice and the invalid designs' names. */
	function relabel() {
		for (const board of actions.allBoards()) labelers.get(board)?.();
		showFeature(state.manifest);
		if (emptyText && !els.empty.hidden) els.empty.textContent = emptyText();
		for (const [option, slug] of invalidOptions) option.textContent = T.invalidDesign(slug);
	}

	return { refreshDesigns, sendMode, boardUrl, loadManifest, reloadBoard, onSystemChange, showDesign, start, relabel };
}
