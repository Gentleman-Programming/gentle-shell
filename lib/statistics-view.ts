// Statistics overlay view (epic #1, I8).
//
// The panel cannot be a sidebar rail from an extension (the painted section
// list is hardcoded and the header/Status slots are singletons), so it is the
// supported overlay: `ctx.ui.custom(..., { overlay: true })`. This module is
// the pure half — a model built from I4's aggregate and I5's timeline, and a
// width-aware renderer — plus the component that owns keyboard handling.
//
// Non-blocking: `render` reads the model it was handed and never recomputes an
// aggregate. The extension caches one snapshot and invalidates it on events.
//
// Every figure carries its provenance, and an unavailable value renders `n/a`,
// never `0`.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { NANO_USD_SCALE } from "./session-usage.ts";
import type { FigureProvenance, UsageAggregate, UsageBucket } from "./session-aggregate.ts";
import type { Timeline } from "./session-timeline.ts";

/** Below this width the panel drops the frame and stacks its sections. */
export const STATISTICS_NARROW_WIDTH = 60;

export interface StatisticsStyle {
	readonly title: (text: string) => string;
	readonly frame: (text: string) => string;
	readonly dim: (text: string) => string;
	readonly accent: (text: string) => string;
}

/** No styling: the default for tests and for a host without a theme. */
export const PLAIN_STATISTICS_STYLE: StatisticsStyle = { title: (text) => text, frame: (text) => text, dim: (text) => text, accent: (text) => text };

export interface StatisticsRow {
	readonly label: string;
	readonly turns: number;
	readonly cost: string;
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
	readonly cost: string;
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

function usd(nanoUsd: number): string {
	return (nanoUsd / NANO_USD_SCALE).toFixed(6);
}

/** A ratio is derived; an unavailable ratio is explicit, never a blank. */
function ratio(value: number | null): string {
	return value === null ? "n/a" : value.toFixed(4);
}

function rowFrom(label: string, bucket: UsageBucket): StatisticsRow {
	return { label, turns: bucket.turns, cost: usd(bucket.cost.nanoUsd), costProvenance: bucket.cost.provenance, tokens: bucket.tokens.total };
}

/** Build the display model from the aggregate and the optional timeline. Pure. */
export function buildStatisticsModel(aggregate: UsageAggregate, timeline: Timeline | null, generatedAt: number): StatisticsModel {
	return {
		cost: usd(aggregate.cost.nanoUsd),
		costProvenance: aggregate.cost.provenance,
		costAbsent: aggregate.cost.absent,
		turns: aggregate.turns,
		tokens: aggregate.tokens,
		ratios: [
			{ label: "cache-read share", value: ratio(aggregate.ratios.cacheReadShare) },
			{ label: "cache-write share", value: ratio(aggregate.ratios.cacheWriteShare) },
			{ label: "reasoning/output", value: ratio(aggregate.ratios.reasoningShareOfOutput) },
			{ label: "output/total", value: ratio(aggregate.ratios.outputToTotal) },
			{ label: "cost/turn", value: ratio(aggregate.ratios.costPerTurn) },
			{ label: "tokens/turn", value: ratio(aggregate.ratios.tokensPerTurn) },
		],
		subagents: aggregate.perSubagent.map((entry) => rowFrom(`${entry.taskId} ${entry.agent}`, entry)),
		models: aggregate.perModel.map((entry) => rowFrom(`${entry.provider}/${entry.model}`, entry)),
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
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function costLine(model: StatisticsModel): string {
	return model.costProvenance === "measured" ? `$${model.cost}` : `$${model.cost} + (${model.costAbsent} unreported)`;
}

function ratioLine(model: StatisticsModel): string {
	return model.ratios.map((entry) => `${entry.label} ${entry.value}`).join("   ");
}

/** The stacked, frameless layout used below `STATISTICS_NARROW_WIDTH`. */
function renderNarrow(model: StatisticsModel, width: number, style: StatisticsStyle): string[] {
	const lines: string[] = [];
	lines.push(style.title("Session statistics"));
	lines.push(`Cost ${costLine(model)} [${model.costProvenance}]`);
	lines.push(`Turns ${model.turns}   Tokens ${model.tokens.total}`);
	lines.push(`Timeline ${model.timeline ? `${formatDuration(model.timeline.modelMs)} model / ${formatDuration(model.timeline.toolMs)} tool / ${formatDuration(model.timeline.idleMs)} idle (est.)` : "n/a"}`);
	lines.push(style.dim(ratioLine(model)));
	lines.push(style.accent("Subagents"));
	if (model.subagents.length === 0) lines.push(style.dim("  none"));
	for (const row of model.subagents) lines.push(`  ${row.label}  ${row.turns}t $${row.cost} [${row.costProvenance}]`);
	lines.push(style.accent("Models"));
	if (model.models.length === 0) lines.push(style.dim("  none"));
	for (const row of model.models) lines.push(`  ${row.label}  ${row.turns}t $${row.cost} [${row.costProvenance}]`);
	lines.push(style.dim("e Export   r Refresh   Esc/q Close"));
	return lines.map((line) => fit(line, width));
}

/** The framed, two-column layout used at and above `STATISTICS_NARROW_WIDTH`. */
function renderWide(model: StatisticsModel, width: number, style: StatisticsStyle): string[] {
	const inner = Math.max(1, width - 4);
	const content: string[] = [];
	content.push(`${style.accent("Cost")}   ${costLine(model)} [${model.costProvenance}]`);
	content.push(`${style.accent("Turns")}  ${model.turns}   ${style.accent("Tokens")}  ${model.tokens.total}   ${style.accent("Wall")}  ${model.timeline ? formatDuration(model.timeline.wallClockMs) : "n/a"}`);
	content.push(`${style.accent("Model")}  ${model.timeline ? formatDuration(model.timeline.modelMs) : "n/a"}   ${style.accent("Tool")}  ${model.timeline ? formatDuration(model.timeline.toolMs) : "n/a"}   ${style.accent("Idle")}  ${model.timeline ? `${formatDuration(model.timeline.idleMs)} (est.)` : "n/a"}`);
	content.push(style.dim(ratioLine(model)));
	content.push("");
	content.push(style.accent("Subagents"));
	if (model.subagents.length === 0) content.push(style.dim("  none"));
	for (const row of model.subagents) content.push(`  ${fit(row.label, 32)} ${String(row.turns).padStart(3)}t  $${row.cost} [${row.costProvenance}]  ${row.tokens} tok`);
	content.push("");
	content.push(style.accent("Models"));
	if (model.models.length === 0) content.push(style.dim("  none"));
	for (const row of model.models) content.push(`  ${fit(row.label, 32)} ${String(row.turns).padStart(3)}t  $${row.cost} [${row.costProvenance}]  ${row.tokens} tok`);

	const title = " Session statistics ";
	const top = `${style.frame("╭─")}${style.title(title)}${style.frame(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`)}`;
	const body = content.map((line) => `${style.frame("│ ")}${fit(line, inner)}${style.frame(" │")}`);
	const footer = `${style.frame("│ ")}${fit(style.dim("e Export   r Refresh   Esc/q Close"), inner)}${style.frame(" │")}`;
	const bottom = style.frame(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
	return [top, ...body, footer, bottom];
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
