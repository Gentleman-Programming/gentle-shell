import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import desktopRpc, { type DesktopRpcExtensionOptions } from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_LOGIN_EVENTS,
	DESKTOP_LOGIN_METHODS,
	INTERACTIVE_SETUP_REQUIRED,
	INVALID_CHOICE,
	INVALID_SET_API_KEY,
	LOGIN_IN_PROGRESS,
	LOGIN_UNSUPPORTED,
	NO_PENDING_PROMPT,
	UNKNOWN_LOGIN,
	UNKNOWN_PROVIDER,
	promptForEvent,
	redirectPrefixOf,
} from "../lib/desktop-rpc-login.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// Provider sign-in from a client, end to end through the real Desktop transport
// and Pi's real model runtime and credential store (in a temporary agent home),
// over fake providers registered into that runtime: no real provider is ever
// contacted. The fakes play Pi's flows: a method choice, a browser sign-in whose
// redirect goes to a loopback callback, a device code, and API key setups.

const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const KEY = "sk-test-NEVER-ON-THE-WIRE-0123456789";

type Interaction = {
	signal: AbortSignal;
	prompt(prompt: Record<string, unknown>): Promise<string>;
	notify(event: Record<string, unknown>): void;
};

/** Hooks a test uses to play the provider's side of a flow. */
interface Remote {
	/** The browser reached the server's own loopback callback with this code. */
	callback?: (code: string) => void;
	/** The provider approved the device code. */
	approveDevice?: () => void;
	signals: AbortSignal[];
}

function fakeProvider(id: string, auth: Record<string, unknown>) {
	const model = { id: `${id}-model`, name: `${id} model`, api: "openai-completions", provider: id, baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
	return {
		id,
		name: `Fake ${id}`,
		auth,
		getModels: () => [model],
		stream: () => { throw new Error("no model turns in tests"); },
		streamSimple: () => { throw new Error("no model turns in tests"); },
	};
}

const oauthBase = { refresh: async (credential: unknown) => credential, toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }) };

/** Like Anthropic's and Codex's: choose a method, then a browser sign-in racing a paste, or a device code. */
function browserOAuth(remote: Remote) {
	return {
		...oauthBase,
		name: "Fake browser",
		async login(interaction: Interaction) {
			remote.signals.push(interaction.signal);
			const method = await interaction.prompt({ type: "select", message: "Select login method:", options: [{ id: "browser", label: "Browser login" }, { id: "paste", label: "Copy code login" }] });
			const state = "st4te";
			interaction.notify({ type: "auth_url", url: `https://auth.example.test/authorize?client_id=x&state=${state}&redirect_uri=${encodeURIComponent("http://localhost:1455/auth/callback")}`, instructions: "Complete login in your browser." });
			// Pi's waitForCallbackOrManualInput: the server's own callback races a pasted code or
			// redirect URL; a paste cancels the callback, a callback withdraws the paste prompt.
			const manual = new AbortController();
			const { promise: callback, resolve: settleCallback } = Promise.withResolvers<string | undefined>();
			remote.callback = settleCallback;
			let pastedInput: string | undefined;
			let pasteError: unknown;
			interaction.prompt({ type: "manual_code", message: "Paste the authorization code / redirect URL:", placeholder: "http://localhost:1455/auth/callback", signal: manual.signal })
				.then((value) => { pastedInput = value; }, (error) => { pasteError = error; })
				.finally(() => settleCallback(undefined));
			const fromCallback = await callback;
			manual.abort();
			if (fromCallback === undefined && pasteError) throw pasteError;
			let code = fromCallback ?? "";
			if (fromCallback === undefined) {
				const url = new URL(pastedInput ?? "");
				if (url.searchParams.get("state") !== state) throw new Error("State mismatch");
				code = url.searchParams.get("code") ?? "";
			}
			if (!code) throw new Error("Missing authorization code");
			return { type: "oauth", access: `access-${method}-${code}`, refresh: "refresh", expires: Date.now() + 3_600_000 };
		},
	};
}

