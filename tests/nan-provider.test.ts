import assert from "node:assert/strict";
import test from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { clampThinkingLevel, createModels, getSupportedThinkingLevels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import nanProviderExtension from "../extensions/nan-provider.ts";
import { createNanProviderConfig as createNativeProvider, isNanAdaptiveReasoningModel, NAN_ADAPTIVE_REASONING_MODEL_IDS, NAN_PROVIDER_BASE_URL, NAN_PROVIDER_ID } from "../lib/nan-provider.ts";

// Keep catalog assertions independent of the native refresh's void return contract.
function createNanProviderConfig(options: Parameters<typeof createNativeProvider>[0] = {}) {
	const provider = createNativeProvider(options);
	return {
		...provider,
		models: provider.getModels(),
		async refreshModels(context: RefreshModelsContext) {
			await provider.refreshModels!(context);
			return provider.getModels();
		},
	};
}

const DOCUMENTED_CHAT_IDS = [
	"glm5.3", "deepseek-v4-flash", "glm5.3-flash", "qwen3.8-flash",
	"mimo-v2.6-flash", "gemma4", "qwen3.6",
	"kimi-k3.1-pro", "qwen3.8-max", "deepseek-v4-pro", "hy4",
];

// Pi 1.5 derives the compat and thinking-map types through pi-schema's Static, which
// collapses all-optional objects to `unknown` under this repository's `strict: false`.
// Both Pi 1.4 and 1.5 still read `compat.maxTokensField` at run time; these views name
// the fields the tests read and write.
type CatalogModel = ReturnType<ReturnType<typeof createNativeProvider>["getModels"]>[number];
const capCompat = (model: CatalogModel) => model.compat as { maxTokensField?: "max_tokens" | "max_completion_tokens" } | undefined;
const levelMap = (model: CatalogModel) => model.thinkingLevelMap as Record<string, string | null> | undefined;

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

test("native login rejects an explicitly submitted empty key", async () => {
	const provider = createNativeProvider();
	await assert.rejects(async () => provider.auth.apiKey!.login!({
		signal: new AbortController().signal,
		prompt: async () => "",
		notify() {},
	}), /non-empty/);
});

test("extension registers NaN with Pi's OpenAI-compatible and native API-key configuration", () => {
	let registeredConfig: Provider | undefined;
	nanProviderExtension({
		registerProvider(provider: Provider) { registeredConfig = provider; },
	} as never);
	assert.equal(registeredConfig?.id, NAN_PROVIDER_ID);
	assert.equal(registeredConfig?.name, "NaN");
	assert.equal(registeredConfig?.baseUrl, NAN_PROVIDER_BASE_URL);
	assert.equal(registeredConfig?.getModels()[0]?.api, "openai-completions");
	assert.equal(typeof registeredConfig?.auth.apiKey?.login, "function");
	assert.equal(typeof registeredConfig?.streamSimple, "function");
	assert.equal(typeof registeredConfig?.refreshModels, "function");
});

test("native login awaits input, trims keys, and rejects whitespace or cancellation", async () => {
	const login = createNativeProvider().auth.apiKey!.login!;
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
	let calls = 0;
	await assert.rejects(login({ signal: controller.signal, notify() {}, prompt: async () => { calls++; return "key"; } }), { name: "AbortError" });
	assert.equal(calls, 0);
});

test("native Models login never persists blank credentials and uses saved auth for requests", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials, authContext: {
		env: async () => "env-key", fileExists: async () => false,
	} });
	models.setProvider(createNativeProvider());
	const interaction = { prompt: async () => "", notify() {} };
	await assert.rejects(models.login("nan", "api_key", interaction), /non-empty/);
	assert.equal(await credentials.read("nan"), undefined);
	await models.login("nan", "api_key", { ...interaction, prompt: async () => " saved-key " });
	assert.deepEqual((await models.getAuth("nan"))?.auth, { apiKey: "saved-key" });
	await assert.rejects(models.login("nan", "api_key", interaction), /non-empty/);
	assert.deepEqual(await credentials.read("nan"), { type: "api_key", key: "saved-key" });
	await models.logout("nan");
	assert.deepEqual((await models.getAuth("nan"))?.auth, { apiKey: "env-key" });
});

