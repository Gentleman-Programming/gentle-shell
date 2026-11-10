import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstatSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import {
	CLOSE_CHANGE_USAGE,
	POST_MERGE_CLOSE_ENTRY,
	checkedOutHeadAt,
	findGitHubRemote,
	formatPreviewEntries,
	gitIsAncestor,
	parsePullRequestUrl,
	pullRequestTargetKey,
	readBranchTip,
	restorePostMergeCloseRecords,
	runGhPullRequestView,
	runGit,
	validatePullRequestView,
	worktreeCloseFingerprint,
	type PostMergeCloseRecord,
	type PreviewEntry,
	type PullRequestRef,
	type PullRequestView,
	type SessionEntryLike,
} from "../lib/post-merge-close.ts";
import { resolveSessionWorktree, resolveSessionWorktreeWithGit, SESSION_WORKTREE_ENTRY, type WorktreeResolver } from "../lib/session-worktree-registry.ts";

// Safe post-merge change closure (odd/tasks/post-merge-close.md, T1): an
// explicit, session-bound command that associates an actually merged,
// same-repository pull request with this session's own worktrees and previews
// a future cleanup. This task changes nothing: cleanup is a later, separately
// confirmed step, and every remote read needs a fresh, target-bound consent.

export interface PostMergeCloseOptions {
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** Bounded timeout for every `gh` child, in milliseconds. */
	ghTimeoutMs?: number;
	resolveWorktree?: WorktreeResolver;
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

export function createPostMergeCloseExtension(options: PostMergeCloseOptions = {}): (pi: ExtensionAPI) => void {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const ghTimeoutMs = options.ghTimeoutMs ?? GH_DEFAULT_TIMEOUT_MS;
	const resolveWorktree = options.resolveWorktree ?? resolveSessionWorktree;
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

		const destinationDetail = (record: PostMergeCloseRecord, circle: SessionCircle, mergeCommitSha: string | undefined): string => {
			if (mergeCommitSha === undefined) return "the merge commit is unknown locally, so no fast-forward answer is possible";
			const ancestor = gitIsAncestor(circle.cwd, `refs/heads/${record.baseBranch}`, mergeCommitSha, env);
			if (ancestor === undefined) return "the fast-forward state could not be checked locally";
			return ancestor
				? "a later cleanup may fast-forward it to the merge commit"
				: "has commits the merge commit does not include, so a later cleanup would refuse to update it";
		};

		const previewEntries = (record: PostMergeCloseRecord, circle: SessionCircle, view: PullRequestView): PreviewEntry[] => {
			const entries: PreviewEntry[] = [];
			const sessionDirectory = (() => { try { return realpathSync(circle.cwd); } catch { return undefined; } })();
			for (const worktree of record.worktrees) {
				let present = true;
				try { lstatSync(worktree.path); } catch { present = false; }
				if (!present) { entries.push({ kind: "worktree", name: worktree.path, state: "already gone" }); continue; }
				const identity = resolveWorktree(worktree.path, circle.cwd);
				if (!identity || identity.root !== worktree.path) { entries.push({ kind: "worktree", name: worktree.path, state: "kept", detail: "the path is no longer a worktree of the registered clone" }); continue; }
				if (identity.commonDir !== circle.commonDir) { entries.push({ kind: "worktree", name: worktree.path, state: "kept", detail: "the path now belongs to a different clone" }); continue; }
				if (worktreeCloseFingerprint(identity.root, circle.commonDir) !== worktree.fingerprint) { entries.push({ kind: "worktree", name: worktree.path, state: "kept", detail: "the worktree changed since it was registered" }); continue; }
				if (sessionDirectory !== undefined && (sessionDirectory === worktree.path || sessionDirectory.startsWith(`${worktree.path}${sep}`))) {
					entries.push({ kind: "worktree", name: worktree.path, state: "kept", detail: "this session's current directory is inside it" });
					continue;
				}
				const status = runGit(identity.root, ["status", "--porcelain"], env);
				if (status === undefined) { entries.push({ kind: "worktree", name: worktree.path, state: "unknown", detail: "git could not read the worktree state" }); continue; }
				if (status.length > 0) { entries.push({ kind: "worktree", name: worktree.path, state: "kept", detail: "has uncommitted changes" }); continue; }
				// A clean worktree is only removable while its checked-out branch
				// still sits exactly at the registered head commit; anything else
				// (an extra commit, a branch switch) is kept with the reason.
				if (!checkedOutHeadAt(identity.root, record.headBranch, record.headSha, env)) {
					entries.push({ kind: "worktree", name: worktree.path, state: "kept", detail: "its checked-out branch no longer sits at the registered head commit" });
					continue;
				}
				entries.push({ kind: "worktree", name: worktree.path, state: "removable", detail: "clean git worktree" });
			}
			const tip = readBranchTip(circle.cwd, record.headBranch, env);
			if (tip === undefined) entries.push({ kind: "local branch", name: record.headBranch, state: "already gone", detail: "the local branch is gone" });
			else if (tip.toLowerCase() === record.headSha) entries.push({ kind: "local branch", name: record.headBranch, state: "removable", detail: `still points at the registered head commit ${record.headSha}` });
			else entries.push({ kind: "local branch", name: record.headBranch, state: "kept", detail: "has commits beyond the registered head commit" });
			const remote = findGitHubRemote(circle.cwd, record.pr.owner, record.pr.repo, env);
			if ("name" in remote) {
				// Local tracking refs are cached evidence only: until T2 adds a
				// fresh authorized read of the remote ref, the live remote branch
				// is never provable from them, whatever they locally contain.
				const trackingTip = runGit(circle.cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote.name}/${record.headBranch}`], env);
				entries.push({ kind: "remote branch", name: `${remote.name}/${record.headBranch}`, state: "unknown", detail: trackingTip === undefined
					? "no local tracking ref is cached; the remote branch is not provable until a future cleanup performs a fresh authorized read"
					: `the local tracking ref caches ${trackingTip.toLowerCase()}, which is stale evidence only; the remote branch is not provable until a future cleanup performs a fresh authorized read` });
			} else {
				entries.push({ kind: "remote branch", name: `${record.pr.repo}/${record.headBranch}`, state: "unknown", detail: remote.problem });
			}
			const destinationTip = readBranchTip(circle.cwd, record.baseBranch, env);
			if (destinationTip === undefined) entries.push({ kind: "destination branch", name: record.baseBranch, state: "kept", detail: "the destination branch is absent locally" });
			else entries.push({ kind: "destination branch", name: record.baseBranch, state: "kept", detail: destinationDetail(record, circle, view.mergeCommitSha) });
			return entries;
		};

		const preview = async (argument: string, ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return withoutUi(ctx);
			const target = argument === "" ? undefined : parsePullRequestUrl(argument);
			if (argument !== "" && !target) return refuse(ctx, badOriginMessage(argument));
			const circle = sessionCircle(ctx);
			if (!circle) return refuse(ctx, "This command needs a live session bound to a Git worktree; nothing was previewed.");
			const records = restorePostMergeCloseRecords(sessionEntries(ctx), { sessionId: circle.sessionId, commonDir: circle.commonDir });
			let record: PostMergeCloseRecord | undefined;
			if (target) {
				const matching = records.filter((candidate) => pullRequestTargetKey(candidate.pr) === pullRequestTargetKey(target));
				if (matching.length === 0) {
					refuse(ctx, `No registration for ${target.owner}/${target.repo}#${target.number} in this session and clone; run /gentle:close-change register <URL> first.`);
					return;
				}
				// Hand-forged entries never widen what a preview trusts.
				if (matching.some((candidate) => pinnedKey(candidate) !== pinnedKey(matching[0]))) {
					refuse(ctx, `Conflicting registrations for ${target.owner}/${target.repo}#${target.number} exist in this session; nothing will be previewed.`);
					return;
				}
				record = matching[0];
			} else if (records.length === 0) {
				refuse(ctx, "No /gentle:close-change registration for this session and clone yet; run /gentle:close-change register <URL> first.");
				return;
			} else {
				const byTarget = new Map<string, PostMergeCloseRecord>();
				for (const candidate of records) {
					const previous = byTarget.get(pullRequestTargetKey(candidate.pr));
					if (previous && pinnedKey(previous) !== pinnedKey(candidate)) {
						refuse(ctx, `Conflicting registrations for ${candidate.pr.owner}/${candidate.pr.repo}#${candidate.pr.number} exist in this session; nothing will be previewed.`);
						return;
					}
					byTarget.set(pullRequestTargetKey(candidate.pr), candidate);
				}
				if (byTarget.size > 1) {
					refuse(ctx, `Several pull requests are registered for this session; run preview with one of their URLs: ${[...byTarget.values()].map((candidate) => candidate.pr.url).join(" ")}`);
					return;
				}
				record = [...byTarget.values()][0];
			}
			const readTarget = record.pr;
			// A registration proves ownership only through this session's own
			// durable worktree registrations, never through the record alone:
			// every listed worktree must be the session directory or an exact,
			// same-session registration entry, and a path that still exists must
			// still resolve into the registered clone. Anything else fails
			// closed here, before the remote read.
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
					refuse(ctx, `The registration for ${readTarget.owner}/${readTarget.repo}#${readTarget.number} lists worktree ${worktree.path}, whose provenance this session can no longer establish (it is neither the session directory nor a same-session worktree registration resolving into the registered clone); refusing the preview.`);
					return;
				}
			}
			const data = await readPullRequest(readTarget, circle, ctx);
			if (!data) return;
			const view = requireMergedView(ctx, readTarget, data);
			if (!view) return;
			if (view.headBranch !== record.headBranch || view.baseBranch !== record.baseBranch) {
				refuse(ctx, `The pull request head/base branch names changed since registration (now ${view.headBranch} over ${view.baseBranch}; the registration pinned ${record.headBranch} over ${record.baseBranch}), so nothing is previewed.`);
				return;
			}
			if (view.headSha !== record.headSha) {
				refuse(ctx, `The pull request head commit ${view.headSha} no longer matches the registered head commit ${record.headSha}; keeping the registration unchanged and showing nothing.`);
				return;
			}
			const lines = [
				`Post-merge preview for ${readTarget.owner}/${readTarget.repo}#${readTarget.number} (merged at ${view.mergedAt}); nothing has been changed:`,
				...formatPreviewEntries(previewEntries(record, circle, view)),
				"No deletion or update has run; the actual cleanup arrives in a later, separately confirmed step.",
			];
			notify(ctx, lines.join("\n"), "info");
		};

		pi.registerCommand("gentle:close-change", {
			description: "Associate a merged pull request with this session and preview its later cleanup (register|preview).",
			getArgumentCompletions: (prefix) => ["register", "preview", "help"].filter((action) => action.startsWith(prefix.trim())).map((action) => ({ value: action, label: action })),
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				const split = trimmed.search(/\s/);
				const action = (split === -1 ? trimmed : trimmed.slice(0, split)).toLowerCase();
				const argument = split === -1 ? "" : trimmed.slice(split + 1).trim();
				if (trimmed === "" || action === "help") { notify(ctx, CLOSE_CHANGE_USAGE, "info"); return; }
				if (action === "register") return await register(argument, ctx);
				if (action === "preview") return await preview(argument, ctx);
				notify(ctx, CLOSE_CHANGE_USAGE, "warning");
			},
		});
	};
}

export default function postMergeClose(pi: ExtensionAPI): void {
	createPostMergeCloseExtension()(pi);
}