function deviceOAuth(remote: Remote) {
	return {
		...oauthBase,
		name: "Fake device",
		async login(interaction: Interaction) {
			remote.signals.push(interaction.signal);
			interaction.notify({ type: "device_code", userCode: "WXYZ-1234", verificationUri: "https://device.example.test/activate" });
			interaction.notify({ type: "progress", message: "Waiting for approval..." });
			await new Promise<void>((resolve, reject) => {
				remote.approveDevice = resolve;
				interaction.signal.addEventListener("abort", () => reject(interaction.signal.reason), { once: true });
			});
			return { type: "oauth", access: "device-access", refresh: "refresh", expires: Date.now() + 3_600_000 };
		},
	};
}

function keyAuth(name: string, ask: (interaction: Interaction) => Promise<Record<string, unknown>>) {
	return {
		name,
		login: ask,
		resolve: async ({ credential }: { credential?: { key?: string } }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined),
	};
}

const simpleKey = keyAuth("Fake key", async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "Enter Fake key" }) }));
// Like Cloudflare's: an account id first, then the key.
const accountKey = keyAuth("Fake account key", async (interaction) => {
	const account = await interaction.prompt({ type: "text", message: "Account id", placeholder: "acc_…" });
	const key = await interaction.prompt({ type: "secret", message: "API token" });
	return { type: "api_key", key, env: { FAKE_ACCOUNT: account } };
});

async function setup(t: test.TestContext, options: DesktopRpcExtensionOptions = {}) {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const agentDir = mkdtempSync(join(tmpdir(), "gs-login-"));
	roots.push(agentDir);
	const authPath = join(agentDir, "auth.json");
	const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
	const remote: Remote = { signals: [] };
	for (const provider of [
		fakeProvider("fake-browser", { oauth: browserOAuth(remote), apiKey: simpleKey }),
		fakeProvider("fake-device", { oauth: deviceOAuth(remote) }),
		fakeProvider("fake-key", { apiKey: simpleKey }),
		fakeProvider("fake-account", { apiKey: accountKey }),
		fakeProvider("fake-ambient", { apiKey: { name: "Ambient", resolve: async () => undefined } }),
	]) runtime.registerNativeProvider(provider as never);
	const registry = new ModelRegistry(runtime);
	await registry.refresh({ allowNetwork: false });

	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
		registerShortcut() {},
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on() { return () => {}; }, emit() {} },
	} as unknown as ExtensionAPI;
	desktopRpc(pi, options);
	const widgets: string[] = [];
	const ctx = {
		mode: "rpc",
		cwd: agentDir,
		modelRegistry: registry,
		sessionManager: { getCwd: () => agentDir, getSessionId: () => "s", getEntries: () => [] },
		ui: { setWidget(_key: string, lines: string[]) { widgets.push(...lines); } },
	};
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	const parsed = () => widgets.map((line) => JSON.parse(line));
	const app = {
		widgets,
		authPath,
		registry,
		remote,
		async call(requestId: string, method: string, params: Record<string, unknown> = {}) {
			await commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }), ctx);
			const response = parsed().findLast((line) => line.kind === "response" && line.requestId === requestId);
			assert.ok(response, `a response to ${requestId}`);
			return response;
		},
		events(name?: string) {
			return parsed().filter((line) => line.kind === "event" && (name === undefined || line.event === name));
		},
		/** The next event of a kind after `count` of them were seen. */
		async nextEvent(name: string, count: number) {
			const deadline = Date.now() + 5000;
			while (app.events(name).length <= count) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${name} #${count + 1}; saw ${JSON.stringify(app.events())}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			return app.events(name)[count]!;
		},
		stored() {
			try {
				return JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;
			} catch {
				return {};
			}
		},
		async shutdown() { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); },
	};
	return app;
}

test("the slice advertises its methods and events", () => {
	assert.deepEqual([...DESKTOP_LOGIN_METHODS], ["login_start", "login_complete", "login_cancel", "set_api_key", "remove_credentials"]);
	assert.deepEqual([...DESKTOP_LOGIN_EVENTS], ["login_prompt", "login_finished"]);
});