test("native auth resolves stored keys before environment and rejects empty configuration", async () => {
	const resolve = createNativeProvider().auth.apiKey!.resolve;
	let envCalls = 0;
	const input = {
		ctx: { async env(name: string) { envCalls++; assert.equal(name, "NAN_API_KEY"); return " env-key "; }, async fileExists() { return false; } },
		signal: new AbortController().signal,
	};
	assert.deepEqual(await resolve({ ...input, credential: { type: "api_key", key: " stored-key " } }), { auth: { apiKey: "stored-key" }, source: "API key" });
	assert.equal(envCalls, 0);
	assert.deepEqual(await resolve({ ...input, credential: { type: "api_key", key: " " } }), { auth: { apiKey: "env-key" }, source: "NAN_API_KEY" });
	assert.equal(await resolve({ ...input, ctx: { ...input.ctx, env: async () => " " } }), undefined);
});

test("native publication exposes the new catalog synchronously, including an empty catalog", async () => {
	for (const ids of [["glm5.3"], []]) {
		const provider = createNativeProvider({
			fetchImpl: async () => jsonResponse({ data: ids.map((id) => ({ id })) }),
		});
		let publications = 0;
		await provider.refreshModels!({
			...refreshContext({ type: "api_key", key: "snapshot-key" }),
			async publish(publication) {
				publications++;
				publication.update?.();
				assert.deepEqual(provider.getModels().map((model) => model.id), ids);
				return true;
			},
		});
		assert.equal(publications, 1);
	}
});

test("stale and aborted publication updates cannot replace the current key's catalog", async () => {
	for (const mode of ["changed-key", "aborted"] as const) {
		const provider = createNativeProvider({
			fetchImpl: async () => jsonResponse({ data: [{ id: "glm5.3" }] }),
		});
		const controller = new AbortController();
		await provider.refreshModels!({
			...refreshContext({ type: "api_key", key: "old-key" }), signal: controller.signal,
			async publish(publication) {
				if (mode === "changed-key") {
					await provider.refreshModels!({
						...refreshContext({ type: "api_key", key: "new-key" }), allowNetwork: false,
						publish: async () => { assert.fail("offline refresh must not publish"); },
					});
				} else controller.abort();
				publication.update?.();
				assert.deepEqual(provider.getModels().map((model) => model.id), DOCUMENTED_CHAT_IDS);
				return false;
			},
		});
		assert.deepEqual(provider.getModels().map((model) => model.id), DOCUMENTED_CHAT_IDS);
	}
});

test("offline and already-aborted refreshes invalidate keys without publication", async () => {
	const provider = createNativeProvider({ fetchImpl: async () => jsonResponse({ data: [{ id: "glm5.3" }] }) });
	await provider.refreshModels!(refreshContext({ type: "api_key", key: "first" }));
	for (const mode of ["offline", "aborted"] as const) {
		const controller = new AbortController();
		if (mode === "aborted") controller.abort();
		await provider.refreshModels!({
			...refreshContext({ type: "api_key", key: mode }),
			allowNetwork: mode !== "offline", signal: controller.signal,
			publish: async () => { assert.fail("refresh must not publish"); },
		});
		assert.deepEqual(provider.getModels().map((model) => model.id), DOCUMENTED_CHAT_IDS);
	}
});

