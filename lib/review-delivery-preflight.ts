import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";
import { NATIVE_UNTRACKED_SCOPE, normalizeNativeReviewCwd, type NativeReviewCli } from "./native-review-cli.ts";
import { recognizeReviewDeliveryActions } from "./destructive-command-guard.ts";
import { resolveSessionWorktree, worktreeGitEnvironment } from "./session-worktree-registry.ts";

type Denial = { block: true; reason: string };
const deny = (reason: string): Denial => ({ block: true, reason: `RDD pre-delivery: ${reason} This delivery command was not run. Review outcomes do not authorize delivery.` });
const isDenial = (value: unknown): value is Denial => typeof value === "object" && value !== null && (value as Denial).block === true;

/** Reads answer in well under a second; only the native assessment is slow enough to exhaust a shared budget. */
const READ_TIMEOUT_MS = 10_000;
const ASSESS_TIMEOUT_MS = 120_000;
const PREFLIGHT_TIMEOUT_ENV = "GENTLE_RDD_PREFLIGHT_TIMEOUT_MS";

/**
 * gentle-pi#3200: one fixed 10 s bound was shared by the mode read, two `git rev-parse` calls and the
 * native assessment. Where `assess` alone takes 22 s, every push was denied. Each phase now carries
 * its own budget, and the assessment budget is the one a caller can raise.
 */
export function preflightTimeouts(env: Record<string, string | undefined>): { readMs: number; assessMs: number } {
	const raw = env[PREFLIGHT_TIMEOUT_ENV]?.trim();
	const override = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
	return { readMs: READ_TIMEOUT_MS, assessMs: Number.isSafeInteger(override) && override > 0 ? override : ASSESS_TIMEOUT_MS };
}

/**
 * gentle-pi#3066: Git Bash reports `/c/Users/ana/repo`. Resolved against a Windows base that becomes
 * `C:\c\Users\ana\repo`, a directory that does not exist, so the native client failed and the preflight
 * reported an unavailable preflight. Normalize to the native path first, so an absolute path stays absolute.
 */
export function deliveryTarget(base: string, directory: string, platform: NodeJS.Platform = process.platform): string {
	return (platform === "win32" ? win32.resolve : posix.resolve)(base, normalizeNativeReviewCwd(directory, platform));
}

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
	const timeouts = preflightTimeouts(process.env);
	const cancellation = () => deny("Session changed during preflight; assess again.");
	/**
	 * Every read and the assessment carry their own budget. A single bound for the whole preflight let a
	 * slow assessment spend the read budget of the reads that follow it, which is the same denial as a
	 * bound that is too short (gentle-pi#3200). The deadline also fires when a caller ignores its signal.
	 */
	const phase = async <T>(budgetMs: number, expired: () => Denial, call: (bound: AbortSignal) => Promise<T>): Promise<T | Denial> => {
		const bound = AbortSignal.any([AbortSignal.timeout(budgetMs), ...(signal ? [signal] : [])]);
		const deadline = new Promise<Denial>(done => bound.addEventListener("abort", () => done(signal?.aborted ? cancellation() : expired()), { once: true }));
		const value = await Promise.race([call(bound), deadline]);
		if (isDenial(value)) return value;
		return current() ? value : cancellation();
	};
	const read = <T>(call: (bound: AbortSignal) => Promise<T>) =>
		phase(timeouts.readMs, () => deny(`The native review read did not answer within ${timeouts.readMs} ms; resolve the native client before delivery.`), call);
	const assess = <T>(call: (bound: AbortSignal) => Promise<T>) =>
		phase(timeouts.assessMs, () => deny(`The native assessment did not answer within ${timeouts.assessMs} ms (raise ${PREFLIGHT_TIMEOUT_ENV}); inspect the native client before delivery.`), call);
	const run = async (): Promise<Denial | undefined> => {
		try {
			const checked: Array<{ root: string; baseRef: string; before: string }> = [];
			const roots = new Set(deliveries.map(delivery => {
				const target = (delivery.directories ?? []).reduce((base, directory) => deliveryTarget(base, directory), cwd);
				return resolveSessionWorktree(target, cwd)?.root ?? target;
			}));
			for (const root of roots) {
				const mode = await read(bound => cli.reviewMode!({ cwd: root, operation: "status", signal: bound }));
				if (isDenial(mode)) return mode;
				if (mode.status.effective === "off") continue;
				if (mode.status.effective !== "on") return deny("RDD mode is unavailable; resolve it before delivery.");
				if (toolName !== "bash" || deliveries.some(delivery => delivery.background) || actions.some(action => action.kind === "change")) return deny("Finish candidate-changing commands or background waits separately, then issue delivery so the resulting commits can be assessed.");
				const baseRef = baseRefFor(root);
				if (!baseRef) return deny('Select the actual committed range with gentle_review assess input {"baseRef":"<slice base>","committedOnly":true}.');
				const before = await read(() => identity(root, baseRef));
				if (isDenial(before)) return before;
				if (!before || !cli.assess) return deny("The selected base or native assessment is unavailable; resolve it before delivery.");
				const untracked = await read(bound => committedRangeUntrackedExclusion(cli, root, baseRef, bound));
				if (isDenial(untracked)) return untracked;
				const assessment = await assess(bound => cli.assess!({ cwd: root, baseRef, committedOnly: true, ...untracked, signal: bound }));
				if (isDenial(assessment)) return assessment;
				if (assessment.candidate.kind !== "base-diff" || assessment.candidate.baseRef !== baseRef || typeof assessment.reviewDue !== "boolean") return deny("Native assessment did not confirm the selected committed range.");
				if (assessment.reviewDue) {
					const status = await read(bound => cli.targetStatus ? cli.targetStatus({ cwd: root, baseRef, committedOnly: true, agent: "pi", signal: bound }) : Promise.resolve(undefined));
					if (!status || isDenial(status) || status.applicability !== "current_target" || status.projection.kind !== "base-diff" || !declined(root, status.targetIdentity)) return deny("Native assessment reports a due review. Resume the bound review or inspect and follow its native transitions and human consent before delivery.");
				}
				checked.push({ root, baseRef, before });
			}
			for (const { root, baseRef, before } of checked) {
				if (baseRefFor(root) !== baseRef) return deny("The range or session changed during preflight; assess again.");
				const after = await read(() => identity(root, baseRef));
				if (isDenial(after)) return after;
				if (after !== before || !current()) return deny("The range or session changed during preflight; assess again.");
			}
			return undefined;
		} catch { return deny("Native preflight is unavailable; resolve it before delivery."); }
	};
	return run();
}
