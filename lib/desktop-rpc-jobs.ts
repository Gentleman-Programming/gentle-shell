// Gentle Desktop background-jobs slice: the pure contract shared by the
// Desktop bridge (`lib/desktop-jobs-service.ts`) and the owner seam inside
// `extensions/gentle-agents.ts`.
//
// Nothing here starts, stops, or polls a job. It only names the wire shapes,
// projects the owner's actual `JobRecord` state into the safe Desktop
// projection, and defines the bounded running + recent-finished selection the
// Desktop list uses. The owner (the single parent-session `JobRegistry` plus
// the parent `MonitorController`, reached through `job_stop`'s exact stop
// path) stays the single source of truth; this module is a projection, not a
// second registry, process manager, or store.

import type { JobRecord, JobStatus } from "./background-jobs.ts";
import { JOBS_FINISHED_TTL_MS } from "./jobs-widget.ts";

export const DESKTOP_JOBS_METHODS = ["list_jobs", "cancel_job"] as const;
export const DESKTOP_JOBS_EVENT = "jobs_update";
/** Advertised only because the owner seam records the registry changes this event carries. */
export const DESKTOP_JOBS_EVENTS = [DESKTOP_JOBS_EVENT] as const;

// The versioned owner-service discovery seam (the jobs analogue of the usage
// `gentle:desktop:usage-service` adapter). The schema string guards the adapter
// against drift; the bridge ignores any responder whose shape does not match.
export const DESKTOP_JOBS_SERVICE_SCHEMA = "gentle-pi.desktop-jobs-service/v1";
export const DESKTOP_JOBS_SERVICE_CHANNEL = "gentle:desktop:jobs-service";

/** Upper bound on the number of jobs one list answer carries (running + recent finished). */
export const DESKTOP_JOBS_LIST_LIMIT = 50;

export type DesktopJobStatus = JobStatus;

/**
 * The safe wire window for one job. Only these fields exist on the wire:
 * identity, the human label, the status word, start/end timestamps, and the
 * exit code when the owner recorded one. Never a command, cwd, output path or
 * tail, environment, owner session id, monitor counters, or an error string.
 */
export interface DesktopJobEntry {
	id: string;
	label: string;
	status: DesktopJobStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
}

/** The owner's list answer for one session: which session, plus its projected jobs. */
export interface DesktopJobsOwnerRead {
	sessionId: string;
	jobs: DesktopJobEntry[];
}

/**
 * A `cancel_job` owner result. `changed` is `true` only when the job really
 * transitioned from running to stopped; an already-terminal job answers
 * `changed: false` with its terminal projection instead of a race-driven error.
 */
export type DesktopJobsCancelOutcome =
	| { kind: "ok"; job: DesktopJobEntry; changed: boolean }
	| { kind: "not_found" };

/**
 * The owner-service adapter the bridge discovers. Every method is defensive:
 * after `dispose()` it answers empty/no-op rather than speaking into a
 * replaced session.
 */
export interface DesktopJobsService {
	schema: typeof DESKTOP_JOBS_SERVICE_SCHEMA;
	read(): DesktopJobsOwnerRead;
	cancel(id: string): DesktopJobsCancelOutcome;
	/** Subscribe to actual registry changes; the unsubscribe stops delivery. */
	observe(onChange: (sessionId: string) => void): () => void;
	dispose(): void;
}

export const INVALID_JOBS_PARAMS = { code: "invalid_request", message: "Invalid background jobs parameters" } as const;
export const JOBS_UNAVAILABLE = { code: "jobs_unavailable", message: "Background jobs owner unavailable for this session" } as const;
export const JOB_NOT_FOUND = { code: "not_found", message: "No background job with that id in this session" } as const;

/** Shown for a command job the agent started without a label. */
export const DESKTOP_JOB_FALLBACK_LABEL = "Background job";
/** Shown for a monitor the agent started without a label. */
export const DESKTOP_MONITOR_FALLBACK_LABEL = "Background monitor";

/**
 * The label a job may show on the wire. An explicit label is the agent's own
 * wording and is kept. Without one, the registry falls back to the command
 * itself, and a command can hide a secret in more shell forms (headers,
 * quoted or escaped assignments, substitutions) than any parser here could
 * safely cover, so no part of it is derived: the label is fixed by kind.
 */
