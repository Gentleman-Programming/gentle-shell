import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export const TPS_SETTINGS_SCHEMA = "gentle-pi.tps/v1";

export interface Tps {
	enabled: boolean;
}

export const DEFAULT_TPS_SETTINGS: Tps = Object.freeze({ enabled: true });

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact shape: only `enabled`, only boolean. Unknown keys invalidate the file, like notifications. */
export function isTpsSettings(value: unknown): value is Tps {
	return record(value) && Object.keys(value).length === 1 && typeof value.enabled === "boolean";
}

/** Never merge defaults on read: a stored file states the whole payload. */
export function parseTpsSettingsFile(raw: string): Tps | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (!record(value) || value.schema !== TPS_SETTINGS_SCHEMA) return undefined;
		const { schema: _schema, ...settings } = value;
		return isTpsSettings(settings) ? settings : undefined;
	} catch {
		return undefined;
	}
}

export interface TpsResolution {
	settings: Tps;
	source: "global_file" | "default";
	malformed: boolean;
	readError: boolean;
	globalFile: string;
}

export function tpsSettingsPath(configHome: string): string {
	return join(configHome, "tps.json");
}

export function resolveTpsSettings(options: { gentlePiConfigHome?: string } = {}): TpsResolution {
	const globalFile = tpsSettingsPath(options.gentlePiConfigHome || gentlePiConfigHome());
	try {
		const settings = parseTpsSettingsFile(readFileSync(globalFile, "utf8"));
		// A malformed existing file still counts as a file source: the caller decides
		// whether to replace it, exactly like notifications.
		return settings === undefined
			? { settings: structuredClone(DEFAULT_TPS_SETTINGS), source: "global_file", malformed: true, readError: false, globalFile }
			: { settings, source: "global_file", malformed: false, readError: false, globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		if (missing) return { settings: structuredClone(DEFAULT_TPS_SETTINGS), source: "default", malformed: false, readError: false, globalFile };
		return { settings: structuredClone(DEFAULT_TPS_SETTINGS), source: "global_file", malformed: false, readError: true, globalFile };
	}
}

/** Explicit persistence; caller owns malformed-file replacement consent as in notifications. */
export function writeTpsSettings(settings: Tps, options: { gentlePiConfigHome?: string } = {}): string {
	if (!isTpsSettings(settings)) throw new TypeError("Invalid TPS settings");
	const configHome = options.gentlePiConfigHome || gentlePiConfigHome();
	const path = tpsSettingsPath(configHome);
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(configHome, { recursive: true });
	let created = false;
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: TPS_SETTINGS_SCHEMA, ...settings }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		created = true;
		renameSync(temporary, path);
	} finally {
		if (created) {
			try {
				unlinkSync(temporary);
			} catch {
				// Rename consumed the temp file; nothing to clean.
			}
		}
	}
	return path;
}
