import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewCoordinatorInput, runReviewCoordinator, type ReviewCoordinatorTool } from "../lib/review-coordinator.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

type Body = Record<string, unknown>;
const target = "sha256:" + "a".repeat(64);
const lineage = "review-fixture";
const scoped = { workspaceRoot: process.cwd(), baseRef: "b".repeat(40), committedOnly: true as const };
const ready = { status: "ready", result: { target_identity: target, next_transition: { kind: "execute", execute: { operation: "review.start" } } } };
const collect = { result: { target_identity: target, authority: { lineage_id: lineage, state: "reviewing" }, next_transition: { kind: "collect" } }, collectBindings: [{ collectBinding: '{"opaque":"binding"}' }] };
const approved = { result: { target_identity: target, authority: { lineage_id: lineage, state: "approved" }, next_transition: { kind: "execute", execute: { operation: "review.acknowledge-approved" } } } };
const closed = { outcome: "native-approved-acknowledgement-completed", status: "closed", authority: "burned", target_identity: target, lineage_id: lineage };

function backend(responses: Body[]) {
	const calls: { tool: ReviewCoordinatorTool; parameters: Body }[] = [];
	return { calls, confirmCurrentCandidate: async () => ({ consumed: true }), async invoke(tool: ReviewCoordinatorTool, parameters: Body) {
		calls.push({ tool, parameters });
		assert.ok(responses.length, "no unexpected follow-up or retry");
		return structuredClone(responses.shift()!);
	} };
}

test("ordinary coordinator retains selectors, displays forecast and closes only through facade acknowledgement", async () => {
	const forecast = { outcome: "reviewer-model-run-forecast", cost_forecast: { model_runs: 1 } };
	const capture = { outcome: "native-last-event-closure", closure: { state: "approved", lineage_id: lineage, target_identity: target } };
	const host = backend([{ reviewDue: true }, ready, { operation: "start", result: { lineage_id: lineage } }, collect, forecast, capture, approved, closed]);
	const forecasts: Body[] = [];
	const result = await runReviewCoordinator({ ...scoped, lenses: ["risk"], lensesReason: "Changes a permission check" }, {
		...host, presentForecast: async (value) => { forecasts.push(value); return true; },
	});
	assert.equal(result.outcome, "closed");
	assert.deepEqual((result.current_candidate as Body).status, "reviewed");
	assert.deepEqual(forecasts, [forecast]);
	assert.equal(host.calls.at(-1)?.parameters.operation, "acknowledge-approved");
	for (const call of host.calls) {
		assert.equal(call.parameters.workspaceRoot, scoped.workspaceRoot);
		if (["assess", "inspect", "status"].includes(String(call.parameters.operation))) assert.deepEqual(JSON.parse(String(call.parameters.input)), { baseRef: scoped.baseRef, committedOnly: true });
	}
	assert.equal(host.calls.filter((call) => call.parameters.reviewerRunAcknowledged === true).length, 1);
});

test("explicit intent is forwarded only to fresh START and cannot reinterpret consumed authority", async () => {
	const host = backend([{ reviewDue: true }, ready, { outcome: "native-review-consent-required" }]);
	await runReviewCoordinator({ requestContextPath: "spec.md" }, host);
	assert.equal(JSON.parse(String(host.calls[2].parameters.input)).requestContextPath, "spec.md");
	assert.throws(() => parseReviewCoordinatorInput({ lineageId: lineage, requestContextPath: "new.md" }), /immutable/);
	const consumed = backend([{ reviewDue: false }]);
	assert.equal((await runReviewCoordinator({ requestContextPath: "new.md" }, consumed)).outcome, "request-context-requires-fresh-review");
	assert.equal(consumed.calls.length, 1);
});

test("explicit new intent cannot resume an active lineage discovered by inspect", async () => {
	const host = backend([{ reviewDue: true }, collect]);
	const result = await runReviewCoordinator({ requestContextPath: "different-request.md" }, host);
	assert.equal(result.outcome, "request-context-requires-fresh-review");
	assert.equal(host.calls.length, 2, "no reviewer or acknowledgement on the old intent");
});

test("not-due assessment does not inspect or start", async () => {
	const host = backend([{ reviewDue: false }]);
	assert.equal((await runReviewCoordinator({}, host)).outcome, "not-due");
	assert.equal(host.calls.length, 1);
});

test("unknown assessment does not infer permission to review", async () => {
	const host = backend([{ nativeRisk: "unassessable" }]);
	assert.equal((await runReviewCoordinator({}, host)).outcome, "assessment-unavailable");
	assert.equal(host.calls.length, 1);
});

