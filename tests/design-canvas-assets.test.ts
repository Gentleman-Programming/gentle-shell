import assert from "node:assert/strict";
import test from "node:test";
import { DESIGN_CANVAS_ASSETS } from "../lib/design-canvas-assets.ts";
import { read } from "./support/design-canvas-dom.ts";

// Source pins over every canvas asset: each rule is read from the module that owns it.
// The behavior tests live next to their module, in tests/design-canvas-<module>.test.ts.

test("canvas assets keep the sandbox, the source check and no remote URLs", () => {
	assert.match(read("canvas-boards.js"), /frame\.setAttribute\("sandbox", "allow-scripts"\)/);
	assert.match(read("canvas-messages.js"), /candidate\.frame\.contentWindow === event\.source/);
	// Only the Compare preview of the running app (another loopback origin) may keep its own origin.
	const compare = read("canvas-compare.js");
	assert.equal(compare.split("allow-same-origin").length - 1, 1);
	assert.match(compare, /const PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";/);
	for (const name of ["index.html", ...Object.keys(DESIGN_CANVAS_ASSETS)]) {
		const source = read(name);
		assert.ok(!source.includes("allow-top-navigation"), `${name} must not grant top navigation`);
		if (name !== "canvas-compare.js") assert.ok(!source.includes("allow-same-origin"), `${name} must not grant allow-same-origin`);
		assert.ok(!/https?:\/\//i.test(source), `${name} must not reference remote URLs`);
		assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(source), `${name} must not parse HTML strings`);
	}
	const html = read("index.html");
	assert.match(html, /id="gd-back"[^>]*>Back to canvas</);
	assert.match(html, /id="gd-nav-mode"[^>]*>Navigating</);
});
