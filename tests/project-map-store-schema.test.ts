import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	PROJECT_MAP_STORE_DIAGNOSTIC_CODES,
	PROJECT_MAP_STORE_RECORD_KINDS,
	PROJECT_MAP_STORE_SCHEMA_V1,
	canonicalizeProjectMapStoreValue,
	parseProjectMapStoreValue,
	readProjectMapStoreValueFile,
	serializeProjectMapStoreValue,
	validateProjectMapStoreValue,
	type ProjectMapStoreRecordKind,
} from "../lib/project-map-store-schema.ts";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const LATER_UUID = "123e4567-e89b-12d3-a456-426614174001";
const AT = "2026-09-24T12:00:00Z";
const RENEW_AFTER = "2026-09-24T12:00:10Z";
const RENEW_BY = "2026-09-24T12:01:00Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

function record(kind: ProjectMapStoreRecordKind, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const common = { schema: PROJECT_MAP_STORE_SCHEMA_V1, kind };
	const records: Record<ProjectMapStoreRecordKind, Record<string, unknown>> = {
		descriptor: { ...common, repository_id: DIGEST, generation: 0, epoch: UUID, predecessor: null, created_at: AT, updated_at: AT },
		claim: { ...common, capability_id: "project-map", session_id: "session-1", acquired_at: AT, lease: { renewal_after: RENEW_AFTER, renew_by: RENEW_BY } },
		heartbeat: { ...common, session_id: "session-1", pid: 1, incarnation: UUID, beat_at: AT },
		"session-binding": { ...common, session_id: "session-1", pid: 1, incarnation: UUID, workspace_root: "/workspace", bound_at: AT },
		blocker: { ...common, capability_id: "project-map", blocker_id: "blocker-1", owner: "owner-1", reason: "Needs review", raised_by: "session-1", raised_at: AT },
		"contract-proposal": { ...common, capability_id: "project-map", contract_id: "contract-1", title: "Shared boundary", digest: DIGEST, proposed_by: "session-1", proposed_at: AT, state: "proposed" },
		"readiness-receipt": { ...common, capability_id: "project-map", issued_by: "session-1", issued_at: AT, verified: ["tests"], evidence: ["node --test"], authority: "none" },
		"worktree-binding": { ...common, capability_id: "project-map", branch: "feat/project-map", worktree_root: "/workspace/project-map-worktrees/project-map", session_id: "session-1", base_commit: "a".repeat(40), created_at: AT },
	};
	return { ...records[kind], ...overrides };
}

