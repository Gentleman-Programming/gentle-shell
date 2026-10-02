import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { aggregateStats, createStatsLoader, currentSessionStats, parseSessionLines, shiftDay, STATS_RANGE, STATS_SCOPE, weekdayOf, type StatsFilter } from "../lib/stats-collector.ts";
import { SESSION_CHANGE_ENTRY } from "../lib/session-changes.ts";

// The /gentle:stats collector: a streaming loader over Pi's session files and
// pure aggregation over the parsed records. Fixtures carry exact numbers so
// every figure the panel shows is pinned here.

const SESSIONS = fileURLToPath(new URL("./fixtures/stats/sessions", import.meta.url));
// A second home (the user's regular Pi) holding an OpenAI session and copies of aaa and bbb.
const USER_SESSIONS = fileURLToPath(new URL("./fixtures/stats/user-pi/sessions", import.meta.url));
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const filter = (overrides: Partial<StatsFilter> = {}): StatsFilter => ({ range: STATS_RANGE.ALL, scope: STATS_SCOPE.ALL, cwd: "/work/alpha", now: NOW, dayKey: utcDay, ...overrides });

test("loader reads top-level session files only and tolerates malformed lines", async () => {
	const sessions = await createStatsLoader().load([SESSIONS]);
	assert.deepEqual(sessions.map((session) => session.id).sort(), ["aaa", "bbb", "ccc", "ddd"]);
	const aaa = sessions.find((session) => session.id === "aaa")!;
	assert.equal(aaa.cwd, "/work/alpha");
	assert.equal(aaa.messages.length, 2);
	assert.deepEqual(aaa.messages[0], { timestamp: Date.parse("2026-09-28T10:01:00.000Z"), provider: "claude-bridge", model: "claude-opus-5-5", input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, total: 1350, cost: 0.5 });
	// Older usage without totalTokens falls back to the sum of its parts.
	assert.equal(sessions.find((session) => session.id === "ccc")!.messages[0].total, 1000);
	assert.equal(sessions.some((session) => session.messages.some((message) => message.model === "nested-model")), false);
});

test("loader returns nothing for a missing or empty sessions root", async () => {
	const loader = createStatsLoader();
	assert.deepEqual(await loader.load([join(tmpdir(), "gentle-stats-missing-root")]), []);
	assert.deepEqual(await loader.load([mkdtempSync(join(tmpdir(), "gentle-stats-empty-"))]), []);
	assert.deepEqual(await loader.load([]), []);
});

test("two roots combine into one history: OpenAI usage from the second root counts, duplicate session IDs count once", async () => {
	const sessions = await createStatsLoader().load([SESSIONS, USER_SESSIONS]);
	assert.deepEqual(sessions.map((session) => session.id).sort(), ["aaa", "bbb", "ccc", "ddd", "fff"]);
	const stats = aggregateStats(sessions, filter());
	assert.deepEqual(stats.totals, { input: 2810, output: 1840, cacheRead: 1000, cacheWrite: 200, total: 5850, cost: 3.85 });
	assert.deepEqual(stats.models.map(({ model, tokens, messages }) => [model, tokens, messages]), [["gpt-5.3-codex", 3000, 1], ["claude-opus-5-5", 1550, 4], ["gpt-5.5", 1000, 1], ["gpt-6.1-sol", 300, 1]]);
	assert.deepEqual(stats.days, { "2026-09-01": 1000, "2026-09-20": 3000, "2026-09-28": 1650, "2026-09-29": 30, "2026-09-30": 170 });
	assert.equal(stats.sessions, 4);
	const gamma = aggregateStats(sessions, filter({ scope: STATS_SCOPE.PROJECT, cwd: "/work/gamma" }));
	assert.deepEqual(gamma.models.map((model) => model.model), ["gpt-5.3-codex"]);
	assert.equal(gamma.totals.total, 3000);
});

