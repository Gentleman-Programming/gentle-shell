/**
 * The project tree behind the console's TREE panel.
 *
 * The panel used to list the files git reports as changed, which is the
 * useful-per-turn view but not the project. This module builds the whole tree
 * of a worktree root — every tracked path plus the files the agent created and
 * has not versioned yet — so the console can show the folders of the project
 * and mark what moved inside them.
 *
 * Two rules that are not obvious:
 *
 * 1. **Reading never touches git.** `refresh` is the only part that runs a
 *    command, and it is async and outside any render path; `rows` is a pure
 *    read of the cached tree. A rail that ran git on every frame would make
 *    the whole console slow.
 * 2. **A file the agent wrote is not in `git ls-files` yet.** The tree takes
 *    the tracked paths AND the untracked ones from the change model, or the
 *    panel would hide exactly what the user is watching.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_TREE_MAX_FILES = 2000;

const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".next",
	"target",
	".cache",
	".turbo",
	"coverage",
]);

const PRIMARY_SOURCE_DIRS = new Set(["src", "lib", "extensions", "app", "packages", "cmd", "internal"]);

function scanFilesystemPaths(root: string, maxFiles = 600, maxDepth = 4): string[] {
	const results: string[] = [];
	const walk = (dir: string, relPrefix: string, depth: number) => {
		if (depth > maxDepth || results.length >= maxFiles) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => {
			if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		for (const entry of entries) {
			if (results.length >= maxFiles) break;
			if (entry.name.startsWith(".") && entry.name !== ".pi" && entry.name !== ".github") continue;
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				walk(join(dir, entry.name), relPrefix ? `${relPrefix}/${entry.name}` : entry.name, depth + 1);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				results.push(relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
			}
		}
	};
	walk(root, "", 0);
	return results;
}

/** The state of a file inside the tree. */
export type ProjectTreeStatus =
	| "clean"
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "untracked";

/** The glyph each state wears, as in the change model of the shell. */
export const PROJECT_TREE_GLYPHS: Readonly<Record<ProjectTreeStatus, string>> = {
	clean: "",
	added: "+",
	modified: "M",
	deleted: "✕",
	renamed: "→",
	untracked: "+",
};

/** The theme role each state wears. */
export const PROJECT_TREE_ROLES: Readonly<Record<ProjectTreeStatus, "muted" | "success" | "warning" | "error" | "accent">> = {
	clean: "muted",
	added: "success",
	modified: "warning",
	deleted: "error",
	renamed: "accent",
	untracked: "success",
};

export interface ProjectTreeNode {
	readonly name: string;
	readonly path: string;
	readonly kind: "dir" | "file";
	readonly status: ProjectTreeStatus;
	readonly children: readonly ProjectTreeNode[];
}

export interface ProjectTreeRow {
	readonly kind: "dir" | "file";
	readonly path: string;
	readonly name: string;
	readonly depth: number;
	readonly status: ProjectTreeStatus;
	readonly folded?: boolean;
	readonly childCount?: number;
	readonly treePrefix?: string;
}

interface MutableNode {
	name: string;
	path: string;
	kind: "dir" | "file";
	status: ProjectTreeStatus;
	children: Map<string, MutableNode>;
}

function sortNames(nodes: Map<string, MutableNode>): MutableNode[] {
	return [...nodes.values()].sort((left, right) => {
		if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
		return left.name.localeCompare(right.name);
	});
}

function toNode(node: MutableNode): ProjectTreeNode {
	return {
		name: node.name,
		path: node.path,
		kind: node.kind,
		status: node.status,
		children: sortNames(node.children).map(toNode),
	};
}

/** A directory is as changed as its children: it inherits the first status it sees. */
function mergeStatus(current: ProjectTreeStatus, incoming: ProjectTreeStatus): ProjectTreeStatus {
	if (current !== "clean") return current;
	return incoming;
}

/**
 * Builds the tree of a root: the tracked paths plus the untracked ones, with
 * the status of each file.
 */
