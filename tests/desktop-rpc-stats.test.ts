import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import gentleStats from "../extensions/gentle-stats.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_STATS_EVENTS,
	DESKTOP_STATS_METHODS,
	DESKTOP_STATS_SERVICE_CHANNEL,
	DESKTOP_STATS_SERVICE_SCHEMA,
	INVALID_STATS_PARAMS,
	parseUsageStatsParams,
	projectDesktopUsageStats,
	projectDisplayName,
	STATS_UNAVAILABLE,
	type DesktopStatsOwnerRead,
	type DesktopStatsService,
} from "../lib/desktop-rpc-stats.ts";
import { DesktopStatsBridge, discoverDesktopStatsService } from "../lib/desktop-stats-service.ts";
import { createStatsLoader, localDayKey, type SessionRecord, type StatsLoader } from "../lib/stats-collector.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";
import { isolatedConfigEnv, removeIsolatedConfigHomes } from "./isolated-config-home.ts";

after(removeIsolatedConfigHomes);

// get_usage_stats: the Desktop read over the same loader and aggregation the
// /gentle:stats panel uses. Fixtures are session files written into a fresh
// temp sessions root outside the worktree, read by the real gentle-stats owner
// through the real Desktop transport.

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
// Days are bucketed in local time like the panel, so expected day keys go
// through the owner's own `localDayKey`. Every fixture sits at 12:00 UTC, so
// its local day keeps the same 7d/30d window membership from UTC-11 to UTC+14.
const localDay = (iso: string): string => localDayKey(Date.parse(iso));
const ALPHA = "/home/devel/secret/alpha";
const BETA = "/home/devel/secret/beta";

interface Usage { at: string; provider?: string; model: string; input: number; output: number; cacheRead?: number; cacheWrite?: number; total?: number; cost: number }

