import assert from "node:assert/strict";
import test from "node:test";
import { committedRangeUntrackedExclusion, type NativeReviewCli } from "../lib/native-review-cli.ts";

const cliWith = (targetStatus: (request: unknown) => Promise<unknown>) => ({ targetStatus }) as unknown as NativeReviewCli;

test("#3169: a committed range declares the native untracked inventory as excluded", async () => {
	const requests: Array<Record<string, unknown>> = [];
	const cli = cliWith(async request => { requests.push(request as Record<string, unknown>); return { eligibleUntrackedInventory: "sha256:inventory" }; });
	assert.deepEqual(await committedRangeUntrackedExclusion(cli, "/repo", "base"), { untrackedScope: "exclude", expectedUntrackedInventory: "sha256:inventory" });
	assert.deepEqual(requests, [{ cwd: "/repo", baseRef: "base", committedOnly: true, agent: "pi" }]);
});

test("#3169: without a native inventory nothing is declared", async () => {
	assert.deepEqual(await committedRangeUntrackedExclusion(cliWith(async () => ({})), "/repo", "base"), {});
	assert.deepEqual(await committedRangeUntrackedExclusion(cliWith(async () => { throw new Error("status unavailable"); }), "/repo", "base"), {});
	assert.deepEqual(await committedRangeUntrackedExclusion(null, "/repo", "base"), {});
});