function codes(result: { record: unknown; diagnostics: { code: string }[] }): string[] {
	assert.equal(result.record, null);
	return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function paths(result: { record: unknown; diagnostics: { path: string }[] }): string[] {
	assert.equal(result.record, null);
	return result.diagnostics.map((diagnostic) => diagnostic.path);
}

test("exports the frozen store vocabulary", () => {
	assert.equal(PROJECT_MAP_STORE_SCHEMA_V1, "gentle-shell.project-map-store/v1");
	assert.deepEqual([...PROJECT_MAP_STORE_RECORD_KINDS], ["descriptor", "claim", "heartbeat", "session-binding", "blocker", "contract-proposal", "readiness-receipt", "worktree-binding"]);
	assert.deepEqual(PROJECT_MAP_STORE_DIAGNOSTIC_CODES, {
		UNSUPPORTED_SCHEMA_VERSION: "project-map-store/unsupported-schema-version",
		UNKNOWN_FIELD: "project-map-store/unknown-field",
		MISSING_FIELD: "project-map-store/missing-field",
		INVALID_FIELD: "project-map-store/invalid-field",
		INVALID_JSON: "project-map-store/invalid-json",
		UNREADABLE_STORE: "project-map-store/unreadable-store",
		STALE_GENERATION: "project-map-store/stale-generation",
		STORE_CORRUPTED: "project-map-store/store-corrupted",
		STORE_EXISTS: "project-map-store/store-exists",
		STORE_NOT_EMPTY: "project-map-store/store-not-empty",
		QUARANTINE_EXISTS: "project-map-store/quarantine-exists",
		STORE_LOCKED: "project-map-store/store-locked",
		CLAIM_HELD: "project-map-store/claim-held",
		CLAIM_ABSENT: "project-map-store/claim-absent",
		CLAIM_NOT_HELD: "project-map-store/claim-not-held",
		CLAIM_EXPIRED: "project-map-store/claim-expired",
		RENEWAL_TOO_EARLY: "project-map-store/renewal-too-early",
		STALE_CLAIM_RECOVERED: "project-map-store/stale-claim-recovered",
		HEARTBEAT_TOO_EARLY: "project-map-store/heartbeat-too-early",
		SESSION_BINDING_HELD: "project-map-store/session-binding-held",
		BLOCKER_EXISTS: "project-map-store/blocker-exists",
		BLOCKER_ABSENT: "project-map-store/blocker-absent",
		BLOCKER_RESOLVED: "project-map-store/blocker-resolved",
		CONTRACT_EXISTS: "project-map-store/contract-exists",
		CONTRACT_ABSENT: "project-map-store/contract-absent",
		CONTRACT_ALREADY_DECIDED: "project-map-store/contract-already-decided",
		WORKTREE_CLAIM_REQUIRED: "project-map-store/worktree-claim-required",
		WORKTREE_TARGET_NOT_EMPTY: "project-map-store/worktree-target-not-empty",
		WORKTREE_NESTED_REPOSITORY: "project-map-store/worktree-nested-repository",
		WORKTREE_FOREIGN_CLONE: "project-map-store/worktree-foreign-clone",
		WORKTREE_OCCUPIED: "project-map-store/worktree-occupied",
		WORKTREE_PATH_ESCAPES: "project-map-store/worktree-path-escapes",
		WORKTREE_ALREADY_BOUND: "project-map-store/worktree-already-bound",
	});
});

test("accepts every frozen record shape and retains the kind envelope through serialization", () => {
	for (const kind of PROJECT_MAP_STORE_RECORD_KINDS) {
		const validated = validateProjectMapStoreValue(kind, record(kind));
		assert.deepEqual(validated.diagnostics, [], kind);
		assert.ok(validated.record, kind);
		assert.equal(validated.record.kind, kind);
		const reparsed = parseProjectMapStoreValue(kind, serializeProjectMapStoreValue(kind, validated.record).record as string);
		assert.deepEqual(reparsed.diagnostics, [], kind);
		assert.equal(reparsed.record?.kind, kind);
	}
});

test("accepts migration-safe unresolved blocker defaults", () => {
	const result = validateProjectMapStoreValue("blocker", record("blocker"));
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(Object.keys(result.record as object), ["schema", "kind", "capability_id", "blocker_id", "owner", "reason", "raised_by", "raised_at"]);
});

test("refuses unsupported versions and missing, unknown, or mismatched kinds", () => {
	const version = validateProjectMapStoreValue("claim", record("claim", { schema: "gentle-shell.project-map-store/v2" }));
	assert.deepEqual(codes(version), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNSUPPORTED_SCHEMA_VERSION]);
	assert.deepEqual(paths(version), ["$.schema"]);

	const missing = record("claim");
	delete missing.kind;
	const missingKind = validateProjectMapStoreValue("claim", missing);
	assert.deepEqual(codes(missingKind), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(missingKind), ["$.kind"]);

	const mismatch = validateProjectMapStoreValue("claim", record("descriptor", { kind: "lease" }));
	assert.deepEqual(codes(mismatch), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(mismatch), ["$.kind"]);

	const other = validateProjectMapStoreValue("claim", record("descriptor"));
	assert.deepEqual(codes(other), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(other), ["$.kind"]);
});

test("reports unknown and missing fields in deterministic discovery order", () => {
	const value = record("claim", { unexpected: true });
	delete value.session_id;
	delete value.acquired_at;
	const result = validateProjectMapStoreValue("claim", value);
	assert.deepEqual(codes(result), [
		PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNKNOWN_FIELD,
		PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD,
		PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD,
	]);
	assert.deepEqual(paths(result), ["$.unexpected", "$.session_id", "$.acquired_at"]);
});

