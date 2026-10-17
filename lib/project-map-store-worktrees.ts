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
	type ProjectMapStoreDiagnostic,
	type ProjectMapStoreWorktreeBindingV1,
} from "./project-map-store-schema.ts";
import { isIsoInstant } from "./shell-project-map-schema.ts";

export type ProjectMapWorktreeBindingStatus = "free" | "bound" | "corrupted" | "unreadable";

export interface ReadProjectMapStoreWorktreeBindingOptions {
	root: string;
	capabilityId: string;
}

export interface ProjectMapStoreWorktreeBindingReadResult {
	binding: ProjectMapStoreWorktreeBindingV1 | null;
	status: ProjectMapWorktreeBindingStatus;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface BindProjectMapStoreWorktreeOptions extends ReadProjectMapStoreWorktreeBindingOptions {
	branch: string;
	worktreeRoot: string;
	sessionId: string;
	baseCommit: string;
	now: string;
}

export interface ProjectMapStoreWorktreeBindingMutationResult {
	binding: ProjectMapStoreWorktreeBindingV1 | null;
	diagnostics: ProjectMapStoreDiagnostic[];
}

export interface ProjectMapStoreWorktreeBindingListResult {
	bindings: ProjectMapStoreWorktreeBindingV1[];
	diagnostics: ProjectMapStoreDiagnostic[];
}

function worktreePath(root: string, capabilityId: string): string {
	const name = createHash("sha256").update(capabilityId).digest("hex");
	return join(root, "worktrees", `${name}.json`);
}

function diagnostic(code: ProjectMapStoreDiagnostic["code"], message: string, path = "$"): ProjectMapStoreDiagnostic {
	return { code, path, message, severity: "error" };
}

function bindingDiagnostic(code: ProjectMapStoreDiagnostic["code"], message: string): ProjectMapStoreDiagnostic {
	return diagnostic(code, message);
}

function invalidNowDiagnostic(): ProjectMapStoreDiagnostic {
	return diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD, "Expected an ISO-8601 instant.", "$.now");
}

function makeBinding(options: BindProjectMapStoreWorktreeOptions): ProjectMapStoreWorktreeBindingV1 {
	return {
		schema: "gentle-shell.project-map-store/v1",
		kind: "worktree-binding",
		capability_id: options.capabilityId,
		branch: options.branch,
		worktree_root: options.worktreeRoot,
		session_id: options.sessionId,
		base_commit: options.baseCommit,
		created_at: options.now,
	};
}

function hasSameBindingFacts(existing: ProjectMapStoreWorktreeBindingV1, candidate: ProjectMapStoreWorktreeBindingV1): boolean {
	return existing.capability_id === candidate.capability_id
		&& existing.branch === candidate.branch
		&& existing.worktree_root === candidate.worktree_root
		&& existing.session_id === candidate.session_id
		&& existing.base_commit === candidate.base_commit;
}

