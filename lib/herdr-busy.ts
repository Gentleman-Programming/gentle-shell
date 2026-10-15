import { FINISHED_STATUSES } from "./agents-protocol.ts";

// gentle-shell#626: the herdr pane must stay busy while owned background
// subagents run, even after the parent itself settles. This module is the
// pure, edge-triggered projection the extension feeds on every summary
// notification; it mirrors pi-subagents' herdr producer exactly: raise once,
// dedup an unchanged label, relabel as lower-then-raise in one synchronous
// step, lower once. Labels are content-free and derived from counts only.

export const HERDR_BUSY_CHANNEL = "herdr:busy";

/** What the extension last emitted on the channel, or nothing yet. */
export type HerdrBusyEmitted = { active: true; label: string } | { active: false } | undefined;

export type HerdrBusyAction =
	| { kind: "none" }
	| { kind: "raise"; label: string }
	| { kind: "lower-then-raise"; label: string }
	| { kind: "lower" };

const finishedStatuses: ReadonlySet<string> = new Set<string>(FINISHED_STATUSES);

export function herdrBusyLabel(count: number): string {
	return count === 1 ? "1 subagent running" : `${count} subagents running`;
}

// Fails closed: malformed task input is a no-op, and a malformed previously
// emitted state is simply "not busy". Never throws.
export function nextHerdrBusyAction(tasks: unknown, emitted: unknown): HerdrBusyAction {
	if (!Array.isArray(tasks)) return { kind: "none" };
	let running = 0;
	for (const task of tasks) {
		if (task === null || typeof task !== "object" || typeof (task as { status?: unknown }).status !== "string") return { kind: "none" };
		if (!finishedStatuses.has((task as { status: string }).status)) running += 1;
	}
	const emittedLabel = typeof emitted === "object" && emitted !== null
		&& (emitted as { active?: unknown }).active === true
		&& typeof (emitted as { label?: unknown }).label === "string"
		? (emitted as { label: string }).label
		: undefined;
	if (running === 0) return emittedLabel === undefined ? { kind: "none" } : { kind: "lower" };
	const label = herdrBusyLabel(running);
	if (label === emittedLabel) return { kind: "none" };
	return emittedLabel === undefined ? { kind: "raise", label } : { kind: "lower-then-raise", label };
}
