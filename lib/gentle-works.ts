import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { resolveGentlePiAgentHome } from "./agent-home.ts";
import {
	resolveCanonicalGitRepositoryIdentity,
	resolveCanonicalGitWorktreeRoot,
} from "./review-session-standing-permission.ts";

export type WorkStatus = "pending" | "in_progress" | "blocked" | "completed";
export interface WorkSession {
	id: string;
	file: string;
}
export interface WorkInput {
	title: string;
	objective: string;
	status: WorkStatus;
	summary: string;
	branch?: string;
	worktree?: string;
	session?: WorkSession;
	odd?: string;
}
export interface Work extends WorkInput {
	id: string;
	cloneIdentity: string;
	revision: number;
}
export interface WorkRegistry {
	revision: number;
	works: Work[];
}
export interface WorkContext {
	cloneIdentity: string;
	worktreeRoot: string;
	registryFile: string;
	lockFile: string;
}

// A narrow read boundary permits deterministic I/O-failure tests without changing writes.
export interface WorkReadIO {
	readRegistry(path: string): Promise<string>;
}
const defaultReadIO: WorkReadIO = { readRegistry: path => readFile(path, "utf8") };
const invalid = () => new Error("Invalid work data");
const plain = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number, empty = false): value is string =>
	typeof value === "string" && value.length <= max &&
	(empty || value.trim().length > 0) && !value.includes("\0");
const absolute = (value: unknown) =>
	text(value, 4096) && isAbsolute(value) && !/[\r\n]/.test(value);
const fields = ["title", "objective", "status", "summary", "branch", "worktree", "session", "odd"];

function validateInput(value: unknown): asserts value is WorkInput {
	if (
		!plain(value) || Object.keys(value).some(key => !fields.includes(key)) ||
		!text(value.title, 256) || !text(value.objective, 4096) ||
		!text(value.summary, 16384, true) ||
		!["pending", "in_progress", "blocked", "completed"].includes(value.status as string)
	) {
		throw invalid();
	}
	for (const key of ["branch", "odd"]) {
		if (key in value && !text(value[key], 4096)) throw invalid();
	}
	if ("worktree" in value && !absolute(value.worktree)) throw invalid();
	if (
		"session" in value && (
			!plain(value.session) || Object.keys(value.session).sort().join(",") !== "file,id" ||
			!text(value.session.id, 512) || !absolute(value.session.file)
		)
	) {
		throw invalid();
	}
}

export async function resolveWorkContext(
	cwd: string,
	agentHome = resolveGentlePiAgentHome(),
): Promise<WorkContext> {
	if (!absolute(agentHome)) throw new Error("Invalid work storage path");
	const [cloneIdentity, worktreeRoot] = await Promise.all([
		resolveCanonicalGitRepositoryIdentity(cwd),
		resolveCanonicalGitWorktreeRoot(cwd),
	]);
	if (!cloneIdentity || !worktreeRoot) throw new Error("Git work context unavailable");
	// An aliased agent home (e.g. a redirected profile folder) must resolve to the
	// same canonical path every time, or safePath's ancestor check below sees it
	// as an attacker-controlled symlink and the registry becomes unreachable.
	await mkdir(agentHome, { recursive: true, mode: 0o700 });
	const canonicalAgentHome = await realpath(agentHome);
	const registryFile = join(canonicalAgentHome, "gentle-works", cloneIdentity.slice(7), "registry.json");
	return { cloneIdentity, worktreeRoot, registryFile, lockFile: `${registryFile}.lock` };
}

function validateContext(context: WorkContext) {
	if (
		!/^sha256:[a-f0-9]{64}$/.test(context.cloneIdentity) || !absolute(context.registryFile) ||
		!absolute(context.worktreeRoot) || context.lockFile !== `${context.registryFile}.lock`
	) {
		throw new Error("Invalid work storage path");
	}
}

function missing(error: unknown) {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

// Check every ancestor, not only the leaf: a redirected storage directory is unsafe too.
async function safePath(path: string, directory = false): Promise<boolean> {
	const parent = dirname(path);
	if (parent !== path) await safePath(parent, true);
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
			throw new Error("Unsafe work registry path");
		}
		return true;
	} catch (error) {
		if (missing(error)) return false;
		throw error;
	}
}

