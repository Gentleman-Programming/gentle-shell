import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
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

test("lease verdicts: free, held-live, held-stale by expiry, held-stale by dead pid, unknown on damage", (t) => {
	const dir = locksDir(t);
	const path = join(dir, "token.json");
	const now = Date.now();

	assert.equal(readLeaseVerdict(path, now), "free", "no file means free");

	writeToken(path, liveToken(now));
	assert.equal(readLeaseVerdict(path, now), "held-live", "live pid inside its TTL");

	writeToken(path, { kind: "init", pid: process.pid, startedAt: now - 120_000, expiresAt: now - 1, host: localHost() });
	assert.equal(readLeaseVerdict(path, now), "held-stale", "expired token is stealable");

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

	// The TTL is the displacement bound: the first holder's lease expires while it lives, and a
	// second session reclaims the path. The first holder may resume and publish or remove state —
	// but only on its own acquisition's token, never on the newer owner's.
	const first = tryAcquireLease(path, "sync", 1, now);
	assert.ok(first, "a free path acquires");
	const second = tryAcquireLease(path, "sync", 120_000, now + 2);
	assert.ok(second, "the expired local token is reclaimed even while its first holder lives");
	const before = readFileSync(path, "utf8");

	first.adopt(4242, false);
	assert.equal(readFileSync(path, "utf8"), before, "a displaced holder's adoption rewrites nothing on the newer owner's token");
	first.release();
	assert.equal(readFileSync(path, "utf8"), before, "its late release removes nothing either");

	second.release();
	assert.equal(readLeaseVerdict(path, now + 2), "free");
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
	const readyDeadline = Date.now() + 10_000;
	while (!existsSync(ready)) {
		if (Date.now() >= readyDeadline) assert.fail("the child never acquired the lease");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(readFileSync(ready, "utf8"), "acquired", "the child starts as the path's owner");

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
	const deadline = Date.now() + 10_000;
	while (!existsSync(marker)) {
		if (Date.now() >= deadline) assert.fail("the child never finished its adoption");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(readFileSync(marker, "utf8"), "adopted", "the adoption ran to its end");
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

	writeToken(boundary, { kind: "init", pid: process.pid, startedAt: now, expiresAt: now, host: localHost() });
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
	const deadline = Date.now() + 10_000;
	while (!existsSync(marker)) {
		if (Date.now() >= deadline) assert.fail("the child never reported its acquisition result");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(readFileSync(marker, "utf8"), "lost", "the displaced reclaimer must not acquire a second lease");
	assert.equal(readFileSync(path, "utf8"), replacementTokenBytes, "the newer owner's stale-looking token survives byte-for-byte: the fence, not the verdict, saved it");
	assert.equal(readFileSync(replacementMutex, "utf8"), replacementMutexBytes, "the replacement owner's mutex is never removed by the displaced section's exit");
	writeFileSync(done, "");
	assert.equal(await closed, 0);
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".stale")), [], "no temp or stale-steal litter is left behind");
});
