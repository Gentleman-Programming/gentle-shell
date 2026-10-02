import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";
import {
	NATIVE_REVIEW_ERROR_CODE,
	NATIVE_REVIEW_MODE_SOURCE,
	NativeReviewCliError,
	NativeReviewCliV216,
	type ExecFileAdapter,
	type NativeReviewCli,
	type NativeReviewAssessRequest,
} from "../lib/native-review-cli.ts";
import {
	decodeReviewAssessmentV1,
	isSmallWriterProfile,
	resolveWriterProfile,
	verificationPlan,
	REVIEW_ASSESSMENT_SCHEMA,
	VERIFICATION_TIER,
	RDD_LINE,
	WRITER_PROFILE,
	NATIVE_REVIEW_OUTCOME,
	type VerificationTier,
	type RddLine,
	type WriterProfile,
	type NativeReviewOutcome,
} from "../lib/review-risk-assessment.ts";
import { consumeReviewMutation, pendingReviewMutation, recordReviewMutation } from "../lib/review-reminder-receipt.ts";

// ---------------------------------------------------------------------------
// gentle-pi#662: decoder for the native `gentle-ai review assess` envelope
// (gentle-ai#4295, landing in parallel -- stubbed here, never invoked as a
// real process).
// ---------------------------------------------------------------------------

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: REVIEW_ASSESSMENT_SCHEMA,
		risk: "medium",
		reasons: [{ code: "touches-auth-path", path: "lib/auth.ts", detail: "matches a high-risk path token" }],
		changed_paths: 2,
		changed_lines: 14,
		candidate: { kind: "current-changes" },
		...overrides,
	};
}

test("decodeReviewAssessmentV1 accepts a well-formed gentle-ai.review-assessment/v1 envelope", () => {
	const decoded = decodeReviewAssessmentV1(validEnvelope());
	assert.equal(decoded.schema, REVIEW_ASSESSMENT_SCHEMA);
	assert.equal(decoded.risk, "medium");
	assert.deepEqual(decoded.reasons, [{ code: "touches-auth-path", path: "lib/auth.ts", detail: "matches a high-risk path token" }]);
	assert.equal(decoded.changedPaths, 2);
	assert.equal(decoded.changedLines, 14);
	assert.deepEqual(decoded.candidate, { kind: "current-changes", baseRef: undefined });
});

test("decodeReviewAssessmentV1 accepts a base-diff candidate with base_ref", () => {
	const decoded = decodeReviewAssessmentV1(validEnvelope({ candidate: { kind: "base-diff", base_ref: "origin/main" } }));
	assert.deepEqual(decoded.candidate, { kind: "base-diff", baseRef: "origin/main" });
});

test("decodeReviewAssessmentV1 accepts passive and high risk values", () => {
	assert.equal(decodeReviewAssessmentV1(validEnvelope({ risk: "passive", reasons: [] })).risk, "passive");
	assert.equal(decodeReviewAssessmentV1(validEnvelope({ risk: "high" })).risk, "high");
});

test("decodeReviewAssessmentV1 rejects a wrong schema", () => {
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ schema: "gentle-ai.review-assessment/v2" })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ schema: undefined })), TypeError);
});

test("decodeReviewAssessmentV1 rejects an unrecognized risk value", () => {
	for (const risk of ["low", "critical", "", 1, null, undefined]) {
		assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ risk })), TypeError, `risk ${JSON.stringify(risk)} must be rejected`);
	}
});

test("decodeReviewAssessmentV1 rejects a malformed shape", () => {
	assert.throws(() => decodeReviewAssessmentV1(null), TypeError);
	assert.throws(() => decodeReviewAssessmentV1("gentle-ai.review-assessment/v1"), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ reasons: "none" })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ changed_paths: -1 })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ changed_lines: 1.5 })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ candidate: { kind: "unknown-kind" } })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ candidate: { kind: "current-changes", base_ref: "" } })), TypeError);
});

// ---------------------------------------------------------------------------
// gentle-pi#1175: the native v2 `assess.schema.json` requires only `code` on a
// reason, and adds `candidate.consumed`, `review_due`, `review_due_reason`,
// and `next_transition`. Older binaries (for example gentle-ai v3.7.0)
// predate those fields; they must decode without invented values.
// ---------------------------------------------------------------------------

function nextTransition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		operation: "review.status",
		command: "gentle-ai",
		arguments: [
			{ name: "review", value: "" },
			{ name: "--cwd", value: "/repo" },
			{ name: "--next-transition", value: "start", token: "opaque-token" },
		],
		...overrides,
	};
}

function newEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return validEnvelope({
		risk: "high",
		candidate: { kind: "current-changes", consumed: false },
		review_due: true,
		review_due_reason: "high_risk",
		next_transition: nextTransition(),
		...overrides,
	});
}

test("decodeReviewAssessmentV1 accepts a reason carrying only code and never synthesizes path or detail", () => {
	const decoded = decodeReviewAssessmentV1(validEnvelope({ reasons: [{ code: "x" }, { code: "y", path: "a.ts" }, { code: "z", detail: "why" }] }));
	assert.deepEqual(decoded.reasons, [{ code: "x" }, { code: "y", path: "a.ts" }, { code: "z", detail: "why" }]);
	assert.equal(Object.hasOwn(decoded.reasons[0], "path"), false);
	assert.equal(Object.hasOwn(decoded.reasons[0], "detail"), false);
});

test("decodeReviewAssessmentV1 rejects a reason with a missing code or an empty/non-string path or detail", () => {
	for (const reason of [
		{},
		{ code: "" },
		{ code: 1 },
		{ path: "a.ts", detail: "why" },
		{ code: "x", path: "" },
		{ code: "x", detail: "" },
		{ code: "x", path: 1 },
		{ code: "x", detail: null },
		"x",
	]) {
		assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ reasons: [reason] })), TypeError, `reason ${JSON.stringify(reason)} must be rejected`);
	}
});

test("decodeReviewAssessmentV1 accepts an older envelope without consumed/review_due/review_due_reason and invents none of them", () => {
	const decoded = decodeReviewAssessmentV1(validEnvelope());
	for (const key of ["reviewDue", "reviewDueReason", "nextTransition"]) {
		assert.equal(Object.hasOwn(decoded, key), false, `${key} must stay absent`);
	}
	assert.equal(Object.hasOwn(decoded.candidate, "consumed"), false, "consumed must stay absent, never defaulted");
});

test("decodeReviewAssessmentV1 decodes consumed, review_due, review_due_reason, and next_transition verbatim", () => {
	const transition = nextTransition();
	const decoded = decodeReviewAssessmentV1(newEnvelope({ next_transition: transition }));
	assert.deepEqual(decoded.candidate, { kind: "current-changes", baseRef: undefined, consumed: false });
	assert.equal(decoded.reviewDue, true);
	assert.equal(decoded.reviewDueReason, "high_risk");
	assert.deepEqual(decoded.nextTransition, nextTransition());
	assert.equal(JSON.stringify(decoded.nextTransition), JSON.stringify(nextTransition()), "next_transition must keep its native key and argument order");

	const consumed = decodeReviewAssessmentV1(newEnvelope({ candidate: { kind: "base-diff", base_ref: "origin/main", consumed: true }, review_due: false, review_due_reason: "already_reviewed", next_transition: undefined }));
	assert.deepEqual(consumed.candidate, { kind: "base-diff", baseRef: "origin/main", consumed: true });
	assert.equal(consumed.reviewDue, false);
	assert.equal(consumed.reviewDueReason, "already_reviewed");
	assert.equal(Object.hasOwn(consumed, "nextTransition"), false);

	for (const pair of CONSISTENT_REVIEW_DUE_PAIRS) {
		assert.equal(decodeReviewAssessmentV1(consistentEnvelope(pair)).reviewDueReason, pair.reason);
	}

	const noToken = decodeReviewAssessmentV1(newEnvelope({ next_transition: nextTransition({ arguments: [] }) }));
	assert.deepEqual(noToken.nextTransition, nextTransition({ arguments: [] }));
});

test("decodeReviewAssessmentV1 rejects malformed consumed, review_due, and review_due_reason values", () => {
	for (const consumed of ["true", 0, null]) {
		assert.throws(() => decodeReviewAssessmentV1(newEnvelope({ candidate: { kind: "current-changes", consumed } })), TypeError, `consumed ${JSON.stringify(consumed)} must be rejected`);
	}
	for (const reviewDueReason of ["low_risk", "", 1, null]) {
		assert.throws(() => decodeReviewAssessmentV1(newEnvelope({ review_due_reason: reviewDueReason })), TypeError, `review_due_reason ${JSON.stringify(reviewDueReason)} must be rejected`);
	}
	for (const reviewDue of ["true", 1, null]) {
		assert.throws(() => decodeReviewAssessmentV1(newEnvelope({ review_due: reviewDue })), TypeError, `review_due ${JSON.stringify(reviewDue)} must be rejected`);
	}
});

