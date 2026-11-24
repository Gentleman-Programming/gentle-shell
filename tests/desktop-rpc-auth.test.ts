import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import {
	AUTH_UNAVAILABLE,
	DESKTOP_AUTH_EVENTS,
	DESKTOP_AUTH_LIMITS,
	DESKTOP_AUTH_METHODS,
	INVALID_GET_AUTH_STATUS,
	INVALID_RELOAD_CREDENTIALS,
	RELOAD_FAILED,
	projectAuthStatus,
} from "../lib/desktop-rpc-auth.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";
import { DesktopAuthBridge } from "../lib/desktop-auth-service.ts";

// get_auth_status / reload_credentials: which providers have credentials and of
// which kind, from Pi's model registry, through the real Desktop transport over
// a fake registry. The fake also exposes the secret-returning calls so the
// tests prove they are never used.

const SECRET = "sk-live-SECRET-VALUE";

function fakeRegistry(options: { configured?: Record<string, { source: string; oauth?: boolean; label?: string }>; refresh?: () => Promise<{ aborted: boolean; errors: Map<string, Error> }> } = {}) {
	const configured = { ...(options.configured ?? {}) };
	const calls = { refresh: [] as unknown[], secretReads: 0 };
	const registry = {
		getAll: () => [
			{ provider: "openai-codex", id: "gpt-5.6-terra" },
			{ provider: "anthropic", id: "claude-luna" },
			{ provider: "anthropic", id: "claude-sol" },
			{ provider: "C:\\evil\\path", id: "x" },
		],
		getProviderAuthStatus(provider: string) {
			const entry = configured[provider];
			return entry ? { configured: true, source: entry.source, label: entry.label ?? `~/.secret/${provider}` } : { configured: false };
		},
		getProviderDisplayName: (provider: string) => ({ "openai-codex": "OpenAI Codex", anthropic: "Anthropic" })[provider] ?? provider,
		isUsingOAuth: (model: { provider: string }) => configured[model.provider]?.oauth === true,
		async refresh(refreshOptions: unknown) {
			calls.refresh.push(refreshOptions);
			return options.refresh ? options.refresh() : { aborted: false, errors: new Map() };
		},
		getApiKeyForProvider() { calls.secretReads += 1; return SECRET; },
		getProviderAuth() { calls.secretReads += 1; return { auth: { apiKey: SECRET } }; },
		getApiKeyAndHeaders() { calls.secretReads += 1; return { apiKey: SECRET }; },
		/** Test hook: another process signs in. */
		signIn(provider: string, source: string, oauth = false) { configured[provider] = { source, oauth }; },
	};
	return { registry, calls };
}

function harness(t: test.TestContext, registry: unknown) {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {},
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on() { return () => {}; }, emit() {} },
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	const widgets: string[] = [];
	const ctx = {
		mode: "rpc",
		cwd: "/x",
		modelRegistry: registry,
		sessionManager: { getCwd: () => "/x", getSessionId: () => "s", getEntries: () => [] },
		ui: { setWidget(_key: string, lines: string[]) { widgets.push(...lines); } },
	};
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	return {
		widgets,
		invoke(requestId: string, method: string, params: Record<string, unknown> = {}) {
			return commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }), ctx);
		},
		last() { return JSON.parse(widgets.at(-1)!); },
		async shutdown() { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); },
	};
}

// ---- Capabilities ----

