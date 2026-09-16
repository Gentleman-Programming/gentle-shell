import assert from "node:assert/strict";
import test from "node:test";
import {
	ANTIGRAVITY_ENDPOINTS,
	ANTIGRAVITY_PROVIDER,
	ANTIGRAVITY_QUOTA_PATH,
	COMMAND_CODE_PROVIDER,
	credentialToken,
	fetchAntigravityUsage,
	fetchCommandCodeUsage,
	fetchOptionalProviderUsage,
	fetchOpenCodeGoUsage,
	OPENCODE_GO_PROVIDER,
	OPENCODE_GO_USAGE_URL,
	parseAntigravityUsage,
	parseCommandCodeUsage,
	parseOpenCodeGoUsage,
} from "../lib/shell-usage-providers.ts";

const NOW = Date.parse("2026-09-16T20:00:00Z");

function response(payload: unknown, ok = true): Response {
	return { ok, json: async () => payload } as Response;
}

test("credentialToken understands each provider credential without retaining account metadata", () => {
	assert.equal(credentialToken(OPENCODE_GO_PROVIDER, "oc-key"), "oc-key");
	assert.equal(credentialToken(COMMAND_CODE_PROVIDER, "cmd-key"), "cmd-key");
	assert.equal(credentialToken(COMMAND_CODE_PROVIDER, "$COMMAND_CODE_API_KEY"), undefined);
	assert.equal(credentialToken(ANTIGRAVITY_PROVIDER, JSON.stringify({ token: "google-token", projectId: "secret-project", email: "user@example.com" })), "google-token");
	assert.equal(credentialToken(ANTIGRAVITY_PROVIDER, "not-json"), undefined);
});

test("parseOpenCodeGoUsage maps rolling, weekly and monthly utilization", () => {
	const usage = parseOpenCodeGoUsage({
		account: { email: "must-not-survive@example.com" },
		usage: {
			rolling: { status: "ok", percent: 12 },
			weekly: { status: "ok", percent: 34 },
			monthly: { status: "ok", percent: 56 },
		},
	}, NOW);
	assert.deepEqual(usage, {
		provider: "opencode-go",
		plan: "Go",
		limits: [{
			name: "opencode",
			windows: [
				{ label: "5h", usedPercent: 12, windowSeconds: 18_000, resetAt: null },
				{ label: "week", usedPercent: 34, windowSeconds: 604_800, resetAt: null },
				{ label: "month", usedPercent: 56, windowSeconds: 2_592_000, resetAt: null },
			],
			limitReached: false,
		}],
		fetchedAt: NOW,
	});
	assert.doesNotMatch(JSON.stringify(usage), /must-not-survive|example\.com/);
});

test("parseOpenCodeGoUsage marks the plan exhausted when any quota window is full", () => {
	const usage = parseOpenCodeGoUsage({
		usage: {
			rolling: { status: "ok", percent: 20 },
			weekly: { status: "ok", percent: 100 },
		},
	}, NOW);
	assert.equal(usage?.limits[0]?.limitReached, true);
});

test("parseAntigravityUsage converts remaining fractions and keeps independent shared pools", () => {
	const usage = parseAntigravityUsage({
		email: "must-not-survive@example.com",
		groups: [
			{ displayName: "Gemini Models", buckets: [
				{ displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.75, resetTime: "2026-09-23T20:00:00Z" },
				{ displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: 0.5, resetTime: "2026-09-17T01:00:00Z" },
			] },
			{ displayName: "Claude and GPT models", buckets: [
				{ displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0, resetTime: "2026-09-23T20:00:00Z" },
			] },
		],
	}, NOW);
	assert.equal(usage?.provider, ANTIGRAVITY_PROVIDER);
	assert.deepEqual(usage?.limits.map((limit) => ({
		name: limit.name,
		windows: limit.windows.map((window) => `${window.label}:${window.usedPercent}:${window.windowSeconds}`),
		reached: limit.limitReached,
	})), [
		{ name: "Gemini Models", windows: ["5h:50:18000", "week:25:604800"], reached: false },
		{ name: "Claude and GPT models", windows: ["week:100:604800"], reached: true },
	]);
	assert.equal(usage?.limits[0]?.windows[1]?.resetAt, Date.parse("2026-09-23T20:00:00Z"));
	assert.doesNotMatch(JSON.stringify(usage), /must-not-survive|example\.com/);
});

