import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalRoot } from "./codegraph-canonical.ts";
import { processAlive } from "./codegraph-daemon.ts";

/** A cross-process exclusion token for one project: init (long-held) or sync (short lease). */
export type LeaseKind = "init" | "sync";

/** What the token file says: "unknown" is fail-closed — never stolen, never written past. */
export type LeaseVerdict = "free" | "held-live" | "held-stale" | "unknown";

export interface LeaseToken {
	kind: LeaseKind;
	pid: number;
	startedAt: number;
	expiresAt: number;
	/** This acquisition's unique identity: release removes only the token that still carries it. */
	nonce?: string;
	/** The holder's host and PID-namespace identity (boot id based): a pid is judged dead only on
	 * the machine that wrote the token; absent when the platform cannot derive one. */
	host?: string;
	/** The machine-stable part of the holder's identity (reboot-invariant): with the boot-scoped
	 * `host` it proves a same-machine token from an earlier boot — whose pids died with that boot —
	 * reclaimable once expired, instead of an unknown wedge after every reboot. Absent on legacy
	 * tokens and platforms without a derivable machine identity (those keep the legacy verdict). */
	machine?: string;
	/** The codegraph process this holder spawned, when observed: on win32 a shell wraps it. */
	writerPid?: number;
	/** The spawn was shelled (a cmd.exe wrapper): this pid is a proxy, not the real writer. */
	writerProxy?: boolean;
	writerPidAt?: number;
}

/** Locks live next to CodeGraph's own daemon registry, keyed per project and kind. */
export function defaultLocksDir(): string {
	return join(homedir(), ".codegraph", "locks");
}

/** One real project path in any spelling maps to one lock per kind: two sessions, one token. */
export function lockPathFor(cwd: string, kind: LeaseKind, locksDir: string = defaultLocksDir()): string {
	const digest = createHash("sha256").update(canonicalRoot(cwd)).digest("hex").slice(0, 32);
	return join(locksDir, `${digest}.${kind}.json`);
}

/** CodeGraph's own writer lock, any launcher's: a live pid in `.codegraph/codegraph.lock` means an index write is in progress right now. */
export function codegraphWritingIndex(cwd: string): boolean {
	try {
		const pid = Number.parseInt(readFileSync(join(cwd, ".codegraph", "codegraph.lock"), "utf8").trim(), 10);
		return Number.isInteger(pid) && pid > 0 && processAlive(pid);
	} catch {
		return false;
	}
}

const BOOT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
let cachedHostIdentity: string | null | undefined;

/**
 * This kernel's identity for lease-holder pids: the darwin boot session uuid, or the linux boot
 * id plus this process's PID namespace. Mirrors the private localHost() derivation in
 * lib/review-candidate-view-owner.ts (kept private there; re-exporting it would widen that
 * module's surface). Null means this platform cannot prove where a pid lives.
 */
export function leaseHostIdentity(): string | null {
	if (cachedHostIdentity === undefined) cachedHostIdentity = deriveHostIdentity();
	return cachedHostIdentity;
}

function deriveHostIdentity(): string | null {
	try {
		if (process.platform === "darwin") {
			const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 1000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] }).trim();
			if (BOOT_ID.test(boot)) return `darwin:${boot.toLowerCase()}`;
		}
		if (process.platform === "linux") {
			const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const namespace = readlinkSync("/proc/self/ns/pid");
			if (BOOT_ID.test(boot) && /^pid:\[\d+\]$/.test(namespace)) return `linux:${boot}:${namespace}`;
		}
	} catch {
		/* no pid-only fallback: an unverifiable host never gets dead verdicts */
	}
	return null;
}

/**
 * The boot-scoped half of a holder identity — darwin:<boot> / linux:<boot> without the PID
 * namespace: two containers of one boot share it while differing in namespace, so only a change
 * of this half proves the token's pids died with an earlier boot. Null when the string is not a
 * host identity this module could have written.
 */
