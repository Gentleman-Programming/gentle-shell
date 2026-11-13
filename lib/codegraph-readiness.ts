import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { daemonFor, mcpCallText, parseMcpReply } from "./codegraph-daemon.ts";
import type { DaemonInfo } from "./codegraph-daemon.ts";
import { acquireInitLock, codegraphWritingIndex, tryAcquireSyncLease } from "./codegraph-lease.ts";
import type { SeedOutcome } from "./codegraph-seed.ts";

/** A cold daemon on a network share can need over a minute for its first read. */
const WARMUP_TIMEOUT_MS = 120_000;
export const SYNC_TIMEOUT_MS = 120_000;
const INIT_TIMEOUT_MS = 600_000;
/** How long a killed command may take to be gone before the timeout is reported anyway. */
const KILL_WAIT_MS = 10_000;
/** The environment variable a subagent child carries; children never start an index operation of their own. */
export const CHILD_ENV = "GENTLE_PI_AGENTS_CHILD";
/** One of these next to a `.git` is what makes a directory a project worth indexing automatically. */
const MARKERS = ["composer.json", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts"];

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
		let child: ReturnType<typeof spawn> | undefined;
		const project = daemon.root ?? realpathSync(cwd);
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// Destroy, not end: an ended pipe still holds the event loop until the server exits.
			try { child?.stdin?.destroy(); } catch { /* already closed */ }
			try { child?.stdout?.destroy(); } catch { /* already gone */ }
			child?.unref();
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		if (background) timer.unref?.();
		try {
			if (process.platform === "win32") {
				// Windows needs a shell for the npm `.cmd` shim; the command line is fixed plus the quoted project.
				child = spawn(`codegraph serve --mcp -p ${JSON.stringify(project)}`, { cwd: tmpdir(), env: process.env, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
			} else {
				child = spawn("codegraph", ["serve", "--mcp", "-p", project], { cwd: tmpdir(), env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
			}
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
		let stage = 0;
		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				const message = parseMcpReply(line);
				if (message === undefined) continue;
				if (stage === 0 && message.id === 1) {
					send({ jsonrpc: "2.0", method: "notifications/initialized" });
					stage = 1;
					send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codegraph_explore", arguments: { query: "main" } } });
				} else if (stage === 1 && message.id === 2) {
					finish(mcpCallText(message) !== undefined);
				}
			}
		});
		child.on("error", () => finish(false));
		child.on("close", () => finish(false));
		child.stdin?.on("error", () => { /* the server exited first */ });
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gentle-shell", version: "0" }, rootUri: pathToFileURL(project).href },
		});
	});
}

/**
 * The index state per the repo's codegraph rules: an access error is unknown, NOT absent, and only a
 * confirmed-missing database file may be initialised. An index is the database file, never the directory.
 */
export type IndexState = "present" | "absent" | "unknown";

export function indexState(cwd: string): IndexState {
	try {
		return statSync(join(cwd, ".codegraph", "codegraph.db")).isFile() ? "present" : "absent";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
	}
}

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
	run(args: readonly string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number, proxy: boolean) => void): Promise<boolean>;
	/** Warms the daemon; true when it worked. */
	warm(cwd: string): Promise<boolean>;
	onStart?(action: IndexAction): void;
	onIndexed?(result: { action: IndexAction; ok: boolean }): void;
	onWarmStart?(): void;
}

