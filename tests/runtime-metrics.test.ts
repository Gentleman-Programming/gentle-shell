import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeMetrics, type FinalResponse } from "../lib/runtime-metrics.ts";

function response(responseId = "local-response"): FinalResponse {
	return {
		kind: "final_assistant_response", responseId,
		executor: "worker", provider: "openai-codex", modelFamily: "gpt",
		effort: "high", error: "none",
		tokens: {
			input: { state: "reported", value: 0 }, output: { state: "reported", value: 12 },
			cacheRead: { state: "unavailable" }, cacheWrite: { state: "unsupported" },
		},
		responseHeadersMs: { state: "measured", value: 25.5 },
		fullResponseMs: { state: "measured", value: 100 },
	};
}

test("selected provider is independent from response provider without relabeling", () => {
	const metrics = new RuntimeMetrics();
	assert.equal(recordRaw(metrics, { ...response(), selectedProvider: "openai-codex",
		selectedModelId: "gpt-5.6-terra", provider: "anthropic" }), "recorded");
	const [row] = metrics.snapshot();
	assert.equal(row.selectedModelId, "gpt-5.6-terra");
	assert.equal(row.selectedProvider, "openai-codex");
	assert.equal(row.provider, "anthropic");
	// The provider dimension stays independent of a specific id's privacy outcome
	// at record time; the pair is only coupled to a schema-conformant custom/custom
	// model object later, at native encode time (see runtime-metrics-native.test.ts).
	assert.equal(recordRaw(metrics, { ...response("private"), selectedProvider: "openai-codex",
		selectedModelId: "private-internal-finetune" }), "recorded");
	assert.equal(metrics.snapshot()[1].selectedProvider, "openai-codex");
	assert.equal(metrics.snapshot()[1].selectedModelId, "custom");
});

test("open-weight models on arbitrary providers are reported by name, not squashed to a closed enum", () => {
	const metrics = new RuntimeMetrics();
	assert.equal(recordRaw(metrics, { ...response(), provider: "nan", selectedProvider: "nan",
		selectedModelId: "deepseek-v4-flash", responseModelId: "glm5.3-flash" }), "recorded");
	const [row] = metrics.snapshot();
	assert.equal(row.provider, "nan");
	assert.equal(row.selectedProvider, "nan");
	assert.equal(row.selectedModelId, "deepseek-v4-flash");
	assert.equal(row.responseModelId, "glm5.3-flash");
});

// Deliberately bypass static types to exercise the runtime boundary.
function recordRaw(metrics: RuntimeMetrics, value: unknown) {
	return metrics.record(value as FinalResponse);
}

test("optional native token fields preserve absence but reject explicit malformed values", () => {
	for (const value of [null, -1, { state: "reported", value: NaN }, { state: "reported", value: 1_000_000_001 }]) {
		assert.equal(recordRaw(new RuntimeMetrics(), { ...response(), tokens: { ...response().tokens, reasoning: value } }), "invalid");
	}
	const metrics = new RuntimeMetrics();
	assert.equal(metrics.record(response()), "recorded");
	assert.equal(metrics.snapshot()[0].tokens.reasoning.unavailable, 1);
});

test("accounts final responses with explicit zero, missing states and separate durations", () => {
	const metrics = new RuntimeMetrics();
	assert.equal(metrics.record(response()), "recorded");
	assert.equal(metrics.record(response("second")), "recorded");
	const [row] = metrics.snapshot();
	assert.equal(row.responses, 2);
	assert.deepEqual(row.tokens.input, { reported: 2, unavailable: 0, unsupported: 0, sum: 0 });
	assert.equal(row.tokens.output.sum, 24);
	assert.equal(row.tokens.cacheRead.unavailable, 2);
	assert.equal(row.tokens.cacheWrite.unsupported, 2);
	assert.equal(row.responseHeadersMs.sum, 51);
	assert.equal(row.fullResponseMs.sum, 200);
	assert.equal(row.executor, "worker");
});

test("deduplicates distinct local IDs without retaining them in snapshots", () => {
	const metrics = new RuntimeMetrics();
	assert.equal(metrics.record(response()), "recorded");
	assert.equal(metrics.record({ ...response(), effort: "low" }), "duplicate");
	assert.equal(metrics.record(response("second")), "recorded");
	assert.equal(metrics.snapshot()[0].responses, 2);
	assert.ok(!JSON.stringify(metrics.snapshot()).includes("local-response"));
	const copy = metrics.snapshot();
	copy[0].tokens.output.sum = 999;
	assert.equal(metrics.snapshot()[0].tokens.output.sum, 24);
});

test("effort selections and absence states remain distinct", () => {
	const metrics = new RuntimeMetrics();
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max",
		"not_selected", "unsupported", "unavailable"] as const;
	for (const effort of levels) assert.equal(metrics.record({ ...response(effort), effort }), "recorded");
	assert.deepEqual(metrics.snapshot().map(row => row.effort), levels);
	assert.equal(recordRaw(metrics, { ...response("bad"), effort: "ultra" }), "invalid");
});

