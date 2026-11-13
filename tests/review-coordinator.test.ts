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
  // Only closure.advisory_findings and advisory_finding_claims are read (relayed on approval); every other closure field stays unread.
  const closure = {};
  for (const key of ["schema", "operation", "lineage_id", "state", "store_revision", "action", "escalation", "status_continuation", "acknowledgement", "next_action"]) Object.defineProperty(closure, key, { get() { throw new Error("must not inspect closure shape"); } });
  const capture = { outcome: "native-last-event-closure", closure };
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

test("an intended-untracked selection returns selection-required; a correction request still returns input-required", async () => {
 const selecting = { operation: "inspect", status: "blocked", result: { next_transition: { kind: "collect" } }, selectionBinding: "opaque-selection", nextStep: "select-intended-untracked" };
 const correction = { ...collect, result: { ...collect.result, next_transition: { kind: "collect", correction_request: { request_hash: "opaque-request" } } }, collectBindings: [{ collectBinding: "plan" }] };
 for (const [response, expected] of [[selecting, "selection-required"], [correction, "input-required"], [{ ...correction, selectionBinding: "opaque-selection" }, "input-required"]] as const) {
  const host = backend([response]); const result = await runReviewCoordinator({ lineageId: lineage }, host);
  assert.equal(result.outcome, expected);
  // The selection drops only the facade's single-operation nextStep; resume_input names the way on.
  const { nextStep: _nextStep, ...relayed } = response as Body;
  assert.deepEqual(result.result, response === selecting ? relayed : response, "the facade envelope is relayed otherwise unchanged"); assert.equal(host.calls.length, 1);
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

test("a reconciled reviewer group continues only through bound STATUS; drift, uncertain or failed reconciliation stays blocked", async () => {
 const group = { ...collect, collectBindings: [{ collectBinding: "first" }, { collectBinding: "second" }] };
 const reconciled = { tool: "gentle_review_capture_group", status: "reconciled", outcome: "native-reviewer-group-status-reconciled", next_transition: { kind: "execute", execute: { operation: "review.acknowledge-approved" } } };
 const refuter = { ...collect, collectBindings: [{ collectBinding: "refuter" }] };
 const host = backend([group, reconciled, refuter, captured, approved, closed]);
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "closed");
 assert.deepEqual(host.calls.map(call => call.tool === "gentle_review" ? `status-or-ack:${call.parameters.operation}` : call.tool), ["status-or-ack:status", "gentle_review_capture_group", "status-or-ack:status", "gentle_review_capture", "status-or-ack:status", "status-or-ack:acknowledge-approved"], "the reconciled capture's own next_transition is never followed");
 for (const capture of [
  { ...reconciled, native_failure: { reason: "unknown" } },
  { ...reconciled, failure: { kind: "transport" } },
  { ...reconciled, reconciliation: {} },
  { ...reconciled, reconciliation_failure: {} },
  { ...reconciled, status: "blocked" },
  { tool: "gentle_review_capture_group", outcome: "native-reviewer-group-status-reconciliation-failed", reconciliation_failure: {} },
  { tool: "gentle_review_capture_group", status: "blocked", outcome: "capture-group-authority-drift", reconciliation: {} },
  { tool: "gentle_review_capture", status: "reconciled", outcome: "native-capture-outcome-unknown", native_failure: {} },
 ]) {
  const blocked = backend([group, capture]);
  const result = await runReviewCoordinator({ lineageId: lineage }, blocked);
  assert.equal(result.outcome, "blocked", JSON.stringify(capture)); assert.equal(result.result, capture); assert.equal(blocked.calls.length, 2);
 }
 // Fresh reconciled groups forever still end at the existing transition cap.
 let groups = 0;
 const capped = await runReviewCoordinator({ lineageId: lineage }, { invoke: async tool => {
  if (tool === "gentle_review") return { ...collect, collectBindings: [{ collectBinding: `a-${groups}` }, { collectBinding: `b-${groups}` }] };
  groups++; return reconciled;
 } });
 assert.equal(capped.outcome, "transition-limit"); assert.equal(groups, 24);
 // Only a group capture reports this outcome; from a single capture it is unknown.
 const single = backend([collect, reconciled]);
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, single)).outcome, "blocked"); assert.equal(single.calls.length, 2);
});

