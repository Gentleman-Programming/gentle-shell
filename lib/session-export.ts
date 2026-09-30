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
import type { BillableReport } from "./billable-hours.ts";

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

// ---------------------------------------------------------------------------
// Billable hours (I9): the same renderer discipline, from the billable report.
// ---------------------------------------------------------------------------

function hours(ms: number): string {
	const totalMinutes = Math.round(ms / 60_000);
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	if (h === 0) return `${m}m`;
	return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function amountText(amount: number, currency: string): string {
	return `${amount.toFixed(2)} ${currency}`;
}

function apiCostText(nanoUsd: number, provenance: FigureProvenance): string {
	return `$${usd(nanoUsd)}${provenance === "partial" ? " (partial)" : ""}`;
}

function roundingText(policy: BillableReport["config"]["rounding"]): string {
	return policy.mode === "none" ? "none" : `${policy.mode} ${policy.minutes} min`;
}

function periodText(report: BillableReport): string {
	const at = (value: number | null) => (value === null ? "…" : new Date(value).toISOString().slice(0, 10));
	return report.range.from === null && report.range.to === null ? "all sessions" : `${at(report.range.from)} → ${at(report.range.to)}`;
}

/** A human hours report: totals, per project, per session, and the measured/derived statement. */
export function exportBillableMarkdown(report: BillableReport, options: ExportOptions = {}): string {
	const lines: string[] = ["# Billable hours", ""];
	if (options.generatedAt !== undefined) lines.push(`Generated: ${new Date(options.generatedAt).toISOString()}`, "");
	lines.push(
		`Period: ${periodText(report)}`,
		`Rate: ${report.config.hourlyRate.toFixed(2)} ${report.config.currency}/h · rounding: ${roundingText(report.config.rounding)}`,
		"",
		"## Totals",
		"",
		"| Sessions | Wall clock | Billable | Amount | API cost |",
		"| ---: | ---: | ---: | ---: | --- |",
		`| ${report.totals.sessions} | ${hours(report.totals.wallClockMs)} | ${hours(report.totals.billableMs)} | ${amountText(report.totals.amount, report.config.currency)} | ${apiCostText(report.totals.costNanoUsd, report.totals.costProvenance)} |`,
		"",
		"## By project",
		"",
		"| Project | Sessions | Wall clock | Billable | Amount |",
		"| --- | ---: | ---: | ---: | ---: |",
	);
	for (const project of report.projects) lines.push(`| ${project.project} | ${project.sessions} | ${hours(project.wallClockMs)} | ${hours(project.billableMs)} | ${amountText(project.amount, report.config.currency)} |`);
	lines.push("", "## By session", "", "| Session | Project | Wall clock | Billable | Amount | API cost |", "| --- | --- | ---: | ---: | ---: | --- |");
	for (const session of report.sessions) lines.push(`| ${session.sessionId} | ${session.project} | ${hours(session.wallClockMs)} | ${hours(session.billableMs)} | ${amountText(session.amount, report.config.currency)} | ${apiCostText(session.costNanoUsd, session.costProvenance)} |`);
	lines.push("", "## Provenance", "", `- measured: ${report.provenance.measured}`, `- derived: ${report.provenance.derived}`, `- estimated: ${report.provenance.estimated}`, "");
	return lines.join("\n");
}

const BILLABLE_CSV_COLUMNS = ["scope", "key", "project", "sessions", "wall_clock_ms", "billable_ms", "amount", "currency", "api_cost_usd", "api_cost_provenance"] as const;

/** One row per scope, with the API cost's provenance alongside the billed amount. */
export function exportBillableCsv(report: BillableReport): string {
	const lines = [BILLABLE_CSV_COLUMNS.join(",")];
	lines.push(["total", "", "", String(report.totals.sessions), String(report.totals.wallClockMs), String(report.totals.billableMs), report.totals.amount.toFixed(2), report.config.currency, usd(report.totals.costNanoUsd), report.totals.costProvenance].join(","));
	for (const project of report.projects) lines.push(["project", csvField(project.project), csvField(project.project), String(project.sessions), String(project.wallClockMs), String(project.billableMs), project.amount.toFixed(2), report.config.currency, usd(project.costNanoUsd), project.costProvenance].join(","));
	for (const session of report.sessions) lines.push(["session", csvField(session.sessionId), csvField(session.project), "1", String(session.wallClockMs), String(session.billableMs), session.amount.toFixed(2), report.config.currency, usd(session.costNanoUsd), session.costProvenance].join(","));
	return `${lines.join("\n")}\n`;
}

/** The versioned billable envelope. Only the report's own fields are read, so an extra field cannot leak. */
export function exportBillableJson(report: BillableReport, options: ExportOptions = {}): string {
	return `${JSON.stringify(
		{
			schema: report.schema,
			generatedAt: options.generatedAt ?? report.generatedAt,
			config: report.config,
			range: report.range,
			totals: report.totals,
			projects: report.projects,
			sessions: report.sessions,
			provenance: report.provenance,
		},
		null,
		2,
	)}\n`;
}
