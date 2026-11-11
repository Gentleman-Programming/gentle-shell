import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Owner decision (2026-11-11): Gentle Shell tracks Pi's latest release, so Pi's
// publisher scope is exempt from the release-age wait as a standing rule, not a
// per-version exception. Every other package still waits 72 hours.

const workspace = readFileSync(join(import.meta.dirname, "..", "pnpm-workspace.yaml"), "utf8");

function listAfter(key: string): string[] {
	const block = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.*\\n?)*)`, "m").exec(workspace);
	assert.ok(block, `${key} must be a YAML list`);
	return block[1].split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^-\s+/, "").replace(/^'(.*)'$/, "$1"));
}

test("release age stays at 72 hours for every package", () => {
	assert.deepEqual([...workspace.matchAll(/^minimumReleaseAge:\s*(\S+)\s*$/gm)].map((match) => match[1]), ["4320"]);
	assert.doesNotMatch(workspace, /^minimumReleaseAgeStrict:/m);
});

test("only Pi's publisher scope is exempt, for every version", () => {
	assert.deepEqual(listAfter("minimumReleaseAgeExclude"), ["@earendil-works/*"]);
});