function bootScopeOf(host: string): string | null {
	const match = /^((?:darwin|linux):[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?::pid:\[\d+\])?$/i.exec(host);
	return match === null ? null : match[1].toLowerCase();
}

let cachedMachineIdentity: string | null | undefined;

/**
 * This machine's reboot-invariant identity: the darwin IOPlatformUUID, or the linux
 * /etc/machine-id. It complements the boot-scoped leaseHostIdentity: a token whose machine part
 * matches but whose boot part differs was written before this machine's last reboot, so every
 * pid it records died with that boot (pids do not survive a reboot) — reclaimable once expired
 * instead of wedging as unknown until manual cleanup. Null means this platform cannot derive
 * one, and cross-boot recovery stays fail-closed exactly as before. Adding the derived value to
 * new tokens is the deliberate migration: legacy tokens without it keep the legacy verdict.
 */
export function leaseMachineIdentity(): string | null {
	if (cachedMachineIdentity === undefined) cachedMachineIdentity = deriveMachineIdentity();
	return cachedMachineIdentity;
}

function deriveMachineIdentity(): string | null {
	try {
		if (process.platform === "darwin") {
			const registry = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 1000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"] });
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
		/* no fallback: an unverifiable machine never gets cross-boot verdicts */
	}
	return null;
}

/**
 * Reads a token file and judges it. An expired token or a dead holder is stale (stealable) — but
 * only on the host that can prove the holder's pid local (see leaseHostIdentity); anywhere else
 * the verdict is unknown. A damaged or unreadable file is unknown too, and unknown is fail-closed:
 * no session may init or sync past it, because it cannot tell whether a live writer is behind the
 * damage. With `cwd` given, CodeGraph's own writer lock is consulted first — before any missing-
 * token return, so a live external writer never coexists with a newly granted lease — and a
 * freshly reported proxy writer pid holds for its trust window; both overrides flip a stale-looking
 * token back to held-live, because a live writer is never unlocked under. Expiry is the hard
 * displacement bound: an expired token is reclaimed even while its local holder's pid still lives
 * (a wedged holder must not keep the lease forever); the displaced holder's own state changes stay
 * nonce-fenced in release() and adopt(). A token from an earlier boot of this machine (its
 * machine-stable identity matches, its boot-scoped identity does not) has no pid left to probe —
 * they died with that boot — so it expires into reclaimable stale instead of an unknown wedge;
 * a different machine, or a legacy token without the machine part, keeps the fail-closed unknown.
 */
export function readLeaseVerdict(path: string, now: number = Date.now(), cwd?: string): LeaseVerdict {
	// CodeGraph's own writer lock outranks everything, a missing launcher token included: a live
	// writer behind a stale-looking token — or behind no token at all — must never be unlocked
	// under, whatever a later pid or TTL check would say.
	if (cwd !== undefined && codegraphWritingIndex(cwd)) return "held-live";
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "unknown";
	}
	let token: LeaseToken;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed !== "object" || parsed === null ||
			typeof (parsed as LeaseToken).kind !== "string" ||
			typeof (parsed as LeaseToken).pid !== "number" ||
			typeof (parsed as LeaseToken).startedAt !== "number" ||
			typeof (parsed as LeaseToken).expiresAt !== "number" ||
			((parsed as LeaseToken).host !== undefined && typeof (parsed as LeaseToken).host !== "string") ||
			((parsed as LeaseToken).machine !== undefined && typeof (parsed as LeaseToken).machine !== "string")
		) {
			return "unknown";
		}
		token = parsed as LeaseToken;
	} catch {
		return "unknown";
	}
	// Reboot recovery: a token whose machine-stable identity matches this machine but whose
	// boot-scoped identity does not was written before this machine's last reboot — every pid it
	// records (holder, proxy, or adopted writer) died with that boot and cannot be probed alive
	// here, even where a coincidental live pid answers to the same number. Only a verified BOOT
	// change proves that: two containers of the same boot share the machine id and boot id and
	// differ only in PID namespace — their holders are live pids of this boot, so a namespace
	// mismatch alone is not a reboot and stays fail-closed below. Expired, a rebooted token
	// is reclaimable stale (the wedge is bounded by the TTL); unexpired it stays fail-closed
	// until its TTL bounds it; a different machine or a legacy token without the machine part
	// keeps the unknown verdict exactly as before.
	if (
		token.host !== undefined && token.machine !== undefined &&
		token.machine === leaseMachineIdentity() &&
		bootScopeOf(token.host) !== null && bootScopeOf(leaseHostIdentity() ?? "") !== null &&
		bootScopeOf(token.host) !== bootScopeOf(leaseHostIdentity() ?? "")
	) {
		return token.expiresAt <= now ? "held-stale" : "unknown";
	}
	// A proxy pid (a cmd.exe wrapper on win32) reported inside its trust window holds the same
	// way — the real writer is still starting behind it.
	if (token.writerProxy === true && token.writerPidAt !== undefined && now - token.writerPidAt < PROXY_TRUST_MS) return "held-live";
	// An adopted direct writer (a detached init child on POSIX) can outlive its dead launcher while
	// it has not written codegraph.lock yet: while that child lives, the token stays held — a live
	// writer is never unlocked under, whatever the TTL or the dead launcher's pid say.
	if (token.writerProxy !== true && typeof token.writerPid === "number" && token.writerPid > 0 && processAlive(token.writerPid)) return "held-live";
	// Holder pids are judged dead only on the host that wrote the token: with a shared locks dir
	// (homedir-based), a live holder in another host or container looks dead locally, and stealing
	// its lease would race its live writer. Without provable locality the verdict is unknown —
	// fail-closed, never stealable — with one carve-out: an identity-less token (written where the
	// platform cannot derive identity) still holds while its pid lives here, preserving legacy
	// liveness without ever granting a dead verdict it cannot prove.
	const host = leaseHostIdentity();
	const provablyLocal = token.host !== undefined ? token.host === host : host === null;
	if (token.expiresAt <= now) return provablyLocal ? "held-stale" : "unknown";
	if (!provablyLocal) return processAlive(token.pid) ? "held-live" : "unknown";
	return processAlive(token.pid) ? "held-live" : "held-stale";
}

