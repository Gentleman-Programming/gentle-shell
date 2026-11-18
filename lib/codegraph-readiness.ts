import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, linkSync, lstatSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { daemonFor, mcpCallRequests, mcpCallText, mcpInitializeRequest, mcpLineReader, mcpReplyKind, projectSpelling } from "./codegraph-daemon.ts";
import type { DaemonInfo } from "./codegraph-daemon.ts";
import { resolveCodegraphEntry } from "./codegraph-cli-resolve.ts";
import type { CodegraphEntry } from "./codegraph-cli-resolve.ts";
import { acquireInitLock, codegraphWritingIndex, indexState, syncLeaseHeldLive, tryAcquireSyncLease, type IndexState } from "./codegraph-lease.ts";
import { resolveSessionWorktree, type WorktreeIdentity } from "./session-worktree-registry.ts";

/** What happened when a worktree asked to be seeded from its main checkout. */
export type SeedOutcome =
	/** Copied, renamed, and the validating sync succeeded. */
	| "seeded"
	/** An index already exists in the worktree (before or during the seed). */
	| "target-exists"
	/** Wrong shape: the main checkout itself, or no main database to copy. */
	| "not-seedable"
	/** Another session owns index creation for this worktree: fail-closed. */
	| "deferred"
	/** The main checkout's index is being written right now: nothing was copied, nothing failed. */
	| "main-busy"
	/** Copy, validating sync, or an unsafe (symlinked) destination failed; the worktree is left without a database. */
	| "seed-failed";

/** What the validating sync reported about the staged index: a bare boolean is the exit
 * status alone, while the object form also says whether the sync removed tracked entries
 * (ok = exit 0, removedEntries = entries dropped from the staged index). The staging project
 * has no source files, so a removal there is always a loss: an emptied index must never be
 * published even though the sync exited 0. */
export type SeedSyncReport = boolean | { ok: boolean; removedEntries: boolean };

/** A cold daemon on a network share can need over a minute for its first read. */
const WARMUP_TIMEOUT_MS = 120_000;
export const SYNC_TIMEOUT_MS = 120_000;

/** One retry after this backoff when a sync beside a live daemon fails: the daemon.log busy windows close by themselves in tens of seconds, well inside the 60s wedged-daemon bypass. */
export const SYNC_RETRY_DELAY_MS = 15_000;

/** What a codegraph command reported about itself; the stdout/stderr tails are bounded by the runner. */
export interface CodegraphCommandInfo {
	ok: boolean;
	exitCode?: number | null;
	stderrTail?: string;
	/** The captured stdout tail — `sync -q` prints nothing, but `status` output carries the entry counts the seed runner parses. */
	stdoutTail?: string;
}

/** Runs codegraph with fixed args for a cwd; the optional sink receives the command outcome for diagnostics. */
export type CodegraphRun = (
	args: readonly string[],
	cwd: string,
	timeoutMs: number,
	onSpawn?: (pid: number, proxy: boolean) => void,
	onInfo?: (info: CodegraphCommandInfo) => void,
) => Promise<boolean>;

/** Runs codegraph for a seed's validating sync: the same shape and CLI call as CodegraphRun, but
 * the report also says whether the sync removed tracked entries from the staged index. */
export type CodegraphSeedRun = (
	args: readonly string[],
	cwd: string,
	timeoutMs: number,
	onSpawn?: (pid: number, proxy: boolean) => void,
	onInfo?: (info: CodegraphCommandInfo) => void,
) => Promise<SeedSyncReport>;

/** The backoff sleep when no test seam is injected. */
const defaultSyncSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The first line of an error's message (or its String form), bounded for reports. */
export function firstLineOf(error: unknown, max?: number): string {
	const text = error instanceof Error ? error.message.split("\n")[0] : String(error);
	return max === undefined ? text : text.slice(0, max);
}

/**
 * One sync -q beside a live daemon, retried once after a backoff when it fails: the CLI coexists
 * with the daemon by design and its busy windows close by themselves, so one retry absorbs the
 * transient failure without touching the lease design. One deadline covers the complete refresh:
 * both attempts and the backoff draw on the same SYNC_TIMEOUT_MS budget, so the sequence can never
 * run twice the timeout plus the backoff — a first attempt that already spent the budget ends the
 * refresh instead of buying a retry no budget is left for. The sink receives the last attempt outcome.
 */
async function runSyncWithRetry(
	run: CodegraphRun,
	cwd: string,
	sleep: (ms: number) => Promise<void>,
	sink?: (info: CodegraphCommandInfo) => void,
): Promise<boolean> {
	const deadline = Date.now() + SYNC_TIMEOUT_MS;
	const attempt = (timeoutMs: number): Promise<boolean> => run(["sync", "-q"], cwd, timeoutMs, undefined, sink);
	if (await attempt(SYNC_TIMEOUT_MS)) return true;
	// The backoff is worth waiting only when a usable budget survives it for the retry.
	if (deadline - Date.now() <= SYNC_RETRY_DELAY_MS) return false;
	await sleep(SYNC_RETRY_DELAY_MS);
	return attempt(Math.max(deadline - Date.now(), 0));
}

type DaemonlessRefresh =
	| { kind: "writing" }
	| { kind: "held-live" }
	| { kind: "lease-blocked" }
	| { kind: "done"; synced: boolean };

