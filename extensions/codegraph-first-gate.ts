import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { indexState } from "../lib/codegraph-lease.ts";

/**
 * The persistent-memory reads the AGENTS.md Memory ordering rule gates: they may run
 * only after a codegraph query or explore has finalized in the same user prompt.
 */
const MEMORY_READ_TOOLS = new Set(["mem_context", "mem_search", "mem_get_observation"]);

const BLOCK_REASON =
	"codegraph-first gate: persistent-memory reads come after a codegraph query or explore in the same user prompt (AGENTS.md Memory ordering). Call codegraph first - a failed or unavailable attempt also counts - then retry this memory read.";

/** The environment override for the gate's workspace scoping: "1" forces it on, "0" off. */
const MEMORY_GATE_OVERRIDE = "GENTLE_CODEGRAPH_MEMORY_GATE";

/**
 * Whether the Memory ordering gate applies to the workspace a memory read runs in: only a
 * workspace that actually has a codegraph index pays the rule, so an unindexed project's memory
 * reads pass with zero graph involvement — the presence probe is a filesystem stat of
 * .codegraph/codegraph.db, never a codegraph call, so machines without the CLI are never blocked
 * either. GENTLE_CODEGRAPH_MEMORY_GATE wins both ways: "1" forces the gate on without an index,
 * "0" turns it off with one; any other value defers to the index. The probe re-runs per call, so
 * an index created mid-session starts gating at the next read. Any error — or a host ctx without
 * a cwd — fails open like every guard here: the gate can never break a tool call.
 */
function gateApplies(cwd: unknown): boolean {
	const override = process.env[MEMORY_GATE_OVERRIDE];
	if (override === "1") return true;
	if (override === "0") return false;
	try {
		return typeof cwd === "string" && indexState(cwd) === "present";
	} catch {
		return false;
	}
}

/**
 * Per-prompt codegraph-first gate (AGENTS.md Memory ordering): persistent-memory reads
 * (mem_context, mem_search, mem_get_observation) are blocked until a codegraph query or explore
 * has finalized in the same user prompt. The requested operation is tracked from the call's
 * start — an init completion never credits. Credit is end-of-execution only — a failed or
 * unavailable query or explore counts — and expires with every new prompt, and it applies only
 * to a fully settled window: while any graph execution is still active, or when a new graph call
 * starts after credit was granted, memory reads stay blocked. The gate is scoped: it applies
 * only to workspaces that have a codegraph index — a filesystem probe of the database file,
 * never a CLI call — with GENTLE_CODEGRAPH_MEMORY_GATE=1 forcing it on and =0 off, so an
 * unindexed workspace's memory reads pass with no graph involvement at all. The guard is total:
 * any internal error allows the call, so the gate can never break a tool call.
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
	// The query/explore executions pending finalization, by call id: the end event carries no
	// arguments, so the requested operation is recorded here when the call starts.
	const queryExploreExecutions = new Set<string>();
	/** codegraph tool calls count for the window: the session tool and the MCP proxy surface. */
	const isGraphToolName = (toolName: unknown): boolean =>
		toolName === "codegraph" || (typeof toolName === "string" && toolName.startsWith("mcp__codegraph__"));
	/** Whether a graph tool call requested a query or an explore: the session tool reports the
	 * operation in its args; the MCP proxy surface encodes it in the tool name. Anything else —
	 * init, a malformed or hostile payload — never credits. */
	const isQueryOrExplore = (toolName: unknown, args: unknown): boolean => {
		if (toolName === "codegraph") {
			const operation = (args as { operation?: unknown } | undefined | null)?.operation;
			return operation === "query" || operation === "explore";
		}
		return typeof toolName === "string" && (toolName.endsWith("_query") || toolName.endsWith("_explore"));
	};

	// A new user prompt starts the Memory ordering window over: codegraph must come first again.
	// before_agent_start fires once per primary request (a user prompt or sendUserMessage),
	// not per LLM turn, so credit earned in one turn of a request survives into its later turns.
	pi.on?.("before_agent_start", () => {
		credited = false;
		activeGraphExecutions.clear();
		queryExploreExecutions.clear();
	});

	// Start-of-execution: the graph call is now active, so no memory read may pass the gate
	// until its matching end event finalizes it (keyed by toolCallId; nested calls carry their
	// own ids too). A query or explore is also recorded as credit-worthy — the end event
	// carries no arguments, so the requested operation is captured here, hostile payload or not.
	pi.on?.("tool_execution_start", (event) => {
		try {
			const toolName = (event as { toolName?: unknown } | undefined | null)?.toolName;
			const toolCallId = (event as { toolCallId?: unknown } | undefined | null)?.toolCallId;
			if (isGraphToolName(toolName) && typeof toolCallId === "string") {
				activeGraphExecutions.add(toolCallId);
				if (isQueryOrExplore(toolName, (event as { args?: unknown }).args)) queryExploreExecutions.add(toolCallId);
			}
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// End-of-execution only, for the operations the rule names: a query or explore that was
	// tracked at start credits even when it failed — the result payload is deliberately never
	// read — while an init completion (or an untracked call) never does. Liveness is kept in the
	// same guarded step: a payload hostile to one field must not void the other.
	pi.on?.("tool_execution_end", (event) => {
		try {
			const toolCallId = (event as { toolCallId?: unknown } | undefined | null)?.toolCallId;
			if (typeof toolCallId === "string") {
				activeGraphExecutions.delete(toolCallId);
				if (queryExploreExecutions.delete(toolCallId)) credited = true;
			}
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// The gate itself: in a workspace the gate applies to, block persistent-memory reads until the
	// codegraph-first window is both credited and settled (no graph execution still active); every
	// guard failure (throwing payload, malformed toolName, missing workspace) allows the call
	// rather than breaking it.
	pi.on?.("tool_call", (event, ctx) => {
		try {
			const toolName = (event as { toolName?: unknown } | undefined | null)?.toolName;
			const cwd = (ctx as { cwd?: unknown } | undefined | null)?.cwd;
			if (typeof toolName === "string" && MEMORY_READ_TOOLS.has(toolName) && gateApplies(cwd) && (!credited || activeGraphExecutions.size > 0)) {
				return { block: true, reason: BLOCK_REASON };
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
}
