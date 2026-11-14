import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

const tracking = readFileSync(new URL("../assets/orchestrator-tracking.md", import.meta.url), "utf8");

test("pending and failed assessment never manufacture review entry", () => {
	assert.doesNotMatch(tracking, /close the open slice first, assessing and reviewing|treat the commit as due/);
	assert.match(tracking, /only when `reviewDue` is true or the user explicitly asks/);
	assert.match(tracking, /otherwise preserve the pending boundary/);
	assert.match(tracking, /A task boundary neither authorizes review nor advances a reviewed boundary/);
	assert.match(tracking, /report missing assessment proof/);
	assert.match(tracking, /never infer `reviewDue`, construct a preflight transition/);
});

test("delivered contract preserves consent, authority and risk floor", () => {
	const contract = __testing.readMirroredReviewContractFragment();
	assert.ok(contract);
	assert.match(contract, /mirrored provider bundle 1\.5\.0/);
	assert.match(contract, /only when its `reviewDue` is true.*or the user explicitly asks/);
	assert.match(contract, /Global RDD enabled permits review; it never grants consent for this candidate/);
	assert.match(contract, /prompt prose never creates authority or decides delivery/);
	assert.match(tracking, /lower the tier or infer low risk/);
	assert.match(tracking, /When RDD is disabled, do not start or prompt for RDD; ordinary checks remain/);
});
