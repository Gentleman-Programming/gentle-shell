import { randomUUID } from "node:crypto";
import { constants as fsConstants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";
import { ANIMATION_POLICY, type AnimationPolicy } from "./animation-policy.ts";
import { isVisualSettings, type VisualSettings } from "./visual-customization-policy.ts";
import type { BannerConfig } from "../extensions/startup-banner.ts";

export const VISUAL_PROFILES_SCHEMA = "gentle-pi.visual-profiles/v1";
const MAX_BYTES = 256_000;
const MAX_PROFILES = 64;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
// O_NOFOLLOW hardens the open against a symlink swapped in between the lstat check below and
// the open call (TOCTOU) on platforms that support it. It is unavailable on Windows, where the
// pre-open lstat check is the only symlink guard and a race window remains: a symlink swapped in
// after the lstat check but before open would still be followed there.
const READ_FLAGS = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW : fsConstants.O_RDONLY;

export interface VisualProfileValues {
	themeName: string;
	animationPolicy: AnimationPolicy;
	banner: BannerConfig;
	visual: VisualSettings;
}

export interface VisualProfile extends VisualProfileValues {
	name: string;
}

interface Options {
	gentlePiConfigHome?: string;
	replace?: boolean;
}

export interface VisualProfilesResolution {
	profiles: VisualProfile[];
	source: "global_file" | "default";
	malformed: boolean;
	readError: boolean;
	globalFile: string;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

function valid(v: unknown): v is VisualProfile {
	if (!record(v) || !exact(v, ["name", "themeName", "animationPolicy", "banner", "visual"])) {
		return false;
	}
	const b = v.banner;
	return (
		typeof v.name === "string" &&
		NAME.test(v.name) &&
		typeof v.themeName === "string" &&
		[...v.themeName].length > 0 &&
		[...v.themeName].length <= 128 &&
		v.themeName.trim() === v.themeName &&
		!/[\\/\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(v.themeName) &&
		Object.values(ANIMATION_POLICY).includes(v.animationPolicy as AnimationPolicy) &&
		record(b) &&
		exact(b, ["showRose", "showTextLogo", "color"]) &&
		typeof b.showRose === "boolean" &&
		typeof b.showTextLogo === "boolean" &&
		["pink", "cyan", "yellow", "green"].includes(b.color as string) &&
		isVisualSettings(v.visual)
	);
}

export function parseVisualProfilesFile(raw: string): VisualProfile[] | undefined {
	if (Buffer.byteLength(raw) > MAX_BYTES) {
		return undefined;
	}
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!record(value) ||
			!exact(value, ["schema", "profiles"]) ||
			value.schema !== VISUAL_PROFILES_SCHEMA ||
			!Array.isArray(value.profiles) ||
			value.profiles.length > MAX_PROFILES
		) {
			return undefined;
		}
		const names = new Set<string>();
		for (const profile of value.profiles) {
			if (!valid(profile) || names.has(profile.name)) {
				return undefined;
			}
			names.add(profile.name);
		}
		return value.profiles as VisualProfile[];
	} catch {
		return undefined;
	}
}

export function readVisualProfiles(options: Options = {}): VisualProfilesResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "visual-profiles.json");
	let fd: number | undefined;
	try {
		try {
			// Platform-independent guard: reject a symlink (or other non-regular entry) before opening
			// it, so the check applies even where O_NOFOLLOW is unavailable (Windows).
			const lst = lstatSync(globalFile);
			if (!lst.isFile()) {
				return { profiles: [], source: "global_file", malformed: false, readError: true, globalFile };
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return { profiles: [], source: "global_file", malformed: false, readError: true, globalFile };
			}
		}
		fd = openSync(globalFile, READ_FLAGS);
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			return { profiles: [], source: "global_file", malformed: false, readError: true, globalFile };
		}
		if (stat.size > MAX_BYTES) {
			return { profiles: [], source: "global_file", malformed: true, readError: false, globalFile };
		}
		const bytes = readFileSync(fd);
		let profiles: VisualProfile[] | undefined;
		if (bytes.length <= MAX_BYTES) {
			try {
				profiles = parseVisualProfilesFile(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			} catch {
				/* Malformed UTF-8. */
			}
		}
		return { profiles: profiles ?? [], source: "global_file", malformed: profiles === undefined, readError: false, globalFile };
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		return { profiles: [], source: missing ? "default" : "global_file", malformed: false, readError: !missing, globalFile };
	} finally {
		if (fd !== undefined) {
			closeSync(fd);
		}
	}
}

function existing(options: Options): VisualProfile[] {
	const result = readVisualProfiles(options);
	if (result.readError || result.malformed) {
		throw new Error(`Cannot edit unreadable or malformed visual profiles: ${result.globalFile}`);
	}
	return result.profiles;
}

function write(profiles: VisualProfile[], options: Options): string {
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(home, "visual-profiles.json");
	const data = `${JSON.stringify({ schema: VISUAL_PROFILES_SCHEMA, profiles })}\n`;
	if (Buffer.byteLength(data) > MAX_BYTES) {
		throw new RangeError("Visual profiles exceed 256 KB.");
	}
	mkdirSync(home, { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try {
			unlinkSync(temporary);
		} catch {
			/* Already renamed. */
		}
	}
	return path;
}

export function listVisualProfiles(options: Options = {}): string[] {
	return existing(options)
		.map(p => p.name)
		.sort();
}

export function getVisualProfile(name: string, options: Options = {}): VisualProfile | undefined {
	if (!NAME.test(name)) {
		throw new TypeError("Invalid visual profile name.");
	}
	const profile = existing(options).find(p => p.name === name);
	return profile && structuredClone(profile);
}

export function saveVisualProfile(name: string, values: VisualProfileValues, options: Options = {}): string {
	const profile = { name, ...values };
	if (!valid(profile)) {
		throw new TypeError("Invalid visual profile name or settings.");
	}
	const profiles = existing(options);
	const index = profiles.findIndex(p => p.name === name);
	if (index >= 0 && !options.replace) {
		throw new Error(`Visual profile ${name} already exists; specify replace: true.`);
	}
	if (index < 0 && profiles.length >= MAX_PROFILES) {
		throw new RangeError("Too many visual profiles.");
	}
	if (index < 0) {
		profiles.push(structuredClone(profile));
	} else {
		profiles[index] = structuredClone(profile);
	}
	return write(profiles, options);
}

export function deleteVisualProfile(name: string, options: Options = {}): string {
	if (!NAME.test(name)) {
		throw new TypeError("Invalid visual profile name.");
	}
	const profiles = existing(options);
	const index = profiles.findIndex(p => p.name === name);
	if (index < 0) {
		throw new Error(`Visual profile ${name} not found.`);
	}
	profiles.splice(index, 1);
	return write(profiles, options);
}

export function resetVisualProfiles(options: Options = {}): string {
	existing(options);
	return write([], options);
}
