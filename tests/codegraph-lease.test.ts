import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acquireInitLock,
	defaultLocksDir,
	lockPathFor,
	readLeaseVerdict,
	syncLeaseHeldLive,
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

/** Mirrors the lib's holder-identity derivation (darwin boot session uuid / linux boot id + PID
 * namespace): fixtures that must read as a LOCAL holder carry this value, foreign ones do not. */
function localHostIdentity(): string | null {
	try {
		if (process.platform === "darwin") {
			const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" }).trim();
			if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(boot)) return `darwin:${boot.toLowerCase()}`;
		}
		if (process.platform === "linux") {
			const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const namespace = readlinkSync("/proc/self/ns/pid");
			if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(boot) && /^pid:\[\d+\]$/.test(namespace)) return `linux:${boot}:${namespace}`;
		}
	} catch {
		/* unverifiable on this platform: fixtures fall back to identity-less tokens */
	}
	return null;
}

/** This machine's identity for fixtures, omitted where the platform cannot derive one (there the
 * lib preserves the legacy judgement shape for identity-less tokens). */
const localHost = (): string | undefined => localHostIdentity() ?? undefined;

/** Mirrors the lib's machine-stable identity derivation (darwin IOPlatformUUID / linux
 * machine-id): fixtures that must read as THIS machine across reboots carry this value. */
function localMachineIdentity(): string | null {
	try {
		if (process.platform === "darwin") {
			const registry = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" }).trim();
			const uuid = /"IOPlatformUUID" = "([0-9a-f-]{36})"/i.exec(registry)?.[1];
			if (uuid !== undefined) return `darwin:${uuid.toLowerCase()}`;
		}
		if (process.platform === "linux") {
			for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
				try {
					const id = readFileSync(file, "utf8").trim();
					if (/^[0-9a-f]{32}$/.test(id)) return `linux:${id}`;
				} catch {
					/* absent: try the other spelling */
				}
			}
		}
	} catch {
		/* unverifiable on this platform: fixtures fall back to boot-scoped identity only */
	}
	return null;
}

/** Opens the fifo for writing without blocking: -1 until the reader under test has it open. */
function openFifoWriter(fifo: string): number {
	try {
		return openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
	} catch {
		return -1;
	}
}

/** Waits until the child's verdict parks reading the fifo; the returned fd keeps it parked. */
async function parkFifo(fifo: string): Promise<number> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const fd = openFifoWriter(fifo);
		if (fd !== -1) return fd;
		if (Date.now() >= deadline) throw new Error("timed out waiting for the fifo reader to park");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Unblocks the parked reader: pid 0 is never a live writer. */
function releaseParkedFifo(fd: number): void {
	writeSync(fd, "0\n");
	closeSync(fd);
}

/** Waits until a child's result file holds its complete expected contents: a marker observed
 * between its create and its write would otherwise read as an empty string and fail a correct
 * run. Keeps the established deadline (10s) and poll cadence of the existence loops. */
async function waitForFileContents(file: string, expected: string, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			if (readFileSync(file, "utf8") === expected) return;
		} catch {
			/* not written yet */
		}
		if (Date.now() >= deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("lease verdicts: free, held-live, held-stale by expiry, held-stale by dead pid, unknown on damage", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	assert.equal(readLeaseVerdict(path, now), "free", "no file means free");

	writeToken(path, liveToken(now));
	assert.equal(readLeaseVerdict(path, now), "held-live", "live pid inside its TTL");

	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1, host: localHost() });
	assert.equal(readLeaseVerdict(path, now), "held-stale", "expired token with a dead holder is stealable");
	// A matching-host token keeps the TTL as its hard displacement bound: a wedged live holder
	// cannot keep the lease forever. Host-less tokens need a dead holder instead (their own test
	// below covers both identity shapes).
	if (localHostIdentity() !== null) {
		writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1, host: localHostIdentity() });
		assert.equal(readLeaseVerdict(path, now), "held-stale", "an expired matching-host token is displaced even while its holder lives");
	}

	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now + 60_000, host: localHost() });
	assert.equal(readLeaseVerdict(path, now), "held-stale", "dead holder is stealable even inside its TTL");

	writeToken(path, { kind: "init", pid: "not a number", startedAt: now, expiresAt: now + 60_000 });
	assert.equal(readLeaseVerdict(path, now), "unknown", "malformed shape is unknown, never stealable");

	writeFileSync(path, "{not json");
	assert.equal(readLeaseVerdict(path, now), "unknown", "corrupt file is unknown, never stealable");

	if (process.platform !== "win32") {
		const unreadable = join(dir, "unreadable.json");
		writeToken(unreadable, liveToken(now));
		chmodSync(unreadable, 0o000);
		try {
			// A privileged runner (root) reads straight through mode 000: the live token would then
			// fail this case for the wrong reason. Probe the denial the case depends on and skip
			// explicitly where the runner bypasses file permissions.
			let readable = true;
			try {
				readFileSync(unreadable, "utf8");
			} catch {
				readable = false;
			}
			if (readable) {
				t.skip("this runner bypasses file permissions: the unreadable-file case cannot be exercised");
				return;
			}
			assert.equal(readLeaseVerdict(unreadable, now), "unknown", "unreadable is unknown, fail-closed");
		} finally {
			chmodSync(unreadable, 0o644); // restore before the locks-dir cleanup removes it, even on failure
		}
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

	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now + 60_000, host: localHost() });
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
	writeToken(path, { kind: "sync", pid: holder, startedAt: now, expiresAt: now - 1, host: localHost() });
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
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now - 1, host: localHost() });
	// A reclaimer that died mid-recovery left its mutex behind: its holder pid is verifiably dead.
	writeToken(`${path}.mutex`, { pid: deadPid(), startedAt: now, expiresAt: now + 60_000 });

	const lease = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(lease, "a dead holder's mutex is stolen, not waited on");
	assert.equal(readLeaseVerdict(path, now), "held-live", "the token is now this session's live one");
	lease.release();
	assert.equal(readLeaseVerdict(path, now), "free");
	assert.equal(existsSync(`${path}.mutex`), false, "the mutex is dropped after the critical section");
});

test("a free-path acquisition cannot land inside another session's adoption window", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	// Mid-adoption state, materialized: the adopting holder is inside its per-path mutex section
	// and the no-replace publish has renamed its token out of the path — between that rename and
	// the link the path reads free, exactly where a second session's acquisition must not land.
	writeToken(`${path}.mutex`, { pid: process.pid, startedAt: now, expiresAt: now + 60_000 });
	assert.equal(tryAcquireLease(path, "sync", 120_000, now, undefined, 60), undefined, "no lease is granted beside an in-flight adoption section");
	assert.equal(existsSync(path), false, "nothing was published into the rename-away window");

	// The section ended and the path is genuinely free again: acquisition proceeds — the window
	// guard fail-closes attempts, it never wedges the path.
	rmSync(`${path}.mutex`, { force: true });
	const lease = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(lease, "a genuinely free path acquires once the section is over");
	lease.release();
	assert.equal(readLeaseVerdict(path, now), "free");
});

