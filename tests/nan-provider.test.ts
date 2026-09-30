import assert from "node:assert/strict";
import test from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import nanProviderExtension from "../extensions/nan-provider.ts";
import { createNanProviderConfig, NAN_PROVIDER_BASE_URL, NAN_PROVIDER_ID } from "../lib/nan-provider.ts";

// Pi 0.99 made ProviderModelConfig a chat/image/classifier union; the fields these tests
// assert (reasoning, contextWindow, maxTokens) live on the chat member the nan provider
// emits, and that member is not re-exported from the package root, so it is extracted.
type ChatModel = Extract<ProviderModelConfig, { reasoning: boolean }>;

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
		async publish() {
			return true;
		},
	};
}

test("extension registers NaN with Pi's OpenAI-compatible and native API-key configuration", () => {
	let registeredName: string | undefined;
	let registeredConfig: ProviderConfig | undefined;
	nanProviderExtension({
		registerProvider(name: string, config: ProviderConfig) {
			registeredName = name;
			registeredConfig = config;
		},
	} as never);

	assert.equal(registeredName, NAN_PROVIDER_ID);
	assert.equal(registeredConfig?.name, "NaN");
	assert.equal(registeredConfig?.baseUrl, NAN_PROVIDER_BASE_URL);
	assert.equal(registeredConfig?.api, "openai-completions");
	assert.equal(registeredConfig?.apiKey, "$NAN_API_KEY");
	assert.equal(registeredConfig?.authHeader, true);
	assert.equal(typeof registeredConfig?.refreshModels, "function");
});

