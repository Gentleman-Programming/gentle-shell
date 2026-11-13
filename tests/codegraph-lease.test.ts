import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
	const keys = Object.keys(JSON.parse(readFileSync(fresh, "utf8"))).sort();
	assert.deepEqual(keys, ["expiresAt", "kind", "pid", "startedAt"], "no extra fields leak into the token");
	lease.release();
});
