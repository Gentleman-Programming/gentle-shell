import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { copyFile, cp, link, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { daemonFor, daemonHealth, mcpCallRequests, mcpCallText, mcpInitializeRequest, mcpLineReader, mcpReplyKind, projectSpelling } from "./codegraph-daemon.ts";
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
export const WARMUP_TIMEOUT_MS = 120_000;
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
	/** A timed-out run whose Windows tree kill never reported a confirmed termination: a
	 * process of that run may still be writing the index, so no caller may retry beside it. */
	teardownUnconfirmed?: boolean;
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
	// A suspended host can resume past the deadline mid-backoff: a retry with a nonpositive
	// budget would still start a real child and run its whole timeout cleanup for nothing —
	// the first failure stands.
	if (deadline - Date.now() <= 0) return false;
	// A `.codegraph` that became a link during the backoff is another checkout's index by now —
	// the same directory a fresh refresh would refuse — so the retry must not lower the guard
	// the first attempt ran under.
	if (!safeIndexDirectory(cwd)) return false;
	const remaining = deadline - Date.now();
	if (remaining <= 0) return false;
	return attempt(remaining);
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
/** The silent retries a failed session-start init run gets inside the held init lock: one
 * initial attempt plus this many. Each attempt draws its own full INIT_TIMEOUT_MS budget and
 * reports its spawn to the lease; only the exhausted failure reaches the user. */
export const INIT_RETRY_COUNT = 3;
/** How long a killed command may take to be gone before the timeout is reported anyway. */
const KILL_WAIT_MS = 10_000;
/** Grace a timed-out command gets to obey SIGTERM before the unignorable SIGKILL ends its tree. */
const KILL_ESCALATE_MS = 1_000;
/** The init lease must outlive every attempt the held-lock retry loop can spend: each attempt
 * draws its full INIT_TIMEOUT_MS and, when it times out, the runner's SIGKILL grace and kill
 * wait before the next one starts. A lease covering only a single attempt expires mid-sequence
 * and a retry would spawn its `init -y` under a lock another session has lawfully reclaimed —
 * the sequence's bounded worst case is therefore the lease TTL. */
const INIT_LOCK_SEQUENCE_TTL_MS = (INIT_RETRY_COUNT + 1) * (INIT_TIMEOUT_MS + KILL_ESCALATE_MS + KILL_WAIT_MS);
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


/** How long an early-exiting warm-up child waits for another session's daemon to appear: the
 * lock loser of two racing sessions exits while the winner is still starting. */
const LOCK_LOSER_ADOPT_MS = 5_000;
/** How often the lock-loser adoption poll re-reads the daemon registry for the winner. */
const LOCK_LOSER_POLL_MS = 250;

/** The warm gate's verdict: ok says the daemon is warm, wedged names the state where the
 * daemon is alive and holds the daemon lock but never answers — no spawn ran, so nothing was
 * killed or replaced — and adopted marks a spawn that lost the daemon lock to a racing
 * session's winner and settled on that winner's daemon once it verified an answer, never on
 * liveness alone. */
export type WarmUpOutcome = { ok: boolean; wedged?: boolean; adopted?: boolean };

/**
 * Makes the project's CodeGraph daemon open its database and start a read worker, so the next real call
 * is fast: talks MCP to `codegraph serve --mcp -p <project>` started from the temp directory (cmd.exe
 * cannot take a UNC working directory), then destroys the pipes and unrefs the child so the server goes
 * on alone as the daemon — it is shared with the user's other sessions, so it is never killed. When a
 * daemon is already alive there is nothing to warm: the alive short-circuit is probe-verified — one
 * health check must actually answer before the warm-up resolves true, still with no spawn — and a
 * wedged daemon resolves { ok: false, wedged: true } with no spawn either, because a fresh serve would
 * lose the daemon lock to the wedged holder. A spawn that loses the daemon lock to a racing session's
 * winner exits at once — its lock message goes to the daemon's own log (stdio for stderr is "ignore"),
 * so nothing arriving through the pipes identifies it — and the exit polls the registry for the
 * winner's live daemon, a candidate until one real health probe answers — the same verification
 * the alive short-circuit demands — resolving { ok: true, adopted: true } only for a winner that
 * actually serves inside the adoption window. Never rejects;
 * `background` unrefs everything so a warm-up still running never keeps its caller alive.
 */
export async function warmUpDaemonDetailed(cwd: string, background = false, timeoutMs = WARMUP_TIMEOUT_MS, registryDir?: string, helloTimeoutMs?: number, adoptWindowMs?: number): Promise<WarmUpOutcome> {
	// A daemon that is already alive is already warm: a second `serve --mcp` cannot take the daemon
	// lock and only logs "Could not acquire the daemon lock; exiting" (26+ such lines in daemon.log)
	// — the same early exit a racing loser takes below, where the winner's appearance adopts it.
	// No spawn, no handshake — with the health probe answered it resolves at once.
	let daemon: DaemonInfo;
	try {
		daemon = daemonFor(cwd, registryDir);
		if (daemon.alive) {
			const health = await daemonHealth(cwd, registryDir, helloTimeoutMs);
			if (health === "ok") return { ok: true };
			// Wedged: the daemon holds the daemon lock and cannot serve, and a fresh serve would
			// only lose that lock to the wedged holder — no kill, no respawn, an explicit outcome
			// the caller warns about and bypasses.
			if (health === "wedged") return { ok: false, wedged: true };
			// Unreachable: the record is effectively dead — the spawn path below starts a new daemon.
		}
	} catch {
		/* an unreadable registry is no reason to skip the warm-up */
		daemon = { alive: false, root: undefined };
	}
	const adoptionWindow = adoptWindowMs ?? LOCK_LOSER_ADOPT_MS;
	const result = await new Promise<"ok" | "adopted" | "failed">((resolve) => {
		let settled = false;
		let timedOut = false;
		let child: ReturnType<typeof spawn> | undefined;
		let escalate: ReturnType<typeof setTimeout> | undefined;
		let adoptTimer: ReturnType<typeof setTimeout> | undefined;
		// An unresolvable cwd — deleted between the readiness pass and here — has no real path to
		// serve: settle false at once instead of letting realpathSync reject the never-rejects promise.
		let project: string;
		try {
			project = projectSpelling(daemon, cwd);
		} catch {
			resolve("failed");
			return;
		}
		const settle = (outcome: "ok" | "adopted" | "failed") => {
			if (settled) return;
			// A settlement that lands after the deadline — while the timed-out child is still being
			// torn down — settles the missed warm-up as failed, never as a late success.
			if (timedOut && outcome !== "failed") outcome = "failed";
			settled = true;
			clearTimeout(timer);
			if (adoptTimer !== undefined) clearTimeout(adoptTimer);
			// An early settlement does not cancel the kill escalation: a child that ignores SIGTERM
			// must still be SIGKILLed before it can keep holding the daemon lock.
			if (!timedOut && escalate !== undefined) clearTimeout(escalate);
			// Destroy, not end: an ended pipe still holds the event loop until the server exits.
			try { child?.stdin?.destroy(); } catch { /* already closed */ }
			try { child?.stdout?.destroy(); } catch { /* already gone */ }
			child?.unref();
			resolve(outcome);
		};
		const finish = (ok: boolean) => settle(ok ? "ok" : "failed");
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
		// The lock loser of two racing sessions closes here at once: it lost the daemon lock to
		// the winner and its lock message went to the daemon's own log (stderr is ignored), so
		// nothing arriving through these pipes identifies it. Liveness separates that exit from
		// a real failure: poll the registry for the winner's live daemon — registered, pid
		// alive, socket present — and treat it as a candidate the same health probe as the alive
		// short-circuit must confirm before the adoption settles. A winner that has not
		// answered yet keeps its chances inside the window; one that never answers, like no
		// winner appearing at all, is the failed warm-up of a child that exited for no better
		// reason.
		child.on("close", () => {
			if (settled) return;
			const deadline = Date.now() + adoptionWindow;
			const scheduleNext = () => {
				if (Date.now() >= deadline) {
					settle("failed");
					return;
				}
				adoptTimer = setTimeout(poll, LOCK_LOSER_POLL_MS);
				if (background) adoptTimer.unref?.();
			};
			const poll = () => {
				// The overall timeout or another settlement path may have finished between ticks.
				if (settled) return;
				if (Date.now() >= deadline) {
					settle("failed");
					return;
				}
				let alive = false;
				try {
					alive = daemonFor(cwd, registryDir, undefined, deadline).alive;
				} catch {
					/* an unreadable registry holds no winner to adopt */
				}
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					settle("failed");
					return;
				}
				if (alive) {
					// The winner is a candidate, not a verdict: liveness alone would adopt a wedged
					// winner — the same daemon the warm gate at the start of this call reports as
					// wedged. One real answer adopts it; anything else keeps polling for a winner
					// that can actually serve, within the remaining window the overall timeout caps.
					void daemonHealth(cwd, registryDir, helloTimeoutMs, remaining).then(
						(health) => {
							if (settled) return;
							if (health === "ok" && Date.now() < deadline) {
								settle("adopted");
								return;
							}
							scheduleNext();
						},
						() => {
							if (settled) return;
							scheduleNext();
						},
					);
					return;
				}
				scheduleNext();
			};
			poll();
		});
		child.stdin?.on("error", () => { /* the server exited first */ });
		send(mcpInitializeRequest(pathToFileURL(project).href));
	});
	return result === "adopted" ? { ok: true, adopted: true } : { ok: result === "ok" };
}

