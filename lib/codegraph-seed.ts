import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireInitLock, defaultLocksDir, indexState, lockPathFor, readLeaseVerdict, type LeaseToken } from "./codegraph-lease.ts";
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
	/** Loads node:sqlite for the snapshot; injectable so tests can flake the open. The
	 * default dynamic import keeps module unavailability a runtime fail-closed outcome. */
	importSqlite?: () => Promise<Pick<typeof import("node:sqlite"), "DatabaseSync">>;
	/** Runs `codegraph <args> <cwd>`; the validating sync, with the staging project as its
	 * cwd. Returning the object form lets the runner report whether the sync removed
	 * tracked entries, which a bare exit status cannot prove either way. */
	run(args: readonly string[], cwd: string, timeoutMs: number): Promise<SeedSyncReport>;
	/** The atomic hard-link publish attempt; injectable so tests can simulate a filesystem
	 * that refuses hard links and verify that publication fails closed. */
	link?(existingPath: string, newPath: string): void;
	/** Receives the seed's phase-timing marker lines (`SEED_SNAPSHOT_MS=<ms>` and
	 * `SEED_SYNC_MS=<ms>`); injectable so tests can observe them. The default writes one
	 * stderr line per phase, so a captured session output splits a worktree seed into
	 * its copy and validating-sync phases on every platform. */
	log?(line: string): void;
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

/** The init-lock token's identity when readable and present — the lease module's private readNonce
 * mirrored and widened with the writer pid and the acquisition timeline the fence binds to,
 * because the seed needs all three without widening lease.ts's export surface. */
function leaseTokenIdentity(path: string): { nonce?: string; pid?: number; startedAt: number } | undefined {
	try {
		const token = JSON.parse(readFileSync(path, "utf8")) as LeaseToken;
		return typeof token.startedAt === "number" ? { nonce: token.nonce, pid: token.pid, startedAt: token.startedAt } : undefined;
	} catch {
		return undefined;
	}
}

const INDEX_GITIGNORE = "*\n!.gitignore\n";

/** Where the seed's phase-timing markers go by default: one stderr log line each, so a
 * captured session output carries the phases on every platform. */
const defaultSeedLog = (line: string): void => {
	process.stderr.write(line + "\n");
};

/** Emits one seed phase marker. A marker is pure diagnostics: a sink that throws is
 * swallowed, never allowed to change the outcome of the seed it measures. */
function seedMarker(log: (line: string) => void, line: string): void {
	try {
		log(line);
	} catch {
		/* a marker must never alter the seed's behavior */
	}
}

/** Windows antivirus and indexers can hold a just-written file for a moment; these codes pass on a quick retry. */
const TRANSIENT_CODES = new Set(["EACCES", "EPERM", "EBUSY"]);
const TRANSIENT_ATTEMPTS = 3;

/** The transient-error test the filesystem retry has always used: a retryable errno code. */
function isTransientFsCode(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && TRANSIENT_CODES.has(code);
}

/** The observed bun flake this classifier covers: node:sqlite threw ERR_SQLITE_ERROR
 * "disk I/O error" from VACUUM INTO while a WAL writer was active on the source database,
 * and an immediate rerun succeeded byte-identically (node itself never showed it). Narrow
 * on purpose: only that IOERR shape is retried — corruption, malformed and locked errors
 * stay fatal, because a retry cannot fix them and would only hide a real failure. */
function isTransientSqliteError(error: unknown): boolean {
	const sqlite = error as NodeJS.ErrnoException;
	return sqlite.code === "ERR_SQLITE_ERROR" && /disk I\/O error/.test(sqlite.message ?? "");
}

/** Runs one synchronous step, retrying only transient errors; anything else fails at once.
 * An optional beforeRetry hook runs after each retry wait, so a caller can re-check an
 * ownership fence before paying for the next attempt; a throw from it aborts the retries.
 * An optional classifier decides which errors count as transient; the default is the
 * filesystem's errno set, and the sqlite snapshot passes the IOERR-only classifier above. */