test("a duplicate session keeps the copy with the most usage records, then the latest usage, whatever the root order", async () => {
	for (const roots of [[SESSIONS, USER_SESSIONS], [USER_SESSIONS, SESSIONS]]) {
		const sessions = await createStatsLoader().load(roots);
		// aaa: the active copy has 2 usage records, the user copy 1 → the active copy wins.
		assert.deepEqual(sessions.find((session) => session.id === "aaa")!.messages.map((message) => message.total), [1350, 300]);
		// bbb: the user copy has 3 usage records, the active copy 2 → the user copy wins.
		assert.deepEqual(sessions.find((session) => session.id === "bbb")!.messages.map((message) => message.total), [30, 70, 100]);
		assert.equal(sessions.filter((session) => session.id === "aaa" || session.id === "bbb").length, 2);
	}
	const root = mkdtempSync(join(tmpdir(), "gentle-stats-tie-"));
	const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-01T00:00:00.000Z", cwd: "/t" });
	const usage = (at: string, total: number) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", model: "m", usage: { output: total } } });
	const write = (dir: string, name: string, lines: string[]) => { mkdirSync(join(root, dir), { recursive: true }); writeFileSync(join(root, dir, name), `${lines.join("\n")}\n`); };
	write("a", "1_tie.jsonl", [header("tie"), usage("2026-09-01T00:01:00.000Z", 1)]);
	write("b", "2_tie.jsonl", [header("tie"), usage("2026-09-01T00:02:00.000Z", 2)]);
	// Equal record counts fall back to the latest usage timestamp.
	assert.deepEqual((await createStatsLoader().load([root])).map((session) => session.messages[0].total), [2]);
	// Headers without an ID are never merged with each other.
	write("a", "3_noid.jsonl", [JSON.stringify({ type: "session", version: 3, cwd: "/t" }), usage("2026-09-02T00:00:00.000Z", 5)]);
	write("b", "4_noid.jsonl", [JSON.stringify({ type: "session", version: 3, cwd: "/t" }), usage("2026-09-03T00:00:00.000Z", 7)]);
	assert.deepEqual((await createStatsLoader().load([root])).map((session) => session.messages[0].total).sort(), [2, 5, 7]);
});

test("alias roots (trailing slash, dot segments, symlinks) and missing roots never double count", async () => {
	const link = join(mkdtempSync(join(tmpdir(), "gentle-stats-alias-")), "sessions-link");
	symlinkSync(SESSIONS, link, "dir");
	const missing = join(tmpdir(), "gentle-stats-missing-root");
	const once = aggregateStats(await createStatsLoader().load([SESSIONS]), filter());
	const aliased = aggregateStats(await createStatsLoader().load([SESSIONS, `${SESSIONS}/`, join(SESSIONS, "..", "sessions"), link, missing]), filter());
	assert.deepEqual(aliased.totals, once.totals);
	assert.equal(aliased.sessions, 3);
});

test("parseSessionLines ignores files without a session header", () => {
	assert.equal(parseSessionLines(["garbage", "{\"type\":\"message\"}"]), undefined);
	const parsed = parseSessionLines([
		"{\"type\":\"session\",\"id\":\"x\",\"timestamp\":\"2026-09-01T00:00:00.000Z\",\"cwd\":\"/x\"}",
		"{\"type\":\"message\",\"timestamp\":\"2026-09-01T00:01:00.000Z\",\"message\":{\"role\":\"assistant\",\"model\":\"m\",\"usage\":{\"input\":\"bad\",\"output\":3}}}",
	]);
	assert.equal(parsed?.messages[0].input, 0);
	assert.equal(parsed?.messages[0].total, 3);
	assert.equal(parsed?.messages[0].provider, "unknown");
});

test("all-time stats across every project match the fixture exactly", async () => {
	const stats = aggregateStats(await createStatsLoader().load([SESSIONS]), filter());
	assert.deepEqual(stats.totals, { input: 810, output: 740, cacheRead: 1000, cacheWrite: 200, total: 2750, cost: 2.05 });
	assert.deepEqual(stats.models.map(({ model, tokens, messages }) => [model, tokens, messages]), [["claude-opus-5-5", 1450, 3], ["gpt-5.5", 1000, 1], ["gpt-6.1-sol", 300, 1]]);
	assert.equal(stats.models[0].cost.toFixed(2), "0.80");
	assert.equal(stats.models[0].share, 1450 / 2750);
	assert.deepEqual(stats.days, { "2026-09-01": 1000, "2026-09-28": 1650, "2026-09-29": 30, "2026-09-30": 70 });
	assert.equal(stats.sessions, 3);
	assert.equal(stats.activeDays, 4);
	assert.equal(stats.daysInRange, 31);
	assert.equal(stats.firstDay, "2026-09-01");
	assert.equal(stats.today, "2026-10-01");
	assert.deepEqual(stats.mostActiveDay, { day: "2026-09-28", tokens: 1650 });
	assert.deepEqual(stats.longestSession, { id: "bbb", durationMs: 2 * 60 * 60 * 1000 });
	assert.equal(stats.longestStreak, 3);
	assert.equal(stats.currentStreak, 3);
});

