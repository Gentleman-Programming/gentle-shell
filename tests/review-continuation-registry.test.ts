import assert from "node:assert/strict";
import test from "node:test";
import { ReviewContinuationRegistry, type RetainedReviewContinuation } from "../lib/review-continuation-registry.ts";

const selection = { untrackedScope: "exclude" as const, expectedUntrackedInventory: "inventory", intendedUntracked: [] };
const preStart = { ...selection, targetIdentity: "target", candidateTree: "tree" };
const stop = { selectionBinding: "selection", targetIdentity: "target" };
const route = { workspaceRoot: "/repo", lineageId: "lineage", targetIdentity: "target" };

test("reminder range hints are bound to one mutation without caching assessment outcomes", () => {
	const registry = new ReviewContinuationRegistry();
	registry.retainCommittedRange("/repo", "base", "mutation-1");
	assert.equal(registry.readReminderRange("/repo", "mutation-1"), "base");
	assert.equal(registry.readReminderRange("/repo", "mutation-2"), undefined);
	assert.equal(registry.readReminderRange("/other", "mutation-1"), undefined);
	registry.clearReminderRange("/repo");
	assert.equal(registry.readReminderRange("/repo", "mutation-1"), undefined);
	registry.retainCommittedRange("/repo", "new-base", "mutation-2");
	assert.equal(registry.readReminderRange("/repo", "mutation-1"), undefined);
	assert.equal(registry.readReminderRange("/repo", "mutation-2"), "new-base");
	assert.equal(new ReviewContinuationRegistry().readReminderRange("/repo", "mutation-2"), undefined);
});

test("committed base hints reuse the session registry without replacing lifecycle continuations", () => {
	const backing = new Map<string, RetainedReviewContinuation>();
	const registry = ReviewContinuationRegistry.from(backing);
	registry.retainPreStart("/repo", preStart);
	registry.retainCommittedRange("/repo", "base", "m1");
	assert.equal(registry.readPreStart("/repo")?.targetIdentity, "target");
	assert.equal(ReviewContinuationRegistry.from(backing).readReminderRange("/repo", "m1"), "base");
	assert.equal(new ReviewContinuationRegistry().readReminderRange("/repo", "m1"), undefined);
	assert.equal(registry.readReminderRange("/other", "m1"), undefined);
	registry.retainCommittedRange("/repo", "new-base", "m2");
	assert.equal(registry.readReminderRange("/repo", "m2"), "new-base");
	for (let index = 0; index < 64; index++) registry.retainCapture(`extra-${index}`, route);
	assert.equal(registry.size, 64);
	assert.equal(registry.readReminderRange("/repo", "m2"), undefined, "the existing capacity bound also covers hints");
});

test("four continuation kinds share one capacity and replacement does not refresh insertion order", () => {
	const registry = new ReviewContinuationRegistry();
	registry.retainCommittedRange("/repo", "first", "mutation");
	registry.retainPreStart("/pre", preStart);
	registry.retainStop("/stop", stop);
	for (let index = 0; index < 61; index++) registry.retainCapture(`binding-${index}`, route);
	assert.equal(registry.size, 64);
	registry.retainCommittedRange("/repo", "replacement", "mutation");
	registry.retainCapture("last", route);
	assert.equal(registry.readReminderRange("/repo", "mutation"), undefined);
	assert.equal(registry.readPreStart("/pre")?.candidateTree, "tree");
	assert.equal(registry.readStop("/stop")?.selectionBinding, "selection");
	assert.equal(registry.size, 64);
});

test("deleting and reinserting moves an entry behind older retained entries", () => {
	const registry = new ReviewContinuationRegistry();
	registry.retainPreStart("/repo", preStart);
	registry.retainPreStart("/older", preStart);
	registry.clearPreStart("/repo");
	registry.retainPreStart("/repo", preStart);
	for (let index = 0; index < 63; index++) registry.retainCapture(`binding-${index}`, route);
	assert.equal(registry.readPreStart("/older"), undefined);
	assert.notEqual(registry.readPreStart("/repo"), undefined);
});

test("pre-start and stop entries share one worktree slot", () => {
	const registry = new ReviewContinuationRegistry();
	registry.retainStop("/repo", stop);
	assert.equal(registry.readPreStart("/repo"), undefined);
	registry.retainPreStart("/repo", preStart);
	assert.equal(registry.readStop("/repo"), undefined);
	assert.equal(registry.size, 1);
	registry.clearPreStart("/repo");
	assert.equal(registry.readPreStart("/repo"), undefined);
});

test("capture cleanup keeps current bindings and other workspaces, lineages and sessions", () => {
	const registry = new ReviewContinuationRegistry(), otherSession = new ReviewContinuationRegistry();
	registry.retainCapture("keep", route);
	registry.retainCapture("expired", route);
	registry.retainCapture("other-root", { ...route, workspaceRoot: "/other" });
	registry.retainCapture("other-lineage", { ...route, lineageId: "other" });
	registry.retainPreStart("/repo", preStart);
	otherSession.retainCapture("expired", route);
	registry.clearCaptureRoutes("/repo", "lineage", ["keep"]);
	assert.equal(registry.readCapture("expired"), undefined);
	for (const binding of ["keep", "other-root", "other-lineage"]) assert.notEqual(registry.readCapture(binding), undefined);
	registry.clearCaptureRoutes("/repo", "lineage");
	assert.equal(registry.readCapture("keep"), undefined);
	assert.notEqual(registry.readPreStart("/repo"), undefined);
	assert.notEqual(otherSession.readCapture("expired"), undefined);
	assert.equal(registry.readPreStart("/other"), undefined);
});

test("Map test seam uses the same discriminated entries without copying retained state", () => {
	const backing = new Map<string, RetainedReviewContinuation>();
	const first = ReviewContinuationRegistry.from(backing), next = ReviewContinuationRegistry.from(backing);
	first.retainPreStart("/repo", preStart);
	assert.equal(backing.size, 1);
	assert.equal([...backing.values()][0].kind, "pre-start");
	assert.deepEqual(next.readPreStart("/repo"), preStart, "the reader omits internal tags");
	first.retainCapture("binding", route);
	assert.deepEqual(next.readCapture("binding"), route);
	next.clearPreStart("/repo");
	assert.equal(first.size, 1);
});
