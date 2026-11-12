import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import gentleShell from "../extensions/gentle-shell.ts";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET, DesktopRpcRouter, type DesktopRpcDomain } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_USAGE_EVENT,
	DESKTOP_USAGE_SERVICE_CHANNEL,
	DESKTOP_USAGE_SERVICE_SCHEMA,
	DESKTOP_USAGE_STALE_MS,
	desktopUsageStatus,
	parseUsageProviderParam,
	projectUsageEntry,
	type DesktopUsageEntry,
	type DesktopUsageOwnerEntry,
	type DesktopUsageOwnerRead,
	type DesktopUsageRecordedSnapshot,
	type DesktopUsageService,
} from "../lib/desktop-rpc-usage.ts";
import { DesktopUsageBridge, discoverDesktopUsageService } from "../lib/desktop-usage-service.ts";
import { parseAnthropicHeaders, parseCodexUsage, parseNanQuota, type ProviderUsage } from "../lib/shell-usage.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

const NOW = 1_788_600_000_000;

// ---- Fixtures ----

function codexSnapshot(fetchedAt = NOW, plan = "pro"): ProviderUsage {
	return parseCodexUsage(
		{ plan_type: plan, rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: 1_788_777_491 } } },
		fetchedAt,
	);
}

function nanSnapshot(fetchedAt = NOW): ProviderUsage {
	return parseNanQuota({
		periodEnd: "2026-10-01T00:00:00.000Z",
		models: [{ model: "glm5.3", cap: 3_000_000_000, fullCap: 3_000_000_000, tokensUsed: 820_000_000 }],
	}, fetchedAt);
}

function anthropicSnapshot(fetchedAt = NOW): ProviderUsage {
	const usage = parseAnthropicHeaders(
		{ "anthropic-ratelimit-unified-5h-utilization": "0.25", "anthropic-ratelimit-unified-7d-utilization": "0.9" },
		fetchedAt,
	);
	assert.ok(usage);
	return usage;
}

function ownerEntry(overrides: Partial<DesktopUsageOwnerEntry> = {}): DesktopUsageOwnerEntry {
	return { provider: "openai-codex", supported: true, refreshable: true, failed: false, ...overrides };
}

function makeService(
	state: () => DesktopUsageOwnerRead,
	options: { refresh?: (provider?: string) => Promise<DesktopUsageOwnerRead> } = {},
) {
	const observers = new Set<(recorded: DesktopUsageRecordedSnapshot) => void>();
	const refreshCalls: Array<string | undefined> = [];
	const readCalls: Array<string | undefined> = [];
	const service: DesktopUsageService = {
		schema: DESKTOP_USAGE_SERVICE_SCHEMA,
		read(provider?: string) {
			readCalls.push(provider);
			const read = state();
			if (provider === undefined) return { providers: read.providers };
			// Mirror the owner: a filtered read still answers for the named provider,
			// reporting an unsupported entry when the owner knows nothing about it.
			const entry = read.providers.find((candidate) => candidate.provider === provider)
				?? { provider, supported: false, refreshable: false, failed: false };
			return { providers: [entry] };
		},
		async refresh(provider?: string) {
			refreshCalls.push(provider);
			if (options.refresh) return options.refresh(provider);
			return service.read(provider);
		},
		observe(callback) {
			observers.add(callback);
			return () => observers.delete(callback);
		},
		dispose() {
			observers.clear();
		},
	};
	return {
		service,
		observers,
		refreshCalls,
		readCalls,
		notify(recorded: DesktopUsageRecordedSnapshot) {
			for (const callback of [...observers]) callback(recorded);
		},
	};
}

function makeBridge(
	service: DesktopUsageService,
	options: { now?: () => number; staleAfterMs?: number } = {},
) {
	const bridge = new DesktopUsageBridge({} as ExtensionAPI, {
		discover: async () => service,
		now: options.now ?? (() => NOW),
		staleAfterMs: options.staleAfterMs,
	});
	bridge.attach({} as ExtensionContext);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	bridge.wire((event, data) => events.push({ event, data }));
	return { bridge, events };
}

