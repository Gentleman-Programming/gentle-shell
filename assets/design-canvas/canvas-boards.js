// Designs and artboards: the design list, each board's sandboxed iframe, header
// and Implement this control, manifest loading, the system board, the show
// event and the first load.
// design/system.html, when present, is the first board of every design; it is
// kept out of state.boards so comments never apply to it.

const SYSTEM_LABEL = { title: "Design system", tradeoff: "Project tokens (design/system.md)" };
const SYSTEM_NOTE = "Comments apply to design artboards only. To change the system, update the project's design sources and run /gentle:design sync.";

export function init(ctx) {
	const { win, doc, els, store, api, ui, actions } = ctx;
	const { state } = store;
	const { base, fileUrl, getJson, postJson, isFiniteNumber } = api;
	const { setStatus, showToast } = ui;

	function showEmpty(text) {
		actions.exitFocus();
		els.world.replaceChildren();
		store.setDesign({ boards: [] });
		els.empty.textContent = text;
		els.empty.hidden = false;
	}

	function renderDesignOptions(designs) {
		const options = designs.map((design) => {
			const option = doc.createElement("option");
			option.value = design.slug;
			option.textContent = design.valid ? design.title : `${design.slug} (invalid design.json)`;
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

	function sendMode(board) {
		board.frame.contentWindow?.postMessage({ type: "gd:mode", enabled: state.commenting && !board.system }, "*");
	}

	function boardUrl(board) {
		return board.system ? `${base}system.html` : fileUrl(board.slug, board.artboard.file);
	}

	function createBoard(slug, artboard, system = false) {
		const wrapper = doc.createElement("section");
		wrapper.className = system ? "gd-artboard gd-system-board" : "gd-artboard";
		wrapper.setAttribute("aria-label", artboard.title);
		const label = doc.createElement("div");
		label.className = "gd-artboard-label";
		const title = doc.createElement("h2");
		title.className = "gd-artboard-title";
		title.textContent = artboard.title;
		label.append(title);
		if (artboard.tradeoff) {
			const tradeoff = doc.createElement("p");
			tradeoff.className = "gd-artboard-tradeoff";
			tradeoff.textContent = artboard.tradeoff;
			label.append(tradeoff);
		}
		// The handoff state, the chosen badge and Compare (rendered by renderHandoff) stack above
		// Implement this, at screen size, so neither covers the other at any zoom.
		const handoff = doc.createElement("div");
		handoff.className = "gd-handoff";
		handoff.hidden = true;
		if (!system) {
			const actions = doc.createElement("div");
			actions.className = "gd-board-actions";
			actions.append(handoff, createImplementControl(slug, artboard));
			label.append(actions);
		}
		if (system) {
			label.title = SYSTEM_NOTE;
			const note = doc.createElement("p");
			note.className = "gd-system-note";
			note.title = SYSTEM_NOTE;
			note.textContent = "Comments off on this board";
			label.append(note);
		}
		const frame = doc.createElement("iframe");
		frame.className = "gd-artboard-frame";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.title = `${artboard.title} artboard`;
		frame.style.width = `${artboard.width}px`;
		const box = doc.createElement("div");
		box.className = "gd-frame-box";
		const shield = doc.createElement("div");
		shield.className = "gd-shield";
		shield.setAttribute("role", "button");
		shield.tabIndex = 0;
		shield.setAttribute("aria-label", system ? `View ${artboard.title} (read-only)` : `Use ${artboard.title}`);
		const hint = doc.createElement("span");
		hint.className = "gd-shield-hint";
		hint.setAttribute("aria-hidden", "true");
		hint.textContent = system ? "Click to view the design system" : "Click to use this design";
		shield.append(hint);
		const pins = doc.createElement("div");
		pins.className = "gd-pins";
		// rects: null until the artboard reports where each commented element is.
		const board = { slug, artboard, frame, wrapper, shield, pins, handoff, rects: null, system, viewHeight: 0 };
		actions.setFrameHeight(board, artboard.height);
		actions.renderHandoff(board);
		shield.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			actions.enterFocus(board);
		});
		frame.addEventListener("load", () => {
			board.rects = null;
			sendMode(board);
			actions.sendFocus(board);
			if (!system) actions.sendPins(board);
			// A live reload of the focused artboard keeps focus mode and its keyboard focus.
			if (state.focus === board && els.popover.hidden && (doc.activeElement === frame || doc.activeElement === doc.body)) frame.focus();
		});
		frame.src = boardUrl(board);
		box.append(frame, shield, pins);
		wrapper.append(label, box);
		return board;
	}

	/** "Implement this" with an inline confirm step; the system board never gets one. */
	function createImplementControl(slug, artboard) {
		const box = doc.createElement("div");
		box.className = "gd-implement";
		const start = doc.createElement("button");
		start.type = "button";
		start.className = "gd-implement-start";
		start.textContent = "Implement this";
		start.setAttribute("aria-label", `Implement ${artboard.title} in the project`);
		const confirm = doc.createElement("div");
		confirm.className = "gd-implement-confirm";
		confirm.setAttribute("role", "group");
		confirm.setAttribute("aria-label", `Confirm implementing ${artboard.title}`);
		confirm.hidden = true;
		const question = doc.createElement("span");
		question.textContent = "Send it to the session to implement?";
		const yes = doc.createElement("button");
		yes.type = "button";
		yes.className = "gd-primary";
		yes.textContent = "Send";
		const no = doc.createElement("button");
		no.type = "button";
		no.textContent = "Cancel";
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
				const text = queued
					? `Queued: the session will implement ${artboard.title} after its current task.`
					: `Sent: the session is implementing ${artboard.title} now.`;
				setStatus(text, false);
				showToast(text, false);
				// The server recorded it before answering; the handoffs.json change event confirms it.
				actions.noteHandoff(slug, artboard.file, queued);
			} else {
				const text = `Not sent: ${reply.body.reason || reply.body.error || "error"}`;
				setStatus(text, true);
				showToast(text, true);
			}
			close(true);
		});
		box.append(start, confirm);
		return box;
	}

	function showFeature(manifest) {
		const feature = manifest && typeof manifest.feature === "string" ? manifest.feature : "";
		els.feature.textContent = feature ? `Feature: ${feature}` : "";
		els.feature.hidden = !feature;
	}

	/** No design selected: only the system board, or the empty notice. */
	function showSystemOnly() {
		store.setDesign({ manifest: null, boards: [] });
		showFeature(null);
		els.title.textContent = "Gentle Design";
		if (!state.systemBoard) {
			showEmpty("No designs yet. Run /gentle:design with a brief to create one.");
			return;
		}
		els.empty.hidden = true;
		placeBoards();
		setStatus("", false);
		win.requestAnimationFrame(actions.fit);
	}

	async function loadManifest(slug, keepView) {
		let manifest;
		try {
			manifest = await getJson(`api/designs/${encodeURIComponent(slug)}`);
		} catch (error) {
			showEmpty(`Design "${slug}" cannot be shown: ${error.message}`);
			setStatus(`design.json for ${slug} is invalid`, true);
			return;
		}
		if (slug !== state.slug) return;
		actions.closePopover();
		store.setDesign({ manifest });
		showFeature(manifest);
		els.title.textContent = manifest.title;
		doc.title = `${manifest.title} · Gentle Design`;
		win.history.replaceState(null, "", `${base}d/${encodeURIComponent(slug)}/`);
		if (manifest.artboards.length === 0 && !state.systemBoard) {
			showEmpty("This design has no artboards yet.");
			return;
		}
		els.empty.hidden = true;
		const focusFile = state.focus && !state.focus.system ? state.focus.artboard.file : null;
		store.setDesign({ boards: manifest.artboards.map((artboard) => createBoard(slug, artboard)) });
		// A manifest reload keeps focus mode on the same artboard file while it still exists.
		if (focusFile) store.setFocus({ focus: state.boards.find((board) => board.artboard.file === focusFile) ?? state.focus });
		placeBoards();
		if (state.focus) win.requestAnimationFrame(actions.centerFocus);
		const warnings = Array.isArray(manifest.warnings) ? manifest.warnings.filter((warning) => typeof warning === "string") : [];
		setStatus(warnings.length > 0 ? `design.json: ${warnings.join("; ")}` : state.boards.length === 0 ? "This design has no artboards yet." : "", warnings.length > 0);
		if (!keepView) win.requestAnimationFrame(actions.fit);
		await actions.loadHandoffs();
		await actions.loadComments();
	}

	function reloadBoard(board) {
		board.rects = null;
		board.frame.src = `${boardUrl(board)}?v=${Date.now()}`;
	}

	/** The system board first, then the design's artboards. */
	function placeBoards() {
		const boards = actions.allBoards();
		els.world.replaceChildren(...boards.map((board) => board.wrapper));
		if (state.focus && !boards.includes(state.focus)) actions.exitFocus();
		else actions.applyFocusState();
	}

	/** Reads api/system and creates or drops the system board; true when it appeared or went away. */
	async function refreshSystem() {
		let info = null;
		try { info = await getJson("api/system"); } catch { info = null; }
		const exists = Boolean(info && info.exists === true && isFiniteNumber(info.width) && isFiniteNumber(info.height));
		if (exists === Boolean(state.systemBoard)) return false;
		store.setDesign({ systemBoard: exists ? createBoard(null, { file: String(info.file), ...SYSTEM_LABEL, width: info.width, height: info.height }, true) : null });
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
		if (state.boards.length === 0 && !state.systemBoard) showEmpty("This design has no artboards yet.");
		else {
			els.empty.hidden = true;
			placeBoards();
		}
	}

	els.design.addEventListener("change", () => {
		actions.exitCompare(false);
		store.setDesign({ slug: els.design.value });
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
			store.setComments({ comments: [], activeId: null });
			actions.renderComments();
		}
		if (!(await refreshSystem()) && state.systemBoard) reloadBoard(state.systemBoard);
		if (slug !== state.slug) return;
		try {
			await refreshDesigns(false);
		} catch (error) {
			setStatus(`Designs cannot be listed: ${error.message}`, true);
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
			showEmpty(`Designs cannot be listed: ${error.message}`);
			return;
		}
		if (!state.slug) {
			showSystemOnly();
			return;
		}
		await loadManifest(state.slug, false);
	}

	return { refreshDesigns, sendMode, boardUrl, loadManifest, reloadBoard, onSystemChange, showDesign, start };
}
