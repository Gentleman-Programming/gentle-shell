import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewCoordinatorInput, runReviewCoordinator, type ReviewCoordinatorTool } from "../lib/review-coordinator.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

type Body = Record<string, any>;
const target = "sha256:" + "a".repeat(64);
const lineage = "review-fixture";
const scoped = { workspaceRoot: process.cwd(), baseRef: "b".repeat(40), committedOnly: true as const };
const ready = { result: { target_identity: target, next_transition: { kind: "execute", execute: { operation: "review.start" } } } };
const collect = { result: { target_identity: target, authority: { lineage_id: lineage }, next_transition: { kind: "collect" } }, collectBindings: [{ collectBinding: "opaque-not-json", requiresInput: false }] };
const approved = { result: { target_identity: target, authority: { lineage_id: lineage }, next_transition: { kind: "execute", execute: { operation: "review.acknowledge-approved" } } } };
const closed = { outcome: "native-approved-acknowledgement-completed", status: "closed", authority: "burned", target_identity: target, lineage_id: lineage };
const captured = { outcome: "native-last-event-closure" };
const stopped = { result: { ...collect.result, next_transition: { kind: "stop", reason_code: "corrected_candidate_unavailable" } } };
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
 for (const response of [stopped, { ...collect, collectBindings: [{ collectBinding: "plan", requiresInput: true }] }, { ...collect, collectBindings: [] }]) {
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

test("unknown input metadata fails closed and exact groups retain provider order", async () => {
 const missing = backend([{ ...collect, collectBindings: [{ collectBinding: "opaque" }] }]);
 assert.equal((await runReviewCoordinator({ lineageId: lineage }, missing)).outcome, "input-required");
 const host = backend([{ ...collect, collectBindings: [{ collectBinding: "second", requiresInput: false }, { collectBinding: "first", requiresInput: false }] }, captured, stopped]);
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
