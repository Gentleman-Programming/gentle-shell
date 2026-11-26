// The desktop feed's adapters to state that has no event of its own: Git (the
// Changes scan and the header branch), the active profile label and tier, and
// the publisher's process ancestry (how the Herdr mod matches a terminal to a
// session). Each adapter is injectable so the extension stays testable.

import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";
import { profilesFilePath, readProfilesFileResult, readProfileWorkflow } from "./agent-profiles.ts";
import type { DesktopFeedProfileCatalog } from "./desktop-feed.ts";
import { resolveSessionProfile, sessionProfileLabel } from "./session-profile-freeze.ts";
import { resolveSessionWorktree, worktreeGitEnvironment, type WorktreeIdentity, type WorktreeResolver } from "./session-worktree-registry.ts";
import { DIFF_MAX_BYTES, type GitRunner, type LineCounter } from "./shell-changes.ts";

const GIT_TIMEOUT_MS = 5000;
/** A porcelain inventory past this is a failed scan, never a partial one. */
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Git for one root with the same sanitized environment Changes uses; never throws. */
export function desktopFeedGitRunner(root: string, env: NodeJS.ProcessEnv = process.env): GitRunner {
	const childEnv = worktreeGitEnvironment(env);
	return (args) => new Promise((resolve) => {
		try {
			execFile("git", ["--no-optional-locks", "-C", root, ...args], { env: childEnv, encoding: "utf8", shell: false, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, (error, stdout) => {
				const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
				if (failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") { resolve({ stdout: "", code: 1, truncated: true }); return; }
				resolve({ stdout: String(stdout ?? ""), code: failure ? typeof failure.code === "number" ? failure.code : 1 : 0, ...(failure?.killed ? { timedOut: true } : {}) });
			});
		} catch {
			resolve({ stdout: "", code: 1 });
		}
	});
}

export type ParentOf = (pid: number) => Promise<number | undefined>;

/** `ps -o ppid=` for one pid; undefined when unknown (Windows, exited, no ps). */
export const psParentOf: ParentOf = (pid) => new Promise((resolve) => {
	if (process.platform === "win32") { resolve(undefined); return; }
	try {
		execFile("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, windowsHide: true }, (error, stdout) => {
			const parent = error ? Number.NaN : Number.parseInt(String(stdout).trim(), 10);
			resolve(Number.isInteger(parent) && parent > 1 ? parent : undefined);
		});
	} catch {
		resolve(undefined);
	}
});

/** One `pid,ppid` pair per line, as the Windows process-table script prints them; other lines are ignored. */
export function parseProcessTable(stdout: string): Map<number, number> {
	const table = new Map<number, number>();
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^(\d+),(\d+)$/.exec(line.trim());
		if (match) table.set(Number(match[1]), Number(match[2]));
	}
	return table;
}

const WINDOWS_TABLE_TIMEOUT_MS = 8000;
const WINDOWS_TABLE_MAX_BUFFER = 4 * 1024 * 1024;
const WINDOWS_TABLE_SCRIPT = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }';

/** The whole Windows process table as text; undefined when PowerShell is missing, fails or times out. */
function readWindowsProcessTable(): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE_SCRIPT], { encoding: "utf8", windowsHide: true, timeout: WINDOWS_TABLE_TIMEOUT_MS, maxBuffer: WINDOWS_TABLE_MAX_BUFFER }, (error, stdout) => {
				resolve(error ? undefined : String(stdout));
			});
		} catch {
			resolve(undefined);
		}
	});
}

/**
 * The parent lookup for one ancestry walk. Outside Windows it is `ps` per hop;
 * Windows has no `ps`, so the first hop reads the whole process table once and
 * every later hop of this walk answers from it. A new walk needs a new lookup.
 * An unreadable table answers undefined (no ancestors), never an error.
 */
export function createParentOf(platform: NodeJS.Platform = process.platform, readTable: () => Promise<string | undefined> = readWindowsProcessTable): ParentOf {
	if (platform !== "win32") return psParentOf;
	let table: Promise<Map<number, number>> | undefined;
	return async (pid) => {
		table ??= readTable().then((text) => parseProcessTable(text ?? ""));
		const parent = (await table).get(pid);
		return parent !== undefined && parent > 1 ? parent : undefined;
	};
}

/** Ancestors above `ppid`, nearest first, stopping at init or after `depth` hops. Never rejects. */
export async function processAncestors(ppid: number, depth: number, parentOf: ParentOf = createParentOf()): Promise<number[]> {
	const chain: number[] = [];
	let current = ppid;
	for (let hop = 0; hop < depth; hop++) {
		const parent = await parentOf(current).catch(() => undefined);
		if (parent === undefined || parent <= 1 || chain.includes(parent)) break;
		chain.push(parent);
		current = parent;
	}
	return chain;
}

export interface DesktopFeedProfile {
	name: string | undefined;
	tier: "standard" | "fast" | undefined;
	/** The saved profiles (S12), when the store reads as valid. */
	catalog?: DesktopFeedProfileCatalog;
}

