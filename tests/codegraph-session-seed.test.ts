import assert from "node:assert/strict";
import test from "node:test";
import type { IndexState } from "../lib/codegraph-readiness.ts";
import type { SeedOutcome } from "../lib/codegraph-seed.ts";
import { parseWorktreeList, seedSessionWorktrees, type SessionSeedInput } from "../lib/codegraph-session-seed.ts";

/** A SessionSeedInput whose roots/state/seed are fakes; nothing real runs. */
function harness(cwd: string, overrides: Partial<SessionSeedInput> = {}): { input: SessionSeedInput; seeds: string[] } {
	const seeds: string[] = [];
	const input: SessionSeedInput = {
		cwd,
		run: async () => true,
		roots: async () => [],
		state: () => "present",
		seed: async (worktree) => {
			seeds.push(worktree);
			return { outcome: "seeded" };
		},
		...overrides,
	};
	return { input, seeds };
}

test("parseWorktreeList: worktree lines in order, deduped; blank and garbage lines ignored", () => {
	const out = [
		"worktree /repo/main",
		"HEAD 36c1e27d1a5b6b1c8b1c8e1f2a3b4c5d6e7f8a9b",
		"branch refs/heads/main",
		"",
		"worktree /repo/feature",
		"HEAD 9a4f5e6d7c8b9a0f1e2d3c4b5a69788776655443",
		"detached",
		"",
		"worktree /repo/main",
		"garbage without a keyword",
		"bare",
	].join("\n");
	assert.deepEqual(parseWorktreeList(out), ["/repo/main", "/repo/feature"]);
});

test("parseWorktreeList: empty and pathless inputs yield no roots", () => {
	assert.deepEqual(parseWorktreeList(""), []);
	assert.deepEqual(parseWorktreeList("worktree "), [], "a keyword without a path is not a worktree");
	assert.deepEqual(parseWorktreeList("HEAD only\nnothing else"), []);
});

test("seedSessionWorktrees: without the session's own index nothing is scanned", async () => {
	const { input, seeds } = harness("/repo/main", {
		state: () => "absent",
		roots: async () => {
			throw new Error("git must not run without the session's own index");
		},
	});
	const result = await seedSessionWorktrees(input);
	assert.deepEqual(result, { seeded: [], skipped: [{ worktree: "/repo/main", reason: "own-index-missing" }] });
	assert.deepEqual(seeds, []);
});

test("seedSessionWorktrees: present and unknown siblings are skipped, the own cwd is never a target", async () => {
	const { input, seeds } = harness("/repo/main", {
		roots: async () => ["/repo/main", "/repo/feature", "/repo/other"],
		state: (cwd) => (cwd === "/repo/feature" ? "present" : cwd === "/repo/other" ? "unknown" : "present") as IndexState,
	});
	const result = await seedSessionWorktrees(input);
	assert.deepEqual(result.seeded, []);
	assert.deepEqual(result.skipped, [
		{ worktree: "/repo/feature", reason: "index-present" },
		{ worktree: "/repo/other", reason: "unknown-state" },
	], "an unconfirmed state fails closed: nothing is seeded on it");
	assert.deepEqual(seeds, [], "the own cwd is excluded even when git lists it");
});

test("seedSessionWorktrees: an absent sibling is seeded from the session's index", async () => {
	const { input, seeds } = harness("/repo/main", {
		roots: async () => ["/repo/main", "/repo/feature"],
		state: (cwd) => (cwd === "/repo/feature" ? "absent" : "present"),
	});
	const result = await seedSessionWorktrees(input);
	assert.deepEqual(result, { seeded: ["/repo/feature"], skipped: [] });
	assert.deepEqual(seeds, ["/repo/feature"]);
});

test("seedSessionWorktrees: a rejecting seed is a seed-failed skip, never a rejection", async (t) => {
	const rejections: unknown[] = [];
	const onUnhandled = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	const { input } = harness("/repo/main", {
		roots: async () => ["/repo/feature"],
		state: (cwd) => (cwd === "/repo/feature" ? "absent" : "present"),
		seed: async () => {
			throw new Error("copy exploded");
		},
	});
	const result = await seedSessionWorktrees(input);
	assert.deepEqual(result, { seeded: [], skipped: [{ worktree: "/repo/feature", reason: "seed-failed" }] });
	assert.deepEqual(rejections, []);
});

test("seedSessionWorktrees: every other seed outcome becomes its skip reason", async () => {
	for (const outcome of ["target-exists", "not-seedable", "deferred", "main-busy"] as const satisfies readonly SeedOutcome[]) {
		const { input } = harness("/repo/main", {
			roots: async () => ["/repo/feature"],
			state: (cwd) => (cwd === "/repo/feature" ? "absent" : "present"),
			seed: async () => ({ outcome }),
		});
		const result = await seedSessionWorktrees(input);
		const reason = outcome === "target-exists" ? "index-present" : outcome;
		assert.deepEqual(result, { seeded: [], skipped: [{ worktree: "/repo/feature", reason }] }, `${outcome} maps to ${reason}`);
	}
});

test("seedSessionWorktrees: a failing worktree listing means no targets, never a rejection", async (t) => {
	const rejections: unknown[] = [];
	const onUnhandled = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	const { input, seeds } = harness("/repo/main", {
		roots: async () => {
			throw new Error("git worktree list failed");
		},
	});
	const result = await seedSessionWorktrees(input);
	assert.deepEqual(result, { seeded: [], skipped: [] });
	assert.deepEqual(seeds, []);
	assert.deepEqual(rejections, []);
});
