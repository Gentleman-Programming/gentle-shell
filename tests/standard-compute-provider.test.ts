import assert from "node:assert/strict";
import test from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { clampThinkingLevel, createModels, getSupportedThinkingLevels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Provider } from "@earendil-works/pi-ai";
import { createStandardComputeProviderConfig, STANDARDCOMPUTE_BASE_URL, STANDARDCOMPUTE_MODEL_ID, STANDARDCOMPUTE_PROVIDER_ID } from "../lib/standard-compute-provider.ts";
import standardComputeProviderExtension from "../extensions/standard-compute-provider.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function refreshContext(credential?: RefreshModelsContext["credential"]): RefreshModelsContext {
	return {
		credential,
		stored: undefined,
		allowNetwork: true,
		signal: new AbortController().signal,
		async publish(publication) {
			publication.update?.();
			return true;
		},
	};
}

const ALL_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof ALL_EFFORTS)[number];

type StandardComputeCatalogModel = ReturnType<ReturnType<typeof createStandardComputeProviderConfig>["getModels"]>[number];

function createStandardComputeProviderConfigForCatalog(options: Parameters<typeof createStandardComputeProviderConfig>[0] = {}) {
	const provider = createStandardComputeProviderConfig(options);
	return {
		...provider,
		models: provider.getModels(),
		async refreshModels(context: RefreshModelsContext) {
			await provider.refreshModels!(context);
			return provider.getModels();
		},
	};
}