test("the Desktop transport advertises both methods once and no new event", async (t) => {
	assert.deepEqual([...DESKTOP_AUTH_METHODS], ["get_auth_status", "reload_credentials"]);
	assert.deepEqual([...DESKTOP_AUTH_EVENTS], []);
	const app = harness(t, fakeRegistry().registry);
	await app.invoke("cap", "capabilities");
	const data = app.last().data;
	for (const method of DESKTOP_AUTH_METHODS) assert.equal(data.methods.filter((name: string) => name === method).length, 1);
	assert.deepEqual(data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed"]);
});

// ---- get_auth_status ----

test("get_auth_status lists providers with configured, type, and source, and never a credential, label, or secret call", async (t) => {
	const fake = fakeRegistry({ configured: { anthropic: { source: "stored", oauth: true }, "openai-codex": { source: "models_json_command", label: "!op read secret" } } });
	const app = harness(t, fake.registry);
	await app.invoke("auth-1", "get_auth_status");
	assert.deepEqual(app.last(), {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId: "auth-1",
		ok: true,
		data: {
			providers: [
				{ provider: "anthropic", displayName: "Anthropic", configured: true, type: "oauth", source: "stored" },
				{ provider: "openai-codex", displayName: "OpenAI Codex", configured: true, type: "api_key", source: "models_json" },
			],
			truncated: false,
		},
	});
	const raw = app.widgets.at(-1)!;
	for (const leak of [SECRET, "!op read", "~/.secret", "evil"]) assert.equal(raw.includes(leak), false, `no ${leak} on the wire`);
	assert.equal(fake.calls.secretReads, 0, "no secret-returning registry call");
	assert.deepEqual(fake.calls.refresh, [], "a read never refreshes");
});

test("an unconfigured provider has no type and no source", async (t) => {
	const app = harness(t, fakeRegistry().registry);
	await app.invoke("auth-2", "get_auth_status");
	assert.deepEqual(app.last().data.providers[0], { provider: "anthropic", displayName: "Anthropic", configured: false, type: null, source: null });
});

test("get_auth_status rejects params and answers auth_unavailable without a registry", async (t) => {
	const app = harness(t, fakeRegistry().registry);
	await app.invoke("bad-1", "get_auth_status", { providers: ["anthropic"] });
	assert.deepEqual(app.last().error, INVALID_GET_AUTH_STATUS);
	const bare = harness(t, undefined);
	await bare.invoke("none-1", "get_auth_status");
	assert.deepEqual(bare.last().error, AUTH_UNAVAILABLE);
});

// ---- reload_credentials ----

test("reload_credentials refreshes the registry offline and answers the new state", async (t) => {
	const fake = fakeRegistry();
	const app = harness(t, fake.registry);
	await app.invoke("before", "get_auth_status");
	assert.equal(app.last().data.providers.find((row: { provider: string }) => row.provider === "anthropic").configured, false);
	fake.registry.signIn("anthropic", "stored", true);
	fake.registry.refresh = async (options: unknown) => { fake.calls.refresh.push(options); return { aborted: false, errors: new Map([["openai-codex", new Error("GET https://example.invalid/C:/Users/secret failed")]]) }; };
	await app.invoke("reload-1", "reload_credentials");
	const response = app.last();
	assert.equal(response.ok, true);
	assert.deepEqual(fake.calls.refresh, [{ allowNetwork: false }]);
	assert.equal(response.data.reloaded, true);
	assert.equal(response.data.aborted, false);
	assert.deepEqual(response.data.failedProviders, ["openai-codex"]);
	assert.deepEqual(response.data.providers.find((row: { provider: string }) => row.provider === "anthropic"), { provider: "anthropic", displayName: "Anthropic", configured: true, type: "oauth", source: "stored" });
	assert.equal(app.widgets.at(-1)!.includes("example.invalid"), false, "refresh error text never crosses");
	assert.equal(fake.calls.secretReads, 0);
});

test("concurrent reloads share one refresh", async (t) => {
	let release: () => void = () => {};
	const fake = fakeRegistry({ refresh: () => new Promise((resolve) => { release = () => resolve({ aborted: false, errors: new Map() }); }) });
	const app = harness(t, fake.registry);
	const first = app.invoke("r-1", "reload_credentials");
	const second = app.invoke("r-2", "reload_credentials");
	await new Promise((resolve) => setImmediate(resolve));
	release();
	await Promise.all([first, second]);
	assert.equal(fake.calls.refresh.length, 1);
	assert.deepEqual(app.widgets.map((line) => JSON.parse(line).ok), [true, true]);
});

test("a failing refresh answers reload_failed without its message", async (t) => {
	const app = harness(t, fakeRegistry({ refresh: () => Promise.reject(new Error("EACCES C:\\Users\\secret\\auth.json")) }).registry);
	await app.invoke("r-fail", "reload_credentials");
	assert.deepEqual(app.last().error, RELOAD_FAILED);
	assert.equal(app.widgets.at(-1)!.includes("secret"), false);
});

test("reload_credentials rejects params before refreshing", async (t) => {
	const fake = fakeRegistry();
	const app = harness(t, fake.registry);
	await app.invoke("r-bad", "reload_credentials", { force: true });
	assert.deepEqual(app.last().error, INVALID_RELOAD_CREDENTIALS);
	assert.deepEqual(fake.calls.refresh, []);
});

// ---- Bounds ----

test("the projection bounds the provider list and skips ids that are not plain names", () => {
	const models = Array.from({ length: DESKTOP_AUTH_LIMITS.providers + 5 }, (_, index) => ({ provider: `p${String(index).padStart(4, "0")}` }));
	const result = projectAuthStatus({
		getAll: () => [...models, { provider: "../etc" }, { provider: "a b" }],
		getProviderAuthStatus: () => ({ configured: false }),
		isUsingOAuth: () => false,
		refresh: async () => ({ aborted: false, errors: new Map() }),
	});
	assert.equal(result.providers.length, DESKTOP_AUTH_LIMITS.providers);
	assert.equal(result.truncated, true);
	assert.equal(result.providers.some((row) => row.provider === "../etc" || row.provider === "a b"), false);
});

// ---- Independent verification follow-ups (L27) ----

test("a reset during a reload drops the answer", async (t) => {
	let release: () => void = () => {};
	const fake = fakeRegistry({ refresh: () => new Promise((resolve) => { release = () => resolve({ aborted: false, errors: new Map() }); }) });
	const app = harness(t, fake.registry);
	const pending = app.invoke("r-reset", "reload_credentials");
	await new Promise((resolve) => setImmediate(resolve));
	await app.shutdown();
	release();
	await pending;
	assert.equal(app.widgets.some((line) => JSON.parse(line).ok === true), false);
});

test("an environment label never crosses and repeated reads never refresh", async (t) => {
	const fake = fakeRegistry({ configured: { anthropic: { source: "environment", label: "ANTHROPIC_API_KEY" } } });
	const app = harness(t, fake.registry);
	for (let i = 0; i < 3; i++) await app.invoke(`g${i}`, "get_auth_status");
	assert.deepEqual(fake.calls.refresh, []);
	assert.equal(app.widgets.some((line) => line.includes("ANTHROPIC_API_KEY")), false);
	assert.deepEqual(app.last().data.providers[0], { provider: "anthropic", displayName: "Anthropic", configured: true, type: "api_key", source: "environment" });
});

test("an unknown source is null and a throwing display name falls back to the id", () => {
	const result = projectAuthStatus({ getAll: () => [{ provider: "x" }], getProviderAuthStatus: () => ({ configured: true, source: "configured provider" }), getProviderDisplayName: () => { throw new Error("boom"); }, isUsingOAuth: () => false, refresh: async () => ({ aborted: false, errors: new Map() }) });
	assert.deepEqual(result.providers, [{ provider: "x", displayName: "x", configured: true, type: "api_key", source: null }]);
});

// ---- Native review advisories (review-00bf531659b82903) ----

test("a completed reload with an unexpected result shape still answers the reloaded state", async (t) => {
	for (const shape of [undefined, { aborted: true, errors: "not a map" }]) {
		const fake = fakeRegistry({ refresh: async () => shape as never });
		const app = harness(t, fake.registry);
		await app.invoke("odd-shape", "reload_credentials");
		const response = app.last();
		assert.equal(response.ok, true, JSON.stringify(shape));
		assert.equal(response.data.reloaded, true);
		assert.equal(response.data.aborted, shape?.aborted === true);
		assert.deepEqual(response.data.failedProviders, []);
	}
});

test("the bridge itself drops a reload answer when a reset lands mid-refresh", async () => {
	let release: () => void = () => {};
	const fake = fakeRegistry({ refresh: () => new Promise((resolve) => { release = () => resolve({ aborted: false, errors: new Map() }); }) });
	const bridge = new DesktopAuthBridge();
	bridge.attach({ modelRegistry: fake.registry } as never);
	const pending = bridge.handle("reload_credentials", {});
	await new Promise((resolve) => setImmediate(resolve));
	bridge.reset();
	bridge.attach({ modelRegistry: fake.registry } as never);
	release();
	assert.deepEqual(await pending, { ok: false, error: AUTH_UNAVAILABLE });
});

// ---- Follow-ups (review-6198081762928a6d advisories, CodeRabbit on #3475) ----

test("an inherited property name as the auth source never crosses as a source", () => {
	for (const source of ["constructor", "__proto__", "toString"]) {
		const result = projectAuthStatus({ getAll: () => [{ provider: "x" }], getProviderAuthStatus: () => ({ configured: true, source }), isUsingOAuth: () => false, refresh: async () => ({ aborted: false, errors: new Map() }) });
		assert.equal(result.providers[0]!.source, null, source);
	}
});

test("get_auth_status answers auth_unavailable when the registry throws, without its message", async (t) => {
	const fake = fakeRegistry();
	fake.registry.getProviderAuthStatus = () => { throw new Error("C:\Users\secret\auth.json is locked"); };
	const app = harness(t, fake.registry);
	await app.invoke("throws", "get_auth_status");
	assert.deepEqual(app.last().error, AUTH_UNAVAILABLE);
	assert.equal(app.widgets.at(-1)!.includes("secret"), false);
});
