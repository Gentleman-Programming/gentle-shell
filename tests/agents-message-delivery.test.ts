import assert from "node:assert/strict";
import test from "node:test";
import { createAgentMessageQueue, STALE_NOTIFICATION_MS } from "../lib/agents-message-delivery.ts";

test("delivers live notifications and queries in order for the active session", () => {
	const queue = createAgentMessageQueue();
	queue.enqueueNotification({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "First progress", 1000);
	queue.enqueueQuery({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "q1", "Which branch?", 1050);

	assert.equal(queue.pendingCount(), 2);
	const deliverable = queue.takeDeliverable(1100, "s1", () => true);
	assert.equal(deliverable.length, 2);

	assert.equal(deliverable[0]?.kind, "notification");
	assert.equal(deliverable[0]?.content, "First progress");
	assert.equal(deliverable[0]?.display, false);

	assert.equal(deliverable[1]?.kind, "query");
	assert.match(deliverable[1]?.content ?? "", /Which branch\?/);
	assert.equal(deliverable[1]?.display, true);
	assert.equal(deliverable[1]?.requestId, "q1");

	assert.equal(queue.pendingCount(), 0);
	assert.equal(queue.takeDeliverable(1200, "s1", () => true).length, 0, "messages are delivered at most once");
});

test("a notification from a task that settled before delivery is dropped silently", () => {
	const queue = createAgentMessageQueue();
	queue.enqueueNotification({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "Late notice", 1000);

	// The task finishes and is invalidated before the parent turn boundary.
	queue.invalidateTask("task-1");

	const deliverable = queue.takeDeliverable(1050, "s1", () => false);
	assert.equal(deliverable.length, 0, "notification from settled task must never enter conversation");
});

test("an answered query is consumed and never delivered", () => {
	const queue = createAgentMessageQueue();
	queue.enqueueQuery({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "q1", "Which target?", 1000);

	// Parent replies before queue flush.
	queue.consumeQuery("task-1", "q1");

	const deliverable = queue.takeDeliverable(1050, "s1", () => true);
	assert.equal(deliverable.length, 0, "answered query must not be delivered");
});

test("an expired query is dropped and never delivered", () => {
	const queue = createAgentMessageQueue();
	queue.enqueueQuery({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "q1", "Need approval", 1000);

	// Query times out.
	queue.expireQuery("task-1", "q1");

	const deliverable = queue.takeDeliverable(1050, "s1", () => true);
	assert.equal(deliverable.length, 0, "expired query must not be delivered");
});

test("a notification exceeding the stale window is dropped", () => {
	const queue = createAgentMessageQueue();
	queue.enqueueNotification({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "Slow notice", 1000);

	// Held past the 90-second threshold.
	const deliverable = queue.takeDeliverable(1000 + STALE_NOTIFICATION_MS + 10, "s1", () => true);
	assert.equal(deliverable.length, 0, "stale notification must not be delivered");
});

test("isTaskLive returning false drops messages for non-live tasks", () => {
	const queue = createAgentMessageQueue();
	queue.enqueueNotification({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "Dead task notice", 1000);
	queue.enqueueQuery({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "q1", "Dead task query", 1000);

	const deliverable = queue.takeDeliverable(1050, "s1", (id) => id !== "task-1");
	assert.equal(deliverable.length, 0, "non-live task messages must be dropped");
});

test("session mismatch drops foreign session messages", () => {
	const queue = createAgentMessageQueue();
	queue.enqueueNotification({ id: "task-1", agent: "scout", parentSessionId: "session-old" }, "Old session notice", 1000);

	const deliverable = queue.takeDeliverable(1050, "session-new", () => true);
	assert.equal(deliverable.length, 0, "foreign session message must be dropped");
});

test("deduplicates identical query requests for the same task and requestId", () => {
	const queue = createAgentMessageQueue();
	queue.enqueueQuery({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "q1", "First ask", 1000);
	queue.enqueueQuery({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "q1", "Duplicate ask", 1001);

	assert.equal(queue.pendingCount(), 1);
	const deliverable = queue.takeDeliverable(1050, "s1", () => true);
	assert.equal(deliverable.length, 1);
	assert.match(deliverable[0]!.content, /First ask/);
});

test("dropAll clears everything across session reset", () => {
	const queue = createAgentMessageQueue();
	queue.enqueueNotification({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "Notice", 1000);
	queue.enqueueQuery({ id: "task-1", agent: "scout", parentSessionId: "s1" }, "q1", "Query", 1000);
	assert.equal(queue.pendingCount(), 2);

	queue.dropAll();
	assert.equal(queue.pendingCount(), 0);
	assert.equal(queue.takeDeliverable(1050, "s1", () => true).length, 0);
});
