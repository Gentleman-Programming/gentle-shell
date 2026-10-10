import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listProjectMapStoreBlockers } from "./project-map-store-blockers.ts";
import { readProjectMapClaim } from "./project-map-store-claims.ts";
import { listProjectMapContracts } from "./project-map-store-contracts.ts";
import { readProjectMapStoreHeartbeat } from "./project-map-store-heartbeats.ts";
import { readProjectMapStoreReadinessReceipts } from "./project-map-store-receipts.ts";
import { readProjectMapStoreDescriptor } from "./project-map-store.ts";
import {
	PROJECT_MAP_STORE_DIAGNOSTIC_CODES,
	parseProjectMapStoreValue,
	serializeProjectMapStoreValue,
	type ProjectMapStoreClaimV1,
} from "./project-map-store-schema.ts";
import { isIsoInstant, readProjectMapFile, type ProjectMapV1 } from "./shell-project-map-schema.ts";

export const PROJECT_MAP_LEAD_CAPABILITY_ID = "__lead";

type Diagnostic = { code: string; path: string; message: string; severity: "error" | "warning" };
type ConflictCode = "unknown-capability" | "undeclared-surfaces" | "unavailable-peer" | "reserved-capability-declared" | "stale-generation";
type Lease = { renewal_after: string; renew_by: string };

interface SatelliteClaim {
	claim: ProjectMapStoreClaimV1;
	status: "live" | "stale";
}

function storeDiagnostic(code: string, message: string, path = "$"): Diagnostic {
	return { code, path, message, severity: "error" };
}

function claimFileName(capabilityId: string): string {
	return `${createHash("sha256").update(capabilityId).digest("hex")}.json`;
}

function conflict(code: ConflictCode, message: string, capabilityId?: string, sessionId?: string): { code: ConflictCode; capabilityId?: string; sessionId?: string; message: string } {
	return {
		code,
		...(capabilityId === undefined ? {} : { capabilityId }),
		...(sessionId === undefined ? {} : { sessionId }),
		message,
	};
}

function mapDeclaresReservedCapability(path: string): boolean {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as { capabilities?: unknown };
		return Array.isArray(value.capabilities) && value.capabilities.some((capability) => typeof capability === "object" && capability !== null && (capability as { id?: unknown }).id === PROJECT_MAP_LEAD_CAPABILITY_ID);
	} catch {
		return false;
	}
}

function listSatelliteClaims(root: string, now: string): { claims: SatelliteClaim[]; diagnostics: Diagnostic[] } {
	const directory = join(root, "claims");
	let entries: string[];
	try {
		entries = readdirSync(directory).filter((entry) => !entry.endsWith(".tmp")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { claims: [], diagnostics: [] };
		return { claims: [], diagnostics: [storeDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Claim directory could not be read.")] };
	}
	const claims: SatelliteClaim[] = [];
	const diagnostics: Diagnostic[] = [];
	for (const entry of entries) {
		let raw: Buffer;
		try {
			raw = readFileSync(join(directory, entry));
		} catch {
			diagnostics.push(storeDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, `Claim record "${entry}" could not be read.`));
			continue;
		}
		const parsed = parseProjectMapStoreValue("claim", raw.toString("utf8"));
		if (parsed.record === null) {
			diagnostics.push(storeDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, `Claim record "${entry}" is corrupted."`), ...parsed.diagnostics);
			continue;
		}
		const claim = parsed.record as ProjectMapStoreClaimV1;
		const canonical = serializeProjectMapStoreValue("claim", claim);
		if (canonical.record === null || !raw.equals(Buffer.from(canonical.record, "utf8")) || entry !== claimFileName(claim.capability_id)) {
			diagnostics.push(storeDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, `Claim record "${entry}" is not canonical or does not match its path.`));
			continue;
		}
		if (claim.capability_id === PROJECT_MAP_LEAD_CAPABILITY_ID) continue;
		claims.push({ claim, status: Date.parse(now) < Date.parse(claim.lease.renew_by) ? "live" : "stale" });
	}
	claims.sort((left, right) => left.claim.capability_id < right.claim.capability_id ? -1 : left.claim.capability_id > right.claim.capability_id ? 1 : 0);
	return { claims, diagnostics };
}

