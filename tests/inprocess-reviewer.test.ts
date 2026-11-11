import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	INPROCESS_REVIEWER_EMPTY_OUTPUT_CAUSE,
	INPROCESS_REVIEWER_FAILURE,
	INPROCESS_REVIEWER_OUTPUT_MAX_BYTES,
	classifyEmptyOutput,
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
		const keepalive = setTimeout(() => {}, 60_000);
		try {
			return await new Promise<AssistantMessage>((_resolve, reject) => {
				const signal = options?.signal;
				if (signal === undefined) return;
				if (signal.aborted) {
					reject(new Error("aborted"));
					return;
				}
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		} finally {
			clearTimeout(keepalive);
		}
	}) as typeof completeSimple;
}

/**
 * A `complete` fake that follows the pi-ai provider convention on abort:
 * once the signal fires it RESOLVES an AssistantMessage carrying the text
 * streamed so far and `stopReason: "aborted"`, instead of rejecting.
 */
function signalResolvingAbortedComplete(partialText = "partial revi"): typeof completeSimple {
	return (async (_model, _context, options) => {
		const keepalive = setTimeout(() => {}, 60_000);
		try {
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
		} finally {
			clearTimeout(keepalive);
		}
	}) as typeof completeSimple;
}

/** A canary `complete` fake for refusals that must never reach the provider. */
const unreachableComplete: typeof completeSimple = (async () => {
	throw new Error("complete must not be called for this refusal");
}) as typeof completeSimple;

/**
 * A `getProvider` fake standing in for pi's composed provider: it records
 * every dispatch and returns a stream whose `result()` settles the
 * completion, which is exactly the shape pi-ai's own compat layer consumes.
 * The registry it is spread onto keeps `fakeRegistry`'s default shape, so the
 * no-`getProvider` seam the other tests use stays untouched.
 */
function capturingProvider(assistant: AssistantMessage) {
	const calls: Array<{ provider: string; model: Model<Api>; context: Context; options: SimpleStreamOptions | undefined }> = [];
	const getProvider = (provider: string) => ({
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
			calls.push({ provider, model, context, options });
			return { result: async () => assistant };
		},
	});
	return { getProvider, calls };
}

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

function withoutRunTiming(evidence: Record<string, unknown> | undefined): Record<string, unknown> {
	const { durationMs, authDurationMs, completionDurationMs, ...facts } = evidence ?? {};
	return facts;
}

test("refuses empty assistant text with safe completion evidence", async () => {
	const assistant = assistantText("", { content: [], stopReason: "stop" });
	const outcome = await runInProcessReviewer(baseRequest(), {
		registry: fakeRegistry([fakeModel()]),
		complete: async () => assistant,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT);
	assert.deepEqual(withoutRunTiming(refused.evidence), {
		phase: "completion", provider: "openai",
		reviewerModel: "openai/gpt-5", stopReason: "stop",
		cause: INPROCESS_REVIEWER_EMPTY_OUTPUT_CAUSE.EMPTY_COMPLETION,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		content: { blocks: 0, textBlocks: 0, thinkingBlocks: 0, textChars: 0, thinkingChars: 0 },
	});
});

test("empty-output diagnostics allowlist facts, not provider secrets, and complete once", async () => {
	const model = fakeModel({ provider: "nan", id: "deepseek-v4-flash" });
	const assistant = assistantText("", {
		content: [{ type: "text", text: "" }, { type: "thinking", thinking: "PRIVATE THINKING", thinkingSignature: "PRIVATE SIGNATURE" }],
		stopReason: "length", errorMessage: "PRIVATE ERROR", rawStopReason: "PRIVATE STOP",
		usage: { input: 12, output: 64, reasoning: 64, cacheRead: 0, cacheWrite: 0, totalTokens: 76, unknown: "PRIVATE USAGE", cost: { secret: "PRIVATE COST" } } as never,
	});
	const { complete, calls } = capturingComplete(assistant);
	const refused = expectRefused(await runInProcessReviewer(baseRequest(), {
		registry: { ...fakeRegistry([model]), find: () => model }, complete,
	}));
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT);
	assert.equal(calls.length, 1);
	assert.deepEqual(withoutRunTiming(refused.evidence), {
		phase: "completion", provider: "nan",
		reviewerModel: "nan/deepseek-v4-flash", stopReason: "length",
		cause: INPROCESS_REVIEWER_EMPTY_OUTPUT_CAUSE.REASONING_EXHAUSTED_OUTPUT_BUDGET,
		usage: { input: 12, output: 64, reasoning: 64, cacheRead: 0, cacheWrite: 0, totalTokens: 76 },
		content: { blocks: 2, textBlocks: 1, thinkingBlocks: 1, textChars: 0, thinkingChars: 16 },
	});
	assert.doesNotMatch(JSON.stringify(refused), /PRIVATE|errorMessage|rawStopReason|Signature|unknown|cost/);
});

