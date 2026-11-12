import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { NATIVE_UNTRACKED_SCOPE, type NativeReviewCli } from "./native-review-cli.ts";
import { recognizeReviewDeliveryActions } from "./destructive-command-guard.ts";
import { resolveSessionWorktree, worktreeGitEnvironment } from "./session-worktree-registry.ts";

type Denial = { block: true; reason: string };
const deny = (reason: string): Denial => ({ block: true, reason: `RDD pre-delivery: ${reason} This delivery command was not run. Review outcomes do not authorize delivery.` });

// Compare HEAD/base around this read, without retaining a verdict or snapshot.
async function identity(root: string, baseRef: string): Promise<string | undefined> {
	return new Promise(done => execFile("git", ["rev-parse", "--revs-only", "--end-of-options", "HEAD^{commit}", `${baseRef}^{commit}`],
		{ cwd: root, encoding: "utf8", timeout: 2_000, maxBuffer: 4096, windowsHide: true, env: worktreeGitEnvironment() },
		(error, stdout) => {
			const ids = stdout.trim().split(/\r?\n/);
			done(!error && ids.length === 2 && ids.every(id => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)) ? ids.join("\n") : undefined);
		}));
}

/**
 * gentle-shell#3169: native assess refuses a committed-only range while any
 * untracked file exists (a PR body written for `gh pr create --body-file`)
 * unless the untracked inventory is declared. A base-diff snapshot never
 * includes untracked files, so excluding them leaves the assessed range
 * unchanged. The digest comes only from native status; without it nothing is
 * declared and native keeps deciding.
 */
export async function committedRangeUntrackedExclusion(cli: Pick<NativeReviewCli, "targetStatus"> | null | undefined, cwd: string, baseRef: string,
	signal?: AbortSignal): Promise<{ untrackedScope?: typeof NATIVE_UNTRACKED_SCOPE.EXCLUDE; expectedUntrackedInventory?: string }> {
	if (!cli?.targetStatus) return {};
	try {
		const inventory = (await cli.targetStatus({ cwd, baseRef, committedOnly: true, agent: "pi", ...(signal ? { signal } : {}) })).eligibleUntrackedInventory;
		return typeof inventory === "string" && inventory ? { untrackedScope: NATIVE_UNTRACKED_SCOPE.EXCLUDE, expectedUntrackedInventory: inventory } : {};
	} catch { return {}; }
}

/** One fresh check per repository/batch. The existing session registry supplies only a base-ref hint. */
export async function checkReviewDeliveryPreflight(cwd: string, toolName: string, command: string, cli: NativeReviewCli | null,
	baseRefFor: (root: string) => string | undefined, declined: (root: string, target: string) => boolean,
	signal?: AbortSignal, current: () => boolean = () => true): Promise<Denial | undefined> {
	const actions = recognizeReviewDeliveryActions(command), deliveries = actions.filter(action => action.kind === "delivery");
	if (!deliveries.length || !cli?.reviewMode) return undefined;
	if (deliveries.some(delivery => delivery.unresolvedDirectory)) return deny("The delivery repository cannot be resolved from this directory or Git/environment redirect; run delivery inside its repository or use literal cd or git -C.");
	if (signal?.aborted || !current()) return deny("Preflight was cancelled or its session changed.");
	const bounded = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
	let abort!: () => void;
	const expired = new Promise<Denial>(done => { abort = () => done(deny("The bounded preflight was cancelled or timed out.")); bounded.addEventListener("abort", abort, { once: true }); });
	const run = async (): Promise<Denial | undefined> => {
		try {
			const checked: Array<{ root: string; baseRef: string; before: string }> = [];
			const roots = new Set(deliveries.map(delivery => {
				const target = (delivery.directories ?? []).reduce((base, directory) => resolve(base, directory), cwd);
				return resolveSessionWorktree(target, cwd)?.root ?? target;
			}));
			for (const root of roots) {
				const mode = await cli.reviewMode!({ cwd: root, operation: "status", signal: bounded });
				if (bounded.aborted || !current()) return deny("Session changed during preflight; assess again.");
				if (mode.status.effective === "off") continue;
				if (mode.status.effective !== "on") return deny("RDD mode is unavailable; resolve it before delivery.");
				if (toolName !== "bash" || deliveries.some(delivery => delivery.background) || actions.some(action => action.kind === "change")) return deny("Finish candidate-changing commands or background waits separately, then issue delivery so the resulting commits can be assessed.");
				const baseRef = baseRefFor(root);
				if (!baseRef) return deny('Select the actual committed range with gentle_review assess input {"baseRef":"<slice base>","committedOnly":true}.');
				const before = await identity(root, baseRef);
				if (!before || !cli.assess) return deny("The selected base or native assessment is unavailable; resolve it before delivery.");
				if (bounded.aborted || !current()) return deny("Session changed during preflight; assess again.");
				const untracked = await committedRangeUntrackedExclusion(cli, root, baseRef, bounded);
				if (bounded.aborted || !current()) return deny("Session changed during preflight; assess again.");
				const assessment = await cli.assess({ cwd: root, baseRef, committedOnly: true, ...untracked, signal: bounded });
				if (bounded.aborted || !current()) return deny("Session changed during preflight; assess again.");
				if (assessment.candidate.kind !== "base-diff" || assessment.candidate.baseRef !== baseRef || typeof assessment.reviewDue !== "boolean") return deny("Native assessment did not confirm the selected committed range.");
				if (assessment.reviewDue) {
					const status = await cli.targetStatus?.({ cwd: root, baseRef, committedOnly: true, agent: "pi", signal: bounded });
					if (!status || status.applicability !== "current_target" || status.projection.kind !== "base-diff" || !declined(root, status.targetIdentity)) return deny("Native assessment reports a due review. Resume the bound review or inspect and follow its native transitions and human consent before delivery.");
				}
				checked.push({ root, baseRef, before });
			}
			for (const { root, baseRef, before } of checked) {
				if (bounded.aborted || !current() || baseRefFor(root) !== baseRef || await identity(root, baseRef) !== before || !current()) return deny("The range or session changed during preflight; assess again.");
			}
			return undefined;
		} catch { return deny("Native preflight is unavailable; resolve it before delivery."); }
	};
	try { return await Promise.race([run(), expired]); }
	finally { bounded.removeEventListener("abort", abort); }
}
