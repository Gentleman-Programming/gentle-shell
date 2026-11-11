// The files the design canvas serves from assets/design-canvas/ under
// `assets/<name>`, and the package check requires in the tarball. The list is
// explicit on purpose: it is a security boundary, and inspector.js is also
// loaded inside the artboard sandbox. index.html is the page template, read by
// the server and never served as an asset.

/** Canvas asset file name to the Content-Type it is served with. */
export const DESIGN_CANVAS_ASSETS: Readonly<Record<string, string>> = Object.freeze({
	"canvas.js": "text/javascript; charset=utf-8",
	"canvas-boot.js": "text/javascript; charset=utf-8",
	"canvas-store.js": "text/javascript; charset=utf-8",
	"canvas-api.js": "text/javascript; charset=utf-8",
	"canvas-ui.js": "text/javascript; charset=utf-8",
	"canvas-view.js": "text/javascript; charset=utf-8",
	"canvas-focus.js": "text/javascript; charset=utf-8",
	"canvas-boards.js": "text/javascript; charset=utf-8",
	"canvas-handoffs.js": "text/javascript; charset=utf-8",
	"canvas-compare.js": "text/javascript; charset=utf-8",
	"canvas-events.js": "text/javascript; charset=utf-8",
	"canvas-comments.js": "text/javascript; charset=utf-8",
	"canvas-popover.js": "text/javascript; charset=utf-8",
	"canvas-messages.js": "text/javascript; charset=utf-8",
	"canvas-menu.js": "text/javascript; charset=utf-8",
	"canvas-rail.js": "text/javascript; charset=utf-8",
	"canvas-sizes.js": "text/javascript; charset=utf-8",
	"canvas-layout.js": "text/javascript; charset=utf-8",
	"canvas-minimap.js": "text/javascript; charset=utf-8",
	"canvas-export.js": "text/javascript; charset=utf-8",
	"canvas.css": "text/css; charset=utf-8",
	"inspector.js": "text/javascript; charset=utf-8",
});
