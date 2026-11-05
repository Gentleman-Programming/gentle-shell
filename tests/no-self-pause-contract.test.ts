import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// gentle-shell#1731 T13 (evidence L24): in bench task x4 the user wrote "I may
// stop you between the two and pick the second part up later"; every Gentle
// cell delivered only the first part and paused by itself. Hedged delivery
// wording asks for resumable notes and separate commits, never a stop, and
// the close step must not leave tracked tasks pending without a user stop.

const REPO_ROOT = join(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

const tracking = read("assets/orchestrator-tracking.md");
const core = read("assets/orchestrator.md");

const contextualApproval = 'Interpret short replies such as "yes", "go ahead", or "eso mismo" against the immediately preceding proposal. When the human unambiguously accepts a concrete implementation action they already understand, execute that action within its agreed scope without asking again. Confirming a preference alone does not authorize implementation; genuinely unclear change intent still requires one focused question. Contextual approval never substitutes for provider-owned consent, exact-token authorization, or separate publishing and destructive-action permission.';
const informedClarification = 'Clarify scope, constraints, acceptance criteria, and non-goals when needed for the human to understand the action or to resolve consequential uncertainty. Reuse what is already established; after informed approval, proceed without repeating the clarification unless new consequential uncertainty appears.';

test("contextual approval continues the agreed action without weakening consent boundaries", () => {
	assert.ok(__testing.buildGentlePrompt("gentleman").includes(contextualApproval));
});

test("clarification preserves understanding without reopening informed approval", () => {
	assert.ok(__testing.buildGentlePrompt("gentleman").includes(informedClarification));
	assert.ok(read("skills/gentle-ai/SKILL.md").includes(informedClarification));
});

test("resolved subdecisions retain the original authorized objective", () => {
	const prompt = __testing.buildGentlePrompt("gentleman");
	assert.ok(prompt.includes("Resolving an incident or subdecision does not complete or cancel the original authorized objective; resume safe, necessary in-scope steps automatically, using judgment for proportionate recovery and respecting explicit user dispositions. Investigate pending technical uncertainty rather than treating it alone as a new human decision."));
	assert.ok(prompt.includes("Stop only for an unresolved consequential scope/product decision, required explicit consent, a denied action, unavailable required proof, or the human's explicit stop."));
	assert.ok(prompt.includes("Do not infer permission for publishing, destructive actions, unrelated scope or native consent from this continuity rule."));
});

function authorizationSection(): string {
	const start = tracking.indexOf("#### Authorization and progress");
	assert.ok(start !== -1, "tracking module must keep its Authorization and progress section");
	const next = tracking.indexOf("\n#### ", start + 1);
	return tracking.slice(start, next === -1 ? undefined : next);
}

test("T13: conditional change intent is narrowed to whether a change is authorized at all", () => {
	const section = authorizationSection();
	assert.ok(
		section.includes(
			"Ambiguous or conditional change intent (unclear whether a change is authorized at all) requires one clarification; stop and wait.",
		),
		"the clarification clause must be scoped to authorization itself",
	);
	assert.ok(
		!section.includes("Ambiguous or conditional change intent requires one clarification"),
		"the unscoped clarification clause must be gone",
	);
});

test("T13: hedged delivery wording asks for resumable notes and separate commits, not a stop", () => {
	const section = authorizationSection();
	for (const clause of [
		"Hedged delivery wording (the user may stop you, review commits one at a time, or pick the work up later)",
		"asks for resumable notes and separate commits, not a stop",
		"complete every authorized task in the current turn unless the user explicitly says to wait",
	]) {
		assert.ok(section.includes(clause), `tracking module is missing: ${clause}`);
	}
	const hedge = section.slice(section.indexOf("Hedged delivery wording"));
	const sentence = hedge.slice(0, hedge.indexOf(". ") + 1);
	assert.doesNotMatch(sentence, /\bask (?:one|a|the user)\b|question/i, "the hedge rule must not add a product or design question");
});

test("T13: the Close gate requires continuing or quoting the user's explicit stop", () => {
	const section = authorizationSection();
	assert.ok(
		section.includes(
			"Close gate: before the final answer, if any tracked task in the feature document or `todo` is still pending, continue it or quote the exact user sentence that orders the stop.",
		),
		"tracking module must carry the Close gate",
	);
});

test("T13: budgets hold and the pinned human-control line is untouched", () => {
	const bytes = Buffer.byteLength(tracking, "utf8");
	// S14: close the open slice before a high-risk commit; outcomes per commit (12,600 -> 12,850 B), same as MODULE_BUDGETS.
	assert.ok(bytes <= 12_850, `orchestrator-tracking.md is ${bytes} B, over its 12,850 B budget`);
	assert.ok(core.includes("- Preserve human control: user decisions beat agent momentum."), "core human-control line must stay verbatim");
	assert.ok(core.includes("4. **Track**") && core.includes("`orchestrator-tracking.md`"), "Track must still load the tracking module");
});

test("T13: the always-on harness narrows conditional intent and gates Close on pending tasks", () => {
	// The harness ODD steps are injected on every request, including the small
	// path that never loads the tracking module, so the narrowing must live there too.
	// They are rendered from the mirrored routing/pi.md, so check the rendered harness.
	const harness = __testing.buildGentlePrompt("gentleman");
	assert.ok(
		harness.includes("Ambiguous or conditional change intent (unclear whether a change is authorized at all) gets one clarification; stop and wait."),
		"harness Authorize step must narrow conditional intent",
	);
	assert.ok(!harness.includes("Ambiguous or conditional change intent gets one clarification"), "the broad harness wording must be gone");
	assert.ok(
		harness.includes("A user saying they may stop you or resume later asks for notes and separate commits, not a stop."),
		"harness must say hedged delivery wording is not a stop",
	);
	assert.ok(
		harness.includes("Never end with a tracked task pending unless you quote the user's explicit stop."),
		"harness Close step must gate pending tracked tasks",
	);
});
