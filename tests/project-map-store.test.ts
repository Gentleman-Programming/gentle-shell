import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	advanceProjectMapStore,
	initializeProjectMapStore,
	readProjectMapStoreDescriptor,
} from "../lib/project-map-store.ts";
import * as projectMapStore from "../lib/project-map-store.ts";
import { canonicalJsonV1, domainHashV1 } from "../lib/review-canonical.ts";
import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES, type ProjectMapStoreDescriptorV1 } from "../lib/project-map-store-schema.ts";

const REPOSITORY_ID = `sha256:${"a".repeat(64)}`;
const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_EPOCH = "123e4567-e89b-12d3-a456-426614174001";
const CREATED_AT = "2026-09-24T12:00:00Z";
const UPDATED_AT = "2026-09-24T12:01:00Z";

function digest(bytes: string): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function withRoot(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "project-map-store-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

async function withAsyncRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "project-map-store-"));
	try {
		await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

interface StoreLockOwner {
	token: string;
	pid: number;
	owner_hash: string;
	acquired_at: string;
}

function createStoreLockOwner(token: string, pid: number, acquiredAt: string): StoreLockOwner {
	return {
		token,
		pid,
		owner_hash: domainHashV1("project-map-store-lock-owner", { token, pid, acquired_at: acquiredAt }),
		acquired_at: acquiredAt,
	};
}

function writeStoreLockOwner(root: string, owner: StoreLockOwner): string {
	const lockPath = join(root, "store.lock");
	mkdirSync(lockPath, { recursive: true, mode: 0o700 });
	const bytes = canonicalJsonV1(owner);
	writeFileSync(join(lockPath, "owner.json"), bytes, { mode: 0o600 });
	return bytes;
}

function runStoreChild(source: string, args: string[]): ReturnType<typeof spawn> {
	return spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source, ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk; });
		child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk; });
		child.once("error", reject);
		child.once("exit", (code) => resolve({ stdout, stderr, code }));
	});
}

function initialize(root: string): ProjectMapStoreDescriptorV1 {
	const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: CREATED_AT });
	assert.deepEqual(result.diagnostics, []);
	assert.ok(result.descriptor);
	return result.descriptor;
}

function advance(root: string, descriptor: ProjectMapStoreDescriptorV1, now = UPDATED_AT): ReturnType<typeof advanceProjectMapStore> {
	const bytes = readFileSync(join(root, "store.json"), "utf8");
	return advanceProjectMapStore({
		root,
		expected: { generation: descriptor.generation, epoch: descriptor.epoch, predecessor: digest(bytes) },
		now,
	});
}

test("initializes then reads a descriptor round trip", () => {
	withRoot((root) => {
		const descriptor = initialize(root);
		assert.equal(descriptor.generation, 0);
		assert.equal(descriptor.predecessor, null);
		assert.equal(descriptor.created_at, CREATED_AT);
		assert.equal(descriptor.updated_at, CREATED_AT);

		const read = readProjectMapStoreDescriptor(root);
		assert.equal(read.status, "ready");
		assert.deepEqual(read.diagnostics, []);
		assert.deepEqual(read.descriptor, descriptor);
	});
});

test("classifies missing, unreadable, and corrupted descriptors without throwing", () => {
	withRoot((root) => {
		assert.equal(readProjectMapStoreDescriptor(root).status, "missing");
		writeFileSync(join(root, "store.json"), "{ not json", "utf8");
		const corrupted = readProjectMapStoreDescriptor(root);
		assert.equal(corrupted.status, "corrupted");
		assert.ok(corrupted.diagnostics.some((diagnostic) => diagnostic.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED));
		rmSync(join(root, "store.json"));
		mkdirSync(join(root, "store.json"));
		assert.equal(readProjectMapStoreDescriptor(root).status, "unreadable");
	});
});

