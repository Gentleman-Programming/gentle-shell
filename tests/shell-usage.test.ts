import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	accountIdFromToken,
	formatReset,
	parseAnthropicHeaders,
	parseCodexHeaders,
	parseNanQuota,
	parseUsageHeaders,
	parseCodexUsage,
	providerNote,
	renderUsageBar,
	renderUsagePanel,
	SUPPORTED_USAGE_PROVIDERS,
	UsageStore,
	windowLabel,
	type ProviderUsage,
	type UsageWindow,
} from "../lib/shell-usage.ts";

// Subscription usage: what each connected provider says about its windows.
// Parsers are pure; the store only remembers the latest snapshot.

const NOW = 1_788_600_000_000;

const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
};

const taggedTheme = {
	fg(color: string, text: string) {
		return `<${color}>${text}</${color}>`;
	},
};

const CODEX_PAYLOAD = {
	plan_type: "pro",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 175_331, reset_at: 1_788_777_491 },
		secondary_window: null,
	},
	additional_rate_limits: [
		{
			limit_name: "codex_spark",
			metered_feature: "spark",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 18_000, reset_at: 1_788_620_161 },
				secondary_window: { used_percent: 3, limit_window_seconds: 604_800, reset_after_seconds: 604_800, reset_at: 1_789_206_961 },
			},
		},
	],
	credits: { has_credits: false, unlimited: false, balance: "0" },
	email: "someone@example.com",
};

test("windowLabel names the common windows and falls back to hours or days", () => {
	assert.equal(windowLabel(18_000), "5h");
	assert.equal(windowLabel(604_800), "week");
	assert.equal(windowLabel(10_800), "3h");
	assert.equal(windowLabel(172_800), "2d");
	assert.equal(windowLabel(1_800), "30m");
});

test("formatReset speaks in minutes, hours, or days", () => {
	assert.equal(formatReset(NOW + 25 * 60_000, NOW), "resets in 25m");
	assert.equal(formatReset(NOW + (1 * 3600 + 48 * 60) * 1000, NOW), "resets in 1h 48m");
	assert.equal(formatReset(NOW + (2 * 86_400 + 5 * 3600) * 1000, NOW), "resets in 2d 5h");
	assert.equal(formatReset(NOW - 1000, NOW), "resets now");
	assert.equal(formatReset(null, NOW), "");
});

test("parseCodexUsage keeps plan, windows, and named limits, and never keeps the email", () => {
	const usage = parseCodexUsage(CODEX_PAYLOAD, NOW);
	assert.equal(usage.provider, "openai-codex");
	assert.equal(usage.plan, "pro");
	assert.equal(usage.fetchedAt, NOW);
	assert.deepEqual(
		usage.limits.map((limit) => ({ name: limit.name, windows: limit.windows.map((w) => `${w.label}:${w.usedPercent}`) })),
		[
			{ name: "codex", windows: ["week:40"] },
			{ name: "codex_spark", windows: ["5h:12", "week:3"] },
		],
	);
	assert.equal(usage.limits[0].windows[0].resetAt, 1_788_777_491_000);
	assert.equal(JSON.stringify(usage).includes("example.com"), false);
});

test("parseCodexUsage tolerates a payload without rate limits", () => {
	const usage = parseCodexUsage({ plan_type: "free" }, NOW);
	assert.equal(usage.plan, "free");
	assert.deepEqual(usage.limits, []);
});

test("parseCodexHeaders reads the SSE rate-limit headers when a provider sends them", () => {
	const usage = parseCodexHeaders(
		{
			"x-codex-primary-used-percent": "62",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1788620161",
			"x-codex-secondary-used-percent": "31",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": "1789206961",
			"content-type": "text/event-stream",
		},
		NOW,
	);
	assert.ok(usage);
	assert.deepEqual(usage.limits[0].windows.map((w) => `${w.label}:${w.usedPercent}:${w.resetAt}`), ["5h:62:1788620161000", "week:31:1789206961000"]);
	assert.equal(parseCodexHeaders({ "content-type": "text/event-stream" }, NOW), undefined);
});

test("accountIdFromToken decodes the chatgpt account claim from an OAuth JWT", () => {
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } })).toString("base64url");
	assert.equal(accountIdFromToken(`header.${claims}.sig`), "acct-123");
	assert.equal(accountIdFromToken("sk-not-a-jwt"), undefined);
	assert.equal(accountIdFromToken("a.!!!.c"), undefined);
});

