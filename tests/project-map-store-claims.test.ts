import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	PROJECT_MAP_STORE_CLAIM_RENEWAL_INTERVAL_MS,
	PROJECT_MAP_STORE_CLAIM_TTL_MS,
	acquireProjectMapClaim,
	readProjectMapClaim,
	releaseProjectMapClaim,
	renewProjectMapClaim,
} from "../lib/project-map-store-claims.ts";
import { initializeProjectMapStore } from "../lib/project-map-store.ts";
import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES, serializeProjectMapStoreValue, type ProjectMapStoreClaimV1 } from "../lib/project-map-store-schema.ts";

const REPOSITORY_ID = `sha256:${"a".repeat(64)}`;
const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const NOW = "2026-09-24T12:00:00.000Z";
const LATER = "2026-09-24T12:00:10.000Z";
const EXPIRED = "2026-09-24T12:01:00.000Z";

function claimPath(root: string, capabilityId: string): string {
	return join(root, "claims", `${createHash("sha256").update(capabilityId).digest("hex")}.json`);
}

function withRoot(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "project-map-store-claims-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function initialize(root: string): void {
	const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: NOW });
	assert.ok(result.descriptor, result.diagnostics.map((entry) => entry.message).join("\n"));
	assert.deepEqual(result.diagnostics, []);
}

function codes(result: { diagnostics: { code: string }[] }): string[] {
	return result.diagnostics.map((entry) => entry.code);
}

function storedClaim(root: string, capabilityId: string): ProjectMapStoreClaimV1 {
	return JSON.parse(readFileSync(claimPath(root, capabilityId), "utf8")) as ProjectMapStoreClaimV1;
}

test("exports the fixed claim lease intervals", () => {
	assert.equal(PROJECT_MAP_STORE_CLAIM_RENEWAL_INTERVAL_MS, 10_000);
	assert.equal(PROJECT_MAP_STORE_CLAIM_TTL_MS, 60_000);
});

test("acquires a free initialized claim canonically and reads it as live", () => {
	withRoot((root) => {
		initialize(root);
		const acquired = acquireProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: NOW });
		assert.ok(acquired.claim);
		assert.deepEqual(acquired.diagnostics, []);
		assert.deepEqual(acquired.claim.lease, { renewal_after: "2026-09-24T12:00:10.000Z", renew_by: "2026-09-24T12:01:00.000Z" });
		const path = claimPath(root, "project-map");
		assert.equal(readFileSync(path, "utf8"), serializeProjectMapStoreValue("claim", acquired.claim).record);
		const read = readProjectMapClaim({ root, capabilityId: "project-map", now: NOW });
		assert.equal(read.status, "live");
		assert.deepEqual(read.claim, acquired.claim);
		assert.deepEqual(read.diagnostics, []);
	});
});

test("refuses a second session while a claim is live without changing bytes", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(acquireProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: NOW }).claim);
		const path = claimPath(root, "project-map");
		const before = readFileSync(path, "utf8");
		const refused = acquireProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-b", now: LATER });
		assert.equal(refused.claim, null);
		assert.deepEqual(codes(refused), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_HELD]);
		assert.equal(readFileSync(path, "utf8"), before);
	});
});

test("takes over a stale claim and reports the prior holder", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(acquireProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: NOW }).claim);
		const acquired = acquireProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-b", now: EXPIRED });
		assert.equal(acquired.claim?.session_id, "session-b");
		const recovered = acquired.diagnostics.find((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STALE_CLAIM_RECOVERED);
		assert.equal(recovered?.severity, "warning");
		assert.match(recovered?.message ?? "", /session-a/);
		assert.match(recovered?.message ?? "", /2026-09-24T12:01:00.000Z/);
		assert.equal(storedClaim(root, "project-map").session_id, "session-b");
	});
});

test("renews a holder claim after the cadence while preserving identity", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(acquireProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: NOW }).claim);
		const renewed = renewProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: LATER });
		assert.equal(renewed.claim?.acquired_at, NOW);
		assert.equal(renewed.claim?.session_id, "session-a");
		assert.deepEqual(renewed.claim?.lease, { renewal_after: "2026-09-24T12:00:20.000Z", renew_by: "2026-09-24T12:01:10.000Z" });
		assert.deepEqual(renewed.diagnostics, []);
	});
});

