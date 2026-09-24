import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

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
const DELEGATION_PATH = join(REPO_ROOT, "assets", "orchestrator-delegation.md");
const DELEGATION = readFileSync(DELEGATION_PATH, "utf8");

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

const DELEGATION_CHOICE1_ORDER = [
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
// 1 — assets/orchestrator-delegation.md structural presence
// ---------------------------------------------------------------------------

test("orchestrator-delegation.md carries the provider defect handoff section", () => {
	assert.match(DELEGATION, /#### Gentle AI Provider Defect Handoff \(MANDATORY\)/);
});

test("orchestrator-delegation.md references the prerelease consent/v3 contract", () => {
	assert.match(DELEGATION, /prerelease/i);
	assert.match(DELEGATION, /gentle-ai\.review-integration\.consent\/v3/);
});

test("orchestrator-delegation.md lists all three semantic choice tokens", () => {
	for (const token of CHOICE_TOKENS) {
		assert.ok(
			DELEGATION.includes(`\`${token}\``),
			`orchestrator-delegation.md missing semantic choice token: ${token}`,
		);
	}
	assert.match(DELEGATION, /\*\*Continue without reporting\*\*: Perform no GitHub search, write, comment, or label, and no report-side privacy scan is required/);
	assert.match(DELEGATION, /\*\*Stop here\*\*: Perform no GitHub operation and no decline invocation; preserve all consumer state and STOP/);
});

test("orchestrator-delegation.md orders the three choices: report_and_continue, continue_without_reporting, stop_here", () => {
	const positions = CHOICE_TOKENS.map((token) => DELEGATION.indexOf(`\`${token}\``));
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

test("orchestrator-delegation.md preserves the rc.8 choice-1 sub-bullet ordering", () => {
	assertChoice1Order(DELEGATION, DELEGATION_CHOICE1_ORDER, "orchestrator-delegation.md");
});

test("orchestrator-delegation.md states the admissibility-before-relay rule", () => {
	assert.match(DELEGATION, /Before losslessly relaying any blocking choice envelope, classify its semantic admissibility/i);
	assert.match(DELEGATION, /The test is what produced the failure, not what the work was doing when it happened/i);
});

test("orchestrator-delegation.md excludes local consent lifecycle outcomes from provider-defect reporting", () => {
	assert.match(DELEGATION, /`consent-binding-expired` and `consent-binding-already-consumed` are local lifecycle outcomes, not Gentle AI provider defects/i);
	assert.match(DELEGATION, /An unknown consent binding is reportable only when independent evidence proves a fresh, same-session, unconsumed binding was lost/i);
	assert.match(DELEGATION, /Never infer that evidence from the old combined stale-binding message/i);
});

test("orchestrator-delegation.md states the never-offer-to-repair rule", () => {
	assert.match(
		DELEGATION,
		/never offer to switch to, inspect, modify, or directly repair the Gentle AI repository/i,
	);
	assert.match(DELEGATION, /reject it as semantically inadmissible and issue this separate orchestrator-owned handoff envelope/i);
});

test("orchestrator-delegation.md states the consent requirement", () => {
	assert.match(DELEGATION, /Ask the user first, in the active orchestrator conversation language/i);
	assert.match(DELEGATION, /for explicit consent to report the apparent defect/i);
	assert.match(DELEGATION, /one single-select blocking envelope with exactly three semantic choices in this order/i);
});

test("orchestrator-delegation.md states the privacy scrub requirement and ordering", () => {
	assert.match(DELEGATION, /Immediately before the first GitHub operation, perform a final privacy scan/i);
	assert.match(DELEGATION, /This scan precedes the definitive lookup, report creation, and occurrence comment/i);
	assert.match(DELEGATION, /raw argv, absolute paths, private project names, usernames, hostnames, credentials, diffs, source contents, and environment values/i);
});

test("orchestrator-delegation.md states the definitive lookup gate", () => {
	assert.match(DELEGATION, /complete a definitive lookup across open and closed issues for an equivalent defect or canonical tracker/i);
	assert.match(DELEGATION, /completed open\+closed lookup with a classifiable result; incomplete, error, or unknown is not definitive/i);
	assert.match(DELEGATION, /Only a definitive lookup may branch to GitHub mutation/i);
});

test("orchestrator-delegation.md states evidence-channel routing from installed build string", () => {
	assert.match(DELEGATION, /derive its evidence channel only from its build string/i);
	assert.match(DELEGATION, /recognized prerelease tags are `-rc\.` and `-main\.`; every other build is stable/i);
	assert.match(DELEGATION, /That release is a relevant published fix only when it is in the installed build's evidence channel/i);
	assert.match(DELEGATION, /A main-only commit, local\/source build, unmerged PR, or unsupported assertion is not published-fix evidence/i);
});

test("orchestrator-delegation.md states other-channel occurrence routing", () => {
	assert.match(DELEGATION, /A fix published only to the other evidence channel is not a relevant published fix for this occurrence: add exactly one occurrence comment/i);
	assert.match(DELEGATION, /note where the fix is published/i);
	assert.match(DELEGATION, /Do not recommend switching channels; channel choice is the user's/i);
});

test("orchestrator-delegation.md states outdated-build and regression routing", () => {
	assert.match(DELEGATION, /If the installed build predates that release, recommend installing the published fix and reproducing; do not create or comment for that occurrence yet/i);
	assert.match(DELEGATION, /treat it as a possible regression: reproduction on a build proven to contain that fix/i);
	assert.match(DELEGATION, /comment on a suitable canonical tracker, or create a linked regression issue when that tracker is unsuitable/i);
	assert.match(DELEGATION, /Never reopen automatically/i);
});

test("orchestrator-delegation.md states confirmed-creation identity requirement", () => {
	assert.match(DELEGATION, /Confirmed creation requires the GitHub create operation to confirm a newly-created issue identity\/URL/i);
	assert.match(DELEGATION, /Never infer creation from output text alone/i);
});

test("orchestrator-delegation.md states the uncertainty continuation (decline invocation runs, not withheld)", () => {
	assert.match(DELEGATION, /perform no further GitHub mutation and no blind retry/i);
	assert.match(
		DELEGATION,
		/execute the exact captured provider-owned decline invocation exactly once, validate it, re-enter native negotiated STATUS, and resume the already-held consumer continuation/i,
	);
	assert.match(DELEGATION, /do not search, comment, update, or retry creation until the exact created issue identity is resolved, then use the uncertainty continuation below/i);
});

test("orchestrator-delegation.md states the exact-captured-decline-invocation rule", () => {
	assert.match(DELEGATION, /Both continue choices execute that exact captured decline invocation exactly once/i);
	assert.match(DELEGATION, /`choices\[answer="declined"\]\.invocation` from the `gentle-ai\.review-integration\.consent\/v3` envelope/i);
	assert.match(
		DELEGATION,
		/Never synthesize the decline command, target, token, or consumer continuation from prose/i,
	);
	assert.match(DELEGATION, /fail closed with all consumer state preserved and do not run a substitute command/i);
	assert.match(DELEGATION, /validate `action: "declined"`, `consent: "declined_this_candidate"`, and the exact target identity match/i);
});

test("orchestrator-delegation.md states handoff scope and mode preservation", () => {
	assert.match(DELEGATION, /Do not invoke `gentle-ai review mode disable` at clone or global scope within this handoff/i);
	assert.match(DELEGATION, /Do not turn RDD off or on within this handoff/i);
	assert.match(DELEGATION, /The result carries no lineage or receipt; ordinary delivery is unmanaged by the candidate choice, and the next candidate asks again/i);
});

test("orchestrator-delegation.md states observed-evidence reporting", () => {
	assert.match(DELEGATION, /Report observed evidence, not an unconfirmed root cause/i);
	assert.match(DELEGATION, /sanitized version\/build, OS\/architecture\/client/i);
	assert.match(DELEGATION, /bounded attempts and outcomes, failure envelopes, mutation outcome/i);
	assert.match(DELEGATION, /expected and actual behavior, a minimal reproduction/i);
	assert.match(DELEGATION, /safe opaque reason\/revision identifiers, and preserved-state evidence/i);
});

test("orchestrator-delegation.md states the resume route (published fix or maintainer-authorized recovery)", () => {
	assert.match(DELEGATION, /Resume after an installed published fix or an explicit maintainer-authorized, documented native recovery or reset/i);
	assert.match(DELEGATION, /A published prerelease or release candidate the user installed satisfies this/i);
	assert.match(DELEGATION, /Never resume against unpublished code: a source checkout, a local build, or an unmerged pull request/i);
});

// ---------------------------------------------------------------------------
// 2 — Prohibited stale rc.3-era rules (must NOT survive in the handoff)
// ---------------------------------------------------------------------------

test("orchestrator-delegation.md does NOT carry the gentle-report label discipline", () => {
	assert.equal(
		DELEGATION.includes("gentle-report"),
		false,
		"the v2.4.0-rc.8 handoff removed the gentle-report label discipline; the string must not appear",
	);
});

test("orchestrator-delegation.md does NOT make published fixes the sole resumption route", () => {
	assert.equal(
		DELEGATION.includes("Resume only after an installed published fix"),
		false,
		"rc.8 prohibits 'Resume only after an installed published fix' as the sole resumption route",
	);
	assert.equal(
		DELEGATION.includes("latest version"),
		false,
		"rc.8 prohibits 'latest version' wording in the handoff",
	);
});

test("orchestrator-delegation.md does NOT retain the rc.3 hard-stop that withholds the decline invocation", () => {
	assert.equal(
		DELEGATION.includes("Any report ambiguity or failure is a hard stop: preserve all consumer state and do not execute the decline invocation"),
		false,
		"rc.8 replaced the rc.3 hard-stop wedge with the uncertainty continuation that executes the decline invocation",
	);
});

test("orchestrator-delegation.md does NOT reference the rc.3 canon", () => {
	assert.equal(DELEGATION.includes("v2.4.0-rc.3"), false, "stale rc.3 version reference must be removed");
	assert.equal(DELEGATION.includes("gentle-ai#2060"), false, "stale rc.3 issue reference must be removed");
});

// ---------------------------------------------------------------------------
// 3 — The retained delegation contract owns the complete handoff
// ---------------------------------------------------------------------------

test("retained delegation owns the complete provider defect handoff", () => {
	assert.match(DELEGATION, /^#### Gentle AI Provider Defect Handoff \(MANDATORY\)$/m);
	assert.match(DELEGATION, /Both continue choices execute that exact captured decline invocation exactly once/);
});

test("the complete delegation handoff invokes `gentle-ai review mode disable` exactly once", () => {
	const section = DELEGATION.match(
		/#### Gentle AI Provider Defect Handoff[\s\S]*?(?=\n#### SDD Edit-Authority|$)/,
	)?.[0] ?? "";
	assert.ok(section.length > 0, "orchestrator-delegation.md: provider defect handoff section not found");
	assert.equal(countOccurrences(section, "gentle-ai review mode disable"), 1);
});