test("renderUsageBar summarizes the main limit with a gauge and the rest as percentages", () => {
	const usage = parseCodexUsage(CODEX_PAYLOAD, NOW);
	assert.equal(renderUsageBar(usage, plainTheme), "codex week ▰▰▰▱▱▱▱▱ 40%");
	const twoWindows = parseCodexUsage({ ...CODEX_PAYLOAD, rate_limit: CODEX_PAYLOAD.additional_rate_limits[0].rate_limit }, NOW);
	assert.equal(renderUsageBar(twoWindows, plainTheme), "codex 5h ▰▱▱▱▱▱▱▱ 12% · week 3%");
	const hot = renderUsageBar(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 91, limit_window_seconds: 18_000, reset_at: 1 } } }, NOW), taggedTheme);
	assert.match(hot, /<warning>▰▰▰▰▰▰▰<\/warning>/);
	assert.equal(renderUsageBar(parseCodexUsage({}, NOW), plainTheme), undefined);
});

test("renderUsagePanel lists each provider with meters, resets, and a stale marker", () => {
	const usage = parseCodexUsage(CODEX_PAYLOAD, NOW);
	const lines = renderUsagePanel([usage], plainTheme, 70, NOW + 3 * 60_000);
	for (const line of lines) assert.ok(visibleWidth(line) <= 70, `too wide: ${line}`);
	assert.match(lines[0], /^openai-codex · pro · updated 3m ago$/);
	// One row per window: the name, its meter, its percentage and, when the window
	// reports one, its reset, all on the same line.
	assert.match(lines[1], /^ {2}codex week +[▰▱]{16} +40% · resets in 2d 1h$/);
	assert.match(lines[2], /^ {2}codex_spark 5h +[▰▱]{16} +12% · resets in \d+h \d+m$/);
	assert.match(lines[3], /^ {2}codex_spark week +[▰▱]{16} +3% · resets in \d+d \d+h$/);
	assert.deepEqual(renderUsagePanel([], plainTheme, 120, NOW), ["No subscription usage yet. Usage arrives with the next response, or press r to fetch it."]);
});

test("renderUsagePanel puts the active provider first and explains missing data", () => {
	const codex = parseCodexUsage(CODEX_PAYLOAD, NOW);
	const claude = parseAnthropicHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.2" }, NOW);
	assert.ok(claude);
	const both = renderUsagePanel([codex, claude], plainTheme, 100, NOW, { provider: "anthropic" });
	assert.match(both[0], /^✿ anthropic · updated just now$/);
	assert.match(both[1], /^ {2}claude 5h +[▰▱]{16} +20%$/);
	assert.match(both.find((line) => line.startsWith("openai-codex")) ?? "", /^openai-codex · pro/);

	const apiKey = renderUsagePanel([codex], plainTheme, 100, NOW, { provider: "openai" });
	assert.match(apiKey[0], /^✿ openai · no subscription usage for this provider$/);
	assert.match(apiKey[1], /^openai-codex · pro/);

	const pending = renderUsagePanel([], plainTheme, 100, NOW, { provider: "anthropic" });
	assert.deepEqual(pending, ["✿ anthropic · usage arrives with the first response"]);
	assert.deepEqual(renderUsagePanel([], plainTheme, 100, NOW, { provider: "openai-codex" }), ["✿ openai-codex · no usage yet · r to fetch"]);
});

// NaN Cloud quota: per-model allowances for the billing period, plus the
// rolling window the model reports. Percentages are tokensUsed over cap, the
// same ratio the dashboard draws. The payload shape was read off the official
// dashboard bundle, not a published schema, so every field stays optional.
const NAN_QUOTA = {
	periodEnd: "2026-10-01T00:00:00.000Z",
	models: [
		{
			model: "glm5.3",
			cap: 3_000_000_000,
			fullCap: 3_000_000_000,
			tokensUsed: 820_000_000,
			windowHours: 4,
			windowTokens: 400_000_000,
			windowTokensUsed: 120_000_000,
			windowResetsAt: 1_788_620_161,
			email: "someone@example.com",
		},
		{ model: "deepseek-v4-flash", cap: 1_500_000_000, tokensUsed: 150_000_000 },
		{ model: "qwen3.8-flash", cap: 0, tokensUsed: 10 },
	],
};