test("advisory_finding_claims is relayed only as a plain object of strings", async () => {
 const findings = { statement: "fixture", findings: [{ id: "F1" }] };
 const run = async (claims: unknown) => {
  const closure = { advisory_findings: findings, advisory_finding_claims: claims };
  return await runReviewCoordinator({ lineageId: lineage }, backend([collect, { ...captured, closure }, approved, closed]));
 };
 assert.deepEqual((await run({ F1: "reviewer text" })).advisory_finding_claims, { F1: "reviewer text" });
 for (const claims of [["reviewer text"], "reviewer text", { F1: 3 }, { F1: ["reviewer text"] }, null, 7, new Map([["F1", "x"]])]) {
  const result = await run(claims);
  assert.equal(result.outcome, "closed");
  assert.deepEqual(result.advisory_findings, findings);
  assert.equal(Object.hasOwn(result, "advisory_finding_claims"), false, JSON.stringify(claims));
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

test("coordinator is registered by default in a parent session; absent in child sessions and with the explicit opt-out", () => {
	for (const [env, expected] of [[{}, true], [{ GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR: "1" }, true], [{ GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR: "0" }, false], [{ GENTLE_PI_AGENTS_CHILD: "1" }, false], [{ GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR: "1", GENTLE_PI_AGENTS_CHILD: "1" }, false]] as const) {
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

test("a captured provider-role artifact continues only through bound STATUS; look-alikes stay blocked", async () => {
 const role = { tool: "gentle_review_capture", status: "captured", outcome: "native-provider-role-captured", provider_role: { role: "refuter", captured: true } };
 const host = backend([collect, role, approved, closed]);
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, host)).outcome, "closed");
 assert.deepEqual(host.calls.map(call => call.tool === "gentle_review" ? String(call.parameters.operation) : call.tool), ["status", "gentle_review_capture", "status", "acknowledge-approved"]);
 const group = { ...collect, collectBindings: [{ collectBinding: "first" }, { collectBinding: "second" }] };
 for (const [status, capture] of [
  [collect, { ...role, status: "blocked" }],
  [collect, { ...role, failure: { kind: "transport" } }],
  [collect, { ...role, native_failure: {} }],
  [collect, { ...role, reconciliation: {} }],
  [collect, { ...role, reconciliation_failure: {} }],
  [collect, { ...role, status: "reconciled" }],
  [collect, (({ status: _status, ...rest }) => rest)(role)],
  [collect, { ...role, outcome: "native-provider-role-capture-recorded" }],
  [group, role],
 ] as const) {
  const blocked = backend([status, capture]);
  const result = await runReviewCoordinator({ lineageId: lineage }, blocked);
  assert.equal(result.outcome, "blocked", JSON.stringify(capture)); assert.equal(result.result, capture); assert.equal(blocked.calls.length, 2);
 }
});

test("advisory finding claim marks are relayed only as arrays of strings, and only with the claims", async () => {
 const findings = { statement: "fixture", findings: [{ id: "F1" }, { id: "F2" }] };
 const run = async (closure: Body) => await runReviewCoordinator({ lineageId: lineage }, backend([collect, { ...captured, closure: { advisory_findings: findings, ...closure } }, approved, closed]));
 const marked = await run({ advisory_finding_claims: { F1: "cut" }, advisory_finding_claims_truncated: ["F1"], advisory_finding_claims_omitted: ["F2"] });
 assert.deepEqual(marked.advisory_finding_claims_truncated, ["F1"]); assert.deepEqual(marked.advisory_finding_claims_omitted, ["F2"]);
 for (const mark of ["F1", [1], { F1: true }, null]) {
  const result = await run({ advisory_finding_claims: { F1: "cut" }, advisory_finding_claims_truncated: mark, advisory_finding_claims_omitted: mark });
  assert.equal(result.outcome, "closed");
  assert.equal(Object.hasOwn(result, "advisory_finding_claims_truncated"), false, JSON.stringify(mark));
  assert.equal(Object.hasOwn(result, "advisory_finding_claims_omitted"), false, JSON.stringify(mark));
 }
 const withoutClaims = await run({ advisory_finding_claims_truncated: ["F1"] });
 assert.equal(Object.hasOwn(withoutClaims, "advisory_finding_claims_truncated"), false);
});

test("cancellation after an admitted closure with findings returns cancelled; a refused capture or a closure without findings still aborts", async () => {
 const findings = { statement: "fixture", findings: [{ id: "F1" }] };
 const withFindings = { ...captured, closure: { advisory_findings: findings, advisory_finding_claims: { F1: "claim" } } };
 const racing = (response: Body) => {
  const controller = new AbortController(); const calls: string[] = [];
  return { calls, signal: controller.signal, async invoke(tool: ReviewCoordinatorTool) { calls.push(tool); if (tool === "gentle_review") return collect; controller.abort(); return response; } };
 };
 const host = racing(withFindings);
 const result = await runReviewCoordinator({ lineageId: lineage }, host);
 assert.equal(result.outcome, "cancelled"); assert.deepEqual(result.result, withFindings, "the fixture envelope carries no status or state to drop");
 assert.deepEqual(result.advisory_findings, findings); assert.deepEqual(result.advisory_finding_claims, { F1: "claim" });
 assert.deepEqual(host.calls, ["gentle_review", "gentle_review_capture"], "nothing is dispatched after the cancellation");
 for (const response of [{ ...withFindings, failure: { kind: "transport" } }, { ...withFindings, outcome: "capture-binding-rejected" }, { ...captured, closure: {} }, captured]) {
  const refused = racing(response);
  await assert.rejects(runReviewCoordinator({ lineageId: lineage }, refused), { name: "AbortError" }, JSON.stringify(response));
  assert.equal(refused.calls.length, 2);
 }
});

test("after a captured provider-role artifact, drift, a reoffered capture and the cap still stop the run", async () => {
 const role = { tool: "gentle_review_capture", status: "captured", outcome: "native-provider-role-captured", provider_role: { role: "refuter", captured: true } };
 const drift = backend([collect, role, { result: { ...approved.result, target_identity: "other" } }]);
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, drift)).outcome, "binding-drift"); assert.equal(drift.calls.length, 3);
 const reoffered = backend([collect, role, collect]);
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, reoffered)).outcome, "repeated-capture"); assert.equal(reoffered.calls.length, 3);
 let roles = 0;
 const capped = await runReviewCoordinator({ lineageId: lineage }, { invoke: async tool => {
  if (tool === "gentle_review") return { ...collect, collectBindings: [{ collectBinding: `role-${roles}` }] };
  roles++; return role;
 } });
 assert.equal(capped.outcome, "transition-limit"); assert.equal(roles, 24);
});