test("only closed dimensions survive; no prompt-based executor inference", () => {
	const metrics = new RuntimeMetrics();
	assert.equal(recordRaw(metrics, {
		// Free text with spaces/case never matches the schema provider pattern,
		// unlike a genuine open-weight provider slug (see the dedicated test above).
		...response(), provider: "Private Provider Free Text", modelFamily: "private-model-id",
		executor: "SDD apply executor", systemPrompt: "reviewer", errorMessage: "private failure",
	}), "recorded");
	const [row] = metrics.snapshot();
	assert.equal(row.provider, "custom");
	assert.equal(row.modelFamily, "custom");
	assert.equal(row.executor, "unknown");
	assert.ok(!JSON.stringify(row).includes("private"));
	assert.equal(recordRaw(metrics, { ...response("missing"), provider: undefined, modelFamily: null }), "recorded");
	assert.equal(metrics.snapshot()[1].provider, "unknown");
	assert.equal(metrics.snapshot()[1].modelFamily, "unknown");
});

test("rejects malformed numbers and ambiguous measurement states atomically", () => {
	const metrics = new RuntimeMetrics();
	for (const value of [-1, NaN, Infinity, "12", null, 1e20]) {
		const base = response();
		assert.equal(recordRaw(metrics, { ...base, tokens: { ...base.tokens, input: { state: "reported", value } } }), "invalid");
		assert.equal(recordRaw(metrics, { ...base, fullResponseMs: { state: "measured", value } }), "invalid");
	}
	for (const measurement of [{ value: 0 }, { state: "reported" }, { state: "unsupported", value: 0 }]) {
		const base = response();
		assert.equal(recordRaw(metrics, { ...base, tokens: { ...base.tokens, input: measurement } }), "invalid");
	}
	assert.equal(recordRaw(metrics, { ...response(), tokens: { ...response().tokens, output: { state: "reported", value: 1.5 } } }), "invalid");
	assert.equal(recordRaw(metrics, { ...response(), fullResponseMs: { state: "reported", value: 10 } }), "invalid");
	assert.equal(recordRaw(metrics, { ...response(), fullResponseMs: { state: "measured", value: 10 } }), "invalid");
	assert.deepEqual(metrics.snapshot(), []);
	assert.equal(metrics.record(response()), "recorded", "invalid inputs do not reserve IDs");
});

test("rejects streaming, malformed records, identifiers and free-text errors", () => {
	const metrics = new RuntimeMetrics();
	for (const value of [null, {}, [], { ...response(), kind: "message_update" },
		{ ...response(), responseId: "" }, { ...response(), responseId: "x".repeat(129) },
		{ ...response(), error: "raw error text" }, { ...response(), tokens: null }]) {
		assert.equal(recordRaw(metrics, value), "invalid");
	}
	for (const error of ["none", "aborted", "rate_limit", "authentication", "network", "provider", "unknown"] as const) {
		assert.equal(metrics.record({ ...response(error), error, responseHeadersMs: { state: "unsupported" }, fullResponseMs: { state: "unavailable" } }), "recorded");
	}
	assert.equal(metrics.snapshot().length, 7);
});

test("host identity stays separate from role and rejects invented model dimensions", () => {
	const metrics = new RuntimeMetrics();
	assert.equal(recordRaw(metrics, { ...response("custom"), identity: { origin: "custom" } }), "recorded");
	assert.equal(recordRaw(metrics, { ...response("forged"), identity: { hostAgent: "private-worker", modelId: "secret-model" } }), "recorded");
	const rows = metrics.snapshot();
	assert.deepEqual(rows.map(row => [row.hostAgent, row.executor, row.selectedModelId, row.effort]), [
		["pi", "worker", "unknown", "high"],
	]);
	assert.ok(!JSON.stringify(rows).includes("secret-model"));
});

test("hard response and numeric ceilings keep aggregate totals bounded", () => {
	const metrics = new RuntimeMetrics();
	for (let i = 0; i < 1024; i++) {
		const record = response(String(i));
		record.tokens.input = { state: "reported", value: 1_000_000_000 };
		record.responseHeadersMs = { state: "measured", value: 0 };
		record.fullResponseMs = { state: "measured", value: 86_400_000 };
		assert.equal(metrics.record(record), "recorded");
	}
	assert.equal(metrics.record(response("overflow")), "capacity");
	const [row] = metrics.snapshot();
	assert.equal(row.responses, 1024);
	assert.equal(row.tokens.input.sum, 1_024_000_000_000);
	assert.equal(row.fullResponseMs.sum, 88_473_600_000);
	assert.equal(row.responseHeadersMs.measured, 1024);
	assert.equal(row.responseHeadersMs.sum, 0);
});

test("capacity rejection keeps dedupe and accounting intact without eviction", () => {
	const metrics = new RuntimeMetrics({ maxResponses: 2, maxBuckets: 1 });
	assert.equal(metrics.record(response("one")), "recorded");
	assert.equal(metrics.record({ ...response("two"), effort: "low" }), "capacity");
	assert.equal(metrics.record(response("two")), "recorded");
	assert.equal(metrics.record(response("three")), "capacity");
	assert.equal(metrics.record(response("one")), "duplicate");
	assert.equal(metrics.snapshot()[0].responses, 2);
	for (const maxResponses of [0, -1, 1.5, Infinity, 1025]) {
		assert.throws(() => new RuntimeMetrics({ maxResponses }), RangeError);
	}
	assert.throws(() => new RuntimeMetrics({ maxBuckets: 65 }), RangeError);
});
