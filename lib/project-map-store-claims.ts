import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFileAtomicallySync } from "./agent-profiles.ts";
import {
	acquireProjectMapStoreLock,
	readProjectMapStoreDescriptor,
	releaseProjectMapStoreLock,
} from "./project-map-store.ts";
import {
	PROJECT_MAP_STORE_DIAGNOSTIC_CODES,
	parseProjectMapStoreValue,
	serializeProjectMapStoreValue,
	type ProjectMapStoreClaimV1,
	type ProjectMapStoreDiagnostic,
} from "./project-map-store-schema.ts";
import { isIsoInstant } from "./shell-project-map-schema.ts";

export const PROJECT_MAP_STORE_CLAIM_RENEWAL_INTERVAL_MS = 10_000;
export const PROJECT_MAP_STORE_CLAIM_TTL_MS = 60_000;

export type ProjectMapClaimStatus = "free" | "live" | "stale" | "corrupted" | "unreadable";

export interface ReadProjectMapClaimOptions {
	root: string;
	capabilityId: string;
	now: string;
}

export interface ProjectMapClaimReadResult {
	claim: ProjectMapStoreClaimV1 | null;
	status: ProjectMapClaimStatus;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapClaimMutationOptions extends ReadProjectMapClaimOptions {
	sessionId: string;
}

export interface ProjectMapClaimMutationResult {
	claim: ProjectMapStoreClaimV1 | null;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapClaimReleaseResult {
	released: boolean;
	diagnostics: ProjectMapStoreDiagnostic[];
}

function claimPath(root: string, capabilityId: string): string {
	const name = createHash("sha256").update(capabilityId).digest("hex");
	return join(root, "claims", `${name}.json`);
}

function diagnostic(code: ProjectMapStoreDiagnostic["code"], message: string, path = "$"): ProjectMapStoreDiagnostic {
	return { code, path, message, severity: "error" };
}

function invalidNowDiagnostic(): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD, "Expected an ISO-8601 instant.", "$.now");
}

function claimDiagnostic(code: ProjectMapStoreDiagnostic["code"], message: string): ProjectMapStoreDiagnostic {
	return diagnostic(code, message);
}

function nextInstant(now: string, milliseconds: number): string {
	return new Date(Date.parse(now) + milliseconds).toISOString();
}

function makeClaim(capabilityId: string, sessionId: string, now: string): ProjectMapStoreClaimV1 {
	return {
		schema: "gentle-shell.project-map-store/v1",
		kind: "claim",
		capability_id: capabilityId,
		session_id: sessionId,
		acquired_at: now,
		lease: {
			renewal_after: nextInstant(now, PROJECT_MAP_STORE_CLAIM_RENEWAL_INTERVAL_MS),
			renew_by: nextInstant(now, PROJECT_MAP_STORE_CLAIM_TTL_MS),
		},
	};
}

