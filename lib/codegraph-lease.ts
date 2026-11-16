import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalRoot } from "./codegraph-canonical.ts";
import { processAlive } from "./codegraph-daemon.ts";

/** A cross-process exclusion token for one project: init (long-held) or sync (short lease). */
export type LeaseKind = "init" | "sync";

/** What the token file says: "unknown" is fail-closed — never stolen, never written past. */
export type LeaseVerdict = "free" | "held-live" | "held-stale" | "unknown";

export interface LeaseToken {
	kind: LeaseKind;
	pid: number;
	startedAt: number;
	expiresAt: number;
	/** This acquisition's unique identity: release removes only the token that still carries it. */
	nonce?: string;
	/** The codegraph process this holder spawned, when observed: on win32 a shell wraps it. */
	writerPid?: number;
	/** The spawn was shelled (a cmd.exe wrapper): this pid is a proxy, not the real writer. */
	writerProxy?: boolean;
	writerPidAt?: number;
}

/** Locks live next to CodeGraph's own daemon registry, keyed per project and kind. */
export function defaultLocksDir(): string {
	return join(homedir(), ".codegraph", "locks");
}

/** One real project path in any spelling maps to one lock per kind: two sessions, one token. */
export function lockPathFor(cwd: string, kind: LeaseKind, locksDir: string = defaultLocksDir()): string {
	const digest = createHash("sha256").update(canonicalRoot(cwd)).digest("hex").slice(0, 32);
	return join(locksDir, `${digest}.${kind}.json`);
}

/** CodeGraph's own writer lock, any launcher's: a live pid in `.codegraph/codegraph.lock` means an index write is in progress right now. */
export function codegraphWritingIndex(cwd: string): boolean {
	try {
		const pid = Number.parseInt(readFileSync(join(cwd, ".codegraph", "codegraph.lock"), "utf8").trim(), 10);
		return Number.isInteger(pid) && pid > 0 && processAlive(pid);
	} catch {
		return false;
	}
}

/**
 * Reads a token file and judges it. An expired token or a dead holder is stale (stealable);
 * a damaged or unreadable file is unknown, and unknown is fail-closed: no session may init or
 * sync past it, because it cannot tell whether a live writer is behind the damage. With `cwd`
 * given, CodeGraph's own writer lock is consulted first, and a freshly reported proxy writer
 * pid holds for its trust window — both overrides flip a stale-looking token back to held-live,
 * because a live writer is never unlocked under.
 */
export function readLeaseVerdict(path: string, now: number = Date.now(), cwd?: string): LeaseVerdict {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "unknown";
	}
	let token: LeaseToken;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed !== "object" || parsed === null ||
			typeof (parsed as LeaseToken).kind !== "string" ||
			typeof (parsed as LeaseToken).pid !== "number" ||
			typeof (parsed as LeaseToken).startedAt !== "number" ||
			typeof (parsed as LeaseToken).expiresAt !== "number"
		) {
			return "unknown";
		}
		token = parsed as LeaseToken;
	} catch {
		return "unknown";
	}
	// CodeGraph's own writer lock outranks everything: a live writer behind a stale-looking token
	// must never be unlocked under. A proxy pid (a cmd.exe wrapper on win32) reported inside its
	// trust window holds the same way — the real writer is still starting behind it.
	if (cwd !== undefined && codegraphWritingIndex(cwd)) return "held-live";
	if (token.writerProxy === true && token.writerPidAt !== undefined && now - token.writerPidAt < PROXY_TRUST_MS) return "held-live";
	// An adopted direct writer (a detached init child on POSIX) can outlive its dead launcher while
	// it has not written codegraph.lock yet: while that child lives, the token stays held — a live
	// writer is never unlocked under, whatever the TTL or the dead launcher's pid say.
	if (token.writerProxy !== true && typeof token.writerPid === "number" && token.writerPid > 0 && processAlive(token.writerPid)) return "held-live";
	if (token.expiresAt <= now) return "held-stale";
	return processAlive(token.pid) ? "held-live" : "held-stale";
}

/** Exclusive create: the only writer of a free or freshly cleared path wins. */
function writeTokenExclusively(path: string, kind: LeaseKind, ttlMs: number, now: number, nonce: string): boolean {
	try {
		const token: LeaseToken = { kind, pid: process.pid, startedAt: now, expiresAt: now + ttlMs, nonce };
		writeFileSync(path, `${JSON.stringify(token)}\n`, { flag: "wx" });
		return true;
	} catch {
		return false; // EEXIST (someone else won) or unwritable: not ours either way
	}
}