// The billing-period window carries no label: the model id in front of it names
// the allowance, and the reset text says what the window is. Only a sub-window
// on top (a rolling `4h`) needs a name, so `windowText` spells the unlabeled one
// out for the assertions below.
function windowText(window: UsageWindow): string {
	return `${window.label === "" ? "period" : window.label}:${window.usedPercent}`;
}

test("parseNanQuota maps each model allowance and its rolling window", () => {
	const usage = parseNanQuota(NAN_QUOTA, NOW);
	assert.equal(usage.provider, "nan");
	assert.equal(usage.plan, undefined);
	assert.equal(usage.fetchedAt, NOW);
	assert.deepEqual(usage.limits.map((limit) => limit.name), ["glm5.3", "deepseek-v4-flash"]);

	const [glm, deepseek] = usage.limits;
	assert.deepEqual(glm.windows.map((window) => window.label), ["", "4h"]);
	assert.equal(glm.windows[0].usedPercent, (820_000_000 / 3_000_000_000) * 100);
	assert.equal(glm.windows[0].windowSeconds, 2_212_800);
	assert.equal(glm.windows[0].resetAt, 1_790_812_800_000);
	assert.equal(glm.windows[1].usedPercent, 30);
	assert.equal(glm.windows[1].windowSeconds, 14_400);
	assert.equal(glm.windows[1].resetAt, 1_788_620_161_000);
	assert.equal(glm.limitReached, false);
	assert.deepEqual(deepseek.windows.map(windowText), ["period:10"]);
	assert.equal(JSON.stringify(usage).includes("example.com"), false, "the quota parser must not keep unrelated account fields");
});

test("parseNanQuota falls back to the top-level period end and defaults the window budget", () => {
	const topLevel = parseNanQuota({ periodEnd: 1_790_812_800, models: [{ model: "glm5.3", cap: 3_000_000_000, tokensUsed: 0 }] }, NOW);
	assert.equal(topLevel.limits[0].windows[0].resetAt, 1_790_812_800_000);

	const defaulted = parseNanQuota({ models: [{ model: "glm5.3", cap: 3_000_000_000, tokensUsed: 0, windowTokensUsed: 100_000_000 }] }, NOW);
	assert.deepEqual(defaulted.limits[0].windows.map(windowText), ["period:0", "4h:25"]);

	const overCap = parseNanQuota({ models: [{ model: "glm5.3", cap: 3_000_000_000, tokensUsed: 3_000_000_000, windowHours: 12, windowTokensUsed: 60_000_000 }] }, NOW);
	assert.deepEqual(overCap.limits[0].windows.map(windowText), ["period:100", "12h:15"]);
	assert.equal(overCap.limits[0].limitReached, true);
});

test("parseNanQuota degrades to no data instead of throwing", () => {
	assert.deepEqual(parseNanQuota({}, NOW).limits, []);
	assert.deepEqual(parseNanQuota(undefined, NOW).limits, []);
	assert.deepEqual(parseNanQuota({ models: "nope" }, NOW).limits, []);
	assert.deepEqual(parseNanQuota({ models: [null, "glm5.3", 7] }, NOW).limits, []);
	assert.deepEqual(parseNanQuota({ models: [{ model: "glm5.3", cap: "3000000000", tokensUsed: 1 }] }, NOW).limits, []);
	assert.deepEqual(parseNanQuota({ models: [{ model: "glm5.3", cap: 3_000_000_000 }] }, NOW).limits, []);
	assert.deepEqual(parseNanQuota({ models: [{ model: "", cap: 3_000_000_000, tokensUsed: 1 }] }, NOW).limits, []);
});

test("nan is a supported usage provider with its own pending note", () => {
	assert.ok(SUPPORTED_USAGE_PROVIDERS.includes("nan"));
	assert.equal(providerNote("nan"), "no usage yet · r to fetch");
	assert.deepEqual(renderUsagePanel([], plainTheme, 100, NOW, { provider: "nan" }), ["✿ nan · no usage yet · r to fetch"]);
});

