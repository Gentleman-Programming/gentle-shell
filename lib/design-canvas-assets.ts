// The files the design canvas serves from assets/design-canvas/ under
// `assets/<name>`, and the package check requires in the tarball. The list is
// explicit on purpose: it is a security boundary, and inspector.js is also
// loaded inside the artboard sandbox. index.html is the page template, read by
// the server and never served as an asset.

/** Canvas asset file name to the Content-Type it is served with. */
export const DESIGN_CANVAS_ASSETS: Readonly<Record<string, string>> = Object.freeze({
	"canvas.js": "text/javascript; charset=utf-8",
	"canvas.css": "text/css; charset=utf-8",
	"inspector.js": "text/javascript; charset=utf-8",
});
