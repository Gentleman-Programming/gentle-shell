import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { buildTowerSnapshot, chatFromBranch, nameSubagents, TOWER_CHAT_TEXT_MAX, TOWER_CHAT_TURNS, TOWER_SNAPSHOT_VERSION } from "../lib/tower-snapshot.ts";
import { readTowerSnapshots, removeTowerSnapshot, TOWER_SNAPSHOT_MAX_BYTES, writeTowerSnapshot } from "../lib/tower-hub.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function scratch(): string {
	const r = mkdtempSync(join(tmpdir(), "gentle-tower-"));
	roots.push(r);
	return join(r, "hub");
}

const base = {
	sessionId: "s-1",
	sessionName: "Token refresh fix",
	cwd: "/Users/me/work/gentle-ai",
	modelId: "claude-opus-5-5",
	effort: "high",
	context: { percent: 38, contextWindow: 200000 },
	stats: { cost: 0.42, input: 121000, output: 9800 },
	todos: [
		{ id: 1, title: "Reproduce with a failing test", status: "done" as const },
		{ id: 2, title: "Retry once when the refresh fails", status: "blocked" as const, note: "waiting for your answer" },
	],
	agents: [
		{ id: "t1", agent: "gentle-ai-worker", status: "running", lastStep: "editing", usage: { total: 1200, cost: 0.03 } },
		{ id: "t2", agent: "gentle-ai-explore", status: "completed", lastStep: "done", usage: { total: 800, cost: 0.01 } },
	],
	phase: "implementing",
	now: 1700000000000,
};

test("snapshot maps the live session data the tower shows", () => {
	const s = buildTowerSnapshot(base);
	assert.equal(s.version, TOWER_SNAPSHOT_VERSION);
	assert.equal(s.sessionId, "s-1");
	assert.equal(s.name, "Token refresh fix");
	assert.deepEqual(s.project, { cwd: "/Users/me/work/gentle-ai", name: "gentle-ai" });
	assert.equal(s.model, "claude-opus-5-5");
	assert.equal(s.effort, "high");
	assert.deepEqual(s.context, { percent: 38, window: 200000 });
	assert.deepEqual(s.cost, { total: 0.42, input: 121000, output: 9800 });
	assert.deepEqual(s.todos, [
		{ id: 1, title: "Reproduce with a failing test", status: "done" },
		{ id: 2, title: "Retry once when the refresh fails", status: "blocked", note: "waiting for your answer" },
	]);
	assert.deepEqual(s.subagents.map((a) => [a.name, a.role, a.status, a.lastStep, a.cost]), [
		["worker", "worker", "running", "editing", 0.03],
		["explore", "explore", "completed", "done", 0.01],
	]);
	assert.equal(s.phase, "implementing");
	assert.equal(s.updatedAt, 1700000000000);
});

test("snapshot falls back when the session has no name, model or context yet", () => {
	const s = buildTowerSnapshot({ ...base, sessionName: undefined, modelId: undefined, effort: undefined, context: undefined, todos: [], agents: [], phase: undefined });
	assert.equal(s.name, "gentle-ai");
	assert.equal(s.model, "no-model");
	assert.equal(s.effort, undefined);
	assert.deepEqual(s.context, { percent: null, window: 0 });
	assert.deepEqual(s.todos, []);
	assert.deepEqual(s.subagents, []);
	assert.equal(s.phase, undefined);
});

test("subagents are named by role, with a task word only when a role repeats", () => {
	const named = nameSubagents([
		{ id: "a", agent: "gentle-ai-worker", label: "write the session tests" },
		{ id: "b", agent: "gentle-ai-worker", label: "Change session.go" },
		{ id: "c", agent: "gentle-ai-explore" },
		{ id: "d", agent: "gentle-ai-verify" },
		{ id: "e", agent: "gentle-ai-verify" },
	]);
	assert.deepEqual(named.map((n) => n.name), ["worker-session", "worker-change", "explore", "verify-d", "verify-e"]);
	assert.deepEqual(named.map((n) => n.role), ["worker", "worker", "explore", "verify", "verify"]);
});

test("the hub writes atomically with private permissions and reads every session back", () => {
	const dir = scratch();
	const s = buildTowerSnapshot(base);
	writeTowerSnapshot(dir, s);
	writeTowerSnapshot(dir, { ...s, name: "renamed" });
	// Windows has no POSIX file modes (stat reports 0o666), so only POSIX checks them.
	const posix = process.platform !== "win32";
	if (posix) assert.equal(statSync(dir).mode & 0o777, 0o700);
	const files = readdirSync(dir);
	assert.deepEqual(files, ["s-1.json"]);
	if (posix) assert.equal(statSync(join(dir, "s-1.json")).mode & 0o777, 0o600);
	assert.deepEqual(readTowerSnapshots(dir).map((x) => x.name), ["renamed"]);
	removeTowerSnapshot(dir, "s-1");
	assert.deepEqual(readdirSync(dir), []);
	assert.deepEqual(readTowerSnapshots(dir), []);
});