/**
 * Exclusive, all-or-nothing publish: the only writer of a free or freshly cleared path wins. The
 * complete token — this host's identity included — is written to a temp file beside the path and
 * linked into place: link never replaces an existing owner's token (its EEXIST loses cleanly),
 * and a crash can leave at most temp litter beside a still-free path, never the empty or partial
 * token at the lease path whose verdict would be "unknown" forever (TTL expiry cannot restore a
 * damaged file).
 */
function writeTokenExclusively(path: string, kind: LeaseKind, ttlMs: number, now: number, nonce: string): boolean {
	const token: LeaseToken = { kind, pid: process.pid, startedAt: now, expiresAt: now + ttlMs, nonce, host: leaseHostIdentity() ?? undefined, machine: leaseMachineIdentity() ?? undefined };
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(token)}\n`);
		linkSync(temp, path);
		return true;
	} catch {
		return false; // EEXIST (someone else won) or unwritable: not ours either way
	} finally {
		rmSync(temp, { force: true }); // best effort: an unpublished temp is litter, never state
	}
}

/**
 * Records the spawned writer pid on this holder's token, best effort: only our own token is ever
 * touched — the holder pid AND this acquisition's nonce must still match, so a holder displaced
 * past its TTL (the TTL is the displacement bound) rewrites nothing on the newer owner's token,
 * and the publish itself is fenced on still owning the per-path mutex: an adopter stalled past
 * the mutex TTL between its checks and the rename never publishes over a newer owner's token.
 * The updated metadata is written whole to a temp file beside the token and renamed over
 * it inside the per-path mutex (the ownership protocol stale recovery and release already
 * serialize on): a process dying mid-write can leave only a complete token behind, never a
 * truncated one, because an "unknown" verdict is fail-closed forever and TTL expiry cannot
 * restore a damaged file.
 */
function adoptWriterPid(path: string, pid: number, proxy: boolean, now: number = Date.now(), nonce?: string): void {
	withPathMutex(path, ADOPT_MUTEX_WAIT_MS, (owns) => {
		try {
			const token = JSON.parse(readFileSync(path, "utf8")) as LeaseToken;
			if (token.pid !== process.pid) return undefined; // lost or stolen since: never touch another holder's token
			if (nonce !== undefined && token.nonce !== nonce) return undefined; // displaced: this acquisition no longer owns the path
			token.writerPid = pid;
			token.writerProxy = proxy;
			token.writerPidAt = now;
			const temp = `${path}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temp, `${JSON.stringify(token)}\n`);
				// The ownership fence every effectful section re-applies: an adopter stalled past the
				// mutex TTL between its nonce check and this publish must not rename its stale adoption
				// over whatever newer owner retook the path meanwhile.
				if (!owns()) return undefined;
				renameSync(temp, path); // same filesystem: the swap is atomic, the token is never half-written
			} finally {
				rmSync(temp, { force: true }); // best effort: an unrenamed temp is litter, never state
			}
		} catch {
			/* best effort: the trust window only narrows the stale window */
		}
		return undefined;
	});
}

