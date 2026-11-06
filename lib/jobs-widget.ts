import { JOB_GLYPH, formatJobDuration } from "./background-jobs-tools.ts";
import type { RunningJobDisplay } from "./jobs-sidebar-state.ts";
import type { CardTheme } from "./shell-card.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { renderPanelHeader, renderPanelRow } from "./shell-panel.ts";

// Gentle Jobs widget: the fullscreen rail section for this session's background
// jobs. Reads the running-job display snapshot only (id, label, startedAt), so
// drawing it costs nothing per event. One row per job: glyph, id, label,
// elapsed right-aligned. Jobs are transient — the section paints nothing while
// no job runs, and the overlay (/gentle:jobs) stays the full view with stop
// controls and output tails.

export const JOBS_GLYPH = JOB_GLYPH;

// Finished jobs linger like the Agents card's results: newest 3 for a minute,
// so an exit is visible long enough to read before the card empties itself.
export const JOBS_FINISHED_TTL_MS = 60_000;
const MAX_FINISHED = 3;

export interface JobsWidgetOptions {
	collapsed: boolean;
	/** The pointer is over the header, the section's collapse control. */
	hovered?: boolean;
}

const GLYPH_ROLE = "accent";
const NAME_ROLE = "text";
const META_ROLE = "dim";
const ELLIPSIS = "…";

// Running jobs newest first, matching the /gentle:jobs running group and the
// old Status group this card replaces; finished tails follow, newest first.
export function widgetJobs(jobs: readonly RunningJobDisplay[], now: number): RunningJobDisplay[] {
	const running = jobs.filter((job) => job.status === undefined).sort((a, b) => b.startedAt - a.startedAt);
	const finished = jobs.filter((job) => job.status !== undefined && now - (job.endedAt ?? 0) < JOBS_FINISHED_TTL_MS)
		.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, MAX_FINISHED);
	return [...running, ...finished];
}

function clean(text: string): string {
	return sanitizeTerminalText(text).replace(/\s+/g, " ");
}

// The /gentle:jobs glyph roles: running keeps the spinner, exits mirror the
// overlay's outcome marks.
function glyph(job: RunningJobDisplay): [string, string] {
	if (job.status === "stopped") return ["–", "dim"];
	if (job.status === "failed") return ["✗", "error"];
	if (job.status === "exited") return job.exitCode === 0 ? ["✓", "success"] : ["✗", "error"];
	return [JOBS_GLYPH, GLYPH_ROLE];
}

function counts(jobs: readonly RunningJobDisplay[]): string {
	const running = jobs.filter((job) => job.status === undefined).length;
	const finished = jobs.length - running;
	const parts: string[] = [];
	if (running > 0) parts.push(running === 1 ? "1 running" : `${running} running`);
	if (finished > 0) parts.push(finished === 1 ? "1 finished" : `${finished} finished`);
	return parts.join(" · ");
}

// The fullscreen rail's panel section: the same jobs, glyphs and counts as the
// card, as a `▾ JOBS … counts` header and one row per job (id, label, elapsed).
export function renderJobsSection(jobs: readonly RunningJobDisplay[], theme: CardTheme, width: number, now: number, options: JobsWidgetOptions): string[] {
	const shown = widgetJobs(jobs, now);
	if (shown.length === 0) return [];
	const listed = options.collapsed ? [shown[0]!] : shown;
	const rows = listed.map((job) => {
		const [mark, role] = glyph(job);
		const elapsed = formatJobDuration(Math.max(0, (job.status === undefined ? now : job.endedAt ?? now) - job.startedAt));
		return renderPanelRow(width, `${theme.fg(role, mark)} ${theme.fg(NAME_ROLE, clean(job.id))} ${theme.fg(META_ROLE, clean(job.label))}`, theme.fg(META_ROLE, elapsed));
	});
	if (options.collapsed && shown.length > 1) rows.push(renderPanelRow(width, theme.fg(META_ROLE, `${ELLIPSIS} ${shown.length - 1} more`)));
	return [renderPanelHeader(theme, width, { title: "Jobs", count: counts(shown), open: !options.collapsed, hovered: options.hovered }), ...rows];
}
