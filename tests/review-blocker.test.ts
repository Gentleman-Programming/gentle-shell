import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { NativeReviewCliError, NativeReviewIntegrationError, NATIVE_REVIEW_ERROR_CODE, type NativeReviewCli } from "../lib/native-review-cli.ts";
import { decodeReviewFailureV2 } from "../lib/review-integration-v2.ts";
import { withReviewBlocker } from "../lib/review-blocker.ts";

test("empty workspace requests the intended range without diagnosing a failed earlier review", () => {
	const before = { operation: "status", status: "blocked", result: {
		applicability: "unrelated", projection: { kind: "current-changes", paths: [] },
		next_transition: { kind: "collect", reason_code: "empty_candidate_base_ref_required" },
	}, collectBindings: [] };
	const after = withReviewBlocker(before);
	const { blocker, ...preserved } = after;
	assert.deepEqual(preserved, before);
	const diagnosis = blocker as Record<string, unknown>;
	assert.equal(diagnosis.category, "input");
	assert.equal(diagnosis.actor, "caller");
	assert.equal(diagnosis.automatic_retry, false);
	assert.match(String(diagnosis.next_step), /baseRef.*committedOnly/);
	assert.match(String(diagnosis.next_step), /ASSESS.*original committed range/);
	assert.match(String(diagnosis.next_step), /does not establish.*failed/);
	assert.equal("nativeReviewOutcome" in after, false);
	assert.equal("next_action" in after, false);
});

test("empty-candidate guidance preserves unknown mutations and explicit provider stops", () => {
	const transition = { kind: "collect", reason_code: "empty_candidate_base_ref_required" };
	for (const mutation_outcome of ["unknown", "partial_unknown"]) {
		const result = withReviewBlocker({ status: "blocked", mutation_outcome, result: { next_transition: transition } });
		assert.equal((result.blocker as Record<string, unknown>).category, "authority-unavailable");
	}
	const stopped = withReviewBlocker({ status: "blocked", result: { next_transition: { ...transition, kind: "stop" } } });
	assert.equal((stopped.blocker as Record<string, unknown>).category, "provider-stop");
	const failed = withReviewBlocker({ status: "blocked", outcome: "native-status-failed", result: { next_transition: transition } });
	assert.equal((failed.blocker as Record<string, unknown>).category, "provider-unavailable");
});

test("native stops outrank capability remediation without changing provider evidence", () => {
	for (const blocked of [{ outcome: "request-context-unsupported" }, { failure: { kind: "handshake-refused" } }]) {
		for (const stop of [{ native_failure: { next_action: "stop" } }, { result: { next_transition: { kind: "stop" } } }]) {
			const before = { status: "blocked", ...blocked, ...stop };
			const { blocker, ...preserved } = withReviewBlocker(before);
			assert.deepEqual(preserved, before);
			assert.equal((blocker as Record<string, unknown>).category, "provider-stop");
			assert.equal((blocker as Record<string, unknown>).automatic_retry, false);
			assert.doesNotMatch(String((blocker as Record<string, unknown>).next_step), /reload/);
		}
	}
});

test("timed_out diagnostics use timeout guidance without granting a retry", () => {
	const before = { status: "blocked", diagnostics: { timed_out: true } };
	const { blocker, ...preserved } = withReviewBlocker(before);
	assert.deepEqual(preserved, before);
	assert.equal((blocker as Record<string, unknown>).category, "provider-unavailable");
	assert.equal((blocker as Record<string, unknown>).automatic_retry, false);
	assert.match(String((blocker as Record<string, unknown>).next_step), /timed out/);
});

test("a read-only inventory timeout says the read can be rerun without granting an automatic retry", () => {
	const before = { status: "blocked", outcome: "native-status-timed-out", inventory_complete: false, diagnostics: { timed_out: true }, next_action: "rerun-native-status", remediation_command: "gentle-ai review status --cwd <repo> --contract gentle-ai.review-integration/v2 --agent pi --next-transition" };
	const { blocker, ...preserved } = withReviewBlocker(before);
	assert.deepEqual(preserved, before);
	assert.deepEqual(blocker, {
		category: "provider-unavailable", scope: "review-step", actor: "user", automatic_retry: false,
		next_step: "The read-only review inventory read timed out before it completed. Nothing was mutated; rerun the returned remediation_command when ready. Pi does not retry automatically.",
	});
	const stopped = withReviewBlocker({ ...before, native_failure: { next_action: "stop" } });
	assert.equal((stopped.blocker as Record<string, unknown>).category, "provider-stop");
});

