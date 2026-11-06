import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { BASE_REF_ACCEPTED_FORMS } from "../lib/review-candidate-view.ts";

const BASE_REF_REJECTION_REASONS = ["base-ref-unresolvable", "base-ref-ambiguous", "base-ref-moved", "base-ref-invalid"];

test("a blocked native START base-ref rejection carries the accepted-forms hint", () => {
	for (const reason of BASE_REF_REJECTION_REASONS) {
		const result = __testing.nativeStartRejection(reason);
		assert.equal(result.status, "blocked", reason);
		assert.equal(result.reason, reason, reason);
		assert.equal(result.hint, BASE_REF_ACCEPTED_FORMS, reason);
	}
});

test("a blocked native START rejection for a reason unrelated to base refs carries no hint", () => {
	const result = __testing.nativeStartRejection("committed-only-required");
	assert.equal(result.status, "blocked");
	assert.equal(result.reason, "committed-only-required");
	assert.equal("hint" in result, false);
});

test("a blocked native STATUS base-ref rejection carries the accepted-forms hint", () => {
	for (const reason of BASE_REF_REJECTION_REASONS) {
		const result = __testing.nativeStatusInputRejection(reason);
		assert.equal(result.status, "blocked", reason);
		assert.equal(result.outcome, "native-status-input-invalid", reason);
		assert.equal(result.reason, reason, reason);
		assert.equal(result.hint, BASE_REF_ACCEPTED_FORMS, reason);
	}
});

test("a blocked native STATUS rejection for a reason unrelated to base refs carries no hint", () => {
	const result = __testing.nativeStatusInputRejection("committed-only-required");
	assert.equal(result.status, "blocked");
	assert.equal(result.reason, "committed-only-required");
	assert.equal("hint" in result, false);
});
