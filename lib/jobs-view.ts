// Background jobs overlay (`/gentle:jobs`): this session's jobs beside the
// selected job's command, status, output file, and output tail. It shares the
// Agents overlay geometry and roles so both read as one family, but stays a
// small standalone view: jobs have no peers, groups, or threads.

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { JobRecord } from "./background-jobs.ts";
import { formatJobDuration, JOB_GLYPH, jobOutcome } from "./background-jobs-tools.ts";
import { measureAgentsViewLayout } from "./agents-view-layout.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

export interface JobsViewDeps {
	theme: { fg(role: string, text: string): string };
	rows: () => number;
	/** This session's jobs; the view sorts a copy by activity and recency. */
	jobs: () => JobRecord[];
	now: () => number;
	onStop(job: JobRecord): void;
	onClose(): void;
	requestRender(): void;
}

const ROLE = { FRAME: "border", TITLE: "customMessageLabel", SELECTED: "accent", NAME: "text", META: "dim", KEY: "accent", KEY_TEXT: "dim", EMPTY: "dim" } as const;
const REFRESH_MS = 1000;

function glyph(job: JobRecord): [string, string] {
	if (job.status === "running") return [job.kind === "monitor" ? "◉" : "◐", "accent"];
	if (job.status === "stopped") return ["–", "dim"];
	if (job.status === "exited" && job.exitCode === 0) return ["✓", "success"];
	return ["✗", "error"];
}

