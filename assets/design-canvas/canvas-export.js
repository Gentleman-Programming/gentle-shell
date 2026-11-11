// Export: a ⋯ button in each design artboard's header opens the shared menu
// (canvas-menu.js) with the export items only: Export as PNG and at 2× (the
// browser's own tab capture, cropped to the artboard), Export as PDF (the print
// dialog) and Download HTML (the artboard file as written). Nothing goes to the
// server and nothing is written under design/. The system board gets no menu.
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
	confirm: "Choose this canvas tab in the browser's capture selector. Choosing another tab or screen may export the wrong content.",
	failed: (reason) => `Could not export the artboard. ${reason} Use your browser's screenshot tool instead.`,
	unavailable: "Tab capture is not available in this browser.",
	sharedScreen: "You shared a screen, not this tab, so the artboard cannot be cropped from it.",
	sharedOther: (surface) => `You shared a ${surface}, not this tab, so the artboard cannot be cropped from it.`,
	window: (width, height) => `The artboard needs a browser window of at least ${width} × ${height} px. Make the window bigger or use full screen (F11), then try again.`,
	noFrame: "The captured frame has no dimensions.",
	noPng: "PNG export is not available.",
	encode: "Could not encode the PNG.",
	denied: "Capture was denied or failed.",
	done: "Exported PNG.",
	doneUpscaled: "Exported PNG at 2× (upscaled).",
	downloadFailed: (reason) => `Could not download the artboard (${reason}). Open it from design/ in your project instead.`,
});

// Every PNG export starts the artboard at Desktop, its own size.
const DESKTOP = Object.freeze({ kind: "desktop" });

export function init(ctx) {
	const { win, doc, els, store, api, ui, actions } = ctx;
	const { state } = store;

	/** The ⋯ button of a design artboard's header, wired to its menu. */
	function boardMenuButton(board) {
		const button = doc.createElement("button");
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
			{ label: TEXT.pdf, icon: "i-image", run: () => exportPdf(board) },
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

	function nextVideoFrame(video) {
		return new Promise((resolve) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => resolve()) : win.setTimeout(resolve, 100)));
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
	 * top left; then it restores the focus, the screen size and the view it had.
	 */
	async function exportArtboard(board, scale) {
		if (!win.navigator?.mediaDevices?.getDisplayMedia) {
			reportFailure(TEXT.failed(TEXT.unavailable));
			return;
		}
		if (!win.confirm(TEXT.confirm)) return;
		let stream = null;
		const previous = { focus: state.focus, size: state.size, view: { zoom: state.zoom, x: state.x, y: state.y, fitted: state.fitted } };
		try {
			// This call must happen directly from the menu activation, before any asynchronous work.
			stream = await win.navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true });
			// Some systems (such as Linux on Wayland) only offer windows or screens; their frame is not this tab's viewport.
			const surface = stream.getVideoTracks?.()[0]?.getSettings?.().displaySurface;
			if (surface && surface !== "browser") throw new Error(surface === "monitor" ? TEXT.sharedScreen : TEXT.sharedOther(surface));
			if (state.focus !== board) actions.enterFocus(board);
			if (state.size.kind !== DESKTOP.kind) {
				store.setFocus({ size: DESKTOP });
				actions.centerFocus();
			}
			// The viewport covers the window without the canvas chrome. Its size changes, so focus mode may center
			// the artboard again once (the viewport's resize observer): wait for that before placing it.
			doc.body.classList.add("gd-exporting");
			await nextPaint();
			// Desktop fills the window (canvas-layout S8); the image is the artboard at its own size, at the top left.
			actions.setFrameSize(board, board.artboard.width, board.artboard.height);
			store.setView({ zoom: 1, x: 0, y: 0 });
			actions.applyView();
			await nextPaint();
			const start = board.frame.getBoundingClientRect();
			store.setView({ x: state.x - start.left, y: state.y - start.top });
			actions.applyView();
			await nextPaint();
			const rect = board.frame.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0 || rect.left + rect.width > win.innerWidth || rect.top + rect.height > win.innerHeight) {
				throw new Error(TEXT.window(Math.ceil(rect.width), Math.ceil(rect.height)));
			}
			const video = doc.createElement("video");
			video.srcObject = stream;
			video.muted = true;
			await video.play();
			// The first frame can predate the layout above; wait for frames painted after it.
			await nextVideoFrame(video);
			await nextVideoFrame(video);
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
			ui.showToast(scale === 2 && (sx < 2 || sy < 2) ? TEXT.doneUpscaled : TEXT.done, false);
		} catch (error) {
			reportFailure(TEXT.failed(sentence(error?.message || TEXT.denied)));
		} finally {
			stream?.getTracks().forEach((track) => track.stop());
			doc.body.classList.remove("gd-exporting");
			if (!previous.focus && state.focus) actions.exitFocus();
			else if (previous.focus && state.focus !== previous.focus) actions.enterFocus(previous.focus);
			if (previous.focus && state.focus === previous.focus) {
				store.setFocus({ size: previous.size });
				actions.centerFocus();
			}
			store.setView(previous.view);
			actions.applyView();
		}
	}

	// The print container of the PDF export in progress, or null.
	let printing = null;

	/**
	 * Prints the artboard alone, at its own size, from this page (artboards are sandboxed without modals, so
	 * they cannot print themselves): the browser's print dialog saves it as PDF. Nothing goes to the server.
	 */
	function exportPdf(board) {
		printing?.remove();
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
		printing = holder;
		const page = setPrintPage(width, height);
		const done = () => {
			if (printing !== holder) return;
			printing = null;
			page?.();
			holder.remove();
			doc.body.classList.remove("gd-printing");
		};
		win.addEventListener("afterprint", done, { once: true });
		frame.addEventListener("load", () => win.print(), { once: true });
		frame.setAttribute("src", api.fileUrl(board.slug, file));
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

	/** Saves the artboard file as written: the server injects the inspector into every artboard, so remove that tag again. */
	async function downloadHtml(board) {
		try {
			const response = await win.fetch(api.fileUrl(board.slug, board.artboard.file), { cache: "no-store" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const served = await response.text();
			const tag = `<script src="${api.base}assets/inspector.js"></script>`;
			const at = served.lastIndexOf(tag);
			const html = at === -1 ? served : served.slice(0, at) + served.slice(at + tag.length);
			download(win.URL.createObjectURL(new win.Blob([html], { type: "text/html" })), fileName(board));
		} catch (error) {
			reportFailure(TEXT.downloadFailed(error?.message || "error"));
		}
	}

	return { boardMenuButton, closeBoardMenu, exportArtboard, exportPdf, downloadHtml };
}