test("parseCommandCodeUsage keeps windows, billing credits and plan but drops identity", () => {
	const usage = parseCommandCodeUsage(
		{
			account: { login: "must-not-survive" },
			windowLimits: {
				fiveHour: { used: 4, cap: 16, resetAt: 1_789_596_528_896 },
				weekly: { used: 10, cap: 40, resetAt: 1_790_155_819_241 },
			},
			credits: { monthlyCredits: 75, purchasedCredits: 5, freeCredits: 0 },
		},
		{ data: { planId: "individual-pro-v1", currentPeriodStart: "2026-09-13T14:42:32Z", currentPeriodEnd: "2026-10-13T14:42:32Z" } },
		{ totalCost: 20, totalCount: 95 },
		NOW,
	);
	assert.equal(usage?.provider, COMMAND_CODE_PROVIDER);
	assert.equal(usage?.plan, "individual pro v1");
	assert.deepEqual(usage?.limits[0]?.windows.map((window) => `${window.label}:${window.usedPercent}`), ["5h:25", "week:25"]);
	assert.equal(usage?.limits[1]?.name, "credits");
	assert.equal(usage?.limits[1]?.windows[0]?.usedPercent, 20);
	assert.equal(usage?.limits[1]?.windows[0]?.resetAt, Date.parse("2026-10-13T14:42:32Z"));
	assert.doesNotMatch(JSON.stringify(usage), /must-not-survive/);
});

test("parseCommandCodeUsage does not invent an exhausted balance from absent or invalid credits", () => {
	for (const credits of [undefined, {}, { monthlyCredits: "invalid", purchasedCredits: -1, freeCredits: null }]) {
		const usage = parseCommandCodeUsage(
			{ windowLimits: { fiveHour: { used: 1, cap: 4 } }, ...(credits === undefined ? {} : { credits }) },
			{ data: { planId: "pro" } },
			{ totalCost: 20 },
			NOW,
		);
		assert.deepEqual(usage?.limits.map((limit) => limit.name), ["command code"]);
	}
});

test("provider reset timestamps reject malformed or impossible RFC3339 values", () => {
	for (const resetTime of ["2026-02-30T00:00:00Z", "2026-01-01T25:00:00Z", "2026-01-01 00:00:00", "not-a-date"]) {
		const usage = parseAntigravityUsage({ groups: [{ buckets: [{ window: "5h", remainingFraction: 0.5, resetTime }] }] }, NOW);
		assert.equal(usage?.limits[0]?.windows[0]?.resetAt, null, resetTime);
	}
	const offset = parseAntigravityUsage({ groups: [{ buckets: [{ window: "5h", remainingFraction: 0.5, resetTime: "2026-09-17T01:00:00-05:00" }] }] }, NOW);
	assert.equal(offset?.limits[0]?.windows[0]?.resetAt, Date.parse("2026-09-17T01:00:00-05:00"));
});

test("fetchOpenCodeGoUsage sends the provider credential only to the Go usage endpoint", async () => {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return response({ usage: { rolling: { status: "ok", percent: 7 } } });
	}) as typeof fetch;
	const usage = await fetchOpenCodeGoUsage("oc-secret", fetchFn, NOW);
	assert.equal(usage?.limits[0]?.windows[0]?.usedPercent, 7);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.url, OPENCODE_GO_USAGE_URL);
	assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer oc-secret");
});