// gentle-pi#1175 (T2): the native schema fixes review_due by reason
// (true for high_risk and slice_budget_reached, false for passive,
// under_budget, and already_reviewed), and already_reviewed is reported
// exactly when the candidate is consumed. A contradictory envelope can never
// be trusted as closure evidence, so it fails decoding.
interface ReviewDuePair {
	reason: string;
	due: boolean;
	consumed: boolean;
}

const CONSISTENT_REVIEW_DUE_PAIRS: readonly ReviewDuePair[] = [
	{ reason: "high_risk", due: true, consumed: false },
	{ reason: "slice_budget_reached", due: true, consumed: false },
	{ reason: "passive", due: false, consumed: false },
	{ reason: "under_budget", due: false, consumed: false },
	{ reason: "already_reviewed", due: false, consumed: true },
];

function consistentEnvelope(pair: ReviewDuePair): Record<string, unknown> {
	return newEnvelope({
		candidate: { kind: "current-changes", consumed: pair.consumed },
		review_due: pair.due,
		review_due_reason: pair.reason,
		next_transition: pair.due ? nextTransition() : undefined,
	});
}

test("decodeReviewAssessmentV1 accepts every consistent review_due/review_due_reason/consumed combination", () => {
	for (const pair of CONSISTENT_REVIEW_DUE_PAIRS) {
		const decoded = decodeReviewAssessmentV1(consistentEnvelope(pair));
		assert.equal(decoded.reviewDue, pair.due, pair.reason);
		assert.equal(decoded.reviewDueReason, pair.reason);
		assert.equal(decoded.candidate.consumed, pair.consumed, pair.reason);
	}
	// Without next_transition the due pairs stay consistent too.
	assert.equal(decodeReviewAssessmentV1(newEnvelope({ next_transition: undefined })).reviewDueReason, "high_risk");
});

test("decodeReviewAssessmentV1 rejects a review_due boolean that contradicts review_due_reason", () => {
	for (const pair of CONSISTENT_REVIEW_DUE_PAIRS) {
		const contradictory = newEnvelope({
			candidate: { kind: "current-changes", consumed: pair.consumed },
			review_due: !pair.due,
			review_due_reason: pair.reason,
			next_transition: undefined,
		});
		assert.throws(() => decodeReviewAssessmentV1(contradictory), TypeError, `review_due ${!pair.due} with ${pair.reason} must be rejected`);
	}
});

test("decodeReviewAssessmentV1 rejects already_reviewed unless the candidate is consumed", () => {
	for (const candidate of [{ kind: "current-changes", consumed: false }, { kind: "current-changes" }]) {
		assert.throws(
			() => decodeReviewAssessmentV1(newEnvelope({ candidate, review_due: false, review_due_reason: "already_reviewed", next_transition: undefined })),
			TypeError,
			`already_reviewed with ${JSON.stringify(candidate)} must be rejected`,
		);
	}
});

test("decodeReviewAssessmentV1 rejects a consumed candidate reported with any reason other than already_reviewed", () => {
	for (const pair of CONSISTENT_REVIEW_DUE_PAIRS.filter((entry) => entry.reason !== "already_reviewed")) {
		assert.throws(
			() => decodeReviewAssessmentV1(newEnvelope({
				candidate: { kind: "current-changes", consumed: true },
				review_due: pair.due,
				review_due_reason: pair.reason,
				next_transition: pair.due ? nextTransition() : undefined,
			})),
			TypeError,
			`consumed with ${pair.reason} must be rejected`,
		);
	}
});

test("decodeReviewAssessmentV1 still accepts an older envelope without the review_due pair", () => {
	assert.equal(decodeReviewAssessmentV1(validEnvelope()).risk, "medium");
	assert.equal(Object.hasOwn(decodeReviewAssessmentV1(validEnvelope({ risk: "passive", reasons: [] })), "reviewDue"), false);
});

test("decodeReviewAssessmentV1 rejects only one of the review_due/review_due_reason pair", () => {
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ review_due: false })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ review_due_reason: "passive" })), TypeError);
});

test("decodeReviewAssessmentV1 rejects a malformed next_transition or one not backed by review_due true", () => {
	const malformed: Record<string, unknown>[] = [
		nextTransition({ operation: "review.start" }),
		nextTransition({ extra: true }),
		nextTransition({ command: undefined }),
		nextTransition({ command: "" }),
		nextTransition({ arguments: undefined }),
		nextTransition({ arguments: "--cwd" }),
		nextTransition({ arguments: [{ name: "--cwd", value: "/repo", token: "" }] }),
		nextTransition({ arguments: [{ name: "", value: "/repo" }] }),
		nextTransition({ arguments: [{ name: "--cwd" }] }),
		nextTransition({ arguments: [{ name: "--cwd", value: 1 }] }),
		nextTransition({ arguments: [{ name: "--cwd", value: "/repo", extra: "x" }] }),
		nextTransition({ arguments: [null] }),
	];
	for (const transition of malformed) {
		assert.throws(() => decodeReviewAssessmentV1(newEnvelope({ next_transition: transition })), TypeError, `next_transition ${JSON.stringify(transition)} must be rejected`);
	}
	assert.throws(() => decodeReviewAssessmentV1(newEnvelope({ next_transition: null })), TypeError);
	assert.throws(() => decodeReviewAssessmentV1(newEnvelope({ review_due: false, review_due_reason: "passive" })), TypeError, "next_transition requires review_due true");
	assert.throws(() => decodeReviewAssessmentV1(validEnvelope({ next_transition: nextTransition() })), TypeError, "next_transition requires review_due true");
});

test("decodeReviewAssessmentV1 ignores unknown top-level fields and never projects them", () => {
	const decoded = decodeReviewAssessmentV1(newEnvelope({ future_field: { anything: true } }));
	assert.equal(Object.hasOwn(decoded, "future_field"), false);
	assert.equal(Object.hasOwn(decoded, "futureField"), false);
	assert.equal(decoded.reviewDue, true);
});

// ---------------------------------------------------------------------------
// verificationPlan: every (rdd, risk, profile) combination from gentle-pi#662.
// ---------------------------------------------------------------------------

const RISKS: readonly VerificationTier[] = [VERIFICATION_TIER.PASSIVE, VERIFICATION_TIER.MEDIUM, VERIFICATION_TIER.HIGH, VERIFICATION_TIER.UNASSESSABLE];
const RDD_LINES: readonly RddLine[] = [RDD_LINE.ON, RDD_LINE.OFF, RDD_LINE.UNKNOWN];
const PROFILES: readonly WriterProfile[] = [WRITER_PROFILE.SMALL, WRITER_PROFILE.LARGE];
const NON_CLOSED_OUTCOMES: readonly NativeReviewOutcome[] = [NATIVE_REVIEW_OUTCOME.DECLINED, NATIVE_REVIEW_OUTCOME.UNAVAILABLE, NATIVE_REVIEW_OUTCOME.UNKNOWN];

test("verificationPlan: rdd on + closed, passive risk -> structural readback only regardless of writer profile", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.PASSIVE, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.CLOSED });
		assert.equal(plan.structuralReadbackOnly, true);
		assert.equal(plan.writerSelfVerification, false);
		assert.equal(plan.independentVerifier, false);
	}
});

test("verificationPlan: rdd on + closed, medium/high/unassessable risk -> writer self-verification, no independent verifier", () => {
	for (const risk of [VERIFICATION_TIER.MEDIUM, VERIFICATION_TIER.HIGH, VERIFICATION_TIER.UNASSESSABLE]) {
		for (const writerProfile of PROFILES) {
			const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.CLOSED });
			assert.equal(plan.writerSelfVerification, true, `rdd on+closed, risk ${risk}, profile ${writerProfile}`);
			assert.equal(plan.structuralReadbackOnly, false);
			assert.equal(plan.independentVerifier, false, `the closed native review is the independent check under rdd on for risk ${risk}`);
		}
	}
});

// ---------------------------------------------------------------------------
// gentle-pi#668: the `on` branch holds only while the native review reaches a
// terminal (`closed`) outcome for this candidate. A decline, an unavailable
// review, or an unknown/omitted outcome falls back to the exact same
// risk-gated path as `off` -- declining a review is candidate-scoped and
// never lowers the bar below the RDD-off path.
// ---------------------------------------------------------------------------