test("range filters count only messages inside the selected local days", async () => {
	const sessions = await createStatsLoader().load([SESSIONS]);
	const week = aggregateStats(sessions, filter({ range: STATS_RANGE.WEEK }));
	assert.equal(week.totals.total, 1750);
	assert.equal(week.totals.cost.toFixed(2), "1.05");
	assert.equal(week.sessions, 2);
	assert.equal(week.activeDays, 3);
	assert.equal(week.daysInRange, 7);
	assert.equal(week.firstDay, "2026-09-25");
	// 2026-09-01 sits one day before the 30-day window that ends today.
	const month = aggregateStats(sessions, filter({ range: STATS_RANGE.MONTH }));
	assert.equal(month.totals.total, 1750);
	assert.equal(month.daysInRange, 30);
	assert.equal(month.firstDay, "2026-09-02");
});

test("project scope keeps only sessions started in the current cwd", async () => {
	const stats = aggregateStats(await createStatsLoader().load([SESSIONS]), filter({ scope: STATS_SCOPE.PROJECT, cwd: "/work/beta" }));
	assert.equal(stats.totals.total, 1000);
	assert.equal(stats.sessions, 1);
	assert.equal(stats.longestStreak, 1);
	assert.equal(stats.currentStreak, 0);
	assert.deepEqual(stats.models.map((model) => model.model), ["gpt-5.5"]);
});

test("current streak survives an idle today but breaks after a missed day", () => {
	const session = (id: string, ...days: string[]) => ({
		id, cwd: "/x", startedAt: Date.parse(`${days[0]}T10:00:00.000Z`),
		messages: days.map((day) => ({ timestamp: Date.parse(`${day}T10:00:00.000Z`), provider: "p", model: "m", input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: 0 })),
	});
	const active = aggregateStats([session("a", "2026-09-29", "2026-09-30", "2026-10-01")], filter());
	assert.equal(active.currentStreak, 3);
	const broken = aggregateStats([session("a", "2026-09-28", "2026-09-29")], filter());
	assert.equal(broken.currentStreak, 0);
	assert.equal(broken.longestStreak, 2);
});

test("empty input aggregates to zeroes without throwing", () => {
	const stats = aggregateStats([], filter());
	assert.deepEqual(stats.totals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
	assert.deepEqual(stats.models, []);
	assert.equal(stats.sessions, 0);
	assert.equal(stats.activeDays, 0);
	assert.equal(stats.daysInRange, 1);
	assert.equal(stats.mostActiveDay, undefined);
	assert.equal(stats.longestSession, undefined);
	assert.equal(stats.longestStreak, 0);
	assert.equal(stats.currentStreak, 0);
});

test("day keys shift across month boundaries and report their weekday", () => {
	assert.equal(shiftDay("2026-10-01", -1), "2026-09-30");
	assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
	assert.equal(weekdayOf("2026-10-01"), 4); // Thursday
});

test("loader reuses unchanged files from its cache", async () => {
	const loader = createStatsLoader();
	const first = await loader.load([SESSIONS]);
	const second = await loader.load([SESSIONS]);
	assert.equal(first.find((session) => session.id === "aaa"), second.find((session) => session.id === "aaa"));
});

test("currentSessionStats summarizes the live session including captured line changes", () => {
	const entries = [
		{ type: "model_change", timestamp: "2026-10-01T11:00:00.000Z", provider: "claude-bridge", modelId: "claude-opus-5-5" },
		{ type: "message", timestamp: "2026-10-01T11:01:00.000Z", message: { role: "assistant", provider: "claude-bridge", model: "claude-opus-5-5", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, totalTokens: 135, cost: { total: 0.125 } } } },
		{ type: "message", timestamp: "2026-10-01T11:02:00.000Z", message: { role: "user", content: "x" } },
		{ type: "custom", customType: SESSION_CHANGE_ENTRY, timestamp: "2026-10-01T11:03:00.000Z", data: { sessionId: "live", evidence: { id: "e1", root: "/repo", path: "a.txt", before: { kind: "text", text: "a\nb\n" }, after: { kind: "text", text: "a\nc\nd\n" } } } },
	];
	const stats = currentSessionStats(entries, { sessionId: "live", now: Date.parse("2026-10-01T11:30:00.000Z") });
	assert.deepEqual(stats.totals, { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, total: 135, cost: 0.125 });
	assert.equal(stats.messages, 1);
	assert.equal(stats.model, "claude-opus-5-5");
	assert.equal(stats.durationMs, 30 * 60 * 1000);
	assert.deepEqual(stats.lines, { added: 2, removed: 1 });
	const empty = currentSessionStats([], { sessionId: "none", now: NOW });
	assert.equal(empty.durationMs, 0);
	assert.equal(empty.lines, undefined);
	assert.equal(empty.model, undefined);
});
