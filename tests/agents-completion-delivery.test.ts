import assert from "node:assert/strict";
import test from "node:test";
import { createCompletionQueue, STALE_COMPLETION_MS } from "../lib/agents-completion-delivery.ts";

// The completion queue owns Gentle Agents' pending background completions so a
// completion is delivered at most once, promptly, and never replays state the
// parent already consumed (issue #867).

interface FakeTask {
	id: string;
}

const task = (id: string): FakeTask => ({ id });

test("STALE_COMPLETION_MS is pinned so tests can rely on the boundary", () => {
	assert.equal(STALE_COMPLETION_MS, 90_000);
});

test("a pending completion is delivered exactly once, in settle order", () => {
	const queue = createCompletionQueue<FakeTask>();
	queue.enqueue(task("t1"), 1000);
	queue.enqueue(task("t2"), 2000);
	const first = queue.takeDeliverable(2000);
	assert.deepEqual(first.map((entry) => entry.task.id), ["t1", "t2"]);
	assert.equal(first[0]!.settledAt, 1000);
	assert.equal(first[0]!.stale, false, "a completion inside the stale window is fresh");
	assert.deepEqual(queue.takeDeliverable(2000), [], "a taken entry is never returned twice");
});

test("duplicate enqueue for a pending task id is a no-op", () => {
	const queue = createCompletionQueue<FakeTask>();
	queue.enqueue(task("t1"), 1000);
	queue.enqueue(task("t1"), 5000);
	assert.deepEqual(queue.takeDeliverable(5000).map((entry) => entry.task.id), ["t1"]);
});

test("duplicate enqueue for a delivered task id is a no-op", () => {
	const queue = createCompletionQueue<FakeTask>();
	queue.enqueue(task("t1"), 1000);
	assert.equal(queue.takeDeliverable(1000).length, 1);
	queue.enqueue(task("t1"), 5000);
	assert.deepEqual(queue.takeDeliverable(5000), []);
});

test("duplicate enqueue for a consumed task id is a no-op", () => {
	const queue = createCompletionQueue<FakeTask>();
	queue.consume("t1");
	queue.enqueue(task("t1"), 1000);
	assert.deepEqual(queue.takeDeliverable(5000), []);
});

test("a consumed entry is dropped and never returned", () => {
	const queue = createCompletionQueue<FakeTask>();
	queue.enqueue(task("t1"), 1000);
	queue.enqueue(task("t2"), 1000);
	queue.consume("t1");
	assert.deepEqual(queue.takeDeliverable(2000).map((entry) => entry.task.id), ["t2"]);
});

test("consume remembers unknown ids so a later completion is suppressed", () => {
	const queue = createCompletionQueue<FakeTask>();
	queue.consume("t9");
	queue.enqueue(task("t9"), 1000);
	assert.deepEqual(queue.takeDeliverable(2000), []);
});

test("consume is idempotent", () => {
	const queue = createCompletionQueue<FakeTask>();
	queue.consume("t1");
	queue.consume("t1");
	queue.enqueue(task("t1"), 1000);
	assert.deepEqual(queue.takeDeliverable(2000), []);
});

test("an entry is stale once now - settledAt reaches STALE_COMPLETION_MS", () => {
	const fresh = createCompletionQueue<FakeTask>();
	fresh.enqueue(task("t1"), 1000);
	assert.equal(fresh.takeDeliverable(1000 + STALE_COMPLETION_MS - 1)[0]!.stale, false);
	const stale = createCompletionQueue<FakeTask>();
	stale.enqueue(task("t1"), 1000);
	assert.equal(stale.takeDeliverable(1000 + STALE_COMPLETION_MS)[0]!.stale, true);
});

test("dropAll discards pending, consumed, and delivered state", () => {
	const queue = createCompletionQueue<FakeTask>();
	queue.enqueue(task("t1"), 1000);
	assert.equal(queue.takeDeliverable(1000).length, 1, "delivered bookkeeping exists");
	queue.enqueue(task("t2"), 1000);
	queue.consume("t3");
	queue.dropAll();
	assert.deepEqual(queue.takeDeliverable(5000), [], "nothing pending survives dropAll");
	queue.enqueue(task("t1"), 5000);
	assert.deepEqual(queue.takeDeliverable(5000).map((entry) => entry.task.id), ["t1"], "the queue is fresh after dropAll");
});
