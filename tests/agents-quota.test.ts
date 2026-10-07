import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { isQuotaExhaustion } from "../lib/agents-quota.ts";
import { TASK_EVENT, normalizeRpcEvent } from "../lib/agents-protocol.ts";

// Only explicit credit/quota exhaustion may change a role's routing.

// Pi's own non-retryable provider-limit messages that state real exhaustion: Pi
// fails these fast, so only a fallback keeps the work going.
const PI_LIMIT_MESSAGES = [
	"GoUsageLimitError: weekly limit reached",
	"FreeUsageLimitError: free tier used up",
	"Monthly usage limit reached",
	"Your available balance is insufficient",
	'429: {"error":{"type":"insufficient_quota"}}',
	"The key is out of budget",
	"Error: billing hard limit has been reached",
	"subscription_sharing_usage_limit_exceeded",
];

// Pi does not retry this one either, but a per-minute quota is a rate limit, not
// exhaustion, so it must not change routing.
const PI_NON_RETRYABLE_RATE_LIMIT = "Quota exceeded for metric requests per minute";

test("isQuotaExhaustion accepts explicit credit and quota exhaustion", () => {
	for (const message of [
		...PI_LIMIT_MESSAGES,
		'402: {"error":{"message":"Payment Required"}}',
		'429: {"error":{"type":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}',
		"Your credit balance is too low to access the API",
		"You have hit your usage limit. Upgrade your plan.",
		"Quota exceeded for this project",
		"usage_limit_exceeded",
		"The account is out of credits",
		"insufficient credits",
		"Error: billing hard limit has been reached",
		'{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"You exceeded your current quota"}}',
	]) assert.equal(isQuotaExhaustion(message), true, message);
});

test("isQuotaExhaustion rejects rate limits, concurrency caps and unrelated failures", () => {
	for (const message of [
		'429: {"message":"qwen3.6 concurrency limit: max 5 simultaneous requests.","type":"rate_limit_error"}',
		"429 Too Many Requests",
		"Rate limit reached for requests, please retry in 20s",
		"overloaded_error: Overloaded",
		PI_NON_RETRYABLE_RATE_LIMIT,
		'429: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
		"429 RESOURCE_EXHAUSTED",
		"WebSocket error: connection reset",
		"500 internal server error",
		"context length exceeded",
		"",
		undefined,
		null,
		42,
	]) assert.equal(isQuotaExhaustion(message), false, String(message));
});

test("the classifier agrees with Pi's retry policy at the boundary", () => {
	const failed = (errorMessage: string) => ({ role: "assistant", content: [], stopReason: "error", errorMessage }) as unknown as AssistantMessage;
	// Exhaustion Pi will not retry: falling back is the only way forward.
	for (const message of [...PI_LIMIT_MESSAGES, PI_NON_RETRYABLE_RATE_LIMIT]) assert.equal(isRetryableAssistantError(failed(message)), false, message);
	// Transient limits Pi retries itself: routing must stay on the role's model.
	for (const message of ['429: {"message":"qwen3.6 concurrency limit: max 5 simultaneous requests.","type":"rate_limit_error"}', "429 Too Many Requests", "Rate limit reached for requests, please retry in 20s", "overloaded_error: Overloaded"]) {
		assert.equal(isRetryableAssistantError(failed(message)), true, message);
		assert.equal(isQuotaExhaustion(message), false, message);
	}
});

test("isQuotaExhaustion only inspects a bounded prefix", () => {
	assert.equal(isQuotaExhaustion(`${"x".repeat(5_000)} insufficient_quota`), false);
});

test("an errored assistant message surfaces a quota flag without copying the provider text", () => {
	const quota = normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "insufficient_quota secret=never-copy" }] });
	assert.deepEqual(quota, [{ type: TASK_EVENT.AGENT_END, text: "", outcome: "error", diagnostic: "assistant reported an error: provider quota exhausted", quotaExhausted: true }]);
	assert.doesNotMatch(JSON.stringify(quota), /never-copy/);
	const rate = normalizeRpcEvent({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 concurrency limit" }] });
	assert.deepEqual(rate, [{ type: TASK_EVENT.AGENT_END, text: "", outcome: "error", diagnostic: "assistant reported an error" }]);
});
