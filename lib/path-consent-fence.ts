import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

// Deliberately ephemeral, mirroring ForeignTargetGrants: no session entry or
// disk persistence can restore consent, and grants never cross sessions.
export class PathTargetGrants {
	private readonly grants = new Map<string, Set<string>>();

	grant(sessionKey: string, targets: readonly string[]): void {
		const set = this.grants.get(sessionKey) ?? new Set<string>();
		for (const target of targets) set.add(target);
		this.grants.set(sessionKey, set);
	}

	pending(sessionKey: string, targets: readonly string[]): string[] {
		const granted = this.grants.get(sessionKey);
		return granted ? targets.filter((target) => !granted.has(target)) : [...targets];
	}
}

export const PATH_FENCE_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const PATH_INPUT_KEYS = new Set(["path", "paths", "file", "files", "filePath", "filePaths"]);

// Single source for path-bearing argument keys; extensions/gentle-ai.ts
// reuses this collector for its sensitive-path guard.
export function collectStringPaths(value: unknown, key?: string): string[] {
	if (typeof value === "string") return key && PATH_INPUT_KEYS.has(key) ? [value] : [];
	if (Array.isArray(value)) return value.flatMap((item) => collectStringPaths(item, key));
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([entryKey, entryValue]) => collectStringPaths(entryValue, entryKey));
}

// Canonical form for consent comparisons: ~ expanded, resolved against cwd,
// and symlink-resolved through the deepest existing ancestor so not-yet-
// written targets still classify. Unreadable trees keep the lexical path.
export function canonicalizeTarget(raw: string, cwd: string): string {
	const trimmed = raw.trim().replace(/\\/g, "/");
	const expanded = trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
	const absolute = resolve(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
	let probe = absolute;
	const missing: string[] = [];
	while (true) {
		try {
			const real = realpathSync(probe);
			return missing.length === 0 ? real : resolve(real, ...missing.reverse());
		} catch {
			missing.push(basename(probe));
			const parent = dirname(probe);
			if (parent === probe) return absolute;
			probe = parent;
		}
	}
}

function insideBoundary(target: string, roots: readonly string[]): boolean {
	return roots.some((root) => target === root || target.startsWith(root + sep));
}

export function resolveOutsidePaths(paths: readonly string[], cwd: string, roots: readonly string[]): string[] {
	const outside = new Set<string>();
	for (const path of paths) {
		const canonical = canonicalizeTarget(path, cwd);
		if (!insideBoundary(canonical, roots)) outside.add(canonical);
	}
	return [...outside].sort();
}

export type PathFenceDecision =
	| { kind: "pass" }
	| { kind: "confirm"; targets: string[] }
	| { kind: "headless-block"; reason: string };

export function evaluatePathFence(
	toolName: string,
	input: unknown,
	cwd: string,
	roots: readonly string[],
	sessionKey: string,
	grants: PathTargetGrants,
	hasUI: boolean,
): PathFenceDecision {
	if (!PATH_FENCE_TOOL_NAMES.has(toolName) || roots.length === 0) return { kind: "pass" };
	let paths = collectStringPaths(input);
	if (paths.length === 0 && (toolName === "grep" || toolName === "find" || toolName === "ls")) paths = ["."];
	const pending = grants.pending(sessionKey, resolveOutsidePaths(paths, cwd, roots));
	if (pending.length === 0) return { kind: "pass" };
	if (!hasUI) {
		return {
			kind: "headless-block",
			reason: `Gentle AI safety policy requires interactive confirmation before accessing paths outside the session worktree: ${pending.join(", ")}. Ask the user for an explicit safer plan.`,
		};
	}
	return { kind: "confirm", targets: pending };
}
