import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { resolveSessionWorktree, type WorktreeResolver } from "./session-worktree-registry.ts";

// gentle-shell#1731: concurrent bounded writers are admitted only when their
// `## Allowed edit surfaces` are disjoint. Overlap is deliberately conservative:
// an entry covers every path it matches and everything under such a path, and
// any entry or segment this module cannot reason about counts as overlapping.
// Like minimatch, `**` is a globstar only as a whole segment; inside a segment
// (`src/**.ts`) it matches within that one segment, like `*`.

const SPECIAL = /[*?{}]/;
const MAX_LISTED_PAIRS = 5;

// Repository-relative, slash-separated and lowercased (case-insensitive
// filesystems make `A.ts` and `a.ts` one file). Undefined means unscopable.
export function normalizeSurfaceEntry(entry: string): string | undefined {
	let value = entry.trim().replace(/^(?:[-*+]|\d+[.)]) +/, "");
	const quoted = value.match(/^`([^`]*)`$/);
	if (quoted) value = quoted[1];
	// Backslashes are kept: an escape and a separator are indistinguishable, so
	// the overlap check treats such an entry as uninterpretable.
	value = value.normalize("NFC");
	if (!value || /^(?:\/|~|[A-Za-z]:)/.test(value)) return undefined;
	const segments = value.split("/").filter(segment => segment !== "" && segment !== ".");
	if (!segments.length || segments.includes("..")) return undefined;
	return segments.join("/").toLowerCase();
}

// Syntax this module never interprets, so the entry overlaps everything:
// bracket classes (negation and POSIX classes do not survive lowercasing),
// extglob groups, and braces that are nested, unbalanced, or span a `/` (a
// spanning group shows up as an unbalanced segment after the split).
function uninterpretable(entry: string): boolean {
	if (/[[\]()\\]/.test(entry)) return true;
	return entry.split("/").some(segment => {
		let depth = 0;
		for (const char of segment) {
			if (char === "{" && ++depth > 1) return true;
			if (char === "}" && --depth < 0) return true;
		}
		return depth !== 0;
	});
}

// Exact glob semantics for one segment of an interpretable entry: `*`, `?` and
// one level of balanced braces.
function segmentRegExp(pattern: string): RegExp {
	let source = "";
	let braces = false;
	for (const char of pattern) {
		if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (char === "{") { braces = true; source += "(?:"; }
		else if (char === "}") { braces = false; source += ")"; }
		else if (char === "," && braces) source += "|";
		else source += char.replace(/[.+^$|\\/()[\]{}]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

// Every match of a glob starts with the literal text before its first special
// character and ends with the literal text after its last one.
function affixesCompatible(a: string, b: string): boolean {
	const prefix = (value: string) => { const index = value.search(SPECIAL); return index < 0 ? value : value.slice(0, index); };
	const suffix = (value: string) => { let index = value.length - 1; while (index >= 0 && !SPECIAL.test(value[index])) index -= 1; return value.slice(index + 1); };
	const [pa, pb, sa, sb] = [prefix(a), prefix(b), suffix(a), suffix(b)];
	return (pa.startsWith(pb) || pb.startsWith(pa)) && (sa.endsWith(sb) || sb.endsWith(sa));
}

function segmentsCompatible(a: string, b: string): boolean {
	const aGlob = SPECIAL.test(a);
	const bGlob = SPECIAL.test(b);
	if (!aGlob && !bGlob) return a === b;
	// A non-ASCII character may span two UTF-16 units that one `?` cannot match.
	if (/[^\x00-\x7f]/.test(a + b)) return true;
	if (!aGlob || !bGlob) {
		const [literal, pattern] = aGlob ? [b, a] : [a, b];
		return segmentRegExp(pattern).test(literal);
	}
	return affixesCompatible(a, b);
}

// True when some path could be covered by both entries. Walking segment by
// segment: a `**` can absorb the rest of the other entry, and an entry that
// runs out first names a directory covering whatever the other continues with.
export function surfacesOverlap(a: string, b: string): boolean {
	const left = normalizeSurfaceEntry(a);
	const right = normalizeSurfaceEntry(b);
	if (left === undefined || right === undefined || uninterpretable(left) || uninterpretable(right)) return true;
	const as = left.split("/");
	const bs = right.split("/");
	for (let index = 0; index < Math.min(as.length, bs.length); index++) {
		if (as[index] === "**" || bs[index] === "**") return true;
		if (!segmentsCompatible(as[index], bs[index])) return false;
	}
	return true;
}

// An empty list scopes nothing, so it is treated as claiming the whole tree.
export function overlappingSurfaces(a: readonly string[], b: readonly string[]): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	for (const left of a.length ? a : ["."]) {
		for (const right of b.length ? b : ["."]) if (surfacesOverlap(left, right)) pairs.push([left, right]);
	}
	return pairs;
}

export interface WriterSurfaceConflict {
	taskId: string;
	root: string;
	pairs: Array<[string, string]>;
}

// The registry key for a writer's cwd: the realpath Git worktree root, so a
// subdirectory, the root itself and a symlinked spelling share one key; without
// Git, the realpath of the cwd, and its resolved spelling when even that fails.
export function canonicalWriterRoot(cwd: string, resolver: WorktreeResolver = resolveSessionWorktree): string {
	const root = resolver(cwd, cwd)?.root;
	if (root) return root;
	try { return realpathSync(cwd); }
	catch { return resolve(cwd); }
}

// Live writer claims keyed by task id. Writers in different worktree roots
// never conflict: their surfaces name different files.
export class WriterSurfaceRegistry {
	private readonly live = new Map<string, { root: string; surfaces: readonly string[] }>();

	get size(): number {
		return this.live.size;
	}

	conflicts(root: string, surfaces: readonly string[]): WriterSurfaceConflict[] {
		const target = resolve(root);
		const conflicts: WriterSurfaceConflict[] = [];
		for (const [taskId, writer] of this.live) {
			if (writer.root !== target) continue;
			const pairs = overlappingSurfaces(surfaces, writer.surfaces);
			if (pairs.length) conflicts.push({ taskId, root: target, pairs });
		}
		return conflicts;
	}

	claim(taskId: string, root: string, surfaces: readonly string[]): void {
		this.live.set(taskId, { root: resolve(root), surfaces: [...surfaces] });
	}

	release(taskId: string): boolean {
		return this.live.delete(taskId);
	}
}

export function writerSurfaceConflictMessage(conflicts: readonly WriterSurfaceConflict[]): string {
	const details = conflicts.map(({ taskId, root, pairs }) => {
		const listed = pairs.slice(0, MAX_LISTED_PAIRS).map(([mine, theirs]) => `\`${mine}\` overlaps \`${theirs}\``).join(", ");
		const more = pairs.length > MAX_LISTED_PAIRS ? ` and ${pairs.length - MAX_LISTED_PAIRS} more` : "";
		return `task ${taskId} in ${root} (${listed}${more})`;
	}).join("; ");
	const ids = conflicts.map(conflict => conflict.taskId).join(", ");
	return `Parallel writer rejected: its Allowed edit surfaces overlap a live writer: ${details}. Wait for ${ids} to finish, narrow \`## Allowed edit surfaces\` to paths disjoint from the live writer, or launch this writer in an isolated worktree (workspace_root).`;
}
