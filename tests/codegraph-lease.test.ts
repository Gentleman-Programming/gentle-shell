import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acquireInitLock,
	defaultLocksDir,
	lockPathFor,
	readLeaseVerdict,
	tryAcquireLease,
	tryAcquireSyncLease,
} from "../lib/codegraph-lease.ts";
import { SYNC_TIMEOUT_MS } from "../lib/codegraph-readiness.ts";

function project(t: test.TestContext): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

function locksDir(t: test.TestContext): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-locks-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A pid that has exited: its process is verifiably gone, not merely unlikely. */
function deadPid(): number {
	const finished = spawnSync(process.execPath, ["--version"], { stdio: "ignore" });
	assert.ok(finished.pid !== undefined && finished.pid > 0);
	return finished.pid as number;
}

function writeToken(path: string, token: Record<string, unknown>): void {
	writeFileSync(path, `${JSON.stringify(token)}\n`);
}

const liveToken = (now: number) => ({ kind: "init", pid: process.pid, startedAt: now, expiresAt: now + 60_000 });

test("lease verdicts: free, held-live, held-stale by expiry, held-stale by dead pid, unknown on damage", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	assert.equal(readLeaseVerdict(path, now), "free", "no file means free");

	writeToken(path, liveToken(now));
	assert.equal(readLeaseVerdict(path, now), "held-live", "live pid inside its TTL");

	writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1 });
	assert.equal(readLeaseVerdict(path, now), "held-stale", "expired token is stealable");

	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now + 60_000 });
	assert.equal(readLeaseVerdict(path, now), "held-stale", "dead holder is stealable even inside its TTL");

	writeToken(path, { kind: "init", pid: "not a number", startedAt: now, expiresAt: now + 60_000 });
	assert.equal(readLeaseVerdict(path, now), "unknown", "malformed shape is unknown, never stealable");

	writeFileSync(path, "{not json");
	assert.equal(readLeaseVerdict(path, now), "unknown", "corrupt file is unknown, never stealable");

	if (process.platform !== "win32") {
		const unreadable = join(dir, "unreadable.json");
		writeToken(unreadable, liveToken(now));
		chmodSync(unreadable, 0o000);
		assert.equal(readLeaseVerdict(unreadable, now), "unknown", "unreadable is unknown, fail-closed");
		chmodSync(unreadable, 0o644); // restore before the locks-dir cleanup removes it
	}
});

test("tryAcquireLease acquires a free path, writes its token, and release removes it", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	const lease = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(lease, "a free path is acquired");

	const token = JSON.parse(readFileSync(path, "utf8")) as { kind: string; pid: number };
	assert.equal(token.kind, "sync");
	assert.equal(token.pid, process.pid);

	lease.release();
	assert.equal(readLeaseVerdict(path, now), "free", "release hands the path back");
});

test("tryAcquireLease refuses a live holder and steals a stale one", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	writeToken(path, liveToken(now));
	assert.equal(tryAcquireLease(path, "sync", 120_000, now), undefined, "a live holder is never displaced");
	assert.equal((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid, process.pid, "the live holder's token is untouched");

	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now + 60_000 });
	const stolen = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(stolen, "a stale token is stolen");
	stolen.release();
	assert.equal(readLeaseVerdict(path, now), "free");
});

test("tryAcquireLease never steals an unknown (fail-closed) token", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	writeFileSync(path, "{not json");
	assert.equal(tryAcquireLease(path, "init", 600_000, Date.now()), undefined);
	assert.match(readFileSync(path, "utf8"), /\{not json/, "the damaged token is left untouched");
});

test("stale recovery waits for the per-path mutex: a live holder fail-closes it, the token untouched", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const holder = deadPid();
	const now = Date.now();
	writeToken(path, { kind: "sync", pid: holder, startedAt: now, expiresAt: now - 1 });
	// Another session is inside its recovery critical section right now: its mutex names a live holder.
	writeToken(`${path}.mutex`, { pid: process.pid, startedAt: now, expiresAt: now + 60_000 });

	assert.equal(tryAcquireLease(path, "sync", 120_000, now, undefined, 60), undefined, "recovery must not run beside the mutex holder");
	assert.equal((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid, holder, "the stale token is left exactly as it was");

	// The holder finished and dropped its mutex: the same attempt proceeds again.
	rmSync(`${path}.mutex`, { force: true });
	const lease = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(lease, "with the mutex free again the stale path is recovered");
	lease.release();
	assert.equal(readLeaseVerdict(path, now), "free");
});

