// The canvas theme, before the first frame: a classic script loaded synchronously in index.html's <head>
// (the canvas CSP allows no inline script), so a saved Gentleman never shows Neutral for a frame on reload.
// The same rule as canvas-theme.js's storedTheme(): only an exact "gentleman" under gentle-design:theme sets
// data-theme; anything else, or any error, leaves :root's Neutral. canvas-theme.js (startTheme) then applies
// the saved theme again and keeps it in the store: it stays the source of truth.
try {
	if (localStorage.getItem("gentle-design:theme") === "gentleman") document.documentElement.setAttribute("data-theme", "gentleman");
} catch {
	// Storage blocked or unavailable: Neutral.
}
