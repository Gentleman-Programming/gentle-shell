import assert from "node:assert/strict";
import test from "node:test";
import { collectSessionStats, renderStatsRows } from "../lib/shell-stats.ts";
import { renderShellStatusSections } from "../lib/shell-bar.ts";

const assistant = (model: string, at: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }) => ({
	type: "message", timestamp: at,
	message: { role: "assistant", model, provider: "anthropic", usage: { ...usage, cost: { total: usage.cost } } },
});
const tool = (at: string, isError = false) => ({ type: "message", timestamp: at, message: { role: "toolResult", toolName: "bash", isError } });
const entries = [
	{ type: "session", timestamp: "2026-11-03T10:00:00.000Z" },
	{ type: "message", timestamp: "2026-11-03T10:00:01.000Z", message: { role: "user" } },
	assistant("claude-opus-5-5", "2026-11-03T10:00:10.000Z", { input: 100, output: 400, cacheRead: 8000, cacheWrite: 1500, cost: 0.5 }),
	tool("2026-11-03T10:00:11.000Z"),
	tool("2026-11-03T10:00:12.000Z", true),
	assistant("claude-opus-5-5", "2026-11-03T10:10:00.000Z", { input: 50, output: 600, cacheRead: 9000, cacheWrite: 500, cost: 0.75 }),
	assistant("gpt-5.5", "2026-11-03T11:05:00.000Z", { input: 2000, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.1 }),
	{ type: "custom", customType: "x", timestamp: "not a date" },
];

test("session stats total every assistant turn and break them down per model, most expensive first", () => {
	const stats = collectSessionStats(entries);
	assert.equal(stats.turns, 3);
	assert.equal(stats.toolCalls, 2);
	assert.equal(stats.toolErrors, 1);
	assert.equal(stats.input, 2150);
	assert.equal(stats.output, 1300);
	assert.equal(stats.cacheRead, 17000);
	assert.equal(stats.cacheWrite, 2000);
	assert.equal(Math.round(stats.cost * 100), 135);
	assert.equal(stats.spanMs, 65 * 60 * 1000, "the span runs from the first to the last dated entry");
	assert.equal(Math.round(stats.cacheHitRate! * 100), 80, "cache reads over every prompt token");
	assert.deepEqual(stats.models.map((model) => [model.model, model.turns, Math.round(model.cost * 100)]), [["claude-opus-5-5", 2, 125], ["gpt-5.5", 1, 10]]);
	const empty = collectSessionStats([]);
	assert.equal(empty.turns, 0);
	assert.equal(empty.cacheHitRate, undefined, "no prompt tokens, no hit rate");
	assert.equal(empty.spanMs, 0);
});

test("the Stats rows fit the rail and name each model with its share", () => {
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const rows = renderStatsRows(collectSessionStats(entries), theme, 46);
	for (const row of rows) assert.ok(row.length <= 46, `row fits: ${JSON.stringify(row)}`);
	const text = rows.map((row) => row.trimEnd()).join("\n");
	assert.match(text, /spent\s+\$1\.35/);
	assert.match(text, /3 turns · 1h05m/);
	assert.match(text, /tokens\s+in 2\.1k · out 1\.3k/);
	assert.match(text, /cache\s+80% hit · 17k read/);
	assert.match(text, /tools\s+2 calls · 1 failed/);
	assert.match(text, /claude-opus-5-5\s+2 turns · 20k · \$1\.25/);
	assert.match(text, /gpt-5\.5\s+1 turn · 2\.3k · \$0\.100/);
});

test("Status adds a foldable Stats section only when the model carries stats", () => {
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const model = { cwd: "~", modelId: "m", contextPercent: null, contextWindow: 0, costTotal: 0, subscription: false, statuses: [], changes: { files: 0, added: 0, deleted: 0 } } as never;
	const without = renderShellStatusSections(model, theme as never, 46).lines.join("\n");
	assert.doesNotMatch(without, /STATS/);
	const stats = collectSessionStats(entries);
	const view = renderShellStatusSections({ ...(model as object), stats } as never, theme as never, 46);
	const header = view.lines.findIndex((line) => /^▾ STATS\s+\$1\.35/.test(line));
	assert.ok(header >= 0, view.lines.join("\n"));
	assert.ok(view.targets.some((target) => target.kind === "toggle" && target.section === "stats" && target.row === header));
	const folded = renderShellStatusSections({ ...(model as object), stats } as never, theme as never, 46, undefined, undefined, { collapsed: new Set(["stats"]) }).lines.join("\n");
	assert.match(folded, /▸ STATS/);
	assert.doesNotMatch(folded, /spent/);
});

test("Stats rows keep the model name at narrow widths, strip escapes and ignore negative usage", () => {
	const theme = { fg: (_role: string, text: string) => text };
	const stats = collectSessionStats([
		assistant("claude-bridge/claude-opus-5-5", "2026-11-03T10:00:00.000Z", { input: 100, output: 200, cacheRead: 0, cacheWrite: -5, cost: 0.2 }),
		assistant("evil\x1b]0;pwned\x07model", "2026-11-03T10:01:00.000Z", { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0 }),
	]);
	assert.equal(stats.cacheWrite, 0, "negative usage is not counted");
	const rows = renderStatsRows(stats, theme, 30).map((row) => row.trimEnd());
	for (const row of rows) assert.ok(row.length <= 30, JSON.stringify(row));
	const text = rows.join("\n");
	assert.match(text, /claude-opus-5-5/, "the model name survives a narrow rail (provider prefix dropped)");
	assert.match(text, /1 turn · 300 · \$0\.200/, "its numbers move to their own row");
	assert.doesNotMatch(text, /\x1b|\x07/, "terminal escapes in a model id never reach the screen");
});
