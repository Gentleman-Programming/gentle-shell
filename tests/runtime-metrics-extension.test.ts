import assert from "node:assert/strict";
import test from "node:test";
import runtimeMetrics from "../extensions/runtime-metrics.ts";
import { parseAgentClass, type RuntimeMetricBucket } from "../lib/runtime-metrics.ts";
import { encodeNativeRuntimeEvent } from "../lib/runtime-metrics-native.ts";
import { CHILD_METRICS_EVENT, childEvent } from "../lib/runtime-metrics-children.ts";
import { normalizeRpcEvent, TASK_EVENT } from "../lib/agents-protocol.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(env: NodeJS.ProcessEnv = {}, mode: "tui" | "print" = "tui", shutdownWaitMs = 1500, model: unknown = { provider: "openai", id: "gpt-4o" }) {
	const handlers = new Map<string, Function>();
	const listeners = new Map<string, Function>();
	let session = "first";
	let finish!: () => void;
	let signal!: AbortSignal;
	const sent: RuntimeMetricBucket[][] = [];
	const launches: unknown[] = [];
	const ctx: any = { cwd: "/fixture", mode, model,
		sessionManager: { getSessionId: () => session, getEntries: () => assert.fail("no reconstruction") } };
	const pi: any = { on: (name: string, handler: Function) => handlers.set(name, handler),
		getThinkingLevel: () => "high", registerCommand() {},
		appendEntry: () => assert.fail("no metrics persistence"),
		events: { on: (name: string, handler: Function) => { listeners.set(name, handler); return () => listeners.delete(name); } } };
	runtimeMetrics(pi, env, { now: () => 0, shutdownWaitMs, send: (rows, _cwd, deps) => {
		sent.push(structuredClone(rows)); launches.push(structuredClone(deps?.launches)); signal = deps!.signal!;
		return new Promise(resolve => { finish = () => resolve("discarded"); });
	} });
	return { sent, launches, ctx, handlers,
		emit: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx),
		bus: (event: unknown) => listeners.get(CHILD_METRICS_EVENT)?.(event),
		replace: () => { session = "second"; }, signal: () => signal,
		finish: async () => { finish(); await tick(); },
	};
}
const final = (input = 7) => ({ role: "assistant", provider: "openai", model: "gpt-4o", responseModel: "gpt-4o",
	providerThinkingLevel: "low", stopReason: "stop", usage: { input, output: 3, cacheRead: 0 },
	content: [{ text: "private response" }], errorMessage: "private error", path: "/private" });

test("a generic open-weight selection reaches the wire by name; no catalog probe or gate", async () => {
	const h = harness({}, "tui", 1500, { provider: "nan", id: "deepseek-v4-flash" });
	await h.emit("session_start");
	h.emit("turn_start"); h.emit("before_provider_request");
	h.emit("message_end", { message: { role: "assistant", provider: "nan", model: "deepseek-v4-flash",
		providerThinkingLevel: "low", stopReason: "stop", usage: { input: 3, output: 2 } } });
	await tick();
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0][0].selectedProvider, "nan");
	assert.equal(h.sent[0][0].selectedModelId, "deepseek-v4-flash");
	const encoded = encodeNativeRuntimeEvent(h.sent[0]);
	assert.ok(encoded);
	const row = JSON.parse(encoded).rows[0];
	assert.deepEqual(row.model, { provider: "nan", id: "deepseek-v4-flash" });
	assert.equal(row.model_evidence, "selected");
	await h.finish(); h.emit("session_shutdown");
});

test("an ambiguous turn with no captured selection still reports the observed model, as selected evidence", async () => {
	const h = harness({}, "tui", 1500, { provider: "nan", id: "deepseek-v4-flash" });
	await h.emit("session_start");
	// No turn_start/before_provider_request: the turn is ambiguous, so no
	// selection was captured for this response.
	h.emit("message_end", { message: { role: "assistant", provider: "nan", model: "glm5.3",
		providerThinkingLevel: "low", stopReason: "stop", usage: { input: 3, output: 2 } } });
	await tick();
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0][0].selectedModelId, "unknown");
	assert.equal(h.sent[0][0].observedModelId, "glm5.3");
	const encoded = encodeNativeRuntimeEvent(h.sent[0]);
	assert.ok(encoded);
	const row = JSON.parse(encoded).rows[0];
	assert.deepEqual(row.model, { provider: "nan", id: "glm5.3" });
	assert.equal(row.model_evidence, "selected");
	await h.finish(); h.emit("session_shutdown");
});

test("final callback returns before blocked transport; busy and duplicate messages drop", async () => {
	const h = harness(); await h.emit("session_start");
	h.emit("turn_start"); h.emit("before_provider_request");
	const message = final();
	assert.equal(h.emit("message_end", { message }), undefined);
	assert.equal(h.sent.length, 0);
	h.emit("message_end", { message });
	h.emit("message_end", { message: final(99) });
	await tick(); assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0][0].tokens.input.sum, 7);
	assert.equal(h.sent[0][0].effort, "high");
	assert.equal(h.sent[0][0].providerThinkingLevel, "low");
	assert.ok(!JSON.stringify(h.sent).includes("private"));
	await h.finish(); await tick();
	assert.equal(h.sent.length, 1, "no replay after failure");
	h.emit("message_end", { message: final(2) }); await tick();
	assert.equal(h.sent[1][0].tokens.input.sum, 2, "event usage, never cumulative totals");
	assert.equal(h.sent[1][0].responses, 1);
	await h.finish(); h.emit("session_shutdown");
});

