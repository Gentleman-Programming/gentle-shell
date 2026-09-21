import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	INPROCESS_REVIEWER_FAILURE,
	INPROCESS_REVIEWER_OUTPUT_MAX_BYTES,
	runInProcessReviewer,
	openCodeSessionAttributionHeaders,
	type InProcessReviewerOutcome,
	type InProcessReviewerRegistry,
	type InProcessReviewerRequest,
} from "../lib/inprocess-reviewer.ts";

// The in-process reviewer completion (gentle-ai#4611; gentle-pi#311 P1) runs
// one reviewer role through pi's live model registry instead of a locked-down
// `pi --print` child with extension discovery disabled. Every seam here is a
// fake: no network, no pi process, no process.env reads.

// ---------------------------------------------------------------------------
// Fakes — structural subsets of pi's live ModelRegistry and completeSimple.
// ---------------------------------------------------------------------------

function fakeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8192,
		...overrides,
	};
}

function fakeRegistry(
	models: readonly Model<Api>[],
	auth?: (model: Model<Api>) => ReturnType<InProcessReviewerRegistry["getApiKeyAndHeaders"]>,
): InProcessReviewerRegistry {
	return {
		find: (provider, modelId) => models.find((candidate) => candidate.provider === provider && candidate.id === modelId),
		getApiKeyAndHeaders: auth ?? (async () => ({ ok: true, apiKey: "test-key" })),
	};
}

