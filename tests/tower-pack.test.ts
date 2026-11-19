import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const towerDir = join(root, "web", "tower");
const distDir = join(towerDir, "dist");

// Regression for https://github.com/Gentleman-Programming/gentle-shell/pull/3332#issuecomment-7009056293
// and https://github.com/Gentleman-Programming/gentle-shell/issues/3378:
// web/tower/.gitignore lists dist/, and npm applies nested ignore files even
// when package.json `files` whitelists web/tower/dist/. Without a nested
// .npmignore, `pnpm pack`/`npm pack` succeeds but the tarball has zero entries
// under package/web/, so `gentle-shell tower` fails on install.
test("the packed tarball includes the built Tower web app, not just the on-disk build", async () => {
	const npmignore = join(towerDir, ".npmignore");
	assert.ok(existsSync(npmignore), "web/tower/.npmignore must exist so pack does not honor web/tower/.gitignore");
	const rules = readFileSync(npmignore, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
	assert.ok(rules.includes("node_modules/"), "web/tower/.npmignore must keep node_modules/ out of the package");
	assert.ok(!rules.some((rule) => rule.includes("dist")), "web/tower/.npmignore must not ignore dist/");

	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.ok(Array.isArray(manifest.files) && manifest.files.includes("web/tower/dist/"), "package.json files must whitelist web/tower/dist/");

	// Build a minimal dist in place (gitignored) so the pack file list can be
	// inspected without running the real `build:tower`. Restored afterwards.
	const indexHtml = "<!doctype html><html><head><script type=\"module\" src=\"./assets/index-regression.js\"></script></head><body></body></html>\n";
	const assetJs = "console.log(\"tower-regression\");\n";
	const hadDist = existsSync(join(distDir, "index.html"));
	const hadAsset = existsSync(join(distDir, "assets", "index-regression.js"));
	let previousIndex = null;
	let previousAsset = null;
	if (hadDist) previousIndex = readFileSync(join(distDir, "index.html"), "utf8");
	if (hadAsset) previousAsset = readFileSync(join(distDir, "assets", "index-regression.js"), "utf8");
	mkdirSync(join(distDir, "assets"), { recursive: true });
	writeFileSync(join(distDir, "index.html"), indexHtml);
	writeFileSync(join(distDir, "assets", "index-regression.js"), assetJs);
	try {
		const output = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		const parsed = JSON.parse(output);
		const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
		const paths = new Set(entry.files.map((file) => file.path));
		assert.ok(paths.has("web/tower/dist/index.html"), "packed tarball must contain web/tower/dist/index.html even though web/tower/.gitignore lists dist/");
		// The referenced JS must ship too: serving index.html alone still leaves Tower broken.
		assert.ok(paths.has("web/tower/dist/assets/index-regression.js"), "packed tarball must contain the JS referenced by web/tower/dist/index.html");
	} finally {
		if (previousIndex === null) rmSync(join(distDir, "index.html"), { force: true });
		else writeFileSync(join(distDir, "index.html"), previousIndex);
		if (previousAsset === null) rmSync(join(distDir, "assets", "index-regression.js"), { force: true });
		else writeFileSync(join(distDir, "assets", "index-regression.js"), previousAsset);
		try {
			if (!hadDist && !hadAsset) rmSync(distDir, { recursive: true, force: true });
		} catch {}
	}
});
