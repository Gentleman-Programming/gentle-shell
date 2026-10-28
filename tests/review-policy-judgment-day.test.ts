import assert from "node:assert/strict";
import test from "node:test";
import {
	EVIDENCE_CLASS,
	REVIEW_MODE,
	REVIEW_PHASE,
	RESOLUTION_OUTCOME,
	TERMINAL_STATE,
	createReviewState,
	type CanonicalFrozenRowV1,
	type ReviewStateV1,
} from "../lib/review-transaction.ts";
import {
	applyJudgmentDayFix,
	judgmentDayRejudgmentRequest,
	recordJudgmentDayDiscovery,
	recordJudgmentDayFinalVerification,
	recordJudgmentDayRejudgment,
} from "../lib/review-policy-judgment-day.ts";
import { REVIEW_ROUTE } from "../lib/review-triggers.ts";
import { testSnapshot } from "./review-test-fixtures.ts";

const TREE = {
	BASE: "1".repeat(40),
	SNAPSHOT: "2".repeat(40),
	FIX_ONE: "3".repeat(40),
	FIX_TWO: "4".repeat(40),
} as const;

function judgmentDayState(mode: ReviewStateV1["mode"] = REVIEW_MODE.JUDGMENT_DAY): ReviewStateV1 {
	return createReviewState({
		lineageId: "judgment-day-lineage",
		mode,
		snapshot: testSnapshot({
			mode,
			baseTree: TREE.BASE,
			completeTree: TREE.SNAPSHOT,
			route: REVIEW_ROUTE.TRIVIAL,
			lenses: [],
		}),
		evidenceHash: "b".repeat(64),
		budget: {
			review_batches: 1,
			review_actors: 2,
			refuter_batches: 0,
			fix_batches: 2,
			validator_runs: 0,
			final_verifications: 1,
			judgment_rounds: 2,
			judge_runs: 6,
		},
	});
}

function finding(id: string, severity: "BLOCKER" | "CRITICAL" = "CRITICAL"): CanonicalFrozenRowV1 {
	return {
		id,
		lens: "judgment-day",
		location: "src/review.ts:42",
		severity,
		status_at_freeze: "open",
		evidence_class: EVIDENCE_CLASS.INFERENTIAL_SEVERE,
		evidence_claim: `${id} has concrete user impact.`,
	};
}

test("explicit Judgment Day starts with exactly two blind judges and zero refuters", () => {
	const discovered = recordJudgmentDayDiscovery(judgmentDayState(), {
		judgeA: [finding("JD-A-001")],
		judgeB: [finding("JD-B-001", "BLOCKER")],
	});
	assert.equal(discovered.phase, REVIEW_PHASE.JUDGMENT_COMPLETE);
	assert.equal(discovered.counters.review_batches, 1);
	assert.equal(discovered.counters.review_actors, 2);
	assert.equal(discovered.counters.judge_runs, 2);
	assert.equal(discovered.counters.refuter_batches, 0);
	assert.deepEqual(discovered.active_finding_ids, ["JD-A-001", "JD-B-001"]);
	assert.throws(
		() =>
			recordJudgmentDayDiscovery(discovered, {
				judgeA: [],
				judgeB: [],
			}),
		/discovery.*only.*started/i,
	);
});

test("Judgment Day with no severe findings skips fixes and re-judgment then verifies once", () => {
	const ready = recordJudgmentDayDiscovery(judgmentDayState(), {
		judgeA: [],
		judgeB: [],
	});
	assert.equal(ready.phase, REVIEW_PHASE.FINAL_VERIFICATION);
	assert.equal(ready.counters.fix_batches, 0);
	assert.equal(ready.counters.judgment_rounds, 0);
	assert.equal(ready.counters.judge_runs, 2);
	assert.throws(() => judgmentDayRejudgmentRequest(ready), /fix.*required/i);
	const terminal = recordJudgmentDayFinalVerification(ready, { passed: true });
	assert.equal(terminal.terminal_state, TERMINAL_STATE.APPROVED);
	assert.equal(terminal.counters.final_verifications, 1);
});

