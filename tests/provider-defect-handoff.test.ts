import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readDelegationDetail } from "./support/orchestrator-modules.ts";

// ---------------------------------------------------------------------------
// Provider Defect Handoff — structural readback tests (issue #256, track 5)
//
// Pins the port of Gentle AI's v2.4.0-rc.8 provider-defect handoff consent
// contract (the gentle-ai.review-integration.consent/v3 envelope; canonical
// source internal/assets/generic/sdd-orchestrator.md at tag v2.4.0-rc.8 of
// Gentleman-Programming/gentle-ai) into Pi's lazy-loaded orchestrator assets.
// The contract is a prerelease (not in v2.3.0 stable). These tests assert
// structural presence, ordering, and the removal of stale rc.3-era rules; they
// do not execute any lifecycle command.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");
// harness-continuity S9 (T9): the report workflow moved out of the always-loaded delegation modules into the
// focused `gentle-ai-provider-defect-report` skill, loaded only when a Gentle AI invocation produced the failure.
// Every workflow assertion below reads the skill; the delegation union keeps only the classification stub.
const SKILL_PATH = "skills/provider-defect-report/SKILL.md";
const SKILL = readFileSync(join(REPO_ROOT, SKILL_PATH), "utf8");
const DELEGATION = readDelegationDetail();
const PROMPTS = readFileSync(join(REPO_ROOT, "assets", "orchestrator-prompts.md"), "utf8");

const CHOICE_TOKENS = ["report_and_continue", "continue_without_reporting", "stop_here"] as const;

// rc.8 choice-1 ordering mirrors gentle-ai v2.4.0-rc.8 blocking_prompt_contract_test.go; asserted only where phrases exist.
function assertChoice1Order(haystack: string, anchors: readonly string[], surface: string): void {
	const positions = anchors.map((p) => haystack.indexOf(p));
	anchors.forEach((p, i) => assert.notEqual(positions[i], -1, `${surface}: missing rc.8 choice-1 anchor: ${JSON.stringify(p)}`));
	for (let i = 1; i < positions.length; i++) {
		assert.ok(positions[i - 1] < positions[i], `${surface}: rc.8 anchor ${i} must precede ${i + 1}; got ${positions}`);
	}
}

const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const SKILL_CHOICE1_ORDER = [
	"complete a definitive lookup across open and closed issues for an equivalent defect",
	"derive its evidence channel only from its build string",
	"If the equivalent has no verifiable relevant published fix, add exactly one occurrence comment",
	"A fix published only to the other evidence channel is not a relevant published fix",
	"If the installed build predates that release, recommend installing the published fix",
	"perform no further GitHub mutation and no blind retry",
	"Confirmed creation requires the GitHub create operation to confirm a newly-created issue identity",
	"execute the shared candidate-scoped continuation below",
] as const;

// ---------------------------------------------------------------------------
// 1 — skills/provider-defect-report/SKILL.md structural presence
// ---------------------------------------------------------------------------

test("the provider-defect-report skill is discoverable, prefixed, and packaged", () => {
	assert.match(SKILL, /^---\nname: gentle-ai-provider-defect-report\ndescription: "Trigger: [^\n]+"\nlicense: Apache-2\.0\nmetadata:\n  author: gentleman-programming\n  version: "1\.0"\n---/);
	for (const section of ["Activation Contract", "Hard Rules", "Decision Gates", "Execution Steps", "Output Contract", "References"]) {
		assert.match(SKILL, new RegExp(`^## ${section}$`, "m"), `the skill is missing section ${section}`);
	}
	assert.ok(readFileSync(join(REPO_ROOT, "scripts", "verify-package-files.mjs"), "utf8").includes(`"${SKILL_PATH}"`), "the skill must be a required package file");
});

