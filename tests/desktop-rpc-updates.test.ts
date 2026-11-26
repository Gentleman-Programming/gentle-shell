import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_UPDATES_EVENTS,
	DESKTOP_UPDATES_METHODS,
	INVALID_UPDATES_PARAMS,
	packageDisplayName,
	parseUpdateStatusParams,
	UPDATES_UNAVAILABLE,
	type ShellChannel,
} from "../lib/desktop-rpc-updates.ts";
import { DesktopUpdatesBridge, resetUpdateStatusCacheForTesting, type UpdateSourcesFactory } from "../lib/desktop-updates-service.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";
import { defaultUpdateSources, packageKey, type ConfiguredPackageFacts, type UpdateSources } from "../lib/update-status.ts";

// get_update_status: a read over Gentle Shell's own channel/version resolution
// and Pi's own package update check. The transport tests inject fake sources
// (counting every lookup that would reach the network); the last tests run the
// real sources against a temporary agent dir, config files, and a fake fetch.

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const CACHED_AT = Date.parse("2026-11-16T08:00:00.000Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";

function pkg(name: string, overrides: Partial<ConfiguredPackageFacts> = {}): ConfiguredPackageFacts {
	return { key: packageKey("user", `npm:${name}`), name, kind: "npm", scope: "user", current: "1.0.0", pinned: false, checkable: true, ...overrides };
}

interface FakeOptions {
	offline?: boolean;
	channel?: ShellChannel;
	shellVersion?: string;
	releaseCache?: { checkedAt: number; latest: string };
	latestShell?: () => Promise<string>;
	latestPi?: (() => Promise<string>) | undefined;
	piVersion?: string;
	packages?: ConfiguredPackageFacts[] | undefined;
	checkPackages?: () => Promise<Set<string>>;
	throwOnChannel?: boolean;
}

function fakeSources(options: FakeOptions = {}) {
	const calls = { network: 0, latestShell: 0, latestPi: 0, checkPackages: 0, factory: 0 };
	const sources: UpdateSources = {
		offline: options.offline ?? false,
		now: () => NOW,
		shellVersion: () => options.shellVersion ?? "4.8.0",
		async shellChannel() {
			if (options.throwOnChannel) throw new Error("C:\\Users\\secret\\channel.json is broken");
			return options.channel ?? "release";
		},
		shellReleaseCache: () => ("releaseCache" in options ? options.releaseCache : undefined),
		latestShell() {
			calls.network += 1;
			calls.latestShell += 1;
			return options.latestShell ? options.latestShell() : Promise.resolve("4.9.0");
		},
		piVersion: () => options.piVersion ?? "1.5.2",
		latestPi: "latestPi" in options && options.latestPi === undefined ? undefined : () => {
			calls.network += 1;
			calls.latestPi += 1;
			return options.latestPi ? options.latestPi() : Promise.resolve("1.6.0");
		},
		packages: () => ("packages" in options ? options.packages : [pkg("alpha"), pkg("beta")]),
		checkPackages() {
			calls.network += 1;
			calls.checkPackages += 1;
			return options.checkPackages ? options.checkPackages() : Promise.resolve(new Set([packageKey("user", "npm:alpha")]));
		},
	};
	const factory: UpdateSourcesFactory = () => {
		calls.factory += 1;
		return sources;
	};
	return { factory, calls };
}

function interactiveHost(t: test.TestContext): void {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
}

/** The real Desktop transport on one fake pi, with injected update sources. */
function harness(t: test.TestContext, factory?: UpdateSourcesFactory, timeoutMs?: number) {
	interactiveHost(t);
	resetUpdateStatusCacheForTesting();
	t.after(resetUpdateStatusCacheForTesting);
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {},
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on() { return () => {}; }, emit() {} },
	} as unknown as ExtensionAPI;
	desktopRpc(pi, { ...(factory ? { updateSources: factory } : {}), ...(timeoutMs === undefined ? {} : { updateTimeoutMs: timeoutMs }) });
	const widgets: string[] = [];
	const ctx = {
		mode: "rpc",
		cwd: "/home/devel/secret/project",
		sessionManager: { getCwd: () => "/home/devel/secret/project", getSessionId: () => "session-a", getEntries: () => [] },
		ui: { setWidget(_key: string, lines: string[]) { widgets.push(...lines); } },
	};
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	return {
		widgets,
		async fire(event: string) { for (const handler of handlers.get(event) ?? []) await handler({}, ctx); },
		invoke(requestId: string, params: Record<string, unknown>, method = "get_update_status") {
			return commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }), ctx);
		},
		responses() { return widgets.map((line) => JSON.parse(line)); },
	};
}

