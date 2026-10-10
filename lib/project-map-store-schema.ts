import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isIsoInstant } from "./shell-project-map-schema.ts";

export const PROJECT_MAP_STORE_SCHEMA_V1 = "gentle-shell.project-map-store/v1" as const;
export const PROJECT_MAP_STORE_RECORD_KINDS = ["descriptor", "claim", "heartbeat", "session-binding", "blocker", "contract-proposal", "readiness-receipt", "worktree-binding"] as const;
export type ProjectMapStoreRecordKind = (typeof PROJECT_MAP_STORE_RECORD_KINDS)[number];
export const PROJECT_MAP_STORE_DIAGNOSTIC_CODES = {
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
} as const;
export type ProjectMapStoreDiagnosticCode = (typeof PROJECT_MAP_STORE_DIAGNOSTIC_CODES)[keyof typeof PROJECT_MAP_STORE_DIAGNOSTIC_CODES];

export interface ProjectMapStoreDiagnostic {
	code: ProjectMapStoreDiagnosticCode;
	path: string;
	message: string;
	severity: "error" | "warning";
}

interface RecordBase {
	schema: typeof PROJECT_MAP_STORE_SCHEMA_V1;
	kind: ProjectMapStoreRecordKind;
}

export interface ProjectMapStoreDescriptorV1 extends RecordBase {
	kind: "descriptor";
	repository_id: string;
	generation: number;
	epoch: string;
	predecessor: string | null;
	created_at: string;
	updated_at: string;
}

export interface ProjectMapStoreClaimV1 extends RecordBase {
	kind: "claim";
	capability_id: string;
	session_id: string;
	acquired_at: string;
	lease: { renewal_after: string; renew_by: string };
}

export interface ProjectMapStoreHeartbeatV1 extends RecordBase {
	kind: "heartbeat";
	session_id: string;
	pid: number;
	incarnation: string;
	beat_at: string;
}

export interface ProjectMapStoreSessionBindingV1 extends RecordBase {
	kind: "session-binding";
	session_id: string;
	pid: number;
	incarnation: string;
	workspace_root: string;
	bound_at: string;
	/**
	 * The nonce this launch generated, when the child was launched by one. Optional so
	 * that bindings written before this field existed keep round-tripping instead of
	 * being reported as corrupted; a launch that expects a nonce simply refuses to be
	 * confirmed by a binding that carries none.
	 */
	launch_nonce?: string;
}

export interface ProjectMapStoreBlockerV1 extends RecordBase {
	kind: "blocker";
	capability_id: string;
	blocker_id: string;
	owner: string;
	reason: string;
	raised_by: string;
	raised_at: string;
	resolved_at?: string;
	resolution?: string;
}

export interface ProjectMapStoreContractProposalV1 extends RecordBase {
	kind: "contract-proposal";
	capability_id: string;
	contract_id: string;
	title: string;
	digest: string;
	proposed_by: string;
	proposed_at: string;
	state: "proposed" | "accepted" | "rejected";
	decided_by?: string;
	decided_at?: string;
	rationale?: string;
}

export interface ProjectMapStoreReadinessReceiptV1 extends RecordBase {
	kind: "readiness-receipt";
	capability_id: string;
	issued_by: string;
	issued_at: string;
	verified: string[];
	evidence: string[];
	authority: "none";
}

export interface ProjectMapStoreWorktreeBindingV1 extends RecordBase {
	kind: "worktree-binding";
	capability_id: string;
	branch: string;
	worktree_root: string;
	session_id: string;
	base_commit: string;
	created_at: string;
}

export type ProjectMapStoreRecord = ProjectMapStoreDescriptorV1 | ProjectMapStoreClaimV1 | ProjectMapStoreHeartbeatV1 | ProjectMapStoreSessionBindingV1 | ProjectMapStoreBlockerV1 | ProjectMapStoreContractProposalV1 | ProjectMapStoreReadinessReceiptV1 | ProjectMapStoreWorktreeBindingV1;
export interface ProjectMapStoreResult<T = ProjectMapStoreRecord> {
	record: T | null;
	diagnostics: ProjectMapStoreDiagnostic[];
}

