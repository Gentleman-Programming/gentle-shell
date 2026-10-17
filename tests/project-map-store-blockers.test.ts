import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeProjectMapStore } from "../lib/project-map-store.ts";
import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES, serializeProjectMapStoreValue, type ProjectMapStoreBlockerV1 } from "../lib/project-map-store-schema.ts";

const blockers = await import("../lib/project-map-store-blockers.ts").catch(() => ({})) as typeof import("../lib/project-map-store-blockers.ts");
const REPOSITORY_ID = `sha256:${"a".repeat(64)}`;
const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const NOW = "2026-09-24T12:00:00.000Z";
const LATER = "2026-09-24T12:01:00.000Z";

function blockerPath(root: string, capabilityId: string, blockerId: string): string {
	return join(root, "blockers", createHash("sha256").update(capabilityId).digest("hex"), `${createHash("sha256").update(blockerId).digest("hex")}.json`);
}

function withRoot(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "project-map-store-blockers-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function initialize(root: string): void {
	const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: NOW });
	assert.ok(result.descriptor, result.diagnostics.map((entry) => entry.message).join("\n"));
}

function codes(result: { diagnostics: { code: string }[] }): string[] {
	return result.diagnostics.map((entry) => entry.code);
}

function raise(root: string, blockerId: string, options: Partial<{ capabilityId: string; owner: string; reason: string; sessionId: string; now: string }> = {}) {
	return blockers.raiseProjectMapStoreBlocker({ root, capabilityId: options.capabilityId ?? "project-map", blockerId, owner: options.owner ?? "owner-a", reason: options.reason ?? "Needs review", sessionId: options.sessionId ?? "session-a", now: options.now ?? NOW });
}

test("raises two blockers for one capability and reads them back by id", () => {
	withRoot((root) => {
		initialize(root);
		const first = raise(root, "blocker-a");
		const second = raise(root, "blocker-b", { owner: "owner-b", reason: "Needs approval", sessionId: "session-b" });
		assert.deepEqual(first.diagnostics, []);
		assert.deepEqual(second.diagnostics, []);
		assert.deepEqual(blockers.readProjectMapStoreBlocker({ root, capabilityId: "project-map", blockerId: "blocker-a" }), { blocker: { schema: "gentle-shell.project-map-store/v1", kind: "blocker", capability_id: "project-map", blocker_id: "blocker-a", owner: "owner-a", reason: "Needs review", raised_by: "session-a", raised_at: NOW }, status: "open", diagnostics: [] });
		assert.equal(blockers.readProjectMapStoreBlocker({ root, capabilityId: "project-map", blockerId: "blocker-b" }).blocker?.owner, "owner-b");
	});
});

test("refuses a second raise without changing blocker bytes", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(raise(root, "blocker-a").blocker);
		const path = blockerPath(root, "project-map", "blocker-a");
		const before = readFileSync(path, "utf8");
		const refused = raise(root, "blocker-a", { owner: "owner-b" });
		assert.equal(refused.blocker, null);
		assert.deepEqual(codes(refused), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.BLOCKER_EXISTS]);
		assert.equal(readFileSync(path, "utf8"), before);
		assert.ok(blockers.resolveProjectMapStoreBlocker({ root, capabilityId: "project-map", blockerId: "blocker-a", resolution: "Approved", now: LATER }).blocker);
		const resolvedBytes = readFileSync(path, "utf8");
		assert.deepEqual(codes(raise(root, "blocker-a")), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.BLOCKER_EXISTS]);
		assert.equal(readFileSync(path, "utf8"), resolvedBytes);
	});
});

test("allows any session to resolve an open blocker", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(raise(root, "blocker-a").blocker);
		const resolved = blockers.resolveProjectMapStoreBlocker({ root, capabilityId: "project-map", blockerId: "blocker-a", resolution: "Approved", now: LATER });
		assert.deepEqual(resolved.diagnostics, []);
		assert.equal(resolved.blocker?.raised_by, "session-a");
		assert.equal(resolved.blocker?.resolved_at, LATER);
		assert.equal(resolved.blocker?.resolution, "Approved");
		const reread = blockers.readProjectMapStoreBlocker({ root, capabilityId: "project-map", blockerId: "blocker-a" });
		assert.equal(reread.status, "resolved");
		assert.deepEqual(reread.blocker, resolved.blocker);
		assert.equal(readFileSync(blockerPath(root, "project-map", "blocker-a"), "utf8"), serializeProjectMapStoreValue("blocker", resolved.blocker).record);
		assert.deepEqual({ owner: reread.blocker?.owner, reason: reread.blocker?.reason, raised_by: reread.blocker?.raised_by, raised_at: reread.blocker?.raised_at }, { owner: "owner-a", reason: "Needs review", raised_by: "session-a", raised_at: NOW });
	});
});

test("refuses a second resolution and preserves the first bytes", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(raise(root, "blocker-a").blocker);
		assert.ok(blockers.resolveProjectMapStoreBlocker({ root, capabilityId: "project-map", blockerId: "blocker-a", resolution: "Approved", now: LATER }).blocker);
		const path = blockerPath(root, "project-map", "blocker-a");
		const before = readFileSync(path, "utf8");
		const refused = blockers.resolveProjectMapStoreBlocker({ root, capabilityId: "project-map", blockerId: "blocker-a", resolution: "Overwritten", now: "2026-09-24T12:02:00.000Z" });
		assert.equal(refused.blocker, null);
		assert.deepEqual(codes(refused), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.BLOCKER_RESOLVED]);
		assert.equal(readFileSync(path, "utf8"), before);
	});
});

