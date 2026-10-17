import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
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
	type ProjectMapStoreDiagnostic,
	type ProjectMapStoreHeartbeatV1,
	type ProjectMapStoreSessionBindingV1,
} from "./project-map-store-schema.ts";
import { conservativeOwnerDeathProofV1, type ReviewLockOwnerV1 } from "./review-lock.ts";
import { isIsoInstant } from "./shell-project-map-schema.ts";

export const PROJECT_MAP_STORE_HEARTBEAT_INTERVAL_MS = 10_000;
export const PROJECT_MAP_STORE_HEARTBEAT_STALE_MS = 60_000;

export type ProjectMapStoreHeartbeatStatus = "free" | "fresh" | "stale" | "corrupted" | "unreadable";
export type ProjectMapStoreSessionBindingStatus = "free" | "bound" | "corrupted" | "unreadable";

export interface ReadProjectMapStoreHeartbeatOptions {
	root: string;
	sessionId: string;
	now: string;
}

export interface ProjectMapStoreHeartbeatMutationOptions extends ReadProjectMapStoreHeartbeatOptions {
	pid: number;
	incarnation: string;
}

export interface ReadProjectMapStoreSessionBindingOptions {
	root: string;
	sessionId: string;
}

export interface ProjectMapStoreSessionBindingMutationOptions extends ReadProjectMapStoreSessionBindingOptions {
	pid: number;
	incarnation: string;
	workspaceRoot: string;
	now: string;
	/** The nonce the launching parent generated, when this session was launched by one. */
	launchNonce?: string;
}

export interface ProjectMapStoreHeartbeatReadResult {
	heartbeat: ProjectMapStoreHeartbeatV1 | null;
	status: ProjectMapStoreHeartbeatStatus;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapStoreHeartbeatMutationResult {
	heartbeat: ProjectMapStoreHeartbeatV1 | null;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapStoreSessionBindingReadResult {
	binding: ProjectMapStoreSessionBindingV1 | null;
	status: ProjectMapStoreSessionBindingStatus;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapStoreSessionBindingMutationResult {
	binding: ProjectMapStoreSessionBindingV1 | null;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapStoreHeartbeatPruneResult {
	removed: string[];
	retained: string[];
	diagnostics: ProjectMapStoreDiagnostic[];
}

function recordPath(root: string, directory: "heartbeats" | "sessions", sessionId: string): string {
	const name = createHash("sha256").update(sessionId).digest("hex");
	return join(root, directory, `${name}.json`);
}

function diagnostic(code: ProjectMapStoreDiagnostic["code"], message: string, path = "$"): ProjectMapStoreDiagnostic {
	return { code, path, message, severity: "error" };
}

function invalidNowDiagnostic(): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD, "Expected an ISO-8601 instant.", "$.now");
}

function unreadableDiagnostic(record: string): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, `${record} record could not be read.`);
}

function corruptedDiagnostic(record: string): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, `${record} record is corrupted.`);
}

function readyStoreDiagnostics(root: string, operation: string): ProjectMapStoreDiagnostic[] {
	const descriptor = readProjectMapStoreDescriptor(root);
	if (descriptor.status === "ready") return [];
	if (descriptor.status === "missing") {
		return [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store has to be initialized first.")];
	}
	return [
		diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, `Project-map store is not ready for ${operation}.`),
		...descriptor.diagnostics,
	];
}

