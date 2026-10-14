import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export type PermissionMode = "normal" | "auto" | "yolo";
export const PERMISSION_MODE_SCHEMA = "gentle-pi.permission-mode/v1";
export interface PermissionModeOptions { gentlePiConfigHome?: string }
export interface PermissionModeResolution {
	mode: PermissionMode;
	malformed: boolean;
	source: "global_file" | "default";
	globalFile: string;
}
export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "normal" || value === "auto" || value === "yolo";
}
/** Never consult merged Pi settings or repository configuration. */
export function permissionModePolicyFile(options: PermissionModeOptions = {}): string {
	return join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "permission-mode.json");
}
export const permissionModePolicyPath = permissionModePolicyFile;
export function parsePermissionModePolicyFile(raw: string): PermissionMode | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) return undefined;
		if (!("schema" in value) || value.schema !== PERMISSION_MODE_SCHEMA || !("mode" in value)) return undefined;
		return isPermissionMode(value.mode) ? value.mode : undefined;
	} catch { return undefined; }
}
export function resolvePermissionModePolicy(options: PermissionModeOptions = {}): PermissionModeResolution {
	const globalFile = permissionModePolicyFile(options);
	try {
		const mode = parsePermissionModePolicyFile(readFileSync(globalFile, "utf8"));
		return { mode: mode ?? "normal", malformed: mode === undefined, source: "global_file", globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { mode: "normal", malformed: !missing, source: missing ? "default" : "global_file", globalFile };
	}
}
/** Private same-directory atomic replacement; malformed/unreadable preferences require human repair. */
export function writePermissionModePolicy(mode: PermissionMode, options: PermissionModeOptions = {}): string {
	if (!isPermissionMode(mode)) throw new Error("Invalid permission mode");
	const resolution = resolvePermissionModePolicy(options);
	if (resolution.malformed) throw new Error("Permission mode preference is malformed or unreadable; repair it before saving.");
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = resolution.globalFile;
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: PERMISSION_MODE_SCHEMA, mode })}\n`, { flag: "wx", mode: 0o600 });
		// Recheck immediately before replacing: never silently repair an invalid file.
		if (resolvePermissionModePolicy(options).malformed) throw new Error("Permission mode preference changed or is unreadable.");
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename already consumed it. */ }
	}
	return path;
}
