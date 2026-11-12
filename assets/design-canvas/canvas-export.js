// Export: a ⋯ button in each design artboard's header opens the shared menu
// (canvas-menu.js) with the export items only: Export as PNG and at 2× (the
// browser's own tab capture, cropped to the artboard), Export as PDF (the print
// dialog) and Download HTML (the artboard file as written). PNG contacts no
// server; PDF and HTML only read the artboard file from the canvas server (a GET).
// Nothing is uploaded and nothing is written under design/. The system board gets no menu.
// canvas-boards.js asks for the button when it builds a board (boardMenuButton).
// Results and failures show on the status line and the toast (canvas-ui.js).

// Every string the export shows, in English until the i18n PR keys them.
const TEXT = Object.freeze({
	button: (title) => `More actions for ${title}`,
	menu: (title) => `${title} actions`,
	png: "Export as PNG",
	png2x: "Export as PNG at 2×",
	pdf: "Export as PDF",
	html: "Download HTML",
	frameTitle: (title) => `${title} artboard`,
	choose: "Choose this canvas tab in the browser's capture selector. Choosing another tab or screen may export the wrong content.",
	failed: (reason) => `Could not export the artboard. ${reason} Use your browser's screenshot tool instead.`,
	unavailable: "Tab capture is not available in this browser.",
	sharedScreen: "You shared a screen, not this tab, so the artboard cannot be cropped from it.",
	sharedOther: (surface) => `You shared a ${surface}, not this tab, so the artboard cannot be cropped from it.`,
	window: (width, height) => `The artboard needs a browser window of at least ${width} × ${height} px. Make the window bigger or use full screen (F11), then try again.`,
	noFrame: "The captured frame has no dimensions.",
	noPng: "PNG export is not available.",
	encode: "Could not encode the PNG.",
	denied: "Capture was denied or failed.",
	stopped: "Sharing stopped before the artboard was captured.",
	gone: "The artboard is no longer in the design.",
	changed: "The artboard was reloaded or closed during the capture.",
	done: "Exported PNG.",
	doneUpscaled: "Exported PNG at 2× (upscaled).",
	downloadFailed: (reason) => `Could not download the artboard (${reason}). Open it from design/ in your project instead.`,
	printFailed: (reason) => `Could not print the artboard (${reason}). Open it from design/ in your project instead.`,
});

// Every PNG export starts the artboard at Desktop, its own size.
const DESKTOP = Object.freeze({ kind: "desktop" });

