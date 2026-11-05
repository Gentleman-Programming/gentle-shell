import assert from "node:assert/strict";
import test from "node:test";
import { ResponseDiagnostics, DIAGNOSTIC_COUNTER_LIMIT } from "../lib/agents-response-diagnostics.ts";
import { normalizeRpcEvent } from "../lib/agents-protocol.ts";

const start = () => ({ type: "message_start", message: { role: "assistant" } });
const delta = (type: string, value: string) => ({ type: "message_update", assistantMessageEvent: { type, delta: value } });
const end = (content: unknown, stopReason: unknown = "stop", extra = {}) => ({
	type: "message_end", message: { role: "assistant", content, stopReason, ...extra },
});

test("reports SDK deltas and finalized text separately, without implying a verdict", () => {
	const observer = new ResponseDiagnostics();
	observer.observe(start());
	observer.observe(delta("text_delta", "draft"));
	observer.observe(delta("toolcall_delta", '{"q":"hidden"}'));
	const report = observer.observe(end([{ type: "text", text: "final" }], "stop", { rawStopReason: "end_turn" }))!;
	assert.deepEqual(report.stream, { coverage: "from_message_start", updates: 2, textDeltas: 1,
		textCharacters: 5, toolArgumentDeltas: 1, toolArgumentCharacters: 14, saturated: false });
	assert.deepEqual(report.finalContent, { kind: "text_present", blocks: 1, textCharacters: 5, toolCalls: 0, saturated: false });
	assert.equal(report.sdkStopReason, "stop");
	assert.equal(report.sdkReportedRawStopReason, "end_turn");
	assert.equal(report.boundary, "sdk_rpc");
	assert.equal("verdict" in report, false);
	assert.deepEqual(report.transport, { httpStatus: null, streaming: null, terminalMarker: null, stopReason: null });
});

test("distinguishes a witnessed empty stream from unobserved streaming", () => {
	const observer = new ResponseDiagnostics();
	const unavailable = observer.observe(end([]))!;
	assert.equal(unavailable.stream, null);
	assert.equal(unavailable.finalContent?.kind, "empty_content");
	observer.observe(start());
	const witnessed = observer.observe(end([]))!;
	assert.equal(witnessed.stream?.updates, 0);
	assert.equal(witnessed.stream?.coverage, "from_message_start");
	observer.observe(delta("text_delta", "x"));
	const partial = observer.observe(end([]))!;
	assert.equal(partial.stream?.coverage, "partial");
	assert.equal(partial.stream?.textCharacters, 1);
	assert.equal(partial.finalContent?.textCharacters, 0);
});

test("ignores private payloads, unknown fields and unrecognized stop strings", () => {
	const secret = "PRIVATE_SENTINEL_DO_NOT_STORE";
	const observer = new ResponseDiagnostics();
	observer.observe({ type: "message_start", message: { role: "user", content: secret } });
	observer.observe({ type: "tool_execution_end", result: { content: secret } });
	observer.observe(start());
	observer.observe(delta("thinking_delta", secret));
	observer.observe(delta("toolcall_delta", secret));
	const report = observer.observe(end([{ type: "thinking", thinking: secret },
		{ type: "toolCall", id: secret, name: secret, arguments: { password: secret } }], secret,
		{ model: secret, provider: secret, responseId: secret, errorMessage: secret, rawStopReason: secret,
			headers: { authorization: secret }, usage: { output: secret }, diagnostics: [{ message: secret }] }))!;
	assert.equal(report.finalContent?.kind, "tools_without_text");
	assert.equal(report.finalContent?.toolCalls, 1);
	assert.equal(report.sdkStopReason, null);
	assert.equal(report.sdkReportedRawStopReason, null);
	assert.equal(JSON.stringify(report).includes(secret), false);
	assert.equal(JSON.stringify(observer).includes(secret), false);
	assert.deepEqual(Object.keys(report).sort(), ["boundary", "finalContent", "sdkReportedRawStopReason", "sdkStopReason", "stream", "transport"]);
});

