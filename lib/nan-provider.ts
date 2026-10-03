import * as piAi from "@earendil-works/pi-ai";
import type { Provider, ProviderStreams, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const NAN_PROVIDER_ID = "nan";
export const NAN_PROVIDER_BASE_URL = "https://api.nan.builders/v1";
export const NAN_MODELS_TIMEOUT_MS = 3_000;

export interface NanProviderOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

type NanChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

// Pi requires numeric rates; NaN access is quota-based, so zero avoids inventing per-token pricing.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Maintained chat subset from https://nan.builders/docs/models.
// Decimal bounds conservatively interpret the documented 1M/262K/131K labels.
// Pi models text/image inputs only; documented audio/video inputs are not advertised.
// Reasoning shares max_tokens with the answer: 65,536 leaves answer room after a
// 32,768 reasoning budget; DeepSeek uses NaN's 16,384 floor. Qwen 3.8 retains its
// published 131K output maximum. The remaining 32,768 caps are configured, not NaN-published limits.
// Pi requires explicit max mappings to offer that level; missing ordinary levels pass through.
const FIXED_THINKING_LEVEL_MAP: NanChatModelConfig["thinkingLevelMap"] = {
	off: null, minimal: null, low: null, high: null, xhigh: null, max: null,
}; // Only medium remains usable: depth is fixed and reasoning cannot be disabled or turned off.

// DeepSeek V4 Flash keeps its fixed depth for enabled levels, but its gateway
// accepts reasoning_effort "none", which deterministically disables reasoning.
const DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP: NanChatModelConfig["thinkingLevelMap"] = {
	off: "none", minimal: null, low: null, high: null, xhigh: null, max: null,
};

const CHAT_MODELS: NanChatModelConfig[] = ([
	{
		id: "glm5.3", name: "GLM 5.3", input: ["text", "image"], contextWindow: 1_000_000,
		thinkingLevelMap: { off: null, minimal: "low", xhigh: "max", max: "max" },
	},
	{
		id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", input: ["text", "image"], contextWindow: 1_000_000,
		thinkingLevelMap: DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP, maxTokens: 16_384,
	},
	{
		id: "glm5.3-flash", name: "GLM 5.3 Flash", input: ["text", "image"], contextWindow: 1_000_000,
		thinkingLevelMap: { off: null, minimal: "low", xhigh: "max", max: "max" },
	},
	{
		id: "qwen3.8-flash", name: "Qwen 3.8 Flash", input: ["text", "image"], contextWindow: 1_048_576,
		thinkingLevelMap: FIXED_THINKING_LEVEL_MAP, maxTokens: 131_000,
	},
	{
		id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", input: ["text", "image"], contextWindow: 1_000_000,
		thinkingLevelMap: FIXED_THINKING_LEVEL_MAP,
	},
	{
		id: "gemma4", name: "Gemma 4", input: ["text", "image"], contextWindow: 262_000,
		thinkingLevelMap: { off: "none", xhigh: "max", max: "max" }, maxTokens: 65_536,
	},
	{
		id: "qwen3.6", name: "Qwen 3.6", input: ["text", "image"], contextWindow: 262_000,
		thinkingLevelMap: { off: "none", xhigh: "max", max: "max" }, maxTokens: 65_536,
	},
] satisfies Partial<NanChatModelConfig>[]).map((model) => ({
	...model,
	api: "openai-completions",
	reasoning: true,
	cost: ZERO_COST,
	maxTokens: model.maxTokens ?? 32_768,
}));

// The cold/offline baseline declares documented chat support, not key entitlement.
// A successful live catalog remains authoritative for the credential that fetched it.
const OFFLINE_MODELS = CHAT_MODELS;

function cloneModel(model: NanChatModelConfig): NanChatModelConfig {
	return {
		...model,
		input: [...model.input],
		cost: { ...model.cost },
		thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
	};
}

function knownChatModels(ids: readonly string[]): NanChatModelConfig[] {
	return ids.flatMap((id) => {
		const known = CHAT_MODELS.find((model) => model.id === id);
		return known ? [cloneModel(known)] : [];
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
		const response = await fetchImpl(`${NAN_PROVIDER_BASE_URL}/models`, {
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

function cloneCatalog(models: readonly NanChatModelConfig[]): NanChatModelConfig[] {
	return models.map(cloneModel);
}

/** Native auth belongs to the provider; Pi persists only a successful login result. */
export function createNanProviderConfig(options: NanProviderOptions = {}): Provider<"openai-completions"> {
	const config = createCatalogConfig(options);
	// Pi's extension loader aliases the bare root to compat, which exposes this
	// host-owned lazy API factory. Do not import an SDK implementation subpath.
	const api = piAi.lazyApi(async () => {
		const runtime = piAi as typeof piAi & { openAICompletionsApi?: () => ProviderStreams };
		if (!runtime.openAICompletionsApi) throw new Error("NaN requires Pi's OpenAI completions API factory");
		return runtime.openAICompletionsApi();
	});
	return {
		id: NAN_PROVIDER_ID,
		name: "NaN",
		baseUrl: NAN_PROVIDER_BASE_URL,
		auth: { apiKey: {
			name: "NaN API key",
			async login(interaction) {
				interaction.signal.throwIfAborted();
				const entered = await interaction.prompt({
					type: "secret", message: "Enter API key", signal: interaction.signal,
				});
				interaction.signal.throwIfAborted();
				const key = entered.trim();
				if (!key) throw new Error("NaN requires a non-empty API key");
				return { type: "api_key", key };
			},
			async resolve({ ctx, credential, signal }) {
				signal.throwIfAborted();
				const stored = credential?.key?.trim();
				const key = stored || (await ctx.env("NAN_API_KEY"))?.trim();
				signal.throwIfAborted();
				return key ? { auth: { apiKey: key }, source: stored ? "API key" : "NAN_API_KEY" } : undefined;
			},
		} },
		getModels: () => config.getModels().map((model) => ({
			...cloneModel(model), provider: NAN_PROVIDER_ID,
			baseUrl: NAN_PROVIDER_BASE_URL, api: "openai-completions" as const,
		})),
		refreshModels: (context) => config.refreshModels(context),
		stream: api.stream,
		streamSimple: api.streamSimple,
	};
}

function createCatalogConfig(options: NanProviderOptions = {}): {
	getModels(): NanChatModelConfig[];
	refreshModels(context: RefreshModelsContext): Promise<void>;
} {
	let catalog = cloneCatalog(OFFLINE_MODELS);
	let catalogKey: string | undefined;
	let credentialRevision = 0;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	return {
		// One source of truth lets Pi snapshot the new catalog inside publish.update.
		getModels: () => cloneCatalog(catalog),
		refreshModels: async (context: RefreshModelsContext) => {
			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			if (apiKey !== catalogKey) {
				// A live catalog is authoritative only for the credential that discovered it.
				catalogKey = apiKey;
				credentialRevision++;
				catalog = cloneCatalog(OFFLINE_MODELS);
			}
			const revision = credentialRevision;
			if (!context.allowNetwork || context.signal.aborted || typeof fetchImpl !== "function") {
				return;
			}

			const ids = await fetchLiveModelIds({
				apiKey,
				signal: context.signal,
				fetchImpl,
				timeoutMs: options.timeoutMs ?? NAN_MODELS_TIMEOUT_MS,
			});
			if (revision !== credentialRevision || ids === undefined || context.signal.aborted) {
				return;
			}

			await context.publish({ update: () => {
				if (revision === credentialRevision && !context.signal.aborted) catalog = knownChatModels(ids);
			} });
		},
	};
}