test("refuses every non-ready descriptor status with a diagnostic", () => {
	withRoot((root) => {
		const cases: Array<{ status: "missing" | "unreadable" | "corrupted"; code: string; prepare: () => void }> = [
			{ status: "missing", code: PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STALE_GENERATION, prepare: () => {} },
			{ status: "corrupted", code: PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, prepare: () => writeFileSync(join(root, "store.json"), "{ not json", "utf8") },
			{ status: "unreadable", code: PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, prepare: () => mkdirSync(join(root, "store.json")) },
		];
		for (const entry of cases) {
			entry.prepare();
			const result = advanceProjectMapStore({
				root,
				expected: { generation: 0, epoch: EPOCH, predecessor: `sha256:${"b".repeat(64)}` },
				now: UPDATED_AT,
			});
			assert.equal(readProjectMapStoreDescriptor(root).status, entry.status);
			assert.ok(result.diagnostics.length > 0);
			assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === entry.code));
			if (entry.status !== "missing") rmSync(join(root, "store.json"), { recursive: true });
		}
	});
});

test("refuses initialization when a descriptor already exists", () => {
	withRoot((root) => {
		initialize(root);
		const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: UPDATED_AT });
		assert.equal(result.descriptor, null);
		assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_EXISTS]);
	});
});

test("writes exactly the successor descriptor and no caller fields", () => {
	withRoot((root) => {
		const initial = initialize(root);
		const before = readFileSync(join(root, "store.json"), "utf8");
		const result = advance(root, initial);
		const successor = {
			schema: "gentle-shell.project-map-store/v1",
			kind: "descriptor",
			repository_id: REPOSITORY_ID,
			generation: 1,
			epoch: EPOCH,
			predecessor: digest(before),
			created_at: CREATED_AT,
			updated_at: UPDATED_AT,
		};
		assert.deepEqual(result.diagnostics, []);
		assert.deepEqual(result.descriptor, successor);
		const serialized = JSON.parse(readFileSync(join(root, "store.json"), "utf8"));
		assert.deepEqual(serialized, successor);
		assert.deepEqual(Object.keys(serialized), ["schema", "kind", "repository_id", "generation", "epoch", "predecessor", "created_at", "updated_at"]);
	});
});

test("refuses a stale generation without changing descriptor bytes", () => {
	withRoot((root) => {
		const initial = initialize(root);
		const advanced = advance(root, initial);
		assert.ok(advanced.descriptor);
		const before = readFileSync(join(root, "store.json"), "utf8");
		const stale = advance(root, initial, "2026-09-24T12:02:00Z");
		assert.equal(stale.descriptor, null);
		assert.deepEqual(stale.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STALE_GENERATION]);
		assert.equal(readFileSync(join(root, "store.json"), "utf8"), before);
	});
});

test("refuses an epoch change even with a matching generation", () => {
	withRoot((root) => {
		const initial = initialize(root);
		const before = readFileSync(join(root, "store.json"), "utf8");
		const result = advanceProjectMapStore({
			root,
			expected: { generation: initial.generation, epoch: OTHER_EPOCH, predecessor: digest(before) },
			now: UPDATED_AT,
		});
		assert.equal(result.descriptor, null);
		assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STALE_GENERATION]);
		assert.equal(readFileSync(join(root, "store.json"), "utf8"), before);
	});
});

test("refuses a mismatched predecessor digest even with a matching generation and epoch", () => {
	withRoot((root) => {
		const initial = initialize(root);
		const before = readFileSync(join(root, "store.json"), "utf8");
		const result = advanceProjectMapStore({
			root,
			expected: { generation: initial.generation, epoch: initial.epoch, predecessor: `sha256:${"b".repeat(64)}` },
			now: UPDATED_AT,
		});
		assert.equal(result.descriptor, null);
		assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STALE_GENERATION]);
		assert.equal(readFileSync(join(root, "store.json"), "utf8"), before);
	});
});

