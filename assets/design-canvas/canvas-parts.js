// Partial implementations (design/<slug>/parts.json): one element of an artboard
// handed to the session on its own, without choosing a direction. The comment
// popover's Implement only this sends the picked element with the field as an
// optional note; "Partial implementations · N", at the bottom of the panel, lists
// the design's parts live with the state in words, the time, the excerpt, the
// agent's note, Show (that artboard in focus with the element highlighted in every
// frame of it) and, while the agent has not taken a part up, Remove behind an
// inline confirm. Which part has its confirm open and which Removes and sends are
// in flight are this module's own view state, kept across re-renders; the parts themselves
// change only through store.setParts.

const TEXT = Object.freeze({
	title: (count) => `Partial implementations · ${count}`,
	states: { sent: "Sent", queued: "Queued", in_progress: "In progress", implemented: "Implemented ✓" },
	times: {
		sent: (time, today) => `Sent ${today ? "at" : "on"} ${time}`,
		queued: (time, today) => `Queued ${today ? "at" : "on"} ${time}`,
		in_progress: (time) => `In progress since ${time}`,
		implemented: (time, today) => `Implemented ${today ? "at" : "on"} ${time}`,
	},
	quoted: (value) => `“${value}”`,
	show: "Show",
	showLabel: (number, file) => `Show part ${number} in ${file}`,
	remove: "Remove",
	removeLabel: (number, file) => `Remove part ${number} in ${file}`,
	question: "Remove this part? The agent can no longer report on it.",
	confirmLabel: (number) => `Confirm removing part ${number}`,
	cancel: "Cancel",
	partTitle: "Build only this element in the project; the field is an optional note",
	partOffline: "The canvas is not connected to a Pi session; open it with /gentle:design open",
	noteTooLong: (max) => `The note can have at most ${max} characters.`,
	sending: "Sending…",
	sentShort: "Sent to the session",
	sent: (title) => `Sent: the session is building only this part of ${title} now.`,
	queued: (title) => `Queued: the session will build only this part of ${title} after its current task.`,
	notSent: (why) => `Not sent: ${why}`,
	sendErrors: {
		"implement-part-unavailable": "the canvas is not connected to a Pi session; open it with /gentle:design open.",
		"invalid-file": "that artboard is no longer in the design.",
		"invalid-selector": "this element's selector cannot be sent.",
		"invalid-excerpt": "this element's text cannot be sent.",
		"invalid-note": "the note can have at most 2000 characters.",
		"not-found": "the design is gone.",
		"too-many-parts": "this design already has 100 parts; remove one first.",
		"parts-too-large": "parts.json is full; remove a part first.",
		"invalid-parts": "parts.json cannot be read; fix it or delete it.",
	},
	deliveryFailed: (reason) => (reason ? `the session did not take it (${reason}).` : "the session did not take it."),
	removed: "Part removed. The agent can no longer report on it.",
	notRemoved: (why) => `Not removed: ${why}`,
	removeErrors: {
		"part-not-sent": "the agent already took this part up.",
		"not-found": "this part is gone; its delivery failed or it was removed already.",
		"invalid-parts": "parts.json cannot be read; fix it or delete it.",
		"invalid-part": "this part's id is not valid.",
	},
	notShown: "Not shown: the artboard of this part is no longer in the design.",
	unreadable: (slug, message) => `parts.json for ${slug} cannot be read: ${message}`,
});

const NOTE_LIMIT = 2000;
const STATUSES = ["sent", "in_progress", "implemented"];
const CLOSE_MS = 1200;