type RecordValue = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function report(diagnostics: ProjectMapStoreDiagnostic[], code: ProjectMapStoreDiagnosticCode, path: string, message: string): void {
	diagnostics.push({ code, path, message, severity: "error" });
}

function invalid(diagnostics: ProjectMapStoreDiagnostic[], path: string, message: string): void {
	report(diagnostics, PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD, path, message);
}

function unknownFields(value: RecordValue, allowed: readonly string[], diagnostics: ProjectMapStoreDiagnostic[], path = "$"): void {
	const permitted = new Set(allowed);
	for (const field of Object.keys(value).filter((field) => !permitted.has(field)).sort()) {
		report(diagnostics, PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNKNOWN_FIELD, `${path}.${field}`, `Unknown field "${field}".`);
	}
}

function required(value: RecordValue, fields: readonly string[], diagnostics: ProjectMapStoreDiagnostic[], path = "$"): void {
	for (const field of fields) {
		if (value[field] === undefined) report(diagnostics, PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD, `${path}.${field}`, `Missing required field "${field}".`);
	}
}

function identifier(value: unknown, path: string, diagnostics: ProjectMapStoreDiagnostic[]): value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		invalid(diagnostics, path, "Expected a non-empty string.");
		return false;
	}
	return true;
}

function instant(value: unknown, path: string, diagnostics: ProjectMapStoreDiagnostic[]): value is string {
	if (typeof value !== "string" || !isIsoInstant(value)) {
		invalid(diagnostics, path, "Expected an ISO-8601 instant.");
		return false;
	}
	return true;
}

function stringArray(value: unknown, path: string, diagnostics: ProjectMapStoreDiagnostic[], nonEmpty: boolean): value is string[] {
	if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
		invalid(diagnostics, path, nonEmpty ? "Expected a non-empty array of unique non-empty strings." : "Expected an array of unique non-empty strings.");
		return false;
	}
	const seen = new Set<string>();
	let valid = true;
	for (let index = 0; index < value.length; index += 1) {
		if (!identifier(value[index], `${path}[${index}]`, diagnostics) || seen.has(value[index] as string)) {
			if (seen.has(value[index] as string)) invalid(diagnostics, `${path}[${index}]`, "Expected a unique non-empty string.");
			valid = false;
			continue;
		}
		seen.add(value[index] as string);
	}
	return valid;
}

function validateLease(value: unknown, acquiredAt: string | undefined, diagnostics: ProjectMapStoreDiagnostic[]): value is { renewal_after: string; renew_by: string } {
	if (!isRecord(value)) {
		invalid(diagnostics, "$.lease", "Expected a lease object.");
		return false;
	}
	unknownFields(value, ["renewal_after", "renew_by"], diagnostics, "$.lease");
	required(value, ["renewal_after", "renew_by"], diagnostics, "$.lease");
	const renewalAfter = value.renewal_after !== undefined && instant(value.renewal_after, "$.lease.renewal_after", diagnostics);
	const renewBy = value.renew_by !== undefined && instant(value.renew_by, "$.lease.renew_by", diagnostics);
	const renewalAfterMs = renewalAfter ? Date.parse(value.renewal_after as string) : Number.NaN;
	const renewByMs = renewBy ? Date.parse(value.renew_by as string) : Number.NaN;
	const acquiredAtMs = acquiredAt === undefined ? undefined : Date.parse(acquiredAt);
	if (renewalAfter && acquiredAtMs !== undefined && renewalAfterMs < acquiredAtMs) invalid(diagnostics, "$.lease.renewal_after", "Renewal may not precede acquisition.");
	if (renewalAfter && renewBy && renewByMs <= renewalAfterMs) invalid(diagnostics, "$.lease.renew_by", "Renew-by must follow renewal-after.");
	return renewalAfter && renewBy && (acquiredAtMs === undefined || renewalAfterMs >= acquiredAtMs) && renewByMs > renewalAfterMs;
}

