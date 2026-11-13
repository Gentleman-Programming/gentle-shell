// Comments persisted in design/<slug>/comments.json: pins on the artboards, the
// list and its filter, the send mode, Send all, the panel and Comment mode.

// Every string the comments show, in English; canvas-i18n-es.js has the Spanish. The comments themselves and file names stay as written.
const TEXT = Object.freeze({
	open: (count) => `Open (${count})`,
	resolved: (count) => `Resolved (${count})`,
	sendAll: (count) => `Send all (${count})`,
	empty: "No comments yet. Turn on Comment mode and click an element.",
	emptyOpen: "No open comments.",
	emptyResolved: "No resolved comments.",
	pin: (number, status, text) => `Comment ${number} (${status}): ${text}`,
	statuses: { open: "open", resolved: "resolved" },
	showLabel: (number, file) => `Show comment ${number} on ${file}`,
	sent: "Sent",
	notSent: "Not sent",
	detached: "Detached",
	shot: (number) => `Screenshot of comment ${number}`,
	resolve: "Resolve",
	reopen: "Reopen",
	resolveLabel: (number) => `Resolve comment ${number}`,
	reopenLabel: (number) => `Reopen comment ${number}`,
	unreadable: (slug, reason) => `comments.json for ${slug} cannot be read: ${reason}`,
	notUpdated: (reason) => `Comment not updated: ${reason}`,
	resolvedDone: "Comment resolved",
	reopenedDone: "Comment reopened",
	notSentAll: (reason) => `Comments not sent: ${reason}`,
	sentAll: (count) => `Sent ${count} comment${count === 1 ? "" : "s"} to the session`,
	noneUnsent: "No unsent comments",
	error: "error",
	save: "Save",
	send: "Send",
	commentMode: "Comment mode: click an element in an artboard",
});

const LIMITS = { pins: 500 };
const MODE_KEY = "gentle-design:send-mode";