export interface AcquiredLease {
	/** Best-effort: a released lease nobody cleans up still expires by TTL. */
	release(): void;
	/** Best-effort: records this holder's spawned writer onto the token, so a dead launcher's lease
	 * still holds while its detached child keeps writing the index. */
	adopt(pid: number, proxy: boolean): void;
}

/** The per-path mutex's own holder record: liveness rules mirror the lease tokens themselves. */
interface MutexToken {
	pid: number;
	startedAt: number;
	expiresAt: number;
	/** This holder's unique identity: release and stale recovery act only on the exact mutex that carries it. */
	nonce?: string;
}

/** The mutex is held for one synchronous handful of syscalls; the TTL bounds how long a holder
 * stalled inside its section can block the path before its mutex is stealable. */
const MUTEX_TTL_MS = 10_000;
/** Waiting for a live mutex holder is bounded: a wedged holder fail-closes the attempt instead. */
const MUTEX_WAIT_MS = 250;
/** Adoption waits out brief per-path mutex contention (observed under win32 load): the
 * spawned-writer record outlives a short stall, unlike a fast skip that loses it. */
const ADOPT_MUTEX_WAIT_MS = 2_000;
const MUTEX_POLL_MS = 5;

function mutexPathFor(path: string): string {
	return `${path}.mutex`;
}

/** Parses the mutex holder's record; anything unreadable or malformed is undefined. */
function parseMutex(mutex: string): MutexToken | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(mutex, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const token = parsed as MutexToken;
		if (typeof token.pid !== "number" || typeof token.startedAt !== "number" || typeof token.expiresAt !== "number") return undefined;
		return token;
	} catch {
		return undefined;
	}
}

/** A damaged mutex (a crash mid-write) is still respected while its bytes are younger than the TTL. */
function mutexFreshOnDisk(mutex: string, now: number): boolean {
	try {
		return statSync(mutex).mtimeMs > now - MUTEX_TTL_MS;
	} catch {
		return false; // gone: nothing blocks
	}
}

/** The only synchronous sleep: slices short enough that a contended mutex never stalls its caller long. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Exclusive create of the mutex file: the only writer of the mutex path wins it. Returns the
 * created mutex's nonce (its creator's proof of ownership), or false when the path is taken. */
function tryTakeMutex(mutex: string, now: number): string | false {
	const nonce = randomUUID();
	const token: MutexToken = { pid: process.pid, startedAt: now, expiresAt: now + MUTEX_TTL_MS, nonce };
	try {
		writeFileSync(mutex, `${JSON.stringify(token)}\n`, { flag: "wx" });
		return nonce;
	} catch {
		return false; // EEXIST (held) or unwritable: either way not ours
	}
}

/** A mutex file's identity: device, inode, and nanosecond mtime pin the exact file observed, and
 * the holder nonce (when the record parsed) binds its content. A mutex created after an
 * observation can never reproduce the observed identity — a fresh file carries a fresh nonce even
 * where the filesystem reuses the freed inode. */
interface MutexIdentity {
	dev: bigint;
	ino: bigint;
	mtimeNs: bigint;
	nonce?: string;
}

