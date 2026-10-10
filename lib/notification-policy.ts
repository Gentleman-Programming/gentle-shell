import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";
import type { TaskStatus } from "./agents-protocol.ts";

export const NOTIFICATION_SCHEMA = "gentle-shell.notifications/v1";
/** Contract vocabulary, NOT proof of runtime support. Adapters must verify producers before UI exposure. */
const SUBAGENT_STATUSES = ["queued", "running", "waiting", "completed", "failed", "cancelled", "timed_out"] as const satisfies readonly TaskStatus[];
export type NotificationEvent = "session.started" | "session.shutdown"
	| `agent.${"started" | "completed" | "failed" | "cancelled" | "attention"}` | `subagent.${TaskStatus}`;
export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
	"session.started", "session.shutdown", "agent.started", "agent.completed", "agent.failed", "agent.cancelled", "agent.attention",
	...SUBAGENT_STATUSES.map(status => `subagent.${status}` as const),
];
export const BUILTIN_NOTIFICATION_IDS = ["success", "error", "attention"] as const;
export type NotificationSound = `builtin:${typeof BUILTIN_NOTIFICATION_IDS[number]}` | `file:${string}` | null;
/** Priority belongs to the event, never the selected sound. waiting does not imply attention. */
export const NOTIFICATION_PRIORITY: Readonly<Record<NotificationEvent, number>> = Object.fromEntries(
	NOTIFICATION_EVENTS.map(event => [event, event.endsWith(".failed") || event.endsWith(".timed_out") ? 3
		: event === "agent.attention" ? 2 : event.endsWith(".completed") ? 1 : 0]),
) as Record<NotificationEvent, number>;
/** Integer milliseconds, inclusive bounds. Zero permits disabling a timing window. TTL belongs to scheduler. */
export const NOTIFICATION_TIMING_LIMITS = {
	minimumIntervalMs: { min: 0, max: 60000 },
	coalesceWindowMs: { min: 0, max: 2000 },
} as const;
export interface NotificationSettings {
	enabled: boolean;
	audio: {
		backend: "auto";
		minimumIntervalMs: number;
		coalesceWindowMs: number;
		events: Partial<Record<NotificationEvent, NotificationSound>>;
	};
}
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = Object.freeze({
	enabled: false,
	audio: Object.freeze({
		backend: "auto" as const, minimumIntervalMs: 1000, coalesceWindowMs: 300,
		events: Object.freeze(Object.fromEntries(NOTIFICATION_EVENTS.map(event => [event,
			NOTIFICATION_PRIORITY[event] === 3 ? "builtin:error" : NOTIFICATION_PRIORITY[event] === 2 ? "builtin:attention"
				: NOTIFICATION_PRIORITY[event] === 1 ? "builtin:success" : null]))),
	}),
});
export type NotificationPathFlavor = "posix" | "win32";
export interface NotificationIO {
	readFile(path: string): string;
	mkdir(path: string): void;
	writeFile(path: string, content: string, options: { flag: "wx"; mode: number }): void;
	rename(from: string, to: string): void;
	unlink(path: string): void;
}
export interface NotificationOptions {
	gentlePiConfigHome?: string;
	pathFlavor?: NotificationPathFlavor;
	io?: NotificationIO;
}
export interface NotificationResolution {
	settings: NotificationSettings;
	source: "global_file" | "default";
	malformed: boolean;
	readError: boolean;
	globalFile: string;
}
const DEFAULT_IO: NotificationIO = {
	readFile: path => readFileSync(path, "utf8"),
	mkdir: path => { mkdirSync(path, { recursive: true }); },
	writeFile: (path, content, options) => writeFileSync(path, content, options),
	rename: renameSync, unlink: unlinkSync,
};
const nativeFlavor: NotificationPathFlavor = process.platform === "win32" ? "win32" : "posix";
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keysMatch(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** Syntax validation only: no stat, WAV parsing or backend detection. No expansion is ever performed. */
export function isNotificationSound(value: unknown, flavor: NotificationPathFlavor = nativeFlavor): value is NotificationSound {
	if (value === null) return true;
	if (typeof value !== "string") return false;
	if (BUILTIN_NOTIFICATION_IDS.some(id => value === `builtin:${id}`)) return true;
	if (!value.startsWith("file:")) return false;
	const path = value.slice(5);
	if (!path || /[\x00-\x1f\x7f$`]|%[^%]+%/.test(path) || path.includes("://")) return false;
	// No network URLs/UNC/device paths, drive-relative paths or shell-home aliases.
	return flavor === "win32"
		? /^[A-Za-z]:[\\/]/.test(path) && win32.isAbsolute(path) && !path.slice(2).includes(":")
		: posix.isAbsolute(path) && !path.startsWith("//");
}
export function isNotificationSettings(value: unknown, flavor: NotificationPathFlavor = nativeFlavor): value is NotificationSettings {
	if (!record(value) || !keysMatch(value, ["enabled", "audio"]) || typeof value.enabled !== "boolean") return false;
	const audio = value.audio;
	if (!record(audio) || !keysMatch(audio, ["backend", "minimumIntervalMs", "coalesceWindowMs", "events"]) || audio.backend !== "auto") return false;
	for (const key of ["minimumIntervalMs", "coalesceWindowMs"] as const) {
		const timing = audio[key]; const { min, max } = NOTIFICATION_TIMING_LIMITS[key];
		if (typeof timing !== "number" || !Number.isInteger(timing) || timing < min || timing > max) return false;
	}
	return record(audio.events) && Object.entries(audio.events).every(([event, sound]) =>
		NOTIFICATION_EVENTS.includes(event as NotificationEvent) && isNotificationSound(sound, flavor));
}
/** Never merge the preset on read: missing event keys remain silent, including future additions. */
export function parseNotificationSettingsFile(raw: string, flavor: NotificationPathFlavor = nativeFlavor): NotificationSettings | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (!record(value) || value.schema !== NOTIFICATION_SCHEMA) return undefined;
		const { schema: _schema, ...settings } = value;
		return isNotificationSettings(settings, flavor) ? settings : undefined;
	} catch { return undefined; }
}
export function notificationSoundFor(settings: NotificationSettings, event: NotificationEvent): NotificationSound {
	return settings.audio.events[event] ?? null;
}
/** Explicit user action only; enabled is preserved, even when currently disabled. */
export function restoreNotificationPreset(settings: NotificationSettings): NotificationSettings {
	return { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), enabled: settings.enabled };
}
export function resolveNotificationSettings(options: NotificationOptions = {}): NotificationResolution {
	const globalFile = join(options.gentlePiConfigHome || gentlePiConfigHome(), "notifications.json");
	try {
		const settings = parseNotificationSettingsFile((options.io ?? DEFAULT_IO).readFile(globalFile), options.pathFlavor);
		return { settings: settings ?? structuredClone(DEFAULT_NOTIFICATION_SETTINGS), source: "global_file", malformed: settings === undefined, readError: false, globalFile };
	} catch (error) {
		const missing = record(error) && error.code === "ENOENT";
		return { settings: structuredClone(DEFAULT_NOTIFICATION_SETTINGS), source: missing ? "default" : "global_file", malformed: false, readError: !missing, globalFile };
	}
}
/** Explicit persistence operation; caller owns confirmation before replacing malformed/unreadable config. */
export function writeNotificationSettings(settings: NotificationSettings, options: NotificationOptions = {}): string {
	if (!isNotificationSettings(settings, options.pathFlavor)) throw new TypeError("Invalid notification settings");
	const io = options.io ?? DEFAULT_IO;
	const home = options.gentlePiConfigHome || gentlePiConfigHome();
	const path = join(home, "notifications.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	io.mkdir(home);
	let created = false;
	try {
		io.writeFile(temporary, `${JSON.stringify({ schema: NOTIFICATION_SCHEMA, ...settings })}\n`, { flag: "wx", mode: 0o600 });
		created = true;
		io.rename(temporary, path);
	} finally {
		if (created) { try { io.unlink(temporary); } catch { /* Rename consumed it; preserve original IO error. */ } }
	}
	return path;
}
