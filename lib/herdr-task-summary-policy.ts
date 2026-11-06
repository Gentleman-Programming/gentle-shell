import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export const HERDR_SUMMARY_COLORS = ["accent", "text", "muted", "dim", "success", "warning", "error"] as const;
export type HerdrSummaryColor = (typeof HERDR_SUMMARY_COLORS)[number];
export interface HerdrTaskSummarySettings {
	enabled: boolean;
	summaryColor: HerdrSummaryColor;
	continuationColor: HerdrSummaryColor;
}
export const DEFAULT_HERDR_TASK_SUMMARY_SETTINGS: HerdrTaskSummarySettings = {
	enabled: true, summaryColor: "accent", continuationColor: "muted",
};
export const HERDR_TASK_SUMMARY_SCHEMA = "gentle-pi.herdr-task-summary/v1";
export const HERDR_TASK_SUMMARY_CHANGED = "gentle-pi:herdr-task-summary:changed";
export interface HerdrTaskSummaryChanged { configHome: string }
export interface HerdrTaskSummaryOptions { gentlePiConfigHome?: string }
export interface HerdrTaskSummaryResolution {
	settings: HerdrTaskSummarySettings;
	malformed: boolean;
	readError: boolean;
	globalFile: string;
	source: "global_file" | "default";
}

export function isHerdrTaskSummarySettings(value: unknown): value is HerdrTaskSummarySettings {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const settings = value as Record<string, unknown>;
	return Object.keys(settings).length === 3 && Object.hasOwn(settings, "enabled")
		&& Object.hasOwn(settings, "summaryColor") && Object.hasOwn(settings, "continuationColor")
		&& typeof settings.enabled === "boolean"
		&& HERDR_SUMMARY_COLORS.includes(settings.summaryColor as HerdrSummaryColor)
		&& HERDR_SUMMARY_COLORS.includes(settings.continuationColor as HerdrSummaryColor);
}

export function resolveHerdrTaskSummarySettings(options: HerdrTaskSummaryOptions = {}): HerdrTaskSummaryResolution {
	const globalFile = join(resolve(options.gentlePiConfigHome ?? gentlePiConfigHome()), "herdr-task-summary.json");
	const fallback = { settings: { ...DEFAULT_HERDR_TASK_SUMMARY_SETTINGS }, globalFile };
	let fd: number | undefined;
	try {
		// Nonblocking, bounded reads reject directories, FIFOs and oversized files.
		fd = openSync(globalFile, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 4096) throw new Error("Unsupported Herdr settings file");
		const buffer = Buffer.alloc(4097);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		if (length > 4096) throw new Error("Oversized Herdr settings file");
		let settings: HerdrTaskSummarySettings | undefined;
		try {
			const value: unknown = JSON.parse(buffer.toString("utf8", 0, length));
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				const { schema, ...candidate } = value as Record<string, unknown>;
				if (schema === HERDR_TASK_SUMMARY_SCHEMA && isHerdrTaskSummarySettings(candidate)) settings = candidate;
			}
		} catch { /* Invalid JSON is malformed, not a read failure. */ }
		return { ...fallback, settings: settings ?? fallback.settings, malformed: !settings, readError: false, source: "global_file" };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { ...fallback, malformed: false, readError: !missing, source: missing ? "default" : "global_file" };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Validate both the new value and the existing store before atomic replacement. */
export function writeHerdrTaskSummarySettings(settings: HerdrTaskSummarySettings, options: HerdrTaskSummaryOptions = {}): string {
	if (!isHerdrTaskSummarySettings(settings)) throw new TypeError("Invalid Herdr task summary settings");
	const current = resolveHerdrTaskSummarySettings(options);
	if (current.malformed || current.readError) throw new Error("Refusing to overwrite unreadable or malformed Herdr task summary settings");
	const path = current.globalFile;
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(resolve(path, ".."), { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: HERDR_TASK_SUMMARY_SCHEMA, ...settings })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		// This writer owns the temporary file; never leave one behind per failed attempt.
		// Cleanup is best effort and never masks the original write or rename error.
		try { rmSync(temporary, { force: true }); } catch { /* keep the original error */ }
		throw error;
	}
	return path;
}
