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

test("baseRef + escalate forwards both in assess input; inspect stays selector-only", async () => {
	const r = recorder((_tool, parameters) => parameters.operation === "assess" ? { reviewDue: true } : { failure: { code: "stop" } });
	await runReviewCoordinator({ baseRef: "main", committedOnly: true, escalate }, r.deps as never);
	assert.deepEqual(JSON.parse(String(r.calls[0]!.parameters.input)), { baseRef: "main", committedOnly: true, escalate });
	assert.deepEqual(JSON.parse(String(r.calls[1]!.parameters.input)), { baseRef: "main", committedOnly: true });
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
