import { execFile } from "node:child_process";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

// Harness roadmap T4 (R1): ODD slices delivery at about 400 authored changed
// lines, but the model had to estimate the count. After each parent commit the
// runtime reports it from Git, so the slicing decision reads a number.

export const SLICE_LINES = 400;

// Generated files that do not count as authored lines.
const GENERATED = [/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$/, /\.min\.(js|css)$/];

// `git [-C dir | -c key=value]... commit` at the start of a segment, after any variable assignments.
const COMMIT = /^\s*(\w+=\S*\s+)*git(\s+-[Cc]\s+\S+)*\s+commit(\s|$)/;

/** A commit is a git invocation that starts a shell segment; text that only mentions one (echo, a message) is not. */
export function isGitCommitCommand(command: string): boolean {
	return command.split(/[;&|(\n]/).some((segment) => COMMIT.test(segment));
}

/** Shell segments joined by `;`, `&&`, `||`, or a newline. */
export const SHELL_SEGMENT_SEPARATOR = /;|&&|\|\||\n/;

const unquote = (value: string) => value.replace(/^["']|["']$/g, "");

/** The directory after a shell segment: `cd <dir>` resolved against `base`, else `base`. */
export function directoryAfterSegment(segment: string, base: string): string {
	const cdDir = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*$/.exec(segment)?.[1];
	return cdDir ? resolve(base, unquote(cdDir)) : base;
}

/** The directory the commit runs in: `git -C <dir>` under every `cd <dir>` segment before the commit (joined by `;`, `&&`, `||`, or a newline), else the session cwd. */
export function commitTargetDirectory(command: string, cwd: string): string {
	const gitDir = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+(?:-[Cc]\s+\S+\s+)*commit\b/.exec(command)?.[1];
	let base = cwd;
	for (const segment of command.split(SHELL_SEGMENT_SEPARATOR)) {
		if (COMMIT.test(segment)) break;
		base = directoryAfterSegment(segment, base);
	}
	return gitDir ? resolve(base, unquote(gitDir)) : base;
}

type Git = (args: string[], cwd: string) => Promise<string | undefined>;

// Asynchronous, so the parent stays responsive while git answers.
const runGit: Git = (args, cwd) => new Promise((resolve) => {
	execFile("git", args, { cwd, encoding: "utf8", timeout: 2_000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
});

async function defaultBranch(cwd: string, git: Git): Promise<string | undefined> {
	const remote = await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (remote) return remote;
	for (const name of ["main", "master"]) {
		if (await git(["rev-parse", "--verify", "-q", `refs/heads/${name}`], cwd) !== undefined) return name;
	}
	return undefined;
}

/** One line for the parent after a commit on a feature branch, or undefined when there is no slice to report. */
export async function commitSliceReport(cwd: string, git: Git = runGit): Promise<string | undefined> {
	const branch = await git(["symbolic-ref", "-q", "--short", "HEAD"], cwd);
	const target = branch === undefined ? undefined : await defaultBranch(cwd, git);
	if (!branch || !target || branch === target || `origin/${branch}` === target) return undefined;
	const base = await git(["merge-base", "HEAD", target], cwd);
	const commits = base ? Number(await git(["rev-list", "--count", `${base}..HEAD`], cwd)) : 0;
	if (!base || !(commits > 0)) return undefined;
	// A failed or timed-out diff is not an empty one: report nothing rather than 0.
	// `-M` counts a move by what it changed; `-z` keeps paths unquoted for the generated-file filter.
	const numstat = await git(["diff", "--numstat", "-z", "-M", base, "HEAD"], cwd);
	if (numstat === undefined) return undefined;
	let lines = 0;
	const fields = numstat.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const [added, deleted, inline] = fields[i].split("\t");
		// A rename leaves the inline path empty and is followed by its old and new paths.
		const path = inline === "" ? fields[i += 2] : inline;
		if (!path || added === "-" || GENERATED.some((pattern) => pattern.test(path))) continue;
		lines += Number(added) + Number(deleted);
	}
	const head = `Commit slice: ${lines} authored changed lines in ${commits} commit${commits === 1 ? "" : "s"} on ${branch} since ${target} (lock files excluded).`;
	return lines > SLICE_LINES
		? `${head} Past the ~${SLICE_LINES}-line slice: apply the feature's delivery strategy before the next commit (record the slice boundary in the feature document).`
		: `${head} ${SLICE_LINES - lines} lines left before the ~${SLICE_LINES}-line slice.`;
}

/**
 * tool_result patch for a successful parent `git commit`: the slice line appended, structured content kept.
 * Only foreground `bash`: a background job's result arrives before its commit exists.
 */
export async function commitSliceToolResult(event: Pick<ToolResultEvent, "toolName" | "input" | "isError" | "content" | "structuredContent">, cwd: string, git: Git = runGit): Promise<ToolResultEventResult | undefined> {
	const command = (event.input as { command?: unknown } | undefined)?.command;
	if (event.toolName !== "bash" || event.isError !== false || typeof command !== "string" || !isGitCommitCommand(command)) return undefined;
	const report = await commitSliceReport(commitTargetDirectory(command, cwd), git);
	if (!report) return undefined;
	return {
		content: [...event.content, { type: "text", text: `\n${report}` }],
		...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
	};
}