function mutexIdentity(file: string): MutexIdentity | undefined {
	try {
		const stat = statSync(file, { bigint: true });
		return { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs, nonce: parseMutex(file)?.nonce };
	} catch {
		return undefined;
	}
}

function sameMutexIdentity(a: MutexIdentity, b: MutexIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.nonce === b.nonce;
}

/**
 * Stale-mutex recovery that cannot delete a replacement owner's mutex: the removal is a rename
 * into a unique graveyard name, and the renamed file must still be the exact mutex the reclaimer
 * observed stale (identity and holder nonce both). When the rename instead grabs a newer mutex —
 * a replacement owner took the path after the observation — it is restored with a no-replace
 * link, and dropped only when a legitimate contender already retook the empty path mid-window;
 * a section left unguarded by that drop is fenced by the owns() check its caller re-applies
 * before every effectful step, so a newer owner's state is never removed twice.
 */
function stealStaleMutex(mutex: string, observed: MutexIdentity): void {
	const graveyard = `${mutex}.${randomUUID()}.stale`;
	try {
		renameSync(mutex, graveyard);
	} catch {
		return; // vanished between observation and steal: nothing was removed
	}
	const grabbed = mutexIdentity(graveyard);
	if (grabbed !== undefined && sameMutexIdentity(grabbed, observed)) {
		// Exactly the mutex judged stale: it is out of the path's way, and the exclusive-create
		// race decides who re-owns the path next.
		rmSync(graveyard, { force: true }); // best effort: the stolen record is litter once verified
		return;
	}
	try {
		linkSync(graveyard, mutex);
	} catch {
		/* the path was retaken while we held the grabbed file: it is superseded, drop it below */
	}
	rmSync(graveyard, { force: true }); // best effort: removes a restored file's extra name, or the superseded record
}

/**
 * Runs one critical section on a token path, serialized against every other session's stale
 * recovery and release. A live mutex holder is waited for (bounded — its section is a handful of
 * syscalls); a dead, expired, or damaged-past-TTL one is stolen under the same liveness rules as
 * the tokens themselves — but bound to the exact mutex observed stale, so recovery can never
 * delete a replacement owner's mutex. The section receives an owns() fence: after a mid-section
 * mutex replacement, every effectful step must re-verify ownership or abort. Returns undefined
 * when the wait budget is spent: fail-closed, the caller skips what it wanted to do.
 */
function withPathMutex<T>(path: string, waitMs: number, section: (owns: () => boolean) => T | undefined): T | undefined {
	const mutex = mutexPathFor(path);
	const deadline = Date.now() + waitMs;
	for (;;) {
		const now = Date.now();
		const mine = tryTakeMutex(mutex, now);
		if (mine !== false) {
			const owns = (): boolean => parseMutex(mutex)?.nonce === mine;
			try {
				return section(owns);
			} finally {
				// Release only the mutex this holder created: after a mid-section replacement the
				// path belongs to whoever retook it, and its mutex is never removed here.
				if (owns()) rmSync(mutex, { force: true }); // best effort: a leftover is stolen by TTL rules
			}
		}
		const holder = parseMutex(mutex);
		const blocking =
			(holder !== undefined && holder.expiresAt > now && processAlive(holder.pid)) ||
			(holder === undefined && mutexFreshOnDisk(mutex, now));
		if (blocking) {
			if (now >= deadline) return undefined;
			sleepSync(MUTEX_POLL_MS);
			continue;
		}
		// Vanished (the holder released between our create and read), or stale/damaged past its
		// TTL: steal only the exact mutex observed stale and race the exclusive create again —
		// bounded by the same wait budget, so a mutex that can never be created (an unwritable or
		// vanished locks dir) fail-closes the attempt instead of spinning past its deadline.
		if (now >= deadline) return undefined;
		const observed = mutexIdentity(mutex);
		if (observed !== undefined) stealStaleMutex(mutex, observed);
	}
}

/** This path's token nonce when the token is readable and carries one. */
function readNonce(path: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as LeaseToken).nonce;
	} catch {
		return undefined;
	}
}