test("offline baseline is one documented chat model with a configured output cap", () => {
	const model = createNanProviderConfig().models?.[0] as ChatModel | undefined;
	assert.equal(model?.id, "deepseek-v4-flash");
	assert.equal(model?.api, "openai-completions");
	assert.equal(model?.reasoning, true);
	assert.deepEqual(model?.input, ["text", "image"]);
	assert.equal(model?.contextWindow, 1_000_000);
	assert.equal(createNanProviderConfig().models?.length, 1);
	assert.equal(model?.maxTokens, 8_192);
	assert.deepEqual(model?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("live discovery uses the key-scoped endpoint and replaces the fallback with listed models", async () => {
	let request: { url: string; init?: RequestInit } | undefined;
	const config = createNanProviderConfig({
		fetchImpl: async (input, init) => {
			request = { url: String(input), init };
			return jsonResponse({ data: [{ id: " glm5.3 " }, { id: "glm5.3" }, { id: "unknown-chat" }, { id: "embedding" }, { id: "image" }, { id: "speech" }, { id: "rerank" }] });
		},
	});
	const fallbackId = config.models?.[0]?.id;
	assert.ok(fallbackId);

	const models = await config.refreshModels?.(refreshContext({ type: "api_key", key: "test-secret" }));

	assert.equal(request?.url, `${NAN_PROVIDER_BASE_URL}/models`);
	assert.equal(request?.init?.method, "GET");
	assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer test-secret");
	assert.equal(request?.init?.redirect, "error");
	assert.deepEqual(models?.map((model) => model.id), ["glm5.3"]);
	assert.ok(!models?.some((model) => model.id === fallbackId));

	const known = models?.[0] as ChatModel | undefined;
	assert.equal(known?.api, "openai-completions");
	assert.equal(known?.reasoning, true);
	assert.deepEqual(known?.input, ["text"]);
	assert.equal(known?.contextWindow, 1_000_000);
	assert.equal(known?.maxTokens, 8_192);
	assert.deepEqual(known?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("known chat models retain documented capabilities without advertising audio", async () => {
	const expected = [
		["glm5.3", 1_000_000, ["text"], 8_192],
		["deepseek-v4-flash", 1_000_000, ["text", "image"], 8_192],
		["glm5.3-flash", 1_000_000, ["text", "image"], 8_192],
		["qwen3.8-flash", 1_048_576, ["text", "image"], 131_000],
		["mimo-v2.6-flash", 1_000_000, ["text", "image"], 8_192],
		["gemma4", 262_000, ["text", "image"], 8_192],
		["qwen3.6", 262_000, ["text", "image"], 8_192],
	] as const;
	const config = createNanProviderConfig({
		fetchImpl: async () => jsonResponse({ data: expected.map(([id]) => ({ id })) }),
	});
	const models = await config.refreshModels?.(refreshContext({ type: "api_key", key: "test-key" }));
	assert.equal(models?.length, expected.length);
	for (const [index, [id, contextWindow, input, maxTokens]] of expected.entries()) {
		const model = models?.[index] as ChatModel | undefined;
		assert.equal(model?.id, id);
		assert.equal(model?.reasoning, true);
		assert.equal(model?.contextWindow, contextWindow);
		assert.deepEqual(model?.input, input);
		assert.equal(model?.maxTokens, maxTokens);
	}
});

test("a successful list containing only unknown or non-chat IDs stays empty", async () => {
	const config = createNanProviderConfig({
		fetchImpl: async () => jsonResponse({ data: ["unknown", "embedding", "image", "speech", "rerank"].map((id) => ({ id })) }),
	});
	const context = refreshContext({ type: "api_key", key: "test-key" });
	assert.deepEqual(await config.refreshModels?.(context), []);
	assert.deepEqual(await config.refreshModels?.({ ...context, allowNetwork: false }), []);
});

test("a successful empty key-scoped catalog does not restore offline fallback models", async () => {
	const config = createNanProviderConfig({ fetchImpl: async () => jsonResponse({ data: [] }) });
	assert.ok(config.models && config.models.length > 0);

	const models = await config.refreshModels?.(refreshContext({ type: "api_key", key: "test-secret" }));

	assert.deepEqual(models, []);
});

test("failed or malformed discovery preserves the conservative baseline or last successful catalog", async () => {
	const failingFetches: Array<typeof fetch> = [
		async () => jsonResponse({ error: "unavailable" }, 503),
		async () => new Response("not-json", { status: 200 }),
		async () => jsonResponse({ models: [{ id: "not-the-supported-shape" }] }),
		async () => {
			throw new Error("network unavailable");
		},
	];

	for (const fetchImpl of failingFetches) {
		const config = createNanProviderConfig({ fetchImpl });
		const baseline = config.models;
		const afterFailure = await config.refreshModels?.(refreshContext({ type: "api_key", key: "test-secret" }));
		assert.deepEqual(afterFailure, baseline);
	}

	let fail = false;
	const config = createNanProviderConfig({
		fetchImpl: async () => fail ? jsonResponse({ error: "unavailable" }, 503) : jsonResponse({ data: [{ id: "glm5.3" }] }),
	});
	const live = await config.refreshModels?.(refreshContext({ type: "api_key", key: "test-secret" }));
	fail = true;
	assert.deepEqual(await config.refreshModels?.(refreshContext({ type: "api_key", key: "test-secret" })), live);
});

test("offline model refresh does not make a network request", async () => {
	let calls = 0;
	const config = createNanProviderConfig({
		fetchImpl: async () => {
			calls++;
			return jsonResponse({ data: [] });
		},
	});
	const context = refreshContext({ type: "api_key", key: "test-secret" });
	const models = await config.refreshModels?.({ ...context, allowNetwork: false });
	assert.equal(calls, 0);
	assert.deepEqual(models, config.models);
});

test("credential changes discard previous live models before failed, offline, or cancelled discovery", async () => {
	for (const mode of ["failure", "offline", "cancelled", "removed"] as const) {
		let calls = 0;
		const config = createNanProviderConfig({
			fetchImpl: async () => ++calls === 1
				? jsonResponse({ data: [{ id: "glm5.3" }] })
				: jsonResponse({ error: "denied" }, 401),
		});
		await config.refreshModels?.(refreshContext({ type: "api_key", key: "first-key" }));
		const controller = new AbortController();
		if (mode === "cancelled") controller.abort();
		const context = refreshContext(mode === "removed" ? undefined : { type: "api_key", key: "second-key" });
		const models = await config.refreshModels?.({
			...context,
			allowNetwork: mode !== "offline",
			signal: controller.signal,
		});
		assert.deepEqual(models, config.models, mode);
		assert.equal(calls, mode === "offline" || mode === "cancelled" ? 1 : 2);
	}
});

test("same-key failure retains an authoritative empty catalog", async () => {
	let calls = 0;
	const config = createNanProviderConfig({
		fetchImpl: async () => ++calls === 1 ? jsonResponse({ data: [] }) : jsonResponse({}, 503),
	});
	const context = refreshContext({ type: "api_key", key: "empty-key" });
	assert.deepEqual(await config.refreshModels?.(context), []);
	assert.deepEqual(await config.refreshModels?.(context), []);
});

test("cancelling discovery aborts fetch and does not restore the previous key's catalog", async () => {
	let calls = 0;
	let requestSignal: AbortSignal | undefined;
	let started!: () => void;
	const pending = new Promise<void>((resolve) => { started = resolve; });
	const config = createNanProviderConfig({
		fetchImpl: async (_input, init) => {
			if (++calls === 1) return jsonResponse({ data: [{ id: "glm5.3" }] });
			requestSignal = init?.signal as AbortSignal;
			return new Promise<Response>((_resolve, reject) => {
				requestSignal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				started();
			});
		},
	});
	await config.refreshModels?.(refreshContext({ type: "api_key", key: "first-key" }));
	const controller = new AbortController();
	const result = config.refreshModels?.({
		...refreshContext({ type: "api_key", key: "second-key" }), signal: controller.signal,
	});
	await pending;
	controller.abort();
	assert.deepEqual(await result, config.models);
	assert.equal(requestSignal?.aborted, true);
});

test("an old in-flight discovery cannot overwrite a changed credential's catalog", async () => {
	let resolveOld!: (response: Response) => void;
	const config = createNanProviderConfig({
		fetchImpl: async (_input, init) => {
			if (new Headers(init?.headers).get("authorization") === "Bearer first-key") {
				return new Promise<Response>((resolve) => { resolveOld = resolve; });
			}
			return jsonResponse({ data: [] });
		},
	});
	const old = config.refreshModels?.(refreshContext({ type: "api_key", key: "first-key" }));
	assert.deepEqual(await config.refreshModels?.(refreshContext({ type: "api_key", key: "second-key" })), []);
	resolveOld(jsonResponse({ data: [{ id: "glm5.3" }] }));
	assert.deepEqual(await old, []);
	assert.deepEqual(await config.refreshModels?.({
		...refreshContext({ type: "api_key", key: "second-key" }), allowNetwork: false,
	}), []);
});