/**
 * The profile the status bar names, through the same single rule the shell's
 * active-profile reader applies (resolveSessionProfile + sessionProfileLabel),
 * the orchestrator tier configured for it in the profiles store, and (S12) the
 * store's saved profiles as /gentle:profiles lists them, with the one this
 * session routes with and the store's default.
 */
export function createDesktopFeedProfileReader(env: NodeJS.ProcessEnv = process.env, resolveWorktree: WorktreeResolver = resolveSessionWorktree) {
	let identity: WorktreeIdentity | undefined;
	let boundCwd: string | undefined;
	return (cwd: string, sessionId: string | undefined): DesktopFeedProfile => {
		try {
			if (boundCwd !== cwd) {
				boundCwd = cwd;
				try { identity = resolveWorktree(cwd, cwd); } catch { identity = undefined; }
			}
			const configHome = gentlePiConfigHome(env);
			const store = readProfilesFileResult(profilesFilePath(configHome));
			const tiers: Record<string, "standard" | "fast" | undefined> = store.status === "valid"
				? Object.fromEntries(Object.entries(store.file.profiles).map(([name, config]) => [name, config.orchestrator?.tier]))
				: {};
			const selected = resolveSessionProfile({ sessionId, cwd, configHome, resolveWorktree: () => identity, env });
			const name = sessionProfileLabel(selected);
			const configured = selected.kind === "explicit" ? selected.name : selected.profile?.name;
			const catalog: DesktopFeedProfileCatalog | undefined = store.status === "valid"
				? {
					active: configured,
					default: store.file.active,
					items: Object.entries(store.file.profiles).map(([profile, config]) => ({ name: profile, config, mode: readProfileWorkflow(store.file, profile).orchestratorMode })),
				}
				: undefined;
			return { name, tier: configured ? tiers[configured] : undefined, ...(catalog ? { catalog } : {}) };
		} catch {
			return { name: undefined, tier: undefined };
		}
	};
}

/** Bounds for counting untracked files: bytes per file (the Changes diff bound) and files per scan of a root. */
export const DESKTOP_FEED_UNTRACKED_LIMITS = { bytes: DIFF_MAX_BYTES, files: 200 } as const;
/** How many uncounted paths are remembered (oldest forgotten first). */
const UNCOUNTED_MAX = 1000;
/** S13: how many counted files are remembered by (path, size, mtime) (oldest forgotten first). */
const LINE_CACHE_MAX = 2000;

/** The file reads the counter needs; injectable for tests. */
export interface UntrackedLineIo {
	lstat(path: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>;
	readFile(path: string): Promise<Buffer>;
}
const realLineIo: UntrackedLineIo = { lstat, readFile: (path) => readFile(path) };

export interface UntrackedLineCounter {
	/** The LineCounter for one scan of `root` (WorktreeChangesTracker's linesForRoot). */
	forRoot(root: string): LineCounter;
	/** Absolute paths of untracked files whose lines were not counted (binary, too large, unreadable, past the budget). */
	uncounted(): ReadonlySet<string>;
}

/**
 * Line counts for untracked files, which git's numstat never lists: the same
 * count the shell's Changes uses (lines, a last line without a newline counts),
 * bounded per file and per scan. A binary file (a NUL byte), a file past the byte
 * bound, a non-regular or unreadable file and every file past the per-scan budget
 * count 0 and are listed in uncounted(), so the snapshot can say "no count".
 * S13: a file whose size and mtime did not change since it was last read is not
 * read again; its last answer (a count or a skip) stands.
 */
export function createUntrackedLineCounter(limits: { bytes: number; files: number } = DESKTOP_FEED_UNTRACKED_LIMITS, io: UntrackedLineIo = realLineIo): UntrackedLineCounter {
	const uncounted = new Set<string>();
	const known = new Map<string, { size: number; mtimeMs: number; lines: number | undefined }>();
	const remember = (target: string, size: number, mtimeMs: number, lines: number | undefined) => {
		known.delete(target);
		known.set(target, { size, mtimeMs, lines });
		if (known.size > LINE_CACHE_MAX) known.delete(known.keys().next().value as string);
	};
	const skip = (target: string) => {
		uncounted.delete(target);
		uncounted.add(target);
		if (uncounted.size > UNCOUNTED_MAX) uncounted.delete(uncounted.values().next().value as string);
		return 0;
	};
	return {
		forRoot(root) {
			let budget = limits.files;
			return async (path) => {
				const target = join(root, path);
				if (budget <= 0) return skip(target);
				budget -= 1;
				try {
					const info = await io.lstat(target);
					if (!info.isFile() || info.size > limits.bytes) { known.delete(target); return skip(target); }
					const cached = known.get(target);
					if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
						if (cached.lines === undefined) return skip(target);
						uncounted.delete(target);
						return cached.lines;
					}
					const bytes = await io.readFile(target);
					if (bytes.length > limits.bytes || bytes.includes(0)) { remember(target, info.size, info.mtimeMs, undefined); return skip(target); }
					uncounted.delete(target);
					const text = bytes.toString("utf8");
					const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
					remember(target, info.size, info.mtimeMs, lines);
					return lines;
				} catch {
					known.delete(target);
					return skip(target);
				}
			};
		},
		uncounted: () => uncounted,
	};
}
