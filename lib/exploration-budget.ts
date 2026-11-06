import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { inferOddPhase } from "./odd-phase-inference.ts";

// Explicit discovery tools; existing shell inference below is advisory, never authorization.
const DISCOVERY_TOOLS = new Set([
	"read", "grep", "find", "ls", "codegraph_query", "codegraph_explore",
	"mem_search", "mem_get_observation", "mem_context",
	"mcp__codegraph__codegraph_query", "mcp__codegraph__codegraph_explore",
]);

type DiscoveryResult = Pick<ToolResultEvent, "toolCallId" | "toolName" | "isError" | "content" | "input" | "details" | "parentToolCallId">;
type PendingCall = { toolName: string; parentToolCallId?: string };
type RequestBudget = { pending: Map<string, PendingCall>; seen: Set<string>; lookups: number; bytes: number; notified: boolean };

function isDiscovery(event: DiscoveryResult): boolean {
	if (DISCOVERY_TOOLS.has(event.toolName)) return true;
	if (event.toolName === "bash" || event.toolName === "powershell") return inferOddPhase(event.toolName, event.input) === "exploring";
	if (event.toolName !== "codegraph" || (event.input.operation !== "query" && event.input.operation !== "explore")) return false;
	// This local tool reports unavailable/failed as successful fallback results.
	const details = event.details;
	return !(details && typeof details === "object" && "status" in details && (details.status === "failed" || details.status === "unavailable"));
}

/** Ephemeral per-request facts. Only calls observed in this request can contribute results. */
export function createExplorationBudget() {
	const requests = new Map<unknown, RequestBudget>();
	return {
		start(session: unknown) {
			requests.set(session, { pending: new Map(), seen: new Set(), lookups: 0, bytes: 0, notified: false });
		},
		call(session: unknown, id: string, toolName = "", parentToolCallId?: string) {
			const request = requests.get(session);
			if (request && !request.seen.has(id)) request.pending.set(id, { toolName, parentToolCallId });
		},
		result(session: unknown, event: DiscoveryResult, primary = true, aborted = false): string | undefined {
			const request = requests.get(session);
			const call = request?.pending.get(event.toolCallId);
			if (!request || !call) return undefined;
			request.pending.delete(event.toolCallId);
			request.seen.add(event.toolCallId);
			if (!primary || aborted || event.isError) return undefined;
			if (call.parentToolCallId !== event.parentToolCallId) return undefined;
			if (call.parentToolCallId !== undefined) {
				const parent = request.pending.get(call.parentToolCallId);
				if (!parent || parent.parentToolCallId !== undefined || !["codemode", "mcp"].includes(parent.toolName)) return undefined;
			}
			if (!isDiscovery(event)) return undefined;
			request.lookups++;
			for (const part of event.content) {
				if (part.type === "text") request.bytes += Buffer.byteLength(part.text, "utf8");
			}
			if (request.notified || (request.lookups <= 3 && request.bytes <= 40_000)) return undefined;
			request.notified = true;
			return `Exploration budget: ${request.lookups.toLocaleString("en-US")} tracked lookups and ${request.bytes.toLocaleString("en-US")} UTF-8 text bytes (an approximate evidence budget). Ongoing discovery needs one configured explorer, even if read-only or initially small. Preparation for an already-understood authorized inline write remains exempt. This is runtime context for the original task, not a new user request. This notice grants no mutation or guard bypass authority.`;
		},
		facts(session: unknown): { lookups: number; textBytes: number } | undefined {
			const request = requests.get(session);
			return request ? { lookups: request.lookups, textBytes: request.bytes } : undefined;
		},
		settle(session: unknown) { requests.delete(session); },
	};
}