// ---- Pure contract: status, projection, params ----

test("desktopUsageStatus maps owner facts to the five truthful statuses", () => {
	const base = { supported: true, refreshable: true, failed: false, now: NOW, staleAfterMs: DESKTOP_USAGE_STALE_MS };
	assert.equal(desktopUsageStatus({ ...base, fetchedAt: NOW - 60_000 }), "ok");
	assert.equal(desktopUsageStatus({ ...base, fetchedAt: NOW - DESKTOP_USAGE_STALE_MS - 1 }), "stale");
	assert.equal(desktopUsageStatus({ ...base, fetchedAt: undefined }), "pending");
	assert.equal(desktopUsageStatus({ ...base, fetchedAt: undefined, failed: true }), "failed");
	assert.equal(desktopUsageStatus({ ...base, fetchedAt: undefined, supported: false }), "unavailable");
	// A retained snapshot keeps ok/stale even after a failed refresh; only the age speaks.
	assert.equal(desktopUsageStatus({ ...base, fetchedAt: NOW - 60_000, failed: true }), "ok");
	// Anthropic is header-driven: its snapshot never ages into stale.
	assert.equal(
		desktopUsageStatus({ ...base, refreshable: false, fetchedAt: NOW - DESKTOP_USAGE_STALE_MS - 1 }),
		"ok",
	);
});

test("projectUsageEntry keeps only safe fields and the plan only when already public", () => {
	const codex = projectUsageEntry("openai-codex", "ok", codexSnapshot());
	assert.equal(codex.provider, "openai-codex");
	assert.equal(codex.status, "ok");
	assert.equal(codex.plan, "pro");
	assert.equal(codex.fetchedAt, NOW);
	assert.deepEqual(codex.limits?.[0].windows, [
		{ label: "week", usedPercent: 40, windowSeconds: 604_800, resetAt: 1_788_777_491_000 },
	]);
	assert.equal("scope" in (codex.limits?.[0] ?? {}), false, "the internal scope marker never crosses the wire");

	const anthropic = projectUsageEntry("anthropic", "ok", anthropicSnapshot());
	assert.equal("plan" in anthropic, false, "an absent plan is not invented");
	assert.deepEqual(
		anthropic.limits?.[0].windows.map((window) => `${window.label}:${window.usedPercent}`),
		["5h:25", "week:90"],
	);

	const nan = projectUsageEntry("nan", "ok", nanSnapshot());
	assert.equal(nan.limits?.[0].windows[0].used, 820_000_000, "NaN's raw allowance numbers are safe and kept");
	assert.equal(JSON.stringify(codex).includes("example.com"), false);
});

test("parseUsageProviderParam accepts empty or exactly one provider and rejects the rest", () => {
	assert.deepEqual(parseUsageProviderParam({}), { provider: undefined });
	assert.deepEqual(parseUsageProviderParam({ provider: "nan" }), { provider: "nan" });
	for (const params of [
		{ provider: 7 },
		{ provider: "" },
		{ unexpected: true },
		{ provider: "nan", extra: true },
		{ provider: "nan", provider2: "codex" },
	]) {
		const parsed = parseUsageProviderParam(params);
		assert.equal("error" in parsed, true, JSON.stringify(params));
		assert.deepEqual((parsed as { error: unknown }).error, { code: "invalid_request", message: "Invalid subscription usage parameters" });
	}
});

// ---- Bridge: reads ----