// ---- Capabilities ----

test("the Desktop transport advertises get_update_status once and no new event", (t) => {
	assert.deepEqual([...DESKTOP_UPDATES_METHODS], ["get_update_status"]);
	assert.deepEqual([...DESKTOP_UPDATES_EVENTS], []);
	const app = harness(t, fakeSources().factory);
	void app.invoke("cap-1", {}, "capabilities");
	const response = app.responses()[0];
	assert.ok(response.data.methods.includes("get_update_status"));
	assert.equal(response.data.methods.filter((method: string) => method === "get_update_status").length, 1);
	assert.ok(response.data.methods.includes("get_usage_stats"), "the previous methods stay advertised");
	assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed"]);
});

// ---- Without refresh: cache only, no network ----

test("without refresh it answers from the launcher's recorded release lookup with no network work", async (t) => {
	const fake = fakeSources({ releaseCache: { checkedAt: CACHED_AT, latest: "4.9.0" } });
	const app = harness(t, fake.factory);
	await app.invoke("upd-1", {});
	const responses = app.responses();
	assert.equal(responses.length, 1, "a read publishes its response and no event");
	assert.equal(responses[0].kind, "response");
	assert.equal(responses[0].requestId, "upd-1");
	assert.equal(responses[0].ok, true);
	assert.equal(fake.calls.network, 0);
	assert.deepEqual(responses[0].data, {
		refreshed: false,
		offline: false,
		gentleShell: { current: "4.8.0", latest: "4.9.0", channel: "release", state: "update_available", command: "gentle-shell upgrade", checkedAt: "2026-11-16T08:00:00.000Z" },
		pi: { current: "1.5.2", latest: null, state: "unknown", command: "gentle-shell update", checkedAt: null },
		packages: {
			available: true,
			items: [
				{ name: "alpha", kind: "npm", scope: "user", current: "1.0.0", latest: null, pinned: false, state: "unknown" },
				{ name: "beta", kind: "npm", scope: "user", current: "1.0.0", latest: null, pinned: false, state: "unknown" },
			],
			truncated: false,
			command: "gentle-shell update --extensions",
			checkedAt: null,
		},
	});
});

test("an omitted or false refresh never looks anything up, and with no cache every latest is unknown", async (t) => {
	const fake = fakeSources({ releaseCache: undefined });
	const app = harness(t, fake.factory);
	await app.invoke("upd-1", {});
	await app.invoke("upd-2", { refresh: false });
	const [first, second] = app.responses();
	assert.equal(fake.calls.network, 0);
	for (const response of [first, second]) {
		assert.equal(response.data.gentleShell.latest, null);
		assert.equal(response.data.gentleShell.state, "unknown");
		assert.equal(response.data.gentleShell.checkedAt, null);
		assert.equal(response.data.pi.state, "unknown");
		assert.equal(response.data.refreshed, false);
	}
});

// ---- refresh: true ----

