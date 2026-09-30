import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readTranscript } from "../lib/session-transcript.ts";
import { foldSessionCost } from "../lib/session-usage.ts";
import {
	appendUsageRecords,
	pruneStore,
	readUsageRecords,
	statisticsStoreDir,
	statisticsStoreEnabled,
	statisticsStoreFile,
	usageLineFromRecord,
	type StoreEnv,
} from "../lib/session-store.ts";
import type { TranscriptUsageRecord } from "../lib/session-transcript.ts";

// I6: the local, opt-in statistics store. Nothing is ever sent, nothing private
// is ever written, retention is bounded and never drops the active session, and
// a written record reads back through I3's parser with identical numbers.

const root = mkdtempSync(join(tmpdir(), "gentle-store-"));
after(() => rmSync(root, { recursive: true, force: true }));
const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function record(sessionId: string, timestamp: number, nanoUsd: number, overrides: Partial<TranscriptUsageRecord> = {}): TranscriptUsageRecord {
	return {
		source: "parent",
		sessionId,
		timestamp,
		model: "deepseek-v4.1-flash",
		provider: "opencode-go",
		tokens: { input: 100, output: 40, cacheRead: 30, cacheWrite: 5, reasoning: 8, total: 175 },
		cost: { state: "reported", nanoUsd },
		costBreakdown: {
			input: { state: "reported", nanoUsd: nanoUsd / 2 },
			output: { state: "reported", nanoUsd: nanoUsd / 2 },
			cacheRead: { state: "absent" },
			cacheWrite: { state: "reported", nanoUsd: 0 },
		},
		transcriptPath: "/transcripts/session.jsonl",
		identified: true,
		...overrides,
	};
}

function writeTranscript(file: string, lines: readonly unknown[]): void {
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

test("statisticsStoreEnabled honors the opt-outs and the documented preference", () => {
	assert.equal(statisticsStoreEnabled({}), true);
	assert.equal(statisticsStoreEnabled({ DO_NOT_TRACK: "0", CI: "false" }), true);
	for (const env of [{ DO_NOT_TRACK: "1" }, { DO_NOT_TRACK: "yes" }, { CI: "true" }, { GITHUB_ACTIONS: "1" }, { GENTLE_STATISTICS_STORE: "0" }, { GENTLE_STATISTICS_STORE: "off" }] as StoreEnv[]) {
		assert.equal(statisticsStoreEnabled(env), false, JSON.stringify(env));
	}
	// Unknown nonempty spellings veto, never weaken a veto.
	assert.equal(statisticsStoreEnabled({ DO_NOT_TRACK: "whatever" }), false);
	assert.equal(statisticsStoreEnabled({ GENTLE_STATISTICS_STORE: "on" }), true);
});

test("the store lives in its own namespace under the agent home", () => {
	assert.equal(statisticsStoreDir("/agent"), join("/agent", "gentle-statistics"));
	assert.equal(statisticsStoreFile("/agent"), join("/agent", "gentle-statistics", "usage.jsonl"));
});

test("the line allowlist cannot carry prompt, response, path or raw error fields", () => {
	const withPrivate = {
		...record("s1", BASE, 1_000_000),
		prompt: "SECRET_PROMPT",
		response: "SECRET_RESPONSE",
		path: "/secret/path.ts",
		error: "SECRET_RAW_ERROR",
	} as unknown as TranscriptUsageRecord;
	const line = usageLineFromRecord(withPrivate);
	const serialized = JSON.stringify(line);
	for (const secret of ["SECRET_PROMPT", "SECRET_RESPONSE", "/secret/path.ts", "SECRET_RAW_ERROR"]) {
		assert.equal(serialized.includes(secret), false, `the line must not carry ${secret}`);
	}
	for (const key of ["prompt", "response", "path", "error"]) {
		assert.equal(key in (line as object), false, `the line must not have a ${key} field`);
	}
	assert.deepEqual(Object.keys(line).sort(), ["message", "sessionId", "source", "timestamp", "type", "version"]);
});

test("a written record round-trips through I3's reader with identical numbers", async () => {
	const transcript = join(root, "session.jsonl");
	writeTranscript(transcript, [
		{ type: "session", id: "s1", timestamp: new Date(BASE).toISOString() },
		{ type: "message", timestamp: new Date(BASE + 1000).toISOString(), message: { role: "assistant", model: "m1", provider: "p1", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: 18, cost: { input: 0.00001, output: 0.00002, cacheRead: 0.000003, cacheWrite: 0, total: 0.000033 } } } },
		{ type: "message", timestamp: new Date(BASE + 2000).toISOString(), message: { role: "assistant", model: "m1", provider: "p1", usage: { input: 20, output: 8, cacheRead: 4, cacheWrite: 0, reasoning: 1, totalTokens: 32, cost: {} } } },
	]);
	const source = await readTranscript(transcript, { source: "parent", sessionId: "s1" });
	assert.equal(source.records.length, 2);

	const file = join(root, "roundtrip", "usage.jsonl");
	assert.equal(await appendUsageRecords(file, source.records), 2);

	const stored = await readUsageRecords(file);
	assert.equal(stored.lines, 2);
	assert.equal(stored.malformedLines, 0);
	assert.deepEqual(
		stored.records.map((entry) => ({ timestamp: entry.timestamp, model: entry.model, tokens: entry.tokens, cost: entry.cost, costBreakdown: entry.costBreakdown, source: entry.source, sessionId: entry.sessionId })),
		source.records.map((entry) => ({ timestamp: entry.timestamp, model: entry.model, tokens: entry.tokens, cost: entry.cost, costBreakdown: entry.costBreakdown, source: entry.source, sessionId: entry.sessionId })),
	);
	// The numbers the module reports are identical too.
	assert.deepEqual(foldSessionCost(stored.records.map((entry) => entry.cost)), foldSessionCost(source.records.map((entry) => entry.cost)));
});

