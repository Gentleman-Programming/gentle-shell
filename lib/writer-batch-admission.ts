// cost-speed P6 (R1): the tool calls of the assistant message that issued one tool call, so writer admission can
// see the launches made together with it. Pi persists an assistant message on `message_end`, before it prepares
// any of its tool calls (pi-agent-core agent-loop: `message_end` is awaited, then `executeToolCalls`; the parallel
// path runs every call's `tool_call` hook before executing any, and appends tool results only after all of them
// finish). At `tool_call` the message is therefore the nearest assistant entry of the session branch.

export interface MessageToolCall {
	readonly name: string;
	readonly arguments: unknown;
}

interface BranchEntry {
	readonly type?: unknown;
	readonly parentId?: unknown;
	readonly message?: { readonly role?: unknown; readonly content?: unknown; readonly toolCallId?: unknown };
}

export interface SessionBranchReader {
	getLeafEntry(): BranchEntry | undefined;
	getEntry(id: string): BranchEntry | undefined;
}

// Tool results and extension entries of the same turn may follow the message; nothing else lies between.
const MAX_ENTRIES_BACK = 64;

/**
 * The tool calls of the nearest assistant message on the branch, when that message issued `toolCallId`; otherwise
 * undefined. A call nested inside another tool (codemode, `parentToolCallId`) is not in the message, so it never
 * gets a batch. Providers may repeat call ids across messages, so a message whose call with this id already has its
 * tool result behind it on the branch is an earlier message, never the one executing: no batch (fail closed). Only
 * this id is checked: in Pi's sequential path earlier calls of the same message already have their results.
 */
export function sameMessageToolCalls(session: SessionBranchReader | undefined, toolCallId: unknown): MessageToolCall[] | undefined {
	if (!session || typeof toolCallId !== "string" || !toolCallId) return undefined;
	try {
		let entry = session.getLeafEntry();
		let answered = false;
		for (let steps = 0; entry && steps < MAX_ENTRIES_BACK; steps++) {
			// Pi persists a result as a `message` entry with `role: "toolResult"` and the call's `toolCallId`
			// (pi-agent-core agent-loop `createToolResultMessage`).
			if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId) answered = true;
			if (entry.type === "message" && entry.message?.role === "assistant") {
				if (answered) return undefined;
				const content = Array.isArray(entry.message.content) ? entry.message.content : [];
				const calls = content.filter((part): part is { type: "toolCall"; id: unknown; name: unknown; arguments: unknown } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall");
				if (!calls.some(call => call.id === toolCallId)) return undefined;
				return calls.map(call => ({ name: String(call.name), arguments: call.arguments }));
			}
			entry = typeof entry.parentId === "string" ? session.getEntry(entry.parentId) : undefined;
		}
	} catch {
		// A session that cannot be read gives no batch: the lone-writer rule applies.
	}
	return undefined;
}