test("a live successor's token is never exposed as a free path while its displaced record is restored", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	// A releaser stalled past its nonce check has renamed the successor's live token out of the
	// path and still holds the per-path mutex. A third session arriving between the rename and
	// the restore must find no acquirable free path.
	const successor = liveToken(now);
	const graveyard = `${path}.${randomUUID()}.stale`;
	writeToken(graveyard, successor);
	writeToken(`${path}.mutex`, { pid: process.pid, startedAt: now, expiresAt: now + 60_000 });
	assert.equal(tryAcquireLease(path, "sync", 120_000, now, undefined, 60), undefined, "no acquisition between the rename and the restore");
	assert.equal(existsSync(path), false, "the third session published nothing over the successor's absence");

	// The releaser's restore completes inside its section: the successor's token is back at the
	// path byte-for-byte before any later acquisition looks, and that acquisition meets a live
	// holder — never the free path the displacement momentarily showed.
	linkSync(graveyard, path);
	rmSync(graveyard, { force: true });
	rmSync(`${path}.mutex`, { force: true });
	assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(successor)}\n`, "the successor's token is restored byte-for-byte");
	assert.equal(readLeaseVerdict(path, now), "held-live", "the restored successor token holds");
	assert.equal(tryAcquireLease(path, "sync", 120_000, now), undefined, "a later session meets the restored live token, not a free path");
});

test("release is bound to its own acquisition: it never removes a newer owner's token", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	const first = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(first, "the path is free: the first session acquires");
	// The first holder's recorded pid dies and its lease runs past its TTL: a second session
	// steals the now-stale path and re-owns it while the first session's process lives on.
	const firstToken = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	writeToken(path, { ...firstToken, pid: deadPid(), expiresAt: now - 1 });
	const second = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(second, "the dead holder's expired token is stolen by the second session");
	// The first session's late release (its finally after the protected operation ran long) must
	// remove nothing: the path belongs to the second session now.
	first.release();
	assert.equal(readLeaseVerdict(path, now), "held-live", "the newer owner's token survives the old release");

	second.release();
	assert.equal(readLeaseVerdict(path, now), "free", "its own release still hands the path back");
});

test("a missing launcher token still holds while a live external CodeGraph writer holds codegraph.lock", (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const path = lockPathFor(cwd, "init", dir);
	const now = Date.now();

	// An external CodeGraph init (not launched through this module's leases) is writing the index
	// right now: its live writer lock must hold the path even though no launcher token exists.
	mkdirSync(join(cwd, ".codegraph"), { recursive: true });
	writeFileSync(join(cwd, ".codegraph", "codegraph.lock"), String(process.pid));
	assert.equal(readLeaseVerdict(path, now, cwd), "held-live", "a live external writer holds even without a launcher token");
	assert.equal(tryAcquireLease(path, "init", 600_000, now, cwd), undefined, "no lease is granted beside the live external writer");

	writeFileSync(join(cwd, ".codegraph", "codegraph.lock"), "not-a-pid");
	assert.equal(readLeaseVerdict(path, now, cwd), "free", "a garbage writer lock leaves the missing token free");
});

test("a token from another host or PID namespace is never judged dead locally: unknown, never stealable", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();
	// A locks dir under a shared homedir can carry a live holder from another host or container:
	// its pid means nothing here, so its token is never classified stale and never replaced while
	// its owner still writes.
	const foreign = "linux:01234567-89ab-cdef-0123-456789abcdef:pid:[1]";
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now + 60_000, host: foreign });
	assert.equal(readLeaseVerdict(path, now), "unknown", "a foreign holder's dead-looking pid is never declared dead here");
	assert.equal(tryAcquireLease(path, "init", 600_000, now), undefined, "acquisition stays fail-closed against a foreign token");

	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now - 1, host: foreign });
	assert.equal(readLeaseVerdict(path, now), "unknown", "even an expired foreign token is not stealable from this host");
	assert.equal(tryAcquireLease(path, "init", 600_000, now), undefined);

	// An identity-less token on a host that does derive identity: a live pid still holds, but a
	// dead one is never stolen without provenance (fail-closed both ways).
	if (localHostIdentity() !== null) {
		writeToken(path, { kind: "sync", pid: process.pid, startedAt: now, expiresAt: now + 60_000 });
		assert.equal(readLeaseVerdict(path, now), "held-live", "an identity-less live holder still holds");
		writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now + 60_000 });
		assert.equal(readLeaseVerdict(path, now), "unknown", "no provenance, no dead verdict");
		assert.equal(tryAcquireLease(path, "sync", 120_000, now), undefined);
	}
});

test("an expired identity-less token with dead holder and writer pids needs a provenance scope: stale only where one exists", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();
	const dead = deadPid();

	// The orphan shape diagnosed on 2026-11-19: an init token whose session and spawned init
	// child both died, written by a launcher that recorded no host identity, long past its
	// TTL. Where the reader itself cannot derive identity (the platform such launchers run
	// on), its dead pids are local proof and the wedge is recovered; an identity-capable
	// reader cannot place a host-less holder inside its own PID namespace — two namespaces
	// can share one locks directory — so it fail-closes instead of guessing the pids dead.
	writeToken(path, { kind: "init", pid: dead, startedAt: now - 600_000, expiresAt: now - 1, nonce: "orphan", writerPid: dead, writerProxy: false, writerPidAt: now - 600_000 });
	assert.equal(readLeaseVerdict(path, now, undefined, null), "held-stale", "a null-identity reader reclaims the dead-pid orphan");
	if (localHostIdentity() !== null) {
		assert.equal(readLeaseVerdict(path, now), "unknown", "an identity-capable reader never guesses a host-less holder dead");
		assert.equal(tryAcquireLease(path, "init", 600_000, now), undefined, "and the path is never stolen past it");
	}

	// The live-writer check stays strictly ahead of expiry: a live adopted writer holds
	// whatever the token shape says, expired or not, provenance or not.
	writeToken(path, { kind: "init", pid: dead, startedAt: now - 600_000, expiresAt: now - 1, nonce: "orphan", writerPid: process.pid, writerProxy: false, writerPidAt: now - 600_000 });
	assert.equal(readLeaseVerdict(path, now), "held-live", "a live writer is never raced, whatever the token shape");
	assert.equal(tryAcquireLease(path, "init", 600_000, now), undefined);

	// Provenance still decides everywhere else: the same dead pids with a foreign host keep
	// the fail-closed unknown - this host cannot judge another host's pids at all.
	const foreign = "linux:01234567-89ab-cdef-0123-456789abcdef:pid:[1]";
	writeToken(path, { kind: "init", pid: dead, startedAt: now - 600_000, expiresAt: now - 1, nonce: "orphan", host: foreign, writerPid: dead, writerProxy: false, writerPidAt: now - 600_000 });
	assert.equal(readLeaseVerdict(path, now), "unknown", "a foreign host token is never stolen from this host");
	assert.equal(tryAcquireLease(path, "init", 600_000, now), undefined);
});

test("an earlier-boot token of this machine is reclaimable stale once expired: the reboot wedge is bounded", (t) => {
	const host = localHostIdentity();
	const machine = localMachineIdentity();
	if (host === null || machine === null) {
		t.skip("this platform cannot derive machine or boot identity: cross-boot recovery keeps its fail-closed shape");
		return;
	}
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();
	// The pre-reboot session's token: this machine's stable identity, the previous boot's scoped
	// identity, and holder pids that cannot exist any more — pids do not survive a reboot. The
	// live current process as the recorded holder proves the verdict is boot-driven, not pid-driven.
	const earlierBoot = host.startsWith("darwin:") ? "darwin:00000000-1111-2222-3333-444444444444" : "linux:00000000-1111-2222-3333-444444444444:pid:[4026531836]";

	writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now + 60_000, host: earlierBoot, machine });
	assert.equal(readLeaseVerdict(path, now), "unknown", "unexpired, an earlier-boot token stays fail-closed until its TTL bounds it");

	writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1, host: earlierBoot, machine });
	assert.equal(readLeaseVerdict(path, now), "held-stale", "expired, an earlier-boot token is stale: its holder died with that boot");
	const lease = tryAcquireLease(path, "init", 600_000, now);
	assert.ok(lease, "the expired earlier-boot token is recovered instead of wedging sync and init forever");
	lease.release();
	assert.equal(readLeaseVerdict(path, now), "free");

	// The adopted-writer wrinkle: a writer pid recorded before the reboot may name a live pid
	// now (pid reuse), but that pid is not the writer — the boot check must outrank it.
	writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1, host: earlierBoot, machine, writerPid: process.pid, writerProxy: false, writerPidAt: now - 120_000 });
	assert.equal(readLeaseVerdict(path, now), "held-stale", "a live-looking writer pid from an earlier boot must not hold the expired token forever");
});

test("a same-boot token from another PID namespace is not a reboot: unknown, never stealable", (t) => {
	const host = localHostIdentity();
	const machine = localMachineIdentity();
	if (host === null || machine === null || !host.startsWith("linux:")) {
		t.skip("same-boot PID namespaces exist only on linux with derivable identity");
		return;
	}
	const match = /^(linux:[0-9a-f-]{36}):pid:\[(\d+)\]$/.exec(host);
	assert.ok(match, "the linux host identity carries the boot id and PID namespace");
	const otherNamespace = match[2] === "4026531836" ? "4026531840" : "4026531836";
	const sameBootOtherNs = `${match[1]}:pid:[${otherNamespace}]`;
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	// Two containers of one boot share the machine id and boot id and differ only in PID
	// namespace: their holders are live pids of THIS boot, so an expired token from the sibling
	// namespace may not be read as from an earlier boot — the mismatch stays fail-closed, the
	// lease is never reclaimed from the live sibling. deadPid() proves the verdict is
	// boot-driven, not pid-driven.
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now - 120_000, expiresAt: now + 60_000, host: sameBootOtherNs, machine });
	assert.notEqual(readLeaseVerdict(path, now), "held-stale", "unexpired, a same-boot other-namespace token is never stale");

	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1, host: sameBootOtherNs, machine });
	assert.equal(readLeaseVerdict(path, now), "unknown", "expired, a same-boot other-namespace token is not a reboot: unknown, not stale");
	assert.equal(tryAcquireLease(path, "init", 600_000, now), undefined, "never stealable while the holder's boot is still running");
});

test("a foreign machine's token, or a legacy boot-only token, stays unknown across reboots: never stealable", (t) => {
	const host = localHostIdentity();
	const machine = localMachineIdentity();
	if (host === null || machine === null) {
		t.skip("this platform cannot derive machine or boot identity: the fail-closed shape is covered by the foreign-host test");
		return;
	}
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();
	const earlierBoot = host.startsWith("darwin:") ? "darwin:00000000-1111-2222-3333-444444444444" : "linux:00000000-1111-2222-3333-444444444444:pid:[4026531836]";
	const foreignMachine = machine.startsWith("darwin:") ? "darwin:ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb" : `linux:${"f".repeat(32)}`;

	// Another machine writing into a shared locks dir: its machine identity differs, so even an
	// expired earlier-boot-looking token is never reclaimed here — its holder may be live there.
	writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1, host: earlierBoot, machine: foreignMachine });
	assert.equal(readLeaseVerdict(path, now), "unknown", "a foreign machine's expired token stays unknown, fail-closed");
	assert.equal(tryAcquireLease(path, "init", 600_000, now), undefined, "never stealable");

	// A legacy token (written before the machine part existed): different boot, no machine part —
	// the pre-existing fail-closed behavior is deliberately preserved for it.
	writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1, host: earlierBoot });
	assert.equal(readLeaseVerdict(path, now), "unknown", "a legacy boot-only token keeps its unknown verdict");
	assert.equal(tryAcquireLease(path, "init", 600_000, now), undefined);
});

test("a local holder's stale token is still judged by pid and TTL once host identity matches", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();
	const host = localHostIdentity();
	if (host === null) {
		t.skip("this platform cannot derive holder identity: local stale judgements keep their legacy shape");
		return;
	}

	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now + 60_000, host });
	assert.equal(readLeaseVerdict(path, now), "held-stale", "a dead local holder is stealable exactly as before");

	const lease = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(lease, "the matching-identity stale token is recovered");
	const token = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	assert.equal(token.host, host, "the fresh acquisition records this host's identity for the next verdict");
	lease.release();
	assert.equal(readLeaseVerdict(path, now), "free");
});

test("lease publication is all-or-nothing: temp litter never blocks, the token lands complete", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");

	// A publication attempt that died before its atomic publish leaves only temp litter beside the
	// path — never an empty or partial token ON it, whose verdict would be "unknown" forever.
	writeFileSync(`${path}.crashed-attempt.tmp`, "{half-written to");
	const lease = tryAcquireLease(path, "sync", 120_000, Date.now());
	assert.ok(lease, "leftover temp litter never blocks a later acquisition");
	const token = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	assert.equal(token.kind, "sync");
	assert.equal(typeof token.nonce, "string", "the published token is complete and carries its acquisition identity");
	// This acquisition cleans up its own temporary file: only the foreign crashed one remains.
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), ["token.json.crashed-attempt.tmp"]);
	lease.release();
});

test("a displaced holder's adopt() and release() cannot touch the newer owner's token", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	// The first holder's recorded pid dies and its lease runs past its TTL: a second session
	// reclaims the path. The first holder may resume and publish or remove state — but only on
	// its own acquisition's token, never on the newer owner's.
	const first = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(first, "a free path acquires");
	const firstToken = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	writeToken(path, { ...firstToken, pid: deadPid(), expiresAt: now - 1 });
	const second = tryAcquireLease(path, "sync", 120_000, now);
	assert.ok(second, "the dead holder's expired token is reclaimed");
	const before = readFileSync(path, "utf8");

	first.adopt(4242, false);
	assert.equal(readFileSync(path, "utf8"), before, "a displaced holder's adoption rewrites nothing on the newer owner's token");
	first.release();
	assert.equal(readFileSync(path, "utf8"), before, "its late release removes nothing either");

	second.release();
	assert.equal(readLeaseVerdict(path, now), "free");
});

test("an adoption stalled past its mutex does not publish over the replacement owner's token", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	const dir = locksDir(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-adopt-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "token.json");
	const ready = join(sandbox, "ready");
	const go = join(sandbox, "go");
	const marker = join(sandbox, "result");
	const done = join(sandbox, "done");
	const script = join(sandbox, "child.mjs");
	// The child acquires the free path, then parks INSIDE its adoption's critical section: the
	// token file is swapped for a fifo, so the section's token read blocks on the parent's writer.
	writeFileSync(script, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, ready, go, marker, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now());",
		"writeFileSync(ready, lease ? \"acquired\" : \"lost\");",
		"if (!lease) process.exit(1);",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(go)) {",
		"	if (Date.now() >= deadline) process.exit(2);",
		"}",
		"lease.adopt(4242, false);",
		"writeFileSync(marker, \"adopted\");",
		"const doneDeadline = Date.now() + 10_000;",
		"while (!existsSync(done)) {",
		"	if (Date.now() >= doneDeadline) process.exit(3);",
		"}",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, ready, go, marker, done], { stdio: "ignore" });
	t.after(() => {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});
	const closed = new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	await waitForFileContents(ready, "acquired", "the child never acquired the lease");

	// Swap the live token file for a fifo: the child's adoption parks reading it inside the
	// per-path mutex, past its holder-pid and nonce checks' read.
	const stalledToken = readFileSync(path, "utf8");
	rmSync(path);
	execFileSync("mkfifo", [path]);
	writeFileSync(go, "");
	const parked = await parkFifo(path);
	assert.equal(existsSync(`${path}.mutex`), true, "the parked child holds the per-path mutex inside its adoption section");

	// The adopter is displaced exactly as a stall past MUTEX_TTL_MS displaces it: its mutex is
	// removed, a replacement owner acquires the now-free path, and a fresh mutex guards it.
	rmSync(`${path}.mutex`, { force: true });
	rmSync(path); // the fifo name goes; the parked reader keeps its open descriptor
	const second = tryAcquireLease(path, "sync", 120_000, Date.now());
	assert.ok(second, "with the path clear the replacement owner acquires it");
	const replacementToken = readFileSync(path, "utf8");
	const replacementMutex = `${path}.mutex`;
	writeToken(replacementMutex, { pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 60_000, nonce: randomUUID() });
	const replacementMutexBytes = readFileSync(replacementMutex, "utf8");

	// The stalled adoption resumes: its pid and nonce checks still pass against the bytes it
	// read, but the section no longer owns the mutex — publishing would rename the stale
	// adoption over the replacement owner's token.
	writeSync(parked, stalledToken);
	closeSync(parked);
	await waitForFileContents(marker, "adopted", "the child never finished its adoption");
	assert.equal(readFileSync(path, "utf8"), replacementToken, "the adoption must not publish over the replacement owner's token");
	assert.equal(readFileSync(replacementMutex, "utf8"), replacementMutexBytes, "the replacement owner's mutex is never removed by the displaced adoption");
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "the aborted adoption leaves no temp litter behind");
	writeFileSync(done, "");
	assert.equal(await closed, 0);
	rmSync(replacementMutex, { force: true }); // the replacement owner's section ends: its mutex goes
	second.release();
	assert.equal(readLeaseVerdict(path, Date.now()), "free");
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

test("the sync lease TTL outlives daemonlessRefresh's single sync sequence", (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const lease = tryAcquireSyncLease(cwd, dir);
	assert.ok(lease, "a free project acquires");
	const token = JSON.parse(readFileSync(lockPathFor(cwd, "sync", dir), "utf8")) as { startedAt: number; expiresAt: number };
	// daemonlessRefresh (readiness.ts) runs no `unlock`: the lease covers exactly one `sync -q`
	// command — up to SYNC_TIMEOUT_MS, then the runner's KILL_ESCALATE_MS (1s, readiness.ts)
	// before it escalates to SIGKILL and KILL_WAIT_MS (10s, readiness.ts) of grace for a child
	// that never closes. Both runner delays are module-private in readiness.ts, so they mirror
	// by value here exactly as the lease module mirrors them for its TTL.
	const KILL_ESCALATE_MS = 1_000;
	const KILL_WAIT_MS = 10_000;
	const worstCaseMs = SYNC_TIMEOUT_MS + KILL_ESCALATE_MS + KILL_WAIT_MS;
	assert.ok(
		token.expiresAt - token.startedAt >= worstCaseMs,
		`the sync TTL (${token.expiresAt - token.startedAt}ms) must cover the ${worstCaseMs}ms single-sync worst case`,
	);
	lease.release();
});

test("acquireInitLock: free path acquires at once", async (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const outcome = await acquireInitLock(cwd, { locksDir: dir, waitMs: 50, pollMs: 5 });
	assert.equal(outcome.outcome, "acquired");
	assert.notEqual(outcome.outcome, "skipped");
	if (outcome.outcome === "acquired") {
		const path = lockPathFor(cwd, "init", dir);
		const token = JSON.parse(readFileSync(path, "utf8")) as { nonce: string };
		assert.equal(outcome.nonce, token.nonce);
		outcome.adopt(4242, true);
		assert.equal((JSON.parse(readFileSync(path, "utf8")) as { nonce: string }).nonce, outcome.nonce);
		outcome.release();
		assert.equal(readLeaseVerdict(path), "free");
	}
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

	writeToken(boundary, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now, host: localHost() });
	assert.equal(readLeaseVerdict(boundary, now), "held-stale", "expiry is inclusive: at-now is stealable");

	const fresh = join(dir, "fresh.json");
	const lease = tryAcquireLease(fresh, "sync", 120_000, now);
	assert.ok(lease);
	const token = JSON.parse(readFileSync(fresh, "utf8")) as Record<string, unknown>;
	// The token's identity fields exist only where the platform can derive them: on Windows
	// leaseHostIdentity() and leaseMachineIdentity() are null, JSON serialization omits both
	// keys, and a fixed expected set would fail the suite there.
	const expectedKeys = ["expiresAt", "kind", "nonce", "pid", "startedAt"];
	if (localHostIdentity() !== null) expectedKeys.push("host");
	if (localMachineIdentity() !== null) expectedKeys.push("machine");
	assert.deepEqual(Object.keys(token).sort(), expectedKeys.sort(), "the token carries its acquisition's nonce and the identity fields this platform can derive, and nothing else");
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
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now - 1, host: localHost() });
	assert.equal(readLeaseVerdict(path, now, cwd), "held-stale", "a garbage writer lock does not hold");

	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now + 60_000, writerPid: 4242, writerProxy: true, writerPidAt: now - 1_000 });
	assert.equal(readLeaseVerdict(path, now, cwd), "held-live", "a fresh proxy pid is inside its trust window");
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now + 60_000, writerPid: 4242, writerProxy: true, writerPidAt: now - 60_001, host: localHost() });
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
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now - 1, writerPid: deadPid(), writerProxy: false, writerPidAt: now, host: localHost() });
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

test("adoption replaces the token under the per-path mutex: never a truncating rewrite", async (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const path = lockPathFor(cwd, "init", dir);
	const outcome = await acquireInitLock(cwd, { locksDir: dir, waitMs: 50, pollMs: 5 });
	assert.equal(outcome.outcome, "acquired");
	if (outcome.outcome !== "acquired") return;

	// A live foreign mutex holder owns the critical section on this path (the same per-path mutex
	// stale recovery and release serialize on): adoption must fail closed beside it and leave the
	// token byte-for-byte untouched.
	const now = Date.now();
	writeToken(path + ".mutex", { pid: process.pid, startedAt: now, expiresAt: now + 60_000 });
	const before = readFileSync(path, "utf8");
	outcome.adopt(4242, false);
	assert.equal(readFileSync(path, "utf8"), before, "beside the mutex holder the token is left untouched");

	// The critical section freed: the updated metadata is written whole to a temp file beside the
	// token and renamed over it, so a crash mid-write can never leave the empty or partial token
	// whose verdict is "unknown" forever (fail-closed expiry cannot restore a damaged file).
	rmSync(path + ".mutex", { force: true });
	const beforeStat = statSync(path);
	outcome.adopt(4242, false);
	const token = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	assert.equal(token.writerPid, 4242);
	assert.equal(token.writerProxy, false);
	const afterStat = statSync(path);
	if (beforeStat.ino !== 0 && afterStat.ino !== 0) {
		assert.notEqual(afterStat.ino, beforeStat.ino, "the token is replaced by rename, not rewritten in place");
	}
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".mutex") || name.endsWith(".stale")), [], "adoption leaves no temp, mutex, or stale-steal litter behind");
	outcome.release();
});

test("adoption waits out brief per-path mutex contention instead of skipping at the first deadline", async (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const path = lockPathFor(cwd, "sync", dir);
	const lease = tryAcquireSyncLease(cwd, dir);
	assert.ok(lease !== undefined, "the free sync lease is acquired");

	// A live local holder's mutex that ages out mid-wait: withPathMutex must keep waiting while
	// the holder is live and the record unexpired (the spawned-writer record outlives a brief
	// stall), then steal the expired mutex and publish the adoption — not skip at the first deadline.
	const now = Date.now();
	writeToken(path + ".mutex", { pid: process.pid, startedAt: now, expiresAt: now + 600 });
	const started = Date.now();
	lease.adopt(4242, false);
	const elapsed = Date.now() - started;
	const token = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	assert.equal(token.writerPid, 4242, "the adoption waits out the contended window and publishes");
	assert.ok(elapsed >= 500, `adoption waited out the contention (elapsed ${elapsed} ms)`);
	lease.release();
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".mutex") || name.endsWith(".stale")), [], "adoption leaves no temp, mutex, or stale-steal litter behind");
});

test("two real sessions reclaiming one stale token: exactly one acquisition, the winner's token survives", async (t) => {
	const dir = locksDir(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-race-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "race.json");
	const now = Date.now();
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now - 1, host: localHost() });

	const log = join(sandbox, "race.log");
	const script = join(sandbox, "child.mjs");
	// Both children wait for each other's marker before reclaiming, so both verdicts read the same
	// stale token instead of one seeing the other's fresh one. Each child records its attempt result
	// before anything else, and the winner holds the lease until the other result exists: a fixed hold
	// duration would hand an early release to a late second attempt, letting both acquire.
	writeFileSync(script, [
		'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, logPath, mine, theirs, doneMine, doneTheirs] = process.argv.slice(2);",
		"writeFileSync(mine, String(process.pid));",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(theirs)) {",
		"	if (Date.now() >= deadline) process.exit(2);",
		"}",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000);",
		"writeFileSync(doneMine, lease ? \"acquired\" : \"lost\");",
		"if (!lease) {",
		'	appendFileSync(logPath, `lost ${process.pid}\\n`);',
		"	process.exit(0);",
		"}",
		'	appendFileSync(logPath, `acquired ${process.pid}\\n`);',
		"const holdDeadline = Date.now() + 10_000;",
		"while (!existsSync(doneTheirs)) {",
		"	if (Date.now() >= holdDeadline) process.exit(3);",
		"}",
		"	lease.release();",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const closed = (child: ReturnType<typeof spawn>) => new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	const children = [
		spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, log, join(sandbox, "ready-a"), join(sandbox, "ready-b"), join(sandbox, "done-a"), join(sandbox, "done-b")], { stdio: "ignore" }),
		spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, log, join(sandbox, "ready-b"), join(sandbox, "ready-a"), join(sandbox, "done-b"), join(sandbox, "done-a")], { stdio: "ignore" }),
	];
	const codes = await Promise.all(children.map(closed));
	assert.deepEqual(codes, [0, 0]);
	const lines = readFileSync(log, "utf8").trim().split("\n").filter((line) => line.length > 0).map((line) => line.split(" ")[0]).sort();
	assert.deepEqual(lines, ["acquired", "lost"], `exactly one session may acquire, got: ${lines.join(" | ")}`);
	assert.equal(readLeaseVerdict(path, Date.now()), "free", "the winner released and the loser removed nothing");
});

test("two real sessions reclaiming one stale token beside a pre-existing stale mutex: exactly one acquisition", async (t) => {
	const dir = locksDir(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-race2-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "race.json");
	const now = Date.now();
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now - 1, host: localHost() });
	// A reclaimer died mid-recovery and left its stale mutex behind: both sessions must steal THAT
	// mutex (not merely race an empty path) before either reaches the stale lease token, so both
	// stale observations target the same pre-existing mutex file.
	writeToken(`${path}.mutex`, { pid: deadPid(), startedAt: now, expiresAt: now + 60_000 });

	const log = join(sandbox, "race.log");
	const script = join(sandbox, "child.mjs");
	writeFileSync(script, [
		'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, logPath, mine, theirs, doneMine, doneTheirs] = process.argv.slice(2);",
		"writeFileSync(mine, String(process.pid));",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(theirs)) {",
		"	if (Date.now() >= deadline) process.exit(2);",
		"}",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000);",
		"writeFileSync(doneMine, lease ? \"acquired\" : \"lost\");",
		"if (!lease) {",
		'	appendFileSync(logPath, `lost ${process.pid}\\n`);',
		"	process.exit(0);",
		"}",
		'	appendFileSync(logPath, `acquired ${process.pid}\\n`);',
		"const holdDeadline = Date.now() + 10_000;",
		"while (!existsSync(doneTheirs)) {",
		"	if (Date.now() >= holdDeadline) process.exit(3);",
		"}",
		"	lease.release();",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const closed = (child: ReturnType<typeof spawn>) => new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	const children = [
		spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, log, join(sandbox, "ready-a"), join(sandbox, "ready-b"), join(sandbox, "done-a"), join(sandbox, "done-b")], { stdio: "ignore" }),
		spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, log, join(sandbox, "ready-b"), join(sandbox, "ready-a"), join(sandbox, "done-b"), join(sandbox, "done-a")], { stdio: "ignore" }),
	];
	const codes = await Promise.all(children.map(closed));
	assert.deepEqual(codes, [0, 0]);
	const lines = readFileSync(log, "utf8").trim().split("\n").filter((line) => line.length > 0).map((line) => line.split(" ")[0]).sort();
	assert.deepEqual(lines, ["acquired", "lost"], `exactly one session may acquire beside a stale mutex, got: ${lines.join(" | ")}`);
	assert.equal(readLeaseVerdict(path, Date.now()), "free", "the winner released and the loser removed nothing");
});

test("a reclaimer whose mutex was replaced mid-section aborts instead of removing the newer owner's token", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	const host = localHostIdentity();
	if (host === null) {
		t.skip("this platform cannot derive holder identity");
		return;
	}
	const dir = locksDir(t);
	const cwd = project(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-fifo-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "token.json");
	const now = Date.now();
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now - 1, host });
	// The child's verdict consults codegraph.lock on every read: a fifo placed there parks the
	// child at a deterministic point inside its stale recovery.
	mkdirSync(join(cwd, ".codegraph"), { recursive: true });
	const fifo = join(cwd, ".codegraph", "codegraph.lock");
	execFileSync("mkfifo", [fifo]);

	const marker = join(sandbox, "result");
	const done = join(sandbox, "done");
	const script = join(sandbox, "child.mjs");
	writeFileSync(script, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, cwd, marker, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now(), cwd);",
		"writeFileSync(marker, lease ? \"acquired\" : \"lost\");",
		"if (lease) {",
		"	const deadline = Date.now() + 10_000;",
		"	while (!existsSync(done)) {",
		"		if (Date.now() >= deadline) process.exit(3);",
		"	}",
		"	lease.release();",
		"}",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, cwd, marker, done], { stdio: "ignore" });
	t.after(() => {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});
	const closed = new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});

	// Park 1: the child's first verdict blocks reading the fifo. Unblocking it lets the child take
	// the per-path mutex and enter its critical section, whose in-section recheck parks again.
	releaseParkedFifo(await parkFifo(fifo));
	// Park 2: the child now sits inside its critical section, holding the mutex. The mutex file is
	// the only reliable proof the first read completed: re-opening the fifo immediately after the
	// release can satisfy the open against the still-blocked first reader (Linux schedules its EOF
	// late), permanently denying it EOF. Wait for the mutex, then park the in-section recheck.
	const sectionDeadline = Date.now() + 10_000;
	while (!existsSync(`${path}.mutex`)) {
		if (Date.now() >= sectionDeadline) assert.fail("the child never entered its critical section");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const parked = await parkFifo(fifo);
	assert.equal(existsSync(`${path}.mutex`), true, "the parked child holds the per-path mutex inside its section");

	// The hazard [4590605571] names, materialized: another reclaimer holding an earlier stale
	// observation removes the section holder's mutex instead of the one it observed stale. The
	// replacement owner is then mid-recovery itself: it holds a fresh mutex over a path whose
	// token still READS stale — exactly what the parked child's recheck will see, so the verdict
	// alone cannot save that token and the owns() fence is the only thing left standing between
	// the displaced section and removing the newer owner's state [4593661541].
	rmSync(`${path}.mutex`, { force: true });
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1, host });
	const replacementMutex = `${path}.mutex`;
	writeToken(replacementMutex, { pid: process.pid, startedAt: now, expiresAt: now + 60_000, nonce: randomUUID() });
	const replacementTokenBytes = readFileSync(path, "utf8");
	const replacementMutexBytes = readFileSync(replacementMutex, "utf8");

	// The parked child's verdict completes now: the recheck reads the stale-looking token under a
	// mutex it no longer owns — it must abort at the fence, acquire nothing, and remove neither
	// the replacement owner's token nor the replacement mutex.
	releaseParkedFifo(parked);
	await waitForFileContents(marker, "lost", "the child never reported its acquisition result");
	assert.equal(readFileSync(path, "utf8"), replacementTokenBytes, "the newer owner's stale-looking token survives byte-for-byte: the fence, not the verdict, saved it");
	assert.equal(readFileSync(replacementMutex, "utf8"), replacementMutexBytes, "the replacement owner's mutex is never removed by the displaced section's exit");
	writeFileSync(done, "");
	assert.equal(await closed, 0);
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".stale")), [], "no temp or stale-steal litter is left behind");
});

test("malformed lease fields stay unknown even when expired: unsupported kind, non-integer pid, non-finite timestamps", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();
	// Every record below is expired and would otherwise read as locally reclaimable: a record this
	// module could never have written must stay fail-closed instead of turning held-stale.
	writeToken(path, { kind: "other", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1, host: localHost() });
	assert.equal(readLeaseVerdict(path, now), "unknown", "an unsupported kind is unknown even when expired");

	writeToken(path, { kind: "init", pid: 4.5, startedAt: now - 120_000, expiresAt: now - 1, host: localHost() });
	assert.equal(readLeaseVerdict(path, now), "unknown", "a fractional pid is unknown even when expired");
	writeToken(path, { kind: "init", pid: 0, startedAt: now - 120_000, expiresAt: now - 1, host: localHost() });
	assert.equal(readLeaseVerdict(path, now), "unknown", "pid 0 is never a holder");

	writeToken(path, { kind: "init", pid: process.pid, startedAt: Number.NaN, expiresAt: now - 1, host: localHost() });
	assert.equal(readLeaseVerdict(path, now), "unknown", "a NaN startedAt is unknown");
	writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: Number.POSITIVE_INFINITY, host: localHost() });
	assert.equal(readLeaseVerdict(path, now), "unknown", "a non-finite expiry is unknown, never held forever");

	// A well-formed expired token keeps its recovery verdict exactly as before.
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1, host: localHost() });
	assert.equal(readLeaseVerdict(path, now), "held-stale", "a well-formed expired token is still stale");
});

test("acquireInitLock bounds mutex contention and polling by the remaining wait budget", async (t) => {
	const dir = locksDir(t);
	const cwd = project(t);
	const path = lockPathFor(cwd, "init", dir);
	const now = Date.now();

	// A stale token beside a live mutex holder: the acquisition attempt must spend only the
	// remaining wait budget waiting on that mutex, not its own default contention wait on top of
	// the loop's deadline.
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now, expiresAt: now - 1, host: localHost() });
	writeToken(`${path}.mutex`, { pid: process.pid, startedAt: now, expiresAt: now + 60_000 });
	let started = Date.now();
	let outcome = await acquireInitLock(cwd, { locksDir: dir, waitMs: 100, pollMs: 5, exists: () => false });
	assert.equal(outcome.outcome, "skipped");
	assert.ok(Date.now() - started < 200, `mutex contention must consume only the remaining budget (elapsed ${Date.now() - started}ms)`);
	rmSync(`${path}.mutex`, { force: true });
	rmSync(path, { force: true });

	// Polling never sleeps past the deadline either: each poll is capped to the remainder.
	writeToken(path, liveToken(Date.now()));
	started = Date.now();
	outcome = await acquireInitLock(cwd, { locksDir: dir, waitMs: 150, pollMs: 1_000, exists: () => false });
	assert.equal(outcome.outcome, "skipped");
	assert.ok(Date.now() - started < 600, `a poll must not sleep past the remaining budget (elapsed ${Date.now() - started}ms)`);
});

test("a reclaimer steals the exact mutex it judged stale, never a replacement published meanwhile", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	const dir = locksDir(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-steal-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "token.json");
	const mutex = `${path}.mutex`;
	const now = Date.now();
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now - 1, host: localHost() });
	// The mutex the child will judge stale: its holder pid is verifiably dead. A fifo at the mutex
	// name parks the child's holder read at the exact moment it takes that decision.
	execFileSync("mkfifo", [mutex]);
	const deadMutexBytes = `${JSON.stringify({ pid: deadPid(), startedAt: now, expiresAt: now + 60_000 })}\n`;

	const marker = join(sandbox, "result");
	const script = join(sandbox, "child.mjs");
	writeFileSync(script, [
		'import { writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, marker] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now());",
		"writeFileSync(marker, lease ? \"acquired\" : \"lost\");",
		"if (lease) lease.release();",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, marker], { stdio: "ignore" });
	t.after(() => {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});
	const closed = new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});

	// Park: the child's holder read blocks on the fifo. While it is parked, the dead holder's
	// mutex name is taken over by a live replacement owner — the replacement must survive the
	// child's steal, and the child must fail-closed beside the live mutex it cannot distinguish
	// from the dead record it read.
	const parked = await parkFifo(mutex);
	rmSync(mutex);
	writeToken(mutex, { pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 60_000, nonce: randomUUID() });
	const replacementBytes = readFileSync(mutex, "utf8");
	writeSync(parked, deadMutexBytes);
	closeSync(parked);

	await waitForFileContents(marker, "lost", "the child never reported its acquisition result");
	assert.equal(readFileSync(mutex, "utf8"), replacementBytes, "the replacement owner's mutex survives byte-for-byte");
	assert.equal(readLeaseVerdict(path, Date.now()), "held-stale", "the stale token itself is untouched: nobody acquired beside the live mutex");
	assert.equal(await closed, 0);
});

test("an adoption stalled past its final fence cannot replace the successor's token", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	const dir = locksDir(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-adopt2-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "token.json");
	const ready = join(sandbox, "ready");
	const go = join(sandbox, "go");
	const marker = join(sandbox, "result");
	const done = join(sandbox, "done");
	const script = join(sandbox, "child.mjs");
	// The child acquires the free path, then parks INSIDE its adoption: the token file is swapped
	// for a fifo (the checks' read parks first), then the mutex file is swapped for a fifo too
	// (the owns() fence parks) — displacement lands strictly after the final check.
	writeFileSync(script, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, ready, go, marker, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now());",
		"writeFileSync(ready, lease ? \"acquired\" : \"lost\");",
		"if (!lease) process.exit(1);",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(go)) {",
		"	if (Date.now() >= deadline) process.exit(2);",
		"}",
		"lease.adopt(4242, false);",
		"writeFileSync(marker, \"adopted\");",
		"const doneDeadline = Date.now() + 10_000;",
		"while (!existsSync(done)) {",
		"	if (Date.now() >= doneDeadline) process.exit(3);",
		"}",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, ready, go, marker, done], { stdio: "ignore" });
	t.after(() => {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});
	const closed = new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	await waitForFileContents(ready, "acquired", "the child never acquired the lease");

	// Park 1: the adoption's token read parks on a fifo at the token path, inside the per-path mutex.
	const adoptedFrom = readFileSync(path, "utf8");
	rmSync(path);
	execFileSync("mkfifo", [path]);
	writeFileSync(go, "");
	const sectionDeadline = Date.now() + 10_000;
	while (!existsSync(`${path}.mutex`)) {
		if (Date.now() >= sectionDeadline) assert.fail("the child never entered its adoption section");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const parkedToken = await parkFifo(path);
	// Park 2: while the token read is parked, the mutex file is swapped for a fifo, so the owns()
	// fence directly before the publish becomes the second park point.
	const childMutexBytes = readFileSync(`${path}.mutex`, "utf8");
	rmSync(`${path}.mutex`);
	execFileSync("mkfifo", [`${path}.mutex`]);
	writeSync(parkedToken, adoptedFrom);
	closeSync(parkedToken);
	const parkedFence = await parkFifo(`${path}.mutex`);

	// The adopter is displaced exactly as a stall past the mutex TTL displaces it: the mutex name
	// goes, the token name goes, and a replacement owner acquires the now-free path under a fresh
	// mutex of its own.
	rmSync(`${path}.mutex`);
	rmSync(path);
	const successor = tryAcquireLease(path, "sync", 120_000, Date.now());
	assert.ok(successor, "with the path clear the replacement owner acquires it");
	const replacementToken = readFileSync(path, "utf8");
	const replacementMutex = `${path}.mutex`;
	writeToken(replacementMutex, { pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 60_000, nonce: randomUUID() });
	const replacementMutexBytes = readFileSync(replacementMutex, "utf8");

	// The stalled fence completes with the child's own mutex bytes: owns() passes, but the publish
	// that follows must be incapable of replacing the successor's token.
	writeSync(parkedFence, childMutexBytes);
	closeSync(parkedFence);
	await waitForFileContents(marker, "adopted", "the child never finished its adoption");
	assert.equal(readFileSync(path, "utf8"), replacementToken, "the adoption must not publish over the successor's token");
	assert.equal(readFileSync(replacementMutex, "utf8"), replacementMutexBytes, "the successor's mutex is never removed by the displaced adoption");
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".stale")), [], "the aborted adoption leaves no temp or stale litter behind");
	writeFileSync(done, "");
	assert.equal(await closed, 0);
	rmSync(replacementMutex, { force: true }); // the replacement owner's section ends: its mutex goes
	successor.release();
	assert.equal(readLeaseVerdict(path, Date.now()), "free");
});

test("a release stalled past its nonce check never removes a successor's token", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	const dir = locksDir(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-rel-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "token.json");
	const ready = join(sandbox, "ready");
	const go = join(sandbox, "go");
	const done = join(sandbox, "done");
	const script = join(sandbox, "child.mjs");
	// The child acquires the path, then parks INSIDE its release: the token file is swapped for a
	// fifo, so the release's nonce read blocks on the parent's writer — the exact point where a
	// stalled releaser resumes after its lease expired and a successor retook the path.
	writeFileSync(script, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, ready, go, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now());",
		"if (!lease) process.exit(1);",
		"writeFileSync(ready, \"\");",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(go)) {",
		"	if (Date.now() >= deadline) process.exit(2);",
		"}",
		"lease.release();",
		"writeFileSync(done, \"\");",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, ready, go, done], { stdio: "ignore" });
	t.after(() => {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});
	const closed = new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	const readyDeadline = Date.now() + 10_000;
	while (!existsSync(ready)) {
		if (Date.now() >= readyDeadline) assert.fail("the child never acquired the lease");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	// Swap the live token for a fifo: the child's release parks at its nonce read inside the
	// per-path mutex (the mutex file appearing proves the section was entered).
	const releasedBytes = readFileSync(path, "utf8");
	rmSync(path);
	execFileSync("mkfifo", [path]);
	writeFileSync(go, "");
	const sectionDeadline = Date.now() + 10_000;
	while (!existsSync(`${path}.mutex`)) {
		if (Date.now() >= sectionDeadline) assert.fail("the child never entered its release section");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const parked = await parkFifo(path);

	// The releaser is displaced exactly as a stall past the mutex TTL displaces it: its mutex is
	// removed, the token name goes, and a successor acquires the now-free path.
	rmSync(`${path}.mutex`, { force: true });
	rmSync(path);
	const successor = tryAcquireLease(path, "sync", 120_000, Date.now());
	assert.ok(successor, "with the path clear the successor acquires it");
	const successorBytes = readFileSync(path, "utf8");

	// The stalled release resumes: its nonce check passes against the bytes it read, but the
	// removal must not touch the successor's token at the filesystem operation.
	writeSync(parked, releasedBytes);
	closeSync(parked);
	const doneDeadline = Date.now() + 10_000;
	while (!existsSync(done)) {
		if (Date.now() >= doneDeadline) assert.fail("the child never finished its release");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(await closed, 0);
	assert.ok(existsSync(path), "the successor's token survives the stalled release");
	assert.equal(readFileSync(path, "utf8"), successorBytes, "byte-for-byte: a displaced releaser removes nothing");
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".stale") || name.endsWith(".mutex")), [], "the stalled release leaves no litter behind");
	successor.release();
	assert.equal(readLeaseVerdict(path, Date.now()), "free");
});

test("stale recovery stalled past its fence never deletes a successor's published token", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	const dir = locksDir(t);
	const cwd = project(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-fence-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "token.json");
	const now = Date.now();
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1, host: localHost(), nonce: "stale-record" });
	// The child's verdict consults codegraph.lock on every read: a fifo placed there parks the
	// child at deterministic points around its stale recovery.
	mkdirSync(join(cwd, ".codegraph"), { recursive: true });
	const fifo = join(cwd, ".codegraph", "codegraph.lock");
	execFileSync("mkfifo", [fifo]);

	const marker = join(sandbox, "result");
	const done = join(sandbox, "done");
	const script = join(sandbox, "child.mjs");
	writeFileSync(script, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, cwd, marker, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now(), cwd);",
		"writeFileSync(marker, lease ? \"acquired\" : \"lost\");",
		"if (lease) {",
		"	const deadline = Date.now() + 10_000;",
		"	while (!existsSync(done)) {",
		"		if (Date.now() >= deadline) process.exit(3);",
		"	}",
		"	lease.release();",
		"}",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, cwd, marker, done], { stdio: "ignore" });
	t.after(() => {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});
	const closed = new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});

	// Park 1: the child's first verdict blocks reading the fifo; unblocking it lets the child take
	// the per-path mutex and enter its critical section, whose in-section recheck parks again.
	releaseParkedFifo(await parkFifo(fifo));
	const sectionDeadline = Date.now() + 10_000;
	while (!existsSync(`${path}.mutex`)) {
		if (Date.now() >= sectionDeadline) assert.fail("the child never entered its critical section");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const parkedRecheck = await parkFifo(fifo);
	// While the recheck is parked, the child's mutex is swapped for a fifo: the owns() fence just
	// past the recheck becomes the next park point — displacement lands AFTER the final check.
	const childMutexBytes = readFileSync(`${path}.mutex`, "utf8");
	rmSync(`${path}.mutex`);
	execFileSync("mkfifo", [`${path}.mutex`]);
	releaseParkedFifo(parkedRecheck);
	const parkedFence = await parkFifo(`${path}.mutex`);

	// The reclaimer is displaced past its fence exactly as a stall past the mutex TTL displaces
	// it: the mutex name goes, the stale token is cleared as the successor's recovery would, and
	// the successor publishes its own token on the now-free path.
	rmSync(`${path}.mutex`);
	rmSync(path);
	const successor = tryAcquireLease(path, "sync", 120_000, Date.now());
	assert.ok(successor, "with the path clear the successor acquires it");
	const successorBytes = readFileSync(path, "utf8");

	// The stalled fence completes with the child's own mutex bytes: owns() passes, and the removal
	// that follows must still not delete the successor's published token.
	writeSync(parkedFence, childMutexBytes);
	closeSync(parkedFence);
	await waitForFileContents(marker, "lost", "the child never reported its acquisition result");
	assert.equal(readFileSync(path, "utf8"), successorBytes, "the successor's published token survives the stalled recovery byte-for-byte");
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".stale")), [], "no temp or stale-steal litter is left behind");
	successor.release();
	assert.equal(readLeaseVerdict(path, Date.now()), "free");
	writeFileSync(done, "");
	assert.equal(await closed, 0);
});

/** Finds the single `.stale` graveyard a parked child's rename created beside the token path. */
async function findGraveyard(dir: string, base: string): Promise<string> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const stale = readdirSync(dir).filter((name) => name.startsWith(`${base}.`) && name.endsWith(".stale"));
		if (stale.length === 1) return join(dir, stale[0]);
		if (Date.now() >= deadline) assert.fail("the parked section never displaced its record");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("a foreign token's writer or holder pid is never read as a live local refresh", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();
	// A locks dir under a shared homedir can carry another host's token; its recorded pids mean
	// nothing here. The coincidental-pid hazard: the foreign token's writer pid happens to name
	// THIS live local process.
	const foreign = "linux:01234567-89ab-cdef-0123-456789abcdef:pid:[1]";
	writeToken(path, { kind: "sync", pid: 4242, startedAt: now, expiresAt: now + 60_000, host: foreign, writerPid: process.pid, writerProxy: false, writerPidAt: now });
	assert.equal(readLeaseVerdict(path, now), "unknown", "a foreign token with a locally-live writer pid is unknown, never held-live");
	writeToken(path, { kind: "sync", pid: 4242, startedAt: now - 120_000, expiresAt: now - 1, host: foreign, writerPid: process.pid, writerProxy: false, writerPidAt: now });
	assert.equal(readLeaseVerdict(path, now), "unknown", "expired too: the TTL does not turn a foreign writer pid into a local one");
	assert.equal(tryAcquireLease(path, "sync", 120_000, now), undefined, "and the path is never stolen past it");

	// A foreign proxy report inside its trust window is equally unprovable here.
	writeToken(path, { kind: "init", pid: 4242, startedAt: now, expiresAt: now + 60_000, host: foreign, writerPid: 4242, writerProxy: true, writerPidAt: now - 1_000 });
	assert.equal(readLeaseVerdict(path, now), "unknown", "a foreign proxy window never holds as a local refresh");

	// An unexpired foreign holder whose pid happens to be live locally is just as unprovable.
	writeToken(path, { kind: "sync", pid: process.pid, startedAt: now, expiresAt: now + 60_000, host: foreign });
	assert.equal(readLeaseVerdict(path, now), "unknown", "a foreign holder is never a live local holder");

	// The daemonless refresh consumer reads this verdict: a foreign sync token must never be
	// reported as another session's handled refresh on the strength of a coincidental pid.
	const cwd = project(t);
	const syncPath = lockPathFor(cwd, "sync", dir);
	writeToken(syncPath, { kind: "sync", pid: 4242, startedAt: now, expiresAt: now + 60_000, host: foreign, writerPid: process.pid, writerProxy: false, writerPidAt: now });
	assert.equal(syncLeaseHeldLive(cwd, dir), false, "a foreign token's coincidental writer pid is nobody's handled refresh");

	// Local provenance keeps writer liveness exactly as before, identity-less legacy included.
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now + 60_000, host: localHost(), writerPid: process.pid, writerProxy: false, writerPidAt: now });
	assert.equal(readLeaseVerdict(path, now), "held-live", "a matching local writer still holds its launcher's token");
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now, expiresAt: now + 60_000, writerPid: process.pid, writerProxy: false, writerPidAt: now });
	assert.equal(readLeaseVerdict(path, now), "held-live", "an identity-less token's live writer still holds (legacy shape)");
});

test("an expired host-less token needs a dead holder: a live holder is never reclaimed", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	// A null-identity host (neither identity derivation available) treats a host-less token as
	// local: expiry alone must not hand the lease over while the holder still lives and may
	// still be starting its writer. The writer checks have already cleared writer pids here.
	writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1 });
	assert.equal(readLeaseVerdict(path, now, undefined, null), "unknown", "a live holder on a null-identity host fail-closes even past the TTL");
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1 });
	assert.equal(readLeaseVerdict(path, now, undefined, null), "held-stale", "a dead holder's TTL reclaim stands on a null-identity host");

	// On a host with identity the same host-less shape already failed closed; a matching-host
	// token keeps the TTL as its hard displacement bound there.
	const host = localHostIdentity();
	if (host !== null) {
		writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1 });
		assert.equal(readLeaseVerdict(path, now), "unknown", "an identity host never reclaims a host-less token from a live holder");
		writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1, host });
		assert.equal(readLeaseVerdict(path, now), "held-stale", "an expired matching-host token is displaced even while its holder lives");
	}
});

test("a host-less expired token is reclaimed only with local PID provenance and a confirmed death", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	// Two PID namespaces can share one locks directory: a host-less token from the other
	// namespace names pids that do not exist here, and a local ESRCH on such a pid proves
	// nothing about its holder. A reader that can derive its own identity can never place a
	// host-less holder inside its own namespace, so the expired verdict fail-closes whatever
	// a local probe says — even a dead-looking pid must not hand the lease over.
	const host = localHostIdentity();
	if (host !== null) {
		writeToken(path, { kind: "init", pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1 });
		assert.equal(readLeaseVerdict(path, now), "unknown", "an identity-capable reader never reclaims a host-less token, dead-looking pid included");
		assert.equal(tryAcquireLease(path, "sync", 120_000, now), undefined, "and the path is never stolen past it");
		writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1 });
		assert.equal(readLeaseVerdict(path, now), "unknown", "a live holder stays fail-closed exactly as before");
	}

	// The one provable scope for a host-less holder is a reader of the same identity-less kind:
	// there the reclaim still stands — but only on a death the reader's own namespace confirms.
	writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1 });
	assert.equal(readLeaseVerdict(path, now, undefined, null), "unknown", "a live holder on a null-identity host is never reclaimed past its TTL");
	writeToken(path, { kind: "init", pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1 });
	assert.equal(readLeaseVerdict(path, now, undefined, null), "held-stale", "a confirmed local death keeps the null-identity reclaim");
});

test("an acquirer paused past its scan cannot publish beside a successor's open adoption window", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	const dir = locksDir(t);
	const cwd = project(t);
	const path = join(dir, "token.json");
	const now = Date.now();
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1, host: localHost(), nonce: "stale-record" });
	// The writer-lock fifo parks session A's verdict and recheck at deterministic points: every
	// readLeaseVerdict consults the lock before the token, so the parent controls both.
	mkdirSync(join(cwd, ".codegraph"), { recursive: true });
	const lockFifo = join(cwd, ".codegraph", "codegraph.lock");
	execFileSync("mkfifo", [lockFifo]);

	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-window-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const markerA = join(sandbox, "a-result");
	const doneA = join(sandbox, "a-done");
	const scriptA = join(sandbox, "a.mjs");
	// Session A reclaims the stale token and parks INSIDE its removal, past every validation:
	// the recheck's token read and the observed-nonce read park on a fifo swapped in for the
	// token, and the removal's rename moves that fifo to the graveyard name, where the
	// grabbed-record read parks — the exact point between the scan and the publish link.
	writeFileSync(scriptA, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, cwd, marker, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now(), cwd);",
		"writeFileSync(marker, lease ? \"acquired\" : \"lost\");",
		"if (lease) {",
		"	const deadline = Date.now() + 10_000;",
		"	while (!existsSync(done)) {",
		"		if (Date.now() >= deadline) process.exit(3);",
		"	}",
		"	lease.release();",
		"}",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const childA = spawn(process.execPath, ["--experimental-strip-types", scriptA, libHref, path, cwd, markerA, doneA], { stdio: "ignore" });
	t.after(() => {
		try {
			childA.kill();
		} catch {
			/* already gone */
		}
	});
	const closedA = new Promise<number>((resolve) => {
		childA.on("close", (code: number | null) => resolve(code ?? -1));
	});
	// Park 1 (the verdict) and park 2 (the recheck), separated by the child acknowledgment the
	// mutex provides: A's first verdict read is provably complete once A has created the
	// per-path mutex on its way into the section, so the recheck park can only attach to the
	// recheck's own lock read — never to the completing first reader's still-open fd.
	const parkedVerdictLock = await parkFifo(lockFifo);
	releaseParkedFifo(parkedVerdictLock);
	const windowSectionDeadline = Date.now() + 10_000;
	while (!existsSync(`${path}.mutex`)) {
		if (Date.now() >= windowSectionDeadline) assert.fail("A never entered its critical section");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const parkedRecheckLock = await parkFifo(lockFifo);
	const staleBytes = readFileSync(path, "utf8");
	rmSync(path);
	execFileSync("mkfifo", [path]);
	releaseParkedFifo(parkedRecheckLock);
	const parkedRecheck = await parkFifo(path);
	// The fresh fifo inode swapped in while this reader is still parked makes the next park
	// provably a new read of the path: the completing verdict reader lives on the unlinked
	// inode, so the observed-nonce park can never attach to it.
	rmSync(path);
	execFileSync("mkfifo", [path]);
	writeSync(parkedRecheck, staleBytes);
	closeSync(parkedRecheck);
	const parkedObserved = await parkFifo(path);
	writeSync(parkedObserved, staleBytes);
	closeSync(parkedObserved);
	// Park 3: past its fence, A's removal renames the token fifo to the graveyard name and the
	// grabbed-record read parks there — A has finished its scan and stands mid-publish.
	const graveyardA = await findGraveyard(dir, "token.json");
	const parkedGrab = await parkFifo(graveyardA);
	// A's grabbed read keeps its pipe; the NAME becomes the stale record's real bytes so no
	// other reader ever contends for that pipe. A's live mutex is replaced by an expired record
	// a successor can steal, and the lock fifo goes before anything reads the lock again.
	rmSync(graveyardA);
	writeFileSync(graveyardA, staleBytes);
	rmSync(lockFifo, { force: true });
	rmSync(`${path}.mutex`, { force: true });
	writeToken(`${path}.mutex`, { pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1, nonce: randomUUID() });

	// Session B steals the expired mutex, reclaims the free path (its pre-scan drops the stale
	// sidecar as abandoned litter), then parks INSIDE its adoption: the token path is swapped
	// for a fifo, so the adoption's rename moves it to a second graveyard and the grabbed-read
	// parks — B's publish window is open and the path name is empty.
	const readyB = join(sandbox, "b-ready");
	const goB = join(sandbox, "b-go");
	const markerB = join(sandbox, "b-result");
	const doneB = join(sandbox, "b-done");
	const scriptB = join(sandbox, "b.mjs");
	writeFileSync(scriptB, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, ready, go, marker, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now());",
		"writeFileSync(ready, lease ? \"acquired\" : \"lost\");",
		"if (!lease) process.exit(1);",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(go)) {",
		"	if (Date.now() >= deadline) process.exit(2);",
		"}",
		"lease.adopt(4242, false);",
		"writeFileSync(marker, \"adopted\");",
		"const doneDeadline = Date.now() + 10_000;",
		"while (!existsSync(done)) {",
		"	if (Date.now() >= doneDeadline) process.exit(3);",
		"}",
		"lease.release();",
	].join("\n") + "\n");
	const childB = spawn(process.execPath, ["--experimental-strip-types", scriptB, libHref, path, readyB, goB, markerB, doneB], { stdio: "ignore" });
	t.after(() => {
		try {
			childB.kill();
		} catch {
			/* already gone */
		}
	});
	const closedB = new Promise<number>((resolve) => {
		childB.on("close", (code: number | null) => resolve(code ?? -1));
	});
	await waitForFileContents(readyB, "acquired", "the successor never acquired the reclaimed path");
	const bTokenBytes = readFileSync(path, "utf8");
	rmSync(path);
	execFileSync("mkfifo", [path]);
	writeFileSync(goB, "");
	const parkedAdopt = await parkFifo(path);
	writeSync(parkedAdopt, bTokenBytes);
	closeSync(parkedAdopt);
	const graveyardB = await findGraveyard(dir, "token.json");
	const parkedAdopted = await parkFifo(graveyardB);
	rmSync(graveyardB);
	writeFileSync(graveyardB, bTokenBytes);

	// A resumes INTO the open window: its publish link lands on the empty path name. A
	// publication that landed beside a successor's in-flight adoption must not survive it — A
	// reverses its own token and reports lost, and B's adoption completes onto the re-emptied
	// path with its writer record intact.
	writeSync(parkedGrab, staleBytes);
	closeSync(parkedGrab);
	await waitForFileContents(markerA, "lost", "the paused acquirer kept a lease published inside the successor's adoption window");
	writeSync(parkedAdopted, bTokenBytes);
	closeSync(parkedAdopted);
	await waitForFileContents(markerB, "adopted", "the successor never finished its adoption");
	const adopted = JSON.parse(readFileSync(path, "utf8")) as { pid: number; nonce?: string; writerPid?: number; writerProxy?: boolean };
	const bToken = JSON.parse(bTokenBytes) as { pid: number; nonce?: string };
	assert.equal(adopted.pid, bToken.pid, "the completed adoption is the successor's own record");
	assert.equal(adopted.nonce, bToken.nonce, "the successor's acquisition nonce survives the window");
	assert.equal(adopted.writerPid, 4242, "the writer pid the adoption recorded is intact");
	assert.equal(adopted.writerProxy, false, "the direct-writer flag is intact");
	writeFileSync(doneA, "");
	writeFileSync(doneB, "");
	assert.equal(await closedA, 0);
	assert.equal(await closedB, 0);
	assert.equal(readLeaseVerdict(path, Date.now()), "free", "the successor released cleanly");
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".stale") || name.endsWith(".mutex")), [], "no temp, stale, or mutex litter is left behind");
});

test("an adoption whose restore loses to a competing publication recovers the displaced lease when that publication reverses", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	const dir = locksDir(t);
	const cwd = project(t);
	const path = join(dir, "token.json");
	const now = Date.now();
	writeToken(path, { kind: "sync", pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1, host: localHost(), nonce: "stale-record" });
	mkdirSync(join(cwd, ".codegraph"), { recursive: true });
	const lockFifo = join(cwd, ".codegraph", "codegraph.lock");
	execFileSync("mkfifo", [lockFifo]);

	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-recover-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const markerA = join(sandbox, "a-result");
	const doneA = join(sandbox, "a-done");
	const scriptA = join(sandbox, "a.mjs");
	// Session A reclaims the stale token and parks inside its removal exactly as the window test
	// above: the divergence is only WHEN each parked section resumes — B's restore fails while
	// A's publication still stands at the path, BEFORE A's post-publication scan reverses it.
	writeFileSync(scriptA, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, cwd, marker, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now(), cwd);",
		"writeFileSync(marker, lease ? \"acquired\" : \"lost\");",
		"if (lease) {",
		"	const deadline = Date.now() + 10_000;",
		"	while (!existsSync(done)) {",
		"		if (Date.now() >= deadline) process.exit(3);",
		"	}",
		"	lease.release();",
		"}",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const childA = spawn(process.execPath, ["--experimental-strip-types", scriptA, libHref, path, cwd, markerA, doneA], { stdio: "ignore" });
	t.after(() => {
		try {
			childA.kill();
		} catch {
			/* already gone */
		}
	});
	const closedA = new Promise<number>((resolve) => {
		childA.on("close", (code: number | null) => resolve(code ?? -1));
	});
	// Park 1 (the verdict) releases only against a fifo A provably still reads, so the mutex
	// acknowledgment below — not fifo reuse — gates park 2 (the recheck's lock read).
	const parkedVerdictLock = await parkFifo(lockFifo);
	releaseParkedFifo(parkedVerdictLock);
	const sectionDeadline = Date.now() + 10_000;
	while (!existsSync(`${path}.mutex`)) {
		if (Date.now() >= sectionDeadline) assert.fail("A never entered its critical section");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const parkedRecheckLock = await parkFifo(lockFifo);
	const staleBytes = readFileSync(path, "utf8");
	rmSync(path);
	execFileSync("mkfifo", [path]);
	releaseParkedFifo(parkedRecheckLock);
	// The recheck verdict's token read parks; the fresh fifo inode swapped in while it is parked
	// makes the observed-nonce park provably a new read of the path.
	const parkedRecheck = await parkFifo(path);
	rmSync(path);
	execFileSync("mkfifo", [path]);
	writeSync(parkedRecheck, staleBytes);
	closeSync(parkedRecheck);
	const parkedObserved = await parkFifo(path);
	writeSync(parkedObserved, staleBytes);
	closeSync(parkedObserved);
	// Park 3: past its fence, A's removal renames the token fifo to the graveyard name and the
	// grabbed-record read parks there — A has finished its scan and stands mid-publish.
	const graveyardA = await findGraveyard(dir, "token.json");
	const parkedGrab = await parkFifo(graveyardA);
	rmSync(graveyardA);
	writeFileSync(graveyardA, staleBytes);
	rmSync(lockFifo, { force: true });
	rmSync(`${path}.mutex`, { force: true });
	writeToken(`${path}.mutex`, { pid: deadPid(), startedAt: now - 120_000, expiresAt: now - 1, nonce: randomUUID() });

	// Session B steals the expired mutex, reclaims the free path (its pre-scan drops the stale
	// sidecar as abandoned litter), then parks INSIDE its adoption at the displaced record's
	// nonce read — B's publish window is open and the path name is empty.
	const readyB = join(sandbox, "b-ready");
	const goB = join(sandbox, "b-go");
	const markerB = join(sandbox, "b-result");
	const doneB = join(sandbox, "b-done");
	// The acknowledgment that releases A: a retry sleep is the only blocking wait this child can
	// reach once the per-path mutex is held, so a wait it reports after the test cleared the file
	// is proof that the adoption's restore link met the publication at the path. That same
	// sleep hosts a second barrier: the retry it leads into stays parked until A has reversed,
	// and the recovery clock is held still while it waits so the park spends no retry budget.
	const ackB = `${markerB}.checked`;
	const armB = `${markerB}.armed`;
	const releaseB = `${markerB}.released`;
	const scriptB = join(sandbox, "b.mjs");
	writeFileSync(scriptB, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, ready, go, marker, done] = process.argv.slice(2);",
		'const ack = marker + ".checked";',
		'const arm = marker + ".armed";',
		'const release = marker + ".released";',
		"const realWait = Atomics.wait;",
		"const realNow = Date.now;",
		"const spin = new Int32Array(new SharedArrayBuffer(4));",
		"let firstWait = true;",
		"let stalled = 0;",
		"Date.now = () => realNow() - stalled;",
		"Atomics.wait = (...args) => {",
		"\tif (!existsSync(arm) || !firstWait) return realWait(...args);",
		"\tfirstWait = false;",
		'\twriteFileSync(ack, "eexist");',
		"\tconst parkedAt = realNow();",
		"\tconst watchdog = parkedAt + 10_000;",
		"\twhile (!existsSync(release)) {",
		"\t\tif (realNow() >= watchdog) process.exit(4);",
		"\t\trealWait(spin, 0, 0, 5);",
		"\t}",
		"\tstalled += realNow() - parkedAt;",
		"\treturn realWait(...args);",
		"};",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now());",
		"writeFileSync(ready, lease ? \"acquired\" : \"lost\");",
		"if (!lease) process.exit(1);",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(go)) {",
		"	if (Date.now() >= deadline) process.exit(2);",
		"}",
		"lease.adopt(4242, false);",
		"writeFileSync(marker, \"adopted\");",
		"const doneDeadline = Date.now() + 10_000;",
		"while (!existsSync(done)) {",
		"	if (Date.now() >= doneDeadline) process.exit(3);",
		"}",
		"lease.release();",
	].join("\n") + "\n");
	const childB = spawn(process.execPath, ["--experimental-strip-types", scriptB, libHref, path, readyB, goB, markerB, doneB], { stdio: "ignore" });
	t.after(() => {
		try {
			childB.kill();
		} catch {
			/* already gone */
		}
	});
	const closedB = new Promise<number>((resolve) => {
		childB.on("close", (code: number | null) => resolve(code ?? -1));
	});
	await waitForFileContents(readyB, "acquired", "the successor never acquired the reclaimed path");
	const bTokenBytes = readFileSync(path, "utf8");
	rmSync(path);
	execFileSync("mkfifo", [path]);
	writeFileSync(goB, "");
	const parkedAdopt = await parkFifo(path);
	writeSync(parkedAdopt, bTokenBytes);
	closeSync(parkedAdopt);
	const graveyardB = await findGraveyard(dir, "token.json");
	const parkedAdopted = await parkFifo(graveyardB);
	rmSync(graveyardB);
	writeFileSync(graveyardB, bTokenBytes);

	// A resumes and PUBLISHES, then parks again before its post-publication scan: the scan's
	// sidecar verdict reads the writer lock, which is a fifo once more. A's token stands at the
	// path while A is parked — exactly the occupant B's links are about to lose to.
	execFileSync("mkfifo", [lockFifo]);
	writeSync(parkedGrab, staleBytes);
	closeSync(parkedGrab);
	const parkedScan = await parkFifo(lockFifo);

	// B resumes FIRST — the order the fix is for: its publish link loses to A's token at the
	// path, and so does the restore that follows. A's scan then runs, sees B's live sidecar,
	// and reverses A's own publication — leaving the path empty beside B's displaced record.
	// The adoption must recover the displaced lease onto that empty path instead of leaving the
	// project wedged behind a sidecar until it expires.
	// The handshake that pins the order the thread names: A stays parked at its scan — its token
	// provably still at the path — while B's publish link and its first restore both lose to it,
	// and B acknowledges that first EEXIST from inside its retry loop. Only that acknowledgment
	// releases A, and B's retry then waits at a second barrier until A reports its reversal, so
	// neither child's scheduling is part of the ordering: a parent descheduled past the restore's
	// budget cannot strand the displaced record, because the retry only spends that budget while
	// the publication it must outlast still occupies the path.
	rmSync(ackB, { force: true }); // while B stays parked at its nonce read, no wait can follow this clear
	writeFileSync(armB, ""); // arms the retry barrier before B resumes
	writeSync(parkedAdopted, bTokenBytes);
	closeSync(parkedAdopted);
	await waitForFileContents(ackB, "eexist", "the adoption never met the publication at the path");
	assert.ok(existsSync(path), "the competitor's token still stands at the path when the adoption acknowledges its lost links");
	releaseParkedFifo(parkedScan);
	rmSync(lockFifo, { force: true });
	await waitForFileContents(markerA, "lost", "the competing publication never reported its reversal");
	// A's token has left the path while B still sits in its first retry sleep, so the record the
	// restore must re-occupy has an empty path to land on: releasing the barrier here is what
	// keeps A's scheduling out of B's recovery budget, and the path assertion below proves the
	// barrier held B until the reversal was complete.
	assert.ok(!existsSync(path), "the competitor's token left the path before the adoption's retry was released");
	writeFileSync(releaseB, "");
	await waitForFileContents(markerB, "adopted", "the adoption never finished its recovery window");
	assert.ok(existsSync(path), "the displaced lease is back at the path after the competitor reversed its publication");
	const recovered = JSON.parse(readFileSync(path, "utf8")) as { pid: number; nonce?: string; writerPid?: number };
	const bToken = JSON.parse(bTokenBytes) as { pid: number; nonce?: string };
	assert.equal(recovered.pid, bToken.pid, "the recovered record is the successor's own token");
	assert.equal(recovered.nonce, bToken.nonce, "the successor's acquisition nonce survives the recovery");
	assert.equal(recovered.writerPid, undefined, "the adoption's writer update was lost to the race and stays best-effort: the lease itself is what must not be lost");
	assert.equal(readLeaseVerdict(path, Date.now()), "held-live", "the recovered lease holds");
	// The holder can release again — the wedge the race left behind kept release() from finding
	// its own token — and the next acquisition proceeds with no sidecar blocking it.
	writeFileSync(doneA, "");
	writeFileSync(doneB, "");
	assert.equal(await closedA, 0);
	assert.equal(await closedB, 0);
	assert.equal(readLeaseVerdict(path, Date.now()), "free", "the recovered lease released cleanly");
	const fresh = tryAcquireLease(path, "sync", 120_000, Date.now());
	assert.ok(fresh, "no displaced record wedges the path after the recovery");
	fresh.release();
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".stale") || name.endsWith(".mutex")), [], "no temp, stale, or mutex litter is left behind");
});

test("a publication landing in an open restore window never deletes the displaced record", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	const dir = locksDir(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-adopt4-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "token.json");
	const ready = join(sandbox, "ready");
	const go = join(sandbox, "go");
	const marker = join(sandbox, "result");
	const done = join(sandbox, "done");
	const script = join(sandbox, "child.mjs");
	// The child acquires the free path, then parks INSIDE its adoption between the publish
	// link and the restore link: the token path is swapped for a fifo, so the adoption's
	// rename moves the fifo to the graveyard name and the grabbed-record read parks there.
	writeFileSync(script, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, ready, go, marker, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now());",
		"writeFileSync(ready, lease ? \"acquired\" : \"lost\");",
		"if (!lease) process.exit(1);",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(go)) {",
		"	if (Date.now() >= deadline) process.exit(2);",
		"}",
		"lease.adopt(4242, false);",
		"writeFileSync(marker, \"adopted\");",
		"const doneDeadline = Date.now() + 10_000;",
		"while (!existsSync(done)) {",
		"	if (Date.now() >= doneDeadline) process.exit(3);",
		"}",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, ready, go, marker, done], { stdio: "ignore" });
	t.after(() => {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});
	const closed = new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	await waitForFileContents(ready, "acquired", "the child never acquired the lease");

	// Park 1: the adoption's token read parks on a fifo at the token path, inside the per-path
	// mutex the child now holds.
	const tokenBytes = readFileSync(path, "utf8");
	rmSync(path);
	execFileSync("mkfifo", [path]);
	writeFileSync(go, "");
	const parkedToken = await parkFifo(path);

	// Park 2: feeding the token bytes lets the child pass its pid and nonce checks, write its
	// temp, pass the owns() fence, and rename the fifo to the graveyard — where the displaced
	// record's nonce read parks in turn.
	writeSync(parkedToken, tokenBytes);
	closeSync(parkedToken);
	const graveyard = await findGraveyard(dir, "token.json");
	const parkedGrave = await parkFifo(graveyard);

	// The grabbed read keeps its pipe; the NAME becomes the original record's real bytes (never
	// a symlink — its bytes must be the recoverable token itself). A successor occupies the
	// empty path, so the publish link loses to EEXIST, and feeding the grabbed read the
	// holder's own nonce drives the adoption into exactly that double failure.
	rmSync(graveyard);
	writeFileSync(graveyard, tokenBytes);
	const successor = liveToken(Date.now());
	writeToken(path, successor);
	writeSync(parkedGrave, tokenBytes);
	closeSync(parkedGrave);

	await waitForFileContents(marker, "adopted", "the child never finished its adoption");
	assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(successor)}\n`, "the successor's token at the path is untouched");
	const remaining = readdirSync(dir).filter((name) => name.startsWith("token.json.") && name.endsWith(".stale"));
	assert.equal(remaining.length, 1, "the displaced record is kept recoverable beside the publication that landed in the window");
	assert.equal(readFileSync(join(dir, remaining[0]), "utf8"), tokenBytes, "the kept record is the holder's original token, byte-for-byte");
	writeFileSync(done, "");
	assert.equal(await closed, 0);

	// The retained record never wedges the path: once removed (a restore or cleanup handled
	// it), the next acquisition proceeds exactly as before.
	rmSync(join(dir, remaining[0]), { force: true });
	rmSync(path);
	const fresh = tryAcquireLease(path, "sync", 120_000, Date.now());
	assert.ok(fresh, "the path acquires again once the displaced record is explained");
	fresh.release();
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".stale") || name.endsWith(".mutex")), [], "no temp, stale, or mutex litter is left behind");
});

