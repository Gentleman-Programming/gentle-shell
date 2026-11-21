import { lstatSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The platform whose path rules apply; tests inject "win32" to exercise folding off Windows. */
export type CanonicalPlatform = typeof process.platform;

/** A backslash without a backslash literal, so this file never mangles in tool transport. */
const BS = String.fromCharCode(92);

/** One unfolded form per resolved spelling, win32 only: every realpathSync.native on a UNC path
 * is an SMB round-trip chain, so the daemon registry, the lease paths and the workspace guard pay
 * it once per spelling instead of per call. Each hit is revalidated with metadata stats
 * before use — the alias identity and the canonicality of the recorded target — so a mapping
 * can never outlive the alias it was recorded from, nor a recorded target that became an
 * alias. POSIX never touches it. */
const unfoldedMemo = new Map<string, string>();

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

/** Tests reset the memos so a fixture rewritten between calls is read again; production never calls it. */
export function resetCanonicalMemo(): void {
	unfoldedMemo.clear();
	caseFoldMemo.clear();
}

/** A bare drive root (`C:` plus one separator): its separator IS the path, so folding keeps it. */
function isDriveRoot(path: string): boolean {
	return path.length === 3 && path.charCodeAt(1) === 58 && (path.endsWith(BS) || path.endsWith("/"));
}

/** Whether the spelling still resolves to the identity the memo recorded: the alias's own stat
 * follows today's link, so its dev/ino pair matching the recorded target's proves the mapping
 * survived (a retargeted junction or symlink compares unequal); any stat failure simply
 * re-walks, because validation must never throw. The recorded path must also still be
 * canonical, not a link itself: a target moved away and replaced by a junction to its new
 * home leaves both stats following that junction and comparing equal, yet the recorded
 * spelling is an alias now and a re-walk must pick up the new home. The stats are bigint
 * ones: win32 ino is a 64-bit file ID whose distinct values can round to the same Number,
 * and the cache decision must differ exactly when the identity does. */
function stillResolvesTo(alias: string, recorded: string): boolean {
	try {
		const aliasStat = statSync(alias, { bigint: true });
		const recordedStat = statSync(recorded, { bigint: true });
		if (aliasStat.dev !== recordedStat.dev || aliasStat.ino !== recordedStat.ino) return false;
		return !lstatSync(recorded, { bigint: true }).isSymbolicLink();
	} catch {
		return false;
	}
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
 * per resolved spelling — one SMB round-trip chain per spelling instead of one per call, separator
 * variants sharing one entry — but a remembered mapping is honored only while the spelling still
 * resolves to the identity it was recorded from, so an alias retargeted to another checkout (a
 * junction or symlink flipped mid-session) re-walks instead of pinning lease and daemon identity
 * to the old target. Off Windows every call takes the filesystem walk unchanged and nothing is
 * remembered.
 */
export function unfoldRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	if (platform !== "win32") return unfoldRootOnce(path);
	const key = resolve(path);
	const memoized = unfoldedMemo.get(key);
	if (memoized !== undefined && stillResolvesTo(key, memoized)) return memoized;
	const unfolded = unfoldRootOnce(path);
	unfoldedMemo.set(key, unfolded);
	return unfolded;
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

/** One directory in any spelling folds to one key: same directory, same daemon, same lock token.
 * On win32 the unfold behind the key comes from the spelling-keyed, revalidated memo. */
export function canonicalRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	return foldRoot(unfoldRoot(resolve(path), platform), platform);
}
