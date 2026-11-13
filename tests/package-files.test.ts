import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DESIGN_CANVAS_ASSETS } from "../lib/design-canvas-assets.ts";
import { designCanvasAssetPaths, missingRequiredPaths, requiredPaths } from "../scripts/verify-package-files.mjs";

// The voice worker is spawned by path and never imported, so only the package
// check keeps it in the published tarball next to the modules that launch it.

const root = fileURLToPath(new URL("..", import.meta.url));

// prepack and prepublishOnly run the check with plain `node`, and Node 23.0-23.5
// (inside engines >=22.19.0) cannot load TypeScript without a flag.
test("the package check runs on a Node without TypeScript type stripping", async () => {
	const result = spawnSync(process.execPath, ["--no-experimental-strip-types", "scripts/verify-package-files.mjs"], { cwd: root, encoding: "utf8" });
	assert.equal(result.stderr, "");
	assert.equal(result.status, 0);
	assert.match(result.stdout, /^gentle-pi package resource check passed/);
	const runtime = await import("../runtime/design-canvas-assets.mjs");
	assert.deepEqual(runtime.DESIGN_CANVAS_ASSETS, DESIGN_CANVAS_ASSETS, "the generated module lists the same assets");
	assert.ok(requiredPaths.includes("runtime/design-canvas-assets.mjs"));
});

test("the package check requires the voice command, its modules and the worker script", () => {
	const voice = ["extensions/gentle-voice.ts", "lib/voice-command.ts", "lib/voice-session.ts", "lib/voice-ui.ts", "scripts/voice-worker.cjs", "docs/voice.md"];
	for (const path of voice) assert.ok(requiredPaths.includes(path), `${path} is required`);
	assert.deepEqual(missingRequiredPaths(root, voice), []);
});

// The canvas server reads its page and scripts from assets/ by path, never by import.
const designCanvas = [
	"lib/design-canvas-server.ts",
	"lib/design-canvas-assets.ts",
	"lib/design-open-browser.ts",
	"lib/design-comments.ts",
	"lib/design-handoffs.ts",
	"lib/design-system-tokens.ts",
	"assets/design-canvas/index.html",
	"assets/design-canvas/canvas.js",
	"assets/design-canvas/canvas.css",
	"assets/design-canvas/inspector.js",
];

// The design command names its skill file by path when Pi has not loaded it.
test("the package check requires the design command, its helpers and its skill", () => {
	const design = ["extensions/gentle-design.ts", "lib/gentle-design.ts", "lib/design-sources.ts", "skills/design/SKILL.md", ...designCanvas];
	for (const path of design) assert.ok(requiredPaths.includes(path), `${path} is required`);
	assert.deepEqual(missingRequiredPaths(root, design), []);
});

// The server's asset allowlist is the package's list of canvas files (S2).
test("the package check requires every canvas asset the server serves", () => {
	const assets = Object.keys(DESIGN_CANVAS_ASSETS).map((name) => `assets/design-canvas/${name}`);
	assert.deepEqual([...designCanvasAssetPaths], assets);
	for (const path of assets) assert.ok(requiredPaths.includes(path), `${path} is required`);
	assert.deepEqual(missingRequiredPaths(root, assets), []);
});
