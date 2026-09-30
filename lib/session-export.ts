// Statistics exporters (epic #1, I7).
//
// A human billing hours needs a file, and tooling needs a stable shape. The
// renderers take I4's `UsageAggregate` and nothing else, so the export and any
// UI cannot diverge: there is one source of numbers. Every figure states its
// provenance — `measured`, `partial` for a cost with an unreported component,
// `derived` for a ratio — and an unavailable ratio is written as `n/a`, never a
// blank that reads as zero.
//
// Only allowlisted aggregate fields are read; prompt text, response text and
// filesystem paths cannot reach any artifact. The output is deterministic for a
// given aggregate (the clock is injected and omitted by default).

import { NANO_USD_SCALE } from "./session-usage.ts";
import type { CountFigure, FigureProvenance, MoneyFigure, TokenFigure, UsageAggregate, UsageBucket } from "./session-aggregate.ts";

export const STATISTICS_EXPORT_SCHEMA = "gentle-shell.statistics/v1";

export interface ExportOptions {
	/** Injected clock. Omitted by default so the output is stable across runs. */
	readonly generatedAt?: number;
}

interface ExportRow {
	readonly scope: "session" | "model" | "agent_class" | "subagent" | "project";
	readonly key: string;
	readonly bucket: UsageBucket;
}

function rowsOf(aggregate: UsageAggregate): ExportRow[] {
	return [
		{ scope: "session", key: "", bucket: aggregate },
		...aggregate.perModel.map((entry): ExportRow => ({ scope: "model", key: `${entry.provider}/${entry.model}`, bucket: entry })),
		...aggregate.perAgentClass.map((entry): ExportRow => ({ scope: "agent_class", key: entry.agentClass, bucket: entry })),
		...aggregate.perSubagent.map((entry): ExportRow => ({ scope: "subagent", key: entry.taskId, bucket: entry })),
		...aggregate.perProject.map((entry): ExportRow => ({ scope: "project", key: entry.project, bucket: entry })),
	];
}

function usd(nanoUsd: number): string {
	return (nanoUsd / NANO_USD_SCALE).toFixed(6);
}

/** A ratio is `derived`; an unavailable ratio is explicit, never a blank. */
function ratio(value: number | null): string {
	return value === null ? "n/a" : value.toFixed(6);
}

function countProvenance(count: CountFigure): FigureProvenance {
	return count.provenance;
}

/** The versioned JSON envelope, with `derived` marked on the ratios object. */
export function exportStatisticsJson(aggregate: UsageAggregate, options: ExportOptions = {}): string {
	const payload = {
		schema: STATISTICS_EXPORT_SCHEMA,
		...(options.generatedAt !== undefined ? { generatedAt: options.generatedAt } : {}),
		session: {
			asOf: aggregate.asOf,
			turns: aggregate.turns,
			cost: aggregate.cost,
			tokens: aggregate.tokens,
			ratios: { ...aggregate.ratios, provenance: "derived" as const },
			counts: { sessions: aggregate.sessions, subagents: aggregate.subagents, toolCalls: aggregate.toolCalls },
		},
		perModel: aggregate.perModel,
		perAgentClass: aggregate.perAgentClass,
		perSubagent: aggregate.perSubagent,
		perProject: aggregate.perProject,
	};
	return `${JSON.stringify(payload, null, 2)}\n`;
}

const CSV_COLUMNS = [
	"scope",
	"key",
	"turns",
	"cost_usd",
	"cost_provenance",
	"cost_absent_components",
	"tokens_input",
	"tokens_output",
	"tokens_cache_read",
	"tokens_cache_write",
	"tokens_reasoning",
	"tokens_total",
	"tokens_provenance",
	"cache_read_share",
	"cache_write_share",
	"reasoning_share_of_output",
	"output_to_total",
	"cost_per_turn",
	"tokens_per_turn",
	"ratios_provenance",
] as const;

