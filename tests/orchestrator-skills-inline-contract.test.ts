import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const readAsset = (name: string) => readFileSync(join(import.meta.dirname, "..", "assets", name), "utf8");
const skills = readAsset("orchestrator-skills.md");
const parentExecution = (skills.split(/^### Parent execution\s*$/m)[1] ?? "")
	.split(/^#{1,6} /m)[0].replace(/\s+/g, " ");

// Pin the instructions the parent receives, not the output of a scripted model.
test("the parent is routed to read the exact indexed skill before acting", () => {
	assert.match(readAsset("orchestrator.md"), /inline\/fallbacks: `orchestrator-skills\.md`/);
	assert.match(parentExecution, /read the exact indexed `SKILL\.md` in this session before acting/);
});

test("the parent follows the skill's output contract only after reading it", () => {
	assert.match(parentExecution, /let the skill's declared `## Output Contract` shape the result, so the reply carries the same contract markers applying the skill directly would produce/);
	assert.match(parentExecution, /Never present contract markers without the in-session read/);
});

test("the parent proceeds unskilled on an unreadable path and adds no attribution line", () => {
	assert.match(parentExecution, /If the indexed path is unreadable, proceed unskilled/);
	assert.doesNotMatch(skills, /Skill (applied|unavailable) \(parent\)/);
	assert.doesNotMatch(parentExecution, /attribution/i);
});