test("uses the injected clock for each successor updated_at", () => {
	withRoot((root) => {
		const result = advance(root, initialize(root), "2026-09-24T23:59:59Z");
		assert.equal(result.descriptor?.updated_at, "2026-09-24T23:59:59Z");
	});
});

test("archives and prunes nothing when a mutation is refused", () => {
	withRoot((root) => {
		let descriptor = initialize(root);
		for (let generation = 1; generation <= 20; generation += 1) {
			const result = advance(root, descriptor, `2026-09-24T12:${String(generation).padStart(2, "0")}:00Z`);
			assert.ok(result.descriptor);
			descriptor = result.descriptor;
		}
		// Pins the reachable half of the refused-mutation contract. The archive-then-swap failure is
		// unreachable through inputs (the PM4-2c lock shares the store root's write permission, and
		// an invalid instant is refused before the archive), so what is pinned here is that a
		// refused mutation archives nothing, prunes nothing and leaves the store where it was.
		const before = readdirSync(join(root, "history")).sort();
		const refused = advanceProjectMapStore({
			root,
			expected: { generation: 0, epoch: EPOCH, predecessor: digest("stale") },
			now: "2026-09-24T23:59:59Z",
		});
		assert.equal(refused.descriptor, null);
		assert.deepEqual(refused.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STALE_GENERATION]);
		assert.deepEqual(readdirSync(join(root, "history")).sort(), before);
		assert.equal(readProjectMapStoreDescriptor(root).descriptor?.generation, 20);
	});
});

test("refuses an invalid instant before the lock and stays usable afterwards", () => {
	withRoot((root) => {
		const descriptor = initialize(root);
		const before = readFileSync(join(root, "store.json"), "utf8");
		const invalid = advance(root, descriptor, "not-an-instant");
		assert.equal(invalid.descriptor, null);
		assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD && diagnostic.path === "$.now"));
		assert.equal(existsSync(join(root, "store.lock")), false);
		assert.equal(readFileSync(join(root, "store.json"), "utf8"), before);
		const initialized = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: "not-an-instant" });
		assert.equal(initialized.descriptor, null);
		assert.equal(existsSync(join(root, "store.lock")), false);
		const recovered = advance(root, descriptor, UPDATED_AT);
		assert.ok(recovered.descriptor);
		assert.equal(recovered.descriptor?.generation, 1);
	});
});

test("classifies a valid non-canonical descriptor as corrupted and refuses advancement", () => {
	withRoot((root) => {
		const descriptor = initialize(root);
		writeFileSync(join(root, "store.json"), JSON.stringify(descriptor), "utf8");
		const read = readProjectMapStoreDescriptor(root);
		assert.equal(read.status, "corrupted");
		assert.deepEqual(read.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED]);
		const advanced = advance(root, descriptor);
		assert.equal(advanced.descriptor, null);
		assert.deepEqual(advanced.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED]);
	});
});

test("proves a fresh store root is empty", () => {
	withRoot((root) => {
		const result = projectMapStore.storeIsProvablyEmpty(root);
		assert.deepEqual(result, { empty: true, diagnostics: [] });
	});
});

test("finds claim, heartbeat, and quarantine evidence in a store root", () => {
	withRoot((root) => {
		const claims = join(root, "claims");
		mkdirSync(claims);
		writeFileSync(join(claims, "capability.json"), "{}", "utf8");
		assert.equal(projectMapStore.storeIsProvablyEmpty(root).empty, false);
		rmSync(claims, { recursive: true });

		const heartbeats = join(root, "heartbeats");
		mkdirSync(heartbeats);
		writeFileSync(join(heartbeats, "session.json"), "{}", "utf8");
		assert.equal(projectMapStore.storeIsProvablyEmpty(root).empty, false);
		rmSync(heartbeats, { recursive: true });

		writeFileSync(join(root, "store.corrupt.2026-09-24T12-00-00-000Z.json"), "evidence", "utf8");
		assert.equal(projectMapStore.storeIsProvablyEmpty(root).empty, false);
	});
});

