import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// This manifest is the public dependency contract consumed by package managers.
test("routing activation requires no native ownership dependency", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.dependencies["fs-native-extensions"], undefined);
	assert.equal(manifest.dependencies["@heyhuynhgiabuu/pi-pretty"], "0.6.27", "unrelated dependency remains pinned");
});