test("a retained approved closure with findings survives every later abort before the acknowledgement; a completed acknowledgement stays closed", async () => {
 const findings = { statement: "fixture", findings: [{ id: "F1" }] };
 const withFindings = { ...captured, status: "closed", closure: { state: "approved", advisory_findings: findings, advisory_finding_claims: { F1: "claim" }, advisory_finding_claims_truncated: ["F1"] } };
 const expected = { outcome: "native-last-event-closure", closure: { advisory_findings: findings, advisory_finding_claims: { F1: "claim" }, advisory_finding_claims_truncated: ["F1"] } };
 // Abort observed after STATUS completed (while its step is recorded), before the acknowledgement.
 {
  const controller = new AbortController(); const calls: string[] = []; let statuses = 0; let abortAtNextClock = false;
  const result = await runReviewCoordinator({ lineageId: lineage }, { signal: controller.signal,
   now: () => { if (abortAtNextClock) controller.abort(); return 0; },
   async invoke(tool, parameters) {
    calls.push(tool === "gentle_review" ? String(parameters.operation) : tool);
    if (tool !== "gentle_review") return withFindings;
    if (++statuses === 1) return collect;
    abortAtNextClock = true; return approved;
   } });
  assert.equal(result.outcome, "cancelled"); assert.deepEqual(result.result, expected);
  assert.deepEqual(result.advisory_findings, findings); assert.deepEqual(result.advisory_finding_claims, { F1: "claim" }); assert.deepEqual(result.advisory_finding_claims_truncated, ["F1"]);
  assert.deepEqual(calls, ["status", "gentle_review_capture", "status"], "no acknowledgement after the abort");
 }
 // The acknowledgement rejects because of the abort; or completes although the signal aborted.
 for (const [ack, outcome] of [["rejects", "cancelled"], ["completes", "closed"]] as const) {
  const controller = new AbortController(); let statuses = 0;
  const result = await runReviewCoordinator({ lineageId: lineage }, { signal: controller.signal, async invoke(tool, parameters) {
   if (tool !== "gentle_review") return withFindings;
   if (parameters.operation === "acknowledge-approved") {
    controller.abort();
    if (ack === "rejects") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return closed;
   }
   return ++statuses === 1 ? collect : approved;
  } });
  assert.equal(result.outcome, outcome, ack);
  assert.deepEqual(result.advisory_findings, findings, ack);
 }
 // A non-abort rejection is not a cancellation.
 let statuses = 0;
 await assert.rejects(runReviewCoordinator({ lineageId: lineage }, { async invoke(tool) {
  if (tool !== "gentle_review") return withFindings;
  if (++statuses === 1) return collect;
  throw new Error("transport failure");
 } }), /transport failure/);
});

