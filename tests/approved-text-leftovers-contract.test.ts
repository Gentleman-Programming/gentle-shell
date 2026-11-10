import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// ---------------------------------------------------------------------------
// cost-speed-painpoints P14 (S15 P5, P7; L66): approved text verdicts that no
// merged PR carried. One test per ledger item; each asserts the rendered
// primary prompt or the shipped asset, and that the rule the text carries is
// still stated where the parent or the agent reads it.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");
const ASSETS = join(REPO_ROOT, "assets");
const MODES = ["organic", "full-delegation"] as const;
const PERSONAS = ["gentleman", "neutral"] as const;
const ACTIVE_TOOLS = ["read", "bash", "edit", "write", "subagent_run"] as const;
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

let scratch: string;
const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
before(() => {
	scratch = mkdtempSync(join(tmpdir(), "p14-leftovers-"));
	process.env.GENTLE_PI_CONFIG_HOME = join(scratch, "config");
});
after(() => {
	if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
	else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
	rmSync(scratch, { recursive: true, force: true });
});

function render(persona: (typeof PERSONAS)[number], mode: (typeof MODES)[number]): string {
	return __testing.buildGentlePrompt(persona, join(scratch, "project"), ACTIVE_TOOLS, undefined, undefined, mode);
}

function count(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function description(skill: string): string {
	const line = read(`skills/${skill}/SKILL.md`).split("\n").find((candidate) => candidate.startsWith("description: "));
	assert.ok(line, `${skill} has a one-line description`);
	return line;
}

test("PD-57: the gentleman Rioplatense rule renders once, in the persona bullet", () => {
	for (const mode of MODES) {
		const gentleman = render("gentleman", mode);
		assert.ok(!gentleman.includes("Language: natural Rioplatense"), `[${mode}] the duplicate Language line must go`);
		assert.equal(count(gentleman, "- When the user writes Spanish, answer in natural Rioplatense Spanish with voseo."), 1, `[${mode}] the persona bullet stays once`);
		const neutral = render("neutral", mode);
		assert.ok(!neutral.includes("Rioplatense Spanish with voseo"), `[${mode}] neutral never gets the Rioplatense rule`);
		assert.ok(neutral.includes("Do NOT use voseo or any regional conjugations"), `[${mode}] neutral register rule stays`);
	}
});

test("PD-81: every always-on and lazy statement of the evidence budget uses the runtime's lookup number", () => {
	const runtime = read("lib/exploration-budget.ts");
	const limit = /request\.lookups <= (\d+)/.exec(runtime)?.[1];
	assert.equal(limit, "3", "the runtime notifies after more than 3 tracked lookups");
	const organic = render("gentleman", "organic");
	assert.ok(organic.includes(`more than one read batch or >${limit} lookups`), "the rendered core states the runtime number");
	const fullDelegation = render("gentleman", "full-delegation");
	assert.ok(fullDelegation.includes(`or more than ${limit} lookups → one \`gentle-ai-explore\``), "the full-delegation Explore mechanism states the runtime number");
	for (const [label, text] of [
		["rendered organic prompt", organic],
		["rendered full-delegation prompt", fullDelegation],
		["orchestrator-delegation.md", read("assets/orchestrator-delegation.md")],
		["gentle-ai skill", read("skills/gentle-ai/SKILL.md")],
		["readme reference", read("docs/readme-reference.md")],
	] as const) {
		assert.ok(!text.includes("~5 sequential lookups"), `${label} must not keep the old ~5 number`);
	}
	assert.ok(read("assets/orchestrator-delegation.md").includes(`When understanding needs more or over ${limit} lookups, delegate one explorer`));
	assert.ok(read("skills/gentle-ai/SKILL.md").includes(`When understanding needs more reading or more than ${limit} lookups, delegate one explorer`));
	assert.ok(read("docs/readme-reference.md").includes(`or more than ${limit} lookups |`));
});

test("PD-74: skill-resolution fallback values are scoped to non-package agents", () => {
	const skills = read("assets/orchestrator-skills.md");
	const scope = "Among package subagents only `gentle-ai-worker` reports `skill_resolution`, as `paths-injected`, `paths-invalid` (blocked; the unreadable path is in `risks`), or `none`; the fallback values below come from non-package agents.";
	const leadIn = "If a subagent reports `skill_resolution`, interpret it as project/user skill resolution:";
	assert.equal(count(skills, scope), 1, "the worker-only scope is stated once");
	assert.ok(skills.includes("If no skill matches, continue without project skill injection and report `skill_resolution: none`."), "the parent's own step-4 report stays");
	assert.ok(skills.indexOf(scope) < skills.indexOf(leadIn), "the scope precedes the single lead-in");
	assert.ok(skills.includes(`${leadIn}\n\n- \`paths-injected\`:`), "one lead-in, directly followed by the value list");
	assert.ok(!skills.includes("other agents may report:"), "no second lead-in");
	assert.ok(read("assets/agents/gentle-ai-worker.md").includes("skill_resolution: paths-injected | paths-invalid | none"), "the worker contract still lists the same three values");
});

test("PD-42: the verifier-setup relaunch names its antecedent, keeping once and unasked", () => {
	const verification = read("assets/orchestrator-verification.md");
	assert.ok(verification.includes("needs no decision; if it made none, relaunch once with the corrected command, unasked."));
	assert.ok(!verification.includes("needs no decision; if none, relaunch"), "the ambiguous antecedent must go");
});

test("PD-71: trimmed skill descriptions keep every trigger phrase and their purpose", () => {
	const expected: Record<string, { max: number; keep: readonly string[] }> = {
		design: { max: 184, keep: ["design a screen or page", "mockup", "landing page", "UI directions", "artboards", "try a different approach", "design system sync", "HTML design directions", "design/<slug>/"] },
		"tui-design": { max: 175, keep: ["terminal UI design", "TUI redesign", "Gentle Shell look", "IDE in a terminal", "sidebar/status bar polish", "critique TUI", "visual proof"] },
		"gentle-ai": { max: 170, keep: ["Gentle AI harness discipline", "Pi work", "clarify first", "ODD", "test-first", "delegate when useful", "review workload"] },
		"work-unit-commits": { max: 127, keep: ["Trigger: commit splitting", "chained PRs", "keeping tests and docs with code", "Plan commits as reviewable work units."] },
	};
	for (const [skill, { max, keep }] of Object.entries(expected)) {
		const line = description(skill);
		assert.ok(Buffer.byteLength(line, "utf8") <= max, `${skill} description is ${Buffer.byteLength(line, "utf8")} B, over ${max} B`);
		for (const phrase of keep) assert.ok(line.includes(phrase), `${skill} description lost "${phrase}"`);
	}
});

test("PD-78: the skill-creation prompt defers its steps to skill-creator and keeps the report", () => {
	const prompt = read("prompts/skill-creation.md");
	const skill = read("skills/skill-creator/SKILL.md");
	assert.ok(prompt.includes("Use the `gentle-ai-skill-creator` skill if it is available."));
	assert.ok(prompt.includes("before editing. If neither the skill nor that `SKILL.md` is available, say so and stop."), "the no-skill fallback follows the sentence that names the skill and its file");
	assert.ok(prompt.includes("Clarify the reusable behavior, target runtime, trigger phrases, and non-goals if they are not obvious"), "the clarify step is not in the skill, so it stays");
	assert.ok(prompt.includes("Return the files changed, the selected trigger phrases, any supporting files, and whether registry/package verification remains to run."));
	assert.ok(!prompt.includes("## Process"), "the restated steps must go");
	for (const step of [
		"2. Inspect existing skills and confirm the new skill does not duplicate one.",
		"| Existing skill covers it | Update the existing skill instead |",
		"3. Choose a kebab-case skill name that matches the user-facing trigger.",
		"Frontmatter `description` must be one physical YAML-safe line",
		"Put templates, schemas, and generated examples in `assets/`.",
		"Put longer rationale or local doc links in `references/`.",
		"7. If this is a packaged `gentle-pi` skill, add it to `scripts/verify-package-files.mjs`.",
		"refresh the registry with `/skill-registry:refresh` when available.",
	]) assert.ok(skill.includes(step), `skill-creator must carry the removed step: ${step}`);
});

test("PR #3111 review: the design skill names the codemode form of both design tools", () => {
	const skill = read("skills/design/SKILL.md");
	assert.equal(count(skill, "When `gentle_design` or `gentle_design_comments` is not declared, call it from `codemode` as `tools.gentle_design({...})` or `tools.gentle_design_comments({...})` with the same arguments."), 1);
});
