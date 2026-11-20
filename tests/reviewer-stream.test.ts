import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";
import { runInProcessReviewer, type InProcessReviewerRequest } from "../lib/inprocess-reviewer.ts";
import { reviewerStreamLimits, withReviewerProgress, publishReviewerProgress } from "../lib/reviewer-stream.ts";

const model = { id: "fixture", provider: "fixture", api: "openai-responses", name: "Fixture", reasoning: true,
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 } as Model<Api>;
const message = { role: "assistant", content: [{ type: "text", text: "verdict" }], api: model.api, provider: model.provider, model: model.id,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop", timestamp: 0 } as AssistantMessage;

async function fixture(t: TestContext, overrides: Partial<InProcessReviewerRequest> = {}, failObserver = false) {
	let clock = 0, calls = 0, settled = false;
	t.mock.method(performance, "now", () => clock);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const stream = createAssistantMessageEventStream(), caller = new AbortController();
	let rejectResult!: (error: Error) => void;
	const resultFailure = new Promise<never>((_resolve, reject) => { rejectResult = reject; });
	const sdkResult = stream.result.bind(stream);
	stream.result = () => Promise.race([sdkResult(), resultFailure]);
	let providerSignal: AbortSignal | undefined;
	const progress: unknown[] = [];
	const pending = runInProcessReviewer({ selection: "fixture/fixture", prompt: Buffer.from("prompt-secret"), timeoutMs: 500,
		firstOutputTimeoutMs: 40, idleTimeoutMs: 30, signal: caller.signal, routingKey: "review-risk", ...overrides }, {
		registry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "auth-secret" }),
			getProvider: () => ({ streamSimple: (_model, _context, options) => { calls++; providerSignal = options?.signal; return stream; } }) },
		complete: async () => { throw new Error("fallback forbidden"); }, onProgress: event => { progress.push(event); if (failObserver) throw new Error("observer failed"); },
	}).then(outcome => { settled = true; return outcome; });
	t.after(async () => { caller.abort(); stream.end(message); await pending; });
	await nextTurn();
	return { stream, caller, pending, progress, get settled() { return settled; }, get calls() { return calls; }, get signal() { return providerSignal; },
		rejectResult,
		jump(ms: number) { clock += ms; },
		async tick(ms: number) { clock += ms; t.mock.timers.tick(ms); await nextTurn(); },
		async delta(type: "text_delta" | "thinking_delta", delta = "output-secret") { stream.push({ type, delta, contentIndex: 0, partial: message }); await nextTurn(); } };
}

test("#2676: a silent SDK stream stops at the first-output bound, not the total deadline", async t => {
	const f = await fixture(t);
	await f.tick(39); assert.equal(f.settled, false);
	await f.tick(1); assert.equal(f.settled, true);
	const outcome = await f.pending;
	assert.equal(outcome.kind, "refused");
	if (outcome.kind !== "refused") return;
	assert.equal(outcome.code, "timed-out"); assert.equal(outcome.evidence?.timeoutPhase, "first-output");
	assert.equal(outcome.evidence?.reviewerModel, "fixture/fixture"); assert.equal(f.signal?.aborted, true); assert.equal(f.calls, 1);
});

test("#2676: thinking counts as activity; subsequent silence uses the idle bound", async t => {
	const f = await fixture(t);
	await f.tick(20); await f.delta("thinking_delta");
	await f.tick(20); assert.equal(f.settled, false, "first-output timer no longer applies");
	await f.delta("thinking_delta"); await f.tick(29); assert.equal(f.settled, false);
	await f.tick(1); assert.equal(f.settled, true);
	const outcome = await f.pending;
	assert.equal(outcome.kind, "refused"); assert.equal(outcome.evidence?.timeoutPhase, "stream-idle"); assert.equal(f.calls, 1);
});

test("#2676: lifecycle and empty deltas do not keep a silent stream alive", async t => {
	const f = await fixture(t);
	await f.tick(20); f.stream.push({ type: "start", partial: message }); await f.delta("text_delta", "");
	await f.tick(20); assert.equal(f.settled, true);
	assert.equal((await f.pending).evidence?.timeoutPhase, "first-output");
});

test("#2676: progress contains no prompt, auth, or response content and stops at completion", async t => {
	const f = await fixture(t);
	await f.delta("text_delta"); f.stream.end(message);
	const outcome = await f.pending; assert.equal(outcome.kind, "text");
	assert.ok(f.progress.length > 0);
	const count = f.progress.length; await f.tick(10_000); assert.equal(f.progress.length, count);
	assert.doesNotMatch(JSON.stringify(f.progress), /prompt-secret|auth-secret|output-secret|verdict/);
});