test("an unexplained restore failure keeps the original record's bytes recoverable", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		t.skip("root bypasses the directory permissions this fixture injects");
		return;
	}
	const dir = locksDir(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-adopt5-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "token.json");
	const ready = join(sandbox, "ready");
	const go = join(sandbox, "go");
	const marker = join(sandbox, "result");
	const done = join(sandbox, "done");
	const script = join(sandbox, "child.mjs");
	// The child acquires the free path, then parks INSIDE its adoption at the displaced
	// record's nonce read, exactly as the window test above: the orchestration differs only in
	// the injected failure, which must be a permission error no EEXIST can explain and no
	// platform renders differently — a read-only locks directory — while the original record
	// stays real bytes on disk the whole time.
	writeFileSync(script, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, ready, go, marker, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now());",
		"writeFileSync(ready, lease ? \"acquired\" : \"lost\");",
		"if (!lease) process.exit(1);",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(go)) {",
		"	if (Date.now() >= deadline) process.exit(2);",
		"}",
		"lease.adopt(4242, false);",
		"writeFileSync(marker, \"adopted\");",
		"const doneDeadline = Date.now() + 10_000;",
		"while (!existsSync(done)) {",
		"	if (Date.now() >= doneDeadline) process.exit(3);",
		"}",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, ready, go, marker, done], { stdio: "ignore" });
	t.after(() => {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});
	const closed = new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	await waitForFileContents(ready, "acquired", "the child never acquired the lease");
	const tokenBytes = readFileSync(path, "utf8");
	rmSync(path);
	execFileSync("mkfifo", [path]);
	writeFileSync(go, "");
	const parkedToken = await parkFifo(path);
	writeSync(parkedToken, tokenBytes);
	closeSync(parkedToken);
	const graveyard = await findGraveyard(dir, "token.json");
	const parkedGrave = await parkFifo(graveyard);
	rmSync(graveyard);
	writeFileSync(graveyard, tokenBytes);

	// Both links — the adoption's publish and the restore that follows its failure — hit a
	// read-only locks directory: EACCES, a failure that neither proves a contender nor depends
	// on symlink resolution, with the displaced record's bytes intact on disk beside the path.
	chmodSync(dir, 0o500);
	let remaining: string[] = [];
	try {
		writeSync(parkedGrave, tokenBytes);
		closeSync(parkedGrave);
		await waitForFileContents(marker, "adopted", "the child never finished its adoption");
		remaining = readdirSync(dir).filter((name) => name.startsWith("token.json.") && name.endsWith(".stale"));
		assert.equal(remaining.length, 1, "the displaced record is kept beside the failed restore");
		assert.equal(readFileSync(join(dir, remaining[0]), "utf8"), tokenBytes, "the original record's bytes remain available for recovery");
		assert.equal(existsSync(path), false, "nothing was published into the path while the restore was failing");
	} finally {
		// The registered directory cleanup must be able to remove the records even when a wait
		// or assertion above fails: the read-only window never outlives the test body.
		chmodSync(dir, 0o700);
	}

	// Recovery proceeds the moment the failure is explained: the record links back to the
	// empty path and the holder's lease is effective again, byte-for-byte.
	linkSync(join(dir, remaining[0]), path);
	rmSync(join(dir, remaining[0]), { force: true });
	assert.equal(readFileSync(path, "utf8"), tokenBytes, "the recovered record is the holder's original token");
	writeFileSync(done, "");
	assert.equal(await closed, 0);
	// The read-only window also defeated the section's own cleanups (temp, mutex): they are
	// litter, never state, and go the moment the directory is writable again.
	readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".mutex")).forEach((name) => rmSync(join(dir, name), { force: true }));
	const fresh = tryAcquireLease(path, "sync", 120_000, Date.now());
	assert.ok(fresh, "the dead holder's recovered token is reclaimed and the path acquires again");
	fresh.release();
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".stale") || name.endsWith(".mutex")), [], "no temp, stale, or mutex litter is left behind");
});

