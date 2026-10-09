// Model-facing surface of background jobs: the `bash_background`, `job_stop`,
// and `job_list` tools, the exit notice text, and its transcript card.
// Delivery of the notice belongs to the caller (Gentle Agents' parent
// delivery router), so this module never sends messages itself.

import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BASH_BACKGROUND_TOOL, MAX_RUNNING_JOBS, MONITOR_TOOL, type JobRecord, type JobRegistry } from "./background-jobs.ts";
import { MONITOR_BATCH_MS, MONITOR_FLOOD_LINES, MONITOR_FLOOD_WINDOW_MS, MONITOR_LINES_PER_NOTICE, MONITOR_MAX_TIMEOUT_SECONDS, type MonitorBatch, type MonitorController, type MonitorStopReason } from "./background-monitor.ts";
import { CARD_TONE, renderCard, type CardTheme } from "./shell-card.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

export const JOB_NOTICE_TYPE = "gentle-jobs.notice";
export const JOB_GLYPH = "⧗";

export function formatJobDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const quoted = (job: JobRecord) => `${job.id} ("${job.label}")`;
const noun = (job: JobRecord) => (job.kind === "monitor" ? "Monitor" : "Background job");
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** One-line outcome, shared by the notice, the list, and the jobs view. */
export function jobOutcome(job: JobRecord): string {
	if (job.status === "running") return "running";
	if (job.status === "stopped") return "stopped";
	if (job.status === "failed") return `could not run: ${job.error ?? "unknown error"}`;
	return job.exitCode === null || job.exitCode === undefined ? "exited without an exit code" : `exited with code ${job.exitCode}`;
}

/** Model-facing exit notice: everything needed to act without polling. */
export function jobNoticeText(job: JobRecord): string {
	const duration = job.endedAt === undefined ? "" : ` after ${formatJobDuration(job.endedAt - job.startedAt)}`;
	// Only a human stops a job without the agent knowing (job_stop sends no notice).
	const outcome = job.status === "stopped" ? "was stopped by the user" : jobOutcome(job);
	const events = job.kind === "monitor" ? `, ${plural(job.events ?? 0, "event")}` : "";
	const lines = [`${noun(job)} ${quoted(job)} ${outcome}${duration}${events}.`, `Command: ${job.command}`];
	if (job.tail.length > 0) lines.push("Last output:", ...job.tail);
	else lines.push("No output.");
	lines.push(`Full output: ${job.outputPath} (read it with the read tool if you need more).`);
	return lines.join("\n");
}

/** Model-facing notice for one batch of monitor lines. */
export function monitorEventsText(job: JobRecord, batch: MonitorBatch): string {
	const lines = [`Monitor ${quoted(job)} reported ${plural(batch.lines.length, "new line")}:`, ...batch.lines];
	if (batch.omitted > 0) lines.push(`(${plural(batch.omitted, "more line")} not shown; full output in ${job.outputPath})`);
	return lines.join("\n");
}

/** Model-facing notice for a monitor the harness stopped. */
export function monitorStoppedText(job: JobRecord, reason: MonitorStopReason): string {
	const events = plural(job.events ?? 0, "event");
	const output = `Full output: ${job.outputPath}`;
	if (reason === "timeout") {
		const limit = job.timeoutSeconds === undefined ? "its timeout" : `its ${job.timeoutSeconds}s timeout`;
		return `Monitor ${quoted(job)} reached ${limit} after ${events} and was stopped. Start a new monitor if you still need to watch it.\n${output}`;
	}
	return `Monitor ${quoted(job)} was stopped: it printed more than ${MONITOR_FLOOD_LINES} lines within ${MONITOR_FLOOD_WINDOW_MS / 1000}s (${events}). Narrow the command's filter before watching it again.\n${output}`;
}

