import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { THINKING_LEVELS as ROUTING_THINKING_LEVELS, type AgentModelConfig, type ThinkingLevel as RoutingThinkingLevel } from "./model-routing-authority.ts";

// Gentle Agents configuration. Agent definitions are markdown files with YAML
// frontmatter (the format gentle-ai installs) and runtime settings come from
// subagents.json at the global and project level. Everything here is pure
// apart from the discovery helpers, which take their roots as arguments.

export const AGENT_MODE = {
	TASK: "task",
	BACKGROUND: "background",
} as const;

export type AgentMode = (typeof AGENT_MODE)[keyof typeof AGENT_MODE];

export type ThinkingLevel = RoutingThinkingLevel;

// Preserve the uppercase compatibility keys without maintaining a second level list.
export const THINKING_LEVEL = Object.fromEntries(
	ROUTING_THINKING_LEVELS.map((level) => [level.toUpperCase(), level]),
) as { readonly [Level in ThinkingLevel as Uppercase<Level>]: Level };

export const AGENT_SCOPE = {
	GLOBAL: "global",
	PROJECT: "project",
} as const;

export type AgentScope = (typeof AGENT_SCOPE)[keyof typeof AGENT_SCOPE];

export const PROFILE_SOURCE = {
	PROFILE: "profile",
	DEFINITION: "definition",
	DEFAULT: "default",
	UNRESOLVED: "unresolved",
} as const;

export type ProfileSource = (typeof PROFILE_SOURCE)[keyof typeof PROFILE_SOURCE];

export interface ModelRef {
	provider: string | undefined;
	id: string;
}

export interface AgentDefinition {
	name: string;
	description: string;
	filePath: string;
	scope: AgentScope;
	instructions: string;
	model: ModelRef | undefined;
	thinking: ThinkingLevel | undefined;
	mode: AgentMode | undefined;
	tools: string[];
}

export interface AgentDefinitionError {
	filePath: string;
	error: string;
}

export interface ModelProfile {
	model: ModelRef | undefined;
	thinking: ThinkingLevel | undefined;
}

export interface AgentsConfig {
	defaultModel: ModelRef | undefined;
	defaultThinking: ThinkingLevel | undefined;
	defaultMode: AgentMode;
	modelProfiles: Record<string, ModelProfile>;
	stallTimeoutMs: number;
	toolStallTimeoutMs: number;
	maxConcurrency: number;
	historyMaxTasks: number;
}

export interface ProfileSources {
	model: ProfileSource;
	thinking: ProfileSource;
}

export interface ResolvedProfile {
	model: ModelRef | undefined;
	thinking: ThinkingLevel | undefined;
	source: ProfileSources;
}

export interface DiscoveryRoots {
	cwd: string;
	home: string;
	agentHome?: string;
}

export interface DiscoveryResult {
	agents: AgentDefinition[];
	errors: string[];
}

export type FrontmatterValue = string | string[];

export interface Frontmatter {
	data: Record<string, FrontmatterValue>;
	body: string;
}

const DEFAULT_STALL_TIMEOUT_MS = 4 * 60_000;
const DEFAULT_TOOL_STALL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_CONCURRENCY = 5;
const DEFAULT_HISTORY_MAX_TASKS = 200;
const THINKING_LEVELS: readonly string[] = ROUTING_THINKING_LEVELS;
const AGENT_MODES = Object.values(AGENT_MODE) as string[];

function unquote(value: string): string {
	const trimmed = value.trim();
	const quoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"));
	return quoted && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed;
}

function parseInlineList(value: string): string[] {
	return value.slice(1, -1).split(",").map(unquote).filter((item) => item.length > 0);
}

// Just enough YAML for agent frontmatter: `key: scalar`, `key: [a, b]`, and
// `key:` followed by `- item` lines. Anything else stays a plain string.
export function parseFrontmatter(text: string): Frontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!match) return { data: {}, body: text.trim() };
	const data: Record<string, FrontmatterValue> = {};
	let listKey: string | undefined;
	for (const raw of match[1].split(/\r?\n/)) {
		const item = /^\s*-\s+(.*)$/.exec(raw);
		if (item && listKey) {
			(data[listKey] as string[]).push(unquote(item[1]));
			continue;
		}
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
		if (!pair) continue;
		const [, key, value] = pair;
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			data[key] = [];
			listKey = key;
			continue;
		}
		listKey = undefined;
		data[key] = trimmed.startsWith("[") && trimmed.endsWith("]") ? parseInlineList(trimmed) : unquote(trimmed);
	}
	return { data, body: match[2].trim() };
}

