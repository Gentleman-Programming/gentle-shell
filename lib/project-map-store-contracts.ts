import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
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
	type ProjectMapStoreContractProposalV1,
	type ProjectMapStoreDiagnostic,
} from "./project-map-store-schema.ts";
import { isIsoInstant } from "./shell-project-map-schema.ts";

export type ProjectMapStoreContractStatus = "free" | "proposed" | "accepted" | "rejected" | "corrupted" | "unreadable";

export interface ReadProjectMapContractOptions {
	root: string;
	capabilityId: string;
	contractId: string;
}

export interface ProposeProjectMapContractOptions extends ReadProjectMapContractOptions {
	title: string;
	digest: string;
	sessionId: string;
	now: string;
}

export interface DecideProjectMapContractOptions extends ReadProjectMapContractOptions {
	decision: "accepted" | "rejected";
	rationale: string;
	sessionId: string;
	now: string;
}

export interface ListProjectMapContractsOptions {
	root: string;
	capabilityId: string;
	includeDecided: boolean;
}

export interface ProjectMapContractReadResult {
	contract: ProjectMapStoreContractProposalV1 | null;
	status: ProjectMapStoreContractStatus;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapContractMutationResult {
	contract: ProjectMapStoreContractProposalV1 | null;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapContractListResult {
	contracts: ProjectMapStoreContractProposalV1[];
	diagnostics: ProjectMapStoreDiagnostic[];
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function contractDirectory(root: string, capabilityId: string): string {
	return join(root, "contracts", digest(capabilityId));
}

function contractPath(root: string, capabilityId: string, contractId: string): string {
	return join(contractDirectory(root, capabilityId), `${digest(contractId)}.json`);
}

function diagnostic(code: ProjectMapStoreDiagnostic["code"], message: string, path = "$"): ProjectMapStoreDiagnostic {
	return { code, path, message, severity: "error" };
}

function contractDiagnostic(code: ProjectMapStoreDiagnostic["code"], message: string): ProjectMapStoreDiagnostic {
	return diagnostic(code, message);
}

function invalidNowDiagnostic(): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD, "Expected an ISO-8601 instant.", "$.now");
}

function readyStoreDiagnostics(root: string): ProjectMapStoreDiagnostic[] {
	const descriptor = readProjectMapStoreDescriptor(root);
	if (descriptor.status === "ready") return [];
	if (descriptor.status === "missing") {
		return [contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store has to be initialized first.")];
	}
	return [
		contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store is not ready for contract operations."),
		...descriptor.diagnostics,
	];
}

function classifyContract(path: string, capabilityId: string, contractId?: string): ProjectMapContractReadResult {
	let raw: Buffer;
	try {
		raw = readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contract: null, status: "free", diagnostics: [] };
		return {
			contract: null,
			status: "unreadable",
			diagnostics: [contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Contract record could not be read.")],
		};
	}
	const parsed = parseProjectMapStoreValue("contract-proposal", raw.toString("utf8"));
	if (parsed.record === null) {
		return {
			contract: null,
			status: "corrupted",
			diagnostics: [contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Contract record is corrupted."), ...parsed.diagnostics],
		};
	}
	const contract = parsed.record as ProjectMapStoreContractProposalV1;
	if (contract.capability_id !== capabilityId) {
		return {
			contract: null,
			status: "corrupted",
			diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Contract capability id does not match the requested capability.", "$.capability_id")],
		};
	}
	if (contractId !== undefined && contract.contract_id !== contractId) {
		return {
			contract: null,
			status: "corrupted",
			diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Contract id does not match the requested contract.", "$.contract_id")],
		};
	}
	const canonical = serializeProjectMapStoreValue("contract-proposal", contract);
	// Raw bytes, not decoded text: an invalid UTF-8 byte that decodes to the same character would
	// otherwise pass a text comparison while the file on disk is no longer the canonical record.
	if (canonical.record === null || !raw.equals(Buffer.from(canonical.record, "utf8"))) {
		return {
			contract: null,
			status: "corrupted",
			diagnostics: [contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Contract record is not in canonical form.")],
		};
	}
	return { contract, status: contract.state, diagnostics: [] };
}

function writeContract(root: string, capabilityId: string, contract: ProjectMapStoreContractProposalV1): ProjectMapContractMutationResult {
	const serialized = serializeProjectMapStoreValue("contract-proposal", contract);
	if (serialized.record === null) return { contract: null, diagnostics: serialized.diagnostics };
	try {
		mkdirSync(contractDirectory(root, capabilityId), { recursive: true, mode: 0o700 });
		writeJsonFileAtomicallySync(contractPath(root, capabilityId, contract.contract_id), serialized.record);
		return { contract, diagnostics: [] };
	} catch {
		return {
			contract: null,
			diagnostics: [contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Contract record could not be written.")],
		};
	}
}

function withContractLock<T extends { diagnostics: ProjectMapStoreDiagnostic[] }>(
	options: { root: string; now: string },
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
		result = unavailable([contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Contract operation could not be completed.")]);
	}
	const releaseDiagnostics = releaseProjectMapStoreLock(options.root, acquired.handle);
	if (releaseDiagnostics.length > 0) result.diagnostics.push(...releaseDiagnostics.map((entry) => ({ ...entry, severity: "warning" as const })));
	return result;
}

function compareContracts(left: ProjectMapStoreContractProposalV1, right: ProjectMapStoreContractProposalV1): number {
	const difference = Date.parse(left.proposed_at) - Date.parse(right.proposed_at);
	if (Number.isFinite(difference) && difference !== 0) return difference;
	return left.contract_id < right.contract_id ? -1 : left.contract_id > right.contract_id ? 1 : 0;
}

export function readProjectMapContract(options: ReadProjectMapContractOptions): ProjectMapContractReadResult {
	try {
		return classifyContract(contractPath(options.root, options.capabilityId, options.contractId), options.capabilityId, options.contractId);
	} catch {
		return {
			contract: null,
			status: "unreadable",
			diagnostics: [contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Contract record could not be read.")],
		};
	}
}

export function proposeProjectMapContract(options: ProposeProjectMapContractOptions): ProjectMapContractMutationResult {
	return withContractLock(options, (diagnostics) => ({ contract: null, diagnostics }), () => {
		const current = classifyContract(contractPath(options.root, options.capabilityId, options.contractId), options.capabilityId, options.contractId);
		if (current.status === "corrupted" || current.status === "unreadable") return { contract: null, diagnostics: current.diagnostics };
		if (current.status !== "free") {
			return { contract: null, diagnostics: [contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CONTRACT_EXISTS, "Contract already exists.")] };
		}
		return writeContract(options.root, options.capabilityId, {
			schema: "gentle-shell.project-map-store/v1",
			kind: "contract-proposal",
			capability_id: options.capabilityId,
			contract_id: options.contractId,
			title: options.title,
			digest: options.digest,
			proposed_by: options.sessionId,
			proposed_at: options.now,
			state: "proposed",
		});
	});
}

export function decideProjectMapContract(options: DecideProjectMapContractOptions): ProjectMapContractMutationResult {
	return withContractLock(options, (diagnostics) => ({ contract: null, diagnostics }), () => {
		const current = classifyContract(contractPath(options.root, options.capabilityId, options.contractId), options.capabilityId, options.contractId);
		if (current.status === "corrupted" || current.status === "unreadable") return { contract: null, diagnostics: current.diagnostics };
		if (current.status === "free") {
			return { contract: null, diagnostics: [contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CONTRACT_ABSENT, "Contract is absent.")] };
		}
		if (current.status !== "proposed" || current.contract === null) {
			return { contract: null, diagnostics: [contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CONTRACT_ALREADY_DECIDED, "Contract has already been decided.")] };
		}
		return writeContract(options.root, options.capabilityId, {
			...current.contract,
			state: options.decision,
			decided_by: options.sessionId,
			decided_at: options.now,
			rationale: options.rationale,
		});
	});
}

export function listProjectMapContracts(options: ListProjectMapContractsOptions): ProjectMapContractListResult {
	let entries: string[];
	try {
		entries = readdirSync(contractDirectory(options.root, options.capabilityId));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contracts: [], diagnostics: [] };
		return { contracts: [], diagnostics: [contractDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Contract directory could not be read.")] };
	}
	const contracts: ProjectMapStoreContractProposalV1[] = [];
	const diagnostics: ProjectMapStoreDiagnostic[] = [];
	for (const entry of entries.sort()) {
		if (entry.endsWith(".tmp")) continue;
		const current = classifyContract(join(contractDirectory(options.root, options.capabilityId), entry), options.capabilityId);
		if (current.status === "corrupted" || current.status === "unreadable" || current.contract === null) {
			diagnostics.push(...current.diagnostics);
			continue;
		}
		if (`${digest(current.contract.contract_id)}.json` !== entry) {
			diagnostics.push(diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Contract id does not match its record path.", "$.contract_id"));
			continue;
		}
		if (options.includeDecided || current.status === "proposed") contracts.push(current.contract);
	}
	contracts.sort(compareContracts);
	return { contracts, diagnostics };
}