function classifyProjectMapClaim(options: ReadProjectMapClaimOptions): ProjectMapClaimReadResult {
	let bytes: string;
	try {
		bytes = readFileSync(claimPath(options.root, options.capabilityId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { claim: null, status: "free", diagnostics: [] };
		return {
			claim: null,
			status: "unreadable",
			diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Claim record could not be read.")],
		};
	}
	const parsed = parseProjectMapStoreValue("claim", bytes);
	if (parsed.record === null) {
		return {
			claim: null,
			status: "corrupted",
			diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Claim record is corrupted."), ...parsed.diagnostics],
		};
	}
	const claim = parsed.record as ProjectMapStoreClaimV1;
	if (claim.capability_id !== options.capabilityId) {
		return {
			claim: null,
			status: "corrupted",
			diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Claim capability id does not match the requested capability.", "$.capability_id")],
		};
	}
	const canonical = serializeProjectMapStoreValue("claim", claim);
	if (canonical.record === null || canonical.record !== bytes) {
		return {
			claim: null,
			status: "corrupted",
			diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Claim record is not in canonical form.")],
		};
	}
	return {
		claim,
		status: Date.parse(options.now) < Date.parse(claim.lease.renew_by) ? "live" : "stale",
		diagnostics: [],
	};
}

function readyStoreDiagnostics(root: string): ProjectMapStoreDiagnostic[] {
	const descriptor = readProjectMapStoreDescriptor(root);
	if (descriptor.status === "ready") return [];
	if (descriptor.status === "missing") {
		return [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store has to be initialized first.")];
	}
	return [
		claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store is not ready for claim operations."),
		...descriptor.diagnostics,
	];
}

function writeClaim(root: string, capabilityId: string, claim: ProjectMapStoreClaimV1): ProjectMapClaimMutationResult {
	const serialized = serializeProjectMapStoreValue("claim", claim);
	if (serialized.record === null) return { claim: null, diagnostics: serialized.diagnostics };
	try {
		mkdirSync(join(root, "claims"), { recursive: true, mode: 0o700 });
		writeJsonFileAtomicallySync(claimPath(root, capabilityId), serialized.record);
		return { claim, diagnostics: [] };
	} catch {
		return {
			claim: null,
			diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Claim record could not be written.")],
		};
	}
}

function withClaimLock<T extends { diagnostics: ProjectMapStoreDiagnostic[] }>(
	options: ReadProjectMapClaimOptions,
	unavailable: (diagnostics: ProjectMapStoreDiagnostic[]) => T,
	mutate: () => T,
): T {
	if (!isIsoInstant(options.now)) return unavailable([invalidNowDiagnostic()]);
	const beforeLock = readyStoreDiagnostics(options.root);
	if (beforeLock.length > 0) return unavailable(beforeLock);
	const acquired = acquireProjectMapStoreLock(options.root, options.now);
	if (acquired.handle === null) return unavailable(acquired.diagnostics);
	let result: T;
	try {
		const underLock = readyStoreDiagnostics(options.root);
		result = underLock.length > 0 ? unavailable(underLock) : mutate();
	} catch {
		result = unavailable([claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Claim operation could not be completed.")]);
	}
	const releaseDiagnostics = releaseProjectMapStoreLock(options.root, acquired.handle);
	if (releaseDiagnostics.length > 0) result.diagnostics.push(...releaseDiagnostics.map((entry) => ({ ...entry, severity: "warning" as const })));
	return result;
}

export function readProjectMapClaim(options: ReadProjectMapClaimOptions): ProjectMapClaimReadResult {
	try {
		if (!isIsoInstant(options.now)) return { claim: null, status: "unreadable", diagnostics: [invalidNowDiagnostic()] };
		return classifyProjectMapClaim(options);
	} catch {
		return {
			claim: null,
			status: "unreadable",
			diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Claim record could not be read.")],
		};
	}
}

export function acquireProjectMapClaim(options: ProjectMapClaimMutationOptions): ProjectMapClaimMutationResult {
	return withClaimLock(options, (diagnostics) => ({ claim: null, diagnostics }), () => {
		const current = classifyProjectMapClaim(options);
		if (current.status === "corrupted" || current.status === "unreadable") return { claim: null, diagnostics: current.diagnostics };
		if (current.status === "live") {
			return { claim: null, diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_HELD, "Capability claim is held by a live session.")] };
		}
		const claim = makeClaim(options.capabilityId, options.sessionId, options.now);
		const written = writeClaim(options.root, options.capabilityId, claim);
		if (written.claim === null || current.status !== "stale" || current.claim === null) return written;
		return {
			claim: written.claim,
			diagnostics: [{
				code: PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STALE_CLAIM_RECOVERED,
				path: "$",
				message: `Recovered stale claim from session "${current.claim.session_id}" with renew_by "${current.claim.lease.renew_by}".`,
				severity: "warning",
			}],
		};
	});
}

export function renewProjectMapClaim(options: ProjectMapClaimMutationOptions): ProjectMapClaimMutationResult {
	return withClaimLock(options, (diagnostics) => ({ claim: null, diagnostics }), () => {
		const current = classifyProjectMapClaim(options);
		if (current.status === "corrupted" || current.status === "unreadable") return { claim: null, diagnostics: current.diagnostics };
		if (current.status === "free") return { claim: null, diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_ABSENT, "Capability claim is absent.")] };
		if (current.status === "stale") return { claim: null, diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_EXPIRED, "Capability claim has expired and must be re-acquired.")] };
		if (current.claim === null || current.claim.session_id !== options.sessionId) {
			return { claim: null, diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_NOT_HELD, "Capability claim is not held by this session.")] };
		}
		if (Date.parse(options.now) < Date.parse(current.claim.lease.renewal_after)) {
			return { claim: null, diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.RENEWAL_TOO_EARLY, "Claim renewal cadence is not yet open.")] };
		}
		return writeClaim(options.root, options.capabilityId, {
			...current.claim,
			lease: {
				renewal_after: nextInstant(options.now, PROJECT_MAP_STORE_CLAIM_RENEWAL_INTERVAL_MS),
				renew_by: nextInstant(options.now, PROJECT_MAP_STORE_CLAIM_TTL_MS),
			},
		});
	});
}

export function releaseProjectMapClaim(options: ProjectMapClaimMutationOptions): ProjectMapClaimReleaseResult {
	return withClaimLock(options, (diagnostics) => ({ released: false, diagnostics }), () => {
		const current = classifyProjectMapClaim(options);
		if (current.status === "corrupted" || current.status === "unreadable") return { released: false, diagnostics: current.diagnostics };
		if (current.status === "free") return { released: false, diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_ABSENT, "Capability claim is absent.")] };
		if (current.claim === null || current.claim.session_id !== options.sessionId) {
			return { released: false, diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_NOT_HELD, "Capability claim is not held by this session.")] };
		}
		try {
			unlinkSync(claimPath(options.root, options.capabilityId));
			return { released: true, diagnostics: [] };
		} catch {
			return {
				released: false,
				diagnostics: [claimDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Claim record could not be released.")],
			};
		}
	});
}