test("initial catalog contains all eleven documented chat models with configured output caps", () => {
	const models = createNanProviderConfig().models;
	assert.deepEqual(models.map((model) => model.id), DOCUMENTED_CHAT_IDS);
	const model = models.find((model) => model.id === "deepseek-v4-flash");
	assert.equal(model?.id, "deepseek-v4-flash");
	assert.equal(model?.api, "openai-completions");
	assert.equal(model?.reasoning, true);
	assert.deepEqual(model?.input, ["text", "image"]);
	assert.equal(model?.contextWindow, 1_000_000);
	assert.equal(models.length, 11);
	assert.equal(model?.maxTokens, 393_216);
	assert.deepEqual(model?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("DeepSeek Flash keeps max_tokens as its configured output field", async () => {
	const models = createNativeProvider().getModels();
	const model = models.find((model) => model.id === "deepseek-v4-flash")!;
	let body: Record<string, unknown> | undefined;
	const result = await completeSimple(model, { messages: [{ role: "user", content: "offline probe", timestamp: 0 }] }, {
		apiKey: "synthetic-key", reasoning: "minimal",
		fetch: async (input, init) => {
			assert.equal(String(input), `${NAN_PROVIDER_BASE_URL}/chat/completions`);
			body = JSON.parse(String(init?.body));
			return new Response('data: {"id":"offline","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	assert.equal(result.stopReason, "stop");
	assert.equal(body?.max_tokens, 393_216);
	assert.ok(!Object.hasOwn(body!, "max_completion_tokens"));
	assert.equal(body?.reasoning_effort, "minimal");
	assert.equal(model.maxTokens, 393_216);
	assert.equal(capCompat(model)?.maxTokensField, "max_tokens");
	assert.ok(models.filter((candidate) => candidate.id !== model.id).every((candidate) => candidate.compat === undefined));
});

test("DeepSeek compat is isolated across snapshots, providers, and live refreshes", async () => {
	const provider = createNativeProvider({ fetchImpl: async () => jsonResponse({ data: [{ id: "deepseek-v4-flash" }] }) });
	for (const live of [false, true]) {
		if (live) await provider.refreshModels!(refreshContext({ type: "api_key", key: "synthetic-key" }));
		const model = provider.getModels().find((model) => model.id === "deepseek-v4-flash")!;
		assert.equal(capCompat(model)?.maxTokensField, "max_tokens");
		capCompat(model)!.maxTokensField = "max_completion_tokens";
		assert.equal(capCompat(provider.getModels().find((candidate) => candidate.id === model.id)!)?.maxTokensField, "max_tokens");
		assert.equal(capCompat(createNativeProvider().getModels().find((model) => model.id === "deepseek-v4-flash")!)?.maxTokensField, "max_tokens");
	}
});

const ALL_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof ALL_EFFORTS)[number];

async function chatPayload(model: ReturnType<ReturnType<typeof createNativeProvider>["getModels"]>[number], reasoning?: Effort) {
	let body: Record<string, unknown> | undefined;
	const result = await completeSimple(model, { messages: [{ role: "user", content: "offline probe", timestamp: 0 }] }, {
		// Pi's simple stream represents the model's off level by omitting reasoning.
		apiKey: "synthetic-key", reasoning: reasoning === "off" ? undefined : reasoning,
		fetch: async (input, init) => {
			assert.equal(String(input), `${NAN_PROVIDER_BASE_URL}/chat/completions`);
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

// Assert the public Pi level list and actual OpenAI-compatible wire payload, not
// just the map: ordinary levels pass through, while off and MiMo use aliases.
for (const id of DOCUMENTED_CHAT_IDS) {
	test(`${id} exposes and serializes NaN's accepted reasoning efforts`, async () => {
		const model = createNativeProvider().getModels().find((candidate) => candidate.id === id);
		assert.ok(model);
		const glm = id === "glm5.3" || id === "glm5.3-flash";
		const mimo = id === "mimo-v2.6-flash";
		const supported = glm ? ALL_EFFORTS.slice(1) : [...ALL_EFFORTS];
		assert.deepEqual(getSupportedThinkingLevels(model), supported);
		if (glm) assert.equal(clampThinkingLevel(model, "off"), "minimal");
		for (const effort of supported) {
			const body = await chatPayload(model, effort);
			const expected = effort === "off" ? "none" : mimo && effort === "minimal" ? "low" : mimo && effort === "xhigh" ? "max" : effort;
			assert.equal(body.model, id);
			assert.equal(body.reasoning_effort, expected, `${id} ${effort}`);
			assert.equal(Object.hasOwn(body, "thinking"), false, `${id} ${effort} must use reasoning_effort`);
			const capField = id === "deepseek-v4-flash" ? "max_tokens" : "max_completion_tokens";
			const otherField = capField === "max_tokens" ? "max_completion_tokens" : "max_tokens";
			// Pi clamps the configured cap to the context window minus its 4,096-token
			// safety reserve and this probe's 4 estimated tokens. Only Kimi K3.1 Pro
			// (Max answer 1M == context window) hits that clamp: 1,000,000 - 4,100.
			const expectedCap = model.maxTokens >= model.contextWindow ? 995_900 : model.maxTokens;
			assert.equal(body[capField], expectedCap, `${id} ${effort} output cap`);
			assert.equal(Object.hasOwn(body, otherField), false, `${id} ${effort} alternate cap`);
		}
	});
}

test("Hy4 forwards explicit effort; Pi's off mapping does not invent its server default", async () => {
	const model = createNativeProvider().getModels().find((candidate) => candidate.id === "hy4");
	assert.ok(model);
	assert.equal((await chatPayload(model, "high")).reasoning_effort, "high");
	assert.equal((await chatPayload(model, "off")).reasoning_effort, "none");
	// Pi's simple stream also uses the off map when no option was supplied.
	assert.equal((await chatPayload(model)).reasoning_effort, "none");
});

test("the legacy adaptive marker is retained but no longer classifies NaN models", () => {
	assert.deepEqual([...NAN_ADAPTIVE_REASONING_MODEL_IDS], []);
	for (const model of createNativeProvider().getModels()) assert.equal(isNanAdaptiveReasoningModel(model), false);
	assert.equal(isNanAdaptiveReasoningModel(undefined), false);
	assert.equal(isNanAdaptiveReasoningModel({ provider: "openai", id: "deepseek-v4-flash" }), false);
});

test("thinking maps are isolated across snapshots, providers, and live catalog refreshes", async () => {
	const provider = createNativeProvider({
		fetchImpl: async () => jsonResponse({ data: DOCUMENTED_CHAT_IDS.map((id) => ({ id })) }),
	});
	const baseline = provider.getModels();
	for (const model of provider.getModels()) {
		const map = levelMap(model);
		assert.ok(map);
		map.off = "mutated";
		map.medium = null;
	}
	assert.deepEqual(provider.getModels(), baseline);
	assert.deepEqual(createNativeProvider().getModels(), baseline);
	await provider.refreshModels!(refreshContext({ type: "api_key", key: "map-key" }));
	assert.deepEqual(provider.getModels(), baseline);
	for (const model of provider.getModels()) {
		const map = levelMap(model);
		assert.ok(map);
		map.xhigh = "mutated";
	}
	assert.deepEqual(provider.getModels(), baseline);
	await provider.refreshModels!(refreshContext({ type: "api_key", key: "map-key" }));
	assert.deepEqual(provider.getModels(), baseline);
});

test("catalog snapshots cannot mutate the offline baseline or another provider", async () => {
	const provider = createNativeProvider();
	const snapshot = [...provider.getModels()];
	snapshot[0].id = "mutated";
	snapshot[0].input.push("image");
	snapshot[0].cost.input = 99;
	snapshot.pop();
	const fresh = provider.getModels();
	assert.deepEqual(fresh.map((model) => model.id), DOCUMENTED_CHAT_IDS);
	assert.deepEqual(fresh[0].input, ["text", "image"]);
	assert.equal(fresh[0].cost.input, 0);
	assert.deepEqual(createNativeProvider().getModels(), fresh);
	await provider.refreshModels!({
		...refreshContext({ type: "api_key", key: "changed-key" }), allowNetwork: false,
	});
	assert.deepEqual(provider.getModels(), fresh);
});

test("live discovery uses the key-scoped endpoint and replaces the fallback with listed models", async () => {
	let request: { url: string; init?: RequestInit } | undefined;
	const config = createNanProviderConfig({
		fetchImpl: async (input, init) => {
			request = { url: String(input), init };
			return jsonResponse({ data: [{ id: " glm5.3 " }, { id: "glm5.3" }, { id: "hy4" }, { id: "qwen3.8-max" }, { id: "deepseek-v4-pro" }, { id: "kimi-k3.1-pro" }, { id: "unknown-chat" }, { id: "embedding" }, { id: "image" }, { id: "speech" }, { id: "rerank" }] });
		},
	});
	const fallbackId = "deepseek-v4-flash";
	assert.ok(fallbackId);

	const models = await config.refreshModels?.(refreshContext({ type: "api_key", key: "test-secret" }));

	assert.equal(request?.url, `${NAN_PROVIDER_BASE_URL}/models`);
	assert.equal(request?.init?.method, "GET");
	assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer test-secret");
	assert.equal(request?.init?.redirect, "error");
	assert.deepEqual(models?.map((model) => model.id), ["glm5.3", "hy4", "qwen3.8-max", "deepseek-v4-pro", "kimi-k3.1-pro"]);
	assert.ok(!models?.some((model) => model.id === fallbackId));

	const known = models?.[0];
	assert.equal(known?.api, "openai-completions");
	assert.equal(known?.reasoning, true);
	assert.deepEqual(known?.input, ["text", "image"]);
	assert.equal(known?.contextWindow, 1_000_000);
	assert.equal(known?.maxTokens, 32_768);
	assert.deepEqual(known?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("known chat models retain documented capabilities without advertising audio", async () => {
	const expected = [
		["glm5.3", 1_000_000, ["text", "image"], 32_768],
		["deepseek-v4-flash", 1_000_000, ["text", "image"], 393_216],
		["glm5.3-flash", 1_000_000, ["text", "image"], 131_072],
		["qwen3.8-flash", 1_048_576, ["text", "image"], 131_000],
		["mimo-v2.6-flash", 1_000_000, ["text", "image"], 32_768],
		["gemma4", 262_000, ["text", "image"], 65_536],
		["qwen3.6", 262_000, ["text", "image"], 65_536],
		["kimi-k3.1-pro", 1_000_000, ["text", "image"], 1_000_000],
		["qwen3.8-max", 1_000_000, ["text", "image"], 131_000],
		["deepseek-v4-pro", 1_000_000, ["text"], 393_000],
		["hy4", 1_000_000, ["text", "image"], 64_000],
	] as const;
	const config = createNanProviderConfig({
		fetchImpl: async () => jsonResponse({ data: expected.map(([id]) => ({ id })) }),
	});
	const models = await config.refreshModels?.(refreshContext({ type: "api_key", key: "test-key" }));
	assert.equal(models?.length, expected.length);
	for (const [index, [id, contextWindow, input, maxTokens]] of expected.entries()) {
		const model = models?.[index];
		assert.equal(model?.id, id);
		assert.equal(model?.reasoning, true);
		assert.equal(model?.api, "openai-completions");
		assert.equal(model?.contextWindow, contextWindow);
		assert.deepEqual(model?.input, input);
		assert.equal(model?.maxTokens, maxTokens);
		assert.deepEqual(model?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(model?.compat, id === "deepseek-v4-flash" ? { maxTokensField: "max_tokens" } : undefined);
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
	assert.deepEqual(await config.refreshModels({
		...refreshContext({ type: "api_key", key: "test-secret" }), allowNetwork: false,
	}), []);
});

test("failed or malformed discovery preserves the documented baseline or last successful catalog", async () => {
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
	assert.deepEqual(await config.refreshModels({
		...refreshContext({ type: "api_key", key: "test-secret" }), allowNetwork: false,
	}), live);
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
	assert.deepEqual(models.map((model) => model.id), DOCUMENTED_CHAT_IDS);
	const changed = await config.refreshModels({
		...refreshContext({ type: "api_key", key: "different-key" }), allowNetwork: false,
	});
	assert.deepEqual(changed.map((model) => model.id), DOCUMENTED_CHAT_IDS);
	assert.equal(calls, 0);
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

test("NaN effort levels per model follow the reasoning contract", () => {
	const models = createNativeProvider().getModels();
	const levels = Object.fromEntries(models.map((model) => [model.id, getSupportedThinkingLevels(model).join(",")]));
	const full = "off,minimal,low,medium,high,xhigh,max";
	const glm = "minimal,low,medium,high,xhigh,max";
	assert.deepEqual(levels, {
		"glm5.3": glm, "glm5.3-flash": glm,
		"deepseek-v4-flash": full, "qwen3.8-flash": full, "mimo-v2.6-flash": full, gemma4: full, "qwen3.6": full,
		"kimi-k3.1-pro": full, "qwen3.8-max": full, "deepseek-v4-pro": full, hy4: full,
	});
	const mimo = models.find((model) => model.id === "mimo-v2.6-flash");
	assert.deepEqual(mimo?.thinkingLevelMap, { off: "none", minimal: "low", xhigh: "max", max: "max" });
});
