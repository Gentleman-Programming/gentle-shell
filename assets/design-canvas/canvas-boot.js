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
//
// Modules: each canvas-*.js module exports init(ctx) and returns its public
// functions; ctx is { win, doc, els, store, api, ui, actions }. Modules reach the
// browser only through ctx.win and ctx.doc, change state only through the store's
// mutators (canvas-store.js), and never import each other: this file is the only
// one that imports the others, so no module touches the DOM or window when it is
// imported, and the cross-module calls cannot form an import cycle.
//
// The ctx.actions rule: boot() fills ctx.actions with the functions every init
// returns. Actions are only complete once every `init` has returned, so no `init`
// may call another module's action synchronously, nor keep one by value: inside
// an init, pass `() => actions.fit()`, never `actions.fit` itself. Inits only
// define functions and register listeners; the first actions run at the end of
// boot().

import * as api from "./canvas-api.js";
import * as boards from "./canvas-boards.js";
import * as comments from "./canvas-comments.js";
import * as compare from "./canvas-compare.js";
import * as events from "./canvas-events.js";
import * as focus from "./canvas-focus.js";
import * as handoffs from "./canvas-handoffs.js";
import * as messages from "./canvas-messages.js";
import * as popover from "./canvas-popover.js";
import { createStore } from "./canvas-store.js";
import * as ui from "./canvas-ui.js";
import * as view from "./canvas-view.js";

/** The modules whose functions become ctx.actions, in their listener registration order. */
const MODULES = [view, focus, boards, handoffs, compare, events, comments, popover, messages];

export function boot(win, doc) {
	const config = JSON.parse(doc.getElementById("gd-config").textContent);
	const base = String(config.base);

	const $ = (id) => doc.getElementById(id);
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

	const store = createStore({ slug: config.slug });
	const actions = {};
	const ctx = { win, doc, els, store, api: null, ui: null, actions };
	ctx.api = api.init(ctx, base);
	ctx.ui = ui.init(ctx);
	for (const module of MODULES) addActions(actions, module.init(ctx));
	addActions(actions, { viewportResized });
	Object.freeze(actions);

	win.addEventListener("resize", actions.closePopover);
	win.addEventListener("resize", actions.layoutCompare);
	// The viewport also changes size when the comments panel opens or closes (setPanel).
	function viewportResized() {
		actions.centerFocus();
		actions.refit();
	}
	if (typeof win.ResizeObserver === "function") new win.ResizeObserver(viewportResized).observe(els.viewport);
	else win.addEventListener("resize", viewportResized);

	actions.setMode(actions.storedMode());
	actions.start();
	actions.connectEvents();
}

/** Adds one module's functions to ctx.actions; two modules never share a name. */
function addActions(actions, functions) {
	for (const [name, action] of Object.entries(functions)) {
		if (Object.hasOwn(actions, name)) throw new Error(`canvas: ${name} is exported by two modules`);
		actions[name] = action;
	}
}