test("get_subscription_usage projects supported providers with truthful statuses", async () => {
	const read: DesktopUsageOwnerRead = {
		providers: [
			ownerEntry({ provider: "openai-codex", snapshot: codexSnapshot() }),
			ownerEntry({ provider: "nan", snapshot: nanSnapshot(NOW - DESKTOP_USAGE_STALE_MS - 1) }),
			ownerEntry({ provider: "anthropic", supported: true, refreshable: false, failed: false }),
			ownerEntry({ provider: "acme-cloud", snapshot: undefined, failed: true }),
			ownerEntry({ provider: "mystery", supported: false, refreshable: false, failed: false }),
		],
	};
	const { bridge, events } = makeBridge(makeService(() => read).service);
	const outcome = await bridge.handle("get_subscription_usage", {});
	assert.equal(outcome.ok, true);
	const providers = (outcome.data as { providers: DesktopUsageEntry[] }).providers;
	assert.deepEqual(
		providers.map((entry) => [entry.provider, entry.status]),
		[
			["openai-codex", "ok"],
			["nan", "stale"],
			["anthropic", "pending"],
			["acme-cloud", "failed"],
			["mystery", "unavailable"],
		],
	);
	assert.equal("refresh" in providers[0], false, "a read never reports a refresh disposition");
	assert.equal("plan" in (providers.find((entry) => entry.provider === "anthropic") ?? {}), false);
	assert.equal(events.length, 0, "a read never emits an event");
});

test("a provider filter narrows the read to one provider and unknown providers answer unavailable", async () => {
	const read: DesktopUsageOwnerRead = {
		providers: [
			ownerEntry({ provider: "openai-codex", snapshot: codexSnapshot() }),
			ownerEntry({ provider: "nan", snapshot: nanSnapshot() }),
		],
	};
	const { bridge } = makeBridge(makeService(() => read).service);

	const filtered = await bridge.handle("get_subscription_usage", { provider: "nan" });
	const filteredProviders = (filtered as { ok: true; data: { providers: DesktopUsageEntry[] } }).data.providers;
	assert.equal(filteredProviders.length, 1);
	assert.equal(filteredProviders[0].provider, "nan");
	assert.equal(filteredProviders[0].status, "ok");

	const unknown = await bridge.handle("get_subscription_usage", { provider: "mystery" });
	const unknownProviders = (unknown as { ok: true; data: { providers: DesktopUsageEntry[] } }).data.providers;
	assert.deepEqual(unknownProviders, [{ provider: "mystery", status: "unavailable" }]);
});

test("invalid params are typed rejections without events", async () => {
	const { bridge, events } = makeBridge(makeService(() => ({ providers: [] })).service);
	for (const params of [{ provider: 7 }, { provider: "" }, { unexpected: true }]) {
		const outcome = await bridge.handle("get_subscription_usage", params);
		assert.equal(outcome.ok, false);
		assert.deepEqual(outcome.error, { code: "invalid_request", message: "Invalid subscription usage parameters" });
	}
	assert.equal(events.length, 0);
});

test("no owner answers usage_unavailable without inventing data", async () => {
	const bridge = new DesktopUsageBridge({} as ExtensionAPI, { discover: async () => undefined, now: () => NOW });
	bridge.attach({} as ExtensionContext);
	const outcome = await bridge.handle("get_subscription_usage", {});
	assert.equal(outcome.ok, false);
	assert.deepEqual(outcome.error, { code: "usage_unavailable", message: "Usage owner unavailable for this session" });
});

// ---- Bridge: refresh ----

test("refresh_subscription_usage delegates to the owner and returns response before one rate_limit event", async () => {
	let snapshot: ProviderUsage | undefined;
	const { service, refreshCalls } = makeService(
		() => ({ providers: [ownerEntry({ provider: "openai-codex", snapshot })] }),
		{
			refresh: async (provider) => {
				snapshot = codexSnapshot(NOW + 1);
				return { providers: [ownerEntry({ provider: "openai-codex", snapshot })] };
			},
		},
	);
	const { bridge, events } = makeBridge(service);

	const outcome = await bridge.handle("refresh_subscription_usage", { provider: "openai-codex" });
	assert.equal(outcome.ok, true);
	assert.deepEqual(refreshCalls, ["openai-codex"], "the provider filter is forwarded to the owner refresh");
	const providers = (outcome.data as { providers: DesktopUsageEntry[] }).providers;
	assert.equal(providers[0].status, "ok");
	assert.equal(providers[0].fetchedAt, NOW + 1);
	assert.equal(outcome.event?.name, DESKTOP_USAGE_EVENT);
	assert.deepEqual(outcome.event?.data, {
		source: "refresh",
		snapshots: [{ provider: "openai-codex", status: "ok", fetchedAt: NOW + 1, plan: "pro", limits: providers[0].limits }],
	});
	assert.equal(events.length, 0, "the refresh event rides the outcome, not the async emit path");
});

