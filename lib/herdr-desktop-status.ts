import { stripVTControlCharacters } from "node:util";

export type DesktopState = "idle" | "working" | "blocked" | "done" | "error";
export type DesktopKind = "permission" | "question" | "auth";
export interface DesktopRecord {
	state: DesktopState;
	kind?: DesktopKind;
	progress?: number;
	title?: string;
	msg?: string;
}
export interface DesktopStatusInputs {
	todo?: unknown;
	jobs?: unknown;
	subagents?: unknown;
	waits?: unknown;
	sends?: unknown;
	/** Caller-provided time in milliseconds, used only for sends. */
	now?: number;
}

export const SEND_TTL_MS = 5000;
export const ERROR_TTL_MS = 60000;
const TEXT_BYTES = 512;
const states: readonly string[] = ["idle", "working", "blocked", "done", "error"];
const kinds: readonly string[] = ["permission", "question", "auth"];
const taskStates: readonly string[] = ["queued", "running", "waiting", "completed", "failed", "cancelled", "timed_out"];
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
type Raw = Record<string, unknown>;

function object(value: unknown): value is Raw {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reject rather than rewriting an identity: rewriting could alias a different record. */
function validId(id: unknown): id is string {
	return typeof id === "string" && id.length <= 64 && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(id);
}

// OSC fields are encoded, but their decoded text must not contain terminal controls.
function cleanText(value: string): string {
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
}

/** Only explicit labels that survive OSC cleanup can replace a safe fallback. */
export function hasUsableDesktopLabel(value: unknown): value is string {
	return typeof value === "string" && cleanText(value).length > 0;
}

function encodedText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = cleanText(value);
	let prefix = "";
	let bytes = 0;
	for (const scalar of text) {
		const size = Buffer.byteLength(scalar, "utf8");
		if (bytes + size > TEXT_BYTES) break;
		prefix += scalar;
		bytes += size;
	}
	return prefix ? Buffer.from(prefix, "utf8").toString("base64") : undefined;
}

function roundedProgress(percent: number): number {
	return Math.round(Math.max(0, Math.min(100, percent)));
}

/** OSC 7501 field order is state, kind, progress, title, msg, id. */
export function encodeRecord(id: unknown, record: unknown): string | undefined {
	try {
		if (!validId(id) || !object(record) || typeof record.state !== "string" || !states.includes(record.state)) return undefined;
		const fields = [`state=${record.state}`];
		if (record.state === "blocked" && typeof record.kind === "string" && kinds.includes(record.kind)) fields.push(`kind=${record.kind}`);
		if ((record.state === "working" || record.state === "blocked")
			&& typeof record.progress === "number" && Number.isFinite(record.progress)) {
			fields.push(`progress=${roundedProgress(record.progress)}`);
		}
		const title = encodedText(record.title);
		const msg = encodedText(record.msg);
		if (title) fields.push(`title=${title}`);
		if (msg) fields.push(`msg=${msg}`);
		fields.push(`id=${id}`);
		return `\x1b]7501;${fields.join(":")}\x1b\\`;
	} catch { return undefined; }
}

export function encodeClear(id: unknown): string | undefined {
	return validId(id) ? `\x1b]7501;state=clear:id=${id}\x1b\\` : undefined;
}

/** Clears follow previous insertion order; resends follow next insertion order. */
export function diffRecords(previous: Map<string, DesktopRecord>, next: Map<string, DesktopRecord>): string[] {
	const before = new Map<string, string>();
	const after = new Map<string, string>();
	for (const [id, record] of previous) {
		const encoded = encodeRecord(id, record);
		if (encoded) before.set(id, encoded);
	}
	for (const [id, record] of next) {
		const encoded = encodeRecord(id, record);
		if (encoded) after.set(id, encoded);
	}
	const changes: string[] = [];
	for (const id of before.keys()) if (!after.has(id)) changes.push(encodeClear(id)!);
	for (const [id, encoded] of after) if (before.get(id) !== encoded) changes.push(encoded);
	return changes;
}

