import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstatSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import {
	CLOSE_CHANGE_USAGE,
	POST_MERGE_CLOSE_ENTRY,
	checkedOutHeadAt,
	defaultRemoteBranchOps,
	findGitHubRemote,
	formatPreviewEntries,
	gitIsAncestor,
	parsePullRequestUrl,
	pullRequestTargetKey,
	readBranchTip,
	remoteBranchEntry,
	restorePostMergeCloseRecords,
	runGhPullRequestView,
	runGit,
	validatePullRequestView,
	worktreeCloseFingerprint,
	type PostMergeCloseRecord,
	type PreviewEntry,
	type PullRequestRef,
	type PullRequestView,
	type RegisteredWorktree,
	type RemoteBranchInput,
	type RemoteBranchOps,
	type RemoteBranchState,
	type SessionEntryLike,
} from "../lib/post-merge-close.ts";
import { resolveSessionWorktree, resolveSessionWorktreeWithGit, SESSION_WORKTREE_ENTRY, type WorktreeResolver } from "../lib/session-worktree-registry.ts";

// Safe post-merge change closure (odd/tasks/post-merge-close.md, T1+T2): an
// explicit, session-bound command that associates an actually merged,
// same-repository pull request with this session's own worktrees, previews the
// cleanup, and runs it after one confirmation binding the exact checked plan;
// every remote read needs its own fresh, target-bound consent.

export interface PostMergeCloseOptions {
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** Bounded timeout for every `gh` and remote Git child, in milliseconds. */
	ghTimeoutMs?: number;
	resolveWorktree?: WorktreeResolver;
	remoteBranchOps?: RemoteBranchOps;
}

interface SessionCircle {
	manager: unknown;
	sessionId: string;
	cwd: string;
	root: string;
	commonDir: string;
}

const GH_DEFAULT_TIMEOUT_MS = 30_000;

const sessionEntries = (ctx: ExtensionContext): readonly SessionEntryLike[] => {
	try { return ctx.sessionManager.getEntries() as unknown as readonly SessionEntryLike[]; } catch { return []; }
};

const badOriginMessage = (argument: string): string =>
	`Not a GitHub pull request URL this command can trust: ${argument || "(none)"}\nUse exactly https://github.com/<owner>/<repo>/pull/<number> with no credentials, query, fragment or extra path.`;

interface Pinning { pr: PullRequestRef; baseBranch: string; headBranch: string; headSha: string; worktrees: readonly { path: string; fingerprint: string }[] }
const pinnedKey = (pinning: Pinning): string =>
	JSON.stringify({ pr: pinning.pr, baseBranch: pinning.baseBranch, headBranch: pinning.headBranch, headSha: pinning.headSha, worktrees: pinning.worktrees });

// What the command knows about the live remote branch right now: nothing
// (a preview), a naming problem, or one freshly read head. Only the last one
// can ever make a remote deletion possible.
type RemoteEvidence =
	| { kind: "cached" }
	| { kind: "problem"; problem: string }
	| { kind: "proven"; name: string; state: RemoteBranchState };

