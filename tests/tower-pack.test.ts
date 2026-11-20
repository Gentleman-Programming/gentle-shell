import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { builtWebPaths, packedFileList } from "../scripts/verify-package-files.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const towerDir = join(root, "web", "tower");

// Regression for https://github.com/Gentleman-Programming/gentle-shell/issues/3378
// (and gentle-ai#6173): web/tower/.gitignore lists dist/, and npm applies nested
// ignore files even when package.json `files` whitelists web/tower/dist/. Without
// a nested .npmignore, pack succeeds but ships zero entries under web/tower/dist,
// so `gentle-shell tower` fails on install. The pack runs in a scratch copy, never
// in this checkout, so no other test can observe a fake web/tower/dist.
function scratchPackage({ withNpmignore }: { withNpmignore: boolean }): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-pi-tower-pack-"));
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version, files: manifest.files }));
	const tower = join(dir, "web", "tower");
	mkdirSync(join(tower, "dist", "assets"), { recursive: true });
	copyFileSync(join(towerDir, ".gitignore"), join(tower, ".gitignore"));
	if (withNpmignore) copyFileSync(join(towerDir, ".npmignore"), join(tower, ".npmignore"));
	writeFileSync(join(tower, "dist", "index.html"), "<!doctype html><script type=\"module\" src=\"./assets/index.js\"></script>\n");
	writeFileSync(join(tower, "dist", "assets", "index.js"), "console.log(\"tower\");\n");
	mkdirSync(join(tower, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(tower, "node_modules", "dep", "index.js"), "\n");
	return dir;
}

test("the packed tarball ships the built Tower web app and its assets, never web/tower/node_modules", () => {
	const dir = scratchPackage({ withNpmignore: true });
	try {
		const packed = packedFileList(dir);
		for (const path of builtWebPaths) assert.ok(packed.has(path), `pack must contain ${path}`);
		assert.ok(packed.has("web/tower/dist/assets/index.js"), "pack must contain the JS index.html references");
		assert.ok(![...packed].some((path) => path.startsWith("web/tower/node_modules/")), "pack must not contain web/tower/node_modules");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the release guard sees what npm packs, not what is on disk: without web/tower/.npmignore dist is excluded", () => {
	const dir = scratchPackage({ withNpmignore: false });
	try {
		const packed = packedFileList(dir);
		assert.deepEqual(builtWebPaths.filter((path) => packed.has(path)), [], "web/tower/.gitignore alone must exclude dist from the pack list");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
