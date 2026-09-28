// Gentle Agents subagent message delivery queue (issue #1162).
//
// Background and foreground child notifications and queries used to be handed
// straight to the host as `deliverAs: "followUp"` messages. Because the host
// only drains the follow-up queue when the parent agent stops calling tools
// entirely, stale notifications and already-answered or expired queries could
// re-enter the conversation long after the child task completed, re-triggering
// the parent LLM unnecessarily (#1162).
//
// This module owns the pending messages instead: the extension enqueues them,
// tracks query answer/timeout/cancellation lifecycle, invalidates messages on
// task completion, and flushes only live, fresh messages at turn boundaries or
// idle using `deliverAs: "steer"`.

export const STALE_NOTIFICATION_MS = 90_000;

export type AgentMessageKind = "notification" | "query";

export interface PendingAgentMessage {
	taskId: string;
	agent: string;
	kind: AgentMessageKind;
	content: string;
	parentSessionId: string;
	requestId?: string;
	display: boolean;
	details: Record<string, unknown>;
	enqueuedAt: number;
}

export interface AgentMessageQueue {
	/** Enqueue an ordinary notification from a subagent. */
	enqueueNotification(
		task: { id: string; agent: string; parentSessionId: string },
		content: string,
		enqueuedAt: number,
	): void;

	/** Enqueue an interactive query from a subagent. */
	enqueueQuery(
		task: { id: string; agent: string; parentSessionId: string },
		requestId: string,
		question: string,
		enqueuedAt: number,
	): void;

	/** Mark a query as consumed (e.g. answered or directly handed off). Prevents subsequent delivery. */
	consumeQuery(taskId: string, requestId: string): void;

	/** Mark a query as expired (timed out or errored). Prevents delivery. */
	expireQuery(taskId: string, requestId: string): void;

	/** Invalidate all pending messages (notifications and queries) for a settled or cancelled task. */
	invalidateTask(taskId: string): void;

	/** Return deliverable messages in enqueue order for the active session, dropping stale/consumed ones. */
	takeDeliverable(
		now: number,
		activeSessionId: string,
		isTaskLive: (taskId: string) => boolean,
	): Array<PendingAgentMessage>;

	/** Return number of pending messages waiting to be delivered. */
	pendingCount(): number;

	/** Discard all pending messages and tracking sets (on session change or shutdown). */
	dropAll(): void;
}

/**
 * Creates an agent message queue that manages pending notifications and queries
 * from subagents, bounding their lifetime and invalidating stale messages upon
 * task settlement or query resolution.
 */
export function createAgentMessageQueue(): AgentMessageQueue {
	let pending: Array<PendingAgentMessage> = [];
	const consumedQueries = new Set<string>();
	const expiredQueries = new Set<string>();
	const invalidatedTasks = new Set<string>();

	const queryKey = (taskId: string, requestId: string) => `${taskId}:${requestId}`;

	return {
		enqueueNotification(task, content, enqueuedAt) {
			if (invalidatedTasks.has(task.id)) return;
			pending.push({
				taskId: task.id,
				agent: task.agent,
				kind: "notification",
				content,
				parentSessionId: task.parentSessionId,
				display: false,
				details: {
					gentleAgents: {
						taskId: task.id,
						agent: task.agent,
						parentSessionId: task.parentSessionId,
						kind: "notification",
					},
				},
				enqueuedAt,
			});
		},

		enqueueQuery(task, requestId, question, enqueuedAt) {
			const key = queryKey(task.id, requestId);
			if (invalidatedTasks.has(task.id) || consumedQueries.has(key) || expiredQueries.has(key)) return;
			if (pending.some((msg) => msg.kind === "query" && msg.taskId === task.id && msg.requestId === requestId)) return;
			pending.push({
				taskId: task.id,
				agent: task.agent,
				kind: "query",
				content: `Subagent ${task.agent} asks:\nTask ID: ${task.id}\nRequest ID: ${requestId}\nQuestion: ${question}`,
				parentSessionId: task.parentSessionId,
				requestId,
				display: true,
				details: {
					gentleAgents: {
						taskId: task.id,
						agent: task.agent,
						parentSessionId: task.parentSessionId,
						requestId,
						kind: "query",
					},
				},
				enqueuedAt,
			});
		},

		consumeQuery(taskId, requestId) {
			const key = queryKey(taskId, requestId);
			consumedQueries.add(key);
			pending = pending.filter((msg) => !(msg.kind === "query" && msg.taskId === taskId && msg.requestId === requestId));
		},

		expireQuery(taskId, requestId) {
			const key = queryKey(taskId, requestId);
			expiredQueries.add(key);
			pending = pending.filter((msg) => !(msg.kind === "query" && msg.taskId === taskId && msg.requestId === requestId));
		},

		invalidateTask(taskId) {
			invalidatedTasks.add(taskId);
			pending = pending.filter((msg) => msg.taskId !== taskId);
		},

		takeDeliverable(now, activeSessionId, isTaskLive) {
			const taken = pending;
			pending = [];
			const deliverable: Array<PendingAgentMessage> = [];

			for (const msg of taken) {
				if (msg.parentSessionId !== activeSessionId) continue;
				if (invalidatedTasks.has(msg.taskId)) continue;
				if (!isTaskLive(msg.taskId)) continue;

				if (msg.kind === "query") {
					const key = queryKey(msg.taskId, msg.requestId!);
					if (consumedQueries.has(key) || expiredQueries.has(key)) continue;
				} else if (msg.kind === "notification") {
					if (now - msg.enqueuedAt >= STALE_NOTIFICATION_MS) continue;
				}

				deliverable.push(msg);
			}

			return deliverable;
		},

		pendingCount() {
			return pending.length;
		},

		dropAll() {
			pending = [];
			consumedQueries.clear();
			expiredQueries.clear();
			invalidatedTasks.clear();
		},
	};
}