function classifyHeartbeat(options: ReadProjectMapStoreHeartbeatOptions): ProjectMapStoreHeartbeatReadResult {
	let bytes: string;
	try {
		bytes = readFileSync(recordPath(options.root, "heartbeats", options.sessionId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { heartbeat: null, status: "free", diagnostics: [] };
		return { heartbeat: null, status: "unreadable", diagnostics: [unreadableDiagnostic("Heartbeat")] };
	}
	const parsed = parseProjectMapStoreValue("heartbeat", bytes);
	if (parsed.record === null) {
		return { heartbeat: null, status: "corrupted", diagnostics: [corruptedDiagnostic("Heartbeat"), ...parsed.diagnostics] };
	}
	const heartbeat = parsed.record as ProjectMapStoreHeartbeatV1;
	if (heartbeat.session_id !== options.sessionId) {
		return {
			heartbeat: null,
			status: "corrupted",
			diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Heartbeat session id does not match the requested session.", "$.session_id")],
		};
	}
	const canonical = serializeProjectMapStoreValue("heartbeat", heartbeat);
	if (canonical.record === null || canonical.record !== bytes) {
		return { heartbeat: null, status: "corrupted", diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Heartbeat record is not in canonical form.")] };
	}
	return {
		heartbeat,
		status: Date.parse(options.now) - Date.parse(heartbeat.beat_at) < PROJECT_MAP_STORE_HEARTBEAT_STALE_MS ? "fresh" : "stale",
		diagnostics: [],
	};
}

function classifySessionBinding(options: ReadProjectMapStoreSessionBindingOptions): ProjectMapStoreSessionBindingReadResult {
	let bytes: string;
	try {
		bytes = readFileSync(recordPath(options.root, "sessions", options.sessionId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { binding: null, status: "free", diagnostics: [] };
		return { binding: null, status: "unreadable", diagnostics: [unreadableDiagnostic("Session binding")] };
	}
	const parsed = parseProjectMapStoreValue("session-binding", bytes);
	if (parsed.record === null) {
		return { binding: null, status: "corrupted", diagnostics: [corruptedDiagnostic("Session binding"), ...parsed.diagnostics] };
	}
	const binding = parsed.record as ProjectMapStoreSessionBindingV1;
	if (binding.session_id !== options.sessionId) {
		return {
			binding: null,
			status: "corrupted",
			diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Session binding id does not match the requested session.", "$.session_id")],
		};
	}
	const canonical = serializeProjectMapStoreValue("session-binding", binding);
	if (canonical.record === null || canonical.record !== bytes) {
		return { binding: null, status: "corrupted", diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Session binding record is not in canonical form.")] };
	}
	return { binding, status: "bound", diagnostics: [] };
}

function writeHeartbeat(root: string, heartbeat: ProjectMapStoreHeartbeatV1): ProjectMapStoreHeartbeatMutationResult {
	const serialized = serializeProjectMapStoreValue("heartbeat", heartbeat);
	if (serialized.record === null) return { heartbeat: null, diagnostics: serialized.diagnostics };
	try {
		mkdirSync(join(root, "heartbeats"), { recursive: true, mode: 0o700 });
		writeJsonFileAtomicallySync(recordPath(root, "heartbeats", heartbeat.session_id), serialized.record);
		return { heartbeat, diagnostics: [] };
	} catch {
		return { heartbeat: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Heartbeat record could not be written.")] };
	}
}

function writeSessionBinding(root: string, binding: ProjectMapStoreSessionBindingV1): ProjectMapStoreSessionBindingMutationResult {
	const serialized = serializeProjectMapStoreValue("session-binding", binding);
	if (serialized.record === null) return { binding: null, diagnostics: serialized.diagnostics };
	try {
		mkdirSync(join(root, "sessions"), { recursive: true, mode: 0o700 });
		writeJsonFileAtomicallySync(recordPath(root, "sessions", binding.session_id), serialized.record);
		return { binding, diagnostics: [] };
	} catch {
		return { binding: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Session binding record could not be written.")] };
	}
}

function heartbeatRecord(options: ProjectMapStoreHeartbeatMutationOptions): ProjectMapStoreHeartbeatV1 {
	return {
		schema: "gentle-shell.project-map-store/v1",
		kind: "heartbeat",
		session_id: options.sessionId,
		pid: options.pid,
		incarnation: options.incarnation,
		beat_at: options.now,
	};
}

function bindingRecord(options: ProjectMapStoreSessionBindingMutationOptions): ProjectMapStoreSessionBindingV1 {
	return {
		schema: "gentle-shell.project-map-store/v1",
		kind: "session-binding",
		session_id: options.sessionId,
		pid: options.pid,
		incarnation: options.incarnation,
		workspace_root: options.workspaceRoot,
		bound_at: options.now,
		...(options.launchNonce === undefined ? {} : { launch_nonce: options.launchNonce }),
	};
}

function pidProvesDead(pid: number): boolean {
	try {
		return conservativeOwnerDeathProofV1({ pid } as ReviewLockOwnerV1);
	} catch {
		return false;
	}
}

export function projectMapStoreBindingProvesDead(binding: ProjectMapStoreSessionBindingV1): boolean {
	return pidProvesDead(binding.pid);
}

export function readProjectMapStoreHeartbeat(options: ReadProjectMapStoreHeartbeatOptions): ProjectMapStoreHeartbeatReadResult {
	try {
		if (!isIsoInstant(options.now)) return { heartbeat: null, status: "unreadable", diagnostics: [invalidNowDiagnostic()] };
		return classifyHeartbeat(options);
	} catch {
		return { heartbeat: null, status: "unreadable", diagnostics: [unreadableDiagnostic("Heartbeat")] };
	}
}

export function beatProjectMapStoreHeartbeat(options: ProjectMapStoreHeartbeatMutationOptions): ProjectMapStoreHeartbeatMutationResult {
	try {
		if (!isIsoInstant(options.now)) return { heartbeat: null, diagnostics: [invalidNowDiagnostic()] };
		const readiness = readyStoreDiagnostics(options.root, "heartbeat operations");
		if (readiness.length > 0) return { heartbeat: null, diagnostics: readiness };
		const current = classifyHeartbeat(options);
		if (current.status === "corrupted" || current.status === "unreadable") return { heartbeat: null, diagnostics: current.diagnostics };
		if (current.heartbeat !== null && Date.parse(options.now) - Date.parse(current.heartbeat.beat_at) < PROJECT_MAP_STORE_HEARTBEAT_INTERVAL_MS) {
			return { heartbeat: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.HEARTBEAT_TOO_EARLY, "Heartbeat cadence is not yet open.")] };
		}
		return writeHeartbeat(options.root, heartbeatRecord(options));
	} catch {
		return { heartbeat: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Heartbeat operation could not be completed.")] };
	}
}

export function readProjectMapStoreSessionBinding(options: ReadProjectMapStoreSessionBindingOptions): ProjectMapStoreSessionBindingReadResult {
	try {
		return classifySessionBinding(options);
	} catch {
		return { binding: null, status: "unreadable", diagnostics: [unreadableDiagnostic("Session binding")] };
	}
}

export function bindProjectMapStoreSession(options: ProjectMapStoreSessionBindingMutationOptions): ProjectMapStoreSessionBindingMutationResult {
	try {
		if (!isIsoInstant(options.now)) return { binding: null, diagnostics: [invalidNowDiagnostic()] };
		const readiness = readyStoreDiagnostics(options.root, "session binding operations");
		if (readiness.length > 0) return { binding: null, diagnostics: readiness };
		const acquired = acquireProjectMapStoreLock(options.root, options.now);
		if (acquired.handle === null) return { binding: null, diagnostics: acquired.diagnostics };
		let result: ProjectMapStoreSessionBindingMutationResult;
		try {
			const underLock = readyStoreDiagnostics(options.root, "session binding operations");
			if (underLock.length > 0) result = { binding: null, diagnostics: underLock };
			else {
				const current = classifySessionBinding(options);
				if (current.status === "corrupted" || current.status === "unreadable") result = { binding: null, diagnostics: current.diagnostics };
				else if (current.status === "free") result = writeSessionBinding(options.root, bindingRecord(options));
				else if (current.binding !== null && current.binding.pid === options.pid && current.binding.incarnation === options.incarnation) {
					result = writeSessionBinding(options.root, { ...current.binding, bound_at: options.now });
				} else if (current.binding !== null && projectMapStoreBindingProvesDead(current.binding)) {
					result = writeSessionBinding(options.root, bindingRecord(options));
				} else {
					result = { binding: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.SESSION_BINDING_HELD, "Session binding is held by a live or ambiguous process.")] };
				}
			}
		} catch {
			result = { binding: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Session binding operation could not be completed.")] };
		}
		const releaseDiagnostics = releaseProjectMapStoreLock(options.root, acquired.handle);
		if (releaseDiagnostics.length > 0) result.diagnostics.push(...releaseDiagnostics.map((entry) => result.binding === null ? entry : { ...entry, severity: "warning" as const }));
		return result;
	} catch {
		return { binding: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Session binding operation could not be completed.")] };
	}
}

export function pruneProjectMapStoreHeartbeats(options: { root: string; now: string }): ProjectMapStoreHeartbeatPruneResult {
	try {
		if (!isIsoInstant(options.now)) return { removed: [], retained: [], diagnostics: [invalidNowDiagnostic()] };
		const readiness = readyStoreDiagnostics(options.root, "heartbeat pruning");
		if (readiness.length > 0) return { removed: [], retained: [], diagnostics: readiness };
		const acquired = acquireProjectMapStoreLock(options.root, options.now);
		if (acquired.handle === null) return { removed: [], retained: [], diagnostics: acquired.diagnostics };
		let result: ProjectMapStoreHeartbeatPruneResult;
		try {
			const underLock = readyStoreDiagnostics(options.root, "heartbeat pruning");
			if (underLock.length > 0) result = { removed: [], retained: [], diagnostics: underLock };
			else {
				let entries: string[];
				try {
					entries = readdirSync(join(options.root, "heartbeats")).sort();
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
					else throw new Error("Heartbeat directory could not be read.");
				}
				const removed: string[] = [];
				const retained: string[] = [];
				const diagnostics: ProjectMapStoreDiagnostic[] = [];
				for (const entry of entries) {
					const path = join(options.root, "heartbeats", entry);
					let bytes: string;
					try {
						bytes = readFileSync(path, "utf8");
					} catch {
						diagnostics.push(unreadableDiagnostic("Heartbeat"));
						continue;
					}
					const parsed = parseProjectMapStoreValue("heartbeat", bytes);
					if (parsed.record === null) {
						diagnostics.push(corruptedDiagnostic("Heartbeat"), ...parsed.diagnostics);
						continue;
					}
					const heartbeat = parsed.record as ProjectMapStoreHeartbeatV1;
					const canonical = serializeProjectMapStoreValue("heartbeat", heartbeat);
					if (canonical.record === null || canonical.record !== bytes || entry !== `${createHash("sha256").update(heartbeat.session_id).digest("hex")}.json`) {
						diagnostics.push(diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Heartbeat record is not in canonical form."));
						continue;
					}
					if (Date.parse(options.now) - Date.parse(heartbeat.beat_at) < PROJECT_MAP_STORE_HEARTBEAT_STALE_MS) continue;
					if (!pidProvesDead(heartbeat.pid)) {
						retained.push(heartbeat.session_id);
						continue;
					}
					try {
						unlinkSync(path);
						removed.push(heartbeat.session_id);
					} catch {
						diagnostics.push(diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Heartbeat record could not be removed."));
					}
				}
				result = { removed: removed.sort(), retained: retained.sort(), diagnostics };
			}
		} catch {
			result = { removed: [], retained: [], diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Heartbeat pruning could not be completed.")] };
		}
		const releaseDiagnostics = releaseProjectMapStoreLock(options.root, acquired.handle);
		if (releaseDiagnostics.length > 0) result.diagnostics.push(...releaseDiagnostics.map((entry) => result.removed.length > 0 ? { ...entry, severity: "warning" as const } : entry));
		return result;
	} catch {
		return { removed: [], retained: [], diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Heartbeat pruning could not be completed.")] };
	}
}