test("refresh runs each lookup once, reports the check time, and later plain reads answer from that result", async (t) => {
	const fake = fakeSources({ releaseCache: { checkedAt: CACHED_AT, latest: "4.7.0" } });
	const app = harness(t, fake.factory);
	await app.invoke("upd-refresh", { refresh: true });
	await app.invoke("upd-cached", {});
	const [refreshed, cached] = app.responses();
	assert.equal(app.responses().length, 2, "no event");
	assert.deepEqual({ latestShell: fake.calls.latestShell, latestPi: fake.calls.latestPi, checkPackages: fake.calls.checkPackages }, { latestShell: 1, latestPi: 1, checkPackages: 1 });
	assert.equal(refreshed.data.refreshed, true);
	assert.deepEqual(refreshed.data.gentleShell, { current: "4.8.0", latest: "4.9.0", channel: "release", state: "update_available", command: "gentle-shell upgrade", checkedAt: "2026-11-17T12:00:00.000Z" });
	assert.deepEqual(refreshed.data.pi, { current: "1.5.2", latest: "1.6.0", state: "update_available", command: "gentle-shell update", checkedAt: "2026-11-17T12:00:00.000Z" });
	assert.deepEqual(refreshed.data.packages.items.map((item: any) => [item.name, item.state]), [["alpha", "update_available"], ["beta", "no_update_reported"]]);
	assert.equal(refreshed.data.packages.checkedAt, "2026-11-17T12:00:00.000Z");
	// The plain read reuses the refresh in memory, over the older launcher record.
	assert.equal(cached.data.refreshed, false);
	assert.deepEqual(cached.data.gentleShell, refreshed.data.gentleShell);
	assert.deepEqual(cached.data.pi, refreshed.data.pi);
	assert.deepEqual(cached.data.packages, refreshed.data.packages);
	assert.equal(fake.calls.network, 3, "the plain read did no network work");
});

test("an exact match is up_to_date only after a successful lookup", async (t) => {
	const fake = fakeSources({ latestShell: async () => "4.8.0", latestPi: async () => "1.5.2", checkPackages: async () => new Set() });
	const app = harness(t, fake.factory);
	await app.invoke("upd-1", { refresh: true });
	const data = app.responses()[0].data;
	assert.equal(data.gentleShell.state, "up_to_date");
	assert.equal(data.pi.state, "up_to_date");
	// Pi's package check cannot tell a failed lookup from no update, so a
	// package it did not list is never called up to date.
	assert.deepEqual(data.packages.items.map((item: any) => item.state), ["no_update_reported", "no_update_reported"]);
});

test("a newer local build or an incomparable version is unknown, never up to date", async (t) => {
	const fake = fakeSources({ shellVersion: "4.10.0", latestShell: async () => "4.9.0", piVersion: "1.5.2-dev", latestPi: async () => "1.5.2" });
	const app = harness(t, fake.factory);
	await app.invoke("upd-1", { refresh: true });
	const data = app.responses()[0].data;
	assert.equal(data.gentleShell.state, "unknown");
	assert.equal(data.pi.state, "unknown");
});

test("failed lookups report unknown with no latest, never up to date, and keep the last good result for plain reads", async (t) => {
	let fail = false;
	const fake = fakeSources({
		latestShell: async () => { if (fail) throw new Error("ENOTFOUND registry.npmjs.org token=npm_secret"); return "4.8.0"; },
		latestPi: async () => { if (fail) throw new Error("pnpm view failed"); return "1.5.2"; },
		checkPackages: async () => { if (fail) throw new Error("npm view failed"); return new Set(); },
	});
	const app = harness(t, fake.factory);
	await app.invoke("good", { refresh: true });
	fail = true;
	await app.invoke("bad", { refresh: true });
	await app.invoke("plain", {});
	const [good, bad, plain] = app.responses();
	assert.equal(good.data.gentleShell.state, "up_to_date");
	assert.equal(bad.ok, true);
	assert.deepEqual(
		{ shell: [bad.data.gentleShell.state, bad.data.gentleShell.latest, bad.data.gentleShell.checkedAt], pi: [bad.data.pi.state, bad.data.pi.latest, bad.data.pi.checkedAt] },
		{ shell: ["unknown", null, null], pi: ["unknown", null, null] },
	);
	assert.deepEqual(bad.data.packages.items.map((item: any) => item.state), ["unknown", "unknown"]);
	assert.equal(bad.data.packages.checkedAt, null);
	assert.doesNotMatch(JSON.stringify(bad), /secret|ENOTFOUND|registry|pnpm view|npm view/);
	// A plain read shows the last successful check with its own time.
	assert.equal(plain.data.gentleShell.state, "up_to_date");
	assert.equal(plain.data.gentleShell.checkedAt, "2026-11-17T12:00:00.000Z");
});