export function init(ctx) {
	const { win, doc, els, store, api, ui, actions } = ctx;
	const { state } = store;
	const { base, getJson, postJson, isFiniteNumber } = api;
	const { setStatus } = ui;
	const T = ctx.i18n.text("comments", TEXT);

	function storedMode() {
		try {
			return win.localStorage.getItem(MODE_KEY) === "collect" ? "collect" : "send";
		} catch {
			return "send";
		}
	}

	function commentsForBoard(board) {
		return state.comments.filter((comment) => comment.file === board.artboard.file);
	}

	/** A board's frame or one of its size frames (canvas-sizes.js) locates its artboard's comments and reports where they are. */
	function sendPins(surface) {
		const pins = commentsForBoard(actions.ownerOf(surface)).slice(0, LIMITS.pins).map((comment) => ({ id: comment.id, selector: comment.selector }));
		surface.frame.contentWindow?.postMessage({ type: "gd:pins", pins }, "*");
	}

	/** Every frame of every design board: its own and, in All sizes, its size frames. */
	function eachSurface(callback) {
		for (const board of state.boards) actions.surfacesOf(board).forEach(callback);
	}

	/** Detached: the artboard is gone, or its own frame reported that the selector matches nothing. */
	function isDetached(comment) {
		const board = state.boards.find((candidate) => candidate.artboard.file === comment.file);
		if (!board) return true;
		return Boolean(board.rects && board.rects.has(comment.id) && board.rects.get(comment.id) === null);
	}

	function detachedKey() {
		return state.comments.filter(isDetached).map((comment) => comment.id).join(",");
	}

	function commentNumber(comment) {
		return state.comments.indexOf(comment) + 1;
	}

	/** The pins of one frame, at their element's position in that frame; a size frame has its own set. */
	function renderPins(surface) {
		const pins = [];
		for (const comment of commentsForBoard(actions.ownerOf(surface))) {
			const rect = surface.rects?.get(comment.id);
			// A 0x0 rect is an element that is hidden or not rendered: no pin at the artboard's corner.
			if (!rect || (rect.width === 0 && rect.height === 0)) continue;
			if (rect.x + rect.width < 0 || rect.y + rect.height < 0 || rect.x > surface.viewWidth || rect.y > surface.viewHeight) continue;
			const pin = doc.createElement("button");
			pin.type = "button";
			pin.className = "gd-pin";
			pin.dataset.id = comment.id;
			pin.dataset.status = comment.status;
			pin.classList.toggle("gd-pin-active", comment.id === state.activeId);
			pin.textContent = String(commentNumber(comment));
			pin.setAttribute("aria-label", T.pin(commentNumber(comment), T.statuses[comment.status] ?? comment.status, comment.comment));
			pin.style.left = `${Math.max(0, rect.x)}px`;
			pin.style.top = `${Math.max(0, rect.y)}px`;
			pin.addEventListener("click", (event) => {
				event.stopPropagation();
				selectComment(comment.id, { scroll: false, focusList: true });
			});
			pins.push(pin);
		}
		const focused = surface.pins.contains(doc.activeElement) ? doc.activeElement.dataset.id : null;
		surface.pins.replaceChildren(...pins);
		if (focused) pins.find((pin) => pin.dataset.id === focused)?.focus();
	}

	function renderList() {
		const open = state.comments.filter((comment) => comment.status === "open");
		const resolved = state.comments.filter((comment) => comment.status === "resolved");
		els.filterOpen.textContent = T.open(open.length);
		els.filterResolved.textContent = T.resolved(resolved.length);
		els.filterOpen.setAttribute("aria-pressed", String(state.filter === "open"));
		els.filterResolved.setAttribute("aria-pressed", String(state.filter === "resolved"));
		els.countComments.textContent = String(open.length);
		const unsent = open.filter((comment) => comment.sentAt === null).length;
		els.sendAll.textContent = T.sendAll(unsent);
		els.sendAll.disabled = unsent === 0 || sendingAll;
		const shown = state.filter === "open" ? open : resolved;
		els.panelEmpty.hidden = shown.length > 0;
		els.panelEmpty.textContent = state.comments.length === 0 ? T.empty : state.filter === "open" ? T.emptyOpen : T.emptyResolved;
		els.list.replaceChildren(...shown.map((comment) => {
			const item = doc.createElement("li");
			item.className = "gd-comment-item";
			item.dataset.id = comment.id;
			item.classList.toggle("gd-active", comment.id === state.activeId);
			const show = doc.createElement("button");
			show.type = "button";
			show.className = "gd-comment-show";
			show.setAttribute("aria-label", T.showLabel(commentNumber(comment), comment.file));
			const meta = doc.createElement("span");
			meta.className = "gd-comment-meta";
			const number = doc.createElement("span");
			number.className = "gd-comment-number";
			number.textContent = `#${commentNumber(comment)}`;
			const file = doc.createElement("span");
			file.textContent = comment.file;
			meta.append(number, file);
			const badge = (text, kind) => {
				const element = doc.createElement("span");
				element.className = `gd-badge gd-badge-${kind}`;
				element.textContent = text;
				meta.append(element);
			};
			badge(comment.sentAt ? T.sent : T.notSent, comment.sentAt ? "sent" : "unsent");
			if (isDetached(comment)) badge(T.detached, "detached");
			const text = doc.createElement("span");
			text.className = "gd-comment-text";
			text.style.display = "block";
			text.textContent = comment.comment;
			show.append(meta, text);
			// The size it was made at, when not at the artboard's own size (canvas-sizes.js).
			const made = actions.viewportChip(comment.viewport);
			if (made) show.append(made);
			if (comment.screenshot) {
				const shot = doc.createElement("img");
				shot.className = "gd-comment-shot";
				shot.alt = T.shot(commentNumber(comment));
				shot.loading = "lazy";
				shot.src = `${base}api/designs/${encodeURIComponent(state.slug)}/comments/${encodeURIComponent(comment.id)}/screenshot`;
				show.append(shot);
			}
			show.addEventListener("click", () => selectComment(comment.id, { scroll: true, focusList: false }));
			const controls = doc.createElement("div");
			controls.className = "gd-comment-actions";
			const toggle = doc.createElement("button");
			toggle.type = "button";
			const next = comment.status === "open" ? "resolved" : "open";
			toggle.textContent = next === "resolved" ? T.resolve : T.reopen;
			toggle.setAttribute("aria-label", (next === "resolved" ? T.resolveLabel : T.reopenLabel)(commentNumber(comment)));
			toggle.addEventListener("click", () => setCommentStatus(comment.id, next));
			controls.append(toggle);
			item.append(show, controls);
			return item;
		}));
	}

	function renderComments() {
		renderList();
		eachSurface(renderPins);
	}

	async function loadComments() {
		const slug = state.slug;
		if (!slug) return;
		let comments = [];
		try {
			comments = (await getJson(`api/designs/${encodeURIComponent(slug)}/comments`)).comments;
		} catch (error) {
			setStatus(T.unreadable(slug, error.message), true);
		}
		if (slug !== state.slug || !Array.isArray(comments)) return;
		store.setComments({ comments });
		if (state.activeId && !comments.some((comment) => comment.id === state.activeId)) store.setComments({ activeId: null });
		eachSurface(sendPins);
		renderComments();
	}

	function selectComment(id, options) {
		store.setComments({ activeId: id });
		renderComments();
		const comment = state.comments.find((candidate) => candidate.id === id);
		if (!comment) return;
		if (comment.status !== state.filter && options.focusList) {
			store.setComments({ filter: comment.status });
			renderList();
		}
		const board = state.boards.find((candidate) => candidate.artboard.file === comment.file);
		if (board) for (const surface of actions.surfacesOf(board)) surface.frame.contentWindow?.postMessage({ type: "gd:highlight", id }, "*");
		// A pin clicked while Quality shows brings the list back, so focus can land in it.
		if (options.focusList && state.tab !== "comments") actions.setTab("comments");
		if (options.focusList) els.list.querySelector(`[data-id="${win.CSS.escape(id)}"] .gd-comment-show`)?.focus();
		if (!options.scroll) return;
		// The focused artboard is already at 1:1; another board's comment leaves focus mode first.
		if (state.focus) {
			if (state.focus === board) return;
			actions.exitFocus();
		}
		const pin = board?.pins.querySelector(`[data-id="${win.CSS.escape(id)}"]`);
		const target = pin ?? board?.frame;
		if (!target) return;
		const viewport = els.viewport.getBoundingClientRect();
		const rect = target.getBoundingClientRect();
		actions.panBy(viewport.left + viewport.width / 2 - (rect.left + rect.width / 2), viewport.top + viewport.height / 2 - (rect.top + rect.height / 2));
	}

	async function setCommentStatus(id, status) {
		const slug = state.slug;
		const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/comments/${encodeURIComponent(id)}/status`, { status }).catch((error) => ({ ok: false, body: { error: error.message } }));
		if (!reply.ok) setStatus(T.notUpdated(reply.body.reason || reply.body.error || T.error), true);
		else setStatus(status === "resolved" ? T.resolvedDone : T.reopenedDone, false);
		await loadComments();
	}

	// Send all is in flight: any re-render (a filter, a language switch) keeps the button disabled until the reply.
	let sendingAll = false;
	els.sendAll.addEventListener("click", async () => {
		const slug = state.slug;
		if (!slug) return;
		sendingAll = true;
		els.sendAll.disabled = true;
		const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/comments/send-all`, {}).catch((error) => ({ ok: false, body: { error: error.message } }));
		sendingAll = false;
		if (!reply.ok) setStatus(T.notSentAll(reply.body.reason || reply.body.error || T.error), true);
		else setStatus(reply.body.sent ? T.sentAll(reply.body.sent) : T.noneUnsent, false);
		await loadComments();
	});

	function setMode(mode) {
		store.setMode(mode === "collect" ? "collect" : "send");
		els.modeSend.checked = state.mode === "send";
		els.modeCollect.checked = state.mode === "collect";
		labelSend();
		try { win.localStorage.setItem(MODE_KEY, state.mode); } catch { /* storage may be unavailable */ }
	}

	/** The comment box's submit button: Save in Collect, Send in Send now. */
	function labelSend() {
		els.send.textContent = state.mode === "collect" ? T.save : T.send;
	}

	/** A new language: the panel, the pins and the submit button, in place (no frame reloads). */
	function relabel() {
		renderComments();
		labelSend();
	}

	els.modeSend.addEventListener("change", () => setMode("send"));
	els.modeCollect.addEventListener("change", () => setMode("collect"));
	els.filterOpen.addEventListener("click", () => { store.setComments({ filter: "open" }); renderList(); });
	els.filterResolved.addEventListener("click", () => { store.setComments({ filter: "resolved" }); renderList(); });
	function setPanel(show) {
		els.panel.hidden = !show;
		els.panelToggle.setAttribute("aria-pressed", String(show));
		// The viewport changes size with the panel; without ResizeObserver nothing else reports it.
		if (typeof win.ResizeObserver !== "function") actions.viewportResized();
	}

	els.panelToggle.addEventListener("click", () => setPanel(els.panel.hidden));

	function readRects(data) {
		if (!Array.isArray(data.rects) || data.rects.length > LIMITS.pins) return null;
		const rects = new Map();
		for (const entry of data.rects) {
			if (!entry || typeof entry.id !== "string" || entry.id.length > 32) return null;
			const rect = entry.rect;
			if (rect === null) rects.set(entry.id, null);
			else if (rect && ["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key]))) rects.set(entry.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
			else return null;
		}
		return rects;
	}

	function setCommenting(enabled) {
		store.setCommenting(enabled);
		actions.renderTools();
		els.world.classList.toggle("gd-commenting", enabled);
		state.boards.forEach((board) => board.sizesView?.classList.toggle("gd-commenting", enabled));
		eachSurface(actions.sendMode);
		setStatus(enabled ? T.commentMode : "", false);
		if (!enabled) {
			actions.setHoverBoard(null);
			actions.closePopover();
		}
	}

	els.comment.addEventListener("click", () => setCommenting(!state.commenting));

	return { relabel, storedMode, sendPins, detachedKey, renderPins, renderList, renderComments, loadComments, setMode, setPanel, readRects, setCommenting };
}
