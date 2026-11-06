import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface AgentStatus {
	schema: "gentle-shell.agent-status/v1";
	agent: "gentle-shell" | "pi";
	session: string;
	pid: number;
	cwd: string;
	state: "working" | "blocked" | "idle";
	task: { title: string } | null;
	updatedAt: string;
}
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_MAX_BYTES = 64 * 1024;
export function agentStatus(input: Omit<AgentStatus, "schema" | "updatedAt">, now: number): AgentStatus {
	return { schema: "gentle-shell.agent-status/v1", ...input, updatedAt: new Date(now).toISOString() };
}

/** Private, best-effort store. No destination file is ever opened for writing. */
export function createAgentStatusStore(home: string, session: string) {
	const configHome = resolve(home);
	const root = join(configHome, "agent-status");
	const path = join(root, `${createHash("sha256").update(session).digest("hex")}.json`);
	const owned = (stat: fs.Stats) => process.platform === "win32" || stat.uid === process.getuid?.();
	const directory = (create: boolean) => {
		// Validate through the config home only; its ancestors are trusted.
		const ensure = (dir: string): void => {
			try {
				const stat = fs.lstatSync(dir);
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe-directory");
			} catch (error) {
				if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				if (dir === configHome) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
				else { ensure(dirname(dir)); fs.mkdirSync(dir, { mode: 0o700 }); }
			}
			if (dir !== configHome) ensureExisting(dirname(dir));
		};
		const ensureExisting = (dir: string): void => {
			const stat = fs.lstatSync(dir);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe-directory");
			if (dir !== configHome) ensureExisting(dirname(dir));
		};
		// Same trust boundary as orchestrator presence: refuse a foreign-owned or
		// group/other-writable config home, where another account could swap the root.
		const home = () => {
			const parent = fs.lstatSync(dirname(root));
			if (!parent.isDirectory() || parent.isSymbolicLink() || !owned(parent) || (process.platform !== "win32" && (parent.mode & 0o022) !== 0)) throw Error("unsafe-home");
		};
		try { home(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		ensure(root); home();
		const stat = fs.lstatSync(root);
		if (!owned(stat) || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw Error("not-private");
	};
	const regular = () => {
		try {
			const stat = fs.lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !owned(stat)) throw Error("unsafe-file");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	};
	// Probe a recorded owner PID: only ESRCH proves it dead; EPERM means alive.
	const gone = (pid: unknown) => {
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
		try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
		return false;
	};
	const orphaned = (value: { pid?: unknown; updatedAt?: unknown }) => {
		const updated = typeof value.updatedAt === "string" ? Date.parse(value.updatedAt) : Number.NaN;
		return (Number.isFinite(updated) && Date.now() - updated > ORPHAN_AGE_MS) || gone(value.pid);
	};
	// A crashed session leaves its file behind; a bounded startup sweep drops proven
	// orphans only. Unreadable, oversized, foreign, linked or unparsable files stay.
	const sweep = () => {
		let entries: string[];
		try { directory(false); entries = fs.readdirSync(root); } catch { return; }
		for (const entry of entries) {
			const candidate = join(root, entry);
			if (!entry.endsWith(".json") || candidate === path) continue;
			try {
				const stat = fs.lstatSync(candidate);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !owned(stat) || stat.size > ORPHAN_MAX_BYTES) continue;
				const value = JSON.parse(fs.readFileSync(candidate, "utf8")) as { pid?: unknown; updatedAt?: unknown } | null;
				if (typeof value !== "object" || value === null || !orphaned(value)) continue;
				fs.unlinkSync(candidate);
			} catch { /* Never touch what cannot be proven an orphan. */ }
		}
	};
	try { sweep(); } catch { /* The sweep never interrupts a session start. */ }
	return { path, write(value: AgentStatus): boolean {
		let temporary: string | undefined;
		try {
			directory(true); regular();
			const candidate = join(root, `.${randomUUID()}.tmp`);
			const fd = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
			temporary = candidate;
			try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); } finally { fs.closeSync(fd); }
			directory(false); regular(); fs.renameSync(temporary, path);
			temporary = undefined; return true;
		} catch { return false; }
		finally { if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Best effort. */ } } }
	}, remove(): void {
		try { directory(false); regular(); fs.unlinkSync(path); } catch { /* Missing, unsafe or unavailable. */ }
	} };
}
