import assert from "node:assert/strict";
import test from "node:test";
import type { RefreshModelsContext, Provider } from "@earendil-works/pi-ai";
import { createNvidiaNimProviderConfig, NVIDIA_NIM_BASE_URL, NVIDIA_NIM_PROVIDER_ID } from "../lib/nvidia-nim-provider.ts";

type NvidiaNimProvider = ReturnType<typeof createNvidiaNimProviderConfig>;

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

test("NVIDIA NIM fallback catalog uses hosted full model ids and zero cache rates", () => {
	const provider = createNvidiaNimProviderConfig();
	const models = provider.getModels();
	assert.ok(models.length > 0, "fallback catalog must be non-empty");
	const nemotron = models.find((model) => model.id === "nvidia/nemotron-3-ultra-550b-a55b");
	assert.ok(nemotron, "fallback catalog must use the hosted full model id for Nemotron 3 Ultra");
	assert.equal(nemotron.api, "openai-completions");
	assert.equal(nemotron.reasoning, true);
	assert.deepEqual(nemotron.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("NVIDIA NIM offline refresh keeps the fallback catalog without publishing", async () => {
	const provider = createNvidiaNimProviderConfig();
	let publications = 0;
	await provider.refreshModels!({
		...refreshContext({ type: "api_key", key: "k" }),
		allowNetwork: false,
		publish: async () => {
			publications += 1;
			return true;
		},
	});
	assert.equal(publications, 0);
	assert.ok(provider.getModels().length > 0);
});

test("NVIDIA NIM provider registers an OpenAI-compatible API-key configuration", () => {
	const provider: Provider<"openai-completions"> = createNvidiaNimProviderConfig();
	assert.equal(provider.id, NVIDIA_NIM_PROVIDER_ID);
	assert.equal(provider.name, "NVIDIA NIM");
	assert.equal(provider.baseUrl, NVIDIA_NIM_BASE_URL);
	assert.equal(typeof provider.auth.apiKey?.login, "function");
	assert.equal(typeof provider.auth.apiKey?.resolve, "function");
	assert.equal(typeof provider.streamSimple, "function");
	assert.equal(typeof provider.refreshModels, "function");
});