test("only the abort itself turns a retained approved closure into cancelled; another error thrown while aborted is rethrown", async () => {
 const findings = { statement: "fixture", findings: [{ id: "F1" }] };
 const withFindings = { ...captured, closure: { advisory_findings: findings } };
 const failing = (abort: (controller: AbortController) => void, thrown: (signal: AbortSignal) => unknown) => {
  const controller = new AbortController(); let statuses = 0;
  return runReviewCoordinator({ lineageId: lineage }, { signal: controller.signal, async invoke(tool) {
   if (tool !== "gentle_review") return withFindings;
   if (++statuses === 1) return collect;
   abort(controller); throw thrown(controller.signal);
  } });
 };
 const transport = new Error("transport failure");
 await assert.rejects(failing(controller => controller.abort(), () => transport), error => error === transport, "a non-abort error is rethrown, not cancelled");
 const timeout = new DOMException("deadline", "TimeoutError");
 for (const [label, abort, thrown] of [
  ["AbortError-named error", (controller: AbortController) => controller.abort(), () => Object.assign(new Error("aborted"), { name: "AbortError" })],
  ["the signal's default reason", (controller: AbortController) => controller.abort(), (signal: AbortSignal) => signal.reason],
  ["the signal's own custom reason", (controller: AbortController) => controller.abort(timeout), (signal: AbortSignal) => signal.reason],
 ] as const) {
  const result = await failing(abort, thrown);
  assert.equal(result.outcome, "cancelled", label); assert.deepEqual(result.advisory_findings, findings, label);
 }
});

test("resume_input names the INSPECT's resolved workspace_root only when the caller passed none", async () => {
 const selecting = { operation: "inspect", status: "blocked", result: { next_transition: { kind: "collect" } }, selectionBinding: "opaque-selection", workspace_root: "/resolved/root" };
 const input = { lenses: ["risk"], lensesReason: "fixture" };
 assert.deepEqual((await runReviewCoordinator(input, backend([{ reviewDue: true }, selecting]))).resume_input, { ...input, workspaceRoot: "/resolved/root" });
 assert.deepEqual((await runReviewCoordinator({ ...input, workspaceRoot: "/caller/root" }, backend([{ reviewDue: true }, selecting]))).resume_input, { ...input, workspaceRoot: "/caller/root" });
 const { workspace_root: _root, ...unrooted } = selecting;
 assert.deepEqual((await runReviewCoordinator(input, backend([{ reviewDue: true }, unrooted]))).resume_input, input);
});

// odd/tasks/review-one-call.md T11 (S5): the correction request's findings, relayed beside input-required.
const correctionFinding = (id: string, claim: unknown, extra: Body = {}) => ({ id, lens: "risk", location: "a.ts:1", severity: "CRITICAL", claim, proof_refs: ["p"], evidence: "e", evidence_class: "deterministic", causal_disposition: "introduced", ...extra });
// L21: the provider answered the non-blocking question (with none), so the correction fields come back.
const answeredNone = { statement: "s", findings: [] };
// `null` builds a STATUS without the key (the provider did not answer).
const correctionStatus = (findings: unknown, nonBlocking: unknown = answeredNone) => ({ ...collect, result: { ...collect.result, next_transition: { kind: "collect", correction_request: { request_hash: "opaque-request", findings } },
 ...(nonBlocking === null ? {} : { non_blocking_findings: nonBlocking }) }, collectBindings: [{ collectBinding: "plan" }] });

