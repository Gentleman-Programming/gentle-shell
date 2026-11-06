import assert from "node:assert/strict";
import test from "node:test";
import { herdrBusyLabel, nextHerdrBusyAction } from "../lib/herdr-busy.ts";

// Pure projection for the herdr:busy producer (gentle-shell#626). It mirrors
// pi-subagents' edge-triggered emitter: raise once, dedup an unchanged label,
// relabel as lower-then-raise, lower once. No I/O, no global state.

const task = (status: string): { status: string } => ({ status });

test("raises once when owned work starts", () => {
	assert.deepEqual(nextHerdrBusyAction([task("queued")], undefined), { kind: "raise", label: "1 subagent running" });
	assert.deepEqual(nextHerdrBusyAction([task("running")], undefined), { kind: "raise", label: "1 subagent running" });
	assert.deepEqual(nextHerdrBusyAction([task("waiting")], undefined), { kind: "raise", label: "1 subagent running" });
	assert.deepEqual(nextHerdrBusyAction([task("running"), task("running"), task("queued")], undefined), { kind: "raise", label: "3 subagents running" });
});

test("emits nothing while the label is unchanged", () => {
	assert.deepEqual(nextHerdrBusyAction([task("running")], { active: true, label: "1 subagent running" }), { kind: "none" });
});

test("a label change is a lower-then-raise in one step", () => {
	assert.deepEqual(
		nextHerdrBusyAction([task("running"), task("running")], { active: true, label: "1 subagent running" }),
		{ kind: "lower-then-raise", label: "2 subagents running" },
	);
	assert.deepEqual(
		nextHerdrBusyAction([task("running")], { active: true, label: "2 subagents running" }),
		{ kind: "lower-then-raise", label: "1 subagent running" },
	);
});

test("lowers once when the last task settles, and never re-lowers", () => {
	assert.deepEqual(nextHerdrBusyAction([], { active: true, label: "2 subagents running" }), { kind: "lower" });
	assert.deepEqual(nextHerdrBusyAction([], undefined), { kind: "none" });
	assert.deepEqual(nextHerdrBusyAction([], { active: false }), { kind: "none" });
});

test("cancellation, failure and timeout each lower busy", () => {
	for (const status of ["completed", "failed", "cancelled", "timed_out"]) {
		assert.deepEqual(nextHerdrBusyAction([task(status)], { active: true, label: "1 subagent running" }), { kind: "lower" }, status);
	}
});

test("malformed input fails closed as a no-op", () => {
	assert.deepEqual(nextHerdrBusyAction(undefined, undefined), { kind: "none" });
	assert.deepEqual(nextHerdrBusyAction("running", undefined), { kind: "none" });
	assert.deepEqual(nextHerdrBusyAction([null], undefined), { kind: "none" });
	assert.deepEqual(nextHerdrBusyAction([42], undefined), { kind: "none" });
	assert.deepEqual(nextHerdrBusyAction([{}], undefined), { kind: "none" });
	assert.deepEqual(nextHerdrBusyAction([{ status: 7 }], undefined), { kind: "none" });
	// A malformed previously-emitted state is simply not busy.
	assert.deepEqual(nextHerdrBusyAction([task("running")], "busy"), { kind: "raise", label: "1 subagent running" });
});

test("the label is content-free and derived from counts only", () => {
	assert.equal(herdrBusyLabel(1), "1 subagent running");
	assert.equal(herdrBusyLabel(3), "3 subagents running");
});
