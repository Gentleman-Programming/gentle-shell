import { execFile, execFileSync } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { worktreeGitEnvironment } from "./session-worktree-registry.ts";

// Safe post-merge change closure (odd/tasks/post-merge-close.md, T1): parse
// pull request URLs fail-closed, validate what `gh pr view` answers, and keep
// the durable session registration shape. The extension owns the command flow;
// the confirmed cleanup deletes only what a freshly checked plan proves.

export const POST_MERGE_CLOSE_ENTRY = "gentle-pi.post-merge-close/v1";

export const PULL_REQUEST_FIELDS = "state,number,url,headRefName,headRefOid,baseRefName,mergedAt,mergeCommit,isCrossRepository";

export const CLOSE_CHANGE_USAGE = [
	"Usage: /gentle:close-change [register <PR URL>|preview [PR URL]|clean [PR URL]|help]",
	"  register <https://github.com/owner/repo/pull/N>  associate one merged GitHub pull request with this session's worktrees for a later cleanup",
	"  preview [PR URL]                                 show exactly what a later cleanup would keep or remove; nothing is changed",
	"  clean [PR URL]                                   after one explicit confirmation, remove only what the preview proved removable and fast-forward the destination",
	"  help                                             show this help",
	"Only same-repository (non-fork) pull requests are accepted; every remote read and every deletion asks for its own consent.",
].join("\n");

export interface PullRequestRef { owner: string; repo: string; number: number; url: string }

export const SHA_PATTERN = /^[0-9a-f]{40}$/;

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// GitHub ref names allow more characters; this deliberately accepts only the
// plain subset, because the name travels into Git arguments untouched.
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const safeRef = (value: unknown, cap: number): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= cap && REF_PATTERN.test(value) && !value.includes("..");

// Only an exact https GitHub pull request URL is an origin this command can
// trust: credentials, ports, queries, fragments, dot segments and extra paths
// all fail closed, and the answer names the exact review target.
export function parsePullRequestUrl(raw: unknown): PullRequestRef | undefined {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 400) return undefined;
	let url: URL;
	try { url = new URL(raw); } catch { return undefined; }
	if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return undefined;
	if (url.username || url.password || url.port || url.search || url.hash) return undefined;
	const parts = url.pathname.split("/");
	if (parts.length !== 5 || parts[0] !== "" || parts[3] !== "pull") return undefined;
	const [owner, repo, numberText] = [parts[1], parts[2], parts[4]];
	if (!OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(repo) || !/^[1-9][0-9]{0,8}$/.test(numberText)) return undefined;
	return { owner, repo, number: Number(numberText), url: raw };
}

export const pullRequestTargetKey = (target: Pick<PullRequestRef, "owner" | "repo" | "number">): string =>
	`${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}`;

export interface PullRequestView {
	state: "OPEN" | "CLOSED" | "MERGED";
	number: number;
	url: string;
	headBranch: string;
	headSha: string;
	baseBranch: string;
	/** Present only for an actually merged pull request. */
	mergedAt?: string;
	mergeCommitSha?: string;
}

// GitHub state is the only merge evidence this command accepts: an approval,
// checks or a merge queue position never count, and a merged answer must carry
// its real merge time and merge commit.
export function validatePullRequestView(json: unknown, target: PullRequestRef): { ok: true; view: PullRequestView } | { ok: false; reason: string } {
	if (typeof json !== "object" || json === null) return { ok: false, reason: "the response is not a JSON object" };
	const data = json as Record<string, unknown>;
	if (data.isCrossRepository === true) return { ok: false, reason: "the pull request comes from a fork (another repository), so its head cannot be proven safe to clean" };
	if (data.isCrossRepository !== false) return { ok: false, reason: "the response cannot be proven to belong to the target repository" };
	if (data.number !== target.number) return { ok: false, reason: `it names pull request #${String(data.number)}, not #${target.number}` };
	if (typeof data.url !== "string" || !samePullRequestTarget(data.url, target)) return { ok: false, reason: "it points at a different repository or number" };
	if (data.state !== "OPEN" && data.state !== "CLOSED" && data.state !== "MERGED") return { ok: false, reason: `its state ${JSON.stringify(data.state)} is unknown` };
	if (!safeRef(data.headRefName, 200) || !safeRef(data.baseRefName, 200)) return { ok: false, reason: "a branch name is missing or malformed" };
	if (typeof data.headRefOid !== "string" || !SHA_PATTERN.test(data.headRefOid)) return { ok: false, reason: "the head commit id is missing or malformed" };
	const view: PullRequestView = { state: data.state, number: target.number, url: data.url, headBranch: data.headRefName, headSha: data.headRefOid.toLowerCase(), baseBranch: data.baseRefName };
	if (data.state === "MERGED") {
		if (typeof data.mergedAt !== "string" || Number.isNaN(Date.parse(data.mergedAt))) return { ok: false, reason: "the merge time is missing or malformed" };
		const mergeCommit = data.mergeCommit;
		if (typeof mergeCommit !== "object" || mergeCommit === null) return { ok: false, reason: "the merge commit is missing" };
		const oid = (mergeCommit as { oid?: unknown }).oid;
		if (typeof oid !== "string" || !SHA_PATTERN.test(oid)) return { ok: false, reason: "the merge commit id is missing or malformed" };
		view.mergedAt = data.mergedAt;
		view.mergeCommitSha = oid.toLowerCase();
	}
	return { ok: true, view };
}