test("does not prove a store holding session, blocker, contract, receipt, and worktree records empty", () => {
	withRoot((root) => {
		for (const directory of ["sessions", "blockers", "contracts", "receipts", "worktrees"]) {
			mkdirSync(join(root, directory));
			writeFileSync(join(root, directory, "record.json"), "evidence", "utf8");
		}
		const empty = projectMapStore.storeIsProvablyEmpty(root);
		assert.equal(empty.empty, false);
		const initialization = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: CREATED_AT });
		assert.equal(initialization.descriptor, null);
		assert.deepEqual(initialization.diagnostics.map((entry) => entry.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_NOT_EMPTY]);
		assert.match(initialization.diagnostics[0].message, /1 entry under sessions\//);
		assert.match(initialization.diagnostics[0].message, /1 entry under blockers\//);
		assert.match(initialization.diagnostics[0].message, /1 entry under contracts\//);
		assert.match(initialization.diagnostics[0].message, /1 entry under receipts\//);
		assert.match(initialization.diagnostics[0].message, /1 entry under worktrees\//);
	});
});

test("does not prove a store holding a worktree record alone empty", () => {
	withRoot((root) => {
		const directory = join(root, "worktrees");
		mkdirSync(directory);
		writeFileSync(join(directory, "record.json"), "evidence", "utf8");
		assert.equal(projectMapStore.storeIsProvablyEmpty(root).empty, false);
		const initialization = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: CREATED_AT });
		assert.equal(initialization.descriptor, null);
		assert.deepEqual(initialization.diagnostics.map((entry) => entry.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_NOT_EMPTY]);
		assert.match(initialization.diagnostics[0].message, /1 entry under worktrees\//);
	});
});

test("refuses to initialize over contract evidence alone", () => {
	withRoot((root) => {
		// Only contract evidence, so the emptiness decision itself is what is under test: a proof
		// that kept contracts in the diagnostic accounting but ignored them in the decision would
		// still pass the combined test above.
		const directory = join(root, "contracts", "digest-directory");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "record.json"), "evidence", "utf8");
		assert.equal(projectMapStore.storeIsProvablyEmpty(root).empty, false);
		const initialization = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: CREATED_AT });
		assert.equal(initialization.descriptor, null);
		assert.deepEqual(initialization.diagnostics.map((entry) => entry.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_NOT_EMPTY]);
		assert.match(initialization.diagnostics[0].message, /1 entry under contracts\//);
		assert.equal(existsSync(join(directory, "record.json")), true);
	});
});

test("fails closed when a record directory cannot be read", () => {
	withRoot((root) => {
		writeFileSync(join(root, "claims"), "not a directory", "utf8");
		const result = projectMapStore.storeIsProvablyEmpty(root);
		assert.equal(result.empty, false);
		assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
	});
});

test("refuses initialization over claim evidence without changing the root", () => {
	withRoot((root) => {
		const claims = join(root, "claims");
		mkdirSync(claims);
		const claim = join(claims, "capability.json");
		writeFileSync(claim, "evidence", "utf8");
		const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: CREATED_AT });
		assert.equal(result.descriptor, null);
		assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_NOT_EMPTY]);
		assert.equal(readFileSync(claim, "utf8"), "evidence");
		assert.deepEqual(readdirSync(root).sort(), ["claims", "locks-quarantine"]);
	});
});

test("quarantines byte-identical evidence without overwriting an existing destination", () => {
	withRoot((root) => {
		const source = join(root, "store.json");
		const bytes = "{ invalid evidence\n";
		const now = "2026-09-24T12:00:00.000Z";
		const destination = join(root, "store.corrupt.2026-09-24T12-00-00-000Z.json");
		writeFileSync(source, bytes, "utf8");
		const quarantined = projectMapStore.quarantineProjectMapStore({ root, now });
		assert.equal(quarantined.quarantined, destination);
		assert.deepEqual(quarantined.diagnostics, []);
		assert.equal(existsSync(source), false);
		assert.equal(readFileSync(destination, "utf8"), bytes);
		const second = projectMapStore.quarantineProjectMapStore({ root, now });
		assert.equal(second.quarantined, null);
		assert.deepEqual(second.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.QUARANTINE_EXISTS]);
		assert.equal(readFileSync(destination, "utf8"), bytes);
	});
});

