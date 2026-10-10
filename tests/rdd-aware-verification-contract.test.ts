import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { readDelegationDetail } from "./support/orchestrator-modules.ts";

// ---------------------------------------------------------------------------
// gentle-pi#661/#662: RDD-aware verification rule for delegated work.
//
// The bounded writer always self-verifies: it runs the parent-authorized
// `## Verification` commands itself and reports observed output. Whether a
// SEPARATE `gentle-ai-verify` delegation is also required depends on the
// rendered `Receipt-driven development:` line, stated normatively exactly
// once in trigger 5 (Verification rule) and referenced -- not restated --
// everywhere else in this asset:
//   - every line (`on`, `off`, `unknown`) -> verify-always-rdd-high S1: the
//                         parent calls `gentle_review` with
//                         `{"operation":"assess"}` over the writer's diff and
//                         follows the returned plan by native risk tier
//                         (passive/medium/high/unassessable), instead of a
//                         blanket non-trivial judgment.
//   - `on`             -> the native review is an additional outside view; it
//                         never replaces or skips the tier's verification.
// These tests assert the exact distinctive sentences (not bare words like
// `off`/`unknown`/`partial`/`blocked`), that the tier table is stated exactly
// once, that the routing ladder paragraph references trigger 5 rather than
// restating it, and that `## Known environmental failures` has one canonical
// definition (owned by the worker asset) that the delegation asset
// references rather than duplicates.
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, "..");

