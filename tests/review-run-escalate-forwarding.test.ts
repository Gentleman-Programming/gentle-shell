import assert from "node:assert/strict";
import test from "node:test";
import { runReviewCoordinator, type ReviewCoordinatorTool } from "../lib/review-coordinator.ts";

type Body = Record<string, unknown>;
function recorder(reply: (tool: ReviewCoordinatorTool, parameters: Body) => Body) {
	const calls: Array<{ tool: ReviewCoordinatorTool; parameters: Body }> = [];
	return { calls, deps: { invoke: async (tool: ReviewCoordinatorTool, parameters: Body) => { calls.push({ tool, parameters }); return reply(tool, parameters); } } };
}
const escalate = { item: 4, reason: "shared counter mutated from a goroutine" };

test("resume with lineageId ignores escalate exactly like resume without it", async () => {
	const runs = [];
	for (const extra of [{}, { escalate }]) {
		const r = recorder(() => ({ failure: { code: "x" } }));
		const out = await runReviewCoordinator({ lineageId: "lin-1", ...extra }, r.deps as never);
		runs.push({ outcome: out.outcome, calls: r.calls });
	}
	assert.deepEqual(runs[1], runs[0]);
	assert.deepEqual(runs[0]!.calls.map((c) => c.parameters.operation), ["status"]);
	assert.equal(JSON.stringify(runs[1]!.calls).includes("escalate"), false);
});

test("baseRef + escalate forwards both to assess only; inspect stays selector-only", async () => {
	const r = recorder((_tool, parameters) => parameters.operation === "assess" ? { reviewDue: true } : { failure: { code: "stop" } });
	await runReviewCoordinator({ baseRef: "main", committedOnly: true, escalate }, r.deps as never);
	assert.deepEqual(JSON.parse(String(r.calls[0]!.parameters.input)), { baseRef: "main", committedOnly: true, escalate });
	assert.deepEqual(JSON.parse(String(r.calls[1]!.parameters.input)), { baseRef: "main", committedOnly: true });
});

test("a fresh START carries the escalate; inspect input is identical with and without escalate", async () => {
	const reply = (_tool: ReviewCoordinatorTool, parameters: Body): Body => parameters.operation === "assess" ? { reviewDue: true }
		: parameters.operation === "inspect" ? { result: { next_transition: { kind: "execute", execute: { operation: "review.start" } } } } : { failure: { code: "stop" } };
	const withEscalate = recorder(reply);
	await runReviewCoordinator({ escalate }, withEscalate.deps as never);
	const start = withEscalate.calls.find((c) => c.parameters.operation === "start")!;
	assert.deepEqual(JSON.parse(String(start.parameters.input)), { mode: "ordinary", escalate });
	assert.equal(withEscalate.calls.find((c) => c.parameters.operation === "inspect")!.parameters.input, undefined);
	const without = recorder(reply);
	await runReviewCoordinator({}, without.deps as never);
	assert.deepEqual(JSON.parse(String(without.calls.find((c) => c.parameters.operation === "start")!.parameters.input)), { mode: "ordinary" });
	assert.equal(without.calls.find((c) => c.parameters.operation === "inspect")!.parameters.input, undefined);
});

test("an invalid escalate is rejected even with lineageId, before any call", async () => {
	for (const bad of [{ item: 9, reason: "x" }, { item: 4, reason: "á".repeat(251) }, { item: 4, reason: "x", extra: 1 }, null]) {
		const r = recorder(() => ({}));
		await assert.rejects(runReviewCoordinator({ lineageId: "lin-1", escalate: bad }, r.deps as never), /escalate/);
		assert.equal(r.calls.length, 0);
	}
});

test("a 500-byte reason (250 × á) is accepted and forwarded unchanged", async () => {
	const reason = "á".repeat(250);
	const r = recorder(() => ({ reviewDue: false }));
	const out = await runReviewCoordinator({ escalate: { item: 4, reason } }, r.deps as never);
	assert.equal(out.outcome, "not-due");
	assert.equal(JSON.parse(String(r.calls[0]!.parameters.input)).escalate.reason, reason);
});