test("renderUsagePanel lists each NaN model allowance with its reset on the same row", () => {
	const usage = parseNanQuota(NAN_QUOTA, NOW);
	const lines = renderUsagePanel([usage], plainTheme, 80, NOW, { provider: "nan" });
	for (const line of lines) assert.ok(visibleWidth(line) <= 80, `too wide: ${line}`);
	assert.match(lines[0], /^✿ nan · updated just now$/);
	assert.match(lines[1], /^ {2}glm5\.3 +[▰▱]{16} +27% · resets in \d+d \d+h$/);
	// The rolling window a model reports is a row of its own, with its own reset.
	assert.match(lines[2], /^ {2}glm5\.3 4h +[▰▱]{16} +30% · resets in \d+h \d+m$/);
	assert.match(lines[3], /^ {2}deepseek-v4-flash +[▰▱]{16} +10% · resets in \d+d \d+h$/);
	assert.equal(lines.some((line) => line.includes("total")), false, "an aggregate row only costs space");
});

// The server picks the order of the per-model allowances, so drawing the first
// one showed DeepSeek's meter inside a GLM session. The bar follows the model
// the session actually uses, and falls back to the account total when that
// model holds no allowance of its own.
test("renderUsageBar prefers the active model allowance over the payload order", () => {
	const usage = parseNanQuota(NAN_QUOTA, NOW);
	assert.equal(renderUsageBar(usage, plainTheme, "deepseek-v4-flash"), "deepseek-v4-flash ▰▱▱▱▱▱▱▱ 10%");
	assert.equal(renderUsageBar(usage, plainTheme, "glm5.3"), "glm5.3 ▰▰▱▱▱▱▱▱ 27% · 4h 30%");
	assert.equal(renderUsageBar(usage, plainTheme), "glm5.3 ▰▰▱▱▱▱▱▱ 27% · 4h 30%", "without an active model the first limit still wins");
	assert.equal(renderUsageBar(usage, plainTheme, "gemma4"), "nan total ▰▰▱▱▱▱▱▱ 22%", "an unmetered model reports the account, never another model");
	assert.equal(renderUsageBar(usage, plainTheme, "qwen3.8-flash"), "nan total ▰▰▱▱▱▱▱▱ 22%", "a model the payload skips holds no allowance either");
});

test("renderUsageBar prefers the active model's family before the account total", () => {
	const usage = parseNanQuota({
		periodEnd: "2026-10-01T00:00:00.000Z",
		models: [
			{ model: "glm5.3-flash", cap: 2_000_000_000, tokensUsed: 200_000_000 },
			{ model: "deepseek-v4-flash", cap: 4_000_000_000, tokensUsed: 200_000_000 },
		],
	}, NOW);
	// The session model holds no allowance of its own and its family has exactly
	// one member: the family is still a closer name for the meter than the whole
	// account, so the ladder visits it before the account rung.
	assert.match(renderUsageBar(usage, plainTheme, "glm5.3-turbo") ?? "", /^glm total ▰▱▱▱▱▱▱▱ 10%$/);
	assert.match(renderUsageBar(usage, plainTheme, "gemma4") ?? "", /^nan total ▰▱▱▱▱▱▱▱ 7%$/, "no member of the family means the account is the only honest name");
});

test("a single metered allowance still takes the family and account names", () => {
	const usage = parseNanQuota({
		periodEnd: "2026-10-01T00:00:00.000Z",
		models: [
			{ model: "glm5.3-flash", cap: 2_000_000_000, tokensUsed: 400_000_000 },
			{ model: "gemma4", cap: 0 },
		],
	}, NOW);
	// One metered model is still a payload that carries raw allowances, so the bar
	// names the allowance the session draws from instead of listing whichever
	// model the payload happened to report.
	assert.deepEqual(usage.limits.map((limit) => limit.name), ["glm5.3-flash"]);
	assert.equal(renderUsageBar(usage, plainTheme, "glm5.3-flash"), "glm5.3-flash ▰▰▱▱▱▱▱▱ 20%");
	assert.match(renderUsageBar(usage, plainTheme, "glm5.4") ?? "", /^glm total ▰▰▱▱▱▱▱▱ 20%$/);
	assert.match(renderUsageBar(usage, plainTheme, "gemma4") ?? "", /^nan total ▰▰▱▱▱▱▱▱ 20%$/);
});

