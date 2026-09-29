import assert from "node:assert/strict";
import test from "node:test";
import {
	clampDelegatedCount,
	decodeDelegatedSessionCost,
	delegatedSessionCostEvent,
	MAX_DELEGATED_COUNT,
	SESSION_DELEGATED_COST_EVENT,
} from "../lib/session-delegated-cost.ts";
import { ABSENT_COST, reportedCost, type SessionCostTotal } from "../lib/session-usage.ts";

// I2 transport: one versioned topic carries the delegated total between the
// agents extension and the shell. The payload is whitelisted and bounded, and
// the decoder never throws on a missing or malformed value.

const total = (overrides: Partial<SessionCostTotal> = {}): SessionCostTotal => ({ nanoUsd: 500_000_000, complete: true, absent: 0, ...overrides });

test("delegatedSessionCostEvent builds a versioned, bounded payload", () => {
	const event = delegatedSessionCostEvent({ parentSessionId: "s1", seq: 1, total: total(), subagents: 2, at: 1000 });
	assert.deepEqual(event, {
		schema: SESSION_DELEGATED_COST_EVENT,
		parentSessionId: "s1",
		seq: 1,
		nanoUsd: 500_000_000,
		complete: true,
		absent: 0,
		subagents: 2,
		at: 1000,
	});
});

test("delegatedSessionCostEvent refuses out-of-range inputs instead of publishing garbage", () => {
	const base = { parentSessionId: "s1", seq: 1, total: total(), subagents: 2, at: 1000 };
	assert.equal(delegatedSessionCostEvent({ ...base, parentSessionId: "" }), undefined);
	assert.equal(delegatedSessionCostEvent({ ...base, parentSessionId: "x".repeat(257) }), undefined);
	assert.equal(delegatedSessionCostEvent({ ...base, seq: -1 }), undefined);
	assert.equal(delegatedSessionCostEvent({ ...base, total: total({ nanoUsd: -1 }) }), undefined);
	assert.equal(delegatedSessionCostEvent({ ...base, total: total({ nanoUsd: 1.5 }) }), undefined);
	assert.equal(delegatedSessionCostEvent({ ...base, subagents: 5000 }), undefined);
	assert.equal(delegatedSessionCostEvent({ ...base, at: Number.NaN }), undefined);
});

test("decodeDelegatedSessionCost round-trips and rejects malformed payloads", () => {
	const event = delegatedSessionCostEvent({ parentSessionId: "s1", seq: 2, total: total({ complete: false, absent: 1 }), subagents: 1, at: 5 });
	assert.deepEqual(decodeDelegatedSessionCost(event), event);
	// A whitelisted decoder drops extra keys rather than trusting them.
	assert.deepEqual(decodeDelegatedSessionCost({ ...event, extra: "ignored" }), event);
	for (const malformed of [undefined, null, 0, "x", [], {}, { schema: SESSION_DELEGATED_COST_EVENT }, { ...event, schema: "gentle:session-cost:delegated/v2" }, { ...event, seq: -1 }, { ...event, nanoUsd: -1 }, { ...event, complete: "yes" }]) {
		assert.equal(decodeDelegatedSessionCost(malformed), undefined);
	}
});

test("the payload carries provenance, not just a number", () => {
	const event = delegatedSessionCostEvent({ parentSessionId: "s1", seq: 3, total: total({ nanoUsd: 0, complete: false, absent: 2 }), subagents: 2, at: 1 });
	assert.equal(event?.complete, false);
	assert.equal(event?.absent, 2);
	assert.equal(event?.seq, 3);
	// A reported zero with a complete total is legitimate.
	const zero = delegatedSessionCostEvent({ parentSessionId: "s1", seq: 4, total: { nanoUsd: 0, complete: true, absent: 0 }, subagents: 0, at: 1 });
	assert.equal(zero?.complete, true);
	assert.equal(reportedCost(0).nanoUsd, 0);
	assert.deepEqual(ABSENT_COST, { state: "absent" });
});

test("diagnostic counts are clamped so a session with more than 4096 tasks still publishes", () => {
	assert.equal(MAX_DELEGATED_COUNT, 4096);
	assert.equal(clampDelegatedCount(3), 3);
	assert.equal(clampDelegatedCount(5000), 4096);
	// The builder keeps rejecting an out-of-range count from any caller.
	assert.equal(delegatedSessionCostEvent({ parentSessionId: "s1", seq: 5, total: { nanoUsd: 0, complete: true, absent: 5000 }, subagents: 1, at: 1 }), undefined);
	assert.equal(delegatedSessionCostEvent({ parentSessionId: "s1", seq: 6, total: { nanoUsd: 0, complete: true, absent: 0 }, subagents: 5000, at: 1 }), undefined);
	// The publisher's clamped shape is accepted and keeps the exact cost.
	const event = delegatedSessionCostEvent({
		parentSessionId: "s1",
		seq: 7,
		total: { nanoUsd: 196_444_498, complete: false, absent: clampDelegatedCount(5000) },
		subagents: clampDelegatedCount(5000),
		at: 1,
	});
	assert.equal(event?.subagents, 4096);
	assert.equal(event?.absent, 4096);
	assert.equal(event?.nanoUsd, 196_444_498);
});