/**
 * Creates the token exclusively and binds release to this acquisition's nonce. The read-back is
 * defense in depth against a doubly-stolen mutex: if the token at the path is not the one this
 * acquisition just wrote, a concurrent reclaimer raced past the serialization — yield the path
 * and remove nothing (the newer owner's token stays).
 */
function createLease(path: string, kind: LeaseKind, ttlMs: number, now: number): AcquiredLease | undefined {
	const nonce = randomUUID();
	if (!writeTokenExclusively(path, kind, ttlMs, now, nonce)) return undefined;
	if (readNonce(path) !== nonce) return undefined;
	return {
		release: () => releaseOwnToken(path, nonce),
		adopt: (pid: number, proxy: boolean) => adoptWriterPid(path, pid, proxy, Date.now(), nonce),
	};
}

/**
 * Release removes only the token this acquisition wrote: an expired lease whose path was stolen
 * and re-owned never removes the newer owner's token. The check and the remove run inside the
 * same per-path mutex as recovery, so a release racing a reclaimer cannot remove the token the
 * reclaimer just created either. Best effort: an unreachable mutex still leaves the TTL backstop.
 */
function releaseOwnToken(path: string, nonce: string): void {
	withPathMutex(path, MUTEX_WAIT_MS, () => {
		if (readNonce(path) === nonce) rmSync(path, { force: true });
		return undefined;
	});
}

/**
 * Acquires a free or stale path exclusively; a live or unknown holder, an unwritable locks dir,
 * or a lost steal race returns undefined — the caller then skips what it wanted to do. The stale
 * path's read/remove/create sequence runs inside the per-path mutex, so concurrent reclaimers
 * serialize and re-read the path inside the critical section: the first recovery's fresh token is
 * a live holder to every later reclaimer, never something to remove. The stale-token removal is
 * additionally fenced on still owning the mutex, so a section whose mutex was replaced mid-flight
 * removes nothing at all.
 */
export function tryAcquireLease(path: string, kind: LeaseKind, ttlMs: number, now: number = Date.now(), cwd?: string, mutexWaitMs: number = MUTEX_WAIT_MS): AcquiredLease | undefined {
	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch {
		return undefined; // fail-closed: no locks dir, no coordination, no write
	}
	const verdict = readLeaseVerdict(path, now, cwd);
	if (verdict !== "free" && verdict !== "held-stale") return undefined;
	if (verdict === "free") return createLease(path, kind, ttlMs, now); // exclusive create is atomic on its own
	// held-stale: the remove/create sequence needs serializing against every other reclaimer and
	// every release — the exclusive create alone does not protect it.
	return withPathMutex(path, mutexWaitMs, (owns): AcquiredLease | undefined => {
		const recheck = readLeaseVerdict(path, now, cwd);
		if (recheck !== "free" && recheck !== "held-stale") return undefined; // a faster reclaimer owns it now
		if (recheck === "held-stale") {
			if (!owns()) return undefined; // the mutex was replaced mid-section: never remove a newer owner's state
			try {
				rmSync(path, { force: true });
			} catch {
				return undefined; // cannot clear the stale token: do not write past it
			}
		}
		return createLease(path, kind, ttlMs, now);
	});
}

/**
 * The sync lease outlives daemonlessRefresh's whole sync sequence (readiness.ts): the command
 * runs up to SYNC_TIMEOUT_MS (120s) and may then spend KILL_WAIT_MS (10s) dying, so the real
 * worst case is 130s plus margin for retries. The constants are mirrored by value on purpose —
 * readiness value-imports this module, so importing them back would open a
 * readiness -> lease -> readiness cycle. The TTL is the hard displacement bound, not a
 * crash-only backstop: a holder suspended past it may be reclaimed while it still lives (a
 * wedged holder must not keep the lease forever), and the margins above keep that to the
 * suspension case it exists for. The displaced holder cannot corrupt the replacement either:
 * release() and adopt() are fenced on the acquisition's nonce, so they act only on this
 * acquisition's own token.
 */