test("the router publishes the refresh response before its single rate_limit event", async () => {
	// A fresh owner whose every refresh advances the snapshot, so the outcome
	// always carries exactly one changed snapshot.
	let snapshot: ProviderUsage | undefined;
	let stamp = NOW;
	const { service } = makeService(
		() => ({ providers: [ownerEntry({ provider: "openai-codex", snapshot })] }),
		{
			refresh: async () => {
				stamp += 1;
				snapshot = codexSnapshot(stamp);
				return { providers: [ownerEntry({ provider: "openai-codex", snapshot })] };
			},
		},
	);
	const bridge = new DesktopUsageBridge({} as ExtensionAPI, { discover: async () => service, now: () => NOW });
	bridge.attach({} as ExtensionContext);
	const domain: DesktopRpcDomain = (method, params) => bridge.handle(method, params as Record<string, unknown>);
	const lines: string[] = [];
	const router = new DesktopRpcRouter(
		["capabilities", "get_snapshot", "get_subscription_usage", "refresh_subscription_usage"],
		[DESKTOP_USAGE_EVENT],
		undefined,
		domain,
	);
	router.start((line) => lines.push(line));
	await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "refresh-1", method: "refresh_subscription_usage", params: { provider: "openai-codex" } }));
	assert.deepEqual(lines.map((line) => JSON.parse(line).kind), ["response", "event"]);
	const event = JSON.parse(lines[1]);
	assert.equal(event.seq, 1);
	assert.equal(event.event, DESKTOP_USAGE_EVENT);
	assert.deepEqual(event.data, { source: "refresh", snapshots: [{ provider: "openai-codex", status: "ok", fetchedAt: NOW + 1, plan: "pro", limits: JSON.parse(lines[0]).data.providers[0].limits }] });
});

test("an Anthropic refresh is a typed no-op with no event", async () => {
	const read: DesktopUsageOwnerRead = {
		providers: [ownerEntry({ provider: "anthropic", supported: true, refreshable: false, failed: false })],
	};
	const { service, refreshCalls } = makeService(() => read);
	const { bridge } = makeBridge(service);

	const outcome = await bridge.handle("refresh_subscription_usage", { provider: "anthropic" });
	assert.equal(outcome.ok, true);
	const providers = (outcome.data as { providers: DesktopUsageEntry[] }).providers;
	assert.deepEqual(providers, [{ provider: "anthropic", status: "pending", refresh: "unsupported" }]);
	assert.equal(outcome.event, undefined, "a no-op refresh never emits a duplicate event");
	assert.deepEqual(refreshCalls, ["anthropic"], "the owner is still asked, and its own refreshUsage skips the fetch");
});

test("refreshing an unknown provider answers unavailable without a refresh marker or event", async () => {
	const { service, refreshCalls } = makeService(() => ({ providers: [] }));
	const { bridge } = makeBridge(service);
	const outcome = await bridge.handle("refresh_subscription_usage", { provider: "mystery" });
	assert.equal(outcome.ok, true);
	const providers = (outcome.data as { providers: DesktopUsageEntry[] }).providers;
	assert.deepEqual(providers, [{ provider: "mystery", status: "unavailable" }]);
	assert.equal(outcome.event, undefined);
	assert.deepEqual(refreshCalls, ["mystery"], "the owner still answers the named provider");
});

test("a failed refresh emits no event and reports the truthful failed status", async () => {
	const read: DesktopUsageOwnerRead = {
		providers: [ownerEntry({ provider: "openai-codex", failed: true })],
	};
	const { bridge } = makeBridge(makeService(() => read).service);
	const outcome = await bridge.handle("refresh_subscription_usage", { provider: "openai-codex" });
	assert.equal(outcome.ok, true);
	const providers = (outcome.data as { providers: DesktopUsageEntry[] }).providers;
	assert.equal(providers[0].status, "failed");
	assert.equal(outcome.event, undefined);
});