/** Match activeTodoTitle without importing its Pi and I/O dependencies. */
function todoTitle(title: string): string | undefined {
	const clipped = title.length > 4096;
	// String controls (OSC/DCS/SOS/PM/APC) may contain arbitrary payloads.
	const sample = title.slice(0, 4096).replace(/(?:\x1b[\]P_X^]|[\x90\x98\x9d\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "");
	const clean = stripVTControlCharacters(sample)
		.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200c\u200e-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
		.replace(/\s+/g, " ").trim();
	if (!clean) return undefined;
	const parts = Array.from(graphemes.segment(clean), ({ segment }) => segment);
	if (clipped) parts.pop();
	return parts.join("") || undefined;
}

/** Each projection returns an insertion-ordered map, empty for malformed input. */
export function projectTodo(input: unknown): Map<string, DesktopRecord> {
	try {
		if (!object(input) || typeof input.done !== "number" || !Number.isSafeInteger(input.done) || input.done < 0
			|| typeof input.total !== "number" || !Number.isSafeInteger(input.total) || input.total <= 0 || input.done > input.total
			|| typeof input.current !== "string") return new Map();
		const title = todoTitle(input.current);
		return title ? new Map([["todo", { state: "working", title, progress: Math.round(input.done / input.total * 100) }]]) : new Map();
	} catch { return new Map(); }
}

// Mirrors isJobsSidebarSnapshot: importing it would also import the Pi keymap/I/O module.
function validJob(job: unknown): job is Raw {
	if (!object(job) || typeof job.id !== "string" || job.id.length === 0 || typeof job.label !== "string"
		|| typeof job.startedAt !== "number" || !Number.isFinite(job.startedAt)) return false;
	if (job.explicitLabel !== undefined && typeof job.explicitLabel !== "string") return false;
	if (job.status !== undefined && job.status !== "exited" && job.status !== "stopped" && job.status !== "failed") return false;
	if (job.endedAt !== undefined && (typeof job.endedAt !== "number" || !Number.isFinite(job.endedAt))) return false;
	return job.exitCode === undefined || job.exitCode === null || typeof job.exitCode === "number";
}

/** A sidebar label can contain the command, so only explicit provenance is publishable. */
export function desktopJobTitle(job: { explicitLabel?: unknown; kind?: unknown }): string {
	return hasUsableDesktopLabel(job.explicitLabel) ? job.explicitLabel : job.kind === "monitor" ? "monitor" : "background job";
}

export function projectJobs(input: unknown): Map<string, DesktopRecord> {
	try {
		if (!object(input) || !Array.isArray(input.jobs) || !input.jobs.every(validJob)) return new Map();
		const result = new Map<string, DesktopRecord>();
		for (const job of input.jobs) {
			const id = `bg/${job.id}`;
			if (job.status === undefined && validId(id)) result.set(id, { state: "working", title: desktopJobTitle(job) });
		}
		return result;
	} catch { return new Map(); }
}

function validTask(task: unknown): task is Raw {
	return object(task) && typeof task.id === "string" && task.id.length > 0
		&& typeof task.agent === "string" && task.agent.trim().length > 0
		&& typeof task.status === "string" && taskStates.includes(task.status)
		&& (task.label === undefined || typeof task.label === "string")
		&& (task.explicitLabel === undefined || typeof task.explicitLabel === "string")
		&& (task.pendingQuery === undefined || typeof task.pendingQuery === "boolean");
}

/** Local task labels can contain the prompt; only an explicit label is publishable. */
export function desktopTaskTitle(task: { explicitLabel?: unknown; agent: unknown }): string {
	return hasUsableDesktopLabel(task.explicitLabel) ? task.explicitLabel : task.agent as string;
}

export function projectSubagents(input: unknown): Map<string, DesktopRecord> {
	try {
		if (!Array.isArray(input) || !input.every(validTask)) return new Map();
		const result = new Map<string, DesktopRecord>();
		for (const task of input) {
			const id = `subagents/${task.id}`;
			if (!validId(id) || (task.status !== "queued" && task.status !== "running" && task.status !== "waiting")) continue;
			const title = desktopTaskTitle({ explicitLabel: task.explicitLabel, agent: task.agent });
			result.set(id, task.pendingQuery === true
				? { state: "blocked", kind: "question", title, msg: "question for parent" }
				: task.status === "waiting" ? { state: "blocked", kind: "question", title, msg: "waiting for user" }
				: { state: "working", title });
		}
		return result;
	} catch { return new Map(); }
}

export function projectWaits(input: unknown): Map<string, DesktopRecord> {
	try {
		if (!Array.isArray(input)) return new Map();
		const result = new Map<string, DesktopRecord>();
		for (const target of input) {
			if (typeof target !== "string") return new Map();
			const id = `wait/${target}`;
			if (validId(id)) result.set(id, { state: "working", msg: `consulting ${target}` });
		}
		return result;
	} catch { return new Map(); }
}

export function projectSends(input: unknown, now: unknown): Map<string, DesktopRecord> {
	try {
		if (!Array.isArray(input) || typeof now !== "number" || !Number.isFinite(now)
			|| !input.every((send) => object(send) && typeof send.target === "string" && typeof send.at === "number" && Number.isFinite(send.at))) return new Map();
		const result = new Map<string, DesktopRecord>();
		for (const send of input) {
			const id = `sent/${send.target}`;
			if (validId(id) && now - send.at < SEND_TTL_MS) result.set(id, { state: "idle", msg: `sent to ${send.target}` });
		}
		return result;
	} catch { return new Map(); }
}

/** Caller supplies time and raw snapshots; no source is allowed to overwrite another. */
export function projectAll(inputs: unknown): Map<string, DesktopRecord> {
	try {
		if (!object(inputs)) return new Map();
		const result = new Map<string, DesktopRecord>();
		for (const source of [projectTodo(inputs.todo), projectJobs(inputs.jobs), projectSubagents(inputs.subagents),
			projectWaits(inputs.waits), projectSends(inputs.sends, inputs.now)]) {
			for (const [id, record] of source) result.set(id, record);
		}
		return result;
	} catch { return new Map(); }
}
