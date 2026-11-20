import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// #3378: the release guard must fail on what npm packs, not on what is on disk.
// Runs against a scratch copy of the package without web/tower/.npmignore.
test("--with-built-web exits 1 naming web/tower/dist/index.html when npm pack excludes it", () => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-pi-built-web-guard-"));
	try {
		cpSync(root, dir, {
			recursive: true,
			filter: (source) => {
				const rel = relative(root, source).split(sep).join("/");
				const top = rel.split("/")[0];
				return top !== ".git" && top !== ".worktrees" && !rel.split("/").includes("node_modules")
					&& rel !== "web/tower/.npmignore" && rel !== "web/tower/dist" && !rel.startsWith("web/tower/dist/");
			},
		});
		mkdirSync(join(dir, "web", "tower", "dist"), { recursive: true });
		writeFileSync(join(dir, "web", "tower", "dist", "index.html"), "<!doctype html>\n");
		const result = spawnSync(process.execPath, ["scripts/verify-package-files.mjs", "--with-built-web"], { cwd: dir, encoding: "utf8" });
		assert.equal(result.status, 1, result.stderr);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /npm pack excludes them:\n- web\/tower\/dist\/index\.html\n/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
