// Where a session's desktop snapshot lives and how it is replaced: one file
// per session under `<agentDir>/desktop/sessions/<sessionId>.json`, written
// atomically (exclusive temp file in the same directory, then rename) so a
// reader never sees half a document. Same trust rules as the agent-status
// store (lib/agent-status.ts): private directories, 0600 files, no symlinks,
// and failures never reach Pi.

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_MAX_ENTRIES = 256;
const SWEEP_MAX_BYTES = 2 * 1024 * 1024;

export function desktopFeedDirectory(agentDir: string): string {
	return join(agentDir, "desktop", "sessions");
}

/** The session's name on disk: the id when it is a plain name, else its SHA-256 (never escapes a folder). */
export function desktopFeedName(sessionId: string): string {
	return SAFE_ID.test(sessionId) ? sessionId : createHash("sha256").update(sessionId).digest("hex");
}

/** `<sessionId>.json` for an ordinary id; a hashed name for anything that could escape the folder. */
export function desktopFeedFile(agentDir: string, sessionId: string): string {
	return join(desktopFeedDirectory(agentDir), `${desktopFeedName(sessionId)}.json`);
}

export interface DesktopFeedStore {
	path: string;
	write(value: unknown): boolean;
	remove(): void;
}

export function createDesktopFeedStore(agentDir: string, sessionId: string): DesktopFeedStore {
	const root = desktopFeedDirectory(agentDir);
	const path = desktopFeedFile(agentDir, sessionId);
	const owned = (stat: fs.Stats) => process.platform === "win32" || stat.uid === process.getuid?.();
	const safeDirectory = (dir: string) => {
		const stat = fs.lstatSync(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw Error("unsafe-directory");
	};
	const ensure = () => {
		// The agent dir is trusted (pi itself writes there); only our own folders are checked.
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		safeDirectory(join(agentDir, "desktop"));
		safeDirectory(root);
	};
	const regular = () => {
		try {
			const stat = fs.lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !owned(stat)) throw Error("unsafe-file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};
	return {
		path,
		write(value: unknown): boolean {
			let temporary: string | undefined;
			try {
				ensure();
				regular();
				const candidate = join(root, `.${randomUUID()}.tmp`);
				const fd = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
				temporary = candidate;
				try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); } finally { fs.closeSync(fd); }
				regular();
				fs.renameSync(temporary, path);
				temporary = undefined;
				return true;
			} catch {
				return false;
			} finally {
				if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Best effort. */ } }
			}
		},
		remove(): void {
			try {
				safeDirectory(root);
				regular();
				fs.unlinkSync(path);
			} catch { /* Missing, unsafe or unavailable. */ }
		},
	};
}

/** Only ESRCH proves a recorded publisher dead; EPERM means it is alive under another account. */
export function desktopFeedProcessGone(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
	return false;
}

/**
 * A crashed session leaves its snapshot behind. A bounded sweep drops proven
 * orphans only (dead publisher pid, or a day without an update); anything
 * unreadable, foreign, linked or oversized stays.
 */
export function sweepDesktopFeedOrphans(agentDir: string, keep: string, now: number = Date.now()): void {
	const root = desktopFeedDirectory(agentDir);
	let entries: string[];
	try {
		const stat = fs.lstatSync(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return;
		entries = fs.readdirSync(root).slice(0, SWEEP_MAX_ENTRIES);
	} catch { return; }
	for (const entry of entries) {
		const candidate = join(root, entry);
		if (!entry.endsWith(".json") || candidate === keep) continue;
		try {
			const stat = fs.lstatSync(candidate);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > SWEEP_MAX_BYTES) continue;
			if (process.platform !== "win32" && stat.uid !== process.getuid?.()) continue;
			const value = JSON.parse(fs.readFileSync(candidate, "utf8")) as { identity?: { pid?: unknown }; updatedAt?: unknown } | null;
			if (typeof value !== "object" || value === null) continue;
			const updated = typeof value.updatedAt === "string" ? Date.parse(value.updatedAt) : Number.NaN;
			if (!desktopFeedProcessGone(value.identity?.pid) && !(Number.isFinite(updated) && now - updated > ORPHAN_AGE_MS)) continue;
			fs.unlinkSync(candidate);
		} catch { /* Never touch what cannot be proven an orphan. */ }
	}
}