const SYNC_LEASE_TTL_MS = 300_000;
/** A freshly reported proxy pid (a cmd.exe wrapper) is trusted this long once its holder is gone. */
const PROXY_TRUST_MS = 60_000;
/** The init lock outlives the longest init; like every lease TTL it is the hard displacement
 * bound — a holder stalled past it is reclaimed (with nonce-fenced state changes) rather than
 * wedging the project forever. */
const INIT_LOCK_TTL_MS = 600_000;
/** How long a second session waits for another session's init before giving up. */
const INIT_LOCK_WAIT_MS = 120_000;
const POLL_MS = 500;

/** One call for the daemon-less sync path: acquire the project's sync lease or skip. The returned
 * lease's adopt hook records the spawned sync child (readiness hands it to runCodegraph),
 * so a dead launcher's lease still holds while its detached child writes. */
export function tryAcquireSyncLease(cwd: string, locksDir?: string, ttlMs: number = SYNC_LEASE_TTL_MS): AcquiredLease | undefined {
	return tryAcquireLease(lockPathFor(cwd, "sync", locksDir ?? defaultLocksDir()), "sync", ttlMs, Date.now(), cwd);
}

/** One read for the daemon-less callers: "held-live" exactly when another session owns the refresh.
 * A damaged or unreadable token is nobody's refresh — it must never be reported as handled. */
export function syncLeaseHeldLive(cwd: string, locksDir?: string): boolean {
	try {
		return readLeaseVerdict(lockPathFor(cwd, "sync", locksDir ?? defaultLocksDir()), Date.now(), cwd) === "held-live";
	} catch {
		return false;
	}
}

export type InitLockOutcome =
	| { outcome: "acquired"; release(): void; adopt(pid: number, proxy: boolean): void }
	/** The other session's init finished while we waited: the database file exists. */
	| { outcome: "present" }
	/** Still held, or unknown, past the wait budget: fail-closed, this session inits nothing. */
	| { outcome: "skipped" };

/**
 * The index state per the repo's codegraph rules: an access error is unknown, NOT absent, and only a
 * confirmed-missing database file may be initialised. An index is the database file, never the directory.
 * The one tri-state every codegraph module keys on; readiness re-exports it for its importers.
 */
export type IndexState = "present" | "absent" | "unknown";

export function indexState(cwd: string): IndexState {
	try {
		return statSync(join(cwd, ".codegraph", "codegraph.db")).isFile() ? "present" : "absent";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
	}
}

/** True exactly for the tri-state's "present": the init wait ends when the database file is confirmed. */
function indexDatabasePresent(cwd: string): boolean {
	return indexState(cwd) === "present";
}

/**
 * The init lock: acquire it, or wait (bounded) for the other session's init to produce the
 * database file. A live holder that has not finished yet and an unknown verdict both end in
 * "skipped" — never a second concurrent init, never a steal of a live holder.
 */
export async function acquireInitLock(
	cwd: string,
	options: {
		locksDir?: string;
		ttlMs?: number;
		waitMs?: number;
		pollMs?: number;
		exists?(cwd: string): boolean;
		now?(): number;
		sleep?(ms: number): Promise<void>;
	} = {},
): Promise<InitLockOutcome> {
	const {
		locksDir,
		ttlMs = INIT_LOCK_TTL_MS,
		waitMs = INIT_LOCK_WAIT_MS,
		pollMs = POLL_MS,
		exists = indexDatabasePresent,
		now = Date.now,
		sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
	} = options;
	const path = lockPathFor(cwd, "init", locksDir ?? defaultLocksDir());
	const deadline = now() + waitMs;
	for (;;) {
		const verdict = readLeaseVerdict(path, now(), cwd);
		if (verdict === "free" || verdict === "held-stale") {
			const lease = tryAcquireLease(path, "init", ttlMs, now(), cwd);
			if (lease) return { outcome: "acquired", release: lease.release, adopt: lease.adopt };
			// The steal race was lost between verdict and create: keep waiting like a live holder.
		} else if (verdict === "held-live" && exists(cwd)) {
			return { outcome: "present" };
		}
		if (now() >= deadline) return { outcome: "skipped" };
		await sleep(pollMs);
	}
}
