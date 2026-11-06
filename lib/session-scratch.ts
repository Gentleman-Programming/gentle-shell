import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { directoryAfterSegment, SHELL_SEGMENT_SEPARATOR } from "./commit-slice-signal.ts";

// Session scratch and artifact ledger (odd/tasks/session-scratch-ledger.md).
// The runtime owns the parent session's TMPDIR and records the clones and
// worktrees the session creates, so cleanup reads a list instead of the model
// re-deducing what is garbage. Removal is limited to what the ledger recorded,
// and every check refuses rather than guesses.

export const LEDGER_VERSION = 1;
/** The ledger keeps the most recent artifacts, evicting the oldest first, so a long session's ledger file stays bounded. */
export const LEDGER_ARTIFACTS_CAP = 64;
// Short on purpose (S9): TMPDIR points at `gpXXXXXX` and a subagent's TMPDIR at
// `gaXXXXXX` under it, and Unix socket paths below them are capped near 104 bytes.
export const SCRATCH_PREFIX = "gp";
/** Subagent TMPDIRs (lib/agents-runner.ts) nest under the session scratch; their runner removes them. */
export const SUBAGENT_SCRATCH_PREFIX = "ga";
// mkdtemp appends six alphanumeric characters to the prefix.
const SCRATCH_NAME = new RegExp(`^${SCRATCH_PREFIX}[A-Za-z0-9]{6}$`);
const SUBAGENT_SCRATCH_NAME = new RegExp(`^${SUBAGENT_SCRATCH_PREFIX}[A-Za-z0-9]{6}$`);
/** Whether a path's last component is named as the runtime names a session scratch. */
export const isSessionScratchName = (path: string): boolean => SCRATCH_NAME.test(basename(path));
export const SWEEP_GRACE_MS = 60 * 60 * 1000;
/** `/gentle:scratch clean` keeps the live scratch's entries changed this long before it started. */
export const CLEAN_RECENT_MS = 60_000;

// The TMPDIRs of this process's live and quarantined subagents. On globalThis
// because Pi loads every extension as its own module instance, again on /reload,
// and a runner of an earlier instance may still hold a quarantined child.
const LIVE_SUBAGENT_SCRATCH = Symbol.for("gentle-pi.live-subagent-scratch");
const liveSubagentRegistry = (): Set<string> => {
	const holder = globalThis as { [LIVE_SUBAGENT_SCRATCH]?: Set<string> };
	return (holder[LIVE_SUBAGENT_SCRATCH] ??= new Set());
};
/** The runner holds a subagent TMPDIR from its creation until it removes it. */
export const holdSubagentScratch = (dir: string): void => { liveSubagentRegistry().add(dir); };
export const releaseSubagentScratch = (dir: string): void => { liveSubagentRegistry().delete(dir); };
export const liveSubagentScratch = (): string[] => [...liveSubagentRegistry()];

export type ArtifactKind = "clone" | "worktree";

export interface ScratchArtifact {
	kind: ArtifactKind;
	path: string;
	command: string;
	recordedAt: string;
}

export interface ScratchLedger {
	version: number;
	sessionId: string;
	pid: number;
	processStartedAt: string;
	/** The OS's opaque start token of the owning process (`processStartToken`); absent when it could not be read. */
	processStartToken?: string;
	cwd: string;
	/** The real temp root the scratch was created directly under (the inherited TMPDIR or os.tmpdir()). */
	tempRoot: string | null;
	/** The temp variables before the session changed them (null: unset), restored at shutdown. */
	inherited: Record<string, string | null>;
	scratchDir: string | null;
	artifacts: ScratchArtifact[];
}

export interface StoredLedger { path: string; ledger: ScratchLedger; mtimeMs: number }

/** The session id as a file and directory name component. */
export function safeSessionId(sessionId: string): string {
	return sessionId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "session";
}

export function ledgerDirectory(configHome: string): string {
	return join(configHome, "scratch");
}

export function ledgerPath(configHome: string, sessionId: string): string {
	return join(ledgerDirectory(configHome), `${safeSessionId(sessionId)}.json`);
}

function isArtifact(value: unknown): value is ScratchArtifact {
	const artifact = value as Partial<ScratchArtifact> | null;
	return typeof artifact === "object" && artifact !== null && (artifact.kind === "clone" || artifact.kind === "worktree") &&
		typeof artifact.path === "string" && isAbsolute(artifact.path) && typeof artifact.command === "string" && typeof artifact.recordedAt === "string";
}

