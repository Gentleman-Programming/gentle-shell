import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const text = readFileSync(new URL("../assets/orchestrator-tracking.md", import.meta.url), "utf8");
const policy = text.split("\n").find(line => line.startsWith("When RDD is enabled,"))!;

test("S1: compact tracking preserves candidate and boundary selectors", () => {
	assert.match(policy, /each work-unit commit, assess it with `gentle_review` `\{"operation":"assess"\}` and `\{"baseRef":"<last reviewed boundary>","committedOnly":true\}`/);
	assert.match(policy, /branch point.*reviewed boundary.*next base/);
	assert.match(policy, /not-due `passive` commit needs no review and the boundary advances/);
	assert.match(policy, /`under_budget` stays pending.*until a later commit reaches the budget/);
	assert.match(policy, /(?:high-risk unit follows pending `under_budget` commits, assess the open slice first|Before a high-risk unit, assess any pending `under_budget` slice)/);
	assert.match(policy, /only when `reviewDue` is true or the user explicitly asks; otherwise preserve the pending boundary/);
	assert.match(policy, /A task boundary neither authorizes review nor advances a reviewed boundary/);
});

test("S1-S2: compact tracking preserves proof, risk floor and human control", () => {
	assert.match(policy, /report (?:the )?missing assessment proof/);
	assert.match(policy, /never infer `reviewDue`(?: or|,) construct a preflight transition/);
	assert.match(policy, /(?:never lowers the tier:.*never infer low risk from a failed assessment|If assessment fails or is unavailable,.*lower the tier or infer low risk)/);
	assert.match(policy, /assess `escalate` field.*never lower one/);
	assert.match(policy, /injected Gentle AI.*contract governs.*consent/);
	assert.match(policy, /When RDD is disabled, do not start or prompt for RDD; ordinary checks remain/);
	assert.match(policy, /never enables RDD, replaces its refuter, or answers consent/);
	assert.doesNotMatch(policy, /close the open slice first, assessing and reviewing|treat the commit as due/);
});

test("S2: delivered tracking fits both existing ceilings", () => {
	assert.ok(Buffer.byteLength(text) <= Math.min(10_324, 10_308));
});