test("a throwing refresh never leaks raw owner errors", async () => {
	const { service } = makeService(() => ({ providers: [ownerEntry()] }), {
		refresh: async () => { throw new Error("secret-token-xyz /etc/passwd https://chatgpt.com/wham"); },
	});
	const { bridge } = makeBridge(service);
	const outcome = await bridge.handle("refresh_subscription_usage", { provider: "openai-codex" });
	assert.equal(outcome.ok, true);
	const text = JSON.stringify(outcome);
	assert.equal(text.includes("secret-token-xyz"), false);
	assert.equal(text.includes("/etc/passwd"), false);
	assert.equal(text.includes("chatgpt.com"), false);
	assert.equal(outcome.event, undefined);
});

test("a scope-filtered refresh that never fetched reports refresh out_of_scope with no event", async () => {
	const snapshot = codexSnapshot(NOW);
	const { service } = makeService(() => ({ providers: [ownerEntry({ provider: "openai-codex", snapshot })] }), {
		refresh: async () => ({
			providers: [
				{ provider: "openai-codex", supported: true, refreshable: true, failed: false, outOfScope: true, snapshot },
			],
		}),
	});
	const { bridge } = makeBridge(service);
	const outcome = await bridge.handle("refresh_subscription_usage", { provider: "openai-codex" });
	assert.equal(outcome.ok, true);
	const providers = (outcome.data as { providers: DesktopUsageEntry[] }).providers;
	assert.equal(providers[0].provider, "openai-codex");
	assert.equal(providers[0].status, "ok", "the current snapshot is preserved");
	assert.equal(providers[0].fetchedAt, NOW);
	assert.equal(providers[0].refresh, "out_of_scope");
	assert.equal(outcome.event, undefined, "an out-of-scope no-op emits nothing");
});

test("changedSnapshots compares content, not only fetchedAt", async () => {
	const make = (usedPercent: number, fetchedAt: number) => parseCodexUsage(
		{ plan_type: "pro", rate_limit: { primary_window: { used_percent: usedPercent, limit_window_seconds: 604_800, reset_at: 1_788_777_491 } } },
		fetchedAt,
	);

	// A changed payload in the same millisecond emits exactly one event.
	let sameMs = make(40, NOW);
	const { service: sameMsService } = makeService(
		() => ({ providers: [ownerEntry({ provider: "openai-codex", snapshot: sameMs })] }),
		{ refresh: async () => { sameMs = make(65, NOW); return { providers: [ownerEntry({ provider: "openai-codex", snapshot: sameMs })] }; } },
	);
	const changed = await makeBridge(sameMsService).bridge.handle("refresh_subscription_usage", { provider: "openai-codex" });
	assert.equal(changed.ok, true);
	const changedEvent = (changed as { ok: true; event?: { name: string; data: Record<string, unknown> } }).event;
	assert.equal(changedEvent?.name, DESKTOP_USAGE_EVENT);
	assert.equal((changedEvent?.data as { source: string }).source, "refresh");
	assert.equal((changedEvent?.data as { snapshots: unknown[] }).snapshots.length, 1);

	// Byte-equivalent data at a later timestamp stays a no-op.
	let equivalent = make(40, NOW);
	const { service: equivalentService } = makeService(
		() => ({ providers: [ownerEntry({ provider: "openai-codex", snapshot: equivalent })] }),
		{ refresh: async () => { equivalent = make(40, NOW + 1000); return { providers: [ownerEntry({ provider: "openai-codex", snapshot: equivalent })] }; } },
	);
	const noop = await makeBridge(equivalentService).bridge.handle("refresh_subscription_usage", { provider: "openai-codex" });
	assert.equal(noop.ok, true);
	assert.equal(noop.event, undefined, "identical content is never re-emitted");
});