/** The boolean warm-up contract every existing caller speaks; warmUpDaemonDetailed carries the detail. */
export function warmUpDaemon(cwd: string, background = false, timeoutMs = WARMUP_TIMEOUT_MS, registryDir?: string): Promise<boolean> {
	return warmUpDaemonDetailed(cwd, background, timeoutMs, registryDir).then((outcome) => outcome.ok);
}

// The tri-state index check lives in the lease module now (the init lock waits on it); re-exported
// here because readiness's own API and its importers (tools, session-seed, tests) speak it from here.
export { indexState, type IndexState } from "./codegraph-lease.ts";

export type IndexAction = "sync" | "init" | "none";
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/** Whether `cwd`'s `.codegraph` is safe for an automatic refresh or initialization: a regular
 * directory, or no `.codegraph` at all. A symlinked one is another checkout's index — the same
 * shape the explicit tool refuses — and CodeGraph itself follows the link, so an automatic sync,
 * warm-up, or init must never write into it: an empty linked directory reports "absent", and
 * init -y would create the other checkout's database through the link. */
function safeIndexDirectory(cwd: string): boolean {
	try {
		const index = lstatSync(join(cwd, ".codegraph"));
		return !index.isSymbolicLink() && index.isDirectory();
	} catch (error) {
		// Only a confirmed absence is safe; any other stat failure — permissions, an unreadable
		// parent — proves nothing about what `.codegraph` is, and the refresh fails closed instead
		// of writing into a directory it could not see.
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/** An existing index is synced; a fresh git project with a marker file is initialised; anything else is left alone. */
export function planIndexAction(cwd: string, state: IndexState, isProjectRoot: (cwd: string) => boolean): IndexAction {
	// The link refusal covers the absent case too: an empty linked `.codegraph` reports "absent",
	// and init -y would create the other checkout's database through the link — no action at all
	// is selected for a directory this workspace does not own.
	if (!safeIndexDirectory(cwd)) return "none";
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
	seed?(cwd: string): Promise<{ outcome: SeedOutcome; error?: string }>;
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
	onIndexed?(result: {
		action: IndexAction;
		ok: boolean;
		daemonAlive?: boolean;
		exitCode?: number | null;
		stderrTail?: string;
		/** How many `codegraph init` runs the held-lock loop attempted (one initial plus silent retries); present only when that loop ran. */
		initAttempts?: number;
		/** Why the held-lock loop stopped short of a success: "teardown-unconfirmed" means an attempt's tree could not be proved gone, so the sequence ended beside a possible writer instead of running out its retries. */
		initStop?: "teardown-unconfirmed";
	}): void;
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
			// The child gate read "absent" a moment ago; another session publishing the index in that
			// window turns the plan into "sync". A child never syncs — it stands down and leaves the
			// index to the session that just published it.
			if (childWorktree && action === "sync") return { action: "none", ok: true, warm: "skipped" };
			try { input.onStart?.(action); } catch { /* never worth stopping the index */ }
			let ok: boolean;
			let seedError: string | undefined;
			const syncInfo = lastInfoSink();
			let standDown = false;
			let alive = false;
			let initAttempts: number | undefined;
			let initStop: "teardown-unconfirmed" | undefined;
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
				let seeded: { outcome: SeedOutcome; error?: string } | undefined;
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
					seedError = seeded.error;
				} else {
					const lock = await acquireInitLock(input.cwd, {
						locksDir: input.locksDir,
						waitMs: input.initLockWaitMs,
						// The lease covers the whole bounded retry sequence the loop below may run.
						ttlMs: INIT_LOCK_SEQUENCE_TTL_MS,
					});
					if (lock.outcome === "acquired") {
						try {
							// The post-lock recheck is tri-state explicit: only a confirmed absence may
							// initialize. "present" means another init finished while this one waited;
							// "unknown" means the index cannot be confirmed, which is a fail-closed
							// report — never a green light to initialize.
							const rechecked = indexState(input.cwd);
							if (rechecked === "present") ok = true;
							// The plan's link refusal, rechecked under the lock: a `.codegraph` that became a link
							// while this session waited is not this session's to initialize either.
							else if (rechecked === "absent" && safeIndexDirectory(input.cwd)) {
								// A failed init process is retried silently inside the SAME held lock — one
								// initial run plus up to INIT_RETRY_COUNT retries — before the session gives up
								// and the failure notice tells the user to run init by hand. A run that
								// resolves true ends the loop at once; a thrown run keeps the existing
								// semantics (no retry, the error surfaces). Unlike the sync retry, every
								// attempt draws its own full INIT_TIMEOUT_MS budget: a legitimately slow
								// first index must not eat the retries' time.
								// An attempt whose teardown could not be confirmed is the one exception: it ends the
								// sequence, because a silent retry would start a second init beside a writer of the
								// timed-out attempt that may still be running.
								const adoptChild = (pid: number, proxy: boolean): void => lock.adopt(pid, proxy);
								ok = false;
								for (let attempt = 1; attempt <= INIT_RETRY_COUNT + 1 && !ok; attempt += 1) {
									initAttempts = attempt;
									let teardownUnconfirmed = false;
									ok = await input.run(["init", "-y"], input.cwd, INIT_TIMEOUT_MS, adoptChild, (info) => {
										teardownUnconfirmed = info.teardownUnconfirmed === true;
									});
									// A failure the loop does not retry past the first teardown it could not confirm: a retry
									// starts a second init beside a writer of the timed-out attempt that may still be running.
									if (!ok && teardownUnconfirmed) {
										initStop = "teardown-unconfirmed";
										break;
									}
								}
							}
							else ok = false;
						} finally {
							lock.release();
						}
					} else {
						ok = lock.outcome === "present";
					}
				}
			}
			try { input.onIndexed?.(action === "sync" ? { action, ok, daemonAlive: alive, ...(syncInfo.get() ?? {}) } : { action, ok, ...(initAttempts === undefined ? {} : { initAttempts }), ...(initStop === undefined ? {} : { initStop }) }); } catch { /* never worth stopping the warm-up */ }
			// A child that just seeded or initialised its own worktree never warms a daemon: it must
			// not reach for the parent-shared project daemon at session start, and maybeRewarm
			// already covers its queries lazily.
			if (childWorktree) return { action, ok, warm: "skipped", ...(seedError === undefined ? {} : { error: seedError }) };
			// A failed sync still leaves an index to warm; a failed init leaves nothing worth warming.
			if (standDown || !(action === "sync" || (action === "init" && ok))) return { action, ok, warm: "skipped", ...(seedError === undefined ? {} : { error: seedError }) };
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
	// A symlinked `.codegraph` is another checkout's index (the explicit tool refuses it too):
	// the automatic search refresh never writes into the linked database.
	if (!safeIndexDirectory(input.cwd)) return Promise.resolve();
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

/** The process view the kill and settlement decisions need: the platform, and the Windows
 * tree kill whose asynchronous completion a settlement must observe before it lands.
 * Injectable so the Windows settlement is observable off Windows; the default seam is the
 * real thing. */
export interface TreeKillSeam {
	platform(): NodeJS.Platform;
	/** Starts the Windows termination of pid's whole tree; onKilled runs exactly once when the
	 * attempt completes, with whether taskkill confirmed the termination. */
	windowsKill(pid: number, onKilled: (confirmed: boolean) => void): void;
}

/** How long the Windows tree kill helper may run before its outcome is reported unconfirmed.
 * A helper that wedges (a hung console host) must neither hold the killing process open nor
 * let a settlement take the stall for a completed teardown. */
const TASKKILL_BOUND_MS = 10_000;

/** The spawn the Windows tree kill starts taskkill through; injectable so a test can drive a
 * helper that never exits through the real adapter. */
export type TaskkillSpawn = (file: string, args: readonly string[], options: { stdio: "ignore"; windowsHide: true }) => ChildProcess;

/**
 * Terminates one process tree through taskkill and reports the outcome exactly once: true only
 * for a helper that exited 0, the one result that proves the tree is gone. A helper that cannot
 * start, exits with an error, or outstays TASKKILL_BOUND_MS reports false — unconfirmed — so the
 * caller keeps its index lease and never retries beside a writer that may still be running.
 * The helper carries no stdio and is unref'd, so a stalled one can never hold this process
 * open; a helper that is merely slow is left to finish, because aborting it would abandon a
 * half-terminated tree with nothing left to close it out.
 */
export function killWindowsTree(pid: number, onKilled: (confirmed: boolean) => void, options: { spawn?: TaskkillSpawn; boundMs?: number } = {}): void {
	const start = options.spawn ?? spawn;
	const bound = options.boundMs ?? TASKKILL_BOUND_MS;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const settle = (confirmed: boolean): void => {
		if (settled) return;
		settled = true;
		if (timer !== undefined) clearTimeout(timer);
		onKilled(confirmed);
	};
	try {
		// stdio "ignore": taskkill's output was never read, and pipes a stalled helper
		// would otherwise hold this process open after every settlement has landed.
		const child = start("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		child.on("error", () => settle(false));
		child.on("exit", (code) => settle(code === 0));
		timer = setTimeout(() => settle(false), bound);
		timer.unref?.();
		child.unref();
	} catch {
		// The spawn itself was refused: nothing ran, so the tree is not proved gone.
		settle(false);
	}
}

const realTreeKillSeam: TreeKillSeam = {
	platform: () => process.platform,
	windowsKill: (pid, onKilled) => killWindowsTree(pid, onKilled),
};

/** The kill seam tests replace to delay or withhold the Windows tree kill's completion. */
let treeKillSeamForTests: TreeKillSeam | undefined;

/** Installs the kill seam for tests; undefined restores the real one. */
export function setTreeKillSeamForTests(seam: TreeKillSeam | undefined): void {
	treeKillSeamForTests = seam;
}

const treeKillSeam = (): TreeKillSeam => treeKillSeamForTests ?? realTreeKillSeam;

/**
 * Kills the spawned command and, on Windows, its whole tree. The shell:true spawn there returns the
 * cmd.exe wrapper's pid, and killing only the wrapper would orphan the real codegraph process, which
 * would keep writing the shared index after the failure has already been reported. On POSIX the child
 * is the command itself, so a direct kill reaches it. `signal` (default SIGTERM) feeds the POSIX group
 * and direct kills, so the grace-window escalation can raise it to SIGKILL; Windows taskkill is /F.
 * The Windows kill is asynchronous: a caller whose settlement must not precede the tree's end passes
 * `onWindowsKilled` and gates that settlement on it (see waitForKilledGroup).
 */
function killProcessTree(child: { pid?: number } | undefined, group = false, signal: NodeJS.Signals = "SIGTERM", onWindowsKilled?: (confirmed: boolean) => void): void {
	if (child?.pid === undefined) return;
	const seam = treeKillSeam();
	if (seam.platform() === "win32") {
		// The seam reports whether taskkill confirmed the termination; the caller's settlement
		// keys on it, never on the callback alone.
		seam.windowsKill(child.pid, (confirmed) => {
			onWindowsKilled?.(confirmed);
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

/** How often a settled result re-probes a killed process group for its last member. */
const GROUP_GONE_POLL_MS = 20;
/** How long a settlement waits after the group SIGKILL for the last group member to be gone.
 * Members normally vanish within a poll tick; a PID 1 that never reaps orphans keeps dead
 * members enumerable forever, so the wait is capped, never unbounded. */
const GROUP_GONE_CAP_MS = 2_000;

/** SIGKILL delivery and orphan reaping lag the kill that sent them: a group kill that returned
 * has marked its members, not removed them. Holds the caller's settlement until the killed
 * group holds no member that can still run — `kill(-pgid, 0)` rejects exactly then: Darwin
 * already ignores unreaped zombies (which can neither run nor write), while Linux counts
 * them, so the wait there also covers reaping, capped for a PID 1 that never reaps. Windows
 * has no process groups to probe, and its taskkill /T /F runs asynchronously: the settlement
 * observes a CONFIRMED kill — `windowsKillDone`, wired by the caller from the kill helper's own
 * outcome — and is bounded by the same cap when that result cannot be confirmed,
 * so a caller never releases its index lease while members of the tree can still run. */
function waitForKilledGroup(pgid: number | undefined, capMs: number, isSettled: () => boolean, onGone: () => void, windowsKillDone?: () => boolean): void {
	if (pgid === undefined) {
		onGone();
		return;
	}
	const deadline = Date.now() + capMs;
	if (treeKillSeam().platform() === "win32") {
		const probe = () => {
			if (isSettled()) return;
			if ((windowsKillDone?.() ?? true) || Date.now() >= deadline) {
				onGone();
				return;
			}
			setTimeout(probe, GROUP_GONE_POLL_MS);
		};
		probe();
		return;
	}
	const probe = () => {
		if (isSettled()) return;
		let gone = false;
		try {
			process.kill(-pgid, 0);
		} catch {
			gone = true;
		}
		if (gone || Date.now() >= deadline) onGone();
		else setTimeout(probe, GROUP_GONE_POLL_MS);
	};
	probe();
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
 * failure once that process and its killed group are gone: no pid of the run can outlive the
 * result, not even in the window between a sent SIGKILL and its landing. The timeout is
 * recorded when it fires, so a command that handles the kill signal and still exits 0 is reported as failed.
 * A teardown that could not be confirmed is reported through the diagnostic sink, so no caller
 * starts another run beside a writer of the timed-out one that may still be running.
 */
function runCodegraphCommand(args: readonly string[], cwd: string, timeoutMs: number, opts: { stdoutChars?: number; onSpawn?: (pid: number, proxy: boolean) => void; onInfo?: (info: CodegraphCommandInfo) => void }): Promise<CommandRun> {
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		let teardownUnconfirmed = false;
		// Only a taskkill that reported success proves the tree is gone; every other outcome keeps
		// this false, so a settlement never claims a teardown nobody confirmed. A confirmation is
		// final for the run: a later attempt that fails only because an earlier one already removed
		// the tree must never downgrade a teardown that was proved.
		let windowsKillConfirmed = treeKillSeam().platform() !== "win32";
		/** Whether the run's single Windows tree kill attempt is still running. */
		let windowsKillInFlight = false;
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
			// The diagnostic sink is best effort: a throwing onInfo must not swallow the command's
			// actual outcome, or the caller holding a lease for this run would never resolve.
			try {
				opts.onInfo?.({ ok, exitCode, stderrTail: stderrTail.length > 0 ? stderrTail : undefined, stdoutTail: stdoutKept.length > 0 ? stdoutKept.slice(-2_000) : undefined, ...(teardownUnconfirmed ? { teardownUnconfirmed: true } : {}) });
			} catch {
				/* the resolved result below is the contract; the sink's failure is diagnostic only */
			}
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
			try {
				opts.onInfo?.({ ok: false, stderrTail: firstLineOf(error, 200) });
			} catch {
				/* best-effort diagnostic: the failure result below still resolves */
			}
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
		// Every path that needs the Windows tree gone — the timeout's kill, the grace escalation and
		// the close-time sweep — starts or joins ONE attempt at a time. taskkill cannot be escalated,
		// so a second helper beside a running one only races its result into the flag above, and an
		// attempt that fails because an earlier one already removed the tree must never overwrite the
		// confirmation that removal proved.
		const startWindowsKill = (): void => {
			if (windowsKillConfirmed || windowsKillInFlight) return;
			windowsKillInFlight = true;
			killProcessTree(child, true, "SIGKILL", (confirmed) => {
				windowsKillInFlight = false;
				if (confirmed) windowsKillConfirmed = true;
			});
		};
		// A failure settlement that also records whether the tree of the timed-out run was proved
		// gone: an unconfirmed kill must reach the caller, so it never retries beside a writer of
		// that tree. Such a tree may still be alive, so the settlement also drops this process's own
		// handles to it — the pipes and the child handle alone can hold the launcher open long after
		// the writer they belong to stopped mattering. Dropping them proves nothing about the
		// process: the unconfirmed verdict still keeps every caller from retrying beside it.
		const failWithTeardown = (): void => {
			if (!windowsKillConfirmed) {
				teardownUnconfirmed = true;
				child?.stdout?.destroy();
				child?.stderr?.destroy();
				child?.unref();
			}
			finish(false);
		};
		// One group SIGKILL and the settlement that observes it: a kill the seam confirmed releases
		// the settlement as soon as the group is empty, while an unconfirmed one (taskkill failed or
		// stalled) waits the cap and settles through the teardown report above. A settlement that
		// already landed needs no further kill.
		const killGroupAndWait = (capMs: number): void => {
			if (settled) return;
			if (treeKillSeam().platform() === "win32") startWindowsKill();
			else killProcessTree(child, true, "SIGKILL");
			waitForKilledGroup(child?.pid, capMs, () => settled, failWithTeardown, () => windowsKillConfirmed);
		};
		const timer = setTimeout(() => {
			// The deadline expired: whatever exit code follows, the run is failed.
			timedOut = true;
			// Windows takes one taskkill /F attempt here, shared with every later path; POSIX sends
			// SIGTERM first, so a command that handles it can still close on its own.
			if (treeKillSeam().platform() === "win32") startWindowsKill();
			else killProcessTree(child, true);
			// A killed command may still be closing; report the failure only once the process is
			// gone — and one that ignored SIGTERM is escalated to the unignorable SIGKILL after a
			// short grace, not the whole KILL_WAIT_MS, so a stubborn tree cannot delay the result;
			// KILL_WAIT_MS stays the absolute cap for a close that never comes (a descendant
			// holding the pipe), so the pid can never outlive the result and keep writing an
			// index no lease covers any more.
			grace = setTimeout(() => {
				// The escalation joins the run's Windows attempt (or starts the one still missing): its
				// completion is the termination result the settlement observes there, while POSIX needs
				// no such callback.
				grace = setTimeout(failWithTeardown, KILL_WAIT_MS);
				killGroupAndWait(KILL_WAIT_MS);
			}, KILL_ESCALATE_MS);
		}, timeoutMs);
		child?.on("error", () => finish(false));
		child?.on("close", (code: number | null) => {
			exitCode = code;
			// Group members that ignored SIGTERM must not outlive the reported result: the leader
			// can exit on the kill signal and close its stdio before the grace escalation fires, so
			// the close itself sends the group SIGKILL — a group with no remaining members rejects
			// the signal, and killProcessTree's existing catch ignores that.
			if (timedOut) {
				// The SIGKILL is sent, not awaited: hold the result until the killed group holds
				// no member that can still run, so no straggler can outlive the settlement.
				killGroupAndWait(GROUP_GONE_CAP_MS);
				return;
			}
			// A zero exit code counts only when the deadline did not expire first: a command that
			// handles the timeout's SIGTERM and exits 0 was still interrupted by the timeout.
			finish(code === 0);
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

/** Top-level trees the share copy fallback never stages: dependency installs and VCS metadata
 * are what the scanner ignores anyway, and copying them on a slow share would spend the
 * session's time and staging space on files no validating sync ever reads. */
const STAGING_COPY_SKIP = new Set(["node_modules", ".git"]);

/** Makes the staging project see the target worktree's real sources: one link per top-level
 * entry, everything except `.codegraph` (the staged copy lives there). The scanner follows the
 * links, so the validating sync reconciles the staged index against the worktree's own files
 * rather than against an empty project — the emptied-index failure mode. Directories become
 * symlinks (junctions on Windows, where they need no privilege); regular files become hard
 * links where the filesystem supports them (the staging root lives inside the worktree, so both
 * share a volume). A link the filesystem refuses — a Windows share takes no junction to a
 * remote directory, and a continuously available SMB 3.0 share takes no hard link either —
 * falls back to a copy instead of aborting the seed: the directory copy runs off the event
 * loop and skips the ignored trees, so a large dependency directory can neither block the
 * session nor eat staging space, and the validating sync still reconciles the same files with
 * the publication target untouched. The seed's staging cleanup unlinks links and copies alike
 * without ever following them. */
async function materializeStagingSources(worktree: string, stagingRoot: string): Promise<void> {
	for (const entry of await readdir(worktree, { withFileTypes: true })) {
		if (entry.name === ".codegraph") continue;
		const target = join(worktree, entry.name);
		const staged = join(stagingRoot, entry.name);
		if (entry.isDirectory()) {
			try {
				await symlink(target, staged, process.platform === "win32" ? "junction" : undefined);
			} catch {
				await cp(target, staged, { recursive: true, filter: (source) => !STAGING_COPY_SKIP.has(basename(source)) });
			}
		} else if (entry.isFile()) {
			try {
				await link(target, staged);
			} catch {
				await copyFile(target, staged);
			}
		} else await symlink(target, staged);
	}
}

/** The exact informational sentence `codegraph files` prints (exit 0, stdout) instead of `[]`
 * when the index holds no indexed files — the documented-by-source empty result. */
const EMPTY_INDEX_NOTICE = 'No files indexed. Run "codegraph index" first.';

/** The complete stdout of the supported CLI's empty case: the informational prefix plus the
 * notice, and nothing else. A listing that carries the notice next to any other output — a
 * torn JSON fragment, an extra line — proves nothing about the index and must never pass as a
 * confirmed-empty one. */
const EMPTY_INDEX_RESPONSE = `ℹ ${EMPTY_INDEX_NOTICE}`;

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
		// CodeGraph prints one informational line — not `[]` — when the index holds no files
		// (v1.6.0 bin: info('No files indexed. Run "codegraph index" first.'), exit 0, stdout):
		// exactly that line, and only it, is a confirmed-empty index whose path set is empty (the
		// validating sync may still add the worktree's files). Any other non-JSON output — the
		// notice with a torn fragment behind it included — stays unprovable and fails closed.
		return run.stdout.trim() === EMPTY_INDEX_RESPONSE ? new Set<string>() : undefined;
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
			await materializeStagingSources(dirname(dirname(cwd)), cwd);
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
