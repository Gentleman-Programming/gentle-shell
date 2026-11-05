import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TASK_STATUS, TERMINAL_ERROR_CATEGORY, type TaskRecord, type TerminalErrorCategory } from "./agents-protocol.ts";
import type { ResponseDiagnostic } from "./agents-response-diagnostics.ts";

// Local, private record of a subagent task that did not complete. It is kept
// apart from task history and transcripts, is never sent anywhere, and holds
// only allowlisted labels, timestamps, counts and a closed failure category.
// Writing it never changes a task outcome; every failure resolves false.

export const RESPONSE_DIAGNOSTIC_SCHEMA = "gentle-pi.response-diagnostic/v1";
export const DIAGNOSTIC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_MAX_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;
const SAFE_LABEL = /^[A-Za-z0-9._:@/+-]{1,128}$/;
const RECORD_FILE = /^(\d{1,16})-[A-Za-z0-9-]{1,64}\.json$/;
const ASSISTANT_ERROR = "assistant reported an error";
const ERROR_CATEGORIES: ReadonlySet<string> = new Set(Object.values(TERMINAL_ERROR_CATEGORY));

export type DiagnosticFailureCategory = "empty_report" | "assistant_error" | "assistant_aborted" | "start_failed"
	| "exited_before_settle" | "cleanup_unconfirmed" | "cancelled" | "timed_out" | "other_failure";

export interface ObservedResponses {
	responses: number;
	settled: boolean;
	last: ResponseDiagnostic | null;
}

export interface ResponseDiagnosticRecord {
	readonly schema: typeof RESPONSE_DIAGNOSTIC_SCHEMA;
	readonly taskId: string;
	readonly agent: string | null;
	/** The launch-requested label, never an inferred effective model. */
	readonly requestedModel: string | null;
	readonly status: TaskRecord["status"];
	readonly category: DiagnosticFailureCategory;
	/** The runner's closed terminal-error category for an assistant error, else null. */
	readonly errorCategory: TerminalErrorCategory | null;
	readonly startedAt: number | null;
	readonly endedAt: number | null;
	readonly durationMs: number | null;
	/** Assistant message_end records observed; an observation, never a verdict. */
	readonly responses: number;
	readonly agentSettled: boolean;
	readonly lastResponse: ResponseDiagnostic | null;
}

export function diagnosticsDir(agentHome: string): string {
	return join(agentHome, "gentle-agents", "diagnostics");
}

/** Maps runner endings to a closed vocabulary; the error text itself is dropped. */
export function failureCategory(status: TaskRecord["status"], error: string | null): DiagnosticFailureCategory {
	if (status === TASK_STATUS.CANCELLED) return "cancelled";
	if (status === TASK_STATUS.TIMED_OUT) return "timed_out";
	if (error === "assistant returned no final report" || error === "assistant settled without a final report") return "empty_report";
	if (error?.startsWith(ASSISTANT_ERROR)) return "assistant_error";
	if (error === "assistant aborted") return "assistant_aborted";
	if (error?.startsWith("could not start pi") || error?.startsWith("could not write agent instructions")) return "start_failed";
	if (error?.startsWith("pi exited with")) return "exited_before_settle";
	if (error?.endsWith("capacity quarantined")) return "cleanup_unconfirmed";
	return "other_failure";
}

const label = (value: unknown): string | null => typeof value === "string" && SAFE_LABEL.test(value) ? value : null;
const time = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function errorCategory(error: string | null): TerminalErrorCategory | null {
	const match = error?.startsWith(ASSISTANT_ERROR) ? /^ \(([a-z_]+)\)$/.exec(error.slice(ASSISTANT_ERROR.length)) : null;
	return match && ERROR_CATEGORIES.has(match[1]) ? match[1] as TerminalErrorCategory : null;
}

/** Undefined for completed tasks or ids unsafe as file names. */
export function responseDiagnosticRecord(task: TaskRecord, observed: ObservedResponses | undefined): ResponseDiagnosticRecord | undefined {
	if (task.status === TASK_STATUS.COMPLETED || !SAFE_ID.test(task.id)) return undefined;
	const startedAt = time(task.startedAt), endedAt = time(task.endedAt);
	return Object.freeze({
		schema: RESPONSE_DIAGNOSTIC_SCHEMA, taskId: task.id, agent: label(task.agent), requestedModel: label(task.model),
		status: task.status, category: failureCategory(task.status, task.error), errorCategory: errorCategory(task.error), startedAt, endedAt,
		durationMs: startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null,
		responses: observed?.responses ?? 0, agentSettled: observed?.settled === true, lastResponse: observed?.last ?? null,
	});
}

export interface DiagnosticStoreOptions {
	now?: () => number;
	maxAgeMs?: number;
	maxBytes?: number;
}

/** Atomic private write, then age/size pruning. Never throws, never follows a symlinked directory. */
export async function writeResponseDiagnostic(dir: string, record: ResponseDiagnosticRecord, options: DiagnosticStoreOptions = {}): Promise<boolean> {
	const now = options.now ?? Date.now;
	try {
		const text = `${JSON.stringify(record)}\n`;
		if (!SAFE_ID.test(record.taskId) || Buffer.byteLength(text) > MAX_RECORD_BYTES) return false;
		await mkdir(dir, { recursive: true, mode: DIR_MODE });
		if (!(await lstat(dir)).isDirectory()) return false;
		await chmod(dir, DIR_MODE);
		const target = join(dir, `${Math.max(0, Math.trunc(now()))}-${record.taskId}.json`);
		const temp = `${target}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(temp, text, { flag: "wx", mode: FILE_MODE });
			await rename(temp, target);
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {});
			throw error;
		}
		await pruneResponseDiagnostics(dir, now(), options.maxAgeMs ?? DIAGNOSTIC_MAX_AGE_MS, options.maxBytes ?? DIAGNOSTIC_MAX_BYTES);
		return true;
	} catch {
		return false;
	}
}

// Only files this store names are counted or removed; anything else is left alone.
async function pruneResponseDiagnostics(dir: string, now: number, maxAgeMs: number, maxBytes: number): Promise<void> {
	const entries: Array<{ name: string; stamp: number; size: number }> = [];
	for (const name of await readdir(dir)) {
		const match = RECORD_FILE.exec(name);
		if (!match) continue;
		const info = await stat(join(dir, name)).catch(() => undefined);
		if (info?.isFile()) entries.push({ name, stamp: Number(match[1]), size: info.size });
	}
	entries.sort((left, right) => left.stamp - right.stamp || left.name.localeCompare(right.name));
	let total = entries.reduce((sum, entry) => sum + entry.size, 0);
	for (const entry of entries) {
		if (entry.stamp >= now - maxAgeMs && total <= maxBytes) break;
		await rm(join(dir, entry.name), { force: true });
		total -= entry.size;
	}
}