test("verificationPlan: rdd on + non-closed outcome behaves exactly like rdd off for every risk/profile combination", () => {
	for (const outcome of NON_CLOSED_OUTCOMES) {
		for (const risk of RISKS) {
			for (const writerProfile of PROFILES) {
				const off = verificationPlan({ rddLine: RDD_LINE.OFF, risk, writerProfile });
				const onFallback = verificationPlan({ rddLine: RDD_LINE.ON, risk, writerProfile, nativeReviewOutcome: outcome });
				assert.equal(onFallback.writerSelfVerification, off.writerSelfVerification, `outcome ${outcome}, risk ${risk}, profile ${writerProfile}`);
				assert.equal(onFallback.structuralReadbackOnly, off.structuralReadbackOnly, `outcome ${outcome}, risk ${risk}, profile ${writerProfile}`);
				assert.equal(onFallback.independentVerifier, off.independentVerifier, `outcome ${outcome}, risk ${risk}, profile ${writerProfile}`);
			}
		}
	}
});

test("verificationPlan: an omitted nativeReviewOutcome under rdd on defaults to unknown (fail closed), exactly like rdd off", () => {
	for (const risk of RISKS) {
		for (const writerProfile of PROFILES) {
			const off = verificationPlan({ rddLine: RDD_LINE.OFF, risk, writerProfile });
			const omitted = verificationPlan({ rddLine: RDD_LINE.ON, risk, writerProfile });
			assert.equal(omitted.writerSelfVerification, off.writerSelfVerification);
			assert.equal(omitted.structuralReadbackOnly, off.structuralReadbackOnly);
			assert.equal(omitted.independentVerifier, off.independentVerifier);
		}
	}
});

test("verificationPlan: on+closed+medium+large -> no verifier", () => {
	const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.MEDIUM, writerProfile: WRITER_PROFILE.LARGE, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.CLOSED });
	assert.equal(plan.independentVerifier, false);
	assert.equal(plan.writerSelfVerification, true);
});

test("verificationPlan: on+declined+medium+large -> no verifier (medium, large)", () => {
	const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.MEDIUM, writerProfile: WRITER_PROFILE.LARGE, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.DECLINED });
	assert.equal(plan.independentVerifier, false);
	assert.equal(plan.writerSelfVerification, true);
});

test("verificationPlan: on+declined+medium+small -> verifier", () => {
	const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.MEDIUM, writerProfile: WRITER_PROFILE.SMALL, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.DECLINED });
	assert.equal(plan.independentVerifier, true);
});

test("verificationPlan: on+declined+high -> verifier", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.HIGH, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.DECLINED });
		assert.equal(plan.independentVerifier, true);
	}
});

test("verificationPlan: on+unavailable+high -> verifier", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.HIGH, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.UNAVAILABLE });
		assert.equal(plan.independentVerifier, true);
	}
});

test("verificationPlan: on+unknown (omitted)+high -> verifier", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.HIGH, writerProfile });
		assert.equal(plan.independentVerifier, true);
	}
});

test("verificationPlan: on+declined+passive -> structural readback", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.ON, risk: VERIFICATION_TIER.PASSIVE, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.DECLINED });
		assert.equal(plan.structuralReadbackOnly, true);
		assert.equal(plan.writerSelfVerification, false);
		assert.equal(plan.independentVerifier, false);
	}
});

test("verificationPlan: off+closed+high -> verifier (outcome ignored)", () => {
	for (const writerProfile of PROFILES) {
		const plan = verificationPlan({ rddLine: RDD_LINE.OFF, risk: VERIFICATION_TIER.HIGH, writerProfile, nativeReviewOutcome: NATIVE_REVIEW_OUTCOME.CLOSED });
		assert.equal(plan.independentVerifier, true);
		assert.equal(plan.writerSelfVerification, true);
	}
});

test("verificationPlan: off/unknown lines ignore nativeReviewOutcome entirely", () => {
	for (const rddLine of [RDD_LINE.OFF, RDD_LINE.UNKNOWN]) {
		for (const risk of RISKS) {
			for (const writerProfile of PROFILES) {
				const withoutOutcome = verificationPlan({ rddLine, risk, writerProfile });
				for (const outcome of Object.values(NATIVE_REVIEW_OUTCOME)) {
					const withOutcome = verificationPlan({ rddLine, risk, writerProfile, nativeReviewOutcome: outcome });
					assert.deepEqual(withOutcome, withoutOutcome, `rddLine ${rddLine}, risk ${risk}, profile ${writerProfile}, outcome ${outcome}`);
				}
			}
		}
	}
});

for (const rddLine of [RDD_LINE.OFF, RDD_LINE.UNKNOWN]) {
	test(`verificationPlan: rdd ${rddLine}, passive risk -> structural readback only, no verifier, no tests`, () => {
		for (const writerProfile of PROFILES) {
			const plan = verificationPlan({ rddLine, risk: VERIFICATION_TIER.PASSIVE, writerProfile });
			assert.equal(plan.structuralReadbackOnly, true);
			assert.equal(plan.writerSelfVerification, false);
			assert.equal(plan.independentVerifier, false);
		}
	});

	test(`verificationPlan: rdd ${rddLine}, medium risk -> independent verifier only for a small writer profile`, () => {
		const large = verificationPlan({ rddLine, risk: VERIFICATION_TIER.MEDIUM, writerProfile: WRITER_PROFILE.LARGE });
		assert.equal(large.writerSelfVerification, true);
		assert.equal(large.structuralReadbackOnly, false);
		assert.equal(large.independentVerifier, false);

		const small = verificationPlan({ rddLine, risk: VERIFICATION_TIER.MEDIUM, writerProfile: WRITER_PROFILE.SMALL });
		assert.equal(small.writerSelfVerification, true);
		assert.equal(small.structuralReadbackOnly, false);
		assert.equal(small.independentVerifier, true, "the small-model bias raises medium to high for verification purposes");
	});

	test(`verificationPlan: rdd ${rddLine}, high or unassessable risk -> writer self-verification plus independent verifier, always`, () => {
		for (const risk of [VERIFICATION_TIER.HIGH, VERIFICATION_TIER.UNASSESSABLE]) {
			for (const writerProfile of PROFILES) {
				const plan = verificationPlan({ rddLine, risk, writerProfile });
				assert.equal(plan.writerSelfVerification, true, `rdd ${rddLine}, risk ${risk}, profile ${writerProfile}`);
				assert.equal(plan.structuralReadbackOnly, false);
				assert.equal(plan.independentVerifier, true, `rdd ${rddLine}, risk ${risk}, profile ${writerProfile}`);
			}
		}
	});
}

test("verificationPlan: an unknown rdd line never lowers a tier relative to off", () => {
	for (const risk of RISKS) {
		for (const writerProfile of PROFILES) {
			const off = verificationPlan({ rddLine: RDD_LINE.OFF, risk, writerProfile });
			const unknown = verificationPlan({ rddLine: RDD_LINE.UNKNOWN, risk, writerProfile });
			assert.equal(unknown.writerSelfVerification, off.writerSelfVerification);
			assert.equal(unknown.structuralReadbackOnly, off.structuralReadbackOnly);
			assert.equal(unknown.independentVerifier, off.independentVerifier);
		}
	}
});

test("verificationPlan: reason is a non-empty distinctive string for every branch", () => {
	for (const rddLine of RDD_LINES) {
		for (const risk of RISKS) {
			for (const writerProfile of PROFILES) {
				const plan = verificationPlan({ rddLine, risk, writerProfile });
				assert.ok(plan.reason.length > 20, `reason too short for ${rddLine}/${risk}/${writerProfile}`);
			}
		}
	}
});

// ---------------------------------------------------------------------------
// Small-writer-profile predicate.
// ---------------------------------------------------------------------------

test("isSmallWriterProfile: true when the resolved effort is low", () => {
	assert.equal(isSmallWriterProfile({ thinking: "low" }), true);
});

test("isSmallWriterProfile: true when the resolved model id carries mini as a whole token, case-insensitively", () => {
	assert.equal(isSmallWriterProfile({ model: { id: "gpt-5-mini" } }), true);
	assert.equal(isSmallWriterProfile({ model: { id: "Claude-Mini-Fast" } }), true);
	assert.equal(isSmallWriterProfile({ model: { id: "openai/gpt-5.4-mini" } }), true, "a path-delimited mini token must still match");
	assert.equal(isSmallWriterProfile({ model: { id: "o4-mini" } }), true);
	assert.equal(isSmallWriterProfile({ model: { id: "claude-mini" } }), true);
	assert.equal(isSmallWriterProfile({ model: { id: "mini-high" } }), true, "mini at the start of the id must still match");
});

