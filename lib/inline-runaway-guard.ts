import { isDevelopmentSurface, WRITER_CONTEXT_BACKSTOP_TOKENS } from "./bounded-writer-admission.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const READ_THRASHING_THRESHOLD = 5;
export const EXPLORE_READ_BUDGET_THRESHOLD = 4;
export const TURN_TOOL_CALL_LIMIT = 25;

/**
 * Resolves current context tokens accurately, handling edge cases where
 * `ctx.getContextUsage()` returns null (e.g. post-compaction or unmeasured proxy models)
 * by falling back to the last recorded assistant message usage on the session branch.
 */
export function resolveCurrentContextTokens(ctx: {
	getContextUsage?: () => { tokens: number | null } | undefined;
	sessionManager?: { getBranch?: () => Array<{ type: string; message?: unknown }> };
}): number | undefined {
	const usageTokens = ctx.getContextUsage?.()?.tokens;
	if (typeof usageTokens === "number" && usageTokens > 0) {
		return usageTokens;
	}
	try {
		const branch = ctx.sessionManager?.getBranch?.();
		if (Array.isArray(branch)) {
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry && entry.type === "message" && entry.message && typeof entry.message === "object") {
					const msg = entry.message as {
						role?: string;
						usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
					};
					if (msg.role === "assistant" && msg.usage) {
						const total =
							msg.usage.totalTokens ||
							((msg.usage.input ?? 0) + (msg.usage.output ?? 0) + (msg.usage.cacheRead ?? 0) + (msg.usage.cacheWrite ?? 0));
						if (total > 0) return total;
					}
				}
			}
		}
	} catch {
		// safe fallback
	}
	return undefined;
}

/**
 * Rejects direct inline code mutations (edit/write) when the primary session's
 * context usage reaches or exceeds the context backstop (150,000 tokens).
 *
 * This enforces Rule 7 of ODD orchestration: once the context passes 150k tokens,
 * the orchestrator must delegate bounded units to gentle-ai-worker rather than
 * inflating context further with monolithic inline edits.
 *
 * Non-development surfaces (such as odd/tasks/*.md, TODO.md, README.md, docs)
 * remain permitted so the orchestrator can update tracking artifacts.
 */
export function rejectContextBackstopInlineMutation(
	event: { toolName: string; input: unknown },
	options: { contextTokens: number | null | undefined },
): { block: true; reason: string } | undefined {
	if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
	if (typeof options.contextTokens !== "number" || options.contextTokens < WRITER_CONTEXT_BACKSTOP_TOKENS) return undefined;
	if (!isRecord(event.input) || typeof event.input.path !== "string") return undefined;
	if (!isDevelopmentSurface(event.input.path)) return undefined;
	return {
		block: true,
		reason: `Context backstop reached (${options.contextTokens.toLocaleString()} tokens >= ${WRITER_CONTEXT_BACKSTOP_TOKENS.toLocaleString()}). Direct inline code mutations are locked to protect orchestrator reasoning fidelity. You must delegate this unit of work to gentle-ai-worker with declared ## Allowed edit surfaces, or pause and summarize your progress.`,
	};
}

/**
 * Enforces the ODD Evidence-budget rule:
 * "understanding needs more than one read batch or >~5 sequential lookups -> one gentle-ai-explore".
 *
 * If the primary orchestrator accumulates more than 5 read lookups across the codebase
 * in a turn without having modified files or dispatched an explore subagent, the runtime
 * halts further inline reading and forces delegating the exploration to gentle-ai-explore.
 */
export class EvidenceBudgetGuard {
	private distinctReads = new Set<string>();
	private totalReads = 0;

	checkRead(event: { toolName: string; input: unknown }): { block: true; reason: string } | undefined {
		if (event.toolName !== "read") return undefined;
		if (!isRecord(event.input) || typeof event.input.path !== "string") return undefined;

		const normalized = event.input.path.replace(/\\/g, "/");
		// Ignore reading tracking/odd tasks or documentation
		if (normalized.startsWith("odd/") || normalized.startsWith("docs/") || normalized.endsWith(".md")) {
			return undefined;
		}

		this.distinctReads.add(normalized);
		this.totalReads += 1;

		if (this.distinctReads.size > EXPLORE_READ_BUDGET_THRESHOLD || this.totalReads > EXPLORE_READ_BUDGET_THRESHOLD + 2) {
			return {
				block: true,
				reason: `Evidence-budget rule triggered: You have performed ${this.totalReads} sequential reads across ${this.distinctReads.size} source files inline. Codebase exploration across multiple files MUST be delegated to gentle-ai-explore to protect parent reasoning context. Stop inline reading and delegate exploration now.`,
			};
		}
		return undefined;
	}

