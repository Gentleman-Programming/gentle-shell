import assert from "node:assert/strict";
import test from "node:test";
import { consumeReviewMutation, pendingReviewMutation, pendingReviewMutationProfiles, recordReviewMutation, REVIEW_REMINDER_RECEIPT } from "../lib/review-reminder-receipt.ts";

function fixture() {
	let sessionId = "parent";
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const session = { getSessionId: () => sessionId, getBranch: () => entries };
	const host = { appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); } };
	const write = (toolCallId: string, root = "/repo") => recordReviewMutation(host, session, root, { source: "direct", toolName: "write", toolCallId });
	return { host, session, entries, write, switchSession: (id: string) => { sessionId = id; } };
}

test("receipts survive reload but are isolated by session, root, and active branch", () => {
	const f = fixture();
	f.write("a");
	const captured = pendingReviewMutation(f.session, "/repo");
	assert.ok(captured);
	assert.equal(pendingReviewMutation({ ...f.session }, "/repo"), captured);
	assert.equal(pendingReviewMutation(f.session, "/sibling"), undefined);
	f.switchSession("fork");
	assert.equal(pendingReviewMutation(f.session, "/repo"), undefined);
	f.switchSession("new");
	assert.equal(pendingReviewMutation(f.session, "/repo"), undefined);
	f.switchSession("parent");
	assert.equal(pendingReviewMutation({ ...f.session, getBranch: () => [] }, "/repo"), undefined);
	f.write("a");
	assert.equal(f.entries.length, 1, "duplicate tool completion cannot re-enable a generation");
});

for (const kind of ["nudged", "acknowledged"] as const) {
	test(`${kind} consumes only its captured prefix, retaining a concurrent own mutation`, () => {
		const f = fixture();
		f.write("a");
		const captured = pendingReviewMutation(f.session, "/repo");
		f.write("b");
		consumeReviewMutation(f.host, f.session, "/repo", captured, kind, "whole-target");
		assert.equal(pendingReviewMutation(f.session, "/repo", captured), undefined);
		const next = pendingReviewMutation(f.session, "/repo");
		assert.ok(next && next !== captured);
		consumeReviewMutation(f.host, f.session, "/repo", next, kind, "whole-target");
		assert.equal(pendingReviewMutation(f.session, "/repo"), undefined);
		f.write("c");
		assert.ok(pendingReviewMutation(f.session, "/repo"));
	});
}

test("malformed, unknown-version, and unmatched consumption entries do not establish ownership", () => {
	const f = fixture();
	f.write("valid");
	const good = f.entries.pop()!;
	const data = good.data as Record<string, unknown>;
	for (const patch of [{ kind: "spawn" }, { source: "prose" }, { toolName: "bash" }, { sessionId: "" }, { root: "relative" }, { taskId: "foreign" }, { extra: true }, { toolCallId: "" }, { id: null }]) {
		f.entries.push({ ...good, data: { ...data, ...patch } });
	}
	f.entries.push({ ...good, customType: "gentle-pi.review-reminder-receipt/v99" });
	assert.equal(pendingReviewMutation(f.session, "/repo"), undefined);
	f.entries.push(good);
	const captured = pendingReviewMutation(f.session, "/repo");
	consumeReviewMutation(f.host, f.session, "/repo", "unknown", "acknowledged", "target");
	assert.equal(pendingReviewMutation(f.session, "/repo"), captured);
});

// gentle-pi#1175 (T2): mutation receipts optionally carry the writer profile
// the runtime resolved, so ASSESS never has to trust a model re-declaration.
test("mutation receipts validate with or without runtime writer profile fields, never with empty ones", () => {
	const f = fixture();
	recordReviewMutation(f.host, f.session, "/repo", { source: "direct", toolName: "write", toolCallId: "plain" });
	recordReviewMutation(f.host, f.session, "/repo", { source: "direct", toolName: "edit", toolCallId: "profiled", writerModelId: "anthropic/claude-sonnet-5", writerEffort: "high" });
	recordReviewMutation(f.host, f.session, "/repo", { source: "subagent", taskId: "task-1", toolName: "write", toolCallId: "model-only", writerModelId: "openai/gpt-5-mini" });
	assert.equal(f.entries.length, 3);
	assert.deepEqual(pendingReviewMutationProfiles(f.session, "/repo"), [
		{},
		{ writerModelId: "anthropic/claude-sonnet-5", writerEffort: "high" },
		{ writerModelId: "openai/gpt-5-mini" },
	]);
	const good = f.entries[1];
	const data = good.data as Record<string, unknown>;
	f.entries.length = 0;
	for (const patch of [{ writerModelId: "" }, { writerEffort: " " }, { writerModelId: 1 }, { writerEffort: null }, { writerModel: "x" }]) {
		f.entries.push({ ...good, data: { ...data, ...patch } });
	}
	assert.equal(pendingReviewMutation(f.session, "/repo"), undefined, "a present-but-empty or malformed profile field invalidates the receipt");
	assert.deepEqual(pendingReviewMutationProfiles(f.session, "/repo"), []);
});

test("recording drops unknown or blank profile fields instead of dropping the mutation evidence", () => {
	const f = fixture();
	recordReviewMutation(f.host, f.session, "/repo", { source: "direct", toolName: "write", toolCallId: "a", writerModelId: "", writerEffort: undefined });
	assert.equal(f.entries.length, 1);
	assert.deepEqual(Object.keys(f.entries[0].data as object).sort(), ["id", "kind", "root", "sessionId", "source", "toolCallId", "toolName"]);
	assert.ok(pendingReviewMutation(f.session, "/repo"));
	assert.deepEqual(pendingReviewMutationProfiles(f.session, "/repo"), [{}]);
});

test("pending writer profiles follow the same consumption watermark as pendingReviewMutation", () => {
	const f = fixture();
	recordReviewMutation(f.host, f.session, "/repo", { source: "direct", toolName: "write", toolCallId: "a", writerModelId: "gpt-5-mini" });
	const captured = pendingReviewMutation(f.session, "/repo");
	recordReviewMutation(f.host, f.session, "/repo", { source: "direct", toolName: "write", toolCallId: "b", writerModelId: "claude-sonnet-5", writerEffort: "high" });
	consumeReviewMutation(f.host, f.session, "/repo", captured, "acknowledged", "target");
	assert.deepEqual(pendingReviewMutationProfiles(f.session, "/repo"), [{ writerModelId: "claude-sonnet-5", writerEffort: "high" }]);
	assert.deepEqual(pendingReviewMutationProfiles(f.session, "/sibling"), []);
	consumeReviewMutation(f.host, f.session, "/repo", pendingReviewMutation(f.session, "/repo"), "nudged", "target");
	assert.deepEqual(pendingReviewMutationProfiles(f.session, "/repo"), []);
	f.switchSession("other");
	assert.deepEqual(pendingReviewMutationProfiles(f.session, "/repo"), []);
});
