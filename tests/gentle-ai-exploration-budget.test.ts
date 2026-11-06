import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;
function fixture(t: TestContext, child = false) {
	const cwd = mkdtempSync(join(tmpdir(), "exploration-budget-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const handlers = new Map<string, Handler>();
	const messages: any[] = [];
	const results: any[] = [];
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		events: { on() {}, emit() {} }, registerCommand() {}, registerTool() {},
		getActiveTools: () => ["read", "grep", "find", "ls"], getFlag: () => undefined,
		sendMessage(message: any, options: any) { messages.push({ message, options }); },
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		contextBackstopMeasure: { minIntervalMs: 0 },
		processEnv: { GENTLE_PI_CONFIG_HOME: join(cwd, "config"), GENTLE_PI_AGENTS_CHILD: child ? "1" : "0" },
		resolveTelemetryTriggerBinary: () => "/usr/bin/true", telemetryTriggerSpawn: (() => undefined) as never,
	})(pi);
	const ctx = { cwd, hasUI: false, mode: "interactive", ui: { notify() {} },
		sessionManager: { getSessionId: () => "exploration-test", getCwd: () => cwd },
		getContextUsage: () => undefined, isIdle: () => false,
	} as unknown as ExtensionContext;
	const start = () => handlers.get("before_agent_start")!({ messageType: "user", prompt: "test", systemPrompt: "primary" }, ctx);
	const call = (id: string, name = "read", extra: Record<string, unknown> = {}) => handlers.get("tool_call")!({ toolCallId: id, toolName: name, input: { path: join(cwd, "example") }, ...extra }, ctx);
	const result = (id: string, name = "read", extra: Record<string, unknown> = {}) => {
		const event = { toolCallId: id, toolName: name, input: { path: join(cwd, "example") }, isError: false,
			content: [{ type: "text", text: "original" }], details: { native: true }, structuredContent: { opaque: true }, ...extra };
		const original = structuredClone(event);
		results.push({ event, original });
		return handlers.get("tool_result")!(event, ctx);
	};
	return { handlers, ctx, messages, results, start, call, result };
}

test("primary result notice preserves the payload and survives turns but resets on the next request", async (t) => {
	const f = fixture(t);
	await f.start();
	for (let i = 0; i < 3; i++) {
		await f.call(String(i));
		assert.equal(await f.result(String(i)), undefined);
	}
	await f.call("3");
	assert.equal(await f.result("3"), undefined, "the threshold result has no patch");
	assert.equal(f.messages.length, 1);
	assert.equal(f.messages[0].message.customType, "gentle-pi.exploration-budget");
	assert.deepEqual(f.messages[0].message.details, { lookups: 4, textBytes: 32 });
	assert.match(f.messages[0].message.content, /Exploration budget:/);
	assert.match(f.messages[0].message.content, /runtime context.*not a new user request/i);
	assert.deepEqual(f.messages[0].options, { deliverAs: "steer", triggerTurn: true });
	await f.call("4");
	assert.equal(await f.result("4"), undefined);
	assert.equal(f.messages.length, 1);
	for (const { event, original } of f.results) assert.deepEqual(event, original);
	await f.start();
	await f.call("5");
	assert.equal(await f.result("5"), undefined);
});

test("both backstops compose on the same result without changing its metadata", async (t) => {
	const f = fixture(t);
	await f.start();
	for (let i = 0; i < 3; i++) { await f.call(String(i)); await f.result(String(i)); }
	(f.ctx as any).getContextUsage = () => ({ tokens: 160_000, contextWindow: 1_000_000 });
	await f.call("3");
	const patch = await f.result("3");
	assert.deepEqual(patch.content[0], { type: "text", text: "original" });
	assert.equal(patch.content.length, 2);
	assert.match(patch.content[1].text, /Context backstop:/);
	assert.equal(f.messages.length, 1);
	assert.match(f.messages[0].message.content, /Exploration budget:/);
	assert.deepEqual(f.messages[0].options, { deliverAs: "steer", triggerTurn: true });
	assert.deepEqual(f.results.at(-1).event, f.results.at(-1).original);
	assert.deepEqual(patch.structuredContent, { opaque: true });
	assert.equal("details" in patch, false);
	assert.equal("isError" in patch, false);
});

test("parallel nested results emit one independent context message and keep their envelopes untouched", async (t) => {
	const f = fixture(t);
	await f.start();
	await f.call("p", "codemode");
	for (let i = 0; i < 4; i++) await f.call(`p/${i}`, "codegraph_query", { parentToolCallId: "p" });
	const results = await Promise.all(Array.from({ length: 4 }, (_, i) => f.result(`p/${i}`, "codegraph_query", { parentToolCallId: "p" })));
	assert.deepEqual(results, [undefined, undefined, undefined, undefined]);
	assert.equal(f.messages.length, 1);
	assert.match(f.messages[0].message.content, /Exploration budget:/);
	assert.deepEqual(f.messages[0].options, { deliverAs: "steer", triggerTurn: true });
	for (const { event, original } of f.results) assert.deepEqual(event, original);
});

test("an idle session never receives a notice that could start a new agent run", async (t) => {
	const f = fixture(t);
	await f.start();
	(f.ctx as any).isIdle = () => true;
	for (let i = 0; i < 4; i++) { await f.call(String(i)); assert.equal(await f.result(String(i)), undefined); }
	assert.equal(f.messages.length, 0);
	for (const { event, original } of f.results) assert.deepEqual(event, original);
});

test("aborted results cannot contribute or carry a notice", async (t) => {
	const f = fixture(t);
	await f.start();
	for (let i = 0; i < 3; i++) { await f.call(String(i)); await f.result(String(i)); }
	await f.call("aborted");
	(f.ctx as any).signal = AbortSignal.abort();
	assert.equal(await f.result("aborted"), undefined);
	(f.ctx as any).signal = undefined;
	await f.call("fourth");
	assert.equal(await f.result("fourth"), undefined);
	assert.match(f.messages[0].message.content, /Exploration budget:/);
});

test("child sessions and stale calls cannot contribute to a new primary request", async (t) => {
	const child = fixture(t, true);
	await child.start();
	for (let i = 0; i < 4; i++) { await child.call(String(i)); assert.equal(await child.result(String(i)), undefined); }
	const f = fixture(t);
	await f.start();
	await f.call("old");
	await f.start();
	assert.equal(await f.result("old"), undefined);
	for (let i = 0; i < 3; i++) { await f.call(String(i)); assert.equal(await f.result(String(i)), undefined); }
	await f.call("new");
	assert.equal(await f.result("new"), undefined);
	assert.match(f.messages[0].message.content, /Exploration budget:/);
});
