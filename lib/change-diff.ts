// One changed file's unified diff, shared by the `/gentle:changes` panel and
// the Desktop RPC `get_change_diff` method so both show the same text: a
// tracked file is `git diff HEAD -- path`, an untracked one is a no-index diff
// against an empty file. The caller's GitRunner owns the root and the output
// bound; this module only chooses the arguments and reads the result.

import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { CHANGE_STATUS, DIFF_MAX_BYTES, DIFF_MAX_LINES, DIFF_TOO_LARGE, type ChangedFile, type GitResult, type GitRunner } from "./shell-changes.ts";

export interface FileDiffOptions {
	/**
	 * Never run a command the repository's own configuration names: no
	 * `.gitattributes` textconv, no external diff driver, no fsmonitor hook.
	 * For readers outside the session (Desktop RPC). The panel leaves it off,
	 * so its diff stays exactly what Git shows the user in a terminal.
	 */
	inertRepositoryCommands?: boolean;
}

/** Git options that keep a diff from executing anything repository configuration names. */
export const INERT_DIFF_CONFIG = ["-c", "core.fsmonitor=false"] as const;
export const INERT_DIFF_FLAGS = ["--no-textconv", "--no-ext-diff"] as const;

/** The Git arguments that produce one file's diff against HEAD (or an empty file when untracked). */
export function fileDiffArgs(file: Pick<ChangedFile, "path" | "status">, options: FileDiffOptions = {}): string[] {
	const target = file.status === CHANGE_STATUS.UNTRACKED ? ["--no-index", "--", "/dev/null", file.path] : ["HEAD", "--", file.path];
	return options.inertRepositoryCommands ? [...INERT_DIFF_CONFIG, "diff", ...INERT_DIFF_FLAGS, ...target] : ["diff", ...target];
}

/** The raw Git answer for one file's diff; callers decide how to bound and present it. */
export function runFileDiff(git: GitRunner, file: Pick<ChangedFile, "path" | "status">, options: FileDiffOptions = {}): Promise<GitResult> {
	return git(fileDiffArgs(file, options));
}

/**
 * True when Git answered a diff: exit 0 (no difference) or 1 (differences,
 * and always for a no-index diff with content). A timed-out run is a failure
 * even when its partial output looks complete.
 */
export function fileDiffAnswered(result: GitResult): boolean {
	return !result.timedOut && (result.code === 0 || result.code === 1);
}

function inside(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return !isAbsolute(path) && path.split(/[\\/]/)[0] !== "..";
}

/**
 * True when the directory holding `path` resolves inside `root` and outside
 * every directory in `excluded` (resolved too; a missing one is skipped). Git
 * lists files behind a directory link (a Windows junction, for one) as part
 * of the working tree, so a listed path can still reach content outside the
 * root, or the repository's own git dir through an alias inside it; a caller
 * that must never serve such content checks this first. The file itself is
 * not followed: a symlink's diff is its link text. A directory that no longer
 * exists (a deleted file) has nothing on disk to reach, and its diff is
 * HEAD's own content.
 */
export async function changeDirectoryInsideRoot(root: string, path: string, excluded: readonly string[] = []): Promise<boolean> {
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
	if (!inside(realRoot, realDirectory)) return false;
	for (const directory of excluded) {
		let realExcluded: string;
		try {
			realExcluded = await realpath(directory);
		} catch {
			continue;
		}
		if (inside(realExcluded, realDirectory)) return false;
	}
	return true;
}

/**
 * The repository's git dir and common dir for `git`'s root, as absolute
 * paths, or `undefined` when Git cannot answer.
 */
export async function repositoryGitDirectories(git: GitRunner, root: string): Promise<string[] | undefined> {
	const result = await git(["rev-parse", "--absolute-git-dir", "--git-common-dir"]);
	if (result.code !== 0 || result.timedOut) return undefined;
	const lines = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	if (lines.length !== 2) return undefined;
	return lines.map((line) => (isAbsolute(line) ? line : join(root, line)));
}

/** The panel's view of one file's diff: the text, DIFF_TOO_LARGE past either bound, or "" when Git failed. */
export async function loadFileDiff(git: GitRunner, file: ChangedFile, options: FileDiffOptions = {}): Promise<string> {
	const result = await runFileDiff(git, file, options);
	if (result.truncated || result.stdout.length > DIFF_MAX_BYTES || result.stdout.split("\n", DIFF_MAX_LINES + 2).length > DIFF_MAX_LINES + 1) return DIFF_TOO_LARGE;
	return fileDiffAnswered(result) ? result.stdout : "";
}