export interface ReadinessResult {
	action: IndexAction;
	ok: boolean;
	warm: "ok" | "failed" | "skipped";
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
			if (skipsSession(input.env, input.reason)) return { action: "none", ok: true, warm: "skipped" };
			const action = planIndexAction(input.cwd, indexState(input.cwd), input.isProjectRoot);
			if (action === "none") return { action, ok: true, warm: "skipped" };
			try { input.onStart?.(action); } catch { /* never worth stopping the index */ }
			let ok: boolean;
			let standDown = false;
			if (action === "sync") {
				// A live daemon holds the writer lock and its index is never stale: a CLI `sync -q` coexists
				// with it (daemon.log auto-syncs), so it is never unlocked — "if an index exists, do not
				// re-index — only sync". Without a live daemon a stale lock can block the sync, so it is
				// cleared first, mirroring the repo's refresh discipline ("codegraph unlock && codegraph
				// sync"). That unlock is a precondition, not best-effort: when it fails, the sync does not
				// run and the failure is reported as the sync's own.
				let alive = false;
				try { alive = daemonFor(input.cwd, input.registryDir).alive; } catch { /* not alive */ }
				if (alive) {
					ok = await input.run(["sync", "-q"], input.cwd, SYNC_TIMEOUT_MS);
				} else if (codegraphWritingIndex(input.cwd)) {
					// CodeGraph itself is writing (any launcher): an unlock would drop its live lock.
					ok = true;
				} else {
					// Daemon-less: only the sync-lease holder refreshes. A live lease in another session
					// means that session is unlocking+syncing right now — an unlock here would clear its
					// live lock — so this session runs nothing and reports the refresh as handled.
					const lease = tryAcquireSyncLease(input.cwd, input.locksDir);
					if (!lease) {
						ok = true;
					} else {
						try {
							const unlocked = await input.run(["unlock"], input.cwd, SYNC_TIMEOUT_MS);
							ok = unlocked && await input.run(["sync", "-q"], input.cwd, SYNC_TIMEOUT_MS);
						} finally {
							lease.release();
						}
					}
				}
			} else {
				// The init lock keeps two sessions on one fresh project from building the same index
				// twice; after acquiring, the state is re-checked — another init may have finished
				// while this one waited for the lock.
				// A linked worktree with a main-checkout index is seeded (copy + sync) instead of
				// initialized: seeded and target-exists stand done, deferred fails closed like a
				// skipped lock, and every other outcome falls through to the ordinary init path.
				let seeded: { outcome: SeedOutcome } | undefined;
				if (input.seed) seeded = await input.seed(input.cwd);
				if (seeded !== undefined && (seeded.outcome === "seeded" || seeded.outcome === "target-exists")) {
					ok = true;
				} else if (seeded?.outcome === "main-busy") {
					// The main checkout is mid-write: nothing failed, but there is no index to warm either.
					ok = true;
					standDown = true;
				} else if (seeded?.outcome === "deferred") {
					ok = false;
				} else {
					const lock = await acquireInitLock(input.cwd, {
						locksDir: input.locksDir,
						waitMs: input.initLockWaitMs,
					});
					if (lock.outcome === "acquired") {
						try {
							ok = indexState(input.cwd) === "present" || await input.run(["init", "-y"], input.cwd, INIT_TIMEOUT_MS, (pid, proxy) => lock.adopt(pid, proxy));
						} finally {
							lock.release();
						}
					} else {
						ok = lock.outcome === "present";
					}
				}
			}
			try { input.onIndexed?.({ action, ok }); } catch { /* never worth stopping the warm-up */ }
			// A failed sync still leaves an index to warm; a failed init leaves nothing worth warming.
			if (standDown || !(action === "sync" || (action === "init" && ok))) return { action, ok, warm: "skipped" };
			try { input.onWarmStart?.(); } catch { /* never worth stopping the warm-up */ }
			try {
				return { action, ok, warm: (await input.warm(input.cwd)) ? "ok" : "failed" };
			} catch {
				return { action, ok, warm: "failed" };
			}
		} catch {
			return { action: "none", ok: false, warm: "skipped" };
		} finally {
			inFlight.delete(input.cwd);
		}
	})();
	inFlight.set(input.cwd, started);
	return started;
}

export interface SearchSyncInput {
	cwd: string;
	/** The daemon registry consulted for liveness; the default is CodeGraph's own. */
	registryDir?: string;
	/** Where the cross-session sync lease token lives; the default is CodeGraph's own locks dir. */
	locksDir?: string;
	run(args: readonly string[], cwd: string, timeoutMs: number): Promise<boolean>;
	onFailed?(stage: "unlock" | "sync"): void;
}

/** One in-flight search sync per cwd: calls that arrive together never run two jobs. */
const searchSyncInFlight = new Map<string, Promise<void>>();

/**
 * Refreshes the index before a search, in the background: sync -q, preceded by an unlock only when no
 * daemon is alive — a live daemon holds the writer lock and is never stale, and a CLI sync coexists
 * with it (daemon.log auto-syncs). Each run is within the sync timeout, and the unlock is a
 * precondition, not best-effort — when it runs and fails, the sync never runs. Never blocks and
 * never rejects; failures surface only through onFailed.
 */
