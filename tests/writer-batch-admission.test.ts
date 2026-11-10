import assert from "node:assert/strict";
import test from "node:test";
import { sameMessageToolCalls } from "../lib/writer-batch-admission.ts";

// cost-speed P6: the batch is read from the session branch at `tool_call`, where Pi already persisted the assistant
// message (on `message_end`). Results of earlier calls of the same message may follow it; an older message never
// lends its calls.

type Entry = { type: string; id: string; parentId: string | null; message?: Record<string, unknown> };

function branch(entries: Entry[]) {
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	return { getLeafEntry: () => entries.at(-1), getEntry: (id: string) => byId.get(id) };
}

const assistant = (id: string, parentId: string | null, calls: string[]): Entry => ({ type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text: "go" }, ...calls.map(call => ({ type: "toolCall", id: call, name: "subagent_run", arguments: { agent: "worker", task: call } }))] } });
const result = (id: string, parentId: string, toolCallId: string): Entry => ({ type: "message", id, parentId, message: { role: "toolResult", toolCallId, content: [] } });

test("P6: the batch is the issuing message's tool calls, past results and extension entries of the same turn", () => {
	const session = branch([
		assistant("a1", null, ["c1", "c2"]),
		result("r1", "a1", "c1"),
		{ type: "custom", id: "x1", parentId: "r1" },
	]);
	assert.deepEqual(sameMessageToolCalls(session, "c2"), [
		{ name: "subagent_run", arguments: { agent: "worker", task: "c1" } },
		{ name: "subagent_run", arguments: { agent: "worker", task: "c2" } },
	]);
});

test("P6: a call missing from the nearest assistant message gets no batch, and neither does an unreadable session", () => {
	const session = branch([assistant("a1", null, ["old1", "old2"]), result("r1", "a1", "old1"), result("r2", "r1", "old2"), assistant("a2", "r2", ["new1"])]);
	assert.equal(sameMessageToolCalls(session, "old1"), undefined, "an older message never lends its calls");
	assert.equal(sameMessageToolCalls(session, "nested-in-codemode"), undefined);
	assert.equal(sameMessageToolCalls(undefined, "new1"), undefined);
	assert.equal(sameMessageToolCalls(session, undefined), undefined);
	assert.equal(sameMessageToolCalls({ getLeafEntry: () => { throw new Error("closed"); }, getEntry: () => undefined }, "new1"), undefined);
});