export function desktopJobLabel(job: Pick<JobRecord, "label" | "command" | "kind">): string {
	if (job.label.trim() !== job.command.trim()) return job.label;
	return job.kind === "monitor" ? DESKTOP_MONITOR_FALLBACK_LABEL : DESKTOP_JOB_FALLBACK_LABEL;
}

/**
 * The whitelisted projection of one owner `JobRecord`. Every field is rebuilt
 * from the named members only, so a foreign or stale object can never smuggle
 * a command, path, tail line, or secret into the Desktop payload.
 */
export function projectDesktopJob(job: JobRecord): DesktopJobEntry {
	const entry: DesktopJobEntry = {
		id: job.id,
		label: desktopJobLabel(job),
		status: job.status,
		startedAt: job.startedAt,
	};
	if (job.endedAt !== undefined) entry.endedAt = job.endedAt;
	if (job.exitCode !== undefined) entry.exitCode = job.exitCode;
	return entry;
}

/**
 * The bounded `list_jobs` selection: running jobs first (newest start first),
 * then recently-finished jobs (newest end first), capped so the answer can
 * never grow with the lifetime of the process. Finished jobs older than the
 * TTL drop out, matching the jobs widget's lingering semantics.
 */
export function selectDesktopJobs(jobs: readonly JobRecord[], now: number): DesktopJobEntry[] {
	const running = jobs
		.filter((job) => job.status === "running")
		.sort((left, right) => right.startedAt - left.startedAt);
	const finished = jobs
		.filter((job) => job.status !== "running" && job.endedAt !== undefined && now - job.endedAt < JOBS_FINISHED_TTL_MS)
		.sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
	return [...running, ...finished].slice(0, DESKTOP_JOBS_LIST_LIMIT).map(projectDesktopJob);
}

/**
 * Defensive validation of one owner-projected entry. The owner's answer crosses
 * the event bus, so its shape is never trusted beyond the fields the bridge
 * projects; anything else is junk the bridge answers `jobs_unavailable` for
 * rather than projecting into a malformed success.
 */
export function parseDesktopJobEntry(value: unknown): DesktopJobEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
	if (typeof raw.label !== "string") return undefined;
	if (raw.status !== "running" && raw.status !== "exited" && raw.status !== "stopped" && raw.status !== "failed") return undefined;
	if (typeof raw.startedAt !== "number" || !Number.isFinite(raw.startedAt) || raw.startedAt < 0) return undefined;
	const entry: DesktopJobEntry = { id: raw.id, label: raw.label, status: raw.status, startedAt: raw.startedAt };
	if (raw.endedAt !== undefined) {
		if (typeof raw.endedAt !== "number" || !Number.isFinite(raw.endedAt) || raw.endedAt < 0) return undefined;
		entry.endedAt = raw.endedAt;
	}
	if (raw.exitCode !== undefined) {
		if (raw.exitCode !== null && (typeof raw.exitCode !== "number" || !Number.isFinite(raw.exitCode))) return undefined;
		entry.exitCode = raw.exitCode as number | null;
	}
	return entry;
}

/**
 * `list_jobs` params must be an empty object; anything else is a typed
 * `invalid_request` before any owner work happens.
 */
export function parseListJobsParams(params: Record<string, unknown>): { ok: true } | { error: { code: string; message: string } } {
	return Object.keys(params).length === 0 ? { ok: true } : { error: INVALID_JOBS_PARAMS };
}

/**
 * `cancel_job` params are exactly `{ id: non-empty string }`. Anything else is
 * a typed `invalid_request` before any owner work happens.
 */
export function parseCancelJobParams(params: Record<string, unknown>): { id: string } | { error: { code: string; message: string } } {
	const keys = Object.keys(params);
	if (keys.length !== 1 || keys[0] !== "id" || typeof params.id !== "string" || params.id.length === 0) {
		return { error: INVALID_JOBS_PARAMS };
	}
	return { id: params.id };
}

/** True only for the adapter-shaped object the discovery responder must return. */
export function isDesktopJobsServiceShape(value: unknown): value is DesktopJobsService {
	if (!value || typeof value !== "object") return false;
	const adapter = value as Partial<DesktopJobsService>;
	if (adapter.schema !== DESKTOP_JOBS_SERVICE_SCHEMA) return false;
	return [adapter.read, adapter.cancel, adapter.observe, adapter.dispose].every((fn) => typeof fn === "function");
}
