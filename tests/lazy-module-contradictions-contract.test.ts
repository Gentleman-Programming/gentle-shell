import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// cost-speed-painpoints S15 P5b: each audited contradiction in the lazy orchestrator
// modules is resolved in the direction T12 decided (L36). Every test checks both
// sides: the wrong text is gone, and the rule that wins is still stated where the
// verdict says it lives.
const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const tracking = read("assets/orchestrator-tracking.md");
const delegation = read("assets/orchestrator-delegation.md");
const writer = read("assets/orchestrator-writer.md");
const reference = read("assets/orchestrator-delegation-reference.md");
const card = read("assets/orchestrator-full-delegation-card.md");
const worker = read("assets/agents/gentle-ai-worker.md");
const explorer = read("assets/agents/gentle-ai-explore.md");
const prompts = (["gentleman", "neutral"] as const).map((persona) => __testing.buildGentlePrompt(persona));

test("C3: tracking drops the test-first restatement; the always-on rule adds no other cases", () => {
	assert.ok(!tracking.includes("relevant alternate cases"), "tracking still asks for alternate cases");
	assert.ok(!tracking.includes("observe RED before implementation"), "tracking still restates the test-first cycle");
	for (const prompt of prompts) {
		assert.ok(prompt.includes("add one test proving its previous behavior still holds; add no other cases."), "the always-on test-first rule is missing");
		assert.ok(!prompt.includes("relevant alternate cases"));
	}
	assert.ok(
		tracking.includes("forward this policy, the applicable exact runner and commands (when available), and any exception rationale on every implementation delegation"),
		"tracking must keep forwarding the policy to writers",
	);
	assert.ok(tracking.includes("record observed evidence or the reason for fallback in the feature document"), "tracking must keep recording the evidence");
});

test("C5: tracking drops what restated the injected review contract and keeps the commit-boundary rules", () => {
	for (const stale of [
		"Medium: defer to the PR slice",
		'`gentle_review` `{"operation":"start"}`',
		"start native review",
		"review at slice close",
		"deferred to slice",
		"native review runs only on grant",
	]) {
		assert.ok(!tracking.includes(stale), `tracking still restates the injected review contract: ${stale}`);
	}
	assert.ok(tracking.includes("When RDD is enabled, the injected Gentle AI review execution contract governs how a native review starts, runs, and gets consent; this module adds only the assessment and commit-boundary rules below."), "tracking must defer start, run, and consent to the injected contract");
	// Current 1.4.0 boundary rules, mirrored from routing/pi.md; the rendered prompt carries them nowhere else.
	for (const rule of [
		"A not-due `passive` commit needs no review and the boundary advances; `under_budget` stays pending in the slice until a later commit reaches the budget.",
		"When a high-risk unit follows pending `under_budget` commits, close the open slice first, assessing and reviewing it as the slice, so the high-risk commit is then reviewed alone against the new boundary.",
		"An unavailable or failed assessment never lowers the tier: treat the commit as due; never infer low risk from a failed assessment.",
	]) {
		assert.ok(tracking.includes(rule), `tracking lost a commit-boundary rule: ${rule}`);
	}
	assert.ok(tracking.includes('after each work-unit commit, assess it with `gentle_review` `{"operation":"assess"}` and `{"baseRef":"<last reviewed boundary>","committedOnly":true}`'));
	assert.match(tracking, /assess `escalate` field \(`orchestrator-verification\.md`\); never lower one/);
	assert.ok(tracking.includes("When RDD is disabled, do not start or prompt for RDD; ordinary checks remain."));
	// The rule that a high-risk unit is reviewed alone lives in always-on step 6.
	for (const prompt of prompts) {
		assert.ok(prompt.includes("a unit whose Risk line names a high-risk item gets its own commit so native review can take it alone"));
	}
});

test("X2: the dead Delivery strategy pointer section is gone; push and merge stay the user's decisions", () => {
	assert.ok(!tracking.includes("## Delivery strategy"), "the dead section is still there");
	assert.ok(!tracking.includes("under Checks and candidate consent above"));
	assert.ok(tracking.includes("Delivery follows work units."), "the delivery paragraph itself must stay");
	for (const prompt of prompts) {
		assert.ok(prompt.includes("push, pull request creation, and merge remain the user's decisions"));
	}
});