test("isSmallWriterProfile: false for a model id where mini is only a bare substring (gemini)", () => {
	assert.equal(isSmallWriterProfile({ model: { id: "gemini" } }), false, "gemini must never match on the mini substring");
	assert.equal(isSmallWriterProfile({ model: { id: "gemini-2.5-pro" } }), false);
	assert.equal(isSmallWriterProfile({ model: { id: "gemini-2.5-flash" } }), false);
});

test("isSmallWriterProfile: false for a large model with medium/high effort", () => {
	assert.equal(isSmallWriterProfile({ model: { id: "claude-opus-4" }, thinking: "high" }), false);
	assert.equal(isSmallWriterProfile({ model: { id: "claude-sonnet-5" }, thinking: "medium" }), false);
	assert.equal(isSmallWriterProfile({ model: { id: "gemini-2.5-pro" }, thinking: "high" }), false);
});

test("isSmallWriterProfile: true (fail closed) when the profile is undefined, empty, or carries only an unrecognized effort with no model id", () => {
	assert.equal(isSmallWriterProfile(undefined), true, "an unknown/omitted profile must fail closed to small, not default to large");
	assert.equal(isSmallWriterProfile({}), true);
	assert.equal(isSmallWriterProfile({ thinking: undefined }), true, "matches how the omitted-input caller shape resolves (thinking key present but undefined)");
});

test("isSmallWriterProfile: false when effort alone is known and not low, even without a model id", () => {
	assert.equal(isSmallWriterProfile({ thinking: "high" }), false, "an explicitly recorded non-low effort is a known-large signal, not an unknown profile");
});

test("resolveWriterProfile maps the predicate to the small/large verificationPlan input", () => {
	assert.equal(resolveWriterProfile({ thinking: "low" }), WRITER_PROFILE.SMALL);
	assert.equal(resolveWriterProfile({ model: { id: "o-mini" } }), WRITER_PROFILE.SMALL);
	assert.equal(resolveWriterProfile({ model: { id: "claude-sonnet-5" }, thinking: "high" }), WRITER_PROFILE.LARGE);
	assert.equal(resolveWriterProfile({ model: { id: "gemini-2.5-pro" }, thinking: "high" }), WRITER_PROFILE.LARGE, "gemini must resolve large, never small on the substring");
});

test("resolveWriterProfile: an unknown or omitted profile fails closed to small, never large", () => {
	assert.equal(resolveWriterProfile(undefined), WRITER_PROFILE.SMALL);
	assert.equal(resolveWriterProfile({}), WRITER_PROFILE.SMALL);
});

// ---------------------------------------------------------------------------
// Tool-level fail-closed path: the `gentle_review` tool's `assess` operation
// (`extensions/gentle-ai.ts`, gentle-pi#662) must treat a native CLI without
// the `assess` verb (an older binary) or a rejected `assess` call (a process
// failure) the same way -- risk "unassessable", which `verificationPlan`
// treats as `high`. `assess` is exposed as a `gentle_review` operation, not a
// dedicated tool, so the fixed `gentle_*` tool registry stays unchanged.

function reviewControllerTool(nativeReviewCli: Partial<NativeReviewCli> | null): { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ content: readonly { type: string; text: string }[]; details: unknown }> } {
	const tools = new Map<string, any>();
	const pi = {
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: nativeReviewCli as NativeReviewCli | null })(pi);
	const tool = tools.get("gentle_review");
	assert.ok(tool, "gentle_review must be registered");
	return tool;
}

const ctx = { cwd: process.cwd() } as ExtensionContext;

test("gentle_review assess: an older binary without the assess verb fails closed to high", async () => {
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "off", cloneLocal: "off", effective: "off", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		// assess intentionally absent: pre-gentle-ai#4295 binary.
	};
	const tool = reviewControllerTool(nativeReviewCli);
	const result = await tool.execute("call-1", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as { risk: string; rddLine: string; plan: { writerSelfVerification: boolean; independentVerifier: boolean; structuralReadbackOnly: boolean } };
	assert.equal(details.risk, VERIFICATION_TIER.UNASSESSABLE);
	assert.equal(details.rddLine, "off");
	assert.equal(details.plan.writerSelfVerification, true);
	assert.equal(details.plan.independentVerifier, true);
	assert.equal(details.plan.structuralReadbackOnly, false);
	const highEquivalent = verificationPlan({ rddLine: "off", risk: VERIFICATION_TIER.HIGH, writerProfile: WRITER_PROFILE.LARGE });
	assert.equal(details.plan.writerSelfVerification, highEquivalent.writerSelfVerification, "unassessable must verify exactly like high");
	assert.equal(details.plan.independentVerifier, highEquivalent.independentVerifier, "unassessable must verify exactly like high");
	assert.equal(details.plan.structuralReadbackOnly, highEquivalent.structuralReadbackOnly, "unassessable must verify exactly like high");
	assert.equal(JSON.parse(result.content[0].text).risk, VERIFICATION_TIER.UNASSESSABLE);
});

test("gentle_review assess: a rejected assess call fails closed to high, and RDD status read failure fails closed to unknown", async () => {
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => {
			throw new Error("native review mode is unavailable");
		},
		assess: async () => {
			throw new Error("native process failed");
		},
	};
	const tool = reviewControllerTool(nativeReviewCli);
	const result = await tool.execute("call-2", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as { risk: string; rddLine: string; reasons: readonly { code: string }[]; plan: { independentVerifier: boolean; writerSelfVerification: boolean } };
	assert.equal(details.risk, VERIFICATION_TIER.UNASSESSABLE);
	assert.equal(details.rddLine, "unknown", "an unresolved RDD status must fail closed to unknown, never on or off");
	assert.equal(details.reasons[0]?.code, "native-assess-unavailable");
	assert.equal(details.plan.writerSelfVerification, true);
	assert.equal(details.plan.independentVerifier, true);
});

test("gentle_review assess: a successful native assessment is reflected directly in the returned plan", async () => {
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		assess: async () => ({
			schema: REVIEW_ASSESSMENT_SCHEMA,
			risk: "passive",
			reasons: [],
			changedPaths: 1,
			changedLines: 3,
			candidate: { kind: "current-changes", baseRef: undefined },
		}),
	};
	const tool = reviewControllerTool(nativeReviewCli);
	const result = await tool.execute("call-3", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as { risk: string; rddLine: string; plan: { structuralReadbackOnly: boolean } };
	assert.equal(details.risk, "passive");
	assert.equal(details.rddLine, "on");
	assert.equal(details.plan.structuralReadbackOnly, true);
});

test("gentle_review assess: baseRef without committedOnly is rejected", async () => {
	const tool = reviewControllerTool({});
	await assert.rejects(
		() => tool.execute("call-4", { operation: "assess", input: JSON.stringify({ baseRef: "origin/main" }) }, undefined, undefined, ctx),
		/committedOnly/,
	);
});

test("gentle_review assess: writerModelId/writerEffort in input select the writer profile, and an omitted profile fails closed to small", async () => {
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "off", cloneLocal: "off", effective: "off", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		assess: async () => ({
			schema: REVIEW_ASSESSMENT_SCHEMA,
			risk: "medium",
			reasons: [],
			changedPaths: 1,
			changedLines: 10,
			candidate: { kind: "current-changes", baseRef: undefined },
		}),
	};
	const tool = reviewControllerTool(nativeReviewCli);

	// Omitted profile + medium + off -> fails closed to small -> independent
	// verifier true (this is the fix for the fail-open finding: an omitted
	// profile must never resolve as permissively as a known large model).
	const omitted = await tool.execute("call-5", { operation: "assess" }, undefined, undefined, ctx);
	assert.equal((omitted.details as { writerProfile: string }).writerProfile, "small");
	assert.equal((omitted.details as { plan: { independentVerifier: boolean } }).plan.independentVerifier, true, "an omitted writer profile must fail closed to small, not default to large");

	// Explicit large profile + medium + off -> independent verifier false.
	const explicitLarge = await tool.execute(
		"call-6",
		{ operation: "assess", input: JSON.stringify({ writerModelId: "claude-sonnet-5", writerEffort: "high" }) },
		undefined,
		undefined,
		ctx,
	);
	assert.equal((explicitLarge.details as { writerProfile: string }).writerProfile, "large");
	assert.equal((explicitLarge.details as { plan: { independentVerifier: boolean } }).plan.independentVerifier, false, "an explicitly recorded large profile must not be forced into the small-model bias");

	const small = await tool.execute("call-7", { operation: "assess", input: JSON.stringify({ writerEffort: "low" }) }, undefined, undefined, ctx);
	assert.equal((small.details as { plan: { independentVerifier: boolean } }).plan.independentVerifier, true, "a low-effort writer profile must trigger the small-model bias");

	// A gemini model id must resolve large, never small on the bare "mini" substring.
	const gemini = await tool.execute("call-8", { operation: "assess", input: JSON.stringify({ writerModelId: "gemini-2.5-pro", writerEffort: "high" }) }, undefined, undefined, ctx);
	assert.equal((gemini.details as { writerProfile: string }).writerProfile, "large", "gemini-2.5-pro must never be tiered as a small model");
	assert.equal((gemini.details as { plan: { independentVerifier: boolean } }).plan.independentVerifier, false);
});

