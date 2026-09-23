import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// ---------------------------------------------------------------------------
// Background subagents policy — project > global > env > default off
//
// Pure resolver, extracted from extensions/gentle-ai.ts so the runtime side
// (extensions/gentle-agents.ts) can read the effective policy without
// importing the pi extension surface. No pi imports belong in this file.
// ---------------------------------------------------------------------------

export type BackgroundSubagentsPolicy = "on" | "off";

/** Which of the four sources decided the effective policy. */
export type BackgroundSubagentsSource =
	| "project_file"
	| "global_file"
	| "environment"
	| "default";

export interface BackgroundSubagentsResolution {
	policy: BackgroundSubagentsPolicy;
	source: BackgroundSubagentsSource;
	/** The deciding file was present but failed the strict decode. */
	malformed: boolean;
	projectFile: string;
	globalFile: string;
	projectFileExists: boolean;
	globalFileExists: boolean;
	/** The raw env value, reported even when it is unrecognized and inert. */
	envValue: string | undefined;
}

export interface LoadBackgroundSubagentsOptions {
	/** Override the config home directory (used in tests to avoid touching ~/.pi). */
	gentlePiConfigHome?: string;
	/** Override the environment lookup (used in tests). */
	env?: Record<string, string | undefined>;
}

export const BACKGROUND_SUBAGENTS_SCHEMA = "gentle-pi.background-subagents/v1";
export const BACKGROUND_SUBAGENTS_FILE = "background-subagents.json";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict decode of {"schema":"gentle-pi.background-subagents/v1","policy":"on"|"off"}.
 * Any malformed shape (bad JSON, wrong schema, unknown keys, invalid policy)
 * returns undefined so the caller fails closed to "off".
 */
export function parseBackgroundSubagentsPolicyFile(
	raw: string,
): BackgroundSubagentsPolicy | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	if (parsed.schema !== BACKGROUND_SUBAGENTS_SCHEMA) return undefined;
	if (parsed.policy !== "on" && parsed.policy !== "off") return undefined;
	if (Object.keys(parsed).length !== 2) return undefined;
	return parsed.policy;
}

/**
 * Resolve the background-subagents policy AND the source that decided it.
 *
 * Resolution order (first hit wins, mirroring loadRuntimeGuardrailsConfig):
 *   1. Project file `${cwd}/.pi/gentle-ai/background-subagents.json`
 *   2. Global file `${configHome}/background-subagents.json`
 *      (configHome honors GENTLE_PI_CONFIG_HOME, default ~/.pi/gentle-ai)
 *   3. Env var GENTLE_PI_BACKGROUND_SUBAGENTS ("on" | "off")
 *   4. Default "off"
 *
 * A present-but-malformed file fails closed to "off" instead of falling
 * through to a lower-priority source, and it stays attributed to that file:
 * "off decided by a broken project file" and "off by default" are different
 * situations, and only the first one is a mistake to fix.
 *
 * Four sources with first-hit-wins is exactly the shape that makes an edit
 * look like it did nothing, so the deciding source is part of the result
 * rather than something a caller has to re-derive.
 */
export function resolveBackgroundSubagentsPolicy(
	cwd: string,
	options: LoadBackgroundSubagentsOptions = {},
): BackgroundSubagentsResolution {
	const env = options.env ?? process.env;
	const envValue = env.GENTLE_PI_BACKGROUND_SUBAGENTS;
	let projectFile = "";
	let globalFile = "";
	try {
		const configHome = options.gentlePiConfigHome ?? gentlePiConfigHome();
		projectFile = join(cwd, ".pi", "gentle-ai", BACKGROUND_SUBAGENTS_FILE);
		globalFile = join(configHome, BACKGROUND_SUBAGENTS_FILE);
		const projectFileExists = existsSync(projectFile);
		const globalFileExists = existsSync(globalFile);
		const locations = { projectFile, globalFile, projectFileExists, globalFileExists, envValue };
		for (const [source, path, present] of [
			["project_file", projectFile, projectFileExists],
			["global_file", globalFile, globalFileExists],
		] as const) {
			if (!present) continue;
			let decoded: BackgroundSubagentsPolicy | undefined;
			try {
				decoded = parseBackgroundSubagentsPolicyFile(readFileSync(path, "utf8"));
			} catch {
				// Unreadable is indistinguishable from unusable at this layer, and
				// both must fail closed on the file that claimed the decision.
				decoded = undefined;
			}
			return decoded === undefined
				? { policy: "off", source, malformed: true, ...locations }
				: { policy: decoded, source, malformed: false, ...locations };
		}
		if (envValue === "on" || envValue === "off") {
			return { policy: envValue, source: "environment", malformed: false, ...locations };
		}
		return { policy: "off", source: "default", malformed: false, ...locations };
	} catch {
		return {
			policy: "off",
			source: "default",
			malformed: false,
			projectFile,
			globalFile,
			projectFileExists: false,
			globalFileExists: false,
			envValue,
		};
	}
}

/**
 * The effective policy alone, for callers that do not report a source.
 * It delegates so the loader and the resolver can never disagree.
 */
export function loadBackgroundSubagentsPolicy(
	cwd: string,
	options: LoadBackgroundSubagentsOptions = {},
): BackgroundSubagentsPolicy {
	return resolveBackgroundSubagentsPolicy(cwd, options).policy;
}