// ---- Bridge: header-driven events and stale sessions ----

test("header-driven snapshots become rate_limit events with source response through the router", async () => {
	const { service, notify } = makeService(() => ({ providers: [] }));
	const { bridge, events } = makeBridge(service);
	// Discovery subscribes the observer before any header arrives.
	await bridge.handle("get_subscription_usage", {});

	notify({ provider: "anthropic", usage: anthropicSnapshot() });
	assert.equal(events.length, 1);
	assert.equal(events[0].event, DESKTOP_USAGE_EVENT);
	assert.deepEqual(events[0].data, {
		source: "response",
		snapshots: [
			{
				provider: "anthropic",
				status: "ok",
				fetchedAt: NOW,
				limits: [{ name: "claude", windows: [{ label: "5h", usedPercent: 25, windowSeconds: 18_000, resetAt: null }, { label: "week", usedPercent: 90, windowSeconds: 604_800, resetAt: null }], limitReached: false }],
			},
		],
	});

	// A malformed recording (wrong provider, or raw header text) is dropped.
	notify({ provider: "anthropic", usage: { provider: "openai-codex", plan: undefined, fetchedAt: NOW, limits: [] } });
	assert.equal(events.length, 1, "a recording naming another provider is never projected");
});

test("session reset disconnects observers and drops stale async outcomes", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const { service, notify } = makeService(
		() => ({ providers: [ownerEntry()] }),
		{ refresh: async () => { await gate; return { providers: [ownerEntry({ snapshot: codexSnapshot() })] }; } },
	);
	const bridge = new DesktopUsageBridge({} as ExtensionAPI, { discover: async () => service, now: () => NOW });
	bridge.attach({} as ExtensionContext);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	bridge.wire((event, data) => events.push({ event, data }));

	// Subscribe the observer, then reset before the header arrives.
	await bridge.handle("get_subscription_usage", {});
	bridge.reset();
	notify({ provider: "anthropic", usage: anthropicSnapshot() });
	assert.equal(events.length, 0, "a disposed session never delivers a header event");

	// A refresh that resolves after the session was replaced is dropped.
	bridge.attach({} as ExtensionContext);
	bridge.wire((event, data) => events.push({ event, data }));
	const pending = bridge.handle("refresh_subscription_usage", { provider: "openai-codex" });
	bridge.reset();
	release!();
	const outcome = await pending;
	assert.equal(outcome.ok, false, "a stale refresh resolves to a safe typed answer");
	assert.deepEqual(outcome.error, { code: "usage_unavailable", message: "Usage owner unavailable for this session" });
	assert.equal(events.length, 0);
});

test("a late discovery after reset is disposed and never cached for the next session", async () => {
	let releaseOld: (service: DesktopUsageService) => void = () => {};
	const oldGate = new Promise<DesktopUsageService>((resolve) => { releaseOld = resolve; });
	const disposed: string[] = [];
	const { service: oldService } = makeService(() => ({ providers: [] }));
	const originalDispose = oldService.dispose.bind(oldService);
	oldService.dispose = () => { disposed.push("old"); originalDispose(); };
	const { service: newService } = makeService(() => ({
		providers: [ownerEntry({ provider: "nan", snapshot: nanSnapshot() })],
	}));

	let discoverCount = 0;
	const bridge = new DesktopUsageBridge({} as ExtensionAPI, {
		discover: () => { discoverCount += 1; return discoverCount === 1 ? oldGate : Promise.resolve(newService); },
		now: () => NOW,
	});
	bridge.attach({} as ExtensionContext);
	const first = bridge.handle("get_subscription_usage", {});
	bridge.reset();
	releaseOld(oldService);
	const firstOutcome = await first;
	assert.equal(firstOutcome.ok, false, "the superseded discovery answers unavailable");
	assert.deepEqual(disposed, ["old"], "the late adapter is disposed, never cached");

	// The next session must discover its own owner, not reuse the stale one.
	bridge.attach({} as ExtensionContext);
	bridge.wire(() => {});
	const second = await bridge.handle("get_subscription_usage", {});
	assert.equal(second.ok, true);
	assert.equal(discoverCount, 2);
	const providers = (second as { ok: true; data: { providers: DesktopUsageEntry[] } }).data.providers;
	assert.equal(providers[0].provider, "nan");
});