function canonical(kind: ProjectMapStoreRecordKind, value: RecordValue): ProjectMapStoreRecord {
	const base = { schema: PROJECT_MAP_STORE_SCHEMA_V1, kind } as const;
	switch (kind) {
		case "descriptor": return { ...base, kind, repository_id: value.repository_id as string, generation: value.generation as number, epoch: value.epoch as string, predecessor: value.predecessor as string | null, created_at: value.created_at as string, updated_at: value.updated_at as string };
		case "claim": return { ...base, kind, capability_id: value.capability_id as string, session_id: value.session_id as string, acquired_at: value.acquired_at as string, lease: { renewal_after: (value.lease as RecordValue).renewal_after as string, renew_by: (value.lease as RecordValue).renew_by as string } };
		case "heartbeat": return { ...base, kind, session_id: value.session_id as string, pid: value.pid as number, incarnation: value.incarnation as string, beat_at: value.beat_at as string };
		case "session-binding": return { ...base, kind, session_id: value.session_id as string, pid: value.pid as number, incarnation: value.incarnation as string, workspace_root: value.workspace_root as string, bound_at: value.bound_at as string, ...(value.launch_nonce === undefined ? {} : { launch_nonce: value.launch_nonce as string }) };
		case "blocker": return { ...base, kind, capability_id: value.capability_id as string, blocker_id: value.blocker_id as string, owner: value.owner as string, reason: value.reason as string, raised_by: value.raised_by as string, raised_at: value.raised_at as string, ...(value.resolved_at === undefined ? {} : { resolved_at: value.resolved_at as string }), ...(value.resolution === undefined ? {} : { resolution: value.resolution as string }) };
		case "contract-proposal": return { ...base, kind, capability_id: value.capability_id as string, contract_id: value.contract_id as string, title: value.title as string, digest: value.digest as string, proposed_by: value.proposed_by as string, proposed_at: value.proposed_at as string, state: value.state as "proposed" | "accepted" | "rejected", ...(value.decided_by === undefined ? {} : { decided_by: value.decided_by as string }), ...(value.decided_at === undefined ? {} : { decided_at: value.decided_at as string }), ...(value.rationale === undefined ? {} : { rationale: value.rationale as string }) };
		case "readiness-receipt": return { ...base, kind, capability_id: value.capability_id as string, issued_by: value.issued_by as string, issued_at: value.issued_at as string, verified: [...(value.verified as string[])], evidence: [...(value.evidence as string[])], authority: "none" };
		case "worktree-binding": return { ...base, kind, capability_id: value.capability_id as string, branch: value.branch as string, worktree_root: value.worktree_root as string, session_id: value.session_id as string, base_commit: value.base_commit as string, created_at: value.created_at as string };
	}
}

