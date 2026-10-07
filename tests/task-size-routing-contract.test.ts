import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { readDelegationDetail } from "./support/orchestrator-modules.ts";

// gentle-shell#1494: task size is decided by understanding, risk, and whether
// the work can be resumed from the diff, never by counting files, commands,
// fixes, or a requested todo list. Each mechanism (ask, explore, verify,
// track, writer) turns on only by its own trigger.

const REPO_ROOT = join(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

const core = read("assets/orchestrator.md");
const delegation = readDelegationDetail();
const skill = read("skills/gentle-ai/SKILL.md");
const extension = read("extensions/gentle-ai.ts");

function sectionOf(text: string, heading: string): string {
	const start = text.indexOf(heading);
	assert.ok(start !== -1, `missing section: ${heading}`);
	const next = text.indexOf("\n## ", start + heading.length);
	return next === -1 ? text.slice(start) : text.slice(start, next);
}

test("AC1: the always-on core defines task size once with the three criteria", () => {
	const size = sectionOf(core, "## Task Size");
	for (const clause of [
		"**Understood**",
		"no product or design decision is open",
		"one bounded read batch (at most 3 calls, ~10k tokens",
		"**Contained risk**",
		"**Resumable from the diff**",
		"the original request and `git diff` alone",
		"A task is **large** only when the resume test fails",
	]) {
		assert.ok(size.includes(clause), `task size section is missing: ${clause}`);
	}
	for (const [path, text] of Object.entries({ delegation, skill })) {
		assert.ok(!text.includes("**Resumable from the diff**"), `${path} restates the task-size criteria instead of referencing them`);
		assert.ok(text.includes("Task Size"), `${path} must reference the always-on Task Size section`);
	}
});

test("AC2: counts never classify, and the step-count classifier is gone", () => {
	const size = sectionOf(core, "## Task Size");
	assert.ok(
		size.includes("The number of files, commands or tests, fixes, or a requested `todo` list never decides size"),
		"task size must say counts never classify",
	);
	for (const [path, text] of Object.entries({ core, delegation, skill, extension, readme: read("docs/readme-reference.md") })) {
		assert.ok(!text.includes("two or more meaningful implementation steps"), `${path} keeps the step-count classifier`);
	}
	const prompt = __testing.buildGentlePrompt("gentleman");
	const classify = prompt.slice(prompt.indexOf("4. **Classify.**"), prompt.indexOf("5. **Track before the first write.**"));
	assert.ok(classify.includes("Task Size"), "ODD step 4 must classify by the Task Size section");
});

test("AC3: small work runs its checks inline and keeps test-first", () => {
	const size = sectionOf(core, "## Task Size");
	for (const clause of [
		"run the focused test and the suite inline, once each",
		"observe RED inline before the fix",
		"No explore, worker, or verifier",
		"no feature document, mirror, or commits unless the user asks",
		"needs no lazy asset",
	]) {
		assert.ok(size.includes(clause), `small path is missing: ${clause}`);
	}
	for (const [path, text] of Object.entries({ core, delegation, skill })) {
		assert.ok(!text.includes("only a read-only check within the evidence budget stays inline"), `${path} keeps the read-only-only inline check`);
		assert.ok(!text.includes("Only a truly local read-only check within the evidence budget stays inline"), `${path} keeps the read-only-only inline check`);
		assert.ok(!text.includes("running focused tests/builds"), `${path} still delegates focused test runs`);
		assert.ok(!text.includes("command-running verification → `gentle-ai-verify`"), `${path} still routes every command-running check to a verifier`);
	}
});

test("AC4: each mechanism turns on only by its own trigger and size is re-evaluated after", () => {
	const triggers = sectionOf(core, "## Mechanisms");
	for (const clause of [
		"each mechanism turns on only by its own trigger",
		"re-evaluate task size",
		"1. **Ask**",
		"2. **Evidence-budget rule**",
		"3. **Verification rule**",
		"4. **Track**",
		"5. **Writer rule**",
		"6. **Incident rule**",
		"7. **Context backstop**",
		"open product or design decision",
		"high risk",
		"never by file count",
		// gentle-shell#1731: the writer fires on reasons, not on size alone.
		"never by file count or a large task alone",
	]) {
		assert.ok(triggers.includes(clause), `mechanism list is missing: ${clause}`);
	}
	for (const [path, text] of Object.entries({ core, delegation, skill })) {
		assert.ok(!/2\+ non-trivial files|2 or more non-trivial files|Multi-file write rule/.test(text), `${path} keeps the file-count writer trigger`);
	}
});

test("AC5: the high-risk list lives once in the core, native tier wins, unclear is bounded", () => {
	const size = sectionOf(core, "## Task Size");
	for (const clause of [
		"**High risk**",
		"hard to detect, hard to undo, or reaches beyond the change",
		"(1) data or irreversible effects",
		// gentle-shell#1731 T10: items 1 and 3 cover changing or breaking existing things, not adding.
		"rewriting or deleting stored data, format changes, writing data without validation; not saving new records",
		"(2) security",
		"(3) changing or removing contracts others already consume",
		"; not adding a flag, command or optional field",
		"(4) concurrency",
		"(5) delivery or environment",
		"(6) no test would catch a regression",
		"only when a bounded look cannot tell whether (1)-(5) apply",
		"When RDD is on and native assess returns a tier, that tier wins",
	]) {
		assert.ok(size.includes(clause), `high-risk definition is missing: ${clause}`);
	}
	for (const broad of ["(1) data or irreversible effects (migrations, persisted data or formats)", "(3) contracts others consume"]) {
		assert.ok(!size.includes(broad), `high-risk list keeps the broad form: ${broad}`);
	}
	for (const [path, text] of Object.entries({ delegation, skill })) {
		assert.ok(!text.includes("(1) data or irreversible effects"), `${path} restates the high-risk list`);
	}
});

// AC7 (S7): the small path reads no lazy rule file, and each lazy module stays
// small enough that one mechanism costs one bounded read instead of 49 KB.
const MODULE_BUDGETS: Record<string, number> = {
	// gentle-shell#1731 merge with main: main's session subject/state guidance plus the reason-based Writer rule (20,000 -> 20,500 B).
	"orchestrator-delegation.md": 20_500,
	// gentle-shell#1731 T23: Close gate accepts one Needs your decision result as a stop (12,500 -> 12,600 B).
	"orchestrator-tracking.md": 12_600,
	// gentle-shell#1731 T3: parallel review protocol; lazy (delegation or high risk only), core and normative rule untouched.
	// gentle-shell#1731 T11/T12: verify-per-unit timing and the every-S# verify handoff (6,000 -> 6,400 B).
	// gentle-shell#1731 T15: one end-of-feature verify for same-model inline deliveries (6,400 -> 6,500 B).
	// gentle-shell#1731 T23: bounded self-review and partial/blocked writer -> Needs your decision (7,000 -> 7,300 B).
	"orchestrator-verification.md": 7_300,
	"orchestrator-writer.md": 4_500,
	"orchestrator-prompts.md": 13_000,
};

test("AC7: each delegation module stays under its byte budget and is loaded by its mechanism only", () => {
	for (const [file, budget] of Object.entries(MODULE_BUDGETS)) {
		const bytes = Buffer.byteLength(read(`assets/${file}`), "utf8");
		assert.ok(bytes <= budget, `${file} is ${bytes} B, over its ${budget} B budget`);
		assert.ok(core.includes(`\`${file}\``), `the always-on core must point at ${file}`);
		assert.ok(read("scripts/verify-package-files.mjs").includes(`assets/${file}`), `${file} must be a required package file`);
	}
	const smallPath = sectionOf(core, "## Task Size").split("\n").find((line) => line.startsWith("Small path:")) ?? "";
	assert.ok(smallPath.includes("It needs no lazy asset"), "the small path must say it needs no lazy asset");
	assert.doesNotMatch(smallPath, /`orchestrator-[a-z]+\.md`/, "the small path must not point at any lazy module");
	const mechanisms = sectionOf(core, "## Mechanisms");
	for (const [label, file] of [
		["3. **Verification rule**", "orchestrator-verification.md"],
		["4. **Track**", "orchestrator-tracking.md"],
		["5. **Writer rule**", "orchestrator-writer.md"],
	] as const) {
		const line = mechanisms.split("\n").find((entry) => entry.startsWith(label)) ?? "";
		assert.ok(line.includes(`\`${file}\``), `${label} must load ${file}`);
	}
});

test("work usage stays complete in the human guide while routing precedence stays canonical", () => {
	const asset = read("assets/orchestrator-delegation.md");
	const guide = read("docs/gentle-agents-activity.md");
	assert.ok(asset.includes("tool schemas and `docs/gentle-agents-activity.md`"));
	for (const clause of [
		'`{"area":"Auth","topic":"Login","tags":["Review"],"refs":[{"kind":"issue","repository":"github.com/Owner/Repo","id":"12"}]}`',
		'`filter: {"related_to":{"session_id":"<stable owner ID>"}}`',
		"Never publish private history as metadata.",
		"not inherited. Keep the returned actual task ID: it is **not** a child session ID.",
		"never automatically page. Source unavailable means no related rows, not refusal.",
		"confer no ownership, consent or permission. Querying needs no helper/model call.",
	]) assert.ok(guide.includes(clause), `human guide must retain: ${clause}`);
	assert.equal(asset.split("For a large task's bounded writes, prefer").length - 1, 1);
	assert.equal(asset.split("Route generic exploration first to the installed package-owned `gentle-ai-explore`").length - 1, 1);
	assert.ok(asset.includes("Judgment Day phase roles are never generic fallbacks."));
	assert.ok(asset.includes("same read-only mapping task and report the fallback."));
});

// S7 axis 2 (more input than output): tracking writes are mechanical; the
// model edits instead of rewriting and never re-emits the whole document just
// to mirror it.
test("T4: tracking updates edit in place and mirror without re-emitting the document", () => {
	const memory = read("assets/orchestrator-memory.md");
	for (const clause of [
		"Update the feature document with targeted edits; never rewrite the whole file to change a task line or append a log entry.",
		"When a code-execution tool such as `codemode` is available, refresh the Engram mirror inside one script that reads the file and saves its content, so the document is never re-emitted as output tokens.",
		"projection for large ODD,",
	]) {
		assert.ok(memory.includes(clause), `orchestrator-memory.md is missing: ${clause}`);
	}
	assert.ok(!memory.includes("For substantial authorized organic implementation"), "memory detail must size by Task Size, not 'substantial'");
});

// RDD follow-ups (lineages review-6d2889a73f541791, review-* slice 2): every
// module must be self-contained for the mechanism that loads it, and each
// moved clause must live in the module its pointer names.
test("T6: each delegation module carries its own clauses and names the modules it depends on", () => {
	const placement: Record<string, readonly string[]> = {
		"orchestrator-tracking.md": ["#### Authorization and progress", "Delivery follows work units", "Raise a candidate you know is high risk"],
		"orchestrator-verification.md": [
			"| Native risk tier | Verification (any RDD state) |",
			"## Agent escalation (gentle-shell#1494)",
			"## Parallel review protocol (gentle-shell#1731)",
		],
		"orchestrator-writer.md": ["#### Allowed edit surfaces (MANDATORY)", "#### Judgment Day fix dispatch"],
		"orchestrator-prompts.md": ["### Lossless Blocking Prompts (MANDATORY)", "#### Gentle AI Provider Defect Handoff (MANDATORY)"],
	};
	for (const [file, clauses] of Object.entries(placement)) {
		const text = read(`assets/${file}`);
		for (const clause of clauses) assert.ok(text.includes(clause), `${file} must carry: ${clause}`);
	}
	const writer = read("assets/orchestrator-writer.md");
	assert.ok(!/Lossless Blocking Prompts rules above/.test(writer), "the writer module must not point at rules 'above' that live in another module");
	assert.ok(writer.includes("`orchestrator-prompts.md`"), "the writer module must name the module that holds the blocking-prompt rules");
	assert.ok(!delegation.includes("precedence in rule 2"), "cross-references name rules, not ambiguous numbers");
});

test("T6: the readme no longer sends every suite to a verifier or tracks 'substantial' work", () => {
	const readme = read("docs/readme-reference.md");
	assert.ok(!readme.includes("send full suites and builds to a verifier"), "readme still delegates every suite");
	assert.ok(!/track substantial work|for substantial work|substantial authorized implementation/i.test(readme), "readme still sizes by 'substantial'");
});