test("gentle_review assess: an explicit nativeReviewOutcome:\"declined\" input falls back to the risk-gated plan even when RDD is on (gentle-pi#668)", async () => {
	const nativeReviewCli: Partial<NativeReviewCli> = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		assess: async () => ({
			schema: REVIEW_ASSESSMENT_SCHEMA,
			risk: "high",
			reasons: [],
			changedPaths: 3,
			changedLines: 40,
			candidate: { kind: "current-changes", baseRef: undefined },
		}),
	};
	const tool = reviewControllerTool(nativeReviewCli);
	const result = await tool.execute("call-9", { operation: "assess", input: JSON.stringify({ nativeReviewOutcome: "declined" }) }, undefined, undefined, ctx);
	const details = result.details as { risk: string; rddLine: string; outcome_source: string; plan: { writerSelfVerification: boolean; independentVerifier: boolean; structuralReadbackOnly: boolean } };
	assert.equal(details.risk, "high");
	assert.equal(details.rddLine, "on", "the rendered RDD line still reads on -- only the verification plan falls back");
	assert.equal(details.outcome_source, "explicit");
	assert.equal(details.plan.writerSelfVerification, true);
	assert.equal(details.plan.independentVerifier, true, "a declined review for this candidate must re-enable the risk-gated independent verifier");
	assert.equal(details.plan.structuralReadbackOnly, false);
});

test("gentle_review assess: an unrecognized nativeReviewOutcome value is rejected", async () => {
	const tool = reviewControllerTool({});
	await assert.rejects(
		() => tool.execute("call-10", { operation: "assess", input: JSON.stringify({ nativeReviewOutcome: "approved" }) }, undefined, undefined, ctx),
		/nativeReviewOutcome/,
	);
});

// gentle-pi#668 correction: keyed per candidate (repository + target
// identity), never repository alone; `closed` is never written to the memo.
function assessOnNativeCli(currentTargetIdentity: () => string): Partial<NativeReviewCli> {
	return {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		assess: async () => ({ schema: REVIEW_ASSESSMENT_SCHEMA, risk: "high", reasons: [], changedPaths: 1, changedLines: 5, candidate: { kind: "current-changes", baseRef: undefined } }),
		targetStatus: (async () => ({ applicability: "current_target", targetIdentity: currentTargetIdentity() })) as NativeReviewCli["targetStatus"],
	};
}

test("gentle_review assess: derivation is bound to the exact candidate recorded, and a caller-declared closed is never trusted without native evidence (gentle-pi#668 correction, gentle-pi#1175)", async (t) => {
	t.after(() => __testing.clearNativeReviewOutcomeMemoForTesting());
	__testing.clearNativeReviewOutcomeMemoForTesting();
	let current = "target-a";
	const tool = reviewControllerTool(assessOnNativeCli(() => current));

	// Nothing recorded for candidate A yet -> unknown, risk-gated.
	const before = (await tool.execute("call-11", { operation: "assess" }, undefined, undefined, ctx)).details as { nativeReviewOutcome: string; outcome_source: string; plan: { independentVerifier: boolean } };
	assert.equal(before.nativeReviewOutcome, "unknown");
	assert.equal(before.outcome_source, "unknown");
	assert.equal(before.plan.independentVerifier, true);

	// Candidate A recorded declined -> assess for A derives it.
	__testing.recordNativeReviewOutcome(ctx.cwd, "target-a", "declined");
	const forA = (await tool.execute("call-12", { operation: "assess" }, undefined, undefined, ctx)).details as { nativeReviewOutcome: string; outcome_source: string; plan: { independentVerifier: boolean } };
	assert.equal(forA.nativeReviewOutcome, "declined");
	assert.equal(forA.outcome_source, "derived");
	assert.equal(forA.plan.independentVerifier, true, "a derived decline re-enables the independent verifier for the matching candidate");

	// Candidate B (different current target) never inherits A's decline --
	// and since closed is never written, an acknowledged A can never leak a
	// closed derivation into B either.
	current = "target-b";
	const forB = (await tool.execute("call-13", { operation: "assess" }, undefined, undefined, ctx)).details as { nativeReviewOutcome: string; outcome_source: string; plan: { independentVerifier: boolean } };
	assert.equal(forB.nativeReviewOutcome, "unknown", "candidate B must never inherit candidate A's recorded outcome");
	assert.equal(forB.outcome_source, "unknown");
	assert.equal(forB.plan.independentVerifier, true);

	// gentle-pi#1175: a caller-declared closed is only a claim. This older
	// assessment carries no candidate.consumed, so it fails closed to unknown.
	const closed = (await tool.execute("call-14", { operation: "assess", input: JSON.stringify({ nativeReviewOutcome: "closed" }) }, undefined, undefined, ctx)).details as { nativeReviewOutcome: string; outcome_source: string; plan: { independentVerifier: boolean; writerSelfVerification: boolean } };
	assert.equal(closed.nativeReviewOutcome, "unknown");
	assert.equal(closed.outcome_source, "unknown");
	assert.equal(closed.plan.writerSelfVerification, true);
	assert.equal(closed.plan.independentVerifier, true, "an uncorroborated closed claim must keep the separate verifier");
});

// ---------------------------------------------------------------------------
// gentle-pi#1175 (T2): closure comes only from the exact native evidence of
// THIS assess call -- candidate.consumed === true, which native writes only
// inside the approved-acknowledgement burn for that exact target identity.
// ---------------------------------------------------------------------------

interface ClosureCliOptions {
	rdd?: "on" | "off";
	risk?: "passive" | "medium" | "high";
	/** undefined models an older binary that reports no consumed/review_due. */
	consumed?: boolean;
	targetIdentity?: () => string;
	unassessable?: boolean;
}

function closureCli(options: ClosureCliOptions): Partial<NativeReviewCli> {
	const rdd = options.rdd ?? "on";
	const risk = options.risk ?? "high";
	const raw = options.consumed === undefined
		? validEnvelope({ risk, reasons: [] })
		: validEnvelope({
			risk,
			reasons: [],
			candidate: { kind: "current-changes", consumed: options.consumed },
			review_due: options.consumed ? false : risk === "high",
			review_due_reason: options.consumed ? "already_reviewed" : risk === "high" ? "high_risk" : risk === "passive" ? "passive" : "under_budget",
		});
	return {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: rdd, cloneLocal: "", effective: rdd, source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } }),
		assess: async () => {
			if (options.unassessable) throw new Error("native process failed");
			return decodeReviewAssessmentV1(raw);
		},
		...(options.targetIdentity === undefined ? {} : {
			targetStatus: (async () => ({ applicability: "current_target", targetIdentity: options.targetIdentity!() })) as unknown as NativeReviewCli["targetStatus"],
		}),
	};
}

interface AssessDetails {
	risk: string;
	nativeReviewOutcome: string;
	outcome_source: string;
	writerProfile: string;
	writerProfileSource: string;
	plan: { writerSelfVerification: boolean; independentVerifier: boolean; structuralReadbackOnly: boolean };
}

async function assessWith(cli: Partial<NativeReviewCli>, input?: Record<string, unknown>, context: ExtensionContext = ctx): Promise<AssessDetails> {
	const params = input === undefined ? { operation: "assess" } : { operation: "assess", input: JSON.stringify(input) };
	return (await reviewControllerTool(cli).execute("closure", params, undefined, undefined, context)).details as AssessDetails;
}

test("gentle_review assess: native consumed true derives closed for this candidate", async () => {
	const details = await assessWith(closureCli({ consumed: true }));
	assert.equal(details.nativeReviewOutcome, "closed");
	assert.equal(details.outcome_source, "derived");
	assert.equal(details.plan.writerSelfVerification, true);
	assert.equal(details.plan.independentVerifier, false, "a natively closed candidate restores the RDD on-path");
});