test("unresolved consent returns verbatim without supplying a grant", async () => {
	const consent = { outcome: "native-review-consent-required", consent_binding: "opaque", consent: { choices: ["granted", "declined"] } };
	const host = backend([{ reviewDue: true }, ready, consent]);
	const result = await runReviewCoordinator({}, host);
	assert.equal(result.outcome, "consent-required");
	assert.deepEqual(result.result, consent);
	assert.ok(!host.calls.some((call) => call.parameters.operation === "answer-consent"));
});

test("correction and maintenance routes hand back without executing them", async () => {
	for (const response of [
		{ result: { authority: { lineage_id: lineage, state: "correction_required" } } },
		{ result: { next_transition: { kind: "execute", execute: { operation: "review.recover" } } } },
	]) {
		const host = backend([response]);
		const result = await runReviewCoordinator({ lineageId: lineage }, host);
		assert.ok(["correction-required", "blocked"].includes(String(result.outcome)));
		assert.equal(host.calls.length, 1);
	}
});

function validationCollect(state = "correction_required"): Body {
	return { result: { target_identity: target, authority: { lineage_id: lineage, state },
		next_transition: { kind: "collect", reason_code: "targeted_validation_required" } },
		collectBindings: [{ captureOperation: "review.capture-validation", collectBinding: "opaque-native-validator" }] };
}

const statusForecast = { tool: "gentle_review_capture", status: "blocked", outcome: "reviewer-model-run-forecast",
	cost_forecast: { transport: "pi_host_relay", model_runs: 1, roles: ["review-validator"] }, mutation_performed: false, mutation_outcome: "none" };
function projectedValidation(): Body {
	const details = validationCollect();
	details.collectBindings = [{ captureOperation: "review.capture-validation", collectBinding: "opaque-native-validator", forecast: statusForecast }];
	return details;
}

test("projected validation forecast is displayed before one fresh acknowledged capture", async () => {
	const host = backend([projectedValidation(), { outcome: "native-last-event-closure", closure: { state: "approved", lineage_id: lineage } }, approved, closed]);
	let shown = 0;
	const result = await runReviewCoordinator({ lineageId: lineage }, { ...host, presentForecast: async forecast => {
		assert.deepEqual(forecast, statusForecast); assert.equal(host.calls.length, 1); shown++; return true;
	} });
	assert.equal(result.outcome, "closed");
	assert.equal(shown, 1);
	const captures = host.calls.filter(call => call.tool === "gentle_review_capture");
	assert.equal(captures.length, 1);
	assert.equal(captures[0].parameters.reviewerRunAcknowledged, true);
	assert.equal(captures[0].parameters.collectBinding, "opaque-native-validator");
	assert.equal(host.calls.length, 4);
});

test("projected forecast absence of display or cancellation prevents capture", async () => {
	for (const presentForecast of [undefined, async () => false]) {
		const host = backend([projectedValidation()]);
		assert.equal((await runReviewCoordinator({ lineageId: lineage }, { ...host, presentForecast })).outcome, "forecast");
		assert.equal(host.calls.length, 1);
	}
	const controller = new AbortController();
	const host = backend([projectedValidation()]);
	await assert.rejects(runReviewCoordinator({ lineageId: lineage }, { ...host, signal: controller.signal,
		presentForecast: async () => { controller.abort(); return true; } }), { name: "AbortError" });
	assert.equal(host.calls.length, 1);
});

test("projected forecast never bypasses current binding refusal or retries a new forecast", async () => {
	for (const response of [{ outcome: "capture-binding-rejected", status: "blocked" }, { outcome: "review-mode-disabled", status: "skipped" }, statusForecast]) {
		const host = backend([projectedValidation(), response]);
		const result = await runReviewCoordinator({ lineageId: lineage }, { ...host, presentForecast: async () => true });
		assert.ok(["blocked", "forecast"].includes(String(result.outcome)));
		assert.equal(host.calls.length, 2);
	}
});

test("incompatible projected forecast retains the legacy capture forecast route", async () => {
	const details = projectedValidation();
	details.collectBindings = [{ captureOperation: "review.capture-validation", collectBinding: "opaque-native-validator",
		forecast: { ...statusForecast, cost_forecast: { transport: "pi_host_relay", model_runs: 2, roles: ["review-validator"] } } }];
	const host = backend([details, statusForecast, { outcome: "native-last-event-closure", closure: { state: "approved" } }, approved, closed]);
	assert.equal((await runReviewCoordinator({ lineageId: lineage }, { ...host, presentForecast: async () => true })).outcome, "closed");
	assert.equal(host.calls[1].parameters.reviewerRunAcknowledged, undefined);
	assert.equal(host.calls[2].parameters.reviewerRunAcknowledged, true);
});

