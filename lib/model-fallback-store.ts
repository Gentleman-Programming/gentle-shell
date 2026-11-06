import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidProfileName, writeJsonFileAtomicallySync } from "./agent-profiles.ts";
import { isSafeAgentName, isThinkingLevel, SAFE_MODEL_ID_PATTERN, type ThinkingLevel } from "./model-routing-authority.ts";

// Fallback chains per profile and agent. They live in their own file next to
// profiles.json: the profiles reader rejects unknown keys, so keeping chains
// apart lets older versions read profiles.json unchanged (they just never
// fall back). Every model in a chain is one the user picked.

export const FALLBACKS_KIND = "gentle-pi.profile_model_fallbacks";
export const FALLBACKS_VERSION = 1;
/** The chain for every agent of a profile that has none of its own. */
export const DEFAULT_CHAIN_KEY = "*";
export const MAX_CHAIN_LENGTH = 8;

export interface FallbackStep {
	model: string;
	thinking?: ThinkingLevel;
}
export type FallbackChain = readonly FallbackStep[];
export interface FallbacksFile {
	kind: typeof FALLBACKS_KIND;
	version: typeof FALLBACKS_VERSION;
	/** profile name → agent name (or `*`) → ordered fallbacks */
	profiles: Record<string, Record<string, FallbackStep[]>>;
}
export type FallbacksReadResult = { status: "missing" } | { status: "invalid" } | { status: "valid"; file: FallbacksFile };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));

export function fallbacksFilePath(configHome: string): string {
	return join(configHome, "profile-fallbacks.json");
}

export function emptyFallbacksFile(): FallbacksFile {
	return { kind: FALLBACKS_KIND, version: FALLBACKS_VERSION, profiles: {} };
}

function normalizeStep(value: unknown): FallbackStep | undefined {
	if (!isRecord(value) || !exactKeys(value, ["model", "thinking"])) return undefined;
	if (typeof value.model !== "string" || !value.model || !SAFE_MODEL_ID_PATTERN.test(value.model)) return undefined;
	const thinking = value.thinking;
	if (thinking === undefined) return { model: value.model };
	return isThinkingLevel(thinking) ? { model: value.model, thinking } : undefined;
}

function normalizeChain(value: unknown): FallbackStep[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_CHAIN_LENGTH) return undefined;
	const steps = value.map(normalizeStep);
	if (steps.some((step) => step === undefined)) return undefined;
	const models = steps.map((step) => step!.model);
	return new Set(models).size === models.length ? (steps as FallbackStep[]) : undefined;
}

const validAgentKey = (key: string) => key === DEFAULT_CHAIN_KEY || isSafeAgentName(key);

export function normalizeFallbacksFile(value: unknown): FallbacksFile | undefined {
	if (!isRecord(value) || !exactKeys(value, ["kind", "version", "profiles"])) return undefined;
	if (value.kind !== FALLBACKS_KIND || value.version !== FALLBACKS_VERSION || !isRecord(value.profiles)) return undefined;
	const profiles: FallbacksFile["profiles"] = {};
	for (const [name, agents] of Object.entries(value.profiles)) {
		if (!isValidProfileName(name) || !isRecord(agents)) return undefined;
		const chains: Record<string, FallbackStep[]> = {};
		for (const [agent, chain] of Object.entries(agents)) {
			const steps = validAgentKey(agent) ? normalizeChain(chain) : undefined;
			if (!steps) return undefined;
			if (steps.length) chains[agent] = steps;
		}
		if (Object.keys(chains).length) profiles[name] = chains;
	}
	return { kind: FALLBACKS_KIND, version: FALLBACKS_VERSION, profiles };
}

export function parseFallbacksFileText(text: string): { status: "invalid" } | { status: "valid"; file: FallbacksFile } {
	try {
		const file = normalizeFallbacksFile(JSON.parse(text));
		return file ? { status: "valid", file } : { status: "invalid" };
	} catch {
		return { status: "invalid" };
	}
}

/** Reads the chains; a broken file is reported, never rewritten. */
export function readFallbacksFile(path: string): FallbacksReadResult {
	if (!existsSync(path)) return { status: "missing" };
	try {
		return parseFallbacksFileText(readFileSync(path, "utf8"));
	} catch {
		return { status: "invalid" };
	}
}

export function writeFallbacksFile(path: string, file: FallbacksFile): void {
	const normalized = normalizeFallbacksFile(file);
	if (!normalized) throw new TypeError("Invalid fallback chains");
	writeJsonFileAtomicallySync(path, `${JSON.stringify(normalized, null, 2)}\n`);
}

/** The fallbacks for `agent` under `profile`: its own chain, else the profile's `*` chain, else none. */
export function chainFor(file: FallbacksFile, profile: string | undefined, agent: string): FallbackChain {
	if (!profile) return [];
	const chains = file.profiles[profile];
	return chains?.[agent] ?? chains?.[DEFAULT_CHAIN_KEY] ?? [];
}

/** Replaces one chain; an empty chain removes the entry (and an emptied profile). */
export function setChain(file: FallbacksFile, profile: string, agent: string, steps: FallbackChain): FallbacksFile {
	if (!isValidProfileName(profile)) throw new TypeError(`Invalid profile name: ${profile}`);
	if (!validAgentKey(agent)) throw new TypeError(`Invalid agent name: ${agent}`);
	const chain = normalizeChain(steps.map((step) => ({ ...step })));
	if (!chain) {
		const models = steps.map((step) => step.model);
		throw new TypeError(new Set(models).size !== models.length ? "A model can appear once per chain" : `Invalid fallback chain for ${agent}`);
	}
	const chains = { ...(file.profiles[profile] ?? {}) };
	if (chain.length) chains[agent] = chain;
	else delete chains[agent];
	const profiles = { ...file.profiles };
	if (Object.keys(chains).length) profiles[profile] = chains;
	else delete profiles[profile];
	return { ...file, profiles };
}

/** Follows a profile rename (`to`) or deletion (`to` undefined). */
export function renameProfileFallbacks(file: FallbacksFile, from: string, to: string | undefined): FallbacksFile {
	if (!(from in file.profiles)) return file;
	const profiles = { ...file.profiles };
	const chains = profiles[from]!;
	delete profiles[from];
	if (to) profiles[to] = chains;
	return { ...file, profiles };
}

/** Keeps the chains on disk with a renamed (`to`) or deleted profile; false when there was nothing to follow or the file is broken. */
export function followProfileRename(configHome: string, from: string, to: string | undefined): boolean {
	const path = fallbacksFilePath(configHome);
	const read = readFallbacksFile(path);
	if (read.status !== "valid" || !(from in read.file.profiles)) return false;
	writeFallbacksFile(path, renameProfileFallbacks(read.file, from, to));
	return true;
}