const rule = (length: number) => "─".repeat(Math.max(0, length));
const fit = (text: string, width: number) => {
	const clipped = truncateToWidth(text, Math.max(0, width), "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};
const clean = (text: string) => sanitizeTerminalText(text).replace(/\s+/g, " ");

export class JobsView {
	private readonly deps: JobsViewDeps;
	private selectedId: string | undefined;
	private details = false;
	private listScroll = 0;
	private closed = false;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(deps: JobsViewDeps) {
		this.deps = deps;
		// Elapsed time and the output tail move while a job runs.
		this.timer = setInterval(() => {
			if (this.deps.jobs().some((job) => job.status === "running")) this.deps.requestRender();
		}, REFRESH_MS);
		this.timer.unref?.();
	}

	dispose(): void {
		this.closed = true;
		clearInterval(this.timer);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.closed) return;
		const jobs = this.orderedJobs();
		const index = Math.max(0, jobs.findIndex((job) => job.id === this.selected(jobs)?.id));
		if (data === "q") this.close();
		else if (matchesKey(data, Key.escape)) {
			if (this.details) this.details = false;
			else this.close();
		} else if (data === "\t" || matchesKey(data, Key.enter)) this.details = !this.details;
		else if (data === "j" || matchesKey(data, Key.down)) this.selectedId = jobs[Math.min(jobs.length - 1, index + 1)]?.id;
		else if (data === "k" || matchesKey(data, Key.up)) this.selectedId = jobs[Math.max(0, index - 1)]?.id;
		else if (data === "s") {
			const job = this.selected(jobs);
			if (job?.status === "running") this.deps.onStop(job);
		} else return;
		this.deps.requestRender();
	}

	render(width: number): string[] {
		const layout = measureAgentsViewLayout(width, this.deps.rows(), this.details);
		if (layout.width === 0 || layout.height === 0) return [];
		if (layout.mode === "fallback") return [fit("× Close Jobs", layout.width)];
		const { theme } = this.deps;
		const jobs = this.orderedJobs();
		const selected = this.selected(jobs);
		const inner = layout.width - 2;
		const running = jobs.filter((job) => job.status === "running").length;
		const title = truncateToWidth(`${JOB_GLYPH} Jobs · ${running} running · ${jobs.length - running} finished`, Math.max(0, inner - 4), "…");
		const top = theme.fg(ROLE.FRAME, "╭─ ") + theme.fg(ROLE.TITLE, title) + theme.fg(ROLE.FRAME, ` ${rule(inner - visibleWidth(title) - 3)}╮`);
		const list = this.listLines(jobs, selected, layout.listWidth, layout.bodyRows);
		const detail = selected ? this.detailLines(selected, layout.bodyRows) : [theme.fg(ROLE.EMPTY, "No background jobs in this session."), theme.fg(ROLE.EMPTY, "The agent starts them with bash_background or monitor.")];
		const bar = theme.fg(ROLE.FRAME, "│");
		const body: string[] = [];
		for (let row = 0; row < layout.bodyRows; row += 1) {
			if (layout.mode === "panes") body.push(`${bar} ${fit(list[row] ?? "", layout.listWidth)} ${bar} ${fit(detail[row] ?? "", layout.threadWidth)}${bar}`);
			else body.push(`${bar} ${fit((this.details ? detail : list)[row] ?? "", layout.listWidth)} ${bar}`);
		}
		const keys = this.keys(selected, layout.mode === "narrow").map(([key, label]) => `${theme.fg(ROLE.KEY, key)} ${theme.fg(ROLE.KEY_TEXT, label)}`).join("   ");
		return [top, ...body, `${bar} ${fit(keys, inner - 2)} ${bar}`, theme.fg(ROLE.FRAME, `╰${rule(inner)}╯`)];
	}

	private orderedJobs(): JobRecord[] {
		return [...this.deps.jobs()].sort((a, b) =>
			Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt);
	}

	private close(): void {
		this.deps.onClose();
	}

	private selected(jobs: JobRecord[]): JobRecord | undefined {
		const selected = jobs.find((job) => job.id === this.selectedId) ?? jobs[0];
		this.selectedId = selected?.id;
		return selected;
	}

	private elapsed(job: JobRecord): string {
		return formatJobDuration((job.endedAt ?? this.deps.now()) - job.startedAt);
	}

	private listLines(jobs: JobRecord[], selected: JobRecord | undefined, width: number, rows: number): string[] {
		const { theme } = this.deps;
		if (jobs.length === 0) return [theme.fg(ROLE.EMPTY, "No jobs")];
		const index = jobs.findIndex((job) => job.id === selected?.id);
		if (index < this.listScroll) this.listScroll = index;
		else if (index >= this.listScroll + rows) this.listScroll = index - rows + 1;
		this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, jobs.length - rows)));
		return jobs.slice(this.listScroll, this.listScroll + rows).map((job) => {
			const [mark, role] = glyph(job);
			const elapsed = this.elapsed(job);
			const isSelected = job.id === selected?.id;
			const name = fit(`${isSelected ? "›" : " "} ${mark} ${clean(job.label)}`, Math.max(0, width - visibleWidth(elapsed) - 1));
			return `${theme.fg(isSelected ? ROLE.SELECTED : role === "accent" ? ROLE.NAME : role, name)} ${theme.fg(ROLE.META, elapsed)}`;
		});
	}

	private detailLines(job: JobRecord, rows: number): string[] {
		const { theme } = this.deps;
		const head = [
			theme.fg(ROLE.TITLE, `${clean(job.label)} · ${job.id}`),
			`${theme.fg(ROLE.META, "Command")} ${clean(job.command)}`,
			`${theme.fg(ROLE.META, "Status ")} ${clean(jobOutcome(job))} · ${this.elapsed(job)}${job.kind === "monitor" ? ` · ${job.events ?? 0} event${job.events === 1 ? "" : "s"}` : ""}`,
			`${theme.fg(ROLE.META, "Output ")} ${clean(job.outputPath)}`,
			"",
		];
		const room = Math.max(0, rows - head.length - 1);
		const tail = job.tail.slice(-room).map((line) => sanitizeTerminalText(line));
		return [...head, theme.fg(ROLE.META, tail.length > 0 ? "Last output" : "No output yet."), ...tail];
	}

	private keys(selected: JobRecord | undefined, narrow: boolean): Array<[string, string]> {
		const keys: Array<[string, string]> = [["↑↓", "move"]];
		if (narrow && selected) keys.push(["tab", this.details ? "list" : "details"]);
		if (selected?.status === "running") keys.push(["s", "Stop"]);
		keys.push(["q", "close"]);
		return keys;
	}
}
