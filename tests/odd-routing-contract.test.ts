import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// These are instruction-delivery contracts, not proof of autonomous model adherence.
const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const core = read("assets/orchestrator.md");
const delegation = read("assets/orchestrator-delegation.md");
const memory = read("assets/orchestrator-memory.md");
const wrapper = read("extensions/gentle-ai.ts");

function containsAll(text: string, clauses: readonly string[]): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `missing contract: ${clause}`);
}

test("organic entry stays read-only without authorization and loads detail before work", () => {
	containsAll(core, [
		"Substantial authorized work: use ODD",
		"ODD (Default Workflow, harness section above) is mandatory on every request",
		"orchestrator-delegation.md",
		"orchestrator-memory.md",
	]);
	containsAll(delegation, [
		"Investigation, explanation, review, comparison, and proposal-only requests remain read-only",
		"without a task or storage permission prompt",
		"Small, understood work creates no durable task artifacts",
	]);
	assert.doesNotMatch(core + wrapper, /Prefer SDD\/OpenSpec artifacts|Substantial feature: suggest SDD organically/);
	assert.doesNotMatch(core + delegation, /Suggest it when proposal\/spec\/design\/tasks|propose SDD only when durable proposal\/spec\/design\/tasks/);
});

test("research uses adaptive evidence gathering and existing general workers only", () => {
	containsAll(delegation, [
		"problem, intended outcome, constraints, and current evidence",
		"no fixed questionnaire or mandatory rounds",
		"one focused user question",
		"stop and wait",
		"workers return gaps to the parent",
		"available authorized documentation/web tools",
		"prefer primary sources",
		"URLs or code locations",
		"verified facts, assumptions, contradictions, freshness, and gaps",
		"recommendation, tradeoffs, open questions, and implementation implications",
		"Forward these research instructions",
		"existing fresh general exploration/research worker",
		"do not create a specialized agent or create a new workflow",
		"no new persistence or readiness machinery",
	]);
});

test("task sizing is explicitly advisory and forwarded without cosmetic savings", () => {
	containsAll(delegation, [
		"about 400 authored changed lines",
		"additions plus deletions",
		"not a task acceptance criterion, hard cap, counter-trigger, automatic stop, forced split, or RDD trigger",
		"Forward this same advisory-only instruction",
		"Never delete spaces, blank lines, or comments",
		"never omit tests, minify, add gratuitous abstractions, or split artificially",
		"Existing PR size gates remain unchanged",
	]);
});

test("organic progress preserves both complete feature copies and reconciles actual evidence", () => {
	containsAll(memory, [
		"odd/tasks/<feature-name>.md",
		"odd/<feature-name>/tasks",
		"stable task IDs",
		"full current document",
		"repository-relative file locator",
		"preserve valid completed and unrelated work",
		"reopen invalidated items",
		"Check off only observed outcomes",
		"Read back both writes",
		"not atomic",
		"mirror pending",
		"Preserve both versions",
		"mem_context",
		"mem_search",
		"mem_get_observation",
		"read the actual task file",
		"not a third authority",
		"create or rebuild the visible `todo` list",
		"before the first source write",
		"after every task transition and material plan change",
	]);
	assert.doesNotMatch(memory, /`todo` tool is an optional session\/UI projection/);
});

test("assumption challenge and task checks do not activate or duplicate native review", () => {
	containsAll(delegation, [
		"at most one scoped independent read-only assumption challenge",
		"high-consequence unproven premise",
		"Deterministic failures need fixes",
		"native RDD refuter",
		"functional checks per task",
		"native review runs at that work-unit commit or PR slice boundary",
		"native candidate risk assessment",
		"gentle_review` with `{\"operation\":\"assess\"}",
		"Passive/low",
		"no reviewer or consent ceremony",
		"only on grant",
		"decline continues under ordinary policy",
		"never infer low risk from a failed assessment",
		"When RDD is disabled, do not start or prompt for RDD",
	]);
});