test("empty-output evidence omits unknown or invalid counters and bounds resolved model identity", async () => {
	for (const invalid of [undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "12"]) {
		const assistant = assistantText("", {
			content: [], stopReason: "PRIVATE STOP" as never,
			usage: Object.fromEntries(["input", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens"].map((key) => [key, invalid])) as never,
		});
		const refused = expectRefused(await runInProcessReviewer(baseRequest(), {
			registry: { ...fakeRegistry([]), find: () => fakeModel({ id: "x".repeat(2_000) }) },
			complete: async () => assistant,
		}));
		assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT);
		assert.equal(String(refused.evidence?.reviewerModel).length, 512);
		assert.ok(!Object.hasOwn(refused.evidence!, "usage"));
		assert.ok(!Object.hasOwn(refused.evidence!, "stopReason"));
		assert.doesNotMatch(JSON.stringify(refused), /PRIVATE STOP/);
	}
});

test("empty-output evidence does not invent usage or missing thinking lengths", async () => {
	const refused = expectRefused(await runInProcessReviewer(baseRequest(), {
		registry: fakeRegistry([fakeModel()]),
		complete: async () => assistantText("", { content: [{ type: "thinking" } as never], usage: undefined }),
	}));
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT);
	assert.ok(!Object.hasOwn(refused.evidence!, "usage"));
	assert.deepEqual(refused.evidence?.content, { blocks: 1, textBlocks: 0, thinkingBlocks: 1, textChars: 0 });
});

// gentle-ai#6095: an empty completion is attributed to whatever the completion
// itself proves — the model's spent output budget, or a provider response with
// no completion at all — instead of the generic "produced no text", which left
// the recorded facts uninterpreted. None of these refusals infers a candidate
// issue: a generation failure is a transport outcome, not a review finding.

test("attributes an empty verdict to a reviewer model that spent its output budget on reasoning", async () => {
	const model = fakeModel({ provider: "nan", id: "glm5.3", maxTokens: 16_384 });
	const assistant = assistantText("", {
		content: [{ type: "thinking", thinking: "x".repeat(74_755), thinkingSignature: "PRIVATE SIGNATURE" }],
		stopReason: "length", errorMessage: "PRIVATE ERROR",
		usage: { input: 901, output: 16_384, reasoning: 16_384, cacheRead: 0, cacheWrite: 0, totalTokens: 17_285 } as never,
	});
	const refused = expectRefused(await runInProcessReviewer(baseRequest(), {
		registry: { ...fakeRegistry([model]), find: () => model }, complete: async () => assistant,
	}));
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT);
	assert.equal(refused.evidence?.cause, INPROCESS_REVIEWER_EMPTY_OUTPUT_CAUSE.REASONING_EXHAUSTED_OUTPUT_BUDGET);
	assert.match(refused.message, /^Reviewer model nan\/glm5\.3 exhausted its 16384-token output budget on reasoning before emitting a verdict for review-risk \(stopReason: length; output: 16384; reasoning: 16384\)\./);
	assert.match(refused.message, /Route this lens to a reviewer model with a sufficient output ceiling, raise the output budget, or reduce reasoning\./);
	assert.match(refused.message, /No candidate issue is inferred from this generation failure\./);
	// The facts that make the attribution checkable stay in the record.
	assert.equal(refused.evidence?.reviewerModel, "nan/glm5.3");
	assert.equal(refused.evidence?.stopReason, "length");
	assert.deepEqual(refused.evidence?.usage, { input: 901, output: 16_384, reasoning: 16_384, cacheRead: 0, cacheWrite: 0, totalTokens: 17_285 });
	assert.equal((refused.evidence?.content as Record<string, number>).textBlocks, 0);
	assert.doesNotMatch(JSON.stringify(refused), /PRIVATE|Signature|errorMessage/);
});

