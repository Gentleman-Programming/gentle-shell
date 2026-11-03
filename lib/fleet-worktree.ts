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
	/** git ran past its bound and was killed: nothing it reports can be trusted (S10 R6). */
	timedOut?: boolean;
}

/** Runs `git <args>` in `cwd`; injected so tests drive a scratch repository. */
export type GitExec = (args: string[], cwd: string) => GitResult;

// Hooks and LFS run inside `git worktree add`: the call is synchronous in the
// controller, so it is bounded and a timeout is reported like any refusal.
export const GIT_TIMEOUT_MS = 60_000;

/** `git <args>` killed after `timeoutMs`; the pipes a hook keeps open do not extend it. */
export function boundedGit(timeoutMs: number): GitExec {
	return (args, cwd) => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
		if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return { status: null, stdout: "", stderr: `git timed out after ${timeoutMs / 1000} s`, timedOut: true };
		return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
	};
}

export const runGit: GitExec = boundedGit(GIT_TIMEOUT_MS);

/** The refusal text for a timed-out call (`command`: e.g. "rev-parse"), or undefined when git answered. */
export function gitTimeout(result: GitResult, command: string, cwd: string): string | undefined {
	return result.timedOut ? `git ${command} ${result.stderr.replace(/^git /, "")} in ${cwd}` : undefined;
}

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
	/** Runs after every check and right before `git worktree add`; a message refuses with nothing created. */
	beforeAdd?(): string | undefined;
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

export function createMemberWorktree(input: MemberWorktreeInput): MemberWorktreeResult {
	const top = input.git(["rev-parse", "--show-toplevel"], input.cwd);
	const topTimeout = gitTimeout(top, "rev-parse", input.cwd);
	if (topTimeout) return { kind: "refused", message: topTimeout };
	const repo = top.status === 0 ? top.stdout.trim() : "";
	if (!repo) return { kind: "outside-git" };
	const branch = `fleet/${input.fleetSlug}/${input.member}`;
	const path = join(dirname(repo), `${basename(repo)}.fleet`, input.fleetSlug, input.member);
	const retry = "Use another member name, or spawn with worktree: false to run in place.";
	const known = input.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
	const branchTimeout = gitTimeout(known, "rev-parse", repo);
	if (branchTimeout) return { kind: "refused", message: branchTimeout };
	if (known.status === 0) return { kind: "refused", message: `branch ${branch} already exists in ${repo}. ${retry}` };
	if (existsSync(path)) return { kind: "refused", message: `${path} already exists. ${retry}` };
	const blocked = input.beforeAdd?.();
	if (blocked) return { kind: "refused", message: blocked };
	const added = input.git(["worktree", "add", "-b", branch, path, "HEAD"], repo);
	// Killed mid-add, git may have created the branch or part of the worktree: say so, never clean up.
	const addTimeout = gitTimeout(added, "worktree add", repo);
	if (addTimeout) return { kind: "refused", message: `${addTimeout}; it may have left branch ${branch} or ${path}: check them before you retry.` };
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
	const timeout = gitTimeout(top, "rev-parse", input.path);
	if (timeout) return timeout;
	let same = false;
	try { same = top.status === 0 && realpathSync(top.stdout.trim()) === realpathSync(input.path); } catch { /* not comparable */ }
	return same ? undefined : `${input.path} is no longer a git worktree`;
}