test("replacement before launch cancels stale work; shutdown does not await a blocked child", async () => {
	const h = harness(); await h.emit("session_start");
	h.emit("message_end", { message: final() });
	h.replace(); await h.emit("session_start"); await tick();
	assert.equal(h.sent.length, 0);
	h.emit("message_end", { message: final() }); await tick();
	assert.equal(h.emit("session_shutdown"), undefined);
	assert.equal(h.signal().aborted, true);
	await h.finish();
});

test("print shutdown joins an accepted orchestrator delivery before disposing", async () => {
	const h = harness({}, "print", 50); await h.emit("session_start");
	h.emit("message_end", { message: final() }); await tick();
	let stopped = false;
	const shutdown = h.emit("session_shutdown").then(() => { stopped = true; });
	await tick();
	assert.equal(stopped, false);
	assert.equal(h.signal().aborted, false);
	await h.finish(); await shutdown;
	assert.equal(stopped, true);
});

test("print shutdown joins an accepted child launch and response delivery", async () => {
	const h = harness({}, "print", 50); await h.emit("session_start");
	const observation = normalizeRpcEvent({ type: "message_end", message: final() }, { observeResponses: true })
		.find(event => event.type === TASK_EVENT.RESPONSE_OBSERVATION);
	assert.ok(observation?.type === TASK_EVENT.RESPONSE_OBSERVATION);
	h.bus(childEvent("first", "child", {
		agentClass: parseAgentClass("sdd-explore")!, selectedProvider: "openai", selectedModelId: "gpt-4o", selectedEffort: "high",
	}, "completed", { coverage: "final_assistant_messages_only", agentSettled: true, droppedResponses: 0,
		responses: [observation.observation] }, 0)!);
	await tick();
	const shutdown = h.emit("session_shutdown");
	assert.equal(h.sent[0][0].agentClass, "sdd-explore");
	assert.deepEqual(h.launches[0], [{ evidence: "launch_configuration", agentClass: "sdd-explore", selectedProvider: "openai",
		selectedModelId: "gpt-4o", selectedEffort: "high", launches: 1 }]);
	assert.equal(h.signal().aborted, false);
	await h.finish(); await shutdown;
});

test("print shutdown aborts a delivery after the bounded join deadline", async () => {
	const h = harness({}, "print", 5); await h.emit("session_start");
	h.emit("message_end", { message: final() }); await tick();
	await h.emit("session_shutdown");
	assert.equal(h.signal().aborted, true);
	await h.finish();
});

test("interactive shutdown never joins a blocked delivery", async () => {
	const h = harness({}, "tui", 50); await h.emit("session_start");
	h.emit("message_end", { message: final() }); await tick();
	assert.equal(h.emit("session_shutdown"), undefined);
	assert.equal(h.signal().aborted, true);
	await h.finish();
});

for (const env of [{ DO_NOT_TRACK: "1" }, { GENTLE_AI_TELEMETRY: "0" }, { CI: "true" }, { GENTLE_PI_AGENTS_CHILD: "1" }]) {
	test(`opt-out suppresses hooks and launches: ${Object.keys(env)[0]}`, async () => {
		const h = harness(env); await h.emit("session_start");
		h.emit("message_end", { message: final() }); await tick();
		assert.equal(h.handlers.size, 0); assert.equal(h.sent.length, 0);
	});
}

test("environment veto between callback and launch discards accepted event", async () => {
	const env: NodeJS.ProcessEnv = {};
	const h = harness(env); await h.emit("session_start");
	h.emit("message_end", { message: final() }); env.DO_NOT_TRACK = "1";
	await tick(); assert.equal(h.sent.length, 0); h.emit("session_shutdown");
});

test("tool and partial assistant messages are not consumed as primary usage", async () => {
	const h = harness(); await h.emit("session_start");
	for (const message of [{ ...final(), role: "toolResult" }, { ...final(), stopReason: "pending" }, { ...final(), stopReason: "deferred" }]) h.emit("message_end", { message });
	await tick(); assert.equal(h.sent.length, 0); h.emit("session_shutdown");
});

test("child completion consumed once, busy children drop, and primary usage stays separate", async () => {
	const h = harness(); await h.emit("session_start");
	const observation = normalizeRpcEvent({ type: "message_end", message: final() }, { observeResponses: true })
		.find(event => event.type === TASK_EVENT.RESPONSE_OBSERVATION);
	assert.ok(observation?.type === TASK_EVENT.RESPONSE_OBSERVATION);
	const event = (taskId: string) => childEvent("first", taskId,
		{ agentClass: parseAgentClass("verify")!, selectedProvider: "openai", selectedModelId: "gpt-4o", selectedEffort: "high" }, "completed",
		{ coverage: "final_assistant_messages_only", agentSettled: true, droppedResponses: 0, responses: [observation.observation] }, 0)!;
	h.bus(event("one")); h.bus(event("one")); h.bus(event("busy"));
	await tick(); assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0][0].agentClass, "verify");
	assert.deepEqual(h.launches[0], [{ evidence: "launch_configuration", agentClass: "verify", selectedProvider: "openai",
		selectedModelId: "gpt-4o", selectedEffort: "high", launches: 1 }]);
	assert.equal(h.sent[0][0].effort, "high", "child response retains launch selection separately from response evidence");
	assert.equal(h.sent[0][0].providerThinkingLevel, "low");
	await h.finish(); h.bus(event("busy")); await tick();
	assert.equal(h.sent.length, 1, "busy completion stays consumed");
	h.emit("message_end", { message: final(2) }); await tick();
	assert.equal(h.sent[1][0].agentClass, "orchestrator");
	assert.equal(h.sent[1][0].tokens.input.sum, 2);
	await h.finish(); h.emit("session_shutdown");
});