export function validateProjectMapStoreValue(kind: ProjectMapStoreRecordKind, value: unknown): ProjectMapStoreResult {
	try {
		const diagnostics: ProjectMapStoreDiagnostic[] = [];
		if (!PROJECT_MAP_STORE_RECORD_KINDS.includes(kind)) {
			invalid(diagnostics, "$.kind", "Requested record kind is unsupported.");
			return { record: null, diagnostics };
		}
		if (!isRecord(value)) {
			invalid(diagnostics, "$", "Expected a store record object.");
			return { record: null, diagnostics };
		}
		if (value.schema === undefined) {
			report(diagnostics, PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD, "$.schema", "Missing required field \"schema\".");
			return { record: null, diagnostics };
		}
		if (typeof value.schema !== "string") {
			invalid(diagnostics, "$.schema", "Expected the schema version string.");
			return { record: null, diagnostics };
		}
		if (value.schema !== PROJECT_MAP_STORE_SCHEMA_V1) {
			report(diagnostics, PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNSUPPORTED_SCHEMA_VERSION, "$.schema", `Unsupported schema version \"${value.schema}\".`);
			return { record: null, diagnostics };
		}
		if (value.kind === undefined) {
			report(diagnostics, PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD, "$.kind", "Missing required field \"kind\".");
			return { record: null, diagnostics };
		}
		if (typeof value.kind !== "string" || !PROJECT_MAP_STORE_RECORD_KINDS.includes(value.kind as ProjectMapStoreRecordKind) || value.kind !== kind) {
			invalid(diagnostics, "$.kind", "Record kind does not match the requested kind.");
			return { record: null, diagnostics };
		}
		const fields: Record<ProjectMapStoreRecordKind, readonly string[]> = {
			descriptor: ["schema", "kind", "repository_id", "generation", "epoch", "predecessor", "created_at", "updated_at"],
			claim: ["schema", "kind", "capability_id", "session_id", "acquired_at", "lease"],
			heartbeat: ["schema", "kind", "session_id", "pid", "incarnation", "beat_at"],
			"session-binding": ["schema", "kind", "session_id", "pid", "incarnation", "workspace_root", "bound_at", "launch_nonce"],
			blocker: ["schema", "kind", "capability_id", "blocker_id", "owner", "reason", "raised_by", "raised_at", "resolved_at", "resolution"],
			"contract-proposal": ["schema", "kind", "capability_id", "contract_id", "title", "digest", "proposed_by", "proposed_at", "state", "decided_by", "decided_at", "rationale"],
			"readiness-receipt": ["schema", "kind", "capability_id", "issued_by", "issued_at", "verified", "evidence", "authority"],
			"worktree-binding": ["schema", "kind", "capability_id", "branch", "worktree_root", "session_id", "base_commit", "created_at"],
		};
		const requiredFields: Record<ProjectMapStoreRecordKind, readonly string[]> = {
			descriptor: fields.descriptor,
			claim: fields.claim,
			heartbeat: fields.heartbeat,
			"session-binding": ["schema", "kind", "session_id", "pid", "incarnation", "workspace_root", "bound_at"],
			blocker: ["schema", "kind", "capability_id", "blocker_id", "owner", "reason", "raised_by", "raised_at"],
			"contract-proposal": ["schema", "kind", "capability_id", "contract_id", "title", "digest", "proposed_by", "proposed_at", "state"],
			"readiness-receipt": fields["readiness-receipt"],
			"worktree-binding": fields["worktree-binding"],
		};
		unknownFields(value, fields[kind], diagnostics);
		required(value, requiredFields[kind], diagnostics);
		switch (kind) {
			case "descriptor":
				if (value.repository_id !== undefined && (typeof value.repository_id !== "string" || !SHA256.test(value.repository_id))) invalid(diagnostics, "$.repository_id", "Expected a sha256 repository identity.");
				if (value.generation !== undefined && (!Number.isInteger(value.generation) || (value.generation as number) < 0)) invalid(diagnostics, "$.generation", "Expected a non-negative integer.");
				if (value.epoch !== undefined && (typeof value.epoch !== "string" || !UUID.test(value.epoch))) invalid(diagnostics, "$.epoch", "Expected a UUID.");
				if (value.predecessor !== undefined && value.predecessor !== null && (typeof value.predecessor !== "string" || !SHA256.test(value.predecessor))) invalid(diagnostics, "$.predecessor", "Expected a sha256 digest or null.");
				if (value.created_at !== undefined) instant(value.created_at, "$.created_at", diagnostics);
				if (value.updated_at !== undefined) instant(value.updated_at, "$.updated_at", diagnostics);
				break;
			case "claim":
				if (value.capability_id !== undefined) identifier(value.capability_id, "$.capability_id", diagnostics);
				if (value.session_id !== undefined) identifier(value.session_id, "$.session_id", diagnostics);
				const acquired = value.acquired_at !== undefined && instant(value.acquired_at, "$.acquired_at", diagnostics) ? value.acquired_at as string : undefined;
				if (value.lease !== undefined) validateLease(value.lease, acquired, diagnostics);
				break;
			case "heartbeat":
				if (value.session_id !== undefined) identifier(value.session_id, "$.session_id", diagnostics);
				if (value.pid !== undefined && (!Number.isInteger(value.pid) || (value.pid as number) <= 0)) invalid(diagnostics, "$.pid", "Expected a positive integer.");
				if (value.incarnation !== undefined && (typeof value.incarnation !== "string" || !UUID.test(value.incarnation))) invalid(diagnostics, "$.incarnation", "Expected a UUID.");
				if (value.beat_at !== undefined) instant(value.beat_at, "$.beat_at", diagnostics);
				break;
			case "session-binding":
				if (value.session_id !== undefined) identifier(value.session_id, "$.session_id", diagnostics);
				if (value.pid !== undefined && (!Number.isInteger(value.pid) || (value.pid as number) <= 0)) invalid(diagnostics, "$.pid", "Expected a positive integer.");
				if (value.incarnation !== undefined && (typeof value.incarnation !== "string" || !UUID.test(value.incarnation))) invalid(diagnostics, "$.incarnation", "Expected a UUID.");
				if (value.workspace_root !== undefined) identifier(value.workspace_root, "$.workspace_root", diagnostics);
				if (value.bound_at !== undefined) instant(value.bound_at, "$.bound_at", diagnostics);
				if (value.launch_nonce !== undefined && (typeof value.launch_nonce !== "string" || value.launch_nonce.length === 0)) invalid(diagnostics, "$.launch_nonce", "Expected a non-empty string.");
				break;
			case "blocker":
				if (value.capability_id !== undefined) identifier(value.capability_id, "$.capability_id", diagnostics);
				if (value.blocker_id !== undefined) identifier(value.blocker_id, "$.blocker_id", diagnostics);
				if (value.owner !== undefined) identifier(value.owner, "$.owner", diagnostics);
				if (value.reason !== undefined) identifier(value.reason, "$.reason", diagnostics);
				if (value.raised_by !== undefined) identifier(value.raised_by, "$.raised_by", diagnostics);
				if (value.raised_at !== undefined) instant(value.raised_at, "$.raised_at", diagnostics);
				if (value.resolved_at !== undefined) instant(value.resolved_at, "$.resolved_at", diagnostics);
				if (value.resolution !== undefined) identifier(value.resolution, "$.resolution", diagnostics);
				if (value.resolved_at !== undefined && value.resolution === undefined) report(diagnostics, PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD, "$.resolution", "A resolution is required with resolved_at.");
				if (value.resolution !== undefined && value.resolved_at === undefined) report(diagnostics, PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD, "$.resolved_at", "resolved_at is required with a resolution.");
				break;
			case "contract-proposal":
				if (value.capability_id !== undefined) identifier(value.capability_id, "$.capability_id", diagnostics);
				if (value.contract_id !== undefined) identifier(value.contract_id, "$.contract_id", diagnostics);
				if (value.title !== undefined) identifier(value.title, "$.title", diagnostics);
				if (value.digest !== undefined && (typeof value.digest !== "string" || !SHA256.test(value.digest))) invalid(diagnostics, "$.digest", "Expected a sha256 digest.");
				if (value.proposed_by !== undefined) identifier(value.proposed_by, "$.proposed_by", diagnostics);
				if (value.proposed_at !== undefined) instant(value.proposed_at, "$.proposed_at", diagnostics);
				if (value.state !== "proposed" && value.state !== "accepted" && value.state !== "rejected") invalid(diagnostics, "$.state", "Expected proposed, accepted, or rejected.");
				if (value.state === "proposed") {
					for (const field of ["decided_by", "decided_at", "rationale"] as const) {
						if (value[field] !== undefined) invalid(diagnostics, `$.${field}`, `${field} is forbidden for a proposed contract.`);
					}
				} else if (value.state === "accepted" || value.state === "rejected") {
					if (value.decided_by === undefined) report(diagnostics, PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD, "$.decided_by", "decided_by is required for a decided contract.");
					else identifier(value.decided_by, "$.decided_by", diagnostics);
					if (value.decided_at === undefined) report(diagnostics, PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD, "$.decided_at", "decided_at is required for a decided contract.");
					else instant(value.decided_at, "$.decided_at", diagnostics);
					if (value.rationale === undefined) report(diagnostics, PROJECT_MAP_STORE_DIAGNOSTIC_CODES.MISSING_FIELD, "$.rationale", "rationale is required for a decided contract.");
					else identifier(value.rationale, "$.rationale", diagnostics);
				}
				break;
			case "readiness-receipt":
				if (value.capability_id !== undefined) identifier(value.capability_id, "$.capability_id", diagnostics);
				if (value.issued_by !== undefined) identifier(value.issued_by, "$.issued_by", diagnostics);
				if (value.issued_at !== undefined) instant(value.issued_at, "$.issued_at", diagnostics);
				if (value.verified !== undefined) stringArray(value.verified, "$.verified", diagnostics, true);
				if (value.evidence !== undefined) stringArray(value.evidence, "$.evidence", diagnostics, false);
				if (value.authority !== "none") invalid(diagnostics, "$.authority", "Readiness receipts may not grant authority.");
				break;
			case "worktree-binding":
				if (value.capability_id !== undefined) identifier(value.capability_id, "$.capability_id", diagnostics);
				if (value.branch !== undefined && (typeof value.branch !== "string" || !/^feat\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.branch))) invalid(diagnostics, "$.branch", "Expected a capability branch name.");
				if (value.worktree_root !== undefined && (typeof value.worktree_root !== "string" || !isAbsolute(value.worktree_root) || resolve(value.worktree_root) !== value.worktree_root)) invalid(diagnostics, "$.worktree_root", "Expected an absolute canonical path.");
				if (value.session_id !== undefined) identifier(value.session_id, "$.session_id", diagnostics);
				if (value.base_commit !== undefined && (typeof value.base_commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.base_commit))) invalid(diagnostics, "$.base_commit", "Expected a full SHA-1 or SHA-256 commit id.");
				if (value.created_at !== undefined) instant(value.created_at, "$.created_at", diagnostics);
				break;
		}
		if (diagnostics.length > 0) return { record: null, diagnostics };
		return { record: canonical(kind, value), diagnostics };
	} catch {
		return { record: null, diagnostics: [{ code: PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD, path: "$", message: "Store record validation failed.", severity: "error" }] };
	}
}

export function parseProjectMapStoreValue(kind: ProjectMapStoreRecordKind, text: string): ProjectMapStoreResult {
	try {
		return validateProjectMapStoreValue(kind, JSON.parse(text));
	} catch {
		return { record: null, diagnostics: [{ code: PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_JSON, path: "$", message: "Invalid JSON store record.", severity: "error" }] };
	}
}

export function readProjectMapStoreValueFile(kind: ProjectMapStoreRecordKind, path: string): ProjectMapStoreResult {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { record: null, diagnostics: [{ code: PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, path: "$", message: "Store record could not be read.", severity: "error" }] };
	}
	return parseProjectMapStoreValue(kind, text);
}

export function canonicalizeProjectMapStoreValue(kind: ProjectMapStoreRecordKind, value: unknown): ProjectMapStoreResult {
	return validateProjectMapStoreValue(kind, value);
}

export function serializeProjectMapStoreValue(kind: ProjectMapStoreRecordKind, value: unknown): ProjectMapStoreResult<string> {
	const result = canonicalizeProjectMapStoreValue(kind, value);
	return result.record === null ? { record: null, diagnostics: result.diagnostics } : { record: `${JSON.stringify(result.record, null, 2)}\n`, diagnostics: result.diagnostics };
}
