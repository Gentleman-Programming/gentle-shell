import { FINISHED_STATUSES } from "./agents-protocol.ts";

// Orca's injected pi status extension keeps a pane "working" after the parent
// turn settles only while it hears background subagent lifecycle events on
// pi.events (the pi-subagents names). This pure, edge-triggered projection
// turns the owned task list into those events: one started per task, one
// complete when it finishes or leaves the list. Content is limited to the
// task id, agent name and label already shown in the AGENTS sidebar.

export const ORCA_SUBAGENT_STARTED = "subagent:async-started";
export const ORCA_SUBAGENT_COMPLETE = "subagent:async-complete";

export type OrcaSubagentEvent =
	| { name: typeof ORCA_SUBAGENT_STARTED; payload: { id: string; agent?: string; description?: string } }
	| { name: typeof ORCA_SUBAGENT_COMPLETE; payload: { id: string } };

const finishedStatuses: ReadonlySet<string> = new Set<string>(FINISHED_STATUSES);

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

// Fails closed: malformed input emits nothing and keeps the previous state. Never throws.
export function nextOrcaSubagentEvents(
	tasks: unknown,
	emitted: ReadonlySet<string>,
): { events: OrcaSubagentEvent[]; emitted: ReadonlySet<string> } {
	if (!Array.isArray(tasks)) return { events: [], emitted };
	const running: { id: string; agent?: string; description?: string }[] = [];
	for (const task of tasks) {
		if (task === null || typeof task !== "object") return { events: [], emitted };
		const record = task as { id?: unknown; status?: unknown; agent?: unknown; label?: unknown };
		if (typeof record.id !== "string" || !record.id || typeof record.status !== "string") return { events: [], emitted };
		if (finishedStatuses.has(record.status)) continue;
		running.push({ id: record.id, agent: text(record.agent), description: text(record.label) });
	}
	const events: OrcaSubagentEvent[] = [];
	const next = new Set<string>();
	for (const task of running) {
		next.add(task.id);
		if (emitted.has(task.id)) continue;
		const payload: { id: string; agent?: string; description?: string } = { id: task.id };
		if (task.agent) payload.agent = task.agent;
		if (task.description) payload.description = task.description;
		events.push({ name: ORCA_SUBAGENT_STARTED, payload });
	}
	for (const id of emitted) if (!next.has(id)) events.push({ name: ORCA_SUBAGENT_COMPLETE, payload: { id } });
	return { events, emitted: next };
}
