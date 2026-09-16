import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	accountIdFromToken,
	formatReset,
	parseAnthropicHeaders,
	parseCodexHeaders,
	parseUsageHeaders,
	parseCodexUsage,
	renderUsageBar,
	renderUsagePanel,
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

test("UsageStore keeps the latest snapshot per provider and lists them in order", () => {
	const store = new UsageStore();
	const first: ProviderUsage = { provider: "openai-codex", plan: "pro", limits: [], fetchedAt: 1 };
	const second: ProviderUsage = { provider: "openai-codex", plan: "pro", limits: [], fetchedAt: 2 };
	store.record(first);
	store.record({ provider: "anthropic", plan: undefined, limits: [], fetchedAt: 1 });
	store.record(second);
	assert.equal(store.get("openai-codex"), second);
	assert.deepEqual(store.all().map((usage) => usage.provider), ["openai-codex", "anthropic"]);
	store.clear();
	assert.equal(store.get("openai-codex"), undefined);
	assert.deepEqual(store.all(), []);
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