test("Judgment Day permits at most two scoped fix and re-judgment rounds", () => {
	const discovered = recordJudgmentDayDiscovery(judgmentDayState(), {
		judgeA: [finding("JD-A-001")],
		judgeB: [],
	});
	const fixedOne = applyJudgmentDayFix(discovered, {
		candidateTree: TREE.FIX_ONE,
		fixedIds: ["JD-A-001"],
		fixDiff: "round one fix",
	});
	const requestOne = judgmentDayRejudgmentRequest(fixedOne);
	assert.deepEqual(requestOne.requested_ids, ["JD-A-001"]);
	assert.equal(requestOne.fix_diff, "round one fix");
	const roundOne = recordJudgmentDayRejudgment(fixedOne, {
		request: requestOne,
		judgeAResults: [
			{ id: "JD-A-001", outcome: RESOLUTION_OUTCOME.CORROBORATED },
		],
		judgeBResults: [
			{ id: "JD-A-001", outcome: RESOLUTION_OUTCOME.VERIFIED },
		],
	});
	assert.equal(roundOne.phase, REVIEW_PHASE.JUDGMENT_COMPLETE);
	assert.deepEqual(roundOne.active_finding_ids, ["JD-A-001"]);
	assert.equal(roundOne.counters.fix_batches, 1);
	assert.equal(roundOne.counters.judgment_rounds, 1);
	assert.equal(roundOne.counters.judge_runs, 4);
	assert.equal(roundOne.counters.refuter_batches, 0);

	const fixedTwo = applyJudgmentDayFix(roundOne, {
		candidateTree: TREE.FIX_TWO,
		fixedIds: ["JD-A-001"],
		fixDiff: "round two fix",
	});
	const requestTwo = judgmentDayRejudgmentRequest(fixedTwo);
	const roundTwo = recordJudgmentDayRejudgment(fixedTwo, {
		request: requestTwo,
		judgeAResults: [
			{ id: "JD-A-001", outcome: RESOLUTION_OUTCOME.VERIFIED },
		],
		judgeBResults: [
			{ id: "JD-A-001", outcome: RESOLUTION_OUTCOME.VERIFIED },
		],
	});
	assert.equal(roundTwo.phase, REVIEW_PHASE.FINAL_VERIFICATION);
	assert.deepEqual(roundTwo.active_finding_ids, []);
	assert.equal(roundTwo.counters.fix_batches, 2);
	assert.equal(roundTwo.counters.judgment_rounds, 2);
	assert.equal(roundTwo.counters.judge_runs, 6);
	assert.equal(roundTwo.counters.refuter_batches, 0);
	assert.equal(
		recordJudgmentDayFinalVerification(roundTwo, { passed: true }).terminal_state,
		TERMINAL_STATE.APPROVED,
	);
});

test("findings surviving round two escalate and expose no third-round edge", () => {
	const discovered = recordJudgmentDayDiscovery(judgmentDayState(), {
		judgeA: [finding("JD-A-001")],
		judgeB: [],
	});
	const roundOneFix = applyJudgmentDayFix(discovered, {
		candidateTree: TREE.FIX_ONE,
		fixedIds: ["JD-A-001"],
		fixDiff: "first",
	});
	const roundOne = recordJudgmentDayRejudgment(roundOneFix, {
		request: judgmentDayRejudgmentRequest(roundOneFix),
		judgeAResults: [
			{ id: "JD-A-001", outcome: RESOLUTION_OUTCOME.CORROBORATED },
		],
		judgeBResults: [
			{ id: "JD-A-001", outcome: RESOLUTION_OUTCOME.CORROBORATED },
		],
	});
	const roundTwoFix = applyJudgmentDayFix(roundOne, {
		candidateTree: TREE.FIX_TWO,
		fixedIds: ["JD-A-001"],
		fixDiff: "second",
	});
	const exhausted = recordJudgmentDayRejudgment(roundTwoFix, {
		request: judgmentDayRejudgmentRequest(roundTwoFix),
		judgeAResults: [
			{ id: "JD-A-001", outcome: RESOLUTION_OUTCOME.CORROBORATED },
		],
		judgeBResults: [
			{ id: "JD-A-001", outcome: RESOLUTION_OUTCOME.VERIFIED },
		],
	});
	assert.equal(exhausted.phase, REVIEW_PHASE.FINAL_VERIFICATION);
	assert.match(exhausted.escalation_reasons!.at(-1)!, /survived Judgment Day round two/i);
	assert.throws(
		() =>
			applyJudgmentDayFix(exhausted, {
				candidateTree: TREE.FIX_TWO,
				fixedIds: ["JD-A-001"],
				fixDiff: "forbidden third",
			}),
		/fix.*only.*judgment-complete/i,
	);
	const terminal = recordJudgmentDayFinalVerification(exhausted, { passed: true });
	assert.equal(terminal.terminal_state, TERMINAL_STATE.ESCALATED);
});

test("Judgment Day reducer rejects ordinary mode without changing its counters", () => {
	const ordinary = judgmentDayState(REVIEW_MODE.ORDINARY);
	const before = structuredClone(ordinary.counters);
	assert.throws(
		() => recordJudgmentDayDiscovery(ordinary, { judgeA: [], judgeB: [] }),
		/Judgment Day reducer requires judgment-day mode/i,
	);
	assert.deepEqual(ordinary.counters, before);
});
