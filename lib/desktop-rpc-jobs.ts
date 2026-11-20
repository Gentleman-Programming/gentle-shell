// Gentle Desktop background-jobs slice: the pure contract shared by the
// Desktop bridge (`lib/desktop-jobs-service.ts`) and the owner seam inside
// `extensions/gentle-agents.ts`.
//
// Nothing here starts, stops, or polls a job. It only names the wire shapes,
// projects the owner's actual `JobRecord` state into the safe Desktop
// projection, defines the bounded running + recent-finished selection the
// Desktop list uses, and turns the owner's bounded output tail into the plain
// text `get_job_output` answers. The owner (the single parent-session `JobRegistry` plus
// the parent `MonitorController`, reached through `job_stop`'s exact stop
// path) stays the single source of truth; this module is a projection, not a
// second registry, process manager, or store.

import { MAX_TAIL_LINE_CHARS, TAIL_LINES, type JobRecord, type JobStatus } from "./background-jobs.ts";
import { JOBS_FINISHED_TTL_MS } from "./jobs-widget.ts";

export const DESKTOP_JOBS_METHODS = ["list_jobs", "cancel_job", "get_job_output"] as const;
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

/**
 * Upper bound, in UTF-16 code units, on one `get_job_output` text: the owner
 * tail's own bound (`TAIL_LINES` lines of at most `MAX_TAIL_LINE_CHARS`
 * characters plus the owner's one-character cut marker) joined by newlines.
 */
export const DESKTOP_JOB_OUTPUT_MAX_CHARS = TAIL_LINES * (MAX_TAIL_LINE_CHARS + 1) + (TAIL_LINES - 1);

export type DesktopJobStatus = JobStatus;

/**
 * The safe wire window for one job. Only these fields exist on the wire:
 * identity, the human label, the status word, start/end timestamps, and the
 * exit code when the owner recorded one. Never a command, cwd, output path,
 * environment, owner session id, monitor counters, or an error string. The
 * output tail is not part of this entry: it crosses only through the separate,
 * owner-verified `get_job_output` read (`DesktopJobOutput`).
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
 * The `get_job_output` answer for one owned job: the job's own whitelisted
 * projection, its bounded output tail as one plain-text field, and whether that
 * tail is incomplete. `output` is the owner's in-memory tail (the last
 * `TAIL_LINES` lines, each at most `MAX_TAIL_LINE_CHARS` characters) with
 * terminal control sequences removed (see `plainJobOutput`). Otherwise it is the
 * job's own unsanitized process output: it can contain anything the job printed,
 * including echoed commands, paths, or secrets. No command, cwd, output path,
 * environment, owner session id, monitor counter, or error string is ever a
 * separate field.
 */
export interface DesktopJobOutput {
	job: DesktopJobEntry;
	output: string;
	/** True when earlier output was dropped or a line was shortened. */
	truncated: boolean;
}

/** A `get_job_output` owner result; a foreign or unknown id is `not_found`. */
export type DesktopJobsOutputOutcome =
	| { kind: "ok"; view: DesktopJobOutput }
	| { kind: "not_found" };

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
	/**
	 * Read one owned job's bounded output tail. Optional so an owner adapter
	 * without it stays a valid list/cancel owner; the bridge then answers
	 * `get_job_output` with `jobs_unavailable`.
	 */
	output?(id: string): DesktopJobsOutputOutcome;
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

// Terminal control sequences, matched per line: OSC (BEL- or ST-terminated, or
// unterminated to the end of the line), DCS/SOS/PM/APC strings, CSI (7- and
// 8-bit), and the remaining two-character escapes.
const TERMINAL_SEQUENCE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[PX^_][\s\S]*?(?:\u001b\\|$)|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]/g;
// Every other C0/C1 control character except tab (a line never holds a newline).
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Half of a UTF-16 pair, left behind when a line was cut at a fixed length.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * One tail line as plain text: terminal control sequences (colors, cursor
 * moves, titles, hyperlinks) are removed, a carriage-return progress line keeps
 * only its last non-empty segment (what a terminal leaves visible), other
 * control characters except tab are dropped, and a half character left by a
 * length cut is removed. Idempotent, so the bridge can re-apply it to an owner
 * answer.
 */
function plainJobOutputLine(line: string): string {
	const segments = line.replace(TERMINAL_SEQUENCE, "").split("\r");
	let visible = "";
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		if (segments[index] !== "") {
			visible = segments[index]!;
			break;
		}
	}
	return visible.replace(CONTROL_CHARACTER, "").replace(LONE_SURROGATE, "");
}

/** Owner tail lines as one plain-text field, newline-joined (see `plainJobOutputLine`). */
export function plainJobOutput(lines: readonly string[]): string {
	return lines.map(plainJobOutputLine).join("\n");
}

/**
 * The whitelisted `get_job_output` projection of one owner `JobRecord`: the job
 * projection, its bounded tail as plain text, and the owner's truncation flag.
 * Nothing else on the record is read.
 */
export function projectDesktopJobOutput(job: JobRecord): DesktopJobOutput {
	return {
		job: projectDesktopJob(job),
		output: plainJobOutput(job.tail.slice(-TAIL_LINES)),
		truncated: job.tailTruncated === true,
	};
}

/**
 * Defensive validation of one owner `get_job_output` answer. It crosses the
 * event bus, so it is re-validated, re-bounded to `TAIL_LINES` lines and
 * `DESKTOP_JOB_OUTPUT_MAX_CHARS` code units (newest output kept, `truncated`
 * set when anything is cut), and re-normalized to plain text.
 */
export function parseDesktopJobOutput(value: unknown): DesktopJobOutput | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const job = parseDesktopJobEntry(raw.job);
	if (job === undefined) return undefined;
	if (typeof raw.output !== "string" || typeof raw.truncated !== "boolean") return undefined;
	const oversized = raw.output.length > DESKTOP_JOB_OUTPUT_MAX_CHARS;
	const text = oversized ? raw.output.slice(-DESKTOP_JOB_OUTPUT_MAX_CHARS) : raw.output;
	const lines = text.split("\n");
	const kept = lines.slice(-TAIL_LINES);
	return { job, output: plainJobOutput(kept), truncated: raw.truncated || oversized || kept.length < lines.length };
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
 * `cancel_job` and `get_job_output` params are exactly `{ id: non-empty
 * string }`. Anything else is a typed `invalid_request` before any owner work
 * happens.
 */
function parseJobIdParams(params: Record<string, unknown>): { id: string } | { error: { code: string; message: string } } {
	const keys = Object.keys(params);
	if (keys.length !== 1 || keys[0] !== "id" || typeof params.id !== "string" || params.id.length === 0) {
		return { error: INVALID_JOBS_PARAMS };
	}
	return { id: params.id };
}

export const parseCancelJobParams = parseJobIdParams;
export const parseJobOutputParams = parseJobIdParams;

/** True only for the adapter-shaped object the discovery responder must return. */
export function isDesktopJobsServiceShape(value: unknown): value is DesktopJobsService {
	if (!value || typeof value !== "object") return false;
	const adapter = value as Partial<DesktopJobsService>;
	if (adapter.schema !== DESKTOP_JOBS_SERVICE_SCHEMA) return false;
	return [adapter.read, adapter.cancel, adapter.observe, adapter.dispose].every((fn) => typeof fn === "function");
}