test("reports an absent blocker when resolving", () => {
	withRoot((root) => {
		initialize(root);
		const result = blockers.resolveProjectMapStoreBlocker({ root, capabilityId: "project-map", blockerId: "missing", resolution: "Approved", now: LATER });
		assert.equal(result.blocker, null);
		assert.deepEqual(codes(result), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.BLOCKER_ABSENT]);
	});
});

test("lists open blockers by raised_at and blocker_id and optionally includes resolved blockers", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(raise(root, "z-last", { now: LATER }).blocker);
		assert.ok(raise(root, "a-first", { now: NOW }).blocker);
		assert.ok(raise(root, "b-first", { now: NOW }).blocker);
		assert.ok(blockers.resolveProjectMapStoreBlocker({ root, capabilityId: "project-map", blockerId: "b-first", resolution: "Done", now: LATER }).blocker);
		const open = blockers.listProjectMapStoreBlockers({ root, capabilityId: "project-map", includeResolved: false });
		assert.deepEqual(open.blockers.map((blocker) => blocker.blocker_id), ["a-first", "z-last"]);
		const all = blockers.listProjectMapStoreBlockers({ root, capabilityId: "project-map", includeResolved: true });
		assert.deepEqual(all.blockers.map((blocker) => blocker.blocker_id), ["a-first", "b-first", "z-last"]);
	});
});

test("lists open blockers chronologically across mixed ISO offsets", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(raise(root, "late-zulu", { now: "2026-09-24T12:00:00.000Z" }).blocker);
		assert.ok(raise(root, "earlier-offset", { now: "2026-09-24T12:30:00.000+01:00" }).blocker);
		const listed = blockers.listProjectMapStoreBlockers({ root, capabilityId: "project-map", includeResolved: false });
		assert.deepEqual(listed.blockers.map((blocker) => blocker.blocker_id), ["earlier-offset", "late-zulu"]);
	});
});

test("orders blockers deterministically when instants tie", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(raise(root, "a-tie", { now: NOW }).blocker);
		assert.ok(raise(root, "B-tie", { now: NOW }).blocker);
		const listed = blockers.listProjectMapStoreBlockers({ root, capabilityId: "project-map", includeResolved: false });
		// Code-unit order puts "B" before "a"; locale collation puts "a" first, so this fails if the
		// tie-break ever goes back to a locale-dependent comparison.
		assert.deepEqual(listed.blockers.map((blocker) => blocker.blocker_id), ["B-tie", "a-tie"]);
	});
});

test("classifies non-canonical and mismatched blocker records as corrupted", () => {
	withRoot((root) => {
		initialize(root);
		const capabilityId = "project-map";
		const blockerId = "blocker-a";
		const blocker: ProjectMapStoreBlockerV1 = { schema: "gentle-shell.project-map-store/v1", kind: "blocker", capability_id: capabilityId, blocker_id: blockerId, owner: "owner-a", reason: "Needs review", raised_by: "session-a", raised_at: NOW };
		const path = blockerPath(root, capabilityId, blockerId);
		mkdirSync(join(root, "blockers", createHash("sha256").update(capabilityId).digest("hex")), { recursive: true });
		writeFileSync(path, JSON.stringify(blocker), "utf8");
		assert.equal(blockers.readProjectMapStoreBlocker({ root, capabilityId, blockerId }).status, "corrupted");
		writeFileSync(path, serializeProjectMapStoreValue("blocker", { ...blocker, capability_id: "other-capability" }).record!, "utf8");
		const capabilityMismatch = blockers.readProjectMapStoreBlocker({ root, capabilityId, blockerId });
		assert.equal(capabilityMismatch.status, "corrupted");
		assert.ok(capabilityMismatch.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED && entry.path === "$.capability_id"));
		writeFileSync(path, serializeProjectMapStoreValue("blocker", { ...blocker, blocker_id: "other-blocker" }).record!, "utf8");
		const blockerMismatch = blockers.readProjectMapStoreBlocker({ root, capabilityId, blockerId });
		assert.equal(blockerMismatch.status, "corrupted");
		assert.ok(blockerMismatch.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED && entry.path === "$.blocker_id"));
	});
});

test("refuses every blocker operation on an uninitialized store without writing", () => {
	withRoot((root) => {
		rmSync(root, { recursive: true, force: true });
		assert.deepEqual(codes(raise(root, "blocker-a")), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
		assert.deepEqual(codes(blockers.resolveProjectMapStoreBlocker({ root, capabilityId: "project-map", blockerId: "blocker-a", resolution: "Done", now: LATER })), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
		assert.equal(existsSync(root), false);
	});
});

test("hashes adversarial capability and blocker ids inside blockers", () => {
	withRoot((root) => {
		initialize(root);
		const capabilityId = "../../outside/../capability";
		const blockerId = "../outside/../blocker";
		assert.ok(raise(root, blockerId, { capabilityId }).blocker);
		assert.equal(existsSync(blockerPath(root, capabilityId, blockerId)), true);
		assert.deepEqual(readdirSync(join(root, "blockers")), [createHash("sha256").update(capabilityId).digest("hex")]);
		assert.deepEqual(readdirSync(join(root, "blockers", createHash("sha256").update(capabilityId).digest("hex"))), [`${createHash("sha256").update(blockerId).digest("hex")}.json`]);
		assert.deepEqual(readdirSync(root).sort(), ["blockers", "locks-quarantine", "store.json"]);
		assert.equal(existsSync(join(root, "outside")), false);
	});
});