function isLedger(value: unknown): value is ScratchLedger {
	const ledger = value as Partial<ScratchLedger> | null;
	return typeof ledger === "object" && ledger !== null && ledger.version === LEDGER_VERSION && typeof ledger.sessionId === "string" &&
		typeof ledger.pid === "number" && typeof ledger.processStartedAt === "string" &&
		(ledger.processStartToken === undefined || typeof ledger.processStartToken === "string") && typeof ledger.cwd === "string" &&
		(ledger.tempRoot === null || typeof ledger.tempRoot === "string") && typeof ledger.inherited === "object" && ledger.inherited !== null &&
		Object.values(ledger.inherited).every((value) => value === null || typeof value === "string") &&
		(ledger.scratchDir === null || typeof ledger.scratchDir === "string") && Array.isArray(ledger.artifacts) && ledger.artifacts.every(isArtifact);
}

/** A valid ledger at `path`, or undefined for a missing, unreadable, or foreign file. */
export function readLedger(path: string): ScratchLedger | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isLedger(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

// The fs functions the ledger file I/O uses. Tests spy on this object to pin the
// ledger I/O to the async fs API; the sync fs functions stay for the single-ledger
// read and the scratch-directory checks, which were already synchronous.
export const ledgerFs = { mkdir, readFile, readdir, rename, stat, unlink, writeFile };

/** A valid ledger read from `path`, or undefined for a missing, unreadable, or foreign file. */
async function readLedgerFile(path: string): Promise<ScratchLedger | undefined> {
	try {
		const parsed: unknown = JSON.parse(await ledgerFs.readFile(path, "utf8"));
		return isLedger(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Atomic and private: a temp file in the same directory, then a rename. */
export async function writeLedger(path: string, ledger: ScratchLedger): Promise<void> {
	await ledgerFs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await ledgerFs.writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await ledgerFs.rename(temp, path);
	} catch (error) {
		try { await ledgerFs.unlink(temp); } catch { /* already renamed or never created */ }
		throw error;
	}
}

/** Synchronous `writeLedger`, for the one caller that cannot await it (the shutdown path, whose callers do not await the handler). */
export function writeLedgerSync(path: string, ledger: ScratchLedger): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* already renamed or never created */ }
		throw error;
	}
}

export function deleteLedger(path: string): void {
	try { unlinkSync(path); } catch { /* already gone */ }
}

/** Every valid ledger in the config home; other files are left alone. */
export async function listLedgers(configHome: string): Promise<StoredLedger[]> {
	const dir = ledgerDirectory(configHome);
	let names: string[];
	try { names = await ledgerFs.readdir(dir); } catch { return []; }
	const result: StoredLedger[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		try {
			const ledger = await readLedgerFile(path);
			if (!ledger) continue;
			result.push({ path, ledger, mtimeMs: (await ledgerFs.stat(path)).mtimeMs });
		} catch { /* removed meanwhile */ }
	}
	return result;
}

/** Synchronous `listLedgers`, for the one caller that cannot await it (the shutdown path, whose callers do not await the handler). */
export function listLedgersSync(configHome: string): StoredLedger[] {
	const dir = ledgerDirectory(configHome);
	let names: string[];
	try { names = readdirSync(dir); } catch { return []; }
	const result: StoredLedger[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		const ledger = readLedger(path);
		if (!ledger) continue;
		try { result.push({ path, ledger, mtimeMs: statSync(path).mtimeMs }); } catch { /* removed meanwhile */ }
	}
	return result;
}

/** `kill(pid, 0)`: EPERM still means a live process owned by someone else. */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * An opaque token for when the process `pid` started, as the OS reports it, or
 * undefined when it cannot be read: always on Windows, where only pid liveness
 * is checked. Tokens are compared for equality only, never converted to wall
 * clock time, so a clock step cannot make a live process look like another one.
 */
