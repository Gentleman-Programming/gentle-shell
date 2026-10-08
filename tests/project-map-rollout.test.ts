import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("every Project Map surface on disk is pinned in the pack list", () => {
	// This guard stays until the parent removes orphan files and updates requiredPaths.
	const script = readFileSync(join(import.meta.dirname, "..", "scripts", "verify-package-files.mjs"), "utf8");
	const pinned = new Set([...script.matchAll(/"((?:lib\/(?:project-map|shell-project-map)[^"]+|extensions\/gentle-project-map)\.ts)"/g)].map((match) => match[1]!));
	const onDisk = [
		...readdirSync(join(import.meta.dirname, "..", "lib")).filter((name) => /^(project-map|shell-project-map).*\.ts$/.test(name)).map((name) => `lib/${name}`),
		"extensions/gentle-project-map.ts",
	];
	const unpinned = onDisk.filter((path) => !pinned.has(path)).sort();
	assert.deepEqual(unpinned, [], "every surface is pinned by name in requiredPaths");
	assert.equal(pinned.size, onDisk.length, "and the pack list pins no surface that does not exist");
});
