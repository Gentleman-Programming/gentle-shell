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
export function agentStatus(input: Omit<AgentStatus, "schema" | "updatedAt">, now: number): AgentStatus {
	return { schema: "gentle-shell.agent-status/v1", ...input, updatedAt: new Date(now).toISOString() };
}

/** Private, best-effort store. No destination file is ever opened for writing. */
export function createAgentStatusStore(home: string, session: string) {
	const root = join(resolve(home), "agent-status");
	const path = join(root, `${createHash("sha256").update(session).digest("hex")}.json`);
	const owned = (stat: fs.Stats) => process.platform === "win32" || stat.uid === process.getuid?.();
	const directory = (create: boolean) => {
		// Validate ancestors before creation: recursive mkdir must not traverse links.
		const ensure = (dir: string): void => {
			try {
				const stat = fs.lstatSync(dir);
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe-directory");
			} catch (error) {
				if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				ensure(dirname(dir)); fs.mkdirSync(dir, { mode: 0o700 });
			}
			if (dirname(dir) !== dir) ensureExisting(dirname(dir));
		};
		const ensureExisting = (dir: string): void => {
			const stat = fs.lstatSync(dir);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe-directory");
			if (dirname(dir) !== dir) ensureExisting(dirname(dir));
		};
		// Ancestors are user-controlled (same model as orchestrator presence); still refuse a
		// foreign or world-writable config home, where another account could swap the root.
		const home = () => {
			const parent = fs.lstatSync(dirname(root));
			if (!owned(parent) || (process.platform !== "win32" && (parent.mode & 0o002) !== 0)) throw Error("unsafe-home");
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