/**
 * The daemon-less half of an index refresh, shared by prepareReadiness and syncBeforeSearch: when
 * CodeGraph itself is writing, its live lock is left alone; only the sync-lease holder refreshes —
 * a live lease in another session means that session is syncing right now, so this session runs
 * nothing. No unlock precedes the sync: CodeGraph's own FileLock reclaims stale locks itself, and
 * an unlock could remove a live owner's lock.
 */
async function daemonlessRefresh(cwd: string, opts: { run: CodegraphRun; locksDir?: string; sink?: (info: CodegraphCommandInfo) => void }): Promise<DaemonlessRefresh> {
	if (codegraphWritingIndex(cwd)) return { kind: "writing" };
	const lease = tryAcquireSyncLease(cwd, opts.locksDir);
	if (!lease) {
		// Only a live holder means another session is refreshing right now. A damaged or unreadable
		// token is nobody's refresh and must not silently disable it forever.
		return syncLeaseHeldLive(cwd, opts.locksDir) ? { kind: "held-live" } : { kind: "lease-blocked" };
	}
	try {
		// The sync child is adopted onto the lease: the detached child can outlive this launcher before
		// it creates codegraph.lock, and its recorded pid keeps the verdict held-live — a live writer
		// is never raced, the same hook acquireInitLock gives its init child.
		const adoptChild = (pid: number, proxy: boolean): void => lease.adopt(pid, proxy);
		return { kind: "done", synced: await opts.run(["sync", "-q"], cwd, SYNC_TIMEOUT_MS, adoptChild, opts.sink) };
	} finally {
		lease.release();
	}
}

/** prepareReadiness's boolean view: another writer or holder handled the refresh, a blocked lease
 * did not, and otherwise the sync outcome decides. */
function daemonlessOk(outcome: DaemonlessRefresh): boolean {
	if (outcome.kind === "done") return outcome.synced;
	return outcome.kind === "writing" || outcome.kind === "held-live";
}