test("a stale per-path mutex is stolen by the same liveness rules and released after recovery", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now - 1 });
	// A reclaimer that died mid-recovery left its mutex behind: its holder pid is verifiably dead.
	writeToken(`${path}.mutex`, { pid: deadPid(), startedAt: now, expiresAt: now + 60_000 });

	const lease = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(lease, "a dead holder's mutex is stolen, not waited on");
	assert.equal(readLeaseVerdict(path, now), "held-live", "the token is now this session's live one");
	lease.release();
	assert.equal(readLeaseVerdict(path, now), "free");
	assert.equal(existsSync(`${path}.mutex`), false, "the mutex is dropped after the critical section");
});

test("release is bound to its own acquisition: it never removes a newer owner's token", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	const first = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(first, "the path is free: the first session acquires");
	// The first lease expires; a second session steals the now-stale path and re-owns it.
	const second = tryAcquireLease(path, "sync", 120_000, now + 121_000);
	assert.ok(second, "the expired token is stolen by the second session");
	// The first session's late release (its finally after the protected operation ran long) must
	// remove nothing: the path belongs to the second session now.
	first.release();
	assert.equal(readLeaseVerdict(path, now + 121_000), "held-live", "the newer owner's token survives the old release");

	second.release();
	assert.equal(readLeaseVerdict(path, now + 121_000), "free", "its own release still hands the path back");
});

test("lock paths are keyed by the real project path and kind, under a shared locks dir", (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	assert.equal(lockPathFor(cwd, "init", dir), lockPathFor(realpathSync(cwd), "init", dir), "one real path, one lock");
	assert.notEqual(lockPathFor(cwd, "init", dir), lockPathFor(cwd, "sync", dir), "kinds never share a path");
	assert.ok(lockPathFor(cwd, "init").startsWith(join(defaultLocksDir())), "default dir is ~/.codegraph/locks");
});

test("tryAcquireSyncLease is one call for the daemon-less sync path", (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const lease = tryAcquireSyncLease(cwd, dir);
	assert.ok(lease, "free project acquires");
	assert.equal(readLeaseVerdict(lockPathFor(cwd, "sync", dir), Date.now()), "held-live");
	lease.release();
	assert.equal(readLeaseVerdict(lockPathFor(cwd, "sync", dir), Date.now()), "free");
});

test("the sync lease TTL outlives daemonlessRefresh's whole unlock+sync sequence", (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const lease = tryAcquireSyncLease(cwd, dir);
	assert.ok(lease, "a free project acquires");
	const token = JSON.parse(readFileSync(lockPathFor(cwd, "sync", dir), "utf8")) as { startedAt: number; expiresAt: number };
	// daemonlessRefresh (readiness.ts) holds this lease across `unlock` and `sync -q`, each up to
	// SYNC_TIMEOUT_MS plus KILL_WAIT_MS (10s, readiness.ts) of kill grace: 2 x 130s worst case.
	const worstCaseMs = 2 * (SYNC_TIMEOUT_MS + 10_000);
	assert.ok(
		token.expiresAt - token.startedAt >= worstCaseMs,
		`the sync TTL (${token.expiresAt - token.startedAt}ms) must cover the ${worstCaseMs}ms refresh worst case`,
	);
	lease.release();
});

test("acquireInitLock: free path acquires at once", async (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const outcome = await acquireInitLock(cwd, { locksDir: dir, waitMs: 50, pollMs: 5 });
	assert.equal(outcome.outcome, "acquired");
	assert.notEqual(outcome.outcome, "skipped");
	if (outcome.outcome === "acquired") outcome.release();
});

