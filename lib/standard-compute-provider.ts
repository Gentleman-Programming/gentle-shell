import * as piAi from "@earendil-works/pi-ai";
import type { Provider, ProviderStreams, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// Standard Compute Provider ID
export const STANDARDCOMPUTE_PROVIDER_ID = "standardcompute";
// Standard Compute Base URL (OpenAI-compatible endpoint)
export const STANDARDCOMPUTE_BASE_URL = "https://api.stdcmpt.com/v1";
// Smart routing entry model id accepted by the OpenAI-compatible endpoints
export const STANDARDCOMPUTE_MODEL_ID = "standardcompute";
export const STANDARDCOMPUTE_MODELS_TIMEOUT_MS = 3_000;

export interface StandardComputeProviderOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

type StandardComputeChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

// Pi requires numeric rates; Standard Compute does not publish per-token prices.
// Zero is a placeholder, not a claim that usage is free.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Smart routing picks the enabled model per request, so the fallback declares the
// documented ceiling (context windows up to ~1M tokens) instead of a pinned model.
const SMART_ROUTING_MODEL_ID = STANDARDCOMPUTE_MODEL_ID;

// Pi thinking levels pass through as OpenAI-style reasoning_effort; off omits the
// effort (the provider default), so no explicit off mapping is required.
const SMART_THINKING_LEVEL_MAP: StandardComputeChatModelConfig["thinkingLevelMap"] = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const SMART_ROUTING_MODEL: StandardComputeChatModelConfig = {
	id: SMART_ROUTING_MODEL_ID,
	name: "StandardCompute",
	input: ["text", "image"],
	contextWindow: 1_000_000,
	reasoning: true,
	maxTokens: 1_000_000,
	thinkingLevelMap: SMART_THINKING_LEVEL_MAP,
	cost: ZERO_COST,
};

function cloneModel(model: StandardComputeChatModelConfig): StandardComputeChatModelConfig {
	return {
		...model,
		input: [...model.input],
		cost: { ...model.cost },
		thinkingLevelMap: model.thinkingLevelMap ? structuredClone(model.thinkingLevelMap) : undefined,
		...(model.compat ? { compat: { ...model.compat } } : {}),
	};
}

function cloneCatalog(models: readonly StandardComputeChatModelConfig[]): StandardComputeChatModelConfig[] {
	return models.map(cloneModel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Conservative defaults for models listed by the gateway but absent from the fallback catalog.
function unmanagedChatModel(id: string): StandardComputeChatModelConfig {
	return {
		id,
		name: id,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		reasoning: true,
		maxTokens: 1_000_000,
		api: "openai-completions",
		cost: ZERO_COST,
	} as StandardComputeChatModelConfig;
}

function buildCatalog(ids: readonly string[]): StandardComputeChatModelConfig[] {
	const models = new Map<string, StandardComputeChatModelConfig>();
	for (const rawId of ids) {
		const id = rawId.trim();
		if (!id) continue;
		if (id.toLowerCase() === SMART_ROUTING_MODEL_ID) {
			models.set(SMART_ROUTING_MODEL_ID, cloneModel(SMART_ROUTING_MODEL));
			continue;
		}
		models.set(id, unmanagedChatModel(id));
	}
	return [...models.values()];
}

/** Returns undefined on an unusable response; an empty data array is authoritative. */
async function fetchLiveModelIds(options: {
	apiKey?: string;
	signal: AbortSignal;
	fetchImpl: typeof fetch;
	timeoutMs: number;
}): Promise<string[] | undefined> {
	const { apiKey, signal, fetchImpl, timeoutMs } = options;
	if (signal.aborted) return undefined;

	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const response = await fetchImpl(`${STANDARDCOMPUTE_BASE_URL}/models`, {
			method: "GET",
			headers,
			signal: controller.signal,
			redirect: "error",
			cache: "no-store",
		});
		if (!response.ok) return undefined;

		const payload: unknown = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload.data)) return undefined;
		if (payload.data.length === 0) return [];

		const ids = new Set<string>();
		for (const row of payload.data) {
			if (!isRecord(row) || typeof row.id !== "string") continue;
			const id = row.id.trim();
			if (id) ids.add(id);
		}
		return ids.size > 0 ? [...ids] : undefined;
	} catch {
		// Discovery is best-effort. Never log request or response data: it may contain credentials.
		return undefined;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abort);
	}
}

