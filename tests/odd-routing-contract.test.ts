import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { readDelegationDetail } from "./support/orchestrator-modules.ts";

// These are instruction-delivery contracts, not proof of autonomous model adherence.
const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
const core = read("assets/orchestrator.md");
const delegation = readDelegationDetail();
const memory = read("assets/orchestrator-memory.md");
// The harness as rendered by extensions/gentle-ai.ts, including the ODD steps
// it takes from the mirrored provider bundle's routing/pi.md.
const wrapper = __testing.buildGentlePrompt("gentleman");

function containsAll(text: string, clauses: readonly string[]): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `missing contract: ${clause}`);
}

test("organic entry stays read-only without authorization and loads detail before work", () => {
	containsAll(core, [
		"large tasks get ODD tracking and workers only by the Writer rule, else inline",
		"orchestrator-delegation.md",
		"orchestrator-memory.md",
	]);
	// S11 T3: deduplicated. The core's "ODD (Default Workflow, harness section
	// above) is mandatory on every request" pointer restated the harness; the
	// mandatory workflow and its detail pointers are stated once in the harness.
	containsAll(wrapper, [
		"Default workflow: Organic Driven Development (MANDATORY)",
		"Every request enters it",
		"Detail for steps 3–7: `orchestrator-delegation.md` and `orchestrator-memory.md`.",
	]);
	containsAll(delegation, [
		"Investigation, explanation, review, comparison, and proposal-only requests remain read-only",
		"without a task or storage permission prompt",
		"small work creates no durable task artifacts",
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
		"explicit, complete save acknowledgement",
		"inspect the changed local task/log lines as needed",
		"do not routinely reread both full copies",
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

// gentle-shell#1494 field follow-up: tracking must not grow its own reconciliation
// scripts, invented size gates, or repeated malformed writer launches.
test("tracking sync recovers from partial writes without custom reconciliation gates", () => {
	containsAll(memory, [
		"These writes are not atomic",
		"never author comparison or reconciliation scripts or gates for them",
		"A missing, partial, truncated, failed, or uncertain acknowledgement requires checking which writes already applied before any retry; never replay an applied write",
		"If the tool reports a payload it cannot preserve, keep the file and mark its mirror pending rather than repeatedly resending the same payload",
		"a mirror that differs from the file just written is refreshed from the file, never a blocker",
		"Preserve both versions on irreconcilable edits",
	]);
	containsAll(delegation, [
		"A user's line limit is a ceiling, never an exact-count gate; never invent acceptance gates the user did not ask for",
	]);
	const writerClause = "Every new writer launch carries the section (a continuation inherits it); after an admission rejection, repair what it names once, never relaunch the same prompt unchanged";
	containsAll(delegation, [writerClause]);
	containsAll(read("assets/orchestrator-full-delegation-card.md"), [writerClause]);
});

test("assumption challenge and task checks do not activate or duplicate native review", () => {
	// P5b: the step 3 limit lives in the always-on steps; tracking keeps only what step 3 does not carry.
	containsAll(wrapper, ["at most one scoped read-only assumption challenge for a high-consequence unproven premise"]);
	containsAll(delegation, [
		"The step 3 assumption challenge is independent",
		"Deterministic failures need fixes",
		"native RDD refuter",
		"functional checks per task",
		"native review runs at that work-unit commit or PR slice boundary",
		"native candidate risk assessment",
		"`gentle_review` `{\"operation\":\"assess\"}`",
		// P5b (C5): the injected contract governs how a review starts, runs, and gets consent; tracking keeps the
		// commit-boundary rules mirrored from routing/pi.md, which the rendered prompt carries nowhere else.
		"When RDD is enabled, the injected Gentle AI review execution contract governs how a native review starts, runs, and gets consent; this module adds only the assessment and commit-boundary rules below.",
		"A not-due `passive` commit needs no review and the boundary advances; `under_budget` stays pending in the slice until a later commit reaches the budget.",
		"never infer low risk from a failed assessment",
		"When RDD is disabled, do not start or prompt for RDD",
	]);
});

// S14: commit per reviewable slice. The exact canon sentence for ODD step 6,
// identical in gentle-ai routing.go and this harness.
const S14_COMMIT_SENTENCE =
	"Commit work units in reviewable slices of about 400 authored changed lines on the feature branch (branch first when on the default branch), with tests and docs alongside the behavior and a Conventional Commit message; a unit whose Risk line names a high-risk item gets its own commit so native review can take it alone, and the last slice closes the feature. Record the commit that holds each task in the feature document as evidence.";
const PER_TASK_COMMIT_SENTENCE =
	"Every tracked task closes with at least one work-unit commit on the feature branch, branch first when on the default branch, with tests and docs alongside the behavior, using a Conventional Commit message; record the commit identity in the feature document as evidence.";

test("S14: the rendered parent prompt commits per reviewable slice, not per task", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.equal(prompt.split(S14_COMMIT_SENTENCE).length - 1, 1, `[${persona}] the parent prompt must carry the S14 sentence once`);
		assert.ok(!prompt.includes(PER_TASK_COMMIT_SENTENCE), `[${persona}] the parent prompt keeps the per-task commit sentence`);
		assert.ok(
			prompt.includes(`${S14_COMMIT_SENTENCE} Work-unit commits on the feature branch are part of authorized large ODD implementation;`),
			`[${persona}] step 6 must keep its authorization sentence right after the S14 sentence`,
		);
	}
});

// S14: commit per reviewable slice. Step 6 commits slices of about 400 authored
// changed lines (a high-risk unit alone) instead of closing every task with a commit.
test("ODD commits work units in reviewable slices and reviews the commit or PR slice", () => {
	containsAll(wrapper, [
		"Commit work units in reviewable slices of about 400 authored changed lines on the feature branch (branch first when on the default branch)",
		"with tests and docs alongside the behavior and a Conventional Commit message",
		"a unit whose Risk line names a high-risk item gets its own commit so native review can take it alone",
		"Record the commit that holds each task in the feature document as evidence",
		"Work-unit commits on the feature branch are part of authorized large ODD implementation; push, pull request creation, and merge remain the user's decisions",
		"The native review candidate is a work-unit commit or a PR slice, never a TODO checkbox and never the accumulated feature branch",
	]);
	// S11 T3: deduplicated. The harness principle that re-listed the ODD steps
	// ("close each tracked task with a work-unit commit") is gone; step 6 above is
	// the single statement. Core Safety allows exactly those commits and no others.
	assert.ok(!wrapper.includes("close each tracked task with a work-unit commit"), "the ODD steps are re-listed outside step 6");
	assert.ok(
		core.includes("- Never commit unless the user explicitly asks, except the work-unit commits authorized large ODD implementation makes on its feature branch (ODD step 6)."),
		"core Safety must allow only the ODD step 6 work-unit commits without an explicit ask",
	);
	assert.ok(!core.includes("- Never commit unless the user explicitly asks."), "core Safety contradicts ODD step 6 work-unit commits");
	containsAll(delegation, [
		'after each work-unit commit, assess it with `gentle_review` `{"operation":"assess"}` and `{"baseRef":"<last reviewed boundary>","committedOnly":true}`',
		"the first boundary is the branch point, and every reviewed boundary becomes the next base",
		// S14: commit per reviewable slice; one commit may hold several tasks, so outcomes are recorded per commit.
		"Record per commit the assessed tier and outcome (not due, granted, declined, or unavailable) with its `reviewDueReason`",
		"Delivery follows work units",
		"forecast authored changed lines (additions plus deletions, generated files excluded) from the task list",
		"keep a running count from work-unit commits",
		"`ask-on-risk` (default), `auto-chain`, `single-pr`, or `exception-ok`",
		"apply the chosen strategy before the next commit",
		"`ask-on-risk` asks once using the ordered oversized-delivery menu",
		"`auto-chain` asks only for a missing chain strategy and slices automatically",
		"Cache both choices, and record slice boundaries",
		"Resolve the `work-unit-commits` and `chained-pr` skills by registry name",
		"never hardcode their paths",
		"The delivery budget below reads the accumulated branch, not this per-task heuristic",
	]);
	assert.ok(!wrapper.includes("Every tracked task closes with at least one work-unit commit"), "step 6 keeps the per-task commit rule");
	const docs = read("docs/readme-reference.md");
	containsAll(docs, [
		"Commit work units in reviewable slices of about 400 authored changed lines on the feature branch (branch first when on the default branch)",
		"a unit whose Risk line names a high-risk item gets its own commit so native review can take it alone",
		"the feature document records the commit that holds each task as evidence",
		"The native review candidate is a work-unit commit or a PR slice, never a TODO checkbox and never the accumulated feature branch",
		"**Delivery:**",
		"Commit at a slice boundary; a high-risk unit alone",
		"RDD enabled at work-unit commit boundary",
		"Running authored lines over 400",
		"Apply selected delivery strategy",
		"Single PR; no chain artifacts",
	]);
	assert.ok(!docs.includes("Every task closes with at least one work-unit commit"), "docs keep the per-task commit rule");
	const skill = read("skills/work-unit-commits/SKILL.md");
	containsAll(skill, [
		"Committing ODD work in reviewable slices of about 400 authored changed lines.",
		"ODD commits work units in reviewable slices of about 400 authored changed lines, not one commit per task:",
		"A unit whose Risk line names a high-risk item gets its own commit, so native review takes it alone.",
	]);
	assert.ok(!skill.includes("Every ODD task closes with at least one work-unit commit"), "the skill keeps the per-task commit rule");
});

test("delivery instructions and docs preserve localized ordered outcomes and override chaining", () => {
	for (const text of [delegation, read("docs/readme-reference.md")]) {
		// English prose is documentation evidence, not mandatory runtime UI copy.
		const outcomes = ["chain_strategy=feature-branch-chain", "chain_strategy=stacked-to-main", "delivery_strategy=single-pr"];
		let previous = -1;
		for (const outcome of outcomes) {
			const index = text.indexOf(outcome);
			assert.ok(index > previous, `missing or out-of-order semantic outcome: ${outcome}`);
			previous = index;
		}
		assert.match(text, /1\. .*feature\/tracker.*feature-branch-chain/i);
		assert.match(text, /2\. .*verified default\/main.*stacked-to-main/i);
		assert.match(text, /3\. .*single PR.*least recommended.*delivery_strategy=single-pr/i);
		containsAll(text, [
			"delivery_strategy=single-pr", "not a `chain_strategy` token",
			"overrides the pending chaining path", "clear the chain choice",
			"suppress later chain prompts", "not automatically select `exception-ok`",
			"destination repository's documented contribution/size policy",
			"not a universal label requirement", "no tracker, child dependency diagram, or Chain Context",
			"complete user-facing question", "every option label, description, and recommendation marker",
			"active user's conversation language", "unchanged and untranslated",
			"English examples are illustrative and localizable, not mandatory copy",
		]);
		assert.doesNotMatch(text, /single-pr.*requires? `size:exception`/i);
	}
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
		"verification evidence, progress, and next step",
		"rationale for meaningful accepted changes",
		"Routine corrections stay brief; no exhaustive decision journal",
		"Accepted user, review, or verification changes",
		"automatically update affected intent and TODOs",
		"add genuinely new tasks or reopen invalidated items with a reason",
		"Findings alone never authorize scope expansion or automatic acceptance",
		"At initial implementation or recovery after interruption or context loss, the parent reads both the actual file and full observation",
		"Within an intact continuation, reuse the established specs, next task, route, and applicable proof",
		"A progress question does not restart preparation",
		"New scope, external edits, stale proof, or missing context require inspecting the affected state before editing",
		"passes the locator, task IDs, and linked `S#`; workers read the document until `## Log` before edits",
	]);
	containsAll(read("assets/agents/gentle-ai-worker.md"), [
		"Read the parent's ODD feature document locator before edits",
		"Preserve valid completed work; return proposed intent/task changes and their reasons",
	]);
});