function classifyProjectMapStoreWorktreeBinding(path: string, capabilityId?: string): ProjectMapStoreWorktreeBindingReadResult {
	let bytes: string;
	try {
		bytes = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { binding: null, status: "free", diagnostics: [] };
		return {
			binding: null,
			status: "unreadable",
			diagnostics: [bindingDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Worktree binding record could not be read.")],
		};
	}
	const parsed = parseProjectMapStoreValue("worktree-binding", bytes);
	if (parsed.record === null) {
		return {
			binding: null,
			status: "corrupted",
			diagnostics: [bindingDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Worktree binding record is corrupted."), ...parsed.diagnostics],
		};
	}
	const binding = parsed.record as ProjectMapStoreWorktreeBindingV1;
	if (capabilityId !== undefined && binding.capability_id !== capabilityId) {
		return {
			binding: null,
			status: "corrupted",
			diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Worktree binding capability id does not match the requested capability.", "$.capability_id")],
		};
	}
	const canonical = serializeProjectMapStoreValue("worktree-binding", binding);
	if (canonical.record === null || canonical.record !== bytes) {
		return {
			binding: null,
			status: "corrupted",
			diagnostics: [bindingDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, "Worktree binding record is not in canonical form.")],
		};
	}
	return { binding, status: "bound", diagnostics: [] };
}

function readyStoreDiagnostics(root: string): ProjectMapStoreDiagnostic[] {
	const descriptor = readProjectMapStoreDescriptor(root);
	if (descriptor.status === "ready") return [];
	if (descriptor.status === "missing") {
		return [bindingDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store has to be initialized first.")];
	}
	return [
		bindingDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Project-map store is not ready for worktree binding operations."),
		...descriptor.diagnostics,
	];
}

function writeBinding(root: string, capabilityId: string, binding: ProjectMapStoreWorktreeBindingV1): ProjectMapStoreWorktreeBindingMutationResult {
	const serialized = serializeProjectMapStoreValue("worktree-binding", binding);
	if (serialized.record === null) return { binding: null, diagnostics: serialized.diagnostics };
	try {
		mkdirSync(join(root, "worktrees"), { recursive: true, mode: 0o700 });
		writeJsonFileAtomicallySync(worktreePath(root, capabilityId), serialized.record);
		return { binding, diagnostics: [] };
	} catch {
		return {
			binding: null,
			diagnostics: [bindingDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Worktree binding record could not be written.")],
		};
	}
}

function withWorktreeBindingLock<T extends { diagnostics: ProjectMapStoreDiagnostic[] }>(
	options: BindProjectMapStoreWorktreeOptions,
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
		result = unavailable([bindingDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Worktree binding operation could not be completed.")]);
	}
	const releaseDiagnostics = releaseProjectMapStoreLock(options.root, acquired.handle);
	if (releaseDiagnostics.length > 0) result.diagnostics.push(...releaseDiagnostics.map((entry) => ({ ...entry, severity: "warning" as const })));
	return result;
}

export function readProjectMapStoreWorktreeBinding(options: ReadProjectMapStoreWorktreeBindingOptions): ProjectMapStoreWorktreeBindingReadResult {
	try {
		return classifyProjectMapStoreWorktreeBinding(worktreePath(options.root, options.capabilityId), options.capabilityId);
	} catch {
		return {
			binding: null,
			status: "unreadable",
			diagnostics: [bindingDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Worktree binding record could not be read.")],
		};
	}
}

export function bindProjectMapStoreWorktree(options: BindProjectMapStoreWorktreeOptions): ProjectMapStoreWorktreeBindingMutationResult {
	return withWorktreeBindingLock(options, (diagnostics) => ({ binding: null, diagnostics }), () => {
		const current = readProjectMapStoreWorktreeBinding(options);
		if (current.status === "corrupted" || current.status === "unreadable") return { binding: null, diagnostics: current.diagnostics };
		const binding = makeBinding(options);
		const serialized = serializeProjectMapStoreValue("worktree-binding", binding);
		if (serialized.record === null) return { binding: null, diagnostics: serialized.diagnostics };
		if (current.status === "bound" && current.binding !== null) {
			if (hasSameBindingFacts(current.binding, binding)) return { binding: current.binding, diagnostics: [] };
			return {
				binding: null,
				diagnostics: [bindingDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.WORKTREE_ALREADY_BOUND, "Capability already has a different worktree binding.")],
			};
		}
		return writeBinding(options.root, options.capabilityId, binding);
	});
}

export function listProjectMapStoreWorktreeBindings(options: { root: string }): ProjectMapStoreWorktreeBindingListResult {
	let entries: string[];
	const directory = join(options.root, "worktrees");
	try {
		entries = readdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bindings: [], diagnostics: [] };
		return {
			bindings: [],
			diagnostics: [bindingDiagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Worktree binding directory could not be read.")],
		};
	}
	const bindings: ProjectMapStoreWorktreeBindingV1[] = [];
	const diagnostics: ProjectMapStoreDiagnostic[] = [];
	for (const entry of entries) {
		const classified = classifyProjectMapStoreWorktreeBinding(join(directory, entry));
		if (classified.status === "bound" && classified.binding !== null) {
			bindings.push(classified.binding);
			continue;
		}
		for (const entryDiagnostic of classified.diagnostics) {
			diagnostics.push({ ...entryDiagnostic, path: `worktrees/${entry}`, message: `${entry}: ${entryDiagnostic.message}` });
		}
	}
	bindings.sort((left, right) => left.capability_id.localeCompare(right.capability_id));
	return { bindings, diagnostics };
}
