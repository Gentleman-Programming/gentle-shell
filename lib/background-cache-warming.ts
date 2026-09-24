import type { TaskRecord } from "./agents-protocol.ts";

const ACTION = { WARM: "warm", STOP: "stop" } as const;
type WarmingAction = (typeof ACTION)[keyof typeof ACTION];
interface WarmingDecision {
	warmCost: number;
	missCost: number;
	continuationProbability: number;
	action: WarmingAction;
}
interface WarmingOverride { action: WarmingAction }
interface WarmingEvents {
	on(event: "cache_warming_decision", handler: (event: WarmingDecision) => WarmingOverride | undefined): unknown;
}
export interface WarmingState {
	sessionId: string | undefined;
	ownedTaskIds: ReadonlySet<string>;
	tasks: Array<Pick<TaskRecord, "id" | "parentSessionId" | "mode" | "status">>;
}

// Pi 0.86.1's native minimum expected savings, in dollars. Ownership raises
// continuation probability to 1, not permission to spend without a benefit.
const MINIMUM_EXPECTED_SAVINGS = 0.05;

export function installBackgroundCacheWarming(pi: WarmingEvents, state: () => WarmingState): void {
	pi.on("cache_warming_decision", (event) => {
		const { sessionId, ownedTaskIds, tasks } = state();
		if (!sessionId || !tasks.some(task => task.parentSessionId === sessionId &&
			ownedTaskIds.has(task.id) && task.mode === "background" &&
			(task.status === "queued" || task.status === "running"))) return;
		// Only native candidates arrive here: Pi owns opt-out, replay safety,
		// provider TTLs, fixed horizons, scheduling and usage outside context.
		const economic = Number.isFinite(event.warmCost) && event.warmCost >= 0 &&
			Number.isFinite(event.missCost) && event.missCost > 0 &&
			event.missCost - event.warmCost >= MINIMUM_EXPECTED_SAVINGS;
		return { action: economic ? ACTION.WARM : ACTION.STOP };
	});
}
