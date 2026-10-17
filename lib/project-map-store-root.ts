import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertManagedStorePathV1 } from "./review-repository.ts";
import { resolveSessionWorktreeWithGit } from "./session-worktree-registry.ts";
import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES, type ProjectMapStoreDiagnostic } from "./project-map-store-schema.ts";

export interface ProjectMapStoreRootResult {
	root: string | null;
	commonDir: string | null;
	repositoryId: string | null;
	diagnostics: ProjectMapStoreDiagnostic[];
}

function refusal(message: string): ProjectMapStoreRootResult {
	return {
		root: null,
		commonDir: null,
		repositoryId: null,
		diagnostics: [{ code: PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD, path: "$", message, severity: "error" }],
	};
}

export function resolveProjectMapStoreRoot(cwd: string): ProjectMapStoreRootResult {
	try {
		const worktree = resolveSessionWorktreeWithGit(cwd, cwd);
		if (!worktree) return refusal("Git repository identity could not be resolved.");
		const repositoryId = `sha256:${createHash("sha256").update(worktree.commonDir).digest("hex")}`;
		const root = assertManagedStorePathV1(worktree.commonDir, join(worktree.commonDir, "gentle-ai", "project-map"));
		return { root, commonDir: worktree.commonDir, repositoryId, diagnostics: [] };
	} catch {
		return refusal("Project Map store root could not be safely resolved.");
	}
}

export function ensureProjectMapStoreRoot(cwd: string): ProjectMapStoreRootResult {
	try {
		const resolved = resolveProjectMapStoreRoot(cwd);
		if (resolved.root === null) return resolved;
		mkdirSync(resolved.root, { recursive: true, mode: 0o700 });
		if ((statSync(resolved.root).mode & 0o077) !== 0) return refusal("Project Map store root permissions are not restrictive.");
		return resolved;
	} catch {
		return refusal("Project Map store root could not be safely created.");
	}
}