test("a late mutex release never removes a contender's replacement mutex", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	const dir = locksDir(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-mutex-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "token.json");
	const mutex = `${path}.mutex`;
	const ready = join(sandbox, "ready");
	const go = join(sandbox, "go");
	const done = join(sandbox, "done");
	const script = join(sandbox, "child.mjs");
	// The child acquires the path, then parks INSIDE its release: the token path is swapped for
	// a fifo (the release's nonce read parks, then the displaced record's nonce read parks), and
	// the mutex path is swapped for a fifo too — so the section's final ownership check parks
	// AFTER every check, exactly where a replacement mutex can take the path.
	writeFileSync(script, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, ready, go, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now());",
		"if (!lease) process.exit(1);",
		"writeFileSync(ready, \"\");",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(go)) {",
		"	if (Date.now() >= deadline) process.exit(2);",
		"}",
		"lease.release();",
		"writeFileSync(done, \"\");",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, ready, go, done], { stdio: "ignore" });
	t.after(() => {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});
	const closed = new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	await waitForFileContents(ready, "", "the child never acquired the lease");

	// Park 1: the release's nonce read parks on a fifo at the token path, inside the child's
	// per-path mutex section.
	const tokenBytes = readFileSync(path, "utf8");
	rmSync(path);
	execFileSync("mkfifo", [path]);
	writeFileSync(go, "");
	const parkedToken = await parkFifo(path);
	// The mutex file is swapped for a fifo as well: every later read of it parks.
	const childMutexBytes = readFileSync(mutex, "utf8");
	rmSync(mutex);
	execFileSync("mkfifo", [mutex]);

	// Park 2: the nonce check passes on the bytes it parked on; the removal renames the fifo
	// token to its graveyard and parks on the displaced record's nonce read.
	writeSync(parkedToken, tokenBytes);
	closeSync(parkedToken);
	const graveyard = await findGraveyard(dir, "token.json");
	const parkedGrave = await parkFifo(graveyard);

	// Park 3: feeding the graveyard unblocks the removal; the section ends and its ownership
	// check parks reading the mutex fifo. While it is parked, the contender replaces the mutex
	// path with its own live record — then the stalled holder's check is fed its OWN bytes.
	writeSync(parkedGrave, tokenBytes);
	closeSync(parkedGrave);
	const parkedMutex = await parkFifo(mutex);
	rmSync(mutex);
	writeToken(mutex, { pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 60_000, nonce: randomUUID() });
	const contenderBytes = readFileSync(mutex, "utf8");
	writeSync(parkedMutex, childMutexBytes);
	closeSync(parkedMutex);

	const doneDeadline = Date.now() + 10_000;
	while (!existsSync(done)) {
		if (Date.now() >= doneDeadline) assert.fail("the child never finished its release");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(await closed, 0);
	assert.ok(existsSync(mutex), "the contender's mutex survives the late release");
	assert.equal(readFileSync(mutex, "utf8"), contenderBytes, "byte-for-byte: the late release removed only its own mutex");
	assert.equal(readLeaseVerdict(path, Date.now()), "free", "the child's own token was released correctly");
	rmSync(mutex, { force: true }); // the contender's section ends: its mutex goes
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".stale") || name.endsWith(".tmp")), [], "no stale or temp litter is left behind");
});

