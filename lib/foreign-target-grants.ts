import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorktreeIdentity } from "./session-worktree-registry.ts";

// Deliberately ephemeral: no session entries or disk persistence can restore consent.
export class ForeignTargetGrants {
	private readonly grants = new Map<string, Set<string>>();
	private manager?: ExtensionContext["sessionManager"];
	private sessionId?: string;

	async authorize(ctx: Pick<ExtensionContext, "sessionManager" | "hasUI" | "ui">, target: WorktreeIdentity, options: { continuation?: boolean; signal?: AbortSignal } = {}): Promise<void> {
		if (options.signal?.aborted) throw new Error("Foreign clone authorization aborted.");
		const id = ctx.sessionManager.getSessionId();
		if (!id) throw new Error("Foreign target requires an active session identity.");
		if (this.manager !== ctx.sessionManager || this.sessionId !== id) {
			this.grants.clear();
			this.manager = ctx.sessionManager;
			this.sessionId = id;
		}
		if (this.grants.get(id)?.has(target.commonDir)) return;
		if (options.continuation) throw new Error("Foreign clone continuation grant was lost; start a new explicit launch.");
		if (!ctx.hasUI || !ctx.ui?.confirm || await ctx.ui.confirm("Authorize foreign clone subagent", `Launch a subagent in ${target.root}? Git common directory: ${target.commonDir}. This grant applies only to this live session and clone.`) !== true) throw new Error("Foreign clone requires interactive human consent before launch.");
		if (options.signal?.aborted) throw new Error("Foreign clone authorization aborted.");
		if (ctx.sessionManager !== this.manager || ctx.sessionManager.getSessionId() !== id) throw new Error("Session identity changed during foreign clone authorization.");
		const grants = this.grants.get(id) ?? new Set<string>();
		grants.add(target.commonDir);
		this.grants.set(id, grants);
	}

	assertCurrent(ctx: Pick<ExtensionContext, "sessionManager">, target: WorktreeIdentity): void {
		if (ctx.sessionManager !== this.manager || !this.sessionId || ctx.sessionManager.getSessionId() !== this.sessionId || !this.grants.get(this.sessionId)?.has(target.commonDir)) throw new Error("Foreign clone grant is no longer live.");
	}
}