test("an oversized snapshot is refused and the stored one stays unchanged", () => {
	const dir = scratch();
	const s = buildTowerSnapshot(base);
	writeTowerSnapshot(dir, s);
	const before = readFileSync(join(dir, "s-1.json"), "utf8");
	const huge = { ...s, name: "x".repeat(TOWER_SNAPSHOT_MAX_BYTES) };
	assert.throws(() => writeTowerSnapshot(dir, huge), /too large/);
	assert.equal(readFileSync(join(dir, "s-1.json"), "utf8"), before);
	assert.deepEqual(readdirSync(dir), ["s-1.json"]);
});

test("unsafe session ids never become file names", () => {
	const dir = scratch();
	assert.throws(() => writeTowerSnapshot(dir, { ...buildTowerSnapshot(base), sessionId: "../escape" }), /session id/);
	assert.throws(() => removeTowerSnapshot(dir, "../escape"), /session id/);
});

test("reading skips files that are not valid snapshots", () => {
	const dir = scratch();
	writeTowerSnapshot(dir, buildTowerSnapshot(base));
	writeFileSync(join(dir, "junk.json"), "{not json", { mode: 0o600 });
	writeFileSync(join(dir, "old.json"), JSON.stringify({ version: 0 }), { mode: 0o600 });
	assert.deepEqual(readTowerSnapshots(dir).map((x) => x.sessionId), ["s-1"]);
});

test("a session with huge history still publishes a snapshot within the hub limit, marking what it left out", () => {
	const dir = scratch();
	const long = (c: string, n: number) => c.repeat(n);
	const huge = buildTowerSnapshot({
		...base,
		sessionName: long("n", 5000),
		cwd: `/w/${long("d", 5000)}`,
		todos: Array.from({ length: 600 }, (_, i) => ({ id: i + 1, title: long("t", 2000), status: (i % 2 ? "pending" : "done") as "pending" | "done", note: long("漢", 1500) })),
		agents: Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, agent: "gentle-ai-worker", label: long("l", 500), status: "running", lastStep: long("s", 3000), usage: { total: 1, cost: 0 } })),
		said: long("w", 10000),
		models: Array.from({ length: 300 }, (_, i) => ({ model: `${long("m", 2000)}${i}`, cost: 1, tokens: 1 })),
		artifacts: Array.from({ length: 50 }, (_, i) => ({ path: `/${long("p", 3000)}${i}.md`, kind: "doc" as const })),
	});
	assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= TOWER_SNAPSHOT_MAX_BYTES, `snapshot is ${Buffer.byteLength(JSON.stringify(huge))} bytes`);
	writeTowerSnapshot(dir, huge);
	const [back] = readTowerSnapshots(dir);
	assert.equal(back.sessionId, "s-1");
	assert.ok(back.name.length <= 200 && back.name.endsWith("…"));
	assert.ok(back.todos.length > 0 && back.todos.length < 600);
	assert.ok(back.subagents.length > 0);
	assert.ok(back.said!.length <= 600);
	assert.ok((back.omitted?.todos ?? 0) > 0, "the snapshot says tasks were left out");
	// The next update of the same session still publishes.
	writeTowerSnapshot(dir, { ...huge, name: "renamed" });
	assert.equal(readTowerSnapshots(dir)[0].name, "renamed");
});

test("a long project folder is kept whole, so New floor launches in the real folder", () => {
	const cwd = `/w/${"d".repeat(3000)}/project`;
	const s = buildTowerSnapshot({ ...base, cwd, sessionName: undefined });
	assert.equal(s.project.cwd, cwd);
	assert.equal(s.project.name, "project");
	// Even when everything else must shrink to fit, the folder stays whole.
	const huge = buildTowerSnapshot({
		...base,
		cwd,
		todos: Array.from({ length: 600 }, (_, i) => ({ id: i + 1, title: "t".repeat(2000), status: "pending" as const })),
		artifacts: Array.from({ length: 12 }, (_, i) => ({ path: `/a/${"p".repeat(3000)}${i}.md`, kind: "doc" as const })),
	});
	assert.equal(huge.project.cwd, cwd);
	assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= TOWER_SNAPSHOT_MAX_BYTES);
	assert.ok((huge.omitted?.todos ?? 0) > 0);
});