test("a browser sign-in: a choice, the URL with its loopback callback, the pasted redirect URL, saved and its models available", async (t) => {
	const app = await setup(t);
	const status = await app.call("st-0", "get_auth_status");
	assert.deepEqual(status.data.providers.find((row: { provider: string }) => row.provider === "fake-browser"),
		{ provider: "fake-browser", displayName: "Fake fake-browser", configured: false, type: null, source: null, loginKinds: ["oauth", "api_key"] });
	assert.equal(app.registry.getAvailable().some((model) => model.provider === "fake-browser"), false);

	const started = await app.call("l-1", "login_start", { provider: "fake-browser" });
	assert.equal(started.ok, true);
	const { loginId } = started.data;
	assert.match(loginId, /^login_[0-9a-f]{16}$/);
	const choice = await app.nextEvent("login_prompt", 0);
	// The answer precedes the flow's first event.
	assert.ok(app.widgets.findIndex((line) => line.includes('"requestId":"l-1"')) < app.widgets.findIndex((line) => line.includes('"event":"login_prompt"')));
	assert.deepEqual(choice.data, { loginId, kind: "input", message: "Select login method:", options: [{ id: "browser", label: "Browser login" }, { id: "paste", label: "Copy code login" }] });
	assert.deepEqual((await app.call("l-2", "login_complete", { loginId, value: "fax" })).error, INVALID_CHOICE);
	assert.deepEqual((await app.call("l-3", "login_complete", { loginId, value: "browser" })).data, { accepted: true });

	const open = await app.nextEvent("login_prompt", 1);
	assert.deepEqual(open.data, {
		loginId,
		kind: "open_url",
		url: "https://auth.example.test/authorize?client_id=x&state=st4te&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
		message: "Complete login in your browser.",
		redirectPrefix: "http://localhost:1455/",
	});
	const paste = await app.nextEvent("login_prompt", 2);
	assert.deepEqual(paste.data, { loginId, kind: "input", message: "Paste the authorization code / redirect URL:", placeholder: "http://localhost:1455/auth/callback", redirectPrefix: "http://localhost:1455/" });
	// The client intercepted the browser's redirect and hands the full URL over.
	assert.deepEqual((await app.call("l-4", "login_complete", { loginId, value: "http://localhost:1455/auth/callback?code=c0de&state=st4te" })).data, { accepted: true });
	const finished = await app.nextEvent("login_finished", 0);
	assert.deepEqual(finished.data, { loginId, provider: "fake-browser", ok: true });

	assert.deepEqual(app.stored()["fake-browser"]?.access, "access-browser-c0de");
	if (process.platform !== "win32") assert.equal(statSync(app.authPath).mode & 0o777, 0o600, "Pi's credential file is owner-only");
	// reload_credentials semantics: the models are there without a restart.
	assert.equal(app.registry.getAvailable().some((model) => model.provider === "fake-browser"), true);
	const after = await app.call("st-1", "get_auth_status");
	assert.deepEqual(after.data.providers.find((row: { provider: string }) => row.provider === "fake-browser").type, "oauth");
	assert.deepEqual((await app.call("l-5", "login_complete", { loginId, value: "x" })).error, UNKNOWN_LOGIN, "a finished sign-in is gone");
	assert.equal(app.widgets.some((line) => line.includes("access-browser")), false, "no credential crosses");
});

test("a device code sign-in shows the code and the page, then finishes when the provider approves", async (t) => {
	const app = await setup(t);
	const { data: { loginId } } = await app.call("d-1", "login_start", { provider: "fake-device" });
	assert.deepEqual((await app.nextEvent("login_prompt", 0)).data, { loginId, kind: "device_code", url: "https://device.example.test/activate", userCode: "WXYZ-1234" });
	assert.deepEqual((await app.nextEvent("login_prompt", 1)).data, { loginId, kind: "progress", message: "Waiting for approval..." });
	assert.deepEqual((await app.call("d-2", "login_complete", { loginId, value: "x" })).error, NO_PENDING_PROMPT, "nothing to answer in a device flow");
	app.remote.approveDevice!();
	assert.deepEqual((await app.nextEvent("login_finished", 0)).data, { loginId, provider: "fake-device", ok: true });
	assert.equal(app.stored()["fake-device"]?.type, "oauth");
});