async function chatPayload(model: StandardComputeCatalogModel, reasoning?: Effort) {
	let body: Record<string, unknown> | undefined;
	const result = await completeSimple(model, { messages: [{ role: "user", content: "offline probe", timestamp: 0 }] }, {
		apiKey: "synthetic-key", reasoning: reasoning === "off" ? undefined : reasoning,
		fetch: async (input, init) => {
			assert.equal(String(input), `${STANDARDCOMPUTE_BASE_URL}/chat/completions`);
			assert.equal(init.method, "POST");
			body = JSON.parse(String(init?.body));
			return new Response('data: {"id":"offline","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	assert.equal(result.stopReason, "stop");
	assert.ok(body);
	return body;
}

test("the Standard Compute constants name the smart routing entry", () => {
	assert.equal(STANDARDCOMPUTE_PROVIDER_ID, "standardcompute");
	assert.equal(STANDARDCOMPUTE_BASE_URL, "https://api.stdcmpt.com/v1");
	assert.equal(STANDARDCOMPUTE_MODEL_ID, "standardcompute");
});

test("extension registers Standard Compute with Pi's OpenAI-compatible provider", () => {
	let registeredConfig: Provider | undefined;
	standardComputeProviderExtension({
		registerProvider(provider: Provider) { registeredConfig = provider; },
	} as never);
	assert.equal(registeredConfig?.id, "standardcompute");
	assert.equal(registeredConfig?.name, "Standard Compute");
	assert.equal(registeredConfig?.baseUrl, "https://api.stdcmpt.com/v1");
	assert.equal(registeredConfig?.getModels()[0]?.api, "openai-completions");
	assert.equal(typeof registeredConfig?.auth.apiKey?.login, "function");
	assert.equal(typeof registeredConfig?.auth.apiKey?.resolve, "function");
	assert.equal(typeof registeredConfig?.streamSimple, "function");
	assert.equal(typeof registeredConfig?.refreshModels, "function");
});

test("the offline fallback catalog exposes the smart routing model", () => {
	const models = createStandardComputeProviderConfig().getModels();
	assert.equal(models.length, 1);
	const model = models[0];
	assert.ok(model);
	assert.equal(model.id, "standardcompute");
	assert.equal(model.name, "StandardCompute");
	assert.equal(model.provider, "standardcompute");
	assert.equal(model.baseUrl, "https://api.stdcmpt.com/v1");
	assert.equal(model.api, "openai-completions");
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.contextWindow, 1_000_000);
	assert.equal(model.maxTokens, 1_000_000);
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("native login awaits input, trims keys, and rejects whitespace or cancellation", async () => {
	const provider = createStandardComputeProviderConfig();
	await assert.rejects(async () => provider.auth.apiKey!.login!({
		signal: new AbortController().signal,
		prompt: async () => "",
		notify() {},
	}), /non-empty/);
	const login = provider.auth.apiKey!.login!;
	const controller = new AbortController();
	let submit!: (key: string) => void;
	let prompted = false;
	let finished = false;
	const pending = login({ signal: controller.signal, notify() {}, prompt: async (prompt) => {
		prompted = true;
		assert.equal(prompt.type, "secret");
		assert.equal(prompt.signal, controller.signal);
		return new Promise<string>((resolve) => { submit = resolve; });
	} }).then((result) => { finished = true; return result; });
	assert.equal(prompted, true);
	assert.equal(finished, false);
	submit("  synthetic-key \t");
	assert.deepEqual(await pending, { type: "api_key", key: "synthetic-key" });
	await assert.rejects(login({ signal: controller.signal, notify() {}, prompt: async () => " \t " }), /non-empty/);
	await assert.rejects(login({ signal: controller.signal, notify() {}, prompt: async () => { throw new Error("cancelled"); } }), /cancelled/);
	await assert.rejects(login({ signal: controller.signal, notify() {}, prompt: async () => {
		controller.abort(); return "synthetic-key";
	} }), { name: "AbortError" });
});

test("native auth resolves stored keys before environment and rejects empty configuration", async () => {
	const resolve = createStandardComputeProviderConfig().auth.apiKey!.resolve;
	let envCalls = 0;
	const input = {
		ctx: { async env(name: string) { envCalls++; assert.equal(name, "STANDARDCOMPUTE_API_KEY"); return " env-key "; }, async fileExists() { return false; } },
		signal: new AbortController().signal,
	};
	assert.deepEqual(await resolve({ ...input, credential: { type: "api_key", key: " stored-key " } }), { auth: { apiKey: "stored-key" }, source: "API key" });
	assert.equal(envCalls, 0);
	assert.deepEqual(await resolve({ ...input, credential: { type: "api_key", key: " " } }), { auth: { apiKey: "env-key" }, source: "STANDARDCOMPUTE_API_KEY" });
	assert.equal(await resolve({ ...input, ctx: { ...input.ctx, env: async () => " " } }), undefined);
});

test("Models login persists saved keys and falls back to the environment", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials, authContext: {
		env: async () => "env-key", fileExists: async () => false,
	} });
	models.setProvider(createStandardComputeProviderConfig());
	const interaction = { prompt: async () => "", notify() {} };
	await assert.rejects(async () => models.login("standardcompute", "api_key", interaction), /non-empty/);
	assert.equal(await credentials.read("standardcompute"), undefined);
	await models.login("standardcompute", "api_key", { ...interaction, prompt: async () => " saved-key " });
	assert.deepEqual((await models.getAuth("standardcompute"))?.auth, { apiKey: "saved-key" });
	await assert.rejects(models.login("standardcompute", "api_key", interaction), /non-empty/);
	assert.deepEqual(await credentials.read("standardcompute"), { type: "api_key", key: "saved-key" });
	await models.logout("standardcompute");
	assert.deepEqual((await models.getAuth("standardcompute"))?.auth, { apiKey: "env-key" });
});

test("offline model refresh keeps the fallback catalog without network", async () => {
	let calls = 0;
	const config = createStandardComputeProviderConfigForCatalog({
		fetchImpl: async () => {
			calls++;
			return jsonResponse({ data: [{ id: "standardcompute" }] });
		},
	});
	const models = await config.refreshModels(refreshContext({ type: "api_key", key: "test-secret" }));
	assert.deepEqual(models.map((model) => model.id), ["standardcompute"]);
	assert.deepEqual(config.getModels().map((model) => model.id), ["standardcompute"]);
	const context = refreshContext({ type: "api_key", key: "test-secret" });
	assert.deepEqual((await config.refreshModels({ ...context, allowNetwork: false })).map((model) => model.id), ["standardcompute"]);
	assert.equal(calls, 1);
});

test("live discovery publishes the smart routing model and listed unmanaged models", async () => {
	let request: { url: string; init?: RequestInit } | undefined;
	const config = createStandardComputeProviderConfigForCatalog({
		fetchImpl: async (input, init) => {
			request = { url: String(input), init };
			return jsonResponse({ data: [{ id: "standardcompute" }, { id: "anthropic/claude-sonnet-5.5" }] });
		},
	});
	const models = await config.refreshModels(refreshContext({ type: "api_key", key: "test-secret" }));
	assert.deepEqual(models.map((model) => model.id), ["standardcompute", "anthropic/claude-sonnet-5.5"]);
	assert.equal(request?.url, `${STANDARDCOMPUTE_BASE_URL}/models`);
	assert.equal(request?.init?.method, "GET");
	assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer test-secret");
	assert.equal(request?.init?.redirect, "error");
	const smart = models.find((model) => model.id === "standardcompute");
	assert.ok(smart);
	assert.equal(smart.api, "openai-completions");
	assert.equal(smart.reasoning, true);
	const unmanaged = models.find((model) => model.id === "anthropic/claude-sonnet-5.5");
	assert.ok(unmanaged);
	assert.equal(unmanaged.contextWindow, 1_000_000);
});

test("failed discovery preserves the fallback catalog", async () => {
	const config = createStandardComputeProviderConfigForCatalog({
		fetchImpl: async () => jsonResponse({ error: "unavailable" }, 503),
	});
	const baseline = config.getModels();
	const models = await config.refreshModels(refreshContext({ type: "api_key", key: "test-secret" }));
	assert.deepEqual(models, baseline);
	assert.deepEqual(config.getModels(), baseline);
});

test("a successful empty catalog is authoritative", async () => {
	const config = createStandardComputeProviderConfigForCatalog({ fetchImpl: async () => jsonResponse({ data: [] }) });
	const models = await config.refreshModels(refreshContext({ type: "api_key", key: "empty-key" }));
	assert.deepEqual(models, []);
	assert.deepEqual(config.getModels(), []);
});

test("credential changes discard the previous live catalog", async () => {
	const config = createStandardComputeProviderConfigForCatalog({
		fetchImpl: async () => jsonResponse({ data: [{ id: "standardcompute" }] }),
	});
	await config.refreshModels(refreshContext({ type: "api_key", key: "first-key" }));
	const models = await config.refreshModels(refreshContext({ type: "api_key", key: "second-key" }));
	assert.deepEqual(models.map((model) => model.id), ["standardcompute"]);
});

test("smart routing exposes Pi thinking levels and serializes reasoning efforts", async () => {
	const model = createStandardComputeProviderConfig().getModels()[0];
	assert.ok(model);
	assert.deepEqual(getSupportedThinkingLevels(model), [...ALL_EFFORTS]);
	assert.equal(clampThinkingLevel(model, "off"), "off");
	assert.equal(clampThinkingLevel(model, "max"), "max");

	for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		const body = await chatPayload(model, effort);
		assert.equal(body.model, "standardcompute");
		assert.equal(body.reasoning_effort, effort);
		assert.equal(Object.hasOwn(body, "thinking"), false);
		assert.equal(body.max_completion_tokens, 995_900);
		assert.equal(Object.hasOwn(body, "max_tokens"), false);
	}
	const offBody = await chatPayload(model, "off");
	assert.equal(offBody.reasoning_effort, undefined);
});

test("smart routing streams a chat completion through the OpenAI-compatible endpoint", async () => {
	const model = createStandardComputeProviderConfig().getModels()[0];
	assert.ok(model);
	const result = await completeSimple(model, { messages: [{ role: "user", content: "offline probe", timestamp: 0 }] }, {
		apiKey: "synthetic-key", reasoning: "minimal",
		fetch: async (input, init) => {
			assert.equal(String(input), `${STANDARDCOMPUTE_BASE_URL}/chat/completions`);
			assert.equal(init.method, "POST");
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, "standardcompute");
			assert.equal(body.reasoning_effort, "minimal");
			assert.equal(body.max_completion_tokens, 995_900);
			assert.equal(Object.hasOwn(body, "max_tokens"), false);
			return new Response('data: {"id":"offline","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	assert.equal(result.stopReason, "stop");
});