test("Duplicates: tracking keeps no restatement of step 3 or of the Phase reporting line", () => {
	for (const restated of [
		"Recommend optional research only for a named uncertainty",
		"ask one focused user question only for a real unresolved product decision",
		"Use at most one scoped independent read-only assumption challenge",
		"inferred automatically from the primary session's tool activity",
		"never per tool call, per thought, or on a fixed cadence",
	]) {
		assert.ok(!tracking.includes(restated), `tracking still restates an always-on rule: ${restated}`);
	}
	for (const prompt of prompts) {
		assert.ok(prompt.includes("Recommend optional research only for a named uncertainty; ask one focused user question only for a real unresolved product decision, then stop and wait; use at most one scoped read-only assumption challenge for a high-consequence unproven premise."));
		assert.ok(prompt.includes("call `gentle_odd_phase` only when the primary session's ODD phase actually changes, never per tool call or on a fixed cadence, and never from a subagent"));
	}
	// The rules step 3 does not carry stay in tracking.
	for (const kept of [
		"no fixed questionnaire or mandatory rounds",
		"workers return gaps to the parent",
		"prefer primary sources",
		"Forward these research instructions to an existing fresh general exploration/research worker",
		"The step 3 assumption challenge is independent and allowed even in a small security-critical change",
		"do not start a debate loop",
		"Deterministic failures need fixes, not model debate",
		"never duplicate or bypass it with this challenge",
		"Call `gentle_odd_phase` with `clear` only to leave the current phase before its turn ends.",
	]) {
		assert.ok(tracking.includes(kept), `tracking lost a rule step 3 or Phase reporting does not carry: ${kept}`);
	}
});

test("C4: the explorer may get web and MCP work its declared tools do, never shell work", () => {
	for (const text of [delegation, card]) {
		assert.ok(!text.includes("shell, HTTP or MCP work"), "the card still forbids HTTP or MCP work to the explorer");
		assert.ok(text.includes("never give a read-only explorer shell work"), "the shell restriction must stay");
		assert.ok(text.includes("Check the agent's declared `tools` in `subagent_list_agents` before launching"));
	}
	assert.match(explorer, /^ {2}- web_search$/m, "the explorer declares web tools");
	assert.match(explorer, /^ {2}- mcp__codegraph__codegraph_explore$/m, "the explorer declares an MCP tool");
	assert.doesNotMatch(explorer, /^ {2}- bash$/m, "the explorer declares no shell");
});

test("C11: the writer card omits `mode` like every other launch rule", () => {
	assert.ok(!writer.includes('mode: "background"'), "the writer card still passes an explicit background mode");
	const parallel = writer.split("\n").find((line) => line.startsWith("- **Parallelism**")) ?? "";
	assert.ok(parallel.includes("launch every independent unit in the same turn via `subagent_run` without `mode`"));
	assert.ok(delegation.includes("omit `mode`"));
	assert.ok(reference.includes("so omit `mode` for ordinary delegation"));
});

test("C14: the reference points at the worker's Known environmental failures definition without restating it", () => {
	assert.ok(!reference.includes("exact pre-existing base failures reported as evidence, never blockers"), "the reference restates the definition");
	assert.ok(reference.includes("`## Known environmental failures`: `gentle-ai-worker`'s Verification contract."));
	assert.ok(worker.includes("this is the canonical definition; other assets reference it, they do not restate it"));
	assert.ok(worker.includes("Any OTHER required command that fails -- one not named under that heading -- still forces `status: partial`."));
});

test("X4: the reference names only agents and options that exist, and no delegate-by-default rule", () => {
	for (const ghost of ["`scout`", "scout maps", "`context-builder`", "`oracle`", "`planner`", "`researcher`", "`delegate`", "outputMode", "file-only", "## Pi Delegation Bindings"]) {
		assert.ok(!reference.includes(ghost), `the reference still names something that does not exist: ${ghost}`);
	}
	assert.ok(!reference.includes("Prefer delegation when fresh context improves correctness"), "the reference contradicts the inline default");
	assert.ok(reference.includes("Route generic exploration first to the installed package-owned `gentle-ai-explore`"));
	assert.ok(reference.includes("do not pass the `model` parameter by default"));
	for (const prompt of prompts) assert.ok(prompt.includes("when in doubt, work inline"));
	assert.ok(delegation.includes("Parallel writers only with disjoint Allowed edit surfaces (runtime-enforced) or isolated worktrees."));
});

test("X4: the README reference and the gentle-ai skill name the explorer that exists, not `scout` or `context-builder`", () => {
	const readme = read("docs/readme-reference.md");
	const skill = read("skills/gentle-ai/SKILL.md");
	for (const text of [readme, skill]) {
		assert.doesNotMatch(text, /scout|context-builder/, "a text still names an agent that does not exist");
		assert.ok(text.includes("gentle-ai-explore"));
	}
	assert.ok(readme.includes("Launch the package-owned `gentle-ai-explore`"));
	assert.ok(readme.includes("`gentle-ai-explore` saves parent context by compressing broad exploration."));
	assert.ok(skill.includes("clarify → gentle-ai-explore when the evidence budget is exceeded → inline"));
});

test("X5: the large task pattern label matches its inline diagram", () => {
	const lines = reference.split("\n");
	const label = lines.findIndex((line) => line.startsWith("Large task pattern"));
	assert.ok(label !== -1);
	assert.equal(lines[label], "Large task pattern (no Writer rule reason; with one, one bounded worker per unit writes instead):");
	assert.ok(lines[label + 3]?.includes("parent edits inline following the logbook"), "the diagram must stay the inline one");
});