test("artifact paths are never cut: a path too long to carry leaves the artifact out and counts it", () => {
	const kept = `/a/${"p".repeat(2000)}/notes.md`;
	const tooLong = `/a/${"q".repeat(5000)}/plan.md`;
	const s = buildTowerSnapshot({ ...base, artifacts: [{ path: tooLong, kind: "doc" }, { path: kept, kind: "doc" }, { path: "/a/short.md", kind: "doc" }] });
	assert.deepEqual(s.artifacts, [{ path: kept, kind: "doc" }, { path: "/a/short.md", kind: "doc" }]);
	assert.deepEqual(s.omitted, { artifacts: 1 });
	assert.ok(s.artifacts!.every((a) => !a.path.endsWith("…")));
});

test("a normal snapshot carries no omission marker", () => {
	assert.equal(buildTowerSnapshot(base).omitted, undefined);
});

// ---------- the intercom conversation ----------
const msg = (role: string, content: unknown, timestamp: number, extra: Record<string, unknown> = {}) => ({ type: "message", message: { role, content, timestamp, ...extra } });

test("the conversation keeps the visible turns in order: your words and the agent's visible text", () => {
	const chat = chatFromBranch([
		msg("user", "what did you do?", 1),
		msg("assistant", [{ type: "thinking", thinking: "secret plan" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }], 2),
		msg("toolResult", [{ type: "text", text: "file body" }], 3, { toolCallId: "c1", toolName: "read" }),
		msg("assistant", [{ type: "text", text: "I fixed the refresh." }, { type: "toolCall", id: "c2", name: "bash", arguments: {} }], 4),
		msg("custom", "injected reminder", 5, { customType: "gentle-todo-reminder", display: false }),
		{ type: "custom_message", customType: "note", content: "hidden note", display: false, timestamp: "1970-01-01T00:00:00.006Z" },
		msg("user", "[System-generated wake] a helper finished", 7),
		msg("user", [{ type: "text", text: "and the docs?" }, { type: "image", data: "x", mimeType: "image/png" }], 8),
		msg("assistant", [{ type: "text", text: "  " }], 9),
		msg("assistant", [{ type: "text", text: "Updated them too." }], 10),
	]);
	assert.deepEqual(chat, [
		{ role: "you", text: "what did you do?", at: 1 },
		{ role: "agent", text: "I fixed the refresh.", at: 4 },
		{ role: "you", text: "and the docs?", at: 8 },
		{ role: "agent", text: "Updated them too.", at: 10 },
	]);
});

test("the conversation keeps only the latest turns, each bounded", () => {
	const entries = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? "assistant" : "user", i % 2 ? [{ type: "text", text: `reply ${i} ${"r".repeat(5000)}` }] : `ask ${i}`, 100 + i));
	const chat = chatFromBranch(entries);
	assert.equal(chat.length, TOWER_CHAT_TURNS);
	assert.equal(chat[0].at, 100 + 30 - TOWER_CHAT_TURNS);
	assert.equal(chat.at(-1)!.at, 129);
	for (const t of chat) assert.ok(t.text.length <= TOWER_CHAT_TEXT_MAX, `turn of ${t.text.length} chars`);
	assert.ok(chat.at(-1)!.text.endsWith("…"));
	// The snapshot applies the same bounds to whatever it is given.
	const s = buildTowerSnapshot({ ...base, chat: Array.from({ length: 20 }, (_, i) => ({ role: "agent" as const, text: "z".repeat(3000), at: i })) });
	assert.equal(s.chat!.length, TOWER_CHAT_TURNS);
	assert.equal(s.chat![0].at, 20 - TOWER_CHAT_TURNS);
	assert.ok(s.chat!.every((t) => t.text.length <= TOWER_CHAT_TEXT_MAX));
});

test("a session with no conversation carries no chat, and the latest words stay for older views", () => {
	const s = buildTowerSnapshot({ ...base, said: "hello" });
	assert.equal(s.chat, undefined);
	assert.equal(s.said, "hello");
});

test("when the snapshot is too large the oldest chat turns go first, before any task", () => {
	const chat = Array.from({ length: TOWER_CHAT_TURNS }, (_, i) => ({ role: (i % 2 ? "agent" : "you") as "agent" | "you", text: `${i}:${"漢".repeat(TOWER_CHAT_TEXT_MAX)}`, at: i }));
	const todos = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, title: "t".repeat(60), status: "done" as const, note: "n".repeat(60) }));
	const s = buildTowerSnapshot({ ...base, todos, chat });
	assert.ok(Buffer.byteLength(JSON.stringify(s)) <= TOWER_SNAPSHOT_MAX_BYTES);
	assert.ok(s.chat!.length > 0 && s.chat!.length < TOWER_CHAT_TURNS, `kept ${s.chat!.length} turns`);
	assert.deepEqual(s.chat!.map((t) => t.at), chat.slice(-s.chat!.length).map((t) => t.at), "the newest turns stay");
	assert.equal(s.omitted?.chat, TOWER_CHAT_TURNS - s.chat!.length);
	assert.equal(s.todos.length, 200, "no task was dropped");
	assert.ok(s.todos.every((t) => t.note), "no task note was dropped");
});
