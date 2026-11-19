import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DESIGN_CANVAS_ASSETS } from "../lib/design-canvas-assets.ts";

// The canvas asset allowlist is a security boundary (S2): one explicit list,
// checked against the folder in both directions.

const ASSET_DIR = fileURLToPath(new URL("../assets/design-canvas/", import.meta.url));

test("every listed canvas asset exists as a file", () => {
	for (const name of Object.keys(DESIGN_CANVAS_ASSETS)) {
		const path = join(ASSET_DIR, name);
		assert.ok(existsSync(path) && statSync(path).isFile(), `${name} exists`);
	}
});

test("every .js and .css file in the canvas folder is listed", () => {
	const onDisk = readdirSync(ASSET_DIR).filter((name) => [".js", ".css"].includes(extname(name)));
	assert.deepEqual(onDisk.sort(), Object.keys(DESIGN_CANVAS_ASSETS).sort());
});

test("the allowlist is frozen and names only flat .js and .css files with their content type", () => {
	assert.ok(Object.isFrozen(DESIGN_CANVAS_ASSETS));
	assert.ok(!Object.hasOwn(DESIGN_CANVAS_ASSETS, "index.html"), "the page template is not an asset");
	for (const [name, type] of Object.entries(DESIGN_CANVAS_ASSETS)) {
		assert.match(name, /^[a-z][a-z0-9-]*\.(?:js|css)$/, name);
		assert.equal(type, name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", name);
	}
});