test("attributes an empty completion with zero output tokens to the provider response", async () => {
	const model = fakeModel({ provider: "nan", id: "glm5.3" });
	const assistant = assistantText("", {
		content: [], stopReason: "stop",
		usage: { input: 901, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 901 } as never,
	});
	const refused = expectRefused(await runInProcessReviewer(baseRequest(), {
		registry: { ...fakeRegistry([model]), find: () => model }, complete: async () => assistant,
	}));
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT);
	assert.equal(refused.evidence?.cause, INPROCESS_REVIEWER_EMPTY_OUTPUT_CAUSE.EMPTY_COMPLETION);
	assert.equal(
		refused.message,
		"The provider returned no completion for review-risk from reviewer model nan/glm5.3 (stopReason: stop; output: 0). Retry the slot. No candidate issue is inferred from this generation failure.",
	);
	assert.equal(refused.evidence?.reviewerModel, "nan/glm5.3");
	assert.equal(refused.evidence?.stopReason, "stop");
	assert.deepEqual(refused.evidence?.usage, { input: 901, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 901 });
});

test("keeps the generic empty-output refusal for shapes it cannot attribute", async () => {
	const unattributed: Array<{ name: string; assistant: AssistantMessage }> = [
		{ name: "length with no reasoning reported", assistant: assistantText("", { content: [], stopReason: "length", usage: { input: 5, output: 64, cacheRead: 0, cacheWrite: 0, totalTokens: 69 } as never }) },
		{ name: "length with zero output tokens", assistant: assistantText("", { content: [], stopReason: "length", usage: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } as never }) },
		{ name: "stop with no usage reported", assistant: assistantText("", { content: [], stopReason: "stop", usage: undefined }) },
		{ name: "partial reasoning below the budget", assistant: assistantText("", { content: [], stopReason: "length", usage: { input: 5, output: 64, reasoning: 63, cacheRead: 0, cacheWrite: 0, totalTokens: 69 } as never }) },
		{ name: "unrecognized stop reason", assistant: assistantText("", { content: [], stopReason: "deferred" }) },
	];
	for (const { name, assistant } of unattributed) {
		const refused = expectRefused(await runInProcessReviewer(baseRequest(), {
			registry: fakeRegistry([fakeModel()]), complete: async () => assistant,
		}));
		assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT, name);
		assert.ok(!Object.hasOwn(refused.evidence!, "cause"), name);
		assert.match(refused.message, /^Reviewer produced no text for review-risk \(stopReason: /, name);
		assert.doesNotMatch(refused.message, /No candidate issue is inferred/, name);
		assert.equal(classifyEmptyOutput(assistant), undefined, name);
	}
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
// Host deadlines must settle even when an auth/provider implementation ignores
// cancellation. The independent watchdog makes a broken implementation fail
// without leaving this suite waiting indefinitely.
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
// Capture real timers before per-test mocks: a broken handshake must still
// fail independently even while the reviewer deadline is driven manually.
const watchdogSetTimeout = setTimeout;
const watchdogClearTimeout = clearTimeout;
async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			timer = watchdogSetTimeout(() => reject(new Error("reviewer did not settle within the independent 250ms watchdog")), 250);
		})]);
	} finally { watchdogClearTimeout(timer!); }
}

test("host deadline bounds authentication that never resolves", async () => {
	let completions = 0;
	const outcome = await bounded(runInProcessReviewer(baseRequest({ timeoutMs: 15 }), {
		registry: fakeRegistry([fakeModel()], async () => await new Promise(() => {})),
		complete: (async () => { completions++; return assistantText("must not run"); }) as typeof completeSimple,
	}));
	assert.equal(expectRefused(outcome).code, INPROCESS_REVIEWER_FAILURE.TIMED_OUT);
	assert.equal(completions, 0);
});

test("host deadline skips auth and dispatch for an already cancelled caller", async () => {
	const caller = new AbortController(); caller.abort();
	let authentications = 0, completions = 0;
	const outcome = await runInProcessReviewer(baseRequest({ signal: caller.signal }), {
		registry: fakeRegistry([fakeModel()], async () => { authentications++; return { ok: true, apiKey: "fixture" }; }),
		complete: (async () => { completions++; return assistantText("must not run"); }) as typeof completeSimple,
	});
	assert.equal(expectRefused(outcome).code, INPROCESS_REVIEWER_FAILURE.ABORTED);
	assert.equal(authentications, 0); assert.equal(completions, 0);
});

