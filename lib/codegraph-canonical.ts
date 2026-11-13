import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The platform whose path rules apply; tests inject "win32" to exercise folding off Windows. */
export type CanonicalPlatform = typeof process.platform;

/** A backslash without a backslash literal, so this file never mangles in tool transport. */
const BS = String.fromCharCode(92);

/** A bare drive root (`C:` plus one separator): its separator IS the path, so folding keeps it. */
function isDriveRoot(path: string): boolean {
	return path.length === 3 && path.charCodeAt(1) === 58 && (path.endsWith(BS) || path.endsWith("/"));
}

/**
 * The true path on disk with fallbacks, never throwing: the native realpath first (on Windows it
 * maps a mapped drive to its UNC target and returns the on-disk casing), the portable one next,
 * and a nearest-resolvable-parent walk last, so a missing or unreadable tail keeps the longest
 * resolvable prefix instead of failing the caller.
 */
export function unfoldRoot(path: string): string {
	try {
		return realpathSync.native(path);
	} catch { /* try the portable resolver */ }
	try {
		return realpathSync(path);
	} catch { /* walk up to the nearest resolvable parent */ }
	const parent = dirname(path);
	if (parent === path) return path;
	return join(unfoldRoot(parent), basename(path));
}

/** Folds one real path into one comparison key: lowercased on Windows, trailing separators removed. */
export function foldRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	if (platform !== "win32") return path;
	let out = path.toLowerCase();
	while ((out.endsWith(BS) || out.endsWith("/")) && !isDriveRoot(out)) out = out.slice(0, -1);
	return out;
}

/** One directory in any spelling folds to one key: same directory, same daemon, same lock token. */
export function canonicalRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	return foldRoot(unfoldRoot(resolve(path)), platform);
}