test("refuses renewal before its cadence without changing bytes", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(acquireProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: NOW }).claim);
		const path = claimPath(root, "project-map");
		const before = readFileSync(path, "utf8");
		const refused = renewProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: "2026-09-24T12:00:09.999Z" });
		assert.equal(refused.claim, null);
		assert.deepEqual(codes(refused), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.RENEWAL_TOO_EARLY]);
		assert.equal(readFileSync(path, "utf8"), before);
	});
});

test("refuses renewal by another session or after expiry", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(acquireProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: NOW }).claim);
		const path = claimPath(root, "project-map");
		const before = readFileSync(path, "utf8");
		const another = renewProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-b", now: LATER });
		assert.equal(another.claim, null);
		assert.deepEqual(codes(another), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_NOT_HELD]);
		assert.equal(readFileSync(path, "utf8"), before);
		const expired = renewProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: EXPIRED });
		assert.equal(expired.claim, null);
		assert.deepEqual(codes(expired), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_EXPIRED]);
		assert.equal(readFileSync(path, "utf8"), before);
	});
});

test("releases only the holder and reports absent claims", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(acquireProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: NOW }).claim);
		const rejected = releaseProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-b", now: LATER });
		assert.equal(rejected.released, false);
		assert.deepEqual(codes(rejected), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_NOT_HELD]);
		const released = releaseProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: LATER });
		assert.equal(released.released, true);
		assert.deepEqual(released.diagnostics, []);
		assert.equal(existsSync(claimPath(root, "project-map")), false);
		const absent = releaseProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: LATER });
		assert.equal(absent.released, false);
		assert.deepEqual(codes(absent), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_ABSENT]);
	});
});

test("classifies non-canonical and mismatched-id claim files as corrupted", () => {
	withRoot((root) => {
		initialize(root);
		const capabilityId = "project-map";
		const claim: ProjectMapStoreClaimV1 = {
			schema: "gentle-shell.project-map-store/v1",
			kind: "claim",
			capability_id: capabilityId,
			session_id: "session-a",
			acquired_at: NOW,
			lease: { renewal_after: "2026-09-24T12:00:10.000Z", renew_by: "2026-09-24T12:01:00.000Z" },
		};
		mkdirSync(join(root, "claims"));
		const path = claimPath(root, capabilityId);
		writeFileSync(path, JSON.stringify(claim), "utf8");
		assert.equal(readProjectMapClaim({ root, capabilityId, now: NOW }).status, "corrupted");
		writeFileSync(path, serializeProjectMapStoreValue("claim", { ...claim, capability_id: "other-capability" }).record!, "utf8");
		const mismatched = readProjectMapClaim({ root, capabilityId, now: NOW });
		assert.equal(mismatched.status, "corrupted");
		assert.ok(mismatched.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED && entry.path === "$.capability_id"), JSON.stringify(mismatched.diagnostics));
	});
});

test("refuses claim writes on an uninitialized store without creating it", () => {
	withRoot((root) => {
		rmSync(root, { recursive: true, force: true });
		const acquired = acquireProjectMapClaim({ root, capabilityId: "project-map", sessionId: "session-a", now: NOW });
		assert.equal(acquired.claim, null);
		assert.deepEqual(codes(acquired), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
		assert.match(acquired.diagnostics[0].message, /initialized first/);
		assert.equal(existsSync(root), false);
	});
});

test("hashes adversarial capability ids into the claims directory", () => {
	withRoot((root) => {
		initialize(root);
		const capabilityId = "../../outside/../capability";
		const acquired = acquireProjectMapClaim({ root, capabilityId, sessionId: "session-a", now: NOW });
		assert.ok(acquired.claim);
		assert.equal(existsSync(claimPath(root, capabilityId)), true);
		assert.deepEqual(readdirSync(join(root, "claims")), [`${createHash("sha256").update(capabilityId).digest("hex")}.json`]);
		assert.equal(existsSync(join(root, "outside")), false);
	});
});
