import { randomUUID } from "node:crypto";
import { join, win32 } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";
import {
	DEFAULT_IO, isNotificationSound, nativeFlavor,
	type NotificationIO, type NotificationOptions, type NotificationPathFlavor,
} from "./notification-policy.ts";

/**
 * Saved sounds are the user's own palette: `/gentle:customize` → Notifications keeps an `f` field, and the list
 * written here is what each row's `Enter` cycle walks in addition to silence and the included tones. It lives in
 * its own file on purpose: `notifications.json` validates its keys exactly, so a library key inside `audio`
 * would make every build that does not know it classify the audio configuration as malformed.
 */
export const SAVED_SOUNDS_SCHEMA = "gentle-shell.notification-sounds/v1";
/**
 * Bounded because the cycle is `silence → builtins → saved sounds`: a longer list turns cycling into a chore.
 * A full library refuses a new sound instead of dropping one the user deliberately saved.
 */
export const MAX_SAVED_SOUNDS = 8;

/** One saved sound. It stays an object so per-sound metadata can be added later without a format change. */
export interface SavedSound { path: string }
export interface SavedSoundsResolution {
	sounds: SavedSound[];
	malformed: boolean;
	readError: boolean;
	file: string;
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keysMatch(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/**
 * Canonical comparison key only; a stored entry always keeps the user's own spelling. Windows paths are
 * case-insensitive and both separators address one file, so the separator is normalized before folding.
 */
export function savedSoundKey(path: string, flavor: NotificationPathFlavor = nativeFlavor): string {
	return flavor === "win32" ? win32.normalize(path).toLowerCase() : path;
}
/** Storage validation: the path header is the same policy the sound assignments use, with no extra keys. */
export function isSavedSound(value: unknown, flavor: NotificationPathFlavor = nativeFlavor): value is SavedSound {
	return record(value) && keysMatch(value, ["path"])
		&& typeof value.path === "string" && isNotificationSound(`file:${value.path}`, flavor);
}
/** Strict parse: unknown schema, extra keys and invalid paths invalidate the whole file rather than being dropped. */
export function parseSavedSoundsFile(raw: string, flavor: NotificationPathFlavor = nativeFlavor): SavedSound[] | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (!record(value) || value.schema !== SAVED_SOUNDS_SCHEMA) return undefined;
		const { schema: _schema, ...rest } = value;
		if (!keysMatch(rest, ["sounds"]) || !Array.isArray(rest.sounds)) return undefined;
		return rest.sounds.every(entry => isSavedSound(entry, flavor)) ? rest.sounds.map(entry => ({ path: (entry as SavedSound).path })) : undefined;
	} catch { return undefined; }
}
/** A missing file is an empty library: it is never created by a read and never warns. */
export function resolveSavedSounds(options: NotificationOptions = {}): SavedSoundsResolution {
	const file = join(options.gentlePiConfigHome || gentlePiConfigHome(), "notifications-sounds.json");
	try {
		const sounds = parseSavedSoundsFile((options.io ?? DEFAULT_IO).readFile(file), options.pathFlavor);
		return { sounds: sounds ?? [], malformed: sounds === undefined, readError: false, file };
	} catch (error) {
		const missing = record(error) && error.code === "ENOENT";
		return { sounds: [], malformed: false, readError: !missing, file };
	}
}
export function hasSavedSound(sounds: readonly SavedSound[], path: string, flavor: NotificationPathFlavor = nativeFlavor): boolean {
	const key = savedSoundKey(path, flavor);
	return sounds.some(sound => savedSoundKey(sound.path, flavor) === key);
}
/**
 * Pure insert: appends the user's own spelling, keeps one entry per file, and returns `undefined` when the
 * library is full so the caller can report it instead of the sound disappearing from the list.
 */
export function addSavedSound(sounds: readonly SavedSound[], path: string, flavor: NotificationPathFlavor = nativeFlavor): SavedSound[] | undefined {
	if (hasSavedSound(sounds, path, flavor)) return [...sounds];
	return sounds.length >= MAX_SAVED_SOUNDS ? undefined : [...sounds, { path }];
}
/** Explicit persistence operation, atomic like the audio configuration and never a silent replacement. */
export function writeSavedSounds(sounds: readonly SavedSound[], options: NotificationOptions = {}): string {
	if (!Array.isArray(sounds) || !sounds.every(sound => isSavedSound(sound, options.pathFlavor))) throw new TypeError("Invalid saved sounds");
	const io: NotificationIO = options.io ?? DEFAULT_IO;
	const home = options.gentlePiConfigHome || gentlePiConfigHome();
	const path = join(home, "notifications-sounds.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	io.mkdir(home);
	let created = false;
	try {
		io.writeFile(temporary, `${JSON.stringify({ schema: SAVED_SOUNDS_SCHEMA, sounds })}\n`, { flag: "wx", mode: 0o600 });
		created = true;
		io.rename(temporary, path);
	} finally {
		if (created) { try { io.unlink(temporary); } catch { /* Rename consumed it; preserve original IO error. */ } }
	}
	return path;
}