test("the delegation modules keep only a short classification stub that loads the skill", () => {
	const stub = PROMPTS.match(/^#### Gentle AI Provider Defect Handoff \(MANDATORY\)$[\s\S]*/m)?.[0] ?? "";
	assert.ok(stub.length > 0, "orchestrator-prompts.md keeps the provider defect heading");
	assert.match(stub, /Before losslessly relaying any blocking choice envelope, classify its semantic admissibility/);
	assert.match(stub, /The test is what produced the failure, not what the work was doing when it happened/);
	assert.match(stub, /there is no report and no handoff/);
	assert.match(stub, /do not name the component you believe is responsible/i);
	assert.match(stub, /load the `gentle-ai-provider-defect-report` skill/);
	assert.ok(Buffer.byteLength(stub, "utf8") < 1200, `the stub stays short: ${Buffer.byteLength(stub, "utf8")} B`);
	for (const token of [...CHOICE_TOKENS, 'choices[answer="declined"].invocation', "final privacy scan", "definitive lookup", "evidence channel"]) {
		assert.ok(!DELEGATION.includes(token), `the delegation modules still carry workflow detail: ${token}`);
	}
});

test("the provider-defect-report skill references the prerelease consent/v3 contract", () => {
	assert.match(SKILL, /prerelease/i);
	assert.match(SKILL, /gentle-ai\.review-integration\.consent\/v3/);
});

test("the provider-defect-report skill lists all three semantic choice tokens", () => {
	for (const token of CHOICE_TOKENS) {
		assert.ok(
			SKILL.includes(`\`${token}\``),
			`the provider-defect-report skill missing semantic choice token: ${token}`,
		);
	}
	assert.match(SKILL, /\*\*Continue without reporting\*\*: Perform no GitHub search, write, comment, or label, and no report-side privacy scan is required/);
	assert.match(SKILL, /\*\*Stop here\*\*: Perform no GitHub operation and no decline invocation; preserve all consumer state and STOP/);
});

test("the provider-defect-report skill orders the three choices: report_and_continue, continue_without_reporting, stop_here", () => {
	const positions = CHOICE_TOKENS.map((token) => SKILL.indexOf(`\`${token}\``));
	for (const pos of positions) {
		assert.notEqual(pos, -1, "a choice token is missing; ordering assertion is meaningless");
	}
	assert.ok(
		positions[0] < positions[1],
		`report_and_continue must appear before continue_without_reporting; got positions ${positions}`,
	);
	assert.ok(
		positions[1] < positions[2],
		`continue_without_reporting must appear before stop_here; got positions ${positions}`,
	);
});

test("the provider-defect-report skill preserves the rc.8 choice-1 sub-bullet ordering", () => {
	assertChoice1Order(SKILL, SKILL_CHOICE1_ORDER, "the provider-defect-report skill");
});

test("the provider-defect-report skill states the admissibility-before-relay rule", () => {
	assert.match(SKILL, /Before losslessly relaying any blocking choice envelope, classify its semantic admissibility/i);
	assert.match(SKILL, /The test is what produced the failure, not what the work was doing when it happened/i);
});

test("the provider-defect-report skill excludes local consent lifecycle outcomes from provider-defect reporting", () => {
	assert.match(SKILL, /Pending consent has no response deadline\. `consent-binding-already-consumed` is a local lifecycle outcome, not a Gentle AI provider defect/i);
	assert.match(SKILL, /An unknown consent binding is reportable only when independent evidence proves a fresh, same-session, unconsumed binding was lost/i);
	assert.match(SKILL, /Never infer that evidence from the old combined stale-binding message/i);
});

test("the provider-defect-report skill states the never-offer-to-repair rule", () => {
	assert.match(
		SKILL,
		/never offer to switch to, inspect, modify, or directly repair the Gentle AI repository/i,
	);
	assert.match(SKILL, /reject it as semantically inadmissible and issue this separate orchestrator-owned handoff envelope/i);
});

test("the provider-defect-report skill states the consent requirement", () => {
	assert.match(SKILL, /Ask the user first, in the active orchestrator conversation language/i);
	assert.match(SKILL, /for explicit consent to report the apparent defect/i);
	assert.match(SKILL, /one single-select blocking envelope with exactly three semantic choices in this order/i);
});

test("the provider-defect-report skill states the privacy scrub requirement and ordering", () => {
	assert.match(SKILL, /Immediately before the first GitHub operation, perform a final privacy scan/i);
	assert.match(SKILL, /This scan precedes the definitive lookup, report creation, and occurrence comment/i);
	assert.match(SKILL, /raw argv, absolute paths, private project names, usernames, hostnames, credentials, diffs, source contents, and environment values/i);
});

test("the provider-defect-report skill states the definitive lookup gate", () => {
	assert.match(SKILL, /complete a definitive lookup across open and closed issues for an equivalent defect or canonical tracker/i);
	assert.match(SKILL, /completed open\+closed lookup with a classifiable result; incomplete, error, or unknown is not definitive/i);
	assert.match(SKILL, /Only a definitive lookup may branch to GitHub mutation/i);
});

test("the provider-defect-report skill states evidence-channel routing from installed build string", () => {
	assert.match(SKILL, /derive its evidence channel only from its build string/i);
	assert.match(SKILL, /recognized prerelease tags are `-rc\.` and `-main\.`; every other build is stable/i);
	assert.match(SKILL, /That release is a relevant published fix only when it is in the installed build's evidence channel/i);
	assert.match(SKILL, /A main-only commit, local\/source build, unmerged PR, or unsupported assertion is not published-fix evidence/i);
});

test("the provider-defect-report skill states other-channel occurrence routing", () => {
	assert.match(SKILL, /A fix published only to the other evidence channel is not a relevant published fix for this occurrence: add exactly one occurrence comment/i);
	assert.match(SKILL, /note where the fix is published/i);
	assert.match(SKILL, /Do not recommend switching channels; channel choice is the user's/i);
});

test("the provider-defect-report skill states outdated-build and regression routing", () => {
	assert.match(SKILL, /If the installed build predates that release, recommend installing the published fix and reproducing; do not create or comment for that occurrence yet/i);
	assert.match(SKILL, /treat it as a possible regression: reproduction on a build proven to contain that fix/i);
	assert.match(SKILL, /comment on a suitable canonical tracker, or create a linked regression issue when that tracker is unsuitable/i);
	assert.match(SKILL, /Never reopen automatically/i);
});

test("the provider-defect-report skill states confirmed-creation identity requirement", () => {
	assert.match(SKILL, /Confirmed creation requires the GitHub create operation to confirm a newly-created issue identity\/URL/i);
	assert.match(SKILL, /Never infer creation from output text alone/i);
});

test("the provider-defect-report skill states the uncertainty continuation (decline invocation runs, not withheld)", () => {
	assert.match(SKILL, /perform no further GitHub mutation and no blind retry/i);
	assert.match(
		SKILL,
		/execute the exact captured provider-owned decline invocation exactly once, validate it, re-enter native negotiated STATUS, and resume the already-held consumer continuation/i,
	);
	assert.match(SKILL, /do not search, comment, update, or retry creation until the exact created issue identity is resolved, then use the uncertainty continuation below/i);
});

test("the provider-defect-report skill states the exact-captured-decline-invocation rule", () => {
	assert.match(SKILL, /Both continue choices execute that exact captured decline invocation exactly once/i);
	assert.match(SKILL, /`choices\[answer="declined"\]\.invocation` from the `gentle-ai\.review-integration\.consent\/v3` envelope/i);
	assert.match(
		SKILL,
		/Never synthesize the decline command, target, token, or consumer continuation from prose/i,
	);
	assert.match(SKILL, /fail closed with all consumer state preserved and do not run a substitute command/i);
	assert.match(SKILL, /validate `action: "declined"`, `consent: "declined_this_candidate"`, and the exact target identity match/i);
});

test("the provider-defect-report skill states handoff scope and mode preservation", () => {
	// cost-speed P20 (PD-88): an explicit user request to stop RDD wins over the handoff scope rule.
	assert.ok(
		SKILL.includes(
			"Unless the user explicitly asks, do not invoke `gentle-ai review mode disable` at clone or global scope or turn RDD off or on within this handoff.",
		),
		"the handoff scope rule must yield to an explicit user request",
	);
	assert.doesNotMatch(SKILL, /Do not invoke `gentle-ai review mode disable` at clone or global scope within this handoff/i);
	assert.doesNotMatch(SKILL, /Do not turn RDD off or on within this handoff/i);
	assert.match(SKILL, /The result carries no lineage or receipt; ordinary delivery is unmanaged by the candidate choice, and the next candidate asks again/i);
});

test("the provider-defect-report skill states observed-evidence reporting", () => {
	assert.match(SKILL, /Report observed evidence, not an unconfirmed root cause/i);
	assert.match(SKILL, /sanitized version\/build, OS\/architecture\/client/i);
	assert.match(SKILL, /bounded attempts and outcomes, failure envelopes, mutation outcome/i);
	assert.match(SKILL, /expected and actual behavior, a minimal reproduction/i);
	assert.match(SKILL, /safe opaque reason\/revision identifiers, and preserved-state evidence/i);
});

test("the provider-defect-report skill states the resume route (published fix or maintainer-authorized recovery)", () => {
	assert.match(SKILL, /Resume after an installed published fix or an explicit maintainer-authorized, documented native recovery or reset/i);
	assert.match(SKILL, /A published prerelease or release candidate the user installed satisfies this/i);
	assert.match(SKILL, /Never resume against unpublished code: a source checkout, a local build, or an unmerged pull request/i);
});

// ---------------------------------------------------------------------------
// 2 — Prohibited stale rc.3-era rules (must NOT survive in the handoff)
// ---------------------------------------------------------------------------

test("the provider-defect-report skill does NOT carry the gentle-report label discipline", () => {
	assert.equal(
		SKILL.includes("gentle-report"),
		false,
		"the v2.4.0-rc.8 handoff removed the gentle-report label discipline; the string must not appear",
	);
});

test("the provider-defect-report skill does NOT make published fixes the sole resumption route", () => {
	assert.equal(
		SKILL.includes("Resume only after an installed published fix"),
		false,
		"rc.8 prohibits 'Resume only after an installed published fix' as the sole resumption route",
	);
	assert.equal(
		SKILL.includes("latest version"),
		false,
		"rc.8 prohibits 'latest version' wording in the handoff",
	);
});

test("the provider-defect-report skill does NOT retain the rc.3 hard-stop that withholds the decline invocation", () => {
	assert.equal(
		SKILL.includes("Any report ambiguity or failure is a hard stop: preserve all consumer state and do not execute the decline invocation"),
		false,
		"rc.8 replaced the rc.3 hard-stop wedge with the uncertainty continuation that executes the decline invocation",
	);
});

test("the provider-defect-report skill does NOT reference the rc.3 canon", () => {
	assert.equal(SKILL.includes("v2.4.0-rc.3"), false, "stale rc.3 version reference must be removed");
	assert.equal(SKILL.includes("gentle-ai#2060"), false, "stale rc.3 issue reference must be removed");
});

// ---------------------------------------------------------------------------
// 3 — The skill owns the complete handoff
// ---------------------------------------------------------------------------

test("the skill owns the complete provider defect handoff", () => {
	assert.match(SKILL, /Both continue choices execute that exact captured decline invocation exactly once/);
});

test("the complete delegation handoff invokes `gentle-ai review mode disable` exactly once", () => {
	assert.equal(countOccurrences(SKILL, "gentle-ai review mode disable"), 1);
});