const INIT_TIMEOUT_MS = 600_000;
/** How long a killed command may take to be gone before the timeout is reported anyway. */
const KILL_WAIT_MS = 10_000;
/** Grace a timed-out command gets to obey SIGTERM before the unignorable SIGKILL ends its tree. */
const KILL_ESCALATE_MS = 1_000;
/** The environment variable a subagent child carries; children never start an index operation of their own. */
export const CHILD_ENV = "GENTLE_PI_AGENTS_CHILD";
/** One of these next to a `.git` is what makes a directory a project worth indexing automatically. */
const MARKERS = ["composer.json", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts"];
/** Quotes one argument the way cmd.exe and the npm `.cmd` shim keep it: backslashes are written
 * exactly as given (JSON.stringify's doubling corrupted drive and UNC project paths, because
 * cmd.exe preserves backslashes inside quotes), the surrounding double quotes keep cmd's
 * metacharacters inert, and an embedded quote is doubled away. */
function quoteForCmd(part: string): string {
	const escaped = part.replaceAll("\"", "\"\"");
	return `"${escaped}"`;
}

/** The full Windows command line for the fixed-argument vector: the npm `.cmd` shim needs
 * cmd.exe, so the arguments become one cmd.exe-quoted string. Pure on purpose — the win32 spawn
 * cannot run on a POSIX host, but the string it would build is fully checkable in a unit test.
 * cmd.exe expands %VAR% even inside double quotes and offers no command-line escape for a
 * literal percent, so an argument carrying one has no faithful transport through the shell and
 * the `.cmd` shim — with USERNAME=alice, C:\repos\%USERNAME% would target C:\repos\alice, a
 * different project than the lease protects. Such arguments are rejected here, before any
 * spawn: the callers' existing spawn-failure paths then report the warm-up or command as
 * failed instead of silently running for the wrong project. */
export function buildWindowsCommand(args: readonly string[]): string {
	for (const part of args) {
		if (part.includes("%")) {
			throw new Error(`cmd.exe would expand the percent in "${part}" into a different project: refusing to build the Windows command line`);
		}
	}
	return ["codegraph", ...args.map(quoteForCmd)].join(" ");
}

/** The process view the spawn decision needs: the platform, the spawn itself, and the win32
 * cmd-shim resolver. Injectable so the Windows selection is observable off Windows; the
 * default seam is the real thing, and the POSIX branch never asks the resolver for anything. */
export interface SpawnCodegraphSeam {
	platform(): NodeJS.Platform;
	/** The spawn: an argument-vector call (command, args, options) or a whole-command-line call
	 * (command, options) for the cmd.exe fallback. */
	spawn(command: string, args: readonly string[] | SpawnOptions, options?: SpawnOptions): ChildProcess;
	/** The win32 cmd-shim resolution: null keeps the cmd.exe fallback. */
	resolveEntry(): CodegraphEntry | null;
}

const realSpawnSeam: SpawnCodegraphSeam = {
	platform: () => process.platform,
	spawn,
	resolveEntry: () => resolveCodegraphEntry(),
};

/** Spawns the codegraph CLI from the temp directory (cmd.exe cannot take a UNC working
 * directory). On Windows the npm `.cmd` shim is resolved once per process to the node
 * executable and JS entrypoint it invokes, and a resolved shim is spawned directly as a plain
 * argument vector — no cmd.exe, no shim, no quoting, and no percent rejection (an argument
 * vector carries one verbatim where cmd.exe would expand it into another project). An
 * unresolvable shim — none on PATH, an unknown shape, a vanished target — keeps the exact
 * previous spawn: the whole fixed command line as one cmd.exe-quoted string through shell:true.
 * POSIX takes a plain argument vector in its own detached group. */
export function spawnCodegraph(args: readonly string[], stdio: ReadonlyArray<"pipe" | "ignore">, seam: SpawnCodegraphSeam = realSpawnSeam): ReturnType<typeof spawn> {
	if (seam.platform() === "win32") {
		const entry = seam.resolveEntry();
		if (entry !== null) {
			return seam.spawn(entry.node, [entry.script, ...args], { cwd: tmpdir(), env: process.env, detached: true, windowsHide: true, stdio: [...stdio] });
		}
		return seam.spawn(buildWindowsCommand(args), { cwd: tmpdir(), env: process.env, shell: true, windowsHide: true, stdio: [...stdio] });
	}
	return seam.spawn("codegraph", [...args], { cwd: tmpdir(), env: process.env, detached: true, windowsHide: true, stdio: [...stdio] });
}


/**
 * Makes the project's CodeGraph daemon open its database and start a read worker, so the next real call
 * is fast: talks MCP to `codegraph serve --mcp -p <project>` started from the temp directory (cmd.exe
 * cannot take a UNC working directory), then destroys the pipes and unrefs the child so the server goes
 * on alone as the daemon — it is shared with the user's other sessions, so it is never killed. When a
 * daemon is already alive there is nothing to warm: resolves true without spawning anything. Never
 * rejects; `background` unrefs everything so a warm-up still running never keeps its caller alive.
 */
export function warmUpDaemon(cwd: string, background = false, timeoutMs = WARMUP_TIMEOUT_MS, registryDir?: string): Promise<boolean> {
	// A daemon that is already alive is already warm: a second `serve --mcp` cannot take the daemon
	// lock and only logs "Could not acquire the daemon lock; exiting" (26+ such lines in daemon.log)
	// before it is reported as a failed warm-up. No spawn, no handshake — it resolves at once.
	let daemon: DaemonInfo;
	try {
		daemon = daemonFor(cwd, registryDir);
		if (daemon.alive) return Promise.resolve(true);
	} catch {
		/* an unreadable registry is no reason to skip the warm-up */
		daemon = { alive: false, root: undefined };
	}
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		let child: ReturnType<typeof spawn> | undefined;
		let escalate: ReturnType<typeof setTimeout> | undefined;
		const project = projectSpelling(daemon, cwd);
		const finish = (ok: boolean) => {
			if (settled) return;
			// A reply that lands after the deadline — while the timed-out child is still being torn
			// down — settles the missed warm-up as failed, never as a late success.
			if (timedOut) ok = false;
			settled = true;
			clearTimeout(timer);
			// An early settlement does not cancel the kill escalation: a child that ignores SIGTERM
			// must still be SIGKILLed before it can keep holding the daemon lock.
			if (!timedOut && escalate !== undefined) clearTimeout(escalate);
			// Destroy, not end: an ended pipe still holds the event loop until the server exits.
			try { child?.stdin?.destroy(); } catch { /* already closed */ }
			try { child?.stdout?.destroy(); } catch { /* already gone */ }
			child?.unref();
			resolve(ok);
		};
		// A warm-up that never handshakes is not a daemon: kill it instead of leaking a process
		// that can hold the daemon lock (the success path above still never kills a live daemon).
		// A child that handles or ignores SIGTERM is escalated to the unignorable SIGKILL after
		// the same short grace the command runner grants, and the failure is reported only once
		// the tree is gone — KILL_WAIT_MS stays the cap for a close that never comes — so a
		// stubborn warm-up can never stay alive holding the daemon lock past its result.
		const timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(child, true);
			escalate = setTimeout(() => {
				killProcessTree(child, true, "SIGKILL");
				escalate = setTimeout(() => finish(false), KILL_WAIT_MS);
				if (background) escalate.unref?.();
			}, KILL_ESCALATE_MS);
			if (background) escalate.unref?.();
		}, timeoutMs);
		if (background) timer.unref?.();
		try {
			child = spawnCodegraph(["serve", "--mcp", "-p", project], ["pipe", "pipe", "ignore"]);
			if (background) {
				child.unref();
				(child.stdin as (NodeJS.WritableStream & { unref?(): void }) | null)?.unref?.();
				(child.stdout as (NodeJS.ReadableStream & { unref?(): void }) | null)?.unref?.();
			}
		} catch {
			finish(false);
			return;
		}
		const send = (message: object) => child?.stdin?.write(JSON.stringify(message) + "\n");
		let stage: "initialize" | "call" = "initialize";
		const readLines = mcpLineReader((message) => {
			if (message === undefined) return false;
			const kind = mcpReplyKind(message);
			if (stage === "initialize" && kind === "initialize") {
				stage = "call";
				for (const request of mcpCallRequests("codegraph_explore", { query: "main" })) send(request);
			} else if (stage === "call" && kind === "call") {
				finish(mcpCallText(message) !== undefined);
				return true;
			}
			return false;
		});
		child.stdout?.on("data", readLines);
		child.on("error", () => finish(false));
		child.on("close", () => finish(false));
		child.stdin?.on("error", () => { /* the server exited first */ });
		send(mcpInitializeRequest(pathToFileURL(project).href));
	});
}

