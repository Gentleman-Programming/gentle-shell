import { copyFileSync, lstatSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveSessionWorktree } from "./session-worktree-registry.ts";
import { acquireInitLock } from "./codegraph-lease.ts";
import { SYNC_TIMEOUT_MS } from "./codegraph-readiness.ts";

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
	/** Copy or validating sync failed; the worktree is left without a database. */
	| "seed-failed";

export interface SeedInput {
	/** The linked worktree that wants an index. */
	cwd: string;
	/** Where cross-session lock tokens live; the default is CodeGraph's own. */
	locksDir?: string;
	/** Bounded wait for another session's init lock; defaults to the init budget. */
	initLockWaitMs?: number;
	/** Runs `codegraph <args> <cwd>`; the validating sync. */
	run(args: readonly string[], cwd: string, timeoutMs: number): Promise<boolean>;
}

/**
 * The main checkout a linked worktree belongs to, or undefined for the main
 * checkout itself (or anything that is not a linked worktree): seeding copies
 * the main checkout's database, so the main checkout has nothing to copy and
 * keeps its ordinary init path.
 */
export function worktreeMainRoot(cwd: string): string | undefined {
	try {
		// A linked worktree's `.git` is a file pointing at the common dir; the
		// main checkout's is a directory and is never a seed target.
		if (!lstatSync(join(cwd, ".git")).isFile()) return undefined;
		const identity = resolveSessionWorktree(cwd, cwd);
		if (!identity || identity.root !== realpathSync(cwd)) return undefined;
		return dirname(identity.commonDir);
	} catch {
		return undefined;
	}
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
/** A staged copy never counts as an index, whatever crash interrupts it. */
const SEEDING_SUFFIX = ".seeding";
const INDEX_GITIGNORE = "*\n!.gitignore\n";

/**
 * Seeds a linked worktree's index by copying the main checkout's database and
 * syncing it, under the worktree's init lock. The sync is the integrity check:
 * a torn copy fails there, the database is removed, and the outcome tells the
 * caller to fall back to init — the worktree never keeps a half-seeded index.
 */
export async function seedWorktreeIndex(input: SeedInput): Promise<{ outcome: SeedOutcome }> {
	const main = worktreeMainRoot(input.cwd);
	if (main === undefined || !isFile(join(main, ".codegraph", "codegraph.db"))) return { outcome: "not-seedable" };
	const targetDir = join(input.cwd, ".codegraph");
	const targetDb = join(targetDir, "codegraph.db");
	if (isFile(targetDb)) return { outcome: "target-exists" };

	const lock = await acquireInitLock(input.cwd, {
		locksDir: input.locksDir,
		waitMs: input.initLockWaitMs,
	});
	if (lock.outcome === "present") return { outcome: "target-exists" };
	if (lock.outcome === "skipped") return { outcome: "deferred" };
	try {
		// Re-checked under the lock: another session may have finished while we waited.
		if (isFile(targetDb)) return { outcome: "target-exists" };

		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, ".gitignore"), INDEX_GITIGNORE);

		const staged: Array<[staged: string, final: string]> = [];
		for (const name of SEED_FILES) {
			const source = join(main, ".codegraph", name);
			if (!isFile(source)) continue;
			const stagedPath = join(targetDir, `${name}${SEEDING_SUFFIX}`);
			copyFileSync(source, stagedPath);
			staged.push([stagedPath, join(targetDir, name)]);
		}
		if (!staged.some(([, final]) => final === targetDb)) {
			// The source database vanished mid-copy: nothing worth renaming.
			for (const [stagedPath] of staged) rmSync(stagedPath, { force: true });
			return { outcome: "seed-failed" };
		}
		// Sidecars first, the database last: no intermediate state has a
		// database without the sidecars it may need.
		staged.sort(([, a], [, b]) => Number(b === targetDb) - Number(a === targetDb));
		for (const [stagedPath, finalPath] of staged) renameSync(stagedPath, finalPath);

		const synced = await input.run(["sync", "-q"], input.cwd, SYNC_TIMEOUT_MS);
		if (!synced) {
			// A torn or stale copy fails the sync: remove it all, so the
			// worktree is exactly as absent as before and init stays possible.
			for (const [, finalPath] of staged) rmSync(finalPath, { force: true });
			return { outcome: "seed-failed" };
		}
		return { outcome: "seeded" };
	} finally {
		lock.release();
	}
}
