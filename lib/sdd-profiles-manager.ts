import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveGentlePiAgentHome } from "./agent-home.ts";
import type {
	ModelProfileEntry,
	Profile,
	ProfileScope,
	ProfileSummary,
	ReasoningEffort,
	SubagentsConfigFile,
} from "./sdd-profiles-catalog.ts";
import { ALL_KNOWN_AGENTS, BUILTIN_PROFILES } from "./sdd-profiles-catalog.ts";

export function applyProfileToConfig(
	currentConfig: SubagentsConfigFile,
	profile: Profile,
): SubagentsConfigFile {
	const nextConfig: SubagentsConfigFile = { ...currentConfig };
	if (profile.default_model) nextConfig.default_model = profile.default_model;
	if (profile.default_effort) nextConfig.default_effort = profile.default_effort;
	nextConfig.active_profile = profile.name;
	nextConfig.model_profiles = { ...profile.model_profiles };
	return nextConfig;
}

export function extractProfileFromConfig(
	config: SubagentsConfigFile,
	name: string,
	description?: string,
): Profile {
	const now = new Date().toISOString();
	const modelProfiles: Record<string, ModelProfileEntry> = {};
	if (config.model_profiles && typeof config.model_profiles === "object") {
		for (const [agent, val] of Object.entries(config.model_profiles)) {
			if (val && typeof val === "object" && typeof (val as { model?: unknown }).model === "string") {
				modelProfiles[agent] = {
					model: (val as { model: string }).model,
					effort: (val as { effort?: ReasoningEffort }).effort,
				};
			}
		}
	}
	return {
		name,
		description: description ?? `Saved from subagents.json at ${now}`,
		default_model: typeof config.default_model === "string" ? config.default_model : undefined,
		default_effort:
			typeof config.default_effort === "string" ? (config.default_effort as ReasoningEffort) : undefined,
		model_profiles: modelProfiles,
		created_at: now,
		updated_at: now,
	};
}

export function applyProfileToFile(filePath: string, profile: Profile): SubagentsConfigFile {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	let currentConfig: SubagentsConfigFile = {};
	if (fs.existsSync(filePath)) {
		try {
			currentConfig = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		} catch {
			currentConfig = {};
		}
	}
	const updatedConfig = applyProfileToConfig(currentConfig, profile);
	const bytes = JSON.stringify(updatedConfig, null, 2) + "\n";
	const temp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
	const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
	try {
		try {
			fs.writeFileSync(fd, bytes);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temp, filePath);
	} finally {
		try {
			fs.unlinkSync(temp);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return updatedConfig;
}

const FALLBACK_MODELS = [
	"anthropic/claude-sonnet-4-5",
	"anthropic/claude-haiku-4-5",
	"anthropic/claude-opus-4-6",
	"openai/o3-mini",
	"openai/gpt-4o",
	"openai/gpt-4o-mini",
	"google/gemini-2.5-flash",
	"google/gemini-2.5-pro",
];

export async function resolveAvailableModels(ctx?: unknown): Promise<string[]> {
	const modelSet = new Set<string>();
	try {
		const registry = (ctx as { modelRegistry?: { getAvailable?: () => Promise<unknown[]> } })
			?.modelRegistry;
		const registryModels = await registry?.getAvailable?.();
		if (Array.isArray(registryModels)) {
			for (const m of registryModels) {
				const item = m as { provider?: string; providerId?: string; id?: string; model?: string };
				const provider = item.provider ?? item.providerId;
				const id = item.id ?? item.model;
				if (provider && id) modelSet.add(`${provider}/${id}`);
			}
		}
	} catch {}
	const agentHome = resolveGentlePiAgentHome();
	const modelsJsonPath = path.join(agentHome, "models.json");
	if (fs.existsSync(modelsJsonPath)) {
		try {
			const data = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8")) as {
				providers?: Record<string, { models?: Array<{ id?: string }> }>;
			};
			if (data?.providers && typeof data.providers === "object") {
				for (const [provider, pData] of Object.entries(data.providers)) {
					if (Array.isArray(pData?.models)) {
						for (const m of pData.models) {
							if (m?.id) modelSet.add(`${provider}/${m.id}`);
						}
					}
				}
			}
		} catch {}
	}
	const storeJsonPath = path.join(agentHome, "models-store.json");
	if (fs.existsSync(storeJsonPath)) {
		try {
			const data = JSON.parse(fs.readFileSync(storeJsonPath, "utf-8")) as Record<
				string,
				{ models?: Array<{ id?: string }> }
			>;
			if (typeof data === "object" && data !== null) {
				for (const [provider, pData] of Object.entries(data)) {
					if (Array.isArray(pData?.models)) {
						for (const m of pData.models) {
							if (m?.id) modelSet.add(`${provider}/${m.id}`);
						}
					}
				}
			}
		} catch {}
	}
	for (const fallback of FALLBACK_MODELS) modelSet.add(fallback);
	return Array.from(modelSet).sort((a, b) => a.localeCompare(b));
}

export interface ManagerOptions {
	globalDir?: string;
	projectDir?: string;
	builtinsDir?: string;
	activeStatePath?: string;
	globalSubagentsPath?: string;
	projectSubagentsPath?: string;
}

export function sanitizeProfileName(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

