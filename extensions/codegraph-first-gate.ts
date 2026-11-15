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
 * unavailable codegraph attempt counts — and expires with every new prompt. The guard is
 * total: any internal error allows the call, so the gate can never break a tool call.
 *
 * Wired through pi's extension-directory discovery (discoverAndLoadExtensions over
 * extensions/); no manifest entry is needed — the runtime-harness EXTENSIONS list is
 * banner-test-specific, not a wiring manifest.
 */
export default function codegraphFirstGate(pi: ExtensionAPI): void {
	// Credit lives in this activation only and expires with every user prompt.
	let credited = false;

	// A new user prompt starts the Memory ordering window over: codegraph must come first again.
	// before_agent_start fires once per primary request (a user prompt or sendUserMessage),
	// not per LLM turn, so credit earned in one turn of a request survives into its later turns.
	pi.on?.("before_agent_start", () => {
		credited = false;
	});

	// End-of-execution only: the call finalized, so it counts even when it failed — the
	// result payload is deliberately never read, a failed or unavailable attempt credits too.
	pi.on?.("tool_execution_end", (event) => {
		try {
			const toolName = (event as { toolName?: unknown } | undefined | null)?.toolName;
			if (toolName === "codegraph" || (typeof toolName === "string" && toolName.startsWith("mcp__codegraph__"))) {
				credited = true;
			}
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// The gate itself: block only uncredited persistent-memory reads; every guard failure
	// (throwing payload, malformed toolName) allows the call rather than breaking it.
	pi.on?.("tool_call", (event) => {
		try {
			const toolName = (event as { toolName?: unknown } | undefined | null)?.toolName;
			if (typeof toolName === "string" && MEMORY_READ_TOOLS.has(toolName) && !credited) {
				return { block: true, reason: BLOCK_REASON };
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
}
