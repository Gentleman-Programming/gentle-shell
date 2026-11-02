import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

// Worktree per git member (odd/tasks/fleet-orchestrator.md T4, L15): a member
// whose cwd is inside a git repository works on its own branch in its own
// worktree, created from the repository's current HEAD. Members outside git
// (publishing, channel work) run in place. Code never reuses, forces or
// removes a worktree or a branch: stop and exit leave both for the human.

export interface GitResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/** Runs `git <args>` in `cwd`; injected so tests drive a scratch repository. */
export type GitExec = (args: string[], cwd: string) => GitResult;

export const runGit: GitExec = (args, cwd) => {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
};

export interface MemberWorktree {
	repo: string;
	path: string;
	branch: string;
	/** Where the member runs: the same subdirectory of the worktree as its requested cwd, when tracked. */
	cwd: string;
}

export type MemberWorktreeResult =
	| { kind: "outside-git" }
	| { kind: "created"; worktree: MemberWorktree }
	| { kind: "refused"; message: string };

export interface MemberWorktreeInput {
	cwd: string;
	fleetSlug: string;
	member: string;
	git: GitExec;
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

export function createMemberWorktree(input: MemberWorktreeInput): MemberWorktreeResult {
	const top = input.git(["rev-parse", "--show-toplevel"], input.cwd);
	const repo = top.status === 0 ? top.stdout.trim() : "";
	if (!repo) return { kind: "outside-git" };
	const branch = `fleet/${input.fleetSlug}/${input.member}`;
	const path = join(dirname(repo), `${basename(repo)}.fleet`, input.fleetSlug, input.member);
	const retry = "Use another member name, or spawn with worktree: false to run in place.";
	if (input.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).status === 0) {
		return { kind: "refused", message: `branch ${branch} already exists in ${repo}. ${retry}` };
	}
	if (existsSync(path)) return { kind: "refused", message: `${path} already exists. ${retry}` };
	const added = input.git(["worktree", "add", "-b", branch, path, "HEAD"], repo);
	if (added.status !== 0) return { kind: "refused", message: `git worktree add failed in ${repo}: ${firstLine(added.stderr) || `exit ${added.status ?? "none"}`}` };
	let sub = "";
	try { sub = relative(repo, realpathSync(input.cwd)); } catch { /* run at the worktree root */ }
	// An untracked subdirectory is not in the new worktree.
	const inside = sub && !sub.startsWith("..") && !isAbsolute(sub) ? join(path, sub) : path;
	const cwd = existsSync(inside) ? inside : path;
	return { kind: "created", worktree: { repo, path, branch, cwd } };
}

/**
 * Why a resumed member cannot go back to its own worktree, or undefined when it
 * still exists as the top of a git worktree. Read-only: nothing is created,
 * repaired or removed.
 */
export function reattachMemberWorktree(input: { path: string; git: GitExec }): string | undefined {
	if (!existsSync(input.path)) return `worktree ${input.path} is missing`;
	const top = input.git(["rev-parse", "--show-toplevel"], input.path);
	let same = false;
	try { same = top.status === 0 && realpathSync(top.stdout.trim()) === realpathSync(input.path); } catch { /* not comparable */ }
	return same ? undefined : `${input.path} is no longer a git worktree`;
}