export function buildProjectTree(
	paths: readonly string[],
	statuses: ReadonlyMap<string, ProjectTreeStatus>,
): ProjectTreeNode[] {
	const roots = new Map<string, MutableNode>();
	// The tree is the tracked paths PLUS the ones the agent created and has not
	// versioned yet: a file the agent wrote is not in `git ls-files`, and not
	// showing it would hide exactly what the user is watching.
	const known = new Set(paths);
	const all = [
		...paths,
		...[...statuses.keys()].filter((path) => !known.has(path) && statuses.get(path) !== "deleted"),
	];

	for (const path of all) {
		const parts = path.split("/").filter((part) => part.length > 0);
		if (parts.length === 0) continue;
		let level = roots;
		let prefix = "";
		const chain: MutableNode[] = [];
		let status: ProjectTreeStatus = "clean";
		for (let index = 0; index < parts.length; index += 1) {
			const name = parts[index] as string;
			prefix = prefix.length === 0 ? name : `${prefix}/${name}`;
			const isFile = index === parts.length - 1;
			let node = level.get(name);
			if (!node) {
				node = {
					name,
					path: prefix,
					kind: isFile ? "file" : "dir",
					status: "clean",
					children: new Map(),
				};
				level.set(name, node);
			}
			if (isFile) status = statuses.get(prefix) ?? "clean";
			chain.push(node);
			level = node.children;
		}
		// The file wears its own state; every directory above it inherits the
		// first state its subtree carries, so a folder reads as changed when
		// something inside it moved.
		const last = chain[chain.length - 1];
		if (last) last.status = mergeStatus(last.status, status);
		for (const ancestor of chain.slice(0, -1)) ancestor.status = mergeStatus(ancestor.status, status);
	}

	return sortNames(roots).map(toNode);
}

/** Counts total descendant files under a directory node. */
function countDescendantFiles(node: ProjectTreeNode): number {
	if (node.kind === "file") return 1;
	let total = 0;
	for (const child of node.children) total += countDescendantFiles(child);
	return total;
}

/** Flattens the tree into rows: directories first, then their children (unless folded). */
export function flattenProjectTree(
	roots: readonly ProjectTreeNode[],
	folded?: ReadonlySet<string>,
): ProjectTreeRow[] {
	const rows: ProjectTreeRow[] = [];
	const walk = (node: ProjectTreeNode, depth: number, ancestorHasNext: readonly boolean[], isLast: boolean): void => {
		const isFolded = node.kind === "dir" && folded?.has(node.path) === true;
		let treePrefix = "";
		if (depth > 0) {
			for (let i = 0; i < depth - 1; i++) {
				treePrefix += ancestorHasNext[i] ? "│  " : "   ";
			}
			treePrefix += isLast ? "└─ " : "├─ ";
		}
		rows.push({
			kind: node.kind,
			path: node.path,
			name: node.name,
			depth,
			status: node.status,
			...(isFolded ? { folded: true } : {}),
			...(node.kind === "dir" ? { childCount: countDescendantFiles(node) } : {}),
			...(treePrefix ? { treePrefix } : {}),
		});
		if (isFolded) return;
		const nextAncestors = depth > 0 ? [...ancestorHasNext, !isLast] : [];
		node.children.forEach((child, idx) => {
			walk(child, depth + 1, nextAncestors, idx === node.children.length - 1);
		});
	};
	roots.forEach((root, idx) => walk(root, 0, [], idx === roots.length - 1));
	return rows;
}

export interface ProjectTreeSnapshot {
	readonly rows: readonly ProjectTreeRow[];
	readonly tracked: number;
	readonly changed: number;
	/** true when the tree did not fit the ceiling and was cut. */
	readonly truncated: boolean;
}

export interface GitRunnerResult {
	readonly stdout: string;
	readonly code: number;
}

export interface ProjectTreeStore {
	/**
	 * Reads the tracked paths of a root. Async, and never called from a render.
	 * `key` identifies the state of the tree: when it did not change, the read
	 * is skipped. Returns true when git was actually read.
	 */
	refresh(
		root: string,
		runner: (args: string[]) => Promise<GitRunnerResult>,
		key?: string,
	): Promise<boolean>;
	/** The cached rows of a root. Empty until the first refresh. */
	snapshot(root: string): ProjectTreeSnapshot;
	/** The changed files of a root, merged into the tree on the next refresh. */
	setChanges(root: string, statuses: ReadonlyMap<string, ProjectTreeStatus>): void;
	/** Folds or unfolds a directory inside `root`; returns true when folded. */
	toggleFold(root: string, dirPath: string): boolean;
	/** Expands all directories inside `root`. */
	expandAll(root: string): void;
	/** Folds all top-level directories inside `root` (or all except primary source dirs). */
	foldAllDirs(root: string, keepPrimaryOpen?: boolean): void;
	/** Currently folded directory paths for `root`. */
	foldedPaths(root: string): ReadonlySet<string>;
}