export function createPostMergeCloseExtension(options: PostMergeCloseOptions = {}): (pi: ExtensionAPI) => void {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const ghTimeoutMs = options.ghTimeoutMs ?? GH_DEFAULT_TIMEOUT_MS;
	const resolveWorktree = options.resolveWorktree ?? resolveSessionWorktree;
	const remoteBranchOps = options.remoteBranchOps ?? defaultRemoteBranchOps;
	const notify = (ctx: ExtensionContext, message: string, style: "info" | "warning") => { try { ctx.ui.notify(message, style); } catch { /* Reporting never changes a fail-closed outcome. */ } };
	const refuse = (ctx: ExtensionContext, message: string) => notify(ctx, message, "warning");
	const withoutUi = (ctx: ExtensionContext) => refuse(ctx, "This command needs an interactive session UI to authorize reading GitHub pull request data. Nothing was read and nothing changed.");

	return (pi: ExtensionAPI) => {
		if (env.GENTLE_PI_AGENTS_CHILD === "1") return;

		// The session, its directory and the canonical clone this process is
		// bound to right now; anything else is refused before any read.
		const sessionCircle = (ctx: ExtensionContext): SessionCircle | undefined => {
			const manager = ctx.sessionManager;
			let sessionId: string;
			try { sessionId = (manager.getSessionId?.() ?? "") as string; } catch { return undefined; }
			if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
			const identity = resolveWorktree(ctx.cwd, ctx.cwd);
			if (!identity) return undefined;
			return { manager, sessionId, cwd: ctx.cwd, root: identity.root, commonDir: identity.commonDir };
		};

		// Only the session's own registrations widen the association scope: the
		// session directory plus same-clone session-registered worktree roots.
		// The clone's other worktrees are deliberately never enumerated here.
		const registeredRoots = (circle: SessionCircle, ctx: ExtensionContext): string[] => {
			const roots = new Set<string>();
			for (const entry of sessionEntries(ctx)) {
				if (entry.type !== "custom" || entry.customType !== SESSION_WORKTREE_ENTRY) continue;
				const data = entry.data as { sessionId?: unknown; root?: unknown } | undefined;
				if (typeof data?.root !== "string" || data.sessionId !== circle.sessionId) continue;
				const identity = resolveWorktree(data.root, circle.cwd);
				if (identity && identity.commonDir === circle.commonDir) roots.add(identity.root);
			}
			if (roots.has(circle.root)) roots.delete(circle.root);
			return [...roots];
		};

		type Grant = "granted" | "declined" | "drifted";

		// The binding is re-derived from the live context, never from cached
		// state: the same session manager and id, and the very directory the
		// command runs in still resolving, freshly and uncached, to the same
		// canonical clone root and common directory it was bound to.
		const bindingHolds = (circle: SessionCircle, ctx: ExtensionContext): boolean => {
			if (ctx.sessionManager !== circle.manager) return false;
			try { if (ctx.sessionManager.getSessionId() !== circle.sessionId) return false; } catch { return false; }
			const identity = resolveSessionWorktreeWithGit(ctx.cwd, ctx.cwd);
			return identity !== undefined && identity.root === circle.root && identity.commonDir === circle.commonDir;
		};

		// One confirm answer grants exactly one validated read of one pull
		// request for this session in this clone. No grant is ever stored, and
		// whatever the prompt window changes invalidates it before the read runs.
		const grantRemoteRead = async (target: PullRequestRef, circle: SessionCircle, ctx: ExtensionContext): Promise<Grant> => {
			const message = [
				`${target.owner}/${target.repo}#${target.number} — ${target.url}`,
				`Session ${circle.sessionId} bound to clone ${circle.commonDir}.`,
				"This grants one read of this pull request through `gh pr view` (no shell, repository pinned with --repo); it grants nothing else and is not saved.",
			].join("\n");
			let confirmed: boolean;
			try { confirmed = await ctx.ui.confirm("Read GitHub pull request data?", message); } catch { return "declined"; }
			if (!confirmed) return "declined";
			return bindingHolds(circle, ctx) ? "granted" : "drifted";
		};

		const readPullRequest = async (target: PullRequestRef, circle: SessionCircle, ctx: ExtensionContext): Promise<Record<string, unknown> | undefined> => {
			const grant = await grantRemoteRead(target, circle, ctx);
			if (grant !== "granted") {
				refuse(ctx, grant === "drifted"
					? "The session or repository changed while the permission prompt was open; the read was cancelled and nothing was read."
					: "Read permission declined; nothing was read from GitHub and nothing changed.");
				return undefined;
			}
			const outcome = await runGhPullRequestView(target, { cwd: circle.root, env, timeoutMs: ghTimeoutMs });
			if (outcome.ok === false) {
				refuse(ctx, `Could not read the pull request from GitHub: ${outcome.reason}`);
				return undefined;
			}
			let data: Record<string, unknown>;
			try { data = JSON.parse(outcome.stdout) as Record<string, unknown>; }
			catch {
				refuse(ctx, `The GitHub response for ${target.owner}/${target.repo}#${target.number} could not be trusted: the answer is not valid JSON`);
				return undefined;
			}
			// Whatever the awaited read changed, the answer belongs to nobody the
			// command still speaks for: it is discarded before it can be stored.
			if (!bindingHolds(circle, ctx)) {
				refuse(ctx, "The session or repository changed while the pull request was being read; the answer was discarded and nothing was stored or previewed.");
				return undefined;
			}
			return data;
		};

		const requireMergedView = (ctx: ExtensionContext, target: PullRequestRef, data: Record<string, unknown>): PullRequestView | undefined => {
			const validated = validatePullRequestView(data, target);
			if (validated.ok === false) {
				refuse(ctx, `The GitHub response for ${target.owner}/${target.repo}#${target.number} could not be trusted: ${validated.reason}`);
				return undefined;
			}
			if (validated.view.state !== "MERGED") {
				refuse(ctx, `Pull request ${target.owner}/${target.repo}#${target.number} is ${validated.view.state}, not merged. Approvals, checks and comments are not merge evidence.`);
				return undefined;
			}
			return validated.view;
		};

		const register = async (argument: string, ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return withoutUi(ctx);
			const target = parsePullRequestUrl(argument);
			if (!target) return refuse(ctx, badOriginMessage(argument));
			const circle = sessionCircle(ctx);
			if (!circle) return refuse(ctx, "This command needs a live session bound to a Git worktree; nothing was associated.");
			const binding = { sessionId: circle.sessionId, commonDir: circle.commonDir };
			const records = restorePostMergeCloseRecords(sessionEntries(ctx), binding);
			const data = await readPullRequest(target, circle, ctx);
			if (!data) return;
			const view = requireMergedView(ctx, target, data);
			if (!view) return;
			const worktrees = associableWorktrees(view, circle, ctx);
			const candidate: Pinning = { pr: { owner: target.owner, repo: target.repo, number: target.number, url: target.url }, baseBranch: view.baseBranch, headBranch: view.headBranch, headSha: view.headSha, worktrees };
			// Registration is immutable: an exact repeat is acknowledged, a
			// different pinning of the same pull request is refused, and no
			// existing entry is ever rewritten.
			const matching = records.filter((record) => pullRequestTargetKey(record.pr) === pullRequestTargetKey(target));
			if (matching.length > 0) {
				if (matching.every((record) => pinnedKey(record) === pinnedKey(candidate))) {
					notify(ctx, `${target.owner}/${target.repo}#${target.number} is already registered for this session with the same pinned data; nothing changed.`, "info");
					return;
				}
				refuse(ctx, `${target.owner}/${target.repo}#${target.number} is already registered for this session with different pinned data; registration never replaces a record. Preview the existing registration instead.`);
				return;
			}
			if (worktrees.length === 0) {
				refuse(ctx, `No worktree of this session (its directory or a session-registered worktree of the same clone) has local branch ${view.headBranch} checked out at ${view.headSha}; nothing was registered.`);
				return;
			}
			const record: PostMergeCloseRecord = {
				version: 1,
				sessionId: circle.sessionId,
				commonDir: circle.commonDir,
				pr: candidate.pr,
				baseBranch: candidate.baseBranch,
				headBranch: candidate.headBranch,
				headSha: candidate.headSha,
				registeredAt: new Date(now()).toISOString(),
				worktrees,
			};
			pi.appendEntry(POST_MERGE_CLOSE_ENTRY, record);
			notify(ctx, [
				`Registered ${target.owner}/${target.repo}#${target.number} for this session (head ${view.headBranch} at ${view.headSha}).`,
				...worktrees.map((worktree) => `  worktree ${worktree.path} — local branch ${view.headBranch} at ${view.headSha}`),
				`The pull request is marked MERGED (merged at ${view.mergedAt}).`,
			].join("\n"), "info");
		};

		// Only the session's directory and its same-clone session-registered
		// worktrees are ever candidates, and only when their checked-out local
		// branch is the pull request head branch at the pinned head commit.
		const associableWorktrees = (view: PullRequestView, circle: SessionCircle, ctx: ExtensionContext): Array<{ path: string; fingerprint: string }> => {
			const worktrees: Array<{ path: string; fingerprint: string }> = [];
			for (const root of [circle.root, ...registeredRoots(circle, ctx)]) {
				const identity = resolveWorktree(root, circle.cwd);
				if (!identity || identity.commonDir !== circle.commonDir) continue;
				if (worktrees.some((worktree) => worktree.path === identity.root)) continue;
				if (!checkedOutHeadAt(identity.root, view.headBranch, view.headSha, env)) continue;
				const fingerprint = worktreeCloseFingerprint(identity.root, circle.commonDir);
				if (fingerprint === undefined) continue;
				worktrees.push({ path: identity.root, fingerprint });
			}
			return worktrees;
		};

		const destinationDetail = (record: PostMergeCloseRecord, circle: SessionCircle, view: PullRequestView): { detail: string; fastForward: boolean } => {
			const mergeCommitSha = view.mergeCommitSha;
			if (mergeCommitSha === undefined) return { detail: "the merge commit is unknown locally, so no fast-forward answer is possible", fastForward: false };
			if (runGit(circle.cwd, ["rev-parse", "--verify", "--quiet", `${mergeCommitSha}^{commit}`], env) === undefined) {
				return { detail: "the merge commit is not present locally, so no fast-forward answer is possible", fastForward: false };
			}
			const ancestor = gitIsAncestor(circle.cwd, `refs/heads/${record.baseBranch}`, mergeCommitSha, env);
			if (ancestor === undefined) return { detail: "the fast-forward state could not be checked locally", fastForward: false };
			return ancestor
				? { detail: "a later cleanup may fast-forward it to the merge commit", fastForward: true }
				: { detail: "has commits the merge commit does not include, so a later cleanup would refuse to update it", fastForward: false };
		};

		// One rule decides whether a registered worktree may be removed, so the
		// preview and the cleanup can never disagree about it. Every blocker is
		// re-evaluated against live state, never against the registration alone.
		type WorktreeVerdict = { state: "removable" } | { state: "kept" | "unknown" | "already gone"; detail?: string };
		const worktreeVerdict = (worktree: RegisteredWorktree, record: PostMergeCloseRecord, circle: SessionCircle, sessionDirectory: string | undefined): WorktreeVerdict => {
			let present = true;
			try { lstatSync(worktree.path); } catch { present = false; }
			if (!present) return { state: "already gone" };
			const identity = resolveWorktree(worktree.path, circle.cwd);
			if (!identity || identity.root !== worktree.path) return { state: "kept", detail: "the path is no longer a worktree of the registered clone" };
			if (identity.commonDir !== circle.commonDir) return { state: "kept", detail: "the path now belongs to a different clone" };
			if (worktreeCloseFingerprint(identity.root, circle.commonDir) !== worktree.fingerprint) return { state: "kept", detail: "the worktree changed since it was registered" };
			if (sessionDirectory !== undefined && (sessionDirectory === worktree.path || sessionDirectory.startsWith(`${worktree.path}${sep}`))) {
				return { state: "kept", detail: "this session's current directory is inside it" };
			}
			const status = runGit(identity.root, ["status", "--porcelain"], env);
			if (status === undefined) return { state: "unknown", detail: "git could not read the worktree state" };
			if (status.length > 0) return { state: "kept", detail: "has uncommitted changes" };
			// A clean worktree is only removable while its checked-out branch still
			// sits exactly at the registered head commit; anything else (an extra
			// commit, a branch switch) is kept with the reason.
			if (!checkedOutHeadAt(identity.root, record.headBranch, record.headSha, env)) {
				return { state: "kept", detail: "its checked-out branch no longer sits at the registered head commit" };
			}
			return { state: "removable" };
		};

		const previewEntries = (record: PostMergeCloseRecord, circle: SessionCircle, view: PullRequestView, evidence: RemoteEvidence): PreviewEntry[] => {
			const entries: PreviewEntry[] = [];
			const sessionDirectory = (() => { try { return realpathSync(circle.cwd); } catch { return undefined; } })();
			for (const worktree of record.worktrees) {
				const verdict = worktreeVerdict(worktree, record, circle, sessionDirectory);
				entries.push(verdict.state === "removable"
					? { kind: "worktree", name: worktree.path, state: "removable", detail: "clean git worktree" }
					: { kind: "worktree", name: worktree.path, state: verdict.state, ...(verdict.detail ? { detail: verdict.detail } : {}) });
			}
			const tip = readBranchTip(circle.cwd, record.headBranch, env);
			// Deleting the branch destroys its commit objects unless something else
			// still holds them: either a freshly proven remote branch, or the merge
			// commit itself when the pull request was merged without a squash.
			const provenOnRemote = evidence.kind === "proven" && evidence.state.state === "at" && evidence.state.sha === record.headSha;
			const mergedIntoDestination = gitIsAncestor(circle.cwd, record.headSha, `refs/heads/${record.baseBranch}`, env) === true;
			if (tip === undefined) entries.push({ kind: "local branch", name: record.headBranch, state: "already gone", detail: "the local branch is gone" });
			else if (tip.toLowerCase() !== record.headSha) entries.push({ kind: "local branch", name: record.headBranch, state: "kept", detail: "has commits beyond the registered head commit" });
			else if (provenOnRemote || mergedIntoDestination) entries.push({ kind: "local branch", name: record.headBranch, state: "removable", detail: `still points at the registered head commit ${record.headSha}` });
			else entries.push({ kind: "local branch", name: record.headBranch, state: "kept", detail: "nothing proves its commit exists anywhere else yet; a cleanup that reads the remote branch may prove it" });
			const remote = findGitHubRemote(circle.cwd, record.pr.owner, record.pr.repo, env);
			if ("name" in remote) {
				if (evidence.kind === "problem") entries.push({ kind: "remote branch", name: `${remote.name}/${record.headBranch}`, state: "unknown", detail: evidence.problem });
				else if (evidence.kind === "proven") entries.push(remoteBranchEntry(`${remote.name}/${record.headBranch}`, evidence.state, record.headSha));
				else {
					// Local tracking refs are cached evidence only: without a fresh
					// authorized read, the live remote branch is never provable.
					const trackingTip = runGit(circle.cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote.name}/${record.headBranch}`], env);
					entries.push({ kind: "remote branch", name: `${remote.name}/${record.headBranch}`, state: "unknown", detail: trackingTip === undefined
						? "no local tracking ref is cached; the remote branch is not provable until a future cleanup performs a fresh authorized read"
						: `the local tracking ref caches ${trackingTip.toLowerCase()}, which is stale evidence only; the remote branch is not provable until a future cleanup performs a fresh authorized read` });
				}
			} else {
				entries.push({ kind: "remote branch", name: `${record.pr.repo}/${record.headBranch}`, state: "unknown", detail: remote.problem });
			}
			const destinationTip = readBranchTip(circle.cwd, record.baseBranch, env);
			if (destinationTip === undefined) entries.push({ kind: "destination branch", name: record.baseBranch, state: "kept", detail: "the destination branch is absent locally" });
			else entries.push({ kind: "destination branch", name: record.baseBranch, state: "kept", detail: destinationDetail(record, circle, view).detail });
			return entries;
		};

		// Everything preview and clean must agree on lives here, evaluated against
		// live state each time instead of against the stored registration.
		const selectRecord = (argument: string, circle: SessionCircle, ctx: ExtensionContext, outcome: string): PostMergeCloseRecord | undefined => {
			const target = argument === "" ? undefined : parsePullRequestUrl(argument);
			if (argument !== "" && !target) { refuse(ctx, badOriginMessage(argument)); return undefined; }
			const records = restorePostMergeCloseRecords(sessionEntries(ctx), { sessionId: circle.sessionId, commonDir: circle.commonDir });
			if (target) {
				const matching = records.filter((candidate) => pullRequestTargetKey(candidate.pr) === pullRequestTargetKey(target));
				if (matching.length === 0) {
					refuse(ctx, `No registration for ${target.owner}/${target.repo}#${target.number} in this session and clone; run /gentle:close-change register <URL> first.`);
					return undefined;
				}
				// Hand-forged entries never widen what the command trusts.
				if (matching.some((candidate) => pinnedKey(candidate) !== pinnedKey(matching[0]))) {
					refuse(ctx, `Conflicting registrations for ${target.owner}/${target.repo}#${target.number} exist in this session; nothing will be ${outcome}.`);
					return undefined;
				}
				return matching[0];
			}
			if (records.length === 0) {
				refuse(ctx, "No /gentle:close-change registration for this session and clone yet; run /gentle:close-change register <URL> first.");
				return undefined;
			}
			const byTarget = new Map<string, PostMergeCloseRecord>();
			for (const candidate of records) {
				const previous = byTarget.get(pullRequestTargetKey(candidate.pr));
				if (previous && pinnedKey(previous) !== pinnedKey(candidate)) {
					refuse(ctx, `Conflicting registrations for ${candidate.pr.owner}/${candidate.pr.repo}#${candidate.pr.number} exist in this session; nothing will be ${outcome}.`);
					return undefined;
				}
				byTarget.set(pullRequestTargetKey(candidate.pr), candidate);
			}
			if (byTarget.size > 1) {
				refuse(ctx, `Several pull requests are registered for this session; run the command with one of their URLs: ${[...byTarget.values()].map((candidate) => candidate.pr.url).join(" ")}`);
				return undefined;
			}
			return [...byTarget.values()][0];
		};

		// A registration proves ownership only through this session's own durable
		// worktree registrations, never through the record alone: every listed
		// worktree must be the session directory or an exact, same-session
		// registration entry, and a path that still exists must still resolve into
		// the registered clone. This runs before any remote read or deletion.
		const provenanceHolds = (record: PostMergeCloseRecord, circle: SessionCircle, ctx: ExtensionContext, outcome: string): boolean => {
			const sessionWorktreeRoots = new Set<string>();
			for (const entry of sessionEntries(ctx)) {
				if (entry.type !== "custom" || entry.customType !== SESSION_WORKTREE_ENTRY) continue;
				const data = entry.data as { sessionId?: unknown; root?: unknown } | undefined;
				if (typeof data?.root === "string" && data.sessionId === circle.sessionId) sessionWorktreeRoots.add(data.root);
				// Entries of other sessions are not provenance for this one.
			}
			for (const worktree of record.worktrees) {
				let present = true;
				try { lstatSync(worktree.path); } catch { present = false; }
				const identity = present ? resolveWorktree(worktree.path, circle.cwd) : undefined;
				if (worktree.path !== circle.root && !sessionWorktreeRoots.has(worktree.path)
					|| (present && (!identity || identity.root !== worktree.path || identity.commonDir !== circle.commonDir))) {
					refuse(ctx, `The registration for ${record.pr.owner}/${record.pr.repo}#${record.pr.number} lists worktree ${worktree.path}, whose provenance this session can no longer establish (it is neither the session directory nor a same-session worktree registration resolving into the registered clone); nothing will be ${outcome}.`);
					return false;
				}
			}
			return true;
		};

		// The pull request must still be merged, still name the registered
		// branches, and still sit at the registered head commit. A reused branch
		// name or a later commit invalidates everything the registration pinned.
		const verifiedView = async (record: PostMergeCloseRecord, circle: SessionCircle, ctx: ExtensionContext, outcome: string): Promise<PullRequestView | undefined> => {
			const data = await readPullRequest(record.pr, circle, ctx);
			if (!data) return undefined;
			const view = requireMergedView(ctx, record.pr, data);
			if (!view) return undefined;
			if (view.headBranch !== record.headBranch || view.baseBranch !== record.baseBranch) {
				refuse(ctx, `The pull request head/base branch names changed since registration (now ${view.headBranch} over ${view.baseBranch}; the registration pinned ${record.headBranch} over ${record.baseBranch}), so nothing is ${outcome}.`);
				return undefined;
			}
			if (view.headSha !== record.headSha) {
				refuse(ctx, `The pull request head commit ${view.headSha} no longer matches the registered head commit ${record.headSha}; keeping the registration unchanged and doing nothing.`);
				return undefined;
			}
			return view;
		};

		// One confirm answer buys exactly one fresh read of one remote branch for
		// this session in this clone; the answer is discarded if anything drifted.
		const readRemoteEvidence = async (record: PostMergeCloseRecord, circle: SessionCircle, ctx: ExtensionContext): Promise<RemoteEvidence | undefined> => {
			const remote = findGitHubRemote(circle.cwd, record.pr.owner, record.pr.repo, env);
			if (!("name" in remote)) return { kind: "problem", problem: remote.problem };
			const message = [
				`${record.pr.owner}/${record.pr.repo}: remote branch ${remote.name}/${record.headBranch}`,
				`Session ${circle.sessionId} bound to clone ${circle.commonDir}.`,
				"This grants one `git ls-remote` read of that branch (no shell, no credential prompts); it grants nothing else and is not saved.",
			].join("\n");
			let confirmed: boolean;
			try { confirmed = await ctx.ui.confirm("Read the GitHub branch state?", message); } catch { return undefined; }
			if (!confirmed) {
				refuse(ctx, "Remote branch read declined; nothing was read from the remote and nothing changed.");
				return undefined;
			}
			if (!bindingHolds(circle, ctx)) {
				refuse(ctx, "The session or repository changed while the permission prompt was open; the remote read was cancelled and nothing changed.");
				return undefined;
			}
			const input: RemoteBranchInput = { directory: circle.cwd, remote: remote.name, branch: record.headBranch, env, timeoutMs: ghTimeoutMs };
			const state = await remoteBranchOps.readHead(input);
			if (!bindingHolds(circle, ctx)) {
				refuse(ctx, "The session or repository changed while the remote branch was being read; the answer was discarded and nothing changed.");
				return undefined;
			}
			return { kind: "proven", name: remote.name, state };
		};

		type CleanAction =
			| { kind: "worktree"; path: string; fingerprint: string }
			| { kind: "local branch"; name: string }
			| { kind: "remote branch"; name: string; remote: string }
			| { kind: "destination branch"; name: string; mergeSha: string };

		const describeAction = (action: CleanAction): string => {
			if (action.kind === "worktree") return `remove worktree ${action.path}`;
			if (action.kind === "local branch") return `delete local branch ${action.name}`;
			if (action.kind === "remote branch") return `delete remote branch ${action.name}`;
			return `fast-forward ${action.name} to ${action.mergeSha}`;
		};

		// Only what the freshly checked plan proves removable becomes an action; a
		// destination update is proposed only when a fast-forward is provable.
		const planActions = (record: PostMergeCloseRecord, circle: SessionCircle, view: PullRequestView, entries: readonly PreviewEntry[], evidence: RemoteEvidence): CleanAction[] => {
			const actions: CleanAction[] = [];
			for (const entry of entries) {
				if (entry.state !== "removable") continue;
				if (entry.kind === "worktree") {
					const worktree = record.worktrees.find((candidate) => candidate.path === entry.name);
					if (worktree) actions.push({ kind: "worktree", path: worktree.path, fingerprint: worktree.fingerprint });
				} else if (entry.kind === "local branch") {
					actions.push({ kind: "local branch", name: record.headBranch });
				} else if (entry.kind === "remote branch" && evidence.kind === "proven") {
					actions.push({ kind: "remote branch", name: entry.name, remote: evidence.name });
				}
			}
			const destination = destinationDetail(record, circle, view);
			if (destination.fastForward && view.mergeCommitSha !== undefined) actions.push({ kind: "destination branch", name: record.baseBranch, mergeSha: view.mergeCommitSha });
			return actions;
		};

		// Every action rechecks its own precondition immediately before it mutates
		// anything, so a change during the confirmation window can only turn an
		// action into "kept", never into a wider deletion.
		const runAction = async (action: CleanAction, record: PostMergeCloseRecord, circle: SessionCircle, ctx: ExtensionContext, view: PullRequestView): Promise<string> => {
			const sessionDirectory = (() => { try { return realpathSync(circle.cwd); } catch { return undefined; } })();
			if (action.kind === "worktree") {
				const verdict = worktreeVerdict({ path: action.path, fingerprint: action.fingerprint }, record, circle, sessionDirectory);
				if (verdict.state === "already gone") return `worktree ${action.path}: already gone`;
				if (verdict.state !== "removable") return `worktree ${action.path}: kept — ${verdict.detail}`;
				if (runGit(circle.root, ["worktree", "remove", action.path], env) === undefined) return `worktree ${action.path}: kept — git refused to remove it`;
				runGit(circle.root, ["worktree", "prune"], env);
				return `worktree ${action.path}: removed`;
			}
			if (action.kind === "local branch") {
				const tip = readBranchTip(circle.cwd, action.name, env);
				if (tip === undefined) return `local branch ${action.name}: already gone`;
				if (tip.toLowerCase() !== record.headSha) return `local branch ${action.name}: kept — it moved to ${tip} since the plan was checked`;
				if (runGit(circle.cwd, ["branch", "-D", action.name], env) === undefined) return `local branch ${action.name}: kept — git refused to delete it`;
				return `local branch ${action.name}: deleted`;
			}
			if (action.kind === "remote branch") {
				const input: RemoteBranchInput = { directory: circle.cwd, remote: action.remote, branch: record.headBranch, env, timeoutMs: ghTimeoutMs };
				const state = await remoteBranchOps.readHead(input);
				if (state.state === "absent") return `remote branch ${action.name}: already gone`;
				if (state.state === "unknown") return `remote branch ${action.name}: kept — ${state.reason}`;
				if (state.sha !== record.headSha) return `remote branch ${action.name}: kept — it now points at ${state.sha}, not the registered head commit`;
				const outcome = await remoteBranchOps.deleteBranch(input);
				// `strict` is off in tsconfig, so only the explicit `=== true` check
				// narrows this boolean-literal union; truthiness would keep both arms.
				if (outcome.ok === true) return `remote branch ${action.name}: deleted`;
				return `remote branch ${action.name}: kept — ${outcome.reason}`;
			}
			const destinationTip = readBranchTip(circle.cwd, record.baseBranch, env);
			if (destinationTip === undefined) return `destination branch ${action.name}: kept — it is absent locally`;
			if (!destinationDetail(record, circle, view).fastForward) return `destination branch ${action.name}: kept — a fast-forward is no longer provable`;
			const holder = [circle.root, ...registeredRoots(circle, ctx)].find((candidate) => {
				const identity = resolveWorktree(candidate, circle.cwd);
				if (!identity || identity.commonDir !== circle.commonDir) return false;
				return checkedOutHeadAt(identity.root, record.baseBranch, destinationTip, env) && runGit(identity.root, ["status", "--porcelain"], env) === "";
			});
			if (holder === undefined) return `destination branch ${action.name}: kept — no clean worktree of this session holds it checked out`;
			if (runGit(holder, ["merge", "--ff-only", action.mergeSha], env) === undefined) return `destination branch ${action.name}: kept — the fast-forward was refused`;
			return `destination branch ${action.name}: fast-forwarded to ${action.mergeSha}`;
		};

		const preview = async (argument: string, ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return withoutUi(ctx);
			const circle = sessionCircle(ctx);
			if (!circle) return refuse(ctx, "This command needs a live session bound to a Git worktree; nothing was previewed.");
			const record = selectRecord(argument, circle, ctx, "previewed");
			if (!record) return;
			if (!provenanceHolds(record, circle, ctx, "previewed")) return;
			const view = await verifiedView(record, circle, ctx, "previewed");
			if (!view) return;
			const lines = [
				`Post-merge preview for ${record.pr.owner}/${record.pr.repo}#${record.pr.number} (merged at ${view.mergedAt}); nothing has been changed:`,
				...formatPreviewEntries(previewEntries(record, circle, view, { kind: "cached" })),
				"No deletion or update has run; run `clean` to read the remote branch and, after one confirmation, act on this plan.",
			];
			notify(ctx, lines.join("\n"), "info");
		};

		// Cleanup is the only mutating action: one fresh remote read, one exact
		// confirmation, then a per-action recheck. Nothing outside the proven plan
		// is touched, and a declined confirmation changes nothing.
		const clean = async (argument: string, ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return withoutUi(ctx);
			const circle = sessionCircle(ctx);
			if (!circle) return refuse(ctx, "This command needs a live session bound to a Git worktree; nothing was cleaned.");
			const record = selectRecord(argument, circle, ctx, "cleaned");
			if (!record) return;
			if (!provenanceHolds(record, circle, ctx, "cleaned")) return;
			const view = await verifiedView(record, circle, ctx, "cleaned");
			if (!view) return;
			const evidence = await readRemoteEvidence(record, circle, ctx);
			if (!evidence) return;
			const entries = previewEntries(record, circle, view, evidence);
			const actions = planActions(record, circle, view, entries, evidence);
			const header = `Post-merge cleanup for ${record.pr.owner}/${record.pr.repo}#${record.pr.number} (merged at ${view.mergedAt}):`;
			if (actions.length === 0) {
				notify(ctx, [header, ...formatPreviewEntries(entries), "Nothing is provable as removable right now, so nothing was removed and nothing changed."].join("\n"), "info");
				return;
			}
			const confirmation = [
				header,
				...formatPreviewEntries(entries),
				"",
				"Exactly these actions will run, each rechecked immediately before it runs:",
				...actions.map((action) => `  ${describeAction(action)}`),
				"This deletes local resources of this clone; the destination branch is only fast-forwarded and is never deleted.",
			].join("\n");
			let confirmed: boolean;
			try { confirmed = await ctx.ui.confirm("Run this cleanup?", confirmation); } catch { confirmed = false; }
			if (!confirmed) return refuse(ctx, "Cleanup declined; nothing was removed and nothing changed.");
			if (!bindingHolds(circle, ctx)) return refuse(ctx, "The session or repository changed while the confirmation was open; nothing was removed.");
			const results: string[] = [];
			for (const action of actions) results.push(await runAction(action, record, circle, ctx, view));
			notify(ctx, [header, ...results, "The registration and the pull request are unchanged."].join("\n"), "info");
		};

		pi.registerCommand("gentle:close-change", {
			description: "Associate a merged pull request with this session, preview its cleanup, and run it after confirmation (register|preview|clean).",
			getArgumentCompletions: (prefix) => ["register", "preview", "clean", "help"].filter((action) => action.startsWith(prefix.trim())).map((action) => ({ value: action, label: action })),
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				const split = trimmed.search(/\s/);
				const action = (split === -1 ? trimmed : trimmed.slice(0, split)).toLowerCase();
				const argument = split === -1 ? "" : trimmed.slice(split + 1).trim();
				if (trimmed === "" || action === "help") { notify(ctx, CLOSE_CHANGE_USAGE, "info"); return; }
				if (action === "register") return await register(argument, ctx);
				if (action === "preview") return await preview(argument, ctx);
				if (action === "clean") return await clean(argument, ctx);
				notify(ctx, CLOSE_CHANGE_USAGE, "warning");
			},
		});
	};
}

export default function postMergeClose(pi: ExtensionAPI): void {
	createPostMergeCloseExtension()(pi);
}
