import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_HIGH_PERCENT, ContextHighLatch } from "../lib/context-threshold.ts";

test("warns exactly once when a reading reaches the threshold, then stays silent", () => {
	assert.equal(CONTEXT_HIGH_PERCENT, 90);
	const latch = new ContextHighLatch();
	assert.equal(latch.observe(0), false);
	assert.equal(latch.observe(89.9), false);
	assert.equal(latch.observe(90), true, "the threshold is inclusive");
	for (const percent of [90, 91, 99, 140]) assert.equal(latch.observe(percent), false, `same episode at ${percent}% must not warn again`);
});

test("unknown readings preserve the latch; a below-threshold reading rearms it", () => {
	const latch = new ContextHighLatch();
	assert.equal(latch.observe(95), true);
	assert.equal(latch.observe(null), false, "a null reading after compaction is not a rearm");
	assert.equal(latch.observe(undefined), false);
	assert.equal(latch.observe(96), false, "the same episode cannot warn twice across an unknown reading");
	assert.equal(latch.observe(80), false);
	assert.equal(latch.observe(91), true, "dropping below the threshold starts a new episode");
});

test("only an explicit rearm starts a new episode and non-finite readings never warn", () => {
	const latch = new ContextHighLatch();
	assert.equal(latch.observe(94), true);
	latch.rearm();
	assert.equal(latch.observe(94), true, "a successful compaction or new session rearms");
	assert.equal(latch.observe(94), false);
	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.equal(latch.observe(value), false);
});
