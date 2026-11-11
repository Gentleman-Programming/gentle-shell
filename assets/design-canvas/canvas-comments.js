// Comments persisted in design/<slug>/comments.json: pins on the artboards, the
// list and its filter, the send mode, Send all, the panel and Comment mode.

const LIMITS = { pins: 500 };
const MODE_KEY = "gentle-design:send-mode";

export function init(ctx) {
	const { win, doc, els, store, api, ui, actions } = ctx;
	const { state } = store;
	const { base, getJson, postJson, isFiniteNumber } = api;
	const { setStatus } = ui;

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

	function sendPins(board) {
		const pins = commentsForBoard(board).slice(0, LIMITS.pins).map((comment) => ({ id: comment.id, selector: comment.selector }));
		board.frame.contentWindow?.postMessage({ type: "gd:pins", pins }, "*");
	}

	/** Detached: the artboard is gone, or it reported that the selector matches nothing. */
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

	function renderPins(board) {
		const pins = [];
		for (const comment of commentsForBoard(board)) {
			const rect = board.rects?.get(comment.id);
			if (!rect) continue;
			if (rect.x + rect.width < 0 || rect.y + rect.height < 0 || rect.x > board.artboard.width || rect.y > board.viewHeight) continue;
			const pin = doc.createElement("button");
			pin.type = "button";
			pin.className = "gd-pin";
			pin.dataset.id = comment.id;
			pin.dataset.status = comment.status;
			pin.classList.toggle("gd-pin-active", comment.id === state.activeId);
			pin.textContent = String(commentNumber(comment));
			pin.setAttribute("aria-label", `Comment ${commentNumber(comment)} (${comment.status}): ${comment.comment}`);
			pin.style.left = `${Math.max(0, rect.x)}px`;
			pin.style.top = `${Math.max(0, rect.y)}px`;
			pin.addEventListener("click", (event) => {
				event.stopPropagation();
				selectComment(comment.id, { scroll: false, focusList: true });
			});
			pins.push(pin);
		}
		const focused = board.pins.contains(doc.activeElement) ? doc.activeElement.dataset.id : null;
		board.pins.replaceChildren(...pins);
		if (focused) pins.find((pin) => pin.dataset.id === focused)?.focus();
	}

	function renderList() {
		const open = state.comments.filter((comment) => comment.status === "open");
		const resolved = state.comments.filter((comment) => comment.status === "resolved");
		els.filterOpen.textContent = `Open (${open.length})`;
		els.filterResolved.textContent = `Resolved (${resolved.length})`;
		els.filterOpen.setAttribute("aria-pressed", String(state.filter === "open"));
		els.filterResolved.setAttribute("aria-pressed", String(state.filter === "resolved"));
		const unsent = open.filter((comment) => comment.sentAt === null).length;
		els.sendAll.textContent = `Send all (${unsent})`;
		els.sendAll.disabled = unsent === 0;
		const shown = state.filter === "open" ? open : resolved;
		els.panelEmpty.hidden = shown.length > 0;
		els.panelEmpty.textContent = state.comments.length === 0
			? "No comments yet. Turn on Comment mode and click an element."
			: state.filter === "open" ? "No open comments." : "No resolved comments.";
		els.list.replaceChildren(...shown.map((comment) => {
			const item = doc.createElement("li");
			item.className = "gd-comment-item";
			item.dataset.id = comment.id;
			item.classList.toggle("gd-active", comment.id === state.activeId);
			const show = doc.createElement("button");
			show.type = "button";
			show.className = "gd-comment-show";
			show.setAttribute("aria-label", `Show comment ${commentNumber(comment)} on ${comment.file}`);
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
			badge(comment.sentAt ? "Sent" : "Not sent", comment.sentAt ? "sent" : "unsent");
			if (isDetached(comment)) badge("Detached", "detached");
			const text = doc.createElement("span");
			text.className = "gd-comment-text";
			text.style.display = "block";
			text.textContent = comment.comment;
			show.append(meta, text);
			if (comment.screenshot) {
				const shot = doc.createElement("img");
				shot.className = "gd-comment-shot";
				shot.alt = `Screenshot of comment ${commentNumber(comment)}`;
				shot.loading = "lazy";
				shot.src = `${base}api/designs/${encodeURIComponent(state.slug)}/comments/${encodeURIComponent(comment.id)}/screenshot`;
				show.append(shot);
			}
			show.addEventListener("click", () => selectComment(comment.id, { scroll: true, focusList: false }));
			const actions = doc.createElement("div");
			actions.className = "gd-comment-actions";
			const toggle = doc.createElement("button");
			toggle.type = "button";
			const next = comment.status === "open" ? "resolved" : "open";
			toggle.textContent = next === "resolved" ? "Resolve" : "Reopen";
			toggle.setAttribute("aria-label", `${toggle.textContent} comment ${commentNumber(comment)}`);
			toggle.addEventListener("click", () => setCommentStatus(comment.id, next));
			actions.append(toggle);
			item.append(show, actions);
			return item;
		}));
	}

	function renderComments() {
		renderList();
		state.boards.forEach(renderPins);
	}

	async function loadComments() {
		const slug = state.slug;
		if (!slug) return;
		let comments = [];
		try {
			comments = (await getJson(`api/designs/${encodeURIComponent(slug)}/comments`)).comments;
		} catch (error) {
			setStatus(`comments.json for ${slug} cannot be read: ${error.message}`, true);
		}
		if (slug !== state.slug || !Array.isArray(comments)) return;
		store.setComments({ comments });
		if (state.activeId && !comments.some((comment) => comment.id === state.activeId)) store.setComments({ activeId: null });
		state.boards.forEach(sendPins);
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
		board?.frame.contentWindow?.postMessage({ type: "gd:highlight", id }, "*");
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
		if (!reply.ok) setStatus(`Comment not updated: ${reply.body.reason || reply.body.error || "error"}`, true);
		else setStatus(status === "resolved" ? "Comment resolved" : "Comment reopened", false);
		await loadComments();
	}

	els.sendAll.addEventListener("click", async () => {
		const slug = state.slug;
		if (!slug) return;
		els.sendAll.disabled = true;
		const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/comments/send-all`, {}).catch((error) => ({ ok: false, body: { error: error.message } }));
		if (!reply.ok) setStatus(`Comments not sent: ${reply.body.reason || reply.body.error || "error"}`, true);
		else setStatus(reply.body.sent ? `Sent ${reply.body.sent} comment${reply.body.sent === 1 ? "" : "s"} to the session` : "No unsent comments", false);
		await loadComments();
	});

	function setMode(mode) {
		store.setMode(mode === "collect" ? "collect" : "send");
		els.modeSend.checked = state.mode === "send";
		els.modeCollect.checked = state.mode === "collect";
		els.send.textContent = state.mode === "collect" ? "Save" : "Send";
		try { win.localStorage.setItem(MODE_KEY, state.mode); } catch { /* storage may be unavailable */ }
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
		state.boards.forEach(actions.sendMode);
		setStatus(enabled ? "Comment mode: click an element in an artboard" : "", false);
		if (!enabled) {
			actions.setHoverBoard(null);
			actions.closePopover();
		}
	}

	els.comment.addEventListener("click", () => setCommenting(!state.commenting));

	return { storedMode, sendPins, detachedKey, renderPins, renderList, renderComments, loadComments, setMode, setPanel, readRects, setCommenting };
}
