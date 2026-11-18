import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireInitLock, defaultLocksDir, lockPathFor, readLeaseVerdict, type LeaseToken } from "./codegraph-lease.ts";
import { linkedWorktreeIdentity, SYNC_TIMEOUT_MS } from "./codegraph-readiness.ts";
import type { SeedOutcome, SeedSyncReport } from "./codegraph-readiness.ts";

// SeedOutcome and SeedSyncReport are defined in codegraph-readiness.ts (moved there to break
// the readiness/seed type cycle) and re-exported here for existing seed-side importers.
export type { SeedOutcome, SeedSyncReport };

export interface SeedInput {
	/** The linked worktree that wants an index. */
	cwd: string;
	/** Where cross-session lock tokens live; the default is CodeGraph's own. */
	locksDir?: string;
	/** Bounded wait for another session's init lock; defaults to the init budget. */
	initLockWaitMs?: number;
	/** Sleep between transient retries; injectable for tests. */
	sleep?(ms: number): Promise<void>;
	/** Runs `codegraph <args> <cwd>`; the validating sync, with the staging project as its
	 * cwd. Returning the object form lets the runner report whether the sync removed
	 * tracked entries, which a bare exit status cannot prove either way. */
	run(args: readonly string[], cwd: string, timeoutMs: number): Promise<SeedSyncReport>;
}

/**
 * The main checkout a linked worktree belongs to, or undefined for the main
 * checkout itself (or anything that is not a linked worktree): seeding snapshots
 * the main checkout's database, so the main checkout has nothing to snapshot
 * and keeps its ordinary init path.
 */
export function worktreeMainRoot(cwd: string): string | undefined {
	// The probe is readiness's linkedWorktreeIdentity: seed already value-imports from readiness
	// (SYNC_TIMEOUT_MS), so it reuses the probe over that same one-way edge.
	const identity = linkedWorktreeIdentity(cwd);
	return identity === undefined ? undefined : dirname(identity.commonDir);
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** The init-lock token's nonce when readable and present — the lease module's private readNonce
 * mirrored here, because the publication fence needs that identity without widening lease.ts's
 * export surface. */
function leaseNonce(path: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as LeaseToken).nonce;
	} catch {
		return undefined;
	}
}

const INDEX_GITIGNORE = "*\n!.gitignore\n";

/** Windows antivirus and indexers can hold a just-written file for a moment; these codes pass on a quick retry. */
const TRANSIENT_CODES = new Set(["EACCES", "EPERM", "EBUSY"]);
const TRANSIENT_ATTEMPTS = 3;

/** Runs one synchronous filesystem step, retrying only the transient codes; anything else fails at once.
 * An optional beforeRetry hook runs after each retry wait, so a caller can re-check an
 * ownership fence before paying for the next attempt; a throw from it aborts the retries. */
export async function retryTransient<T>(step: () => T, sleep: (ms: number) => Promise<void>, beforeRetry?: () => void): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt += 1) {
		try {
			return step();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === undefined || !TRANSIENT_CODES.has(code)) throw error;
			lastError = error;
			if (attempt + 1 < TRANSIENT_ATTEMPTS) {
				await sleep(50 * (attempt + 1));
				beforeRetry?.();
			}
		}
	}
	throw lastError;
}

/**
 * Seeds a linked worktree's index by taking a lock-safe snapshot of the main
 * checkout's database into an isolated staging project, validating the snapshot
 * there, and publishing it only after that sync succeeds without removing
 * tracked entries — all under the worktree's init lock. The snapshot (SQLite's
 * VACUUM INTO) reads through the source's WAL, so a live writer never defers
 * the seed and never tears the copy, and the sync is the integrity check: a bad
 * snapshot fails in staging, and so does a sync that emptied the staged index
 * (the staging project has no source files, so every removal is a loss, never
 * a reconciliation, even on exit 0); nothing is published in either case, so no
 * other session can accept a database the seed might still remove, and the
 * worktree never keeps a half-seeded index. Publication is fenced on the init
 * lease's nonce: a seed displaced mid-flight stands down instead of replacing
 * the newer database the replacement holder published.
 */