function read(relativePath: string): string {
	return readFileSync(join(ROOT, relativePath), "utf8");
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

const delegation = readDelegationDetail();
const worker = read("assets/agents/gentle-ai-worker.md");

const ROUTING_SENTENCE =
	'After the writer returns, call `gentle_review` with `{"operation":"assess"}` over the writer\'s diff and follow the returned plan, whatever the `Receipt-driven development:` line reads (`on`, `off`, or `unknown`), instead of judging non-triviality from the task description: the operation resolves the native risk tier and states exactly who verifies next.';
const RDD_ON_SENTENCE =
	"When the line reads `on`, the native review is an additional outside view of the change; it never replaces or skips the tier's verification, and the tier's verifier runs before review.";
const TIER_TABLE_HEADER = "| Native risk tier | Verification (any RDD state) |";
const PASSIVE_TIER_ROW = "| passive | structural readback by the parent; no separate verifier, no tests |";
const MEDIUM_TIER_ROW = "| medium | writer self-verification stands; a separate `gentle-ai-verify` run is added only when the writer profile is a small model (mini or low effort) |";
const HIGH_TIER_ROW = "| high | writer self-verification plus a separate `gentle-ai-verify` run, always |";
const UNASSESSABLE_TIER_ROW = "| unknown / assess failed | treated as high |";
const SMALL_MODEL_BIAS_SENTENCE =
	"The small-model bias raises the tier by one for verification purposes (medium becomes high); an unknown `Receipt-driven development:` line never lowers a tier below `off`.";
const SPOT_CHECK_SENTENCE =
	"The parent spot check (re-running one reported command before delivery) stays required in every tier.";
test("trigger 5 (Verification rule) routes every RDD line through assess and the risk tier", () => {
	assert.ok(delegation.includes(ROUTING_SENTENCE), "trigger 5 is missing the exact routing sentence");
});

test("trigger 5 states that with RDD on the native review adds an outside view and never replaces verification", () => {
	assert.ok(delegation.includes(RDD_ON_SENTENCE), "trigger 5 is missing the RDD-on sentence");
	for (const banned of ["verification of record", "becomes on-demand", "on-demand only", "on-demand verify"]) {
		assert.ok(!delegation.includes(banned), `the native review still replaces verification somewhere: ${banned}`);
	}
});

test("trigger 5 states the native risk tier table exactly once, with all four rows", () => {
	for (const row of [TIER_TABLE_HEADER, PASSIVE_TIER_ROW, MEDIUM_TIER_ROW, HIGH_TIER_ROW, UNASSESSABLE_TIER_ROW]) {
		assert.equal(countOccurrences(delegation, row), 1, `expected exactly one occurrence of tier table row: ${row}`);
	}
});

test("trigger 5 states the small-model bias and the unknown-never-lowers-a-tier rule", () => {
	assert.ok(delegation.includes(SMALL_MODEL_BIAS_SENTENCE), "trigger 5 is missing the small-model bias sentence");
});

test("trigger 5 keeps the parent spot check requirement in every tier", () => {
	assert.ok(delegation.includes(SPOT_CHECK_SENTENCE), "trigger 5 is missing the parent spot check sentence");
});

test("trigger 5 never introduces a forbidden native RDD marker", () => {
	for (const marker of ["gentle-ai review status", "next_transition", "review.capture-result", "review.validate", "reviewGate.result"]) {
		assert.ok(!delegation.includes(marker), `stale/forbidden RDD marker introduced: ${marker}`);
	}
});

test("the routing and RDD-on sentences appear exactly once each (normative statement lives only in trigger 5)", () => {
	for (const sentence of [ROUTING_SENTENCE, RDD_ON_SENTENCE]) {
		assert.equal(countOccurrences(delegation, sentence), 1, `expected exactly one occurrence of: ${sentence.slice(0, 60)}...`);
	}
});

test("trigger 5 never restates the retired #661 off/unknown non-trivial judgment", () => {
	assert.doesNotMatch(delegation, /non-trivial change, in addition to the writer's own report/);
	assert.doesNotMatch(delegation, /purely passive documentation with no behavior to verify/);
});

test("the Simple Delegation paragraph references trigger 3 instead of restating the on/off/unknown routing", () => {
	assert.match(
		delegation,
		/per the RDD-aware Verification rule \(trigger 3 under Mandatory Delegation Triggers, gentle-pi#661\)/,
	);
	assert.match(delegation, /the normative on\/off\/unknown routing lives in `orchestrator-verification.md`, not here/);
});

test("delegation overlay's Verification rule is RDD-aware", () => {
	assert.match(delegation, /\*\*Verification rule\*\*.*RDD-aware/);
});

test("delegation overlay reserves separate exploration for parent routing decisions", () => {
	assert.match(delegation, /exploration stays reserved for when the parent needs the map to decide or route/i);
	assert.match(delegation, /reading that prepares a write belongs with the writer/i);
});

test("delegation overlay keeps the required headings", () => {
	for (const heading of [
		"### Delegation Rules",
		"#### Background Subagent Policy",
		"#### Allowed edit surfaces (MANDATORY)",
		"### 2. Simple Delegation",
	]) {
		assert.ok(delegation.includes(heading), `delegation overlay lost required heading: ${heading}`);
	}
	assert.doesNotMatch(delegation, /### 3\. SDD \(optional\)/);
});

test("worker asset declares the Verification section after Test discipline", () => {
	const testDisciplineIndex = worker.indexOf("## Test discipline");
	const verificationIndex = worker.indexOf("## Verification");
	const interactionIndex = worker.indexOf("## Interaction contract");
	assert.ok(testDisciplineIndex >= 0, "worker asset lost ## Test discipline");
	assert.ok(verificationIndex >= 0, "worker asset is missing ## Verification");
	assert.ok(interactionIndex >= 0, "worker asset lost ## Interaction contract");
	assert.ok(
		testDisciplineIndex < verificationIndex && verificationIndex < interactionIndex,
		"## Verification must sit between ## Test discipline and ## Interaction contract",
	);
});

test("worker asset requires foreground, one-at-a-time verification with nothing left unreported", () => {
	for (const clause of [
		"in the foreground",
		"one at a time",
		"Never launch a verification command in the background",
		"never end the task with a listed command unreported",
	]) {
		assert.ok(worker.includes(clause), `worker asset is missing: ${clause}`);
	}
});

test("worker asset reports each verification command as <exact command>: <observed result> in validation", () => {
	assert.ok(worker.includes("`<exact command>: <observed result>`"));
	assert.ok(worker.includes("in `validation`"));
});

// ---------------------------------------------------------------------------
// Contract consistency (`## Known environmental failures`): defined exactly
// once, in the worker asset, as "exact test names (or exact command lines)
// that already fail on the base"; the writer reports those as evidence, but
// any OTHER failing required command still forces `status: partial`. The
// delegation asset must reference this same definition, not restate it.
// ---------------------------------------------------------------------------

test("worker asset owns the canonical Known environmental failures definition", () => {
	assert.ok(worker.includes("## Known environmental failures"));
	assert.match(worker, /this is the canonical definition; other assets reference it, they do not restate it/i);
	assert.match(worker, /lists exact test names or exact command lines that already fail on the base/i);
	assert.match(worker, /Any OTHER required command that fails -- one not named under that heading -- still forces `status: partial`\./);
});

test("delegation asset references the worker's Known environmental failures definition instead of restating it", () => {
	assert.match(
		delegation,
		/`## Known environmental failures` follows the same definition as `gentle-ai-worker`'s Verification contract: exact pre-existing base failures reported as evidence, never blockers -- any other failing required command still forces `status: partial`\./,
	);
	// The full canonical wording ("lists exact test names or exact command
	// lines that already fail on the base") must not be duplicated here.
	assert.doesNotMatch(delegation, /lists exact test names or exact command lines that already fail on the base/i);
});

test("worker asset never claims completion while a required verification command fails under RDD, except a named environmental failure", () => {
	assert.doesNotMatch(worker, /verification of record/i);
	assert.match(worker, /this report is your self-verification; the risk tier decides whether an independent verifier also runs/i);
	assert.match(
		worker,
		/never report `status: completed` while a required command under `## Verification` is failing, unless that exact failure is named under `## Known environmental failures`\./i,
	);
});

test("worker keeps candidate review disposition and lifecycle parent-owned", () => {
	for (const clause of [
		"The primary parent owns candidate review disposition and lifecycle, including preflight and any explicit candidate-level opt-out.",
		"Never search for, request, or invoke review tools, including `gentle_review`.",
		"Missing review tools never block this worker's implementation or verification handoff.",
	]) {
		assert.ok(worker.includes(clause), `worker asset is missing: ${clause}`);
	}
});

test("worker asset keeps the existing Return contract fields", () => {
	for (const field of [
		"status: completed | partial | blocked | interaction_required",
		"summary:",
		"files_changed:",
		"tdd_evidence:",
		"validation:",
		"risks:",
		"review_focus:",
		"skill_resolution:",
		"interaction_required:",
	]) {
		assert.ok(worker.includes(field), `worker asset lost Return contract field: ${field}`);
	}
});

// ---------------------------------------------------------------------------
// gentle-pi#1175: the verification policy is stated on three surfaces -- the
// `gentle_review` tool contract (description, guidelines, parameters), the
// delegation asset, and docs/delegated-verification.md -- and they must say
// the same thing about the behavior ASSESS implements: closure only from the
// native `candidate.consumed` fact for this candidate, the runtime writer
// profile with a caller fallback, the conservative small-model bias, the
// declined/unavailable/unknown fallback, and functional checks that a native
// review never replaces. Assertions use short stable phrases, normalized for
// case, quoting, and line wrapping, not whole paragraphs.
// ---------------------------------------------------------------------------

interface RegisteredPolicyTool {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	parameters?: unknown;
}

function registeredReviewToolContract(): string {
	const tools = new Map<string, RegisteredPolicyTool>();
	const pi = {
		on() {},
		registerCommand() {},
		registerTool(definition: RegisteredPolicyTool) {
			tools.set(definition.name, definition);
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const tool = tools.get("gentle_review");
	assert.ok(tool, "gentle_review must be registered");
	return [tool.description ?? "", tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? []), JSON.stringify(tool.parameters)].join("\n");
}

function normalizePolicyText(text: string): string {
	return text.replace(/\\"/g, "").replace(/[`"']/g, "").replace(/\s+/g, " ").toLowerCase();
}

const POLICY_SURFACES: ReadonlyArray<readonly [string, string]> = [
	["gentle_review tool contract", normalizePolicyText(registeredReviewToolContract())],
	["assets/orchestrator-delegation.md", normalizePolicyText(delegation)],
	["docs/delegated-verification.md", normalizePolicyText(read("docs/delegated-verification.md"))],
];

const SHARED_POLICY_PHRASES: ReadonlyArray<readonly [string, string]> = [
	["closure only from native consumed evidence", "only from the native candidate.consumed fact for this exact candidate"],
	["caller closure claim is not authority", "a caller-supplied closed is not authority"],
	["runtime writer profile", "runtime-recorded model and effort of the pending mutations"],
	["caller profile is only a fallback", "only a fallback when no runtime evidence exists"],
	["conservative small-model bias", "keeps the conservative small-model bias"],
	["native review never replaces verification (verify-always-rdd-high S1)", "native review is an additional outside view"],
	["functional checks still run", "a native code review is not a substitute for applicable functional checks"],
];

test("the three verification policy surfaces carry the same ASSESS closure, profile, fallback, and functional-check statements (gentle-pi#1175)", () => {
	for (const [surface, text] of POLICY_SURFACES) {
		for (const [statement, phrase] of SHARED_POLICY_PHRASES) {
			assert.ok(text.includes(phrase), `${surface} is missing the ${statement} statement: "${phrase}"`);
		}
	}
});

test("no verification policy surface still tells callers to pass closed explicitly (gentle-pi#1175)", () => {
	for (const [surface, text] of POLICY_SURFACES) {
		for (const stale of ["closed is never derived", "closed is never auto-derived", "closed is never inferred", "pass it explicitly", "pass it only right after"]) {
			assert.ok(!text.includes(stale), `${surface} still carries the retired explicit-closure wording: "${stale}"`);
		}
	}
});
