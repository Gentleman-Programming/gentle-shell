import { realpathSync, statSync, type BigIntStats } from "node:fs";
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

/** One cached case-fold decision anchored to the base directory's identity at record time: a
 * hit is honored only while the spelling still stats to the recorded dev/ino pair, so a
 * checkout removed and recreated — the only way a tree's case sensitivity can change, since
 * Windows flips it per empty directory — re-probes instead of folding with the replaced
 * tree's answer. The identity is absent when the base did not resolve at record time, so
 * every hit of an unresolvable spelling re-probes until it does. */
interface CaseFoldEntry {
	folds: boolean;
	dev?: bigint;
	ino?: bigint;
}

const caseFoldMemo = new Map<string, CaseFoldEntry>();

/** Tests reset the memo so a fixture rewritten between calls is read again; production never calls it. */
export function resetCanonicalMemo(): void {
	caseFoldMemo.clear();
}

/** One path component with every cased letter swapped, or undefined when it carries no case. */
function flippedCase(component: string): string | undefined {
	let out = "";
	let changed = false;
	for (const char of component) {
		const lower = char.toLowerCase();
		const upper = char.toUpperCase();
		if (lower === upper) out += char;
		else {
			out += char === lower ? upper : lower;
			changed = true;
		}
	}
	return changed ? out : undefined;
}

/** Whether path still names the directory a case-fold decision was recorded from: a matching
 * dev/ino pair proves the probe walked the same tree; a stat failure or a different pair
 * means the directory was replaced and the decision must be re-probed. Validation never
 * throws, and an entry without an identity never validates, so it re-probes until the
 * spelling resolves. */
function stillSameDirectory(path: string, entry: CaseFoldEntry): boolean {
	if (entry.dev === undefined || entry.ino === undefined) return false;
	try {
		const own = statSync(path, { bigint: true });
		return own.dev === entry.dev && own.ino === entry.ino;
	} catch {
		return false;
	}
}

/** Whether the directory tree at path folds letter case the way stock NTFS does. Windows also
 * allows per-directory case sensitivity, where a differently-cased spelling names a different
 * directory or nothing at all; folding such a tree would merge two distinct checkouts into one
 * lease and daemon key. The base identity is compared against one case-flipped spelling per
 * component, so any component whose flip stops matching proves the tree distinguishes case; an
 * unresolvable base has nothing to distinguish and keeps folding. The decision is remembered
 * per path but honored only while the base directory still stats to the identity recorded
 * with it (see stillSameDirectory), so a replaced checkout re-probes. */
function win32FoldsCase(path: string): boolean {
	const memoized = caseFoldMemo.get(path);
	if (memoized !== undefined && stillSameDirectory(path, memoized)) return memoized.folds;
	let folds = true;
	let dev: bigint | undefined;
	let ino: bigint | undefined;
	try {
		try {
			const own = statSync(path, { bigint: true });
			dev = own.dev;
			ino = own.ino;
		} catch {
			// An unresolvable base carries no identity to anchor; the walk below still decides.
		}
		let rest = path;
		for (;;) {
			const parent = dirname(rest);
			if (parent === rest) break;
			const flipped = flippedCase(basename(rest));
			if (flipped !== undefined) {
				let own: BigIntStats | undefined;
				try {
					own = statSync(rest, { bigint: true });
				} catch {
					// A component that does not resolve (the probe may run on a missing tail)
					// carries nothing to distinguish; a deeper resolvable level still decides.
				}
				if (own !== undefined) {
					try {
						const variant = statSync(join(parent, flipped), { bigint: true });
						if (own.dev !== variant.dev || own.ino !== variant.ino) folds = false;
					} catch {
						folds = false;
					}
				}
			}
			rest = parent;
		}
	} catch {
		folds = true;
	}
	caseFoldMemo.set(path, { folds, dev, ino });
	return folds;
}
/** Folds one real path into one comparison key: on Windows a case-insensitive tree lowercases
 * and drops trailing separators, while a case-sensitive Windows directory keeps its on-disk
 * casing so distinct checkouts stay distinct keys; off Windows the path passes through. */
export function foldRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	if (platform !== "win32") return path;
	let out = path;
	while ((out.endsWith(BS) || out.endsWith("/")) && !isDriveRoot(out)) out = out.slice(0, -1);
	return win32FoldsCase(out) ? out.toLowerCase() : out;
}

/** One directory in any spelling folds to one key: same directory, same daemon, same lock token. */
export function canonicalRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	return foldRoot(unfoldRoot(resolve(path)), platform);
}
