import type { TaskStatus } from "./agents-protocol.ts";
import type { JobKind, JobStatus } from "./background-jobs.ts";

/** Local display-only snapshots and lifecycle edges, never routing authority. */
export const HERDR_DESKTOP_TASKS = "gentle-pi:herdr-desktop:tasks";
export const HERDR_DESKTOP_TASKS_REQUEST = "gentle-pi:herdr-desktop:tasks-request";
export const HERDR_DESKTOP_TASK_FINISHED = "gentle-pi:herdr-desktop:task-finished";
export const HERDR_DESKTOP_JOBS = "gentle-pi:herdr-desktop:jobs";
export const HERDR_DESKTOP_JOB_SETTLED = "gentle-pi:herdr-desktop:job-settled";
export const HERDR_DESKTOP_CONSULT = "gentle-pi:herdr-desktop:consult";
export const HERDR_DESKTOP_SEND = "gentle-pi:herdr-desktop:send";
export const HERDR_DESKTOP_INBOUND = "gentle-pi:herdr-desktop:inbound";

export interface HerdrDesktopTask {
	id: string;
	agent: string;
	label: string;
	/** Explicit label only; label may be derived from a task prompt. */
	explicitLabel?: string;
	status: TaskStatus;
	pendingQuery: boolean;
}
export interface HerdrDesktopTasks { sessionId: string; tasks: HerdrDesktopTask[] }
export interface HerdrDesktopTaskFinished { sessionId: string; task: HerdrDesktopTask }
/** A job outcome without the local label, which can contain the shell command. */
export interface HerdrDesktopJobSettled {
	sessionId: string;
	job: {
		id: string;
		explicitLabel?: string;
		kind: JobKind;
		startedAt: number;
		status: Exclude<JobStatus, "running">;
		endedAt?: number;
		exitCode?: number | null;
	};
}
export interface HerdrDesktopConsult { sessionId: string; target: string; callId: string; phase: "start" | "settle" }
export interface HerdrDesktopSend { sessionId: string; target: string }
export interface HerdrDesktopInbound { sessionId: string; peer: string; peerName?: string; id: string; phase: "received" | "handled" }
