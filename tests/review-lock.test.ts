import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJsonV1, domainHashV1 } from "../lib/review-canonical.ts";
import { conservativeOwnerDeathProofV1, qualifiedNodeFsLockPlatformV1, ReviewLockError, ReviewMutationLockV1, type ReviewLockPlatformAdapterV1 } from "../lib/review-lock.ts";

function temporaryRoot(): string {
	return mkdtempSync(join(tmpdir(), "drakonc-review-lock-"));
}

function qualifiedAdapter(ownerDead = true): ReviewLockPlatformAdapterV1 {
	return {
		name: "test-qualified",
		assertQualified() {},
		proveOwnerDead() { return ownerDead; },
		moveNoReplace(source, destination) {
			if (existsSync(destination)) throw new Error("destination exists");
			renameSync(source, destination);
		},
	};
}

test("exclusive lock acquisition requires its owner token to release", () => {
	const root = temporaryRoot();
	try {
		const lock = new ReviewMutationLockV1(root, "a".repeat(64), "b".repeat(64), qualifiedAdapter());
		const owner = lock.acquire();
		assert.throws(() => lock.acquire(), ReviewLockError);
		assert.throws(() => lock.release({ ...owner, token: "wrong" }), /owner token/i);
		lock.release(owner);
		lock.acquire();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("active and ambiguous lock ownership fail closed during recovery", () => {
	const root = temporaryRoot();
	try {
		const lock = new ReviewMutationLockV1(root, "a".repeat(64), "b".repeat(64), qualifiedAdapter(false));
		const owner = lock.acquire();
		assert.throws(() => lock.recover(owner.owner_hash), /active|ambiguous/i);
		assert.throws(() => lock.recover("c".repeat(64)), /owner hash/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("stale recovery moves only the observed owner into a persistent token-fenced quarantine", () => {
	const root = temporaryRoot();
	try {
		const lock = new ReviewMutationLockV1(root, "a".repeat(64), "b".repeat(64), qualifiedAdapter());
		const owner = lock.acquire();
		lock.recover(owner.owner_hash);
		assert.equal(existsSync(lock.path), false);
		assert.equal(existsSync(join(root, "locks", "quarantine", `stale-${owner.owner_hash}-${owner.token}`)), true);
		assert.throws(() => lock.recover(owner.owner_hash), /absent|race/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("production owner-death proof only accepts a conclusively absent process", () => {
	const owner = { token: "a".repeat(64), owner_hash: "b".repeat(64), pid: process.pid, repository_id: "c".repeat(64), authority_id: "d".repeat(64) };
	assert.equal(conservativeOwnerDeathProofV1(owner), false);
	assert.equal(conservativeOwnerDeathProofV1({ ...owner, pid: 999_999_999 }), true);
});

test("production lock uses atomic mkdir and releases only the observed owner", () => {
	const root = temporaryRoot();
	try {
		const lock = new ReviewMutationLockV1(root, "a".repeat(64), "b".repeat(64));
		const owner = lock.acquire();
		assert.equal(lock.inspect().status, "owned");
		assert.throws(() => lock.recover(owner.owner_hash), /active|ambiguous/i);
		lock.release(owner);
		assert.equal(lock.inspect().status, "absent");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function writeStaleOwner(lockPath: string, pid: number, token: string): { token: string; pid: number; repository_id: string; authority_id: string; owner_hash: string } {
	mkdirSync(lockPath, { recursive: true, mode: 0o700 });
	const unsigned = { token, pid, repository_id: "a".repeat(64), authority_id: "b".repeat(64) };
	const owner = { ...unsigned, owner_hash: domainHashV1("lock-owner", unsigned) };
	writeFileSync(join(lockPath, "owner.json"), canonicalJsonV1(owner), { mode: 0o600 });
	return owner;
}

test("stale lock recovery succeeds via the default production platform without an injected test adapter", () => {
	const root = temporaryRoot();
	try {
		const lock = new ReviewMutationLockV1(root, "a".repeat(64), "b".repeat(64));
		const owner = writeStaleOwner(lock.path, 999_999_999, "e".repeat(64));
		lock.recover(owner.owner_hash);
		assert.equal(existsSync(lock.path), false);
		assert.equal(existsSync(join(root, "locks", "quarantine", `stale-${owner.owner_hash}-${owner.token}`)), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("default production lock platform preserves no-replace semantics when the quarantine destination is already occupied", () => {
	const root = temporaryRoot();
	try {
		const lock = new ReviewMutationLockV1(root, "a".repeat(64), "b".repeat(64));
		const owner = writeStaleOwner(lock.path, 999_999_998, "f".repeat(64));
		const destination = join(root, "locks", "quarantine", `stale-${owner.owner_hash}-${owner.token}`);
		mkdirSync(destination, { recursive: true, mode: 0o700 });
		writeFileSync(join(destination, "sentinel.txt"), "pre-existing", { mode: 0o600 });
		assert.throws(() => lock.recover(owner.owner_hash), ReviewLockError);
		assert.equal(existsSync(join(destination, "sentinel.txt")), true);
		assert.equal(existsSync(lock.path), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function withStubbedPlatform(platform: NodeJS.Platform, run: () => void): void {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		run();
	} finally {
		if (descriptor) Object.defineProperty(process, "platform", descriptor);
	}
}

test("qualified production moveNoReplace never replaces an existing destination file on any platform", () => {
	for (const platform of [process.platform, "win32" as NodeJS.Platform]) {
		const root = temporaryRoot();
		try {
			const source = join(root, "source.json");
			const destination = join(root, "destination.json");
			writeFileSync(source, "candidate", { mode: 0o600 });
			writeFileSync(destination, "holder", { mode: 0o600 });
			withStubbedPlatform(platform, () => {
				assert.throws(() => qualifiedNodeFsLockPlatformV1().moveNoReplace(source, destination), ReviewLockError, `platform ${platform} must fail closed on an occupied destination file`);
			});
			assert.equal(readFileSync(destination, "utf8"), "holder", `platform ${platform} must not modify the occupied destination file`);
			assert.equal(existsSync(source), true, `platform ${platform} must keep the source after the refused move`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("qualified production moveNoReplace never replaces an existing destination directory on any platform", () => {
	for (const platform of [process.platform, "win32" as NodeJS.Platform]) {
		const root = temporaryRoot();
		try {
			const source = join(root, "source-lock");
			const destination = join(root, "destination-lock");
			mkdirSync(source, { mode: 0o700 });
			writeFileSync(join(source, "owner.json"), "candidate", { mode: 0o600 });
			mkdirSync(destination, { mode: 0o700 });
			writeFileSync(join(destination, "sentinel.txt"), "pre-existing", { mode: 0o600 });
			withStubbedPlatform(platform, () => {
				assert.throws(() => qualifiedNodeFsLockPlatformV1().moveNoReplace(source, destination), ReviewLockError, `platform ${platform} must fail closed on an occupied destination directory`);
			});
			assert.equal(readFileSync(join(destination, "sentinel.txt"), "utf8"), "pre-existing", `platform ${platform} must not modify the occupied destination directory`);
			assert.equal(existsSync(join(source, "owner.json")), true, `platform ${platform} must keep the source directory after the refused move`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("incomplete acquisition may be quarantined only with a dead durable intent", () => {
	const root = temporaryRoot();
	try {
		const lock = new ReviewMutationLockV1(root, "a".repeat(64), "b".repeat(64), qualifiedAdapter());
		const owner = lock.acquire();
		lock.release(owner);
		// Simulate a crash after the durable acquisition intent but before owner.json publication.
		mkdirSync(lock.path, { recursive: true, mode: 0o700 });
		assert.throws(() => lock.recoverIncomplete("missing"), /intent|ambiguous/i);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