test("renderUsageBar leaves providers without raw allowances on their first limit", () => {
	assert.equal(renderUsageBar(parseCodexUsage(CODEX_PAYLOAD, NOW), plainTheme, "gpt-5.2-codex"), "codex week ▰▰▰▱▱▱▱▱ 40%");
});

test("parseNanQuota weights the period window by the effective allowance", () => {
	const usage = parseNanQuota({
		periodEnd: "2026-10-01T00:00:00.000Z",
		models: [
			{ model: "glm5.3-flash", cap: 1_500_000_000, fullCap: 2_000_000_000, tokensUsed: 200_000_000 },
			{ model: "glm5.3", cap: 0, fullCap: 3_000_000_000, tokensUsed: 300_000_000 },
		],
	}, NOW);
	// The dashboard divides by the full-period allowance, not by the prorated cap
	// the current period reports, so the percentages keep matching it.
	assert.deepEqual(usage.limits.map((limit) => limit.name), ["glm5.3-flash", "glm5.3"]);
	const [prorated, noPeriodCap] = usage.limits;
	assert.equal(prorated.windows[0].budget, 2_000_000_000, "fullCap is the denominator when it is positive");
	assert.equal(prorated.windows[0].usedPercent, 10);
	assert.equal(noPeriodCap.windows[0].budget, 3_000_000_000, "a period cap prorated to zero still reports a metered model");
	assert.equal(noPeriodCap.windows[0].usedPercent, 10);
	assert.equal(noPeriodCap.limitReached, false);
});

test("parseNanQuota refuses a payload that hides a metered model's usage", () => {
	// A sibling with a metered allowance whose usage cannot be read is drift, not
	// a model to skip: a partial snapshot would understate every aggregate it
	// feeds, so the read fails whole and the last valid snapshot survives.
	const drifted = parseNanQuota({
		periodEnd: "2026-10-01T00:00:00.000Z",
		models: [
			{ model: "glm5.3", cap: 3_000_000_000, tokensUsed: 820_000_000 },
			{ model: "deepseek-v4-flash", cap: 2_000_000_000 },
		],
	}, NOW);
	assert.deepEqual(drifted.limits, []);
	// No allowance at all is not drift: the dashboard draws nothing for these
	// models either, and today's real payload carries them.
	const unmetered = parseNanQuota({
		models: [
			{ model: "glm5.3", cap: 3_000_000_000, tokensUsed: 820_000_000 },
			{ model: "gemma4", cap: 0 },
			{ model: "qwen3.8-flash", tokensUsed: 10 },
		],
	}, NOW);
	assert.deepEqual(unmetered.limits.map((limit) => limit.name), ["glm5.3"]);
	assert.deepEqual(parseNanQuota({ models: "none" }, NOW).limits, []);
});

test("parseNanQuota keeps the raw numbers the aggregates are weighted by", () => {
	const [glm] = parseNanQuota(NAN_QUOTA, NOW).limits;
	assert.equal(glm.windows[0].used, 820_000_000);
	assert.equal(glm.windows[0].budget, 3_000_000_000);
	const [codex] = parseCodexUsage(CODEX_PAYLOAD, NOW).limits[0].windows;
	assert.equal(codex.used, undefined, "only NaN reports raw allowance numbers, which is what gates the aggregates");
	assert.equal(codex.budget, undefined);
});

// Grouping is a presentation decision: the panel adds the account total and one
// row per family with more than one metered model, and each of those rows is an
// ordinary limit block, the shape Codex already uses for its extra limits.
const GROUPED_NAN_QUOTA = {
	periodEnd: "2026-10-01T00:00:00.000Z",
	models: [
		{ model: "glm5.3-flash", cap: 2_000_000_000, tokensUsed: 200_000_000 },
		{ model: "glm5.3", cap: 3_000_000_000, tokensUsed: 0, periodEnd: "2026-10-17T05:53:20.000Z" },
		{ model: "glm5.2", cap: 3_000_000_000, tokensUsed: 0, periodEnd: "2026-10-17T05:53:20.000Z" },
		{ model: "deepseek-v4-flash", cap: 3_000_000_000, tokensUsed: 300_000_000 },
	],
};

function panelNames(lines: string[]): string[] {
	return lines.filter(isMeterRow).map((line) => line.trim().replace(/\s*[▰▱].*$/, ""));
}