function readLead(root: string, now: string): { capabilityId: string; sessionId: string | null; lease: Lease | null; status: "free" | "live" | "stale" | "corrupted"; diagnostics: Diagnostic[] } {
	const current = readProjectMapClaim({ root, capabilityId: PROJECT_MAP_LEAD_CAPABILITY_ID, now });
	if (current.claim === null || current.status === "corrupted" || current.status === "unreadable") {
		return {
			capabilityId: PROJECT_MAP_LEAD_CAPABILITY_ID,
			sessionId: null,
			lease: null,
			status: current.status === "free" ? "free" : "corrupted",
			diagnostics: current.diagnostics,
		};
	}
	return {
		capabilityId: PROJECT_MAP_LEAD_CAPABILITY_ID,
		sessionId: current.claim.session_id,
		lease: current.claim.lease,
		status: current.status,
		diagnostics: current.diagnostics,
	};
}

function projectCapabilities(root: string, map: ProjectMapV1, satellites: SatelliteClaim[], now: string): { capabilities: Array<{ capabilityId: string; dependencyReady: boolean; complete: boolean; openBlockers: number; proposedContracts: number; nextSafeAction: "claim" | "wait-for-dependency" | "resolve-blocker" | "decide-contract" | "integrate" | "work" | "done" | "blocked" }>; diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];
	const records = new Map<string, { receipts: boolean; openBlockers: number; proposedContracts: number }>();
	for (const capability of map.capabilities) {
		const receipts = readProjectMapStoreReadinessReceipts({ root, capabilityId: capability.id, limit: 1 });
		const blockers = listProjectMapStoreBlockers({ root, capabilityId: capability.id, includeResolved: false });
		const contracts = listProjectMapContracts({ root, capabilityId: capability.id, includeDecided: false });
		diagnostics.push(...receipts.diagnostics, ...blockers.diagnostics, ...contracts.diagnostics);
		records.set(capability.id, { receipts: receipts.receipts.length > 0, openBlockers: blockers.blockers.length, proposedContracts: contracts.contracts.length });
	}
	const byId = new Map(map.capabilities.map((capability) => [capability.id, capability]));
	const liveClaims = new Set(satellites.filter((satellite) => satellite.status === "live").map((satellite) => satellite.claim.capability_id));
	return {
		capabilities: map.capabilities.map((capability) => {
			const record = records.get(capability.id) as { receipts: boolean; openBlockers: number; proposedContracts: number };
			const dependencyReady = capability.dependsOn.every((dependencyId) => {
				const dependency = byId.get(dependencyId);
				return dependency !== undefined && dependency.state !== "blocked" && records.get(dependencyId)?.receipts === true;
			});
			const complete = record.receipts;
			const nextSafeAction = capability.state === "done" ? "done"
				: capability.state === "blocked" ? "blocked"
					: record.openBlockers > 0 ? "resolve-blocker"
						: !dependencyReady ? "wait-for-dependency"
							: record.proposedContracts > 0 ? "decide-contract"
								: complete ? "integrate"
									: liveClaims.has(capability.id) ? "work"
										: "claim";
			return { capabilityId: capability.id, dependencyReady, complete, openBlockers: record.openBlockers, proposedContracts: record.proposedContracts, nextSafeAction };
		}),
		diagnostics,
	};
}