// The tri-state index check lives in the lease module now (the init lock waits on it); re-exported
// here because readiness's own API and its importers (tools, session-seed, tests) speak it from here.
export { indexState, type IndexState } from "./codegraph-lease.ts";

export type IndexAction = "sync" | "init" | "none";
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/** An existing index is synced; a fresh git project with a marker file is initialised; anything else is left alone. */
export function planIndexAction(cwd: string, state: IndexState, isProjectRoot: (cwd: string) => boolean): IndexAction {
	if (state === "present") return "sync";
	if (state === "unknown" || !isProjectRoot(cwd)) return "none";
	return MARKERS.some((marker) => existsSync(join(cwd, marker))) ? "init" : "none";
}

/** A /reload is not a new session, and a subagent child shares its parent's project. */
export function skipsSession(env: Record<string, string | undefined>, reason: SessionStartReason): boolean {
	return env[CHILD_ENV] === "1" || reason === "reload";
}

/**
 * The worktree identity when `cwd` is itself a linked git worktree (not a main checkout), else
 * undefined. The one probe for this module and codegraph-seed: seed already value-imports
 * SYNC_TIMEOUT_MS from here, so it imports the probe too and the seed -> readiness edge stays
 * one-way — no cycle opens.
 */
export function linkedWorktreeIdentity(cwd: string): WorktreeIdentity | undefined {
	try {
		// A linked worktree's `.git` is a file pointing at the common dir; the main checkout's
		// is a directory.
		if (!lstatSync(join(cwd, ".git")).isFile()) return undefined;
		const identity = resolveSessionWorktree(cwd, cwd);
		return identity !== undefined && identity.root === realpathSync(cwd) ? identity : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A subagent child normally shares its parent's project index, with one exception: its cwd is
 * its own unindexed linked worktree, whose index is no other session's job to bring up.
 */
export function childWorktreeNeedsIndex(env: Record<string, string | undefined>, cwd: string): boolean {
	return env[CHILD_ENV] === "1" && indexState(cwd) === "absent" && linkedWorktreeIdentity(cwd) !== undefined;
}

/** Reload dominates; only a child in its own unindexed linked worktree is un-skipped for the seed-or-init path. */
export function sessionSkipsReadiness(env: Record<string, string | undefined>, reason: SessionStartReason, cwd: string): boolean {
	if (reason === "reload") return true;
	if (env[CHILD_ENV] === "1") return !childWorktreeNeedsIndex(env, cwd);
	return false; // reload and the child case returned above; skipsSession can only see the negative
}

/** Captures the last command outcome a refresh ran, for its failure reports. */
function lastInfoSink(): { sink: (info: CodegraphCommandInfo) => void; get(): { exitCode?: number | null; stderrTail?: string } | undefined } {
	let last: { exitCode?: number | null; stderrTail?: string } | undefined;
	return {
		sink: (info) => { last = { exitCode: info.exitCode, stderrTail: info.stderrTail }; },
		get: () => last,
	};
}

export interface ReadinessInput {
	cwd: string;
	/** The daemon registry consulted for liveness; the default is CodeGraph's own. */
	registryDir?: string;
	/** Where cross-session init/sync lock tokens live; the default is CodeGraph's own locks dir. */
	locksDir?: string;
	/** Bounded wait for another session's init before failing closed; defaults to the init-lock budget. */
	initLockWaitMs?: number;

	/** Seeds a linked worktree from its main checkout; undefined disables seeding. */
	seed?(cwd: string): Promise<{ outcome: SeedOutcome }>;
	env: Record<string, string | undefined>;
	reason: SessionStartReason;
	/** Whether cwd is a real git project root equal to the workspace (the tool's workspace guard). */
	isProjectRoot(cwd: string): boolean;
	/** Runs `codegraph <args...> <project>` from the temp dir; true when it exited 0. */
	run: CodegraphRun;
	/** Sleeps the live-daemon sync retry backoff; injectable for tests. */
	sleep?(ms: number): Promise<void>;
	/** Warms the daemon; true when it worked. */
	warm(cwd: string): Promise<boolean>;
	onStart?(action: IndexAction): void;
	onIndexed?(result: { action: IndexAction; ok: boolean; daemonAlive?: boolean; exitCode?: number | null; stderrTail?: string }): void;
	onWarmStart?(): void;
}

export interface ReadinessResult {
	action: IndexAction;
	ok: boolean;
	warm: "ok" | "failed" | "skipped";
	/** The first line of an unexpected mid-run exception: a collapsed failure stays visible to the
	 * session instead of silently looking like a deliberate skip. */
	error?: string;
}

/** One in-flight readiness run per project: sessions that start together never run two of these. */
const inFlight = new Map<string, Promise<ReadinessResult>>();

/**
 * Brings the index of the project Pi started in up to date, then, when an index exists, warms the daemon
 * so the first real call is fast. Background by design: never rejects, and the session never waits.
 */
export function prepareReadiness(input: ReadinessInput): Promise<ReadinessResult> {
	const existing = inFlight.get(input.cwd);
	if (existing) return existing;
	const started = (async (): Promise<ReadinessResult> => {
		try {
			// The narrowed gate: reload always skips, an ordinary child skips unless its cwd is its
			// own unindexed linked worktree — the only exception that un-skips a child. A child past
			// this gate can therefore only see action "init" or "none": childWorktreeNeedsIndex
			// requires indexState absent, which keeps planIndexAction off "sync".
			if (sessionSkipsReadiness(input.env, input.reason, input.cwd)) return { action: "none", ok: true, warm: "skipped" };
			const childWorktree = input.env[CHILD_ENV] === "1";
			const action = planIndexAction(input.cwd, indexState(input.cwd), input.isProjectRoot);
			if (action === "none") return { action, ok: true, warm: "skipped" };
			try { input.onStart?.(action); } catch { /* never worth stopping the index */ }
			let ok: boolean;
			const syncInfo = lastInfoSink();
			let standDown = false;
			let alive = false;
			if (action === "sync") {
			// A live daemon holds the writer lock and its index is never stale: a CLI `sync -q` coexists
			// with it (daemon.log auto-syncs) — "if an index exists, do not re-index — only sync". Without
			// a live daemon, only the sync-lease holder refreshes (daemonlessRefresh decides); nothing is
			// unlocked first, because CodeGraph's own FileLock reclaims stale locks itself and an unlock
			// could remove a live owner's lock.
				try { alive = daemonFor(input.cwd, input.registryDir).alive; } catch { /* not alive */ }
				if (alive) {
					ok = await runSyncWithRetry(input.run, input.cwd, input.sleep ?? defaultSyncSleep, syncInfo.sink);
				} else {
					// Daemon-less: only the sync-lease holder refreshes (daemonlessRefresh decides).
					const refreshed = await daemonlessRefresh(input.cwd, { run: input.run, locksDir: input.locksDir, sink: syncInfo.sink });
					if (refreshed.kind === "held-live") {
						// The holder may still be mid-sync: the warm-up stands down rather than racing the other
						// session's refresh. The ok verdict is unchanged: another session refreshing is not this
						// session failing.
						standDown = true;
					}
					ok = daemonlessOk(refreshed);
				}
			} else {
				// The init lock keeps two sessions on one fresh project from building the same index
				// twice; after acquiring, the state is re-checked — another init may have finished
				// while this one waited for the lock.
				// A linked worktree with a main-checkout index is seeded (snapshot + sync) instead
				// of initialized: seeded and target-exists stand done, deferred fails closed like
				// a skipped lock, seed-failed stands down, and not-seedable — no parent index — is
				// a fresh project that falls through to the ordinary init path.
				let seeded: { outcome: SeedOutcome } | undefined;
				if (input.seed) seeded = await input.seed(input.cwd);
				if (seeded !== undefined && (seeded.outcome === "seeded" || seeded.outcome === "target-exists")) {
					ok = true;
				} else if (seeded?.outcome === "main-busy") {
					// The main checkout's own index is being created right now: nothing failed,
					// but there is no index to warm either.
					ok = true;
					standDown = true;
				} else if (seeded?.outcome === "deferred") {
					ok = false;
				} else if (seeded?.outcome === "seed-failed") {
					// AGENTS.md: "init is for fresh projects without a parent index" — a failed
					// copy of an existing parent index stands down; the worktree is never initialized.
					ok = false;
				} else {
					const lock = await acquireInitLock(input.cwd, {
						locksDir: input.locksDir,
						waitMs: input.initLockWaitMs,
					});
					if (lock.outcome === "acquired") {
						try {
							// The post-lock recheck is tri-state explicit: only a confirmed absence may
							// initialize. "present" means another init finished while this one waited;
							// "unknown" means the index cannot be confirmed, which is a fail-closed
							// report — never a green light to initialize.
							const rechecked = indexState(input.cwd);
							if (rechecked === "present") ok = true;
							else if (rechecked === "absent") ok = await input.run(["init", "-y"], input.cwd, INIT_TIMEOUT_MS, (pid, proxy) => lock.adopt(pid, proxy));
							else ok = false;
						} finally {
							lock.release();
						}
					} else {
						ok = lock.outcome === "present";
					}
				}
			}
			try { input.onIndexed?.(action === "sync" ? { action, ok, daemonAlive: alive, ...(syncInfo.get() ?? {}) } : { action, ok }); } catch { /* never worth stopping the warm-up */ }
			// A child that just seeded or initialised its own worktree never warms a daemon: it must
			// not reach for the parent-shared project daemon at session start, and maybeRewarm
			// already covers its queries lazily.
			if (childWorktree) return { action, ok, warm: "skipped" };
			// A failed sync still leaves an index to warm; a failed init leaves nothing worth warming.
			if (standDown || !(action === "sync" || (action === "init" && ok))) return { action, ok, warm: "skipped" };
			try { input.onWarmStart?.(); } catch { /* never worth stopping the warm-up */ }
			try {
				return { action, ok, warm: (await input.warm(input.cwd)) ? "ok" : "failed" };
			} catch {
				return { action, ok, warm: "failed" };
			}
		} catch (error: unknown) {
			// An unexpected exception is not a deliberate skip: carry its reason so the session
			// surfaces it instead of silently reporting that nothing happened.
			return { action: "none", ok: false, warm: "skipped", error: firstLineOf(error, 200) };
		}
	})();
	// The entry is removed when the REGISTERED promise settles, never inside the body: a body
	// that settles before its first await (reload skip, action "none", a synchronous exception)
	// would run that finally during the IIFE call itself — before the set below stores it — and
	// the settled promise would then stay cached for the rest of the process.
	const registered = started.finally(() => {
		inFlight.delete(input.cwd);
	});
	inFlight.set(input.cwd, registered);
	return registered;
}

export interface SearchSyncInput {
	cwd: string;
	/** The daemon registry consulted for liveness; the default is CodeGraph's own. */
	registryDir?: string;
	/** Where the cross-session sync lease token lives; the default is CodeGraph's own locks dir. */
	locksDir?: string;
	run: CodegraphRun;
	/** Sleeps the live-daemon sync retry backoff; injectable for tests. */
	sleep?(ms: number): Promise<void>;
	onFailed?(stage: "lease" | "sync", info: { daemonAlive: boolean; exitCode?: number | null; stderrTail?: string }): void;
	/** Surfaces an unexpected exception from the refresh itself (not a command failure). */
	onError?(reason: string): void;
}

/** One in-flight search sync per cwd: calls that arrive together never run two jobs. */
const searchSyncInFlight = new Map<string, Promise<void>>();

/**
 * Refreshes the index before a search and resolves once that refresh has settled: sync -q only.
 * A live daemon holds the writer lock and is never stale, and a CLI sync coexists with it
 * (daemon.log auto-syncs); without one, the sync lease decides who refreshes. A call that arrives
 * while a refresh is in flight resolves with that same job instead of starting another. The whole
 * refresh — attempts and backoff together — stays within one sync timeout. Never rejects; failures
 * surface only through onFailed.
 */
export function syncBeforeSearch(input: SearchSyncInput): Promise<void> {
	const running = searchSyncInFlight.get(input.cwd);
	if (running) return running;
	const job = (async (): Promise<void> => {
		const sleep = input.sleep ?? defaultSyncSleep;
		const info = lastInfoSink();
		try {
			let alive = false;
			try { alive = daemonFor(input.cwd, input.registryDir).alive; } catch { /* not alive */ }
			if (alive) {
				const synced = await runSyncWithRetry(input.run, input.cwd, sleep, info.sink);
				if (!synced) input.onFailed?.("sync", { daemonAlive: true, ...(info.get() ?? {}) });
				return;
			}
			// Daemon-less: the sync lease decides who refreshes (daemonlessRefresh decides). A live
			// lease in another session means zero CLI calls here.
			const outcome = await daemonlessRefresh(input.cwd, { run: input.run, locksDir: input.locksDir, sink: info.sink });
			if (outcome.kind === "writing" || outcome.kind === "held-live") return;
			if (outcome.kind === "lease-blocked") {
				// A damaged or unreadable lease is nobody's refresh: this session reports the blocked
				// refresh instead of silently skipping it.
				input.onFailed?.("lease", { daemonAlive: false });
				return;
			}
			if (!outcome.synced) input.onFailed?.("sync", { daemonAlive: false, ...(info.get() ?? {}) });
		} catch (error: unknown) {
			// Command failures flow through onFailed; an exception from the refresh itself would
			// otherwise vanish with the detached job — surface its reason instead.
			input.onError?.(firstLineOf(error, 200));
		} finally {
			searchSyncInFlight.delete(input.cwd);
		}
	})();
	searchSyncInFlight.set(input.cwd, job);
	return job;
}

/**
 * Kills the spawned command and, on Windows, its whole tree. The shell:true spawn there returns the
 * cmd.exe wrapper's pid, and killing only the wrapper would orphan the real codegraph process, which
 * would keep writing the shared index after the failure has already been reported. On POSIX the child
 * is the command itself, so a direct kill reaches it. `signal` (default SIGTERM) feeds the POSIX group
 * and direct kills, so the grace-window escalation can raise it to SIGKILL; Windows taskkill is /F.
 */
function killProcessTree(child: { pid?: number } | undefined, group = false, signal: NodeJS.Signals = "SIGTERM"): void {
	if (child?.pid === undefined) return;
	if (process.platform === "win32") {
		execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {
			/* already gone: the grace timer reports the failure anyway; windowsHide keeps the kill invisible */
		});
		return;
	}
	try {
		// A detached child leads its own process group: the negative pid takes the command's
		// workers with it instead of orphaning them under a killed leader.
		if (group) process.kill(-child.pid, signal);
		return;
	} catch {
		/* no such group (or not detached): fall through to the direct kill */
	}
	try {
		process.kill(child.pid, signal);
	} catch {
		/* already gone */
	}
}

/** One codegraph command run's captured result: the ok verdict, the exit code, the bounded
 * stderr tail, and the captured stdout — whole when the caller asked for an unbounded capture
 * (the seed's tracked-file listing parses JSON a 2,000-character tail could truncate). */
interface CommandRun {
	ok: boolean;
	exitCode?: number | null;
	stderrTail?: string;
	stdout: string;
}

/**
 * Runs the codegraph CLI with fixed arguments for the project in `cwd`, from the temp directory with the
 * project as the last argument spelled as its daemon registered it (another spelling starts another
 * daemon). On Windows the npm `.cmd` shim needs a shell. A timeout kills the child and only reports the
 * failure once that process is gone: its pid must not outlive the result — and the timeout is recorded
 * when it fires, so a command that handles the kill signal and still exits 0 is reported as failed.
 */
function runCodegraphCommand(args: readonly string[], cwd: string, timeoutMs: number, opts: { stdoutChars?: number; onSpawn?: (pid: number, proxy: boolean) => void; onInfo?: (info: CodegraphCommandInfo) => void }): Promise<CommandRun> {
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		let grace: ReturnType<typeof setTimeout> | undefined;
		let exitCode: number | null | undefined;
		let stderrTail = "";
		let stdoutKept = "";
		const stdoutChars = opts.stdoutChars;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (grace !== undefined) clearTimeout(grace);
			opts.onInfo?.({ ok, exitCode, stderrTail: stderrTail.length > 0 ? stderrTail : undefined, stdoutTail: stdoutKept.length > 0 ? stdoutKept.slice(-2_000) : undefined });
			resolve({ ok, exitCode, stderrTail: stderrTail.length > 0 ? stderrTail : undefined, stdout: stdoutKept });
		};
		let child: ReturnType<typeof spawn> | undefined;
		try {
			let project: string;
			try {
				project = projectSpelling(daemonFor(cwd), cwd);
			} catch {
				/* not alive: no registry, so the command simply runs for the real project path */
				project = realpathSync(cwd);
			}
			child = spawnCodegraph([...args, project], ["ignore", "pipe", "pipe"]);
		} catch (error) {
			// A refused spawn — cmd.exe cannot carry a literal percent through the .cmd shim — is
			// a diagnosable failure, not a silent one: the sink sees why no command ran.
			opts.onInfo?.({ ok: false, stderrTail: firstLineOf(error, 200) });
			resolve({ ok: false, stdout: "" });
			return;
		}
		if (child !== undefined && child.pid !== undefined) {
			try { opts.onSpawn?.(child.pid, process.platform === "win32"); } catch { /* bookkeeping is best effort */ }
		}
		// One persistent decoder per stream: a multibyte UTF-8 character split across Buffer chunks
		// corrupts into replacement characters under a per-chunk toString (the same class as the
		// daemon's line reader), and the seed's tracked-file identities compare decoded strings.
		const stderrDecoder = new StringDecoder("utf8");
		child?.stderr?.on("data", (chunk: Buffer) => {
			// Only the tail is ever shown: keep the last slice, never the whole stream.
			stderrTail = (stderrTail + stderrDecoder.write(chunk)).slice(-2_000);
		});
		const stdoutDecoder = new StringDecoder("utf8");
		child?.stdout?.on("data", (chunk: Buffer) => {
			// The pipe is always drained (a full one would block the child). Diagnostics only ever
			// need the bounded tail; the seed's tracked-file listing is the one caller that parses
			// structured output, so its capture runs unbounded — a tail could truncate the JSON.
			const text = stdoutDecoder.write(chunk);
			stdoutKept = stdoutChars === undefined ? stdoutKept + text : (stdoutKept + text).slice(-stdoutChars);
		});
		const timer = setTimeout(() => {
			// The deadline expired: whatever exit code follows, the run is failed.
			timedOut = true;
			killProcessTree(child, true);
			// A killed command may still be closing; report the failure only once the process is
			// gone — and one that ignored SIGTERM is escalated to the unignorable SIGKILL after a
			// short grace, not the whole KILL_WAIT_MS, so a stubborn tree cannot delay the result;
			// KILL_WAIT_MS stays the absolute cap for a close that never comes (a descendant
			// holding the pipe), so the pid can never outlive the result and keep writing an
			// index no lease covers any more.
			grace = setTimeout(() => {
				killProcessTree(child, true, "SIGKILL");
				grace = setTimeout(() => finish(false), KILL_WAIT_MS);
			}, KILL_ESCALATE_MS);
		}, timeoutMs);
		child?.on("error", () => finish(false));
		child?.on("close", (code: number | null) => {
			exitCode = code;
			// A zero exit code counts only when the deadline did not expire first: a command that
			// handles the timeout's SIGTERM and exits 0 was still interrupted by the timeout.
			finish(!timedOut && code === 0);
		});
	});
}