test("#2676: caller cancellation beats the stream timers and late text is never admitted", async t => {
	const f = await fixture(t); f.caller.abort();
	const outcome = await f.pending; assert.equal(outcome.kind, "refused");
	if (outcome.kind !== "refused") return;
	assert.equal(outcome.code, "aborted"); assert.equal(f.signal?.aborted, true);
	f.stream.end(message); await f.tick(1000); assert.equal(f.calls, 1);
});

test("#2676: content activity cannot extend the overall deadline", async t => {
	const f = await fixture(t, { timeoutMs: 100 });
	for (let index = 0; index < 4; index++) { await f.tick(20); await f.delta("thinking_delta"); }
	await f.tick(20); assert.equal(f.settled, true);
	const outcome = await f.pending; assert.equal(outcome.kind, "refused");
	if (outcome.kind === "refused") assert.equal(outcome.code, "timed-out");
	assert.equal(outcome.evidence?.timeoutPhase, undefined, "total deadline retains its own diagnosis");
});

test("#2676: a healthy long stream publishes heartbeats; observer failure is harmless", async t => {
	const f = await fixture(t, { timeoutMs: 20_000, firstOutputTimeoutMs: 10_000, idleTimeoutMs: 10_000 }, true);
	assert.equal(f.progress.length, 1);
	await f.tick(5_000); assert.equal(f.progress.length, 2);
	await f.delta("thinking_delta"); await f.tick(5_000);
	await f.delta("text_delta"); f.stream.end(message);
	assert.equal((await f.pending).kind, "text"); assert.equal(f.calls, 1);
});

test("#2676: stream limits use explicit positive timer-safe overrides and bounded defaults", () => {
	assert.deepEqual(reviewerStreamLimits({}), { firstOutputTimeoutMs: 120_000, idleTimeoutMs: 120_000 });
	assert.deepEqual(reviewerStreamLimits({ GENTLE_PI_REVIEW_RELAY_FIRST_OUTPUT_TIMEOUT_MS: "300000", GENTLE_PI_REVIEW_RELAY_IDLE_TIMEOUT_MS: "90000" }), { firstOutputTimeoutMs: 300_000, idleTimeoutMs: 90_000 });
	for (const value of ["0", "-1", "NaN", "Infinity", "1.5", "2147483648", "100ms"]) {
		assert.equal(reviewerStreamLimits({ GENTLE_PI_REVIEW_RELAY_IDLE_TIMEOUT_MS: value }).idleTimeoutMs, 120_000);
	}
});

test("#2676: concurrent tool progress stays in its own async context", async () => {
	const left: string[] = [], right: string[] = [];
	await Promise.all([left, right].map((target, index) => withReviewerProgress(p => { target.push(p.routingKey); }, async () => {
		await nextTurn(); publishReviewerProgress({ routingKey: String(index), phase: "streaming", elapsedMs: 0 });
	})));
	assert.deepEqual(left, ["0"]); assert.deepEqual(right, ["1"]);
});

for (const scenario of ["late-first-delta", "late-first-result", "late-idle-result"] as const) {
	test(`#2676: ${scenario} cannot outrun an expired timer in provider microtasks`, async t => {
		const f = await fixture(t);
		if (scenario === "late-idle-result") await f.delta("thinking_delta");
		f.jump(scenario === "late-idle-result" ? 31 : 41);
		if (scenario === "late-first-delta") await f.delta("text_delta");
		f.stream.end(message);
		const outcome = await f.pending; assert.equal(outcome.kind, "refused");
		assert.equal(outcome.evidence?.timeoutPhase, scenario === "late-idle-result" ? "stream-idle" : "first-output");
	});
}

for (const phase of ["first-output", "stream-idle"] as const) {
	test(`#2676: a late provider rejection retains the expired ${phase} cause`, async t => {
		const f = await fixture(t);
		if (phase === "stream-idle") await f.delta("thinking_delta");
		f.jump(phase === "stream-idle" ? 31 : 41);
		f.rejectResult(new Error("controlled provider rejection"));
		const outcome = await f.pending; assert.equal(outcome.kind, "refused");
		if (outcome.kind !== "refused") return;
		assert.equal(outcome.code, "timed-out"); assert.equal(outcome.evidence?.timeoutPhase, phase);
		assert.equal(f.signal?.aborted, true); assert.equal(f.calls, 1);
	});
}

test("#2676: a provider rejection within the stream bound remains provider-failed", async t => {
	const f = await fixture(t); f.rejectResult(new Error("controlled timely rejection"));
	const outcome = await f.pending; assert.equal(outcome.kind, "refused");
	if (outcome.kind !== "refused") return;
	assert.equal(outcome.code, "provider-failed"); assert.equal(outcome.evidence?.timeoutPhase, undefined);
});
