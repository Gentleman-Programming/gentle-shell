import assert from "node:assert/strict";
import test from "node:test";
import { ORCA_SUBAGENT_COMPLETE, ORCA_SUBAGENT_STARTED, nextOrcaSubagentEvents } from "../lib/orca-subagent-lifecycle.ts";

// Orca's injected pi status extension keeps the pane "working" only while it
// hears subagent:async-started / subagent:async-complete on pi.events.

const task = (id: string, status: string) => ({ id, status, agent: "gentle-ai-worker", label: `label ${id}` });

test("announces each running owned task once", () => {
	const first = nextOrcaSubagentEvents([task("a", "running"), task("b", "queued")], new Set());
	assert.deepEqual(first.events, [
		{ name: ORCA_SUBAGENT_STARTED, payload: { id: "a", agent: "gentle-ai-worker", description: "label a" } },
		{ name: ORCA_SUBAGENT_STARTED, payload: { id: "b", agent: "gentle-ai-worker", description: "label b" } },
	]);
	assert.deepEqual([...first.emitted], ["a", "b"]);
	const again = nextOrcaSubagentEvents([task("a", "running"), task("b", "running")], first.emitted);
	assert.deepEqual(again.events, []);
});

test("completes a task once when it finishes or disappears", () => {
	const finished = nextOrcaSubagentEvents([task("a", "completed"), task("b", "running")], new Set(["a", "b"]));
	assert.deepEqual(finished.events, [{ name: ORCA_SUBAGENT_COMPLETE, payload: { id: "a" } }]);
	assert.deepEqual([...finished.emitted], ["b"]);
	const gone = nextOrcaSubagentEvents([], finished.emitted);
	assert.deepEqual(gone.events, [{ name: ORCA_SUBAGENT_COMPLETE, payload: { id: "b" } }]);
	assert.equal(gone.emitted.size, 0);
});

test("a task that finished before being announced emits nothing", () => {
	assert.deepEqual(nextOrcaSubagentEvents([task("a", "failed")], new Set()).events, []);
});

test("fails closed on malformed input", () => {
	const emitted = new Set(["a"]);
	const result = nextOrcaSubagentEvents("nope", emitted);
	assert.deepEqual(result.events, []);
	assert.equal(result.emitted, emitted);
	assert.deepEqual(nextOrcaSubagentEvents([{ status: "running" }], new Set()).events, []);
});
