import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// ---------------------------------------------------------------------------
// Double-esc-cancel policy — global file > env > default off (issue #1163)
//
// Deliberately global-only (no project-file layer, unlike
// background-subagents): this preference changes what a keypress does while
// the agent is working, and a per-project override for a personal habit like
// this would make the same key do two different things depending on which
// repo happens to be open. Otherwise mirrors the resolution shape of
// lib/background-subagents-policy.ts, minus that project-file layer.
// ---------------------------------------------------------------------------

export type DoubleEscCancelPolicy = "on" | "off";

/** Which of the three sources decided the effective policy. */
export type DoubleEscCancelSource = "global_file" | "environment" | "default";

export interface DoubleEscCancelResolution {
	policy: DoubleEscCancelPolicy;
	source: DoubleEscCancelSource;
	/** The deciding file was present but failed the strict decode. */
	malformed: boolean;
	globalFile: string;
	globalFileExists: boolean;
	/** The raw env value, reported even when it is unrecognized and inert. */
	envValue: string | undefined;
}

export interface LoadDoubleEscCancelOptions {
	/** Override the config home directory (used in tests to avoid touching ~/.pi). */
	gentlePiConfigHome?: string;
	/** Override the environment lookup (used in tests). */
	env?: Record<string, string | undefined>;
}

export const DOUBLE_ESC_CANCEL_SCHEMA = "gentle-pi.double-esc-cancel/v1";
export const DOUBLE_ESC_CANCEL_FILE = "double-esc-cancel.json";

// Pi's own idle double-Esc (empty editor -> /tree or /fork, interactive-mode.js
// `lastEscapeTime`) uses a 500ms window. Canceling a running turn throws away
// in-flight work and is harder to undo than switching prompts, so this
// confirmation deliberately gets double that time to land the second press.
export const DOUBLE_ESC_CANCEL_WINDOW_MS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict decode of {"schema":"gentle-pi.double-esc-cancel/v1","policy":"on"|"off"}.
 * Any malformed shape (bad JSON, wrong schema, unknown keys, invalid policy)
 * returns undefined so the caller fails closed to "off".
 */
export function parseDoubleEscCancelPolicyFile(raw: string): DoubleEscCancelPolicy | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	if (parsed.schema !== DOUBLE_ESC_CANCEL_SCHEMA) return undefined;
	if (parsed.policy !== "on" && parsed.policy !== "off") return undefined;
	if (Object.keys(parsed).length !== 2) return undefined;
	return parsed.policy;
}

/**
 * Resolve the double-esc-cancel policy AND the source that decided it.
 *
 * Resolution order (first hit wins):
 *   1. Global file `${configHome}/double-esc-cancel.json`
 *      (configHome honors GENTLE_PI_CONFIG_HOME, default ~/.pi/gentle-ai)
 *   2. Env var GENTLE_PI_DOUBLE_ESC_CANCEL ("on" | "off")
 *   3. Default "off"
 *
 * A present-but-malformed file fails closed to "off" instead of falling
 * through to the env var, and stays attributed to that file: "off decided
 * by a broken global file" and "off by default" are different situations,
 * and only the first one is a mistake to fix.
 */
export function resolveDoubleEscCancelPolicy(
	options: LoadDoubleEscCancelOptions = {},
): DoubleEscCancelResolution {
	const env = options.env ?? process.env;
	const envValue = env.GENTLE_PI_DOUBLE_ESC_CANCEL;
	let globalFile = "";
	try {
		const configHome = options.gentlePiConfigHome ?? gentlePiConfigHome(env);
		globalFile = join(configHome, DOUBLE_ESC_CANCEL_FILE);
		const globalFileExists = existsSync(globalFile);
		if (globalFileExists) {
			let decoded: DoubleEscCancelPolicy | undefined;
			try {
				decoded = parseDoubleEscCancelPolicyFile(readFileSync(globalFile, "utf8"));
			} catch {
				// Unreadable is indistinguishable from unusable at this layer, and
				// both must fail closed on the file that claimed the decision.
				decoded = undefined;
			}
			return decoded === undefined
				? { policy: "off", source: "global_file", malformed: true, globalFile, globalFileExists, envValue }
				: { policy: decoded, source: "global_file", malformed: false, globalFile, globalFileExists, envValue };
		}
		if (envValue === "on" || envValue === "off") {
			return { policy: envValue, source: "environment", malformed: false, globalFile, globalFileExists, envValue };
		}
		return { policy: "off", source: "default", malformed: false, globalFile, globalFileExists, envValue };
	} catch {
		return { policy: "off", source: "default", malformed: false, globalFile, globalFileExists: false, envValue };
	}
}

/**
 * The effective policy alone, for callers that do not report a source.
 * It delegates so the loader and the resolver can never disagree.
 */
export function loadDoubleEscCancelPolicy(options: LoadDoubleEscCancelOptions = {}): DoubleEscCancelPolicy {
	return resolveDoubleEscCancelPolicy(options).policy;
}

/**
 * Write the global policy file, creating the config home when needed.
 * Used by both `/gentle:double-esc-cancel enable` and `... disable`.
 */
export function writeDoubleEscCancelPolicy(
	policy: DoubleEscCancelPolicy,
	options: { gentlePiConfigHome?: string } = {},
): string {
	const configHome = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(configHome, DOUBLE_ESC_CANCEL_FILE);
	mkdirSync(configHome, { recursive: true });
	writeFileSync(path, `${JSON.stringify({ schema: DOUBLE_ESC_CANCEL_SCHEMA, policy }, null, 2)}\n`);
	return path;
}
