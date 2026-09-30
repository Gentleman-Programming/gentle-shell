import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { piDefaultSessionDir } from "../lib/gentle-shell-resume-hint.ts";
import { foldSessionCost, sessionCostFromEntries, sessionCostUsd } from "../lib/session-usage.ts";
import {
	listTranscriptFiles,
	loadTaskIdentityIndex,
	parseTranscriptLine,
	readSessionUsage,
	readTranscript,
	streamTranscript,
	type TranscriptTaskIdentity,
} from "../lib/session-transcript.ts";

// I3: transcript replay. The parent and child transcripts share one record
// shape, so one reader serves both; malformed lines are skipped and counted;
// nothing loads a whole file and nothing writes to disk.

const root = mkdtempSync(join(tmpdir(), "gentle-transcript-"));
after(() => rmSync(root, { recursive: true, force: true }));
const agentHome = join(root, "agent");
const projectCwd = "/home/dev/project";
const parentDir = piDefaultSessionDir(projectCwd, agentHome);
const childDir = join(agentHome, "gentle-agents", "sessions");
const tasksDir = join(agentHome, "gentle-agents", "tasks");

const PARENT_ID = "01a0eeb8-0747-719a-ab3c-c65304faf83f";
const CHILD_ID = "01a0edd5-ca84-72fe-8336-4a8dee7b9cb7";

