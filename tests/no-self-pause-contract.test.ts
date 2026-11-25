import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// gentle-shell#1731 T13 (evidence L24): in bench task x4 the user wrote "I may
// stop you between the two and pick the second part up later"; every Gentle
// cell delivered only the first part and paused by itself. Hedged delivery
// wording asks for resumable notes and separate commits, never a stop, and
// the Close step must not leave runnable authorized tasks pending.

const REPO_ROOT = join(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

const tracking = read("assets/orchestrator-tracking.md");
const core = read("assets/orchestrator.md");

const contextualApproval = 'Read short replies ("yes", "go ahead", "eso mismo") against the preceding proposal. Act within scope on clear, informed approval of a concrete change without asking again. Preference alone is not approval. Ask one focused question if change intent is unclear. Contextual approval never substitutes for provider-owned consent, exact-token authorization, or separate publishing and destructive-action permission.';
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
	assert.ok(prompt.includes("After resolving an incident or subdecision, automatically resume safe, necessary in-scope work on the original authorized objective. Recover proportionately and respect explicit user dispositions."));
	assert.ok(!prompt.includes("Investigate pending technical uncertainty"), "the canonical real-human-decision boundary owns that clause");
	assert.ok(prompt.includes("Only a real human decision, explicit user stop, denial, missing consent, exhausted limit, or failure without a permitted route stops only affected work."));
	assert.ok(prompt.includes("Continue independent authorized work; never abandon runnable work or present an unverified outcome as final."));
	assert.ok(prompt.includes("Missing, partial, unavailable, or declined proof bars claiming completion of affected work, not independent authorized work or required authorized checks in budget."));
	// cost-speed-painpoints S15 P4: the verifier-setup rules load with the Verification rule, not on every turn.
	const verification = read("assets/orchestrator-verification.md");
	for (const sentence of [
		"After a setup prerequisite is repaired, the human may explicitly request one new bounded verification attempt.",
		"Never bypass consent, a denial, explicit one-run or no-retry limits, terminal native outcomes, or exhausted native budgets",
	]) {
		assert.ok(verification.includes(sentence), `verification module keeps: ${sentence}`);
		assert.ok(!prompt.includes(sentence), `always-on prompt no longer carries: ${sentence}`);
	}
	assert.ok(prompt.includes("Do not infer permission for publishing, destructive actions, unrelated scope or native consent."));
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

test("S3: the Close gate allows a pending tracked task only for a launched child, scoped denial/consent/exhaustion, or an open human decision", () => {
	const section = authorizationSection();
	for (const clause of [
		"continue every pending tracked task in the document or `todo` unless it waits on a launched child",
		"an already-decided denial, missing consent, or exhausted limit applies to that affected work",
		"the user stopped only that work",
		"or a genuine human decision is open",
		"Unrelated runnable authorized work continues",
	]) assert.ok(section.includes(clause), `tracking Close gate is missing: ${clause}`);
	assert.ok(!section.includes("tracked or untracked work alike"), "the unscoped stop exception must go");
	assert.ok(!section.includes("Needs your decision"), "tracking must not license a generic terminal phrase");
	assert.ok(!section.includes("also a valid stop"), "tracking must not keep the old terminal stop license");
});

test("T13: budgets hold and the pinned human-control line is untouched", () => {
	const bytes = Buffer.byteLength(tracking, "utf8");
	// S14: close the open slice before a high-risk commit; outcomes per commit (12,600 -> 12,850 B), same as MODULE_BUDGETS.
	// P5b: contradictions and step 3 / Phase reporting restatements removed; 1.4.0 commit-boundary rules kept (12,850 -> 10,324 B).
	// harness-continuity S3: the canonical Close owns the authorized-work boundary; the local gate now names only a launched
	// child, an explicit stop, or an open human decision, so the generic terminal license leaves the tracking module.
	assert.ok(bytes <= 10_308, `orchestrator-tracking.md is ${bytes} B, over its 10,308 B budget`);
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
		harness.includes("A tracked task ends the turn pending only for launched work still running, a real human decision, denial, missing consent, explicit stop, or exhausted limit."),
		"harness Close step must keep a legitimate pending child or scoped human decision",
	);
	assert.ok(harness.includes("Hedged wording is not a stop."), "harness Close step must keep hedged wording out of stops");
	assert.ok(!harness.includes("Never end with a tracked task pending unless you quote the user's explicit stop."), "the broad pending-task gate must go");
	assert.ok(!harness.includes("Needs your decision"), "the harness must not license a generic terminal phrase");
});
