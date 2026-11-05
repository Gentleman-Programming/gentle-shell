import assert from "node:assert/strict";
import test from "node:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_STATUS, type TaskRecord } from "../lib/agents-protocol.ts";
import { ResponseDiagnostics } from "../lib/agents-response-diagnostics.ts";
import {
	DIAGNOSTIC_MAX_AGE_MS, RESPONSE_DIAGNOSTIC_SCHEMA, diagnosticsDir, responseDiagnosticRecord, writeResponseDiagnostic,
	type ResponseDiagnosticRecord,
} from "../lib/agents-response-diagnostics-store.ts";

const SECRET = "PRIVATE_STORE_SENTINEL";
const NOW = 1_800_000_000_000;

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
	return { id: "mw-1a-task", agent: "gentle-ai-verify", mode: "task", prompt: SECRET, label: SECRET, cwd: `/private/${SECRET}`,
		parentSessionId: SECRET, status: TASK_STATUS.FAILED, createdAt: 10, startedAt: 100, endedAt: 1600, model: "cliproxy/agy-flash",
		thinking: "high", sessionPath: `/sessions/${SECRET}.jsonl`, error: "assistant returned no final report", result: SECRET,
		lastStep: SECRET, lastActivityAt: 1600, turns: 1, toolCalls: 2, tokens: 3, cost: 0, sddPreflightContext: SECRET, ...overrides };
}

function emptyResponse() {
	const observer = new ResponseDiagnostics();
	observer.observe({ type: "message_start", message: { role: "assistant" } });
	observer.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: SECRET } });
	return observer.observe({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } })!;
}

const scratch = () => mkdtempSync(join(tmpdir(), "rdiag-"));

test("builds a content-free record only for tasks that did not complete", () => {
	const last = emptyResponse();
	const record = responseDiagnosticRecord(task(), { responses: 2, settled: true, last })!;
	assert.deepEqual(record, { schema: RESPONSE_DIAGNOSTIC_SCHEMA, taskId: "mw-1a-task", agent: "gentle-ai-verify",
		requestedModel: "cliproxy/agy-flash", status: "failed", category: "empty_report", errorCategory: null, startedAt: 100, endedAt: 1600,
		durationMs: 1500, responses: 2, agentSettled: true, lastResponse: last });
	assert.equal(JSON.stringify(record).includes(SECRET), false);
	assert.ok(Object.isFrozen(record));
	assert.equal(responseDiagnosticRecord(task({ status: TASK_STATUS.COMPLETED, error: null }), undefined), undefined);
	const unobserved = responseDiagnosticRecord(task({ startedAt: null }), undefined)!;
	assert.deepEqual([unobserved.responses, unobserved.agentSettled, unobserved.lastResponse, unobserved.durationMs], [0, false, null, null]);
	assert.equal(responseDiagnosticRecord(task({ id: "../escape" }), undefined), undefined);
	const unlabeled = responseDiagnosticRecord(task({ agent: `bad agent ${SECRET}`, model: "x".repeat(200) }), undefined)!;
	assert.deepEqual([unlabeled.agent, unlabeled.requestedModel], [null, null]);
});

test("maps every runner ending to a closed category without keeping the error text", () => {
	for (const [status, error, category] of [
		[TASK_STATUS.FAILED, "assistant returned no final report", "empty_report"],
		[TASK_STATUS.FAILED, "assistant settled without a final report", "empty_report"],
		[TASK_STATUS.FAILED, "assistant reported an error", "assistant_error"],
		[TASK_STATUS.FAILED, "assistant reported an error (rate_limit)", "assistant_error"],
		[TASK_STATUS.FAILED, "assistant aborted", "assistant_aborted"],
		[TASK_STATUS.FAILED, `could not start pi: ${SECRET}`, "start_failed"],
		[TASK_STATUS.FAILED, `could not write agent instructions: ${SECRET}`, "start_failed"],
		[TASK_STATUS.FAILED, `pi exited with code 1 before agent_settled ${SECRET}`, "exited_before_settle"],
		[TASK_STATUS.FAILED, "child exit unconfirmed after 5000ms; capacity quarantined", "cleanup_unconfirmed"],
		[TASK_STATUS.FAILED, SECRET, "other_failure"],
		[TASK_STATUS.CANCELLED, `cancelled ${SECRET}`, "cancelled"],
		[TASK_STATUS.TIMED_OUT, `stalled for 30 min after: ${SECRET}`, "timed_out"],
	] as const) {
		const record = responseDiagnosticRecord(task({ status, error }), undefined)!;
		assert.equal(record.category, category, error);
		assert.equal(JSON.stringify(record).includes(SECRET), false);
	}
	const errorCategory = (error: string) => responseDiagnosticRecord(task({ error }), undefined)!.errorCategory;
	assert.equal(errorCategory("assistant reported an error (rate_limit)"), "rate_limit");
	assert.equal(errorCategory("assistant reported an error (unavailable)"), "unavailable");
	assert.equal(errorCategory(`assistant reported an error (${SECRET})`), null, "only the closed vocabulary is kept");
	assert.equal(errorCategory("assistant returned no final report"), null);
});

