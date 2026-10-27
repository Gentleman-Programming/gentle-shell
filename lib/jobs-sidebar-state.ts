/** Session-scoped display data only; never command output or process control. */
export const JOBS_SIDEBAR_EVENT = "gentle-ai:jobs-sidebar";
export const JOBS_STATUS_KEY = "gentle-jobs";

const COLLAPSE_KEY_DEFAULT = "ctrl+shift+j";

export function jobsCollapseKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.GENTLE_PI_JOBS_KEY?.trim();
	if (value === undefined) return COLLAPSE_KEY_DEFAULT;
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}

export interface RunningJobDisplay {
	id: string;
	label: string;
	startedAt: number;
}

export interface JobsSidebarSnapshot {
	jobs: RunningJobDisplay[];
}

export function isJobsSidebarSnapshot(value: unknown): value is JobsSidebarSnapshot {
	if (!value || typeof value !== "object" || !Array.isArray((value as JobsSidebarSnapshot).jobs)) return false;
	return (value as JobsSidebarSnapshot).jobs.every((job) => job && typeof job === "object" &&
		typeof job.id === "string" && job.id.length > 0 && typeof job.label === "string" &&
		typeof job.startedAt === "number" && Number.isFinite(job.startedAt));
}
