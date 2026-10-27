import { visibleWidth } from "@earendil-works/pi-tui";
import { JOB_GLYPH, formatJobDuration } from "./background-jobs-tools.ts";
import type { RunningJobDisplay } from "./jobs-sidebar-state.ts";
import { paintHoverable } from "./shell-hover.ts";
import { CARD_TONE, panelInnerWidth, renderCard, type CardTheme, type CardTone } from "./shell-card.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

// Gentle Jobs widget: the sidebar card for this session's background jobs.
// Reads the running-job display snapshot only (id, label, startedAt), the same
// data the Status card used to print, so drawing it costs nothing per event.
// One row per job: glyph, label, elapsed right-aligned. Jobs are transient —
// the card paints nothing while no job runs, and the overlay (/gentle:jobs)
// stays the full view with stop controls and output tails.

export const JOBS_GLYPH = JOB_GLYPH;

export interface JobsWidgetOptions {
	collapsed: boolean;
	collapseKey?: string;
	// Paint the clickable "▾ Collapse" / "▸ Expand" control in the header, the
	// same control the Agents and Todos cards carry.
	collapseControl?: boolean;
	hovered?: boolean;
}

const GLYPH_ROLE = "accent";
const NAME_ROLE = "text";
const META_ROLE = "dim";
const GLYPH_GAP = "  ";
const ELLIPSIS = "…";

// Newest first, matching the /gentle:jobs running group and the old Status
// group this card replaces.
export function widgetJobs(jobs: readonly RunningJobDisplay[]): RunningJobDisplay[] {
	return [...jobs].sort((a, b) => b.startedAt - a.startedAt);
}

function clean(text: string): string {
	return sanitizeTerminalText(text).replace(/\s+/g, " ");
}

function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	// Plain clip, mirroring the status bar: pi's truncateToWidth wraps the
	// result in resets, which would end up inside a painted segment.
	let clipped = "";
	for (const char of text) {
		if (visibleWidth(clipped + char) > width - 1) break;
		clipped += char;
	}
	return `${clipped}${ELLIPSIS}`;
}

function counts(jobs: readonly RunningJobDisplay[]): string {
	return jobs.length === 1 ? "1 running" : `${jobs.length} running`;
}

/** The tone the card paints, so a host can locate its header row. */
export function jobsCardTone(_jobs: readonly RunningJobDisplay[]): CardTone {
	return CARD_TONE.INFO;
}

export function renderJobsCard(jobs: readonly RunningJobDisplay[], theme: CardTheme, width: number, now: number, options: JobsWidgetOptions): string[] {
	const shown = widgetJobs(jobs);
	if (shown.length === 0) return [];
	const tone = jobsCardTone(shown);
	const inner = panelInnerWidth(theme, width, tone);
	const listed = options.collapsed ? [shown[0]!] : shown;
	const body = listed.map((job) => {
		const elapsed = formatJobDuration(Math.max(0, now - job.startedAt));
		const label = clip(clean(job.label), Math.max(0, inner - visibleWidth(elapsed) - GLYPH_GAP.length - 1));
		const head = `${theme.fg(GLYPH_ROLE, JOBS_GLYPH)}${GLYPH_GAP}${theme.fg(NAME_ROLE, label)}`;
		const tail = theme.fg(META_ROLE, " ".repeat(Math.max(1, inner - visibleWidth(head) - visibleWidth(elapsed))) + elapsed);
		return `${head}${tail}`;
	});
	if (options.collapsed && shown.length > 1) body.push(theme.fg(META_ROLE, `${ELLIPSIS} ${shown.length - 1} more`));
	const icon = options.collapsed ? "▸" : "▾";
	const control = `${icon} ${width >= 28 ? (options.collapsed ? "Expand" : "Collapse") : ""}`.trimEnd();
	const title = options.collapseControl ? `Jobs ${paintHoverable(theme, control, options.hovered ?? false, "accent")}` : "Jobs";
	const hint = options.collapsed && options.collapseKey ? `${options.collapseKey} expand` : undefined;
	return renderCard(
		{ title, subtitle: counts(shown), body, tone, glyph: JOBS_GLYPH },
		theme,
		width,
		{ expanded: true, hint, panel: true },
	);
}
