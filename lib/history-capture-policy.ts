import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// Prompt history capture is default-off. An explicit GENTLE_PI_HISTORY_CAPTURE
// value wins, then the Gentle → Customize preference, then off. Any missing,
// malformed or unreadable preference fails closed. Turning capture off only
// stops new captures; stored history is never deleted here.
export const HISTORY_CAPTURE_POLICY = { ON: "on", OFF: "off" } as const;
export type HistoryCapturePolicy = (typeof HISTORY_CAPTURE_POLICY)[keyof typeof HISTORY_CAPTURE_POLICY];
export const HISTORY_CAPTURE_SCHEMA = "gentle-pi.history-capture/v1";
export const HISTORY_CAPTURE_ENV = "GENTLE_PI_HISTORY_CAPTURE";
interface HistoryCaptureOptions { gentlePiConfigHome?: string }
export interface HistoryCapturePolicyResolution {
	policy: HistoryCapturePolicy;
	source: "global_file" | "default";
	malformed: boolean;
	globalFile: string;
}
export interface HistoryCaptureResolution {
	enabled: boolean;
	source: "env" | "global_file" | "default";
	/** The persisted Customize preference, reported even while the env overrides it. */
	preference: HistoryCapturePolicy;
	envOverride: HistoryCapturePolicy | undefined;
	malformed: boolean;
	globalFile: string;
}

/** Only explicit on/off values override; anything else defers to the preference. */
export function historyCaptureEnvOverride(env: NodeJS.ProcessEnv = process.env): HistoryCapturePolicy | undefined {
	const value = env[HISTORY_CAPTURE_ENV]?.trim().toLowerCase();
	if (value === "1" || value === "true" || value === "on") return "on";
	if (value === "0" || value === "false" || value === "off") return "off";
	return undefined;
}

export function parseHistoryCaptureFile(raw: string): HistoryCapturePolicy | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (Object.keys(value).length !== 2 || !("schema" in value) || value.schema !== HISTORY_CAPTURE_SCHEMA || !("policy" in value)) return undefined;
		return value.policy === "on" || value.policy === "off" ? value.policy : undefined;
	} catch { return undefined; }
}

export function resolveHistoryCapturePolicy(options: HistoryCaptureOptions = {}): HistoryCapturePolicyResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "history-capture.json");
	try {
		const policy = parseHistoryCaptureFile(readFileSync(globalFile, "utf8"));
		return { policy: policy ?? "off", source: "global_file", malformed: policy === undefined, globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { policy: "off", source: missing ? "default" : "global_file", malformed: !missing, globalFile };
	}
}

/** Full resolution for status surfaces; always reads the preference. */
export function resolveHistoryCapture(options: { env?: NodeJS.ProcessEnv; gentlePiConfigHome?: string } = {}): HistoryCaptureResolution {
	const env = options.env ?? process.env;
	const saved = resolveHistoryCapturePolicy({ gentlePiConfigHome: options.gentlePiConfigHome ?? gentlePiConfigHome(env) });
	const envOverride = historyCaptureEnvOverride(env);
	return {
		enabled: (envOverride ?? saved.policy) === "on",
		source: envOverride ? "env" : saved.source,
		preference: saved.policy,
		envOverride,
		malformed: saved.malformed,
		globalFile: saved.globalFile,
	};
}

/** Per-prompt gate: an explicit env value never reads the preference file. */
export function historyCaptureEnabled(options: { env?: NodeJS.ProcessEnv; gentlePiConfigHome?: string } = {}): boolean {
	const env = options.env ?? process.env;
	const override = historyCaptureEnvOverride(env);
	if (override) return override === "on";
	return resolveHistoryCapturePolicy({ gentlePiConfigHome: options.gentlePiConfigHome ?? gentlePiConfigHome(env) }).policy === "on";
}

export function writeHistoryCapturePolicy(policy: HistoryCapturePolicy, options: HistoryCaptureOptions = {}): string {
	if (policy !== "on" && policy !== "off") throw new TypeError("Invalid history capture policy");
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(home, "history-capture.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: HISTORY_CAPTURE_SCHEMA, policy })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