test("never reuses a previous response's deltas for a new response", () => {
	const observer = new ResponseDiagnostics();
	observer.observe(start());
	observer.observe(delta("text_delta", "previous"));
	observer.observe(end([{ type: "text", text: "previous" }]));
	observer.observe(start());
	const report = observer.observe(end([]))!;
	assert.equal(report.stream?.textCharacters, 0);
	assert.equal(report.finalContent?.kind, "empty_content");
	observer.observe(delta("text_delta", "orphan"));
	observer.observe({ type: "agent_settled" });
	assert.equal(observer.observe(end([]))!.stream, null);
});

test("unknown or malformed final data is unavailable, not empty or successful", () => {
	const observer = new ResponseDiagnostics();
	for (const input of [null, [], "ignored", { type: "message_end", message: { role: "user" } }]) {
		assert.equal(observer.observe(input), undefined);
	}
	for (const content of [undefined, "not an array", [null], [{ type: "text", text: 42 }]]) {
		assert.equal(observer.observe(end(content))!.finalContent, null);
	}
	assert.equal(observer.observe(end([{ type: "thinking" }]))!.finalContent?.kind, "no_text");
	observer.observe(start());
	observer.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: 42 } });
	assert.equal(observer.observe(end([]))!.stream, null);
});

test("bounds counters and returns detached immutable projections", () => {
	const observer = new ResponseDiagnostics();
	observer.observe(start());
	observer.observe(delta("text_delta", "x".repeat(DIAGNOSTIC_COUNTER_LIMIT + 1)));
	const report = observer.observe(end([{ type: "text", text: "ok" }]))!;
	assert.equal(report.stream?.textCharacters, DIAGNOSTIC_COUNTER_LIMIT);
	assert.equal(report.stream?.saturated, true);
	assert.throws(() => { (report.stream as any).textCharacters = -1; }, TypeError);
	assert.throws(() => { (report as any).sdkStopReason = "invented"; }, TypeError);
	observer.observe(start());
	observer.observe(delta("text_delta", "later"));
	assert.equal(report.stream?.textCharacters, DIAGNOSTIC_COUNTER_LIMIT);
});

test("keeps signatures and partial payloads out, resets mid-message, and saturates only past the limit", () => {
	const secret = "PRIVATE_SIGNATURE_SENTINEL";
	const observer = new ResponseDiagnostics();
	observer.observe(start());
	observer.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ab", partial: secret } });
	const signed = observer.observe(end([{ type: "text", text: "ok", textSignature: secret },
		{ type: "toolCall", id: "t", name: "n", arguments: {}, thoughtSignature: secret },
		{ type: "thinking", thinking: secret, thinkingSignature: secret }]))!;
	assert.equal(JSON.stringify(signed).includes(secret), false);
	assert.equal(signed.finalContent?.blocks, 3);
	observer.observe(start());
	observer.observe(delta("text_delta", "a"));
	observer.observe({ type: "turn_end" });
	assert.equal(observer.observe(end([]))!.stream, null);
	observer.observe(start());
	observer.observe(delta("text_delta", "x".repeat(DIAGNOSTIC_COUNTER_LIMIT)));
	const atLimit = observer.observe(end([]))!;
	assert.equal(atLimit.stream?.textCharacters, DIAGNOSTIC_COUNTER_LIMIT);
	assert.equal(atLimit.stream?.saturated, false);
});

test("preserves existing public task outcomes for text, empty, tools, errors and aborts", () => {
	for (const [content, stopReason, outcome, diagnostic] of [
		[[{ type: "text", text: "report" }], "stop", "success", undefined],
		[[], "stop", "empty", "assistant returned no final report"],
		[[{ type: "toolCall", name: "bash", arguments: {} }], "toolUse", "empty", "assistant returned no final report"],
		[[], "error", "error", "assistant reported an error (unavailable)"],
		[[], "aborted", "aborted", "assistant aborted"],
	] as const) {
		const observer = new ResponseDiagnostics();
		observer.observe(start());
		observer.observe(end(content, stopReason));
		const [event] = normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content, stopReason }] });
		assert.equal((event as any).outcome, outcome);
		assert.equal((event as any).text, outcome === "success" ? "report" : "");
		assert.equal((event as any).diagnostic, diagnostic);
	}
});