// gentle-shell#1713: handoffs paraphrased the user's request, the feature
// document summarized it, and verify never saw it. The document is now the
// specification subagents read by reference, in a fixed token-cheap order.
test("feature document is the verbatim specification subagents read by reference", () => {
	const always = [
		"`## Specs`",
		"`## Tasks`",
		"`## Log`",
		"exact strings, error messages, and examples verbatim",
		"`L1` is the user's original request verbatim",
		"rewrites only the affected `S#`, and reopens only its task",
		"Hand off by reference, never by paraphrase",
		"read until `## Log`",
		"Without a feature document, include the user's request verbatim",
		"a verdict per `S#`",
		"reproduce it before deciding it already works",
	];
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		containsAll(prompt, [...always,
			// Parity with the gentle-ai canon (gentle-ai#5215).
			"name the document, task, and specs (for example `Spec: odd/tasks/<feature>.md, T2, S3-S4`), tell workers to read until `## Log`",
			"runs the spec's examples the parent authorized, against isolated state when they mutate data",
		]);
		assert.doesNotMatch(prompt, /\(read until \\?`## Log\\?`\)\. Do T#/, "inline code spans cannot nest backticks");
	}
	containsAll(memory, [
		"specification subagents read by reference",
		"stable content first and the growing log last",
		"never summarize or reword those fragments",
		"Do not add requirements the user never asked for",
		"`L1` holds the user's original request verbatim",
		"rewrites only the affected `S#`, and reopens only its linked task",
	]);
	assert.doesNotMatch(delegation, /Translate the user's request into concise English/);
	containsAll(delegation, [
		"never translate, condense, or paraphrase the user's requirements",
		"Reproduce a user-reported failure",
	]);
	containsAll(read("assets/agents/gentle-ai-worker.md"), ["until `## Log`", "which `S#` the change covers"]);
	containsAll(read("assets/agents/gentle-ai-verify.md"), [
		"execute only exact test, build, lint, or spec example commands explicitly authorized by the parent",
		"verbatim user entries in `## Log`",
		"verdict per `S#`",
		"compare the exact output and error text",
		"isolated state",
	]);
	containsAll(read("assets/agents/gentle-ai-explore.md"), ["until `## Log`"]);
});

test("ODD defaults to applicable test-first without chat or TUI activation", () => {
	const worker = read("assets/agents/gentle-ai-worker.md");
	const verify = read("assets/agents/gentle-ai-verify.md");
	const support = read("assets/support/strict-tdd.md") + read("assets/support/strict-tdd-verify.md");
	const skill = read("skills/gentle-ai/SKILL.md");
	// S11 T3: deduplicated. The core sits after the harness in the same system
	// prompt; its pointer sentence restated the harness test-first policy, so the
	// rendered parent prompt (harness + core) now carries that policy exactly
	// once, from the harness, instead of the core carrying its own copy.
	const rendered = __testing.buildGentlePrompt("gentleman");
	// P5b (C3): the delegation modules forward the policy instead of restating its cycle.
	for (const text of [rendered, worker, verify, support, skill, wrapper]) {
		containsAll(text, ["applicable", "RED", "GREEN"]);
		assert.doesNotMatch(text, /(?:configured TDD mode|Strict TDD Mode is enabled|explicit user choice|test presence does not enable it|tests existing does not activate it)/i);
	}
	assert.equal(rendered.split("use test-first by default").length - 1, 1, "the parent prompt states the test-first policy once");
	assert.ok(!core.includes("GREEN"), "core restates the harness test-first policy");
	// P5b (C3): the lazy modules no longer restate the policy; they forward it (below).
	for (const [actor, text] of [["extension", wrapper], ["skill", skill]] as const) {
		assert.match(text, /behavior changes with applicable runnable deterministic tests and a clear expected outcome/i, `${actor} must require applicability, not test presence`);
		assert.match(text, /passive documentation/i, `${actor} must handle passive docs`);
		assert.match(text, /unavailable runner/i, `${actor} must handle unavailable runners`);
		assert.match(text, /ordinary functional or structural verification/i, `${actor} must specify fallback checks`);
	}
	// P5b (C3): the "use test-first by default" policy lives once, in the rendered always-on principle
	// (asserted above); tracking alone forwards it to writers.
	containsAll(read("assets/orchestrator-tracking.md"), ["Test-first is the always-on harness principle", "forward this policy"]);
	containsAll(worker, ["before implementation", "ordinary functional or structural verification", "no meaningful RED"]);
	containsAll(verify, ["observed RED", "observed GREEN", "exception"]);
	assert.doesNotMatch(skill, /SDD|OpenSpec/i, "the ODD-only skill must not prime SDD");
	assert.doesNotMatch(core + delegation + worker + support + skill + wrapper, /If tests exist, use strict TDD/i);
});

// S9 canon change (gentle-ai 87a3b2eb): "These triggers are mandatory, not
// advisory." read as a default to delegate (L8). A trigger is mandatory only
// once its condition truly holds; none holds by default, inline when in doubt.
test("delegation triggers are behavioral in the lazy canonical port and the always-on ODD step", () => {
	for (const clause of [
		"Each trigger holds only when its condition truly holds; none holds by default. Inline stays within the evidence budget.",
		"stop and delegate through the runtime's subagent mechanism before continuing",
		"executing past a fired trigger inline is a routing defect even if the work succeeds",
		"**Mapping trigger",
		"**Writer trigger",
		"**Preparation trigger:**",
		"**Context backstop:**",
		"pause and delegate the next bounded unit of work",
		"**Route declaration:**",
		"record the chosen route per task",
		"so skipped delegation is observable instead of silent",
		"These triggers only choose between direct inline and delegated direct inside ODD",
	]) {
		assert.ok(delegation.includes(clause), `lazy canonical port is missing delegation clause: ${clause}`);
	}
	assert.ok(!delegation.includes("These triggers are mandatory, not advisory"), "the lazy port must not read the triggers as mandatory by default");
	assert.ok(
		wrapper.includes("honoring its delegation triggers when their conditions truly hold"),
		"the always-on ODD step 6 must honor its delegation triggers only when their conditions truly hold",
	);
	assert.ok(wrapper.includes("No trigger holds by default and, when in doubt, work inline"), "the always-on ODD step 6 must default to inline");
	assert.ok(!wrapper.includes("These triggers are mandatory, not advisory"), "the always-on ODD step 6 must not read the triggers as mandatory by default");
	assert.ok(
		wrapper.includes("executing past a fired trigger inline is a routing defect"),
		"the always-on ODD protocol must state that skipping a fired trigger is a routing defect",
	);
});

test("core and lazy canonical trigger lists agree in numbering and semantics", () => {
	for (const entry of [
		"1. **Ask**",
		"2. **Evidence-budget rule**",
		"3. **Verification rule**",
		"4. **Track**",
		"5. **Writer rule**",
		"6. **Incident rule**",
		"7. **Context backstop**",
	]) {
		assert.ok(core.includes(entry), `always-on core trigger list is missing: ${entry}`);
	}
	for (const entry of [
		"1. **Ask:**",
		"2. **Mapping trigger (Evidence-budget rule):**",
		"3. **Verification rule**",
		"4. **Track:**",
		"5. **Writer trigger (Writer rule):**",
		"6. **Incident rule:**",
		"7. **Context backstop:**",
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

// Evidence-budget rule (gentle-shell#1587, measured in gentle-ai#5139): every
// routing surface states the same numbers, and the retired file-count and
// tool-call triggers are gone from all of them.
test("evidence-budget numbers agree across routing surfaces and retired triggers are gone", () => {
	const surfaces: Record<string, string> = {
		"assets/orchestrator.md": core,
		"assets/orchestrator-delegation.md": delegation,
		"skills/gentle-ai/SKILL.md": read("skills/gentle-ai/SKILL.md"),
	};
	for (const [path, text] of Object.entries(surfaces)) {
		containsAll(text, [
			"**Evidence-budget rule**",
			"at most 3 calls",
			"~10k tokens",
			"at most ~2k tokens",
			"`path:line`",
			"Context backstop",
		]);
		assert.doesNotMatch(text, /4-file rule|20 tool calls|5 exploratory (?:file )?reads/, `${path} keeps a retired trigger`);
	}
	for (const agent of ["assets/agents/gentle-ai-explore.md", "assets/agents/gentle-ai-verify.md"]) {
		containsAll(read(agent), ["at most ~2k tokens", "`path:line`"]);
	}
});

// Harness roadmap R1: the backstop is a measured runtime signal (min(absolute cap, fraction x window)), so the
// prompt modules stop stating a fixed token count and only a unit needing several steps is worth delegating.
test("context backstop prompt text defers to the runtime signal instead of a fixed token count", () => {
	const reference = read("assets/orchestrator-delegation-reference.md");
	for (const [path, text] of Object.entries({ "assets/orchestrator.md": core, "assets/orchestrator-delegation.md": read("assets/orchestrator-delegation.md"), "assets/orchestrator-delegation-reference.md": reference })) {
		assert.doesNotMatch(text, /~?150k tokens/, `${path} still states a fixed backstop`);
		assert.match(text, /\*\*Context backstop(?::\*\*|\*\*:?)[^\n]*when the runtime signals/, `${path} must defer to the runtime signal`);
		assert.ok(text.includes("several steps"), `${path} must say only a unit needing several steps is delegated`);
	}
	const docs = read("docs/readme-reference.md");
	containsAll(docs, ["GENTLE_PI_CONTEXT_BACKSTOP_TOKENS", "GENTLE_PI_CONTEXT_BACKSTOP_FRACTION", "min(", "`getContextUsage()`", "re-armed"]);
	assert.doesNotMatch(docs, /~150k tokens|150,000-token context backstop/, "docs still describe the fixed backstop");
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
		"Size the task by the orchestrator's Task Size section",
		"5. **Track before the first write.**",
		"create or rebuild the visible `todo` list from the reconciled feature tasks",
		"Tell the user in one line which feature document was created and how many tasks it holds",
		"6. **Implement task by task.**",
		"7. **Close.**",
		"call `gentle_odd_phase` only when the primary session's ODD phase actually changes",
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

	// S11 T3: deduplicated. The harness principle and the core pointer sentence
	// both restated the mandatory workflow; the steps' own header (asserted in
	// order above as "predefined workflow of this orchestrator") is the one statement.
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		assert.equal(prompt.split("is the predefined workflow").length - 1, 1, `[${persona}] the ODD workflow is declared more than once`);
		assert.ok(!prompt.includes("ODD (Default Workflow, harness section above)"), `[${persona}] the core restates the ODD workflow`);
	}
	containsAll(core, ["orchestrator-delegation.md", "orchestrator-memory.md"]);
	assert.doesNotMatch(core + delegation + memory, /SDD|sdd-|OpenSpec|openspec/i);
});

// S14: commit per reviewable slice; outcomes are recorded per commit, since one commit may hold several tasks.
// Mirrors gentle-ai 06ad2776 (routing/pi.md, contract 1.4.0): a high-risk unit that follows pending `under_budget`
// commits closes the open slice first, so native review takes the high-risk commit alone. The rendered prompt carries
// only steps 1-7 of routing/pi.md and the injected orchestration contract has no slice rule, so tracking states it;
// P5b removed only the sentences that restated the injected contract (start, consent, Medium deferral).
test("S14: RDD tracking closes the open slice before a high-risk commit and records outcomes per commit", () => {
	const tracking = readFileSync(join(import.meta.dirname, "..", "assets", "orchestrator-tracking.md"), "utf8");
	assert.ok(
		tracking.includes("When a high-risk unit follows pending `under_budget` commits, close the open slice first, assessing and reviewing it as the slice, so the high-risk commit is then reviewed alone against the new boundary."),
		"tracking must close the open slice before a high-risk commit",
	);
	assert.ok(
		wrapper.includes("a unit whose Risk line names a high-risk item gets its own commit so native review can take it alone"),
		"step 6 must keep a high-risk unit in its own commit",
	);
	assert.ok(tracking.includes("Record per commit the assessed tier and outcome"), "tracking must record outcomes per commit");
	assert.ok(!tracking.includes("Record per task the assessed tier and outcome"), "tracking must not record outcomes per task");
});
