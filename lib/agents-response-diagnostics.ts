// Content-free observations at the SDK-normalized RPC boundary. This module
// neither reconstructs messages nor decides task outcomes, sends telemetry,
// persists data, runs commands, or retries an operation.
export const DIAGNOSTIC_COUNTER_LIMIT = 1_000_000;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Raw : undefined;
const SDK_STOPS = ["stop", "length", "toolUse", "error", "aborted", "deferred"] as const;
const RAW_STOPS = ["stop", "length", "tool_calls", "function_call", "end_turn", "max_tokens",
	"stop_sequence", "STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "content_filter", "error", "aborted"] as const;
const UPDATE_TYPES = new Set(["start", "text_start", "text_delta", "text_end", "thinking_start",
	"thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done", "error"]);
const TRANSPORT = Object.freeze({ httpStatus: null, streaming: null, terminalMarker: null, stopReason: null });

type SdkStop = typeof SDK_STOPS[number];
type ReportedRawStop = typeof RAW_STOPS[number];
interface StreamCounts {
	coverage: "from_message_start" | "partial";
	updates: number;
	textDeltas: number;
	textCharacters: number;
	toolArgumentDeltas: number;
	toolArgumentCharacters: number;
	saturated: boolean;
}
interface FinalCounts {
	kind: "text_present" | "empty_content" | "tools_without_text" | "no_text";
	blocks: number;
	textCharacters: number;
	toolCalls: number;
	saturated: boolean;
}
export interface ResponseDiagnostic {
	readonly boundary: "sdk_rpc";
	readonly stream: Readonly<StreamCounts> | null;
	readonly finalContent: Readonly<FinalCounts> | null;
	readonly sdkStopReason: SdkStop | null;
	/** An SDK field, not independently observed upstream transport evidence. */
	readonly sdkReportedRawStopReason: ReportedRawStop | null;
	readonly transport: typeof TRANSPORT;
}

function known<T extends string>(value: unknown, vocabulary: readonly T[]): T | null {
	return typeof value === "string" && vocabulary.includes(value as T) ? value as T : null;
}
function count(target: { saturated: boolean }, current: number, amount: number): number {
	const sum = current + amount;
	if (sum > DIAGNOSTIC_COUNTER_LIMIT) target.saturated = true;
	return Math.min(sum, DIAGNOSTIC_COUNTER_LIMIT);
}
function stream(completeStart: boolean): StreamCounts {
	return { coverage: completeStart ? "from_message_start" : "partial", updates: 0,
		textDeltas: 0, textCharacters: 0, toolArgumentDeltas: 0, toolArgumentCharacters: 0, saturated: false };
}
function finalContent(value: unknown): Readonly<FinalCounts> | null {
	if (!Array.isArray(value)) return null;
	const result: FinalCounts = { kind: "no_text", blocks: 0, textCharacters: 0, toolCalls: 0, saturated: false };
	result.blocks = count(result, 0, value.length);
	for (const item of value) {
		const block = record(item);
		if (!block) return null;
		if (block.type === "text") {
			if (typeof block.text !== "string") return null;
			result.textCharacters = count(result, result.textCharacters, block.text.length);
		} else if (block.type === "toolCall") {
			// Do not traverse names, IDs, arguments, signatures or nested payloads.
			result.toolCalls = count(result, result.toolCalls, 1);
		} else if (block.type !== "thinking") return null;
	}
	result.kind = result.textCharacters > 0 ? "text_present" : result.toolCalls > 0 ? "tools_without_text"
		: value.length === 0 ? "empty_content" : "no_text";
	return Object.freeze(result);
}

/** One bounded accumulator per child. Output is an observation, never a verdict.
 * Counts describe received SDK RPC records/UTF-16 code units, not provider SSE
 * events, unique chunks, tokens, bytes, or semantically valid final reports.
 */
export class ResponseDiagnostics {
	private current: StreamCounts | undefined;

	observe(raw: unknown): ResponseDiagnostic | undefined {
		const event = record(raw);
		if (!event) return;
		if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled" || event.type === "turn_end") {
			this.current = undefined;
			return;
		}
		const message = record(event.message);
		if (event.type === "message_start" && message?.role === "assistant") {
			this.current = stream(true);
			return;
		}
		if (event.type === "message_update") {
			const inner = record(event.assistantMessageEvent);
			if (!inner || typeof inner.type !== "string" || !UPDATE_TYPES.has(inner.type)) {
				this.current = undefined;
				return;
			}
			const isText = inner.type === "text_delta", isTool = inner.type === "toolcall_delta";
			if ((isText || isTool) && typeof inner.delta !== "string") {
				// Broken coverage is unknown, not an observed zero-length delta.
				this.current = undefined;
				return;
			}
			const current = this.current ??= stream(false);
			current.updates = count(current, current.updates, 1);
			if (isText) {
				current.textDeltas = count(current, current.textDeltas, 1);
				current.textCharacters = count(current, current.textCharacters, (inner.delta as string).length);
			} else if (isTool) {
				current.toolArgumentDeltas = count(current, current.toolArgumentDeltas, 1);
				current.toolArgumentCharacters = count(current, current.toolArgumentCharacters, (inner.delta as string).length);
			}
			return;
		}
		if (event.type !== "message_end" || message?.role !== "assistant") return;
		const observed = this.current ? Object.freeze({ ...this.current }) : null;
		this.current = undefined;
		return Object.freeze({ boundary: "sdk_rpc", stream: observed, finalContent: finalContent(message.content),
			sdkStopReason: known(message.stopReason, SDK_STOPS),
			sdkReportedRawStopReason: known(message.rawStopReason, RAW_STOPS), transport: TRANSPORT });
	}
}
