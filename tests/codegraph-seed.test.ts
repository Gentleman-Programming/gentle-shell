import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { seedWorktreeIndex, worktreeMainRoot, type SeedInput } from "../lib/codegraph-seed.ts";

/** git that fails the test WITH stderr instead of swallowing it. */
function git(args: readonly string[], cwd: string): void {
	const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} in ${cwd} failed (${result.status}): ${result.stderr ?? result.error ?? "no stderr"}`);
	}
}

function repo(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-seed-"));
	git(["init", "-b", "main"], cwd);
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

/** A main checkout with a real index plus a linked worktree of it. */
function worktreePair(t: test.TestContext): { main: string; worktree: string } {
	const main = repo(t);
	git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], main);
	// A unique name per test: a leftover worktree from a crashed run must never
	// collide with the next one (git worktree add refuses an existing path).
	const worktree = join(dirname(main), `seeded-worktree-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	git(["worktree", "add", "-b", "feature", worktree], main);
	// Direct removal, not `git worktree remove`: after-hooks may run after the
	// main repo is already gone, and the repo's own cleanup drops the registration.
	t.after(() => rmSync(worktree, { recursive: true, force: true }));
	writeDb(main);
	return { main, worktree };
}

function writeDb(root: string): void {
	mkdirSync(join(root, ".codegraph"), { recursive: true });
	writeFileSync(join(root, ".codegraph", "codegraph.db"), "index-bytes");
}

function fileAbsent(path: string): boolean {
	try {
		statSync(path);
		return false;
	} catch {
		return true;
	}
}

/** A SeedInput whose CLI run records calls; copies are the real filesystem. */
function seedHarness(cwd: string, overrides: Partial<SeedInput> = {}): { input: SeedInput; calls: string[] } {
	const calls: string[] = [];
	const input: SeedInput = {
		cwd,
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
		...overrides,
	};
	return { input, calls };
}

test("worktreeMainRoot: the linked worktree resolves to its main checkout, the main does not", (t) => {
	const { main, worktree } = worktreePair(t);
	assert.equal(worktreeMainRoot(worktree), main, "a linked worktree's main is the common dir's root");
	assert.equal(worktreeMainRoot(main), undefined, "the main checkout itself has no seeding source");
});

test("seedWorktreeIndex: not-seedable for a main checkout or a worktree without a main index", async (t) => {
	const { main, worktree } = worktreePair(t);
	const mainAttempt = await seedWorktreeIndex(seedHarness(main).input);
	assert.equal(mainAttempt.outcome, "not-seedable", "the main checkout is never seeded");

	rmSync(join(main, ".codegraph", "codegraph.db"));
	const noSource = await seedWorktreeIndex(seedHarness(worktree).input);
	assert.equal(noSource.outcome, "not-seedable", "no main database means nothing to copy");
});

test("seedWorktreeIndex: staged copy, gitignore, rename, then one sync; the target becomes an index", async (t) => {
	const { worktree } = worktreePair(t);
	const { input, calls } = seedHarness(worktree);

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seeded");
	assert.deepEqual(calls, ["sync -q"], "exactly one sync validates the copy");
	assert.equal(readFileSync(join(worktree, ".codegraph", "codegraph.db"), "utf8"), "index-bytes");
	assert.equal(readFileSync(join(worktree, ".codegraph", ".gitignore"), "utf8"), "*\n!.gitignore\n");
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db.seeding")), true, "no staged file remains");
});

test("seedWorktreeIndex: an existing target index is left alone", async (t) => {
	const { worktree } = worktreePair(t);
	writeDb(worktree);
	writeFileSync(join(worktree, ".codegraph", "codegraph.db"), "already-here");
	const { input, calls } = seedHarness(worktree);

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "target-exists");
	assert.equal(readFileSync(join(worktree, ".codegraph", "codegraph.db"), "utf8"), "already-here");
	assert.deepEqual(calls, [], "nothing ran: the index already exists");
});

test("seedWorktreeIndex: a failed sync removes the seeded database so absent stays absent", async (t) => {
	const { worktree } = worktreePair(t);
	const { input } = seedHarness(worktree, { run: async () => false });

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "the caller learns to fall back to init");
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true, "no corrupt half-seeded database is left behind");
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db.seeding")), true, "and no staged remnant either");
});

test("seedWorktreeIndex: two real sessions seeding one worktree copy exactly once", async (t) => {
	const { worktree } = worktreePair(t);
	const sandbox = mkdtempSync(join(tmpdir(), "gentle-pi-seed-race-"));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const log = join(sandbox, "copy.log");
	const script = join(sandbox, "child.mjs");
	writeFileSync(script, [
		'import { appendFileSync } from "node:fs";',
		"const [libHref, cwd, logPath] = process.argv.slice(2);",
		"const { seedWorktreeIndex } = await import(libHref);",
		"await seedWorktreeIndex({",
		"  cwd,",
		"  run: async (args) => {",
		'    if (args[0] === "sync") {',
		"      appendFileSync(logPath, `copy ${process.pid}\\\\n`);",
		"      await new Promise((resolve) => setTimeout(resolve, 200));",
		"      return true;",
		"    }",
		"    return true;",
		"  },",
		"});",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-seed.ts", import.meta.url).href;
	const closed = (child: ReturnType<typeof spawn>) => new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	const children = [
		spawn(process.execPath, [script, libHref, worktree, log], { stdio: "ignore" }),
		spawn(process.execPath, [script, libHref, worktree, log], { stdio: "ignore" }),
	];
	const codes = await Promise.all(children.map(closed));
	assert.deepEqual(codes, [0, 0]);
	const lines = readFileSync(log, "utf8").trim().split("\n").filter((line) => line.length > 0);
	assert.equal(lines.length, 1, `exactly one seed ran, got: ${lines.join(" | ")}`);
});
