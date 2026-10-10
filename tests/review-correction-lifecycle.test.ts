import assert from "node:assert/strict";
import test from "node:test";
import {
	CORRECTION_OUTCOMES,
	CorrectionEvidenceReplacedError,
	CorrectionOutcomeError,
	assertDistinctCorrectionEvidence,
	resolveCorrectionStep,
} from "../lib/review-correction-lifecycle.ts";

// The provider owns the evidence directory and the budget ledger. Pi's job is
// narrower and entirely decidable from data: given a status and one captured
// evidence record, which step comes next, and is it ever allowed to reuse a
// prior evidence identity. Keeping that a pure function is what makes these
// branches testable without spawning the binary — the alternative the design
// rejected was inlining them beside the existing conditionals, where the
// single-correction invariant would be enforced by control flow instead.

const STATUS = Object.freeze({
	lineageId: "review-b39d803b68a90767",
	targetIdentity: "sha256:b39d803b68a90767c822c6bac906c2ff512034df2a2432d4c2d8e48f45c11b0a",
	authorityRevision: "sha256:1298b2f5dd1ab7208bd7dfbf2e5802b21380617050f7ae3d7786bffcf0c6bb29",
	correctionBudget: 56,
	changedLinesCharged: 0,
});

function evidence(outcome: string, overrides: Record<string, unknown> = {}) {
	return {
		outcome,
		evidenceIdentity: "sha256:a077148ccb9f1c6e8b65fbfa984309676eee3e35311caaca31d6d61f6351f9fa",
		recordDigest: "sha256:a077148ccb9f1c6e8b65fbfa984309676eee3e35311caaca31d6d61f6351f9fa",
		candidateTree: "0542f90ab7b6af3fe79340509ec6420f0cc9ef68",
		rawPayloadSha256: "sha256:9013edfc64295a20c3f4ed41a7cf61d81a6617bb7180fd95b129cb77ff53fa00",
		...overrides,
	};
}

test("the outcome domain is exactly the three closed provider values", () => {
	assert.deepEqual([...CORRECTION_OUTCOMES], ["passed", "verification_failed", "procedural_tooling_failed"]);
});

test("an outcome outside the closed domain is rejected with no step and no charge", () => {
	for (const rejected of ["failed", "PASSED", "pass", "ok", "", "verification-failed", "skipped"]) {
		assert.throws(
			() => resolveCorrectionStep(STATUS, evidence(rejected)),
			(error: unknown) => error instanceof CorrectionOutcomeError && /outcome/.test((error as Error).message),
			`outcome ${JSON.stringify(rejected)} must be refused`,
		);
	}
});

test("a missing or non-string outcome is refused rather than defaulted", () => {
	for (const rejected of [undefined, null, 1, true, {}, []]) {
		assert.throws(() => resolveCorrectionStep(STATUS, evidence(rejected as unknown as string)), CorrectionOutcomeError);
	}
});

test("passed is the only outcome that unlocks targeted validation", () => {
	const step = resolveCorrectionStep(STATUS, evidence("passed"));

	assert.equal(step.kind, "run-targeted-validation");
	assert.equal(step.unlocksTargetedValidation, true);
	assert.equal(step.transactionOpen, false);
	assert.equal(Object.hasOwn(step, "escalation"), false);
	// The provider issues the request; Pi must re-query STATUS for it rather
	// than inventing one, which is why the step names the operation instead of
	// carrying a fabricated payload.
	assert.equal(step.expectCaptureOperation, "external.run_targeted_validation");
});

test("verification_failed keeps the transaction open and charges nothing", () => {
	const step = resolveCorrectionStep(STATUS, evidence("verification_failed"));

	assert.equal(step.kind, "recapture-required");
	assert.equal(step.transactionOpen, true);
	assert.equal(step.unlocksTargetedValidation, false);
	assert.equal(step.attemptConsumed, false);
	assert.equal(step.changedLinesCharged, 0);
	assert.equal(step.budgetConsumed, 0);
	assert.equal(step.autoRetry, false);
});

test("verification_failed carries the prior identity as supersedes and demands a NEW capture", () => {
	const first = evidence("verification_failed");
	const step = resolveCorrectionStep(STATUS, first);

	assert.equal(step.kind, "recapture-required");
	assert.equal(step.supersedes, first.evidenceIdentity);
	assert.equal(step.requiresNewCapture, true);
	// It must never hand back a step that resubmits the same candidate bytes.
	assert.notEqual(step.supersedes, undefined);
	assert.equal(Object.hasOwn(step, "resubmitCandidate"), false);
});