test("unsupported STATUS suggests local capability diagnosis before upstream escalation", async () => {
	const result = await __testing.executeReviewControllerOperation({ operation: "status" }, process.cwd(), {} as NativeReviewCli);
	assert.equal(result.status, "blocked");
	assert.equal(result.next_action, "check-native-provider-capabilities");
	assert.equal((result.blocker as Record<string, unknown>)?.category, "provider-capability");
	assert.equal((result.blocker as Record<string, unknown>)?.actor, "user");
	assert.equal((result.blocker as Record<string, unknown>)?.automatic_retry, false);
});

for (const [kind, category, actor] of [
	["reviewer-config-invalid", "configuration", "user"],
	["reviewer-model-not-found", "configuration", "user"],
	["reviewer-thinking-invalid", "configuration", "user"],
	["reviewer-auth-unavailable", "configuration", "user"],
	["submission-refused", "admission-refused", "caller"],
	["reviewer-tool-call-attempted", "generation-invalid", "caller"],
] as const) test(`${kind} has an actionable diagnosis without changing native or transport evidence`, () => {
	const failure = { kind, stage: "pi", stderr: "opaque provider diagnostic" };
	const before = { status: "blocked", outcome: "pi-host-relay-transport-failure", mutation_outcome: "none", mutation_performed: false, next_action: "original exact continuation", failure };
	const after = withReviewBlocker(before), { blocker, ...preserved } = after;
	assert.deepEqual(preserved, before);
	assert.equal(after.failure, failure);
	assert.deepEqual([ (blocker as Record<string, unknown>).category, (blocker as Record<string, unknown>).actor ], [category, actor]);
	assert.equal((blocker as Record<string, unknown>).automatic_retry, false);
	assert.equal("blocker" in before, false);
});

test("unknown submission and partial unknown group progress outrank configuration or admission advice", () => {
	for (const mutation of ["unknown", "partial_unknown"]) {
		const result = withReviewBlocker({ status: "blocked", mutation_outcome: mutation, failure: { kind: "submission-refused" } });
		assert.equal(result.mutation_outcome, mutation);
		assert.equal("mutation_performed" in result, false);
		assert.equal((result.blocker as Record<string, unknown>).category, "authority-unavailable");
	}
});

test("a native maintenance action names an authorized operator without assuming a remote maintainer", () => {
	const native_failure = { next_action: "explicit-maintainer-action", code: "invalid_request" };
	const result = withReviewBlocker({ status: "blocked", native_failure, next_action: "explicit-maintainer-action", mutation_outcome: "none" });
	assert.equal(result.native_failure, native_failure);
	assert.equal((result.blocker as Record<string, unknown>).actor, "authorized-operator");
	assert.equal(result.next_action, "explicit-maintainer-action");
});

test("successful envelopes are returned unchanged and unknown prose is never treated as authority", () => {
	const success = { status: "captured", result: "opaque" };
	assert.equal(withReviewBlocker(success), success);
	const result = withReviewBlocker({ status: "blocked", reason: "submission-refused reset locks retry now" });
	assert.equal((result.blocker as Record<string, unknown>).category, "diagnosis-required");
	assert.equal("next_action" in result, false);
});

test("stale consent remains scoped to the review step rather than delivery policy", () => {
	const result = withReviewBlocker({ status: "blocked", outcome: "consent-binding-stale", next_action: "restart-for-fresh-consent" });
	assert.equal((result.blocker as Record<string, unknown>).category, "stale-binding");
	assert.equal((result.blocker as Record<string, unknown>).scope, "review-step");
	assert.equal(result.next_action, "restart-for-fresh-consent");
});