test("gentle_review assess: a caller-declared closed without native consumed evidence fails closed to unknown", async () => {
	for (const consumed of [false, undefined]) {
		const details = await assessWith(closureCli({ consumed }), { nativeReviewOutcome: "closed" });
		assert.equal(details.nativeReviewOutcome, "unknown", `consumed ${String(consumed)}`);
		assert.equal(details.outcome_source, "unknown");
		assert.equal(details.plan.independentVerifier, true);
	}
});

test("gentle_review assess: a caller-declared closed corroborated by native consumed stays closed", async () => {
	const details = await assessWith(closureCli({ consumed: true }), { nativeReviewOutcome: "closed" });
	assert.equal(details.nativeReviewOutcome, "closed");
	assert.equal(details.outcome_source, "derived", "closure is attributed to the native evidence, not to the caller's claim");
	assert.equal(details.plan.independentVerifier, false);
});

test("gentle_review assess: explicit declined, unavailable, or unknown beats native consumed (only ever raises the bar)", async () => {
	for (const outcome of ["declined", "unavailable", "unknown"]) {
		const details = await assessWith(closureCli({ consumed: true }), { nativeReviewOutcome: outcome });
		assert.equal(details.nativeReviewOutcome, outcome);
		assert.equal(details.outcome_source, "explicit");
		assert.equal(details.plan.independentVerifier, true, `${outcome} must keep the risk-gated verifier`);
	}
});

test("gentle_review assess: a recorded decline for the same candidate beats native consumed and a caller-declared closed", async (t) => {
	t.after(() => __testing.clearNativeReviewOutcomeMemoForTesting());
	__testing.clearNativeReviewOutcomeMemoForTesting();
	__testing.recordNativeReviewOutcome(ctx.cwd, "target-a", "declined");
	const cli = closureCli({ consumed: true, targetIdentity: () => "target-a" });
	for (const input of [undefined, { nativeReviewOutcome: "closed" }]) {
		const details = await assessWith(cli, input);
		assert.equal(details.nativeReviewOutcome, "declined", JSON.stringify(input));
		assert.equal(details.outcome_source, "derived");
		assert.equal(details.plan.independentVerifier, true);
	}
});

test("gentle_review assess: a different candidate never inherits closure or a recorded decline", async (t) => {
	t.after(() => __testing.clearNativeReviewOutcomeMemoForTesting());
	__testing.clearNativeReviewOutcomeMemoForTesting();
	__testing.recordNativeReviewOutcome(ctx.cwd, "target-a", "declined");
	// Candidate B was natively closed: A's recorded decline must not leak into it.
	const closedB = await assessWith(closureCli({ consumed: true, targetIdentity: () => "target-b" }));
	assert.equal(closedB.nativeReviewOutcome, "closed");
	// Candidate C follows B, but its own assessment is not consumed: B's closure never carries over.
	const openC = await assessWith(closureCli({ consumed: false, targetIdentity: () => "target-c" }));
	assert.equal(openC.nativeReviewOutcome, "unknown");
	assert.equal(openC.outcome_source, "unknown");
	assert.equal(openC.plan.independentVerifier, true);
});

test("gentle_review assess: an unassessable candidate is never closed", async () => {
	for (const input of [undefined, { nativeReviewOutcome: "closed" }]) {
		const details = await assessWith(closureCli({ unassessable: true }), input);
		assert.equal(details.risk, VERIFICATION_TIER.UNASSESSABLE);
		assert.equal(details.nativeReviewOutcome, "unknown");
		assert.equal(details.plan.independentVerifier, true);
	}
});

test("gentle_review assess: derived closure only changes the RDD on-path; RDD off plans are unchanged", async () => {
	for (const risk of ["passive", "medium", "high"] as const) {
		for (const consumed of [true, false]) {
			const off = await assessWith(closureCli({ rdd: "off", risk, consumed }), { writerModelId: "claude-sonnet-5", writerEffort: "high" });
			const expectedOff = verificationPlan({ rddLine: RDD_LINE.OFF, risk, writerProfile: WRITER_PROFILE.LARGE });
			assert.deepEqual(off.plan, { ...expectedOff }, `off ${risk} consumed ${consumed}`);
			const on = await assessWith(closureCli({ rdd: "on", risk, consumed }), { writerModelId: "claude-sonnet-5", writerEffort: "high" });
			const expectedOn = verificationPlan({ rddLine: RDD_LINE.ON, risk, writerProfile: WRITER_PROFILE.LARGE, nativeReviewOutcome: consumed ? NATIVE_REVIEW_OUTCOME.CLOSED : NATIVE_REVIEW_OUTCOME.UNKNOWN });
			assert.deepEqual(on.plan, { ...expectedOn }, `on ${risk} consumed ${consumed}`);
		}
	}
});

// ---------------------------------------------------------------------------
// gentle-pi#1175 (T2): the writer profile comes from the runtime-recorded
// mutation receipts for this root; caller input is used only when no pending
// runtime receipt exists.
// ---------------------------------------------------------------------------

interface RuntimeProfileFields {
	writerModelId?: string;
	writerEffort?: string;
}

function receiptContext(): { context: ExtensionContext; record(evidence: RuntimeProfileFields & { toolCallId: string }): void; consumeAll(): void } {
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const session = { getSessionId: () => "assess-session", getBranch: () => entries, getCwd: () => process.cwd() };
	const host = { appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); } };
	const root = workspaceRoot();
	return {
		context: { cwd: process.cwd(), sessionManager: session } as unknown as ExtensionContext,
		record: (evidence) => recordReviewMutation(host, session, root, { source: "direct", toolName: "write", ...evidence }),
		consumeAll: () => consumeReviewMutation(host, session, root, pendingReviewMutation(session, root), "acknowledged", "target"),
	};
}

function workspaceRoot(): string {
	return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" }).trim());
}

const mediumOffCli = (): Partial<NativeReviewCli> => closureCli({ rdd: "off", risk: "medium" });

test("gentle_review assess: the runtime writer profile wins over contradicting caller input", async () => {
	const small = receiptContext();
	small.record({ toolCallId: "w1", writerModelId: "openai/gpt-5-mini", writerEffort: "high" });
	const claimedLarge = await assessWith(mediumOffCli(), { writerModelId: "claude-sonnet-5", writerEffort: "high" }, small.context);
	assert.equal(claimedLarge.writerProfile, "small");
	assert.equal(claimedLarge.writerProfileSource, "runtime");
	assert.equal(claimedLarge.plan.independentVerifier, true, "a caller can never talk a runtime mini writer into a large profile");

	const large = receiptContext();
	large.record({ toolCallId: "w1", writerModelId: "google/gemini-2.5-pro", writerEffort: "high" });
	const claimedSmall = await assessWith(mediumOffCli(), { writerEffort: "low" }, large.context);
	assert.equal(claimedSmall.writerProfile, "large", "gemini must never count as mini");
	assert.equal(claimedSmall.writerProfileSource, "runtime");
	assert.equal(claimedSmall.plan.independentVerifier, false);
});

test("gentle_review assess: any small or unknown pending runtime writer makes the profile small", async () => {
	const cases: Array<{ name: string; receipts: RuntimeProfileFields[] }> = [
		{ name: "missing model id", receipts: [{ writerModelId: "claude-sonnet-5", writerEffort: "high" }, { writerEffort: "high" }] },
		{ name: "no profile at all", receipts: [{}] },
		{ name: "gpt-5-mini", receipts: [{ writerModelId: "claude-sonnet-5", writerEffort: "high" }, { writerModelId: "gpt-5-mini", writerEffort: "high" }] },
		{ name: "low effort", receipts: [{ writerModelId: "claude-sonnet-5", writerEffort: "low" }] },
	];
	for (const entry of cases) {
		const fixture = receiptContext();
		entry.receipts.forEach((receipt, index) => fixture.record({ toolCallId: `w${index}`, ...receipt }));
		const details = await assessWith(mediumOffCli(), { writerModelId: "claude-sonnet-5", writerEffort: "high" }, fixture.context);
		assert.equal(details.writerProfile, "small", entry.name);
		assert.equal(details.writerProfileSource, "runtime", entry.name);
		assert.equal(details.plan.independentVerifier, true, entry.name);
	}

	const known = receiptContext();
	known.record({ toolCallId: "w1", writerModelId: "google/gemini-2.5-pro", writerEffort: "high" });
	known.record({ toolCallId: "w2", writerModelId: "anthropic/claude-sonnet-5", writerEffort: "medium" });
	const details = await assessWith(mediumOffCli(), undefined, known.context);
	assert.equal(details.writerProfile, "large");
	assert.equal(details.writerProfileSource, "runtime");
});