test("a refresh is bounded by its deadline even when a lookup never settles", async (t) => {
	const never = () => new Promise<never>(() => {});
	const fake = fakeSources({ latestShell: never, latestPi: never, checkPackages: never });
	const app = harness(t, fake.factory, 30);
	const started = Date.now();
	await app.invoke("upd-slow", { refresh: true });
	assert.ok(Date.now() - started < 5_000, "the answer came back at the deadline");
	const data = app.responses()[0].data;
	assert.equal(data.refreshed, true);
	assert.equal(data.gentleShell.state, "unknown");
	assert.equal(data.pi.state, "unknown");
	assert.deepEqual(data.packages.items.map((item: any) => item.state), ["unknown", "unknown"]);
});

test("concurrent refreshes share one run of the lookups", async (t) => {
	let release!: (value: string) => void;
	const fake = fakeSources({ latestShell: () => new Promise<string>((resolve) => { release = resolve; }) });
	const app = harness(t, fake.factory);
	const first = app.invoke("upd-a", { refresh: true });
	const second = app.invoke("upd-b", { refresh: true });
	await new Promise((resolve) => setImmediate(resolve));
	release("4.9.0");
	await Promise.all([first, second]);
	assert.equal(fake.calls.latestShell, 1);
	assert.equal(fake.calls.checkPackages, 1);
	const [a, b] = app.responses();
	assert.deepEqual(a.data, b.data);
});

// ---- PI_OFFLINE ----

test("PI_OFFLINE: refresh does no network work and reports nothing as up to date", async (t) => {
	const fake = fakeSources({ offline: true, releaseCache: { checkedAt: CACHED_AT, latest: "4.8.0" } });
	const app = harness(t, fake.factory);
	await app.invoke("offline-refresh", { refresh: true });
	await app.invoke("offline-plain", {});
	const [refresh, plain] = app.responses();
	assert.equal(fake.calls.network, 0);
	assert.equal(refresh.data.offline, true);
	assert.equal(refresh.data.refreshed, false);
	assert.deepEqual([refresh.data.gentleShell.state, refresh.data.gentleShell.latest], ["unknown", null]);
	assert.equal(refresh.data.pi.state, "unknown");
	assert.deepEqual(refresh.data.packages.items.map((item: any) => item.state), ["unknown", "unknown"]);
	// A plain read still answers from the recorded lookup, dated, and flagged offline.
	assert.equal(plain.data.offline, true);
	assert.deepEqual([plain.data.gentleShell.state, plain.data.gentleShell.checkedAt], ["up_to_date", "2026-11-16T08:00:00.000Z"]);
});

// ---- Channels and fixed commands ----

test("the main channel compares the latest main commit with the commit in the running version", async (t) => {
	const current = fakeSources({ channel: "main", shellVersion: `4.8.0-main.${SHA.slice(0, 12)}`, latestShell: async () => SHA, releaseCache: { checkedAt: CACHED_AT, latest: "9.9.9" } });
	const app = harness(t, current.factory);
	await app.invoke("main-plain", {});
	await app.invoke("main-current", { refresh: true });
	const [plain, fresh] = app.responses();
	assert.deepEqual([plain.data.gentleShell.latest, plain.data.gentleShell.state], [null, "unknown"], "the release record never answers for main");
	assert.deepEqual(fresh.data.gentleShell, { current: `4.8.0-main.${SHA.slice(0, 12)}`, latest: SHA.slice(0, 12), channel: "main", state: "up_to_date", command: "gentle-shell upgrade --channel main", checkedAt: "2026-11-17T12:00:00.000Z" });

	const behind = fakeSources({ channel: "main", shellVersion: "4.8.0-main.ffffffffffff", latestShell: async () => SHA });
	const other = harness(t, behind.factory);
	await other.invoke("main-behind", { refresh: true });
	assert.equal(other.responses()[0].data.gentleShell.state, "update_available");
});

