// The canvas theme, before the first frame: a classic script loaded synchronously in index.html's <head>
// (the canvas CSP allows no inline script), so a saved Drakoncman never shows Neutral for a frame on reload.
// The same rule as canvas-theme.js's storedTheme(): only an exact "drakoncman" under drakonc-design:theme sets
// data-theme; anything else, or any error, leaves :root's Neutral. canvas-theme.js (startTheme) then applies
// the saved theme again and keeps it in the store: it stays the source of truth.
try {
	if (localStorage.getItem("drakonc-design:theme") === "drakoncman") document.documentElement.setAttribute("data-theme", "drakoncman");
} catch {
	// Storage blocked or unavailable: Neutral.
}
