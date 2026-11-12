// The comment popover: the pick it opens on, the screenshot attach (file, paste,
// drop), Esc and Shift+Esc in the canvas, and the submit that saves or sends the
// comment.

const LIMITS = { selector: 500, excerpt: 300, comment: 2000, screenshotBytes: 5 * 1024 * 1024 };
const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function init(ctx) {
	const { win, doc, els, store, api, ui, actions } = ctx;
	const { state } = store;
	const { base, isFiniteNumber } = api;
	const { setStatus } = ui;

	function readPick(data) {
		if (typeof data.selector !== "string") return null;
		const selector = data.selector.trim();
		if (!selector || selector.length > LIMITS.selector) return null;
		const excerpt = typeof data.excerpt === "string" ? data.excerpt.slice(0, LIMITS.excerpt) : "";
		const rect = data.rect && typeof data.rect === "object" ? data.rect : {};
		const box = ["x", "y", "width", "height"].every((key) => isFiniteNumber(rect[key])) ? rect : { x: 0, y: 0, width: 0, height: 0 };
		return { selector, excerpt, rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
	}

	/**
	 * The pick of `surface`, a board's frame or one of its All sizes frames (canvas-sizes.js), with the size it was
	 * made at (viewport, null at the artboard's own size); the popover opens beside the element in that frame.
	 */
	function openPopover(surface, pick) {
		win.clearTimeout(state.closeTimer);
		const board = actions.ownerOf(surface);
		// A pick in another frame replaces the open one: that frame's highlight goes, as on a close.
		const previous = state.pick && state.pick.surface;
		if (previous && previous !== surface) previous.frame.contentWindow?.postMessage({ type: "gd:clear" }, "*");
		store.setPopover({ pick: { board, surface, viewport: actions.viewportOf(surface), ...pick } });
		els.target.textContent = `${board.artboard.file} · ${pick.selector}`;
		els.message.textContent = "";
		els.message.classList.remove("gd-error");
		els.send.disabled = false;
		els.popover.hidden = false;
		// The frame may be scaled (All sizes) or resized (a single size).
		const frameRect = surface.frame.getBoundingClientRect();
		const scale = frameRect.width / surface.viewWidth || 1;
		const width = els.popover.offsetWidth;
		const height = els.popover.offsetHeight;
		let left = frameRect.left + pick.rect.x * scale;
		let top = frameRect.top + (pick.rect.y + pick.rect.height) * scale + 8;
		if (top + height > win.innerHeight - 12) top = frameRect.top + pick.rect.y * scale - height - 8;
		left = Math.min(Math.max(12, left), win.innerWidth - width - 12);
		top = Math.min(Math.max(12, top), win.innerHeight - height - 12);
		els.popover.style.left = `${left}px`;
		els.popover.style.top = `${top}px`;
		els.text.focus();
	}

	function clearShot() {
		store.setPopover({ shot: null, shotToken: state.shotToken + 1 });
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
		store.setPopover({ shotToken: state.shotToken + 1 });
		const token = state.shotToken;
		const reader = new win.FileReader();
		reader.addEventListener("load", () => {
			if (token !== state.shotToken || typeof reader.result !== "string") return;
			const url = reader.result;
			store.setPopover({ shot: { mimeType: file.type, data: url.slice(url.indexOf(",") + 1) } });
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
		win.clearTimeout(state.closeTimer);
		// The frame that was picked clears its outline.
		const surface = state.pick && state.pick.surface;
		store.setPopover({ pick: null });
		clearShot();
		els.popover.hidden = true;
		surface?.frame.contentWindow?.postMessage({ type: "gd:clear" }, "*");
		if (els.popover.contains(doc.activeElement) || doc.activeElement === doc.body) returnFocus(surface);
	}

	/** Back to the size frame that was picked while it still shows, else the focused artboard, else Comment. */
	function returnFocus(surface) {
		const sizeFrame = Boolean(state.focus && surface && surface !== state.focus && actions.surfacesOf(state.focus).includes(surface));
		(sizeFrame ? surface.frame : state.focus ? state.focus.frame : els.comment).focus();
	}

	els.cancel.addEventListener("click", closePopover);
	els.popover.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			closePopover();
		}
	});
	doc.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.key !== "Escape") return;
		if (event.shiftKey) {
			if (state.compare) {
				event.preventDefault();
				actions.exitCompare(true);
				return;
			}
			if (!state.focus) return;
			event.preventDefault();
			actions.exitFocus();
		} else if (state.commenting && els.popover.hidden && event.target === doc.body) actions.setCommenting(false);
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
			const response = await win.fetch(`${base}api/comments`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				cache: "no-store",
				body: JSON.stringify({ slug: pick.board.slug, file: pick.board.artboard.file, selector: pick.selector, excerpt: pick.excerpt, comment, mode: state.mode, ...(shot ? { screenshot: shot } : {}), ...(pick.viewport ? { viewport: pick.viewport } : {}) }),
			});
			let reply = {};
			try { reply = await response.json(); } catch { /* keep the status */ }
			// Delivery can fail after the comment was saved; it then waits for "Send all".
			const savedOnly = response.status === 500 && reply.saved === true;
			if (response.status !== 202 && response.status !== 201 && !savedOnly) throw new Error(reply.reason || reply.error || `HTTP ${response.status}`);
			actions.loadComments();
			if (state.pick !== pick) return;
			els.text.value = "";
			if (state.shot === shot) clearShot();
			const done = savedOnly ? "Saved, but not sent to the session" : response.status === 201 ? "Saved; use Send all to send it" : "Sent to the session";
			els.message.textContent = done;
			els.message.classList.toggle("gd-error", savedOnly);
			setStatus(done, savedOnly);
			store.setPopover({ closeTimer: win.setTimeout(closePopover, savedOnly ? 2500 : 1200) });
		} catch (error) {
			if (state.pick !== pick) return;
			els.send.disabled = false;
			els.message.textContent = `Not sent: ${error.message}`;
			els.message.classList.add("gd-error");
		}
	});

	return { readPick, openPopover, closePopover };
}
