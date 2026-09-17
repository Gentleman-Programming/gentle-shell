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
	assert.match(lines[1], /^ {2}codex$/);
	assert.match(lines[2], /^ {4}week +▰+▱+ +40% +resets in 2d 1h$/);
	assert.match(lines[3], /^ {2}codex_spark$/);
	assert.match(lines[4], /^ {4}5h /);
	assert.match(lines[5], /^ {4}week /);
	assert.deepEqual(renderUsagePanel([], plainTheme, 120, NOW), ["No subscription usage yet. Usage arrives with the next response, or press r to fetch it."]);
});

test("renderUsagePanel puts the active provider first and explains missing data", () => {
	const codex = parseCodexUsage(CODEX_PAYLOAD, NOW);
	const claude = parseAnthropicHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.2" }, NOW);
	assert.ok(claude);
	const both = renderUsagePanel([codex, claude], plainTheme, 100, NOW, { provider: "anthropic" });
	assert.match(both[0], /^✿ anthropic · updated just now$/);
	assert.match(both[1], /^ {2}claude$/);
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

test("parseNanQuota maps each model allowance and its rolling window", () => {
	const usage = parseNanQuota(NAN_QUOTA, NOW);
	assert.equal(usage.provider, "nan");
	assert.equal(usage.plan, undefined);
	assert.equal(usage.fetchedAt, NOW);
	assert.deepEqual(usage.limits.map((limit) => limit.name), ["glm5.3", "deepseek-v4-flash"]);

	const [glm, deepseek] = usage.limits;
	assert.deepEqual(glm.windows.map((window) => window.label), ["period", "4h"]);
	assert.equal(glm.windows[0].usedPercent, (820_000_000 / 3_000_000_000) * 100);
	assert.equal(glm.windows[0].windowSeconds, 2_212_800);
	assert.equal(glm.windows[0].resetAt, 1_790_812_800_000);
	assert.equal(glm.windows[1].usedPercent, 30);
	assert.equal(glm.windows[1].windowSeconds, 14_400);
	assert.equal(glm.windows[1].resetAt, 1_788_620_161_000);
	assert.equal(glm.limitReached, false);
	assert.deepEqual(deepseek.windows.map((window) => `${window.label}:${window.usedPercent}`), ["period:10"]);
	assert.equal(JSON.stringify(usage).includes("example.com"), false, "the quota parser must not keep unrelated account fields");
});

test("parseNanQuota falls back to the top-level period end and defaults the window budget", () => {
	const topLevel = parseNanQuota({ periodEnd: 1_790_812_800, models: [{ model: "glm5.3", cap: 3_000_000_000, tokensUsed: 0 }] }, NOW);
	assert.equal(topLevel.limits[0].windows[0].resetAt, 1_790_812_800_000);

	const defaulted = parseNanQuota({ models: [{ model: "glm5.3", cap: 3_000_000_000, tokensUsed: 0, windowTokensUsed: 100_000_000 }] }, NOW);
	assert.deepEqual(defaulted.limits[0].windows.map((window) => `${window.label}:${window.usedPercent}`), ["period:0", "4h:25"]);

	const overCap = parseNanQuota({ models: [{ model: "glm5.3", cap: 3_000_000_000, tokensUsed: 3_000_000_000, windowHours: 12, windowTokensUsed: 60_000_000 }] }, NOW);
	assert.deepEqual(overCap.limits[0].windows.map((window) => `${window.label}:${window.usedPercent}`), ["period:100", "12h:15"]);
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

test("renderUsagePanel lists the NaN account total ahead of the per-model allowances", () => {
	const usage = parseNanQuota(NAN_QUOTA, NOW);
	const lines = renderUsagePanel([usage], plainTheme, 80, NOW, { provider: "nan" });
	assert.match(lines[0], /^✿ nan · updated just now$/);
	assert.match(lines[1], /^ {2}nan total$/);
	assert.match(lines[2], /^ {4}period .+ 22%$/);
	assert.match(lines[3], /^ {2}glm5\.3$/);
	assert.match(lines[4], /^ {4}period .+ 27% +resets in \d+d \d+h$/);
	assert.match(lines[5], /^ {4}4h .+ 30% +resets in \d+h \d+m$/);
	assert.match(lines[6], /^ {2}deepseek-v4-flash$/);
});

// The server picks the order of the per-model allowances, so drawing the first
// one showed DeepSeek's meter inside a GLM session. The bar follows the model
// the session actually uses, and falls back to the account total when that
// model holds no allowance of its own.
test("renderUsageBar prefers the active model allowance over the payload order", () => {
	const usage = parseNanQuota(NAN_QUOTA, NOW);
	assert.equal(renderUsageBar(usage, plainTheme, "deepseek-v4-flash"), "deepseek-v4-flash period ▰▱▱▱▱▱▱▱ 10%");
	assert.equal(renderUsageBar(usage, plainTheme, "glm5.3"), "glm5.3 period ▰▰▱▱▱▱▱▱ 27% · 4h 30%");
	assert.equal(renderUsageBar(usage, plainTheme), "glm5.3 period ▰▰▱▱▱▱▱▱ 27% · 4h 30%", "without an active model the first limit still wins");
	assert.equal(renderUsageBar(usage, plainTheme, "gemma4"), "nan total period ▰▰▱▱▱▱▱▱ 22%", "an unmetered model reports the account, never another model");
	assert.equal(renderUsageBar(usage, plainTheme, "qwen3.8-flash"), "nan total period ▰▰▱▱▱▱▱▱ 22%", "a model the payload skips holds no allowance either");
});

test("renderUsageBar leaves providers without raw allowances on their first limit", () => {
	assert.equal(renderUsageBar(parseCodexUsage(CODEX_PAYLOAD, NOW), plainTheme, "gpt-5.2-codex"), "codex week ▰▰▰▱▱▱▱▱ 40%");
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
	return lines.filter((line) => !line.trim().startsWith("period")).map((line) => line.trim());
}

function panelPercents(lines: string[]): number[] {
	return lines.filter((line) => line.trim().startsWith("period")).map((line) => Number.parseInt(line.trim().match(/(\d+)%/)![1] ?? "", 10));
}

test("renderUsagePanel groups NaN allowances by family and totals the account", () => {
	const lines = renderUsagePanel([parseNanQuota(GROUPED_NAN_QUOTA, NOW)], plainTheme, 80, NOW, { provider: "nan" }).map((line) => line.trimEnd());
	assert.deepEqual(panelNames(lines), ["✿ nan · updated just now", "nan total", "deepseek-v4-flash", "glm total", "glm5.3-flash", "glm5.3", "glm5.2"]);
	// 500M of 11B account-wide, 200M of 8B across the GLM members, then each model.
	assert.deepEqual(panelPercents(lines), [5, 10, 3, 10, 0, 0]);
	assert.deepEqual(
		lines.filter((line) => line.trim().startsWith("period")).map((line) => line.includes("resets in")),
		[false, true, false, true, true, true],
		"a group closes when its members do, so it carries no single reset",
	);
});

test("renderUsagePanel leaves providers without raw allowances ungrouped", () => {
	const lines = renderUsagePanel([parseCodexUsage(CODEX_PAYLOAD, NOW)], plainTheme, 70, NOW);
	assert.equal(lines.some((line) => line.includes("total")), false);
	assert.match(lines[1], /^ {2}codex$/);
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
