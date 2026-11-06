import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const skill = readFileSync(join(import.meta.dirname, "..", "skills/branch-pr/SKILL.md"), "utf8");

test("target-host reads require explicit destination, operation and credential/session authorization", () => {
	assert.match(skill, /explicit.*(?:destination|target).*operation.*credential\/session.*before.*target-host reads/i);
	assert.match(skill, /reuse fresh target-bound.*issue.*default branch.*type.*labels.*checks/i);
	assert.match(skill, /(?:do not|never).*ambient SSH/i);
});

test("issue linkage and protected labels retain human decisions without extra proof", () => {
	assert.match(skill, /human-selected.*closing.*nonclosing.*Refs/i);
	assert.match(skill, /protected labels.*exact direct instruction.*MAINTAIN\/ADMIN/i);
	assert.match(skill, /human-selected.*size:exception.*rationale.*no separate instructor proof/i);
	assert.doesNotMatch(skill, /Every PR body MUST contain:[\s\S]*?```markdown\s*Closes #<issue-number>/i);
});

test("oversized single PR does not impose Gentle size labels on generic users", () => {
	assert.match(skill, /size:exception.*Gentle-owned.*not.*universal/i);
	assert.match(skill, /destination repository's documented contribution\/size policy/i);
	assert.match(skill, /only when.*policy.*size:exception/i);
	assert.match(skill, /(?:never|do not).*request.*(?:create|add).*label.*generic/i);
	assert.match(skill, /single-pr.*not.*(?:waive|bypass).*authorization/i);
});

test("required checks are target-policy based and actions are not automatic", () => {
	assert.match(skill, /REQUIRED CI.*target policy/i);
	assert.match(skill, /CodeRabbit.*optional.*unless required/i);
	assert.match(skill, /(?:do not|never).*automatically commit.*push.*open.*PR.*merge/i);
	assert.match(skill, /applicable test-first/i);
	assert.match(skill, /advisory 400/i);
	assert.doesNotMatch(skill, /\bSDD\b|OpenSpec|TUI Strict TDD/i);
});

test("template checklist reflects evidence rather than pre-checked assertions", () => {
	assert.match(skill, /(?:do not|never).*unverified `?\[x\]`?/i);
	assert.doesNotMatch(skill, /^- \[x\]/m);
	assert.match(skill, /shellcheck on modified scripts/i);
	assert.match(skill, /skills.*at least one agent/i);
});