test("enforces descriptor generation epoch and predecessor fields", () => {
	const result = validateProjectMapStoreValue("descriptor", record("descriptor", { repository_id: "sha256:short", generation: -1, epoch: "no", predecessor: "sha256:bad" }));
	assert.deepEqual(codes(result), Array(4).fill(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD));
	assert.deepEqual(paths(result), ["$.repository_id", "$.generation", "$.epoch", "$.predecessor"]);
});

test("enforces the claim lease shape and ordered renewal window", () => {
	const malformed = validateProjectMapStoreValue("claim", record("claim", { lease: { renewal_after: RENEW_BY, renew_by: RENEW_AFTER } }));
	assert.deepEqual(codes(malformed), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(malformed), ["$.lease.renew_by"]);

	const beforeAcquire = validateProjectMapStoreValue("claim", record("claim", { lease: { renewal_after: "2026-09-24T11:59:59Z", renew_by: RENEW_BY } }));
	assert.deepEqual(paths(beforeAcquire), ["$.lease.renewal_after"]);
});

test("compares lease instants across offsets and fractional seconds", () => {
	const mixedOffsetBeforeAcquire = validateProjectMapStoreValue("claim", record("claim", {
		lease: { renewal_after: "2026-09-24T13:00:00+02:00", renew_by: "2026-09-24T14:00:00+02:00" },
	}));
	assert.deepEqual(paths(mixedOffsetBeforeAcquire), ["$.lease.renewal_after"]);

	const validMixedOffset = validateProjectMapStoreValue("claim", record("claim", {
		lease: { renewal_after: "2026-09-24T14:00:00.250+02:00", renew_by: "2026-09-24T10:00:01.500-02:00" },
	}));
	assert.deepEqual(validMixedOffset.diagnostics, []);
	assert.ok(validMixedOffset.record);
});

test("reports lease missing and unknown fields at their nested paths", () => {
	const missingRenewBy = record("claim");
	delete (missingRenewBy.lease as Record<string, unknown>).renew_by;
	const missingRenewalAfter = record("claim");
	delete (missingRenewalAfter.lease as Record<string, unknown>).renewal_after;
	const unknownLeaseField = validateProjectMapStoreValue("claim", record("claim", {
		lease: { renewal_after: RENEW_AFTER, renew_by: RENEW_BY, unexpected: true },
	}));

	assert.deepEqual(paths(validateProjectMapStoreValue("claim", missingRenewBy)), ["$.lease.renew_by"]);
	assert.deepEqual(paths(validateProjectMapStoreValue("claim", missingRenewalAfter)), ["$.lease.renewal_after"]);
	assert.deepEqual(paths(unknownLeaseField), ["$.lease.unexpected"]);
});

test("validates the worktree binding record shape", () => {
	const valid = validateProjectMapStoreValue("worktree-binding" as ProjectMapStoreRecordKind, record("worktree-binding" as ProjectMapStoreRecordKind));
	assert.deepEqual(valid.diagnostics, []);
	assert.deepEqual(Object.keys(valid.record as object), ["schema", "kind", "capability_id", "branch", "worktree_root", "session_id", "base_commit", "created_at"]);

	const unknown = validateProjectMapStoreValue("worktree-binding" as ProjectMapStoreRecordKind, record("worktree-binding" as ProjectMapStoreRecordKind, { unexpected: true }));
	assert.deepEqual(paths(unknown), ["$.unexpected"]);
	const missingValue = record("worktree-binding" as ProjectMapStoreRecordKind);
	delete missingValue.base_commit;
	assert.deepEqual(paths(validateProjectMapStoreValue("worktree-binding" as ProjectMapStoreRecordKind, missingValue)), ["$.base_commit"]);

	for (const [field, value] of [
		["branch", "main"],
		["base_commit", `sha256:${"a".repeat(64)}`],
		["base_commit", "a".repeat(39)],
		["worktree_root", "relative/path"],
		["worktree_root", "/workspace/../workspace/project-map"],
	] as const) {
		const invalid = validateProjectMapStoreValue("worktree-binding" as ProjectMapStoreRecordKind, record("worktree-binding" as ProjectMapStoreRecordKind, { [field]: value }));
		assert.deepEqual(codes(invalid), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD], `${field}: ${value}`);
		assert.deepEqual(paths(invalid), [`$.${field}`], `${field}: ${value}`);
	}
});