// ---- Discovery: versioned, defensive adapter ----

test("discoverDesktopUsageService accepts the versioned adapter and ignores malformed responders", async () => {
	const listeners = new Map<string, (value: unknown) => void>();
	const pi = {
		events: {
			on(name: string, handler: (value: unknown) => void) { listeners.set(name, handler); return () => listeners.delete(name); },
			emit(name: string, value: unknown) { listeners.get(name)?.(value); },
		},
	} as unknown as ExtensionAPI;
	const ctx = {} as ExtensionContext;

	// A well-formed responder resolves.
	listeners.set(DESKTOP_USAGE_SERVICE_CHANNEL, (payload) => {
		const request = payload as { respond(service: unknown): void };
		request.respond({
			schema: DESKTOP_USAGE_SERVICE_SCHEMA,
			read: () => ({ providers: [] }),
			refresh: async () => ({ providers: [] }),
			observe: () => () => {},
			dispose: () => {},
		});
	});
	const service = await discoverDesktopUsageService(pi, ctx);
	assert.equal(service?.schema, DESKTOP_USAGE_SERVICE_SCHEMA);

	// A wrong-schema or missing-method responder is ignored and the discovery times out closed.
	listeners.set(DESKTOP_USAGE_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({ schema: "gentle-pi.desktop-usage-service/v0", read: () => ({ providers: [] }) });
	});
	assert.equal(await discoverDesktopUsageService(pi, ctx), undefined);
});

// ---- Real owner service: Claude 5h/7d windows from response headers ----