export async function seedWorktreeIndex(input: SeedInput): Promise<{ outcome: SeedOutcome }> {
	const { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = input;
	const main = worktreeMainRoot(input.cwd);
	if (main === undefined || !isFile(join(main, ".codegraph", "codegraph.db"))) return { outcome: "not-seedable" };
	const targetDir = join(input.cwd, ".codegraph");
	const targetDb = join(targetDir, "codegraph.db");
	if (isFile(targetDb)) return { outcome: "target-exists" };

	const locksDir = input.locksDir ?? defaultLocksDir();
	// The main checkout's own index creation is the one state with nothing coherent to copy:
	// a live init lease means the database is being built right now. A live CodeGraph writer,
	// by contrast, is exactly what the lock-safe snapshot reads through, so it never defers.
	const mainBusy =
		readLeaseVerdict(lockPathFor(main, "init", locksDir)) === "held-live";
	if (mainBusy) return { outcome: "main-busy" };

	const lock = await acquireInitLock(input.cwd, {
		locksDir,
		waitMs: input.initLockWaitMs,
	});
	if (lock.outcome === "present") return { outcome: "target-exists" };
	if (lock.outcome === "skipped") return { outcome: "deferred" };
	// This seed's identity for the publication fence below: the nonce of the init-lock token
	// just acquired — the lease module's owns() pattern (release and adopt are fenced on it too).
	const heldNonce = leaseNonce(lockPathFor(input.cwd, "init", locksDir));
	try {
		// Re-checked under the lock: another session may have finished while we waited.
		if (isFile(targetDb)) return { outcome: "target-exists" };

		// A symlinked index directory would redirect every seed write outside the worktree,
		// so it is rejected before anything is written through it.
		try {
			const target = lstatSync(targetDir);
			if (target.isSymbolicLink() || !target.isDirectory()) return { outcome: "seed-failed" };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		mkdirSync(targetDir, { recursive: true });
		// Exclusive creation: an existing .gitignore — a regular file or a planted symlink —
		// is never truncated or followed, so the write cannot land outside the index directory.
		try {
			writeFileSync(join(targetDir, ".gitignore"), INDEX_GITIGNORE, { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		// The seed stays unpublished until validation succeeds: everything is staged in its
		// own scratch project inside the index directory and the validating sync runs there,
		// so codegraph.db only appears at its final path once the snapshot has passed — no
		// other session can accept a database this seed might still remove.
		const stagingRoot = mkdtempSync(join(targetDir, "seed-"));
		const stagingIndex = join(stagingRoot, ".codegraph");
		try {
			mkdirSync(stagingIndex);
			const stagedPath = join(stagingIndex, "codegraph.db");
			try {
				// A lock-safe snapshot instead of a byte copy of live files: VACUUM INTO reads
				// the main database through its own WAL — a writer mid-commit is the snapshot's
				// input, never a torn copy — and it refuses an existing target file, preserving
				// the exclusive-creation safety the raw copy's "wx" probe used to provide.
				const { DatabaseSync } = await import("node:sqlite");
				const source = new DatabaseSync(join(main, ".codegraph", "codegraph.db"), { readOnly: true });
				try {
					source.exec("VACUUM INTO '" + stagedPath.replaceAll("'", "''") + "'");
				} finally {
					source.close();
				}
				// The snapshot inherits the source's on-disk WAL mode; the published database
				// must stand alone with no -wal/-shm beside it, so the staged copy is converted
				// into a rollback-journal database before it ever leaves staging.
				const stagedDb = new DatabaseSync(stagedPath);
				try {
					stagedDb.exec("PRAGMA journal_mode=DELETE");
				} finally {
					stagedDb.close();
				}
			} catch {
				// A failed snapshot — node:sqlite unavailable, a failed open, a refused target —
				// leaves no index: staging is removed whole, so the worktree is exactly as
				// absent as before the seed.
				return { outcome: "seed-failed" };
			}

			const report = await input.run(["sync", "-q"], stagingRoot, SYNC_TIMEOUT_MS);
			// The staging project deliberately has no source files, so a sync that removed
			// tracked entries emptied the staged index without reconciling anything: exit 0
			// or not, that report is a failed validation and never a seedable database.
			const synced = report === true || (typeof report === "object" && report.ok === true && report.removedEntries !== true);
			if (!synced) {
				// A torn or stale snapshot fails the validating sync in staging, and so does a
				// sync that emptied the staged index: nothing was published, so the worktree is
				// exactly as absent as before the seed.
				return { outcome: "seed-failed" };
			}
			// Publication fence, mirroring the lease module's owns() checks: the init lease's TTL is the
			// hard displacement bound, so this seed can be reclaimed mid-flight — suspended past the
			// TTL — while another session takes the lease and publishes a newer index into this worktree.
			// The rename places the staged snapshot over whatever the target holds now, so ownership is
			// re-verified against the CURRENT token immediately before it: a displaced seed (a
			// different or unreadable nonce) stands down instead of replacing the newer database, and
			// the caller falls back to init. The displaced lock's own release() is nonce-fenced and
			// removes nothing.
			// An unreadable ACQUISITION nonce stands down the same way: undefined === undefined would
			// otherwise pass the fence and publish over a database this seed can no longer prove it owns.
			if (heldNonce === undefined || leaseNonce(lockPathFor(input.cwd, "init", locksDir)) !== heldNonce) {
				return { outcome: "seed-failed" };
			}
			// The standalone snapshot is the only staged file, so the name every consumer
			// keys on — codegraph.db — appears at its final path only after the copy has
			// already been validated.
			try {
				// The wait before a retry can outlast the init lease: ownership is re-verified after
				// every wait, so a seed displaced mid-publication aborts instead of renaming over
				// the replacement holder's index.
				await retryTransient(() => renameSync(stagedPath, targetDb), sleep, () => {
					if (leaseNonce(lockPathFor(input.cwd, "init", locksDir)) !== heldNonce) {
						throw new Error("the init lease changed hands while the publication waited to retry");
					}
				});
			} catch {
				// A displaced seed removes nothing: once the lease has changed hands, whatever sits
				// at the final path belongs to the replacement holder, and removing it is that
				// holder's cleanup, never this seed's.
				if (leaseNonce(lockPathFor(input.cwd, "init", locksDir)) !== heldNonce) {
					return { outcome: "seed-failed" };
				}
				// A failed placement leaves no index: the database itself was never placed, so
				// nothing another session accepted is removed here. (A placement failure is the
				// seed-failed outcome, never a rejection; a final path this seed did not place —
				// a squatter directory above all — is not ours to remove either.)
				try {
					rmSync(targetDb, { force: true });
				} catch { /* a final path this seed did not place is not ours to remove */ }
				return { outcome: "seed-failed" };
			}
			return { outcome: "seeded" };
		} finally {
			// Staging never outlives the seed: published or failed, the scratch project goes.
			try {
				rmSync(stagingRoot, { recursive: true, force: true });
			} catch { /* a leftover scratch dir is garbage, never an index */ }
		}
	} finally {
		lock.release();
	}
}