/** The public boolean contract every injected CodegraphRun speaks: one bounded-tail command run. */
export function runCodegraph(args: readonly string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number, proxy: boolean) => void, onInfo?: (info: CodegraphCommandInfo) => void): Promise<boolean> {
	return runCodegraphCommand(args, cwd, timeoutMs, { stdoutChars: 2_000, onSpawn, onInfo }).then((run) => run.ok);
}

/** The tracked-file count a `codegraph status <project>` run reports, or undefined when the
 * output carries no readable count: a torn or corrupt database cannot prove anything. */
export function indexedFileCount(statusOutput: string): number | undefined {
	const match = /(?:^|\n)[ \t]*Files:[ \t]*([\d,]+)/.exec(statusOutput);
	if (match === null) return undefined;
	const count = Number(match[1].replaceAll(",", ""));
	return Number.isFinite(count) ? count : undefined;
}

/** Whether `cwd` is a seed's staging project (`<worktree>/.codegraph/seed-<random>` holding the
 * staged `.codegraph/codegraph.db`): the one call whose validating sync must see the target
 * worktree's sources instead of the deliberately source-less staging directory. */
function isSeedStagingRoot(cwd: string): boolean {
	return basename(cwd).startsWith("seed-") && basename(dirname(cwd)) === ".codegraph" && existsSync(join(cwd, ".codegraph", "codegraph.db"));
}

