import assert from "node:assert/strict";
import test from "node:test";
import * as nativeReviewCli from "../lib/native-review-cli.ts";
import {
	CompactReviewContractError,
	parseNativeCompactFinalizeInput,
	toNativeValidatorDocument,
} from "../lib/review-compact-contract.ts";

const REQUEST_HASH = "a".repeat(64);

test("the native client exposes no legacy compact input parser", () => {
	assert.equal("parseNativeCompactFinalizeInput" in nativeReviewCli, false);
});

test("compact finalize parser enforces the final evidence pairing and forecast range", () => {
	assert.throws(
		() => parseNativeCompactFinalizeInput({ cwd: "/repo", final_evidence: "passed" }),
		(error: unknown) => error instanceof CompactReviewContractError && error.code === "field-pair",
	);
	assert.throws(
		() => parseNativeCompactFinalizeInput({ cwd: "/repo", final_verification_passed: true }),
		(error: unknown) => error instanceof CompactReviewContractError && error.code === "field-pair",
	);
	assert.throws(() => parseNativeCompactFinalizeInput({ cwd: "/repo", correction_line_forecast: 0 }), CompactReviewContractError);
	assert.equal(parseNativeCompactFinalizeInput({ cwd: "/repo", correction_line_forecast: 3 }).correction_line_forecast, 3);
	assert.throws(() => parseNativeCompactFinalizeInput({ cwd: "/repo", lineageId: "bad lineage!" }), CompactReviewContractError);
});

test("native finalize preserves arbitrary non-empty evidence text byte-for-byte", () => {
	const evidence = " \tleading evidence\nterminal newlines\n\n";
	assert.equal(parseNativeCompactFinalizeInput({ cwd: "/repo", final_evidence: evidence, final_verification_passed: true }).final_evidence, evidence);
	for (const outcome of ["passed", "verification_failed", "procedural_tooling_failed"] as const) {
		assert.equal(parseNativeCompactFinalizeInput({ cwd: "/repo", final_evidence: evidence, final_verification_outcome: outcome }).final_verification_outcome, outcome);
	}
	assert.throws(() => parseNativeCompactFinalizeInput({ cwd: "/repo", final_evidence: "", final_verification_passed: true }), CompactReviewContractError);
});

test("targeted validation document keeps its strict provider-bound shape", () => {
	const validation = {
		request_hash: REQUEST_HASH,
		correction_ids: ["RISK-001"],
		original_criteria: { passed: true, evidence: ["acceptance passes"] },
		correction_regression: { passed: true, evidence: ["regression suite passes"] },
		fix_caused_findings: [],
		follow_ups: [{ finding_id: "RISK-001", location: "lib/a.ts:1", summary: "Track the remaining cleanup", proof_refs: ["differential-test:covered"] }],
	};
	const parsed = parseNativeCompactFinalizeInput({ cwd: "/repo", validation, final_evidence: "full suite passed", final_verification_passed: true });
	assert.deepEqual(toNativeValidatorDocument(parsed.validation!), {
		original_criteria: validation.original_criteria,
		correction_regression: validation.correction_regression,
		follow_ups: [{ observation: "Track the remaining cleanup", proof_refs: ["differential-test:covered"] }],
	});
	assert.throws(() => parseNativeCompactFinalizeInput({ cwd: "/repo", validation: { ...validation, request_hash: "not-a-digest" }, final_evidence: "evidence", final_verification_passed: true }), CompactReviewContractError);
});
