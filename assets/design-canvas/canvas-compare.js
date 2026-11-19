// Compare: an implemented artboard next to the running app at its loopback
// previewUrl, both at the artboard's size, over the canvas and the panel.

// The running app is another loopback origin (previewTarget refuses this server's own
// port), so the same-origin flag below gives the app its own origin, never the canvas's: it cannot
// reach this page, its token or its API, and its scripts, storage and forms work as in
// production. No top-navigation flag is granted, so it can never navigate the canvas away.
const PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";
const PREVIEW_TIMEOUT_MS = 6000;
const COMPARE_GAP = 24;
const COMPARE_PADDING = 24;

// Every string Compare shows, in English; canvas-i18n-es.js has the Spanish. Titles, file names and URLs stay as written.
const TEXT = Object.freeze({
	hint: "If the app refuses to be framed, use Open in new tab.",
	// CSP host sources have no IPv6 literal form, so Chromium drops the [::1] source from frame-src.
	ipv6: "Browsers do not frame [::1] under the canvas policy (CSP has no IPv6 sources): use Open in new tab, or report the preview on localhost.",
	title: (title) => `Compare: ${title}`,
	artboardFrame: (title) => `${title} artboard`,
	appFrame: (preview) => `Running app at ${preview}`,
	designCaption: (file) => `Design: ${file}`,
	appCaption: (preview) => `Implementation: ${preview}`,
	loadError: (preview) => `The app at ${preview} could not be loaded in the frame. Use Open in new tab.`,
	timeout: (preview) => `The app at ${preview} has not loaded; it may be down or refuse to be framed. Use Open in new tab.`,
});

export function init(ctx) {
	const { win, doc, els, store, actions } = ctx;
	const { state } = store;
	const T = ctx.i18n.text("compare", TEXT);

	function comparePane(frame) {
		const figure = doc.createElement("figure");
		figure.className = "gd-compare-pane";
		const label = doc.createElement("figcaption");
		label.className = "gd-compare-caption";
		figure.append(label, frame);
		return figure;
	}

	function compareFrame(width, height) {
		const frame = doc.createElement("iframe");
		frame.className = "gd-compare-frame";
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.style.width = `${width}px`;
		frame.style.height = `${height}px`;
		return frame;
	}

	/** text: the message, as a function so a new language writes it again (relabel). */
	function setCompareMessage(compare, text, isError) {
		compare.message = { text, isError };
		els.compareMessage.textContent = text();
		els.compareMessage.classList.toggle("gd-error", Boolean(isError));
	}

	/** Compare's own text, in the current language: its title, the captions and names of both frames, and its message. */
	function labelCompare() {
		const compare = state.compare;
		if (!compare) return;
		const { board, preview, artboardFrame, app, panes } = compare;
		els.compareTitle.textContent = T.title(board.artboard.title);
		artboardFrame.title = T.artboardFrame(board.artboard.title);
		app.title = T.appFrame(preview);
		panes[0].children[0].textContent = T.designCaption(board.artboard.file);
		panes[1].children[0].textContent = T.appCaption(preview);
		setCompareMessage(compare, compare.message.text, compare.message.isError);
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
		actions.exitFocus();
		actions.closePopover();
		actions.setHoverBoard(null);
		const { width, height } = board.artboard;
		const artboardFrame = compareFrame(width, height);
		artboardFrame.setAttribute("sandbox", "allow-scripts");
		// Like focus mode: the artboard owns its scroll, and Shift+Esc inside it asks to leave.
		artboardFrame.addEventListener("load", () => artboardFrame.contentWindow?.postMessage({ type: "gd:focus", enabled: true }, "*"));
		artboardFrame.src = actions.boardUrl(board);
		const app = compareFrame(width, height);
		app.setAttribute("sandbox", PREVIEW_SANDBOX);
		const panes = [comparePane(artboardFrame), comparePane(app)];
		// This module's own object: the load and timeout below update it in place, and so does a new language (labelCompare).
		const compare = { board, preview, artboardFrame, app, panes, timer: 0, loaded: false, message: null };
		const failed = (text) => {
			if (state.compare === compare) setCompareMessage(compare, text, true);
		};
		// A frame refused by X-Frame-Options or frame-ancestors may still fire load, so the
		// Open in new tab fallback is always shown; a missing load also says so.
		app.addEventListener("load", () => { compare.loaded = true; });
		app.addEventListener("error", () => failed(() => T.loadError(preview)));
		compare.timer = win.setTimeout(() => {
			if (!compare.loaded) failed(() => T.timeout(preview));
		}, PREVIEW_TIMEOUT_MS);
		app.src = preview;
		store.setCompare(compare);
		// A new tab with no opener and no Referer: the canvas URL carries the server token.
		els.compareOpen.setAttribute("target", "_blank");
		els.compareOpen.setAttribute("rel", "noopener noreferrer");
		els.compareOpen.href = preview;
		const ipv6 = new win.URL(preview).hostname === "[::1]";
		compare.message = { text: () => (ipv6 ? T.ipv6 : T.hint), isError: false };
		els.comparePanes.replaceChildren(...panes);
		labelCompare();
		els.compareFit.checked = false;
		els.compare.hidden = false;
		// Compare covers the rail too: inert, its controls leave the keyboard and the pointer.
		els.viewport.inert = true;
		els.panel.inert = true;
		els.rail.inert = true;
		for (const control of [els.zoomOut, els.zoomIn, els.fit, els.railFit, els.design]) control.disabled = true;
		// Compare covers the canvas: nothing to arrange, and no minimap.
		actions.renderArrange();
		actions.renderMinimap();
		layoutCompare();
		els.compareBack.focus();
	}

	function exitCompare(restoreFocus) {
		const compare = state.compare;
		if (!compare) return;
		win.clearTimeout(compare.timer);
		store.setCompare(null);
		els.comparePanes.replaceChildren();
		els.compareOpen.removeAttribute("href");
		els.compare.hidden = true;
		els.viewport.inert = false;
		els.panel.inert = false;
		els.rail.inert = false;
		actions.applyFocusState();
		if (!restoreFocus) return;
		const board = state.boards.find((candidate) => candidate.artboard.file === compare.board.artboard.file);
		const button = board ? Array.from(board.handoff.children).find((child) => child.classList.contains("gd-compare-start")) : null;
		(button ?? els.viewport).focus();
	}

	els.compareBack.addEventListener("click", () => exitCompare(true));
	els.compareFit.addEventListener("change", layoutCompare);

	return { layoutCompare, enterCompare, exitCompare, relabel: labelCompare };
}
