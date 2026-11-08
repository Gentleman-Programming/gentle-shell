import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewCoordinatorInput, runReviewCoordinator, type ReviewCoordinatorTool } from "../lib/review-coordinator.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

type Body = Record<string, any>;
const target = "sha256:" + "a".repeat(64);
const lineage = "review-fixture";
const scoped = { workspaceRoot: process.cwd(), baseRef: "b".repeat(40), committedOnly: true as const };
const ready = { result: { target_identity: target, next_transition: { kind: "execute", execute: { operation: "review.start" } } } };
const collect = { result: { target_identity: target, authority: { lineage_id: lineage }, next_transition: { kind: "collect" } }, collectBindings: [{ collectBinding: "opaque-not-json" }] };
const approved = { result: { target_identity: target, authority: { lineage_id: lineage }, next_transition: { kind: "execute", execute: { operation: "review.acknowledge-approved" } } } };
const closed = { outcome: "native-approved-acknowledgement-completed", status: "closed", authority: "burned", target_identity: target, lineage_id: lineage };
const captured = { outcome: "native-last-event-closure" };
const stopped = { result: { ...collect.result, next_transition: { kind: "stop", reason_code: "corrected_candidate_unavailable" } } };

test("coordinator snapshots single/group reviewer runs through terminal ACK without double-counting legacy diagnostics", async () => {
	const first = { reviewer: { reviewerModel: "fixture/first", usage: { input: 4 }, cost: { total: 0.1 } }, lens: "review-risk" };
	const second = { reviewer: { reviewerModel: "fixture/second", phase: "completion" }, lens: "review-reliability" };
	const group = { ...captured, host_relay: { transport: "pi_host_relay", reviewer_runs: [first, second], reviewers: [first] } };
	const single = { ...captured, host_relay: { transport: "pi_host_relay", reviewer: { reviewerModel: "fixture/third", usage: { input: 2 } }, role: "provider_refuter", submission: "opaque native response, not reviewer facts" } };
	const next = { ...collect, collectBindings: [{ collectBinding: "next-opaque" }] };
	const host = backend([collect, group, next, single, approved, closed]);
	const expected = structuredClone([first, second, { role: "provider_refuter", reviewer: single.host_relay.reviewer }]);
	const result = await runReviewCoordinator({ lineageId: lineage }, { invoke: async (tool, parameters) => {
		if (host.calls.length === 2) first.reviewer.usage.input = 999;
		return await host.invoke(tool, parameters);
	} });
	assert.equal(result.outcome, "closed"); assert.deepEqual(result.reviewer_runs, expected);
	assert.equal((result.metrics as Body).reviewer_cost, undefined, "host evidence is not a second SDK accounting total");
	assert.doesNotMatch(JSON.stringify(result.reviewer_runs), /opaque native response/);
});

test("coordinator retains earlier runs and a failed reviewer attempt without duplicating grouped failure evidence", async () => {
	const first = { reviewer: { reviewerModel: "fixture/first", usage: { output: 3 } } };
	const next = { ...collect, collectBindings: [{ collectBinding: "next-opaque" }] };
	const failure = { outcome: "pi-host-relay-transport-failure", failure: { reviewer: { reviewerModel: "fixture/failed", phase: "auth" } } };
	const result = await runReviewCoordinator({ lineageId: lineage }, backend([collect, { ...captured, host_relay: { reviewer_runs: [first], reviewers: [first] } }, next, failure]));
	assert.equal(result.outcome, "blocked");
	assert.deepEqual(result.reviewer_runs, [first, { reviewer: failure.failure.reviewer }]);
	const groupedFailure = { ...failure, host_relay: { reviewer_runs: [first, { reviewer: failure.failure.reviewer }], reviewers: [first] } };
	const grouped = await runReviewCoordinator({ lineageId: lineage }, backend([collect, groupedFailure]));
	assert.deepEqual(grouped.reviewer_runs, [first, { reviewer: failure.failure.reviewer }], "group evidence supersedes the same reviewer repeated in failure diagnostics");
});