function writeLines(file: string, lines: readonly unknown[]): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`, "utf8");
}

/** One assistant usage line in the transcript's verified shape. */
function assistantLine(input: {
	id: string;
	timestamp: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	stopReason?: string;
	usage?: Record<string, unknown>;
}): Record<string, unknown> {
	return {
		type: "message",
		id: input.id,
		parentId: null,
		timestamp: input.timestamp,
		message: {
			role: "assistant",
			model: input.model ?? "deepseek-v4.1-flash",
			provider: input.provider ?? "opencode-go",
			...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
			...(input.stopReason ? { stopReason: input.stopReason } : {}),
			usage: input.usage ?? {
				input: 499,
				output: 394,
				cacheRead: 11_008,
				cacheWrite: 0,
				reasoning: 184,
				totalTokens: 11_901,
				cost: { input: 0.00007485, output: 0.0002364, cacheRead: 0.000033024, cacheWrite: 0, total: 0.000344274 },
			},
		},
	};
}

const FIRST_USAGE = {
	input: 18_856,
	output: 157,
	cacheRead: 2_048,
	cacheWrite: 0,
	reasoning: 55,
	totalTokens: 21_061,
	cost: { input: 0.0028284, output: 0.0000942, cacheRead: 0.000006144, cacheWrite: 0, total: 0.002928744 },
};

const PARENT_LINES: readonly Record<string, unknown>[] = [
	{ type: "session", version: 3, id: PARENT_ID, timestamp: "2026-09-29T19:50:33.038Z", cwd: projectCwd },
	{ type: "message", id: "u1", parentId: null, timestamp: "2026-09-29T19:50:40.000Z", message: { role: "user", content: "hi" } },
	{ type: "custom", id: "c1", parentId: "u1", timestamp: "2026-09-29T19:51:00.000Z", customType: "gentle-pi.demo/v1" },
	assistantLine({ id: "a1", timestamp: "2026-09-29T19:52:32.384Z", thinkingLevel: "high", stopReason: "toolUse", usage: FIRST_USAGE }),
	{ type: "message", id: "tr1", parentId: "a1", timestamp: "2026-09-29T19:52:33.762Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash" } },
	assistantLine({ id: "a2", timestamp: "2026-09-29T19:52:40.100Z", usage: { input: 19_113, output: 368, cacheRead: 20_864, cacheWrite: 0, reasoning: 167, totalTokens: 40_345, cost: {} } }),
];

const parentFile = join(parentDir, `2026-09-29T19-50-33-038Z_${PARENT_ID}.jsonl`);
const childFile = join(childDir, `2026-09-29T15-43-26-349Z_${CHILD_ID}.jsonl`);
writeLines(parentFile, PARENT_LINES);
writeLines(childFile, [assistantLine({ id: "ch1", timestamp: "2026-09-29T15:43:52.593Z" })]);

// Two more parent sessions so the date range has something to select, and a
// child with no task file so the unidentified path is exercised. Written once
// at load so every test is independent of another test's side effects.
const olderFile = join(parentDir, "2026-09-20T08-00-00-000Z_01a00000-0000-7000-8000-000000000001.jsonl");
const middleFile = join(parentDir, "2026-09-25T08-00-00-000Z_01a00000-0000-7000-8000-000000000002.jsonl");
const orphanFile = join(childDir, "2026-09-29T16-00-00-000Z_01a0ffff-0000-7000-8000-000000000000.jsonl");
writeLines(olderFile, [assistantLine({ id: "o1", timestamp: "2026-09-20T08:00:01.000Z" })]);
writeLines(middleFile, [assistantLine({ id: "m1", timestamp: "2026-09-25T08:00:01.000Z" })]);
writeLines(orphanFile, [assistantLine({ id: "orphan1", timestamp: "2026-09-29T16:00:01.000Z" })]);
mkdirSync(tasksDir, { recursive: true });
writeFileSync(
	join(tasksDir, "mumuiuv4-2-gptu.json"),
	JSON.stringify({
		task: {
			id: "mumuiuv4-2-gptu",
			agent: "gentle-ai-verify",
			mode: "task",
			label: "verify I1 merge resolution",
			cwd: projectCwd,
			parentSessionId: PARENT_ID,
			status: "completed",
			createdAt: 1_790_696_604_352,
			startedAt: 1_790_696_604_418,
			endedAt: 1_790_696_875_433,
			model: "opencode-go/deepseek-v4.1-flash",
			thinking: "high",
			sessionPath: childFile,
			turns: 4,
			toolCalls: 9,
		},
		thread: { items: [] },
	}),
	"utf8",
);

test("parseTranscriptLine yields the canonical record with model, tokens, cost split and timestamp", () => {
	const context = { source: "parent" as const, sessionId: PARENT_ID, transcriptPath: parentFile };
	const result = parseTranscriptLine(JSON.stringify(assistantLine({ id: "a1", timestamp: "2026-09-29T19:52:32.384Z", thinkingLevel: "high", usage: FIRST_USAGE })), context);
	assert.equal(result.kind, "usage");
	if (result.kind !== "usage") return;
	const { record } = result;
	assert.equal(record.source, "parent");
	assert.equal(record.sessionId, PARENT_ID);
	assert.equal(record.transcriptPath, parentFile);
	assert.equal(record.model, "deepseek-v4.1-flash");
	assert.equal(record.provider, "opencode-go");
	assert.equal(record.effort, "high");
	assert.equal(record.timestamp, Date.parse("2026-09-29T19:52:32.384Z"));
	assert.deepEqual(record.tokens, { input: 18_856, output: 157, cacheRead: 2_048, cacheWrite: 0, reasoning: 55, total: 21_061 });
	assert.equal(sessionCostUsd(foldSessionCost([record.cost])), 0.002928744);
	assert.equal(record.costBreakdown?.input.state, "reported");
	assert.equal(record.costBreakdown?.cacheWrite.state, "reported");
	assert.equal(record.identified, true);
});

test("parseTranscriptLine classifies a non-usage line as skip and an unusable line as malformed", () => {
	const context = { source: "parent" as const, sessionId: PARENT_ID, transcriptPath: parentFile };
	assert.equal(parseTranscriptLine("", context).kind, "skip");
	assert.equal(parseTranscriptLine('{"type":"custom"}', context).kind, "skip");
	assert.equal(parseTranscriptLine('{"type":"message","message":{"role":"user"}}', context).kind, "skip");
	assert.equal(parseTranscriptLine('{"type":"message","message":{"role":"assistant"}}', context).kind, "skip");
	assert.equal(parseTranscriptLine("{not json", context).kind, "malformed");
	assert.equal(parseTranscriptLine("[]", context).kind, "malformed");
	assert.equal(parseTranscriptLine(JSON.stringify(assistantLine({ id: "x", timestamp: "not-a-date" })), context).kind, "malformed");
});

test("readTranscript yields one record per assistant message in file order and preserves provenance", async () => {
	const result = await readTranscript(parentFile, { source: "parent", sessionId: PARENT_ID });
	assert.equal(result.records.length, 2);
	assert.equal(result.malformedLines, 0);
	assert.equal(result.lines, PARENT_LINES.length);
	assert.deepEqual(result.records.map((record) => record.model), ["deepseek-v4.1-flash", "deepseek-v4.1-flash"]);
	assert.ok(result.records[0]!.timestamp < result.records[1]!.timestamp);
	assert.equal(result.records[0]!.stopReason, "toolUse");
	// The second message reported no cost at all; that is not a reported zero.
	assert.equal(result.records[1]!.cost.state, "absent");
	assert.equal(result.records[1]!.costBreakdown?.output.state, "absent");
});

test("malformed and partial lines are skipped and counted, and never throw", async () => {
	const file = join(root, "malformed.jsonl");
	writeLines(file, [
		assistantLine({ id: "ok1", timestamp: "2026-09-29T10:00:00.000Z" }),
		"{not json",
		"[]",
		'{"type":"custom"}',
		assistantLine({ id: "ok2", timestamp: "2026-09-29T10:01:00.000Z" }),
	]);
	// A partially written final line: no trailing newline, truncated JSON.
	writeFileSync(file, `${JSON.stringify(assistantLine({ id: "ok3", timestamp: "2026-09-29T10:02:00.000Z" }))}\n{"type":"message","message":{"role":"assistant","usage":{`, { flag: "a" });
	const result = await readTranscript(file, { source: "parent", sessionId: PARENT_ID });
	assert.equal(result.records.length, 3);
	assert.equal(result.malformedLines, 3, "two bad lines plus the partial tail");
	assert.equal(result.records[2]!.timestamp, Date.parse("2026-09-29T10:02:00.000Z"));
});

test("a child record joins its TaskRecord when present and stays identified=false when absent", async () => {
	const index = await loadTaskIdentityIndex(tasksDir);
	const identity = index.bySessionPath.get(childFile) ?? index.bySessionId.get(CHILD_ID);
	assert.equal(identity?.taskId, "mumuiuv4-2-gptu");
	assert.equal(identity?.agent, "gentle-ai-verify");
	assert.equal(identity?.status, "completed");
	assert.equal(identity?.turns, 4);
	assert.equal(identity?.toolCalls, 9);
	assert.equal(identity?.startedAt, 1_790_696_604_418);
	assert.equal(identity?.endedAt, 1_790_696_875_433);
	assert.equal(identity?.model, "opencode-go/deepseek-v4.1-flash");
	assert.equal(identity?.thinking, "high");

	const joined = await readTranscript(childFile, { source: "subagent", task: identity });
	assert.equal(joined.records[0]!.identified, true);
	assert.equal(joined.records[0]!.taskId, "mumuiuv4-2-gptu");
	assert.deepEqual(joined.records[0]!.task, identity);

	const orphan = await readTranscript(orphanFile, { source: "subagent" });
	assert.equal(orphan.records.length, 1);
	assert.equal(orphan.records[0]!.identified, false);
	assert.equal(orphan.records[0]!.taskId, undefined);
	assert.equal(orphan.records[0]!.source, "subagent");
});

test("listTranscriptFiles enumerates a project by date range in deterministic order", async () => {
	const all = await listTranscriptFiles({ agentHome, projectCwd, includeChildren: false });
	assert.deepEqual(all.map((ref) => ref.sessionId), [
		"01a00000-0000-7000-8000-000000000001",
		"01a00000-0000-7000-8000-000000000002",
		PARENT_ID,
	]);
	assert.deepEqual(all.map((ref) => ref.source), ["parent", "parent", "parent"]);

	const windowed = await listTranscriptFiles({
		agentHome,
		projectCwd,
		includeChildren: false,
		from: Date.parse("2026-09-24T00:00:00.000Z"),
		to: Date.parse("2026-09-29T19:50:33.038Z"),
	});
	assert.deepEqual(windowed.map((ref) => ref.sessionId), ["01a00000-0000-7000-8000-000000000002"]);

	// Re-listing is stable: same order, same timestamps.
	const again = await listTranscriptFiles({ agentHome, projectCwd, includeChildren: false });
	assert.deepEqual(again, all);
});

test("readSessionUsage merges parents and joined children with deterministic ordering", async () => {
	const result = await readSessionUsage({ agentHome, projectCwd });
	const parentRecords = result.records.filter((record) => record.source === "parent");
	const childRecords = result.records.filter((record) => record.source === "subagent");
	assert.equal(parentRecords.length, 4, "three parent sessions: two usage lines in one, one in each of the other two");
	assert.equal(childRecords.length, 2);
	assert.equal(childRecords.filter((record) => record.identified).length, 1);
	assert.equal(childRecords.find((record) => record.identified)?.taskId, "mumuiuv4-2-gptu");
	assert.equal(result.malformedLines, 0);
	// The streaming path is deterministic: same result and order on a second read.
	const again = await readSessionUsage({ agentHome, projectCwd });
	assert.deepEqual(again.records.map((record) => record.transcriptPath), result.records.map((record) => record.transcriptPath));
});

test("the reader's parent total aligns with the surface gentle-shell already reports", async () => {
	const result = await readTranscript(parentFile, { source: "parent", sessionId: PARENT_ID });
	const readerTotal = foldSessionCost(result.records.map((record) => record.cost));
	const surfaceTotal = sessionCostFromEntries(PARENT_LINES as readonly { type?: string; message?: { role?: string; usage?: { cost?: { total?: unknown } } } }[]);
	assert.deepEqual(readerTotal, surfaceTotal);
});

test("streamTranscript is lazy and the reader performs no filesystem writes", async () => {
	const before = readdirSync(root, { recursive: true }).sort();
	const generator = streamTranscript(join(root, "does-not-exist.jsonl"), { source: "parent", sessionId: PARENT_ID });
	assert.equal(typeof generator[Symbol.asyncIterator], "function");
	await assert.rejects(generator.next(), "the first iteration is where the I/O happens");

	const collected = await readTranscript(parentFile, { source: "parent", sessionId: PARENT_ID });
	const items: string[] = [];
	for await (const item of streamTranscript(parentFile, { source: "parent", sessionId: PARENT_ID })) items.push(item.kind);
	assert.equal(items.filter((kind) => kind === "usage").length, collected.records.length);
	const after = readdirSync(root, { recursive: true }).sort();
	assert.deepEqual(after, before, "reading a transcript writes nothing");
});

test("the exported task identity stays assignable to a plain child record", () => {
	const identity: TranscriptTaskIdentity = {
		taskId: "t1",
		agent: "explore",
		label: "l",
		status: "completed",
		turns: 0,
		toolCalls: 0,
		startedAt: null,
		endedAt: null,
		model: "m",
	};
	assert.equal(identity.startedAt, null);
});
