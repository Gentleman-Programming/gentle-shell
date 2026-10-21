import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// ---------------------------------------------------------------------------
// gentle-shell#348 — slice 2, contract layer.
//
// The `### Parent inline execution` paragraph in the lazy
// `assets/orchestrator-skills.md` is the narrowest execution boundary of the
// inline skill contract (design note: issues/348#issuecomment-5784664642).
// This test binds every obligation clause of the landed paragraph so no
// wording drift can silently weaken it: each required clause is asserted, the
// section must stay free of delegation-scope tokens and absolute-path
// phrasing, and a negative control per clause proves the assertion function
// rejects mutated copies.
// ---------------------------------------------------------------------------

const repoRoot = join(import.meta.dirname, "..");
const asset = readFileSync(join(repoRoot, "assets", "orchestrator-skills.md"), "utf8");

const SECTION_HEADING = "### Parent inline execution";

// Extracts the `### Parent inline execution` section: from its heading to the
// next markdown heading (any level) or EOF, whichever comes first.
function extractParentInlineExecutionSection(source: string): string {
	const start = source.indexOf(SECTION_HEADING);
	assert.ok(start >= 0, "the skills asset must carry a `### Parent inline execution` section");
	const remainder = source.slice(start + SECTION_HEADING.length);
	const nextHeading = /^#{1,6} .*/m.exec(remainder);
	return remainder.slice(0, nextHeading === null ? remainder.length : nextHeading.index);
}

// Requires every obligation clause of the landed paragraph, and forbids the
// delegation-scope vocabulary and absolute-path phrasing the design note
// keeps out of the inline boundary.
function assertInlineExecutionContract(section: string): void {
	assert.match(section, /read the exact indexed `SKILL\.md` in this session/);
	assert.match(section, /let the skill's declared `## Output Contract` shape the result/);
	assert.match(section, /same contract markers applying the skill directly would\s+produce/);
	assert.match(section, /`Skill applied \(inline\): <name>`/);
	assert.match(section, /proceed unskilled/);
	assert.match(section, /Never present contract markers/);
	assert.match(section, /name only, never paths/);

	assert.doesNotMatch(section, /paths-injected|paths-invalid|fallback-/);
	assert.doesNotMatch(section, /\/home\//);
	assert.doesNotMatch(section, /~\/\.pi/);
}

test("the landed parent-inline execution paragraph carries the full inline skill contract", () => {
	const section = extractParentInlineExecutionSection(asset);
	assertInlineExecutionContract(section);
});

test("every obligation clause is bound: mutating it makes the contract assertion throw", () => {
	const section = extractParentInlineExecutionSection(asset);
	const clauseMutations: ReadonlyArray<{ label: string; mutated: string }> = [
		{
			label: "in-session read of the exact indexed SKILL.md",
			mutated: section.replace(
				/read the exact indexed `SKILL\.md` in this session/,
				"read the skill whenever convenient",
			),
		},
		{
			label: "declared ## Output Contract shapes the result",
			mutated: section.replace(/shape the result/, "be ignored"),
		},
		{
			label: "same contract markers applying the skill directly would produce",
			mutated: section.replace(
				/same contract markers applying the skill directly would\s+produce/,
				"whatever markers the model improvises",
			),
		},
		{
			label: "attribution line format",
			mutated: section.replace(/`Skill applied \(inline\): <name>`/, "`some attribution`"),
		},
		{
			label: "unreadable-path fallback",
			mutated: section.replace(/proceed unskilled/, "improvise from the registry description"),
		},
		{
			label: "never present markers without the in-session read",
			mutated: section.replace(/Never present contract markers/, ""),
		},
		{
			label: "name-only attribution",
			mutated: section.replace(/name only, never paths/, "name and, when helpful, its path"),
		},
	];
	for (const { label, mutated } of clauseMutations) {
		assert.notEqual(mutated, section, `mutation must change the section: ${label}`);
		assert.throws(() => assertInlineExecutionContract(mutated), undefined, label);
	}
});

test("the inline boundary stays free of delegation-scope tokens and absolute paths", () => {
	const section = extractParentInlineExecutionSection(asset);
	const forbiddenAdditions: ReadonlyArray<{ label: string; mutated: string }> = [
		{
			label: "delegation skill_resolution token",
			mutated: `${section}\nReported as skill_resolution: paths-injected.`,
		},
		{
			label: "absolute home path phrasing",
			mutated: `${section}\nRead it from /home/dev/.pi/skills/probe/SKILL.md.`,
		},
		{
			label: "tilde agent-dir path phrasing",
			mutated: `${section}\nRead it from ~/.pi/skills/probe/SKILL.md.`,
		},
	];
	for (const { label, mutated } of forbiddenAdditions) {
		assert.throws(() => assertInlineExecutionContract(mutated), undefined, label);
	}
});