function samePullRequestTarget(raw: string, target: PullRequestRef): boolean {
	const parsed = parsePullRequestUrl(raw);
	return parsed !== undefined && parsed.owner.toLowerCase() === target.owner.toLowerCase()
		&& parsed.repo.toLowerCase() === target.repo.toLowerCase() && parsed.number === target.number;
}

export interface RegisteredWorktree { path: string; fingerprint: string }
export interface PostMergeCloseRecord {
	version: 1;
	sessionId: string;
	commonDir: string;
	pr: PullRequestRef;
	baseBranch: string;
	headBranch: string;
	headSha: string;
	registeredAt: string;
	worktrees: readonly RegisteredWorktree[];
}

export interface SessionEntryLike { type: unknown; customType?: unknown; data?: unknown }

// Entries are historical data, never consent: a record only counts when it is
// complete, valid, and bound to this exact session and canonical clone.
export function restorePostMergeCloseRecords(entries: readonly SessionEntryLike[], binding: { sessionId: string; commonDir: string }): PostMergeCloseRecord[] {
	const records: PostMergeCloseRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== POST_MERGE_CLOSE_ENTRY) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null) continue;
		const candidate = data as Partial<PostMergeCloseRecord>;
		if (candidate.version !== 1) continue;
		if (candidate.sessionId !== binding.sessionId || candidate.commonDir !== binding.commonDir) continue;
		const pr = candidate.pr as Partial<PullRequestRef> | undefined;
		const target = parsePullRequestUrl(pr && typeof pr === "object" ? pr.url : undefined);
		if (!target || pr!.number !== target.number || pr!.owner?.toLowerCase() !== target.owner.toLowerCase() || pr!.repo?.toLowerCase() !== target.repo.toLowerCase()) continue;
		if (!safeRef(candidate.baseBranch, 200) || !safeRef(candidate.headBranch, 200)) continue;
		if (typeof candidate.headSha !== "string" || !SHA_PATTERN.test(candidate.headSha)) continue;
		if (typeof candidate.registeredAt !== "string" || Number.isNaN(Date.parse(candidate.registeredAt))) continue;
		if (!Array.isArray(candidate.worktrees) || candidate.worktrees.length === 0 || candidate.worktrees.length > 64) continue;
		const worktrees: RegisteredWorktree[] = [];
		let valid = true;
		for (const worktree of candidate.worktrees) {
			if (typeof worktree !== "object" || worktree === null) { valid = false; break; }
			const { path, fingerprint } = worktree as Partial<RegisteredWorktree>;
			if (typeof path !== "string" || !isAbsolute(path) || path.includes("..") || typeof fingerprint !== "string" || fingerprint.length === 0) { valid = false; break; }
			worktrees.push({ path, fingerprint });
		}
		if (!valid) continue;
		records.push({ version: 1, sessionId: candidate.sessionId as string, commonDir: candidate.commonDir as string, pr: target, baseBranch: candidate.baseBranch, headBranch: candidate.headBranch, headSha: candidate.headSha, registeredAt: candidate.registeredAt, worktrees });
	}
	return records;
}