test("ODD closes each task with a work-unit commit and reviews the commit or PR slice", () => {
	containsAll(wrapper, [
		"Every task closes with at least one work-unit commit on the feature branch, branch first when on the default branch",
		"with tests and docs alongside the behavior, using a Conventional Commit message",
		"record the commit identity in the feature document as evidence",
		"Work-unit commits on the feature branch are part of authorized substantial ODD implementation; push, pull request creation, and merge remain the user's decisions",
		"The native review candidate is a work-unit commit or a PR slice, never a TODO checkbox and never the accumulated feature branch",
		"close each task with a work-unit commit",
	]);
	containsAll(delegation, [
		'after each work-unit commit, assess it with that same call and `{"baseRef":"<last reviewed boundary>","committedOnly":true}`',
		"Passive/low: silent structural checks, no reviewer or consent ceremony, and the boundary advances",
		'start native review on it right away at that base with `gentle_review` `{"operation":"start"}`',
		"Medium: defer to the PR slice",
		"bounded by the delivery budget of about 400 authored changed lines",
		"The first boundary is the branch point, and every reviewed boundary becomes the next base",
		"Record per task the assessed tier and outcome: granted, declined, passive, deferred to slice, or unavailable",
		"Delivery follows work units",
		"forecast authored changed lines (additions plus deletions, generated files excluded) from the task list",
		"keep a running count from work-unit commits",
		"`ask-on-risk` (default), `auto-chain`, `single-pr`, or `exception-ok`",
		"apply the chosen strategy before the next commit",
		"`ask-on-risk` asks once for the chain strategy, `stacked-to-main` or `feature-branch-chain`",
		"`auto-chain` asks only for a missing chain strategy and slices automatically",
		"Cache both choices, and record slice boundaries",
		"Resolve the `work-unit-commits` and `chained-pr` skills by registry name",
		"never hardcode their paths",
		"The delivery budget below reads the accumulated branch, not this per-task heuristic",
	]);
	const docs = read("docs/readme-reference.md");
	containsAll(docs, [
		"Every task closes with at least one work-unit commit on the feature branch (branch first when on the default branch)",
		"the feature document records the commit identity as evidence",
		"The native review candidate is a work-unit commit or a PR slice, never a TODO checkbox and never the accumulated feature branch",
		"**Delivery:**",
		"Close task with a work-unit commit",
		"RDD enabled at work-unit commit boundary",
		"Running authored lines over 400",
		"Apply delivery strategy: chained PR slice",
	]);
});

test("user documentation shows recovery and candidate-level consent without claiming model proof", () => {
	const docs = read("docs/readme-reference.md");
	containsAll(docs, [
		"## Organic Driven Development",
		"```mermaid",
		"Full feature memory and actual task file",
		"Native candidate risk",
		"advisory",
		"Static prompt tests",
		"autonomous",
	]);
	assert.ok(read("README.md").includes("#organic-driven-development"));
});


test("one feature document carries intent, accepted rationale and worker context", () => {
	containsAll(memory, [
		"one feature document, not a separate plan file or topic",
		"objective, problem, why, scope, constraints",
		"progress, verification evidence, and next step",
		"concise rationale for meaningful accepted changes",
		"Routine corrections stay with their tasks; no exhaustive decision journal",
		"Accepted user, review, or verification changes",
		"automatically update affected intent and TODOs",
		"add genuinely new tasks or reopen invalidated items with a reason",
		"Findings alone never authorize scope expansion or automatic acceptance",
		"Before implementation or resume, the parent reads both the actual file and full observation",
		"passes the locator and relevant context; workers read the document before edits",
	]);
	containsAll(read("assets/agents/gentle-ai-worker.md"), [
		"Read the parent's ODD feature document locator before edits",
		"Preserve valid completed work; return proposed intent/task changes and their reasons",
	]);
});

test("ODD defaults to applicable test-first without chat or TUI activation", () => {
	const worker = read("assets/agents/gentle-ai-worker.md");
	const verify = read("assets/agents/gentle-ai-verify.md");
	const support = read("assets/support/strict-tdd.md") + read("assets/support/strict-tdd-verify.md");
	const skill = read("skills/gentle-ai/SKILL.md");
	for (const text of [core, delegation, worker, verify, support, skill, wrapper]) {
		containsAll(text, ["applicable", "RED", "GREEN"]);
		assert.doesNotMatch(text, /(?:configured TDD mode|Strict TDD Mode is enabled|explicit user choice|test presence does not enable it|tests existing does not activate it)/i);
	}
	for (const [actor, text] of [["core", core], ["delegation", delegation], ["extension", wrapper], ["skill", skill]] as const) {
		assert.match(text, /behavior changes with applicable runnable deterministic tests and a clear expected outcome/i, `${actor} must require applicability, not test presence`);
		assert.match(text, /passive documentation/i, `${actor} must handle passive docs`);
		assert.match(text, /unavailable runner/i, `${actor} must handle unavailable runners`);
		assert.match(text, /ordinary functional or structural verification/i, `${actor} must specify fallback checks`);
	}
	containsAll(delegation, ["by default", "Forward this policy"]);
	containsAll(worker, ["before implementation", "ordinary functional or structural verification", "no meaningful RED"]);
	containsAll(verify, ["observed RED", "observed GREEN", "exception"]);
	assert.doesNotMatch(skill, /SDD|OpenSpec/i, "the ODD-only skill must not prime SDD");
	assert.doesNotMatch(core + delegation + worker + support + skill + wrapper, /If tests exist, use strict TDD/i);
});