test("each install channel carries its fixed command, and an unknown channel looks nothing up", async (t) => {
	const expected: Record<ShellChannel, string | null> = {
		release: "gentle-shell upgrade",
		main: "gentle-shell upgrade --channel main",
		bundled: "gentle-shell upgrade",
		"gentle-ai-managed": "gentle-shell update --extensions",
		unknown: null,
	};
	for (const [channel, command] of Object.entries(expected) as Array<[ShellChannel, string | null]>) {
		const fake = fakeSources({ channel });
		const app = harness(t, fake.factory);
		await app.invoke(`ch-${channel}`, { refresh: true });
		const shell = app.responses()[0].data.gentleShell;
		assert.equal(shell.channel, channel);
		assert.equal(shell.command, command);
		if (channel === "unknown") {
			assert.equal(fake.calls.latestShell, 0);
			assert.deepEqual([shell.state, shell.latest], ["unknown", null]);
		}
	}
});

test("a Pi with no reachable latest-version source stays unknown and is never looked up", async (t) => {
	const fake = fakeSources({ latestPi: undefined });
	const app = harness(t, fake.factory);
	await app.invoke("pi-1", { refresh: true });
	const pi = app.responses()[0].data.pi;
	assert.deepEqual(pi, { current: "1.5.2", latest: null, state: "unknown", command: "gentle-shell update", checkedAt: null });
	assert.equal(fake.calls.latestPi, 0);
});

// ---- Packages ----

test("packages: Pi's skipped kinds, project scope, unknown sources, and the wire carries no source text", async (t) => {
	const packages = [
		pkg("alpha"),
		pkg("pinned", { key: packageKey("user", "npm:pinned@1.2.3"), pinned: true, checkable: false, current: "1.2.3" }),
		pkg("github.com/user/repo", { key: packageKey("project", "git:https://ghp_secret@github.com/user/repo"), kind: "git", scope: "project", current: null, checkable: true }),
		pkg("my-ext", { key: packageKey("user", "C:\\Users\\secret\\my-ext"), kind: "local", current: null, pinned: null, checkable: false }),
		pkg("missing", { key: packageKey("user", "npm:missing"), current: null, checkable: false }),
		pkg("unknown", { key: packageKey("user", "weird"), kind: "unknown", current: null, pinned: null, checkable: false }),
	];
	const fake = fakeSources({ packages, checkPackages: async () => new Set([packageKey("project", "git:https://ghp_secret@github.com/user/repo")]) });
	const app = harness(t, fake.factory);
	await app.invoke("pkg-1", { refresh: true });
	const data = app.responses()[0].data;
	assert.deepEqual(data.packages.items, [
		{ name: "alpha", kind: "npm", scope: "user", current: "1.0.0", latest: null, pinned: false, state: "no_update_reported" },
		{ name: "pinned", kind: "npm", scope: "user", current: "1.2.3", latest: null, pinned: true, state: "skipped" },
		{ name: "github.com/user/repo", kind: "git", scope: "project", current: null, latest: null, pinned: false, state: "update_available" },
		{ name: "my-ext", kind: "local", scope: "user", current: null, latest: null, pinned: null, state: "skipped" },
		{ name: "missing", kind: "npm", scope: "user", current: null, latest: null, pinned: false, state: "skipped" },
		{ name: "unknown", kind: "unknown", scope: "user", current: null, latest: null, pinned: null, state: "unknown" },
	]);
	assert.doesNotMatch(JSON.stringify(data), /ghp_secret|https:|C:\\\\|secret|npm:|key/);
});

test("packages are bounded to 100 rows with truncated, and an unreadable listing is available: false", async (t) => {
	const many = Array.from({ length: 105 }, (_, index) => pkg(`p${String(index).padStart(3, "0")}`, { key: packageKey("user", `npm:p${index}`) }));
	const app = harness(t, fakeSources({ packages: many }).factory);
	await app.invoke("many", {});
	const data = app.responses()[0].data;
	assert.equal(data.packages.items.length, 100);
	assert.equal(data.packages.items[99].name, "p099");
	assert.equal(data.packages.truncated, true);

	const broken = harness(t, fakeSources({ packages: undefined }).factory);
	await broken.invoke("broken", {});
	assert.deepEqual(broken.responses()[0].data.packages, { available: false, items: [], truncated: false, command: "gentle-shell update --extensions", checkedAt: null });
});