export async function retryTransient<T>(
	step: () => T,
	sleep: (ms: number) => Promise<void>,
	beforeRetry?: () => void,
	isTransient: (error: unknown) => boolean = isTransientFsCode,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt += 1) {
		try {
			return step();
		} catch (error) {
			if (!isTransient(error)) throw error;
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
export async function seedWorktreeIndex(input: SeedInput): Promise<{ outcome: SeedOutcome; error?: string }> {
	const {
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		importSqlite = () => import("node:sqlite"),
		link = linkSync,
		log = defaultSeedLog,
	} = input;
	const main = worktreeMainRoot(input.cwd);
	if (main === undefined) return { outcome: "not-seedable" };
	const locksDir = input.locksDir ?? defaultLocksDir();
	// The main checkout's own index creation is the one state with nothing coherent to copy:
	// a live init lease means the database is being built right now — also when it has not
	// created the database file yet, so the lease is checked before a missing database is
	// treated as permission to initialize the worktree instead. A live CodeGraph writer,
	// by contrast, is exactly what the lock-safe snapshot reads through, so it never defers.
	const mainBusy =
		readLeaseVerdict(lockPathFor(main, "init", locksDir)) === "held-live";
	if (mainBusy) return { outcome: "main-busy" };
	// Tri-state parent probe: only a confirmed-absent main database leaves the worktree to
	// ordinary init. An unreadable one (access denied, a looping symlink) is unknown — the
	// seed fails closed instead of initializing past a parent index it could not see.
	const mainIndex = indexState(main);
	if (mainIndex !== "present") return { outcome: mainIndex === "unknown" ? "seed-failed" : "not-seedable" };
	const targetDir = join(input.cwd, ".codegraph");
	const targetDb = join(targetDir, "codegraph.db");
	if (isFile(targetDb)) return { outcome: "target-exists" };

	const lock = await acquireInitLock(input.cwd, {
		locksDir,
		waitMs: input.initLockWaitMs,
	});
	if (lock.outcome === "present") return { outcome: "target-exists" };
	if (lock.outcome === "skipped") return { outcome: "deferred" };
	// Bind every fence to the acquisition, not a successor observed after suspension.
	const heldNonce = lock.nonce;
	// The token at the lock path must still be this acquisition's nonce.
	const publishFenceHolds = () => {
		const nonce = leaseTokenIdentity(lockPathFor(input.cwd, "init", locksDir))?.nonce;
		return heldNonce !== undefined && nonce === heldNonce;
	};
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
			// SEED_SNAPSHOT_MS: the snapshot/copy phase alone (sqlite open, VACUUM INTO, the
			// standalone conversion), so the phase can be measured apart from the sync.
			const snapshotStartedAt = Date.now();
			try {
				// A lock-safe snapshot instead of a byte copy of live files: VACUUM INTO reads
				// the main database through its own WAL — a writer mid-commit is the snapshot's
				// input, never a torn copy — and it refuses an existing target file, preserving
				// the exclusive-creation safety the raw copy's "wx" probe used to provide.
				const { DatabaseSync } = await importSqlite();
				// The whole snapshot is one retried unit: bun has been seen throwing a transient
				// ERR_SQLITE_ERROR "disk I/O error" from VACUUM INTO beside a live WAL writer, and
				// an immediate rerun succeeded byte-identically, so that IOERR shape is retried
				// instead of costing the worktree its index for the session.
				await retryTransient(() => {
					// VACUUM INTO refuses an existing target, so every attempt starts clean: an
					// attempt that died mid-copy leaves no partial file for the next one.
					rmSync(stagedPath, { force: true });
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
				}, sleep, () => {
					// The wait before a retry can outlast the init lease, exactly like the
					// publication fence below: a seed displaced mid-snapshot stands down instead
					// of paying for another attempt on a lease it no longer holds.
					if (!publishFenceHolds()) {
						throw new Error("the init lease changed hands while the snapshot waited to retry");
					}
				}, isTransientSqliteError);
			} catch {
				// A failed snapshot — node:sqlite unavailable, a failed open, a refused target,
				// a transient IOERR that outlived its retries — leaves no index: staging is
				// removed whole, so the worktree is exactly as absent as before the seed.
				return { outcome: "seed-failed" };
			} finally {
				seedMarker(log, `SEED_SNAPSHOT_MS=${Date.now() - snapshotStartedAt}`);
			}

			// SEED_SYNC_MS: the complete validating sync — the injected run, tracked-file
			// probes and all — so this marker and the snapshot's split the seed end to end.
			const syncStartedAt = Date.now();
			const report = await input.run(["sync", "-q"], stagingRoot, SYNC_TIMEOUT_MS);
			seedMarker(log, `SEED_SYNC_MS=${Date.now() - syncStartedAt}`);
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
			// The publish below never replaces what the target holds, so a displaced seed (a different
			// or unreadable nonce) stands down before it instead of racing the newer database.
			// The displaced lock's own release() is nonce-fenced and removes nothing.
			// An unreadable ACQUISITION identity stands down the same way: undefined === undefined would
			// otherwise pass the fence and publish over a database this seed can no longer prove it owns.
			if (!publishFenceHolds()) {
				return { outcome: "seed-failed" };
			}
			// The standalone snapshot is the only staged file, so the name every consumer
			// keys on — codegraph.db — appears at its final path only after the copy has
			// already been validated.
			try {
				// Atomic no-replace publish: a hard link from staging (the same directory, so the
				// same filesystem) lands the validated database at its final name without ever
				// replacing what is already there — a successor that published while this seed
				// was stalled in validation keeps its database, because link's EEXIST loses
				// cleanly instead of overwriting. The staged name itself is dropped with the
				// staging directory in the finally below.
				// The wait before a retry can outlast the init lease: ownership is re-verified after
				// every wait, so a seed displaced mid-publication aborts instead of linking over
				// the replacement holder's index.
				await retryTransient(() => link(stagedPath, targetDb), sleep, () => {
					if (!publishFenceHolds()) {
						throw new Error("the init lease changed hands while the publication waited to retry");
					}
				});
			} catch (error) {
				// A copy exposes partial data and rename can overwrite a successor. Without an
				// atomic no-replace link, leave the destination untouched.
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS") {
					return { outcome: "seed-failed", error: "CodeGraph seed publication requires hard links; use a worktree filesystem that supports hard links." };
				}
				if (code === "EPERM") {
					return { outcome: "seed-failed", error: "CodeGraph seed hard-link publication failed; check filesystem hard-link support and permissions." };
				}
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