test("a correction request's findings are relayed as provider fields plus bounded claims, never routed on", async () => {
 const findings = [correctionFinding("B1", "first claim"), correctionFinding("B2", "second claim", { future_field: "kept in STATUS only" }), correctionFinding("B1", "duplicate id")];
 const response = correctionStatus(findings);
 const host = backend([response]);
 const result = await runReviewCoordinator({ lineageId: lineage }, host);
 assert.equal(result.outcome, "input-required"); assert.equal(host.calls.length, 1);
 const { non_blocking_findings: _answer, ...nested } = response.result as Body;
 assert.deepEqual(result.result, { ...response, result: nested }, "the STATUS envelope is relayed unchanged apart from the non-blocking answer (L19)");
 const listed = { lens: "risk", location: "a.ts:1", severity: "CRITICAL", evidence_class: "deterministic", causal_disposition: "introduced" };
 assert.deepEqual(result.correction_findings, [{ id: "B1", ...listed }, { id: "B2", ...listed }, { id: "B1", ...listed }]);
 assert.deepEqual(result.correction_finding_claims, { B2: "second claim" }, "an id with more than one finding is left out");
 const bounded = await runReviewCoordinator({ lineageId: lineage }, backend([correctionStatus([correctionFinding("B1", "é".repeat(600)), ...Array.from({ length: 8 }, (_, i) => correctionFinding(`C${i}`, "z".repeat(1024)))])]));
 assert.equal((bounded.correction_finding_claims as Body).B1, "é".repeat(512)); assert.deepEqual(bounded.correction_finding_claims_truncated, ["B1"]);
 assert.deepEqual(Object.keys(bounded.correction_finding_claims as Body), ["B1", "C0", "C1", "C2", "C3", "C4", "C5", "C6"]); assert.deepEqual(bounded.correction_finding_claims_omitted, ["C7"]);
});

test("without the provider's non-blocking answer a correction request returns no correction fields (L21)", async () => {
 const findings = [correctionFinding("B1", "first claim")];
 const response = correctionStatus(findings, null);
 const result = await runReviewCoordinator({ lineageId: lineage }, backend([response]));
 assert.equal(result.outcome, "input-required"); assert.equal(result.result, response, "the STATUS envelope is relayed unchanged");
 for (const key of ["correction_findings", "correction_finding_claims", "correction_finding_claims_truncated", "correction_finding_claims_omitted", "non_blocking_findings"]) assert.equal(Object.hasOwn(result, key), false, key);
 // A set the run drops (whitespace-only) is not an answer either.
 const dropped = await runReviewCoordinator({ lineageId: lineage }, backend([correctionStatus(findings, { statement: " ", findings: [] })]));
 for (const key of ["correction_findings", "correction_finding_claims", "non_blocking_findings"]) assert.equal(Object.hasOwn(dropped, key), false, `dropped: ${key}`);
 const answered = await runReviewCoordinator({ lineageId: lineage }, backend([correctionStatus(findings)]));
 assert.deepEqual(answered.correction_finding_claims, { B1: "first claim" }); assert.deepEqual(answered.non_blocking_findings, answeredNone);
});

test("a malformed correction finding set is dropped whole and the outcome stays input-required", async () => {
 const proto = Object.create({ id: "B1" });
 for (const findings of [undefined, [], "B1", [null], [correctionFinding("B1", "")], [correctionFinding("B1", 3)], [{ ...correctionFinding("B1", "c"), severity: 1 }], [{ ...correctionFinding("B1", "c"), lens: undefined }],
  [{ ...correctionFinding("B1", "c"), evidence_class: 2 }], [proto], [new Map([["id", "B1"]])], [correctionFinding("B1", "c"), ["B2"]]]) {
  const result = await runReviewCoordinator({ lineageId: lineage }, backend([correctionStatus(findings)]));
  assert.equal(result.outcome, "input-required", JSON.stringify(findings));
  for (const key of ["correction_findings", "correction_finding_claims", "correction_finding_claims_truncated", "correction_finding_claims_omitted"]) assert.equal(Object.hasOwn(result, key), false, `${key}: ${JSON.stringify(findings)}`);
 }
});

test("correction findings are read only after the correction request decided input-required, and never from any other response", async () => {
 // A correction request without kind collect routes as before; its findings are not read.
 const request: Body = { request_hash: "opaque" };
 Object.defineProperty(request, "findings", { get() { throw new Error("must not read findings before the routing decision"); } });
 const stoppedWithRequest = { ...collect, result: { ...collect.result, next_transition: { kind: "stop", correction_request: request } } };
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, backend([stoppedWithRequest]))).outcome, "stopped");
 // An approved run carries the advisory keys only.
 const closedRun = await runReviewCoordinator({ lineageId: lineage }, backend([collect, { ...captured, closure: { advisory_findings: { statement: "s", findings: [{ id: "F1" }] }, advisory_finding_claims: { F1: "c" } } }, approved, closed]));
 assert.equal(closedRun.outcome, "closed"); assert.equal(Object.hasOwn(closedRun, "correction_findings"), false); assert.deepEqual(closedRun.advisory_finding_claims, { F1: "c" });
});
