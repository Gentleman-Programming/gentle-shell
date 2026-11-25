// `gentle-shell serve`'s self-upgrade (`POST /api/upgrade`, admin): runs the
// same `gentle-shell upgrade` a person would on this machine, streams its
// output to admin clients (`GET /api/upgrade/:jobId/stream`, SSE `line` and
// `finished`), and on success asks the server to restart itself on the new
// version. Session keepers and the terminal host are separate processes and
// keep running; the next server reattaches them. One upgrade at a time.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sseEvent, startSse } from "./serve-http.ts";
import type { SessionLaunch } from "./serve-session.ts";

export const SERVE_UPGRADE_LIMITS = {
	/** Output lines kept for a stream that connects late; older ones are dropped. */
	lines: 2000,
	line: 2000,
	error: 300,
	/** An upgrade still running then is stopped. */
	timeoutMs: 30 * 60_000,
	/** Time for the `finished` event to reach clients before the server restarts. */
	restartDelayMs: 500,
	heartbeatMs: 20_000,
};

export const UPGRADE_CHANNELS = ["release", "main"] as const;
export type UpgradeChannel = (typeof UPGRADE_CHANNELS)[number];

export interface ServeUpgradeOptions {
	/** The upgrade command: `gentle-shell upgrade [--channel <channel>]` in production. */
	launch: (channel: UpgradeChannel | undefined) => SessionLaunch;
	/** The version installed after a successful upgrade, when it can be read. */
	installedVersion?: () => string | undefined;
	/** A successful upgrade's `finished` was sent: restart on the new version. */
	onUpgraded: () => void;
	limits?: Partial<typeof SERVE_UPGRADE_LIMITS>;
	log?: (line: string) => void;
}

export interface UpgradeFinished {
	ok: boolean;
	error?: string;
	version?: string;
}

interface UpgradeJob {
	jobId: string;
	lines: string[];
	finished?: UpgradeFinished;
	streams: Set<ServerResponse>;
	child?: ChildProcess;
}

export const UPGRADE_JOB_ID = /^upg_[0-9a-f]{16}$/;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Output text as lines: no color codes, no control characters, no blank lines, each bounded. */
export function upgradeLines(text: string, limit: number = SERVE_UPGRADE_LIMITS.line): string[] {
	const lines: string[] = [];
	for (const raw of text.replace(ANSI, "").split(/\r\n|\r|\n/)) {
		// eslint-disable-next-line no-control-regex
		const line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd();
		if (line.trim().length > 0) lines.push(line.length > limit ? `${line.slice(0, limit - 1)}…` : line);
	}
	return lines;
}

export class UpgradeService {
	private job: UpgradeJob | undefined;
	private readonly limits: typeof SERVE_UPGRADE_LIMITS;
	private readonly heartbeat: NodeJS.Timeout;
	private readonly options: ServeUpgradeOptions;
	private closed = false;

	constructor(options: ServeUpgradeOptions) {
		this.options = options;
		this.limits = { ...SERVE_UPGRADE_LIMITS, ...options.limits };
		this.heartbeat = setInterval(() => {
			for (const res of this.job?.streams ?? []) res.write(": ping\n\n");
		}, this.limits.heartbeatMs);
		this.heartbeat.unref();
	}

	running(): boolean {
		return this.job !== undefined && this.job.finished === undefined;
	}

	/** Starts the upgrade; `409 upgrade_running` while one runs. */
	start(channel: UpgradeChannel | undefined): { jobId: string } {
		if (this.closed) throw new HttpError(503, "server_stopping", "The server is stopping");
		if (this.running()) throw new HttpError(409, "upgrade_running", "An upgrade is already running");
		const previous = this.job;
		for (const res of previous?.streams ?? []) res.end();
		const job: UpgradeJob = { jobId: `upg_${randomBytes(8).toString("hex")}`, lines: [], streams: new Set() };
		this.job = job;
		const launch = this.options.launch(channel);
		this.options.log?.(`upgrade ${job.jobId}: started${channel === undefined ? "" : ` (channel ${channel})`}`);
		let child: ChildProcess;
		try {
			child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch (error) {
			queueMicrotask(() => this.finish(job, { ok: false, error: error instanceof Error ? error.message : String(error) }));
			return { jobId: job.jobId };
		}
		job.child = child;
		const errors: string[] = [];
		const read = (stream: NodeJS.ReadableStream | null, isError: boolean) => {
			let rest = "";
			const emit = (text: string) => {
				for (const line of upgradeLines(text, this.limits.line)) {
					if (isError) errors.push(line);
					this.line(job, line);
				}
			};
			stream?.setEncoding("utf8");
			stream?.on("data", (chunk: string) => {
				const text = rest + chunk;
				const cut = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
				rest = cut === -1 ? text : text.slice(cut + 1);
				if (cut !== -1) emit(text.slice(0, cut + 1));
			});
			stream?.on("end", () => {
				emit(rest);
				rest = "";
			});
		};
		read(child.stdout, false);
		read(child.stderr, true);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref();
		}, this.limits.timeoutMs);
		timer.unref();
		child.once("error", (error) => {
			clearTimeout(timer);
			this.finish(job, { ok: false, error: error.message });
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				let version: string | undefined;
				try {
					version = this.options.installedVersion?.();
				} catch { /* unknown until the new server answers GET /api/server */ }
				this.finish(job, { ok: true, ...(version === undefined ? {} : { version }) });
				return;
			}
			const last = errors.at(-1) ?? job.lines.at(-1);
			const error = timedOut ? "The upgrade ran past its time limit" : last ?? (signal ? `Stopped by ${signal}` : `Exited with code ${code}`);
			this.finish(job, { ok: false, error: error.length > this.limits.error ? `${error.slice(0, this.limits.error - 1)}…` : error });
		});
		return { jobId: job.jobId };
	}

	private line(job: UpgradeJob, line: string): void {
		job.lines.push(line);
		if (job.lines.length > this.limits.lines) job.lines.shift();
		const event = sseEvent("line", { line });
		for (const res of job.streams) res.write(event);
	}

	private finish(job: UpgradeJob, finished: UpgradeFinished): void {
		if (job.finished) return;
		job.finished = finished;
		job.child = undefined;
		this.options.log?.(`upgrade ${job.jobId}: ${finished.ok ? `done${finished.version === undefined ? "" : ` (${finished.version})`}` : `failed: ${finished.error}`}`);
		const event = sseEvent("finished", finished);
		for (const res of job.streams) res.end(event);
		job.streams.clear();
		if (finished.ok && !this.closed) setTimeout(() => this.options.onUpgraded(), this.limits.restartDelayMs).unref();
	}

	/** SSE: the lines so far, then live ones, then `finished`, then the stream ends. */
	stream(req: IncomingMessage, res: ServerResponse, jobId: string): void {
		const job = this.job;
		if (!job || job.jobId !== jobId) throw new HttpError(404, "not_found", "No such upgrade");
		startSse(req, res);
		res.write("retry: 3000\n\n");
		for (const line of job.lines) res.write(sseEvent("line", { line }));
		if (job.finished) {
			res.end(sseEvent("finished", job.finished));
			return;
		}
		job.streams.add(res);
		res.on("close", () => job.streams.delete(res));
	}

	/** The server is stopping: streams end; a running upgrade goes on to its end, as a CLI one would. */
	close(): void {
		this.closed = true;
		clearInterval(this.heartbeat);
		for (const res of this.job?.streams ?? []) res.end();
		this.job?.streams.clear();
	}
}
