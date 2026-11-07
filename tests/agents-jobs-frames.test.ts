import assert from "node:assert/strict";
import test from "node:test";
import { CHILD_MESSAGE_MAX_BYTES, formatChildJobState, parseChildFrame, parseChildJobState, validChildId, validChildJobId, validChildQueryId } from "../lib/agents-messaging.ts";

// Child background jobs (#2266): a job state report travels on the same owned
// IPC as acks, queries and notifications, so its frame must stay strictly
// separated by correlation prefix and bounded in size before any JSON parse.

const state = (running: number, pending: boolean) => JSON.stringify({ running, pending });
const frame = (id: string, kind: string, message: string) => ({ id, kind, message });

function parse(value: unknown): unknown {
	const result = parseChildFrame(value) as { frame?: unknown; id?: string; error?: string };
	return { frame: result.frame ? { id: (result.frame as { id: string }).id, kind: (result.frame as { kind: string }).kind } : undefined, id: result.id, error: result.error };
}

test("P-A1 a well-formed job frame is accepted", () => {
	assert.deepEqual(parse(frame("j1", "job", state(1, true))), { frame: { id: "j1", kind: "job" }, id: undefined, error: undefined });
});

test("P-A2 correlation prefixes are disjoint, so a job id can never be an ack/notification id", () => {
	assert.equal(validChildId("j1"), false);
	assert.equal(validChildId("n1"), true);
	assert.equal(validChildQueryId("j1"), false);
	assert.equal(validChildJobId("n1"), false);
	assert.equal(validChildJobId("q1"), false);
	assert.equal(validChildJobId("j1"), true);
});

test("P-A3 a job-kind frame with a notification or query id is refused", () => {
	assert.equal((parse(frame("n1", "job", state(0, false))) as { error?: string }).error, "invalid child IPC correlation");
	assert.equal((parse(frame("q1", "job", state(0, false))) as { error?: string }).error, "invalid child IPC correlation");
});

test("P-A4 a notification or query frame carrying a job id is refused", () => {
	assert.equal((parse(frame("j1", "notification", "hello")) as { error?: string }).error, "invalid child IPC correlation");
	assert.equal((parse(frame("j1", "query", "hello")) as { error?: string }).error, "invalid child IPC correlation");
});

test("P-A5 an unknown kind is still rejected", () => {
	for (const kind of ["monitor", "ack", "jobstate", "JOB", "", "job "]) {
		assert.equal((parse(frame("j1", kind, state(0, false))) as { error?: string }).error, "unsupported child IPC kind", kind);
	}
});

test("P-A6 job correlation boundaries: j0, leading zeros, sign, spaces and >16 digits are refused", () => {
	for (const id of ["j0", "j01", "j+1", "j-1", "j 1", "j1 ", " j1", "j12345678901234567", "j9999999999999999", "J1", "j"]) {
		const result = parse(frame(id, "job", state(0, false))) as { error?: string; frame?: unknown };
		assert.equal(result.frame, undefined, id);
		assert.ok(result.error, id);
	}
	// The largest accepted form still fits a safe integer.
	assert.equal(validChildJobId("j9007199254740991"), true);
});

test("P-A7 an oversized job message is refused before any JSON parsing", () => {
	const originalParse = JSON.parse;
	let largeParses = 0;
	(JSON as unknown as { parse: (text: string) => unknown }).parse = (text: string) => {
		if (typeof text === "string" && text.length > 10_000) largeParses += 1;
		return originalParse(text);
	};
	try {
		const huge = JSON.stringify({ running: 0, pending: false, pad: "x".repeat(10 * 1024 * 1024) });
		assert.ok(huge.length > 10 * 1024 * 1024);
		const result = parseChildFrame(frame("j1", "job", huge)) as { frame?: unknown; id?: string; error?: string };
		assert.deepEqual({ frame: result.frame, id: result.id, error: result.error }, { frame: undefined, id: "j1", error: "invalid child IPC message" });
		// One byte over the documented bound is already refused.
		const justOver = "x".repeat(CHILD_MESSAGE_MAX_BYTES + 1);
		assert.equal((parseChildFrame(frame("j1", "job", justOver)) as { error?: string }).error, "invalid child IPC message");
		assert.equal(largeParses, 0, "no multi-kilobyte JSON.parse reached the runner");
	} finally {
		(JSON as unknown as { parse: (text: string) => unknown }).parse = originalParse;
	}
});

test("P-A8 malformed job state is refused with no throw", () => {
	for (const message of [
		"", "not json", "{}", "null", "[]", "0", "\"running\"",
		'{"running":0}', '{"pending":false}', '{"running":0,"pending":false,"extra":1}',
		'{"running":-1,"pending":false}', '{"running":1.5,"pending":false}', '{"running":"1","pending":false}',
		'{"running":0,"pending":"false"}', '{"running":0,"pending":null}', '{"running":1000001,"pending":false}',
		'{"running":1e999,"pending":false}', '{"running":null,"pending":false}',
	]) assert.equal(parseChildJobState(message), undefined, message);
});

test("P-A9 the bounded job state round-trips, including the documented limits", () => {
	assert.deepEqual(parseChildJobState(state(0, false)), { running: 0, pending: false });
	assert.deepEqual(parseChildJobState(state(25, true)), { running: 25, pending: true });
	assert.deepEqual(parseChildJobState(state(1_000_000, false)), { running: 1_000_000, pending: false });
	assert.deepEqual(formatChildJobState({ running: 3, pending: true }), '{"running":3,"pending":true}');
	assert.deepEqual(parseChildJobState(formatChildJobState({ running: 3, pending: true })), { running: 3, pending: true });
});