test("a third acquirer beside a displaced live token fail-closes: two lease handles never coexist", async (t) => {
	const dir = locksDir(t);
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-side-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const path = join(dir, "token.json");
	const ready = join(sandbox, "ready");
	const done = join(sandbox, "done");
	const script = join(sandbox, "child.mjs");
	// One holder (B) acquires the lease and keeps it.
	writeFileSync(script, [
		'import { existsSync, writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, ready, done] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now());",
		"writeFileSync(ready, lease ? \"acquired\" : \"lost\");",
		"if (!lease) process.exit(1);",
		"const deadline = Date.now() + 10_000;",
		"while (!existsSync(done)) {",
		"	if (Date.now() >= deadline) process.exit(3);",
		"}",
		"	lease.release();",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, ready, done], { stdio: "ignore" });
	t.after(() => {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});
	const closed = new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	await waitForFileContents(ready, "acquired", "the holder never acquired the lease");
	const holderBytes = readFileSync(path, "utf8");

	// A stalled reclaimer's rename-away window, materialized: the holder's live token is
	// displaced to a recoverable sidecar beside the path, and the path itself reads free. A
	// third acquirer publishing into that window would leave the holder's lease orphaned the
	// moment the stalled reclaimer drops the record — two successful handles on one lease.
	const sidecar = `${path}.${randomUUID()}.stale`;
	renameSync(path, sidecar);
	const third = tryAcquireLease(path, "sync", 120_000, Date.now());
	assert.equal(third, undefined, "no lease is granted beside a displaced live record");
	assert.equal(existsSync(path), false, "the third acquirer published nothing into the window");
	assert.equal(readFileSync(sidecar, "utf8"), holderBytes, "the displaced record is untouched");

	// The stalled reclaimer's restore completes: the holder's token is back at the path and
	// still holds — the third acquirer must meet the live holder, not a free path.
	linkSync(sidecar, path);
	rmSync(sidecar);
	assert.equal(tryAcquireLease(path, "sync", 120_000, Date.now()), undefined, "the restored live token refuses a second lease");

	writeFileSync(done, "");
	assert.equal(await closed, 0);
	assert.equal(readLeaseVerdict(path, Date.now()), "free", "the holder released cleanly");
});

