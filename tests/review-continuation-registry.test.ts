import assert from "node:assert/strict";
import test from "node:test";
import { ReviewContinuationRegistry, type RetainedReviewContinuation } from "../lib/review-continuation-registry.ts";

const selection = { untrackedScope: "exclude" as const, expectedUntrackedInventory: "inventory", intendedUntracked: [] };
const preStart = { ...selection, targetIdentity: "target", candidateTree: "tree" };
const stop = { selectionBinding: "selection", targetIdentity: "target" };
const route = { workspaceRoot: "/repo", lineageId: "lineage", targetIdentity: "target" };

test("committed base hints reuse the session registry without replacing lifecycle continuations", () => {
	const backing = new Map<string, RetainedReviewContinuation>();
	const registry = ReviewContinuationRegistry.from(backing);
	registry.retainPreStart("/repo", preStart);
	registry.retainCommittedRange("/repo", "base");
	assert.equal(registry.readPreStart("/repo")?.targetIdentity, "target");
	assert.equal(ReviewContinuationRegistry.from(backing).readCommittedRange("/repo"), "base");
	assert.equal(new ReviewContinuationRegistry().readCommittedRange("/repo"), undefined);
	assert.equal(registry.readCommittedRange("/other"), undefined);
	registry.retainCommittedRange("/repo", "new-base");
	assert.equal(registry.readCommittedRange("/repo"), "new-base");
	for (let index = 0; index < 64; index++) registry.retainCapture(`extra-${index}`, route);
	assert.equal(registry.size, 64);
	assert.equal(registry.readCommittedRange("/repo"), undefined, "the existing capacity bound also covers hints");
});

test("four continuation kinds share one capacity and replacement does not refresh insertion order", () => {
	const registry = new ReviewContinuationRegistry();
	registry.retainSelection("/repo", "first", selection);
	registry.retainPreStart("/pre", preStart);
	registry.retainStop("/stop", stop);
	for (let index = 0; index < 61; index++) registry.retainCapture(`binding-${index}`, route);
	assert.equal(registry.size, 64);
	registry.retainSelection("/repo", "first", { ...selection, expectedUntrackedInventory: "replacement" });
	registry.retainCapture("last", route);
	assert.equal(registry.readSelection("/repo", "first"), undefined);
	assert.equal(registry.readPreStart("/pre")?.candidateTree, "tree");
	assert.equal(registry.readStop("/stop")?.selectionBinding, "selection");
	assert.equal(registry.size, 64);
});

test("deleting and reinserting moves an entry behind older retained entries", () => {
	const registry = new ReviewContinuationRegistry();
	registry.retainSelection("/repo", "reinserted", selection);
	registry.retainPreStart("/older", preStart);
	registry.clearSelection("/repo", "reinserted");
	registry.retainSelection("/repo", "reinserted", selection);
	for (let index = 0; index < 63; index++) registry.retainCapture(`binding-${index}`, route);
	assert.equal(registry.readPreStart("/older"), undefined);
	assert.notEqual(registry.readSelection("/repo", "reinserted"), undefined);
});

test("pre-start entries replace stop entries but cannot be read as lineage selections", () => {
	const registry = new ReviewContinuationRegistry();
	registry.retainStop("/repo", stop);
	assert.equal(registry.readPreStart("/repo"), undefined);
	registry.retainPreStart("/repo", preStart);
	assert.equal(registry.readStop("/repo"), undefined);
	assert.equal(registry.readSelection("/repo", ""), undefined);
	assert.equal(registry.size, 1);
});

test("capture cleanup keeps current bindings and other workspaces, lineages and sessions", () => {
	const registry = new ReviewContinuationRegistry(), otherSession = new ReviewContinuationRegistry();
	registry.retainCapture("keep", route);
	registry.retainCapture("expired", route);
	registry.retainCapture("other-root", { ...route, workspaceRoot: "/other" });
	registry.retainCapture("other-lineage", { ...route, lineageId: "other" });
	registry.retainSelection("/repo", "lineage", selection);
	otherSession.retainCapture("expired", route);
	registry.clearCaptureRoutes("/repo", "lineage", ["keep"]);
	assert.equal(registry.readCapture("expired"), undefined);
	for (const binding of ["keep", "other-root", "other-lineage"]) assert.notEqual(registry.readCapture(binding), undefined);
	registry.clearCaptureRoutes("/repo", "lineage");
	assert.equal(registry.readCapture("keep"), undefined);
	assert.notEqual(registry.readSelection("/repo", "lineage"), undefined);
	assert.notEqual(otherSession.readCapture("expired"), undefined);
	assert.equal(registry.readSelection("/other", "lineage"), undefined);
});

test("Map test seam uses the same discriminated entries without copying retained state", () => {
	const backing = new Map<string, RetainedReviewContinuation>();
	const first = ReviewContinuationRegistry.from(backing), next = ReviewContinuationRegistry.from(backing);
	first.retainSelection("/repo", "lineage", selection);
	assert.equal(backing.size, 1);
	assert.equal([...backing.values()][0].kind, "selection");
	assert.notEqual(next.readSelection("/repo", "lineage"), undefined);
	assert.equal("kind" in next.readSelection("/repo", "lineage")!, false, "internal tags never enter native requests");
	first.retainCapture("binding", route);
	assert.deepEqual(next.readCapture("binding"), route);
	next.clearSelection("/repo", "lineage");
	assert.equal(first.size, 1);
});
