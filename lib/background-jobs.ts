// Background jobs.
//
// A background job runs a shell command while the parent keeps working or
// stays idle, so waiting on CI, a build, or a server never costs a sleep loop
// or a subagent. A wait condition lives inside the command itself (for
// example `until grep -q ready log; do sleep 1; done` or
// `gh run watch <id> --exit-status`): the job's exit is the notification.
//
// The registry owns live jobs and reports each job's own exit exactly once
// through `onSettled`. A stopped job reports nothing: whoever stopped it
// already knows. Execution goes through Pi's own shell operations
// (`createLocalBashOperations`), so the configured shell, the command
// transport, process groups, and process-tree kill match native Bash.

import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";

/** The background sibling of Pi's native `bash` tool. */
export const BASH_BACKGROUND_TOOL = "bash_background";
/** A background job whose output lines are events. */
export const MONITOR_TOOL = "monitor";
/**
 * Tools whose `command` input runs in a shell. Command guards (confirmation,
 * YOLO, child safety) must cover every one of them, or the background tool
 * would bypass them.
 */
export const SHELL_COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", BASH_BACKGROUND_TOOL, MONITOR_TOOL]);

const STANDALONE_SLEEP_SEGMENT = /^sleep\s+\d+(?:\.\d+)?[smhd]?$/;

/**
 * True only for a command that does nothing but sleep: one or more literal
 * `sleep <number>[smhd]` segments joined by `&&` or `;`. Wait conditions
 * (`until ...; do sleep 1; done`), loops, pipes and sleeps mixed with real
 * commands are never standalone (#1903).
 */
export function isStandaloneSleep(command: string): boolean {
	const segments = command.split(/&&|;/).map((segment) => segment.trim()).filter((segment) => segment.length > 0);
	return segments.length > 0 && segments.every((segment) => STANDALONE_SLEEP_SEGMENT.test(segment));
}

/** Lines kept for the exit notice and job listings. */
export const TAIL_LINES = 20;
/**
 * Characters kept per tail line. Progress bars and minified output can print
 * one endless line; only its newest characters are kept, after an ellipsis.
 */
export const MAX_TAIL_LINE_CHARS = 2000;
/** Running jobs allowed at once across the process. */
export const MAX_RUNNING_JOBS = 25;

/** Collects the last TAIL_LINES lines of a stream of output chunks. */
export function createOutputTail() {
	const complete: string[] = [];
	let partial = "";
	let partialTruncated = false;
	const bound = (line: string, truncated: boolean) => {
		const cut = line.length > MAX_TAIL_LINE_CHARS;
		const kept = cut ? line.slice(-MAX_TAIL_LINE_CHARS) : line;
		return cut || truncated ? `…${kept}` : kept;
	};
	const clean = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);
	return {
		push(text: string) {
			const parts = (partial + text).split("\n");
			partial = parts.pop() ?? "";
			for (const [index, part] of parts.entries()) {
				complete.push(bound(clean(part), index === 0 && partialTruncated));
				if (complete.length > TAIL_LINES) complete.shift();
				if (index === 0) partialTruncated = false;
			}
			if (partial.length > MAX_TAIL_LINE_CHARS) {
				partial = partial.slice(-MAX_TAIL_LINE_CHARS);
				partialTruncated = true;
			}
		},
		lines(): string[] {
			const all = partial.length > 0 ? [...complete, bound(clean(partial), partialTruncated)] : [...complete];
			return all.slice(-TAIL_LINES);
		},
	};
}

/** The subset of Pi's `BashOperations` a job needs. */
export interface JobExecOperations {
	exec(command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal }): Promise<{ exitCode: number | null }>;
}

export type JobStatus = "running" | "exited" | "stopped" | "failed";
/** A command reports its exit; a monitor also reports each output line. */
export type JobKind = "command" | "monitor";

export interface JobRecord {
	readonly id: string;
	readonly kind: JobKind;
	readonly label: string;
	readonly command: string;
	readonly cwd: string;
	readonly ownerSessionId: string;
	readonly outputPath: string;
	readonly startedAt: number;
	status: JobStatus;
	exitCode?: number | null;
	error?: string;
	endedAt?: number;
	/** Last output lines; refreshed until the job ends. */
	tail: string[];
	/** Monitor only: output lines reported as events so far. */
	events?: number;
	/** Monitor only: the mandatory timeout it was started with. */
	timeoutSeconds?: number;
}

export interface JobStartRequest {
	command: string;
	cwd: string;
	ownerSessionId: string;
	label?: string;
	kind?: JobKind;
	/** Called with each complete output line, and the last partial one at exit. */
	onLine?: (line: string) => void;
}