for (const stop of ["caller", "deadline"] as const) {
	test(`host deadline does not dispatch after late authentication following ${stop}`, async () => {
		const auth = deferred<Awaited<ReturnType<InProcessReviewerRegistry["getApiKeyAndHeaders"]>>>();
		const caller = new AbortController();
		let completions = 0;
		const pending = runInProcessReviewer(baseRequest({ signal: caller.signal, timeoutMs: stop === "deadline" ? 15 : 30_000 }), {
			registry: fakeRegistry([fakeModel()], () => auth.promise),
			complete: (async () => { completions++; return assistantText("must not run"); }) as typeof completeSimple,
		});
		if (stop === "caller") caller.abort();
		try {
			const outcome = await bounded(pending);
			assert.equal(expectRefused(outcome).code, stop === "caller" ? INPROCESS_REVIEWER_FAILURE.ABORTED : INPROCESS_REVIEWER_FAILURE.TIMED_OUT);
		} finally { auth.resolve({ ok: true, apiKey: "fixture" }); }
		await nextTurn();
		assert.equal(completions, 0);
	});
}

for (const composed of [false, true]) {
	for (const late of ["fulfill", "reject"] as const) {
		test(`host deadline settles non-cooperative ${composed ? "composed" : "compat"} completion and consumes late ${late}`, { timeout: 5_000 }, async t => {
			let clock = 0;
			t.mock.method(performance, "now", () => clock);
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const completion = deferred<AssistantMessage>(), entered = deferred<void>();
			const registry = fakeRegistry([fakeModel()]);
			let calls = 0, providerSignal: AbortSignal | undefined;
			const complete = (async (_model, _context, options) => { calls++; providerSignal = options?.signal; entered.resolve(); return await completion.promise; }) as typeof completeSimple;
			if (composed) registry.getProvider = () => ({ streamSimple: (model, context, options) => ({ result: () => complete(model, context, options) }) });
			const pending = runInProcessReviewer(baseRequest({ timeoutMs: 15 }), { registry, complete });
			try {
				// This test targets a completion already dispatched. Contention
				// before auth/dispatch must not expire its deadline accidentally.
				await bounded(entered.promise);
				assert.equal(calls, 1);
				clock = 15; t.mock.timers.tick(15);
				const outcome = await bounded(pending);
				assert.equal(expectRefused(outcome).code, INPROCESS_REVIEWER_FAILURE.TIMED_OUT);
				assert.equal(providerSignal?.aborted, true); assert.equal(calls, 1);
			} finally {
				if (late === "fulfill" || calls === 0) completion.resolve(assistantText("late text must never be admitted"));
				else completion.reject(new Error("late provider rejection must be consumed"));
			}
			await nextTurn();
		});
	}
	test(`host deadline bounds caller cancellation of a non-cooperative ${composed ? "composed" : "compat"} completion`, async () => {
		const completion = deferred<AssistantMessage>(), entered = deferred<void>();
		const caller = new AbortController(), registry = fakeRegistry([fakeModel()]);
		let providerSignal: AbortSignal | undefined;
		const complete = (async (_model, _context, options) => { providerSignal = options?.signal; entered.resolve(); return await completion.promise; }) as typeof completeSimple;
		if (composed) registry.getProvider = () => ({ streamSimple: (model, context, options) => ({ result: () => complete(model, context, options) }) });
		const pending = runInProcessReviewer(baseRequest({ signal: caller.signal }), { registry, complete });
		try {
			await bounded(entered.promise);
			caller.abort();
			assert.equal(expectRefused(await bounded(pending)).code, INPROCESS_REVIEWER_FAILURE.ABORTED);
			assert.equal(providerSignal?.aborted, true);
			assert.equal(getEventListeners(caller.signal, "abort").length, 0);
			assert.equal(getEventListeners(providerSignal!, "abort").length, 0);
		} finally { caller.abort(); completion.resolve(assistantText("late text")); }
		await nextTurn();
	});
}

test("host deadline checks monotonic elapsed time after auth before the timer can run", async t => {
	let clock = 0, calls = 0;
	t.mock.method(performance, "now", () => clock);
	const auth = deferred<Awaited<ReturnType<InProcessReviewerRegistry["getApiKeyAndHeaders"]>>>();
	const pending = runInProcessReviewer(baseRequest({ timeoutMs: 100 }), {
		registry: fakeRegistry([fakeModel()], () => auth.promise),
		complete: (async () => { calls++; return assistantText("must not run"); }) as typeof completeSimple,
	});
	clock = 101;
	auth.resolve({ ok: true, apiKey: "fixture" });
	assert.equal(expectRefused(await bounded(pending)).code, INPROCESS_REVIEWER_FAILURE.TIMED_OUT);
	assert.equal(calls, 0);
});

