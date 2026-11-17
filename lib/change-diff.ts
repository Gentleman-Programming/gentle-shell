// One changed file's unified diff, shared by the `/gentle:changes` panel and
// the Desktop RPC `get_change_diff` method so both show the same text: a
// tracked file is `git diff HEAD -- path`, an untracked one is a no-index diff
// against an empty file. The caller's GitRunner owns the root and the output
// bound; this module only chooses the arguments and reads the result.

import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { CHANGE_STATUS, DIFF_MAX_BYTES, DIFF_MAX_LINES, DIFF_TOO_LARGE, type ChangedFile, type GitResult, type GitRunner } from "./shell-changes.ts";

/** The Git arguments that produce one file's diff against HEAD (or an empty file when untracked). */
export function fileDiffArgs(file: Pick<ChangedFile, "path" | "status">): string[] {
	return file.status === CHANGE_STATUS.UNTRACKED ? ["diff", "--no-index", "--", "/dev/null", file.path] : ["diff", "HEAD", "--", file.path];
}

/** The raw Git answer for one file's diff; callers decide how to bound and present it. */
export function runFileDiff(git: GitRunner, file: Pick<ChangedFile, "path" | "status">): Promise<GitResult> {
	return git(fileDiffArgs(file));
}

/**
 * True when Git answered a diff: exit 0 (no difference) or 1 (differences,
 * and always for a no-index diff with content). A timed-out run is a failure
 * even when its partial output looks complete.
 */
export function fileDiffAnswered(result: GitResult): boolean {
	return !result.timedOut && (result.code === 0 || result.code === 1);
}

/**
 * True when the directory holding `path` resolves inside `root`. Git lists
 * files behind a directory link (a Windows junction, for one) as part of the
 * working tree, so a listed path can still reach content outside the root;
 * a caller that must never serve such content checks this first. The file
 * itself is not followed: a symlink's diff is its link text. A directory
 * that no longer exists (a deleted file) has nothing on disk to reach, and
 * its diff is HEAD's own content.
 */
export async function changeDirectoryInsideRoot(root: string, path: string): Promise<boolean> {
	let realRoot: string;
	try {
		realRoot = await realpath(root);
	} catch {
		return false;
	}
	let realDirectory: string;
	try {
		realDirectory = await realpath(dirname(join(root, path)));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
	const inside = relative(realRoot, realDirectory);
	return !isAbsolute(inside) && inside.split(/[\\/]/)[0] !== "..";
}

/** The panel's view of one file's diff: the text, DIFF_TOO_LARGE past either bound, or "" when Git failed. */
export async function loadFileDiff(git: GitRunner, file: ChangedFile): Promise<string> {
	const result = await runFileDiff(git, file);
	if (result.truncated || result.stdout.length > DIFF_MAX_BYTES || result.stdout.split("\n", DIFF_MAX_LINES + 2).length > DIFF_MAX_LINES + 1) return DIFF_TOO_LARGE;
	return fileDiffAnswered(result) ? result.stdout : "";
}
