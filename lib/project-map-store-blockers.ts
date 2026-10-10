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
	type ProjectMapStoreBlockerV1,
	type ProjectMapStoreDiagnostic,
} from "./project-map-store-schema.ts";
import { isIsoInstant } from "./shell-project-map-schema.ts";

export type ProjectMapStoreBlockerStatus = "free" | "open" | "resolved" | "corrupted" | "unreadable";

export interface ReadProjectMapStoreBlockerOptions {
	root: string;
	capabilityId: string;
	blockerId: string;
}

export interface RaiseProjectMapStoreBlockerOptions extends ReadProjectMapStoreBlockerOptions {
	owner: string;
	reason: string;
	sessionId: string;
	now: string;
}

export interface ResolveProjectMapStoreBlockerOptions extends ReadProjectMapStoreBlockerOptions {
	resolution: string;
	now: string;
}

export interface ListProjectMapStoreBlockersOptions {
	root: string;
	capabilityId: string;
	includeResolved: boolean;
}

export interface ProjectMapStoreBlockerReadResult {
	blocker: ProjectMapStoreBlockerV1 | null;
	status: ProjectMapStoreBlockerStatus;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapStoreBlockerMutationResult {
	blocker: ProjectMapStoreBlockerV1 | null;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapStoreBlockerListResult {
	blockers: ProjectMapStoreBlockerV1[];
	diagnostics: ProjectMapStoreDiagnostic[];
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function blockerDirectory(root: string, capabilityId: string): string {
	return join(root, "blockers", digest(capabilityId));
}

function blockerPath(root: string, capabilityId: string, blockerId: string): string {
	return join(blockerDirectory(root, capabilityId), `${digest(blockerId)}.json`);
}

function diagnostic(code: ProjectMapStoreDiagnostic["code"], message: string, path = "$"): ProjectMapStoreDiagnostic {
	return { code, path, message, severity: "error" };
}

function blockerDiagnostic(code: ProjectMapStoreDiagnostic["code"], message: string): ProjectMapStoreDiagnostic {
	return diagnostic(code, message);
}

function invalidNowDiagnostic(): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD, "Expected an ISO-8601 instant.", "$.now");
}

function readyStoreDiagnostics(root: string): ProjectMapStoreDiagnostic[] {
	const descriptor = readProjectMapStoreDescriptor(root);
	if (descriptor.status === "ready") return [];
	if (descriptor.status === "missing") {
		return [blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store has to be initialized first.")];
	}
	return [
		blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store is not ready for blocker operations."),
		...descriptor.diagnostics,
	];
}

function classifyBlocker(path: string, capabilityId: string, blockerId?: string): ProjectMapStoreBlockerReadResult {
	let bytes: string;
	try {
		bytes = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { blocker: null, status: "free", diagnostics: [] };
		return {
			blocker: null,
			status: "unreadable",
			diagnostics: [blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Blocker record could not be read.")],
		};
	}
	const parsed = parseProjectMapStoreValue("blocker", bytes);
	if (parsed.record === null) {
		return {
			blocker: null,
			status: "corrupted",
			diagnostics: [blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Blocker record is corrupted."), ...parsed.diagnostics],
		};
	}
	const blocker = parsed.record as ProjectMapStoreBlockerV1;
	if (blocker.capability_id !== capabilityId) {
		return {
			blocker: null,
			status: "corrupted",
			diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Blocker capability id does not match the requested capability.", "$.capability_id")],
		};
	}
	if (blockerId !== undefined && blocker.blocker_id !== blockerId) {
		return {
			blocker: null,
			status: "corrupted",
			diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Blocker id does not match the requested blocker.", "$.blocker_id")],
		};
	}
	const canonical = serializeProjectMapStoreValue("blocker", blocker);
	if (canonical.record === null || canonical.record !== bytes) {
		return {
			blocker: null,
			status: "corrupted",
			diagnostics: [blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Blocker record is not in canonical form.")],
		};
	}
	return { blocker, status: blocker.resolved_at === undefined ? "open" : "resolved", diagnostics: [] };
}

function writeBlocker(root: string, capabilityId: string, blocker: ProjectMapStoreBlockerV1): ProjectMapStoreBlockerMutationResult {
	const serialized = serializeProjectMapStoreValue("blocker", blocker);
	if (serialized.record === null) return { blocker: null, diagnostics: serialized.diagnostics };
	try {
		mkdirSync(blockerDirectory(root, capabilityId), { recursive: true, mode: 0o700 });
		writeJsonFileAtomicallySync(blockerPath(root, capabilityId, blocker.blocker_id), serialized.record);
		return { blocker, diagnostics: [] };
	} catch {
		return {
			blocker: null,
			diagnostics: [blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Blocker record could not be written.")],
		};
	}
}

function withBlockerLock<T extends { diagnostics: ProjectMapStoreDiagnostic[] }>(
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
		result = unavailable([blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Blocker operation could not be completed.")]);
	}
	const releaseDiagnostics = releaseProjectMapStoreLock(options.root, acquired.handle);
	if (releaseDiagnostics.length > 0) result.diagnostics.push(...releaseDiagnostics.map((entry) => ({ ...entry, severity: "warning" as const })));
	return result;
}

function compareBlockers(left: ProjectMapStoreBlockerV1, right: ProjectMapStoreBlockerV1): number {
	const difference = Date.parse(left.raised_at) - Date.parse(right.raised_at);
	if (Number.isFinite(difference) && difference !== 0) return difference;
	// Code-unit order rather than localeCompare: a tie-break that changes with the runtime
	// locale is a tie-break that reports a different order on a different machine.
	return left.blocker_id < right.blocker_id ? -1 : left.blocker_id > right.blocker_id ? 1 : 0;
}

export function readProjectMapStoreBlocker(options: ReadProjectMapStoreBlockerOptions): ProjectMapStoreBlockerReadResult {
	try {
		return classifyBlocker(blockerPath(options.root, options.capabilityId, options.blockerId), options.capabilityId, options.blockerId);
	} catch {
		return {
			blocker: null,
			status: "unreadable",
			diagnostics: [blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Blocker record could not be read.")],
		};
	}
}

export function raiseProjectMapStoreBlocker(options: RaiseProjectMapStoreBlockerOptions): ProjectMapStoreBlockerMutationResult {
	return withBlockerLock(options, (diagnostics) => ({ blocker: null, diagnostics }), () => {
		const current = classifyBlocker(blockerPath(options.root, options.capabilityId, options.blockerId), options.capabilityId, options.blockerId);
		if (current.status === "corrupted" || current.status === "unreadable") return { blocker: null, diagnostics: current.diagnostics };
		if (current.status !== "free") {
			return { blocker: null, diagnostics: [blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.BLOCKER_EXISTS, "Blocker already exists.")] };
		}
		return writeBlocker(options.root, options.capabilityId, {
			schema: "gentle-shell.project-map-store/v1",
			kind: "blocker",
			capability_id: options.capabilityId,
			blocker_id: options.blockerId,
			owner: options.owner,
			reason: options.reason,
			raised_by: options.sessionId,
			raised_at: options.now,
		});
	});
}

export function resolveProjectMapStoreBlocker(options: ResolveProjectMapStoreBlockerOptions): ProjectMapStoreBlockerMutationResult {
	return withBlockerLock(options, (diagnostics) => ({ blocker: null, diagnostics }), () => {
		const current = classifyBlocker(blockerPath(options.root, options.capabilityId, options.blockerId), options.capabilityId, options.blockerId);
		if (current.status === "corrupted" || current.status === "unreadable") return { blocker: null, diagnostics: current.diagnostics };
		if (current.status === "free") {
			return { blocker: null, diagnostics: [blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.BLOCKER_ABSENT, "Blocker is absent.")] };
		}
		if (current.status === "resolved" || current.blocker === null) {
			return { blocker: null, diagnostics: [blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.BLOCKER_RESOLVED, "Blocker has already been resolved.")] };
		}
		return writeBlocker(options.root, options.capabilityId, { ...current.blocker, resolved_at: options.now, resolution: options.resolution });
	});
}

export function listProjectMapStoreBlockers(options: ListProjectMapStoreBlockersOptions): ProjectMapStoreBlockerListResult {
	let entries: string[];
	try {
		entries = readdirSync(blockerDirectory(options.root, options.capabilityId));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { blockers: [], diagnostics: [] };
		return { blockers: [], diagnostics: [blockerDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Blocker directory could not be read.")] };
	}
	const blockers: ProjectMapStoreBlockerV1[] = [];
	const diagnostics: ProjectMapStoreDiagnostic[] = [];
	for (const entry of entries.sort()) {
		const path = join(blockerDirectory(options.root, options.capabilityId), entry);
		const current = classifyBlocker(path, options.capabilityId);
		if (current.status === "corrupted") {
			diagnostics.push(...current.diagnostics);
			continue;
		}
		if (current.status === "unreadable" || current.blocker === null) {
			diagnostics.push(...current.diagnostics);
			continue;
		}
		if (`${digest(current.blocker.blocker_id)}.json` !== entry) {
			diagnostics.push(diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Blocker id does not match its record path.", "$.blocker_id"));
			continue;
		}
		if (options.includeResolved || current.status === "open") blockers.push(current.blocker);
	}
	blockers.sort(compareBlockers);
	return { blockers, diagnostics };
}