// Reveals replacement, removal or recreation of the worktree between fits of
// inspecting it; deliberately conservative, because nothing here mutates.
export function worktreeCloseFingerprint(root: string, commonDir: string): string | undefined {
	try {
		const marker = lstatSync(join(root, ".git"));
		const parts = [statSync(root), statSync(commonDir)].map((entry) => `${entry.dev}:${entry.ino}`);
		parts.push(`${marker.size}:${marker.mtimeMs}`);
		return parts.join("|");
	} catch { return undefined; }
}

// Git never prompts for credentials: a cleanup that cannot authenticate fails
// closed instead of waiting on a terminal that does not exist.
export function postMergeCloseEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const cleaned = worktreeGitEnvironment(env);
	delete cleaned.SSH_AUTH_SOCK;
	delete cleaned.SSH_AGENT_PID;
	cleaned.GIT_TERMINAL_PROMPT = "0";
	return cleaned;
}

export function runGit(directory: string, args: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
	try {
		return String(execFileSync("git", ["--no-optional-locks", "-C", directory, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, env: postMergeCloseEnvironment(env) })).trimEnd();
	} catch { return undefined; }
}

export function readBranchTip(directory: string, branch: string, env: NodeJS.ProcessEnv): string | undefined {
	return runGit(directory, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], env);
}

/**
 * true when `ancestor` is an ancestor of `descendant`, false when Git answers
 * "no", undefined when it could not answer at all.
 */
export function gitIsAncestor(directory: string, ancestor: string, descendant: string, env: NodeJS.ProcessEnv): boolean | undefined {
	try {
		execFileSync("git", ["--no-optional-locks", "-C", directory, "merge-base", "--is-ancestor", ancestor, descendant], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, env: postMergeCloseEnvironment(env) });
		return true;
	} catch (error) {
		return (error as { status?: number }).status === 1 ? false : undefined;
	}
}

// The local branch checked out in a candidate worktree, at the pinned head
// commit, is what makes that worktree associable: nothing else is claimed.
export function checkedOutHeadAt(root: string, headBranch: string, headSha: string, env: NodeJS.ProcessEnv): boolean {
	return runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"], env) === headBranch
		&& runGit(root, ["rev-parse", "HEAD"], env)?.toLowerCase() === headSha;
}

export function findGitHubRemote(directory: string, owner: string, repo: string, env: NodeJS.ProcessEnv): { name: string } | { problem: string } {
	const wanted = `github.com/${owner}/${repo}`;
	const output = runGit(directory, ["remote", "-v"], env);
	if (output === undefined) return { problem: `the local remotes could not be read, so ${wanted} stays unreachable for a later cleanup` };
	const names = new Set<string>();
	for (const line of output.split("\n")) {
		const separator = line.indexOf("\t");
		if (separator <= 0) continue;
		const name = line.slice(0, separator);
		const rest = line.slice(separator + 1);
		if (!rest.endsWith("(fetch)")) continue;
		if (remoteNamesRepository(rest.slice(0, -"(fetch)".length).trim(), owner, repo)) names.add(name);
	}
	if (names.size === 0) return { problem: `no local remote tracks ${wanted}, so a later cleanup cannot name its remote branch` };
	if (names.size > 1) return { problem: `several local remotes track ${wanted}, so a later cleanup would not choose one` };
	return { name: [...names][0] };
}

function remoteNamesRepository(raw: string, owner: string, repo: string): boolean {
	const normalized = [raw, raw.endsWith(".git") ? raw.slice(0, -".git".length) : ""].map((value) => {
		try {
			const url = new URL(value);
			return `${url.hostname.toLowerCase()}${url.pathname}`;
		} catch {
			const scp = value.match(/^[^@]+@([^:]+):(.+)$/);
			return scp ? `${scp[1].toLowerCase()}/${scp[2]}` : "";
		}
	});
	const wanted = `github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`;
	return normalized.some((value) => value.toLowerCase() === wanted);
}