// A meter row carries the row name and its gauge on one line; the reset, when the
// window reports one, is the line underneath.
function isMeterRow(line: string): boolean {
	return /[▰▱]/.test(line);
}

// A row carries its own reset on the same line when the window reports one.
function panelResets(lines: string[]): string[] {
	return lines.filter(isMeterRow).map((line) => /resets in .*$/.exec(line)?.[0] ?? "").filter((reset) => reset.length > 0);
}

function panelPercents(lines: string[]): number[] {
	return lines.filter(isMeterRow).map((line) => Number.parseInt(line.trim().match(/(\d+)%/)![1] ?? "", 10));
}

test("renderUsagePanel orders the NaN allowances by family and prints no totals", () => {
	const lines = renderUsagePanel([parseNanQuota(GROUPED_NAN_QUOTA, NOW)], plainTheme, 80, NOW, { provider: "nan" }).map((line) => line.trimEnd());
	assert.deepEqual(panelNames(lines), ["deepseek-v4-flash", "glm5.3-flash", "glm5.3", "glm5.2"]);
	// 300M of 3B for DeepSeek first, then the GLM family by its own allowance.
	assert.deepEqual(panelPercents(lines), [10, 10, 0, 0]);
	// Every row keeps its own reset, inline: one line per window, never two.
	const resets = panelResets(lines);
	assert.equal(resets.length, 4);
	assert.equal(resets[0], resets[1], "the two models on the 2026-10-01 period share their date");
	assert.equal(resets[2], resets[3], "the two models on the 2026-10-17 period share theirs");
	assert.notEqual(resets[1], resets[2], "each row carries its own window's reset, not its family's");
});

test("renderUsagePanel leaves providers without raw allowances ungrouped", () => {
	const lines = renderUsagePanel([parseCodexUsage(CODEX_PAYLOAD, NOW)], plainTheme, 70, NOW);
	assert.equal(lines.some((line) => line.includes("total")), false);
	assert.match(lines[1], /^ {2}codex week /);
});

test("UsageStore keeps the latest snapshot per provider and lists them in order", () => {
	const store = new UsageStore();
	const first: ProviderUsage = { provider: "openai-codex", plan: "pro", limits: [], fetchedAt: 1 };
	const second: ProviderUsage = { provider: "openai-codex", plan: "pro", limits: [], fetchedAt: 2 };
	store.record(first);
	store.record({ provider: "anthropic", plan: undefined, limits: [], fetchedAt: 1 });
	store.record(second);
	assert.equal(store.get("openai-codex"), second);
	assert.deepEqual(store.all().map((usage) => usage.provider), ["openai-codex", "anthropic"]);
});

test("parseAnthropicHeaders turns the unified utilization fractions into 5h and weekly windows", () => {
	const headers = {
		"anthropic-ratelimit-unified-status": "allowed_warning",
		"anthropic-ratelimit-unified-5h-utilization": "0.42",
		"anthropic-ratelimit-unified-5h-reset": "1788620161",
		"anthropic-ratelimit-unified-7d-utilization": "0.875",
		"anthropic-ratelimit-unified-7d-reset": "1789206961",
		"anthropic-ratelimit-unified-representative-claim": "seven_day",
	};
	const usage = parseAnthropicHeaders(headers, NOW);
	assert.ok(usage);
	assert.equal(usage.provider, "anthropic");
	assert.deepEqual(usage.limits.map((limit) => limit.name), ["claude"]);
	assert.deepEqual(usage.limits[0].windows.map((w) => `${w.label}:${w.usedPercent}:${w.resetAt}`), ["5h:42:1788620161000", "week:87.5:1789206961000"]);
	assert.equal(usage.limits[0].limitReached, false);
	assert.equal(parseAnthropicHeaders({ ...headers, "anthropic-ratelimit-unified-status": "rejected" }, NOW)?.limits[0].limitReached, true);
	assert.equal(parseAnthropicHeaders({ "anthropic-ratelimit-requests-remaining": "99" }, NOW), undefined);
});

test("parseUsageHeaders picks whichever provider the headers belong to", () => {
	assert.equal(parseUsageHeaders({ "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": "300" }, NOW)?.provider, "openai-codex");
	assert.equal(parseUsageHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.1" }, NOW)?.provider, "anthropic");
	assert.equal(parseUsageHeaders({ "content-type": "application/json" }, NOW), undefined);
});
