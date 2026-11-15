import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodegraphRun, IndexState } from "./codegraph-readiness.ts";
import { indexState } from "./codegraph-readiness.ts";
import { seedWorktreeIndex, type SeedOutcome } from "./codegraph-seed.ts";

const execFileAsync = promisify(execFile);

/** Why one candidate worktree was not seeded. */
export type SessionSeedSkipReason =
	/** The session's own project has no index: there is nothing to seed siblings from. */
	| "own-index-missing"
	/** The worktree already carries an index (checked, or the seed reported target-exists). */
	| "index-present"
	/** The index state could not be confirmed: fail closed, seed nothing. */
	| "unknown-state"
	/** Wrong shape: the main checkout itself, or no main database to copy. */
	| "not-seedable"
	/** Another session owns index creation for that worktree: fail-closed. */
	| "deferred"
	/** The main checkout's index is being written right now: nothing was copied, nothing failed. */
	| "main-busy"
	/** Copy, validating sync, or the seed call itself failed. */
	| "seed-failed";

export interface SessionSeedSkip {
	worktree: string;
	reason: SessionSeedSkipReason;
}

export interface SessionSeedResult {
	/** The worktrees this scan seeded from the session's own index. */
	seeded: string[];
	/** Every other candidate, with the reason it was left alone. */
	skipped: SessionSeedSkip[];
}

export interface SessionSeedInput {
	cwd: string;
	/** Where cross-session lock tokens live; the default is CodeGraph's own. */
	locksDir?: string;
	/** Bounded wait for another session's init lock; defaults to the init budget. */
	initLockWaitMs?: number;
	/** Runs `codegraph <args> <project>`; the validating sync of each seed. */
	run: CodegraphRun;
	/** Lists the repo's worktree roots; the default is one `git worktree list --porcelain` in cwd. */
	roots?(): Promise<string[]>;
	/** The index state probe; the default is indexState. */
	state?(cwd: string): IndexState;
	/** Seeds one linked worktree; the default wraps seedWorktreeIndex. */
	seed?(cwd: string): Promise<{ outcome: SeedOutcome }>;
}

/** Parses `git worktree list --porcelain`: the path of each `worktree <path>` line, in order, deduped. */
export function parseWorktreeList(out: string): string[] {
	const roots: string[] = [];
	for (const line of out.split(/\r?\n/)) {
		if (!line.startsWith("worktree ")) continue;
		const path = line.slice("worktree ".length);
		if (path.length > 0 && !roots.includes(path)) roots.push(path);
	}
	return roots;
}

/** One `git worktree list --porcelain` in cwd; any failure means no roots, never a rejection. */
async function listWorktreeRoots(cwd: string): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8", windowsHide: true });
		return parseWorktreeList(stdout);
	} catch {
		return [];
	}
}

/**
 * Pre-warms the repo's other unindexed linked worktrees at session start: one worktree listing,
 * then a seed of each absent sibling from this session's own index (it must already exist — a
 * session without its own index has nothing to copy). Purely best-effort and background by
 * design: never rejects, every failure becomes a skip reason.
 */
export async function seedSessionWorktrees(input: SessionSeedInput): Promise<SessionSeedResult> {
	const state = input.state ?? indexState;
	const seed = input.seed ?? ((worktree: string) => seedWorktreeIndex({ cwd: worktree, run: input.run, locksDir: input.locksDir, initLockWaitMs: input.initLockWaitMs }));
	const roots = input.roots ?? (() => listWorktreeRoots(input.cwd));
	const result: SessionSeedResult = { seeded: [], skipped: [] };
	if (state(input.cwd) !== "present") {
		result.skipped.push({ worktree: input.cwd, reason: "own-index-missing" });
		return result;
	}
	let listed: string[];
	try {
		listed = await roots();
	} catch {
		return result;
	}
	for (const root of listed) {
		// The session's own cwd is never a sibling target: its index is the scan's source.
		if (root === input.cwd) continue;
		const rootState = state(root);
		if (rootState === "present") {
			result.skipped.push({ worktree: root, reason: "index-present" });
			continue;
		}
		if (rootState === "unknown") {
			// An access error is not an invitation to copy: unknown fails closed, exactly like indexState.
			result.skipped.push({ worktree: root, reason: "unknown-state" });
			continue;
		}
		let outcome: SeedOutcome;
		try {
			outcome = (await seed(root)).outcome;
		} catch {
			outcome = "seed-failed";
		}
		if (outcome === "seeded") {
			result.seeded.push(root);
		} else if (outcome === "target-exists") {
			result.skipped.push({ worktree: root, reason: "index-present" });
		} else {
			result.skipped.push({ worktree: root, reason: outcome });
		}
	}
	return result;
}