	recordDelegation(): void {
		this.reset();
	}

	reset(): void {
		this.distinctReads.clear();
		this.totalReads = 0;
	}
}

/**
 * Tracks micro-fragmented reads on the same file in a single turn without modifications.
 * Prevents "read thrashing" / analysis paralysis loops where an agent performs dozens
 * of incremental offset reads on a file instead of reading completely or delegating.
 */
export class ReadThrashingGuard {
	private readCounts = new Map<string, number>();

	checkRead(event: { toolName: string; input: unknown }): { block: true; reason: string } | undefined {
		if (event.toolName !== "read") return undefined;
		if (!isRecord(event.input) || typeof event.input.path !== "string") return undefined;

		// A micro-fragmented read is one with an explicit offset (> 1) and small limit (<= 200 lines).
		const isMicroFragmented =
			typeof event.input.offset === "number" &&
			event.input.offset > 1 &&
			typeof event.input.limit === "number" &&
			event.input.limit <= 200;

		const normalized = event.input.path.replace(/\\/g, "/");
		const current = (this.readCounts.get(normalized) ?? 0) + (isMicroFragmented ? 1 : 0.5);
		this.readCounts.set(normalized, current);

		if (current >= READ_THRASHING_THRESHOLD) {
			return {
				block: true,
				reason: `Read thrashing detected: "${normalized}" has been read incrementally ${Math.floor(current)} times without modification. Incremental offset reads degrade context and indicate analysis paralysis. Read the required symbol or range completely in one call, or delegate this task to gentle-ai-explore or gentle-ai-worker.`,
			};
		}
		return undefined;
	}

	recordMutation(path: string): void {
		const normalized = path.replace(/\\/g, "/");
		this.readCounts.delete(normalized);
	}

	reset(): void {
		this.readCounts.clear();
	}
}

/**
 * Protects against runaway turns where an orchestrator runs an excessive number
 * of tool calls (25+) in a single turn without delegating or summarizing.
 */
export class TurnToolCallGuard {
	private callCount = 0;
	private budgetExceeded = false;

	checkCall(event: { toolName: string; input?: unknown }): { block: true; reason: string } | undefined {
		// Meta-tools and memory bookkeeping do not count towards runaway inline execution.
		if (
			event.toolName === "todo" ||
			event.toolName === "gentle_odd_phase" ||
			event.toolName === "orchestrator_session_id" ||
			event.toolName === "subagent_run" ||
			event.toolName.startsWith("mem_")
		) {
			return undefined;
		}

		// Editing non-development tracking surfaces (odd/tasks/*.md, docs, etc.) is bookkeeping.
		if (
			(event.toolName === "write" || event.toolName === "edit") &&
			isRecord(event.input) &&
			typeof event.input.path === "string" &&
			!isDevelopmentSurface(event.input.path)
		) {
			return undefined;
		}

		this.callCount += 1;
		if (this.callCount > TURN_TOOL_CALL_LIMIT) {
			this.budgetExceeded = true;
			return {
				block: true,
				reason: `Turn tool budget exceeded (${TURN_TOOL_CALL_LIMIT} tool calls in a single turn without delegation). Consolidate your progress in todo, summarize the outcome for the user, or delegate the next unit of work to a subagent (gentle-ai-explore or gentle-ai-worker).`,
			};
		}
		return undefined;
	}

	isBudgetExceeded(): boolean {
		return this.budgetExceeded || this.callCount > TURN_TOOL_CALL_LIMIT;
	}

	recordDelegation(): void {
		this.callCount = 0;
		this.budgetExceeded = false;
	}

	resetTurn(): void {
		this.callCount = 0;
	}

	reset(): void {
		this.callCount = 0;
		this.budgetExceeded = false;
	}
}