test("the server's own callback wins the race: the paste prompt is withdrawn", async (t) => {
	const app = await setup(t);
	const { data: { loginId } } = await app.call("c-1", "login_start", { provider: "fake-browser" });
	await app.nextEvent("login_prompt", 0);
	await app.call("c-2", "login_complete", { loginId, value: "paste" });
	await app.nextEvent("login_prompt", 2);
	app.remote.callback!("cb");
	assert.deepEqual((await app.nextEvent("login_finished", 0)).data, { loginId, provider: "fake-browser", ok: true });
	assert.equal(app.stored()["fake-browser"]?.access, "access-paste-cb");
});

test("one sign-in per provider; cancel ends it with nothing stored; a bad paste fails it with Pi's message", async (t) => {
	const app = await setup(t);
	const { data: { loginId } } = await app.call("x-1", "login_start", { provider: "fake-browser" });
	assert.deepEqual((await app.call("x-2", "login_start", { provider: "fake-browser" })).error, LOGIN_IN_PROGRESS);
	assert.deepEqual((await app.call("x-3", "set_api_key", { provider: "fake-browser", key: KEY })).error, LOGIN_IN_PROGRESS);
	await app.nextEvent("login_prompt", 0);
	assert.deepEqual((await app.call("x-4", "login_cancel", { loginId })).data, { cancelled: true });
	assert.deepEqual((await app.nextEvent("login_finished", 0)).data, { loginId, provider: "fake-browser", ok: false, error: "Sign-in cancelled" });
	assert.equal(app.remote.signals[0]!.aborted, true, "the provider's flow is aborted");
	assert.deepEqual(app.stored(), {});
	assert.deepEqual((await app.call("x-5", "login_cancel", { loginId })).error, UNKNOWN_LOGIN);

	const again = (await app.call("x-6", "login_start", { provider: "fake-browser" })).data.loginId;
	await app.nextEvent("login_prompt", 1);
	await app.call("x-7", "login_complete", { loginId: again, value: "browser" });
	await app.nextEvent("login_prompt", 3);
	await app.call("x-8", "login_complete", { loginId: again, value: "http://localhost:1455/auth/callback?code=c&state=forged" });
	assert.deepEqual((await app.nextEvent("login_finished", 1)).data, { loginId: again, provider: "fake-browser", ok: false, error: "State mismatch" });
	assert.deepEqual(app.stored(), {});
});

test("a sign-in is cancelled at its time limit, and a session change ends one silently", async (t) => {
	const app = await setup(t, { login: { timeoutMs: 40 } });
	const { data: { loginId } } = await app.call("t-1", "login_start", { provider: "fake-device" });
	assert.deepEqual((await app.nextEvent("login_finished", 0)).data, { loginId, provider: "fake-device", ok: false, error: "Sign-in timed out" });

	const other = await setup(t);
	await other.call("t-2", "login_start", { provider: "fake-device" });
	await other.nextEvent("login_prompt", 0);
	await other.shutdown();
	// The aborted flow settles within a few turns of the event loop; let it.
	for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(other.remote.signals[0]!.aborted, true);
	assert.equal(other.events("login_finished").length, 0, "nothing reaches a replaced session");
});

test("login_start refuses bad params, unknown providers and unsupported kinds", async (t) => {
	const app = await setup(t);
	assert.equal((await app.call("v-1", "login_start", { provider: "../x" })).error.code, "invalid_request");
	assert.equal((await app.call("v-2", "login_start", { provider: "fake-browser", extra: 1 })).error.code, "invalid_request");
	assert.deepEqual((await app.call("v-3", "login_start", { provider: "nope" })).error, UNKNOWN_PROVIDER);
	assert.deepEqual((await app.call("v-4", "login_start", { provider: "fake-key", kind: "oauth" })).error, LOGIN_UNSUPPORTED);
	assert.deepEqual((await app.call("v-5", "login_start", { provider: "fake-ambient" })).error, LOGIN_UNSUPPORTED);
	assert.equal((await app.call("v-6", "login_complete", { loginId: "login_0000000000000000", value: 1 })).error.code, "invalid_request");
});