test("errorCategory keeps only an exact closed-vocabulary suffix", () => {
	const of = (error: string) => responseDiagnosticRecord(task({ error }), undefined)!;
	for (const error of [`assistant reported an error (rate_limit) ${SECRET}`, "assistant reported an error (__proto__)",
		"assistant reported an error (constructor)", "assistant reported an error (RATE_LIMIT)", "assistant reported an error ((rate_limit))",
		"assistant reported an error (rate_limit)(auth)", "assistant reported an error (rate_limit)\n", "assistant reported an error ()"]) {
		const record = of(error);
		assert.deepEqual([record.category, record.errorCategory], ["assistant_error", null], error);
		assert.equal(JSON.stringify(record).includes(SECRET), false);
	}
	for (const error of [`could not continue on a/b: ${SECRET}`, `could not switch to a/b: ${SECRET}`, `could not continue: ${SECRET}`]) {
		assert.deepEqual([of(error).category, of(error).errorCategory], ["other_failure", null], error);
	}
});

test("writes one private file per record and returns true", async () => {
	const root = scratch();
	const dir = diagnosticsDir(join(root, "agent"));
	assert.equal(dir, join(root, "agent", "gentle-agents", "diagnostics"));
	const record = responseDiagnosticRecord(task(), { responses: 1, settled: true, last: emptyResponse() })!;
	assert.equal(await writeResponseDiagnostic(dir, record, { now: () => NOW }), true);
	const files = readdirSync(dir);
	assert.deepEqual(files, [`${NOW}-mw-1a-task.json`]);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, files[0]), "utf8")), JSON.parse(JSON.stringify(record)));
	if (process.platform !== "win32") {
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
	}
});

test("prunes records by age and total size, oldest first, leaving foreign files alone", async () => {
	const dir = join(scratch(), "diagnostics");
	mkdirSync(dir, { recursive: true });
	const old = NOW - DIAGNOSTIC_MAX_AGE_MS - 1;
	writeFileSync(join(dir, `${old}-old.json`), "{}");
	writeFileSync(join(dir, `${NOW - 3}-a.json`), "x".repeat(400));
	writeFileSync(join(dir, `${NOW - 2}-b.json`), "x".repeat(400));
	writeFileSync(join(dir, "notes.txt"), "keep");
	writeFileSync(join(dir, `${NOW - 1}-c.json.123-ab.tmp`), "keep");
	const record = responseDiagnosticRecord(task({ id: "new" }), undefined)!;
	assert.equal(await writeResponseDiagnostic(dir, record, { now: () => NOW, maxBytes: 1000 }), true);
	assert.deepEqual(readdirSync(dir).sort(), [`${NOW - 1}-c.json.123-ab.tmp`, `${NOW - 2}-b.json`, `${NOW}-new.json`, "notes.txt"].sort());
});

test("a store failure resolves false and never throws or follows a symlink", async () => {
	const root = scratch();
	const record = responseDiagnosticRecord(task(), undefined)!;
	const blocked = join(root, "file");
	writeFileSync(blocked, "not a directory");
	assert.equal(await writeResponseDiagnostic(join(blocked, "diagnostics"), record, { now: () => NOW }), false);
	const target = join(root, "elsewhere");
	mkdirSync(target);
	const link = join(root, "linked");
	symlinkSync(target, link);
	assert.equal(await writeResponseDiagnostic(link, record, { now: () => NOW }), false);
	assert.deepEqual(readdirSync(target), []);
	assert.ok(lstatSync(link).isSymbolicLink());
	const huge = { ...record, agent: "x".repeat(20_000) } as ResponseDiagnosticRecord;
	assert.equal(await writeResponseDiagnostic(join(root, "huge"), huge, { now: () => NOW }), false);
});