test("reviewer evidence snapshots stay within the existing transition limit and do not persist across invocations", async () => {
	let captures = 0;
	const result = await runReviewCoordinator({ lineageId: lineage }, { invoke: async tool => {
		if (tool === "gentle_review") return { ...collect, collectBindings: Array.from({ length: 4 }, (_, i) => ({ collectBinding: `opaque-${captures}-${i}` })) };
		captures++;
		return { ...captured, host_relay: { reviewer_runs: Array.from({ length: 4 }, () => ({ reviewer: { reviewerModel: "fixture/model", phase: "completion" } })) } };
	} });
	assert.equal(result.outcome, "transition-limit"); assert.equal(captures, 24);
	assert.equal((result.reviewer_runs as Body[]).length, 96);
	const next = await runReviewCoordinator({ lineageId: lineage }, backend([stopped]));
	assert.deepEqual(next.reviewer_runs, []);
});
function backend(responses: Body[]) {
 const calls: { tool: ReviewCoordinatorTool; parameters: Body }[] = [];
 return { calls, async invoke(tool: ReviewCoordinatorTool, parameters: Body) {
  calls.push({ tool, parameters });
  assert.ok(responses.length, "no unexpected follow-up or retry");
  return responses.shift()!;
 } };
}

test("fresh ordinary review retains selectors, displays forecasts and ends at native ACK", async () => {
 const forecast = { outcome: "reviewer-model-run-forecast" };
 const host = backend([{ reviewDue: true }, ready, { result: { lineage_id: lineage } }, collect, forecast, captured, approved, closed]);
 const shown: Body[] = [];
 const result = await runReviewCoordinator({ ...scoped, lenses: ["risk"], lensesReason: "permission check", requestContextPath: "spec.md" }, { ...host, presentForecast: async value => { shown.push(value); return true; } });
 assert.equal(result.outcome, "closed"); assert.deepEqual(result.result, closed); assert.deepEqual(shown, [forecast]);
 assert.deepEqual(result.forecasts, [forecast], "the primary model must receive the complete forecast for lossless relay");
 assert.equal(result.current_candidate, undefined, "ACK describes only its frozen target");
 assert.equal(host.calls.at(-1)!.parameters.operation, "acknowledge-approved");
 assert.equal(JSON.parse(String(host.calls[2].parameters.input)).requestContextPath, "spec.md");
 for (const call of host.calls) {
  assert.equal(call.parameters.workspaceRoot, scoped.workspaceRoot);
  if (["assess", "inspect", "status"].includes(String(call.parameters.operation))) assert.deepEqual(JSON.parse(String(call.parameters.input)), { baseRef: scoped.baseRef, committedOnly: true });
 }
});

test("routing ignores every native state, reason code and capture closure shape", async () => {
 for (const state of ["correction_required", "validating", "declined", "future-state"]) {
  const response: Body = structuredClone(collect);
  response.result.authority.state = state; response.result.next_transition.reason_code = "future-reason";
  const capture = { outcome: "native-last-event-closure" };
  Object.defineProperty(capture, "closure", { get() { throw new Error("must not inspect closure shape"); } });
  for (const object of [response.result, response.result.authority]) Object.defineProperty(object, "state", { get() { throw new Error("must not read state"); }, configurable: true });
  Object.defineProperty(response.result.next_transition, "reason_code", { get() { throw new Error("must not read reason_code"); } });
  // Serialization is transport instrumentation, so poison only property reads.
  Object.defineProperty(response, "toJSON", { value: () => ({ fixture: true }) });
  Object.defineProperty(capture, "toJSON", { value: () => ({ fixture: true }) });
  const host = backend([response, capture, approved, closed]);
  assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "closed");
  assert.equal(host.calls[1].parameters.collectBinding, "opaque-not-json");
 }
});

test("stop is surfaced unchanged before edit; authored collect returns to the model", async () => {
 for (const response of [stopped, { ...collect, result: { ...collect.result, next_transition: { kind: "collect", correction_request: { schema: "gentle-ai.review-correction-plan-request/v1", request_hash: "opaque-request" } } }, collectBindings: [{ collectBinding: "plan" }] }, { ...collect, collectBindings: [] }]) {
  const host = backend([response]); const result = await runReviewCoordinator({ lineageId: lineage }, host);
  assert.equal(result.outcome, response === stopped ? "stopped" : "input-required");
  assert.equal(result.result, response); assert.equal(host.calls.length, 1);
 }
});

test("post-edit opaque captures need no targeted-validator reason or operation", async () => {
 const host = backend([collect, captured, approved, closed]);
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "closed");
 assert.equal(host.calls.filter(call => call.tool === "gentle_review_capture").length, 1);
});