export function parseModelRef(value: unknown): ModelRef | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return { provider: undefined, id: trimmed };
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

function parseThinking(value: unknown): ThinkingLevel | undefined | string {
	if (value === undefined) return undefined;
	const normalized = String(value).trim().toLowerCase();
	return THINKING_LEVELS.includes(normalized) ? (normalized as ThinkingLevel) : `thinking "${value}" is not one of ${THINKING_LEVELS.join(", ")}`;
}

function parseMode(value: unknown): AgentMode | undefined | string {
	if (value === undefined) return undefined;
	const normalized = String(value).trim().toLowerCase();
	return AGENT_MODES.includes(normalized) ? (normalized as AgentMode) : `mode "${value}" is not one of ${AGENT_MODES.join(", ")}`;
}

function parseTools(value: FrontmatterValue | undefined): string[] {
	if (value === undefined) return [];
	const items = Array.isArray(value) ? value : value.split(",");
	return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

function scalar(value: FrontmatterValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function parseAgentDefinition(text: string, filePath: string, scope: AgentScope): AgentDefinition | AgentDefinitionError {
	const { data, body } = parseFrontmatter(text);
	const thinking = parseThinking(scalar(data.thinking) ?? scalar(data.effort) ?? scalar(data.thinking_level));
	if (thinking !== undefined && !THINKING_LEVELS.includes(thinking)) return { filePath, error: thinking };
	const mode = parseMode(scalar(data.subagent_mode) ?? scalar(data.mode));
	if (mode !== undefined && !AGENT_MODES.includes(mode)) return { filePath, error: mode };
	if (body.length === 0) return { filePath, error: "no instructions after the frontmatter" };
	const name = scalar(data.name)?.trim() || basename(filePath).replace(/\.md$/i, "");
	return {
		name,
		description: scalar(data.description)?.trim() ?? "",
		filePath,
		scope,
		instructions: body,
		model: parseModelRef(data.model),
		thinking: thinking as ThinkingLevel | undefined,
		mode: mode as AgentMode | undefined,
		tools: parseTools(data.tools),
	};
}

// Discovery order is precedence order: a later directory replaces an earlier
// definition with the same name, so project beats global and `subagents/`
// beats `agents/` within each scope.
function profileRoot(roots: DiscoveryRoots): string {
	return roots.agentHome ?? join(roots.home, ".pi", "agent");
}

export function agentDirectories(roots: DiscoveryRoots): Array<{ dir: string; scope: AgentScope }> {
	const agentHome = profileRoot(roots);
	return [
		{ dir: join(agentHome, "agents"), scope: AGENT_SCOPE.GLOBAL },
		{ dir: join(agentHome, "subagents"), scope: AGENT_SCOPE.GLOBAL },
		{ dir: join(roots.cwd, ".pi", "agents"), scope: AGENT_SCOPE.PROJECT },
		{ dir: join(roots.cwd, ".pi", "subagents"), scope: AGENT_SCOPE.PROJECT },
	];
}

export function discoverAgents(roots: DiscoveryRoots): DiscoveryResult {
	const agents = new Map<string, AgentDefinition>();
	const errors: string[] = [];
	for (const { dir, scope } of agentDirectories(roots)) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).filter((entry) => entry.toLowerCase().endsWith(".md")).sort()) {
			const filePath = join(dir, file);
			const parsed = parseAgentDefinition(readFileSync(filePath, "utf8"), filePath, scope);
			if ("error" in parsed) errors.push(`${filePath}: ${parsed.error}`);
			else agents.set(parsed.name, parsed);
		}
	}
	return { agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

type RawConfig = Record<string, unknown> | undefined;

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseProfiles(value: unknown): Record<string, ModelProfile> {
	const profiles: Record<string, ModelProfile> = {};
	if (!value || typeof value !== "object") return profiles;
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		const thinking = parseThinking(entry.effort ?? entry.thinking);
		profiles[name] = { model: parseModelRef(entry.model), thinking: thinking !== undefined && THINKING_LEVELS.includes(thinking) ? (thinking as ThinkingLevel) : undefined };
	}
	return profiles;
}