export function syncBeforeSearch(input: SearchSyncInput): void {
	if (searchSyncInFlight.has(input.cwd)) return;
	const job = (async (): Promise<void> => {
		try {
			let alive = false;
			try { alive = daemonFor(input.cwd, input.registryDir).alive; } catch { /* not alive */ }
			if (alive) {
				const synced = await input.run(["sync", "-q"], input.cwd, SYNC_TIMEOUT_MS);
				if (!synced) input.onFailed?.("sync");
				return;
			}
			// Daemon-less: the sync lease decides who refreshes. A live lease in another session
			// means zero CLI calls here — an unlock would clear that session's live lock.
			if (codegraphWritingIndex(input.cwd)) return; // a live CodeGraph writer is never unlocked under
			const lease = tryAcquireSyncLease(input.cwd, input.locksDir);
			if (!lease) return;
			try {
				const unlocked = await input.run(["unlock"], input.cwd, SYNC_TIMEOUT_MS);
				if (!unlocked) {
					input.onFailed?.("unlock");
					return;
				}
				const synced = await input.run(["sync", "-q"], input.cwd, SYNC_TIMEOUT_MS);
				if (!synced) input.onFailed?.("sync");
			} finally {
				lease.release();
			}
		} catch {
			/* a detached job never surfaces; a rejection is not a stage failure */
		} finally {
			searchSyncInFlight.delete(input.cwd);
		}
	})();
	searchSyncInFlight.set(input.cwd, job);
}

/**
 * Kills the spawned command and, on Windows, its whole tree. The shell:true spawn there returns the
 * cmd.exe wrapper's pid, and killing only the wrapper would orphan the real codegraph process, which
 * would keep writing the shared index after the failure has already been reported. On POSIX the child
 * is the command itself, so a direct kill reaches it.
 */
function killProcessTree(child: { pid?: number } | undefined): void {
	if (child?.pid === undefined) return;
	if (process.platform === "win32") {
		execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {
			/* already gone: the grace timer reports the failure anyway; windowsHide keeps the kill invisible */
		});
		return;
	}
	try {
		process.kill(child.pid);
	} catch {
		/* already gone */
	}
}

/**
 * Runs the codegraph CLI with fixed arguments for the project in `cwd`, from the temp directory with the
 * project as the last argument spelled as its daemon registered it (another spelling starts another
 * daemon). On Windows the npm `.cmd` shim needs a shell. A timeout kills the child and only reports the
 * failure once that process is gone: its pid must not outlive the result.
 */
export function runCodegraph(args: readonly string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number, proxy: boolean) => void): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let grace: ReturnType<typeof setTimeout> | undefined;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (grace !== undefined) clearTimeout(grace);
			resolve(ok);
		};
		let child: ReturnType<typeof spawn> | undefined;
		try {
			let project: string;
			try {
				project = daemonFor(cwd).root ?? realpathSync(cwd);
			} catch {
				/* not alive: no registry, so the command simply runs for the real project path */
				project = realpathSync(cwd);
			}
			if (process.platform === "win32") {
				child = spawn(`codegraph ${[...args, project].map((part) => JSON.stringify(part)).join(" ")}`, { cwd: tmpdir(), env: process.env, shell: true, windowsHide: true, stdio: "ignore" });
			} else {
				child = spawn("codegraph", [...args, project], { cwd: tmpdir(), env: process.env, windowsHide: true, stdio: "ignore" });
			}
		} catch {
			resolve(false);
			return;
		}
		if (child !== undefined && child.pid !== undefined) {
			try { onSpawn?.(child.pid, process.platform === "win32"); } catch { /* bookkeeping is best effort */ }
		}
		const timer = setTimeout(() => {
			killProcessTree(child);
			// A killed command may still be closing; report the failure only once the process is gone.
			grace = setTimeout(() => finish(false), KILL_WAIT_MS);
		}, timeoutMs);
		child?.on("error", () => finish(false));
		child?.on("close", (code: number | null) => finish(code === 0));
	});
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