export function readProjectMapCoordinationState(options: { root: string; mapPath: string; now: string; expectedGeneration?: number }): {
	map: ProjectMapV1 | null;
	lead: { capabilityId: string; sessionId: string | null; lease: Lease | null; status: "free" | "live" | "stale" | "corrupted" };
	satellites: Array<{ capabilityId: string; sessionId: string; lease: Lease; status: "live" | "stale"; heartbeat: "fresh" | "stale" | "missing" | "corrupted" }>;
	conflicts: Array<{ code: ConflictCode; capabilityId?: string; sessionId?: string; message: string }>;
	capabilities: Array<{ capabilityId: string; dependencyReady: boolean; complete: boolean; openBlockers: number; proposedContracts: number; nextSafeAction: "claim" | "wait-for-dependency" | "resolve-blocker" | "decide-contract" | "integrate" | "work" | "done" | "blocked" }>;
	diagnostics: Diagnostic[];
} {
	const mapRead = readProjectMapFile(options.mapPath);
	const descriptor = readProjectMapStoreDescriptor(options.root);
	const diagnostics: Diagnostic[] = [...mapRead.diagnostics, ...descriptor.diagnostics];
	// An instant that cannot be parsed would make every lease look stale, so the time-dependent
	// parts are refused instead of being reported wrong.
	if (!isIsoInstant(options.now)) {
		diagnostics.push(storeDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD, "Expected an ISO-8601 instant.", "$.now"));
		return {
			map: mapRead.map,
			lead: { capabilityId: PROJECT_MAP_LEAD_CAPABILITY_ID, sessionId: null, lease: null, status: "corrupted" },
			satellites: [],
			conflicts: [],
			capabilities: [],
			diagnostics,
		};
	}
	if (descriptor.status !== "ready") {
		if (descriptor.diagnostics.length === 0) diagnostics.push(storeDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store descriptor is not ready."));
		return {
			map: mapRead.map,
			lead: { capabilityId: PROJECT_MAP_LEAD_CAPABILITY_ID, sessionId: null, lease: null, status: "corrupted" },
			satellites: [],
			conflicts: [],
			capabilities: [],
			diagnostics,
		};
	}
	const lead = readLead(options.root, options.now);
	diagnostics.push(...lead.diagnostics);
	const listed = listSatelliteClaims(options.root, options.now);
	diagnostics.push(...listed.diagnostics);
	const satellites: Array<{ capabilityId: string; sessionId: string; lease: Lease; status: "live" | "stale"; heartbeat: "fresh" | "stale" | "missing" | "corrupted" }> = [];
	const conflicts: Array<{ code: ConflictCode; capabilityId?: string; sessionId?: string; message: string }> = [];
	if (mapDeclaresReservedCapability(options.mapPath)) {
		conflicts.push(conflict("reserved-capability-declared", `Map declares reserved capability "${PROJECT_MAP_LEAD_CAPABILITY_ID}".`, PROJECT_MAP_LEAD_CAPABILITY_ID));
	}
	if (options.expectedGeneration !== undefined && descriptor.descriptor !== null && descriptor.descriptor.generation !== options.expectedGeneration) {
		conflicts.push(conflict("stale-generation", `Store generation is ${descriptor.descriptor.generation}; expected ${options.expectedGeneration}.`));
	}
	for (const satellite of listed.claims) {
		const heartbeat = readProjectMapStoreHeartbeat({ root: options.root, sessionId: satellite.claim.session_id, now: options.now });
		const heartbeatStatus = heartbeat.status === "fresh" || heartbeat.status === "stale" || heartbeat.status === "free" ? heartbeat.status === "free" ? "missing" : heartbeat.status : "corrupted";
		diagnostics.push(...heartbeat.diagnostics);
		satellites.push({
			capabilityId: satellite.claim.capability_id,
			sessionId: satellite.claim.session_id,
			lease: satellite.claim.lease,
			status: satellite.status,
			heartbeat: heartbeatStatus,
		});
		const mapped = mapRead.map?.capabilities.find((capability) => capability.id === satellite.claim.capability_id);
		if (mapped === undefined) conflicts.push(conflict("unknown-capability", `Claim for unknown capability "${satellite.claim.capability_id}" is held by session "${satellite.claim.session_id}" until "${satellite.claim.lease.renew_by}".`, satellite.claim.capability_id, satellite.claim.session_id));
		else if (mapped.surfaces.length === 0) conflicts.push(conflict("undeclared-surfaces", `Claim for capability "${satellite.claim.capability_id}" with no declared surfaces is held by session "${satellite.claim.session_id}" until "${satellite.claim.lease.renew_by}".`, satellite.claim.capability_id, satellite.claim.session_id));
		if (satellite.status === "live" && heartbeatStatus !== "fresh") conflicts.push(conflict("unavailable-peer", `Live claim for capability "${satellite.claim.capability_id}" is held by session "${satellite.claim.session_id}" until "${satellite.claim.lease.renew_by}", but its heartbeat is ${heartbeatStatus}.`, satellite.claim.capability_id, satellite.claim.session_id));
	}
	if (mapRead.map === null) {
		return { map: null, lead: { capabilityId: lead.capabilityId, sessionId: lead.sessionId, lease: lead.lease, status: lead.status }, satellites, conflicts, capabilities: [], diagnostics };
	}
	const projected = projectCapabilities(options.root, mapRead.map, listed.claims, options.now);
	diagnostics.push(...projected.diagnostics);
	return {
		map: mapRead.map,
		lead: { capabilityId: lead.capabilityId, sessionId: lead.sessionId, lease: lead.lease, status: lead.status },
		satellites,
		conflicts,
		capabilities: projected.capabilities,
		diagnostics,
	};
}
