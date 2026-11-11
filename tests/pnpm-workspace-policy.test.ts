import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Owner decision (2026-11-11): Gentle Shell tracks Pi's latest release, so Pi's
// publisher scope is exempt from the release-age wait as a standing rule, not a
// per-version exception. Every other package still waits 72 hours.

const workspace = readFileSync(join(import.meta.dirname, "..", "pnpm-workspace.yaml"), "utf8");

// Every entry of a top-level YAML block list, up to the next top-level key. Comment
// and blank lines do not end the list; any other line inside it fails, so a form
// this scan does not understand can never hide an entry.
function listAfter(text: string, key: string): string[] {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line));
	assert.ok(start >= 0, `${key} must be a YAML block list`);
	const entries: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*(?:#.*)?$/.test(line)) continue;
		const entry = /^\s*-\s+(?:'([^']*)'|"([^"]*)"|([^\s#][^#]*?))\s*(?:#.*)?$/.exec(line);
		if (entry) {
			entries.push(entry[1] ?? entry[2] ?? entry[3]);
			continue;
		}
		assert.match(line, /^[^\s-]/, `unrecognized line inside ${key}: ${line}`);
		break;
	}
	return entries;
}

test("the list scan reads entries after comments, blank lines and quotes up to the next key", () => {
	const fixture = "minimumReleaseAgeExclude:\n  - '@earendil-works/*'\n  # a comment between entries\n\n  - openai\n- \"x\" # trailing\ntrustPolicy: no-downgrade\n  - not-in-the-list\n";
	assert.deepEqual(listAfter(fixture, "minimumReleaseAgeExclude"), ["@earendil-works/*", "openai", "x"]);
	assert.deepEqual(listAfter("minimumReleaseAgeExclude:\n  - a\n  # comment\n  - b\n", "minimumReleaseAgeExclude"), ["a", "b"]);
	assert.throws(() => listAfter("minimumReleaseAgeExclude:\n  - a\n  b: 1\n", "minimumReleaseAgeExclude"), /unrecognized line/);
});

test("release age stays at 72 hours for every package", () => {
	assert.deepEqual([...workspace.matchAll(/^minimumReleaseAge:\s*(\S+)\s*$/gm)].map((match) => match[1]), ["4320"]);
	assert.doesNotMatch(workspace, /^minimumReleaseAgeStrict:/m);
});

test("only Pi's publisher scope is exempt, for every version", () => {
	assert.deepEqual(listAfter(workspace, "minimumReleaseAgeExclude"), ["@earendil-works/*"]);
});