test("host deadline takes precedence when caller cancellation is observed after expiry", async t => {
	let clock = 0;
	t.mock.method(performance, "now", () => clock);
	const caller = new AbortController();
	const pending = runInProcessReviewer(baseRequest({ timeoutMs: 100, signal: caller.signal }), {
		registry: fakeRegistry([fakeModel()], async () => await new Promise(() => {})), complete: unreachableComplete,
	});
	clock = 100;
	caller.abort();
	assert.equal(expectRefused(await bounded(pending)).code, INPROCESS_REVIEWER_FAILURE.TIMED_OUT);
});

test("host deadline removes its caller listener when authentication throws", async () => {
	const caller = new AbortController(), expected = new Error("auth fixture");
	await assert.rejects(runInProcessReviewer(baseRequest({ signal: caller.signal }), {
		registry: fakeRegistry([fakeModel()], async () => { throw expected; }), complete: unreachableComplete,
	}), error => error === expected);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

test("host deadline cleans caller/provider listeners and its timer after success", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const caller = new AbortController();
	let providerSignal: AbortSignal | undefined;
	const outcome = await runInProcessReviewer(baseRequest({ signal: caller.signal }), {
		registry: fakeRegistry([fakeModel()]),
		complete: (async (_model, _context, options) => { providerSignal = options?.signal; return assistantText("done"); }) as typeof completeSimple,
	});
	assert.equal(expectText(outcome).text, "done");
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	assert.equal(getEventListeners(providerSignal!, "abort").length, 0);
	t.mock.timers.tick(30_000);
	assert.equal(providerSignal?.aborted, false, "a completed call must not retain a deadline timer");
	caller.abort();
	assert.equal(providerSignal?.aborted, false, "a completed call must detach its caller signal");
});

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
// Resolved auth context — synthetic OAuth-like endpoint and provider env
// ---------------------------------------------------------------------------

for (const dispatch of ["composed provider", "compatibility complete"] as const) {
	function captureDispatch() {
		const provider = capturingProvider(assistantText("ok"));
		const compatibility = capturingComplete(assistantText("ok"));
		return {
			getProvider: dispatch === "composed provider" ? provider.getProvider : undefined,
			complete: dispatch === "composed provider" ? unreachableComplete : compatibility.complete,
			calls: dispatch === "composed provider" ? provider.calls : compatibility.calls,
		};
	}

	test(`${dispatch} preserves the registry's exchanged key, headers, account endpoint, and env`, async () => {
		const original = Object.freeze(fakeModel({ provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com" }));
		const snapshot = { ...original };
		const baseUrl = "https://api.synthetic-account.githubcopilot.com";
		const headers = Object.freeze({ "x-synthetic-auth": "registry-header", "x-suppress-default": null });
		const env = Object.freeze({ RDD_SYNTHETIC_PROVIDER_REGION: "test-region" });
		const ambientBefore = process.env.RDD_SYNTHETIC_PROVIDER_REGION;
		const { getProvider, complete, calls } = captureDispatch();
		const outcome = await runInProcessReviewer(baseRequest({ selection: "github-copilot/gpt-5" }), {
			registry: {
				...fakeRegistry([original], async (resolvedModel) => {
					assert.equal(resolvedModel, original, "auth must resolve against the registry model");
					return { ok: true, apiKey: "synthetic-exchanged-access-token", headers, baseUrl, env };
				}),
				...(getProvider === undefined ? {} : { getProvider }),
			},
			complete,
		});
		assert.equal(expectText(outcome).reviewerModel, "github-copilot/gpt-5");
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0]!.model, { ...snapshot, baseUrl });
		assert.notEqual(calls[0]!.model, original, "the endpoint override needs a request-local model");
		assert.equal(calls[0]!.options?.apiKey, "synthetic-exchanged-access-token");
		assert.equal(calls[0]!.options?.headers, headers);
		assert.equal(calls[0]!.options?.env, env);
		assert.deepEqual(original, snapshot, "shared registry state must remain unchanged");
		assert.equal(process.env.RDD_SYNTHETIC_PROVIDER_REGION, ambientBefore, "env must be forwarded, not installed globally");
	});

	test(`${dispatch} forwards env without an endpoint override`, async () => {
		const original = Object.freeze(fakeModel());
		const env = Object.freeze({ RDD_SYNTHETIC_PROVIDER_REGION: "env-only-region" });
		const { getProvider, complete, calls } = captureDispatch();
		expectText(await runInProcessReviewer(baseRequest(), {
			registry: {
				...fakeRegistry([original], async () => ({ ok: true, apiKey: "synthetic-key", env })),
				...(getProvider === undefined ? {} : { getProvider }),
			},
			complete,
		}));
		assert.equal(calls[0]!.model, original);
		assert.equal(calls[0]!.options?.env, env);
	});

	test(`${dispatch} preserves model defaults and omits unresolved env`, async () => {
		const original = Object.freeze(fakeModel());
		const { getProvider, complete, calls } = captureDispatch();
		expectText(await runInProcessReviewer(baseRequest(), {
			registry: { ...fakeRegistry([original]), ...(getProvider === undefined ? {} : { getProvider }) },
			complete,
		}));
		assert.equal(calls[0]!.model, original);
		assert.equal(calls[0]!.model.baseUrl, "https://api.openai.com");
		assert.ok(!("env" in (calls[0]!.options ?? {})));
	});

	for (const routedToOpenCode of [true, false]) {
		test(`${dispatch} uses the resolved endpoint for attribution when routed ${routedToOpenCode ? "to" : "away from"} OpenCode`, async () => {
			const original = Object.freeze(fakeModel({
				provider: "custom",
				baseUrl: routedToOpenCode ? "https://default.invalid" : "https://opencode.ai/v1",
			}));
			const baseUrl = routedToOpenCode ? "https://opencode.ai/v1" : "https://account.invalid/v1";
			const { getProvider, complete, calls } = captureDispatch();
			expectText(await runInProcessReviewer(baseRequest({ selection: "custom/gpt-5", sessionId: "ses-synthetic" }), {
				registry: {
					...fakeRegistry([original], async () => ({ ok: true, apiKey: "synthetic-key", baseUrl })),
					...(getProvider === undefined ? {} : { getProvider }),
				},
				complete,
			}));
			assert.deepEqual(calls[0]!.options?.headers, routedToOpenCode
				? { "x-opencode-session": "ses-synthetic", "x-opencode-client": "pi" }
				: undefined);
			assert.equal(calls[0]!.model.baseUrl, baseUrl);
		});
	}
}

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

test("each completion carries its own sessionId, never the parent session's", async () => {
	const { complete, calls } = capturingComplete(assistantText("ok"));
	const deps = { registry: fakeRegistry([fakeModel({ provider: "anthropic", id: "claude-sonnet-4" })]), complete };
	expectText(await runInProcessReviewer(baseRequest({ selection: "anthropic/claude-sonnet-4", sessionId: "ses-live-1" }), deps));
	expectText(await runInProcessReviewer(baseRequest({ selection: "anthropic/claude-sonnet-4", sessionId: "ses-live-1" }), deps));
	assert.equal(calls.length, 2);
	const [first, second] = calls.map((call) => call.options?.sessionId);
	assert.ok(typeof first === "string" && first.length > 0);
	assert.ok(typeof second === "string" && second.length > 0);
	assert.notEqual(first, second);
	assert.notEqual(first, "ses-live-1");
	assert.notEqual(second, "ses-live-1");
});

test("an OpenCode model with a live parent keeps the parent id in the attribution header while options.sessionId stays synthetic", async () => {
	const { complete, calls } = capturingComplete(assistantText("ok"));
	const outcome = await runInProcessReviewer(baseRequest({ selection: "opencode/sonnet-4", sessionId: "ses-live-1" }), {
		registry: fakeRegistry([fakeModel({ provider: "opencode", id: "sonnet-4", baseUrl: "https://opencode.ai" })]),
		complete,
	});
	expectText(outcome);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.options?.headers?.["x-opencode-session"], "ses-live-1");
	const sessionId = calls[0]!.options?.sessionId;
	assert.ok(typeof sessionId === "string" && sessionId.length > 0);
	assert.notEqual(sessionId, "ses-live-1");
});

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

// ---------------------------------------------------------------------------
// Composed-provider routing (gentle-shell#1304)
//
// pi-ai's `completeSimple` resolves against pi-ai's own builtin-only
// `apiProviderRegistry`, so an extension-registered provider is unreachable
// through it ("No API provider registered for api: <api>"). A registry that
// exposes `getProvider` carries pi's composed provider, which does honor
// extensions, and must be used instead of `deps.complete`.
// ---------------------------------------------------------------------------

test("dispatches through the composed provider's streamSimple when the registry exposes getProvider", async () => {
	const extensionModel = fakeModel({ provider: "claude-bridge", id: "claude-opus-5", api: "claude-bridge", baseUrl: "https://bridge.invalid" });
	const { getProvider, calls } = capturingProvider(assistantText("bridged review"));
	const outcome = await runInProcessReviewer(baseRequest({ selection: "claude-bridge/claude-opus-5" }), {
		// `unreachableComplete` is the canary: reaching pi-ai's compat path at
		// all is the defect, so any call to it fails this test.
		registry: { ...fakeRegistry([extensionModel]), getProvider },
		complete: unreachableComplete,
	});
	const text = expectText(outcome);
	assert.equal(text.text, "bridged review");
	assert.equal(text.reviewerModel, "claude-bridge/claude-opus-5");
	assert.equal(calls.length, 1, "the composed provider must receive exactly one dispatch");
	assert.equal(calls[0]!.provider, "claude-bridge", "the provider is resolved by the model's own provider id");
	assert.equal(calls[0]!.model.api, "claude-bridge", "the extension api must reach the composed provider unchanged");
});

test("forwards the same context and options to the composed provider as to deps.complete", async () => {
	const { getProvider, calls } = capturingProvider(assistantText("ok"));
	const prompt = Buffer.from("frozen prompt bytes", "utf8");
	const outcome = await runInProcessReviewer(baseRequest({ prompt, thinking: "high" }), {
		registry: { ...fakeRegistry([fakeModel()]), getProvider },
		complete: unreachableComplete,
		now: () => 12_345,
	});
	expectText(outcome);
	assert.deepEqual(calls[0]!.context, {
		messages: [{ role: "user", content: [{ type: "text", text: "frozen prompt bytes" }], timestamp: 12_345 }],
	});
	assert.equal(calls[0]!.options?.apiKey, "test-key", "registry-resolved credentials still travel on options");
	assert.equal(calls[0]!.options?.reasoning, "high");
});

test("refuses instead of falling back when getProvider returns undefined for a model find() resolved", async () => {
	const outcome = await runInProcessReviewer(baseRequest(), {
		registry: { ...fakeRegistry([fakeModel()]), getProvider: () => undefined },
		complete: unreachableComplete,
	});
	const refused = expectRefused(outcome);
	assert.equal(refused.code, INPROCESS_REVIEWER_FAILURE.MODEL_NOT_FOUND);
	assert.match(refused.message, /review-risk/);
	assert.deepEqual(withoutRunTiming(refused.evidence), { provider: "openai", api: "openai-responses", reviewerModel: "openai/gpt-5", phase: "configuration" }, "the evidence separates this cause from a plain unresolved selection");
});

// ---------------------------------------------------------------------------
// Env-API-key contract when the registry resolves no apiKey (gentle-shell#1304,
// IRP-4)
//
// pi-ai's compat layer wraps every dispatch in `withEnvApiKey`
// (@earendil-works/pi-ai/dist/compat.js:145-152, called at :190 and :193),
// which injects an API key read from the ambient environment whenever
// `options.apiKey` is absent or blank. pi's composed provider does no such
// thing: it forwards `options` verbatim. `ModelRegistry.getApiKeyAndHeaders`
// can legitimately resolve `{ ok: true, headers }` with no `apiKey` — a
// header-authenticated provider, for instance — so these tests pin what this
// module itself guarantees in that case, independently of which side settles
// the completion.
//
// The delta is not a regression. pi's own auth resolvers already read the same
// environment, through the same variable names, before this module dispatches:
// `getApiKeyAndHeaders` -> `ModelRuntime.getAuth` -> `Models.getAuth` ->
// `resolveProviderAuth` (dist/auth/resolve.js:51-54, the ambient branch) ->
// the provider's `ApiKeyAuth.resolve`, which reads `ctx.env(...)`
// (dist/auth/helpers.js:21-26) off `defaultProviderAuthContext`, whose `env`
// is `process.env` (dist/auth/context.js:19-24). So any key `withEnvApiKey`
// would have injected is one the registry has already returned as `apiKey`.
// What this module must never do is invent one itself: its header promises it
// "never reads process.env", and that promise is what these tests hold.
// ---------------------------------------------------------------------------

/** A registry auth resolution that succeeds with headers only — no `apiKey`. */
const HEADER_ONLY_AUTH_HEADERS = { Authorization: "Bearer resolved-by-the-registry" } as const;
const headerOnlyAuth = async () => ({ ok: true, headers: { ...HEADER_ONLY_AUTH_HEADERS } }) as const;

/**
 * Runs `body` with a synthetic value on the environment variable pi-ai's
 * compat layer would read for the default fake model's provider
 * (`openai` -> `OPENAI_API_KEY`, dist/env-api-keys.js:77), restoring the
 * previous value afterwards. The value is a fixed placeholder, never a
 * credential: the assertions only check that it does NOT appear on the
 * forwarded options.
 */
async function withAmbientProviderApiKey<T>(body: () => Promise<T>): Promise<T> {
	const name = "OPENAI_API_KEY";
	const previous = process.env[name];
	process.env[name] = "ambient-placeholder-the-module-must-never-read";
	try {
		return await body();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

test("forwards no apiKey to the composed provider when the registry resolves auth without one", async () => {
	const { getProvider, calls } = capturingProvider(assistantText("ok"));
	const outcome = await withAmbientProviderApiKey(() =>
		runInProcessReviewer(baseRequest(), {
			registry: { ...fakeRegistry([fakeModel()], headerOnlyAuth), getProvider },
			complete: unreachableComplete,
		}),
	);
	expectText(outcome);
	assert.equal(calls.length, 1, "the composed provider must receive exactly one dispatch");
	const options = calls[0]!.options;
	assert.notEqual(options, undefined, "options must reach the composed provider");
	assert.equal("apiKey" in options!, false, "the module must not invent an apiKey the registry did not resolve, nor read one from the ambient environment");
	assert.deepEqual(options!.headers, { ...HEADER_ONLY_AUTH_HEADERS }, "the registry's own auth headers are the credential on this path");
});

test("forwards no apiKey to deps.complete when the registry resolves auth without one", async () => {
	const { complete, calls } = capturingComplete(assistantText("ok"));
	const outcome = await withAmbientProviderApiKey(() =>
		runInProcessReviewer(baseRequest(), {
			registry: fakeRegistry([fakeModel()], headerOnlyAuth),
			complete,
		}),
	);
	expectText(outcome);
	assert.equal(calls.length, 1, "the fallback path must receive exactly one dispatch");
	const options = calls[0]!.options;
	assert.notEqual(options, undefined, "options must reach deps.complete");
	assert.equal("apiKey" in options!, false, "the fallback path must not invent an apiKey either; compat's own withEnvApiKey is pi-ai's business, not this module's");
	assert.deepEqual(options!.headers, { ...HEADER_ONLY_AUTH_HEADERS }, "the registry's own auth headers are the credential on this path too");
});

test("the no-apiKey options shape is identical on the composed-provider and deps.complete paths", async () => {
	const { getProvider, calls: providerCalls } = capturingProvider(assistantText("ok"));
	const { complete, calls: completeCalls } = capturingComplete(assistantText("ok"));
	await withAmbientProviderApiKey(async () => {
		expectText(
			await runInProcessReviewer(baseRequest(), {
				registry: { ...fakeRegistry([fakeModel()], headerOnlyAuth), getProvider },
				complete: unreachableComplete,
			}),
		);
		expectText(
			await runInProcessReviewer(baseRequest(), {
				registry: fakeRegistry([fakeModel()], headerOnlyAuth),
				complete,
			}),
		);
	});
	// Option *keys* rather than values: the two runs carry different
	// AbortSignal instances by construction, so only the shape is comparable.
	const providerKeys = Object.keys(providerCalls[0]!.options ?? {}).sort();
	const completeKeys = Object.keys(completeCalls[0]!.options ?? {}).sort();
	assert.deepEqual(providerKeys, completeKeys, "routing through the composed provider must not change which credential fields this module forwards");
	assert.equal(providerKeys.includes("apiKey"), false, "neither path may carry an apiKey the registry did not resolve");
});

for (const transport of ["sse", "websocket", "websocket-cached", "auto", undefined] as const) {
	for (const composed of [false, true]) {
		test(`reviewer forwards transport ${transport ?? "absent"} through ${composed ? "composed provider" : "compat completion"} unchanged`, async () => {
			const model = fakeModel();
			const registry = fakeRegistry([model]);
			const captured = capturingComplete(assistantText("review result"));
			if (composed) registry.getProvider = () => ({
				streamSimple: (model, context, options) => ({ result: () => captured.complete(model, context, options) }),
			});
			const outcome = await runInProcessReviewer(baseRequest({ transport }), { registry, complete: captured.complete });
			const { evidence, ...completion } = outcome;
			assert.deepEqual(completion, { kind: "text", text: "review result", reviewerModel: "openai/gpt-5" });
			assert.equal(evidence?.phase, "completion");
			assert.equal(captured.calls.length, 1);
			assert.equal(captured.calls[0]!.options?.transport, transport);
			assert.equal(Object.hasOwn(captured.calls[0]!.options!, "transport"), transport !== undefined);
			assert.equal(captured.calls[0]!.options?.apiKey, "test-key");
			assert.equal(captured.calls[0]!.options?.timeoutMs, 30_000);
		});
	}
}