function assistantText(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function baseRequest(overrides: Partial<InProcessReviewerRequest> = {}): InProcessReviewerRequest {
	return {
		selection: "openai/gpt-5",
		prompt: Buffer.from("Review this diff.", "utf8"),
		timeoutMs: 30_000,
		routingKey: "review-risk",
		...overrides,
	};
}

/** A `complete` fake that records every call for assertion. */
function capturingComplete(assistant: AssistantMessage) {
	const calls: Array<{ model: Model<Api>; context: Context; options: SimpleStreamOptions | undefined }> = [];
	const complete: typeof completeSimple = (async (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		calls.push({ model, context, options });
		return assistant;
	}) as typeof completeSimple;
	return { complete, calls };
}

/**
 * A `complete` fake that never resolves except when its signal aborts — the
 * timeout and caller-abort paths are exercised without a real network call
 * or a wall-clock wait longer than the request's own timeout.
 */
function signalAwaitingComplete(): typeof completeSimple {
	return (async (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
		return await new Promise<AssistantMessage>((_resolve, reject) => {
			const signal = options?.signal;
			if (signal === undefined) return;
			if (signal.aborted) {
				reject(new Error("aborted"));
				return;
			}
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	}) as typeof completeSimple;
}

/**
 * A `complete` fake that follows the pi-ai provider convention on abort:
 * once the signal fires it RESOLVES an AssistantMessage carrying the text
 * streamed so far and `stopReason: "aborted"`, instead of rejecting.
 */
function signalResolvingAbortedComplete(partialText = "partial revi"): typeof completeSimple {
	return (async (_model, _context, options) => {
		return await new Promise<AssistantMessage>((resolve) => {
			const signal = options?.signal;
			const settle = () => resolve(assistantText(partialText, { stopReason: "aborted" }));
			if (signal === undefined) return;
			if (signal.aborted) {
				settle();
				return;
			}
			signal.addEventListener("abort", settle, { once: true });
		});
	}) as typeof completeSimple;
}

/** A canary `complete` fake for refusals that must never reach the provider. */
const unreachableComplete: typeof completeSimple = (async () => {
	throw new Error("complete must not be called for this refusal");
}) as typeof completeSimple;

function expectRefused(outcome: InProcessReviewerOutcome): Extract<InProcessReviewerOutcome, { kind: "refused" }> {
	assert.equal(outcome.kind, "refused", outcome.kind === "text" ? `expected a refusal, got text: ${outcome.text}` : undefined);
	return outcome as Extract<InProcessReviewerOutcome, { kind: "refused" }>;
}

function expectText(outcome: InProcessReviewerOutcome): Extract<InProcessReviewerOutcome, { kind: "text" }> {
	assert.equal(outcome.kind, "text", outcome.kind === "refused" ? `expected text, got refusal ${outcome.code}: ${outcome.message}` : undefined);
	return outcome as Extract<InProcessReviewerOutcome, { kind: "text" }>;
}

// ---------------------------------------------------------------------------
// Every refusal code
// ---------------------------------------------------------------------------

test("refuses a selection with no provider/id separator", async () => {
	const outcome = await runInProcessReviewer(baseRequest({ selection: "gpt-5" }), {
		registry: fakeRegistry([fakeModel()]),
		complete: unreachableComplete,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.SELECTION_INVALID);
	assert.match(refused.message, /review-risk/);
});

test("refuses when the registry has no matching model", async () => {
	const outcome = await runInProcessReviewer(baseRequest({ selection: "openai/does-not-exist" }), {
		registry: fakeRegistry([fakeModel()]),
		complete: unreachableComplete,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.MODEL_NOT_FOUND);
	assert.match(refused.message, /review-risk/);
	assert.doesNotMatch(refused.message.toLowerCase(), /env var|extension/);
});

test("refuses when the registry cannot resolve auth", async () => {
	const outcome = await runInProcessReviewer(baseRequest(), {
		registry: fakeRegistry([fakeModel()], async () => ({ ok: false, error: "no stored credential" })),
		complete: unreachableComplete,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.AUTH_UNAVAILABLE);
	assert.match(refused.message, /openai/);
	assert.match(refused.message, /no stored credential/);
});

test("refuses an unknown thinking label", async () => {
	const outcome = await runInProcessReviewer(baseRequest({ thinking: "bogus" }), {
		registry: fakeRegistry([fakeModel()]),
		complete: unreachableComplete,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.THINKING_INVALID);
});

test("refuses when the reviewer attempts a tool call", async () => {
	const assistant = assistantText("", {
		content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }],
		stopReason: "toolUse",
	});
	const outcome = await runInProcessReviewer(baseRequest(), {
		registry: fakeRegistry([fakeModel()]),
		complete: async () => assistant,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.TOOL_CALL_ATTEMPTED);
});

test("refuses empty assistant text with stopReason evidence", async () => {
	const assistant = assistantText("", { content: [], stopReason: "stop" });
	const outcome = await runInProcessReviewer(baseRequest(), {
		registry: fakeRegistry([fakeModel()]),
		complete: async () => assistant,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT);
	assert.deepEqual(refused.evidence, { stopReason: "stop" });
});

test("refuses with PROVIDER_FAILED when the provider itself reports an aborted completion", async () => {
	const assistant = assistantText("", { content: [], stopReason: "aborted", errorMessage: "provider aborted mid-turn" });
	const outcome = await runInProcessReviewer(baseRequest(), {
		registry: fakeRegistry([fakeModel()]),
		complete: (async () => assistant) as typeof completeSimple,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED);
	assert.match(refused.message, /aborted/);
	assert.match(refused.message, /provider aborted mid-turn/);
});

test("refuses output over the byte bound", async () => {
	const oversized = "a".repeat(INPROCESS_REVIEWER_OUTPUT_MAX_BYTES + 16);
	const assistant = assistantText(oversized);
	const outcome = await runInProcessReviewer(baseRequest(), {
		registry: fakeRegistry([fakeModel()]),
		complete: async () => assistant,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.OUTPUT_TOO_LARGE);
	assert.match(refused.message, new RegExp(String(INPROCESS_REVIEWER_OUTPUT_MAX_BYTES)));
});

test("refuses with PROVIDER_FAILED when stopReason is error", async () => {
	const assistant = assistantText("", { content: [], stopReason: "error", errorMessage: "upstream 500" });
	const outcome = await runInProcessReviewer(baseRequest(), {
		registry: fakeRegistry([fakeModel()]),
		complete: async () => assistant,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED);
	assert.match(refused.message, /upstream 500/);
});

test("refuses with a bounded sanitized excerpt when complete throws", async () => {
	const raw = `boom ${"x".repeat(700)}\n\nwith \t whitespace`;
	const outcome = await runInProcessReviewer(baseRequest(), {
		registry: fakeRegistry([fakeModel()]),
		complete: (async () => {
			throw new Error(raw);
		}) as typeof completeSimple,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED);
	assert.ok(refused.message.length < raw.length, "the excerpt must be shorter than the raw error");
	assert.match(refused.message, /…/);
});

test("refuses with TIMED_OUT when the completion exceeds its bound", async () => {
	const outcome = await runInProcessReviewer(baseRequest({ timeoutMs: 20 }), {
		registry: fakeRegistry([fakeModel()]),
		complete: signalAwaitingComplete(),
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.TIMED_OUT);
	assert.match(refused.message, /20ms/);
});

test("refuses with ABORTED when the caller's own signal aborts", async () => {
	const controller = new AbortController();
	controller.abort();
	const outcome = await runInProcessReviewer(baseRequest({ timeoutMs: 5_000, signal: controller.signal }), {
		registry: fakeRegistry([fakeModel()]),
		complete: signalAwaitingComplete(),
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.ABORTED);
});

test("refuses with TIMED_OUT when the provider resolves an aborted message after the bound fires", async () => {
	const outcome = await runInProcessReviewer(baseRequest({ timeoutMs: 20 }), {
		registry: fakeRegistry([fakeModel()]),
		complete: signalResolvingAbortedComplete(),
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.TIMED_OUT);
	assert.match(refused.message, /20ms/);
});

test("refuses with ABORTED when the provider resolves partial text after the caller aborts", async () => {
	const controller = new AbortController();
	controller.abort();
	const outcome = await runInProcessReviewer(baseRequest({ timeoutMs: 5_000, signal: controller.signal }), {
		registry: fakeRegistry([fakeModel()]),
		complete: signalResolvingAbortedComplete("truncated findings"),
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.ABORTED);
});

// ---------------------------------------------------------------------------
// Exact Context passed to complete
// ---------------------------------------------------------------------------

test("passes exactly one user message with the verbatim prompt, no systemPrompt, no tools", async () => {
	const { complete, calls } = capturingComplete(assistantText("looks fine"));
	const prompt = Buffer.from("frozen prompt bytes", "utf8");
	await runInProcessReviewer(baseRequest({ prompt }), {
		registry: fakeRegistry([fakeModel()]),
		complete,
		now: () => 12_345,
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]!.context, {
		messages: [{ role: "user", content: [{ type: "text", text: "frozen prompt bytes" }], timestamp: 12_345 }],
	});
	assert.ok(!("systemPrompt" in calls[0]!.context));
	assert.ok(!("tools" in calls[0]!.context));
});

// ---------------------------------------------------------------------------
// Thinking mapping
// ---------------------------------------------------------------------------

test("omits reasoning when thinking is off (or omitted)", async () => {
	const { complete, calls } = capturingComplete(assistantText("ok"));
	await runInProcessReviewer(baseRequest({ thinking: "off" }), { registry: fakeRegistry([fakeModel()]), complete });
	assert.ok(!("reasoning" in (calls[0]!.options ?? {})));
});

test("forwards max verbatim so pi-ai applies the model's own level map", async () => {
	const { complete, calls } = capturingComplete(assistantText("ok"));
	await runInProcessReviewer(baseRequest({ thinking: "max" }), { registry: fakeRegistry([fakeModel()]), complete });
	assert.equal(calls[0]!.options?.reasoning, "max");
});

test("passes a known label through unchanged", async () => {
	const { complete, calls } = capturingComplete(assistantText("ok"));
	await runInProcessReviewer(baseRequest({ thinking: "high" }), { registry: fakeRegistry([fakeModel()]), complete });
	assert.equal(calls[0]!.options?.reasoning, "high");
});

test("omits reasoning for a non-reasoning model even with a valid label", async () => {
	const { complete, calls } = capturingComplete(assistantText("ok"));
	await runInProcessReviewer(baseRequest({ thinking: "high" }), {
		registry: fakeRegistry([fakeModel({ reasoning: false })]),
		complete,
	});
	assert.ok(!("reasoning" in (calls[0]!.options ?? {})));
});

// ---------------------------------------------------------------------------
// OpenCode session attribution headers
//
// Pi adds OpenCode attribution headers inside the main agent loop
// (provider-attribution.js#getSessionHeaders). This completion is an extension
// side-call that bypasses that loop, so it must add the same headers itself:
// provider opencode / opencode-go, or a baseUrl whose host is opencode.ai,
// carrying the live session id — and nothing for any other provider.
// ---------------------------------------------------------------------------

const OPENCODE_ATTRIBUTION_TESTS: Array<{ readonly name: string; readonly model: Partial<Model<Api>>; readonly selection: string }> = [
	{ name: "an opencode provider model", model: { provider: "opencode", id: "sonnet-4", baseUrl: "https://opencode.ai" }, selection: "opencode/sonnet-4" },
	{ name: "an opencode-go provider model", model: { provider: "opencode-go", id: "gpt-5", baseUrl: "https://opencode.ai" }, selection: "opencode-go/gpt-5" },
	{ name: "a custom provider whose baseUrl host is opencode.ai", model: { provider: "custom", id: "relay-model", baseUrl: "https://opencode.ai/v1" }, selection: "custom/relay-model" },
];

for (const { name, model, selection } of OPENCODE_ATTRIBUTION_TESTS) {
	test(`${name} receives both attribution headers carrying the live session id`, async () => {
		const { complete, calls } = capturingComplete(assistantText("ok"));
		const outcome = await runInProcessReviewer(baseRequest({ selection, sessionId: "ses-live-1" }), {
			registry: fakeRegistry([fakeModel(model)]),
			complete,
		});
		expectText(outcome);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.options?.headers?.["x-opencode-session"], "ses-live-1");
		assert.equal(calls[0]!.options?.headers?.["x-opencode-client"], "pi");
	});
}

for (const { name, model, selection } of OPENCODE_ATTRIBUTION_TESTS) {
	test(`${name} without a session id adds no attribution header and still completes`, async () => {
		const { complete, calls } = capturingComplete(assistantText("ok"));
		const outcome = await runInProcessReviewer(baseRequest({ selection }), {
			registry: fakeRegistry([fakeModel(model)]),
			complete,
		});
		expectText(outcome);
		assert.equal(calls.length, 1);
		assert.ok(!("headers" in (calls[0]!.options ?? {})), "a missing session id must never invent a header");
	});
}

test("a non-OpenCode model adds no attribution headers and leaves the options unchanged", async () => {
	const { complete, calls } = capturingComplete(assistantText("ok"));
	const outcome = await runInProcessReviewer(baseRequest({ selection: "anthropic/claude-sonnet-4", sessionId: "ses-live-1" }), {
		registry: fakeRegistry([fakeModel({ provider: "anthropic", id: "claude-sonnet-4", baseUrl: "https://api.anthropic.com" })]),
		complete,
	});
	expectText(outcome);
	assert.equal(calls.length, 1);
	assert.ok(!("headers" in (calls[0]!.options ?? {})));
});

test("registry auth headers win over the attribution defaults and both survive the merge", async () => {
	const { complete, calls } = capturingComplete(assistantText("ok"));
	const outcome = await runInProcessReviewer(baseRequest({ selection: "opencode/sonnet-4", sessionId: "ses-live-1" }), {
		registry: fakeRegistry([fakeModel({ provider: "opencode", id: "sonnet-4" })], async () => ({
			ok: true,
			headers: { "x-api-key": "registry-key", "x-opencode-session": "registry-session" },
		})),
		complete,
	});
	expectText(outcome);
	const headers = calls[0]!.options?.headers;
	assert.equal(headers?.["x-api-key"], "registry-key", "registry auth headers must survive");
	assert.equal(headers?.["x-opencode-session"], "registry-session", "explicit registry headers must not be clobbered by the attribution default");
	assert.equal(headers?.["x-opencode-client"], "pi");
});

test("an unparseable baseUrl never throws: attribution follows the provider condition only", async () => {
	const { complete, calls } = capturingComplete(assistantText("ok"));
	const outcome = await runInProcessReviewer(baseRequest({ selection: "custom/relay-model", sessionId: "ses-live-1" }), {
		registry: fakeRegistry([fakeModel({ provider: "custom", id: "relay-model", baseUrl: "not-a-url" })]),
		complete,
	});
	expectText(outcome);
	assert.ok(!("headers" in (calls[0]!.options ?? {})));
});

test("openCodeSessionAttributionHeaders mirrors pi's condition exactly", () => {
	const opencode = fakeModel({ provider: "opencode", baseUrl: "https://example.com" });
	assert.deepEqual(openCodeSessionAttributionHeaders(opencode, "ses-1"), { "x-opencode-session": "ses-1", "x-opencode-client": "pi" });
	assert.deepEqual(openCodeSessionAttributionHeaders(fakeModel({ provider: "opencode-go" }), "ses-1"), { "x-opencode-session": "ses-1", "x-opencode-client": "pi" });
	assert.deepEqual(openCodeSessionAttributionHeaders(fakeModel({ provider: "custom", baseUrl: "https://opencode.ai/v1" }), "ses-1"), { "x-opencode-session": "ses-1", "x-opencode-client": "pi" });
	assert.equal(openCodeSessionAttributionHeaders(fakeModel({ provider: "custom", baseUrl: "https://api.opencode.ai" }), "ses-1"), undefined, "a subdomain host is not opencode.ai");
	assert.equal(openCodeSessionAttributionHeaders(fakeModel(), "ses-1"), undefined);
	assert.equal(openCodeSessionAttributionHeaders(opencode, undefined), undefined, "no session id, no header");
	assert.equal(openCodeSessionAttributionHeaders(opencode, ""), undefined, "an empty session id is no session id");
});

// ---------------------------------------------------------------------------
// Text concatenation ignoring thinking parts
// ---------------------------------------------------------------------------

test("concatenates only text parts, ignoring thinking parts, in order", async () => {
	const assistant = assistantText("", {
		content: [
			{ type: "thinking", thinking: "reasoning about the diff" },
			{ type: "text", text: "Part A " },
			{ type: "thinking", thinking: "more reasoning" },
			{ type: "text", text: "Part B" },
		],
	});
	const outcome = await runInProcessReviewer(baseRequest(), {
		registry: fakeRegistry([fakeModel()]),
		complete: async () => assistant,
	});
	const text = expectText(outcome);
	assert.equal(text.text, "Part A Part B");
	assert.equal(text.reviewerModel, "openai/gpt-5");
});
