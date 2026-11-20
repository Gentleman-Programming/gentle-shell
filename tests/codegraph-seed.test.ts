import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { retryTransient, seedWorktreeIndex, worktreeMainRoot, type SeedInput } from "../lib/codegraph-seed.ts";
import { leaseHostIdentity, lockPathFor, readLeaseVerdict, tryAcquireLease } from "../lib/codegraph-lease.ts";

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

/** Absence of the directory entry itself, not of what it resolves to: only ENOENT counts,
 * so a link left dangling by staging cleanup fails here instead of passing as absence. */
function entryAbsent(path: string): boolean {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
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

test("seedWorktreeIndex: SEED_SNAPSHOT_MS and SEED_SYNC_MS marker lines bracket the two phases", async (t) => {
	const { worktree } = worktreePair(t);
	const lines: string[] = [];
	const { input } = seedHarness(worktree, { log: (line) => { lines.push(line); } });

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seeded");
	assert.equal(lines.length, 2, `exactly the two phase markers, got: ${lines.join(" | ")}`);
	assert.match(lines[0], /^SEED_SNAPSHOT_MS=\d+$/, "the snapshot phase ends with its marker");
	assert.match(lines[1], /^SEED_SYNC_MS=\d+$/, "the validating sync follows, its marker after the phase");
});

test("a throwing marker sink never changes the seed's outcome", async (t) => {
	const { worktree } = worktreePair(t);
	const { input, calls } = seedHarness(worktree, { log: () => { throw new Error("marker sink down"); } });

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seeded", "markers are pure log lines: a broken sink cannot fail the seed");
	assert.deepEqual(calls, ["sync -q"], "the validating sync ran exactly once, exactly as before");
	assert.deepEqual(markerNotes(join(worktree, ".codegraph", "codegraph.db")), ["committed"], "the snapshot still publishes");
});

test("a failed snapshot still reports its phase and never starts the validating sync", async (t) => {
	const { worktree } = worktreePair(t);
	const lines: string[] = [];
	const { input, calls } = seedHarness(worktree, {
		log: (line) => { lines.push(line); },
		importSqlite: async () => {
			throw new Error("node:sqlite unavailable");
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed");
	assert.equal(lines.length, 1, "only the snapshot phase ever ran");
	assert.match(lines[0], /^SEED_SNAPSHOT_MS=\d+$/, "the snapshot phase reports its duration even when it fails");
	assert.deepEqual(calls, [], "the validating sync never started");
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

test("a transient SQLITE_IOERR during the snapshot is retried and the seed still publishes", async (t) => {
	const { worktree } = worktreePair(t);
	const { DatabaseSync: RealDatabaseSync } = await import("node:sqlite");
	let constructions = 0;
	const { input, calls } = seedHarness(worktree, {
		// The observed bun flake as an injection: the first DatabaseSync construction throws
		// the transient IOERR and every later one delegates to the real module.
		importSqlite: async () => ({
			DatabaseSync: class extends RealDatabaseSync {
				constructor(...args: ConstructorParameters<typeof RealDatabaseSync>) {
					constructions += 1;
					if (constructions === 1) throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR" });
					super(...args);
				}
			},
		}),
		sleep: async () => {},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seeded", "a lone snapshot IOERR is retried, so the worktree still gets its index this session");
	assert.deepEqual(calls, ["sync -q"], "exactly one sync validates the snapshot");
	assert.deepEqual(markerNotes(join(worktree, ".codegraph", "codegraph.db")), ["committed"], "the retried snapshot still publishes the committed marker");
});

test("a non-IOERR sqlite snapshot error fails the seed without burning retries", async (t) => {
	const { worktree } = worktreePair(t);
	const { DatabaseSync: RealDatabaseSync } = await import("node:sqlite");
	let constructions = 0;
	const sleeps: number[] = [];
	const { input, calls } = seedHarness(worktree, {
		// A corruption-shaped sqlite error: never retried, whatever the code says.
		importSqlite: async () => ({
			DatabaseSync: class extends RealDatabaseSync {
				constructor(...args: ConstructorParameters<typeof RealDatabaseSync>) {
					constructions += 1;
					if (constructions === 1) throw Object.assign(new Error("file is not a database"), { code: "ERR_SQLITE_ERROR" });
					super(...args);
				}
			},
		}),
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "only the IOERR shape is transient: corruption stays fatal");
	assert.equal(constructions, 1, "exactly one construction attempt: no retry was spent");
	assert.deepEqual(sleeps, [], "and no retry wait was burned either");
	assert.deepEqual(calls, [], "the validating sync never ran");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore"], "staging is cleaned and the worktree stays exactly as absent as before");
});

test("a seed displaced while a snapshot retry waits never publishes over the replacement", async (t) => {
	if (leaseHostIdentity() === null) {
		return t.skip("the reclaim fixture needs a host identity: a host-less token (Windows) whose holder pid is alive fails closed to unknown, so the displacement cannot be staged here");
	}
	const { worktree } = worktreePair(t);
	const sandbox = mkdtempSync(join(tmpdir(), "gentle-pi-seed-snapshot-fence-"));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const locksDir = join(sandbox, "locks");
	const lockPath = lockPathFor(worktree, "init", locksDir);
	const { DatabaseSync: RealDatabaseSync } = await import("node:sqlite");
	let constructions = 0;
	let displaced = false;
	const { input } = seedHarness(worktree, {
		locksDir,
		importSqlite: async () => ({
			DatabaseSync: class extends RealDatabaseSync {
				constructor(...args: ConstructorParameters<typeof RealDatabaseSync>) {
					constructions += 1;
					if (constructions === 1) throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR" });
					super(...args);
				}
			},
		}),
		sleep: async () => {
			if (displaced) return;
			displaced = true;
			// The retry wait is the displacement window, exactly like the publication fence: the
			// lease's TTL elapses while this seed sits parked, another session reclaims it and
			// publishes a newer index into the same worktree.
			const { expiresAt } = JSON.parse(readFileSync(lockPath, "utf8")) as { expiresAt: number };
			const reclaimer = tryAcquireLease(lockPath, "init", 600_000, expiresAt + 1_000, worktree);
			assert.ok(reclaimer, "the other session reclaims the lease during the snapshot retry wait");
			writeFileSync(join(worktree, ".codegraph", "codegraph.db"), "newer-index-bytes");
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "a seed displaced mid-snapshot aborts instead of publishing over the replacement holder's index");
	assert.equal(readFileSync(join(worktree, ".codegraph", "codegraph.db"), "utf8"), "newer-index-bytes", "the newer database the other session published survives");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore", "codegraph.db"], "no staging leftover and no stale seed file is left behind");
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

test("a live main init lease defers the worktree even before the main database exists", async (t) => {
	const { main, worktree } = worktreePair(t);
	const locksDir = mkdtempSync(join(tmpdir(), "gentle-pi-seed-locks-"));
	t.after(() => rmSync(locksDir, { recursive: true, force: true }));
	// The main checkout is mid-init and has not created its database yet: the live lease must
	// stand the worktree down instead of letting the missing database read as a fresh project.
	rmSync(join(main, ".codegraph", "codegraph.db"));
	const token = { kind: "init", pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 60_000 };
	writeFileSync(lockPathFor(main, "init", locksDir), JSON.stringify(token) + "\n");
	const { input, calls } = seedHarness(worktree, { locksDir });

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "main-busy", "a live main init lease stands the worktree down before the missing database is treated as permission to initialize");
	assert.deepEqual(calls, [], "nothing ran: the worktree does not initialize beside a live main init");
	assert.equal(fileAbsent(join(worktree, ".codegraph")), true, "the worktree is untouched");
});

test("an unreadable main index fails closed instead of falling through to init", async (t) => {
	if (process.platform === "win32") return t.skip("creating symlinks needs privileges on Windows");
	const { main, worktree } = worktreePair(t);
	// A self-referential symlink is unreadable without being absent: stat fails with ELOOP,
	// the same tri-state "unknown" an access-denied parent index produces.
	const mainDb = join(main, ".codegraph", "codegraph.db");
	rmSync(mainDb);
	symlinkSync(mainDb, mainDb);
	const { input, calls } = seedHarness(worktree);

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "an unconfirmable parent index is never permission to initialize");
	assert.deepEqual(calls, [], "nothing ran: the parent state could not be established");
	assert.equal(fileAbsent(join(worktree, ".codegraph")), true, "the worktree is untouched");
});

test("a seed displaced from its init lease before publication never replaces the newer index", async (t) => {
	if (leaseHostIdentity() === null) {
		return t.skip("the reclaim fixture needs a host identity: a host-less token (Windows) whose holder pid is alive fails closed to unknown, so the displacement cannot be staged here");
	}
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

test("an expired host-less lease whose holder pid is alive is never reclaimable (the displacement fixtures' platform gate)", (t) => {
	const sandbox = mkdtempSync(join(tmpdir(), "gentle-pi-seed-hostless-verdict-"));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	// The token shape acquireInitLock writes where no host identity can be derived (win32):
	// expired past its TTL, holder pid still alive — here this process, exactly the
	// displacement fixtures' in-process holder. The lease's fail-closed provenance rules
	// refuse that reclaim on every platform, which is why the displacement fixtures skip
	// where leaseHostIdentity() is null instead of staging an unreachable displacement.
	const lockPath = join(sandbox, "hostless.init.json");
	const token = { kind: "init", pid: process.pid, startedAt: Date.now() - 2_000, expiresAt: Date.now() - 1_000, nonce: "seed-acquisition" };
	writeFileSync(lockPath, JSON.stringify(token) + "\n");
	assert.equal(readLeaseVerdict(lockPath, Date.now()), "unknown", "an expired host-less token with a live holder is unknown, never stealable");
	assert.equal(tryAcquireLease(lockPath, "init", 600_000, Date.now()), undefined, "the reclaim the displacement fixtures rely on is refused for this token shape");
});

test("a same-pid successor replacing the lease before acquisition resumes cannot authorize publication", async (t) => {
	const { worktree } = worktreePair(t);
	const sandbox = mkdtempSync(join(tmpdir(), "gentle-pi-seed-acquisition-fence-"));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const locksDir = join(sandbox, "locks");
	const path = lockPathFor(worktree, "init", locksDir);
	const { input, calls } = seedHarness(worktree, { locksDir });
	const pending = seedWorktreeIndex(input);
	const token = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const successor = JSON.stringify({ ...token, nonce: "successor", startedAt: Date.now() - 1 }) + "\n";
	writeFileSync(path, successor);
	const result = await pending;
	assert.equal(result.outcome, "seed-failed");
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true);
	assert.equal(readFileSync(path, "utf8"), successor);
	assert.ok(calls.length <= 1);
});

test("an independent publish during validation is never replaced by the seed", async (t) => {
	const { worktree } = worktreePair(t);
	const { input } = seedHarness(worktree, {
		run: async () => {
			// An independent writer publishes while this seed's validation is still pending.
			// This seed still owns its init lease, so only the placement itself can protect the
			// newer database: the publish must refuse to replace an existing target.
			writeFileSync(join(worktree, ".codegraph", "codegraph.db"), "independent-bytes");
			return true;
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "a target that appeared during validation is never replaced: the publish refuses, it does not win");
	assert.equal(readFileSync(join(worktree, ".codegraph", "codegraph.db"), "utf8"), "independent-bytes", "the independent publish survives the seed's failed placement");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore", "codegraph.db"], "no staging leftover and nothing the seed did not place is removed");
});

test("a filesystem that refuses hard links fails without publishing", async (t) => {
	const { worktree } = worktreePair(t);
	let linkAttempts = 0;
	const { input, calls } = seedHarness(worktree, {
		link: () => {
			linkAttempts += 1;
			// A continuously available SMB share refuses CreateHardLinkW: the atomic
			// publish is rejected by the filesystem itself, not by a competing writer.
			throw Object.assign(new Error("hard links are not supported"), { code: "ENOTSUP" });
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(linkAttempts, 1, "the atomic link publish was attempted exactly once");
	assert.deepEqual(result, { outcome: "seed-failed", error: "CodeGraph seed publication requires hard links; use a worktree filesystem that supports hard links." });
	assert.deepEqual(calls, ["sync -q"]);
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true);
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore"]);
});

test("EPERM publication fails closed after retries with actionable diagnostics", async (t) => {
	const { worktree } = worktreePair(t);
	const sleeps: number[] = [];
	let attempts = 0;
	const result = await seedWorktreeIndex(seedHarness(worktree, {
		link: () => { attempts += 1; throw Object.assign(new Error("denied"), { code: "EPERM" }); },
		sleep: async (ms) => { sleeps.push(ms); },
	}).input);
	assert.deepEqual(result, { outcome: "seed-failed", error: "CodeGraph seed hard-link publication failed; check filesystem hard-link support and permissions." });
	assert.equal(attempts, 3);
	assert.deepEqual(sleeps, [50, 100]);
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true);
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")), [".gitignore"]);
});

test("a successor appearing at link refusal remains untouched", async (t) => {
	const { worktree } = worktreePair(t);
	const target = join(worktree, ".codegraph", "codegraph.db");
	let attempts = 0;
	let linkedDestination: string | undefined;
	const result = await seedWorktreeIndex(seedHarness(worktree, {
		link: (_staged, destination) => {
			attempts += 1;
			linkedDestination = destination;
			writeFileSync(target, "successor");
			throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
		},
	}).input);
	assert.equal(linkedDestination, target, "the seed links the staged snapshot to the final database path");
	assert.equal(result.outcome, "seed-failed");
	assert.equal(attempts, 1);
	assert.equal(readFileSync(target, "utf8"), "successor");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore", "codegraph.db"]);
});

test("a refused link never publishes a final database", async (t) => {
	const { worktree } = worktreePair(t);
	const target = join(worktree, ".codegraph", "codegraph.db");
	let attempts = 0;
	let linkedDestination: string | undefined;
	const result = await seedWorktreeIndex(seedHarness(worktree, {
		link: (_staged, destination) => {
			attempts += 1;
			linkedDestination = destination;
			throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
		},
	}).input);
	assert.equal(linkedDestination, target, "the seed links the staged snapshot to the final database path");
	assert.equal(result.outcome, "seed-failed");
	assert.equal(attempts, 1);
	assert.equal(entryAbsent(target), true, "the refused link leaves the final directory entry absent: no database and no dangling link");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")), [".gitignore"]);
});

test("a refused link never replaces a database that appeared meanwhile", async (t) => {
	const { worktree } = worktreePair(t);
	let linkAttempts = 0;
	const { input } = seedHarness(worktree, {
		link: () => {
			linkAttempts += 1;
			throw Object.assign(new Error("hard links are not supported"), { code: "ENOTSUP" });
		},
		run: async () => {
			// An independent writer publishes while this seed's validation is pending.
			writeFileSync(join(worktree, ".codegraph", "codegraph.db"), "independent-bytes");
			return true;
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(linkAttempts, 1, "the atomic link publish was attempted exactly once");
	assert.equal(result.outcome, "seed-failed", "the failed link leaves the occupied name untouched");
	assert.equal(readFileSync(join(worktree, ".codegraph", "codegraph.db"), "utf8"), "independent-bytes", "the independent publish survives");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore", "codegraph.db"], "no staging leftover and nothing the seed did not place is removed");
});

test("a link-less filesystem leaves the validated snapshot unpublished", async (t) => {
	const { worktree } = worktreePair(t);
	let stagedIdentity: { dev: bigint; ino: bigint; size: number } | undefined;
	let visibleDuringValidation: boolean | undefined;
	const { input } = seedHarness(worktree, {
		link: () => {
			// A continuously available SMB share refuses CreateHardLinkW: the atomic
			// link publish is rejected by the filesystem itself, not by a competing writer.
			throw Object.assign(new Error("hard links are not supported"), { code: "ENOTSUP" });
		},
		run: async () => {
			// Validation runs while the completed snapshot still lives in staging: capture
			// the staged file's identity there, and confirm the final name is still invisible.
			const staging = readdirSync(join(worktree, ".codegraph")).find((entry) => entry.startsWith("seed-"));
			assert.ok(staging, "the staged snapshot exists during validation");
			const staged = statSync(join(worktree, ".codegraph", staging, ".codegraph", "codegraph.db"), { bigint: true });
			stagedIdentity = { dev: staged.dev, ino: staged.ino, size: Number(staged.size) };
			visibleDuringValidation = !fileAbsent(join(worktree, ".codegraph", "codegraph.db"));
			return true;
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed");
	assert.equal(visibleDuringValidation, false);
	assert.ok(stagedIdentity);
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true);
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore"]);
});

test("a missing staged snapshot on a link-less filesystem leaves no final database", async (t) => {
	const { worktree } = worktreePair(t);
	let linkError: NodeJS.ErrnoException | undefined;
	const { input } = seedHarness(worktree, {
		link: (staged, destination) => {
			// A real hard link: the missing staged database itself must fail the
			// publication — an injected ENOTSUP would pass whatever staging held (the
			// unsupported-filesystem test covers that shape).
			try {
				linkSync(staged, destination);
			} catch (error) {
				linkError = error as NodeJS.ErrnoException;
				throw error;
			}
		},
		run: async () => {
			// Validation passes, but the staged snapshot is gone before publication.
			const staging = readdirSync(join(worktree, ".codegraph")).find((entry) => entry.startsWith("seed-"));
			assert.ok(staging, "the staged snapshot exists during validation");
			rmSync(join(worktree, ".codegraph", staging), { recursive: true, force: true });
			return true;
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(linkError?.code, "ENOENT", "the real link attempt failed on the missing staged database, not an injected ENOTSUP");
	assert.equal(result.outcome, "seed-failed", "publication fails closed");
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true, "no database is published");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore"], "no staging leftover and no claim remains");
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

test("a seed displaced while a transient publication retry waits never publishes", async (t) => {
	if (leaseHostIdentity() === null) {
		return t.skip("the reclaim fixture needs a host identity: a host-less token (Windows) whose holder pid is alive fails closed to unknown, so the displacement cannot be staged here");
	}
	if (process.platform === "win32") return t.skip("chmod-based EACCES is a POSIX retry trigger");
	// chmod only forces the transient failure where the permission really blocks writes: under
	// CAP_DAC_OVERRIDE (root) the first placement succeeds, the displacement never happens, and
	// the seed reports success — so probe the chmod and skip when it does not prevent writes.
	const probeDir = mkdtempSync(join(tmpdir(), "gentle-pi-seed-chmod-probe-"));
	t.after(() => rmSync(probeDir, { recursive: true, force: true }));
	chmodSync(probeDir, 0o555);
	let chmodBlocksWrites = false;
	try {
		writeFileSync(join(probeDir, "probe"), "");
	} catch {
		chmodBlocksWrites = true;
	}
	chmodSync(probeDir, 0o755);
	rmSync(join(probeDir, "probe"), { force: true });
	if (!chmodBlocksWrites) return t.skip("chmod 0o555 does not prevent writes in this environment (CAP_DAC_OVERRIDE): the transient publication failure cannot be forced");
	const { worktree } = worktreePair(t);
	const sandbox = mkdtempSync(join(tmpdir(), "gentle-pi-seed-retry-fence-"));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const locksDir = join(sandbox, "locks");
	const lockPath = lockPathFor(worktree, "init", locksDir);
	let displaced = false;
	let reclaimed = false;
	const { input } = seedHarness(worktree, {
		locksDir,
		run: async () => {
			// The first link fails transiently: a read-only index directory makes the
			// placement fail with EACCES, one of the transient retry codes.
			chmodSync(join(worktree, ".codegraph"), 0o555);
			return true;
		},
		sleep: async () => {
			// The retry wait is the displacement window: the lease's TTL elapses while this
			// seed sits parked and another session reclaims the lease. The directory becomes
			// writable again with the destination still empty, so an unfenced retry would now
			// publish: only the ownership fence can stand the displaced seed down (the occupied
			// destination is the independent-publish test's case, not this one's).
			if (displaced) return;
			displaced = true;
			chmodSync(join(worktree, ".codegraph"), 0o755);
			const { expiresAt } = JSON.parse(readFileSync(lockPath, "utf8")) as { expiresAt: number };
			if (tryAcquireLease(lockPath, "init", 600_000, expiresAt + 1_000, worktree) !== undefined) reclaimed = true;
		},
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "a seed displaced mid-retry aborts instead of publishing on a lease it no longer owns");
	assert.equal(reclaimed, true, "a successor reclaimed the lease during the backoff wait: the ownership fence, not the placement, stood the displaced seed down");
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true, "the displaced seed publishes nothing: with the destination left empty, only the ownership fence — not the no-replace placement — stood it down");
	assert.deepEqual(readdirSync(join(worktree, ".codegraph")).sort(), [".gitignore"], "no staging leftover and no stale seed file is left behind");
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

test("a validating sync that fails validation still reports both phases and publishes nothing", async (t) => {
	const { worktree } = worktreePair(t);
	const lines: string[] = [];
	const { input } = seedHarness(worktree, {
		log: (line) => { lines.push(line); },
		run: async () => ({ ok: true, removedEntries: true }),
	});

	const result = await seedWorktreeIndex(input);

	assert.equal(result.outcome, "seed-failed", "a sync that removed tracked entries fails the seed");
	assert.equal(lines.length, 2, "both phases ran, so both markers fired");
	assert.match(lines[0], /^SEED_SNAPSHOT_MS=\d+$/, "snapshot marker format");
	assert.match(lines[1], /^SEED_SYNC_MS=\d+$/, "the sync marker fires even when validation fails");
	assert.equal(fileAbsent(join(worktree, ".codegraph", "codegraph.db")), true, "a failed validation publishes nothing");
});