test("a store line is parseable by I3's parseTranscriptLine as-is", async () => {
	const file = join(root, "parseable", "usage.jsonl");
	await appendUsageRecords(file, [record("s1", BASE, 1_234_567)]);
	const line = readFileSync(file, "utf8").trim();
	const { parseTranscriptLine } = await import("../lib/session-transcript.ts");
	const result = parseTranscriptLine(line, { source: "parent", sessionId: "s1", transcriptPath: file });
	assert.equal(result.kind, "usage");
	if (result.kind === "usage") {
		assert.equal(result.record.cost.state, "reported");
		assert.equal(result.record.model, "deepseek-v4.1-flash");
	}
});

test("opt-out leaves no file behind and does not throw", async () => {
	const file = join(root, "opted-out", "usage.jsonl");
	assert.equal(await appendUsageRecords(file, [record("s1", BASE, 1_000_000)], { env: { DO_NOT_TRACK: "1" } }), 0);
	assert.equal(existsSync(file), false);
	assert.equal(existsSync(join(root, "opted-out")), false);
	assert.equal(await appendUsageRecords(file, [record("s1", BASE, 1_000_000)], { env: { CI: "true" } }), 0);
	assert.equal(existsSync(join(root, "opted-out")), false);
});

test("a write failure is silent and never surfaces", async () => {
	const blocker = join(root, "blocker");
	writeFileSync(blocker, "not a directory", "utf8");
	const file = join(blocker, "usage.jsonl");
	assert.equal(await appendUsageRecords(file, [record("s1", BASE, 1_000_000)]), 0);
	assert.equal(existsSync(file), false);
});

test("retention prunes oldest-first by count and never removes the active session", async () => {
	const file = join(root, "retention", "usage.jsonl");
	const records = ["s0", "s1", "s2", "s3", "s4", "s5"].map((sessionId, index) => record(sessionId, BASE + index * 1000, 1_000_000));
	await appendUsageRecords(file, records);
	assert.equal(await pruneStore(file, { maxRecords: 3, maxAgeMs: Number.POSITIVE_INFINITY, activeSessionId: "s0" }), 3);
	const kept = await readUsageRecords(file);
	assert.deepEqual(kept.records.map((entry) => entry.sessionId), ["s0", "s4", "s5"], "the active session plus the two newest survive");

	// An active session survives even when it is the oldest and far past the bound.
	assert.equal(await pruneStore(file, { maxRecords: 1, maxAgeMs: 0, activeSessionId: "s0", now: () => BASE + 1000 * DAY }), 2);
	const after = await readUsageRecords(file);
	assert.deepEqual(after.records.map((entry) => entry.sessionId), ["s0"]);
});

test("retention prunes by age and leaves newer records alone", async () => {
	const file = join(root, "age", "usage.jsonl");
	await appendUsageRecords(file, [record("old", BASE, 1_000_000), record("new", BASE + 30 * DAY, 2_000_000)]);
	assert.equal(await pruneStore(file, { maxRecords: 1000, maxAgeMs: 10 * DAY, now: () => BASE + 31 * DAY }), 1);
	const kept = await readUsageRecords(file);
	assert.deepEqual(kept.records.map((entry) => entry.sessionId), ["new"]);
	assert.equal(await pruneStore(file, { maxRecords: 1000, maxAgeMs: 10 * DAY, now: () => BASE + 31 * DAY }), 0, "a second prune removes nothing");
});

test("no code path of the store can reach the network", () => {
	const source = readFileSync(fileURLToPath(new URL("../lib/session-store.ts", import.meta.url)), "utf8");
	for (const forbidden of ["node:http", "node:https", "node:net", "node:dns", "node:tls", "fetch(", "XMLHttpRequest", "WebSocket", "http.request", "https.request"]) {
		assert.equal(source.includes(forbidden), false, `session-store.ts must not reference ${forbidden}`);
	}
});