test("set_api_key saves the key owner-only through Pi, never echoes it, and remove_credentials removes it", async (t) => {
	const app = await setup(t);
	assert.deepEqual((await app.call("k-1", "set_api_key", { provider: "fake-key", key: ` ${KEY}\n` })).data, { saved: true });
	assert.deepEqual(app.stored()["fake-key"], { type: "api_key", key: KEY }, "trimmed and stored by Pi");
	if (process.platform !== "win32") assert.equal(statSync(app.authPath).mode & 0o777, 0o600);
	assert.equal(app.widgets.some((line) => line.includes(KEY)), false, "the key is never on the wire");
	const status = await app.call("k-2", "get_auth_status");
	assert.deepEqual(status.data.providers.find((row: { provider: string }) => row.provider === "fake-key"),
		{ provider: "fake-key", displayName: "Fake fake-key", configured: true, type: "api_key", source: "stored", loginKinds: ["api_key"] });
	assert.equal(app.registry.getAvailable().some((model) => model.provider === "fake-key"), true);

	assert.deepEqual((await app.call("k-3", "remove_credentials", { provider: "fake-key" })).data, { removed: true });
	assert.equal(app.stored()["fake-key"], undefined);
	assert.equal(app.registry.getAvailable().some((model) => model.provider === "fake-key"), false);
	assert.deepEqual((await app.call("k-4", "remove_credentials", { provider: "fake-key" })).data, { removed: false });
});

test("set_api_key refuses bad keys and providers, and a setup that needs more than a key", async (t) => {
	const app = await setup(t);
	for (const key of ["", "a\nb", "x".repeat(4097), 7]) assert.deepEqual((await app.call(`bad-${String(key).length}`, "set_api_key", { provider: "fake-key", key })).error, INVALID_SET_API_KEY);
	assert.deepEqual((await app.call("k-5", "set_api_key", { provider: "nope", key: KEY })).error, UNKNOWN_PROVIDER);
	assert.deepEqual((await app.call("k-6", "set_api_key", { provider: "fake-device", key: KEY })).error, LOGIN_UNSUPPORTED);
	assert.deepEqual((await app.call("k-7", "set_api_key", { provider: "fake-account", key: KEY })).error, INTERACTIVE_SETUP_REQUIRED);
	assert.deepEqual(app.stored(), {});
	assert.equal(app.widgets.some((line) => line.includes(KEY)), false);
});

test("login_start with kind api_key runs a key setup interactively, masking the secret", async (t) => {
	const app = await setup(t);
	const { data: { loginId } } = await app.call("a-1", "login_start", { provider: "fake-account", kind: "api_key" });
	assert.deepEqual((await app.nextEvent("login_prompt", 0)).data, { loginId, kind: "input", message: "Account id", placeholder: "acc_…" });
	await app.call("a-2", "login_complete", { loginId, value: "acc_42" });
	assert.deepEqual((await app.nextEvent("login_prompt", 1)).data, { loginId, kind: "input", message: "API token", secret: true });
	await app.call("a-3", "login_complete", { loginId, value: KEY });
	assert.deepEqual((await app.nextEvent("login_finished", 0)).data, { loginId, provider: "fake-account", ok: true });
	assert.deepEqual(app.stored()["fake-account"], { type: "api_key", key: KEY, env: { FAKE_ACCOUNT: "acc_42" } });
});

test("redirect prefixes are loopback origins only, and display text is bounded", () => {
	assert.equal(redirectPrefixOf("https://x.test/a?redirect_uri=http%3A%2F%2F127.0.0.1%3A53692%2Fcallback"), "http://127.0.0.1:53692/");
	assert.equal(redirectPrefixOf("https://x.test/a?callback_url=http%3A%2F%2Flocalhost%3A3000%2Fcb"), "http://localhost:3000/");
	assert.equal(redirectPrefixOf("https://x.test/a?redirect_uri=https%3A%2F%2Fconsole.example.test%2Fcode"), undefined, "a provider page is not a loopback callback");
	assert.equal(redirectPrefixOf("https://x.test/a?redirect_uri=http%3A%2F%2Fevil.test%3A1455%2F"), undefined);
	assert.equal(promptForEvent("login_0000000000000000", { type: "auth_url", url: "javascript:alert(1)" }), undefined);
	const long = promptForEvent("login_0000000000000000", { type: "progress", message: `a\u0007b${"x".repeat(5000)}` });
	assert.equal(long?.message?.length, 1024);
	assert.equal(long?.message?.startsWith("a b"), true);
});
