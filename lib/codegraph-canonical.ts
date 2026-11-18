import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The platform whose path rules apply; tests inject "win32" to exercise folding off Windows. */
export type CanonicalPlatform = typeof process.platform;

/** A backslash without a backslash literal, so this file never mangles in tool transport. */
const BS = String.fromCharCode(92);

/** One unfolded form per resolved spelling for the process's lifetime, win32 only: every
 * realpathSync.native on a UNC path is an SMB round-trip chain, so the daemon registry, the lease
 * paths and the workspace guard pay it once per spelling instead of per call. POSIX never touches it. */
const unfoldedMemo = new Map<string, string>();

/** Tests reset the memo so a fixture rewritten between calls is read again; production never calls it. */
export function resetCanonicalMemo(): void {
	unfoldedMemo.clear();
}

/** A bare drive root (`C:` plus one separator): its separator IS the path, so folding keeps it. */
function isDriveRoot(path: string): boolean {
	return path.length === 3 && path.charCodeAt(1) === 58 && (path.endsWith(BS) || path.endsWith("/"));
}

/** The filesystem walk behind unfoldRoot, without the memo: the native realpath first (on Windows it
 * maps a mapped drive to its UNC target and returns the on-disk casing), the portable one next, and a
 * nearest-resolvable-parent walk last, so a missing or unreadable tail keeps the longest resolvable
 * prefix instead of failing the caller. */
function unfoldRootOnce(path: string): string {
	try {
		return realpathSync.native(path);
	} catch { /* try the portable resolver */ }
	try {
		return realpathSync(path);
	} catch { /* walk up to the nearest resolvable parent */ }
	const parent = dirname(path);
	if (parent === path) return path;
	return join(unfoldRootOnce(parent), basename(path));
}

/**
 * The true path on disk with fallbacks, never throwing. On Windows the unfolded form is remembered
 * for the process's lifetime — one SMB round-trip chain per spelling instead of one per call — keyed
 * by the resolved spelling, so separator variants share one entry. Off Windows every call takes the
 * filesystem walk unchanged and nothing is remembered.
 */
export function unfoldRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	if (platform !== "win32") return unfoldRootOnce(path);
	const key = resolve(path);
	const memoized = unfoldedMemo.get(key);
	if (memoized !== undefined) return memoized;
	const unfolded = unfoldRootOnce(path);
	unfoldedMemo.set(key, unfolded);
	return unfolded;
}

/** Folds one real path into one comparison key: lowercased on Windows, trailing separators removed. */
export function foldRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	if (platform !== "win32") return path;
	let out = path.toLowerCase();
	while ((out.endsWith(BS) || out.endsWith("/")) && !isDriveRoot(out)) out = out.slice(0, -1);
	return out;
}

/** One directory in any spelling folds to one key: same directory, same daemon, same lock token.
 * On win32 the unfold behind the key comes from the process-lifetime memo. */
export function canonicalRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	return foldRoot(unfoldRoot(resolve(path), platform), platform);
}