export function init(ctx) {
	const { win, doc, els, store, api, ui, actions } = ctx;
	const { state } = store;
	const { getJson, postJson, delivery } = api;
	const { setStatus, showToast } = ui;
	const T = ctx.i18n.text("parts", TEXT);
	// The part whose Remove confirm is open, and the Removes in flight ("<slug>/<id>").
	let confirming = null;
	const removing = new Set();
	// The latest loadParts: parts.json is written more than once per send, so an older reply landing last changes nothing.
	// A part listed by Implement only this or dropped by Remove counts as newer too; when that drops a read in flight,
	// which may carry other parts' updates, a fresh read follows.
	let partLoads = 0;
	let reading = 0;
	// The parts a parts.json read listed or a Remove dropped ("<slug>/<id>"): the server already reported on them, so
	// an Implement only this reply that lands later never lists them again, even when the list no longer has them.
	const reported = new Set();
	// The elements whose Implement only this is in flight ("<slug>/<file>/<selector>"), across popovers.
	const sending = new Set();
	const sendKey = (pick) => JSON.stringify([pick.board.slug, pick.board.artboard.file, pick.selector]);
	// Why Implement only this is disabled, under the popover's buttons, where the keyboard and screen readers reach it too.
	const partNote = doc.createElement("p");
	partNote.id = "gd-popover-part-note";
	partNote.className = "gd-popover-note";
	partNote.textContent = T.partOffline;
	partNote.hidden = true;
	els.form.append(partNote);

	const partsPath = (slug) => `api/designs/${encodeURIComponent(slug)}/parts`;
	// A request that never reached the server has no error code, only its reason.
	const failed = (error) => ({ ok: false, status: 0, body: { reason: error.message } });

	function isPart(part) {
		return Boolean(part && typeof part === "object" && typeof part.id === "string" && typeof part.file === "string" && typeof part.selector === "string" && STATUSES.includes(part.status));
	}

	/** The parts of the design shown; another design's parts never show. */
	function shownParts() {
		return state.parts.slug !== null && state.parts.slug === state.slug ? state.parts.parts : [];
	}

	function kindOf(part) {
		if (part.status === "sent") return part.queued === true ? "queued" : "sent";
		return part.status;
	}

	// By design and file: while a design switch waits for its design.json, the boards installed are the old design's.
	const boardOf = (part, slug) => state.boards.find((board) => board.slug === slug && board.artboard.file === part.file) ?? null;
	const removeKey = (slug, part) => `${slug}/${part.id}`;
	const twoDigits = (value) => String(value).padStart(2, "0");

	/** "09:30" today, "Oct 26, 09:30" this year, "Mar 4 2020, 09:05" before (in Spanish "26 oct, 09:30"); null when unreadable. */
	function timeOf(value) {
		const date = typeof value === "string" ? new Date(value) : null;
		if (!date || Number.isNaN(date.getTime())) return null;
		const now = new Date();
		const clock = `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
		if (date.toDateString() === now.toDateString()) return { time: clock, today: true };
		const day = date.toLocaleDateString(state.language === "es" ? "es-ES" : "en-US", { month: "short", day: "numeric" });
		return { time: `${date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`}, ${clock}`, today: false };
	}

	function chip(className, value) {
		const element = doc.createElement("span");
		element.className = className;
		element.textContent = value;
		return element;
	}

	function button(className, label, onClick) {
		const element = doc.createElement("button");
		element.type = "button";
		element.className = className;
		element.textContent = label;
		element.addEventListener("click", onClick);
		return element;
	}

	function renderPart(part, index, slug) {
		const number = index + 1;
		const kind = kindOf(part);
		const board = boardOf(part, slug);
		const item = doc.createElement("li");
		item.className = "gd-part";
		item.dataset.id = part.id;
		item.dataset.status = kind;
		const head = doc.createElement("div");
		head.className = "gd-part-head";
		head.append(chip("gd-part-title", board ? board.artboard.title : part.file), chip("gd-part-state", T.states[kind]));
		item.append(head);
		if (typeof part.excerpt === "string" && part.excerpt) item.append(chip("gd-part-excerpt", T.quoted(part.excerpt)));
		const when = timeOf(kind === "implemented" ? part.implementedAt : kind === "in_progress" ? part.startedAt : part.sentAt);
		if (when) item.append(chip("gd-part-time", T.times[kind](when.time, when.today)));
		if (typeof part.note === "string" && part.note) item.append(chip("gd-part-note", T.quoted(part.note)));
		const controls = doc.createElement("div");
		controls.className = "gd-part-actions";
		const show = button("gd-part-show", T.show, () => showPart(part));
		show.setAttribute("aria-label", T.showLabel(number, part.file));
		show.dataset.control = "show";
		show.disabled = !board;
		controls.append(show);
		if (kind === "sent" || kind === "queued") controls.append(...removeControl(part, number, slug));
		item.append(controls);
		return item;
	}

	/** Remove and its inline confirm (like Implement this): the agent can no longer report on a removed part. */
	function removeControl(part, number, slug) {
		const key = removeKey(slug, part);
		const inFlight = removing.has(key);
		const start = button("gd-part-remove", T.remove, () => {
			confirming = key;
			start.hidden = true;
			confirm.hidden = false;
			yes.focus();
		});
		start.setAttribute("aria-label", T.removeLabel(number, part.file));
		start.dataset.control = "remove";
		start.disabled = inFlight;
		const confirm = doc.createElement("div");
		confirm.className = "gd-part-confirm";
		confirm.setAttribute("role", "group");
		confirm.setAttribute("aria-label", T.confirmLabel(number));
		// Cancel and Esc wait for a Remove in flight: Remove (start) is disabled until it answers.
		const close = () => {
			if (removing.has(key)) return;
			confirming = null;
			confirm.hidden = true;
			start.hidden = false;
			start.focus();
		};
		const yes = button("gd-part-confirm-yes gd-primary", T.remove, () => removePart(slug, part));
		yes.dataset.control = "yes";
		// In flight it stays focusable, so the redraw keeps keyboard focus on it; removePart ignores the click.
		if (inFlight) yes.setAttribute("aria-disabled", "true");
		const no = button("gd-part-confirm-no", T.cancel, close);
		no.dataset.control = "no";
		no.disabled = inFlight;
		confirm.addEventListener("keydown", (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close();
		});
		confirm.append(chip("gd-part-question", T.question), yes, no);
		const open = confirming === key;
		confirm.hidden = !open;
		start.hidden = open;
		return [start, confirm];
	}

	/** The list from the store; keyboard focus on a part's control stays on it across a re-render. */
	function renderParts() {
		const parts = shownParts();
		const slug = state.parts.slug;
		if (confirming && !parts.some((part) => removeKey(slug, part) === confirming && ["sent", "queued"].includes(kindOf(part)))) confirming = null;
		const active = els.partsList.contains(doc.activeElement) ? doc.activeElement : null;
		const focusItem = active?.closest(".gd-part");
		const focus = focusItem ? { id: focusItem.dataset.id, control: active.dataset.control, index: Array.from(els.partsList.children).indexOf(focusItem) } : null;
		const rendered = parts.map((part, index) => renderPart(part, index, slug));
		els.partsList.replaceChildren(...rendered);
		els.parts.hidden = parts.length === 0;
		els.partsTitle.textContent = T.title(parts.length);
		if (focus) restoreFocus(rendered, focus);
	}

	/** The same control of the same part, else a usable one of the part now at its place, else the panel's toggle. */
	function restoreFocus(rendered, focus) {
		const usable = (element) => !element.hidden && !element.disabled && !element.parentElement.hidden;
		const buttonsIn = (root) => Array.from(root.children).flatMap((child) => (child.localName === "button" ? [child] : buttonsIn(child)));
		const pickIn = (item) => {
			const buttons = buttonsIn(item).filter(usable);
			return buttons.find((element) => element.dataset.control === focus.control) ?? buttons[0];
		};
		const same = rendered.find((item) => item.dataset.id === focus.id);
		const near = rendered[Math.min(Math.max(focus.index, 0), rendered.length - 1)];
		const target = same ? pickIn(same) : near ? pickIn(near) : null;
		(target ?? els.panelToggle).focus();
	}

	function setParts(slug, parts) {
		store.setParts({ slug, parts });
		renderParts();
	}

	/** Drops the parts of the design shown before (canvas-boards.js showDesign). */
	function clearParts() {
		setParts(state.slug, []);
	}

	async function loadParts() {
		const slug = state.slug;
		if (!slug) return;
		const load = ++partLoads;
		let data = null;
		let failure = null;
		reading += 1;
		try {
			data = await getJson(partsPath(slug));
		} catch (error) {
			failure = error;
		} finally {
			reading -= 1;
		}
		if (load !== partLoads || slug !== state.slug) return;
		// A failed read keeps the parts shown.
		if (failure) return setStatus(T.unreadable(slug, failure.message), true);
		const parts = data && Array.isArray(data.parts) ? data.parts.filter(isPart) : [];
		for (const part of parts) reported.add(removeKey(slug, part));
		setParts(slug, parts);
	}

	/** A part the server just accepted, before its parts.json change event arrives; never into another design's list. */
	function noteParts(slug, part) {
		if (slug !== state.slug || reported.has(removeKey(slug, part))) return;
		const current = state.parts.slug === slug ? state.parts.parts : [];
		if (current.some((entry) => entry.id === part.id)) return;
		partLoads += 1;
		setParts(slug, [...current, part]);
		if (reading > 0) void loadParts();
	}

	/** Show: the part's artboard in focus, its element highlighted in every frame; the board is looked up now. */
	function showPart(part) {
		const board = state.parts.slug === state.slug ? boardOf(part, state.slug) : null;
		if (!board) {
			setStatus(T.notShown, true);
			renderParts();
			return;
		}
		actions.exitCompare(false);
		actions.enterFocus(board);
		for (const surface of actions.surfacesOf(board)) surface.frame.contentWindow?.postMessage({ type: "gd:highlight", selector: part.selector }, "*");
	}

	async function removePart(slug, part) {
		const key = removeKey(slug, part);
		if (removing.has(key)) return;
		removing.add(key);
		renderParts();
		const reply = await postJson(`${partsPath(slug)}/remove`, { id: part.id }).catch(failed);
		removing.delete(key);
		if (confirming === key) confirming = null;
		const current = slug === state.slug && state.parts.slug === slug;
		if (reply.ok) {
			reported.add(key);
			setStatus(T.removed, false);
			showToast(T.removed, false);
			if (!current) return;
			partLoads += 1;
			setParts(slug, state.parts.parts.filter((entry) => entry.id !== part.id));
			if (reading > 0) await loadParts();
			return;
		}
		const code = typeof reply.body.error === "string" ? reply.body.error : "";
		const text = T.notRemoved(T.removeErrors[code] ?? (reply.body.reason || code || `HTTP ${reply.status}`));
		setStatus(text, true);
		showToast(text, true);
		if (!current) return;
		// The agent took it up meanwhile (409), or a failed delivery took it back (404): show what parts.json holds now.
		if (code === "part-not-sent" || code === "not-found") await loadParts();
		else renderParts();
	}

	/** A new language: the list (focus kept, as on any re-render), the note and Implement only this's tooltip (not its state). */
	function relabel() {
		partNote.textContent = T.partOffline;
		els.partAdd.title = delivery.part ? T.partTitle : T.partOffline;
		renderParts();
	}

	/** Implement only this on the open popover: enabled only when the page config says the server can deliver a part and that element is not in flight. */
	function renderPartButton() {
		const offline = !delivery.part;
		els.partAdd.disabled = offline || Boolean(state.pick && sending.has(sendKey(state.pick)));
		els.partAdd.title = offline ? T.partOffline : T.partTitle;
		// Worded where it is shown: the language may have been set after init (a stored choice).
		partNote.textContent = T.partOffline;
		partNote.hidden = !offline;
		if (offline) els.partAdd.setAttribute("aria-describedby", partNote.id);
		else els.partAdd.removeAttribute("aria-describedby");
	}

	function sendFailure(reply) {
		const code = typeof reply.body.error === "string" ? reply.body.error : "";
		const reason = typeof reply.body.reason === "string" ? reply.body.reason : "";
		const why = code === "delivery-failed" ? T.deliveryFailed(reason) : T.sendErrors[code] ?? (reason || code || `HTTP ${reply.status}`);
		return { text: T.notSent(why), code };
	}

	function popoverMessage(text, isError, detail = "") {
		els.message.setAttribute("data-gd-message-owner", "parts");
		els.message.textContent = text;
		els.message.title = detail;
		els.message.classList.toggle("gd-error", isError);
	}

	els.partAdd.addEventListener("click", async () => {
		const pick = state.pick;
		if (!pick || !delivery.part || els.partAdd.disabled) return;
		const key = sendKey(pick);
		if (sending.has(key)) return;
		const note = els.text.value.replace(/\r\n?/g, "\n").trim();
		if (note.length > NOTE_LIMIT) return popoverMessage(T.noteTooLong(NOTE_LIMIT), true);
		sending.add(key);
		els.partAdd.disabled = true;
		popoverMessage(T.sending, false);
		const board = pick.board;
		const slug = board.slug;
		const reply = await postJson(`api/designs/${encodeURIComponent(slug)}/implement-part`, { file: board.artboard.file, selector: pick.selector, excerpt: pick.excerpt, ...(note ? { note } : {}) }).catch(failed);
		sending.delete(key);
		const open = state.pick === pick;
		// The same element picked again while this was in flight can be sent now.
		if (!open && state.pick && sendKey(state.pick) === key) renderPartButton();
		if (!reply.ok) {
			const failure = sendFailure(reply);
			if (!open) return setStatus(failure.text, true);
			els.partAdd.disabled = !delivery.part;
			popoverMessage(failure.text, true, failure.code);
			return;
		}
		// Sent: it stays disabled until the popover closes, so a second click sends no duplicate; a new pick enables it.
		const queued = reply.body.queued === true;
		if (typeof reply.body.id === "string") {
			noteParts(slug, { id: reply.body.id, file: board.artboard.file, selector: pick.selector, excerpt: pick.excerpt, status: "sent", queued, sentAt: new Date().toISOString(), startedAt: null, implementedAt: null, ...(note ? { instruction: note } : {}) });
		}
		const done = queued ? T.queued(board.artboard.title) : T.sent(board.artboard.title);
		setStatus(done, false);
		showToast(done, false);
		if (!open) return;
		els.text.value = "";
		popoverMessage(T.sentShort, false);
		store.setPopover({ closeTimer: win.setTimeout(actions.closePopover, CLOSE_MS) });
	});

	return { relabel, loadParts, clearParts, renderParts, renderPartButton };
}