/** Makes the staging project see the target worktree's real sources: one link per top-level
 * entry, everything except `.codegraph` (the staged copy lives there). The scanner follows the
 * links, so the validating sync reconciles the staged index against the worktree's own files
 * rather than against an empty project — the emptied-index failure mode. Directories become
 * symlinks (junctions on Windows, where they need no privilege), regular files become hardlinks
 * (no privilege either, and the staging root lives inside the worktree so both share a volume);
 * the seed's staging cleanup unlinks the links without ever following them. */
function materializeStagingSources(worktree: string, stagingRoot: string): void {
	for (const entry of readdirSync(worktree, { withFileTypes: true })) {
		if (entry.name === ".codegraph") continue;
		const target = join(worktree, entry.name);
		const link = join(stagingRoot, entry.name);
		if (entry.isDirectory()) symlinkSync(target, link, process.platform === "win32" ? "junction" : undefined);
		else if (entry.isFile()) linkSync(target, link);
		else symlinkSync(target, link);
	}
}

/** One `codegraph files --format flat -j -p <project>` read of the staged index's tracked-file
 * identities — the CLI prints one {path} record per tracked entry as a JSON array. The capture
 * is unbounded: a 2,000-character tail could truncate the listing's JSON. Undefined when the
 * listing cannot be read: a torn or corrupt database cannot prove anything. */