test("gentle_review assess: without pending runtime receipts the caller input path is unchanged", async () => {
	const fixture = receiptContext();
	fixture.record({ toolCallId: "w1", writerModelId: "gpt-5-mini" });
	fixture.consumeAll();
	const caller = await assessWith(mediumOffCli(), { writerModelId: "claude-sonnet-5", writerEffort: "high" }, fixture.context);
	assert.equal(caller.writerProfile, "large", "a consumed runtime receipt is no longer evidence for the next candidate");
	assert.equal(caller.writerProfileSource, "caller");

	const callerSmall = await assessWith(mediumOffCli(), { writerEffort: "low" }, fixture.context);
	assert.equal(callerSmall.writerProfile, "small");
	assert.equal(callerSmall.writerProfileSource, "caller");

	const fallback = await assessWith(mediumOffCli(), undefined, fixture.context);
	assert.equal(fallback.writerProfile, "small");
	assert.equal(fallback.writerProfileSource, "fallback");
	assert.equal(fallback.plan.independentVerifier, true);

	// No session at all behaves exactly the same way.
	const noSession = await assessWith(mediumOffCli());
	assert.equal(noSession.writerProfile, "small");
	assert.equal(noSession.writerProfileSource, "fallback");
});

test("gentle_review assess never requires a lineageId (unlike most other operations)", async () => {
	const tool = reviewControllerTool({});
	// Would throw "Review controller requires a lineageId" if ASSESS were not
	// exempted from that check.
	await assert.doesNotReject(() => tool.execute("call-7", { operation: "assess" }, undefined, undefined, ctx));
});

// ---------------------------------------------------------------------------
// Native reader (`NativeReviewCliV216.assess`, `lib/native-review-cli.ts`):
// mirrors reviewMode's wiring -- bounded subprocess, typed decode, fail closed
// on a non-zero exit or an "unknown command" older binary.
// ---------------------------------------------------------------------------

interface QueuedResult {
	stdout: string;
	stderr?: string;
	exitCode?: number;
}

function queuedAdapter(results: readonly QueuedResult[]): { adapter: ExecFileAdapter; calls: Array<{ arguments: readonly string[]; cwd: string }> } {
	const queue = [...results];
	const calls: Array<{ arguments: readonly string[]; cwd: string }> = [];
	return {
		calls,
		adapter: async (request) => {
			calls.push({ arguments: request.arguments, cwd: request.cwd });
			const result = queue.shift();
			if (result === undefined) throw new Error("unexpected native invocation");
			return { stdout: result.stdout, stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0, signal: null, timedOut: false, outputLimitExceeded: false };
		},
	};
}

function nativeClient(adapter: ExecFileAdapter): NativeReviewCliV216 {
	return new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024);
}

test("gentle_review assess: stderr-only refusal preserves safe actionable diagnostics and fails closed", async () => {
	const queue = queuedAdapter([{ stdout: "", stderr: "untracked scope declaration required; use --untracked-scope=exclude or select; token=hidden-secret", exitCode: 1 }]);
	const client = nativeClient(queue.adapter);
	const tool = reviewControllerTool({ assess: client.assess.bind(client) });
	const result = await tool.execute("refusal", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as { risk: string; reasons: { code: string; detail: string }[]; plan: { independentVerifier: boolean } };
	assert.equal(details.risk, "unassessable");
	assert.equal(details.plan.independentVerifier, true);
	assert.equal(details.reasons[0].code, NATIVE_REVIEW_ERROR_CODE.EMPTY_OUTPUT);
	assert.match(details.reasons[0].detail, /untracked scope declaration required/);
	assert.match(details.reasons[0].detail, /--untracked-scope=exclude/);
	assert.doesNotMatch(JSON.stringify(result), /hidden-secret/);
});

test("gentle_review assess: diagnostic projection is bounded and redacts paths and environment assignments", async () => {
	const queue = queuedAdapter([{ stdout: "", stderr: "untracked declaration required /private/project/file C:\\private\\project\\file PRIVATE_PROJECT=hidden-project token=hidden-token " + "x".repeat(6000), exitCode: 1 }]);
	const client = nativeClient(queue.adapter);
	const tool = reviewControllerTool({ assess: client.assess.bind(client) });
	const result = await tool.execute("private-refusal", { operation: "assess" }, undefined, undefined, ctx);
	const serialized = JSON.stringify(result);
	const detail = (result.details as { reasons: { detail: string }[] }).reasons[0].detail;
	assert.match(detail, /untracked declaration required/);
	assert.ok(detail.length < 4300);
	assert.doesNotMatch(serialized, /hidden-project|hidden-token|private.project|\/package\//);
});

for (const [shape, sensitive] of [
	["lowercase environment", "private_project=hidden-project"],
	["quoted environment", 'private_project="hidden project value"'],
	["credential argument", "--password hidden-credential"],
	["quoted credential argument", '--api-key "hidden credential value"'],
	["POSIX path with spaces", "/private/hidden project/hidden file.ts"],
	["quoted POSIX path", '"/private/hidden project/hidden file.ts"'],
	["Windows path with spaces", String.raw`C:\private\hidden project\hidden file.ts`],
	["quoted Windows path", String.raw`"C:\private\hidden project\hidden file.ts"`],
]) {
	test(`assess diagnostic redacts ${shape} without losing provider guidance`, async () => {
		const queue = queuedAdapter([{ stdout: "", stderr: `${sensitive}\nuntracked scope declaration required; use --untracked-scope=exclude or select`, exitCode: 1 }]);
		const client = nativeClient(queue.adapter);
		const result = await reviewControllerTool({ assess: client.assess.bind(client) }).execute("private-shape", { operation: "assess" }, undefined, undefined, ctx);
		const details = result.details as { risk: string; reasons: { code: string; detail: string }[] };
		assert.equal(details.risk, "unassessable");
		assert.equal(details.reasons[0].code, NATIVE_REVIEW_ERROR_CODE.EMPTY_OUTPUT);
		assert.doesNotMatch(JSON.stringify(result), /hidden|private_project| project|file\.ts|\/private\//);
		assert.match(details.reasons[0].detail, /untracked scope declaration required; use --untracked-scope=exclude or select/);
		assert.ok(details.reasons[0].detail.length < 4300);
	});
}

for (const selection of [
	{ untrackedScope: "exclude", expectedUntrackedInventory: "inventory-v1" },
	{ untrackedScope: "select", expectedUntrackedInventory: "inventory-v1", intendedUntracked: ["new/file.ts", "notes.md"] },
] as const) {
	test(`native and facade assess forward explicit ${selection.untrackedScope} without choosing scope`, async () => {
		const queue = queuedAdapter([{ stdout: JSON.stringify(validEnvelope()) }, { stdout: JSON.stringify(validEnvelope()) }]);
		const client = nativeClient(queue.adapter);
		await client.assess({ cwd: process.cwd(), ...selection });
		const tool = reviewControllerTool({ assess: client.assess.bind(client) });
		const result = await tool.execute("selected", { operation: "assess", input: JSON.stringify({ ...selection, baseRef: "origin/main", committedOnly: true }) }, undefined, undefined, ctx);
		assert.equal((result.details as { risk: string }).risk, "medium");
		const flags = [`--untracked-scope=${selection.untrackedScope}`, "--expected-untracked-inventory=inventory-v1", ...(selection.untrackedScope === "select" ? selection.intendedUntracked.map((path) => `--intended-untracked=${path}`) : [])];
		assert.deepEqual(queue.calls[0].arguments, ["review", "assess", "--cwd", process.cwd(), ...flags, "--json"]);
		assert.deepEqual(queue.calls[1].arguments, ["review", "assess", "--cwd", process.cwd(), "--base-ref", "origin/main", "--committed-only", ...flags, "--json"]);
	});
}

test("native and facade assess reject invalid declarations before launching", async () => {
	const invalid = [
		{ untrackedScope: "exclude" },
		{ expectedUntrackedInventory: "inventory" },
		{ intendedUntracked: ["file.ts"] },
		{ untrackedScope: "all", expectedUntrackedInventory: "inventory" },
		{ untrackedScope: "exclude", expectedUntrackedInventory: "inventory", intendedUntracked: ["file.ts"] },
		{ untrackedScope: "select", expectedUntrackedInventory: "inventory" },
		{ untrackedScope: "select", expectedUntrackedInventory: "inventory", intendedUntracked: [] },
		...[null, 42, "", " inventory", "inventory\n", "inv\u0000entory"].map((expectedUntrackedInventory) => ({ untrackedScope: "exclude", expectedUntrackedInventory })),
		...["/absolute", "C:\\absolute", "dir\\file", ".", "..", "../file", "dir/../file", "dir/./file", "dir//file", "dir/", " file", "file\n"].map((path) => ({ untrackedScope: "select", expectedUntrackedInventory: "inventory", intendedUntracked: [path] })),
		{ untrackedScope: "select", expectedUntrackedInventory: "inventory", intendedUntracked: ["file", "file"] },
		{ untrackedScope: "select", expectedUntrackedInventory: "inventory", intendedUntracked: "file" },
	];
	for (const selection of invalid) {
		const queue = queuedAdapter([]);
		const client = nativeClient(queue.adapter);
		await assert.rejects(() => client.assess({ cwd: process.cwd(), ...selection } as NativeReviewAssessRequest), TypeError);
		const tool = reviewControllerTool({ assess: client.assess.bind(client) });
		await assert.rejects(() => tool.execute("invalid", { operation: "assess", input: JSON.stringify(selection) }, undefined, undefined, ctx));
		assert.equal(queue.calls.length, 0);
	}
});

test("facade assess leaves absent declarations to native and preserves stale-inventory refusal", async () => {
	for (const selection of [{}, { untrackedScope: "exclude", expectedUntrackedInventory: "stale-inventory" }]) {
		const queue = queuedAdapter([{ stdout: "", stderr: "untracked inventory changed; inspect and declare the current inventory", exitCode: 1 }]);
		const client = nativeClient(queue.adapter);
		const tool = reviewControllerTool({ assess: client.assess.bind(client) });
		const result = await tool.execute("stale", { operation: "assess", input: JSON.stringify(selection) }, undefined, undefined, ctx);
		const details = result.details as { risk: string; reasons: { detail: string }[] };
		assert.equal(details.risk, "unassessable");
		assert.match(details.reasons[0].detail, /inventory changed/);
		if (!("untrackedScope" in selection)) assert.deepEqual(queue.calls[0].arguments, ["review", "assess", "--cwd", process.cwd(), "--json"]);
	}
});

test("native assess: decodes a well-formed envelope and sends the exact plain-versioned argv", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify({ schema: REVIEW_ASSESSMENT_SCHEMA, risk: "medium", reasons: [], changed_paths: 1, changed_lines: 2, candidate: { kind: "current-changes" } }) }]);
	const result = await nativeClient(queue.adapter).assess!({ cwd: process.cwd() });
	assert.equal(result.risk, "medium");
	assert.deepEqual(queue.calls[0]?.arguments, ["review", "assess", "--cwd", process.cwd(), "--json"]);
});

