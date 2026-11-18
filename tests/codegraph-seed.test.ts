import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { retryTransient, seedWorktreeIndex, worktreeMainRoot, type SeedInput } from "../lib/codegraph-seed.ts";
import { lockPathFor, tryAcquireLease } from "../lib/codegraph-lease.ts";

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
	const db = new DatabaseSync(join(root, ".codegraph", "codegraph.db"));
	db.exec("CREATE TABLE IF NOT EXISTS marker (id INTEGER PRIMARY KEY, note TEXT)");
	db.exec("INSERT INTO marker (note) VALUES ('committed')");
	db.close();
}

/** Opens the main fixture's database in WAL mode and returns the live handle: the second
 * commit stays in the -wal while the handle is open, exactly like a main daemon mid-write. */
function openMainDbWithWal(main: string): DatabaseSync {
	mkdirSync(join(main, ".codegraph"), { recursive: true });
	// worktreePair's writeDb already wrote a plain database here: this fixture replaces it
	// wholesale so the WAL handle starts from exactly the two rows the test pins.
	rmSync(join(main, ".codegraph", "codegraph.db"), { force: true });
	const db = new DatabaseSync(join(main, ".codegraph", "codegraph.db"));
	db.exec("PRAGMA journal_mode=wal");
	db.exec("CREATE TABLE marker (id INTEGER PRIMARY KEY, note TEXT)");
	db.exec("INSERT INTO marker (note) VALUES ('committed')");
	db.exec("INSERT INTO marker (note) VALUES ('wal-only')");
	return db;
}

function markerNotes(path: string): string[] {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
	return db.prepare("SELECT note FROM marker ORDER BY id").all().map((row) => String((row as { note: unknown }).note));
	} finally {
	db.close();
	}
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
	assert.equal(worktreeMainRoot(worktree), realpathSync(main), "a linked worktree's main is the common dir's root");
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
	assert.deepEqual(markerNotes(join(worktree, ".codegraph", "codegraph.db")), ["committed"]);
	assert.equal(readFileSync(join(worktree, ".codegraph", ".gitignore"), "utf8"), "*\n!.gitignore\n");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore", "codegraph.db"], "only the index and its gitignore remain: no staging leftovers");
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
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore"], "and no staging remnant either");
});

test("a blocked final placement returns seed-failed and leaves no torn database", async (t) => {
	const { worktree } = worktreePair(t);
	// A directory squatting on the database's final name makes the publish rename fail.
	mkdirSync(join(worktree, ".codegraph", "codegraph.db"), { recursive: true });
	const result = await seedWorktreeIndex(seedHarness(worktree).input);
	assert.equal(result.outcome, "seed-failed", "the caller learns the copy failed, never a rejection");
	assert.equal(lstatSync(join(worktree, ".codegraph", "codegraph.db")).isDirectory(), true, "the squatter is not ours to remove");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore", "codegraph.db"], "no staging remnant stays behind");
});

