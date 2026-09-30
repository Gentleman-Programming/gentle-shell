// Statistics overlay view (epic #1, I8; panel polish).
//
// The panel cannot be a sidebar rail from an extension, so it is the supported
// overlay: `ctx.ui.custom(..., { overlay: true })`. This module is the pure
// half — a model built from I4's aggregate and I5's timeline, and a
// width-aware renderer — plus the component that owns keyboard handling.
//
// It is written for a human, not for a machine: readable magnitudes, no raw
// ids, provenance as a single marker with a legend, and no silently truncated
// line. An unavailable value renders `n/a`, never `0`, and the overlay renders
// a cached model it never recomputes per frame.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { NANO_USD_SCALE } from "./session-usage.ts";
import type { FigureProvenance, UsageAggregate, UsageBucket } from "./session-aggregate.ts";
import type { Timeline } from "./session-timeline.ts";

/** Below this width the panel drops the frame and stacks its sections. */
export const STATISTICS_NARROW_WIDTH = 60;
/** The documented marker convention, shown once in the footer. */
export const STATISTICS_LEGEND = "measured unless + partial · n/a unavailable";

export interface StatisticsStyle {
	readonly title: (text: string) => string;
	readonly frame: (text: string) => string;
	readonly dim: (text: string) => string;
	readonly accent: (text: string) => string;
}

/** No styling: the default for tests and for a host without a theme. */
export const PLAIN_STATISTICS_STYLE: StatisticsStyle = { title: (text) => text, frame: (text) => text, dim: (text) => text, accent: (text) => text };

export interface StatisticsRow {
	/** Stable key, never displayed. */
	readonly key: string;
	/** Displayed primary label: the agent role, or the model. */
	readonly title: string;
	/** Displayed secondary label: the task label, or the provider. */
	readonly subtitle?: string;
	readonly turns: number;
	readonly costNanoUsd: number;
	readonly costProvenance: FigureProvenance;
	readonly tokens: number;
}

export interface StatisticsRatio {
	readonly label: string;
	readonly value: string;
}

export interface StatisticsTimelineModel {
	readonly modelMs: number;
	readonly toolMs: number;
	readonly idleMs: number;
	readonly wallClockMs: number;
}

export interface StatisticsModel {
	readonly costNanoUsd: number;
	readonly costProvenance: FigureProvenance;
	readonly costAbsent: number;
	readonly turns: number;
	readonly tokens: UsageBucket["tokens"];
	readonly ratios: readonly StatisticsRatio[];
	readonly subagents: readonly StatisticsRow[];
	readonly models: readonly StatisticsRow[];
	readonly timeline: StatisticsTimelineModel | null;
	readonly generatedAt: number;
}

function usdFromNano(nanoUsd: number): string {
	return `$${(nanoUsd / NANO_USD_SCALE).toFixed(4)}`;
}

