// YOLO temp-scratch waiver: a recursive `rm` whose every literal target is the
// session's own scratch under a temp root needs no data-loss confirmation.
// Pure over an injectable filesystem view so tests never touch real paths.
// Callers own the policy gate: primary session with active YOLO only.
import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { posix } from "node:path";
import type { DestructiveCommandMatch } from "./destructive-command-guard.ts";

export interface TempScratchStat {
	uid: number;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface TempScratchFs {
	/** Throws an error with code `ENOENT` when the path is missing. */
	lstat(path: string): TempScratchStat;
	/** Current process uid; undefined where POSIX ownership is unavailable. */
	uid: number | undefined;
	/** Resolved `os.tmpdir()`, when resolvable. */
	tmpdir: string | undefined;
	home: string;
}

const FIXED_TEMP_ROOTS = ["/tmp", "/var/tmp"];
const MKTEMP_NAME_RE = /^tmp\.[A-Za-z0-9]{6,}$/;
// A closed character set: expansion, quoting, glob, brace and redirection
// characters (`$`, backtick, `~`, `*?[{`, quotes, `<>`) make the shell
// target differ from the text or add a write elsewhere.
const LITERAL_PATH_RE = /^\/[A-Za-z0-9._@%+=:,/-]*$/;

export function defaultTempScratchFs(): TempScratchFs {
	let resolvedTmpdir: string | undefined;
	try { resolvedTmpdir = realpathSync(tmpdir()); } catch { resolvedTmpdir = undefined; }
	return { lstat: (path) => lstatSync(path), uid: process.getuid?.(), tmpdir: resolvedTmpdir, home: homedir() };
}

/** A temp root equal to, above or below home would expose home entries as scratch. */
function tempRoots(fs: TempScratchFs): string[] {
	const home = posix.normalize(fs.home);
	return [...FIXED_TEMP_ROOTS, fs.tmpdir].filter((root): root is string =>
		root !== undefined && posix.isAbsolute(root) && posix.normalize(root) === root && root !== "/" &&
		root !== home && !home.startsWith(`${root}/`) && !root.startsWith(`${home}/`));
}

/** One literal path component directly under a temp root, proven own scratch by an admission-time lstat. */
export function isTempScratchTarget(target: string, fs: TempScratchFs): boolean {
	if (fs.uid === undefined || !LITERAL_PATH_RE.test(target)) return false;
	if (target.endsWith("/") || posix.normalize(target) !== target) return false;
	const name = posix.basename(target);
	if (name === "" || name === "." || name === ".." || !tempRoots(fs).includes(posix.dirname(target))) return false;
	let stat: TempScratchStat;
	try {
		stat = fs.lstat(target);
	} catch (error) {
		return (error as { code?: unknown }).code === "ENOENT";
	}
	if (stat.isSymbolicLink()) return true;
	if (stat.uid !== fs.uid) return false;
	return stat.isFile() || (stat.isDirectory() && MKTEMP_NAME_RE.test(name));
}

/** A recognized effect is waivable temp scratch only when it is a direct recursive `rm` of temp scratch alone. */
export function isTempScratchRemoval(match: DestructiveCommandMatch, fs: TempScratchFs): boolean {
	if (match.hardDeny || match.kind !== "filesystem" || match.removalTargets === undefined) return false;
	return match.removalTargets.every((target) => isTempScratchTarget(target, fs));
}