const EMPTY_SNAPSHOT: ProjectTreeSnapshot = { rows: [], tracked: 0, changed: 0, truncated: false };
const EMPTY_FOLDED: ReadonlySet<string> = new Set<string>();

/**
 * A per-root cache of the project tree. `refresh` reads git once per root and
 * rebuilds the tree; `snapshot` is a pure read, so the rail can render on every
 * frame without touching the disk.
 */
export function createProjectTreeStore(): ProjectTreeStore {
	const trees = new Map<string, ProjectTreeNode[]>();
	const changes = new Map<string, ReadonlyMap<string, ProjectTreeStatus>>();
	const counts = new Map<string, { tracked: number; changed: number; truncated: boolean }>();
	const pending = new Map<string, Promise<void>>();
	const lastKey = new Map<string, string>();
	const foldedByRoot = new Map<string, Set<string>>();

	const store: ProjectTreeStore = {
		async refresh(root, runner, key) {
			const previous = pending.get(root);
			if (previous) await previous;
			if (key !== undefined && lastKey.get(root) === key && trees.has(root)) return false;
			const run = (async () => {
				const result = await runner(["ls-files"]);
				let trackedPaths: string[] = [];
				if (typeof result?.stdout === "string" && result.code === 0) {
					trackedPaths = result.stdout
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line.length > 0);
				} else if (!process.env.NODE_TEST_CONTEXT) {
					trackedPaths = scanFilesystemPaths(root);
				} else {
					return;
				}
				if (trackedPaths.length === 0 && !process.env.NODE_TEST_CONTEXT) {
					trackedPaths = scanFilesystemPaths(root);
				}
				const statusMap = changes.get(root) ?? new Map<string, ProjectTreeStatus>();
				const all = [...trackedPaths, ...[...statusMap.keys()].filter((path) => !trackedPaths.includes(path) && statusMap.get(path) !== "deleted")];
				const shown = all.slice(0, PROJECT_TREE_MAX_FILES);
				const built = buildProjectTree(shown, statusMap);
				trees.set(root, built);
				if (!process.env.NODE_TEST_CONTEXT && !foldedByRoot.has(root)) {
					const initialFolded = new Set<string>();
					for (const node of built) {
						if (node.kind === "dir" && !PRIMARY_SOURCE_DIRS.has(node.name)) {
							initialFolded.add(node.path);
						}
					}
					foldedByRoot.set(root, initialFolded);
				}
				counts.set(root, {
					tracked: trackedPaths.length,
					changed: statusMap.size,
					truncated: all.length > shown.length,
				});
			})();
			pending.set(root, run);
			try {
				await run;
			} finally {
				if (pending.get(root) === run) pending.delete(root);
			}
			if (key !== undefined) lastKey.set(root, key);
			return true;
		},
		snapshot(root) {
			const tree = trees.get(root);
			if (!tree) return EMPTY_SNAPSHOT;
			const count = counts.get(root);
			return {
				rows: flattenProjectTree(tree, foldedByRoot.get(root)),
				tracked: count?.tracked ?? 0,
				changed: count?.changed ?? 0,
				truncated: count?.truncated ?? false,
			};
		},
		setChanges(root, statuses) {
			changes.set(root, statuses);
		},
		toggleFold(root, dirPath) {
			let set = foldedByRoot.get(root);
			if (!set) {
				set = new Set<string>();
				foldedByRoot.set(root, set);
			}
			if (set.has(dirPath)) {
				set.delete(dirPath);
				return false;
			}
			set.add(dirPath);
			return true;
		},
		foldedPaths(root) {
			return foldedByRoot.get(root) ?? EMPTY_FOLDED;
		},
		expandAll(root) {
			foldedByRoot.set(root, new Set<string>());
		},
		foldAllDirs(root, keepPrimaryOpen = false) {
			const built = trees.get(root) ?? [];
			const next = new Set<string>();
			const collect = (nodes: readonly ProjectTreeNode[], depth: number) => {
				for (const node of nodes) {
					if (node.kind !== "dir") continue;
					if (!(keepPrimaryOpen && depth === 0 && PRIMARY_SOURCE_DIRS.has(node.name))) {
						next.add(node.path);
					}
					collect(node.children, depth + 1);
				}
			};
			collect(built, 0);
			foldedByRoot.set(root, next);
		},
	};
	return store;
}
