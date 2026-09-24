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

export class SddProfileManager {
	readonly globalDir: string;
	readonly projectDir: string;
	readonly builtinsDir?: string;
	readonly activeStatePath: string;
	readonly globalSubagentsPath: string;
	readonly projectSubagentsPath: string;

	constructor(options: ManagerOptions = {}) {
		const agentHome = resolveGentlePiAgentHome();
		this.globalDir = options.globalDir ?? path.join(agentHome, "profiles");
		this.projectDir = options.projectDir ?? path.join(process.cwd(), ".pi", "profiles");
		this.builtinsDir = options.builtinsDir;
		this.activeStatePath = options.activeStatePath ?? path.join(this.globalDir, ".active");
		this.globalSubagentsPath = options.globalSubagentsPath ?? path.join(agentHome, "subagents.json");
		this.projectSubagentsPath =
			options.projectSubagentsPath ?? path.join(process.cwd(), ".pi", "subagents.json");
	}

	sanitizeName(name: string): string {
		return sanitizeProfileName(name);
	}

	private getDeletedProfilesPath(): string {
		return path.join(this.globalDir, ".deleted-profiles");
	}

	private getDeletedProfiles(): Set<string> {
		const filePath = this.getDeletedProfilesPath();
		if (!fs.existsSync(filePath)) return new Set();
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			return new Set(raw.split("\n").map((s) => this.sanitizeName(s)).filter(Boolean));
		} catch {
			return new Set();
		}
	}

	private addDeletedProfile(name: string): void {
		const set = this.getDeletedProfiles();
		set.add(this.sanitizeName(name));
		try {
			if (!fs.existsSync(this.globalDir)) fs.mkdirSync(this.globalDir, { recursive: true });
			fs.writeFileSync(this.getDeletedProfilesPath(), Array.from(set).join("\n"), "utf-8");
		} catch {}
	}

	private removeDeletedProfile(name: string): void {
		const set = this.getDeletedProfiles();
		const key = this.sanitizeName(name);
		if (set.has(key)) {
			set.delete(key);
			try {
				fs.writeFileSync(this.getDeletedProfilesPath(), Array.from(set).join("\n"), "utf-8");
			} catch {}
		}
	}

	private readProfilesFromDir(
		dir: string,
		scope: ProfileScope,
	): Map<string, { profile: Profile; path: string }> {
		const map = new Map<string, { profile: Profile; path: string }>();
		if (!fs.existsSync(dir)) return map;
		const deleted = scope === "builtin" ? this.getDeletedProfiles() : new Set<string>();
		try {
			for (const file of fs.readdirSync(dir)) {
				if (!file.endsWith(".json") || file.startsWith(".")) continue;
				const filePath = path.join(dir, file);
				try {
					const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Profile;
					if (data && typeof data === "object" && data.name) {
						const key = this.sanitizeName(data.name);
						if (deleted.has(key)) continue;
						map.set(key, { profile: data, path: filePath });
					}
				} catch {}
			}
		} catch {}
		return map;
	}

	listProfiles(): ProfileSummary[] {
		const deleted = this.getDeletedProfiles();
		const merged = new Map<string, { profile: Profile; scope: ProfileScope; path?: string }>();
		for (const [key, profile] of Object.entries(BUILTIN_PROFILES)) {
			const norm = this.sanitizeName(key);
			if (!deleted.has(norm)) merged.set(norm, { profile, scope: "builtin" });
		}
		if (this.builtinsDir) {
			for (const [key, val] of this.readProfilesFromDir(this.builtinsDir, "builtin")) {
				merged.set(key, { profile: val.profile, scope: "builtin", path: val.path });
			}
		}
		for (const [key, val] of this.readProfilesFromDir(this.globalDir, "global")) {
			merged.set(key, { profile: val.profile, scope: "global", path: val.path });
		}
		for (const [key, val] of this.readProfilesFromDir(this.projectDir, "project")) {
			merged.set(key, { profile: val.profile, scope: "project", path: val.path });
		}
		const active = this.getActiveProfileName();
		const out: ProfileSummary[] = [];
		for (const item of merged.values()) {
			out.push({
				name: item.profile.name,
				description: item.profile.description,
				default_model: item.profile.default_model,
				agent_count: Object.keys(item.profile.model_profiles ?? {}).length,
				scope: item.scope,
				is_active: Boolean(
					active && this.sanitizeName(item.profile.name) === this.sanitizeName(active),
				),
				path: item.path,
			});
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	loadProfile(name: string): Profile | null {
		const key = this.sanitizeName(name);
		const projectPath = path.join(this.projectDir, `${key}.json`);
		if (fs.existsSync(projectPath)) {
			try {
				return JSON.parse(fs.readFileSync(projectPath, "utf-8")) as Profile;
			} catch {}
		}
		const globalPath = path.join(this.globalDir, `${key}.json`);
		if (fs.existsSync(globalPath)) {
			try {
				return JSON.parse(fs.readFileSync(globalPath, "utf-8")) as Profile;
			} catch {}
		}
		if (!this.getDeletedProfiles().has(key)) {
			if (this.builtinsDir) {
				const builtinPath = path.join(this.builtinsDir, `${key}.json`);
				if (fs.existsSync(builtinPath)) {
					try {
						return JSON.parse(fs.readFileSync(builtinPath, "utf-8")) as Profile;
					} catch {}
				}
			}
			const builtin = BUILTIN_PROFILES[name] ?? BUILTIN_PROFILES[key];
			if (builtin) return { ...builtin };
		}
		return null;
	}

	saveProfile(profile: Profile, scope: "global" | "project" = "global"): string {
		const targetDir = scope === "project" ? this.projectDir : this.globalDir;
		if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
		const key = this.sanitizeName(profile.name);
		this.removeDeletedProfile(key);
		const targetPath = path.join(targetDir, `${key}.json`);
		const now = new Date().toISOString();
		const payload: Profile = { ...profile, name: profile.name.trim(), updated_at: now };
		if (!payload.created_at) payload.created_at = now;
		const bytes = JSON.stringify(payload, null, 2) + "\n";
		const temp = path.join(targetDir, `.${key}.${randomUUID()}.tmp`);
		const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			try {
				fs.writeFileSync(fd, bytes);
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(temp, targetPath);
		} finally {
			try {
				fs.unlinkSync(temp);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return targetPath;
	}

	getActiveProfileName(): string | null {
		if (fs.existsSync(this.projectSubagentsPath)) {
			try {
				const config = JSON.parse(
					fs.readFileSync(this.projectSubagentsPath, "utf-8"),
				) as SubagentsConfigFile;
				if (typeof config.active_profile === "string" && config.active_profile.trim()) {
					return config.active_profile.trim();
				}
			} catch {}
		}
		if (fs.existsSync(this.activeStatePath)) {
			try {
				const content = fs.readFileSync(this.activeStatePath, "utf-8").trim();
				if (content) return content;
			} catch {}
		}
		if (fs.existsSync(this.globalSubagentsPath)) {
			try {
				const config = JSON.parse(
					fs.readFileSync(this.globalSubagentsPath, "utf-8"),
				) as SubagentsConfigFile;
				if (typeof config.active_profile === "string" && config.active_profile.trim()) {
					return config.active_profile.trim();
				}
			} catch {}
		}
		return null;
	}
}
