// Handoffs (design/<slug>/handoffs.json) show live on each artboard's header: the
// handoff state, the chosen artboard and its alternatives, and, once implemented
// with a loopback previewUrl, the button that opens Compare.

// Every string the handoff row shows, in English; canvas-i18n-es.js has the Spanish. Titles, feature paths and notes stay as written.
const TEXT = Object.freeze({
	states: { queued: "Queued", sent: "Implementing…", in_progress: "In progress", implemented: "Implemented ✓" },
	chosen: "Chosen",
	alternative: "Alternative",
	feature: "Tracked in this ODD feature document",
	compare: "Compare",
	compareLabel: (title) => `Compare ${title} with the running app`,
	unreadable: (slug, reason) => `handoffs.json for ${slug} cannot be read: ${reason}`,
});

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const MAX_PREVIEW_URL = 2048;

export function init(ctx) {
	const { win, doc, store, api, ui, actions } = ctx;
	const { state } = store;
	const { getJson } = api;
	const { setStatus } = ui;
	const T = ctx.i18n.text("handoffs", TEXT);

	function ownPort() {
		const location = win.location;
		return location && typeof location.port === "string" ? location.port : "";
	}

	/**
	 * The preview URL Compare may frame: http(s) on localhost, 127.0.0.1 or [::1], no
	 * credentials, and never this canvas server's port (the server validates it too).
	 */
	function previewTarget(value) {
		if (typeof value !== "string" || value.length === 0 || value.length > MAX_PREVIEW_URL) return null;
		let url;
		try { url = new win.URL(value); } catch { return null; }
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password || !LOOPBACK_HOSTS.includes(url.hostname)) return null;
		const port = url.port || (url.protocol === "https:" ? "443" : "80");
		return port === ownPort() ? null : url.href;
	}

	function handoffOf(board) {
		const data = state.handoffs;
		if (board.system || data.slug !== board.slug) return { chosen: null, entry: null };
		const file = board.artboard.file;
		const entry = Object.prototype.hasOwnProperty.call(data.handoffs, file) ? data.handoffs[file] : null;
		return { chosen: data.chosen, entry: entry && typeof entry === "object" ? entry : null };
	}

	function handoffKind(entry) {
		if (entry.status === "sent") return entry.queued === true ? "queued" : "sent";
		return entry.status === "in_progress" || entry.status === "implemented" ? entry.status : null;
	}

	function chip(className, text) {
		const element = doc.createElement("span");
		element.className = className;
		element.textContent = text;
		return element;
	}

	/** The header row of one artboard: Chosen or Alternative, the handoff badge, its feature document, note and Compare. */
	function renderHandoff(board) {
		if (board.system || !board.handoff) return;
		const { chosen, entry } = handoffOf(board);
		const isChosen = typeof chosen === "string" && chosen === board.artboard.file;
		board.wrapper.classList.toggle("gd-chosen", isChosen);
		const parts = [];
		if (typeof chosen === "string") parts.push(chip(`gd-choice ${isChosen ? "gd-choice-chosen" : "gd-choice-alternative"}`, isChosen ? T.chosen : T.alternative));
		const kind = entry ? handoffKind(entry) : null;
		let compare = null;
		if (kind) {
			const badge = chip("gd-handoff-badge", T.states[kind]);
			badge.dataset.status = kind;
			parts.push(badge);
			if (typeof entry.feature === "string" && entry.feature) {
				const feature = chip("gd-handoff-feature", entry.feature);
				feature.title = T.feature;
				parts.push(feature);
			}
			if (typeof entry.note === "string" && entry.note) {
				const note = chip("gd-handoff-note", entry.note);
				note.title = entry.note;
				parts.push(note);
			}
			const preview = kind === "implemented" ? previewTarget(entry.previewUrl) : null;
			if (preview) {
				compare = doc.createElement("button");
				compare.type = "button";
				compare.className = "gd-compare-start";
				compare.textContent = T.compare;
				compare.setAttribute("aria-label", T.compareLabel(board.artboard.title));
				compare.addEventListener("click", () => actions.enterCompare(board, preview));
				parts.push(compare);
			}
		}
		const hadFocus = board.handoff.contains(doc.activeElement);
		board.handoff.replaceChildren(...parts);
		board.handoff.hidden = parts.length === 0;
		board.wrapper.classList.toggle("gd-has-handoff", parts.length > 0);
		if (hadFocus && compare) compare.focus();
	}

	function renderHandoffs(options) {
		state.boards.forEach(renderHandoff);
		// The handoff row changes the labels' height: the arrangement and the minimap (its chosen block too) follow.
		actions.boardsResized(options);
	}

	/** A new language: the same rows, in place, without closing the token panel (boot places the artboard again). */
	function relabel() {
		renderHandoffs({ keepInspector: true });
	}

	function setHandoffs(slug, data) {
		const valid = Boolean(data && typeof data === "object" && data.handoffs && typeof data.handoffs === "object" && !Array.isArray(data.handoffs));
		store.setHandoffs({ slug, chosen: valid && typeof data.chosen === "string" ? data.chosen : null, handoffs: valid ? data.handoffs : {} });
		renderHandoffs();
	}

	async function loadHandoffs() {
		const slug = state.slug;
		if (!slug) return;
		let data = null;
		try {
			data = await getJson(`api/designs/${encodeURIComponent(slug)}/handoffs`);
		} catch (error) {
			setStatus(T.unreadable(slug, error.message), true);
		}
		if (slug === state.slug) setHandoffs(slug, data);
	}

	/** Shows a handoff the server just accepted, before its handoffs.json change event arrives. */
	function noteHandoff(slug, file, queued) {
		const current = state.handoffs.slug === slug ? state.handoffs.handoffs : {};
		const feature = state.manifest && state.manifest.slug === slug && typeof state.manifest.feature === "string" ? state.manifest.feature : undefined;
		const entry = { status: "sent", queued, sentAt: new Date().toISOString(), startedAt: null, implementedAt: null };
		if (feature) entry.feature = feature;
		const handoffs = Object.assign({}, current);
		handoffs[file] = entry;
		store.setHandoffs({ slug, chosen: file, handoffs });
		renderHandoffs();
	}

	// A new language rewrites each artboard's handoff row (its chips only; no frame reloads).
	return { relabel, renderHandoff, loadHandoffs, noteHandoff };
}
