import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireInitLock, codegraphWritingIndex, defaultLocksDir, lockPathFor, readLeaseVerdict } from "./codegraph-lease.ts";
import { linkedWorktreeIdentity, SYNC_TIMEOUT_MS } from "./codegraph-readiness.ts";

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

export interface SeedInput {
	/** The linked worktree that wants an index. */
	cwd: string;
	/** Where cross-session lock tokens live; the default is CodeGraph's own. */
	locksDir?: string;
	/** Bounded wait for another session's init lock; defaults to the init budget. */
	initLockWaitMs?: number;
	/** Sleep between transient retries; injectable for tests. */
	sleep?(ms: number): Promise<void>;
	/** Runs `codegraph <args> <cwd>`; the validating sync, with the staging project as its cwd. */
	run(args: readonly string[], cwd: string, timeoutMs: number): Promise<boolean>;
}

/**
 * The main checkout a linked worktree belongs to, or undefined for the main
 * checkout itself (or anything that is not a linked worktree): seeding copies
 * the main checkout's database, so the main checkout has nothing to copy and
 * keeps its ordinary init path.
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

/** The database and its SQLite sidecars, in copy order; missing ones are skipped. */
const SEED_FILES = ["codegraph.db", "codegraph.db-wal", "codegraph.db-shm"] as const;
const INDEX_GITIGNORE = "*\n!.gitignore\n";

/** Windows antivirus and indexers can hold a just-written file for a moment; these codes pass on a quick retry. */
const TRANSIENT_CODES = new Set(["EACCES", "EPERM", "EBUSY"]);
const TRANSIENT_ATTEMPTS = 3;

/** Runs one synchronous filesystem step, retrying only the transient codes; anything else fails at once. */
export async function retryTransient<T>(step: () => T, sleep: (ms: number) => Promise<void>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt += 1) {
		try {
			return step();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === undefined || !TRANSIENT_CODES.has(code)) throw error;
			lastError = error;
			if (attempt + 1 < TRANSIENT_ATTEMPTS) await sleep(50 * (attempt + 1));
		}
	}
	throw lastError;
}

/**
 * Seeds a linked worktree's index by copying the main checkout's database into
 * an isolated staging project, validating the copy there, and publishing it
 * only after that sync succeeds — all under the worktree's init lock. The sync
 * is the integrity check: a torn copy fails in staging and nothing is
 * published, so no other session can accept a database the seed might still
 * remove, and the worktree never keeps a half-seeded index.
 */
export async function seedWorktreeIndex(input: SeedInput): Promise<{ outcome: SeedOutcome }> {
	const { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = input;
	const main = worktreeMainRoot(input.cwd);
	if (main === undefined || !isFile(join(main, ".codegraph", "codegraph.db"))) return { outcome: "not-seedable" };
	const targetDir = join(input.cwd, ".codegraph");
	const targetDb = join(targetDir, "codegraph.db");
	if (isFile(targetDb)) return { outcome: "target-exists" };

	// Never copy a main index that is being written right now: CodeGraph's own writer lock (any
	// launcher) or another session's live init lease on the main checkout means a torn copy.
	const mainBusy =
		codegraphWritingIndex(main) ||
		readLeaseVerdict(lockPathFor(main, "init", input.locksDir ?? defaultLocksDir())) === "held-live";
	if (mainBusy) return { outcome: "main-busy" };

	const lock = await acquireInitLock(input.cwd, {
		locksDir: input.locksDir,
		waitMs: input.initLockWaitMs,
	});
	if (lock.outcome === "present") return { outcome: "target-exists" };
	if (lock.outcome === "skipped") return { outcome: "deferred" };
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
		// so codegraph.db only appears at its final path once the copy has passed — no other
		// session can accept a database this seed might still remove.
		const stagingRoot = mkdtempSync(join(targetDir, "seed-"));
		const stagingIndex = join(stagingRoot, ".codegraph");
		try {
			mkdirSync(stagingIndex);
			const staged: Array<[staged: string, final: string]> = [];
			try {
				for (const name of SEED_FILES) {
					const source = join(main, ".codegraph", name);
					if (!isFile(source)) continue;
					const stagedPath = join(stagingIndex, name);
					// The exclusive probe makes the destination this seed's own regular file: a
					// pre-existing path (a symlink above all) rejects instead of redirecting the copy.
					writeFileSync(stagedPath, "", { flag: "wx" });
					await retryTransient(() => copyFileSync(source, stagedPath), sleep);
					staged.push([stagedPath, join(targetDir, name)]);
				}
				if (!staged.some(([, final]) => final === targetDb)) {
					// The source database vanished mid-copy: nothing worth publishing.
					return { outcome: "seed-failed" };
				}
			} catch {
				// A failing copy leaves no index: staging is removed whole, so the worktree is
				// exactly as absent as before and init stays possible.
				return { outcome: "seed-failed" };
			}

			const synced = await input.run(["sync", "-q"], stagingRoot, SYNC_TIMEOUT_MS);
			if (!synced) {
				// A torn or stale copy fails the validating sync in staging: nothing was published,
				// so the worktree is exactly as absent as before and init stays possible.
				return { outcome: "seed-failed" };
			}
			// Sidecars first, the database last: no intermediate state has a database without
			// the sidecars it may need, and the file every consumer keys on — codegraph.db —
			// appears only after the copy is already validated.
			staged.sort(([, a], [, b]) => Number(a === targetDb) - Number(b === targetDb));
			try {
				for (const [stagedPath, finalPath] of staged) await retryTransient(() => renameSync(stagedPath, finalPath), sleep);
			} catch {
				// A torn placement leaves no index: every placed file goes, so the worktree is
				// exactly as absent as before and init stays possible. (A placement failure is
				// the seed-failed outcome, never a rejection; the database itself was never
				// placed, so nothing another session accepted is removed here.)
				for (const [, finalPath] of staged) {
					try {
						rmSync(finalPath, { force: true });
					} catch { /* a final path this seed did not place is not ours to remove */ }
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
