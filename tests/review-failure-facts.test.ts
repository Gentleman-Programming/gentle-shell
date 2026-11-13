import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { asNativeReviewCliError, readReviewFailureFacts } from "../lib/review-failure-facts.ts";
import { NativeReviewCliError, NativeReviewConsentBindingError, NativeReviewIntegrationError, NATIVE_REVIEW_ERROR_CODE, NATIVE_REQUEST_CONTEXT_UNSUPPORTED_MESSAGE } from "../lib/native-review-cli.ts";
import { decodeReviewFailureV2 } from "../lib/review-integration-v2.ts";

function failure(mutationOutcome: "not_started" | "unknown" | "committed" = "not_started") {
	return decodeReviewFailureV2({
		schema: "gentle-ai.review-integration.failure/v2", contract: "gentle-ai.review-integration/v2",
		operation: "review.status", phase: "preflight", code: "invalid_request", message: "The negotiated review request is invalid.",
		mutation_outcome: mutationOutcome, authority_applicability: "not_evaluated", retry_safe: false,
		replayability: "not_replayable", required_inputs: [], next_action: "stop", cause: "exact provider cause",
	});
}

test("unknown mutation never becomes no mutation in operation or status projection", () => {
	const error = new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.TIMEOUT, "review/status", true, true, "timeout");
	for (const result of [__testing.nativeOperationFailure("start", error), __testing.nativeStatusFailed("inspect", error)]) {
		assert.equal(result.mutation_outcome, "unknown");
		assert.equal("mutation_performed" in result, false);
		assert.equal(result.replayability, "status_required");
		assert.deepEqual(result.diagnostics, error.diagnostics);
	}
	assert.equal(__testing.nativeStatusFailed("inspect", error).inventory_complete, false);
});

for (const mutation of ["not_started", "unknown", "committed"] as const) test(`decoded ${mutation} envelope retains native stop and original evidence`, () => {
	const decoded = failure(mutation), error = new NativeReviewIntegrationError(decoded);
	for (const result of [__testing.nativeOperationFailure("start", error), __testing.nativeStatusFailed("inspect", error), __testing.captureGroupStatusFailure(error)]) {
		assert.equal(result.native_failure, decoded.raw);
		assert.equal(result.next_action, "stop");
		assert.equal(result.replayability, "not_replayable");
	}
	const operation = __testing.nativeOperationFailure("start", error);
	assert.equal(operation.mutation_outcome, mutation === "not_started" ? "none" : mutation);
	assert.equal(operation.mutation_performed, mutation === "unknown" ? undefined : mutation === "committed");
});

test("group STATUS does not promote a lookalike envelope to decoded provider evidence", () => {
	const error = Object.assign(new Error("untrusted"), { failureEnvelope: failure() });
	assert.notEqual(readReviewFailureFacts(error).envelope, undefined);
	assert.equal(readReviewFailureFacts(error).integration, undefined);
	const group = __testing.captureGroupStatusFailure(error);
	assert.equal("native_failure" in group, false);
	assert.equal("next_action" in group, false);
});

test("foreign CLI errors require matching sanitized diagnostics and never carry arbitrary fields", () => {
	const actual = new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, "review/status", false, false, "failed");
	const foreign = { name: "NativeReviewCliError", code: actual.code, diagnostics: actual.diagnostics };
	const facts = asNativeReviewCliError(foreign);
	assert.deepEqual(facts, { code: actual.code, diagnostics: actual.diagnostics });
	assert.equal(asNativeReviewCliError({ ...foreign, diagnostics: { ...actual.diagnostics, private_prompt: "do not expose" } }), undefined);
	assert.equal(asNativeReviewCliError({ ...foreign, code: "forged" }), undefined);
	assert.equal(asNativeReviewCliError({ ...foreign, diagnostics: {} }), undefined);
});

test("managed-asset continuation and audit evidence retain their existing operation projection", () => {
	const raw = { code: "managed_assets_outdated", opaque: "provider evidence" };
	const error = { failureEnvelope: { raw, code: "managed_assets_outdated", mutationOutcome: "not_started", replayability: "not_replayable", nextAction: "stop", continuation: { command: "gentle-ai sync" } } };
	assert.deepEqual(__testing.nativeOperationFailure("start", error), {
		operation: "start", status: "blocked", native_failure: raw, mutation_performed: false, mutation_outcome: "none",
		replayability: "not_replayable", next_action: "stop", hint: "run gentle-ai sync",
	});
	const auditRecord = { operation: "review.repair", outcome: "unknown" };
	const unknown = new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, "review/repair", true, true, "unknown", undefined, auditRecord);
	assert.equal(__testing.nativeOperationFailure("repair", unknown).native_audit_record, auditRecord);
});

test("consent binding remains a pre-launch local refusal rather than a provider outage", () => {
	const error = new NativeReviewConsentBindingError("consent-invocation-cwd-changed", "repository changed");
	assert.deepEqual(__testing.nativeOperationFailure("answer-consent", error), {
		operation: "answer-consent", status: "blocked", outcome: "consent-binding-invalid", native_invocation_attempted: false,
		lineage_created: false, mutation_performed: false, mutation_outcome: "none",
		diagnostics: { code: error.reason, message: error.message }, next_action: "resolve-consent-binding",
	});
});

test("request capability refusal precedes generic incompatible-version remediation", () => {
	const error = new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.VERSION_INCOMPATIBLE, "review/start", false, false, NATIVE_REQUEST_CONTEXT_UNSUPPORTED_MESSAGE);
	for (const result of [__testing.nativeOperationFailure("start", error), __testing.nativeStatusFailed("inspect", error)]) {
		assert.equal(result.outcome, "request-context-unsupported");
		assert.equal(result.next_action, "use-provider-with-request-context-capabilities");
		assert.equal(result.mutation_outcome, "none");
	}
});