// The characters the server escapes in the inspector tag's base, and how (escapeHtml in lib/design-canvas-server.ts).
const HTML_ESCAPES = Object.freeze({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" });

/**
 * The inspector tag the server injects into every artboard served under `base` (inspectorTag and injectInspector in
 * lib/design-canvas-server.ts): Download HTML removes it. tests/design-canvas-export.test.ts serves the
 * artboard through the server's own injection, so the two cannot drift apart silently.
 */
function inspectorTag(base) {
	return `<script src="${base.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])}assets/inspector.js"></script>`;
}

// How long a PNG export waits for the capture to paint a new frame; sharing that stopped paints none.
const FRAME_WAIT_MS = 500;

export function init(ctx) {
	const { win, doc, els, store, api, ui, actions } = ctx;
	const { state } = store;
	// Each board's ⋯ button, so an export can give the keyboard focus back to the current board's.
	const buttons = new WeakMap();
	// True while a PNG export runs: a second one would share its body class, its view restore and its capture.
	let exporting = false;

	/** The ⋯ button of a design artboard's header, wired to its menu. */
	function boardMenuButton(board) {
		const button = doc.createElement("button");
		buttons.set(board, button);
		button.type = "button";
		button.className = "gd-menu-button";
		button.setAttribute("aria-label", TEXT.button(board.artboard.title));
		button.setAttribute("aria-haspopup", "menu");
		button.setAttribute("aria-expanded", "false");
		button.setAttribute("aria-controls", els.menu.id);
		button.append(actions.icon("i-more", "gd-i gd-i-s"));
		actions.wireMenu(button, (last) => actions.showMenu(button, menuActions(board), TEXT.menu(board.artboard.title), last));
		return button;
	}

	/** What the menu offers for one artboard, in order: the exports only. */
	function menuActions(board) {
		return [
			{ label: TEXT.png, icon: "i-image", run: () => exportArtboard(board, 1) },
			{ label: TEXT.png2x, icon: "i-image", run: () => exportArtboard(board, 2) },
			{ label: TEXT.pdf, icon: "i-file", run: () => exportPdf(board) },
			{ label: TEXT.html, icon: "i-download", run: () => downloadHtml(board) },
		];
	}

	/** Closes the open menu when it is an artboard's: its button moved (a pan or zoom) or is gone (a reload). */
	function closeBoardMenu() {
		if (state.menu && state.menu.button.classList.contains("gd-menu-button")) actions.closeMenu(false);
	}

	/** One sentence, ending with its period. */
	const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

	function reportFailure(text) {
		ui.setStatus(text, true);
		ui.showToast(text, true);
	}

	function nextPaint() {
		return new Promise((resolve) => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
	}

	/** The next frame the capture paints, or FRAME_WAIT_MS at most: a capture whose sharing stopped paints none. */
	function nextVideoFrame(video) {
		const frame = new Promise((resolve) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => resolve()) : win.setTimeout(resolve, 100)));
		return Promise.race([frame, new Promise((resolve) => win.setTimeout(resolve, FRAME_WAIT_MS))]);
	}

	/**
	 * Rejects with TEXT.stopped once the shared video ends (the browser's Stop sharing, a closed tab):
	 * nothing paints after that, so no wait of the export may outlive it.
	 */
	function sharingEnded(stream) {
		const ended = new Promise((_resolve, reject) => {
			for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => reject(new Error(TEXT.stopped)), { once: true });
		});
		// Ending after the export finished concerns nobody.
		ended.catch(() => {});
		return ended;
	}

	/**
	 * The board that stands for `board` now: a design.json reload builds new board objects, so the same
	 * artboard file (or the system board) is looked up again; null when it is gone.
	 */
	function currentBoard(board) {
		if (!board) return null;
		if (board.system) return state.systemBoard;
		return state.boards.find((candidate) => candidate.slug === board.slug && candidate.artboard.file === board.artboard.file) ?? null;
	}

	/** Downloads `url` as `name` through a temporary link, then releases the URL. */
	function download(url, name) {
		try {
			const link = doc.createElement("a");
			link.href = url;
			link.download = name;
			link.click();
		} finally { win.URL.revokeObjectURL(url); }
	}

	/** The artboard file's name without its folder (and, with `bare`, without its extension). */
	function fileName(board, bare = false) {
		const name = board.artboard.file.split("/").pop();
		return bare ? name.replace(/\.[^.]+$/, "") : name;
	}

	/**
	 * Exports the artboard as a PNG from the browser's tab capture, without sending pixels to the server.
	 * For one frame the canvas hides its chrome and puts the artboard at its own size at 100% in the window's
	 * top left; then it restores the focus, the screen size and the view it had, and puts the keyboard focus
	 * back on the artboard's ⋯ button. A design.json reload while the browser asks for the capture replaces
	 * the board objects: both the export and the restore follow the current ones; a reload (the design's or the
	 * artboard frame's own) or a close while the frame is being grabbed fails the export instead, and an artboard
	 * left meanwhile (Back, Shift+Esc) is not reopened, even across a reload. A second request while one runs is
	 * ignored, a viewport resized meanwhile gets the view a resize gives (refit or recentered), not the old one, and
	 * another design shown meanwhile keeps its own view.
	 */
	async function exportArtboard(chosen, scale) {
		if (!win.navigator?.mediaDevices?.getDisplayMedia) {
			reportFailure(TEXT.failed(TEXT.unavailable));
			return;
		}
		// Synchronous, so the capture below still starts from the menu activation.
		if (exporting) return;
		exporting = true;
		// Not a confirm dialog: the browser lets the capture start only for a few seconds after the click.
		ui.setStatus(TEXT.choose, false);
		let stream = null;
		// The board whose inspector highlight was cleared for the capture.
		let cleared = null;
		const previous = { slug: state.slug, focus: state.focus, size: state.size, view: { zoom: state.zoom, x: state.x, y: state.y, fitted: state.fitted } };
		const viewport = els.viewport.getBoundingClientRect();
		const viewportSize = { width: viewport.width, height: viewport.height };
		try {
			// This call must happen directly from the menu activation, before any asynchronous work.
			stream = await win.navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true });
			const ended = sharingEnded(stream);
			// Every wait below ends early, and the export fails, once sharing stops.
			const live = (promise) => Promise.race([ended, promise]);
			// Some systems (such as Linux on Wayland) only offer windows or screens; their frame is not this tab's viewport.
			const surface = stream.getVideoTracks?.()[0]?.getSettings?.().displaySurface;
			if (surface && surface !== "browser") throw new Error(surface === "monitor" ? TEXT.sharedScreen : TEXT.sharedOther(surface));
			// A stream that is already inactive will send no ended event.
			if (stream.getVideoTracks().some((track) => track.readyState === "ended")) throw new Error(TEXT.stopped);
			const board = currentBoard(chosen);
			if (!board) throw new Error(TEXT.gone);
			if (state.focus !== board) actions.enterFocus(board);
			if (state.size.kind !== DESKTOP.kind) {
				store.setFocus({ size: DESKTOP });
				actions.centerFocus();
			}
			// The viewport covers the window without the canvas chrome. Its size changes, so focus mode may center
			// the artboard again once (the viewport's resize observer): wait for that before placing it.
			doc.body.classList.add("gd-exporting");
			// The inspector draws a selected comment's outline and, in comment mode, the hovered element's outline
			// inside the artboard, out of the chrome's reach: comment mode is off there until the export ends.
			board.frame.contentWindow?.postMessage({ type: "gd:clear" }, "*");
			board.frame.contentWindow?.postMessage({ type: "gd:mode", enabled: false }, "*");
			cleared = board;
			// An artboard file change reloads this frame in place (same board object, new src): see the check below.
			const source = board.frame.src;
			await live(nextPaint());
			// Desktop fills the window (canvas-layout S8); the image is the artboard at its own size, at the top left.
			actions.setFrameSize(board, board.artboard.width, board.artboard.height);
			store.setView({ zoom: 1, x: 0, y: 0 });
			actions.applyView();
			await live(nextPaint());
			const start = board.frame.getBoundingClientRect();
			store.setView({ x: state.x - start.left, y: state.y - start.top });
			actions.applyView();
			await live(nextPaint());
			const rect = board.frame.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0 || rect.left + rect.width > win.innerWidth || rect.top + rect.height > win.innerHeight) {
				throw new Error(TEXT.window(Math.ceil(rect.width), Math.ceil(rect.height)));
			}
			const video = doc.createElement("video");
			video.srcObject = stream;
			video.muted = true;
			await live(video.play());
			// The first frame can predate the layout above; wait for frames painted after it.
			await live(nextVideoFrame(video));
			await live(nextVideoFrame(video));
			// A reload (of the design or of the artboard's own frame) or a close during the waits moved or repainted
			// the artboard away from the rectangle measured above.
			if (currentBoard(board) !== board || state.focus !== board || board.frame.src !== source) throw new Error(TEXT.changed);
			const sx = video.videoWidth / win.innerWidth;
			const sy = video.videoHeight / win.innerHeight;
			if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) throw new Error(TEXT.noFrame);
			const canvas = doc.createElement("canvas");
			canvas.width = Math.round(rect.width * scale);
			canvas.height = Math.round(rect.height * scale);
			const context = canvas.getContext("2d");
			if (!context) throw new Error(TEXT.noPng);
			context.drawImage(video, rect.left * sx, rect.top * sy, rect.width * sx, rect.height * sy, 0, 0, canvas.width, canvas.height);
			stream.getTracks().forEach((track) => track.stop());
			stream = null;
			const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
			if (!blob) throw new Error(TEXT.encode);
			download(win.URL.createObjectURL(blob), `${fileName(board, true)}${scale === 2 ? "@2x" : ""}.png`);
			const done = scale === 2 && (sx < 2 || sy < 2) ? TEXT.doneUpscaled : TEXT.done;
			ui.setStatus(done, false);
			ui.showToast(done, false);
		} catch (error) {
			reportFailure(TEXT.failed(sentence(error?.message || TEXT.denied)));
		} finally {
			exporting = false;
			stream?.getTracks().forEach((track) => track.stop());
			doc.body.classList.remove("gd-exporting");
			// Left with Back or Shift+Esc during the capture: the artboard stays closed, with the view leaving gave.
			// A design.json reload keeps focus on the same file (with a new board object), so no focus while the
			// artboard is still in the design means it was left, whether a reload came before or after.
			const left = Boolean(cleared) && !state.focus && currentBoard(cleared) !== null;
			// The artboard that was open, as it is now; when a reload removed it, the canvas leaves focus mode.
			const reopen = left ? null : currentBoard(previous.focus);
			if (!reopen && state.focus) actions.exitFocus();
			else if (reopen && state.focus !== reopen) actions.enterFocus(reopen);
			if (reopen && state.focus === reopen) {
				store.setFocus({ size: previous.size });
				actions.centerFocus();
			}
			// A focus view without its artboard would leave the overview pointing at nothing, and another design
			// shown meanwhile keeps the view it got (its fit), not this design's.
			if (!left && (reopen || !previous.focus) && state.slug === previous.slug) {
				store.setView(previous.view);
				actions.applyView();
			}
			// The window changed size meanwhile (while the browser asked for the capture, say): the view from before
			// would stay stale until the next resize, so do what a resize does (refit the overview, recenter focus).
			const now = els.viewport.getBoundingClientRect();
			if (now.width !== viewportSize.width || now.height !== viewportSize.height) actions.viewportResized();
			// Comment mode comes back in the artboard, then the selected comment's outline when it is on this
			// artboard, as canvas-comments.js shows it. A reload sent its own mode to the board that replaced it.
			const active = state.comments.find((comment) => comment.id === state.activeId);
			if (cleared && currentBoard(cleared) === cleared) {
				actions.sendMode(cleared);
				if (active?.file === cleared.artboard.file) cleared.frame.contentWindow?.postMessage({ type: "gd:highlight", id: active.id }, "*");
			}
			const board = currentBoard(chosen);
			if (board) buttons.get(board)?.focus();
		}
	}

	// Ends the PDF export in progress (its container, page rule and listener), or null.
	let endPrint = null;

	/**
	 * Prints the artboard alone, at its own size, from this page (artboards are sandboxed without modals, so
	 * they cannot print themselves): the browser's print dialog saves it as PDF. The frame and the check below
	 * read the artboard file from the canvas server; nothing is uploaded.
	 * The file is read first: a frame also loads the server's error page, which must not be printed.
	 */
	async function exportPdf(board) {
		endPrint?.();
		const { width, height, title, file } = board.artboard;
		const holder = doc.createElement("div");
		holder.className = "gd-print";
		const frame = doc.createElement("iframe");
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.title = TEXT.frameTitle(title);
		frame.style.width = `${width}px`;
		frame.style.height = `${height}px`;
		holder.append(frame);
		doc.body.append(holder);
		doc.body.classList.add("gd-printing");
		const page = setPrintPage(width, height);
		const done = () => {
			if (endPrint !== done) return;
			endPrint = null;
			win.removeEventListener("afterprint", done);
			page?.();
			holder.remove();
			doc.body.classList.remove("gd-printing");
		};
		endPrint = done;
		win.addEventListener("afterprint", done, { once: true });
		const url = api.fileUrl(board.slug, file);
		try {
			const response = await win.fetch(url, { cache: "no-store" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
		} catch (error) {
			// A newer export replaced this one meanwhile: its failure concerns nobody.
			if (endPrint !== done) return;
			done();
			reportFailure(TEXT.printFailed(error?.message || "error"));
			return;
		}
		if (endPrint !== done) return;
		// Attached only now: some browsers (Firefox before 148) fire the empty frame's about:blank load after its
		// insertion, which would print a blank page. Setting src right after cancels that pending load.
		frame.addEventListener("load", () => {
			try {
				win.print();
			} catch (error) {
				// No dialog opened, so no afterprint will come.
				done();
				reportFailure(TEXT.printFailed(error?.message || "error"));
			}
		}, { once: true });
		frame.setAttribute("src", url);
	}

	/** One page the artboard's size (canvas.css sets no margin); returns how to remove it, or null where the browser gives no CSSOM. */
	function setPrintPage(width, height) {
		const sheet = [...(doc.styleSheets ?? [])].find((candidate) => /canvas\.css(\?|$)/.test(candidate.href ?? ""));
		if (!sheet?.insertRule) return null;
		try {
			const index = sheet.insertRule(`@page { size: ${width}px ${height}px; }`, sheet.cssRules.length);
			return () => { if (sheet.cssRules[index]) sheet.deleteRule(index); };
		} catch {
			return null;
		}
	}

	/**
	 * Saves the artboard file as written, read from the canvas server (nothing is uploaded): the server injects the
	 * inspector into every artboard, so remove that tag again.
	 */
	async function downloadHtml(board) {
		try {
			const response = await win.fetch(api.fileUrl(board.slug, board.artboard.file), { cache: "no-store" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const served = await response.text();
			const tag = inspectorTag(api.base);
			const at = served.lastIndexOf(tag);
			const html = at === -1 ? served : served.slice(0, at) + served.slice(at + tag.length);
			download(win.URL.createObjectURL(new win.Blob([html], { type: "text/html" })), fileName(board));
		} catch (error) {
			reportFailure(TEXT.downloadFailed(error?.message || "error"));
		}
	}

	return { boardMenuButton, closeBoardMenu };
}
