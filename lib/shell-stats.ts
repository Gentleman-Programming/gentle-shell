import { formatElapsed } from "./agents-widget.ts";
import { formatCost, formatTokens } from "./shell-bar.ts";
import { PANEL_ROW_INDENT, renderPanelRow } from "./shell-panel.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

// Session statistics for the Power user rail (compact density): what the
// session spent, per model, and how the harness is behaving (cache reuse,
// tool failures, pace). Everything comes from the session's own entries.

export interface ModelStats {
	model: string;
	turns: number;
	tokens: number;
	cost: number;
}
export interface SessionStats {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Assistant responses. */
	turns: number;
	toolCalls: number;
	toolErrors: number;
	/** From the first to the last dated entry. */
	spanMs: number;
	/** Cache reads over every prompt token, or undefined before the first prompt. */
	cacheHitRate: number | undefined;
	/** Most expensive first; ties by tokens. */
	models: ModelStats[];
}

type StatsEntry = {
	type?: string;
	timestamp?: unknown;
	message?: {
		role?: string;
		model?: unknown;
		isError?: unknown;
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
	};
};

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

export function collectSessionStats(entries: readonly unknown[]): SessionStats {
	const stats: SessionStats = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, toolCalls: 0, toolErrors: 0, spanMs: 0, cacheHitRate: undefined, models: [] };
	const models = new Map<string, ModelStats>();
	let first = Infinity;
	let last = -Infinity;
	for (const raw of entries) {
		const entry = raw as StatsEntry;
		const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : count(entry.timestamp) || Number.NaN;
		if (Number.isFinite(at)) {
			first = Math.min(first, at);
			last = Math.max(last, at);
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "toolResult") {
			stats.toolCalls++;
			if (message.isError === true) stats.toolErrors++;
			continue;
		}
		if (message?.role !== "assistant") continue;
		const usage = message.usage ?? {};
		const input = count(usage.input);
		const output = count(usage.output);
		const cacheRead = count(usage.cacheRead);
		const cacheWrite = count(usage.cacheWrite);
		const cost = count(usage.cost?.total);
		stats.turns++;
		stats.input += input;
		stats.output += output;
		stats.cacheRead += cacheRead;
		stats.cacheWrite += cacheWrite;
		stats.cost += cost;
		// The registry id may carry a provider prefix (`claude-bridge/…`) and comes from
		// session files, so it is reduced to the model name and stripped of escapes.
		const id = typeof message.model === "string" ? sanitizeTerminalText(message.model).replace(/[\x00-\x1f\x7f]/g, "").trim() : "";
		const name = id.slice(id.lastIndexOf("/") + 1) || "unknown";
		const model = models.get(name) ?? { model: name, turns: 0, tokens: 0, cost: 0 };
		model.turns++;
		model.tokens += input + output + cacheRead + cacheWrite;
		model.cost += cost;
		models.set(name, model);
	}
	const prompt = stats.input + stats.cacheRead + stats.cacheWrite;
	stats.cacheHitRate = prompt > 0 ? stats.cacheRead / prompt : undefined;
	stats.spanMs = last > first ? last - first : 0;
	stats.models = [...models.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
	return stats;
}

type StatsTheme = { fg(role: string, text: string): string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The Stats section rows: totals first, then one row per model. */
export function renderStatsRows(stats: SessionStats, theme: StatsTheme, width: number, subscription = false): string[] {
	const label = (text: string) => theme.fg("muted", text.padEnd(7));
	const value = (text: string) => theme.fg("text", text);
	const muted = (text: string) => theme.fg("muted", text);
	const rows = [
		renderPanelRow(width, `${label("spent")}${value(formatCost(stats.cost, subscription))}`, muted(`${plural(stats.turns, "turn")} · ${formatElapsed(stats.spanMs)}`)),
		renderPanelRow(width, `${label("tokens")}${value(`in ${formatTokens(stats.input)} · out ${formatTokens(stats.output)}`)}`),
	];
	if (stats.cacheHitRate !== undefined) rows.push(renderPanelRow(width, `${label("cache")}${value(`${Math.round(stats.cacheHitRate * 100)}% hit · ${formatTokens(stats.cacheRead)} read`)}`));
	const failed = stats.toolErrors ? ` · ${theme.fg("warning", `${stats.toolErrors} failed`)}` : "";
	rows.push(renderPanelRow(width, `${label("tools")}${value(plural(stats.toolCalls, "call"))}${failed}`));
	for (const model of stats.models) {
		const numbers = `${plural(model.turns, "turn")} · ${formatTokens(model.tokens)} · ${formatCost(model.cost, subscription)}`;
		// A narrow rail keeps the name: the numbers move to their own row instead of clipping it away.
		if (visibleWidth(model.model) + 2 + visibleWidth(numbers) <= width - PANEL_ROW_INDENT) rows.push(renderPanelRow(width, value(model.model), muted(numbers)));
		else rows.push(renderPanelRow(width, value(model.model)), renderPanelRow(width, muted(numbers), "", PANEL_ROW_INDENT + 2));
	}
	return rows;
}