function usd(value: number | null): string {
	if (value === null) return "n/a";
	if (value >= 1) return `$${value.toFixed(2)}`;
	if (value >= 0.01) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(4)}`;
}

/** Compact magnitude: 122803929 becomes "122.8M", 7780 becomes "7.8K". */
export function formatTokens(value: number | null): string {
	if (value === null) return "n/a";
	if (value >= 1e9) return `${trimZero(value / 1e9)}B`;
	if (value >= 1e6) return `${trimZero(value / 1e6)}M`;
	if (value >= 1e3) return `${trimZero(value / 1e3)}K`;
	return `${Math.round(value)}`;
}

function trimZero(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

function percent(value: number | null): string {
	return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function ratio(value: number | null): string {
	return value === null ? "n/a" : value.toFixed(2);
}

function rowFrom(key: string, title: string, subtitle: string | undefined, bucket: UsageBucket): StatisticsRow {
	return { key, title, ...(subtitle !== undefined && subtitle.length > 0 ? { subtitle } : {}), turns: bucket.turns, costNanoUsd: bucket.cost.nanoUsd, costProvenance: bucket.cost.provenance, tokens: bucket.tokens.total };
}

/** Build the display model from the aggregate and the optional timeline. Pure. */
export function buildStatisticsModel(aggregate: UsageAggregate, timeline: Timeline | null, generatedAt: number): StatisticsModel {
	return {
		costNanoUsd: aggregate.cost.nanoUsd,
		costProvenance: aggregate.cost.provenance,
		costAbsent: aggregate.cost.absent,
		turns: aggregate.turns,
		tokens: aggregate.tokens,
		ratios: [
			{ label: "cache reads", value: percent(aggregate.ratios.cacheReadShare) },
			{ label: "cache writes", value: percent(aggregate.ratios.cacheWriteShare) },
			{ label: "reasoning of output", value: percent(aggregate.ratios.reasoningShareOfOutput) },
			{ label: "output of total", value: percent(aggregate.ratios.outputToTotal) },
			{ label: "cost per turn", value: usd(aggregate.ratios.costPerTurn) },
			{ label: "tokens per turn", value: formatTokens(aggregate.ratios.tokensPerTurn) },
		],
		subagents: aggregate.perSubagent.map((entry) => rowFrom(entry.taskId, entry.agent, entry.label, entry)),
		models: aggregate.perModel.map((entry) => rowFrom(`${entry.provider}/${entry.model}`, entry.model, entry.provider, entry)),
		timeline: timeline ? { modelMs: timeline.modelMs, toolMs: timeline.toolMs, idleMs: timeline.idleMs, wallClockMs: timeline.wallClockMs } : null,
		generatedAt,
	};
}

function fit(text: string, width: number): string {
	const truncated = truncateToWidth(text, Math.max(0, width));
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}

/** Join parts into lines that never exceed `width`, instead of truncating. */
function wrapParts(parts: readonly string[], width: number, separator = " · "): string[] {
	const lines: string[] = [];
	let current = "";
	for (const part of parts) {
		const candidate = current === "" ? part : `${current}${separator}${part}`;
		if (visibleWidth(candidate) <= width || current === "") current = candidate;
		else {
			lines.push(current);
			current = part;
		}
	}
	if (current !== "") lines.push(current);
	return lines;
}

function costText(model: StatisticsModel): string {
	const marker = model.costProvenance === "partial" ? "+" : "";
	return `${usdFromNano(model.costNanoUsd)}${marker}`;
}

function timeSplit(model: StatisticsModel): string {
	if (!model.timeline) return "n/a";
	return `model ${formatDuration(model.timeline.modelMs)} · tools ${formatDuration(model.timeline.toolMs)} · idle ${formatDuration(model.timeline.idleMs)} (est.)`;
}

function rowLines(row: StatisticsRow, width: number, style: StatisticsStyle): string[] {
	const lines: string[] = [`  ${style.accent(row.title)}${row.subtitle ? style.dim(`  ${row.subtitle}`) : ""}`];
	const marker = row.costProvenance === "partial" ? "+" : "";
	lines.push(`    ${wrapParts([`${row.turns} turn${row.turns === 1 ? "" : "s"}`, `${usdFromNano(row.costNanoUsd)}${marker}`, `${formatTokens(row.tokens)} tokens`], width - 4).join("\n    ")}`);
	return lines;
}

/** The stacked, frameless layout used below `STATISTICS_NARROW_WIDTH`. */
function renderNarrow(model: StatisticsModel, width: number, style: StatisticsStyle): string[] {
	const lines: string[] = [];
	lines.push(style.title("Session statistics"));
	for (const line of wrapParts([costText(model), `${model.turns} turns`, `${formatTokens(model.tokens.total)} tokens`, model.timeline ? formatDuration(model.timeline.wallClockMs) : "n/a"], width)) lines.push(line);
	if (model.timeline) for (const line of wrapParts([`model ${formatDuration(model.timeline.modelMs)}`, `tools ${formatDuration(model.timeline.toolMs)}`, `idle ${formatDuration(model.timeline.idleMs)} (est.)`], width)) lines.push(style.dim(line));
	lines.push("");
	lines.push(style.accent("Helpers"));
	if (model.subagents.length === 0) lines.push(style.dim("  none"));
	for (const row of model.subagents) lines.push(...rowLines(row, width, style));
	lines.push("");
	lines.push(style.accent("Models"));
	if (model.models.length === 0) lines.push(style.dim("  none"));
	for (const row of model.models) lines.push(...rowLines(row, width, style));
	lines.push("");
	lines.push(style.accent("Efficiency"));
	for (const line of wrapParts(model.ratios.map((entry) => `${entry.label} ${entry.value}`), width)) lines.push(style.dim(`  ${line}`));
	lines.push("");
	lines.push(style.dim("e Export   r Refresh   Esc/q Close"));
	lines.push(style.dim(STATISTICS_LEGEND));
	return lines.map((line) => fit(line, width));
}

/** The framed layout used at and above `STATISTICS_NARROW_WIDTH`. */
function renderWide(model: StatisticsModel, width: number, style: StatisticsStyle): string[] {
	const inner = Math.max(1, width - 4);
	const content: string[] = [];
	content.push("");
	for (const line of wrapParts([costText(model), `${model.turns} turns`, `${formatTokens(model.tokens.total)} tokens`, model.timeline ? formatDuration(model.timeline.wallClockMs) : "n/a"], inner)) content.push(`  ${line}`);
	if (model.timeline) content.push(`  ${style.dim(timeSplit(model))}`);
	content.push("");
	content.push(style.accent("  Helpers"));
	if (model.subagents.length === 0) content.push(style.dim("    none"));
	for (const row of model.subagents) content.push(...rowLines(row, inner, style));
	content.push("");
	content.push(style.accent("  Models"));
	if (model.models.length === 0) content.push(style.dim("    none"));
	for (const row of model.models) content.push(...rowLines(row, inner, style));
	content.push("");
	content.push(style.accent("  Efficiency"));
	for (const line of wrapParts(model.ratios.map((entry) => `${entry.label} ${entry.value}`), inner - 4)) content.push(style.dim(`    ${line}`));
	content.push("");

	const title = " Session statistics ";
	const top = `${style.frame("╭─")}${style.title(title)}${style.frame(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`)}`;
	const body = content.map((line) => `${style.frame("│ ")}${fit(line, inner)}${style.frame(" │")}`);
	const footer = `${style.frame("│ ")}${fit(style.dim("e Export   r Refresh   Esc/q Close"), inner)}${style.frame(" │")}`;
	const legend = `${style.frame("│ ")}${fit(style.dim(STATISTICS_LEGEND), inner)}${style.frame(" │")}`;
	const bottom = style.frame(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
	return [top, ...body, footer, legend, bottom];
}

/** Render the model at `width`: framed when wide, stacked when narrow. */
export function renderStatistics(model: StatisticsModel, width: number, style: StatisticsStyle = PLAIN_STATISTICS_STYLE): string[] {
	const safeWidth = Math.max(1, width);
	return safeWidth < STATISTICS_NARROW_WIDTH ? renderNarrow(model, safeWidth, style) : renderWide(model, safeWidth, style);
}

export interface StatisticsViewDeps {
	/** The cached model; `render` never recomputes it. */
	readonly getModel: () => StatisticsModel;
	readonly onClose: () => void;
	readonly onExport: () => void;
	readonly onRefresh: () => void;
	readonly style?: StatisticsStyle;
}

/** The overlay component: renders the cached model and owns the keys. */
export class StatisticsView {
	private readonly deps: StatisticsViewDeps;

	constructor(deps: StatisticsViewDeps) {
		this.deps = deps;
	}

	render(width: number): string[] {
		return renderStatistics(this.deps.getModel(), width, this.deps.style ?? PLAIN_STATISTICS_STYLE);
	}

	handleInput(data: string): void {
		if (data === "\u001b" || data === "q") this.deps.onClose();
		else if (data === "e") this.deps.onExport();
		else if (data === "r") this.deps.onRefresh();
	}

	/** The model is supplied externally, so there is no cached render state to drop. */
	invalidate(): void {}
}