export interface JobRegistryDeps {
	/** Directory receiving one `<id>.log` file per job; read at each start. */
	outputDir(): string;
	now(): number;
	/** Resolved at each start so a changed shell setting applies to the next job. */
	shell(cwd: string): { operations: JobExecOperations; commandPrefix?: string };
	/** Called once when a job ends on its own (exited or failed), never for a stop. */
	onSettled(job: JobRecord): void;
}

export function createJobRegistry(deps: JobRegistryDeps) {
	const jobs = new Map<string, JobRecord>();
	const aborts = new Map<string, AbortController>();
	// Every job's run, until its log file is closed and its exit reported.
	const runs = new Set<Promise<void>>();
	let counter = 0;

	const running = () => [...jobs.values()].filter((job) => job.status === "running").length;

	const finish = async (job: JobRecord, output: WriteStream, update: () => void) => {
		update();
		await new Promise<void>((resolve) => output.end(resolve));
		aborts.delete(job.id);
	};

	const start = (request: JobStartRequest): JobRecord => {
		if (running() >= MAX_RUNNING_JOBS) {
			throw new Error(`${MAX_RUNNING_JOBS} background jobs are already running; stop one with job_stop first.`);
		}
		const { operations, commandPrefix } = deps.shell(request.cwd);
		const id = `job-${++counter}`;
		const job: JobRecord = {
			id,
			kind: request.kind ?? "command",
			label: request.label?.trim() || request.command,
			command: request.command,
			cwd: request.cwd,
			ownerSessionId: request.ownerSessionId,
			outputPath: join(deps.outputDir(), `${id}.log`),
			startedAt: deps.now(),
			status: "running",
			tail: [],
		};
		const output = createWriteStream(job.outputPath);
		output.on("error", () => { /* A lost log must not crash the session; the tail survives. */ });
		const tail = createOutputTail();
		// Streaming decode keeps a multibyte character split across chunks intact.
		const decoder = new TextDecoder("utf-8");
		const abort = new AbortController();
		jobs.set(id, job);
		aborts.set(id, abort);
		const execCommand = commandPrefix ? `${commandPrefix}\n${request.command}` : request.command;
		let linePartial = "";
		const emitLines = (text: string, end: boolean) => {
			if (!request.onLine) return;
			const parts = (linePartial + text).split("\n");
			linePartial = end ? "" : parts.pop() ?? "";
			// Keep one extra character so a cut partial still reads as cut.
			if (linePartial.length > MAX_TAIL_LINE_CHARS) linePartial = linePartial.slice(-(MAX_TAIL_LINE_CHARS + 1));
			for (const part of parts) {
				const line = part.endsWith("\r") ? part.slice(0, -1) : part;
				request.onLine(line.length > MAX_TAIL_LINE_CHARS ? `…${line.slice(-MAX_TAIL_LINE_CHARS)}` : line);
			}
		};
		const flushDecoder = () => {
			const rest = decoder.decode();
			if (rest) {
				tail.push(rest);
				job.tail = tail.lines();
			}
			emitLines(rest, true);
		};
		const onData = (data: Buffer) => {
			output.write(data);
			const text = decoder.decode(data, { stream: true });
			tail.push(text);
			job.tail = tail.lines();
			emitLines(text, false);
		};
		const run = operations.exec(execCommand, request.cwd, { onData, signal: abort.signal }).then(
			({ exitCode }) => finish(job, output, () => {
				flushDecoder();
				if (job.status !== "running") return;
				job.status = "exited";
				job.exitCode = exitCode;
				job.endedAt = deps.now();
			}),
			(error: unknown) => finish(job, output, () => {
				flushDecoder();
				if (job.status !== "running") return;
				job.status = "failed";
				job.error = error instanceof Error ? error.message : String(error);
				job.endedAt = deps.now();
			}),
		).then(() => {
			if (job.status === "exited" || job.status === "failed") deps.onSettled(job);
		}).finally(() => runs.delete(run));
		runs.add(run);
		return job;
	};

	const stop = (id: string): JobRecord | undefined => {
		const job = jobs.get(id);
		if (!job) return undefined;
		if (job.status === "running") {
			job.status = "stopped";
			job.endedAt = deps.now();
			aborts.get(id)?.abort();
		}
		return job;
	};

	return {
		start,
		stop,
		get: (id: string) => jobs.get(id),
		/** Jobs in start order, optionally only those one session owns. */
		list: (ownerSessionId?: string) => [...jobs.values()].filter((job) => ownerSessionId === undefined || job.ownerSessionId === ownerSessionId),
		running,
		/** Runs not yet finished: still executing or closing their log. */
		pending: () => runs.size,
		/** Stops every running job and resolves once every log file is closed. */
		stopAll: async () => {
			for (const id of jobs.keys()) stop(id);
			await Promise.allSettled([...runs]);
		},
	};
}

export type JobRegistry = ReturnType<typeof createJobRegistry>;