test("resuming a corrected candidate executes exactly the offered validator and closes through native acknowledgement", async () => {
	for (const state of ["correction_required", "validating"]) {
		const validation = validationCollect(state);
		const host = backend([validation, { outcome: "reviewer-model-run-forecast" },
			{ outcome: "native-last-event-closure", closure: { state: "approved", lineage_id: lineage } }, approved, closed]);
		const result = await runReviewCoordinator({ lineageId: lineage }, { ...host, presentForecast: async () => true });
		assert.equal(result.outcome, "closed");
		const captures = host.calls.filter(call => call.tool === "gentle_review_capture");
		assert.equal(captures.length, 2, "one forecast then one acknowledged execution");
		assert.equal(captures[1].parameters.collectBinding, "opaque-native-validator");
		assert.equal(captures[1].parameters.reviewerRunAcknowledged, true);
		assert.equal(host.calls.at(-1)?.parameters.operation, "acknowledge-approved");
	}
});

test("correction resume refuses other roles, ambiguous bindings and missing validation reason", async () => {
	for (const operation of [undefined, "review.capture-correction-plan", "review.capture-refuter", "review.capture-result"]) {
		const response = validationCollect();
		response.collectBindings = [{ captureOperation: operation, collectBinding: "opaque" }];
		const host = backend([response]);
		assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "correction-required");
		assert.equal(host.calls.length, 1);
	}
	for (const response of [
		{ ...validationCollect(), collectBindings: [] },
		{ ...validationCollect(), collectBindings: [{ captureOperation: "review.capture-validation", collectBinding: "a" }, { captureOperation: "review.capture-validation", collectBinding: "b" }] },
		{ ...validationCollect(), result: { target_identity: target, authority: { lineage_id: lineage, state: "correction_required" }, next_transition: { kind: "collect" } } },
	]) {
		const host = backend([response]);
		assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "correction-required");
		assert.equal(host.calls.length, 1);
	}
});

test("validator failure, cancellation, drift and escalation never retry or acknowledge", async () => {
	for (const response of [
		{ outcome: "native-reviewer-result-failed", reconciliation: approved },
		{ outcome: "capture-binding-rejected", status: "blocked" },
		{ outcome: "native-last-event-closure", closure: { state: "escalated", lineage_id: lineage } },
		{ outcome: "native-last-event-closure", closure: { state: "approved", lineage_id: "foreign-lineage" } },
	]) {
		const host = backend([validationCollect(), response]);
		const result = await runReviewCoordinator({ lineageId: lineage }, host);
		assert.ok(["blocked", "binding-drift"].includes(String(result.outcome)));
		assert.equal(host.calls.length, 2);
	}
	const controller = new AbortController();
	let calls = 0;
	await assert.rejects(runReviewCoordinator({ lineageId: lineage }, { signal: controller.signal, async invoke() {
		calls++; controller.abort(); return validationCollect();
	} }), { name: "AbortError" });
	assert.equal(calls, 1);
	const changed = { ...approved, result: { ...approved.result, target_identity: "changed-candidate" } };
	const host = backend([validationCollect(), { outcome: "native-last-event-closure", closure: { state: "approved" } }, changed]);
	assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "binding-drift");
	assert.equal(host.calls.length, 3);
});

test("validation forecast is mandatory and a reoffered validator never executes twice", async () => {
	const forecast = backend([validationCollect(), { outcome: "reviewer-model-run-forecast" }]);
	assert.equal((await runReviewCoordinator({ lineageId: lineage }, forecast)).outcome, "forecast");
	assert.equal(forecast.calls.length, 2);
	for (const binding of ["opaque-native-validator", "new-opaque-validator"]) {
		const again = validationCollect();
		again.collectBindings = [{ captureOperation: "review.capture-validation", collectBinding: binding }];
		const repeated = backend([validationCollect(), { outcome: "native-reviewer-result-captured" }, again]);
		assert.equal((await runReviewCoordinator({ lineageId: lineage }, repeated)).outcome, "repeated-capture");
		assert.equal(repeated.calls.length, 3);
	}
});

test("no forecast presentation means no model run", async () => {
	const host = backend([collect, { outcome: "reviewer-model-run-forecast" }]);
	assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "forecast");
	assert.equal(host.calls.length, 2);
});

