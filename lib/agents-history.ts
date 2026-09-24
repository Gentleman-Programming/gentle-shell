import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyThread, type TaskRecord, type TaskThread } from "./agents-protocol.ts";

// Gentle Agents history: one JSON file per finished task, written by the
// host after the child is gone and read back lazily when the overlay opens
// or a tool asks for a task from an earlier session. Everything is async so
// the terminal never waits on disk.

export interface StoredTask {
	task: TaskRecord;
	thread: TaskThread;
}

const FILE_SUFFIX = ".json";
const SAFE_ID = /^[a-z0-9-]+$/i;

export function historyDir(home: string, agentHome = join(home, ".pi", "agent")): string {
	return join(agentHome, "gentle-agents", "tasks");
}

function fileFor(dir: string, id: string): string {
	if (!SAFE_ID.test(id)) throw new Error(`invalid task id: ${id}`);
	return join(dir, `${id}${FILE_SUFFIX}`);
}

function isRecord(value: unknown): value is TaskRecord {
	const task = value as Partial<TaskRecord> | undefined;
	return typeof task?.id === "string" && typeof task.agent === "string" && typeof task.status === "string" && typeof task.createdAt === "number";
}

function parseStored(text: string): StoredTask | undefined {
	try {
		const parsed = JSON.parse(text) as Partial<StoredTask>;
		if (!isRecord(parsed.task)) return undefined;
		const thread = parsed.thread && Array.isArray(parsed.thread.items) ? parsed.thread : emptyThread();
		return { task: parsed.task, thread: { ...emptyThread(), ...thread } };
	} catch {
		return undefined;
	}
}

export async function saveTask(dir: string, task: TaskRecord, thread: TaskThread): Promise<void> {
	await mkdir(dir, { recursive: true });
	const target = fileFor(dir, task.id);
	const temp = `${target}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
	await writeFile(temp, JSON.stringify({ task, thread }), "utf8");
	await rename(temp, target);
}

export async function loadStoredTask(dir: string, id: string): Promise<StoredTask | undefined> {
	if (!SAFE_ID.test(id)) return undefined;
	try {
		return parseStored(await readFile(fileFor(dir, id), "utf8"));
	} catch {
		return undefined;
	}
}

async function listFiles(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((name) => name.endsWith(FILE_SUFFIX));
	} catch {
		return [];
	}
}

export async function loadHistory(dir: string): Promise<StoredTask[]> {
	const files = await listFiles(dir);
	const stored = await Promise.all(files.map(async (name) => parseStored(await readFile(join(dir, name), "utf8").catch(() => ""))));
	return stored.filter((entry): entry is StoredTask => entry !== undefined).sort((a, b) => b.task.createdAt - a.task.createdAt);
}

// Keep the newest `maxTasks` files; the rest go. Returns how many were removed.
export async function pruneHistory(dir: string, maxTasks: number): Promise<number> {
	const stored = await loadHistory(dir);
	// Preserve historical remediation payloads without interpreting or replaying their retired ledger.
	const extra = stored.filter(({ task }) => task.sddRemediation === undefined).slice(Math.max(0, maxTasks));
	await Promise.all(extra.map((entry) => rm(fileFor(dir, entry.task.id), { force: true })));
	return extra.length;
}