test("package names are display names only: no path, URL, or credential", () => {
	assert.equal(packageDisplayName("npm", "@scope/pkg"), "@scope/pkg");
	assert.equal(packageDisplayName("git", "github.com/user/repo"), "github.com/user/repo");
	assert.equal(packageDisplayName("git", "token@github.com/user/repo"), "unknown");
	assert.equal(packageDisplayName("local", "/home/devel/secret/my-ext"), "my-ext");
	assert.equal(packageDisplayName("local", "C:\\Users\\secret\\my-ext\\"), "my-ext");
	assert.equal(packageDisplayName("npm", "https://registry.example/x"), "unknown");
	assert.equal(packageDisplayName("npm", undefined), "unknown");
	assert.equal(packageDisplayName("npm", "x".repeat(200)).length, 128);
});

// ---- Params, absence, and failures ----

test("params: only an optional boolean refresh; anything else is invalid_request before any source work", async (t) => {
	assert.deepEqual(parseUpdateStatusParams({}), { refresh: false });
	assert.deepEqual(parseUpdateStatusParams({ refresh: true }), { refresh: true });
	const fake = fakeSources();
	const app = harness(t, fake.factory);
	const bad = [{ refresh: "yes" }, { refresh: null }, { refresh: 1 }, { force: true }, { refresh: true, extra: 1 }];
	for (const [index, params] of bad.entries()) await app.invoke(`bad-${index}`, params);
	for (const response of app.responses()) {
		assert.equal(response.ok, false);
		assert.deepEqual(response.error, INVALID_UPDATES_PARAMS);
	}
	assert.equal(fake.calls.factory, 0, "no source was even created");
});

test("updates_unavailable without a bound session, on a source failure, and for a read a reset superseded", async (t) => {
	resetUpdateStatusCacheForTesting();
	t.after(resetUpdateStatusCacheForTesting);
	const unbound = new DesktopUpdatesBridge({ sources: fakeSources().factory });
	assert.deepEqual(await unbound.handle("get_update_status", {}), { ok: false, error: UPDATES_UNAVAILABLE });
	assert.equal(await unbound.handle("get_usage_stats", {}), undefined, "other methods fall through");

	const app = harness(t, fakeSources({ throwOnChannel: true }).factory);
	await app.invoke("throws", {});
	const response = app.responses()[0];
	assert.deepEqual([response.ok, response.error], [false, UPDATES_UNAVAILABLE]);
	assert.doesNotMatch(JSON.stringify(response), /secret|channel\.json/);

	let release!: (value: string) => void;
	const slow = fakeSources({ latestShell: () => new Promise<string>((resolve) => { release = resolve; }) });
	const bridge = new DesktopUpdatesBridge({ sources: slow.factory });
	bridge.attach({ cwd: "/x" } as unknown as ExtensionContext);
	const pending = bridge.handle("get_update_status", { refresh: true });
	await new Promise((resolve) => setImmediate(resolve));
	bridge.reset();
	release("4.9.0");
	assert.deepEqual(await pending, { ok: false, error: UPDATES_UNAVAILABLE });
});

test("a session shutdown leaves the transport answering nothing", async (t) => {
	const app = harness(t, fakeSources().factory);
	await app.fire("session_shutdown");
	await app.invoke("after-shutdown", {});
	assert.equal(app.responses().length, 0);
});

// ---- The real sources ----

function realFixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "desktop-rpc-updates-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const installed = (name: string, version: string) => {
		const dir = join(agentDir, "npm", "node_modules", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
	};
	installed("alpha", "1.4.0");
	installed("pinned", "2.0.0");
	mkdirSync(join(root, "local-ext"), { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:alpha", "npm:pinned@2.0.0", join(root, "local-ext")] }));
	const configHome = join(root, "config");
	mkdirSync(configHome, { recursive: true });
	const launcherConfig = join(root, "launcher.json");
	writeFileSync(launcherConfig, JSON.stringify({ startupReleaseCheck: { checkedAt: "2026-11-16T08:00:00.000Z", latest: "4.9.0" } }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	return { root, configHome, launcherConfig, project: join(root, "project") };
}

test("real sources: Pi's listing, the launcher's release record, the channel record, and Pi's VERSION", async (t) => {
	const fixture = realFixture(t);
	const requests: string[] = [];
	const fetch = (async (url: string) => {
		requests.push(url);
		return new Response(JSON.stringify({ version: "4.9.1" }), { status: 200 });
	}) as typeof globalThis.fetch;
	const env = { GENTLE_PI_CONFIG_HOME: fixture.configHome, GENTLE_SHELL_CONFIG: fixture.launcherConfig };
	const sources = defaultUpdateSources({ cwd: fixture.project, env, home: fixture.root, fetch });

	assert.equal(sources.offline, false);
	assert.equal(sources.piVersion(), VERSION);
	assert.match(sources.shellVersion() ?? "", /^\d+\.\d+\.\d+/);
	assert.equal(sources.latestPi, undefined, "outside a bundled install no existing source names the latest Pi");
	assert.equal(await sources.shellChannel(), "release", "no channel record means release");
	assert.deepEqual(sources.shellReleaseCache(), { checkedAt: Date.parse("2026-11-16T08:00:00.000Z"), latest: "4.9.0" });
	const facts = sources.packages()!;
	assert.deepEqual(facts.map(({ key: _key, ...fact }) => fact), [
		{ name: "alpha", kind: "npm", scope: "user", current: "1.4.0", pinned: false, checkable: true },
		{ name: "pinned", kind: "npm", scope: "user", current: "2.0.0", pinned: true, checkable: false },
		{ name: "local-ext", kind: "local", scope: "user", current: null, pinned: null, checkable: false },
	]);
	assert.equal(requests.length, 0, "every read above was local");
	assert.equal(await sources.latestShell("release", new AbortController().signal), "4.9.1");
	assert.deepEqual(requests, ["https://registry.npmjs.org/gentle-pi/latest"]);

	writeFileSync(join(fixture.configHome, "channel.json"), JSON.stringify({ schema: "gentle-shell.channel/v1", channel: "main", shellCommit: SHA, gentleAiCommit: SHA }));
	assert.equal(await sources.shellChannel(), "main");
	writeFileSync(join(fixture.configHome, "channel.json"), "not json");
	assert.equal(await sources.shellChannel(), "unknown", "a malformed channel record is never guessed");
});

test("real sources: PI_OFFLINE makes Pi's own package check report nothing, so the answer stays unknown", async (t) => {
	const fixture = realFixture(t);
	const sources = defaultUpdateSources({ cwd: fixture.project, env: { PI_OFFLINE: "1", GENTLE_SHELL_CONFIG: fixture.launcherConfig, GENTLE_PI_CONFIG_HOME: fixture.configHome }, home: fixture.root, fetch: (() => { throw new Error("no network"); }) as typeof globalThis.fetch });
	assert.equal(sources.offline, true);
	const bridge = new DesktopUpdatesBridge({ sources: () => sources });
	resetUpdateStatusCacheForTesting();
	t.after(resetUpdateStatusCacheForTesting);
	bridge.attach({ cwd: fixture.project } as unknown as ExtensionContext);
	const outcome = await bridge.handle("get_update_status", { refresh: true });
	assert.equal(outcome?.ok, true);
	const data = (outcome as { data: any }).data;
	assert.equal(data.offline, true);
	assert.equal(data.refreshed, false);
	assert.deepEqual(data.packages.items.map((item: any) => [item.name, item.state]), [["alpha", "unknown"], ["pinned", "skipped"], ["local-ext", "skipped"]]);
	assert.doesNotMatch(JSON.stringify(data), new RegExp(fixture.root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&").replace(/\\\\/g, "[\\\\/]+")));
});