function gentleShellHarness(t: test.TestContext) {
	const home = mkdtempSync(join(tmpdir(), "desktop-usage-owner-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const listeners = new Map<string, (value: unknown) => void>();
	const fetchCalls: unknown[] = [];
	const pi = {
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: {
			on(name: string, handler: (value: unknown) => void) { listeners.set(name, handler); return () => { if (listeners.get(name) === handler) listeners.delete(name); }; },
			emit(name: string, value: unknown) { listeners.get(name)?.(value); },
		},
		registerCommand(_name: string, _command: any) {},
		registerShortcut(_key: string, _registration: any) {},
		registerTool(_tool: any) {},
		registerMessageRenderer(_type: string, _renderer: any) {},
		getThinkingLevel() { return "medium"; },
		getCommands() { return []; },
		sendUserMessage(_content: string, _options?: unknown) {},
		appendEntry(_customType: string, _data: unknown) {},
		async exec(_command: string, _args: string[]) { return { stdout: "", stderr: "", code: 0, killed: false }; },
	} as unknown as ExtensionAPI;
	gentleShell(pi, { GENTLE_PI_CONFIG_HOME: home, GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, {
		fetch: (async (...args: unknown[]) => { fetchCalls.push(args); throw new Error("network forbidden in test"); }) as unknown as typeof fetch,
		now: () => NOW,
		resolveWorktree: () => ({ root: "/repo", commonDir: "/repo/.git" }),
		gitRunner: () => async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		rootExists: () => true,
	});
	const ctx = {
		mode: "rpc",
		hasUI: true,
		cwd: "/repo",
		model: { id: "claude-opus-5-5", provider: "anthropic", reasoning: true, contextWindow: 272_000 },
		sessionManager: { getSessionId: () => "session-1", getEntries: () => [], getCwd: () => "/repo", getSessionName: () => "s" },
		modelRegistry: { isUsingOAuth: () => true, getApiKeyForProvider: async () => undefined },
		getContextUsage: () => ({ tokens: 0, contextWindow: 272_000, percent: 0 }),
		ui: {
			setWidget: () => {},
			setStatus: () => {},
			notify: () => {},
			getAllThemes: () => [],
			setFooter: () => {},
			setEditorComponent: () => {},
		},
	} as unknown as ExtensionContext;
	return { pi, handlers, ctx, fetchCalls };
}

test("the real owner service delivers Claude 5h/7d windows from response headers as structured rate_limit snapshots", async (t) => {
	const { pi, handlers, ctx } = gentleShellHarness(t);
	const service = await discoverDesktopUsageService(pi, ctx);
	assert.ok(service, "the owner seam must answer in-process");

	const recorded: DesktopUsageRecordedSnapshot[] = [];
	const unsubscribe = service.observe((snapshot) => recorded.push(snapshot));
	for (const handler of handlers.get("after_provider_response") ?? []) {
		handler(
			{ status: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.25", "anthropic-ratelimit-unified-7d-utilization": "0.9" } },
			ctx,
		);
	}
	assert.equal(recorded.length, 1, "one header response records exactly one snapshot");
	assert.equal(recorded[0].provider, "anthropic");
	assert.deepEqual(
		recorded[0].usage.limits[0].windows.map((window) => `${window.label}:${window.usedPercent}`),
		["5h:25", "week:90"],
		"the structured windows arrive already parsed, never as header text",
	);
	assert.equal(recorded[0].usage.provider, "anthropic");

	unsubscribe();
	service.dispose();
	// A second response after unsubscribe/dispose reaches no consumer.
	for (const handler of handlers.get("after_provider_response") ?? []) {
		handler({ status: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.5" } }, ctx);
	}
	assert.equal(recorded.length, 1);
});

test("the real owner answers an out-of-scope refresh without attempting a fetch", async (t) => {
	const { pi, ctx, fetchCalls } = gentleShellHarness(t);
	const service = await discoverDesktopUsageService(pi, ctx);
	assert.ok(service);
	// The session model is anthropic, so openai-codex is outside the scope.
	const read = await service.refresh("openai-codex");
	assert.equal(read.providers.length, 1);
	assert.equal(read.providers[0].provider, "openai-codex");
	assert.equal(read.providers[0].outOfScope, true);
	assert.equal(read.providers[0].snapshot, undefined);
	assert.equal(fetchCalls.length, 0, "an out-of-scope refresh never reaches the fetcher");
	service.dispose();
});

// ---- Transport: capabilities advertise only the wired usage surface ----

test("the Desktop transport advertises the usage methods and rate_limit event", async (t) => {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: any) => void>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { events.set(name, handler); },
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	const widgets: Array<{ key: string; lines: string[] }> = [];
	const ctx = { mode: "rpc", ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } } };
	events.get("session_start")?.({}, ctx);
	await commands.get("gentle:desktop")!.handler(
		JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "cap-1", method: "capabilities", params: {} }),
		ctx,
	);
	assert.equal(widgets[0].key, DESKTOP_RPC_WIDGET);
	const response = JSON.parse(widgets[0].lines[0]);
	assert.deepEqual(response.data.methods, [
		"capabilities",
		"get_snapshot",
		"get_config",
		"set_config",
		"get_permission_mode",
		"set_permission_mode",
		"get_subscription_usage",
		"refresh_subscription_usage",
		"get_design_canvas",
		"list_jobs",
		"cancel_job",
		"list_subagents",
		"cancel_subagent",
	]);
	assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "agents_update"]);
});

test("get_subscription_usage answers usage_unavailable through the transport without an owner extension", async (t) => {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: any) => void>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { events.set(name, handler); },
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	const widgets: Array<{ key: string; lines: string[] }> = [];
	const ctx = { mode: "rpc", ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } } };
	events.get("session_start")?.({}, ctx);
	await commands.get("gentle:desktop")!.handler(
		JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "usage-1", method: "get_subscription_usage", params: {} }),
		ctx,
	);
	const response = JSON.parse(widgets[0].lines[0]);
	assert.equal(response.ok, false);
	assert.deepEqual(response.error, { code: "usage_unavailable", message: "Usage owner unavailable for this session" });
});