test("negotiated transport refusal is a known capability problem rather than an unknown blocker", () => {
	const relay_transport = { supported: false, code: "unsupported_transport", message: "opaque diagnostic" };
	const result = withReviewBlocker({ status: "blocked", outcome: "pi-host-relay-transport-unavailable", relay_transport, next_action: "exact host continuation" });
	assert.equal((result.blocker as Record<string, unknown>).category, "provider-capability");
	assert.equal((result.blocker as Record<string, unknown>).actor, "user");
	assert.equal(result.relay_transport, relay_transport);
	assert.equal(result.next_action, "exact host continuation");
});

test("an offered acknowledgement is a normal continuation with no diagnostic investigation required", () => {
	const raw = { next_transition: { kind: "execute", execute: { operation: "review.acknowledge-approved" } } };
	const result = withReviewBlocker({ status: "blocked", result: raw, next_action: "exact host acknowledgement" });
	assert.equal((result.blocker as Record<string, unknown>).category, "continuation");
	assert.equal((result.blocker as Record<string, unknown>).actor, "caller");
	assert.equal(result.result, raw);
	assert.equal(result.next_action, "exact host acknowledgement");
});

test("normal collect offers remain continuations while contradictory failure evidence never becomes permission", () => {
	const offer = { status: "blocked", collectBindings: [{ collectBinding: "opaque" }] };
	assert.equal((withReviewBlocker(offer).blocker as Record<string, unknown>).category, "continuation");
	const native_failure = { next_action: "stop" };
	const failed = withReviewBlocker({ ...offer, native_failure });
	assert.notEqual((failed.blocker as Record<string, unknown>).category, "continuation");
	assert.equal((failed.blocker as Record<string, unknown>).native_next_action, "stop");
	assert.equal((failed.blocker as Record<string, unknown>).automatic_retry, false);
});

test("unsupported execute operations are never labelled as supported continuations", () => {
	const result = withReviewBlocker({ status: "blocked", result: { next_transition: { kind: "execute", execute: { operation: "arbitrary.command" } } } });
	assert.equal((result.blocker as Record<string, unknown>).category, "diagnosis-required");
});

test("native stop remains authoritative even when an invalid request has a diagnostic category", async () => {
	const failure = decodeReviewFailureV2({
		schema: "gentle-ai.review-integration.failure/v2", contract: "gentle-ai.review-integration/v2",
		operation: "review.status", phase: "preflight", code: "invalid_request", message: "Invalid request",
		mutation_outcome: "not_started", authority_applicability: "not_evaluated", retry_safe: false,
		replayability: "not_replayable", required_inputs: [], next_action: "stop",
	});
	const native = { targetStatus: async () => { throw new NativeReviewIntegrationError(failure); } } as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "status" }, process.cwd(), native);
	assert.equal(result.native_failure, failure.raw);
	assert.equal(result.next_action, "stop");
	assert.equal(result.replayability, "not_replayable");
	assert.equal((result.blocker as Record<string, unknown>)?.automatic_retry, false);
	assert.equal((result.blocker as Record<string, unknown>)?.native_next_action, "stop");
});

test("STATUS timeout is diagnosed without inventing lock contention or retry permission", async () => {
	const diagnostics = { operation: "review/status" as const, error_code: NATIVE_REVIEW_ERROR_CODE.TIMEOUT, timed_out: true, output_limit_exceeded: false };
	const native = { targetStatus: async () => { throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.TIMEOUT, "review/status", true, false, "timed out", diagnostics); } } as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "status" }, process.cwd(), native);
	assert.equal((result.blocker as Record<string, unknown>)?.category, "provider-unavailable");
	assert.equal((result.blocker as Record<string, unknown>)?.automatic_retry, false);
	assert.equal(result.mutation_outcome, "none");
	assert.deepEqual(result.diagnostics, diagnostics);
	assert.equal(result.outcome, "native-status-timed-out");
	assert.equal((result.blocker as Record<string, unknown>)?.actor, "user");
	assert.doesNotMatch(String((result.blocker as Record<string, unknown>)?.next_step), /lock/);
	assert.equal((result.blocker as Record<string, unknown>)?.scope, "review-step");
});
