import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluateModelFallback,
	FALLBACK_EFFORT,
	FALLBACK_MODEL,
	FALLBACK_MODEL_ID,
	FALLBACK_PROVIDER,
	isEligibleProviderError,
} from "../lib/model-fallback.ts";

test("eligible 429 provider error produces single fallback decision with metadata", () => {
	const result = evaluateModelFallback({
		primaryModel: "anthropic/claude-3-7-sonnet",
		primaryEffort: "medium",
		origin: "model_provider",
		error: { status: 429, message: "rate limit exceeded" },
		fallbackAvailable: true,
	});

	assert.equal(result.action, "fallback");
	assert.equal(result.eligible, true);
	if (result.action === "fallback") {
		assert.equal(result.fallbackModel, FALLBACK_MODEL);
		assert.equal(result.fallbackEffort, FALLBACK_EFFORT);
		assert.deepEqual(result.metadata, {
			target: "cli-proxy-api/gemini-3.8-flash-high",
			provider: "cli-proxy-api",
			modelId: "gemini-3.8-flash-high",
			effort: "high",
			primaryModel: "anthropic/claude-3-7-sonnet",
			primaryEffort: "medium",
		});
	}
});

test("positive eligible provider errors accept 429, 500, 502, 503, 504, quota, and transient transport", () => {
	const positiveCases = [
		{ status: 429 },
		{ statusCode: 500 },
		{ status: 502 },
		{ status: 503 },
		{ status: 504 },
		{ code: "RESOURCE_EXHAUSTED" },
		{ code: "rate_limit_exceeded" },
		{ code: "quota_exceeded" },
		{ code: "UNAVAILABLE" },
		{ code: "SERVICE_UNAVAILABLE" },
		{ code: "TRANSIENT_FAILURE" },
		{ code: "ECONNRESET" },
		{ code: "ETIMEDOUT" },
		{ code: "UND_ERR_SOCKET" },
		{ message: "socket hang up" },
		{ message: "stream disconnected unexpectedly" },
		{ message: "fetch failed: premature close" },
	];

	for (const err of positiveCases) {
		assert.equal(isEligibleProviderError(err, "model_provider"), true);
		assert.equal(isEligibleProviderError({ ...err, origin: "provider" }), true);
	}
	assert.equal(isEligibleProviderError({ origin: "provider", status: 429 }, "model_provider"), true);
	assert.equal(isEligibleProviderError({ origin: "model_provider", status: 429 }, "provider"), true);
});

test("negative errors reject abort, auth, context overflow, invalid request, unknown, user refusal, rdd", () => {
	const negativeCases = [
		{ name: "AbortError", message: "The operation was aborted" },
		{ code: "ABORT_ERR" },
		{ status: 401, message: "Unauthorized invalid API key" },
		{ status: 403, code: "PERMISSION_DENIED" },
		{ code: "INVALID_API_KEY" },
		{ code: "CONTEXT_OVERFLOW", message: "Context length exceeded" },
		{ code: "prompt_too_long" },
		{ status: 400, message: "Bad request: invalid parameter" },
		{ status: 422, code: "INVALID_ARGUMENT" },
		{ code: "USER_REFUSAL", message: "User declined execution" },
		{ code: "RDD_FAILURE", message: "Native review authority quarantined" },
		{ code: "TOOL_CAPABILITY_DENIAL", message: "Tool capability denied" },
		{ code: "429garbage" },
		{ code: "503tool-denied" },
		{ message: "Some unknown internal runtime error" },
		new Error("plain unexpected syntax or logic bug"),
	];

	for (const err of negativeCases) {
		assert.equal(isEligibleProviderError(err, "model_provider"), false);
	}
});

test("failure origin must be explicit model provider and rejects conflicting origins", () => {
	assert.equal(isEligibleProviderError({ origin: "tool", status: 429 }), false);
	assert.equal(isEligibleProviderError({ origin: "tool", status: 429 }, "model_provider"), false);
	assert.equal(isEligibleProviderError({ origin: "task", status: 500 }, "model_provider"), false);
	assert.equal(isEligibleProviderError({ origin: "rdd", status: 503 }, "provider"), false);
	assert.equal(isEligibleProviderError({ origin: "user", status: 429 }, "model_provider"), false);
	assert.equal(isEligibleProviderError({ message: "429 rate limit" }, "task"), false);
	assert.equal(isEligibleProviderError({ status: 429 }), false);
});

test("policy stops on already attempted, fallback unavailable/missing, or primary equals fallback", () => {
	const baseEligible = {
		primaryModel: "anthropic/claude-3-7-sonnet",
		origin: "model_provider",
		error: { status: 429 },
		fallbackAvailable: true,
	};

	const missingAvailable = evaluateModelFallback({
		...baseEligible,
		fallbackAvailable: undefined,
	});
	assert.equal(missingAvailable.action, "stop");
	assert.equal(missingAvailable.reason, "fallback_unavailable");

	const explicitUnavailable = evaluateModelFallback({
		...baseEligible,
		fallbackAvailable: false,
	});
	assert.equal(explicitUnavailable.action, "stop");
	assert.equal(explicitUnavailable.reason, "fallback_unavailable");

	const alreadyAttempted = evaluateModelFallback({
		...baseEligible,
		attempted: true,
	});
	assert.equal(alreadyAttempted.action, "stop");
	assert.equal(alreadyAttempted.reason, "already_attempted");

	const sameModel = evaluateModelFallback({
		...baseEligible,
		primaryModel: "cli-proxy-api/gemini-3.8-flash-high",
	});
	assert.equal(sameModel.action, "stop");
	assert.equal(sameModel.reason, "primary_equals_fallback");

	const sameModelShort = evaluateModelFallback({
		...baseEligible,
		primaryModel: "gemini-3.8-flash-high",
	});
	assert.equal(sameModelShort.action, "stop");
	assert.equal(sameModelShort.reason, "primary_equals_fallback");

	const ineligible = evaluateModelFallback({
		...baseEligible,
		error: { status: 400, message: "invalid request" },
	});
	assert.equal(ineligible.action, "stop");
	assert.equal(ineligible.reason, "ineligible_provider_error");
});