function createCatalogConfig(options: StandardComputeProviderOptions = {}): {
	getModels(): StandardComputeChatModelConfig[];
	refreshModels(context: RefreshModelsContext): Promise<void>;
} {
	let catalog = cloneCatalog([SMART_ROUTING_MODEL]);
	let catalogKey: string | undefined;
	let credentialRevision = 0;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	return {
		getModels: () => cloneCatalog(catalog),
		refreshModels: async (context: RefreshModelsContext) => {
			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			if (apiKey !== catalogKey) {
				// A live catalog is authoritative only for the credential that discovered it.
				catalogKey = apiKey;
				credentialRevision++;
				catalog = cloneCatalog([SMART_ROUTING_MODEL]);
			}
			const revision = credentialRevision;
			if (!context.allowNetwork || context.signal.aborted || typeof fetchImpl !== "function") {
				return;
			}

			const ids = await fetchLiveModelIds({
				apiKey,
				signal: context.signal,
				fetchImpl,
				timeoutMs: options.timeoutMs ?? STANDARDCOMPUTE_MODELS_TIMEOUT_MS,
			});
			if (revision !== credentialRevision || ids === undefined || context.signal.aborted) {
				return;
			}

			await context.publish({ update: () => {
				if (revision === credentialRevision && !context.signal.aborted) catalog = buildCatalog(ids);
			} });
		},
	};
}

/** Native auth belongs to the provider; Pi persists only a successful login result. */
export function createStandardComputeProviderConfig(options: StandardComputeProviderOptions = {}): Provider<"openai-completions"> {
	const config = createCatalogConfig(options);
	// Pi's extension loader aliases the bare root to compat, which exposes this
	// host-owned lazy API factory.
	const api = piAi.lazyApi(async () => {
		const runtime = piAi as typeof piAi & { openAICompletionsApi?: () => ProviderStreams };
		if (!runtime.openAICompletionsApi) throw new Error("Standard Compute requires Pi's OpenAI completions API factory");
		return runtime.openAICompletionsApi();
	});

	return {
		id: STANDARDCOMPUTE_PROVIDER_ID,
		name: "Standard Compute",
		baseUrl: STANDARDCOMPUTE_BASE_URL,
		auth: {
			apiKey: {
				name: "Standard Compute API key",
				async login(interaction) {
					interaction.signal.throwIfAborted();
					const entered = await interaction.prompt({
						type: "secret", message: "Enter Standard Compute API Key", signal: interaction.signal,
					});
					interaction.signal.throwIfAborted();
					const key = entered.trim();
					if (!key) throw new Error("Standard Compute requires a non-empty API key");
					return { type: "api_key", key };
				},
				async resolve({ ctx, credential, signal }) {
					signal.throwIfAborted();
					const stored = credential?.key?.trim();
					const key = stored || (await ctx.env("STANDARDCOMPUTE_API_KEY"))?.trim();
					signal.throwIfAborted();
					return key ? { auth: { apiKey: key }, source: stored ? "API key" : "STANDARDCOMPUTE_API_KEY" } : undefined;
				},
			},
		},
		getModels: () => config.getModels().map((model) => ({
			...cloneModel(model), provider: STANDARDCOMPUTE_PROVIDER_ID,
			baseUrl: STANDARDCOMPUTE_BASE_URL, api: "openai-completions" as const,
		})),
		refreshModels: (context) => config.refreshModels(context),
		stream: api.stream,
		streamSimple: api.streamSimple,
	};
}
