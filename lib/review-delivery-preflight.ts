import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { NativeReviewCli } from "./native-review-cli.ts";
import { recognizeDeliveryCommands } from "./destructive-command-guard.ts";
import { resolveSessionWorktree, worktreeGitEnvironment } from "./session-worktree-registry.ts";

type Key = string | symbol;
type Scope = { key: Key; root: string; baseRef: string; identity: string; generation: number; assessed: boolean };
type Denial = { block: true; reason: string };
const deny = (reason: string): Denial => ({ block: true, reason: `RDD pre-delivery: ${reason} This delivery command was not run. Review outcomes do not authorize delivery.` });

// HEAD plus resolved base: a scope hint, never a cached verdict or receipt.
async function identity(root: string, baseRef: string): Promise<string | undefined> {
	return new Promise(done => execFile("git", ["rev-parse", "--revs-only", "--end-of-options", "HEAD^{commit}", `${baseRef}^{commit}`],
		{ cwd: root, encoding: "utf8", timeout: 2_000, maxBuffer: 4096, windowsHide: true, env: worktreeGitEnvironment() },
		(error, stdout) => {
			const ids = stdout.trim().split(/\r?\n/);
			done(!error && ids.length === 2 && ids.every(id => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)) ? ids.join("\n") : undefined);
		}));
}

export class ReviewDeliveryPreflight {
	private scopes = new Map<Key, Map<string, Scope>>();
	private generation = 0;
	clear(): void { this.generation++; this.scopes.clear(); }
	async capture(key: Key, root: string, baseRef: string): Promise<Scope | undefined> {
		let roots = this.scopes.get(key);
		if (!roots) {
			if (this.scopes.size >= 128) this.scopes.clear();
			this.scopes.set(key, roots = new Map());
		}
		if (roots.size >= 128) roots.clear();
		const scope: Scope = { key, root, baseRef, identity: "", generation: this.generation, assessed: false };
		roots.set(root, scope);
		const snapshot = await identity(root, baseRef);
		if (!snapshot || !this.current(scope)) return undefined;
		scope.identity = snapshot;
		return scope;
	}
	private current(scope: Scope): boolean {
		return scope.generation === this.generation && this.scopes.get(scope.key)?.get(scope.root) === scope;
	}
	async remember(scope: Scope | undefined): Promise<void> {
		if (scope && this.current(scope) && await identity(scope.root, scope.baseRef) === scope.identity && this.current(scope)) scope.assessed = true;
	}

	async check(key: Key, cwd: string, toolName: string, command: string, cli: NativeReviewCli | null,
		declined: (root: string, target: string) => boolean, signal?: AbortSignal): Promise<Denial | undefined> {
		const deliveries = recognizeDeliveryCommands(command);
		if (!deliveries.length || !cli?.reviewMode) return undefined;
		if (signal?.aborted) return deny("Preflight was cancelled.");
		const generation = this.generation;
		const bounded = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
		let abort!: () => void;
		const expired = new Promise<Denial>(done => { abort = () => done(deny("The bounded preflight was cancelled or timed out; repeat assessment before delivery.")); bounded.addEventListener("abort", abort, { once: true }); });
		const run = async (): Promise<Denial | undefined> => {
			const delivery = deliveries[0];
			const targets = deliveries.map(delivery => {
				const target = (delivery.directories ?? []).reduce((base, directory) => resolve(base, directory), cwd);
				const worktree = resolveSessionWorktree(target, cwd);
				return { root: worktree?.root ?? target, worktree };
			});
			const { root, worktree } = targets[0];
			try {
				let enabled = false;
				for (const targetRoot of new Set(targets.map(target => target.root))) {
					const mode = await cli.reviewMode!({ cwd: targetRoot, operation: "status", signal: bounded });
					if (bounded.aborted || generation !== this.generation) return deny("Session changed during preflight; assess again.");
					if (mode.status.effective !== "off" && mode.status.effective !== "on") return deny("RDD mode is unavailable; resolve it before delivery.");
					enabled ||= mode.status.effective === "on";
				}
				if (!enabled) return undefined;
				if (!worktree) return deny("Select an existing Git worktree and assess its explicit committed range with gentle_review before delivery.");
				if (deliveries.length !== 1 || !delivery.standalone || toolName !== "bash") return deny("Separate commit, waits and delivery into distinct foreground tool calls so the committed range can be checked immediately before delivery.");
				const scope = this.scopes.get(key)?.get(root);
				if (!scope?.assessed || await identity(root, scope.baseRef) !== scope.identity) return deny('Run gentle_review assess with workspaceRoot and input {"baseRef":"<actual slice base>","committedOnly":true}; the committed-range scope is missing or changed.');
				if (bounded.aborted || generation !== this.generation) return deny("Session changed during preflight; assess again.");
				if (!cli.assess) return deny("Native assessment is unavailable; resolve it before delivery.");
				const assessment = await cli.assess({ cwd: root, baseRef: scope.baseRef, committedOnly: true, untrackedScope: "exclude", signal: bounded });
				if (bounded.aborted || generation !== this.generation) return deny("Session changed during preflight; assess again.");
				if (assessment.candidate.kind !== "base-diff" || assessment.candidate.baseRef !== scope.baseRef || typeof assessment.reviewDue !== "boolean") return deny("Native assessment did not confirm the selected committed range.");
				if (assessment.reviewDue) {
					const status = await cli.targetStatus?.({ cwd: root, baseRef: scope.baseRef, committedOnly: true, untrackedScope: "exclude", agent: "pi", signal: bounded });
					if (!status || status.applicability !== "current_target" || status.projection.kind !== "base-diff" || !declined(root, status.targetIdentity)) return deny("Native assessment reports a due review. Resume a bound lineage or inspect and follow the facade's native transitions, including human consent and exact acknowledgement, before delivery.");
				}
				if (bounded.aborted || !this.current(scope) || await identity(root, scope.baseRef) !== scope.identity || !this.current(scope)) return deny("The committed range or session changed during preflight; assess again.");
				return undefined;
			} catch { return deny("Native preflight is unavailable; resolve it and assess the explicit range before delivery."); }
		};
		try { return await Promise.race([run(), expired]); }
		finally { bounded.removeEventListener("abort", abort); }
	}
}
