import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A cross-process exclusion token for one project: init (long-held) or sync (short lease). */
export type LeaseKind = "init" | "sync";

/** What the token file says: "unknown" is fail-closed — never stolen, never written past. */
export type LeaseVerdict = "free" | "held-live" | "held-stale" | "unknown";

export interface LeaseToken {
	kind: LeaseKind;
	pid: number;
	startedAt: number;
	expiresAt: number;
}

/** Locks live next to CodeGraph's own daemon registry, keyed per project and kind. */
export function defaultLocksDir(): string {
	return join(homedir(), ".codegraph", "locks");
}

/** One real project path maps to one lock per kind: two sessions, one spelling, one token. */
export function lockPathFor(cwd: string, kind: LeaseKind, locksDir: string = defaultLocksDir()): string {
	const digest = createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 32);
	return join(locksDir, `${digest}.${kind}.json`);
}

/** Signal 0 only checks; EPERM means the process exists under another user. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Reads a token file and judges it. An expired token or a dead holder is stale (stealable);
 * a damaged or unreadable file is unknown, and unknown is fail-closed: no session may init or
 * sync past it, because it cannot tell whether a live writer is behind the damage.
 */
export function readLeaseVerdict(path: string, now: number = Date.now()): LeaseVerdict {
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
	if (token.expiresAt <= now) return "held-stale";
	return pidAlive(token.pid) ? "held-live" : "held-stale";
}

/** Exclusive create: the only writer of a free or freshly cleared path wins. */
function writeTokenExclusively(path: string, kind: LeaseKind, ttlMs: number, now: number): boolean {
	try {
		const token: LeaseToken = { kind, pid: process.pid, startedAt: now, expiresAt: now + ttlMs };
		writeFileSync(path, `${JSON.stringify(token)}\n`, { flag: "wx" });
		return true;
	} catch {
		return false; // EEXIST (someone else won) or unwritable: not ours either way
	}
}

export interface AcquiredLease {
	/** Best-effort: a released lease nobody cleans up still expires by TTL. */
	release(): void;
}

function releasePath(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		/* best effort: the TTL is the backstop */
	}
}

/**
 * Acquires a free or stale path exclusively; a live or unknown holder, an unwritable locks dir,
 * or a lost steal race returns undefined — the caller then skips what it wanted to do.
 */
export function tryAcquireLease(path: string, kind: LeaseKind, ttlMs: number, now: number = Date.now()): AcquiredLease | undefined {
	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch {
		return undefined; // fail-closed: no locks dir, no coordination, no write
	}
	const verdict = readLeaseVerdict(path, now);
	if (verdict !== "free" && verdict !== "held-stale") return undefined;
	if (verdict === "held-stale") {
		try {
			rmSync(path, { force: true });
		} catch {
			return undefined; // cannot clear the stale token: do not write past it
		}
	}
	if (!writeTokenExclusively(path, kind, ttlMs, now)) return undefined;
	return { release: () => releasePath(path) };
}

/** The sync lease outlives the longest sync by design; the TTL is the crash backstop. */
const SYNC_LEASE_TTL_MS = 120_000;
/** The init lock outlives the longest init; the TTL is the crash backstop. */
const INIT_LOCK_TTL_MS = 600_000;
/** How long a second session waits for another session's init before giving up. */
const INIT_LOCK_WAIT_MS = 120_000;
const POLL_MS = 500;

/** One call for the daemon-less sync path: acquire the project's sync lease or skip. */
export function tryAcquireSyncLease(cwd: string, locksDir?: string, ttlMs: number = SYNC_LEASE_TTL_MS): AcquiredLease | undefined {
	return tryAcquireLease(lockPathFor(cwd, "sync", locksDir ?? defaultLocksDir()), "sync", ttlMs);
}

export type InitLockOutcome =
	| { outcome: "acquired"; release(): void }
	/** The other session's init finished while we waited: the database file exists. */
	| { outcome: "present" }
	/** Still held, or unknown, past the wait budget: fail-closed, this session inits nothing. */
	| { outcome: "skipped" };

function indexDatabasePresent(cwd: string): boolean {
	try {
		return statSync(join(cwd, ".codegraph", "codegraph.db")).isFile();
	} catch {
		return false;
	}
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
		const verdict = readLeaseVerdict(path, now());
		if (verdict === "free" || verdict === "held-stale") {
			const lease = tryAcquireLease(path, "init", ttlMs, now());
			if (lease) return { outcome: "acquired", release: lease.release };
			// The steal race was lost between verdict and create: keep waiting like a live holder.
		} else if (verdict === "held-live" && exists(cwd)) {
			return { outcome: "present" };
		}
		if (now() >= deadline) return { outcome: "skipped" };
		await sleep(pollMs);
	}
}
