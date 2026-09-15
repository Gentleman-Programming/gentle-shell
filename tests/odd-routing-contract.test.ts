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
		"do not create a specialized agent or invoke `sdd-research`",
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
	]);
});

test("assumption challenge and task checks do not activate or duplicate native review", () => {
	containsAll(delegation, [
		"at most one scoped independent read-only assumption challenge",
		"high-consequence unproven premise",
		"Deterministic failures need fixes",
		"native RDD refuter",
		"functional checks per task, not an RDD cycle per TODO",
		"deliverable candidate boundary",
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

test("ODD forwards configured TDD without equating test presence with enablement", () => {
	containsAll(delegation, [
		"Resolve effective TDD on/off from existing project/session configuration or explicit user choice",
		"retain its source and exact test runner",
		"Record resolved mode, source, and runner in the feature document when present",
		"Tests or frameworks being present does not enable TDD",
		"Forward mode, source, and runner on every implementation delegation; refresh on resume",
		"When enabled, require observed RED before implementation, GREEN, then REFACTOR",
		"When disabled, run ordinary functional checks, not no checks",
		"If mode is unknown/conflicting or the runner is missing",
		"resolve only the ambiguity affecting the next action",
		"never invent precedence or a command, and never invoke sdd-init to determine ODD TDD",
	]);
	containsAll(read("assets/agents/gentle-ai-worker.md"), [
		"Consume the parent's effective TDD mode, configuration/choice source, and exact runner",
		"Missing or conflicting mode/source/runner is not disabled TDD",
	]);
	assert.doesNotMatch(wrapper, /If tests exist, use strict TDD/);
});

test("ODD protocol is always-on in the rendered system prompt and runs by default", () => {
	const orderedClauses = [
		"Default workflow: Organic Driven Development (MANDATORY)",
		"predefined workflow of this orchestrator",
		"SDD is a branch inside ODD",
		"Never describe this workflow only when asked about it: run it.",
		"1. **Authorize.**",
		"2. **Explore.**",
		"3. **Resolve uncertainty.**",
		"4. **Classify.**",
		"two or more meaningful implementation steps",
		"5. **Track before the first write.**",
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
	assert.ok(
		wrapper.includes(
			"I run Organic Driven Development by default and SDD/OpenSpec when explicitly selected",
		),
		"missing contract: extensions/gentle-ai.ts identity sentence",
	);
	assert.ok(
		core.includes("ODD (Default Workflow, harness section above) is mandatory on every request"),
		"missing contract: assets/orchestrator.md pointer sentence",
	);
	containsAll(core, ["orchestrator-delegation.md", "orchestrator-memory.md"]);
});
