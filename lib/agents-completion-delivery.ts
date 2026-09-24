// Gentle Agents completion delivery queue (issue #867).
//
// A background subagent completion used to be handed straight to the host as a
// `deliverAs: "followUp"` message, but the host only flushes that queue when
// the parent agent stops calling tools entirely. In a long orchestrator run
// the notification could therefore land tens of minutes after the parent
// already pulled the same result through subagent_result. This module owns the
// pending completions instead: the extension enqueues at settle time, decides
// freshness at flush time, and drops whatever the parent already consumed. It
// is dependency-free and clock-agnostic: every timestamp is passed in, so the
// behavior is unit-testable against a fake clock.

/**
 * A completion older than this at flush time is stale: the parent had many
 * turns to pull the result with subagent_result, so replaying it into the
 * model context would re-enter state the conversation may already have used.
 * Ninety seconds comfortably covers one slow orchestrator turn (model latency
 * plus a few tool calls) while staying orders of magnitude below the 50-58
 * minute followUp delays measured in issue #867.
 */
export const STALE_COMPLETION_MS = 90_000;

export interface DeliverableCompletion<T> {
	/** The settled task exactly as enqueued. */
	task: T;
	/** Clock value passed to enqueue when the task settled. */
	settledAt: number;
	/** True once now - settledAt has reached STALE_COMPLETION_MS. */
	stale: boolean;
}

export interface CompletionQueue<T extends { id: string }> {
	/** Record a settled completion. At most one record per task id; a duplicate enqueue for a delivered, pending, or consumed id is a no-op. */
	enqueue(task: T, settledAt: number): void;
	/** Mark a task's result as already consumed by the parent. Idempotent; unknown ids are remembered so a later completion is suppressed. */
	consume(taskId: string): void;
	/** Remove and return the still-pending completions in settle order, each with its staleness decision at `now`. Consumed entries are dropped and never returned. */
	takeDeliverable(now: number): Array<DeliverableCompletion<T>>;
	/** Discard everything: pending completions and consumed/delivered bookkeeping. Used on session start and shutdown so nothing replays after a resume. */
	dropAll(): void;
}

export function createCompletionQueue<T extends { id: string }>(): CompletionQueue<T> {
	let pending: Array<{ task: T; settledAt: number }> = [];
	const consumed = new Set<string>();
	const delivered = new Set<string>();
	return {
		enqueue(task, settledAt) {
			if (consumed.has(task.id) || delivered.has(task.id) || pending.some((entry) => entry.task.id === task.id)) return;
			pending.push({ task, settledAt });
		},
		consume(taskId) {
			consumed.add(taskId);
		},
		takeDeliverable(now) {
			const taken = pending;
			pending = [];
			const deliverable: Array<DeliverableCompletion<T>> = [];
			for (const entry of taken) {
				if (consumed.has(entry.task.id)) continue;
				delivered.add(entry.task.id);
				deliverable.push({ task: entry.task, settledAt: entry.settledAt, stale: now - entry.settledAt >= STALE_COMPLETION_MS });
			}
			return deliverable;
		},
		dropAll() {
			pending = [];
			consumed.clear();
			delivered.clear();
		},
	};
}