test("verification_failed never consumes budget even when lines were already charged", () => {
	const charged = { ...STATUS, changedLinesCharged: 40 };
	const step = resolveCorrectionStep(charged, evidence("verification_failed"));
	assert.equal(step.kind, "recapture-required");

	// The invariant is about what THIS outcome adds, not about resetting prior
	// accounting: a failed verification must not move the needle at all.
	assert.equal(step.budgetConsumed, 0);
	assert.equal(step.changedLinesCharged, 40);
	assert.equal(step.attemptConsumed, false);
});

test("procedural_tooling_failed escalates terminally before any retry is eligible", () => {
	const step = resolveCorrectionStep(STATUS, evidence("procedural_tooling_failed"));

	assert.equal(step.kind, "terminal-escalation");
	assert.equal(step.retryEligible, false);
	assert.equal(step.transactionOpen, false);
	assert.equal(step.unlocksTargetedValidation, false);
	assert.equal(typeof step.escalation, "string");
	assert.match(step.escalation as string, /\S/);
	// No further actor may run after a terminal escalation.
	assert.equal(step.launchesReviewer, false);
	assert.equal(step.launchesValidator, false);
	assert.equal(step.launchesCorrection, false);
});

test("every closed outcome resolves to exactly one distinct step kind", () => {
	const kinds = CORRECTION_OUTCOMES.map((outcome) => resolveCorrectionStep(STATUS, evidence(outcome)).kind);

	assert.equal(new Set(kinds).size, kinds.length, "each outcome must map to its own step kind");
	assert.deepEqual(kinds, ["run-targeted-validation", "recapture-required", "terminal-escalation"]);
});

test("a second capture with a distinct identity and an unchanged prior record is accepted", () => {
	const prior = evidence("verification_failed");
	const next = evidence("passed", { evidenceIdentity: "sha256:" + "b".repeat(64), recordDigest: "sha256:" + "b".repeat(64) });

	assert.doesNotThrow(() => assertDistinctCorrectionEvidence({ prior, next, priorStillResolvable: true, priorRecordDigestNow: prior.recordDigest }));
});

test("a second capture reusing the prior evidence identity is correction-evidence-replaced", () => {
	const prior = evidence("verification_failed");
	const next = evidence("passed");

	assert.throws(
		() => assertDistinctCorrectionEvidence({ prior, next, priorStillResolvable: true, priorRecordDigestNow: prior.recordDigest }),
		(error: unknown) => error instanceof CorrectionEvidenceReplacedError && /correction-evidence-replaced/.test((error as Error).message),
	);
});

test("a prior evidence record whose bytes changed is correction-evidence-replaced", () => {
	const prior = evidence("verification_failed");
	const next = evidence("passed", { evidenceIdentity: "sha256:" + "c".repeat(64), recordDigest: "sha256:" + "c".repeat(64) });

	assert.throws(
		() => assertDistinctCorrectionEvidence({ prior, next, priorStillResolvable: true, priorRecordDigestNow: "sha256:" + "d".repeat(64) }),
		CorrectionEvidenceReplacedError,
	);
});

test("a prior evidence record that no longer resolves is correction-evidence-replaced", () => {
	const prior = evidence("verification_failed");
	const next = evidence("passed", { evidenceIdentity: "sha256:" + "e".repeat(64), recordDigest: "sha256:" + "e".repeat(64) });

	assert.throws(
		() => assertDistinctCorrectionEvidence({ prior, next, priorStillResolvable: false, priorRecordDigestNow: prior.recordDigest }),
		CorrectionEvidenceReplacedError,
	);
});

test("the step machine is pure: repeated calls on frozen input return equal results and mutate nothing", () => {
	const input = Object.freeze(evidence("verification_failed"));
	const snapshot = JSON.stringify({ status: STATUS, input });

	const first = resolveCorrectionStep(STATUS, input);
	const second = resolveCorrectionStep(STATUS, input);

	assert.deepEqual(first, second);
	assert.equal(JSON.stringify({ status: STATUS, input }), snapshot, "inputs must not be mutated");
});