test("acquireInitLock: a live holder that finished (db exists) resolves present", async (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const now = Date.now();
	writeToken(lockPathFor(cwd, "init", dir), liveToken(now));
	// The other session's init finished while we waited: the database exists.
	writeFileSync(join(cwd, ".codegraph-marker"), "index");

	const outcome = await acquireInitLock(cwd, { locksDir: dir, waitMs: 500, pollMs: 5, exists: () => true });
	assert.equal(outcome.outcome, "present");
	assert.equal(readLeaseVerdict(lockPathFor(cwd, "init", dir), Date.now()), "held-live", "present never steals");
});

test("acquireInitLock: a live holder that never finishes resolves skipped without stealing", async (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	writeToken(lockPathFor(cwd, "init", dir), liveToken(Date.now()));

	const outcome = await acquireInitLock(cwd, { locksDir: dir, waitMs: 20, pollMs: 5, exists: () => false });
	assert.equal(outcome.outcome, "skipped");
	assert.equal(readLeaseVerdict(lockPathFor(cwd, "init", dir), Date.now()), "held-live", "skipped never steals");
});

test("acquireInitLock: a sustained unknown verdict resolves skipped (fail-closed)", async (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	writeFileSync(lockPathFor(cwd, "init", dir), "{not json");

	const outcome = await acquireInitLock(cwd, { locksDir: dir, waitMs: 20, pollMs: 5, exists: () => false });
	assert.equal(outcome.outcome, "skipped");
	assert.match(readFileSync(lockPathFor(cwd, "init", dir), "utf8"), /\{not json/);
});

test("a token expiring exactly now is stale, and the token shape is exactly kind/pid/startedAt/expiresAt", (t) => {
	const dir = locksDir(t);
	const boundary = join(dir, "boundary.json");
	const now = Date.now();

	writeToken(boundary, { kind: "init", pid: process.pid, startedAt: now, expiresAt: now });
	assert.equal(readLeaseVerdict(boundary, now), "held-stale", "expiry is inclusive: at-now is stealable");

	const fresh = join(dir, "fresh.json");
	const lease = tryAcquireLease(fresh, "sync", 120_000, now);
	assert.ok(lease);
	const token = JSON.parse(readFileSync(fresh, "utf8")) as Record<string, unknown>;
	assert.deepEqual(Object.keys(token).sort(), ["expiresAt", "kind", "nonce", "pid", "startedAt"], "the token carries its acquisition's nonce identity and nothing else");
	lease.release();
	const again = tryAcquireLease(fresh, "sync", 120_000, now);
	assert.ok(again);
	assert.notEqual((JSON.parse(readFileSync(fresh, "utf8")) as { nonce: string }).nonce, token.nonce, "each acquisition's nonce is unique");
	again.release();
});

test("lock tokens fold path spellings: trailing separators share one token, a missing directory still keys", (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	assert.equal(lockPathFor(cwd, "init", dir), lockPathFor(`${cwd}/`, "init", dir), "a trailing separator is not a different project");
	assert.equal(lockPathFor(cwd, "init", dir), lockPathFor(`${cwd}//`, "init", dir), "neither are two");
	const missing = `${cwd}-missing`;
	assert.equal(typeof lockPathFor(missing, "init", dir), "string", "a missing directory still keys a token instead of throwing");
});

test("a live CodeGraph writer lock keeps a dead-holder token held; the proxy window expires", (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const path = lockPathFor(cwd, "init", dir);
	const now = Date.now();

	mkdirSync(join(cwd, ".codegraph"), { recursive: true });
	writeFileSync(join(cwd, ".codegraph", "codegraph.lock"), String(process.pid));
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now + 60_000 });
	assert.equal(readLeaseVerdict(path, now, cwd), "held-live", "CodeGraph's own live writer is never stolen past");
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now - 1 });
	assert.equal(readLeaseVerdict(path, now, cwd), "held-live", "even an expired token holds while the writer lives");

	writeFileSync(join(cwd, ".codegraph", "codegraph.lock"), "not-a-pid");
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now - 1 });
	assert.equal(readLeaseVerdict(path, now, cwd), "held-stale", "a garbage writer lock does not hold");

	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now + 60_000, writerPid: 4242, writerProxy: true, writerPidAt: now - 1_000 });
	assert.equal(readLeaseVerdict(path, now, cwd), "held-live", "a fresh proxy pid is inside its trust window");
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now + 60_000, writerPid: 4242, writerProxy: true, writerPidAt: now - 60_001 });
	assert.equal(readLeaseVerdict(path, now, cwd), "held-stale", "past the window the token is only as held as its holder");
});