function writeSession(root: string, cwd: string, id: string, usages: Usage[], prompt = "secret prompt text"): void {
	const dir = join(root, `--${cwd.replace(/[\\/]+/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	const lines = [
		{ type: "session", version: 3, id, timestamp: usages[0]?.at ?? new Date(NOW).toISOString(), cwd },
		{ type: "message", timestamp: usages[0]?.at ?? new Date(NOW).toISOString(), message: { role: "user", content: prompt } },
		...usages.map((usage) => ({
			type: "message",
			timestamp: usage.at,
			message: {
				role: "assistant",
				provider: usage.provider ?? "test-provider",
				model: usage.model,
				content: [{ type: "text", text: "secret answer text" }],
				usage: {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead ?? 0,
					cacheWrite: usage.cacheWrite ?? 0,
					...(usage.total === undefined ? {} : { totalTokens: usage.total }),
					cost: { total: usage.cost },
				},
			},
		})),
	];
	writeFileSync(join(dir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

function historyRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "desktop-rpc-stats-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeSession(root, ALPHA, "s-alpha-1", [
		{ at: "2026-10-09T12:00:00.000Z", model: "claude-opus-5-5", input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, total: 1350, cost: 0.5 },
		{ at: "2026-10-09T12:05:00.000Z", model: "claude-opus-5-5", input: 10, output: 5, cost: 0.01 },
	]);
	writeSession(root, ALPHA, "s-alpha-2", [{ at: "2026-09-20T12:00:00.000Z", model: "gpt-5.5", input: 1000, output: 0, cost: 1 }]);
	writeSession(root, ALPHA, "s-alpha-3", [{ at: "2025-01-01T12:00:00.000Z", model: "old-model", input: 7, output: 3, cost: 0 }]);
	writeSession(root, BETA, "s-beta-1", [{ at: "2026-10-08T12:00:00.000Z", model: "gpt-5.5", input: 200, output: 100, cost: 0.25 }]);
	return root;
}

function interactiveHost(t: test.TestContext): void {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
}

function spyLoader() {
	const inner = createStatsLoader();
	const calls: Array<readonly string[]> = [];
	const results: Array<Promise<SessionRecord[]>> = [];
	const loader: StatsLoader = {
		load(roots) {
			calls.push(typeof roots === "string" ? [roots] : [...roots]);
			const result = inner.load(roots);
			results.push(result);
			return result;
		},
	};
	return { loader, calls, results };
}

/** The real Desktop transport and, unless `owner: false`, the real gentle-stats owner on one fake pi. */
function harness(t: test.TestContext, options: { roots?: readonly string[]; owner?: boolean; loader?: StatsLoader } = {}) {
	interactiveHost(t);
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {},
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: {
			on(name: string, handler: (value: unknown) => void) {
				const set = listeners.get(name) ?? new Set();
				set.add(handler);
				listeners.set(name, set);
				return () => set.delete(handler);
			},
			emit(name: string, value: unknown) { for (const handler of [...(listeners.get(name) ?? [])]) handler(value); },
		},
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	if (options.owner !== false) {
		gentleStats(pi, { env: isolatedConfigEnv({}), now: () => NOW, sessionsRoots: () => options.roots ?? [], loader: options.loader });
	}
	const widgets: string[] = [];
	const ctx = {
		mode: "rpc",
		cwd: ALPHA,
		sessionManager: { getCwd: () => ALPHA, getSessionId: () => "session-a", getEntries: () => [] },
		ui: { setWidget(_key: string, lines: string[]) { widgets.push(...lines); } },
	};
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	return {
		widgets,
		listeners,
		async fire(event: string) { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); },
		async invoke(requestId: string, params: Record<string, unknown>, method = "get_usage_stats") {
			await commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }), ctx);
		},
		responses() { return widgets.map((line) => JSON.parse(line)); },
	};
}

// ---- Capabilities ----

test("the Desktop transport advertises get_usage_stats and no new event", (t) => {
	assert.deepEqual([...DESKTOP_STATS_METHODS], ["get_usage_stats"]);
	assert.deepEqual([...DESKTOP_STATS_EVENTS], []);
	const app = harness(t, { owner: false });
	void app.invoke("cap-1", {}, "capabilities");
	const response = app.responses()[0];
	assert.ok(response.data.methods.includes("get_usage_stats"));
	assert.equal(response.data.methods.filter((method: string) => method === "get_usage_stats").length, 1);
	assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed"]);
});

// ---- The read ----

test("get_usage_stats defaults to the last 7 days of the current project", async (t) => {
	const app = harness(t, { roots: [historyRoot(t)] });
	await app.invoke("stats-1", {});
	const responses = app.responses();
	assert.equal(responses.length, 1, "a read publishes its response and no event");
	assert.equal(responses[0].kind, "response");
	assert.equal(responses[0].requestId, "stats-1");
	assert.equal(responses[0].ok, true);
	assert.deepEqual(responses[0].data, {
		range: "7d",
		scope: "project",
		totals: { sessions: 1, messages: 2, inputTokens: 110, outputTokens: 55, cacheReadTokens: 1000, cacheWriteTokens: 200, totalTokens: 1365, cost: 0.51 },
		byModel: [{ model: "claude-opus-5-5", messages: 2, tokens: 1365, cost: 0.51, share: 1 }],
		byDay: [{ day: localDay("2026-10-09T12:00:00.000Z"), tokens: 1365, cost: 0.51 }],
		byProvider: [{ provider: "test-provider", messages: 2, tokens: 1365, cost: 0.51, share: 1 }],
		truncated: { byModel: false, byDay: false, byProvider: false },
	});
});

test("get_usage_stats honors range and scope exactly like aggregateStats, with projects as display names", async (t) => {
	const app = harness(t, { roots: [historyRoot(t)] });
	await app.invoke("stats-30d", { range: "30d", scope: "all" });
	await app.invoke("stats-all", { range: "all", scope: "all" });
	await app.invoke("stats-all-project", { range: "all", scope: "project" });
	const [month, all, allProject] = app.responses();

	assert.deepEqual(month.data, {
		range: "30d",
		scope: "all",
		totals: { sessions: 3, messages: 4, inputTokens: 1310, outputTokens: 155, cacheReadTokens: 1000, cacheWriteTokens: 200, totalTokens: 2665, cost: 1.76 },
		byModel: [
			{ model: "claude-opus-5-5", messages: 2, tokens: 1365, cost: 0.51, share: 1365 / 2665 },
			{ model: "gpt-5.5", messages: 2, tokens: 1300, cost: 1.25, share: 1300 / 2665 },
		],
		byDay: [{ day: localDay("2026-09-20T12:00:00.000Z"), tokens: 1000, cost: 1 }, { day: localDay("2026-10-08T12:00:00.000Z"), tokens: 300, cost: 0.25 }, { day: localDay("2026-10-09T12:00:00.000Z"), tokens: 1365, cost: 0.51 }],
		byProvider: [{ provider: "test-provider", messages: 4, tokens: 2665, cost: 1.76, share: 1 }],
		byProject: [
			{ name: "alpha", sessions: 2, messages: 3, tokens: 2365, cost: 1.51 },
			{ name: "beta", sessions: 1, messages: 1, tokens: 300, cost: 0.25 },
		],
		truncated: { byModel: false, byDay: false, byProvider: false, byProject: false },
	});

	assert.equal(all.data.range, "all");
	assert.equal(all.data.totals.sessions, 4);
	assert.equal(all.data.totals.totalTokens, 2675);
	assert.deepEqual(all.data.byDay[0], { day: localDay("2025-01-01T12:00:00.000Z"), tokens: 10, cost: 0 });
	assert.deepEqual(all.data.byProject.map((project: { name: string; sessions: number }) => [project.name, project.sessions]), [["alpha", 3], ["beta", 1]]);

	// Project scope never carries a project breakdown.
	assert.equal(allProject.data.scope, "project");
	assert.equal(allProject.data.totals.sessions, 3);
	assert.equal("byProject" in allProject.data, false);
	assert.deepEqual(allProject.data.truncated, { byModel: false, byDay: false, byProvider: false });

	// No path, session id, or message text ever reaches the wire.
	const wire = app.widgets.join("\n");
	for (const secret of ["/home/devel", "secret/", "s-alpha", "s-beta", "secret prompt text", "secret answer text"]) {
		assert.equal(wire.includes(secret), false, secret);
	}
});

test("get_usage_stats bounds models, days, and projects and flags truncation while totals stay complete", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "desktop-rpc-stats-bounds-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bulk: Usage[] = [];
	for (let day = 0; day < 450; day++) {
		bulk.push({ at: new Date(NOW - day * DAY_MS).toISOString(), model: `model-${String(day % 60).padStart(2, "0")}`, input: 1, output: 0, cost: 0 });
	}
	writeSession(root, "/p/bulk", "bulk", bulk);
	for (let project = 0; project < 51; project++) {
		writeSession(root, `/p/proj-${String(project).padStart(2, "0")}`, `proj-${project}`, [{ at: new Date(NOW).toISOString(), model: "model-00", input: 1, output: 0, cost: 0 }]);
	}
	const app = harness(t, { roots: [root] });
	await app.invoke("bounds", { range: "all", scope: "all" });
	const { data } = app.responses()[0];
	assert.equal(data.totals.sessions, 52);
	assert.equal(data.totals.messages, 501);
	assert.equal(data.totals.totalTokens, 501);
	assert.equal(data.byModel.length, 50);
	assert.equal(data.byDay.length, 400);
	assert.equal(data.byProject.length, 50);
	assert.deepEqual(data.truncated, { byModel: true, byDay: true, byProvider: false, byProject: true });
	// The most recent days are kept, oldest first; the largest project leads.
	assert.equal(data.byDay.at(-1).day, localDayKey(NOW));
	assert.equal(data.byDay[0].day, localDayKey(NOW - 399 * DAY_MS));
	assert.deepEqual(data.byProject[0], { name: "bulk", sessions: 1, messages: 450, tokens: 450, cost: 0 });
});

test("get_usage_stats reads through the owner's single loader and concurrent requests share one load", async (t) => {
	const root = historyRoot(t);
	const spy = spyLoader();
	const app = harness(t, { roots: [root], loader: spy.loader });
	await Promise.all([app.invoke("c-1", { range: "all", scope: "all" }), app.invoke("c-2", { range: "all", scope: "all" })]);
	assert.deepEqual(spy.calls, [[root], [root]]);
	const [first, second] = await Promise.all(spy.results);
	assert.equal(first, second, "one in-flight scan answers both requests");
	const responses = app.responses();
	assert.deepEqual(responses.map((response) => response.requestId).sort(), ["c-1", "c-2"]);
	assert.deepEqual(responses[0].data, responses[1].data);
});

// ---- Failures ----

test("invalid get_usage_stats params are rejected before any owner load", async (t) => {
	const spy = spyLoader();
	const app = harness(t, { roots: [historyRoot(t)], loader: spy.loader });
	const invalid: Array<Record<string, unknown>> = [
		{ range: "1d" },
		{ range: 7 },
		{ scope: "global" },
		{ scope: null },
		{ range: "7d", extra: true },
	];
	for (const [index, params] of invalid.entries()) await app.invoke(`bad-${index}`, params);
	for (const response of app.responses()) {
		assert.equal(response.ok, false);
		assert.deepEqual(response.error, INVALID_STATS_PARAMS);
	}
	assert.equal(app.responses().length, invalid.length);
	assert.deepEqual(spy.calls, []);
});

test("get_usage_stats answers stats_unavailable when no session root can be read", async (t) => {
	const app = harness(t, { roots: [join(tmpdir(), "desktop-rpc-stats-missing-root"), join(tmpdir(), "desktop-rpc-stats-missing-root-2")] });
	await app.invoke("none", {});
	const [response] = app.responses();
	assert.equal(response.ok, false);
	assert.deepEqual(response.error, STATS_UNAVAILABLE);
});

test("get_usage_stats answers stats_unavailable without the stats owner extension", async (t) => {
	const app = harness(t, { owner: false });
	await app.invoke("no-owner", {});
	const [response] = app.responses();
	assert.equal(response.ok, false);
	assert.deepEqual(response.error, STATS_UNAVAILABLE);
});

test("the stats owner leaves the bus on session shutdown", async (t) => {
	const app = harness(t, { roots: [historyRoot(t)] });
	assert.equal(app.listeners.get(DESKTOP_STATS_SERVICE_CHANNEL)?.size, 1);
	await app.fire("session_shutdown");
	assert.equal(app.listeners.get(DESKTOP_STATS_SERVICE_CHANNEL)?.size, 0);
});

// ---- Bridge lifecycle and discovery ----

test("a session reset drops a read that was in flight", async () => {
	let release: (read: DesktopStatsOwnerRead) => void = () => {};
	const disposed: string[] = [];
	const service: DesktopStatsService = {
		schema: DESKTOP_STATS_SERVICE_SCHEMA,
		read: () => new Promise((resolve) => { release = resolve; }),
		dispose: () => disposed.push("owner"),
	};
	const bridge = new DesktopStatsBridge({} as ExtensionAPI, { discover: async () => service });
	bridge.attach({ sessionManager: { getCwd: () => ALPHA } } as unknown as ExtensionContext);
	const pending = bridge.handle("get_usage_stats", {});
	await new Promise((resolve) => setTimeout(resolve, 0));
	bridge.reset();
	release({ kind: "ok", sessions: [], now: NOW });
	assert.deepEqual(await pending, { ok: false, error: STATS_UNAVAILABLE });
	assert.deepEqual(disposed, ["owner"]);
	// Unrelated methods fall through to the next slice.
	assert.equal(await bridge.handle("list_jobs", {}), undefined);
});

test("a throwing or malformed owner read answers stats_unavailable", async () => {
	for (const read of [
		async () => { throw new Error("EACCES: /home/devel/secret"); },
		async () => ({ kind: "unavailable" }) as DesktopStatsOwnerRead,
		async () => ({ kind: "ok", sessions: "nope", now: NOW }) as unknown as DesktopStatsOwnerRead,
	]) {
		const service: DesktopStatsService = { schema: DESKTOP_STATS_SERVICE_SCHEMA, read, dispose: () => {} };
		const bridge = new DesktopStatsBridge({} as ExtensionAPI, { discover: async () => service });
		bridge.attach({ sessionManager: { getCwd: () => ALPHA } } as unknown as ExtensionContext);
		assert.deepEqual(await bridge.handle("get_usage_stats", {}), { ok: false, error: STATS_UNAVAILABLE });
	}
});

test("discoverDesktopStatsService accepts the versioned adapter and ignores malformed responders", async () => {
	const listeners = new Map<string, (value: unknown) => void>();
	const pi = {
		events: {
			on(name: string, handler: (value: unknown) => void) { listeners.set(name, handler); return () => listeners.delete(name); },
			emit(name: string, value: unknown) { listeners.get(name)?.(value); },
		},
	} as unknown as ExtensionAPI;
	const ctx = {} as ExtensionContext;
	listeners.set(DESKTOP_STATS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({ schema: DESKTOP_STATS_SERVICE_SCHEMA, read: async () => ({ kind: "unavailable" }), dispose: () => {} });
	});
	assert.equal((await discoverDesktopStatsService(pi, ctx))?.schema, DESKTOP_STATS_SERVICE_SCHEMA);
	listeners.set(DESKTOP_STATS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({ schema: "gentle-pi.desktop-stats-service/v0", read: async () => ({ kind: "unavailable" }), dispose: () => {} });
	});
	assert.equal(await discoverDesktopStatsService(pi, ctx), undefined);
});

// ---- Regressions from the independent verifier's probes ----

const INVALID_PARAMS: Array<Record<string, unknown>> = [{ range: null }, { scope: null }, { range: "1d" }, { scope: "global" }, { extra: 1 }, { range: 7 }, { range: "7D" }];

test("invalid params are rejected before discovery, with or without an attached host", async () => {
	for (const attached of [true, false]) {
		for (const params of INVALID_PARAMS) {
			let discovered = 0;
			const bridge = new DesktopStatsBridge({} as ExtensionAPI, { discover: async () => { discovered++; return undefined; } });
			if (attached) bridge.attach({ cwd: "/x" } as unknown as ExtensionContext);
			assert.deepEqual(await bridge.handle("get_usage_stats", params), { ok: false, error: INVALID_STATS_PARAMS }, `${attached} ${JSON.stringify(params)}`);
			assert.equal(discovered, 0);
		}
	}
	// Valid params without an attached host stay a truthful absence.
	const bridge = new DesktopStatsBridge({} as ExtensionAPI, { discover: async () => undefined });
	assert.deepEqual(await bridge.handle("get_usage_stats", {}), { ok: false, error: STATS_UNAVAILABLE });
	assert.deepEqual(parseUsageStatsParams({}), { range: "7d", scope: "project" });
});

function record(id: string, cwd: string, usages: Array<{ at: number; model: string; input: number }>): SessionRecord {
	return {
		id,
		cwd,
		startedAt: Date.parse("2026-10-01T00:00:00.000Z"),
		messages: usages.map((usage) => ({ timestamp: usage.at, provider: "p", model: usage.model, input: usage.input, output: 1, cacheRead: 2, cacheWrite: 3, total: usage.input + 6, cost: 0.1 })),
	};
}

test("the projection carries no ids, paths, or text, and duplicate project basenames stay two rows", () => {
	const sessions = [
		record("sid-a", "/home/u/secret/alpha", [{ at: Date.parse("2026-10-09T10:00:00.000Z"), model: "m1", input: 100 }, { at: Date.parse("2026-10-08T10:00:00.000Z"), model: "m2", input: 50 }]),
		record("sid-b", "/home/u/secret/beta", [{ at: Date.parse("2026-09-01T10:00:00.000Z"), model: "m1", input: 70 }]),
		record("sid-c", "/home/u/other/alpha", [{ at: Date.parse("2024-01-01T10:00:00.000Z"), model: "m3", input: 5 }]),
	];
	const out = projectDesktopUsageStats(sessions, { range: "all", scope: "all", cwd: "/home/u/secret/alpha", now: NOW });
	const json = JSON.stringify(out);
	for (const bad of ["sid-", "secret/", "/home", "\\\\"]) assert.ok(!json.includes(bad), bad);
	assert.deepEqual(out.byProject!.map((project) => project.name).sort(), ["alpha", "alpha", "beta"]);
	assert.equal(out.truncated.byProject, false);
	const project = projectDesktopUsageStats(sessions, { range: "7d", scope: "project", cwd: "/home/u/secret/alpha", now: NOW });
	assert.equal(project.byProject, undefined);
	assert.equal(project.totals.sessions, 1);
	assert.equal(project.totals.messages, 2);
	assert.equal(projectDisplayName("C:\\Users\\x\\proj\\"), "proj");
	assert.equal(projectDisplayName(""), "unknown");
});

test("the projection bounds 51 models, 401 days, and 51 projects and cuts long model ids", () => {
	const sessions: SessionRecord[] = [];
	for (let index = 0; index < 51; index++) sessions.push({ id: `s${index}`, cwd: `/p/proj${index}`, startedAt: NOW - 500 * DAY_MS, messages: [] });
	for (let day = 0; day < 401; day++) {
		sessions[day % 51]!.messages.push({ timestamp: NOW - day * DAY_MS, model: `model-${day % 51}`.padEnd(day === 0 ? 200 : 0, "x"), provider: "p", input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 });
	}
	const out = projectDesktopUsageStats(sessions, { range: "all", scope: "all", cwd: "/p/proj0", now: NOW });
	assert.equal(out.byModel.length, 50);
	assert.equal(out.truncated.byModel, true);
	assert.equal(out.byDay.length, 400);
	assert.equal(out.truncated.byDay, true);
	assert.equal(out.byProject!.length, 50);
	assert.equal(out.truncated.byProject, true);
	assert.ok(out.byModel.every((model) => model.model.length <= 128));
	const days = out.byDay.map((day) => day.day);
	assert.deepEqual([...days].sort(), days);
});

// ---- Providers (gentle-shell-gpui parity, T10) ----

test("get_usage_stats splits usage by provider, largest first, and bounds the provider rows", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "desktop-rpc-stats-providers-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const at = new Date(NOW).toISOString();
	writeSession(root, ALPHA, "multi", [
		{ at, provider: "anthropic", model: "claude-a", input: 300, output: 0, cost: 0.3 },
		{ at, provider: "openai", model: "gpt-a", input: 100, output: 0, cost: 0.2 },
		{ at, provider: "anthropic", model: "claude-a", input: 100, output: 0, cost: 0.1 },
	]);
	const app = harness(t, { roots: [root] });
	await app.invoke("providers", { range: "7d", scope: "project" });
	assert.deepEqual(app.responses()[0].data.byProvider, [
		{ provider: "anthropic", messages: 2, tokens: 400, cost: 0.4, share: 0.8 },
		{ provider: "openai", messages: 1, tokens: 100, cost: 0.2, share: 0.2 },
	]);

	const many = mkdtempSync(join(tmpdir(), "desktop-rpc-stats-many-providers-"));
	t.after(() => rmSync(many, { recursive: true, force: true }));
	writeSession(many, ALPHA, "many", Array.from({ length: 51 }, (_, index) => ({ at, provider: `p-${String(index).padStart(2, "0")}`, model: "m", input: 1, output: 0, cost: 0 })));
	const bounded = harness(t, { roots: [many] });
	await bounded.invoke("many", { range: "7d", scope: "project" });
	const data = bounded.responses()[0].data;
	assert.equal(data.byProvider.length, 50);
	assert.equal(data.truncated.byProvider, true);
	assert.equal(data.totals.totalTokens, 51, "totals stay complete");
});