test("requires removal of quarantined evidence before initialization", () => {
	withRoot((root) => {
		const now = "2026-09-24T12:00:00.000Z";
		const source = join(root, "store.json");
		writeFileSync(source, "{ invalid evidence\n", "utf8");
		const quarantined = projectMapStore.quarantineProjectMapStore({ root, now });
		assert.ok(quarantined.quarantined);
		const blocked = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: CREATED_AT });
		assert.equal(blocked.descriptor, null);
		assert.deepEqual(blocked.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_NOT_EMPTY]);
		assert.match(blocked.diagnostics[0].message, /store\.corrupt\.2026-09-24T12-00-00-000Z\.json/);
		rmSync(quarantined.quarantined!);
		assert.ok(initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: CREATED_AT }).descriptor);
	});
});

test("refuses quarantine for a missing descriptor or invalid instant without moving evidence", () => {
	withRoot((root) => {
		const missing = projectMapStore.quarantineProjectMapStore({ root, now: CREATED_AT });
		assert.equal(missing.quarantined, null);
		assert.deepEqual(missing.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);

		const source = join(root, "store.json");
		writeFileSync(source, "evidence", "utf8");
		const invalid = projectMapStore.quarantineProjectMapStore({ root, now: "not-an-instant" });
		assert.equal(invalid.quarantined, null);
		assert.deepEqual(invalid.diagnostics.map((diagnostic) => diagnostic.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
		assert.equal(invalid.diagnostics[0].path, "$.now");
		assert.equal(readFileSync(source, "utf8"), "evidence");
	});
});

test("exports the fixed project-map store lock stale threshold", () => {
	assert.equal((projectMapStore as Record<string, unknown>).PROJECT_MAP_STORE_LOCK_STALE_MS, 30_000);
});

test("refuses a live cross-process lock holder without changing store bytes", async () => {
	await withAsyncRoot(async (root) => {
		const descriptor = initialize(root);
		const before = readFileSync(join(root, "store.json"), "utf8");
		const expected = { generation: descriptor.generation, epoch: descriptor.epoch, predecessor: digest(before) };
		const holder = runStoreChild(`
			import { mkdirSync, writeFileSync } from "node:fs";
			import { join } from "node:path";
			import { canonicalJsonV1, domainHashV1 } from "./lib/review-canonical.ts";
			const [root, acquiredAt] = process.argv.slice(-2);
			const token = "${"a".repeat(64)}";
			const owner = { token, pid: process.pid, acquired_at: acquiredAt };
			owner.owner_hash = domainHashV1("project-map-store-lock-owner", owner);
			mkdirSync(join(root, "store.lock"), { mode: 0o700 });
			writeFileSync(join(root, "store.lock", "owner.json"), canonicalJsonV1(owner), { mode: 0o600, flag: "wx" });
			console.log("held");
			setInterval(() => {}, 1_000);
		`, [root, UPDATED_AT]);
		try {
			await new Promise<void>((resolve, reject) => {
				let output = "";
				holder.stdout!.on("data", (chunk: Buffer) => {
					output += chunk;
					if (output.includes("held\n")) resolve();
				});
				holder.once("error", reject);
				holder.once("exit", (code) => reject(new Error(`holder exited before acquiring lock: ${code}`)));
			});
			const result = advanceProjectMapStore({ root, expected, now: UPDATED_AT });
			assert.equal(result.descriptor, null);
			assert.ok(result.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_LOCKED));
			assert.equal(readFileSync(join(root, "store.json"), "utf8"), before);
		} finally {
			holder.kill();
			await waitForChildExit(holder);
		}
	});
});

test("allows exactly one concurrent writer with the same frozen expectation", async () => {
	await withAsyncRoot(async (root) => {
		const descriptor = initialize(root);
		const expected = { generation: descriptor.generation, epoch: descriptor.epoch, predecessor: digest(readFileSync(join(root, "store.json"), "utf8")) };
		const writer = `
			import { advanceProjectMapStore } from "./lib/project-map-store.ts";
			const [root, expectedText, now] = process.argv.slice(-3);
			const result = advanceProjectMapStore({ root, expected: JSON.parse(expectedText), now });
			console.log(JSON.stringify({ descriptor: result.descriptor !== null, codes: result.diagnostics.map((entry) => entry.code) }));
		`;
		const args = [root, JSON.stringify(expected), UPDATED_AT];
		const [first, second] = await Promise.all([
			waitForChildExit(runStoreChild(writer, args)),
			waitForChildExit(runStoreChild(writer, args)),
		]);
		assert.equal(first.code, 0, first.stderr);
		assert.equal(second.code, 0, second.stderr);
		const results = [first, second].map((entry) => JSON.parse(entry.stdout) as { descriptor: boolean; codes: string[] });
		assert.equal(results.filter((entry) => entry.descriptor).length, 1);
		assert.ok(results.find((entry) => !entry.descriptor)?.codes.some((code) => code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_LOCKED || code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STALE_GENERATION));
		assert.equal(readProjectMapStoreDescriptor(root).descriptor?.generation, 1);
	});
});

test("breaks only a stale lock with a provably dead owner and preserves its bytes", async () => {
	await withAsyncRoot(async (root) => {
		const exited = runStoreChild("process.exit(0);", []);
		await waitForChildExit(exited);
		const acquiredAt = "2026-09-24T12:00:00Z";
		const owner = createStoreLockOwner("b".repeat(64), exited.pid!, acquiredAt);
		const ownerBytes = writeStoreLockOwner(root, owner);
		const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: "2026-09-24T12:00:30Z" });
		assert.ok(result.descriptor);
		assert.equal(readFileSync(join(root, "locks-quarantine", `stale-${owner.owner_hash}-${owner.token}`, "owner.json"), "utf8"), ownerBytes);
	});
});