test("requires an issuer and refuses readiness receipts that imply delivery authority", () => {
	const missingIssuer = record("readiness-receipt");
	delete missingIssuer.issued_by;
	const missing = validateProjectMapStoreValue("readiness-receipt", missingIssuer);
	assert.deepEqual(codes(missing), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(missing), ["$.issued_by"]);

	const result = validateProjectMapStoreValue("readiness-receipt", record("readiness-receipt", { authority: "delivery" }));
	assert.deepEqual(codes(result), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(result), ["$.authority"]);
});

test("enforces record field rules and paired blocker resolution", () => {
	const heartbeat = validateProjectMapStoreValue("heartbeat", record("heartbeat", { session_id: "", pid: 0, incarnation: LATER_UUID.replace("1", "x"), beat_at: "tomorrow" }));
	assert.deepEqual(paths(heartbeat), ["$.session_id", "$.pid", "$.incarnation", "$.beat_at"]);

	const blocker = validateProjectMapStoreValue("blocker", record("blocker", { resolved_at: AT }));
	assert.deepEqual(codes(blocker), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(blocker), ["$.resolution"]);

	const missingResolutionTime = validateProjectMapStoreValue("blocker", record("blocker", { resolution: "Approved" }));
	assert.deepEqual(codes(missingResolutionTime), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(missingResolutionTime), ["$.resolved_at"]);

	const missingDecider = record("contract-proposal", { state: "accepted", decided_at: AT, rationale: "Approved" });
	assert.deepEqual(codes(validateProjectMapStoreValue("contract-proposal", missingDecider)), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(validateProjectMapStoreValue("contract-proposal", missingDecider)), ["$.decided_by"]);

	const missingDecisionTime = record("contract-proposal", { state: "accepted", decided_by: "session-lead", rationale: "Approved" });
	assert.deepEqual(codes(validateProjectMapStoreValue("contract-proposal", missingDecisionTime)), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(validateProjectMapStoreValue("contract-proposal", missingDecisionTime)), ["$.decided_at"]);

	const missingRationale = record("contract-proposal", { state: "accepted", decided_by: "session-lead", decided_at: AT });
	assert.deepEqual(codes(validateProjectMapStoreValue("contract-proposal", missingRationale)), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(validateProjectMapStoreValue("contract-proposal", missingRationale)), ["$.rationale"]);

	const proposedWithDecision = validateProjectMapStoreValue("contract-proposal", record("contract-proposal", { decided_by: "session-lead" }));
	assert.deepEqual(codes(proposedWithDecision), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(proposedWithDecision), ["$.decided_by"]);

	const proposedWithDecisionTime = validateProjectMapStoreValue("contract-proposal", record("contract-proposal", { decided_at: AT }));
	assert.deepEqual(codes(proposedWithDecisionTime), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(proposedWithDecisionTime), ["$.decided_at"]);

	const proposedWithRationale = validateProjectMapStoreValue("contract-proposal", record("contract-proposal", { rationale: "Approved" }));
	assert.deepEqual(codes(proposedWithRationale), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(proposedWithRationale), ["$.rationale"]);

	const rejectedMissingDecider = record("contract-proposal", { state: "rejected", decided_at: AT, rationale: "No" });
	assert.deepEqual(codes(validateProjectMapStoreValue("contract-proposal", rejectedMissingDecider)), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(validateProjectMapStoreValue("contract-proposal", rejectedMissingDecider)), ["$.decided_by"]);

	const rejectedMissingTime = record("contract-proposal", { state: "rejected", decided_by: "session-lead", rationale: "No" });
	assert.deepEqual(codes(validateProjectMapStoreValue("contract-proposal", rejectedMissingTime)), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(validateProjectMapStoreValue("contract-proposal", rejectedMissingTime)), ["$.decided_at"]);

	const rejectedMissingRationale = record("contract-proposal", { state: "rejected", decided_by: "session-lead", decided_at: AT });
	assert.deepEqual(codes(validateProjectMapStoreValue("contract-proposal", rejectedMissingRationale)), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(validateProjectMapStoreValue("contract-proposal", rejectedMissingRationale)), ["$.rationale"]);

	const missingIdentifiers = record("blocker");
	delete missingIdentifiers.blocker_id;
	delete missingIdentifiers.owner;
	const invalidIdentifiers = validateProjectMapStoreValue("blocker", missingIdentifiers);
	assert.deepEqual(paths(invalidIdentifiers), ["$.blocker_id", "$.owner"]);
});

