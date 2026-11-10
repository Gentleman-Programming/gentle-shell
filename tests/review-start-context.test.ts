import assert from "node:assert/strict";
import test from "node:test";
import { snapshotReviewStartContext } from "../lib/review-start-context.ts";

test("retained intent cannot be changed through caller-owned lens arrays", () => {
	const lenses = ["review-risk"];
	const context = snapshotReviewStartContext({ lenses, lensesReason: "permission checks", requestContextPath: "/repo/spec.md", policyPath: "/repo/policy.json" });
	lenses.push("review-readability");
	assert.deepEqual(context.lenses, ["review-risk"]);
	assert.equal(Object.isFrozen(context), true);
	assert.equal(Object.isFrozen(context.lenses), true);
	assert.throws(() => { (context.lenses as string[]).push("review-reliability"); }, TypeError);
});

test("intent snapshot never retains provider authority, scope or executable state", () => {
	const request = { focus: "risk", targetIdentity: "stale-target", baseRef: "stale-base", intendedUntracked: ["stale-file"], consentBinding: "old-consent", signal: new AbortController().signal };
	assert.deepEqual(snapshotReviewStartContext(request), { focus: "risk" });
	assert.deepEqual(snapshotReviewStartContext({}), {});
});