/**
 * Records the spawned writer pid on this holder's token, best effort: only our own token is ever
 * touched. The updated metadata is written whole to a temp file beside the token and renamed over
 * it inside the per-path mutex (the ownership protocol stale recovery and release already
 * serialize on): a process dying mid-write can leave only a complete token behind, never a
 * truncated one, because an "unknown" verdict is fail-closed forever and TTL expiry cannot
 * restore a damaged file.
 */
function adoptWriterPid(path: string, pid: number, proxy: boolean, now: number = Date.now()): void {
	withPathMutex(path, MUTEX_WAIT_MS, () => {
		try {
			const token = JSON.parse(readFileSync(path, "utf8")) as LeaseToken;
			if (token.pid !== process.pid) return undefined; // lost or stolen since: never touch another holder's token
			token.writerPid = pid;
			token.writerProxy = proxy;
			token.writerPidAt = now;
			const temp = `${path}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temp, `${JSON.stringify(token)}\n`);
				renameSync(temp, path); // same filesystem: the swap is atomic, the token is never half-written
			} finally {
				rmSync(temp, { force: true }); // best effort: an unrenamed temp is litter, never state
			}
		} catch {
			/* best effort: the trust window only narrows the stale window */
		}
		return undefined;
	});
}

export interface AcquiredLease {
	/** Best-effort: a released lease nobody cleans up still expires by TTL. */
	release(): void;
	/** Best-effort: records this holder's spawned writer onto the token, so a dead launcher's lease
	 * still holds while its detached child keeps writing the index. */
	adopt(pid: number, proxy: boolean): void;
}

/** The per-path mutex's own holder record: liveness rules mirror the lease tokens themselves. */
interface MutexToken {
	pid: number;
	startedAt: number;
	expiresAt: number;
}

/** The mutex is held for one synchronous handful of syscalls; the TTL is only the crash backstop. */
const MUTEX_TTL_MS = 10_000;
/** Waiting for a live mutex holder is bounded: a wedged holder fail-closes the attempt instead. */
const MUTEX_WAIT_MS = 250;
const MUTEX_POLL_MS = 5;

function mutexPathFor(path: string): string {
	return `${path}.mutex`;
}

/** Parses the mutex holder's record; anything unreadable or malformed is undefined. */
function parseMutex(mutex: string): MutexToken | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(mutex, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const token = parsed as MutexToken;
		if (typeof token.pid !== "number" || typeof token.startedAt !== "number" || typeof token.expiresAt !== "number") return undefined;
		return token;
	} catch {
		return undefined;
	}
}

/** A damaged mutex (a crash mid-write) is still respected while its bytes are younger than the TTL. */
function mutexFreshOnDisk(mutex: string, now: number): boolean {
	try {
		return statSync(mutex).mtimeMs > now - MUTEX_TTL_MS;
	} catch {
		return false; // gone: nothing blocks
	}
}

/** The only synchronous sleep: slices short enough that a contended mutex never stalls its caller long. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Exclusive create of the mutex file: the only writer of the mutex path wins it. */
function tryTakeMutex(mutex: string, now: number): boolean {
	try {
		const token: MutexToken = { pid: process.pid, startedAt: now, expiresAt: now + MUTEX_TTL_MS };
		writeFileSync(mutex, `${JSON.stringify(token)}\n`, { flag: "wx" });
		return true;
	} catch {
		return false; // EEXIST (held) or unwritable: either way not ours
	}
}

/**
 * Runs one critical section on a token path, serialized against every other session's stale
 * recovery and release. A live mutex holder is waited for (bounded — its section is a handful of
 * syscalls); a dead, expired, or damaged-past-TTL one is stolen under the same liveness rules as
 * the tokens themselves, so a crashed reclaimer can never block a path forever. Returns undefined
 * when the wait budget is spent: fail-closed, the caller skips what it wanted to do.
 */
function withPathMutex<T>(path: string, waitMs: number, section: () => T | undefined): T | undefined {
	const mutex = mutexPathFor(path);
	const deadline = Date.now() + waitMs;
	for (;;) {
		const now = Date.now();
		if (tryTakeMutex(mutex, now)) {
			try {
				return section();
			} finally {
				rmSync(mutex, { force: true }); // best effort: a leftover is stolen by TTL rules
			}
		}
		const holder = parseMutex(mutex);
		const blocking =
			(holder !== undefined && holder.expiresAt > now && processAlive(holder.pid)) ||
			(holder === undefined && mutexFreshOnDisk(mutex, now));
		if (blocking) {
			if (now >= deadline) return undefined;
			sleepSync(MUTEX_POLL_MS);
			continue;
		}
		// Vanished (the holder released between our create and read), or stale/damaged past its
		// TTL: clear it and race the exclusive create again — bounded by the same wait budget, so a
		// mutex that can never be created (an unwritable or vanished locks dir) fail-closes the
		// attempt instead of spinning past its deadline.
		if (now >= deadline) return undefined;
		rmSync(mutex, { force: true });
	}
}

/** This path's token nonce when the token is readable and carries one. */
function readNonce(path: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as LeaseToken).nonce;
	} catch {
		return undefined;
	}
}

/**
 * Creates the token exclusively and binds release to this acquisition's nonce. The read-back is
 * defense in depth against a doubly-stolen mutex: if the token at the path is not the one this
 * acquisition just wrote, a concurrent reclaimer raced past the serialization — yield the path
 * and remove nothing (the newer owner's token stays).
 */
function createLease(path: string, kind: LeaseKind, ttlMs: number, now: number): AcquiredLease | undefined {
	const nonce = randomUUID();
	if (!writeTokenExclusively(path, kind, ttlMs, now, nonce)) return undefined;
	if (readNonce(path) !== nonce) return undefined;
	return {
		release: () => releaseOwnToken(path, nonce),
		adopt: (pid: number, proxy: boolean) => adoptWriterPid(path, pid, proxy),
	};
}

/**
 * Release removes only the token this acquisition wrote: an expired lease whose path was stolen
 * and re-owned never removes the newer owner's token. The check and the remove run inside the
 * same per-path mutex as recovery, so a release racing a reclaimer cannot remove the token the
 * reclaimer just created either. Best effort: an unreachable mutex still leaves the TTL backstop.
 */
function releaseOwnToken(path: string, nonce: string): void {
	withPathMutex(path, MUTEX_WAIT_MS, () => {
		if (readNonce(path) === nonce) rmSync(path, { force: true });
		return undefined;
	});
}

/**
 * Acquires a free or stale path exclusively; a live or unknown holder, an unwritable locks dir,
 * or a lost steal race returns undefined — the caller then skips what it wanted to do. The stale
 * path's read/remove/create sequence runs inside the per-path mutex, so concurrent reclaimers
 * serialize and re-read the path inside the critical section: the first recovery's fresh token is
 * a live holder to every later reclaimer, never something to remove.
 */
export function tryAcquireLease(path: string, kind: LeaseKind, ttlMs: number, now: number = Date.now(), cwd?: string, mutexWaitMs: number = MUTEX_WAIT_MS): AcquiredLease | undefined {
	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch {
		return undefined; // fail-closed: no locks dir, no coordination, no write
	}
	const verdict = readLeaseVerdict(path, now, cwd);
	if (verdict !== "free" && verdict !== "held-stale") return undefined;
	if (verdict === "free") return createLease(path, kind, ttlMs, now); // exclusive create is atomic on its own
	// held-stale: the remove/create sequence needs serializing against every other reclaimer and
	// every release — the exclusive create alone does not protect it.
	return withPathMutex(path, mutexWaitMs, (): AcquiredLease | undefined => {
		const recheck = readLeaseVerdict(path, now, cwd);
		if (recheck !== "free" && recheck !== "held-stale") return undefined; // a faster reclaimer owns it now
		if (recheck === "held-stale") {
			try {
				rmSync(path, { force: true });
			} catch {
				return undefined; // cannot clear the stale token: do not write past it
			}
		}
		return createLease(path, kind, ttlMs, now);
	});
}

/**
 * The sync lease outlives daemonlessRefresh's whole sync sequence (readiness.ts): the command
 * runs up to SYNC_TIMEOUT_MS (120s) and may then spend KILL_WAIT_MS (10s) dying, so the real
 * worst case is 130s plus margin for retries. The constants are mirrored by value on purpose —
 * readiness value-imports this module, so importing them back would open a
 * readiness -> lease -> readiness cycle. The TTL stays the crash backstop: a live holder is
 * never displaced, it only expires when its session is truly gone.
 */
const SYNC_LEASE_TTL_MS = 300_000;
/** A freshly reported proxy pid (a cmd.exe wrapper) is trusted this long once its holder is gone. */
const PROXY_TRUST_MS = 60_000;
/** The init lock outlives the longest init; the TTL is the crash backstop. */
const INIT_LOCK_TTL_MS = 600_000;
/** How long a second session waits for another session's init before giving up. */
const INIT_LOCK_WAIT_MS = 120_000;
const POLL_MS = 500;

/** One call for the daemon-less sync path: acquire the project's sync lease or skip. The returned
 * lease's adopt hook records the spawned sync child (readiness hands it to runCodegraph),
 * so a dead launcher's lease still holds while its detached child writes. */
export function tryAcquireSyncLease(cwd: string, locksDir?: string, ttlMs: number = SYNC_LEASE_TTL_MS): AcquiredLease | undefined {
	return tryAcquireLease(lockPathFor(cwd, "sync", locksDir ?? defaultLocksDir()), "sync", ttlMs, Date.now(), cwd);
}

/** One read for the daemon-less callers: "held-live" exactly when another session owns the refresh.
 * A damaged or unreadable token is nobody's refresh — it must never be reported as handled. */
export function syncLeaseHeldLive(cwd: string, locksDir?: string): boolean {
	try {
		return readLeaseVerdict(lockPathFor(cwd, "sync", locksDir ?? defaultLocksDir()), Date.now(), cwd) === "held-live";
	} catch {
		return false;
	}
}

export type InitLockOutcome =
	| { outcome: "acquired"; release(): void; adopt(pid: number, proxy: boolean): void }
	/** The other session's init finished while we waited: the database file exists. */
	| { outcome: "present" }
	/** Still held, or unknown, past the wait budget: fail-closed, this session inits nothing. */
	| { outcome: "skipped" };

/**
 * The index state per the repo's codegraph rules: an access error is unknown, NOT absent, and only a
 * confirmed-missing database file may be initialised. An index is the database file, never the directory.
 * The one tri-state every codegraph module keys on; readiness re-exports it for its importers.
 */
export type IndexState = "present" | "absent" | "unknown";

export function indexState(cwd: string): IndexState {
	try {
		return statSync(join(cwd, ".codegraph", "codegraph.db")).isFile() ? "present" : "absent";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
	}
}

/** True exactly for the tri-state's "present": the init wait ends when the database file is confirmed. */
function indexDatabasePresent(cwd: string): boolean {
	return indexState(cwd) === "present";
}

/**
 * The init lock: acquire it, or wait (bounded) for the other session's init to produce the
 * database file. A live holder that has not finished yet and an unknown verdict both end in
 * "skipped" — never a second concurrent init, never a steal of a live holder.
 */
export async function acquireInitLock(
	cwd: string,
	options: {
		locksDir?: string;
		ttlMs?: number;
		waitMs?: number;
		pollMs?: number;
		exists?(cwd: string): boolean;
		now?(): number;
		sleep?(ms: number): Promise<void>;
	} = {},
): Promise<InitLockOutcome> {
	const {
		locksDir,
		ttlMs = INIT_LOCK_TTL_MS,
		waitMs = INIT_LOCK_WAIT_MS,
		pollMs = POLL_MS,
		exists = indexDatabasePresent,
		now = Date.now,
		sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
	} = options;
	const path = lockPathFor(cwd, "init", locksDir ?? defaultLocksDir());
	const deadline = now() + waitMs;
	for (;;) {
		const verdict = readLeaseVerdict(path, now(), cwd);
		if (verdict === "free" || verdict === "held-stale") {
			const lease = tryAcquireLease(path, "init", ttlMs, now(), cwd);
			if (lease) return { outcome: "acquired", release: lease.release, adopt: (pid, proxy) => adoptWriterPid(path, pid, proxy) };
			// The steal race was lost between verdict and create: keep waiting like a live holder.
		} else if (verdict === "held-live" && exists(cwd)) {
			return { outcome: "present" };
		}
		if (now() >= deadline) return { outcome: "skipped" };
		await sleep(pollMs);
	}
}
