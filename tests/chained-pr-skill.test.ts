import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const skill = read("skills/chained-pr/SKILL.md");
const details = read("skills/chained-pr/references/chaining-details.md");

function assertDeliveryGate(text: string) {
	assert.match(text, /ask-on-risk.*(?:ask|prompt).*chain strategy/i);
	assert.match(text, /auto-chain.*(?:ask|prompt).*chain strategy.*(?:missing|not cached)/i);
	assert.match(text, /single-pr.*size:exception.*(?:no|never|do not) (?:ask|prompt).*chain strategy/i);
	assert.match(text, /exception-ok.*size:exception.*(?:no|never|do not) (?:ask|prompt).*chain strategy/i);
}

test("only chaining delivery strategies ask for a missing chain strategy", () => {
	assertDeliveryGate(skill);
	assert.throws(() => assertDeliveryGate(skill.replace(/single-pr.*size:exception.*(?:no|never|do not) (?:ask|prompt).*chain strategy/i, "single-pr asks for a chain strategy")));
});

function assertBases(text: string) {
	assert.match(text, /verify the target repository's default branch/i);
	assert.match(text, /stacked-to-main/);
	assert.match(text, /PR #1.*(?:base|target).*tracker branch/i);
	assert.match(text, /later (?:children|child PRs).*immediate parent branch/i);
	assert.doesNotMatch(text, /(?:from|to|on) `main`|^main(?:\s|$)/m);
}

test("uses verified default branch and tracker-first child bases", () => {
	assertBases(skill);
	assert.throws(() => assertBases(skill.replace(/PR #1.*(?:base|target).*tracker branch/i, "PR #1 targets the default branch")));
	assert.match(details, /verify the target repository's default branch/i);
	assert.match(details, /tracker PR to `<default branch>`/);
	assert.match(details, /PR #1.*target.*tracker branch/i);
	assert.match(details, /base each subsequent PR on its immediate parent/i);
	assert.doesNotMatch(details, /(?:from|to|on) `main`|^main(?:\s|$)/m);
});

function assertExplicitPrTarget(text: string) {
	const commands = text.slice(text.indexOf("## Commands"), text.indexOf("## Reviewer Guidance"));
	assert.match(commands, /explicit.*authorization.*(?:destination|repository).*operation.*credential\/session/is);
	assert.match(commands, /verified.*(?:target|repository)/i);
	const ghCommands = commands.match(/^gh pr (?:view|create).*$/gm) ?? [];
	assert.ok(ghCommands.length >= 3);
	for (const command of ghCommands) assert.match(command, /--repo "\$TARGET"/);
}

test("binds every chained PR example to an explicitly authorized verified repository", () => {
	assertExplicitPrTarget(details);
	assert.throws(() => assertExplicitPrTarget(details.replace(/--repo "\$TARGET"/, "")));
});

test("preserves ODD scope and bounded slicing without SDD guidance", () => {
	assert.match(skill, /ODD feature's forecast or running authored changed-line count/);
	assert.match(skill, /per-task advisory 400 authored-line heuristic does not itself require a PR split/);
	assert.match(skill, /one.*slicing pass/);
	assert.doesNotMatch(skill, /SDD|OpenSpec/i);
});
