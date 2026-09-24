import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { historyDir, loadHistory, loadStoredTask, pruneHistory, saveTask } from "../lib/agents-history.ts";
import { applyTaskEvent, emptyThread, TASK_EVENT, TASK_STATUS, TaskStore, type TaskRecord } from "../lib/agents-protocol.ts";

// Gentle Agents history: JSON per task, async, lazy, pruned by count.

const root = mkdtempSync(join(tmpdir(), "gentle-agents-history-"));
after(() => rmSync(root, { recursive: true, force: true }));
const dir = join(root, "tasks");

function task(id: string, createdAt: number): TaskRecord {
	return { id, agent: "explore", mode: "task", prompt: "p", label: "p", cwd: "/r", parentSessionId: "s", status: TASK_STATUS.COMPLETED, createdAt, startedAt: createdAt, endedAt: createdAt + 5, model: "m", thinking: undefined, sessionPath: null, error: null, result: "ok", lastStep: "done", lastActivityAt: createdAt, turns: 1, toolCalls: 0, tokens: 10, cost: 0.01 };
}

test("historyDir follows an isolated agent profile while explicit homes retain the default fallback", () => {
	assert.equal(historyDir("/home/x", "/profiles/pi-principal/agent"), join("/profiles/pi-principal/agent", "gentle-agents", "tasks"));
	assert.equal(historyDir("/home/x", "/profiles/pi-lab/agent"), join("/profiles/pi-lab/agent", "gentle-agents", "tasks"));
	assert.equal(historyDir("/home/x"), join("/home/x", ".pi", "agent", "gentle-agents", "tasks"));
});

test("saveTask writes a task with its thread and loadStoredTask reads it back", async () => {
	const thread = applyTaskEvent(emptyThread(), { type: TASK_EVENT.TEXT, text: "hello" });
	await saveTask(dir, task("a1", 1000), thread);
	const stored = await loadStoredTask(dir, "a1");
	assert.equal(stored?.task.result, "ok");
	assert.deepEqual(stored?.thread.items, [{ kind: "text", text: "hello" }]);
	assert.equal(await loadStoredTask(dir, "missing"), undefined);
	assert.equal(await loadStoredTask(dir, "../etc/passwd"), undefined);
	assert.deepEqual(readdirSync(dir), ["a1.json"], "no temp file is left behind");
});

test("loadHistory skips broken files, sorts newest first, and pruneHistory keeps the newest N", async () => {
	await saveTask(dir, task("b2", 3000), emptyThread());
	await saveTask(dir, task("c3", 2000), emptyThread());
	writeFileSync(join(dir, "junk.json"), "{not json");
	writeFileSync(join(dir, "shape.json"), JSON.stringify({ task: { id: 1 } }));
	assert.deepEqual((await loadHistory(dir)).map((entry) => entry.task.id), ["b2", "c3", "a1"]);
	assert.equal(await pruneHistory(dir, 2), 1);
	assert.deepEqual((await loadHistory(dir)).map((entry) => entry.task.id), ["b2", "c3"]);
	assert.deepEqual(await loadHistory(join(root, "nowhere")), []);
});

test("TaskStore.restore adds a stored task without clobbering a live one", () => {
	const store = new TaskStore();
	const thread = applyTaskEvent(emptyThread(), { type: TASK_EVENT.NOTE, text: "restored" });
	assert.equal(store.restore(task("r1", 1000), thread), true);
	assert.equal(store.thread("r1").items.length, 1);
	assert.equal(store.restore({ ...task("r1", 1000), result: "other" }, emptyThread()), false);
	assert.equal(store.get("r1")?.result, "ok");
});

test("retired remediation payloads remain readable and are never automatically pruned or replayed", async () => {
	const legacyDir = join(root, "legacy-remediation");
	const legacy = { ...task("legacy", 1), sddRemediation: { acquire: { requestId: "old" }, token: "historical", settlement: { state: "complete" } } };
	await saveTask(legacyDir, legacy, emptyThread());
	const before = readFileSync(join(legacyDir, "legacy.json"), "utf8");
	assert.equal(await pruneHistory(legacyDir, 0), 0);
	assert.deepEqual((await loadStoredTask(legacyDir, "legacy"))?.task, JSON.parse(before).task);
	assert.equal(readFileSync(join(legacyDir, "legacy.json"), "utf8"), before);
});
