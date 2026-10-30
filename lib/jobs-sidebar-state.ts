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
	// Finished-tail fields; optional so older publishers that only list running
	// jobs keep validating (the Agents-card pattern: results linger briefly).
	status?: "exited" | "stopped" | "failed";
	endedAt?: number;
	exitCode?: number | null;
}

export interface JobsSidebarSnapshot {
	jobs: RunningJobDisplay[];
}

export function isJobsSidebarSnapshot(value: unknown): value is JobsSidebarSnapshot {
	if (!value || typeof value !== "object" || !Array.isArray((value as JobsSidebarSnapshot).jobs)) return false;
	return (value as JobsSidebarSnapshot).jobs.every((job) => {
		if (!job || typeof job !== "object") return false;
		if (typeof job.id !== "string" || job.id.length === 0 || typeof job.label !== "string") return false;
		if (typeof job.startedAt !== "number" || !Number.isFinite(job.startedAt)) return false;
		if (job.status !== undefined && job.status !== "exited" && job.status !== "stopped" && job.status !== "failed") return false;
		if (job.endedAt !== undefined && (typeof job.endedAt !== "number" || !Number.isFinite(job.endedAt))) return false;
		if (job.exitCode !== undefined && typeof job.exitCode !== "number" && job.exitCode !== null) return false;
		return true;
	});
}