async function stagedTrackedPaths(cwd: string, onSpawn?: (pid: number, proxy: boolean) => void, onInfo?: (info: CodegraphCommandInfo) => void): Promise<Set<string> | undefined> {
	const run = await runCodegraphCommand(["files", "--format", "flat", "-j", "-p"], cwd, SYNC_TIMEOUT_MS, { onSpawn, onInfo });
	if (!run.ok) return undefined;
	try {
		const parsed: unknown = JSON.parse(run.stdout);
		if (!Array.isArray(parsed)) return undefined;
		const paths = new Set<string>();
		for (const entry of parsed) {
			if (typeof (entry as { path?: unknown }).path !== "string") return undefined;
			paths.add((entry as { path: string }).path);
		}
		return paths;
	} catch {
		return undefined;
	}
}

/**
 * The seed's validating-sync runner: `codegraph sync -q` for the staging project, run against the
 * target worktree's real sources, reporting the SeedSyncReport object form. `sync -q` prints
 * nothing (probed: it is quiet even while dropping every entry), so removal is detected by a
 * before/after tracked-file-identity probe through `codegraph files --format flat -j` — the same CLI: an exit-0
 * sync that still dropped entries copied an index that does not match the worktree's files, and
 * the seed must fail instead of publishing it. Any step that cannot prove the copy — a staging
 * whose sources cannot be linked, a listing that cannot be read — fails closed with ok=false, and
 * every other call shape keeps runCodegraph's plain boolean contract.
 */
