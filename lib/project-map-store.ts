import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFileAtomicallySync } from "./agent-profiles.ts";
import { appendProjectMapStoreHistory, pruneProjectMapStoreHistory } from "./project-map-store-history.ts";
import { conservativeOwnerDeathProofV1, qualifiedNodeFsLockPlatformV1, type ReviewLockOwnerV1 } from "./review-lock.ts";
import { canonicalJsonV1, domainHashV1 } from "./review-canonical.ts";
import { isIsoInstant } from "./shell-project-map-schema.ts";
import {
	PROJECT_MAP_STORE_DIAGNOSTIC_CODES,
	parseProjectMapStoreValue,
	serializeProjectMapStoreValue,
	type ProjectMapStoreDescriptorV1,
	type ProjectMapStoreDiagnostic,
} from "./project-map-store-schema.ts";

export type ProjectMapStoreDescriptorStatus = "ready" | "missing" | "unreadable" | "corrupted";

export interface ProjectMapStoreDescriptorReadResult {
	descriptor: ProjectMapStoreDescriptorV1 | null;
	status: ProjectMapStoreDescriptorStatus;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapStoreMutationResult {
	descriptor: ProjectMapStoreDescriptorV1 | null;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapStoreEmptinessResult {
	empty: boolean;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapStoreQuarantineResult {
	quarantined: string | null;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapStoreExpectedDescriptor {
	generation: number;
	epoch: string;
	predecessor: string;
}

export interface InitializeProjectMapStoreOptions {
	root: string;
	repositoryId: string;
	epoch: string;
	now: string;
}

export interface AdvanceProjectMapStoreOptions {
	root: string;
	expected: ProjectMapStoreExpectedDescriptor;
	now: string;
}

export const PROJECT_MAP_STORE_LOCK_STALE_MS = 30_000;

export interface ProjectMapStoreLockOwner {
	token: string;
	pid: number;
	owner_hash: string;
	acquired_at: string;
}

export interface ProjectMapStoreLockHandle {
	path: string;
	owner: ProjectMapStoreLockOwner;
}

interface DescriptorFileRead extends ProjectMapStoreDescriptorReadResult {
	bytes: string | null;
}

interface StoreEmptinessInspection extends ProjectMapStoreEmptinessResult {
	recordDirectories: Array<{ name: string; entries: number }>;
	quarantine: string | null;
}

const PROJECT_MAP_STORE_RECORD_DIRECTORIES = ["claims", "heartbeats", "sessions", "blockers", "contracts", "receipts", "worktrees"] as const;

function descriptorPath(root: string): string {
	return join(root, "store.json");
}

function storeLockPath(root: string): string {
	return join(root, "store.lock");
}

function diagnostic(code: ProjectMapStoreDiagnostic["code"], message: string): ProjectMapStoreDiagnostic {
	return { code, path: "$", message, severity: "error" };
}

function hash(bytes: string): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readDescriptorFile(root: string): DescriptorFileRead {
	let bytes: string;
	try {
		bytes = readFileSync(descriptorPath(root), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { descriptor: null, status: "missing", diagnostics: [], bytes: null };
		return { descriptor: null, status: "unreadable", diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store descriptor could not be read.")], bytes: null };
	}
	const parsed = parseProjectMapStoreValue("descriptor", bytes);
	if (parsed.record === null) {
		return {
			descriptor: null,
			status: "corrupted",
			diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Store descriptor is corrupted."), ...parsed.diagnostics],
			bytes,
		};
	}
	const canonical = serializeProjectMapStoreValue("descriptor", parsed.record);
	if (canonical.record !== bytes) {
		return {
			descriptor: null,
			status: "corrupted",
			diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Store descriptor is not in canonical form.")],
			bytes,
		};
	}
	return { descriptor: parsed.record as ProjectMapStoreDescriptorV1, status: "ready", diagnostics: [], bytes };
}

function staleDiagnostic(observed: number | null, expected: number): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STALE_GENERATION, `Store generation is ${observed === null ? "unavailable" : observed}; expected ${expected}.`);
}

function writeDescriptor(path: string, descriptor: ProjectMapStoreDescriptorV1): ProjectMapStoreMutationResult {
	const serialized = serializeProjectMapStoreValue("descriptor", descriptor);
	if (serialized.record === null) return { descriptor: null, diagnostics: serialized.diagnostics };
	try {
		writeJsonFileAtomicallySync(path, serialized.record);
		return { descriptor, diagnostics: [] };
	} catch {
		return { descriptor: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store descriptor could not be written.")] };
	}
}

function unreadableDirectoryDiagnostic(path: string): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, `Store directory "${path}" could not be read.`);
}

function storeLockedDiagnostic(): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_LOCKED, "Project-map store lock is active or ambiguous.");
}

function invalidFieldDiagnostic(path: string, message: string): ProjectMapStoreDiagnostic {
	return { code: PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD, path, message, severity: "error" };
}

function fsyncFile(path: string): void {
	const descriptor = openSync(path, "r+");
	try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(path: string): void {
	if (!statSync(path).isDirectory() || process.platform === "win32") return;
	const descriptor = openSync(path, "r");
	try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function createStoreLockOwner(now: string): ProjectMapStoreLockOwner {
	const token = randomBytes(32).toString("hex");
	const pid = process.pid;
	return { token, pid, acquired_at: now, owner_hash: domainHashV1("project-map-store-lock-owner", { token, pid, acquired_at: now }) };
}

function parseStoreLockOwner(path: string): ProjectMapStoreLockOwner | null {
	try {
		const owner = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectMapStoreLockOwner>;
		if (
			typeof owner.token !== "string"
			|| !/^[0-9a-f]{64}$/.test(owner.token)
			|| !Number.isSafeInteger(owner.pid)
			|| owner.pid <= 0
			|| typeof owner.owner_hash !== "string"
			|| typeof owner.acquired_at !== "string"
			|| !isIsoInstant(owner.acquired_at)
			|| owner.owner_hash !== domainHashV1("project-map-store-lock-owner", { token: owner.token, pid: owner.pid, acquired_at: owner.acquired_at })
		) return null;
		return owner as ProjectMapStoreLockOwner;
	} catch {
		return null;
	}
}

function writeStoreLockOwner(path: string, owner: ProjectMapStoreLockOwner): boolean {
	try {
		const ownerPath = join(path, "owner.json");
		writeFileSync(ownerPath, canonicalJsonV1(owner), { mode: 0o600, flag: "wx" });
		fsyncFile(ownerPath);
		fsyncDirectory(path);
		return true;
	} catch {
		return false;
	}
}

export function acquireProjectMapStoreLock(root: string, now: string): { handle: ProjectMapStoreLockHandle | null; diagnostics: ProjectMapStoreDiagnostic[] } {
	const path = storeLockPath(root);
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
	} catch {
		return { handle: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store root could not be created for locking.")] };
	}
	const owner = createStoreLockOwner(now);
	try {
		mkdirSync(path, { mode: 0o700 });
		if (!writeStoreLockOwner(path, owner)) {
			// A lock this process created and could not finish is this process's to remove. Leaving
			// it behind would refuse every later mutation until a human intervened, because an
			// ownerless lock directory is never broken automatically.
			try { rmSync(path, { recursive: true, force: true }); } catch { /* retained: the refusal still fails closed */ }
			return { handle: null, diagnostics: [storeLockedDiagnostic()] };
		}
		return { handle: { path, owner }, diagnostics: [] };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { handle: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store lock could not be acquired.")] };
	}
	const observed = parseStoreLockOwner(join(path, "owner.json"));
	if (observed === null || !conservativeOwnerDeathProofV1(observed as unknown as ReviewLockOwnerV1) || Date.parse(now) - Date.parse(observed.acquired_at) < PROJECT_MAP_STORE_LOCK_STALE_MS) {
		return { handle: null, diagnostics: [storeLockedDiagnostic()] };
	}
	const quarantineRoot = join(root, "locks-quarantine");
	const stale = join(quarantineRoot, `stale-${observed.owner_hash}-${observed.token}`);
	try {
		mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
		qualifiedNodeFsLockPlatformV1().moveNoReplace(path, stale);
	} catch {
		return { handle: null, diagnostics: [storeLockedDiagnostic()] };
	}
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return { handle: null, diagnostics: [storeLockedDiagnostic()] };
		return { handle: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store lock could not be acquired.")] };
	}
	if (!writeStoreLockOwner(path, owner)) return { handle: null, diagnostics: [storeLockedDiagnostic()] };
	return { handle: { path, owner }, diagnostics: [] };
}

export function releaseProjectMapStoreLock(root: string, handle: ProjectMapStoreLockHandle): ProjectMapStoreDiagnostic[] {
	const observed = parseStoreLockOwner(join(handle.path, "owner.json"));
	if (observed === null || observed.token !== handle.owner.token || observed.owner_hash !== handle.owner.owner_hash || observed.pid !== process.pid) return [storeLockedDiagnostic()];
	const quarantineRoot = join(root, "locks-quarantine");
	const released = join(quarantineRoot, `released-${handle.owner.token}`);
	try {
		mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
		qualifiedNodeFsLockPlatformV1().moveNoReplace(handle.path, released);
	} catch {
		return [storeLockedDiagnostic()];
	}
	const moved = parseStoreLockOwner(join(released, "owner.json"));
	if (moved === null || moved.token !== handle.owner.token || moved.owner_hash !== handle.owner.owner_hash || moved.pid !== process.pid) {
		try { qualifiedNodeFsLockPlatformV1().moveNoReplace(released, handle.path); } catch {}
		return [storeLockedDiagnostic()];
	}
	try {
		rmSync(released, { recursive: true, force: false });
		fsyncDirectory(quarantineRoot);
		return [];
	} catch {
		return [storeLockedDiagnostic()];
	}
}

function mutateWithProjectMapStoreLock(root: string, now: string, mutate: () => ProjectMapStoreMutationResult): ProjectMapStoreMutationResult {
	// The acquired_at this lock persists is validated by every later reader, so an invalid
	// instant must be refused before the lock exists: otherwise release cannot recognize its
	// own owner and the malformed lock permanently refuses every later mutation.
	if (!isIsoInstant(now)) return { descriptor: null, diagnostics: [invalidFieldDiagnostic("$.now", "Expected an ISO-8601 instant.")] };
	const acquired = acquireProjectMapStoreLock(root, now);
	if (acquired.handle === null) return { descriptor: null, diagnostics: acquired.diagnostics };
	let result: ProjectMapStoreMutationResult;
	try {
		result = mutate();
	} catch {
		result = { descriptor: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store mutation could not be completed.")] };
	}
	const releaseDiagnostics = releaseProjectMapStoreLock(root, acquired.handle);
	if (releaseDiagnostics.length === 0) return result;
	return {
		descriptor: result.descriptor,
		diagnostics: [...result.diagnostics, ...releaseDiagnostics.map((entry) => result.descriptor === null ? entry : { ...entry, severity: "warning" as const })],
	};
}

function inspectStoreEmptiness(root: string): StoreEmptinessInspection {
	const emptyRecordDirectories = () => PROJECT_MAP_STORE_RECORD_DIRECTORIES.map((name) => ({ name, entries: 0 }));
	let rootEntries: string[];
	try {
		rootEntries = readdirSync(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { empty: true, diagnostics: [], recordDirectories: emptyRecordDirectories(), quarantine: null };
		return { empty: false, diagnostics: [unreadableDirectoryDiagnostic(root)], recordDirectories: emptyRecordDirectories(), quarantine: null };
	}
	const diagnostics: ProjectMapStoreDiagnostic[] = [];
	const countEntries = (path: string): number => {
		try {
			return readdirSync(path).length;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			diagnostics.push(unreadableDirectoryDiagnostic(path));
			return 0;
		}
	};
	const recordDirectories = PROJECT_MAP_STORE_RECORD_DIRECTORIES.map((name) => ({ name, entries: countEntries(join(root, name)) }));
	const quarantine = rootEntries.find((entry) => /^store\.corrupt\..*\.json$/.test(entry)) ?? null;
	return { empty: diagnostics.length === 0 && recordDirectories.every((directory) => directory.entries === 0) && quarantine === null, diagnostics, recordDirectories, quarantine };
}

export function storeIsProvablyEmpty(root: string): ProjectMapStoreEmptinessResult {
	const { recordDirectories: _recordDirectories, quarantine: _quarantine, ...result } = inspectStoreEmptiness(root);
	return result;
}

function storeNotEmptyDiagnostic(inspection: StoreEmptinessInspection): ProjectMapStoreDiagnostic {
	const found = inspection.recordDirectories
		.filter((directory) => directory.entries > 0)
		.map((directory) => `${directory.entries} entr${directory.entries === 1 ? "y" : "ies"} under ${directory.name}/`);
	if (inspection.quarantine !== null) found.push(`quarantine file ${inspection.quarantine}`);
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_NOT_EMPTY, `Store is not empty: found ${found.join(", ")}.`);
}

export function readProjectMapStoreDescriptor(root: string): ProjectMapStoreDescriptorReadResult {
	const { bytes: _bytes, ...result } = readDescriptorFile(root);
	return result;
}

function initializeProjectMapStoreUnlocked(options: InitializeProjectMapStoreOptions): ProjectMapStoreMutationResult {
	try {
		const existing = readDescriptorFile(options.root);
		if (existing.status === "ready") return { descriptor: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_EXISTS, "Store descriptor already exists.")] };
		if (existing.status !== "missing") return { descriptor: null, diagnostics: existing.diagnostics };
		const emptiness = inspectStoreEmptiness(options.root);
		if (emptiness.diagnostics.length > 0) return { descriptor: null, diagnostics: emptiness.diagnostics };
		if (!emptiness.empty) return { descriptor: null, diagnostics: [storeNotEmptyDiagnostic(emptiness)] };
		const descriptor: ProjectMapStoreDescriptorV1 = {
			schema: "gentle-shell.project-map-store/v1",
			kind: "descriptor",
			repository_id: options.repositoryId,
			generation: 0,
			epoch: options.epoch,
			predecessor: null,
			created_at: options.now,
			updated_at: options.now,
		};
		return writeDescriptor(descriptorPath(options.root), descriptor);
	} catch {
		return { descriptor: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store descriptor could not be initialized.")] };
	}
}

export function initializeProjectMapStore(options: InitializeProjectMapStoreOptions): ProjectMapStoreMutationResult {
	return mutateWithProjectMapStoreLock(options.root, options.now, () => initializeProjectMapStoreUnlocked(options));
}

export function quarantineProjectMapStore(options: { root: string; now: string }): ProjectMapStoreQuarantineResult {
	if (!isIsoInstant(options.now)) {
		return { quarantined: null, diagnostics: [invalidFieldDiagnostic("$.now", "Expected an ISO-8601 instant.")] };
	}
	const source = descriptorPath(options.root);
	const destination = join(options.root, `store.corrupt.${options.now.replace(/[:.]/g, "-")}.json`);
	if (existsSync(destination)) return { quarantined: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.QUARANTINE_EXISTS, "Store quarantine destination already exists.")] };
	try {
		readFileSync(source, "utf8");
	} catch (error) {
		const message = (error as NodeJS.ErrnoException).code === "ENOENT" ? "Store descriptor is absent; nothing to quarantine." : "Store descriptor could not be quarantined.";
		return { quarantined: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, message)] };
	}
	try {
		qualifiedNodeFsLockPlatformV1().moveNoReplace(source, destination);
		return { quarantined: destination, diagnostics: [] };
	} catch {
		if (existsSync(destination)) return { quarantined: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.QUARANTINE_EXISTS, "Store quarantine destination already exists.")] };
		return { quarantined: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store descriptor could not be quarantined.")] };
	}
}