test("opaque captures need no Pi metadata and groups retain provider order", async () => {
 const host = backend([{ ...collect, collectBindings: [{ collectBinding: "second" }, { collectBinding: "first" }] }, captured, stopped]);
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "stopped");
 assert.equal(host.calls[1].tool, "gentle_review_capture_group"); assert.deepEqual(host.calls[1].parameters.collectBindings, ["second", "first"]);
});

test("capture failures and missing forecast display never run or acknowledge further", async () => {
 for (const capture of [{ outcome: "capture-binding-rejected" }, { outcome: "native-reviewer-result-failed", reconciliation: approved }, { outcome: "reviewer-model-run-forecast" }]) {
  const host = backend([collect, capture]);
  assert.ok(["blocked", "forecast"].includes(String((await runReviewCoordinator({ lineageId: lineage }, host)).outcome)));
  assert.equal(host.calls.length, 2);
 }
});

test("reoffered and duplicate opaque bindings cannot execute twice", async () => {
 const host = backend([collect, captured, collect]);
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "repeated-capture");
 assert.equal(host.calls.length, 3);
 const duplicate = backend([{ ...collect, collectBindings: [...collect.collectBindings, ...collect.collectBindings] }]);
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, duplicate)).outcome, "repeated-capture");
 assert.equal(duplicate.calls.length, 1);
});

test("lineage and target drift block before ACK, including a mismatched ACK envelope", async () => {
 for (const change of [{ target_identity: "other" }, { authority: { lineage_id: "other" } }]) {
  const host = backend([collect, captured, { result: { ...approved.result, ...change } }]);
  assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "binding-drift");
  assert.equal(host.calls.length, 3);
 }
 const host = backend([approved, { ...closed, target_identity: "other" }]);
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "blocked");
 assert.equal(host.calls.length, 2);
});

test("cancellation stops dispatch but a racing verified burn remains terminal", async () => {
 const host = backend([]);
 await assert.rejects(runReviewCoordinator({}, { ...host, signal: AbortSignal.abort() }), { name: "AbortError" });
 assert.equal(host.calls.length, 0);
 const controller = new AbortController(); let calls = 0;
 const result = await runReviewCoordinator({ lineageId: lineage }, { signal: controller.signal, async invoke() { if (++calls === 1) return approved; controller.abort(); return closed; } });
 assert.equal(result.outcome, "closed"); assert.equal(calls, 2); assert.equal(result.result, closed);
});

test("no retries after missing or unsuccessful ACK", async () => {
 for (const ack of [{}, { ...closed, authority: "active" }]) {
  const host = backend([approved, ack]); assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "blocked"); assert.equal(host.calls.length, 2);
 }
});

test("assessment, consent and existing frozen intent retain their explicit boundaries", async () => {
 for (const [assessment, outcome] of [[{ reviewDue: false }, "not-due"], [{}, "assessment-unavailable"]] as const) {
  const host = backend([assessment]); assert.equal((await runReviewCoordinator({}, host)).outcome, outcome); assert.equal(host.calls.length, 1);
 }
 const old = backend([{ reviewDue: true }, collect]);
 assert.equal((await runReviewCoordinator({ requestContextPath: "new.md" }, old)).outcome, "request-context-requires-fresh-review");
 const consent = { outcome: "native-review-consent-required" };
 const host = backend([{ reviewDue: true }, ready, consent]); assert.equal((await runReviewCoordinator({}, host)).result, consent); assert.equal(host.calls.length, 3);
 assert.throws(() => parseReviewCoordinatorInput({ lineageId: lineage, requestContextPath: "new.md" }), /immutable/);
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

test("forecasts remain lossless in final results even if capture later refuses", async () => {
 const first = { outcome: "reviewer-model-run-forecast", cost_forecast: { model_runs: 2, roles: ["review-risk", "review-refuter"] }, message: "Relay all forecast fields" };
 const second = { outcome: "reviewer-model-run-forecast", cost_forecast: { model_runs: 1, roles: ["review-validator"] } };
 const next = { ...collect, collectBindings: [{ collectBinding: "another-opaque" }] };
 const host = backend([collect, first, captured, next, second, { outcome: "capture-binding-rejected" }]);
 const expected = structuredClone([first, second]);
 const result = await runReviewCoordinator({ lineageId: lineage }, { ...host, presentForecast: async forecast => { forecast.message = "UI rendering must not alter the model relay"; return true; } });
 assert.equal(result.outcome, "blocked"); assert.deepEqual(result.forecasts, expected);
});