export function runCodegraphSeedSync(args: readonly string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number, proxy: boolean) => void, onInfo?: (info: CodegraphCommandInfo) => void): Promise<SeedSyncReport> {
	if (args.length !== 2 || args[0] !== "sync" || args[1] !== "-q" || !isSeedStagingRoot(cwd)) {
		return runCodegraph(args, cwd, timeoutMs, onSpawn, onInfo);
	}
	return (async (): Promise<SeedSyncReport> => {
		try {
			materializeStagingSources(dirname(dirname(cwd)), cwd);
		} catch {
			return { ok: false, removedEntries: false };
		}
		const before = await stagedTrackedPaths(cwd, onSpawn, onInfo);
		if (before === undefined) return { ok: false, removedEntries: false };
		if (!(await runCodegraph(args, cwd, timeoutMs, onSpawn, onInfo))) return { ok: false, removedEntries: false };
		const after = await stagedTrackedPaths(cwd, onSpawn, onInfo);
		// An after-listing that cannot be read cannot prove the entries survived: fail closed.
		// Identities, never the net count: a sync that swaps one entry for another keeps the
		// count but still dropped a tracked entry, and the report must say so.
		return { ok: true, removedEntries: after === undefined || [...before].some((path) => !after.has(path)) };
	})();
}

/**
 * Lazy re-warm for tool calls: when the project's daemon is not alive any more, warm it in the background
 * so the NEXT query is fast again. Never blocks, never throws; a warm-up still running never keeps the
 * caller alive.
 */
export function maybeRewarm(
	cwd: string,
	warm: (cwd: string) => Promise<boolean> = (project) => warmUpDaemon(project, true),
	registryDir?: string,
): void {
	try {
		const daemon = daemonFor(cwd, registryDir);
		if (!daemon.alive) void warm(daemon.root ?? cwd).catch(() => { /* best effort */ });
	} catch { /* never worth failing a query over */ }
}