export function processStartToken(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		if (platform === "linux") {
			// Field 22 counts clock ticks since boot; the command name (field 2) may hold spaces and parentheses.
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
			return ticks && /^\d+$/.test(ticks) ? `linux:${ticks}` : undefined;
		}
		if (platform === "win32") return undefined;
		// macOS and the BSDs: the start time text as ps prints it, in a fixed locale.
		const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
		return started ? `ps:${started}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A private `gpXXXXXX` under `base`, or undefined when it cannot be created.
 * `path` joins `base` as given, for TMPDIR (a real path can be longer, as
 * macOS `/private/var/...`); `realPath` is what the ledger and checks use.
 */
export function createSessionScratch(base: string | undefined): { path: string; realPath: string } | undefined {
	if (!base || !isAbsolute(base)) return undefined;
	try {
		const path = mkdtempSync(join(base, SCRATCH_PREFIX));
		try { chmodSync(path, 0o700); } catch { /* best effort, as mkdtemp already creates 0700 on POSIX */ }
		return { path, realPath: realpathSync(path) };
	} catch {
		return undefined;
	}
}

export const isWithin = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/** The real path of a temp root, or undefined when it does not exist. */
export function realTempRoot(path: string | undefined): string | undefined {
	if (!path || !isAbsolute(path)) return undefined;
	try { return realpathSync(path); } catch { return undefined; }
}

/**
 * Why a recorded scratch dir is not ours to remove, "absent" when it is gone,
 * or undefined when it is. `ownRoot` is the temp root of the session asking:
 * a ledger's temp root inside the home is trusted only when it is that root.
 */
export function scratchRefusal(ledger: ScratchLedger, ownRoot: string | undefined): string | undefined {
	const dir = ledger.scratchDir;
	if (!dir || !isAbsolute(dir)) return "not recorded";
	// Prefix and ledger match: only a directory named as the runtime names a session scratch.
	if (!SCRATCH_NAME.test(basename(dir))) return "not a session scratch name";
	// Created directly under the temp root recorded with it, which is a temp root.
	const root = ledger.tempRoot;
	if (!root || !isAbsolute(root) || dirname(dir) !== root) return "outside its temp root";
	if (isWithin(root, resolve(homedir())) && root !== ownRoot) return "temp root inside the home";
	let stat;
	try { stat = lstatSync(dir); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable"; }
	if (stat.isSymbolicLink() || !stat.isDirectory()) return "not a directory";
	// The ledger holds the real path made at creation; a swapped parent changes it.
	try { if (realpathSync(dir) !== dir) return "moved behind a symlink"; } catch { return "unreadable"; }
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) return "owned by another user";
	return undefined;
}

export type ScratchRemoval = "removed" | "absent" | "kept" | "refused";

/** The latest mtime or ctime under `path`, without following symlinks; Infinity when it cannot be told. */
function latestChange(path: string): number {
	let latest = -Infinity;
	const stack = [path];
	for (let visited = 0; stack.length > 0; visited++) {
		if (visited >= 200_000) return Infinity;
		const current = stack.pop()!;
		let stat;
		try { stat = lstatSync(current); } catch (error) {
			if (current !== path && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return Infinity;
		}
		latest = Math.max(latest, stat.mtimeMs, stat.ctimeMs);
		if (stat.isDirectory()) {
			try { for (const name of readdirSync(current)) stack.push(join(current, name)); } catch { return Infinity; }
		}
	}
	return latest;
}

export interface ScratchRemovalOptions {
	/** Remove the entries and keep the directory, as for the live session's own scratch. */
	contentsOnly?: boolean;
	ownRoot: string | undefined;
	/** Real paths of this process's live and quarantined subagent TMPDIRs: kept, and the rest of the scratch removed. */
	liveSubagentDirs?: readonly string[];
	/** With `contentsOnly`, an entry with anything changed at or after this time (epoch ms) is kept. */
	keepChangedSince?: number;
}

/**
 * Removes a ledger's scratch dir, or with `contentsOnly` its entries except
 * subagent TMPDIRs. A dir or entry holding one of `heldPaths` is kept: a
 * recorded artifact is removed only through its own checks, and the scratch dir
 * of a live session only through that session's ledger. A scratch holding a
 * live subagent TMPDIR loses its other entries only. Symlinks are never followed.
 */
export function removeSessionScratch(ledger: ScratchLedger, heldPaths: readonly string[], options: ScratchRemovalOptions): ScratchRemoval {
	const refusal = scratchRefusal(ledger, options.ownRoot);
	if (refusal === "absent") return "absent";
	if (refusal) return "refused";
	const dir = ledger.scratchDir!;
	const holdsArtifact = (path: string) => heldPaths.some((held) => isWithin(held, path));
	const holdsSubagent = (path: string) => (options.liveSubagentDirs ?? []).some((held) => isWithin(held, path));
	try {
		if (!options.contentsOnly) {
			if (holdsArtifact(dir)) return "kept";
			if (!holdsSubagent(dir)) {
				rmSync(dir, { recursive: true, force: true });
				return "removed";
			}
		}
		let kept = false;
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const recent = options.contentsOnly && options.keepChangedSince !== undefined && latestChange(path) >= options.keepChangedSince;
			if (SUBAGENT_SCRATCH_NAME.test(name) || holdsArtifact(path) || holdsSubagent(path) || recent) { kept = true; continue; }
			rmSync(path, { recursive: true, force: true });
		}
		return kept ? "kept" : "removed";
	} catch {
		return "refused";
	}
}

/** Total bytes of regular files under `dir`, without following symlinks. */
export function directorySize(dir: string): number {
	let total = 0;
	const stack = [dir];
	for (let visited = 0; stack.length > 0 && visited < 200_000; visited++) {
		const path = stack.pop()!;
		try {
			const stat = lstatSync(path);
			if (stat.isDirectory()) for (const name of readdirSync(path)) stack.push(join(path, name));
			else if (stat.isFile()) total += stat.size;
		} catch { /* removed meanwhile */ }
	}
	return total;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
	return `${value.toFixed(1)} ${units[unit]}`;
}

// Command parsing (S4).

const CLONE_VALUE_OPTIONS = new Set(["-b", "--branch", "-o", "--origin", "-c", "--config", "--depth", "--reference", "--reference-if-able", "--separate-git-dir", "-u", "--upload-pack", "--template", "-j", "--jobs", "--filter", "--shallow-since", "--shallow-exclude", "--server-option", "--bundle-uri", "--revision"]);
const WORKTREE_ADD_VALUE_OPTIONS = new Set(["-b", "-B", "--reason"]);
// A pipe, background, or redirection token ends the git arguments.
const ARGUMENTS_END = /^(\||&|\d*>|\d*<|&>|<|>)/;

function tokens(segment: string): string[] {
	return (segment.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? []).map((token) => token.replace(/^(["'])(.*)\1$/s, "$2"));
}

function positionals(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") { result.push(...args.slice(i + 1)); break; }
		if (arg.startsWith("-") && arg !== "-") { if (valueOptions.has(arg)) i++; continue; }
		result.push(arg);
	}
	return result;
}

/** The directory `git clone <repo>` creates without a destination, as git guesses it. */
function defaultCloneDirectory(repository: string): string | undefined {
	const trimmed = repository.replace(/[\\/]+$/, "").replace(/[\\/]\.git$/, "");
	const name = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":"), trimmed.lastIndexOf("\\")) + 1).replace(/\.(git|bundle)$/, "");
	return name && name !== "." && name !== ".." ? name : undefined;
}

export interface ArtifactTarget { kind: ArtifactKind; path: string }

/** Clone and worktree destinations a shell command creates, resolved against its `cd` segments and `git -C`. */
export function gitArtifactTargets(command: string, cwd: string): ArtifactTarget[] {
	const targets: ArtifactTarget[] = [];
	let base = cwd;
	for (const segment of command.split(SHELL_SEGMENT_SEPARATOR)) {
		const words = tokens(segment);
		let i = 0;
		while (i < words.length && /^\w+=/.test(words[i])) i++;
		if (words[i] === "git") {
			let directory = base;
			for (i++; i < words.length && words[i].startsWith("-"); i++) {
				if (words[i] === "-C" && i + 1 < words.length) directory = resolve(directory, words[++i]);
				else if (words[i] === "-c") i++;
			}
			const end = words.findIndex((word, index) => index >= i && ARGUMENTS_END.test(word));
			const args = words.slice(i, end < 0 ? undefined : end);
			if (args[0] === "clone") {
				const [repository, destination] = positionals(args.slice(1), CLONE_VALUE_OPTIONS);
				const target = destination ?? (repository ? defaultCloneDirectory(repository) : undefined);
				if (target) targets.push({ kind: "clone", path: resolve(directory, target) });
			} else if (args[0] === "worktree" && args[1] === "add") {
				const [path] = positionals(args.slice(2), WORKTREE_ADD_VALUE_OPTIONS);
				if (path) targets.push({ kind: "worktree", path: resolve(directory, path) });
			}
		}
		base = directoryAfterSegment(segment, base);
	}
	return targets;
}

/** A path the runtime never records or removes: a filesystem root, or the home, config, or session directory or an ancestor of them. */
export function isProtectedPath(path: string, keep: readonly string[]): boolean {
	return parse(path).root === path || [homedir(), ...keep].some((dir) => dir && isWithin(resolve(dir), path));
}

// Artifact checks and removal (S6).

type Git = (args: string[], cwd: string) => Promise<string | undefined>;

// Inherited repository overrides would point git away from the recorded path.
const GIT_ENV_OVERRIDES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"];

const runGit: Git = (args, cwd) => new Promise((resolveResult) => {
	const env = { ...process.env };
	for (const key of GIT_ENV_OVERRIDES) delete env[key];
	execFile("git", args, { cwd, env, encoding: "utf8", timeout: 10_000, windowsHide: true }, (error, stdout) => resolveResult(error ? undefined : stdout.trim()));
});

export type ArtifactCheck =
	| { state: "missing" }
	| { state: "kept"; reason: string }
	| { state: "removable"; commonDir?: string; identity?: { dev: bigint; ino: bigint } };

const sameDirectory = (path: string) => {
	try {
		const stat = lstatSync(path);
		return !stat.isSymbolicLink() && stat.isDirectory() && realpathSync(path) === path;
	} catch {
		return false;
	}
};

const identityOf = (path: string) => {
	try {
		// bigint: some filesystems report inode numbers above Number.MAX_SAFE_INTEGER.
		const { dev, ino } = lstatSync(path, { bigint: true });
		return { dev, ino };
	} catch {
		return undefined;
	}
};

/** Whether a recorded clone or worktree can be removed without losing work. */
export async function checkArtifact(artifact: ScratchArtifact, keep: readonly string[], git: Git = runGit): Promise<ArtifactCheck> {
	const { path, kind } = artifact;
	try { lstatSync(path); } catch (error) {
		// ENOTDIR: a path component is no longer a directory, so the artifact cannot exist there.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing" };
	}
	if (!sameDirectory(path)) return { state: "kept", reason: "not the recorded directory" };
	// Taken before any Git call, so a directory swapped in during the checks is not the one removed.
	const identity = identityOf(path);
	if (isProtectedPath(path, keep)) return { state: "kept", reason: "protected directory" };
	const top = await git(["rev-parse", "--show-toplevel"], path);
	if (top === undefined || resolve(top) !== path) return { state: "kept", reason: "not a Git work tree root" };
	let dotGit;
	try { dotGit = lstatSync(join(path, ".git")); } catch { return { state: "kept", reason: "not a Git work tree root" }; }
	if (kind === "clone" ? !dotGit.isDirectory() : !dotGit.isFile()) return { state: "kept", reason: kind === "clone" ? "not a standalone clone" : "not a linked worktree" };
	// Override user settings that hide untracked files or submodule changes from status.
	const status = await git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], path);
	if (status === undefined) return { state: "kept", reason: "Git status unavailable" };
	if (status !== "") return { state: "kept", reason: "uncommitted changes" };
	if (kind === "clone") {
		// Removing the clone would orphan its linked worktrees; a prunable one has lost its directory already.
		const worktrees = await git(["worktree", "list", "--porcelain"], path);
		const present = worktrees?.split(/\n\s*\n/).filter((entry) => /^worktree /m.test(entry) && !/^prunable\b/m.test(entry));
		if (!present?.length) return { state: "kept", reason: "Git worktrees unavailable" };
		if (present.length > 1) return { state: "kept", reason: "has linked worktrees" };
		// Every ref, stashes included, must already be on a remote.
		const local = await git(["rev-list", "-n", "1", "--all", "--not", "--remotes"], path);
		if (local === undefined) return { state: "kept", reason: "Git history unavailable" };
		return local === "" ? { state: "removable", identity } : { state: "kept", reason: "commits not on any remote" };
	}
	const detached = await git(["rev-list", "-n", "1", "HEAD", "--not", "--branches", "--tags", "--remotes"], path);
	if (detached === undefined) return { state: "kept", reason: "Git history unavailable" };
	if (detached !== "") return { state: "kept", reason: "commits on no branch" };
	const commonDir = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
	return commonDir ? { state: "removable", commonDir, identity } : { state: "kept", reason: "Git repository unavailable" };
}

/** Removes a checked artifact: a worktree through git (which refuses dirty ones), a clone by its recorded path only. */
export async function removeArtifact(artifact: ScratchArtifact, check: Extract<ArtifactCheck, { state: "removable" }>, git: Git = runGit): Promise<string | undefined> {
	if (!sameDirectory(artifact.path)) return "not the recorded directory";
	// The directory checked must be the one removed, not a replacement at the same path.
	const now = identityOf(artifact.path);
	if (!check.identity || !now || now.dev !== check.identity.dev || now.ino !== check.identity.ino) return "replaced after the check";
	if (artifact.kind === "worktree") {
		if (await git(["worktree", "remove", artifact.path], artifact.path) === undefined) return "git worktree remove failed";
		if (check.commonDir) await git([`--git-dir=${check.commonDir}`, "worktree", "prune"], dirname(check.commonDir));
		return undefined;
	}
	try {
		rmSync(artifact.path, { recursive: true, force: true });
		return undefined;
	} catch (error) {
		return `removal failed: ${(error as Error).message}`;
	}
}
