import * as piAi from "@earendil-works/pi-ai";
import type { Provider, RefreshModelsContext, ProviderStreams } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// NVIDIA NIM Provider ID
export const NVIDIA_NIM_PROVIDER_ID = "nvidia";
// NVIDIA NIM Base URL
export const NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

// Known NVIDIA NIM model IDs (fallback when /models endpoint doesn't return them)
type NvidiaChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

const KNOWN_NVIDIA_MODELS: ReadonlyArray<Partial<NvidiaChatModelConfig>> = [
	{
		id: "nemotron-3-ultra-550b-a55b",
		name: "Nemotron 3 Ultra 550B",
		input: ["text"],
		contextWindow: 128_000,
		reasoning: true,
		maxTokens: 16_384,
	},
	{
		id: "nemotron-3-ultra",
		name: "Nemotron 3 Ultra",
		input: ["text"],
		contextWindow: 128_000,
		reasoning: true,
		maxTokens: 16_384,
	},
	{
		id: "nemotron-4-340b",
		name: "Nemotron 4 340B",
		input: ["text"],
		contextWindow: 128_000,
		reasoning: true,
		maxTokens: 16_384,
	},
	{
		id: "llama-3.1-nemotron-70b-instruct",
		name: "Llama 3.1 Nemotron 70B Instruct",
		input: ["text"],
		contextWindow: 128_000,
		reasoning: true,
		maxTokens: 16_384,
	},
	{
		id: "llama-3.1-nemotron-51b-instruct",
		name: "Llama 3.1 Nemotron 51B Instruct",
		input: ["text"],
		contextWindow: 128_000,
		reasoning: true,
		maxTokens: 16_384,
	},
];

function cloneModel(model: NvidiaChatModelConfig): NvidiaChatModelConfig {
	return {
		...model,
		input: [...model.input],
		cost: { ...model.cost },
		thinkingLevelMap: model.thinkingLevelMap ? structuredClone(model.thinkingLevelMap) : undefined,
		...(model.compat ? { compat: { ...model.compat } } : {}),
	};
}

function knownModels(ids: readonly string[]): NvidiaChatModelConfig[] {
	return ids.flatMap((id) => {
		const known = KNOWN_NVIDIA_MODELS.find((model) => model.id === id);
		if (known) {
			return [{
				...known,
				api: "openai-completions",
				cost: { input: 0, output: 0 },
				maxTokens: known.maxTokens ?? 4_096,
			} as NvidiaChatModelConfig];
		}
		// Unknown model from live catalog - include with defaults
		return [{
			id,
			name: id,
			input: ["text"],
			contextWindow: 128_000,
			api: "openai-completions",
			reasoning: true,
			cost: { input: 0, output: 0 },
			maxTokens: 16_384,
		} as NvidiaChatModelConfig];
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
		const response = await fetchImpl(`${NVIDIA_NIM_BASE_URL}/models`, {
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
	}
}

function createCatalogConfig(options: {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
} = {}): {
	getModels(): NvidiaChatModelConfig[];
	refreshModels(context: RefreshModelsContext): Promise<void>;
} {
	let catalog = knownModels(KNOWN_NVIDIA_MODELS.map(m => m.id!));
	let catalogKey: string | undefined;
	let credentialRevision = 0;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	return {
		getModels: () => catalog.map(cloneModel),
		refreshModels: async (context: RefreshModelsContext) => {
			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			if (apiKey !== catalogKey) {
				catalogKey = apiKey;
				credentialRevision++;
				catalog = knownModels(KNOWN_NVIDIA_MODELS.map(m => m.id!));
			}
			const revision = credentialRevision;
			if (!context.allowNetwork || context.signal.aborted || typeof fetchImpl !== "function") {
				return;
			}

			const ids = await fetchLiveModelIds({
				apiKey,
				signal: context.signal,
				fetchImpl,
				timeoutMs: options.timeoutMs ?? 10_000,
			});
			if (revision !== credentialRevision || ids === undefined || context.signal.aborted) {
				return;
			}

			await context.publish({ update: () => {
				if (revision === credentialRevision && !context.signal.aborted) catalog = knownModels(ids);
			} });
		},
	};
}

/** Native auth belongs to the provider; Pi persists only a successful login result. */
export function createNvidiaNimProviderConfig(options: {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
} = {}): Provider<"openai-completions"> {
	const config = createCatalogConfig(options);
	// Pi's extension loader aliases the bare root to compat, which exposes this
	// host-owned lazy API factory.
	const api = piAi.lazyApi(async () => {
		const runtime = piAi as typeof piAi & { openAICompletionsApi?: () => ProviderStreams };
		if (!runtime.openAICompletionsApi) throw new Error("NVIDIA NIM requires Pi's OpenAI completions API factory");
		return runtime.openAICompletionsApi();
	});

	return {
		id: NVIDIA_NIM_PROVIDER_ID,
		name: "NVIDIA NIM",
		baseUrl: NVIDIA_NIM_BASE_URL,
		auth: {
			apiKey: {
				name: "NVIDIA API Key",
				async login(interaction) {
					interaction.signal.throwIfAborted();
					const entered = await interaction.prompt({
						type: "secret", message: "Enter NVIDIA API Key", signal: interaction.signal,
					});
					interaction.signal.throwIfAborted();
					const key = entered.trim();
					if (!key) throw new Error("NVIDIA NIM requires a non-empty API key");
					return { type: "api_key", key };
				},
				async resolve({ ctx, credential, signal }) {
					signal.throwIfAborted();
					const stored = credential?.key?.trim();
					// Read from NVIDIA_API_KEY environment variable (user has it in ~/.env)
					const key = stored || (await ctx.env("NVIDIA_API_KEY"))?.trim();
					signal.throwIfAborted();
					return key ? { auth: { apiKey: key }, source: stored ? "API key" : "NVIDIA_API_KEY" } : undefined;
				},
			},
		},
		getModels: () => config.getModels().map((model) => ({
			...cloneModel(model), provider: NVIDIA_NIM_PROVIDER_ID,
			baseUrl: NVIDIA_NIM_BASE_URL, api: "openai-completions" as const,
		})),
		refreshModels: (context) => config.refreshModels(context),
		stream: api.stream,
		streamSimple: api.streamSimple,
	};
}