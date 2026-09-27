import { existsSync, readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentRoutingEntry {
	model?: string;
	thinking?: ThinkingLevel;
}

export type AgentModelConfig = Record<string, AgentRoutingEntry>;

export type ModelConfigFileResult =
	| { status: "missing" }
	| { status: "invalid"; path: string }
	| { status: "valid"; config: AgentModelConfig };

export const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9._~:@/+%-]+$/;
const SAFE_AGENT_NAME_PATTERN = /^[A-Za-z0-9._:@/+%-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		typeof value === "string" &&
		(THINKING_LEVELS as readonly string[]).includes(value)
	);
}

export function normalizeModelId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const model = value.trim();
	if (model.length === 0) return undefined;
	if (!SAFE_MODEL_ID_PATTERN.test(model)) return undefined;
	return model;
}

export function normalizeRoutingEntry(value: unknown): AgentRoutingEntry | undefined {
	if (typeof value === "string") {
		const model = normalizeModelId(value);
		return model ? { model } : undefined;
	}
	if (!isRecord(value)) return undefined;
	const model = normalizeModelId(value.model);
	const thinking = isThinkingLevel(value.thinking)
		? value.thinking
		: isThinkingLevel(value.effort)
			? value.effort
			: undefined;
	if (!model && !thinking) {
		return Object.keys(value).length === 0 ? {} : undefined;
	}
	return { model, thinking };
}

export function normalizeModelConfig(value: unknown): AgentModelConfig | undefined {
	if (!isRecord(value)) return undefined;
	const cleaned: AgentModelConfig = {};
	for (const [name, entryValue] of Object.entries(value)) {
		if (!SAFE_AGENT_NAME_PATTERN.test(name)) continue;
		const entry = normalizeRoutingEntry(entryValue);
		if (entry) cleaned[name] = entry;
	}
	return cleaned;
}

function parseModelConfigFileValue(value: Record<string, unknown>): AgentModelConfig {
	const config: AgentModelConfig = {};
	for (const [name, entryValue] of Object.entries(value)) {
		const entry = normalizeRoutingEntry(entryValue);
		if (entry) config[name] = entry;
	}
	return config;
}

export function readModelConfigFile(path: string): ModelConfigFileResult {
	if (!existsSync(path)) return { status: "missing" };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) return { status: "invalid", path };
		return { status: "valid", config: parseModelConfigFileValue(parsed) };
	} catch {
		return { status: "invalid", path };
	}
}

export async function readModelConfigFileAsync(
	path: string,
): Promise<ModelConfigFileResult> {
	if (!(await pathExists(path))) return { status: "missing" };
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(parsed)) return { status: "invalid", path };
		return { status: "valid", config: parseModelConfigFileValue(parsed) };
	} catch {
		return { status: "invalid", path };
	}
}

export function readSavedModelConfig(
	globalPath: string,
	projectPath: string,
): ModelConfigFileResult {
	const globalResult = readModelConfigFile(globalPath);
	if (globalResult.status !== "missing") return globalResult;
	return readModelConfigFile(projectPath);
}

export async function readSavedModelConfigAsync(
	globalPath: string,
	projectPath: string,
): Promise<ModelConfigFileResult> {
	const globalResult = await readModelConfigFileAsync(globalPath);
	if (globalResult.status !== "missing") return globalResult;
	return readModelConfigFileAsync(projectPath);
}
