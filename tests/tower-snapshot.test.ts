import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { buildTowerSnapshot, nameSubagents, TOWER_SNAPSHOT_VERSION } from "../lib/tower-snapshot.ts";
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
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	const files = readdirSync(dir);
	assert.deepEqual(files, ["s-1.json"]);
	assert.equal(statSync(join(dir, "s-1.json")).mode & 0o777, 0o600);
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