function csvField(value: string): string {
	return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One row per scope, with an explicit provenance column and `n/a` for unavailable ratios. */
export function exportStatisticsCsv(aggregate: UsageAggregate): string {
	const lines = [CSV_COLUMNS.join(",")];
	for (const row of rowsOf(aggregate)) {
		const { bucket } = row;
		lines.push(
			[
				row.scope,
				csvField(row.key),
				String(bucket.turns),
				usd(bucket.cost.nanoUsd),
				bucket.cost.provenance,
				String(bucket.cost.absent),
				String(bucket.tokens.input),
				String(bucket.tokens.output),
				String(bucket.tokens.cacheRead),
				String(bucket.tokens.cacheWrite),
				String(bucket.tokens.reasoning),
				String(bucket.tokens.total),
				bucket.tokens.provenance,
				ratio(bucket.ratios.cacheReadShare),
				ratio(bucket.ratios.cacheWriteShare),
				ratio(bucket.ratios.reasoningShareOfOutput),
				ratio(bucket.ratios.outputToTotal),
				ratio(bucket.ratios.costPerTurn),
				ratio(bucket.ratios.tokensPerTurn),
				"derived",
			].join(","),
		);
	}
	return `${lines.join("\n")}\n`;
}

function costCell(cost: MoneyFigure): string {
	return cost.provenance === "measured" ? `$${usd(cost.nanoUsd)}` : `$${usd(cost.nanoUsd)} + (${cost.absent} unreported)`;
}

function tokenCell(tokens: TokenFigure): string {
	return `${tokens.total} (in ${tokens.input}, out ${tokens.output}, cache r/w ${tokens.cacheRead}/${tokens.cacheWrite}, reasoning ${tokens.reasoning})`;
}

function breakdownTable(rows: readonly ExportRow[]): string[] {
	const lines = ["| Scope | Key | Turns | Cost | Cost provenance | Tokens | Cache-read share | Reasoning/output | Cost/turn |", "| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |"];
	for (const row of rows) {
		lines.push(
			`| ${row.scope} | ${row.key === "" ? "session" : row.key} | ${row.bucket.turns} | ${costCell(row.bucket.cost)} | ${row.bucket.cost.provenance} | ${row.bucket.tokens.total} | ${ratio(row.bucket.ratios.cacheReadShare)} | ${ratio(row.bucket.ratios.reasoningShareOfOutput)} | ${ratio(row.bucket.ratios.costPerTurn)} |`,
		);
	}
	return lines;
}

/** A human report: a session summary, then one row per scope, provenance included. */
export function exportStatisticsMarkdown(aggregate: UsageAggregate, options: ExportOptions = {}): string {
	const lines: string[] = ["# Session statistics", ""];
	if (options.generatedAt !== undefined) {
		lines.push(`Generated: ${new Date(options.generatedAt).toISOString()}`, "");
	}
	lines.push(
		"## Session",
		"",
		"| Metric | Value | Provenance |",
		"| --- | ---: | --- |",
		`| Turns | ${aggregate.turns} | measured |`,
		`| Cost | ${costCell(aggregate.cost)} | ${aggregate.cost.provenance} |`,
		`| Tokens | ${tokenCell(aggregate.tokens)} | ${aggregate.tokens.provenance} |`,
		`| Sessions | ${aggregate.sessions.value} | ${countProvenance(aggregate.sessions)} |`,
		`| Subagents | ${aggregate.subagents.value} | ${countProvenance(aggregate.subagents)} |`,
		`| Tool calls | ${aggregate.toolCalls.value} | ${countProvenance(aggregate.toolCalls)} |`,
		"",
		"Ratios are derived; `n/a` means the denominator is zero (unavailable), never zero.",
		"",
		"## Breakdown",
		"",
		...breakdownTable(rowsOf(aggregate)),
		"",
	);
	return lines.join("\n");
}