test("a dead launcher's token holds while its adopted direct writer lives", (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const path = lockPathFor(cwd, "init", dir);
	const now = Date.now();

	// POSIX shape: the holder (launcher) is dead, its adopted writer is a live direct child that
	// has not written codegraph.lock yet.
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now + 60_000, writerPid: process.pid, writerProxy: false, writerPidAt: now });
	assert.equal(readLeaseVerdict(path, now, cwd), "held-live", "the live adopted direct writer holds its dead launcher's token");
	assert.equal(tryAcquireLease(path, "init", 600_000, now, cwd), undefined, "acquisition must not steal it");

	// The TTL is only the crash backstop: a live writer is never unlocked under, even past it.
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now - 1, writerPid: process.pid, writerProxy: false, writerPidAt: now });
	assert.equal(readLeaseVerdict(path, now, cwd), "held-live", "an expired token still holds while its direct writer lives");
	assert.equal(tryAcquireLease(path, "init", 600_000, now, cwd), undefined, "not stealable past the TTL either");

	// Once the writer is gone too, only the dead holder remains: stale again.
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now - 1, writerPid: deadPid(), writerProxy: false, writerPidAt: now });
	assert.equal(readLeaseVerdict(path, now, cwd), "held-stale", "a dead writer leaves only the dead holder's stale token");
});

test("acquireInitLock adopts the spawned writer pid onto its own token", async (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const outcome = await acquireInitLock(cwd, { locksDir: dir, waitMs: 50, pollMs: 5 });
	assert.equal(outcome.outcome, "acquired");
	if (outcome.outcome !== "acquired") return;
	outcome.adopt(4242, true);
	const token = JSON.parse(readFileSync(lockPathFor(cwd, "init", dir), "utf8")) as Record<string, unknown>;
	assert.equal(token.writerPid, 4242);
	assert.equal(token.writerProxy, true);
	assert.equal(typeof token.writerPidAt, "number");
	outcome.release();
});

test("two real sessions reclaiming one stale token: exactly one acquisition, the winner's token survives", async (t) => {
	const dir = locksDir(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-race-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "race.json");
	const now = Date.now();
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now - 1 });

	const log = join(sandbox, "race.log");
	const script = join(sandbox, "child.mjs");
	// Both children wait for each other's marker before reclaiming, so both verdicts read the same
	// stale token instead of one seeing the other's fresh one.
	writeFileSync(script, [
		'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, logPath, mine, theirs] = process.argv.slice(2);",
		"writeFileSync(mine, String(process.pid));",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(theirs)) {",
		"	if (Date.now() >= deadline) process.exit(2);",
		"}",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000);",
		"if (!lease) {",
		'	appendFileSync(logPath, `lost ${process.pid}\\n`);',
		"	process.exit(0);",
		"}",
		'	appendFileSync(logPath, `acquired ${process.pid}\\n`);',
		"	await new Promise((resolve) => setTimeout(resolve, 200));",
		"	lease.release();",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const closed = (child: ReturnType<typeof spawn>) => new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	const children = [
		spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, log, join(sandbox, "ready-a"), join(sandbox, "ready-b")], { stdio: "ignore" }),
		spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, log, join(sandbox, "ready-b"), join(sandbox, "ready-a")], { stdio: "ignore" }),
	];
	const codes = await Promise.all(children.map(closed));
	assert.deepEqual(codes, [0, 0]);
	const lines = readFileSync(log, "utf8").trim().split("\n").filter((line) => line.length > 0).map((line) => line.split(" ")[0]).sort();
	assert.deepEqual(lines, ["acquired", "lost"], `exactly one session may acquire, got: ${lines.join(" | ")}`);
	assert.equal(readLeaseVerdict(path, Date.now()), "free", "the winner released and the loser removed nothing");
});
