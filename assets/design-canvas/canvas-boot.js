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
// Parts (design/<slug>/parts.json): Implement only this hands one element to the session
// without choosing a direction; Partial implementations lists them at the panel's bottom.
// Tokens (design/system.md): with Technical details on, Comment mode shows the token inspector
// beside the hovered element's frame (canvas-tokens.js).
// Accessibility checks: each artboard's own frame checks its page; the panel's Quality tab lists the
// findings, with Show (a ring on the canvas) and Ask the agent to fix (canvas-checks.js).
//
// Modules: each canvas-*.js module exports init(ctx) and returns its public
// functions; ctx is { win, doc, els, store, api, ui, i18n, actions }. Modules reach the
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
//
// The relabel rule: ctx.i18n (canvas-i18n.js) is ready before any init. A module reads its
// strings through `const T = ctx.i18n.text("<module>", TEXT)`, made in its init, and may
// return a `relabel` function from init, which boot() keeps apart from ctx.actions. The
// language starts before the first action, so the first render is in it; when it changes,
// boot() rewrites index.html's keyed text, then runs every relabel in MODULES order. A
// relabel rewrites in place the text its module built (never rebuilding a board, so no
// artboard reloads); transient text (the status line, a toast) keeps the language it had.

import * as api from "./canvas-api.js";
import * as boards from "./canvas-boards.js";
import * as checks from "./canvas-checks.js";
import * as comments from "./canvas-comments.js";
import * as compare from "./canvas-compare.js";
import * as events from "./canvas-events.js";
import * as exporter from "./canvas-export.js";
import * as focus from "./canvas-focus.js";
import * as handoffs from "./canvas-handoffs.js";
import * as i18n from "./canvas-i18n.js";
import { ES } from "./canvas-i18n-es.js";
import * as layout from "./canvas-layout.js";
import * as menu from "./canvas-menu.js";
import * as messages from "./canvas-messages.js";
import * as minimap from "./canvas-minimap.js";
import * as parts from "./canvas-parts.js";
import * as popover from "./canvas-popover.js";
import * as rail from "./canvas-rail.js";
import * as sizes from "./canvas-sizes.js";
import { createStore } from "./canvas-store.js";
import * as tokens from "./canvas-tokens.js";
import * as ui from "./canvas-ui.js";
import * as view from "./canvas-view.js";

/**
 * The modules whose functions become ctx.actions, in their listener registration order.
 * The rail comes before the popover: its keydown listener that takes the next key for a
 * shortcut runs in the capture phase, ahead of the popover's Esc. The layout comes before
 * the popover too: its Esc clears the selected artboard first, and the next Esc reaches
 * the popover's (leave Comment mode). The checks come before the layout: their Esc clears
 * the ring of Show before the selected artboard.
 */
const MODULES = [view, focus, boards, handoffs, parts, tokens, compare, events, comments, menu, rail, sizes, exporter, checks, layout, minimap, popover, messages];

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
		arrange: { row: $("gd-arrange-row"), column: $("gd-arrange-column"), grid: $("gd-arrange-grid") },
		device: $("gd-device"),
		deviceIcon: $("gd-device-icon"),
		deviceName: $("gd-device-name"),
		deviceSize: $("gd-device-size"),
		deviceMenu: $("gd-device-menu"),
		sprite: $("gd-sprite"),
		rail: $("gd-rail"),
		toolNavigate: $("gd-tool-navigate"),
		railFit: $("gd-rail-fit"),
		railSettings: $("gd-rail-settings"),
		menu: $("gd-menu"),
		shortcuts: $("gd-shortcuts"),
		shortcutsClose: $("gd-shortcuts-close"),
		keysCustom: $("gd-keys-custom"),
		keysMessage: $("gd-keys-message"),
		keysRestore: $("gd-keys-restore"),
		navMode: $("gd-nav-mode"),
		back: $("gd-back"),
		comment: $("gd-comment"),
		status: $("gd-status"),
		viewport: $("gd-viewport"),
		world: $("gd-world"),
		empty: $("gd-empty"),
		minimap: $("gd-minimap"),
		minimapMap: $("gd-minimap-map"),
		minimapView: $("gd-minimap-view"),
		minimapKey: $("gd-minimap-key"),
		inspector: $("gd-inspector"),
		inspectorTitle: $("gd-inspector-title"),
		inspectorSelector: $("gd-inspector-selector"),
		inspectorList: $("gd-inspector-list"),
		inspectorNote: $("gd-inspector-note"),
		inspectorFix: $("gd-inspector-fix"),
		inspectorCopy: $("gd-inspector-copy"),
		popover: $("gd-popover"),
		form: $("gd-popover-form"),
		target: $("gd-popover-target"),
		text: $("gd-popover-text"),
		message: $("gd-popover-message"),
		cancel: $("gd-popover-cancel"),
		partAdd: $("gd-popover-part"),
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
		tabs: $("gd-tabs"),
		tabComments: $("gd-tab-comments"),
		tabQuality: $("gd-tab-quality"),
		countComments: $("gd-count-comments"),
		countQuality: $("gd-count-quality"),
		tabpanelComments: $("gd-tabpanel-comments"),
		quality: $("gd-quality"),
		filterOpen: $("gd-filter-open"),
		filterResolved: $("gd-filter-resolved"),
		panelEmpty: $("gd-panel-empty"),
		list: $("gd-comment-list"),
		parts: $("gd-parts"),
		partsTitle: $("gd-parts-title"),
		partsList: $("gd-parts-list"),
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
	const ctx = { win, doc, els, store, api: null, ui: null, i18n: null, actions };
	ctx.api = api.init(ctx, base, config.delivery);
	ctx.ui = ui.init(ctx);
	const relabels = [];
	ctx.i18n = i18n.init(ctx, ES, () => {
		ctx.i18n.applyMarkup();
		for (const relabel of relabels) relabel();
		// A longer or shorter label changes the room above the focused artboard: place it again.
		ctx.actions.centerFocus({ keepInspector: true });
	});
	for (const module of MODULES) {
		const { relabel, ...functions } = module.init(ctx);
		if (relabel) relabels.push(relabel);
		addActions(actions, functions);
	}
	addActions(actions, { viewportResized });
	Object.freeze(actions);

	win.addEventListener("resize", actions.closePopover);
	win.addEventListener("resize", actions.layoutCompare);
	// The viewport also changes size when the comments panel opens or closes (setPanel).
	function viewportResized() {
		actions.centerFocus();
		actions.refit();
		actions.measureMinimap();
	}
	if (typeof win.ResizeObserver === "function") new win.ResizeObserver(viewportResized).observe(els.viewport);
	else win.addEventListener("resize", viewportResized);

	ctx.i18n.startLanguage();
	actions.setMode(actions.storedMode());
	actions.startRail();
	actions.startSizes();
	actions.startTokens();
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
