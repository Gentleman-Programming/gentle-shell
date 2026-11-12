// Live reload: the server's event stream (show and change events).

export function init(ctx) {
	const { win, els, store, api, ui, actions } = ctx;
	const { state } = store;
	const { base } = api;
	const { setStatus } = ui;

	function connectEvents() {
		const source = new win.EventSource(`${base}events`);
		source.addEventListener("open", () => {
			if (els.status.classList.contains("gd-error")) setStatus("", false);
		});
		source.addEventListener("error", () => setStatus("Live reload disconnected, retrying…", true));
		source.addEventListener("show", (event) => {
			let request;
			try { request = JSON.parse(event.data); } catch { return; }
			if (!request || typeof request !== "object") return;
			if (request.slug !== null && !(typeof request.slug === "string" && /^[a-z0-9][a-z0-9-]*$/.test(request.slug))) return;
			actions.showDesign(request.slug).catch(() => {});
		});
		source.addEventListener("change", (event) => {
			let change;
			try { change = JSON.parse(event.data); } catch { return; }
			if (!change || typeof change.file !== "string") return;
			if (change.slug === null) {
				if (change.file === "system.html") actions.onSystemChange().catch(() => {});
				return;
			}
			if (typeof change.slug !== "string") return;
			if (change.file === "design.json") {
				actions.refreshDesigns().then(() => {
					if (change.slug === state.slug) return actions.loadManifest(state.slug, true);
					if (!state.manifest && state.slug) return actions.loadManifest(state.slug, false);
					return undefined;
				}).catch(() => {});
				return;
			}
			if (change.slug !== state.slug) return;
			if (change.file === "comments.json") {
				actions.loadComments();
				return;
			}
			if (change.file === "handoffs.json") {
				actions.loadHandoffs();
				return;
			}
			// Nor is where the boards sit: they move, nothing reloads.
			if (change.file === "layout.json") {
				actions.onLayoutChange().catch(() => {});
				return;
			}
			if (state.compare && state.compare.board.artboard.file === change.file) state.compare.artboardFrame.src = `${actions.boardUrl(state.compare.board)}?v=${Date.now()}`;
			const matching = state.boards.filter((board) => board.artboard.file === change.file);
			// A shared asset (CSS, image, font) can affect every artboard of the design.
			const targets = matching.length > 0 ? matching : change.file.endsWith(".html") ? [] : state.boards;
			targets.forEach(actions.reloadBoard);
		});
	}

	return { connectEvents };
}