function listLine(job: JobRecord, now: number): string {
	const ended = job.endedAt ?? now;
	const status = `${job.kind === "monitor" ? "monitor " : ""}${job.status === "exited" ? `exited ${job.exitCode ?? "?"}` : job.status}`;
	return `${job.id} · ${status} · ${job.label} · ${formatJobDuration(ended - job.startedAt)} · ${job.outputPath}`;
}

type ToolText = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
const text = (value: string, details: Record<string, unknown> = {}): ToolText => ({ content: [{ type: "text", text: value }], details });
export const jobDetails = (job: JobRecord, event?: "events" | MonitorStopReason) => ({ gentleJobs: { jobId: job.id, kind: job.kind, label: job.label, status: job.status, exitCode: job.exitCode ?? null, outputPath: job.outputPath, ...(event ? { event } : {}) } });

export interface BackgroundJobToolsOptions {
	registry: JobRegistry;
	/** The session the tool call runs in; jobs belong to it. */
	sessionId(ctx: ExtensionContext): string;
	now(): number;
	/** Called after a job starts or stops, so views can refresh. */
	onChange?(): void;
	/** Starts and stops monitors; without it the monitor tool is not offered. */
	monitors?: MonitorController;
}

export function registerBackgroundJobTools(pi: ExtensionAPI, options: BackgroundJobToolsOptions): void {
	const { registry } = options;
	const owned = (ctx: ExtensionContext, id: string) => {
		const job = registry.get(id);
		return job && job.ownerSessionId === options.sessionId(ctx) ? job : undefined;
	};

	pi.registerTool({
		name: BASH_BACKGROUND_TOOL,
		label: "Bash (background)",
		description: [
			"Run a shell command in the background and return a job id at once. You are notified once, automatically, when it exits (exit code, last output lines, output file); do not poll, sleep, or delegate a subagent to wait.",
			"Use it for anything you would otherwise wait on: CI, builds, long tests, deploys, servers.",
			"Put the wait condition inside the command so its exit is the event, e.g. `gh run watch <run-id> --exit-status` or `until curl -sf localhost:3000/health; do sleep 1; done`.",
			`Output goes to a file you can read with the read tool. Stop a job with job_stop; list jobs with job_list. At most ${MAX_RUNNING_JOBS} run at once.`,
		].join(" "),
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["command"],
			properties: {
				command: { type: "string", description: "Shell command to run in the background, in the session working directory." },
				label: { type: "string", maxLength: 80, description: "Short human-readable label, e.g. 'CI for PR 1834'." },
			},
		} as never,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const input = params as { command?: unknown; label?: unknown };
			if (typeof input.command !== "string" || !input.command.trim()) throw new Error("bash_background requires a non-empty command");
			const job = registry.start({ command: input.command, cwd: ctx.cwd, ownerSessionId: options.sessionId(ctx), label: typeof input.label === "string" ? input.label : undefined });
			options.onChange?.();
			return text(
				`Started background job ${quoted(job)}.\nOutput: ${job.outputPath}\nYou will be notified once when it exits; keep working or end your turn. Stop it with job_stop.`,
				jobDetails(job),
			);
		},
	});

	const monitors = options.monitors;
	if (monitors) pi.registerTool({
		name: MONITOR_TOOL,
		label: "Monitor",
		description: [
			"Run a command in the background and receive each output line as an event while it runs, without waiting for it to exit. Do not poll or sleep between events.",
			"Use it to react as things happen: `tail -f app.log | grep --line-buffered ERROR`, or a loop that prints each CI check as it finishes. For a single result when a command ends, use bash_background instead.",
			`Lines within ${MONITOR_BATCH_MS} ms arrive as one notice of at most ${MONITOR_LINES_PER_NOTICE} lines. timeout_seconds is mandatory (1-${MONITOR_MAX_TIMEOUT_SECONDS}); the monitor is stopped when it expires, and also when it prints more than ${MONITOR_FLOOD_LINES} lines within ${MONITOR_FLOOD_WINDOW_MS / 1000}s, so filter the command's output.`,
			"Stop it with job_stop; list it with job_list.",
		].join(" "),
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["command", "timeout_seconds"],
			properties: {
				command: { type: "string", description: "Shell command whose output lines are events, run in the session working directory." },
				timeout_seconds: { type: "integer", minimum: 1, maximum: MONITOR_MAX_TIMEOUT_SECONDS, description: "Mandatory: stop the monitor after this many seconds." },
				label: { type: "string", maxLength: 80, description: "Short human-readable label, e.g. 'CI checks for PR 1842'." },
			},
		} as never,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const input = params as { command?: unknown; label?: unknown; timeout_seconds?: unknown };
			if (typeof input.command !== "string" || !input.command.trim()) throw new Error("monitor requires a non-empty command");
			const timeoutSeconds = typeof input.timeout_seconds === "number" ? input.timeout_seconds : Number.NaN;
			const job = monitors.start({ command: input.command, cwd: ctx.cwd, ownerSessionId: options.sessionId(ctx), label: typeof input.label === "string" ? input.label : undefined, timeoutSeconds });
			options.onChange?.();
			return text(
				`Started monitor ${quoted(job)} for up to ${timeoutSeconds}s.\nOutput: ${job.outputPath}\nEach new output line reaches you as an event; keep working or end your turn. Stop it with job_stop.`,
				jobDetails(job),
			);
		},
	});

	pi.registerTool({
		name: "job_stop",
		label: "Stop background job",
		description: "Stop a background job started with bash_background, killing its whole process tree. A stopped job sends no exit notice.",
		parameters: { type: "object", additionalProperties: false, required: ["job_id"], properties: { job_id: { type: "string" } } } as never,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const id = (params as { job_id?: unknown }).job_id;
			const job = typeof id === "string" ? owned(ctx, id) : undefined;
			if (!job) throw new Error(`No background job ${String(id)} in this session. Use job_list to see this session's jobs.`);
			const wasRunning = job.status === "running";
			options.monitors?.cancel(job.id);
			registry.stop(job.id);
			options.onChange?.();
			return text(wasRunning ? `Stopped ${quoted(job)}.` : `${quoted(job)} was already ${jobOutcome(job)}.`, jobDetails(job));
		},
	});

	pi.registerTool({
		name: "job_list",
		label: "List background jobs",
		description: "List this session's background jobs with status, label, elapsed time, and output file.",
		parameters: { type: "object", additionalProperties: false, properties: {} } as never,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const jobs = registry.list(options.sessionId(ctx));
			if (jobs.length === 0) return text("No background jobs in this session.");
			const now = options.now();
			return text(jobs.map((job) => listLine(job, now)).join("\n"), { gentleJobs: { count: jobs.length } });
		},
	});

	pi.registerMessageRenderer(JOB_NOTICE_TYPE, (message, renderOptions, theme) => {
		const details = (message.details as { gentleJobs?: { label?: string; status?: string; exitCode?: number | null; kind?: string; event?: string } } | undefined)?.gentleJobs;
		const content = typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const lines = sanitizeTerminalText(content).split("\n");
		const tone = details?.event === "events" ? CARD_TONE.INFO
			: details?.status === "exited" && details.exitCode === 0 ? CARD_TONE.SUCCESS : CARD_TONE.ERROR;
		let hint: string;
		try { hint = keyHint("app.tools.expand", renderOptions.expanded ? "collapse" : "expand"); } catch { hint = renderOptions.expanded ? "collapse" : "expand"; }
		return {
			render(width: number) {
				return renderCard({ title: details?.kind === "monitor" ? "Monitor" : "Background job", subtitle: details?.label, body: lines, tone, glyph: JOB_GLYPH }, theme as CardTheme, width, { expanded: renderOptions.expanded, previewRows: 3, hint });
			},
			invalidate() {},
		};
	});
}