test("capture errors never retry or acknowledge even when reconciliation offers approval", async () => {
	const failure = { outcome: "native-reviewer-result-failed", reconciliation: approved };
	const host = backend([collect, failure]);
	const result = await runReviewCoordinator({ lineageId: lineage }, host);
	assert.equal(result.outcome, "blocked");
	assert.deepEqual(result.result, failure);
	assert.equal(host.calls.length, 2);
});

test("target and lineage drift block before acknowledgement", async () => {
	for (const changed of [
		{ ...approved, result: { ...approved.result, target_identity: "other-target" } },
		{ ...approved, result: { ...approved.result, authority: { lineage_id: "other-lineage", state: "approved" } } },
	]) {
		const host = backend([collect, { outcome: "native-last-event-closure", closure: { state: "approved" } }, changed]);
		assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "binding-drift");
		assert.ok(!host.calls.some((call) => call.parameters.operation === "acknowledge-approved"));
	}
});

test("cancelled coordinator performs no calls", async () => {
	const host = backend([]);
	await assert.rejects(runReviewCoordinator({}, { ...host, signal: AbortSignal.abort() }), { name: "AbortError" });
	assert.equal(host.calls.length, 0);
});

test("a cancellation racing a confirmed burn does not hide acknowledgement evidence", async () => {
	const controller = new AbortController();
	let calls = 0;
	const result = await runReviewCoordinator({ lineageId: lineage }, {
		signal: controller.signal,
		async invoke() {
			calls++;
			if (calls === 1) return approved;
			controller.abort();
			return closed;
		},
	});
	assert.equal(result.outcome, "closed-scope-unconfirmed");
	assert.deepEqual(result.result, closed);
	assert.equal(calls, 2);
});

test("post-burn candidate drift preserves the burn but never reports current changes reviewed", async () => {
	const host = backend([approved, closed]);
	const result = await runReviewCoordinator({ lineageId: lineage }, { ...host, confirmCurrentCandidate: async () => ({ consumed: false }) });
	assert.equal(result.outcome, "candidate-changed-after-close");
	assert.deepEqual(result.result, closed);
	assert.equal((result.current_candidate as Body).status, "unreviewed");
	assert.deepEqual(host.calls.map((call) => call.parameters.operation), ["status", "acknowledge-approved"]);
});

test("failed or absent post-burn evidence does not hide closure or grant current-candidate approval", async () => {
	for (const confirmCurrentCandidate of [undefined, async () => ({}), async () => { throw new Error("assessment timeout"); }]) {
		const host = backend([approved, closed]);
		const result = await runReviewCoordinator({ lineageId: lineage }, { ...host, confirmCurrentCandidate });
		assert.equal(result.outcome, "closed-scope-unconfirmed");
		assert.deepEqual(result.result, closed);
		assert.equal(host.calls.length, 2, "no post-burn STATUS or replay");
	}
});

test("an accepted capture whose binding is reoffered cannot run twice", async () => {
	const host = backend([collect, { outcome: "native-reviewer-result-captured" }, collect]);
	assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "repeated-capture");
	assert.equal(host.calls.filter((call) => call.tool === "gentle_review_capture").length, 1);
});

test("group captures preserve the exact provider order", async () => {
	const bindings = [{ collectBinding: '{"opaque":"second"}' }, { collectBinding: '{"opaque":"first"}' }];
	const host = backend([{ ...collect, collectBindings: bindings }, { outcome: "native-last-event-closure", closure: { state: "correction_required" } }]);
	assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "correction-required");
	assert.equal(host.calls[1]!.tool, "gentle_review_capture_group");
	assert.deepEqual(host.calls[1]!.parameters.collectBindings, bindings.map((entry) => entry.collectBinding));
});

test("ambiguous selectors and consent arguments are rejected before dispatch", () => {
	for (const value of [{ baseRef: "main" }, { committedOnly: true }, { consent: "granted" }, { lenses: ["risk"] }, { intendedUntracked: [] }]) assert.throws(() => parseReviewCoordinatorInput(value));
});

test("coordinator is absent by default and in child sessions; enabled only by explicit environment flag", () => {
	for (const [env, expected] of [[{}, false], [{ GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR: "1" }, true], [{ GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR: "1", GENTLE_PI_AGENTS_CHILD: "1" }, false]] as const) {
		const tools = new Map();
		createGentleAiExtension({ nativeReviewCli: null, processEnv: env })({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool), registerCommand() {}, on() {} } as never);
		assert.equal(tools.has("gentle_review_run"), expected);
		for (const name of ["gentle_review", "gentle_review_capture", "gentle_review_capture_group"]) assert.ok(tools.has(name));
	}
});
