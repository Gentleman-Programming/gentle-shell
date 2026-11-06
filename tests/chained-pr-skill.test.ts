import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const skill = read("skills/chained-pr/SKILL.md");
const details = read("skills/chained-pr/references/chaining-details.md");
const workUnits = read("skills/work-unit-commits/SKILL.md");

function assertDeliveryGate(text: string) {
	assert.match(text, /ask-on-risk.*(?:ask|prompt).*chain strategy/i);
	assert.match(text, /auto-chain.*(?:ask|prompt).*chain strategy.*(?:missing|not cached)/i);
	assert.match(text, /single-pr.*destination.*policy.*(?:no|never|do not) (?:ask|prompt).*chain strategy/i);
	assert.match(text, /exception-ok.*accepted.*destination.*policy.*(?:no|never|do not) (?:ask|prompt).*chain strategy/i);
}

test("only chaining delivery strategies ask for a missing chain strategy", () => {
	assertDeliveryGate(skill);
	assert.throws(() => assertDeliveryGate(skill.replace(/single-pr.*destination.*policy.*(?:no|never|do not) (?:ask|prompt).*chain strategy/i, "single-pr asks for a chain strategy")));
});

function assertOversizedMenu(text: string) {
	const choices = [
		/1\. .*feature\/tracker.*feature-branch-chain/i,
		/2\. .*verified default\/main.*stacked-to-main/i,
		/3\. .*one single PR.*least recommended.*delivery_strategy=single-pr/i,
	];
	let previous = -1;
	for (const choice of choices) {
		const match = choice.exec(text);
		assert.ok(match, `missing menu choice: ${choice}`);
		assert.ok(match.index > previous, "delivery choices must retain their order");
		previous = match.index;
	}
	assert.match(text, /single-pr.*not a.*chain_strategy/i);
	assert.match(text, /overrides.*pending chaining path/i);
	assert.match(text, /clear.*chain choice.*suppress.*later chain prompts/i);
	assert.match(text, /not.*(?:automatically|silently).*exception-ok/i);
}

test("oversized menu has three ordered choices and single PR replaces chaining", () => {
	assertOversizedMenu(skill);
	assert.throws(() => assertOversizedMenu(skill.replace("delivery_strategy=single-pr", "chain_strategy=single-pr")));
	assert.match(details, /Feature\/tracker branch chain.*Default\/main branch chain.*One single PR/is);
});

test("delivery prompts localize all human-facing copy without translating tokens", () => {
	for (const text of [skill, details]) {
		assert.match(text, /complete.*question.*every option label.*description.*recommendation marker.*active user's conversation language/i);
		assert.match(text, /English.*English.*Spanish.*Spanish/i);
		assert.match(text, /(?:tokens|single-pr).*unchanged and untranslated/i);
		assert.match(text, /English examples.*illustrative.*localizable.*not mandatory copy/i);
	}
});

test("single PR avoids chain artifacts and least-recommended advice is scoped", () => {
	assert.match(skill, /least recommended.*only.*oversized menu/i);
	assert.match(skill, /≤400 changed lines and focused.*Keep single PR/);
	assert.match(skill, /single PR.*reviewer.*(?:rollback|feedback)/i);
	assert.match(skill, /single-pr.*no tracker.*dependency diagram.*Chain Context/i);
	assert.match(skill, /selection.*not authorize.*push.*PR creation.*merge.*review/is);
});

test("size exceptions follow destination policy, not a universal label gate", () => {
	for (const text of [skill, details, workUnits]) {
		assert.match(text, /size:exception.*Gentle-owned.*not.*universal/i);
		assert.match(text, /destination repository's documented contribution\/size policy/i);
		assert.match(text, /(?:never|do not).*request.*(?:create|add).*label.*generic/i);
	}
	assert.doesNotMatch(skill + workUnits, /require `size:exception` on over-budget|Require `size:exception` for an over-budget/i);
});

function assertSddWorkloadGuard(text: string) {
	const row = text.match(/^\| SDD workload guard \|.*$/m)?.[0] ?? "";
	assert.match(row, />400-line.*selected `delivery_strategy`/);
	assert.match(row, /chaining paths only.*group commits into chained PR slices before implementation/i);
	assert.match(row, /single-pr.*exception-ok.*keep one PR.*destination repository's documented contribution\/size policy/i);
}

test("critical SDD workload guard honors single-PR delivery without disabling chaining budgets", () => {
	assertSddWorkloadGuard(workUnits);
	assert.throws(() => assertSddWorkloadGuard(workUnits.replace("On chaining paths only", "For every delivery strategy")));
	assert.throws(() => assertSddWorkloadGuard(workUnits.replace("keep one PR", "force chained PRs")));
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
