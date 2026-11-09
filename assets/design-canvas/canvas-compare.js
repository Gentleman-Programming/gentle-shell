// Compare: an implemented artboard next to the running app at its loopback
// previewUrl, both at the artboard's size, over the canvas and the panel.

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

export function init(ctx) {
	const { win, doc, els, store, actions } = ctx;
	const { state } = store;

	function comparePane(caption, frame) {
		const figure = doc.createElement("figure");
		figure.className = "gd-compare-pane";
		const label = doc.createElement("figcaption");
		label.className = "gd-compare-caption";
		label.textContent = caption;
		figure.append(label, frame);
		return figure;
	}

	function compareFrame(width, height, title) {
		const frame = doc.createElement("iframe");
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
		actions.exitFocus();
		actions.closePopover();
		actions.setHoverBoard(null);
		const { width, height, title } = board.artboard;
		const artboardFrame = compareFrame(width, height, `${title} artboard`);
		artboardFrame.setAttribute("sandbox", "allow-scripts");
		// Like focus mode: the artboard owns its scroll, and Shift+Esc inside it asks to leave.
		artboardFrame.addEventListener("load", () => artboardFrame.contentWindow?.postMessage({ type: "gd:focus", enabled: true }, "*"));
		artboardFrame.src = actions.boardUrl(board);
		const app = compareFrame(width, height, `Running app at ${preview}`);
		app.setAttribute("sandbox", PREVIEW_SANDBOX);
		// This module's own object: the load and timeout below update it in place.
		const compare = { board, preview, artboardFrame, timer: 0, loaded: false };
		const failed = (text) => {
			if (state.compare === compare) setCompareMessage(text, true);
		};
		// A frame refused by X-Frame-Options or frame-ancestors may still fire load, so the
		// Open in new tab fallback is always shown; a missing load also says so.
		app.addEventListener("load", () => { compare.loaded = true; });
		app.addEventListener("error", () => failed(`The app at ${preview} could not be loaded in the frame. Use Open in new tab.`));
		compare.timer = win.setTimeout(() => {
			if (!compare.loaded) failed(`The app at ${preview} has not loaded; it may be down or refuse to be framed. Use Open in new tab.`);
		}, PREVIEW_TIMEOUT_MS);
		app.src = preview;
		store.setCompare(compare);
		els.compareTitle.textContent = `Compare: ${title}`;
		// A new tab with no opener and no Referer: the canvas URL carries the server token.
		els.compareOpen.setAttribute("target", "_blank");
		els.compareOpen.setAttribute("rel", "noopener noreferrer");
		els.compareOpen.href = preview;
		setCompareMessage(new win.URL(preview).hostname === "[::1]" ? IPV6_HINT : PREVIEW_HINT, false);
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
		win.clearTimeout(compare.timer);
		store.setCompare(null);
		els.comparePanes.replaceChildren();
		els.compareOpen.removeAttribute("href");
		els.compare.hidden = true;
		els.viewport.inert = false;
		els.panel.inert = false;
		actions.applyFocusState();
		if (!restoreFocus) return;
		const board = state.boards.find((candidate) => candidate.artboard.file === compare.board.artboard.file);
		const button = board ? Array.from(board.handoff.children).find((child) => child.classList.contains("gd-compare-start")) : null;
		(button ?? els.viewport).focus();
	}

	els.compareBack.addEventListener("click", () => exitCompare(true));
	els.compareFit.addEventListener("change", layoutCompare);

	return { layoutCompare, enterCompare, exitCompare };
}