test("mandatory delegation triggers are behavioral in the lazy canonical port and the always-on ODD step", () => {
	for (const clause of [
		"These triggers are mandatory, not advisory.",
		"stop and delegate through the runtime's subagent mechanism before continuing",
		"executing past a fired trigger inline is a routing defect even if the work succeeds",
		"**Mapping trigger",
		"**Writer trigger",
		"**Preparation trigger:**",
		"**Long-session backstop",
		"pause and delegate the next bounded unit of work",
		"**Route declaration:**",
		"record the chosen route per task",
		"so skipped delegation is observable instead of silent",
		"These triggers only choose between direct inline and delegated direct inside ODD",
	]) {
		assert.ok(delegation.includes(clause), `lazy canonical port is missing mandatory delegation clause: ${clause}`);
	}
	assert.ok(
		wrapper.includes("honoring its mandatory delegation triggers"),
		"the always-on ODD step 6 must honor its mandatory delegation triggers",
	);
	assert.ok(
		wrapper.includes("executing past a fired trigger inline is a routing defect"),
		"the always-on ODD protocol must state that skipping a fired trigger is a routing defect",
	);
});

test("core and lazy canonical trigger lists agree in numbering and semantics", () => {
	for (const entry of [
		"1. **4-file rule**",
		"2. **Multi-file write rule**",
		"3. **Incident rule**",
		"4. **Long-session rule**",
		"5. **Verification rule**",
	]) {
		assert.ok(core.includes(entry), `always-on core trigger list is missing: ${entry}`);
	}
	for (const entry of [
		"1. **Mapping trigger (4-file rule):**",
		"2. **Writer trigger (Multi-file write rule):**",
		"3. **Incident rule:**",
		"4. **Long-session backstop (Long-session rule):**",
		"5. **Verification rule**",
	]) {
		assert.ok(delegation.includes(entry), `lazy canonical trigger list is missing: ${entry}`);
	}
	for (const stale of [
		"**Bounded read rule**",
		"**Write rule**",
		"**Context rule**",
		"**Per-action rule**",
	]) {
		assert.ok(!delegation.includes(stale), `reconciled canonical list retains stale trigger framing: ${stale}`);
	}
});

test("ODD protocol is always-on in the rendered system prompt and runs by default", () => {
	const orderedClauses = [
		"Default workflow: Organic Driven Development (MANDATORY)",
		"predefined workflow of this orchestrator",
		"Never describe this workflow only when asked about it: run it.",
		"1. **Authorize.**",
		"2. **Explore.**",
		"3. **Resolve uncertainty.**",
		"4. **Classify.**",
		"two or more meaningful implementation steps",
		"5. **Track before the first write.**",
		"create or rebuild the visible `todo` list from the reconciled feature tasks",
		"Tell the user in one line which feature document was created and how many tasks it holds",
		"6. **Implement task by task.**",
		"7. **Close.**",
		"Harness principles:",
		"# el Gentleman Orchestrator",
	];
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		let cursor = -1;
		for (const clause of orderedClauses) {
			const index = prompt.indexOf(clause);
			assert.ok(index !== -1, `[${persona}] missing contract: ${clause}`);
			assert.ok(
				index > cursor,
				`[${persona}] clause out of order (must appear after the previous one): ${clause}`,
			);
			cursor = index;
		}
	}

	assert.ok(
		wrapper.includes("Organic Driven Development (ODD) is the predefined workflow for every request"),
		"missing contract: extensions/gentle-ai.ts harness principle",
	);
	// The parent owns the injected identity; its migration is outside this suite's edit surface.
	assert.ok(
		core.includes("ODD (Default Workflow, harness section above) is mandatory on every request"),
		"missing contract: assets/orchestrator.md pointer sentence",
	);
	containsAll(core, ["orchestrator-delegation.md", "orchestrator-memory.md"]);
	assert.doesNotMatch(core + delegation + memory, /SDD|sdd-|OpenSpec|openspec/i);
});