test("canonicalizes byte-identically regardless of insertion order", () => {
	const first = record("readiness-receipt");
	const second = { authority: "none", evidence: ["node --test"], verified: ["tests"], issued_at: AT, issued_by: "session-1", capability_id: "project-map", kind: "readiness-receipt", schema: PROJECT_MAP_STORE_SCHEMA_V1 };
	const one = serializeProjectMapStoreValue("readiness-receipt", first);
	const two = serializeProjectMapStoreValue("readiness-receipt", second);
	assert.deepEqual(one.diagnostics, []);
	assert.deepEqual(two.diagnostics, []);
	assert.equal(one.record, two.record);
	assert.deepEqual(Object.keys(canonicalizeProjectMapStoreValue("readiness-receipt", second).record as object), ["schema", "kind", "capability_id", "issued_by", "issued_at", "verified", "evidence", "authority"]);
});

test("distinguishes invalid JSON from an unreadable store file", () => {
	const directory = mkdtempSync(join(tmpdir(), "project-map-store-schema-"));
	try {
		const broken = join(directory, "broken.json");
		writeFileSync(broken, "{ not json", "utf8");
		const invalid = readProjectMapStoreValueFile("claim", broken);
		assert.deepEqual(codes(invalid), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_JSON]);
		const missing = readProjectMapStoreValueFile("claim", join(directory, "missing.json"));
		assert.deepEqual(codes(missing), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("never throws on malformed values and hostile prototypes", () => {
	const hostile = Object.create(null) as Record<string, unknown>;
	hostile.schema = PROJECT_MAP_STORE_SCHEMA_V1;
	hostile.kind = "claim";
	for (const value of [undefined, null, 1, [], hostile]) {
		assert.doesNotThrow(() => validateProjectMapStoreValue("claim", value));
		assert.doesNotThrow(() => canonicalizeProjectMapStoreValue("claim", value));
		assert.doesNotThrow(() => serializeProjectMapStoreValue("claim", value));
	}
	for (const value of [undefined, null, 1, {}]) assert.doesNotThrow(() => parseProjectMapStoreValue("claim", value as string));
});

const BINDING_BODY = { schema: PROJECT_MAP_STORE_SCHEMA_V1, kind: "session-binding" as const, session_id: "session-a", pid: 7, incarnation: "123e4567-e89b-12d3-a456-426614174001", workspace_root: "/w", bound_at: "2026-09-26T12:00:00.000Z" };

test("a session binding without a launch nonce still round-trips, so no existing record breaks", () => {
	const serialized = serializeProjectMapStoreValue("session-binding", BINDING_BODY);
	assert.ok(serialized.record);
	assert.doesNotMatch(serialized.record!, /launch_nonce/);
	const parsed = parseProjectMapStoreValue("session-binding", serialized.record!);
	assert.ok(parsed.record);
	assert.equal((parsed.record as { launch_nonce?: string }).launch_nonce, undefined);
});

test("a session binding carrying a launch nonce round-trips it canonically", () => {
	const nonce = "123e4567-e89b-12d3-a456-426614174000";
	const serialized = serializeProjectMapStoreValue("session-binding", { ...BINDING_BODY, launch_nonce: nonce });
	assert.ok(serialized.record);
	assert.match(serialized.record!, /launch_nonce/);
	const parsed = parseProjectMapStoreValue("session-binding", serialized.record!);
	assert.ok(parsed.record);
	assert.equal((parsed.record as { launch_nonce?: string }).launch_nonce, nonce);
});

test("a launch nonce that is not a non-empty string is refused", () => {
	for (const launch_nonce of ["", 7, null, {}, []]) {
		assert.equal(validateProjectMapStoreValue("session-binding", { ...BINDING_BODY, launch_nonce }).record, null, `accepted ${JSON.stringify(launch_nonce)}`);
	}
});
