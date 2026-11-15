import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The persistent-memory reads the AGENTS.md Memory ordering rule gates: they may run
 * only after a codegraph query or explore has finalized in the same user prompt.
 */
const MEMORY_READ_TOOLS = new Set(["mem_context", "mem_search", "mem_get_observation"]);

const BLOCK_REASON =
	"codegraph-first gate: persistent-memory reads come after a codegraph query or explore in the same user prompt (AGENTS.md Memory ordering). Call codegraph first - a failed or unavailable attempt also counts - then retry this memory read.";

/**
 * Per-prompt codegraph-first gate (AGENTS.md Memory ordering): persistent-memory reads
 * (mem_context, mem_search, mem_get_observation) are blocked until a codegraph call has
 * finalized in the same user prompt. Credit is end-of-execution only — a failed or
 * unavailable codegraph attempt counts — and expires with every new prompt, and it applies
 * only to a fully settled window: while any graph execution is still active, or when a new
 * graph call starts after credit was granted, memory reads stay blocked. The guard is
 * total: any internal error allows the call, so the gate can never break a tool call.
 *
 * Wired through pi's extension-directory discovery (discoverAndLoadExtensions over
 * extensions/); no manifest entry is needed — the runtime-harness EXTENSIONS list is
 * banner-test-specific, not a wiring manifest.
 */
export default function codegraphFirstGate(pi: ExtensionAPI): void {
	// Credit lives in this activation only and expires with every user prompt.
	let credited = false;
	// The graph executions that started but have not finalized: one call's completion must not
	// credit the prompt while a sibling call is still running, and a graph call that starts after
	// credit was granted re-opens the window until it finalizes.
	const activeGraphExecutions = new Set<string>();
	/** codegraph tool calls count for the window: the session tool and the MCP proxy surface. */
	const isGraphToolName = (toolName: unknown): boolean =>
		toolName === "codegraph" || (typeof toolName === "string" && toolName.startsWith("mcp__codegraph__"));

	// A new user prompt starts the Memory ordering window over: codegraph must come first again.
	// before_agent_start fires once per primary request (a user prompt or sendUserMessage),
	// not per LLM turn, so credit earned in one turn of a request survives into its later turns.
	pi.on?.("before_agent_start", () => {
		credited = false;
		activeGraphExecutions.clear();
	});

	// Start-of-execution: the graph call is now active, so no memory read may pass the gate
	// until its matching end event finalizes it (keyed by toolCallId; nested calls carry their
	// own ids too).
	pi.on?.("tool_execution_start", (event) => {
		try {
			const toolName = (event as { toolName?: unknown } | undefined | null)?.toolName;
			const toolCallId = (event as { toolCallId?: unknown } | undefined | null)?.toolCallId;
			if (isGraphToolName(toolName) && typeof toolCallId === "string") {
				activeGraphExecutions.add(toolCallId);
			}
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// End-of-execution only: the call finalized, so it counts even when it failed — the
	// result payload is deliberately never read, a failed or unavailable attempt credits too.
	pi.on?.("tool_execution_end", (event) => {
		// Credit and liveness are read in separate guards: a payload hostile to one field
		// must not void the other.
		try {
			if (isGraphToolName((event as { toolName?: unknown } | undefined | null)?.toolName)) {
				credited = true;
			}
		} catch {
			/* a hostile payload must never break the host */
		}
		try {
			const toolCallId = (event as { toolCallId?: unknown } | undefined | null)?.toolCallId;
			if (typeof toolCallId === "string") activeGraphExecutions.delete(toolCallId);
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// The gate itself: block persistent-memory reads until the codegraph-first window is both
	// credited and settled (no graph execution still active); every guard failure (throwing
	// payload, malformed toolName) allows the call rather than breaking it.
	pi.on?.("tool_call", (event) => {
		try {
			const toolName = (event as { toolName?: unknown } | undefined | null)?.toolName;
			if (typeof toolName === "string" && MEMORY_READ_TOOLS.has(toolName) && (!credited || activeGraphExecutions.size > 0)) {
				return { block: true, reason: BLOCK_REASON };
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
}