test("fetchAntigravityUsage follows pi-antigravity's endpoint fallback order", async () => {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		if (calls.length === 1) return response({}, false);
		return response({ groups: [{ displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.8 }] }] });
	}) as typeof fetch;
	const usage = await fetchAntigravityUsage("google-secret", fetchFn, NOW);
	assert.equal(usage?.limits[0]?.windows[0]?.usedPercent, 20);
	assert.deepEqual(calls.map((call) => call.url), [
		`${ANTIGRAVITY_ENDPOINTS[0]}${ANTIGRAVITY_QUOTA_PATH}`,
		`${ANTIGRAVITY_ENDPOINTS[1]}${ANTIGRAVITY_QUOTA_PATH}`,
	]);
	assert.equal(calls[0]?.init?.method, "POST");
	assert.equal(calls[0]?.init?.body, "{}");
	assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer google-secret");
});

test("fetchCommandCodeUsage follows the provider plugin's dependent quota requests", async () => {
	const calls: string[] = [];
	const fetchFn = (async (url: string | URL | Request) => {
		const value = String(url);
		calls.push(value);
		if (value.endsWith("/alpha/whoami")) return response({ org: { id: "org one", login: "private" } });
		if (value.includes("/alpha/billing/credits")) return response({ windowLimits: { fiveHour: { used: 1, cap: 4 } }, credits: { monthlyCredits: 9 } });
		if (value.includes("/alpha/billing/subscriptions")) return response({ data: { planId: "pro", currentPeriodStart: "2026-09-01", currentPeriodEnd: "2026-10-01" } });
		return response({ totalCost: 1 });
	}) as typeof fetch;
	const usage = await fetchCommandCodeUsage("cmd-secret", fetchFn, NOW, "https://command.example");
	assert.equal(usage?.limits[0]?.windows[0]?.usedPercent, 25);
	assert.deepEqual(calls, [
		"https://command.example/alpha/whoami",
		"https://command.example/alpha/billing/credits?orgId=org%20one",
		"https://command.example/alpha/billing/subscriptions?orgId=org%20one",
		"https://command.example/alpha/usage/summary?orgId=org%20one&since=2026-09-01",
	]);
	assert.doesNotMatch(JSON.stringify(usage), /org one|private/);
});

test("fetchCommandCodeUsage refuses remote cleartext API overrides before sending a credential", async () => {
	let calls = 0;
	const fetchFn = (async () => {
		calls += 1;
		return response({});
	}) as typeof fetch;
	assert.equal(await fetchCommandCodeUsage("cmd-secret", fetchFn, NOW, "http://command.example"), undefined);
	assert.equal(calls, 0);
});

test("fetchCommandCodeUsage permits loopback HTTP for local provider development", async () => {
	const calls: string[] = [];
	const fetchFn = (async (url: string | URL | Request) => {
		calls.push(String(url));
		return response(calls.length === 1 ? { org: {} } : calls.length === 2 ? { windowLimits: { fiveHour: { used: 1, cap: 2 } } } : calls.length === 3 ? { data: {} } : { totalCost: 0 });
	}) as typeof fetch;
	assert.ok(await fetchCommandCodeUsage("cmd-secret", fetchFn, NOW, "http://127.0.0.1:8787/provider/v1"));
	assert.equal(calls[0], "http://127.0.0.1:8787/alpha/whoami");
});

test("Command Code usage preserves the provider plugin's zero-data-retention header", async () => {
	const headers: Array<Record<string, string>> = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		headers.push(init?.headers as Record<string, string>);
		const value = String(url);
		if (value.endsWith("/alpha/whoami")) return response({ org: {} });
		if (value.includes("/alpha/billing/credits")) return response({ windowLimits: { fiveHour: { used: 1, cap: 2 } } });
		if (value.includes("/alpha/billing/subscriptions")) return response({ data: {} });
		return response({ totalCost: 0 });
	}) as typeof fetch;
	const usage = await fetchOptionalProviderUsage(COMMAND_CODE_PROVIDER, "cmd-secret", fetchFn, NOW, { COMMANDCODE_ZDR: "1" });
	assert.ok(usage);
	assert.ok(headers.length >= 4);
	assert.ok(headers.every((value) => value["x-cmd-zdr"] === "1"));
});