// gh runs without a shell, with the target repository pinned through --repo,
// the Git routing and SSH agent environments removed, and a bounded timeout.
const execFileAsync = promisify(execFile);
export async function runGhPullRequestView(target: PullRequestRef, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
	try {
		const { stdout } = await execFileAsync("gh", ["pr", "view", String(target.number), "--repo", `${target.owner}/${target.repo}`, "--json", PULL_REQUEST_FIELDS], { cwd: options.cwd, env: postMergeCloseEnvironment(options.env), shell: false, windowsHide: true, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
		return { ok: true, stdout };
	} catch (error) {
		const failure = error as { code?: unknown; message?: unknown; stderr?: unknown };
		if (failure.code === "ENOENT") return { ok: false, reason: "gh is not installed or not runnable" };
		const detail = typeof failure.stderr === "string" && failure.stderr.trim().length > 0 ? failure.stderr.trim().split("\n")[0] : "";
		return { ok: false, reason: `gh exited with status ${typeof failure.code === "number" ? failure.code : "unknown"}${detail ? `: ${detail}` : ""}` };
	}
}

export type CloseState = "removable" | "kept" | "already gone" | "unknown";
export interface PreviewEntry { kind: "worktree" | "local branch" | "remote branch" | "destination branch"; name: string; state: CloseState; detail?: string }

export function formatPreviewEntries(entries: readonly PreviewEntry[]): string[] {
	return entries.map((entry) => `${entry.kind} ${entry.name}: ${entry.state}${entry.detail ? ` — ${entry.detail}` : ""}`);
}

// The live remote branch is only knowable by asking the remote. A cached
// tracking ref, the local branch or the pull request response never counts.
export type RemoteBranchState =
	| { state: "at"; sha: string }
	| { state: "absent" }
	| { state: "moved"; sha: string }
	| { state: "unknown"; reason: string };

export interface RemoteBranchInput {
	directory: string;
	remote: string;
	branch: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
}

// Injected in tests so the public command behavior is pinned without network.
export interface RemoteBranchOps {
	readHead(input: RemoteBranchInput): Promise<RemoteBranchState>;
	deleteBranch(input: RemoteBranchInput): Promise<{ ok: true } | { ok: false; reason: string }>;
}

const remoteFailure = (error: unknown, verb: string): string => {
	const failure = error as { code?: unknown; stderr?: unknown; message?: unknown };
	if (failure.code === "ENOENT") return "git is not installed or not runnable";
	const detail = typeof failure.stderr === "string" && failure.stderr.trim().length > 0 ? failure.stderr.trim().split("\n")[0] : "";
	return `git ${verb} failed${detail ? `: ${detail}` : ` with status ${typeof failure.code === "number" ? failure.code : "unknown"}`}`;
};

// Reading the remote runs without a shell, with credentials prompts disabled
// and a bounded timeout, so an unauthenticated or slow remote fails closed.
export const defaultRemoteBranchOps: RemoteBranchOps = {
	async readHead(input) {
		try {
			const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", input.remote, `refs/heads/${input.branch}`], { cwd: input.directory, env: postMergeCloseEnvironment(input.env), shell: false, windowsHide: true, timeout: input.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
			const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
			if (lines.length === 0) return { state: "absent" };
			if (lines.length > 1) return { state: "unknown", reason: "the remote answered with more than one head for that branch" };
			const [sha, name, ...rest] = lines[0].split(/\s+/);
			if (rest.length > 0 || name !== `refs/heads/${input.branch}` || typeof sha !== "string" || !SHA_PATTERN.test(sha)) return { state: "unknown", reason: "the remote answer could not be read as one branch head" };
			return { state: "at", sha: sha.toLowerCase() };
		} catch (error) {
			return { state: "unknown", reason: remoteFailure(error, "ls-remote") };
		}
	},
	async deleteBranch(input) {
		try {
			await execFileAsync("git", ["push", "--delete", input.remote, `refs/heads/${input.branch}`], { cwd: input.directory, env: postMergeCloseEnvironment(input.env), shell: false, windowsHide: true, timeout: input.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: remoteFailure(error, "push --delete") };
		}
	},
};

// The caller compares the live sha against the registered head itself, so a
// moved or reused remote ref can never be read as the pull request's branch.
export function remoteBranchEntry(name: string, state: RemoteBranchState, headSha: string): PreviewEntry {
	if (state.state === "absent") return { kind: "remote branch", name, state: "already gone" };
	if (state.state === "unknown") return { kind: "remote branch", name, state: "unknown", detail: state.reason };
	if (state.state === "moved") return { kind: "remote branch", name, state: "kept", detail: `the remote branch now points at ${state.sha}, not the registered head commit ${headSha}` };
	return state.sha === headSha
		? { kind: "remote branch", name, state: "removable", detail: `the remote branch still points at the registered head commit ${state.sha}` }
		: { kind: "remote branch", name, state: "kept", detail: `the remote branch now points at ${state.sha}, not the registered head commit ${headSha}` };
}