function advanceProjectMapStoreUnlocked(options: AdvanceProjectMapStoreOptions): ProjectMapStoreMutationResult {
	try {
		const observed = readDescriptorFile(options.root);
		if (observed.status !== "ready" || observed.descriptor === null || observed.bytes === null) {
			return { descriptor: null, diagnostics: observed.status === "missing" ? [staleDiagnostic(null, options.expected.generation)] : observed.diagnostics };
		}
		if (
			observed.descriptor.generation !== options.expected.generation
			|| observed.descriptor.epoch !== options.expected.epoch
			|| hash(observed.bytes) !== options.expected.predecessor
		) return { descriptor: null, diagnostics: [staleDiagnostic(observed.descriptor.generation, options.expected.generation)] };

		const successor: ProjectMapStoreDescriptorV1 = {
			...observed.descriptor,
			generation: observed.descriptor.generation + 1,
			predecessor: hash(observed.bytes),
			updated_at: options.now,
		};
		const archiveDiagnostics = appendProjectMapStoreHistory(options.root, observed.descriptor);
		if (archiveDiagnostics.length > 0) return { descriptor: null, diagnostics: archiveDiagnostics };
		const written = writeDescriptor(descriptorPath(options.root), successor);
		if (written.descriptor === null) return { descriptor: null, diagnostics: written.diagnostics };
		const pruneDiagnostics = pruneProjectMapStoreHistory(options.root);
		return { descriptor: written.descriptor, diagnostics: pruneDiagnostics };
	} catch {
		return { descriptor: null, diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store descriptor could not be advanced.")] };
	}
}

export function advanceProjectMapStore(options: AdvanceProjectMapStoreOptions): ProjectMapStoreMutationResult {
	return mutateWithProjectMapStoreLock(options.root, options.now, () => advanceProjectMapStoreUnlocked(options));
}
