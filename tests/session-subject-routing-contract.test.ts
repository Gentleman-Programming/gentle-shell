import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const source = readFileSync(join(root, "extensions/gentle-agents.ts"), "utf8");
const match = source.match(/name: "orchestrator_session_id",\s*label: "[^"]+",\s*description: ("(?:[^"\\]|\\.)*")/);
assert.ok(match, "Registered session tool must expose a public description");
const description: string = JSON.parse(match[1]);
const detail = readFileSync(join(root, "assets/orchestrator-delegation.md"), "utf8")
	.split("## Session subject and display identity\n")[1].split("### Publish and find classified work")[0];
const docs = readFileSync(join(root, "docs/gentle-agents-activity.md"), "utf8")
	.split("### Declare a recognizable subject\n")[1].split("### Publish curated state")[0];

// The changed behavior is model-facing metadata/guidance, not a new runtime guard.
test("session declaration guidance exempts small direct tasks in every public surface", () => {
	for (const [name, text] of [["tool description", description], ["coordination policy", detail], ["user docs", docs]]) {
		assert.match(text, /Do not require a subject declaration for small direct tasks/, name);
		assert.match(text, /before delegation or cross-session coordination/i, name);
		assert.doesNotMatch(text, /When starting a task or delegation/, name);
	}
});

test("existing coordination identity and privacy guidance remains intact", () => {
	assert.match(description, /Names never authenticate/);
	assert.match(description, /Existing Pi names and human renames are preserved/);
	assert.match(description, /Never include credentials, internal instructions, or raw prompts/);
	assert.match(detail, /short, non-sensitive `subject`/);
	assert.match(detail, /Batch with setup if possible; no extra model call/);
	assert.match(detail, /Names display only; stable IDs route/);
	assert.match(docs, /preserving existing names\s+and later human renames/);
	assert.match(docs, /Aliases are display hints, never authentication or routing identities/);
});
