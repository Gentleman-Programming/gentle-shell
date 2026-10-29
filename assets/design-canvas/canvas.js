// Gentle Design canvas: artboards side by side with pan, zoom, live reload,
// and comments persisted in design/<slug>/comments.json (pins, list, send modes).
// design/system.html, when present, is the first board of every design; it is
// kept out of state.boards so comments never apply to it.
// Artboards run in iframes sandboxed with scripts only, so each one has an opaque
// origin; messages are trusted only by matching event.source to a known artboard.
// Navigation mode (the default) covers every artboard with a shield, so the wheel,
// drags and clicks always reach the canvas; a click on a shield enters focus mode,
// which shows that artboard at 100% and lets it own the pointer and the keyboard
// until "Back to canvas" or Shift+Esc restores the previous view.
// Handoffs (design/<slug>/handoffs.json) show live on each artboard's header: the
// handoff state, the chosen artboard and its alternatives, and, once implemented
// with a loopback previewUrl, a Compare view of the artboard next to the running app.
(() => {
	"use strict";

	const config = JSON.parse(document.getElementById("gd-config").textContent);
	const base = String(config.base);
	const MIN_ZOOM = 0.05;
	const MAX_ZOOM = 4;
	const FIT_PADDING = 48;
	const FOCUS_MARGIN = 16;
	// Room below a focused artboard for the floating "Back to canvas" button.
	const BACK_SPACE = 64;
	const CLICK_SLOP = 4;
	const LIMITS = { selector: 500, excerpt: 300, comment: 2000, pins: 500, screenshotBytes: 5 * 1024 * 1024 };
	const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
	const MODE_KEY = "gentle-design:send-mode";
	const SYSTEM_LABEL = { title: "Design system", tradeoff: "Project tokens (design/system.md)" };
	const SYSTEM_NOTE = "Comments apply to design artboards only. To change the system, update the project's design sources and run /gentle:design sync.";
	const HANDOFF_LABELS = { queued: "Queued", sent: "Implementing…", in_progress: "In progress", implemented: "Implemented ✓" };
	const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
	const MAX_PREVIEW_URL = 2048;
	// The running app is another loopback origin (previewTarget refuses this server's own
	// port), so the same-origin flag below gives the app its own origin, never the canvas's: it cannot
	// reach this page, its token or its API, and its scripts, storage and forms work as in
	// production. No top-navigation flag is granted, so it can never navigate the canvas away.
	const PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";
	const PREVIEW_TIMEOUT_MS = 6000;
	const PREVIEW_HINT = "If the app refuses to be framed, use Open in new tab.";
	// CSP host sources have no IPv6 literal form, so Chromium drops the [::1] source from frame-src.
	const IPV6_HINT = "Browsers do not frame [::1] under the canvas policy (CSP has no IPv6 sources): use Open in new tab, or report the preview on localhost.";
	const COMPARE_GAP = 24;
	const COMPARE_PADDING = 24;
	const TOAST_MS = 5000;

	const $ = (id) => document.getElementById(id);
	const els = {
		title: $("gd-title"),
		design: $("gd-design"),
		designField: $("gd-design-field"),
		feature: $("gd-feature"),
		zoomOut: $("gd-zoom-out"),
		zoomIn: $("gd-zoom-in"),
		zoomLevel: $("gd-zoom-level"),
		fit: $("gd-fit"),
		navMode: $("gd-nav-mode"),
		back: $("gd-back"),
		comment: $("gd-comment"),
		status: $("gd-status"),
		viewport: $("gd-viewport"),
		world: $("gd-world"),
		empty: $("gd-empty"),
		popover: $("gd-popover"),
		form: $("gd-popover-form"),
		target: $("gd-popover-target"),
		text: $("gd-popover-text"),
		message: $("gd-popover-message"),
		cancel: $("gd-popover-cancel"),
		send: $("gd-popover-send"),
		shotInput: $("gd-shot-input"),
		shotAttach: $("gd-shot-attach"),
		shotPreview: $("gd-shot-preview"),
		shotImage: $("gd-shot-image"),
		shotRemove: $("gd-shot-remove"),
		modeSend: $("gd-mode-send"),
		modeCollect: $("gd-mode-collect"),
		sendAll: $("gd-send-all"),
		panelToggle: $("gd-panel-toggle"),
		panel: $("gd-panel"),
		filterOpen: $("gd-filter-open"),
		filterResolved: $("gd-filter-resolved"),
		panelEmpty: $("gd-panel-empty"),
		list: $("gd-comment-list"),
		toast: $("gd-toast"),
		compare: $("gd-compare"),
		compareTitle: $("gd-compare-title"),
		compareFit: $("gd-compare-fit"),
		compareFitField: $("gd-compare-fit-field"),
		compareOpen: $("gd-compare-open"),
		compareBack: $("gd-compare-back"),
		compareMessage: $("gd-compare-message"),
		compareStage: $("gd-compare-stage"),
		compareSizer: $("gd-compare-sizer"),
		comparePanes: $("gd-compare-panes"),
	};

	function storedMode() {
		try {
			return localStorage.getItem(MODE_KEY) === "collect" ? "collect" : "send";
		} catch {
			return "send";
		}
	}

	const state = {
		slug: typeof config.slug === "string" ? config.slug : null,
		manifest: null,
		boards: [],
		system: null,
		systemBoard: null,
		zoom: 1,
		x: FIT_PADDING,
		y: FIT_PADDING,
		commenting: false,
		pick: null,
		// The one screenshot of the open popover: { mimeType, data: base64 }, or null.
		shot: null,
		shotToken: 0,
		closeTimer: 0,
		comments: [],
		filter: "open",
		mode: storedMode(),
		activeId: null,
		designCount: 0,
		// The focused board, and the view to restore when focus mode ends.
		focus: null,
		savedView: null,
		savedPanel: null,
		hoverBoard: null,
		// The handoffs.json of design `slug`; boards of another design ignore it.
		handoffs: { slug: null, chosen: null, handoffs: {} },
		// The open Compare view: { board, preview, artboardFrame, timer }.
		compare: null,
		toastTimer: 0,
	};

	function setStatus(text, isError) {
		els.status.textContent = text;
		els.status.classList.toggle("gd-error", Boolean(isError));
	}

	/** A confirmation that stays on screen for a few seconds, beyond the status line. */
	function showToast(text, isError) {
		clearTimeout(state.toastTimer);
		els.toast.textContent = text;
		els.toast.classList.toggle("gd-error", Boolean(isError));
		els.toast.hidden = false;
		state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, TOAST_MS);
	}

	function fileUrl(slug, file) {
		return `${base}files/${encodeURIComponent(slug)}/${file.split("/").map(encodeURIComponent).join("/")}`;
	}

	async function getJson(path) {
		const response = await fetch(base + path, { headers: { Accept: "application/json" }, cache: "no-store" });
		let body = null;
		try { body = await response.json(); } catch { body = null; }
		if (!response.ok) {
			const reason = body && (body.reason || body.error);
			throw new Error(reason ? String(reason) : `HTTP ${response.status}`);
		}
		return body;
	}

	// ---- view transform -------------------------------------------------

	function clampZoom(value) {
		return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
	}

	function applyView() {
		els.world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
		els.world.style.setProperty("--gd-inv-zoom", String(1 / state.zoom));
		els.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
	}

	/** Zoom so the world point under (px, py) in viewport coordinates stays put. */
	function zoomAt(nextZoom, px, py) {
		const zoom = clampZoom(nextZoom);
		state.x = px - (px - state.x) * (zoom / state.zoom);
		state.y = py - (py - state.y) * (zoom / state.zoom);
		state.zoom = zoom;
		applyView();
		closePopover();
	}

	function zoomAtCenter(factor) {
		const rect = els.viewport.getBoundingClientRect();
		zoomAt(state.zoom * factor, rect.width / 2, rect.height / 2);
	}

	function panBy(dx, dy) {
		state.x += dx;
		state.y += dy;
		applyView();
		closePopover();
	}

	function fit() {
		if (state.focus) return;
		const rect = els.viewport.getBoundingClientRect();
		const width = els.world.offsetWidth;
		const height = els.world.offsetHeight;
		if (!width || !height) return;
		const zoom = clampZoom(Math.min((rect.width - FIT_PADDING * 2) / width, (rect.height - FIT_PADDING * 2) / height, 1));
		state.zoom = zoom;
		state.x = (rect.width - width * zoom) / 2;
		state.y = Math.max(FIT_PADDING, (rect.height - height * zoom) / 2);
		applyView();
		closePopover();
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

	// A press on a shield pans like the background; released without moving, it is a
	// click on that artboard: a routed pick in comment mode, else focus mode.
	let drag = null;
	els.viewport.addEventListener("pointerdown", (event) => {
		if (state.focus || event.button !== 0 || event.target.closest("button")) return;
		const shield = event.target.closest(".gd-shield");
		if (!shield && event.target !== els.viewport && event.target !== els.world && !event.target.closest(".gd-artboard-label")) return;
		drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, board: shield ? boardOfShield(shield) : null };
		els.viewport.setPointerCapture(event.pointerId);
		els.viewport.classList.add("gd-panning");
	});
	els.viewport.addEventListener("pointermove", (event) => {
		if (!drag || drag.id !== event.pointerId) {
			if (!drag) hoverAt(event);
			return;
		}
		panBy(event.clientX - drag.x, event.clientY - drag.y);
		drag.x = event.clientX;
		drag.y = event.clientY;
		if (Math.abs(event.clientX - drag.startX) > CLICK_SLOP || Math.abs(event.clientY - drag.startY) > CLICK_SLOP) drag.moved = true;
	});
	const endDrag = (event) => {
		if (!drag || drag.id !== event.pointerId) return;
		const ended = drag;
		drag = null;
		els.viewport.classList.remove("gd-panning");
		if (event.type === "pointerup" && ended.board && !ended.moved) activateBoard(ended.board, event.clientX, event.clientY);
	};
	els.viewport.addEventListener("pointerup", endDrag);
	els.viewport.addEventListener("pointercancel", endDrag);
	els.viewport.addEventListener("pointerleave", () => setHoverBoard(null));

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

	// ---- navigation and focus modes ---------------------------------------

	function allBoards() {
		return state.systemBoard ? [state.systemBoard, ...state.boards] : state.boards;
	}

	function boardOfShield(shield) {
		return allBoards().find((board) => board.shield === shield) ?? null;
	}

	/** A viewport point in the artboard's own CSS pixels. */
	function framePoint(board, clientX, clientY) {
		const rect = board.frame.getBoundingClientRect();
		const scale = rect.width / board.artboard.width || 1;
		return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
	}

	function activateBoard(board, clientX, clientY) {
		if (!state.commenting) enterFocus(board);
		else if (!board.system) board.frame.contentWindow?.postMessage({ type: "gd:pick-at", ...framePoint(board, clientX, clientY) }, "*");
	}

	function setHoverBoard(board) {
		if (state.hoverBoard && state.hoverBoard !== board) state.hoverBoard.frame.contentWindow?.postMessage({ type: "gd:hover-at", x: null, y: null }, "*");
		state.hoverBoard = board;
	}

	/** Comment mode in navigation: the shield routes the hover to the inspector so it can outline the element. */
	function hoverAt(event) {
		if (!state.commenting || state.focus) return setHoverBoard(null);
		const shield = event.target.closest(".gd-shield");
		const board = shield ? boardOfShield(shield) : null;
		setHoverBoard(board && !board.system ? board : null);
		if (state.hoverBoard) state.hoverBoard.frame.contentWindow?.postMessage({ type: "gd:hover-at", ...framePoint(board, event.clientX, event.clientY) }, "*");
	}

	function sendFocus(board) {
		board.frame.contentWindow?.postMessage({ type: "gd:focus", enabled: board === state.focus }, "*");
	}

	/** The artboard's visible height: its manifest height, or the viewport's while focused on a taller one. */
	function setFrameHeight(board, height) {
		board.viewHeight = height;
		board.frame.style.height = `${height}px`;
	}

	/**
	 * 100% zoom with the focused artboard centered and its label (Implement this) in view.
	 * A taller artboard is top-aligned and its frame is clipped to the viewport, so it
	 * scrolls inside like a browser window instead of leaving its bottom out of reach
	 * while the canvas cannot pan.
	 */
	function centerFocus() {
		const board = state.focus;
		if (!board) return;
		const viewport = els.viewport.getBoundingClientRect();
		// Layout offsets inside the world ignore its transform, so re-centering is idempotent
		// (a scaled bounding rect carries sub-pixel error that shifted the board by 1 px).
		const box = board.frame.parentElement;
		const left = box.offsetLeft;
		const top = box.offsetTop;
		const labelSpace = box.offsetTop - board.wrapper.offsetTop;
		const { width, height } = board.artboard;
		const minTop = FOCUS_MARGIN + labelSpace;
		const available = viewport.height - minTop - BACK_SPACE;
		const tall = height > available;
		setFrameHeight(board, tall ? Math.max(120, Math.floor(available)) : height);
		state.zoom = 1;
		state.x = Math.round(width + FOCUS_MARGIN * 2 <= viewport.width ? (viewport.width - width) / 2 - left : FOCUS_MARGIN - left);
		state.y = Math.round((tall ? minTop : Math.max(minTop, (viewport.height - height) / 2)) - top);
		applyView();
	}

	/** Shields, dimming, inert boards, toolbar controls and the mode label follow state.focus. */
	function applyFocusState() {
		const focused = state.focus;
		els.viewport.classList.toggle("gd-focused", Boolean(focused));
		for (const board of allBoards()) {
			const active = board === focused;
			board.wrapper.classList.toggle("gd-focus-board", active);
			board.wrapper.inert = Boolean(focused) && !active;
			board.shield.hidden = active;
			if (!active && board.viewHeight !== board.artboard.height) setFrameHeight(board, board.artboard.height);
			sendFocus(board);
		}
		for (const control of [els.zoomOut, els.zoomIn, els.fit]) control.disabled = Boolean(focused);
		els.design.disabled = Boolean(focused) || state.designCount === 0;
		els.back.hidden = !focused;
		els.navMode.textContent = focused ? `Using: ${focused.artboard.title} · Shift+Esc to exit` : "Navigating";
		els.navMode.classList.toggle("gd-using", Boolean(focused));
	}

	function enterFocus(board) {
		if (state.focus === board) return;
		if (!state.focus) {
			state.savedView = { zoom: state.zoom, x: state.x, y: state.y };
			// The artboard keeps its designed width at 100%; hiding the panel gains room for it.
			state.savedPanel = !els.panel.hidden;
			setPanel(false);
		}
		closePopover();
		setHoverBoard(null);
		state.focus = board;
		centerFocus();
		applyFocusState();
		board.frame.focus();
	}

	function exitFocus() {
		if (!state.focus) return;
		closePopover();
		state.focus = null;
		if (state.savedPanel !== null) setPanel(state.savedPanel);
		state.savedPanel = null;
		if (state.savedView) Object.assign(state, state.savedView);
		state.savedView = null;
		applyView();
		applyFocusState();
		els.viewport.focus();
	}

	els.back.addEventListener("click", exitFocus);

	// ---- designs and artboards -------------------------------------------

	function showEmpty(text) {
		exitFocus();
		els.world.replaceChildren();
		state.boards = [];
		els.empty.textContent = text;
		els.empty.hidden = false;
	}

	function renderDesignOptions(designs) {
		const options = designs.map((design) => {
			const option = document.createElement("option");
			option.value = design.slug;
			option.textContent = design.valid ? design.title : `${design.slug} (invalid design.json)`;
			return option;
		});
		els.design.replaceChildren(...options);
		state.designCount = designs.length;
		els.design.disabled = designs.length === 0 || Boolean(state.focus);
		els.designField.hidden = designs.length === 0;
		if (state.slug) els.design.value = state.slug;
	}

	/** pickLatest: with no design selected, select the most recent one (not for the system-only view). */
	async function refreshDesigns(pickLatest = true) {
		const { designs } = await getJson("api/designs");
		if (pickLatest && !state.slug && designs.length > 0) state.slug = designs[0].slug;
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
		const wrapper = document.createElement("section");
		wrapper.className = system ? "gd-artboard gd-system-board" : "gd-artboard";
		wrapper.setAttribute("aria-label", artboard.title);
		const label = document.createElement("div");
		label.className = "gd-artboard-label";
		const title = document.createElement("h2");
		title.className = "gd-artboard-title";
		title.textContent = artboard.title;
		label.append(title);
		if (artboard.tradeoff) {
			const tradeoff = document.createElement("p");
			tradeoff.className = "gd-artboard-tradeoff";
			tradeoff.textContent = artboard.tradeoff;
			label.append(tradeoff);
		}
		// The handoff state, the chosen badge and Compare (rendered by renderHandoff) stack above
		// Implement this, at screen size, so neither covers the other at any zoom.
		const handoff = document.createElement("div");
		handoff.className = "gd-handoff";
		handoff.hidden = true;
		if (!system) {
			const actions = document.createElement("div");
			actions.className = "gd-board-actions";
			actions.append(handoff, createImplementControl(slug, artboard));
			label.append(actions);
		}
		if (system) {
			label.title = SYSTEM_NOTE;
			const note = document.createElement("p");
			note.className = "gd-system-note";
			note.title = SYSTEM_NOTE;
			note.textContent = "Comments off on this board";
			label.append(note);
		}
		const frame = document.createElement("iframe");
		frame.className = "gd-artboard-frame";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.title = `${artboard.title} artboard`;
		frame.style.width = `${artboard.width}px`;
		const box = document.createElement("div");
		box.className = "gd-frame-box";
		const shield = document.createElement("div");
		shield.className = "gd-shield";
		shield.setAttribute("role", "button");
		shield.tabIndex = 0;
		shield.setAttribute("aria-label", system ? `View ${artboard.title} (read-only)` : `Use ${artboard.title}`);
		const hint = document.createElement("span");
		hint.className = "gd-shield-hint";
		hint.setAttribute("aria-hidden", "true");
		hint.textContent = system ? "Click to view the design system" : "Click to use this design";
		shield.append(hint);
		const pins = document.createElement("div");
		pins.className = "gd-pins";
		// rects: null until the artboard reports where each commented element is.
		const board = { slug, artboard, frame, wrapper, shield, pins, handoff, rects: null, system, viewHeight: 0 };
		setFrameHeight(board, artboard.height);
		renderHandoff(board);
		shield.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			enterFocus(board);
		});
		frame.addEventListener("load", () => {
			board.rects = null;
			sendMode(board);
			sendFocus(board);
			if (!system) sendPins(board);
			// A live reload of the focused artboard keeps focus mode and its keyboard focus.
			if (state.focus === board && els.popover.hidden && (document.activeElement === frame || document.activeElement === document.body)) frame.focus();
		});
		frame.src = boardUrl(board);
		box.append(frame, shield, pins);
		wrapper.append(label, box);
		return board;
	}

	/** "Implement this" with an inline confirm step; the system board never gets one. */
	function createImplementControl(slug, artboard) {
		const box = document.createElement("div");
		box.className = "gd-implement";
		const start = document.createElement("button");
		start.type = "button";
		start.className = "gd-implement-start";
		start.textContent = "Implement this";
		start.setAttribute("aria-label", `Implement ${artboard.title} in the project`);
		const confirm = document.createElement("div");
		confirm.className = "gd-implement-confirm";
		confirm.setAttribute("role", "group");
		confirm.setAttribute("aria-label", `Confirm implementing ${artboard.title}`);
		confirm.hidden = true;
		const question = document.createElement("span");
		question.textContent = "Send it to the session to implement?";
		const yes = document.createElement("button");
		yes.type = "button";
		yes.className = "gd-primary";
		yes.textContent = "Send";
		const no = document.createElement("button");
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
				noteHandoff(slug, artboard.file, queued);
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

	// ---- handoffs ------------------------------------------------------------

	function ownPort() {
		const location = window.location;
		return location && typeof location.port === "string" ? location.port : "";
	}

	/**
	 * The preview URL Compare may frame: http(s) on localhost, 127.0.0.1 or [::1], no
	 * credentials, and never this canvas server's port (the server validates it too).
	 */
	function previewTarget(value) {
		if (typeof value !== "string" || value.length === 0 || value.length > MAX_PREVIEW_URL) return null;
		let url;
		try { url = new URL(value); } catch { return null; }
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
		const element = document.createElement("span");
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
		if (typeof chosen === "string") parts.push(chip(`gd-choice ${isChosen ? "gd-choice-chosen" : "gd-choice-alternative"}`, isChosen ? "Chosen" : "Alternative"));
		const kind = entry ? handoffKind(entry) : null;
		let compare = null;
		if (kind) {
			const badge = chip("gd-handoff-badge", HANDOFF_LABELS[kind]);
			badge.dataset.status = kind;
			parts.push(badge);
			if (typeof entry.feature === "string" && entry.feature) {
				const feature = chip("gd-handoff-feature", entry.feature);
				feature.title = "Tracked in this ODD feature document";
				parts.push(feature);
			}
			if (typeof entry.note === "string" && entry.note) {
				const note = chip("gd-handoff-note", entry.note);
				note.title = entry.note;
				parts.push(note);
			}
			const preview = kind === "implemented" ? previewTarget(entry.previewUrl) : null;
			if (preview) {
				compare = document.createElement("button");
				compare.type = "button";
				compare.className = "gd-compare-start";
				compare.textContent = "Compare";
				compare.setAttribute("aria-label", `Compare ${board.artboard.title} with the running app`);
				compare.addEventListener("click", () => enterCompare(board, preview));
				parts.push(compare);
			}
		}
		const hadFocus = board.handoff.contains(document.activeElement);
		board.handoff.replaceChildren(...parts);
		board.handoff.hidden = parts.length === 0;
		board.wrapper.classList.toggle("gd-has-handoff", parts.length > 0);
		if (hadFocus && compare) compare.focus();
	}

	function renderHandoffs() {
		state.boards.forEach(renderHandoff);
	}

	function setHandoffs(slug, data) {
		const valid = Boolean(data && typeof data === "object" && data.handoffs && typeof data.handoffs === "object" && !Array.isArray(data.handoffs));
		state.handoffs = { slug, chosen: valid && typeof data.chosen === "string" ? data.chosen : null, handoffs: valid ? data.handoffs : {} };
		renderHandoffs();
	}

	async function loadHandoffs() {
		const slug = state.slug;
		if (!slug) return;
		let data = null;
		try {
			data = await getJson(`api/designs/${encodeURIComponent(slug)}/handoffs`);
		} catch (error) {
			setStatus(`handoffs.json for ${slug} cannot be read: ${error.message}`, true);
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
		state.handoffs = { slug, chosen: file, handoffs };
		renderHandoffs();
	}

	// ---- compare -------------------------------------------------------------

	function comparePane(caption, frame) {
		const figure = document.createElement("figure");
		figure.className = "gd-compare-pane";
		const label = document.createElement("figcaption");
		label.className = "gd-compare-caption";
		label.textContent = caption;
		figure.append(label, frame);
		return figure;
	}

	function compareFrame(width, height, title) {
		const frame = document.createElement("iframe");
		frame.className = "gd-compare-frame";
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.title = title;
		frame.style.width = `${width}px`;
		frame.style.height = `${height}px`;
		return frame;
	}

	function setCompareMessage(text, isError) {
		els.compareMessage.textContent = text;
		els.compareMessage.classList.toggle("gd-error", Boolean(isError));
	}

	/** 100% by default; past the window width, "Scale to fit" shrinks the pair to fit. */
	function layoutCompare() {
		const compare = state.compare;
		if (!compare) return;
		const { width } = compare.board.artboard;
		const needed = width * 2 + COMPARE_GAP;
		const available = els.compareStage.getBoundingClientRect().width - COMPARE_PADDING * 2;
		const wide = needed > available;
		els.compareFitField.hidden = !wide;
		const scale = wide && els.compareFit.checked ? Math.max(0.05, available / needed) : 1;
		els.comparePanes.style.transform = scale === 1 ? "none" : `scale(${scale.toFixed(3)})`;
		// The sizer keeps the scroll area at the scaled size.
		els.compareSizer.style.width = scale === 1 ? "" : `${Math.ceil(needed * scale)}px`;
		els.compareSizer.style.height = scale === 1 ? "" : `${Math.ceil(els.comparePanes.offsetHeight * scale)}px`;
	}

	/** The artboard (sandboxed as on the canvas) next to the running app, both at the artboard's size. */
	function enterCompare(board, preview) {
		exitCompare(false);
		exitFocus();
		closePopover();
		setHoverBoard(null);
		const { width, height, title } = board.artboard;
		const artboardFrame = compareFrame(width, height, `${title} artboard`);
		artboardFrame.setAttribute("sandbox", "allow-scripts");
		// Like focus mode: the artboard owns its scroll, and Shift+Esc inside it asks to leave.
		artboardFrame.addEventListener("load", () => artboardFrame.contentWindow?.postMessage({ type: "gd:focus", enabled: true }, "*"));
		artboardFrame.src = boardUrl(board);
		const app = compareFrame(width, height, `Running app at ${preview}`);
		app.setAttribute("sandbox", PREVIEW_SANDBOX);
		const compare = { board, preview, artboardFrame, timer: 0, loaded: false };
		const failed = (text) => {
			if (state.compare === compare) setCompareMessage(text, true);
		};
		// A frame refused by X-Frame-Options or frame-ancestors may still fire load, so the
		// Open in new tab fallback is always shown; a missing load also says so.
		app.addEventListener("load", () => { compare.loaded = true; });
		app.addEventListener("error", () => failed(`The app at ${preview} could not be loaded in the frame. Use Open in new tab.`));
		compare.timer = setTimeout(() => {
			if (!compare.loaded) failed(`The app at ${preview} has not loaded; it may be down or refuse to be framed. Use Open in new tab.`);
		}, PREVIEW_TIMEOUT_MS);
		app.src = preview;
		state.compare = compare;
		els.compareTitle.textContent = `Compare: ${title}`;
		// A new tab with no opener and no Referer: the canvas URL carries the server token.
		els.compareOpen.setAttribute("target", "_blank");
		els.compareOpen.setAttribute("rel", "noopener noreferrer");
		els.compareOpen.href = preview;
		setCompareMessage(new URL(preview).hostname === "[::1]" ? IPV6_HINT : PREVIEW_HINT, false);
		els.comparePanes.replaceChildren(comparePane(`Design: ${board.artboard.file}`, artboardFrame), comparePane(`Implementation: ${preview}`, app));
		els.compareFit.checked = false;
		els.compare.hidden = false;
		els.viewport.inert = true;
		els.panel.inert = true;
		for (const control of [els.zoomOut, els.zoomIn, els.fit, els.design]) control.disabled = true;
		layoutCompare();
		els.compareBack.focus();
	}

	function exitCompare(restoreFocus) {
		const compare = state.compare;
		if (!compare) return;
		clearTimeout(compare.timer);
		state.compare = null;
		els.comparePanes.replaceChildren();
		els.compareOpen.removeAttribute("href");
		els.compare.hidden = true;
		els.viewport.inert = false;
		els.panel.inert = false;
		applyFocusState();
		if (!restoreFocus) return;
		const board = state.boards.find((candidate) => candidate.artboard.file === compare.board.artboard.file);
		const button = board ? Array.from(board.handoff.children).find((child) => child.classList.contains("gd-compare-start")) : null;
		(button ?? els.viewport).focus();
	}

	els.compareBack.addEventListener("click", () => exitCompare(true));
	els.compareFit.addEventListener("change", layoutCompare);

	function showFeature(manifest) {
		const feature = manifest && typeof manifest.feature === "string" ? manifest.feature : "";
		els.feature.textContent = feature ? `Feature: ${feature}` : "";
		els.feature.hidden = !feature;
	}

	/** No design selected: only the system board, or the empty notice. */
	function showSystemOnly() {
		state.manifest = null;
		state.boards = [];
		showFeature(null);
		els.title.textContent = "Gentle Design";
		if (!state.systemBoard) {
			showEmpty("No designs yet. Run /gentle:design with a brief to create one.");
			return;
		}
		els.empty.hidden = true;
		placeBoards();
		setStatus("", false);
		requestAnimationFrame(fit);
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
		closePopover();
		state.manifest = manifest;
		showFeature(manifest);
		els.title.textContent = manifest.title;
		document.title = `${manifest.title} · Gentle Design`;
		history.replaceState(null, "", `${base}d/${encodeURIComponent(slug)}/`);
		if (manifest.artboards.length === 0 && !state.systemBoard) {
			showEmpty("This design has no artboards yet.");
			return;
		}
		els.empty.hidden = true;
		const focusFile = state.focus && !state.focus.system ? state.focus.artboard.file : null;
		state.boards = manifest.artboards.map((artboard) => createBoard(slug, artboard));
		// A manifest reload keeps focus mode on the same artboard file while it still exists.
		if (focusFile) state.focus = state.boards.find((board) => board.artboard.file === focusFile) ?? state.focus;
		placeBoards();
		if (state.focus) requestAnimationFrame(centerFocus);
		const warnings = Array.isArray(manifest.warnings) ? manifest.warnings.filter((warning) => typeof warning === "string") : [];
		setStatus(warnings.length > 0 ? `design.json: ${warnings.join("; ")}` : state.boards.length === 0 ? "This design has no artboards yet." : "", warnings.length > 0);
		if (!keepView) requestAnimationFrame(fit);
		await loadHandoffs();
		await loadComments();
	}

	function reloadBoard(board) {
		board.rects = null;
		board.frame.src = `${boardUrl(board)}?v=${Date.now()}`;
	}

	/** The system board first, then the design's artboards. */
	function placeBoards() {
		const boards = allBoards();
		els.world.replaceChildren(...boards.map((board) => board.wrapper));
		if (state.focus && !boards.includes(state.focus)) exitFocus();
		else applyFocusState();
	}

	/** Reads api/system and creates or drops the system board; true when it appeared or went away. */
	async function refreshSystem() {
		let info = null;
		try { info = await getJson("api/system"); } catch { info = null; }
		const exists = Boolean(info && info.exists === true && isFiniteNumber(info.width) && isFiniteNumber(info.height));
		state.system = exists ? info : null;
		if (exists === Boolean(state.systemBoard)) return false;
		state.systemBoard = exists ? createBoard(null, { file: String(info.file), ...SYSTEM_LABEL, width: info.width, height: info.height }, true) : null;
		return true;
	}

	async function onSystemChange() {
		if (!(await refreshSystem())) {
			if (state.systemBoard) reloadBoard(state.systemBoard);
			return;
		}
		if (state.focus && !allBoards().includes(state.focus)) exitFocus();
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
		exitCompare(false);
		state.slug = els.design.value;
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
			exitCompare(false);
			exitFocus();
			state.slug = slug;
			state.comments = [];
			state.activeId = null;
			renderComments();
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
			history.replaceState(null, "", base);
			document.title = "Gentle Design";
			if (!same || !state.systemBoard) showSystemOnly();
			return;
		}
		await loadManifest(slug, same);
	}

	async function start() {
		applyView();
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

	// ---- live reload -------------------------------------------------------

	function connectEvents() {
		const source = new EventSource(`${base}events`);
		source.addEventListener("open", () => {
			if (els.status.classList.contains("gd-error")) setStatus("", false);
		});
		source.addEventListener("error", () => setStatus("Live reload disconnected, retrying…", true));
		source.addEventListener("show", (event) => {
			let request;
			try { request = JSON.parse(event.data); } catch { return; }
			if (!request || typeof request !== "object") return;
			if (request.slug !== null && !(typeof request.slug === "string" && /^[a-z0-9][a-z0-9-]*$/.test(request.slug))) return;
			showDesign(request.slug).catch(() => {});
		});
		source.addEventListener("change", (event) => {
			let change;
			try { change = JSON.parse(event.data); } catch { return; }
			if (!change || typeof change.file !== "string") return;
			if (change.slug === null) {
				if (change.file === "system.html") onSystemChange().catch(() => {});
				return;
			}
			if (typeof change.slug !== "string") return;
			if (change.file === "design.json") {
				refreshDesigns().then(() => {
					if (change.slug === state.slug) return loadManifest(state.slug, true);
					if (!state.manifest && state.slug) return loadManifest(state.slug, false);
					return undefined;
				}).catch(() => {});
				return;
			}
			if (change.slug !== state.slug) return;
			if (change.file === "comments.json") {
				loadComments();
				return;
			}
			if (change.file === "handoffs.json") {
				loadHandoffs();
				return;
			}
			if (state.compare && state.compare.board.artboard.file === change.file) state.compare.artboardFrame.src = `${boardUrl(state.compare.board)}?v=${Date.now()}`;
			const matching = state.boards.filter((board) => board.artboard.file === change.file);
			// A shared asset (CSS, image, font) can affect every artboard of the design.
			const targets = matching.length > 0 ? matching : change.file.endsWith(".html") ? [] : state.boards;
			targets.forEach(reloadBoard);
		});
	}

	// ---- comments ----------------------------------------------------------

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
			const pin = document.createElement("button");
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
		const focused = board.pins.contains(document.activeElement) ? document.activeElement.dataset.id : null;
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
			const item = document.createElement("li");
			item.className = "gd-comment-item";
			item.dataset.id = comment.id;
			item.classList.toggle("gd-active", comment.id === state.activeId);
			const show = document.createElement("button");
			show.type = "button";
			show.className = "gd-comment-show";
			show.setAttribute("aria-label", `Show comment ${commentNumber(comment)} on ${comment.file}`);
			const meta = document.createElement("span");
			meta.className = "gd-comment-meta";
			const number = document.createElement("span");
			number.className = "gd-comment-number";
			number.textContent = `#${commentNumber(comment)}`;
			const file = document.createElement("span");
			file.textContent = comment.file;
			meta.append(number, file);
			const badge = (text, kind) => {
				const element = document.createElement("span");
				element.className = `gd-badge gd-badge-${kind}`;
				element.textContent = text;
				meta.append(element);
			};
			badge(comment.sentAt ? "Sent" : "Not sent", comment.sentAt ? "sent" : "unsent");
			if (isDetached(comment)) badge("Detached", "detached");
			const text = document.createElement("span");
			text.className = "gd-comment-text";
			text.style.display = "block";
			text.textContent = comment.comment;
			show.append(meta, text);
			if (comment.screenshot) {
				const shot = document.createElement("img");
				shot.className = "gd-comment-shot";
				shot.alt = `Screenshot of comment ${commentNumber(comment)}`;
				shot.loading = "lazy";
				shot.src = `${base}api/designs/${encodeURIComponent(state.slug)}/comments/${encodeURIComponent(comment.id)}/screenshot`;
				show.append(shot);
			}
			show.addEventListener("click", () => selectComment(comment.id, { scroll: true, focusList: false }));
			const actions = document.createElement("div");
			actions.className = "gd-comment-actions";
			const toggle = document.createElement("button");
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
		state.comments = comments;
		if (state.activeId && !comments.some((comment) => comment.id === state.activeId)) state.activeId = null;
		state.boards.forEach(sendPins);
		renderComments();
	}

	function selectComment(id, options) {
		state.activeId = id;
		renderComments();
		const comment = state.comments.find((candidate) => candidate.id === id);
		if (!comment) return;
		if (comment.status !== state.filter && options.focusList) {
			state.filter = comment.status;
			renderList();
		}
		const board = state.boards.find((candidate) => candidate.artboard.file === comment.file);
		board?.frame.contentWindow?.postMessage({ type: "gd:highlight", id }, "*");
		if (options.focusList) els.list.querySelector(`[data-id="${CSS.escape(id)}"] .gd-comment-show`)?.focus();
		if (!options.scroll) return;
		// The focused artboard is already at 1:1; another board's comment leaves focus mode first.
		if (state.focus) {
			if (state.focus === board) return;
			exitFocus();
		}
		const pin = board?.pins.querySelector(`[data-id="${CSS.escape(id)}"]`);
		const target = pin ?? board?.frame;
		if (!target) return;
		const viewport = els.viewport.getBoundingClientRect();
		const rect = target.getBoundingClientRect();
		panBy(viewport.left + viewport.width / 2 - (rect.left + rect.width / 2), viewport.top + viewport.height / 2 - (rect.top + rect.height / 2));
	}

	async function postJson(path, body) {
		const response = await fetch(base + path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			cache: "no-store",
			body: JSON.stringify(body),
		});
		let reply = null;
		try { reply = await response.json(); } catch { reply = null; }
		return { status: response.status, ok: response.ok, body: reply || {} };
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
		state.mode = mode === "collect" ? "collect" : "send";
		els.modeSend.checked = state.mode === "send";
		els.modeCollect.checked = state.mode === "collect";
		els.send.textContent = state.mode === "collect" ? "Save" : "Send";
		try { localStorage.setItem(MODE_KEY, state.mode); } catch { /* storage may be unavailable */ }
	}

	els.modeSend.addEventListener("change", () => setMode("send"));
	els.modeCollect.addEventListener("change", () => setMode("collect"));
	els.filterOpen.addEventListener("click", () => { state.filter = "open"; renderList(); });
	els.filterResolved.addEventListener("click", () => { state.filter = "resolved"; renderList(); });
	function setPanel(show) {
		els.panel.hidden = !show;
		els.panelToggle.setAttribute("aria-pressed", String(show));
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
		state.commenting = enabled;
		els.comment.setAttribute("aria-pressed", String(enabled));
		els.world.classList.toggle("gd-commenting", enabled);
		state.boards.forEach(sendMode);
		setStatus(enabled ? "Comment mode: click an element in an artboard" : "", false);
		if (!enabled) {
			setHoverBoard(null);
			closePopover();
		}
	}

	els.comment.addEventListener("click", () => setCommenting(!state.commenting));

	function isFiniteNumber(value) {
		return typeof value === "number" && Number.isFinite(value);
	}

	function readPick(data) {
		if (typeof data.selector !== "string") return null;
		const selector = data.selector.trim();
		if (!selector || selector.length > LIMITS.selector) return null;
		const excerpt = typeof data.excerpt === "string" ? data.excerpt.slice(0, LIMITS.excerpt) : "";
		const rect = data.rect && typeof data.rect === "object" ? data.rect : {};
		const box = ["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key])) ? rect : { x: 0, y: 0, width: 0, height: 0 };
		return { selector, excerpt, rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
	}

	function openPopover(board, pick) {
		clearTimeout(state.closeTimer);
		state.pick = { board, ...pick };
		els.target.textContent = `${board.artboard.file} · ${pick.selector}`;
		els.message.textContent = "";
		els.message.classList.remove("gd-error");
		els.send.disabled = false;
		els.popover.hidden = false;
		const frameRect = board.frame.getBoundingClientRect();
		const scale = frameRect.width / board.artboard.width || 1;
		const width = els.popover.offsetWidth;
		const height = els.popover.offsetHeight;
		let left = frameRect.left + pick.rect.x * scale;
		let top = frameRect.top + (pick.rect.y + pick.rect.height) * scale + 8;
		if (top + height > window.innerHeight - 12) top = frameRect.top + pick.rect.y * scale - height - 8;
		left = Math.min(Math.max(12, left), window.innerWidth - width - 12);
		top = Math.min(Math.max(12, top), window.innerHeight - height - 12);
		els.popover.style.left = `${left}px`;
		els.popover.style.top = `${top}px`;
		els.text.focus();
	}

	function clearShot() {
		state.shot = null;
		state.shotToken += 1;
		els.shotInput.value = "";
		els.shotImage.removeAttribute("src");
		els.shotPreview.hidden = true;
		els.shotAttach.hidden = false;
	}

	function shotError(message) {
		els.message.textContent = message;
		els.message.classList.add("gd-error");
	}

	/** Reads one image file into the popover; a later attach or a clear discards a read still running. */
	function attachShot(file) {
		if (!file || els.popover.hidden) return;
		if (!SCREENSHOT_TYPES.includes(file.type)) return shotError("Attach a PNG, JPEG, WebP or GIF image.");
		if (file.size === 0 || file.size > LIMITS.screenshotBytes) return shotError("The screenshot must be at most 5 MB.");
		const token = ++state.shotToken;
		const reader = new FileReader();
		reader.addEventListener("load", () => {
			if (token !== state.shotToken || typeof reader.result !== "string") return;
			const url = reader.result;
			state.shot = { mimeType: file.type, data: url.slice(url.indexOf(",") + 1) };
			els.shotImage.src = url;
			els.shotPreview.hidden = false;
			els.shotAttach.hidden = true;
			els.message.textContent = "";
			els.message.classList.remove("gd-error");
		});
		reader.addEventListener("error", () => { if (token === state.shotToken) shotError("The screenshot could not be read."); });
		reader.readAsDataURL(file);
	}

	function imageFile(list) {
		return Array.from(list || []).find((file) => file.type.startsWith("image/")) || (list && list[0]) || null;
	}

	els.shotAttach.addEventListener("click", () => els.shotInput.click());
	els.shotInput.addEventListener("change", () => attachShot(els.shotInput.files && els.shotInput.files[0]));
	els.shotRemove.addEventListener("click", () => {
		clearShot();
		els.shotAttach.focus();
	});
	els.popover.addEventListener("paste", (event) => {
		const items = Array.from(event.clipboardData ? event.clipboardData.items : []);
		const item = items.find((entry) => entry.kind === "file" && entry.type.startsWith("image/"));
		if (!item) return;
		event.preventDefault();
		attachShot(item.getAsFile());
	});
	els.popover.addEventListener("dragover", (event) => {
		if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		els.popover.classList.add("gd-dropping");
	});
	els.popover.addEventListener("dragleave", (event) => {
		if (!els.popover.contains(event.relatedTarget)) els.popover.classList.remove("gd-dropping");
	});
	els.popover.addEventListener("drop", (event) => {
		els.popover.classList.remove("gd-dropping");
		if (!event.dataTransfer || event.dataTransfer.files.length === 0) return;
		event.preventDefault();
		attachShot(imageFile(event.dataTransfer.files));
	});

	function closePopover() {
		if (els.popover.hidden) return;
		clearTimeout(state.closeTimer);
		const board = state.pick && state.pick.board;
		state.pick = null;
		clearShot();
		els.popover.hidden = true;
		board?.frame.contentWindow?.postMessage({ type: "gd:clear" }, "*");
		if (els.popover.contains(document.activeElement) || document.activeElement === document.body) (state.focus ? state.focus.frame : els.comment).focus();
	}

	els.cancel.addEventListener("click", closePopover);
	els.popover.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			closePopover();
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.key !== "Escape") return;
		if (event.shiftKey) {
			if (state.compare) {
				event.preventDefault();
				exitCompare(true);
				return;
			}
			if (!state.focus) return;
			event.preventDefault();
			exitFocus();
		} else if (state.commenting && els.popover.hidden && event.target === document.body) setCommenting(false);
	});

	els.form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const pick = state.pick;
		if (!pick) return;
		const comment = els.text.value.trim();
		if (!comment || comment.length > LIMITS.comment) {
			els.message.textContent = `Write a comment of 1 to ${LIMITS.comment} characters.`;
			els.message.classList.add("gd-error");
			return;
		}
		els.send.disabled = true;
		els.message.classList.remove("gd-error");
		els.message.textContent = "Sending…";
		const shot = state.shot;
		try {
			const response = await fetch(`${base}api/comments`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				cache: "no-store",
				body: JSON.stringify({ slug: pick.board.slug, file: pick.board.artboard.file, selector: pick.selector, excerpt: pick.excerpt, comment, mode: state.mode, ...(shot ? { screenshot: shot } : {}) }),
			});
			let reply = {};
			try { reply = await response.json(); } catch { /* keep the status */ }
			// Delivery can fail after the comment was saved; it then waits for "Send all".
			const savedOnly = response.status === 500 && reply.saved === true;
			if (response.status !== 202 && response.status !== 201 && !savedOnly) throw new Error(reply.reason || reply.error || `HTTP ${response.status}`);
			loadComments();
			if (state.pick !== pick) return;
			els.text.value = "";
			if (state.shot === shot) clearShot();
			const done = savedOnly ? "Saved, but not sent to the session" : response.status === 201 ? "Saved; use Send all to send it" : "Sent to the session";
			els.message.textContent = done;
			els.message.classList.toggle("gd-error", savedOnly);
			setStatus(done, savedOnly);
			state.closeTimer = setTimeout(closePopover, savedOnly ? 2500 : 1200);
		} catch (error) {
			if (state.pick !== pick) return;
			els.send.disabled = false;
			els.message.textContent = `Not sent: ${error.message}`;
			els.message.classList.add("gd-error");
		}
	});

	window.addEventListener("message", (event) => {
		// Shift+Esc inside the compared artboard leaves Compare; nothing else from it is trusted.
		if (state.compare && event.source === state.compare.artboardFrame.contentWindow) {
			if (event.data && typeof event.data === "object" && event.data.type === "gd:exit-focus") exitCompare(true);
			return;
		}
		const system = state.systemBoard && state.systemBoard.frame.contentWindow === event.source ? state.systemBoard : null;
		const board = system ?? state.boards.find((candidate) => candidate.frame.contentWindow === event.source);
		if (!board || !event.data || typeof event.data !== "object") return;
		const data = event.data;
		if (data.type === "gd:pick") {
			// The system board never takes comments, even if its page posts a pick.
			if (!state.commenting || board.system || (state.focus && board !== state.focus)) return;
			const pick = readPick(data);
			if (pick) openPopover(board, pick);
		} else if (data.type === "gd:wheel") {
			if (![data.deltaX, data.deltaY, data.deltaMode, data.x, data.y].every(isFiniteNumber)) return;
			const frameRect = board.frame.getBoundingClientRect();
			const scale = frameRect.width / board.artboard.width || 1;
			handleWheel(data.deltaX, data.deltaY, data.deltaMode, data.zoom === true, data.shift === true, frameRect.left + data.x * scale, frameRect.top + data.y * scale);
		} else if (data.type === "gd:pin-rects") {
			if (board.system) return;
			const rects = readRects(data);
			if (!rects) return;
			const detachedBefore = detachedKey();
			board.rects = rects;
			renderPins(board);
			// Re-render the list only when a badge changes, so keyboard focus in it survives.
			if (detachedKey() !== detachedBefore) renderList();
		} else if (data.type === "gd:escape") {
			if (!els.popover.hidden) closePopover();
			else if (state.commenting) setCommenting(false);
		} else if (data.type === "gd:exit-focus") {
			// Only the focused artboard may end its own focus mode.
			if (board === state.focus) exitFocus();
		}
	});

	window.addEventListener("resize", closePopover);
	window.addEventListener("resize", layoutCompare);
	// The viewport also changes size when the comments panel opens or closes.
	if (typeof ResizeObserver === "function") new ResizeObserver(() => centerFocus()).observe(els.viewport);
	else window.addEventListener("resize", () => centerFocus());

	setMode(state.mode);
	start();
	connectEvents();
})();