test("native assess: passes baseRef/committedOnly through as --base-ref and --committed-only", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify({ schema: REVIEW_ASSESSMENT_SCHEMA, risk: "high", reasons: [], changed_paths: 5, changed_lines: 500, candidate: { kind: "base-diff", base_ref: "origin/main" } }) }]);
	await nativeClient(queue.adapter).assess!({ cwd: process.cwd(), baseRef: "origin/main", committedOnly: true });
	assert.deepEqual(queue.calls[0]?.arguments, ["review", "assess", "--cwd", process.cwd(), "--base-ref", "origin/main", "--committed-only", "--json"]);
});

test("native assess: baseRef requires explicit committedOnly acknowledgement", async () => {
	const queue = queuedAdapter([]);
	await assert.rejects(() => nativeClient(queue.adapter).assess!({ cwd: process.cwd(), baseRef: "origin/main" }), TypeError);
	assert.equal(queue.calls.length, 0, "an invalid request must never reach the subprocess");
});

test("native assess: a non-zero exit (an older binary reporting an unknown command) fails closed with a native error, never a synthesized result", async () => {
	// An older binary without the `assess` verb reports its "unknown command"
	// diagnostic on stderr with nothing on stdout, or writes the same message
	// to stdout instead -- either way the wrapper rejects rather than
	// returning a synthesized envelope; the specific error code depends only
	// on which stream carried the message.
	const emptyStdout = queuedAdapter([{ stdout: "", stderr: "unknown command \"assess\" for \"gentle-ai review\"", exitCode: 1 }]);
	await assert.rejects(
		() => nativeClient(emptyStdout.adapter).assess!({ cwd: process.cwd() }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.EMPTY_OUTPUT,
	);

	const textOnStdout = queuedAdapter([{ stdout: "unknown command \"assess\" for \"gentle-ai review\"", exitCode: 1 }]);
	await assert.rejects(
		() => nativeClient(textOnStdout.adapter).assess!({ cwd: process.cwd() }),
		(error: unknown) => error instanceof NativeReviewCliError && [NATIVE_REVIEW_ERROR_CODE.MALFORMED_JSON, NATIVE_REVIEW_ERROR_CODE.NON_ZERO].includes(error.code),
	);
});

// gentle-pi#1175: the full native path (real decoder through the native CLI
// wrapper) must keep a code-only reason assessable and project the new
// native facts without fabricating them for older envelopes.

test("gentle_review assess: a native envelope whose reasons lack path/detail is assessed, not unassessable", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify(validEnvelope({ reasons: [{ code: "touches-auth-path" }] })) }]);
	const client = nativeClient(queue.adapter);
	const result = await reviewControllerTool({ assess: client.assess.bind(client) }).execute("code-only", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as { risk: string; reasons: Record<string, unknown>[] };
	assert.equal(details.risk, "medium");
	assert.deepEqual(details.reasons, [{ code: "touches-auth-path" }]);
});

test("gentle_review assess: consumed, reviewDue, reviewDueReason, and nextTransition are projected verbatim from native", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify(newEnvelope({ candidate: { kind: "current-changes", consumed: false } })) }]);
	const client = nativeClient(queue.adapter);
	const result = await reviewControllerTool({ assess: client.assess.bind(client) }).execute("new-envelope", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as Record<string, unknown> & { candidate: Record<string, unknown> };
	assert.equal(details.risk, "high");
	assert.equal(details.candidate.consumed, false);
	assert.equal(details.reviewDue, true);
	assert.equal(details.reviewDueReason, "high_risk");
	assert.deepEqual(details.nextTransition, nextTransition());
	const text = JSON.parse(result.content[0].text) as Record<string, unknown>;
	assert.deepEqual(text.nextTransition, nextTransition());
});

test("gentle_review assess: an older native envelope projects no consumed/reviewDue/reviewDueReason/nextTransition", async () => {
	const queue = queuedAdapter([{ stdout: JSON.stringify(validEnvelope()) }]);
	const client = nativeClient(queue.adapter);
	const result = await reviewControllerTool({ assess: client.assess.bind(client) }).execute("old-envelope", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as Record<string, unknown> & { candidate: Record<string, unknown> };
	assert.equal(details.risk, "medium");
	for (const key of ["reviewDue", "reviewDueReason", "nextTransition"]) {
		assert.equal(Object.hasOwn(details, key), false, `${key} must not be fabricated`);
	}
	assert.equal(Object.hasOwn(details.candidate, "consumed"), false, "consumed must not be fabricated");
});

test("gentle_review assess: an unassessable projection omits reason.path instead of emitting an empty string", async () => {
	const result = await reviewControllerTool({}).execute("no-assess", { operation: "assess" }, undefined, undefined, ctx);
	const details = result.details as { risk: string; reasons: Record<string, unknown>[] };
	assert.equal(details.risk, VERIFICATION_TIER.UNASSESSABLE);
	assert.equal(details.reasons.length, 1);
	assert.equal(Object.hasOwn(details.reasons[0], "path"), false);
	assert.equal(typeof details.reasons[0].detail, "string");
	assert.ok((details.reasons[0].detail as string).length > 0);
});

test("native assess: a wrong schema or unrecognized risk value fails closed as schema-incompatible", async () => {
	const wrongSchema = queuedAdapter([{ stdout: JSON.stringify({ schema: "gentle-ai.review-assessment/v2", risk: "medium", reasons: [], changed_paths: 0, changed_lines: 0, candidate: { kind: "current-changes" } }) }]);
	await assert.rejects(
		() => nativeClient(wrongSchema.adapter).assess!({ cwd: process.cwd() }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE,
	);

	const badRisk = queuedAdapter([{ stdout: JSON.stringify({ schema: REVIEW_ASSESSMENT_SCHEMA, risk: "critical", reasons: [], changed_paths: 0, changed_lines: 0, candidate: { kind: "current-changes" } }) }]);
	await assert.rejects(
		() => nativeClient(badRisk.adapter).assess!({ cwd: process.cwd() }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE,
	);
});
