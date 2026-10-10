import assert from "node:assert/strict";
import test from "node:test";
import {
	createReviewEventV1,
	validateReviewEventV1,
} from "../lib/review-graph-schema.ts";

const stateHash = "a".repeat(64);

test("event identity commits to canonical body and predecessor", () => {
	const genesis = createReviewEventV1({
		lineage_id: "lineage-a",
		sequence: 0,
		predecessor_event_id: null,
		kind: "lineage-created",
		payload: { initial: true },
		reduced_state_hash: stateHash,
	});
	const next = createReviewEventV1({
		lineage_id: "lineage-a",
		sequence: 1,
		predecessor_event_id: genesis.event_id,
		kind: "operation-completed",
		payload: { result: "done" },
		reduced_state_hash: stateHash,
	});
	assert.equal(validateReviewEventV1(next).event_id, next.event_id);
	assert.notEqual(next.event_id, createReviewEventV1({ ...next.body, predecessor_event_id: "b".repeat(64) }).event_id);
});

test("schema rejects invalid genesis and tampered event identities", () => {
	assert.throws(() => createReviewEventV1({
		lineage_id: "lineage-a",
		sequence: 1,
		predecessor_event_id: null,
		kind: "lineage-created",
		payload: {},
		reduced_state_hash: stateHash,
	}), /genesis/i);
	const event = createReviewEventV1({
		lineage_id: "lineage-a",
		sequence: 0,
		predecessor_event_id: null,
		kind: "lineage-created",
		payload: {},
		reduced_state_hash: stateHash,
	});
	assert.throws(() => validateReviewEventV1({ ...event, event_id: "b".repeat(64) }), /identity/i);
	assert.throws(
		() => createReviewEventV1({ ...event.body, unexpected: true } as typeof event.body),
		/unknown/i,
	);
});

test("event schema commits a canonical reducer transition and input", () => {
	const event = createReviewEventV1({
		lineage_id: "lineage-a",
		sequence: 0,
		predecessor_event_id: null,
		kind: "lineage-created",
		reducer_transition: "start",
		reducer_input: { source: "controller" },
		payload: { initial: true },
		reduced_state_hash: stateHash,
	} as never);
	assert.equal(event.body.reducer_transition, "start");
	assert.deepEqual(event.body.reducer_input, { source: "controller" });
	assert.throws(() => createReviewEventV1({
		lineage_id: "lineage-a",
		sequence: 0,
		predecessor_event_id: null,
		kind: "lineage-created",
		reducer_transition: "start",
		payload: { initial: true },
		reduced_state_hash: stateHash,
	} as never), /transition\/input/i);
	assert.throws(() => createReviewEventV1({
		lineage_id: "lineage-a",
		sequence: 1,
		predecessor_event_id: "b".repeat(64),
		kind: "operation-completed",
		reducer_transition: "forged-transition",
		reducer_input: {},
		payload: {},
		reduced_state_hash: stateHash,
	} as never), /transition/i);
});

test("graph-v1 rejects the discarded ordinary follow-up lifecycle transition", () => {
	assert.throws(() => createReviewEventV1({
		lineage_id: "lineage-a",
		sequence: 1,
		predecessor_event_id: "b".repeat(64),
		kind: "operation-completed",
		reducer_transition: "ordinary-follow-up",
		reducer_input: { followUp: "documentation only" },
		payload: {},
		reduced_state_hash: stateHash,
	} as never), /transition/i);
});