test("a staged database removed by the validating sync still fails the seed", async (t) => {
	const { worktree } = worktreePair(t);
	const { input } = seedHarness(worktree, {
		run: async (_args, cwd) => {
			rmSync(join(cwd, ".codegraph", "codegraph.db"), { force: true });
			return { ok: true, removedEntries: false };
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "the database rename stays required: its absence is a failure, never a skip");
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true, "nothing is published");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore"], "no staging remnant stays behind");
});

test("seedWorktreeIndex: symlinked destinations never receive or redirect seed writes", async (t) => {
	if (process.platform === "win32") return t.skip("creating symlinks needs privileges on Windows");
	const { worktree } = worktreePair(t);

	// A planted .codegraph/.gitignore -> ../package.json must never be truncated through.
	writeFileSync(join(worktree, "package.json"), "{\"name\":\"worktree-manifest\"}");
	mkdirSync(join(worktree, ".codegraph"));
	symlinkSync(join(worktree, "package.json"), join(worktree, ".codegraph", ".gitignore"));
	const planted = await seedWorktreeIndex(seedHarness(worktree).input);
	assert.equal(planted.outcome, "seeded", "an existing .gitignore is skipped, never followed: the seed itself completes safely");
	assert.equal(readFileSync(join(worktree, "package.json"), "utf8"), "{\"name\":\"worktree-manifest\"}", "the manifest behind the symlink is never replaced with INDEX_GITIGNORE");
	assert.equal(lstatSync(join(worktree, ".codegraph", ".gitignore")).isSymbolicLink(), true, "the planted link itself stays a link");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore", "codegraph.db"], "the index lands beside the link without staging leftovers");

	// A symlinked .codegraph directory would redirect every seed write outside the worktree.
	const elsewhere = mkdtempSync(join(tmpdir(), "gentle-pi-seed-elsewhere-"));
	t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
	rmSync(join(worktree, ".codegraph"), { recursive: true, force: true });
	symlinkSync(elsewhere, join(worktree, ".codegraph"), "dir");
	const redirected = await seedWorktreeIndex(seedHarness(worktree).input);
	assert.equal(redirected.outcome, "seed-failed", "a symlinked index directory is not seeded: fail-closed");
	assert.deepEqual(readdirSync(elsewhere), [], "nothing is ever written through the symlinked index directory");
});

test("a failed validating sync leaves no published codegraph.db", async (t) => {
	const { worktree } = worktreePair(t);
	let visibleDuringSync: boolean | undefined;
	const { input } = seedHarness(worktree, {
		run: async () => {
			visibleDuringSync = !fileAbsent(join(worktree, ".codegraph", "codegraph.db"));
			return false;
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "the caller learns to fall back to init");
	assert.equal(visibleDuringSync, false, "codegraph.db is invisible to every consumer while the validating sync runs");
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true, "no database is published from a failed validation");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore"], "staging is cleaned and the worktree stays exactly as absent as before");
});

test("seedWorktreeIndex: an exit-0 sync that removed tracked entries is a failed validation", async (t) => {
	const { worktree } = worktreePair(t);
	let visibleDuringSync: boolean | undefined;
	const { input } = seedHarness(worktree, {
		run: async (_args, cwd) => {
			// The staging project has no source files, so a real sync drops every tracked
			// entry and still exits 0, leaving an emptied staged database behind.
			writeFileSync(join(cwd, ".codegraph", "codegraph.db"), "emptied");
			visibleDuringSync = !fileAbsent(join(worktree, ".codegraph", "codegraph.db"));
			return { ok: true, removedEntries: true };
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "an emptied staged index is never seedable, even on exit-0");
	assert.equal(visibleDuringSync, false, "nothing is visible to any consumer while the validating sync runs");
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true, "no emptied database is published");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore"], "staging is cleaned and the worktree stays exactly as absent as before");
});

test("seedWorktreeIndex: an exit-0 sync that preserved tracked entries publishes the seed", async (t) => {
	const { worktree } = worktreePair(t);
	const { input, calls } = seedHarness(worktree, {
		run: async (args) => {
			calls.push(args.join(" "));
			return { ok: true, removedEntries: false };
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seeded");
	assert.deepEqual(calls, ["sync -q"], "exactly one sync validates the copy");
	assert.deepEqual(markerNotes(join(worktree, ".codegraph", "codegraph.db")), ["committed"]);
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
		"      appendFileSync(logPath, `copy ${process.pid}\\n`);",
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

test("a busy main writer still seeds through a lock-safe snapshot", async (t) => {
	const { main, worktree } = worktreePair(t);
	const db = openMainDbWithWal(main);
	try {
		// A live CodeGraph writer lock on the main checkout: the common state whenever the
		// main session's daemon is refreshing the index.
		writeFileSync(join(main, ".codegraph", "codegraph.lock"), String(process.pid));
		const { input, calls } = seedHarness(worktree);

		const result = await seedWorktreeIndex(input);

		assert.equal(result.outcome, "seeded", "a busy writer never defers: the snapshot reads committed state");
		assert.deepEqual(calls, ["sync -q"], "exactly one sync validates the snapshot");
		assert.deepEqual(
			readdirSync(join(worktree, ".codegraph")).sort(),
			[".gitignore", "codegraph.db"],
			"only the standalone snapshot is published: no sidecar files",
		);
		assert.deepEqual(markerNotes(join(worktree, ".codegraph", "codegraph.db")), ["committed", "wal-only"], "the snapshot carries the WAL-resident commit");
	} finally {
		// Windows: node:test runs t.after hooks in registration order (FIFO), so
		// worktreePair's rmSync teardown would run while this WAL handle is still
		// open (EBUSY). The busy-writer fixture only needs it open during the seed.
		db.close();
	}
});

test("a main checkout mid-init defers seeding without touching the worktree", async (t) => {
	const { main, worktree } = worktreePair(t);
	const locksDir = mkdtempSync(join(tmpdir(), "gentle-pi-seed-locks-"));
	t.after(() => rmSync(locksDir, { recursive: true, force: true }));
	const token = { kind: "init", pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 60_000 };
	writeFileSync(lockPathFor(main, "init", locksDir), JSON.stringify(token) + "\n");
	const { input, calls } = seedHarness(worktree, { locksDir });
	const result = await seedWorktreeIndex(input);
	assert.equal(result.outcome, "main-busy", "the main index is being created: there is nothing coherent to copy yet");
	assert.deepEqual(calls, [], "nothing ran and nothing was copied");
	assert.equal(fileAbsent(join(worktree, ".codegraph")), true, "the worktree is untouched");
});

test("a seed displaced from its init lease before publication never replaces the newer index", async (t) => {
	const { worktree } = worktreePair(t);
	const sandbox = mkdtempSync(join(tmpdir(), "gentle-pi-seed-fence-"));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const locksDir = join(sandbox, "locks");
	const { input } = seedHarness(worktree, {
		locksDir,
		run: async () => {
			// The suspension window between validation and publication: while this seed sits in
			// the validating sync, its lease's TTL elapses and another session reclaims the
			// lease and publishes a newer index into the same worktree.
			const path = lockPathFor(worktree, "init", locksDir);
			const { expiresAt } = JSON.parse(readFileSync(path, "utf8")) as { expiresAt: number };
			const reclaimer = tryAcquireLease(path, "init", 600_000, expiresAt + 1_000, worktree);
			assert.ok(reclaimer, "the other session reclaims the expired lease");
			writeFileSync(join(worktree, ".codegraph", "codegraph.db"), "newer-index-bytes");
			return true;
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "a displaced seed stands down so the caller falls back to init");
	assert.equal(readFileSync(join(worktree, ".codegraph", "codegraph.db"), "utf8"), "newer-index-bytes", "the newer database the other session published survives");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore", "codegraph.db"], "no staging leftover and no stale seed sidecar is left behind");
});

test("a seed whose init-lock nonce is unreadable at publication stands down", async (t) => {
	const { worktree } = worktreePair(t);
	const sandbox = mkdtempSync(join(tmpdir(), "gentle-pi-seed-unreadable-"));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const locksDir = join(sandbox, "locks");
	const lockPath = lockPathFor(worktree, "init", locksDir);
	const { input } = seedHarness(worktree, {
		locksDir,
		run: async () => {
			// The token becomes unreadable between validation and publication: a directory
			// at the lock path makes every nonce read fail (EISDIR) — the unreadable shape,
			// not the replaced-token shape the displacement test covers. (An acquisition-time
			// undefined nonce cannot be produced through this interface: the lease is only
			// acquired after its own nonce write reads back, so the fence's heldNonce guard
			// is fail-closed hardening for that side of the contract.)
			rmSync(lockPath, { force: true });
			mkdirSync(lockPath);
			return true;
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "an unreadable nonce is nobody's proof of ownership: the seed stands down");
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true, "nothing is published over a database the seed can no longer prove it owns");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore"], "staging is cleaned and the worktree stays exactly as absent as before");
});

test("a seed displaced while a transient publication retry waits never publishes over the replacement", async (t) => {
	if (process.platform === "win32") return t.skip("chmod-based EACCES is a POSIX retry trigger");
	const { worktree } = worktreePair(t);
	const sandbox = mkdtempSync(join(tmpdir(), "gentle-pi-seed-retry-fence-"));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const locksDir = join(sandbox, "locks");
	const lockPath = lockPathFor(worktree, "init", locksDir);
	let displaced = false;
	const { input } = seedHarness(worktree, {
		locksDir,
		run: async () => {
			// The first rename fails transiently: a read-only index directory makes the
			// placement fail with EACCES, one of the transient retry codes.
			chmodSync(join(worktree, ".codegraph"), 0o555);
			return true;
		},
		sleep: async () => {
			// The retry wait is the displacement window: the lease's TTL elapses while this
			// seed sits parked, another session reclaims it and publishes a newer index, and
			// the directory becomes writable again so an unfenced retry would now succeed.
			if (displaced) return;
			displaced = true;
			chmodSync(join(worktree, ".codegraph"), 0o755);
			const { expiresAt } = JSON.parse(readFileSync(lockPath, "utf8")) as { expiresAt: number };
			const reclaimer = tryAcquireLease(lockPath, "init", 600_000, expiresAt + 1_000, worktree);
			assert.ok(reclaimer, "the other session reclaims the lease during the retry wait");
			writeFileSync(join(worktree, ".codegraph", "codegraph.db"), "newer-index-bytes");
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "a seed displaced mid-retry aborts instead of renaming over the replacement holder's index");
	assert.equal(readFileSync(join(worktree, ".codegraph", "codegraph.db"), "utf8"), "newer-index-bytes", "the newer database the other session published survives");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore", "codegraph.db"], "no staging leftover and no stale seed file is left behind");
});

test("retryTransient retries transient codes with backoff and fails others at once", async () => {
	const sleeps: number[] = [];
	const sleep = async (ms: number) => {
		sleeps.push(ms);
	};
	let eperm = 0;
	assert.equal(
		await retryTransient(() => {
			eperm += 1;
			if (eperm < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
			return "ok";
		}, sleep),
		"ok",
	);
	assert.deepEqual(sleeps, [50, 100], "two retries, gentle backoff");
	sleeps.length = 0;
	let ebusy = 0;
	await assert.rejects(() =>
		retryTransient(() => {
			ebusy += 1;
			throw Object.assign(new Error("busy"), { code: "EBUSY" });
		}, sleep));
	assert.equal(ebusy, 3, "three attempts, then the transient error surfaces");
	let enosys = 0;
	await assert.rejects(() =>
		retryTransient(() => {
			enosys += 1;
			throw Object.assign(new Error("nope"), { code: "ENOSYS" });
		}, sleep));
	assert.equal(enosys, 1, "non-transient codes fail on the first attempt");
	assert.deepEqual(sleeps, [50, 100], "no sleep was spent on the non-transient code");
});