test("does not break a fresh dead lock or an old lock owned by this process", async () => {
	await withAsyncRoot(async (root) => {
		const exited = runStoreChild("process.exit(0);", []);
		await waitForChildExit(exited);
		writeStoreLockOwner(root, createStoreLockOwner("c".repeat(64), exited.pid!, UPDATED_AT));
		const fresh = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: UPDATED_AT });
		assert.equal(fresh.descriptor, null);
		assert.ok(fresh.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_LOCKED));
		rmSync(join(root, "store.lock"), { recursive: true, force: true });
		writeStoreLockOwner(root, createStoreLockOwner("d".repeat(64), process.pid, CREATED_AT));
		const own = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: "2026-09-24T12:01:00Z" });
		assert.equal(own.descriptor, null);
		assert.ok(own.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_LOCKED));
	});
});

test("refuses malformed lock ownership without touching the lock directory", () => {
	withRoot((root) => {
		const lock = join(root, "store.lock");
		mkdirSync(lock, { mode: 0o700 });
		const owner = join(lock, "owner.json");
		writeFileSync(owner, "{ invalid", "utf8");
		const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: CREATED_AT });
		assert.equal(result.descriptor, null);
		assert.ok(result.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_LOCKED));
		assert.equal(readFileSync(owner, "utf8"), "{ invalid");
		assert.equal(existsSync(lock), true);
	});
});

test("successful mutations release the project-map store lock", () => {
	withRoot((root) => {
		const descriptor = initialize(root);
		assert.equal(existsSync(join(root, "store.lock")), false);
		const advanced = advance(root, descriptor);
		assert.ok(advanced.descriptor);
		assert.equal(existsSync(join(root, "store.lock")), false);
	});
});
