import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// gentle-shell#1731 T13 (evidence L24): in bench task x4 the user wrote "I may
// stop you between the two and pick the second part up later"; every Gentle
// cell delivered only the first part and paused by itself. Hedged delivery
// wording asks for resumable notes and separate commits, never a stop, and
// the close step must not leave tracked tasks pending without a user stop.

const REPO_ROOT = join(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

const tracking = read("assets/orchestrator-tracking.md");
const core = read("assets/orchestrator.md");

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
	assert.ok(bytes <= 12_600, `orchestrator-tracking.md is ${bytes} B, over its 12,600 B budget`);
	assert.ok(core.includes("- Preserve human control: user decisions beat agent momentum."), "core human-control line must stay verbatim");
	assert.ok(core.includes("4. **Track**") && core.includes("`orchestrator-tracking.md`"), "Track must still load the tracking module");
});

test("T13: the always-on harness narrows conditional intent and gates Close on pending tasks", () => {
	// The harness ODD steps are injected on every request, including the small
	// path that never loads the tracking module, so the narrowing must live there too.
	const harness = read("extensions/gentle-ai.ts");
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
