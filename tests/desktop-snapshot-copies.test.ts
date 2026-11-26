import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const MODS = join(dirname(fileURLToPath(import.meta.url)), "..", "herdr", "mods");

test("should ship the same snapshot.js in every Herdr mod", () => {
	const copies = readdirSync(MODS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(MODS, entry.name, "snapshot.js")))
		.map((entry) => entry.name)
		.sort();
	assert.ok(copies.includes("gentle-status"), "the canonical copy exists");
	assert.ok(copies.length > 1, "more than one copy ships");
	const canonical = readFileSync(join(MODS, "gentle-status", "snapshot.js"));
	for (const name of copies) {
		assert.ok(readFileSync(join(MODS, name, "snapshot.js")).equals(canonical), `${name}/snapshot.js is byte-identical to gentle-status/snapshot.js`);
	}
});