export async function listWorks(
	context: WorkContext,
	io: WorkReadIO = defaultReadIO,
): Promise<WorkRegistry> {
	validateContext(context);
	if (!await safePath(context.registryFile)) return { revision: 0, works: [] };
	const raw = await io.readRegistry(context.registryFile);
	try {
		const data = JSON.parse(raw);
		if (
			!plain(data) || Object.keys(data).sort().join(",") !== "revision,version,works" ||
			data.version !== 1 || !Number.isSafeInteger(data.revision) ||
			(data.revision as number) < 0 || !Array.isArray(data.works)
		) {
			throw invalid();
		}
		const ids = new Set<string>();
		for (const work of data.works) {
			if (!plain(work)) throw invalid();
			const { id, cloneIdentity, revision, ...input } = work;
			validateInput(input);
			if (
				typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || ids.has(id) ||
				cloneIdentity !== context.cloneIdentity || !Number.isSafeInteger(revision) ||
				(revision as number) < 1 || (revision as number) > (data.revision as number)
			) {
				throw invalid();
			}
			ids.add(id);
		}
		if (data.works.reduce((sum: number, work: Work) => sum + work.revision, 0) !== data.revision) {
			throw invalid();
		}
		return { revision: data.revision as number, works: data.works as Work[] };
	} catch {
		throw new Error("Invalid work registry");
	}
}

// A holder that was killed leaves its lock behind. A mutation takes milliseconds, so a lock this old is
// probably abandoned. S4 forbids automatic destructive recovery, so name the file for manual removal instead.
const LOCK_STALE_MS = 60_000;

async function busyError(path: string): Promise<Error> {
	try {
		const info = await lstat(path);
		if (info.isFile() && Date.now() - info.mtimeMs >= LOCK_STALE_MS) {
			const seconds = Math.floor((Date.now() - info.mtimeMs) / 1000);
			return new Error(`Work registry lock is ${seconds}s old; if no other Shell is updating works, delete ${path}`);
		}
	} catch (error) {
		if (!missing(error)) throw error;
	}
	return new Error("Work registry busy");
}

async function mutate(
	context: WorkContext,
	change: (registry: WorkRegistry) => Work,
	io: WorkReadIO,
): Promise<Work> {
	validateContext(context);
	await safePath(dirname(context.registryFile), true);
	await mkdir(dirname(context.registryFile), { recursive: true, mode: 0o700 });
	let lock;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			lock = await open(context.lockFile, "wx", 0o600);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (attempt === 99) throw await busyError(context.lockFile);
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	}
	const temporary = `${context.registryFile}.${randomUUID()}.tmp`;
	let created = false;
	try {
		const registry = await listWorks(context, io);
		const work = change(registry);
		if (!Number.isSafeInteger(registry.revision + 1)) {
			throw new Error("Work registry revision exhausted");
		}
		registry.revision++;
		const file = await open(temporary, "wx", 0o600);
		created = true;
		try {
			await file.writeFile(JSON.stringify({ version: 1, ...registry }) + "\n");
			await file.sync();
		} finally {
			await file.close();
		}
		await safePath(context.registryFile);
		await rename(temporary, context.registryFile);
		created = false;
		return work;
	} finally {
		try {
			if (created) await unlink(temporary);
		} finally {
			try {
				await lock!.close();
			} finally {
				await unlink(context.lockFile);
			}
		}
	}
}

export async function createWork(
	context: WorkContext,
	input: WorkInput,
	io: WorkReadIO = defaultReadIO,
): Promise<Work> {
	validateInput(input);
	// Snapshot caller-owned objects before the first await.
	const snapshot = structuredClone(input);
	return mutate(context, registry => {
		const work: Work = {
			...snapshot, id: randomUUID(), cloneIdentity: context.cloneIdentity, revision: 1,
		};
		registry.works.push(work);
		return work;
	}, io);
}

export async function updateWork(
	context: WorkContext,
	id: string,
	patch: Partial<WorkInput>,
	io: WorkReadIO = defaultReadIO,
): Promise<Work> {
	if (!plain(patch) || Object.keys(patch).some(key => !fields.includes(key))) throw invalid();
	const snapshot = structuredClone(patch);
	return mutate(context, registry => {
		const index = registry.works.findIndex(work => work.id === id);
		if (index < 0) throw new Error("Work not found");
		const previous = registry.works[index];
		const { id: _id, cloneIdentity: _clone, revision: _revision, ...input } = previous;
		const changed = { ...input, ...snapshot };
		validateInput(changed);
		const work = {
			...changed, id: previous.id, cloneIdentity: previous.cloneIdentity,
			revision: previous.revision + 1,
		};
		registry.works[index] = work;
		return work;
	}, io);
}