function mergeProfiles(base: Record<string, ModelProfile>, override: Record<string, ModelProfile>): Record<string, ModelProfile> {
	const merged = { ...base };
	for (const [name, profile] of Object.entries(override)) {
		merged[name] = { model: profile.model ?? base[name]?.model, thinking: profile.thinking ?? base[name]?.thinking };
	}
	return merged;
}

// Project settings override global ones field by field; model profiles merge
// per agent so a project can change one effort without repeating the model.
export function parseAgentsConfig(global: RawConfig, project: RawConfig): AgentsConfig {
	const merged: Record<string, unknown> = { ...(global ?? {}), ...(project ?? {}) };
	const thinking = parseThinking(merged.default_effort ?? merged.default_thinking_level ?? merged.default_thinking);
	const mode = parseMode(merged.default_mode);
	const stallTimeoutMs = positiveInteger(merged.stall_timeout_ms, DEFAULT_STALL_TIMEOUT_MS);
	return {
		defaultModel: parseModelRef(merged.default_model),
		defaultThinking: thinking !== undefined && THINKING_LEVELS.includes(thinking) ? (thinking as ThinkingLevel) : undefined,
		defaultMode: mode !== undefined && AGENT_MODES.includes(mode) ? (mode as AgentMode) : AGENT_MODE.TASK,
		modelProfiles: mergeProfiles(parseProfiles(global?.model_profiles), parseProfiles(project?.model_profiles)),
		// `timeout_ms` remains accepted as an inert legacy key so existing JSON
		// files load normally; only silence is bounded by `stall_timeout_ms`.
		stallTimeoutMs,
		// An announced tool call in flight is live work, not silence, so it gets a
		// longer ceiling; the idle budget still bounds a genuinely quiet child and
		// remains the hard floor for this one.
		toolStallTimeoutMs: Math.max(positiveInteger(merged.tool_stall_timeout_ms, DEFAULT_TOOL_STALL_TIMEOUT_MS), stallTimeoutMs),
		maxConcurrency: positiveInteger(merged.max_concurrency, DEFAULT_MAX_CONCURRENCY),
		historyMaxTasks: positiveInteger(merged.history_max_tasks, DEFAULT_HISTORY_MAX_TASKS),
	};
}

function readJson(path: string): RawConfig {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function loadAgentsConfig(roots: DiscoveryRoots): AgentsConfig {
	return parseAgentsConfig(readJson(join(profileRoot(roots), "subagents.json")), readJson(join(roots.cwd, ".pi", "subagents.json")));
}

export function withPinnedModelProfiles(
	config: AgentsConfig,
	pinned: AgentModelConfig | undefined,
): AgentsConfig {
	// No pin, and no pin-shaped input, both mean today's routing: a repository that
	// never opted in must not observe any difference.
	if (pinned === undefined) return config;
	// The profile replaces subagent routing wholesale. Merging would let routing
	// materialised in `subagents.json` by a previous global profile leak into a
	// repository that pinned a different one, which is the exact conflict a pin
	// exists to remove. Only `modelProfiles` moves: the orchestrator routing and
	// every operational default stay global.
	return { ...config, modelProfiles: parseProfiles(pinned) };
}

function pick<T>(candidates: Array<[T | undefined, ProfileSource]>): [T | undefined, ProfileSource] {
	return candidates.find(([value]) => value !== undefined) ?? [undefined, PROFILE_SOURCE.UNRESOLVED];
}

export function resolveAgentProfile(agent: AgentDefinition, config: AgentsConfig): ResolvedProfile {
	const profile = config.modelProfiles[agent.name];
	const [model, modelSource] = pick<ModelRef>([
		[profile?.model, PROFILE_SOURCE.PROFILE],
		[agent.model, PROFILE_SOURCE.DEFINITION],
		[config.defaultModel, PROFILE_SOURCE.DEFAULT],
	]);
	const [thinking, thinkingSource] = pick<ThinkingLevel>([
		[profile?.thinking, PROFILE_SOURCE.PROFILE],
		[agent.thinking, PROFILE_SOURCE.DEFINITION],
		[config.defaultThinking, PROFILE_SOURCE.DEFAULT],
	]);
	return { model, thinking, source: { model: modelSource, thinking: thinkingSource } };
}

export function formatModelRef(model: ModelRef | undefined): string {
	if (!model) return "default";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}