test("an external writer installed during proven mutex contention blocks the free-path publish", async (t) => {
	if (process.platform === "win32") {
		t.skip("the fifo orchestration is POSIX-only");
		return;
	}
	const dir = locksDir(t);
	const cwd = project(t);
	const path = join(dir, "token.json");
	const mutex = `${path}.mutex`;
	mkdirSync(join(cwd, ".codegraph"), { recursive: true });
	// The per-path mutex is a fifo: the child's exclusive create fails on the existing name
	// immediately, and its holder observation parks on the read end — that park proves the
	// child has passed its first verdict and reached mutex contention, and the parent decides
	// exactly when contention ends (removing the fifo releases the mutex explicitly — no TTL
	// wait whose expiry could also swallow the child's first verdict).
	execFileSync("mkfifo", [mutex]);

	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lease-wait-")));
	t.after(() => rmSync(sandbox, { recursive: true, force: true }));
	const started = join(sandbox, "started");
	const marker = join(sandbox, "result");
	const script = join(sandbox, "child.mjs");
	writeFileSync(script, [
		'import { writeFileSync } from "node:fs";',
		"const [libHref, tokenPath, cwd, started, marker] = process.argv.slice(2);",
		"const { tryAcquireLease } = await import(libHref);",
		"writeFileSync(started, \"\");", // after the import: the free-path verdict runs next, inside this tick
		"const lease = tryAcquireLease(tokenPath, \"sync\", 60_000, Date.now(), cwd, 5_000);",
		"writeFileSync(marker, lease ? \"acquired\" : \"lost\");",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-lease.ts", import.meta.url).href;
	const child = spawn(process.execPath, ["--experimental-strip-types", script, libHref, path, cwd, started, marker], { stdio: "ignore" });
	t.after(() => {
		try {
			child.kill();
		} catch {
			/* already gone */
		}
	});
	const closed = new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	await waitForFileContents(started, "", "the child never started its acquisition");

	// The barrier: the parked writer end means the child is blocked observing the mutex, so its
	// first verdict has already run (the token path was free and no codegraph.lock existed —
	// the verdict read both before parking). The external CodeGraph writer starts NOW, with the
	// child proven inside contention; removing the fifo then releases the mutex explicitly, so
	// the section the child finally enters re-reads the path with the writer already there —
	// only the in-section recheck stands between the publish and the writer.
	const parkedMutex = await parkFifo(mutex);
	writeFileSync(join(cwd, ".codegraph", "codegraph.lock"), String(process.pid));
	rmSync(mutex, { force: true });
	closeSync(parkedMutex);
	await waitForFileContents(marker, "lost", "the child never reported its acquisition result");
	assert.equal(existsSync(path), false, "no lease is published beside the external writer that appeared while waiting");

	// With the writer gone, the free path still acquires.
	rmSync(join(cwd, ".codegraph", "codegraph.lock"), { force: true });
	rmSync(mutex, { force: true }); // none expected: the child's section removed its own mutex
	const lease = tryAcquireLease(path, "sync", 120_000, Date.now(), cwd);
	assert.ok(lease, "with the writer gone, the free path still acquires");
	lease.release();
	assert.equal(readLeaseVerdict(path, Date.now()), "free");
	assert.equal(await closed, 0);
});
